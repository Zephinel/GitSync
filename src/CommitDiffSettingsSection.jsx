import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY,
  COMMIT_DIFF_SETTINGS_STORAGE_KEY,
  COMMIT_DIFF_VIEW_STYLE,
  COMMIT_DIFF_VIEW_STYLE_CHANGED_EVENT,
  normalizeCommitDiffViewStyle,
  readCommitDiffViewStyle,
  writeCommitDiffViewStyle,
} from './commitDiffSettings'
import { ensureCommitDiffSettingsMount, getCommitDiffSettingsObserverTarget } from './commitDiffSettingsSectionUtils'
import './SettingsSegmentedControls.css'

export default function CommitDiffSettingsSection() {
  const [mountNode, setMountNode] = useState(null)
  const [viewStyle, setViewStyle] = useState(readCommitDiffViewStyle)

  useEffect(() => {
    if (typeof document === 'undefined') return undefined

    let frameId = 0
    const updateMount = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        setMountNode(ensureCommitDiffSettingsMount())
      })
    }

    updateMount()
    const observerTarget = getCommitDiffSettingsObserverTarget()
    const observer = observerTarget ? new MutationObserver(updateMount) : null
    observer?.observe(observerTarget, { childList: true })

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      observer?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleStyleChange = (event) => {
      setViewStyle(normalizeCommitDiffViewStyle(event.detail?.commitDiffViewStyle))
    }
    const handleStorage = (event) => {
      if (event.key === COMMIT_DIFF_SETTINGS_STORAGE_KEY || event.key === COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY || event.key === null) {
        setViewStyle(readCommitDiffViewStyle())
      }
    }

    window.addEventListener(COMMIT_DIFF_VIEW_STYLE_CHANGED_EVENT, handleStyleChange)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(COMMIT_DIFF_VIEW_STYLE_CHANGED_EVENT, handleStyleChange)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const updateViewStyle = (nextStyle) => {
    setViewStyle(writeCommitDiffViewStyle(nextStyle))
  }

  if (!mountNode) return null

  return createPortal((
    <div className="settings__row commit-diff-settings-row">
      <div className="settings__label">
        默认 Diff 样式
        <small>查看提交文件改动时默认使用的渲染方式；窄屏下分栏视图会自动退回统一视图。</small>
      </div>
      <div className="mode-btn-group" role="group" aria-label="默认 Diff 样式">
        <button
          className={`mode-btn ${viewStyle === COMMIT_DIFF_VIEW_STYLE.unified ? 'mode-btn--active' : ''}`}
          onClick={() => updateViewStyle(COMMIT_DIFF_VIEW_STYLE.unified)}
          aria-pressed={viewStyle === COMMIT_DIFF_VIEW_STYLE.unified}
          type="button"
        >
          统一视图
        </button>
        <button
          className={`mode-btn ${viewStyle === COMMIT_DIFF_VIEW_STYLE.split ? 'mode-btn--active' : ''}`}
          onClick={() => updateViewStyle(COMMIT_DIFF_VIEW_STYLE.split)}
          aria-pressed={viewStyle === COMMIT_DIFF_VIEW_STYLE.split}
          type="button"
        >
          分栏视图
        </button>
      </div>
    </div>
  ), mountNode)
}
