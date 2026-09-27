export const BRANCH_CREATION_STATUS = Object.freeze({
  complete: 'complete',
  partial: 'partial',
  failed: 'failed',
  unknown: 'unknown',
})

export const EMPTY_NAME_VALIDATION = Object.freeze({
  valid: false,
  normalizedName: '',
  errors: [],
  warnings: [],
  localExists: false,
  remoteExists: false,
  remoteChecked: false,
})

function asText(value) {
  return String(value ?? '').trim()
}

function asCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

export function createBranchCreationRequestId(prefix = 'branch-create') {
  const safePrefix = asText(prefix).replace(/[^a-z0-9_.-]/gi, '-').slice(0, 28) || 'branch-create'
  const random = Math.random().toString(36).slice(2, 10)
  return `${safePrefix}_${Date.now().toString(36)}_${random}`
}

export function normalizeBranchCreationSource(value) {
  const input = value && typeof value === 'object' ? value : {}
  const kind = ['local', 'remote'].includes(asText(input.kind)) ? asText(input.kind) : 'auto'
  return {
    kind,
    name: asText(input.name),
    displayName: asText(input.displayName || input.name),
  }
}

export function normalizeBranchCreationInspection(value) {
  const input = value && typeof value === 'object' ? value : {}
  const sourceOptions = (Array.isArray(input.sourceOptions) ? input.sourceOptions : [])
    .map((option) => ({
      id: asText(option?.id),
      kind: asText(option?.kind),
      label: asText(option?.label),
      fullRef: asText(option?.fullRef),
      commit: asText(option?.commit),
      branchName: asText(option?.branchName),
      remoteName: asText(option?.remoteName) || null,
      recommended: Boolean(option?.recommended),
    }))
    .filter((option) => option.id && option.fullRef && option.commit)
  const defaultSourceOptionId = asText(input.defaultSourceOptionId)
  return {
    sourceDisplayName: asText(input.sourceDisplayName),
    sourceKind: asText(input.sourceKind),
    relationship: asText(input.relationship),
    localName: asText(input.localName) || null,
    localRef: asText(input.localRef) || null,
    localCommit: asText(input.localCommit) || null,
    upstreamRef: asText(input.upstreamRef) || null,
    remoteName: asText(input.remoteName) || null,
    remoteBranch: asText(input.remoteBranch) || null,
    remoteRef: asText(input.remoteRef) || null,
    remoteCommit: asText(input.remoteCommit) || null,
    ahead: asCount(input.ahead),
    behind: asCount(input.behind),
    sourceOptions,
    defaultSourceOptionId: sourceOptions.some((option) => option.id === defaultSourceOptionId)
      ? defaultSourceOptionId
      : '',
    requiresSourceChoice: Boolean(input.requiresSourceChoice),
    warnings: (Array.isArray(input.warnings) ? input.warnings : []).map(asText).filter(Boolean),
    currentBranch: asText(input.currentBranch) || null,
    detachedHead: Boolean(input.detachedHead),
    worktreeDirty: Boolean(input.worktreeDirty),
    changedPathCount: asCount(input.changedPathCount),
    remotes: (Array.isArray(input.remotes) ? input.remotes : []).map(asText).filter(Boolean),
    preferredRemote: asText(input.preferredRemote) || null,
    fingerprint: asText(input.fingerprint),
  }
}

export function chooseInitialSourceOption(inspection) {
  if (!inspection) return ''
  if (inspection.requiresSourceChoice) return ''
  if (inspection.defaultSourceOptionId) return inspection.defaultSourceOptionId
  return inspection.sourceOptions?.length === 1 ? inspection.sourceOptions[0].id : ''
}

export function findSourceOption(inspection, sourceOptionId) {
  return inspection?.sourceOptions?.find((option) => option.id === sourceOptionId) || null
}

export function normalizeBranchNameValidation(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    valid: Boolean(input.valid),
    normalizedName: asText(input.normalizedName),
    errors: (Array.isArray(input.errors) ? input.errors : []).map(asText).filter(Boolean),
    warnings: (Array.isArray(input.warnings) ? input.warnings : []).map(asText).filter(Boolean),
    localExists: Boolean(input.localExists),
    remoteExists: Boolean(input.remoteExists),
    remoteChecked: Boolean(input.remoteChecked),
  }
}

export function normalizeBranchCreationOperation(value) {
  const input = value && typeof value === 'object' ? value : {}
  const status = Object.values(BRANCH_CREATION_STATUS).includes(asText(input.status))
    ? asText(input.status)
    : BRANCH_CREATION_STATUS.unknown
  return {
    requestId: asText(input.requestId),
    status,
    branchName: asText(input.branchName),
    sourceRef: asText(input.sourceRef),
    sourceCommit: asText(input.sourceCommit),
    localCreated: Boolean(input.localCreated),
    switched: Boolean(input.switched),
    currentBranch: asText(input.currentBranch) || null,
    worktreeWasDirty: Boolean(input.worktreeWasDirty),
    worktreeIsDirty: Boolean(input.worktreeIsDirty),
    remoteCreated: Boolean(input.remoteCreated),
    trackingConfigured: Boolean(input.trackingConfigured),
    targetRemote: asText(input.targetRemote) || null,
    completedSteps: (Array.isArray(input.completedSteps) ? input.completedSteps : []).map(asText).filter(Boolean),
    pendingSteps: (Array.isArray(input.pendingSteps) ? input.pendingSteps : []).map(asText).filter(Boolean),
    retryableSteps: (Array.isArray(input.retryableSteps) ? input.retryableSteps : []).map(asText).filter(Boolean),
    warnings: (Array.isArray(input.warnings) ? input.warnings : []).map(asText).filter(Boolean),
    errors: (Array.isArray(input.errors) ? input.errors : []).map(asText).filter(Boolean),
    resultNeedsConfirmation: Boolean(input.resultNeedsConfirmation),
    message: asText(input.message),
  }
}

export function normalizeAiBranchNameResult(value) {
  const input = value && typeof value === 'object' ? value : {}
  const seen = new Set()
  return {
    requestId: asText(input.requestId),
    model: asText(input.model),
    providerHost: asText(input.providerHost),
    suggestions: (Array.isArray(input.suggestions) ? input.suggestions : [])
      .map((suggestion) => ({
        name: asText(suggestion?.name),
        reason: asText(suggestion?.reason),
      }))
      .filter((suggestion) => {
        if (!suggestion.name || seen.has(suggestion.name)) return false
        seen.add(suggestion.name)
        return true
      }),
    usedRepositoryContext: Boolean(input.usedRepositoryContext),
    branchSampleCount: asCount(input.branchSampleCount),
  }
}

export function buildBranchCreationInputRevision({
  inspectionFingerprint,
  sourceOptionId,
  branchName,
  publish,
  remote,
  taskDescription,
  includeRepositoryContext,
}) {
  return JSON.stringify({
    inspectionFingerprint: asText(inspectionFingerprint),
    sourceOptionId: asText(sourceOptionId),
    branchName: asText(branchName),
    publish: Boolean(publish),
    remote: asText(remote),
    taskDescription: asText(taskDescription),
    includeRepositoryContext: Boolean(includeRepositoryContext),
  })
}

export function buildAiSuggestionRevision({
  inspectionFingerprint,
  sourceOptionId,
  taskDescription,
  includeRepositoryContext,
  publish,
  remote,
}) {
  return JSON.stringify({
    inspectionFingerprint: asText(inspectionFingerprint),
    sourceOptionId: asText(sourceOptionId),
    taskDescription: asText(taskDescription),
    includeRepositoryContext: Boolean(includeRepositoryContext),
    publish: Boolean(publish),
    remote: asText(remote),
  })
}

export function canConfirmBranchCreation({
  inspection,
  sourceOptionId,
  validation,
  validationRevision,
  currentRevision,
  busy,
}) {
  return Boolean(
    inspection?.fingerprint
      && findSourceOption(inspection, sourceOptionId)
      && validation?.valid
      && validationRevision
      && validationRevision === currentRevision
      && !busy
  )
}

export function relationshipLabel(inspection) {
  if (!inspection) return '正在确认'
  switch (inspection.relationship) {
    case 'local-only': return '仅本地，无 upstream'
    case 'synced': return '本地与远端一致'
    case 'behind': return `本地落后远端 ${inspection.behind}`
    case 'ahead': return `本地领先远端 ${inspection.ahead}`
    case 'diverged': return `本地与远端分叉 ${inspection.ahead}/${inspection.behind}`
    case 'upstream-gone': return '原远端目标已消失'
    case 'remote-only': return '仅远端来源'
    default: return inspection.relationship || '状态未知'
  }
}

export function operationTone(status) {
  switch (status) {
    case BRANCH_CREATION_STATUS.complete: return 'success'
    case BRANCH_CREATION_STATUS.partial: return 'warning'
    case BRANCH_CREATION_STATUS.failed: return 'danger'
    default: return 'unknown'
  }
}
