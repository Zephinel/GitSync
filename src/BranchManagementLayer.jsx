import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import BranchCreationDialog from './BranchCreationDialog.jsx'
import BranchManagementHoverGateway from './BranchManagementHoverGateway.jsx'
import CanonicalCheckbox from './CanonicalCheckbox.jsx'
import OverlayPortal from './OverlayPortal.jsx'
import { OVERLAY_ID, OVERLAY_LEVEL } from './overlayLayerContract.js'
import BranchSwitchIcon from './BranchSwitchIcon.jsx'
import {
  BatchSelectIcon as CanonicalBatchSelectIcon,
  BranchIcon,
  CollapseIcon as CanonicalCollapseIcon,
  CopyIcon as CanonicalCopyIcon,
  DeleteIcon as CanonicalDeleteIcon,
  DirectionDivergedIcon as CanonicalDirectionDivergedIcon,
  DirectionDownIcon as CanonicalDirectionDownIcon,
  DirectionRemoteIcon as CanonicalDirectionRemoteIcon,
  DirectionSyncedIcon as CanonicalDirectionSyncedIcon,
  DirectionUpIcon as CanonicalDirectionUpIcon,
  RefreshSyncIcon as CanonicalRefreshSyncIcon,
  SearchIcon as CanonicalSearchIcon,
} from './icons/CanonicalIcons.jsx'
import {
  buildBatchDeleteRequests,
  filterBranchManagementRows,
  getSelectableBranchIdentities,
  normalizeBranchManagementRows,
} from './branchManagementUtils.js'
import {
  getBranchCreationSource,
  getBranchSwitchAction,
  getPreferredBranchCreationRow,
} from './branchManagementActionModel.js'
import {
  BRANCH_MANAGEMENT_VIEW_MODE,
  getBranchManagementViewSummary,
  getBranchManagementVisibleRows,
} from './branchManagementViewUtils.js'
import { getBranchStatusDirection } from './branchManagementStatusArrowUtils.js'
import {
  BRANCH_FORCE_DELETE_DEFAULT_STORAGE_KEY,
  readBranchForceDeleteDefault,
  writeBranchForceDeleteDefault,
} from './branchForceDeleteSettings.js'
import { normalizeBranchManagementOpenContext } from './branchManagementHoverGateway.js'
import './BranchManagementLayer.css'
import './BranchManagementPolish.css'
import './BranchManagementActions.css'

const OVERLAY_BODY_CLASS = 'branch-management-overlay-active'

function getErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return error.message
  try { return JSON.stringify(error) } catch { return '未知错误' }
}

function SyncIcon({ small = false }) {
  return <CanonicalRefreshSyncIcon className={`icon ${small ? 'icon--xs' : 'icon--sm'}`} />
}

const DIRECTION_ICONS = Object.freeze({
  up: CanonicalDirectionUpIcon,
  down: CanonicalDirectionDownIcon,
  diverged: CanonicalDirectionDivergedIcon,
  synced: CanonicalDirectionSyncedIcon,
  remote: CanonicalDirectionRemoteIcon,
})

function DirectionIcon({ direction }) {
  const Icon = DIRECTION_ICONS[direction]
  return Icon ? <Icon /> : null
}

function BranchManagementSheet({ children }) {
  return (
    <div
      className="branch-management-sheet branch-management-sheet--motion-ready"
      data-overlay-motion="surface"
    >
      <div className="branch-management-sheet__content">{children}</div>
    </div>
  )
}

function BranchTag({ tone = 'neutral', children }) {
  return <span className={`branch-management-tag branch-management-tag--${tone}`}>{children}</span>
}

function getRowState(row) {
  if (row.comparisonState === 'error') return { text: '读取失败', tone: 'danger' }
  if (row.upstreamGone) return { text: '上游已删除', tone: 'warning' }
  if (row.ahead > 0 && row.behind > 0) return { text: `分叉 ${row.ahead}/${row.behind}`, tone: 'danger' }
  if (row.ahead > 0) return { text: `待推送 ${row.ahead}`, tone: 'ahead' }
  if (row.behind > 0) return { text: `落后 ${row.behind}`, tone: 'behind' }
  if (row.isRemoteOnly) return { text: '仅远端', tone: 'remote' }
  if (!row.upstream) return { text: '无 upstream', tone: 'neutral' }
  return { text: '已同步', tone: 'success' }
}

function BranchStatusPill({ state }) {
  const presentation = getBranchStatusDirection(state.text)
  return (
    <span
      className={`branch-management-state-pill branch-management-state-pill--${state.tone}`}
      data-branch-status-direction={presentation?.direction || undefined}
    >
      {presentation ? (
        <span className="branch-management-state-pill__direction" data-app-tooltip={presentation.label} aria-hidden="true">
          <DirectionIcon direction={presentation.direction} />
        </span>
      ) : null}
      {state.text}
    </span>
  )
}

function DeleteConfirmDialog({ repoName, rows, busy, defaultForceDelete, onCancel, onConfirm }) {
  const [includeRemote, setIncludeRemote] = useState(false)
  const [forceDelete, setForceDelete] = useState(false)
  const hasOptionalRemote = rows.some((row) => !row.isRemoteRow && !row.isRemoteOnly && row.remoteRef && !row.upstreamGone)
  const hasLocalDelete = rows.some((row) => !row.isRemoteRow && !row.isRemoteOnly)
  const remoteOnlyCount = rows.filter((row) => row.isRemoteRow || row.isRemoteOnly).length

  useEffect(() => {
    setIncludeRemote(false)
    setForceDelete(Boolean(defaultForceDelete && hasLocalDelete))
  }, [defaultForceDelete, hasLocalDelete, rows])

  return (
    <div data-overlay-motion="backdrop" className="branch-management-confirm-backdrop" role="presentation" onMouseDown={busy ? undefined : onCancel}>
      <section data-overlay-motion="surface" className="branch-management-confirm" role="dialog" aria-modal="true" aria-label="确认删除分支" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <span className="branch-management-confirm__icon"><CanonicalDeleteIcon className="icon icon--sm" /></span>
          <div><h3>{rows.length > 1 ? `确认批量删除 ${rows.length} 个分支` : '确认删除分支'}</h3><p>{repoName}</p></div>
        </header>
        <div className="branch-management-confirm__list">
          {rows.map((row) => <div key={row.identity}><span>{row.rowName}</span><small>{row.isRemoteRow || row.isRemoteOnly ? '将删除远端分支' : '将删除本地分支'}</small></div>)}
        </div>
        {hasOptionalRemote ? <CanonicalCheckbox className="branch-management-checkbox" checked={includeRemote} disabled={busy} onChange={setIncludeRemote} label="同时删除所选本地分支对应的远端分支"><span className="branch-management-checkbox__label">同时删除所选本地分支对应的远端分支</span></CanonicalCheckbox> : null}
        <CanonicalCheckbox className="branch-management-checkbox" checked={hasLocalDelete && forceDelete} disabled={busy || !hasLocalDelete} onChange={setForceDelete} label="强制删除本地分支（git branch -D）"><span className="branch-management-checkbox__label">强制删除本地分支（git branch -D）</span></CanonicalCheckbox>
        <p className="branch-management-confirm__note">强制删除只跳过“尚未合并”检查；默认分支、当前分支和其他 worktree 的保护仍然生效。</p>
        {remoteOnlyCount > 0 ? <p className="branch-management-confirm__note">其中 {remoteOnlyCount} 个仅远端分支会直接从远端删除，强制删除选项不影响它们。</p> : null}
        <footer>
          <button type="button" className="branch-management-btn" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className="branch-management-btn branch-management-btn--danger" disabled={busy} onClick={() => onConfirm?.({ includeRemote, forceDelete: hasLocalDelete && forceDelete })}>
            {busy ? (forceDelete ? '强制删除中...' : '删除中...') : (forceDelete ? '确认强制删除' : '确认删除')}
          </button>
        </footer>
      </section>
    </div>
  )
}

function ExpandedBranchManager({
  context,
  rows,
  repoStatus,
  loading,
  error,
  activeOperation,
  creationDialogOpen,
  onClose,
  onRefresh,
  onCreate,
  onSwitch,
  onSync,
  onCopy,
  onDelete,
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [batchMode, setBatchMode] = useState(false)
  const [viewMode, setViewMode] = useState(BRANCH_MANAGEMENT_VIEW_MODE.branches)
  const [selectedIdentities, setSelectedIdentities] = useState(() => new Set())
  const searchInputRef = useRef(null)
  const operationActive = Boolean(activeOperation || creationDialogOpen)
  const rowsForView = useMemo(() => getBranchManagementVisibleRows(rows, viewMode), [rows, viewMode])
  const filteredRows = useMemo(() => filterBranchManagementRows(rowsForView, filterText), [filterText, rowsForView])
  const summary = useMemo(() => getBranchManagementViewSummary(rows, viewMode), [rows, viewMode])
  const selectableIdentities = useMemo(() => getSelectableBranchIdentities(filteredRows), [filteredRows])
  const selectedRows = useMemo(() => rows.filter((row) => selectedIdentities.has(row.identity) && row.canDelete), [rows, selectedIdentities])
  const allVisibleSelected = selectableIdentities.length > 0 && selectableIdentities.every((identity) => selectedIdentities.has(identity))
  const preferredCreationRow = useMemo(() => getPreferredBranchCreationRow(rowsForView), [rowsForView])

  useEffect(() => { if (searchOpen) searchInputRef.current?.focus() }, [searchOpen])
  useEffect(() => {
    setSelectedIdentities((previous) => {
      const valid = new Set(rows.filter((row) => row.canDelete).map((row) => row.identity))
      const next = new Set(Array.from(previous).filter((identity) => valid.has(identity)))
      return next.size === previous.size ? previous : next
    })
  }, [rows])

  const setBatch = (next) => {
    if (operationActive) return
    setBatchMode(next)
    setSelectedIdentities(new Set())
    if (next) setViewMode(BRANCH_MANAGEMENT_VIEW_MODE.refs)
  }

  const toggleSelected = (identity, checked) => {
    setSelectedIdentities((previous) => {
      const next = new Set(previous)
      if (checked) next.add(identity)
      else next.delete(identity)
      return next
    })
  }

  const toggleSelectAll = (checked) => {
    setSelectedIdentities((previous) => {
      const next = new Set(previous)
      selectableIdentities.forEach((identity) => checked ? next.add(identity) : next.delete(identity))
      return next
    })
  }

  const handleBatchRowActivation = (event, row) => {
    if (!batchMode || !row.canDelete || event.target.closest('button, input, label, a')) return
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
    if (event.type === 'keydown') event.preventDefault()
    toggleSelected(row.identity, !selectedIdentities.has(row.identity))
  }

  return (
    <div
      className="branch-management-stage"
      data-branch-management-view-mode={viewMode}
    >
      <button data-overlay-motion="backdrop" className="branch-management-backdrop" type="button" onClick={onClose} aria-label="收起分支完整视图" />
      <BranchManagementSheet>
        <header className="branch-management-header">
          <div className="branch-management-header__identity">
            <div className="branch-management-header__brand"><SyncIcon /></div>
            <div><div className="branch-management-header__eyebrow">分支完整视图</div><h2>{context.repoName}</h2><p data-app-tooltip={context.repoPath}>{context.repoPath}</p></div>
          </div>
          <div className="branch-management-header__actions">
            <button
              type="button"
              className="branch-management-create-header branch-management-btn"
              disabled={operationActive || !preferredCreationRow}
              onClick={() => preferredCreationRow && onCreate(preferredCreationRow)}
              data-app-tooltip={preferredCreationRow ? `基于 ${preferredCreationRow.rowName} 创建新分支` : '当前没有可用的分支来源'}
            >
              <BranchIcon className="icon icon--sm" /><span>创建分支</span>
            </button>
            <button
              type="button"
              className={`branch-management-batch-toggle ${batchMode ? 'branch-management-batch-toggle--active' : ''}`}
              onClick={() => setBatch(!batchMode)}
              disabled={operationActive}
              aria-pressed={batchMode}
              data-app-tooltip={batchMode ? '退出批量操作' : '批量操作'}
              aria-label={batchMode ? '退出批量操作' : '批量操作'}
            >
              <CanonicalBatchSelectIcon className="branch-management-batch-toggle__icon" />
              批量操作
            </button>
            <button className={`branch-management-icon-action ${searchOpen ? 'branch-management-icon-btn--active' : ''}`} type="button" onClick={() => setSearchOpen((previous) => !previous)} data-app-tooltip="搜索分支" aria-label="搜索分支" aria-pressed={searchOpen}><CanonicalSearchIcon className="icon icon--xs" /></button>
            <button className="branch-management-icon-action" type="button" onClick={onClose} data-app-tooltip="收起分支完整视图" aria-label="收起分支完整视图"><CanonicalCollapseIcon className="icon icon--xs" /></button>
          </div>
        </header>

        <div className={`branch-management-search ${searchOpen ? 'branch-management-search--open' : ''}`}>
          <CanonicalSearchIcon className="icon icon--xs" />
          <input ref={searchInputRef} type="search" placeholder="搜索分支、upstream、hash 或状态" value={filterText} onChange={(event) => setFilterText(event.target.value)} aria-label="搜索分支" />
          {filterText ? <button type="button" onClick={() => setFilterText('')}>清除</button> : null}
        </div>

        <div className="branch-management-summary">
          {summary.map(([label, count]) => <span key={label}>{label} <strong>{count}</strong></span>)}
          <div className="branch-management-view-toggle" role="group" aria-label="分支显示模式">
            <button type="button" className={viewMode === BRANCH_MANAGEMENT_VIEW_MODE.branches ? 'branch-management-view-toggle__button--active' : ''} disabled={batchMode || operationActive} onClick={() => setViewMode(BRANCH_MANAGEMENT_VIEW_MODE.branches)} aria-pressed={viewMode === BRANCH_MANAGEMENT_VIEW_MODE.branches}>分支视图</button>
            <button type="button" className={viewMode === BRANCH_MANAGEMENT_VIEW_MODE.refs ? 'branch-management-view-toggle__button--active' : ''} disabled={batchMode || operationActive} onClick={() => setViewMode(BRANCH_MANAGEMENT_VIEW_MODE.refs)} aria-pressed={viewMode === BRANCH_MANAGEMENT_VIEW_MODE.refs}>引用视图</button>
          </div>
          <button type="button" className="branch-management-text-action" onClick={onRefresh} disabled={loading || operationActive}><SyncIcon small />{loading ? '刷新中' : '刷新'}</button>
        </div>

        {batchMode ? (
          <div className="branch-management-batch-bar">
            <CanonicalCheckbox className="branch-management-checkbox" checked={allVisibleSelected} disabled={selectableIdentities.length === 0 || operationActive} onChange={toggleSelectAll} label={`选择当前结果（${selectableIdentities.length}）`}><span className="branch-management-checkbox__label">选择当前结果（{selectableIdentities.length}）</span></CanonicalCheckbox>
            <span>已选择 {selectedRows.length} 个可删除分支</span>
            <button type="button" className="branch-management-btn branch-management-btn--danger" disabled={selectedRows.length === 0 || operationActive} onClick={() => onDelete(selectedRows)}><CanonicalDeleteIcon className="icon icon--sm" />批量删除</button>
          </div>
        ) : null}

        <div className="branch-management-table" role="table" aria-label="完整分支信息">
          <div className={`branch-management-table__header ${batchMode ? 'branch-management-table__header--batch' : ''}`} role="row">
            {batchMode ? <span aria-hidden="true" /> : null}
            <span>分支</span><span>Upstream / 范围</span><span>提交</span><span>状态</span><span>操作</span>
          </div>
          <div className="branch-management-table__body">
            {loading && rows.length === 0 ? <div className="branch-management-state">正在读取完整分支信息...</div> : null}
            {!loading && error ? <div className="branch-management-state branch-management-state--error">{error}</div> : null}
            {!loading && !error && filteredRows.length === 0 ? <div className="branch-management-state">没有匹配的分支</div> : null}
            {filteredRows.map((row) => {
              const rowState = getRowState(row)
              const switchAction = getBranchSwitchAction(row, rows, repoStatus, { batchMode, operationActive })
              const rowBusy = activeOperation?.identity === row.identity
              const syncRequired = row.ahead > 0 || row.behind > 0
              return (
                <div
                  className={`branch-management-row ${batchMode ? 'branch-management-row--batch' : ''} ${row.isDefault ? 'branch-management-row--default' : ''} ${selectedIdentities.has(row.identity) ? 'branch-management-row--selected' : ''}`}
                  role="row"
                  key={row.identity}
                  tabIndex={batchMode && row.canDelete ? 0 : undefined}
                  aria-selected={batchMode ? selectedIdentities.has(row.identity) : undefined}
                  onClick={(event) => handleBatchRowActivation(event, row)}
                  onKeyDown={(event) => handleBatchRowActivation(event, row)}
                >
                  {batchMode ? <CanonicalCheckbox className="branch-management-checkbox" checked={selectedIdentities.has(row.identity)} disabled={!row.canDelete || rowBusy || operationActive} onChange={(checked) => toggleSelected(row.identity, checked)} /> : null}
                  <div className="branch-management-row__identity" role="cell">
                    <strong data-app-tooltip={row.rowName}>{row.rowName}</strong>
                    <div>
                      {row.isCurrent ? <BranchTag tone="current">当前</BranchTag> : null}
                      {row.isDefault ? <BranchTag tone="default">默认</BranchTag> : null}
                      {row.isRemoteRow || row.isRemoteOnly ? <BranchTag tone="remote">远端</BranchTag> : <BranchTag>本地</BranchTag>}
                      {row.isCheckedOutElsewhere ? <BranchTag tone="warning">其他 worktree</BranchTag> : null}
                    </div>
                  </div>
                  <div className="branch-management-row__upstream" role="cell"><span data-app-tooltip={row.upstream || row.remoteRef || ''}>{row.upstream || row.remoteRef || '—'}</span><small>{row.isRemoteRow ? '远端引用' : row.hasRemote ? '已关联远端' : '仅本地'}</small></div>
                  <div className="branch-management-row__commit" role="cell"><code data-app-tooltip={row.headHash}>{row.headHash ? row.headHash.slice(0, 10) : '—'}</code>{row.worktreePath ? <small data-app-tooltip={row.worktreePath}>{row.worktreePath}</small> : null}</div>
                  <div className="branch-management-row__state" role="cell"><BranchStatusPill state={rowState} />{row.comparisonError ? <small data-app-tooltip={row.comparisonError}>{row.comparisonError}</small> : null}</div>
                  <div className="branch-management-row__actions" role="cell">
                    <button type="button" className="branch-management-create-row" disabled={operationActive || batchMode} onClick={() => onCreate(row)} data-app-tooltip={`基于 ${row.rowName} 创建新分支`} aria-label={`基于分支 ${row.rowName} 创建新分支`}><BranchIcon className="icon icon--sm" /><span>创建</span></button>
                    {switchAction.visible ? (
                      <button
                        type="button"
                        className={`branch-management-switch-row branch-management-switch-row--${switchAction.kind || 'current'}`}
                        disabled={!switchAction.enabled}
                        onClick={() => switchAction.enabled && onSwitch(row, switchAction)}
                        data-app-tooltip={switchAction.disabledReason || (switchAction.kind === 'track' ? `切换并跟踪 ${switchAction.remoteBranch}` : `切换到 ${switchAction.branch}`)}
                        aria-label={switchAction.disabledReason ? `不能${switchAction.label}分支 ${row.rowName}：${switchAction.disabledReason}` : `${switchAction.label}分支 ${row.rowName}`}
                      >
                        <BranchSwitchIcon className="icon icon--sm" />
                      </button>
                    ) : null}
                    {row.canSync ? (
                      <button type="button" onClick={() => onSync(row)} disabled={operationActive} data-app-tooltip={row.syncDirection === 'push' ? `推送 ${row.rowName}` : `同步 ${row.rowName}`} aria-label={`同步分支 ${row.rowName}`}><SyncIcon /></button>
                    ) : syncRequired ? (
                      <button type="button" disabled data-app-tooltip={row.syncDisabledReason || `${row.rowName} 当前不能同步`} aria-label={`暂不能同步分支 ${row.rowName}`}><SyncIcon /></button>
                    ) : null}
                    <button type="button" onClick={() => onCopy(row.rowName)} disabled={operationActive} data-app-tooltip={`复制分支：${row.rowName}`} aria-label={`复制分支 ${row.rowName}`}><CanonicalCopyIcon className="icon icon--sm" /></button>
                    <button type="button" className="branch-management-row__delete" onClick={() => row.canDelete && onDelete([row])} disabled={!row.canDelete || operationActive} data-app-tooltip={row.canDelete ? `删除分支：${row.rowName}` : row.deleteDisabledReason} aria-label={row.canDelete ? `删除分支 ${row.rowName}` : `不能删除分支 ${row.rowName}：${row.deleteDisabledReason}`}><CanonicalDeleteIcon className="icon icon--sm" /></button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </BranchManagementSheet>
    </div>
  )
}

function BranchForceDeleteSettings({ enabled, onChange }) {
  return (
    <div className="settings__row branch-management-settings-row">
      <div className="settings__label">默认强制删除分支<small>开启后，单独删除和批量删除的确认窗口会默认勾选 git branch -D；每次删除仍可手动取消</small></div>
      <button type="button" className={`toggle ${enabled ? 'toggle--active' : ''}`} onClick={() => onChange(!enabled)} aria-pressed={enabled} aria-label="切换默认强制删除分支" />
    </div>
  )
}

export default function BranchManagementLayer() {
  const [activeContext, setActiveContext] = useState(null)
  const [settingsSection, setSettingsSection] = useState(null)
  const [defaultForceDelete, setDefaultForceDelete] = useState(readBranchForceDeleteDefault)
  const [dataState, setDataState] = useState({ repoPath: '', loading: false, error: '', rows: [], overview: null, meta: null, status: null })
  const [expanded, setExpanded] = useState(false)
  const [activeOperation, setActiveOperation] = useState(null)
  const [creationTarget, setCreationTarget] = useState(null)
  const [creationBusy, setCreationBusy] = useState(false)
  const [deleteRows, setDeleteRows] = useState([])
  const [deleteContext, setDeleteContext] = useState(null)
  const [notice, setNotice] = useState(null)
  const activeContextRef = useRef(activeContext)
  const rowsRef = useRef(dataState.rows)
  const expandedRef = useRef(expanded)
  const operationRef = useRef(activeOperation)
  const loadRequestRef = useRef(0)

  useEffect(() => { activeContextRef.current = activeContext }, [activeContext])
  useEffect(() => { rowsRef.current = dataState.rows }, [dataState.rows])
  useEffect(() => { expandedRef.current = expanded }, [expanded])
  useEffect(() => { operationRef.current = activeOperation }, [activeOperation])

  const showNotice = useCallback((title, message, tone = 'info') => setNotice({ title, message, tone, id: Date.now() }), [])
  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(null), notice.tone === 'danger' ? 5200 : 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key === BRANCH_FORCE_DELETE_DEFAULT_STORAGE_KEY) setDefaultForceDelete(readBranchForceDeleteDefault())
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    let frame = 0
    const scan = () => {
      frame = 0
      const next = Array.from(document.querySelectorAll('.settings__section'))
        .find((section) => section.querySelector('.settings__section-title')?.textContent?.trim() === '同步设置') || null
      setSettingsSection((previous) => previous === next ? previous : next)
    }
    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(scan)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  const updateDefaultForceDelete = useCallback((value) => setDefaultForceDelete(writeBranchForceDeleteDefault(value)), [])

  const loadBranchData = useCallback(async (repoPath, { quiet = false } = {}) => {
    if (!repoPath) return
    const requestId = ++loadRequestRef.current
    if (!quiet) setDataState((previous) => ({
      ...previous,
      repoPath,
      loading: true,
      error: '',
      rows: previous.repoPath === repoPath ? previous.rows : [],
      overview: previous.repoPath === repoPath ? previous.overview : null,
      meta: previous.repoPath === repoPath ? previous.meta : null,
      status: previous.repoPath === repoPath ? previous.status : null,
    }))
    try {
      const [overview, meta, status] = await Promise.all([
        invoke('get_repo_branch_overview', { path: repoPath }),
        invoke('get_repo_branch_management_meta', { path: repoPath }),
        invoke('get_repo_status', { path: repoPath }),
      ])
      if (requestId !== loadRequestRef.current) return
      setDataState({ repoPath, loading: false, error: '', rows: normalizeBranchManagementRows(overview, meta, status), overview, meta, status })
    } catch (error) {
      if (requestId !== loadRequestRef.current) return
      setDataState((previous) => ({ ...previous, repoPath, loading: false, error: getErrorMessage(error) }))
    }
  }, [])

  useEffect(() => {
    if (!expanded || !activeContext?.repoPath) return
    void loadBranchData(activeContext.repoPath)
  }, [activeContext?.repoPath, expanded, loadBranchData])

  const operationContext = useCallback(() => activeContextRef.current, [])
  const refreshRepositorySurfaces = useCallback(async (context, { quiet = true } = {}) => {
    if (!context?.repoPath) return
    await loadBranchData(context.repoPath, { quiet })
    if (context.repoId) await invoke('refresh_repo_git_metadata', { repoId: context.repoId }).catch(() => {})
  }, [loadBranchData])

  const runOperation = useCallback(async ({ kind, identity, task }) => {
    if (operationRef.current || creationBusy) return null
    const token = { kind, identity }
    operationRef.current = token
    setActiveOperation(token)
    try {
      return await task()
    } finally {
      operationRef.current = null
      setActiveOperation(null)
    }
  }, [creationBusy])

  const handleCreate = useCallback((row) => {
    const context = operationContext()
    const source = getBranchCreationSource(row)
    if (!context || !source || operationRef.current || creationTarget) return
    setCreationTarget({ context, source, row })
  }, [creationTarget, operationContext])

  const handleSwitch = useCallback(async (row, action) => {
    const context = operationContext()
    if (!context || !action?.enabled) return
    await runOperation({
      kind: action.kind,
      identity: row.identity,
      task: async () => {
        try {
          const result = await invoke('switch_repo_branch', {
            path: context.repoPath,
            branch: action.branch,
            remoteBranch: action.remoteBranch,
          })
          showNotice(action.kind === 'track' ? '远端分支已跟踪' : '分支切换完成', result?.message || `已切换到 ${action.branch}`, 'success')
          await refreshRepositorySurfaces(context)
          return result
        } catch (error) {
          showNotice('分支切换失败', getErrorMessage(error), 'danger')
          await refreshRepositorySurfaces(context)
          return null
        }
      },
    })
  }, [operationContext, refreshRepositorySurfaces, runOperation, showNotice])

  const handleSync = useCallback(async (row) => {
    const context = operationContext()
    if (!context || !row?.canSync) return
    await runOperation({
      kind: 'sync',
      identity: row.identity,
      task: async () => {
        try {
          const result = await invoke('sync_repo_branch', { path: context.repoPath, branch: row.localName })
          showNotice('分支同步完成', result?.message || `${row.rowName} 已同步`, 'success')
          await refreshRepositorySurfaces(context)
          return result
        } catch (error) {
          showNotice('分支同步失败', getErrorMessage(error), 'danger')
          await refreshRepositorySurfaces(context)
          return null
        }
      },
    })
  }, [operationContext, refreshRepositorySurfaces, runOperation, showNotice])

  const handleCopy = useCallback(async (value) => {
    const text = String(value || '').trim()
    if (!text) return
    try {
      if (globalThis.navigator?.clipboard?.writeText) await globalThis.navigator.clipboard.writeText(text)
      else await invoke('write_clipboard', { text })
      showNotice('已复制', text, 'success')
    } catch (error) {
      showNotice('复制失败', getErrorMessage(error), 'danger')
    }
  }, [showNotice])

  const requestDelete = useCallback((rows) => {
    const safeRows = (Array.isArray(rows) ? rows : []).filter(Boolean)
    if (!safeRows.length || operationRef.current || creationTarget) return
    const blocked = safeRows.find((row) => !row.canDelete)
    if (blocked) {
      showNotice('不能删除分支', blocked.deleteDisabledReason || `${blocked.rowName} 当前不可删除`, 'danger')
      return
    }
    setDeleteContext(operationContext())
    setDeleteRows(safeRows)
  }, [creationTarget, operationContext, showNotice])

  const confirmDelete = useCallback(async ({ includeRemote = false, forceDelete = false } = {}) => {
    const context = deleteContext || operationContext()
    if (!context || !deleteRows.length) return
    const selected = new Set(deleteRows.map((row) => row.identity))
    const requests = buildBatchDeleteRequests(rowsRef.current, selected, { includeRemote, forceDelete })
    if (!requests.length) {
      showNotice('没有可删除分支', '默认分支、当前分支和其他受保护分支不会被删除。', 'danger')
      setDeleteRows([])
      setDeleteContext(null)
      return
    }
    const useForceCommand = requests.some((request) => request.forceDelete === true)
    await runOperation({
      kind: 'delete',
      identity: deleteRows.length === 1 ? deleteRows[0].identity : 'batch-delete',
      task: async () => {
        try {
          // Single delete authority: the request carries forceDelete per branch.
          const result = await invoke('delete_repo_branches_batch', { path: context.repoPath, requests })
          const failedCount = Number(result?.failed_count ?? result?.failedCount ?? 0)
          const succeededCount = Number(result?.succeeded_count ?? result?.succeededCount ?? 0)
          const failures = Array.isArray(result?.results) ? result.results.filter((item) => !item.success).map((item) => item.message || item.warning).filter(Boolean) : []
          if (failedCount > 0) showNotice('批量删除部分完成', `成功 ${succeededCount} 个，失败 ${failedCount} 个。${failures.length ? ` ${failures.join('；')}` : ''}`, 'danger')
          else showNotice(useForceCommand ? '分支强制删除成功' : '分支删除成功', `已删除 ${succeededCount || requests.length} 个分支。`, 'success')
          setDeleteRows([])
          setDeleteContext(null)
          await refreshRepositorySurfaces(context)
          return result
        } catch (error) {
          showNotice(useForceCommand ? '分支强制删除失败' : '分支删除失败', getErrorMessage(error), 'danger')
          await refreshRepositorySurfaces(context)
          return null
        }
      },
    })
  }, [deleteContext, deleteRows, operationContext, refreshRepositorySurfaces, runOperation, showNotice])

  const openExpanded = useCallback((inputContext) => {
    if (expandedRef.current) return
    const context = normalizeBranchManagementOpenContext(inputContext)
    if (!context) {
      showNotice('无法展开分支视图', '当前仓库上下文不可用，请重新打开分支悬浮窗。', 'danger')
      return
    }
    activeContextRef.current = context
    expandedRef.current = true
    document.body.classList.add(OVERLAY_BODY_CLASS)
    setActiveContext(context)
    setExpanded(true)
  }, [showNotice])

  const finishClose = useCallback(() => {
    document.body.classList.remove(OVERLAY_BODY_CLASS)
    expandedRef.current = false
    activeContextRef.current = null
    setActiveContext(null)
    setDataState({ repoPath: '', loading: false, error: '', rows: [], overview: null, meta: null, status: null })
  }, [])

  const closeExpanded = useCallback(() => {
    if (!expandedRef.current || activeOperation || creationBusy) return
    if (creationTarget) {
      setCreationTarget(null)
      return
    }
    expandedRef.current = false
    setExpanded(false)
  }, [activeOperation, creationBusy, creationTarget])

  useEffect(() => () => {
    document.body.classList.remove(OVERLAY_BODY_CLASS)
  }, [])

  useEffect(() => {
    if (!expanded) return undefined
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      if (creationTarget && !creationBusy) setCreationTarget(null)
      else if (deleteRows.length > 0 && activeOperation?.kind !== 'delete') {
        setDeleteRows([])
        setDeleteContext(null)
      } else closeExpanded()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeOperation?.kind, closeExpanded, creationBusy, creationTarget, deleteRows.length, expanded])

  return (
    <>
      <BranchManagementHoverGateway disabled={expanded} onOpen={openExpanded} />

      {settingsSection?.isConnected ? createPortal(
        <BranchForceDeleteSettings enabled={defaultForceDelete} onChange={updateDefaultForceDelete} />,
        settingsSection
      ) : null}

      {activeContext && typeof document !== 'undefined' ? (
        <OverlayPortal
          level={OVERLAY_LEVEL.workspace}
          overlayId={OVERLAY_ID.branchManagement}
          present={expanded}
          onExitComplete={finishClose}
          onEscape={closeExpanded}
        >
          <ExpandedBranchManager
            context={activeContext}
            rows={dataState.rows}
            repoStatus={dataState.status}
            loading={dataState.loading}
            error={dataState.error}
            activeOperation={activeOperation}
            creationDialogOpen={Boolean(creationTarget) || creationBusy}
            onClose={closeExpanded}
            onRefresh={() => loadBranchData(activeContext.repoPath)}
            onCreate={handleCreate}
            onSwitch={handleSwitch}
            onSync={handleSync}
            onCopy={handleCopy}
            onDelete={requestDelete}
          />
        </OverlayPortal>
      ) : null}

      {typeof document !== 'undefined' ? (
        <OverlayPortal
          level={OVERLAY_LEVEL.nested}
          overlayId={OVERLAY_ID.branchCreation}
          parentOverlayId={OVERLAY_ID.branchManagement}
          present={Boolean(creationTarget)}
          onEscape={() => { if (!creationBusy) setCreationTarget(null) }}
        >
          {creationTarget ? (
          <BranchCreationDialog
            target={creationTarget}
            onBusyChange={setCreationBusy}
            onRepositoryChanged={async () => refreshRepositorySurfaces(creationTarget.context)}
            onClose={() => { if (!creationBusy) setCreationTarget(null) }}
          />
          ) : null}
        </OverlayPortal>
      ) : null}

      {typeof document !== 'undefined' ? (
        <OverlayPortal
          level={OVERLAY_LEVEL.nested}
          overlayId={OVERLAY_ID.branchDelete}
          parentOverlayId={OVERLAY_ID.branchManagement}
          present={deleteRows.length > 0 && Boolean(deleteContext || activeContext)}
          onEscape={() => {
            if (activeOperation?.kind !== 'delete') {
              setDeleteRows([])
              setDeleteContext(null)
            }
          }}
        >
          {deleteRows.length > 0 && (deleteContext || activeContext) ? (
          <DeleteConfirmDialog
            repoName={(deleteContext || activeContext).repoName}
            rows={deleteRows}
            busy={activeOperation?.kind === 'delete'}
            defaultForceDelete={defaultForceDelete}
            onCancel={() => {
              if (activeOperation?.kind !== 'delete') {
                setDeleteRows([])
                setDeleteContext(null)
              }
            }}
            onConfirm={confirmDelete}
          />
          ) : null}
        </OverlayPortal>
      ) : null}

      {notice && typeof document !== 'undefined' ? createPortal(
        <div className={`branch-management-notice branch-management-notice--${notice.tone}`} role="status" key={notice.id}><strong>{notice.title}</strong><span>{notice.message}</span></div>,
        document.body
      ) : null}
    </>
  )
}
