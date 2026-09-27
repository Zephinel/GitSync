import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { isGithubRepoAlreadyAdded } from './githubRepoVisibility'

const GITHUB_REPOS_PAGE_SIZE = 100
const GITHUB_CLONE_CONCURRENCY = 3
const GITHUB_REPO_VISIBILITY_OPTIONS = [
  { value: 'all', label: '可视性: 全部' },
  { value: 'public', label: '公开' },
  { value: 'private', label: '私有' },
]
const GITHUB_REPO_SORT_OPTIONS = [
  { value: 'updated-desc', label: '最近更新' },
  { value: 'updated-asc', label: '最早更新' },
  { value: 'created-desc', label: '最新创建' },
  { value: 'created-asc', label: '最早创建' },
]

function getGithubRepoSortConfig(value) {
  switch (value) {
    case 'updated-asc':
      return { sort: 'updated', direction: 'asc' }
    case 'created-desc':
      return { sort: 'created', direction: 'desc' }
    case 'created-asc':
      return { sort: 'created', direction: 'asc' }
    case 'updated-desc':
    default:
      return { sort: 'updated', direction: 'desc' }
  }
}

function getGithubRepoLanguageKey(repo) {
  return String(repo?.language || '').trim().toLowerCase()
}

function formatGithubRepoDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleDateString('zh-CN')
}

function getGithubRepoSearchText(repo) {
  return [
    repo?.full_name,
    repo?.name,
    repo?.description,
    repo?.language,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function getCloneProgressLabel(progress) {
  if (!progress) return '等待中'
  if (progress.state === 'pending') return '等待中'
  if (progress.state === 'cloning') return '克隆中...'
  if (progress.state === 'canceling') return '取消中...'
  if (progress.state === 'canceled') return '已取消'
  if (progress.state === 'done') return progress.warning ? '完成（含警告）' : '完成'
  if (progress.state === 'error') return '失败'
  return '等待中'
}

function isCloneProgressCancelable(progress) {
  return progress?.state === 'pending' || progress?.state === 'cloning'
}

function createGithubCloneTaskId(repo) {
  const repoKey = String(repo?.id || repo?.name || 'repo').replace(/[^a-zA-Z0-9_-]/g, '')
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `github-clone-${repoKey}-${crypto.randomUUID()}`
  }
  return `github-clone-${repoKey}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getGithubCloneTargetKey(repo) {
  const targetName = String(repo?.name || repo?.full_name || repo?.id || '').trim().toLowerCase()
  return targetName || String(repo?.id || 'repo')
}

function groupGithubCloneTasksByTargetName(tasks) {
  const groupsByName = new Map()
  for (const task of tasks) {
    const key = getGithubCloneTargetKey(task.repo)
    if (!groupsByName.has(key)) groupsByName.set(key, [])
    groupsByName.get(key).push(task)
  }
  return Array.from(groupsByName.values())
}

function mergeGithubRepos(previousRepos, incomingRepos) {
  const nextMap = new Map()
  for (const repo of previousRepos) {
    if (!repo?.id) continue
    nextMap.set(repo.id, repo)
  }
  for (const repo of incomingRepos) {
    if (!repo?.id) continue
    nextMap.set(repo.id, repo)
  }
  return Array.from(nextMap.values())
}

function GithubRepoFilterSelect({
  Icons,
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  disabled = false,
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const selectedOption = options.find((option) => option.value === value) || options[0] || null

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const handleSelect = (nextValue) => {
    setOpen(false)
    if (nextValue !== value) {
      onChange(nextValue)
    }
  }

  return (
    <div className={`github-repo-browser__select custom-select ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className={`custom-select__trigger ${open ? 'custom-select__trigger--open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="custom-select__label">{selectedOption?.label || '-'}</span>
        <Icons.arrowDown className={`icon icon--xs custom-select__arrow ${open ? 'custom-select__arrow--open' : ''}`} />
      </button>

      {open && !disabled ? (
        <div className="custom-select__menu github-repo-browser__select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`custom-select__option ${option.value === value ? 'custom-select__option--active' : ''}`}
              onClick={() => handleSelect(option.value)}
              role="option"
              aria-selected={option.value === value}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function GithubRepoBrowserDialog({
  Icons,
  getErrorMessage,
  existingRepoKeys,
  existingRepoNameKeys,
  initialHideExisting = false,
  initialLocalPath = '',
  busy = false,
  onClose,
  onCloneRepo,
  onCancelCloneRepo,
  onBatchCloneComplete,
  onAuthExpired,
}) {
  const [repos, setRepos] = useState([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [visibilityFilter, setVisibilityFilter] = useState('all')
  const [languageFilter, setLanguageFilter] = useState('all')
  const [sortValue, setSortValue] = useState('updated-desc')
  const [hideExisting, setHideExisting] = useState(Boolean(initialHideExisting))
  const [clonePanelOpen, setClonePanelOpen] = useState(false)
  const [clonePath, setClonePath] = useState(String(initialLocalPath || '').trim())
  const [cloneProgress, setCloneProgress] = useState({})
  const [cloneTargets, setCloneTargets] = useState([])
  const [cloneError, setCloneError] = useState('')
  const [cloning, setCloning] = useState(false)
  const [batchResult, setBatchResult] = useState(null)
  const loadingRef = useRef(false)
  const queryKeyRef = useRef('')
  const cloneRunIdRef = useRef(0)
  const cloneCancelRequestedRepoIdsRef = useRef(new Set())
  const activeCloneTaskIdsRef = useRef(new Map())
  const existingKeySet = existingRepoKeys instanceof Set ? existingRepoKeys : new Set()
  const existingNameKeySet = existingRepoNameKeys instanceof Set ? existingRepoNameKeys : new Set()
  const sortConfig = useMemo(() => getGithubRepoSortConfig(sortValue), [sortValue])

  const isRepoExisting = useCallback(
    (repo) => isGithubRepoAlreadyAdded(repo, existingKeySet, existingNameKeySet),
    [existingKeySet, existingNameKeySet]
  )

  // One authority for ending a clone run. Every place that changes the target set or
  // reopens the panel calls this, so a per-repo outcome can never survive the run it
  // belongs to (previously each site reset a different subset of the run state).
  const resetCloneRun = useCallback(() => {
    setCloneProgress({})
    setCloneTargets([])
    setBatchResult(null)
    setCloneError('')
  }, [])

  const loadReposPage = useCallback(async (targetPage, replace = false) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    setLoadError('')

    try {
      const nextRepos = await invoke('github_get_repos', {
        page: targetPage,
        visibility: visibilityFilter,
        sort: sortConfig.sort,
        direction: sortConfig.direction,
      })
      const repoList = Array.isArray(nextRepos) ? nextRepos : []
      setRepos((prev) => (replace ? mergeGithubRepos([], repoList) : mergeGithubRepos(prev, repoList)))
      setPage(targetPage + 1)
      setHasMore(repoList.length >= GITHUB_REPOS_PAGE_SIZE)
    } catch (error) {
      const message = getErrorMessage(error)
      setLoadError(message)
      if (message.includes('登录已过期')) {
        onAuthExpired?.()
      }
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [getErrorMessage, onAuthExpired, sortConfig.direction, sortConfig.sort, visibilityFilter])

  useEffect(() => {
    const queryKey = `${visibilityFilter}:${sortValue}`
    if (queryKeyRef.current === queryKey) return
    queryKeyRef.current = queryKey
    setRepos([])
    setPage(1)
    setHasMore(true)
    setLoadError('')
    setSelectedIds(new Set())
    setLanguageFilter('all')
    setClonePanelOpen(false)
    resetCloneRun()
    void loadReposPage(1, true)
  }, [loadReposPage, sortValue, visibilityFilter])

  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set()
      for (const id of prev) {
        const repo = repos.find((item) => item.id === id)
        if (repo && !isRepoExisting(repo)) next.add(id)
      }
      return next.size === prev.size ? prev : next
    })
  }, [isRepoExisting, repos])

  const normalizedSearch = search.trim().toLowerCase()
  const languageOptions = useMemo(() => {
    const languagesByKey = new Map()
    for (const repo of repos) {
      const language = String(repo?.language || '').trim()
      if (!language) continue
      const key = language.toLowerCase()
      if (!languagesByKey.has(key)) {
        languagesByKey.set(key, language)
      }
    }

    return [
      { value: 'all', label: '语言: 全部' },
      ...Array.from(languagesByKey.entries())
        .sort(([, a], [, b]) => a.localeCompare(b, 'zh-CN', { sensitivity: 'base' }))
        .map(([value, label]) => ({ value, label })),
    ]
  }, [repos])

  useEffect(() => {
    if (languageFilter === 'all' || repos.length === 0) return
    if (!languageOptions.some((option) => option.value === languageFilter)) {
      setLanguageFilter('all')
    }
  }, [languageFilter, languageOptions, repos.length])

  const searchMatchedRepos = useMemo(() => {
    if (!normalizedSearch) return repos
    return repos.filter((repo) => getGithubRepoSearchText(repo).includes(normalizedSearch))
  }, [normalizedSearch, repos])

  const filterMatchedRepos = useMemo(() => {
    if (languageFilter === 'all') return searchMatchedRepos
    return searchMatchedRepos.filter((repo) => getGithubRepoLanguageKey(repo) === languageFilter)
  }, [languageFilter, searchMatchedRepos])

  const hiddenExistingCount = useMemo(
    () => filterMatchedRepos.filter((repo) => isRepoExisting(repo)).length,
    [filterMatchedRepos, isRepoExisting]
  )

  const visibleRepos = useMemo(
    () => filterMatchedRepos.filter((repo) => !hideExisting || !isRepoExisting(repo)),
    [filterMatchedRepos, hideExisting, isRepoExisting]
  )

  const selectedRepos = useMemo(
    () => repos.filter((repo) => selectedIds.has(repo.id) && !isRepoExisting(repo)),
    [isRepoExisting, repos, selectedIds]
  )
  const cloneDisplayRepos = cloneTargets.length > 0 ? cloneTargets : selectedRepos

  const selectedCount = selectedRepos.length
  const canStartClone = selectedCount > 0 && clonePath.trim() && !cloning && !busy

  const toggleSelect = (repo) => {
    if (cloning || isRepoExisting(repo)) return
    // Changing the target set invalidates the previous run's outcomes for every repo.
    resetCloneRun()
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(repo.id)) {
        next.delete(repo.id)
      } else {
        next.add(repo.id)
      }
      return next
    })
  }

  const pickClonePath = async () => {
    if (cloning) return
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择 GitHub 仓库存放目录',
      })
      if (!selected) return
      const nextPath = Array.isArray(selected) ? selected[0] : selected
      setClonePath(String(nextPath || '').trim())
      setCloneError('')
    } catch (error) {
      setCloneError(getErrorMessage(error))
    }
  }

  const openClonePanel = () => {
    if (selectedCount === 0 || busy || cloning) return
    setClonePanelOpen(true)
    resetCloneRun()
  }

  const openRemoteRepo = async (event, repo) => {
    event.stopPropagation()
    const url = String(repo?.html_url || '').trim()
    if (!url) return
    try {
      await openUrl(url)
    } catch (error) {
      setLoadError(`打开远程仓库失败：${getErrorMessage(error)}`)
    }
  }

  const requestCancelClone = async (repoId) => {
    const normalizedRepoId = Number(repoId)
    cloneCancelRequestedRepoIdsRef.current.add(normalizedRepoId)
    const taskId = activeCloneTaskIdsRef.current.get(normalizedRepoId) || cloneProgress[normalizedRepoId]?.taskId
    const currentState = cloneProgress[normalizedRepoId]?.state

    setCloneProgress((prev) => {
      const current = prev[normalizedRepoId]
      if (!current || !isCloneProgressCancelable(current)) return prev
      return {
        ...prev,
        [normalizedRepoId]: {
          ...current,
          state: current.state === 'pending' ? 'canceled' : 'canceling',
          message: current.state === 'pending' ? '已取消，未开始克隆。' : '正在取消克隆任务...',
        },
      }
    })

    if (taskId && currentState !== 'pending' && currentState !== 'canceled') {
      try {
        await onCancelCloneRepo?.(taskId)
      } catch (error) {
        setCloneProgress((prev) => {
          const current = prev[normalizedRepoId]
          if (!current || current.state !== 'canceling') return prev
          return {
            ...prev,
            [normalizedRepoId]: {
              ...current,
              state: 'error',
              message: `取消失败：${getErrorMessage(error)}`,
            },
          }
        })
      }
    }
  }

  const requestCancelAllClones = () => {
    if (!cloning) {
      setClonePanelOpen(false)
      return
    }

    for (const repo of cloneDisplayRepos) {
      const progress = cloneProgress[repo.id]
      if (isCloneProgressCancelable(progress)) {
        void requestCancelClone(repo.id)
      }
    }
  }

  const startClone = async () => {
    if (cloning || busy) return
    const targetPath = clonePath.trim()
    if (!targetPath) {
      setCloneError('请选择本地保存路径')
      return
    }

    const targets = selectedRepos
    if (targets.length === 0) {
      setCloneError('请选择要克隆的仓库')
      return
    }

    const cloneRunId = cloneRunIdRef.current + 1
    cloneRunIdRef.current = cloneRunId
    cloneCancelRequestedRepoIdsRef.current = new Set()
    activeCloneTaskIdsRef.current = new Map()
    const cloneTasks = targets.map((repo) => ({
      repo,
      taskId: createGithubCloneTaskId(repo),
    }))
    const cloneTaskGroups = groupGithubCloneTasksByTargetName(cloneTasks)

    setCloning(true)
    setCloneTargets(targets)
    setCloneError('')
    setBatchResult(null)
    setCloneProgress(() => {
      const initialProgress = {}
      for (const task of cloneTasks) {
        initialProgress[task.repo.id] = {
          state: 'pending',
          message: '',
          taskId: task.taskId,
        }
      }
      return initialProgress
    })

    let successCount = 0
    const failures = []
    const warnings = []
    const canceled = []
    const successfulIds = new Set()
    let cursor = 0

    const markCloneProgress = (repoId, nextProgress) => {
      setCloneProgress((prev) => {
        const current = prev[repoId] || {}
        return {
          ...prev,
          [repoId]: {
            ...current,
            ...nextProgress,
          },
        }
      })
    }

    const runCloneTask = async (task) => {
      const { repo, taskId } = task
      const repoId = repo.id

      if (cloneCancelRequestedRepoIdsRef.current.has(repoId)) {
        canceled.push({ repo, message: '已取消，未开始克隆。' })
        markCloneProgress(repoId, {
          state: 'canceled',
          message: '已取消，未开始克隆。',
          taskId,
        })
        return
      }

      activeCloneTaskIdsRef.current.set(repoId, taskId)
      markCloneProgress(repoId, { state: 'cloning', message: '', taskId })

      try {
        const result = await onCloneRepo?.(repo, targetPath, { cloneTaskId: taskId })
        const wasCancelled = cloneCancelRequestedRepoIdsRef.current.has(repoId) || result?.canceled
        if (wasCancelled) {
          const message = result?.message || '克隆已取消'
          canceled.push({ repo, message })
          markCloneProgress(repoId, { state: 'canceled', message, taskId })
        } else if (result?.success) {
          successCount += 1
          successfulIds.add(repoId)
          if (result.warning) warnings.push({ repo, message: result.warning })
          markCloneProgress(repoId, {
            state: 'done',
            message: result.warning || '',
            warning: Boolean(result.warning),
            taskId,
          })
        } else {
          const message = result?.message || '克隆失败'
          failures.push({ repo, message })
          markCloneProgress(repoId, { state: 'error', message, taskId })
        }
      } catch (error) {
        const message = getErrorMessage(error)
        if (cloneCancelRequestedRepoIdsRef.current.has(repoId) || message.includes('克隆已取消')) {
          canceled.push({ repo, message: '克隆已取消' })
          markCloneProgress(repoId, { state: 'canceled', message: '克隆已取消', taskId })
        } else {
          failures.push({ repo, message })
          markCloneProgress(repoId, { state: 'error', message, taskId })
        }
      } finally {
        activeCloneTaskIdsRef.current.delete(repoId)
      }
    }

    const runCloneWorker = async () => {
      while (cursor < cloneTaskGroups.length) {
        const group = cloneTaskGroups[cursor]
        cursor += 1
        for (const task of group) {
          await runCloneTask(task)
        }
      }
    }

    const workerCount = Math.min(GITHUB_CLONE_CONCURRENCY, cloneTaskGroups.length)
    await Promise.all(Array.from({ length: workerCount }, () => runCloneWorker()))
    if (cloneRunId !== cloneRunIdRef.current) return

    const resultSummary = {
      totalCount: targets.length,
      successCount,
      failureCount: failures.length,
      canceledCount: canceled.length,
      failures,
      warnings,
      canceled,
      parentPath: targetPath,
    }

    setSelectedIds((prev) => {
      if (successfulIds.size === 0) return prev
      const next = new Set(prev)
      successfulIds.forEach((id) => next.delete(id))
      return next
    })
    setBatchResult(resultSummary)
    setCloning(false)
    activeCloneTaskIdsRef.current = new Map()
    cloneCancelRequestedRepoIdsRef.current = new Set()

    if (successCount > 0) {
      try {
        await onBatchCloneComplete?.(resultSummary)
      } catch (error) {
        setCloneError(`仓库已克隆，但刷新列表失败：${getErrorMessage(error)}`)
      }
    }
  }

  const handleClose = () => {
    if (cloning) return
    onClose?.()
  }

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={handleClose}>
      <div data-overlay-motion="surface" className="github-repo-browser" onClick={(event) => event.stopPropagation()}>
        <div className="github-repo-browser__header">
          <div className="github-repo-browser__title-wrap">
            <div className="github-repo-browser__icon">
              <Icons.github className="icon icon--sm" />
            </div>
            <div>
              <div className="github-repo-browser__title">GitHub 仓库</div>
              <div className="github-repo-browser__subtitle">浏览账号仓库并批量克隆到本地</div>
            </div>
          </div>
          <button className="github-repo-browser__close" onClick={handleClose} disabled={cloning} aria-label="关闭 GitHub 仓库浏览器">
            <Icons.close className="icon icon--xs" />
          </button>
        </div>

        <div className="github-repo-browser__toolbar">
          <div className="github-repo-browser__search">
            <Icons.search className="icon icon--sm" />
            <input
              value={search}
              placeholder="搜索仓库名称、描述或语言"
              onChange={(event) => setSearch(event.target.value)}
              disabled={cloning}
            />
          </div>
          <div className="github-repo-browser__filters">
            <GithubRepoFilterSelect
              Icons={Icons}
              value={visibilityFilter}
              options={GITHUB_REPO_VISIBILITY_OPTIONS}
              onChange={setVisibilityFilter}
              ariaLabel="筛选仓库可视性"
              className="github-repo-browser__select--visibility"
              disabled={loading || cloning}
            />
            <GithubRepoFilterSelect
              Icons={Icons}
              value={languageFilter}
              options={languageOptions}
              onChange={setLanguageFilter}
              ariaLabel="筛选仓库语言"
              className="github-repo-browser__select--language"
              disabled={cloning || languageOptions.length <= 1}
            />
            <GithubRepoFilterSelect
              Icons={Icons}
              value={sortValue}
              options={GITHUB_REPO_SORT_OPTIONS}
              onChange={setSortValue}
              ariaLabel="排序 GitHub 仓库"
              className="github-repo-browser__select--sort"
              disabled={loading || cloning}
            />
          </div>
          <button
            className={`github-repo-browser__filter-toggle ${hideExisting ? 'github-repo-browser__filter-toggle--active' : ''}`}
            onClick={() => setHideExisting((prev) => !prev)}
            disabled={cloning}
            aria-pressed={hideExisting}
          >
            <span className={`toggle toggle--compact ${hideExisting ? 'toggle--active' : ''}`} />
            <span>隐藏已添加</span>
          </button>
        </div>

        <div className="github-repo-browser__summary">
          <span>已加载 {repos.length} 个</span>
          <span>匹配 {visibleRepos.length} 个</span>
          {hiddenExistingCount > 0 ? (
            <span>{hideExisting ? `已隐藏 ${hiddenExistingCount} 个已添加仓库` : `${hiddenExistingCount} 个已添加仓库`}</span>
          ) : null}
          <strong>已选 {selectedCount}</strong>
        </div>

        {loadError ? (
          <div className="github-repo-browser__error" role="alert">
            <Icons.warning className="icon icon--xs" />
            <span>{loadError}</span>
          </div>
        ) : null}

        <div className="github-repo-browser__list" aria-label="GitHub 仓库列表">
          {visibleRepos.map((repo) => {
            const existing = isRepoExisting(repo)
            const selected = selectedIds.has(repo.id)
            return (
              <div
                key={repo.id}
                className={`github-repo-browser__item ${selected ? 'github-repo-browser__item--selected' : ''} ${existing ? 'github-repo-browser__item--existing' : ''}`}
              >
                <button
                  type="button"
                  className="github-repo-browser__item-select"
                  onClick={() => toggleSelect(repo)}
                  disabled={cloning || existing}
                  aria-pressed={selected}
                >
                  <span className={`github-repo-browser__check ${selected ? 'github-repo-browser__check--active' : ''}`}>
                    {selected ? <Icons.check className="icon icon--xs" /> : null}
                  </span>
                  <span className="github-repo-browser__item-main">
                    <span className="github-repo-browser__item-head">
                      <span className="github-repo-browser__item-name">{repo.full_name}</span>
                    </span>
                    {repo.description ? (
                      <span className="github-repo-browser__item-desc">{repo.description}</span>
                    ) : null}
                    <span className="github-repo-browser__item-meta">
                      {repo.language ? <span>{repo.language}</span> : null}
                      <span>Star {Number(repo.stargazers_count || 0)}</span>
                      <span>{repo.default_branch || 'main'}</span>
                      <span>更新 {formatGithubRepoDate(repo.updated_at)}</span>
                      <span>创建 {formatGithubRepoDate(repo.created_at)}</span>
                    </span>
                  </span>
                </button>
                <span className="github-repo-browser__item-actions">
                  <span className="github-repo-browser__badges">
                    {existing ? <span className="github-repo-browser__badge github-repo-browser__badge--muted">已添加到应用中</span> : null}
                    <span className="github-repo-browser__badge">{repo.private ? '私有' : '公开'}</span>
                  </span>
                  <button
                    type="button"
                    className="github-repo-browser__remote-btn"
                    onClick={(event) => openRemoteRepo(event, repo)}
                    disabled={!repo.html_url}
                    aria-label={`打开 ${repo.full_name} 的远程仓库`}
                  >
                    <Icons.externalLink className="icon icon--xs" />
                    <span>打开</span>
                  </button>
                </span>
              </div>
            )
          })}

          {!loading && visibleRepos.length === 0 ? (
            <div className="github-repo-browser__empty">
              {hideExisting && hiddenExistingCount > 0
                ? '匹配的仓库都已在列表中，可关闭隐藏开关查看。'
                : '没有找到匹配的仓库。'}
            </div>
          ) : null}

          {loading && repos.length === 0 ? (
            <div className="github-repo-browser__loading">
              <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
              <span>正在加载仓库...</span>
            </div>
          ) : null}
        </div>

        <div className="github-repo-browser__footer">
          <button className="dialog-btn" onClick={handleClose} disabled={cloning}>关闭</button>
          {hasMore ? (
            <button className="dialog-btn" onClick={() => loadReposPage(page)} disabled={loading || cloning}>
              {loading ? '加载中...' : '加载更多'}
            </button>
          ) : null}
          <button className="dialog-btn dialog-btn--primary" onClick={openClonePanel} disabled={selectedCount === 0 || cloning || busy}>
            克隆所选
          </button>
        </div>

        {clonePanelOpen ? (
          <div
            className="github-repo-browser__clone-overlay"
            onClick={() => {
              if (!cloning) setClonePanelOpen(false)
            }}
          >
            <section
              className="github-repo-browser__clone-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="github-repo-clone-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="github-repo-browser__clone-head">
                <div>
                  <div className="github-repo-browser__clone-title" id="github-repo-clone-title">克隆 {cloneDisplayRepos.length} 个仓库</div>
                  <div className="github-repo-browser__clone-subtitle">并发克隆，单个失败或取消不会中断剩余任务。</div>
                </div>
                <button
                  type="button"
                  className="github-repo-browser__clone-close"
                  onClick={() => setClonePanelOpen(false)}
                  disabled={cloning}
                  aria-label="关闭克隆设置"
                >
                  <Icons.close className="icon icon--xs" />
                </button>
              </div>

              <div className="github-repo-browser__clone-scroll">
                <div className="github-repo-browser__path-row">
                  <input
                    className="github-repo-browser__path-input"
                    value={clonePath}
                    placeholder="请选择本地保存目录"
                    onChange={(event) => setClonePath(event.target.value)}
                    disabled={cloning}
                  />
                  <button className="github-repo-browser__pick-btn" onClick={pickClonePath} disabled={cloning}>
                    选择目录
                  </button>
                </div>
                {cloneError ? (
                  <div className="github-repo-browser__error github-repo-browser__error--clone" role="alert">
                    <Icons.warning className="icon icon--xs" />
                    <span>{cloneError}</span>
                  </div>
                ) : null}
                <div className="github-repo-browser__clone-list">
                  {cloneDisplayRepos.map((repo) => {
                    const progress = cloneProgress[repo.id]
                    return (
                      <div className={`github-repo-browser__clone-item github-repo-browser__clone-item--${progress?.state || 'pending'}`} key={repo.id}>
                        <span>{repo.full_name}</span>
                        <strong>{getCloneProgressLabel(progress)}</strong>
                        <button
                          type="button"
                          className="github-repo-browser__clone-cancel-btn"
                          onClick={() => { void requestCancelClone(repo.id) }}
                          disabled={!isCloneProgressCancelable(progress)}
                        >
                          {progress?.state === 'pending' ? '移除' : '取消'}
                        </button>
                        {progress?.message ? <small>{progress.message}</small> : null}
                      </div>
                    )
                  })}
                </div>
                {batchResult ? (
                  <div className="github-repo-browser__result">
                    完成 {batchResult.successCount}/{batchResult.totalCount} 个
                    {batchResult.failureCount > 0 ? `，失败 ${batchResult.failureCount} 个` : ''}
                    {batchResult.canceledCount > 0 ? `，取消 ${batchResult.canceledCount} 个` : ''}
                  </div>
                ) : null}
              </div>

              <div className="github-repo-browser__clone-actions">
                <button className="dialog-btn" onClick={requestCancelAllClones}>
                  {cloning ? '取消全部' : '取消'}
                </button>
                <button className="dialog-btn dialog-btn--primary" onClick={startClone} disabled={!canStartClone}>
                  {cloning ? (
                    <><span className="spinning"><Icons.sync className="icon icon--sm" /></span> 克隆中...</>
                  ) : (
                    <>开始克隆</>
                  )}
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}
