// One clipboard export for everything a maintainer needs to diagnose a report.
//
// Historically the sync history center exposed two separate copy actions: a
// privacy-bounded sync diagnostic log and a raw application error log. Users
// could not tell which one to copy, and only one of them ever reached the other
// party. This module merges both sources into a single payload with clearly
// separated sections, keeping each section's own schema version for downstream
// tooling.
//
// The merge is deliberately additive: it does not widen what either source
// stores, it just hands both over together.

export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1
export const DIAGNOSTIC_BUNDLE_KIND = 'gitsync-diagnostic-bundle'

function toExportTimestamp(now) {
  const ms = now instanceof Date ? now.getTime() : Number(now)
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString()
}

export function createDiagnosticBundlePayload({
  appVersion = '',
  syncDiagnostics = {},
  appErrorLog = {},
  now = Date.now(),
} = {}) {
  const diagnostics = syncDiagnostics && typeof syncDiagnostics === 'object' ? syncDiagnostics : {}
  const errors = appErrorLog && typeof appErrorLog === 'object' ? appErrorLog : {}
  const events = Array.isArray(diagnostics.events) ? diagnostics.events : []
  const entries = Array.isArray(errors.entries) ? errors.entries : []

  return {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    kind: DIAGNOSTIC_BUNDLE_KIND,
    appVersion: String(appVersion || ''),
    exportedAt: toExportTimestamp(now),
    syncDiagnostics: {
      schemaVersion: Number(diagnostics.schemaVersion) || 0,
      eventCount: events.length,
      events,
    },
    appErrorLog: {
      schemaVersion: Number(errors.schemaVersion) || 0,
      entryCount: entries.length,
      entries,
    },
  }
}

export function isDiagnosticBundleEmpty(payload) {
  if (!payload || typeof payload !== 'object') return true
  return (payload.syncDiagnostics?.eventCount || 0) === 0
    && (payload.appErrorLog?.entryCount || 0) === 0
}

export function formatDiagnosticBundleForClipboard(payload) {
  return JSON.stringify(payload, null, 2)
}
