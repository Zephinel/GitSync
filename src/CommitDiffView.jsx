import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import CanonicalCheckbox from './CanonicalCheckbox.jsx'
import CommitDiffFileCard from './CommitDiffFileCard.jsx'
import { CodeBrandIcon, CommitDiffLoadingCard } from './CommitDiffLoadingCard.jsx'
import ImageDiffPreview from './ImageDiffPreview.jsx'
import { isImageDiffCandidate } from './imageDiffUtils.js'
import { FILE_GLYPH_ICONS, FILE_GLYPH_KIND, resolveFileGlyphKind } from './fileGlyphIcons.js'
import { buildBinaryFileDiff, parsePatchRows, parseSplitPatchRows } from './commitDiffUtils'
import {
  BranchIcon,
  ClockIcon as CanonicalClockIcon,
  CloseIcon as CanonicalCloseIcon,
  CollapseIcon as CanonicalCollapseIcon,
  CopyIcon as CanonicalCopyIcon,
  ExpandIcon as CanonicalExpandIcon,
  ListLayoutIcon as CanonicalListLayoutIcon,
  SplitViewIcon as CanonicalSplitViewIcon,
  UserIcon as CanonicalUserIcon,
} from './icons/CanonicalIcons.jsx'
import {
  COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH,
  COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH,
  clampFocusSidebarWidth,
  formatCommitDisplayDate,
  isCommitDiffSplitViewportNarrow,
} from './commitDiffViewUtils'
import { normalizeCommitDiffViewStyle, readCommitDiffViewStyle } from './commitDiffSettings'

function getInitialViewStyle(data) {
  return normalizeCommitDiffViewStyle(data?.commitDiffViewStyle || data?.diffViewStyle || readCommitDiffViewStyle())
}

function getRepoDisplayName(data) {
  const explicitName = String(data?.repoName || '').trim()
  if (explicitName) return explicitName
  const repoPath = String(data?.repoPath || '').trim().replace(/\\/g, '/')
  const parts = repoPath.split('/').filter(Boolean)
  return parts[parts.length - 1] || 'Repository'
}

function getErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return error.message
  try { return JSON.stringify(error) } catch { return '未知错误' }
}

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getFileId(file, index) {
  return file?.id || `${file?.status || 'unknown'}:${file?.old_path || ''}:${file?.path || index}`
}

function MetaIcon({ type }) {
  if (type === 'user') return <CanonicalUserIcon className="commit-diff-meta-icon" />
  if (type === 'branch') return <BranchIcon className="commit-diff-meta-icon" />
  return <CanonicalClockIcon className="commit-diff-meta-icon" />
}

function ViewModeIcon({ type }) {
  if (type === 'split') return <CanonicalSplitViewIcon className="icon icon--sm" />
  return <CanonicalListLayoutIcon className="icon icon--sm" />
}

function getFileStatusLabel(status) {
  switch (status) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'typechange': return 'T'
    case 'modified': return 'M'
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
    default: return '未知'
  }
}

function splitPath(path) {
  const normalized = String(path || '').replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  const fileName = parts.pop() || normalized || '-'
  const directory = parts.length > 0 ? `${parts.join('/')}/` : ''
  return { directory, fileName }
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

function renderInlineTokens(tokens, fallbackText) {
  if (!Array.isArray(tokens)) return fallbackText || ' '
  if (tokens.length === 0) return ' '
  return tokens.map((token, index) => (
    <span key={`${index}-${token.text}`} className={token.type === 'same' ? undefined : `commit-diff-token commit-diff-token--${token.type}`}>
      {token.text}
    </span>
  ))
}

function FileDiffLoadingState() {
  return (
    <div className="commit-diff-viewer-state" role="status" aria-live="polite">
      <div className="commit-diff-viewer-state__spinner" />
      <strong>正在读取文件 Diff...</strong>
      <span>只加载当前选中文件，避免一次性渲染整个 commit。</span>
    </div>
  )
}

function FileDiffErrorState({ error, onRetry }) {
  return (
    <div className="commit-diff-viewer-state commit-diff-viewer-state--error" role="alert">
      <strong>文件 Diff 读取失败</strong>
      <span>{error}</span>
      <button type="button" onClick={onRetry}>重试</button>
    </div>
  )
}

function EmptyPatchState({ fileDiff }) {
  return (
    <div className="commit-diff-viewer-state">
      <strong>没有可渲染的文本 hunk</strong>
      <span>该文件可能只有重命名、权限或类型变化。状态：{getFileStatusText(fileDiff?.status)}。</span>
    </div>
  )
}

function LargeDiffNotice({ fileDiff, canRender, onRenderAnyway }) {
  return (
    <div className="commit-diff-large-notice" role="status">
      <div>
        <strong>{canRender ? '这是一个较大的 Diff' : 'Diff 过大，已阻止渲染'}</strong>
        <span>{canRender ? '后端已标记该 patch 较大。为避免 UI 卡顿，需要手动确认后再渲染。' : '该 patch 超过后端最大返回限制，当前只显示文件 metadata。'}</span>
      </div>
      {canRender ? <button type="button" onClick={onRenderAnyway}>仍然渲染</button> : null}
      <div className="commit-diff-large-notice__stats"><span>+{toNumber(fileDiff?.additions)}</span><span>-{toNumber(fileDiff?.deletions)}</span></div>
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

function FileDiffRenderer({ file, fileDiff, repoPath, commitHash, lineWrap, viewMode, allowLargeRender, onAllowLargeRender }) {
  if (!fileDiff) return <FileDiffLoadingState />
  if (isImageDiffCandidate(file)) {
    return <ImageDiffPreview mode="commit" repoPath={repoPath} commitHash={commitHash} file={file} />
  }
  const patch = String(fileDiff.patch || '')
  const canRenderLargePatch = fileDiff.is_too_large && patch.length > 0
  if (fileDiff.is_too_large && !allowLargeRender) return <LargeDiffNotice fileDiff={fileDiff} canRender={canRenderLargePatch} onRenderAnyway={onAllowLargeRender} />
  return viewMode === 'split'
    ? <SplitPatchRenderer fileDiff={fileDiff} lineWrap={lineWrap} />
    : <RawPatchRenderer fileDiff={fileDiff} lineWrap={lineWrap} />
}

export default function CommitDiffView({ data, onClose }) {
  const [summaryState, setSummaryState] = useState({ loading: true, error: '', summary: null })
  const [selectedFileId, setSelectedFileId] = useState('')
  const [filterText, setFilterText] = useState('')
  const [fileDiffStates, setFileDiffStates] = useState({})
  const fileDiffStatesRef = useRef(fileDiffStates)
  const mountedRef = useRef(false)
  const [largeDiffRenderConsent, setLargeDiffRenderConsent] = useState({})
  const [viewMode, setViewMode] = useState(() => getInitialViewStyle(data))
  const [isSplitViewportNarrow, setIsSplitViewportNarrow] = useState(
    () => typeof window !== 'undefined' && isCommitDiffSplitViewportNarrow(window.innerWidth)
  )
  const [lineWrap, setLineWrap] = useState(true)
  const [copyState, setCopyState] = useState('idle')
  const [initialReady, setInitialReady] = useState(false)
  const [isDiffFocusMode, setIsDiffFocusMode] = useState(false)
  const [focusSidebarWidth, setFocusSidebarWidth] = useState(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH)
  const [isFocusSidebarDragging, setIsFocusSidebarDragging] = useState(false)
  const focusSidebarDragRef = useRef(null)
  const diffScope = `${data?.repoPath || ''}:${data?.commit?.hash || ''}`
  const diffScopeRef = useRef(diffScope)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const updateViewport = () => setIsSplitViewportNarrow(isCommitDiffSplitViewportNarrow(window.innerWidth))
    updateViewport()
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  useEffect(() => {
    let disposed = false
    const repoPath = data?.repoPath || ''
    const commitHash = data?.commit?.hash || ''
    setSummaryState({ loading: true, error: '', summary: null })
    setSelectedFileId('')
    setFilterText('')
    setFileDiffStates({})
    setLargeDiffRenderConsent({})
    setViewMode(getInitialViewStyle(data))
    setCopyState('idle')
    setInitialReady(false)
    setIsDiffFocusMode(false)
    setFocusSidebarWidth(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH)
    setIsFocusSidebarDragging(false)
    focusSidebarDragRef.current = null

    async function loadSummary() {
      try {
        const summary = await invoke('get_repo_commit_diff_summary', { repoPath, commitHash })
        if (disposed) return
        const files = Array.isArray(summary?.files) ? summary.files : []
        const preferred = files.find((file) => !isImageDiffCandidate(file)) || files[0] || null
        setSummaryState({ loading: false, error: '', summary })
        setSelectedFileId(preferred ? getFileId(preferred, 0) : '')
      } catch (error) {
        if (disposed) return
        setSummaryState({ loading: false, error: getErrorMessage(error), summary: null })
      }
    }

    if (!repoPath || !commitHash) setSummaryState({ loading: false, error: '缺少仓库路径或提交 hash。', summary: null })
    else void loadSummary()
    return () => { disposed = true }
  }, [data])

  useEffect(() => {
    fileDiffStatesRef.current = fileDiffStates
  }, [fileDiffStates])

  useEffect(() => {
    diffScopeRef.current = diffScope
  }, [diffScope])

  useEffect(() => {
    const handleKeyDown = (event) => { if (event.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

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

  const files = useMemo(() => {
    const list = Array.isArray(summaryState.summary?.files) ? summaryState.summary.files : []
    return list.map((file, index) => ({ ...file, id: getFileId(file, index) }))
  }, [summaryState.summary])

  const filteredFiles = useMemo(() => {
    const keyword = filterText.trim().toLowerCase()
    if (!keyword) return files
    return files.filter((file) => [file.path, file.old_path, file.status].filter(Boolean).join(' ').toLowerCase().includes(keyword))
  }, [files, filterText])

  const selectedFile = files.find((file) => file.id === selectedFileId) || files[0] || null
  const selectedFileDiffState = selectedFile ? fileDiffStates[selectedFile.id] : null
  const summary = summaryState.summary
  const filesChanged = toNumber(summary?.files_changed ?? files.length)
  const insertions = toNumber(summary?.insertions)
  const deletions = toNumber(summary?.deletions)
  const commit = data?.commit || {}
  const repoDisplayName = getRepoDisplayName(data)
  const displayHash = commit.hash || summary?.hash || '-'
  const fullHash = summary?.full_hash || commit.hash || ''
  const branchName = String(data?.branchName || '').trim()
  const displayAuthor = String(commit.author || '').trim() || '未知作者'
  const displayDate = formatCommitDisplayDate(commit.date)
  const effectiveViewMode = isSplitViewportNarrow ? 'unified' : viewMode

  const initialDataReady = useMemo(() => {
    if (summaryState.loading) return false
    if (summaryState.error) return true
    if (!summaryState.summary) return false
    if (files.length === 0) return true
    if (!selectedFile) return false
    const state = selectedFileDiffState
    return Boolean(state && !state.loading && (state.diff || state.error))
  }, [files.length, selectedFile, selectedFileDiffState, summaryState])

  useEffect(() => { if (initialDataReady) setInitialReady(true) }, [initialDataReady])

  const copyHash = async () => {
    if (!fullHash) return
    try {
      if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(fullHash)
      else await invoke('write_clipboard', { text: fullHash })
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 1200)
    } catch {
      setCopyState('failed')
      setTimeout(() => setCopyState('idle'), 1400)
    }
  }

  const loadFileDiff = useCallback(async (file, { force = false } = {}) => {
    if (!file?.id || !data?.repoPath || !data?.commit?.hash) return
    const requestScope = diffScope
    const canApplyResult = () => mountedRef.current && diffScopeRef.current === requestScope
    if (!force) {
      const existing = fileDiffStatesRef.current[file.id]
      if (existing?.loading || existing?.diff || existing?.error) return
    }
    if (isImageDiffCandidate(file)) {
      setFileDiffStates((prev) => ({
        ...prev,
        [file.id]: { loading: false, error: '', diff: buildBinaryFileDiff(file, { commitHash: data.commit.hash, fullHash }) },
      }))
      return
    }
    setFileDiffStates((prev) => ({ ...prev, [file.id]: { loading: true, error: '', diff: force ? null : prev[file.id]?.diff || null } }))
    try {
      const diff = await invoke('get_repo_commit_file_diff', { repoPath: data.repoPath, commitHash: data.commit.hash, path: file.path, oldPath: file.old_path || null })
      if (!canApplyResult()) return
      setFileDiffStates((prev) => ({ ...prev, [file.id]: { loading: false, error: '', diff } }))
    } catch (error) {
      if (!canApplyResult()) return
      setFileDiffStates((prev) => ({ ...prev, [file.id]: { loading: false, error: getErrorMessage(error), diff: null } }))
    }
  }, [data?.commit?.hash, data?.repoPath, diffScope, fullHash])

  useEffect(() => {
    if (!selectedFile) return
    const current = selectedFileDiffState
    if (current?.loading || current?.diff || current?.error) return
    void loadFileDiff(selectedFile)
  }, [loadFileDiff, selectedFile, selectedFileDiffState])

  const retrySelectedFileDiff = () => { if (selectedFile) void loadFileDiff(selectedFile, { force: true }) }
  const allowLargeSelectedFileRender = () => {
    if (!selectedFile) return
    setLargeDiffRenderConsent((prev) => ({ ...prev, [selectedFile.id]: true }))
  }
  const toggleDiffFocusMode = () => {
    setFocusSidebarWidth(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH)
    setIsFocusSidebarDragging(false)
    focusSidebarDragRef.current = null
    setIsDiffFocusMode((prev) => !prev)
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
      setFocusSidebarWidth((prev) => clampFocusSidebarWidth(prev - 32))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setFocusSidebarWidth((prev) => clampFocusSidebarWidth(prev + 32))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setFocusSidebarWidth(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setFocusSidebarWidth(COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH)
    }
  }

  const sheetClassName = [
    'commit-diff-sheet commit-diff-sheet--designed',
    isDiffFocusMode ? 'commit-diff-sheet--focus' : '',
  ].filter(Boolean).join(' ')
  const isFocusSidebarVisible = isDiffFocusMode && focusSidebarWidth > COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH
  const bodyClassName = [
    'commit-diff-body commit-diff-body--designed',
    isDiffFocusMode ? 'commit-diff-body--focus' : '',
    isFocusSidebarVisible ? 'commit-diff-body--focus-sidebar-visible' : '',
    isFocusSidebarDragging ? 'commit-diff-body--focus-sidebar-dragging' : '',
  ].filter(Boolean).join(' ')
  const focusSidebarStyle = isDiffFocusMode ? {
    '--commit-diff-focus-sidebar-width': `${focusSidebarWidth}px`,
    '--commit-diff-focus-sidebar-max-width': `${COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH}px`,
  } : undefined
  const selectedFileStatus = selectedFile ? (
    <span className={`commit-diff-file-header__status commit-diff-file-header__status--${selectedFile.status || 'unknown'}`} data-app-tooltip={`文件状态：${getFileStatusText(selectedFile.status)}`} aria-label={`文件状态：${getFileStatusText(selectedFile.status)}`}>{getFileStatusText(selectedFile.status)}</span>
  ) : null
  const diffViewControls = selectedFile && !isImageDiffCandidate(selectedFile) ? (
    <>
      <div className="layout-switcher commit-diff-view-switcher" role="group" aria-label="Diff 视图切换">
        <button className={`layout-switcher__btn ${effectiveViewMode === 'unified' ? 'layout-switcher__btn--active' : ''}`} type="button" onClick={() => setViewMode('unified')} aria-pressed={effectiveViewMode === 'unified'} data-app-tooltip="统一视图" aria-label="统一视图">
          <ViewModeIcon type="unified" />
        </button>
        <button className={`layout-switcher__btn ${effectiveViewMode === 'split' ? 'layout-switcher__btn--active' : ''}`} type="button" onClick={() => setViewMode('split')} disabled={isSplitViewportNarrow} aria-pressed={effectiveViewMode === 'split'} data-app-tooltip={isSplitViewportNarrow ? '窗口宽度不足，自动使用统一视图' : '分栏视图'} aria-label="分栏视图">
          <ViewModeIcon type="split" />
        </button>
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

  if (typeof document === 'undefined') return null
  if (!initialReady) return createPortal(<CommitDiffLoadingCard data={data} onClose={onClose} />, document.body)

  return createPortal((
    <>
      <button className="commit-diff-backdrop" type="button" onClick={onClose} aria-label="关闭提交 Diff" />
      <section className="commit-diff-stage" aria-label="提交 Diff 视图">
        <div className={sheetClassName}>
          <header className="commit-diff-header commit-diff-header--designed">
            <div className="commit-diff-header__identity">
              <div className="commit-diff-brand-mark" aria-hidden="true"><CodeBrandIcon /></div>
              <div className="commit-diff-header__main">
                <div className="commit-diff-header__title-row">
                  <span className="commit-diff-header__app-name" data-app-tooltip={repoDisplayName}>{repoDisplayName}</span>
                  <span className="commit-diff-header__hash">{displayHash}</span>
                  <h2 className="commit-diff-header__title" data-app-tooltip={commit.message || '暂无提交信息'}>{commit.message || '暂无提交信息'}</h2>
                </div>
              </div>
              <div className="commit-diff-header__meta commit-diff-header__meta--designed">
                <span className="commit-diff-meta-item commit-diff-meta-item--author" data-app-tooltip={displayAuthor}><MetaIcon type="user" /><span className="commit-diff-meta-item__text">{displayAuthor}</span></span>
                {displayDate ? <span className="commit-diff-meta-item commit-diff-meta-item--time" data-app-tooltip={displayDate}><MetaIcon type="clock" /><span className="commit-diff-meta-item__text">{displayDate}</span></span> : null}
                {branchName ? <span className="commit-diff-meta-item commit-diff-meta-item--branch" data-app-tooltip={branchName}><MetaIcon type="branch" /><span className="commit-diff-meta-item__text">{branchName}</span></span> : null}
                <span className="commit-diff-meta-item commit-diff-meta-item--files">{filesChanged} 个文件已更改</span>
                <span className="commit-diff-header__delta commit-diff-header__delta--add">+{insertions}</span>
                <span className="commit-diff-header__delta commit-diff-header__delta--del">-{deletions}</span>
                {isDiffFocusMode && selectedFile ? (
                  <div className="commit-diff-header-controls" aria-label="Diff 视图控制">
                    {selectedFileStatus}
                    <div className="commit-diff-file-header__actions">
                      {diffViewControls}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="commit-diff-header__actions">
              <button
                className="github-repo-browser__close commit-diff-header__icon-btn commit-diff-header__focus"
                type="button"
                onClick={toggleDiffFocusMode}
                data-app-tooltip={isDiffFocusMode ? '收起 Diff 视图' : '展开 Diff 视图'}
                aria-label={isDiffFocusMode ? '收起 Diff 视图' : '展开 Diff 视图'}
                aria-pressed={isDiffFocusMode}
              >
                {isDiffFocusMode ? <CanonicalCollapseIcon className="icon icon--xs" /> : <CanonicalExpandIcon className="icon icon--xs" />}
              </button>
              <button
                className="github-repo-browser__close commit-diff-header__icon-btn commit-diff-header__copy"
                type="button"
                onClick={copyHash}
                disabled={!fullHash}
                data-app-tooltip={copyState === 'copied' ? '已复制 hash' : '复制 hash'}
                aria-label={copyState === 'copied' ? '已复制 hash' : '复制 hash'}
              >
                <CanonicalCopyIcon className="icon icon--xs" />
              </button>
              <button className="github-repo-browser__close commit-diff-header__icon-btn commit-diff-header__close" type="button" onClick={onClose} aria-label="关闭提交 Diff">
                <CanonicalCloseIcon className="icon icon--xs" />
              </button>
            </div>
          </header>

          <div className={bodyClassName} style={focusSidebarStyle}>
            <aside className="commit-diff-sidebar" aria-label="文件改动列表">
              <input className="commit-diff-sidebar__search" type="text" placeholder="搜索文件" value={filterText} onChange={(event) => setFilterText(event.target.value)} aria-label="搜索改动文件" />
              <div className="commit-diff-file-list">
                {summaryState.error ? <div className="commit-diff-state commit-diff-state--error"><strong>Summary 读取失败</strong><span>{summaryState.error}</span></div> : null}
                {!summaryState.error && files.length === 0 ? <div className="commit-diff-state"><strong>没有文件改动</strong><span>这个 commit 没有可显示的文件变更。</span></div> : null}
                {!summaryState.error && filteredFiles.map((file) => {
                  const isSelected = selectedFile?.id === file.id
                  const pathParts = splitPath(file.path)
                  const isImage = isImageDiffCandidate(file)
                  return (
                    <CommitDiffFileCard
                      key={file.id}
                      selected={isSelected}
                      onClick={() => setSelectedFileId(file.id)}
                      cardProps={{ 'data-file-path': file.path }}
                    >
                      <FileGlyph path={file.path} status={file.status} />
                      <span className="commit-diff-file-item__main">
                        <span className="commit-diff-file-item__path" data-app-tooltip={file.path}>{pathParts.fileName}</span>
                        <span className="commit-diff-file-item__location" data-app-tooltip={file.path}>{file.path}</span>
                      </span>
                      <span className="commit-diff-file-item__side">
                        <span className={`commit-diff-file-item__badge commit-diff-file-item__badge--${file.status || 'unknown'}`}>{getFileStatusLabel(file.status)}</span>
                        <span className="commit-diff-file-item__stats">{isImage ? <span className="commit-diff-file-item__binary">Image</span> : null}<span className="commit-diff-file-item__add">+{toNumber(file.additions)}</span><span className="commit-diff-file-item__del">-{toNumber(file.deletions)}</span></span>
                      </span>
                    </CommitDiffFileCard>
                  )
                })}
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

            <main className="commit-diff-content" aria-label="选中文件 Diff 预览">
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
                  {selectedFileDiffState?.loading ? <FileDiffLoadingState /> : null}
                  {!selectedFileDiffState?.loading && selectedFileDiffState?.error ? <FileDiffErrorState error={selectedFileDiffState.error} onRetry={retrySelectedFileDiff} /> : null}
                  {!selectedFileDiffState?.loading && !selectedFileDiffState?.error ? <FileDiffRenderer file={selectedFile} fileDiff={selectedFileDiffState?.diff} repoPath={data?.repoPath || ''} commitHash={data?.commit?.hash || ''} lineWrap={lineWrap} viewMode={effectiveViewMode} allowLargeRender={Boolean(largeDiffRenderConsent[selectedFile.id])} onAllowLargeRender={allowLargeSelectedFileRender} /> : null}
                </>
              ) : <div className="commit-diff-placeholder commit-diff-placeholder--empty"><h3>选择一个文件</h3><p>左侧文件列表加载完成后，选择文件即可在这里查看 Diff。</p></div>}
            </main>
          </div>
        </div>
      </section>
    </>
  ), document.body)
}
