import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length
  assert.ok(end > start, `missing end marker after: ${startMarker}`)
  return source.slice(start, end)
}

const authority = read('./AdaptiveRowContainerAuthority.css')
const cell = read('./WorkingChangesFileCell.jsx')
const cellCss = read('./WorkingChangesFileCell.css')
const main = read('./main.jsx')
const workingChanges = read('./WorkingChangesView.jsx')
const groups = read('./WorkingChangesFileGroups.jsx')
const sharedFileCards = read('./CommitDiffFileListShared.css')
const stagingCss = read('./WorkingChangesStaging.css')
const imagePreviewCss = read('./WorkingChangesImagePreviewLayer.css')

test('loads one adaptive row authority after the existing root surface authorities', () => {
  const marker = "import './AdaptiveRowContainerAuthority.css'"
  assert.equal((main.match(/import '\.\/AdaptiveRowContainerAuthority\.css'/g) || []).length, 1)
  assert.ok(main.includes(marker))
  assert.ok(
    main.indexOf(marker) > main.indexOf("import './FormControlSurface.css'"),
    'adaptive row authority must remain the final root stylesheet import'
  )
  assert.doesNotMatch(main, /ResponsiveDenseRowAuthority/)
})

test('dense rows react to local inline-size containers instead of viewport width', () => {
  assert.match(authority, /\.commit-diff-file-card\s*\{[\s\S]*container:\s*adaptive-file-card\s*\/\s*inline-size;/)
  assert.match(cellCss, /\.working-changes-file-list\s*\{[\s\S]*container:\s*working-changes-file-list\s*\/\s*inline-size;/)
  assert.match(cellCss, /\.working-changes-body\s*>\s*\.commit-diff-sidebar\s*\{[\s\S]*container:\s*working-changes-sidebar\s*\/\s*inline-size;/)
  assert.match(cellCss, /\.working-changes-file-cell\s*\{[\s\S]*container:\s*working-changes-file-cell\s*\/\s*inline-size;/)
  assert.doesNotMatch(authority, /@media\s*\(max-width:/)
  assert.doesNotMatch(cellCss, /@media\s*\(max-width:/)
})

test('shared Commit Diff cards use a dense two-band compact layout', () => {
  const shared = sliceBetween(
    authority,
    '@container adaptive-file-card (max-width: 20rem)',
    null
  )
  assert.match(shared, /\.commit-diff-file-card__content\s*\{[\s\S]*grid-template-rows:\s*auto auto;/)
  assert.match(shared, /> \.commit-diff-file-item__main\s*\{[\s\S]*grid-column:\s*2;[\s\S]*grid-row:\s*1;/)
  assert.match(shared, /> \.commit-diff-file-item__side\s*\{[\s\S]*grid-column:\s*2;[\s\S]*grid-row:\s*2;/)
  assert.doesNotMatch(shared, /grid-template-rows:\s*auto auto auto/)
})

test('Working Changes keeps a dense two-band cell at normal narrow pane widths', () => {
  assert.match(groups, /data-working-changes-group=\{group\.id\}/)
  assert.match(workingChanges, /stagingState=\{file\.staging_state\}/)

  const cardCompact = sliceBetween(
    cellCss,
    '@container working-changes-file-cell (max-width: 25rem)',
    '@container working-changes-file-list (max-width: 22rem)'
  )
  assert.match(cardCompact, /\.working-changes-file-cell__preview\s*\{[\s\S]*grid-template-rows:\s*minmax\(23px, auto\) auto;/)
  assert.match(cardCompact, /\.working-changes-file-cell \.commit-diff-file-glyph\s*\{[\s\S]*display:\s*none;/)
  assert.match(cardCompact, /\.working-changes-file-cell__identity\s*\{[\s\S]*grid-column:\s*1;[\s\S]*grid-row:\s*1;/)
  assert.doesNotMatch(cardCompact, /\.working-changes-file-cell__identity\s*\{[\s\S]*flex-direction:\s*row;/)
  assert.match(cellCss, /\.working-changes-file-cell__filename,[\s\S]*\.working-changes-file-cell__path\s*\{[\s\S]*text-overflow:\s*ellipsis;/)
  assert.match(cardCompact, /\.working-changes-file-cell__status\s*\{[\s\S]*grid-column:\s*2;[\s\S]*grid-row:\s*1 \/ span 2;[\s\S]*align-self:\s*center;/)
  assert.match(cardCompact, /\.working-changes-file-cell__details\s*\{[\s\S]*grid-column:\s*1 \/ 3;[\s\S]*grid-row:\s*2;/)
  assert.match(cardCompact, /\.working-changes-file-cell__actions\s*\{[\s\S]*align-self:\s*start;/)
  assert.doesNotMatch(cardCompact, /grid-template-rows:\s*auto auto auto/)

  const tinyListCompact = sliceBetween(
    cellCss,
    '@container working-changes-sidebar (width < 17rem)',
    '@media (prefers-reduced-motion: reduce)'
  )
  assert.match(tinyListCompact, /\.working-changes-file-cell\s*\{[\s\S]*column-gap:\s*6px;[\s\S]*padding-inline:\s*10px;/)
  assert.doesNotMatch(tinyListCompact, /working-changes-file-cell__(?:preview|identity|status|details)/)
})

test('Working Changes owns its file-cell anatomy instead of adapting CommitDiffFileCard slots', () => {
  assert.match(workingChanges, /import WorkingChangesFileCell from '\.\/WorkingChangesFileCell\.jsx'/)
  assert.match(workingChanges, /<WorkingChangesFileCell/)
  assert.doesNotMatch(workingChanges, /import CommitDiffFileCard from/)
  assert.doesNotMatch(workingChanges, /<CommitDiffFileCard/)
  assert.doesNotMatch(authority, /working-changes-file-preview|working-changes-file-stage-actions/)
  assert.doesNotMatch(sharedFileCards, /working-changes-file-row|working-changes-file-stage-actions|working-changes-batch-slot/)
  assert.doesNotMatch(stagingCss, /working-changes-file-row__metadata|working-changes-file-stage-actions/)
  assert.doesNotMatch(imagePreviewCss, /\.working-changes-sheet \.working-changes-file-row\s*\{/)
  assert.match(cell, /working-changes-file-cell__selection[\s\S]*working-changes-file-cell__preview[\s\S]*working-changes-file-cell__identity[\s\S]*working-changes-file-cell__status[\s\S]*working-changes-file-cell__details[\s\S]*working-changes-file-cell__actions/)
  assert.match(cell, /data-file-path=\{filePath\}/)
  assert.doesNotMatch(cell, /working-changes-file-preview|working-changes-batch-slot|commit-diff-file-item__main|commit-diff-file-item__side/)
})

test('Working Changes presents basename first and the repository-relative path second', () => {
  const identity = sliceBetween(
    cell,
    '<span className="working-changes-file-cell__identity">',
    '<span className="working-changes-file-cell__status">'
  )

  assert.ok(
    identity.indexOf('working-changes-file-cell__filename') < identity.indexOf('working-changes-file-cell__path'),
    'basename must precede the repository-relative path'
  )
  assert.match(identity, /working-changes-file-cell__filename[\s\S]*\{filename\}/)
  assert.match(identity, /working-changes-file-cell__path[\s\S]*\{filePath\}/)
  assert.doesNotMatch(identity, /working-changes-file-cell__directory/)
})

test('Working Changes gives operation selection a full-row rail hit target', () => {
  assert.match(cellCss, /--working-changes-selection-rail-width:\s*40px;/)
  assert.match(cellCss, /\.working-changes-file-cell--has-actions\s*\{[\s\S]*grid-template-columns:\s*var\(--working-changes-selection-rail-width\) minmax\(0, 1fr\) max-content;/)
  assert.match(cellCss, /\.working-changes-file-cell__selection\s*\{[\s\S]*align-self:\s*stretch;/)
  assert.match(cellCss, /\.working-changes-file-cell__selection \.working-changes-checkbox\s*\{[\s\S]*width:\s*100%;[\s\S]*min-height:\s*44px;[\s\S]*place-items:\s*center;/)
  assert.match(cellCss, /\.working-changes-file-cell__selection \.working-changes-checkbox:hover,[\s\S]*\{[\s\S]*background:/)
  assert.match(cellCss, /\.working-changes-file-cell__selection \.working-changes-checkbox:has\(input:focus-visible\)\s*\{[\s\S]*outline:/)
})

test('no production stylesheet competes for Working Changes file-cell layout', () => {
  const layoutProperty = /(?:^|;)\s*(?:display|position|inset|grid(?:-template)?(?:-columns|-rows)?|grid-column|grid-row|flex(?:-direction|-wrap)?|order|align-(?:self|items)|justify-(?:self|content)|place-items|width|min-width|max-width|height|min-height|max-height|margin|padding|gap|row-gap|column-gap|overflow)\s*:/m
  const cssFiles = readdirSync(new URL('.', import.meta.url), { recursive: true })
    .filter((path) => path.endsWith('.css') && path !== 'WorkingChangesFileCell.css')

  for (const path of cssFiles) {
    const source = read(`./${path}`)
    for (const match of source.matchAll(/([^{}]*\.working-changes-file-(?:cell|row)[^{}]*)\{([^{}]*)\}/g)) {
      assert.doesNotMatch(match[2], layoutProperty, `${path} competes with WorkingChangesFileCell.css: ${match[1].trim()}`)
    }
  }
})

test('Working Changes removes contextual staging duplication and impossible action width', () => {
  assert.match(groups, /renderFile\(file, group\)/)
  assert.match(workingChanges, /stagingStateContext=\{group \? 'group' : 'row'\}/)
  assert.match(groups, /aria-labelledby=\{headingId\}/)
  assert.match(workingChanges, /previewLabel=\{`预览 \$\{file\.path\}，文件状态：\$\{getFileStatusText\(file\.status\)\}，暂存状态：\$\{getStagingStateLabel\(file\.staging_state\)\}，增加 \$\{toNumber\(file\.additions\)\} 行，删除 \$\{toNumber\(file\.deletions\)\} 行`\}/)
  assert.match(cell, /stagingStateContext === 'row' \? stagingStateLabel : null/)
  assert.match(workingChanges, /const stageActions = cellActions\.canStage \|\| cellActions\.minus \?/)
  assert.match(workingChanges, /\{cellActions\.minus \? \(/)
  assert.match(workingChanges, /\{cellActions\.canStage \? \([\s\S]*working-changes-file-stage-action--stage/)
  assert.doesNotMatch(workingChanges, /disabled=\{!can(?:Stage|Unstage)/)
  assert.doesNotMatch(cellCss, /data-staging-state[^}]*display:\s*none/)
  assert.match(cellCss, /\.working-changes-file-cell__preview:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--accent-blue\);[\s\S]*outline-offset:\s*4px;/)
})
