import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
function git(cwd, args, fail = false) {
  const r = spawnSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, encoding: 'utf8' })
  if (!fail) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || ''}`)
  return r
}
function repo(label) {
  const p = mkdtempSync(join(tmpdir(), `gitsync-message-${label}-`))
  git(p, ['init', '-q']); git(p, ['config', 'user.name', 'GitSync Tests']); git(p, ['config', 'user.email', 'test@example.invalid'])
  return p
}
function commitBody(r) {
  const raw = git(r, ['cat-file', 'commit', 'HEAD']).stdout
  const split = raw.indexOf('\n\n')
  assert.ok(split >= 0)
  return raw.slice(split + 2)
}

test('atomic Commit applies Git cleanup after hooks and rejects empty cleaned message', () => {
  const semantics = read('../src-tauri/src/git_atomic_mutation_commit_message.rs')
  const commit = read('../src-tauri/src/git_atomic_mutation_commit_ref_guarded.rs')
  assert.match(semantics, /commit\.cleanup/)
  assert.match(semantics, /CommitCleanupMode::Strip[\s\S]*"stripspace"[\s\S]*"--strip-comments"/)
  assert.match(semantics, /CommitCleanupMode::Whitespace \| CommitCleanupMode::Scissors[\s\S]*"stripspace"/)
  assert.match(semantics, /CommitCleanupMode::Verbatim => hook_message/)
  assert.match(semantics, /if cleaned\.is_empty\(\)/)
  const hooks = commit.indexOf('run_pre_publish_commit_hooks')
  const cleanup = commit.indexOf('finalize_commit_message')
  const publish = commit.indexOf('"commit-tree"')
  assert.ok(hooks >= 0 && hooks < cleanup && cleanup < publish)
})

test('standard Git rejects a commit-msg hook that clears the message', () => {
  const r = repo('empty-hook')
  try {
    writeFileSync(join(r, 'f.txt'), 'base\n'); git(r, ['add', 'f.txt']); git(r, ['commit', '-qm', 'base'])
    writeFileSync(join(r, 'f.txt'), 'change\n'); git(r, ['add', 'f.txt'])
    const before = git(r, ['rev-parse', 'HEAD']).stdout.trim()
    const hook = join(r, '.git', 'hooks', 'commit-msg')
    writeFileSync(hook, '#!/bin/sh\n: > "$1"\nexit 0\n'); chmodSync(hook, 0o755)
    const result = git(r, ['commit', '-m', 'hello'], true)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /empty commit message/i)
    assert.equal(git(r, ['rev-parse', 'HEAD']).stdout.trim(), before)
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('standard Git performs final cleanup after prepare-commit-msg edits', () => {
  const r = repo('cleanup')
  try {
    writeFileSync(join(r, 'f.txt'), 'base\n'); git(r, ['add', 'f.txt'])
    const hook = join(r, '.git', 'hooks', 'prepare-commit-msg')
    writeFileSync(hook, '#!/bin/sh\nprintf "Subject   \\n\\n\\nBody   \\n   \\n" > "$1"\n'); chmodSync(hook, 0o755)
    git(r, ['commit', '-qm', 'seed'])
    assert.equal(commitBody(r), 'Subject\n\nBody\n')

    git(r, ['config', 'commit.cleanup', 'strip'])
    writeFileSync(join(r, 'f.txt'), 'next\n'); git(r, ['add', 'f.txt'])
    writeFileSync(hook, '#!/bin/sh\nprintf "Subject   \\n\\n# comment   \\nBody   \\n" > "$1"\n'); chmodSync(hook, 0o755)
    git(r, ['commit', '-qm', 'seed'])
    assert.equal(commitBody(r), 'Subject\n\nBody\n')
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('cleanup primitives preserve configured modes and core.commentChar semantics', () => {
  const semantics = read('../src-tauri/src/git_atomic_mutation_commit_message.rs')
  for (const mode of ['default','whitespace','strip','verbatim','scissors']) assert.ok(semantics.includes(`\"${mode}\"`))

  const r = repo('cleanup-modes')
  try {
    git(r, ['config', 'core.commentChar', ';'])
    const cleaned = spawnSync('git', ['stripspace', '--strip-comments'], {
      cwd: r,
      input: 'Subject   \n\n; comment   \nBody   \n',
      encoding: 'utf8',
    })
    assert.equal(cleaned.status, 0)
    assert.equal(cleaned.stdout, 'Subject\n\nBody\n')

    git(r, ['config', 'commit.cleanup', 'scissors'])
    writeFileSync(join(r, 'f.txt'), 'one\n'); git(r, ['add', 'f.txt'])
    const hook = join(r, '.git', 'hooks', 'prepare-commit-msg')
    writeFileSync(hook, '#!/bin/sh\nprintf "Subject\\n# ------------------------ >8 ------------------------\\nTAIL\\n" > "$1"\n'); chmodSync(hook, 0o755)
    git(r, ['commit', '-qm', 'seed'])
    assert.match(commitBody(r), /TAIL/)
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('core.commentChar=auto strip cleanup preserves a legitimate leading hash like git commit', () => {
  const semantics = read('../src-tauri/src/git_atomic_mutation_commit_message.rs')
  const commit = read('../src-tauri/src/git_atomic_mutation_commit_ref_guarded.rs')
  assert.match(semantics, /CANDIDATES: &\[u8\] = b"#;@!\$%\^&\|:"/)
  assert.match(semantics, /fn is_magic_auto_comment_config/)
  assert.match(semantics, /eq_ignore_ascii_case\("auto"\)/)
  assert.match(semantics, /"-z"\.to_string\(\)[\s\S]*"--get-regexp"\.to_string\(\)/)
  assert.match(semantics, /parse_effective_comment_config_output/)
  assert.doesNotMatch(semantics, /comment_config\.as_deref\(\) == Some\("auto"\)/)
  assert.match(semantics, /core\.commentChar=\{\}/)
  assert.ok(commit.indexOf('resolve_commit_cleanup_mode') < commit.indexOf('run_pre_publish_commit_hooks'))

  const r = repo('comment-auto')
  try {
    git(r, ['config', 'core.commentChar', 'auto'])
    git(r, ['config', 'commit.cleanup', 'strip'])
    writeFileSync(join(r, 'f.txt'), 'one\n'); git(r, ['add', 'f.txt'])
    const msg = join(r, 'msg.txt')
    writeFileSync(msg, '# subject\n')
    git(r, ['commit', '-q', '-F', msg])
    assert.equal(commitBody(r), '# subject\n')

    const cleaned = spawnSync('git', ['-c', 'core.commentChar=;', 'stripspace', '--strip-comments'], {
      cwd: r,
      input: '# subject\n',
      encoding: 'utf8',
    })
    assert.equal(cleaned.status, 0)
    assert.equal(cleaned.stdout, '# subject\n')
  } finally { rmSync(r, { recursive: true, force: true }) }
})

test('atomic publication supplies normal and initial Commit reflog reasons', () => {
  const source = read('../src-tauri/src/git_atomic_mutation_commit_ref_guarded.rs')
  const semantics = read('../src-tauri/src/git_atomic_mutation_commit_message.rs')
  assert.match(semantics, /fn commit_reflog_reason/)
  assert.match(semantics, /"commit \(initial\)"/)
  assert.match(semantics, /"commit"/)
  assert.match(source, /"update-ref"\.to_string\(\)[\s\S]*"-m"\.to_string\(\)[\s\S]*reflog_reason[\s\S]*"HEAD"\.to_string\(\)/)

  const r = repo('reflog')
  try {
    writeFileSync(join(r, 'f.txt'), 'one\n'); git(r, ['add', 'f.txt']); git(r, ['commit', '-qm', 'first subject'])
    assert.equal(git(r, ['reflog', '-1', '--format=%gs']).stdout.trim(), 'commit (initial): first subject')
    writeFileSync(join(r, 'f.txt'), 'two\n'); git(r, ['add', 'f.txt']); git(r, ['commit', '-qm', '  second subject  '])
    assert.equal(git(r, ['reflog', '-1', '--format=%gs']).stdout.trim(), 'commit: second subject')
  } finally { rmSync(r, { recursive: true, force: true }) }
})
