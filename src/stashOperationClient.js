import { invoke } from '@tauri-apps/api/core'
import {
  isStashAuthorityAdmissionTimeout,
  stashErrorMessage,
} from './stashError.js'
import {
  beginStashSnapshotMutation,
  publishStashMutationSnapshot,
  readStashSnapshot,
  releaseStashSnapshotMutation,
} from './stashSnapshotRepository.js'
import { normalizeStashOperationResult } from './stashViewModel.js'
import { projectStashRetentionFromSnapshot } from './stashSnapshotCompleteness.js'

const STASH_OPERATION_BUSY_MESSAGE = '该仓库已有 Stash 操作正在执行或确认结果；本次操作未开始。'
const STASH_RESPONSE_IDENTITY_WARNING = 'Stash 操作响应与当前请求身份不一致；不会安装该响应中的条目或快照。'
export { stashErrorMessage } from './stashError.js'
export const STASH_SNAPSHOT_INSTALL_WARNING = '操作结果已返回，但权威 Stash 快照无法安装或重新读取；已保留 mutation 事实并要求确认当前状态。'
export const STASH_RECONCILE_TIMEOUT_WARNING = '操作结果快照已保留，但进一步的权威对账等待超时；当前结果仍需确认。'

function authorityAdmissionErrorDetail(error) {
  return stashErrorMessage(error)
}

function stashOperationBusyError() {
  const error = new Error(STASH_OPERATION_BUSY_MESSAGE)
  error.code = 'STASH_OPERATION_BUSY'
  error.needsConfirmation = false
  return error
}

export function createStashOperationClient({
  invokeNative = invoke,
  normalizeResult = normalizeStashOperationResult,
  snapshotRepository = {
    beginMutation: beginStashSnapshotMutation,
    releaseMutation: releaseStashSnapshotMutation,
    publishMutation: publishStashMutationSnapshot,
    read: readStashSnapshot,
  },
} = {}) {
  const activeOperations = new Map()

  const enterOperation = (repoPath) => {
    const key = String(repoPath || '').trim()
    if (!key) throw new Error('仓库路径不能为空')
    if (activeOperations.has(key)) throw stashOperationBusyError()
    const token = Symbol(key)
    activeOperations.set(key, token)
    return () => {
      if (activeOperations.get(key) === token) activeOperations.delete(key)
    }
  }

  const release = (token) => {
    try { snapshotRepository.releaseMutation?.(token) } catch { /* release cannot rewrite a Git result */ }
  }

  const preserveSnapshotFailure = (result, error) => ({
    ...result,
    status: ['complete', 'acknowledged'].includes(result?.status)
      ? 'needs_confirmation'
      : result?.status || 'needs_confirmation',
    needsConfirmation: true,
    snapshot: null,
    snapshotError: stashErrorMessage(error),
    warnings: Array.from(new Set([...(result.warnings || []), STASH_SNAPSHOT_INSTALL_WARNING])),
    message: STASH_SNAPSHOT_INSTALL_WARNING,
  })

  const preserveAuthorityReprojectTimeout = (result, error) => ({
    ...result,
    status: ['complete', 'acknowledged'].includes(result?.status)
      ? 'needs_confirmation'
      : result?.status || 'needs_confirmation',
    needsConfirmation: true,
    warnings: Array.from(new Set([
      ...(result?.warnings || []),
      `${STASH_RECONCILE_TIMEOUT_WARNING} ${stashErrorMessage(error)}`.trim(),
    ])),
  })

  const authorityAdmissionFailure = ({ operation, request, requestId, error }) => ({
    operation,
    requestId,
    status: 'failed',
    mutated: false,
    needsConfirmation: false,
    worktreeChanged: false,
    createdStashId: null,
    targetStashId: String(request?.stashId || '').trim() || null,
    applied: false,
    dropped: false,
    stashRetained: false,
    conflicts: [],
    warnings: [],
    errors: [authorityAdmissionErrorDetail(error)],
    snapshot: null,
    snapshotError: null,
    message: '未取得 Stash authority，本次请求明确未进入 Git 临界区。',
  })

  const shouldReconcileProjection = (result, requestId, operation, expectedTargetStashId) => Boolean(
    requestId
    && (
      result?.snapshotError
      || result?.needsConfirmation
      || result?.status === 'needs_confirmation'
      || result?.requestId !== requestId
      || (operation && result?.operation !== operation)
      || (expectedTargetStashId && result?.targetStashId !== expectedTargetStashId)
    )
  )

  const responseIdentityMatches = (result, requestId, operation, expectedTargetStashId) => Boolean(
    result
    && (!requestId || result.requestId === requestId)
    && (!operation || result.operation === operation)
    && (!expectedTargetStashId || result.targetStashId === expectedTargetStashId)
  )

  const failClosedIdentity = (result, requestId, operation, expectedTargetStashId) => ({
    ...result,
    operation: operation || result?.operation || '',
    requestId: requestId || result?.requestId || '',
    status: 'needs_confirmation',
    mutated: false,
    needsConfirmation: true,
    worktreeChanged: false,
    createdStashId: null,
    targetStashId: expectedTargetStashId || null,
    applied: false,
    dropped: false,
    stashRetained: false,
    conflicts: [],
    snapshot: null,
    snapshotError: null,
    warnings: Array.from(new Set([...(result?.warnings || []), STASH_RESPONSE_IDENTITY_WARNING])),
    message: STASH_RESPONSE_IDENTITY_WARNING,
  })

  const reconcileArgs = (repoPath, requestId, operation = '', targetStashId = '', expectedSnapshotId = '') => ({
    repoPath,
    requestId,
    expectedOperation: operation || null,
    expectedTargetStashId: targetStashId || null,
    expectedSnapshotId: expectedSnapshotId || null,
  })

  const reprojectUncertainResult = async (
    repoPath,
    requestId,
    operation,
    result,
    {
      enabled = true,
      expectedTargetStashId = '',
      expectedSnapshotId = '',
    } = {},
  ) => {
    if (!enabled || !shouldReconcileProjection(
      result,
      requestId,
      operation,
      expectedTargetStashId,
    )) return { result, authorityError: null }
    try {
      return {
        result: normalizeResult(await invokeNative(
          'reconcile_repo_stash_operation',
          reconcileArgs(repoPath, requestId, operation, expectedTargetStashId, expectedSnapshotId),
        )),
        authorityError: null,
      }
    } catch (error) {
      return {
        result,
        authorityError: isStashAuthorityAdmissionTimeout(error) ? error : null,
      }
    }
  }

  const forceAuthorityRead = (repoPath, token) => snapshotRepository.read(repoPath, {
    force: true,
    mutationToken: token,
  })

  const refreshAuthorityAfterControlFailure = async (repoPath, token, error) => {
    if (isStashAuthorityAdmissionTimeout(error)) throw error
    try {
      await forceAuthorityRead(repoPath, token)
    } catch {
      // The original control-command error remains the primary failure. A
      // failed authority read cannot make that command safer to retry.
    }
    throw error
  }

  const installObservedSnapshot = (result, snapshot) => {
    if (!snapshot) return result
    const targetStashId = String(result?.targetStashId || '').trim()
    return {
      ...result,
      snapshot,
      ...(targetStashId
        ? { stashRetained: projectStashRetentionFromSnapshot(snapshot, targetStashId, result?.stashRetained) }
        : {}),
    }
  }

  const installResultSnapshot = async (
    repoPath,
    token,
    result,
    {
      allowAuthorityRead = true,
      authorityError = null,
    } = {},
  ) => {
    if (result.snapshot) {
      let installError = null
      try {
        const installed = snapshotRepository.publishMutation(token, result.snapshot)
        if (installed) return installObservedSnapshot(result, installed)
        installError = new Error('操作快照已被更新的仓库状态淘汰')
      } catch (error) {
        installError = error
      }

      if (!allowAuthorityRead) {
        return preserveSnapshotFailure(
          result,
          new Error([
            stashErrorMessage(installError),
            authorityError ? stashErrorMessage(authorityError) : '',
          ].filter(Boolean).join('；')),
        )
      }

      try {
        const observed = await forceAuthorityRead(repoPath, token)
        if (observed) return installObservedSnapshot(result, observed)
        throw new Error('重新读取权威 Stash 快照后没有返回可安装结果')
      } catch (readError) {
        return preserveSnapshotFailure(
          result,
          new Error(`${stashErrorMessage(installError)}；${stashErrorMessage(readError)}`),
        )
      }
    }

    if (!allowAuthorityRead) {
      return preserveSnapshotFailure(
        result,
        authorityError || new Error('当前不允许再次等待权威 Stash 快照'),
      )
    }

    let next = result
    try {
      const observed = await forceAuthorityRead(repoPath, token)
      if (observed) next = installObservedSnapshot(next, observed)
    } catch (error) {
      return preserveSnapshotFailure(next, error)
    }
    return next
  }

  const projectAndInstall = async (
    repoPath,
    token,
    requestId,
    raw,
    {
      operation = '',
      allowReproject = true,
      expectedTargetStashId = '',
      expectedSnapshotId = '',
    } = {},
  ) => {
    const normalized = normalizeResult(raw)
    const reprojected = await reprojectUncertainResult(
      repoPath,
      requestId,
      operation,
      normalized,
      { enabled: allowReproject, expectedTargetStashId, expectedSnapshotId },
    )
    const projected = reprojected.result
    const identified = responseIdentityMatches(
      projected,
      requestId,
      operation,
      expectedTargetStashId,
    )
      ? projected
      : failClosedIdentity(projected, requestId, operation, expectedTargetStashId)
    if (reprojected.authorityError) {
      const timedOut = preserveAuthorityReprojectTimeout(identified, reprojected.authorityError)
      return installResultSnapshot(repoPath, token, timedOut, {
        allowAuthorityRead: false,
        authorityError: reprojected.authorityError,
      })
    }
    return installResultSnapshot(repoPath, token, identified)
  }

  const unresolvedFailure = ({ operation, request, requestId, initialError, reconcileError }) => {
    const targetStashId = String(request?.stashId || '').trim() || null
    return {
      operation,
      requestId,
      status: 'needs_confirmation',
      mutated: false,
      needsConfirmation: true,
      worktreeChanged: false,
      createdStashId: null,
      targetStashId,
      applied: false,
      dropped: false,
      stashRetained: false,
      conflicts: [],
      warnings: [],
      errors: [`${stashErrorMessage(initialError)}；${stashErrorMessage(reconcileError)}`],
      snapshot: null,
      snapshotError: null,
      message: '操作响应与状态确认均未完成；不会自动重试。',
    }
  }

  const runExclusive = async (repoPath, callback) => {
    const leaveOperation = enterOperation(repoPath)
    let snapshotToken = null
    try {
      snapshotToken = snapshotRepository.beginMutation(repoPath)
      return await callback(snapshotToken)
    } finally {
      if (snapshotToken) release(snapshotToken)
      leaveOperation()
    }
  }

  const invokeMutation = async ({
    repoPath,
    operation,
    command,
    request,
    requestId = request?.requestId,
    reconcile = true,
  }) => runExclusive(repoPath, async (token) => {
    let raw
    try {
      raw = await invokeNative(command, { repoPath, request })
    } catch (initialError) {
      if (isStashAuthorityAdmissionTimeout(initialError)) {
        return authorityAdmissionFailure({ operation, request, requestId, error: initialError })
      }
      if (!reconcile || !requestId) throw initialError
      try {
        raw = await invokeNative(
          'reconcile_repo_stash_operation',
          reconcileArgs(
            repoPath,
            requestId,
            operation,
            String(request?.stashId || '').trim(),
            String(request?.expectedSnapshotId || '').trim(),
          ),
        )
      } catch (reconcileError) {
        const unresolved = unresolvedFailure({
          operation,
          request,
          requestId,
          initialError,
          reconcileError,
        })
        if (isStashAuthorityAdmissionTimeout(reconcileError)) return unresolved
        return installResultSnapshot(repoPath, token, unresolved)
      }
    }
    return projectAndInstall(repoPath, token, requestId, raw, {
      operation,
      expectedTargetStashId: String(request?.stashId || '').trim(),
      expectedSnapshotId: String(request?.expectedSnapshotId || '').trim(),
    })
  })

  const reconcileOperation = async (repoPath, requestId) => runExclusive(repoPath, async (token) => {
    let raw
    try {
      raw = await invokeNative('reconcile_repo_stash_operation', reconcileArgs(repoPath, requestId))
    } catch (error) {
      return refreshAuthorityAfterControlFailure(repoPath, token, error)
    }
    return projectAndInstall(repoPath, token, requestId, raw, { allowReproject: false })
  })

  const acknowledgeOperation = async (repoPath, requestId, expectedSnapshotId) => runExclusive(repoPath, async (token) => {
    let raw
    try {
      raw = await invokeNative('acknowledge_repo_stash_operation', {
        repoPath,
        requestId,
        expectedSnapshotId,
      })
    } catch (error) {
      return refreshAuthorityAfterControlFailure(repoPath, token, error)
    }
    return projectAndInstall(repoPath, token, requestId, raw, { allowReproject: false })
  })

  const stats = () => ({ activeRepositories: activeOperations.size })
  const activeOperationPaths = () => Array.from(activeOperations.keys())

  return { invokeMutation, reconcileOperation, acknowledgeOperation, stats, activeOperationPaths }
}

const defaultClient = createStashOperationClient()

export const invokeStashMutation = (options) => defaultClient.invokeMutation(options)
export const reconcileStashOperation = (repoPath, requestId) => defaultClient.reconcileOperation(repoPath, requestId)
export const acknowledgeStashOperation = (repoPath, requestId, expectedSnapshotId) => defaultClient.acknowledgeOperation(repoPath, requestId, expectedSnapshotId)
export const getActiveStashOperationPaths = () => defaultClient.activeOperationPaths()
