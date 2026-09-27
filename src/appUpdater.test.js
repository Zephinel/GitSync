import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppUpdaterController } from './appUpdater.js'

function createUpdate(version = '3.0.0') {
  const calls = { download: 0, install: 0, close: 0, progress: null }
  return {
    version,
    body: 'release notes',
    calls,
    async download(onEvent) {
      calls.download += 1
      await new Promise((resolve) => {
        calls.progress = (event) => {
          onEvent(event)
          if (event?.event === 'Finished') resolve()
        }
      })
    },
    async install() { calls.install += 1 },
    async close() { calls.close += 1 },
  }
}

function createHarness(overrides = {}) {
  const updates = []
  const states = []
  const calls = { check: 0, relaunch: 0, acquire: 0, release: 0 }
  let guardResult = { acquired: true, token: 'restart-token', blockers: [] }
  const controller = createAppUpdaterController({
    checkForUpdate: async () => {
      calls.check += 1
      return updates.shift() ?? null
    },
    relaunch: async () => { calls.relaunch += 1 },
    acquireRestartGuard: async () => {
      calls.acquire += 1
      return guardResult
    },
    releaseRestartGuard: async () => { calls.release += 1 },
    onStateChange: (state) => states.push(state),
    ...overrides,
  })
  return {
    controller,
    calls,
    states,
    updates,
    setGuardResult(value) { guardResult = value },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

test('no update moves checking to current without retaining a resource', async () => {
  const h = createHarness()
  await h.controller.check()
  assert.equal(h.controller.getState().phase, 'current')
  assert.equal(h.controller.getOwner(), null)
})

test('found update downloads in background without showing a prompt', async () => {
  const h = createHarness()
  const update = createUpdate('3.1.0')
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  assert.equal(h.controller.getState().phase, 'downloading')
  assert.equal(h.controller.getState().dismissed, true)
  assert.equal(h.controller.isPromptVisible(), false)
  update.calls.progress({ event: 'Started', data: { contentLength: 20 } })
  update.calls.progress({ event: 'Progress', data: { chunkLength: 5 } })
  assert.equal(h.controller.getState().downloadedBytes, 5)
  update.calls.progress({ event: 'Finished' })
  await check
})

test('download success opens the ready prompt and keeps the update resource', async () => {
  const h = createHarness()
  const update = createUpdate()
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check
  assert.equal(h.controller.getState().phase, 'ready')
  assert.equal(h.controller.getState().dismissed, false)
  assert.equal(h.controller.isPromptVisible(), true)
  assert.equal(h.controller.getOwner().update, update)
})

test('install click shows progress immediately while restart checks are pending', async () => {
  const blockers = deferred()
  const h = createHarness({ getRestartBlockers: () => blockers.promise })
  const update = createUpdate()
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check

  const install = h.controller.installOrRestart()
  assert.equal(h.controller.getState().phase, 'preparing')
  assert.equal(h.controller.isPromptVisible(), true)
  h.controller.dismiss()
  assert.equal(h.controller.isPromptVisible(), true)
  await h.controller.installOrRestart()
  assert.equal(update.calls.install, 0)

  blockers.resolve([])
  await install
  assert.equal(update.calls.install, 1)
})

test('dismissing ready hides only the prompt and Settings can still install', async () => {
  const h = createHarness()
  const update = createUpdate()
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check
  h.controller.dismiss()
  assert.equal(h.controller.getState().phase, 'ready')
  assert.equal(h.controller.getState().dismissed, true)
  assert.equal(h.controller.getOwner().update, update)
  assert.equal(h.controller.isPromptVisible(), false)
  await h.controller.installOrRestart()
  assert.equal(update.calls.install, 1)
})

test('a new check disposes a previously ready resource before retaining the new update', async () => {
  const h = createHarness()
  const oldUpdate = createUpdate('3.1.0')
  const newUpdate = createUpdate('3.2.0')
  h.updates.push(oldUpdate)
  const oldCheck = h.controller.check()
  await settle()
  oldUpdate.calls.progress({ event: 'Finished' })
  await oldCheck

  h.updates.push(newUpdate)
  const newCheck = h.controller.check({ manual: true })
  await settle()
  assert.equal(oldUpdate.calls.close, 1)
  assert.equal(h.controller.getState().phase, 'downloading')
  newUpdate.calls.progress({ event: 'Finished' })
  await newCheck
  assert.equal(h.controller.getOwner().update, newUpdate)
  assert.equal(newUpdate.calls.close, 0)
})

test('download failure closes and releases its update resource', async () => {
  const h = createHarness()
  const update = createUpdate()
  update.download = async () => { throw new Error('download failed') }
  h.updates.push(update)
  await h.controller.check()
  assert.equal(h.controller.getState().phase, 'error')
  assert.equal(h.controller.getOwner(), null)
  assert.equal(update.calls.close, 1)
})

test('stale download progress and completion cannot mutate a newer owner', async () => {
  const h = createHarness()
  const oldUpdate = createUpdate('3.1.0')
  const newUpdate = createUpdate('3.2.0')
  let releaseOldDownload
  oldUpdate.download = (onEvent) => {
    oldUpdate.calls.download += 1
    oldUpdate.calls.progress = onEvent
    return new Promise((resolve) => { releaseOldDownload = resolve })
  }
  h.updates.push(oldUpdate, newUpdate)
  const oldCheck = h.controller.check()
  await settle()
  const newCheck = h.controller.check()
  await settle()
  oldUpdate.calls.progress({ event: 'Progress', data: { chunkLength: 99 } })
  assert.equal(h.controller.getState().version, '3.2.0')
  assert.equal(h.controller.getState().downloadedBytes, 0)
  newUpdate.calls.progress({ event: 'Finished' })
  await newCheck
  assert.equal(oldUpdate.calls.close, 0)
  releaseOldDownload()
  await oldCheck
  assert.equal(h.controller.getOwner().update, newUpdate)
  assert.equal(oldUpdate.calls.close, 1)
  assert.equal(newUpdate.calls.close, 0)
})

test('stale download failure closes only its old owner and preserves the current ready owner', async () => {
  const h = createHarness()
  const oldUpdate = createUpdate('3.1.0')
  const newUpdate = createUpdate('3.2.0')
  let failOldDownload
  oldUpdate.download = () => {
    oldUpdate.calls.download += 1
    return new Promise((resolve, reject) => { failOldDownload = reject })
  }
  h.updates.push(oldUpdate, newUpdate)
  const oldCheck = h.controller.check()
  await settle()
  const newCheck = h.controller.check()
  await settle()
  newUpdate.calls.progress({ event: 'Finished' })
  await newCheck
  failOldDownload(new Error('stale download failed'))
  await oldCheck
  assert.equal(h.controller.getState().phase, 'ready')
  assert.equal(h.controller.getOwner().update, newUpdate)
  assert.equal(oldUpdate.calls.close, 1)
  assert.equal(newUpdate.calls.close, 0)
})

test('stale check completion cannot close the current owner when resource identity matches', async () => {
  const sharedUpdate = createUpdate('3.2.0')
  const firstCheck = deferred()
  let checkCount = 0
  const h = createHarness({
    checkForUpdate: () => {
      checkCount += 1
      return checkCount === 1 ? firstCheck.promise : Promise.resolve(sharedUpdate)
    },
  })
  const oldCheck = h.controller.check()
  await settle()
  const currentCheck = h.controller.check()
  await settle()
  firstCheck.resolve(sharedUpdate)
  await oldCheck
  assert.equal(h.controller.getOwner().update, sharedUpdate)
  assert.equal(sharedUpdate.calls.close, 0)
  sharedUpdate.calls.progress({ event: 'Finished' })
  await currentCheck
  assert.equal(h.controller.getState().phase, 'ready')
})

test('install failure returns to ready and retains resource for retry', async () => {
  const h = createHarness()
  const update = createUpdate()
  update.install = async () => {
    update.calls.install += 1
    if (update.calls.install === 1) throw new Error('install failed')
  }
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check
  await h.controller.installOrRestart()
  assert.equal(h.controller.getState().phase, 'ready')
  assert.equal(h.controller.getOwner().update, update)
  assert.equal(update.calls.close, 0)
})

test('install success then relaunch failures stay restartRequired and retry only relaunches', async () => {
  let shouldRelaunchFail = true
  const h = createHarness({
    relaunch: async () => {
      h.calls.relaunch += 1
      if (shouldRelaunchFail) throw new Error('relaunch failed')
    },
  })
  const update = createUpdate()
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check
  await h.controller.installOrRestart()
  assert.equal(h.controller.getState().phase, 'restartRequired')
  assert.equal(h.controller.getOwner(), null)
  assert.equal(update.calls.install, 1)
  assert.equal(update.calls.close, 1)
  await h.controller.installOrRestart()
  assert.equal(h.controller.getState().phase, 'restartRequired')
  assert.equal(update.calls.install, 1)
  shouldRelaunchFail = false
  await h.controller.installOrRestart()
  assert.equal(update.calls.install, 1)
  assert.equal(h.calls.relaunch, 3)
})

test('busy restart authority blocks both install and relaunch', async () => {
  const h = createHarness()
  h.setGuardResult({ acquired: false, blockers: ['pull in progress'] })
  const update = createUpdate()
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check
  await h.controller.installOrRestart()
  assert.equal(update.calls.install, 0)
  assert.equal(h.calls.relaunch, 0)
  assert.equal(h.controller.getState().phase, 'ready')
  assert.match(h.controller.getState().error, /pull in progress/)
})

test('TOCTOU restart guard rechecks busy state when install is requested', async () => {
  const h = createHarness()
  const update = createUpdate()
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check
  h.setGuardResult({ acquired: false, blockers: ['sync started after render'] })
  await h.controller.installOrRestart()
  assert.equal(update.calls.install, 0)
  assert.equal(h.calls.relaunch, 0)
  assert.match(h.controller.getState().error, /sync started after render/)
})

test('installing and relaunching cannot be dismissed, but restartRequired can', async () => {
  const installResult = deferred()
  const relaunchResult = deferred()
  const h = createHarness({ relaunch: () => {
    h.calls.relaunch += 1
    return relaunchResult.promise
  } })
  const update = createUpdate()
  update.install = () => {
    update.calls.install += 1
    return installResult.promise
  }
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check

  const install = h.controller.installOrRestart()
  await settle()
  assert.equal(h.controller.getState().phase, 'installing')
  h.controller.dismiss()
  assert.equal(h.controller.isPromptVisible(), true)
  installResult.resolve()
  await settle()
  assert.equal(h.controller.getState().phase, 'relaunching')
  h.controller.dismiss()
  assert.equal(h.controller.isPromptVisible(), true)
  relaunchResult.reject(new Error('restart failed'))
  await install
  assert.equal(h.controller.getState().phase, 'restartRequired')
  h.controller.dismiss()
  assert.equal(h.controller.getState().phase, 'restartRequired')
  assert.equal(h.controller.isPromptVisible(), false)
})

test('unmount discards a ready owner exactly once', async () => {
  const h = createHarness()
  const update = createUpdate()
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  update.calls.progress({ event: 'Finished' })
  await check
  await h.controller.dispose()
  await h.controller.dispose()
  assert.equal(h.controller.getOwner(), null)
  assert.equal(update.calls.close, 1)
})

test('unmount defers closing a pending download until its downloaded-bytes resource exists', async () => {
  const h = createHarness()
  const update = createUpdate()
  let finishDownload
  update.download = (onEvent) => {
    update.calls.download += 1
    update.calls.progress = onEvent
    return new Promise((resolve) => { finishDownload = resolve })
  }
  h.updates.push(update)
  const check = h.controller.check()
  await settle()
  await h.controller.dispose()
  assert.equal(update.calls.close, 0)
  finishDownload()
  await check
  assert.equal(update.calls.close, 1)
})
