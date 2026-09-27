import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DASHBOARD_REPO_FILTER_STORAGE_KEY,
  DASHBOARD_REPO_SORT_STORAGE_KEY,
  readDashboardRepoFilter,
  readDashboardRepoSortMode,
  writeDashboardRepoFilter,
  writeDashboardRepoSortMode,
} from './dashboardPreferences.js'
import {
  DEFAULT_DASHBOARD_REPO_SORT_MODE,
  DASHBOARD_REPO_FILTER_MODE,
  DASHBOARD_REPO_SORT_MODE,
} from './repoStatusUtils.js'

function createStorage(initialValues = {}) {
  const values = new Map(Object.entries(initialValues))
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
  }
}

test('dashboard filter and sort preferences use their defaults when unset', () => {
  const storage = createStorage()
  assert.equal(readDashboardRepoFilter(storage), DASHBOARD_REPO_FILTER_MODE.all)
  assert.equal(readDashboardRepoSortMode(storage), DEFAULT_DASHBOARD_REPO_SORT_MODE)
})

test('dashboard filter and sort preferences persist and restore selected values', () => {
  const storage = createStorage()
  const filter = DASHBOARD_REPO_FILTER_MODE.localChanges
  const sortMode = DASHBOARD_REPO_SORT_MODE.nameAsc

  assert.equal(writeDashboardRepoFilter(filter, storage), filter)
  assert.equal(writeDashboardRepoSortMode(sortMode, storage), sortMode)
  assert.equal(storage.getItem(DASHBOARD_REPO_FILTER_STORAGE_KEY), filter)
  assert.equal(storage.getItem(DASHBOARD_REPO_SORT_STORAGE_KEY), sortMode)
  assert.equal(readDashboardRepoFilter(storage), filter)
  assert.equal(readDashboardRepoSortMode(storage), sortMode)
})

test('invalid stored dashboard preferences fall back to defaults', () => {
  const storage = createStorage({
    [DASHBOARD_REPO_FILTER_STORAGE_KEY]: 'unknown-filter',
    [DASHBOARD_REPO_SORT_STORAGE_KEY]: 'unknown-sort',
  })
  assert.equal(readDashboardRepoFilter(storage), DASHBOARD_REPO_FILTER_MODE.all)
  assert.equal(readDashboardRepoSortMode(storage), DEFAULT_DASHBOARD_REPO_SORT_MODE)
})

test('dashboard preferences remain usable when storage throws', () => {
  const brokenStorage = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
  }
  assert.equal(readDashboardRepoFilter(brokenStorage), DASHBOARD_REPO_FILTER_MODE.all)
  assert.equal(readDashboardRepoSortMode(brokenStorage), DEFAULT_DASHBOARD_REPO_SORT_MODE)
  assert.equal(writeDashboardRepoFilter(DASHBOARD_REPO_FILTER_MODE.synced, brokenStorage), DASHBOARD_REPO_FILTER_MODE.synced)
  assert.equal(writeDashboardRepoSortMode(DASHBOARD_REPO_SORT_MODE.nameDesc, brokenStorage), DASHBOARD_REPO_SORT_MODE.nameDesc)
})
