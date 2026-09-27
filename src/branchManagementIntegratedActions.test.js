import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `missing end marker: ${endNeedle}`)
  return source.slice(start, end)
}

test('complete-view create and switch actions belong to BranchManagementLayer', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const actionCss = read('./BranchManagementActions.css')
  const main = read('./main.jsx')

  assert.match(layer, /import BranchCreationDialog from '\.\/BranchCreationDialog\.jsx'/)
  assert.match(layer, /import BranchSwitchIcon from '\.\/BranchSwitchIcon\.jsx'/)
  assert.match(layer, /BranchIcon,[\s\S]*from '\.\/icons\/CanonicalIcons\.jsx'/)
  assert.match(layer, /className="branch-management-create-header branch-management-btn"/)
  assert.match(layer, /className="branch-management-create-row"/)
  assert.match(layer, /className=\{`branch-management-switch-row/)
  assert.equal((layer.match(/<BranchIcon className="icon icon--sm" \/>/g) || []).length, 2)
  assert.match(layer, /<BranchSwitchIcon className="icon icon--sm" \/>/)
  assert.match(layer, /invoke\('switch_repo_branch'/)
  assert.match(layer, /onCreate=\{handleCreate\}/)
  assert.match(layer, /onSwitch=\{handleSwitch\}/)
  assert.match(actionCss, /\.branch-management-create-header > svg/)
  assert.doesNotMatch(actionCss, /branch-management-create-header::before|data:image\/svg\+xml/)
  assert.doesNotMatch(actionCss, /272px !important/)
  assert.doesNotMatch(main, /BranchCreationLayer|BranchManagementSwitchActionLayer/)
})

test('complete-view switch action consumes the canonical BranchSwitch IconDefinition', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const icon = read('./BranchSwitchIcon.jsx')
  const css = read('./BranchSwitchActionIcon.css')
  const main = read('./main.jsx')
  const directIconRule = sourceBetween(
    css,
    '.branch-switch-icon {',
    '\n\n.branch-management-stage .branch-management-switch-row {'
  )

  assert.match(layer, /<BranchSwitchIcon className="icon icon--sm" \/>/)
  assert.match(icon, /import AppIcon from '\.\/icons\/AppIcon\.jsx'/)
  assert.match(icon, /import \{ BRANCH_SWITCH_ICON \} from '\.\/icons\/iconDefinitions\.js'/)
  assert.match(icon, /<AppIcon icon=\{BRANCH_SWITCH_ICON\} className=\{classes\} \/>/)
  assert.doesNotMatch(icon, /branch-switch-icon\.svg|BRANCH_SWITCH_ICON_URL|--branch-switch-icon-url|<path\b|<svg\b/)
  assert.doesNotMatch(directIconRule, /mask:|background:/)
  assert.doesNotMatch(main, /BranchHoverSwitchIconAdapter/)
})

test('hover switch presentation is CSS-owned, React-owned, truly centered, and keeps copy before switch before delete', () => {
  const detail = read('./BranchAttentionDetailLayer.jsx')
  const css = read('./BranchSwitchActionIcon.css')
  const app = read('./App.jsx')
  const main = read('./main.jsx')

  assert.match(css, /\.repo-card__branch-row-actions > \.repo-card__branch-row-state \+ \.repo-card__branch-row-action \{/)
  assert.match(css, /\.repo-card__branch-row-state \+ \.repo-card__branch-row-action > \.repo-card__branch-row-action-icon \{/)
  assert.match(css, /\.repo-card__branch-row-state \+ \.repo-card__branch-row-action \{[\s\S]*display:\s*inline-flex !important;/)
  assert.match(css, /\.repo-card__branch-row-state \+ \.repo-card__branch-row-action \{[\s\S]*align-items:\s*center !important;/)
  assert.match(css, /\.repo-card__branch-row-state \+ \.repo-card__branch-row-action \{[\s\S]*justify-content:\s*center !important;/)
  assert.match(css, /font-size: 0;/)
  assert.match(css, /\.repo-card__branch-row-actions > \.repo-card__branch-row-action ~ \.repo-card__branch-row-action/)
  assert.match(css, /display: none !important;/)
  assert.match(css, /\.repo-card__branch-row-actions > \.repo-card__branch-row-copy:not\(\.repo-card__branch-row-delete\) \{[\s\S]*order: 80 !important;/)
  assert.match(css, /\.repo-card__branch-row-actions > \.repo-card__branch-row-state \+ \.repo-card__branch-row-action \{[\s\S]*order: 90 !important;/)
  assert.match(css, /\.repo-card__branch-row-actions > \.repo-card__branch-row-delete \{[\s\S]*order: 100 !important;/)
  assert.match(app, /import BranchSwitchIcon from '\.\/BranchSwitchIcon\.jsx'/)
  assert.equal((app.match(/<BranchSwitchIcon className="repo-card__branch-row-action-icon" \/>/g) || []).length, 2)
  assert.doesNotMatch(main, /BranchHoverSwitchIconAdapter/)
  assert.doesNotMatch(css, /data:image\/svg|branch-switch-icon\.svg|(?:-webkit-)?mask\s*:/)
  assert.match(detail, /command: 'rebind_repo_branch_upstream'/)
  assert.match(detail, /command: 'unset_repo_branch_upstream'/)
})

test('hover and remote-only switch actions render the canonical icon in their React owners', () => {
  const app = read('./App.jsx')
  const detail = read('./BranchAttentionDetailLayer.jsx')
  const css = read('./BranchSwitchActionIcon.css')

  assert.match(app, /<BranchSwitchIcon className="repo-card__branch-row-action-icon" \/>/)
  assert.match(detail, /import BranchSwitchIcon from '\.\/BranchSwitchIcon\.jsx'/)
  assert.match(detail, /const branchSwitchAction = action\?\.command === 'switch_repo_branch'/)
  assert.match(detail, /branchSwitchAction && !rowBusy/)
  assert.match(detail, /<BranchSwitchIcon className="branch-attention-detail__primary-action-icon" \/>/)
  assert.doesNotMatch(css, /::before|branch-switch-icon\.svg|(?:-webkit-)?mask\s*:/)
})

test('complete-view row actions use blue for normal actions and red for delete', () => {
  const css = read('./BranchSwitchActionIcon.css')

  assert.match(css, /\.branch-management-row__actions > button:not\(\.branch-management-row__delete\):not\(:disabled\)/)
  assert.match(css, /color: var\(--accent-blue\) !important;/)
  assert.match(css, /\.branch-management-row__actions > \.branch-management-row__delete:not\(:disabled\)/)
  assert.match(css, /color: var\(--status-error\) !important;/)
})

test('branch batch transition is React-owned and clears stale selection', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const transition = sourceBetween(
    layer,
    '  const setBatch = (next) => {',
    '\n\n  const toggleSelected'
  )

  assert.match(layer, /const \[batchMode, setBatchMode\] = useState\(false\)/)
  assert.match(layer, /const \[selectedIdentities, setSelectedIdentities\] = useState\(\(\) => new Set\(\)\)/)
  assert.match(transition, /if \(operationActive\) return/)
  assert.match(transition, /setBatchMode\(next\)/)
  assert.match(transition, /setSelectedIdentities\(new Set\(\)\)/)
  assert.match(transition, /if \(next\) setViewMode\(BRANCH_MANAGEMENT_VIEW_MODE\.refs\)/)
})

test('batch selection icon is React-owned and centered without CSS geometry compensation', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const css = read('./BranchManagementPolish.css')
  const batchRule = sourceBetween(
    css,
    '.branch-management-batch-toggle {',
    '\n\n.branch-management-batch-toggle >'
  )
  const iconRule = sourceBetween(
    css,
    '.branch-management-batch-toggle >',
    '\n\n.branch-management-batch-toggle:hover'
  )

  assert.match(layer, /BatchSelectIcon as CanonicalBatchSelectIcon/)
  assert.match(layer, /<CanonicalBatchSelectIcon className="branch-management-batch-toggle__icon" \/>/)
  assert.match(batchRule, /display: inline-flex;/)
  assert.match(batchRule, /align-items: center;/)
  assert.match(batchRule, /justify-content: center;/)
  assert.match(iconRule, /width: 15px;[\s\S]*height: 15px;[\s\S]*flex: 0 0 15px;/)
  assert.doesNotMatch(`${batchRule}\n${iconRule}`, /data:image\/svg|(?:-webkit-)?mask\s*:|translateY|position:\s*absolute/)
})

test('complete-view actions consume structured rows rather than translated DOM labels', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const model = read('./branchManagementActionModel.js')
  assert.match(layer, /getBranchCreationSource\(row\)/)
  assert.match(layer, /getBranchSwitchAction\(row, rows, repoStatus/)
  assert.match(model, /row\.localName \|\| row\.rowName/)
  assert.match(model, /row\.remoteRef \|\| row\.upstream \|\| row\.rowName/)
  assert.doesNotMatch(model, /textContent|querySelector|includes\('本地'\)|includes\('远端'\)/)
})

test('complete view opens through the native hover event without synthetic reveal or dismissal', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const gateway = read('./BranchManagementHoverGateway.jsx')
  const action = read('./BranchManagementHoverAction.jsx')
  const bridge = read('./branchManagementAppBridge.js')

  assert.match(layer, /<BranchManagementHoverGateway disabled=\{expanded\} onOpen=\{openExpanded\} \/>/)
  assert.match(gateway, /subscribeBranchManagementOpen/)
  assert.match(action, /dispatchBranchManagementOpen/)
  assert.match(bridge, /BRANCH_MANAGEMENT_OPEN_EVENT/)
  assert.doesNotMatch(gateway, /createPortal|MutationObserver|ResizeObserver|MouseEvent|FocusEvent/)
  assert.doesNotMatch(layer, /reopenOriginalHover|dismissUnderlyingBranchHover/)
  assert.doesNotMatch(layer, /new MouseEvent\('mouseover'/)
  assert.doesNotMatch(layer, /new FocusEvent\('focusin'/)
})

test('one component owns view mode, selection and all branch mutations', () => {
  const layer = read('./BranchManagementLayer.jsx')
  assert.match(layer, /useState\(BRANCH_MANAGEMENT_VIEW_MODE\.branches\)/)
  assert.match(layer, /getBranchManagementVisibleRows\(rows, viewMode\)/)
  assert.match(layer, /const \[activeOperation, setActiveOperation\] = useState\(null\)/)
  assert.match(layer, /const runOperation = useCallback/)
  assert.match(layer, /kind: 'sync'/)
  assert.match(layer, /kind: 'delete'/)
  assert.match(layer, /kind: action\.kind/)
})
