import { gitPathIdentity, optionalGitPathIdentity } from './gitPathIdentity.js'

const STAGING_STATES = new Set(['staged', 'unstaged', 'mixed', 'untracked', 'conflicted', 'clean'])
const RESULT_TONES = Object.freeze({
  complete: 'success',
  partial: 'warning',
  stale: 'warning',
  needs_confirmation: 'warning',
  failed: 'danger',
})

function normalizeText(value) {
  return String(value ?? '').trim()
}

function pathIdentity(value) {
  return gitPathIdentity(value)
}

function statusCode(value) {
  const raw = String(value ?? '')
  return raw.length > 0 ? raw.slice(0, 1) : ' '
}

function mutationAuthority(value) {
  return String(value ?? '')
}

export function logicalFileKey(file) {
  const path = pathIdentity(file?.path)
  const oldPath = pathIdentity(file?.old_path ?? file?.oldPath)
  return `${oldPath}\0${path}`
}

export function stagingEntryIdentity(file) {
  const path = pathIdentity(file?.path)
  const oldPath = optionalGitPathIdentity(file?.old_path ?? file?.oldPath)
  const indexCode = statusCode(file?.index_code ?? file?.indexCode)
  const worktreeCode = statusCode(file?.worktree_code ?? file?.worktreeCode)
  const isUntracked = Boolean(file?.is_untracked ?? file?.isUntracked)
  return JSON.stringify([oldPath, path, indexCode, worktreeCode, isUntracked])
}

function normalizeStagingFile(file, index) {
  const path = pathIdentity(file?.path)
  const oldPath = optionalGitPathIdentity(file?.old_path ?? file?.oldPath)
  const indexCode = statusCode(file?.index_code ?? file?.indexCode)
  const worktreeCode = statusCode(file?.worktree_code ?? file?.worktreeCode)
  const isUntracked = Boolean(file?.is_untracked ?? file?.isUntracked)
  const stagingState = STAGING_STATES.has(file?.staging_state)
    ? file.staging_state
    : (file?.is_conflicted ? 'conflicted' : isUntracked ? 'untracked' : 'clean')
  const logicalId = logicalFileKey({ path, old_path: oldPath })
  const entryId = stagingEntryIdentity({
    path,
    old_path: oldPath,
    index_code: indexCode,
    worktree_code: worktreeCode,
    is_untracked: isUntracked,
  })

  return {
    ...file,
    authority_id: mutationAuthority(file?.id),
    status_authority_id: mutationAuthority(file?.id),
    id: path ? entryId : `staging:${stagingState}:${index}`,
    logical_id: logicalId,
    path,
    old_path: oldPath,
    index_code: indexCode,
    worktree_code: worktreeCode,
    staging_state: stagingState,
    has_staged_changes: Boolean(file?.has_staged_changes),
    has_unstaged_changes: Boolean(file?.has_unstaged_changes),
    is_untracked: isUntracked,
    is_conflicted: Boolean(file?.is_conflicted),
    can_stage: Boolean(file?.can_stage),
    can_unstage: Boolean(file?.can_unstage),
  }
}

function normalizeWorkingFile(file, index) {
  const path = pathIdentity(file?.path)
  const oldPath = optionalGitPathIdentity(file?.old_path ?? file?.oldPath)
  const indexCode = statusCode(file?.index_code ?? file?.indexCode)
  const worktreeCode = statusCode(file?.worktree_code ?? file?.worktreeCode)
  const isUntracked = Boolean(file?.is_untracked ?? file?.isUntracked)
  const entryId = stagingEntryIdentity({
    path,
    old_path: oldPath,
    index_code: indexCode,
    worktree_code: worktreeCode,
    is_untracked: isUntracked,
  })
  return {
    ...file,
    authority_id: mutationAuthority(file?.id),
    id: path ? entryId : `working:${index}`,
    path,
    old_path: oldPath,
    index_code: indexCode,
    worktree_code: worktreeCode,
    is_untracked: isUntracked,
    entry_id: entryId,
  }
}

function exactStatusIndex(files) {
  const buckets = new Map()
  files.forEach((file) => {
    const key = stagingEntryIdentity(file)
    const bucket = buckets.get(key) || []
    bucket.push(file)
    buckets.set(key, bucket)
  })
  return buckets
}

function findWorkingFile(stagingFile, exact) {
  const exactMatches = exact.get(stagingEntryIdentity(stagingFile)) || []
  if (exactMatches.length !== 1) return null
  const workingFile = exactMatches[0]
  if (stagingFile.authority_id && stagingFile.authority_id !== workingFile.authority_id) return null
  return workingFile
}

export function buildWorkingChangesViewModel(workingSummary, stagingSnapshot) {
  const workingFiles = Array.isArray(workingSummary?.files)
    ? workingSummary.files.map(normalizeWorkingFile)
    : []
  const stagingFiles = Array.isArray(stagingSnapshot?.files)
    ? stagingSnapshot.files.map(normalizeStagingFile)
    : []

  const exactWorking = exactStatusIndex(workingFiles)
  const matchedWorkingIds = new Set()
  let stagingOnlyCount = 0

  const files = stagingFiles.map((stagingFile) => {
    const workingFile = findWorkingFile(stagingFile, exactWorking)
    if (workingFile) matchedWorkingIds.add(workingFile.id)
    else stagingOnlyCount += 1

    return {
      ...(workingFile || {}),
      ...stagingFile,
      authority_id: workingFile?.authority_id || '',
      additions: Number(workingFile?.additions) || 0,
      deletions: Number(workingFile?.deletions) || 0,
      is_binary: Boolean(workingFile?.is_binary),
      is_too_large: Boolean(workingFile?.is_too_large),
      diff_available: Boolean(workingFile),
    }
  })

  const workingOnlyCount = workingFiles.filter((file) => !matchedWorkingIds.has(file.id)).length
  const workingHead = normalizeText(workingSummary?.full_hash ?? workingSummary?.fullHash)
  const stagingHead = normalizeText(stagingSnapshot?.head_hash ?? stagingSnapshot?.headHash)
  const headMatches = workingHead === stagingHead
  const contentAuthorityReady = files.every((file) => Boolean(file.authority_id))
  const isConsistent = headMatches && workingOnlyCount === 0 && stagingOnlyCount === 0 && contentAuthorityReady

  return {
    ...workingSummary,
    repo_path: normalizeText(stagingSnapshot?.repo_path) || normalizeText(workingSummary?.repo_path),
    branch: stagingSnapshot?.branch ?? null,
    detached_head: Boolean(stagingSnapshot?.detached_head),
    head_hash: stagingSnapshot?.head_hash ?? null,
    snapshot_id: normalizeText(stagingSnapshot?.snapshot_id),
    working_snapshot_id: normalizeText(workingSummary?.snapshot_id ?? workingSummary?.snapshotId),
    files_changed: Number(stagingSnapshot?.files_changed) || files.length,
    files_truncated: Boolean(stagingSnapshot?.files_truncated),
    staged_files: Number(stagingSnapshot?.staged_files) || 0,
    unstaged_files: Number(stagingSnapshot?.unstaged_files) || 0,
    mixed_files: Number(stagingSnapshot?.mixed_files) || 0,
    untracked_files: Number(stagingSnapshot?.untracked_files) || 0,
    conflicted_files: Number(stagingSnapshot?.conflicted_files) || 0,
    files,
    consistency: {
      is_consistent: isConsistent,
      head_matches: headMatches,
      working_only_count: workingOnlyCount,
      staging_only_count: stagingOnlyCount,
    },
  }
}

export function getStagingStateLabel(state) {
  switch (state) {
    case 'staged': return '已暂存'
    case 'unstaged': return '未暂存'
    case 'mixed': return '部分暂存'
    case 'untracked': return '未跟踪'
    case 'conflicted': return '冲突'
    default: return '无改动'
  }
}

export function getStagingStateDescription(file) {
  switch (file?.staging_state) {
    case 'staged': return '该文件的当前改动已进入暂存区。'
    case 'unstaged': return '该文件的当前改动尚未进入暂存区。'
    case 'mixed': return '该文件同时包含已暂存和未暂存改动。'
    case 'untracked': return '这是一个尚未被 Git 跟踪的新文件。'
    case 'conflicted': return '该文件仍有未解决冲突，不能使用普通 Stage / Unstage。'
    default: return '当前没有可操作的暂存区改动。'
  }
}

export function canRunStagingOperation(file, operation) {
  if (file?.is_conflicted || file?.staging_state === 'conflicted') return false
  if (operation === 'stage') return Boolean(file?.can_stage)
  if (operation === 'unstage') return Boolean(file?.can_unstage)
  return false
}

export function canDiscardUnstaged(file) {
  if (file?.is_conflicted || file?.staging_state === 'conflicted') return false
  return Boolean(file?.can_stage)
}

export const FILE_CELL_MINUS = Object.freeze({
  unstage: 'unstage',
  discardUnstaged: 'discard-unstaged',
  discardUntracked: 'discard-untracked',
  choose: 'choose-minus',
})

/*
 * File-cell quick-action presentation contract.
 *
 * One consolidated mixed cell carries both layers, so its minus action is a
 * secondary-action entry (choose-minus) instead of a third slot. Direct minus
 * actions always carry an explicit operation type; the glyph is never the
 * semantic authority.
 */
export function resolveFileCellActions(file, { authorityReady = true } = {}) {
  if (!authorityReady) return { canStage: false, minus: null }
  const path = file?.path || ''
  const choices = []
  if (canRunStagingOperation(file, 'unstage')) {
    choices.push({
      operation: FILE_CELL_MINUS.unstage,
      tone: 'unstage',
      title: `取消暂存 ${path}`,
      ariaLabel: `取消暂存 ${path}`,
    })
  }
  if (canDiscardUnstaged(file)) {
    const untracked = Boolean(file?.is_untracked)
    choices.push({
      operation: untracked ? FILE_CELL_MINUS.discardUntracked : FILE_CELL_MINUS.discardUnstaged,
      tone: 'discard',
      title: untracked ? `删除未跟踪文件 ${path}` : `丢弃 ${path} 的未暂存改动`,
      ariaLabel: untracked ? `删除未跟踪文件 ${path}` : `丢弃 ${path} 的未暂存改动`,
    })
  }

  const minus = choices.length === 0 ? null : choices.length === 1 ? choices[0] : {
    operation: FILE_CELL_MINUS.choose,
    tone: 'minus',
    title: `${path} 同时包含已暂存与未暂存改动，可选择取消暂存或丢弃未暂存改动`,
    ariaLabel: `${path} 存在多个减除操作：取消暂存或丢弃未暂存改动`,
    choices,
  }

  return {
    canStage: canRunStagingOperation(file, 'stage'),
    minus,
  }
}

export function selectStagingCandidates(files, operation) {
  if (!Array.isArray(files)) return []
  return files.filter((file) => canRunStagingOperation(file, operation))
}

export function buildStagingTargets(files, operation) {
  return selectStagingCandidates(files, operation).map((file) => ({
    path: file.path,
    oldPath: file.old_path ?? null,
    expectedIndexCode: file.index_code,
    expectedWorktreeCode: file.worktree_code,
    expectedAuthorityId: mutationAuthority(file?.authority_id ?? file?.authorityId ?? file?.id),
  }))
}

export function buildWorkingChangeTargets(files) {
  if (!Array.isArray(files)) return []
  return files.map((file) => ({
    path: pathIdentity(file?.path),
    oldPath: optionalGitPathIdentity(file?.old_path ?? file?.oldPath),
    expectedIndexCode: statusCode(file?.index_code ?? file?.indexCode),
    expectedWorktreeCode: statusCode(file?.worktree_code ?? file?.worktreeCode),
    expectedIsUntracked: Boolean(file?.is_untracked ?? file?.isUntracked),
    expectedAuthorityId: mutationAuthority(file?.authority_id ?? file?.authorityId ?? file?.id),
  }))
}

export function describeStagingOperationResult(result) {
  const status = normalizeText(result?.status) || 'failed'
  const details = Array.isArray(result?.results)
    ? result.results
      .filter((item) => item?.status !== 'success')
      .map((item) => ({
        path: pathIdentity(item?.path) || '未知文件',
        status: normalizeText(item?.status) || 'failed',
        message: normalizeText(item?.message) || '操作结果未提供说明。',
      }))
    : []

  return {
    status,
    tone: RESULT_TONES[status] || 'danger',
    message: normalizeText(result?.message) || '暂存区操作没有返回可识别结果。',
    details,
    mutated: Boolean(result?.mutated),
    needs_confirmation: Boolean(result?.needs_confirmation) || status === 'needs_confirmation',
    should_refresh: status !== 'complete' || Boolean(result?.mutated),
    snapshot: result?.snapshot || null,
  }
}

export function hasExecutableStagingAuthority(viewModel) {
  return Boolean(
    normalizeText(viewModel?.snapshot_id)
    && normalizeText(viewModel?.working_snapshot_id)
    && viewModel?.consistency?.is_consistent
  )
}
