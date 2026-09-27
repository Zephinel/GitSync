import test from 'node:test'
import assert from 'node:assert/strict'
import { createStashSnapshotRepository } from './stashSnapshotRepository.js'
import {
  createStashDetailRepository,
  StashDetailSupersededError,
} from './stashDetailRepository.js'

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

function rawSnapshot(id, stashIds = []) {
  return {
    repo_path: '/repo',
    snapshot_id: id,
    worktree_id: `worktree-${id}`,
    head_hash: 'a'.repeat(40),
    stashes: stashIds.map((stashId, ordinal) => ({
      id: stashId,
      oid: stashId,
      selector: `stash@{${ordinal}}`,
    })),
  }
}

test('mutation reservation prevents an older read from replacing the mutation snapshot', async () => {
  const readFlight = deferred()
  const repository = createStashSnapshotRepository({
    invokeNative: () => readFlight.promise,
    clearDetails: () => {},
    pruneDetails: () => {},
  })

  const read = repository.read('/repo')
  const mutation = repository.beginMutation('/repo')
  repository.publishMutation(mutation, rawSnapshot('mutation', ['b'.repeat(40)]))
  readFlight.resolve(rawSnapshot('old-read'))
  repository.releaseMutation(mutation)

  assert.equal((await read).snapshotId, 'mutation')
  assert.equal(repository.peek('/repo').snapshotId, 'mutation')
})

test('a read requested during mutation waits for the mutation snapshot without starting Git I/O', async () => {
  let calls = 0
  const repository = createStashSnapshotRepository({
    invokeNative: async () => {
      calls += 1
      return rawSnapshot('unexpected-read')
    },
    clearDetails: () => {},
    pruneDetails: () => {},
  })

  const mutation = repository.beginMutation('/repo')
  const read = repository.read('/repo')
  assert.equal(calls, 0)
  assert.equal(repository.stats().deferredReads, 1)

  repository.publishMutation(mutation, rawSnapshot('mutation'))
  repository.releaseMutation(mutation)

  assert.equal((await read).snapshotId, 'mutation')
  assert.equal(calls, 0)
  assert.equal(repository.stats().deferredReads, 0)
})

test('a pre-mutation read that returns during mutation cannot deliver its stale value', async () => {
  const flight = deferred()
  const repository = createStashSnapshotRepository({
    invokeNative: () => flight.promise,
    clearDetails: () => {},
    pruneDetails: () => {},
  })

  const read = repository.read('/repo')
  let settled = false
  void read.then(() => { settled = true })
  const mutation = repository.beginMutation('/repo')
  flight.resolve(rawSnapshot('before-mutation'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)

  repository.publishMutation(mutation, rawSnapshot('after-mutation'))
  repository.releaseMutation(mutation)

  assert.equal((await read).snapshotId, 'after-mutation')
})

test('active mutation reservation protects its repository from LRU eviction', () => {
  const repository = createStashSnapshotRepository({
    invokeNative: async () => rawSnapshot('read'),
    clearDetails: () => {},
    pruneDetails: () => {},
    limit: 1,
  })

  const mutation = repository.beginMutation('/active')
  repository.publish('/other', rawSnapshot('other'))

  assert.equal(repository.stats().activeMutations, 1)
  assert.equal(repository.stats().repositories, 1)
  assert.notEqual(repository.publishMutation(mutation, rawSnapshot('active')), null)
  repository.releaseMutation(mutation)
  assert.equal(repository.stats().activeMutations, 0)
})

test('normal reads share one flight while force refresh supersedes the old generation', async () => {
  const flights = [deferred(), deferred()]
  let calls = 0
  const repository = createStashSnapshotRepository({
    invokeNative: () => flights[calls++].promise,
    clearDetails: () => {},
    pruneDetails: () => {},
  })

  const first = repository.read('/repo')
  assert.equal(repository.read('/repo'), first)
  const forced = repository.read('/repo', { force: true })
  flights[1].resolve(rawSnapshot('forced'))
  flights[0].resolve(rawSnapshot('old'))

  assert.equal((await forced).snapshotId, 'forced')
  assert.equal((await first).snapshotId, 'forced')
  assert.equal(calls, 2)
})

test('subscribers observe installs and clear invalidates the repository generation', async () => {
  const flight = deferred()
  const repository = createStashSnapshotRepository({
    invokeNative: () => flight.promise,
    clearDetails: () => {},
    pruneDetails: () => {},
  })
  const observed = []
  const unsubscribe = repository.subscribe('/repo', (snapshot) => observed.push(snapshot?.snapshotId || null))
  const read = repository.read('/repo')
  repository.clear('/repo')
  flight.resolve(rawSnapshot('stale'))
  await read

  assert.deepEqual(observed, [null, null])
  assert.equal(repository.peek('/repo'), null)
  unsubscribe()
})

test('subscriber failures cannot break snapshot authority', () => {
  const repository = createStashSnapshotRepository({
    invokeNative: async () => rawSnapshot('read'),
    clearDetails: () => {},
    pruneDetails: () => {},
  })

  assert.doesNotThrow(() => repository.subscribe('/repo', () => {
    throw new Error('subscriber failure')
  }))
  assert.doesNotThrow(() => repository.publish('/repo', rawSnapshot('published')))
  assert.equal(repository.peek('/repo').snapshotId, 'published')
})

test('detail reads share one flight and force refresh rejects the superseded consumer', async () => {
  const flights = [deferred(), deferred()]
  let calls = 0
  const repository = createStashDetailRepository({
    invokeNative: () => flights[calls++].promise,
    normalizeDetail: (value) => value,
  })

  const oldRead = repository.read('/repo', 'stash', { force: false })
  assert.equal(repository.read('/repo', 'stash'), oldRead)
  const forcedRead = repository.read('/repo', 'stash', { force: true })
  flights[1].resolve({ fileCount: 2 })
  flights[0].resolve({ fileCount: 1 })

  assert.deepEqual(await forcedRead, { fileCount: 2 })
  await assert.rejects(oldRead, StashDetailSupersededError)
  assert.deepEqual(repository.peek('/repo', 'stash'), { fileCount: 2 })
  assert.equal(calls, 2)
})

test('clearing details rejects in-flight work so stale data cannot reach consumers or cache', async () => {
  const flight = deferred()
  const repository = createStashDetailRepository({
    invokeNative: () => flight.promise,
    normalizeDetail: (value) => value,
  })

  const read = repository.read('/repo', 'stash')
  repository.clear('/repo')
  flight.resolve({ fileCount: 3 })
  await assert.rejects(read, StashDetailSupersededError)

  assert.equal(repository.peek('/repo', 'stash'), null)
  assert.equal(repository.stats().activeFlights, 0)
})

test('pruning a removed Stash clears orphan failure cooldown state', async () => {
  let calls = 0
  const repository = createStashDetailRepository({
    invokeNative: async () => {
      calls += 1
      if (calls === 1) throw new Error('temporary failure')
      return { fileCount: 4 }
    },
    normalizeDetail: (value) => value,
    failureCooldownMs: 60_000,
  })

  await assert.rejects(repository.read('/repo', 'removed'))
  assert.equal(repository.stats().coolingFailures, 1)
  repository.prune('/repo', [])
  assert.equal(repository.stats().coolingFailures, 0)
  assert.deepEqual(await repository.read('/repo', 'removed'), { fileCount: 4 })
  assert.equal(calls, 2)
})

test('detail native work is globally bounded per repository across callers', async () => {
  const calls = []
  const flights = []
  const repository = createStashDetailRepository({
    nativeConcurrency: 2,
    normalizeDetail: (value) => value,
    invokeNative: (_command, args) => {
      calls.push(args.stashId)
      const flight = deferred()
      flights.push({ stashId: args.stashId, ...flight })
      return flight.promise
    },
  })

  const reads = ['a', 'b', 'c', 'd', 'e'].map((stashId) => repository.read('/repo', stashId))
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(repository.stats().activeNativeReads, 2)
  assert.equal(repository.stats().queuedNativeReads, 3)

  flights[0].resolve({ fileCount: 1 })
  flights[1].resolve({ fileCount: 1 })
  await nextTurn()
  assert.deepEqual(calls, ['a', 'b', 'c', 'd'])
  assert.equal(repository.stats().activeNativeReads, 2)

  flights[2].resolve({ fileCount: 1 })
  flights[3].resolve({ fileCount: 1 })
  await nextTurn()
  assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'e'])

  flights[4].resolve({ fileCount: 1 })
  await Promise.all(reads)
  assert.equal(repository.stats().activeNativeReads, 0)
  assert.equal(repository.stats().queuedNativeReads, 0)
})

test('aborting a queued detail generation removes it before native invocation', async () => {
  const calls = []
  const firstFlight = deferred()
  const repository = createStashDetailRepository({
    nativeConcurrency: 1,
    normalizeDetail: (value) => value,
    invokeNative: (_command, args) => {
      calls.push(args.stashId)
      if (args.stashId === 'a') return firstFlight.promise
      return Promise.resolve({ fileCount: 1 })
    },
  })

  const first = repository.read('/repo', 'a')
  const controller = new AbortController()
  const queued = repository.read('/repo', 'b', { signal: controller.signal })
  assert.deepEqual(calls, ['a'])
  assert.equal(repository.stats().queuedNativeReads, 1)

  controller.abort()
  await assert.rejects(queued, StashDetailSupersededError)
  await nextTurn()
  assert.deepEqual(calls, ['a'])
  assert.equal(repository.stats().queuedNativeReads, 0)

  firstFlight.resolve({ fileCount: 1 })
  await first
  assert.equal(repository.peek('/repo', 'b'), null)
})

test('aborting one consumer cannot cancel another consumer of the same detail flight', async () => {
  const flight = deferred()
  let calls = 0
  const repository = createStashDetailRepository({
    nativeConcurrency: 1,
    normalizeDetail: (value) => value,
    invokeNative: () => {
      calls += 1
      return flight.promise
    },
  })

  const controller = new AbortController()
  const abortable = repository.read('/repo', 'shared', { signal: controller.signal })
  const persistent = repository.read('/repo', 'shared')
  assert.equal(calls, 1)

  controller.abort()
  await assert.rejects(abortable, StashDetailSupersededError)
  flight.resolve({ fileCount: 7 })
  assert.deepEqual(await persistent, { fileCount: 7 })
  assert.equal(calls, 1)
})

test('truncated snapshots cannot prune detail authority by omission', async () => {
  const pruneCalls = []
  let nextSnapshot = {
    ...rawSnapshot('truncated', ['visible']),
    stashes_truncated: true,
    stash_total: 2,
  }
  const repository = createStashSnapshotRepository({
    invokeNative: async () => nextSnapshot,
    clearDetails: () => {},
    pruneDetails: (repoPath, ids) => pruneCalls.push([repoPath, ids]),
  })

  await repository.read('/repo')
  assert.deepEqual(pruneCalls, [])

  nextSnapshot = rawSnapshot('complete', ['visible'])
  await repository.read('/repo', { force: true })
  assert.deepEqual(pruneCalls, [['/repo', ['visible']]])
})
