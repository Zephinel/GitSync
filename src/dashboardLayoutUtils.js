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

/**
 * 卡片布局的投影：把已排序数组按 `index % columnCount` 保序分发到等宽列。
 *
 * 为什么不是 row-major 分行：
 *   行的做法要求每行做成一个 grid，而 grid 会把这行的卡片拉到同高
 *   （`align-items: stretch` 的默认行为），卡片高度就不再由内容决定，
 *   瀑布流也就不存在了。只有列容器（flex column）能让每张卡片自己决定高度。
 *
 * 保序仍然成立：分配顺序就是「先左到右、再上到下」的阅读顺序——
 * 第 1 轮分发（索引 0..n-1）落在第 0..n-1 列，即从左到右的第一排；
 * 第 2 轮落到各列的第二个位置。所以视觉阅读顺序与排序顺序一致。
 */
export function buildDashboardColumns(items, layout, columnCount) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return []
  if (layout === DASHBOARD_LAYOUT_MODE.list) return list.map((item) => [item])

  const safeColumnCount = Math.max(1, Number(columnCount) || 1)
  const columns = Array.from({ length: safeColumnCount }, () => [])
  list.forEach((item, index) => {
    columns[index % safeColumnCount].push(item)
  })
  return columns
}

/**
 * 列表布局的投影：每行一个仓库。
 * 与 `buildDashboardColumns` 输出同一种形状（数组的数组），渲染端共用一套遍历。
 */
export function buildDashboardRows(items, layout, columnCount) {
  return buildDashboardColumns(items, layout, columnCount)
}

export function flattenDashboardRows(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => (
    Array.isArray(row) ? row : []
  ))
}

/**
 * 列投影的视觉阅读顺序（先左到右、再上到下的读取），
 * 用于断言「投影只是投影，没有重新解释排序」。
 */
export function readDashboardColumnsInVisualOrder(columns) {
  const safeColumns = (Array.isArray(columns) ? columns : []).map((column) => (
    Array.isArray(column) ? column : []
  ))
  const rowCount = safeColumns.reduce((max, column) => Math.max(max, column.length), 0)
  const ordered = []
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    safeColumns.forEach((column) => {
      if (rowIndex < column.length) ordered.push(column[rowIndex])
    })
  }
  return ordered
}
