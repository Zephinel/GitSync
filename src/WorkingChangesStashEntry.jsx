import { useEffect, useMemo, useRef, useState } from 'react'
import CreateStashDialog from './CreateStashDialog.jsx'
import StashManagementPopover from './StashManagementPopover.jsx'
import DirectionalChevronIcon from './icons/DirectionalChevronIcon.jsx'
import { StashIcon } from './icons/CanonicalIcons.jsx'
import {
  createStashCreateSession,
  stashCreateSessionMatchesContext,
} from './stashCreateSession.js'
import { dispatchStashManagerOpen } from './stashManagerAppBridge.js'
import { OVERLAY_ID } from './overlayLayerContract.js'
import {
  normalizeSelectedStashTargets,
  selectedStashScopeLabel,
} from './stashScopeResolution.js'
import useStashSnapshotState from './useStashSnapshotState.js'
import { resolveWorkingChangesStashEntryMode } from './workingChangesStashEntryMode.js'

export default function WorkingChangesStashEntry({
  visible = false,
  disabled = false,
  data,
  selectedFiles = [],
  onChanged,
}) {
  const files = useMemo(() => normalizeSelectedStashTargets(selectedFiles), [selectedFiles])
  const createSequenceRef = useRef(0)
  const menuButtonRef = useRef(null)
  const [createSession, setCreateSession] = useState(null)
  const [createPresent, setCreatePresent] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [snapshotSettled, setSnapshotSettled] = useState(false)
  const repoPath = data?.repoPath || ''
  const repoName = data?.repoName || '当前仓库'
  const {
    snapshot,
    loading: snapshotLoading,
    error: snapshotError,
    refresh: refreshSnapshot,
  } = useStashSnapshotState(repoPath, { autoLoad: false })

  useEffect(() => {
    if (disabled || !visible || !repoPath) setMenuOpen(false)
    if (createSession && !stashCreateSessionMatchesContext(createSession, { repoPath, visible })) {
      setCreatePresent(false)
    }
  }, [createSession, disabled, repoPath, visible])

  useEffect(() => {
    let disposed = false
    if (!visible || !repoPath || disabled) {
      setSnapshotSettled(false)
      return () => {
        disposed = true
      }
    }

    setSnapshotSettled(false)
    void refreshSnapshot({ force: true }).finally(() => {
      if (!disposed) setSnapshotSettled(true)
    })
    return () => {
      disposed = true
    }
  }, [disabled, refreshSnapshot, repoPath, visible])

  const entryMode = resolveWorkingChangesStashEntryMode(snapshot, {
    loading: !snapshotSettled || snapshotLoading,
    error: snapshotError,
  })
  const createDisabled = disabled || !repoPath || !entryMode.canCreate
  const createTitle = entryMode.reason
    || (files.length > 0 ? `只 Stash 当前选择的 ${files.length} 个文件` : 'Stash 全部当前改动')

  const openCreate = () => {
    if (createDisabled || !visible || !repoPath) return
    setMenuOpen(false)
    createSequenceRef.current += 1
    setCreateSession(createStashCreateSession({
      openId: createSequenceRef.current,
      repoPath,
      repoName,
      files,
      onChanged,
    }))
    setCreatePresent(true)
  }

  const openManager = (intent = {}) => {
    if (!repoPath) return
    setMenuOpen(false)
    dispatchStashManagerOpen({
      repoId: data?.repoId,
      repoPath,
      repoName,
      initialStashId: intent.stashId,
      initialOperation: intent.operation,
      overlayParentId: OVERLAY_ID.workingChanges,
      onChanged,
    })
  }

  const createDialog = createSession ? (
    <CreateStashDialog
      key={createSession.openId}
      repoPath={createSession.repoPath}
      repoName={createSession.repoName}
      files={createSession.files}
      present={createPresent}
      onClose={() => setCreatePresent(false)}
      onExitComplete={() => setCreateSession(null)}
      onChanged={createSession.onChanged}
    />
  ) : null

  if (entryMode.manageOnly) {
    return (
      <div className="working-changes-stash-split" hidden={!visible}>
        <button
          type="button"
          className="working-changes-action working-changes-action--stash working-changes-stash-manage"
          disabled={disabled || !repoPath}
          onClick={() => openManager()}
          data-app-tooltip="当前工作区干净，打开已有 Stash 管理"
          aria-label="管理 Stash"
        >
          <span className="working-changes-stash-split__icon"><StashIcon className="icon icon--sm" /></span>
          <span>管理 Stash</span>
        </button>
        {createDialog}
      </div>
    )
  }

  return (
    <div className="working-changes-stash-split" hidden={!visible}>
      <button
        type="button"
        className="working-changes-action working-changes-action--stash working-changes-stash-split__main"
        disabled={createDisabled}
        onClick={openCreate}
        data-app-tooltip={createTitle}
        aria-label={selectedStashScopeLabel(files)}
      >
        <span className="working-changes-stash-split__icon"><StashIcon className="icon icon--sm" /></span>
        <span>{selectedStashScopeLabel(files)}</span>
      </button>
      <button
        ref={menuButtonRef}
        type="button"
        className="working-changes-stash-split__menu"
        disabled={disabled || !repoPath}
        aria-label="打开 Stash 管理菜单"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <DirectionalChevronIcon direction="down" />
      </button>

      {menuOpen ? (
        <StashManagementPopover
          repoPath={repoPath}
          anchorRef={menuButtonRef}
          onClose={() => setMenuOpen(false)}
          onOpenManager={openManager}
        />
      ) : null}

      {createDialog}
    </div>
  )
}
