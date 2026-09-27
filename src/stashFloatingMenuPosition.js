const DEFAULT_GAP = 6
const DEFAULT_MARGIN = 8

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, minimum, maximum) {
  if (maximum < minimum) return minimum
  return Math.min(Math.max(value, minimum), maximum)
}

export function computeFloatingMenuPosition({
  triggerRect,
  menuRect,
  viewportWidth,
  viewportHeight,
  preferredPlacement = 'bottom',
  gap = DEFAULT_GAP,
  margin = DEFAULT_MARGIN,
}) {
  const width = Math.max(0, finite(menuRect?.width))
  const height = Math.max(0, finite(menuRect?.height))
  const viewportW = Math.max(0, finite(viewportWidth))
  const viewportH = Math.max(0, finite(viewportHeight))
  const safeGap = Math.max(0, finite(gap, DEFAULT_GAP))
  const safeMargin = Math.max(0, finite(margin, DEFAULT_MARGIN))
  const triggerTop = finite(triggerRect?.top)
  const triggerBottom = finite(triggerRect?.bottom, triggerTop)
  const triggerRight = finite(triggerRect?.right)

  const spaceAbove = Math.max(0, triggerTop - safeGap - safeMargin)
  const spaceBelow = Math.max(0, viewportH - safeMargin - triggerBottom - safeGap)
  const wantsTop = preferredPlacement === 'top' || preferredPlacement === 'above'
  const preferredSpace = wantsTop ? spaceAbove : spaceBelow
  const alternateSpace = wantsTop ? spaceBelow : spaceAbove
  const fitsPreferred = height <= preferredSpace
  const fitsAlternate = height <= alternateSpace

  let placement
  if (fitsPreferred || (!fitsAlternate && preferredSpace >= alternateSpace)) {
    placement = wantsTop ? 'top' : 'bottom'
  } else {
    placement = wantsTop ? 'bottom' : 'top'
  }

  const availableHeight = placement === 'top' ? spaceAbove : spaceBelow
  const renderedHeight = Math.min(height, availableHeight)
  const availableWidth = Math.max(0, viewportW - safeMargin * 2)
  const renderedWidth = Math.min(width, availableWidth)
  const left = clamp(
    triggerRight - renderedWidth,
    safeMargin,
    Math.max(safeMargin, viewportW - safeMargin - renderedWidth),
  )
  const rawTop = placement === 'top'
    ? triggerTop - safeGap - renderedHeight
    : triggerBottom + safeGap
  const top = clamp(
    rawTop,
    safeMargin,
    Math.max(safeMargin, viewportH - safeMargin - renderedHeight),
  )

  return {
    placement,
    top,
    left,
    maxHeight: availableHeight,
    maxWidth: availableWidth,
  }
}
