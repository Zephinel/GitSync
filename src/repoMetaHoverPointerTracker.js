// App-side pointer bookkeeping for the RepoCard metadata hover lifecycle.
//
// The controller (repoMetaHoverController.js) owns the *state* lifecycle: which key is open
// and which owners claim it. This module owns the *DOM integration* lifecycle that the
// controller cannot see:
//
//   - the last *trusted* pointer coordinate, used to hit-test after a layout reposition
//   - the pointer-basis epoch, so a reconcile frame scheduled against an older pointer basis
//     can never run against a newer one
//   - the scheduled reconcile frame, cancelled as soon as that basis is invalidated
//
// The epoch advances whenever the basis a queued frame was computed from stops being valid:
//
//   - a lifecycle active/inactive transition (`setActive`)
//   - the host's unconditional dismissal (`reset`)
//   - the local pointer leaving its region (`invalidatePointerFromLocalLeave`)
//
// Any rAF queued against an older basis is therefore dropped, even if its cancellation races.
//
// Frame coalescing: an active lifecycle receives pointer samples and layout changes
// independently. Pointer samples update the latest *trusted* point; layout changes coalesce
// into at most one current reconcile frame. The frame holds no coordinate — when it runs it
// must still be the current frame, on the same basis epoch, with the lifecycle active and a
// trusted point present — and it hit-tests the point that is trusted at that moment. A
// historical pointer sample therefore never drives reconciliation, and a superseded frame can
// neither run nor clear the bookkeeping of the frame that replaced it.
//
// Why it is a separate, framework-free module: the bugs this closes are all integration-level
// and a pure controller test cannot observe them.
//
//  1. The coordinate used to be written only by the document-level pointer listener, which
//     is installed *only while the lifecycle is active*. The very first hover after an idle
//     period therefore hit-tested with the previous lifecycle's coordinate (or none at all).
//     `seedPointerFromLocalEnter` is now also called from the local enter binding, so the
//     first frame already has the right position.
//  2. Nothing cleared the coordinate when the lifecycle went inactive, so a stale position
//     leaked into the next hover.
//  3. A `requestAnimationFrame` scheduled just before a dismissal could run after a new
//     hover had started and re-close (or mis-close) it. Every frame now carries the epoch it
//     was scheduled in and is dropped unless the epoch and the active flag both still match.
//  4. React may not have removed the document pointer listener yet when a hover is dismissed,
//     so a late `pointermove` could write a coordinate back into an inactive lifecycle. The
//     two writers therefore have DIFFERENT authority: `seedPointerFromLocalEnter` is the only
//     one allowed while inactive (it is what starts a hover), and `recordPointerWhileActive`
//     refuses to write unless the lifecycle is active.
//  5. The coordinate also survived a local `onPointerLeave`, so a layout change during the
//     close delay hit-tested the old inside position, re-entered the region and cancelled the
//     pending close — the surface never went away. `invalidatePointerFromLocalLeave` now drops
//     the basis (without ending the lifecycle) the moment the pointer leaves the region.

function defaultRequestFrame(callback) {
  if (typeof requestAnimationFrame !== 'function') return 0
  return requestAnimationFrame(callback)
}

function defaultCancelFrame(frameId) {
  if (frameId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId)
}

export function createRepoMetaHoverPointerTracker({
  requestFrame = defaultRequestFrame,
  cancelFrame = defaultCancelFrame,
} = {}) {
  let active = false
  let epoch = 0
  let point = null
  let pendingFrame = null

  // Record-aware cancellation. Ownership is given up BEFORE the browser cancellation is
  // attempted, so a callback whose cancellation races still fails its identity check:
  // `pendingFrame !== record`. A bare rAF handle cannot express that — it is only a
  // cancellation token, not an ownership identity.
  function cancelPendingFrame() {
    const record = pendingFrame
    if (!record) return false
    pendingFrame = null
    if (record.id) cancelFrame(record.id)
    return true
  }

  /**
   * Follow the controller's activity signal. Leaving the active state drops the coordinate,
   * cancels the scheduled frame and advances the epoch, so nothing from the finished hover
   * can outlive it. Every transition starts a new epoch.
   */
  function setActive(nextActive) {
    const next = Boolean(nextActive)
    if (next === active) return active
    active = next
    epoch += 1
    if (!next) {
      point = null
      cancelPendingFrame()
    }
    return active
  }

  /**
   * Invalidate everything unconditionally (the host's dismissal authority).
   *
   * This advances the epoch even when the tracker is already inactive, and the controller's
   * own `closeAll()` → `setActive(false)` advances it too. The double increment is
   * deliberate: `setActive(false)` is the activity-lifecycle cleanup, while `reset()` is the
   * host's unconditional invalidation and must hold even if the activity signal never
   * changed (e.g. a dismissal while nothing was owned). Correctness does not depend on the
   * exact value, only on it changing.
   */
  function reset() {
    epoch += 1
    active = false
    point = null
    cancelPendingFrame()
  }

  function setPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    point = { x, y }
    return true
  }

  /**
   * Local fast path (`onPointerEnter` on a hover-region element).
   *
   * This is the ONLY writer allowed while the lifecycle is inactive, because it is precisely
   * what seeds the first coordinate of a new hover: the controller's activity signal only
   * flips after this call. Integration tests pin the ordering (seed, then `enter`).
   */
  function seedPointerFromLocalEnter(event) {
    if (!event) return false
    return setPoint(event.clientX, event.clientY)
  }

  /**
   * Document-level reconciliation path (`pointermove` / `pointerover`).
   *
   * Refuses to write unless the lifecycle is currently active, so a listener React has not
   * removed yet cannot re-pollute a hover that has already been dismissed. The host also
   * guards with `isActive()`; both layers fail closed on purpose.
   */
  function recordPointerWhileActive(event) {
    if (!active || !event) return false
    return setPoint(event.clientX, event.clientY)
  }

  /**
   * Element-level `onPointerLeave`: the pointer left the piece of the local pointer region it
   * was inside, so the stored coordinate is no longer a trusted fact about where the pointer
   * is. Dropping it is what stops a post-layout hit test from re-entering (and thereby
   * cancelling the pending close of) a surface the pointer has already left.
   *
   * This deliberately does NOT end the lifecycle: `active` is untouched, because the surface
   * may still be inside its 180ms close delay, or still owned by focus/explicit. Only the
   * pointer basis is invalidated.
   *
   * The epoch advances because the pointer basis itself changed: a frame queued against the
   * previous basis must not be treated as current, whatever its cancellation outcome. The
   * frame record's identity fence already covers a superseded frame; the epoch additionally
   * records that the basis is invalid, so a stale callback cannot satisfy the basis check
   * either.
   *
   * Returns false when there was nothing to invalidate, so a `pointerleave` following a
   * blocked enter cannot bump the epoch for no reason.
   */
  function invalidatePointerFromLocalLeave() {
    if (point === null && pendingFrame === null) return false
    point = null
    epoch += 1
    cancelPendingFrame()
    return true
  }

  /**
   * Coalesce a layout change into at most one pending reconcile frame.
   *
   * A lifecycle keeps receiving pointer samples and layout changes independently. Pointer
   * samples update the latest *trusted* point; layout changes only decide that a hit test is
   * needed. The frame therefore does NOT capture a coordinate — it reads whatever the trusted
   * point is when it actually runs, so a pointer that moved between scheduling and execution
   * is reconciled at its real position instead of a historical one.
   *
   * The frame carries its own record so a superseded frame can recognise that it is no longer
   * current, which a shared rAF id cannot express. Four independent fences must all hold
   * before the hit test runs:
   *
   *   identity  this is still the current pending frame (survives a racing cancellation)
   *   active    the lifecycle is still running
   *   epoch     the pointer basis was not invalidated (leave / reset / transition)
   *   point     a trusted coordinate still exists
   *
   * Returns false when there is nothing to test (no active lifecycle, or no trusted
   * coordinate) — the caller must NOT fall back to a stale position.
   */
  function scheduleAfterLayout(hitTest) {
    if (!active || point === null) return false
    cancelPendingFrame()
    const record = { id: 0, epoch }
    // Registered before requesting the frame so even a synchronous requestFrame stub sees a
    // consistent ownership state inside the callback.
    pendingFrame = record
    record.id = requestFrame(() => {
      // A newer frame superseded this one: not ours to run, and not ours to clean up. Bailing
      // out first is what stops a stale callback from clearing the current frame's record.
      if (pendingFrame !== record) return
      pendingFrame = null
      if (!active) return
      if (record.epoch !== epoch) return
      if (point === null) return
      // Read the CURRENT trusted point, never a snapshot taken when the frame was queued.
      hitTest({ x: point.x, y: point.y })
    })
    return true
  }

  return {
    setActive,
    reset,
    seedPointerFromLocalEnter,
    recordPointerWhileActive,
    invalidatePointerFromLocalLeave,
    scheduleAfterLayout,
    cancelPendingFrame,
    getPoint: () => (point === null ? null : { x: point.x, y: point.y }),
    getEpoch: () => epoch,
    isActive: () => active,
    hasPendingFrame: () => pendingFrame !== null,
  }
}
