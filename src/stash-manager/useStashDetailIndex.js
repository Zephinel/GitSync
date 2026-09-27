import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  peekStashDetail,
  pruneStashDetails,
  readStashDetail,
} from '../stashDetailRepository.js'
import {
  STASH_DETAIL_SEARCH_STATE,
  stashDetailSearchState,
  stashDetailSearchStateIsVisible,
} from '../stashDetailSearch.js'

export const DETAIL_BATCH_SIZE = 4
export const SEARCH_PROGRESS_BATCH_SIZE = 12

function entryIdentityText(entry) {
  return [
    entry?.message,
    entry?.branchContext,
    entry?.id,
    entry?.selector,
    entry?.baseSummary,
  ]
    .map((value) => String(value || '').toLowerCase())
    .join('\n')
}

function uniqueEntries(entries) {
  const seen = new Set()
  return entries.filter((entry) => {
    if (!entry?.id || seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })
}

export function clearStashDetailIndex(repoPath) {
  pruneStashDetails(repoPath, [])
}

export function useStashDetailIndex(
  repoPath,
  authorityEntries = [],
  searchEntries = [],
  visibleEntries = [],
  query = '',
  { canPruneAbsent = true } = {},
) {
  const [detailVersion, setDetailVersion] = useState(0)
  const [searchVersion, setSearchVersion] = useState(0)
  const [indexingFiles, setIndexingFiles] = useState(false)
  const searchMatchesRef = useRef(new Set())
  const searchUnknownRef = useRef(new Set())
  const fileCountsRef = useRef(new Map())
  const queryNeedle = query.trim().toLowerCase()
  const queryActive = queryNeedle.length > 0
  const authorityIds = useMemo(
    () => authorityEntries.map((entry) => entry?.id).filter(Boolean),
    [authorityEntries]
  )
  const authoritySignature = useMemo(() => authorityIds.join('\0'), [authorityIds])
  const searchScope = useMemo(() => uniqueEntries(searchEntries), [searchEntries])
  const searchSignature = useMemo(
    () => searchScope.map((entry) => entry.id).join('\0'),
    [searchScope]
  )
  const visible = useMemo(() => uniqueEntries(visibleEntries), [visibleEntries])
  const visibleSignature = useMemo(() => visible.map((entry) => entry.id).join('\0'), [visible])

  useEffect(() => {
    if (!repoPath || !canPruneAbsent) return
    pruneStashDetails(repoPath, authorityIds)
    const valid = new Set(authorityIds)
    for (const stashId of fileCountsRef.current.keys()) {
      if (!valid.has(stashId)) fileCountsRef.current.delete(stashId)
    }
  }, [authorityIds, authoritySignature, canPruneAbsent, repoPath])

  useEffect(() => {
    if (!repoPath || queryActive || visible.length === 0) return undefined
    let active = true
    let cursor = 0
    const controller = new AbortController()
    const pending = visible.filter((entry) => {
      const detail = peekStashDetail(repoPath, entry.id)
      if (detail) {
        fileCountsRef.current.set(entry.id, detail.fileCount)
        return false
      }
      return true
    })

    const worker = async () => {
      while (active && cursor < pending.length) {
        const entry = pending[cursor]
        cursor += 1
        try {
          const detail = await readStashDetail(repoPath, entry.id, {
            signal: controller.signal,
          })
          if (!active) return
          fileCountsRef.current.set(entry.id, detail.fileCount)
          setDetailVersion((value) => value + 1)
        } catch {
          // A bounded cooldown in the shared repository prevents hot retry loops.
        }
      }
    }

    void Promise.all(Array.from(
      { length: Math.min(DETAIL_BATCH_SIZE, pending.length) },
      () => worker()
    ))
    return () => {
      active = false
      controller.abort()
    }
  }, [queryActive, repoPath, visible, visibleSignature])

  useEffect(() => {
    searchMatchesRef.current = new Set()
    searchUnknownRef.current = new Set()
    setSearchVersion((value) => value + 1)
    if (!repoPath || !queryActive) {
      setIndexingFiles(false)
      return undefined
    }

    let active = true
    let cursor = 0
    let completedSinceFlush = 0
    const controller = new AbortController()
    const matches = new Set()
    const unknown = new Set()
    const pending = []

    const classifyDetail = (entry, detail) => {
      const state = stashDetailSearchState(detail, queryNeedle)
      if (state === STASH_DETAIL_SEARCH_STATE.MATCH) matches.add(entry.id)
      else if (state === STASH_DETAIL_SEARCH_STATE.UNKNOWN) unknown.add(entry.id)
    }

    for (const entry of searchScope) {
      const detail = peekStashDetail(repoPath, entry.id)
      if (detail) fileCountsRef.current.set(entry.id, detail.fileCount)
      if (entryIdentityText(entry).includes(queryNeedle)) matches.add(entry.id)
      else if (detail) classifyDetail(entry, detail)
      else pending.push(entry)
    }

    searchMatchesRef.current = matches
    searchUnknownRef.current = unknown
    setSearchVersion((value) => value + 1)
    setIndexingFiles(pending.length > 0)

    const flush = () => {
      if (!active || completedSinceFlush === 0) return
      completedSinceFlush = 0
      searchMatchesRef.current = new Set(matches)
      searchUnknownRef.current = new Set(unknown)
      setSearchVersion((value) => value + 1)
    }

    const worker = async () => {
      while (active && cursor < pending.length) {
        const entry = pending[cursor]
        cursor += 1
        try {
          const detail = await readStashDetail(repoPath, entry.id, {
            signal: controller.signal,
          })
          if (!active) return
          fileCountsRef.current.set(entry.id, detail.fileCount)
          classifyDetail(entry, detail)
        } catch {
          if (!active) return
          // An unavailable detail cannot prove a filename does not match.
          unknown.add(entry.id)
        }
        completedSinceFlush += 1
        if (completedSinceFlush >= SEARCH_PROGRESS_BATCH_SIZE) flush()
      }
    }

    void Promise.all(Array.from(
      { length: Math.min(DETAIL_BATCH_SIZE, pending.length) },
      () => worker()
    )).finally(() => {
      if (!active) return
      flush()
      setIndexingFiles(false)
    })

    return () => {
      active = false
      controller.abort()
    }
  }, [queryActive, queryNeedle, repoPath, searchScope, searchSignature])

  const getDetail = useCallback(
    (stashId) => peekStashDetail(repoPath, stashId),
    [repoPath]
  )

  const getFileCount = useCallback((stashId) => {
    const detail = peekStashDetail(repoPath, stashId)
    return detail?.fileCount ?? fileCountsRef.current.get(stashId) ?? null
  }, [repoPath, detailVersion, searchVersion])

  const matchesQuery = useCallback((entry) => {
    if (!queryActive) return true
    if (searchMatchesRef.current.has(entry?.id)) return true
    const state = searchUnknownRef.current.has(entry?.id)
      ? STASH_DETAIL_SEARCH_STATE.UNKNOWN
      : STASH_DETAIL_SEARCH_STATE.NO_MATCH
    return stashDetailSearchStateIsVisible(state)
  }, [queryActive, queryNeedle, searchVersion])

  return {
    detailVersion,
    searchVersion,
    getDetail,
    getFileCount,
    matchesQuery,
    indexingFiles,
    searchIncomplete: queryActive && searchUnknownRef.current.size > 0,
  }
}
