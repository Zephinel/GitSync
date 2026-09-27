import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DASHBOARD_EMPTY_PROJECTION_KIND,
  getDashboardEmptyProjection,
} from './dashboardEmptyProjection.js'
import { DASHBOARD_REPO_FILTER_MODE } from './repoStatusUtils.js'

test('empty all projection appears only after the initial dashboard load', () => {
  assert.deepEqual(
    getDashboardEmptyProjection({
      isAppReady: true,
      resultCount: 0,
      filterMode: DASHBOARD_REPO_FILTER_MODE.all,
    }),
    {
      kind: DASHBOARD_EMPTY_PROJECTION_KIND.filter,
      filterMode: DASHBOARD_REPO_FILTER_MODE.all,
    }
  )
})

test('empty filter projection uses the active filter even when the global repo list is non-empty', () => {
  for (const filterMode of [
    DASHBOARD_REPO_FILTER_MODE.synced,
    DASHBOARD_REPO_FILTER_MODE.newChanges,
    DASHBOARD_REPO_FILTER_MODE.localChanges,
    DASHBOARD_REPO_FILTER_MODE.newAndLocalChanges,
  ]) {
    assert.deepEqual(
      getDashboardEmptyProjection({
        isAppReady: true,
        resultCount: 0,
        filterMode,
      }),
      {
        kind: DASHBOARD_EMPTY_PROJECTION_KIND.filter,
        filterMode,
      }
    )
  }
})

test('search empty projection takes precedence over filter illustration', () => {
  assert.deepEqual(
    getDashboardEmptyProjection({
      isAppReady: true,
      hasSearchKeyword: true,
      resultCount: 0,
      filterMode: DASHBOARD_REPO_FILTER_MODE.synced,
    }),
    {
      kind: DASHBOARD_EMPTY_PROJECTION_KIND.search,
      filterMode: null,
    }
  )
})

test('a non-empty projection renders neither empty state', () => {
  assert.deepEqual(
    getDashboardEmptyProjection({
      isAppReady: true,
      hasSearchKeyword: true,
      resultCount: 1,
      filterMode: DASHBOARD_REPO_FILTER_MODE.all,
    }),
    {
      kind: DASHBOARD_EMPTY_PROJECTION_KIND.none,
      filterMode: null,
    }
  )
})

test('startup and loading projections do not flash an empty state', () => {
  assert.equal(
    getDashboardEmptyProjection({ resultCount: 0 }).kind,
    DASHBOARD_EMPTY_PROJECTION_KIND.none
  )
  assert.equal(
    getDashboardEmptyProjection({ isAppReady: true, isLoading: true, resultCount: 0 }).kind,
    DASHBOARD_EMPTY_PROJECTION_KIND.none
  )
})
