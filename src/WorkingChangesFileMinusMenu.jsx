import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { computeFloatingMenuPosition } from './stashFloatingMenuPosition.js'
import { FILE_CELL_MINUS } from './stagingViewModel.js'
import './WorkingChangesFileMinusMenu.css'

/*
 * Secondary-action entry for a consolidated mixed file cell. The minus button
 * itself is never an operation; this menu resolves to the existing unstage /
 * discard-unstaged operations only.
 *
 * Escape ownership stays with the overlay stack (the Working Changes layer
 * closes this menu before the layer itself), so no document-level Escape
 * listener is registered here. Focus moves into the first item on open and
 * returns to the trigger when the menu is dismissed without picking.
 */
export default function WorkingChangesFileMinusMenu({
  file,
  anchor,
  busy = false,
  onClose,
  onPick,
}) {
  const rootRef = useRef(null)
  const pickedRef = useRef(false)
  const [floatingPosition, setFloatingPosition] = useState(null)

  const updateFloatingPosition = useCallback(() => {
    if (typeof window === 'undefined') return
    const anchorNode = anchor
    const panel = rootRef.current
    if (!anchorNode || !panel) return

    const panelRect = panel.getBoundingClientRect()
    const next = computeFloatingMenuPosition({
      triggerRect: anchorNode.getBoundingClientRect(),
      menuRect: {
        width: panelRect.width,
        height: Math.max(panel.scrollHeight, panelRect.height),
      },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredPlacement: 'bottom',
      gap: 6,
      margin: 8,
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
  }, [anchor])

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !anchor) return undefined

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
  }, [anchor, updateFloatingPosition])

  useLayoutEffect(() => {
    rootRef.current?.querySelector('[role="menuitem"]')?.focus()
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onPointerDown = (event) => {
      const insideMenu = rootRef.current?.contains(event.target)
      const insideAnchor = anchor?.contains(event.target)
      if (!insideMenu && !insideAnchor) onClose?.()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [anchor, onClose])

  useEffect(() => {
    return () => {
      if (!pickedRef.current && anchor?.isConnected) anchor.focus()
    }
  }, [anchor])

  const handleMenuKeyDown = (event) => {
    if (!rootRef.current) return
    const items = [...rootRef.current.querySelectorAll('[role="menuitem"]')]
    if (items.length === 0) return
    const currentIndex = items.indexOf(document.activeElement)
    let nextIndex = -1
    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
    else if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    else return
    event.preventDefault()
    items[nextIndex].focus()
  }

  if (typeof document === 'undefined') return null

  const pick = (operation) => {
    pickedRef.current = true
    onClose?.()
    onPick?.(operation)
  }

  return createPortal((
    <div
      ref={rootRef}
      className={`working-changes-file-minus-menu working-changes-file-minus-menu--${floatingPosition?.placement || 'bottom'}`}
      role="menu"
      aria-label={`${file?.path || '文件'} 减除操作`}
      onKeyDown={handleMenuKeyDown}
      style={floatingPosition ? {
        top: floatingPosition.top,
        left: floatingPosition.left,
        maxHeight: floatingPosition.maxHeight,
        maxWidth: floatingPosition.maxWidth,
      } : undefined}
    >
      <button
        type="button"
        className="working-changes-file-minus-menu__item"
        role="menuitem"
        disabled={busy}
        onClick={() => pick(FILE_CELL_MINUS.unstage)}
      >
        <strong>取消暂存</strong>
        <small>保留文件内容</small>
      </button>
      <button
        type="button"
        className="working-changes-file-minus-menu__item working-changes-file-minus-menu__item--danger"
        role="menuitem"
        disabled={busy}
        onClick={() => pick(FILE_CELL_MINUS.discardUnstaged)}
      >
        <strong>丢弃未暂存改动</strong>
        <small>已暂存内容保持不变</small>
      </button>
    </div>
  ), document.body)
}
