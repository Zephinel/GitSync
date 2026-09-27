import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function assertFamilyGuardBeforeEvidence(source, family) {
  const authority = source.indexOf('let _authority = acquire_stash_operation_authority')
  const guard = source.indexOf(`StashJournalFamily::${family}`, authority)
  const evidence = source.indexOf('ensure_stash_evidence_readable', guard)
  assert.ok(authority >= 0, 'missing operation authority')
  assert.ok(guard > authority, `missing ${family} request-family guard after authority`)
  assert.ok(evidence > guard, 'request-family guard must run before evidence projection')
}

function assertProtectedEvidenceBeforeRepoGuard(source, entryMarker) {
  const entry = source.indexOf(entryMarker)
  const authority = source.indexOf('acquire_stash_operation_authority(&repo_root).await?', entry)
  const evidence = source.indexOf('ensure_stash_evidence_readable_for_request(&repo_root, &request_id).await?', authority)
  const repoGuard = source.indexOf('acquire_repo_git_guard(&state, &repo_root).await', evidence)
  assert.ok(entry >= 0, `missing entry ${entryMarker}`)
  assert.ok(authority > entry, 'missing operation authority in command body')
  assert.ok(evidence > authority, 'protected evidence scan must follow operation authority')
  assert.ok(repoGuard > evidence, 'repo Git guard must be acquired after protected evidence scan')
}

test('common-dir authority owns one request-id namespace across both journal families', () => {
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.match(authority, /enum StashJournalFamily/)
  assert.match(authority, /Regular,[\s\S]*Selected,/)
  assert.match(authority, /async fn stash_request_journal_family/)
  assert.match(authority, /let regular_exists = load_stash_journal/)
  assert.match(authority, /let selected_exists = load_selected_stash_journal_authoritative/)
  assert.match(authority, /\(true, true\) => Err/)
  assert.match(authority, /同时存在于普通和文件级操作记录/)
  assert.match(authority, /async fn ensure_stash_request_family/)
  assert.match(authority, /已由另一类操作记录占用/)
})

test('request-family lookup is read-only and cannot prune the exact request it is resolving', () => {
  const authority = read('../src-tauri/src/stash/operation_authority.rs')
  const start = authority.indexOf('async fn stash_request_journal_family')
  const end = authority.indexOf('async fn ensure_stash_request_family', start)
  const body = authority.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(body, /stash_journal_directory\(repo_root\)/)
  assert.match(body, /selected_stash_journal_directory\(repo_root\)/)
  assert.doesNotMatch(body, /stash_operation_path\(|selected_stash_operation_path\(/)
  assert.doesNotMatch(body, /prune_settled_stash_journals/)
})

test('all journal evidence claims one request-id namespace before terminal filtering', () => {
  const authority = read('../src-tauri/src/stash/operation_authority.rs')

  assert.match(authority, /fn claim_journal_request_id/)
  assert.match(authority, /操作证据存在重复请求 ID/)
  assert.equal(
    (authority.match(/claim_journal_request_id\(&mut request_ids, &journal\.request_id\)\?/g) || []).length,
    2,
  )
  const regularClaim = authority.indexOf('claim_journal_request_id(&mut request_ids, &journal.request_id)?')
  const regularTerminal = authority.indexOf('if !stash_result_is_terminal', regularClaim)
  const selectedDirectory = authority.indexOf('let selected_directory = selected_stash_journal_directory', regularClaim)
  const selectedClaim = authority.indexOf('claim_journal_request_id(&mut request_ids, &journal.request_id)?', selectedDirectory)
  const selectedTerminal = authority.indexOf('if !stash_result_is_terminal', selectedClaim)
  assert.ok(regularClaim >= 0 && regularTerminal > regularClaim)
  assert.ok(selectedClaim > selectedDirectory && selectedTerminal > selectedClaim)
})

test('every mutation wrapper declares its expected request journal family before evidence scanning', () => {
  const create = read('../src-tauri/src/stash/create_guard.rs')
  const restore = read('../src-tauri/src/stash/restore_guard.rs')
  const drop = read('../src-tauri/src/stash/drop_guard.rs')
  const selected = read('../src-tauri/src/stash/selected_create_guard.rs')

  assertFamilyGuardBeforeEvidence(create, 'Regular')
  assertFamilyGuardBeforeEvidence(restore, 'Regular')
  assertFamilyGuardBeforeEvidence(drop, 'Regular')
  assertFamilyGuardBeforeEvidence(selected, 'Selected')
})

test('explicit reconcile and acknowledgement scan protected evidence before taking the repo Git guard', () => {
  assertProtectedEvidenceBeforeRepoGuard(
    read('../src-tauri/src/stash/reconcile.rs'),
    'pub async fn reconcile_repo_stash_operation',
  )
  assertProtectedEvidenceBeforeRepoGuard(
    read('../src-tauri/src/stash/acknowledge_guard.rs'),
    'pub async fn acknowledge_repo_stash_operation',
  )
})

test('reconcile dispatches by resolved family and treats missing evidence as an explicit recovery policy', () => {
  const reconcile = read('../src-tauri/src/stash/reconcile.rs')
  const entry = reconcile.indexOf('pub async fn reconcile_repo_stash_operation')
  const resolve = reconcile.indexOf('stash_request_journal_family(&repo_root, &request_id).await?', entry)
  const familyMatch = reconcile.indexOf('match family', resolve)
  const regular = reconcile.indexOf('Some(StashJournalFamily::Regular)', familyMatch)
  const selected = reconcile.indexOf('Some(StashJournalFamily::Selected)', familyMatch)
  const missing = reconcile.indexOf('None => {', familyMatch)
  const expectedSnapshot = reconcile.indexOf('unchanged_since_request', missing)
  const nonStart = reconcile.indexOf('Git mutation 未开始', expectedSnapshot)
  const uncertain = reconcile.indexOf('无法证明仓库仍处于请求前状态', expectedSnapshot)

  assert.ok(entry >= 0 && resolve > entry && familyMatch > resolve)
  assert.ok(regular > familyMatch && selected > regular && missing > selected)
  assert.ok(expectedSnapshot > missing && nonStart > expectedSnapshot && uncertain > expectedSnapshot)
})

test('acknowledgement dispatches by resolved family while preserving legacy origin policy', () => {
  const acknowledge = read('../src-tauri/src/stash/acknowledge_guard.rs')
  const entry = acknowledge.indexOf('pub async fn acknowledge_repo_stash_operation')
  const resolve = acknowledge.indexOf('stash_request_journal_family(&repo_root, &request_id).await?', entry)
  const familyMatch = acknowledge.indexOf('match family', resolve)
  const regular = acknowledge.indexOf('Some(StashJournalFamily::Regular)', familyMatch)
  const selected = acknowledge.indexOf('Some(StashJournalFamily::Selected)', familyMatch)
  const missing = acknowledge.indexOf('None => Err', familyMatch)

  assert.ok(entry >= 0 && resolve > entry && familyMatch > resolve)
  assert.ok(regular > familyMatch && selected > regular && missing > selected)
  assert.equal(
    (acknowledge.match(/ensure_stash_journal_origin\(&journal\.origin_repo_root, &repo_root, true\)/g) || []).length,
    2,
  )
})
