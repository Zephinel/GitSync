import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStagingTargets,
  buildWorkingChangeTargets,
  buildWorkingChangesViewModel,
  canRunStagingOperation,
  describeStagingOperationResult,
  getStagingStateDescription,
  getStagingStateLabel,
  hasExecutableStagingAuthority,
  logicalFileKey,
  selectStagingCandidates,
  stagingEntryIdentity,
} from './stagingViewModel.js'

function stagingFile(overrides = {}) {
  return {
    id: 'authority:src/a.rs:A',
    path: 'src/a.rs',
    old_path: null,
    status: 'modified',
    index_code: ' ',
    worktree_code: 'M',
    staging_state: 'unstaged',
    has_staged_changes: false,
    has_unstaged_changes: true,
    is_untracked: false,
    is_conflicted: false,
    can_stage: true,
    can_unstage: false,
    ...overrides,
  }
}

function workingFile(file, overrides = {}) {
  return {
    id: file.id,
    path: file.path,
    old_path: file.old_path ?? null,
    status: file.status,
    index_code: file.index_code,
    worktree_code: file.worktree_code,
    is_untracked: Boolean(file.is_untracked),
    is_conflicted: Boolean(file.is_conflicted),
    additions: 0,
    deletions: 0,
    is_binary: false,
    ...overrides,
  }
}

function snapshot(files, overrides = {}) {
  return {
    repo_path: '/repo',
    branch: 'main',
    detached_head: false,
    head_hash: 'abc',
    snapshot_id: 'staging-v1-test',
    files_changed: files.length,
    files_truncated: false,
    staged_files: files.filter((file) => file.has_staged_changes).length,
    unstaged_files: files.filter((file) => file.has_unstaged_changes).length,
    mixed_files: files.filter((file) => file.staging_state === 'mixed').length,
    untracked_files: files.filter((file) => file.is_untracked).length,
    conflicted_files: files.filter((file) => file.is_conflicted).length,
    files,
    ...overrides,
  }
}

test('uses exact status and mutation content authority to join staging with working diff metadata', () => {
  const unstaged = stagingFile()
  const staged = stagingFile({
    id: 'authority:src/b.rs:A',
    path: 'src/b.rs',
    index_code: 'M',
    worktree_code: ' ',
    staging_state: 'staged',
    has_staged_changes: true,
    has_unstaged_changes: false,
    can_stage: false,
    can_unstage: true,
  })
  const authority = snapshot([unstaged, staged])
  const working = {
    repo_path: '/repo',
    full_hash: 'abc',
    snapshot_id: 'working-v1-test',
    insertions: 8,
    deletions: 3,
    files: [
      workingFile(unstaged, { additions: 5, deletions: 1 }),
      workingFile(staged, { additions: 3, deletions: 2, is_binary: true }),
    ],
  }

  const model = buildWorkingChangesViewModel(working, authority)
  assert.equal(model.files.length, 2)
  assert.equal(model.files[0].staging_state, 'unstaged')
  assert.equal(model.files[0].additions, 5)
  assert.equal(model.files[1].staging_state, 'staged')
  assert.equal(model.files[1].is_binary, true)
  assert.equal(model.snapshot_id, 'staging-v1-test')
  assert.equal(model.working_snapshot_id, 'working-v1-test')
  assert.deepEqual(model.consistency, {
    is_consistent: true,
    head_matches: true,
    working_only_count: 0,
    staging_only_count: 0,
  })
  assert.equal(hasExecutableStagingAuthority(model), true)
})

test('blocks executable authority when reads disagree, content authority differs, either side is unmatched, or a working snapshot is unavailable', () => {
  const authority = snapshot([stagingFile()], { files_truncated: true })
  const model = buildWorkingChangesViewModel({ full_hash: 'different', files: [] }, authority)

  assert.equal(model.consistency.head_matches, false)
  assert.equal(model.consistency.staging_only_count, 1)
  assert.equal(model.consistency.is_consistent, false)
  assert.equal(model.working_snapshot_id, '')
  assert.equal(hasExecutableStagingAuthority(model), false)

  const mismatchedWorking = buildWorkingChangesViewModel({
    full_hash: 'abc',
    snapshot_id: 'working-v1-mismatch',
    files: [workingFile(stagingFile({ worktree_code: 'D' }))],
  }, snapshot([stagingFile()]))
  assert.equal(mismatchedWorking.consistency.working_only_count, 1)
  assert.equal(mismatchedWorking.consistency.staging_only_count, 1)
  assert.equal(mismatchedWorking.consistency.is_consistent, false)

  const sameStatus = stagingFile()
  const contentMismatch = buildWorkingChangesViewModel({
    full_hash: 'abc',
    snapshot_id: 'working-v1-content-mismatch',
    files: [workingFile(sameStatus, { id: 'authority:content:B' })],
  }, snapshot([sameStatus]))
  assert.equal(contentMismatch.consistency.working_only_count, 1)
  assert.equal(contentMismatch.consistency.staging_only_count, 1)
  assert.equal(contentMismatch.consistency.is_consistent, false)
  assert.equal(hasExecutableStagingAuthority(contentMismatch), false)
})

test('matches rename metadata by exact status and mutation authority', () => {
  const renamed = stagingFile({
    id: 'authority:rename:A',
    path: 'src/new.rs',
    old_path: 'src/old.rs',
    status: 'renamed',
    index_code: 'R',
    worktree_code: ' ',
    staging_state: 'staged',
    has_staged_changes: true,
    has_unstaged_changes: false,
    can_stage: false,
    can_unstage: true,
  })
  const model = buildWorkingChangesViewModel({
    full_hash: 'abc',
    snapshot_id: 'working-v1-rename',
    files: [workingFile(renamed, {
      additions: 4,
      deletions: 4,
    })],
  }, snapshot([renamed]))

  assert.equal(logicalFileKey(model.files[0]), 'src/old.rs\0src/new.rs')
  assert.equal(model.files[0].additions, 4)
  assert.equal(model.consistency.is_consistent, true)
})

test('assigns injective UI and mutation identities to same-path Git status entries without disabling Stage or Unstage', () => {
  const stagedDeletion = stagingFile({
    id: 'authority:deleted',
    path: 'same.txt',
    status: 'deleted',
    index_code: 'D',
    worktree_code: ' ',
    staging_state: 'staged',
    has_staged_changes: true,
    has_unstaged_changes: false,
    is_untracked: false,
    can_stage: false,
    can_unstage: true,
  })
  const untrackedReplacement = stagingFile({
    id: 'authority:untracked',
    path: 'same.txt',
    status: 'added',
    index_code: '?',
    worktree_code: '?',
    staging_state: 'untracked',
    has_staged_changes: false,
    has_unstaged_changes: true,
    is_untracked: true,
    can_stage: true,
    can_unstage: false,
  })
  const model = buildWorkingChangesViewModel(
    {
      repo_path: '/repo',
      full_hash: 'abc',
      snapshot_id: 'working-v1-same',
      files: [workingFile(stagedDeletion), workingFile(untrackedReplacement)],
    },
    snapshot([stagedDeletion, untrackedReplacement]),
  )

  assert.equal(model.files.length, 2)
  assert.notEqual(model.files[0].id, model.files[1].id)
  assert.equal(new Set(model.files.map((file) => file.id)).size, 2)
  assert.notEqual(model.files[0].authority_id, model.files[1].authority_id)
  assert.notEqual(stagingEntryIdentity(stagedDeletion), stagingEntryIdentity(untrackedReplacement))
  assert.deepEqual(model.consistency, {
    is_consistent: true,
    head_matches: true,
    working_only_count: 0,
    staging_only_count: 0,
  })
  assert.equal(selectStagingCandidates(model.files, 'unstage').length, 1)
  assert.equal(selectStagingCandidates(model.files, 'stage').length, 1)

  assert.deepEqual(buildWorkingChangeTargets([stagedDeletion, untrackedReplacement]), [
    {
      path: 'same.txt',
      oldPath: null,
      expectedIndexCode: 'D',
      expectedWorktreeCode: ' ',
      expectedIsUntracked: false,
      expectedAuthorityId: 'authority:deleted',
    },
    {
      path: 'same.txt',
      oldPath: null,
      expectedIndexCode: '?',
      expectedWorktreeCode: '?',
      expectedIsUntracked: true,
      expectedAuthorityId: 'authority:untracked',
    },
  ])
})

test('composite staging identity remains injective for legal colon path shapes', () => {
  const modifiedColonPath = stagingFile({
    id: 'authority:colon-modified',
    path: 'a:b',
    old_path: null,
    index_code: 'M',
    worktree_code: ' ',
    staging_state: 'staged',
    has_staged_changes: true,
    has_unstaged_changes: false,
    can_stage: false,
    can_unstage: true,
  })
  const renamedColonPath = stagingFile({
    id: 'authority:colon-rename',
    path: 'b',
    old_path: ':a',
    index_code: 'R',
    worktree_code: ' ',
    staging_state: 'staged',
    has_staged_changes: true,
    has_unstaged_changes: false,
    can_stage: false,
    can_unstage: true,
  })
  assert.notEqual(stagingEntryIdentity(modifiedColonPath), stagingEntryIdentity(renamedColonPath))
  assert.equal(buildStagingTargets([modifiedColonPath, renamedColonPath], 'unstage').length, 2)
  assert.equal(buildWorkingChangeTargets([modifiedColonPath, renamedColonPath]).length, 2)
})

test('preserves opaque Git path identities through working/staging projection and targets', () => {
  const paths = ['a\\b.txt', 'a/b.txt', ' file.txt', 'file.txt', 'tail.txt ']
  const authorityFiles = paths.map((path, index) => stagingFile({
    id: `authority:path:${index}`,
    path,
  }))
  const workingFiles = authorityFiles.map((file, index) => workingFile(file, {
    additions: index + 1,
    deletions: 0,
  }))
  const model = buildWorkingChangesViewModel({
    repo_path: '/repo',
    full_hash: 'abc',
    snapshot_id: 'working-v1-paths',
    files: workingFiles,
  }, snapshot(authorityFiles))

  assert.deepEqual(model.files.map((file) => file.path), paths)
  assert.equal(model.consistency.is_consistent, true)
  assert.notEqual(logicalFileKey(model.files[0]), logicalFileKey(model.files[1]))
  assert.notEqual(logicalFileKey(model.files[2]), logicalFileKey(model.files[3]))
  assert.deepEqual(buildStagingTargets(model.files, 'stage').map((target) => target.path), paths)
  assert.deepEqual(buildWorkingChangeTargets(model.files).map((target) => target.path), paths)

  const described = describeStagingOperationResult({
    status: 'partial',
    results: [{ path: ' file.txt ', status: 'failed', message: 'identity' }],
  })
  assert.equal(described.details[0].path, ' file.txt ')
})

test('builds only eligible stage and unstage targets with exact mutation authority', () => {
  const unstaged = stagingFile()
  const mixed = stagingFile({
    path: 'src/mixed.rs',
    id: 'authority:mixed',
    index_code: 'M',
    worktree_code: 'M',
    staging_state: 'mixed',
    has_staged_changes: true,
    has_unstaged_changes: true,
    can_stage: true,
    can_unstage: true,
  })
  const conflicted = stagingFile({
    path: 'src/conflict.rs',
    id: 'authority:conflict',
    staging_state: 'conflicted',
    is_conflicted: true,
    can_stage: false,
    can_unstage: false,
  })

  assert.equal(canRunStagingOperation(unstaged, 'stage'), true)
  assert.equal(canRunStagingOperation(unstaged, 'unstage'), false)
  assert.deepEqual(selectStagingCandidates([unstaged, mixed, conflicted], 'unstage'), [mixed])
  assert.deepEqual(buildStagingTargets([unstaged, mixed, conflicted], 'stage'), [
    {
      path: 'src/a.rs',
      oldPath: null,
      expectedIndexCode: ' ',
      expectedWorktreeCode: 'M',
      expectedAuthorityId: 'authority:src/a.rs:A',
    },
    {
      path: 'src/mixed.rs',
      oldPath: null,
      expectedIndexCode: 'M',
      expectedWorktreeCode: 'M',
      expectedAuthorityId: 'authority:mixed',
    },
  ])
})

test('exposes clear staging labels and conflict descriptions', () => {
  assert.equal(getStagingStateLabel('staged'), '已暂存')
  assert.equal(getStagingStateLabel('mixed'), '部分暂存')
  assert.match(getStagingStateDescription({ staging_state: 'conflicted' }), /未解决冲突/)
})

test('maps complete, partial, stale and uncertain results without hiding file failures', () => {
  const complete = describeStagingOperationResult({ status: 'complete', mutated: true, message: '完成', results: [] })
  assert.equal(complete.tone, 'success')
  assert.equal(complete.should_refresh, true)

  const partial = describeStagingOperationResult({
    status: 'partial',
    mutated: true,
    message: '部分完成',
    results: [
      { path: 'src/a.rs', status: 'success', message: '完成' },
      { path: 'src/b.rs', status: 'failed', message: '状态变化' },
    ],
  })
  assert.equal(partial.tone, 'warning')
  assert.deepEqual(partial.details, [{ path: 'src/b.rs', status: 'failed', message: '状态变化' }])

  const stale = describeStagingOperationResult({ status: 'stale', mutated: false, message: '已过期' })
  assert.equal(stale.tone, 'warning')
  assert.equal(stale.needs_confirmation, false)

  const uncertain = describeStagingOperationResult({
    status: 'needs_confirmation',
    needs_confirmation: true,
    message: '需要确认',
  })
  assert.equal(uncertain.tone, 'warning')
  assert.equal(uncertain.needs_confirmation, true)
})
