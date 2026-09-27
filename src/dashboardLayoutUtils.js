export const DASHBOARD_LAYOUT_MODE = Object.freeze({
  list: 'list',
  // Keep this persisted value for existing users; the UI calls it card layout.
  card: 'masonry',
})

export function normalizeDashboardLayout(value) {
  return value === DASHBOARD_LAYOUT_MODE.list
    ? DASHBOARD_LAYOUT_MODE.list
    : DASHBOARD_LAYOUT_MODE.card
}

export function buildDashboardRows(items, layout, columnCount) {
  const list = Array.isArray(items) ? items : []
  if (layout === DASHBOARD_LAYOUT_MODE.list) return list.map((item) => [item])

  const safeColumnCount = Math.max(1, Number(columnCount) || 1)
  const rows = []
  for (let index = 0; index < list.length; index += safeColumnCount) {
    rows.push(list.slice(index, index + safeColumnCount))
  }
  return rows
}

export function flattenDashboardRows(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => (
    Array.isArray(row) ? row : []
  ))
}
