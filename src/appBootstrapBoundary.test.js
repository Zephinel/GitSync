import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  getOverlayLaneId,
  OVERLAY_ID,
  OVERLAY_LANE_ID,
  OVERLAY_LEVEL,
} from './overlayLayerContract.js'
import {
  claimOverlayStackOrder,
  getOverlayStackSnapshot,
  registerOverlayStackElement,
  releaseOverlayStackEntry,
  updateOverlayStackEntry,
} from './overlayStack.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function fakeElement() {
  const attributes = new Set()
  return {
    dataset: {},
    toggleAttribute(name, force) {
      if (force) attributes.add(name)
      else attributes.delete(name)
    },
    hasAttribute(name) {
      return attributes.has(name)
    },
  }
}

test('root bootstrap hands off after the application subtree commits under StrictMode', () => {
  const main = read('./main.jsx')
  const boundary = read('./AppBootstrapBoundary.jsx')
  const css = read('./AppBootstrapBoundary.css')

  assert.match(main, /import AppBootstrapBoundary from '\.\/AppBootstrapBoundary\.jsx'/)
  assert.match(main, /<StrictMode>[\s\S]*<AppBootstrapBoundary>[\s\S]*<GitSyncApplication \/>[\s\S]*<\/AppBootstrapBoundary>[\s\S]*<\/StrictMode>/)
  assert.match(boundary, /import \{ Component, useCallback, useEffect, useState \} from 'react'/)
  assert.match(boundary, /function BootstrapLoadingShell\(\)/)
  assert.match(boundary, /function BootstrapCommitSignal\(\{ onCommit \}\)/)
  assert.match(boundary, /useEffect\(\(\) => \{\s*onCommit\(\)\s*\}, \[onCommit\]\)/)
  assert.match(boundary, /const \[bootstrapSettled, setBootstrapSettled\] = useState\(false\)/)
  assert.match(boundary, /const settleBootstrap = useCallback\(\(\) => \{\s*setBootstrapSettled\(true\)\s*\}, \[\]\)/)
  assert.match(boundary, /\{!bootstrapSettled \? <BootstrapLoadingShell \/> : null\}/)
  assert.match(boundary, /<AppRuntimeErrorBoundary onRuntimeError=\{settleBootstrap\}>[\s\S]*<BootstrapCommitSignal onCommit=\{settleBootstrap\} \/>[\s\S]*<\/AppRuntimeErrorBoundary>/)
  assert.doesNotMatch(boundary, /MutationObserver|querySelector|setTimeout/)
  assert.match(css, /\.app-bootstrap-root\s*\{[\s\S]*position:\s*relative;[\s\S]*display:\s*flex;/)
  assert.match(css, /\.app-bootstrap-shell\s*\{[\s\S]*position:\s*absolute;[\s\S]*inset:\s*0;[\s\S]*background:\s*var\(--bg-primary\);/)
  assert.match(css, /\.app-bootstrap-root \.app-layout\s*\{[\s\S]*z-index:\s*1;/)
})

test('root bootstrap turns React runtime failures into a visible diagnostic surface and settles the loading shell', () => {
  const boundary = read('./AppBootstrapBoundary.jsx')
  const css = read('./AppBootstrapBoundary.css')

  assert.match(boundary, /class AppRuntimeErrorBoundary extends Component/)
  assert.match(boundary, /static getDerivedStateFromError\(error\)/)
  assert.match(boundary, /componentDidCatch\(error, info\)/)
  assert.match(boundary, /console\.error\('\[GitSync bootstrap\] React runtime failed'/)
  assert.match(boundary, /this\.props\.onRuntimeError\?\.\(error\)/)
  assert.match(boundary, /className="app-bootstrap-error" role="alert"/)
  assert.match(boundary, /GitSync 界面加载失败/)
  assert.match(boundary, /window\.location\.reload\(\)/)
  assert.match(css, /\.app-bootstrap-error\s*\{[\s\S]*z-index:\s*1000;/)
})

test('overlay levels resolve through one explicit root lane contract', () => {
  const html = read('../index.html')
  const css = read('./OverlayLayer.css')
  const main = read('./main.jsx')

  assert.deepEqual(Object.values(OVERLAY_LEVEL), ['workspace', 'dialog', 'nested'])
  assert.equal(new Set(Object.values(OVERLAY_ID)).size, Object.values(OVERLAY_ID).length)
  assert.throws(() => getOverlayLaneId('unknown'), /Unknown overlay level/)
  assert.equal((html.match(/id="app-overlay-root"/g) || []).length, 1)

  for (const level of Object.values(OVERLAY_LEVEL)) {
    assert.equal(getOverlayLaneId(level), OVERLAY_LANE_ID[level])
    assert.match(html, new RegExp(`id="${OVERLAY_LANE_ID[level]}"[^>]*data-overlay-level="${level}"`))
  }
  assert.match(main, /import '\.\/OverlayLayer\.css'/)

  const values = Object.fromEntries(
    [...css.matchAll(/--z-overlay-(workspace|dialog|nested):\s*(\d+);/g)]
      .map((match) => [match[1], Number(match[2])])
  )
  assert.deepEqual(Object.keys(values), Object.values(OVERLAY_LEVEL))
  assert.ok(values.workspace < values.dialog)
  assert.ok(values.dialog < values.nested)
})

test('overlay slots isolate legacy z-index and own one shared presence lifecycle', () => {
  const portal = read('./OverlayPortal.jsx')
  const css = read('./OverlayLayer.css')
  const stack = read('./overlayStack.js')

  assert.match(portal, /getOverlayLaneId\(level\)/)
  assert.match(portal, /present = true/)
  assert.match(portal, /useLayoutEffect\(\(\) => \{[\s\S]*if \(present\)/)
  assert.match(portal, /entering: 'entering'[\s\S]*open: 'open'[\s\S]*exiting: 'exiting'[\s\S]*unmounted: 'unmounted'/)
  assert.match(portal, /retainedChildrenRef/)
  assert.match(portal, /querySelectorAll\('\[data-overlay-motion\]'\)/)
  assert.match(portal, /target\.getAnimations\?\.\(\)/)
  assert.match(portal, /Promise\.allSettled\(animations\.map\(\(animation\) => animation\.finished\)\)/)
  assert.match(portal, /onExitCompleteRef\.current\?\.\(\)/)
  assert.match(portal, /className="app-overlay-slot"/)
  assert.match(portal, /data-overlay-id=\{overlayId \|\| undefined\}/)
  assert.match(portal, /data-overlay-parent=\{parentOverlayId \|\| undefined\}/)
  assert.match(portal, /data-overlay-presence=\{presence\}/)
  assert.match(portal, /data-overlay-stack-order=\{stackOrder \|\| undefined\}/)
  assert.match(portal, /registerOverlayStackElement\(stackKey, slotRef\.current, contentRef\.current\)/)
  assert.match(portal, /claimOverlayStackOrder\(/)
  assert.match(portal, /wasExitingRef/)
  assert.match(css, /\.app-overlay-slot \{[\s\S]*z-index: var\(--overlay-slot-z-index, 0\);[\s\S]*isolation: isolate;/)
  assert.match(css, /\.app-overlay-slot\[data-overlay-presence='exiting'\] \{[\s\S]*pointer-events: auto;/)
  assert.match(css, /\.app-overlay-slot__content > \* \{[\s\S]*pointer-events: auto;/)
  assert.match(css, /\.app-overlay-slot\[data-overlay-presence='exiting'\] \.app-overlay-slot__content > \* \{[\s\S]*pointer-events: none;/)
  assert.doesNotMatch(css, /animation:|transition:/)
  assert.match(stack, /document\.addEventListener\('keydown', handleEscape, true\)/)
  assert.match(stack, /topmostActiveRecord\(\)/)
  assert.match(stack, /const renderedTopmost = topmostRenderedRecord\(\)/)
  assert.match(stack, /function topmostRenderedRecord\(\)/)
  assert.match(stack, /const rendered = record\.active \|\| record\.transitioning/)
  assert.match(stack, /const pointerBlocked = !rendered \|\| record !== renderedTopmost/)
  assert.match(stack, /overlayPointerBlocked/)
  assert.match(stack, /event\.stopImmediatePropagation\?\.\(\)/)
  assert.match(stack, /contentElement\?\.toggleAttribute\('inert', contentBlocked\)/)
  assert.match(stack, /toggleAttribute\('aria-hidden', contentBlocked\)/)
  assert.match(portal, /presenceRef\.current === PRESENCE\.exiting/)
  assert.match(portal, /transitioning: presence === PRESENCE\.exiting/)
})

test('window surfaces declare semantic overlay ownership while commit history stays outside this migration', () => {
  const app = read('./App.jsx')
  const working = read('./WorkingChangesView.jsx')
  const branch = read('./BranchManagementLayer.jsx')
  const attention = read('./BranchAttentionDetailLayer.jsx')
  const stash = read('./stash-manager/StashManagerDialog.jsx')
  const stashSurfaces = read('./stash-manager/StashOperationSurfaces.jsx')
  const createStash = read('./stash-create/CreateStashDialog.jsx')
  const review = read('./ai/AiReviewLayer.jsx')

  assert.match(working, /level=\{OVERLAY_LEVEL\.workspace\}[\s\S]{0,120}overlayId=\{OVERLAY_ID\.workingChanges\}[\s\S]{0,120}present=\{present\}/)
  assert.match(working, /overlayId=\{OVERLAY_ID\.workingChangesOperation\}[\s\S]*parentOverlayId=\{OVERLAY_ID\.workingChanges\}/)
  assert.match(branch, /overlayId=\{OVERLAY_ID\.branchManagement\}[\s\S]{0,120}present=\{expanded\}/)
  assert.match(branch, /overlayId=\{OVERLAY_ID\.branchCreation\}[\s\S]{0,120}parentOverlayId=\{OVERLAY_ID\.branchManagement\}[\s\S]{0,120}present=\{Boolean\(creationTarget\)\}/)
  assert.match(attention, /overlayId=\{OVERLAY_ID\.branchAttentionDelete\}[\s\S]*parentOverlayId=\{OVERLAY_ID\.branchAttention\}/)
  assert.match(stash, /parentOverlayId=\{overlayParentId\}/)
  assert.match(stashSurfaces, /overlayId=\{OVERLAY_ID\.stashOperation\}[\s\S]*parentOverlayId=\{OVERLAY_ID\.stashManager\}/)
  assert.match(createStash, /overlayId=\{OVERLAY_ID\.createStash\}[\s\S]*parentOverlayId=\{OVERLAY_ID\.workingChanges\}/)
  assert.match(review, /overlayId=\{OVERLAY_ID\.aiReviewPreview\}[\s\S]{0,120}parentOverlayId=\{OVERLAY_ID\.workingChanges\}[\s\S]{0,120}present=\{present\}/)

  for (const id of [
    'repoBranchDelete',
    'cloneRepo',
    'githubRepoBrowser',
    'deviceAuth',
    'conflict',
    'errorLog',
    'removeRepo',
    'importResult',
    'syncGuard',
    'scriptLog',
    'notice',
  ]) {
    assert.match(app, new RegExp(`overlayId=\\{OVERLAY_ID\\.${id}\\}[^>]*present=`))
  }

  assert.match(app, /className=\{`commit-history-backdrop/)
  assert.doesNotMatch(app, /OVERLAY_ID\.commitHistory/)
  assert.doesNotMatch(`${working}\n${attention}\n${stash}\n${createStash}`, /createPortal/)
})

test('window callers delegate exit completion without retaining local animation timers', () => {
  const working = read('./WorkingChangesView.jsx')
  const workingOwner = read('./WorkingChangesLayer.jsx')
  const workingCss = read('./WorkingChangesPolish.css')
  const branch = read('./BranchManagementLayer.jsx')
  const portal = read('./OverlayPortal.jsx')

  assert.match(workingOwner, /const \[present, setPresent\] = useState\(false\)/)
  assert.match(workingOwner, /setPresent\(false\)/)
  assert.match(workingOwner, /onExitComplete=\{\(\) => setActiveContext\(null\)\}/)
  assert.match(working, /data-overlay-motion="backdrop"/)
  assert.match(working, /data-overlay-motion="surface"/)
  assert.match(working, /onEscape=\{/)
  assert.match(workingCss, /data-overlay-presence='exiting'/)
  assert.doesNotMatch(working, /CLOSE_FALLBACK|closeFallback|onAnimationEnd/)

  assert.match(branch, /present=\{expanded\}/)
  assert.match(branch, /onExitComplete=\{finishClose\}/)
  assert.doesNotMatch(branch, /CLOSE_FALLBACK|closeFallback|onAnimationEnd/)

  assert.equal((portal.match(/EXIT_SAFETY_TIMEOUT_MS/g) || []).length, 2)
  assert.equal((portal.match(/window\.setTimeout/g) || []).length, 1)
})

test('Working Changes records Stash manager parentage without changing operation intent', () => {
  const entry = read('./WorkingChangesStashEntry.jsx')
  const bridge = read('./stashManagerAppBridge.js')
  const layer = read('./RepoStashManagerLayer.jsx')

  assert.match(entry, /overlayParentId: OVERLAY_ID\.workingChanges/)
  assert.match(bridge, /overlayParentId: String\(input\?\.overlayParentId \|\| ''\)\.trim\(\)/)
  assert.match(layer, /overlayParentId=\{target\.overlayParentId\}/)
  assert.match(bridge, /initialOperation: operation/)
})

test('same-level overlay claims are explicit, monotonic, and releaseable', () => {
  const first = {}
  const second = {}
  const firstOrder = claimOverlayStackOrder(first, { level: 'dialog', overlayId: 'a', parentOverlayId: 'workspace' })
  const secondOrder = claimOverlayStackOrder(second, { level: 'dialog', overlayId: 'b', parentOverlayId: 'workspace' })

  assert.ok(secondOrder > firstOrder)
  assert.deepEqual(getOverlayStackSnapshot().slice(0, 2).map((entry) => entry.overlayId), ['b', 'a'])
  assert.equal(getOverlayStackSnapshot()[0].parentOverlayId, 'workspace')

  updateOverlayStackEntry(second, { active: false })
  assert.deepEqual(getOverlayStackSnapshot().filter((entry) => entry.active).map((entry) => entry.overlayId), ['a'])

  releaseOverlayStackEntry(second)
  releaseOverlayStackEntry(first)
  assert.equal(getOverlayStackSnapshot().length, 0)
})

test('reopening a previously exiting overlay receives a new topmost order', () => {
  const exiting = {}
  const peer = {}
  const initial = claimOverlayStackOrder(exiting, { level: 'dialog', overlayId: 'exiting', parentOverlayId: 'workspace' })
  claimOverlayStackOrder(peer, { level: 'dialog', overlayId: 'peer', parentOverlayId: 'workspace' })
  updateOverlayStackEntry(exiting, { active: false })
  const reopened = claimOverlayStackOrder(exiting, { level: 'dialog', overlayId: 'exiting', parentOverlayId: 'workspace' })

  assert.ok(reopened > initial)
  assert.equal(getOverlayStackSnapshot()[0].overlayId, 'exiting')

  releaseOverlayStackEntry(exiting)
  releaseOverlayStackEntry(peer)
})

test('higher semantic lanes remain topmost over newer lower-lane peers', () => {
  const nested = {}
  const dialog = {}
  claimOverlayStackOrder(nested, { level: 'nested', overlayId: 'nested' })
  claimOverlayStackOrder(dialog, { level: 'dialog', overlayId: 'dialog' })

  assert.equal(getOverlayStackSnapshot()[0].overlayId, 'nested')

  releaseOverlayStackEntry(dialog)
  releaseOverlayStackEntry(nested)
})

test('topmost exiting overlay remains the rendered pointer and Escape barrier until release', () => {
  const first = {}
  const second = {}
  const firstSlot = fakeElement()
  const secondSlot = fakeElement()
  const firstContent = fakeElement()
  const secondContent = fakeElement()
  const escapeCalls = []
  let keydown
  const previousDocument = globalThis.document
  globalThis.document = {
    addEventListener(type, listener) {
      if (type === 'keydown') keydown = listener
    },
    removeEventListener() {},
  }

  try {
    claimOverlayStackOrder(first, {
      level: 'dialog',
      overlayId: 'first',
      onEscape: () => escapeCalls.push('first'),
    })
    registerOverlayStackElement(first, firstSlot, firstContent)
    claimOverlayStackOrder(second, {
      level: 'dialog',
      overlayId: 'second',
      onEscape: () => escapeCalls.push('second'),
    })
    registerOverlayStackElement(second, secondSlot, secondContent)
    updateOverlayStackEntry(second, { active: false, transitioning: true })

    const snapshot = getOverlayStackSnapshot()
    assert.equal(snapshot[0].overlayId, 'second')
    assert.equal(snapshot[0].active, false)
    assert.equal(snapshot[0].transitioning, true)
    assert.equal(snapshot[0].rendered, true)
    assert.equal(firstSlot.dataset.overlayPointerBlocked, 'true')
    assert.equal(secondSlot.dataset.overlayPointerBlocked, 'false')
    assert.equal(firstSlot.hasAttribute('aria-hidden'), true)
    assert.equal(secondSlot.hasAttribute('aria-hidden'), true)
    assert.equal(firstContent.hasAttribute('inert'), true)
    assert.equal(secondContent.hasAttribute('inert'), true)

    keydown?.({
      key: 'Escape',
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    })
    assert.deepEqual(escapeCalls, ['second'])

    updateOverlayStackEntry(second, { active: false, transitioning: false })
    assert.equal(firstSlot.dataset.overlayPointerBlocked, 'false')
    assert.equal(firstSlot.hasAttribute('aria-hidden'), false)
    assert.equal(firstContent.hasAttribute('inert'), false)
  } finally {
    releaseOverlayStackEntry(second)
    releaseOverlayStackEntry(first)
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('an older exiting peer releases its pointer shield to a newer active peer', () => {
  const first = {}
  const second = {}
  const firstSlot = fakeElement()
  const secondSlot = fakeElement()
  const firstContent = fakeElement()
  const secondContent = fakeElement()

  claimOverlayStackOrder(first, { level: 'dialog', overlayId: 'first' })
  registerOverlayStackElement(first, firstSlot, firstContent)
  claimOverlayStackOrder(second, { level: 'dialog', overlayId: 'second' })
  registerOverlayStackElement(second, secondSlot, secondContent)
  updateOverlayStackEntry(first, { active: false, transitioning: true })

  assert.equal(firstSlot.dataset.overlayPointerBlocked, 'true')
  assert.equal(secondSlot.dataset.overlayPointerBlocked, 'false')
  assert.equal(firstSlot.hasAttribute('aria-hidden'), true)
  assert.equal(secondSlot.hasAttribute('aria-hidden'), false)
  assert.equal(firstContent.hasAttribute('inert'), true)
  assert.equal(secondContent.hasAttribute('inert'), false)

  releaseOverlayStackEntry(second)
  releaseOverlayStackEntry(first)
})

test('reopening an exiting overlay clears its transition barrier state', () => {
  const overlay = {}
  const slot = fakeElement()
  const content = fakeElement()

  claimOverlayStackOrder(overlay, { level: 'dialog', overlayId: 'reopen' })
  registerOverlayStackElement(overlay, slot, content)
  updateOverlayStackEntry(overlay, { active: false, transitioning: true })
  assert.equal(content.hasAttribute('inert'), true)

  claimOverlayStackOrder(overlay, { level: 'dialog', overlayId: 'reopen' })
  updateOverlayStackEntry(overlay, { active: true, transitioning: false })
  assert.equal(slot.dataset.overlayPointerBlocked, 'false')
  assert.equal(slot.hasAttribute('aria-hidden'), false)
  assert.equal(content.hasAttribute('inert'), false)

  releaseOverlayStackEntry(overlay)
})
