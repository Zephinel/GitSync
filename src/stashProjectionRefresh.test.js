import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  dispatchStashOperationProjectionRefresh,
  dispatchStashProjectionRefresh,
  stashOperationNeedsProjectionRefresh,
} from './stashProjectionRefresh.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('projection refresh is dispatched without waiting for its promise', async () => {
  let started = false
  let release
  const pending = new Promise((resolve) => { release = resolve })

  const returned = dispatchStashProjectionRefresh(() => {
    started = true
    return pending
  }, { status: 'complete' })

  assert.equal(returned, undefined)
  assert.equal(started, true)
  release()
  await pending
})

test('projection callback failures are isolated from authoritative operation state', () => {
  assert.doesNotThrow(() => dispatchStashProjectionRefresh(() => {
    throw new Error('projection failed')
  }, { status: 'complete' }))

  assert.doesNotThrow(() => dispatchStashProjectionRefresh(null, { status: 'complete' }))
})

test('uncertain operation results refresh outer repository projections even when mutation axes are unknown', () => {
  assert.equal(stashOperationNeedsProjectionRefresh({
    status: 'needs_confirmation',
    mutated: false,
    worktreeChanged: false,
    needsConfirmation: true,
  }), true)
  assert.equal(stashOperationNeedsProjectionRefresh({
    status: 'conflict',
    mutated: false,
    worktreeChanged: false,
    needsConfirmation: false,
  }), true)
  assert.equal(stashOperationNeedsProjectionRefresh({
    status: 'failed',
    mutated: false,
    worktreeChanged: false,
    needsConfirmation: false,
  }), false)
  assert.equal(stashOperationNeedsProjectionRefresh({
    status: 'stale',
    mutated: false,
    worktreeChanged: false,
    needsConfirmation: false,
  }), true)
})

test('operation projection dispatch uses the shared mutation uncertainty policy', () => {
  let calls = 0
  dispatchStashOperationProjectionRefresh(() => { calls += 1 }, {
    status: 'failed',
    mutated: false,
    worktreeChanged: false,
    needsConfirmation: false,
  })
  assert.equal(calls, 0)

  dispatchStashOperationProjectionRefresh(() => { calls += 1 }, {
    status: 'needs_confirmation',
    mutated: false,
    worktreeChanged: false,
    needsConfirmation: true,
  })
  assert.equal(calls, 1)
})

test('create and manager surfaces never await outer projection callbacks', () => {
  const create = read('./stash-create/CreateStashDialog.jsx')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const sources = `${create}\n${manager}`

  assert.match(create, /dispatchStashOperationProjectionRefresh\(onChanged, next\)/)
  assert.match(manager, /dispatchStashOperationProjectionRefresh\(onChanged, projected\)/)
  assert.doesNotMatch(sources, /await onChanged\?\./)
  assert.doesNotMatch(sources, /try \{ await onChanged/)
  assert.ok(
    create.indexOf('closeAfterSettle = isConfirmedCreateResult(next)')
      < create.indexOf('if (closeAfterSettle) onClose?.()')
  )
})
