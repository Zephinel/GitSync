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

test('commit diff layer owns the app and dashboard extension siblings at the root', () => {
  const mainSource = readSource('src/main.jsx')

  assert.match(mainSource, /import CommitDiffLayer from '\.\/CommitDiffLayer\.jsx'/)
  const layerOpen = mainSource.indexOf('<CommitDiffLayer>')
  const app = mainSource.indexOf('<App />', layerOpen)
  const branchLayer = mainSource.indexOf('<BranchManagementLayer />', app)
  const workingLayer = mainSource.indexOf('<WorkingChangesLayer />', branchLayer)
  const layerClose = mainSource.indexOf('</CommitDiffLayer>', workingLayer)
  assert.ok(layerOpen >= 0 && layerOpen < app && app < branchLayer && branchLayer < workingLayer && workingLayer < layerClose)
})

test('commit diff view is lazy loaded and layered styles are loaded globally', () => {
  const layerSource = readSource('src/CommitDiffLayer.jsx')

  assert.match(layerSource, /const loadCommitDiffView = \(\) => import\('\.\/CommitDiffView\.jsx'\)/)
  assert.match(layerSource, /requestIdleCallback/)
  assert.match(layerSource, /import \{ CommitDiffLoadingCard \} from '\.\/CommitDiffLoadingCard\.jsx'/)
  assert.match(layerSource, /import CommitDiffSettingsSection from '\.\/CommitDiffSettingsSection\.jsx'/)
  assert.match(layerSource, /import \{ COMMIT_DIFF_OPEN_EVENT \} from '\.\/events'/)
  assert.match(layerSource, /import \{ normalizeCommitDiffViewStyle, readCommitDiffViewStyle \} from '\.\/commitDiffSettings'/)
  assert.match(layerSource, /<CommitDiffLoadingCard data=\{commitDiffData\} onClose=\{closeCommitDiff\} \/>/)
  assert.match(layerSource, /<CommitDiffSettingsSection \/>/)
  assert.match(layerSource, /commitDiffViewStyle: normalizeCommitDiffViewStyle/)
  assert.match(layerSource, /import '\.\/CommitDiffView\.css'/)
  assert.match(layerSource, /import '\.\/CommitDiffRendered\.css'/)
  assert.match(layerSource, /import '\.\/CommitDiffScrollbars\.css'/)
  assert.match(layerSource, /import '\.\/CommitDiffPolish\.css'/)
  assert.match(layerSource, /import '\.\/CommitDiffFinal\.css'/)
  assert.match(layerSource, /import '\.\/CommitDiffSplit\.css'/)
  assert.match(layerSource, /import '\.\/CommitDiffHeaderLayout\.css'/)
  assert.match(layerSource, /import '\.\/CommitDiffFileListShared\.css'/)
  assert.match(layerSource, /import '\.\/ImageDiffSwipeFix\.css'/)
})

test('commit diff settings section reuses settings section UI', () => {
  const sectionSource = readSource('src/CommitDiffSettingsSection.jsx')
  const settingsSource = readSource('src/commitDiffSettings.js')
  const segmentedCssSource = readSource('src/SettingsSegmentedControls.css')

  assert.match(sectionSource, /import '\.\/SettingsSegmentedControls\.css'/)
  assert.match(sectionSource, /ensureCommitDiffSettingsMount/)
  assert.match(sectionSource, /getCommitDiffSettingsObserverTarget/)
  assert.match(sectionSource, /observerTarget \? new MutationObserver\(updateMount\) : null/)
  assert.match(sectionSource, /observer\?\.observe\(observerTarget, \{ childList: true \}\)/)
  assert.doesNotMatch(sectionSource, /document\.body, \{ childList: true, subtree: true \}/)
  assert.match(sectionSource, /observer\?\.disconnect\(\)/)
  assert.match(sectionSource, /window\.removeEventListener\(COMMIT_DIFF_VIEW_STYLE_CHANGED_EVENT/)
  assert.match(sectionSource, /window\.removeEventListener\('storage'/)
  assert.match(sectionSource, /event\.key === null/)
  assert.match(sectionSource, /settings__row commit-diff-settings-row/)
  assert.doesNotMatch(sectionSource, /settings__section-title">Diff 样式/)
  assert.match(sectionSource, /mode-btn-group/)
  assert.match(sectionSource, /默认 Diff 样式/)
  assert.match(sectionSource, /统一视图/)
  assert.match(sectionSource, /分栏视图/)
  assert.match(sectionSource, /writeCommitDiffViewStyle/)
  assert.match(settingsSource, /commitDiffViewStyle/)
  assert.match(settingsSource, /COMMIT_DIFF_SETTINGS_STORAGE_KEY = 'gitsync-commit-diff-settings'/)
  assert.match(settingsSource, /COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY = 'gitsync-settings'/)
  assert.match(settingsSource, /normalizeCommitDiffViewStyle/)
  assert.match(cssBlock(segmentedCssSource, '.settings .theme-switcher,'), /background:\s*var\(--bg-elevated\);/)
  assert.match(cssBlock(segmentedCssSource, '.settings .theme-btn,'), /background:\s*transparent;/)
  assert.match(cssBlock(segmentedCssSource, '.settings .theme-btn--active,'), /background:\s*var\(--bg-card\);/)
})

test('commit history renders native diff row actions and opens the layer by event', () => {
  const appSource = readSource('src/App.jsx')
  const layerSource = readSource('src/CommitDiffLayer.jsx')
  const appCssSource = readSource('src/App.css')
  const finalCssSource = readSource('src/CommitDiffFinal.css')

  assert.match(appSource, /import \{ COMMIT_DIFF_OPEN_EVENT, REPO_WORKING_CHANGES_CHANGED_EVENT \} from '\.\/events'/)
  assert.match(appSource, /className="commit-history-row__actions"/)
  assert.match(appSource, /className="commit-history-row__icon-btn commit-history-row__copy"/)
  assert.match(appSource, /className="commit-history-row__icon-btn commit-history-row__diff"/)
  assert.match(appSource, /window\.dispatchEvent\(new CustomEvent\(COMMIT_DIFF_OPEN_EVENT/)
  assert.match(appSource, /repoName:\s*repoContext\.repoName/)
  assert.match(appSource, /repoPath:\s*repoContext\.repoPath/)
  assert.match(appSource, /const commitBranchName = normalizeCommitHistoryBranchName\(commit\?\.branch\) \|\| repoContext\?\.branchName/)
  assert.match(appSource, /branchName:\s*commitBranchName/)
  assert.match(appSource, /repoContext=\{repoContext\}/)
  assert.doesNotMatch(layerSource, /MutationObserver|querySelector|appendChild|dataset\.commitDiffAction|handleDelegatedClick|installCommitDiffButtons|COMMIT_DIFF_RUNTIME_STYLE_ID/)
  assert.match(layerSource, /window\.addEventListener\(COMMIT_DIFF_OPEN_EVENT/)
  assert.doesNotMatch(finalCssSource, /commit-history-/)
  assert.doesNotMatch(finalCssSource, /!important/)
  assert.match(cssBlock(appCssSource, '.commit-history-row__bubble'), /grid-template-columns:\s*minmax\(0,\s*1fr\) 32px;/)
  assert.match(cssBlock(appCssSource, '.commit-history-row__actions'), /justify-content:\s*space-between;/)
  assert.match(cssBlock(appCssSource, '.commit-history-row__icon-btn'), /width:\s*32px;/)
  assert.match(cssBlock(appCssSource, '.commit-history-row__icon-btn'), /border:\s*0;/)
  assert.match(cssBlock(appCssSource, '.commit-history-row__icon-btn'), /background:\s*var\(--bg-card\);/)
})

test('commit diff loads summary and selected-file patch commands', () => {
  const viewSource = readSource('src/CommitDiffView.jsx')

  assert.match(viewSource, /invoke\('get_repo_commit_diff_summary'/)
  assert.match(viewSource, /invoke\('get_repo_commit_file_diff'/)
})

test('commit history file cards use the full sidebar width and present basename before path', () => {
  const viewSource = readSource('src/CommitDiffView.jsx')
  const sharedCssSource = readSource('src/CommitDiffFileListShared.css')
  const identityStart = viewSource.indexOf('<span className="commit-diff-file-item__main">')
  const identityEnd = viewSource.indexOf('<span className="commit-diff-file-item__side">', identityStart)

  assert.ok(identityStart >= 0 && identityEnd > identityStart)
  const identity = viewSource.slice(identityStart, identityEnd)
  assert.match(sharedCssSource, /\.commit-diff-file-list\s*\{[\s\S]*padding:\s*22px 18px 40px !important;/)
  assert.match(identity, /commit-diff-file-item__path[\s\S]*\{pathParts\.fileName\}/)
  assert.match(identity, /commit-diff-file-item__location[\s\S]*\{file\.path\}/)
  assert.ok(
    identity.indexOf('commit-diff-file-item__path') < identity.indexOf('commit-diff-file-item__location'),
    'basename must precede the repository-relative path'
  )
  assert.doesNotMatch(identity, /commit-diff-file-item__dir|pathParts\.directory/)
})

test('commit diff viewer renders unified and split git patch rows directly', () => {
  const viewSource = readSource('src/CommitDiffView.jsx')
  const rawCssSource = readSource('src/CommitDiffRendered.css')
  const splitCssSource = readSource('src/CommitDiffSplit.css')
  const scrollbarsCssSource = readSource('src/CommitDiffScrollbars.css')

  assert.match(viewSource, /import \{ buildBinaryFileDiff, parsePatchRows, parseSplitPatchRows \} from '\.\/commitDiffUtils'/)
  assert.match(viewSource, /import \{[\s\S]*isCommitDiffSplitViewportNarrow[\s\S]*\} from '\.\/commitDiffViewUtils'/)
  assert.match(viewSource, /import \{ normalizeCommitDiffViewStyle, readCommitDiffViewStyle \} from '\.\/commitDiffSettings'/)
  assert.match(viewSource, /function RawPatchRenderer/)
  assert.match(viewSource, /function SplitPatchRenderer/)
  assert.match(viewSource, /viewMode === 'split'/)
  assert.match(viewSource, /getInitialViewStyle/)
  assert.match(viewSource, /isCommitDiffSplitViewportNarrow/)
  assert.match(viewSource, /commit-diff-raw__line--\$\{row\.type\}/)
  assert.doesNotMatch(viewSource, /commit-diff-split__row--\$\{row\.type\}/)
  assert.doesNotMatch(viewSource, /<DiffView/)
  assert.match(rawCssSource, /^\.commit-diff-raw\s*\{[^}]*overflow:\s*auto;/m)
  assert.match(cssBlock(rawCssSource, '.commit-diff-raw__line'), /grid-template-columns:\s*54px 54px minmax\(0, 1fr\);/)
  assert.doesNotMatch(cssBlock(rawCssSource, '.commit-diff-raw'), /scrollbar-width:\s*thin;/)
  assert.doesNotMatch(rawCssSource, /commit-diff-raw::-webkit-scrollbar/)
  assert.match(cssBlock(scrollbarsCssSource, '.commit-diff-raw::-webkit-scrollbar,\n.commit-diff-split::-webkit-scrollbar'), /width:\s*6px;/)
  assert.match(cssBlock(scrollbarsCssSource, '.commit-diff-raw::-webkit-scrollbar,\n.commit-diff-split::-webkit-scrollbar'), /height:\s*6px;/)
  assert.match(cssBlock(scrollbarsCssSource, '.commit-diff-raw::-webkit-scrollbar-track,\n.commit-diff-split::-webkit-scrollbar-track'), /background:\s*transparent;/)
  assert.match(cssBlock(scrollbarsCssSource, '.commit-diff-raw::-webkit-scrollbar-thumb,\n.commit-diff-split::-webkit-scrollbar-thumb'), /background:\s*var\(--text-tertiary\);/)
  assert.match(cssBlock(scrollbarsCssSource, '.commit-diff-raw::-webkit-scrollbar-thumb,\n.commit-diff-split::-webkit-scrollbar-thumb'), /border-radius:\s*3px;/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-split__row'), /grid-template-columns:\s*54px minmax\(320px, 1fr\) 54px minmax\(320px, 1fr\);/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-split'), /--commit-diff-split-min-width:\s*900px;/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-split__row'), /min-width:\s*var\(--commit-diff-split-min-width,\s*900px\);/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-split__line'), /min-width:\s*var\(--commit-diff-split-min-width,\s*900px\);/)
  assert.doesNotMatch(cssBlock(splitCssSource, '.commit-diff-split'), /scrollbar-width:\s*thin;/)
  assert.doesNotMatch(splitCssSource, /commit-diff-split::-webkit-scrollbar/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-split__row'), /border-bottom:\s*1px solid var\(--border-subtle\);/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-split__code--del,\n.commit-diff-split__num--del'), /background:\s*var\(--status-error-bg\);/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-split__code--add,\n.commit-diff-split__num--add'), /background:\s*var\(--status-success-bg\);/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-token--removed'), /background:/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-token--added'), /background:/)
})

test('React owns the split-width fallback without a competing CSS hide rule', () => {
  const commitViewSource = readSource('src/CommitDiffView.jsx')
  const workingChangesSource = readSource('src/WorkingChangesView.jsx')
  const splitCssSource = readSource('src/CommitDiffSplit.css')

  for (const source of [commitViewSource, workingChangesSource]) {
    assert.match(source, /isCommitDiffSplitViewportNarrow\(window\.innerWidth\)/)
    assert.doesNotMatch(source, /window\.innerWidth\s*<\s*COMMIT_DIFF_SPLIT_MIN_WIDTH/)
    assert.match(source, /const effectiveViewMode = isSplitViewportNarrow \? 'unified' : viewMode/)
  }
  assert.doesNotMatch(splitCssSource, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.commit-diff-split\s*\{[\s\S]*?display:\s*none;/)
})

test('commit diff uses icon close/copy buttons, view switcher, and stable file status badges', () => {
  const viewSource = readSource('src/CommitDiffView.jsx')
  const viewUtilsSource = readSource('src/commitDiffViewUtils.js')
  const finalCssSource = readSource('src/CommitDiffFinal.css')
  const splitCssSource = readSource('src/CommitDiffSplit.css')

  assert.match(viewSource, /CloseIcon as CanonicalCloseIcon/)
  assert.match(viewSource, /CopyIcon as CanonicalCopyIcon/)
  assert.match(viewSource, /ExpandIcon as CanonicalExpandIcon/)
  assert.match(viewSource, /CollapseIcon as CanonicalCollapseIcon/)
  assert.doesNotMatch(viewSource, /function (?:CloseIcon|CopyIcon|DiffExpandIcon|DiffCollapseIcon)\(/)
  assert.match(viewSource, /function ViewModeIcon/)
  assert.match(viewUtilsSource, /export function formatCommitDisplayDate/)
  assert.match(viewSource, /formatCommitDisplayDate\(commit\.date\)/)
  assert.match(viewSource, /commit-diff-header__icon-btn commit-diff-header__close/)
  assert.match(viewSource, /commit-diff-header__icon-btn commit-diff-header__copy/)
  assert.match(viewSource, /commit-diff-header__icon-btn commit-diff-header__focus/)
  assert.match(viewSource, /commit-diff-view-switcher/)
  assert.match(viewSource, /setViewMode\('split'\)/)
  assert.match(viewSource, /data-app-tooltip=\{`文件状态：\$\{getFileStatusText\(selectedFile\.status\)\}`\}/)
  assert.match(viewSource, /\{getFileStatusText\(selectedFile\.status\)\}/)
  assert.match(viewSource, /case 'deleted': return '已删除'/)
  assert.match(viewSource, /case 'modified': return '已编辑'/)
  assert.match(cssBlock(finalCssSource, '.commit-diff-file-header__status'), /height:\s*24px;/)
  assert.match(cssBlock(finalCssSource, '.commit-diff-file-header__status'), /border-radius:\s*999px;/)
  assert.match(cssBlock(finalCssSource, '.commit-diff-file-header__status'), /cursor:\s*default;/)
  assert.match(cssBlock(splitCssSource, '.commit-diff-view-switcher'), /height:\s*32px;/)
})

test('commit diff focus mode expands the diff area and keeps the file list behind a draggable handle', () => {
  const viewSource = readSource('src/CommitDiffView.jsx')
  const viewUtilsSource = readSource('src/commitDiffViewUtils.js')
  const headerCssSource = readSource('src/CommitDiffHeaderLayout.css')

  assert.match(viewUtilsSource, /export const COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH = 0/)
  assert.match(viewUtilsSource, /export const COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH = 320/)
  assert.match(viewUtilsSource, /export function clampFocusSidebarWidth/)
  assert.match(viewSource, /import \{[\s\S]*clampFocusSidebarWidth[\s\S]*\} from '\.\/commitDiffViewUtils'/)
  assert.match(viewSource, /const \[isDiffFocusMode, setIsDiffFocusMode\] = useState\(false\)/)
  assert.match(viewSource, /const \[focusSidebarWidth, setFocusSidebarWidth\] = useState\(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH\)/)
  assert.match(viewSource, /const \[isFocusSidebarDragging, setIsFocusSidebarDragging\] = useState\(false\)/)
  assert.match(viewSource, /focusSidebarDragRef = useRef\(null\)/)
  assert.match(viewSource, /setFocusSidebarWidth\(COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH\)/)
  assert.doesNotMatch(viewSource, /setIsFocusSidebarOpen/)
  assert.match(viewSource, /commit-diff-sheet--focus/)
  assert.match(viewSource, /commit-diff-body--focus-sidebar-visible/)
  assert.match(viewSource, /commit-diff-body--focus-sidebar-dragging/)
  assert.match(viewSource, /commit-diff-sidebar-handle/)
  assert.match(viewSource, /commit-diff-header-controls/)
  assert.match(viewSource, /style=\{focusSidebarStyle\}/)
  assert.match(viewSource, /'--commit-diff-focus-sidebar-width': `\$\{focusSidebarWidth\}px`/)
  assert.match(viewSource, /'--commit-diff-focus-sidebar-max-width': `\$\{COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH\}px`/)
  assert.doesNotMatch(viewSource, /commit-diff-focus-toolbar/)
  assert.match(viewSource, /\{!isDiffFocusMode \? \(\s*<div className="commit-diff-file-header commit-diff-file-header--designed">/)
  assert.match(viewSource, /aria-label=\{isDiffFocusMode \? '收起 Diff 视图' : '展开 Diff 视图'\}/)
  assert.match(viewSource, /role="separator"/)
  assert.match(viewSource, /aria-label="拖动调整文件列表宽度"/)
  assert.match(viewSource, /aria-valuemin=\{COMMIT_DIFF_FOCUS_SIDEBAR_MIN_WIDTH\}/)
  assert.match(viewSource, /aria-valuemax=\{COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH\}/)
  assert.match(viewSource, /aria-valuenow=\{focusSidebarWidth\}/)
  assert.match(viewSource, /onPointerDown=\{beginFocusSidebarDrag\}/)
  assert.match(viewSource, /onPointerMove=\{moveFocusSidebarDrag\}/)
  assert.match(viewSource, /onPointerUp=\{endFocusSidebarDrag\}/)
  assert.match(viewSource, /onPointerCancel=\{endFocusSidebarDrag\}/)
  assert.match(viewSource, /onKeyDown=\{handleFocusSidebarKeyDown\}/)
  assert.doesNotMatch(viewSource, /onClick=\{\(\) => setIsFocusSidebarOpen/)
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-header--designed'),
    /grid-template-columns:\s*minmax\(0,\s*1fr\) 124px;/,
    'the header action slot should fit the expand, copy, and close icon buttons'
  )
  assert.match(cssBlock(headerCssSource, '.commit-diff-header__actions'), /grid-column:\s*2;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-header__actions'), /grid-row:\s*1;/)
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-body--focus'),
    /grid-template-columns:\s*var\(--commit-diff-focus-sidebar-width\) minmax\(0,\s*1fr\);/,
    'focused mode should let the draggable sidebar width control the diff area'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-body--designed'),
    /transition:\s*grid-template-columns 240ms/,
    'focus and sidebar layout changes should animate instead of snapping'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-body--designed'),
    /position:\s*relative;/,
    'the sidebar handle should be able to overlay the collapsed edge without reserving a grid column'
  )
  assert.match(cssBlock(headerCssSource, '.commit-diff-body--designed'), /--commit-diff-focus-sidebar-width:\s*0px;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-body--designed'), /--commit-diff-focus-sidebar-max-width:\s*320px;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-body--focus-sidebar-dragging'), /transition:\s*none;/)
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-body--focus .commit-diff-sidebar'),
    /opacity:\s*0;/,
    'the file list should fade out by default in focused mode'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-body--focus .commit-diff-sidebar'),
    /transform:\s*translateX\(-14px\);/,
    'the file list should slide away by default in focused mode'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-body--focus .commit-diff-sidebar'),
    /pointer-events:\s*none;/,
    'the hidden file list should not remain interactive'
  )
  assert.match(cssBlock(headerCssSource, '.commit-diff-body--focus .commit-diff-sidebar'), /overflow:\s*hidden;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-body--focus-sidebar-visible .commit-diff-sidebar'), /opacity:\s*1;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle'), /position:\s*absolute;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle'), /left:\s*clamp\(10px,\s*calc\(var\(--commit-diff-focus-sidebar-width\) - 10px\),\s*calc\(var\(--commit-diff-focus-sidebar-max-width\) - 10px\)\);/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle'), /cursor:\s*ew-resize;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle'), /touch-action:\s*none;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle'), /user-select:\s*none;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle'), /height:\s*78px;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle'), /animation:\s*commitDiffHandleIn 180ms/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle--dragging'), /transition:\s*[\s\S]*background/)
  assert.doesNotMatch(cssBlock(headerCssSource, '.commit-diff-sidebar-handle--dragging'), /border-color/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-header-controls'), /margin-left:\s*auto;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-header-controls'), /justify-content:\s*flex-end;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-header-controls'), /animation:\s*commitDiffHeaderControlsIn 180ms/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sheet--focus .commit-diff-header__identity'), /grid-column:\s*1\s*\/\s*-1;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sheet--focus .commit-diff-header__identity'), /grid-row:\s*1;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sheet--focus .commit-diff-header__main'), /padding-right:\s*136px;/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sheet--focus .commit-diff-meta-item--branch'), /max-width:\s*min\(320px,\s*24vw\);/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sheet--focus .commit-diff-meta-item--branch'), /overflow:\s*hidden;/)
  assert.doesNotMatch(headerCssSource, /commit-diff-body--focus \.commit-diff-file-header--designed/)
})

test('commit diff header aligns metadata to the leading icon and stays compact', () => {
  const layerSource = readSource('src/CommitDiffLayer.jsx')
  const headerCssSource = readSource('src/CommitDiffHeaderLayout.css')
  const renderedCssSource = readSource('src/CommitDiffRendered.css')

  assert.match(layerSource, /import '\.\/CommitDiffHeaderLayout\.css'/)
  assert.doesNotMatch(renderedCssSource, /\.commit-diff-header__actions\s*\{/)
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-header--designed'),
    /min-height:\s*94px;/,
    'the commit header should not reserve a tall empty band'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-brand-mark'),
    /grid-row:\s*1;/,
    'the leading icon should not occupy the metadata row'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-header__meta.commit-diff-header__meta--designed'),
    /display:\s*flex;/,
    'metadata should stay in a continuous row instead of being spread across the header'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-header__meta.commit-diff-header__meta--designed'),
    /grid-column:\s*1\s*\/\s*-1;/,
    'metadata should start at the same left edge as the leading icon'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-header__meta.commit-diff-header__meta--designed'),
    /justify-content:\s*flex-start;/,
    'metadata should align from the left edge instead of being centered or spread out'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-header__meta.commit-diff-header__meta--designed'),
    /flex-wrap:\s*nowrap;/,
    'metadata should remain a single row on desktop'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-header__actions'),
    /justify-content:\s*flex-start;/,
    'header action buttons should align from the left edge of the action slot'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-meta-item--time'),
    /max-width:\s*none;/,
    'the time column should not inherit old narrow max-width caps'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-meta-item--branch'),
    /max-width:\s*min\(360px,\s*28vw\);/,
    'long branch names should truncate locally without pushing the rest of the row apart'
  )
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-header__icon-btn.github-repo-browser__close'),
    /width:\s*36px;/,
    'header icon buttons should stay visually quiet'
  )
  assert.match(cssBlock(headerCssSource, ".commit-diff-header__focus[aria-pressed='true']"), /background:\s*color-mix\(/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle'), /background:\s*var\(--bg-card\);/)
  assert.match(cssBlock(headerCssSource, '.commit-diff-sidebar-handle:hover,\n.commit-diff-sidebar-handle--visible'), /background:\s*color-mix\(/)
  assert.doesNotMatch(cssBlock(headerCssSource, '.commit-diff-sidebar-handle:hover,\n.commit-diff-sidebar-handle--visible'), /border-color:/)
  assert.match(
    cssBlock(headerCssSource, '.commit-diff-file-header--designed'),
    /min-height:\s*64px;/,
    'the selected-file header should not leave unused vertical space'
  )
})

test('commit diff view keeps selected-file loading scoped to selected state', () => {
  const viewSource = readSource('src/CommitDiffView.jsx')

  assert.match(viewSource, /const fileDiffStatesRef = useRef\(fileDiffStates\)/)
  assert.match(viewSource, /fileDiffStatesRef\.current = fileDiffStates/)
  assert.match(viewSource, /const mountedRef = useRef\(false\)/)
  assert.match(viewSource, /const diffScopeRef = useRef\(diffScope\)/)
  assert.match(viewSource, /mountedRef\.current && diffScopeRef\.current === requestScope/)
  assert.doesNotMatch(viewSource, /\}, \[data\?\.commit\?\.hash, data\?\.repoPath, fileDiffStates\]\)/)
  assert.match(viewSource, /buildBinaryFileDiff\(file, \{ commitHash: data\.commit\.hash, fullHash \}\)/)
})

test('commit diff shell is an app-level centered sheet above commit history', () => {
  const baseCssSource = readSource('src/CommitDiffView.css')
  const polishCssSource = readSource('src/CommitDiffPolish.css')

  assert.match(cssBlock(baseCssSource, '.commit-diff-stage'), /position:\s*fixed;/)
  assert.match(cssBlock(baseCssSource, '.commit-diff-stage'), /z-index:\s*180;/)
  assert.match(cssBlock(polishCssSource, '.commit-diff-stage'), /align-items:\s*center\s*!important;/)
})

test('commit diff rendered view has large, image, error, and text renderer states', () => {
  const viewSource = readSource('src/CommitDiffView.jsx')
  const imageSource = readSource('src/ImageDiffPreview.jsx')
  const imageCssSource = readSource('src/ImageDiffPreview.css')
  const swipeCssSource = readSource('src/ImageDiffSwipeFix.css')
  const cssSource = readSource('src/CommitDiffRendered.css')

  assert.match(viewSource, /function LargeDiffNotice/)
  assert.match(viewSource, /import ImageDiffPreview from '\.\/ImageDiffPreview\.jsx'/)
  assert.match(viewSource, /<ImageDiffPreview mode="commit" repoPath=\{repoPath\} commitHash=\{commitHash\} file=\{file\} \/>/)
  assert.match(viewSource, /function FileDiffErrorState/)
  assert.match(viewSource, /function RawPatchRenderer/)
  assert.match(viewSource, /function SplitPatchRenderer/)
  assert.match(imageSource, /get_repo_commit_image_diff_preview/)
  assert.match(imageSource, /get_repo_working_image_diff_preview/)
  assert.match(imageSource, /compareMode === 'swipe'/)
  assert.match(imageSource, /type="range"/)
  assert.match(imageCssSource, /image-diff__grid--two/)
  assert.match(imageCssSource, /background-image:/)
  assert.match(swipeCssSource, /clip-path:\s*inset/)
  assert.match(cssSource, /\.commit-diff-large-notice\s*\{[\s\S]*?grid-template-columns:/)
})

test('image diff backend registers guarded commit and worktree preview commands without new crates', () => {
  const libSource = readSource('src-tauri/src/lib.rs')
  const backendSource = readSource('src-tauri/src/image_diff.rs')
  const cargoSource = readSource('src-tauri/Cargo.toml')

  assert.match(libSource, /mod image_diff;/)
  assert.match(libSource, /image_diff::get_repo_commit_image_diff_preview/)
  assert.match(libSource, /image_diff::get_repo_working_image_diff_preview/)
  assert.match(backendSource, /IMAGE_SOURCE_MAX_BYTES/)
  assert.match(backendSource, /normalize_relative_path/)
  assert.match(backendSource, /canonical_file\.starts_with\(&canonical_repo\)/)
  assert.match(backendSource, /validate_svg/)
  assert.match(backendSource, /encode_base64/)
  assert.match(backendSource, /PNG、APNG、JPEG、GIF、WebP、AVIF、SVG/)
  assert.doesNotMatch(cargoSource, /^image\s*=|^resvg\s*=|^base64\s*=/m)
})
