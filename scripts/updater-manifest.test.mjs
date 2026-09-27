import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildUpdaterManifest,
  validateUpdaterArtifacts,
  validateUpdaterManifest,
} from './updater-manifest.mjs'
import { validateReleaseState } from './validate-release-state.mjs'

const version = '0.1.0'
const tag = 'v0.1.0'
const repository = 'Zephinel/GitSync'
const pubDate = '2026-09-27T00:00:00.000Z'
const signature = (signedVersion = version) => Buffer.from(
  'untrusted comment: minisign signature\n'
    + 'AAAAAAAAAAAAAAAAAAAAAA==\n'
    + 'trusted comment: file:GitSync\tversion:' + signedVersion + '\n',
).toString('base64')

const files = [
  'macos/GitSync.app.tar.gz',
  'macos/GitSync.app.tar.gz.sig',
  'macos/updater-build-target-darwin-aarch64.txt',
  'windows/GitSync-setup.exe',
  'windows/GitSync-setup.exe.sig',
  'windows/updater-build-target-windows-x86_64.txt',
]
const signatures = {
  'macos/GitSync.app.tar.gz.sig': signature(),
  'windows/GitSync-setup.exe.sig': signature(),
}
const builtTargets = {
  'darwin-aarch64': 'darwin-aarch64',
  'windows-x86_64': 'windows-x86_64',
}
const inputs = { files, signatures, builtTargets, version, tag, repository, pubDate, notes: 'First public release' }

test('public manifest binds both signed updater bundles to the new repository and tag', () => {
  const manifest = buildUpdaterManifest(inputs)
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'windows-x86_64'])
  assert.equal(
    manifest.platforms['darwin-aarch64'].url,
    'https://github.com/Zephinel/GitSync/releases/download/v0.1.0/GitSync.app.tar.gz',
  )
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://github.com/Zephinel/GitSync/releases/download/v0.1.0/GitSync-setup.exe',
  )
  assert.equal(validateUpdaterManifest({ manifest, version, tag, repository }), manifest)
})

test('manifest rejects the old repository, unsafe URLs, wrong signatures, and incomplete builds', () => {
  assert.throws(() => buildUpdaterManifest({ ...inputs, repository: 'legacy-owner/GitSync' }), /must target/)
  assert.throws(() => buildUpdaterManifest({
    ...inputs,
    signatures: { ...signatures, 'windows/GitSync-setup.exe.sig': signature('0.0.9') },
  }), /signature version/)
  assert.throws(() => validateUpdaterArtifacts({
    files: files.filter((file) => !file.includes('windows-x86_64.txt')),
    signatures,
    builtTargets,
    version,
  }), /build target marker/)
  const manifest = buildUpdaterManifest(inputs)
  manifest.platforms['windows-x86_64'].url += '?redirect=https://evil.example'
  assert.throws(() => validateUpdaterManifest({ manifest, version, tag, repository }), /exact public Release asset/)
})

test('draft and published Release validation requires the exact uploaded asset set', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gitsync-public-release-'))
  const assetNames = [
    'GitSync.app.tar.gz',
    'GitSync.app.tar.gz.sig',
    'GitSync-setup.exe',
    'GitSync-setup.exe.sig',
    'GitSync.exe',
    'GitSync_0.1.0_aarch64.dmg',
    'latest.json',
  ]
  try {
    await mkdir(path.join(directory, 'macos'))
    await mkdir(path.join(directory, 'windows'))
    for (const name of assetNames) {
      const subdir = name.includes('.app.') || name.endsWith('.dmg') ? 'macos' : 'windows'
      await writeFile(path.join(directory, subdir, name), 'asset bytes')
    }
    const release = {
      id: 1,
      tag_name: tag,
      draft: true,
      prerelease: false,
      assets: assetNames.map((name, index) => ({
        id: index + 1,
        name,
        size: 11,
        state: 'uploaded',
      })),
    }
    const manifest = buildUpdaterManifest(inputs)
    const args = { release, manifest, assetsDirectory: directory, version, tag, repository }
    assert.equal(await validateReleaseState({ ...args, expectedDraft: true }), release)
    await assert.rejects(validateReleaseState({
      ...args,
      expectedDraft: true,
      release: { ...release, assets: release.assets.slice(1) },
    }), /asset count/)
    const published = { ...release, draft: false }
    assert.equal(await validateReleaseState({
      ...args,
      expectedDraft: false,
      release: published,
    }), published)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
