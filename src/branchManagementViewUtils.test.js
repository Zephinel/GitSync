import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRANCH_MANAGEMENT_VIEW_MODE,
  getBranchManagementViewSummary,
  getBranchManagementVisibleRows,
  normalizeBranchManagementViewMode,
} from './branchManagementViewUtils.js'

const rows = [
  { identity: 'local-main', rowName: 'main', localName: 'main', upstream: 'origin/main', isRemoteRow: false, isRemoteOnly: false, isDefault: true, canSync: false },
  { identity: 'local-feature', rowName: 'feature', localName: 'feature', upstream: 'origin/feature', isRemoteRow: false, isRemoteOnly: false, isDefault: false, canSync: true },
  { identity: 'remote-main', rowName: 'origin/main', remoteRef: 'origin/main', isRemoteRow: true, isRemoteOnly: false, isDefault: true, canSync: false },
  { identity: 'remote-feature', rowName: 'origin/feature', remoteRef: 'origin/feature', isRemoteRow: true, isRemoteOnly: false, isDefault: false, canSync: false },
  { identity: 'remote-only', rowName: 'origin/new-branch', remoteRef: 'origin/new-branch', isRemoteRow: true, isRemoteOnly: true, isDefault: false, canSync: false },
]

test('defaults invalid view values to the logical branch view', () => {
  assert.equal(normalizeBranchManagementViewMode('unknown'), BRANCH_MANAGEMENT_VIEW_MODE.branches)
  assert.equal(normalizeBranchManagementViewMode('refs'), BRANCH_MANAGEMENT_VIEW_MODE.refs)
})

test('logical branch view hides remote refs already represented by local rows', () => {
  assert.deepEqual(getBranchManagementVisibleRows(rows).map((row) => row.identity), ['local-main', 'local-feature', 'remote-only'])
})

test('reference view keeps every local and remote ref', () => {
  assert.deepEqual(getBranchManagementVisibleRows(rows, BRANCH_MANAGEMENT_VIEW_MODE.refs).map((row) => row.identity), rows.map((row) => row.identity))
})

test('logical summary counts branches rather than duplicated refs', () => {
  assert.deepEqual(getBranchManagementViewSummary(rows), [
    ['分支', 3], ['本地', 2], ['仅远端', 1], ['可同步', 1], ['默认分支', 1],
  ])
})

test('reference summary exposes full ref counts for advanced inspection', () => {
  assert.deepEqual(getBranchManagementViewSummary(rows, BRANCH_MANAGEMENT_VIEW_MODE.refs), [
    ['引用', 5], ['本地', 2], ['远端引用', 3], ['可同步', 1], ['默认引用', 2],
  ])
})
