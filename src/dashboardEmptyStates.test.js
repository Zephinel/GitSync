import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const srcDir = fileURLToPath(new URL('.', import.meta.url))
const configSource = readFileSync(new URL('./dashboardEmptyStates.js', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
const appCssSource = readFileSync(new URL('./App.css', import.meta.url), 'utf8')

const EMPTY_STATE_KEYS = [
  'all',
  'synced',
  'new-changes',
  'local-changes',
  'new-and-local-changes',
]

const CONFIG_MODES = [
  'all',
  'synced',
  'newChanges',
  'localChanges',
  'newAndLocalChanges',
]

test('dashboard filter empty state configuration maps every filter to light and dark WebP assets', () => {
  for (const key of EMPTY_STATE_KEYS) {
    const lightAsset = srcDir + 'assets/dashboard-empty-states/light/' + key + '.webp'
    const darkAsset = srcDir + 'assets/dashboard-empty-states/dark/' + key + '.webp'
    assert.equal(existsSync(lightAsset), true, 'missing light asset: ' + key)
    assert.equal(existsSync(darkAsset), true, 'missing dark asset: ' + key)
    assert.ok(statSync(lightAsset).size > 0)
    assert.ok(statSync(darkAsset).size > 0)
  }

  assert.match(configSource, /DASHBOARD_EMPTY_STATE_CONFIG/)
  for (const mode of CONFIG_MODES) {
    assert.match(
      configSource,
      new RegExp('\\[DASHBOARD_REPO_FILTER_MODE\\.' + mode + '\\]:\\s*\\{[\\s\\S]*?lightImage:[\\s\\S]*?darkImage:')
    )
  }
  assert.match(configSource, /\.webp'/)
  assert.doesNotMatch(configSource, /\.png'/)
})

test('filter empty state copy is centralized and search empty state remains separate', () => {
  assert.match(configSource, /title: '还没有导入仓库'/)
  assert.match(configSource, /title: '暂无已同步仓库'/)
  assert.match(configSource, /title: '所有仓库都很干净'/)
  assert.match(configSource, /title: '没有未提交的本地改动'/)
  assert.match(configSource, /title: '没有待处理的改动'/)
  assert.match(appSource, /description: '待拉取、待推送，或本地有未提交内容'/)
  assert.match(appSource, /getDashboardFilterEmptyState/)
  assert.match(appSource, /未找到匹配仓库，请尝试其他关键词。/)
  assert.doesNotMatch(appSource, /DashboardEmptyRepoCard|DashboardEmptyDocumentCard/)
  assert.doesNotMatch(appCssSource, /dashboard-empty-art__/)
})

test('dashboard empty rendering is driven by the current projection instead of global repo count', () => {
  assert.doesNotMatch(appSource, /SHOW_EMPTY_STATE_KEY|showEmptyState|setShowEmptyState/)
  assert.match(appSource, /getDashboardEmptyProjection/)
})
