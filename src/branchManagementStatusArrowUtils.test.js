import test from 'node:test'
import assert from 'node:assert/strict'
import { getBranchStatusDirection } from './branchManagementStatusArrowUtils.js'

test('maps directional branch states to platform-independent icon keys', () => {
  assert.deepEqual(getBranchStatusDirection('待推送 4'), {
    direction: 'up',
    label: '本地领先，待推送到远端',
  })
  assert.deepEqual(getBranchStatusDirection('落后 12'), {
    direction: 'down',
    label: '本地落后，需要从远端同步',
  })
  assert.deepEqual(getBranchStatusDirection('分叉 2/3'), {
    direction: 'diverged',
    label: '本地与远端双向分叉',
  })
  assert.deepEqual(getBranchStatusDirection('已同步'), {
    direction: 'synced',
    label: '本地与远端保持同步',
  })
  assert.deepEqual(getBranchStatusDirection('仅远端'), {
    direction: 'remote',
    label: '仅存在远端引用，可拉取到本地',
  })
})

test('does not invent directional meaning for error and upstream states', () => {
  assert.equal(getBranchStatusDirection('读取失败'), null)
  assert.equal(getBranchStatusDirection('上游已删除'), null)
  assert.equal(getBranchStatusDirection('无 upstream'), null)
  assert.equal(getBranchStatusDirection(''), null)
})
