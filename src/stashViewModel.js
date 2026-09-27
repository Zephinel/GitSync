import { gitPathIdentity, optionalGitPathIdentity } from './gitPathIdentity.js'

const VALID_RESULT_STATUSES = new Set([
  'complete',
  'partial',
  'conflict',
  'failed',
  'stale',
  'needs_confirmation',
  'acknowledged',
])

function text(value) {
  return String(value ?? '').trim()
}

function code(value) {
  const normalized = String(value ?? '')
  return normalized.length > 0 ? normalized.slice(0, 1) : ' '
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

function bool(value) {
  return value === true
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function field(input, camel, snake) {
  return input?.[camel] ?? input?.[snake]
}

function nonEmptyGitPaths(values) {
  return array(values).map(gitPathIdentity).filter((path) => path !== '')
}

function stashPathIdentity(file) {
  return `${file.oldPath || ''}\0${file.path}\0${file.indexCode}\0${file.worktreeCode}\0${file.isUntracked ? 'u' : 't'}`
}

export function createStashRequestId(prefix = 'stash') {
  const safePrefix = text(prefix).replace(/[^a-z0-9_.-]/gi, '-').slice(0, 24) || 'stash'
  const random = Math.random().toString(36).slice(2, 10)
  return `${safePrefix}_${Date.now().toString(36)}_${random}`
}

export function normalizeStashEntry(value) {
  const input = value && typeof value === 'object' ? value : {}
  const id = text(input.id || input.oid)
  return {
    id,
    oid: text(input.oid || input.id),
    selector: text(input.selector),
    ordinal: count(input.ordinal),
    message: text(input.message || input.subject) || '未填写说明',
    subject: text(input.subject),
    branchContext: text(field(input, 'branchContext', 'branch_context')) || null,
    createdAt: text(field(input, 'createdAt', 'created_at')),
    baseCommit: text(field(input, 'baseCommit', 'base_commit')) || null,
    baseSummary: text(field(input, 'baseSummary', 'base_summary')) || null,
    includesUntracked: bool(field(input, 'includesUntracked', 'includes_untracked')),
    scopeSummary: text(field(input, 'scopeSummary', 'scope_summary')),
  }
}

export function normalizeStashPathTarget(value) {
  const input = value && typeof value === 'object' ? value : {}
  const path = gitPathIdentity(input.path)
  const oldPath = optionalGitPathIdentity(field(input, 'oldPath', 'old_path'))
  return {
    path,
    oldPath,
    old_path: oldPath,
    status: text(input.status),
    indexCode: code(field(input, 'indexCode', 'index_code')),
    worktreeCode: code(field(input, 'worktreeCode', 'worktree_code')),
    stagingState: text(field(input, 'stagingState', 'staging_state')),
    isUntracked: bool(field(input, 'isUntracked', 'is_untracked')),
    isConflicted: bool(field(input, 'isConflicted', 'is_conflicted')),
    hasStagedChanges: bool(field(input, 'hasStagedChanges', 'has_staged_changes')),
    hasUnstagedChanges: bool(field(input, 'hasUnstagedChanges', 'has_unstaged_changes')),
    canUnstage: bool(field(input, 'canUnstage', 'can_unstage')),
  }
}

export function normalizeStashPathTargets(values) {
  const seen = new Set()
  return array(values)
    .map(normalizeStashPathTarget)
    .filter((file) => {
      const identity = stashPathIdentity(file)
      if (file.path === '' || seen.has(identity)) return false
      seen.add(identity)
      return true
    })
}

export function stashCreateScopeLabel(files = []) {
  const selected = normalizeStashPathTargets(files)
  return selected.length > 0 ? `Stash ${selected.length} 个文件` : 'Stash 全部改动'
}

function unsupportedSummary(codeValue, files, description) {
  return {
    code: codeValue,
    kind: codeValue,
    title: '所选内容不能按文件单独 Stash',
    description,
    files,
    fileCount: files.length,
    canSwitchToAll: true,
    canUnstage: true,
  }
}

export function selectedStashUnsupportedSummary(files = []) {
  const selected = normalizeStashPathTargets(files)
  if (selected.length === 0) return null

  const identityBuckets = new Map()
  selected.forEach((file) => {
    const keys = [file.path, file.oldPath].filter((path) => path !== null && path !== '')
    keys.forEach((key) => {
      const bucket = identityBuckets.get(key) || []
      if (!bucket.includes(file)) bucket.push(file)
      identityBuckets.set(key, bucket)
    })
  })
  const ambiguous = [...identityBuckets.values()].find((bucket) => bucket.length > 1)
  if (ambiguous) {
    return unsupportedSummary(
      'multiple-identities',
      ambiguous,
      `${ambiguous.length} 个所选条目共享同一路径并形成多种 Git 身份。GitSync 不会猜测应该保存哪一种状态，但可以改为保存全部改动，或先取消相关暂存状态后继续。`
    )
  }

  const deleted = selected.filter((file) => file.indexCode === 'D')
  if (deleted.length > 0) {
    return unsupportedSummary(
      'staged-deletion',
      deleted,
      `${deleted.length} 个文件是“已暂存删除”。Git 无法通过文件路径安全保存这种状态，但可以通过“Stash 全部改动”正常保存。`
    )
  }

  const renamed = selected.filter((file) => file.indexCode === 'R' || file.indexCode === 'C')
  if (renamed.length > 0) {
    return unsupportedSummary(
      'staged-rename-copy',
      renamed,
      `${renamed.length} 个文件包含已暂存重命名或复制。文件级 pathspec 无法完整保存旧路径与新路径身份，但可以通过“Stash 全部改动”正常保存。`
    )
  }

  return null
}

export function selectedStashUnsupportedReason(files = []) {
  const summary = selectedStashUnsupportedSummary(files)
  if (!summary) return ''
  const firstPath = summary.files[0]?.path
  return `${summary.description}${firstPath ? `：${firstPath}` : ''}`
}

export function stashKeepIndexAvailability(snapshot, files = [], includeUntracked = false) {
  const selected = normalizeStashPathTargets(files)
  if (selected.length > 0) {
    const available = selected.some((file) => file.hasUnstagedChanges || file.isUntracked)
    return {
      available,
      reason: available
        ? ''
        : '所选文件只有已暂存改动；保留已暂存改动后，没有可写入 Stash 的未暂存内容。',
    }
  }

  const available = count(snapshot?.unstagedFiles) > 0
    || (includeUntracked && count(snapshot?.untrackedFiles) > 0)
  return {
    available,
    reason: available
      ? ''
      : '当前没有将被保存的未暂存内容；此选项暂不可用。',
  }
}

export function normalizePendingStashOperation(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    requestId: text(field(input, 'requestId', 'request_id')),
    operation: text(input.operation),
    targetStashId: text(field(input, 'targetStashId', 'target_stash_id')) || null,
    originRepoPath: text(field(input, 'originRepoPath', 'origin_repo_path')) || null,
    status: text(input.status) || 'needs_confirmation',
    message: text(input.message),
    updatedAtMs: count(field(input, 'updatedAtMs', 'updated_at_ms')),
  }
}

export function normalizeStashSnapshot(value) {
  const input = value && typeof value === 'object' ? value : {}
  const stashes = array(input.stashes)
    .map(normalizeStashEntry)
    .filter((entry) => entry.id && entry.selector)
  const pendingOperations = array(field(input, 'pendingOperations', 'pending_operations'))
    .map(normalizePendingStashOperation)
    .filter((operation) => operation.requestId)
  const pendingOperationTotal = Math.max(
    count(field(input, 'pendingOperationTotal', 'pending_operation_total')),
    pendingOperations.length,
  )
  const pendingOperationsTruncated = bool(field(
    input,
    'pendingOperationsTruncated',
    'pending_operations_truncated',
  )) || pendingOperationTotal > pendingOperations.length

  return {
    repoPath: text(field(input, 'repoPath', 'repo_path')),
    branch: text(input.branch) || null,
    detachedHead: bool(field(input, 'detachedHead', 'detached_head')),
    headHash: text(field(input, 'headHash', 'head_hash')) || null,
    snapshotId: text(field(input, 'snapshotId', 'snapshot_id')),
    worktreeId: text(field(input, 'worktreeId', 'worktree_id')),
    stagedFiles: count(field(input, 'stagedFiles', 'staged_files')),
    unstagedFiles: count(field(input, 'unstagedFiles', 'unstaged_files')),
    mixedFiles: count(field(input, 'mixedFiles', 'mixed_files')),
    untrackedFiles: count(field(input, 'untrackedFiles', 'untracked_files')),
    conflictedFiles: count(field(input, 'conflictedFiles', 'conflicted_files')),
    conflictPaths: nonEmptyGitPaths(field(input, 'conflictPaths', 'conflict_paths')),
    hasTrackedChanges: bool(field(input, 'hasTrackedChanges', 'has_tracked_changes')),
    hasUntrackedChanges: bool(field(input, 'hasUntrackedChanges', 'has_untracked_changes')),
    canCreateDefault: bool(field(input, 'canCreateDefault', 'can_create_default')),
    canCreateWithUntracked: bool(field(input, 'canCreateWithUntracked', 'can_create_with_untracked')),
    stashTotal: count(field(input, 'stashTotal', 'stash_total')),
    stashesTruncated: bool(field(input, 'stashesTruncated', 'stashes_truncated')),
    stashes,
    pendingOperationTotal,
    pendingOperationsTruncated,
    pendingOperations,
  }
}

export function normalizeStashDetailFile(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    path: gitPathIdentity(input.path),
    oldPath: optionalGitPathIdentity(field(input, 'oldPath', 'old_path')),
    status: text(input.status) || 'modified',
    additions: count(input.additions),
    deletions: count(input.deletions),
    isBinary: bool(field(input, 'isBinary', 'is_binary')),
    isUntracked: bool(field(input, 'isUntracked', 'is_untracked')),
  }
}

export function normalizeStashDetail(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    entry: normalizeStashEntry(input.entry),
    fileCount: count(field(input, 'fileCount', 'file_count')),
    additions: count(input.additions),
    deletions: count(input.deletions),
    addedFiles: count(field(input, 'addedFiles', 'added_files')),
    modifiedFiles: count(field(input, 'modifiedFiles', 'modified_files')),
    deletedFiles: count(field(input, 'deletedFiles', 'deleted_files')),
    renamedFiles: count(field(input, 'renamedFiles', 'renamed_files')),
    untrackedFiles: count(field(input, 'untrackedFiles', 'untracked_files')),
    filesTruncated: bool(field(input, 'filesTruncated', 'files_truncated')),
    files: array(input.files).map(normalizeStashDetailFile).filter((file) => file.path !== ''),
  }
}

export function normalizeStashFileDiff(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    stashId: text(field(input, 'stashId', 'stash_id')),
    path: gitPathIdentity(input.path),
    oldPath: optionalGitPathIdentity(field(input, 'oldPath', 'old_path')),
    status: text(input.status) || 'modified',
    patch: String(input.patch ?? ''),
    additions: count(input.additions),
    deletions: count(input.deletions),
    isBinary: bool(field(input, 'isBinary', 'is_binary')),
    truncated: bool(input.truncated),
    tooLarge: bool(field(input, 'tooLarge', 'too_large')),
  }
}

export function normalizeStashOperationResult(value) {
  const input = value && typeof value === 'object' ? value : {}
  const statusCandidate = text(input.status)
  const statusKnown = VALID_RESULT_STATUSES.has(statusCandidate)
  const rawStatus = statusKnown ? statusCandidate : 'needs_confirmation'
  const snapshotError = text(field(input, 'snapshotError', 'snapshot_error')) || null
  const needsConfirmation = rawStatus === 'needs_confirmation'
    || !statusKnown
    || bool(field(input, 'needsConfirmation', 'needs_confirmation'))
    || Boolean(snapshotError)
  const status = needsConfirmation && ['complete', 'acknowledged'].includes(rawStatus)
    ? 'needs_confirmation'
    : rawStatus
  const rawSnapshot = input.snapshot
  return {
    operation: text(input.operation),
    requestId: text(field(input, 'requestId', 'request_id')),
    status,
    mutated: bool(input.mutated),
    needsConfirmation,
    worktreeChanged: bool(field(input, 'worktreeChanged', 'worktree_changed')),
    createdStashId: text(field(input, 'createdStashId', 'created_stash_id')) || null,
    targetStashId: text(field(input, 'targetStashId', 'target_stash_id')) || null,
    applied: bool(input.applied),
    dropped: bool(input.dropped),
    stashRetained: bool(field(input, 'stashRetained', 'stash_retained')),
    conflicts: nonEmptyGitPaths(input.conflicts),
    warnings: array(input.warnings).map(text).filter(Boolean),
    errors: array(input.errors).map(text).filter(Boolean),
    snapshot: rawSnapshot ? normalizeStashSnapshot(rawSnapshot) : null,
    snapshotError,
    message: text(input.message),
  }
}

export function findStashEntry(snapshot, stashId) {
  const id = text(stashId)
  return snapshot?.stashes?.find((entry) => entry.id === id) || null
}

export function canCreateStash(snapshot, includeUntracked = false, files = [], keepIndex = false) {
  if (!snapshot?.snapshotId || snapshot.conflictedFiles > 0 || !snapshot.headHash) return false
  const selected = normalizeStashPathTargets(files)
  if (selected.length > 0) {
    if (selected.some((file) => file.isConflicted)) return false
    if (selectedStashUnsupportedSummary(selected)) return false
    if (keepIndex && !stashKeepIndexAvailability(snapshot, selected, includeUntracked).available) return false
    return true
  }
  if (keepIndex && !stashKeepIndexAvailability(snapshot, selected, includeUntracked).available) return false
  return includeUntracked
    ? snapshot.canCreateWithUntracked
    : snapshot.canCreateDefault
}

export function buildCreateStashRequest(snapshot, {
  requestId,
  message = '',
  includeUntracked = false,
  keepIndex = false,
  files = [],
} = {}) {
  const selected = normalizeStashPathTargets(files)
  return {
    requestId: text(requestId),
    expectedSnapshotId: text(snapshot?.snapshotId),
    message: text(message),
    includeUntracked: Boolean(includeUntracked || selected.some((file) => file.isUntracked)),
    keepIndex: Boolean(keepIndex),
    files: selected.map((file) => ({ path: file.path, oldPath: file.oldPath })),
  }
}

export function buildTargetStashRequest(snapshot, stashId, requestId) {
  return {
    requestId: text(requestId),
    expectedSnapshotId: text(snapshot?.snapshotId),
    stashId: text(stashId),
  }
}

export function stashOperationLabel(operation) {
  switch (operation) {
    case 'create': return '创建 Stash'
    case 'create_selected': return '创建文件级 Stash'
    case 'apply': return '应用 Stash'
    case 'pop': return '应用并删除 Stash'
    case 'drop': return '删除 Stash'
    case 'acknowledge': return '接受当前 Stash 状态'
    default: return 'Stash 操作'
  }
}

export function stashResultTone(status) {
  switch (status) {
    case 'complete': return 'success'
    case 'acknowledged':
    case 'partial':
    case 'conflict':
    case 'stale': return 'warning'
    case 'failed': return 'danger'
    default: return 'unknown'
  }
}
