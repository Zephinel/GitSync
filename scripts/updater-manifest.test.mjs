import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

test('manifest creation rejects a forged trusted comment before publication', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gitsync-forged-updater-'))
  try {
    for (const [target, definition] of Object.entries({
      macos: { bundle: 'GitSync.app.tar.gz', marker: 'updater-build-target-darwin-aarch64.txt', value: 'darwin-aarch64' },
      windows: { bundle: 'GitSync-setup.exe', marker: 'updater-build-target-windows-x86_64.txt', value: 'windows-x86_64' },
    })) {
      const folder = path.join(directory, target)
      await mkdir(folder)
      await writeFile(path.join(folder, definition.bundle), 'unsigned bundle')
      await writeFile(path.join(folder, definition.bundle + '.sig'), signature())
      await writeFile(path.join(folder, definition.marker), definition.value)
    }
    const result = spawnSync(process.execPath, ['scripts/create-updater-manifest.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        RELEASE_ASSETS_DIR: directory,
        APP_VERSION: version,
        TAG: tag,
        GITHUB_REPOSITORY: repository,
      },
      encoding: 'utf8',
    })
    if (result.error) throw result.error
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /invalid updater signature|updater signature verification failed/)
    assert.equal(existsSync(path.join(directory, 'latest.json')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

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
        digest: 'sha256:' + createHash('sha256').update('asset bytes').digest('hex'),
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
    await writeFile(path.join(directory, 'windows', 'GitSync.exe'), 'other bytes')
    await assert.rejects(validateReleaseState({ ...args, expectedDraft: true }), /digest does not match: GitSync.exe/)
    await writeFile(path.join(directory, 'windows', 'GitSync.exe'), 'asset bytes')
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
