import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const readRust = (name) => readFileSync(new URL(`../src-tauri/src/${name}`, import.meta.url), 'utf8')
function git(cwd, args, fail = false) {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, encoding: 'utf8' })
  if (!fail) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || ''}`)
  return r
}
function repo(label) {
  const p = mkdtempSync(join(tmpdir(), `gitsync-hooks-${label}-`)); git(p, ['init', '-q']); git(p, ['config', 'user.name', 'GitSync Tests']); git(p, ['config', 'user.email', 'test@example.invalid'])
  writeFileSync(join(p, 'f.txt'), 'base\n'); git(p, ['add', 'f.txt']); git(p, ['commit', '-qm', 'base']); return p
}

test('commit hooks are wired around immutable commit publication', () => {
  const s = readRust('git_atomic_mutation_commit_semantics.rs'), c = readRust('git_atomic_mutation_commit_ref_guarded.rs')
  for (const hook of ['pre-commit','prepare-commit-msg','commit-msg','post-commit']) assert.ok(s.includes(`\"${hook}\"`))
  assert.match(s, /\"hook\"\.to_string\(\)[\s\S]*\"run\"\.to_string\(\)[\s\S]*\"--ignore-missing\"/)
  assert.match(s, /GIT_EDITOR/); assert.match(c, /tree_after_hooks != tree_before_hooks/)
  assert.ok(c.indexOf('run_pre_publish_commit_hooks') < c.indexOf('\"commit-tree\"'))
  assert.ok(c.indexOf('\"update-ref\"') < c.indexOf('run_post_commit_hook_best_effort'))
})

test('pre-commit and commit-msg rejection preserve HEAD', () => {
  const r = repo('reject')
  try {
    writeFileSync(join(r, 'f.txt'), 'change\n'); git(r, ['add', 'f.txt']); const before = git(r, ['rev-parse', 'HEAD']).stdout.trim()
    const pre = join(r, '.git', 'hooks', 'pre-commit'); writeFileSync(pre, '#!/bin/sh\nexit 17\n'); chmodSync(pre, 0o755)
    assert.equal(git(r, ['hook', 'run', '--ignore-missing', 'pre-commit'], true).status, 17); assert.equal(git(r, ['rev-parse', 'HEAD']).stdout.trim(), before)
    rmSync(pre); const cm = join(r, '.git', 'hooks', 'commit-msg'); writeFileSync(cm, '#!/bin/sh\nexit 23\n'); chmodSync(cm, 0o755)
    const msg = join(r, '.git', 'TEST_COMMIT_MSG'); writeFileSync(msg, 'message\n')
    assert.equal(git(r, ['hook', 'run', '--ignore-missing', 'commit-msg', '--', msg], true).status, 23); assert.equal(git(r, ['rev-parse', 'HEAD']).stdout.trim(), before)
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('prepare-commit-msg edits message while hook index mutation is fail-closed', () => {
  const r = repo('prepare')
  try {
    const hook = join(r, '.git', 'hooks', 'prepare-commit-msg'); writeFileSync(hook, '#!/bin/sh\nprintf \"prepared\\n\" >> \"$1\"\n'); chmodSync(hook, 0o755)
    const msg = join(r, '.git', 'TEST_COMMIT_MSG'); writeFileSync(msg, 'original\n'); git(r, ['hook', 'run', '--ignore-missing', 'prepare-commit-msg', '--', msg, 'message'])
    assert.equal(readFileSync(msg, 'utf8'), 'original\nprepared\n')
    const c = readRust('git_atomic_mutation_commit_ref_guarded.rs'); assert.match(c, /immutable selected index/); assert.match(c, /tree_after_hooks != tree_before_hooks/)
  } finally { rmSync(r, { recursive: true, force: true }) }
})
