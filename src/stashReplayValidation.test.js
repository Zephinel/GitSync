import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function assertReplayBeforeRaw(source, entryMarker, rawMarker) {
  const entry = source.indexOf(entryMarker)
  const replay = source.indexOf('reconcile_matching_stash_request(', entry)
  const raw = source.indexOf(rawMarker, replay)
  assert.ok(entry >= 0, `missing entry ${entryMarker}`)
  assert.ok(replay > entry, 'existing request reconciliation must run inside the authoritative entry')
  assert.ok(raw > replay, 'raw Git mutation must run only after exact request reconciliation')
}

test('every authoritative mutation resumes an existing request before raw execution', () => {
  const create = read('../src-tauri/src/stash/create_guard.rs')
  const restore = read('../src-tauri/src/stash/restore_guard.rs')
  const drop = read('../src-tauri/src/stash/drop_guard.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')

  assert.match(reconcile, /async fn reconcile_matching_stash_request/)
  assertReplayBeforeRaw(create, 'pub async fn create_repo_stash(', 'super::create_repo_stash(')
  assertReplayBeforeRaw(restore, 'async fn run(', 'super::apply_repo_stash(')
  assertReplayBeforeRaw(drop, 'pub async fn drop_repo_stash(', 'super::drop_repo_stash_internal(')
})

test('authoritative reconciliation revalidates every complete result before returning it', () => {
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')

  assert.match(reconcile, /validate_create_complete_result_under_guard/)
  assert.match(reconcile, /validate_selected_create_complete_result_under_guard/)
  assert.match(reconcile, /validate_restore_complete_result_under_guard/)
  assert.match(reconcile, /validate_drop_complete_result_under_guard/)
  assert.match(reconcile, /validate_reconciled_result_under_guard/)
})

test('create completion validators use internal all-Stash identity authority, never display projection membership', () => {
  const create = read('../src-tauri/src/stash/create_guard.rs')
  const selected = read('../src-tauri/src/stash/selected_create_guard.rs')

  for (const source of [create, selected]) {
    assert.match(source, /let actual = stash_ids\(snapshot\)/)
    assert.doesNotMatch(source, /let actual = snapshot[\s\S]*\.stashes[\s\S]*collect::<HashSet/)
  }
})

test('journal evidence identity is validated at every regular and selected load boundary', () => {
  const regular = read('../src-tauri/src/stash/journal.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.match(regular, /fn evidence_path_request_id/)
  assert.match(regular, /fn validate_stored_result_identity/)
  assert.match(regular, /result\.operation != expected_operation/)
  assert.match(regular, /result\.request_id != expected_request_id/)
  assert.match(regular, /result\.target_stash_id\.as_deref\(\) != expected_target_stash_id/)
  assert.match(regular, /fn validate_regular_stash_journal/)
  assert.match(regular, /validate_regular_stash_journal\(path, &journal\)\?/)
  assert.match(regular, /validate_before_stash_ids\(&journal\.before_stash_ids\)\?/)

  assert.match(selected, /fn validate_selected_stash_journal/)
  assert.match(selected, /evidence_path_request_id\(path\)\?/)
  assert.match(selected, /selected_file_targets\(&journal\.selected_files\)\?/)
  assert.match(selected, /selected_targets\.len\(\) != journal\.selected_files\.len\(\)/)
  assert.match(selected, /selected_targets != normalized_targets/)
  assert.match(selected, /validate_stored_result_identity\(result, "create_selected", &journal\.request_id, None\)\?/)
  assert.match(selected, /validate_selected_stash_journal\(path, &journal\)\?/)

  assert.match(authority, /fn parse_selected_stash_journal_authoritative/)
  assert.match(authority, /validate_selected_stash_journal\(path, &journal\)\?/)

  assert.doesNotMatch(regular, /read_pending_stash_operations/)
  assert.doesNotMatch(selected, /read_pending_selected_stash_operations/)
})

test('journal loaders validate persisted phase and operation-specific result semantics before terminality can be trusted', () => {
  const regular = read('../src-tauri/src/stash/journal.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const types = read('../src-tauri/src/stash/mod.rs')
  const validationTests = read('../src-tauri/src/stash/journal_validation_tests.rs')

  assert.match(regular, /fn stored_result_status_is_terminal/)
  assert.match(regular, /fn validate_stored_result_semantics/)
  assert.match(regular, /"complete" => match expected_operation/)
  assert.match(regular, /"failed" \| "stale"/)
  assert.match(regular, /"partial" =>/)
  assert.match(regular, /!result\.needs_confirmation && !result\.applied/)
  assert.match(regular, /"conflict" =>/)
  assert.match(regular, /fn regular_phase_is_valid/)
  assert.match(regular, /journal\.phase == "settled" && journal\.result\.is_none\(\)/)
  assert.match(regular, /terminal Stash result 只能存在于 settled journal/)
  assert.match(regular, /journal\.phase == "drop-prepared"[\s\S]*result\.status == "partial"/)

  assert.match(selected, /fn selected_phase_is_valid/)
  assert.match(selected, /"prepared" \| "executing" \| "command-returned" \| "settled"/)
  assert.match(selected, /journal\.phase == "settled" && journal\.result\.is_none\(\)/)
  assert.match(selected, /journal\.phase != "settled"[\s\S]*非 settled 文件级 Stash journal 不能持久化 result/)

  assert.match(types, /include!\("journal_validation_tests\.rs"\)/)
  assert.match(validationTests, /complete_results_require_operation_specific_axes/)
  assert.match(validationTests, /partial_pop_distinguishes_uncertain_from_confirmed_application/)
  assert.match(validationTests, /phase_contracts_allow_only_persisted_operation_states/)
  assert.match(validationTests, /backup_evidence_path_keeps_the_same_request_identity/)
})

test('durable completion proof releases automatic complete only before one public result projection', () => {
  const types = read('../src-tauri/src/stash/mod.rs')
  const regular = read('../src-tauri/src/stash/journal.rs')
  const selected = read('../src-tauri/src/stash/selected_create.rs')
  const finalizer = read('../src-tauri/src/stash/completion_finalizer.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const retention = read('../src-tauri/src/stash/retention.rs')
  const create = read('../src-tauri/src/stash/create_guard.rs')
  const selectedGuard = read('../src-tauri/src/stash/selected_create_guard.rs')
  const restore = read('../src-tauri/src/stash/restore_guard.rs')
  const drop = read('../src-tauri/src/stash/drop_guard.rs')
  const validationTests = read('../src-tauri/src/stash/journal_validation_tests.rs')

  assert.match(types, /#\[serde\(default\)\][\s\S]*completion_validated: bool/)
  assert.match(selected, /#\[serde\(default\)\][\s\S]*completion_validated: bool/)
  assert.match(regular, /fn stash_result_is_durable_terminal/)
  assert.match(regular, /"complete" => completion_validated/)
  assert.match(regular, /fn validate_completion_proof/)
  assert.match(regular, /fn persist_completion_validated/)
  assert.match(regular, /stored_completion_matches_public/)
  assert.match(regular, /completion_validated: false/)
  assert.match(selected, /completion_validated: false/)
  assert.match(authority, /stash_result_is_durable_terminal\(value, completion_validated\)/)
  assert.match(authority, /unvalidated_completion_projection/)
  assert.match(authority, /authoritative completion proof 尚未持久化/)
  assert.match(retention, /stash_result_is_durable_terminal\(result, journal\.completion_validated\)/)

  assert.match(finalizer, /persist_completion_validated\(repo_root, &result\)\.await/)
  assert.doesNotMatch(finalizer, /project_operation_result_snapshot|project_pending_into_snapshot/)

  const regularValidation = reconcile.indexOf('let result = validate_reconciled_result_under_guard(&repo_root, result).await?')
  const regularProjection = reconcile.indexOf('project_operation_result_snapshot(&repo_root, result).await', regularValidation)
  assert.ok(regularValidation >= 0 && regularProjection > regularValidation)
  assert.ok(
    (reconcile.match(/project_operation_result_snapshot\(&repo_root, result\)\.await/g) || []).length >= 3,
    'regular, selected, and no-evidence reconcile branches must project at the public boundary'
  )

  for (const source of [create, selectedGuard, restore, drop]) {
    assert.match(source, /completion_validated/)
    assert.match(source, /project_operation_result_snapshot/)
  }
  assert.match(validationTests, /complete_requires_durable_validation_before_terminal_release/)
  assert.match(validationTests, /completion_proof_is_only_valid_for_settled_complete_result/)
})

test('response-loss non-start recovery is a structured reconcile result, not localized error parsing', () => {
  const client = read('./stashOperationClient.js')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')

  assert.doesNotMatch(client, /NO_OPERATION_RECORD|includes\([^)]*找不到可确认的 Stash/)
  assert.match(client, /expectedOperation/)
  assert.match(client, /expectedSnapshotId/)
  assert.match(reconcile, /expected_operation: Option<String>/)
  assert.match(reconcile, /expected_target_stash_id: Option<String>/)
  assert.match(reconcile, /expected_snapshot_id: Option<String>/)
  assert.match(reconcile, /ensure_expected_reconcile_identity/)
  assert.match(reconcile, /unchanged_since_request/)
  assert.match(reconcile, /None => \{[\s\S]*"failed"[\s\S]*"needs_confirmation"/)
  assert.match(reconcile, /Git mutation 未开始/)
})

test('cached initial intent is consumed only after its stable Stash OID is found', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const lookup = manager.indexOf('const entry = findStashEntry(snapshot, initialStashId)')
  const guard = manager.indexOf('if (!entry) return', lookup)
  const consume = manager.indexOf('initialIntentConsumedRef.current = true', lookup)

  assert.ok(lookup >= 0 && guard > lookup && consume > guard)
})

test('invalidated detail flights cannot deliver superseded detail to consumers', () => {
  const repository = read('./stashDetailRepository.js')

  assert.match(repository, /class StashDetailSupersededError extends Error/)
  assert.match(repository, /invalidatedFlightTokens\.has\(token\)[\s\S]*throw new StashDetailSupersededError/)
  assert.match(repository, /detailFlights\.get\(key\)\?\.token !== token/)
})
