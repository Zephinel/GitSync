import { gitPathIdentity, optionalGitPathIdentity } from './gitPathIdentity.js'
import { buildWorkingChangeTargets } from './stagingViewModel.js'

function text(value) {
  return String(value ?? '').trim()
}

function code(value) {
  const normalized = String(value ?? '')
  return normalized.length > 0 ? normalized.slice(0, 1) : ' '
}

function field(input, camel, snake) {
  return input?.[camel] ?? input?.[snake]
}

export function normalizeSelectedStashTarget(value) {
  const input = value && typeof value === 'object' ? value : {}
  const oldPath = optionalGitPathIdentity(field(input, 'oldPath', 'old_path'))
  return {
    path: gitPathIdentity(input.path),
    oldPath,
    old_path: oldPath,
    status: text(input.status),
    indexCode: code(field(input, 'indexCode', 'index_code')),
    worktreeCode: code(field(input, 'worktreeCode', 'worktree_code')),
    stagingState: text(field(input, 'stagingState', 'staging_state')),
    isUntracked: field(input, 'isUntracked', 'is_untracked') === true,
    isConflicted: field(input, 'isConflicted', 'is_conflicted') === true,
    hasStagedChanges: field(input, 'hasStagedChanges', 'has_staged_changes') === true,
    hasUnstagedChanges: field(input, 'hasUnstagedChanges', 'has_unstaged_changes') === true,
    canUnstage: field(input, 'canUnstage', 'can_unstage') === true,
  }
}

function identity(file) {
  return `${file.oldPath || ''}\0${file.path}\0${file.indexCode}\0${file.worktreeCode}\0${file.isUntracked ? 'u' : 't'}`
}

export function normalizeSelectedStashTargets(values) {
  const seen = new Set()
  return (Array.isArray(values) ? values : [])
    .map(normalizeSelectedStashTarget)
    .filter((file) => {
      const key = identity(file)
      if (file.path === '' || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function selectedStashScopeLabel(values) {
  const selected = normalizeSelectedStashTargets(values)
  return selected.length > 0 ? `Stash ${selected.length} 个文件` : 'Stash 全部改动'
}

function unsupportedSummary(kind, files, description) {
  return {
    kind,
    title: '所选内容不能按文件单独 Stash',
    description,
    files,
    fileCount: files.length,
    canSwitchToAll: true,
    canUnstage: true,
  }
}

export function selectedStashUnsupportedSummary(values) {
  const selected = normalizeSelectedStashTargets(values)
  if (selected.length === 0) return null

  const identities = new Map()
  selected.forEach((file) => {
    for (const key of [file.path, file.oldPath].filter((path) => path !== null && path !== '')) {
      const bucket = identities.get(key) || []
      if (!bucket.includes(file)) bucket.push(file)
      identities.set(key, bucket)
    }
  })
  const ambiguous = [...identities.values()].find((bucket) => bucket.length > 1)
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
      `${deleted.length} 个文件是“已暂存删除”。Git 不能通过文件路径安全保存这种状态，但可以通过“Stash 全部改动”正常保存。`
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

function stagingFiles(snapshot) {
  return normalizeSelectedStashTargets(snapshot?.files)
}

export function buildScopeUnstageTargets(snapshot, targets, workingFiles = []) {
  const files = stagingFiles(snapshot)
  const authorityTargets = buildWorkingChangeTargets(workingFiles)
  const staged = normalizeSelectedStashTargets(targets).filter((target) => (
    target.hasStagedChanges && ![' ', '?', '!'].includes(target.indexCode)
  ))
  if (staged.length === 0) {
    throw new Error('所选范围没有可以取消暂存的条目，请改为 Stash 全部改动。')
  }

  return staged.map((target) => {
    const matches = files.filter((file) => (
      file.path === target.path
      && (file.oldPath || null) === (target.oldPath || null)
      && file.indexCode === target.indexCode
      && file.worktreeCode === target.worktreeCode
    ))
    if (matches.length !== 1) {
      throw new Error(`无法为 ${target.path} 建立唯一的暂存区身份，请刷新后重试。`)
    }
    const current = matches[0]
    if (!current.canUnstage || current.isConflicted) {
      throw new Error(`${target.path} 当前不能安全取消暂存。`)
    }
    const authorityMatches = authorityTargets.filter((authority) => (
      authority.path === current.path
      && (authority.oldPath || null) === (current.oldPath || null)
      && authority.expectedIndexCode === current.indexCode
      && authority.expectedWorktreeCode === current.worktreeCode
      && authority.expectedIsUntracked === current.isUntracked
      && authority.expectedAuthorityId
    ))
    if (authorityMatches.length !== 1) {
      throw new Error(`无法为 ${target.path} 建立完整的内容 authority，请刷新后重试。`)
    }
    return {
      path: current.path,
      oldPath: current.oldPath,
      expectedIndexCode: current.indexCode,
      expectedWorktreeCode: current.worktreeCode,
      expectedAuthorityId: authorityMatches[0].expectedAuthorityId,
    }
  })
}

export function projectResolvedScopeTargets(snapshot, previousTargets) {
  const files = stagingFiles(snapshot)
  const selected = []
  normalizeSelectedStashTargets(previousTargets).forEach((target) => {
    const exact = files.filter((file) => (
      file.path === target.path
      && (file.oldPath || null) === (target.oldPath || null)
    ))
    if (exact.length > 0) {
      selected.push(...exact)
      return
    }
    const identities = new Set(
      [target.path, target.oldPath].filter((path) => path !== null && path !== '')
    )
    selected.push(...files.filter((file) => identities.has(file.path) || identities.has(file.oldPath)))
  })

  const normalized = normalizeSelectedStashTargets(selected)
  if (normalized.length === 0) {
    throw new Error('取消暂存已完成，但无法重新定位所选文件身份。请关闭后刷新，再重新选择文件。')
  }
  return normalized
}
