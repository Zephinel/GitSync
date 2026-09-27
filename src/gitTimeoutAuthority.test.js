import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rustSourceDir = join(__dirname, '..', 'src-tauri', 'src')

function rustSources() {
  return readdirSync(rustSourceDir)
    .filter((name) => name.endsWith('.rs'))
    .map((name) => ({ name, source: readFileSync(join(rustSourceDir, name), 'utf8') }))
}

test('every git timeout budget is defined only in the timeout authority', () => {
  const offenders = []
  for (const { name, source } of rustSources()) {
    if (name === 'git_timeouts.rs') continue
    source.split('\n').forEach((line, index) => {
      if (/const\s+[A-Z_]*TIMEOUT_MS\s*:\s*u64\s*=\s*[0-9]/.test(line)) {
        offenders.push(`${name}:${index + 1} ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `a timeout literal outside git_timeouts.rs lets budgets diverge again: ${offenders.join(' | ')}`
  )
})

test('the timeout error prefix has one definition and no hand-written copy', () => {
  const authority = rustSources().find(({ name }) => name === 'git_timeouts.rs')
  assert.ok(authority, 'git_timeouts.rs must exist')
  assert.match(
    authority.source,
    /pub const TIMEOUT_ERROR_PREFIX: &str = "执行 git 命令超时: "/
  )
  for (const { name, source } of rustSources()) {
    if (name === 'git_timeouts.rs') continue
    assert.doesNotMatch(
      source,
      /"执行 git 命令超时: /,
      `${name} must build timeout errors from git_timeouts::TIMEOUT_ERROR_PREFIX`
    )
  }
})
