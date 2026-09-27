import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const source = [
  '../src-tauri/src/stash/mod.rs',
  '../src-tauri/src/stash/git.rs',
  '../src-tauri/src/stash/git_stream.rs',
  '../src-tauri/src/stash/snapshot_stream.rs',
  '../src-tauri/src/stash/snapshot.rs',
  '../src-tauri/src/stash/selected_scope.rs',
  '../src-tauri/src/stash/selected_scope_budget.rs',
  '../src-tauri/src/stash/stash_detail_stream.rs',
  '../src-tauri/src/stash/stash_detail.rs',
  '../src-tauri/src/stash/stash_detail_guard.rs',
  '../src-tauri/src/stash/selected_create.rs',
  '../src-tauri/src/stash/operation_authority.rs',
  '../src-tauri/src/stash/selected_create_guard.rs',
  '../src-tauri/src/stash/journal.rs',
  '../src-tauri/src/stash/reconcile.rs',
  '../src-tauri/src/stash/retention.rs',
  '../src-tauri/src/stash/commands.rs',
  '../src-tauri/src/stash/snapshot_guard.rs',
  '../src-tauri/src/stash/create_guard.rs',
  '../src-tauri/src/stash/restore_guard.rs',
  '../src-tauri/src/stash/drop_guard.rs',
].map(read).join('\n')

test('every Stash Git child is created through the Windows-hidden runner', () => {
  const gitCommand = read('../src-tauri/src/git_command.rs')
  assert.match(source, /crate::git_command::new_read_only_async_command/)
  assert.match(source, /crate::git_command::new_mutation_async_command/)
  assert.match(gitCommand, /std::os::windows::process::CommandExt/)
  assert.match(gitCommand, /const CREATE_NO_WINDOW: u32 = 0x08000000/)
  assert.match(gitCommand, /command\.creation_flags\(CREATE_NO_WINDOW\)/)
  assert.equal((source.match(/Command::new\("git"\)/g) || []).length, 0)
})

test('Stash Git children are noninteractive bounded and killed on dropped futures', () => {
  const detailGuard = read('../src-tauri/src/stash/stash_detail_guard.rs')
  const detail = read('../src-tauri/src/stash/stash_detail.rs')
  const detailStream = read('../src-tauri/src/stash/stash_detail_stream.rs')
  const gitStream = read('../src-tauri/src/stash/git_stream.rs')
  const gitCommand = read('../src-tauri/src/git_command.rs')

  assert.match(gitCommand, /GIT_TERMINAL_PROMPT/)
  assert.match(gitCommand, /GCM_INTERACTIVE/)
  assert.match(gitCommand, /GIT_OPTIONAL_LOCKS/)
  assert.match(source, /stdin\(Stdio::null\(\)\)/)
  assert.match(source, /stdout\(Stdio::piped\(\)\)/)
  assert.match(source, /stderr\(Stdio::piped\(\)\)/)
  assert.match(source, /kill_on_drop\(true\)/)
  assert.match(source, /tokio::time::timeout/)
  assert.match(source, /create_repo_stash_selected[\s\S]*run_git_mutation_output/)
  assert.match(detailGuard, /pub async fn get_repo_stash_detail[\s\S]*read_repo_stash_detail\(&repo_root, &stash_id\)\.await/)
  assert.match(detail, /read_repo_stash_detail_streamed/)
  assert.match(detailStream, /run_git_nul_fields/)
  assert.match(gitStream, /read_bounded_git_stderr/)
  assert.match(detail, /read_object_size/)
})

test('registered Stash commands use only canonical authorities', () => {
  const lib = read('../src-tauri/src/lib.rs')
  assert.match(lib, /stash::authoritative_snapshot::get_repo_stash_snapshot/)
  assert.match(lib, /stash::authoritative_detail::get_repo_stash_detail/)
  assert.match(lib, /stash::authoritative_detail::get_repo_stash_file_diff/)
  assert.match(lib, /stash::authoritative_create::create_repo_stash/)
  assert.match(lib, /stash::authoritative_selected_create::create_repo_stash_selected_authoritative/)
  assert.match(lib, /stash::authoritative_restore::apply_repo_stash/)
  assert.match(lib, /stash::authoritative_restore::pop_repo_stash/)
  assert.match(lib, /stash::authoritative_drop::drop_repo_stash/)
  assert.match(lib, /stash::authoritative_reconcile::reconcile_repo_stash_operation/)
  assert.match(lib, /stash::authoritative_acknowledge::acknowledge_repo_stash_operation/)
  assert.doesNotMatch(lib, /\n\s*stash::get_repo_stash_detail,/)
  assert.doesNotMatch(lib, /\n\s*stash::get_repo_stash_file_diff,/)
  assert.doesNotMatch(lib, /\n\s*stash::create_repo_stash_selected,/)
  assert.doesNotMatch(lib, /\n\s*stash::reconcile_repo_selected_stash_operation,/)
  assert.doesNotMatch(lib, /stash_no_window|stash_windows|Command::new\("git"\)/)
})
