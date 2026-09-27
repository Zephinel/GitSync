import test from 'node:test'
import assert from 'node:assert/strict'
import { getBranchAttention } from './branchAttentionUtils.js'
import {
  clearBranchSnapshotsForPaths,
  getBranchDataRevision,
  getActiveBranchOperationPaths,
  getLatestBranchOverview,
  getLatestBranchStatus,
  registerBranchOverview,
  registerBranchStatus,
  resetBranchDomainStoreForTests,
} from './branchDomainStore.js'
import { createBranchCommandBoundary } from './tauriCoreBridge.js'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('ignores branch reads that started before a completed write operation', async () => {
  resetBranchDomainStoreForTests()
  const repoPath = 'C:\\Repo'
  const oldOverview = createDeferred()
  let overviewCallCount = 0
  const invokeNative = async (command) => {
    if (command === 'delete_repo_branches_batch') return { success: true }
    if (command === 'get_repo_branch_overview') {
      overviewCallCount += 1
      if (overviewCallCount === 1) return oldOverview.promise
      return { current_branch: 'main', branches: [] }
    }
    if (command === 'get_repo_status') return { branch: 'main', is_clean: true }
    return null
  }
  const boundary = createBranchCommandBoundary({ invokeNative, setTimer: () => 0, clearTimer: () => {} })
  const oldRead = boundary.invoke('get_repo_branch_overview', { path: repoPath })
  await boundary.invoke('delete_repo_branches_batch', { path: repoPath, branch: 'topic' })
  assert.equal(getActiveBranchOperationPaths().has('c:/Repo'), true)
  oldOverview.resolve({
    current_branch: 'main',
    branches: [{ identity: 'remote:topic', name: 'origin/topic', local_name: 'topic', is_current: false, has_local: false, is_remote_only: true }],
  })
  await oldRead
  assert.equal(getActiveBranchOperationPaths().has('c:/Repo'), true)
  await Promise.all([
    boundary.invoke('get_repo_branch_overview', { path: repoPath }),
    boundary.invoke('get_repo_status', { path: repoPath }),
  ])
  assert.equal(getActiveBranchOperationPaths().has('c:/Repo'), false)
  assert.equal(getBranchAttention(getLatestBranchOverview(repoPath)), null)
  boundary.dispose()
})

test('does not let an older normal read overwrite a newer branch snapshot', async () => {
  resetBranchDomainStoreForTests()
  const repoPath = '/repo'
  const oldOverview = createDeferred()
  let overviewCallCount = 0
  const boundary = createBranchCommandBoundary({
    invokeNative: async (command) => {
      if (command !== 'get_repo_branch_overview') return null
      overviewCallCount += 1
      if (overviewCallCount === 1) return oldOverview.promise
      return { current_branch: 'main', branches: [] }
    },
    setTimer: () => 0,
    clearTimer: () => {},
  })
  const olderRead = boundary.invoke('get_repo_branch_overview', { path: repoPath })
  const newerSnapshot = await boundary.invoke('get_repo_branch_overview', { path: repoPath })
  assert.equal(getBranchAttention(newerSnapshot), null)
  oldOverview.resolve({
    current_branch: 'main',
    branches: [{ identity: 'remote:topic', name: 'origin/topic', local_name: 'topic', is_current: false, has_local: false, is_remote_only: true }],
  })
  const olderResult = await olderRead
  assert.equal(getBranchAttention(olderResult), null)
  assert.equal(getBranchAttention(getLatestBranchOverview(repoPath)), null)
  boundary.dispose()
})

test('does not resurrect a branch snapshot after its repository path is invalidated', async () => {
  resetBranchDomainStoreForTests()
  const repoPath = '/repo'
  const staleOverview = createDeferred()
  const staleStatus = createDeferred()
  let overviewCallCount = 0
  let statusCallCount = 0
  const boundary = createBranchCommandBoundary({
    invokeNative: async (command) => {
      if (command === 'get_repo_branch_overview') {
        overviewCallCount += 1
        return overviewCallCount === 1
          ? staleOverview.promise
          : { current_branch: 'develop', branches: [] }
      }
      if (command === 'get_repo_status') {
        statusCallCount += 1
        return statusCallCount === 1
          ? staleStatus.promise
          : { branch: 'develop', behind: 0 }
      }
      return null
    },
    setTimer: () => 0,
    clearTimer: () => {},
  })

  registerBranchOverview(repoPath, { current_branch: 'main', branches: [] })
  registerBranchStatus(repoPath, { branch: 'main', behind: 0 })
  const staleRead = boundary.invoke('get_repo_branch_overview', { path: repoPath })
  const staleStatusRead = boundary.invoke('get_repo_status', { path: repoPath })
  assert.equal(clearBranchSnapshotsForPaths([repoPath]), true)

  staleOverview.resolve({
    current_branch: 'main',
    branches: [{
      identity: 'remote:topic',
      name: 'origin/topic',
      local_name: 'topic',
      is_current: false,
      has_local: false,
      is_remote_only: true,
    }],
  })
  staleStatus.resolve({ branch: 'main', behind: 4 })

  const staleResult = await staleRead
  const staleStatusResult = await staleStatusRead
  assert.equal(staleResult, null)
  assert.equal(staleStatusResult, null)
  assert.equal(getLatestBranchOverview(repoPath), null)
  assert.equal(getLatestBranchStatus(repoPath), null)

  const freshResult = await boundary.invoke('get_repo_branch_overview', { path: repoPath })
  const freshStatusResult = await boundary.invoke('get_repo_status', { path: repoPath })
  assert.equal(freshResult.current_branch, 'develop')
  assert.equal(freshStatusResult.branch, 'develop')
  boundary.dispose()
})

test('does not let an invalidated pending operation consume re-added generation reads', async () => {
  resetBranchDomainStoreForTests()
  const repoPath = '/repo'
  let fallback = null
  const boundary = createBranchCommandBoundary({
    invokeNative: async (command) => {
      if (command === 'delete_repo_branches_batch') return { success: true }
      if (command === 'get_repo_branch_overview') return { current_branch: 'develop', branches: [] }
      if (command === 'get_repo_status') return { branch: 'develop', behind: 0 }
      return null
    },
    setTimer: (handler) => {
      fallback = handler
      return 1
    },
    clearTimer: () => {},
  })

  await boundary.invoke('delete_repo_branches_batch', { path: repoPath, branch: 'topic' })
  assert.equal(getActiveBranchOperationPaths().has(repoPath), true)
  const dataRevisionBeforeInvalidation = getBranchDataRevision()

  assert.equal(clearBranchSnapshotsForPaths([repoPath]), false)
  assert.equal(getActiveBranchOperationPaths().has(repoPath), false)
  await Promise.all([
    boundary.invoke('get_repo_branch_overview', { path: repoPath }),
    boundary.invoke('get_repo_status', { path: repoPath }),
  ])
  if (fallback) fallback()
  await flushMicrotasks()

  assert.equal(getBranchDataRevision(), dataRevisionBeforeInvalidation)
  assert.equal(getLatestBranchOverview(repoPath).current_branch, 'develop')
  assert.equal(getLatestBranchStatus(repoPath).branch, 'develop')
  boundary.dispose()
})

test('does not start a refresh for an operation that crosses repository invalidation', async () => {
  resetBranchDomainStoreForTests()
  const repoPath = '/repo'
  const operationResult = createDeferred()
  const boundary = createBranchCommandBoundary({
    invokeNative: (command) => {
      if (command === 'delete_repo_branches_batch') return operationResult.promise
      return { current_branch: 'develop', branches: [] }
    },
    setTimer: () => 0,
    clearTimer: () => {},
  })

  const operation = boundary.invoke('delete_repo_branches_batch', { path: repoPath, branch: 'topic' })
  await flushMicrotasks()
  assert.equal(getActiveBranchOperationPaths().has(repoPath), true)
  assert.equal(clearBranchSnapshotsForPaths([repoPath]), false)
  operationResult.resolve({ success: true })
  await operation

  assert.equal(getActiveBranchOperationPaths().has(repoPath), false)
  boundary.dispose()
})

test('does not let invalidated fallback advance sequence over fresh generation reads', async () => {
  resetBranchDomainStoreForTests()
  const repoPath = '/repo'
  const oldOverview = createDeferred()
  const oldStatus = createDeferred()
  const lateFreshOverview = createDeferred()
  let overviewCallCount = 0
  let statusCallCount = 0
  let fallback = null
  const boundary = createBranchCommandBoundary({
    invokeNative: (command) => {
      if (command === 'delete_repo_branches_batch') return Promise.resolve({ success: true })
      if (command === 'get_repo_branch_overview') {
        overviewCallCount += 1
        if (overviewCallCount === 1) return oldOverview.promise
        if (overviewCallCount < 4) return { current_branch: 'main', branches: [] }
        return lateFreshOverview.promise
      }
      if (command === 'get_repo_status') {
        statusCallCount += 1
        if (statusCallCount === 1) return oldStatus.promise
        return { branch: 'main', behind: 0 }
      }
      return null
    },
    setTimer: (handler) => {
      fallback = handler
      return 1
    },
    clearTimer: () => {},
  })

  await boundary.invoke('delete_repo_branches_batch', { path: repoPath, branch: 'topic' })
  assert.equal(typeof fallback, 'function')
  fallback()
  assert.equal(overviewCallCount, 1)
  assert.equal(statusCallCount, 1)

  assert.equal(clearBranchSnapshotsForPaths([repoPath]), false)
  assert.equal(getActiveBranchOperationPaths().has(repoPath), false)
  await boundary.invoke('get_repo_branch_overview', { path: repoPath })
  await boundary.invoke('get_repo_branch_overview', { path: repoPath })
  const lateFreshRead = boundary.invoke('get_repo_branch_overview', { path: repoPath })

  oldOverview.resolve({ current_branch: 'removed', branches: [] })
  oldStatus.resolve({ branch: 'removed', behind: 9 })
  await flushMicrotasks()

  lateFreshOverview.resolve({ current_branch: 'develop', branches: [] })
  const lateFreshResult = await lateFreshRead
  assert.equal(lateFreshResult.current_branch, 'develop')
  assert.equal(getLatestBranchOverview(repoPath).current_branch, 'develop')
  boundary.dispose()
})

test('does not mutate an invalidated fallback after its snapshot generation check', async () => {
  resetBranchDomainStoreForTests()
  const repoPath = '/repo'
  const freshOverview = createDeferred()
  let overviewCallCount = 0
  let fallback = null
  let freshRead = null
  let boundary
  boundary = createBranchCommandBoundary({
    invokeNative: (command) => {
      if (command === 'delete_repo_branches_batch') return { success: true }
      if (command === 'get_repo_branch_overview') {
        overviewCallCount += 1
        return overviewCallCount === 1
          ? { current_branch: 'old', branches: [] }
          : freshOverview.promise
      }
      if (command === 'get_repo_status') return { branch: 'old', behind: 7 }
      return null
    },
    allSettled: (values) => {
      const settled = Promise.allSettled(values)
      settled.then(() => {
        queueMicrotask(() => {
          clearBranchSnapshotsForPaths([repoPath])
          freshRead = boundary.invoke('get_repo_branch_overview', { path: repoPath })
        })
      })
      return settled
    },
    setTimer: (handler) => {
      fallback = handler
      return 1
    },
    clearTimer: () => {},
  })

  await boundary.invoke('delete_repo_branches_batch', { path: repoPath, branch: 'topic' })
  assert.equal(typeof fallback, 'function')
  fallback()
  await flushMicrotasks()

  assert.ok(freshRead)
  assert.equal(getActiveBranchOperationPaths().has(repoPath), false)
  freshOverview.resolve({ current_branch: 'develop', branches: [] })
  const freshResult = await freshRead
  assert.equal(freshResult.current_branch, 'develop')
  assert.equal(getLatestBranchOverview(repoPath).current_branch, 'develop')
  boundary.dispose()
})

test('uses one bounded fallback read when the operation caller does not refresh', async () => {
  resetBranchDomainStoreForTests()
  const repoPath = '/repo'
  let fallback = null
  const boundary = createBranchCommandBoundary({
    invokeNative: async (command) => {
      if (command === 'delete_repo_branches_batch') return { success: true }
      if (command === 'get_repo_branch_overview') return { current_branch: 'main', branches: [] }
      if (command === 'get_repo_status') return { branch: 'main', is_clean: true, last_commit: { hash: 'fresh123' } }
      return null
    },
    setTimer: (handler) => { fallback = handler; return 1 },
    clearTimer: () => {},
  })
  await boundary.invoke('delete_repo_branches_batch', { path: repoPath, branch: 'topic' })
  assert.equal(getActiveBranchOperationPaths().has(repoPath), true)
  assert.equal(typeof fallback, 'function')
  fallback()
  await flushMicrotasks()
  assert.equal(getActiveBranchOperationPaths().has(repoPath), false)
  assert.equal(getBranchAttention(getLatestBranchOverview(repoPath)), null)
  assert.equal(getLatestBranchStatus(repoPath).last_commit.hash, 'fresh123')
  boundary.dispose()
})

test('rejects a second mutation for the same repository until the first refresh settles', async () => {
  resetBranchDomainStoreForTests()
  const boundary = createBranchCommandBoundary({
    invokeNative: async () => ({ success: true }),
    setTimer: () => 0,
    clearTimer: () => {},
  })
  await boundary.invoke('switch_repo_branch', { path: '/repo', branch: 'feature/a' })
  await assert.rejects(
    boundary.invoke('sync_repo_branch', { path: '/repo', branch: 'feature/a' }),
    /已有分支操作正在执行或等待状态刷新/
  )
  assert.deepEqual(Array.from(getActiveBranchOperationPaths()), ['/repo'])
  boundary.dispose()
})

test('clears operation state when the command boundary is disposed', async () => {
  resetBranchDomainStoreForTests()
  const boundary = createBranchCommandBoundary({
    invokeNative: async () => ({ success: true }),
    setTimer: () => 0,
    clearTimer: () => {},
  })
  await boundary.invoke('sync_repo_branch', { path: '/repo', branch: 'main' })
  assert.equal(getActiveBranchOperationPaths().has('/repo'), true)
  boundary.dispose()
  assert.equal(getActiveBranchOperationPaths().size, 0)
})
