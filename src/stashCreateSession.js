function text(value) {
  return String(value || '').trim()
}

function freezeFiles(files) {
  return Object.freeze((Array.isArray(files) ? files : []).map((file) => (
    Object.freeze({ ...file })
  )))
}

export function createStashCreateSession({
  openId,
  repoPath,
  repoName,
  files,
  onChanged,
}) {
  const normalizedPath = text(repoPath)
  if (!normalizedPath) return null
  return Object.freeze({
    openId: Number(openId) || 1,
    repoPath: normalizedPath,
    repoName: text(repoName) || '当前仓库',
    files: freezeFiles(files),
    onChanged: typeof onChanged === 'function' ? onChanged : null,
  })
}

export function stashCreateSessionMatchesContext(session, {
  repoPath,
  visible = true,
}) {
  return Boolean(
    session
    && visible
    && text(repoPath)
    && session.repoPath === text(repoPath)
  )
}
