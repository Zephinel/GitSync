import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'

export function ImportEntryMenu({
  Icons,
  anchor,
  disabled,
  githubAccount,
  onClose,
  onImportLocal,
  onCloneRepo,
  onGithubRepos,
}) {
  const menuRef = useRef(null)
  const [position, setPosition] = useState(null)

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null)
      return
    }

    const menuElement = menuRef.current
    if (!menuElement) return

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
    const menuRect = menuElement.getBoundingClientRect()
    const menuWidth = menuRect.width || 0
    const menuHeight = menuRect.height || 0
    const margin = 12
    const gap = 8

    const minLeft = margin
    const maxLeft = Math.max(minLeft, viewportWidth - menuWidth - margin)
    const anchorRight = Number(anchor.right || 0)
    const anchorLeft = Number(anchor.left || 0)
    const preferredLeft = anchorRight > 0
      ? anchorRight - menuWidth
      : anchorLeft
    const left = Math.min(maxLeft, Math.max(minLeft, preferredLeft))

    const spaceBelow = Math.max(0, viewportHeight - anchor.bottom - gap - margin)
    const spaceAbove = Math.max(0, anchor.top - gap - margin)
    const placeBelow = spaceBelow >= spaceAbove

    let top = placeBelow
      ? anchor.bottom + gap
      : Math.max(margin, anchor.top - gap - menuHeight)
    let maxHeight = placeBelow ? spaceBelow : spaceAbove

    if (maxHeight <= 0) {
      top = margin
      maxHeight = Math.max(120, viewportHeight - margin * 2)
    }

    setPosition({
      left: Math.round(left),
      top: Math.round(top),
      maxHeight: Math.floor(maxHeight),
    })
  }, [anchor])

  if (!anchor) return null

  return (
    <div className="import-entry-menu-layer" onClick={onClose}>
      <div
        ref={menuRef}
        className={`import-entry-menu ${position ? 'import-entry-menu--ready' : ''}`}
        style={position
          ? {
            top: `${position.top}px`,
            left: `${position.left}px`,
            maxHeight: `${position.maxHeight}px`,
          }
          : undefined}
        role="menu"
        aria-label="选择仓库导入方式"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="import-entry-menu__item"
          role="menuitem"
          onClick={onImportLocal}
          disabled={disabled}
        >
          <Icons.folder className="icon icon--sm" />
          <div className="import-entry-menu__item-main">
            <span className="import-entry-menu__item-title">本地导入</span>
            <span className="import-entry-menu__item-desc">从本机选择一个或多个 Git 仓库目录</span>
          </div>
        </button>
        <button
          className="import-entry-menu__item"
          role="menuitem"
          onClick={onCloneRepo}
          disabled={disabled}
        >
          <Icons.cloneRepo className="icon icon--sm" />
          <div className="import-entry-menu__item-main">
            <span className="import-entry-menu__item-title">克隆仓库</span>
            <span className="import-entry-menu__item-desc">输入远程地址并克隆到指定本地目录</span>
          </div>
        </button>
        <button
          className="import-entry-menu__item"
          role="menuitem"
          onClick={onGithubRepos}
          disabled={disabled}
        >
          <Icons.github className="icon icon--sm" />
          <div className="import-entry-menu__item-main">
            <span className="import-entry-menu__item-title">
              GitHub 仓库
            </span>
            <span className="import-entry-menu__item-desc">
              {githubAccount ? '浏览账号仓库并批量克隆' : '需先在设置中登录 GitHub'}
            </span>
          </div>
        </button>
      </div>
    </div>
  )
}

export function CloneRepoDialog({
  Icons,
  getErrorMessage,
  initialLocalPath = '',
  cloning = false,
  onCancel,
  onConfirm,
}) {
  const [repoUrl, setRepoUrl] = useState('')
  const [localPath, setLocalPath] = useState(initialLocalPath)
  const [errorText, setErrorText] = useState('')

  useEffect(() => {
    setLocalPath(String(initialLocalPath || '').trim())
  }, [initialLocalPath])

  const pickLocalPath = async () => {
    if (cloning) return
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择克隆仓库存放目录',
      })
      if (!selected) return
      const nextPath = Array.isArray(selected) ? selected[0] : selected
      setLocalPath(String(nextPath || '').trim())
      setErrorText('')
    } catch (error) {
      setErrorText(getErrorMessage(error))
    }
  }

  const submitClone = async () => {
    if (cloning) return
    const normalizedRepoUrl = String(repoUrl || '').trim()
    const normalizedLocalPath = String(localPath || '').trim()
    if (!normalizedRepoUrl) {
      setErrorText('请输入仓库地址')
      return
    }
    if (!normalizedLocalPath) {
      setErrorText('请输入本地保存路径')
      return
    }

    setErrorText('')
    try {
      const result = await onConfirm?.({
        repoUrl: normalizedRepoUrl,
        localPath: normalizedLocalPath,
      })
      if (!result?.success) {
        setErrorText(result?.message || '克隆失败，请稍后重试')
      }
    } catch (error) {
      setErrorText(getErrorMessage(error))
    }
  }

  const handleCancel = () => {
    if (cloning) return
    onCancel?.()
  }

  const handleKeyDown = (event) => {
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.isComposing) return
    event.preventDefault()
    void submitClone()
  }

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={handleCancel}>
      <div data-overlay-motion="surface" className="clone-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="clone-dialog__header">
          <div className="clone-dialog__icon">
            <Icons.cloneRepo className="icon icon--warning" />
          </div>
          <div>
            <div className="clone-dialog__title">克隆仓库</div>
            <div className="clone-dialog__subtitle">输入远程地址并选择本地保存路径，完成后会自动导入到列表。</div>
          </div>
        </div>

        <div className="clone-dialog__body">
          <label className="clone-dialog__field">
            <span className="clone-dialog__label">仓库地址</span>
            <input
              className="clone-dialog__input"
              value={repoUrl}
              placeholder="例如：https://github.com/owner/repo.git"
              onChange={(event) => setRepoUrl(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={cloning}
            />
          </label>

          <label className="clone-dialog__field">
            <span className="clone-dialog__label">本地保存路径</span>
            <div className="clone-dialog__path-row">
              <input
                className="clone-dialog__input"
                value={localPath}
                placeholder="请选择本地目录（将自动在该目录下创建仓库文件夹）"
                onChange={(event) => setLocalPath(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={cloning}
              />
              <button
                className="clone-dialog__pick-btn"
                onClick={pickLocalPath}
                disabled={cloning}
              >
                选择目录
              </button>
            </div>
          </label>

          {errorText ? (
            <div className="clone-dialog__error" role="alert">
              <Icons.warning className="icon icon--xs" />
              <span>{errorText}</span>
            </div>
          ) : null}
        </div>

        <div className="clone-dialog__footer">
          <button className="dialog-btn" onClick={handleCancel} disabled={cloning}>
            取消
          </button>
          <button className="dialog-btn dialog-btn--primary" onClick={submitClone} disabled={cloning}>
            {cloning ? (
              <><span className="spinning"><Icons.sync className="icon icon--sm" /></span> 克隆中...</>
            ) : (
              <>开始克隆</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
