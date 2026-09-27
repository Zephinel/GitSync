import { readWorkingChangeScope } from './workingChangeScope.js'

const RISK_VALUES = new Set(['low', 'medium', 'high', 'critical'])
const SEVERITY_VALUES = new Set(['P0', 'P1', 'P2', 'P3'])

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function normalizeNotice(value) {
  return {
    path: asText(value?.path),
    reason: asText(value?.reason),
  }
}

function normalizeBatchFailure(value) {
  return {
    batchIndex: asCount(value?.batchIndex),
    fileCount: asCount(value?.fileCount),
    code: asText(value?.code),
    message: asText(value?.message),
    retryable: value?.retryable === true,
  }
}

export function readWorkingReviewScope(root = document) {
  return readWorkingChangeScope(root)
}

export function normalizeAiReviewPreview(value) {
  const scopeKind = value?.scopeKind === 'selected' ? 'selected' : 'all'
  return {
    scopeKind,
    scopeLabel: asText(value?.scopeLabel) || (scopeKind === 'selected' ? '已勾选文件' : '全部未提交文件'),
    selectedFileCount: asCount(value?.selectedFileCount),
    includedFileCount: asCount(value?.includedFileCount),
    excludedFiles: Array.isArray(value?.excludedFiles) ? value.excludedFiles.map(normalizeNotice).filter((item) => item.path) : [],
    summaryOnlyFiles: Array.isArray(value?.summaryOnlyFiles) ? value.summaryOnlyFiles.map(normalizeNotice).filter((item) => item.path) : [],
    binaryFiles: Array.isArray(value?.binaryFiles) ? value.binaryFiles.map(normalizeNotice).filter((item) => item.path) : [],
    sanitizedBytes: asCount(value?.sanitizedBytes),
    redactedLineCount: asCount(value?.redactedLineCount),
    snapshotFingerprint: asText(value?.snapshotFingerprint),
    batchCount: Math.max(1, asCount(value?.batchCount)),
    batchFileLimit: asCount(value?.batchFileLimit),
    pipelineVersion: asText(value?.pipelineVersion),
  }
}

function normalizeFinding(value, index) {
  const severity = asText(value?.severity).toUpperCase()
  return {
    id: asText(value?.id) || `finding-${index + 1}`,
    severity: SEVERITY_VALUES.has(severity) ? severity : 'P3',
    title: asText(value?.title),
    file: asText(value?.file) || null,
    startLine: asCount(value?.startLine) || null,
    endLine: asCount(value?.endLine) || null,
    explanation: asText(value?.explanation),
    suggestion: asText(value?.suggestion) || null,
  }
}

export function normalizeAiReviewResult(value) {
  const risk = asText(value?.overallRisk).toLowerCase()
  const scopeKind = value?.scopeKind === 'selected' ? 'selected' : 'all'
  const selectedFileCount = asCount(value?.selectedFileCount)
  const batchCount = Math.max(1, asCount(value?.batchCount))
  const completedBatchCount = asCount(value?.completedBatchCount) || batchCount
  const completedFileCount = value?.completedFileCount == null
    ? selectedFileCount
    : Math.min(selectedFileCount, asCount(value.completedFileCount))
  return {
    requestId: asText(value?.requestId),
    model: asText(value?.model),
    providerHost: asText(value?.providerHost),
    summary: asText(value?.summary),
    overallRisk: RISK_VALUES.has(risk) ? risk : 'medium',
    findings: Array.isArray(value?.findings)
      ? value.findings.map(normalizeFinding).filter((finding) => finding.title && finding.explanation)
      : [],
    positiveNotes: Array.isArray(value?.positiveNotes) ? value.positiveNotes.map(asText).filter(Boolean) : [],
    testSuggestions: Array.isArray(value?.testSuggestions) ? value.testSuggestions.map(asText).filter(Boolean) : [],
    scopeKind,
    scopeLabel: asText(value?.scopeLabel) || (scopeKind === 'selected' ? '已勾选文件' : '全部未提交文件'),
    selectedFileCount,
    includedFileCount: asCount(value?.includedFileCount),
    excludedFiles: Array.isArray(value?.excludedFiles) ? value.excludedFiles.map(normalizeNotice).filter((item) => item.path) : [],
    summaryOnlyFiles: Array.isArray(value?.summaryOnlyFiles) ? value.summaryOnlyFiles.map(normalizeNotice).filter((item) => item.path) : [],
    binaryFiles: Array.isArray(value?.binaryFiles) ? value.binaryFiles.map(normalizeNotice).filter((item) => item.path) : [],
    sanitizedBytes: asCount(value?.sanitizedBytes),
    redactedLineCount: asCount(value?.redactedLineCount),
    snapshotFingerprint: asText(value?.snapshotFingerprint),
    currentSnapshotFingerprint: asText(value?.currentSnapshotFingerprint),
    stale: value?.stale === true,
    batchCount,
    completedBatchCount,
    completedFileCount,
    failedBatchCount: asCount(value?.failedBatchCount),
    partialSuccess: value?.partialSuccess === true,
    batchFailures: Array.isArray(value?.batchFailures)
      ? value.batchFailures.map(normalizeBatchFailure).filter((item) => item.code && item.message)
      : [],
    cacheHit: value?.cacheHit === true,
    pipelineVersion: asText(value?.pipelineVersion),
  }
}

export function formatAiReviewForClipboard(result) {
  if (!result) return ''
  const lines = [
    '# AI Review',
    '',
    `Risk: ${result.overallRisk}`,
    `Scope: ${result.scopeLabel} (${result.selectedFileCount} files)`,
    `Reviewed files: ${result.completedFileCount}/${result.selectedFileCount}`,
    `Batches: ${result.completedBatchCount}/${result.batchCount}${result.cacheHit ? ' (cache)' : ''}`,
    '',
    result.summary,
  ]
  if (result.partialSuccess && result.batchFailures.length > 0) {
    lines.push('', '## Partial coverage')
    result.batchFailures.forEach((failure) => {
      lines.push(`- Batch ${failure.batchIndex || '-'}: ${failure.code} — ${failure.message}`)
    })
  }
  if (result.findings.length > 0) {
    lines.push('', '## Findings')
    result.findings.forEach((finding) => {
      const location = finding.file
        ? `${finding.file}${finding.startLine ? `:${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ''}` : ''}`
        : 'Cross-file'
      lines.push('', `### ${finding.severity} · ${finding.title}`, location, finding.explanation)
      if (finding.suggestion) lines.push(`Suggestion: ${finding.suggestion}`)
    })
  }
  if (result.positiveNotes.length > 0) {
    lines.push('', '## Positive notes', ...result.positiveNotes.map((item) => `- ${item}`))
  }
  if (result.testSuggestions.length > 0) {
    lines.push('', '## Test suggestions', ...result.testSuggestions.map((item) => `- ${item}`))
  }
  return lines.join('\n').trim()
}

export function getReviewCoverageItems(value) {
  if (!value) return []
  return [
    ...value.excludedFiles.map((item) => ({ ...item, kind: 'excluded' })),
    ...value.summaryOnlyFiles.map((item) => ({ ...item, kind: 'summary' })),
    ...value.binaryFiles.map((item) => ({ ...item, kind: 'binary' })),
  ]
}
