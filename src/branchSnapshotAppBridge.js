import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { getBranchAttentionKey } from './branchAttentionUtils.js'
import {
  getActiveBranchOperationPaths,
  getBranchOperationRevision,
  getBranchSnapshotChangesSince,
  getBranchSnapshotRevision,
  getLatestBranchOverviewSnapshot,
  getLatestBranchStatusSnapshot,
  normalizeBranchRepoPath,
  subscribeBranchOperations,
  subscribeBranchSnapshots,
} from './branchDomainStore.js'

function buildRepoIndex(repos) {
  const repoIdByPath = new Map()
  ;(Array.isArray(repos) ? repos : []).forEach((repo) => {
    const repoId = String(repo?.id || '').trim()
    const repoPath = normalizeBranchRepoPath(repo?.path)
    if (repoId && repoPath) repoIdByPath.set(repoPath, repoId)
  })
  return repoIdByPath
}

function applyRecordPatch(setState, patch) {
  const entries = Object.entries(patch || {})
  if (entries.length === 0 || typeof setState !== 'function') return
  setState((previous) => {
    let changed = false
    const next = { ...(previous || {}) }
    entries.forEach(([key, value]) => {
      if (next[key] === value) return
      next[key] = value
      changed = true
    })
    return changed ? next : previous
  })
}

function clearDismissedKeys(setState, repoIds) {
  const ids = Array.from(new Set((repoIds || []).filter(Boolean)))
  if (ids.length === 0 || typeof setState !== 'function') return
  setState((previous) => {
    let changed = false
    const next = { ...(previous || {}) }
    ids.forEach((repoId) => {
      if (!Object.prototype.hasOwnProperty.call(next, repoId)) return
      delete next[repoId]
      changed = true
    })
    return changed ? next : previous
  })
}

export function buildBranchSnapshotAppPatch(repos, changedPaths = null) {
  const repoIdByPath = buildRepoIndex(repos)
  const useAllPaths = changedPaths == null
  const normalizedChangedPaths = new Set(
    Array.from(changedPaths || [])
      .map(normalizeBranchRepoPath)
      .filter(Boolean)
  )
  const targetPaths = useAllPaths
    ? new Set(repoIdByPath.keys())
    : normalizedChangedPaths
  const overviewByRepoId = {}
  const statusByRepoId = {}
  const dismissedRepoIdsToClear = []

  targetPaths.forEach((repoPath) => {
    const repoId = repoIdByPath.get(repoPath)
    if (!repoId) return
    const overview = getLatestBranchOverviewSnapshot(repoPath)
    const status = getLatestBranchStatusSnapshot(repoPath)
    if (overview) {
      overviewByRepoId[repoId] = overview
      if (!getBranchAttentionKey(overview)) dismissedRepoIdsToClear.push(repoId)
    }
    if (status) statusByRepoId[repoId] = status
  })

  return {
    overviewByRepoId,
    statusByRepoId,
    dismissedRepoIdsToClear,
  }
}

export function useBranchSnapshotAppBridge({
  repos,
  setRepoBranchOverviews,
  setRepoStatuses,
  setDismissedBranchAttentionKeys,
}) {
  const snapshotRevision = useSyncExternalStore(
    subscribeBranchSnapshots,
    getBranchSnapshotRevision,
    getBranchSnapshotRevision
  )
  const operationRevision = useSyncExternalStore(
    subscribeBranchOperations,
    getBranchOperationRevision,
    getBranchOperationRevision
  )
  const appliedRevisionRef = useRef(0)
  const initializedRef = useRef(false)
  const previousRepoSignatureRef = useRef('')
  const pendingRepoPathsRef = useRef(new Set())
  const repoSignature = useMemo(() => (
    (Array.isArray(repos) ? repos : [])
      .map((repo) => `${String(repo?.id || '').trim()}:${normalizeBranchRepoPath(repo?.path)}`)
      .join('|')
  ), [repos])

  useEffect(() => {
    const previousRevision = appliedRevisionRef.current
    const changes = getBranchSnapshotChangesSince(previousRevision)
    appliedRevisionRef.current = snapshotRevision
    const firstAvailableRevision = Number(changes[0]?.revision) || 0
    const hasChangeLogGap = previousRevision > 0
      && firstAvailableRevision > previousRevision + 1
    const repoListChanged = previousRepoSignatureRef.current !== repoSignature
    previousRepoSignatureRef.current = repoSignature

    if (!initializedRef.current || hasChangeLogGap || repoListChanged) {
      ;(Array.isArray(repos) ? repos : []).forEach((repo) => {
        const repoPath = normalizeBranchRepoPath(repo?.path)
        if (repoPath) pendingRepoPathsRef.current.add(repoPath)
      })
      initializedRef.current = true
    } else {
      changes.forEach((change) => {
        const repoPath = normalizeBranchRepoPath(change?.repoPath)
        if (repoPath) pendingRepoPathsRef.current.add(repoPath)
      })
    }

    const activeOperationPaths = getActiveBranchOperationPaths()
    const readyPaths = new Set()
    pendingRepoPathsRef.current.forEach((repoPath) => {
      if (activeOperationPaths.has(repoPath)) return
      readyPaths.add(repoPath)
      pendingRepoPathsRef.current.delete(repoPath)
    })
    if (readyPaths.size === 0) return

    const patch = buildBranchSnapshotAppPatch(repos, readyPaths)
    applyRecordPatch(setRepoBranchOverviews, patch.overviewByRepoId)
    applyRecordPatch(setRepoStatuses, patch.statusByRepoId)
    clearDismissedKeys(
      setDismissedBranchAttentionKeys,
      patch.dismissedRepoIdsToClear
    )
  }, [
    operationRevision,
    repoSignature,
    repos,
    setDismissedBranchAttentionKeys,
    setRepoBranchOverviews,
    setRepoStatuses,
    snapshotRevision,
  ])
}