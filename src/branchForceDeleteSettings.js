export const BRANCH_FORCE_DELETE_DEFAULT_STORAGE_KEY = 'gitsync-branch-force-delete-default'

export function readBranchForceDeleteDefault(storage = globalThis?.localStorage) {
  try {
    return storage?.getItem?.(BRANCH_FORCE_DELETE_DEFAULT_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeBranchForceDeleteDefault(value, storage = globalThis?.localStorage) {
  const enabled = value === true
  try {
    storage?.setItem?.(BRANCH_FORCE_DELETE_DEFAULT_STORAGE_KEY, String(enabled))
  } catch {
    // Keep the current UI state even when persistent storage is unavailable.
  }
  return enabled
}
