export const APP_UPDATE_PHASE = Object.freeze({
  idle: 'idle',
  checking: 'checking',
  current: 'current',
  downloading: 'downloading',
  ready: 'ready',
  preparing: 'preparing',
  installing: 'installing',
  restartRequired: 'restartRequired',
  relaunching: 'relaunching',
  error: 'error',
})

const initialState = () => ({
  phase: APP_UPDATE_PHASE.idle,
  version: '',
  notes: '',
  downloadedBytes: 0,
  contentLength: 0,
  dismissed: true,
  error: '',
  restartBlocked: false,
})

function errorText(error) {
  return error instanceof Error ? error.message : String(error || '未知错误')
}

/*
 * relaunch() 的语义是「替换掉当前进程」，所以在多数平台上它的 Promise
 * **永远不会 resolve**（进程直接被替换）。此前 `await relaunch()` 一旦不返回，
 * `actionInFlight` 就被永久卡在 true：之后每次点击都在入口静默 return，
 * 弹窗停在 relaunching 且没有按钮、也关不掉——表现就是「点很多次都没反应，
 * 直到某一刻应用突然退出并装好」。
 *
 * 所以这里改成有界等待：进程按预期退掉时这个 Promise 永远不 settle（无所谓，
 * 进程都没了）；只有「进程还活着」才会走到超时分支，那就必须把状态解开，
 * 让用户能重试，而不是把界面锁死。
 */
const RELAUNCH_SETTLE_TIMEOUT_MS = 15000

function relaunchWithDeadline(relaunch, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve('timeout')
    }, timeoutMs)
    Promise.resolve()
      .then(() => relaunch())
      .then(
        () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve('resolved')
        },
        (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(error)
        },
      )
  })
}

export function createAppUpdaterController({
  checkForUpdate,
  relaunch,
  acquireRestartGuard,
  releaseRestartGuard,
  getRestartBlockers = () => [],
  relaunchTimeoutMs = RELAUNCH_SETTLE_TIMEOUT_MS,
  onRestartIntent = () => {},
  onStateChange = () => {},
  onManualCurrent = () => {},
  onManualError = () => {},
} = {}) {
  let state = initialState()
  let generation = 0
  let owner = null
  let disposed = false
  let actionInFlight = false
  const closePromises = new WeakMap()

  const publish = (next) => {
    state = { ...state, ...next }
    if (!disposed) onStateChange({ ...state })
  }

  const closeUpdateOnce = (update) => {
    if (!update || (typeof update !== 'object' && typeof update !== 'function')) {
      return Promise.resolve()
    }
    let pending = closePromises.get(update)
    if (!pending) {
      pending = Promise.resolve().then(() => update.close?.()).catch((error) => {
        console.warn('释放应用更新资源失败:', error)
      })
      closePromises.set(update, pending)
    }
    return pending
  }

  const disposeOwner = async (target) => {
    if (!target) return
    target.disposed = true
    if (target.downloadPending) return
    await closeUpdateOnce(target.update)
  }

  const detachOwner = async () => {
    const previous = owner
    owner = null
    await disposeOwner(previous)
  }

  const isPromptVisible = () => (
    !state.dismissed
    && [
      APP_UPDATE_PHASE.ready,
      APP_UPDATE_PHASE.preparing,
      APP_UPDATE_PHASE.installing,
      APP_UPDATE_PHASE.restartRequired,
      APP_UPDATE_PHASE.relaunching,
    ].includes(state.phase)
  )

  const setError = (phase, error) => {
    const message = errorText(error)
    publish({ phase, error: message, dismissed: false, restartBlocked: false })
    return message
  }

  async function check({ manual = false } = {}) {
    if (
      disposed
      || actionInFlight
      || [APP_UPDATE_PHASE.preparing, APP_UPDATE_PHASE.installing, APP_UPDATE_PHASE.restartRequired, APP_UPDATE_PHASE.relaunching].includes(state.phase)
    ) return
    const currentGeneration = ++generation
    const previousOwner = owner
    owner = null
    publish({
      phase: APP_UPDATE_PHASE.checking,
      version: '',
      notes: '',
      downloadedBytes: 0,
      contentLength: 0,
      dismissed: true,
      error: '',
      restartBlocked: false,
    })
    if (previousOwner) await disposeOwner(previousOwner)
    if (disposed || currentGeneration !== generation) return

    let candidate = null
    try {
      const update = await checkForUpdate()
      if (currentGeneration !== generation || disposed) {
        if (owner?.update !== update) await closeUpdateOnce(update)
        return
      }
      if (!update) {
        publish({ phase: APP_UPDATE_PHASE.current, dismissed: true, error: '' })
        if (manual) onManualCurrent()
        return
      }

      candidate = {
        generation: currentGeneration,
        update,
        disposed: false,
        downloaded: false,
        downloadPending: true,
      }
      owner = candidate
      publish({
        phase: APP_UPDATE_PHASE.downloading,
        version: update.version || '',
        notes: update.body || '',
        downloadedBytes: 0,
        contentLength: 0,
        dismissed: true,
        error: '',
      })

      let downloadedBytes = 0
      let contentLength = 0
      await update.download((event) => {
        if (
          disposed
          || currentGeneration !== generation
          || owner !== candidate
          || candidate.disposed
        ) return

        if (event?.event === 'Started') {
          contentLength = Number(event.data?.contentLength || 0)
        } else if (event?.event === 'Progress') {
          downloadedBytes += Number(event.data?.chunkLength || 0)
        }
        publish({ downloadedBytes, contentLength })
      })
      candidate.downloadPending = false

      if (
        disposed
        || currentGeneration !== generation
        || owner !== candidate
        || candidate.disposed
      ) {
        if (candidate.disposed) await closeUpdateOnce(update)
        return
      }

      candidate.downloaded = true
      publish({ phase: APP_UPDATE_PHASE.ready, dismissed: false, error: '' })
    } catch (error) {
      if (candidate) candidate.downloadPending = false
      if (candidate && owner === candidate) {
        owner = null
        await disposeOwner(candidate)
      } else if (candidate?.disposed) {
        await closeUpdateOnce(candidate.update)
      }
      if (disposed || currentGeneration !== generation) return
      const message = setError(APP_UPDATE_PHASE.error, error)
      if (manual) onManualError(message)
    }
  }

  async function installOrRestart() {
    if (disposed || actionInFlight) return
    const restartingInstalledUpdate = state.phase === APP_UPDATE_PHASE.restartRequired
    const installingDownloadedUpdate = state.phase === APP_UPDATE_PHASE.ready
    if (!restartingInstalledUpdate && !installingDownloadedUpdate) return
    if (installingDownloadedUpdate && (!owner || !owner.downloaded || owner.disposed)) return

    actionInFlight = true
    publish({ phase: APP_UPDATE_PHASE.preparing, error: '', dismissed: false, restartBlocked: false })
    onRestartIntent(true)
    let guardToken = null
    let keepGuard = false
    try {
      const frontendBlockers = await getRestartBlockers()
      if (frontendBlockers?.length) {
        publish({
          phase: restartingInstalledUpdate ? APP_UPDATE_PHASE.restartRequired : APP_UPDATE_PHASE.ready,
          error: `当前仍有 Git 操作正在执行：${frontendBlockers.join('、')}`,
          dismissed: false,
          restartBlocked: true,
        })
        return
      }

      const guard = await acquireRestartGuard()
      if (!guard?.acquired) {
        const blockers = Array.isArray(guard?.blockers) ? guard.blockers : []
        publish({
          phase: restartingInstalledUpdate ? APP_UPDATE_PHASE.restartRequired : APP_UPDATE_PHASE.ready,
          error: blockers.length
            ? `当前仍有 Git 操作正在执行：${blockers.join('、')}`
            : String(guard?.error || 'GitSync 当前无法安全重启，请稍后重试。'),
          dismissed: false,
          restartBlocked: blockers.length > 0,
        })
        return
      }
      guardToken = guard.token

      let installedOwner = null
      if (installingDownloadedUpdate) {
        const updateOwner = owner
        publish({ phase: APP_UPDATE_PHASE.installing, error: '', dismissed: false })
        try {
          await updateOwner.update.install()
        } catch (error) {
          if (owner === updateOwner) {
            publish({
              phase: APP_UPDATE_PHASE.ready,
              error: errorText(error),
              dismissed: false,
            })
          }
          return
        }

        if (owner === updateOwner) owner = null
        installedOwner = updateOwner
      }

      publish({ phase: APP_UPDATE_PHASE.relaunching, error: '', dismissed: false })
      if (installedOwner) await disposeOwner(installedOwner)
      const outcome = await relaunchWithDeadline(relaunch, relaunchTimeoutMs)
      if (outcome === 'timeout') {
        // 进程还活着说明重启没发生；必须退回可重试状态，否则界面会永久锁死。
        setError(APP_UPDATE_PHASE.restartRequired, 'GitSync 未能自动重新启动，请点击重新启动，或手动退出后重新打开。')
      } else if (outcome !== 'resolved') {
        setError(APP_UPDATE_PHASE.restartRequired, outcome)
      } else {
        // 重启调用正常返回且进程没有立刻消失：同样交回给用户决定是否重试。
        keepGuard = false
        setError(APP_UPDATE_PHASE.restartRequired, 'GitSync 未能自动重新启动，请点击重新启动，或手动退出后重新打开。')
      }
    } catch (error) {
      if (state.phase === APP_UPDATE_PHASE.installing) {
        publish({ phase: APP_UPDATE_PHASE.ready, error: errorText(error), dismissed: false })
      } else {
        setError(restartingInstalledUpdate
          ? APP_UPDATE_PHASE.restartRequired
          : APP_UPDATE_PHASE.ready, error)
      }
    } finally {
      if (guardToken != null && !keepGuard) {
        try { await releaseRestartGuard(guardToken) } catch (error) {
          console.warn('释放应用重启保护失败:', error)
        }
      }
      if (!keepGuard) onRestartIntent(false)
      actionInFlight = false
    }
  }

  function dismiss() {
    if ([APP_UPDATE_PHASE.preparing, APP_UPDATE_PHASE.installing, APP_UPDATE_PHASE.relaunching].includes(state.phase)) return
    publish({ dismissed: true })
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    generation += 1
    if (![APP_UPDATE_PHASE.preparing, APP_UPDATE_PHASE.installing, APP_UPDATE_PHASE.relaunching].includes(state.phase)) {
      await detachOwner()
    }
  }

  return {
    check,
    installOrRestart,
    dismiss,
    dispose,
    getState: () => ({ ...state }),
    getOwner: () => owner,
    isPromptVisible,
  }
}
