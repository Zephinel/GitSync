import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRANCH_FORCE_DELETE_DEFAULT_STORAGE_KEY,
  readBranchForceDeleteDefault,
  writeBranchForceDeleteDefault,
} from './branchForceDeleteSettings.js'

function createStorage(initialValue = null) {
  const values = new Map()
  if (initialValue !== null) values.set(BRANCH_FORCE_DELETE_DEFAULT_STORAGE_KEY, initialValue)
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
  }
}

test('force-delete preference defaults to disabled', () => {
  assert.equal(readBranchForceDeleteDefault(createStorage()), false)
})

test('force-delete preference persists explicit true and false values', () => {
  const storage = createStorage()
  assert.equal(writeBranchForceDeleteDefault(true, storage), true)
  assert.equal(readBranchForceDeleteDefault(storage), true)
  assert.equal(writeBranchForceDeleteDefault(false, storage), false)
  assert.equal(readBranchForceDeleteDefault(storage), false)
})

test('force-delete preference fails safely when storage is unavailable', () => {
  const brokenStorage = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
  }
  assert.equal(readBranchForceDeleteDefault(brokenStorage), false)
  assert.equal(writeBranchForceDeleteDefault(true, brokenStorage), true)
})
