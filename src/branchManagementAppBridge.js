export const BRANCH_MANAGEMENT_OPEN_EVENT = 'gitsync:open-branch-management'

const openListeners = new Set()

export function normalizeBranchManagementOpenDetail(input) {
  const repoPath = String(input?.repoPath || '').trim()
  if (!repoPath) return null

  const fallbackName = repoPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Repository'
  return Object.freeze({
    repoId: String(input?.repoId || '').trim(),
    repoName: String(input?.repoName || '').trim() || fallbackName,
    repoPath,
  })
}

export function dispatchBranchManagementOpen(input) {
  const detail = normalizeBranchManagementOpenDetail(input)
  if (!detail || openListeners.size === 0) return false

  Array.from(openListeners).forEach((listener) => listener(detail))
  return true
}

export function subscribeBranchManagementOpen(listener) {
  if (typeof listener !== 'function') return () => {}
  openListeners.add(listener)
  return () => openListeners.delete(listener)
}

export function resetBranchManagementAppBridgeForTests() {
  openListeners.clear()
}
