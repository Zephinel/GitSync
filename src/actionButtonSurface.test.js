import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const readCssRule = (source, selector) => {
  const lineStart = source.lastIndexOf(`\n${selector} {`)
  const start = lineStart >= 0 ? lineStart + 1 : source.startsWith(`${selector} {`) ? 0 : -1

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

test('root entry loads the canonical action-button surface after feature polish', () => {
  const main = read('./main.jsx')
  const authorityImport = "import './ActionButtonSurface.css'"
  const settingsAuthorityImport = "import './SettingsControlSurface.css'"

  assert.equal((main.match(/import '\.\/ActionButtonSurface\.css'/g) || []).length, 1)
  assert.ok(main.indexOf(authorityImport) > main.indexOf("import './ai/AiReviewStage4.css'"))
  assert.equal((main.match(/import '\.\/SettingsControlSurface\.css'/g) || []).length, 1)
  assert.ok(main.indexOf(settingsAuthorityImport) > main.indexOf(authorityImport))
})

test('settings right-side controls and dashboard/history collapse indicators are borderless', () => {
  const app = read('./App.css')
  const settingsAuthority = read('./SettingsControlSurface.css')
  const arrowRules = app.slice(
    app.indexOf('.history-group__arrow,'),
    app.indexOf('.history-group__entries-wrap'),
  )
  const expectedSettingsControls = [
    '.interval-control__main',
    '.interval-control__units',
    '.concurrency-control',
    '.theme-switcher',
    '.mode-btn-group',
    '.toggle',
    '.github-settings-account',
    '.github-settings-login-btn',
    '.open-app-picker__value',
    '.open-app-picker__btn',
    '.ai-config-badge',
    '.ai-settings-input',
    '.ai-key-status',
    '.ai-model-select .custom-select__trigger',
    '.ai-primary-button',
    '.ai-secondary-button',
    '.ai-danger-button',
  ]

  assert.match(arrowRules, /border:\s*0;/)
  assert.doesNotMatch(arrowRules, /border:\s*1px/)
  assert.doesNotMatch(arrowRules, /border-color:\s*color-mix/)
  for (const selector of expectedSettingsControls) {
    assert.ok(settingsAuthority.includes(selector), `missing settings selector: ${selector}`)
  }
  assert.match(settingsAuthority, /border:\s*0\s*!important;/)
  assert.match(settingsAuthority, /border-color:\s*transparent\s*!important;/)
})

test('toggle knobs stay vertically centered when the track border is removed', () => {
  const app = read('./App.css')
  const toggle = readCssRule(app, '.toggle::after')
  const active = readCssRule(app, '.toggle--active::after')
  const compact = readCssRule(app, '.toggle--compact::after')
  const compactActive = readCssRule(app, '.toggle--compact.toggle--active::after')

  assert.match(toggle, /top:\s*50%;/)
  assert.match(toggle, /transform:\s*translateY\(-50%\);/)
  assert.match(active, /transform:\s*translate\(18px,\s*-50%\);/)
  assert.match(compact, /top:\s*50%;/)
  assert.match(compactActive, /transform:\s*translate\(14px,\s*-50%\);/)
})

test('syncing dashboard cards use the accent-blue glow instead of cyan', () => {
  const app = read('./App.css')
  const cardGlow = readCssRule(app, '.repo-card::before')
  const syncingGlow = readCssRule(app, '.repo-card--syncing::before')
  const glowKeyframes = readCssRule(app, '@keyframes repoSyncGlow')
  const cardGlowCss = `${cardGlow}\n${syncingGlow}\n${glowKeyframes}`

  assert.match(cardGlowCss, /rgba\(91,\s*141,\s*239,\s*0\.14\)/)
  assert.match(cardGlowCss, /rgba\(91,\s*141,\s*239,\s*0\.22\)/)
  assert.match(cardGlowCss, /rgba\(91,\s*141,\s*239,\s*0\.18\)/)
  assert.match(cardGlowCss, /rgba\(91,\s*141,\s*239,\s*0\.32\)/)
  assert.doesNotMatch(cardGlowCss, /rgba\(56,\s*189,\s*248,/)
})

test('visible action-button families share one borderless elevated surface', () => {
  const authority = read('./ActionButtonSurface.css')
  const expectedFamilies = [
    '.action-btn',
    '.dialog-btn',
    '.commit-history-drawer__retry',
    '.commit-history-drawer__close',
    '.commit-history-row__icon-btn',
    '.commit-diff-close',
    '.branch-management-btn',
    '.github-repo-browser__close',
    '.working-changes-file-stage-action',
    '.branch-attention-detail__icon-button',
    '.branch-creation-suggestions button',
    '.stash-entry-action-menu__trigger',
    '.stash-manager-pagination button',
    '.ai-primary-button',
    '.ai-secondary-button',
    '.ai-danger-button',
    '.ai-review-icon-button',
  ]

  for (const family of expectedFamilies) assert.match(authority, new RegExp(family.replaceAll('.', '\\.')))
  assert.match(authority, /--app-action-border: 0;/)
  assert.match(authority, /body:has\(#root\) :where\(/)
  assert.match(authority, /border: var\(--app-action-border\) !important;/)
  assert.match(authority, /box-shadow: var\(--app-action-current-shadow\) !important;/)
  assert.match(authority, /@media \(hover: hover\)/)
  assert.match(authority, /--app-action-hover-transform: none;/)
  assert.match(authority, /--app-action-pressed-transform: scale\(0\.98\);/)
  assert.match(authority, /transform: var\(--app-action-pressed-transform\) !important;/)
  assert.match(authority, /:focus-visible/)
  assert.match(authority, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(authority, /body:has\(#root\) button/)
  assert.doesNotMatch(authority, /0 7px 18px|0 10px 24px/)
  assert.doesNotMatch(authority, /transition:\s*all/)
})

test('dashboard shell actions use the card-colored neutral surface', () => {
  const authority = read('./ActionButtonSurface.css')

  assert.match(
    authority,
    /\.sidebar__sync-all-btn:not\(\.sidebar__sync-all-btn--syncing\),[\s\S]*\.dashboard__header-actions[\s\S]*--app-action-surface-background:\s*var\(--bg-card\);/
  )
  assert.match(
    authority,
    /\.dashboard__header-actions[\s\S]*--app-action-surface-hover-background:\s*color-mix\(in srgb, var\(--accent-blue\) 8%, var\(--bg-card\) 92%\);/
  )
  assert.match(
    authority,
    /\.sidebar__sync-all-btn:not\(\.sidebar__sync-all-btn--syncing\)\s*\{[\s\S]*?--app-action-surface-shadow:\s*var\(--app-dashboard-stat-card-shadow\);/
  )
})

test('file staging buttons preserve semantic color and disabled strength', () => {
  const authority = read('./ActionButtonSurface.css')

  assert.match(authority, /\.working-changes-file-stage-action\s*\{[\s\S]*?--app-action-disabled-opacity:\s*0\.26;/)
  assert.match(authority, /\.working-changes-file-stage-action--unstage,[\s\S]*?--app-action-color:\s*var\(--status-warning\);/)
  assert.match(authority, /\.working-changes-file-stage-action--stage,[\s\S]*?--app-action-color:\s*var\(--status-success\);/)
})

test('composed sync loading state keeps its blue semantic color', () => {
  const authority = read('./ActionButtonSurface.css')
  const app = read('./App.jsx')
  const primaryStateStart = authority.indexOf('body:has(#root) :where(\n  .dashboard__add-btn,')
  const primaryStateEnd = authority.indexOf('\n}\n\nbody:has(#root) :where(', primaryStateStart)
  const primaryState = authority.slice(primaryStateStart, primaryStateEnd)

  assert.match(authority, /body:has\(#root\) :where\(\s*\.sidebar__sync-hover-btn--failed,[\s\S]*?\.action-btn--cancel,[\s\S]*?\)\s*\{[\s\S]*?--app-action-color:\s*var\(--status-warning\);/)
  assert.match(authority, /body:has\(#root\) :where\(\s*\.dashboard__batch-btn--active,[\s\S]*?\.action-btn--syncing,[\s\S]*?\),[\s\S]*?--app-action-color:\s*var\(--accent-blue\);[\s\S]*?--app-action-hover-color:\s*var\(--accent-blue\);/)
  assert.ok(primaryStateStart >= 0)
  assert.ok(primaryStateEnd > primaryStateStart)
  for (const selector of [
    '.sidebar__sync-all-btn--syncing',
    '.sidebar__sync-hover-btn--changed',
    '.sidebar__sync-hover-btn--syncing',
    '.commit-history-toolbar__refresh',
    '.commit-history-drawer__retry',
  ]) {
    assert.match(primaryState, new RegExp(`${selector.replaceAll('.', '\\.')}[\\s\\S]*--app-action-color:\\s*var\\(--accent-blue\\);`))
  }
  assert.match(app, /if \(mode === SYNC_BUTTON_MODE\.syncing\) classes\.push\('action-btn--syncing'\)/)
  assert.match(app, /if \(mode === SYNC_BUTTON_MODE\.queued \|\| mode === SYNC_BUTTON_MODE\.syncing\) classes\.push\('action-btn--cancel'\)/)
})

test('sync cancellation keeps the blue sync surface instead of warning yellow', () => {
  const authority = read('./ActionButtonSurface.css')

  assert.match(
    authority,
    /body:has\(#root\) \.action-btn--sync\.action-btn--cancel\s*\{[\s\S]*?--app-action-state-background:\s*color-mix\(in srgb, var\(--accent-blue\) 18%, var\(--bg-elevated\)\);[\s\S]*?--app-action-hover-background:\s*color-mix\(in srgb, var\(--accent-blue\) 22%, var\(--bg-elevated\)\);[\s\S]*?--app-action-color:\s*var\(--accent-blue\);/
  )
})

test('registered sibling states keep their component semantic colors', () => {
  const authority = read('./ActionButtonSurface.css')
  const blueStart = authority.indexOf('body:has(#root) :where(\n  .dashboard__add-btn,')
  const dangerStart = authority.indexOf('body:has(#root) :where(\n  .batch-action-btn--danger,')
  const warningStart = authority.indexOf('body:has(#root) :where(\n  .sidebar__sync-hover-btn--failed,')
  const successStart = authority.indexOf('body:has(#root) :where(\n  .working-changes-action--stage,')
  const blueState = authority.slice(blueStart, dangerStart)
  const dangerState = authority.slice(dangerStart, warningStart)
  const warningState = authority.slice(warningStart, successStart)

  for (const selector of [
    '.open-app-picker__btn:not(.open-app-picker__btn--ghost)',
    '.undo-toast__btn--primary',
    '.commit-diff-viewer-state button',
    '.commit-diff-large-notice button',
    '.branch-attention-detail__footer button',
    '.ai-review-toolbar-button',
  ]) {
    assert.match(blueState, new RegExp(escapeRegex(selector)))
  }
  for (const selector of ['.branch-management-btn--danger', '.stash-manager-load-error button']) {
    assert.match(dangerState, new RegExp(escapeRegex(selector)))
  }
  for (const selector of [
    '.working-changes-authority-warning:not(.working-changes-authority-warning--info) button',
    '.ai-commit-overwrite__confirm',
  ]) {
    assert.match(warningState, new RegExp(escapeRegex(selector)))
  }
  assert.match(authority, /--app-action-disabled-color:\s*var\(--text-tertiary\);/)
  assert.match(authority, /\.sidebar__sync-all-btn--syncing,[\s\S]*?\.sidebar__sync-hover-btn--syncing\s*\)\s*\{[\s\S]*?--app-action-disabled-color:\s*var\(--accent-blue\);/)
})

test('successful commit-hash copy feedback uses the success action tone', () => {
  const app = read('./App.jsx')
  const copyHashStart = app.indexOf("title: '已复制提交 hash'")
  const copyHashEnd = app.indexOf('\n      })', copyHashStart)
  const copyHashFeedback = app.slice(copyHashStart, copyHashEnd)

  assert.match(copyHashFeedback, /title: '已复制提交 hash',[\s\S]*?message: text,[\s\S]*?tone: 'success'/)
})

test('RepoCard metadata icon actions stay component-owned while operation controls share the button authority', () => {
  const authority = read('./ActionButtonSurface.css')
  const app = read('./App.css')

  for (const selector of [
    '.repo-card__branch-row-action',
    '.branch-management-hover-expand',
    '.branch-management-hover-action',
    '.branch-management-icon-action',
    '.branch-management-batch-toggle',
    '.branch-management-text-action',
    '.branch-management-row__actions',
  ]) {
    assert.match(authority, new RegExp(escapeRegex(selector)))
  }
  for (const selector of [
    '.repo-card__meta-copy-btn',
    '.repo-card__history-link',
    '.repo-card__branch-row-copy',
  ]) {
    assert.doesNotMatch(authority, new RegExp(escapeRegex(selector)))
  }
  assert.match(app, /\.repo-card__meta-copy-btn\s*\{[\s\S]*?background:\s*transparent;/)
  assert.match(app, /\.repo-card__history-link\s*\{[\s\S]*?background:\s*transparent;/)
  assert.match(app, /\.repo-card__branch-row-copy\s*\{[\s\S]*?background:\s*transparent;/)
  assert.doesNotMatch(authority, /\.repo-card__actions-checking-overlay/)
  assert.doesNotMatch(authority, /\.repo-card__more-menu/)
  assert.match(authority, /\.branch-management-btn:not\(\.branch-management-create-header\)/)
  assert.doesNotMatch(authority, /\.stash-entry-action-menu__panel\s*>\s*button/)
  assert.doesNotMatch(authority, /\[role=["']menuitem["']\]/)
  assert.match(app, /\.repo-card__more-menu\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/)
  assert.match(app, /\.repo-card__more-item\s*\{[\s\S]*?width:\s*100%;[\s\S]*?border:\s*0;/)
  assert.match(app, /\.repo-card__more-item:hover\s*\{[\s\S]*?background:\s*color-mix\(/)
  assert.doesNotMatch(app, /\.repo-card__more-item:hover\s*\{[^}]*border-color:/)
})

test('Import entry menu keeps flat rows and symmetric horizontal space', () => {
  const authority = read('./ActionButtonSurface.css')
  const app = read('./App.css')
  const scrollbar = read('./ScrollBarSurface.css')
  const itemRule = readCssRule(app, '.import-entry-menu__item')

  assert.doesNotMatch(authority, /\.import-entry-menu__item/)
  assert.match(itemRule, /border:\s*0;/)
  assert.match(itemRule, /background:\s*transparent;/)
  assert.match(itemRule, /padding:\s*10px 11px;/)
  assert.match(
    scrollbar,
    /\.repo-card__meta-hover-card,[\s\S]*\.import-entry-menu[\s\S]*scrollbar-gutter:\s*auto;/
  )
})

test('layout switcher keeps only the selected segment filled', () => {
  const authority = read('./ActionButtonSurface.css')
  const app = read('./App.css')

  assert.doesNotMatch(authority, /layout-switcher__btn/)
  assert.match(app, /\.dashboard__header-actions \.layout-switcher::before\s*\{[\s\S]*?transition:\s*transform 220ms cubic-bezier\(0\.16, 1, 0\.3, 1\);/)
  assert.match(app, /\.layout-switcher:has\(\.layout-switcher__btn--active:nth-child\(2\)\)::before\s*\{[\s\S]*?transform:\s*translateX\(calc\(100% \+ 4px\)\);/)
  assert.match(app, /\.layout-switcher__btn\s*\{[\s\S]*?background:\s*transparent;/)
  assert.match(app, /\.layout-switcher__btn:focus-visible\s*\{[\s\S]*?box-shadow:\s*0 0 0 2px color-mix\(/)
  assert.match(app, /\.layout-switcher__btn--active\s*\{[\s\S]*?background:\s*transparent;/)
  assert.match(app, /\.dashboard__header-actions \.layout-switcher::before\s*\{[\s\S]*?background:\s*rgba\(91, 141, 239, 0\.14\);/)
  assert.match(app, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.dashboard__header-actions \.layout-switcher::before\s*\{[\s\S]*?transition-duration:\s*1ms;/)
})

test('floating menu shells match the borderless branch hover surface', () => {
  const app = read('./App.css')
  const stashActionMenu = read('./StashEntryActionMenu.css')
  const stashManagement = read('./StashManagementPopover.css')
  const ai = read('./ai/Ai.css')
  const floatingMenus = [
    [app, '.repo-card__more-menu'],
    [app, '.import-entry-menu'],
    [app, '.app-tooltip'],
    [app, '.custom-select__menu'],
    [stashActionMenu, '.stash-entry-action-menu__panel'],
    [stashManagement, '.stash-management-popover'],
    [ai, '.ai-model-select .custom-select__menu'],
  ]

  for (const [source, selector] of floatingMenus) {
    const rule = readCssRule(source, selector)
    assert.match(rule, /border:\s*0;/, `${selector} should have no outer border`)
    assert.match(rule, /box-shadow:/, `${selector} should retain elevation`)
  }
})

test('registered operation controls use tonal surfaces while composite state surfaces stay component-owned', () => {
  const app = read('./App.css')
  const hover = read('./BranchSwitchActionIcon.css')

  const overlayRule = readCssRule(app, '.repo-card__actions-checking-overlay')
  assert.match(overlayRule, /border:\s*0;/)
  assert.match(overlayRule, /background:\s*var\(--app-action-surface-background\)/)
  assert.match(overlayRule, /box-shadow:\s*none;/)
  assert.match(hover, /\.repo-card__branch-row-actions[\s\S]*?background:\s*transparent !important/)
  assert.match(hover, /\.repo-card__branch-row-actions[\s\S]*?box-shadow:\s*none !important/)

  const completeView = read('./BranchManagementLayer.css')
  assert.match(completeView, /\.branch-management-row__actions button\s*\{[\s\S]*?border:\s*0;/)
  assert.match(completeView, /\.branch-management-row__actions button\s*\{[\s\S]*?background:\s*var\(--app-action-surface-background\)/)
})

test('stash file rows keep an explicit keyboard focus ring after border removal', () => {
  const stash = read('./StashDetailView.css')
  const focusRule = readCssRule(stash, '.stash-detail-file-group > button:focus-visible')

  assert.match(focusRule, /outline:\s*0;/)
  assert.match(focusRule, /box-shadow:\s*0 0 0 3px color-mix\(/)
  assert.doesNotMatch(focusRule, /border(?:-color)?:/)
})

test('repository status surfaces are borderless and dashboard cards use visible shared elevation', () => {
  const app = read('./App.css')
  const authority = read('./ActionButtonSurface.css')
  const branchManagement = read('./BranchManagementLayer.css')
  const branchActions = read('./BranchManagementActions.css')
  const fileSurfaces = read('./CommitDiffFileListShared.css')
  const workingCell = read('./WorkingChangesFileCell.jsx')
  const workingCellCss = read('./WorkingChangesFileCell.css')
  const workingGroups = read('./WorkingChangesGroups.css')
  const commitDiffView = read('./CommitDiffView.jsx')
  const workingChangesView = read('./WorkingChangesView.jsx')
  const repoCardRule = readCssRule(app, '.repo-card')
  const historyGroupRule = readCssRule(app, '.history-group')
  const historyEntryRule = readCssRule(app, '.history-entry')
  const floatingShadow = authority.match(/--app-floating-card-shadow:\s*([\s\S]*?);/)?.[1]
  const historyEntryShadow = authority.match(/--app-history-entry-shadow:\s*([\s\S]*?);/)?.[1]
  const statCardShadow = authority.match(/--app-dashboard-stat-card-shadow:\s*([\s\S]*?);/)?.[1]

  assert.match(app, /\.sync-info\s*\{[\s\S]*?border:\s*0;/)
  assert.match(app, /\.sync-badge\s*\{[\s\S]*?border:\s*0;/)
  assert.match(app, /\.repo-card__branch-attention\s*\{[\s\S]*?border:\s*0;/)
  assert.match(app, /\.repo-card__state-callout\s*\{[\s\S]*?border:\s*0;/)
  assert.match(app, /\.repo-card__actions-checking-overlay\s*\{[\s\S]*?border:\s*0;/)
  assert.match(authority, /--app-large-surface-shadow:/)
  assert.match(authority, /--app-dashboard-card-shadow:/)
  assert.match(authority, /--app-dashboard-stat-card-shadow:/)
  assert.match(authority, /--app-large-surface-hover-shadow:/)
  assert.match(authority, /--app-floating-card-shadow:/)
  assert.match(authority, /--app-floating-card-hover-shadow:/)
  assert.match(authority, /--app-history-entry-shadow:/)
  assert.match(authority, /--app-history-entry-hover-shadow:/)
  assert.match(authority, /--app-history-group-background:/)
  assert.match(
    authority,
    /\[data-theme="light"\]\s*\{[\s\S]*?--app-history-group-background:\s*var\(--bg-card\);/
  )
  assert.match(
    authority,
    /\[data-theme="light"\]\s*\{[\s\S]*?--app-history-entry-shadow:\s*0 0 12px rgba\(20, 31, 55, 0\.12\);/
  )
  assert.match(
    authority,
    /\[data-theme="light"\]\s*\{[\s\S]*?--app-history-entry-hover-shadow:\s*0 0 14px rgba\(20, 31, 55, 0\.16\);/
  )
  assert.match(authority, /--app-file-card-shadow:/)
  assert.match(authority, /--app-file-card-hover-shadow:/)
  assert.match(app, /\.dashboard-repo-summary\s*\{[\s\S]*?display:\s*flex;/)
  assert.doesNotMatch(app, /\.dashboard-group__header\s*\{/)
  assert.match(repoCardRule, /border:\s*0;/)
  assert.doesNotMatch(repoCardRule, /border-color:/)
  assert.match(repoCardRule, /box-shadow:\s*var\(--app-dashboard-card-shadow\);/)
  assert.match(authority, /body:has\(#root\) \.sidebar__stats \.stat-item\s*\{[\s\S]*?box-shadow:\s*var\(--app-dashboard-stat-card-shadow\) !important;/)
  assert.ok(statCardShadow)
  assert.match(statCardShadow, /0 0 12px -3px/)
  assert.match(statCardShadow, /0 0 2px/)
  assert.match(authority, /--app-dashboard-card-hover-shadow:/)
  assert.ok(floatingShadow)
  assert.match(floatingShadow, /0 4px 8px -2px rgba\(0, 0, 0, 0\.14\)/)
  assert.doesNotMatch(floatingShadow, /inset 0 1px 0/)
  assert.match(historyGroupRule, /border:\s*0;/)
  assert.match(historyGroupRule, /background:\s*var\(--app-history-group-background\);/)
  assert.match(historyGroupRule, /box-shadow:\s*var\(--app-floating-card-shadow\);/)
  assert.match(historyEntryRule, /border:\s*0;/)
  assert.match(historyEntryRule, /box-shadow:\s*var\(--app-history-entry-shadow\);/)
  assert.ok(historyEntryShadow)
  assert.match(historyEntryShadow, /0 0 12px rgba\(0, 0, 0, 0\.24\)/)
  assert.doesNotMatch(historyEntryShadow, /inset 0 1px 0/)
  assert.match(app, /\.repo-card--selected\s*\{[\s\S]*?box-shadow:\s*var\(--app-dashboard-card-hover-shadow\)/)
  assert.match(app, /\.repo-card:not\(\.repo-card--syncing\):hover,[\s\S]*?box-shadow:\s*var\(--app-dashboard-card-hover-shadow\)/)
  assert.match(app, /\.repo-card--selected\s*\{[\s\S]*?transform:\s*translateY\(-2px\) scale\(1\.006\);/)
  assert.match(app, /\.repo-card:not\(\.repo-card--syncing\):hover,[\s\S]*?transform:\s*translateY\(-2px\) scale\(1\.006\);/)

  assert.match(app, /\.repo-card__meta-hover-card\s*\{[\s\S]*?border:\s*0;/)
  assert.match(app, /\.commit-history-row__bubble\s*\{[\s\S]*?border:\s*0;/)
  assert.match(app, /\.commit-history-row__bubble::before\s*\{[\s\S]*?border:\s*0;/)
  assert.match(branchManagement, /\.branch-management-sheet\s*\{[\s\S]*?border:\s*0;/)
  assert.match(authority, /--app-card-highlight-background:/)
  assert.match(authority, /--app-card-highlight-background:\s*var\(--bg-card\);/)
  assert.doesNotMatch(authority, /--app-card-highlight-background:\s*[^;]*color-mix\(in srgb, var\(--accent-blue\)/)
  assert.match(authority, /--app-card-highlight-shadow:/)
  assert.match(authority, /--app-card-highlight-shadow:\s*var\(--app-large-surface-hover-shadow\);/)
  assert.doesNotMatch(authority, /--app-card-highlight-shadow:\s*[^;]*color-mix\(in srgb, var\(--accent-blue\)/)
  assert.match(authority, /\.branch-creation-suggestion--selected/)
  assert.match(authority, /\.stash-manager-pagination__active/)
  assert.match(app, /\.repo-card--selected\s*\{[\s\S]*?background:\s*var\(--app-card-highlight-background\);/)
  assert.match(app, /\.repo-card:not\(\.repo-card--syncing\):hover,[\s\S]*?background:\s*var\(--app-card-highlight-background\);/)
  assert.match(branchActions, /\.branch-management-row--selected\s*\{[\s\S]*?border-color:\s*transparent;[\s\S]*?background:\s*var\(--bg-card-hover\);/)
  assert.match(app, /\.commit-history-row__bubble\s*\{[\s\S]*?box-shadow:\s*var\(--app-floating-card-shadow\);/)
  assert.match(commitDiffView, /import CommitDiffFileCard from '\.\/CommitDiffFileCard\.jsx'/)
  assert.match(workingChangesView, /import WorkingChangesFileCell from '\.\/WorkingChangesFileCell\.jsx'/)
  assert.match(commitDiffView, /<CommitDiffFileCard/)
  assert.match(workingChangesView, /<WorkingChangesFileCell/)
  assert.match(workingCell, /className="working-changes-file-cell__preview"/)
  assert.match(fileSurfaces, /\.commit-diff-file-card\s*\{[\s\S]*?background:\s*var\(--bg-card\) !important;[\s\S]*?box-shadow:\s*var\(--app-file-card-shadow\) !important;/)
  assert.match(fileSurfaces, /\.commit-diff-file-card__content\s*\{[\s\S]*?border:\s*0 !important;[\s\S]*?background:\s*transparent !important;[\s\S]*?box-shadow:\s*none !important;/)
  assert.match(workingCellCss, /\.working-changes-file-cell\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*var\(--bg-card\);[\s\S]*?box-shadow:\s*var\(--app-file-card-shadow\);/)
  assert.match(workingCellCss, /\.working-changes-file-cell__preview\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/)
  assert.match(app, /\.commit-history-row__bubble::before\s*\{[\s\S]*?filter:\s*drop-shadow\(/)
  assert.match(fileSurfaces, /\.commit-diff-file-list\s*\{[\s\S]*?padding:\s*22px 18px 40px !important;/)
  assert.doesNotMatch(fileSurfaces, /\.working-changes-file-list\s*\{/)
  assert.match(workingGroups, /\.working-changes-group\s*\{[\s\S]*?background:\s*transparent;/)
  const largeSurfaceSelectorBlock = authority.match(/body:has\(#root\) :where\(\s*\.stat-item,[\s\S]*?\)\s*\{\s*border:\s*0 !important;[\s\S]*?box-shadow:\s*var\(--app-large-surface-shadow\) !important;/)?.[0]
  assert.ok(largeSurfaceSelectorBlock)
  assert.doesNotMatch(largeSurfaceSelectorBlock, /\.working-changes-group/)
  assert.match(authority, /body:has\(#root\) :where\(\s*\.branch-attention-detail__row:hover,[\s\S]*?box-shadow:\s*var\(--app-card-highlight-shadow\) !important;/)
  assert.match(workingGroups, /\.working-changes-group\s*\{[\s\S]*?box-shadow:\s*none;[\s\S]*?outline:\s*0;[\s\S]*?filter:\s*none;/)
  assert.match(workingGroups, /\.working-changes-group__files\s*\{[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;[\s\S]*?outline:\s*0;[\s\S]*?background:\s*transparent;/)
  assert.match(workingGroups, /\.working-changes-group::before,[\s\S]*?\.working-changes-group__files::after\s*\{[\s\S]*?content:\s*none;/)
  assert.match(authority, /\.working-changes-group,\s*[\r\n]+body:has\(#root\) \.working-changes-file-list\s*\{[\s\S]*?box-shadow:\s*none !important;/)
  assert.match(authority, /\.working-changes-sheet \.commit-diff-sidebar\s*\{[\s\S]*?border:\s*0 !important;/)
  assert.doesNotMatch(authority, /--app-working-list-card-(?:hover-)?shadow/)
  assert.doesNotMatch(authority, /commit-diff-file-card-surface/)
  assert.doesNotMatch(authority, /\.working-changes-file-row[\s\S]*?::after/)
  assert.match(authority, /body:has\(#root\) \.commit-diff-file-card\s*\{[\s\S]*?box-shadow:\s*var\(--app-file-card-shadow\) !important;/)
  assert.match(workingGroups, /\.working-changes-group__header\s*\{[\s\S]*?box-shadow:\s*var\(--app-floating-card-shadow\);/)
})

test('secondary window and card surfaces use borderless elevation across feature layers', () => {
  const authority = read('./ActionButtonSurface.css')
  const expectedSurfaces = [
    '.commit-diff-sheet',
    '.commit-history-toolbar',
    '.commit-diff-file-card',
    '.commit-diff-state',
    '.working-changes-dialog__warning',
    '.branch-attention-detail__sheet',
    '.branch-attention-detail__row',
    '.branch-attention-detail__feedback',
    '.branch-management-sheet',
    '.branch-management-row',
    '.branch-management-confirm',
    '.branch-management-notice',
    '.batch-toolbar',
    '.dashboard__search-empty',
    '.commit-history-drawer',
    '.history-group',
    '.history-entry',
    '.conflict-file',
    '.sync-guard-dialog__section',
    '.github-repo-browser',
    '.github-repo-browser__clone-panel',
    '.stash-manager-dialog',
    '.stash-manager-toast',
    '.stash-manager-item',
    '.stash-manager-table-scroll',
    '.stash-detail-layout',
    '.stash-detail-state',
    '.stash-detail-warning',
    '.ai-commit-coverage ul',
    '.ai-review-cache-badge',
    '.ai-review-drawer',
    '.ai-review-section',
    '.ai-request-feedback',
    '.dashboard-loading__panel',
    '.repo-card__missing-overlay-card',
    '.status-toast',
  ]

  for (const surface of expectedSurfaces) assert.match(authority, new RegExp(surface.replaceAll('.', '\\.') + '[\\s,)]'))
  assert.match(authority, /secondary windows and their content cards/i)
  assert.match(authority, /border:\s*0\s*!important;/)
  assert.match(authority, /border-color:\s*transparent\s*!important;/)
  assert.match(authority, /--app-secondary-surface-shadow:/)
  assert.match(authority, /\.commit-history-toolbar--embedded\s*\{[\s\S]*?box-shadow:\s*none !important;/)
  assert.doesNotMatch(authority, /\.repo-card__branch-row(?:\s*[,)]|\s*\{)/)
  assert.doesNotMatch(authority, /\.repo-card__branch-tag\b/)
  assert.doesNotMatch(authority, /\.repo-card__branch-row-state\b/)
  assert.doesNotMatch(authority, /\.repo-card__more-menu/)
  assert.doesNotMatch(authority, /\.stash-entry-action-menu__panel/)
})

test('bottom-right toast surfaces use a theme-aware floating shadow', () => {
  const authority = read('./ActionButtonSurface.css')

  assert.match(
    authority,
    /--app-toast-shadow:\s*[\s\S]*?0 14px 32px rgba\(0, 0, 0, 0\.28\)/,
    'dark theme should give the toast card a visible downward shadow'
  )
  assert.match(
    authority,
    /--app-toast-shadow:\s*[\s\S]*?0 0 14px rgba\(0, 0, 0, 0\.16\)/,
    'dark theme should keep a soft card shadow around the toast'
  )
  assert.match(
    authority,
    /\[data-theme="light"\]\s*\{[\s\S]*?--app-toast-shadow:\s*[\s\S]*?0 14px 32px rgba\(20, 31, 55, 0\.13\)/,
    'light theme should give the toast card a visible downward shadow'
  )
  assert.match(
    authority,
    /\[data-theme="light"\]\s*\{[\s\S]*?--app-toast-shadow:\s*[\s\S]*?0 0 14px rgba\(20, 31, 55, 0\.06\)/,
    'light theme should keep a soft card shadow around the toast'
  )
  const shadowValues = [...authority.matchAll(/--app-toast-shadow:\s*([\s\S]*?);/g)].map((match) => match[1])
  assert.equal(shadowValues.length, 2)
  for (const shadowValue of shadowValues) assert.doesNotMatch(shadowValue, /0 0 0 1px/)
  assert.match(
    authority,
    /body:has\(#root\) :where\(\s*\.undo-toast,\s*\.import-loading-toast,\s*\.status-toast\s*\)\s*\{[\s\S]*?box-shadow:\s*var\(--app-toast-shadow\) !important;/,
    'all bottom-right toast variants should use the dedicated toast shadow'
  )
})

test('toast surfaces stay borderless while using a dedicated floating shadow', () => {
  const authority = read('./ActionButtonSurface.css')
  const sharedSurfaceStart = authority.indexOf('body:has(#root) :where(\n  .stat-item,')
  const sharedSurfaceEnd = authority.indexOf('\n}\n\n/* Toasts are floating feedback', sharedSurfaceStart)
  assert.ok(sharedSurfaceStart >= 0)
  assert.ok(sharedSurfaceEnd > sharedSurfaceStart)

  const sharedSurfaceRule = authority.slice(sharedSurfaceStart, sharedSurfaceEnd)
  assert.doesNotMatch(sharedSurfaceRule, /\.undo-toast/)
  assert.doesNotMatch(sharedSurfaceRule, /\.import-loading-toast/)
  assert.doesNotMatch(sharedSurfaceRule, /\.status-toast/)
  assert.match(
    authority,
    /body:has\(#root\) :where\(\s*\.undo-toast,\s*\.import-loading-toast,\s*\.status-toast\s*\)\s*\{[\s\S]*?border:\s*0 !important;[\s\S]*?border-color:\s*transparent !important;[\s\S]*?box-shadow:\s*var\(--app-toast-shadow\) !important;/,
    'toast border and shadow should have one selector authority without competing specificity'
  )
})

test('root entry loads the canonical scrollbar surface after feature polish', () => {
  const main = read('./main.jsx')
  const actionIndex = main.indexOf("import './ActionButtonSurface.css'")
  const scrollbarImport = "import './ScrollBarSurface.css'"

  assert.equal((main.match(/import '\.\/ScrollBarSurface\.css'/g) || []).length, 1)
  assert.ok(main.indexOf(scrollbarImport) > actionIndex)
})

test('scrollbar thumbs have an inset, low-emphasis surface across sibling scroll containers', () => {
  const authority = read('./ScrollBarSurface.css')
  const fileListSurfaces = read('./CommitDiffFileListShared.css')
  const stableGutterTargets = authority.match(/Reserve a stable lane[\s\S]*?:where\(([\s\S]*?)\)\s*\{\s*scrollbar-gutter:\s*stable;/)?.[1]
  const hoverThumb = authority.match(/\*::-webkit-scrollbar-thumb:hover\s*\{([^}]*)\}/)?.[1]
  const activeThumb = authority.match(/\*::-webkit-scrollbar-thumb:active\s*\{([^}]*)\}/)?.[1]

  assert.ok(stableGutterTargets)
  assert.ok(hoverThumb)
  assert.ok(activeThumb)
  assert.match(authority, /body:has\(#root\)\s+\*::-webkit-scrollbar\s*\{[\s\S]*width:\s*12px !important;[\s\S]*height:\s*12px !important;/)
  assert.match(authority, /body:has\(#root\)\s+\*::-webkit-scrollbar-track\s*\{[\s\S]*background:\s*transparent !important;/)
  assert.match(authority, /body:has\(#root\)\s+\*::-webkit-scrollbar-thumb\s*\{[\s\S]*border:\s*3px solid transparent !important;/)
  assert.match(authority, /body:has\(#root\)\s+\*::-webkit-scrollbar-thumb\s*\{[\s\S]*border-radius:\s*999px !important;/)
  assert.match(authority, /body:has\(#root\)\s+\*::-webkit-scrollbar-thumb\s*\{[\s\S]*background-clip:\s*padding-box !important;/)
  assert.match(hoverThumb, /background-color:\s*var\(--app-scrollbar-thumb-hover\) !important;/)
  assert.match(activeThumb, /background-color:\s*var\(--app-scrollbar-thumb-active\) !important;/)
  assert.doesNotMatch(hoverThumb, /\bbackground:\s/)
  assert.doesNotMatch(activeThumb, /\bbackground:\s/)
  assert.match(authority, /scrollbar-gutter:\s*stable;/)
  assert.doesNotMatch(stableGutterTargets, /\.repo-card__more-menu/)
  assert.doesNotMatch(stableGutterTargets, /\.commit-diff-file-list/)
  assert.doesNotMatch(stableGutterTargets, /\.stash-entry-action-menu__panel/)
  assert.match(fileListSurfaces, /\.commit-diff-file-list\s*\{[\s\S]*?scrollbar-gutter:\s*auto;/)
  assert.match(authority, /\.repo-card__meta-hover-card,[\s\S]*\.repo-card__more-menu,[\s\S]*\.stash-entry-action-menu__panel[\s\S]*\)\s*\{\s*scrollbar-gutter:\s*auto;/)
  assert.doesNotMatch(authority, /\.repo-card__meta-hover-card,\s*\.repo-card__branch-hover-list/)
  assert.match(authority, /branch-attention-detail__content/)
  assert.match(authority, /commit-history-drawer__body/)
  assert.match(authority, /stash-manager-body/)
  assert.match(authority, /ai-review-drawer__content/)
})

test('main content keeps its intentionally hidden scrollbar', () => {
  const authority = read('./ScrollBarSurface.css')

  assert.match(authority, /body:has\(#root\) \.main-content\s*\{[\s\S]*scrollbar-width:\s*none !important;/)
  assert.match(authority, /body:has\(#root\) \.main-content::-webkit-scrollbar\s*\{[\s\S]*width:\s*0 !important;[\s\S]*height:\s*0 !important;[\s\S]*display:\s*none !important;/)
})

test('dialog buttons keep icon and label on one vertically centered flex row', () => {
  const app = read('./App.css')
  const dialogButton = readCssRule(app, '.dialog-btn')

  assert.match(dialogButton, /display:\s*inline-flex;/)
  assert.match(dialogButton, /align-items:\s*center;/)
  assert.match(dialogButton, /justify-content:\s*center;/)
  assert.match(dialogButton, /gap:\s*6px;/)
})

test('notice dialog footer separates adjacent action buttons', () => {
  const app = read('./App.css')
  const footer = readCssRule(app, '.notice-dialog__footer')

  assert.match(footer, /display:\s*flex;/)
  assert.match(footer, /justify-content:\s*flex-end;/)
  // The update dialog renders two buttons (「稍后」/「现在重启并安装」); without a gap they
  // sit flush against each other. 8px matches every other flex-end action row in App.css.
  assert.match(footer, /gap:\s*8px;/)
})
