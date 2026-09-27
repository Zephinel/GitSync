import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildUndoRemovedRepos,
  createRepoRemovalSnapshot,
  getFailedRepoIds,
  removeMissingRepoStatesByIdSet,
  removeReposByIdSet,
  removeRepoStatusesByIdSet,
  rollbackMissingRepoStatesState,
  rollbackReposState,
  rollbackRepoStatusesState,
  rollbackSelectedRepoIdsState,
} from './repoRemoveState.js'

test('createRepoRemovalSnapshot deduplicates target ids and captures snapshots', () => {
  const reposToRemove = [
    { id: ' repo-1 ', name: 'Repo1' },
    { id: 'repo-2', name: 'Repo2' },
    { id: 'repo-1', name: 'Repo1 duplicate' },
  ]
  const snapshot = createRepoRemovalSnapshot({
    reposToRemove,
    repoStatuses: { 'repo-1': { branch: 'main' } },
    missingRepoStates: { 'repo-2': { message: '目录不存在' } },
    selectedRepoIds: ['repo-2'],
    repoOrderSource: [{ id: 'repo-2' }, { id: 'repo-1' }],
  })

  assert.deepEqual(snapshot.targetRepoIds, ['repo-1', 'repo-2'])
  assert.equal(snapshot.targetRepoIdSet.has('repo-1'), true)
  assert.equal(snapshot.selectedRepoIdSetBeforeRemove.has('repo-2'), true)
  assert.deepEqual(snapshot.repoSnapshotMap.get('repo-1').repo.name, 'Repo1')
  assert.deepEqual(snapshot.repoSnapshotMap.get('repo-2').missingState, { message: '目录不存在' })
})

test('remove state helpers remove targeted repo data', () => {
  const targetRepoIdSet = new Set(['repo-2'])
  const repos = [{ id: 'repo-1' }, { id: 'repo-2' }]
  const statuses = { 'repo-1': 1, 'repo-2': 2 }
  const missingStates = { 'repo-2': { message: 'missing' } }

  assert.deepEqual(removeReposByIdSet(repos, targetRepoIdSet), [{ id: 'repo-1' }])
  assert.deepEqual(removeRepoStatusesByIdSet(statuses, targetRepoIdSet), { 'repo-1': 1 })
  assert.deepEqual(removeMissingRepoStatesByIdSet(missingStates, targetRepoIdSet), {})
})

test('rollback helpers restore removed repo data and selection', () => {
  const snapshot = createRepoRemovalSnapshot({
    reposToRemove: [
      { id: 'repo-1', name: 'Repo1' },
      { id: 'repo-2', name: 'Repo2' },
    ],
    repoStatuses: { 'repo-1': { branch: 'dev' }, 'repo-2': { branch: 'main' } },
    missingRepoStates: { 'repo-2': { message: '目录不存在' } },
    selectedRepoIds: ['repo-2'],
    repoOrderSource: [{ id: 'repo-1' }, { id: 'repo-2' }, { id: 'repo-3' }],
  })

  const rollbackIds = ['repo-2']
  const restoredRepos = rollbackReposState([{ id: 'repo-1' }, { id: 'repo-3' }], snapshot, rollbackIds)
  assert.deepEqual(restoredRepos.map((repo) => repo.id), ['repo-1', 'repo-2', 'repo-3'])

  const restoredStatuses = rollbackRepoStatusesState({ 'repo-1': { branch: 'dev' } }, snapshot, rollbackIds)
  assert.deepEqual(restoredStatuses, {
    'repo-1': { branch: 'dev' },
    'repo-2': { branch: 'main' },
  })

  const restoredMissingStates = rollbackMissingRepoStatesState({}, snapshot, rollbackIds)
  assert.deepEqual(restoredMissingStates, { 'repo-2': { message: '目录不存在' } })

  const restoredSelectedIds = rollbackSelectedRepoIdsState([], snapshot, rollbackIds)
  assert.deepEqual(restoredSelectedIds, ['repo-2'])
})

test('undo and failed ids helpers return expected result', () => {
  const reposToRemove = [
    { id: 'repo-1', name: 'Repo1' },
    { id: 'repo-2', name: 'Repo2' },
  ]
  const snapshot = createRepoRemovalSnapshot({
    reposToRemove,
    repoStatuses: {},
    missingRepoStates: {},
    selectedRepoIds: [],
    repoOrderSource: [],
  })

  const removedIdSet = new Set(['repo-2'])
  assert.deepEqual(
    buildUndoRemovedRepos(reposToRemove, snapshot, removedIdSet),
    [{ id: 'repo-2', name: 'Repo2' }]
  )
  assert.deepEqual(getFailedRepoIds(['repo-1', 'repo-2', 'repo-3'], ['repo-1', 'repo-3']), ['repo-2'])
})
