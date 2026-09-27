import { useCallback, useEffect, useRef, useState } from 'react'
import StashDetailView from '../StashDetailView.jsx'
import OverlayPortal from '../OverlayPortal.jsx'
import { OVERLAY_ID, OVERLAY_LEVEL } from '../overlayLayerContract.js'
import {
  acknowledgeStashOperation,
  invokeStashMutation,
  reconcileStashOperation,
  stashErrorMessage,
} from '../stashOperationClient.js'
import {
  dispatchStashOperationProjectionRefresh,
  stashOperationNeedsProjectionRefresh,
} from '../stashProjectionRefresh.js'
import { stashSnapshotHasCompleteStashList } from '../stashSnapshotCompleteness.js'
import useStashSnapshotState from '../useStashSnapshotState.js'
import {
  buildTargetStashRequest,
  createStashRequestId,
  findStashEntry,
} from '../stashViewModel.js'
import { CloseIcon, RefreshSyncIcon } from '../icons/CanonicalIcons.jsx'
import StashManagerList from './StashManagerList.jsx'
import { ConfirmationDialog, ResultPanel } from './StashOperationSurfaces.jsx'
import StashPendingOperations from './StashPendingOperations.jsx'
import {
  Spinner,
  trapTabKey,
} from './managerUtils.jsx'

const SUCCESS_TOAST_DURATION_MS = 5_000

function explicitFailure(operation, requestId, entry, error) {
  return {
    operation,
    requestId,
    status: error?.needsConfirmation === false ? 'failed' : 'needs_confirmation',
    mutated: false,
    needsConfirmation: error?.needsConfirmation !== false,
    worktreeChanged: false,
    createdStashId: null,
    targetStashId: entry?.id || null,
    applied: false,
    dropped: false,
    stashRetained: Boolean(entry),
    conflicts: [],
    warnings: [],
    errors: [stashErrorMessage(error)],
    snapshot: null,
    snapshotError: null,
    entryMessage: entry?.message || '',
    message: error?.needsConfirmation === false
      ? '操作未开始或已明确失败。'
      : '操作响应与状态确认均未完成；不会自动重试。',
  }
}

export default function StashManagerDialog({
  repoPath,
  repoName,
  initialStashId = null,
  initialOperation = null,
  overlayParentId = '',
  present = true,
  onClose,
  onExitComplete,
  onChanged,
}) {
  const dialogRef = useRef(null)
  const confirmDialogRef = useRef(null)
  const flightRef = useRef(false)
  const initialIntentConsumedRef = useRef(false)
  const {
    snapshot,
    loading,
    error: snapshotError,
    refresh: refreshSnapshot,
  } = useStashSnapshotState(repoPath)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useState(null)
  const [detailRefreshToken, setDetailRefreshToken] = useState(0)
  const [confirm, setConfirm] = useState(null)
  const [result, setResult] = useState(null)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const loadError = actionError || snapshotError

  const loadSnapshot = useCallback(async ({ refreshDetail = false, force = false } = {}) => {
    setActionError('')
    const next = await refreshSnapshot({ force })
    if (next && refreshDetail) setDetailRefreshToken((current) => current + 1)
    return next
  }, [refreshSnapshot])

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!snapshot) {
      setDetailId(null)
      setConfirm(null)
      return
    }
    if (stashSnapshotHasCompleteStashList(snapshot)) {
      if (detailId && !findStashEntry(snapshot, detailId)) setDetailId(null)
      if (confirm?.stashId && !findStashEntry(snapshot, confirm.stashId)) setConfirm(null)
    }
  }, [confirm?.stashId, detailId, snapshot])

  useEffect(() => {
    if (!confirm) return undefined
    confirmDialogRef.current?.focus({ preventScroll: true })
    return undefined
  }, [confirm])

  useEffect(() => {
    if (!result || !['complete', 'acknowledged'].includes(result.status)) return undefined
    const timer = window.setTimeout(() => setResult(null), SUCCESS_TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [result])

  useEffect(() => {
    if (!snapshot || initialIntentConsumedRef.current || !initialStashId) return
    const entry = findStashEntry(snapshot, initialStashId)
    if (!entry) return
    initialIntentConsumedRef.current = true
    setDetailId(initialStashId)
    if (['apply', 'pop', 'drop'].includes(initialOperation)) {
      setConfirm({ operation: initialOperation, stashId: initialStashId, entry })
    }
  }, [initialOperation, initialStashId, snapshot])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (busy || actionMenuOpen) return
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation?.()
        if (confirm) setConfirm(null)
        else onClose?.()
        return
      }
      trapTabKey(event, confirm ? confirmDialogRef.current : dialogRef.current)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [actionMenuOpen, busy, confirm, onClose])

  const applyOperationResult = useCallback((next, entry = null) => {
    const projected = {
      ...next,
      entryMessage: entry?.message || next.entryMessage || '',
    }
    setActionError('')
    setResult(projected)
    if (stashOperationNeedsProjectionRefresh(projected)) {
      setDetailRefreshToken((current) => current + 1)
    }
    dispatchStashOperationProjectionRefresh(onChanged, projected)
    if (projected.dropped && detailId === projected.targetStashId) setDetailId(null)
    return projected
  }, [detailId, onChanged])

  const runOperation = useCallback(async (operation, entry) => {
    if (flightRef.current || !snapshot?.snapshotId || !entry) return
    flightRef.current = true
    setBusy(true)
    setActionError('')
    const requestId = createStashRequestId(operation)
    try {
      const request = buildTargetStashRequest(snapshot, entry.id, requestId)
      const command = operation === 'apply'
        ? 'apply_repo_stash'
        : operation === 'pop'
          ? 'pop_repo_stash'
          : 'drop_repo_stash'
      const next = await invokeStashMutation({
        repoPath,
        operation,
        command,
        request,
        requestId,
      })
      applyOperationResult(next, entry)
    } catch (error) {
      const failure = explicitFailure(operation, requestId, entry, error)
      setResult(failure)
      dispatchStashOperationProjectionRefresh(onChanged, failure)
    } finally {
      setConfirm(null)
      setBusy(false)
      flightRef.current = false
    }
  }, [applyOperationResult, onChanged, repoPath, snapshot])

  const reconcilePending = useCallback(async (requestId) => {
    if (flightRef.current) return
    flightRef.current = true
    setBusy(true)
    setActionError('')
    try {
      applyOperationResult(await reconcileStashOperation(repoPath, requestId))
    } catch (error) {
      setActionError(stashErrorMessage(error))
    } finally {
      setBusy(false)
      flightRef.current = false
    }
  }, [applyOperationResult, repoPath])

  const acknowledgePending = useCallback(async (requestId) => {
    if (flightRef.current || !snapshot?.snapshotId) return
    flightRef.current = true
    setBusy(true)
    setActionError('')
    try {
      applyOperationResult(await acknowledgeStashOperation(
        repoPath,
        requestId,
        snapshot.snapshotId,
      ))
    } catch (error) {
      setActionError(stashErrorMessage(error))
    } finally {
      setBusy(false)
      flightRef.current = false
    }
  }, [applyOperationResult, repoPath, snapshot?.snapshotId])

  const requestAction = useCallback((operation, entry) => {
    if (!['apply', 'pop', 'drop'].includes(operation) || !entry?.id) return
    setConfirm({ operation, stashId: entry.id, entry })
  }, [])

  const selectedEntry = confirm?.stashId
    ? findStashEntry(snapshot, confirm.stashId)
      || (!stashSnapshotHasCompleteStashList(snapshot) ? confirm.entry || null : null)
    : null
  if (typeof document === 'undefined') return null

  const detailPanel = detailId ? (
    <StashDetailView
      repoPath={repoPath}
      stashId={detailId}
      busy={busy}
      refreshToken={detailRefreshToken}
      restoreDisabled={(snapshot?.conflictedFiles || 0) > 0}
      onAction={requestAction}
    />
  ) : null

  return (
    <OverlayPortal
      level={overlayParentId ? OVERLAY_LEVEL.dialog : OVERLAY_LEVEL.workspace}
      overlayId={OVERLAY_ID.stashManager}
      parentOverlayId={overlayParentId}
      present={present}
      onExitComplete={onExitComplete}
      onEscape={() => { if (!busy) onClose?.() }}
    >
      <div data-overlay-motion="backdrop" className="stash-manager-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose?.()
    }}>
      <section data-overlay-motion="surface" ref={dialogRef} className="stash-manager-dialog stash-manager-dialog--management" role="dialog" aria-modal="true" aria-labelledby="stash-manager-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="stash-manager-header stash-manager-header--redesign">
          <div className="stash-manager-header__identity">
            <div><span>Git Stash</span><h2 id="stash-manager-title">Stash 管理</h2><p data-app-tooltip={repoPath}>{repoName || '当前仓库'} · {repoPath}</p></div>
          </div>
          <div className="stash-manager-header__actions">
            <button type="button" className="stash-manager-icon-button" onClick={() => void loadSnapshot({ refreshDetail: true, force: true })} disabled={busy || loading} aria-label={loading ? '正在刷新 Stash' : '刷新 Stash'} data-app-tooltip="刷新">
              {loading ? <Spinner /> : <RefreshSyncIcon />}
            </button>
            <button type="button" className="stash-manager-icon-button" onClick={onClose} disabled={busy} aria-label="关闭 Stash 管理"><CloseIcon /></button>
          </div>
        </header>

        <ResultPanel result={result} onDismiss={() => setResult(null)} />

        <div className="stash-manager-redesign-body">
          {loadError ? <div className="stash-manager-load-error" role="alert"><strong>Stash 状态读取失败</strong><span>{loadError}</span><button type="button" onClick={() => void loadSnapshot({ refreshDetail: true, force: true })}><RefreshSyncIcon />重试</button></div> : null}
          {loading && !snapshot ? <div className="stash-manager-loading"><Spinner />正在读取 Stash 列表…</div> : null}

          <StashPendingOperations
            operations={snapshot?.pendingOperations || []}
            total={snapshot?.pendingOperationTotal || 0}
            truncated={snapshot?.pendingOperationsTruncated === true}
            currentRepoPath={snapshot?.repoPath || repoPath}
            busy={busy}
            hasSnapshotIdentity={Boolean(snapshot?.snapshotId)}
            onReconcile={(requestId) => void reconcilePending(requestId)}
            onAcknowledge={(requestId) => void acknowledgePending(requestId)}
          />

          {snapshot ? (
            <StashManagerList
              repoPath={repoPath}
              snapshot={snapshot}
              busy={busy}
              selectedStashId={detailId}
              detailPanel={detailPanel}
              onOpenDetail={setDetailId}
              onRequestAction={requestAction}
              onMenuOpenChange={setActionMenuOpen}
            />
          ) : null}
        </div>
      </section>

      <ConfirmationDialog
        present={Boolean(confirm && selectedEntry)}
        dialogRef={confirmDialogRef}
        operation={confirm?.operation}
        entry={selectedEntry}
        snapshot={snapshot}
        busy={busy}
        onCancel={() => !busy && setConfirm(null)}
        onConfirm={() => selectedEntry && void runOperation(confirm.operation, selectedEntry)}
      />
      </div>
    </OverlayPortal>
  )
}
