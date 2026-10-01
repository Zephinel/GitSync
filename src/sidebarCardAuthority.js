// 窄屏下侧边栏的「悬浮卡片」形态。
//
// 宽度不够时侧边栏不再占着一整列，而是变成一张浮在仪表盘之上的圆角卡片：
// 打开时从左侧贴边推进来，收起时镜像退回边缘之外。
//
// 这里只负责卡片的几何与节奏，**不重复实现断点**：什么时候进入卡片形态完全由
// sidebarFitAuthority 的收起判定（toolbarNeedsCollapse）决定，两套断点会互相打架。
// 形态状态机在 sidebarCardState.js。
//   - 卡片四周的留白、圆角与 z 轴都由 CSS 变量给出，JS 只写入 left/bottom 的像素值。

export const SIDEBAR_CARD_INSET_PX = 24
export const SIDEBAR_CARD_RADIUS_PX = 16
export const SIDEBAR_CARD_Z_INDEX = 60
// 与 CSS 里的 --sidebar-card-dock-duration 对齐，只作为「过渡事件没等到」时的兜底。
export const SIDEBAR_CARD_DOCK_DURATION_MS = 280
export const SIDEBAR_CARD_DOCK_FALLBACK_MS = SIDEBAR_CARD_DOCK_DURATION_MS + 220
// Windows 的经典滚动条会占掉纵向空间，卡片右边缘要按这段宽度收起，避免压出纵向滚动条。
export const SIDEBAR_CARD_SCROLLBAR_GUTTER_PX = 12

export const SIDEBAR_CARD_INSET_FALLBACK_PX = 24
export const SIDEBAR_CARD_RADIUS_FALLBACK_PX = 16
export const SIDEBAR_CARD_Z_INDEX_FALLBACK = 60
export const SIDEBAR_CARD_SCROLLBAR_GUTTER_FALLBACK_PX = 12

function toNonNegativeNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 悬浮卡片的几何：视口四边各留一段，顶部/底部同样留白，于是卡片是一张
 * 有厚度的圆角浮层，而不是贴着窗口边缘的面板。
 */
export function resolveSidebarCardRect({
  inset = SIDEBAR_CARD_INSET_PX,
  radius = SIDEBAR_CARD_RADIUS_PX,
  zIndex = SIDEBAR_CARD_Z_INDEX,
  scrollbarGutter = SIDEBAR_CARD_SCROLLBAR_GUTTER_PX,
} = {}) {
  return {
    inset: toNonNegativeNumber(inset, SIDEBAR_CARD_INSET_FALLBACK_PX),
    radius: toNonNegativeNumber(radius, SIDEBAR_CARD_RADIUS_FALLBACK_PX),
    zIndex: toPositiveNumber(zIndex, SIDEBAR_CARD_Z_INDEX_FALLBACK),
    // 右边缘比左边缘多留一点：卡片是 fixed 的，右边缘不收进来就可能压出滚动条。
    edgeRight: toNonNegativeNumber(scrollbarGutter, SIDEBAR_CARD_SCROLLBAR_GUTTER_FALLBACK_PX),
  }
}
