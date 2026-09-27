import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { stashErrorMessage } from './stashError.js'
import {
  peekStashSnapshot,
  readStashSnapshot,
  subscribeStashSnapshot,
} from './stashSnapshotRepository.js'

export default function useStashSnapshotState(repoPath, { autoLoad = true } = {}) {
  const subscribe = useCallback(
    (notify) => subscribeStashSnapshot(repoPath, notify, { emitCurrent: false }),
    [repoPath],
  )
  const getSnapshot = useCallback(
    () => peekStashSnapshot(repoPath),
    [repoPath],
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null)
  const [loading, setLoading] = useState(() => autoLoad && !peekStashSnapshot(repoPath))
  const [error, setError] = useState('')
  const requestSequenceRef = useRef(0)
  const repoPathRef = useRef(repoPath)

  const refresh = useCallback(async ({ force = false } = {}) => {
    const requestSequence = ++requestSequenceRef.current
    const requestRepoPath = repoPath
    setLoading(true)
    setError('')
    try {
      return await readStashSnapshot(requestRepoPath, { force })
    } catch (loadError) {
      if (
        repoPathRef.current === requestRepoPath
        && requestSequenceRef.current === requestSequence
      ) {
        setError(stashErrorMessage(loadError))
      }
      return null
    } finally {
      if (
        repoPathRef.current === requestRepoPath
        && requestSequenceRef.current === requestSequence
      ) {
        setLoading(false)
      }
    }
  }, [repoPath])

  useEffect(() => {
    repoPathRef.current = repoPath
    requestSequenceRef.current += 1
    setError('')
    setLoading(autoLoad && !peekStashSnapshot(repoPath))
    if (autoLoad) void refresh()
    return () => {
      requestSequenceRef.current += 1
    }
  }, [autoLoad, refresh, repoPath])

  useEffect(() => {
    if (!snapshot) return
    requestSequenceRef.current += 1
    setError('')
    setLoading(false)
  }, [snapshot])

  return {
    snapshot,
    loading,
    error,
    refresh,
  }
}
