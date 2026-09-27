import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('snapshot repository owns reads, mutation reservations and subscriptions', () => {
  const repository = read('./stashSnapshotRepository.js')
  const hook = read('./useStashSnapshotState.js')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const create = read('./stash-create/CreateStashDialog.jsx')
  const popover = read('./StashManagementPopover.jsx')
  const operationClient = read('./stashOperationClient.js')

  assert.match(repository, /export function createStashSnapshotRepository/)
  assert.match(repository, /STASH_SNAPSHOT_REPOSITORY_LIMIT = 64/)
  assert.match(repository, /beginMutation/)
  assert.match(repository, /publishMutation/)
  assert.match(repository, /subscribe/)
  assert.match(repository, /generation/)
  assert.match(repository, /readFlight/)
  assert.match(repository, /deferredRead/)
  assert.match(repository, /invokeNative\('get_repo_stash_snapshot'/)
  assert.match(operationClient, /beginStashSnapshotMutation/)
  assert.match(operationClient, /publishStashMutationSnapshot/)
  assert.match(hook, /subscribeStashSnapshot/)
  assert.match(hook, /readStashSnapshot/)
  assert.match(manager, /useStashSnapshotState\(repoPath\)/)
  assert.match(create, /useStashSnapshotState\(repoPath\)/)
  assert.match(popover, /useStashSnapshotState\(repoPath\)/)
  assert.doesNotMatch(`${manager}\n${create}\n${popover}`, /subscribeStashSnapshot|readStashSnapshot|peekStashSnapshot/)
  assert.doesNotMatch(`${manager}\n${create}\n${popover}`, /invoke\('get_repo_stash_snapshot'/)
})

test('snapshot installation is generation fenced and reads wait behind mutation authority', () => {
  const repository = read('./stashSnapshotRepository.js')

  assert.match(repository, /state\.generation === generation/)
  assert.match(repository, /version >= state\.installedVersion/)
  assert.match(repository, /state\.latestMutationVersion = Math\.max/)
  assert.match(repository, /state\.snapshotVersion = version/)
  assert.match(repository, /state\.mutationReservations\.size > 0 && !mutationRead/)
  assert.match(repository, /return deferRead\(state\)/)
  assert.match(repository, /state\.snapshotVersion >= state\.latestMutationVersion/)
  assert.match(repository, /void read\(key, \{ force: true \}\)/)
  assert.match(repository, /state\.generation \+= 1/)
  assert.match(repository, /if \(!force && state\.readFlight\) return state\.readFlight\.promise/)
})

test('snapshot install failures preserve mutation facts and use the same reservation for authority reads', () => {
  const operationClient = read('./stashOperationClient.js')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const createMutation = read('./stash-create/createStashMutation.js')

  assert.match(operationClient, /STASH_SNAPSHOT_INSTALL_WARNING/)
  assert.match(operationClient, /status: 'needs_confirmation'/)
  assert.match(operationClient, /snapshotRepository\.read\(repoPath, \{[\s\S]*force: true,[\s\S]*mutationToken: token/)
  assert.match(manager, /invokeStashMutation/)
  assert.match(createMutation, /invokeStashMutation/)
  assert.doesNotMatch(`${manager}\n${createMutation}`, /publishStashSnapshot/)
})
