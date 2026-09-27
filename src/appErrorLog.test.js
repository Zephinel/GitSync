import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_ERROR_LOG_MAX_MESSAGE_LENGTH,
  APP_ERROR_LOG_STORAGE_KEY,
  MAX_APP_ERROR_LOG_ENTRIES,
  appendAppErrorLogEntries,
  clearAppErrorLog,
  createAppErrorLogPayload,
  formatAppErrorLogForClipboard,
  loadAppErrorLog,
  normalizeAppErrorLogEntry,
} from './appErrorLog.js'

function createStorage() {
  const values = new Map()
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

test('normalizes an entry with defaults and clips the raw message', () => {
  const entry = normalizeAppErrorLogEntry({
    timestamp: 1710000000000,
    scope: 'remote-fetch',
    repoId: 'repo_1',
    repoName: 'demo',
    message: 'x'.repeat(APP_ERROR_LOG_MAX_MESSAGE_LENGTH + 50),
  })
  assert.equal(entry.schemaVersion, 1)
  assert.equal(entry.timestamp, 1710000000000)
  assert.equal(entry.scope, 'remote-fetch')
  assert.equal(entry.repoId, 'repo_1')
  assert.equal(entry.repoName, 'demo')
  assert.equal(entry.message.length, APP_ERROR_LOG_MAX_MESSAGE_LENGTH)
  assert.match(entry.id, /^apperr_1710000000000_/)
})

test('appends and reloads raw git failure text from storage', () => {
  const storage = createStorage()
  appendAppErrorLogEntries([{
    scope: 'remote-fetch',
    repoId: 'repo_1',
    repoName: 'demo',
    message: "刷新远程信息失败: error: cannot open '.git/FETCH_HEAD': Operation not permitted",
  }], storage)

  const entries = loadAppErrorLog(storage)
  assert.equal(entries.length, 1)
  assert.match(entries[0].message, /Operation not permitted/)
  assert.match(storage.getItem(APP_ERROR_LOG_STORAGE_KEY), /Operation not permitted/)
})

test('keeps only the most recent entries and clears on demand', () => {
  const storage = createStorage()
  for (let index = 0; index < MAX_APP_ERROR_LOG_ENTRIES + 25; index += 1) {
    appendAppErrorLogEntries([{ scope: 'sync', message: `failure-${index}` }], storage)
  }
  const entries = loadAppErrorLog(storage)
  assert.equal(entries.length, MAX_APP_ERROR_LOG_ENTRIES)
  assert.equal(entries[0].message, 'failure-25')
  assert.equal(entries.at(-1).message, `failure-${MAX_APP_ERROR_LOG_ENTRIES + 24}`)

  clearAppErrorLog(storage)
  assert.deepEqual(loadAppErrorLog(storage), [])
})

test('builds an exportable payload and survives unavailable storage', () => {
  const payload = createAppErrorLogPayload({
    appVersion: '0.1.0',
    entries: [normalizeAppErrorLogEntry({ scope: 'sync', message: 'boom' })],
    now: new Date('2026-09-21T00:00:00.000Z'),
  })
  assert.equal(payload.schemaVersion, 1)
  assert.equal(payload.appVersion, '0.1.0')
  assert.equal(payload.entryCount, 1)
  assert.equal(payload.exportedAt, '2026-09-21T00:00:00.000Z')
  assert.match(formatAppErrorLogForClipboard(payload), /"message": "boom"/)

  const brokenStorage = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  assert.deepEqual(loadAppErrorLog(brokenStorage), [])
  const recorded = appendAppErrorLogEntries([{ scope: 'sync', message: 'kept' }], brokenStorage)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].message, 'kept')
})
