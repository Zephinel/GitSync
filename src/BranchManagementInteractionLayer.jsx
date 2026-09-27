import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  getActiveBranchOperationPaths,
  getBranchOperationRevision,
  subscribeBranchOperations,
} from './branchDomainStore.js'
import {
  areBranchOperationOverlayLayoutsEqual,
  collectBranchOperationOverlays,
  getLockedBranchAttentionPath,
} from './branchManagementOperationOverlay.js'
import './BranchManagementInteractionLayer.css'

function BranchOperationOverlay({ overlay, onNode }) {
  return (
    <div
      ref={(node) => onNode(overlay.repoPath, node)}
      className="branch-management-operation-overlay"
      data-branch-operation-path={overlay.repoPath}
      style={overlay.style}
      role="status"
      tabIndex={0}
      aria-live="polite"
      aria-label={`${overlay.repoName} 分支状态更新中`}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <span className="branch-management-operation-overlay__spinner" aria-hidden="true" />
      <span>更新中…</span>
    </div>
  )
}

export default function BranchManagementInteractionLayer() {
  const operationRevision = useSyncExternalStore(
    subscribeBranchOperations,
    getBranchOperationRevision,
    getBranchOperationRevision
  )
  const [overlays, setOverlays] = useState([])
  const updateFrameRef = useRef(0)
  const resizeObserverRef = useRef(null)
  const overlayNodesByPathRef = useRef(new Map())

  const registerOverlayNode = useCallback((repoPath, node) => {
    if (!repoPath) return
    if (node) overlayNodesByPathRef.current.set(repoPath, node)
    else overlayNodesByPathRef.current.delete(repoPath)
  }, [])

  const updateOverlays = useCallback(() => {
    updateFrameRef.current = 0
    if (typeof document === 'undefined') {
      setOverlays([])
      return
    }
    const next = collectBranchOperationOverlays(document, getActiveBranchOperationPaths())
    resizeObserverRef.current?.disconnect()
    next.forEach((overlay) => resizeObserverRef.current?.observe(overlay.element))
    setOverlays((previous) => (
      areBranchOperationOverlayLayoutsEqual(previous, next) ? previous : next
    ))
  }, [])

  const scheduleUpdate = useCallback(() => {
    if (updateFrameRef.current || typeof window === 'undefined') return
    updateFrameRef.current = window.requestAnimationFrame(updateOverlays)
  }, [updateOverlays])

  useLayoutEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined
    const activePaths = getActiveBranchOperationPaths()
    if (activePaths.size === 0) {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      overlayNodesByPathRef.current.clear()
      setOverlays([])
      return undefined
    }

    const blockActiveAttentionInteraction = (event) => {
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
      const repoPath = getLockedBranchAttentionPath(event.target, activePaths)
      if (!repoPath) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()

      if (event.type === 'focusin') {
        overlayNodesByPathRef.current.get(repoPath)?.focus({ preventScroll: true })
      }
    }

    resizeObserverRef.current = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(scheduleUpdate)
      : null

    scheduleUpdate()
    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('scroll', scheduleUpdate, true)
    document.addEventListener('click', blockActiveAttentionInteraction, true)
    document.addEventListener('keydown', blockActiveAttentionInteraction, true)
    document.addEventListener('focusin', blockActiveAttentionInteraction, true)

    const observer = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(scheduleUpdate)
      : null
    observer?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => {
      if (updateFrameRef.current) window.cancelAnimationFrame(updateFrameRef.current)
      updateFrameRef.current = 0
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('scroll', scheduleUpdate, true)
      document.removeEventListener('click', blockActiveAttentionInteraction, true)
      document.removeEventListener('keydown', blockActiveAttentionInteraction, true)
      document.removeEventListener('focusin', blockActiveAttentionInteraction, true)
      observer?.disconnect()
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      overlayNodesByPathRef.current.clear()
    }
  }, [operationRevision, scheduleUpdate])

  if (overlays.length === 0 || typeof document === 'undefined') return null

  return createPortal((
    <>
      {overlays.map((overlay) => (
        <BranchOperationOverlay
          key={overlay.key}
          overlay={overlay}
          onNode={registerOverlayNode}
        />
      ))}
    </>
  ), document.body)
}
