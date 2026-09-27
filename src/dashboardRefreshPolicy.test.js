import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DASHBOARD_REFRESH_ACTION,
  FOCUS_REFRESH_REASON,
  getDashboardIntervalRefreshAction,
  getDashboardNavigationRefreshAction,
  getForegroundRefreshAction,
  getPendingFocusRefreshReasonsAfterBackgroundSyncCompletion,
  getPendingFocusRefreshReasonsAfterBackgroundSyncStart,
  getPendingFocusRefreshReasonsAfterHidden,
  getRemoteRefreshAction,
  getSyncCompletionRefreshAction,
  hasPendingFocusRefreshReasons,
} from './dashboardRefreshPolicy.js'

test('foreground refresh updates repo list and local statuses when repos already exist', () => {
  assert.equal(
    getForegroundRefreshAction({ repoCount: 17 }),
    DASHBOARD_REFRESH_ACTION.repoListAndLocalStatuses
  )
})

test('foreground refresh only loads repo list before any repo is known', () => {
  assert.equal(
    getForegroundRefreshAction({ repoCount: 0 }),
    DASHBOARD_REFRESH_ACTION.repoList
  )
})

test('dashboard interval refreshes local statuses every round', () => {
  assert.equal(
    getDashboardIntervalRefreshAction({
      page: 'dashboard',
      isWindowFocused: true,
      isRemoveMutationRunning: false,
      repoCount: 17,
    }),
    DASHBOARD_REFRESH_ACTION.localStatuses
  )
})

test('dashboard interval does not run while dashboard is hidden or mutations are active', () => {
  assert.equal(
    getDashboardIntervalRefreshAction({
      page: 'settings',
      isWindowFocused: true,
      isRemoveMutationRunning: false,
      repoCount: 17,
    }),
    DASHBOARD_REFRESH_ACTION.none
  )
  assert.equal(
    getDashboardIntervalRefreshAction({
      page: 'dashboard',
      isWindowFocused: true,
      isRemoveMutationRunning: true,
      repoCount: 17,
    }),
    DASHBOARD_REFRESH_ACTION.none
  )
})

test('switching back to dashboard does not trigger refresh work', () => {
  assert.equal(
    getDashboardNavigationRefreshAction({
      fromPage: 'settings',
      toPage: 'dashboard',
    }),
    DASHBOARD_REFRESH_ACTION.none
  )
})

test('remote refresh is only triggered by startup, explicit button, or configured interval', () => {
  assert.equal(getRemoteRefreshAction('startup'), DASHBOARD_REFRESH_ACTION.remoteFetch)
  assert.equal(getRemoteRefreshAction('button'), DASHBOARD_REFRESH_ACTION.remoteFetch)
  assert.equal(getRemoteRefreshAction('settingsInterval'), DASHBOARD_REFRESH_ACTION.remoteFetch)
  assert.equal(getRemoteRefreshAction('dashboardNavigation'), DASHBOARD_REFRESH_ACTION.none)
  assert.equal(getRemoteRefreshAction('foreground'), DASHBOARD_REFRESH_ACTION.none)
  assert.equal(getRemoteRefreshAction('dashboardInterval'), DASHBOARD_REFRESH_ACTION.none)
})

test('sync completion refreshes completed repo status even while app is backgrounded', () => {
  assert.equal(
    getSyncCompletionRefreshAction({ isWindowFocused: true }),
    DASHBOARD_REFRESH_ACTION.repoListAndLocalStatuses
  )
  assert.equal(
    getSyncCompletionRefreshAction({ isWindowFocused: false }),
    DASHBOARD_REFRESH_ACTION.completedRepoStatus
  )
})

test('hidden window pending refresh distinguishes ordinary hide from active background sync', () => {
  assert.deepEqual(
    getPendingFocusRefreshReasonsAfterHidden([], { hasActiveSync: false }),
    [FOCUS_REFRESH_REASON.windowHidden]
  )
  assert.deepEqual(
    getPendingFocusRefreshReasonsAfterHidden([], { hasActiveSync: true }),
    [FOCUS_REFRESH_REASON.backgroundSync]
  )
})

test('background sync start consumes ordinary hidden refresh but preserves remote refresh', () => {
  assert.deepEqual(
    getPendingFocusRefreshReasonsAfterBackgroundSyncStart([
      FOCUS_REFRESH_REASON.windowHidden,
      FOCUS_REFRESH_REASON.remoteRefresh,
    ]),
    [
      FOCUS_REFRESH_REASON.remoteRefresh,
      FOCUS_REFRESH_REASON.backgroundSync,
    ]
  )
})

test('background sync completion clears only the sync completion reason', () => {
  assert.deepEqual(
    getPendingFocusRefreshReasonsAfterBackgroundSyncCompletion([
      FOCUS_REFRESH_REASON.backgroundSync,
    ]),
    []
  )
  assert.deepEqual(
    getPendingFocusRefreshReasonsAfterBackgroundSyncCompletion([
      FOCUS_REFRESH_REASON.remoteRefresh,
      FOCUS_REFRESH_REASON.backgroundSync,
    ]),
    [FOCUS_REFRESH_REASON.remoteRefresh]
  )
  assert.deepEqual(
    getPendingFocusRefreshReasonsAfterBackgroundSyncCompletion([
      FOCUS_REFRESH_REASON.backgroundSync,
    ], { hasRemainingBackgroundSync: true }),
    [FOCUS_REFRESH_REASON.backgroundSync]
  )
})

test('pending focus refresh reason helper handles empty and populated sets', () => {
  assert.equal(hasPendingFocusRefreshReasons([]), false)
  assert.equal(hasPendingFocusRefreshReasons(new Set()), false)
  assert.equal(
    hasPendingFocusRefreshReasons(new Set([FOCUS_REFRESH_REASON.remoteRefresh])),
    true
  )
})
