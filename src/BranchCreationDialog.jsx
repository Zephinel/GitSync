import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  EMPTY_NAME_VALIDATION,
  buildAiSuggestionRevision,
  buildBranchCreationInputRevision,
  canConfirmBranchCreation,
  chooseInitialSourceOption,
  createBranchCreationRequestId,
  findSourceOption,
  normalizeAiBranchNameResult,
  normalizeBranchCreationInspection,
  normalizeBranchCreationOperation,
  normalizeBranchNameValidation,
  operationTone,
  relationshipLabel,
} from './branchCreationUtils.js'
import { CloseIcon as CanonicalCloseIcon } from './icons/CanonicalIcons.jsx'
import CanonicalCheckbox from './CanonicalCheckbox.jsx'
import './BranchCreationDialog.css'

const BRANCH_CREATION_PROGRESS_EVENT = 'branch-create://progress'
const AI_PROGRESS_EVENT = 'ai://request-progress'
const VALIDATION_DELAY_MS = 260
const NO_OPERATION_RECORD_MESSAGE = '找不到可确认的分支创建记录'

const IDLE_PHASE = Object.freeze({
  status: 'idle',
  phase: '',
  label: '',
})

function getErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return String(error.message)
  if (error?.title) return String(error.title)
  try { return JSON.stringify(error) } catch { return '未知错误' }
}

function getAiErrorMessage(error) {
  if (error && typeof error === 'object') {
    return [error.title, error.message].filter(Boolean).join('：') || 'AI 请求失败'
  }
  return getErrorMessage(error)
}

function shortCommit(value) {
  const commit = String(value || '').trim()
  return commit ? commit.slice(0, 12) : '—'
}

function operationTerminalPhase(operation) {
  return {
    status: operation?.status || 'unknown',
    phase: 'completed',
    label: operation?.message || '操作结果已更新',
  }
}

function Spinner() {
  return <span className="branch-creation-spinner" aria-hidden="true" />
}

function Toggle({ checked, disabled = false, label, description, onChange }) {
  return (
    <label className={`branch-creation-toggle ${disabled ? 'branch-creation-toggle--disabled' : ''}`}>
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      <span className="branch-creation-toggle__track" aria-hidden="true"><span /></span>
    </label>
  )
}

function FeedbackList({ title, values, tone = 'neutral' }) {
  if (!Array.isArray(values) || values.length === 0) return null
  return (
    <div className={`branch-creation-feedback branch-creation-feedback--${tone}`}>
      <strong>{title}</strong>
      <ul>{values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}</ul>
    </div>
  )
}

function ResultPanel({ operation }) {
  if (!operation) return null
  const tone = operationTone(operation.status)
  const title = operation.status === 'complete'
    ? '分支创建已完成'
    : operation.status === 'partial'
      ? '分支创建已部分完成'
      : operation.status === 'failed'
        ? '分支创建未完成'
        : '结果需要确认'

  return (
    <section className={`branch-creation-result branch-creation-result--${tone}`} aria-live="polite">
      <header>
        <span className="branch-creation-result__mark" aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <p>{operation.message}</p>
        </div>
      </header>
      <dl className="branch-creation-result__facts">
        <div><dt>请求 ID</dt><dd><code data-app-tooltip={operation.requestId}>{operation.requestId || '—'}</code></dd></div>
        <div><dt>新分支</dt><dd>{operation.branchName || '—'}</dd></div>
        <div><dt>来源提交</dt><dd><code data-app-tooltip={operation.sourceCommit}>{shortCommit(operation.sourceCommit)}</code></dd></div>
        <div><dt>当前实际分支</dt><dd>{operation.currentBranch || '无法确认'}</dd></div>
        <div><dt>工作区修改</dt><dd>{operation.worktreeIsDirty ? '仍有未提交修改' : '当前未检测到未提交修改'}</dd></div>
      </dl>
      <FeedbackList title="已完成" values={operation.completedSteps} tone="success" />
      <FeedbackList title="尚未完成" values={operation.pendingSteps} tone="warning" />
      <FeedbackList title="警告" values={operation.warnings} tone="warning" />
      <FeedbackList title="错误" values={operation.errors} tone="danger" />
      {operation.resultNeedsConfirmation ? (
        <p className="branch-creation-result__authority">
          当前不会猜测成功，也不会自动重放任何修改。请先刷新并确认真实结果。
        </p>
      ) : null}
    </section>
  )
}

function buildUnknownTransportOperation({
  requestId,
  branchName,
  selectedSource,
  inspection,
  publish,
  targetRemote,
  executeError,
  reconcileError,
}) {
  return normalizeBranchCreationOperation({
    requestId,
    status: 'unknown',
    branchName,
    sourceRef: selectedSource?.fullRef || '',
    sourceCommit: selectedSource?.commit || '',
    localCreated: false,
    switched: false,
    currentBranch: inspection?.currentBranch || null,
    worktreeWasDirty: Boolean(inspection?.worktreeDirty),
    worktreeIsDirty: Boolean(inspection?.worktreeDirty),
    remoteCreated: false,
    trackingConfigured: false,
    targetRemote: publish ? targetRemote : null,
    completedSteps: [],
    pendingSteps: ['本地创建、切换和远端发布的真实结果尚待确认'],
    retryableSteps: [],
    warnings: ['不会使用新的请求 ID重复创建，也不会自动重放任何仓库修改。'],
    errors: [
      `原请求返回失败：${executeError}`,
      `使用原请求 ID 对账也未完成：${reconcileError}`,
    ],
    resultNeedsConfirmation: true,
    message: '应用没有收到可确认结果；必须继续使用原请求 ID 刷新真实状态。',
  })
}

export default function BranchCreationDialog({ target, onClose, onBusyChange, onRepositoryChanged }) {
  const dialogRef = useRef(null)
  const nameInputRef = useRef(null)
  const inspectionRequestRef = useRef(0)
  const validationRequestRef = useRef(0)
  const aiRevisionRef = useRef('')
  const currentAiRevisionRef = useRef('')
  const activeAiRequestIdRef = useRef('')
  const aiFlightRef = useRef(false)
  const operationRequestIdRef = useRef('')
  const operationFlightRef = useRef(false)

  const [inspection, setInspection] = useState(null)
  const [inspectionBusy, setInspectionBusy] = useState(true)
  const [inspectionError, setInspectionError] = useState('')
  const [sourceOptionId, setSourceOptionId] = useState('')
  const [branchName, setBranchName] = useState('')
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true)
  const [publish, setPublish] = useState(false)
  const [targetRemote, setTargetRemote] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [includeRepositoryContext, setIncludeRepositoryContext] = useState(false)
  const [validation, setValidation] = useState(EMPTY_NAME_VALIDATION)
  const [validationRevision, setValidationRevision] = useState('')
  const [validationBusy, setValidationBusy] = useState(false)
  const [validationError, setValidationError] = useState('')
  const [aiSuggestions, setAiSuggestions] = useState([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiPhase, setAiPhase] = useState(IDLE_PHASE)
  const [operation, setOperation] = useState(null)
  const [operationBusy, setOperationBusy] = useState(false)
  const [operationError, setOperationError] = useState('')
  const [operationPhase, setOperationPhase] = useState({
    status: 'preparing',
    phase: 'confirming-source',
    label: '正在确认来源分支的当前真实状态…',
  })

  const repoPath = target?.context?.repoPath || ''
  const repoName = target?.context?.repoName || 'Repository'
  const source = target?.source || { kind: 'auto', name: '', displayName: '' }
  const selectedSource = useMemo(
    () => findSourceOption(inspection, sourceOptionId),
    [inspection, sourceOptionId]
  )

  const currentValidationRevision = useMemo(() => buildBranchCreationInputRevision({
    inspectionFingerprint: inspection?.fingerprint,
    sourceOptionId,
    branchName,
    publish,
    remote: targetRemote,
    taskDescription,
    includeRepositoryContext,
  }), [
    branchName,
    includeRepositoryContext,
    inspection?.fingerprint,
    publish,
    sourceOptionId,
    targetRemote,
    taskDescription,
  ])

  const currentAiRevision = useMemo(() => buildAiSuggestionRevision({
    inspectionFingerprint: inspection?.fingerprint,
    sourceOptionId,
    taskDescription,
    includeRepositoryContext,
    publish,
    remote: targetRemote,
  }), [
    includeRepositoryContext,
    inspection?.fingerprint,
    publish,
    sourceOptionId,
    targetRemote,
    taskDescription,
  ])

  currentAiRevisionRef.current = currentAiRevision

  const stopAiRequestLocally = useCallback((label = 'AI 请求已取消') => {
    const requestId = activeAiRequestIdRef.current
    activeAiRequestIdRef.current = ''
    aiRevisionRef.current = ''
    aiFlightRef.current = false
    setAiBusy(false)
    setAiSuggestions([])
    setAiError('')
    setAiPhase({ status: 'cancelled', phase: 'cancelled', label })
    if (requestId) {
      void invoke('cancel_ai_branch_name_request', { requestId }).catch(() => {})
    }
  }, [])

  const loadInspection = useCallback(async ({ resetDraft = false } = {}) => {
    const activeAiRequestId = activeAiRequestIdRef.current
    if (activeAiRequestId || aiFlightRef.current) {
      stopAiRequestLocally('来源正在重新确认，旧 AI 请求已取消')
    }
    validationRequestRef.current += 1
    const requestNumber = ++inspectionRequestRef.current
    setInspectionBusy(true)
    setInspectionError('')
    setOperationError('')
    setOperationPhase({
      status: 'preparing',
      phase: 'confirming-source',
      label: '正在确认来源分支、远端状态和工作区…',
    })
    setValidation(EMPTY_NAME_VALIDATION)
    setValidationRevision('')
    setValidationError('')
    setAiSuggestions([])
    setAiError('')
    aiRevisionRef.current = ''

    if (resetDraft) {
      setBranchName('')
      setSwitchAfterCreate(true)
      setPublish(false)
      setTargetRemote('')
      setTaskDescription('')
      setIncludeRepositoryContext(false)
      setOperation(null)
    }

    try {
      const raw = await invoke('inspect_repo_branch_creation', { path: repoPath, source })
      if (requestNumber !== inspectionRequestRef.current) return
      const next = normalizeBranchCreationInspection(raw)
      if (!next.fingerprint || next.sourceOptions.length === 0) {
        throw new Error('没有可用的创建起点，请刷新仓库状态后重试。')
      }
      setInspection(next)
      setSourceOptionId(chooseInitialSourceOption(next))
      setTargetRemote((previous) => {
        if (previous && next.remotes.includes(previous)) return previous
        return next.preferredRemote || next.remotes[0] || ''
      })
      setOperationPhase({ status: 'ready', phase: 'source-confirmed', label: '来源状态已确认' })
    } catch (error) {
      if (requestNumber !== inspectionRequestRef.current) return
      setInspection(null)
      setSourceOptionId('')
      setInspectionError(getErrorMessage(error))
      setOperationPhase({ status: 'failed', phase: 'source-failed', label: '无法确认来源状态' })
    } finally {
      if (requestNumber === inspectionRequestRef.current) setInspectionBusy(false)
    }
  }, [repoPath, source.displayName, source.kind, source.name, stopAiRequestLocally])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.focus?.({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    void loadInspection({ resetDraft: true })
    return () => {
      inspectionRequestRef.current += 1
      validationRequestRef.current += 1
    }
  }, [loadInspection])

  useEffect(() => {
    onBusyChange?.(operationBusy)
    return () => onBusyChange?.(false)
  }, [onBusyChange, operationBusy])

  useEffect(() => {
    let disposed = false
    let unlistenOperation = null
    let unlistenAi = null

    void listen(BRANCH_CREATION_PROGRESS_EVENT, (event) => {
      if (disposed) return
      const progress = event.payload || {}
      if (!progress.requestId || progress.requestId !== operationRequestIdRef.current) return
      setOperationPhase({
        status: String(progress.status || 'running'),
        phase: String(progress.phase || ''),
        label: String(progress.label || '正在处理…'),
      })
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlistenOperation = cleanup
    }).catch(() => {})

    void listen(AI_PROGRESS_EVENT, (event) => {
      if (disposed) return
      const progress = event.payload || {}
      if (!progress.requestId || progress.requestId !== activeAiRequestIdRef.current) return
      if (progress.kind && progress.kind !== 'branch-name') return
      setAiPhase({
        status: String(progress.status || 'running'),
        phase: String(progress.phase || ''),
        label: String(progress.label || '正在生成建议…'),
      })
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlistenAi = cleanup
    }).catch(() => {})

    return () => {
      disposed = true
      unlistenOperation?.()
      unlistenAi?.()
    }
  }, [])

  useEffect(() => () => {
    const requestId = activeAiRequestIdRef.current
    activeAiRequestIdRef.current = ''
    aiFlightRef.current = false
    if (requestId) void invoke('cancel_ai_branch_name_request', { requestId }).catch(() => {})
  }, [])

  useEffect(() => {
    const revision = currentAiRevision
    if (aiRevisionRef.current && revision !== aiRevisionRef.current) {
      stopAiRequestLocally('输入或仓库状态已变化，旧 AI 建议已作废')
    }
  }, [currentAiRevision, stopAiRequestLocally])

  useEffect(() => {
    const requestNumber = ++validationRequestRef.current
    const normalizedName = branchName.trim()
    setValidation(EMPTY_NAME_VALIDATION)
    setValidationRevision('')
    setValidationError('')

    if (!inspection || !selectedSource || !normalizedName || operation) {
      setValidationBusy(false)
      return undefined
    }

    setValidationBusy(true)
    const timer = window.setTimeout(() => {
      void invoke('validate_repo_branch_creation_name', {
        path: repoPath,
        request: { name: normalizedName, publish, remote: targetRemote || null },
      }).then((raw) => {
        if (requestNumber !== validationRequestRef.current) return
        setValidation(normalizeBranchNameValidation(raw))
        setValidationRevision(currentValidationRevision)
      }).catch((error) => {
        if (requestNumber !== validationRequestRef.current) return
        setValidationError(getErrorMessage(error))
      }).finally(() => {
        if (requestNumber === validationRequestRef.current) setValidationBusy(false)
      })
    }, VALIDATION_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [
    branchName,
    currentValidationRevision,
    inspection,
    operation,
    publish,
    repoPath,
    selectedSource,
    targetRemote,
  ])

  useEffect(() => {
    if (!inspectionBusy && inspection && !operation) {
      window.requestAnimationFrame(() => nameInputRef.current?.focus())
    }
  }, [inspection, inspectionBusy, operation])

  const canConfirm = canConfirmBranchCreation({
    inspection,
    sourceOptionId,
    validation,
    validationRevision,
    currentRevision: currentValidationRevision,
    busy: inspectionBusy || validationBusy || operationBusy,
  })

  const cancelAiSuggestions = useCallback(() => {
    if (!activeAiRequestIdRef.current && !aiFlightRef.current) return
    stopAiRequestLocally('AI 请求已取消；手动创建仍可继续')
  }, [stopAiRequestLocally])

  const generateAiSuggestions = useCallback(async () => {
    const task = taskDescription.trim()
    if (aiFlightRef.current || !inspection || !selectedSource) return
    if (task.length < 3) {
      setAiError('请先填写至少 3 个字符的任务描述。')
      return
    }
    if (publish && !targetRemote) {
      setAiError('发布已开启，请先选择目标远端。')
      return
    }

    aiFlightRef.current = true
    const requestId = createBranchCreationRequestId('branch-name')
    const revision = currentAiRevision
    activeAiRequestIdRef.current = requestId
    aiRevisionRef.current = revision
    setAiBusy(true)
    setAiError('')
    setAiSuggestions([])
    setAiPhase({ status: 'preparing', phase: 'starting', label: '正在启动 AI 分支命名…' })

    try {
      const raw = await invoke('generate_ai_branch_names', {
        request: {
          requestId,
          repoPath,
          repoName,
          taskDescription: task,
          sourceType: `${selectedSource.kind}:${inspection.relationship}`,
          includeRepositoryContext,
        },
      })
      if (
        activeAiRequestIdRef.current !== requestId
        || revision !== aiRevisionRef.current
        || revision !== currentAiRevisionRef.current
      ) return

      const generated = normalizeAiBranchNameResult(raw)
      const accepted = []
      for (const suggestion of generated.suggestions) {
        const candidateRaw = await invoke('validate_repo_branch_creation_name', {
          path: repoPath,
          request: { name: suggestion.name, publish, remote: targetRemote || null },
        })
        if (
          activeAiRequestIdRef.current !== requestId
          || revision !== aiRevisionRef.current
          || revision !== currentAiRevisionRef.current
        ) return
        const candidateValidation = normalizeBranchNameValidation(candidateRaw)
        if (candidateValidation.valid) accepted.push(suggestion)
      }

      if (accepted.length === 0) {
        throw new Error('AI 返回的候选名称均未通过当前仓库的正常名称验证。')
      }
      setAiSuggestions(accepted)
      setAiPhase({ status: 'completed', phase: 'completed', label: `已生成 ${accepted.length} 个经过验证的建议` })
    } catch (error) {
      if (activeAiRequestIdRef.current !== requestId) return
      setAiError(getAiErrorMessage(error))
      setAiPhase({ status: 'failed', phase: 'failed', label: 'AI 分支命名未完成' })
    } finally {
      if (activeAiRequestIdRef.current === requestId) {
        activeAiRequestIdRef.current = ''
        aiFlightRef.current = false
        setAiBusy(false)
      }
    }
  }, [
    currentAiRevision,
    includeRepositoryContext,
    inspection,
    publish,
    repoName,
    repoPath,
    selectedSource,
    targetRemote,
    taskDescription,
  ])

  const recoverAfterExecuteError = useCallback(async ({
    requestId,
    executeError,
    requestedBranchName,
  }) => {
    setOperationPhase({
      status: 'validating',
      phase: 'reconciling-lost-response',
      label: '请求返回失败，正在使用原请求 ID确认真实结果…',
    })
    try {
      const raw = await invoke('reconcile_repo_branch_creation', { path: repoPath, requestId })
      const next = normalizeBranchCreationOperation(raw)
      setOperation(next)
      setOperationPhase(operationTerminalPhase(next))
      setOperationError('')
      await onRepositoryChanged?.(next.branchName)
      return
    } catch (reconcileFailure) {
      const reconcileMessage = getErrorMessage(reconcileFailure)
      if (reconcileMessage.includes(NO_OPERATION_RECORD_MESSAGE)) {
        setOperation(null)
        await onRepositoryChanged?.('')
        await loadInspection({ resetDraft: false })
        setOperationError(executeError)
        setOperationPhase({
          status: 'failed',
          phase: 'not-accepted',
          label: '仓库未发现持久化操作记录；已刷新来源与名称状态',
        })
        return
      }
      const unknown = buildUnknownTransportOperation({
        requestId,
        branchName: requestedBranchName,
        selectedSource,
        inspection,
        publish,
        targetRemote,
        executeError,
        reconcileError: reconcileMessage,
      })
      setOperation(unknown)
      setOperationError('')
      setOperationPhase(operationTerminalPhase(unknown))
      await onRepositoryChanged?.(unknown.branchName)
    }
  }, [inspection, loadInspection, onRepositoryChanged, publish, repoPath, selectedSource, targetRemote])

  const executeBranchCreation = useCallback(async () => {
    if (!canConfirm || !inspection || !selectedSource || operationFlightRef.current) return
    operationFlightRef.current = true
    const requestId = createBranchCreationRequestId()
    const requestedBranchName = validation.normalizedName || branchName.trim()
    operationRequestIdRef.current = requestId
    setOperationBusy(true)
    setOperationError('')
    setOperationPhase({ status: 'validating', phase: 'confirming-source', label: '正在执行前重新确认来源和名称…' })

    try {
      const raw = await invoke('execute_repo_branch_creation', {
        path: repoPath,
        request: {
          requestId,
          source,
          inspectionFingerprint: inspection.fingerprint,
          sourceOptionId,
          sourceRef: selectedSource.fullRef,
          sourceCommit: selectedSource.commit,
          branchName: requestedBranchName,
          switchAfterCreate,
          publish,
          targetRemote: publish ? targetRemote : null,
        },
      })
      const next = normalizeBranchCreationOperation(raw)
      setOperation(next)
      setOperationPhase(operationTerminalPhase(next))
      if (next.localCreated || next.remoteCreated || next.switched || next.resultNeedsConfirmation) {
        await onRepositoryChanged?.(next.branchName)
      }
    } catch (error) {
      await recoverAfterExecuteError({
        requestId,
        executeError: getErrorMessage(error),
        requestedBranchName,
      })
    } finally {
      operationRequestIdRef.current = ''
      operationFlightRef.current = false
      setOperationBusy(false)
    }
  }, [
    branchName,
    canConfirm,
    inspection,
    onRepositoryChanged,
    publish,
    recoverAfterExecuteError,
    repoPath,
    selectedSource,
    source,
    sourceOptionId,
    switchAfterCreate,
    targetRemote,
    validation.normalizedName,
  ])

  const runResultCommand = useCallback(async (command) => {
    if (!operation?.requestId || operationFlightRef.current) return
    operationFlightRef.current = true
    const requestId = operation.requestId
    operationRequestIdRef.current = requestId
    setOperationBusy(true)
    setOperationError('')
    setOperationPhase({
      status: 'validating',
      phase: command === 'resume_repo_branch_creation' ? 'reconciling-retry' : 'reconciling-result',
      label: command === 'resume_repo_branch_creation'
        ? '正在确认状态并重试尚未完成部分…'
        : '正在刷新并确认原操作的真实结果…',
    })
    try {
      const raw = await invoke(command, { path: repoPath, requestId })
      const next = normalizeBranchCreationOperation(raw)
      setOperation(next)
      setOperationPhase(operationTerminalPhase(next))
      await onRepositoryChanged?.(next.branchName)
    } catch (error) {
      setOperationError(getErrorMessage(error))
      setOperationPhase({
        status: 'failed',
        phase: 'result-command-failed',
        label: '状态确认未完成；原结果仍然保留',
      })
    } finally {
      operationRequestIdRef.current = ''
      operationFlightRef.current = false
      setOperationBusy(false)
    }
  }, [onRepositoryChanged, operation, repoPath])

  const handleClose = useCallback(async () => {
    if (operationFlightRef.current) return
    const requestId = activeAiRequestIdRef.current
    activeAiRequestIdRef.current = ''
    aiRevisionRef.current = ''
    aiFlightRef.current = false
    if (requestId) await invoke('cancel_ai_branch_name_request', { requestId }).catch(() => {})
    onBusyChange?.(false)
    onClose?.()
  }, [onBusyChange, onClose])

  const handleDialogKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      event.nativeEvent?.stopImmediatePropagation?.()
      void handleClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'
    ) || []).filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const closeLabel = operation?.status === 'complete' ? '完成' : '关闭并保留结果'
  const validationIsCurrent = validationRevision === currentValidationRevision

  return (
    <div
      data-overlay-motion="backdrop"
      className="branch-creation-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void handleClose()
      }}
    >
      <section
        data-overlay-motion="surface"
        ref={dialogRef}
        className="branch-creation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-creation-title"
        aria-describedby="branch-creation-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="branch-creation-dialog__header">
          <div>
            <span className="branch-creation-dialog__eyebrow">创建新分支</span>
            <h2 id="branch-creation-title">基于 {source.displayName || source.name} 创建</h2>
            <p id="branch-creation-description">{repoName} · {repoPath}</p>
          </div>
          <button
            type="button"
            className="branch-creation-icon-button"
            onClick={() => void handleClose()}
            disabled={operationBusy}
            aria-label="关闭创建分支对话框"
            data-app-tooltip={operationBusy ? '当前已确认的仓库操作结束后才能关闭' : '关闭'}
          >
            <CanonicalCloseIcon />
          </button>
        </header>

        <div className="branch-creation-dialog__progress" role="status" aria-live="polite">
          {(inspectionBusy || validationBusy || operationBusy) ? <Spinner /> : <span className="branch-creation-progress-dot" aria-hidden="true" />}
          <span>{operationPhase.label}</span>
        </div>

        <div className="branch-creation-dialog__body">
          {operation ? (
            <>
              <ResultPanel operation={operation} />
              {operationError ? <FeedbackList title="操作错误" values={[operationError]} tone="danger" /> : null}
            </>
          ) : (
            <>
              <section className="branch-creation-section" aria-labelledby="branch-creation-source-title">
                <div className="branch-creation-section__heading">
                  <div>
                    <h3 id="branch-creation-source-title">创建来源</h3>
                    <p>点击的分支代表来源意图；执行前仍会重新确认当前真实状态。</p>
                  </div>
                  <button
                    type="button"
                    className="branch-creation-link-button"
                    onClick={() => void loadInspection({ resetDraft: false })}
                    disabled={inspectionBusy || operationBusy}
                  >
                    {inspectionBusy ? '确认中…' : '重新确认来源'}
                  </button>
                </div>

                {inspectionBusy && !inspection ? (
                  <div className="branch-creation-loading"><Spinner />正在读取来源、远端和工作区状态…</div>
                ) : null}
                {inspectionError ? <FeedbackList title="无法确认来源" values={[inspectionError]} tone="danger" /> : null}

                {inspection ? (
                  <>
                    <dl className="branch-creation-source-facts">
                      <div><dt>用户点击</dt><dd>{inspection.sourceDisplayName}</dd></div>
                      <div><dt>来源类型</dt><dd>{inspection.sourceKind === 'remote' ? '远端分支' : '本地分支'}</dd></div>
                      <div><dt>当前关系</dt><dd>{relationshipLabel(inspection)}</dd></div>
                      <div><dt>当前工作区</dt><dd>{inspection.currentBranch || 'Detached HEAD'}</dd></div>
                    </dl>

                    {inspection.sourceOptions.length > 1 ? (
                      <fieldset className="branch-creation-source-options">
                        <legend>{inspection.requiresSourceChoice ? '本地与远端已分叉，请明确选择创建起点' : '选择创建起点'}</legend>
                        {inspection.sourceOptions.map((option) => (
                          <label
                            key={option.id}
                            className={`branch-creation-source-option ${sourceOptionId === option.id ? 'branch-creation-source-option--selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name="branch-creation-source"
                              value={option.id}
                              checked={sourceOptionId === option.id}
                              onChange={() => setSourceOptionId(option.id)}
                            />
                            <span>
                              <strong>{option.label}</strong>
                              <small>{option.fullRef}</small>
                              <code data-app-tooltip={option.commit}>{shortCommit(option.commit)}</code>
                            </span>
                            {option.recommended ? <em>建议</em> : null}
                          </label>
                        ))}
                      </fieldset>
                    ) : selectedSource ? (
                      <div className="branch-creation-source-option branch-creation-source-option--static">
                        <span>
                          <strong>{selectedSource.label}</strong>
                          <small>{selectedSource.fullRef}</small>
                          <code data-app-tooltip={selectedSource.commit}>{shortCommit(selectedSource.commit)}</code>
                        </span>
                      </div>
                    ) : (
                      <div className="branch-creation-feedback branch-creation-feedback--warning">
                        <strong>需要选择来源</strong>
                        <p>当前没有默认创建起点，确认前必须明确选择。</p>
                      </div>
                    )}

                    <p className="branch-creation-authority-note">
                      来源分支不会被修改。本流程不会同步、更新、切换、合并、变基、重置或改变来源分支的远端关系。
                    </p>
                    <FeedbackList title="来源提示" values={inspection.warnings} tone="warning" />
                  </>
                ) : null}
              </section>

              <section className="branch-creation-section" aria-labelledby="branch-creation-name-title">
                <div className="branch-creation-section__heading">
                  <div>
                    <h3 id="branch-creation-name-title">新分支名称</h3>
                    <p>手动输入始终可用；AI 不是创建分支的前置条件。</p>
                  </div>
                </div>
                <label className="branch-creation-field">
                  <span>分支名称</span>
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                    placeholder="例如 fix/branch-refresh"
                    autoComplete="off"
                    spellCheck="false"
                    disabled={operationBusy}
                    aria-describedby="branch-name-validation"
                  />
                </label>
                <div id="branch-name-validation" className="branch-creation-validation" aria-live="polite">
                  {validationBusy ? <><Spinner />正在按当前来源和发布选项验证名称…</> : null}
                  {!validationBusy && validationError ? <span className="branch-creation-validation--danger">{validationError}</span> : null}
                  {!validationBusy && branchName.trim() && validationIsCurrent && validation.valid ? (
                    <span className="branch-creation-validation--success">名称可用：{validation.normalizedName}</span>
                  ) : null}
                </div>
                {validationIsCurrent ? (
                  <>
                    <FeedbackList title="名称问题" values={validation.errors} tone="danger" />
                    <FeedbackList title="名称提示" values={validation.warnings} tone="warning" />
                  </>
                ) : null}
              </section>

              <section className="branch-creation-section branch-creation-ai" aria-labelledby="branch-creation-ai-title">
                <div className="branch-creation-section__heading">
                  <div>
                    <h3 id="branch-creation-ai-title">AI 名称建议（可选）</h3>
                    <p>AI 只能建议名称，不能选择来源、切换、发布、远端或执行任何 Git 操作。</p>
                  </div>
                </div>
                <label className="branch-creation-field">
                  <span>任务描述</span>
                  <textarea
                    value={taskDescription}
                    onChange={(event) => setTaskDescription(event.target.value)}
                    placeholder="说明当前要处理的任务；不使用 AI 时可以留空"
                    rows={3}
                    maxLength={4000}
                    disabled={operationBusy}
                  />
                </label>
                <CanonicalCheckbox
                  className="branch-creation-consent"
                  checked={includeRepositoryContext}
                  onChange={setIncludeRepositoryContext}
                  disabled={operationBusy || aiBusy}
                  label="使用有限仓库命名上下文"
                >
                  <span>
                    <strong>使用有限仓库命名上下文</strong>
                    <small>默认关闭。开启后只读取并发送最多 12 个现有分支名称样本；不会发送代码、Diff、文件内容、文件路径或提交内容。</small>
                  </span>
                </CanonicalCheckbox>
                <div className="branch-creation-ai__actions">
                  {aiBusy ? (
                    <button type="button" className="branch-creation-button branch-creation-button--danger" onClick={cancelAiSuggestions}>
                      取消 AI 请求
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="branch-creation-button"
                      onClick={generateAiSuggestions}
                      disabled={!inspection || !selectedSource || taskDescription.trim().length < 3 || operationBusy}
                    >
                      获取 AI 建议
                    </button>
                  )}
                  {aiPhase.label ? <span className="branch-creation-ai__phase">{aiBusy ? <Spinner /> : null}{aiPhase.label}</span> : null}
                </div>
                {aiError ? <FeedbackList title="AI 建议不可用" values={[aiError]} tone="danger" /> : null}
                {aiSuggestions.length > 0 ? (
                  <div className="branch-creation-suggestions" aria-label="经过验证的 AI 分支名称建议">
                    {aiSuggestions.map((suggestion) => {
                      const selected = branchName.trim() === suggestion.name
                      return (
                        <button
                          key={suggestion.name}
                          type="button"
                          className={`branch-creation-suggestion ${selected ? 'branch-creation-suggestion--selected' : ''}`}
                          aria-pressed={selected}
                          onClick={() => setBranchName(suggestion.name)}
                          disabled={operationBusy}
                        >
                          <strong>{suggestion.name}</strong>
                          <span>{suggestion.reason}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </section>

              <section className="branch-creation-section" aria-labelledby="branch-creation-options-title">
                <div className="branch-creation-section__heading">
                  <div>
                    <h3 id="branch-creation-options-title">创建选项</h3>
                    <p>创建、切换和发布是独立结果，界面会分别报告。</p>
                  </div>
                </div>
                <div className="branch-creation-option-grid">
                  <Toggle
                    checked={switchAfterCreate}
                    onChange={setSwitchAfterCreate}
                    disabled={operationBusy}
                    label="创建后切换"
                    description="默认开启。工作区有修改时，切换可能被 Git 拒绝。"
                  />
                  <Toggle
                    checked={publish}
                    onChange={setPublish}
                    disabled={operationBusy}
                    label="发布到远端"
                    description="默认关闭。只有明确开启后才会创建新远端分支。"
                  />
                </div>

                {publish ? (
                  <label className="branch-creation-field">
                    <span>目标远端</span>
                    <select
                      value={targetRemote}
                      onChange={(event) => setTargetRemote(event.target.value)}
                      disabled={operationBusy || inspection?.remotes?.length === 0}
                    >
                      <option value="">请选择远端</option>
                      {(inspection?.remotes || []).map((remote) => <option key={remote} value={remote}>{remote}</option>)}
                    </select>
                    <small>将创建 {targetRemote || '所选远端'}/{branchName.trim() || '新分支名'}，不会继承来源分支的 upstream。</small>
                  </label>
                ) : null}

                {inspection?.worktreeDirty ? (
                  <div className="branch-creation-feedback branch-creation-feedback--warning">
                    <strong>当前工作区有 {inspection.changedPathCount || '未确认数量的'} 项未提交修改</strong>
                    <p>只创建不会改变当前文件、暂存状态或当前分支。创建并切换时，当前修改可能会被带到新分支；如果切换会影响这些修改，Git 可能拒绝切换。</p>
                  </div>
                ) : null}
              </section>

              <section className="branch-creation-section branch-creation-preview" aria-labelledby="branch-creation-preview-title">
                <h3 id="branch-creation-preview-title">最终操作预览</h3>
                <dl>
                  <div><dt>新分支</dt><dd>{validation.normalizedName || branchName.trim() || '尚未填写'}</dd></div>
                  <div><dt>创建来源</dt><dd>{selectedSource?.fullRef || '尚未选择'}</dd></div>
                  <div><dt>来源提交</dt><dd><code data-app-tooltip={selectedSource?.commit}>{shortCommit(selectedSource?.commit)}</code></dd></div>
                  <div><dt>创建后切换</dt><dd>{switchAfterCreate ? '是' : '否，只创建'}</dd></div>
                  <div><dt>发布到远端</dt><dd>{publish ? `${targetRemote || '尚未选择'}/${validation.normalizedName || branchName.trim() || '新分支名'}` : '否'}</dd></div>
                </dl>
                <p>来源分支不会被修改；不会自动执行合并、变基、重置、提交、Cherry-pick 或其他额外操作。</p>
              </section>

              {operationError ? <FeedbackList title="创建未开始或已安全停止" values={[operationError]} tone="danger" /> : null}
            </>
          )}
        </div>

        <footer className="branch-creation-dialog__footer">
          {operation ? (
            <>
              <button
                type="button"
                className="branch-creation-button"
                onClick={() => void runResultCommand('reconcile_repo_branch_creation')}
                disabled={operationBusy}
              >
                刷新并确认真实结果
              </button>
              {operation.retryableSteps.length > 0 && !operation.resultNeedsConfirmation ? (
                <button
                  type="button"
                  className="branch-creation-button branch-creation-button--primary"
                  onClick={() => void runResultCommand('resume_repo_branch_creation')}
                  disabled={operationBusy}
                >
                  {operationBusy ? '处理中…' : '重试未完成部分'}
                </button>
              ) : null}
              <button
                type="button"
                className="branch-creation-button"
                onClick={() => void handleClose()}
                disabled={operationBusy}
              >
                {closeLabel}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="branch-creation-button"
                onClick={() => void handleClose()}
                disabled={operationBusy}
              >
                取消
              </button>
              <button
                type="button"
                className="branch-creation-button branch-creation-button--primary"
                onClick={() => void executeBranchCreation()}
                disabled={!canConfirm}
              >
                {operationBusy ? <><Spinner />处理中…</> : '确认创建分支'}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
