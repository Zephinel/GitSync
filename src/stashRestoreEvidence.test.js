import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('complete Apply and Pop require persisted command evidence and stable target semantics', () => {
  const guard = read('../src-tauri/src/stash/restore_guard.rs')

  assert.match(guard, /async fn validate_complete_result/)
  assert.match(guard, /value\.command_success/)
  assert.match(guard, /== Some\(true\)/)
  assert.match(guard, /find_stash_entry\(snapshot, &target_id\)/)
  assert.match(guard, /result\.operation == "apply"/)
  assert.match(guard, /!result\.applied \|\| result\.dropped \|\| !result\.stash_retained \|\| !target_present/)
  assert.match(guard, /result\.operation == "pop"/)
  assert.match(guard, /!result\.applied \|\| !result\.dropped \|\| result\.stash_retained \|\| target_present/)
})

test('restore uncertainty preserves all mutation axes in durable journal evidence', () => {
  const guard = read('../src-tauri/src/stash/restore_guard.rs')

  assert.match(guard, /async fn persist_restore_uncertainty/)
  assert.match(guard, /stored\.mutated = result\.mutated/)
  assert.match(guard, /stored\.worktree_changed = result\.worktree_changed/)
  assert.match(guard, /stored\.applied = result\.applied/)
  assert.match(guard, /stored\.dropped = result\.dropped/)
  assert.match(guard, /stored\.stash_retained = result\.stash_retained/)
  assert.match(guard, /journal\.phase = "settled"/)
  assert.match(guard, /journal\.result = Some\(stored\)/)
})

test('restore validation remains inside repository operation authority', () => {
  const guard = read('../src-tauri/src/stash/restore_guard.rs')

  const authority = guard.indexOf('let _authority = acquire_stash_operation_authority')
  const rawRestore = guard.indexOf('super::apply_repo_stash')
  const validation = guard.indexOf('validate_complete_result(&repo_root')
  assert.ok(authority >= 0 && authority < rawRestore && rawRestore < validation)
  assert.match(guard, /let _guard = acquire_repo_git_guard\(state, repo_root\)\.await/)
})
