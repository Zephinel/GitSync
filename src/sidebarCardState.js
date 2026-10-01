// 窄屏侧边栏卡片的形态判定。
//
// 三种形态：
//   docked   —— 面板在栅格列里，和仪表盘同一个图层（宽屏，或窄屏但尚未展开）。
//   floating —— 面板是收在屏幕外的圆角卡片。
//   open     —— 卡片从左侧贴边推进来，盖在仪表盘之上。
//   docking  —— 窗口变宽，卡片沿原路径滑回它原来的栅格列，动画结束后才切回同一图层。
//
// floating/open/docked 三个形态完全由输入决定，唯一真正的状态是
// 「正在播放回位动画」这一个布尔量。把它单独拿出来，是因为窗口变宽会把
// `isOpen` 同时清成 false：如果按「当前是否展开」去触发回位，每次展开都会误触发。

export const SIDEBAR_CARD_MODE = Object.freeze({
  docked: 'docked',
  floating: 'floating',
  open: 'open',
  docking: 'docking',
})

export function resolveSidebarCardMode({ enabled, isOpen, isDocked, isDocking } = {}) {
  // 回位动画最优先：变宽时 isDocked 已经是 true，但那一档还要把浮层位置和
  // 栅格列一起反向，所以不能被 docked 抢先判定。
  if (isDocking) return SIDEBAR_CARD_MODE.docking
  if (!enabled || isDocked) return SIDEBAR_CARD_MODE.docked
  if (!isOpen) return SIDEBAR_CARD_MODE.floating
  return SIDEBAR_CARD_MODE.open
}

export function isSidebarCardFloating(mode) {
  return mode === SIDEBAR_CARD_MODE.floating
    || mode === SIDEBAR_CARD_MODE.open
    || mode === SIDEBAR_CARD_MODE.docking
}

export function isSidebarCardOpen(mode) {
  return mode === SIDEBAR_CARD_MODE.open
}

export function isSidebarCardDocking(mode) {
  return mode === SIDEBAR_CARD_MODE.docking
}

/**
 * 是否需要播放一次回位动画。这个纯函数与 App.jsx 里那个 effect 的判定必须逐字一致：
 * effect 负责读「上一次渲染的边沿」，这里只负责判定。
 *
 * 只有「窗口从窄变宽、且面板此刻是展开的」才需要：那种情况下 isOpen 会被一起清成
 * false，必须靠 wasEnabled 的下降沿把它认出来。反过来，用户在窄屏里按下展开
 * （isOpen 的上升沿）只是卡片从边缘推进来，不该触发回位。
 *
 * @param {{wasEnabled:boolean, wasOpen:boolean}} previous 上一次渲染结束时的边沿
 * @param {{enabled:boolean, isOpen:boolean, isDocked:boolean}} input 本次渲染的输入
 * @returns {{wasEnabled:boolean, wasOpen:boolean, shouldStartDocking:boolean}}
 *   wasEnabled / wasOpen 是供下一次渲染使用的「本次边沿」。
 */
export function resolveSidebarCardTransition(previous, input) {
  const enabled = Boolean(input?.enabled)
  const isOpen = Boolean(input?.isOpen)
  const isDocked = Boolean(input?.isDocked)
  const wasEnabled = Boolean(previous?.wasEnabled)
  const wasOpen = Boolean(previous?.wasOpen)
  const next = {
    wasEnabled: enabled,
    wasOpen: enabled && isOpen && !isDocked,
  }

  // 窗口刚变宽，而且面板在这一刻展开着：把它滑回原来的栅格列。
  if (!enabled && wasEnabled && (isOpen || wasOpen)) {
    return { ...next, shouldStartDocking: true }
  }

  return { ...next, shouldStartDocking: false }
}

/**
 * 侧边栏面板的可见性与栅格列占用——这段推导有三个意图在竞争，所以单独抽出来测。
 *
 * @param {object} input
 *   toolbarNeedsCollapse —— 顶栏一行放不下（sidebarFitAuthority 的判定）
 *   isCardRequested      —— 窄屏下用户手动展开了浮层
 *   isDockCollapsed      —— 宽屏下用户手动收起了面板
 *   isCardFloating       —— 浮层形态（floating / open）
 *   isCardDocking        —— 正在播放回位动画
 */
export const SIDEBAR_PANEL_PREFERENCE = Object.freeze({
  expanded: 'expanded',
  collapsed: 'collapsed',
})

export const SIDEBAR_PANEL_PREFERENCE_STORAGE_KEY = 'gitsync-sidebar-panel-preference'

/*
 * 侧边栏开合是一个持久偏好，**完全不是窗口宽度的函数**。
 *
 * 规则：只有两个来源能改变开合——用户按下的收起/展开，以及上次退出时留下的偏好。
 * 别的输入（尤其是窗口宽度）一律不能改变它。
 *
 * 为什么宽度也**不能**当「没有偏好时的默认值」：真实用法就是拖窗口边框看响应，
 * 那种情况下永远不会产生偏好，于是宽度继续决定开合，表现得和自动展开/收起一模一样。
 * 默认值只能是常量：首次使用默认展开（宽屏是贴边面板，窄屏是浮在仪表盘上的卡片，
 * 两者都不占主区宽度，所以「默认展开」在窄屏同样成立）。
 * 留空字符串表示「没有偏好」，此时取默认展开。
 */
export function normalizeSidebarPanelPreference(value) {
  if (value === SIDEBAR_PANEL_PREFERENCE.expanded) return SIDEBAR_PANEL_PREFERENCE.expanded
  if (value === SIDEBAR_PANEL_PREFERENCE.collapsed) return SIDEBAR_PANEL_PREFERENCE.collapsed
  return ''
}

export function readSidebarPanelPreference(storage) {
  try {
    const target = storage === undefined ? globalThis?.localStorage : storage
    return normalizeSidebarPanelPreference(
      target?.getItem?.(SIDEBAR_PANEL_PREFERENCE_STORAGE_KEY)
    )
  } catch {
    return ''
  }
}

export function writeSidebarPanelPreference(value, storage) {
  const preference = normalizeSidebarPanelPreference(value)
  try {
    const target = storage === undefined ? globalThis?.localStorage : storage
    if (!preference) {
      target?.removeItem?.(SIDEBAR_PANEL_PREFERENCE_STORAGE_KEY)
    } else {
      target?.setItem?.(SIDEBAR_PANEL_PREFERENCE_STORAGE_KEY, preference)
    }
  } catch {
    // 存储不可用时保持当前 UI 状态即可。
  }
  return preference
}

export function resolveSidebarPanelLayout({
  toolbarNeedsCollapse = false,
  preference = '',
  isCardFloating = false,
  isCardDocking = false,
} = {}) {
  const saved = normalizeSidebarPanelPreference(preference)
  /*
   * 唯一 authority 是偏好；没有偏好时取常量默认值「展开」。
   * toolbarNeedsCollapse 只用来决定「收起时要不要算成让出了宽屏那一列」，
   * 绝不参与「开还是合」的判定。
   */
  const visible = saved
    ? saved === SIDEBAR_PANEL_PREFERENCE.expanded
    : true
  const dockCollapsed = !visible && !toolbarNeedsCollapse

  /*
   * 栅格第一列该不该占宽度，只看「面板现在是不是浮层 / 有没有被手动收起」，
   * 不看面板可不可见。踩过的坑：拿可见性当判据，于是卡片一展开这一列就回到
   * 240px，主区被挤窄、顶栏折成两行——而做成悬浮卡片的全部意义就是不让它折。
   */
  const columnCollapsed = Boolean(isCardFloating) || Boolean(isCardDocking) || dockCollapsed

  return { visible, dockCollapsed, columnCollapsed, preference: saved }
}
