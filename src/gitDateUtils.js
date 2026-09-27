const GIT_COMMIT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2}):?(\d{2})$/

export function parseGitCommitDateToMs(value) {
  if (typeof value !== 'string') return 0
  const match = value.trim().match(GIT_COMMIT_DATE_RE)
  if (!match) return 0

  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  const hour = Number.parseInt(match[4], 10)
  const minute = Number.parseInt(match[5], 10)
  const second = Number.parseInt(match[6], 10)
  const offsetHour = Number.parseInt(match[8], 10)
  const offsetMinute = Number.parseInt(match[9], 10)

  if (
    month < 1 || month > 12
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return 0
  }

  const utcWithoutOffset = Date.UTC(year, month - 1, day, hour, minute, second)
  const calendarDate = new Date(utcWithoutOffset)
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
    || calendarDate.getUTCHours() !== hour
    || calendarDate.getUTCMinutes() !== minute
    || calendarDate.getUTCSeconds() !== second
  ) {
    return 0
  }

  const offsetMinutes = (offsetHour * 60) + offsetMinute
  const signedOffsetMinutes = match[7] === '-' ? -offsetMinutes : offsetMinutes
  const timestamp = utcWithoutOffset - (signedOffsetMinutes * 60 * 1000)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0
}

export function formatGitCommitLocalTime(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  const timestamp = parseGitCommitDateToMs(trimmed)
  if (!timestamp) return trimmed

  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}/${month}/${day} ${hour}:${minute}:${second}`
}
