import test from 'node:test'
import assert from 'node:assert/strict'
import { createStashOperationClient, stashErrorMessage } from './stashOperationClient.js'

const AUTHORITY_TIMEOUT = '[STASH_AUTHORITY_ADMISSION_TIMEOUT] authority wait expired'

function snapshot(id) {
  return {
    snapshotId: id,
    worktreeId: `worktree-${id}`,
    stashes: [],
  }
}

test('user-facing Stash errors strip internal authority machine codes', () => {
  assert.equal(stashErrorMessage(new Error(AUTHORITY_TIMEOUT)), 'authority wait expired')
  assert.equal(stashErrorMessage('ordinary failure'), 'ordinary failure')
})

test('a successful transport response with the wrong request identity is reconciled before install', async () => {
  const commands = []
  const published = []
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => {
      published.push(value.snapshotId)
      return value
    },
    read: async () => snapshot('observed'),
  }
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      commands.push(command)
      if (command === 'create_repo_stash') {
        return {
          operation: 'drop',
          request_id: 'foreign-request',
          status: 'complete',
          snapshot: snapshot('foreign'),
        }
      }
      return {
        operation: 'create',
        request_id: 'request-1',
        status: 'complete',
        snapshot: snapshot('reconciled'),
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
  assert.deepEqual(published, ['reconciled'])
  assert.equal(result.requestId, 'request-1')
  assert.equal(result.operation, 'create')
  assert.equal(result.snapshot.snapshotId, 'reconciled')
})

test('an explicit needs-confirmation response receives one projection-only reconciliation', async () => {
  const commands = []
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => value,
    read: async () => snapshot('observed'),
  }
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      commands.push(command)
      return command === 'create_repo_stash'
        ? {
          operation: 'create',
          request_id: 'request-1',
          status: 'needs_confirmation',
          needs_confirmation: true,
        }
        : {
          operation: 'create',
          request_id: 'request-1',
          status: 'complete',
          needs_confirmation: false,
          snapshot: snapshot('confirmed'),
        }
    },
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      needsConfirmation: value.needs_confirmation === true,
      mutated: true,
      worktreeChanged: true,
      snapshot: value.snapshot || null,
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

  assert.deepEqual(commands, [
    'create_repo_stash',
    'reconcile_repo_stash_operation',
  ])
  assert.equal(result.status, 'complete')
  assert.equal(result.snapshot.snapshotId, 'confirmed')
})

test('a mismatched reconciliation response cannot install its foreign snapshot', async () => {
  const published = []
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => {
      published.push(value.snapshotId)
      return value
    },
    read: async () => snapshot('observed'),
  }
  const client = createStashOperationClient({
    invokeNative: async () => ({
      operation: 'drop',
      request_id: 'foreign-request',
      status: 'complete',
      mutated: true,
      snapshot: snapshot('foreign'),
    }),
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      needsConfirmation: false,
      mutated: value.mutated === true,
      worktreeChanged: true,
      snapshot: value.snapshot,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.reconcileOperation('/repo', 'request-1')

  assert.deepEqual(published, [])
  assert.equal(result.requestId, 'request-1')
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.mutated, false)
  assert.equal(result.snapshot.snapshotId, 'observed')
  assert.match(result.message, /响应与当前请求身份不一致/)
})

test('a second mismatched identity after automatic reconciliation fails closed', async () => {
  const commands = []
  const published = []
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => {
      published.push(value.snapshotId)
      return value
    },
    read: async () => snapshot('observed'),
  }
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      commands.push(command)
      return {
        operation: 'drop',
        request_id: 'foreign-request',
        status: 'complete',
        snapshot: snapshot(command === 'create_repo_stash' ? 'foreign-1' : 'foreign-2'),
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
  assert.deepEqual(published, [])
  assert.equal(result.requestId, 'request-1')
  assert.equal(result.operation, 'create')
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.snapshot.snapshotId, 'observed')
})

test('manual reconciliation refreshes snapshot authority before preserving a control-command failure', async () => {
  const reads = []
  const token = { repoPath: '/repo', token: 'reconcile' }
  const repository = {
    beginMutation: () => token,
    releaseMutation: () => {},
    publishMutation: (_token, value) => value,
    read: async (repoPath, options) => {
      reads.push([repoPath, options])
      return snapshot('after-concurrent-settle')
    },
  }
  const client = createStashOperationClient({
    invokeNative: async () => { throw new Error('journal already settled elsewhere') },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  await assert.rejects(
    client.reconcileOperation('/repo', 'request-1'),
    /journal already settled elsewhere/,
  )
  assert.deepEqual(reads, [[
    '/repo',
    { force: true, mutationToken: token },
  ]])
})

test('manual acknowledgement refreshes snapshot authority before preserving a control-command failure', async () => {
  const reads = []
  const token = { repoPath: '/repo', token: 'acknowledge' }
  const repository = {
    beginMutation: () => token,
    releaseMutation: () => {},
    publishMutation: (_token, value) => value,
    read: async (repoPath, options) => {
      reads.push([repoPath, options])
      return snapshot('after-concurrent-settle')
    },
  }
  const client = createStashOperationClient({
    invokeNative: async () => { throw new Error('journal already settled elsewhere') },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  await assert.rejects(
    client.acknowledgeOperation('/repo', 'request-1', 'snapshot-before'),
    /journal already settled elsewhere/,
  )
  assert.deepEqual(reads, [[
    '/repo',
    { force: true, mutationToken: token },
  ]])
})

test('authority admission timeout is a definitive non-start without reconcile or snapshot read', async () => {
  const commands = []
  let reads = 0
  const targetId = 'a'.repeat(40)
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => value,
    read: async () => { reads += 1; return snapshot('should-not-read') },
  }
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      commands.push(command)
      throw new Error(AUTHORITY_TIMEOUT)
    },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'drop',
    command: 'drop_repo_stash',
    requestId: 'drop-1',
    request: { requestId: 'drop-1', stashId: targetId },
  })

  assert.deepEqual(commands, ['drop_repo_stash'])
  assert.equal(reads, 0)
  assert.equal(result.status, 'failed')
  assert.equal(result.mutated, false)
  assert.equal(result.needsConfirmation, false)
  assert.equal(result.targetStashId, targetId)
  assert.doesNotMatch(result.errors[0], /STASH_AUTHORITY_ADMISSION_TIMEOUT/)
  assert.equal(client.stats().activeRepositories, 0)
})

test('authority timeout while reconciling an unknown mutation does not add a third authority wait', async () => {
  const commands = []
  let reads = 0
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => value,
    read: async () => { reads += 1; return snapshot('should-not-read') },
  }
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      commands.push(command)
      if (command === 'create_repo_stash') throw new Error('transport lost after unknown execution')
      throw new Error(AUTHORITY_TIMEOUT)
    },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'create-1',
    request: { requestId: 'create-1', expectedSnapshotId: 'before' },
  })

  assert.deepEqual(commands, ['create_repo_stash', 'reconcile_repo_stash_operation'])
  assert.equal(reads, 0)
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.needsConfirmation, true)
  assert.doesNotMatch(result.errors.join('\n'), /STASH_AUTHORITY_ADMISSION_TIMEOUT/)
})

test('projection-only reconcile timeout preserves uncertainty without a follow-up authority read', async () => {
  const commands = []
  let reads = 0
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => value,
    read: async () => { reads += 1; return snapshot('should-not-read') },
  }
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      commands.push(command)
      if (command === 'create_repo_stash') {
        return {
          operation: 'create',
          request_id: 'create-1',
          status: 'needs_confirmation',
          needs_confirmation: true,
          mutated: true,
        }
      }
      throw new Error(AUTHORITY_TIMEOUT)
    },
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'create-1',
    request: { requestId: 'create-1' },
  })

  assert.deepEqual(commands, ['create_repo_stash', 'reconcile_repo_stash_operation'])
  assert.equal(reads, 0)
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.needsConfirmation, true)
  assert.match(result.snapshotError, /authority wait expired/)
  assert.doesNotMatch(result.snapshotError, /STASH_AUTHORITY_ADMISSION_TIMEOUT/)
})

test('projection-only reconcile timeout installs an attached authoritative snapshot without another read', async () => {
  const commands = []
  const published = []
  let reads = 0
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => {
      published.push(value.snapshotId)
      return value
    },
    read: async () => { reads += 1; return snapshot('should-not-read') },
  }
  const client = createStashOperationClient({
    invokeNative: async (command) => {
      commands.push(command)
      if (command === 'create_repo_stash') {
        return {
          operation: 'create',
          request_id: 'create-attached',
          status: 'needs_confirmation',
          needs_confirmation: true,
          mutated: true,
          snapshot: snapshot('attached-authority'),
        }
      }
      throw new Error(AUTHORITY_TIMEOUT)
    },
    normalizeResult: (value) => ({
      operation: value.operation,
      requestId: value.request_id,
      status: value.status,
      needsConfirmation: value.needs_confirmation === true,
      mutated: value.mutated === true,
      worktreeChanged: false,
      snapshot: value.snapshot || null,
      snapshotError: null,
      warnings: [],
    }),
    snapshotRepository: repository,
  })

  const result = await client.invokeMutation({
    repoPath: '/repo',
    operation: 'create',
    command: 'create_repo_stash',
    requestId: 'create-attached',
    request: { requestId: 'create-attached' },
  })

  assert.deepEqual(commands, ['create_repo_stash', 'reconcile_repo_stash_operation'])
  assert.deepEqual(published, ['attached-authority'])
  assert.equal(reads, 0)
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.needsConfirmation, true)
  assert.equal(result.snapshot.snapshotId, 'attached-authority')
  assert.equal(result.snapshotError, null)
  assert.match(result.warnings.join('\n'), /进一步的权威对账等待超时/)
  assert.doesNotMatch(result.warnings.join('\n'), /STASH_AUTHORITY_ADMISSION_TIMEOUT/)
})

test('manual reconcile and acknowledge authority timeouts do not start a second authority read', async () => {
  let reads = 0
  const repository = {
    beginMutation: (repoPath) => ({ repoPath }),
    releaseMutation: () => {},
    publishMutation: (_token, value) => value,
    read: async () => { reads += 1; return snapshot('should-not-read') },
  }
  const client = createStashOperationClient({
    invokeNative: async () => { throw new Error(AUTHORITY_TIMEOUT) },
    normalizeResult: (value) => value,
    snapshotRepository: repository,
  })

  await assert.rejects(client.reconcileOperation('/repo', 'request-1'), /STASH_AUTHORITY_ADMISSION_TIMEOUT/)
  await assert.rejects(client.acknowledgeOperation('/repo', 'request-1', 'before'), /STASH_AUTHORITY_ADMISSION_TIMEOUT/)
  assert.equal(reads, 0)
})
