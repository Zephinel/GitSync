export const DASHBOARD_REFRESH_ACTION = {
  none: 'none',
  repoList: 'repoList',
  localStatuses: 'localStatuses',
  repoListAndLocalStatuses: 'repoListAndLocalStatuses',
  completedRepoStatus: 'completedRepoStatus',
  remoteFetch: 'remoteFetch',
}

export const FOCUS_REFRESH_REASON = {
  windowHidden: 'windowHidden',
  remoteRefresh: 'remoteRefresh',
  backgroundSync: 'backgroundSync',
}

function normalizePendingFocusRefreshReasons(reasons) {
  if (!reasons) return new Set()
  if (reasons instanceof Set) return new Set(Array.from(reasons).filter(Boolean))
  if (Array.isArray(reasons)) return new Set(reasons.filter(Boolean))
  if (typeof reasons === 'string') return new Set([reasons])
  return new Set()
}

export function getForegroundRefreshAction({ repoCount = 0 } = {}) {
  return repoCount > 0
    ? DASHBOARD_REFRESH_ACTION.repoListAndLocalStatuses
    : DASHBOARD_REFRESH_ACTION.repoList
}

export function getDashboardIntervalRefreshAction({
  page,
  isWindowFocused,
  isRemoveMutationRunning,
  repoCount = 0,
} = {}) {
  if (page !== 'dashboard') return DASHBOARD_REFRESH_ACTION.none
  if (!isWindowFocused || isRemoveMutationRunning) return DASHBOARD_REFRESH_ACTION.none
  return repoCount > 0 ? DASHBOARD_REFRESH_ACTION.localStatuses : DASHBOARD_REFRESH_ACTION.repoList
}

export function getDashboardNavigationRefreshAction({ fromPage, toPage } = {}) {
  if (fromPage !== 'dashboard' && toPage === 'dashboard') {
    return DASHBOARD_REFRESH_ACTION.none
  }
  return DASHBOARD_REFRESH_ACTION.none
}

export function getRemoteRefreshAction(trigger) {
  return trigger === 'startup' || trigger === 'button' || trigger === 'settingsInterval'
    ? DASHBOARD_REFRESH_ACTION.remoteFetch
    : DASHBOARD_REFRESH_ACTION.none
}

export function getSyncCompletionRefreshAction({ isWindowFocused } = {}) {
  return isWindowFocused
    ? DASHBOARD_REFRESH_ACTION.repoListAndLocalStatuses
    : DASHBOARD_REFRESH_ACTION.completedRepoStatus
}

export function hasPendingFocusRefreshReasons(reasons) {
  return normalizePendingFocusRefreshReasons(reasons).size > 0
}

export function getPendingFocusRefreshReasonsAfterHidden(
  reasons,
  { hasActiveSync = false } = {}
) {
  const next = normalizePendingFocusRefreshReasons(reasons)
  next.add(hasActiveSync
    ? FOCUS_REFRESH_REASON.backgroundSync
    : FOCUS_REFRESH_REASON.windowHidden)
  return Array.from(next)
}

export function getPendingFocusRefreshReasonsAfterBackgroundSyncStart(reasons) {
  const next = normalizePendingFocusRefreshReasons(reasons)
  next.delete(FOCUS_REFRESH_REASON.windowHidden)
  next.add(FOCUS_REFRESH_REASON.backgroundSync)
  return Array.from(next)
}

export function getPendingFocusRefreshReasonsAfterBackgroundSyncCompletion(
  reasons,
  { hasRemainingBackgroundSync = false } = {}
) {
  const next = normalizePendingFocusRefreshReasons(reasons)
  if (!hasRemainingBackgroundSync) {
    next.delete(FOCUS_REFRESH_REASON.backgroundSync)
  }
  return Array.from(next)
}
