import { normalizeBranchRepoPath } from './branchDomainStore.js'

const REPO_CARD_SELECTOR = '.repo-card'
const REPO_PATH_SELECTOR = '.repo-card__path-text'
const ATTENTION_SELECTOR = '.repo-card__branch-attention'

function getElementRect(element) {
  const rect = element?.getBoundingClientRect?.()
  if (!rect || Number(rect.width) <= 0 || Number(rect.height) <= 0) return null
  return {
    top: Math.round(Number(rect.top) || 0),
    left: Math.round(Number(rect.left) || 0),
    width: Math.round(Number(rect.width) || 0),
    height: Math.round(Number(rect.height) || 0),
  }
}

function normalizeActivePaths(activePaths) {
  if (!(activePaths instanceof Set) || activePaths.size === 0) return new Set()
  return new Set(Array.from(activePaths, normalizeBranchRepoPath).filter(Boolean))
}

export function getLockedBranchAttentionPath(target, activePaths) {
  if (!target?.closest) return ''
  const normalizedActivePaths = normalizeActivePaths(activePaths)
  if (normalizedActivePaths.size === 0) return ''

  const attention = target.closest(ATTENTION_SELECTOR)
  const repoCard = attention?.closest?.(REPO_CARD_SELECTOR)
  const repoPath = normalizeBranchRepoPath(
    repoCard?.querySelector?.(REPO_PATH_SELECTOR)?.textContent
  )
  return repoPath && normalizedActivePaths.has(repoPath) ? repoPath : ''
}

export function collectBranchOperationOverlays(documentObject, activePaths) {
  if (!documentObject?.querySelectorAll) return []

  const normalizedActivePaths = normalizeActivePaths(activePaths)
  if (normalizedActivePaths.size === 0) return []

  return Array.from(documentObject.querySelectorAll(REPO_CARD_SELECTOR))
    .map((repoCard, index) => {
      const repoPath = normalizeBranchRepoPath(
        repoCard.querySelector?.(REPO_PATH_SELECTOR)?.textContent
      )
      if (!repoPath || !normalizedActivePaths.has(repoPath)) return null

      const attention = repoCard.querySelector?.(ATTENTION_SELECTOR)
      const rect = getElementRect(attention)
      if (!attention?.isConnected || !rect) return null

      const repoId = String(repoCard.getAttribute?.('data-repo-card-id') || '').trim()
      return {
        key: `${repoId || repoPath}:${index}`,
        repoPath,
        repoName: repoCard.querySelector?.('.repo-card__name')?.textContent?.trim() || repoId || 'Repository',
        element: attention,
        style: {
          position: 'fixed',
          top: `${rect.top}px`,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        },
      }
    })
    .filter(Boolean)
}

export function areBranchOperationOverlayLayoutsEqual(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false

  return left.every((item, index) => {
    const other = right[index]
    return item?.key === other?.key
      && item?.repoPath === other?.repoPath
      && item?.repoName === other?.repoName
      && item?.element === other?.element
      && item?.style?.top === other?.style?.top
      && item?.style?.left === other?.style?.left
      && item?.style?.width === other?.style?.width
      && item?.style?.height === other?.style?.height
  })
}
