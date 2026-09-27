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

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start > -1, `missing source marker: ${startMarker}`)
  assert.ok(end > start, `missing source end marker: ${endMarker}`)
  return source.slice(start, end)
}

test('commit history fixed overlay is mounted outside the transformed main content', () => {
  const appSource = readSource('src/App.jsx')

  const mainStart = appSource.search(/<main\s+[^>]*className="main-content"[^>]*>/)
  assert.notEqual(mainStart, -1, 'main content element should exist')

  const mainEnd = appSource.indexOf('</main>', mainStart)
  assert.notEqual(mainEnd, -1, 'main content closing tag should exist')

  const stageIndex = appSource.indexOf("'commit-history-stage'")
  assert.notEqual(stageIndex, -1, 'commit history stage should exist')
  assert.ok(
    stageIndex > mainEnd,
    'commit history stage must stay outside main-content so fixed positioning uses the viewport'
  )

  const backdropIndex = appSource.indexOf('className={`commit-history-backdrop')
  assert.notEqual(backdropIndex, -1, 'commit history backdrop should exist')
  assert.ok(
    backdropIndex > mainEnd,
    'commit history backdrop must stay outside main-content so fixed positioning uses the viewport'
  )
})

test('commit history stage remains viewport-fixed while the repository list translates', () => {
  const cssSource = readSource('src/App.css')

  assert.match(
    cssBlock(cssSource, '.commit-history-stage'),
    /position:\s*fixed;/,
    'commit history stage should be fixed to the viewport'
  )

  assert.match(
    cssBlock(cssSource, '.app-layout--commit-history-open .main-content'),
    /transform:\s*translateX\(calc\(-1 \* var\(--sidebar-width\)\)\);/,
    'repository list should move by translation, not by resizing the dashboard grid'
  )
})

test('commit history flight uses one live-DOM geometry contract in both directions', () => {
  const cssSource = readSource('src/App.css')

  const heroKeyframes = cssBlock(cssSource, '@keyframes commitHistoryFlight')
  const sourceClosingBlock = cssBlock(
    cssSource,
    '.dashboard-shell--commit-history-closing .repo-card--history-open'
  )

  assert.match(
    cssSource,
    /\.commit-history-hero-card--geometry-ready\s*\{[\s\S]*?position:\s*fixed;/,
    'the flight owner should use one fixed geometry frame in both directions'
  )
  assert.doesNotMatch(
    cssSource,
    /commit-history-hero-(?:translate|scale|return)/,
    'the old scale and return-only geometry variables must be removed'
  )
  assert.match(
    cssSource,
    /\.commit-history-hero-card--geometry-ready \.repo-card\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*auto;/,
    'the live card should reflow inside the animated geometry frame'
  )
  assert.doesNotMatch(
    cssSource,
    /\.commit-history-hero-card--closing::before\s*\{/,
    'closing hero must not leave an opaque empty shell after its content fades'
  )
  assert.match(
    heroKeyframes,
    /0%\s*\{[\s\S]*?transform:\s*translate\(0, 0\)[\s\S]*?width:\s*var\(--commit-history-flight-start-width\)/,
    'the shared flight should start from measured geometry without a scale transform'
  )
  assert.match(
    sourceClosingBlock,
    /visibility:\s*hidden;/,
    'the source card should stay hidden until the geometry handoff completes'
  )
  assert.match(
    heroKeyframes,
    /100%\s*\{[\s\S]*?calc\(var\(--commit-history-flight-end-left\) - var\(--commit-history-flight-start-left\)\)[\s\S]*?width:\s*var\(--commit-history-flight-end-width\)/,
    'the shared geometry frame should finish exactly on the measured destination bounds'
  )
  assert.doesNotMatch(
    heroKeyframes,
    /scaleX|scaleY|scale\(/,
    'the shared flight must never distort visible text or icons'
  )
  assert.match(
    cssSource,
    /\.commit-history-hero-card--preparing\s*\{[\s\S]*?visibility:\s*hidden;/,
    'the source-to-flight ownership transfer should hide the unmeasured frame before paint'
  )
  assert.match(
    cssSource,
    /\.commit-history-hero-card--geometry-ready\s*\{[\s\S]*?pointer-events:\s*none;/,
    'the flight owner should be inert to pointer input until the stable history surface owns interaction'
  )
  assert.match(
    heroKeyframes,
    /0%\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?100%\s*\{[\s\S]*?opacity:\s*1;/,
    'the visible card must stay fully opaque for the whole geometry flight'
  )
})

test('commit history flight preserves a measured flow slot for the surrounding context', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')

  assert.match(
    appSource,
    /const \[slotStyle, setSlotStyle\] = useState\(null\)/,
    'the hero should own a layout slot while its live card is fixed during flight'
  )
  assert.match(
    appSource,
    /className="commit-history-hero-slot"[\s\S]*?style=\{slotStyle \|\| undefined\}/,
    'the flow slot should wrap the fixed hero instead of letting surrounding content become its replacement'
  )
  assert.match(
    appSource,
    /height: `\$\{targetRect\.height\}px`/,
    'the flow slot height should come from the measured resting hero geometry'
  )
  assert.match(
    cssSource,
    /\.commit-history-hero-slot\s*\{[\s\S]*?flex:\s*0\s+0\s+auto;[\s\S]*?width:\s*min\(680px,\s*100%\);/,
    'the flow slot should remain in the context flex layout at the target width'
  )
})

test('commit history toolbar stays inside the live Hero card surface', () => {
  const appSource = readSource('src/App.jsx')
  const repoCardStart = appSource.indexOf('function RepoCard(')
  const repoCardEnd = appSource.indexOf('const MemoizedRepoCard = memo(RepoCard)')
  const heroStart = appSource.indexOf('<CommitHistoryHeroCard')
  const heroEnd = appSource.indexOf('</CommitHistoryHeroCard>', heroStart)
  assert.ok(repoCardStart > -1 && repoCardEnd > repoCardStart, 'RepoCard source should be available')
  assert.ok(heroStart > -1 && heroEnd > heroStart, 'Hero render should be available')

  const repoCardSource = appSource.slice(repoCardStart, repoCardEnd)
  const heroSource = appSource.slice(heroStart, heroEnd + '</CommitHistoryHeroCard>'.length)
  const afterHero = appSource.slice(heroEnd + '</CommitHistoryHeroCard>'.length)

  assert.match(
    repoCardSource,
    /\{historyToolbar \? \(/,
    'RepoCard should render the history toolbar slot whenever the Hero supplies it'
  )
  assert.doesNotMatch(
    repoCardSource,
    /commitHistoryClone|repo-card--history-clone/,
    'RepoCard should not retain the retired clone compatibility authority'
  )
  assert.ok(
    repoCardSource.indexOf('className="repo-card__history-toolbar-slot"')
      > repoCardSource.indexOf('className={`repo-card__actions-wrap'),
    'the embedded toolbar should follow the repository card actions inside the same surface'
  )
  assert.match(
    heroSource,
    /historyToolbar=\{!isCommitHistoryHeroReturning \? \(/,
    'the live Hero card should receive the toolbar before the close handoff'
  )
  assert.doesNotMatch(
    afterHero,
    /<CommitHistoryToolbar/,
    'the context should not render a second toolbar as a sibling of the Hero card'
  )
})

test('commit history opening handoff preserves the measured vertical slot', () => {
  const appSource = readSource('src/App.jsx')

  assert.match(
    appSource,
    /const settleOpening = useCallback\(/,
    'opening should have one explicit settle handoff instead of clearing geometry from multiple callbacks'
  )
  assert.match(
    appSource,
    /minHeight:\s*current\.height/,
    'the first settled frame should retain the measured height as a lower bound'
  )
  assert.match(
    appSource,
    /width:\s*current\.width/,
    'the settled flow slot should retain the measured target width during the fixed-to-flow handoff'
  )
  assert.match(
    appSource,
    /width:\s*current\.width,[\s\S]*?height:\s*current\.height,[\s\S]*?minHeight:\s*current\.height/,
    'the handoff should retain the original measured slot geometry so flex centering cannot move the card'
  )
  assert.doesNotMatch(
    appSource,
    /height:\s*measuredHeight/,
    'the handoff must not replace the measured slot height with an asynchronously changed live-card height'
  )
  assert.match(
    appSource,
    /settleOpening\(true\)/,
    'the animation-end handoff should preserve the measured slot'
  )
  assert.match(
    appSource,
    /settleOpening\(false\)/,
    'resize or scroll interruption should still release stale flight geometry'
  )
})

test('commit history flight ignores natural-height-only observer changes', () => {
  const appSource = readSource('src/App.jsx')
  const flightEffectStart = appSource.indexOf(
    "const baseline = {\n      mainWidth: mainContent?.getBoundingClientRect().width || 0"
  )
  const flightEffectEnd = appSource.indexOf('    window.addEventListener(\'resize\'', flightEffectStart)
  assert.ok(flightEffectStart > -1 && flightEffectEnd > flightEffectStart, 'flight observer should be available')

  const flightEffect = appSource.slice(flightEffectStart, flightEffectEnd)
  assert.match(
    flightEffect,
    /sourceRect:\s*getRepoCardProjectedRestingRect\(repoId\)/,
    'flight observer should snapshot the projected source endpoint geometry'
  )
  assert.match(
    flightEffect,
    /const currentSource = getRepoCardProjectedRestingRect\(repoId\)/,
    'flight observer should compare projected geometry while the main content is translated'
  )
  assert.match(
    flightEffect,
    /areCommitHistoryFlightEndpointsAligned\(currentSource,\s*baseline\.sourceRect\)/,
    'observer changes should be judged by the source endpoint geometry rather than natural height'
  )
  assert.doesNotMatch(
    flightEffect,
    /mainHeight|shellHeight|sourceHeight/,
    'natural height changes must not terminate an otherwise valid horizontal flight'
  )
})

test('commit history closing completion shares the observer horizontal endpoint contract', () => {
  const appSource = readSource('src/App.jsx')
  const completeReturn = sourceBetween(
    appSource,
    'const completeReturn = useCallback((finalFlightRect = null) =>',
    'const settleOpening = useCallback'
  )
  const flightObserver = sourceBetween(
    appSource,
    'const handleResizeObservation = () => {',
    "window.addEventListener('resize'"
  )

  assert.match(
    flightObserver,
    /areCommitHistoryFlightEndpointsAligned\(currentSource,\s*baseline\.sourceRect\)/,
    'observer should ignore source natural-height changes during a valid flight'
  )
  assert.match(
    completeReturn,
    /areCommitHistoryFlightEndpointsAligned\(currentTargetRect, heroStartRect\)/,
    'closing completion should use the same horizontal endpoint authority as the observer'
  )
  assert.doesNotMatch(
    completeReturn,
    /areCommitHistoryRectsAligned\(currentTargetRect, heroStartRect\)/,
    'closing completion must not defer a height-only source change into an abort'
  )
})

test('commit history closing handoff separates Hero endpoint and source-target geometry', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')

  assert.match(
    appSource,
    /const completeReturn = useCallback\(\(finalFlightRect = null\) =>/,
    'closing should accept the live Hero rect before unmounting the flight owner'
  )
  assert.match(
    appSource,
    /if\s*\(\s*finalFlightRect[\s\S]*?areCommitHistoryFlightEndpointsAligned\(finalFlightRect, heroStartRect\)/,
    'Hero endpoint should validate source anchor and width without requiring compact height'
  )
  assert.match(
    appSource,
    /const currentTargetRect[\s\S]*?areCommitHistoryFlightEndpointsAligned\(currentTargetRect, heroStartRect\)/,
    'source target stability should use the horizontal endpoint contract while height remains dynamic'
  )
  assert.doesNotMatch(
    appSource,
    /const currentTargetRect[\s\S]*?areCommitHistoryRectsAligned\(currentTargetRect, heroStartRect\)/,
    'source natural-height changes must not abort a closing flight at animation end'
  )
  assert.match(
    appSource,
    /const finalFlightRect = rootRef\.current\?\.getBoundingClientRect\(\)[\s\S]*?completeReturn\(finalFlightRect\)/,
    'animationend should validate the actual final live Hero bounds before the source is revealed'
  )
  assert.match(
    cssSource,
    /\.commit-history-hero-card\.commit-history-hero-card--closing \.repo-card--history-flight\s*\{[\s\S]*?transition:\s*box-shadow var\(--commit-history-motion-duration\)/,
    'closing should animate the Hero surface toward the source card surface'
  )
  assert.match(
    cssSource,
    /\.commit-history-hero-card\.commit-history-hero-card--closing\.commit-history-hero-card--geometry-ready \.repo-card--history-flight\s*\{[\s\S]*?box-shadow:\s*var\(--app-dashboard-card-shadow\)/,
    'the closing Hero shadow should match the source card before the handoff completes'
  )
})

test('commit history close keeps the source card hidden until the returning hero completes', () => {
  const appSource = readSource('src/App.jsx')

  assert.match(
    appSource,
    /activeCommitHistoryRepoId=\{commitHistoryRepoId\}/,
    'the source card should keep history-open styling while the returning hero owns the visible card'
  )
  assert.doesNotMatch(
    appSource,
    /activeCommitHistoryRepoId=\{isCommitHistoryHeroReturning \? null : commitHistoryRepoId\}/,
    'the source card should not be revealed before the return animation completes'
  )
  assert.match(
    appSource,
    /aria-hidden=\{commitHistoryTransitionHidden \|\| commitHistoryClosing \? 'true' : undefined\}[\s\S]*?inert=\{commitHistoryTransitionHidden \|\| commitHistoryClosing \|\| undefined\}/,
    'the real source card should remain inaccessible while the flight owns the visual card'
  )
  assert.match(
    appSource,
    /aria-hidden=\{closing \|\| flightPhase !== 'settled' \? 'true' : undefined\}[\s\S]*?inert=\{closing \|\| flightPhase !== 'settled' \|\| undefined\}/,
    'the flight owner should remain inaccessible until its geometry is settled'
  )
  assert.match(
    appSource,
    /<main[\s\S]*?aria-hidden=\{isCommitHistoryDrawerOpen \? 'true' : undefined\}[\s\S]*?inert=\{isCommitHistoryDrawerOpen \|\| undefined\}/,
    'the dashboard background should remain out of the keyboard tree for the whole history session'
  )
  assert.match(
    appSource,
    /className="sidebar"[\s\S]*?aria-hidden=\{interactive \? undefined : 'true'\}[\s\S]*?inert=\{interactive \? undefined : true\}/,
    'the hidden sidebar should not retain keyboard ownership behind the history surface'
  )
  assert.match(
    appSource,
    /<CommitHistoryDrawer[\s\S]*?repo=\{commitHistoryHeroRepo\}[\s\S]*?status=\{commitHistoryHeroStatus\}/,
    'the visible drawer should use the same presentation snapshot during the handoff'
  )
  assert.match(
    appSource,
    /--commit-history-flight-start-left[\s\S]*?--commit-history-flight-end-width/,
    'both directions must be bound to one measured start and end geometry contract'
  )
  assert.match(
    appSource,
    /areCommitHistoryFlightEndpointsAligned[\s\S]*?COMMIT_HISTORY_GEOMETRY_TOLERANCE_PX/,
    'handoff should verify the current target geometry within an explicit tolerance'
  )
  assert.match(
    appSource,
    /onFlightAbort=\{handleCommitHistoryFlightAbort\}/,
    'a geometry mismatch should use the abort cleanup path instead of a stale handoff'
  )
  assert.match(
    appSource,
    /if\s*\(page !== 'dashboard' && commitHistoryRepoId\)\s*\{[\s\S]*?finishCommitHistoryClose\(null, COMMIT_HISTORY_FLIGHT_PHASE\.aborting\)/,
    'leaving the dashboard should abort and clean up the transition instead of orphaning its state'
  )
  assert.match(
    appSource,
    /if\s*\(commitHistoryRepoId && !activeCommitHistoryRepo\)\s*\{[\s\S]*?finishCommitHistoryClose\(null, COMMIT_HISTORY_FLIGHT_PHASE\.aborting\)/,
    'a missing target repository should take the safe close fallback'
  )
  assert.match(
    appSource,
    /COMMIT_HISTORY_FLIGHT_PHASE[\s\S]*?preparingOpen[\s\S]*?preparingClose[\s\S]*?handoff[\s\S]*?aborting/,
    'the transition lifecycle should name preparation, flight, handoff, and abort states'
  )
})

test('commit history opening keeps the source card as a hidden layout placeholder', () => {
  const cssSource = readSource('src/App.css')
  const sourceCardBlock = cssBlock(cssSource, '.repo-card--history-open {\n  visibility: hidden;')
  const sourceCardAuthorityCount = (cssSource.match(/^\.repo-card--history-open\s*\{/gm) || []).length

  assert.equal(
    sourceCardAuthorityCount,
    1,
    'the source card must have one selector authority so a later rule cannot override its resting geometry'
  )
  assert.match(
    sourceCardBlock,
    /visibility:\s*hidden;/,
    'the source card should stop painting while the Hero flight owns the visible card'
  )
  assert.doesNotMatch(
    sourceCardBlock,
    /display:\s*none;/,
    'the source card should keep its layout slot so nearby repository cards do not move'
  )
  assert.match(
    sourceCardBlock,
    /pointer-events:\s*none;/,
    'the hidden source placeholder should not accept pointer interactions during hero motion'
  )
  assert.match(
    sourceCardBlock,
    /transform:\s*none;/,
    'the source placeholder geometry should match the final resting card exactly'
  )
  assert.match(
    cssSource,
    /\.app-layout--commit-history-session \.main-content\s*\{[\s\S]*?overflow-y:\s*hidden;/,
    'the dashboard background should remain scroll-locked for the whole history session'
  )
})

test('main repository list keeps scrolling without showing its scrollbar', () => {
  const cssSource = readSource('src/App.css')
  const mainContentBlock = cssBlock(cssSource, '.main-content')

  assert.match(
    mainContentBlock,
    /overflow-y:\s*auto;/,
    'main content should remain scrollable'
  )
  assert.match(
    mainContentBlock,
    /scrollbar-width:\s*none;/,
    'main content should hide the Firefox scrollbar'
  )
  assert.match(
    mainContentBlock,
    /-ms-overflow-style:\s*none;/,
    'main content should hide legacy Microsoft scrollbars'
  )

  const webkitScrollbarBlock = cssBlock(cssSource, '.main-content::-webkit-scrollbar')
  assert.match(
    webkitScrollbarBlock,
    /display:\s*none;/,
    'main content should hide the WebKit scrollbar'
  )
  assert.match(
    webkitScrollbarBlock,
    /width:\s*0;/,
    'main content WebKit scrollbar should not reserve width'
  )
})

test('commit history row keeps the expand control inline with truncated text', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')

  const titleIndex = appSource.indexOf('className="commit-history-row__title"')
  const messageIndex = appSource.indexOf('commit-history-row__message-text', titleIndex)
  const toggleIndex = appSource.indexOf('commit-history-row__toggle', titleIndex)

  assert.ok(messageIndex > titleIndex, 'commit message text should render inside the title row')
  assert.ok(toggleIndex > messageIndex, 'expand toggle should render after the message text in the same title row')
  assert.match(
    appSource,
    /scrollWidth\s*>\s*node\.clientWidth\s*\+\s*1/,
    'message toggle should be based on actual rendered overflow'
  )
  assert.match(
    appSource,
    /ResizeObserver/,
    'message overflow should be remeasured when row width changes'
  )
  assert.match(
    cssBlock(cssSource, '.commit-history-row__title'),
    /display:\s*flex;/,
    'collapsed commit title should place text and expand control on one row'
  )
  assert.match(
    cssBlock(cssSource, '.commit-history-row__message-text'),
    /text-overflow:\s*ellipsis;/,
    'commit message text should own the ellipsis before the inline toggle'
  )
  assert.match(
    cssBlock(cssSource, '.commit-history-row__message-text'),
    /flex:\s*1 1 auto;/,
    'commit message text should shrink so the expand toggle remains visible'
  )
  assert.match(
    cssBlock(cssSource, '.commit-history-row__toggle'),
    /margin:\s*0;/,
    'expand toggle should not create a separate row with top margin'
  )
})

test('commit history branch dropdown highlights fit wrapped branch names', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')

  assert.doesNotMatch(
    appSource,
    /className="custom-select__option-label"/,
    'branch dropdown should not add a second padded highlight box inside each option'
  )

  for (const selector of [
    '.commit-history-toolbar__branch-select .custom-select__option',
    '.commit-history-drawer__branch-select .custom-select__option',
  ]) {
    const optionBlock = cssBlock(cssSource, selector)

    assert.match(
      optionBlock,
      /flex:\s*0\s+0\s+auto;/,
      `${selector} row should not shrink inside the height-limited flex menu`
    )
    assert.match(
      optionBlock,
      /width:\s*100%;/,
      `${selector} row should stay full-width as the click target`
    )
    assert.match(
      optionBlock,
      /height:\s*auto;/,
      `${selector} should grow with wrapped branch names`
    )
    assert.match(
      optionBlock,
      /min-height:\s*32px;/,
      `${selector} should retain a compact single-line minimum height`
    )
    assert.match(
      optionBlock,
      /padding:\s*6px\s+10px;/,
      `${selector} should use one compact padding layer`
    )
    assert.match(
      optionBlock,
      /overflow-wrap:\s*anywhere;/,
      `${selector} should wrap long branch names inside the menu row`
    )
    assert.match(
      optionBlock,
      /white-space:\s*normal;/,
      `${selector} should allow branch names to wrap`
    )
    assert.doesNotMatch(
      optionBlock,
      /\n\s*height:\s*32px;/,
      `${selector} should not force a fixed option height`
    )
    assert.doesNotMatch(
      optionBlock,
      /text-overflow:\s*ellipsis;/,
      `${selector} should not ellipsize wrapped branch names`
    )
    assert.doesNotMatch(
      optionBlock,
      /width:\s*fit-content;/,
      `${selector} active highlight should use the full menu width instead of the text width`
    )
  }

  const activeOptionBlock = cssBlock(cssSource, '.custom-select__option--active')
  assert.doesNotMatch(activeOptionBlock, /border(?:-color)?:/)
  assert.match(activeOptionBlock, /background:\s*color-mix\(/)
})

test('commit history branch controls use view-only wording with labeled head hash', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')
  const helperLabelBlock = cssBlock(cssSource, '.commit-history-toolbar__label-row span:last-child')

  assert.match(
    appSource,
    />历史分支</,
    'branch selector should be labeled as the history branch view'
  )
  assert.match(
    appSource,
    /切换下拉分支仅影响历史记录，不会切换仓库分支/,
    'branch selector helper should explain that the dropdown does not switch the actual repo branch'
  )
  assert.match(
    appSource,
    />历史分支 HEAD</,
    'toolbar hash should identify the selected history branch HEAD'
  )
  assert.doesNotMatch(
    appSource,
    /不切换仓库分支/,
    'toolbar should not use terse warning-like copy for a view-only selector'
  )
  assert.doesNotMatch(
    appSource,
    /当前卡片最新提交/,
    'drawer header should not describe repository commits as card commits'
  )
  assert.match(
    appSource,
    /const currentBranchName = getCommitHistoryDefaultBranch\(repo, status\)/,
    'drawer header should resolve the actual current repo branch'
  )
  assert.match(
    appSource,
    /<span>当前分支<\/span>[\s\S]*?commit-history-drawer__branch-name[\s\S]*?currentBranchName[\s\S]*?<span>最新提交<\/span>/,
    'drawer latest hash row should include the current branch name before the hash'
  )
  assert.match(
    appSource,
    /<div className="commit-history-drawer__view-branch"[\s\S]*?<span>查看分支<\/span>[\s\S]*?viewedBranchName/,
    'drawer body should show which branch the history list is viewing'
  )
  assert.match(
    appSource,
    /className="commit-history-row__icon-btn commit-history-drawer__branch-copy"/,
    'viewed branch row should include an icon button for copying the branch name'
  )
  assert.match(
    appSource,
    /onClick=\{\(\) => onCopyBranchName\?\.\(viewedBranchName\)\}/,
    'viewed branch copy button should copy the branch currently shown by the history list'
  )
  assert.match(
    appSource,
    /onCopyBranchName=\{\(branch\) => stableHandleCopyRepoMeta\('branch', branch\)\}/,
    'drawer branch copy should reuse the repository branch copy toast path'
  )
  assert.match(
    helperLabelBlock,
    /text-align:\s*right;/,
    'branch helper copy should stay above the dropdown and right-aligned'
  )
  assert.match(
    helperLabelBlock,
    /min-width:\s*0;/,
    'branch helper copy should shrink inside the label row without pushing the layout'
  )
})

test('commit history refresh control keeps a stable action slot while loading', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')
  const refreshBlock = cssBlock(cssSource, '.commit-history-toolbar__refresh')

  assert.match(
    appSource,
    /const refreshButtonText = isRefreshing \|\| isLoading \? '刷新中' : '刷新'/,
    'refresh button may show explicit loading copy'
  )
  assert.match(
    appSource,
    /<span>\{refreshButtonText\}<\/span>/,
    'refresh button should render the fixed-width status text slot'
  )
  assert.match(
    appSource,
    /const refreshAriaLabel = isRefreshing \|\| isLoading \? '正在刷新提交历史' : '刷新提交历史'/,
    'loading state should move to accessible state text instead of visible width changes'
  )
  assert.match(
    refreshBlock,
    /width:\s*88px;/,
    'refresh button should reserve a stable width for loading and idle states'
  )
  assert.match(
    refreshBlock,
    /flex:\s*0\s+0\s+88px;/,
    'refresh button should not shrink or grow inside the toolbar action row'
  )
})

test('commit history drawer branch labels truncate without hiding their identity', () => {
  const cssSource = readSource('src/App.css')
  const branchNameBlock = cssBlock(cssSource, '.commit-history-drawer__branch-name')
  const viewBranchBlock = cssBlock(cssSource, '.commit-history-drawer__view-branch')
  const viewBranchNameBlock = cssBlock(cssSource, '.commit-history-drawer__view-branch .commit-history-drawer__branch-name')
  const branchCopyBlock = cssBlock(cssSource, '.commit-history-drawer__branch-copy')

  assert.match(
    branchNameBlock,
    /text-overflow:\s*ellipsis;/,
    'long drawer branch names should truncate instead of pushing header layout'
  )
  assert.match(
    branchNameBlock,
    /white-space:\s*nowrap;/,
    'drawer branch labels should stay on one line'
  )
  assert.match(
    branchNameBlock,
    /max-width:\s*min\(360px,\s*42vw\);/,
    'current branch label should have a bounded header width'
  )
  assert.match(
    viewBranchBlock,
    /margin-bottom:\s*14px;/,
    'viewed branch label should occupy the drawer body slot above the timeline'
  )
  assert.match(
    viewBranchNameBlock,
    /max-width:\s*min\(520px,\s*58vw\);/,
    'viewed branch name should get a wider but bounded timeline header slot'
  )
  assert.match(
    branchCopyBlock,
    /margin-left:\s*auto;/,
    'viewed branch copy button should stay at the trailing edge of the drawer row'
  )
  assert.match(
    branchCopyBlock,
    /flex:\s*0\s+0\s+auto;/,
    'viewed branch copy button should not shrink the branch label'
  )
})

test('commit history toolbar controls share one compact row height', () => {
  const cssSource = readSource('src/App.css')
  const toolbarBlock = cssBlock(cssSource, '.commit-history-toolbar')
  const embeddedBlock = cssBlock(cssSource, '.commit-history-toolbar--embedded')
  const triggerBlock = cssBlock(cssSource, '.commit-history-toolbar__branch-select .custom-select__trigger')
  const countBlock = cssBlock(cssSource, '.commit-history-toolbar__count')
  const countButtonBlock = cssBlock(cssSource, '.commit-history-toolbar__count-btn')
  const refreshBlock = cssBlock(cssSource, '.commit-history-toolbar__refresh')

  assert.match(
    toolbarBlock,
    /--commit-history-control-height:\s*38px;/,
    'standalone toolbar should define a shared control height'
  )
  assert.match(
    embeddedBlock,
    /--commit-history-control-height:\s*36px;/,
    'repo-card embedded toolbar should use the compact shared control height'
  )
  assert.match(
    embeddedBlock,
    /--commit-history-count-button-height:\s*30px;/,
    'segmented control buttons should be tuned to the compact embedded row'
  )
  assert.match(
    triggerBlock,
    /height:\s*var\(--commit-history-control-height\);/,
    'branch select should use the shared control height'
  )
  assert.match(
    countBlock,
    /height:\s*var\(--commit-history-control-height\);/,
    'segmented control container should use the shared control height'
  )
  assert.match(
    countBlock,
    /padding:\s*2px;/,
    'segmented control should not be taller than the adjacent controls'
  )
  assert.match(
    countButtonBlock,
    /height:\s*var\(--commit-history-count-button-height\);/,
    'segmented control buttons should fit within the shared row height'
  )
  assert.match(
    refreshBlock,
    /height:\s*var\(--commit-history-control-height\);/,
    'refresh button should use the shared control height'
  )
})

test('commit history loading state has a minimum visible duration', () => {
  const appSource = readSource('src/App.jsx')

  assert.match(
    appSource,
    /COMMIT_HISTORY_LOADING_MIN_MS\s*=\s*360/,
    'commit history loading should not flash for very fast requests'
  )
  assert.match(
    appSource,
    /waitForMinimumElapsed\(loadingStartedAt,\s*COMMIT_HISTORY_LOADING_MIN_MS\)/,
    'commit history should wait before replacing an uncached loading state'
  )
  assert.match(
    appSource,
    /const shouldHoldLoading = !cachedEntry/,
    'minimum loading duration should apply only to uncached skeleton loading'
  )
})

test('commit history cache accepts short and full ref hashes', () => {
  const appSource = readSource('src/App.jsx')

  assert.match(
    appSource,
    /function areCommitHistoryHashesEqual\(left, right\)/,
    'cache should compare branch overview hashes with log short hashes through a helper'
  )
  assert.match(
    appSource,
    /leftHash\.startsWith\(rightHash\) \|\| rightHash\.startsWith\(leftHash\)/,
    'cache hash comparison should accept short and full versions of the same commit hash'
  )
  assert.match(
    appSource,
    /areCommitHistoryHashesEqual\(entry\.remoteHeadHash, normalizedRemoteHeadHash\)/,
    'remote cache freshness should use the same short/full hash comparison'
  )
})

test('commit history skeleton action buttons use neutral skeleton naming', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')

  assert.match(appSource, /commit-history-row__icon-btn--skeleton/)
  assert.match(cssSource, /\.commit-history-row__icon-btn--skeleton/)
  assert.doesNotMatch(appSource, /commit-history-row__copy--skeleton/)
  assert.doesNotMatch(cssSource, /commit-history-row__copy--skeleton/)
})

test('commit history speech-bubble arrow stays a crisp fill-only triangle', () => {
  const cssSource = readSource('src/App.css')
  const arrowBlock = cssBlock(cssSource, '.commit-history-row__bubble::before')

  assert.match(arrowBlock, /border:\s*0;/)
  assert.match(arrowBlock, /background:\s*inherit;/)
  assert.match(arrowBlock, /clip-path:\s*polygon\(100%\s+0,\s*0\s+50%,\s*100%\s+100%\);/)
  assert.match(arrowBlock, /transform:\s*none;/)
  assert.doesNotMatch(arrowBlock, /filter:/)
  assert.match(arrowBlock, /transition:\s*background\s+var\(--transition-fast\);/)
})

test('commit history separates upstream-only commits with a remote timeline treatment', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')
  const timelineBlock = cssBlock(cssSource, '.commit-history-timeline')
  const dividerBlock = cssBlock(cssSource, '.commit-history-remote-divider')
  const dividerConnectorBlock = cssBlock(cssSource, '.commit-history-remote-divider::before')
  const dividerLineBlock = cssBlock(cssSource, '.commit-history-remote-divider__line')
  const dividerLeftLineBlock = cssBlock(cssSource, '.commit-history-remote-divider__line:first-child')
  const dividerRightLineBlock = cssBlock(cssSource, '.commit-history-remote-divider__line:last-child')
  const dividerLabelBlock = cssBlock(cssSource, '.commit-history-remote-divider__label')
  const afterDividerDayBlock = cssBlock(cssSource, '.commit-history-day--after-remote-divider')
  const dayBlock = cssBlock(cssSource, '.commit-history-day::before')
  const remoteDayBlock = cssBlock(cssSource, '.commit-history-day--remote::before')
  const dateLabelBlock = cssBlock(cssSource, '.commit-history-day__label')

  assert.match(
    appSource,
    /Array\.isArray\(cacheEntry\?\.remoteCommits\) \? cacheEntry\.remoteCommits : \[\]/,
    'drawer should read remote commits separately from local commits'
  )
  assert.match(
    appSource,
    /className="commit-history-remote-divider"/,
    'remote commits should be separated from local commits by an explicit divider'
  )
  const remoteGroupIndex = appSource.indexOf('remoteGroups.map')
  const dividerIndex = appSource.indexOf('className="commit-history-remote-divider"')
  const localGroupIndex = appSource.indexOf('groups.map', dividerIndex)
  const dividerMarkup = appSource.slice(dividerIndex, localGroupIndex)
  assert.ok(remoteGroupIndex > -1 && remoteGroupIndex < dividerIndex, 'remote commit groups should render above the divider')
  assert.ok(localGroupIndex > dividerIndex, 'local commit groups should render below the divider')
  assert.match(
    appSource,
    /commit-history-row--remote/,
    'remote commit rows should carry a source-specific class'
  )
  assert.match(
    appSource,
    /branchName: commitBranchName/,
    'remote commit diff events should use the commit row branch ref'
  )
  assert.match(
    cssBlock(cssSource, '.commit-history-row--remote .commit-history-row__dot'),
    /background:\s*var\(--status-warning\);/,
    'remote commit dots should use the warning tone instead of the local blue'
  )
  assert.match(
    cssBlock(cssSource, '.commit-history-remote-divider__line'),
    /background:\s*var\(--border-subtle\);/,
    'remote divider line should use the same neutral tone as the local timeline'
  )
  assert.match(
    dividerBlock,
    /display:\s*grid;/,
    'remote divider should use side columns so line length can scale with available space'
  )
  assert.match(
    dividerBlock,
    /grid-template-columns:\s*minmax\(0,\s*1fr\) auto minmax\(0,\s*1fr\);/,
    'remote divider should measure the side space between the label and list edges'
  )
  assert.match(
    dividerBlock,
    /padding-left:\s*var\(--commit-history-list-inline-start\);/,
    'remote divider should align its measured width to the commit card list edge'
  )
  assert.match(
    dividerLineBlock,
    /width:\s*var\(--commit-history-divider-line-share\);/,
    'remote divider lines should use a percentage of the available side space'
  )
  assert.match(
    dividerLeftLineBlock,
    /justify-self:\s*end;/,
    'left divider line should grow outward from the label edge'
  )
  assert.match(
    dividerRightLineBlock,
    /justify-self:\s*start;/,
    'right divider line should grow outward from the label edge'
  )
  assert.match(
    dividerLabelBlock,
    /min-width:\s*0;/,
    'remote divider label should fit its content instead of reserving a wide slot'
  )
  assert.match(
    dividerLabelBlock,
    /max-width:\s*min\(420px,\s*calc\(100% - 140px\)\);/,
    'remote divider label should stay bounded inside the drawer'
  )
  assert.match(
    dividerLabelBlock,
    /border:\s*1px solid var\(--border-subtle\);/,
    'remote divider label should use the same neutral border tone as local timeline surfaces'
  )
  assert.match(
    dividerLabelBlock,
    /background:\s*var\(--bg-card\);/,
    'remote divider label should use the local commit surface background'
  )
  assert.match(
    dividerLabelBlock,
    /justify-content:\s*center;/,
    'remote divider label content should stay centered inside the wider pill'
  )
  assert.doesNotMatch(
    dividerMarkup,
    /data-app-tooltip=\{viewedBranchName\}/,
    'remote divider branch label should not trigger the native browser tooltip'
  )
  assert.match(
    dividerConnectorBlock,
    /top:\s*calc\(-1 \* var\(--commit-history-card-divider-gap\)\);/,
    'divider connector should bridge the same vertical gap above the divider'
  )
  assert.match(
    dividerConnectorBlock,
    /bottom:\s*calc\(-1 \* var\(--commit-history-card-divider-gap\)\);/,
    'divider connector should bridge the same vertical gap below the divider'
  )
  assert.match(
    timelineBlock,
    /--commit-history-card-divider-gap:\s*36px;/,
    'timeline should define one shared card-to-divider spacing token'
  )
  assert.match(
    timelineBlock,
    /--commit-history-date-label-gap:\s*12px;/,
    'timeline should define one shared date-label-to-card spacing token'
  )
  assert.match(
    timelineBlock,
    /--commit-history-date-label-height:\s*16px;/,
    'timeline should define the date label height used by the remote divider crossover'
  )
  assert.match(
    timelineBlock,
    /--commit-history-list-inline-start:\s*34px;/,
    'timeline should expose the commit card list start for divider alignment'
  )
  assert.match(
    timelineBlock,
    /--commit-history-divider-line-share:\s*80%;/,
    'timeline should define divider line length as a percentage of side space'
  )
  assert.match(
    timelineBlock,
    /--commit-history-rail-x:\s*12px;/,
    'timeline should define one shared horizontal rail position'
  )
  assert.match(
    timelineBlock,
    /gap:\s*var\(--commit-history-card-divider-gap\);/,
    'space between the last remote card and the local divider should use the card-to-divider token'
  )
  assert.match(
    afterDividerDayBlock,
    /margin-top:\s*calc\(-1 \* \(var\(--commit-history-date-label-height\) \+ var\(--commit-history-date-label-gap\)\)\);/,
    'the first local date group should let the date label occupy the divider-to-card gap instead of enlarging it'
  )
  assert.match(
    dateLabelBlock,
    /margin-bottom:\s*var\(--commit-history-date-label-gap\);/,
    'space below date labels should use the shared label-to-card token'
  )
  assert.match(
    dateLabelBlock,
    /line-height:\s*var\(--commit-history-date-label-height\);/,
    'date labels should expose a stable height for the remote divider crossover'
  )
  assert.match(
    dateLabelBlock,
    /background:\s*var\(--bg-secondary\);/,
    'date labels should mask the connected rail so text remains clean'
  )
  assert.match(
    dayBlock,
    /top:\s*var\(--commit-history-date-label-height\);/,
    'timeline rails should start below date labels so they do not protrude above the first label'
  )
  assert.match(
    dayBlock,
    /bottom:\s*0;/,
    'timeline rails should end at the date-group level so adjacent sections can connect'
  )
  assert.match(
    dayBlock,
    /background:\s*var\(--border-subtle\);/,
    'local timeline rails should be drawn once per date group'
  )
  assert.match(
    remoteDayBlock,
    /background:\s*var\(--border-subtle\);/,
    'remote timeline rails should match the neutral local timeline rail'
  )
  assert.doesNotMatch(
    cssSource,
    /\.commit-history-row__rail::before/,
    'row-level rails should not overlap between adjacent commit rows'
  )
  assert.doesNotMatch(
    cssSource,
    /\.commit-history-day__list::before/,
    'list-level rails should not create disconnected timeline segments'
  )
})

test('commit history close returns to the projected resting card and waits for animation end', () => {
  const appSource = readSource('src/App.jsx')

  const closeHandlerIndex = appSource.indexOf('const handleCloseCommitHistory = useCallback')
  assert.notEqual(closeHandlerIndex, -1, 'close handler should exist')

  const projectedRectIndex = appSource.indexOf('getRepoCardProjectedRestingRect(commitHistoryRepoId)', closeHandlerIndex)
  const closingIndex = appSource.indexOf('setCommitHistoryDrawerClosing(true)', closeHandlerIndex)
  assert.ok(
    projectedRectIndex > closingIndex,
    'close should project the source card resting rect after the closing layout is active'
  )
  assert.match(
    appSource.slice(closeHandlerIndex, closingIndex + 80),
    /setCommitHistoryHeroStartRect[(]null[)]/,
    'close should clear the previous opening geometry before measuring the post-close target'
  )

  assert.match(
    appSource,
    /onReturnComplete=\{finishCommitHistoryClose\}/,
    'hero return animation should complete the close instead of relying only on a timeout'
  )
  assert.match(
    appSource,
    /setCommitHistoryHeroStartRect\(null\)[\s\S]*?setCommitHistoryDrawerClosing\(true\)[\s\S]*?getRepoCardProjectedRestingRect\(commitHistoryRepoId\)/,
    'close should measure the target only after the closing dashboard layout has been committed'
  )
  assert.match(
    appSource,
    /COMMIT_HISTORY_DRAWER_EXIT_FALLBACK_MS\s*=\s*COMMIT_HISTORY_DRAWER_EXIT_MS\s*\+\s*180/,
    'timeout should be a fallback after the CSS motion duration, not the primary close trigger'
  )
  assert.match(
    appSource,
    /commitHistoryFocusReturnRepoIdRef\s*=\s*useRef\(null\)/,
    'the close lifecycle should retain the source repository for focus restoration'
  )
  assert.match(
    appSource,
    /commitHistoryFocusRestoreFrameRef\s*=\s*useRef\(null\)/,
    'focus restoration should be cancellable when a new history surface opens'
  )
  assert.match(
    appSource,
    /const focusTarget = sourceCard\?\.querySelector\('\.repo-card__history-link'\)[\s\S]*?focusTarget\.focus\(/,
    'close handoff should restore focus to the source card history trigger'
  )
})

test('commit history overlay closes repository floating surfaces globally', () => {
  const appSource = readSource('src/App.jsx')

  assert.match(
    appSource,
    /commitHistoryOverlayActive\s*=\s*false/,
    'RepoCard should accept a global commit-history overlay lock'
  )
  assert.match(
    appSource,
    /const metaHoverBlocked = Boolean\(\s*commitHistoryOpen\s*\|\|\s*commitHistoryOverlayActive\s*\|\|\s*commitHistoryFlight\s*\|\|\s*commitHistoryHandoff\s*\)/,
    'repository meta hover cards should not open while commit history motion owns the dashboard'
  )
  assert.match(
    appSource,
    /if \(!metaHoverBlocked\) return[\s\S]*?closeAllMetaHover\('commit-history'\)/,
    'an already-open meta hover portal should close as soon as the commit history overlay becomes active'
  )
  assert.match(
    appSource,
    /aria-hidden=\{interactive \? undefined : 'true'\}[\s\S]*?inert=\{interactive \? undefined : true\}/,
    'history drawer controls should remain inaccessible until the flight is settled'
  )
  assert.match(
    appSource,
    /commitHistoryOverlayActive=\{isCommitHistoryDrawerOpen\}/,
    'all dashboard cards should receive the overlay lock for the full open and close lifecycle'
  )
  assert.match(
    appSource,
    /if\s*\(\(!isActionOverlayVisible\s*&&\s*!isMissingRepoPath\s*&&\s*!commitHistoryOverlayActive\)\s*\|\|\s*!menuOpen\)\s*return[\s\S]*?closeMenu\(\)/,
    'the repo more menu should close when the commit history overlay becomes active'
  )
  assert.match(
    appSource,
    /setImportMenuAnchor\(null\)[\s\S]*?setBottomImportPanelOpen\(false\)[\s\S]*?setIsDashboardSearchOpen\(false\)[\s\S]*?setDashboardSearchKeyword\(''\)/,
    'opening commit history should close dashboard-level transient panels'
  )
})

test('repository fixed hover cards keep a pointer bridge back to their trigger', () => {
  const appSource = readSource('src/App.jsx')
  const cssSource = readSource('src/App.css')

  assert.match(
    appSource,
    /getRepoCardFloatingHoverBridgeLayout\(/,
    'fixed metadata hover card layout should calculate a bridge between the trigger and portal'
  )
  assert.equal(
    appSource.match(/className="repo-card__meta-hover-bridge"/g)?.length,
    2,
    'branch and commit fixed hover cards should each render one pointer bridge'
  )
  assert.match(
    appSource,
    /branchHoverBridgeStyle[\s\S]*?className="repo-card__meta-hover-bridge"[\s\S]*?\.\.\.branchMetaCardBindings/,
    'branch hover portal should keep the hover state while the pointer crosses the portal gap'
  )
  assert.match(
    appSource,
    /commitHoverBridgeStyle[\s\S]*?className="repo-card__meta-hover-bridge"[\s\S]*?\.\.\.commitMetaCardBindings/,
    'commit hover portal should share the same bridge behavior'
  )
  assert.match(
    cssBlock(cssSource, '.repo-card__meta-hover-bridge'),
    /pointer-events:\s*auto;/,
    'the bridge must be pointer-interactive so host mouseleave does not close the portal early'
  )
})
