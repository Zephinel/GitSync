import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY,
  COMMIT_DIFF_SETTINGS_STORAGE_KEY,
  COMMIT_DIFF_VIEW_STYLE_CHANGED_EVENT,
  normalizeCommitDiffViewStyle,
  readCommitDiffViewStyle,
  readSettingsObject,
  writeCommitDiffViewStyle,
} from './commitDiffSettings.js'

class FakeLocalStorage {
  constructor() {
    this.items = new Map()
    this.throwOnSet = false
  }

  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null
  }

  setItem(key, value) {
    if (this.throwOnSet) throw new Error('quota exceeded')
    this.items.set(key, String(value))
  }
}

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type
    this.detail = options.detail
  }
}

function installBrowserGlobals(storage = new FakeLocalStorage()) {
  const events = []
  globalThis.localStorage = storage
  globalThis.CustomEvent = FakeCustomEvent
  globalThis.window = {
    dispatchEvent(event) {
      events.push(event)
      return true
    },
  }
  return { storage, events }
}

afterEach(() => {
  delete globalThis.localStorage
  delete globalThis.window
  delete globalThis.CustomEvent
})

test('normalizeCommitDiffViewStyle accepts only split and otherwise falls back to unified', () => {
  assert.equal(normalizeCommitDiffViewStyle('split'), 'split')
  assert.equal(normalizeCommitDiffViewStyle('unified'), 'unified')
  assert.equal(normalizeCommitDiffViewStyle(null), 'unified')
  assert.equal(normalizeCommitDiffViewStyle({}), 'unified')
})

test('readSettingsObject returns an object only for valid JSON objects', () => {
  const { storage } = installBrowserGlobals()

  assert.deepEqual(readSettingsObject(), {})
  storage.items.set(COMMIT_DIFF_SETTINGS_STORAGE_KEY, '{"commitDiffViewStyle":"split"}')
  assert.deepEqual(readSettingsObject(), { commitDiffViewStyle: 'split' })
  storage.items.set(COMMIT_DIFF_SETTINGS_STORAGE_KEY, '{broken')
  assert.deepEqual(readSettingsObject(), {})
  storage.items.set(COMMIT_DIFF_SETTINGS_STORAGE_KEY, '"not-an-object"')
  assert.deepEqual(readSettingsObject(), {})
  storage.items.set(COMMIT_DIFF_SETTINGS_STORAGE_KEY, '["split"]')
  assert.deepEqual(readSettingsObject(), {})
})

test('readCommitDiffViewStyle prefers the independent key and migrates from the legacy app settings key', () => {
  const { storage } = installBrowserGlobals()

  assert.equal(readCommitDiffViewStyle(), 'unified')
  storage.items.set(COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY, '{"commitDiffViewStyle":"split"}')
  assert.equal(readCommitDiffViewStyle(), 'split')
  storage.items.set(COMMIT_DIFF_SETTINGS_STORAGE_KEY, '{"commitDiffViewStyle":"unified"}')
  assert.equal(readCommitDiffViewStyle(), 'unified')
  storage.items.set(COMMIT_DIFF_SETTINGS_STORAGE_KEY, '{"diffViewStyle":"split"}')
  assert.equal(readCommitDiffViewStyle(), 'split')
})

test('writeCommitDiffViewStyle writes only the independent key and dispatches the change event', () => {
  const { storage, events } = installBrowserGlobals()
  storage.items.set(COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY, '{"notifications":true}')
  storage.items.set(COMMIT_DIFF_SETTINGS_STORAGE_KEY, '{"other":"preserved"}')

  assert.equal(writeCommitDiffViewStyle('split'), 'split')
  assert.deepEqual(JSON.parse(storage.getItem(COMMIT_DIFF_SETTINGS_STORAGE_KEY)), {
    other: 'preserved',
    commitDiffViewStyle: 'split',
  })
  assert.equal(storage.getItem(COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY), '{"notifications":true}')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, COMMIT_DIFF_VIEW_STYLE_CHANGED_EVENT)
  assert.deepEqual(events[0].detail, { commitDiffViewStyle: 'split' })
})

test('writeCommitDiffViewStyle still dispatches when localStorage write fails', () => {
  const { storage, events } = installBrowserGlobals()
  storage.throwOnSet = true

  assert.equal(writeCommitDiffViewStyle('side-by-side'), 'unified')
  assert.equal(storage.getItem(COMMIT_DIFF_SETTINGS_STORAGE_KEY), null)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0].detail, { commitDiffViewStyle: 'unified' })
})
