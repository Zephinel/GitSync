import { BundleType } from '@tauri-apps/api/app'

export function supportsUpdaterForBundle(platform, bundleType) {
  if (platform === 'macos') return bundleType === BundleType.App
  if (platform === 'windows') return bundleType === BundleType.Nsis
  return false
}
