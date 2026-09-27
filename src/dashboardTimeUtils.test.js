import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSyncTimePresentation } from './dashboardTimeUtils.js'
import { getRepoSyncSortTimestamp } from './repoStatusUtils.js'

test('sync presentation keeps missing timestamps natural', () => {
  assert.deepEqual(formatSyncTimePresentation(0, 1710000000000), {
    timestampMs: 0,
    relative: '从未同步',
    absolute: '',
    tooltip: '上次同步：从未同步',
  })
})

test('sync presentation exposes the exact local time from the final sort timestamp', () => {
  const persisted = 1710000000000
  const history = 1710000060000
  const nowMs = history + (2 * 60 * 60 * 1000)
  const finalSortTimestamp = getRepoSyncSortTimestamp(
    { id: 'repo', last_sync_at: String(persisted) },
    { repo: history }
  )
  const presentation = formatSyncTimePresentation(finalSortTimestamp, nowMs)

  assert.equal(presentation.timestampMs, history)
  assert.equal(presentation.relative, '2 小时前')
  assert.match(presentation.absolute, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(
    presentation.tooltip,
    `上次同步\n${presentation.absolute}\n2 小时前`
  )
  assert.doesNotMatch(
    presentation.tooltip,
    new RegExp(formatSyncTimePresentation(persisted, nowMs).absolute)
  )
})
