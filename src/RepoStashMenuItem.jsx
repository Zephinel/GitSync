import { dispatchStashManagerOpen } from './stashManagerAppBridge.js'
import { StashIcon } from './icons/CanonicalIcons.jsx'

export default function RepoStashMenuItem({
  repo,
  disabled = false,
  onOpenAccepted,
  onChanged,
}) {
  const openManager = () => {
    if (disabled) return
    const accepted = dispatchStashManagerOpen({
      repoId: repo?.id,
      repoName: repo?.name,
      repoPath: repo?.path,
      onChanged,
    })
    if (accepted) onOpenAccepted?.()
  }

  return (
    <button
      className="repo-card__more-item"
      role="menuitem"
      type="button"
      onClick={openManager}
      disabled={disabled}
    >
      <StashIcon className="icon icon--sm" />
      <span className="repo-card__more-text">Stash 管理</span>
    </button>
  )
}
