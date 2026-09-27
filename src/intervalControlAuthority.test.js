import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

function readCssRule(source, selector) {
  const start = source.lastIndexOf(`\n${selector} {`)
  assert.ok(start >= 0, `missing CSS rule: ${selector}`)
  const openingBrace = source.indexOf('{', start)
  let depth = 0
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  assert.fail(`unterminated CSS rule: ${selector}`)
}

test('every interval-style settings control renders the shared stepper authority', () => {
  const units = read('./intervalUnits.js')
  const control = read('./IntervalControl.jsx')
  const app = read('./App.jsx')
  const appCss = read('./App.css')
  const ai = read('./ai/AiSettingsSection.jsx')
  const aiCss = read('./ai/Ai.css')

  assert.match(units, /export const INTERVAL_UNIT_OPTIONS = Object\.freeze\(\{/)
  assert.match(units, /export const INTERVAL_UNIT_ORDER = Object\.freeze\(\['seconds', 'minutes', 'hours'\]\)/)
  // The component module exports only the component, so Fast Refresh can hot-update it.
  assert.match(control, /import \{ INTERVAL_UNIT_OPTIONS, INTERVAL_UNIT_ORDER \} from '\.\/intervalUnits\.js'/)
  assert.doesNotMatch(control, /export const/)
  assert.match(control, /const switchable = resolvedUnitKeys\.length > 1/)
  assert.match(control, /const layoutClassName = switchable \? 'interval-control' : 'interval-control interval-control--inline-unit'/)
  assert.match(control, /aria-hidden="true">\s*\{activeUnit\.label\}/)
  // A single fixed unit stays on the stepper's row and matches its height.
  assert.match(appCss, /\.interval-control--inline-unit \{\s*flex-direction: row;\s*align-items: stretch;\s*\}/)
  assert.match(appCss, /\.interval-control__unit-btn \{[\s\S]*?display: inline-flex;[\s\S]*?align-items: center;[\s\S]*?justify-content: center;/)

  // Sync settings keep the switchable unit row and read the shared unit map.
  assert.match(app, /import IntervalControl from '\.\/IntervalControl\.jsx'/)
  assert.match(app, /import \{ INTERVAL_UNIT_OPTIONS \} from '\.\/intervalUnits\.js'/)
  assert.match(app, /const INTERVAL_UNITS = INTERVAL_UNIT_OPTIONS/)
  assert.match(app, /<IntervalControl[\s\S]*?unit=\{unit\}/)
  assert.doesNotMatch(app, /interval-control__units/)

  // The AI timeout uses the same control with the unit locked to seconds.
  assert.match(ai, /import IntervalControl from '\.\.\/IntervalControl\.jsx'/)
  assert.match(ai, /<IntervalControl[\s\S]*?unit="seconds"[\s\S]*?units=\{\['seconds'\]\}/)
  assert.match(ai, /clampTimeoutSeconds/)
  assert.doesNotMatch(ai, /ai-timeout-control/)
  assert.doesNotMatch(aiCss, /\.ai-timeout-control/)
  assert.match(aiCss, /\.ai-settings-section \.interval-control \{\s*justify-self: end;/)
})

test('settings steppers share one height so every stacked box lines up', () => {
  const appCss = read('./App.css')

  assert.match(appCss, /--settings-stepper-height: 36px;/)
  assert.match(appCss, /--settings-stepper-field-height: calc\(var\(--settings-stepper-height\) - 6px\);/)

  for (const selector of ['.interval-control__main', '.interval-control__units', '.concurrency-control']) {
    assert.match(
      readCssRule(appCss, selector),
      /height: var\(--settings-stepper-height\);/,
      `${selector} should share the stepper box height`,
    )
  }
  for (const selector of ['.interval-control__input', '.concurrency-control__input']) {
    assert.match(
      readCssRule(appCss, selector),
      /height: var\(--settings-stepper-field-height\);/,
      `${selector} should fill the stepper field height`,
    )
  }
})

test('the AI timeout range has one numeric authority', () => {
  const settings = read('./ai/aiSettings.js')
  const ai = read('./ai/AiSettingsSection.jsx')

  assert.match(settings, /export const MIN_AI_TIMEOUT_SECONDS = 5/)
  assert.match(settings, /export const MAX_AI_TIMEOUT_SECONDS = 300/)
  assert.match(settings, /Math\.max\(MIN_AI_TIMEOUT_SECONDS, Math\.min\(MAX_AI_TIMEOUT_SECONDS, timeout\)\)/)

  assert.match(ai, /import IntervalControl from '\.\.\/IntervalControl\.jsx'/)
  assert.match(ai, /MIN_AI_TIMEOUT_SECONDS,[\s\S]*MAX_AI_TIMEOUT_SECONDS,/)
  assert.match(ai, /范围 \$\{MIN_AI_TIMEOUT_SECONDS\}–\$\{MAX_AI_TIMEOUT_SECONDS\} 秒/)
})
