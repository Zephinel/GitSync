export const COMMIT_DIFF_SETTINGS_STORAGE_KEY = 'gitsync-commit-diff-settings'
export const COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY = 'gitsync-settings'
export const COMMIT_DIFF_VIEW_STYLE_CHANGED_EVENT = 'gitsync:commit-diff-view-style-changed'

export const COMMIT_DIFF_VIEW_STYLE = {
  unified: 'unified',
  split: 'split',
}

export function normalizeCommitDiffViewStyle(value) {
  return value === COMMIT_DIFF_VIEW_STYLE.split
    ? COMMIT_DIFF_VIEW_STYLE.split
    : COMMIT_DIFF_VIEW_STYLE.unified
}

export function readSettingsObject(storageKey = COMMIT_DIFF_SETTINGS_STORAGE_KEY) {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readCommitDiffViewStyleFrom(storageKey) {
  const settings = readSettingsObject(storageKey)
  return settings.commitDiffViewStyle || settings.diffViewStyle
}

export function readCommitDiffViewStyle() {
  const storedStyle = readCommitDiffViewStyleFrom(COMMIT_DIFF_SETTINGS_STORAGE_KEY)
  if (storedStyle) return normalizeCommitDiffViewStyle(storedStyle)
  return normalizeCommitDiffViewStyle(readCommitDiffViewStyleFrom(COMMIT_DIFF_LEGACY_SETTINGS_STORAGE_KEY))
}

export function writeCommitDiffViewStyle(value) {
  const commitDiffViewStyle = normalizeCommitDiffViewStyle(value)
  if (typeof localStorage !== 'undefined') {
    try {
      const settings = readSettingsObject()
      localStorage.setItem(
        COMMIT_DIFF_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          ...settings,
          commitDiffViewStyle,
        })
      )
    } catch {
      // Keep the UI responsive even if local storage is unavailable.
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(COMMIT_DIFF_VIEW_STYLE_CHANGED_EVENT, {
      detail: { commitDiffViewStyle },
    }))
  }

  return commitDiffViewStyle
}
