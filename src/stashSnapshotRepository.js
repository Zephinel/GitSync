import { invoke } from '@tauri-apps/api/core'
import { clearStashDetails, pruneStashDetails } from './stashDetailRepository.js'
import { stashSnapshotHasCompleteStashList } from './stashSnapshotCompleteness.js'
import { normalizeStashSnapshot } from './stashViewModel.js'

export const STASH_SNAPSHOT_REPOSITORY_LIMIT = 64

function normalizedRepoPath(repoPath) {
  return String(repoPath || '').trim()
}

function createState() {
  return {
    clock: 0,
    installedVersion: 0,
    snapshotVersion: 0,
    latestMutationVersion: 0,
    generation: 0,
    snapshot: null,
    readFlight: null,
    deferredRead: null,
    subscribers: new Set(),
    mutationReservations: new Set(),
  }
}

function createDeferredRead() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

export function createStashSnapshotRepository({
  invokeNative = invoke,
  normalizeSnapshot = normalizeStashSnapshot,
  clearDetails = clearStashDetails,
  pruneDetails = pruneStashDetails,
  limit = STASH_SNAPSHOT_REPOSITORY_LIMIT,
} = {}) {
  const states = new Map()

  const notify = (state) => {
    for (const subscriber of [...state.subscribers]) {
      try { subscriber(state.snapshot) } catch { /* subscribers cannot break authority */ }
    }
  }

  const evictIdleStates = (protectedKey = '') => {
    if (states.size <= limit) return
    for (const [key, state] of states) {
      if (states.size <= limit) break
      if (
        key === protectedKey
        || state.subscribers.size > 0
        || state.readFlight
        || state.deferredRead
        || state.mutationReservations.size > 0
      ) continue
      states.delete(key)
      state.generation += 1
      clearDetails(key)
    }
  }

  const touchState = (repoPath) => {
    const key = normalizedRepoPath(repoPath)
    if (!key) throw new Error('仓库路径不能为空')
    let state = states.get(key)
    if (!state) state = createState()
    states.delete(key)
    states.set(key, state)
    evictIdleStates(key)
    return { key, state }
  }

  const deferRead = (state) => {
    if (!state.deferredRead) state.deferredRead = createDeferredRead()
    return state.deferredRead.promise
  }

  const canInstall = (key, state, generation, version) => (
    states.get(key) === state
    && state.generation === generation
    && version >= state.installedVersion
  )

  const install = (key, state, generation, version, rawSnapshot) => {
    if (!canInstall(key, state, generation, version)) return null
    const snapshot = normalizeSnapshot(rawSnapshot)
    if (!snapshot.snapshotId) throw new Error('Stash 快照缺少权威身份')
    state.installedVersion = version
    state.snapshotVersion = version
    state.snapshot = snapshot
    if (stashSnapshotHasCompleteStashList(snapshot)) {
      pruneDetails(key, snapshot.stashes.map((entry) => entry.id))
    }
    notify(state)
    return snapshot
  }

  const beginMutation = (repoPath) => {
    const { key, state } = touchState(repoPath)
    const version = ++state.clock
    state.latestMutationVersion = Math.max(state.latestMutationVersion, version)
    state.installedVersion = Math.max(state.installedVersion, version)
    const token = Object.freeze({
      repoPath: key,
      state,
      generation: state.generation,
      version,
    })
    state.mutationReservations.add(token)
    return token
  }

  const read = (repoPath, { force = false, mutationToken = null } = {}) => {
    const { key, state } = touchState(repoPath)
    // Cache invalidation may advance the read generation while a real Git
    // mutation is still active. Reservation membership, not the old cache
    // generation, is the authority that permits the operation's own final read.
    const mutationRead = Boolean(
      mutationToken
      && mutationToken.repoPath === key
      && mutationToken.state === state
      && state.mutationReservations.has(mutationToken)
    )

    if (state.mutationReservations.size > 0 && !mutationRead) {
      return deferRead(state)
    }
    if (!force && state.readFlight) return state.readFlight.promise

    const version = ++state.clock
    if (force) state.installedVersion = Math.max(state.installedVersion, version)
    const generation = state.generation
    const token = Symbol(key)

    const resolveSupersededRead = () => {
      if (state.mutationReservations.size > 0) return deferRead(state)
      const active = state.readFlight
      if (active && active.token !== token) return active.promise
      return state.snapshot
    }

    const promise = invokeNative('get_repo_stash_snapshot', { repoPath: key })
      .then((raw) => install(key, state, generation, version, raw) || resolveSupersededRead())
      .catch((error) => {
        if (!canInstall(key, state, generation, version)) return resolveSupersededRead()
        throw error
      })
      .finally(() => {
        if (state.readFlight?.token === token) state.readFlight = null
        evictIdleStates()
      })

    state.readFlight = { token, promise, version, generation }
    return promise
  }

  const settleDeferredRead = (key, state) => {
    if (state.mutationReservations.size > 0 || !state.deferredRead) return
    const deferred = state.deferredRead
    state.deferredRead = null

    if (
      state.snapshot
      && state.snapshotVersion >= state.latestMutationVersion
    ) {
      deferred.resolve(state.snapshot)
      return
    }

    void read(key, { force: true }).then(deferred.resolve, deferred.reject)
  }

  const releaseMutation = (token) => {
    if (!token?.state) return
    const state = token.state
    state.mutationReservations.delete(token)
    if (state.mutationReservations.size === 0 && states.get(token.repoPath) === state) {
      settleDeferredRead(token.repoPath, state)
    }
    evictIdleStates()
  }

  const publishMutation = (token, rawSnapshot) => {
    if (
      !token?.repoPath
      || !token?.state
      || !rawSnapshot
      || !token.state.mutationReservations.has(token)
    ) return null
    return install(
      token.repoPath,
      token.state,
      token.generation,
      token.version,
      rawSnapshot,
    )
  }

  const publish = (repoPath, rawSnapshot) => {
    const token = beginMutation(repoPath)
    try {
      return publishMutation(token, rawSnapshot)
    } finally {
      releaseMutation(token)
    }
  }

  const subscribe = (repoPath, subscriber, { emitCurrent = true } = {}) => {
    if (typeof subscriber !== 'function') return () => {}
    const { state } = touchState(repoPath)
    state.subscribers.add(subscriber)
    if (emitCurrent) {
      try { subscriber(state.snapshot) } catch { /* subscriber failure is isolated */ }
    }
    return () => {
      state.subscribers.delete(subscriber)
      evictIdleStates()
    }
  }

  const peek = (repoPath) => {
    const key = normalizedRepoPath(repoPath)
    return key ? states.get(key)?.snapshot || null : null
  }

  const invalidate = (repoPath) => {
    const { state } = touchState(repoPath)
    const version = ++state.clock
    state.installedVersion = Math.max(state.installedVersion, version)
  }

  const resetState = (key, state) => {
    state.generation += 1
    state.clock += 1
    state.installedVersion = state.clock
    state.snapshotVersion = 0
    state.latestMutationVersion = 0
    state.readFlight = null
    state.snapshot = null
    if (state.deferredRead && state.mutationReservations.size === 0) {
      const deferred = state.deferredRead
      state.deferredRead = null
      deferred.resolve(null)
    }
    clearDetails(key)
    notify(state)
  }

  const clear = (repoPath = '') => {
    const key = normalizedRepoPath(repoPath)
    if (key) {
      const state = states.get(key)
      if (!state) return
      resetState(key, state)
      if (state.subscribers.size === 0 && state.mutationReservations.size === 0) states.delete(key)
      return
    }

    for (const [existingKey, state] of states) resetState(existingKey, state)
    for (const [existingKey, state] of states) {
      if (state.subscribers.size === 0 && state.mutationReservations.size === 0) {
        states.delete(existingKey)
      }
    }
  }

  const stats = () => ({
    repositories: states.size,
    snapshots: [...states.values()].filter((state) => state.snapshot).length,
    activeReads: [...states.values()].filter((state) => state.readFlight).length,
    deferredReads: [...states.values()].filter((state) => state.deferredRead).length,
    activeMutations: [...states.values()].reduce((total, state) => total + state.mutationReservations.size, 0),
    subscribers: [...states.values()].reduce((total, state) => total + state.subscribers.size, 0),
  })

  return {
    beginMutation,
    releaseMutation,
    publishMutation,
    read,
    publish,
    subscribe,
    peek,
    invalidate,
    clear,
    stats,
  }
}

const defaultRepository = createStashSnapshotRepository()

export const beginStashSnapshotMutation = (repoPath) => defaultRepository.beginMutation(repoPath)
export const releaseStashSnapshotMutation = (token) => defaultRepository.releaseMutation(token)
export const publishStashMutationSnapshot = (token, rawSnapshot) => defaultRepository.publishMutation(token, rawSnapshot)
export const readStashSnapshot = (repoPath, options) => defaultRepository.read(repoPath, options)
export const publishStashSnapshot = (repoPath, rawSnapshot) => defaultRepository.publish(repoPath, rawSnapshot)
export const subscribeStashSnapshot = (repoPath, subscriber, options) => defaultRepository.subscribe(repoPath, subscriber, options)
export const peekStashSnapshot = (repoPath) => defaultRepository.peek(repoPath)
export const invalidateStashSnapshot = (repoPath) => defaultRepository.invalidate(repoPath)
export const clearStashSnapshotRepository = (repoPath) => defaultRepository.clear(repoPath)
export const stashSnapshotRepositoryStats = () => defaultRepository.stats()
