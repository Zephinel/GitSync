import assert from 'node:assert/strict'
import test from 'node:test'
import { createWindowLifecycleDiagnostics } from './windowLifecycleDiagnostics.js'

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
  return {
    ...target,
    devicePixelRatio: 1.25,
    innerWidth: 1200,
    innerHeight: 800,
    outerWidth: 1216,
    outerHeight: 839,
    visualViewport: {
      width: 1200,
      height: 800,
      scale: 1,
      addEventListener: () => {},
    },
    ...overrides,
  }
}

function createFakeDocument(overrides = {}) {
  const target = createFakeEventTarget()
  return {
    ...target,
    visibilityState: 'visible',
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    querySelector(selector) {
      if (selector === '.sidebar') return null
      return null
    },
    ...overrides,
  }
}

test('start is a no-op without a window or document', () => {
  const calls = []
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve()
    },
    win: null,
    doc: null,
  })
  diagnostics.start()
  assert.deepEqual(calls, [])
})

test('start reports AppStarted and registers lifecycle listeners once when enabled', async () => {
  const calls = []
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(true)
    },
    win,
    doc,
  })
  diagnostics.start()
  diagnostics.start()
  await Promise.resolve()
  await Promise.resolve()

  const registered = new Set([...win.listeners.keys(), ...doc.listeners.keys()])
  assert.deepEqual(
    [...registered].sort(),
    ['blur', 'focus', 'resize', 'visibilitychange'],
  )
  const enabledCalls = calls.filter((call) => call.command === 'is_window_diagnostics_enabled')
  assert.equal(enabledCalls.length, 1)
  const appStarted = calls.filter((call) => call.args?.event === 'AppStarted')
  assert.equal(appStarted.length, 1)
})

test('start registers nothing when diagnostics are disabled', async () => {
  const calls = []
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(false)
    },
    win,
    doc,
  })
  diagnostics.start()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'is_window_diagnostics_enabled')
  assert.equal(win.listeners.size, 0)
  assert.equal(doc.listeners.size, 0)
})

test('start registers nothing when the capability check fails', async () => {
  const calls = []
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: () => Promise.reject(new Error('not in tauri')),
    win,
    doc,
  })
  diagnostics.start()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(win.listeners.size, 0)
})

test('lifecycle events report structured viewport snapshots', async () => {
  const calls = []
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(true)
    },
    win,
    doc,
  })
  diagnostics.start()
  await Promise.resolve()
  await Promise.resolve()

  win.fire('blur')
  await Promise.resolve()
  win.fire('focus')
  await Promise.resolve()

  const events = calls.map((call) => call.args?.event).filter(Boolean)
  assert.deepEqual(events, ['AppStarted', 'Blur', 'Focus'])
  const blurPayload = calls[1].args.payload
  assert.equal(blurPayload.device_pixel_ratio, 1.25)
  assert.equal(blurPayload.inner_width, 1200)
  assert.equal(blurPayload.inner_height, 800)
  assert.equal(blurPayload.outer_width, 1216)
  assert.equal(blurPayload.outer_height, 839)
  assert.equal(blurPayload.client_width, 1200)
  assert.equal(blurPayload.client_height, 800)
  assert.deepEqual(blurPayload.visual_viewport, { width: 1200, height: 800, scale: 1 })
  assert.equal(blurPayload.sidebar_width, null)
  assert.equal(blurPayload.visibility_state, 'visible')
})

test('visibilitychange reports the current visibility state', async () => {
  const calls = []
  const win = createFakeWindow()
  const doc = createFakeDocument({ visibilityState: 'hidden' })
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(true)
    },
    win,
    doc,
  })
  diagnostics.start()
  await Promise.resolve()
  await Promise.resolve()

  doc.fire('visibilitychange')
  await Promise.resolve()
  assert.equal(calls.filter((call) => call.args?.event === 'VisibilityChange').length, 1)
  const visibilityCall = calls.find((call) => call.args?.event === 'VisibilityChange')
  assert.equal(visibilityCall.args.payload.visibility_state, 'hidden')
})

test('sidebar width is captured when the sidebar exists', async () => {
  const calls = []
  const win = createFakeWindow()
  const doc = createFakeDocument({
    querySelector(selector) {
      if (selector === '.sidebar') {
        return { getBoundingClientRect: () => ({ width: 240 }) }
      }
      return null
    },
  })
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(true)
    },
    win,
    doc,
  })
  diagnostics.start()
  await Promise.resolve()
  await Promise.resolve()

  win.fire('resize')
  await Promise.resolve()
  const resizeCall = calls.find((call) => call.args?.event === 'Resize')
  assert.equal(resizeCall.args.payload.sidebar_width, 240)
})

test('missing visualViewport is safe', async () => {
  const calls = []
  const win = createFakeWindow({ visualViewport: null })
  const doc = createFakeDocument()
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(true)
    },
    win,
    doc,
  })
  diagnostics.start()
  await Promise.resolve()
  await Promise.resolve()
  win.fire('resize')
  await Promise.resolve()
  const resizeCall = calls.find((call) => call.args?.event === 'Resize')
  assert.equal(resizeCall.args.payload.visual_viewport, null)
})

test('invoke failures are swallowed so diagnostics never break the app', async () => {
  let calls = 0
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const diagnostics = createWindowLifecycleDiagnostics({
    invokeNative: (command) => {
      calls += 1
      if (command === 'is_window_diagnostics_enabled') return Promise.resolve(true)
      return Promise.reject(new Error('not in tauri'))
    },
    win,
    doc,
  })
  diagnostics.start()
  await Promise.resolve()
  await Promise.resolve()
  win.fire('focus')
  await Promise.resolve()
  assert.equal(calls, 3)
})

test('records contain no forbidden metadata keys', () => {
  const forbiddenFragments = ['path', 'repo', 'branch', 'file', 'user', 'host', 'machine', 'account']
  const win = createFakeWindow()
  const doc = createFakeDocument()
  const diagnostics = createWindowLifecycleDiagnostics({ invokeNative: () => Promise.resolve(), win, doc })
  const payload = diagnostics.snapshot()
  const walkKeys = (value) => {
    const keys = []
    if (value && typeof value === 'object') {
      Object.keys(value).forEach((key) => {
        keys.push(key)
        keys.push(...walkKeys(value[key]))
      })
    }
    return keys
  }
  const keys = walkKeys(payload)
  forbiddenFragments.forEach((fragment) => {
    assert.equal(keys.some((key) => key.toLowerCase().includes(fragment)), false, `forbidden key fragment: ${fragment}`)
  })
})
