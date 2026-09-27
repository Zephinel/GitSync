import { normalizeRepoIds } from './removeRepoUtils.js'

function toRollbackRepoIdSet(repoIds) {
  return new Set(normalizeRepoIds(repoIds))
}

export function createRepoRemovalSnapshot({
  reposToRemove,
  repoStatuses,
  missingRepoStates,
  selectedRepoIds,
  repoOrderSource,
}) {
  const reposToRemoveList = toArray(reposToRemove)
  const targetRepoIds = normalizeRepoIds(reposToRemoveList.map((repo) => repo?.id))
  const targetRepoIdSet = new Set(targetRepoIds)
  const selectedRepoIdSetBeforeRemove = new Set(normalizeRepoIds(selectedRepoIds))
  const repoOrderMap = new Map(
    toArray(repoOrderSource).map((repo, index) => [repo.id, index])
  )
  const snapshotEntries = []
  targetRepoIds.forEach((repoId) => {
    const sourceRepo = reposToRemoveList.find((repo) => String(repo?.id || '').trim() === repoId)
    if (!sourceRepo) return
    snapshotEntries.push([
      repoId,
      {
        repo: { ...sourceRepo },
        status: Object.prototype.hasOwnProperty.call(repoStatuses || {}, repoId)
          ? repoStatuses[repoId]
          : null,
        missingState: missingRepoStates?.[repoId]
          ? { ...missingRepoStates[repoId] }
          : null,
      },
    ])
  })

  return {
    targetRepoIds,
    targetRepoIdSet,
    selectedRepoIdSetBeforeRemove,
    repoOrderMap,
    repoSnapshotMap: new Map(snapshotEntries),
  }
}

export function removeReposByIdSet(prevRepos, targetRepoIdSet) {
  const repos = toArray(prevRepos)
  if (!(targetRepoIdSet instanceof Set) || targetRepoIdSet.size === 0) return repos
  const nextRepos = repos.filter((repo) => !targetRepoIdSet.has(repo.id))
  return nextRepos.length === repos.length ? repos : nextRepos
}

export function removeRepoStatusesByIdSet(prevStatuses, targetRepoIdSet) {
  if (!(targetRepoIdSet instanceof Set) || targetRepoIdSet.size === 0) return prevStatuses
  let changed = false
  const next = {}
  Object.entries(prevStatuses || {}).forEach(([repoId, status]) => {
    if (targetRepoIdSet.has(repoId)) {
      changed = true
      return
    }
    next[repoId] = status
  })
  return changed ? next : prevStatuses
}

export function removeMissingRepoStatesByIdSet(prevMissingRepoStates, targetRepoIdSet) {
  if (!(targetRepoIdSet instanceof Set) || targetRepoIdSet.size === 0) return prevMissingRepoStates
  let changed = false
  const next = {}
  Object.entries(prevMissingRepoStates || {}).forEach(([repoId, info]) => {
    if (targetRepoIdSet.has(repoId)) {
      changed = true
      return
    }
    next[repoId] = info
  })
  return changed ? next : prevMissingRepoStates
}

export function rollbackReposState(prevRepos, snapshot, rollbackRepoIds) {
  const rollbackRepoIdSet = toRollbackRepoIdSet(rollbackRepoIds)
  if (rollbackRepoIdSet.size === 0) return prevRepos
  const existingIdSet = new Set(toArray(prevRepos).map((repo) => repo.id))
  const reposToRestore = []
  rollbackRepoIdSet.forEach((repoId) => {
    const entry = snapshot?.repoSnapshotMap?.get(repoId)
    if (!entry?.repo || existingIdSet.has(repoId)) return
    reposToRestore.push({ ...entry.repo })
  })
  if (reposToRestore.length === 0) return prevRepos

  const nextRepos = [...toArray(prevRepos), ...reposToRestore]
  nextRepos.sort((a, b) => {
    const orderA = snapshot?.repoOrderMap?.has(a.id)
      ? snapshot.repoOrderMap.get(a.id)
      : Number.MAX_SAFE_INTEGER
    const orderB = snapshot?.repoOrderMap?.has(b.id)
      ? snapshot.repoOrderMap.get(b.id)
      : Number.MAX_SAFE_INTEGER
    return orderA - orderB
  })
  return nextRepos
}

export function rollbackRepoStatusesState(prevStatuses, snapshot, rollbackRepoIds) {
  const rollbackRepoIdSet = toRollbackRepoIdSet(rollbackRepoIds)
  if (rollbackRepoIdSet.size === 0) return prevStatuses
  let changed = false
  const next = { ...(prevStatuses || {}) }
  rollbackRepoIdSet.forEach((repoId) => {
    const entry = snapshot?.repoSnapshotMap?.get(repoId)
    if (!entry) return
    if (next[repoId] !== entry.status) {
      next[repoId] = entry.status
      changed = true
    }
  })
  return changed ? next : prevStatuses
}

export function rollbackMissingRepoStatesState(prevMissingRepoStates, snapshot, rollbackRepoIds) {
  const rollbackRepoIdSet = toRollbackRepoIdSet(rollbackRepoIds)
  if (rollbackRepoIdSet.size === 0) return prevMissingRepoStates
  let changed = false
  const next = { ...(prevMissingRepoStates || {}) }
  rollbackRepoIdSet.forEach((repoId) => {
    const entry = snapshot?.repoSnapshotMap?.get(repoId)
    if (!entry) return
    if (!entry.missingState) {
      if (next[repoId]) {
        delete next[repoId]
        changed = true
      }
      return
    }
    const current = next[repoId]
    if (!current || current.message !== entry.missingState.message) {
      next[repoId] = { ...entry.missingState }
      changed = true
    }
  })
  return changed ? next : prevMissingRepoStates
}

export function rollbackSelectedRepoIdsState(prevSelectedRepoIds, snapshot, rollbackRepoIds) {
  const rollbackRepoIdSet = toRollbackRepoIdSet(rollbackRepoIds)
  if (rollbackRepoIdSet.size === 0) return prevSelectedRepoIds
  const selectedBeforeRemove = snapshot?.selectedRepoIdSetBeforeRemove || new Set()
  const nextSet = new Set(toArray(prevSelectedRepoIds))
  let changed = false

  rollbackRepoIdSet.forEach((repoId) => {
    if (!selectedBeforeRemove.has(repoId) || nextSet.has(repoId)) return
    nextSet.add(repoId)
    changed = true
  })
  return changed ? Array.from(nextSet) : prevSelectedRepoIds
}

export function buildUndoRemovedRepos(reposToRemove, snapshot, removedIdSet) {
  if (!(removedIdSet instanceof Set) || removedIdSet.size === 0) return []
  return toArray(reposToRemove)
    .map((repo) => {
      const repoId = String(repo?.id || '').trim()
      if (!repoId) return null
      return snapshot?.repoSnapshotMap?.get(repoId)?.repo || repo
    })
    .filter((repo) => repo && removedIdSet.has(repo.id))
    .map((repo) => ({ ...repo }))
}

export function getFailedRepoIds(targetRepoIds, removedIds) {
  const removedIdSet = new Set(normalizeRepoIds(removedIds))
  return normalizeRepoIds(targetRepoIds).filter((repoId) => !removedIdSet.has(repoId))
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}
