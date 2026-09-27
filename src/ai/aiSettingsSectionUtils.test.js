import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_SETTINGS_MOUNT_ID,
  ensureAiSettingsMount,
  getAiSettingsObserverTarget,
} from './aiSettingsSectionUtils.js'

class FakeElement {
  constructor({ className = '', textContent = '' } = {}) {
    this.className = className
    this.textContent = textContent
    this.children = []
    this.parentElement = null
    this.id = ''
  }

  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  insertBefore(child, beforeChild) {
    child.parentElement = this
    const index = this.children.indexOf(beforeChild)
    if (index === -1) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  querySelector(selector) {
    if (selector === '.settings__section-title') {
      return this.children.find((child) => child.className === 'settings__section-title') || null
    }
    return null
  }

  querySelectorAll(selector) {
    if (selector === '.settings__section') {
      return this.children.filter((child) => child.className === 'settings__section')
    }
    return []
  }
}

function createFakeDocument({ withMainContent = true, withApplication = true } = {}) {
  const settingsRoot = new FakeElement({ className: 'settings' })
  const mainContent = new FakeElement({ className: 'main-content' })
  const githubSection = new FakeElement({ className: 'settings__section' })
  githubSection.appendChild(new FakeElement({ className: 'settings__section-title', textContent: 'GitHub' }))
  settingsRoot.appendChild(githubSection)

  let applicationSection = null
  if (withApplication) {
    applicationSection = new FakeElement({ className: 'settings__section' })
    applicationSection.appendChild(new FakeElement({ className: 'settings__section-title', textContent: '应用设置' }))
    settingsRoot.appendChild(applicationSection)
  }

  const createdElements = []
  return {
    settingsRoot,
    mainContent,
    applicationSection,
    createdElements,
    querySelector(selector) {
      if (selector === '.settings') return settingsRoot
      if (selector === '.main-content') return withMainContent ? mainContent : null
      return null
    },
    getElementById(id) {
      return createdElements.find((element) => element.id === id) || null
    },
    createElement() {
      const element = new FakeElement()
      createdElements.push(element)
      return element
    },
  }
}

test('watches only the main content container', () => {
  const doc = createFakeDocument()
  assert.equal(getAiSettingsObserverTarget(doc), doc.mainContent)
  const withoutMain = createFakeDocument({ withMainContent: false })
  assert.equal(getAiSettingsObserverTarget(withoutMain), null)
  assert.equal(getAiSettingsObserverTarget(null), null)
})

test('inserts AI settings before application settings and reuses the mount', () => {
  const doc = createFakeDocument()
  const mount = ensureAiSettingsMount(doc)
  assert.equal(mount.id, AI_SETTINGS_MOUNT_ID)
  assert.equal(doc.settingsRoot.children[1], mount)
  assert.equal(doc.settingsRoot.children[2], doc.applicationSection)
  assert.equal(ensureAiSettingsMount(doc), mount)
  assert.equal(doc.createdElements.length, 1)
})

test('appends when application settings are absent', () => {
  const doc = createFakeDocument({ withApplication: false })
  const mount = ensureAiSettingsMount(doc)
  assert.equal(doc.settingsRoot.children.at(-1), mount)
})

test('returns null outside the settings page', () => {
  const doc = createFakeDocument()
  doc.querySelector = () => null
  assert.equal(ensureAiSettingsMount(doc), null)
})
