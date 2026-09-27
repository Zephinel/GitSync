export function formatStashRelativeDate(value, now = Date.now()) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '时间未知'

  const elapsed = now - parsed.getTime()
  if (elapsed >= 0 && elapsed < 60_000) return '刚刚'
  if (elapsed >= 0 && elapsed < 60 * 60_000) {
    return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`
  }
  if (elapsed >= 0 && elapsed < 24 * 60 * 60_000) {
    return `${Math.max(1, Math.floor(elapsed / (60 * 60_000)))} 小时前`
  }
  if (elapsed >= 0 && elapsed < 7 * 24 * 60 * 60_000) {
    return `${Math.max(1, Math.floor(elapsed / (24 * 60 * 60_000)))} 天前`
  }
  return parsed.toLocaleDateString()
}
