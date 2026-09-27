// Shared geometry and gating for every floating tooltip in the app.
//
// One visual authority (`.app-tooltip`) serves three producers: the delegated
// `data-app-tooltip` layer, the branch-name hover tooltip, and `CustomSelect`.
// They all position themselves through this module.
//
// Two anchoring modes:
// - A pointer anchor follows the cursor the way the native tooltip did. It is
//   the default for explicit hints, which may sit on a full-width container.
// - An element anchor hangs the surface on the anchor's left edge. It is used
//   by the truncation-gated hints, where the surface documents the label it
//   belongs to.

export const APP_TOOLTIP_DELAY_MS = 620
export const APP_TOOLTIP_OFFSET_PX = 7
export const APP_TOOLTIP_VIEWPORT_GUTTER_PX = 12
export const APP_TOOLTIP_MIN_MAX_WIDTH_PX = 180
export const APP_TOOLTIP_MAX_MAX_WIDTH_PX = 520
export const APP_TOOLTIP_POINTER_OFFSET_X_PX = 12
export const APP_TOOLTIP_POINTER_OFFSET_Y_PX = 18
export const APP_TOOLTIP_POINTER_FLIP_GAP_PX = 10

export function getViewportSize(win = globalThis.window) {
  return {
    width: win?.innerWidth || win?.document?.documentElement?.clientWidth || 0,
    height: win?.innerHeight || win?.document?.documentElement?.clientHeight || 0,
  }
}

// The wrapping constraint applied before the surface is measured. It only caps
// very long hints; it must not be used as the assumed width when positioning.
export function getAppTooltipMaxWidth(viewportWidth) {
  const width = Number(viewportWidth) || 0
  return Math.max(
    APP_TOOLTIP_MIN_MAX_WIDTH_PX,
    Math.min(APP_TOOLTIP_MAX_MAX_WIDTH_PX, width - APP_TOOLTIP_VIEWPORT_GUTTER_PX * 2),
  )
}

// Shared resolve step: clamp the left edge into the viewport, then keep the
// preferred side when it fits and flip to the other side when it does not.
function resolveAppTooltipPosition({ desiredLeft, belowTop, aboveTop, width, height, viewport }) {
  const viewportWidth = Number(viewport?.width) || 0
  const viewportHeight = Number(viewport?.height) || 0
  const surfaceWidth = Number(width) || 0
  const surfaceHeight = Number(height) || 0
  const maxLeft = Math.max(
    APP_TOOLTIP_VIEWPORT_GUTTER_PX,
    viewportWidth - surfaceWidth - APP_TOOLTIP_VIEWPORT_GUTTER_PX,
  )
  const left = Math.min(Math.max(Number(desiredLeft) || 0, APP_TOOLTIP_VIEWPORT_GUTTER_PX), maxLeft)
  const fitsBelow = belowTop + surfaceHeight <= viewportHeight - APP_TOOLTIP_VIEWPORT_GUTTER_PX
  const fitsAbove = aboveTop >= APP_TOOLTIP_VIEWPORT_GUTTER_PX
  const placement = fitsBelow || !fitsAbove ? 'bottom' : 'top'

  return {
    left,
    top: placement === 'bottom' ? belowTop : aboveTop,
    maxWidth: getAppTooltipMaxWidth(viewportWidth),
    placement,
  }
}

// Element anchor: the surface keeps the anchor's left edge and slides left only
// by as much as it actually overflows, so a short hint never gets pushed away
// from its anchor by a worst-case max-width guess.
export function getAppTooltipPosition({ anchorRect, width, height, viewport }) {
  const anchorTop = Number(anchorRect?.top) || 0
  const anchorBottom = Number(anchorRect?.bottom) || 0
  const surfaceHeight = Number(height) || 0

  return resolveAppTooltipPosition({
    desiredLeft: Number(anchorRect?.left) || 0,
    belowTop: anchorBottom + APP_TOOLTIP_OFFSET_PX,
    aboveTop: anchorTop - APP_TOOLTIP_OFFSET_PX - surfaceHeight,
    width,
    height,
    viewport,
  })
}

// Pointer anchor: below-right of the cursor, like the native tooltip, clamped
// into the viewport and flipped above when there is no room below.
export function getAppTooltipPointPosition({ point, width, height, viewport }) {
  const pointerX = Number(point?.x) || 0
  const pointerY = Number(point?.y) || 0
  const surfaceHeight = Number(height) || 0

  return resolveAppTooltipPosition({
    desiredLeft: pointerX + APP_TOOLTIP_POINTER_OFFSET_X_PX,
    belowTop: pointerY + APP_TOOLTIP_POINTER_OFFSET_Y_PX,
    aboveTop: pointerY - APP_TOOLTIP_POINTER_FLIP_GAP_PX - surfaceHeight,
    width,
    height,
    viewport,
  })
}

// A tooltip that carries the full value of a truncated label is noise when the
// label already fits. CustomSelect and the branch-name rows opt into this gate.
export function isTextVisuallyTruncated(textElement) {
  if (!textElement?.isConnected) return false
  const elementWidth = Number(textElement.getBoundingClientRect?.().width)
    || Number(textElement.clientWidth)
    || 0
  if (elementWidth <= 0) return false
  if (Number(textElement.scrollWidth) > elementWidth + 1) return true
  const documentRef = textElement.ownerDocument
  if (typeof documentRef?.createRange !== 'function') return false
  try {
    const range = documentRef.createRange()
    range.selectNodeContents(textElement)
    return range.getBoundingClientRect().width > elementWidth + 1
  } catch {
    return false
  }
}
