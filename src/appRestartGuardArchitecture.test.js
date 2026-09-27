import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const commands = readFileSync(new URL('../src-tauri/src/commands.rs', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')

function assertGuardBeforeMutation(functionName, mutationPattern) {
  const start = commands.indexOf(`pub async fn ${functionName}(`)
  assert.notEqual(start, -1, `${functionName} must remain an async Tauri command`)
  const guard = commands.indexOf('acquire_repo_git_guard', start)
  const mutation = commands.slice(start).search(mutationPattern)
  assert.ok(guard > start, `${functionName} must acquire the canonical Git operation guard`)
  assert.ok(mutation >= 0, `${functionName} must retain its Git mutation`)
  assert.ok(guard - start < mutation, `${functionName} must acquire the guard before mutating Git`)
}

test('conflict resolution and merge abort acquire the restart-blocking Git authority', () => {
  assertGuardBeforeMutation('resolve_conflict', /run_git_mutation\(repo_path, &\["checkout"/)
  assertGuardBeforeMutation('resolve_all_conflicts', /run_git_mutation\(&repo_path, &\["commit"/)
  assertGuardBeforeMutation('abort_merge', /run_git_mutation\(&repo_path, &\["merge", "--abort"\]/)
})

test('App only mounts the updater modal for ready or restart-critical phases', () => {
  assert.match(app, /present=\{!appUpdateState\.dismissed && \['ready', 'preparing', 'installing', 'restartRequired', 'relaunching'\]\.includes\(appUpdateState\.phase\)\}/)
  assert.match(app, /onClick=\{\['ready', 'restartRequired'\]\.includes\(updatePhase\) \? onInstallUpdate : onCheckForUpdates\}/)
  assert.doesNotMatch(app, /present=\{[^\n]*\['checking', 'downloading'/)
})
