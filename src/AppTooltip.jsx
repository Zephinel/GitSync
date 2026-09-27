import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  APP_TOOLTIP_DELAY_MS,
  getAppTooltipMaxWidth,
  getAppTooltipPointPosition,
  getAppTooltipPosition,
  getViewportSize,
} from './appTooltip.js'

// One floating-tooltip authority for the whole app.
//
// Hints are authored explicitly in source with `data-app-tooltip`, never with
// the browser-native `title`: a native tooltip is drawn by the web engine's
// chrome and cannot be themed, and `title` is also read as data elsewhere in
// this app. A single delegated listener turns the authored attribute into the
// shared `.app-tooltip` surface.
//
// Explicit hints follow the cursor (the pointer position when the delay
// expires), because their anchor is often a full-width container. The
// truncation-gated hints (branch-name rows and `CustomSelect`) hang on the
// element they document and portal into the same surface.

const APP_TOOLTIP_ATTRIBUTE = 'data-app-tooltip'
const TOOLTIP_SOURCE_SELECTOR = `[${APP_TOOLTIP_ATTRIBUTE}]`

function isElementNode(value) {
  return Boolean(value) && typeof value === 'object' && value.nodeType === 1
}

function isDomNode(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.nodeType === 'number'
}

// The single rendering surface. It measures itself once mounted, so positioning
// uses the real width/height instead of a worst-case max-width estimate.
export function AppTooltipSurface({ anchor = null, point = null, text }) {
  const surfaceRef = useRef(null)
  const [position, setPosition] = useState(null)
  const viewportWidth = getViewportSize().width

  useLayoutEffect(() => {
    const node = surfaceRef.current
    if (!node) return
    const size = { width: node.offsetWidth, height: node.offsetHeight, viewport: getViewportSize() }
    if (point) {
      setPosition(getAppTooltipPointPosition({ point, ...size }))
      return
    }
    if (!anchor?.isConnected) return
    setPosition(getAppTooltipPosition({ anchorRect: anchor.getBoundingClientRect(), ...size }))
  }, [anchor, point, text])

  if (typeof document === 'undefined') return null

  return createPortal((
    <div
      ref={surfaceRef}
      className="app-tooltip"
      role="tooltip"
      style={{
        top: `${position ? position.top : 0}px`,
        left: `${position ? position.left : 0}px`,
        maxWidth: `${getAppTooltipMaxWidth(viewportWidth)}px`,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {text}
    </div>
  ), document.body)
}

export default function AppTooltipLayer() {
  const [tooltip, setTooltip] = useState(null)
  const anchorRef = useRef(null)
  const pointRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const hide = () => {
      clearTimer()
      anchorRef.current = null
      pointRef.current = null
      setTooltip((previous) => (previous === null ? previous : null))
    }

    const schedule = (anchor, point) => {
      const text = String(anchor.getAttribute(APP_TOOLTIP_ATTRIBUTE) || '').trim()
      if (!text) return
      anchorRef.current = anchor
      pointRef.current = point
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (anchorRef.current !== anchor || !anchor.isConnected) return
        setTooltip({ text, anchor, point: pointRef.current })
      }, APP_TOOLTIP_DELAY_MS)
    }

    const handlePointerOver = (event) => {
      const target = isElementNode(event.target) ? event.target.closest(TOOLTIP_SOURCE_SELECTOR) : null
      if (!target) {
        const anchor = anchorRef.current
        if (anchor && !(isDomNode(event.target) && anchor.contains(event.target))) hide()
        return
      }
      if (target === anchorRef.current) return
      hide()
      schedule(target, { x: event.clientX, y: event.clientY })
    }

    // Keep the pending pointer position fresh while the delay runs, so a hint on
    // a wide container appears where the cursor actually is.
    const handlePointerMove = (event) => {
      const anchor = anchorRef.current
      if (!anchor) return
      if (isDomNode(event.target) && anchor.contains(event.target)) {
        pointRef.current = { x: event.clientX, y: event.clientY }
      }
    }

    const handlePointerOut = (event) => {
      const anchor = anchorRef.current
      if (!anchor) return
      if (isDomNode(event.relatedTarget) && anchor.contains(event.relatedTarget)) return
      hide()
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') hide()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') hide()
    }

    document.addEventListener('pointerover', handlePointerOver, true)
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerout', handlePointerOut, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    window.addEventListener('blur', hide)

    return () => {
      document.removeEventListener('pointerover', handlePointerOver, true)
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerout', handlePointerOut, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('blur', hide)
      hide()
    }
  }, [])

  if (!tooltip) return null

  return <AppTooltipSurface anchor={tooltip.anchor} point={tooltip.point} text={tooltip.text} />
}
