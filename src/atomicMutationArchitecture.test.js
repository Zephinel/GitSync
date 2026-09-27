import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  linkSync,
  renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rustSourceDir = join(here, '..', 'src-tauri', 'src')
const readRust = (name) => readFileSync(join(rustSourceDir, name), 'utf8')

function runGit(cwd, args, { input = null, allowFailure = false, env = {} } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', ...env },
  })
  if (!allowFailure) {
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr?.toString('utf8')}`)
  }
  return result
}

function initRepo(label) {
  const repo = mkdtempSync(join(tmpdir(), `gitsync-atomic-${label}-`))
  runGit(repo, ['init', '-q'])
  runGit(repo, ['config', 'user.email', 'tests@example.invalid'])
  runGit(repo, ['config', 'user.name', 'GitSync Tests'])
  return repo
}

function blobPatch(repo, oldOid, newOid, path) {
  const patch = runGit(repo, ['diff', '--binary', '--full-index', oldOid, newOid]).stdout.toString('utf8')
  return patch
    .replaceAll(`a/${oldOid}`, `a/${path}`)
    .replaceAll(`b/${newOid}`, `b/${path}`)
}

test('production mutation path uses immutable/conditional primitives instead of live git add/restore after authority check', () => {
  const atomic = [
    readRust('git_atomic_mutation.rs'),
    readRust('git_atomic_mutation_index.rs'),
    readRust('git_atomic_mutation_commit.rs'),
    readRust('git_atomic_mutation_discard.rs'),
  ].join('\n')
  const staging = [readRust('staging_authority_overlay.rs'), readRust('staging_authority_prelude.rs'), readRust('staging_authority_operation_part1.rs'), readRust('staging_authority_operation_part2.rs')].join('\n')
  const working = [readRust('working_changes_authority_overlay.rs'), [readRust('working_changes_authority_prelude.rs'), readRust('working_changes_authority_prelude_part1.rs'), readRust('working_changes_authority_prelude_part2.rs')].join('\n'), readRust('working_changes_authority_operations.rs')].join('\n')
  const snapshot = [readRust('git_content_authority_snapshot_overlay.rs'), [readRust('git_content_authority_snapshot_types.rs'), readRust('git_content_authority_snapshot_model.rs'), readRust('git_content_authority_snapshot_index.rs'), readRust('git_content_authority_snapshot_worktree.rs')].join('\n'), readRust('git_content_authority_snapshot_capture.rs')].join('\n')
  const stagingBase = readRust('staging.rs')
  const workingBase = readRust('working_changes.rs')
  const stagingCommands = readRust('staging_authority.rs')
  const workingCommands = readRust('working_changes_authority.rs')

  assert.match(snapshot, /capture_mutation_entry_snapshots/)
  assert.match(snapshot, /hash-object[\s\S]*-w[\s\S]*--no-filters/)
  assert.match(snapshot, /--path=/)

  assert.match(atomic, /"apply"\.to_string\(\)[\s\S]*"--cached"\.to_string\(\)[\s\S]*"--index"\.to_string\(\)/)
  assert.match(atomic, /"commit-tree"\.to_string\(\)/)
  assert.match(atomic, /"update-ref"\.to_string\(\)[\s\S]*"HEAD"\.to_string\(\)[\s\S]*expected_old/)
  assert.match(atomic, /tokio::fs::rename\(&original, &recovery\)/)
  assert.match(atomic, /hard_link\(recovery, original\)/)
  assert.match(atomic, /materialize_blob_no_clobber/)
  assert.match(atomic, /materialize_blob_overwrite/)
  assert.match(atomic, /replace_materialized_path/)
  assert.match(atomic, /cat-file[\s\S]*--filters[\s\S]*--path=/)
  assert.equal((atomic.match(/Option<&\(dyn Fn\(\) \+ Send \+ Sync\)>/g) || []).length, 7)
  assert.doesNotMatch(atomic, /Option<&dyn Fn\(\)>/)

  assert.doesNotMatch(stagingBase, /#\[tauri::command\]/)
  assert.doesNotMatch(workingBase, /#\[tauri::command\]/)
  assert.equal((stagingCommands.match(/#\[tauri::command\]/g) || []).length, 3)
  assert.equal((workingCommands.match(/#\[tauri::command\]/g) || []).length, 5)

  assert.match(staging, /git_atomic_mutation::stage_verified_entry/)
  assert.match(staging, /git_atomic_mutation::unstage_verified_entry/)
  assert.doesNotMatch(staging, /stage_file\(&repo_path/)
  assert.doesNotMatch(staging, /unstage_file\(&repo_path/)

  assert.match(working, /git_atomic_mutation::commit_verified_entries/)
  assert.match(working, /git_atomic_mutation::discard_verified_entry/)
  assert.doesNotMatch(working, /commit_selected_files\(&repo_path/)
  assert.doesNotMatch(working, /discard_file\(&repo_path/)
  assert.doesNotMatch(working, /verify_selected_scope_clean/)
})

test('Stage conditional index patch stages verified A while later worktree B survives unstaged', () => {
  const repo = initRepo('stage')
  try {
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    runGit(repo, ['add', '--', 'a.txt'])
    runGit(repo, ['commit', '-q', '-m', 'base'])
    const oldOid = runGit(repo, ['rev-parse', 'HEAD:a.txt']).stdout.toString('utf8').trim()

    writeFileSync(join(repo, 'snapshot-A'), 'A\n')
    const aOid = runGit(repo, ['hash-object', '-w', '--no-filters', 'snapshot-A']).stdout.toString('utf8').trim()
    const patch = blobPatch(repo, oldOid, aOid, 'a.txt')

    writeFileSync(join(repo, 'a.txt'), 'B\n')
    runGit(repo, ['apply', '--cached', '--index', '-'], { input: patch })

    assert.equal(runGit(repo, ['show', ':a.txt']).stdout.toString('utf8'), 'A\n')
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'B\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('Unstage conditional patch rejects an externally staged B instead of overwriting it', () => {
  const repo = initRepo('unstage')
  try {
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    runGit(repo, ['add', '--', 'a.txt'])
    runGit(repo, ['commit', '-q', '-m', 'base'])
    const headOid = runGit(repo, ['rev-parse', 'HEAD:a.txt']).stdout.toString('utf8').trim()

    writeFileSync(join(repo, 'a.txt'), 'A\n')
    runGit(repo, ['add', '--', 'a.txt'])
    const aOid = runGit(repo, ['rev-parse', ':a.txt']).stdout.toString('utf8').trim()
    const reversePatch = blobPatch(repo, aOid, headOid, 'a.txt')

    writeFileSync(join(repo, 'a.txt'), 'B\n')
    runGit(repo, ['add', '--', 'a.txt'])
    const apply = runGit(repo, ['apply', '--cached', '--index', '-'], {
      input: reversePatch,
      allowFailure: true,
    })

    assert.notEqual(apply.status, 0)
    assert.equal(runGit(repo, ['show', ':a.txt']).stdout.toString('utf8'), 'B\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('Commit can publish verified A from an immutable temp index while later worktree B survives', () => {
  const repo = initRepo('commit')
  try {
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    runGit(repo, ['add', '--', 'a.txt'])
    runGit(repo, ['commit', '-q', '-m', 'base'])
    const head = runGit(repo, ['rev-parse', 'HEAD']).stdout.toString('utf8').trim()
    const oldOid = runGit(repo, ['rev-parse', 'HEAD:a.txt']).stdout.toString('utf8').trim()

    writeFileSync(join(repo, 'snapshot-A'), 'A\n')
    const aOid = runGit(repo, ['hash-object', '-w', '--no-filters', 'snapshot-A']).stdout.toString('utf8').trim()
    const patch = blobPatch(repo, oldOid, aOid, 'a.txt')

    writeFileSync(join(repo, 'a.txt'), 'B\n')

    const tempIndex = join(repo, '.git', 'test-index')
    const env = { GIT_INDEX_FILE: tempIndex }
    runGit(repo, ['read-tree', head], { env })
    runGit(repo, ['apply', '--cached', '--index', '-'], { input: patch, env })
    const tree = runGit(repo, ['write-tree'], { env }).stdout.toString('utf8').trim()
    const commit = runGit(repo, ['commit-tree', tree, '-p', head, '-m', 'verified A']).stdout.toString('utf8').trim()
    runGit(repo, ['update-ref', 'HEAD', commit, head])

    assert.equal(runGit(repo, ['show', 'HEAD:a.txt']).stdout.toString('utf8'), 'A\n')
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'B\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('Discard pathname claim preserves external B instead of overwriting it', () => {
  const repo = initRepo('discard')
  try {
    writeFileSync(join(repo, 'a.txt'), 'A\n')
    const expected = runGit(repo, ['hash-object', '--no-filters', 'a.txt']).stdout.toString('utf8').trim()

    writeFileSync(join(repo, 'replacement.tmp'), 'B\n')
    renameSync(join(repo, 'replacement.tmp'), join(repo, 'a.txt'))

    const recovery = join(repo, '.git', 'recovery-preimage')
    renameSync(join(repo, 'a.txt'), recovery)
    const claimed = runGit(repo, ['hash-object', '--no-filters', recovery]).stdout.toString('utf8').trim()
    assert.notEqual(claimed, expected)

    linkSync(recovery, join(repo, 'a.txt'))
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'B\n')
    assert.equal(readFileSync(recovery, 'utf8'), 'B\n')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
