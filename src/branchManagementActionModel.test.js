import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getBranchCreationSource,
  getBranchSwitchAction,
  getPreferredBranchCreationRow,
} from './branchManagementActionModel.js'

const local = (name, extra = {}) => ({
  identity: `local:${name}`,
  rowName: name,
  localName: name,
  isRemoteRow: false,
  isRemoteOnly: false,
  ...extra,
})

const remote = (remoteRef, extra = {}) => ({
  identity: `remote:${remoteRef}`,
  rowName: remoteRef,
  remoteRef,
  remoteBranchName: remoteRef.split('/').slice(1).join('/'),
  isRemoteRow: true,
  isRemoteOnly: true,
  ...extra,
})

test('creation source uses structured local and remote identities', () => {
  assert.deepEqual(getBranchCreationSource(local('feature/a')), {
    kind: 'local',
    name: 'feature/a',
    displayName: 'feature/a',
  })
  assert.deepEqual(getBranchCreationSource(remote('origin/feature/b')), {
    kind: 'remote',
    name: 'origin/feature/b',
    displayName: 'origin/feature/b',
  })
})

test('header creation prefers the current local branch', () => {
  const rows = [remote('origin/main'), local('main'), local('feature/a', { isCurrent: true })]
  assert.equal(getPreferredBranchCreationRow(rows)?.localName, 'feature/a')
})

test('local, current, remote-only, dirty and worktree states produce deterministic switch actions', () => {
  const rows = [local('main', { isCurrent: true }), local('feature/a'), remote('origin/feature/b')]
  assert.deepEqual(
    getBranchSwitchAction(rows[1], rows, { is_clean: true }),
    {
      visible: true,
      enabled: true,
      label: '切换',
      kind: 'switch',
      branch: 'feature/a',
      remoteBranch: null,
      disabledReason: '',
    }
  )
  assert.equal(getBranchSwitchAction(rows[0], rows, { is_clean: true }).label, '当前')
  assert.equal(getBranchSwitchAction(rows[0], rows, { is_clean: true }).enabled, false)
  assert.equal(getBranchSwitchAction(rows[2], rows, { is_clean: true }).label, '跟踪')
  assert.equal(getBranchSwitchAction(rows[2], rows, { is_clean: true }).remoteBranch, 'origin/feature/b')
  assert.match(getBranchSwitchAction(rows[1], rows, { is_clean: false }).disabledReason, /未提交改动/)
  assert.match(
    getBranchSwitchAction(local('feature/c', { isCheckedOutElsewhere: true, worktreePath: '/tmp/other' }), rows, { is_clean: true }).disabledReason,
    /\/tmp\/other/
  )
})

test('remote refs with an existing local counterpart cannot create a duplicate tracking branch', () => {
  const rows = [local('feature/a'), remote('origin/feature/a')]
  const action = getBranchSwitchAction(rows[1], rows, { is_clean: true })
  assert.equal(action.enabled, false)
  assert.match(action.disabledReason, /本地分支 feature\/a 已存在/)
})
