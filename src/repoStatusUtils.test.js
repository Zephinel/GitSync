import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRefreshFailureNoticeMessage,
  buildSuccessfulSyncTimesByRepoId,
  compareReposByCleanSortOrder,
  compareReposByDashboardSortOrder,
  createRepoStatusIssue,
  DASHBOARD_REPO_FILTER_MODE,
  DEFAULT_DASHBOARD_REPO_SORT_MODE,
  DASHBOARD_REPO_SORT_MODE,
  formatRelativeTimeFromMs,
  getRepoCleanSortTimestamp,
  getRepoDashboardGroupKey,
  hasRepoPendingChanges,
  hasRepoStatusIssue,
  getRepoStatusIssueDisplay,
  getDashboardRepoFilterCategory,
  hasRepoLocalUncommittedChanges,
  hasRepoNewChanges,
  matchesDashboardRepoFilter,
  normalizeDashboardRepoFilterMode,
  normalizeRepoSyncTimestampToMs,
  normalizeRepoTimestampToMs,
  normalizeDashboardRepoSortMode,
  REPO_DASHBOARD_GROUP_KEY,
  isRepoSyncInProgress,
  shouldGroupRepoAsChanged,
  getRepoSyncSortTimestamp,
} from './repoStatusUtils.js'

test('returns false for empty status', () => {
  assert.equal(hasRepoPendingChanges(null), false)
  assert.equal(hasRepoPendingChanges({}), false)
})

test('normalizes legacy seconds and millisecond repo timestamps', () => {
  assert.equal(normalizeRepoTimestampToMs('1710000000'), 1710000000000)
  assert.equal(normalizeRepoTimestampToMs('1710000000123'), 1710000000123)
  assert.equal(normalizeRepoTimestampToMs(null), 0)
  assert.equal(normalizeRepoTimestampToMs('bad'), 0)
})

test('accepts only the six dashboard repository sort modes', () => {
  assert.equal(DEFAULT_DASHBOARD_REPO_SORT_MODE, DASHBOARD_REPO_SORT_MODE.syncDesc)
  assert.equal(
    normalizeDashboardRepoSortMode(DASHBOARD_REPO_SORT_MODE.nameAsc),
    DASHBOARD_REPO_SORT_MODE.nameAsc
  )
  assert.equal(
    normalizeDashboardRepoSortMode(DASHBOARD_REPO_SORT_MODE.syncDesc),
    DASHBOARD_REPO_SORT_MODE.syncDesc
  )
  assert.equal(normalizeDashboardRepoSortMode('unknown'), null)
})

test('normalizes dashboard filters and classifies sync and local changes independently', () => {
  assert.equal(normalizeDashboardRepoFilterMode('unknown'), DASHBOARD_REPO_FILTER_MODE.all)
  assert.equal(hasRepoNewChanges({ behind: 2 }), true)
  assert.equal(hasRepoNewChanges({ ahead: 1 }), true)
  assert.equal(hasRepoNewChanges({ needs_upstream_publish: true }), true)
  assert.equal(hasRepoLocalUncommittedChanges({ modified: ['src/a.js'] }), true)
  assert.equal(hasRepoLocalUncommittedChanges({ conflicted: ['src/a.js'] }), true)

  const repo = { id: 'repo', status: 'idle', error_logs: [] }
  assert.equal(
    getDashboardRepoFilterCategory(repo, { behind: 2 }, null, null),
    DASHBOARD_REPO_FILTER_MODE.newChanges
  )
  assert.equal(
    getDashboardRepoFilterCategory(repo, { modified: ['src/a.js'] }, null, null),
    DASHBOARD_REPO_FILTER_MODE.localChanges
  )
  assert.equal(
    getDashboardRepoFilterCategory(repo, { ahead: 1, modified: ['src/a.js'] }, null, null),
    DASHBOARD_REPO_FILTER_MODE.newAndLocalChanges
  )
  assert.equal(
    getDashboardRepoFilterCategory(repo, {
      comparison_state: 'ok',
      is_clean: true,
      behind: 0,
      ahead: 0,
      needs_upstream_publish: false,
      modified: [],
      conflicted: [],
    }, null, null),
    DASHBOARD_REPO_FILTER_MODE.synced
  )
})

test('the combined change filter unions remote and local changes while single filters stay exact', () => {
  const repo = { id: 'repo', status: 'idle' }
  const combined = DASHBOARD_REPO_FILTER_MODE.newAndLocalChanges
  const localOnly = DASHBOARD_REPO_FILTER_MODE.localChanges
  const remoteOnly = DASHBOARD_REPO_FILTER_MODE.newChanges
  const cleanStatus = {
    comparison_state: 'ok',
    is_clean: true,
    ahead: 0,
    behind: 0,
    needs_upstream_publish: false,
    modified: [],
    conflicted: [],
  }

  // Union: remote-only, local-only and both all qualify, so the combined filter is
  // never narrower than either single-condition filter.
  assert.equal(matchesDashboardRepoFilter(repo, { ahead: 1 }, null, null, combined), true)
  assert.equal(matchesDashboardRepoFilter(repo, { modified: ['src/a.js'] }, null, null, combined), true)
  assert.equal(
    matchesDashboardRepoFilter(repo, { ahead: 1, modified: ['src/a.js'] }, null, null, combined),
    true
  )

  // Nothing changed, or unclassifiable (failure / stale), stays out of the union.
  assert.equal(matchesDashboardRepoFilter(repo, cleanStatus, null, null, combined), false)
  assert.equal(matchesDashboardRepoFilter({ status: 'error' }, { ahead: 1 }, null, null, combined), false)

  // The single-condition filters remain exact, so they stay distinguishable.
  assert.equal(matchesDashboardRepoFilter(repo, { modified: ['src/a.js'] }, null, null, localOnly), true)
  assert.equal(matchesDashboardRepoFilter(repo, { ahead: 1, modified: ['src/a.js'] }, null, null, localOnly), false)
  assert.equal(matchesDashboardRepoFilter(repo, { ahead: 1 }, null, null, remoteOnly), true)
  assert.equal(matchesDashboardRepoFilter(repo, { ahead: 1, modified: ['src/a.js'] }, null, null, remoteOnly), false)
})

test('dashboard status filters keep active sync visible and do not call stale status synced', () => {
  const staleIssue = createRepoStatusIssue('statusRefresh', 'status unavailable')
  assert.equal(
    matchesDashboardRepoFilter({ status: 'syncing' }, { behind: 0 }, null, staleIssue, DASHBOARD_REPO_FILTER_MODE.newChanges),
    true
  )
  assert.equal(
    matchesDashboardRepoFilter({ status: 'idle' }, { behind: 0, modified: [] }, null, staleIssue, DASHBOARD_REPO_FILTER_MODE.synced),
    false
  )
  assert.equal(
    matchesDashboardRepoFilter({ status: 'idle' }, { behind: 0, modified: [] }, null, staleIssue, DASHBOARD_REPO_FILTER_MODE.all),
    true
  )
  assert.equal(
    getDashboardRepoFilterCategory({ status: 'idle' }, null, null, null),
    null
  )
  assert.equal(
    getDashboardRepoFilterCategory({ status: 'idle' }, { status_timed_out: true }, null, null),
    null
  )
  assert.equal(
    getDashboardRepoFilterCategory({ status: 'idle' }, { comparison_state: 'error' }, null, null),
    null
  )
})

test('dashboard synced category requires a healthy idle repository and positive clean status', () => {
  const cleanStatus = {
    comparison_state: 'ok',
    is_clean: true,
    modified: [],
    conflicted: [],
    ahead: 0,
    behind: 0,
    needs_upstream_publish: false,
  }

  assert.equal(getDashboardRepoFilterCategory({ status: 'error' }, cleanStatus), null)
  assert.equal(getDashboardRepoFilterCategory({ status: 'conflict' }, cleanStatus), null)
  assert.equal(
    getDashboardRepoFilterCategory({ status: 'conflict' }, { ...cleanStatus, conflicted: ['src/conflict.js'] }),
    DASHBOARD_REPO_FILTER_MODE.localChanges
  )
  assert.equal(getDashboardRepoFilterCategory({ status: 'idle', last_error: 'fetch failed' }, cleanStatus), null)
  assert.equal(getDashboardRepoFilterCategory({ status: 'idle', error_logs: ['old failure'] }, cleanStatus), null)
  assert.equal(getDashboardRepoFilterCategory({ status: 'paused' }, cleanStatus), null)
  assert.equal(getDashboardRepoFilterCategory({ status: 'idle' }, { ...cleanStatus, comparison_state: 'detached' }), null)
  assert.equal(getDashboardRepoFilterCategory({ status: 'idle' }, { ...cleanStatus, detached_head: true }), null)
  assert.equal(getDashboardRepoFilterCategory({ status: 'idle' }, { ...cleanStatus, comparison_state: 'no-upstream' }), null)
  assert.equal(getDashboardRepoFilterCategory({ status: 'idle' }, { ...cleanStatus, is_clean: false }), null)
})

test('paused repositories retain their content-change categories without appearing synced', () => {
  const repo = { status: 'paused' }

  assert.equal(
    getDashboardRepoFilterCategory(repo, { comparison_state: 'ok', behind: 2 }),
    DASHBOARD_REPO_FILTER_MODE.newChanges
  )
  assert.equal(
    getDashboardRepoFilterCategory(repo, { comparison_state: 'ok', modified: ['src/a.js'] }),
    DASHBOARD_REPO_FILTER_MODE.localChanges
  )
})

test('active sync takes precedence over a stale status issue', () => {
  assert.equal(
    getDashboardRepoFilterCategory(
      { status: 'syncing' },
      { behind: 0 },
      null,
      createRepoStatusIssue('statusRefresh', 'status unavailable')
    ),
    DASHBOARD_REPO_FILTER_MODE.newChanges
  )
})

test('sorts dashboard repositories by name in both directions', () => {
  const repos = [
    { id: 'repo-b', name: 'beta' },
    { id: 'repo-a', name: 'Alpha' },
    { id: 'repo-g', name: 'gamma' },
  ]

  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(a, b, DASHBOARD_REPO_SORT_MODE.nameAsc))
      .map((repo) => repo.name),
    ['Alpha', 'beta', 'gamma']
  )
  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(a, b, DASHBOARD_REPO_SORT_MODE.nameDesc))
      .map((repo) => repo.name),
    ['gamma', 'beta', 'Alpha']
  )
})

test('sorts dashboard repositories by latest commit time and keeps missing values last', () => {
  const repos = [
    { id: 'new', name: 'new' },
    { id: 'old', name: 'old' },
    { id: 'missing', name: 'missing' },
  ]
  const repoStatuses = {
    new: { last_commit: { date: '2026-08-18 12:18:53 +0800' } },
    old: { last_commit: { date: '2026-08-18 11:06:53 +0800' } },
  }

  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(
        a,
        b,
        DASHBOARD_REPO_SORT_MODE.commitDesc,
        null,
        repoStatuses
      ))
      .map((repo) => repo.name),
    ['new', 'old', 'missing']
  )
  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(
        a,
        b,
        DASHBOARD_REPO_SORT_MODE.commitAsc,
        null,
        repoStatuses
      ))
      .map((repo) => repo.name),
    ['old', 'new', 'missing']
  )
})

test('sorts dashboard repositories by successful sync completion in both directions', () => {
  const repos = [
    { id: 'persisted-later', name: 'persisted-later', last_sync_at: '1710000000900' },
    { id: 'history-later', name: 'history-later', last_sync_at: '1710000000100' },
    { id: 'missing', name: 'missing' },
  ]
  const successfulSyncTimesByRepoId = {
    'history-later': 1710000001500,
  }

  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(
        a,
        b,
        DASHBOARD_REPO_SORT_MODE.syncDesc,
        successfulSyncTimesByRepoId
      ))
      .map((repo) => repo.name),
    ['history-later', 'persisted-later', 'missing']
  )
  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(
        a,
        b,
        DASHBOARD_REPO_SORT_MODE.syncAsc,
        successfulSyncTimesByRepoId
      ))
      .map((repo) => repo.name),
    ['persisted-later', 'history-later', 'missing']
  )
})

test('sync sort keeps missing timestamps last in both directions', () => {
  const repos = [
    { id: 'older', name: 'older', last_sync_at: '1710000000100' },
    { id: 'newer', name: 'newer', last_sync_at: '1710000000900' },
    { id: 'missing', name: 'missing' },
  ]

  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(a, b, DASHBOARD_REPO_SORT_MODE.syncDesc))
      .map((repo) => repo.id),
    ['newer', 'older', 'missing']
  )
  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(a, b, DASHBOARD_REPO_SORT_MODE.syncAsc))
      .map((repo) => repo.id),
    ['older', 'newer', 'missing']
  )
})

test('normalizes sync timestamps by unit only and keeps future-looking values', () => {
  const futureTimestamp = Date.now() + (60 * 60 * 1000)

  assert.equal(normalizeRepoSyncTimestampToMs('1710000000'), 1710000000000)
  assert.equal(normalizeRepoSyncTimestampToMs('1710000000123'), 1710000000123)
  assert.equal(normalizeRepoSyncTimestampToMs(1710000000456), 1710000000456)

  // Normalization only picks the unit (seconds vs milliseconds) and rejects
  // invalid or non-positive input. It never compares against the current wall
  // clock, so a future-looking value stays a valid timestamp rather than being
  // discarded as implausible.
  assert.equal(normalizeRepoSyncTimestampToMs(String(futureTimestamp)), futureTimestamp)
  assert.equal(normalizeRepoSyncTimestampToMs(0), 0)
  assert.equal(normalizeRepoSyncTimestampToMs(-1), 0)
  assert.equal(normalizeRepoSyncTimestampToMs('not-a-timestamp'), 0)

  assert.deepEqual(
    buildSuccessfulSyncTimesByRepoId([
      { repoId: 'repo', result: 'success', finishedAt: '1710000000' },
      { repoId: 'repo', result: 'success', finishedAt: 1710000000456 },
    ]),
    { repo: 1710000000456 }
  )
})

test('uses the newer successful history or persisted sync timestamp without mixing authorities', () => {
  const repo = { id: 'repo', last_sync_at: '1710000000100' }

  assert.equal(
    getRepoSyncSortTimestamp(repo, { repo: 1710000000900 }),
    1710000000900
  )
  assert.equal(
    getRepoSyncSortTimestamp({ ...repo, last_sync_at: '1710000001500' }, { repo: 1710000000900 }),
    1710000001500
  )
  assert.deepEqual(
    buildSuccessfulSyncTimesByRepoId([
      { repoId: 'repo', result: 'failed', finishedAt: 1710000002500 },
      { repoId: 'repo', result: 'canceled', finishedAt: 1710000003500 },
    ]),
    {}
  )
})

test('uses deterministic name and id fallback for equal sync timestamps', () => {
  const repos = [
    { id: 'repo-b', name: 'Same', last_sync_at: '1710000000100' },
    { id: 'repo-a', name: 'Same', last_sync_at: '1710000000100' },
  ]

  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(a, b, DASHBOARD_REPO_SORT_MODE.syncDesc))
      .map((repo) => repo.id),
    ['repo-a', 'repo-b']
  )
})

test('commit and sync sorting stay independent for an old commit with a recent sync', () => {
  const nowMs = Date.now()
  const repos = [
    { id: 'old-commit-recent-sync', name: 'old commit', last_sync_at: String(nowMs - 60 * 1000) },
    { id: 'new-commit-old-sync', name: 'new commit', last_sync_at: String(nowMs - 60 * 60 * 1000) },
  ]
  const repoStatuses = {
    'old-commit-recent-sync': { last_commit: { date: '2026-09-20 10:00:00 +0800' } },
    'new-commit-old-sync': { last_commit: { date: '2026-09-25 10:00:00 +0800' } },
  }

  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(
        a,
        b,
        DASHBOARD_REPO_SORT_MODE.commitDesc,
        null,
        repoStatuses
      ))
      .map((repo) => repo.id),
    ['new-commit-old-sync', 'old-commit-recent-sync']
  )
  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByDashboardSortOrder(
        a,
        b,
        DASHBOARD_REPO_SORT_MODE.syncDesc,
        null,
        repoStatuses
      ))
      .map((repo) => repo.id),
    ['old-commit-recent-sync', 'new-commit-old-sync']
  )
})

test('sorts clean repos by sync completion before created fallback', () => {
  const repos = [
    {
      name: 'older-sync-newer-created',
      last_sync_at: '1710000000100',
      created_at: '1710009999999',
    },
    {
      name: 'newer-sync-older-created',
      last_sync_at: '1710000000900',
      created_at: '1710000000000',
    },
  ]

  assert.deepEqual(
    [...repos].sort(compareReposByCleanSortOrder).map((repo) => repo.name),
    ['newer-sync-older-created', 'older-sync-newer-created']
  )
})

test('sorts clean repos by the latest commit shown on each card', () => {
  const repos = [
    {
      id: 'gitsync',
      name: 'GitSync',
      last_sync_at: '1787018023662',
      created_at: '1773379200',
    },
    {
      id: 'pi-lot-pack',
      name: 'pi-lot-pack',
      last_sync_at: '1786355360859',
      created_at: '1783179518',
    },
  ]
  const repoStatuses = {
    gitsync: {
      last_commit: { date: '2026-08-18 11:06:53 +0800' },
    },
    'pi-lot-pack': {
      last_commit: { date: '2026-08-18 12:18:53 +0800' },
    },
  }

  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByCleanSortOrder(a, b, null, repoStatuses))
      .map((repo) => repo.name),
    ['pi-lot-pack', 'GitSync']
  )
})

test('builds latest successful sync completion per repo and ignores non-success outcomes', () => {
  assert.deepEqual(
    buildSuccessfulSyncTimesByRepoId([
      { repoId: 'repo-a', result: 'success', finishedAt: 1710000000100 },
      { repoId: 'repo-a', result: 'success', finishedAt: 1710000000900 },
      { repoId: 'repo-a', result: 'failed', finishedAt: 1710000001200 },
      { repoId: 'repo-b', result: 'canceled', finishedAt: 1710000001300 },
      { repo_id: 'repo-c', result: 'success', finished_at: '1710000001400' },
    ]),
    {
      'repo-a': 1710000000900,
      'repo-c': 1710000001400,
    }
  )
})

test('uses recent successful completion when backend last_sync_at is stale', () => {
  const repos = [
    {
      id: 'persisted-newer',
      name: 'persisted-newer',
      last_sync_at: '1710000000900',
      created_at: '1710000000000',
    },
    {
      id: 'just-finished',
      name: 'just-finished',
      last_sync_at: '1710000000100',
      created_at: '1710000000000',
    },
  ]
  const successfulSyncTimesByRepoId = {
    'just-finished': 1710000001500,
  }

  assert.equal(
    getRepoCleanSortTimestamp(repos[1], successfulSyncTimesByRepoId),
    1710000001500
  )
  assert.deepEqual(
    [...repos]
      .sort((a, b) => compareReposByCleanSortOrder(a, b, successfulSyncTimesByRepoId))
      .map((repo) => repo.name),
    ['just-finished', 'persisted-newer']
  )
})

test('reconciles clean ordering from persisted sync history without waiting for repo metadata refresh', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) {
        assert.equal(key, 'gitsync-sync-history')
        return JSON.stringify([
          { repoId: 'just-finished-from-history', result: 'success', finishedAt: 1710000002500 },
          { repoId: 'failed-later', result: 'failed', finishedAt: 1710000003500 },
        ])
      },
    },
  })

  try {
    const repos = [
      {
        id: 'persisted-newer',
        name: 'persisted-newer',
        last_sync_at: '1710000001900',
        created_at: '1710000000000',
      },
      {
        id: 'just-finished-from-history',
        name: 'just-finished-from-history',
        last_sync_at: '1710000000100',
        created_at: '1710000000000',
      },
    ]

    assert.deepEqual(
      [...repos].sort(compareReposByCleanSortOrder).map((repo) => repo.name),
      ['just-finished-from-history', 'persisted-newer']
    )
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
    } else {
      delete globalThis.localStorage
    }
  }
})

test('returns true for current branch ahead/behind', () => {
  assert.equal(hasRepoPendingChanges({ ahead: 1 }), true)
  assert.equal(hasRepoPendingChanges({ behind: 2 }), true)
})

test('returns true when current branch needs publishing upstream', () => {
  assert.equal(hasRepoPendingChanges({ needs_upstream_publish: true }), true)
})

test('returns false for clean repo status', () => {
  assert.equal(
    hasRepoPendingChanges({
      modified: [],
      conflicted: [],
      ahead: 0,
      behind: 0,
      needs_upstream_publish: false,
    }),
    false
  )
})

test('ignores non-current branch overview counts for dashboard grouping', () => {
  assert.equal(
    hasRepoPendingChanges({
      modified: [],
      conflicted: [],
      ahead: 0,
      behind: 0,
      needs_upstream_publish: false,
      remote_only_count: 3,
      behind_branch_count: 2,
      updated_branch_count: 5,
    }),
    false
  )
})

test('detects repo status issue state', () => {
  assert.equal(hasRepoStatusIssue(null), false)
  assert.equal(hasRepoStatusIssue({}), false)
  assert.equal(hasRepoStatusIssue({ remoteFetch: { message: 'fetch failed' } }), true)
  assert.equal(hasRepoStatusIssue({ statusRefresh: { message: 'status failed' } }), true)
})

test('creates status issue with timestamp and relative display', () => {
  const issue = createRepoStatusIssue('remoteFetch', 'network down', 1710000000000)
  assert.equal(issue.message, '远程更新获取失败，当前状态可能不是最新。')
  assert.equal(issue.detail, 'network down')
  assert.equal(issue.updatedAt, 1710000000000)

  assert.equal(formatRelativeTimeFromMs(1710000000000, 1710000000000), '刚刚')
  assert.equal(formatRelativeTimeFromMs(1710000000000, 1710000120000), '2 分钟前')

  assert.deepEqual(
    getRepoStatusIssueDisplay({ remoteFetch: issue }, 1710000120000),
    {
      message: '远程更新获取失败，当前状态可能不是最新。',
      detail: 'network down',
      relativeTime: '2 分钟前',
    }
  )
})

test('detects sync in-progress states', () => {
  assert.equal(isRepoSyncInProgress('syncing', 'idle'), true)
  assert.equal(isRepoSyncInProgress('idle', 'running'), true)
  assert.equal(isRepoSyncInProgress('idle', 'queued'), true)
  assert.equal(isRepoSyncInProgress('idle', 'idle'), false)
})

test('groups repo as changed while sync is active even when status is clean', () => {
  assert.equal(
    shouldGroupRepoAsChanged(
      'syncing',
      {
        modified: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
      'idle'
    ),
    true
  )
  assert.equal(
    shouldGroupRepoAsChanged(
      'idle',
      {
        modified: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
      'queued'
    ),
    true
  )
})

test('does not group remote refresh and sync check overlays as changed by themselves', () => {
  assert.equal(
    shouldGroupRepoAsChanged(
      'idle',
      {
        modified: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
      'idle',
      { isRemoteRefreshing: true }
    ),
    false
  )
  assert.equal(
    shouldGroupRepoAsChanged(
      'idle',
      {
        modified: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
      'idle',
      { isSyncChecking: true }
    ),
    false
  )
})

test('does not keep clean repos in changed group during branch refresh', () => {
  assert.equal(
    shouldGroupRepoAsChanged(
      'idle',
      {
        modified: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
      'idle',
      { keepInChangedGroup: true }
    ),
    false
  )
})

test('groups stale repos ahead of changed and clean states', () => {
  assert.equal(
    getRepoDashboardGroupKey(
      'idle',
      { modified: ['a'] },
      'idle',
      { remoteFetch: createRepoStatusIssue('remoteFetch', 'timeout', 1) }
    ),
    REPO_DASHBOARD_GROUP_KEY.stale
  )
  assert.equal(
    getRepoDashboardGroupKey(
      'idle',
      { modified: ['a'] },
      'idle',
      null
    ),
    REPO_DASHBOARD_GROUP_KEY.changed
  )
})

test('keeps actively syncing repos in changed group even if status refresh failed', () => {
  const issue = { statusRefresh: createRepoStatusIssue('statusRefresh', 'timeout', 1) }

  assert.equal(
    getRepoDashboardGroupKey(
      'syncing',
      {
        modified: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
      'idle',
      issue
    ),
    REPO_DASHBOARD_GROUP_KEY.changed
  )
  assert.equal(
    getRepoDashboardGroupKey(
      'idle',
      {
        modified: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
      'running',
      issue
    ),
    REPO_DASHBOARD_GROUP_KEY.changed
  )
})

test('builds refresh failure notice message with preview and overflow count', () => {
  assert.equal(buildRefreshFailureNoticeMessage([]), '')
  assert.match(
    buildRefreshFailureNoticeMessage([
      { name: 'Repo A', message: 'timeout' },
      { name: 'Repo B', message: 'dns failed' },
      { name: 'Repo C', message: 'offline' },
    ], 2),
    /Repo A: timeout[\s\S]*Repo B: dns failed[\s\S]*还有 1 个仓库获取失败/
  )
})
