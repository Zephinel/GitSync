import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import CustomSelect from '../CustomSelect.jsx'
import IntervalControl from '../IntervalControl.jsx'
import {
  AI_COMMIT_STYLE,
  AI_OUTPUT_LANGUAGE,
  AI_PROGRESS_EVENT,
  DEFAULT_AI_CONFIGURATION,
  MAX_AI_TIMEOUT_SECONDS,
  MIN_AI_TIMEOUT_SECONDS,
  buildAiConfigurationPayload,
  createAiRequestId,
  isAiRequestRunning,
  normalizeAiConfiguration,
  normalizeAiConfigurationStatus,
  normalizeAiError,
  normalizeAiModelListResult,
} from './aiSettings'
import { ensureAiSettingsMount, getAiSettingsObserverTarget } from './aiSettingsSectionUtils'
import './Ai.css'

const IDLE_REQUEST = Object.freeze({
  requestId: '',
  kind: '',
  status: 'idle',
  phase: '',
  label: '',
  result: null,
  error: null,
})

const NON_CANCELLABLE_REQUEST_PHASES = new Set(['saving', 'starting', 'cancelling'])

function Spinner() {
  return <span className="ai-spinner" aria-hidden="true" />
}

function SettingLabel({ title, description }) {
  return (
    <div className="settings__label ai-settings-label">
      {title}
      <small>{description}</small>
    </div>
  )
}

function RequestFeedback({ request }) {
  if (request.status === 'idle') return null
  const tone = request.status === 'completed'
    ? 'success'
    : request.status === 'failed'
      ? 'danger'
      : request.status === 'cancelled'
        ? 'neutral'
        : 'running'
  const modelCount = Array.isArray(request.result?.models) ? request.result.models.length : 0

  return (
    <div className={`ai-request-feedback ai-request-feedback--${tone}`} role="status" aria-live="polite">
      {isAiRequestRunning(request.status) ? <Spinner /> : <span className="ai-request-feedback__dot" aria-hidden="true" />}
      <div className="ai-request-feedback__main">
        <strong>{request.error?.title || request.label || 'AI 请求状态'}</strong>
        {request.error?.message ? <span>{request.error.message}</span> : null}
        {request.kind === 'connection-test' && request.result ? (
          <span>已连接 {request.result.providerHost} · {request.result.model} · {request.result.latencyMs} ms</span>
        ) : null}
        {request.kind === 'model-list' && request.result ? (
          <span>
            已从 {request.result.providerHost} 拉取 {modelCount} 个模型
            {request.result.truncated ? ' · 列表已按安全上限截断' : ''}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default function AiSettingsSection() {
  const [mountNode, setMountNode] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [status, setStatus] = useState(() => normalizeAiConfigurationStatus(DEFAULT_AI_CONFIGURATION))
  const [draft, setDraft] = useState(() => normalizeAiConfiguration(DEFAULT_AI_CONFIGURATION))
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [availableModels, setAvailableModels] = useState([])
  const [modelListMeta, setModelListMeta] = useState(null)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [request, setRequest] = useState(IDLE_REQUEST)
  const activeRequestIdRef = useRef('')
  const requestBusy = isAiRequestRunning(request.status)
  const requestCancellable = requestBusy && !NON_CANCELLABLE_REQUEST_PHASES.has(request.phase)
  const formDisabled = loading || saveBusy || requestBusy
  const canFetchModels = Boolean(draft.endpoint.trim() && (status.hasApiKey || apiKeyDraft.trim()))
  const canTestConnection = Boolean(draft.defaultModel.trim() && (status.hasApiKey || apiKeyDraft.trim()))

  const modelOptions = useMemo(() => {
    const options = availableModels.map((model) => ({ value: model, label: model }))
    if (draft.defaultModel && !availableModels.includes(draft.defaultModel)) {
      options.unshift({
        value: draft.defaultModel,
        label: `${draft.defaultModel} · 当前输入`,
      })
    }
    return options
  }, [availableModels, draft.defaultModel])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    let frameId = 0
    const updateMount = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        setMountNode(ensureAiSettingsMount())
      })
    }
    updateMount()
    const target = getAiSettingsObserverTarget()
    const observer = target ? new MutationObserver(updateMount) : null
    observer?.observe(target, { childList: true })
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      observer?.disconnect()
    }
  }, [])

  const loadConfiguration = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setSaveMessage('')
    try {
      const nextStatus = normalizeAiConfigurationStatus(await invoke('get_ai_configuration_status'))
      setStatus(nextStatus)
      setDraft(normalizeAiConfiguration(nextStatus))
      setAvailableModels([])
      setModelListMeta(null)
    } catch (error) {
      setLoadError(normalizeAiError(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!mountNode) return
    void loadConfiguration()
  }, [loadConfiguration, mountNode])

  useEffect(() => {
    let disposed = false
    let unlisten = null
    void listen(AI_PROGRESS_EVENT, (event) => {
      const progress = event.payload || {}
      if (!progress.requestId || progress.requestId !== activeRequestIdRef.current) return
      setRequest((previous) => ({
        ...previous,
        requestId: progress.requestId,
        kind: String(progress.kind || previous.kind),
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

  const updateDraft = (key, value) => {
    setSaveMessage('')
    setLoadError(null)
    if (key === 'endpoint') {
      setAvailableModels([])
      setModelListMeta(null)
    }
    setDraft((previous) => normalizeAiConfiguration({ ...previous, [key]: value }))
  }

  const updateApiKeyDraft = (value) => {
    setSaveMessage('')
    setLoadError(null)
    setApiKeyDraft(value)
    setAvailableModels([])
    setModelListMeta(null)
  }

  // The timeout uses the shared interval stepper with the unit locked to seconds.
  const clampTimeoutSeconds = (value) => {
    const parsed = Number.parseInt(String(value), 10)
    if (!Number.isFinite(parsed)) return DEFAULT_AI_CONFIGURATION.timeoutSeconds
    return Math.max(MIN_AI_TIMEOUT_SECONDS, Math.min(MAX_AI_TIMEOUT_SECONDS, parsed))
  }

  const stepTimeoutDraft = (delta) => {
    const current = clampTimeoutSeconds(draft.timeoutSeconds)
    updateDraft('timeoutSeconds', String(clampTimeoutSeconds(current + delta)))
  }

  const persistDraft = useCallback(async () => {
    const saved = normalizeAiConfigurationStatus(await invoke('save_ai_configuration', {
      config: buildAiConfigurationPayload(draft),
    }))
    setDraft(normalizeAiConfiguration(saved))
    if (apiKeyDraft.trim()) {
      await invoke('set_ai_api_key', { apiKey: apiKeyDraft.trim() })
      setApiKeyDraft('')
      const withKey = { ...saved, hasApiKey: true, configured: Boolean(saved.endpoint && saved.defaultModel) }
      setStatus(withKey)
      return withKey
    }
    setStatus(saved)
    return saved
  }, [apiKeyDraft, draft])

  const saveConfiguration = async () => {
    if (saveBusy || requestBusy) return
    setSaveBusy(true)
    setSaveMessage('')
    setLoadError(null)
    try {
      await persistDraft()
      setSaveMessage('AI 设置已保存。')
    } catch (error) {
      setLoadError(normalizeAiError(error))
    } finally {
      setSaveBusy(false)
    }
  }

  const clearApiKey = async () => {
    if (saveBusy || requestBusy || !status.hasApiKey) return
    setSaveBusy(true)
    setSaveMessage('')
    setLoadError(null)
    try {
      const clearedDraft = normalizeAiConfiguration({
        ...draft,
        defaultModel: '',
        reviewModel: '',
        commitModel: '',
      })
      await invoke('clear_ai_api_key')
      const saved = normalizeAiConfigurationStatus(await invoke('save_ai_configuration', {
        config: buildAiConfigurationPayload(clearedDraft),
      }))
      activeRequestIdRef.current = ''
      setRequest(IDLE_REQUEST)
      setApiKeyDraft('')
      setAvailableModels([])
      setModelListMeta(null)
      setDraft(normalizeAiConfiguration(saved))
      setStatus({ ...saved, hasApiKey: false, configured: false })
      setSaveMessage('API Key 和模型设置已清除。')
    } catch (error) {
      setLoadError(normalizeAiError(error))
    } finally {
      setSaveBusy(false)
    }
  }

  const fetchModels = async () => {
    if (saveBusy || requestBusy || !canFetchModels) return
    const requestId = createAiRequestId('models')
    activeRequestIdRef.current = requestId
    setRequest({
      ...IDLE_REQUEST,
      requestId,
      kind: 'model-list',
      status: 'preparing',
      phase: 'saving',
      label: '正在保存 Endpoint 和 API Key…',
    })
    setLoadError(null)
    setSaveMessage('')
    try {
      await persistDraft()
      if (activeRequestIdRef.current !== requestId) return
      setRequest((previous) => ({
        ...previous,
        status: 'preparing',
        phase: 'starting',
        label: '正在启动模型列表请求…',
      }))
      const result = normalizeAiModelListResult(await invoke('list_ai_models', { requestId }))
      if (activeRequestIdRef.current !== requestId) return
      setAvailableModels(result.models)
      setModelListMeta(result)
      setRequest({
        requestId,
        kind: 'model-list',
        status: 'completed',
        phase: 'completed',
        label: '模型列表已更新',
        result,
        error: null,
      })
    } catch (error) {
      if (activeRequestIdRef.current !== requestId) return
      const normalized = normalizeAiError(error)
      setRequest({
        requestId,
        kind: 'model-list',
        status: normalized.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        phase: normalized.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        label: normalized.title,
        result: null,
        error: normalized,
      })
    }
  }

  const testConnection = async () => {
    if (saveBusy || requestBusy || !canTestConnection) return
    const requestId = createAiRequestId('connection')
    activeRequestIdRef.current = requestId
    setRequest({
      ...IDLE_REQUEST,
      requestId,
      kind: 'connection-test',
      status: 'preparing',
      phase: 'saving',
      label: '正在保存并准备 AI 配置…',
    })
    setLoadError(null)
    setSaveMessage('')
    try {
      await persistDraft()
      if (activeRequestIdRef.current !== requestId) return
      setRequest((previous) => ({
        ...previous,
        status: 'preparing',
        phase: 'starting',
        label: '正在启动连接测试…',
      }))
      const result = await invoke('test_ai_connection', { requestId })
      if (activeRequestIdRef.current !== requestId) return
      setRequest({
        requestId,
        kind: 'connection-test',
        status: 'completed',
        phase: 'completed',
        label: '连接测试完成',
        result,
        error: null,
      })
    } catch (error) {
      if (activeRequestIdRef.current !== requestId) return
      const normalized = normalizeAiError(error)
      setRequest({
        requestId,
        kind: 'connection-test',
        status: normalized.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        phase: normalized.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        label: normalized.title,
        result: null,
        error: normalized,
      })
    }
  }

  const cancelRequest = async () => {
    const requestId = activeRequestIdRef.current
    if (!requestId || !requestCancellable) return
    setRequest((previous) => ({ ...previous, phase: 'cancelling', label: '正在取消 AI 请求…' }))
    try {
      await invoke('cancel_ai_request', { requestId })
    } catch (error) {
      setRequest((previous) => ({ ...previous, error: normalizeAiError(error) }))
    }
  }

  const configurationLabel = useMemo(() => {
    if (loading) return '正在读取…'
    if (status.configured) return '已配置'
    if (status.hasApiKey) return '等待选择模型'
    return '未配置'
  }, [loading, status.configured, status.hasApiKey])

  if (!mountNode) return null

  return createPortal((
    <section className="settings__section ai-settings-section" aria-labelledby="ai-settings-title">
      <div className="ai-settings-heading">
        <div>
          <h2 className="settings__section-title" id="ai-settings-title">AI</h2>
          <p>配置 OpenAI-compatible Provider，用于生成提交信息和 Review 未提交改动。</p>
        </div>
        <span className={`ai-config-badge ${status.configured ? 'ai-config-badge--ready' : ''}`}>{configurationLabel}</span>
      </div>

      {loadError ? (
        <div className="ai-inline-error" role="alert">
          <strong>{loadError.title}</strong>
          <span>{loadError.message}</span>
        </div>
      ) : null}

      <div className="settings__row ai-settings-row">
        <SettingLabel title="Provider Endpoint" description="填写 API 基础地址；远端服务必须使用 HTTPS，本地服务可使用 loopback HTTP。" />
        <div className="ai-settings-field">
          <input
            className="ai-settings-input"
            type="url"
            value={draft.endpoint}
            disabled={formDisabled}
            onChange={(event) => updateDraft('endpoint', event.target.value)}
            placeholder="https://api.openai.com/v1"
            aria-label="AI Provider Endpoint"
          />
        </div>
      </div>

      <div className="settings__row ai-settings-row">
        <SettingLabel title="API Key" description="只写入系统 Keychain；应用前端不会读取或回显已保存的明文 Key。" />
        <div className="ai-settings-field ai-key-control">
          <input
            className="ai-settings-input"
            type="password"
            value={apiKeyDraft}
            disabled={formDisabled}
            onChange={(event) => updateApiKeyDraft(event.target.value)}
            placeholder={status.hasApiKey ? '已安全保存；输入新 Key 可覆盖' : '输入 API Key'}
            autoComplete="off"
            aria-label="AI API Key"
          />
          <span className={`ai-key-status ${status.hasApiKey ? 'ai-key-status--ready' : ''}`}>
            {status.hasApiKey ? '已保存' : '未保存'}
          </span>
          <button
            type="button"
            className="ai-secondary-button ai-key-clear"
            onClick={clearApiKey}
            disabled={formDisabled || !status.hasApiKey}
            data-app-tooltip={status.hasApiKey ? '从系统 Keychain 清除 API Key 和模型设置' : '当前没有已保存的 API Key'}
          >
            清除
          </button>
        </div>
      </div>

      <div className="settings__row ai-settings-row">
        <SettingLabel title="默认模型" description="可手动输入；也可从 Provider 的 models 接口拉取后选择。" />
        <div className="ai-settings-field ai-model-picker">
          <div className="ai-model-picker__input-row">
            <input
              className="ai-settings-input"
              value={draft.defaultModel}
              disabled={formDisabled}
              onChange={(event) => updateDraft('defaultModel', event.target.value)}
              placeholder="输入或选择模型"
              aria-label="AI 默认模型"
            />
            <button
              type="button"
              className="ai-secondary-button ai-model-fetch"
              onClick={fetchModels}
              disabled={formDisabled || !canFetchModels}
              data-app-tooltip={canFetchModels ? '从当前 Provider 拉取模型列表' : '请先填写 Endpoint 和 API Key'}
            >
              {requestBusy && request.kind === 'model-list' ? <><Spinner />拉取中…</> : '拉取模型'}
            </button>
          </div>
          {modelOptions.length > 0 ? (
            <div className="ai-model-picker__selection">
              <CustomSelect
                value={draft.defaultModel}
                options={modelOptions}
                onChange={(value) => updateDraft('defaultModel', value)}
                ariaLabel="选择 AI 默认模型"
                className="ai-model-select"
                disabled={formDisabled}
                placeholder="从已拉取模型中选择"
                searchable
                searchPlaceholder="搜索模型"
                emptyText="没有匹配的模型"
              />
              <small>
                {modelListMeta
                  ? `${modelListMeta.providerHost} · ${availableModels.length} 个模型${modelListMeta.truncated ? ' · 已截断' : ''}`
                  : '当前输入不在已拉取列表中，仍可继续使用。'}
              </small>
            </div>
          ) : (
            <small className="ai-field-hint">模型列表不是所有 Provider 的强制能力；拉取失败时仍可手动输入。</small>
          )}
        </div>
      </div>

      <div className="settings__row ai-settings-row">
        <SettingLabel title="独立模型" description="Review 和提交信息可覆盖默认模型；留空时自动跟随默认模型。" />
        <div className="ai-settings-field ai-model-overrides">
          <label>
            <span>Review</span>
            <input className="ai-settings-input" value={draft.reviewModel} disabled={formDisabled} onChange={(event) => updateDraft('reviewModel', event.target.value)} placeholder="跟随默认模型" />
          </label>
          <label>
            <span>提交信息</span>
            <input className="ai-settings-input" value={draft.commitModel} disabled={formDisabled} onChange={(event) => updateDraft('commitModel', event.target.value)} placeholder="跟随默认模型" />
          </label>
        </div>
      </div>

      <div className="settings__row ai-settings-row">
        <SettingLabel title="输出语言" description="控制提交信息和 Review 的默认输出语言。" />
        <div className="mode-btn-group ai-settings-control" role="group" aria-label="AI 输出语言">
          {[
            [AI_OUTPUT_LANGUAGE.auto, '自动'],
            [AI_OUTPUT_LANGUAGE.zhCn, '中文'],
            [AI_OUTPUT_LANGUAGE.en, 'English'],
          ].map(([value, label]) => (
            <button type="button" key={value} disabled={formDisabled} className={`mode-btn ${draft.outputLanguage === value ? 'mode-btn--active' : ''}`} onClick={() => updateDraft('outputLanguage', value)} aria-pressed={draft.outputLanguage === value}>{label}</button>
          ))}
        </div>
      </div>

      <div className="settings__row ai-settings-row">
        <SettingLabel title="提交信息格式" description="Stage 2 会使用此设置生成可编辑的提交信息。" />
        <div className="mode-btn-group ai-settings-control" role="group" aria-label="AI 提交信息格式">
          <button type="button" disabled={formDisabled} className={`mode-btn ${draft.commitStyle === AI_COMMIT_STYLE.conventional ? 'mode-btn--active' : ''}`} onClick={() => updateDraft('commitStyle', AI_COMMIT_STYLE.conventional)} aria-pressed={draft.commitStyle === AI_COMMIT_STYLE.conventional}>Conventional</button>
          <button type="button" disabled={formDisabled} className={`mode-btn ${draft.commitStyle === AI_COMMIT_STYLE.plain ? 'mode-btn--active' : ''}`} onClick={() => updateDraft('commitStyle', AI_COMMIT_STYLE.plain)} aria-pressed={draft.commitStyle === AI_COMMIT_STYLE.plain}>简洁文本</button>
        </div>
      </div>

      <div className="settings__row ai-settings-row">
        <SettingLabel title="参考最近提交风格" description="只发送有限数量的 commit subject，不发送历史代码内容。" />
        <button type="button" disabled={formDisabled} className={`toggle ai-settings-toggle ${draft.useRecentCommitStyle ? 'toggle--active' : ''}`} onClick={() => updateDraft('useRecentCommitStyle', !draft.useRecentCommitStyle)} aria-pressed={draft.useRecentCommitStyle} aria-label="切换参考最近提交风格" />
      </div>

      <div className="settings__row ai-settings-row">
        <SettingLabel title="请求超时" description={`所有 AI 网络请求的 Rust 端硬超时，范围 ${MIN_AI_TIMEOUT_SECONDS}–${MAX_AI_TIMEOUT_SECONDS} 秒。`} />
        <IntervalControl
          unit="seconds"
          units={['seconds']}
          amountDraft={String(draft.timeoutSeconds ?? '')}
          onAmountDraftChange={(value) => updateDraft('timeoutSeconds', value)}
          onCommit={() => updateDraft('timeoutSeconds', String(clampTimeoutSeconds(draft.timeoutSeconds)))}
          onStep={stepTimeoutDraft}
          decreaseAriaLabel="减少 AI 请求超时"
          inputAriaLabel="AI 请求超时秒数"
          increaseAriaLabel="增加 AI 请求超时"
          disabled={formDisabled}
        />
      </div>

      <RequestFeedback request={request} />
      {saveMessage ? <div className="ai-save-message" role="status">{saveMessage}</div> : null}

      <div className="ai-settings-actions">
        <button type="button" className="ai-secondary-button" onClick={loadConfiguration} disabled={formDisabled}>重新读取</button>
        <button type="button" className="ai-secondary-button" onClick={saveConfiguration} disabled={formDisabled}>{saveBusy ? <><Spinner />保存中…</> : '保存设置'}</button>
        {requestCancellable ? (
          <button type="button" className="ai-danger-button" onClick={cancelRequest}>取消请求</button>
        ) : requestBusy ? (
          <button type="button" className="ai-primary-button" disabled><Spinner />{request.label || '处理中…'}</button>
        ) : (
          <button type="button" className="ai-primary-button" onClick={testConnection} disabled={loading || saveBusy || !canTestConnection} data-app-tooltip={canTestConnection ? '验证 Endpoint、API Key 和默认模型' : '请先保存 API Key 并选择默认模型'}>测试连接</button>
        )}
      </div>
    </section>
  ), mountNode)
}
