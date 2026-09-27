import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { CommitDiffLoadingCard } from './CommitDiffLoadingCard.jsx'
import CommitDiffSettingsSection from './CommitDiffSettingsSection.jsx'
import ImageFileGlyphProjection from './ImageFileGlyphProjection.jsx'
import { COMMIT_DIFF_OPEN_EVENT } from './events'
import { normalizeCommitDiffViewStyle, readCommitDiffViewStyle } from './commitDiffSettings'
import './CommitDiffView.css'
import './CommitDiffRendered.css'
import './CommitDiffScrollbars.css'
import './CommitDiffPolish.css'
import './CommitDiffFinal.css'
import './CommitDiffSplit.css'
import './CommitDiffHeaderLayout.css'
import './CommitDiffFileListShared.css'
import './ImageDiffSwipeFix.css'
import './WorkingChangesImagePreviewLayer.css'
import './CommitDiffViewportLayout.css'

const loadCommitDiffView = () => import('./CommitDiffView.jsx')
const CommitDiffView = lazy(loadCommitDiffView)

function normalizeCommitDiffPayload(payload) {
  const repoPath = String(payload?.repoPath || '').trim()
  const commitHash = String(payload?.commit?.hash || payload?.commitHash || '').trim()
  if (!repoPath || !commitHash) return null

  return {
    repoName: String(payload?.repoName || '未知仓库').trim() || '未知仓库',
    repoPath,
    branchName: String(payload?.branchName || '').trim(),
    commitDiffViewStyle: normalizeCommitDiffViewStyle(payload?.commitDiffViewStyle || payload?.diffViewStyle || readCommitDiffViewStyle()),
    commit: {
      hash: commitHash,
      message: String(payload?.commit?.message || payload?.message || '暂无提交信息').trim() || '暂无提交信息',
      author: String(payload?.commit?.author || payload?.author || '').trim(),
      date: String(payload?.commit?.date || payload?.date || '').trim(),
    },
  }
}

export default function CommitDiffLayer({ children }) {
  const [commitDiffData, setCommitDiffData] = useState(null)

  const openCommitDiff = useCallback((payload) => {
    const normalized = normalizeCommitDiffPayload(payload)
    if (!normalized) return

    setCommitDiffData({
      ...normalized,
      id: `${normalized.repoPath}:${normalized.commit.hash}:${Date.now()}`,
    })
  }, [])

  const closeCommitDiff = useCallback(() => {
    setCommitDiffData(null)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleOpenEvent = (event) => {
      openCommitDiff(event.detail)
    }

    window.addEventListener(COMMIT_DIFF_OPEN_EVENT, handleOpenEvent)
    return () => window.removeEventListener(COMMIT_DIFF_OPEN_EVENT, handleOpenEvent)
  }, [openCommitDiff])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const preload = () => {
      void loadCommitDiffView()
    }

    if (typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(preload, { timeout: 2000 })
      return () => window.cancelIdleCallback?.(idleId)
    }

    const timerId = window.setTimeout(preload, 600)
    return () => window.clearTimeout(timerId)
  }, [])

  return (
    <>
      {children}
      <CommitDiffSettingsSection />
      <ImageFileGlyphProjection />
      {commitDiffData ? (
        <Suspense fallback={<CommitDiffLoadingCard data={commitDiffData} onClose={closeCommitDiff} />}>
          <CommitDiffView data={commitDiffData} onClose={closeCommitDiff} />
        </Suspense>
      ) : null}
    </>
  )
}