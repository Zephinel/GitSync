export const COMMIT_DIFF_SPLIT_MIN_WIDTH = 900
export const COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH = 0
export const COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH = 320

export function isCommitDiffSplitViewportNarrow(viewportWidth) {
  const width = Number(viewportWidth)
  return Number.isFinite(width) && width <= COMMIT_DIFF_SPLIT_MIN_WIDTH
}

export function clampFocusSidebarWidth(value) {
  const width = Number(value)
  if (!Number.isFinite(width)) return COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH
  return Math.max(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH, Math.min(COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH, Math.round(width)))
}

function padDatePart(value) {
  return String(value).padStart(2, '0')
}

function formatLocalDateTime(date) {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-') + ' ' + [
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
    padDatePart(date.getSeconds()),
  ].join(':')
}

export function formatCommitDisplayDate(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const parsed = new Date(text)
    if (Number.isFinite(parsed.getTime())) return formatLocalDateTime(parsed)
  }
  return text
    .replace(/([T ]\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))$/i, '$1')
    .replace(/([T ]\d{2}:\d{2}:\d{2})\.\d+$/, '$1')
    .replace('T', ' ')
}
