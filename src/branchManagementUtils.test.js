import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBatchDeleteRequests,
  buildBranchDeleteRequest,
  filterBranchManagementRows,
  getSelectableBranchIdentities,
  normalizeBranchDeleteTarget,
  normalizeBranchManagementRows,
} from './branchManagementUtils.js'

const overview = {
  branches: [
    {
      identity: 'local:main',
      name: 'main',
      local_name: 'main',
      is_current: true,
      has_local: true,
      has_remote: true,
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
      comparison_state: 'ok',
    },
    {
      identity: 'local:feature',
      name: 'feature',
      local_name: 'feature',
      is_current: false,
      has_local: true,
      has_remote: true,
      upstream: 'origin/feature',
      ahead: 2,
      behind: 0,
      comparison_state: 'ok',
    },
    {
      identity: 'remote:refs/remotes/origin/remote-only',
      name: 'origin/remote-only',
      local_name: 'remote-only',
      is_remote_only: true,
      has_local: false,
      has_remote: true,
      upstream: 'origin/remote-only',
      comparison_state: 'remote-only',
    },
  ],
}

const meta = {
  default_branch: 'main',
  remote_default_branches: { origin: 'main' },
}

test('normalization protects the default branch and exposes safe branch syncs', () => {
  const rows = normalizeBranchManagementRows(overview, meta, { modified: [], conflicted: [] })
  assert.equal(rows[0].isDefault, true)
  assert.equal(rows[0].canDelete, false)
  assert.equal(rows[0].deleteDisabledReason, '默认分支不能删除。')
  assert.equal(rows[0].canSync, true)
  assert.equal(rows[0].syncDirection, 'pull')
  assert.equal(rows[1].canSync, true)
  assert.equal(rows[1].syncDirection, 'push')
  assert.equal(rows[2].canSync, false)
  assert.equal(rows[2].canDelete, true)
})

test('current dirty branch cannot pull but another branch can still push', () => {
  const rows = normalizeBranchManagementRows(overview, meta, { modified: ['src/App.jsx'], conflicted: [] })
  assert.equal(rows[0].canSync, false)
  assert.match(rows[0].syncDisabledReason, /未提交改动/)
  assert.equal(rows[1].canSync, true)
})

test('delete request always deletes a remote-only row remotely without force', () => {
  const rows = normalizeBranchManagementRows(overview, meta, {})
  assert.deepEqual(buildBranchDeleteRequest(rows[2], { forceDelete: true }), {
    identity: rows[2].identity,
    branch: 'remote-only',
    remoteBranch: 'origin/remote-only',
    deleteLocal: false,
    deleteRemote: true,
    forceDelete: false,
  })
})

test('local delete request carries the explicit force-delete choice', () => {
  const rows = normalizeBranchManagementRows(overview, meta, {})
  assert.deepEqual(buildBranchDeleteRequest(rows[1], { forceDelete: true }), {
    identity: 'local:feature',
    branch: 'feature',
    remoteBranch: null,
    deleteLocal: true,
    deleteRemote: false,
    forceDelete: true,
  })
})

test('overview branch items adapt to the same delete request rule as complete-view rows', () => {
  const [mainItem, featureItem, remoteOnlyItem] = overview.branches

  assert.deepEqual(
    buildBranchDeleteRequest(normalizeBranchDeleteTarget(featureItem), { includeRemote: true, forceDelete: true }),
    {
      identity: 'local:feature',
      branch: 'feature',
      remoteBranch: 'origin/feature',
      deleteLocal: true,
      deleteRemote: true,
      forceDelete: true,
    }
  )
  assert.deepEqual(buildBranchDeleteRequest(normalizeBranchDeleteTarget(mainItem), {}), {
    identity: 'local:main',
    branch: 'main',
    remoteBranch: null,
    deleteLocal: true,
    deleteRemote: false,
    forceDelete: false,
  })
  assert.deepEqual(
    buildBranchDeleteRequest(normalizeBranchDeleteTarget(remoteOnlyItem), { forceDelete: true }),
    {
      identity: 'remote:refs/remotes/origin/remote-only',
      branch: 'remote-only',
      remoteBranch: 'origin/remote-only',
      deleteLocal: false,
      deleteRemote: true,
      forceDelete: false,
    }
  )
})

test('overview adapter refuses items without a local or remote delete target', () => {
  const target = normalizeBranchDeleteTarget({ identity: 'local:blank', name: '' })
  assert.equal(target.canDelete, false)
  assert.equal(buildBranchDeleteRequest(target, {}), null)
})

test('batch requests omit protected rows and optionally include upstream deletion', () => {
  const rows = normalizeBranchManagementRows(overview, meta, {})
  const requests = buildBatchDeleteRequests(rows, new Set(rows.map((row) => row.identity)), {
    includeRemote: true,
    forceDelete: true,
  })
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0], {
    identity: 'local:feature',
    branch: 'feature',
    remoteBranch: 'origin/feature',
    deleteLocal: true,
    deleteRemote: true,
    forceDelete: true,
  })
  assert.equal(requests[1].deleteRemote, true)
  assert.equal(requests[1].forceDelete, false)
  assert.deepEqual(getSelectableBranchIdentities(rows), ['local:feature', 'remote:refs/remotes/origin/remote-only'])
})

test('search covers branch, upstream, hash and semantic tags', () => {
  const rows = normalizeBranchManagementRows({
    branches: [{
      identity: 'local:release',
      name: 'release',
      local_name: 'release',
      upstream: 'upstream/release',
      has_local: true,
      has_remote: true,
      head_hash: 'abc1234',
      comparison_state: 'ok',
    }],
  }, { remote_default_branches: { upstream: 'release' } }, {})
  assert.equal(filterBranchManagementRows(rows, 'abc1234').length, 1)
  assert.equal(filterBranchManagementRows(rows, '默认').length, 1)
  assert.equal(filterBranchManagementRows(rows, 'missing').length, 0)
})

test('batch requests prefer the local row even when the duplicate remote row appears first', () => {
  const rows = normalizeBranchManagementRows({
    branches: [
      {
        identity: 'remote:refs/remotes/origin/feature',
        name: 'origin/feature',
        local_name: 'feature',
        upstream: 'origin/feature',
        remote_name: 'origin',
        is_remote_only: false,
        has_local: true,
        has_remote: true,
        comparison_state: 'remote-only',
      },
      {
        identity: 'local:feature',
        name: 'feature',
        local_name: 'feature',
        upstream: 'origin/feature',
        has_local: true,
        has_remote: true,
        comparison_state: 'ok',
      },
    ],
  }, { remote_default_branches: { origin: 'main' } }, {})
  const requests = buildBatchDeleteRequests(rows, new Set(rows.map((row) => row.identity)), {
    includeRemote: true,
    forceDelete: true,
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].identity, 'local:feature')
  assert.equal(requests[0].deleteLocal, true)
  assert.equal(requests[0].deleteRemote, true)
  assert.equal(requests[0].forceDelete, true)
  assert.equal(requests[0].remoteBranch, 'origin/feature')
})
