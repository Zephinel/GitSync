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

test('Step 1 keeps the source Dashboard card at rest when History focus is restored', () => {
  const appSource = readSource('src/App.jsx')
  const mainSource = readSource('src/main.jsx')
  const horizontalSource = readSource('src/CommitHistoryHorizontalSurface.css')
  const handoffSource = readSource('src/CommitHistoryHandoffSurface.css')
  const selector = '.repo-card:not(.repo-card--syncing):has(.repo-card__history-link:focus):hover,'

  assert.match(
    mainSource,
    /import '\.\/CommitHistoryHorizontalSurface\.css'[\s\S]*?import '\.\/CommitHistoryHandoffSurface\.css'/,
    'handoff authority should load after the horizontal compositor surface'
  )
  assert.match(
    appSource,
    /sourceCard\?\.querySelector\('\.repo-card__history-link'\)[\s\S]*?focusTarget\.focus/,
    'close handoff should continue restoring focus to the source History trigger'
  )

  const block = cssBlock(handoffSource, selector)
  assert.match(
    handoffSource,
    /\.repo-card:not\(\.repo-card--syncing\):has\(\.repo-card__history-link:focus\):focus-within/,
    'focus-within must be neutralized while the History trigger owns focus'
  )
  assert.match(block, /border:\s*0/)
  assert.match(block, /background:\s*var\(--bg-card\)/)
  assert.match(block, /box-shadow:\s*var\(--app-dashboard-card-shadow\)/)
  assert.match(block, /transform:\s*none/)
  assert.match(block, /overflow:\s*hidden/)
  assert.match(block, /z-index:\s*auto/)
  assert.match(block, /transition:\s*none/)

  assert.doesNotMatch(
    horizontalSource,
    /repo-card__history-link:focus/,
    'horizontal compositor authority must not own the close focus handoff'
  )
  assert.doesNotMatch(
    handoffSource,
    /--commit-history-flight-(?:start|end)-/,
    'handoff authority must not own flight geometry variables'
  )
  assert.doesNotMatch(
    handoffSource,
    /^\s*(?:width|left|top)\s*:/m,
    'handoff authority must not own flight geometry declarations'
  )
})

test('Step 1 preserves the accepted compact Commit History Hero anatomy', () => {
  const horizontalSource = readSource('src/CommitHistoryHorizontalSurface.css')
  const operationalChrome = [
    '.sync-info',
    '.repo-card__branch-attention',
    '.repo-card__state-callout',
    '.repo-card__missing-overlay',
    '.repo-card__actions-wrap',
  ]

  const anatomySelectorStart = horizontalSource.indexOf(
    '.commit-history-hero-card--preparing.commit-history-hero-card--opening'
  )
  const anatomyBlock = cssBlock(
    horizontalSource,
    '.commit-history-hero-card--preparing.commit-history-hero-card--opening'
  )
  const anatomyRule = horizontalSource.slice(
    anatomySelectorStart,
    horizontalSource.indexOf('}', anatomySelectorStart) + 1
  )
  const closingSelectorStart = horizontalSource.indexOf(
    '.commit-history-hero-card--preparing.commit-history-hero-card--closing'
  )
  const closingBlock = cssBlock(
    horizontalSource,
    '.commit-history-hero-card--preparing.commit-history-hero-card--closing'
  )
  const closingRule = horizontalSource.slice(
    closingSelectorStart,
    horizontalSource.indexOf('}', closingSelectorStart) + 1
  )

  assert.match(
    horizontalSource,
    /\.commit-history-hero-card--geometry-ready\.commit-history-hero-card--opening/,
    'visible opening flight must keep Dashboard operational chrome out of the Hero'
  )
  assert.match(
    horizontalSource,
    /\.commit-history-hero-card--settled/,
    'settled Hero must keep Dashboard operational chrome hidden'
  )
  assert.match(
    horizontalSource,
    /\.commit-history-hero-card--preparing\.commit-history-hero-card--closing/,
    'preparing return flight must keep Dashboard operational chrome out of the paint'
  )
  assert.match(
    horizontalSource,
    /\.commit-history-hero-card--geometry-ready\.commit-history-hero-card--closing/,
    'visible return flight must keep Dashboard operational chrome out of the paint'
  )
  for (const selector of operationalChrome) {
    assert.ok(anatomyRule.includes(selector), `${selector} must stay excluded from the visible opening Hero`)
    assert.ok(closingRule.includes(selector), `${selector} must stay excluded from the visible closing Hero`)
  }
  assert.match(anatomyBlock, /display:\s*none/)
  assert.match(closingBlock, /display:\s*none/)
  assert.doesNotMatch(closingBlock, /visibility:\s*hidden/)
})

test('closing uses one horizontal endpoint authority', () => {
  const appSource = readSource('src/App.jsx')
  const endpointHelperStart = appSource.indexOf('function areCommitHistoryFlightEndpointsAligned')
  const endpointHelperEnd = appSource.indexOf('function normalizeCommitHistoryBranchName', endpointHelperStart)
  assert.ok(endpointHelperStart > -1)
  assert.ok(endpointHelperEnd > endpointHelperStart)

  const endpointHelper = appSource.slice(endpointHelperStart, endpointHelperEnd)
  assert.match(endpointHelper, /\['left', 'top', 'width'\]/)
  assert.doesNotMatch(endpointHelper, /height/)
  assert.doesNotMatch(appSource, /function areCommitHistoryRectsAligned/)
  assert.match(
    appSource,
    /finalFlightRect[\s\S]*?areCommitHistoryFlightEndpointsAligned\(finalFlightRect, heroStartRect\)/
  )
  assert.match(
    appSource,
    /const currentTargetRect[\s\S]*?areCommitHistoryFlightEndpointsAligned\(currentTargetRect, heroStartRect\)/
  )
})

test('commit history has no retired full-geometry or clone authorities', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')
  const horizontalSource = readSource('src/CommitHistoryHorizontalSurface.css')

  assert.doesNotMatch(
    appSource,
    /areCommitHistoryRectsAligned|commitHistoryClone|repo-card--history-clone/,
    'production App code should not retain retired geometry or clone compatibility authorities'
  )
  assert.doesNotMatch(
    cssSource,
    /repo-card--history-clone/,
    'App.css should not retain the retired clone selector'
  )
  assert.doesNotMatch(
    horizontalSource,
    /full Dashboard geometry check/,
    'horizontal-surface documentation should describe the current endpoint contract'
  )
})

test('close handoff suppresses commit hover while restoring the History trigger', () => {
  const appSource = readSource('src/App.jsx')
  const handoffSource = readSource('src/CommitHistoryHandoffSurface.css')

  assert.match(
    appSource,
    /commitHistoryHandoff\s*=\s*false/,
    'RepoCard should receive an explicit post-flight handoff state'
  )
  assert.match(
    appSource,
    /commitHistoryOverlayActive\s*\|\|\s*commitHistoryFlight\s*\|\|\s*commitHistoryHandoff/,
    'meta hover must stay disabled while the source card is in handoff'
  )
  assert.match(
    appSource,
    /commitHistoryHandoffRepoId/,
    'the parent should retain the returning repository id for the handoff frame'
  )
  assert.match(
    handoffSource,
    /repo-card--history-handoff/,
    'handoff presentation should have a dedicated source-card state'
  )
})

test('close handoff prefers final compact Hero height and keeps a pre-close fallback', () => {
  const appSource = readSource('src/App.jsx')

  assert.match(
    appSource,
    /const commitHistoryHandoffHeightRef = useRef\(null\)/,
    'close should retain the compact Hero height across the return transaction'
  )
  assert.match(
    appSource,
    /document\.querySelector\('\.commit-history-hero-card \.repo-card--history-flight'\)[\s\S]*?getBoundingClientRect\(\)\.height/,
    'close should measure the visible Hero surface before switching to the closing layout'
  )
  assert.match(
    appSource,
    /const handoffRevealHeight = Number\.isFinite\(finalFlightHeight\) && finalFlightHeight > 0\s*\n\s*\? finalFlightHeight\s*\n\s*: measuredHandoffHeight/,
    'normal close should use the final compact Hero height and only fall back to the pre-close measurement'
  )
  assert.match(
    appSource,
    /function DashboardGroupEntries\([\s\S]*?commitHistoryHandoffHeight[\s\S]*?commitHistoryHandoffHeight=\{commitHistoryHandoffRepoId === item\.id \? commitHistoryHandoffHeight : null\}/,
    'DashboardGroupEntries should pass the active handoff height only to the returning repository card'
  )
  assert.match(
    appSource,
    /activeCommitHistoryRepoId=\{commitHistoryRepoId\}[\s\S]*?commitHistoryHandoffRepoId=\{commitHistoryHandoffRepoId\}[\s\S]*?commitHistoryHandoffHeight=\{commitHistoryHandoffHeight\}/,
    'App should pass the measured handoff height into DashboardGroupEntries'
  )
})

test('handoff reveals content without clipping the source card shadow', () => {
  const appSource = readSource('src/App.jsx')
  const handoffSource = readSource('src/CommitHistoryHandoffSurface.css')
  const handoffBlock = cssBlock(handoffSource, '.repo-card--history-handoff {')
  const revealFrames = cssBlock(handoffSource, '@keyframes commitHistorySourceCardReveal')

  assert.match(
    appSource,
    /const \[commitHistoryHandoffSourceHeight, setCommitHistoryHandoffSourceHeight\] = useState\(null\)/,
    'handoff should carry the full source-card height separately from the compact Hero height'
  )
  assert.match(
    appSource,
    /commitHistoryHandoffSourceHeight=\{commitHistoryHandoffRepoId === item\.id \? commitHistoryHandoffSourceHeight : null\}/,
    'DashboardGroupEntries should pass the full source-card height only to the returning card'
  )
  assert.match(
    appSource,
    /commitHistoryHandoffSourceHeight=\{commitHistoryHandoffSourceHeight\}/,
    'App should bridge the full source-card height into DashboardGroupEntries'
  )
  assert.match(
    appSource,
    /--commit-history-handoff-reserve-height/,
    'handoff should reserve the source-card flow height while the compact surface grows'
  )
  assert.match(handoffBlock, /overflow:\s*hidden/)
  assert.match(handoffBlock, /height:\s*var\(--commit-history-handoff-height/)
  assert.match(handoffBlock, /margin-bottom:\s*var\(--commit-history-handoff-reserve-height/)
  assert.doesNotMatch(
    handoffBlock,
    /clip-path:/,
    'the shadow-owning source card must not clip its own shadow during handoff'
  )
  assert.match(revealFrames, /height:\s*var\(--commit-history-handoff-height/)
  assert.match(revealFrames, /height:\s*var\(--commit-history-handoff-source-height/)
  assert.match(revealFrames, /margin-bottom:\s*var\(--commit-history-handoff-reserve-height/)
  assert.match(revealFrames, /margin-bottom:\s*0/)
})

test('handoff reveal timer survives the phase transition to closed', () => {
  const appSource = readSource('src/App.jsx')
  const phaseEffectStart = appSource.indexOf(
    'useEffect(() => {\n    if (\n      commitHistoryFlightPhase !== COMMIT_HISTORY_FLIGHT_PHASE.handoff'
  )
  const phaseEffectEnd = appSource.indexOf('  useEffect(() => {\n    if (!commitHistoryHandoffRepoId)', phaseEffectStart)
  assert.ok(phaseEffectStart > -1 && phaseEffectEnd > phaseEffectStart, 'phase handoff effect should be present')

  const phaseEffect = appSource.slice(phaseEffectStart, phaseEffectEnd)
  assert.doesNotMatch(phaseEffect, /setTimeout\(/, 'phase transition cleanup must not own the reveal timer')

  const timerEffect = appSource.slice(phaseEffectEnd, appSource.indexOf('  const handleCommitHistoryCountChange', phaseEffectEnd))
  assert.match(timerEffect, /if \(!commitHistoryHandoffRepoId\) return undefined/)
  assert.match(timerEffect, /setTimeout\([\s\S]*?COMMIT_HISTORY_HANDOFF_REVEAL_MS/)
  assert.match(timerEffect, /return \(\) => window\.clearTimeout\(revealTimerId\)/)
  assert.doesNotMatch(timerEffect, /commitHistoryFlightPhase/)
})

test('close handoff blocks delayed mouse hover timers before they outlive the lock', () => {
  const appSource = readSource('src/App.jsx')
  const controllerSource = readSource('src/repoMetaHoverController.js')

  assert.match(
    appSource,
    /const metaHoverBlocked = Boolean\([\s\S]*?commitHistoryHandoff[\s\S]*?\)/,
    'the handoff must be part of the metadata hover block predicate'
  )
  assert.match(
    appSource,
    /isBlocked: \(\) => metaHoverHandlersRef\.current\.isBlocked\(\)/,
    'the hover controller must consult the live block predicate'
  )
  assert.match(
    controllerSource,
    /if \(isBlocked\(\) \|\| focusKey !== null \|\| pointerKey !== key\) \{/,
    'a hover scheduled before the handoff must not open after the handoff ends'
  )
})

test('History trigger stays outside commit hover mouse ownership', () => {
  const appSource = readSource('src/App.jsx')

  assert.match(
    appSource,
    /<div\s+className="repo-card__latest-commit-hover-target"[\s\S]*?\{\.\.\.commitMetaHostBindings\}[\s\S]*?latestCommitTextRef/,
    'commit hover should be owned by a target containing only the latest-commit content'
  )
  assert.match(
    appSource,
    /\{\.\.\.commitMetaHostBindings\}[\s\S]*?<\/div>\s*<button\s+className=\{`repo-card__history-link/,
    'the History trigger should be a sibling of, not a descendant of, the commit hover target'
  )
})

test('source card reveals Dashboard chrome after the Hero surface handoff', () => {
  const handoffSource = readSource('src/CommitHistoryHandoffSurface.css')
  const operationalChrome = [
    '.sync-info',
    '.repo-card__branch-attention',
    '.repo-card__state-callout',
    '.repo-card__missing-overlay',
    '.repo-card__actions-wrap',
  ]
  const revealStart = handoffSource.indexOf('.repo-card--history-handoff')
  assert.notEqual(revealStart, -1, 'handoff source-card reveal selector should exist')
  const revealRule = handoffSource.slice(revealStart, handoffSource.indexOf('}', revealStart) + 1)

  for (const selector of operationalChrome) {
    assert.ok(revealRule.includes(selector), `${selector} should participate in the post-flight reveal`)
  }
  assert.match(revealRule, /animation:/, 'Dashboard chrome should reveal with a presentation animation')
  assert.match(
    handoffSource,
    /@keyframes\s+commitHistoryDashboardChromeReveal/,
    'handoff should use a dedicated chrome reveal animation'
  )
})

test('History trigger retains its dedicated keyboard focus affordance', () => {
  const appCss = readSource('src/App.css')
  const block = cssBlock(appCss, '.repo-card__history-link:focus-visible')

  assert.match(block, /background:/)
  assert.match(block, /box-shadow:/)
})
