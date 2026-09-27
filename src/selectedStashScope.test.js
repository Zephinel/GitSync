import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildCreateStashRequest,
  canCreateStash,
  normalizeStashDetail,
  normalizeStashFileDiff,
  normalizeStashPathTargets,
  stashCreateScopeLabel,
} from './stashViewModel.js'
import {
  buildScopeUnstageTargets,
  normalizeSelectedStashTargets,
  projectResolvedScopeTargets,
  selectedStashUnsupportedSummary,
} from './stashScopeResolution.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const snapshot = {
  snapshotId: 'stash-snapshot-1',
  headHash: 'a'.repeat(40),
  conflictedFiles: 0,
  canCreateDefault: true,
  canCreateWithUntracked: true,
}

const selected = [
  {
    path: 'src/new.rs',
    old_path: 'src/old.rs',
    has_staged_changes: true,
    has_unstaged_changes: true,
  },
  {
    path: 'notes.txt',
    is_untracked: true,
    has_unstaged_changes: true,
  },
]

test('normalizes and binds selected file identity to the visible snapshot', () => {
  const files = normalizeStashPathTargets(selected)
  assert.deepEqual(files.map(({ path, oldPath }) => ({ path, oldPath })), [
    { path: 'src/new.rs', oldPath: 'src/old.rs' },
    { path: 'notes.txt', oldPath: null },
  ])

  const request = buildCreateStashRequest(snapshot, {
    requestId: 'selected-request',
    message: 'selected work',
    includeUntracked: false,
    keepIndex: false,
    files,
  })
  assert.deepEqual(request.files, [
    { path: 'src/new.rs', oldPath: 'src/old.rs' },
    { path: 'notes.txt', oldPath: null },
  ])
  assert.equal(request.includeUntracked, true)
  assert.equal(request.expectedSnapshotId, snapshot.snapshotId)
})

test('treats Git file paths as opaque identities across selected Stash and detail projection', () => {
  const identityPaths = ['a\\b.txt', 'a/b.txt', ' file.txt', 'file.txt', 'tail.txt ']
  const files = identityPaths.map((path) => ({
    path,
    old_path: path === 'a\\b.txt' ? ' old\\name.txt' : null,
    index_code: ' ',
    worktree_code: 'M',
    has_unstaged_changes: true,
  }))

  const normalized = normalizeStashPathTargets(files)
  assert.deepEqual(normalized.map((file) => file.path), identityPaths)
  assert.equal(normalized[0].oldPath, ' old\\name.txt')
  assert.equal(new Set(normalized.map((file) => file.path)).size, identityPaths.length)

  const scopeTargets = normalizeSelectedStashTargets(files)
  assert.deepEqual(scopeTargets.map((file) => file.path), identityPaths)
  assert.equal(scopeTargets[0].oldPath, ' old\\name.txt')

  const request = buildCreateStashRequest(snapshot, {
    requestId: 'path-identity-request',
    files,
  })
  assert.deepEqual(request.files.map((file) => file.path), identityPaths)
  assert.equal(request.files[0].oldPath, ' old\\name.txt')

  const detail = normalizeStashDetail({
    files: identityPaths.map((path) => ({ path, status: 'modified' })),
  })
  assert.deepEqual(detail.files.map((file) => file.path), identityPaths)

  const diff = normalizeStashFileDiff({
    stash_id: 'a'.repeat(40),
    path: ' a\\b.txt ',
    old_path: ' old\\name.txt ',
    patch: 'diff',
  })
  assert.equal(diff.path, ' a\\b.txt ')
  assert.equal(diff.oldPath, ' old\\name.txt ')
})

test('selection itself authorizes selected untracked files', () => {
  assert.equal(canCreateStash(snapshot, false, selected, false), true)
  assert.equal(canCreateStash(snapshot, true, selected, false), true)

  const stagedOnly = [{
    path: 'staged.txt',
    has_staged_changes: true,
    has_unstaged_changes: false,
  }]
  assert.equal(canCreateStash(snapshot, false, stagedOnly, true), false)
  assert.equal(canCreateStash(snapshot, false, stagedOnly, false), true)
})

test('scope label derives directly from the current selection count', () => {
  assert.equal(stashCreateScopeLabel([]), 'Stash 全部改动')
  assert.equal(stashCreateScopeLabel([{ path: 'a.txt' }]), 'Stash 1 个文件')
  assert.equal(stashCreateScopeLabel([{ path: 'a.txt' }, { path: 'b.txt' }]), 'Stash 2 个文件')
})

test('scope resolution preserves same-path Git identities instead of silently deduplicating', () => {
  const targets = normalizeSelectedStashTargets([
    { path: 'file.md', index_code: 'D', has_staged_changes: true },
    { path: 'file.md', index_code: '?', worktree_code: '?', is_untracked: true, has_unstaged_changes: true },
  ])
  assert.equal(targets.length, 2)
  const summary = selectedStashUnsupportedSummary(targets)
  assert.equal(summary.kind, 'multiple-identities')
  assert.equal(summary.fileCount, 2)
  assert.match(summary.description, /多种 Git 身份/)
})

test('staged deletion rename and copy produce friendly range-resolution summaries', () => {
  const deletion = selectedStashUnsupportedSummary([{ path: 'old.md', index_code: 'D', has_staged_changes: true }])
  const rename = selectedStashUnsupportedSummary([{ path: 'new.md', old_path: 'old.md', index_code: 'R', has_staged_changes: true }])
  const copy = selectedStashUnsupportedSummary([{ path: 'copy.md', old_path: 'old.md', index_code: 'C', has_staged_changes: true }])
  assert.equal(deletion.kind, 'staged-deletion')
  assert.equal(rename.kind, 'staged-rename-copy')
  assert.equal(copy.kind, 'staged-rename-copy')
  assert.match(deletion.description, /Stash 全部改动/)
})

test('unstage resolution binds exact staging authority and reprojects the selected identities', () => {
  const selectedTargets = normalizeSelectedStashTargets([
    { path: 'old.md', index_code: 'D', worktree_code: ' ', has_staged_changes: true },
  ])
  const stagingBefore = {
    files: [{
      path: 'old.md', index_code: 'D', worktree_code: ' ', has_staged_changes: true,
      can_unstage: true, is_conflicted: false,
    }],
  }
  const workingSummary = {
    files: [{
      id: 'authority-staged-deletion',
      path: 'old.md', index_code: 'D', worktree_code: ' ', is_untracked: false,
    }],
  }
  assert.deepEqual(buildScopeUnstageTargets(stagingBefore, selectedTargets, workingSummary.files), [{
    path: 'old.md',
    oldPath: null,
    expectedIndexCode: 'D',
    expectedWorktreeCode: ' ',
    expectedAuthorityId: 'authority-staged-deletion',
  }])
  const stagingAfter = {
    files: [{ path: 'old.md', index_code: ' ', worktree_code: 'D', has_unstaged_changes: true }],
  }
  const projected = projectResolvedScopeTargets(stagingAfter, selectedTargets)
  assert.equal(projected.length, 1)
  assert.equal(projected[0].worktreeCode, 'D')
})

test('snapshot preview and selected execution share one streamed worktree status authority', () => {
  const snapshotSource = read('../src-tauri/src/stash/snapshot.rs')
  const scope = read('../src-tauri/src/stash/selected_scope.rs')
  const stream = read('../src-tauri/src/stash/snapshot_stream.rs')

  assert.match(stream, /const STASH_WORKTREE_STATUS_ARGS/)
  assert.match(stream, /"status"/)
  assert.match(stream, /"--porcelain=v1"/)
  assert.match(stream, /"-z"/)
  assert.match(stream, /"-uall"/)
  assert.match(stream, /"--untracked-files=all"/)
  assert.match(stream, /async fn read_snapshot_worktree_status/)
  assert.match(stream, /async fn read_stash_worktree_files_streamed/)
  assert.match(snapshotSource, /read_snapshot_worktree_status\(repo_root, branch_value, head_value\)\.await/)
  assert.match(scope, /read_stash_worktree_files_streamed\(repo_root\)\.await/)
  assert.match(scope, /worktree_status_args_with_pathspecs/)
  assert.doesNotMatch(`${snapshotSource}\n${scope}`, /"--porcelain=v1"|"--untracked-files=all"/)
  assert.doesNotMatch(snapshotSource, /WorktreeSummary[\s\S]*raw: String/)
})

test('new selected journals persist an unselected Git digest instead of the full worktree inventory', () => {
  const gitStream = read('../src-tauri/src/stash/git_stream.rs')
  const scope = read('../src-tauri/src/stash/selected_scope.rs')
  const command = read('../src-tauri/src/stash/selected_create.rs')
  const gitTests = read('../src-tauri/src/stash/selected_scope_git_tests.rs')

  assert.match(gitStream, /async fn hash_git_command_stdout/)
  assert.match(gitStream, /\["hash-object", "--stdin"\]/)
  assert.match(gitStream, /tokio::io::copy\(&mut source_stdout, &mut hash_stdin\)/)
  assert.match(gitStream, /normalize_git_content_oid/)
  assert.match(scope, /top_literal_exclude_pathspec/)
  assert.match(scope, /:\(top,literal,exclude\)/)
  assert.match(scope, /hash_unselected_stash_worktree_status/)
  assert.match(scope, /read_stash_worktree_files_for_targets/)
  assert.match(scope, /read_stash_worktree_files_for_selected/)
  assert.match(scope, /verify_selected_scope_digest_after_create/)
  assert.match(command, /before_unselected_status_oid: String/)
  assert.match(command, /#\[serde\(default\)\][\s\S]*before_files: Vec<StashWorktreeFile>/)
  assert.match(command, /before_unselected_status_oid,[\s\S]*before_files: Vec::new\(\)/)
  assert.match(command, /validate_selected_scope_evidence/)
  assert.match(command, /selected_scope_verified_for_journal/)
  assert.match(command, /journal\.before_files/)
  assert.match(command, /journal\.before_unselected_status_oid/)
  assert.doesNotMatch(command, /pub\(crate\) async fn reconcile_repo_selected_stash_operation/)
  assert.match(gitTests, /unselected_digest_ignores_selected_changes_and_detects_other_worktree_changes/)
})

test('new selected requests are budgeted before mutation without blocking existing replay', () => {
  const types = read('../src-tauri/src/stash/mod.rs')
  const budget = read('../src-tauri/src/stash/selected_scope_budget.rs')
  const guard = read('../src-tauri/src/stash/selected_create_guard.rs')

  assert.match(types, /include!\("selected_scope_budget\.rs"\)/)
  assert.match(budget, /STASH_SELECTED_TARGET_MAX_FILES: usize = 512/)
  assert.match(budget, /STASH_SELECTED_PATHSPEC_BUDGET_UTF16: usize = 16 \* 1024/)
  assert.match(budget, /STASH_SELECTED_DIGEST_PATHSPEC_BUDGET_UTF16: usize = 24 \* 1024/)
  assert.match(budget, /argument\.encode_utf16\(\)\.count\(\)/)
  assert.match(budget, /selected_scope_request_pathspecs/)
  assert.match(budget, /请缩小选择范围或改用 Stash 全部改动/)

  const existingResult = guard.indexOf('if let Some(result) = existing_result')
  const budgetCall = guard.indexOf('ensure_selected_scope_request_budget(&targets)?')
  const admission = guard.indexOf('ensure_no_other_unresolved_stash_operation', budgetCall)
  const rawMutation = guard.indexOf('super::create_repo_stash_selected', admission)
  assert.ok(existingResult >= 0)
  assert.ok(budgetCall > existingResult, 'existing journal/replay must be resolved before new-request budget')
  assert.ok(admission > budgetCall, 'budget must run before new mutation admission')
  assert.ok(rawMutation > admission, 'raw selected mutation must run after budget and admission')
})

test('backend rejects ambiguous selected identities and normalizes idempotency before journal comparison', () => {
  const scope = read('../src-tauri/src/stash/selected_scope.rs')
  const command = read('../src-tauri/src/stash/selected_create.rs')
  const guard = read('../src-tauri/src/stash/selected_create_guard.rs')
  const lib = read('../src-tauri/src/lib.rs')
  const createController = read('./stash-create/CreateStashDialog.jsx')
  const createMutation = read('./stash-create/createStashMutation.js')
  const scopeResolution = read('./stashScopeResolution.js')

  assert.match(scope, /matches\.len\(\) > 1/)
  assert.match(scope, /多种 Git 身份/)
  assert.match(scope, /unsupported_selected_pathspec_state/)
  assert.match(scope, /已在暂存区标记为删除/)
  assert.match(scope, /已在暂存区标记为重命名/)
  assert.match(scope, /git_path_is_known/)
  assert.match(scope, /format!\(":\(literal\)\{\}"/)
  assert.match(command, /owned_args\.extend\(selected_scope_pathspecs\(&selected_files\)\)/)
  assert.match(guard, /create_repo_stash_selected_authoritative/)

  const includeUntracked = guard.indexOf('request.include_untracked = true')
  const journalLoad = guard.indexOf('load_selected_stash_journal_authoritative(&journal_path)?', includeUntracked)
  assert.ok(includeUntracked >= 0)
  assert.ok(journalLoad > includeUntracked, 'normalized selected request must be compared only at the actual journal-load call site')

  assert.match(lib, /authoritative_selected_create::create_repo_stash_selected_authoritative/)
  assert.match(createMutation, /create_repo_stash_selected_authoritative/)
  assert.match(createController, /get_repo_staging_snapshot/)
  assert.match(createController, /unstage_repo_files/)
  assert.match(scopeResolution, /buildScopeUnstageTargets/)
  assert.doesNotMatch(command, /\["add"|\["reset"|stage_repo_files|unstage_repo_files/)
})

test('split button removes the legacy range chooser', () => {
  const entry = read('./WorkingChangesStashEntry.jsx')
  const createController = read('./stash-create/CreateStashDialog.jsx')
  const createForm = read('./stash-create/CreateStashForm.jsx')
  const createMutation = read('./stash-create/createStashMutation.js')

  assert.match(entry, /selectedStashScopeLabel\(files\)/)
  assert.match(entry, /working-changes-stash-split__main/)
  assert.match(entry, /working-changes-stash-split__menu/)
  assert.match(entry, /<CreateStashDialog/)
  assert.match(entry, /<StashManagementPopover/)
  assert.doesNotMatch(entry, /WorkingChangesStashDialog/)
  assert.match(createMutation, /selectedScope \? 'create_selected' : 'create'/)
  assert.match(createForm, /选择行为本身即为本次授权/)
})

test('selected journals remain visible through the unified pending and reconcile authorities', () => {
  const snapshotSource = read('../src-tauri/src/stash/snapshot.rs')
  const snapshotGuard = read('../src-tauri/src/stash/snapshot_guard.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const selectedCommand = read('../src-tauri/src/stash/selected_create.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')

  assert.match(snapshotSource, /collect_unresolved_stash_authorities/)
  assert.match(snapshotSource, /project_pending_stash_operations/)
  assert.match(snapshotGuard, /read_stash_snapshot\(&repo_root\)/)
  assert.doesNotMatch(snapshotGuard, /project_pending_stash_operations/)
  assert.match(authority, /load_selected_stash_journal_authoritative/)
  assert.match(selectedCommand, /SelectedStashOperationJournal/)
  assert.match(selectedCommand, /selected_files/)
  assert.match(selectedCommand, /before_unselected_status_oid/)
  assert.match(selectedCommand, /before_files/)
  assert.match(reconcile, /load_selected_stash_journal_authoritative/)
  assert.match(reconcile, /reconcile_selected_stash_journal/)
})
