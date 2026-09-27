import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRepoMetaHoverController } from './repoMetaHoverController.js'
import { createRepoMetaHoverPointerTracker } from './repoMetaHoverPointerTracker.js'

// App-integration lifecycle tests.
//
// The controller tests cover state ownership. These cover the other half of the problem:
// the App-side DOM integration that the controller cannot see — the last pointer
// coordinate, the lifecycle epoch, the scheduled reconcile frame — plus the host-level
// composition of the two modules, which is where the three ownership bugs actually lived.

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function createFrameScheduler() {
  let nextId = 1
  const frames = new Map()
  return {
    requestFrame(callback) {
      const id = nextId
      nextId += 1
      frames.set(id, callback)
      return id
    },
    cancelFrame(frameId) {
      frames.delete(frameId)
    },
    flush() {
      const queued = [...frames.values()]
      frames.clear()
      for (const callback of queued) callback()
    },
    // Run exactly one queued callback, in insertion order. Needed to execute a stale frame
    // while a newer one is still queued.
    flushNext() {
      const first = frames.entries().next()
      if (first.done) return false
      const [id, callback] = first.value
      frames.delete(id)
      callback()
      return true
    },
    pendingCount() {
      return frames.size
    },
  }
}

function createClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    setTimeoutFn(callback, delay) {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, at: now + (Number(delay) || 0) })
      return id
    },
    clearTimeoutFn(timerId) {
      timers.delete(timerId)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let pickedId = null
        let pickedTimer = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (pickedTimer === null || timer.at < pickedTimer.at) {
            pickedTimer = timer
            pickedId = id
          }
        }
        if (pickedTimer === null) break
        timers.delete(pickedId)
        now = pickedTimer.at
        pickedTimer.callback()
      }
      now = target
    },
  }
}

// Mirrors the App.jsx composition: controller owns state, tracker owns DOM integration,
// closeAllMetaHover is the single dismissal authority over both.
function createHostHarness({ cancelFrame, isBlocked = () => false } = {}) {
  const clock = createClock()
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: cancelFrame || frames.cancelFrame,
  })
  const controller = createRepoMetaHoverController({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    isBlocked,
    onActivityChange: (value) => tracker.setActive(value),
  })
  const closeAllMetaHover = (reason) => {
    controller.closeAll(reason)
    tracker.reset()
  }
  return { clock, frames, tracker, controller, closeAllMetaHover }
}

// Mirrors App.jsx `enterMetaHoverPointerRegion`: blocked guard -> seed -> enter.
// Used by every region element (trigger, bridge and card) of every key.
function createLocalEnterAuthority({ tracker, controller, isBlocked = () => false }) {
  return (key, event) => {
    if (isBlocked()) return
    tracker.seedPointerFromLocalEnter(event)
    controller.enter(key)
  }
}

// Mirrors App.jsx `leaveMetaHoverPointerRegion`: invalidate the pointer basis -> leave.
// Shared by exactly the same region elements as the enter authority.
function createLocalLeaveAuthority({ tracker, controller }) {
  return (key) => {
    tracker.invalidatePointerFromLocalLeave()
    controller.leave(key)
  }
}

// ---- Integration 1: the local fast path seeds the real coordinate ---------------------

test('Integration 1: a local pointer enter seeds clientX/clientY before any state effect', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })

  // Exactly the first hover after an idle period: nothing is active and no coordinate is known.
  assert.equal(tracker.isActive(), false)
  assert.equal(tracker.getPoint(), null)

  // What the local enter binding does, synchronously, before React state settles.
  assert.equal(tracker.seedPointerFromLocalEnter({ clientX: 120, clientY: 240 }), true)
  assert.deepEqual(tracker.getPoint(), { x: 120, y: 240 })

  // Only now does the controller's activity signal reach the tracker.
  tracker.setActive(true)

  const hits = []
  assert.equal(tracker.scheduleAfterLayout((point) => hits.push(point)), true)
  frames.flush()
  assert.deepEqual(hits, [{ x: 120, y: 240 }], 'the first frame must use the real position')
})

test('the local seed ignores events without usable coordinates', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })
  assert.equal(tracker.seedPointerFromLocalEnter({}), false)
  assert.equal(tracker.seedPointerFromLocalEnter({ clientX: Number.NaN, clientY: 3 }), false)
  assert.equal(tracker.seedPointerFromLocalEnter(null), false)
  assert.equal(tracker.getPoint(), null)
})

// ---- Integration 2: leaving the active lifecycle clears every tracking fact -----------

test('Integration 2: going inactive clears the coordinate, the frame and advances the epoch', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })

  tracker.setActive(true)
  tracker.recordPointerWhileActive({ clientX: 11, clientY: 22 })
  tracker.scheduleAfterLayout(() => {})
  assert.deepEqual(tracker.getPoint(), { x: 11, y: 22 })
  assert.equal(tracker.hasPendingFrame(), true)
  const epoch = tracker.getEpoch()

  tracker.setActive(false)

  assert.equal(tracker.getPoint(), null, 'a stale coordinate must not survive the lifecycle')
  assert.equal(tracker.hasPendingFrame(), false)
  assert.equal(frames.pendingCount(), 0)
  assert.ok(tracker.getEpoch() > epoch, 'the epoch must advance so old frames are dropped')
})

test('reset invalidates tracking unconditionally, even when already inactive', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })

  const epoch = tracker.getEpoch()
  tracker.reset()

  assert.equal(tracker.isActive(), false)
  assert.equal(tracker.getPoint(), null)
  assert.equal(tracker.hasPendingFrame(), false)
  assert.ok(tracker.getEpoch() > epoch)
})

// ---- Integration 3: reconcile frames are fenced to their own lifecycle ---------------

test('Integration 3: a frame from a finished lifecycle cannot hit-test into the next one', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })
  const hits = []

  tracker.setActive(true) // lifecycle A
  tracker.recordPointerWhileActive({ clientX: 10, clientY: 20 })
  tracker.scheduleAfterLayout((point) => hits.push({ lifecycle: 'A', point }))

  tracker.setActive(false) // A ends: its frame is cancelled
  tracker.setActive(true) // lifecycle B
  tracker.recordPointerWhileActive({ clientX: 300, clientY: 400 })
  tracker.scheduleAfterLayout((point) => hits.push({ lifecycle: 'B', point }))

  frames.flush()
  assert.deepEqual(hits, [{ lifecycle: 'B', point: { x: 300, y: 400 } }])
})

test('Integration 3b: even without a cancel, the epoch fence drops a stale frame', () => {
  const frames = createFrameScheduler()
  // Simulate a cancellation race where cancelFrame does not take effect.
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: () => {},
  })
  const hits = []

  tracker.setActive(true)
  tracker.recordPointerWhileActive({ clientX: 10, clientY: 20 })
  tracker.scheduleAfterLayout((point) => hits.push(point))

  tracker.setActive(false)
  tracker.setActive(true)
  frames.flush()

  assert.deepEqual(hits, [], 'the epoch fence alone must prevent the stale frame')
})

test('Integration 3c: a frame is dropped when the lifecycle simply went inactive', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: () => {},
  })
  const hits = []

  tracker.setActive(true)
  tracker.recordPointerWhileActive({ clientX: 10, clientY: 20 })
  tracker.scheduleAfterLayout((point) => hits.push(point))

  tracker.setActive(false)
  frames.flush()

  assert.deepEqual(hits, [], 'an inactive lifecycle must never run a reconcile frame')
})

// ---- Integration 4: never hit-test from an unknown position --------------------------

test('Integration 4: without a real coordinate no frame is scheduled at all', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })

  // A focus-only or explicit-only open has no pointer coordinate.
  tracker.setActive(true)
  const hits = []
  assert.equal(tracker.scheduleAfterLayout(() => hits.push('hit')), false)
  assert.equal(frames.pendingCount(), 0, 'a previous lifecycle position must not be reused')
  frames.flush()
  assert.deepEqual(hits, [])
})

test('a layout pass with no active lifecycle schedules nothing', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })

  tracker.seedPointerFromLocalEnter({ clientX: 5, clientY: 6 }) // coordinate exists, nothing active
  assert.equal(tracker.scheduleAfterLayout(() => {}), false)
  assert.equal(frames.pendingCount(), 0)
})

// ---- Integration 5: host reconciliation must not churn deadlines ---------------------

test('Integration 5: repeated host reconciliation does not extend an existing close deadline', () => {
  const host = createHostHarness()

  host.controller.enter('commit')
  host.clock.advance(600)
  assert.equal(host.controller.getState().openKey, 'commit')

  host.controller.leave('commit') // arms the 180ms close
  host.clock.advance(100)

  // A pointermove storm outside the region, as the document listener would deliver it.
  for (let index = 0; index < 5; index += 1) host.controller.reconcile(null)

  host.clock.advance(79)
  assert.equal(host.controller.getState().openKey, 'commit')
  host.clock.advance(1)
  assert.equal(host.controller.getState().openKey, null, 'the close must land on its original deadline')
})

// ---- host-level ownership behaviour ---------------------------------------------------

test('the "details" action opens the branch surface without forging focus ownership', () => {
  const host = createHostHarness()

  // Exactly what handleBranchAttentionAction does.
  host.controller.openExplicit('branch')

  const opened = host.controller.getState()
  assert.equal(opened.openKey, 'branch')
  assert.equal(opened.explicitKey, 'branch')
  assert.equal(opened.focusKey, null, 'no phantom focus owner may exist for an outside button')

  // The pointer never enters the branch region: an outside reconciliation must still close it.
  host.controller.reconcile(null)
  host.clock.advance(180)

  const closed = host.controller.getState()
  assert.equal(closed.openKey, null, 'an explicit surface must not be pinned forever')
  assert.equal(closed.explicitKey, null)
})

test('an explicit surface hands over to the pointer and then closes normally', () => {
  const host = createHostHarness()

  host.controller.openExplicit('branch')
  host.controller.enter('branch')

  const handedOver = host.controller.getState()
  assert.equal(handedOver.explicitKey, null)
  assert.equal(handedOver.pointerOpenKey, 'branch')
  assert.equal(handedOver.openKey, 'branch')

  host.controller.leave('branch')
  host.clock.advance(180)
  assert.equal(host.controller.getState().openKey, null)
})

test('focus and pointer on different keys converge end to end', () => {
  const host = createHostHarness()

  host.controller.focusEnter('branch')
  host.tracker.recordPointerWhileActive({ clientX: 10, clientY: 10 })
  host.controller.enter('commit')

  const held = host.controller.getState()
  assert.equal(held.openKey, 'branch', 'the focus-owned surface must survive the pointer')
  assert.equal(held.pointerKey, 'commit')
  assert.equal(host.tracker.isActive(), true, 'reconciliation must stay installed while focus owns it')

  host.controller.focusLeave('branch')
  assert.equal(host.controller.getState().pendingOpenKey, 'commit')

  host.clock.advance(600)
  assert.equal(host.controller.getState().openKey, 'commit')

  host.closeAllMetaHover('done')
  assert.equal(host.controller.getState().openKey, null)
  assert.equal(host.tracker.isActive(), false)
  assert.equal(host.tracker.getPoint(), null)
})

test('the App-side dismissal helper resets controller state and pointer tracking together', () => {
  const host = createHostHarness()

  host.controller.enter('branch')
  host.clock.advance(600)
  host.controller.focusEnter('branch')
  host.tracker.recordPointerWhileActive({ clientX: 50, clientY: 60 })
  host.tracker.scheduleAfterLayout(() => {})
  assert.equal(host.tracker.hasPendingFrame(), true)

  host.closeAllMetaHover('window-inactive')

  const state = host.controller.getState()
  assert.equal(state.openKey, null)
  assert.equal(state.focusKey, null)
  assert.equal(state.pointerKey, null)
  assert.equal(state.explicitKey, null)
  assert.equal(state.pendingOpenKey, null)
  assert.equal(state.pendingCloseKey, null)
  assert.equal(host.tracker.getPoint(), null)
  assert.equal(host.tracker.hasPendingFrame(), false)
  assert.equal(host.tracker.isActive(), false)
  assert.equal(host.frames.pendingCount(), 0)
})

test('host reconciliation keeps an open surface alive while the pointer is still inside', () => {
  const host = createHostHarness()

  host.controller.enter('commit')
  host.clock.advance(600)
  host.controller.leave('commit')

  host.controller.reconcile('commit') // the document listener reports the same key
  host.clock.advance(5000)

  assert.equal(host.controller.getState().openKey, 'commit')
})

// ---- tracker writer authority (local seed vs active document record) -------------------

test('the document writer refuses to record while the lifecycle is inactive', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })

  assert.equal(tracker.isActive(), false)
  assert.equal(tracker.recordPointerWhileActive({ clientX: 10, clientY: 20 }), false)
  assert.equal(tracker.getPoint(), null, 'an inactive lifecycle must not gain a coordinate')
})

test('the local seed is allowed while inactive because it starts the hover', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })

  assert.equal(tracker.seedPointerFromLocalEnter({ clientX: 120, clientY: 240 }), true)
  assert.deepEqual(tracker.getPoint(), { x: 120, y: 240 })
})

test('the document writer records normally while the lifecycle is active', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })

  tracker.setActive(true)
  assert.equal(tracker.recordPointerWhileActive({ clientX: 7, clientY: 8 }), true)
  assert.deepEqual(tracker.getPoint(), { x: 7, y: 8 })
})

test('reset clears the coordinate and the active flag', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })

  tracker.setActive(true)
  tracker.recordPointerWhileActive({ clientX: 1, clientY: 2 })
  tracker.reset()

  assert.equal(tracker.isActive(), false)
  assert.equal(tracker.getPoint(), null)
})

test('a stale document event after reset cannot write the coordinate back', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })

  tracker.setActive(true)
  tracker.recordPointerWhileActive({ clientX: 1, clientY: 2 })
  tracker.reset()
  const epochAfterReset = tracker.getEpoch()

  assert.equal(tracker.recordPointerWhileActive({ clientX: 900, clientY: 900 }), false)
  assert.equal(tracker.getPoint(), null, 'the dismissed coordinate must stay gone')
  assert.equal(tracker.getEpoch(), epochAfterReset, 'a rejected write must not touch the epoch')
})

test('reactivating does not resurrect the previous coordinate', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })

  tracker.setActive(true)
  tracker.recordPointerWhileActive({ clientX: 1, clientY: 2 })
  tracker.setActive(false)
  tracker.setActive(true)

  assert.equal(tracker.getPoint(), null, 'the next lifecycle starts without a coordinate')
  assert.equal(tracker.scheduleAfterLayout(() => {}), false)
})

// ---- Integration 6/7: the inactive window cannot be re-polluted ----------------------

function createDocumentPointerHandler({ tracker, reconcilePointer }) {
  // Mirrors the App.jsx document listener exactly.
  return (event) => {
    const target = tracker
    if (!target.isActive()) return
    target.recordPointerWhileActive(event)
    reconcilePointer(event.target)
  }
}

test('Integration 6: an inactive tracker ignores a stale document pointer event entirely', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })
  let reconcileCalls = 0
  const handler = createDocumentPointerHandler({
    tracker,
    reconcilePointer: () => { reconcileCalls += 1 },
  })

  assert.equal(tracker.isActive(), false)
  handler({ clientX: 640, clientY: 480, target: { nodeType: 1 } })

  assert.equal(tracker.getPoint(), null, 'no coordinate may be written while inactive')
  assert.equal(reconcileCalls, 0, 'reconciliation must not run while inactive')
})

test('Integration 7: a local trigger enter seeds first and only then activates', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })
  let pointWhenActivated = 'unset'
  const controller = createRepoMetaHoverController({
    onActivityChange: (value) => {
      if (value && pointWhenActivated === 'unset') pointWhenActivated = tracker.getPoint()
      tracker.setActive(value)
    },
  })

  assert.equal(tracker.isActive(), false)
  // The exact ordering of the App-side authority: blocked guard, then seed, then enter.
  const localEnter = createLocalEnterAuthority({ tracker, controller })
  localEnter('branch', { clientX: 120, clientY: 240 })

  assert.deepEqual(
    pointWhenActivated,
    { x: 120, y: 240 },
    'the coordinate must already exist when the lifecycle activates'
  )
  assert.equal(tracker.isActive(), true)

  const hits = []
  assert.equal(tracker.scheduleAfterLayout((point) => hits.push(point)), true)
  frames.flush()
  assert.deepEqual(hits, [{ x: 120, y: 240 }])
})

// ---- Integration 10-13: blocked local enter must be inert at the App layer ------------

test('Integration 10: a blocked local enter seeds nothing, for every key', () => {
  for (const key of ['path', 'branch', 'commit']) {
    const host = createHostHarness({ isBlocked: () => true })
    const localEnter = createLocalEnterAuthority({
      tracker: host.tracker,
      controller: host.controller,
      isBlocked: () => true,
    })

    // This is the trigger/bridge/card binding for `key`, all of which share one authority.
    localEnter(key, { clientX: 700, clientY: 300 })

    const state = host.controller.getState()
    assert.equal(host.tracker.getPoint(), null, `${key}: blocked local enter must not seed a coordinate`)
    assert.equal(host.tracker.isActive(), false, `${key}: ...and must not activate the tracker`)
    assert.equal(state.openKey, null, `${key}: no surface may open`)
    assert.equal(state.pointerKey, null, `${key}: no pointer fact may be written`)
    assert.equal(state.focusKey, null)
    assert.equal(state.explicitKey, null)
    assert.equal(state.pointerOpenKey, null)
    assert.equal(state.pendingOpenKey, null)
    assert.equal(state.pendingCloseKey, null)
    assert.equal(state.active, false, `${key}: the lifecycle must stay inactive`)
    assert.equal(
      host.tracker.scheduleAfterLayout(() => {}),
      false,
      `${key}: no layout reconciliation may be scheduled`
    )
    host.clock.advance(5000)
    assert.equal(host.controller.getState().openKey, null, `${key}: nothing may open later`)
  }
})

test('Integration 11: a blocked coordinate cannot leak into an explicit lifecycle', () => {
  let blocked = true
  const host = createHostHarness({ isBlocked: () => blocked })
  const localEnter = createLocalEnterAuthority({
    tracker: host.tracker,
    controller: host.controller,
    isBlocked: () => blocked,
  })

  localEnter('branch', { clientX: 700, clientY: 300 })
  assert.equal(host.tracker.getPoint(), null)

  blocked = false
  host.controller.openExplicit('branch')

  const state = host.controller.getState()
  assert.equal(state.openKey, 'branch')
  assert.equal(state.explicitKey, 'branch')
  assert.equal(host.tracker.isActive(), true)
  assert.equal(
    host.tracker.getPoint(),
    null,
    'an explicit lifecycle must not inherit the blocked pointer coordinate'
  )

  let hitTests = 0
  assert.equal(host.tracker.scheduleAfterLayout(() => { hitTests += 1 }), false)
  host.frames.flush()
  assert.equal(hitTests, 0, 'no elementFromPoint hit test may run with the blocked coordinate')
})

test('Integration 12: a blocked coordinate cannot leak into a focus lifecycle', () => {
  let blocked = true
  const host = createHostHarness({ isBlocked: () => blocked })
  const localEnter = createLocalEnterAuthority({
    tracker: host.tracker,
    controller: host.controller,
    isBlocked: () => blocked,
  })

  localEnter('branch', { clientX: 700, clientY: 300 })
  assert.equal(host.tracker.getPoint(), null)

  blocked = false
  host.controller.focusEnter('branch')

  const state = host.controller.getState()
  assert.equal(state.openKey, 'branch')
  assert.equal(state.focusKey, 'branch')
  assert.equal(host.tracker.isActive(), true)
  assert.equal(
    host.tracker.getPoint(),
    null,
    'a focus lifecycle must not inherit the blocked pointer coordinate'
  )

  let hitTests = 0
  assert.equal(host.tracker.scheduleAfterLayout(() => { hitTests += 1 }), false)
  host.frames.flush()
  assert.equal(hitTests, 0, 'no elementFromPoint hit test may run with the blocked coordinate')
})

test('Integration 13: a dropped blocked enter does not disable the next local enter', () => {
  let blocked = true
  const host = createHostHarness({ isBlocked: () => blocked })
  const localEnter = createLocalEnterAuthority({
    tracker: host.tracker,
    controller: host.controller,
    isBlocked: () => blocked,
  })

  localEnter('branch', { clientX: 700, clientY: 300 })
  assert.equal(host.tracker.getPoint(), null)

  blocked = false
  localEnter('branch', { clientX: 333, clientY: 444 })

  assert.deepEqual(host.tracker.getPoint(), { x: 333, y: 444 }, 'the real hover must seed normally')
  assert.equal(host.tracker.isActive(), true)
  assert.equal(host.controller.getState().pendingOpenKey, 'branch')

  host.clock.advance(600)
  assert.equal(host.controller.getState().openKey, 'branch')
})

// ---- Integration 8/9: an inactive stale event cannot seed a later lifecycle ----------

test('Integration 8: an inactive stale event cannot give an explicit lifecycle a coordinate', () => {
  const host = createHostHarness()
  let reconcileCalls = 0
  const handler = createDocumentPointerHandler({
    tracker: host.tracker,
    reconcilePointer: () => { reconcileCalls += 1 },
  })

  // Lifecycle A runs and is then dismissed.
  host.tracker.setActive(true)
  host.tracker.recordPointerWhileActive({ clientX: 100, clientY: 200 })
  host.closeAllMetaHover('window-inactive')
  assert.equal(host.tracker.getPoint(), null)

  // A listener that React has not removed yet still receives a move.
  handler({ clientX: 700, clientY: 300, target: { nodeType: 1 } })
  assert.equal(host.tracker.getPoint(), null, 'the stale event must not seed anything')
  assert.equal(reconcileCalls, 0)

  // Explicit-only lifecycle: no pointer coordinate exists at all.
  host.controller.openExplicit('branch')
  assert.equal(host.controller.getState().openKey, 'branch')
  assert.equal(host.tracker.getPoint(), null)
  assert.equal(
    host.tracker.scheduleAfterLayout(() => { reconcileCalls += 1 }),
    false,
    'a layout pass must not hit-test with the stale coordinate'
  )
  host.frames.flush()
  assert.equal(reconcileCalls, 0)
})

test('Integration 9: an inactive stale event cannot give a focus lifecycle a coordinate', () => {
  const host = createHostHarness()
  let reconcileCalls = 0
  const handler = createDocumentPointerHandler({
    tracker: host.tracker,
    reconcilePointer: () => { reconcileCalls += 1 },
  })

  host.tracker.setActive(true)
  host.tracker.recordPointerWhileActive({ clientX: 100, clientY: 200 })
  host.closeAllMetaHover('window-inactive')

  handler({ clientX: 700, clientY: 300, target: { nodeType: 1 } })

  host.controller.focusEnter('branch')
  assert.equal(host.controller.getState().openKey, 'branch')
  assert.equal(host.tracker.getPoint(), null, 'a focus-only lifecycle must not inherit a stale point')
  assert.equal(host.tracker.scheduleAfterLayout(() => { reconcileCalls += 1 }), false)
  host.frames.flush()
  assert.equal(reconcileCalls, 0)
})

// ---- Integration 14-16: local leave invalidates the pointer basis --------------------

test('Integration 14: a local leave clears the trusted coordinate without ending the lifecycle', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })
  tracker.setActive(true)
  tracker.seedPointerFromLocalEnter({ clientX: 10, clientY: 20 })
  const epoch = tracker.getEpoch()

  assert.equal(tracker.invalidatePointerFromLocalLeave(), true)

  assert.equal(tracker.getPoint(), null, 'the left coordinate is no longer a trusted fact')
  assert.equal(tracker.isActive(), true, 'the lifecycle stays active: a close delay may be pending')
  assert.ok(tracker.getEpoch() > epoch, 'the pointer basis generation must advance')
})

test('a local leave with nothing to invalidate is a no-op', () => {
  const tracker = createRepoMetaHoverPointerTracker({ requestFrame: () => 1, cancelFrame: () => {} })
  tracker.setActive(true)
  const epoch = tracker.getEpoch()

  assert.equal(tracker.invalidatePointerFromLocalLeave(), false)
  assert.equal(tracker.getEpoch(), epoch, 'a stray leave must not bump the epoch')
  assert.equal(tracker.isActive(), true)
})

test('Integration 15: a local leave cancels the scheduled layout reconciliation', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })
  tracker.setActive(true)
  tracker.seedPointerFromLocalEnter({ clientX: 10, clientY: 20 })

  const hits = []
  assert.equal(tracker.scheduleAfterLayout(() => hits.push('hit')), true)
  assert.equal(tracker.hasPendingFrame(), true)

  tracker.invalidatePointerFromLocalLeave()

  assert.equal(tracker.getPoint(), null)
  assert.equal(tracker.hasPendingFrame(), false)
  assert.equal(frames.pendingCount(), 0)
  frames.flush()
  assert.deepEqual(hits, [])
})

test('Integration 16: the epoch fence protects even when the frame cancellation races', () => {
  const frames = createFrameScheduler()
  // Simulate a cancellation race: cancelFrame never takes effect.
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: () => {},
  })
  tracker.setActive(true)
  tracker.seedPointerFromLocalEnter({ clientX: 10, clientY: 20 })

  const hits = []
  tracker.scheduleAfterLayout(() => hits.push('hit'))
  tracker.invalidatePointerFromLocalLeave()

  frames.flush() // the stale frame still runs

  assert.deepEqual(hits, [], 'cancelling alone is not the guarantee; the epoch fence is')
})

// ---- Integration 17-19: a left surface must not be revived by a layout ----------------

test('Integration 17: a layout during the close delay cannot revive the surface that was left', () => {
  const host = createHostHarness()
  const localEnter = createLocalEnterAuthority({ tracker: host.tracker, controller: host.controller })
  const localLeave = createLocalLeaveAuthority({ tracker: host.tracker, controller: host.controller })

  localEnter('branch', { clientX: 100, clientY: 100 })
  host.clock.advance(600)
  assert.equal(host.controller.getState().openKey, 'branch')

  localLeave('branch')

  const left = host.controller.getState()
  assert.equal(left.pendingCloseKey, 'branch', 'the close delay is pending')
  assert.equal(host.tracker.getPoint(), null, 'the inside coordinate is no longer trusted')
  assert.equal(host.tracker.isActive(), true, 'the lifecycle is still active during the delay')

  // A layout change during the close window, e.g. the branch overview arriving.
  let hitTests = 0
  assert.equal(
    host.tracker.scheduleAfterLayout(() => { hitTests += 1 }),
    false,
    'no post-layout hit test may run from a stale inside position'
  )
  host.frames.flush()
  assert.equal(hitTests, 0)
  assert.equal(
    host.controller.getState().pendingCloseKey,
    'branch',
    'nothing may re-enter and cancel the pending close'
  )

  host.clock.advance(179)
  assert.equal(host.controller.getState().openKey, 'branch', 'still open just before the delay elapses')
  host.clock.advance(1)
  assert.equal(host.controller.getState().openKey, null, 'closed on its original deadline')
})

test('Integration 18: trigger -> bridge transfer keeps the surface without re-waiting 600ms', () => {
  const host = createHostHarness()
  const localEnter = createLocalEnterAuthority({ tracker: host.tracker, controller: host.controller })
  const localLeave = createLocalLeaveAuthority({ tracker: host.tracker, controller: host.controller })

  localEnter('branch', { clientX: 100, clientY: 100 })
  host.clock.advance(600)
  assert.equal(host.controller.getState().openKey, 'branch')

  localLeave('branch') // trigger leave
  assert.equal(host.tracker.getPoint(), null)
  assert.equal(host.controller.getState().pendingCloseKey, 'branch')

  host.clock.advance(50)
  localEnter('branch', { clientX: 100, clientY: 110 }) // bridge enter

  const state = host.controller.getState()
  assert.equal(state.openKey, 'branch', 'the surface never dropped')
  assert.equal(state.pendingCloseKey, null, 'the pending close was cancelled')
  assert.equal(state.hasOpenTimer, false, 'the same-key transfer must not re-arm the 600ms delay')
  assert.deepEqual(host.tracker.getPoint(), { x: 100, y: 110 }, 'the bridge coordinate replaces the trigger one')

  host.clock.advance(5000)
  assert.equal(host.controller.getState().openKey, 'branch')
})

test('Integration 19: trigger -> bridge -> card -> outside keeps the surface, then closes', () => {
  const host = createHostHarness()
  const localEnter = createLocalEnterAuthority({ tracker: host.tracker, controller: host.controller })
  const localLeave = createLocalLeaveAuthority({ tracker: host.tracker, controller: host.controller })

  localEnter('branch', { clientX: 100, clientY: 100 })
  host.clock.advance(600)
  assert.equal(host.controller.getState().openKey, 'branch')

  // trigger -> bridge
  localLeave('branch')
  assert.equal(host.tracker.getPoint(), null)
  host.clock.advance(40)
  localEnter('branch', { clientX: 100, clientY: 110 })
  assert.equal(host.controller.getState().openKey, 'branch')

  // bridge -> card
  localLeave('branch')
  assert.equal(host.tracker.getPoint(), null)
  host.clock.advance(40)
  localEnter('branch', { clientX: 120, clientY: 140 })
  const onCard = host.controller.getState()
  assert.equal(onCard.openKey, 'branch')
  assert.equal(onCard.hasOpenTimer, false, 'no hop may re-arm the open delay')
  assert.deepEqual(host.tracker.getPoint(), { x: 120, y: 140 })

  // card -> outside
  localLeave('branch')
  assert.equal(host.tracker.getPoint(), null, 'every leave invalidates the coordinate')
  host.clock.advance(179)
  assert.equal(host.controller.getState().openKey, 'branch')
  host.clock.advance(1)
  assert.equal(host.controller.getState().openKey, null)
})

test('every key shares the same local-leave authority', () => {
  for (const key of ['path', 'branch', 'commit']) {
    const host = createHostHarness()
    const localEnter = createLocalEnterAuthority({ tracker: host.tracker, controller: host.controller })
    const localLeave = createLocalLeaveAuthority({ tracker: host.tracker, controller: host.controller })

    localEnter(key, { clientX: 10, clientY: 20 })
    host.clock.advance(600)
    assert.equal(host.controller.getState().openKey, key)

    localLeave(key)

    assert.equal(host.tracker.getPoint(), null, `${key}: leave must invalidate the coordinate`)
    assert.equal(host.controller.getState().pendingCloseKey, key, `${key}: the close delay is pending`)
    assert.equal(host.tracker.scheduleAfterLayout(() => {}), false, `${key}: no stale hit test`)

    host.clock.advance(180)
    assert.equal(host.controller.getState().openKey, null, `${key}: closes on its deadline`)
  }
})

test('a pointer leave drops the coordinate but never disturbs a focus-owned surface', () => {
  const host = createHostHarness()
  const localEnter = createLocalEnterAuthority({ tracker: host.tracker, controller: host.controller })
  const localLeave = createLocalLeaveAuthority({ tracker: host.tracker, controller: host.controller })

  localEnter('branch', { clientX: 10, clientY: 20 })
  host.clock.advance(600)
  host.controller.focusEnter('branch')

  localLeave('branch')

  const state = host.controller.getState()
  assert.equal(state.focusKey, 'branch', 'real focus still owns the surface')
  assert.equal(state.openKey, 'branch')
  assert.equal(host.tracker.getPoint(), null, 'but the historical pointer position is gone')
  assert.equal(host.tracker.isActive(), true)
  assert.equal(
    host.tracker.scheduleAfterLayout(() => {}),
    false,
    'layout must not reconcile from a historical pointer position'
  )

  host.clock.advance(5000)
  assert.equal(host.controller.getState().openKey, 'branch')
})

test('an explicit surface handed to the pointer closes after a real leave', () => {
  const host = createHostHarness()
  const localEnter = createLocalEnterAuthority({ tracker: host.tracker, controller: host.controller })
  const localLeave = createLocalLeaveAuthority({ tracker: host.tracker, controller: host.controller })

  host.controller.openExplicit('branch')
  localEnter('branch', { clientX: 30, clientY: 40 })
  assert.equal(host.controller.getState().explicitKey, null, 'ownership handed over to the pointer')
  assert.equal(host.controller.getState().openKey, 'branch')

  localLeave('branch')
  assert.equal(host.tracker.getPoint(), null)
  assert.equal(host.controller.getState().pendingCloseKey, 'branch')

  host.clock.advance(180)
  assert.equal(host.controller.getState().openKey, null)
})

test('leaving before the open delay elapses cancels the pending open', () => {
  const host = createHostHarness()
  const localEnter = createLocalEnterAuthority({ tracker: host.tracker, controller: host.controller })
  const localLeave = createLocalLeaveAuthority({ tracker: host.tracker, controller: host.controller })

  localEnter('branch', { clientX: 10, clientY: 20 })
  assert.equal(host.controller.getState().pendingOpenKey, 'branch')
  assert.deepEqual(host.tracker.getPoint(), { x: 10, y: 20 })

  host.clock.advance(200)
  localLeave('branch')

  const left = host.controller.getState()
  assert.equal(left.pendingOpenKey, null, 'the pending open is cancelled')
  assert.equal(host.tracker.getPoint(), null)

  host.clock.advance(5000)
  const settled = host.controller.getState()
  assert.equal(settled.openKey, null)
  assert.equal(settled.active, false, 'no residual lifecycle state')
  assert.equal(settled.hasOpenTimer, false)
  assert.equal(settled.hasCloseTimer, false)
})

// ---- Regression 1-5: reconcile frames are coalesced and identity-fenced --------------

test('Regression 1: a queued frame reconciles with the latest trusted point, not the queued one', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  })
  tracker.setActive(true)
  tracker.seedPointerFromLocalEnter({ clientX: 10, clientY: 20 })

  const hits = []
  assert.equal(tracker.scheduleAfterLayout((point) => hits.push(point)), true)

  // The pointer moves inside the SAME active lifecycle, before the frame runs. The epoch does
  // not change, so only reading the live point can produce the right answer.
  tracker.recordPointerWhileActive({ clientX: 300, clientY: 400 })

  frames.flush()
  assert.deepEqual(hits, [{ x: 300, y: 400 }], 'the frame must use the current trusted point')
})

test('Regression 2: a superseded frame cannot run even when the cancellation races', () => {
  const frames = createFrameScheduler()
  // cancelFrame never takes effect, so both callbacks really are queued.
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: () => {},
  })
  tracker.setActive(true)
  tracker.seedPointerFromLocalEnter({ clientX: 10, clientY: 20 })

  const hits = []
  tracker.scheduleAfterLayout((point) => hits.push({ which: 'A', point }))
  tracker.recordPointerWhileActive({ clientX: 300, clientY: 400 })
  tracker.scheduleAfterLayout((point) => hits.push({ which: 'B', point }))

  frames.flush()
  assert.deepEqual(
    hits,
    [{ which: 'B', point: { x: 300, y: 400 } }],
    'only the current frame may hit-test, and it must use the latest point'
  )
})

test('Regression 3: a stale frame cannot clear the bookkeeping of the current frame', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: () => {},
  })
  tracker.setActive(true)
  tracker.seedPointerFromLocalEnter({ clientX: 10, clientY: 20 })

  const hits = []
  tracker.scheduleAfterLayout((point) => hits.push({ which: 'A', point }))
  tracker.recordPointerWhileActive({ clientX: 300, clientY: 400 })
  tracker.scheduleAfterLayout((point) => hits.push({ which: 'B', point }))

  // Run ONLY the stale A callback.
  assert.equal(frames.flushNext(), true)
  assert.deepEqual(hits, [], 'the stale frame must not hit-test')
  assert.equal(tracker.hasPendingFrame(), true, 'B is still the current pending frame')

  // Now run B.
  assert.equal(frames.flushNext(), true)
  assert.equal(tracker.hasPendingFrame(), false)
  assert.deepEqual(hits, [{ which: 'B', point: { x: 300, y: 400 } }])
})

test('Regression 4: the local-leave epoch fence still holds after the frame refactor', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: () => {},
  })
  tracker.setActive(true)
  tracker.seedPointerFromLocalEnter({ clientX: 10, clientY: 20 })

  const hits = []
  tracker.scheduleAfterLayout((point) => hits.push(point))
  tracker.invalidatePointerFromLocalLeave()

  frames.flush()
  assert.deepEqual(hits, [], 'the basis was invalidated, so the queued frame must not run')
})

test('Regression 5: a frame from a finished lifecycle cannot disturb the next lifecycle frame', () => {
  const frames = createFrameScheduler()
  const tracker = createRepoMetaHoverPointerTracker({
    requestFrame: frames.requestFrame,
    cancelFrame: () => {},
  })
  tracker.setActive(true)
  tracker.seedPointerFromLocalEnter({ clientX: 10, clientY: 20 })
  const hits = []
  tracker.scheduleAfterLayout((point) => hits.push({ which: 'A', point }))

  tracker.setActive(false) // the queued frame is cancelled, but cancelFrame is a no-op
  tracker.setActive(true) // lifecycle B
  tracker.seedPointerFromLocalEnter({ clientX: 300, clientY: 400 })
  tracker.scheduleAfterLayout((point) => hits.push({ which: 'B', point }))

  assert.equal(frames.flushNext(), true) // stale A
  assert.equal(tracker.hasPendingFrame(), true, 'the stale callback must not clear B')
  assert.deepEqual(hits, [])

  assert.equal(frames.flushNext(), true) // B
  assert.equal(tracker.hasPendingFrame(), false)
  assert.deepEqual(hits, [{ which: 'B', point: { x: 300, y: 400 } }])
})

// ---- App wiring guards ----------------------------------------------------------------

test('App.jsx wires the ownership rules these tests depend on', () => {
  const app = readSource('./App.jsx')

  // The "details" action must use explicit ownership, never focus ownership.
  assert.match(app, /metaHoverController\.openExplicit\('branch'\)/)
  assert.doesNotMatch(app, /metaHoverController\.focusEnter\('branch'\)/)

  // focusEnter() may only be reached from the real focus-region capture binding.
  assert.equal(
    (app.match(/metaHoverController\.focusEnter\(/g) || []).length,
    1,
    'focus ownership may only be granted by the real focus capture binding'
  )
  assert.match(app, /bindings\.onFocusCapture = \(\) => metaHoverController\.focusEnter\(key\)/)

  // The local pointer-enter authority must apply the product-level blocked gate BEFORE it
  // writes anything, so a blocked hover can never seed a coordinate.
  const authorityStart = app.indexOf('const enterMetaHoverPointerRegion = useCallback(')
  assert.notEqual(authorityStart, -1, 'the App must expose a single local-enter authority')
  const authorityEnd = app.indexOf('}, [metaHoverController])', authorityStart)
  assert.notEqual(authorityEnd, -1, 'the local-enter authority body must be discoverable')
  const localEnterAuthority = app.slice(authorityStart, authorityEnd)
  const blockedIndex = localEnterAuthority.indexOf('if (metaHoverBlockedRef.current) return')
  const seedIndex = localEnterAuthority.indexOf('seedPointerFromLocalEnter(event)')
  const enterIndex = localEnterAuthority.indexOf('metaHoverController.enter(key)')
  assert.ok(blockedIndex >= 0, 'the local-enter authority must gate on the blocked state')
  assert.ok(seedIndex > blockedIndex, 'the blocked guard must run BEFORE the coordinate is seeded')
  assert.ok(enterIndex > seedIndex, 'seeding must run before delegating to the controller')

  // A single shared factory, so the trigger, the bridge and the card of every key inherit
  // exactly the same gate.
  assert.equal(
    (app.match(/onPointerEnter:/g) || []).length,
    1,
    'the local enter handler must exist once, inside the shared region bindings factory'
  )
  assert.match(app, /onPointerEnter: \(event\) => enterMetaHoverPointerRegion\(key, event\)/)
  // The symmetric leave authority must invalidate the pointer basis BEFORE handing the leave
  // to the controller, so nothing can reconcile against a coordinate the pointer has left.
  const leaveAuthorityStart = app.indexOf('const leaveMetaHoverPointerRegion = useCallback(')
  assert.notEqual(leaveAuthorityStart, -1, 'the App must expose a single local-leave authority')
  const leaveAuthorityEnd = app.indexOf('}, [metaHoverController])', leaveAuthorityStart)
  assert.notEqual(leaveAuthorityEnd, -1, 'the local-leave authority body must be discoverable')
  const localLeaveAuthority = app.slice(leaveAuthorityStart, leaveAuthorityEnd)
  const invalidateIndex = localLeaveAuthority.indexOf('invalidatePointerFromLocalLeave()')
  const controllerLeaveIndex = localLeaveAuthority.indexOf('metaHoverController.leave(key)')
  assert.ok(invalidateIndex >= 0, 'the leave authority must invalidate the pointer basis')
  assert.ok(controllerLeaveIndex > invalidateIndex, 'invalidation must run BEFORE controller.leave')

  // A single shared factory, so the trigger, the bridge and the card of every key inherit
  // exactly the same leave path — no half-fix where the portal keeps the raw call.
  assert.equal(
    (app.match(/onPointerLeave:/g) || []).length,
    1,
    'the local leave handler must exist once, inside the shared region bindings factory'
  )
  assert.match(app, /onPointerLeave: \(\) => leaveMetaHoverPointerRegion\(key\)/)
  assert.doesNotMatch(app, /onPointerLeave: \(\) => metaHoverController\.leave\(key\)/)

  // The document listener must fail closed while the lifecycle is inactive, and must use the
  // active-only writer rather than the permissive local seed.
  assert.match(app, /if \(!tracker\.isActive\(\)\) return/)
  assert.match(app, /tracker\.recordPointerWhileActive\(event\)/)
  const documentPointerHandler = app.slice(
    app.indexOf('const handlePointer = (event) => {'),
    app.indexOf('const dismiss = () => closeAllMetaHover')
  )
  assert.notEqual(documentPointerHandler, '', 'the document pointer handler must exist')
  assert.doesNotMatch(
    documentPointerHandler,
    /seedPointerFromLocalEnter|seedMetaHoverPointerFromLocalEnter/,
    'the document listener must not use the inactive-allowed local seed'
  )

  // The controller's closeAll may only be invoked from the App-side dismissal authority.
  assert.equal(
    (app.match(/metaHoverController\.closeAll\(/g) || []).length,
    1,
    'every dismissal must go through closeAllMetaHover'
  )
  assert.match(app, /const closeAllMetaHover = useCallback\(\(reason\) => \{\s*metaHoverController\.closeAll\(reason\)\s*metaHoverPointerTrackerRef\.current\.reset\(\)/)
  assert.match(app, /closeAllMetaHover\('window-inactive'\)/)
  assert.match(app, /closeAllMetaHover\('visibility'\)|closeAllMetaHover\('window-inactive'\)[\s\S]*visibilitychange/)

  // The post-layout hit test is scheduled through the epoch-fenced tracker.
  assert.match(app, /metaHoverPointerTrackerRef\.current\.scheduleAfterLayout\(/)
  assert.match(app, /onActivityChange: \(value\) => \{\s*metaHoverPointerTrackerRef\.current\.setActive\(value\)/)

  // Pointer region and focus region are distinct concepts.
  assert.match(app, /isTargetInsideMetaPointerRegion/)
  assert.match(app, /isTargetInsideMetaFocusRegion/)
  assert.doesNotMatch(app, /isTargetInsideMetaHoverRegion/)
})
