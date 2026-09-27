import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import WorkingChangesView from './WorkingChangesView.jsx'
import { REPO_WORKING_CHANGES_CHANGED_EVENT } from './events'
import './CommitDiffFileListShared.css'

const CALLOUT_SELECTOR = '.repo-card__state-callout--warning'
const ACTION_CLASS = 'repo-card__working-changes-action'
const WORKING_CHANGES_CONTEXT_EVENT = 'gitsync:working-changes-context'
const WORKING_CHANGES_CONTEXT_KEY = '__gitsyncWorkingChangesContext'
const WORKING_CHANGES_SUMMARY_KEY = '__gitsyncWorkingChangesSummaryByPath'
const WORKING_CHANGES_COUNT_CACHE_TTL_MS = 4000

const workingChangesCountCache = new Map()
const workingChangesCountRequests = new Map()

function normalizeRepoName(value) {
  return String(value || '').replace(/^✓\s*/, '').trim() || '当前仓库'
}

function isWorkingChangesCallout(callout) {
  if (!(callout instanceof HTMLElement)) return false
  const text = callout.querySelector('.repo-card__state-callout-text')?.textContent || callout.textContent || ''
  return /未提交改动/.test(text)
}

function createActionButton() {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = ACTION_CLASS
  button.textContent = '查看详情'
  button.title = '查看当前未提交改动'
  button.setAttribute('aria-label', '查看当前未提交改动详情')
  return button
}

function readRepoCardContext(element) {
  const repoCard = element?.closest?.('.repo-card')
  if (!(repoCard instanceof HTMLElement)) return null
  const repoPath = repoCard.querySelector('.repo-card__path-text')?.textContent?.trim() || ''
  if (!repoPath) return null
  const branchName = repoCard.querySelector('.repo-card__branch-meta .meta-value')?.textContent?.trim() || ''
  return {
    repoId: repoCard.getAttribute('data-repo-card-id') || '',
    repoName: normalizeRepoName(repoCard.querySelector('.repo-card__name')?.textContent),
    repoPath,
    branchName,
  }
}

function normalizeWorkingChangesCount(summary) {
  const explicitCount = Number(summary?.files_changed ?? summary?.filesChanged)
  if (Number.isFinite(explicitCount) && explicitCount >= 0) return Math.floor(explicitCount)
  return Array.isArray(summary?.files) ? summary.files.length : null
}

function workingSummaryStore() {
  if (typeof window === 'undefined') return null
  if (!window[WORKING_CHANGES_SUMMARY_KEY]) window[WORKING_CHANGES_SUMMARY_KEY] = {}
  return window[WORKING_CHANGES_SUMMARY_KEY]
}

function cacheWorkingSummary(repoPath, summary) {
  const store = workingSummaryStore()
  const normalizedPath = String(repoPath || '').trim()
  if (!store || !normalizedPath || !summary) return
  store[normalizedPath] = summary
}

function invalidateWorkingChangesCount(repoPath = '') {
  const normalizedPath = String(repoPath || '').trim()
  const store = workingSummaryStore()
  if (normalizedPath) {
    workingChangesCountCache.delete(normalizedPath)
    if (store) delete store[normalizedPath]
  } else {
    workingChangesCountCache.clear()
    if (store) Object.keys(store).forEach((key) => delete store[key])
  }
}

async function readExactWorkingChangesCount(repoPath) {
  const normalizedPath = String(repoPath || '').trim()
  if (!normalizedPath) return null

  const cached = workingChangesCountCache.get(normalizedPath)
  if (cached && Date.now() - cached.updatedAt < WORKING_CHANGES_COUNT_CACHE_TTL_MS) {
    return cached.count
  }

  const existingRequest = workingChangesCountRequests.get(normalizedPath)
  if (existingRequest) return existingRequest

  const request = invoke('get_repo_working_diff_summary', { repoPath: normalizedPath })
    .then((summary) => {
      cacheWorkingSummary(normalizedPath, summary)
      const count = normalizeWorkingChangesCount(summary)
      if (count !== null) workingChangesCountCache.set(normalizedPath, { count, updatedAt: Date.now() })
      return count
    })
    .catch(() => null)
    .finally(() => {
      workingChangesCountRequests.delete(normalizedPath)
    })

  workingChangesCountRequests.set(normalizedPath, request)
  return request
}

function syncExactWorkingChangesCount(callout) {
  const context = readRepoCardContext(callout)
  if (!context) return

  void readExactWorkingChangesCount(context.repoPath).then((count) => {
    if (!callout.isConnected || !isWorkingChangesCallout(callout) || !Number.isFinite(count) || count <= 0) return
    const textElement = callout.querySelector('.repo-card__state-callout-text')
    if (!(textElement instanceof HTMLElement)) return
    const nextText = `本地有 ${count} 个未提交改动`
    if (textElement.textContent !== nextText) textElement.textContent = nextText
  })
}

function syncActionButtons() {
  document.querySelectorAll(CALLOUT_SELECTOR).forEach((callout) => {
    const existing = callout.querySelector(`:scope > .${ACTION_CLASS}`)
    if (isWorkingChangesCallout(callout)) {
      if (!existing) callout.appendChild(createActionButton())
      syncExactWorkingChangesCount(callout)
    } else if (existing) {
      existing.remove()
    }
  })

  document.querySelectorAll(`.${ACTION_CLASS}`).forEach((button) => {
    const callout = button.closest(CALLOUT_SELECTOR)
    if (!callout || !isWorkingChangesCallout(callout)) button.remove()
  })
}

function publishWorkingChangesContext(context) {
  if (typeof window === 'undefined') return
  window[WORKING_CHANGES_CONTEXT_KEY] = context || null
  window.dispatchEvent(new CustomEvent(WORKING_CHANGES_CONTEXT_EVENT, {
    detail: context || null,
  }))
}

export default function WorkingChangesLayer() {
  const [activeContext, setActiveContext] = useState(null)
  const [present, setPresent] = useState(false)

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    let frame = 0
    const scheduleScan = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        syncActionButtons()
      })
    }
    const observer = new MutationObserver(scheduleScan)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    const handleClick = (event) => {
      const button = event.target?.closest?.(`.${ACTION_CLASS}`)
      if (!button) return
      event.preventDefault()
      event.stopPropagation()
      const context = readRepoCardContext(button)
      if (context) {
        setActiveContext(context)
        setPresent(true)
      }
    }

    const handleFocus = () => {
      invalidateWorkingChangesCount()
      scheduleScan()
    }

    document.addEventListener('click', handleClick, true)
    window.addEventListener('focus', handleFocus)
    scheduleScan()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('click', handleClick, true)
      window.removeEventListener('focus', handleFocus)
      invalidateWorkingChangesCount()
      workingChangesCountRequests.clear()
    }
  }, [])

  useEffect(() => {
    publishWorkingChangesContext(activeContext)
    return () => {
      if (activeContext) publishWorkingChangesContext(null)
    }
  }, [activeContext])

  const handleChanged = useCallback(async () => {
    const context = activeContext
    if (!context) return
    invalidateWorkingChangesCount(context.repoPath)
    if (context.repoId) {
      try {
        await invoke('refresh_repo_git_metadata', { repoId: context.repoId })
      } catch {
        // The status refresh event below still reconciles the dashboard card for this repo.
      }
      window.dispatchEvent(new CustomEvent(REPO_WORKING_CHANGES_CHANGED_EVENT, {
        detail: { repoId: context.repoId, repoPath: context.repoPath },
      }))
    }
    window.dispatchEvent(new Event('focus'))
  }, [activeContext])

  return activeContext ? (
    <WorkingChangesView
      data={activeContext}
      present={present}
      onClose={() => setPresent(false)}
      onExitComplete={() => setActiveContext(null)}
      onChanged={handleChanged}
    />
  ) : null
}
