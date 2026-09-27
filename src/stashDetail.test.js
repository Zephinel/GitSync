import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createStashFileDiffClient,
  StashFileDiffSupersededError,
} from './stashFileDiffClient.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

test('registers only authoritative stable-OID detail and file-diff commands', () => {
  const lib = read('../src-tauri/src/lib.rs')
  const detail = read('../src-tauri/src/stash/stash_detail.rs')
  const guard = read('../src-tauri/src/stash/stash_detail_guard.rs')
  const types = read('../src-tauri/src/stash/mod.rs')

  assert.equal((lib.match(/stash::authoritative_detail::get_repo_stash_detail/g) || []).length, 1)
  assert.equal((lib.match(/stash::authoritative_detail::get_repo_stash_file_diff/g) || []).length, 1)
  assert.equal((lib.match(/\bstash::get_repo_stash_detail\b/g) || []).length, 0)
  assert.equal((lib.match(/\bstash::get_repo_stash_file_diff\b/g) || []).length, 0)
  assert.match(guard, /#\[tauri::command\][\s\S]*pub async fn get_repo_stash_detail/)
  assert.match(guard, /#\[tauri::command\][\s\S]*pub async fn get_repo_stash_file_diff/)
  assert.doesNotMatch(detail, /#\[tauri::command\]/)
  assert.match(types, /pub struct RepoStashDetail/)
  assert.match(types, /pub struct RepoStashDetailFile/)
  assert.match(types, /pub struct RepoStashFileDiff/)
  assert.match(types, /pub too_large: bool/)
  assert.match(types, /include!\("git_stream\.rs"\)/)
  assert.match(types, /include!\("stash_detail_stream\.rs"\)/)
})

test('detail metadata is streamed with bounded retained memory while complete summary counts are preserved', () => {
  const detail = read('../src-tauri/src/stash/stash_detail.rs')
  const stream = read('../src-tauri/src/stash/stash_detail_stream.rs')
  const gitStream = read('../src-tauri/src/stash/git_stream.rs')
  const rustTests = read('../src-tauri/src/stash/stash_detail_tests.rs')

  assert.match(detail, /read_repo_stash_detail_streamed\(repo_root, stash_id\)\.await/)
  assert.match(gitStream, /async fn run_git_nul_fields/)
  assert.match(gitStream, /stdout[\s\S]*\.read\(&mut buffer\)[\s\S]*\.await/)
  assert.match(gitStream, /GIT_STREAM_FIELD_MAX_BYTES/)
  assert.match(gitStream, /read_bounded_git_stderr/)
  assert.match(stream, /struct StashDetailAccumulator/)
  assert.match(stream, /BTreeMap<\(String, String\), RepoStashDetailFile>/)
  assert.match(stream, /self\.retained\.len\(\) > STASH_DETAIL_MAX_FILES/)
  assert.match(stream, /self\.additions = self\.additions\.saturating_add/)
  assert.match(stream, /self\.deletions = self\.deletions\.saturating_add/)
  assert.match(stream, /files_truncated: self\.file_count > files\.len\(\)/)
  assert.match(stream, /stream_name_status_command/)
  assert.match(stream, /stream_numstat_command/)
  assert.doesNotMatch(detail, /let tracked_status = run_git\(/)
  assert.doesNotMatch(detail, /files\.truncate\(STASH_DETAIL_MAX_FILES\)/)
  assert.match(rustTests, /streamed_detail_retains_only_the_bounded_sorted_surface_but_counts_every_file/)
  assert.match(rustTests, /streaming_parsers_preserve_rename_and_numstat_identity/)
})

test('file Patch metadata no longer rebuilds the full Stash detail surface', () => {
  const detail = read('../src-tauri/src/stash/stash_detail.rs')
  const stream = read('../src-tauri/src/stash/stash_detail_stream.rs')

  assert.match(detail, /read_repo_stash_file_metadata_streamed\(repo_root, &context, &path\)\.await/)
  assert.doesNotMatch(detail, /let detail = read_repo_stash_detail\(repo_root, stash_id\)\.await/)
  assert.match(stream, /async fn read_repo_stash_file_metadata_streamed/)
  assert.match(stream, /find_file_in_name_status/)
  assert.match(stream, /apply_target_numstat/)
})

test('file Patch reads are object-size bounded before content output is loaded', () => {
  const detail = read('../src-tauri/src/stash/stash_detail.rs')

  assert.match(detail, /read_object_size/)
  assert.match(detail, /stash_file_object_bytes/)
  assert.match(detail, /object_bytes > STASH_DETAIL_MAX_PATCH_BYTES as u64/)
  assert.match(detail, /empty_file_diff\(&context, file, false, false, true\)/)
  assert.match(detail, /bounded_patch/)
  assert.match(detail, /--no-textconv/)
  assert.match(detail, /--no-ext-diff/)
})

test('detail UI uses cancellable bounded Detail reads and latest-wins File Diff inside one master-detail surface', () => {
  const view = read('./StashDetailView.jsx')
  const repository = read('./stashDetailRepository.js')
  const fileDiffClient = read('./stashFileDiffClient.js')
  const index = read('./stash-manager/useStashDetailIndex.js')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const list = read('./stash-manager/StashManagerList.jsx')
  const popover = read('./StashManagementPopover.jsx')

  assert.match(view, /readStashDetail\(repoPath, stashId, \{ force, signal: controller\.signal \}\)/)
  assert.ok((view.match(/new AbortController\(\)/g) || []).length >= 2)
  assert.match(view, /controller\.abort\(\)/)
  assert.match(repository, /STASH_DETAIL_NATIVE_CONCURRENCY = 4/)
  assert.match(repository, /invokeNative\('get_repo_stash_detail'/)
  assert.match(repository, /\{ force = false, signal = null \}/)
  assert.match(repository, /activeNativeReads/)
  assert.match(repository, /queuedNativeReads/)
  assert.match(index, /new AbortController\(\)/)
  assert.match(index, /signal: controller\.signal/)
  assert.match(view, /readStashFileDiff\(repoPath, stashId, selectedPath/)
  assert.doesNotMatch(view, /invoke\('get_repo_stash_file_diff'/)
  assert.match(fileDiffClient, /get_repo_stash_file_diff/)
  assert.match(fileDiffClient, /state = \{ active: null, pending: null \}/)
  assert.match(fileDiffClient, /supersedePending/)
  assert.match(fileDiffClient, /state\.pending = request/)
  assert.match(view, /selectedPath/)
  assert.match(view, /fileDiff\.patch/)
  assert.match(view, /二进制内容/)
  assert.match(view, /超过 2 MiB 详情安全上限/)
  assert.match(view, /Patch 超过安全上限/)
  assert.match(view, /refreshToken/)
  assert.match(manager, /detailPanel=\{detailPanel\}/)
  assert.match(manager, /<StashDetailView/)
  assert.match(list, /stash-manager-master-detail/)
  assert.match(list, /onOpenDetail\?\.\(entry\.id\)/)
  assert.match(popover, /onOpenManager\?\.\(intent\)/)
  assert.doesNotMatch(view, /invoke\('get_repo_stash_detail'/)
  assert.doesNotMatch(view, /返回列表|onBack/)
  assert.doesNotMatch(view, />刷新</)
})

test('File Diff keeps one active native request and only the latest pending selection', async () => {
  const calls = []
  const first = deferred()
  const latest = deferred()
  const client = createStashFileDiffClient({
    invokeNative: (_command, args) => {
      calls.push(args.path)
      if (args.path === 'a.txt') return first.promise
      if (args.path === 'c.txt') return latest.promise
      throw new Error(`unexpected native diff: ${args.path}`)
    },
  })

  const active = client.read('/repo', 'stash-1', 'a.txt')
  const superseded = client.read('/repo', 'stash-1', 'b.txt')
  const supersededAssertion = assert.rejects(superseded, StashFileDiffSupersededError)
  const pending = client.read('/repo', 'stash-1', 'c.txt')

  await supersededAssertion
  assert.deepEqual(calls, ['a.txt'])
  assert.equal(client.stats().activeNativeReads, 1)
  assert.equal(client.stats().pendingReads, 1)

  first.resolve({ path: 'a.txt' })
  assert.deepEqual(await active, { path: 'a.txt' })
  await nextTurn()
  assert.deepEqual(calls, ['a.txt', 'c.txt'])

  latest.resolve({ path: 'c.txt' })
  assert.deepEqual(await pending, { path: 'c.txt' })
  await nextTurn()
  assert.equal(client.stats().activeNativeReads, 0)
  assert.equal(client.stats().pendingReads, 0)
})

test('aborting a pending File Diff prevents it from entering Tauri', async () => {
  const calls = []
  const activeFlight = deferred()
  const client = createStashFileDiffClient({
    invokeNative: (_command, args) => {
      calls.push(args.path)
      if (args.path === 'a.txt') return activeFlight.promise
      return Promise.resolve({ path: args.path })
    },
  })

  const active = client.read('/repo', 'stash-1', 'a.txt')
  const controller = new AbortController()
  const queued = client.read('/repo', 'stash-1', 'b.txt', { signal: controller.signal })
  assert.deepEqual(calls, ['a.txt'])

  controller.abort()
  await assert.rejects(queued, StashFileDiffSupersededError)
  assert.equal(client.stats().pendingReads, 0)

  activeFlight.resolve({ path: 'a.txt' })
  await active
  await nextTurn()
  assert.deepEqual(calls, ['a.txt'])
})

test('aborting an active File Diff caller does not release the native slot early', async () => {
  const calls = []
  const first = deferred()
  const second = deferred()
  const client = createStashFileDiffClient({
    invokeNative: (_command, args) => {
      calls.push(args.path)
      return args.path === 'a.txt' ? first.promise : second.promise
    },
  })

  const controller = new AbortController()
  const active = client.read('/repo', 'stash-1', 'a.txt', { signal: controller.signal })
  const pending = client.read('/repo', 'stash-1', 'b.txt')
  controller.abort()

  await assert.rejects(active, StashFileDiffSupersededError)
  assert.deepEqual(calls, ['a.txt'])
  assert.equal(client.stats().activeNativeReads, 1)
  assert.equal(client.stats().pendingReads, 1)

  first.resolve({ path: 'a.txt' })
  await nextTurn()
  assert.deepEqual(calls, ['a.txt', 'b.txt'])

  second.resolve({ path: 'b.txt' })
  assert.deepEqual(await pending, { path: 'b.txt' })
})

test('detail actions remain confirmation-gated in the manager', () => {
  const view = read('./StashDetailView.jsx')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const surfaces = read('./stash-manager/StashOperationSurfaces.jsx')

  assert.match(view, /onAction\?\.\('apply', entry\)/)
  assert.match(view, /onAction\?\.\('pop', entry\)/)
  assert.match(view, /onAction\?\.\('drop', entry\)/)
  assert.match(manager, /setConfirm\(\{ operation, stashId: entry\.id, entry \}\)/)
  assert.match(manager, /!stashSnapshotHasCompleteStashList\(snapshot\) \? confirm\.entry \|\| null : null/)
  assert.match(surfaces, /function ConfirmationDialog/)
  assert.match(manager, /restoreDisabled=\{\(snapshot\?\.conflictedFiles \|\| 0\) > 0\}/)
})
