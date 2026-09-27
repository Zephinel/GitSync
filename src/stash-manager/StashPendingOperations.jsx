import {
  pendingOperationOriginLabel,
  pendingStashOperationPermissions,
} from '../stashPendingOperation.js'
import { stashOperationLabel } from '../stashViewModel.js'

export default function StashPendingOperations({
  operations = [],
  total = operations.length,
  truncated = false,
  currentRepoPath = '',
  busy = false,
  hasSnapshotIdentity = false,
  onReconcile,
  onAcknowledge,
}) {
  const parsedTotal = Number(total)
  const normalizedTotal = Math.max(
    operations.length,
    Number.isFinite(parsedTotal) ? Math.max(0, Math.floor(parsedTotal)) : operations.length,
  )
  const hasHiddenOperations = Boolean(truncated || normalizedTotal > operations.length)
  if (normalizedTotal === 0) return null

  return (
    <section className="stash-manager-pending">
      <header>
        <div>
          <h3>需要确认的历史操作</h3>
          {hasHiddenOperations ? (
            <small>
              当前显示 {operations.length} / {normalizedTotal} 条，并优先包含当前 worktree 可处理的操作；其余操作会在后续快照中继续出现。
            </small>
          ) : null}
        </div>
        <span>{hasHiddenOperations ? `${operations.length} / ${normalizedTotal}` : normalizedTotal}</span>
      </header>
      {operations.length === 0 ? (
        <div className="stash-manager-pending__item">
          <div>
            <strong>待确认操作尚未投影</strong>
            <span>请刷新 Stash 状态后继续处理；在证据恢复前不会放开新的 Stash mutation。</span>
          </div>
        </div>
      ) : null}
      {operations.map((operation) => {
        const permission = pendingStashOperationPermissions(operation, currentRepoPath)
        const originLabel = pendingOperationOriginLabel(operation, currentRepoPath)
        return (
          <div className="stash-manager-pending__item" key={operation.requestId}>
            <div>
              <strong>{stashOperationLabel(operation.operation)}</strong>
              <span>{operation.message || '操作尚未得到明确终态。'}</span>
              <span>{originLabel}</span>
              <code>{operation.requestId}</code>
            </div>
            {permission.canReconcile ? (
              <button type="button" disabled={busy} onClick={() => onReconcile?.(operation.requestId)}>
                重新确认
              </button>
            ) : null}
            {permission.canAcknowledge && hasSnapshotIdentity ? (
              <button type="button" disabled={busy} onClick={() => onAcknowledge?.(operation.requestId)}>
                接受当前状态
              </button>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
