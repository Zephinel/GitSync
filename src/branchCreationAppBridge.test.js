import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')

test('creation execute, resume and reconciliation use the canonical branch command boundary', () => {
  const bridge = read('./tauriCoreBridge.js')
  for (const command of ['execute_repo_branch_creation', 'resume_repo_branch_creation', 'reconcile_repo_branch_creation']) {
    assert.match(bridge, new RegExp(`'${command}'`))
  }
  assert.match(bridge, /beginBranchOperation\(/)
  assert.match(bridge, /waitForAuthoritativeRefresh\(token, repoPath\)/)
})

test('integrated creation refreshes the complete view and repository card', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const dialog = read('./BranchCreationDialog.jsx')
  assert.match(layer, /refreshRepositorySurfaces/)
  assert.match(layer, /invoke\('refresh_repo_git_metadata'/)
  assert.match(layer, /onRepositoryChanged=\{async \(\) => refreshRepositorySurfaces\(creationTarget\.context\)\}/)
  assert.match(dialog, /await onRepositoryChanged\?\.\(next\.branchName\)/)
})

test('creation source and post-create focus are derived from structured rows', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const model = read('./branchManagementActionModel.js')
  assert.match(layer, /getBranchCreationSource\(row\)/)
  assert.match(layer, /getPreferredBranchCreationRow\(rowsForView\)/)
  assert.match(model, /kind: 'local'/)
  assert.match(model, /kind: 'remote'/)
  assert.doesNotMatch(model, /querySelector|textContent/)
})
