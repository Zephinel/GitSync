import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getOverlayLaneId } from './overlayLayerContract.js'
import {
  claimOverlayStackOrder,
  registerOverlayStackElement,
  releaseOverlayStackEntry,
  updateOverlayStackEntry,
} from './overlayStack.js'

const PRESENCE = Object.freeze({
  entering: 'entering',
  open: 'open',
  exiting: 'exiting',
  unmounted: 'unmounted',
})

const EXIT_SAFETY_TIMEOUT_MS = 1200

function activeExitAnimations(slot) {
  if (!slot?.querySelectorAll) return []
  return [...slot.querySelectorAll('[data-overlay-motion]')].flatMap((target) => (
    target.getAnimations?.() || []
  )).filter((animation) => {
    const endTime = animation.effect?.getComputedTiming?.().endTime
    return animation.playState !== 'finished' && Number.isFinite(endTime) && endTime > 0
  })
}

export default function OverlayPortal({
  level,
  overlayId,
  parentOverlayId = '',
  present = true,
  onExitComplete,
  onEscape,
  children,
}) {
  const [presence, setPresence] = useState(() => present ? PRESENCE.entering : PRESENCE.unmounted)
  const retainedChildrenRef = useRef(children)
  const slotRef = useRef(null)
  const contentRef = useRef(null)
  const presentRef = useRef(present)
  const presenceRef = useRef(presence)
  const onExitCompleteRef = useRef(onExitComplete)
  const onEscapeRef = useRef(onEscape)
  const stackKeyRef = useRef({})
  const stackOrderRef = useRef(0)
  const wasExitingRef = useRef(false)
  const [stackOrder, setStackOrder] = useState(0)
  const useCurrentChildren = present || children != null
  const renderedChildren = useCurrentChildren ? children : retainedChildrenRef.current
  const handleOverlayEscape = () => {
    if (presenceRef.current === PRESENCE.exiting) return
    onEscapeRef.current?.()
  }

  useLayoutEffect(() => {
    presentRef.current = present
    presenceRef.current = presence
    onExitCompleteRef.current = onExitComplete
    onEscapeRef.current = onEscape
    if (useCurrentChildren) retainedChildrenRef.current = children
  }, [children, onEscape, onExitComplete, presence, present, useCurrentChildren])

  useLayoutEffect(() => {
    setPresence((current) => {
      if (present) {
        if (current === PRESENCE.unmounted) return PRESENCE.entering
        if (current === PRESENCE.exiting) return PRESENCE.open
        return current
      }
      return current === PRESENCE.entering || current === PRESENCE.open
        ? PRESENCE.exiting
        : current
    })
  }, [present])

  useLayoutEffect(() => {
    const stackKey = stackKeyRef.current
    if (present && (!stackOrderRef.current || wasExitingRef.current)) {
      const nextOrder = claimOverlayStackOrder(stackKey, {
        level,
        overlayId,
        parentOverlayId,
        onEscape: handleOverlayEscape,
      })
      stackOrderRef.current = nextOrder
      setStackOrder(nextOrder)
      wasExitingRef.current = false
    }

    registerOverlayStackElement(stackKey, slotRef.current, contentRef.current)
    updateOverlayStackEntry(stackKey, {
      active: presence === PRESENCE.entering || presence === PRESENCE.open,
      transitioning: presence === PRESENCE.exiting,
      onEscape: handleOverlayEscape,
    })

    if (presence === PRESENCE.exiting) wasExitingRef.current = true
    if (presence === PRESENCE.unmounted) {
      releaseOverlayStackEntry(stackKey)
      stackOrderRef.current = 0
      setStackOrder(0)
      wasExitingRef.current = false
    }
  }, [level, overlayId, presence, present])

  useEffect(() => () => {
    releaseOverlayStackEntry(stackKeyRef.current)
  }, [])

  useEffect(() => {
    if (presence !== PRESENCE.entering) return undefined
    const frame = window.requestAnimationFrame(() => {
      if (!presentRef.current) return
      setPresence((current) => current === PRESENCE.entering ? PRESENCE.open : current)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [presence])

  useEffect(() => {
    if (presence !== PRESENCE.exiting) return undefined
    let cancelled = false
    let fallback = 0

    const finish = () => {
      if (cancelled || presentRef.current || presenceRef.current !== PRESENCE.exiting) return
      presenceRef.current = PRESENCE.unmounted
      setPresence(PRESENCE.unmounted)
      onExitCompleteRef.current?.()
    }

    const frame = window.requestAnimationFrame(() => {
      const animations = activeExitAnimations(slotRef.current)
      if (animations.length === 0) {
        finish()
        return
      }
      fallback = window.setTimeout(finish, EXIT_SAFETY_TIMEOUT_MS)
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish)
    })

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      if (fallback) window.clearTimeout(fallback)
    }
  }, [presence])

  if (typeof document === 'undefined') return null
  if (presence === PRESENCE.unmounted) return null
  const lane = document.getElementById(getOverlayLaneId(level))
  if (!lane) throw new Error(`Overlay lane is not mounted: ${level}`)

  return createPortal(
    <div
      ref={slotRef}
      className="app-overlay-slot"
      data-overlay-level={level}
      data-overlay-id={overlayId || undefined}
      data-overlay-parent={parentOverlayId || undefined}
      data-overlay-presence={presence}
      data-overlay-stack-order={stackOrder || undefined}
      style={stackOrder ? { '--overlay-slot-z-index': stackOrder } : undefined}
    >
      <div ref={contentRef} className="app-overlay-slot__content">
        {renderedChildren}
      </div>
    </div>,
    lane
  )
}
