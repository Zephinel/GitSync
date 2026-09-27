function asText(value) {
  return String(value ?? '').trim()
}

function asCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function getRemoteBranchParts(branchItem = {}) {
  const remoteName = asText(branchItem.remote_name || branchItem.remoteName)
  const upstream = asText(branchItem.upstream)
  const rowName = asText(branchItem.name)
  const remoteRef = upstream || rowName
  if (remoteName && remoteRef.startsWith(`${remoteName}/`)) {
    return { remoteName, branchName: remoteRef.slice(remoteName.length + 1), remoteRef }
  }
  const slash = remoteRef.indexOf('/')
  if (slash <= 0 || slash === remoteRef.length - 1) {
    return { remoteName, branchName: '', remoteRef }
  }
  return {
    remoteName: remoteName || remoteRef.slice(0, slash),
    branchName: remoteRef.slice(slash + 1),
    remoteRef,
  }
}

export function getBranchIdentity(branchItem = {}, index = 0) {
  return asText(branchItem.identity || branchItem.full_ref) || `branch:${asText(branchItem.name) || index}`
}

export function normalizeBranchManagementRows(overview, managementMeta, repoStatus) {
  const branches = Array.isArray(overview?.branches) ? overview.branches : []
  const remoteDefaults = managementMeta?.remote_default_branches && typeof managementMeta.remote_default_branches === 'object'
    ? managementMeta.remote_default_branches
    : {}
  const defaultBranchNames = new Set(
    [managementMeta?.default_branch, ...Object.values(remoteDefaults)]
      .map(asText)
      .filter(Boolean)
  )
  const currentModifiedCount = Array.isArray(repoStatus?.modified) ? repoStatus.modified.length : 0
  const currentConflictCount = Array.isArray(repoStatus?.conflicted) ? repoStatus.conflicted.length : 0

  return branches.map((branchItem, index) => {
    const identity = getBranchIdentity(branchItem, index)
    const rowName = asText(branchItem.name) || '-'
    const localName = asText(branchItem.local_name || branchItem.localName)
    const upstream = asText(branchItem.upstream)
    const isRemoteRow = identity.startsWith('remote:')
    const isRemoteOnly = Boolean(branchItem.is_remote_only || branchItem.isRemoteOnly)
    const hasLocal = Boolean(branchItem.has_local ?? branchItem.hasLocal)
    const hasRemote = Boolean(branchItem.has_remote ?? branchItem.hasRemote)
    const isCurrent = Boolean(branchItem.is_current || branchItem.isCurrent)
    const isCheckedOutElsewhere = Boolean(branchItem.is_checked_out_elsewhere || branchItem.isCheckedOutElsewhere)
    const worktreePath = asText(branchItem.worktree_path || branchItem.worktreePath)
    const comparisonState = asText(branchItem.comparison_state || branchItem.comparisonState)
    const comparisonError = asText(branchItem.comparison_error || branchItem.comparisonError)
    const upstreamGone = Boolean(branchItem.upstream_gone || branchItem.upstreamGone)
    const ahead = asCount(branchItem.ahead)
    const behind = asCount(branchItem.behind)
    const headHash = asText(branchItem.head_hash || branchItem.headHash)
    const remoteParts = getRemoteBranchParts(branchItem)
    const localDefault = Boolean(localName && defaultBranchNames.has(localName))
    const remoteDefault = Boolean(
      remoteParts.remoteName
      && remoteParts.branchName
      && asText(remoteDefaults[remoteParts.remoteName]) === remoteParts.branchName
    )
    const isDefault = isRemoteRow || isRemoteOnly ? remoteDefault : localDefault
    const hasLocalTarget = !isRemoteRow && !isRemoteOnly && Boolean(localName)
    const hasRemoteTarget = Boolean(remoteParts.remoteName && remoteParts.branchName)
    const isDivergent = ahead > 0 && behind > 0
    const syncDirection = !isDivergent && ahead > 0
      ? 'push'
      : !isDivergent && behind > 0
        ? 'pull'
        : ''
    const currentPullBlocked = isCurrent
      && syncDirection === 'pull'
      && (currentModifiedCount > 0 || currentConflictCount > 0)
    const syncDisabledReason = !hasLocalTarget
      ? '只有本地分支可以执行分支同步。'
      : !upstream || upstreamGone
        ? '分支没有可用 upstream。'
        : comparisonState && comparisonState !== 'ok'
          ? (comparisonError || '分支比较状态不可用。')
          : isDivergent
            ? '本地与远端已经分叉，请先人工处理。'
            : !syncDirection
              ? '分支已经同步。'
              : isCheckedOutElsewhere
                ? (worktreePath ? `该分支已在另一个 worktree 检出：${worktreePath}` : '该分支已在另一个 worktree 检出。')
                : currentPullBlocked
                  ? '当前分支存在未提交改动或冲突，不能快进同步。'
                  : ''
    const canSync = !syncDisabledReason
    const deleteDisabledReason = isDefault
      ? '默认分支不能删除。'
      : isCurrent
        ? '当前分支不能删除。'
        : isCheckedOutElsewhere
          ? (worktreePath ? `该分支已在另一个 worktree 检出：${worktreePath}` : '该分支已在另一个 worktree 检出。')
          : comparisonState === 'error'
            ? (comparisonError || '分支状态读取失败，请刷新后重试。')
            : !hasLocalTarget && !hasRemoteTarget
              ? '没有可删除的本地或远端引用。'
              : ''

    return {
      source: branchItem,
      identity,
      rowName,
      localName,
      upstream,
      remoteName: remoteParts.remoteName,
      remoteBranchName: remoteParts.branchName,
      remoteRef: remoteParts.remoteRef,
      isRemoteRow,
      isRemoteOnly,
      hasLocal,
      hasRemote,
      isCurrent,
      isDefault,
      ahead,
      behind,
      comparisonState,
      comparisonError,
      upstreamGone,
      headHash,
      isCheckedOutElsewhere,
      worktreePath,
      syncDirection,
      canSync,
      syncDisabledReason,
      canDelete: !deleteDisabledReason,
      deleteDisabledReason,
    }
  })
}

export function filterBranchManagementRows(rows, keyword) {
  const normalized = asText(keyword).toLowerCase()
  if (!normalized) return Array.isArray(rows) ? rows : []
  return (Array.isArray(rows) ? rows : []).filter((row) => [
    row.rowName,
    row.localName,
    row.upstream,
    row.remoteName,
    row.remoteBranchName,
    row.headHash,
    row.comparisonState,
    row.worktreePath,
    row.isCurrent ? '当前' : '',
    row.isDefault ? '默认' : '',
  ].filter(Boolean).join(' ').toLowerCase().includes(normalized))
}

// Adapts a repository-overview branch item (the hover card's data shape) into the row subset
// `buildBranchDeleteRequest` reads, so every delete surface shares one request rule.
export function normalizeBranchDeleteTarget(branchItem = {}) {
  const identity = asText(branchItem.identity || branchItem.full_ref)
  const isRemoteRow = identity.startsWith('remote:')
  const isRemoteOnly = Boolean(branchItem.is_remote_only || branchItem.isRemoteOnly)
  const rowName = asText(branchItem.name) || '-'
  const localName = asText(branchItem.local_name || branchItem.localName) || (isRemoteRow ? '' : rowName)
  const upstream = asText(branchItem.upstream)
  const upstreamGone = Boolean(branchItem.upstream_gone || branchItem.upstreamGone)
  const hasLocalTarget = !isRemoteRow && !isRemoteOnly && Boolean(localName) && localName !== '-'
  const remoteRef = isRemoteRow || isRemoteOnly ? (upstream || rowName) : upstream
  return {
    identity,
    rowName,
    localName,
    isRemoteRow,
    isRemoteOnly,
    upstreamGone,
    remoteRef,
    canDelete: hasLocalTarget || (Boolean(remoteRef) && remoteRef !== '-'),
  }
}

export function buildBranchDeleteRequest(row, { includeRemote = false, forceDelete = false } = {}) {
  if (!row?.canDelete) return null
  if (row.isRemoteRow || row.isRemoteOnly) {
    if (!row.remoteRef) return null
    return {
      identity: row.identity,
      branch: row.localName || row.rowName,
      remoteBranch: row.remoteRef,
      deleteLocal: false,
      deleteRemote: true,
      forceDelete: false,
    }
  }

  if (!row.localName) return null
  const shouldDeleteRemote = Boolean(includeRemote && row.remoteRef && !row.upstreamGone)
  return {
    identity: row.identity,
    branch: row.localName,
    remoteBranch: shouldDeleteRemote ? row.remoteRef : null,
    deleteLocal: true,
    deleteRemote: shouldDeleteRemote,
    forceDelete: forceDelete === true,
  }
}

export function buildBatchDeleteRequests(rows, selectedIdentities, options = {}) {
  const selected = selectedIdentities instanceof Set
    ? selectedIdentities
    : new Set(Array.isArray(selectedIdentities) ? selectedIdentities : [])
  const seenLocalBranches = new Set()
  const seenRemoteBranches = new Set()
  const requests = []

  const selectedRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => selected.has(row.identity))
    .sort((left, right) => Number(left.isRemoteRow || left.isRemoteOnly) - Number(right.isRemoteRow || right.isRemoteOnly))

  for (const row of selectedRows) {
    const request = buildBranchDeleteRequest(row, options)
    if (!request) continue

    if (request.deleteLocal) {
      if (seenLocalBranches.has(request.branch)) request.deleteLocal = false
      else seenLocalBranches.add(request.branch)
    }
    if (request.deleteRemote && request.remoteBranch) {
      if (seenRemoteBranches.has(request.remoteBranch)) request.deleteRemote = false
      else seenRemoteBranches.add(request.remoteBranch)
    }
    request.forceDelete = Boolean(request.forceDelete && request.deleteLocal)
    if (request.deleteLocal || request.deleteRemote) requests.push(request)
  }

  return requests
}

export function getSelectableBranchIdentities(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row.canDelete)
    .map((row) => row.identity)
}
