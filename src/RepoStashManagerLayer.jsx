import { useEffect, useState } from 'react'
import StashManagerDialog from './StashManagerDialog.jsx'
import { subscribeStashManagerOpen } from './stashManagerAppBridge.js'

export default function RepoStashManagerLayer() {
  const [target, setTarget] = useState(null)
  const [present, setPresent] = useState(false)

  useEffect(() => subscribeStashManagerOpen((nextTarget) => {
    setTarget(nextTarget)
    setPresent(Boolean(nextTarget))
  }), [])

  if (!target) return null

  return (
    <StashManagerDialog
      key={target.openId}
      repoPath={target.repoPath}
      repoName={target.repoName}
      initialStashId={target.initialStashId}
      initialOperation={target.initialOperation}
      overlayParentId={target.overlayParentId}
      present={present}
      onClose={() => setPresent(false)}
      onExitComplete={() => setTarget(null)}
      onChanged={async (result) => {
        await target.onChanged?.(result)
      }}
    />
  )
}
