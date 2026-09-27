import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rustSourceDir = join(here, '..', 'src-tauri', 'src')
const readRust = (name) => readFileSync(join(rustSourceDir, name), 'utf8')
function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd })
  assert.equal(result.status, 0, result.stderr.toString('utf8'))
  return result.stdout
}

test('expected-HEAD ref guard blocks concurrent HEAD/branch updates and is wired into destructive/ref-sensitive mutations', async () => {
  const guard = readRust('git_atomic_mutation_ref_guard.rs')
  const commit = readRust('git_atomic_mutation_commit_ref_guarded.rs')
  const staging = readRust('staging_authority_operation_part1.rs')
  const working = readRust('working_changes_authority_operations.rs')
  assert.match(guard, /update-ref[\s\S]*--stdin/)
  assert.match(guard, /verify HEAD \{\}/)
  assert.match(guard, /prepare/)
  assert.match(guard, /unstage_verified_entry_ref_guarded/)
  assert.match(guard, /discard_verified_entry_ref_guarded/)
  assert.match(commit, /ExpectedHeadRefGuard::acquire\(repo_path, Some\(&commit\)\)/)
  assert.match(staging, /unstage_verified_entry_ref_guarded/)
  assert.match(working, /discard_verified_entry_ref_guarded/)
  assert.match(working, /commit_verified_entries_ref_guarded/)

  const repo = mkdtempSync(join(tmpdir(), 'gitsync-head-ref-guard-'))
  try {
    runGit(repo, ['init', '-q'])
    runGit(repo, ['config', 'user.email', 'tests@example.invalid'])
    runGit(repo, ['config', 'user.name', 'GitSync Tests'])
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    runGit(repo, ['add', '--', 'a.txt'])
    runGit(repo, ['commit', '-q', '-m', 'base'])
    const head = runGit(repo, ['rev-parse', 'HEAD']).toString('utf8').trim()
    const branch = runGit(repo, ['symbolic-ref', 'HEAD']).toString('utf8').trim()

    const child = spawn('git', ['update-ref', '--stdin'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    child.stdin.write('start\n')
    assert.equal((await lines.next()).value, 'start: ok')
    child.stdin.write(`verify HEAD ${head}\nprepare\n`)
    assert.equal((await lines.next()).value, 'prepare: ok')

    const headUpdate = spawnSync('git', ['update-ref', 'HEAD', head, head], { cwd: repo })
    const branchUpdate = spawnSync('git', ['update-ref', branch, head, head], { cwd: repo })
    assert.notEqual(headUpdate.status, 0)
    assert.notEqual(branchUpdate.status, 0)
    assert.match(headUpdate.stderr.toString('utf8'), /cannot lock ref 'HEAD'/)
    assert.match(branchUpdate.stderr.toString('utf8'), /cannot lock ref/)

    child.stdin.write('abort\n')
    assert.equal((await lines.next()).value, 'abort: ok')
    child.stdin.end()
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(exitCode, 0)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
