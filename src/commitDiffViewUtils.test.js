import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH,
  COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH,
  COMMIT_DIFF_SPLIT_MIN_WIDTH,
  clampFocusSidebarWidth,
  formatCommitDisplayDate,
  isCommitDiffSplitViewportNarrow,
} from './commitDiffViewUtils.js'

function formatExpectedLocalDateTime(value) {
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(':')
}

test('commit diff view constants keep split and focus sidebar limits explicit', () => {
  assert.equal(COMMIT_DIFF_SPLIT_MIN_WIDTH, 900)
  assert.equal(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH, 0)
  assert.equal(COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH, 320)
})

test('split view treats the exact minimum-width boundary as narrow', () => {
  assert.equal(isCommitDiffSplitViewportNarrow(899), true)
  assert.equal(isCommitDiffSplitViewportNarrow(900), true)
  assert.equal(isCommitDiffSplitViewportNarrow(901), false)
})

test('clampFocusSidebarWidth clamps invalid, underflow, overflow, fractional, and string values', () => {
  assert.equal(clampFocusSidebarWidth(NaN), 0)
  assert.equal(clampFocusSidebarWidth(Infinity), 0)
  assert.equal(clampFocusSidebarWidth(-Infinity), 0)
  assert.equal(clampFocusSidebarWidth(-100), 0)
  assert.equal(clampFocusSidebarWidth(0), 0)
  assert.equal(clampFocusSidebarWidth(320), 320)
  assert.equal(clampFocusSidebarWidth(500), 320)
  assert.equal(clampFocusSidebarWidth(42.7), 43)
  assert.equal(clampFocusSidebarWidth('42'), 42)
  assert.equal(clampFocusSidebarWidth('garbage'), 0)
  assert.equal(clampFocusSidebarWidth(null), 0)
  assert.equal(clampFocusSidebarWidth(undefined), 0)
})

test('formatCommitDisplayDate converts timezone-aware values to local seconds', () => {
  assert.equal(
    formatCommitDisplayDate('2026-07-07T03:47:58Z'),
    formatExpectedLocalDateTime('2026-07-07T03:47:58Z')
  )
  assert.equal(
    formatCommitDisplayDate('2026-07-07T03:47:58+08:00'),
    formatExpectedLocalDateTime('2026-07-07T03:47:58+08:00')
  )
  assert.equal(
    formatCommitDisplayDate('2026-07-07T03:47:58+0800'),
    formatExpectedLocalDateTime('2026-07-07T03:47:58+0800')
  )
})

test('formatCommitDisplayDate keeps local-looking values and trims precision or timezone suffixes', () => {
  assert.equal(formatCommitDisplayDate('2026-07-07'), '2026-07-07')
  assert.equal(formatCommitDisplayDate('2026-07-07T03:47:58.123'), '2026-07-07 03:47:58')
  assert.equal(formatCommitDisplayDate('2026-07-07 03:47:58.123'), '2026-07-07 03:47:58')
  assert.equal(formatCommitDisplayDate('not a date'), 'not a date')
  assert.equal(formatCommitDisplayDate(''), '')
  assert.equal(formatCommitDisplayDate('   '), '')
  assert.equal(formatCommitDisplayDate(null), '')
})
