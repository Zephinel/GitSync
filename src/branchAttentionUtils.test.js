import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRANCH_ATTENTION_KIND,
  getBranchAttention,
  getBranchAttentionItems,
  getBranchAttentionKey,
  getBranchAttentionSummary,
  parseDismissedBranchAttentionKeys,
} from './branchAttentionUtils.js'

test('keeps the current branch outside other-branch reminders', () => {
  const overview = {
    branches: [
      {
        identity: 'local:feature-a',
        name: 'feature-a',
        local_name: 'feature-a',
        is_current: true,
        has_local: true,
        upstream: 'origin/feature-a',
        ahead: 0,
        behind: 48,
        comparison_state: 'ok',
      },
      {
        identity: 'remote:refs/remotes/origin/backup-a',
        name: 'origin/backup-a',
        local_name: 'backup-a',
        is_current: false,
        has_local: false,
        upstream: 'origin/backup-a',
        is_remote_only: true,
        comparison_state: 'remote-only',
      },
      {
        identity: 'remote:refs/remotes/origin/backup-b',
        name: 'origin/backup-b',
        local_name: 'backup-b',
        is_current: false,
        has_local: false,
        upstream: 'origin/backup-b',
        is_remote_only: true,
        comparison_state: 'remote-only',
      },
    ],
  }

  const summary = getBranchAttentionSummary(overview)
  assert.equal(summary.count, 2)
  assert.equal(summary.message, '发现 2 个仅远端分支')
  assert.equal(summary.detail, '仅远端 2')
  assert.deepEqual(summary.items.map((item) => item.branch), ['backup-a', 'backup-b'])
  assert.equal(summary.items.some((item) => item.branch === 'feature-a'), false)
})

test('uses a details action for one non-current branch that is behind its upstream', () => {
  const branchItem = {
    identity: 'local:main',
    name: 'main',
    local_name: 'main',
    is_current: false,
    has_local: true,
    upstream: 'origin/main',
    ahead: 0,
    behind: 2,
    comparison_state: 'ok',
  }

  assert.deepEqual(getBranchAttention({ branches: [branchItem] }), {
    count: 1,
    message: 'main 落后远端 2 个提交',
    reason: '',
    action: 'details',
    actionLabel: '查看详情',
    branch: 'main',
    branchItem,
  })
})

test('uses a details action for one remote-only branch', () => {
  const branchItem = {
    identity: 'remote:refs/remotes/origin/topic',
    name: 'origin/topic',
    local_name: 'topic',
    is_current: false,
    has_local: false,
    upstream: 'origin/topic',
    ahead: 0,
    behind: 0,
    is_remote_only: true,
    comparison_state: 'remote-only',
  }

  assert.deepEqual(getBranchAttention({ branches: [branchItem] }), {
    count: 1,
    message: '发现仅远端分支 topic',
    reason: '',
    action: 'details',
    actionLabel: '查看详情',
    branch: 'topic',
    branchItem,
  })
})

test('summarizes mixed reminder types without hiding the reasons', () => {
  const overview = {
    branches: [
      {
        identity: 'local:main',
        name: 'main',
        local_name: 'main',
        is_current: false,
        has_local: true,
        upstream: 'origin/main',
        ahead: 0,
        behind: 1,
        comparison_state: 'ok',
      },
      {
        identity: 'remote:refs/remotes/origin/topic',
        name: 'origin/topic',
        local_name: 'topic',
        is_current: false,
        has_local: false,
        upstream: 'origin/topic',
        ahead: 0,
        behind: 0,
        is_remote_only: true,
        comparison_state: 'remote-only',
      },
      {
        identity: 'local:legacy',
        name: 'legacy',
        local_name: 'legacy',
        is_current: false,
        has_local: true,
        upstream: 'origin/legacy',
        upstream_gone: true,
        comparison_state: 'upstream-gone',
      },
    ],
  }

  assert.deepEqual(getBranchAttention(overview), {
    count: 3,
    message: '其他分支：仅远端 1 · 落后 1 · 上游失效 1',
    reason: '',
    action: 'details',
    actionLabel: '查看详情',
    branch: '',
    branchItem: null,
  })

  const items = getBranchAttentionItems(overview)
  assert.deepEqual(items.map((item) => item.kind), [
    BRANCH_ATTENTION_KIND.behind,
    BRANCH_ATTENTION_KIND.remoteOnly,
    BRANCH_ATTENTION_KIND.upstreamGone,
  ])
  assert.match(items[0].reason, /落后 origin\/main 1 个提交/)
  assert.match(items[1].reason, /本地尚未建立对应分支/)
  assert.match(items[2].reason, /远端分支已经不存在/)
})

test('describes a divergent branch instead of treating it as ordinary behind', () => {
  const branchItem = {
    identity: 'local:main',
    name: 'main',
    local_name: 'main',
    is_current: false,
    has_local: true,
    upstream: 'origin/main',
    ahead: 1,
    behind: 2,
    comparison_state: 'ok',
  }

  const summary = getBranchAttentionSummary({ branches: [branchItem] })
  assert.equal(summary.message, 'main 已分叉')
  assert.equal(summary.items[0].kind, BRANCH_ATTENTION_KIND.diverged)
  assert.equal(summary.items[0].reason, '本地领先 1、落后 2 个提交，分支已经分叉。')
})

test('creates a stable dismissal key that changes with branch attention state', () => {
  const main = {
    identity: 'local:main',
    name: 'main',
    local_name: 'main',
    is_current: false,
    has_local: true,
    upstream: 'origin/main',
    ahead: 0,
    behind: 2,
    comparison_state: 'ok',
  }
  const topic = {
    identity: 'remote:refs/remotes/origin/topic',
    name: 'origin/topic',
    local_name: 'topic',
    is_current: false,
    has_local: false,
    upstream: 'origin/topic',
    ahead: 0,
    behind: 0,
    is_remote_only: true,
    comparison_state: 'remote-only',
  }

  const key = getBranchAttentionKey({ branches: [main, topic] })
  assert.equal(key, getBranchAttentionKey({ branches: [topic, main] }))
  assert.notEqual(key, getBranchAttentionKey({ branches: [{ ...main, behind: 3 }, topic] }))
  assert.equal(getBranchAttentionKey({ branches: [{ ...main, is_current: true }] }), '')
})

test('restores only valid dismissed branch attention keys after a cold start', () => {
  assert.deepEqual(parseDismissedBranchAttentionKeys(JSON.stringify({
    ' repo-a ': ' attention-a ',
    'repo-b': 'attention-b',
    'repo-empty': '',
    'repo-invalid': 42,
  })), {
    'repo-a': 'attention-a',
    'repo-b': 'attention-b',
  })
  assert.deepEqual(parseDismissedBranchAttentionKeys('not-json'), {})
  assert.deepEqual(parseDismissedBranchAttentionKeys(JSON.stringify(['attention-a'])), {})
})