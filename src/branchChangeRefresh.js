export function findBranchChangeRefreshRepo(repoList, repoId) {
  if (!Array.isArray(repoList) || !repoId) return null

  return repoList.find((repo) => {
    if (!repo || repo.id !== repoId) return false
    if (typeof repo.path !== 'string' || !repo.path.trim()) return false
    return repo.status !== 'paused'
  }) || null
}

export async function refreshRepoAfterBranchChange({
  repoId,
  repoList,
  refreshRepoRemote,
  refreshRepoStatus,
  refreshRepoMetadata,
}) {
  const targetRepo = findBranchChangeRefreshRepo(repoList, repoId)

  if (!targetRepo) {
    return {
      kind: 'missingTarget',
      remoteFetched: false,
      statusRefreshed: false,
      metadataRefreshed: false,
      warning: '目标仓库已不可用，无法刷新状态。',
    }
  }

  let remoteFetched = false
  let statusRefreshed = false
  let metadataRefreshed = false
  const warnings = []

  if (typeof refreshRepoRemote === 'function') {
    try {
      await refreshRepoRemote(targetRepo)
      remoteFetched = true
    } catch (error) {
      warnings.push(error?.message || String(error || '远端刷新失败'))
    }
  }

  if (typeof refreshRepoStatus === 'function') {
    try {
      await refreshRepoStatus(targetRepo)
      statusRefreshed = true
    } catch (error) {
      warnings.push(error?.message || String(error || '状态刷新失败'))
    }
  }

  if (typeof refreshRepoMetadata === 'function') {
    try {
      await refreshRepoMetadata(targetRepo)
      metadataRefreshed = true
    } catch (error) {
      warnings.push(error?.message || String(error || '仓库信息刷新失败'))
    }
  }

  return {
    kind: 'targetedRefresh',
    remoteFetched,
    statusRefreshed,
    metadataRefreshed,
    warning: warnings.join('；'),
  }
}

export async function refreshRepoAfterBranchChangeWithGroupRetention({
  repoId,
  repoList,
  refreshRepoRemote,
  refreshRepoStatus,
  refreshRepoMetadata,
  setRepoBranchRefreshing,
}) {
  if (typeof setRepoBranchRefreshing === 'function') {
    setRepoBranchRefreshing(repoId, true)
  }

  try {
    return await refreshRepoAfterBranchChange({
      repoId,
      repoList,
      refreshRepoRemote,
      refreshRepoStatus,
      refreshRepoMetadata,
    })
  } finally {
    if (typeof setRepoBranchRefreshing === 'function') {
      setRepoBranchRefreshing(repoId, false)
    }
  }
}
