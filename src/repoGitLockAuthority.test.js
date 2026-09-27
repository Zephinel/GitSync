import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rustSourceDir = join(__dirname, '..', 'src-tauri', 'src')

function rustSources() {
  return readdirSync(rustSourceDir, { recursive: true })
    .filter((name) => String(name).endsWith('.rs'))
    .map((name) => ({
      name: String(name),
      source: readFileSync(join(rustSourceDir, name), 'utf8'),
    }))
}

test('the repository git lock map lives in exactly one module', () => {
  const owners = rustSources()
    .filter(({ source }) => /git_repo_locks\s*\.lock\(\)/.test(source))
    .map(({ name }) => name)
  assert.deepEqual(
    owners,
    ['repo_git_lock.rs'],
    `the lock map must only be touched by the lock authority, found: ${owners.join(', ')}`
  )
})

test('no module re-implements the repository git lock locally', () => {
  const offenders = []
  for (const { name, source } of rustSources()) {
    if (name === 'repo_git_lock.rs') continue
    const definition = source.match(/async fn acquire_repo_git_guard\([\s\S]*?\n\}/)
    if (!definition) continue
    if (!/repo_git_lock::acquire/.test(definition[0])) {
      offenders.push(name)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these modules must delegate to repo_git_lock instead of locking directly: ${offenders.join(', ')}`
  )
})

test('the lock wait has a single bounded budget', () => {
  const timeouts = readFileSync(join(rustSourceDir, 'git_timeouts.rs'), 'utf8')
  assert.match(timeouts, /pub const GUARD_WAIT: u64 = \d/)
  const lockAuthority = readFileSync(join(rustSourceDir, 'repo_git_lock.rs'), 'utf8')
  assert.match(lockAuthority, /tokio::time::timeout\(/)
  assert.match(lockAuthority, /git_timeouts::GUARD_WAIT/)
})
