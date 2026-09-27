export const AI_PROGRESS_EVENT = 'ai://request-progress'

export const AI_OUTPUT_LANGUAGE = Object.freeze({
  auto: 'auto',
  zhCn: 'zh-CN',
  en: 'en',
})

export const AI_COMMIT_STYLE = Object.freeze({
  conventional: 'conventional',
  plain: 'plain',
})

export const MIN_AI_TIMEOUT_SECONDS = 5
export const MAX_AI_TIMEOUT_SECONDS = 300

export const DEFAULT_AI_CONFIGURATION = Object.freeze({
  endpoint: 'https://api.openai.com/v1',
  defaultModel: '',
  reviewModel: '',
  commitModel: '',
  outputLanguage: AI_OUTPUT_LANGUAGE.auto,
  commitStyle: AI_COMMIT_STYLE.conventional,
  useRecentCommitStyle: true,
  timeoutSeconds: 60,
})

function normalizeTimeoutForPersistence(value) {
  const timeout = Number.parseInt(String(value ?? DEFAULT_AI_CONFIGURATION.timeoutSeconds), 10)
  return Number.isFinite(timeout)
    ? Math.max(MIN_AI_TIMEOUT_SECONDS, Math.min(MAX_AI_TIMEOUT_SECONDS, timeout))
    : DEFAULT_AI_CONFIGURATION.timeoutSeconds
}

export function normalizeAiConfiguration(value) {
  const input = value && typeof value === 'object' ? value : {}
  const timeoutSeconds = typeof input.timeoutSeconds === 'string'
    ? input.timeoutSeconds
    : normalizeTimeoutForPersistence(input.timeoutSeconds)
  return {
    endpoint: String(input.endpoint ?? DEFAULT_AI_CONFIGURATION.endpoint).trim(),
    defaultModel: String(input.defaultModel ?? '').trim(),
    reviewModel: String(input.reviewModel ?? '').trim(),
    commitModel: String(input.commitModel ?? '').trim(),
    outputLanguage: Object.values(AI_OUTPUT_LANGUAGE).includes(input.outputLanguage)
      ? input.outputLanguage
      : AI_OUTPUT_LANGUAGE.auto,
    commitStyle: Object.values(AI_COMMIT_STYLE).includes(input.commitStyle)
      ? input.commitStyle
      : AI_COMMIT_STYLE.conventional,
    useRecentCommitStyle: input.useRecentCommitStyle !== false,
    timeoutSeconds,
  }
}

export function normalizeAiConfigurationStatus(value) {
  const config = normalizeAiConfiguration(value)
  return {
    ...config,
    timeoutSeconds: normalizeTimeoutForPersistence(config.timeoutSeconds),
    configured: Boolean(value?.configured),
    hasApiKey: Boolean(value?.hasApiKey),
  }
}

export function buildAiConfigurationPayload(value) {
  const normalized = normalizeAiConfiguration(value)
  return {
    ...normalized,
    reviewModel: normalized.reviewModel || null,
    commitModel: normalized.commitModel || null,
    timeoutSeconds: normalizeTimeoutForPersistence(normalized.timeoutSeconds),
  }
}

export function normalizeAiModelListResult(value) {
  const seen = new Set()
  const models = (Array.isArray(value?.models) ? value.models : [])
    .map((model) => String(model || '').trim())
    .filter((model) => {
      if (!model || seen.has(model)) return false
      seen.add(model)
      return true
    })
  return {
    requestId: String(value?.requestId || ''),
    providerHost: String(value?.providerHost || ''),
    models,
    truncated: Boolean(value?.truncated),
  }
}

export function createAiRequestId(kind = 'request') {
  const safeKind = String(kind || 'request').replace(/[^a-z0-9_-]/gi, '-').slice(0, 32) || 'request'
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `ai_${safeKind}_${Date.now().toString(36)}_${randomPart}`
}

export function normalizeAiError(error) {
  if (error && typeof error === 'object') {
    return {
      code: String(error.code || 'AI_INTERNAL'),
      title: String(error.title || 'AI 请求失败'),
      message: String(error.message || 'AI 请求失败，请稍后重试。'),
      retryable: Boolean(error.retryable),
      providerStatus: Number.isFinite(Number(error.providerStatus)) ? Number(error.providerStatus) : null,
      requestId: error.requestId ? String(error.requestId) : null,
    }
  }
  if (typeof error === 'string') {
    try {
      return normalizeAiError(JSON.parse(error))
    } catch {
      return {
        code: 'AI_INTERNAL',
        title: 'AI 请求失败',
        message: error,
        retryable: true,
        providerStatus: null,
        requestId: null,
      }
    }
  }
  return {
    code: 'AI_INTERNAL',
    title: 'AI 请求失败',
    message: 'AI 请求失败，请稍后重试。',
    retryable: true,
    providerStatus: null,
    requestId: null,
  }
}

export function isAiRequestRunning(status) {
  return ['preparing', 'running', 'validating', 'merging'].includes(String(status || ''))
}
