import { dispatchBranchManagementOpen } from './branchManagementAppBridge.js'
import AppIcon from './icons/AppIcon.jsx'
import { EXPAND_ICON } from './icons/iconDefinitions.js'
import './BranchManagementHoverAction.css'

function ExpandIcon() {
  return <AppIcon icon={EXPAND_ICON} className="icon icon--xs" />
}

export default function BranchManagementHoverAction({ repo, onOpenAccepted }) {
  const openCompleteView = (event) => {
    event.preventDefault()
    event.stopPropagation()

    const detail = {
      repoId: repo?.id,
      repoName: repo?.name,
      repoPath: repo?.path,
    }
    if (!dispatchBranchManagementOpen(detail)) return
    onOpenAccepted?.()
  }

  return (
    <button
      type="button"
      className="branch-management-hover-action"
      data-app-tooltip="展开分支完整视图"
      aria-label="展开分支完整视图"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={openCompleteView}
    >
      <ExpandIcon />
    </button>
  )
}
