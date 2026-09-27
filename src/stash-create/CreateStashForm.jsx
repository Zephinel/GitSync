import { stashResultTone } from '../stashViewModel.js'
import CanonicalCheckbox from '../CanonicalCheckbox.jsx'
import StashScopeResolutionPanel from '../StashScopeResolutionPanel.jsx'

function shortOid(value) {
  return String(value || '').slice(0, 12) || '—'
}

function Spinner() {
  return <span className="stash-manager-spinner" aria-hidden="true" />
}

export default function CreateStashForm({
  snapshot,
  result,
  scopeTitle,
  selectedScope,
  targets,
  selectedUntrackedCount,
  resolutionNotice,
  unsupported,
  resolutionBusy,
  resolutionError,
  confirmingUnstage,
  onSwitchAll,
  onRequestUnstage,
  onCancelUnstage,
  onConfirmUnstage,
  onClose,
  message,
  setMessage,
  includeUntracked,
  setIncludeUntracked,
  keepIndex,
  setKeepIndex,
  keepIndexAvailability,
  executable,
  blockedReason,
  confirming,
  setConfirming,
  busy,
  mutationLocked = false,
  onExecute,
}) {
  const controlsLocked = busy || resolutionBusy || mutationLocked

  return (
    <div className="create-stash-content">
      {result ? (
        <section className={`stash-manager-result stash-manager-result--${stashResultTone(result.status)}`} role="status">
          <div className="stash-manager-result__heading">
            <div>
              <strong>{result.message || 'Stash 结果已更新'}</strong>
              {result.createdStashId ? <span>新条目 OID：<code>{shortOid(result.createdStashId)}</code></span> : null}
            </div>
          </div>
          <div className="stash-manager-result__axes">
            {result.worktreeChanged ? <span>工作区已变化</span> : null}
            {result.stashRetained ? <span>原条目仍保留</span> : null}
            {result.needsConfirmation ? <span>结果需要确认</span> : null}
          </div>
          {result.warnings?.map((value, index) => <span key={`warning-${index}`}>{value}</span>)}
          {result.errors?.map((value, index) => <span key={`error-${index}`}>{value}</span>)}
        </section>
      ) : null}

      <div className="create-stash-summary">
        <span>当前分支 <strong>{snapshot.branch || 'Detached HEAD'}</strong></span>
        <span>当前提交 <code>{shortOid(snapshot.headHash)}</code></span>
        <span>范围 <strong>{scopeTitle}</strong></span>
      </div>

      {resolutionNotice ? <p className="create-stash-resolution-notice">{resolutionNotice}</p> : null}

      {unsupported ? (
        <StashScopeResolutionPanel
          summary={unsupported}
          busy={resolutionBusy || mutationLocked}
          error={resolutionError}
          confirmingUnstage={confirmingUnstage}
          onSwitchAll={onSwitchAll}
          onRequestUnstage={onRequestUnstage}
          onCancelUnstage={onCancelUnstage}
          onConfirmUnstage={onConfirmUnstage}
        />
      ) : null}

      {selectedScope ? (
        <div className="create-stash-files" aria-label="所选 Stash 文件">
          {targets.map((file, index) => (
            <div key={`${file.path}:${file.oldPath || ''}:${file.indexCode}:${file.worktreeCode}:${index}`}>
              <code>{file.path}</code>
              {file.oldPath ? <small>原路径：{file.oldPath}</small> : null}
              {file.isUntracked ? <small>未跟踪 · 选择行为本身即为本次授权</small> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="create-stash-counts">
          <span>已暂存 <strong>{snapshot.stagedFiles}</strong></span>
          <span>未暂存 <strong>{snapshot.unstagedFiles}</strong></span>
          <span>部分暂存 <strong>{snapshot.mixedFiles}</strong></span>
          <span>未跟踪 <strong>{snapshot.untrackedFiles}</strong></span>
        </div>
      )}

      <label className="stash-manager-field">
        <span>Stash 说明</span>
        <input
          type="text"
          value={message}
          maxLength={500}
          disabled={controlsLocked || confirming}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="可选"
        />
      </label>

      <div className="create-stash-options">
        {!selectedScope ? (
          <CanonicalCheckbox
            className="create-stash-option"
            checked={includeUntracked}
            disabled={controlsLocked || confirming}
            onChange={setIncludeUntracked}
            label="同时包含全部未跟踪文件"
          >
            <span><strong>同时包含全部未跟踪文件</strong><small>默认关闭；忽略文件始终不包含。</small></span>
          </CanonicalCheckbox>
        ) : selectedUntrackedCount > 0 ? (
          <p>所选范围包含 {selectedUntrackedCount} 个未跟踪文件；选择行为本身即为本次授权，不会包含其他未跟踪文件。</p>
        ) : null}

        <CanonicalCheckbox
          className={!keepIndexAvailability.available || mutationLocked ? 'create-stash-option create-stash-option--disabled' : 'create-stash-option'}
          checked={keepIndex}
          disabled={controlsLocked || confirming || !keepIndexAvailability.available}
          onChange={setKeepIndex}
          label="保留已暂存改动"
          inputProps={{ 'aria-describedby': 'create-stash-keep-index-help' }}
        >
          <span>
            <strong>保留已暂存改动 <em>高级</em></strong>
            <small id="create-stash-keep-index-help">{keepIndexAvailability.available
              ? '开启后只 Stash 未暂存部分；已暂存内容继续留在暂存区。'
              : keepIndexAvailability.reason}</small>
          </span>
        </CanonicalCheckbox>
      </div>

      {mutationLocked ? (
        <p className="create-stash-blocked">本次操作已经改变仓库，或结果仍需进一步确认。为防止把剩余文件再次 Stash，当前窗口已禁止重复创建；请关闭后在 Stash 管理中核对条目和工作区。</p>
      ) : !unsupported && !executable ? <p className="create-stash-blocked">{blockedReason}</p> : null}

      {confirming ? (
        <div className="create-stash-confirm" role="alert">
          <strong>确认创建 Stash</strong>
          <p>{selectedScope
            ? `只处理上方 ${targets.length} 个文件；未选择文件必须保持原状。`
            : '保存全部已跟踪改动；未跟踪文件按上方选项处理。'} {keepIndex
            ? '已暂存改动会继续留在暂存区，本次只保存未暂存部分。'
            : '已暂存和未暂存改动都会进入 Stash。'} 忽略文件始终不包含。</p>
          <div>
            <button type="button" className="stash-manager-button" disabled={busy} onClick={() => setConfirming(false)}>返回修改</button>
            <button type="button" className="stash-manager-button stash-manager-button--primary" disabled={busy || mutationLocked} onClick={onExecute}>
              {busy ? <><Spinner />处理中…</> : '确认创建'}
            </button>
          </div>
        </div>
      ) : (
        <footer className="create-stash-footer">
          <button type="button" className="stash-manager-button" disabled={busy || resolutionBusy} onClick={onClose}>取消</button>
          <button
            type="button"
            className="stash-manager-button stash-manager-button--primary"
            disabled={!executable || busy || resolutionBusy || mutationLocked || Boolean(unsupported)}
            onClick={() => setConfirming(true)}
          >
            检查并确认
          </button>
        </footer>
      )}
    </div>
  )
}
