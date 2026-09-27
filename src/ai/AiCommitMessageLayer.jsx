import { useEffect, useMemo, useRef, useState } from 'react'
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
  normalizeAiCommitMessageResult,
  readSelectedCommitScope,
  readSelectedCommitTargets,
  shouldConfirmCommitMessageOverwrite,
  summarizeCommitGenerationCoverage,
} from './aiCommitMessage'
import { cacheWorkingSummary } from './workingChangeScope.js'
import './AiCommitMessageLayer.css'

const WORKING_CHANGES_CONTEXT_EVENT = 'gitsync:working-changes-context'
const WORKING_CHANGES_CONTEXT_KEY = '__gitsyncWorkingChangesContext'
const MOUNT_CLASS = 'ai-commit-message-mount'
const DIALOG_CLASS = 'working-changes-dialog--ai-commit'
const NON_CANCELLABLE_PHASES = new Set(['starting', 'cancelling'])

const IDLE_REQUEST = Object.freeze({
  requestId: '',
  status: 'idle',
  phase: '',
  label: '',
})

function Spinner() {
  return <span className="ai-commit-spinner" aria-hidden="true" />
}

function findCommitDialog() {
  const textarea = document.querySelector('.working-changes-dialog textarea[aria-label="提交信息"]')
  const dialog = textarea?.closest('.working-changes-dialog')
  return dialog && textarea ? { dialog, textarea } : null
}

function ensureCommitMount(dialog, textarea) {
  dialog.classList.add(DIALOG_CLASS)
  let mount = dialog.querySelector(`:scope > .${MOUNT_CLASS}`)
  if (!mount) {
    mount = document.createElement('div')
    mount.className = MOUNT_CLASS
    textarea.before(mount)
  }
  return mount
}

function setControlledTextareaValue(textarea, value) {
  if (!(textarea instanceof HTMLTextAreaElement)) return
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
  descriptor?.set?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.dispatchEvent(new Event('change', { bubbles: true }))
  textarea.focus()
  textarea.setSelectionRange(value.length, value.length)
}

function coverageDetails(result) {
  return [
    ...result.excludedFiles,
    ...result.summaryOnlyFiles,
    ...result.binaryFiles,
  ]
}

export default function AiCommitMessageLayer() {
  const [mountNode, setMountNode] = useState(null)
  const [dialogNode, setDialogNode] = useState(null)
  const [textareaNode, setTextareaNode] = useState(null)
  const [context, setContext] = useState(null)
  const [targets, setTargets] = useState([])
  const [messageValue, setMessageValue] = useState('')
  const [configurationReady, setConfigurationReady] = useState(false)
  const [configurationLoading, setConfigurationLoading] = useState(false)
  const [request, setRequest] = useState(IDLE_REQUEST)
  const [result, setResult] = useState(null)
  const [pendingResult, setPendingResult] = useState(null)
  const [error, setError] = useState(null)
  const [overwriteMode, setOverwriteMode] = useState('')
  const activeRequestIdRef = useRef('')
  const lastGeneratedMessageRef = useRef('')
  const requestBusy = isAiRequestRunning(request.status)
  const requestCancellable = requestBusy && !NON_CANCELLABLE_PHASES.has(request.phase)

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    let frame = 0
    const sync = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const match = findCommitDialog()
        if (!match) {
          setMountNode(null)
          setDialogNode(null)
          setTextareaNode(null)
          setTargets([])
          return
        }
        setDialogNode(match.dialog)
        setTextareaNode(match.textarea)
        setMountNode(ensureCommitMount(match.dialog, match.textarea))
        setMessageValue(match.textarea.value)
        setTargets(readSelectedCommitTargets(document))
        setContext(window[WORKING_CHANGES_CONTEXT_KEY] || null)
      })
    }

    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['checked', 'disabled', 'aria-label'],
    })
    const handleChange = (event) => {
      if (event.target === textareaNode || event.target?.matches?.('.working-changes-checkbox input')) sync()
    }
    const handleInput = (event) => {
      if (!event.target?.matches?.('.working-changes-dialog textarea[aria-label="提交信息"]')) return
      const nextValue = event.target.value
      setMessageValue(nextValue)
      if (nextValue.trim() !== lastGeneratedMessageRef.current.trim()) {
        setResult(null)
        if (!activeRequestIdRef.current) {
          setPendingResult(null)
          setOverwriteMode('')
          setError(null)
          setRequest(IDLE_REQUEST)
        }
      }
    }
    const handleContext = (event) => setContext(event.detail || null)
    document.addEventListener('change', handleChange, true)
    document.addEventListener('input', handleInput, true)
    window.addEventListener(WORKING_CHANGES_CONTEXT_EVENT, handleContext)
    sync()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('change', handleChange, true)
      document.removeEventListener('input', handleInput, true)
      window.removeEventListener(WORKING_CHANGES_CONTEXT_EVENT, handleContext)
    }
  }, [textareaNode])

  useEffect(() => {
    if (!mountNode) {
      const activeRequestId = activeRequestIdRef.current
      if (activeRequestId) void invoke('cancel_ai_request', { requestId: activeRequestId }).catch(() => {})
      activeRequestIdRef.current = ''
      setRequest(IDLE_REQUEST)
      setResult(null)
      setPendingResult(null)
      setError(null)
      setOverwriteMode('')
      lastGeneratedMessageRef.current = ''
      return
    }

    let cancelled = false
    setConfigurationLoading(true)
    void invoke('get_ai_configuration_status')
      .then((status) => {
        if (cancelled) return
        setConfigurationReady(Boolean(
          status?.hasApiKey
            && status?.endpoint
            && (status?.commitModel || status?.defaultModel)
        ))
      })
      .catch(() => {
        if (!cancelled) setConfigurationReady(false)
      })
      .finally(() => {
        if (!cancelled) setConfigurationLoading(false)
      })
    return () => { cancelled = true }
  }, [mountNode])

  useEffect(() => {
    let disposed = false
    let unlisten = null
    void listen(AI_PROGRESS_EVENT, (event) => {
      const progress = event.payload || {}
      if (!progress.requestId || progress.requestId !== activeRequestIdRef.current) return
      setRequest((previous) => ({
        ...previous,
        requestId: String(progress.requestId),
        status: String(progress.status || previous.status),
        phase: String(progress.phase || previous.phase),
        label: String(progress.label || previous.label),
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
    if (!dialogNode || !textareaNode) return
    const confirmButton = dialogNode.querySelector('footer .working-changes-dialog__primary')
    if (!(confirmButton instanceof HTMLButtonElement)) return
    if (requestBusy || pendingResult) {
      confirmButton.dataset.aiCommitGenerationBusy = 'true'
      confirmButton.disabled = true
      return
    }
    if (confirmButton.dataset.aiCommitGenerationBusy === 'true') {
      delete confirmButton.dataset.aiCommitGenerationBusy
      confirmButton.disabled = textareaNode.disabled || !textareaNode.value.trim()
    }
  }, [dialogNode, messageValue, pendingResult, requestBusy, textareaNode])

  useEffect(() => () => {
    const activeRequestId = activeRequestIdRef.current
    if (activeRequestId) void invoke('cancel_ai_request', { requestId: activeRequestId }).catch(() => {})
  }, [])

  const coverageSummary = useMemo(() => result ? summarizeCommitGenerationCoverage(result) : '', [result])
  const selectedDomCount = typeof document === 'undefined' ? 0 : readSelectedCommitScope(document).selectedCount
  const canGenerate = Boolean(
    mountNode
      && context?.repoPath
      && (targets.length > 0 || selectedDomCount > 0)
      && configurationReady
      && !configurationLoading
      && !requestBusy
      && !pendingResult
      && !textareaNode?.disabled
  )

  const applyGeneratedResult = (generatedResult) => {
    setControlledTextareaValue(textareaNode, generatedResult.message)
    lastGeneratedMessageRef.current = generatedResult.message
    setMessageValue(generatedResult.message)
    setResult(generatedResult)
    setPendingResult(null)
    setOverwriteMode('')
    setError(null)
    setRequest({
      requestId: generatedResult.requestId,
      status: 'completed',
      phase: 'completed',
      label: '提交信息已生成',
    })
  }

  const startGeneration = async () => {
    if (!canGenerate) return
    const selectedScope = readSelectedCommitScope(document)
    if (!context?.repoPath || selectedScope.selectedCount === 0 || !textareaNode) return
    setOverwriteMode('')
    setPendingResult(null)
    setError(null)
    const requestId = createAiRequestId('commit-message')
    const startMessage = textareaNode.value
    activeRequestIdRef.current = requestId
    setRequest({
      requestId,
      status: 'preparing',
      phase: 'starting',
      label: '正在启动提交信息生成…',
    })
    try {
      let freshScope = selectedScope
      if (!freshScope.complete) {
        const latestSummary = await invoke('get_repo_working_diff_summary', { repoPath: context.repoPath })
        cacheWorkingSummary(context.repoPath, latestSummary)
        freshScope = readSelectedCommitScope(document)
      }
      if (!freshScope.complete || freshScope.targets.length === 0) {
        throw new Error('当前未提交改动的 authority 尚未准备好，请刷新后重试。')
      }
      const freshTargets = freshScope.targets
      setTargets(freshTargets)
      const response = await invoke('generate_ai_commit_message', {
        requestId,
        repoPath: context.repoPath,
        files: freshTargets,
      })
      if (activeRequestIdRef.current !== requestId) return
      const normalized = normalizeAiCommitMessageResult(response)
      if (!normalized.message) throw new Error('AI 没有返回可用的提交信息。')
      setResult(normalized)
      if (textareaNode.value !== startMessage) {
        setPendingResult(normalized)
        setOverwriteMode('apply-result')
        setRequest({
          requestId,
          status: 'completed',
          phase: 'awaiting-apply',
          label: '已生成，但未覆盖生成期间的手动修改',
        })
      } else {
        applyGeneratedResult(normalized)
      }
    } catch (requestError) {
      if (activeRequestIdRef.current !== requestId) return
      const normalizedError = normalizeAiError(requestError)
      setError(normalizedError)
      setRequest({
        requestId,
        status: normalizedError.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        phase: normalizedError.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        label: normalizedError.code === 'AI_CANCELLED' ? '生成已取消' : normalizedError.title,
      })
    } finally {
      if (activeRequestIdRef.current === requestId) activeRequestIdRef.current = ''
    }
  }

  const requestGeneration = () => {
    if (!canGenerate) return
    if (shouldConfirmCommitMessageOverwrite(messageValue, lastGeneratedMessageRef.current)) {
      setOverwriteMode('before-generation')
      return
    }
    void startGeneration()
  }

  const cancelGeneration = async () => {
    const requestId = activeRequestIdRef.current
    if (!requestId || !requestCancellable) return
    setRequest((previous) => ({ ...previous, label: '正在取消生成…', phase: 'cancelling' }))
    try {
      await invoke('cancel_ai_request', { requestId })
    } catch (cancelError) {
      setError(normalizeAiError(cancelError))
    }
  }

  const keepExistingMessage = () => {
    setPendingResult(null)
    setResult(null)
    setOverwriteMode('')
    setError(null)
    setRequest(IDLE_REQUEST)
  }

  if (!mountNode) return null

  const details = result ? coverageDetails(result) : []
  return createPortal((
    <div className="ai-commit-control" aria-label="AI 提交信息生成">
      <div className="ai-commit-control__bar">
        <div className="ai-commit-control__copy">
          <strong>AI 提交信息</strong>
          <span>
            {configurationLoading
              ? '正在读取 AI 配置…'
              : configurationReady
                ? `严格使用当前选中的 ${targets.length} 个文件`
                : '请先在设置中配置 Endpoint、API Key 和模型'}
          </span>
        </div>
        <div className="ai-commit-control__actions">
          {requestCancellable ? (
            <button type="button" className="ai-commit-button ai-commit-button--danger" onClick={cancelGeneration}>取消生成</button>
          ) : requestBusy ? (
            <button type="button" className="ai-commit-button ai-commit-button--primary" disabled><Spinner />处理中…</button>
          ) : (
            <button type="button" className="ai-commit-button ai-commit-button--primary" onClick={requestGeneration} disabled={!canGenerate}>
              {lastGeneratedMessageRef.current ? '重新生成' : 'AI 生成'}
            </button>
          )}
        </div>
      </div>

      {overwriteMode === 'before-generation' ? (
        <div className="ai-commit-overwrite" role="alert">
          <span>当前提交信息包含手动内容，继续会在生成完成后覆盖它。</span>
          <button type="button" onClick={() => setOverwriteMode('')}>保留现有内容</button>
          <button type="button" className="ai-commit-overwrite__confirm" onClick={() => void startGeneration()}>覆盖并生成</button>
        </div>
      ) : null}

      {overwriteMode === 'apply-result' && pendingResult ? (
        <div className="ai-commit-overwrite" role="alert">
          <span>生成期间提交信息被修改，生成结果尚未应用。</span>
          <button type="button" onClick={keepExistingMessage}>保留现有内容</button>
          <button type="button" className="ai-commit-overwrite__confirm" onClick={() => applyGeneratedResult(pendingResult)}>应用生成结果</button>
        </div>
      ) : null}

      {request.status !== 'idle' ? (
        <div className={`ai-commit-status ai-commit-status--${request.status}`} role="status" aria-live="polite">
          {requestBusy ? <Spinner /> : <span className="ai-commit-status__dot" aria-hidden="true" />}
          <div>
            <strong>{request.label}</strong>
            {result ? <span>{coverageSummary}</span> : null}
            {error ? <span>{error.message}</span> : null}
          </div>
        </div>
      ) : null}

      {details.length > 0 ? (
        <details className="ai-commit-coverage">
          <summary>查看输入覆盖范围</summary>
          <ul>{details.map((item) => <li key={`${item.path}:${item.reason}`}><code>{item.path}</code><span>{item.reason}</span></li>)}</ul>
        </details>
      ) : null}
    </div>
  ), mountNode)
}
