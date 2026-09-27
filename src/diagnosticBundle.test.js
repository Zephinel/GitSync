import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIAGNOSTIC_BUNDLE_KIND,
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  createDiagnosticBundlePayload,
  formatDiagnosticBundleForClipboard,
  isDiagnosticBundleEmpty,
} from './diagnosticBundle.js'

test('merges sync diagnostics and the app error log into one payload', () => {
  const payload = createDiagnosticBundlePayload({
    appVersion: '0.1.0',
    syncDiagnostics: {
      schemaVersion: 1,
      events: [{ requestId: 'req_1', phase: 'job_started' }],
    },
    appErrorLog: {
      schemaVersion: 1,
      entries: [{ scope: 'sync', message: 'boom' }],
    },
    now: new Date('2026-09-22T00:00:00.000Z'),
  })

  assert.equal(payload.schemaVersion, DIAGNOSTIC_BUNDLE_SCHEMA_VERSION)
  assert.equal(payload.kind, DIAGNOSTIC_BUNDLE_KIND)
  assert.equal(payload.appVersion, '0.1.0')
  assert.equal(payload.exportedAt, '2026-09-22T00:00:00.000Z')
  assert.equal(payload.syncDiagnostics.schemaVersion, 1)
  assert.equal(payload.syncDiagnostics.eventCount, 1)
  assert.equal(payload.syncDiagnostics.events.length, 1)
  assert.equal(payload.appErrorLog.schemaVersion, 1)
  assert.equal(payload.appErrorLog.entryCount, 1)
  assert.equal(payload.appErrorLog.entries[0].message, 'boom')
  assert.match(formatDiagnosticBundleForClipboard(payload), /"kind": "gitsync-diagnostic-bundle"/)
})

test('degrades to empty sections when a source is missing or malformed', () => {
  const payload = createDiagnosticBundlePayload({ syncDiagnostics: null, appErrorLog: 'nope' })
  assert.equal(payload.syncDiagnostics.eventCount, 0)
  assert.deepEqual(payload.syncDiagnostics.events, [])
  assert.equal(payload.appErrorLog.entryCount, 0)
  assert.deepEqual(payload.appErrorLog.entries, [])
  assert.equal(isDiagnosticBundleEmpty(payload), true)

  const partial = createDiagnosticBundlePayload({
    syncDiagnostics: { schemaVersion: 1, events: [{ phase: 'job_started' }] },
  })
  assert.equal(isDiagnosticBundleEmpty(partial), false)
})
