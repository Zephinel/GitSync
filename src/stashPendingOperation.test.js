import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeStashWorktreePath,
  pendingOperationOriginLabel,
  pendingStashOperationPermissions,
} from './stashPendingOperation.js'

test('pending operation origin presentation is an exported runtime binding', () => {
  const currentRepoPath = '/repo/worktree'

  assert.equal(
    pendingOperationOriginLabel({ originRepoPath: '/repo/worktree' }, currentRepoPath),
    '来源 worktree：/repo/worktree（当前）'
  )
  assert.equal(
    pendingOperationOriginLabel({ originRepoPath: '/repo/other' }, currentRepoPath),
    '来源 worktree：/repo/other'
  )
  assert.equal(
    pendingOperationOriginLabel({}, currentRepoPath),
    '旧记录：来源 worktree 身份不可用'
  )
})

test('pending worktree permissions and labels share the same normalized identity', () => {
  assert.equal(normalizeStashWorktreePath('C:\\Repo\\Worktree\\'), 'c:/repo/worktree')

  const permissions = pendingStashOperationPermissions(
    { originRepoPath: 'C:\\Repo\\Worktree' },
    'c:/repo/worktree/'
  )
  assert.equal(permissions.belongsToCurrent, true)
  assert.equal(permissions.canReconcile, true)
  assert.equal(permissions.canAcknowledge, true)
})
