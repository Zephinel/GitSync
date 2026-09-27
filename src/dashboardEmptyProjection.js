export const DASHBOARD_EMPTY_PROJECTION_KIND = Object.freeze({
  none: 'none',
  search: 'search',
  filter: 'filter',
})

export function getDashboardEmptyProjection({
  isAppReady = false,
  isLoading = false,
  hasSearchKeyword = false,
  resultCount = 0,
  filterMode = null,
} = {}) {
  if (!isAppReady || isLoading || Number(resultCount) > 0) {
    return {
      kind: DASHBOARD_EMPTY_PROJECTION_KIND.none,
      filterMode: null,
    }
  }

  if (hasSearchKeyword) {
    return {
      kind: DASHBOARD_EMPTY_PROJECTION_KIND.search,
      filterMode: null,
    }
  }

  return {
    kind: DASHBOARD_EMPTY_PROJECTION_KIND.filter,
    filterMode,
  }
}
