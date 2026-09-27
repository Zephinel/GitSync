export function normalizeBranchOverviewRow(branchItem) {
  const safeBranchItem = branchItem && typeof branchItem === 'object' ? branchItem : {}
  const identity = String(safeBranchItem.identity || '').trim()
  const isRemoteRow = identity.startsWith('remote:')
  const rowName = String(safeBranchItem.name || '').trim() || '-'
  return {
    identity,
    isRemoteRow,
    isRemoteOnly: Boolean(safeBranchItem.is_remote_only),
    hasLocal: Boolean(safeBranchItem.has_local || safeBranchItem.hasLocal),
    rowName,
    localName: String(safeBranchItem.local_name || safeBranchItem.localName || (!isRemoteRow ? rowName : '')).trim(),
    upstream: String(safeBranchItem.upstream || '').trim(),
  }
}

export function shouldShowBranchOverviewRow(branchItem, branchItems = []) {
  if (!branchItem || typeof branchItem !== 'object') return false
  const branchMeta = normalizeBranchOverviewRow(branchItem)
  if (!branchMeta.isRemoteRow || !branchMeta.hasLocal || branchMeta.isRemoteOnly) return true

  const localBranch = branchItems.find((candidate) => {
    const candidateMeta = normalizeBranchOverviewRow(candidate)
    return !candidateMeta.isRemoteRow && candidateMeta.rowName === branchMeta.localName
  })
  const localUpstream = normalizeBranchOverviewRow(localBranch).upstream
  return !localUpstream || localUpstream !== branchMeta.rowName
}
