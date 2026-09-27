import test from 'node:test'
import assert from 'node:assert/strict'
import { getBranchAttention } from './branchAttentionUtils.js'
import {
  beginBranchOperation,
  clearBranchSnapshotsForPaths,
  completeBranchOperation,
  getActiveBranchOperationPaths,
  getBranchDataRevision,
  getBranchReadGeneration,
  getBranchOperationRevision,
  getBranchSnapshotChangesSince,
  getBranchSnapshotRevision,
  getLatestBranchDataChange,
  getLatestBranchOverviewSnapshot,
  getLatestBranchStatusSnapshot,
  markBranchOperationAwaitingRefresh,
  publishBranchSnapshot,
  registerBranchOverview,
  registerBranchStatus,
  resetBranchDomainStoreForTests,
  resolveBranchOverview,
  subscribeBranchData,
  subscribeBranchOperations,
  subscribeBranchReadInvalidations,
  subscribeBranchSnapshots,
} from './branchDomainStore.js'

test('publishes repository-scoped data only after a completed operation', () => {
  resetBranchDomainStoreForTests()
  const dataRevisions = []
  const operationRevisions = []
  const unsubscribeData = subscribeBranchData(() => dataRevisions.push(getBranchDataRevision()))
  const unsubscribeOperations = subscribeBranchOperations(() => operationRevisions.push(getBranchOperationRevision()))
  const original = {
    current_branch: 'topic',
    head_hash: 'abc123',
    preferred_remote: 'origin',
    remote_branch_count: 1,
    branches: [{
      identity: 'remote:topic',
      name: 'origin/topic',
      local_name: 'topic',
      is_current: false,
      has_local: false,
      is_remote_only: true,
    }],
  }
  const refreshed = {
    current_branch: 'main',
    head_hash: 'def456',
    preferred_remote: 'origin',
    remote_branch_count: 0,
    branches: [],
  }

  const overviewSnapshot = registerBranchOverview('C:\\Repo\\', original)
  const statusSnapshot = registerBranchStatus('C:\\Repo\\', {
    branch: 'topic',
    behind: 2,
    last_commit: { hash: 'abc123' },
  })
  assert.equal(overviewSnapshot.branches.length, 1)
  assert.equal(getBranchAttention(overviewSnapshot)?.branch, 'topic')
  assert.equal(getBranchAttention(overviewSnapshot)?.action, 'details')
  assert.equal(getBranchAttention(overviewSnapshot)?.actionLabel, '查看详情')
  assert.equal(statusSnapshot.branch, 'topic')
  assert.equal(dataRevisions.length, 0, 'ordinary reads must not rerender the application')
  assert.equal(operationRevisions.length, 0)

  const normalOverviewSnapshot = registerBranchOverview('c:/Repo', { ...original, remote_branch_count: 2 })
  const normalStatusSnapshot = registerBranchStatus('c:/Repo', {
    branch: 'main',
    behind: 0,
    last_commit: { hash: 'def456' },
  })
  assert.notEqual(normalOverviewSnapshot, overviewSnapshot)
  assert.notEqual(normalStatusSnapshot, statusSnapshot)
  assert.equal(overviewSnapshot.remote_branch_count, 2)
  assert.equal(statusSnapshot.branch, 'main')
  assert.equal(dataRevisions.length, 0)

  const token = beginBranchOperation({ repoPath: 'c:/Repo', command: 'delete_repo_branches_batch' })
  assert.equal(getActiveBranchOperationPaths().has('c:/Repo'), true)
  assert.equal(dataRevisions.length, 0)
  assert.equal(operationRevisions.length, 1)
  assert.equal(markBranchOperationAwaitingRefresh(token), true)
  assert.equal(operationRevisions.length, 2)

  completeBranchOperation(token, {
    overview: refreshed,
    status: { branch: 'main', behind: 0, last_commit: { hash: 'def456' } },
  })
  assert.equal(getActiveBranchOperationPaths().size, 0)
  assert.equal(resolveBranchOverview(overviewSnapshot), overviewSnapshot)
  assert.deepEqual(overviewSnapshot.branches, [])
  assert.deepEqual({ ...overviewSnapshot }, refreshed)
  assert.equal(statusSnapshot.branch, 'main')
  assert.equal(statusSnapshot.last_commit.hash, 'def456')
  assert.equal(getBranchAttention(overviewSnapshot), null)
  assert.equal(dataRevisions.length, 1)
  assert.deepEqual(getLatestBranchDataChange(), { revision: 1, repoPath: 'c:/Repo' })
  assert.equal(operationRevisions.length, 3)

  unsubscribeData()
  unsubscribeOperations()
})

test('publishes semantic snapshot changes from every reader without duplicate notifications', () => {
  resetBranchDomainStoreForTests()
  const revisions = []
  const unsubscribe = subscribeBranchSnapshots(() => revisions.push(getBranchSnapshotRevision()))
  registerBranchOverview('/repo', { current_branch: 'main', branches: [] })
  registerBranchOverview('/repo', { current_branch: 'main', branches: [] })
  registerBranchOverview('/repo', {
    current_branch: 'main',
    branches: [{ identity: 'remote:topic', name: 'origin/topic', is_remote_only: true }],
  })
  registerBranchStatus('/repo', { branch: 'main', behind: 0 })
  registerBranchStatus('/repo', { branch: 'main', behind: 0 })
  assert.deepEqual(revisions, [1, 2, 3])
  assert.deepEqual(getBranchSnapshotChangesSince(1), [
    { revision: 2, repoPath: '/repo', surface: 'overview' },
    { revision: 3, repoPath: '/repo', surface: 'status' },
  ])
  unsubscribe()
})

test('can publish a canonical snapshot outside a write lifecycle without duplicating UI logic', () => {
  resetBranchDomainStoreForTests()
  const revisions = []
  const unsubscribe = subscribeBranchData(() => revisions.push(getLatestBranchDataChange()))
  assert.equal(publishBranchSnapshot('C:\\Repo\\', {
    overview: { current_branch: 'main', branches: [] },
    status: { branch: 'main', behind: 0 },
  }), true)
  assert.deepEqual(revisions, [{ revision: 1, repoPath: 'c:/Repo' }])
  unsubscribe()
})

test('clears canonical snapshots when a repository is removed', () => {
  resetBranchDomainStoreForTests()
  registerBranchOverview('/repo', {
    current_branch: 'main',
    branches: [{ identity: 'remote:topic', name: 'origin/topic', is_remote_only: true }],
  })
  registerBranchStatus('/repo', { branch: 'main', behind: 2 })

  assert.ok(getLatestBranchOverviewSnapshot('/repo'))
  assert.ok(getLatestBranchStatusSnapshot('/repo'))
  assert.equal(getBranchReadGeneration('/repo'), 0)
  assert.equal(clearBranchSnapshotsForPaths(['/repo']), true)
  assert.equal(getLatestBranchOverviewSnapshot('/repo'), null)
  assert.equal(getLatestBranchStatusSnapshot('/repo'), null)
  assert.equal(getBranchReadGeneration('/repo'), 1)
  assert.equal(clearBranchSnapshotsForPaths(['/repo']), false)
  assert.equal(getBranchReadGeneration('/repo'), 2)
})

test('binds Windows path spellings to one read generation domain', () => {
  resetBranchDomainStoreForTests()
  const token = beginBranchOperation({ repoPath: 'C:\\Repo\\', command: 'sync_repo_branch' })

  assert.equal(token.readGeneration, 0)
  assert.equal(getBranchReadGeneration('c:/Repo'), 0)
  assert.equal(clearBranchSnapshotsForPaths(['c:/Repo']), false)
  assert.equal(getBranchReadGeneration('C:\\Repo\\'), 1)
  assert.equal(completeBranchOperation(token, { overview: { current_branch: 'old', branches: [] } }), false)

  const freshToken = beginBranchOperation({ repoPath: 'c:/Repo', command: 'sync_repo_branch' })
  assert.equal(freshToken.readGeneration, 1)
  assert.equal(clearBranchSnapshotsForPaths(['C:\\Repo\\']), false)
  assert.equal(getBranchReadGeneration('c:/Repo'), 2)
  assert.equal(completeBranchOperation(freshToken, { overview: { current_branch: 'old', branches: [] } }), false)
})

test('publishes path invalidation even when no canonical snapshot exists', () => {
  resetBranchDomainStoreForTests()
  const invalidations = []
  const unsubscribe = subscribeBranchReadInvalidations((repoPath, generation) => {
    invalidations.push({ repoPath, generation })
  })

  assert.equal(clearBranchSnapshotsForPaths(['/repo']), false)
  assert.deepEqual(invalidations, [{ repoPath: '/repo', generation: 1 }])
  unsubscribe()
})

test('rejects completing a branch operation after its repository generation changes', () => {
  resetBranchDomainStoreForTests()
  const token = beginBranchOperation({ repoPath: '/repo', command: 'sync_repo_branch' })
  assert.ok(token)
  assert.equal(clearBranchSnapshotsForPaths(['/repo']), false)

  assert.equal(completeBranchOperation(token, { overview: { current_branch: 'removed', branches: [] } }), false)
  assert.equal(getActiveBranchOperationPaths().has('/repo'), false)
  assert.equal(getLatestBranchOverviewSnapshot('/repo'), null)
})

test('refuses to replace an active operation token for the same repository', () => {
  resetBranchDomainStoreForTests()
  const first = beginBranchOperation({ repoPath: '/repo', command: 'sync_repo_branch' })
  const second = beginBranchOperation({ repoPath: '/repo', command: 'delete_repo_branches_batch' })

  assert.ok(first)
  assert.equal(second, null)
  assert.equal(getActiveBranchOperationPaths().has('/repo'), true)
  assert.equal(completeBranchOperation(first, { overview: { branches: [] } }), true)
  assert.equal(getActiveBranchOperationPaths().has('/repo'), false)
})
