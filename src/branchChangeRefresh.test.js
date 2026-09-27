import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findBranchChangeRefreshRepo,
  refreshRepoAfterBranchChange,
  refreshRepoAfterBranchChangeWithGroupRetention,
} from './branchChangeRefresh.js'

test('finds the active repo for branch-change remote refresh', () => {
  const repo = findBranchChangeRefreshRepo([
    { id: 'repo-1', path: '/tmp/repo-1', status: 'idle' },
    { id: 'repo-2', path: '/tmp/repo-2', status: 'paused' },
  ], 'repo-1')

  assert.deepEqual(repo, { id: 'repo-1', path: '/tmp/repo-1', status: 'idle' })
})

test('ignores paused repos when resolving branch-change refresh target', () => {
  const repo = findBranchChangeRefreshRepo([
    { id: 'repo-1', path: '/tmp/repo-1', status: 'paused' },
  ], 'repo-1')

  assert.equal(repo, null)
})

test('prefers targeted remote refresh after branch change', async () => {
  const calls = []
  const targetRepo = { id: 'repo-1', path: '/tmp/repo-1', status: 'idle' }

  const result = await refreshRepoAfterBranchChange({
    repoId: 'repo-1',
    repoList: [targetRepo],
    refreshRepoRemote: async (repo) => {
      calls.push({ type: 'remote', repo })
    },
    refreshRepoStatus: async (repo) => {
      calls.push({ type: 'status', repo })
    },
    refreshRepoMetadata: async (repo) => {
      calls.push({ type: 'metadata', repo })
    },
  })

  assert.deepEqual(result, {
    kind: 'targetedRefresh',
    remoteFetched: true,
    statusRefreshed: true,
    metadataRefreshed: true,
    warning: '',
  })
  assert.deepEqual(calls, [
    { type: 'remote', repo: targetRepo },
    { type: 'status', repo: targetRepo },
    { type: 'metadata', repo: targetRepo },
  ])
})

test('does not run a full status refresh when repo is unavailable', async () => {
  const calls = []

  const result = await refreshRepoAfterBranchChange({
    repoId: 'repo-1',
    repoList: [],
    refreshRepoRemote: async () => {
      calls.push({ type: 'remote' })
    },
    refreshRepoStatus: async () => {
      calls.push({ type: 'status' })
    },
    refreshRepoMetadata: async () => {
      calls.push({ type: 'metadata' })
    },
  })

  assert.deepEqual(result, {
    kind: 'missingTarget',
    remoteFetched: false,
    statusRefreshed: false,
    metadataRefreshed: false,
    warning: '目标仓库已不可用，无法刷新状态。',
  })
  assert.deepEqual(calls, [])
})

test('keeps repo in changed group only during branch-change refresh', async () => {
  const calls = []
  const targetRepo = { id: 'repo-1', path: '/tmp/repo-1', status: 'idle' }

  const result = await refreshRepoAfterBranchChangeWithGroupRetention({
    repoId: 'repo-1',
    repoList: [targetRepo],
    refreshRepoRemote: async (repo) => {
      calls.push({ type: 'remote', repo })
    },
    refreshRepoStatus: async (repo) => {
      calls.push({ type: 'status', repo })
    },
    refreshRepoMetadata: async (repo) => {
      calls.push({ type: 'metadata', repo })
    },
    setRepoBranchRefreshing: (repoId, branchRefreshing) => {
      calls.push({ type: 'group', repoId, branchRefreshing })
    },
  })

  assert.equal(result.kind, 'targetedRefresh')
  assert.deepEqual(calls, [
    { type: 'group', repoId: 'repo-1', branchRefreshing: true },
    { type: 'remote', repo: targetRepo },
    { type: 'status', repo: targetRepo },
    { type: 'metadata', repo: targetRepo },
    { type: 'group', repoId: 'repo-1', branchRefreshing: false },
  ])
})

test('clears changed-group retention when targeted remote refresh warns', async () => {
  const calls = []

  const result = await refreshRepoAfterBranchChangeWithGroupRetention({
    repoId: 'repo-1',
    repoList: [{ id: 'repo-1', path: '/tmp/repo-1', status: 'idle' }],
    refreshRepoRemote: async () => {
      calls.push({ type: 'remote' })
      throw new Error('refresh failed')
    },
    refreshRepoStatus: async () => {
      calls.push({ type: 'status' })
    },
    setRepoBranchRefreshing: (repoId, branchRefreshing) => {
      calls.push({ type: 'group', repoId, branchRefreshing })
    },
  })

  assert.equal(result.warning, 'refresh failed')
  assert.deepEqual(calls, [
    { type: 'group', repoId: 'repo-1', branchRefreshing: true },
    { type: 'remote' },
    { type: 'status' },
    { type: 'group', repoId: 'repo-1', branchRefreshing: false },
  ])
})

test('continues metadata refresh when status refresh fails after branch change', async () => {
  const calls = []

  const result = await refreshRepoAfterBranchChange({
    repoId: 'repo-1',
    repoList: [{ id: 'repo-1', path: '/tmp/repo-1', status: 'idle' }],
    refreshRepoRemote: async () => {
      calls.push({ type: 'remote' })
    },
    refreshRepoStatus: async () => {
      calls.push({ type: 'status' })
      throw new Error('status failed')
    },
    refreshRepoMetadata: async () => {
      calls.push({ type: 'metadata' })
    },
  })

  assert.deepEqual(result, {
    kind: 'targetedRefresh',
    remoteFetched: true,
    statusRefreshed: false,
    metadataRefreshed: true,
    warning: 'status failed',
  })
  assert.deepEqual(calls, [
    { type: 'remote' },
    { type: 'status' },
    { type: 'metadata' },
  ])
})

test('aggregates branch-change refresh warnings without stopping later phases', async () => {
  const calls = []

  const result = await refreshRepoAfterBranchChange({
    repoId: 'repo-1',
    repoList: [{ id: 'repo-1', path: '/tmp/repo-1', status: 'idle' }],
    refreshRepoRemote: async () => {
      calls.push({ type: 'remote' })
      throw new Error('remote failed')
    },
    refreshRepoStatus: async () => {
      calls.push({ type: 'status' })
      throw new Error('status failed')
    },
    refreshRepoMetadata: async () => {
      calls.push({ type: 'metadata' })
      throw new Error('metadata failed')
    },
  })

  assert.deepEqual(result, {
    kind: 'targetedRefresh',
    remoteFetched: false,
    statusRefreshed: false,
    metadataRefreshed: false,
    warning: 'remote failed；status failed；metadata failed',
  })
  assert.deepEqual(calls, [
    { type: 'remote' },
    { type: 'status' },
    { type: 'metadata' },
  ])
})
