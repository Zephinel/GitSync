// General-purpose, local, bounded error log.
//
// The dashboard only ever shows a short generic message for a failure, and the
// raw reason disappears as soon as the condition clears. This module keeps the
// most recent failures of any operation (remote fetch, status refresh, sync,
// branch operations, uncaught errors) in local storage so the user can copy
// them out of a packaged build and hand them over for diagnosis.
//
// It deliberately stays separate from the sync diagnostic events, whose
// documented privacy contract excludes repository paths and raw error text.

export const APP_ERROR_LOG_STORAGE_KEY = 'gitsync-error-log'
export const APP_ERROR_LOG_SCHEMA_VERSION = 1
export const MAX_APP_ERROR_LOG_ENTRIES = 200
export const APP_ERROR_LOG_MAX_MESSAGE_LENGTH = 2000

function defaultStorage() {
  try {
    return globalThis?.localStorage ?? null
  } catch {
    return null
  }
}

export function normalizeAppErrorLogEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {}
  const timestamp = Number(source.timestamp) || Date.now()
  return {
    schemaVersion: APP_ERROR_LOG_SCHEMA_VERSION,
    id: String(source.id || `apperr_${timestamp}_${Math.random().toString(36).slice(2, 8)}`),
    timestamp,
    scope: String(source.scope || 'unknown').slice(0, 60),
    repoId: String(source.repoId || '').slice(0, 120),
    repoName: String(source.repoName || '').slice(0, 160),
    message: String(source.message || '').slice(0, APP_ERROR_LOG_MAX_MESSAGE_LENGTH),
  }
}

export function loadAppErrorLog(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem?.(APP_ERROR_LOG_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && typeof item === 'object')
      .slice(-MAX_APP_ERROR_LOG_ENTRIES)
  } catch {
    return []
  }
}

export function appendAppErrorLogEntries(entries, storage = defaultStorage()) {
  const nextEntries = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map(normalizeAppErrorLogEntry)
  if (nextEntries.length === 0) return loadAppErrorLog(storage)
  const combined = [...loadAppErrorLog(storage), ...nextEntries].slice(-MAX_APP_ERROR_LOG_ENTRIES)
  try {
    storage?.setItem?.(APP_ERROR_LOG_STORAGE_KEY, JSON.stringify(combined))
  } catch {
    // Storage unavailable: the caller still receives the in-memory entry list.
  }
  return combined
}

export function clearAppErrorLog(storage = defaultStorage()) {
  try {
    storage?.removeItem?.(APP_ERROR_LOG_STORAGE_KEY)
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export function createAppErrorLogPayload({ appVersion = '', entries, now = Date.now(), storage = defaultStorage() } = {}) {
  const list = Array.isArray(entries) ? entries : loadAppErrorLog(storage)
  const exportedAtMs = now instanceof Date ? now.getTime() : Number(now) || Date.now()
  return {
    schemaVersion: APP_ERROR_LOG_SCHEMA_VERSION,
    appVersion: String(appVersion || ''),
    exportedAt: new Date(exportedAtMs).toISOString(),
    entryCount: list.length,
    entries: list,
  }
}

export function formatAppErrorLogForClipboard(payload) {
  return JSON.stringify(payload, null, 2)
}
