// 侧边栏自动收起的判定。
//
// 顶栏要求单行显示：当「顶栏单行所需宽度 + 侧边栏宽度 + 主区左右内边距」超过窗口宽度时，
// 收起侧边栏把这 240px 还给主区，而不是让顶栏换行。
//
// 这里只做纯计算，真实宽度由调用方测量：字号、字体回退与语言都会影响顶栏的自然宽度，
// 写死一个断点会在这些变化下漂移。

export const SIDEBAR_WIDTH_FALLBACK_PX = 240
export const MAIN_CONTENT_PADDING_FALLBACK_PX = 64
// 顶栏宽度是取整后的测量值，紧贴边界时真实布局可能差几个像素；留一点余量避免在边界上抖动。
export const SIDEBAR_FIT_SAFETY_PX = 12

function toPositiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function resolveSidebarFitMetrics({
  requiredRowWidth = 0,
  sidebarWidth = SIDEBAR_WIDTH_FALLBACK_PX,
  mainPadding = MAIN_CONTENT_PADDING_FALLBACK_PX,
  windowWidth = 0,
} = {}) {
  const row = toPositiveNumber(requiredRowWidth)
  const sidebar = toPositiveNumber(sidebarWidth) || SIDEBAR_WIDTH_FALLBACK_PX
  const padding = toPositiveNumber(mainPadding) || MAIN_CONTENT_PADDING_FALLBACK_PX
  const viewport = toPositiveNumber(windowWidth)

  return {
    requiredRowWidth: row,
    sidebarWidth: sidebar,
    mainPadding: padding,
    windowWidth: viewport,
    // 顶栏一行放得下所需的最小窗口宽度；量不到顶栏时为 0（表示「不参与判定」）。
    requiredWindowWidth: row > 0 ? Math.ceil(row + sidebar + padding + SIDEBAR_FIT_SAFETY_PX) : 0,
  }
}

export function shouldCollapseSidebar(input) {
  const metrics = resolveSidebarFitMetrics(input)
  // 量不到顶栏（例如不在仪表盘页、或还没有布局）时不收起，避免误伤其它页面。
  if (metrics.requiredRowWidth <= 0 || metrics.windowWidth <= 0) return false
  return metrics.windowWidth < metrics.requiredWindowWidth
}
