function asText(value) {
  return String(value ?? '').trim()
}

export function isRemoteBranchRow(row) {
  return Boolean(row?.isRemoteRow || row?.isRemoteOnly)
}

export function isLocalBranchRow(row) {
  return Boolean(row) && !isRemoteBranchRow(row)
}

export function getBranchCreationSource(row) {
  if (!row) return null
  if (isRemoteBranchRow(row)) {
    const name = asText(row.remoteRef || row.upstream || row.rowName)
    if (!name) return null
    return {
      kind: 'remote',
      name,
      displayName: asText(row.rowName || name),
    }
  }

  const name = asText(row.localName || row.rowName)
  if (!name) return null
  return {
    kind: 'local',
    name,
    displayName: asText(row.rowName || name),
  }
}

export function getPreferredBranchCreationRow(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.find((row) => isLocalBranchRow(row) && row.isCurrent)
    || list.find(isLocalBranchRow)
    || list[0]
    || null
}

export function hasDirtyWorktree(repoStatus) {
  if (!repoStatus || typeof repoStatus !== 'object') return false
  if (repoStatus.is_clean === false || repoStatus.isClean === false) return true
  if (Array.isArray(repoStatus.modified) && repoStatus.modified.length > 0) return true
  if (Array.isArray(repoStatus.conflicted) && repoStatus.conflicted.length > 0) return true
  return false
}

function remoteBranchName(row) {
  const explicit = asText(row?.remoteBranchName)
  if (explicit) return explicit
  const remoteRef = asText(row?.remoteRef || row?.upstream || row?.rowName)
  const slash = remoteRef.indexOf('/')
  return slash > 0 && slash < remoteRef.length - 1 ? remoteRef.slice(slash + 1) : ''
}

function localCounterpart(rows, branchName) {
  if (!branchName) return null
  return (Array.isArray(rows) ? rows : []).find((candidate) => (
    isLocalBranchRow(candidate)
    && asText(candidate.localName || candidate.rowName) === branchName
  )) || null
}

export function getBranchSwitchAction(
  row,
  rows,
  repoStatus,
  { batchMode = false, operationActive = false } = {}
) {
  if (!row) return { visible: false, enabled: false, label: '', disabledReason: '' }

  const remote = isRemoteBranchRow(row)
  const branch = remote ? remoteBranchName(row) : asText(row.localName || row.rowName)
  const remoteBranch = remote ? asText(row.remoteRef || row.upstream || row.rowName) : null
  const counterpart = remote ? localCounterpart(rows, branch) : null

  let disabledReason = ''
  if (operationActive) disabledReason = '正在处理另一个分支操作，请稍候。'
  else if (batchMode) disabledReason = '退出批量操作后可以切换分支。'
  else if (row.isCurrent) disabledReason = '已经位于当前分支。'
  else if (row.isCheckedOutElsewhere) {
    disabledReason = row.worktreePath
      ? `该分支已在另一个 worktree 中检出：${row.worktreePath}`
      : '该分支已在另一个 worktree 中检出。'
  } else if (hasDirtyWorktree(repoStatus)) {
    disabledReason = '工作区或暂存区存在未提交改动，请先提交、stash 或清理后再切换分支。'
  } else if (!branch) {
    disabledReason = '无法识别目标分支名称。'
  } else if (remote && !remoteBranch) {
    disabledReason = '无法识别远端分支引用。'
  } else if (counterpart) {
    disabledReason = `本地分支 ${branch} 已存在，请在对应本地分支行切换。`
  }

  return {
    visible: true,
    enabled: !disabledReason,
    label: row.isCurrent ? '当前' : remote ? '跟踪' : '切换',
    kind: remote ? 'track' : 'switch',
    branch,
    remoteBranch,
    disabledReason,
  }
}
