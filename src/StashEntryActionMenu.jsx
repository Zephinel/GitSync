import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ApplyAndDropIcon,
  CheckIcon,
  DeleteIcon,
  InfoIcon,
  MoreIcon,
  ViewIcon,
} from './icons/CanonicalIcons.jsx'
import { computeFloatingMenuPosition } from './stashFloatingMenuPosition.js'

function focusableMenuItems(panel) {
  if (!panel) return []
  return [...panel.querySelectorAll('button[role="menuitem"]:not(:disabled)')]
}

export default function StashEntryActionMenu({
  entry,
  disabled = false,
  busy = false,
  restoreDisabled = false,
  restoreDisabledReason = '工作区存在未解决冲突，暂时不能应用 Stash。',
  placement = 'bottom',
  open: controlledOpen,
  onOpenChange,
  onClose,
  onApply,
  onPop,
  onViewDetails,
  onView,
  onDrop,
  onAction,
}) {
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const focusedOpenRef = useRef(false)
  const [internalOpen, setInternalOpen] = useState(false)
  const [floatingPosition, setFloatingPosition] = useState(null)
  const controlled = typeof controlledOpen === 'boolean'
  const open = controlled ? controlledOpen : internalOpen
  const normalizedPlacement = placement === 'top' || placement === 'above' ? 'top' : 'bottom'

  const setOpen = useCallback((next) => {
    if (!controlled) setInternalOpen(next)
    onOpenChange?.(next)
    if (!next) onClose?.()
  }, [controlled, onClose, onOpenChange])

  const updateFloatingPosition = useCallback(() => {
    if (!open || typeof window === 'undefined') return
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return
    const panelRect = panel.getBoundingClientRect()
    const next = computeFloatingMenuPosition({
      triggerRect: trigger.getBoundingClientRect(),
      menuRect: {
        width: panelRect.width,
        height: Math.max(panel.scrollHeight, panelRect.height),
      },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredPlacement: normalizedPlacement,
    })
    setFloatingPosition((current) => (
      current
      && current.placement === next.placement
      && current.top === next.top
      && current.left === next.left
      && current.maxHeight === next.maxHeight
      && current.maxWidth === next.maxWidth
        ? current
        : next
    ))
  }, [normalizedPlacement, open])

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') {
      setFloatingPosition(null)
      focusedOpenRef.current = false
      return undefined
    }

    let frame = 0
    const schedulePosition = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateFloatingPosition)
    }

    updateFloatingPosition()
    window.addEventListener('resize', schedulePosition)
    document.addEventListener('scroll', schedulePosition, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedulePosition)
      document.removeEventListener('scroll', schedulePosition, true)
    }
  }, [open, restoreDisabled, restoreDisabledReason, updateFloatingPosition])

  useEffect(() => {
    if (!open || !floatingPosition || focusedOpenRef.current) return undefined
    focusedOpenRef.current = true
    const first = focusableMenuItems(panelRef.current)[0]
    first?.focus({ preventScroll: true })
    return undefined
  }, [floatingPosition, open])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      const insideTrigger = rootRef.current?.contains(event.target)
      const insidePanel = panelRef.current?.contains(event.target)
      if (!insideTrigger && !insidePanel) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, setOpen])

  useEffect(() => {
    if (disabled || busy) setOpen(false)
  }, [busy, disabled, setOpen])

  const onMenuKeyDown = (event) => {
    const items = focusableMenuItems(panelRef.current)
    if (items.length === 0) return
    const currentIndex = items.indexOf(document.activeElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = currentIndex < 0
        ? 0
        : (currentIndex + delta + items.length) % items.length
      items[nextIndex]?.focus({ preventScroll: true })
      return
    }
    if (event.key !== 'Tab') return
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus({ preventScroll: true })
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus({ preventScroll: true })
    }
  }

  const run = (operation, callback) => {
    setOpen(false)
    if (callback) callback()
    else if (operation) onAction?.(operation, entry)
  }
  const label = entry?.message || 'Stash'
  const panel = open && typeof document !== 'undefined' ? createPortal((
    <div
      ref={panelRef}
      data-stash-entry-action-menu-layer="true"
      className={`stash-entry-action-menu__panel stash-entry-action-menu__panel--${floatingPosition?.placement || normalizedPlacement}`}
      role="menu"
      aria-label={`${label} 的操作`}
      onKeyDown={onMenuKeyDown}
      style={floatingPosition ? {
        top: `${floatingPosition.top}px`,
        left: `${floatingPosition.left}px`,
        maxHeight: `${floatingPosition.maxHeight}px`,
        maxWidth: `${floatingPosition.maxWidth}px`,
        visibility: 'visible',
      } : {
        top: 0,
        left: 0,
        visibility: 'hidden',
      }}
    >
      {restoreDisabled ? <div className="stash-entry-action-menu__notice" role="note"><InfoIcon /><span>{restoreDisabledReason}</span></div> : null}
      <button type="button" role="menuitem" disabled={restoreDisabled} onClick={() => run('apply', onApply)}><CheckIcon /><span>应用</span></button>
      <button type="button" role="menuitem" disabled={restoreDisabled} onClick={() => run('pop', onPop)}><ApplyAndDropIcon /><span>应用并删除</span></button>
      <button type="button" role="menuitem" onClick={() => run(null, onViewDetails || onView)}><ViewIcon /><span>查看详情</span></button>
      <div className="stash-entry-action-menu__separator stash-entry-action-menu__divider" role="separator" />
      <button type="button" role="menuitem" className="stash-entry-action-menu__danger" onClick={() => run('drop', onDrop)}><DeleteIcon /><span>删除 Stash</span></button>
    </div>
  ), document.body) : null

  return (
    <div ref={rootRef} className="stash-entry-action-menu">
      <button
        ref={triggerRef}
        type="button"
        className="stash-entry-action-menu__trigger"
        disabled={disabled || busy}
        aria-label={`${label} 的操作菜单`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreIcon />
      </button>
      {panel}
    </div>
  )
}
