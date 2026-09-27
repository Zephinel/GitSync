import { invoke as tauriInvoke } from '../node_modules/@tauri-apps/api/core.js'
import {
  beginBranchOperation,
  completeBranchOperation,
  getBranchReadGeneration,
  failBranchOperation,
  getLatestBranchOverview,
  getLatestBranchStatus,
  markBranchOperationAwaitingRefresh,
  normalizeBranchRepoPath,
  registerBranchOverview,
  registerBranchStatus,
  subscribeBranchReadInvalidations,
} from './branchDomainStore.js'

export * from '../node_modules/@tauri-apps/api/core.js'

const BRANCH_OPERATION_COMMANDS = new Set([
  'sync_repo_branch',
  'switch_repo_branch',
  'switch_and_update_repo_branch',
  'rebind_repo_branch_upstream',
  'unset_repo_branch_upstream',
  'delete_repo_branches_batch',
  'execute_repo_branch_creation',
  'resume_repo_branch_creation',
  'reconcile_repo_branch_creation',
])

export const BRANCH_OPERATION_REFRESH_FALLBACK_MS = 5000
const BRANCH_OPERATION_BUSY_MESSAGE = '该仓库已有分支操作正在执行或等待状态刷新，请完成后再试。'

function readRepoPath(args) {
  return String(args?.path || args?.repoPath || args?.repo_path || '').trim()
}

export function createBranchCommandBoundary({
  invokeNative = tauriInvoke,
  refreshFallbackMs = BRANCH_OPERATION_REFRESH_FALLBACK_MS,
  allSettled = (values) => Promise.allSettled(values),
  setTimer = (handler, delay) => setTimeout(handler, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  const pendingRefreshByPath = new Map()
  const readSequenceByPath = new Map()
  const appliedOverviewSequenceByPath = new Map()
  const appliedStatusSequenceByPath = new Map()

  const nextReadSequence = (repoPath) => {
    const normalizedPath = normalizeBranchRepoPath(repoPath)
    const next = (readSequenceByPath.get(normalizedPath) || 0) + 1
    readSequenceByPath.set(normalizedPath, next)
    return next
  }

  const shouldApplyRead = (sequenceMap, repoPath, readSequence) => {
    const normalizedPath = normalizeBranchRepoPath(repoPath)
    const latestApplied = sequenceMap.get(normalizedPath) || 0
    if (readSequence < latestApplied) return false
    sequenceMap.set(normalizedPath, readSequence)
    return true
  }

  const clearPendingRefresh = (repoPath) => {
    const normalizedPath = normalizeBranchRepoPath(repoPath)
    const pending = pendingRefreshByPath.get(normalizedPath)
    if (!pending) return null
    pendingRefreshByPath.delete(normalizedPath)
    if (pending.timer) clearTimer(pending.timer)
    return pending
  }

  const invalidatePendingRefresh = (repoPath) => {
    const normalizedPath = normalizeBranchRepoPath(repoPath)
    const pending = pendingRefreshByPath.get(normalizedPath)
    if (!pending || pending.readGeneration === getBranchReadGeneration(normalizedPath)) return false
    clearPendingRefresh(normalizedPath)
    failBranchOperation(pending.token)
    return true
  }

  const getCurrentPendingRefresh = (repoPath) => {
    const normalizedPath = normalizeBranchRepoPath(repoPath)
    const pending = pendingRefreshByPath.get(normalizedPath)
    if (!pending) return null
    if (pending.readGeneration !== getBranchReadGeneration(normalizedPath)) {
      invalidatePendingRefresh(normalizedPath)
      return null
    }
    return pending
  }

  const settlePendingRefresh = (repoPath) => {
    const normalizedPath = normalizeBranchRepoPath(repoPath)
    const pending = getCurrentPendingRefresh(normalizedPath)
    if (!pending || !pending.overviewSettled || !pending.statusSettled) return false
    clearPendingRefresh(normalizedPath)
    if (!pending.overview && !pending.status) return failBranchOperation(pending.token)
    return completeBranchOperation(pending.token, { overview: pending.overview, status: pending.status })
  }

  const recordPendingSnapshot = (repoPath, key, value, readSequence, readGeneration) => {
    const normalizedPath = normalizeBranchRepoPath(repoPath)
    const pending = getCurrentPendingRefresh(normalizedPath)
    if (
      !pending
      || pending.readGeneration !== readGeneration
      || readSequence < pending.minimumReadSequence
    ) return
    pending[key] = value || null
    pending[`${key}Settled`] = true
    settlePendingRefresh(normalizedPath)
  }

  const unsubscribeReadInvalidations = subscribeBranchReadInvalidations((repoPath) => {
    invalidatePendingRefresh(repoPath)
  })

  const readBranchSnapshot = async (repoPath, expectedGeneration = getBranchReadGeneration(repoPath)) => {
    const [overviewResult, statusResult] = await allSettled([
      invokeNative('get_repo_branch_overview', { path: repoPath }),
      invokeNative('get_repo_status', { path: repoPath }),
    ])
    const generationMatches = expectedGeneration === getBranchReadGeneration(repoPath)
    return {
      overview: generationMatches
        ? (overviewResult.status === 'fulfilled' ? overviewResult.value || null : null)
        : getLatestBranchOverview(repoPath),
      status: generationMatches
        ? (statusResult.status === 'fulfilled' ? statusResult.value || null : null)
        : getLatestBranchStatus(repoPath),
    }
  }

  const waitForAuthoritativeRefresh = (token, repoPath) => {
    if (!token?.repoPath) return
    if (token.readGeneration !== getBranchReadGeneration(token.repoPath)) {
      failBranchOperation(token)
      return
    }
    clearPendingRefresh(token.repoPath)
    const pending = {
      token,
      minimumReadSequence: (readSequenceByPath.get(token.repoPath) || 0) + 1,
      overview: null,
      status: null,
      overviewSettled: false,
      statusSettled: false,
      readGeneration: token.readGeneration,
      timer: 0,
    }
    pendingRefreshByPath.set(token.repoPath, pending)
    markBranchOperationAwaitingRefresh(token)

    pending.timer = setTimer(() => {
      void (async () => {
        const current = getCurrentPendingRefresh(token.repoPath)
        if (current !== pending) return
        const snapshot = await readBranchSnapshot(repoPath, pending.readGeneration)
        if (
          pendingRefreshByPath.get(token.repoPath) !== pending
          || pending.readGeneration !== getBranchReadGeneration(token.repoPath)
        ) {
          invalidatePendingRefresh(token.repoPath)
          return
        }
        const fallbackSequence = nextReadSequence(token.repoPath)
        if (snapshot.overview) appliedOverviewSequenceByPath.set(token.repoPath, fallbackSequence)
        if (snapshot.status) appliedStatusSequenceByPath.set(token.repoPath, fallbackSequence)
        current.overview = snapshot.overview
        current.status = snapshot.status
        current.overviewSettled = true
        current.statusSettled = true
        settlePendingRefresh(token.repoPath)
      })()
    }, refreshFallbackMs)
  }

  const invoke = async (command, args) => {
    const normalizedCommand = String(command || '')
    const repoPath = readRepoPath(args)
    const normalizedPath = normalizeBranchRepoPath(repoPath)

    if (normalizedCommand === 'get_repo_branch_overview') {
      if (!normalizedPath) return invokeNative(command, args)
      const readSequence = nextReadSequence(normalizedPath)
      const readGeneration = getBranchReadGeneration(normalizedPath)
      try {
        const overview = await invokeNative(command, args)
        if (readGeneration !== getBranchReadGeneration(normalizedPath)) {
          const currentOverview = getLatestBranchOverview(repoPath)
          recordPendingSnapshot(normalizedPath, 'overview', currentOverview, readSequence, readGeneration)
          return currentOverview
        }
        const shouldApply = shouldApplyRead(appliedOverviewSequenceByPath, normalizedPath, readSequence)
        const registeredOverview = shouldApply
          ? registerBranchOverview(repoPath, overview || null)
          : (getLatestBranchOverview(repoPath) || overview || null)
        recordPendingSnapshot(
          normalizedPath,
          'overview',
          shouldApply ? overview : registeredOverview,
          readSequence,
          readGeneration
        )
        return registeredOverview
      } catch (error) {
        recordPendingSnapshot(normalizedPath, 'overview', null, readSequence, readGeneration)
        throw error
      }
    }

    if (normalizedCommand === 'get_repo_status') {
      if (!normalizedPath) return invokeNative(command, args)
      const readSequence = nextReadSequence(normalizedPath)
      const readGeneration = getBranchReadGeneration(normalizedPath)
      try {
        const status = await invokeNative(command, args)
        if (readGeneration !== getBranchReadGeneration(normalizedPath)) {
          const currentStatus = getLatestBranchStatus(repoPath)
          recordPendingSnapshot(normalizedPath, 'status', currentStatus, readSequence, readGeneration)
          return currentStatus
        }
        const shouldApply = shouldApplyRead(appliedStatusSequenceByPath, normalizedPath, readSequence)
        const registeredStatus = shouldApply
          ? registerBranchStatus(repoPath, status || null)
          : (getLatestBranchStatus(repoPath) || status || null)
        recordPendingSnapshot(normalizedPath, 'status', registeredStatus, readSequence, readGeneration)
        return registeredStatus
      } catch (error) {
        recordPendingSnapshot(normalizedPath, 'status', null, readSequence, readGeneration)
        throw error
      }
    }

    if (!normalizedPath || !BRANCH_OPERATION_COMMANDS.has(normalizedCommand)) {
      return invokeNative(command, args)
    }

    const token = beginBranchOperation({ repoPath, command: normalizedCommand, args })
    if (!token) throw new Error(BRANCH_OPERATION_BUSY_MESSAGE)

    try {
      const result = await invokeNative(command, args)
      if (token.readGeneration !== getBranchReadGeneration(normalizedPath)) {
        failBranchOperation(token)
        return result
      }
      waitForAuthoritativeRefresh(token, repoPath)
      return result
    } catch (error) {
      clearPendingRefresh(normalizedPath)
      failBranchOperation(token)
      throw error
    }
  }

  const dispose = () => {
    unsubscribeReadInvalidations()
    pendingRefreshByPath.forEach((pending) => {
      if (pending.timer) clearTimer(pending.timer)
      failBranchOperation(pending.token)
    })
    pendingRefreshByPath.clear()
    readSequenceByPath.clear()
    appliedOverviewSequenceByPath.clear()
    appliedStatusSequenceByPath.clear()
  }

  return { invoke, dispose }
}

const defaultBoundary = createBranchCommandBoundary()
export const invoke = (command, args) => defaultBoundary.invoke(command, args)
