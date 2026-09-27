import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CodeBrandIcon } from './CommitDiffLoadingCard.jsx'
import ImageDiffPreview from './ImageDiffPreview.jsx'
import CanonicalCheckbox from './CanonicalCheckbox.jsx'
import WorkingChangesFileCell from './WorkingChangesFileCell.jsx'
import WorkingChangesFileGroups from './WorkingChangesFileGroups.jsx'
import WorkingChangesFileMinusMenu from './WorkingChangesFileMinusMenu.jsx'
import WorkingChangesStashEntry from './WorkingChangesStashEntry.jsx'
import OverlayPortal from './OverlayPortal.jsx'
import { OVERLAY_ID, OVERLAY_LEVEL } from './overlayLayerContract.js'
import { parsePatchRows, parseSplitPatchRows } from './commitDiffUtils'
import { isImageDiffCandidate } from './imageDiffUtils.js'
import { splitGitRepoPath } from './gitPathIdentity.js'
import { FILE_GLYPH_ICONS, FILE_GLYPH_KIND, resolveFileGlyphKind } from './fileGlyphIcons.js'
import {
  CloseIcon as CanonicalCloseIcon,
  CollapseIcon as CanonicalCollapseIcon,
  CommitIcon as CanonicalCommitIcon,
  DeleteIcon as CanonicalDeleteIcon,
  ExpandIcon as CanonicalExpandIcon,
  ListLayoutIcon as CanonicalListLayoutIcon,
  MinusIcon as CanonicalMinusIcon,
  PlusIcon as CanonicalPlusIcon,
  RefreshSyncIcon as CanonicalRefreshSyncIcon,
  SplitViewIcon as CanonicalSplitViewIcon,
} from './icons/CanonicalIcons.jsx'
import {
  COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH,
  COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH,
  clampFocusSidebarWidth,
  isCommitDiffSplitViewportNarrow,
} from './commitDiffViewUtils'
import { normalizeCommitDiffViewStyle, readCommitDiffViewStyle } from './commitDiffSettings'
import {
  buildStagingTargets,
  buildWorkingChangeTargets,
  buildWorkingChangesViewModel,
  describeStagingOperationResult,
  FILE_CELL_MINUS,
  getStagingStateDescription,
  getStagingStateLabel,
  hasExecutableStagingAuthority,
  resolveFileCellActions,
  selectStagingCandidates,
} from './stagingViewModel.js'
import {
  getVisibleWorkingChangeFiles,
  groupWorkingChangesFiles,
  toggleCollapsedWorkingChangeGroup,
} from './workingChangesGroups.js'
import './WorkingChangesView.css'
import './WorkingChangesPolish.css'
import './WorkingChangesStaging.css'
import './WorkingChangesGroups.css'
import './WorkingChangesPerformance.css'

const STAGING_OPERATION_TYPES = new Set(['stage', 'unstage'])

function getErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return error.message
  try { return JSON.stringify(error) } catch { return '未知错误' }
}

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getFileStatusLabel(status) {
  switch (status) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'typechange': return 'T'
    case 'modified': return 'M'
    case 'unmerged': return 'U'
    default: return '?'
  }
}

function getFileStatusText(status) {
  switch (status) {
    case 'added': return '新增'
    case 'deleted': return '已删除'
    case 'renamed': return '重命名'
    case 'copied': return '复制'
    case 'typechange': return '类型变更'
    case 'modified': return '已编辑'
    case 'unmerged': return '冲突'
    default: return '未知'
  }
}

function FileGlyph({ path, status = '' }) {
  const kind = resolveFileGlyphKind(path)
  const GlyphIcon = FILE_GLYPH_ICONS[kind]
  return (
    <span
      className={`commit-diff-file-glyph commit-diff-file-glyph--${status || 'unknown'}`}
      data-image-file-glyph={kind === FILE_GLYPH_KIND.image ? 'true' : undefined}
      data-app-tooltip={kind === FILE_GLYPH_KIND.image ? '图片文件' : undefined}
      aria-hidden="true"
    >
      <GlyphIcon className="image-file-glyph__icon" />
    </span>
  )
}

function StageIcon({ type }) {
  if (type !== 'unstage') return <CanonicalPlusIcon className="icon icon--sm" />
  return <CanonicalMinusIcon className="icon icon--sm" />
}

function ViewModeIcon({ type }) {
  if (type === 'split') return <CanonicalSplitViewIcon className="icon icon--sm" />
  return <CanonicalListLayoutIcon className="icon icon--sm" />
}

function renderInlineTokens(tokens, fallbackText) {
  if (!Array.isArray(tokens) || tokens.length === 0) return fallbackText || ' '
  return tokens.map((token, index) => (
    <span key={`${index}-${token.text}`} className={token.type === 'same' ? undefined : `commit-diff-token commit-diff-token--${token.type}`}>
      {token.text}
    </span>
  ))
}

function EmptyPatchState({ fileDiff }) {
  return (
    <div className="commit-diff-viewer-state">
      <strong>没有可渲染的文本 hunk</strong>
      <span>该文件可能只有重命名、权限或类型变化。状态：{getFileStatusText(fileDiff?.status)}。</span>
    </div>
  )
}

function RawPatchRenderer({ fileDiff, lineWrap }) {
  const rows = parsePatchRows(fileDiff?.patch || '')
  if (rows.length === 0) return <EmptyPatchState fileDiff={fileDiff} />
  return (
    <div className={`commit-diff-raw ${lineWrap ? 'commit-diff-raw--wrap' : ''}`}>
      {rows.map((row) => (
        <div className={`commit-diff-raw__line commit-diff-raw__line--${row.type}`} key={row.key}>
          <span className="commit-diff-raw__num commit-diff-raw__num--old">{row.oldNumber}</span>
          <span className="commit-diff-raw__num commit-diff-raw__num--new">{row.newNumber}</span>
          <code className="commit-diff-raw__code">{row.text || ' '}</code>
        </div>
      ))}
    </div>
  )
}

function SplitPatchRenderer({ fileDiff, lineWrap }) {
  const rows = parseSplitPatchRows(fileDiff?.patch || '')
  if (rows.length === 0) return <EmptyPatchState fileDiff={fileDiff} />
  return (
    <div className={`commit-diff-split ${lineWrap ? 'commit-diff-split--wrap' : ''}`}>
      {rows.map((row) => {
        if (row.type === 'hunk' || row.type === 'note') {
          return (
            <div className={`commit-diff-split__line commit-diff-split__line--${row.type}`} key={row.key}>
              <span className="commit-diff-split__num" />
              <code className="commit-diff-split__code" data-app-tooltip={row.oldText}>{row.oldText || ' '}</code>
            </div>
          )
        }
        return (
          <div className="commit-diff-split__row" key={row.key}>
            <span className={`commit-diff-split__num commit-diff-split__num--${row.oldType}`}>{row.oldNumber}</span>
            <code className={`commit-diff-split__code commit-diff-split__code--${row.oldType}`}>{renderInlineTokens(row.oldTokens, row.oldText)}</code>
            <span className={`commit-diff-split__num commit-diff-split__num--${row.newType}`}>{row.newNumber}</span>
            <code className={`commit-diff-split__code commit-diff-split__code--${row.newType}`}>{renderInlineTokens(row.newTokens, row.newText)}</code>
          </div>
        )
      })}
    </div>
  )
}

function FileDiffRenderer({ repoPath, file, state, lineWrap, viewMode, allowLarge, onAllowLarge }) {
  if (isImageDiffCandidate(file)) {
    return <ImageDiffPreview mode="working" repoPath={repoPath} file={file} />
  }
  if (!file?.diff_available) {
    return (
      <div className="commit-diff-viewer-state">
        <strong>暂时没有可用的 Diff 元数据</strong>
        <span>暂存状态已经读取，但 Diff 摘要尚未与当前仓库状态对齐，请刷新后重试。</span>
      </div>
    )
  }
  if (state?.loading) {
    return <div className="commit-diff-viewer-state"><div className="commit-diff-viewer-state__spinner" /><strong>正在读取文件 Diff...</strong></div>
  }
  if (state?.error) {
    return <div className="commit-diff-viewer-state commit-diff-viewer-state--error"><strong>文件 Diff 读取失败</strong><span>{state.error}</span></div>
  }
  const fileDiff = state?.diff
  if (!fileDiff) return null
  if (fileDiff.is_binary) {
    return <div className="commit-diff-viewer-state commit-diff-viewer-state--binary"><strong>Binary 文件</strong><span>{file?.path || '该文件'} 是二进制文件，当前不渲染文本 diff。</span></div>
  }
  if (fileDiff.is_too_large && !allowLarge) {
    const canRender = Boolean(fileDiff.patch)
    return (
      <div className="commit-diff-large-notice" role="status">
        <div><strong>{canRender ? '这是一个较大的 Diff' : 'Diff 过大，已阻止渲染'}</strong><span>{canRender ? '为避免界面卡顿，需要手动确认后再渲染。' : '该 patch 超过最大返回限制。'}</span></div>
        {canRender ? <button type="button" onClick={onAllowLarge}>仍然渲染</button> : null}
      </div>
    )
  }
  return viewMode === 'split'
    ? <SplitPatchRenderer fileDiff={fileDiff} lineWrap={lineWrap} />
    : <RawPatchRenderer fileDiff={fileDiff} lineWrap={lineWrap} />
}

const MemoizedFileDiffRenderer = memo(
  FileDiffRenderer,
  (previous, next) => (
    previous.repoPath === next.repoPath
    && previous.file === next.file
    && previous.state === next.state
    && previous.lineWrap === next.lineWrap
    && previous.viewMode === next.viewMode
    && previous.allowLarge === next.allowLarge
  )
)

function operationDefinition(type, count) {
  switch (type) {
    case 'stage':
      return {
        title: `暂存 ${count} 个文件`,
        label: '确认暂存',
        busyLabel: '暂存中...',
        description: '只会把确认范围内的当前未暂存改动加入暂存区；不会提交、丢弃或改写文件内容。',
        tone: 'stage',
      }
    case 'unstage':
      return {
        title: `取消暂存 ${count} 个文件`,
        label: '确认取消暂存',
        busyLabel: '取消暂存中...',
        description: '只会把确认范围内的已暂存内容移回工作区；不会丢弃修改或恢复旧文件内容。',
        tone: 'unstage',
      }
    case 'commit':
      return {
        title: `提交 ${count} 个文件`,
        label: '确认提交',
        busyLabel: '提交中...',
        description: '只提交确认范围内的当前文件 identity；执行前会重新验证 Working Changes 快照和 Git status identity，其他已暂存改动保持不变。',
        tone: 'commit',
      }
    case 'discard-unstaged':
      return {
        title: `丢弃 ${count} 个文件的未暂存改动`,
        label: '确认丢弃',
        busyLabel: '丢弃未暂存改动中...',
        description: '只会把确认范围内未暂存的工作区改动恢复为暂存区内容；已暂存内容保持不变，不会被改写。',
        tone: 'discard',
      }
    case 'discard-untracked':
      return {
        title: `删除 ${count} 个未跟踪文件`,
        label: '确认删除',
        busyLabel: '删除中...',
        description: '该操作会从磁盘删除这些未跟踪文件，不是恢复到 Git 版本，无法撤销。',
        tone: 'discard',
      }
    default:
      return {
        title: `丢弃 ${count} 个文件的改动`,
        label: '确认丢弃',
        busyLabel: '丢弃中...',
        description: '该操作不可撤销。执行前会重新验证 Working Changes 快照和 Git status identity，不会猜测同路径的歧义目标。',
        tone: 'discard',
      }
  }
}

function OperationDialog({
  type,
  files,
  busy,
  message,
  repoName,
  branchName,
  onMessageChange,
  onCancel,
  onConfirm,
}) {
  const count = files.length
  const definition = operationDefinition(type, count)
  const isCommit = type === 'commit'
  const isDiscard = type === 'discard' || type === 'discard-unstaged' || type === 'discard-untracked'
  const visiblePaths = files.slice(0, 6)
  const hiddenCount = Math.max(0, files.length - visiblePaths.length)

  return (
    <div data-overlay-motion="backdrop" className="working-changes-dialog-backdrop" role="presentation" onMouseDown={busy ? undefined : onCancel}>
      <section data-overlay-motion="surface" className={`working-changes-dialog working-changes-dialog--${definition.tone}`} role="dialog" aria-modal="true" aria-label={definition.title} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <span className={`working-changes-dialog__icon working-changes-dialog__icon--${definition.tone}`}>
            {isCommit ? <CanonicalCommitIcon className="icon icon--sm" /> : isDiscard ? <CanonicalDeleteIcon className="icon icon--sm" /> : <StageIcon type={type} />}
          </span>
          <div>
            <h3>{definition.title}</h3>
            <p>{definition.description}</p>
          </div>
        </header>

        <div className="working-changes-dialog__context">
          <span data-app-tooltip={repoName}>{repoName}</span>
          <span data-app-tooltip={branchName || '当前分支未知'}>{branchName || '当前分支未知'}</span>
        </div>

        <div className="working-changes-dialog__files" aria-label="本次操作文件范围">
          {visiblePaths.map((file) => <code key={file.id}>{file.path}</code>)}
          {hiddenCount > 0 ? <span>另有 {hiddenCount} 个文件</span> : null}
        </div>

        {isCommit ? (
          <textarea autoFocus value={message} disabled={busy} onChange={(event) => onMessageChange(event.target.value)} placeholder="输入提交信息" aria-label="提交信息" />
        ) : isDiscard ? (
          <div className="working-changes-dialog__warning">
            {type === 'discard-untracked'
              ? '确认永久删除所选未跟踪文件？该文件会从磁盘删除，无法恢复到 Git 版本。'
              : type === 'discard-unstaged'
                ? '确认永久丢弃所选文件的未暂存改动？已暂存内容保持不变。'
                : '确认永久丢弃所选文件的当前改动？'}
          </div>
        ) : (
          <div className="working-changes-dialog__staging-note">
            操作执行前会重新验证分支、HEAD、仓库快照和每个文件的 Index / Worktree 状态。
          </div>
        )}

        <footer>
          <button type="button" autoFocus={!isCommit} disabled={busy} onClick={onCancel}>取消</button>
          <button
            type="button"
            className={isDiscard ? 'working-changes-dialog__danger' : 'working-changes-dialog__primary'}
            disabled={busy || (isCommit && !message.trim())}
            onClick={onConfirm}
          >
            {busy ? definition.busyLabel : definition.label}
          </button>
        </footer>
      </section>
    </div>
  )
}

function StagingStateBadge({ file, compact = false }) {
  const state = file?.staging_state || 'clean'
  const label = getStagingStateLabel(state)
  return (
    <span
      className={`working-changes-staging-badge working-changes-staging-badge--${state} ${compact ? 'working-changes-staging-badge--compact' : ''}`}
      data-app-tooltip={getStagingStateDescription(file)}
      aria-label={`暂存状态：${label}`}
    >
      {label}
    </span>
  )
}

function Notice({ notice }) {
  if (!notice) return null
  const role = notice.tone === 'danger' ? 'alert' : 'status'
  return (
    <div className={`working-changes-notice working-changes-notice--${notice.tone}`} role={role}>
      <div className="working-changes-notice__message">{notice.message}</div>
      {Array.isArray(notice.details) && notice.details.length > 0 ? (
        <ul className="working-changes-notice__details">
          {notice.details.map((detail, index) => (
            <li key={`${detail.path}-${detail.status}-${index}`}>
              <code>{detail.path}</code>
              <span>{detail.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default function WorkingChangesView({ data, present = true, onClose, onExitComplete, onChanged }) {
  const [summaryState, setSummaryState] = useState({
    loading: true,
    error: '',
    workingSummary: null,
    stagingSnapshot: null,
    summary: null,
  })
  const [selectedFileId, setSelectedFileId] = useState('')
  const operationBusyRef = useRef(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [collapsedGroupIds, setCollapsedGroupIds] = useState(() => new Set())
  const [filterText, setFilterText] = useState('')
  const [fileDiffStates, setFileDiffStates] = useState({})
  const fileDiffStatesRef = useRef(fileDiffStates)
  const [viewMode, setViewMode] = useState(() => normalizeCommitDiffViewStyle(readCommitDiffViewStyle()))
  const [lineWrap, setLineWrap] = useState(true)
  const [isSplitViewportNarrow, setIsSplitViewportNarrow] = useState(
    () => typeof window !== 'undefined' && isCommitDiffSplitViewportNarrow(window.innerWidth)
  )
  const [largeDiffConsent, setLargeDiffConsent] = useState({})
  const [operationDialog, setOperationDialog] = useState(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [operationBusy, setOperationBusy] = useState(false)
  const [minusMenu, setMinusMenu] = useState(null)
  operationBusyRef.current = operationBusy
  const [notice, setNotice] = useState(null)
  const lastSummaryLoadAtRef = useRef(0)
  const loadSummarySequenceRef = useRef(0)
  const isClosing = !present
  const [isDiffFocusMode, setIsDiffFocusMode] = useState(false)
  const [focusSidebarWidth, setFocusSidebarWidth] = useState(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH)
  const [isFocusSidebarDragging, setIsFocusSidebarDragging] = useState(false)
  const focusSidebarDragRef = useRef(null)
  const requestClose = useCallback(() => {
    if (operationBusy || isClosing) return
    onClose?.()
  }, [isClosing, onClose, operationBusy])

  const loadSummary = useCallback(async ({ preserveSelection = false, silent = false } = {}) => {
    const sequence = ++loadSummarySequenceRef.current
    lastSummaryLoadAtRef.current = Date.now()
    if (!silent) setSummaryState((previous) => ({ ...previous, loading: true, error: '' }))
    try {
      const [workingSummary, stagingSnapshot] = await Promise.all([
        invoke('get_repo_working_diff_summary', { repoPath: data.repoPath }),
        invoke('get_repo_staging_snapshot', { repoPath: data.repoPath }),
      ])
      if (loadSummarySequenceRef.current !== sequence) return
      const summary = buildWorkingChangesViewModel(workingSummary, stagingSnapshot)
      const files = Array.isArray(summary.files) ? summary.files : []
      const preferred = files.find((file) => file.diff_available && !file.is_binary) || files[0] || null

      setSummaryState({
        loading: false,
        error: '',
        workingSummary,
        stagingSnapshot,
        summary,
      })
      setSelectedFileId((previous) => files.some((file) => file.id === previous) ? previous : (preferred?.id || ''))
      if (!preserveSelection) setSelectedIds(new Set())
      else setSelectedIds((previous) => new Set([...previous].filter((id) => files.some((file) => file.id === id))))
      setFileDiffStates({})
      setLargeDiffConsent({})
    } catch (error) {
      if (loadSummarySequenceRef.current !== sequence) return
      setSummaryState((previous) => ({
        ...previous,
        loading: false,
        error: getErrorMessage(error),
      }))
    }
  }, [data.repoPath])

  const installReturnedSnapshot = useCallback((stagingSnapshot) => {
    if (!stagingSnapshot) return
    setSummaryState((previous) => {
      if (!previous.workingSummary) return previous
      return {
        ...previous,
        stagingSnapshot,
        summary: buildWorkingChangesViewModel(previous.workingSummary, stagingSnapshot),
      }
    })
  }, [])

  useEffect(() => { void loadSummary() }, [loadSummary])
  useEffect(() => { fileDiffStatesRef.current = fileDiffStates }, [fileDiffStates])

  useEffect(() => {
    if (operationBusy) setMinusMenu(null)
  }, [operationBusy])

  useEffect(() => {
    if (!notice || notice.tone !== 'success') return undefined
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const reloadWhenVisible = () => {
      if (Date.now() - lastSummaryLoadAtRef.current < 1500) return
      void loadSummary({ preserveSelection: true, silent: true })
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reloadWhenVisible()
    }
    window.addEventListener('focus', reloadWhenVisible)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', reloadWhenVisible)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [loadSummary])

  useEffect(() => {
    const update = () => setIsSplitViewportNarrow(isCommitDiffSplitViewportNarrow(window.innerWidth))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      if (minusMenu) setMinusMenu(null)
      else if (operationDialog && !operationBusy) setOperationDialog(null)
      else requestClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [minusMenu, operationBusy, operationDialog, requestClose])

  useEffect(() => {
    if (!isFocusSidebarDragging) return undefined
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [isFocusSidebarDragging])

  const summary = summaryState.summary
  const files = useMemo(() => Array.isArray(summary?.files) ? summary.files : [], [summary])
  const searching = Boolean(filterText.trim())
  const groupedFiles = useMemo(
    () => groupWorkingChangesFiles(files, filterText),
    [files, filterText]
  )
  const visibleFiles = useMemo(
    () => getVisibleWorkingChangeFiles(groupedFiles, collapsedGroupIds, searching),
    [collapsedGroupIds, groupedFiles, searching]
  )
  const selectedFile = useMemo(
    () => visibleFiles.find((file) => file.id === selectedFileId) || visibleFiles[0] || null,
    [selectedFileId, visibleFiles]
  )
  const selectedFileDiffState = selectedFile ? fileDiffStates[selectedFile.id] : null
  const selectionProjection = useMemo(() => {
    const selectedFiles = visibleFiles.filter((file) => selectedIds.has(file.id))
    return {
      selectedFiles,
      allVisibleSelected: visibleFiles.length > 0 && visibleFiles.every((file) => selectedIds.has(file.id)),
      selectedHasConflict: selectedFiles.some((file) => file.is_conflicted || file.status === 'unmerged'),
      selectedStageCandidates: selectStagingCandidates(selectedFiles, 'stage'),
      selectedUnstageCandidates: selectStagingCandidates(selectedFiles, 'unstage'),
    }
  }, [selectedIds, visibleFiles])
  const {
    selectedFiles,
    allVisibleSelected,
    selectedHasConflict,
    selectedStageCandidates,
    selectedUnstageCandidates,
  } = selectionProjection
  const stagingAuthorityReady = !summaryState.loading
    && !summaryState.error
    && hasExecutableStagingAuthority(summary)
  const canDiscardAll = stagingAuthorityReady
    && files.length > 0
    && !summary?.files_truncated
  const effectiveViewMode = isSplitViewportNarrow ? 'unified' : viewMode

  useEffect(() => {
    if (!selectedFileId || visibleFiles.some((file) => file.id === selectedFileId)) return
    const preferred = visibleFiles.find((file) => file.diff_available && !file.is_binary) || visibleFiles[0] || null
    setSelectedFileId(preferred?.id || '')
  }, [selectedFileId, visibleFiles])

  const loadFileDiff = useCallback(async (file, { force = false } = {}) => {
    if (!file?.id || !file.diff_available || isImageDiffCandidate(file)) return
    if (!force) {
      const existing = fileDiffStatesRef.current[file.id]
      if (existing?.loading || existing?.diff || existing?.error) return
    }
    setFileDiffStates((previous) => ({
      ...previous,
      [file.id]: {
        loading: true,
        error: '',
        diff: force ? null : previous[file.id]?.diff || null,
      },
    }))
    try {
      const diff = await invoke('get_repo_working_file_diff', {
        repoPath: data.repoPath,
        path: file.path,
        oldPath: file.old_path || null,
      })
      setFileDiffStates((previous) => ({
        ...previous,
        [file.id]: { loading: false, error: '', diff },
      }))
    } catch (error) {
      setFileDiffStates((previous) => ({
        ...previous,
        [file.id]: { loading: false, error: getErrorMessage(error), diff: null },
      }))
    }
  }, [data.repoPath])

  useEffect(() => {
    if (!selectedFile || !selectedFile.diff_available || isImageDiffCandidate(selectedFile)) return
    const state = selectedFileDiffState
    if (state?.loading || state?.diff || state?.error) return
    void loadFileDiff(selectedFile)
  }, [loadFileDiff, selectedFile, selectedFileDiffState])

  const toggleSelected = useCallback((id, checked) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const toggleAllVisible = (checked) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      visibleFiles.forEach((file) => {
        if (checked) next.add(file.id)
        else next.delete(file.id)
      })
      return next
    })
  }

  const toggleGroup = useCallback((groupId) => {
    if (searching || operationBusy) return
    const group = groupedFiles.find((candidate) => candidate.id === groupId)
    if (!group) return

    const willCollapse = !collapsedGroupIds.has(groupId)
    const nextCollapsed = toggleCollapsedWorkingChangeGroup(collapsedGroupIds, groupId)
    setCollapsedGroupIds(nextCollapsed)

    if (!willCollapse) return
    const hiddenIds = new Set(group.files.map((file) => file.id))
    setSelectedIds((previous) => new Set([...previous].filter((id) => !hiddenIds.has(id))))

    if (hiddenIds.has(selectedFileId)) {
      const nextVisible = getVisibleWorkingChangeFiles(groupedFiles, nextCollapsed, false)
      const preferred = nextVisible.find((file) => file.diff_available && !file.is_binary) || nextVisible[0] || null
      setSelectedFileId(preferred?.id || '')
    }
  }, [collapsedGroupIds, groupedFiles, operationBusy, searching, selectedFileId])

  const handleFilePreview = useCallback((file) => {
    setSelectedFileId(file.id)
  }, [])

  const openOperation = useCallback((type, targetFiles) => {
    if (operationBusyRef.current || !Array.isArray(targetFiles) || targetFiles.length === 0) return
    const isStaging = STAGING_OPERATION_TYPES.has(type)
    const targets = isStaging ? buildStagingTargets(targetFiles, type) : buildWorkingChangeTargets(targetFiles)
    if (targets.length === 0) return
    setNotice(null)
    setOperationDialog({
      type,
      snapshotId: isStaging ? summary.snapshot_id : summary.working_snapshot_id,
      targets,
      displayFiles: targetFiles.map((file) => ({ id: file.id, path: file.path })),
    })
  }, [summary])

  const refreshAfterExistingOperation = async (result) => {
    setNotice({ tone: 'success', message: result?.message || '操作完成。', details: [] })
    setOperationDialog(null)
    setCommitMessage('')
    await loadSummary({ preserveSelection: false, silent: true })
    await onChanged?.(result)
  }

  const executeStagingOperation = async (type, dialog) => {
    const targets = dialog.targets
    if (!stagingAuthorityReady || targets.length === 0) {
      setNotice({
        tone: 'warning',
        message: '当前暂存区预览已经不可执行，请刷新后重新选择文件。',
        details: [],
      })
      setOperationDialog(null)
      return
    }

    const command = type === 'stage' ? 'stage_repo_files' : 'unstage_repo_files'
    const result = await invoke(command, {
      repoPath: data.repoPath,
      files: targets,
      expectedSnapshotId: dialog.snapshotId,
    })
    const described = describeStagingOperationResult(result)
    installReturnedSnapshot(described.snapshot)
    setNotice(described)
    setOperationDialog(null)
    setSelectedIds(new Set())

    await onChanged?.(result)
    await loadSummary({ preserveSelection: false, silent: true })
  }

  const confirmOperation = async () => {
    if (!operationDialog || operationBusy) return
    setOperationBusy(true)
    setNotice(null)
    try {
      if (STAGING_OPERATION_TYPES.has(operationDialog.type)) {
        await executeStagingOperation(operationDialog.type, operationDialog)
      } else {
        if (!stagingAuthorityReady) {
          setNotice({
            tone: 'warning',
            message: '当前 Working Changes authority 已经过期，请刷新后重新选择文件。',
            details: [],
          })
          setOperationDialog(null)
          return
        }
        const targets = operationDialog.targets
        if (targets.length === 0) {
          setOperationDialog(null)
          return
        }
        const isWorktreeDiscard = operationDialog.type === 'discard-unstaged' || operationDialog.type === 'discard-untracked'
        const result = operationDialog.type === 'commit'
          ? await invoke('commit_repo_working_files', {
            repoPath: data.repoPath,
            files: targets,
            expectedSnapshotId: operationDialog.snapshotId,
            message: commitMessage.trim(),
          })
          : isWorktreeDiscard
            ? await invoke('discard_repo_working_files_unstaged', {
              repoPath: data.repoPath,
              files: targets,
              expectedSnapshotId: operationDialog.snapshotId,
            })
            : await invoke('discard_repo_working_files', {
              repoPath: data.repoPath,
              files: targets,
              expectedSnapshotId: operationDialog.snapshotId,
            })
        await refreshAfterExistingOperation(result)
      }
    } catch (error) {
      setNotice({ tone: 'danger', message: getErrorMessage(error), details: [] })
    } finally {
      setOperationBusy(false)
    }
  }

  const toggleDiffFocusMode = () => {
    setFocusSidebarWidth(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH)
    setIsFocusSidebarDragging(false)
    focusSidebarDragRef.current = null
    setIsDiffFocusMode((previous) => !previous)
  }

  const beginFocusSidebarDrag = (event) => {
    if (!isDiffFocusMode) return
    event.preventDefault()
    focusSidebarDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: focusSidebarWidth,
    }
    setIsFocusSidebarDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveFocusSidebarDrag = (event) => {
    const dragState = focusSidebarDragRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    event.preventDefault()
    setFocusSidebarWidth(clampFocusSidebarWidth(dragState.startWidth + event.clientX - dragState.startX))
  }

  const endFocusSidebarDrag = (event) => {
    const dragState = focusSidebarDragRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    focusSidebarDragRef.current = null
    setIsFocusSidebarDragging(false)
  }

  const handleFocusSidebarKeyDown = (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setFocusSidebarWidth((previous) => clampFocusSidebarWidth(previous - 32))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setFocusSidebarWidth((previous) => clampFocusSidebarWidth(previous + 32))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setFocusSidebarWidth(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setFocusSidebarWidth(COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH)
    }
  }

  const insertions = toNumber(summary?.insertions)
  const deletions = toNumber(summary?.deletions)
  const repoName = String(data.repoName || '').trim() || String(data.repoPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Repository'
  const branchName = String(summary?.branch || data.branchName || '').trim()
  const isFocusSidebarVisible = isDiffFocusMode && focusSidebarWidth > COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH
  const sheetClassName = [
    'commit-diff-sheet commit-diff-sheet--designed working-changes-sheet',
    isDiffFocusMode ? 'commit-diff-sheet--focus' : '',
  ].filter(Boolean).join(' ')
  const bodyClassName = [
    'commit-diff-body commit-diff-body--designed working-changes-body',
    isDiffFocusMode ? 'commit-diff-body--focus' : '',
    isFocusSidebarVisible ? 'commit-diff-body--focus-sidebar-visible' : '',
    isFocusSidebarDragging ? 'commit-diff-body--focus-sidebar-dragging' : '',
  ].filter(Boolean).join(' ')
  const focusSidebarStyle = isDiffFocusMode ? {
    '--commit-diff-focus-sidebar-width': `${focusSidebarWidth}px`,
    '--commit-diff-focus-sidebar-max-width': `${COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH}px`,
  } : undefined
  const selectedFileStatus = selectedFile ? (
    <div className="working-changes-selected-status">
      <span
        className={`commit-diff-file-header__status commit-diff-file-header__status--${selectedFile.status || 'unknown'}`}
        data-app-tooltip={`文件状态：${getFileStatusText(selectedFile.status)}`}
        aria-label={`文件状态：${getFileStatusText(selectedFile.status)}`}
      >
        {getFileStatusText(selectedFile.status)}
      </span>
      <StagingStateBadge file={selectedFile} compact />
    </div>
  ) : null
  const selectedIsImage = isImageDiffCandidate(selectedFile)
  const diffViewControls = selectedFile && !selectedIsImage ? (
    <>
      <div className="layout-switcher commit-diff-view-switcher" role="group" aria-label="Diff 视图切换">
        <button className={`layout-switcher__btn ${effectiveViewMode === 'unified' ? 'layout-switcher__btn--active' : ''}`} type="button" onClick={() => setViewMode('unified')} aria-pressed={effectiveViewMode === 'unified'} data-app-tooltip="统一视图" aria-label="统一视图"><ViewModeIcon type="unified" /></button>
        <button className={`layout-switcher__btn ${effectiveViewMode === 'split' ? 'layout-switcher__btn--active' : ''}`} type="button" onClick={() => setViewMode('split')} disabled={isSplitViewportNarrow} aria-pressed={effectiveViewMode === 'split'} data-app-tooltip={isSplitViewportNarrow ? '窗口宽度不足，自动使用统一视图' : '分栏视图'} aria-label="分栏视图"><ViewModeIcon type="split" /></button>
      </div>
      <CanonicalCheckbox
        className={`commit-diff-wrap-toggle ${lineWrap ? 'commit-diff-wrap-toggle--active' : ''}`}
        checked={lineWrap}
        onChange={(checked) => setLineWrap(checked)}
        label="自动换行"
        title="自动换行"
      >
        <span>自动换行</span>
      </CanonicalCheckbox>
    </>
  ) : null

  const authorityWarning = !summaryState.loading && summary && !stagingAuthorityReady
    ? '仓库状态在读取过程中发生变化。Stage / Unstage 已暂停，Commit / Discard 同样不可执行，请刷新后重新确认。'
    : ''
  const truncatedWarning = !summaryState.loading && summary?.files_truncated
    ? `改动文件超过显示上限，当前展示 ${files.length} / ${summary.files_changed} 个文件；仅可操作当前可见文件。`
    : ''

  const renderFileRow = useCallback((file, group) => {
    const pathParts = splitGitRepoPath(file.path)
    const isPreviewSelected = selectedFile?.id === file.id
    const cellActions = resolveFileCellActions(file, { authorityReady: stagingAuthorityReady })
    const stageActions = cellActions.canStage || cellActions.minus ? (
      <>
        {cellActions.canStage ? (
          <button
            type="button"
            className="working-changes-file-stage-action working-changes-file-stage-action--stage"
            disabled={operationBusy}
            data-app-tooltip={`暂存 ${file.path}`}
            aria-label={`暂存 ${file.path}`}
            onClick={() => openOperation('stage', [file])}
          >
            <StageIcon type="stage" />
          </button>
        ) : null}
        {cellActions.minus ? (
          cellActions.minus.operation === FILE_CELL_MINUS.choose ? (
            <button
              type="button"
              className="working-changes-file-stage-action working-changes-file-stage-action--minus"
              disabled={operationBusy}
              data-app-tooltip={cellActions.minus.title}
              aria-label={cellActions.minus.ariaLabel}
              aria-haspopup="menu"
              aria-expanded={minusMenu?.fileId === file.id}
              onClick={(event) => setMinusMenu({ fileId: file.id, anchor: event.currentTarget })}
            >
              <StageIcon type="unstage" />
            </button>
          ) : (
            <button
              type="button"
              className={`working-changes-file-stage-action working-changes-file-stage-action--${cellActions.minus.tone}`}
              disabled={operationBusy}
              data-app-tooltip={cellActions.minus.title}
              aria-label={cellActions.minus.ariaLabel}
              onClick={() => openOperation(cellActions.minus.operation, [file])}
            >
              <StageIcon type="unstage" />
            </button>
          )
        ) : null}
      </>
    ) : null
    const metadata = file.is_binary || !file.diff_available ? (
      <>
        {file.is_binary ? <span className="working-changes-file-cell__meta">Binary</span> : null}
        {!file.diff_available ? <span className="working-changes-file-cell__meta">Diff 待读取</span> : null}
      </>
    ) : null

    return (
      <Fragment key={file.id}>
      <WorkingChangesFileCell
        selected={isPreviewSelected}
        onPreview={() => handleFilePreview(file)}
        previewLabel={`预览 ${file.path}，文件状态：${getFileStatusText(file.status)}，暂存状态：${getStagingStateLabel(file.staging_state)}，增加 ${toNumber(file.additions)} 行，删除 ${toNumber(file.deletions)} 行`}
        stagingState={file.staging_state}
        stagingStateContext={group ? 'group' : 'row'}
        stagingStateLabel={<StagingStateBadge file={file} compact />}
        checkbox={<CanonicalCheckbox className="working-changes-checkbox" checked={selectedIds.has(file.id)} disabled={operationBusy} label={`选择文件 ${file.path}`} inputProps={{ 'data-file-id': file.id }} onChange={(checked) => toggleSelected(file.id, checked)} />}
        glyph={<FileGlyph path={file.path} status={file.status} />}
        filePath={file.path}
        filename={pathParts.fileName}
        status={(
          <span
            className={`commit-diff-file-item__badge commit-diff-file-item__badge--${file.status || 'unknown'}`}
            data-app-tooltip={`文件状态：${getFileStatusText(file.status)}`}
            aria-label={`文件状态：${getFileStatusText(file.status)}`}
          >
            {getFileStatusLabel(file.status)}
          </span>
        )}
        metrics={(
          <span className="commit-diff-file-item__stats">
            <span className="commit-diff-file-item__add">+{toNumber(file.additions)}</span>
            <span className="commit-diff-file-item__del">-{toNumber(file.deletions)}</span>
          </span>
        )}
        metadata={metadata}
        actionsProps={{ 'aria-label': `${file.path} 文件操作` }}
        actions={stageActions}
      />
      {minusMenu?.fileId === file.id ? (
        <WorkingChangesFileMinusMenu
          file={file}
          anchor={minusMenu.anchor}
          busy={operationBusy}
          onClose={() => setMinusMenu(null)}
          onPick={(operation) => {
            setMinusMenu(null)
            openOperation(operation, [file])
          }}
        />
      ) : null}
      </Fragment>
    )
  }, [handleFilePreview, minusMenu, openOperation, operationBusy, selectedFile?.id, selectedIds, stagingAuthorityReady, toggleSelected])

  if (typeof document === 'undefined') return null

  return (
    <OverlayPortal
      level={OVERLAY_LEVEL.workspace}
      overlayId={OVERLAY_ID.workingChanges}
      present={present}
      onExitComplete={onExitComplete}
      onEscape={() => {
        if (minusMenu) setMinusMenu(null)
        else if (operationDialog && !operationBusy) setOperationDialog(null)
        else requestClose()
      }}
    >
      <>
      <button data-overlay-motion="backdrop" className="commit-diff-backdrop working-changes-backdrop" type="button" onClick={requestClose} aria-label="关闭未提交改动详情" />
      <section
        className="commit-diff-stage working-changes-stage"
        aria-label="未提交改动详情"
        aria-busy={summaryState.loading || operationBusy}
      >
        <div data-overlay-motion="surface" className={sheetClassName}>
          <header className="commit-diff-header commit-diff-header--designed">
            <div className="commit-diff-header__identity">
              <div className="commit-diff-brand-mark" aria-hidden="true"><CodeBrandIcon /></div>
              <div className="commit-diff-header__main">
                <div className="commit-diff-header__title-row">
                  <span className="commit-diff-header__app-name" data-app-tooltip={repoName}>{repoName}</span>
                  <span className="commit-diff-header__hash">WORKTREE</span>
                  <h2 className="commit-diff-header__title">未提交改动</h2>
                </div>
              </div>
              <div className="commit-diff-header__meta commit-diff-header__meta--designed">
                {branchName ? <span className="commit-diff-meta-item commit-diff-meta-item--branch" data-app-tooltip={branchName}>{branchName}</span> : null}
                <span className="commit-diff-meta-item commit-diff-meta-item--files">{toNumber(summary?.files_changed)} 个文件已更改</span>
                <span className="commit-diff-header__delta commit-diff-header__delta--add">+{insertions}</span>
                <span className="commit-diff-header__delta commit-diff-header__delta--del">-{deletions}</span>
                {isDiffFocusMode && selectedFile ? (
                  <div className="commit-diff-header-controls" aria-label="Diff 视图控制">
                    {selectedFileStatus}
                    <div className="commit-diff-file-header__actions">{diffViewControls}</div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="commit-diff-header__actions">
              <button
                className="github-repo-browser__close commit-diff-header__icon-btn commit-diff-header__focus"
                type="button"
                onClick={toggleDiffFocusMode}
                disabled={operationBusy || isClosing}
                data-app-tooltip={isDiffFocusMode ? '收起 Diff 视图' : '展开 Diff 视图'}
                aria-label={isDiffFocusMode ? '收起 Diff 视图' : '展开 Diff 视图'}
                aria-pressed={isDiffFocusMode}
              >
                {isDiffFocusMode ? <CanonicalCollapseIcon className="icon icon--xs" /> : <CanonicalExpandIcon className="icon icon--xs" />}
              </button>
              <button className="github-repo-browser__close commit-diff-header__icon-btn commit-diff-header__close" type="button" onClick={requestClose} disabled={operationBusy || isClosing} aria-label="关闭未提交改动详情"><CanonicalCloseIcon className="icon icon--xs" /></button>
            </div>
          </header>

          <div className="working-changes-staging-overview" aria-label="暂存区状态摘要">
            <div className="working-changes-staging-overview__counts">
              <span className="working-changes-staging-count working-changes-staging-count--staged">已暂存 <strong>{toNumber(summary?.staged_files)}</strong></span>
              <span className="working-changes-staging-count working-changes-staging-count--unstaged">未暂存 <strong>{toNumber(summary?.unstaged_files)}</strong></span>
              <span className="working-changes-staging-count working-changes-staging-count--mixed">部分暂存 <strong>{toNumber(summary?.mixed_files)}</strong></span>
              <span className="working-changes-staging-count working-changes-staging-count--untracked">未跟踪 <strong>{toNumber(summary?.untracked_files)}</strong></span>
              {toNumber(summary?.conflicted_files) > 0 ? <span className="working-changes-staging-count working-changes-staging-count--conflicted">冲突 <strong>{toNumber(summary?.conflicted_files)}</strong></span> : null}
            </div>
            <button type="button" className="working-changes-staging-refresh" disabled={summaryState.loading || operationBusy} onClick={() => loadSummary({ preserveSelection: true })}>
              <CanonicalRefreshSyncIcon className="working-changes-staging-refresh__icon" />
              {summaryState.loading ? '刷新中...' : '刷新状态'}
            </button>
          </div>

          <div className="working-changes-toolbar">
            <div className="working-changes-toolbar__selection">
              <CanonicalCheckbox className="working-changes-checkbox" checked={allVisibleSelected} disabled={visibleFiles.length === 0 || operationBusy} label={allVisibleSelected ? '取消选择当前可见文件' : '选择当前可见文件'} onChange={toggleAllVisible} />
              <span>已选择 <strong>{selectedFiles.length}</strong> / {visibleFiles.length} 个可见文件</span>
            </div>
            <div className="working-changes-toolbar__actions">
              <WorkingChangesStashEntry
                visible
                disabled={operationBusy || isClosing}
                data={data}
                selectedFiles={selectedFiles}
                onChanged={async () => {
                  await loadSummary({ preserveSelection: false })
                  await onChanged?.()
                }}
              />
              <button
                type="button"
                className="working-changes-action working-changes-action--unstage"
                disabled={!stagingAuthorityReady || selectedUnstageCandidates.length === 0 || operationBusy}
                onClick={() => openOperation('unstage', selectedUnstageCandidates)}
              >
                <StageIcon type="unstage" />取消暂存 {selectedUnstageCandidates.length || ''}
              </button>
              <button
                type="button"
                className="working-changes-action working-changes-action--stage"
                disabled={!stagingAuthorityReady || selectedStageCandidates.length === 0 || operationBusy}
                onClick={() => openOperation('stage', selectedStageCandidates)}
              >
                <StageIcon type="stage" />暂存选中 {selectedStageCandidates.length || ''}
              </button>
              <button type="button" className="working-changes-action working-changes-action--discard" disabled={!stagingAuthorityReady || selectedFiles.length === 0 || operationBusy} onClick={() => openOperation('discard', selectedFiles)}><CanonicalDeleteIcon className="icon icon--sm" />丢弃选中</button>
              <button
                type="button"
                className="working-changes-action working-changes-action--discard working-changes-action--discard-all"
                disabled={!canDiscardAll || operationBusy}
                data-app-tooltip={summary?.files_truncated ? '改动文件超过显示上限，无法安全丢弃全部' : `丢弃当前仓库全部 ${files.length} 个改动文件`}
                onClick={() => openOperation('discard', files)}
              >
                <CanonicalDeleteIcon className="icon icon--sm" />丢弃全部 {files.length || ''}
              </button>
              <button type="button" className="working-changes-action working-changes-action--commit" disabled={!stagingAuthorityReady || selectedFiles.length === 0 || selectedHasConflict || operationBusy} data-app-tooltip={selectedHasConflict ? '所选文件包含未解决冲突' : '提交选中文件'} onClick={() => openOperation('commit', selectedFiles)}><CanonicalCommitIcon className="icon icon--sm" />提交选中</button>
            </div>
          </div>

          {authorityWarning ? <div className="working-changes-authority-warning" role="alert"><span>{authorityWarning}</span><button type="button" onClick={() => loadSummary()}>重新读取</button></div> : null}
          {truncatedWarning ? <div className="working-changes-authority-warning working-changes-authority-warning--info" role="status">{truncatedWarning}</div> : null}
          <Notice notice={notice} />

          <div className={bodyClassName} style={focusSidebarStyle}>
            <aside className="commit-diff-sidebar" aria-label="未提交文件列表">
              <input className="commit-diff-sidebar__search" type="text" placeholder="搜索文件或暂存状态" value={filterText} onChange={(event) => setFilterText(event.target.value)} aria-label="搜索未提交文件" />
              <div className="commit-diff-file-list working-changes-file-list">
                {summaryState.loading ? <div className="commit-diff-state"><strong>正在读取未提交改动与暂存区状态...</strong></div> : null}
                {summaryState.error ? <div className="commit-diff-state commit-diff-state--error"><strong>改动读取失败</strong><span>{summaryState.error}</span><button type="button" onClick={() => loadSummary()}>重试</button></div> : null}
                {!summaryState.loading && !summaryState.error && files.length === 0 ? <div className="commit-diff-state"><strong>工作区干净</strong><span>当前没有未提交的文件改动。</span></div> : null}
                {!summaryState.loading && !summaryState.error && files.length > 0 && groupedFiles.length === 0 ? (
                  <div className="working-changes-group-empty">
                    <strong>没有匹配的文件</strong>
                    <span>调整搜索条件后再试。</span>
                  </div>
                ) : null}
                {!summaryState.error ? (
                  <WorkingChangesFileGroups
                    groups={groupedFiles}
                    collapsedGroupIds={collapsedGroupIds}
                    searching={searching}
                    onToggleGroup={toggleGroup}
                    renderFile={renderFileRow}
                  />
                ) : null}
              </div>
            </aside>

            {isDiffFocusMode ? (
              <div
                className={`commit-diff-sidebar-handle ${isFocusSidebarVisible ? 'commit-diff-sidebar-handle--visible' : ''} ${isFocusSidebarDragging ? 'commit-diff-sidebar-handle--dragging' : ''}`}
                role="separator"
                tabIndex={0}
                aria-label="拖动调整文件列表宽度"
                aria-orientation="vertical"
                aria-valuemin={COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH}
                aria-valuemax={COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH}
                aria-valuenow={focusSidebarWidth}
                data-app-tooltip="拖动调整文件列表宽度"
                onPointerDown={beginFocusSidebarDrag}
                onPointerMove={moveFocusSidebarDrag}
                onPointerUp={endFocusSidebarDrag}
                onPointerCancel={endFocusSidebarDrag}
                onKeyDown={handleFocusSidebarKeyDown}
              >
                <span className="commit-diff-sidebar-handle__bar" aria-hidden="true" />
              </div>
            ) : null}

            <main className="commit-diff-content" aria-label="选中文件未提交 Diff 预览">
              {selectedFile ? (
                <>
                  {!isDiffFocusMode ? (
                    <div className="commit-diff-file-header commit-diff-file-header--designed">
                      <div className="commit-diff-file-header__identity">
                        <FileGlyph path={selectedFile.path} status={selectedFile.status} />
                        <div className="commit-diff-file-header__main">
                          <div className="commit-diff-file-header__path" data-app-tooltip={selectedFile.path}>{selectedFile.path}</div>
                          {selectedFile.old_path && selectedFile.old_path !== selectedFile.path ? <div className="commit-diff-file-header__old" data-app-tooltip={selectedFile.old_path}>原路径：{selectedFile.old_path}</div> : null}
                        </div>
                      </div>
                      <div className="commit-diff-file-header__actions" aria-label="Diff 视图控制">
                        {selectedFileStatus}
                        {diffViewControls}
                      </div>
                    </div>
                  ) : null}
                  <MemoizedFileDiffRenderer repoPath={data.repoPath} file={selectedFile} state={selectedFileDiffState} lineWrap={lineWrap} viewMode={effectiveViewMode} allowLarge={Boolean(largeDiffConsent[selectedFile.id])} onAllowLarge={() => setLargeDiffConsent((previous) => ({ ...previous, [selectedFile.id]: true }))} />
                </>
              ) : <div className="commit-diff-placeholder commit-diff-placeholder--empty"><h3>选择一个文件</h3><p>从左侧展开分组并选择文件，即可查看当前工作区 Diff。</p></div>}
            </main>
          </div>
        </div>
      </section>

      </>
      <OverlayPortal
        level={OVERLAY_LEVEL.nested}
        overlayId={OVERLAY_ID.workingChangesOperation}
        parentOverlayId={OVERLAY_ID.workingChanges}
        present={Boolean(operationDialog)}
        onEscape={() => !operationBusy && setOperationDialog(null)}
      >
        {operationDialog ? (
          <OperationDialog
            type={operationDialog.type}
            files={operationDialog.displayFiles}
            busy={operationBusy}
            message={commitMessage}
            repoName={repoName}
            branchName={branchName}
            onMessageChange={setCommitMessage}
            onCancel={() => !operationBusy && setOperationDialog(null)}
            onConfirm={confirmOperation}
          />
        ) : null}
      </OverlayPortal>
    </OverlayPortal>
  )
}
