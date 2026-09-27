import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computeFloatingMenuPosition } from './stashFloatingMenuPosition.js'
import { formatStashRelativeDate } from './stashRelativeTime.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Stash action menus escape scroll and paint containment through one viewport portal authority', () => {
  const actions = read('./StashEntryActionMenu.jsx')
  const css = read('./StashEntryActionMenu.css')
  const table = read('./stash-manager/StashManagerTable.css')
  const popover = read('./StashManagementPopover.jsx')

  assert.match(table, /\.stash-manager-table-scroll \{[\s\S]*overflow: auto;/)
  assert.match(table, /\.stash-manager-table-row \{[\s\S]*contain: layout paint style;/)
  assert.match(actions, /import \{ createPortal \} from 'react-dom'/)
  assert.match(actions, /computeFloatingMenuPosition/)
  assert.match(actions, /trigger\.getBoundingClientRect\(\)/)
  assert.match(actions, /Math\.max\(panel\.scrollHeight, panelRect\.height\)/)
  assert.match(actions, /document\.addEventListener\('scroll', schedulePosition, true\)/)
  assert.match(actions, /data-stash-entry-action-menu-layer="true"/)
  assert.match(actions, /\), document\.body\)/)
  assert.match(css, /\.stash-entry-action-menu__panel \{[^}]*position: fixed;/)
  assert.doesNotMatch(css, /\.stash-entry-action-menu__panel \{[^}]*position: absolute;/)
  assert.match(popover, /isStashActionMenuLayerTarget/)
  assert.match(popover, /onOpenChange=\{setActionMenuOpen\}/)
  assert.match(popover, /formatStashRelativeDate/)
  assert.doesNotMatch(popover, /function formatDate\(/)
})

test('ported Stash action menus stay above the full manager backdrop', () => {
  const app = read('./App.css')
  const actions = read('./StashEntryActionMenu.css')
  const dialog = read('./StashManagerDialog.css')
  const actionLayer = app.match(/--z-stash-entry-action-menu:\s*(\d+)/)
  const managerLayer = dialog.match(/\.stash-manager-backdrop\s*\{[\s\S]*?z-index:\s*(\d+)/)

  assert.ok(actionLayer, 'App.css must define a dedicated Stash action-menu portal layer')
  assert.ok(managerLayer, 'StashManagerDialog.css must define the manager backdrop layer')
  assert.match(actions, /z-index:\s*var\(--z-stash-entry-action-menu\)/)
  assert.ok(
    Number(actionLayer[1]) > Number(managerLayer[1]),
    'the body-level action-menu portal must paint above the full Stash manager',
  )
})

test('floating Stash menu keeps right alignment when the preferred bottom side fits', () => {
  assert.deepEqual(computeFloatingMenuPosition({
    triggerRect: { top: 100, bottom: 130, right: 500 },
    menuRect: { width: 188, height: 200 },
    viewportWidth: 800,
    viewportHeight: 600,
    preferredPlacement: 'bottom',
  }), {
    placement: 'bottom',
    top: 136,
    left: 312,
    maxHeight: 456,
    maxWidth: 784,
  })
})

test('floating Stash menu flips above from real viewport space instead of row index guesses', () => {
  assert.deepEqual(computeFloatingMenuPosition({
    triggerRect: { top: 500, bottom: 530, right: 780 },
    menuRect: { width: 188, height: 200 },
    viewportWidth: 800,
    viewportHeight: 600,
    preferredPlacement: 'bottom',
  }), {
    placement: 'top',
    top: 294,
    left: 592,
    maxHeight: 486,
    maxWidth: 784,
  })
})

test('floating Stash menu clamps horizontally and chooses the larger side when neither side fully fits', () => {
  const clamped = computeFloatingMenuPosition({
    triggerRect: { top: 100, bottom: 130, right: 100 },
    menuRect: { width: 188, height: 120 },
    viewportWidth: 800,
    viewportHeight: 600,
  })
  assert.equal(clamped.left, 8)

  const constrained = computeFloatingMenuPosition({
    triggerRect: { top: 300, bottom: 330, right: 500 },
    menuRect: { width: 188, height: 1000 },
    viewportWidth: 800,
    viewportHeight: 600,
  })
  assert.equal(constrained.placement, 'top')
  assert.equal(constrained.top, 8)
  assert.equal(constrained.maxHeight, 286)
})

test('compact Stash relative time formatting is executable and deterministic at minute, hour, and day boundaries', () => {
  const now = Date.UTC(2026, 7, 9, 6, 30, 0)
  assert.equal(formatStashRelativeDate(now - 30_000, now), '刚刚')
  assert.equal(formatStashRelativeDate(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(formatStashRelativeDate(now - 3 * 60 * 60_000, now), '3 小时前')
  assert.equal(formatStashRelativeDate(now - 2 * 24 * 60 * 60_000, now), '2 天前')
  assert.equal(formatStashRelativeDate('not-a-date', now), '时间未知')
})
