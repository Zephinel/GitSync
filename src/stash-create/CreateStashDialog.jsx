import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import OverlayPortal from '../OverlayPortal.jsx'
import { OVERLAY_ID, OVERLAY_LEVEL } from '../overlayLayerContract.js'
import { CloseIcon } from '../icons/CanonicalIcons.jsx'
import {
  dispatchStashOperationProjectionRefresh,
  dispatchStashProjectionRefresh,
} from '../stashProjectionRefresh.js'
import useStashSnapshotState from '../useStashSnapshotState.js'
import { canCreateStash, stashKeepIndexAvailability } from '../stashViewModel.js'
import {
  buildScopeUnstageTargets,
  normalizeSelectedStashTargets,
  projectResolvedScopeTargets,
  selectedStashUnsupportedSummary,
} from '../stashScopeResolution.js'
import CreateStashForm from './CreateStashForm.jsx'
import { messageOf, runCreateStashMutation } from './createStashMutation.js'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'
const CREATE_RESULT_NOT_VISIBLE_WARNING = 'Git 已返回创建完成，但最新 Stash 列表尚未确认新条目。为避免重复保存其他改动，本窗口已锁定再次创建。'

function Spinner() { return <span className="stash-manager-spinner" aria-hidden="true" /> }

function trapTab(event, root) {
  if (event.key !== 'Tab' || !root) return
  const items = Array.from(root.querySelectorAll(FOCUSABLE)).filter((item) => item instanceof HTMLElement && item.offsetParent !== null)
  if (items.length === 0) return
  if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus() }
  else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus() }
}

function isConfirmedCreateResult(result) {
  const createdStashId = String(result?.createdStashId || '').trim()
  return result?.status === 'complete'
    && result?.needsConfirmation !== true
    && Boolean(createdStashId)
    && Boolean(result?.snapshot?.stashes?.some((entry) => entry.id === createdStashId))
}

function shouldLockCreateReplay(result) {
  return Boolean(
    result?.mutated
    || result?.worktreeChanged
    || result?.createdStashId
    || result?.needsConfirmation
    || ['complete', 'partial', 'conflict', 'acknowledged'].includes(result?.status)
  )
}

function guardCompletedCreateResult(result) {
  if (result?.status !== 'complete' || isConfirmedCreateResult(result)) return result
  const warnings = Array.from(new Set([...(result?.warnings || []), CREATE_RESULT_NOT_VISIBLE_WARNING]))
  return {
    ...result,
    status: 'needs_confirmation',
    needsConfirmation: true,
    warnings,
    message: CREATE_RESULT_NOT_VISIBLE_WARNING,
  }
}

export default function CreateStashDialog({ repoPath, repoName, files = [], present = true, onClose, onExitComplete, onChanged }) {
  const dialogRef = useRef(null)
  const runningRef = useRef(false)
  const [initialTargets] = useState(() => normalizeSelectedStashTargets(files))
  const [scopeMode, setScopeMode] = useState(() => initialTargets.length ? 'selected' : 'all')
  const [resolvedTargets, setResolvedTargets] = useState(null)
  const targets = resolvedTargets || initialTargets
  const selectedScope = scopeMode === 'selected' && targets.length > 0
  const operationTargets = selectedScope ? targets : []
  const selectedUntrackedCount = operationTargets.filter((file) => file.isUntracked).length
  const {
    snapshot,
    loading,
    error: snapshotError,
    refresh: refreshSnapshot,
  } = useStashSnapshotState(repoPath)
  const [actionError, setActionError] = useState('')
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [keepIndex, setKeepIndex] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [mutationLocked, setMutationLocked] = useState(false)
  const [confirmingUnstage, setConfirmingUnstage] = useState(false)
  const [resolutionBusy, setResolutionBusy] = useState(false)
  const [resolutionError, setResolutionError] = useState('')
  const [resolutionNotice, setResolutionNotice] = useState('')
  const loadError = actionError || snapshotError

  const effectiveIncludeUntracked = selectedScope ? selectedUntrackedCount > 0 : includeUntracked
  const unsupported = useMemo(() => selectedScope ? selectedStashUnsupportedSummary(operationTargets) : null, [operationTargets, selectedScope])
  const keepIndexAvailability = useMemo(() => stashKeepIndexAvailability(snapshot, operationTargets, includeUntracked), [includeUntracked, operationTargets, snapshot])

  const loadSnapshot = useCallback(async ({ force = false } = {}) => {
    setActionError('')
    return refreshSnapshot({ force })
  }, [refreshSnapshot])

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (snapshot) return
    setConfirming(false)
    setConfirmingUnstage(false)
  }, [snapshot])

  useEffect(() => { if (!keepIndexAvailability.available && keepIndex) setKeepIndex(false) }, [keepIndex, keepIndexAvailability.available])
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (busy || resolutionBusy) return
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.()
        if (confirmingUnstage) setConfirmingUnstage(false)
        else if (confirming) setConfirming(false)
        else onClose?.()
        return
      }
      trapTab(event, dialogRef.current)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [busy, confirming, confirmingUnstage, onClose, resolutionBusy])

  const executable = !mutationLocked && !unsupported && canCreateStash(snapshot, effectiveIncludeUntracked, operationTargets, keepIndex)

  const execute = useCallback(async () => {
    if (runningRef.current || mutationLocked || !snapshot?.snapshotId) return
    runningRef.current = true
    setBusy(true)
    setActionError('')
    let closeAfterSettle = false
    try {
      let next = await runCreateStashMutation({
        repoPath,
        snapshot,
        selectedScope,
        message,
        includeUntracked: effectiveIncludeUntracked,
        keepIndex,
        files: operationTargets,
      })
      next = guardCompletedCreateResult(next)
      setResult(next)
      if (shouldLockCreateReplay(next)) setMutationLocked(true)
      dispatchStashOperationProjectionRefresh(onChanged, next)
      closeAfterSettle = isConfirmedCreateResult(next)
      if (closeAfterSettle) setMessage('')
    } catch (error) {
      setActionError(messageOf(error))
    } finally {
      setConfirming(false)
      setBusy(false)
      runningRef.current = false
      if (closeAfterSettle) onClose?.()
    }
  }, [effectiveIncludeUntracked, keepIndex, message, mutationLocked, onChanged, onClose, operationTargets, repoPath, selectedScope, snapshot])

  const switchAll = () => {
    if (resolutionBusy || mutationLocked) return
    setScopeMode('all')
    setKeepIndex(false)
    setConfirming(false)
    setConfirmingUnstage(false)
    setResolutionError('')
    setResolutionNotice('已切换为 Stash 全部改动；暂存区尚未修改。')
  }

  const resolveUnstage = useCallback(async () => {
    if (resolutionBusy || mutationLocked || !operationTargets.length) return
    setResolutionBusy(true)
    setResolutionError('')
    setResolutionNotice('')
    try {
      const [staging, workingSummary] = await Promise.all([
        invoke('get_repo_staging_snapshot', { repoPath }),
        invoke('get_repo_working_diff_summary', { repoPath }),
      ])
      const unstageTargets = buildScopeUnstageTargets(staging, operationTargets, workingSummary?.files)
      const response = await invoke('unstage_repo_files', {
        repoPath,
        files: unstageTargets,
        expectedSnapshotId: staging?.snapshot_id || staging?.snapshotId,
      })
      if (response?.status !== 'complete' || response?.needs_confirmation || response?.needsConfirmation) {
        throw new Error(response?.message || '取消暂存结果未能明确确认为完成；不会继续创建 Stash。')
      }
      const nextStaging = response?.snapshot || await invoke('get_repo_staging_snapshot', { repoPath })
      setResolvedTargets(projectResolvedScopeTargets(nextStaging, operationTargets))
      setScopeMode('selected')
      setConfirmingUnstage(false)
      setKeepIndex(false)
      setResolutionNotice(`已取消 ${unstageTargets.length} 个条目的暂存状态。文件内容保持不变，可以继续创建文件级 Stash。`)
      await loadSnapshot({ force: true })
      dispatchStashProjectionRefresh(onChanged, response)
    } catch (error) {
      setResolutionError(messageOf(error))
    } finally {
      setResolutionBusy(false)
    }
  }, [loadSnapshot, mutationLocked, onChanged, operationTargets, repoPath, resolutionBusy])

  if (typeof document === 'undefined') return null
  const scopeTitle = selectedScope ? `所选 ${operationTargets.length} 个文件` : '全部当前改动'
  const blockedReason = snapshot?.conflictedFiles > 0
    ? '存在未解决冲突，不能创建 Stash。'
    : !snapshot?.headHash
      ? '仓库尚无首个提交，不能创建标准 Stash。'
      : keepIndex && !keepIndexAvailability.available
        ? keepIndexAvailability.reason
        : selectedScope
          ? '所选文件当前没有可安全保存的范围，请刷新后重新选择。'
          : snapshot?.hasUntrackedChanges && !snapshot?.hasTrackedChanges && !includeUntracked
            ? '当前只有未跟踪文件，请明确开启包含未跟踪文件。'
            : '当前范围没有可保存内容，不会创建空 Stash。'

  return (
    <OverlayPortal
      level={OVERLAY_LEVEL.dialog}
      overlayId={OVERLAY_ID.createStash}
      parentOverlayId={OVERLAY_ID.workingChanges}
      present={present}
      onExitComplete={onExitComplete}
      onEscape={() => { if (!busy && !resolutionBusy) onClose?.() }}
    >
      <div data-overlay-motion="backdrop" className="stash-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy && !resolutionBusy) onClose?.() }}>
        <section data-overlay-motion="surface" ref={dialogRef} className="stash-manager-dialog create-stash-dialog" role="dialog" aria-modal="true" aria-labelledby="create-stash-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header className="stash-manager-header create-stash-header">
        <div><span>Git Stash</span><h2 id="create-stash-title">创建 Stash</h2><p>{repoName || '当前仓库'} · {scopeTitle}</p></div>
        <div className="stash-manager-header__actions">
          <button
            type="button"
            className="stash-manager-icon-button"
            disabled={busy || resolutionBusy}
            onClick={onClose}
            aria-label="关闭创建 Stash"
            data-app-tooltip="关闭"
          >
            <CloseIcon />
          </button>
        </div>
      </header>
      {loading ? <div className="create-stash-state"><Spinner />正在读取仓库状态…</div> : null}
      {loadError ? <div className="create-stash-error" role="alert">{loadError}</div> : null}
      {!loading && snapshot ? <CreateStashForm snapshot={snapshot} result={result} scopeTitle={scopeTitle} selectedScope={selectedScope} targets={operationTargets} selectedUntrackedCount={selectedUntrackedCount} resolutionNotice={resolutionNotice} unsupported={unsupported} resolutionBusy={resolutionBusy} resolutionError={resolutionError} confirmingUnstage={confirmingUnstage} onSwitchAll={switchAll} onRequestUnstage={() => { if (!mutationLocked) { setResolutionError(''); setConfirmingUnstage(true) } }} onCancelUnstage={() => setConfirmingUnstage(false)} onConfirmUnstage={() => void resolveUnstage()} onClose={onClose} message={message} setMessage={setMessage} includeUntracked={includeUntracked} setIncludeUntracked={setIncludeUntracked} keepIndex={keepIndex} setKeepIndex={setKeepIndex} keepIndexAvailability={keepIndexAvailability} executable={executable} blockedReason={blockedReason} confirming={confirming} setConfirming={setConfirming} busy={busy} mutationLocked={mutationLocked} onExecute={() => void execute()} /> : null}
        </section>
      </div>
    </OverlayPortal>
  )
}
