import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

test('registers the staging protocol as explicit Tauri commands', () => {
  const lib = read('../src-tauri/src/lib.rs')

  assert.match(lib, /mod staging;/)
  assert.match(lib, /staging::get_repo_staging_snapshot/)
  assert.match(lib, /staging::stage_repo_files/)
  assert.match(lib, /staging::unstage_repo_files/)
})

test('preserves Git index and worktree status instead of collapsing mixed files', () => {
  const source = read('../src-tauri/src/staging.rs')

  assert.match(source, /pub index_code: String/)
  assert.match(source, /pub worktree_code: String/)
  assert.match(source, /pub staging_state: String/)
  assert.match(source, /has_staged_changes && has_unstaged_changes[\s\S]*"mixed"/)
  assert.match(source, /pub files_truncated: bool/)
  assert.match(source, /let files_changed = files\.len\(\)/)
  assert.match(source, /pub staged_files: usize/)
  assert.match(source, /pub unstaged_files: usize/)
  assert.match(source, /pub mixed_files: usize/)
  assert.match(source, /pub untracked_files: usize/)
  assert.match(source, /pub conflicted_files: usize/)
})

test('keeps Git file path identity opaque and emits literal mutation pathspecs', () => {
  const source = read('../src-tauri/src/staging.rs')
  const viewModel = read('./stagingViewModel.js')
  const pathAuthority = read('./gitPathIdentity.js')

  assert.match(pathAuthority, /Git-reported repository-relative file paths are opaque identities/)
  assert.match(pathAuthority, /return String\(value \?\? ''\)/)
  assert.doesNotMatch(pathAuthority, /\.trim\(\)|replace\([^\n]*\\\\/)
  assert.match(source, /if path\.is_empty\(\) \|\| path == "\." \|\| path\.contains\('\\0'\)/)
  assert.match(source, /Ok\(path\.to_string\(\)\)/)
  assert.match(source, /fn literal_pathspec\(path: &str\)/)
  assert.match(source, /format!\(":\(literal\)\{\}", path\)/)
  assert.match(source, /paths\.push\(literal_pathspec\(&file\.path\)\)/)
  assert.doesNotMatch(source, /path\.trim\(\)\.replace\('\\\\', "\/"\)/)
  assert.doesNotMatch(viewModel, /replace\(\/\\\\\/g, '\/'\)/)
})

test('deduplicates staging requests by the full structured target identity', () => {
  const source = read('../src-tauri/src/staging.rs')

  assert.match(source, /pub struct StagingTarget/)
  assert.match(source, /PartialEq, Eq, Hash/)
  assert.match(source, /fn normalized_targets\(targets: &\[StagingTarget\]\)/)
  assert.match(source, /seen\.insert\(normalized\.clone\(\)\)/)
  assert.match(source, /let normalized_files = normalized_targets\(&files\)\?/)
  assert.doesNotMatch(source, /fn target_key\(/)
  assert.match(source, /normalized_targets_do_not_collapse_legal_colon_composites/)
})

test('rejects stale previews and rechecks each file before mutation', () => {
  const source = read('../src-tauri/src/staging.rs')

  assert.match(source, /pub snapshot_id: String/)
  assert.match(source, /pub expected_index_code: String/)
  assert.match(source, /pub expected_worktree_code: String/)
  assert.match(source, /initial_snapshot\.snapshot_id != expected_snapshot_id/)
  assert.match(source, /status: "stale"\.to_string\(\)/)
  assert.match(source, /mutated: false/)
  assert.match(source, /for \(target_index, target\) in normalized_files\.iter\(\)\.enumerate\(\) \{[\s\S]*read_staging_snapshot_inner\(&repo_path\)[\s\S]*find_target_file/)
  assert.match(source, /let remaining = &normalized_files\[target_index\.\.\]/)
  assert.match(source, /当前文件及后续文件均未执行/)
})

test('uses one canonical repository lock and never treats conflicts as ordinary staging', () => {
  const source = read('../src-tauri/src/staging.rs')
  const lockAuthority = read('../src-tauri/src/repo_git_lock.rs')

  // The lock key and the lock map live in one authority; staging only resolves the
  // worktree root (which needs git) and delegates the rest.
  assert.match(lockAuthority, /pub\(crate\) fn normalize_repo_lock_key/)
  assert.match(lockAuthority, /state\.git_repo_locks\.lock\(\)\.await/)
  assert.match(source, /async fn resolve_repo_lock_key/)
  assert.match(source, /\["rev-parse", "--show-toplevel"\]/)
  assert.match(source, /crate::repo_git_lock::normalize_repo_lock_key/)
  assert.match(source, /crate::repo_git_lock::acquire_key/)
  assert.match(source, /let _guard = acquire_repo_git_guard\(&state, &repo_path\)\.await\?/)
  assert.match(source, /冲突文件不能通过普通 Stage 操作标记为已解决/)
  assert.match(source, /冲突文件不能通过普通 Unstage 操作改变解决状态/)
  assert.match(source, /can_stage: has_unstaged_changes && !is_conflicted/)
  assert.match(source, /can_unstage: has_staged_changes && !is_conflicted/)
})

test('keeps file content safe and suppresses Windows command windows', () => {
  const source = read('../src-tauri/src/staging.rs')
  const gitCommand = read('../src-tauri/src/git_command.rs')

  assert.match(source, /\["add"\.to_string\(\), "-A"\.to_string\(\), "--"\.to_string\(\)\]/)
  assert.match(source, /"restore"\.to_string\(\)[\s\S]*"--staged"\.to_string\(\)[\s\S]*"--source=HEAD"\.to_string\(\)/)
  assert.match(source, /"rm"\.to_string\(\)[\s\S]*"--cached"\.to_string\(\)[\s\S]*"--ignore-unmatch"\.to_string\(\)/)
  assert.doesNotMatch(source, /\["commit"/)
  assert.doesNotMatch(source, /\["push"/)
  assert.doesNotMatch(source, /\["stash"/)
  assert.doesNotMatch(source, /\["clean"/)
  assert.doesNotMatch(source, /"--worktree"/)
  assert.match(source, /new_read_only_async_command\(repo_path, args\)/)
  assert.match(gitCommand, /const CREATE_NO_WINDOW: u32 = 0x08000000/)
  assert.match(gitCommand, /command\.creation_flags\(CREATE_NO_WINDOW\)/)
})

test('returns explicit complete, partial, failed, stale and uncertain outcomes', () => {
  const source = read('../src-tauri/src/staging.rs')

  assert.match(source, /pub struct StagingFileOperationResult/)
  assert.match(source, /pub needs_confirmation: bool/)
  assert.match(source, /pub succeeded_count: usize/)
  assert.match(source, /pub failed_count: usize/)
  assert.match(source, /pub uncertain_count: usize/)
  assert.match(source, /pub snapshot: Option<RepoStagingSnapshot>/)
  assert.match(source, /pub snapshot_error: Option<String>/)
  assert.match(source, /"needs_confirmation"[\s\S]*"complete"[\s\S]*"failed"[\s\S]*"partial"/)
  assert.match(source, /status: "success"\.to_string\(\)/)
  assert.match(source, /status: "failed"\.to_string\(\)/)
  assert.match(source, /status: "needs_confirmation"\.to_string\(\)/)
  assert.match(source, /status: "skipped"\.to_string\(\)/)
})

test('re-reads repository state after both successful and failed Git command responses', () => {
  const source = read('../src-tauri/src/staging.rs')

  assert.match(source, /match operation_result \{[\s\S]*Ok\(\(\)\) => match read_staging_snapshot_inner/)
  assert.match(source, /Err\(command_error\) => match read_staging_snapshot_inner/)
  assert.match(source, /verification\.snapshot_id == current_snapshot\.snapshot_id/)
  assert.match(source, /Git 命令返回异常，但重新读取后已确认文件完成暂存/)
  assert.match(source, /请重新确认，不要直接重试/)
})

test('verifies logical rename identity even when unstage splits the status record', () => {
  const source = read('../src-tauri/src/staging.rs')

  assert.match(source, /fn shares_logical_path/)
  assert.match(source, /fn verify_operation/)
  assert.match(source, /fn verifies_a_rename_that_splits_after_unstage\(\)/)
  assert.match(source, /" D src\/old\.rs\\0\?\? src\/new\.rs\\0"/)
})
