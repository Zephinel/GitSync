import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  AI_PROGRESS_EVENT,
  createAiRequestId,
  isAiRequestRunning,
  normalizeAiError,
} from './aiSettings'
import {
  formatAiReviewForClipboard,
  getReviewCoverageItems,
  normalizeAiReviewPreview,
  normalizeAiReviewResult,
  readWorkingReviewScope,
} from './aiReview'
import { cacheWorkingSummary } from './workingChangeScope.js'
import { navigateReviewFinding } from './aiReviewNavigation'
import OverlayPortal from '../OverlayPortal.jsx'
import { OVERLAY_ID, OVERLAY_LEVEL } from '../overlayLayerContract.js'
import {
  CloseIcon as CanonicalCloseIcon,
  ReviewIcon as CanonicalReviewIcon,
} from '../icons/CanonicalIcons.jsx'
import './AiReviewLayer.css'

const WORKING_CHANGES_CONTEXT_EVENT = 'gitsync:working-changes-context'
const WORKING_CHANGES_CONTEXT_KEY = '__gitsyncWorkingChangesContext'
const TOOLBAR_MOUNT_CLASS = 'ai-review-toolbar-mount'
const NON_CANCELLABLE_PHASES = new Set(['starting', 'cancelling'])
const SEVERITIES = ['P0', 'P1', 'P2', 'P3']
const REVIEW_STALE_CHECK_INTERVAL_MS = 2000

const IDLE_REQUEST = Object.freeze({
  requestId: '',
  status: 'idle',
  phase: '',
  label: '',
  completedUnits: 0,
  totalUnits: 0,
})

function Spinner() {
  return <span className="ai-review-spinner" aria-hidden="true" />
}

function ensureToolbarMount() {
  const toolbar = document.querySelector('.working-changes-toolbar__actions')
  if (!(toolbar instanceof HTMLElement)) return null
  let mount = toolbar.querySelector(`:scope > .${TOOLBAR_MOUNT_CLASS}`)
  if (!mount) {
    mount = document.createElement('div')
    mount.className = TOOLBAR_MOUNT_CLASS
    toolbar.prepend(mount)
  }
  return mount
}

function getWorkingContext() {
  return typeof window === 'undefined' ? null : window[WORKING_CHANGES_CONTEXT_KEY] || null
}

function readToolbarSelectedCount(root = document) {
  const text = root.querySelector('.working-changes-toolbar__selection strong')?.textContent
  const value = Number.parseInt(String(text || ''), 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function shouldRefreshWorkingSummary(scope, root = document) {
  if (scope.complete !== true) return true
  const selectedCount = readToolbarSelectedCount(root)
  if (selectedCount === null || selectedCount === 0) return true
  return scope.selectedCount !== selectedCount || scope.targets.length !== selectedCount
}

function riskLabel(value) {
  return ({
    low: '低风险',
    medium: '中风险',
    high: '高风险',
    critical: '严重风险',
  })[value] || value
}

function bytesLabel(value) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function PreviewDialog({ present, state, onClose, onConfirm }) {
  const preview = state.preview
  const coverage = getReviewCoverageItems(preview)
  return (
    <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.aiReviewPreview} parentOverlayId={OVERLAY_ID.workingChanges} present={present} onEscape={() => { if (!state.loading) onClose() }}>
      <div data-overlay-motion="backdrop" className="ai-review-preview-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !state.loading) onClose()
    }}>
      <section data-overlay-motion="surface" className="ai-review-preview" role="dialog" aria-modal="true" aria-labelledby="ai-review-preview-title">
        <header>
          <div>
            <span className="ai-review-eyebrow">INPUT PREVIEW</span>
            <h2 id="ai-review-preview-title">发送前确认 Review 范围</h2>
          </div>
          <button type="button" className="ai-review-icon-button" onClick={onClose} disabled={state.loading} aria-label="关闭 Review 输入预览"><CanonicalCloseIcon /></button>
        </header>
        {state.loading ? (
          <div className="ai-review-preview__loading"><Spinner /><strong>正在过滤并计算 Review 输入…</strong></div>
        ) : state.error ? (
          <div className="ai-review-preview__error" role="alert"><strong>{state.error.title}</strong><span>{state.error.message}</span></div>
        ) : preview ? (
          <>
            <div className="ai-review-preview__metrics">
              <div><span>范围</span><strong>{preview.scopeLabel}</strong></div>
              <div><span>文件</span><strong>{preview.selectedFileCount}</strong></div>
              <div><span>批次</span><strong>{preview.batchCount}</strong></div>
              <div><span>完整 Diff</span><strong>{preview.includedFileCount}</strong></div>
              <div><span>脱敏后输入</span><strong>{bytesLabel(preview.sanitizedBytes)}</strong></div>
            </div>
            <div className="ai-review-preview__privacy">
              <span>每批最多 {preview.batchFileLimit || 8} 文件</span>
              <span>排除 {preview.excludedFiles.length}</span>
              <span>摘要模式 {preview.summaryOnlyFiles.length}</span>
              <span>Binary {preview.binaryFiles.length}</span>
              <span>脱敏行 {preview.redactedLineCount}</span>
            </div>
            {coverage.length > 0 ? (
              <details className="ai-review-coverage">
                <summary>查看未发送完整内容的文件</summary>
                <ul>{coverage.map((item) => <li key={`${item.kind}:${item.path}`}><code>{item.path}</code><span>{item.reason}</span></li>)}</ul>
              </details>
            ) : <p className="ai-review-preview__clean">当前范围内没有敏感路径、Binary 或摘要模式文件。</p>}
          </>
        ) : null}
        <footer>
          <button type="button" className="ai-review-button" onClick={onClose} disabled={state.loading}>取消</button>
          <button type="button" className="ai-review-button ai-review-button--primary" onClick={onConfirm} disabled={state.loading || Boolean(state.error) || !preview}>开始 Review</button>
        </footer>
      </section>
      </div>
    </OverlayPortal>
  )
}

function FindingCard({ finding }) {
  const location = finding.file
    ? `${finding.file}${finding.startLine ? `:${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `–${finding.endLine}` : ''}` : ''}`
    : '跨文件'
  return (
    <button type="button" className={`ai-review-finding ai-review-finding--${finding.severity.toLowerCase()}`} onClick={() => navigateReviewFinding(finding)} disabled={!finding.file}>
      <span className="ai-review-finding__severity">{finding.severity}</span>
      <span className="ai-review-finding__content">
        <strong>{finding.title}</strong>
        <code>{location}</code>
        <span>{finding.explanation}</span>
        {finding.suggestion ? <small>建议：{finding.suggestion}</small> : null}
      </span>
    </button>
  )
}

function RequestProgress({ request, running, error }) {
  const hasUnits = request.totalUnits > 0
  const ratio = hasUnits ? Math.min(1, request.completedUnits / request.totalUnits) : 0
  return (
    <div className={`ai-review-request ai-review-request--${request.status}`} role="status" aria-live="polite">
      {running ? <Spinner /> : <span className="ai-review-request__dot" aria-hidden="true" />}
      <div className="ai-review-request__content">
        <strong>{request.label || '正在执行 AI Review…'}</strong>
        {error ? <span>{error.message}</span> : <span>{hasUnits ? `批次 ${request.completedUnits}/${request.totalUnits}` : 'Review 会严格使用发送前确认的范围。'}</span>}
        {hasUnits ? <div className="ai-review-request__bar" aria-hidden="true"><span style={{ width: `${ratio * 100}%` }} /></div> : null}
      </div>
    </div>
  )
}

function ReviewDrawer({ present, request, result, error, filters, onToggleFilter, onCancel, onClose, onRerun, onCopy, copyState }) {
  const running = isAiRequestRunning(request.status)
  const cancellable = running && !NON_CANCELLABLE_PHASES.has(request.phase)
  const findings = result?.findings.filter((finding) => filters.has(finding.severity)) || []
  const coverage = getReviewCoverageItems(result)
  return (
    <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.aiReviewDrawer} parentOverlayId={OVERLAY_ID.workingChanges} present={present} onEscape={() => { if (!running || cancellable) onClose() }}>
      <div className="ai-review-drawer-shell" role="presentation">
      <aside data-overlay-motion="surface" className="ai-review-drawer" role="dialog" aria-modal="false" aria-labelledby="ai-review-drawer-title">
        <header className="ai-review-drawer__header">
          <div>
            <span className="ai-review-eyebrow">AI REVIEW</span>
            <h2 id="ai-review-drawer-title">未提交改动 Review</h2>
          </div>
          <button type="button" className="ai-review-icon-button" onClick={onClose} disabled={running && !cancellable} data-app-tooltip={running && !cancellable ? '请求正在注册，稍后可取消或关闭' : '关闭 AI Review'} aria-label="关闭 AI Review"><CanonicalCloseIcon /></button>
        </header>

        {result?.stale ? (
          <div className="ai-review-stale" role="alert"><strong>结果已过期</strong><span>Review 使用的工作区快照已经变化。结果仍可查看，但应重新运行后再据此修改代码。</span></div>
        ) : null}
        {result?.partialSuccess ? (
          <div className="ai-review-partial" role="alert"><strong>Review 部分完成</strong><span>完成 {result.completedBatchCount}/{result.batchCount} 个批次，覆盖 {result.completedFileCount}/{result.selectedFileCount} 个文件。失败批次未被伪装成完整覆盖。</span></div>
        ) : null}

        {request.status !== 'idle' && !result ? <RequestProgress request={request} running={running} error={error} /> : null}

        {result ? (
          <div className="ai-review-drawer__content">
            <section className="ai-review-summary">
              <div className="ai-review-summary__top">
                <span className={`ai-review-risk ai-review-risk--${result.overallRisk}`}>{riskLabel(result.overallRisk)}</span>
                <span>{result.scopeLabel} · {result.selectedFileCount} 个文件</span>
              </div>
              <p>{result.summary}</p>
              <div className="ai-review-summary__meta">
                <span>{result.model}</span>
                <span>{result.providerHost}</span>
                <span>{bytesLabel(result.sanitizedBytes)}</span>
                <span>批次 {result.completedBatchCount}/{result.batchCount}</span>
                <span>文件 {result.completedFileCount}/{result.selectedFileCount}</span>
                {result.cacheHit ? <span className="ai-review-cache-badge">缓存命中</span> : null}
              </div>
            </section>

            {result.batchFailures.length > 0 ? (
              <details className="ai-review-batch-failures" open={result.partialSuccess}>
                <summary>未完成或被截断的批次（{result.batchFailures.length}）</summary>
                <ul>{result.batchFailures.map((failure, index) => (
                  <li key={`${failure.batchIndex}:${failure.code}:${index}`}>
                    <strong>{failure.batchIndex ? `批次 ${failure.batchIndex}` : '合并结果'}</strong>
                    <code>{failure.code}</code>
                    <span>{failure.message}</span>
                  </li>
                ))}</ul>
              </details>
            ) : null}

            <section className="ai-review-section">
              <div className="ai-review-section__heading"><h3>Findings</h3><span>{result.findings.length}</span></div>
              <div className="ai-review-filters" role="group" aria-label="Finding 严重级别过滤">
                {SEVERITIES.map((severity) => <button type="button" key={severity} className={filters.has(severity) ? 'ai-review-filter--active' : ''} onClick={() => onToggleFilter(severity)} aria-pressed={filters.has(severity)}>{severity}</button>)}
              </div>
              <div className="ai-review-findings">
                {findings.length > 0 ? findings.map((finding) => <FindingCard key={finding.id} finding={finding} />) : <div className="ai-review-empty">当前过滤条件下没有 Finding。</div>}
              </div>
            </section>

            {result.positiveNotes.length > 0 ? (
              <section className="ai-review-section"><div className="ai-review-section__heading"><h3>做得好的地方</h3></div><ul>{result.positiveNotes.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></section>
            ) : null}
            {result.testSuggestions.length > 0 ? (
              <section className="ai-review-section"><div className="ai-review-section__heading"><h3>测试建议</h3></div><ul>{result.testSuggestions.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></section>
            ) : null}
            <details className="ai-review-coverage">
              <summary>覆盖范围与排除项</summary>
              <div className="ai-review-coverage__summary"><span>完整 Diff {result.includedFileCount}</span><span>排除 {result.excludedFiles.length}</span><span>摘要 {result.summaryOnlyFiles.length}</span><span>Binary {result.binaryFiles.length}</span><span>脱敏行 {result.redactedLineCount}</span></div>
              {coverage.length > 0 ? <ul>{coverage.map((item) => <li key={`${item.kind}:${item.path}`}><code>{item.path}</code><span>{item.reason}</span></li>)}</ul> : <p>没有排除项。</p>}
            </details>
          </div>
        ) : error && !running ? (
          <div className="ai-review-drawer__error" role="alert"><strong>{error.title}</strong><span>{error.message}</span></div>
        ) : null}

        <footer className="ai-review-drawer__footer">
          {cancellable ? <button type="button" className="ai-review-button ai-review-button--danger" onClick={onCancel}>取消 Review</button> : null}
          {running && !cancellable ? <button type="button" className="ai-review-button" disabled><Spinner />处理中…</button> : null}
          {result ? <button type="button" className="ai-review-button" onClick={onCopy}>{copyState || '复制 Review'}</button> : null}
          <button type="button" className="ai-review-button ai-review-button--primary" onClick={onRerun} disabled={running}>{result ? '重新运行' : '重新选择范围'}</button>
        </footer>
      </aside>
      </div>
    </OverlayPortal>
  )
}

export default function AiReviewLayer() {
  const [mountNode, setMountNode] = useState(null)
  const [context, setContext] = useState(null)
  const [configurationReady, setConfigurationReady] = useState(false)
  const [previewState, setPreviewState] = useState({ open: false, loading: false, preview: null, error: null })
  const [scope, setScope] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [request, setRequest] = useState(IDLE_REQUEST)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [filters, setFilters] = useState(() => new Set(SEVERITIES))
  const [copyState, setCopyState] = useState('')
  const activeRequestIdRef = useRef('')
  const requestBusy = isAiRequestRunning(request.status)
  const requestCancellable = requestBusy && !NON_CANCELLABLE_PHASES.has(request.phase)

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    let frame = 0
    const sync = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        setMountNode(ensureToolbarMount())
        setContext(getWorkingContext())
      })
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    const handleContext = (event) => {
      setContext(event.detail || null)
      sync()
    }
    window.addEventListener(WORKING_CHANGES_CONTEXT_EVENT, handleContext)
    sync()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener(WORKING_CHANGES_CONTEXT_EVENT, handleContext)
    }
  }, [])

  useEffect(() => {
    if (!mountNode || !context?.repoPath) {
      setConfigurationReady(false)
      setPreviewState({ open: false, loading: false, preview: null, error: null })
      setDrawerOpen(false)
      setScope(null)
      setResult(null)
      setError(null)
      const requestId = activeRequestIdRef.current
      if (requestId) void invoke('cancel_ai_review_request', { requestId }).catch(() => {})
      activeRequestIdRef.current = ''
      setRequest(IDLE_REQUEST)
      return undefined
    }
    let disposed = false
    void invoke('get_ai_configuration_status').then((status) => {
      if (disposed) return
      setConfigurationReady(Boolean(status?.hasApiKey && status?.endpoint && (status?.reviewModel || status?.defaultModel)))
    }).catch(() => {
      if (!disposed) setConfigurationReady(false)
    })
    return () => { disposed = true }
  }, [context?.repoPath, mountNode])

  useEffect(() => {
    let disposed = false
    let unlisten = null
    void listen(AI_PROGRESS_EVENT, (event) => {
      const progress = event.payload || {}
      if (!progress.requestId || progress.requestId !== activeRequestIdRef.current || progress.kind !== 'review') return
      const completedUnits = progress.completedUnits == null ? null : Number(progress.completedUnits)
      const totalUnits = progress.totalUnits == null ? null : Number(progress.totalUnits)
      setRequest((previous) => ({
        ...previous,
        requestId: String(progress.requestId),
        status: String(progress.status || previous.status),
        phase: String(progress.phase || previous.phase),
        label: String(progress.label || previous.label),
        completedUnits: Number.isFinite(completedUnits) ? completedUnits : previous.completedUnits,
        totalUnits: Number.isFinite(totalUnits) ? totalUnits : previous.totalUnits,
      }))
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    }).catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!drawerOpen || !result || result.stale || !context?.repoPath || !scope?.targets?.length) return undefined
    let disposed = false
    let checking = false
    const fingerprint = result.snapshotFingerprint
    const check = async () => {
      if (disposed || checking) return
      checking = true
      try {
        const currentFingerprint = await invoke('get_ai_review_scope_fingerprint', {
          repoPath: context.repoPath,
          files: scope.targets,
          scopeKind: scope.scopeKind,
        })
        if (disposed || currentFingerprint === fingerprint) return
        setResult((previous) => previous && previous.snapshotFingerprint === fingerprint
          ? { ...previous, stale: true, currentSnapshotFingerprint: String(currentFingerprint || 'unavailable') }
          : previous)
      } catch {
        if (!disposed) {
          setResult((previous) => previous && previous.snapshotFingerprint === fingerprint
            ? { ...previous, stale: true, currentSnapshotFingerprint: 'unavailable' }
            : previous)
        }
      } finally {
        checking = false
      }
    }
    const handleFocus = () => { void check() }
    void check()
    const timer = window.setInterval(check, REVIEW_STALE_CHECK_INTERVAL_MS)
    window.addEventListener('focus', handleFocus)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
    }
  }, [context?.repoPath, drawerOpen, result, scope])

  useEffect(() => () => {
    const requestId = activeRequestIdRef.current
    if (requestId) void invoke('cancel_ai_review_request', { requestId }).catch(() => {})
  }, [])

  const openPreview = async () => {
    if (!context?.repoPath || requestBusy) return
    setPreviewState({ open: true, loading: true, preview: null, error: null })
    try {
      let nextScope = readWorkingReviewScope(document)
      if (shouldRefreshWorkingSummary(nextScope, document)) {
        const latestSummary = await invoke('get_repo_working_diff_summary', { repoPath: context.repoPath })
        cacheWorkingSummary(context.repoPath, latestSummary)
        nextScope = readWorkingReviewScope(document)
      }
      if (nextScope.complete !== true) throw new Error('当前未提交改动的 authority 尚未准备好，请刷新后重试。')
      if (nextScope.targets.length === 0) throw new Error('当前没有可 Review 的未提交文件。')
      setScope(nextScope)
      const value = await invoke('preview_ai_review_scope', {
        repoPath: context.repoPath,
        files: nextScope.targets,
        scopeKind: nextScope.scopeKind,
      })
      setPreviewState({ open: true, loading: false, preview: normalizeAiReviewPreview(value), error: null })
    } catch (previewError) {
      setPreviewState({ open: true, loading: false, preview: null, error: normalizeAiError(previewError) })
    }
  }

  const runReview = async () => {
    if (!context?.repoPath || !scope?.targets?.length || requestBusy || !previewState.preview) return
    const requestId = createAiRequestId('review')
    activeRequestIdRef.current = requestId
    setPreviewState((previous) => ({ ...previous, open: false }))
    setDrawerOpen(true)
    setResult(null)
    setError(null)
    setRequest({ requestId, status: 'preparing', phase: 'starting', label: '正在启动 AI Review…', completedUnits: 0, totalUnits: previewState.preview.batchCount })
    try {
      const value = await invoke('run_ai_review', {
        requestId,
        repoPath: context.repoPath,
        files: scope.targets,
        scopeKind: scope.scopeKind,
      })
      if (activeRequestIdRef.current !== requestId) return
      const normalizedResult = normalizeAiReviewResult(value)
      setResult(normalizedResult)
      setRequest({
        requestId,
        status: 'completed',
        phase: normalizedResult.cacheHit ? 'cache-hit' : normalizedResult.partialSuccess ? 'partial-success' : 'completed',
        label: normalizedResult.cacheHit ? '已复用缓存的 AI Review' : normalizedResult.partialSuccess ? 'AI Review 已部分完成' : 'AI Review 已完成',
        completedUnits: normalizedResult.completedBatchCount,
        totalUnits: normalizedResult.batchCount,
      })
    } catch (reviewError) {
      if (activeRequestIdRef.current !== requestId) return
      const normalized = normalizeAiError(reviewError)
      setError(normalized)
      setRequest((previous) => ({
        ...previous,
        requestId,
        status: normalized.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        phase: normalized.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        label: normalized.code === 'AI_CANCELLED' ? 'AI Review 已取消' : normalized.title,
      }))
    } finally {
      if (activeRequestIdRef.current === requestId) activeRequestIdRef.current = ''
    }
  }

  const cancelReview = async () => {
    const requestId = activeRequestIdRef.current
    if (!requestId || !requestCancellable) return false
    setRequest((previous) => ({ ...previous, phase: 'cancelling', label: '正在取消 AI Review…' }))
    try {
      await invoke('cancel_ai_review_request', { requestId })
      return true
    } catch (cancelError) {
      setError(normalizeAiError(cancelError))
      return false
    }
  }

  const closeDrawer = async () => {
    if (requestBusy && !requestCancellable) return
    if (requestCancellable) await cancelReview()
    setDrawerOpen(false)
  }

  const toggleFilter = (severity) => {
    setFilters((previous) => {
      const next = new Set(previous)
      if (next.has(severity)) next.delete(severity)
      else next.add(severity)
      return next
    })
  }

  const copyReview = async () => {
    const text = formatAiReviewForClipboard(result)
    if (!text) return
    try {
      await invoke('write_clipboard', { text })
      setCopyState('已复制')
    } catch {
      setCopyState('复制失败')
    }
    window.setTimeout(() => setCopyState(''), 1600)
  }

  const toolbar = mountNode ? createPortal((
    <button type="button" className="working-changes-action ai-review-toolbar-button" onClick={openPreview} disabled={!configurationReady || requestBusy} data-app-tooltip={configurationReady ? 'Review 当前勾选文件；未勾选时 Review 全部文件' : '请先配置 AI Provider 和 Review 模型'}>
      <CanonicalReviewIcon />AI Review
    </button>
  ), mountNode) : null

  return (
    <>
      {toolbar}
      <PreviewDialog present={previewState.open} state={previewState} onClose={() => setPreviewState((previous) => ({ ...previous, open: false }))} onConfirm={runReview} />
      <ReviewDrawer present={drawerOpen} request={request} result={result} error={error} filters={filters} onToggleFilter={toggleFilter} onCancel={cancelReview} onClose={closeDrawer} onRerun={openPreview} onCopy={copyReview} copyState={copyState} />
    </>
  )
}
