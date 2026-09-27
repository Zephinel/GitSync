import {
  DEFAULT_DASHBOARD_REPO_SORT_MODE,
  DASHBOARD_REPO_FILTER_MODE,
  normalizeDashboardRepoFilterMode,
  normalizeDashboardRepoSortMode,
} from './repoStatusUtils.js'

export const DASHBOARD_REPO_FILTER_STORAGE_KEY = 'gitsync-dashboard-repo-filter'
export const DASHBOARD_REPO_SORT_STORAGE_KEY = 'gitsync-dashboard-repo-sort'

export function readDashboardRepoFilter(storage) {
  try {
    const target = storage === undefined ? globalThis?.localStorage : storage
    return normalizeDashboardRepoFilterMode(
      target?.getItem?.(DASHBOARD_REPO_FILTER_STORAGE_KEY)
    )
  } catch {
    return DASHBOARD_REPO_FILTER_MODE.all
  }
}

export function writeDashboardRepoFilter(value, storage) {
  const filter = normalizeDashboardRepoFilterMode(value)
  try {
    const target = storage === undefined ? globalThis?.localStorage : storage
    target?.setItem?.(DASHBOARD_REPO_FILTER_STORAGE_KEY, filter)
  } catch {
    // Keep the current UI state even when persistent storage is unavailable.
  }
  return filter
}

export function readDashboardRepoSortMode(storage) {
  try {
    const target = storage === undefined ? globalThis?.localStorage : storage
    return normalizeDashboardRepoSortMode(
      target?.getItem?.(DASHBOARD_REPO_SORT_STORAGE_KEY)
    ) || DEFAULT_DASHBOARD_REPO_SORT_MODE
  } catch {
    return DEFAULT_DASHBOARD_REPO_SORT_MODE
  }
}

export function writeDashboardRepoSortMode(value, storage) {
  const sortMode = normalizeDashboardRepoSortMode(value) || DEFAULT_DASHBOARD_REPO_SORT_MODE
  try {
    const target = storage === undefined ? globalThis?.localStorage : storage
    target?.setItem?.(DASHBOARD_REPO_SORT_STORAGE_KEY, sortMode)
  } catch {
    // Keep the current UI state even when persistent storage is unavailable.
  }
  return sortMode
}
