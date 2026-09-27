import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('retention removes only settled durable-terminal journals from both families', () => {
  const source = read('../src-tauri/src/stash/retention.rs')

  assert.match(source, /fn is_terminal_stash_journal/)
  assert.match(source, /fn is_terminal_selected_stash_journal/)
  assert.equal((source.match(/journal\.phase == "settled"/g) || []).length, 2)
  assert.equal((source.match(/stash_result_is_durable_terminal\(result, journal\.completion_validated\)/g) || []).length, 2)
  assert.doesNotMatch(source, /matches!\(result\.status\.as_str\(\), "partial"/)
})

test('retention is bounded by age and count without timers or polling', () => {
  const types = read('../src-tauri/src/stash/mod.rs')
  const source = read('../src-tauri/src/stash/retention.rs')

  assert.match(types, /STASH_SETTLED_RETENTION_MS: u128 = 30 \* 24 \* 60 \* 60 \* 1_000/)
  assert.match(types, /STASH_SETTLED_MAX_JOURNALS: usize = 256/)
  assert.match(source, /now\.saturating_sub\(updated_at_ms\) > STASH_SETTLED_RETENTION_MS/)
  assert.match(source, /index >= STASH_SETTLED_MAX_JOURNALS/)
  assert.match(source, /prune_terminal_paths\(regular_terminal\)/)
  assert.match(source, /prune_terminal_paths\(selected_terminal\)/)
  assert.doesNotMatch(source, /setInterval|setTimeout|loop \{|tokio::spawn/)
})

test('public snapshot retains operation authority through retention and read-only pending projection', () => {
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const guard = read('../src-tauri/src/stash/snapshot_guard.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.match(authority, /async fn collect_unresolved_stash_authorities/)
  assert.match(authority, /async fn unresolved_stash_authorities_protecting/)
  assert.match(authority, /prune_settled_stash_journals_except\(repo_root, protected_request_id\)/)
  assert.match(snapshot, /collect_unresolved_stash_authorities\(repo_root\)\.await\?/)
  assert.doesNotMatch(snapshot, /prune_settled_stash_journals/)
  assert.match(snapshot, /let ordered = order_pending_for_snapshot\(&snapshot\.repo_path, unresolved\)/)
  assert.match(snapshot, /project_pending_stash_operations\(ordered\)/)

  const operationAuthority = guard.indexOf('let _authority = acquire_stash_operation_authority(&repo_root).await?')
  const prune = guard.indexOf('let _ = prune_settled_stash_journals(&repo_root).await', operationAuthority)
  const repoGuard = guard.indexOf('let _guard = acquire_repo_git_read_guard(&state, &repo_root).await', prune)
  const readSnapshot = guard.indexOf('read_stash_snapshot(&repo_root).await', repoGuard)
  assert.ok(operationAuthority >= 0)
  assert.ok(prune > operationAuthority)
  assert.ok(repoGuard > prune)
  assert.ok(readSnapshot > repoGuard)
})

test('internal operation-result snapshots cannot erase the current idempotency journal', () => {
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const journal = read('../src-tauri/src/stash/journal.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')
  const acknowledge = read('../src-tauri/src/stash/acknowledge_guard.rs')

  assert.match(snapshot, /Snapshot projection is intentionally read-only/)
  assert.match(snapshot, /collect_unresolved_stash_authorities\(repo_root\)/)
  for (const source of [journal, selected, reconcile, acknowledge]) {
    assert.match(source, /read_stash_snapshot\(/)
  }
  assert.doesNotMatch(`${journal}\n${selected}\n${reconcile}\n${acknowledge}`, /prune_settled_stash_journals/)
})

test('explicit request admission protects its own journal while still scanning other evidence', () => {
  const retention = read('../src-tauri/src/stash/retention.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const sources = [
    read('../src-tauri/src/stash/create_guard.rs'),
    read('../src-tauri/src/stash/restore_guard.rs'),
    read('../src-tauri/src/stash/drop_guard.rs'),
    read('../src-tauri/src/stash/selected_create_guard.rs'),
    read('../src-tauri/src/stash/reconcile.rs'),
    read('../src-tauri/src/stash/acknowledge_guard.rs'),
  ]

  assert.match(retention, /async fn prune_settled_stash_journals_except/)
  assert.equal(
    (retention.match(/protected_request_id == Some\(journal\.request_id\.as_str\(\)\)/g) || []).length,
    2,
  )
  assert.match(authority, /async fn ensure_stash_evidence_readable_for_request/)
  assert.match(authority, /unresolved_stash_authorities_protecting\(repo_root, Some\(request_id\)\)/)
  for (const source of sources) {
    assert.match(source, /ensure_stash_evidence_readable_for_request\(&repo_root, &request_id\)\.await\?/)
  }
})

test('cleanup removes journal siblings but retains unreadable evidence', () => {
  const source = read('../src-tauri/src/stash/retention.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.match(source, /remove_journal_family/)
  assert.match(source, /journal_sibling_path\(path, "bak"\)/)
  assert.match(source, /journal_sibling_path\(path, "tmp"\)/)
  assert.match(source, /let Ok\(Some\(journal\)\) = load_stash_journal\(&path\) else/)
  assert.match(source, /load_selected_stash_journal_authoritative/)
  assert.match(authority, /操作记录损坏，不能盲目重试/)
})
