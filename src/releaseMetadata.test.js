import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { formatReleaseVersion, RELEASE_DATE } from './releaseMetadata.js'

test('formats the app version with the ISO release date', () => {
  assert.match(RELEASE_DATE, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(formatReleaseVersion('3.0.0-test'), `3.0.0-test (${RELEASE_DATE})`)
})

test('RELEASE_DATE 不能落后于 CHANGELOG 里当前版本的日期', () => {
  /*
   * 这条是漂移护栏，不是重复实现。
   *
   * 此前上面那条测试用 RELEASE_DATE 自己去断言输出，等于「用实现验证实现」：
   * 常量停在 2026-09-29 而版本已经发到 0.1.4，测试照样全绿，于是「关于」里
   * 显示了「0.1.4 (2026-09-29)」这种新版本号配旧日期的组合。
   *
   * 所以这里改用仓库里另一处独立的事实来源——CHANGELOG 中与 package.json
   * 当前版本对应的条目日期——来约束这个常量。
   */
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const packageVersion = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ).version

  const entry = changelog.match(new RegExp(`^##\\s+${packageVersion.replace(/\\./g, '\\.')}\\s+\\((\\d{4}-\\d{2}-\\d{2})\\)`, 'm'))
  assert.ok(entry, `CHANGELOG.md 里应有当前版本 ${packageVersion} 的条目（形如 "## ${packageVersion} (YYYY-MM-DD)"）`)
  assert.equal(
    RELEASE_DATE,
    entry[1],
    `RELEASE_DATE 必须与 CHANGELOG 里 ${packageVersion} 的日期一致（发版时两处一起改）`
  )
})

test('does not append a date to unresolved version states', () => {
  assert.equal(formatReleaseVersion('读取中...'), '读取中...')
  assert.equal(formatReleaseVersion('未知版本'), '未知版本')
  assert.equal(formatReleaseVersion(''), '未知版本')
})
