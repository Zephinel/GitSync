import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRemoveReposOutcome,
  normalizeRemoveReposBatchResult,
  normalizeRepoIdsForRemoval,
} from './removeRepoUtils.js'

test('normalizeRepoIdsForRemoval keeps trimmed unique ids in order', () => {
  const repos = [
    { id: '  a ' },
    { id: 'b' },
    { id: 'a' },
    { id: '' },
    {},
    { id: ' c ' },
  ]
  assert.deepEqual(normalizeRepoIdsForRemoval(repos), ['a', 'b', 'c'])
})

test('normalizeRemoveReposBatchResult supports snake_case and camelCase payload keys', () => {
  assert.deepEqual(
    normalizeRemoveReposBatchResult({
      removed_ids: ['a', 'b'],
      missing_ids: ['c'],
    }),
    { removedIds: ['a', 'b'], missingIds: ['c'] }
  )

  assert.deepEqual(
    normalizeRemoveReposBatchResult({
      removedIds: ['x', 'x'],
      missingIds: [' y '],
    }),
    { removedIds: ['x'], missingIds: ['y'] }
  )
})

test('buildRemoveReposOutcome treats missing ids as already removed', () => {
  const targetRepos = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]

  const outcome = buildRemoveReposOutcome(targetRepos, {
    removed_ids: ['a'],
    missing_ids: ['c'],
  })

  assert.equal(outcome.successCount, 2)
  assert.deepEqual(outcome.removedIds, ['a', 'c'])
  assert.deepEqual(outcome.failures, [{ name: 'B', message: '移除失败，请稍后重试' }])
})

test('buildRemoveReposOutcome returns all failures when backend payload has no result ids', () => {
  const targetRepos = [
    { id: 'a', name: 'Repo A' },
    { id: 'b', name: 'Repo B' },
  ]

  const outcome = buildRemoveReposOutcome(targetRepos, {})
  assert.equal(outcome.successCount, 0)
  assert.deepEqual(outcome.removedIds, [])
  assert.deepEqual(outcome.failures, [
    { name: 'Repo A', message: '移除失败，请稍后重试' },
    { name: 'Repo B', message: '移除失败，请稍后重试' },
  ])
})
