function toSet(values) {
  if (values instanceof Set) return values
  return new Set(Array.isArray(values) ? values : [])
}

export function getDashboardVisibleRepoIds(visibleRepos) {
  return new Set(
    (Array.isArray(visibleRepos) ? visibleRepos : [])
      .map((repo) => repo?.id)
      .filter((repoId) => repoId !== undefined && repoId !== null)
  )
}

export function getVisibleSelectedRepoIds(selectedRepoIds, visibleRepoIds) {
  const selected = toSet(selectedRepoIds)
  const visible = toSet(visibleRepoIds)
  return [...visible].filter((repoId) => selected.has(repoId))
}

export function getHiddenSelectedRepoIds(selectedRepoIds, visibleRepoIds, repos) {
  const selected = toSet(selectedRepoIds)
  const visible = toSet(visibleRepoIds)
  return (Array.isArray(repos) ? repos : [])
    .map((repo) => repo?.id)
    .filter((repoId) => repoId !== undefined && repoId !== null && selected.has(repoId) && !visible.has(repoId))
}

export function areAllVisibleReposSelected(selectedRepoIds, visibleRepoIds) {
  const visible = toSet(visibleRepoIds)
  if (visible.size === 0) return false
  const selected = toSet(selectedRepoIds)
  return [...visible].every((repoId) => selected.has(repoId))
}

export function toggleVisibleRepoSelection(selectedRepoIds, visibleRepoIds) {
  const selected = [...new Set(Array.isArray(selectedRepoIds) ? selectedRepoIds : [])]
  const visible = [...toSet(visibleRepoIds)]
  const selectedSet = new Set(selected)

  if (visible.length > 0 && visible.every((repoId) => selectedSet.has(repoId))) {
    const visibleSet = new Set(visible)
    return selected.filter((repoId) => !visibleSet.has(repoId))
  }

  for (const repoId of visible) {
    if (!selectedSet.has(repoId)) {
      selected.push(repoId)
      selectedSet.add(repoId)
    }
  }
  return selected
}
