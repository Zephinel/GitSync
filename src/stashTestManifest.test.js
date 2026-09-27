import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const testScript = String(packageJson?.scripts?.test || '')

const RELATED_TESTS = new Set([
  'selectedStashScope.test.js',
  'sharedActionIconAuthority.test.js',
  'workingChangesStashIntegration.test.js',
])

function stashTestFiles() {
  return readdirSync(new URL('.', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^stash.*\.test\.js$/i.test(name) || RELATED_TESTS.has(name))
    .sort()
}

test('every Stash subsystem regression is registered in npm test', () => {
  const missing = stashTestFiles().filter((name) => !testScript.includes(`src/${name}`))
  assert.deepEqual(missing, [], `npm test is missing Stash regressions: ${missing.join(', ')}`)
})
