import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('the real branch management component owns complete-view actions and dialogs', () => {
  const source = read('./BranchManagementLayer.jsx')
  assert.match(source, /function ExpandedBranchManager\(/)
  assert.match(source, /className="branch-management-create-header branch-management-btn"/)
  assert.match(source, /className="branch-management-create-row"/)
  assert.match(source, /branch-management-switch-row/)
  assert.match(source, /<BranchCreationDialog/)
  assert.match(source, /<DeleteConfirmDialog/)
})

test('complete view owns branch\/ref mode and batch selection without DOM decorators', () => {
  const source = read('./BranchManagementLayer.jsx')
  assert.match(source, /useState\(BRANCH_MANAGEMENT_VIEW_MODE\.branches\)/)
  assert.match(source, /getBranchManagementVisibleRows\(rows, viewMode\)/)
  assert.match(source, /getBranchManagementViewSummary\(rows, viewMode\)/)
  assert.match(source, /handleBatchRowActivation/)
  assert.doesNotMatch(source, /branch-management-logical-row--hidden/)
})

test('all complete-view mutations share one active operation authority', () => {
  const source = read('./BranchManagementLayer.jsx')
  assert.match(source, /const \[activeOperation, setActiveOperation\] = useState\(null\)/)
  assert.match(source, /const runOperation = useCallback/)
  assert.match(source, /operationRef\.current/)
  assert.match(source, /kind: action\.kind/)
  assert.match(source, /kind: 'sync'/)
  assert.match(source, /kind: 'delete'/)
})

test('hover entry is an isolated React gateway and complete view receives primitive context', () => {
  const source = read('./BranchManagementLayer.jsx')

  assert.match(source, /import BranchManagementHoverGateway from '\.\/BranchManagementHoverGateway\.jsx'/)
  assert.match(source, /<BranchManagementHoverGateway disabled=\{expanded\} onOpen=\{openExpanded\} \/>/)
  assert.match(source, /normalizeBranchManagementOpenContext\(inputContext\)/)
  assert.match(source, /setActiveContext\(context\)/)
  assert.doesNotMatch(source, /sourceRect|sourceMarkup|captureHoverMarkup|dangerouslySetInnerHTML/)
})

test('branch manager never mutates or intercepts the App-owned hover card', () => {
  const source = read('./BranchManagementLayer.jsx')

  assert.doesNotMatch(source, /createNativeExpandButton|document\.createElement|appendChild|insertBefore|innerHTML/)
  assert.doesNotMatch(source, /repo-card__branch-row-delete|branch-management-inline-sync|branch-management-hover-default-tag/)
  assert.doesNotMatch(source, /addEventListener\('click',[\s\S]*true\)/)
  assert.doesNotMatch(source, /querySelectorAll\('\.repo-card__branch-row'/)
})

test('complete branch data is read only while the complete view is active', () => {
  const source = read('./BranchManagementLayer.jsx')

  assert.match(source, /if \(!expanded \|\| !activeContext\?\.repoPath\) return/)
  assert.match(source, /void loadBranchData\(activeContext\.repoPath\)/)
  assert.doesNotMatch(source, /visibleContext = expanded \? activeContext : hoverContext/)
  assert.doesNotMatch(source, /hoverContext\?\.repoPath[\s\S]*loadBranchData/)
})

test('settings discovery uses a narrow child-list observer instead of page-wide attribute scanning', () => {
  const source = read('./BranchManagementLayer.jsx')

  assert.match(source, /observer\.observe\(document\.body, \{ childList: true, subtree: true \}\)/)
  assert.match(source, /textContent\?\.trim\(\) === '同步设置'/)
  assert.match(source, /className="settings__row branch-management-settings-row"/)
  assert.doesNotMatch(source, /className="settings__section branch-management-settings-section"/)
  assert.doesNotMatch(source, /attributeFilter: \['class', 'style', 'disabled'\]/)
})

test('branch management notices render above the complete-view overlay stack', () => {
  const css = read('./BranchManagementLayer.css')

  assert.match(css, /\.branch-management-notice\s*\{[\s\S]*?z-index:\s*calc\(var\(--z-overlay-nested\) \+ 20\);/)
})
