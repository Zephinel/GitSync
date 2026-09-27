import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_NAME_VALIDATION,
  buildAiSuggestionRevision,
  buildBranchCreationInputRevision,
  canConfirmBranchCreation,
  chooseInitialSourceOption,
  normalizeAiBranchNameResult,
  normalizeBranchCreationInspection,
  normalizeBranchCreationOperation,
  normalizeBranchNameValidation,
  relationshipLabel,
} from './branchCreationUtils.js'

function inspection(overrides = {}) {
  return normalizeBranchCreationInspection({
    sourceDisplayName: 'main',
    sourceKind: 'local',
    relationship: 'behind',
    ahead: 0,
    behind: 2,
    sourceOptions: [
      { id: 'local', kind: 'local', label: 'local', fullRef: 'refs/heads/main', commit: 'a'.repeat(40) },
      { id: 'remote', kind: 'remote', label: 'remote', fullRef: 'refs/remotes/origin/main', commit: 'b'.repeat(40), recommended: true },
    ],
    defaultSourceOptionId: 'remote',
    fingerprint: 'fingerprint-1',
    ...overrides,
  })
}

test('chooses deterministic defaults but never chooses a divergent source', () => {
  assert.equal(chooseInitialSourceOption(inspection()), 'remote')
  assert.equal(chooseInitialSourceOption(inspection({ relationship: 'diverged', requiresSourceChoice: true, defaultSourceOptionId: null })), '')
})

test('normalizes validation and operation results without collapsing partial success', () => {
  assert.deepEqual(normalizeBranchNameValidation(null), EMPTY_NAME_VALIDATION)
  const result = normalizeBranchCreationOperation({
    status: 'partial',
    branchName: 'fix/example',
    localCreated: true,
    switched: false,
    remoteCreated: false,
    completedSteps: ['本地分支已创建'],
    pendingSteps: ['远端发布尚未完成'],
    retryableSteps: ['publish'],
  })
  assert.equal(result.status, 'partial')
  assert.equal(result.localCreated, true)
  assert.deepEqual(result.retryableSteps, ['publish'])
})

test('confirmation requires current production validation and an explicit source option', () => {
  const value = inspection()
  const revision = buildBranchCreationInputRevision({
    inspectionFingerprint: value.fingerprint,
    sourceOptionId: 'remote',
    branchName: 'fix/example',
    publish: false,
    remote: 'origin',
  })
  assert.equal(canConfirmBranchCreation({
    inspection: value,
    sourceOptionId: 'remote',
    validation: { valid: true },
    validationRevision: revision,
    currentRevision: revision,
    busy: false,
  }), true)
  assert.equal(canConfirmBranchCreation({
    inspection: value,
    sourceOptionId: '',
    validation: { valid: true },
    validationRevision: revision,
    currentRevision: revision,
    busy: false,
  }), false)
  assert.equal(canConfirmBranchCreation({
    inspection: value,
    sourceOptionId: 'remote',
    validation: { valid: true },
    validationRevision: revision,
    currentRevision: `${revision}-stale`,
    busy: false,
  }), false)
})

test('AI revisions expire when task, source, consent, publish, or remote changes', () => {
  const base = {
    inspectionFingerprint: 'f1',
    sourceOptionId: 'local',
    taskDescription: 'fix branch refresh',
    includeRepositoryContext: false,
    publish: false,
    remote: 'origin',
  }
  const initial = buildAiSuggestionRevision(base)
  for (const changed of [
    { taskDescription: 'other task' },
    { sourceOptionId: 'remote' },
    { includeRepositoryContext: true },
    { publish: true },
    { remote: 'upstream' },
    { inspectionFingerprint: 'f2' },
  ]) {
    assert.notEqual(buildAiSuggestionRevision({ ...base, ...changed }), initial)
  }
})

test('AI result normalization removes duplicate candidates without inventing replacements', () => {
  const result = normalizeAiBranchNameResult({
    suggestions: [
      { name: 'fix/example', reason: 'one' },
      { name: 'fix/example', reason: 'two' },
      { name: '', reason: 'empty' },
    ],
  })
  assert.deepEqual(result.suggestions, [{ name: 'fix/example', reason: 'one' }])
})

test('relationship labels expose ahead, behind, and divergence counts', () => {
  assert.equal(relationshipLabel(inspection()), '本地落后远端 2')
  assert.equal(relationshipLabel(inspection({ relationship: 'ahead', ahead: 3, behind: 0 })), '本地领先远端 3')
  assert.equal(relationshipLabel(inspection({ relationship: 'diverged', ahead: 2, behind: 4 })), '本地与远端分叉 2/4')
})
