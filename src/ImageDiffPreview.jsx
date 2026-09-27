import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './ImageDiffPreview.css'

function getErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return error.message
  try { return JSON.stringify(error) } catch { return '未知错误' }
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function statusLabel(status) {
  switch (status) {
    case 'added': return '新增图片'
    case 'deleted': return '删除图片'
    case 'renamed': return '重命名图片'
    case 'copied': return '复制图片'
    case 'modified': return '图片已修改'
    case 'typechange': return '图片类型变更'
    case 'unmerged': return '图片存在冲突'
    default: return '图片 Diff'
  }
}

function sideMetadata(side, naturalSize) {
  const width = naturalSize?.width || side?.width
  const height = naturalSize?.height || side?.height
  const values = []
  if (width && height) values.push(`${width} × ${height}`)
  const bytes = formatBytes(side?.byte_size)
  if (bytes) values.push(bytes)
  if (side?.original_format) {
    values.push(side.converted ? `${side.original_format} → ${side.preview_format || 'PNG'}` : side.original_format)
  }
  return values.join(' · ')
}

function ImagePane({ side, fitMode, compact = false }) {
  const [decodeError, setDecodeError] = useState(false)
  const [naturalSize, setNaturalSize] = useState(null)

  useEffect(() => {
    setDecodeError(false)
    setNaturalSize(null)
  }, [side?.data_url])

  const metadata = sideMetadata(side, naturalSize)
  const paneClassName = [
    'image-diff-pane',
    compact ? 'image-diff-pane--compact' : '',
    fitMode === 'actual' ? 'image-diff-pane--actual' : 'image-diff-pane--fit',
  ].filter(Boolean).join(' ')

  return (
    <section className={paneClassName} aria-label={side?.source_label || '图片版本'}>
      <header className="image-diff-pane__header">
        <div>
          <strong>{side?.source_label || '图片版本'}</strong>
          <span data-app-tooltip={side?.path || ''}>{side?.path || '-'}</span>
        </div>
        {metadata ? <small>{metadata}</small> : null}
      </header>
      <div className="image-diff-pane__canvas">
        {decodeError ? (
          <div className="image-diff-pane__message image-diff-pane__message--error">
            <strong>当前系统无法解码该图片</strong>
            <span>{side?.original_format || side?.mime_type || '此格式'} 可能不受当前 WebView 支持。</span>
          </div>
        ) : (
          <img
            src={side?.data_url || ''}
            alt={`${side?.source_label || '图片版本'}：${side?.path || ''}`}
            draggable="false"
            onLoad={(event) => setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })}
            onError={() => setDecodeError(true)}
          />
        )}
      </div>
    </section>
  )
}

function getUnavailableCopy({ side, role, file, mode }) {
  if (side?.is_too_large) {
    return {
      header: side?.source_label || '图片版本',
      title: '图片过大，未生成预览',
      detail: side?.message || '该图片超过预览大小限制。',
    }
  }

  const isWorking = mode !== 'commit'
  if (role === 'before' && file?.status === 'added') {
    return {
      header: isWorking ? '新增前 · HEAD' : '新增前',
      title: '新增前没有此文件',
      detail: isWorking
        ? 'HEAD 中没有这个文件，右侧展示当前工作区新增的图片。'
        : '上一版本中没有这个文件，右侧展示本次提交新增的图片。',
    }
  }

  if (role === 'after' && file?.status === 'deleted') {
    return {
      header: isWorking ? '删除后 · 工作区' : '删除后',
      title: '删除后不再存在',
      detail: isWorking
        ? '当前工作区已经删除这个文件，左侧保留 HEAD 中的原图片。'
        : '本次提交已经删除这个文件，左侧保留上一版本中的原图片。',
    }
  }

  return {
    header: side?.source_label || '图片版本',
    title: '无法显示这个图片版本',
    detail: side?.message || '没有读取到对应的图片内容。',
  }
}

function UnavailableSide({ side, role, file, mode }) {
  const copy = getUnavailableCopy({ side, role, file, mode })
  return (
    <section className="image-diff-pane image-diff-pane--unavailable" aria-label={copy.header}>
      <header className="image-diff-pane__header">
        <div>
          <strong>{copy.header}</strong>
          <span data-app-tooltip={side?.path || ''}>{side?.path || '-'}</span>
        </div>
      </header>
      <div className="image-diff-pane__message">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </div>
    </section>
  )
}

function SwipeComparison({ before, after, position, setPosition, fitMode }) {
  const [beforeDecodeError, setBeforeDecodeError] = useState(false)
  const [afterDecodeError, setAfterDecodeError] = useState(false)

  useEffect(() => {
    setBeforeDecodeError(false)
    setAfterDecodeError(false)
  }, [before?.data_url, after?.data_url])

  if (beforeDecodeError || afterDecodeError) {
    return (
      <div className="image-diff-swipe image-diff-swipe--error">
        <div className="image-diff-pane__message image-diff-pane__message--error">
          <strong>滑动对比无法显示</strong>
          <span>其中一个图片版本不受当前系统 WebView 支持，请切换到并排视图查看详情。</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`image-diff-swipe ${fitMode === 'actual' ? 'image-diff-swipe--actual' : 'image-diff-swipe--fit'}`}
      style={{ '--image-diff-position': `${position}%` }}
    >
      <div className="image-diff-swipe__stage">
        <img className="image-diff-swipe__image image-diff-swipe__image--before" src={before.data_url} alt={`修改前：${before.path}`} draggable="false" onError={() => setBeforeDecodeError(true)} />
        <div className="image-diff-swipe__after-clip">
          <img className="image-diff-swipe__image image-diff-swipe__image--after" src={after.data_url} alt={`修改后：${after.path}`} draggable="false" onError={() => setAfterDecodeError(true)} />
        </div>
        <div className="image-diff-swipe__divider" aria-hidden="true"><span>↔</span></div>
        <span className="image-diff-swipe__label image-diff-swipe__label--before">{before.source_label}</span>
        <span className="image-diff-swipe__label image-diff-swipe__label--after">{after.source_label}</span>
      </div>
      <label className="image-diff-swipe__range">
        <span>对比位置</span>
        <input type="range" min="0" max="100" step="1" value={position} onChange={(event) => setPosition(Number(event.target.value))} />
        <output>{position}%</output>
      </label>
    </div>
  )
}

export default function ImageDiffPreview({ mode, repoPath, commitHash = '', file }) {
  const [requestVersion, setRequestVersion] = useState(0)
  const [state, setState] = useState({ loading: true, error: '', preview: null })
  const [compareMode, setCompareMode] = useState('side')
  const [position, setPosition] = useState(50)
  const [fitMode, setFitMode] = useState('fit')
  const scope = `${mode}:${repoPath}:${commitHash}:${file?.old_path || ''}:${file?.path || ''}:${requestVersion}`

  useEffect(() => {
    let disposed = false
    const normalizedMode = mode === 'commit' ? 'commit' : 'working'
    const command = normalizedMode === 'commit'
      ? 'get_repo_commit_image_diff_preview'
      : 'get_repo_working_image_diff_preview'
    const payload = {
      repoPath,
      path: file?.path || '',
      oldPath: file?.old_path || null,
      ...(normalizedMode === 'commit' ? { commitHash } : {}),
    }

    setState({ loading: true, error: '', preview: null })
    setCompareMode('side')
    setPosition(50)
    setFitMode('fit')

    if (!repoPath || !payload.path || (normalizedMode === 'commit' && !commitHash)) {
      setState({ loading: false, error: '缺少图片 Diff 所需的仓库、提交或文件信息。', preview: null })
      return () => { disposed = true }
    }

    void invoke(command, payload)
      .then((preview) => {
        if (!disposed) setState({ loading: false, error: '', preview })
      })
      .catch((error) => {
        if (!disposed) setState({ loading: false, error: getErrorMessage(error), preview: null })
      })

    return () => { disposed = true }
  }, [scope])

  const preview = state.preview
  const before = preview?.before || null
  const after = preview?.after || null
  const availableSides = useMemo(() => [before, after].filter((side) => side?.available), [after, before])
  const hasBoth = Boolean(before?.available && after?.available)

  if (state.loading) {
    return (
      <div className="commit-diff-viewer-state image-diff-loading" role="status" aria-live="polite">
        <div className="commit-diff-viewer-state__spinner" />
        <strong>正在生成图片 Diff...</strong>
        <span>按需读取修改前后的图片版本，并交由当前系统 WebView 解码显示。</span>
      </div>
    )
  }

  if (state.error) {
    return (
      <div className="commit-diff-viewer-state commit-diff-viewer-state--error" role="alert">
        <strong>图片 Diff 读取失败</strong>
        <span>{state.error}</span>
        <button type="button" onClick={() => setRequestVersion((value) => value + 1)}>重试</button>
      </div>
    )
  }

  if (!preview?.has_visual_diff || availableSides.length === 0) {
    return (
      <div className="commit-diff-viewer-state commit-diff-viewer-state--binary image-diff-unsupported">
        <strong>无法生成图片预览</strong>
        <span>{before?.message || after?.message || '该二进制文件不是受支持的图片，或两个版本都不存在。'}</span>
        <small>支持格式：{preview?.supported_formats || '常见图片格式'}</small>
      </div>
    )
  }

  return (
    <div className="image-diff" aria-label={statusLabel(file?.status)}>
      <div className="image-diff__toolbar">
        <div className="image-diff__title">
          <strong>{statusLabel(file?.status)}</strong>
          <span>{hasBoth ? '比较修改前后的视觉变化' : (after?.available ? '显示当前图片版本' : '显示删除前的图片版本')}</span>
        </div>
        <div className="image-diff__controls">
          {hasBoth ? (
            <div className="image-diff__segmented" role="group" aria-label="图片对比方式">
              <button type="button" className={compareMode === 'side' ? 'image-diff__segmented-active' : ''} onClick={() => setCompareMode('side')} aria-pressed={compareMode === 'side'}>并排</button>
              <button type="button" className={compareMode === 'swipe' ? 'image-diff__segmented-active' : ''} onClick={() => setCompareMode('swipe')} aria-pressed={compareMode === 'swipe'}>滑动</button>
            </div>
          ) : null}
          <button type="button" className="image-diff__fit-button" onClick={() => setFitMode((value) => value === 'fit' ? 'actual' : 'fit')}>
            {fitMode === 'fit' ? '实际尺寸' : '适应窗口'}
          </button>
        </div>
      </div>

      {hasBoth && compareMode === 'swipe' ? (
        <SwipeComparison before={before} after={after} position={position} setPosition={setPosition} fitMode={fitMode} />
      ) : hasBoth ? (
        <div className="image-diff__grid image-diff__grid--two">
          <ImagePane side={before} fitMode={fitMode} />
          <ImagePane side={after} fitMode={fitMode} />
        </div>
      ) : (
        <div className="image-diff__grid image-diff__grid--single">
          {before?.available ? <ImagePane side={before} fitMode={fitMode} /> : <UnavailableSide side={before} role="before" file={file} mode={mode} />}
          {after?.available ? <ImagePane side={after} fitMode={fitMode} /> : <UnavailableSide side={after} role="after" file={file} mode={mode} />}
        </div>
      )}
    </div>
  )
}
