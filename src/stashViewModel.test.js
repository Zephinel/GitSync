import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildCreateStashRequest,
  buildTargetStashRequest,
  canCreateStash,
  findStashEntry,
  normalizeStashDetail,
  normalizeStashFileDiff,
  normalizeStashOperationResult,
  normalizeStashPathTargets,
  normalizeStashSnapshot,
  selectedStashUnsupportedReason,
  stashCreateScopeLabel,
  stashKeepIndexAvailability,
  stashOperationLabel,
  stashResultTone,
} from './stashViewModel.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const oid = 'a'.repeat(40)

function snapshot(overrides = {}) {
  return normalizeStashSnapshot({
    repo_path: '/repo',
    branch: 'main',
    head_hash: 'b'.repeat(40),
    snapshot_id: 'snapshot-1',
    worktree_id: 'worktree-1',
    staged_files: 2,
    unstaged_files: 3,
    untracked_files: 1,
    can_create_default: true,
    can_create_with_untracked: true,
    stash_total: 1,
    stashes: [{
      id: oid,
      oid,
      selector: 'stash@{0}',
      ordinal: 0,
      message: 'save work',
      branch_context: 'main',
      created_at: '2026-08-02T00:00:00Z',
      base_commit: 'c'.repeat(40),
      base_summary: 'base',
      includes_untracked: false,
      scope_summary: '已跟踪修改（含暂存区快照）',
    }],
    ...overrides,
  })
}

test('normalizes stable identity separately from mutable selector', () => {
  const value = snapshot()
  assert.equal(value.stashes[0].id, oid)
  assert.equal(value.stashes[0].selector, 'stash@{0}')
  assert.equal(findStashEntry(value, oid)?.message, 'save work')
  assert.equal(findStashEntry(value, 'stash@{0}'), null)
})

test('normalizes bounded pending-operation projection without losing total authority', () => {
  const pending = Array.from({ length: 20 }, (_, index) => ({
    request_id: `request-${index}`,
    operation: 'create',
    status: 'needs_confirmation',
  }))
  const value = snapshot({
    pending_operation_total: 27,
    pending_operations_truncated: true,
    pending_operations: pending,
  })
  assert.equal(value.pendingOperations.length, 20)
  assert.equal(value.pendingOperationTotal, 27)
  assert.equal(value.pendingOperationsTruncated, true)

  const legacy = snapshot({ pending_operations: pending.slice(0, 2) })
  assert.equal(legacy.pendingOperationTotal, 2)
  assert.equal(legacy.pendingOperationsTruncated, false)

  const contradictory = snapshot({
    pending_operation_total: 1,
    pending_operations_truncated: false,
    pending_operations: pending.slice(0, 2),
  })
  assert.equal(contradictory.pendingOperationTotal, 2)
  assert.equal(contradictory.pendingOperationsTruncated, false)
})

test('normalizes selected staging identity for preflight explanations', () => {
  const [file] = normalizeStashPathTargets([{
    path: 'docs/old.md',
    index_code: 'D',
    worktree_code: ' ',
    staging_state: 'staged',
    has_staged_changes: true,
  }])
  assert.equal(file.indexCode, 'D')
  assert.equal(file.worktreeCode, ' ')
  assert.equal(file.stagingState, 'staged')
})

test('create eligibility derives selected scope without extra untracked consent', () => {
  assert.equal(canCreateStash(snapshot(), false), true)
  assert.equal(canCreateStash(snapshot({ can_create_default: false }), false), false)
  assert.equal(canCreateStash(snapshot({ can_create_default: false }), true), true)
  assert.equal(canCreateStash(snapshot({ conflicted_files: 1 }), true), false)
  assert.equal(canCreateStash(snapshot({ head_hash: null }), true), false)

  const selectedUntracked = [{ path: 'notes.txt', is_untracked: true, has_unstaged_changes: true }]
  assert.equal(canCreateStash(snapshot(), false, selectedUntracked, false), true)
  assert.equal(stashCreateScopeLabel(selectedUntracked), 'Stash 1 个文件')
  assert.equal(stashCreateScopeLabel([]), 'Stash 全部改动')
})

test('keep-index is available only when something remains outside the index', () => {
  const stagedOnly = [{
    path: 'staged.txt',
    index_code: 'M',
    has_staged_changes: true,
    has_unstaged_changes: false,
  }]
  const mixed = [{
    path: 'mixed.txt',
    index_code: 'M',
    worktree_code: 'M',
    has_staged_changes: true,
    has_unstaged_changes: true,
  }]

  const stagedOnlyAvailability = stashKeepIndexAvailability(snapshot(), stagedOnly, false)
  assert.equal(stagedOnlyAvailability.available, false)
  assert.match(stagedOnlyAvailability.reason, /只有已暂存改动/)
  assert.equal(canCreateStash(snapshot(), false, stagedOnly, true), false)

  assert.equal(stashKeepIndexAvailability(snapshot(), mixed, false).available, true)
  assert.equal(canCreateStash(snapshot(), false, mixed, true), true)

  const allStagedOnly = snapshot({ unstaged_files: 0, untracked_files: 1 })
  assert.equal(stashKeepIndexAvailability(allStagedOnly, [], false).available, false)
  assert.equal(stashKeepIndexAvailability(allStagedOnly, [], true).available, true)
})

test('selected staged deletion and rename are blocked before mutation', () => {
  const deletion = [{ path: 'docs/old.md', index_code: 'D', has_staged_changes: true }]
  const rename = [{ path: 'docs/new.md', old_path: 'docs/old.md', index_code: 'R', has_staged_changes: true }]

  assert.match(selectedStashUnsupportedReason(deletion), /已暂存删除/)
  assert.match(selectedStashUnsupportedReason(rename), /已暂存重命名或复制/)
  assert.equal(canCreateStash(snapshot(), false, deletion, false), false)
  assert.equal(canCreateStash(snapshot(), false, rename, false), false)
})

test('request builders bind every mutation to the visible snapshot', () => {
  const value = snapshot()
  assert.deepEqual(buildCreateStashRequest(value, {
    requestId: 'stash_1',
    message: '  work  ',
    includeUntracked: false,
    keepIndex: true,
    files: [{ path: 'notes.txt', is_untracked: true }],
  }), {
    requestId: 'stash_1',
    expectedSnapshotId: 'snapshot-1',
    message: 'work',
    includeUntracked: true,
    keepIndex: true,
    files: [{ path: 'notes.txt', oldPath: null }],
  })
  assert.deepEqual(buildTargetStashRequest(value, oid, 'pop_1'), {
    requestId: 'pop_1',
    expectedSnapshotId: 'snapshot-1',
    stashId: oid,
  })
})

test('normalizes complete detail and bounded file Diff contracts', () => {
  const detail = normalizeStashDetail({
    entry: snapshot().stashes[0],
    file_count: 2,
    additions: 12,
    deletions: 3,
    added_files: 1,
    modified_files: 1,
    files: [
      { path: 'src/a.rs', status: 'modified', additions: 10, deletions: 3 },
      { path: 'notes.txt', status: 'untracked', additions: 2, is_untracked: true },
    ],
  })
  assert.equal(detail.fileCount, 2)
  assert.equal(detail.files[1].isUntracked, true)

  const fileDiff = normalizeStashFileDiff({
    stash_id: oid,
    path: 'src/a.rs',
    status: 'modified',
    patch: '@@ -1 +1 @@',
    additions: 1,
    deletions: 1,
    too_large: true,
  })
  assert.equal(fileDiff.stashId, oid)
  assert.equal(fileDiff.patch, '@@ -1 +1 @@')
  assert.equal(fileDiff.tooLarge, true)
})

test('preserves Pop partial axes and nested authoritative snapshot', () => {
  const result = normalizeStashOperationResult({
    operation: 'pop',
    request_id: 'pop_1',
    status: 'partial',
    mutated: true,
    worktree_changed: true,
    target_stash_id: oid,
    applied: true,
    dropped: false,
    stash_retained: true,
    warnings: ['drop pending'],
    snapshot: {
      snapshot_id: 'snapshot-2',
      head_hash: 'b'.repeat(40),
      stashes: [{ id: oid, oid, selector: 'stash@{1}' }],
    },
  })

  assert.equal(result.status, 'partial')
  assert.equal(result.applied, true)
  assert.equal(result.dropped, false)
  assert.equal(result.stashRetained, true)
  assert.equal(result.snapshot.snapshotId, 'snapshot-2')
  assert.equal(result.snapshot.stashes[0].selector, 'stash@{1}')
})

test('unknown result statuses fail closed to needs confirmation', () => {
  const result = normalizeStashOperationResult({ status: 'success-ish' })
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.needsConfirmation, true)
  assert.equal(stashResultTone(result.status), 'unknown')
})

test('acknowledged results remain terminal without pretending a Git mutation happened', () => {
  const result = normalizeStashOperationResult({
    operation: 'create_selected',
    request_id: 'selected_1',
    status: 'acknowledged',
    mutated: true,
    worktree_changed: true,
    needs_confirmation: false,
    created_stash_id: oid,
    message: 'accepted current state',
  })
  assert.equal(result.status, 'acknowledged')
  assert.equal(result.needsConfirmation, false)
  assert.equal(result.mutated, true)
  assert.equal(result.createdStashId, oid)
  assert.equal(stashResultTone(result.status), 'warning')
})

test('acknowledgement is snapshot-bound, mutation-free, registered and terminal across both journals', () => {
  const lib = read('../src-tauri/src/lib.rs')
  const command = read('../src-tauri/src/stash/acknowledge_guard.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')
  const retention = read('../src-tauri/src/stash/retention.rs')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const pending = read('./stash-manager/StashPendingOperations.jsx')
  const operationClient = read('./stashOperationClient.js')

  assert.match(lib, /authoritative_acknowledge::acknowledge_repo_stash_operation/)
  assert.match(command, /expected_snapshot_id/)
  assert.match(command, /current\.snapshot_id != expected_snapshot_id/)
  assert.match(command, /acknowledged_stash_result/)
  assert.match(command, /没有执行任何 Git mutation/)
  assert.doesNotMatch(command, /run_git|run_git_output|stash push|stash apply|stash drop/)
  assert.match(authority, /stash_result_is_terminal[\s\S]*stash_result_is_durable_terminal\(value, completion_validated\)/)
  assert.match(reconcile, /"complete" \| "failed" \| "stale" \| "acknowledged"/)
  assert.match(retention, /is_terminal_stash_journal[\s\S]*stash_result_is_durable_terminal\(result, journal\.completion_validated\)/)
  assert.match(retention, /is_terminal_selected_stash_journal[\s\S]*stash_result_is_durable_terminal\(result, journal\.completion_validated\)/)
  assert.match(manager, /acknowledgeStashOperation/)
  assert.match(pending, /接受当前状态/)
  assert.match(manager, /snapshot\.snapshotId/)
  assert.match(operationClient, /acknowledge_repo_stash_operation/)
  assert.match(operationClient, /expectedSnapshotId/)
})

test('operation labels remain explicit about Pop deletion and acknowledgement semantics', () => {
  assert.equal(stashOperationLabel('create_selected'), '创建文件级 Stash')
  assert.equal(stashOperationLabel('apply'), '应用 Stash')
  assert.equal(stashOperationLabel('pop'), '应用并删除 Stash')
  assert.equal(stashOperationLabel('drop'), '删除 Stash')
  assert.equal(stashOperationLabel('acknowledge'), '接受当前 Stash 状态')
})
