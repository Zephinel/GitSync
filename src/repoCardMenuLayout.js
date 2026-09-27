export const REPO_CARD_MORE_MENU_GAP_PX = 8
export const REPO_CARD_MORE_MENU_VIEWPORT_PADDING_PX = 12
export const REPO_CARD_FLOATING_HOVER_BRIDGE_PADDING_PX = 8
export const REPO_CARD_MORE_MENU_PLACEMENT = {
  top: 'top',
  bottom: 'bottom',
}
export const REPO_CARD_FLOATING_ALIGNMENT = {
  left: 'left',
  right: 'right',
}

function getViewportSize(value, fallback) {
  const nextValue = Number(value)
  return Number.isFinite(nextValue) && nextValue > 0 ? nextValue : fallback
}

function getGlobalViewportSize(axis) {
  if (typeof window === 'undefined') return 0
  const windowValue = axis === 'width' ? window.innerWidth : window.innerHeight
  const documentValue = axis === 'width'
    ? document.documentElement?.clientWidth
    : document.documentElement?.clientHeight
  return getViewportSize(windowValue, getViewportSize(documentValue, 0))
}

export function getRepoCardMoreMenuPlacement(
  anchorRect,
  menuHeight,
  viewportHeight = getGlobalViewportSize('height')
) {
  const anchorTop = Number(anchorRect?.top) || 0
  const anchorBottom = Number(anchorRect?.bottom) || 0
  const requiredHeight = (Number(menuHeight) || 0) + REPO_CARD_MORE_MENU_GAP_PX
  const availableBelow = viewportHeight - anchorBottom - REPO_CARD_MORE_MENU_VIEWPORT_PADDING_PX
  const availableAbove = anchorTop - REPO_CARD_MORE_MENU_VIEWPORT_PADDING_PX
  if (availableBelow < requiredHeight && availableAbove > availableBelow) {
    return REPO_CARD_MORE_MENU_PLACEMENT.top
  }
  return REPO_CARD_MORE_MENU_PLACEMENT.bottom
}

export function isRepoCardMoreMenuAnchorVisible(anchorRect, viewport = {}) {
  const viewportWidth = getViewportSize(viewport.width, getGlobalViewportSize('width'))
  const viewportHeight = getViewportSize(viewport.height, getGlobalViewportSize('height'))
  const anchorTop = Number(anchorRect?.top) || 0
  const anchorBottom = Number(anchorRect?.bottom) || 0
  const anchorLeft = Number(anchorRect?.left) || 0
  const anchorRight = Number(anchorRect?.right) || 0
  const anchorWidth = Math.max(0, anchorRight - anchorLeft)
  const anchorHeight = Math.max(0, anchorBottom - anchorTop)

  if (anchorWidth === 0 || anchorHeight === 0 || viewportWidth === 0 || viewportHeight === 0) {
    return false
  }

  return anchorBottom > 0
    && anchorTop < viewportHeight
    && anchorRight > 0
    && anchorLeft < viewportWidth
}

export function getRepoCardMoreMenuLayout(
  anchorRect,
  menuRect,
  viewport = {}
) {
  return getRepoCardFloatingLayout(anchorRect, menuRect, viewport, {
    horizontalAlignment: REPO_CARD_FLOATING_ALIGNMENT.right,
  })
}

export function getRepoCardFloatingLayout(
  anchorRect,
  floatingRect,
  viewport = {},
  options = {}
) {
  const viewportWidth = getViewportSize(viewport.width, getGlobalViewportSize('width'))
  const viewportHeight = getViewportSize(viewport.height, getGlobalViewportSize('height'))
  const margin = REPO_CARD_MORE_MENU_VIEWPORT_PADDING_PX
  const gap = REPO_CARD_MORE_MENU_GAP_PX
  const anchorTop = Number(anchorRect?.top) || 0
  const anchorBottom = Number(anchorRect?.bottom) || 0
  const anchorRight = Number(anchorRect?.right) || 0
  const anchorLeft = Number(anchorRect?.left) || margin
  const floatingWidth = Math.max(0, Number(floatingRect?.width) || 0)
  const floatingHeight = Math.max(0, Number(floatingRect?.height) || 0)
  const placement = getRepoCardMoreMenuPlacement(anchorRect, floatingHeight, viewportHeight)

  const minLeft = margin
  const maxLeft = Math.max(minLeft, viewportWidth - floatingWidth - margin)
  const horizontalAlignment = options.horizontalAlignment || REPO_CARD_FLOATING_ALIGNMENT.right
  const preferredLeft = horizontalAlignment === REPO_CARD_FLOATING_ALIGNMENT.left
    ? anchorLeft
    : (anchorRight > 0 ? anchorRight - floatingWidth : anchorLeft)
  const left = Math.min(maxLeft, Math.max(minLeft, preferredLeft))

  const spaceBelow = Math.max(0, viewportHeight - anchorBottom - gap - margin)
  const spaceAbove = Math.max(0, anchorTop - gap - margin)
  const availableHeight = placement === REPO_CARD_MORE_MENU_PLACEMENT.top ? spaceAbove : spaceBelow
  const maxHeight = availableHeight > 0
    ? Math.floor(availableHeight)
    : Math.max(96, Math.floor(viewportHeight - margin * 2))
  const visibleFloatingHeight = Math.min(floatingHeight, maxHeight)
  const top = placement === REPO_CARD_MORE_MENU_PLACEMENT.top
    ? Math.max(margin, anchorTop - gap - visibleFloatingHeight)
    : Math.min(
      Math.max(margin, anchorBottom + gap),
      Math.max(margin, viewportHeight - margin - visibleFloatingHeight)
    )

  return {
    placement,
    top: Math.round(top),
    left: Math.round(left),
    maxHeight,
  }
}

export function getRepoCardFloatingHoverBridgeLayout(
  anchorRect,
  floatingRect,
  floatingLayout,
  viewport = {}
) {
  const viewportWidth = getViewportSize(viewport.width, getGlobalViewportSize('width'))
  const anchorTop = Number(anchorRect?.top) || 0
  const anchorBottom = Number(anchorRect?.bottom) || 0
  const anchorLeft = Number(anchorRect?.left) || 0
  const anchorRight = Number(anchorRect?.right) || 0
  const floatingTop = Number(floatingLayout?.top) || 0
  const floatingLeft = Number(floatingLayout?.left) || 0
  const floatingWidth = Math.max(0, Number(floatingRect?.width) || 0)
  const floatingHeight = Math.max(0, Number(floatingRect?.height) || 0)
  const maxHeight = Math.max(0, Number(floatingLayout?.maxHeight) || floatingHeight)
  const visibleFloatingHeight = Math.min(floatingHeight, maxHeight)
  const floatingRight = floatingLeft + floatingWidth
  const floatingBottom = floatingTop + visibleFloatingHeight
  const placement = floatingLayout?.placement || REPO_CARD_MORE_MENU_PLACEMENT.bottom
  const rawTop = placement === REPO_CARD_MORE_MENU_PLACEMENT.top ? floatingBottom : anchorBottom
  const rawBottom = placement === REPO_CARD_MORE_MENU_PLACEMENT.top ? anchorTop : floatingTop
  const height = Math.max(0, rawBottom - rawTop)

  if (height === 0 || floatingWidth === 0 || visibleFloatingHeight === 0) return null

  const rawLeft = Math.min(anchorLeft, floatingLeft) - REPO_CARD_FLOATING_HOVER_BRIDGE_PADDING_PX
  const rawRight = Math.max(anchorRight, floatingRight) + REPO_CARD_FLOATING_HOVER_BRIDGE_PADDING_PX
  const left = Math.max(0, rawLeft)
  const right = viewportWidth > 0 ? Math.min(viewportWidth, rawRight) : rawRight
  const width = Math.max(0, right - left)

  if (width === 0) return null

  return {
    top: Math.round(rawTop),
    left: Math.round(left),
    width: Math.round(width),
    height: Math.round(height),
  }
}
