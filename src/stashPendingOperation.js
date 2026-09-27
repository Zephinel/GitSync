function text(value) {
  return String(value || '').trim()
}

export function normalizeStashWorktreePath(value) {
  const normalized = text(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function pendingOperationOriginLabel(operation, currentRepoPath) {
  const rawOrigin = text(operation?.originRepoPath)
  if (!rawOrigin) return '旧记录：来源 worktree 身份不可用'

  const origin = normalizeStashWorktreePath(rawOrigin)
  const current = normalizeStashWorktreePath(currentRepoPath)
  return current && origin === current
    ? `来源 worktree：${rawOrigin}（当前）`
    : `来源 worktree：${rawOrigin}`
}

export function pendingStashOperationPermissions(operation, currentRepoPath) {
  const origin = normalizeStashWorktreePath(operation?.originRepoPath)
  const current = normalizeStashWorktreePath(currentRepoPath)

  if (!origin) {
    return {
      originKnown: false,
      belongsToCurrent: false,
      canReconcile: false,
      canAcknowledge: Boolean(current),
      reason: '这是升级前的旧操作记录，缺少来源 worktree 身份；不能自动对账，只能在确认当前状态后显式接受。',
    }
  }

  const belongsToCurrent = Boolean(current && origin === current)
  return {
    originKnown: true,
    belongsToCurrent,
    canReconcile: belongsToCurrent,
    canAcknowledge: belongsToCurrent,
    reason: belongsToCurrent
      ? ''
      : `该操作来自另一个 worktree：${operation.originRepoPath}`,
  }
}
