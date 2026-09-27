export const OVERLAY_LEVEL = Object.freeze({
  workspace: 'workspace',
  dialog: 'dialog',
  nested: 'nested',
})

export const OVERLAY_LANE_ID = Object.freeze({
  [OVERLAY_LEVEL.workspace]: 'app-overlay-workspace',
  [OVERLAY_LEVEL.dialog]: 'app-overlay-dialog',
  [OVERLAY_LEVEL.nested]: 'app-overlay-nested',
})

export const OVERLAY_ID = Object.freeze({
  workingChanges: 'working-changes',
  workingChangesOperation: 'working-changes-operation',
  createStash: 'create-stash',
  stashManager: 'stash-manager',
  stashOperation: 'stash-operation',
  branchManagement: 'branch-management',
  branchCreation: 'branch-creation',
  branchDelete: 'branch-delete',
  branchAttention: 'branch-attention',
  branchAttentionDelete: 'branch-attention-delete',
  aiReviewPreview: 'ai-review-preview',
  aiReviewDrawer: 'ai-review-drawer',
  repoBranchDelete: 'repo-branch-delete',
  cloneRepo: 'clone-repo',
  githubRepoBrowser: 'github-repo-browser',
  deviceAuth: 'device-auth',
  conflict: 'conflict',
  errorLog: 'error-log',
  removeRepo: 'remove-repo',
  importResult: 'import-result',
  syncGuard: 'sync-guard',
  scriptLog: 'script-log',
  appUpdate: 'app-update',
  notice: 'notice',
})

export function getOverlayLaneId(level) {
  const laneId = OVERLAY_LANE_ID[level]
  if (!laneId) throw new Error(`Unknown overlay level: ${String(level)}`)
  return laneId
}
