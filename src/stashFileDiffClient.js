import { invoke } from '@tauri-apps/api/core'

export class StashFileDiffSupersededError extends Error {
  constructor() {
    super('Stash 文件 Diff 请求已被更新的选择取代')
    this.name = 'StashFileDiffSupersededError'
    this.code = 'STASH_FILE_DIFF_SUPERSEDED'
  }
}

function normalizedRepoPath(repoPath) {
  return String(repoPath || '').trim()
}

export function createStashFileDiffClient({ invokeNative = invoke } = {}) {
  const repositories = new Map()

  const stateFor = (repoKey) => {
    let state = repositories.get(repoKey)
    if (!state) {
      state = { active: null, pending: null }
      repositories.set(repoKey, state)
    }
    return state
  }

  const cleanupState = (repoKey, state) => {
    if (!state.active && !state.pending && repositories.get(repoKey) === state) {
      repositories.delete(repoKey)
    }
  }

  const settle = (request, callback, value) => {
    if (request.settled) return
    request.settled = true
    request.signal?.removeEventListener?.('abort', request.onAbort)
    callback(value)
  }

  const supersedePending = (state) => {
    const pending = state.pending
    if (!pending) return
    state.pending = null
    settle(pending, pending.reject, new StashFileDiffSupersededError())
  }

  const startRequest = (repoKey, state, request) => {
    if (request.settled || request.signal?.aborted) {
      settle(request, request.reject, new StashFileDiffSupersededError())
      cleanupState(repoKey, state)
      return
    }

    request.started = true
    state.active = request
    let nativePromise
    try {
      nativePromise = Promise.resolve(invokeNative('get_repo_stash_file_diff', {
        repoPath: request.repoPath,
        stashId: request.stashId,
        path: request.path,
      }))
    } catch (error) {
      nativePromise = Promise.reject(error)
    }

    nativePromise
      .then(
        (raw) => settle(request, request.resolve, raw),
        (error) => settle(request, request.reject, error),
      )
      .finally(() => {
        if (state.active === request) state.active = null
        const next = state.pending
        state.pending = null
        if (next) startRequest(repoKey, state, next)
        else cleanupState(repoKey, state)
      })
  }

  const read = (repoPath, stashId, path, { signal = null } = {}) => {
    const repoKey = normalizedRepoPath(repoPath)
    const normalizedStashId = String(stashId || '').trim()
    const normalizedPath = String(path || '')
    if (!repoKey || !normalizedStashId || !normalizedPath) {
      return Promise.reject(new Error('Stash 文件 Diff 身份无效'))
    }
    if (signal?.aborted) return Promise.reject(new StashFileDiffSupersededError())

    const state = stateFor(repoKey)
    return new Promise((resolve, reject) => {
      const request = {
        repoPath: repoKey,
        stashId: normalizedStashId,
        path: normalizedPath,
        signal,
        resolve,
        reject,
        started: false,
        settled: false,
        onAbort: null,
      }
      request.onAbort = () => {
        if (request.settled) return
        if (!request.started && state.pending === request) state.pending = null
        settle(request, reject, new StashFileDiffSupersededError())
        cleanupState(repoKey, state)
      }
      signal?.addEventListener?.('abort', request.onAbort, { once: true })

      if (!state.active) {
        startRequest(repoKey, state, request)
        return
      }

      supersedePending(state)
      state.pending = request
    })
  }

  const stats = () => ({
    repositories: repositories.size,
    activeNativeReads: [...repositories.values()].filter((state) => state.active).length,
    pendingReads: [...repositories.values()].filter((state) => state.pending).length,
  })

  return { read, stats }
}

const defaultClient = createStashFileDiffClient()

export const readStashFileDiff = (repoPath, stashId, path, options) => (
  defaultClient.read(repoPath, stashId, path, options)
)
export const stashFileDiffClientStats = () => defaultClient.stats()
