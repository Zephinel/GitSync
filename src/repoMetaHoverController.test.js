import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createRepoMetaHoverController,
  REPO_META_HOVER_CLOSE_DELAY_MS,
  REPO_META_HOVER_KEYS,
  REPO_META_HOVER_OPEN_DELAY_MS,
} from './repoMetaHoverController.js'

// A deterministic virtual clock. The controller takes its timers by injection, so every
// lifecycle race below is expressed as explicit "the user did X, then 100ms passed".
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
    pendingCount() {
      return timers.size
    },
  }
}

function createHarness(options = {}) {
  const clock = createClock()
  const openChanges = []
  const activityChanges = []
  const controller = createRepoMetaHoverController({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onOpenChange: (key) => openChanges.push(key),
    onActivityChange: (value) => activityChanges.push(value),
    ...options,
  })
  return { clock, controller, openChanges, activityChanges }
}

const DELAYS = {
  open: REPO_META_HOVER_OPEN_DELAY_MS,
  close: REPO_META_HOVER_CLOSE_DELAY_MS,
}

test('the injected delays keep the audited interaction rhythm', () => {
  assert.equal(DELAYS.open, 600)
  assert.equal(DELAYS.close, 180)
  assert.deepEqual([...REPO_META_HOVER_KEYS], ['path', 'branch', 'commit'])
})

test('Race 1: a branch pass-through never strands a previously open commit surface', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'commit')

  controller.leave('commit')
  clock.advance(100) // still inside the 180ms close window
  controller.enter('branch') // must supersede commit, not silently swallow its pending close

  assert.equal(
    controller.getState().openKey,
    null,
    'the previous commit surface must close as soon as a different key supersedes it'
  )
  assert.equal(controller.getState().pendingOpenKey, 'branch')

  clock.advance(100) // still inside branch's own 600ms open window
  controller.leave('branch')
  clock.advance(5000)

  assert.equal(controller.getState().openKey, null, 'no orphan surface may survive')
  assert.equal(controller.getState().pendingOpenKey, null)
  assert.equal(controller.getState().pendingCloseKey, null)
})

test('Race 2: a commit pass-through never strands a previously open branch surface', () => {
  const { clock, controller } = createHarness()

  controller.enter('branch')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')

  controller.leave('branch')
  clock.advance(100)
  controller.enter('commit')
  assert.equal(controller.getState().openKey, null)

  clock.advance(100) // commit has not opened yet
  controller.leave('commit')
  clock.advance(5000)

  assert.equal(controller.getState().openKey, null)
  assert.equal(controller.getState().pendingOpenKey, null)
  assert.equal(controller.getState().pendingCloseKey, null)
})

test('Race 3: same-key bridge transfer keeps the surface open without re-arming the open delay', () => {
  const { clock, controller } = createHarness()

  controller.enter('branch')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')

  controller.leave('branch') // pointer leaves the trigger
  clock.advance(100) // before the 180ms close lands
  controller.enter('branch') // pointer enters the bridge

  const transferred = controller.getState()
  assert.equal(transferred.openKey, 'branch', 'branch must stay open across the bridge')
  assert.equal(transferred.hasOpenTimer, false, 'an already-open key must not re-arm the 600ms open timer')
  assert.equal(transferred.pendingCloseKey, null, 'the pending close must be cancelled')

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'branch', 'the pointer still owns the surface')
})

test('Race 4: trigger -> bridge -> card transfer stays open, then closes 180ms after leaving', () => {
  const { clock, controller } = createHarness()

  controller.enter('branch') // trigger
  clock.advance(DELAYS.open)

  controller.leave('branch')
  clock.advance(50)
  controller.enter('branch') // bridge

  clock.advance(50)
  controller.leave('branch')
  clock.advance(50)
  controller.enter('branch') // card

  assert.equal(controller.getState().openKey, 'branch')
  clock.advance(500)
  assert.equal(controller.getState().openKey, 'branch')

  controller.leave('branch') // genuinely outside the whole region
  clock.advance(DELAYS.close - 1)
  assert.equal(controller.getState().openKey, 'branch', 'still open just before the close delay elapses')
  clock.advance(1)
  assert.equal(controller.getState().openKey, null, 'closed after the close delay')
})

test('Race 5: a superseded open timer cannot reopen the key the pointer left', () => {
  const { clock, controller } = createHarness()

  controller.enter('branch')
  clock.advance(100)
  controller.enter('commit') // intent switched before branch ever opened

  assert.equal(controller.getState().openKey, null)
  assert.equal(controller.getState().pendingOpenKey, 'commit')

  clock.advance(500) // branch's original 600ms deadline passes
  assert.equal(controller.getState().openKey, null, 'the stale branch open must not fire')

  clock.advance(100) // commit's own delay completes
  assert.equal(controller.getState().openKey, 'commit')
})

test('Race 6: re-entering a key cancels its pending close', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)
  controller.leave('commit')
  clock.advance(100)
  controller.enter('commit') // re-owned before the close lands

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'commit', 'the stale close must not fire against a re-owned key')
})

test('Race 6b: a pending close for one key never closes another key', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)
  controller.leave('commit') // pending close(commit)

  controller.enter('branch') // supersede: commit closes now, branch becomes pending
  assert.equal(controller.getState().openKey, null)
  assert.equal(controller.getState().pendingCloseKey, null, 'supersede clears the stale close intent')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')
})

test('Race 7: closeAll clears the open key and every pending timer', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)
  controller.enter('branch') // supersede -> branch pending
  assert.equal(controller.getState().pendingOpenKey, 'branch')

  controller.closeAll('window-inactive')

  const dismissed = controller.getState()
  assert.equal(dismissed.openKey, null)
  assert.equal(dismissed.pendingOpenKey, null)
  assert.equal(dismissed.pendingCloseKey, null)
  assert.equal(dismissed.hasOpenTimer, false)
  assert.equal(dismissed.hasCloseTimer, false)

  clock.advance(5000)
  assert.equal(controller.getState().openKey, null, 'no timer may resurrect a surface after dismissal')
})

test('Race 8: focus ownership keeps the surface alive while the pointer is away', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('branch')
  assert.equal(controller.getState().openKey, 'branch', 'focus opens immediately, without the pointer delay')

  controller.leave('branch') // pointer left, but a keyboard user is still inside the card
  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'branch', 'pointer leave alone must not close a focus-owned surface')

  controller.focusLeave('branch') // focus finally left trigger + card
  clock.advance(DELAYS.close - 1)
  assert.equal(controller.getState().openKey, 'branch')
  clock.advance(1)
  assert.equal(controller.getState().openKey, null)
})

test('Race 8b: focus leaving while the pointer still owns the key does not close it', () => {
  const { clock, controller } = createHarness()

  controller.enter('branch')
  clock.advance(DELAYS.open)
  controller.focusEnter('branch')
  controller.focusLeave('branch') // e.g. focus moves back out, pointer is still on the card

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'branch')
})

test('Race 8c: focus arrival supersedes a different pending key instead of waiting it out', () => {
  const { clock, controller } = createHarness()

  controller.enter('branch') // pending open(branch)
  controller.focusEnter('commit') // keyboard intent wins immediately

  assert.equal(controller.getState().openKey, 'commit')
  assert.equal(controller.getState().pendingOpenKey, null)

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'commit', 'the superseded branch timer must stay dead')
})

test('Race 9: losing hover eligibility resets state and timers deterministically', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'commit')

  controller.invalidate('commit')

  const invalidated = controller.getState()
  assert.equal(invalidated.openKey, null)
  assert.equal(invalidated.pendingOpenKey, null)
  assert.equal(invalidated.pendingCloseKey, null)
  assert.equal(invalidated.hasCloseTimer, false)
  assert.equal(invalidated.active, false)

  // Eligibility can also be lost while the open is still pending.
  controller.enter('commit')
  controller.invalidate('commit')
  assert.equal(controller.getState().pendingOpenKey, null)
  clock.advance(5000)
  assert.equal(controller.getState().openKey, null)
})

test('Race 10: destroy cancels every timer and later callbacks never notify the host', () => {
  const { clock, controller, openChanges } = createHarness()

  controller.enter('commit')
  controller.destroy()

  const destroyed = controller.getState()
  assert.equal(destroyed.destroyed, true)
  assert.equal(destroyed.openKey, null)
  assert.equal(destroyed.hasOpenTimer, false)
  assert.equal(destroyed.hasCloseTimer, false)
  assert.equal(clock.pendingCount(), 0, 'no host timer may survive destroy')

  const notifiedAtDestroy = openChanges.length
  clock.advance(5000)
  assert.equal(openChanges.length, notifiedAtDestroy, 'a stale timer must not set state after unmount')

  controller.enter('branch')
  assert.equal(controller.getState().openKey, null, 'a destroyed controller ignores new intents')
})

test('a global overlay lock vetoes an open that would outlive it', () => {
  let blocked = false
  const { clock, controller } = createHarness({ isBlocked: () => blocked })

  controller.enter('branch')
  blocked = true // e.g. the commit-history handoff starts during the 600ms delay
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, null, 'no hover may open while the overlay owns the dashboard')

  blocked = false
  controller.enter('branch')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')
})

test('a blocked intent also cancels an already pending close', () => {
  let blocked = false
  const { clock, controller } = createHarness({ isBlocked: () => blocked })

  controller.enter('commit')
  clock.advance(DELAYS.open)
  controller.leave('commit') // pending close(commit)

  blocked = true
  controller.enter('commit') // blocked host must drop both intents
  const state = controller.getState()
  assert.equal(state.pendingCloseKey, null)
  assert.equal(state.hasCloseTimer, false)
  assert.equal(state.pendingOpenKey, null)
})

test('reconcile closes a surface the DOM moved out from under a stationary pointer', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'commit')

  controller.reconcile(null) // nothing under the pointer any more
  clock.advance(DELAYS.close - 1)
  assert.equal(controller.getState().openKey, 'commit')
  clock.advance(1)
  assert.equal(controller.getState().openKey, null)
})

test('reconcile is idempotent and never postpones a pending close', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)

  controller.reconcile(null) // arms the close
  clock.advance(100)
  controller.reconcile(null) // a pointermove storm outside must not extend the deadline
  controller.reconcile(null)
  clock.advance(DELAYS.close - 100)
  assert.equal(controller.getState().openKey, null, 'the close must land on its original deadline')
})

test('reconcile lands on the key actually under the pointer', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)

  controller.reconcile('branch') // repositioning exposed the branch trigger instead
  assert.equal(controller.getState().openKey, null, 'the stale commit surface closes immediately')
  assert.equal(controller.getState().pendingOpenKey, 'branch')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')
})

test('reconcile keeps an open surface alive while the pointer is still inside it', () => {
  const { clock, controller } = createHarness()

  controller.enter('commit')
  clock.advance(DELAYS.open)
  controller.leave('commit') // pending close

  controller.reconcile('commit') // still inside the union region
  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'commit')
})

test('reconcile is a no-op while no lifecycle is active', () => {
  const { clock, controller } = createHarness()

  controller.reconcile('branch')
  clock.advance(5000)

  const idle = controller.getState()
  assert.equal(idle.openKey, null)
  assert.equal(idle.pendingOpenKey, null, 'reconciliation must not start a hover on its own')
  assert.equal(idle.active, false)
})

test('activity is reported once per settled transition, without flapping', () => {
  const { clock, controller, activityChanges } = createHarness()

  controller.enter('branch')
  clock.advance(DELAYS.open) // still active: the surface is now open
  controller.leave('branch') // still active: a close is pending
  clock.advance(DELAYS.close) // fully closed

  assert.deepEqual(activityChanges, [true, false], 'installing/removing listeners must not churn')
})

test('the unmount path (closeAll) leaves the controller reusable, unlike destroy', () => {
  // React StrictMode runs an effect cleanup once on the throwaway first mount. The host
  // therefore uses closeAll (cancel timers, reset state) rather than destroy, so hover must
  // still work after that cleanup.
  const { clock, controller } = createHarness()

  controller.enter('branch')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')

  controller.closeAll('unmount')

  const afterCleanup = controller.getState()
  assert.equal(afterCleanup.openKey, null)
  assert.equal(afterCleanup.hasOpenTimer, false)
  assert.equal(afterCleanup.hasCloseTimer, false)
  assert.equal(afterCleanup.destroyed, false)

  controller.enter('branch')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch', 'hover must survive a StrictMode remount')
})

test('every key shares the same open / keep-alive / close contract', () => {
  for (const key of REPO_META_HOVER_KEYS) {
    const { clock, controller } = createHarness()

    controller.enter(key)
    clock.advance(DELAYS.open)
    assert.equal(controller.getState().openKey, key, `${key} must open after its delay`)

    controller.leave(key)
    clock.advance(50)
    controller.enter(key) // trigger -> bridge/card transfer
    assert.equal(controller.getState().openKey, key, `${key} must survive a same-key transfer`)

    controller.leave(key)
    clock.advance(DELAYS.close)
    assert.equal(controller.getState().openKey, null, `${key} must close after the pointer leaves`)
  }
})

test('every ordered key pair supersedes cleanly and converges to closed', () => {
  for (const first of REPO_META_HOVER_KEYS) {
    for (const second of REPO_META_HOVER_KEYS) {
      if (first === second) continue
      const { clock, controller } = createHarness()

      controller.enter(first)
      clock.advance(DELAYS.open)
      assert.equal(controller.getState().openKey, first)

      controller.leave(first)
      clock.advance(60) // still inside the close window
      controller.enter(second)
      assert.equal(
        controller.getState().openKey,
        null,
        `${first} must close immediately when ${second} supersedes it`
      )

      clock.advance(60) // still inside the new key's open window
      controller.leave(second)
      clock.advance(5000)

      const settled = controller.getState()
      assert.equal(settled.openKey, null, `${first} -> ${second} must not strand a surface`)
      assert.equal(settled.pendingOpenKey, null, `${first} -> ${second} must leave no pending open`)
      assert.equal(settled.pendingCloseKey, null, `${first} -> ${second} must leave no pending close`)
    }
  }
})

// ---- ownership precedence: focus > explicit > pointer ---------------------------------

test('Race 11: a pointer entering another key never tears down a focus-owned surface', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('branch')
  assert.equal(controller.getState().openKey, 'branch')

  controller.enter('commit')
  const state = controller.getState()
  assert.equal(state.focusKey, 'branch', 'focus ownership is untouched')
  assert.equal(state.pointerKey, 'commit', 'the pointer fact is still recorded')
  assert.equal(state.openKey, 'branch', 'focus outranks the pointer for the visible projection')
  assert.equal(state.pendingOpenKey, null, 'no pointer open may be armed while focus owns the surface')

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'branch', 'branch must not disappear under the cursor')
})

test('Race 12: releasing focus hands off to the key the pointer really occupies', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('branch')
  controller.enter('commit')
  assert.equal(controller.getState().openKey, 'branch')

  controller.focusLeave('branch')
  const released = controller.getState()
  assert.equal(released.focusKey, null)
  assert.equal(released.openKey, null, 'the focus-owned surface is released')
  assert.equal(released.pointerKey, 'commit', 'the pointer fact survives')
  assert.equal(released.pendingOpenKey, 'commit', 'the pointer lifecycle takes over')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'commit')
})

test('Race 13: the mirror case (focus commit, pointer branch) behaves identically', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('commit')
  controller.enter('branch')

  let state = controller.getState()
  assert.equal(state.openKey, 'commit')
  assert.equal(state.focusKey, 'commit')
  assert.equal(state.pointerKey, 'branch')

  controller.focusLeave('commit')
  state = controller.getState()
  assert.equal(state.openKey, null)
  assert.equal(state.pendingOpenKey, 'branch')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')
})

test('Race 14: real focus outranks pointer ownership and hands back on release', () => {
  const { clock, controller } = createHarness()

  controller.enter('branch')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')

  controller.focusEnter('commit')
  let state = controller.getState()
  assert.equal(state.openKey, 'commit', 'real focus wins immediately')
  assert.equal(state.pointerKey, 'branch', 'the pointer fact is not falsified')
  assert.equal(state.pointerOpenKey, null, 'the pointer claim on branch was released')

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'commit')

  controller.focusLeave('commit')
  state = controller.getState()
  assert.equal(state.openKey, null)
  assert.equal(state.pendingOpenKey, 'branch', 'branch is re-derived from the live pointer fact')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')
})

test('Race 15: invalidating a focus-owned key clears its focus ownership', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('branch')
  assert.equal(controller.getState().openKey, 'branch')

  controller.invalidate('branch')
  const state = controller.getState()
  assert.equal(state.focusKey, null, 'no stale focus owner may survive invalidation')
  assert.equal(state.openKey, null)
  assert.equal(state.pointerOpenKey, null)
  assert.equal(state.active, false)

  clock.advance(5000)
  assert.equal(controller.getState().openKey, null)
})

test('Race 16: closeAll clears focus, pointer and explicit ownership together', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('branch')
  controller.enter('commit') // pointer fact on another key; focus still projects branch
  controller.openExplicit('path') // deliberate intent on a third key

  const before = controller.getState()
  assert.equal(before.focusKey, 'branch')
  assert.equal(before.pointerKey, 'commit')
  assert.equal(before.explicitKey, 'path')
  assert.equal(before.openKey, 'branch', 'focus keeps the visible projection')

  controller.closeAll('dismissed')

  const after = controller.getState()
  assert.equal(after.openKey, null)
  assert.equal(after.focusKey, null)
  assert.equal(after.pointerKey, null)
  assert.equal(after.explicitKey, null)
  assert.equal(after.pointerOpenKey, null)
  assert.equal(after.pendingOpenKey, null)
  assert.equal(after.pendingCloseKey, null)
  assert.equal(after.hasOpenTimer, false)
  assert.equal(after.hasCloseTimer, false)
  assert.equal(after.active, false)

  clock.advance(5000)
  assert.equal(controller.getState().openKey, null, 'no timer may resurrect a dismissed surface')
})

test('Race 17: an explicit open is visible immediately but never forges focus ownership', () => {
  const { clock, controller } = createHarness()

  controller.openExplicit('branch')
  const state = controller.getState()
  assert.equal(state.explicitKey, 'branch')
  assert.equal(state.openKey, 'branch', 'the deliberate surface shows at once')
  assert.equal(state.focusKey, null, 'focusKey may only ever come from real DOM focus')
  assert.equal(state.pointerKey, null, 'and it must not fabricate a pointer fact either')

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'branch', 'an explicit open is not time-limited')
})

test('Race 18: an explicit surface hands over to the pointer and then closes normally', () => {
  const { clock, controller } = createHarness()

  controller.openExplicit('branch')
  assert.equal(controller.getState().explicitKey, 'branch')

  controller.enter('branch')
  let state = controller.getState()
  assert.equal(state.explicitKey, null, 'explicit ownership transfers to the pointer')
  assert.equal(state.pointerOpenKey, 'branch')
  assert.equal(state.openKey, 'branch', 'the surface stays visible across the handover')
  assert.equal(state.hasOpenTimer, false, 'the handover must not re-arm the open delay')

  controller.leave('branch')
  clock.advance(DELAYS.close - 1)
  assert.equal(controller.getState().openKey, 'branch')
  clock.advance(1)
  state = controller.getState()
  assert.equal(state.openKey, null, 'a real leave still closes after the close delay')
  assert.equal(state.explicitKey, null)
})

test('Race 19: global dismissal clears an explicit surface', () => {
  const { clock, controller } = createHarness()

  controller.openExplicit('branch')
  controller.closeAll('window-inactive')

  const state = controller.getState()
  assert.equal(state.openKey, null)
  assert.equal(state.explicitKey, null)
  assert.equal(state.active, false)

  clock.advance(5000)
  assert.equal(controller.getState().openKey, null)
})

test('an explicit surface closes when the pointer reconciles outside every region', () => {
  const { clock, controller } = createHarness()

  controller.openExplicit('branch')
  controller.reconcile(null)

  clock.advance(DELAYS.close - 1)
  assert.equal(controller.getState().openKey, 'branch')
  clock.advance(1)
  const state = controller.getState()
  assert.equal(state.openKey, null)
  assert.equal(state.explicitKey, null, 'the close releases the explicit owner')
})

test('an explicit surface is released when the pointer moves to another key', () => {
  const { clock, controller } = createHarness()

  controller.openExplicit('branch')
  controller.enter('commit')

  const state = controller.getState()
  assert.equal(state.explicitKey, null, 'the pointer supersedes the explicit intent')
  assert.equal(state.openKey, null, 'the explicit surface is not left orphaned')
  assert.equal(state.pendingOpenKey, 'commit')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'commit')
})

test('real focus outranks an explicit open without faking focus ownership', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('commit')
  controller.openExplicit('branch')

  assert.equal(controller.getState().openKey, 'commit', 'focus keeps the visible projection')
  assert.equal(controller.getState().focusKey, 'commit')
  assert.equal(controller.getState().explicitKey, 'branch', 'the deliberate intent is remembered')

  controller.focusLeave('commit')
  assert.equal(controller.getState().openKey, 'branch', 'focus release re-projects the explicit intent')

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'branch')
})

test('focus moving to another key drops a stale explicit claim', () => {
  const { clock, controller } = createHarness()

  controller.openExplicit('branch')
  assert.equal(controller.getState().openKey, 'branch')

  controller.focusEnter('commit')
  assert.equal(controller.getState().openKey, 'commit')
  assert.equal(controller.getState().explicitKey, null, 'the abandoned explicit intent is released')

  controller.focusLeave('commit')
  clock.advance(DELAYS.close)
  assert.equal(controller.getState().openKey, null, 'nothing re-opens the abandoned surface')
})

test('openKey is a projection with focus over explicit over pointer precedence', () => {
  const { clock, controller } = createHarness()

  controller.enter('path')
  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'path')
  assert.equal(controller.getState().pointerOpenKey, 'path')

  controller.openExplicit('branch')
  assert.equal(controller.getState().openKey, 'branch', 'explicit outranks the pointer lifecycle')

  controller.focusEnter('commit')
  assert.equal(controller.getState().openKey, 'commit', 'focus outranks explicit')

  controller.releaseExplicit('branch')
  assert.equal(controller.getState().openKey, 'commit', 'releasing a shadowed owner changes nothing')

  controller.focusLeave('commit')
  assert.equal(controller.getState().openKey, null, 'released focus leaves no surface behind')
})

test('a focus intent never fabricates a pointer position', () => {
  const { controller } = createHarness()

  controller.focusEnter('branch')
  assert.equal(controller.getState().pointerKey, null)

  controller.focusLeave('branch')
  assert.equal(controller.getState().pointerKey, null)
})

test('activity stays true while any ownership slot is occupied', () => {
  const { controller, activityChanges } = createHarness()

  controller.openExplicit('branch')
  assert.equal(controller.getState().active, true)
  assert.deepEqual(activityChanges, [true])

  controller.closeAll('done')
  assert.equal(controller.getState().active, false)
  assert.deepEqual(activityChanges, [true, false])
})

test('a focus owner keeps the lifecycle active so reconciliation stays installed', () => {
  const { controller } = createHarness()

  controller.focusEnter('branch')
  controller.leave('branch') // the pointer fact goes away; real focus still owns the surface

  const state = controller.getState()
  assert.equal(state.active, true, 'uninstalling reconciliation here would strand the surface')
  assert.equal(state.pointerKey, null)
  assert.equal(state.openKey, 'branch')
})

test('invalidating an explicitly opened key clears the explicit ownership', () => {
  const { controller } = createHarness()

  controller.openExplicit('branch')
  controller.invalidate('branch')

  const state = controller.getState()
  assert.equal(state.explicitKey, null)
  assert.equal(state.openKey, null)
  assert.equal(state.active, false)
})

// ---- blocked contract: inert and memoryless -------------------------------------------

test('Race 20: a blocked openExplicit writes no ownership and is not remembered', () => {
  let blocked = true
  const { clock, controller, activityChanges } = createHarness({ isBlocked: () => blocked })

  controller.openExplicit('branch')

  let state = controller.getState()
  assert.equal(state.explicitKey, null)
  assert.equal(state.openKey, null)
  assert.equal(state.pointerOpenKey, null)
  assert.equal(state.pendingOpenKey, null)
  assert.equal(state.pendingCloseKey, null)
  assert.equal(state.active, false)
  assert.deepEqual(activityChanges, [], 'a rejected intent must not emit activity')

  // Unblocking must not replay the rejected intent: the user has to ask again.
  blocked = false
  clock.advance(5000)
  state = controller.getState()
  assert.equal(state.openKey, null, 'a blocked explicit intent must never be deferred')
  assert.equal(state.explicitKey, null)

  controller.openExplicit('branch')
  assert.equal(controller.getState().openKey, 'branch', 'a fresh intent still works')
})

test('Race 21: a blocked focusEnter leaves no stale focus owner', () => {
  let blocked = true
  const { clock, controller } = createHarness({ isBlocked: () => blocked })

  controller.focusEnter('branch')

  let state = controller.getState()
  assert.equal(state.focusKey, null, 'focus must not be recorded while blocked')
  assert.equal(state.openKey, null)
  assert.equal(state.pointerOpenKey, null)
  assert.equal(state.pendingOpenKey, null)
  assert.equal(state.pendingCloseKey, null)
  assert.equal(state.active, false)

  blocked = false
  clock.advance(5000)
  state = controller.getState()
  assert.equal(state.openKey, null, 'branch must not appear without a new real focus event')
  assert.equal(state.focusKey, null)
})

test('Race 22: a blocked pointer enter writes neither ownership nor a pointer fact', () => {
  let blocked = true
  const { clock, controller } = createHarness({ isBlocked: () => blocked })

  controller.enter('path')

  let state = controller.getState()
  assert.equal(state.pointerKey, null, 'a blocked intent leaves no trace at all')
  assert.equal(state.pointerOpenKey, null)
  assert.equal(state.openKey, null)
  assert.equal(state.pendingOpenKey, null)
  assert.equal(state.active, false)

  blocked = false
  clock.advance(5000)
  assert.equal(controller.getState().openKey, null)
})

test('every blocked intent is inert: no ownership, no pending intent, no activity', () => {
  const intents = [
    ['enter', (controller) => controller.enter('branch')],
    ['focusEnter', (controller) => controller.focusEnter('branch')],
    ['openExplicit', (controller) => controller.openExplicit('branch')],
    ['reconcile', (controller) => controller.reconcile('branch')],
  ]

  for (const [name, runIntent] of intents) {
    const { clock, controller, activityChanges } = createHarness({ isBlocked: () => true })
    runIntent(controller)

    const state = controller.getState()
    assert.equal(state.openKey, null, `${name} must not open a surface`)
    assert.equal(state.focusKey, null, `${name} must not set focus ownership`)
    assert.equal(state.explicitKey, null, `${name} must not set explicit ownership`)
    assert.equal(state.pointerOpenKey, null, `${name} must not set pointer ownership`)
    assert.equal(state.pointerKey, null, `${name} must not even write the pointer fact`)
    assert.equal(state.pendingOpenKey, null, `${name} must not leave a pending open`)
    assert.equal(state.pendingCloseKey, null, `${name} must not leave a pending close`)
    assert.equal(state.active, false, `${name} must not activate the lifecycle`)
    assert.deepEqual(activityChanges, [], `${name} must not emit activity`)

    clock.advance(5000)
    assert.equal(controller.getState().openKey, null, `${name} must not open later either`)
  }
})

test('blocked intents do not accumulate into a deferred state', () => {
  let blocked = true
  const { clock, controller } = createHarness({ isBlocked: () => blocked })

  controller.openExplicit('branch')
  controller.focusEnter('commit')
  controller.enter('path')
  controller.reconcile('branch')

  let state = controller.getState()
  assert.equal(state.openKey, null)
  assert.equal(state.explicitKey, null)
  assert.equal(state.focusKey, null)
  assert.equal(state.pointerOpenKey, null)
  assert.equal(state.pointerKey, null)
  assert.equal(state.pendingOpenKey, null)
  assert.equal(state.pendingCloseKey, null)
  assert.equal(state.active, false)

  blocked = false
  clock.advance(5000)
  state = controller.getState()
  assert.equal(state.openKey, null, 'nothing may be replayed on unblock')
  assert.equal(state.active, false)
})

// ---- soft-ownership cleanup vs visible priority ---------------------------------------

test('Race 23: the pointer clears a stale explicit owner even while focus holds the surface', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('branch')
  controller.openExplicit('branch')
  assert.equal(controller.getState().explicitKey, 'branch', 'a shadowed explicit intent exists')
  assert.equal(controller.getState().openKey, 'branch')

  controller.enter('commit')

  const held = controller.getState()
  assert.equal(held.focusKey, 'branch', 'focus ownership is preserved')
  assert.equal(held.pointerKey, 'commit')
  assert.equal(held.explicitKey, null, 'the contradicted explicit owner is released')
  assert.equal(held.openKey, 'branch', 'the focus surface stays visible')
  assert.equal(held.pendingOpenKey, null)

  controller.focusLeave('branch')

  const released = controller.getState()
  assert.equal(released.focusKey, null)
  assert.equal(released.openKey, null)
  assert.equal(released.pointerKey, 'commit')
  assert.equal(released.pendingOpenKey, 'commit')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'commit')
})

test('Race 24: the mirror case (focus commit, explicit commit, pointer branch) behaves the same', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('commit')
  controller.openExplicit('commit')
  controller.enter('branch')

  const held = controller.getState()
  assert.equal(held.focusKey, 'commit')
  assert.equal(held.pointerKey, 'branch')
  assert.equal(held.explicitKey, null)
  assert.equal(held.openKey, 'commit')

  controller.focusLeave('commit')
  const released = controller.getState()
  assert.equal(released.openKey, null)
  assert.equal(released.pendingOpenKey, 'branch')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'branch')
})

test('Race 25: same-key focus + explicit + pointer transfers without reopening', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('branch')
  controller.openExplicit('branch')
  controller.enter('branch') // same key: join, do not reopen

  let state = controller.getState()
  assert.equal(state.explicitKey, null, 'the explicit surface hands over')
  assert.equal(state.pointerOpenKey, 'branch')
  assert.equal(state.focusKey, 'branch')
  assert.equal(state.openKey, 'branch')
  assert.equal(state.hasOpenTimer, false, 'a same-key join must not re-arm the 600ms delay')

  controller.focusLeave('branch')
  state = controller.getState()
  assert.equal(state.focusKey, null)
  assert.equal(state.openKey, 'branch', 'the pointer still owns it')

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'branch')
})

test('Race 26: with focus A, an explicit B contradicted by pointer C is released', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('path') // A
  controller.openExplicit('branch') // B
  controller.enter('commit') // C, and C !== B

  const state = controller.getState()
  assert.equal(state.focusKey, 'path')
  assert.equal(state.explicitKey, null, 'B is released because the pointer went to C')
  assert.equal(state.pointerKey, 'commit')
  assert.equal(state.openKey, 'path', 'focus A keeps the visible projection')
  assert.equal(state.pendingOpenKey, null)

  controller.focusLeave('path')
  assert.equal(controller.getState().pendingOpenKey, 'commit')

  clock.advance(DELAYS.open)
  assert.equal(controller.getState().openKey, 'commit')
})

test('focus A + explicit B + pointer B hands B over to the pointer without a reopen', () => {
  const { clock, controller } = createHarness()

  controller.focusEnter('path') // A
  controller.openExplicit('branch') // B
  controller.enter('branch') // C === B

  let state = controller.getState()
  assert.equal(state.focusKey, 'path')
  assert.equal(state.explicitKey, null, 'B transfers to the pointer')
  assert.equal(state.pointerOpenKey, 'branch')
  assert.equal(state.openKey, 'path', 'focus A keeps the visible projection')
  assert.equal(state.hasOpenTimer, false, 'the handover must not re-arm the delay')

  controller.focusLeave('path')
  state = controller.getState()
  assert.equal(state.openKey, 'branch', 'the pointer-owned surface is projected on focus release')
  assert.equal(state.hasOpenTimer, false)

  clock.advance(5000)
  assert.equal(controller.getState().openKey, 'branch')
})

test('unknown keys are ignored so a typo cannot create an unowned surface', () => {
  const { clock, controller } = createHarness()

  controller.enter('branches')
  controller.focusEnter('')
  controller.invalidate('nope')
  clock.advance(5000)

  const state = controller.getState()
  assert.equal(state.openKey, null)
  assert.equal(state.pendingOpenKey, null)
  assert.equal(state.active, false)
})
