// One authority for a coalescing refresh queue.
//
// A refresh machine owns everything that used to be spread across React state and
// four refs in App: the round counter, the request that arrived while a round was
// running, the set of repositories currently being refreshed, the waiter list and
// the idle notification. Consumers only call `request()` and read a snapshot.
//
// Guarantees:
// - A request that arrives during a round is merged into exactly one follow-up
//   round; it never queues one extra round per request.
// - A caller that re-enters from a round-completion continuation starts a fresh
//   task: the in-flight marker is released before waiters are woken.
// - The busy snapshot is derived from `track`/`settle` calls, so a per-repository
//   overlay reflects real progress instead of spanning the whole round.

function defaultMergeInput(previous, next) {
  if (previous == null) return next
  if (previous && next && typeof previous === 'object' && typeof next === 'object') {
    return { ...previous, ...next }
  }
  return next
}

export function createRefreshMachine({
  name = 'refresh',
  runRound,
  mergeInput = defaultMergeInput,
  getLatestInput = (input) => input,
  onIdle = null,
  now = () => Date.now(),
} = {}) {
  if (typeof runRound !== 'function') {
    throw new Error('createRefreshMachine requires a runRound function')
  }

  let runner = runRound
  const listeners = new Set()
  const state = {
    activeRound: 0,
    completedRound: 0,
    inFlight: null,
    queuedInput: null,
    activeRepoIds: [],
    idleAt: 0,
  }
  let waiters = []

  function buildSnapshot() {
    return Object.freeze({
      name,
      active: state.inFlight != null,
      round: state.activeRound,
      activeRepoIds: Object.freeze([...state.activeRepoIds]),
      idleAt: state.idleAt,
    })
  }

  let snapshot = buildSnapshot()

  function emit() {
    snapshot = buildSnapshot()
    for (const listener of listeners) listener(snapshot)
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function getSnapshot() {
    return snapshot
  }

  function waitFor(round) {
    if (state.completedRound >= round) return Promise.resolve()
    return new Promise((resolve, reject) => {
      waiters.push({ round, resolve, reject })
    })
  }

  function resolveWaiters() {
    const pending = []
    for (const waiter of waiters) {
      if (waiter.round <= state.completedRound) waiter.resolve()
      else pending.push(waiter)
    }
    waiters = pending
  }

  function rejectWaiters(error) {
    for (const waiter of waiters) waiter.reject(error)
    waiters = []
  }

  function trackRepos(repoIds) {
    const next = Array.isArray(repoIds) ? [...repoIds] : []
    if (next.length === state.activeRepoIds.length && next.every((id, index) => id === state.activeRepoIds[index])) {
      return
    }
    state.activeRepoIds = next
    emit()
  }

  function settleRepo(repoId) {
    if (!state.activeRepoIds.includes(repoId)) return
    state.activeRepoIds = state.activeRepoIds.filter((id) => id !== repoId)
    emit()
  }

  async function run(firstInput) {
    let nextInput = firstInput
    try {
      while (true) {
        const currentRound = state.activeRound + 1
        state.activeRound = currentRound
        state.activeRepoIds = []
        emit()

        await runner(nextInput, { track: trackRepos, settle: settleRepo })
        state.completedRound = currentRound

        const queued = state.queuedInput
        if (queued == null) break
        state.queuedInput = null
        nextInput = getLatestInput(queued)
      }
    } catch (error) {
      rejectWaiters(error)
      throw error
    } finally {
      // Release the in-flight marker BEFORE waking waiters: a caller that re-enters
      // from a round-completion continuation must start a fresh task, not queue a
      // round that no surviving task will run.
      state.inFlight = null
      state.activeRepoIds = []
      state.idleAt = now()
      resolveWaiters()
      emit()
      if (typeof onIdle === 'function') onIdle(snapshot)
    }
  }

  function request(input) {
    if (state.inFlight) {
      state.queuedInput = mergeInput(state.queuedInput, input)
      return waitFor(state.activeRound + 1)
    }
    const targetRound = state.activeRound + 1
    state.inFlight = run(input)
    return waitFor(targetRound)
  }

  return {
    name,
    request,
    subscribe,
    getSnapshot,
    trackRepos,
    settleRepo,
    setRunner(nextRunner) {
      if (typeof nextRunner === 'function') runner = nextRunner
    },
    isActive() {
      return state.inFlight != null
    },
  }
}
