import { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import OverlayPortal from '../src/OverlayPortal.jsx'
import '../src/OverlayLayer.css'
import { OVERLAY_LEVEL } from '../src/overlayLayerContract.js'

const laneCases = [
  { level: OVERLAY_LEVEL.workspace, overlayId: 'smoke-workspace', parentOverlayId: '' },
  { level: OVERLAY_LEVEL.dialog, overlayId: 'smoke-dialog', parentOverlayId: 'smoke-workspace' },
  { level: OVERLAY_LEVEL.nested, overlayId: 'smoke-nested', parentOverlayId: 'smoke-dialog' },
]

const peerIds = ['smoke-dialog-a', 'smoke-dialog-b', 'smoke-dialog-c']

function peerPresence(scenario, id) {
  if (scenario === 'ab') return id !== 'smoke-dialog-c'
  if (scenario === 'exit-open' || scenario === 'exit-enter') return id === 'smoke-dialog-b'
  if (scenario === 'exit-enter-pre') return id === 'smoke-dialog-a'
  if (scenario === 'top-exit-pre') return id !== 'smoke-dialog-c'
  if (scenario === 'top-exit') return id === 'smoke-dialog-a'
  if (scenario === 'three') return true
  return false
}

function inspectOverlayContract({ nestedPresent, sameLevelScenario, clicks }) {
  const failures = []
  const laneZIndexes = laneCases.map(({ level, overlayId, parentOverlayId }) => {
    const lane = document.querySelector(`.app-overlay-lane[data-overlay-level="${level}"]`)
    const slot = lane?.querySelector(`.app-overlay-slot[data-overlay-id="${overlayId}"]`)

    if (!lane) {
      failures.push(`${level}: missing lane`)
      return Number.NaN
    }
    if (!slot) {
      if (level === OVERLAY_LEVEL.nested && !nestedPresent) return Number(getComputedStyle(lane).zIndex)
      failures.push(`${level}: missing portal slot`)
      return Number.NaN
    }

    const laneStyle = getComputedStyle(lane)
    const slotStyle = getComputedStyle(slot)
    if (laneStyle.pointerEvents !== 'none') failures.push(`${level}: lane captures pointer events`)
    if (slotStyle.isolation !== 'isolate') failures.push(`${level}: slot is not isolated`)
    const content = slot.querySelector('.app-overlay-slot__content')
    if (slot.dataset.overlayPresence === 'exiting') {
      const pointerBlocked = slot.dataset.overlayPointerBlocked === 'true'
      const expectedPointerEvents = pointerBlocked ? 'none' : 'auto'
      if (slotStyle.pointerEvents !== expectedPointerEvents) {
        failures.push(`${level}: exiting slot pointer protection is ${slotStyle.pointerEvents}, expected ${expectedPointerEvents}`)
      }
    }
    if (slot.dataset.overlayPresence === 'exiting' && !content?.hasAttribute('inert')) {
      failures.push(`${level}: exiting content is not inert`)
    }
    if (!Number.isFinite(Number(slot.dataset.overlayStackOrder))) failures.push(`${level}: missing stack order`)
    if (slot.dataset.overlayId !== overlayId) failures.push(`${level}: overlay id metadata mismatch`)
    if ((slot.dataset.overlayParent || '') !== parentOverlayId) failures.push(`${level}: parent metadata mismatch`)
    if (level === OVERLAY_LEVEL.nested && !nestedPresent && slot.dataset.overlayPresence !== 'exiting') {
      failures.push('nested: hide did not retain an exiting slot')
    }

    return Number(laneStyle.zIndex)
  })

  const peerSlots = peerIds
    .map((overlayId) => document.querySelector(`.app-overlay-slot[data-overlay-id="${overlayId}"]`))
    .filter(Boolean)
  const allRenderableSlots = [...document.querySelectorAll('.app-overlay-slot')]
    .filter((slot) => ['entering', 'open', 'exiting'].includes(slot.dataset.overlayPresence))
  const levelOrder = { workspace: 0, dialog: 1, nested: 2 }
  const semanticTop = allRenderableSlots
    .slice()
    .sort((left, right) => {
      return (levelOrder[right.dataset.overlayLevel] - levelOrder[left.dataset.overlayLevel])
        || (Number(right.dataset.overlayStackOrder) - Number(left.dataset.overlayStackOrder))
    })[0]
  allRenderableSlots.forEach((slot) => {
    const shouldBeBlocked = slot !== semanticTop || slot.dataset.overlayPresence === 'exiting'
    const contentBlocked = slot.querySelector('.app-overlay-slot__content')?.hasAttribute('inert')
    if (contentBlocked !== shouldBeBlocked) {
      failures.push(`${slot.dataset.overlayId}: semantic inert state mismatch`)
    }
  })
  document.querySelectorAll('.app-overlay-slot[data-overlay-presence="exiting"]').forEach((slot) => {
    if (!slot.querySelector('.app-overlay-slot__content')?.hasAttribute('inert')) {
      failures.push(`${slot.dataset.overlayId}: exiting content is not inert`)
    }
  })
  const peerOrders = peerSlots.map((slot) => Number(slot.dataset.overlayStackOrder))
  if (peerOrders.some((order) => !Number.isFinite(order))) failures.push('same-level peer is missing explicit stack order')
  if (sameLevelScenario === 'ab' || sameLevelScenario === 'exit-open' || sameLevelScenario === 'exit-enter') {
    const orderById = Object.fromEntries(peerSlots.map((slot) => [slot.dataset.overlayId, Number(slot.dataset.overlayStackOrder)]))
    if (!(orderById['smoke-dialog-b'] > orderById['smoke-dialog-a'])) {
      failures.push(`same-level peer B is not above peer A: ${peerOrders.join(',')}`)
    }
  }
  if (sameLevelScenario === 'exit-open' || sameLevelScenario === 'exit-enter') {
    const exitingPeer = peerSlots.find((slot) => slot.dataset.overlayId === 'smoke-dialog-a')
    const activePeer = peerSlots.find((slot) => slot.dataset.overlayId === 'smoke-dialog-b')
    if (exitingPeer?.dataset.overlayPresence !== 'exiting') failures.push('same-level peer A did not enter exiting state')
    if (!['entering', 'open'].includes(activePeer?.dataset.overlayPresence)) failures.push('same-level peer B is not active')
  }
  if (sameLevelScenario === 'top-exit') {
    const exitingTop = peerSlots.find((slot) => slot.dataset.overlayId === 'smoke-dialog-b')
    const lowerPeer = peerSlots.find((slot) => slot.dataset.overlayId === 'smoke-dialog-a')
    if (exitingTop?.dataset.overlayPresence !== 'exiting') failures.push('same-level top peer B did not enter exiting state')
    if (!['entering', 'open'].includes(lowerPeer?.dataset.overlayPresence)) failures.push('same-level lower peer A is not active')
    if (semanticTop?.dataset.overlayId !== 'smoke-dialog-b') failures.push(`exiting top peer B lost semantic ownership to ${semanticTop?.dataset.overlayId || 'none'}`)
    if (!lowerPeer?.querySelector('.app-overlay-slot__content')?.hasAttribute('inert')) failures.push('lower peer A became interactive during top peer B exit')
    if ((clicks?.['smoke-dialog-a'] || 0) > 0) failures.push('click-through reached lower peer A during top peer B exit')
  }
  if (sameLevelScenario === 'three' && new Set(peerOrders).size !== peerOrders.length) {
    failures.push(`same-level stack order is not unique: ${peerOrders.join(',')}`)
  }

  if (!(laneZIndexes[0] < laneZIndexes[1] && laneZIndexes[1] < laneZIndexes[2])) {
    failures.push('lane z-index order is not workspace < dialog < nested')
  }

  const orderedRenderableSlots = allRenderableSlots.slice().sort((left, right) => (
      (levelOrder[right.dataset.overlayLevel] - levelOrder[left.dataset.overlayLevel])
      || (Number(right.dataset.overlayStackOrder) - Number(left.dataset.overlayStackOrder))
  ))
  const expectedPointerSlot = orderedRenderableSlots[0]
  const topPointerSlot = allRenderableSlots.find((slot) => slot.dataset.overlayPointerBlocked !== 'true')
  if (topPointerSlot?.dataset.overlayId !== expectedPointerSlot?.dataset.overlayId) {
    failures.push(`pointer owner is ${topPointerSlot?.dataset.overlayId || 'none'}, expected rendered top ${expectedPointerSlot?.dataset.overlayId || 'none'}`)
  }
  const topHit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
  const topHitSlot = topHit?.closest?.('.app-overlay-slot')
  if (topPointerSlot && topHitSlot?.dataset.overlayId !== topPointerSlot.dataset.overlayId) {
    failures.push(`pointer top is ${topHitSlot?.dataset.overlayId || topHit?.tagName || 'none'}, expected ${topPointerSlot.dataset.overlayId}`)
  }

  return {
    failures,
    laneZIndexes,
    peerOrders,
    topHit: topHit?.dataset.smokeId || topHit?.dataset.smokeLevel || topHitSlot?.dataset.overlayId || '',
  }
}

function SmokeButton({ id, level, onClick }) {
  return (
    <button
      className={`overlay-smoke-button overlay-smoke-button--${id.replace('smoke-', '')}`}
      data-smoke-id={id}
      data-smoke-level={level}
      data-overlay-motion="surface"
      type="button"
      onClick={onClick}
    >
      {id}
    </button>
  )
}

function OverlayLayerBrowserSmoke() {
  const [inspection, setInspection] = useState(null)
  const [clicks, setClicks] = useState({})
  const [nestedPresent, setNestedPresent] = useState(true)
  const [nestedExitCompletions, setNestedExitCompletions] = useState(0)
  const [sameLevelScenario, setSameLevelScenario] = useState('none')

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
    setInspection(inspectOverlayContract({ nestedPresent, sameLevelScenario, clicks }))
    })
    return () => window.cancelAnimationFrame(frame)
  }, [clicks, nestedPresent, sameLevelScenario])

  const passed = inspection?.failures.length === 0
  const click = (id) => setClicks((current) => ({ ...current, [id]: (current[id] || 0) + 1 }))

  return (
    <>
      <main className="overlay-smoke-panel">
        <h1>Overlay layer browser smoke</h1>
        <output
          id="overlay-smoke-result"
          data-status={inspection ? (passed ? 'passed' : 'failed') : 'running'}
        >
          {inspection
            ? JSON.stringify({ ...inspection, clicks, nestedPresent, nestedExitCompletions, sameLevelScenario })
            : 'Inspecting runtime overlay contract…'}
        </output>
        <div className="overlay-smoke-controls">
          <button id="overlay-smoke-hide" type="button" onClick={() => setNestedPresent(false)}>Hide nested</button>
          <button id="overlay-smoke-show" type="button" onClick={() => setNestedPresent(true)}>Show nested</button>
          <button id="overlay-smoke-interrupt" type="button" onClick={() => {
            setNestedPresent(false)
            window.setTimeout(() => setNestedPresent(true), 60)
          }}>Interrupt nested exit</button>
          <button id="overlay-smoke-peers" type="button" onClick={() => {
            setNestedPresent(false)
            setSameLevelScenario('ab')
          }}>Dialog A + B</button>
          <button id="overlay-smoke-exit-open" type="button" onClick={() => {
            setNestedPresent(false)
            setSameLevelScenario('ab')
            window.setTimeout(() => setSameLevelScenario('exit-open'), 60)
          }}>A exiting + B open</button>
          <button id="overlay-smoke-exit-enter" type="button" onClick={() => {
            setNestedPresent(false)
            setSameLevelScenario('exit-enter-pre')
            window.setTimeout(() => setSameLevelScenario('exit-enter'), 60)
          }}>A exiting + B entering</button>
          <button id="overlay-smoke-top-exit" type="button" onClick={() => {
            setNestedPresent(false)
            setSameLevelScenario('top-exit-pre')
            window.setTimeout(() => setSameLevelScenario('top-exit'), 1100)
          }}>B topmost exits</button>
          <button id="overlay-smoke-three" type="button" onClick={() => {
            setNestedPresent(false)
            setSameLevelScenario('three')
          }}>Three dialogs</button>
          <button id="overlay-smoke-reset" type="button" onClick={() => {
            setNestedPresent(true)
            setSameLevelScenario('none')
          }}>Reset peers</button>
        </div>
      </main>

      <OverlayPortal
        level={OVERLAY_LEVEL.workspace}
        overlayId="smoke-workspace"
        onEscape={() => setNestedPresent(false)}
      >
        <SmokeButton id="smoke-workspace" level={OVERLAY_LEVEL.workspace} onClick={() => click('smoke-workspace')} />
      </OverlayPortal>

      <OverlayPortal
        level={OVERLAY_LEVEL.dialog}
        overlayId="smoke-dialog"
        parentOverlayId="smoke-workspace"
        onEscape={() => setSameLevelScenario('none')}
      >
        <SmokeButton id="smoke-dialog" level={OVERLAY_LEVEL.dialog} onClick={() => click('smoke-dialog')} />
      </OverlayPortal>

      {peerIds.map((overlayId) => (
        <OverlayPortal
          key={overlayId}
          level={OVERLAY_LEVEL.dialog}
          overlayId={overlayId}
          parentOverlayId="smoke-workspace"
          present={peerPresence(sameLevelScenario, overlayId)}
          onEscape={() => setSameLevelScenario('none')}
        >
          <SmokeButton id={overlayId} level={OVERLAY_LEVEL.dialog} onClick={() => click(overlayId)} />
        </OverlayPortal>
      ))}

      <OverlayPortal
        level={OVERLAY_LEVEL.nested}
        overlayId="smoke-nested"
        parentOverlayId="smoke-dialog"
        present={nestedPresent}
        onEscape={() => setNestedPresent(false)}
        onExitComplete={() => setNestedExitCompletions((current) => current + 1)}
      >
        <SmokeButton id="smoke-nested" level={OVERLAY_LEVEL.nested} onClick={() => click('smoke-nested')} />
      </OverlayPortal>
    </>
  )
}

createRoot(document.getElementById('overlay-smoke-root')).render(<OverlayLayerBrowserSmoke />)
