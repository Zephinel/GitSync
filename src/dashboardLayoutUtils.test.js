import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildDashboardRows,
  flattenDashboardRows,
  normalizeDashboardLayout,
} from './dashboardLayoutUtils.js'

test('legacy masonry preference still loads as the user-facing card layout', () => {
  assert.equal(normalizeDashboardLayout('masonry'), 'masonry')
  assert.equal(normalizeDashboardLayout('list'), 'list')
  assert.equal(normalizeDashboardLayout('unknown'), 'masonry')

  const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  assert.match(appSource, /data-app-tooltip="卡片布局"/)
  assert.match(appSource, /aria-label="卡片布局"/)
  assert.doesNotMatch(appSource, /瀑布流布局/)
})

test('list projection preserves the sorted repository order', () => {
  const repos = ['one', 'two', 'three']
  const rows = buildDashboardRows(repos, 'list', 3)
  assert.deepEqual(rows, [['one'], ['two'], ['three']])
  assert.deepEqual(flattenDashboardRows(rows), repos)
})

test('card-layout projection uses row-major rows so visual reading order matches sort order', () => {
  const repos = ['one', 'two', 'three', 'four', 'five']
  const rows = buildDashboardRows(repos, 'masonry', 2)
  assert.deepEqual(rows, [['one', 'two'], ['three', 'four'], ['five']])
  assert.deepEqual(flattenDashboardRows(rows), repos)
})

test('dashboard row projection handles invalid and empty input without mutation', () => {
  const repos = ['one', 'two', 'three']
  const rows = buildDashboardRows(repos, 'masonry', 0)
  assert.deepEqual(rows, [['one'], ['two'], ['three']])
  assert.deepEqual(repos, ['one', 'two', 'three'])
  assert.deepEqual(buildDashboardRows(null, 'masonry', 2), [])
})
