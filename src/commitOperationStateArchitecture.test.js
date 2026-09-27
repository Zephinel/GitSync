import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const BASE_BRANCH = 'gitsync-base'
const readRust = (name) => readFileSync(new URL(`../src-tauri/src/${name}`, import.meta.url), 'utf8')
function git(cwd, args, fail = false) {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, encoding: 'utf8' })
  if (!fail) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || ''}`)
  return r
}
function repo(label) {
  const p = mkdtempSync(join(tmpdir(), `gitsync-opstate-${label}-`))
  git(p, ['init', '-q'])
  git(p, ['symbolic-ref', 'HEAD', `refs/heads/${BASE_BRANCH}`])
  git(p, ['config', 'user.name', 'GitSync Tests'])
  git(p, ['config', 'user.email', 'test@example.invalid'])
  return p
}
function commitFile(r, path, content, msg) {
  writeFileSync(join(r, path), content); git(r, ['add', '--', path]); git(r, ['commit', '-q', '-m', msg])
}

test('ordinary Commit admission owns normal state only', () => {
  const s = readRust('git_atomic_mutation_commit_semantics.rs')
  const c = readRust('git_atomic_mutation_commit_ref_guarded.rs')
  for (const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','rebase-merge','rebase-apply','sequencer']) assert.ok(s.includes(marker))
  assert.match(s, /普通 Working Changes Commit 已拒绝/)
  const lock = c.indexOf('RealIndexLockGuard::acquire'), first = c.indexOf('ensure_normal_commit_operation_state')
  const hooks = c.indexOf('run_pre_publish_commit_hooks'), second = c.lastIndexOf('ensure_normal_commit_operation_state'), publish = c.indexOf('"commit-tree"')
  assert.ok(lock >= 0 && lock < first && first < hooks && hooks < second && second < publish)
})

test('no-conflict merge --no-commit remains MERGE_HEAD-owned', () => {
  const r = repo('merge-clean')
  try {
    commitFile(r, 'base.txt', 'base\n', 'base'); git(r, ['checkout', '-qb', 'feature']); commitFile(r, 'feature.txt', 'feature\n', 'feature')
    git(r, ['checkout', '-q', BASE_BRANCH]); commitFile(r, 'base-branch.txt', 'base branch\n', 'base branch')
    const before = git(r, ['rev-parse', 'HEAD']).stdout.trim(); git(r, ['merge', '--no-commit', '--no-ff', 'feature'])
    assert.equal(git(r, ['rev-parse', 'HEAD']).stdout.trim(), before)
    assert.equal(git(r, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 0)
    assert.equal(git(r, ['diff', '--name-only', '--diff-filter=U']).stdout.trim(), '')
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('resolved merge conflict still remains MERGE_HEAD-owned', () => {
  const r = repo('merge-resolved')
  try {
    commitFile(r, 'f.txt', 'base\n', 'base'); git(r, ['checkout', '-qb', 'feature']); commitFile(r, 'f.txt', 'feature\n', 'feature')
    git(r, ['checkout', '-q', BASE_BRANCH]); commitFile(r, 'f.txt', 'base branch\n', 'base branch'); assert.notEqual(git(r, ['merge', '--no-commit', '--no-ff', 'feature'], true).status, 0)
    writeFileSync(join(r, 'f.txt'), 'resolved\n'); git(r, ['add', '--', 'f.txt'])
    assert.equal(git(r, ['diff', '--name-only', '--diff-filter=U']).stdout.trim(), '')
    assert.equal(git(r, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 0)
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('resolved cherry-pick conflict remains CHERRY_PICK_HEAD-owned', () => {
  const r = repo('cherry-resolved')
  try {
    commitFile(r, 'f.txt', 'base\n', 'base'); git(r, ['checkout', '-qb', 'feature']); commitFile(r, 'f.txt', 'feature\n', 'feature')
    const picked = git(r, ['rev-parse', 'HEAD']).stdout.trim(); git(r, ['checkout', '-q', BASE_BRANCH]); commitFile(r, 'f.txt', 'base branch\n', 'base branch')
    assert.notEqual(git(r, ['cherry-pick', picked], true).status, 0); writeFileSync(join(r, 'f.txt'), 'resolved\n'); git(r, ['add', '--', 'f.txt'])
    assert.equal(git(r, ['diff', '--name-only', '--diff-filter=U']).stdout.trim(), '')
    assert.equal(git(r, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD']).status, 0)
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('real index lock prevents external merge from establishing MERGE_HEAD', () => {
  const r = repo('index-lock')
  try {
    commitFile(r, 'base.txt', 'base\n', 'base'); git(r, ['checkout', '-qb', 'feature']); commitFile(r, 'feature.txt', 'feature\n', 'feature')
    git(r, ['checkout', '-q', BASE_BRANCH]); commitFile(r, 'base-branch.txt', 'base branch\n', 'base branch'); writeFileSync(join(r, '.git', 'index.lock'), '')
    assert.notEqual(git(r, ['merge', '--no-commit', '--no-ff', 'feature'], true).status, 0)
    assert.equal(git(r, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).status, 1)
    rmSync(join(r, '.git', 'index.lock'), { force: true })
  } finally { rmSync(r, { recursive: true, force: true }) }
})
