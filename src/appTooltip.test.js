import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  APP_TOOLTIP_DELAY_MS,
  APP_TOOLTIP_MAX_MAX_WIDTH_PX,
  APP_TOOLTIP_OFFSET_PX,
  APP_TOOLTIP_POINTER_OFFSET_X_PX,
  APP_TOOLTIP_POINTER_OFFSET_Y_PX,
  APP_TOOLTIP_VIEWPORT_GUTTER_PX,
  getAppTooltipMaxWidth,
  getAppTooltipPointPosition,
  getAppTooltipPosition,
  getViewportSize,
} from './appTooltip.js'

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

function listJsxFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) files.push(...listJsxFiles(full))
    else if (entry.name.endsWith('.jsx')) files.push(full)
  }
  return files
}

// Nearest preceding JSX tag name, used to tell an intrinsic element from a
// component that merely takes a `title` prop.
function nearestTagBefore(source, index) {
  const tagPattern = /<([A-Za-z][\w.$-]*)/g
  let tag = null
  let match
  while ((match = tagPattern.exec(source)) && match.index < index) tag = match[1]
  return tag
}

// Extract one top-level CSS rule block by its exact selector, so a contract
// assertion cannot be satisfied by a different rule elsewhere in the sheet.
function readCssRuleBlock(source, selector) {
  const match = source.match(new RegExp(`^${selector} \\{[\\s\\S]*?^\\}`, 'm'))
  assert.ok(match, `missing CSS rule for ${selector}`)
  return match[0]
}

function findDomTitleAttributes(source) {
  const found = []
  const pattern = /\btitle=/g
  let match
  while ((match = pattern.exec(source))) {
    const tag = nearestTagBefore(source, match.index)
    if (!/^[A-Z]/.test(tag || '')) {
      found.push({ tag, line: source.slice(0, match.index).split('\n').length })
    }
  }
  return found
}

test('hangs the surface on the anchor left edge when there is room', () => {
  const position = getAppTooltipPosition({
    anchorRect: { left: 100, top: 100, bottom: 130 },
    width: 120,
    height: 30,
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(position.placement, 'bottom')
  assert.equal(position.left, 100)
  assert.equal(position.top, 130 + APP_TOOLTIP_OFFSET_PX)
  assert.equal(position.maxWidth, APP_TOOLTIP_MAX_MAX_WIDTH_PX)
})

test('a short hint near the right edge keeps the anchor left edge', () => {
  const position = getAppTooltipPosition({
    anchorRect: { left: 1100, top: 40, bottom: 70 },
    width: 80,
    height: 28,
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(position.left, 1100)
})

test('a wide hint near the right edge slides only as far as it overflows', () => {
  const position = getAppTooltipPosition({
    anchorRect: { left: 1150, top: 40, bottom: 70 },
    width: 300,
    height: 30,
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(position.left, 1200 - 300 - APP_TOOLTIP_VIEWPORT_GUTTER_PX)
})

test('flips above the anchor only when the surface cannot fit below', () => {
  const flipped = getAppTooltipPosition({
    anchorRect: { left: 100, top: 700, bottom: 760 },
    width: 120,
    height: 100,
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(flipped.placement, 'top')
  assert.equal(flipped.top, 700 - APP_TOOLTIP_OFFSET_PX - 100)

  const tooTallEvenAbove = getAppTooltipPosition({
    anchorRect: { left: 100, top: 20, bottom: 60 },
    width: 120,
    height: 760,
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(tooTallEvenAbove.placement, 'bottom')
  assert.equal(tooTallEvenAbove.top, 60 + APP_TOOLTIP_OFFSET_PX)
})

test('clamps the max width to the viewport without using it as the anchor offset', () => {
  assert.equal(getAppTooltipMaxWidth(1200), APP_TOOLTIP_MAX_MAX_WIDTH_PX)
  assert.equal(getAppTooltipMaxWidth(300), 300 - APP_TOOLTIP_VIEWPORT_GUTTER_PX * 2)
  assert.equal(getAppTooltipMaxWidth(120), 180)
})

test('a pointer anchor sits below-right of the cursor like the native tooltip', () => {
  const position = getAppTooltipPointPosition({
    point: { x: 100, y: 100 },
    width: 120,
    height: 30,
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(position.placement, 'bottom')
  assert.equal(position.left, 100 + APP_TOOLTIP_POINTER_OFFSET_X_PX)
  assert.equal(position.top, 100 + APP_TOOLTIP_POINTER_OFFSET_Y_PX)
})

test('a pointer anchor stays inside the viewport and flips near the bottom', () => {
  const clamped = getAppTooltipPointPosition({
    point: { x: 1190, y: 50 },
    width: 200,
    height: 30,
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(clamped.left, 1200 - 200 - APP_TOOLTIP_VIEWPORT_GUTTER_PX)

  const flipped = getAppTooltipPointPosition({
    point: { x: 100, y: 780 },
    width: 120,
    height: 100,
    viewport: { width: 1200, height: 800 },
  })
  assert.equal(flipped.placement, 'top')
  assert.ok(flipped.top < 780)
  assert.ok(flipped.top + 100 <= 780)
})

test('reads the viewport from the window or document element', () => {
  assert.deepEqual(
    getViewportSize({ innerWidth: 1024, innerHeight: 768 }),
    { width: 1024, height: 768 },
  )
  assert.deepEqual(
    getViewportSize({ document: { documentElement: { clientWidth: 800, clientHeight: 600 } } }),
    { width: 800, height: 600 },
  )
})

test('one surface measures itself instead of guessing its width', () => {
  const surface = read('./AppTooltip.jsx')

  assert.match(surface, /export function AppTooltipSurface\(\{ anchor = null, point = null, text \}\)/)
  assert.match(surface, /if \(point\) \{[\s\S]*getAppTooltipPointPosition\(\{ point, \.\.\.size \}\)/)
  assert.match(surface, /anchorRect: anchor\.getBoundingClientRect\(\)/)
  assert.match(surface, /width: node\.offsetWidth[\s\S]*height: node\.offsetHeight/)
  assert.match(surface, /className="app-tooltip"/)
  assert.match(surface, /role="tooltip"/)
  assert.match(surface, /visibility: position \? 'visible' : 'hidden'/)
})

test('one delegated trigger owns the authored tooltip attribute', () => {
  const layer = read('./AppTooltip.jsx')
  const main = read('./main.jsx')
  const app = read('./App.css')

  assert.match(layer, /export default function AppTooltipLayer\(\)/)
  assert.match(layer, /const APP_TOOLTIP_ATTRIBUTE = 'data-app-tooltip'/)
  assert.match(layer, /const TOOLTIP_SOURCE_SELECTOR = `\[\$\{APP_TOOLTIP_ATTRIBUTE\}\]`/)
  assert.match(layer, /document\.addEventListener\('pointerover', handlePointerOver, true\)/)
  assert.match(layer, /document\.addEventListener\('pointerout', handlePointerOut, true\)/)
  assert.match(layer, /schedule\(target, \{ x: event\.clientX, y: event\.clientY \}\)/)
  assert.match(layer, /pointRef\.current = \{ x: event\.clientX, y: event\.clientY \}/)
  assert.match(layer, /<AppTooltipSurface anchor=\{tooltip\.anchor\} point=\{tooltip\.point\} text=\{tooltip\.text\} \/>/)
  assert.match(layer, /APP_TOOLTIP_DELAY_MS/)
  assert.equal(APP_TOOLTIP_DELAY_MS, 620)
  // No native-title interception: the hint is authored, not stolen from `title`.
  assert.doesNotMatch(layer, /removeAttribute\('title'\)|setAttribute\('title'|NATIVE_TITLE/)

  assert.match(main, /import AppTooltipLayer from '\.\/AppTooltip\.jsx'/)
  assert.match(main, /<AppTooltipLayer \/>/)

  const baseRule = readCssRuleBlock(app, '\\.app-tooltip')
  assert.match(app, /--z-app-tooltip: 4000;/)
  assert.match(baseRule, /position: fixed;/)
  assert.match(baseRule, /z-index: var\(--z-app-tooltip\);/)
  assert.match(baseRule, /pointer-events: none;/)
  assert.match(app, /\[data-theme="light"\] \.app-tooltip \{/)
  assert.doesNotMatch(app, /\.app-tooltip--top/)
})

test('the shared tooltip surface keeps authored line breaks without disturbing single-line hints', () => {
  const app = read('./App.css')
  const baseRule = readCssRuleBlock(app, '\\.app-tooltip')

  // The multi-line sync-time hint is authored as `上次同步\n${absolute}\n${relative}`.
  // `pre-line` is what makes those authored breaks render; `normal` collapses them
  // into spaces, which is the regression this contract locks down.
  assert.match(baseRule, /white-space: pre-line;/)
  assert.doesNotMatch(baseRule, /white-space:\s*normal/)

  // `pre-line` (not `pre`/`pre-wrap`/`nowrap`) still collapses runs of spaces and
  // still wraps normally, so every existing single-line hint renders unchanged.
  // Exactly one `white-space` declaration keeps this rule unambiguous.
  assert.equal((baseRule.match(/white-space:/g) || []).length, 1)
  assert.doesNotMatch(baseRule, /white-space:\s*(pre|pre-wrap|nowrap);/)
  assert.match(baseRule, /overflow-wrap: anywhere;/)
})

test('no DOM element falls back to the browser-native title tooltip', () => {
  const srcDir = fileURLToPath(new URL('.', import.meta.url))
  const offenders = []
  for (const file of listJsxFiles(srcDir)) {
    for (const hit of findDomTitleAttributes(readFileSync(file, 'utf8'))) {
      offenders.push(`${file.replace(srcDir, '')}:${hit.line} <${hit.tag}>`)
    }
  }
  assert.deepEqual(offenders, [], `use data-app-tooltip instead of title on DOM elements:\n${offenders.join('\n')}`)
})
