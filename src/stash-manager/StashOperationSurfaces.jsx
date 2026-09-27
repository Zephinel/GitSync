import { stashOperationLabel, stashResultTone } from '../stashViewModel.js'
import {
  ApplyAndDropIcon,
  CheckIcon,
  CloseIcon,
  DeleteIcon,
  SuccessIcon,
  WarningIcon,
} from '../icons/CanonicalIcons.jsx'
import { shortOid, Spinner } from './managerUtils.jsx'
import OverlayPortal from '../OverlayPortal.jsx'
import { OVERLAY_ID, OVERLAY_LEVEL } from '../overlayLayerContract.js'

function ResultStatusIcon({ tone }) {
  return tone === 'success' ? <SuccessIcon /> : <WarningIcon />
}

function resultDetail(result) {
  if (result.errors?.length > 0) return result.errors[0]
  if (result.conflicts?.length > 0) return `存在 ${result.conflicts.length} 个冲突文件，请检查工作区。`
  if (result.warnings?.length > 0) return result.warnings[0]
  if (result.snapshotError) return `快照刷新失败：${result.snapshotError}`
  if (result.status === 'complete' && result.entryMessage) {
    if (result.operation === 'pop') return `${result.entryMessage} 已成功应用并删除。`
    if (result.operation === 'drop') return `${result.entryMessage} 已成功删除。`
    if (result.operation === 'apply') return `${result.entryMessage} 已成功应用。`
  }
  return result.message || '操作结果已更新。'
}

export function ResultPanel({ result, onDismiss }) {
  if (!result) return null
  const tone = stashResultTone(result.status)
  const detail = resultDetail(result)
  return (
    <aside className={`stash-manager-toast stash-manager-toast--${tone}`} role={tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
      <span className="stash-manager-toast__icon"><ResultStatusIcon tone={tone} /></span>
      <div className="stash-manager-toast__content">
        <strong>{stashOperationLabel(result.operation)}</strong>
        <span data-app-tooltip={detail}>{detail}</span>
        <div className="stash-manager-result__axes">
          {result.worktreeChanged ? <span>工作区已变化</span> : null}
          {result.applied ? <span>内容已应用</span> : null}
          {result.dropped ? <span>原条目已删除</span> : null}
          {result.stashRetained ? <span>原条目仍保留</span> : null}
          {result.needsConfirmation ? <span>结果需要确认</span> : null}
        </div>
      </div>
      <button type="button" className="stash-manager-toast__close" onClick={onDismiss} aria-label="关闭操作结果"><CloseIcon /></button>
    </aside>
  )
}

function ConfirmActionIcon({ operation }) {
  if (operation === 'drop') return <DeleteIcon />
  if (operation === 'pop') return <ApplyAndDropIcon />
  return <CheckIcon />
}

export function ConfirmationDialog({ present, dialogRef, operation, entry, snapshot, busy, onCancel, onConfirm }) {
  const isDrop = operation === 'drop'
  const isPop = operation === 'pop'
  const title = stashOperationLabel(operation)
  return (
    <OverlayPortal
      level={OVERLAY_LEVEL.nested}
      overlayId={OVERLAY_ID.stashOperation}
      parentOverlayId={OVERLAY_ID.stashManager}
      present={present}
      onEscape={() => { if (!busy) onCancel?.() }}
    >
      {operation && entry ? (
      <div data-overlay-motion="backdrop" className="stash-manager-confirm-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel?.()
      }}>
        <section data-overlay-motion="surface" ref={dialogRef} className="stash-manager-confirm" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h3>{title}</h3><p>{entry.message}</p></div></header>
        <dl>
          <div><dt>稳定条目标识</dt><dd><code data-app-tooltip={entry.id}>{shortOid(entry.id)}</code></dd></div>
          <div><dt>当前显示位置</dt><dd>{entry.selector}</dd></div>
          <div><dt>当前目标分支</dt><dd>{snapshot?.branch || 'Detached HEAD'}</dd></div>
          <div><dt>创建时分支</dt><dd>{entry.branchContext || '未知'}</dd></div>
        </dl>
        <div className={`stash-manager-confirm__notice ${isDrop ? 'stash-manager-confirm__notice--danger' : ''}`}>
          {operation === 'apply' ? '内容将应用到当前工作区，原 Stash 会保留。' : null}
          {isPop ? '系统会先应用内容；只有应用成功且没有冲突时，才删除同一条 Stash。' : null}
          {isDrop ? '这只删除所选 Stash，不会应用其中内容。删除后无法通过本流程恢复。' : null}
        </div>
        {!isDrop && ((snapshot?.stagedFiles || 0) + (snapshot?.unstagedFiles || 0) + (snapshot?.untrackedFiles || 0)) > 0 ? (
          <p className="stash-manager-confirm__worktree-warning">当前工作区已有修改，恢复内容可能重叠并产生冲突。</p>
        ) : null}
        <footer>
          <button type="button" className="stash-manager-button" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className={`stash-manager-button ${isDrop ? 'stash-manager-button--danger' : 'stash-manager-button--primary'}`} disabled={busy} onClick={onConfirm}>
            {busy ? <><Spinner />处理中…</> : <><ConfirmActionIcon operation={operation} />确认{title}</>}
          </button>
        </footer>
        </section>
      </div>
      ) : null}
    </OverlayPortal>
  )
}
