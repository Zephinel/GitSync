import assert from 'node:assert/strict'
import test from 'node:test'
import { createWindowScaleGuard } from './windowScaleGuard.js'

function createFakeEventTarget() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(event, handler) {
      const set = listeners.get(event) || new Set()
      set.add(handler)
      listeners.set(event, set)
    },
    fire(event) {
      const set = listeners.get(event)
      if (!set) return
      set.forEach((handler) => handler())
    },
  }
}

function createFakeWindow(overrides = {}) {
  const target = createFakeEventTarget()
  return { ...target, devicePixelRatio: 1.5, innerWidth: 1184, ...overrides }
}

function createFakeDocument(overrides = {}) {
  const target = createFakeEventTarget()
  return { ...target, visibilityState: 'visible', ...overrides }
}

test('start is a no-op without a window or document', () => {
  const calls = []
  createWindowScaleGuard({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve()
    },
    win: null,
    doc: null,
  }).start()
  assert.deepEqual(calls, [])
})

test('start registers listeners once when the guard is enabled', async () => {
  const calls = []
  const win = createFakeWindow({ devicePixelRatio: 1.0, innerWidth: 1184 })
  const doc = createFakeDocument()
  const guard = createWindowScaleGuard({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(true)
    },
    win,
    doc,
  })
  guard.start()
  guard.start()
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual([...win.listeners.keys()].sort(), ['focus'])
  assert.deepEqual([...doc.listeners.keys()].sort(), ['visibilitychange'])
  const capabilityCalls = calls.filter((call) => call.command === 'is_window_scale_guard_enabled')
  assert.equal(capabilityCalls.length, 1)

  win.fire('focus')
  await Promise.resolve()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].command, 'webview_scale_guard')
  assert.equal(calls[1].args.dpr, 1.0)
  assert.equal(calls[1].args.innerWidth, 1184)
})

test('start registers nothing when the guard is disabled (non-Windows)', async () => {
  const calls = []
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const guard = createWindowScaleGuard({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(false)
    },
    win,
    doc,
  })
  guard.start()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'is_window_scale_guard_enabled')
  assert.equal(win.listeners.size, 0)
  assert.equal(doc.listeners.size, 0)
})

test('start registers nothing when the capability check fails', async () => {
  const calls = []
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const guard = createWindowScaleGuard({
    invokeNative: () => Promise.reject(new Error('not in tauri')),
    win,
    doc,
  })
  guard.start()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(win.listeners.size, 0)
})

test('visibility regain reports the current devicePixelRatio', async () => {
  const calls = []
  const win = createFakeWindow({ devicePixelRatio: 1.5, innerWidth: 1184 })
  const doc = createFakeDocument({ visibilityState: 'hidden' })
  const guard = createWindowScaleGuard({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(true)
    },
    win,
    doc,
  })
  guard.start()
  await Promise.resolve()
  await Promise.resolve()

  doc.fire('visibilitychange')
  await Promise.resolve()
  assert.equal(calls.length, 1)

  doc.visibilityState = 'visible'
  doc.fire('visibilitychange')
  await Promise.resolve()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].args.dpr, 1.5)
  assert.equal(calls[1].args.innerWidth, 1184)
})

test('invoke failures are swallowed so the guard never breaks the app', async () => {
  let calls = 0
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const guard = createWindowScaleGuard({
    invokeNative: (command) => {
      calls += 1
      if (command === 'is_window_scale_guard_enabled') return Promise.resolve(true)
      return Promise.reject(new Error('not in tauri'))
    },
    win,
    doc,
  })
  guard.start()
  await Promise.resolve()
  await Promise.resolve()
  win.fire('focus')
  await Promise.resolve()
  assert.equal(calls, 2)
})
