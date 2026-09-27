import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import StashEntryActionMenu from './StashEntryActionMenu.jsx'
import DirectionalChevronIcon from './icons/DirectionalChevronIcon.jsx'
import { RefreshSyncIcon, StashIcon } from './icons/CanonicalIcons.jsx'
import { computeFloatingMenuPosition } from './stashFloatingMenuPosition.js'
import { formatStashRelativeDate } from './stashRelativeTime.js'
import useStashSnapshotState from './useStashSnapshotState.js'
import useStashFileCounts from './useStashFileCounts.js'
import { Spinner } from './stash-manager/managerUtils.jsx'

function isStashActionMenuLayerTarget(target) {
  return target instanceof Element
    && Boolean(target.closest('[data-stash-entry-action-menu-layer="true"]'))
}

export default function StashManagementPopover({
  repoPath,
  anchorRef,
  onClose,
  onOpenManager,
}) {
  const rootRef = useRef(null)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [floatingPosition, setFloatingPosition] = useState(null)
  const {
    snapshot,
    loading,
    error,
    refresh,
  } = useStashSnapshotState(repoPath)

  const recent = snapshot?.stashes?.slice(0, 3) || []
  const fileCounts = useStashFileCounts(repoPath, recent)
  const restoreBlocked = (snapshot?.conflictedFiles || 0) > 0

  const updateFloatingPosition = useCallback(() => {
    if (typeof window === 'undefined') return
    const anchor = anchorRef?.current
    const panel = rootRef.current
    if (!anchor || !panel) return

    const panelRect = panel.getBoundingClientRect()
    const next = computeFloatingMenuPosition({
      triggerRect: anchor.getBoundingClientRect(),
      menuRect: {
        width: panelRect.width,
        height: Math.max(panel.scrollHeight, panelRect.height),
      },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredPlacement: 'bottom',
      gap: 7,
      margin: 12,
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
  }, [anchorRef])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined

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
  }, [error, loading, recent.length, updateFloatingPosition])

  useEffect(() => {
    const onPointerDown = (event) => {
      const insidePopover = rootRef.current?.contains(event.target)
      const insideAnchor = anchorRef?.current?.contains(event.target)
      if (!insidePopover && !insideAnchor && !isStashActionMenuLayerTarget(event.target)) {
        onClose?.()
      }
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || actionMenuOpen) return
      onClose?.()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [actionMenuOpen, anchorRef, onClose])

  const open = (intent = {}) => {
    onClose?.()
    onOpenManager?.(intent)
  }

  if (typeof document === 'undefined') return null

  return createPortal((
    <section
      ref={rootRef}
      className={`stash-management-popover stash-management-popover--viewport stash-management-popover--${floatingPosition?.placement || 'bottom'}`}
      role="menu"
      aria-label="Stash 管理菜单"
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
      <header className="stash-management-popover__header">
        <strong>Stash 管理</strong>
        <button
          type="button"
          className="stash-management-popover__refresh"
          disabled={loading}
          aria-label={loading ? '正在刷新 Stash' : '刷新 Stash'}
          data-app-tooltip={loading ? '刷新中…' : '刷新'}
          onClick={() => void refresh({ force: true })}
        >
          {loading ? <Spinner /> : <RefreshSyncIcon />}
        </button>
      </header>

      <div className="stash-management-popover__body">
        {loading && !snapshot ? (
          <div className="stash-management-popover__state"><Spinner /><span>正在读取 Stash…</span></div>
        ) : null}
        {error ? (
          <div className="stash-management-popover__error" role="alert">
            <strong>读取失败</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {!loading && !error && recent.length === 0 ? (
          <div className="stash-management-popover__empty">
            <span className="stash-management-popover__empty-icon"><StashIcon /></span>
            <div className="stash-management-popover__empty-copy">
              <strong>暂无 Stash</strong>
              <span>当前仓库还没有已保存的条目。</span>
            </div>
          </div>
        ) : null}

        {recent.length > 0 ? (
          <div className="stash-management-popover__list">
            {recent.map((entry, index) => {
              const count = fileCounts[entry.id]
              const countText = Number.isFinite(count)
                ? `${count} 个文件`
                : entry.scopeSummary || '文件数读取中…'
              const relativeDate = formatStashRelativeDate(entry.createdAt)
              return (
                <article key={entry.id} className="stash-management-popover__item">
                  <button type="button" role="menuitem" className="stash-management-popover__identity" onClick={() => open({ stashId: entry.id })}>
                    <strong data-app-tooltip={entry.message}>{entry.message}</strong>
                    <span data-app-tooltip={`${entry.branchContext || '分支未知'} · ${relativeDate} · ${countText}`}>
                      {entry.branchContext || '分支未知'} · {relativeDate} · {countText}
                    </span>
                  </button>
                  <StashEntryActionMenu
                    entry={entry}
                    placement={index === recent.length - 1 ? 'top' : 'bottom'}
                    restoreDisabled={restoreBlocked}
                    onOpenChange={setActionMenuOpen}
                    onApply={() => open({ stashId: entry.id, operation: 'apply' })}
                    onPop={() => open({ stashId: entry.id, operation: 'pop' })}
                    onViewDetails={() => open({ stashId: entry.id })}
                    onDrop={() => open({ stashId: entry.id, operation: 'drop' })}
                  />
                </article>
              )
            })}
          </div>
        ) : null}
      </div>

      <footer className="stash-management-popover__footer">
        <button type="button" role="menuitem" onClick={() => open({})}>
          <span>查看全部 Stash…</span>
          <DirectionalChevronIcon />
        </button>
      </footer>
    </section>
  ), document.body)
}
