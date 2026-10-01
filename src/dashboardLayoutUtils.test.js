import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildDashboardColumns,
  buildDashboardRows,
  flattenDashboardRows,
  normalizeDashboardLayout,
  readDashboardColumnsInVisualOrder,
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
  const columns = buildDashboardColumns(repos, 'list', 3)
  assert.deepEqual(columns, [['one'], ['two'], ['three']])
  assert.deepEqual(flattenDashboardRows(columns), repos)
})

test('card-layout projection dispatches into equal columns so every card keeps its own height', () => {
  const repos = ['one', 'two', 'three', 'four', 'five']
  const columns = buildDashboardColumns(repos, 'masonry', 2)
  assert.deepEqual(columns, [['one', 'three', 'five'], ['two', 'four']])
  // 保序分发：视觉阅读顺序（先左到右、再上到下）与排序顺序完全一致。
  assert.deepEqual(readDashboardColumnsInVisualOrder(columns), repos)
})

test('card-layout projection never produces a row-shaped container', () => {
  // 行形态要求每行一个 grid，而 grid 会把同行卡片拉成同高，瀑布流就退化成
  // 等高网格了。这里守住「投影结果一定是列、且列数等于列数」这条不变式。
  const columns = buildDashboardColumns(['a', 'b', 'c', 'd'], 'masonry', 3)
  assert.equal(columns.length, 3)
  assert.deepEqual(columns, [['a', 'd'], ['b'], ['c']])
  assert.deepEqual(readDashboardColumnsInVisualOrder(columns), ['a', 'b', 'c', 'd'])
})

test('card-layout wiring renders column containers and a flex column grid', () => {
  const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const cssSource = readFileSync(new URL('./App.css', import.meta.url), 'utf8')

  assert.match(appSource, /buildDashboardColumns\(group\.repos, dashboardLayout, repoGridColumns\)/)
  assert.match(appSource, /className="repo-grid__column"/)
  assert.doesNotMatch(appSource, /className="repo-grid__row"/)

  // 列容器：外层 flex row + 等宽列；列内部 flex column 让每张卡片自己决定高度。
  assert.match(cssSource, /\.repo-grid--masonry \{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*flex-start;/)
  assert.match(cssSource, /\.repo-grid__column \{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/)
  assert.match(cssSource, /\.repo-grid--masonry \.repo-grid__column \{[\s\S]*?flex:\s*1 1 0;/)
  // 回归护栏：不能再出现把卡片拉齐的等宽行 grid。
  assert.doesNotMatch(cssSource, /\.repo-grid__row/)
})

test('dashboard projection handles invalid and empty input without mutation', () => {
  const repos = ['one', 'two', 'three']
  // 列数非法时收敛到 1 列，而不是产出「每行一个」的行形态。
  const columns = buildDashboardRows(repos, 'masonry', 0)
  assert.deepEqual(columns, [['one', 'two', 'three']])
  assert.deepEqual(repos, ['one', 'two', 'three'])
  assert.deepEqual(buildDashboardRows(null, 'masonry', 2), [])
  assert.deepEqual(buildDashboardColumns(undefined, 'masonry', 2), [])
})
