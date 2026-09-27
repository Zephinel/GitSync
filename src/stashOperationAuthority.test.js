import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function assertAuthorityBeforeMutation(source, mutationPattern) {
  const authorityPattern = /let _authority = acquire_stash_operation_authority/
  assert.match(source, authorityPattern)
  assert.match(source, /acquire_stash_operation_authority\(&repo_root\)\.await\?/)
  assert.match(source, /ensure_stash_evidence_readable/)
  assert.match(source, mutationPattern)
  assert.ok(
    source.search(authorityPattern) < source.search(mutationPattern),
    'operation authority must be acquired before entering the mutation implementation'
  )
}

function assertReconcileEntryAuthority(source) {
  const entry = source.indexOf('pub async fn reconcile_repo_stash_operation')
  const authority = source.indexOf('let _authority = acquire_stash_operation_authority', entry)
  const regular = source.indexOf('let result = reconcile_unresolved_stash_journal', authority)
  const selected = source.indexOf('reconcile_selected_stash_journal(', authority)
  assert.ok(entry >= 0, 'missing authoritative reconcile entry')
  assert.ok(authority > entry, 'reconcile must acquire operation authority inside its entry')
  assert.ok(regular > authority, 'regular journal reconciliation must run after authority')
  assert.ok(selected > authority, 'selected journal reconciliation must run after authority')
}

function assertReadAuthority(source, entryMarker, readMarker) {
  const entry = source.indexOf(entryMarker)
  const resolve = source.indexOf('let repo_root = resolve_repo_root(&repo_path).await?', entry)
  const authority = source.indexOf('let _authority = acquire_stash_operation_authority(&repo_root).await?', resolve)
  const repoGuard = source.indexOf('let _guard = acquire_repo_git_read_guard(&state, &repo_root).await', authority)
  const read = source.indexOf(readMarker, repoGuard)
  assert.ok(entry >= 0, `missing entry ${entryMarker}`)
  assert.ok(resolve > entry, 'Stash read must resolve repository root first')
  assert.ok(authority > resolve, 'Stash read must acquire common-dir authority after resolving root')
  assert.ok(repoGuard > authority, 'Stash read must take repo Git guard after common-dir authority')
  assert.ok(read > repoGuard, 'multi-command Stash read must execute only after both authorities')
}

test('repository operation authority combines common-dir process and OS locks with one bounded acquisition deadline', () => {
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.match(authority, /const STASH_OPERATION_AUTHORITY_WAIT_TIMEOUT_MS: u64 = GIT_STASH_OPERATION_TIMEOUT_MS \* 4/)
  assert.match(authority, /static STASH_OPERATION_LOCKS: std::sync::OnceLock/)
  assert.match(authority, /struct StashOperationAuthorityGuard/)
  assert.match(authority, /async fn stash_operation_authority_identity/)
  assert.match(authority, /resolve_git_common_dir\(repo_root\)\.await\?/)
  assert.match(authority, /fs::canonicalize\(&common_dir\)/)
  assert.match(authority, /stash-operation-authority\.lock/)
  assert.match(authority, /async fn acquire_cross_process_stash_lock/)
  assert.match(authority, /file\.try_lock\(\)/)
  assert.match(authority, /std::fs::TryLockError::WouldBlock/)
  assert.match(authority, /tokio::time::sleep/)
  assert.match(authority, /let acquisition = async \{[\s\S]*lock\.lock_owned\(\)\.await[\s\S]*acquire_cross_process_stash_lock\(&lock_path\)\.await\?/)
  assert.match(authority, /tokio::time::timeout\([\s\S]*STASH_OPERATION_AUTHORITY_WAIT_TIMEOUT_MS[\s\S]*acquisition/)
  assert.match(authority, /本次 Stash 请求未进入 Git 读写临界区/)
  assert.match(authority, /_process_guard: process_guard/)
  assert.match(authority, /_cross_process_file: cross_process_file/)
  assert.doesNotMatch(authority, /normalize_repo_lock_key\(repo_root\)/)
})

test('authority admission timeout has one machine-code and user-message projection owner', () => {
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const errorAuthority = read('./stashError.js')
  const client = read('./stashOperationClient.js')
  const snapshotState = read('./useStashSnapshotState.js')
  const detail = read('./StashDetailView.jsx')

  assert.match(authority, /const STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE: &str = "STASH_AUTHORITY_ADMISSION_TIMEOUT"/)
  assert.match(authority, /"\[\{\}\] 等待 Stash authority 超过 \{\} 秒/)
  assert.match(errorAuthority, /STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE = '\[STASH_AUTHORITY_ADMISSION_TIMEOUT\]'/)
  assert.match(errorAuthority, /startsWith\(STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE\)/)
  assert.match(errorAuthority, /export function stashErrorMessage/)
  assert.match(errorAuthority, /export function isStashAuthorityAdmissionTimeout/)

  assert.match(client, /isStashAuthorityAdmissionTimeout/)
  assert.match(client, /export \{ stashErrorMessage \} from '\.\/stashError\.js'/)
  assert.doesNotMatch(client, /const STASH_AUTHORITY_ADMISSION_TIMEOUT_CODE/)
  assert.doesNotMatch(client, /function rawStashErrorMessage/)

  assert.match(snapshotState, /import \{ stashErrorMessage \} from '\.\/stashError\.js'/)
  assert.match(snapshotState, /setError\(stashErrorMessage\(loadError\)\)/)
  assert.doesNotMatch(snapshotState, /function errorMessage/)

  assert.match(detail, /import \{ stashErrorMessage \} from '\.\/stashError\.js'/)
  assert.equal((detail.match(/stashErrorMessage\(loadError\)/g) || []).length, 2)
  assert.doesNotMatch(`${client}\n${snapshotState}\n${detail}`, /includes\([^)]*未进入 Git 读写临界区/)
})

test('repository operation authority serializes admission checks with every mutation', () => {
  const create = read('../src-tauri/src/stash/create_guard.rs')
  const selected = read('../src-tauri/src/stash/selected_create_guard.rs')
  const restore = read('../src-tauri/src/stash/restore_guard.rs')
  const drop = read('../src-tauri/src/stash/drop_guard.rs')
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')
  const acknowledge = read('../src-tauri/src/stash/acknowledge_guard.rs')

  assertAuthorityBeforeMutation(create, /super::create_repo_stash\(/)
  assertAuthorityBeforeMutation(selected, /super::create_repo_stash_selected\(/)
  assertAuthorityBeforeMutation(restore, /super::apply_repo_stash\(|super::pop_repo_stash\(/)
  assertAuthorityBeforeMutation(drop, /super::drop_repo_stash_internal\(/)
  assertReconcileEntryAuthority(reconcile)
  assert.match(acknowledge, /acquire_stash_operation_authority\(&repo_root\)\.await\?/)
})

test('multi-command Stash detail and file diff reads share mutation authority across processes', () => {
  const detail = read('../src-tauri/src/stash/stash_detail_guard.rs')
  const lib = read('../src-tauri/src/lib.rs')

  assertReadAuthority(detail, 'pub async fn get_repo_stash_detail', 'read_repo_stash_detail(&repo_root, &stash_id).await')
  assertReadAuthority(detail, 'pub async fn get_repo_stash_file_diff', 'read_repo_stash_file_diff(&repo_root, &stash_id, &path).await')
  assert.equal((lib.match(/stash::authoritative_detail::get_repo_stash_detail/g) || []).length, 1)
  assert.equal((lib.match(/stash::authoritative_detail::get_repo_stash_file_diff/g) || []).length, 1)
  assert.equal((lib.match(/\bstash::get_repo_stash_detail\b/g) || []).length, 0)
  assert.equal((lib.match(/\bstash::get_repo_stash_file_diff\b/g) || []).length, 0)
})

test('operation authority has one explicit safe follow-up policy for partial Pop cleanup', () => {
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const drop = read('../src-tauri/src/stash/drop_guard.rs')

  assert.match(authority, /fn is_safe_partial_pop_drop/)
  assert.match(authority, /pending\.operation == "pop"/)
  assert.match(authority, /pending\.status == "partial"/)
  assert.match(authority, /pending\.applied/)
  assert.match(authority, /!pending\.needs_confirmation/)
  assert.match(authority, /pending\.target_stash_id\.as_deref\(\) == proposed_target_stash_id/)
  assert.match(authority, /pending_origin_matches_repo\(pending, repo_root\)/)
  assert.match(drop, /ensure_stash_operation_policy/)
  assert.match(drop, /Some\(target_id\.as_str\(\)\)/)
})

test('public snapshot stays inside operation authority through retention and Git projection', () => {
  const snapshot = read('../src-tauri/src/stash/snapshot.rs')
  const guard = read('../src-tauri/src/stash/snapshot_guard.rs')
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.match(authority, /async fn collect_unresolved_stash_authorities/)
  assert.match(snapshot, /collect_unresolved_stash_authorities\(repo_root\)/)
  assert.match(snapshot, /project_pending_stash_operations/)
  assert.doesNotMatch(snapshot, /acquire_stash_operation_authority|prune_settled_stash_journals/)

  const operationAuthority = guard.indexOf('let _authority = acquire_stash_operation_authority(&repo_root).await?')
  const prune = guard.indexOf('let _ = prune_settled_stash_journals(&repo_root).await', operationAuthority)
  const repoGuard = guard.indexOf('let _guard = acquire_repo_git_read_guard(&state, &repo_root).await', prune)
  const readSnapshot = guard.indexOf('read_stash_snapshot(&repo_root).await', repoGuard)
  assert.ok(operationAuthority >= 0)
  assert.ok(prune > operationAuthority)
  assert.ok(repoGuard > prune)
  assert.ok(readSnapshot > repoGuard)
})

test('authoritative command wrappers are the only Tauri command owners for Stash operations', () => {
  const wrappers = [
    read('../src-tauri/src/stash/snapshot_guard.rs'),
    read('../src-tauri/src/stash/stash_detail_guard.rs'),
    read('../src-tauri/src/stash/create_guard.rs'),
    read('../src-tauri/src/stash/restore_guard.rs'),
    read('../src-tauri/src/stash/drop_guard.rs'),
    read('../src-tauri/src/stash/reconcile.rs'),
    read('../src-tauri/src/stash/acknowledge_guard.rs'),
    read('../src-tauri/src/stash/selected_create_guard.rs'),
  ]
  const rawCommands = read('../src-tauri/src/stash/commands.rs')
  const types = read('../src-tauri/src/stash/mod.rs')
  const lib = read('../src-tauri/src/lib.rs')
  const cargoLock = read('../src-tauri/Cargo.lock')

  for (const source of wrappers) {
    assert.doesNotMatch(source, /use super::\*/)
    assert.doesNotMatch(source, /tauri::command\(rename/)
  }
  assert.doesNotMatch(rawCommands, /#\[tauri::command\]/)
  assert.match(rawCommands, /pub async fn create_repo_stash\(/)
  assert.match(rawCommands, /pub async fn apply_repo_stash\(/)
  assert.match(rawCommands, /pub async fn pop_repo_stash\(/)
  assert.match(cargoLock, /name = "tauri"[\s\S]*version = "2\.11\.1"/)
  assert.match(types, /include!\("stash_detail_guard\.rs"\)/)
  assert.match(types, /include!\("acknowledge_guard\.rs"\)/)
  assert.equal((lib.match(/authoritative_snapshot::get_repo_stash_snapshot/g) || []).length, 1)
  assert.equal((lib.match(/authoritative_detail::get_repo_stash_detail/g) || []).length, 1)
  assert.equal((lib.match(/authoritative_detail::get_repo_stash_file_diff/g) || []).length, 1)
  assert.equal((lib.match(/authoritative_create::create_repo_stash/g) || []).length, 1)
  assert.equal((lib.match(/authoritative_restore::apply_repo_stash/g) || []).length, 1)
  assert.equal((lib.match(/authoritative_restore::pop_repo_stash/g) || []).length, 1)
  assert.equal((lib.match(/authoritative_acknowledge::acknowledge_repo_stash_operation/g) || []).length, 1)
})

test('GitSync process ownership uses the first-registered single-instance plugin and reactivates the main window', () => {
  const lib = read('../src-tauri/src/lib.rs')
  const cargo = read('../src-tauri/Cargo.toml')

  assert.match(cargo, /tauri-plugin-single-instance = "2"/)
  assert.doesNotMatch(lib, /mod single_instance;|single_instance::acquire|app\.handle\(\)\.exit\(0\)/)
  assert.match(lib, /tauri_plugin_single_instance::init\(\|app, _args, _cwd\|/)
  assert.match(lib, /app\.get_webview_window\("main"\)/)
  assert.match(lib, /window\.show\(\)/)
  assert.match(lib, /window\.unminimize\(\)/)
  assert.match(lib, /window\.set_focus\(\)/)

  const builder = lib.indexOf('let builder = tauri::Builder::default()')
  const singleInstance = lib.indexOf('tauri_plugin_single_instance::init', builder)
  const opener = lib.indexOf('.plugin(tauri_plugin_opener::init())', singleInstance)
  const manageState = lib.indexOf('.manage(state)', opener)
  const setup = lib.indexOf('.setup(|app|', manageState)
  const stateInit = lib.indexOf('state.init(app_data_dir.clone())', setup)
  const windowState = lib.indexOf('window_state::setup_main_window_state(app, &app_data_dir)', stateInit)

  assert.ok(builder >= 0)
  assert.ok(singleInstance > builder, 'single-instance plugin must be registered first')
  assert.ok(opener > singleInstance, 'other plugins must register after single-instance')
  assert.ok(manageState > opener)
  assert.ok(setup > manageState)
  assert.ok(stateInit > setup)
  assert.ok(windowState > stateInit)
  assert.throws(() => read('../src-tauri/src/single_instance.rs'))
})
