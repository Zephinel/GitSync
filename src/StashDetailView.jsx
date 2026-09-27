import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ApplyAndDropIcon,
  CheckIcon,
  DeleteIcon,
  SearchIcon,
} from './icons/CanonicalIcons.jsx'
import { stashErrorMessage } from './stashError.js'
import { readStashDetail } from './stashDetailRepository.js'
import { readStashFileDiff } from './stashFileDiffClient.js'
import { Spinner } from './stash-manager/managerUtils.jsx'

const STATUS_LABELS = {
  conflicted: '冲突',
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  typechange: '类型变化',
  untracked: '未跟踪',
}

const STATUS_ORDER = [
  'conflicted',
  'added',
  'modified',
  'typechange',
  'deleted',
  'renamed',
  'copied',
  'untracked',
]

function shortOid(value) {
  return String(value || '').slice(0, 12) || '—'
}

function formatDate(value) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '时间未知' : parsed.toLocaleString()
}

export default function StashDetailView({
  repoPath,
  stashId,
  busy = false,
  restoreDisabled = false,
  refreshToken = 0,
  onAction,
}) {
  const lastRefreshTokenRef = useRef(refreshToken)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [fileDiff, setFileDiff] = useState(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState('')

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const force = refreshToken !== lastRefreshTokenRef.current
    lastRefreshTokenRef.current = refreshToken
    setLoading(true)
    setError('')
    setDetail(null)
    void readStashDetail(repoPath, stashId, { force, signal: controller.signal })
      .then((next) => {
        if (!active) return
        setDetail(next)
        setSelectedPath((current) => (
          next.files.some((file) => file.path === current)
            ? current
            : next.files[0]?.path || ''
        ))
      })
      .catch((loadError) => {
        if (active) setError(stashErrorMessage(loadError) || '读取 Stash 详情失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [refreshToken, repoPath, stashId])

  useEffect(() => {
    if (!selectedPath) {
      setFileDiff(null)
      return undefined
    }
    let active = true
    const controller = new AbortController()
    setFileDiff(null)
    setDiffLoading(true)
    setDiffError('')
    void readStashFileDiff(repoPath, stashId, selectedPath, { signal: controller.signal })
      .then((next) => {
        if (active) setFileDiff(next)
      })
      .catch((loadError) => {
        if (active) setDiffError(stashErrorMessage(loadError) || '读取文件 Diff 失败')
      })
      .finally(() => {
        if (active) setDiffLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [refreshToken, repoPath, selectedPath, stashId])

  const filteredFiles = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return detail?.files || []
    return (detail?.files || []).filter((file) => (
      file.path.toLowerCase().includes(needle)
      || file.oldPath?.toLowerCase().includes(needle)
      || String(STATUS_LABELS[file.status] || file.status).toLowerCase().includes(needle)
    ))
  }, [detail, query])

  const groupedFiles = useMemo(() => {
    const groups = new Map()
    for (const file of filteredFiles) {
      const key = STATUS_ORDER.includes(file.status) ? file.status : 'modified'
      const values = groups.get(key) || []
      values.push(file)
      groups.set(key, values)
    }
    return STATUS_ORDER
      .filter((status) => groups.has(status))
      .map((status) => ({ status, files: groups.get(status) }))
  }, [filteredFiles])

  if (loading && !detail) {
    return <div className="stash-detail-state stash-detail-state--full"><Spinner />正在读取 Stash 详情…</div>
  }
  if (error) {
    return <div className="stash-detail-state stash-detail-state--error stash-detail-state--full"><strong>Stash 详情读取失败</strong><span>{error}</span></div>
  }
  if (!detail) return null

  const entry = detail.entry

  return (
    <section className="stash-detail-view stash-detail-view--embedded">
      <header className="stash-detail-header stash-detail-header--embedded">
        <div>
          <span>Stash 详情</span>
          <h3>{entry.message}</h3>
        </div>
      </header>

      <div className="stash-detail-meta">
        <span>{entry.selector}</span>
        <span>OID <code data-app-tooltip={entry.id}>{shortOid(entry.id)}</code></span>
        <span>分支 <strong>{entry.branchContext || '未知'}</strong></span>
        <span>创建时间 {formatDate(entry.createdAt)}</span>
        <span>基线 <code data-app-tooltip={entry.baseCommit || ''}>{shortOid(entry.baseCommit)}</code></span>
        <span>{entry.baseSummary || '基线摘要不可用'}</span>
      </div>

      <div className="stash-detail-stats">
        <span>文件 <strong>{detail.fileCount}</strong></span>
        <span className="stash-detail-stats--add">新增 +{detail.additions}</span>
        <span>修改 {detail.modifiedFiles}</span>
        <span className="stash-detail-stats--delete">删除 {detail.deletedFiles}</span>
        <span>重命名 {detail.renamedFiles}</span>
        <span>未跟踪 {detail.untrackedFiles}</span>
      </div>

      {detail.filesTruncated ? <p className="stash-detail-warning">文件列表超过安全上限，只显示前 {detail.files.length} 项；上方汇总仍基于完整 Stash。</p> : null}
      {restoreDisabled ? <p className="stash-detail-warning">当前工作区存在未解决冲突，暂时不能应用 Stash；查看详情和删除仍可用。</p> : null}

      <div className="stash-detail-layout">
        <aside>
          <label className="stash-detail-search-field">
            <SearchIcon />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件…" aria-label="搜索 Stash 文件" />
          </label>
          <div className="stash-detail-files">
            {groupedFiles.length === 0 ? <div className="stash-detail-files__empty">没有匹配的文件。</div> : null}
            {groupedFiles.map((group) => (
              <section className="stash-detail-file-group" key={group.status}>
                <header><strong>{STATUS_LABELS[group.status] || group.status}</strong><span>{group.files.length}</span></header>
                {group.files.map((file) => (
                  <button
                    type="button"
                    key={`${file.status}:${file.path}`}
                    className={selectedPath === file.path ? 'stash-detail-file--selected' : ''}
                    onClick={() => setSelectedPath(file.path)}
                  >
                    <span className={`stash-detail-file__status stash-detail-file__status--${file.status}`}>{STATUS_LABELS[file.status] || file.status}</span>
                    <span className="stash-detail-file__identity"><strong>{file.path}</strong>{file.oldPath ? <small>原路径：{file.oldPath}</small> : null}</span>
                    <span className="stash-detail-file__stat">{file.isBinary ? '二进制' : `+${file.additions} / -${file.deletions}`}</span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        </aside>

        <main className="stash-detail-diff">
          {diffLoading ? <div className="stash-detail-state"><Spinner />正在读取文件 Diff…</div> : null}
          {diffError ? <div className="stash-detail-state stash-detail-state--error">{diffError}</div> : null}
          {!diffLoading && !diffError && fileDiff?.tooLarge ? <div className="stash-detail-binary">文件内容超过 2 MiB 详情安全上限，未加载文本 Patch。</div> : null}
          {!diffLoading && !diffError && fileDiff?.isBinary ? <div className="stash-detail-binary">该文件为二进制内容，无法显示文本 Diff。</div> : null}
          {!diffLoading && !diffError && fileDiff && !fileDiff.isBinary && !fileDiff.tooLarge ? (
            <>
              {fileDiff.truncated ? <div className="stash-detail-warning">Patch 超过安全上限，当前显示已截断。</div> : null}
              <pre><code>{fileDiff.patch || '该文件没有可显示的文本 Patch。'}</code></pre>
            </>
          ) : null}
          {!selectedPath ? <div className="stash-detail-state">请选择一个文件查看 Diff。</div> : null}
        </main>
      </div>

      <footer className="stash-detail-actions">
        <button type="button" disabled={busy || restoreDisabled} onClick={() => onAction?.('apply', entry)}><CheckIcon />应用</button>
        <button type="button" className="stash-detail-actions__primary" disabled={busy || restoreDisabled} onClick={() => onAction?.('pop', entry)}><ApplyAndDropIcon />应用并删除</button>
        <button type="button" className="stash-detail-actions__danger" disabled={busy} onClick={() => onAction?.('drop', entry)}><DeleteIcon />删除 Stash</button>
      </footer>
    </section>
  )
}
