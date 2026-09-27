import { useState } from 'react'
import { WarningIcon } from './icons/CanonicalIcons.jsx'

export default function StashScopeResolutionPanel({
  summary,
  busy = false,
  error = '',
  confirmingUnstage = false,
  onSwitchAll,
  onRequestUnstage,
  onCancelUnstage,
  onConfirmUnstage,
}) {
  const [expanded, setExpanded] = useState(false)
  if (!summary) return null
  const files = Array.isArray(summary.files) ? summary.files : []

  return (
    <section className="stash-scope-resolution" role="alert" aria-live="polite">
      <div className="stash-scope-resolution__icon"><WarningIcon /></div>
      <div className="stash-scope-resolution__content">
        <strong>{summary.title}</strong>
        <p>{summary.description}</p>
        <button type="button" className="stash-scope-resolution__details-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          查看 {summary.fileCount} 个文件
        </button>
        {expanded ? (
          <div className="stash-scope-resolution__files">
            {files.map((file) => <code key={`${file.oldPath || ''}:${file.path}`}>{file.oldPath ? `${file.oldPath} → ` : ''}{file.path}</code>)}
          </div>
        ) : null}
        {error ? <div className="stash-scope-resolution__error">{error}</div> : null}
        {!confirmingUnstage ? (
          <div className="stash-scope-resolution__actions">
            <button type="button" disabled={busy} onClick={onSwitchAll}>改为 Stash 全部改动</button>
            <button type="button" disabled={busy} onClick={onRequestUnstage}>取消暂存后继续</button>
          </div>
        ) : (
          <div className="stash-scope-resolution__confirmation">
            <p>这会先取消相关条目的暂存状态，但不会改写或删除文件内容。完成后才允许继续创建文件级 Stash。</p>
            <div>
              <button type="button" disabled={busy} onClick={onCancelUnstage}>取消</button>
              <button type="button" disabled={busy} onClick={onConfirmUnstage}>{busy ? '处理中…' : '确认取消暂存'}</button>
            </div>
          </div>
        )}
        <small>尚未执行 Stash，也尚未修改暂存区。</small>
      </div>
    </section>
  )
}
