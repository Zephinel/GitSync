import assert from 'node:assert/strict'
import test from 'node:test'
import { formatReleaseVersion, RELEASE_DATE } from './releaseMetadata.js'

test('formats the app version with the ISO release date', () => {
  assert.match(RELEASE_DATE, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(formatReleaseVersion('3.0.0-test'), `3.0.0-test (${RELEASE_DATE})`)
})

test('does not append a date to unresolved version states', () => {
  assert.equal(formatReleaseVersion('读取中...'), '读取中...')
  assert.equal(formatReleaseVersion('未知版本'), '未知版本')
  assert.equal(formatReleaseVersion(''), '未知版本')
})
