import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function cssBlock(source, selector) {
  const start = source.indexOf(selector)
  assert.notEqual(start, -1, `missing CSS selector: ${selector}`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `missing CSS block open for: ${selector}`)

  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }

  assert.fail(`missing CSS block close for: ${selector}`)
}

test('Step 2 animates only the live Hero opening shadow from the source-card depth', () => {
  const mainSource = readSource('src/main.jsx')
  const appSource = readSource('src/App.jsx')
  const handoffSource = readSource('src/CommitHistoryHandoffSurface.css')
  const horizontalSource = readSource('src/CommitHistoryHorizontalSurface.css')
  const openingSelector = '.commit-history-hero-card--geometry-ready.commit-history-hero-card--opening'
  const openingBlock = cssBlock(handoffSource, openingSelector)
  const shadowFrames = cssBlock(handoffSource, '@keyframes commitHistoryOpeningShadow')

  assert.match(
    mainSource,
    /import '\.\/CommitHistoryHorizontalSurface\.css'[\s\S]*?import '\.\/CommitHistoryHandoffSurface\.css'/,
    'endpoint handoff authority must remain layered after the horizontal flight surface'
  )
  assert.doesNotMatch(
    appSource,
    /commitHistoryOpeningShadow/,
    'Step 2 must not introduce a JavaScript shadow runtime'
  )

  assert.match(
    openingBlock,
    /animation:[\s\S]*?commitHistoryOpeningShadow[\s\S]*?var\(--commit-history-motion-duration\)[\s\S]*?var\(--commit-history-motion-ease\)[\s\S]*?both;/,
    'opening shadow must reuse the existing motion duration and easing'
  )
  assert.doesNotMatch(
    openingBlock,
    /\b(?:width|height|left|top|right|transform|background|border|opacity|display|visibility|clip-path|padding|margin)\s*:/,
    'Step 2 must not take geometry, anatomy, or surface ownership from existing authorities'
  )

  assert.match(
    shadowFrames,
    /from\s*\{[\s\S]*?box-shadow:\s*var\(--app-card-highlight-shadow\);/,
    'the first visible Hero frame must inherit the highlighted Dashboard source depth'
  )
  assert.doesNotMatch(
    shadowFrames,
    /\bto\s*\{/,
    'the settled Hero shadow must remain implicitly owned by App.css'
  )
  assert.doesNotMatch(
    shadowFrames,
    /--app-dashboard-card-shadow|22px|48px|transform:|width:|height:|background:|border:|opacity:|display:|visibility:/,
    'Step 2 keyframes must own box-shadow start depth only'
  )

  assert.match(
    handoffSource,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?commit-history-hero-card--opening[\s\S]*?animation:\s*none;/,
    'reduced motion must disable the added opening shadow animation'
  )
  assert.doesNotMatch(
    horizontalSource,
    /commitHistoryOpeningShadow/,
    'HorizontalSurface must remain horizontal-only and must not own Step 2 shadow continuity'
  )
})

test('Step 2 preserves the accepted compact Hero anatomy guard', () => {
  const horizontalSource = readSource('src/CommitHistoryHorizontalSurface.css')
  const operationalChrome = [
    '.sync-info',
    '.repo-card__branch-attention',
    '.repo-card__state-callout',
    '.repo-card__missing-overlay',
    '.repo-card__actions-wrap',
  ]

  const openingStart = horizontalSource.indexOf(
    '.commit-history-hero-card--preparing.commit-history-hero-card--opening'
  )
  assert.notEqual(openingStart, -1, 'opening compact-anatomy selector must remain present')
  const openingEnd = horizontalSource.indexOf('}', openingStart)
  assert.notEqual(openingEnd, -1, 'opening compact-anatomy rule must close')
  const openingRule = horizontalSource.slice(openingStart, openingEnd + 1)

  assert.match(openingRule, /\.commit-history-hero-card--geometry-ready\.commit-history-hero-card--opening/)
  assert.match(openingRule, /\.commit-history-hero-card--settled/)
  assert.match(openingRule, /display:\s*none/)
  for (const selector of operationalChrome) {
    assert.ok(openingRule.includes(selector), `${selector} must stay out of the visible opening/settled Hero`)
  }

  const closingBlock = cssBlock(
    horizontalSource,
    '.commit-history-hero-card--preparing.commit-history-hero-card--closing'
  )
  assert.match(closingBlock, /display:\s*none/)
  assert.doesNotMatch(closingBlock, /visibility:\s*hidden/)
})
