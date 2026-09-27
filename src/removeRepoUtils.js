export function normalizeRepoIds(values) {
  const uniqueIds = []
  const seen = new Set()
  const input = Array.isArray(values) ? values : []
  input.forEach((value) => {
    const id = String(value || '').trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    uniqueIds.push(id)
  })
  return uniqueIds
}

function toNormalizedBatchIds(payload, snakeCaseKey, camelCaseKey) {
  if (!payload || typeof payload !== 'object') return []
  return normalizeRepoIds(payload[snakeCaseKey] || payload[camelCaseKey])
}

export function normalizeRepoIdsForRemoval(targetRepos) {
  const repos = Array.isArray(targetRepos) ? targetRepos : []
  return normalizeRepoIds(repos.map((repo) => repo?.id))
}

export function normalizeRemoveReposBatchResult(payload) {
  const removedIds = toNormalizedBatchIds(payload, 'removed_ids', 'removedIds')
  const missingIds = toNormalizedBatchIds(payload, 'missing_ids', 'missingIds')
  return { removedIds, missingIds }
}

export function buildRemoveReposOutcome(targetRepos, payload) {
  const repos = Array.isArray(targetRepos) ? targetRepos : []
  const targetIds = normalizeRepoIdsForRemoval(repos)
  if (targetIds.length === 0) {
    return { successCount: 0, failures: [], removedIds: [] }
  }

  const { removedIds, missingIds } = normalizeRemoveReposBatchResult(payload)
  const successIdSet = new Set([...removedIds, ...missingIds])
  const normalizedRemovedIds = targetIds.filter((repoId) => successIdSet.has(repoId))
  const removedIdSet = new Set(normalizedRemovedIds)

  const failures = repos
    .filter((repo) => {
      const repoId = String(repo?.id || '').trim()
      if (!repoId) return false
      return !removedIdSet.has(repoId)
    })
    .map((repo) => ({
      name: repo.name || repo.id,
      message: '移除失败，请稍后重试',
    }))

  return {
    successCount: normalizedRemovedIds.length,
    failures,
    removedIds: normalizedRemovedIds,
  }
}
