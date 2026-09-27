import { invoke } from '@tauri-apps/api/core'
import { normalizeStashDetail } from './stashViewModel.js'

export const STASH_DETAIL_CACHE_LIMIT = 256
export const STASH_DETAIL_FAILURE_COOLDOWN_MS = 3_000
export const STASH_DETAIL_NATIVE_CONCURRENCY = 4

export class StashDetailSupersededError extends Error {
  constructor() {
    super('Stash 详情读取已被更新的权威请求取代')
    this.name = 'StashDetailSupersededError'
    this.code = 'STASH_DETAIL_SUPERSEDED'
  }
}

function normalizedRepoPath(repoPath) {
  return String(repoPath || '').trim()
}

function cacheKey(repoPath, stashId) {
  return `${normalizedRepoPath(repoPath)}\0${String(stashId || '').trim()}`
}

export function createStashDetailRepository({
  invokeNative = invoke,
  normalizeDetail = normalizeStashDetail,
  now = () => Date.now(),
  cacheLimit = STASH_DETAIL_CACHE_LIMIT,
  failureCooldownMs = STASH_DETAIL_FAILURE_COOLDOWN_MS,
  nativeConcurrency = STASH_DETAIL_NATIVE_CONCURRENCY,
} = {}) {
  const detailCache = new Map()
  const detailFlights = new Map()
  const failureUntil = new Map()
  const invalidatedFlightTokens = new Set()
  const nativeQueues = new Map()
  const concurrencyLimit = Math.max(1, Number(nativeConcurrency) || STASH_DETAIL_NATIVE_CONCURRENCY)

  const touch = (key, value) => {
    detailCache.delete(key)
    detailCache.set(key, value)
    while (detailCache.size > cacheLimit) {
      const oldest = detailCache.keys().next().value
      if (oldest == null) break
      detailCache.delete(oldest)
      failureUntil.delete(oldest)
    }
  }

  const hasConsumers = (flight) => Boolean(
    flight?.persistentConsumer
    || flight?.abortableConsumers?.size > 0
  )

  const nativeQueueState = (repoKey) => {
    let state = nativeQueues.get(repoKey)
    if (!state) {
      state = { active: 0, queue: [] }
      nativeQueues.set(repoKey, state)
    }
    return state
  }

  const pruneNativeQueue = (repoKey) => {
    const state = nativeQueues.get(repoKey)
    if (!state || state.queue.length === 0) return
    const kept = []
    for (const job of state.queue) {
      if (job.shouldRun()) kept.push(job)
      else job.reject(new StashDetailSupersededError())
    }
    state.queue = kept
    if (state.active === 0 && state.queue.length === 0) nativeQueues.delete(repoKey)
  }

  const pumpNativeQueue = (repoKey) => {
    const state = nativeQueues.get(repoKey)
    if (!state) return
    pruneNativeQueue(repoKey)
    const current = nativeQueues.get(repoKey)
    if (!current) return

    while (current.active < concurrencyLimit && current.queue.length > 0) {
      const job = current.queue.shift()
      if (!job.shouldRun()) {
        job.reject(new StashDetailSupersededError())
        continue
      }

      current.active += 1
      let taskPromise
      try {
        // Preserve existing read() timing: available native capacity starts
        // immediately. Only excess work is queued.
        taskPromise = Promise.resolve(job.task())
      } catch (error) {
        current.active -= 1
        job.reject(error)
        continue
      }

      taskPromise
        .then(job.resolve, job.reject)
        .finally(() => {
          current.active -= 1
          if (current.active === 0 && current.queue.length === 0) {
            if (nativeQueues.get(repoKey) === current) nativeQueues.delete(repoKey)
            return
          }
          pumpNativeQueue(repoKey)
        })
    }
  }

  const scheduleNativeRead = (repoKey, task, shouldRun) => new Promise((resolve, reject) => {
    const state = nativeQueueState(repoKey)
    state.queue.push({ task, shouldRun, resolve, reject })
    pumpNativeQueue(repoKey)
  })

  const invalidateFlight = (key, { detach = false } = {}) => {
    const active = detailFlights.get(key)
    if (!active) return
    invalidatedFlightTokens.add(active.token)
    if (detach && detailFlights.get(key)?.token === active.token) detailFlights.delete(key)
    pruneNativeQueue(active.repoKey)
  }

  const invalidatePrefix = (prefix, { detach = false } = {}) => {
    for (const [key] of detailFlights) {
      if (key.startsWith(prefix)) invalidateFlight(key, { detach })
    }
  }

  const peek = (repoPath, stashId) => {
    const key = cacheKey(repoPath, stashId)
    const value = detailCache.get(key) || null
    if (value) touch(key, value)
    return value
  }

  const bindAbortableConsumer = (flight, signal, existingToken = null) => {
    if (signal?.aborted) {
      if (existingToken) flight.abortableConsumers.delete(existingToken)
      if (!flight.started && !hasConsumers(flight)) pruneNativeQueue(flight.repoKey)
      return Promise.reject(new StashDetailSupersededError())
    }

    const consumerToken = existingToken || Symbol(flight.repoKey)
    flight.abortableConsumers.add(consumerToken)

    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        signal?.removeEventListener?.('abort', onAbort)
        flight.abortableConsumers.delete(consumerToken)
        if (!flight.started && !hasConsumers(flight)) pruneNativeQueue(flight.repoKey)
      }
      const settle = (callback, value) => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
      const onAbort = () => settle(reject, new StashDetailSupersededError())

      signal?.addEventListener?.('abort', onAbort, { once: true })
      flight.promise.then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      )
    })
  }

  const read = (repoPath, stashId, { force = false, signal = null } = {}) => {
    const repoKey = normalizedRepoPath(repoPath)
    const key = cacheKey(repoPath, stashId)
    if (!repoKey || !key || key.endsWith('\0')) return Promise.reject(new Error('Stash 详情身份无效'))
    if (signal?.aborted) return Promise.reject(new StashDetailSupersededError())

    const cached = force ? null : peek(repoPath, stashId)
    if (cached) return Promise.resolve(cached)

    const active = detailFlights.get(key)
    if (active && !force) {
      if (!signal) {
        active.persistentConsumer = true
        return active.promise
      }
      return bindAbortableConsumer(active, signal)
    }
    if (active && force) invalidateFlight(key, { detach: true })

    const retryAt = failureUntil.get(key) || 0
    if (!force && retryAt > now()) {
      return Promise.reject(new Error('Stash 详情暂时不可用，请稍后刷新'))
    }
    if (force) failureUntil.delete(key)

    const token = Symbol(key)
    const firstConsumer = signal ? Symbol(repoKey) : null
    const flight = {
      token,
      repoKey,
      persistentConsumer: !signal,
      abortableConsumers: new Set(firstConsumer ? [firstConsumer] : []),
      started: false,
      promise: null,
    }
    detailFlights.set(key, flight)

    const shouldRun = () => (
      !invalidatedFlightTokens.has(token)
      && detailFlights.get(key)?.token === token
      && hasConsumers(flight)
    )

    flight.promise = scheduleNativeRead(
      repoKey,
      () => {
        if (!shouldRun()) throw new StashDetailSupersededError()
        flight.started = true
        return invokeNative('get_repo_stash_detail', { repoPath, stashId })
      },
      shouldRun,
    )
      .then((raw) => {
        const detail = normalizeDetail(raw)
        if (
          invalidatedFlightTokens.has(token)
          || detailFlights.get(key)?.token !== token
        ) {
          throw new StashDetailSupersededError()
        }
        touch(key, detail)
        failureUntil.delete(key)
        return detail
      })
      .catch((error) => {
        if (
          !(error instanceof StashDetailSupersededError)
          && !invalidatedFlightTokens.has(token)
          && detailFlights.get(key)?.token === token
        ) {
          failureUntil.set(key, now() + failureCooldownMs)
        }
        throw error
      })
      .finally(() => {
        if (detailFlights.get(key)?.token === token) detailFlights.delete(key)
        invalidatedFlightTokens.delete(token)
      })

    return signal
      ? bindAbortableConsumer(flight, signal, firstConsumer)
      : flight.promise
  }

  const prune = (repoPath, validStashIds = []) => {
    const repoKey = normalizedRepoPath(repoPath)
    const prefix = `${repoKey}\0`
    const valid = new Set(validStashIds.map((value) => String(value || '').trim()).filter(Boolean))
    const invalidKey = (key) => (
      key.startsWith(prefix)
      && !valid.has(key.slice(prefix.length))
    )

    for (const key of [...detailCache.keys()]) {
      if (!invalidKey(key)) continue
      detailCache.delete(key)
      failureUntil.delete(key)
      invalidateFlight(key, { detach: true })
    }
    for (const key of [...failureUntil.keys()]) {
      if (invalidKey(key)) failureUntil.delete(key)
    }
    for (const key of [...detailFlights.keys()]) {
      if (invalidKey(key)) invalidateFlight(key, { detach: true })
    }
    pruneNativeQueue(repoKey)
  }

  const clear = (repoPath = '') => {
    const normalized = normalizedRepoPath(repoPath)
    if (!normalized) {
      detailCache.clear()
      failureUntil.clear()
      for (const key of [...detailFlights.keys()]) invalidateFlight(key, { detach: true })
      for (const repoKey of [...nativeQueues.keys()]) pruneNativeQueue(repoKey)
      return
    }

    const prefix = `${normalized}\0`
    for (const key of [...detailCache.keys()]) {
      if (key.startsWith(prefix)) detailCache.delete(key)
    }
    for (const key of [...failureUntil.keys()]) {
      if (key.startsWith(prefix)) failureUntil.delete(key)
    }
    invalidatePrefix(prefix, { detach: true })
    pruneNativeQueue(normalized)
  }

  const stats = () => ({
    cacheEntries: detailCache.size,
    activeFlights: detailFlights.size,
    coolingFailures: failureUntil.size,
    invalidatedFlights: invalidatedFlightTokens.size,
    activeNativeReads: [...nativeQueues.values()].reduce((total, state) => total + state.active, 0),
    queuedNativeReads: [...nativeQueues.values()].reduce((total, state) => total + state.queue.length, 0),
  })

  return { peek, read, prune, clear, stats }
}

const defaultRepository = createStashDetailRepository()

export const peekStashDetail = (repoPath, stashId) => defaultRepository.peek(repoPath, stashId)
export const readStashDetail = (repoPath, stashId, options) => defaultRepository.read(repoPath, stashId, options)
export const pruneStashDetails = (repoPath, validStashIds) => defaultRepository.prune(repoPath, validStashIds)
export const clearStashDetails = (repoPath) => defaultRepository.clear(repoPath)
export const stashDetailRepositoryStats = () => defaultRepository.stats()
