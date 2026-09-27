import { parseGitCommitDateToMs } from './gitDateUtils.js'

export const REPO_DASHBOARD_GROUP_KEY = {
  changed: 'changed',
  stale: 'stale',
  clean: 'clean',
}

export const DASHBOARD_REPO_SORT_MODE = Object.freeze({
  nameAsc: 'name-asc',
  nameDesc: 'name-desc',
  commitAsc: 'commit-asc',
  commitDesc: 'commit-desc',
  syncAsc: 'sync-asc',
  syncDesc: 'sync-desc',
})

export const DASHBOARD_REPO_FILTER_MODE = Object.freeze({
  all: 'all',
  synced: 'synced',
  newChanges: 'new-changes',
  localChanges: 'local-changes',
  newAndLocalChanges: 'new-and-local-changes',
})

export const DEFAULT_DASHBOARD_REPO_SORT_MODE = DASHBOARD_REPO_SORT_MODE.syncDesc

const DASHBOARD_REPO_SORT_MODE_VALUES = new Set(Object.values(DASHBOARD_REPO_SORT_MODE))
const DASHBOARD_REPO_FILTER_MODE_VALUES = new Set(Object.values(DASHBOARD_REPO_FILTER_MODE))

export function normalizeDashboardRepoSortMode(value) {
  return DASHBOARD_REPO_SORT_MODE_VALUES.has(value) ? value : null
}

export function normalizeDashboardRepoFilterMode(value) {
  return DASHBOARD_REPO_FILTER_MODE_VALUES.has(value)
    ? value
    : DASHBOARD_REPO_FILTER_MODE.all
}

const SYNC_HISTORY_STORAGE_KEY = 'gitsync-sync-history'
const EMPTY_SUCCESSFUL_SYNC_TIMES = Object.freeze({})
let cachedSyncHistoryRaw = null
let cachedSuccessfulSyncTimesByRepoId = EMPTY_SUCCESSFUL_SYNC_TIMES

export function normalizeRepoTimestampToMs(value) {
  const timestamp = Number.parseInt(value, 10)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0
  return timestamp >= 1000000000000 ? timestamp : timestamp * 1000
}

export function normalizeRepoSyncTimestampToMs(value) {
  return normalizeRepoTimestampToMs(value)
}

export function buildSuccessfulSyncTimesByRepoId(entries) {
  const successfulSyncTimesByRepoId = {}
  const historyEntries = Array.isArray(entries) ? entries : []

  historyEntries.forEach((entry) => {
    if (String(entry?.result || '').trim() !== 'success') return
    const repoId = String(entry?.repoId || entry?.repo_id || '').trim()
    const finishedAt = normalizeRepoSyncTimestampToMs(entry?.finishedAt ?? entry?.finished_at)
    if (!repoId || !finishedAt) return
    successfulSyncTimesByRepoId[repoId] = Math.max(
      successfulSyncTimesByRepoId[repoId] || 0,
      finishedAt
    )
  })

  return successfulSyncTimesByRepoId
}

function readStoredSuccessfulSyncTimesByRepoId() {
  let storage
  try {
    storage = globalThis?.localStorage
  } catch {
    return EMPTY_SUCCESSFUL_SYNC_TIMES
  }
  if (!storage || typeof storage.getItem !== 'function') return EMPTY_SUCCESSFUL_SYNC_TIMES

  let rawHistory
  try {
    rawHistory = storage.getItem(SYNC_HISTORY_STORAGE_KEY)
  } catch {
    return EMPTY_SUCCESSFUL_SYNC_TIMES
  }
  if (rawHistory === cachedSyncHistoryRaw) return cachedSuccessfulSyncTimesByRepoId

  cachedSyncHistoryRaw = rawHistory
  if (!rawHistory) {
    cachedSuccessfulSyncTimesByRepoId = EMPTY_SUCCESSFUL_SYNC_TIMES
    return cachedSuccessfulSyncTimesByRepoId
  }

  try {
    cachedSuccessfulSyncTimesByRepoId = buildSuccessfulSyncTimesByRepoId(JSON.parse(rawHistory))
  } catch {
    cachedSuccessfulSyncTimesByRepoId = EMPTY_SUCCESSFUL_SYNC_TIMES
  }
  return cachedSuccessfulSyncTimesByRepoId
}

function getSuccessfulSyncTimeForRepo(repo, successfulSyncTimesByRepoId) {
  const repoId = String(repo?.id || '').trim()
  if (!repoId || !successfulSyncTimesByRepoId) return 0
  if (successfulSyncTimesByRepoId instanceof Map) {
    return normalizeRepoSyncTimestampToMs(successfulSyncTimesByRepoId.get(repoId))
  }
  return normalizeRepoSyncTimestampToMs(successfulSyncTimesByRepoId[repoId])
}

function getRepoStatusForSort(repo, repoStatuses) {
  const repoId = String(repo?.id || '').trim()
  if (!repoId || !repoStatuses) return null
  if (repoStatuses instanceof Map) return repoStatuses.get(repoId) || null
  return repoStatuses[repoId] || null
}

function getRepoLatestCommitTimestamp(repo, repoStatuses) {
  const status = getRepoStatusForSort(repo, repoStatuses)
  const commitDate = status?.last_commit?.date || repo?.last_commit?.date
  return parseGitCommitDateToMs(commitDate)
}

export function getRepoSyncSortTimestamp(
  repo,
  successfulSyncTimesByRepoId = null
) {
  const storedSyncTime = normalizeRepoSyncTimestampToMs(repo?.last_sync_at)
  const recentSuccessfulSyncTime = getSuccessfulSyncTimeForRepo(
    repo,
    successfulSyncTimesByRepoId || readStoredSuccessfulSyncTimesByRepoId()
  )
  return Math.max(storedSyncTime, recentSuccessfulSyncTime)
}

const REPO_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function compareReposByName(a, b) {
  const nameComparison = REPO_NAME_COLLATOR.compare(
    String(a?.name || '').trim(),
    String(b?.name || '').trim()
  )
  if (nameComparison !== 0) return nameComparison
  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

function compareDashboardTimestamps(a, b, direction) {
  const hasA = Number.isFinite(a) && a > 0
  const hasB = Number.isFinite(b) && b > 0
  if (!hasA && !hasB) return 0
  if (!hasA) return 1
  if (!hasB) return -1
  if (a === b) return 0
  return direction === 'asc' ? a - b : b - a
}

export function compareReposByDashboardSortOrder(
  a,
  b,
  sortMode,
  successfulSyncTimesByRepoId = null,
  repoStatuses = null
) {
  const normalizedSortMode = normalizeDashboardRepoSortMode(sortMode)
  if (!normalizedSortMode) return 0

  if (
    normalizedSortMode === DASHBOARD_REPO_SORT_MODE.nameAsc
    || normalizedSortMode === DASHBOARD_REPO_SORT_MODE.nameDesc
  ) {
    const nameComparison = compareReposByName(a, b)
    return normalizedSortMode === DASHBOARD_REPO_SORT_MODE.nameDesc
      ? nameComparison * -1
      : nameComparison
  }

  const isCommitSort = normalizedSortMode === DASHBOARD_REPO_SORT_MODE.commitAsc
    || normalizedSortMode === DASHBOARD_REPO_SORT_MODE.commitDesc
  const direction = normalizedSortMode.endsWith('-asc') ? 'asc' : 'desc'
  const timestampA = isCommitSort
    ? getRepoLatestCommitTimestamp(a, repoStatuses)
    : getRepoSyncSortTimestamp(a, successfulSyncTimesByRepoId)
  const timestampB = isCommitSort
    ? getRepoLatestCommitTimestamp(b, repoStatuses)
    : getRepoSyncSortTimestamp(b, successfulSyncTimesByRepoId)
  const timestampComparison = compareDashboardTimestamps(timestampA, timestampB, direction)
  return timestampComparison !== 0 ? timestampComparison : compareReposByName(a, b)
}

export function getRepoCleanSortTimestamp(
  repo,
  successfulSyncTimesByRepoId = null,
  repoStatuses = null
) {
  return getRepoLatestCommitTimestamp(repo, repoStatuses)
    || getRepoSyncSortTimestamp(repo, successfulSyncTimesByRepoId)
}

export function compareReposByCleanSortOrder(
  a,
  b,
  successfulSyncTimesByRepoId = null,
  repoStatuses = null
) {
  const timeA = getRepoCleanSortTimestamp(a, successfulSyncTimesByRepoId, repoStatuses)
  const timeB = getRepoCleanSortTimestamp(b, successfulSyncTimesByRepoId, repoStatuses)
  if (timeA !== timeB) return timeB - timeA

  const createdA = normalizeRepoTimestampToMs(a?.created_at)
  const createdB = normalizeRepoTimestampToMs(b?.created_at)
  return createdB - createdA
}

// Dashboard grouping reflects only the current branch and working tree.
// Non-current branch state is surfaced on demand in the branch overview.
export function hasRepoPendingChanges(repoStatus) {
  if (!repoStatus || typeof repoStatus !== 'object') return false

  const modifiedCount = Array.isArray(repoStatus.modified) ? repoStatus.modified.length : 0
  const conflictedCount = Array.isArray(repoStatus.conflicted) ? repoStatus.conflicted.length : 0
  const ahead = Number(repoStatus.ahead) || 0
  const behind = Number(repoStatus.behind) || 0
  const needsUpstreamPublish = repoStatus.needs_upstream_publish === true

  return modifiedCount > 0
    || conflictedCount > 0
    || ahead > 0
    || behind > 0
    || needsUpstreamPublish
}

export function hasRepoStatusIssue(repoStatusIssue) {
  if (!repoStatusIssue || typeof repoStatusIssue !== 'object') return false
  return Boolean(repoStatusIssue.remoteFetch || repoStatusIssue.statusRefresh || repoStatusIssue.message)
}

export function isRepoInFailedState(repo) {
  if (!repo || repo.status === 'paused') return false
  return repo.status === 'error' || Boolean(repo.last_error) || (repo.error_logs?.length || 0) > 0
}

export function createRepoStatusIssue(kind, detail, updatedAt = Date.now()) {
  if (kind === 'remoteFetch') {
    return {
      kind,
      message: '远程更新获取失败，当前状态可能不是最新。',
      detail: detail || '未知错误',
      updatedAt,
    }
  }
  return {
    kind: 'statusRefresh',
    message: '仓库状态刷新失败，当前分组可能不是最新。',
    detail: detail || '未知错误',
    updatedAt,
  }
}

export function getPrimaryRepoStatusIssue(repoStatusIssue) {
  if (!hasRepoStatusIssue(repoStatusIssue)) return null
  return repoStatusIssue.remoteFetch || repoStatusIssue.statusRefresh || repoStatusIssue
}

export function formatRelativeTimeFromMs(timestampMs, nowMs = Date.now()) {
  const timestamp = Number(timestampMs)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const diffMs = Math.max(0, nowMs - timestamp)
  const diffSeconds = Math.floor(diffMs / 1000)
  if (diffSeconds < 60) return '刚刚'
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)} 小时前`
  return `${Math.floor(diffSeconds / 86400)} 天前`
}

export function getRepoStatusIssueDisplay(repoStatusIssue, nowMs = Date.now()) {
  const issue = getPrimaryRepoStatusIssue(repoStatusIssue)
  if (!issue) {
    return {
      message: '',
      detail: '',
      relativeTime: '',
    }
  }
  return {
    message: issue.message || '',
    detail: issue.detail || issue.message || '',
    relativeTime: formatRelativeTimeFromMs(issue.updatedAt, nowMs),
  }
}

export function buildRefreshFailureNoticeMessage(failures, previewLimit = 5) {
  const failureList = Array.isArray(failures) ? failures : []
  if (failureList.length === 0) return ''
  const preview = failureList
    .slice(0, previewLimit)
    .map((item) => `- ${item.name}: ${item.message}`)
    .join('\n')
  const moreCount = Math.max(0, failureList.length - previewLimit)
  const moreText = moreCount > 0 ? `\n\n还有 ${moreCount} 个仓库获取失败。` : ''
  return `以下仓库获取远程更新失败，当前状态可能不是最新：\n\n${preview}${moreText}`
}

export function isRepoSyncInProgress(repoRuntimeStatus, queueState) {
  return repoRuntimeStatus === 'syncing' || queueState === 'running' || queueState === 'queued'
}

export function hasRepoLocalUncommittedChanges(repoStatus) {
  if (!repoStatus || typeof repoStatus !== 'object') return false
  return (Array.isArray(repoStatus.modified) && repoStatus.modified.length > 0)
    || (Array.isArray(repoStatus.conflicted) && repoStatus.conflicted.length > 0)
}

export function hasRepoNewChanges(repoStatus) {
  if (!repoStatus || typeof repoStatus !== 'object') return false
  return (Number(repoStatus.ahead) || 0) > 0
    || (Number(repoStatus.behind) || 0) > 0
    || repoStatus.needs_upstream_publish === true
}

export function hasRepoDashboardFailure(repo, repoStatus, repoStatusIssue) {
  return !repo
    || isRepoInFailedState(repo)
    || hasRepoStatusIssue(repoStatusIssue)
    || !repoStatus
    || repoStatus.status_timed_out === true
    || repoStatus.comparison_state === 'error'
    || repoStatus.comparison_state === 'detached'
    || repoStatus.detached_head === true
}

export function getDashboardRepoFilterCategory(
  repo,
  repoStatus,
  queueState,
  repoStatusIssue
) {
  const isActive = isRepoSyncInProgress(repo?.status, queueState)
  if (!isActive && hasRepoDashboardFailure(repo, repoStatus, repoStatusIssue)) return null

  const hasNew = isActive || hasRepoNewChanges(repoStatus)
  const hasLocal = hasRepoLocalUncommittedChanges(repoStatus)
  if (hasNew && hasLocal) return DASHBOARD_REPO_FILTER_MODE.newAndLocalChanges
  if (hasNew) return DASHBOARD_REPO_FILTER_MODE.newChanges
  if (hasLocal) return DASHBOARD_REPO_FILTER_MODE.localChanges

  const hasPositiveSyncedProof = repo.status === 'idle'
    && repoStatus.is_clean === true
    && repoStatus.comparison_state === 'ok'
    && repoStatus.status_timed_out !== true
    && !hasRepoNewChanges(repoStatus)
    && !hasRepoLocalUncommittedChanges(repoStatus)
  return hasPositiveSyncedProof ? DASHBOARD_REPO_FILTER_MODE.synced : null
}

export function matchesDashboardRepoFilter(
  repo,
  repoStatus,
  queueState,
  repoStatusIssue,
  filterMode
) {
  const normalizedFilter = normalizeDashboardRepoFilterMode(filterMode)
  if (normalizedFilter === DASHBOARD_REPO_FILTER_MODE.all) return true
  const category = getDashboardRepoFilterCategory(
    repo,
    repoStatus,
    queueState,
    repoStatusIssue
  )

  // "有新改动 + 本地有未提交改动" is the union of the two change conditions: the repo
  // qualifies when it has remote new changes, local uncommitted changes, or both.
  // The two single-condition filters stay exact, so they remain distinguishable
  // ("有新改动" alone still means remote changes only), and a repo that cannot be
  // classified at all (failure / stale / detached) stays out of every filter.
  if (normalizedFilter === DASHBOARD_REPO_FILTER_MODE.newAndLocalChanges) {
    return category === DASHBOARD_REPO_FILTER_MODE.newChanges
      || category === DASHBOARD_REPO_FILTER_MODE.localChanges
      || category === DASHBOARD_REPO_FILTER_MODE.newAndLocalChanges
  }

  return category === normalizedFilter
}

export function shouldGroupRepoAsChanged(
  repoRuntimeStatus,
  repoStatus,
  queueState,
  groupingHint = null
) {
  if (isRepoSyncInProgress(repoRuntimeStatus, queueState)) return true
  if (groupingHint?.keepInChangedGroup === true && hasRepoPendingChanges(repoStatus)) return true
  return hasRepoPendingChanges(repoStatus)
}

export function getRepoDashboardGroupKey(
  repoRuntimeStatus,
  repoStatus,
  queueState,
  repoStatusIssue,
  groupingHint = null
) {
  const isActiveSync = isRepoSyncInProgress(repoRuntimeStatus, queueState)
  if (isActiveSync) return REPO_DASHBOARD_GROUP_KEY.changed
  if (hasRepoStatusIssue(repoStatusIssue)) return REPO_DASHBOARD_GROUP_KEY.stale
  if (shouldGroupRepoAsChanged(repoRuntimeStatus, repoStatus, queueState, groupingHint)) {
    return REPO_DASHBOARD_GROUP_KEY.changed
  }
  return REPO_DASHBOARD_GROUP_KEY.clean
}
