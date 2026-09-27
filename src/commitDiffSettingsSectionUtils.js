function getDocument(documentObject) {
  if (documentObject) return documentObject
  if (typeof document === 'undefined') return null
  return document
}

export function getCommitDiffSettingsObserverTarget(documentObject) {
  const doc = getDocument(documentObject)
  if (!doc) return null
  return doc.querySelector('.main-content')
}

export function ensureCommitDiffSettingsMount(documentObject) {
  const doc = getDocument(documentObject)
  if (!doc) return null
  const settingsRoot = doc.querySelector('.settings')
  if (!settingsRoot) return null

  return Array.from(settingsRoot.querySelectorAll('.settings__section'))
    .find((section) => section.querySelector('.settings__section-title')?.textContent?.trim() === '应用设置') || null
}
