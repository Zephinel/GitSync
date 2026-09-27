import assert from 'node:assert/strict'
import test from 'node:test'
import { BundleType } from '@tauri-apps/api/app'
import { supportsUpdaterForBundle } from './appUpdaterBundleSupport.js'

test('macOS app bundle supports the application updater', () => {
  assert.equal(supportsUpdaterForBundle('macos', BundleType.App), true)
})

test('Windows NSIS bundle supports the application updater', () => {
  assert.equal(supportsUpdaterForBundle('windows', BundleType.Nsis), true)
})

test('Windows portable and other installer types do not support the application updater', () => {
  assert.equal(supportsUpdaterForBundle('windows', undefined), false)
  assert.equal(supportsUpdaterForBundle('windows', BundleType.Msi), false)
})
