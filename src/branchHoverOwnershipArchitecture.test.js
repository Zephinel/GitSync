import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

const DOM_MUTATION_PATTERN = /document\.createElement|createElementNS|appendChild|insertBefore|replaceChildren|\.innerHTML\s*=|\.disabled\s*=|dataset\.[A-Za-z_$][\w$]*\s*=/

test('App render remains the sole owner of the native branch hover tree and expand action', () => {
  const app = read('./App.jsx')

  assert.match(app, /<RepoMetaHoverCard[\s\S]*ariaLabel="仓库分支总览"/)
  assert.match(app, /visibleBranchOverviewList\.map/)
  assert.match(app, /className="repo-card__branch-row-copy"/)
  assert.match(app, /repo-card__branch-row-delete/)
  assert.match(app, /ariaLabel="仓库分支总览"[\s\S]*<BranchManagementHoverAction[\s\S]*branchOverviewLoading/)
  assert.equal((app.match(/<BranchManagementHoverAction/g) || []).length, 1)
  assert.equal(existsSync(new URL('./viteAppBranchSnapshotBridgePlugin.js', import.meta.url)), false)
})

test('branch manager owns only event subscription and complete-view React surfaces', () => {
  const layer = read('./BranchManagementLayer.jsx')
  const gateway = read('./BranchManagementHoverGateway.jsx')

  assert.match(layer, /<BranchManagementHoverGateway disabled=\{expanded\} onOpen=\{openExpanded\} \/>/)
  assert.match(layer, /normalizeBranchManagementOpenContext\(inputContext\)/)
  assert.match(layer, /createPortal/)
  assert.match(gateway, /subscribeBranchManagementOpen/)
  assert.match(gateway, /return null/)
  assert.doesNotMatch(layer, DOM_MUTATION_PATTERN)
  assert.doesNotMatch(layer, /hoverCard|sourceRect|sourceMarkup|dangerouslySetInnerHTML/)
  assert.doesNotMatch(layer, /repo-card__branch-row/)
  assert.doesNotMatch(gateway, /createPortal|MutationObserver|ResizeObserver|querySelector|getBoundingClientRect/)
})

test('native action and event gateway never discover or mutate App hover nodes', () => {
  const action = read('./BranchManagementHoverAction.jsx')
  const gateway = read('./BranchManagementHoverGateway.jsx')
  const bridge = read('./branchManagementAppBridge.js')
  const compatibility = read('./branchManagementHoverGateway.js')
  const interaction = read('./BranchManagementInteractionLayer.jsx')

  assert.match(action, /dispatchBranchManagementOpen/)
  assert.match(gateway, /subscribeBranchManagementOpen/)
  assert.match(compatibility, /normalizeBranchManagementOpenDetail as normalizeBranchManagementOpenContext/)
  assert.doesNotMatch(action, DOM_MUTATION_PATTERN)
  assert.doesNotMatch(gateway, DOM_MUTATION_PATTERN)
  assert.doesNotMatch(bridge, DOM_MUTATION_PATTERN)
  assert.doesNotMatch(compatibility, DOM_MUTATION_PATTERN)
  assert.doesNotMatch(action, /createPortal|MutationObserver|querySelector|getBoundingClientRect/)
  assert.doesNotMatch(gateway, /createPortal|MutationObserver|querySelector|getBoundingClientRect/)
  assert.doesNotMatch(compatibility, /document|window|MutationObserver|querySelector|getBoundingClientRect/)
  assert.match(interaction, /createPortal/)
  assert.doesNotMatch(interaction, DOM_MUTATION_PATTERN)
  assert.doesNotMatch(interaction, /classList\.(?:add|remove|toggle)|setAttribute|removeAttribute/)
})

test('branch attention detail is a read-only entry gateway to the shared overlay portal', () => {
  const detail = read('./BranchAttentionDetailLayer.jsx')

  assert.match(detail, /document\.addEventListener\('click', handleActionClick, true\)/)
  assert.match(detail, /import OverlayPortal from '\.\/OverlayPortal\.jsx'/)
  assert.match(detail, /overlayId=\{OVERLAY_ID\.branchAttention\}/)
  assert.doesNotMatch(detail, DOM_MUTATION_PATTERN)
  assert.doesNotMatch(detail, /classList\.(?:add|remove|toggle)\([^)]*repo-card__branch/)
})

test('obsolete hover DOM adapters and external portal styles stay deleted', () => {
  const main = read('./main.jsx')

  assert.equal(existsSync(new URL('./BranchHoverSwitchIconAdapter.jsx', import.meta.url)), false)
  assert.equal(existsSync(new URL('./BranchManagementHoverGateway.css', import.meta.url)), false)
  assert.doesNotMatch(main, /BranchHoverSwitchIconAdapter/)
  assert.doesNotMatch(main, /BranchManagementSwitchActionLayer|BranchManagementSyncActionLayer|BranchManagementViewLayer/)
})

test('branch switch component and hover owners use canonical geometry without CSS masks', () => {
  const icon = read('./BranchSwitchIcon.jsx')
  const css = read('./BranchSwitchActionIcon.css')
  const app = read('./App.jsx')

  assert.match(icon, /import AppIcon from '\.\/icons\/AppIcon\.jsx'/)
  assert.match(icon, /import \{ BRANCH_SWITCH_ICON \} from '\.\/icons\/iconDefinitions\.js'/)
  assert.match(icon, /<AppIcon icon=\{BRANCH_SWITCH_ICON\}/)
  assert.doesNotMatch(icon, /assets\/branch-switch-icon\.svg|<svg\b|<path\b/)
  assert.match(app, /import BranchSwitchIcon from '\.\/BranchSwitchIcon\.jsx'/)
  assert.equal((app.match(/<BranchSwitchIcon className="repo-card__branch-row-action-icon" \/>/g) || []).length, 2)
  assert.doesNotMatch(css, /::before|branch-switch-icon\.svg|(?:-webkit-)?mask\s*:/)
  assert.match(css, /order: 80 !important;/)
  assert.match(css, /order: 90 !important;/)
  assert.match(css, /order: 100 !important;/)
  assert.doesNotMatch(icon, DOM_MUTATION_PATTERN)
})
