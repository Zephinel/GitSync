function formatDownloadProgress(downloadedBytes, contentLength) {
  if (!contentLength) return '正在下载更新…'
  const percent = Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
  return `正在下载更新… ${percent}%`
}

export function AppUpdateDialog({
  version,
  notes,
  status,
  downloadedBytes = 0,
  contentLength = 0,
  error = '',
  onDismiss,
  onInstall,
}) {
  const isReady = status === 'ready'
  const isPreparing = status === 'preparing'
  const isInstalling = status === 'installing'
  const isRestartRequired = status === 'restartRequired'
  const isRelaunching = status === 'relaunching'
  const isBusy = isPreparing || isInstalling || isRelaunching
  const progressText = formatDownloadProgress(downloadedBytes, contentLength)
  const message = isPreparing
    ? '正在确认没有进行中的 Git 操作，并准备安装更新…'
    : isInstalling
      ? '正在安装更新。请勿退出 GitSync。'
      : isRelaunching
        ? '更新已安装，正在重新启动 GitSync。'
        : isRestartRequired
          ? '更新已安装，但 GitSync 未能自动重新启动。请点击重新启动，或手动退出后重新打开 GitSync。'
          : isReady
            ? '更新已下载。点击「现在重启并安装」后，GitSync 会安装更新并重新启动。检测到 Git 操作时会阻止安装。'
            : progressText
  const title = isPreparing
    ? '正在准备 GitSync 更新'
    : isReady
      ? '更新已准备好'
      : isInstalling
        ? '正在安装 GitSync 更新'
        : isRestartRequired
          ? '更新已安装'
          : isRelaunching
            ? '正在重新启动 GitSync'
            : '正在获取 GitSync 更新'

  return (
    <div
      data-overlay-motion="backdrop"
      className="modal-overlay"
      onClick={isBusy ? undefined : onDismiss}
    >
      <div
        data-overlay-motion="surface"
        className="notice-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="notice-dialog__header">
          <div id="app-update-dialog-title" className="notice-dialog__title">
            {title}
          </div>
        </div>
        <div className="notice-dialog__body">
          <pre className="notice-dialog__message" aria-live="polite">
            {`新版本：${version || '未知'}\n${message}${error ? `\n\n${error}` : ''}${notes ? `\n\n更新说明：\n${notes}` : ''}`}
          </pre>
        </div>
        <div className="notice-dialog__footer">
          {!isBusy ? (
            <button className="dialog-btn" onClick={onDismiss}>稍后</button>
          ) : null}
          {isReady || isRestartRequired ? (
            <button className="dialog-btn dialog-btn--primary" onClick={onInstall}>
              {isRestartRequired ? '重新启动 GitSync' : '现在重启并安装'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
