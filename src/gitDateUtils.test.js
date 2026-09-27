import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseGitCommitDateToMs, formatGitCommitLocalTime } from './gitDateUtils.js'

const UTC = (value) => Date.parse(value)

test('parses Git commit dates with compact and colon-separated positive offsets', () => {
  assert.equal(
    parseGitCommitDateToMs('2026-09-25 12:00:00 +0800'),
    UTC('2026-09-25T04:00:00Z')
  )
  assert.equal(
    parseGitCommitDateToMs('2026-09-25 12:00:00 +08:00'),
    UTC('2026-09-25T04:00:00Z')
  )
  assert.equal(
    parseGitCommitDateToMs('2026-09-25 12:00:00 +05:30'),
    UTC('2026-09-25T06:30:00Z')
  )
})

test('applies the sign to the complete negative timezone offset', () => {
  assert.equal(
    parseGitCommitDateToMs('2026-09-25 12:00:00 -03:30'),
    UTC('2026-09-25T15:30:00Z')
  )
  assert.equal(
    parseGitCommitDateToMs('2026-09-25 12:00:00 -09:30'),
    UTC('2026-09-25T21:30:00Z')
  )
  assert.equal(
    parseGitCommitDateToMs('2026-09-25 12:00:00 +00:00'),
    UTC('2026-09-25T12:00:00Z')
  )
})

test('returns zero for invalid Git commit dates and formats valid dates from the same epoch', () => {
  assert.equal(parseGitCommitDateToMs('not a git date'), 0)
  assert.equal(parseGitCommitDateToMs('2026-02-30 12:00:00 +0000'), 0)
  assert.equal(parseGitCommitDateToMs('2026-09-25 12:00:00 +2460'), 0)

  const value = '2026-09-25 12:00:00 -03:30'
  const date = new Date(parseGitCommitDateToMs(value))
  const expected = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  assert.equal(formatGitCommitLocalTime(value), expected)
})

test('App and sorting code consume the shared Git date parser', () => {
  const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const repoStatusSource = readFileSync(new URL('./repoStatusUtils.js', import.meta.url), 'utf8')
  assert.doesNotMatch(appSource, /GIT_DATE_RE|parseGitDateToTs/)
  assert.match(appSource, /parseGitCommitDateToMs/)
  assert.match(repoStatusSource, /parseGitCommitDateToMs/)
  assert.doesNotMatch(repoStatusSource, /Date\.UTC/)
})
