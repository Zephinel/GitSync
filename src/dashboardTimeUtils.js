import {
  formatRelativeTimeFromMs,
  normalizeRepoTimestampToMs,
} from './repoStatusUtils.js'

function formatLocalTimestamp(timestampMs) {
  const date = new Date(timestampMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}/${month}/${day} ${hour}:${minute}:${second}`
}

export function formatSyncTimePresentation(timestamp, nowMs = Date.now()) {
  const timestampMs = normalizeRepoTimestampToMs(timestamp)
  if (!timestampMs) {
    return {
      timestampMs: 0,
      relative: '从未同步',
      absolute: '',
      tooltip: '上次同步：从未同步',
    }
  }

  const relative = formatRelativeTimeFromMs(timestampMs, nowMs)
  const absolute = formatLocalTimestamp(timestampMs)
  return {
    timestampMs,
    relative,
    absolute,
    tooltip: `上次同步\n${absolute}\n${relative}`,
  }
}
