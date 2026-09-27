import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRefreshMachine } from './refreshStateMachine.js'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('resolves each caller after the round that covers its request', async () => {
  const rounds = []
  const gates = [createDeferred(), createDeferred(), createDeferred()]
  const machine = createRefreshMachine({
    runRound: async (input, progress) => {
      const roundIndex = rounds.length
      rounds.push(input)
      progress.track([`repo-${roundIndex}`])
      await gates[roundIndex].promise
      progress.settle(`repo-${roundIndex}`)
    },
  })

  const first = machine.request({ manualOnly: true })
  const second = machine.request({ manualOnly: false })

  assert.equal(rounds.length, 1)
  gates[0].resolve()
  await nextTick()
  assert.equal(rounds.length, 2)

  gates[1].resolve()
  await nextTick()
  await Promise.all([first, second])
  assert.equal(rounds.length, 2)
  assert.deepEqual(rounds[0], { manualOnly: true })
  assert.deepEqual(rounds[1], { manualOnly: false })
})

test('many requests during a round coalesce into exactly one follow-up round', async () => {
  const gates = [createDeferred(), createDeferred()]
  let roundCount = 0
  const machine = createRefreshMachine({
    runRound: async () => {
      const index = roundCount
      roundCount += 1
      await gates[index].promise
    },
  })

  const calls = [machine.request({ manualOnly: false })]
  for (let index = 0; index < 5; index += 1) {
    calls.push(machine.request({ manualOnly: true }))
  }

  assert.equal(roundCount, 1)
  gates[0].resolve()
  await nextTick()
  assert.equal(roundCount, 2, 'five queued requests must still produce one extra round')

  gates[1].resolve()
  await Promise.all(calls)
  assert.equal(roundCount, 2)
})

test('the busy snapshot reflects per-repository progress and resets per round', async () => {
  const gate = createDeferred()
  const seen = []
  const machine = createRefreshMachine({
    runRound: async (input, progress) => {
      progress.track(['a', 'b'])
      seen.push(machine.getSnapshot().activeRepoIds)
      progress.settle('a')
      seen.push(machine.getSnapshot().activeRepoIds)
      await gate.promise
      progress.settle('b')
    },
  })

  const subscriptionSnapshots = []
  const unsubscribe = machine.subscribe(() => subscriptionSnapshots.push(machine.getSnapshot()))
  const request = machine.request({})

  assert.deepEqual(seen[0], ['a', 'b'])
  assert.deepEqual(seen[1], ['b'])
  gate.resolve()
  await request

  assert.deepEqual(machine.getSnapshot().activeRepoIds, [])
  assert.equal(machine.getSnapshot().active, false)
  assert.ok(subscriptionSnapshots.length >= 3)
  unsubscribe()
})

test('a caller that re-enters from a round completion starts a new task', async () => {
  let roundCount = 0
  const machine = createRefreshMachine({
    runRound: async () => {
      roundCount += 1
    },
  })

  const first = machine.request({})
  const reentrant = first.then(() => machine.request({}))

  const outcome = await Promise.race([
    reentrant.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
  ])

  assert.equal(outcome, 'resolved')
  assert.equal(roundCount, 2)
  assert.equal(machine.isActive(), false)
})

test('onIdle fires once when the queue settles and not while a successor takes over', async () => {
  const gate = createDeferred()
  let idleCount = 0
  const machine = createRefreshMachine({
    runRound: async () => {
      await gate.promise
    },
    onIdle: () => {
      idleCount += 1
    },
  })

  const request = machine.request({})
  assert.equal(idleCount, 0)
  gate.resolve()
  await request
  assert.equal(idleCount, 1)

  await machine.request({})
  assert.equal(idleCount, 2)
})

test('the in-flight marker is released before round waiters are woken', () => {
  const source = readFileSync(new URL('./refreshStateMachine.js', import.meta.url), 'utf8')
  const finallyStart = source.indexOf('} finally {')
  assert.notEqual(finallyStart, -1)
  const finallyBlock = source.slice(finallyStart, source.indexOf('\n  function request', finallyStart))
  const releaseIndex = finallyBlock.indexOf('state.inFlight = null')
  const resolveIndex = finallyBlock.indexOf('resolveWaiters()')
  assert.notEqual(releaseIndex, -1)
  assert.notEqual(resolveIndex, -1)
  assert.ok(
    releaseIndex < resolveIndex,
    'release the in-flight marker before resolving waiters, otherwise a re-entrant request hangs'
  )
})
