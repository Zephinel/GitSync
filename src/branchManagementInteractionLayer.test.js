import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('mounts the repository-card operation presentation beside the integrated branch manager', () => {
  const source = readSource('src/main.jsx')
  assert.match(source, /const BranchManagementInteractionLayer = lazy/)
  assert.match(source, /<BranchManagementLayer \/>[\s\S]*<BranchManagementInteractionLayer \/>/)
  assert.doesNotMatch(source, /BranchManagementViewLayer|BranchManagementStatusArrowLayer|BranchManagementSyncActionLayer|BranchManagementSwitchActionLayer|BranchCreationLayer|installBranchManagementOverlayGuard/)
  assert.doesNotMatch(source, /BranchHoverSwitchIconAdapter/)
})

test('interaction layer projects operation loading through a focusable React portal', () => {
  const source = readSource('src/BranchManagementInteractionLayer.jsx')
  const css = readSource('src/BranchManagementInteractionLayer.css')

  assert.match(source, /useSyncExternalStore/)
  assert.match(source, /subscribeBranchOperations/)
  assert.match(source, /getActiveBranchOperationPaths/)
  assert.match(source, /collectBranchOperationOverlays/)
  assert.match(source, /createPortal/)
  assert.match(source, /function BranchOperationOverlay/)
  assert.match(source, /data-branch-operation-path/)
  assert.match(source, /tabIndex=\{0\}/)
  assert.match(css, /\.branch-management-operation-overlay \{/)
  assert.match(css, /pointer-events: auto;/)
  assert.match(css, /\.branch-management-operation-overlay:focus-visible/)
  assert.match(css, /body\.branch-management-overlay-active \.branch-management-operation-overlay/)
})

test('keeps operation loading below the branch metadata hover card', () => {
  const css = readSource('src/BranchManagementInteractionLayer.css')
  const appCss = readSource('src/App.css')
  const overlayRule = css.match(/\.branch-management-operation-overlay \{([\s\S]*?)\n\}/)?.[1] || ''

  assert.match(appCss, /--z-repo-meta-hover-card:\s*\d+;/)
  assert.match(
    overlayRule,
    /z-index:\s*calc\(var\(--z-repo-meta-hover-card\)\s*-\s*1\);/
  )
  assert.match(overlayRule, /justify-content:\s*center;/)
  assert.match(overlayRule, /padding:\s*8px 12px;/)
})

test('interaction layer never mutates App-owned attention elements', () => {
  const source = readSource('src/BranchManagementInteractionLayer.jsx')

  assert.doesNotMatch(source, /classList\.(?:add|remove|toggle)/)
  assert.doesNotMatch(source, /setAttribute|removeAttribute/)
  assert.doesNotMatch(source, /replaceChildren|appendChild|insertBefore|createElement/)
  assert.doesNotMatch(source, /\.disabled\s*=/)
  assert.doesNotMatch(source, /dataset\./)
})

test('active operation boundary blocks pointer and keyboard re-entry without changing native buttons', () => {
  const source = readSource('src/BranchManagementInteractionLayer.jsx')

  assert.match(source, /getLockedBranchAttentionPath/)
  assert.match(source, /event\.type === 'keydown' && event\.key !== 'Enter' && event\.key !== ' '/)
  assert.match(source, /document\.addEventListener\('click', blockActiveAttentionInteraction, true\)/)
  assert.match(source, /document\.addEventListener\('keydown', blockActiveAttentionInteraction, true\)/)
  assert.match(source, /document\.addEventListener\('focusin', blockActiveAttentionInteraction, true\)/)
  assert.match(source, /overlayNodesByPathRef\.current\.get\(repoPath\)\?\.focus/)
})

test('operation projection observes only while branch operations are active', () => {
  const source = readSource('src/BranchManagementInteractionLayer.jsx')

  assert.match(source, /const activePaths = getActiveBranchOperationPaths\(\)/)
  assert.match(source, /if \(activePaths\.size === 0\) \{[\s\S]*setOverlays\(\[\]\)[\s\S]*return undefined/)
  assert.match(source, /attributeFilter: \['class'\]/)
  assert.match(source, /ResizeObserver/)
  assert.match(source, /next\.forEach\(\(overlay\) => resizeObserverRef\.current\?\.observe\(overlay\.element\)\)/)
  assert.doesNotMatch(source, /setInterval|setTimeout/)
})
