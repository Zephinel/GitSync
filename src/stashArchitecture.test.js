import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const backend = () => [
  '../src-tauri/src/stash/mod.rs',
  '../src-tauri/src/stash/git.rs',
  '../src-tauri/src/stash/git_stream.rs',
  '../src-tauri/src/stash/snapshot_stream.rs',
  '../src-tauri/src/stash/snapshot.rs',
  '../src-tauri/src/stash/selected_scope.rs',
  '../src-tauri/src/stash/selected_scope_budget.rs',
  '../src-tauri/src/stash/stash_detail_stream.rs',
  '../src-tauri/src/stash/stash_detail.rs',
  '../src-tauri/src/stash/journal.rs',
  '../src-tauri/src/stash/selected_create.rs',
  '../src-tauri/src/stash/operation_authority.rs',
  '../src-tauri/src/stash/reconcile.rs',
  '../src-tauri/src/stash/retention.rs',
  '../src-tauri/src/stash/commands.rs',
  '../src-tauri/src/stash/snapshot_guard.rs',
  '../src-tauri/src/stash/stash_detail_guard.rs',
  '../src-tauri/src/stash/create_guard.rs',
  '../src-tauri/src/stash/restore_guard.rs',
  '../src-tauri/src/stash/drop_guard.rs',
  '../src-tauri/src/stash/selected_create_guard.rs',
  '../src-tauri/src/stash/acknowledge_guard.rs',
].map(read).join('\n')

const authoritativeCommands = [
  'stash::authoritative_snapshot::get_repo_stash_snapshot',
  'stash::authoritative_detail::get_repo_stash_detail',
  'stash::authoritative_detail::get_repo_stash_file_diff',
  'stash::authoritative_create::create_repo_stash',
  'stash::authoritative_selected_create::create_repo_stash_selected_authoritative',
  'stash::authoritative_restore::apply_repo_stash',
  'stash::authoritative_restore::pop_repo_stash',
  'stash::authoritative_drop::drop_repo_stash',
  'stash::authoritative_reconcile::reconcile_repo_stash_operation',
  'stash::authoritative_acknowledge::acknowledge_repo_stash_operation',
]

function assertCreateJournalBeforeGit(source, {
  entryMarker,
  journalMarker,
  gitMarker,
}) {
  const entry = source.indexOf(entryMarker)
  const journal = source.indexOf(journalMarker, entry)
  const git = source.indexOf(gitMarker, journal)
  assert.ok(entry >= 0, `missing entry ${entryMarker}`)
  assert.ok(journal > entry, 'journal must be persisted after entering the create implementation')
  assert.ok(git > journal, 'Git mutation must start only after request evidence is durable')
}

test('registers exactly one authoritative Stash command surface', () => {
  const lib = read('../src-tauri/src/lib.rs')

  assert.equal(lib.includes('mod stash;'), true)
  for (const command of authoritativeCommands) {
    assert.equal(lib.includes(command), true, `missing command ${command}`)
    assert.equal(lib.split(command).length - 1, 1, `duplicate command ${command}`)
  }

  for (const rawCommand of [
    'stash::get_repo_stash_snapshot,',
    'stash::get_repo_stash_detail,',
    'stash::get_repo_stash_file_diff,',
    'stash::create_repo_stash,',
    'stash::apply_repo_stash,',
    'stash::pop_repo_stash,',
    'stash::drop_repo_stash,',
    'stash::reconcile_repo_selected_stash_operation,',
    'stash::create_repo_stash_selected,',
  ]) {
    assert.equal(lib.includes(rawCommand), false, `raw command registered: ${rawCommand}`)
  }
})

test('all mutations and pending evidence pass through common-dir operation authority', () => {
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const snapshotGuard = read('../src-tauri/src/stash/snapshot_guard.rs')
  const guards = [
    read('../src-tauri/src/stash/create_guard.rs'),
    read('../src-tauri/src/stash/selected_create_guard.rs'),
    read('../src-tauri/src/stash/restore_guard.rs'),
    read('../src-tauri/src/stash/drop_guard.rs'),
    read('../src-tauri/src/stash/reconcile.rs'),
    read('../src-tauri/src/stash/acknowledge_guard.rs'),
  ]

  for (const marker of [
    'stash_operation_authority_identity',
    'resolve_git_common_dir(repo_root).await?',
    'collect_unresolved_stash_authorities',
    'unresolved_stash_authorities_protecting',
    'ensure_stash_operation_policy',
    'project_pending_stash_operations',
    'origin_repo_path',
    'std::sync::Weak<AsyncMutex',
  ]) {
    assert.equal(authority.includes(marker), true, `missing authority marker ${marker}`)
  }
  assert.equal(snapshot.includes('collect_unresolved_stash_authorities(repo_root)'), true)
  assert.equal(snapshot.includes('let ordered = order_pending_for_snapshot(&snapshot.repo_path, unresolved)'), true)
  assert.equal(snapshot.includes('let operations = project_pending_stash_operations(ordered)'), true)
  assert.equal(snapshot.includes('snapshot.pending_operations = operations'), true)
  assert.equal(snapshot.includes('prune_settled_stash_journals'), false)
  assert.equal(snapshotGuard.includes('let _ = prune_settled_stash_journals(&repo_root).await'), true)
  for (const guard of guards) {
    assert.equal(guard.includes('acquire_stash_operation_authority(&repo_root).await?'), true)
    assert.equal(guard.includes('ensure_stash_evidence_readable_for_request'), true)
  }
})

test('guarded mutation names cannot collide with raw implementations', () => {
  const commands = read('../src-tauri/src/stash/commands.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const selectedGuard = read('../src-tauri/src/stash/selected_create_guard.rs')
  const createGuard = read('../src-tauri/src/stash/create_guard.rs')
  const restoreGuard = read('../src-tauri/src/stash/restore_guard.rs')
  const dropGuard = read('../src-tauri/src/stash/drop_guard.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')

  assert.equal(commands.includes('pub(crate) async fn drop_repo_stash_internal'), true)
  assert.equal(createGuard.includes('pub mod authoritative_create'), true)
  assert.equal(createGuard.includes('super::create_repo_stash'), true)
  assert.equal(restoreGuard.includes('pub mod authoritative_restore'), true)
  assert.equal(restoreGuard.includes('super::apply_repo_stash'), true)
  assert.equal(restoreGuard.includes('super::pop_repo_stash'), true)
  assert.equal(dropGuard.includes('pub mod authoritative_drop'), true)
  assert.equal(dropGuard.includes('super::drop_repo_stash_internal'), true)
  assert.equal(reconcile.includes('pub mod authoritative_reconcile'), true)
  assert.equal(selected.includes('pub(crate) async fn create_repo_stash_selected'), true)
  assert.equal(selectedGuard.includes('pub async fn create_repo_stash_selected_authoritative'), true)
  assert.equal(selectedGuard.includes('use super::*'), false)
})

test('uses immutable Stash OIDs as identity and selectors only for exact deletion', () => {
  const types = read('../src-tauri/src/stash/mod.rs')
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const stream = read('../src-tauri/src/stash/snapshot_stream.rs')
  const commands = read('../src-tauri/src/stash/commands.rs')

  assert.equal(types.includes('pub id: String'), true)
  assert.equal(types.includes('pub oid: String'), true)
  assert.equal(types.includes('pub selector: String'), true)
  assert.equal(stream.includes('id: oid.clone()'), true)
  assert.equal(snapshot.includes('entry.id == stash_id'), true)
  assert.equal(stream.includes('--format=%gd%x00%H%x00%cI%x00%gs%x00%P'), true)
  assert.equal(commands.includes('target.oid.as_str()'), true)
  assert.equal(commands.includes('target_after_apply.selector.as_str()'), true)
  assert.equal(commands.includes('["stash", "pop"'), false)
})

test('returns the complete Stash list while bounding only base-summary enrichment', () => {
  const types = read('../src-tauri/src/stash/mod.rs')
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const stream = read('../src-tauri/src/stash/snapshot_stream.rs')

  assert.equal(types.includes('GIT_STASH_BASE_SUMMARY_LIMIT: usize = 100'), true)
  assert.equal(snapshot.includes('.take(GIT_STASH_BASE_SUMMARY_LIMIT)'), true)
  assert.equal(snapshot.includes('let mut display_stashes = all_stashes.clone()'), true)
  assert.equal(snapshot.includes('stashes_truncated: false'), true)
  assert.equal(snapshot.includes('all_stashes,'), true)
  assert.equal(stream.includes('entries.push(parse_stash_list_record(&record)?)'), true)
})

test('persists request identity before mutation and reconciles duplicate IDs without replay', () => {
  const commands = read('../src-tauri/src/stash/commands.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')

  assertCreateJournalBeforeGit(commands, {
    entryMarker: 'pub async fn create_repo_stash(',
    journalMarker: 'persist_stash_journal(&journal_path, &mut journal)?',
    gitMarker: 'run_recorded_stash_step(',
  })
  assertCreateJournalBeforeGit(selected, {
    entryMarker: 'pub(crate) async fn create_repo_stash_selected(',
    journalMarker: 'persist_selected_stash_journal(&journal_path, &mut journal)?',
    gitMarker: 'run_git_mutation_output(&repo_root, &args, GIT_STASH_OPERATION_TIMEOUT_MS)',
  })
  assert.equal(reconcile.includes('reconcile_matching_stash_request'), true)
  assert.equal(reconcile.includes('journal.signature != *signature'), true)
  assert.equal(reconcile.includes('ensure_stash_journal_origin'), true)
})

test('create completion requires command evidence, stable OID and exact list identity', () => {
  const create = read('../src-tauri/src/stash/create_guard.rs')
  const selected = read('../src-tauri/src/stash/selected_create_guard.rs')

  for (const source of [create, selected]) {
    assert.equal(source.includes('command_success'), true)
    assert.equal(source.includes('created_stash_id'), true)
    assert.equal(source.includes('before_stash_ids'), true)
    assert.equal(source.includes('needs_confirmation'), true)
  }
  assert.equal(create.includes('actual != expected'), true)
  assert.equal(selected.includes('actual != expected'), true)
})

test('keeps create defaults conservative and never includes ignored files implicitly', () => {
  const commands = read('../src-tauri/src/stash/commands.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const source = `${commands}\n${selected}`

  assert.equal(commands.includes('--include-untracked'), true)
  assert.equal(commands.includes('--keep-index'), true)
  assert.equal(commands.includes('当前只有未跟踪文件；请明确开启'), true)
  assert.equal(commands.includes('当前范围没有可保存的修改，不会创建空 Stash'), true)
  assert.equal(source.includes('--include-ignored'), false)
  assert.equal(source.includes('stash clear'), false)
})

test('persists confirmed Pop application before allowing exact deletion', () => {
  const commands = read('../src-tauri/src/stash/commands.rs')
  const journal = read('../src-tauri/src/stash/journal.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.equal(commands.includes('applied_result.status = "partial"'), true)
  assert.equal(commands.includes('journal.phase = "drop-prepared"'), true)
  assert.equal(commands.includes('journal.result = Some(applied_result.clone())'), true)
  assert.equal(commands.includes('为避免重复恢复，本次不会执行删除'), true)
  assert.equal(journal.includes('fn recorded_pop_result'), true)
  assert.equal(journal.includes('不会再次 Apply'), true)
  assert.equal(authority.includes('fn is_safe_partial_pop_drop'), true)
})

test('keeps Apply, Drop, conflict and uncertainty as separate result axes', () => {
  const types = read('../src-tauri/src/stash/mod.rs')
  const commands = read('../src-tauri/src/stash/commands.rs')
  const dropGuard = read('../src-tauri/src/stash/drop_guard.rs')

  for (const marker of [
    'pub applied: bool',
    'pub dropped: bool',
    'pub stash_retained: bool',
    'pub needs_confirmation: bool',
  ]) {
    assert.equal(types.includes(marker), true)
  }
  assert.equal(commands.includes('result.status = "conflict"'), true)
  assert.equal(commands.includes('result.status = "partial"'), true)
  assert.equal(commands.includes('result.status = "needs_confirmation"'), true)
  assert.equal(dropGuard.includes('Drop 本身不应修改工作区'), true)
})

test('shares repository serialization and hides Git children on Windows', () => {
  const source = backend()
  const gitCommand = read('../src-tauri/src/git_command.rs')
  const lockAuthority = read('../src-tauri/src/repo_git_lock.rs')

  // The lock map itself moved into the single lock authority; stash delegates to it.
  assert.equal(lockAuthority.includes('state.git_repo_locks'), true)
  assert.equal(source.includes('crate::repo_git_lock::acquire'), true)
  assert.equal(source.includes('resolve_repo_root'), true)
  assert.equal(source.includes('crate::git_command::new_read_only_async_command'), true)
  assert.equal(gitCommand.includes('std::os::windows::process::CommandExt'), true)
  assert.equal(gitCommand.includes('const CREATE_NO_WINDOW: u32 = 0x08000000'), true)
  assert.equal(gitCommand.includes('command.creation_flags(CREATE_NO_WINDOW)'), true)
  assert.equal(gitCommand.includes('GIT_TERMINAL_PROMPT'), true)
  assert.equal(gitCommand.includes('GCM_INTERACTIVE'), true)
  assert.equal(source.includes('.kill_on_drop(true)'), true)
})

test('contains no implicit branch switch, commit, push, cleanup or ignored-file Stash behavior', () => {
  const source = backend()

  for (const forbidden of [
    '["switch"',
    '["checkout"',
    '["commit"',
    '["push"',
    '["clean"',
    'stash clear',
    '--include-ignored',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden behavior ${forbidden}`)
  }
})
