const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'

export function errorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return String(error.message)
  if (error?.title) return String(error.title)
  try { return JSON.stringify(error) } catch { return '未知错误' }
}

export function operationError(message, needsConfirmation) {
  const error = new Error(message)
  error.needsConfirmation = needsConfirmation
  return error
}

export function shortOid(value) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, 12) : '—'
}

export function dateMs(value) {
  const parsed = new Date(value)
  const milliseconds = parsed.getTime()
  return Number.isFinite(milliseconds) ? milliseconds : 0
}

export function formatDate(value) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '时间未知' : parsed.toLocaleString()
}

export function branchKey(entry) {
  return String(entry?.branchContext || 'other').trim() || 'other'
}

export function visiblePageNumbers(current, total) {
  if (total <= 5) return Array.from({ length: total }, (_, index) => index + 1)
  const candidates = new Set([1, total, current - 1, current, current + 1])
  return [...candidates]
    .filter((value) => value >= 1 && value <= total)
    .sort((left, right) => left - right)
}

export function trapTabKey(event, root) {
  if (event.key !== 'Tab' || !root) return
  const focusable = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

export function Spinner() {
  return <span className="stash-manager-spinner" aria-hidden="true" />
}
