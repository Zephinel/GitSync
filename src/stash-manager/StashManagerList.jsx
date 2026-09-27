import { useEffect, useMemo, useState } from 'react'
import CustomSelect from '../CustomSelect.jsx'
import StashEntryActionMenu from '../StashEntryActionMenu.jsx'
import DirectionalChevronIcon from '../icons/DirectionalChevronIcon.jsx'
import { BranchIcon, SearchIcon, StashIcon } from '../icons/CanonicalIcons.jsx'
import { stashSnapshotHasCompleteStashList } from '../stashSnapshotCompleteness.js'
import { useStashDetailIndex } from './useStashDetailIndex.js'
import {
  branchKey,
  dateMs,
  formatDate,
  shortOid,
  Spinner,
  visiblePageNumbers,
} from './managerUtils.jsx'

const PAGE_SIZE = 8
const SORT_OPTIONS = [
  { value: 'desc', label: '按创建时间 ↓' },
  { value: 'asc', label: '按创建时间 ↑' },
]

function Pagination({ count, page, pageCount, onPageChange }) {
  return (
    <footer className="stash-manager-pagination">
      <span>共 {count} 条</span>
      <div>
        <button type="button" disabled={page <= 1} aria-label="上一页" onClick={() => onPageChange(Math.max(1, page - 1))}><DirectionalChevronIcon direction="left" /></button>
        {visiblePageNumbers(page, pageCount).map((number) => (
          <button type="button" key={number} className={page === number ? 'stash-manager-pagination__active' : ''} aria-current={page === number ? 'page' : undefined} onClick={() => onPageChange(number)}>{number}</button>
        ))}
        <button type="button" disabled={page >= pageCount} aria-label="下一页" onClick={() => onPageChange(Math.min(pageCount, page + 1))}><DirectionalChevronIcon /></button>
      </div>
    </footer>
  )
}

export default function StashManagerList({
  repoPath,
  snapshot,
  busy = false,
  selectedStashId = null,
  detailPanel = null,
  onOpenDetail,
  onRequestAction,
  onMenuOpenChange,
}) {
  const [query, setQuery] = useState('')
  const [branchFilter, setBranchFilter] = useState('all')
  const [sortDirection, setSortDirection] = useState('desc')
  const [page, setPage] = useState(1)
  const [actionId, setActionId] = useState(null)
  const allStashes = useMemo(() => snapshot?.stashes || [], [snapshot])
  const detailMode = Boolean(selectedStashId && detailPanel)
  const canPruneAbsentDetails = stashSnapshotHasCompleteStashList(snapshot)

  const branchCounts = useMemo(() => {
    const counts = new Map()
    allStashes.forEach((entry) => counts.set(branchKey(entry), (counts.get(branchKey(entry)) || 0) + 1))
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  }, [allStashes])

  const preliminary = useMemo(() => allStashes
    .filter((entry) => branchFilter === 'all' || branchKey(entry) === branchFilter)
    .slice()
    .sort((left, right) => {
      const difference = dateMs(left.createdAt) - dateMs(right.createdAt)
      if (difference !== 0) return sortDirection === 'asc' ? difference : -difference
      return sortDirection === 'asc' ? right.ordinal - left.ordinal : left.ordinal - right.ordinal
    }), [allStashes, branchFilter, sortDirection])

  const preliminaryPageCount = Math.max(1, Math.ceil(preliminary.length / PAGE_SIZE))
  const preliminaryPage = Math.min(page, preliminaryPageCount)
  const preliminaryVisible = useMemo(
    () => preliminary.slice((preliminaryPage - 1) * PAGE_SIZE, preliminaryPage * PAGE_SIZE),
    [preliminary, preliminaryPage]
  )

  const {
    searchVersion,
    getFileCount,
    matchesQuery,
    indexingFiles,
    searchIncomplete,
  } = useStashDetailIndex(
    repoPath,
    allStashes,
    preliminary,
    preliminaryVisible,
    query,
    { canPruneAbsent: canPruneAbsentDetails },
  )

  const filteredStashes = useMemo(
    () => preliminary.filter((entry) => matchesQuery(entry)),
    [matchesQuery, preliminary, searchVersion]
  )

  const pageCount = Math.max(1, Math.ceil(filteredStashes.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pagedStashes = useMemo(
    () => filteredStashes.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredStashes, safePage]
  )

  useEffect(() => { setPage(1) }, [branchFilter, query, sortDirection])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  useEffect(() => { setActionId(null) }, [branchFilter, page, query, sortDirection])
  useEffect(() => { onMenuOpenChange?.(Boolean(actionId)) }, [actionId, onMenuOpenChange])
  useEffect(() => () => onMenuOpenChange?.(false), [onMenuOpenChange])

  const searchField = (
    <label className="stash-manager-search-field">
      <SearchIcon />
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Stash 说明或文件名…" aria-label="搜索 Stash 说明或文件名" />
    </label>
  )
  const searchCoverageNotice = query.trim() && searchIncomplete ? (
    <p className="stash-manager-indexing" role="status">
      部分 Stash 的文件列表超过安全上限或详情暂不可用；未加载部分无法排除的条目已保留在结果中。
    </p>
  ) : null

  if (detailMode) {
    return (
      <div className="stash-manager-master-detail">
        <aside className="stash-manager-master-list" aria-label="Stash 条目列表">
          <div className="stash-manager-master-list__toolbar">{searchField}</div>
          {indexingFiles ? <p className="stash-manager-indexing"><Spinner />正在建立文件名搜索索引…</p> : null}
          {searchCoverageNotice}
          <div className="stash-manager-master-list__items">
            {pagedStashes.length === 0 ? <div className="stash-manager-master-list__empty">没有匹配的 Stash。</div> : null}
            {pagedStashes.map((entry) => {
              const fileCount = getFileCount(entry.id)
              return (
                <button
                  type="button"
                  key={entry.id}
                  className={`stash-manager-master-list__item ${selectedStashId === entry.id ? 'stash-manager-master-list__item--active' : ''}`}
                  aria-current={selectedStashId === entry.id ? 'true' : undefined}
                  onClick={() => onOpenDetail?.(entry.id)}
                >
                  <span className="stash-manager-master-list__message" data-app-tooltip={entry.message}>{entry.message}</span>
                  <small>{entry.branchContext || 'other'} · {formatDate(entry.createdAt)}</small>
                  <strong>{fileCount ?? '—'}</strong>
                </button>
              )
            })}
          </div>
          <Pagination count={filteredStashes.length} page={safePage} pageCount={pageCount} onPageChange={setPage} />
        </aside>
        <main className="stash-manager-detail-pane">{detailPanel}</main>
      </div>
    )
  }

  return (
    <div className="stash-manager-workspace">
      <aside className="stash-manager-sidebar" aria-label="Stash 分支筛选">
        <button type="button" className={branchFilter === 'all' ? 'stash-manager-sidebar__item--active' : ''} onClick={() => setBranchFilter('all')}>
          <span className="stash-manager-sidebar__icon"><StashIcon /></span>
          <span>全部 Stash</span>
          <strong>{snapshot.stashTotal}</strong>
        </button>
        <h3>按分支筛选</h3>
        <div className="stash-manager-sidebar__branches">
          {branchCounts.map(([branch, count]) => (
            <button type="button" key={branch} className={branchFilter === branch ? 'stash-manager-sidebar__item--active' : ''} onClick={() => setBranchFilter(branch)}>
              <span className="stash-manager-sidebar__branch-icon"><BranchIcon /></span>
              <span data-app-tooltip={branch}>{branch}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>
      </aside>

      <main className="stash-manager-main">
        <div className="stash-manager-toolbar">
          {searchField}
          <CustomSelect
            value={sortDirection}
            options={SORT_OPTIONS}
            onChange={setSortDirection}
            ariaLabel="Stash 创建时间排序"
            className="stash-manager-sort-select"
          />
        </div>

        {indexingFiles ? <p className="stash-manager-indexing"><Spinner />正在建立文件名搜索索引，结果会逐步更新…</p> : null}
        {searchCoverageNotice}

        <div className="stash-manager-table-scroll">
          <div className="stash-manager-table" role="table" aria-label="Stash 列表">
            <div className="stash-manager-table__header" role="row">
              <span role="columnheader">说明</span>
              <span role="columnheader">分支</span>
              <span role="columnheader">创建时间</span>
              <span role="columnheader">文件数</span>
              <span role="columnheader">操作</span>
            </div>

            {pagedStashes.length === 0 ? <div className="stash-manager-table__empty">没有匹配的 Stash。</div> : null}

            {pagedStashes.map((entry, rowIndex) => {
              const fileCount = getFileCount(entry.id)
              return (
                <article className="stash-manager-table-row" role="row" key={entry.id}>
                  <button type="button" className="stash-manager-table-row__main" onClick={() => onOpenDetail?.(entry.id)}>
                    <span className="stash-manager-table-row__description"><strong>{entry.message}</strong><small>{entry.selector} · {shortOid(entry.id)}</small></span>
                    <span data-app-tooltip={entry.branchContext || 'other'}>{entry.branchContext || 'other'}</span>
                    <span>{formatDate(entry.createdAt)}</span>
                    <span>{fileCount ?? '—'}</span>
                  </button>
                  <StashEntryActionMenu
                    entry={entry}
                    busy={busy}
                    open={actionId === entry.id}
                    onOpenChange={(open) => setActionId(open ? entry.id : null)}
                    restoreDisabled={(snapshot.conflictedFiles || 0) > 0}
                    onApply={() => onRequestAction?.('apply', entry)}
                    onPop={() => onRequestAction?.('pop', entry)}
                    onViewDetails={() => onOpenDetail?.(entry.id)}
                    onDrop={() => onRequestAction?.('drop', entry)}
                    placement={rowIndex >= pagedStashes.length - 2 ? 'top' : 'bottom'}
                  />
                </article>
              )
            })}
          </div>
        </div>

        <Pagination count={filteredStashes.length} page={safePage} pageCount={pageCount} onPageChange={setPage} />
      </main>
    </div>
  )
}
