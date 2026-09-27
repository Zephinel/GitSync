import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createStashOperationClient } from './stashOperationClient.js'
import { pendingStashOperationPermissions } from './stashPendingOperation.js'
import { normalizeStashSnapshot } from './stashViewModel.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('both journal families persist the origin worktree and project it to pending operations', () => {
  const types = read('../src-tauri/src/stash/mod.rs')
  const journal = read('../src-tauri/src/stash/journal.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.match(types, /struct StashOperationJournal[\s\S]*origin_repo_root: String/)
  assert.match(types, /struct PendingStashOperation[\s\S]*origin_repo_path: Option<String>/)
  assert.match(selected, /struct SelectedStashOperationJournal[\s\S]*origin_repo_root: String/)
  assert.match(journal, /origin_repo_root: stash_worktree_origin\(&snapshot\.repo_path\)/)
  assert.match(selected, /origin_repo_root: stash_worktree_origin\(&repo_root\)/)
  assert.match(authority, /origin_repo_path: journal_origin_projection\(&journal\.origin_repo_root\)/)
  assert.match(authority, /origin_repo_path: operation\.origin_repo_path/)
})

test('automatic replay and reconciliation require the same origin worktree', () => {
  const journal = read('../src-tauri/src/stash/journal.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const selectedGuard = read('../src-tauri/src/stash/selected_create_guard.rs')

  assert.match(journal, /fn ensure_stash_journal_origin/)
  assert.match(journal, /旧 Stash 操作记录缺少来源 worktree 身份，不能自动对账/)
  assert.match(journal, /该 Stash 操作属于另一个 worktree/)
  assert.match(reconcile, /reconcile_matching_stash_request[\s\S]*ensure_stash_journal_origin\(&journal\.origin_repo_root, repo_root, false\)/)
  assert.match(reconcile, /reconcile_unresolved_stash_journal[\s\S]*ensure_stash_journal_origin\(&journal\.origin_repo_root, repo_root, false\)/)
  assert.match(reconcile, /load_selected_stash_journal_authoritative[\s\S]*ensure_stash_journal_origin\(&journal\.origin_repo_root, &repo_root, false\)/)
  assert.match(selected, /reconcile_selected_stash_journal[\s\S]*ensure_stash_journal_origin\(&journal\.origin_repo_root, repo_root, false\)/)
  assert.match(selectedGuard, /load_selected_stash_journal_authoritative[\s\S]*ensure_stash_journal_origin\(&journal\.origin_repo_root, &repo_root, false\)/)
})

test('acknowledgement is same-worktree except for explicit legacy migration', () => {
  const acknowledge = read('../src-tauri/src/stash/acknowledge_guard.rs')

  assert.equal(
    (acknowledge.match(/ensure_stash_journal_origin\(&journal\.origin_repo_root, &repo_root, true\)/g) || []).length,
    2
  )
  assert.match(acknowledge, /Legacy journals without an origin can only leave the system through[\s\S]*explicit user acknowledgement/)
})

test('pending operation permissions distinguish current, foreign and legacy worktrees', () => {
  const current = pendingStashOperationPermissions({
    originRepoPath: '/repo/worktree-a',
  }, '/repo/worktree-a/')
  assert.deepEqual(current, {
    originKnown: true,
    belongsToCurrent: true,
    canReconcile: true,
    canAcknowledge: true,
    reason: '',
  })

  const foreign = pendingStashOperationPermissions({
    originRepoPath: '/repo/worktree-b',
  }, '/repo/worktree-a')
  assert.equal(foreign.canReconcile, false)
  assert.equal(foreign.canAcknowledge, false)
  assert.match(foreign.reason, /另一个 worktree/)

  const legacy = pendingStashOperationPermissions({}, '/repo/worktree-a')
  assert.equal(legacy.originKnown, false)
  assert.equal(legacy.canReconcile, false)
  assert.equal(legacy.canAcknowledge, true)
  assert.match(legacy.reason, /升级前的旧操作记录/)
})

test('snapshot DTO normalization preserves pending origin identity directly', () => {
  const snapshot = normalizeStashSnapshot({
    repo_path: '/repo/worktree-a',
    snapshot_id: 'snapshot-1',
    worktree_id: 'worktree-1',
    head_hash: 'a'.repeat(40),
    stashes: [],
    pending_operations: [{
      request_id: 'request-1',
      operation: 'create',
      origin_repo_path: '/repo/worktree-a',
    }],
  })

  assert.equal(snapshot.pendingOperations[0].originRepoPath, '/repo/worktree-a')
})

test('operation client preserves pending origin identity through normalize, publish and return', async () => {
  let published = null
  const client = createStashOperationClient({
    invokeNative: async () => ({
      operation: 'create',
      request_id: 'request-1',
      status: 'complete',
      mutated: true,
      needs_confirmation: false,
      worktree_changed: true,
      snapshot: {
        repo_path: '/repo/worktree-a',
        snapshot_id: 'snapshot-after',
        worktree_id: 'worktree-after',
        head_hash: 'a'.repeat(40),
        stashes: [],
        pending_operations: [{
          request_id: 'pending-1',
          operation: 'create',
          target_stash_id: null,
          status: 'needs_confirmation',
          message: 'pending',
          updated_at_ms: 1,
          origin_repo_path: '/repo/worktree-a',
        }],
      },
    }),
    snapshotRepository: {
      beginMutation: (repoPath) => ({ repoPath }),
      releaseMutation: () => {},
      publishMutation: (_token, snapshot) => {
        published = snapshot
        return snapshot
      },
      read: async () => null,
    },
  })

  const result = await client.invokeMutation({
    repoPath: '/repo/worktree-a',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'request-1',
    request: { requestId: 'request-1' },
  })

  assert.equal(published.pendingOperations[0].originRepoPath, '/repo/worktree-a')
  assert.equal(result.snapshot.pendingOperations[0].originRepoPath, '/repo/worktree-a')
})

test('Manager delegates pending action visibility to the origin permission component', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const pending = read('./stash-manager/StashPendingOperations.jsx')
  const repository = read('./stashSnapshotRepository.js')
  const client = read('./stashOperationClient.js')
  const viewModel = read('./stashViewModel.js')

  assert.match(manager, /<StashPendingOperations/)
  assert.match(manager, /currentRepoPath=\{snapshot\?\.repoPath \|\| repoPath\}/)
  assert.doesNotMatch(manager, /snapshot\.pendingOperations\.map/)
  assert.match(pending, /pendingStashOperationPermissions\(operation, currentRepoPath\)/)
  assert.match(pending, /\.canReconcile/)
  assert.match(pending, /\.canAcknowledge/)
  assert.match(pending, /pendingOperationOriginLabel/)
  assert.match(viewModel, /originRepoPath: text\(field\(input, 'originRepoPath', 'origin_repo_path'\)\) \|\| null/)
  assert.doesNotMatch(`${repository}\n${client}`, /enrichStashPendingOrigins/)
})
