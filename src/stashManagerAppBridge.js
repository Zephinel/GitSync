let owner = null
let pendingTarget = null
let openSequence = 0

export function normalizeStashManagerTarget(input) {
  const repoPath = String(input?.repoPath || '').trim()
  if (!repoPath) return null
  const fallbackName = repoPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Repository'
  const operation = ['apply', 'pop', 'drop'].includes(input?.initialOperation)
    ? input.initialOperation
    : null
  return Object.freeze({
    openId: ++openSequence,
    repoId: String(input?.repoId || '').trim(),
    repoName: String(input?.repoName || '').trim() || fallbackName,
    repoPath,
    initialStashId: String(input?.initialStashId || input?.stashId || '').trim() || null,
    initialOperation: operation,
    overlayParentId: String(input?.overlayParentId || '').trim(),
    onChanged: typeof input?.onChanged === 'function' ? input.onChanged : null,
  })
}

export function dispatchStashManagerOpen(input) {
  const target = normalizeStashManagerTarget(input)
  if (!target) return false
  if (typeof owner === 'function') owner(target)
  else pendingTarget = target
  return true
}

export function subscribeStashManagerOpen(listener) {
  if (typeof listener !== 'function') return () => {}
  owner = listener
  if (pendingTarget) {
    const target = pendingTarget
    pendingTarget = null
    owner(target)
  }
  return () => {
    if (owner === listener) owner = null
  }
}

export function resetStashManagerAppBridgeForTests() {
  owner = null
  pendingTarget = null
  openSequence = 0
}
