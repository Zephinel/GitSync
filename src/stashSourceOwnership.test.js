import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('retired Stash helpers stay out of the production source surface', () => {
  const git = read('../src-tauri/src/stash/git.rs')
  const snapshotStream = read('../src-tauri/src/stash/snapshot_stream.rs')
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const detail = read('../src-tauri/src/stash/stash_detail.rs')
  const selectedScope = read('../src-tauri/src/stash/selected_scope.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const commands = read('../src-tauri/src/stash/commands.rs')

  assert.match(git, /#\[cfg\(test\)\]\s*fn stable_hash\(/)
  assert.match(snapshotStream, /#\[cfg\(test\)\]\s*fn parse_worktree_status\(/)
  assert.match(snapshot, /#\[cfg\(test\)\]\s*fn parse_stash_list\(/)
  assert.match(detail, /#\[cfg\(test\)\]\s*fn parse_name_status_z\(/)
  assert.match(detail, /#\[cfg\(test\)\]\s*fn parse_numstat_z\(/)
  assert.match(detail, /#\[cfg\(test\)\]\s*fn merge_stash_detail_stats\(/)
  assert.match(detail, /#\[cfg\(test\)\]\s*fn mark_untracked_detail_files\(/)

  assert.doesNotMatch(selectedScope, /fn apply_selected_scope_verification\(/)
  assert.doesNotMatch(authority, /async fn stash_operation_lock_key\(/)
  assert.doesNotMatch(authority, /async fn ensure_stash_evidence_readable\(repo_root/)
  assert.match(authority, /async fn ensure_stash_evidence_readable_for_request\(/)
  assert.doesNotMatch(commands, /pub async fn get_repo_stash_snapshot\(/)
})
