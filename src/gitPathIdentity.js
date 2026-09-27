// Git-reported repository-relative file paths are opaque identities.
// Do not trim whitespace or rewrite path separators here: on POSIX, both
// leading/trailing spaces and backslashes are valid filename characters.
export function gitPathIdentity(value) {
  return String(value ?? '')
}

export function optionalGitPathIdentity(value) {
  const path = gitPathIdentity(value)
  return path === '' ? null : path
}

// Git's repository-relative path separator is '/'. A backslash is a legal
// filename character on POSIX and must remain visible as part of the name.
export function splitGitRepoPath(value) {
  const path = gitPathIdentity(value)
  const separatorIndex = path.lastIndexOf('/')
  if (separatorIndex < 0) {
    return { directory: '', fileName: path || '-' }
  }
  return {
    directory: path.slice(0, separatorIndex + 1),
    fileName: path.slice(separatorIndex + 1) || path || '-',
  }
}
