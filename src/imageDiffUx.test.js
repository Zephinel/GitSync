import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { getImageDiffExtension, isImageDiffPath } from './imageDiffUtils.js'

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('uses the canonical image glyph across commit and worktree diff surfaces', () => {
  const layer = readSource('src/CommitDiffLayer.jsx')
  const projection = readSource('src/ImageFileGlyphProjection.jsx')
  const commitView = readSource('src/CommitDiffView.jsx')
  const workingView = readSource('src/WorkingChangesView.jsx')
  const workingCell = readSource('src/WorkingChangesFileCell.jsx')
  const definitions = readSource('src/icons/iconDefinitions.js')
  const domRenderer = readSource('src/icons/iconDom.js')

  assert.match(layer, /import ImageFileGlyphProjection from '\.\/ImageFileGlyphProjection\.jsx'/)
  assert.match(layer, /<ImageFileGlyphProjection \/>/)
  assert.match(projection, /import \{ FILE_GLYPH_DEFINITIONS, FILE_GLYPH_KIND, resolveFileGlyphKind \} from '\.\/fileGlyphIcons\.js'/)
  assert.match(projection, /import \{ createIconSvgElement \} from '\.\/icons\/iconDom\.js'/)
  assert.match(projection, /createIconSvgElement\(icon, \{/)
  assert.match(projection, /glyph\.closest\('\[data-file-path\]'\)/)
  assert.match(projection, /explicitOwner\?\.hasAttribute\('data-file-path'\)/)
  assert.match(projection, /return explicitOwner\.getAttribute\('data-file-path'\) \|\| ''/)
  assert.doesNotMatch(projection, /explicitPath[\s\S]*\.trim\(\)/)
  assert.match(projection, /const GLYPH_TOOLTIP_ATTRIBUTE = 'data-app-tooltip'/)
  assert.match(projection, /glyph\.setAttribute\(GLYPH_TOOLTIP_ATTRIBUTE, GLYPH_TOOLTIP_TEXT\)/)
  assert.doesNotMatch(projection, /setAttribute\('title'/)
  assert.match(projection, /attributeFilter: \['class', 'title', 'aria-pressed', 'data-file-path', 'data-app-tooltip'\]/)
  assert.match(projection, /querySelectorAll\('\.commit-diff-stage \.commit-diff-file-glyph'\)/)
  assert.match(projection, /resolveFileGlyphKind\(path\)/)
  assert.match(commitView, /cardProps=\{\{ 'data-file-path': file\.path \}\}/)
  assert.match(workingView, /filePath=\{file\.path\}/)
  assert.match(workingCell, /data-file-path=\{filePath\}/)
  assert.doesNotMatch(projection, /IMAGE_FILE_GLYPH_SVG|innerHTML\s*=|<svg\b|<path\b/)

  assert.match(workingView, /import \{ FILE_GLYPH_ICONS, FILE_GLYPH_KIND, resolveFileGlyphKind \} from '\.\/fileGlyphIcons\.js'/)
  assert.match(workingView, /<GlyphIcon className="image-file-glyph__icon" \/>/)
  assert.doesNotMatch(workingView, /function ImageGlyphIcon\(\)/)
  assert.match(workingView, /resolveFileGlyphKind\(path\)/)

  assert.match(definitions, /export const IMAGE_FILE_ICON = defineFilledPathIcon\(/)
  assert.match(domRenderer, /export function createIconSvgElement\(icon/)
  assert.doesNotMatch(domRenderer, /\bd:\s*['"`]/)
})

test('recognizes image extensions before common backup suffixes', () => {
  assert.equal(getImageDiffExtension('assets/icon.png.bak'), 'png')
  assert.equal(getImageDiffExtension('assets/photo.JPEG.original'), 'jpeg')
  assert.equal(isImageDiffPath('assets/icon.png.bak'), true)
  assert.equal(isImageDiffPath('assets/archive.bin.bak'), false)
})

test('worktree image preview is a native renderer rather than a DOM projection', () => {
  const view = readSource('src/WorkingChangesView.jsx')
  const layer = readSource('src/WorkingChangesLayer.jsx')

  assert.match(view, /import ImageDiffPreview from '\.\/ImageDiffPreview\.jsx'/)
  assert.match(view, /<ImageDiffPreview mode="working" repoPath=\{repoPath\} file=\{file\} \/>/)
  assert.match(view, /if \(!file\?\.id \|\| !file\.diff_available \|\| isImageDiffCandidate\(file\)\) return/)
  assert.doesNotMatch(layer, /WorkingChangesImagePreviewProjection|data-working-image-preview-hidden|createPortal/)
})

test('worktree preview and Git operation selection remain independent by default', () => {
  const view = readSource('src/WorkingChangesView.jsx')
  const layer = readSource('src/WorkingChangesLayer.jsx')
  const css = readSource('src/WorkingChangesImagePreviewLayer.css')
  const performanceCss = readSource('src/WorkingChangesPerformance.css')
  const fileCell = readSource('src/WorkingChangesFileCell.css')

  assert.match(view, /const operationBusyRef = useRef\(false\)/)
  assert.match(view, /const \[selectedIds, setSelectedIds\] = useState\(\(\) => new Set\(\)\)/)
  assert.doesNotMatch(view, /const \[batchMode, setBatchMode\]|batchModeRef|toggleBatchMode/)
  assert.match(view, /const handleFilePreview = useCallback\(\(file\) => \{\s*setSelectedFileId\(file\.id\)\s*\}, \[\]\)/)
  assert.match(view, /<WorkingChangesFileCell/)
  assert.match(view, /checkbox=\{<CanonicalCheckbox/)
  assert.doesNotMatch(fileCell, /\.working-changes-file-cell__selection\s*\{[^}]*display:\s*none;/)
  assert.match(fileCell, /\.working-changes-file-cell__selection\s*\{[^}]*display:\s*grid;/)
  assert.doesNotMatch(performanceCss, /content-visibility|contain-intrinsic-size/)
  assert.doesNotMatch(layer, /BATCH_MODE_DATASET_KEY|MutationObserver\(syncBatch|input\.click\(\)/)
})

test('always-visible operation scope keeps selection React-owned', () => {
  const working = readSource('src/WorkingChangesView.jsx')

  assert.match(working, /const \[selectedIds, setSelectedIds\] = useState\(\(\) => new Set\(\)\)/)
  assert.match(working, /const toggleSelected = useCallback/)
  assert.match(working, /const toggleAllVisible = \(checked\) =>/)
  assert.doesNotMatch(working, /setBatchMode|toggleBatchMode/)
})

test('always-visible actions keep one shared width without squeezing summary metadata', () => {
  const css = readSource('src/WorkingChangesImagePreviewLayer.css')
  const polish = readSource('src/WorkingChangesPolish.css')

  assert.match(css, /--working-changes-actions-width:\s*clamp\(520px, 45vw, 660px\)/)
  assert.match(css, /\.working-changes-sheet \.commit-diff-header__meta[\s\S]*padding-right:\s*calc\(var\(--working-changes-actions-width\) \+ 14px\)/)
  assert.match(css, /\.working-changes-sheet \.working-changes-toolbar[\s\S]*width:\s*var\(--working-changes-actions-width\)/)
  assert.match(css, /\.working-changes-toolbar__actions\s*\{[\s\S]*display:\s*contents;/)
  assert.match(css, /\.working-changes-toolbar__selection\s*\{[\s\S]*order:\s*5;/)
  assert.match(css, /\.working-changes-action--discard\s*\{[\s\S]*order:\s*20;/)
  assert.match(css, /\.ai-review-toolbar-button\s*\{[\s\S]*order:\s*40;/)
  assert.match(css, /\.working-changes-toolbar \.working-changes-action[\s\S]*min-width:\s*88px;[\s\S]*max-width:\s*112px;[\s\S]*flex:\s*1 1 104px;/)
  assert.match(polish, /\.commit-diff-header__meta\.commit-diff-header__meta--designed \.commit-diff-meta-item--branch\s*\{[\s\S]*min-width:\s*0;[\s\S]*flex:\s*0 1 auto;/)
  assert.doesNotMatch(polish, /\.commit-diff-meta-item--branch\s*\{[\s\S]*flex:\s*1 1/)
  assert.match(css, /\.commit-diff-meta-item--files::after\s*\{[\s\S]*content:\s*'未提交改动总行数';/)
})

test('always-visible controls have no obsolete operation-mode transition', () => {
  const view = readSource('src/WorkingChangesView.jsx')
  const css = readSource('src/WorkingChangesImagePreviewLayer.css')

  assert.doesNotMatch(view, /working-changes-sheet--browse|working-changes-sheet--batch|batchMode/)
  assert.doesNotMatch(css, /working-changes-sheet--browse|working-changes-sheet--batch|workingChangesBatch|working-changes-batch-mode/)
  assert.match(css, /\.working-changes-sheet \.working-changes-toolbar__selection\s*\{[\s\S]*display:\s*flex;/)
})

test('missing image panes explain added and deleted states in user-facing language', () => {
  const preview = readSource('src/ImageDiffPreview.jsx')

  assert.match(preview, /title: '新增前没有此文件'/)
  assert.match(preview, /HEAD 中没有这个文件，右侧展示当前工作区新增的图片。/)
  assert.match(preview, /title: '删除后不再存在'/)
  assert.match(preview, /当前工作区已经删除这个文件，左侧保留 HEAD 中的原图片。/)
  assert.doesNotMatch(preview, />该版本不可用</)
})
