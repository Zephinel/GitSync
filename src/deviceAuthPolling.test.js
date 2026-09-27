import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./DeviceAuthDialog.jsx', import.meta.url), 'utf8')
const start = source.indexOf('  const startPolling = ')
const end = source.indexOf('\n  const cancelActiveSession', start)
assert.ok(start >= 0 && end > start, 'DeviceAuthDialog polling function must be present')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function harness() {
  const pending = []
  const timers = new Map()
  const pollTimerRef = { current: null }
  const pollIntervalRef = { current: 5000 }
  const epochRef = { current: 1 }
  const sessionIdRef = { current: null }
  let nextTimer = 0
  const schedule = (callback) => {
    const id = ++nextTimer
    timers.set(id, callback)
    return id
  }
  const clear = (id) => timers.delete(id)
  const startPolling = new Function(
    'pollTimerRef', 'pollIntervalRef', 'epochRef', 'sessionIdRef', 'cancelActiveSession', 'invoke',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'setStep', 'setErrorText', 'onAccountUpdate',
    `${source.slice(start, end)}\nreturn startPolling`,
  )(
    pollTimerRef, pollIntervalRef, epochRef, sessionIdRef, () => Promise.resolve(),
    () => {
      const request = deferred()
      pending.push(request)
      return request.promise
    },
    schedule, clear, schedule, clear,
    () => {}, () => {}, () => {},
  )
  return {
    pending, timers, pollTimerRef, epochRef, startPolling,
    fireTimers() {
      const ready = [...timers.entries()]
      for (const [id, callback] of ready) {
        timers.delete(id)
        callback()
      }
    },
  }
}

test('device auth waits for a poll response before sending another request', () => {
  const h = harness()
  h.startPolling('first-code', 5000, 1, 1)
  h.fireTimers()
  assert.equal(h.pending.length, 1)
})

test('a stale poll cannot clear the timer owned by a retried attempt', async () => {
  const h = harness()
  h.startPolling('first-code', 5000, 1, 1)
  h.epochRef.current = 2
  h.timers.delete(h.pollTimerRef.current)
  h.startPolling('second-code', 5000, 2, 2)
  h.pending[1].reject(new Error('authorization_pending'))
  await new Promise(setImmediate)
  assert.equal(h.timers.size, 1)
  h.pending[0].resolve({ login: 'old-account' })
  await new Promise(setImmediate)
  assert.equal(h.timers.size, 1)
})
