import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

test('loads branch complete-view viewport rules through the existing style authority', () => {
  const polish = read('BranchManagementPolish.css')

  assert.match(polish, /^@import '\.\/BranchManagementViewportLayout\.css';/)
})

test('branch complete view consumes the canonical safe-area content box', () => {
  const main = read('main.jsx')
  const authority = read('SecondaryWindowViewport.css')

  assert.match(main, /import '\.\/SecondaryWindowViewport\.css'/)
  assert.match(authority, /body \.branch-management-stage \{[\s\S]*padding: var\(--secondary-window-safe-inset\);/)
  const sheetBlock = authority.match(/body \.branch-management-stage > \.branch-management-sheet \{([^}]*)\}/)?.[1]
  assert.ok(sheetBlock)
  assert.match(sheetBlock, /width:\s*min\(1840px,\s*100%\)/)
  assert.match(sheetBlock, /height:\s*min\(1120px,\s*100%\)/)
  assert.match(sheetBlock, /max-width:\s*100%/)
  assert.match(sheetBlock, /max-height:\s*100%/)
  assert.doesNotMatch(sheetBlock, /100vw|100vh/)
})

test('centered secondary windows share one parent-owned safe inset', () => {
  const authority = read('SecondaryWindowViewport.css')

  assert.match(authority, /--secondary-window-safe-inset: clamp\(12px, 2\.5vmin, 28px\);/)
  assert.match(authority, /\.modal-overlay \{[\s\S]*padding: var\(--secondary-window-safe-inset\);/)
  assert.match(authority, /\.stash-manager-backdrop \{[\s\S]*padding: var\(--secondary-window-safe-inset\);/)
  assert.match(authority, /\.branch-creation-backdrop \{[\s\S]*padding: var\(--secondary-window-safe-inset\);/)
  assert.match(authority, /\.stash-manager-confirm-backdrop \{[\s\S]*padding: var\(--secondary-window-safe-inset\);/)
  assert.match(authority, /body \.branch-management-confirm-backdrop \{[\s\S]*padding: var\(--secondary-window-safe-inset\);/)

  for (const selector of [
    '.modal-overlay > .device-auth-dialog',
    '.modal-overlay > .clone-dialog',
    '.stash-manager-backdrop > .stash-manager-dialog.create-stash-dialog',
    '.branch-creation-backdrop > .branch-creation-dialog',
    '.stash-manager-confirm-backdrop > .stash-manager-confirm',
    'body .branch-management-confirm-backdrop > .branch-management-confirm',
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const block = authority.match(new RegExp(`${escaped} \\{([^}]*)\\}`))?.[1]
    assert.ok(block, `missing viewport contract for ${selector}`)
    assert.match(block, /max-height:\s*100%/)
    assert.doesNotMatch(block, /100vh/)
  }

  assert.match(authority, /\.modal-overlay > \.clone-dialog \.clone-dialog__body,[\s\S]*\.modal-overlay > \.device-auth-dialog \.device-auth-dialog__body \{[\s\S]*overflow: auto;/)
})

test('compact Stash management menu uses viewport portal geometry and captured-scroll repositioning', () => {
  const popover = read('StashManagementPopover.jsx')
  const entry = read('WorkingChangesStashEntry.jsx')
  const authority = read('SecondaryWindowViewport.css')

  assert.match(entry, /const menuButtonRef = useRef\(null\)/)
  assert.match(entry, /ref=\{menuButtonRef\}/)
  assert.match(entry, /anchorRef=\{menuButtonRef\}/)
  assert.match(popover, /createPortal/)
  assert.match(popover, /computeFloatingMenuPosition/)
  assert.match(popover, /anchorRef\?\.current/)
  assert.match(popover, /document\.addEventListener\('scroll', schedulePosition, true\)/)
  assert.match(popover, /window\.addEventListener\('resize', schedulePosition\)/)
  assert.match(popover, /stash-management-popover--viewport/)
  assert.match(authority, /\.stash-management-popover\.stash-management-popover--viewport \{[\s\S]*position: fixed;/)
  assert.match(authority, /z-index: calc\(var\(--z-stash-entry-action-menu, 762\) - 1\);/)
})

test('wide branch tables give branch and upstream columns the extra space', () => {
  const css = read('BranchManagementViewportLayout.css')

  assert.match(css, /\.branch-management-stage \.branch-management-table__header,[\s\S]*minmax\(220px, 1\.45fr\)[\s\S]*minmax\(210px, 1\.25fr\)/)
  assert.match(css, /@media \(min-width: 1800px\)[\s\S]*minmax\(300px, 1\.6fr\)[\s\S]*minmax\(280px, 1\.4fr\)/)
  assert.match(css, /\.branch-management-stage \.branch-management-table__header--batch,[\s\S]*30px[\s\S]*176px !important;/)
})

test('secondary windows keep compact safe inset and reduced-motion safety', () => {
  const authority = read('SecondaryWindowViewport.css')
  const viewportCss = read('BranchManagementViewportLayout.css')

  assert.match(authority, /@media \(max-width: 760px\)[\s\S]*--secondary-window-safe-inset: 10px;/)
  assert.match(authority, /@media \(min-width: 1800px\)[\s\S]*body \.branch-management-stage > \.branch-management-sheet[\s\S]*width: 100%;[\s\S]*height: 100%;/)
  assert.match(viewportCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration: 1ms !important;/)
})
