import { readSelectedWorkingChangeScope } from './workingChangeScope.js'

export function normalizeAiCommitMessageResult(value) {
  const normalizeNotices = (items) => (Array.isArray(items) ? items : [])
    .map((item) => ({
      path: String(item?.path || '').trim(),
      reason: String(item?.reason || '').trim(),
    }))
    .filter((item) => item.path)

  return {
    requestId: String(value?.requestId || ''),
    message: String(value?.message || '').trim(),
    model: String(value?.model || ''),
    providerHost: String(value?.providerHost || ''),
    selectedFileCount: Math.max(0, Number(value?.selectedFileCount) || 0),
    includedFileCount: Math.max(0, Number(value?.includedFileCount) || 0),
    excludedFiles: normalizeNotices(value?.excludedFiles),
    summaryOnlyFiles: normalizeNotices(value?.summaryOnlyFiles),
    binaryFiles: normalizeNotices(value?.binaryFiles),
    sanitizedBytes: Math.max(0, Number(value?.sanitizedBytes) || 0),
    redactedLineCount: Math.max(0, Number(value?.redactedLineCount) || 0),
    recentSubjectCount: Math.max(0, Number(value?.recentSubjectCount) || 0),
    snapshotFingerprint: String(value?.snapshotFingerprint || ''),
  }
}

export function readSelectedCommitScope(root = document) {
  return readSelectedWorkingChangeScope(root)
}

export function readSelectedCommitTargets(root = document) {
  return readSelectedCommitScope(root).targets
}

export function shouldConfirmCommitMessageOverwrite(currentMessage, lastGeneratedMessage = '') {
  const current = String(currentMessage || '').trim()
  if (!current) return false
  return current !== String(lastGeneratedMessage || '').trim()
}

export function summarizeCommitGenerationCoverage(result) {
  const normalized = normalizeAiCommitMessageResult(result)
  const notes = [`${normalized.includedFileCount}/${normalized.selectedFileCount} 个文件包含完整 Diff`]
  if (normalized.summaryOnlyFiles.length > 0) notes.push(`${normalized.summaryOnlyFiles.length} 个仅使用摘要`)
  if (normalized.binaryFiles.length > 0) notes.push(`${normalized.binaryFiles.length} 个 Binary`)
  if (normalized.excludedFiles.length > 0) notes.push(`${normalized.excludedFiles.length} 个敏感文件已排除`)
  if (normalized.redactedLineCount > 0) notes.push(`${normalized.redactedLineCount} 行已脱敏`)
  return notes.join(' · ')
}
