import test from 'node:test'
import assert from 'node:assert/strict'
import { createStashOperationClient } from './stashOperationClient.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function snapshot(id) {
  return {
    snapshotId: id,
    worktreeId: `worktree-${id}`,
    stashes: [],
  }
}

function repositoryDouble({
  publishError = null,
  publishResult = undefined,
  readError = null,
} = {}) {
  const calls = []
  return {
    calls,
    beginMutation(repoPath) {
      const token = { repoPath, version: calls.length + 1 }
      calls.push(['begin', token])
      return token
    },
    releaseMutation(token) {
      calls.push(['release', token])
    },
    publishMutation(token, rawSnapshot) {
      calls.push(['publish', token, rawSnapshot])
      if (publishError) throw publishError
      return publishResult === undefined ? rawSnapshot : publishResult
    },
    async read(repoPath, options) {
      calls.push(['read', repoPath, options])
      if (readError) throw readError
      return snapshot('observed')
    },
  }
}

test('mutation invocation reconciles a response loss with the same request id', async () => {
  const commands = []
  const repository = repositoryDouble()
  const client = createStashOperationClient({
    invokeNative: async (command, args) => {
      commands.push([command, args])
      if (command === 'create_repo_stash') throw new Error('response lost')
      return {
        operation: 'create',
        request_id: 'request-1',
        status: 'complete',
        mutated: true,
        created_stash_id: 'a'.repeat(40),
        snapshot: snapshot('mutation'),
      }
    },
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      mutated: value.mutated,
      worktreeChanged: false,
      createdStashId: value.created_stash_id,
      needsConfirmation: false,
      snapshot: value.snapshot,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'request-1',
    request: { requestId: 'request-1', expectedSnapshotId: 'snapshot-before' },
  })

  assert.equal(result.status, 'complete')
  assert.deepEqual(commands.map(([command]) => command), [
    'create_repo_stash',
    'reconcile_repo_stash_operation',
  ])
  assert.deepEqual(commands[1][1], {
    repoPath: '/repo',
    requestId: 'request-1',
    expectedOperation: 'create',
    expectedTargetStashId: null,
    expectedSnapshotId: 'snapshot-before',
  })
  assert.equal(client.stats().activeRepositories, 0)
})

test('backend snapshot projection failure is reprojected once without replaying Git mutation', async () => {
  const commands = []
  const repository = repositoryDouble()
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      commands.push(command)
      if (command === 'create_repo_stash') {
        return {
          operation: 'create',
          request_id: 'request-1',
          status: 'needs_confirmation',
          needs_confirmation: true,
          mutated: true,
          created_stash_id: 'a'.repeat(40),
          snapshot_error: 'temporary snapshot failure',
        }
      }
      return {
        operation: 'create',
        request_id: 'request-1',
        status: 'complete',
        needs_confirmation: false,
        mutated: true,
        created_stash_id: 'a'.repeat(40),
        snapshot: snapshot('reprojected'),
      }
    },
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      needsConfirmation: value.needs_confirmation === true,
      mutated: value.mutated === true,
      worktreeChanged: false,
      createdStashId: value.created_stash_id || null,
      targetStashId: value.target_stash_id || null,
      snapshot: value.snapshot || null,
      snapshotError: value.snapshot_error || null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'request-1',
    request: { requestId: 'request-1' },
  })

  assert.deepEqual(commands, [
    'create_repo_stash',
    'reconcile_repo_stash_operation',
  ])
  assert.equal(result.status, 'complete')
  assert.equal(result.snapshot.snapshotId, 'reprojected')
})

test('snapshot install failure preserves confirmed operation truth when the authority fallback read succeeds', async () => {
  const repository = repositoryDouble({ publishError: new Error('bad snapshot') })
  const client = createStashOperationClient({
    invokeNative: async () => ({
      operation: 'drop',
      request_id: 'drop-1',
      status: 'complete',
      mutated: true,
      dropped: true,
      target_stash_id: 'a'.repeat(40),
      snapshot: snapshot('mutation'),
    }),
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      mutated: value.mutated,
      dropped: value.dropped,
      targetStashId: value.target_stash_id,
      worktreeChanged: false,
      needsConfirmation: false,
      snapshot: value.snapshot,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'drop',
    command: 'drop_repo_stash',
    requestId: 'drop-1',
    request: { requestId: 'drop-1', stashId: 'a'.repeat(40) },
  })

  assert.equal(result.status, 'complete')
  assert.equal(result.needsConfirmation, false)
  assert.equal(result.mutated, true)
  assert.equal(result.dropped, true)
  assert.equal(result.snapshot.snapshotId, 'observed')
  assert.equal(result.snapshotError, null)
  const begin = repository.calls.find(([type]) => type === 'begin')
  const read = repository.calls.find(([type]) => type === 'read')
  assert.equal(read[2].mutationToken, begin[1])
})

test('snapshot install failure downgrades only when the authority fallback read also fails', async () => {
  const repository = repositoryDouble({
    publishError: new Error('bad snapshot'),
    readError: new Error('authority unavailable'),
  })
  const client = createStashOperationClient({
    invokeNative: async () => ({
      operation: 'drop',
      request_id: 'drop-1',
      status: 'complete',
      mutated: true,
      dropped: true,
      target_stash_id: 'a'.repeat(40),
      snapshot: snapshot('mutation'),
    }),
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      mutated: value.mutated,
      dropped: value.dropped,
      targetStashId: value.target_stash_id,
      worktreeChanged: false,
      needsConfirmation: false,
      snapshot: value.snapshot,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'drop',
    command: 'drop_repo_stash',
    requestId: 'drop-1',
    request: { requestId: 'drop-1', stashId: 'a'.repeat(40) },
  })

  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.needsConfirmation, true)
  assert.equal(result.mutated, true)
  assert.equal(result.dropped, true)
  assert.equal(result.snapshot, null)
  assert.match(result.snapshotError, /bad snapshot/)
  assert.match(result.snapshotError, /authority unavailable/)
})

test('missing result snapshot downgrades only when the authority fallback read also fails', async () => {
  const repository = repositoryDouble()
  repository.read = async () => { throw new Error('authority read unavailable') }
  const client = createStashOperationClient({
    invokeNative: async () => ({
      operation: 'apply',
      request_id: 'apply-1',
      status: 'complete',
      mutated: true,
      applied: true,
      stash_retained: true,
      target_stash_id: 'a'.repeat(40),
    }),
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      mutated: value.mutated === true,
      applied: value.applied === true,
      stashRetained: value.stash_retained === true,
      targetStashId: value.target_stash_id || null,
      worktreeChanged: false,
      needsConfirmation: false,
      snapshot: null,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'apply',
    command: 'apply_repo_stash',
    requestId: 'apply-1',
    request: { requestId: 'apply-1', stashId: 'a'.repeat(40) },
  })

  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.needsConfirmation, true)
  assert.equal(result.mutated, true)
  assert.equal(result.applied, true)
  assert.match(result.snapshotError, /authority read unavailable/)
})

test('projection failure preserves a known conflict status while adding confirmation uncertainty', async () => {
  const targetId = 'a'.repeat(40)
  const repository = repositoryDouble({ readError: new Error('authority unavailable') })
  const client = createStashOperationClient({
    invokeNative: async () => ({
      operation: 'apply',
      request_id: 'apply-conflict',
      status: 'conflict',
      mutated: true,
      target_stash_id: targetId,
      stash_retained: true,
      conflicts: ['conflicted.txt'],
    }),
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      mutated: value.mutated === true,
      worktreeChanged: true,
      targetStashId: value.target_stash_id || null,
      stashRetained: value.stash_retained === true,
      conflicts: value.conflicts || [],
      needsConfirmation: false,
      snapshot: null,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'apply',
    command: 'apply_repo_stash',
    requestId: 'apply-conflict',
    request: { requestId: 'apply-conflict', stashId: targetId },
  })

  assert.equal(result.status, 'conflict')
  assert.equal(result.needsConfirmation, true)
  assert.equal(result.mutated, true)
  assert.equal(result.stashRetained, true)
  assert.deepEqual(result.conflicts, ['conflicted.txt'])
  assert.match(result.snapshotError, /authority unavailable/)
})

test('a superseded mutation snapshot uses a fresh authority read without rewriting confirmed operation truth', async () => {
  const repository = repositoryDouble({ publishResult: null })
  const client = createStashOperationClient({
    invokeNative: async () => ({
      operation: 'create',
      request_id: 'request-1',
      status: 'complete',
      mutated: true,
      created_stash_id: 'a'.repeat(40),
      snapshot: snapshot('superseded'),
    }),
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      mutated: value.mutated,
      worktreeChanged: false,
      createdStashId: value.created_stash_id,
      needsConfirmation: false,
      snapshot: value.snapshot,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'request-1',
    request: { requestId: 'request-1' },
  })

  assert.equal(result.status, 'complete')
  assert.equal(result.needsConfirmation, false)
  assert.equal(result.mutated, true)
  assert.equal(result.snapshot.snapshotId, 'observed')
  assert.equal(result.snapshotError, null)
})

test('missing journal after an invocation failure is returned as a structured non-start result', async () => {
  const repository = repositoryDouble()
  const commands = []
  const client = createStashOperationClient({
    invokeNative: async (command, args) => {
      commands.push([command, args])
      if (command === 'create_repo_stash') throw new Error('did not start')
      return {
        operation: 'create',
        requestId: 'request-1',
        status: 'failed',
        mutated: false,
        needsConfirmation: false,
        worktreeChanged: false,
        snapshot: snapshot('non-start'),
      }
    },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'request-1',
    request: { requestId: 'request-1', expectedSnapshotId: 'snapshot-before' },
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.needsConfirmation, false)
  assert.equal(result.mutated, false)
  assert.equal(result.snapshot.snapshotId, 'non-start')
  assert.deepEqual(commands[1][1], {
    repoPath: '/repo',
    requestId: 'request-1',
    expectedOperation: 'create',
    expectedTargetStashId: null,
    expectedSnapshotId: 'snapshot-before',
  })
})

test('reconcile failures never infer non-start from human-readable error text', async () => {
  const repository = repositoryDouble()
  const targetId = 'a'.repeat(40)
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      if (command === 'pop_repo_stash') throw new Error('response lost')
      throw new Error('找不到可确认的 Stash 操作记录。')
    },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'pop',
    command: 'pop_repo_stash',
    requestId: 'pop-1',
    request: { requestId: 'pop-1', stashId: targetId },
  })

  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.needsConfirmation, true)
  assert.equal(result.targetStashId, targetId)
  assert.equal(result.stashRetained, false)
  assert.equal(result.mutated, false)
})

test('unresolved target operation preserves the selected Stash identity without replaying it', async () => {
  const repository = repositoryDouble()
  const targetId = 'a'.repeat(40)
  const client = createStashOperationClient({
    invokeNative: async () => { throw new Error('transport and reconcile unavailable') },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'pop',
    command: 'pop_repo_stash',
    requestId: 'pop-1',
    request: { requestId: 'pop-1', stashId: targetId },
  })

  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.targetStashId, targetId)
  assert.equal(result.stashRetained, false)
  assert.equal(result.mutated, false)
})

test('a truncated authority snapshot keeps target retention unknown when the target is unseen', async () => {
  const targetId = 'a'.repeat(40)
  const repository = repositoryDouble()
  repository.read = async () => ({
    ...snapshot('observed'),
    stashesTruncated: true,
  })
  const client = createStashOperationClient({
    invokeNative: async () => { throw new Error('transport and reconcile unavailable') },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'pop',
    command: 'pop_repo_stash',
    requestId: 'pop-1',
    request: { requestId: 'pop-1', stashId: targetId },
  })

  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.needsConfirmation, true)
  assert.equal(result.targetStashId, targetId)
  assert.equal(result.stashRetained, false)
  assert.equal(result.snapshot.stashesTruncated, true)
})

test('automatic reconciliation trusts the original target identity instead of a foreign response target', async () => {
  const repository = repositoryDouble()
  const requestTarget = 'a'.repeat(40)
  const foreignTarget = 'b'.repeat(40)
  const calls = []
  const client = createStashOperationClient({
    invokeNative: async (command, args) => {
      calls.push([command, args])
      if (command === 'pop_repo_stash') {
        return {
          operation: 'pop',
          request_id: 'pop-1',
          status: 'complete',
          target_stash_id: foreignTarget,
          snapshot: snapshot('foreign'),
        }
      }
      return {
        operation: 'pop',
        request_id: 'pop-1',
        status: 'complete',
        target_stash_id: requestTarget,
        applied: true,
        dropped: true,
        snapshot: snapshot('reconciled'),
      }
    },
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      targetStashId: value.target_stash_id || null,
      applied: value.applied === true,
      dropped: value.dropped === true,
      mutated: true,
      worktreeChanged: true,
      needsConfirmation: false,
      snapshot: value.snapshot || null,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'pop',
    command: 'pop_repo_stash',
    requestId: 'pop-1',
    request: {
      requestId: 'pop-1',
      stashId: requestTarget,
      expectedSnapshotId: 'snapshot-before',
    },
  })

  assert.equal(calls[1][0], 'reconcile_repo_stash_operation')
  assert.deepEqual(calls[1][1], {
    repoPath: '/repo',
    requestId: 'pop-1',
    expectedOperation: 'pop',
    expectedTargetStashId: requestTarget,
    expectedSnapshotId: 'snapshot-before',
  })
  assert.equal(result.operation, 'pop')
  assert.equal(result.requestId, 'pop-1')
  assert.equal(result.targetStashId, requestTarget)
  assert.equal(result.snapshot.snapshotId, 'reconciled')
})

test('one repository cannot start a second frontend Stash operation while the first is active', async () => {
  const flight = deferred()
  let nativeCalls = 0
  const repository = repositoryDouble()
  const client = createStashOperationClient({
    invokeNative: async () => {
      nativeCalls += 1
      await flight.promise
      return {
        operation: 'create',
        request_id: 'first',
        status: 'complete',
        snapshot: snapshot('first'),
      }
    },
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      needsConfirmation: false,
      mutated: true,
      worktreeChanged: true,
      snapshot: value.snapshot,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const first = client.invokeMutation({
    repoPath: '/repo',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'first',
    request: { requestId: 'first' },
  })
  await Promise.resolve()

  await assert.rejects(
    client.invokeMutation({
      repoPath: '/repo',
      operation: 'drop',
      command: 'drop_repo_stash',
      requestId: 'second',
      request: { requestId: 'second', stashId: 'a'.repeat(40) },
    }),
    (error) => error?.code === 'STASH_OPERATION_BUSY' && error?.needsConfirmation === false
  )
  assert.equal(nativeCalls, 1)
  assert.equal(client.stats().activeRepositories, 1)

  flight.resolve()
  await first
  assert.equal(client.stats().activeRepositories, 0)
})

test('acknowledgement binds the current snapshot id without constructing a mutation request', async () => {
  const repository = repositoryDouble()
  let observed
  const client = createStashOperationClient({
    invokeNative: async (command, args) => {
      observed = { command, args }
      return {
        operation: 'create',
        request_id: 'request-1',
        status: 'acknowledged',
        needs_confirmation: false,
        snapshot: snapshot('accepted'),
      }
    },
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      needsConfirmation: value.needs_confirmation,
      mutated: false,
      worktreeChanged: false,
      snapshot: value.snapshot,
      snapshotError: value.snapshot_error || null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.acknowledgeOperation('/repo', 'request-1', 'snapshot-before')
  assert.equal(result.status, 'acknowledged')
  assert.deepEqual(observed, {
    command: 'acknowledge_repo_stash_operation',
    args: {
      repoPath: '/repo',
      requestId: 'request-1',
      expectedSnapshotId: 'snapshot-before',
    },
  })
})