import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitGitRepoPath } from './gitPathIdentity.js'
import { buildWorkingChangesViewModel, canRunStagingOperation } from './stagingViewModel.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

test('loads diff metadata and staging authority as separate inputs', () => {
  const source = read('WorkingChangesView.jsx')

  assert.match(source, /from '\.\/stagingViewModel\.js'/)
  assert.match(source, /Promise\.all\(\[[\s\S]*invoke\('get_repo_working_diff_summary'[\s\S]*invoke\('get_repo_staging_snapshot'/)
  assert.match(source, /buildWorkingChangesViewModel\(workingSummary, stagingSnapshot\)/)
  assert.match(source, /const stagingAuthorityReady = !summaryState\.loading[\s\S]*&& !summaryState\.error[\s\S]*&& hasExecutableStagingAuthority\(summary\)/)
  assert.match(source, /仓库状态在读取过程中发生变化/)
  assert.match(source, /Stage \/ Unstage 已暂停/)
})

test('joins Working Changes and Staging by exact status-entry identity before enabling mutation', () => {
  const viewModel = read('stagingViewModel.js')

  assert.match(viewModel, /function exactStatusIndex\(files\)/)
  assert.match(viewModel, /const key = stagingEntryIdentity\(file\)/)
  assert.match(viewModel, /const exactMatches = exact\.get\(stagingEntryIdentity\(stagingFile\)\) \|\| \[\]/)
  assert.match(viewModel, /if \(exactMatches\.length !== 1\) return null/)
  assert.match(viewModel, /stagingFile\.authority_id && stagingFile\.authority_id !== workingFile\.authority_id/)
  assert.match(viewModel, /const isConsistent = headMatches && workingOnlyCount === 0 && stagingOnlyCount === 0/)
  assert.doesNotMatch(viewModel, /function uniquePathIndex|const pathMatches = byPath/)

  const workingFile = {
    id: 'authority-a',
    path: 'a.txt',
    old_path: null,
    index_code: ' ',
    worktree_code: 'M',
    is_untracked: false,
  }
  const stagingFile = {
    ...workingFile,
    staging_state: 'unstaged',
    can_stage: true,
    can_unstage: false,
  }
  const workingSummary = { full_hash: 'head', snapshot_id: 'working', files: [workingFile] }
  const stagingSnapshot = { head_hash: 'head', snapshot_id: 'staging', files: [stagingFile] }

  const unique = buildWorkingChangesViewModel(workingSummary, stagingSnapshot)
  assert.equal(unique.consistency.is_consistent, true)
  assert.equal(unique.files[0].authority_id, 'authority-a')

  const mismatch = buildWorkingChangesViewModel(workingSummary, {
    ...stagingSnapshot,
    files: [{ ...stagingFile, id: 'authority-b' }],
  })
  assert.equal(mismatch.consistency.is_consistent, false)
  assert.equal(mismatch.files[0].authority_id, '')

  const duplicate = buildWorkingChangesViewModel({
    ...workingSummary,
    files: [workingFile, { ...workingFile }],
  }, stagingSnapshot)
  assert.equal(duplicate.consistency.is_consistent, false)

  const missing = buildWorkingChangesViewModel({ ...workingSummary, files: [] }, stagingSnapshot)
  assert.equal(missing.consistency.is_consistent, false)
})

test('sends snapshot identity and expected XY state only after explicit staging confirmation', () => {
  const source = read('WorkingChangesView.jsx')

  assert.match(source, /const targets = isStaging \? buildStagingTargets\(targetFiles, type\) : buildWorkingChangeTargets\(targetFiles\)/)
  assert.match(source, /inputProps=\{\{ 'data-file-id': file\.id \}\}/)
  assert.match(source, /snapshotId: isStaging \? summary\.snapshot_id : summary\.working_snapshot_id/)
  assert.match(source, /expectedSnapshotId: dialog\.snapshotId/)
  assert.match(source, /type === 'stage' \? 'stage_repo_files' : 'unstage_repo_files'/)
  assert.match(source, /onConfirm=\{confirmOperation\}/)
  assert.match(source, /确认暂存/)
  assert.match(source, /确认取消暂存/)
  assert.match(source, /label: '确认丢弃'/)
  assert.match(source, /不会提交、丢弃或改写文件内容/)
  assert.match(source, /不会丢弃修改或恢复旧文件内容/)
  assert.match(read('WorkingChangesView.css'), /\.working-changes-dialog footer button \{[\s\S]*flex: 0 0 auto;[\s\S]*padding-inline: 16px;[\s\S]*white-space: nowrap;/)
  assert.doesNotMatch(source, /useEffect\([^)]*stage_repo_files/)
  assert.doesNotMatch(source, /useEffect\([^)]*unstage_repo_files/)
})

test('binds commit and discard to exact working snapshot and status-entry authority', () => {
  const source = read('WorkingChangesView.jsx')
  const viewModel = read('stagingViewModel.js')
  const backend = read('../src-tauri/src/working_changes.rs')

  assert.match(viewModel, /export function buildWorkingChangeTargets\(files\)/)
  assert.match(viewModel, /expectedIndexCode: statusCode/)
  assert.match(viewModel, /expectedWorktreeCode: statusCode/)
  assert.match(viewModel, /expectedIsUntracked: Boolean/)
  assert.match(viewModel, /working_snapshot_id: normalizeText\(workingSummary\?\.snapshot_id/)
  assert.match(viewModel, /normalizeText\(viewModel\?\.working_snapshot_id\)/)

  assert.match(source, /const targets = operationDialog\.targets/)
  assert.match(source, /expectedSnapshotId: operationDialog\.snapshotId/)
  assert.match(source, /invoke\('commit_repo_working_files',[\s\S]*files: targets[\s\S]*expectedSnapshotId: operationDialog\.snapshotId/)
  assert.match(source, /invoke\('discard_repo_working_files',[\s\S]*files: targets[\s\S]*expectedSnapshotId: operationDialog\.snapshotId/)
  assert.doesNotMatch(source, /const workingTargets = \(targetFiles\)/)

  assert.match(backend, /pub expected_index_code: String/)
  assert.match(backend, /pub expected_worktree_code: String/)
  assert.match(backend, /pub expected_is_untracked: bool/)
  assert.match(backend, /ensure_expected_snapshot\(&summary, &expected_snapshot_id\)/)
  assert.match(backend, /file\.index_code == target\.expected_index_code/)
  assert.match(backend, /file\.worktree_code == target\.expected_worktree_code/)
  assert.match(backend, /file\.is_untracked == target\.expected_is_untracked/)
  assert.match(backend, /多个 Git status identity，Commit \/ Discard 不会猜测目标/)
})

test('provides both file-level and batch stage actions without treating conflicts as ordinary files', () => {
  const source = read('WorkingChangesView.jsx')

  assert.match(read('stagingViewModel.js'), /export function resolveFileCellActions\(file/)
  assert.match(source, /aria-label=\{`暂存 \$\{file\.path\}`\}/)
  assert.match(source, /data-app-tooltip=\{cellActions\.minus\.title\}/)
  assert.match(source, /aria-label=\{cellActions\.minus\.ariaLabel\}/)
  assert.match(source, /selectedStageCandidates/)
  assert.match(source, /selectedUnstageCandidates/)
  assert.match(source, /暂存选中/)
  assert.match(source, /取消暂存/)
  assert.match(source, /selectedHasConflict/)
  assert.match(source, /const cellActions = resolveFileCellActions\(file, \{ authorityReady: stagingAuthorityReady \}\)/)
  assert.match(source, /const stageActions = cellActions\.canStage \|\| cellActions\.minus \?/)
  assert.match(source, /\{cellActions\.canStage \? \([\s\S]*working-changes-file-stage-action--stage/)
  assert.match(source, /\{cellActions\.minus \? \(/)
  assert.match(source, /working-changes-file-stage-action--stage"[\s\S]{0,120}disabled=\{operationBusy\}/)
  assert.ok(source.includes('working-changes-file-stage-action--${cellActions.minus.tone}'))
  assert.ok(source.includes('disabled={operationBusy}'))
  assert.doesNotMatch(source, /disabled=\{!can(?:Stage|Unstage)/)

  const cell = read('WorkingChangesFileCell.jsx')
  assert.match(cell, /\{actions \? \([\s\S]*working-changes-file-cell__actions[\s\S]*\) : null\}/)
})

test('projects only meaningful file actions for every staging state', () => {
  const actionsFor = (file) => [
    canRunStagingOperation(file, 'unstage') ? 'unstage' : null,
    canRunStagingOperation(file, 'stage') ? 'stage' : null,
  ].filter(Boolean)

  assert.deepEqual(actionsFor({ staging_state: 'staged', can_stage: false, can_unstage: true }), ['unstage'])
  assert.deepEqual(actionsFor({ staging_state: 'unstaged', can_stage: true, can_unstage: false }), ['stage'])
  assert.deepEqual(actionsFor({ staging_state: 'untracked', can_stage: true, can_unstage: false }), ['stage'])
  assert.deepEqual(actionsFor({ staging_state: 'mixed', can_stage: true, can_unstage: true }), ['unstage', 'stage'])
  assert.deepEqual(actionsFor({ staging_state: 'conflicted', is_conflicted: true, can_stage: true, can_unstage: true }), [])
  assert.deepEqual(actionsFor({ staging_state: 'clean', can_stage: false, can_unstage: false }), [])

  const authorityUnavailable = (file) => false && canRunStagingOperation(file, 'stage')
  assert.equal(authorityUnavailable({ staging_state: 'unstaged', can_stage: true }), false)
})

test('renders POSIX backslash filenames distinctly from slash-separated paths', () => {
  const source = read('WorkingChangesView.jsx')

  assert.deepEqual(splitGitRepoPath('a\\b.txt'), {
    directory: '',
    fileName: 'a\\b.txt',
  })
  assert.deepEqual(splitGitRepoPath('a/b.txt'), {
    directory: 'a/',
    fileName: 'b.txt',
  })
  assert.notDeepEqual(splitGitRepoPath('a\\b.txt'), splitGitRepoPath('a/b.txt'))
  assert.match(source, /import \{ splitGitRepoPath \} from '\.\/gitPathIdentity\.js'/)
  assert.match(read('fileGlyphIcons.js'), /const \{ fileName \} = splitGitRepoPath\(path\)/)
  assert.match(source, /const pathParts = splitGitRepoPath\(file\.path\)/)
  assert.doesNotMatch(source, /function splitPath\(path\)/)
})

test('preserves partial and uncertain outcomes while refreshing repository context', () => {
  const source = read('WorkingChangesView.jsx')

  assert.match(source, /describeStagingOperationResult\(result\)/)
  assert.match(source, /installReturnedSnapshot\(described\.snapshot\)/)
  assert.match(source, /setNotice\(described\)/)
  assert.match(source, /await onChanged\?\.\(result\)/)
  assert.match(source, /await loadSummary\(\{ preserveSelection: false, silent: true \}\)/)
  assert.match(source, /working-changes-notice__details/)
  assert.match(source, /detail\.message/)
})

test('renders staged, unstaged, mixed, untracked and conflict status distinctly', () => {
  const source = read('WorkingChangesView.jsx')
  const css = read('WorkingChangesStaging.css')

  for (const state of ['staged', 'unstaged', 'mixed', 'untracked', 'conflicted']) {
    assert.match(css, new RegExp(`working-changes-staging-badge--${state}`))
  }
  assert.match(source, /已暂存/)
  assert.match(source, /未暂存/)
  assert.match(source, /部分暂存/)
  assert.match(source, /未跟踪/)
  assert.match(source, /冲突/)
  assert.match(source, /stagingState=\{file\.staging_state\}/)
  assert.match(source, /stagingStateContext=\{group \? 'group' : 'row'\}/)
})

test('keeps the expanded action set in normal flow at wide and narrow widths', () => {
  const css = read('WorkingChangesStaging.css')
  const fileCell = read('WorkingChangesFileCell.css')

  assert.match(css, /\.working-changes-sheet \.working-changes-toolbar \{[\s\S]*position: static;[\s\S]*width: auto;[\s\S]*height: auto;/)
  assert.match(css, /\.working-changes-sheet \.working-changes-toolbar__actions \{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;/)
  assert.match(css, /\.working-changes-action--unstage \{[\s\S]*order: 12;/)
  assert.match(css, /\.working-changes-action--stage \{[\s\S]*order: 14;/)
  assert.match(fileCell, /\.working-changes-file-cell--has-actions \{[\s\S]*grid-template-columns: var\(--working-changes-selection-rail-width\) minmax\(0, 1fr\) max-content;/)
  assert.match(fileCell, /@container working-changes-file-cell \(max-width: 25rem\)/)
  assert.doesNotMatch(fileCell, /@media \(max-width:/)
  assert.doesNotMatch(fileCell, /working-changes-file-cell__selection[\s\S]*visibility:\s*hidden/)
})

test('keeps staging controls keyboard-visible and reduced-motion safe', () => {
  const source = read('WorkingChangesView.jsx')
  const css = read('WorkingChangesFileCell.css')

  assert.match(source, /actionsProps=\{\{ 'aria-label': `\$\{file\.path\} 文件操作` \}\}/)
  assert.match(source, /role="dialog" aria-modal="true"/)
  assert.match(source, /autoFocus=\{!isCommit\}/)
  assert.match(source, /aria-busy=\{summaryState\.loading \|\| operationBusy\}/)
  assert.match(source, /event\.key !== 'Escape'/)
  assert.match(css, /\.working-changes-file-stage-action:focus-visible/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(css, /accent-color/)
})

test('keeps existing commit, discard, text diff, image diff and focus mode paths', () => {
  const source = read('WorkingChangesView.jsx')

  assert.match(source, /commit_repo_working_files/)
  assert.match(source, /discard_repo_working_files/)
  assert.match(source, /parsePatchRows/)
  assert.match(source, /parseSplitPatchRows/)
  assert.match(source, /ImageDiffPreview mode="working"/)
  assert.match(source, /toggleDiffFocusMode/)
  assert.match(source, /role="separator"/)
})
