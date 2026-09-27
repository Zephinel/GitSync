import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_COMMIT_STYLE,
  AI_OUTPUT_LANGUAGE,
  buildAiConfigurationPayload,
  createAiRequestId,
  isAiRequestRunning,
  normalizeAiConfiguration,
  normalizeAiConfigurationStatus,
  normalizeAiError,
  normalizeAiModelListResult,
} from './aiSettings.js'

test('normalizes provider configuration without any API key field', () => {
  const normalized = normalizeAiConfiguration({
    endpoint: ' https://example.com/v1 ',
    defaultModel: ' model-a ',
    reviewModel: ' ',
    commitModel: ' commit-a ',
    outputLanguage: 'invalid',
    commitStyle: AI_COMMIT_STYLE.plain,
    timeoutSeconds: 999,
  })
  assert.deepEqual(normalized, {
    endpoint: 'https://example.com/v1',
    defaultModel: 'model-a',
    reviewModel: '',
    commitModel: 'commit-a',
    outputLanguage: AI_OUTPUT_LANGUAGE.auto,
    commitStyle: AI_COMMIT_STYLE.plain,
    useRecentCommitStyle: true,
    timeoutSeconds: 300,
  })
  assert.equal(Object.hasOwn(normalized, 'apiKey'), false)
})

test('keeps timeout drafts editable and clamps only at the command boundary', () => {
  assert.equal(normalizeAiConfiguration({ timeoutSeconds: '' }).timeoutSeconds, '')
  assert.equal(normalizeAiConfiguration({ timeoutSeconds: '1' }).timeoutSeconds, '1')
  assert.equal(buildAiConfigurationPayload({ timeoutSeconds: '' }).timeoutSeconds, 60)
  assert.equal(buildAiConfigurationPayload({ timeoutSeconds: '1' }).timeoutSeconds, 5)
  assert.equal(buildAiConfigurationPayload({ timeoutSeconds: '999' }).timeoutSeconds, 300)
})

test('builds nullable model overrides for the Rust command boundary', () => {
  const payload = buildAiConfigurationPayload({
    endpoint: 'https://example.com/v1',
    defaultModel: 'default',
    reviewModel: '',
    commitModel: 'commit',
  })
  assert.equal(payload.reviewModel, null)
  assert.equal(payload.commitModel, 'commit')
})

test('normalizes configuration status without exposing a secret', () => {
  const status = normalizeAiConfigurationStatus({
    configured: true,
    hasApiKey: true,
    endpoint: 'https://example.com/v1',
    defaultModel: 'model-a',
  })
  assert.equal(status.configured, true)
  assert.equal(status.hasApiKey, true)
  assert.equal(Object.hasOwn(status, 'apiKey'), false)
})

test('normalizes and deduplicates provider model lists', () => {
  const result = normalizeAiModelListResult({
    requestId: 'models-1',
    providerHost: 'example.com',
    models: [' model-b ', 'model-a', 'model-a', '', null],
    truncated: true,
  })
  assert.deepEqual(result.models, ['model-b', 'model-a'])
  assert.equal(result.providerHost, 'example.com')
  assert.equal(result.truncated, true)
})

test('creates command-safe unique-looking request identifiers', () => {
  const first = createAiRequestId('connection test')
  const second = createAiRequestId('connection test')
  assert.match(first, /^ai_connection-test_[a-z0-9]+_[a-z0-9]+$/)
  assert.notEqual(first, second)
})

test('normalizes structured and stringified UI errors', () => {
  const structured = normalizeAiError({ code: 'AI_TIMEOUT', title: 'Timeout', message: 'Later', retryable: true })
  assert.equal(structured.code, 'AI_TIMEOUT')
  assert.equal(structured.retryable, true)

  const stringified = normalizeAiError(JSON.stringify({ code: 'AI_CANCELLED', title: 'Cancelled', message: 'Stopped' }))
  assert.equal(stringified.code, 'AI_CANCELLED')
})

test('recognizes all long-running request phases', () => {
  for (const status of ['preparing', 'running', 'validating', 'merging']) {
    assert.equal(isAiRequestRunning(status), true)
  }
  assert.equal(isAiRequestRunning('completed'), false)
})
