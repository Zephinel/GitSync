import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

const readCssBlock = (source, marker) => {
  const markerIndex = source.indexOf(marker)
  assert.ok(markerIndex >= 0, `missing CSS block: ${marker}`)

  const openBraceIndex = source.indexOf('{', markerIndex)
  assert.ok(openBraceIndex >= 0, `missing opening brace for: ${marker}`)

  let depth = 0
  for (let index = openBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(markerIndex, index + 1)
  }

  assert.fail(`missing closing brace for: ${marker}`)
}

test('loads one shared viewport layout after the existing commit diff layers', () => {
  const layer = read('CommitDiffLayer.jsx')

  const headerLayout = layer.indexOf("import './CommitDiffHeaderLayout.css'")
  const viewportLayout = layer.indexOf("import './CommitDiffViewportLayout.css'")
  assert.ok(headerLayout >= 0 && viewportLayout > headerLayout)
})

test('uses the available desktop viewport instead of fixed 1400px and 84vh limits', () => {
  const css = read('CommitDiffViewportLayout.css')

  assert.match(css, /\.commit-diff-stage \{[\s\S]*--commit-diff-stage-inline-inset: clamp\(20px, 2\.5vw, 44px\);/)
  assert.match(css, /\.commit-diff-stage \{[\s\S]*--commit-diff-stage-block-inset: clamp\(20px, 3\.5vh, 40px\);/)
  assert.match(css, /\.commit-diff-sheet--designed \{[\s\S]*width: 100%;/)
  assert.match(css, /\.commit-diff-sheet--designed \{[\s\S]*height: 100%;/)
  assert.match(css, /max-width: 1840px;/)
  assert.match(css, /max-height: 1120px;/)
  assert.doesNotMatch(css, /width:\s*min\(1400px/)
  assert.doesNotMatch(css, /height:\s*min\(8[46]vh/)
})

test('gives the file list responsive width while preserving the diff remainder', () => {
  const css = read('CommitDiffViewportLayout.css')
  const mediumTrack = readCssBlock(css, '@media (max-width: 1334px)')
  const wideTrack = readCssBlock(css, '@media (min-width: 1917px)')

  assert.match(css, /\.commit-diff-body--designed:not\(\.commit-diff-body--focus\) \{[\s\S]*grid-template-columns: clamp\(328px, calc\(27vw \+ 8px\), 468px\) minmax\(0, 1fr\);/)
  assert.match(mediumTrack, /grid-template-columns: clamp\(288px, calc\(34vw \+ 8px\), 368px\) minmax\(0, 1fr\);/)
  assert.match(wideTrack, /grid-template-columns: clamp\(388px, calc\(24vw \+ 8px\), 528px\) minmax\(0, 1fr\);/)
})

test('file cells never move backward while the desktop viewport grows', () => {
  const css = read('CommitDiffViewportLayout.css')
  const wideSheet = readCssBlock(css, '@media (min-width: 1900px)')

  assert.doesNotMatch(css, /@media \(max-width: 1100px\)/)
  assert.doesNotMatch(wideSheet, /grid-template-columns/)

  const sidebarWidthAt = (viewportWidth) => {
    if (viewportWidth <= 1334) return Math.min(368, Math.max(288, (viewportWidth * 0.34) + 8))
    if (viewportWidth < 1917) return Math.min(468, Math.max(328, (viewportWidth * 0.27) + 8))
    return Math.min(528, Math.max(388, (viewportWidth * 0.24) + 8))
  }

  let previousWidth = sidebarWidthAt(900)
  for (let viewportWidth = 900.25; viewportWidth <= 2200; viewportWidth += 0.25) {
    const currentWidth = sidebarWidthAt(viewportWidth)
    assert.ok(
      currentWidth >= previousWidth,
      `file cell width moved backward at ${viewportWidth}px: ${previousWidth}px -> ${currentWidth}px`
    )
    previousWidth = currentWidth
  }

  assert.equal(sidebarWidthAt(900), 314)
  assert.equal(sidebarWidthAt(1100), 368)
  assert.equal(sidebarWidthAt(1101), 368)
  assert.equal(sidebarWidthAt(1900), 468)
})

test('horizontal window resizing cannot change the designed sheet height contract', () => {
  const css = read('CommitDiffViewportLayout.css')
  const polish = read('CommitDiffPolish.css')
  const rendered = read('CommitDiffRendered.css')
  const emergencyViewport = readCssBlock(css, '@media (max-width: 860px)')

  const ownsBlockGeometry = (source) => /(?:^|\n)\s*(?:height|max-height)\s*:/.test(source)
  const ownsSheetSize = /\.commit-diff-sheet--designed\s*\{[^}]*(?:\n\s*)(?:width|height|max-width|max-height)\s*:/

  assert.doesNotMatch(polish, /\.commit-diff-stage\s*\{[^}]*padding\s*:/)
  assert.doesNotMatch(polish, ownsSheetSize)
  assert.doesNotMatch(rendered, ownsSheetSize)
  assert.doesNotMatch(css, /@media \(max-width: 1100px\)/)
  assert.equal(
    ownsBlockGeometry(emergencyViewport),
    false,
    'the emergency width layout must not replace the sheet height or max-height authority'
  )

  const clamp = (minimum, preferred, maximum) => Math.min(maximum, Math.max(minimum, preferred))
  const sheetRectAt = (viewportWidth, viewportHeight) => {
    const inlineInset = clamp(20, viewportWidth * 0.025, 44)
    const blockInset = clamp(20, viewportHeight * 0.035, 40)
    return {
      width: viewportWidth - (inlineInset * 2),
      height: Math.min(1120, viewportHeight - (blockInset * 2)),
    }
  }

  for (const viewportHeight of [600, 800, 1200, 1600]) {
    const widths = [900, 960, 961, 1100, 1101, 1334, 1335, 1900, 1917, 2200]
    const expectedHeight = sheetRectAt(widths[0], viewportHeight).height
    let previousWidth = sheetRectAt(widths[0], viewportHeight).width

    widths.slice(1).forEach((viewportWidth) => {
      const rect = sheetRectAt(viewportWidth, viewportHeight)
      assert.equal(rect.height, expectedHeight, `sheet height changed during horizontal resize at ${viewportWidth}px`)
      assert.ok(rect.width >= previousWidth, `sheet width moved backward at ${viewportWidth}px`)
      previousWidth = rect.width
    })
  }
})

test('Working Changes glyph visibility follows the pane without changing its minimum width', () => {
  const viewportCss = read('CommitDiffViewportLayout.css')
  const renderedCss = read('CommitDiffRendered.css')
  const cellCss = read('WorkingChangesFileCell.css')
  const tauriConfig = JSON.parse(read('../src-tauri/tauri.conf.json'))

  assert.match(viewportCss, /grid-template-columns: clamp\(328px, calc\(27vw \+ 8px\), 468px\) minmax\(0, 1fr\);/)
  assert.match(viewportCss, /grid-template-columns: clamp\(288px, calc\(34vw \+ 8px\), 368px\) minmax\(0, 1fr\);/)
  assert.match(renderedCss, /\.commit-diff-body--designed \.commit-diff-sidebar \{[\s\S]*padding: 22px 24px;/)
  assert.doesNotMatch(viewportCss, /commit-diff-file-list-visible-sidebar-min/)
  assert.match(
    cellCss,
    /\.working-changes-body\s*>\s*\.commit-diff-sidebar\s*\{[\s\S]*container:\s*working-changes-sidebar\s*\/\s*inline-size;/
  )
  assert.match(cellCss, /@container working-changes-sidebar \(width < 17rem\)/)
  assert.doesNotMatch(cellCss, /@container working-changes-file-list \(max-width: 16rem\)/)

  const minWindowWidth = tauriConfig.app.windows[0].minWidth
  const sidebarInlinePadding = 24 * 2
  const glyphEmergencyPaneContentWidth = 17 * 16
  const sidebarWidthAt = (viewportWidth) => {
    if (viewportWidth <= 860) return viewportWidth - 12
    if (viewportWidth <= 1334) return Math.min(368, Math.max(288, (viewportWidth * 0.34) + 8))
    if (viewportWidth < 1917) return Math.min(468, Math.max(328, (viewportWidth * 0.27) + 8))
    return Math.min(528, Math.max(388, (viewportWidth * 0.24) + 8))
  }

  const sidebarContentWidthAt = (viewportWidth) => sidebarWidthAt(viewportWidth) - sidebarInlinePadding

  assert.ok(sidebarContentWidthAt(minWindowWidth) < glyphEmergencyPaneContentWidth, 'the glyph must remain hidden at the real minimum window width')

  let glyphHasBecomeVisible = false
  for (let viewportWidth = minWindowWidth; viewportWidth <= 2200; viewportWidth += 1) {
    const glyphIsVisible = sidebarContentWidthAt(viewportWidth) >= glyphEmergencyPaneContentWidth
    if (glyphIsVisible) glyphHasBecomeVisible = true
    if (glyphHasBecomeVisible) {
      assert.equal(glyphIsVisible, true, `glyph visibility regressed while widening at ${viewportWidth}px`)
    }
  }
})

test('focused commit and working-change sheets use nearly the full viewport', () => {
  const css = read('CommitDiffViewportLayout.css')
  const commitView = read('CommitDiffView.jsx')
  const workingView = read('WorkingChangesView.jsx')

  assert.match(commitView, /isDiffFocusMode \? 'commit-diff-sheet--focus' : ''/)
  assert.match(workingView, /isDiffFocusMode \? 'commit-diff-sheet--focus' : ''/)
  assert.match(css, /\.commit-diff-stage:has\(> \.commit-diff-sheet--focus\) \{[\s\S]*padding: 10px !important;/)
  assert.match(css, /\.commit-diff-sheet--designed\.commit-diff-sheet--focus \{[\s\S]*max-width: none;[\s\S]*max-height: none;/)
  assert.match(css, /max-width: none;/)
  assert.match(css, /max-height: none;/)
})

test('keeps compact and reduced-motion fallbacks', () => {
  const css = read('CommitDiffViewportLayout.css')
  const compact = readCssBlock(css, '@media (max-width: 860px)')

  assert.doesNotMatch(compact, /(?:^|\n)\s*(?:width|height|max-width|max-height|padding)\s*:/)
  assert.match(compact, /grid-template-columns: minmax\(0, 1fr\);/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration: 1ms !important;/)
})
