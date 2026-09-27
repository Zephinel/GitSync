import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')
const workingSource = () => [
  read('../src-tauri/src/working_changes_authority_overlay.rs'),
  read('../src-tauri/src/working_changes_authority_prelude.rs'),
  read('../src-tauri/src/working_changes_authority_prelude_part1.rs'),
  read('../src-tauri/src/working_changes_authority_prelude_part2.rs'),
  read('../src-tauri/src/working_changes_authority_operations.rs'),
].join('\n')
const snapshotSource = () => [
  read('../src-tauri/src/git_content_authority_snapshot_overlay.rs'),
  read('../src-tauri/src/git_content_authority_snapshot_types.rs'),
  read('../src-tauri/src/git_content_authority_snapshot_model.rs'),
  read('../src-tauri/src/git_content_authority_snapshot_index.rs'),
  read('../src-tauri/src/git_content_authority_snapshot_worktree.rs'),
  read('../src-tauri/src/git_content_authority_snapshot_capture.rs'),
].join('\n')

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr?.toString('utf8')}`)
  return result.stdout
}
function initRepo(label) {
  const repo = mkdtempSync(join(tmpdir(), `gitsync-${label}-`))
  runGit(repo, ['init', '-q'])
  runGit(repo, ['config', 'user.email', 'tests@example.invalid'])
  runGit(repo, ['config', 'user.name', 'GitSync Tests'])
  return repo
}

test('path identity stays strict while display content may decode lossily', () => {
  const lib = read('../src-tauri/src/lib.rs')
  const encoding = read('../src-tauri/src/git_encoding.rs')
  const working = workingSource()
  assert.match(lib, /#\[path = "git_content_authority_runtime\.rs"\][\s\S]*mod git_content_authority;/)
  assert.match(lib, /mod git_atomic_mutation;/)
  assert.match(encoding, /UNSUPPORTED_GIT_PATH_ENCODING/)
  assert.match(encoding, /String::from_utf8\(bytes\)/)
  assert.match(encoding, /decode_git_display_content/)
  assert.match(encoding, /String::from_utf8_lossy\(&bytes\)/)
  assert.match(working, /run_git_display_content/)
})

test('valid UTF-8 path may expose non-UTF8 diff content without becoming a path error', () => {
  const repo = initRepo('non-utf8-content')
  try {
    writeFileSync(join(repo, 'latin.txt'), Buffer.from('base\n'))
    runGit(repo, ['add', '--', 'latin.txt'])
    runGit(repo, ['commit', '-q', '-m', 'baseline'])
    writeFileSync(join(repo, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    const diff = runGit(repo, ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', 'latin.txt'])
    assert.ok(diff.includes(0xe9))
    assert.ok(diff.toString('utf8').includes('\uFFFD'))
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('same-status content change stays distinct and immutable capture writes Git objects', () => {
  const repo = initRepo('content-authority')
  try {
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    runGit(repo, ['add', '--', 'a.txt'])
    runGit(repo, ['commit', '-q', '-m', 'baseline'])
    writeFileSync(join(repo, 'a.txt'), 'A\n')
    const statusA = runGit(repo, ['status', '--porcelain=v1', '--', 'a.txt']).toString('utf8')
    const hashA = runGit(repo, ['hash-object', '--no-filters', '--', 'a.txt']).toString('utf8')
    writeFileSync(join(repo, 'a.txt'), 'B\n')
    const statusB = runGit(repo, ['status', '--porcelain=v1', '--', 'a.txt']).toString('utf8')
    const hashB = runGit(repo, ['hash-object', '--no-filters', '--', 'a.txt']).toString('utf8')
    assert.equal(statusA, statusB)
    assert.notEqual(hashA, hashB)
    const snapshot = snapshotSource()
    assert.match(snapshot, /capture_mutation_entry_snapshots/)
    assert.match(snapshot, /"hash-object"\.to_string\(\), "-w"\.to_string\(\)/)
    assert.match(snapshot, /--no-filters/)
    assert.match(snapshot, /--path=/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('same-path D/?? remains ambiguous for Commit/Discard', () => {
  const repo = initRepo('same-path')
  try {
    writeFileSync(join(repo, 'same.txt'), 'baseline\n')
    runGit(repo, ['add', '--', 'same.txt'])
    runGit(repo, ['commit', '-q', '-m', 'baseline'])
    runGit(repo, ['rm', '-q', '--cached', '--', 'same.txt'])
    const fields = runGit(repo, ['status', '--porcelain=v1', '-z', '-uall']).toString('utf8').split('\0').filter(Boolean).sort()
    assert.deepEqual(fields, ['?? same.txt', 'D  same.txt'])
    const working = workingSource()
    assert.match(working, /files_share_identity_path\(candidate, file\)/)
    assert.match(working, /同一路径同时存在多个 Git status identity，Commit \/ Discard 不会猜测目标/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
