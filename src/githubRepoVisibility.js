export function normalizeGithubRepoKey(value) {
  return String(value || '').trim().toLowerCase()
}

export function getGithubRepoFullNameKey(repo) {
  return normalizeGithubRepoKey(repo?.full_name)
}

export function getGithubRepoNameKey(repo) {
  return normalizeGithubRepoKey(repo?.name)
}

export function getExistingGithubRepoNameFallbackKeys(repos, getFullNameFromRemote) {
  const keys = new Set()
  for (const repo of Array.isArray(repos) ? repos : []) {
    const fullName = typeof getFullNameFromRemote === 'function'
      ? getFullNameFromRemote(repo?.remote)
      : ''
    if (fullName) continue
    const nameKey = normalizeGithubRepoKey(repo?.name)
    if (nameKey) keys.add(nameKey)
  }
  return keys
}

export function isGithubRepoAlreadyAdded(githubRepo, existingFullNameKeys, existingNameKeys) {
  const fullNameKey = getGithubRepoFullNameKey(githubRepo)
  if (fullNameKey && existingFullNameKeys instanceof Set && existingFullNameKeys.has(fullNameKey)) {
    return true
  }

  const nameKey = getGithubRepoNameKey(githubRepo)
  return Boolean(nameKey && existingNameKeys instanceof Set && existingNameKeys.has(nameKey))
}
