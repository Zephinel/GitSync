import test from 'node:test'
import assert from 'node:assert/strict'
import { createStashSnapshotRepository } from './stashSnapshotRepository.js'

function rawSnapshot(id) {
  return {
    repo_path: '/repo',
    snapshot_id: id,
    worktree_id: `worktree-${id}`,
    head_hash: 'a'.repeat(40),
    stashes: [],
  }
}

test('cache clear cannot deadlock the active mutation final read', async () => {
  let calls = 0
  const repository = createStashSnapshotRepository({
    invokeNative: async () => {
      calls += 1
      return rawSnapshot('after-mutation')
    },
    clearDetails: () => {},
    pruneDetails: () => {},
  })

  const mutation = repository.beginMutation('/repo')
  repository.clear('/repo')

  const publicRead = repository.read('/repo')
  const mutationRead = repository.read('/repo', {
    force: true,
    mutationToken: mutation,
  })

  assert.equal((await mutationRead).snapshotId, 'after-mutation')
  repository.releaseMutation(mutation)

  assert.equal((await publicRead).snapshotId, 'after-mutation')
  assert.equal(calls, 1)
  assert.equal(repository.stats().activeMutations, 0)
  assert.equal(repository.stats().deferredReads, 0)
})

test('a reader already waiting before clear still waits for the mutation result', async () => {
  let calls = 0
  const repository = createStashSnapshotRepository({
    invokeNative: async () => {
      calls += 1
      return rawSnapshot('after-clear')
    },
    clearDetails: () => {},
    pruneDetails: () => {},
  })

  const mutation = repository.beginMutation('/repo')
  const waitingRead = repository.read('/repo')
  let settled = false
  void waitingRead.then(() => { settled = true })

  repository.clear('/repo')
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(repository.stats().deferredReads, 1)

  const mutationRead = repository.read('/repo', {
    force: true,
    mutationToken: mutation,
  })
  assert.equal((await mutationRead).snapshotId, 'after-clear')
  repository.releaseMutation(mutation)

  assert.equal((await waitingRead).snapshotId, 'after-clear')
  assert.equal(calls, 1)
  assert.equal(repository.stats().deferredReads, 0)
})

test('released mutation tokens cannot publish a late snapshot', () => {
  const repository = createStashSnapshotRepository({
    invokeNative: async () => rawSnapshot('read'),
    clearDetails: () => {},
    pruneDetails: () => {},
  })

  const mutation = repository.beginMutation('/repo')
  repository.releaseMutation(mutation)

  assert.equal(repository.publishMutation(mutation, rawSnapshot('late')), null)
  assert.equal(repository.peek('/repo'), null)
})
