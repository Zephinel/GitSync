function normalizedStashId(value) {
  return String(value || '').trim()
}

export function stashSnapshotHasCompleteStashList(snapshot) {
  return Boolean(snapshot) && snapshot.stashesTruncated !== true
}

export function stashSnapshotContainsStash(snapshot, stashId) {
  const id = normalizedStashId(stashId)
  return Boolean(id && snapshot?.stashes?.some((entry) => entry?.id === id))
}

export function projectStashRetentionFromSnapshot(snapshot, stashId, previousRetained = false) {
  const id = normalizedStashId(stashId)
  if (!id) return Boolean(previousRetained)
  if (stashSnapshotContainsStash(snapshot, id)) return true
  if (stashSnapshotHasCompleteStashList(snapshot)) return false
  return Boolean(previousRetained)
}
