export const AI_SETTINGS_MOUNT_ID = 'gitsync-ai-settings-section'

function getDocument(documentObject) {
  if (documentObject) return documentObject
  if (typeof document === 'undefined') return null
  return document
}

export function getAiSettingsObserverTarget(documentObject) {
  const doc = getDocument(documentObject)
  if (!doc) return null
  return doc.querySelector('.main-content')
}

export function ensureAiSettingsMount(documentObject) {
  const doc = getDocument(documentObject)
  if (!doc) return null
  const settingsRoot = doc.querySelector('.settings')
  if (!settingsRoot) return null

  let mount = doc.getElementById(AI_SETTINGS_MOUNT_ID)
  if (!mount) {
    mount = doc.createElement('div')
    mount.id = AI_SETTINGS_MOUNT_ID

    const applicationSection = Array.from(settingsRoot.querySelectorAll('.settings__section'))
      .find((section) => section.querySelector('.settings__section-title')?.textContent?.trim() === '应用设置')
    if (applicationSection) settingsRoot.insertBefore(mount, applicationSection)
    else settingsRoot.appendChild(mount)
  }

  return mount
}
