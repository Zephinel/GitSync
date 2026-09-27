import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  normalizeStashOperationResult,
  stashResultTone,
} from './stashViewModel.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('unknown and explicit confirmation statuses fail closed', () => {
  const unknown = normalizeStashOperationResult({ status: 'success-ish' })
  assert.equal(unknown.status, 'needs_confirmation')
  assert.equal(unknown.needsConfirmation, true)
  assert.equal(stashResultTone(unknown.status), 'unknown')

  const explicit = normalizeStashOperationResult({
    status: 'needs_confirmation',
    needs_confirmation: false,
  })
  assert.equal(explicit.status, 'needs_confirmation')
  assert.equal(explicit.needsConfirmation, true)
})

test('terminal success cannot coexist with a confirmation or snapshot-error axis', () => {
  const complete = normalizeStashOperationResult({
    status: 'complete',
    needs_confirmation: true,
  })
  assert.equal(complete.status, 'needs_confirmation')
  assert.equal(complete.needsConfirmation, true)

  const acknowledged = normalizeStashOperationResult({
    status: 'acknowledged',
    needs_confirmation: false,
    snapshot_error: 'snapshot unavailable',
    mutated: true,
  })
  assert.equal(acknowledged.status, 'needs_confirmation')
  assert.equal(acknowledged.needsConfirmation, true)
  assert.equal(acknowledged.mutated, true)
  assert.equal(acknowledged.snapshotError, 'snapshot unavailable')
})

test('known terminal statuses preserve their explicit success axis only when fully confirmed', () => {
  const complete = normalizeStashOperationResult({
    status: 'complete',
    needs_confirmation: false,
  })
  assert.equal(complete.status, 'complete')
  assert.equal(complete.needsConfirmation, false)

  const acknowledged = normalizeStashOperationResult({
    status: 'acknowledged',
    needs_confirmation: false,
    mutated: true,
  })
  assert.equal(acknowledged.status, 'acknowledged')
  assert.equal(acknowledged.needsConfirmation, false)
  assert.equal(acknowledged.mutated, true)
})

test('mutation and recovery axes are never inferred away by normalization', () => {
  const result = normalizeStashOperationResult({
    operation: 'pop',
    request_id: 'request-1',
    status: 'partial',
    mutated: true,
    worktree_changed: true,
    applied: true,
    dropped: false,
    stash_retained: true,
  })

  assert.equal(result.operation, 'pop')
  assert.equal(result.requestId, 'request-1')
  assert.equal(result.mutated, true)
  assert.equal(result.worktreeChanged, true)
  assert.equal(result.applied, true)
  assert.equal(result.dropped, false)
  assert.equal(result.stashRetained, true)
})

test('backend operation projection downgrades contradictory terminal statuses too', () => {
  const source = read('../src-tauri/src/stash/journal.rs')
  assert.match(source, /let needs_confirmation = stored\.needs_confirmation \|\| snapshot_error\.is_some\(\)/)
  assert.match(source, /matches!\(stored\.status\.as_str\(\), "complete" \| "acknowledged"\)/)
  assert.match(source, /"needs_confirmation"\.to_string\(\)/)
})

test('authoritative result snapshots always re-project current pending evidence with bounded actionable visibility metadata', () => {
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const types = read('../src-tauri/src/stash/mod.rs')
  const create = read('../src-tauri/src/stash/create_guard.rs')
  const restore = read('../src-tauri/src/stash/restore_guard.rs')
  const drop = read('../src-tauri/src/stash/drop_guard.rs')
  const selected = read('../src-tauri/src/stash/selected_create_guard.rs')
  const acknowledge = read('../src-tauri/src/stash/acknowledge_guard.rs')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const pending = read('./stash-manager/StashPendingOperations.jsx')

  assert.match(types, /pub pending_operation_total: usize/)
  assert.match(types, /pub pending_operations_truncated: bool/)
  assert.match(snapshot, /fn order_pending_for_snapshot/)
  assert.match(snapshot, /Some\(origin\) if origin == current_origin => current\.push\(operation\)/)
  assert.match(snapshot, /None => legacy\.push\(operation\)/)
  assert.match(snapshot, /Some\(_\) => foreign\.push\(operation\)/)
  assert.match(snapshot, /current\.extend\(legacy\)/)
  assert.match(snapshot, /current\.extend\(foreign\)/)
  assert.match(snapshot, /fn apply_pending_projection/)
  assert.match(snapshot, /let total = unresolved\.len\(\)/)
  assert.match(snapshot, /snapshot\.pending_operation_total = total/)
  assert.match(snapshot, /snapshot\.pending_operations_truncated = total > operations\.len\(\)/)
  assert.match(snapshot, /snapshot\.pending_operations = operations/)
  assert.match(snapshot, /async fn project_pending_into_snapshot/)
  assert.match(snapshot, /async fn project_operation_result_snapshot/)
  assert.match(manager, /total=\{snapshot\?\.pendingOperationTotal \|\| 0\}/)
  assert.match(manager, /truncated=\{snapshot\?\.pendingOperationsTruncated === true\}/)
  assert.match(pending, /优先包含当前 worktree 可处理的操作/)

  for (const source of [create, restore, drop, selected]) {
    assert.match(source, /project_operation_result_snapshot/)
  }

  const staleCheck = acknowledge.indexOf('current.snapshot_id != expected_snapshot_id')
  const staleProjection = acknowledge.indexOf('project_operation_result_snapshot(&repo_root, result).await', staleCheck)
  assert.ok(staleCheck >= 0 && staleProjection > staleCheck)
})

test('pending-evidence projection failure preserves mutation facts instead of throwing the result away', () => {
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const start = snapshot.indexOf('async fn project_operation_result_snapshot')
  const end = snapshot.indexOf('async fn read_stash_snapshot', start)
  const body = snapshot.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(body, /match project_pending_into_snapshot\(repo_root, snapshot\.clone\(\)\)\.await/)
  assert.match(body, /result\.snapshot = Some\(snapshot\)/)
  assert.match(body, /result\.needs_confirmation = true/)
  assert.match(body, /result\.snapshot_error = Some\(message\.clone\(\)\)/)
  assert.match(body, /result\.warnings\.push\(message\)/)
  assert.doesNotMatch(body, /project_pending_into_snapshot\(repo_root, snapshot\)\.await\?/)
})
