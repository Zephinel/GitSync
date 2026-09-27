import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import CanonicalCheckbox from './CanonicalCheckbox.jsx'
import OverlayPortal from './OverlayPortal.jsx'
import { OVERLAY_ID, OVERLAY_LEVEL } from './overlayLayerContract.js'
import {
  BRANCH_ATTENTION_KIND,
  getBranchAttentionSummary,
} from './branchAttentionUtils.js'
import { getLatestBranchOverview } from './branchDomainStore.js'
import {
  buildBranchDeleteRequest,
  normalizeBranchManagementRows,
} from './branchManagementUtils.js'
import { readBranchForceDeleteDefault } from './branchForceDeleteSettings.js'
import BranchSwitchIcon from './BranchSwitchIcon.jsx'
import {
  BranchIcon,
  CloseIcon as CanonicalCloseIcon,
  CopyIcon as CanonicalCopyIcon,
  DeleteIcon as CanonicalDeleteIcon,
  RefreshSyncIcon,
} from './icons/CanonicalIcons.jsx'
import './BranchAttentionDetailLayer.css'
import './BranchAttentionDetailDelete.css'

const ACTION_SELECTOR = '.repo-card__branch-attention-action'
const CARD_SELECTOR = '.repo-card'

function getErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return error.message
  try { return JSON.stringify(error) } catch { return '未知错误' }
}

function getContextFromAction(action) {
  const repoCard = action?.closest?.(CARD_SELECTOR)
  if (!repoCard) return null
  const repoPath = repoCard.querySelector('.repo-card__path-text')?.textContent?.trim() || ''
  if (!repoPath) return null
  const repoName = repoCard.querySelector('.repo-card__name')?.textContent?.trim()
    || repoPath.replace(/\\/g, '/').split('/').filter(Boolean).pop()
    || 'Repository'
  return {
    repoId: repoCard.getAttribute('data-repo-card-id') || '',
    repoName,
    repoPath,
  }
}

function getKindTone(kind) {
  if (kind === BRANCH_ATTENTION_KIND.comparisonError) return 'danger'
  if (kind === BRANCH_ATTENTION_KIND.diverged) return 'danger'
  if (kind === BRANCH_ATTENTION_KIND.upstreamGone) return 'warning'
  if (kind === BRANCH_ATTENTION_KIND.behind) return 'behind'
  return 'remote'
}

function summaryChips(summary) {
  if (!summary?.counts) return []
  const definitions = [
    [BRANCH_ATTENTION_KIND.remoteOnly, '仅远端'],
    [BRANCH_ATTENTION_KIND.behind, '落后'],
    [BRANCH_ATTENTION_KIND.diverged, '分叉'],
    [BRANCH_ATTENTION_KIND.upstreamGone, '上游失效'],
    [BRANCH_ATTENTION_KIND.comparisonError, '读取失败'],
  ]
  return definitions
    .filter(([kind]) => Number(summary.counts[kind] || 0) > 0)
    .map(([kind, label]) => ({ kind, label, count: summary.counts[kind] }))
}

function buildAttentionEntries(summary, rows) {
  const rowByIdentity = new Map(rows.map((row) => [row.identity, row]))
  return (summary?.items || []).map((item) => ({
    item,
    row: rowByIdentity.get(item.identity)
      || rows.find((row) => row.rowName === item.fullName || row.localName === item.branch)
      || null,
  }))
}

function getPrimaryAction(entry, repoStatus) {
  const item = entry?.item
  const row = entry?.row
  if (!item || !row) return null

  const modifiedCount = Array.isArray(repoStatus?.modified) ? repoStatus.modified.length : 0
  const conflictCount = Array.isArray(repoStatus?.conflicted) ? repoStatus.conflicted.length : 0
  const switchBlockedReason = modifiedCount > 0 || conflictCount > 0
    ? '当前工作区存在未提交改动或冲突。'
    : ''

  if (item.kind === BRANCH_ATTENTION_KIND.remoteOnly) {
    const remoteBranch = row.remoteRef || row.upstream || item.fullName
    const localBranch = row.localName || row.remoteBranchName || item.branch
    if (!remoteBranch || !localBranch) return null
    return {
      label: '切换并跟踪',
      disabledReason: switchBlockedReason,
      command: 'switch_repo_branch',
      payload: { branch: localBranch, remoteBranch },
    }
  }

  if (item.kind === BRANCH_ATTENTION_KIND.behind && row.canSync && row.localName) {
    return {
      label: '同步',
      disabledReason: '',
      command: 'sync_repo_branch',
      payload: { branch: row.localName },
    }
  }

  if (item.kind === BRANCH_ATTENTION_KIND.upstreamGone && row.localName) {
    const rebindUpstream = String(
      row.source?.rebind_upstream || row.source?.rebindUpstream || ''
    ).trim()
    if (rebindUpstream) {
      return {
        label: '重新绑定',
        disabledReason: switchBlockedReason,
        command: 'rebind_repo_branch_upstream',
        payload: { branch: row.localName, upstream: rebindUpstream },
      }
    }
    return {
      label: '取消上游',
      disabledReason: switchBlockedReason,
      command: 'unset_repo_branch_upstream',
      payload: { branch: row.localName },
    }
  }

  return null
}

function AttentionRow({ entry, repoStatus, busyIdentity, onRunAction, onCopy, onDelete }) {
  const { item, row } = entry
  const displayName = item.fullName || item.branch
  const action = getPrimaryAction(entry, repoStatus)
  const syncAction = action?.command === 'sync_repo_branch'
  const branchSwitchAction = action?.command === 'switch_repo_branch'
  const rowBusy = busyIdentity === item.identity
  const deleteDisabledReason = row?.deleteDisabledReason || (!row ? '分支信息不完整，请刷新后重试。' : '')

  return (
    <article className="branch-attention-detail__row">
      <div className="branch-attention-detail__row-icon"><BranchIcon /></div>
      <div className="branch-attention-detail__row-main">
        <div className="branch-attention-detail__row-title-line">
          <strong data-app-tooltip={displayName}>{displayName}</strong>
          <span className={`branch-attention-detail__state branch-attention-detail__state--${getKindTone(item.kind)}`}>
            {item.kindLabel}
          </span>
        </div>
        {item.upstream && item.upstream !== displayName ? (
          <div className="branch-attention-detail__upstream" data-app-tooltip={item.upstream}>
            upstream: {item.upstream}
          </div>
        ) : null}
        <p>{item.reason}</p>
        {row?.isCheckedOutElsewhere ? (
          <div className="branch-attention-detail__worktree" data-app-tooltip={row.worktreePath || ''}>
            {row.worktreePath ? `已在其他 worktree 检出：${row.worktreePath}` : '已在其他 worktree 检出。'}
          </div>
        ) : null}
      </div>
      <div className="branch-attention-detail__row-side">
        {(item.ahead > 0 || item.behind > 0) ? (
          <div className="branch-attention-detail__metrics" aria-label="提交差异">
            {item.ahead > 0 ? <span>领先 {item.ahead}</span> : null}
            {item.behind > 0 ? <span>落后 {item.behind}</span> : null}
          </div>
        ) : null}
        <div className="branch-attention-detail__row-actions">
          {action ? (
            <button
              type="button"
              className={`branch-attention-detail__primary-action ${syncAction ? 'branch-attention-detail__primary-action--icon-only' : ''}`.trim()}
              onClick={() => onRunAction(entry, action)}
              disabled={rowBusy || Boolean(action.disabledReason)}
              data-app-tooltip={action.disabledReason || action.label}
              aria-label={syncAction ? `同步分支 ${displayName}` : undefined}
            >
              {syncAction ? (
                <span className={rowBusy ? 'branch-attention-detail__spinning' : ''}><RefreshSyncIcon /></span>
              ) : (
                <>
                  {branchSwitchAction && !rowBusy ? <BranchSwitchIcon className="branch-attention-detail__primary-action-icon" /> : null}
                  {rowBusy ? <span className="branch-attention-detail__busy-dot" aria-hidden="true" /> : null}
                  {rowBusy ? '处理中…' : action.label}
                </>
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="branch-attention-detail__copy-action"
            onClick={() => onCopy(displayName)}
            disabled={rowBusy}
            data-app-tooltip={`复制分支：${displayName}`}
            aria-label={`复制分支 ${displayName}`}
          >
            <CanonicalCopyIcon />
          </button>
          <button
            type="button"
            className="branch-attention-detail__delete-action"
            onClick={() => row?.canDelete && onDelete(entry)}
            disabled={rowBusy || !row?.canDelete}
            data-app-tooltip={row?.canDelete ? `删除分支：${displayName}` : deleteDisabledReason}
            aria-label={row?.canDelete ? `删除分支 ${displayName}` : `不能删除分支 ${displayName}：${deleteDisabledReason}`}
          >
            <CanonicalDeleteIcon />
          </button>
        </div>
      </div>
    </article>
  )
}

function DeleteConfirmDialog({ entry, present, busy, onCancel, onConfirm }) {
  const row = entry?.row
  const displayName = entry?.item?.fullName || entry?.item?.branch || row?.rowName || '该分支'
  const isRemoteOnly = Boolean(row?.isRemoteRow || row?.isRemoteOnly)
  const hasLocalDelete = Boolean(row && !isRemoteOnly && row.localName)
  const hasOptionalRemote = Boolean(hasLocalDelete && row.remoteRef && !row.upstreamGone)
  const [includeRemote, setIncludeRemote] = useState(false)
  const [forceDelete, setForceDelete] = useState(false)

  useEffect(() => {
    setIncludeRemote(false)
    setForceDelete(Boolean(hasLocalDelete && readBranchForceDeleteDefault()))
  }, [entry?.item?.identity, hasLocalDelete])

  return (
    <OverlayPortal
      level={OVERLAY_LEVEL.nested}
      overlayId={OVERLAY_ID.branchAttentionDelete}
      parentOverlayId={OVERLAY_ID.branchAttention}
      present={present}
      onEscape={onCancel}
    >
      {row ? (
      <div data-overlay-motion="backdrop" className="branch-attention-detail__delete-backdrop" role="presentation" onMouseDown={busy ? undefined : onCancel}>
        <section
          data-overlay-motion="surface"
          className="branch-attention-detail__delete-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={`确认删除分支 ${displayName}`}
          onMouseDown={(event) => event.stopPropagation()}
        >
        <header>
          <span className="branch-attention-detail__delete-icon"><CanonicalDeleteIcon /></span>
          <div>
            <h3>确认删除分支</h3>
            <p data-app-tooltip={displayName}>{displayName}</p>
          </div>
        </header>

        <div className="branch-attention-detail__delete-summary">
          {isRemoteOnly
            ? `将从远端删除 ${row.remoteRef || displayName}。`
            : `将删除本地分支 ${row.localName || displayName}。`}
        </div>

        {hasOptionalRemote ? (
          <CanonicalCheckbox
            className="branch-attention-detail__delete-option"
            checked={includeRemote}
            disabled={busy}
            onChange={setIncludeRemote}
            label={`同时删除远端分支 ${row.remoteRef}`}
          >
            <span>同时删除远端分支 {row.remoteRef}</span>
          </CanonicalCheckbox>
        ) : null}

        {hasLocalDelete ? (
          <CanonicalCheckbox
            className="branch-attention-detail__delete-option"
            checked={forceDelete}
            disabled={busy}
            onChange={setForceDelete}
            label="强制删除本地分支（git branch -D）"
          >
            <span>强制删除本地分支（git branch -D）</span>
          </CanonicalCheckbox>
        ) : null}

        <p className="branch-attention-detail__delete-note">
          {isRemoteOnly
            ? '删除远端分支会立即推送删除操作，无法通过 GitSync 撤销。'
            : '默认分支、当前分支和其他 worktree 中已检出的分支仍然受保护。'}
        </p>

        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button
            type="button"
            className="branch-attention-detail__delete-confirm"
            disabled={busy}
            onClick={() => onConfirm({ includeRemote, forceDelete: hasLocalDelete && forceDelete })}
          >
            {busy ? '删除中…' : '确认删除'}
          </button>
        </footer>
        </section>
      </div>
      ) : null}
    </OverlayPortal>
  )
}

export default function BranchAttentionDetailLayer() {
  const [context, setContext] = useState(null)
  const [present, setPresent] = useState(false)
  const [dataState, setDataState] = useState({
    overview: null,
    meta: null,
    status: null,
    rows: [],
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyIdentity, setBusyIdentity] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [deleteEntry, setDeleteEntry] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const requestIdRef = useRef(0)

  const summary = useMemo(
    () => getBranchAttentionSummary(dataState.overview),
    [dataState.overview]
  )
  const chips = useMemo(() => summaryChips(summary), [summary])
  const entries = useMemo(
    () => buildAttentionEntries(summary, dataState.rows),
    [dataState.rows, summary]
  )

  const finishClose = useCallback(() => {
    requestIdRef.current += 1
    setContext(null)
    setDataState({ overview: null, meta: null, status: null, rows: [] })
    setLoading(false)
    setError('')
    setFeedback(null)
    setDeleteEntry(null)
  }, [])

  const close = useCallback(() => {
    if (busyIdentity || deleteBusy) return
    requestIdRef.current += 1
    setDeleteEntry(null)
    setPresent(false)
  }, [busyIdentity, deleteBusy])

  const load = useCallback(async (nextContext, { preserve = false } = {}) => {
    if (!nextContext?.repoPath) return
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    setError('')
    if (!preserve) {
      const cachedOverview = getLatestBranchOverview(nextContext.repoPath)
      setDataState((previous) => ({ ...previous, overview: cachedOverview }))
    }
    try {
      const [overview, meta, status] = await Promise.all([
        invoke('get_repo_branch_overview', { path: nextContext.repoPath }),
        invoke('get_repo_branch_management_meta', { path: nextContext.repoPath }),
        invoke('get_repo_status', { path: nextContext.repoPath }),
      ])
      if (requestIdRef.current !== requestId) return
      setDataState({
        overview: overview || null,
        meta: meta || null,
        status: status || null,
        rows: normalizeBranchManagementRows(overview, meta, status),
      })
    } catch (loadError) {
      if (requestIdRef.current !== requestId) return
      setError(getErrorMessage(loadError) || '读取分支提醒失败')
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const handleActionClick = (event) => {
      const action = event.target?.closest?.(ACTION_SELECTOR)
      if (!action || action.disabled) return
      const attention = action.closest('.repo-card__branch-attention')
      if (!attention || attention.hidden || attention.style.display === 'none') return
      const nextContext = getContextFromAction(action)
      if (!nextContext) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      setContext(nextContext)
      setPresent(true)
      setFeedback(null)
      setBusyIdentity('')
      setDeleteEntry(null)
      void load(nextContext)
    }

    document.addEventListener('click', handleActionClick, true)
    return () => document.removeEventListener('click', handleActionClick, true)
  }, [load])

  useEffect(() => {
    if (!context) return undefined
    document.body.classList.add('branch-attention-detail-open')
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' || busyIdentity || deleteBusy) return
      if (deleteEntry) {
        setDeleteEntry(null)
        event.preventDefault()
        return
      }
      close()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.classList.remove('branch-attention-detail-open')
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [busyIdentity, close, context, deleteBusy, deleteEntry])

  const handleCopy = useCallback(async (value) => {
    const text = String(value || '').trim()
    if (!text) return
    try {
      if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text)
      } else {
        await invoke('write_clipboard', { text })
      }
      setFeedback({ tone: 'success', message: `已复制 ${text}` })
    } catch (copyError) {
      setFeedback({ tone: 'danger', message: `复制失败：${getErrorMessage(copyError)}` })
    }
  }, [])

  const handleRunAction = useCallback(async (entry, action) => {
    if (!context?.repoPath || !entry?.item || !action || busyIdentity || deleteBusy) return
    setBusyIdentity(entry.item.identity)
    setFeedback(null)
    try {
      const result = await invoke(action.command, {
        path: context.repoPath,
        ...action.payload,
      })
      setFeedback({
        tone: 'success',
        message: String(result?.message || `${entry.item.branch} 已处理`).trim(),
      })
      await load(context, { preserve: true })
      if (context.repoId) {
        void invoke('refresh_repo_git_metadata', { repoId: context.repoId }).catch(() => {})
      }
    } catch (operationError) {
      setFeedback({ tone: 'danger', message: getErrorMessage(operationError) })
      await load(context, { preserve: true })
    } finally {
      setBusyIdentity('')
    }
  }, [busyIdentity, context, deleteBusy, load])

  const handleRequestDelete = useCallback((entry) => {
    const row = entry?.row
    if (!row?.canDelete) {
      setFeedback({
        tone: 'danger',
        message: row?.deleteDisabledReason || '该分支当前不能删除。',
      })
      return
    }
    setFeedback(null)
    setDeleteEntry(entry)
  }, [])

  const handleConfirmDelete = useCallback(async ({ includeRemote = false, forceDelete = false } = {}) => {
    const row = deleteEntry?.row
    const item = deleteEntry?.item
    if (!context?.repoPath || !row || !item || deleteBusy || busyIdentity) return
    const request = buildBranchDeleteRequest(row, { includeRemote, forceDelete })
    if (!request) {
      setFeedback({ tone: 'danger', message: row.deleteDisabledReason || '该分支当前不能删除。' })
      setDeleteEntry(null)
      return
    }

    // Single delete authority: the request carries forceDelete.
    const command = 'delete_repo_branches_batch'
    setDeleteBusy(true)
    setBusyIdentity(item.identity)
    setFeedback(null)
    try {
      const result = await invoke(command, {
        path: context.repoPath,
        requests: [request],
      })
      const failedCount = Number(result?.failed_count ?? result?.failedCount ?? 0)
      const resultItems = Array.isArray(result?.results) ? result.results : []
      const failureMessage = resultItems
        .filter((resultItem) => !resultItem?.success)
        .map((resultItem) => resultItem?.message || resultItem?.warning)
        .filter(Boolean)
        .join('；')

      if (failedCount > 0) {
        setFeedback({ tone: 'danger', message: failureMessage || '分支删除失败。' })
      } else {
        setFeedback({
          tone: 'success',
          message: request.deleteRemote && !request.deleteLocal
            ? `已删除远端分支 ${request.remoteBranch}`
            : `已删除分支 ${request.branch}`,
        })
      }
      setDeleteEntry(null)
      await load(context, { preserve: true })
      if (context.repoId) {
        void invoke('refresh_repo_git_metadata', { repoId: context.repoId }).catch(() => {})
      }
    } catch (deleteError) {
      setFeedback({ tone: 'danger', message: getErrorMessage(deleteError) })
      setDeleteEntry(null)
      await load(context, { preserve: true })
    } finally {
      setDeleteBusy(false)
      setBusyIdentity('')
    }
  }, [busyIdentity, context, deleteBusy, deleteEntry, load])

  if (!context || typeof document === 'undefined') return null

  return (
    <OverlayPortal
      level={OVERLAY_LEVEL.workspace}
      overlayId={OVERLAY_ID.branchAttention}
      present={present}
      onExitComplete={finishClose}
      onEscape={close}
    >
      <div data-overlay-motion="backdrop" className="branch-attention-detail__backdrop" role="presentation" onMouseDown={close}>
      <section
        data-overlay-motion="surface"
        className="branch-attention-detail__sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${context.repoName} 分支提醒详情`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="branch-attention-detail__header">
          <div className="branch-attention-detail__identity">
            <span className="branch-attention-detail__eyebrow">其他分支提醒</span>
            <h2>{context.repoName}</h2>
            <p data-app-tooltip={context.repoPath}>{context.repoPath}</p>
          </div>
          <div className="branch-attention-detail__header-actions">
            <button
              type="button"
              className="branch-attention-detail__icon-button"
              onClick={() => void load(context, { preserve: true })}
              disabled={loading || Boolean(busyIdentity) || deleteBusy}
              data-app-tooltip="刷新提醒"
              aria-label="刷新分支提醒"
            >
              <span className={loading ? 'branch-attention-detail__spinning' : ''}><RefreshSyncIcon /></span>
            </button>
            <button
              type="button"
              className="branch-attention-detail__icon-button"
              onClick={close}
              disabled={Boolean(busyIdentity) || deleteBusy}
              data-app-tooltip="关闭"
              aria-label="关闭分支提醒详情"
            >
              <CanonicalCloseIcon />
            </button>
          </div>
        </header>

        <div className="branch-attention-detail__content">
          {summary ? (
            <section className="branch-attention-detail__summary" aria-label="提醒摘要">
              <div>
                <strong>{summary.message}</strong>
                <span>仅显示被计入仓库卡片提醒的其他分支</span>
              </div>
              <div className="branch-attention-detail__chips">
                {chips.map((chip) => (
                  <span key={chip.kind}>{chip.label} {chip.count}</span>
                ))}
              </div>
            </section>
          ) : null}

          {feedback ? (
            <div className={`branch-attention-detail__feedback branch-attention-detail__feedback--${feedback.tone}`} role="status">
              {feedback.message}
            </div>
          ) : null}

          {error ? (
            <div className="branch-attention-detail__state branch-attention-detail__state--error">
              <strong>提醒读取失败</strong>
              <span>{error}</span>
              <button type="button" onClick={() => void load(context, { preserve: true })}>重新读取</button>
            </div>
          ) : null}

          {!error && !summary && loading ? (
            <div className="branch-attention-detail__state">
              <span className="branch-attention-detail__spinning"><RefreshSyncIcon /></span>
              <span>正在读取分支提醒...</span>
            </div>
          ) : null}

          {!error && !loading && !summary ? (
            <div className="branch-attention-detail__empty">
              <BranchIcon />
              <strong>当前没有其他分支需要关注</strong>
              <span>仓库卡片的提醒状态已经更新。</span>
            </div>
          ) : null}

          {summary ? (
            <div className="branch-attention-detail__list">
              {entries.map((entry) => (
                <AttentionRow
                  key={entry.item.identity || `${entry.item.kind}:${entry.item.fullName || entry.item.branch}`}
                  entry={entry}
                  repoStatus={dataState.status}
                  busyIdentity={busyIdentity}
                  onRunAction={handleRunAction}
                  onCopy={handleCopy}
                  onDelete={handleRequestDelete}
                />
              ))}
            </div>
          ) : null}
        </div>

        <footer className="branch-attention-detail__footer">
          <span>{summary ? `共 ${summary.count} 个其他分支` : ''}</span>
          <button type="button" onClick={close} disabled={Boolean(busyIdentity) || deleteBusy}>关闭</button>
        </footer>

        <DeleteConfirmDialog
          entry={deleteEntry}
          present={Boolean(deleteEntry)}
          busy={deleteBusy}
          onCancel={() => !deleteBusy && setDeleteEntry(null)}
          onConfirm={handleConfirmDelete}
        />
      </section>
      </div>
    </OverlayPortal>
  )
}
