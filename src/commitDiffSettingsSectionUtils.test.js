import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ensureCommitDiffSettingsMount,
  getCommitDiffSettingsObserverTarget,
} from './commitDiffSettingsSectionUtils.js'

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
  const syncSection = new FakeElement({ className: 'settings__section' })
  const syncTitle = new FakeElement({ className: 'settings__section-title', textContent: '同步设置' })
  syncSection.appendChild(syncTitle)
  settingsRoot.appendChild(syncSection)

  let applicationSection = null
  if (withApplication) {
    applicationSection = new FakeElement({ className: 'settings__section' })
    const applicationTitle = new FakeElement({ className: 'settings__section-title', textContent: '应用设置' })
    applicationSection.appendChild(applicationTitle)
    settingsRoot.appendChild(applicationSection)
  }

  const createdElements = []
  const doc = {
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
  return doc
}

test('getCommitDiffSettingsObserverTarget watches only the main content container', () => {
  const doc = createFakeDocument()
  assert.equal(getCommitDiffSettingsObserverTarget(doc), doc.mainContent)
  assert.equal(getCommitDiffSettingsObserverTarget(createFakeDocument({ withMainContent: false })), null)
  assert.equal(getCommitDiffSettingsObserverTarget(null), null)
})

test('ensureCommitDiffSettingsMount targets the application settings section', () => {
  const doc = createFakeDocument()
  const target = ensureCommitDiffSettingsMount(doc)

  assert.equal(target, doc.applicationSection)
  assert.equal(ensureCommitDiffSettingsMount(doc), target)
  assert.equal(doc.settingsRoot.children.length, 2)
  assert.equal(doc.createdElements.length, 0)
})

test('ensureCommitDiffSettingsMount returns null when application settings are absent', () => {
  const doc = createFakeDocument({ withApplication: false })
  const target = ensureCommitDiffSettingsMount(doc)

  assert.equal(target, null)
})

test('ensureCommitDiffSettingsMount returns null outside the settings page', () => {
  const doc = createFakeDocument()
  doc.querySelector = () => null

  assert.equal(ensureCommitDiffSettingsMount(doc), null)
})
