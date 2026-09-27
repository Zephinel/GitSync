import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSource = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('loads the fixed-width AI settings action treatment after the stage polish overrides', () => {
  const main = readSource('src/main.jsx')
  const stagePolish = main.indexOf("import './ai/AiStage1Polish.css'")
  const actionWidth = main.indexOf("import './ai/AiSettingsActionWidth.css'")
  assert.ok(stagePolish >= 0 && stagePolish < actionWidth)
})

test('keeps the three AI settings footer buttons equal-width while preserving narrow layouts', () => {
  const css = readSource('src/ai/AiSettingsActionWidth.css')
  assert.match(css, /\.ai-settings-section \.ai-settings-actions > button/)
  assert.match(css, /flex: 0 0 96px;/)
  assert.match(css, /width: 96px;/)
  assert.match(css, /min-width: 96px;/)
  assert.match(css, /max-width: 96px;/)
  assert.match(css, /@media \(max-width: 560px\)/)
  assert.match(css, /flex: 1 1 100%;/)
})
