function count(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

export function resolveWorkingChangesStashEntryMode(snapshot, {
  loading = false,
  error = '',
} = {}) {
  if (loading || error || !snapshot) {
    return {
      state: 'unknown',
      manageOnly: false,
      canCreate: false,
      reason: error ? String(error) : '正在确认当前工作区是否可以创建 Stash。',
    }
  }

  const conflictedFiles = count(snapshot.conflictedFiles)
  const hasTrackedChanges = snapshot.hasTrackedChanges === true
  const hasUntrackedChanges = snapshot.hasUntrackedChanges === true
  const clean = !hasTrackedChanges && !hasUntrackedChanges && conflictedFiles === 0

  if (clean) {
    return {
      state: 'clean',
      manageOnly: true,
      canCreate: false,
      reason: '当前工作区没有可保存的改动。',
    }
  }

  const canCreate = snapshot.canCreateDefault === true
    || snapshot.canCreateWithUntracked === true

  return {
    state: conflictedFiles > 0 ? 'conflict' : 'changes',
    manageOnly: false,
    canCreate,
    reason: conflictedFiles > 0
      ? '当前存在未解决冲突，不能创建 Stash；可以继续管理已有 Stash。'
      : canCreate
        ? ''
        : '当前改动暂时不能安全创建 Stash。',
  }
}
