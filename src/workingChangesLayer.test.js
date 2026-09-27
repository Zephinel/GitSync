import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

test('mounts the working changes and global Stash manager layers beside branch extensions', () => {
  const source = read('main.jsx')

  assert.match(source, /const BranchManagementLayer = lazy\(\(\) => import\('\.\/BranchManagementLayer\.jsx'\)\)/)
  assert.match(source, /const BranchManagementInteractionLayer = lazy\(\(\) => import\('\.\/BranchManagementInteractionLayer\.jsx'\)\)/)
  assert.match(source, /const RepoStashManagerLayer = lazy\(\(\) => import\('\.\/RepoStashManagerLayer\.jsx'\)\)/)
  assert.match(source, /const WorkingChangesLayer = lazy\(\(\) => import\('\.\/WorkingChangesLayer\.jsx'\)\)/)
  assert.match(source, /import '\.\/BranchManagementSyncFeedback\.css'/)
  assert.match(source, /import '\.\/CommitDiffFileListFinal\.css'/)
  assert.match(source, /import '\.\/StashStyleAuthority\.css'/)
  assert.doesNotMatch(source, /BranchSyncStatusRefreshLayer/)

  const branchLayer = source.indexOf('<BranchManagementLayer />')
  const interactionLayer = source.indexOf('<BranchManagementInteractionLayer />')
  const stashLayer = source.indexOf('<RepoStashManagerLayer />')
  const workingLayer = source.indexOf('<WorkingChangesLayer />')
  const aiLayer = source.indexOf('<AiSettingsSection />')

  assert.ok(
    branchLayer >= 0
      && branchLayer < interactionLayer
      && interactionLayer < stashLayer
      && stashLayer < workingLayer
      && workingLayer < aiLayer,
    'expected branch, Stash, working changes, and AI layers to retain their root order'
  )
})

test('adds a simple details action only to uncommitted-change callouts', () => {
  const source = read('WorkingChangesLayer.jsx')
  assert.match(source, /const CALLOUT_SELECTOR = '\.repo-card__state-callout--warning'/)
  assert.match(source, /const ACTION_CLASS = 'repo-card__working-changes-action'/)
  assert.match(source, /\/未提交改动\//)
  assert.match(source, /button\.textContent = '查看详情'/)
  assert.match(source, /callout\.appendChild\(createActionButton\(\)\)/)
  assert.match(source, /new MutationObserver\(scheduleScan\)/)
  assert.match(source, /setActiveContext\(context\)/)
})

test('broadcasts working-changes mutations so the dashboard card refreshes immediately', () => {
  const layer = read('WorkingChangesLayer.jsx')
  const app = read('App.jsx')
  const events = read('events.js')

  assert.match(events, /REPO_WORKING_CHANGES_CHANGED_EVENT = 'gitsync:repo-working-changes-changed'/)
  assert.match(layer, /import \{ REPO_WORKING_CHANGES_CHANGED_EVENT \} from '\.\/events'/)
  assert.match(
    layer,
    /window\.dispatchEvent\(new CustomEvent\(REPO_WORKING_CHANGES_CHANGED_EVENT/
  )
  assert.match(
    app,
    /import \{ COMMIT_DIFF_OPEN_EVENT, REPO_WORKING_CHANGES_CHANGED_EVENT \} from '\.\/events'/)
  assert.match(app, /window\.addEventListener\(REPO_WORKING_CHANGES_CHANGED_EVENT/)
  assert.match(app, /refreshRepoStatusesByIds\(\[repoId\]\)/)
})

test('uses the working-diff summary as the exact repository-card file count', () => {
  const source = read('WorkingChangesLayer.jsx')
  assert.match(source, /invoke\('get_repo_working_diff_summary', \{ repoPath: normalizedPath \}\)/)
  assert.match(source, /summary\?\.files_changed \?\? summary\?\.filesChanged/)
  assert.match(source, /Array\.isArray\(summary\?\.files\) \? summary\.files\.length : null/)
  assert.match(source, /const nextText = `本地有 \$\{count\} 个未提交改动`/)
  assert.match(source, /WORKING_CHANGES_COUNT_CACHE_TTL_MS = 4000/)
  assert.match(source, /window\.addEventListener\('focus', handleFocus\)/)
  assert.match(source, /invalidateWorkingChangesCount\(context\.repoPath\)/)
})

test('owns always-visible Git operation selection and Stash integration in React source', () => {
  const layer = read('WorkingChangesLayer.jsx')
  const view = read('WorkingChangesView.jsx')
  const vite = read('../vite.config.js')

  assert.match(view, /import WorkingChangesStashEntry from '\.\/WorkingChangesStashEntry\.jsx'/)
  assert.match(view, /const operationBusyRef = useRef\(false\)/)
  assert.match(view, /const \[selectedIds, setSelectedIds\] = useState\(\(\) => new Set\(\)\)/)
  assert.doesNotMatch(view, /const \[batchMode, setBatchMode\]|batchModeRef|toggleBatchMode/)
  assert.match(view, /<div className="working-changes-toolbar__selection">/)
  assert.match(view, /checkbox=\{<CanonicalCheckbox/)
  assert.match(view, /<WorkingChangesStashEntry[\s\S]*visible/)
  assert.doesNotMatch(vite, /workingChangesStashPlugin|viteWorkingChangesStashPlugin/)
  assert.doesNotMatch(layer, /BATCH_MODE_DATASET_KEY|handleWorkingChangesFileCardClick|input\.click\(\)/)
})

test('keeps preview selection separate from an always-visible Git operation scope', () => {
  const view = read('WorkingChangesView.jsx')
  const previewStart = view.indexOf('const handleFilePreview = useCallback')
  const previewEnd = view.indexOf('const openOperation = useCallback', previewStart)

  assert.ok(previewStart >= 0 && previewEnd > previewStart)
  const previewHandler = view.slice(previewStart, previewEnd)

  assert.match(previewHandler, /setSelectedFileId\(file\.id\)/)
  assert.doesNotMatch(previewHandler, /setSelectedIds|batchModeRef/)
  assert.doesNotMatch(view, /const \[batchMode, setBatchMode\]|toggleBatchMode|batchModeRef/)
  assert.match(view, /<div className="working-changes-toolbar__selection">/)
  assert.match(view, /<WorkingChangesStashEntry[\s\S]*visible/)
  assert.match(view, /onClick=\{\(\) => openOperation\('discard', files\)\}[\s\S]*丢弃全部/)
})

test('reuses commit diff rendering while providing selection, Stash, discard and commit actions', () => {
  const source = read('WorkingChangesView.jsx')
  assert.match(source, /parsePatchRows/)
  assert.match(source, /parseSplitPatchRows/)
  assert.match(source, /commit-diff-sheet commit-diff-sheet--designed working-changes-sheet/)
  assert.match(source, /<WorkingChangesStashEntry/)
  assert.match(source, /丢弃选中/)
  assert.match(source, /提交选中/)
  assert.match(source, /CanonicalCheckbox/)
  assert.match(source, /invoke\('get_repo_working_diff_summary'/)
  assert.match(source, /invoke\('get_repo_working_file_diff'/)
  assert.match(source, /invoke\('discard_repo_working_files'/)
  assert.match(source, /invoke\('commit_repo_working_files'/)
  assert.match(source, /其他已暂存改动保持不变/)
})

test('working changes reuses commit diff focus controls and animates both lifecycle directions', () => {
  const source = read('WorkingChangesView.jsx')
  const owner = read('WorkingChangesLayer.jsx')
  const polish = read('WorkingChangesPolish.css')
  assert.match(source, /import \{[\s\S]*COMMIT_DIFF_FOCUS_SIDEBAR_MAX_WIDTH[\s\S]*clampFocusSidebarWidth[\s\S]*\} from '\.\/commitDiffViewUtils'/)
  assert.match(source, /import '\.\/WorkingChangesPolish\.css'/)
  assert.match(source, /ExpandIcon as CanonicalExpandIcon/)
  assert.match(source, /CollapseIcon as CanonicalCollapseIcon/)
  assert.match(source, /isDiffFocusMode \? <CanonicalCollapseIcon className="icon icon--xs" \/> : <CanonicalExpandIcon className="icon icon--xs" \/>/)
  assert.doesNotMatch(source, /function (?:DiffExpandIcon|DiffCollapseIcon)\(\)/)
  assert.match(source, /const \[isDiffFocusMode, setIsDiffFocusMode\] = useState\(false\)/)
  assert.match(source, /commit-diff-header__icon-btn commit-diff-header__focus/)
  assert.match(source, /aria-label=\{isDiffFocusMode \? '收起 Diff 视图' : '展开 Diff 视图'\}/)
  assert.match(source, /commit-diff-body--focus-sidebar-visible/)
  assert.match(source, /role="separator"/)
  assert.match(source, /requestClose/)
  assert.match(source, /present=\{present\}/)
  assert.match(source, /onExitComplete=\{onExitComplete\}/)
  assert.match(source, /data-overlay-motion="backdrop"/)
  assert.match(source, /data-overlay-motion="surface"/)
  assert.match(owner, /const \[present, setPresent\] = useState\(false\)/)
  assert.match(owner, /onClose=\{\(\) => setPresent\(false\)\}/)
  assert.match(owner, /onExitComplete=\{\(\) => setActiveContext\(null\)\}/)
  assert.doesNotMatch(source, /working-changes-(?:backdrop|sheet)--closing/)
  assert.doesNotMatch(source, /onAnimationEnd|CLOSE_FALLBACK|closeFallback/)
  assert.match(polish, /data-overlay-presence='exiting'/)
  assert.match(polish, /@keyframes workingChangesSheetIn/)
  assert.match(polish, /@keyframes workingChangesSheetOut/)
  assert.match(polish, /@keyframes workingChangesBackdropIn/)
  assert.match(polish, /@keyframes workingChangesBackdropOut/)
})

test('working changes header keeps repository context beside the readable repository name', () => {
  const polish = read('WorkingChangesPolish.css')
  assert.match(polish, /\.working-changes-sheet \.commit-diff-header__title-row \{[\s\S]*display: flex;[\s\S]*justify-content: flex-start;/)
  assert.match(polish, /\.working-changes-sheet \.commit-diff-header__app-name \{[\s\S]*flex: 0 1 auto;[\s\S]*max-width: calc\(100% - 214px\);/)
  assert.match(polish, /\.working-changes-sheet \.commit-diff-header__hash,[\s\S]*\.working-changes-sheet \.commit-diff-header__title \{[\s\S]*flex: 0 0 auto;/)
  assert.match(polish, /\.working-changes-sheet \.commit-diff-header__actions \{[\s\S]*min-width: 80px;/)
})

test('commit details and working changes use separate single-layer presentation anatomies', () => {
  const layerSource = read('WorkingChangesLayer.jsx')
  const commitLayerSource = read('CommitDiffLayer.jsx')
  const finalCss = read('CommitDiffFileListFinal.css')
  const sharedCss = read('CommitDiffFileListShared.css')
  const workingCss = read('WorkingChangesView.css')
  const performanceCss = read('WorkingChangesPerformance.css')
  const source = read('WorkingChangesView.jsx')
  const cellSource = read('WorkingChangesFileCell.jsx')
  const cellCss = read('WorkingChangesFileCell.css')
  const commitSource = read('CommitDiffView.jsx')
  const cardSource = read('CommitDiffFileCard.jsx')

  assert.match(layerSource, /import '\.\/CommitDiffFileListShared\.css'/)
  assert.match(commitLayerSource, /import '\.\/CommitDiffFileListShared\.css'/)
  assert.match(commitLayerSource, /import '\.\/WorkingChangesImagePreviewLayer\.css'/)
  assert.match(finalCss, /@import '\.\/CommitDiffFileListShared\.css';/)
  assert.match(cardSource, /className=\{cardClassName\}/)
  assert.match(cardSource, /className=\{contentClassName\}/)
  assert.match(sharedCss, /\.commit-diff-file-card\s*\{[\s\S]*padding: 12px 14px !important;/)
  assert.match(sharedCss, /\.commit-diff-file-card:hover/)
  assert.match(sharedCss, /\.working-changes-sheet \.commit-diff-header--designed \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.match(sharedCss, /\.commit-diff-file-list \{[\s\S]*padding: 22px 18px 40px !important;[\s\S]*scrollbar-gutter: auto;/)
  assert.match(sharedCss, /\.commit-diff-file-card \{[\s\S]*border-radius: 13px !important;[\s\S]*background: var\(--bg-card\) !important;/)
  assert.match(commitSource, /import CommitDiffFileCard from '\.\/CommitDiffFileCard\.jsx'/)
  assert.match(source, /import WorkingChangesFileCell from '\.\/WorkingChangesFileCell\.jsx'/)
  assert.match(commitSource, /<CommitDiffFileCard/)
  assert.match(source, /<WorkingChangesFileCell/)
  assert.doesNotMatch(source, /CommitDiffFileCard/)
  assert.match(cellSource, /import '\.\/WorkingChangesFileCell\.css'/)
  assert.match(cellSource, /className="working-changes-file-cell__preview"/)
  assert.match(cellSource, /className="working-changes-file-cell__actions"/)
  assert.match(cellSource, /role="group"[\s\S]*className="working-changes-file-cell__actions/)
  assert.match(cellSource, /className="working-changes-file-cell__selection"/)
  assert.match(cellSource, /className="working-changes-file-cell__filename"/)
  assert.match(cellSource, /data-file-path=\{filePath\}/)
  assert.doesNotMatch(cellSource, /working-changes-file-stage-actions/)
  assert.match(cellCss, /\.working-changes-file-cell\s*\{[\s\S]*border-radius:\s*13px;[\s\S]*background:\s*var\(--bg-card\);[\s\S]*box-shadow:\s*var\(--app-file-card-shadow\);/)
  assert.doesNotMatch(commitSource, /commit-diff-file-item--selected/)
  assert.doesNotMatch(source, /commit-diff-file-card-surface/)
  assert.doesNotMatch(sharedCss, /\.working-changes-file-list\s*\{/)
  assert.doesNotMatch(sharedCss, /working-changes-file-row|working-changes-file-stage-actions|working-changes-batch-slot/)
  assert.doesNotMatch(sharedCss, /--working-changes-card-edge-inset|padding: 5px var\(--working-changes-card-edge-inset\)|margin-right:\s*-/)

  assert.doesNotMatch(workingCss, /\.working-changes-file-row \{[\s\S]*border:/)
  assert.doesNotMatch(performanceCss, /content-visibility|contain-intrinsic-size|contain:\s*[^;]*paint/)
  assert.doesNotMatch(cellCss, /\.working-changes-file-cell__selection\s*\{[^}]*display:\s*none;/)
  assert.match(cellCss, /\.working-changes-file-cell__selection\s*\{[^}]*display:\s*grid;/)
  assert.match(source, /checkbox=\{<CanonicalCheckbox/)
  assert.doesNotMatch(source, /working-changes-file-row--browse|working-changes-file-row--batch/)
})

test('styles the card entry and destructive confirmation explicitly', () => {
  const css = read('WorkingChangesView.css')
  const canonicalCss = read('CanonicalCheckbox.css')
  assert.match(css, /\.repo-card__working-changes-action/)
  assert.match(css, /\.working-changes-toolbar/)
  assert.match(canonicalCss, /\.canonical-checkbox input:checked \+ \.canonical-checkbox__box/)
  assert.match(css, /\.working-changes-dialog__danger/)
  assert.doesNotMatch(css, /accent-color/)
  assert.doesNotMatch(css, /\.working-changes-checkbox__box/)
})

test('registers exact guarded working tree commands and literal selected pathspecs', () => {
  const libSource = read('../src-tauri/src/lib.rs')
  const backend = read('../src-tauri/src/working_changes.rs')
  assert.match(libSource, /mod working_changes;/)
  assert.match(libSource, /working_changes::get_repo_working_diff_summary/)
  assert.match(libSource, /working_changes::get_repo_working_file_diff/)
  assert.match(libSource, /working_changes::discard_repo_working_files/)
  assert.match(libSource, /working_changes::commit_repo_working_files/)
  assert.match(backend, /"status"[\s\S]*"--porcelain=v1"[\s\S]*"-z"[\s\S]*"-uall"/)
  assert.match(backend, /pub struct WorkingChangeTarget[\s\S]*expected_index_code[\s\S]*expected_worktree_code[\s\S]*expected_is_untracked/)
  assert.match(backend, /pub snapshot_id: String/)
  assert.match(backend, /ensure_expected_snapshot\(&summary, &expected_snapshot_id\)/)
  assert.match(backend, /fn target_matches_file/)
  assert.match(backend, /fn literal_pathspec\(path: &str\)/)
  assert.match(backend, /format!\(":\(literal\)\{\}", path\)/)
  assert.match(backend, /paths\.push\(literal_pathspec\(&file\.path\)\)/)
  assert.match(backend, /pathspec\.as_str\(\)/)
  assert.doesNotMatch(backend, /path\.trim\(\)\.replace\('\\\\', "\/"\)/)
  assert.match(backend, /GIT_INDEX_FILE/)
  assert.match(backend, /read-tree", "HEAD"/)
  assert.match(backend, /"reset"\.to_string\(\)[\s\S]*"HEAD"\.to_string\(\)/)
  assert.match(backend, /"restore"\.to_string\(\)[\s\S]*"--source=HEAD"/)
  assert.doesNotMatch(backend, /\["clean", "-f", "--", file\.path\.as_str\(\)\]/)
})

test('renders worktree image previews directly instead of projecting over binary placeholders', () => {
  const layerSource = read('WorkingChangesLayer.jsx')
  const viewSource = read('WorkingChangesView.jsx')
  const imageSource = read('ImageDiffPreview.jsx')
  const libSource = read('../src-tauri/src/lib.rs')

  assert.match(viewSource, /import ImageDiffPreview from '\.\/ImageDiffPreview\.jsx'/)
  assert.match(viewSource, /if \(isImageDiffCandidate\(file\)\) \{[\s\S]*<ImageDiffPreview mode="working" repoPath=\{repoPath\} file=\{file\} \/>/)
  assert.match(viewSource, /if \(!file\?\.id \|\| !file\.diff_available \|\| isImageDiffCandidate\(file\)\) return/)
  assert.doesNotMatch(layerSource, /createPortal|WorkingChangesImagePreviewProjection|data-working-image-preview-hidden/)
  assert.match(imageSource, /get_repo_working_image_diff_preview/)
  assert.match(libSource, /image_diff::get_repo_working_image_diff_preview/)
})
