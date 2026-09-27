import test from 'node:test'
import assert from 'node:assert/strict'
import {
  areAllVisibleReposSelected,
  getDashboardVisibleRepoIds,
  getHiddenSelectedRepoIds,
  getVisibleSelectedRepoIds,
  toggleVisibleRepoSelection,
} from './dashboardSelectionUtils.js'

const repos = [
  { id: 'a' },
  { id: 'b' },
  { id: 'c' },
  { id: 'd' },
  { id: 'e' },
]

test('select all adds only currently visible repositories', () => {
  const visibleRepoIds = getDashboardVisibleRepoIds(repos.slice(0, 2))

  assert.deepEqual(toggleVisibleRepoSelection([], visibleRepoIds), ['a', 'b'])
})

test('select all preserves selections hidden by the current filter', () => {
  const visibleRepoIds = getDashboardVisibleRepoIds(repos.slice(0, 2))

  assert.deepEqual(toggleVisibleRepoSelection(['c'], visibleRepoIds), ['c', 'a', 'b'])
})

test('cancel select all removes only visible selections', () => {
  const visibleRepoIds = getDashboardVisibleRepoIds(repos.slice(0, 2))

  assert.deepEqual(toggleVisibleRepoSelection(['c', 'a', 'b'], visibleRepoIds), ['c'])
})

test('destructive action scope contains visible selected repositories only', () => {
  const visibleRepoIds = getDashboardVisibleRepoIds(repos.slice(0, 2))
  const selectedRepoIds = ['a', 'b', 'c']

  assert.deepEqual(getVisibleSelectedRepoIds(selectedRepoIds, visibleRepoIds), ['a', 'b'])
  assert.deepEqual(getHiddenSelectedRepoIds(selectedRepoIds, visibleRepoIds, repos), ['c'])
})

test('selection survives filter changes while visible count and all-selected state follow the new scope', () => {
  const selectedRepoIds = ['a', 'b']
  const firstVisibleRepoIds = getDashboardVisibleRepoIds(repos.slice(0, 2))
  const secondVisibleRepoIds = getDashboardVisibleRepoIds(repos.slice(2, 4))

  assert.deepEqual(getVisibleSelectedRepoIds(selectedRepoIds, firstVisibleRepoIds), ['a', 'b'])
  assert.equal(areAllVisibleReposSelected(selectedRepoIds, firstVisibleRepoIds), true)
  assert.deepEqual(getVisibleSelectedRepoIds(selectedRepoIds, secondVisibleRepoIds), [])
  assert.equal(areAllVisibleReposSelected(selectedRepoIds, secondVisibleRepoIds), false)
  assert.deepEqual(selectedRepoIds, ['a', 'b'])
})
