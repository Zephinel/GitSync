// Key-aware lifecycle authority for RepoCard metadata hover surfaces.
//
// Three hover surfaces exist per repository card — `path`, `branch`, `commit` — and each
// one is a *region* made of up to three DOM pieces: the inline trigger, a transparent
// pointer bridge, and a portaled (or inline) hover card. From the user's point of view a
// trigger + bridge + card is one surface: moving between those pieces must never drop it.
//
// This module exists because the previous implementation kept a single pair of shared
// `setTimeout` handles in RepoCard. A single timer pair cannot express *which* key it
// belongs to, so the callbacks had to guess by clearing each other, which stranded a
// surface with the pointer over nothing. The ownership model below replaces the guesswork:
//
//   pointerKey     the key whose region the pointer is really inside (a fact)
//   focusKey       the key whose focus region really holds DOM focus (a fact)
//   explicitKey    a key opened by a deliberate user action (e.g. a "details" button)
//   pointerOpenKey the key the *pointer* lifecycle has opened
//   openKey        PROJECTION of the visible surface — never a raw input fact
//
// Ownership precedence is fixed and total:
//
//   openKey = focusKey ?? explicitKey ?? pointerOpenKey
//
// Rationale for focus > explicit > pointer:
//  - DOM focus is the strongest, most explicit ownership; a pointer passing over a
//    different trigger must never tear down a surface a keyboard user is inside.
//  - An explicit open is a deliberate action, but it is weaker than real focus and it is
//    always released as soon as the pointer or focus really owns the same key.
//  - Pointer ownership is the weakest and the only one that is timing-driven.
//
// Because openKey is derived, event arrival order can no longer decide what is visible.
//
// Invariants this module guarantees (and tests):
//  1. `focusKey` is only ever set by `focusEnter()`. No click, programmatic open or
//     shortcut may forge focus ownership.
//  2. `pointerKey` / `focusKey` are independent facts. A pointer event never clears
//     `focusKey`; a focus event never invents a `pointerKey`.
//  3. `openKey` is a projection, not an input fact.
//  4. Releasing the focus owner re-derives the next surface from the remaining facts.
//  5. A key that has been invalidated cannot stay in any ownership slot.
//  6. `closeAll()` clears every owner and both pending intents.
//  7. Every timer is fenced by pending-record identity plus a generation counter, so a
//     stale callback can never open a key the pointer left or close a re-owned key.
//  8. While `isBlocked()` is true every public intent is INERT and memoryless: no owner, no
//     pointer fact, no pending intent is written, and nothing is remembered for later.
//     Existing surfaces are dismissed by the host (`closeAll`), never by this guard.
//  9. Soft ownership (`explicitKey`) is released for any key the pointer has contradicted,
//     even while a focus owner keeps a different surface visible.
//
// React wiring lives in App.jsx; this module is deliberately framework-free so every race
// is unit-testable with an injected clock.

export const REPO_META_HOVER_KEYS = Object.freeze(['path', 'branch', 'commit'])

const REPO_META_HOVER_KEY_SET = new Set(REPO_META_HOVER_KEYS)

export const REPO_META_HOVER_OPEN_DELAY_MS = 600
export const REPO_META_HOVER_CLOSE_DELAY_MS = 180

function defaultSetTimeout(callback, delay) {
  return setTimeout(callback, delay)
}

function defaultClearTimeout(timerId) {
  clearTimeout(timerId)
}

/**
 * Create the metadata hover lifecycle authority.
 *
 * All injection points exist so the lifecycle can be driven deterministically in tests:
 * `setTimeoutFn` / `clearTimeoutFn` accept a fake clock, and `isBlocked` lets the host
 * veto opening while a global overlay owns the dashboard.
 */
export function createRepoMetaHoverController({
  openDelayMs = REPO_META_HOVER_OPEN_DELAY_MS,
  closeDelayMs = REPO_META_HOVER_CLOSE_DELAY_MS,
  setTimeoutFn = defaultSetTimeout,
  clearTimeoutFn = defaultClearTimeout,
  isBlocked = () => false,
  onOpenChange = () => {},
  onActivityChange = () => {},
  onOpen = () => {},
} = {}) {
  let openKey = null
  let pointerKey = null
  let focusKey = null
  let explicitKey = null
  let pointerOpenKey = null
  let pendingOpen = null
  let pendingClose = null
  let openTimerId = null
  let closeTimerId = null
  let generation = 0
  let active = false
  let destroyed = false

  function computeVisibleOwner() {
    if (focusKey !== null) return focusKey
    if (explicitKey !== null) return explicitKey
    return pointerOpenKey
  }

  // Owner sets always include openKey; focusKey/explicitKey are listed too so the activity
  // signal can never drop to false while an owner still exists (which would uninstall the
  // host's reconciliation listeners mid-lifecycle).
  function computeActive() {
    return openKey !== null
      || pendingOpen !== null
      || focusKey !== null
      || explicitKey !== null
  }

  // Emitted once per settled public operation (and once per fired timer) so a single
  // supersede never flaps the document-level reconciliation listeners off and on.
  function syncActivity() {
    const next = computeActive()
    if (next === active) return
    active = next
    onActivityChange(active)
  }

  function nextGeneration() {
    generation += 1
    return generation
  }

  function cancelPendingOpen() {
    if (openTimerId !== null) {
      clearTimeoutFn(openTimerId)
      openTimerId = null
    }
    pendingOpen = null
  }

  function cancelPendingClose() {
    if (closeTimerId !== null) {
      clearTimeoutFn(closeTimerId)
      closeTimerId = null
    }
    pendingClose = null
  }

  function refreshOpen(reason) {
    const next = computeVisibleOwner()
    if (next === openKey) return
    openKey = next
    onOpenChange(openKey, { reason })
    if (openKey !== null) onOpen(openKey, { reason })
  }

  function releasePointerOwnersExcept(key) {
    if (pointerOpenKey !== null && pointerOpenKey !== key) pointerOpenKey = null
    if (explicitKey !== null && explicitKey !== key) explicitKey = null
  }

  // ---- pointer lifecycle -------------------------------------------------------------

  function scheduleOpen(key) {
    cancelPendingClose()
    cancelPendingOpen()
    const record = { key, generation: nextGeneration() }
    pendingOpen = record
    openTimerId = setTimeoutFn(() => {
      openTimerId = null
      if (destroyed) {
        syncActivity()
        return
      }
      // Identity fence: a later intent replaced this record (different key, cancellation,
      // or closeAll), so this stale callback must not open anything.
      if (pendingOpen !== record) {
        syncActivity()
        return
      }
      // The overlay lock can arrive during the delay (e.g. commit history handoff), focus
      // can take over, or the pointer can leave. None of those may be overridden by a timer.
      if (isBlocked() || focusKey !== null || pointerKey !== key) {
        pendingOpen = null
        syncActivity()
        return
      }
      pendingOpen = null
      pointerOpenKey = key
      refreshOpen('pointer')
      syncActivity()
    }, openDelayMs)
  }

  function scheduleClose(key) {
    cancelPendingClose()
    const record = { key, generation: nextGeneration() }
    pendingClose = record
    closeTimerId = setTimeoutFn(() => {
      closeTimerId = null
      if (destroyed) {
        syncActivity()
        return
      }
      // Identity fence: superseded by a newer intent for any key.
      if (pendingClose !== record) {
        syncActivity()
        return
      }
      pendingClose = null
      // Only the key this close owns may be closed, and only if nothing re-owned it.
      if (openKey !== key) {
        syncActivity()
        return
      }
      // Real focus always wins; a close timer must never remove a focused surface.
      if (focusKey === key) {
        syncActivity()
        return
      }
      if (pointerKey === key) {
        syncActivity()
        return
      }
      // Release the soft owners (explicit can be released by time; focus never can).
      if (pointerOpenKey === key) pointerOpenKey = null
      if (explicitKey === key) explicitKey = null
      refreshOpen('left')
      syncActivity()
    }, closeDelayMs)
  }

  /** Pointer entered a piece of `key`'s pointer region (trigger, bridge or card). */
  function enter(key) {
    if (destroyed || !REPO_META_HOVER_KEY_SET.has(key)) return
    // Blocked must be fully inert: while a global overlay owns the dashboard no ownership,
    // no pointer fact and no pending intent may be written. Dismissing an *already open*
    // surface is the host's job (closeAllMetaHover on overlay takeover), not this guard's.
    if (isBlocked()) {
      cancelPendingOpen()
      cancelPendingClose()
      return
    }
    pointerKey = key

    // Soft ownership that contradicts this pointer intent is released BEFORE the focus
    // priority check. Focus decides which surface stays *visible*; it must not preserve an
    // explicit owner the pointer has already contradicted, otherwise focusLeave() would
    // resurrect that stale explicit surface instead of handing over to the pointer.
    if (explicitKey !== null) {
      if (explicitKey === key) {
        // Same key: the explicit surface hands over to the pointer so it can never pin itself.
        explicitKey = null
        pointerOpenKey = key
        cancelPendingOpen()
        cancelPendingClose()
        refreshOpen('explicit-handed-to-pointer')
        return
      }
      explicitKey = null
      refreshOpen('explicit-released')
    }

    if (focusKey !== null) {
      if (focusKey === key) {
        // The pointer is joining the surface focus already owns, so it must survive focus
        // leaving later.
        pointerOpenKey = key
        cancelPendingClose()
        cancelPendingOpen()
        return
      }
      // Focus owns a DIFFERENT key. Record where the pointer really is, drop any stale
      // pending pointer intent, but never tear down the focus-owned surface. The handoff is
      // decided in focusLeave() from the live pointerKey fact.
      cancelPendingOpen()
      return
    }

    // Already visible through the pointer lifecycle: keep-alive only. Re-arming the 600ms
    // timer here was pointless churn and is what the bridge/card transfer must not do.
    if (pointerOpenKey === key) {
      cancelPendingClose()
      cancelPendingOpen()
      refreshOpen('keep-alive')
      return
    }
    // Same key already pending: keep its original deadline, just drop a pending close.
    if (pendingOpen !== null && pendingOpen.key === key) {
      cancelPendingClose()
      return
    }

    // Different key (or nothing open): supersede. Close the previous pointer surface at once
    // so it cannot linger as an unowned orphan while this key waits out its own delay.
    cancelPendingOpen()
    cancelPendingClose()
    pointerOpenKey = null
    refreshOpen('superseded')
    scheduleOpen(key)
  }

  /** Pointer left a piece of `key`'s pointer region. */
  function leave(key) {
    if (destroyed || !REPO_META_HOVER_KEY_SET.has(key)) return
    if (pointerKey === key) pointerKey = null
    // Real focus owns the surface: a pointer leave must not schedule a close for it.
    if (focusKey === key) return
    if (explicitKey === key) {
      // Pointer left an explicitly opened surface: let the normal close delay run. A
      // re-enter inside the window hands ownership to the pointer instead.
      if (pendingClose === null) scheduleClose(key)
      return
    }
    // Left before it ever opened: cancel the pending open, nothing is visible.
    if (pendingOpen !== null && pendingOpen.key === key) {
      cancelPendingOpen()
      return
    }
    if (pointerOpenKey !== key) return
    scheduleClose(key)
  }

  // ---- focus lifecycle (the only writer of focusKey) ---------------------------------

  /** Real DOM focus entered `key`'s focus region. Opens immediately (keyboard users). */
  function focusEnter(key) {
    if (destroyed || !REPO_META_HOVER_KEY_SET.has(key)) return
    // Blocked is inert and must stay memoryless: a focus that lands while an overlay owns the
    // dashboard is NOT recorded and NOT remembered. If the DOM focus is still there once the
    // overlay ends, a real subsequent focus event (or host reconciliation) re-establishes it.
    if (isBlocked()) {
      cancelPendingOpen()
      cancelPendingClose()
      return
    }
    focusKey = key
    cancelPendingClose()
    cancelPendingOpen()
    // Focus outranks the pointer and explicit ownership; drop their claims on OTHER keys.
    // pointerKey itself is a fact and is deliberately left untouched.
    releasePointerOwnersExcept(key)
    if (explicitKey === key) explicitKey = null
    refreshOpen('focus')
  }

  /**
   * Real DOM focus left `key`'s focus region. The caller only calls this once focus has
   * truly left the region (see the relatedTarget / microtask check in App.jsx), so internal
   * focus moves between card buttons never reach here.
   */
  function focusLeave(key) {
    if (destroyed || !REPO_META_HOVER_KEY_SET.has(key)) return
    if (focusKey === key) focusKey = null
    if (isBlocked()) {
      cancelPendingOpen()
      cancelPendingClose()
      refreshOpen('focus-left')
      return
    }
    // The pointer still really owns this surface: hand ownership back to it.
    if (pointerKey === key) {
      pointerOpenKey = key
      cancelPendingClose()
      cancelPendingOpen()
      refreshOpen('focus-left-pointer-owns')
      return
    }
    // Focus released; re-derive from the remaining facts rather than from event order.
    const pointerIntent = pointerKey
    if (pointerIntent !== null && pointerIntent !== key) {
      // The pointer is somewhere else: close this surface now and hand over to the pointer
      // lifecycle for the key the pointer actually occupies.
      if (pointerOpenKey === key) pointerOpenKey = null
      refreshOpen('focus-released')
      // Only arm a fresh delay when the pointer lifecycle does not already own that key —
      // e.g. an explicit open that was handed to the pointer must not be reopened.
      if (pointerOpenKey !== pointerIntent) scheduleOpen(pointerIntent)
      return
    }
    if (pendingOpen !== null && pendingOpen.key === key) cancelPendingOpen()
    if (explicitKey !== null) {
      refreshOpen('explicit')
      return
    }
    if (pointerOpenKey === key || openKey === key) scheduleClose(key)
    else refreshOpen('focus-left')
  }

  // ---- explicit lifecycle (deliberate user action, never focus) ----------------------

  /**
   * A deliberate user action (e.g. a "details" button) asked for `key` to be shown.
   * This NEVER sets focusKey: focus ownership may only come from real DOM focus.
   * Real focus keeps precedence; the explicit intent is remembered and projected once focus
   * is released.
   */
  function openExplicit(key) {
    if (destroyed || !REPO_META_HOVER_KEY_SET.has(key)) return
    // Blocked is inert and must not retain a deferred intent: an explicit open requested while
    // the overlay owns the dashboard is simply dropped. The user has to ask again afterwards.
    if (isBlocked()) {
      cancelPendingOpen()
      cancelPendingClose()
      return
    }
    explicitKey = key
    cancelPendingOpen()
    cancelPendingClose()
    releasePointerOwnersExcept(key)
    refreshOpen('explicit')
  }

  /** Release an explicit open without opening anything else. */
  function releaseExplicit(key) {
    if (destroyed) return
    if (key && explicitKey !== key) return
    explicitKey = null
    refreshOpen('explicit-released')
  }

  // ---- reconciliation / dismissal ----------------------------------------------------

  /**
   * Document-level reconciliation. `insideKey` is the key whose pointer region currently
   * contains the real pointer target (or null). This is the fallback that closes a surface
   * the DOM moved out from under a stationary pointer, where no leave event was delivered.
   * It is idempotent: repeated calls never extend an existing deadline.
   */
  function reconcile(insideKey) {
    if (destroyed) return
    // Blocked is inert: pointer reconciliation must not write ownership while an overlay owns
    // the dashboard. Dismissing an existing surface is the host's job.
    if (isBlocked()) return
    if (!computeActive()) return
    const key = REPO_META_HOVER_KEY_SET.has(insideKey) ? insideKey : null
    if (key !== null) {
      enter(key)
      return
    }
    if (pendingOpen !== null) cancelPendingOpen()
    pointerKey = null
    if (openKey === null) return
    if (focusKey === openKey) return
    // Only arm one close; a pointermove storm outside must not postpone it forever.
    if (pendingClose !== null) return
    scheduleClose(openKey)
  }

  /**
   * The key stopped being eligible to render (e.g. the commit summary is no longer
   * truncated). Fail closed in every ownership slot instead of relying on the portal simply
   * not rendering.
   */
  function invalidate(key) {
    if (destroyed || !REPO_META_HOVER_KEY_SET.has(key)) return
    if (pendingOpen !== null && pendingOpen.key === key) cancelPendingOpen()
    if (pendingClose !== null && pendingClose.key === key) cancelPendingClose()
    if (pointerKey === key) pointerKey = null
    if (focusKey === key) focusKey = null
    if (explicitKey === key) explicitKey = null
    if (pointerOpenKey === key) pointerOpenKey = null
    refreshOpen('invalidated')
  }

  /** Deterministic global dismissal: window blur, visibility hidden, overlay, unmount. */
  function closeAll(reason = 'dismissed') {
    if (destroyed) return
    cancelPendingOpen()
    cancelPendingClose()
    pointerKey = null
    focusKey = null
    explicitKey = null
    pointerOpenKey = null
    refreshOpen(reason)
  }

  /**
   * Tear down for unmount. Deliberately silent: the host is going away, so it must not be
   * asked to set state, and no timer may fire afterwards.
   */
  function destroy() {
    if (destroyed) return
    if (openTimerId !== null) clearTimeoutFn(openTimerId)
    if (closeTimerId !== null) clearTimeoutFn(closeTimerId)
    openTimerId = null
    closeTimerId = null
    pendingOpen = null
    pendingClose = null
    openKey = null
    pointerKey = null
    focusKey = null
    explicitKey = null
    pointerOpenKey = null
    active = false
    destroyed = true
  }

  function getState() {
    return {
      openKey,
      pendingOpenKey: pendingOpen ? pendingOpen.key : null,
      pendingCloseKey: pendingClose ? pendingClose.key : null,
      pointerKey,
      focusKey,
      explicitKey,
      pointerOpenKey,
      generation,
      hasOpenTimer: openTimerId !== null,
      hasCloseTimer: closeTimerId !== null,
      active,
      destroyed,
    }
  }

  // Every public intent settles its activity signal exactly once, no matter which path it
  // took, so the host can install/remove document listeners without churn.
  function withActivitySync(fn) {
    return (...args) => {
      const result = fn(...args)
      syncActivity()
      return result
    }
  }

  return {
    enter: withActivitySync(enter),
    leave: withActivitySync(leave),
    focusEnter: withActivitySync(focusEnter),
    focusLeave: withActivitySync(focusLeave),
    openExplicit: withActivitySync(openExplicit),
    releaseExplicit: withActivitySync(releaseExplicit),
    reconcile: withActivitySync(reconcile),
    invalidate: withActivitySync(invalidate),
    closeAll: withActivitySync(closeAll),
    destroy,
    getState,
  }
}
