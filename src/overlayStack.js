import { OVERLAY_LEVEL } from './overlayLayerContract.js'

const records = new Map()
let sequence = 0
let escapeListenerInstalled = false
const LEVEL_ORDER = Object.freeze({
  [OVERLAY_LEVEL.workspace]: 0,
  [OVERLAY_LEVEL.dialog]: 1,
  [OVERLAY_LEVEL.nested]: 2,
})

function syncDomState() {
  const renderedTopmost = topmostRenderedRecord()
  for (const record of records.values()) {
    if (!record.element?.toggleAttribute && !record.contentElement?.toggleAttribute) continue
    const rendered = record.active || record.transitioning
    const blocked = !rendered || record !== renderedTopmost
    const contentBlocked = !record.active || record !== renderedTopmost
    const pointerBlocked = !rendered || record !== renderedTopmost
    record.element?.toggleAttribute('aria-hidden', contentBlocked)
    record.contentElement?.toggleAttribute('inert', contentBlocked)
    record.contentElement?.toggleAttribute('aria-hidden', contentBlocked)
    if (record.element) {
      record.element.dataset.overlayBlocked = blocked ? 'true' : 'false'
      record.element.dataset.overlayPointerBlocked = pointerBlocked ? 'true' : 'false'
    }
  }
}

function topmostActiveRecord() {
  return topmostRecord((record) => record.active)
}

function topmostRenderedRecord() {
  return topmostRecord((record) => record.active || record.transitioning)
}

function topmostRecord(predicate) {
  let topmost = null
  for (const record of records.values()) {
    if (predicate && !predicate(record)) continue
    const level = LEVEL_ORDER[record.level] ?? -1
    const topmostLevel = topmost ? (LEVEL_ORDER[topmost.level] ?? -1) : -1
    if (!topmost || level > topmostLevel || (level === topmostLevel && record.order > topmost.order)) {
      topmost = record
    }
  }
  return topmost
}

function handleEscape(event) {
  if (event.key !== 'Escape') return
  const topmost = topmostRenderedRecord()
  if (!topmost) return

  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation?.()
  topmost.onEscape?.()
}

function ensureEscapeListener() {
  if (escapeListenerInstalled || typeof document === 'undefined') return
  document.addEventListener('keydown', handleEscape, true)
  escapeListenerInstalled = true
}

function releaseEscapeListener() {
  if (!escapeListenerInstalled || typeof document === 'undefined' || records.size > 0) return
  document.removeEventListener('keydown', handleEscape, true)
  escapeListenerInstalled = false
}

export function claimOverlayStackOrder(key, { level, overlayId, parentOverlayId = '', onEscape } = {}) {
  const record = records.get(key) || { order: 0 }
  record.level = level
  record.overlayId = overlayId
  record.parentOverlayId = parentOverlayId
  record.order = ++sequence
  record.active = true
  record.transitioning = false
  record.onEscape = onEscape
  records.set(key, record)
  syncDomState()
  ensureEscapeListener()
  return record.order
}

export function updateOverlayStackEntry(key, { active, transitioning = false, onEscape } = {}) {
  const record = records.get(key)
  if (!record) return
  record.active = active === true
  record.transitioning = transitioning === true
  if (onEscape !== undefined) record.onEscape = onEscape
  syncDomState()
}

export function releaseOverlayStackEntry(key) {
  records.delete(key)
  syncDomState()
  releaseEscapeListener()
}

export function registerOverlayStackElement(key, element, contentElement) {
  const record = records.get(key)
  if (!record) return
  record.element = element
  record.contentElement = contentElement
  syncDomState()
}

export function getOverlayStackSnapshot() {
  return [...records.values()]
    .map(({ level, overlayId, parentOverlayId, order, active, transitioning }) => ({
      level,
      overlayId,
      parentOverlayId,
      order,
      active,
      transitioning,
      rendered: active || transitioning,
    }))
    .sort((left, right) => {
      const levelDelta = (LEVEL_ORDER[right.level] ?? -1) - (LEVEL_ORDER[left.level] ?? -1)
      return levelDelta || right.order - left.order
    })
}
