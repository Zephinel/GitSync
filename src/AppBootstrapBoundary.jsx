import { Component, useCallback, useEffect, useState } from 'react'
import BootstrapLoadingMark from './illustrations/BootstrapLoadingMark.jsx'
import './AppBootstrapBoundary.css'

function BootstrapLoadingShell() {
  return (
    <div className="app-bootstrap-shell" aria-hidden="true">
      <div className="dashboard-loading">
        <div className="dashboard-loading__panel">
          <div className="dashboard-loading__header">
            <span className="dashboard-loading__mark">
              <BootstrapLoadingMark className="icon icon--md" />
            </span>
            <div className="dashboard-loading__copy">
              <div className="dashboard-loading__title">正在加载 GitSync</div>
              <div className="dashboard-loading__subtitle">正在读取仓库和本地状态…</div>
            </div>
          </div>
          <div className="dashboard-loading__preview">
            <div className="dashboard-loading__row dashboard-loading__row--primary">
              <span className="dashboard-loading__dot" />
              <span className="dashboard-loading__line dashboard-loading__line--wide" />
              <span className="dashboard-loading__pill" />
            </div>
            <div className="dashboard-loading__row">
              <span className="dashboard-loading__dot" />
              <span className="dashboard-loading__line dashboard-loading__line--medium" />
              <span className="dashboard-loading__pill" />
            </div>
            <div className="dashboard-loading__row">
              <span className="dashboard-loading__dot" />
              <span className="dashboard-loading__line dashboard-loading__line--short" />
              <span className="dashboard-loading__pill" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function BootstrapCommitSignal({ onCommit }) {
  useEffect(() => {
    onCommit()
  }, [onCommit])
  return null
}

class AppRuntimeErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[GitSync bootstrap] React runtime failed', error, info)
    this.props.onRuntimeError?.(error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const detail = error instanceof Error ? error.message : String(error || '未知错误')
    return (
      <div className="app-bootstrap-error" role="alert">
        <div className="app-bootstrap-error__panel">
          <strong>GitSync 界面加载失败</strong>
          <p>应用已经启动，但前端界面在初始化时发生错误。</p>
          <code>{detail}</code>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      </div>
    )
  }
}

export default function AppBootstrapBoundary({ children }) {
  const [bootstrapSettled, setBootstrapSettled] = useState(false)
  const settleBootstrap = useCallback(() => {
    setBootstrapSettled(true)
  }, [])

  return (
    <div className="app-bootstrap-root">
      {!bootstrapSettled ? <BootstrapLoadingShell /> : null}
      <AppRuntimeErrorBoundary onRuntimeError={settleBootstrap}>
        <>
          {children}
          <BootstrapCommitSignal onCommit={settleBootstrap} />
        </>
      </AppRuntimeErrorBoundary>
    </div>
  )
}
