import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateUpdaterManifest } from './updater-manifest.mjs'

const REQUIRED_NAMES = new Set([
  'GitSync.app.tar.gz',
  'GitSync.app.tar.gz.sig',
  'GitSync-setup.exe',
  'GitSync-setup.exe.sig',
  'GitSync.exe',
  'latest.json',
])

async function listReleaseFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = new Map()
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const [name, file] of await listReleaseFiles(path.join(directory, entry.name))) {
        if (files.has(name)) throw new Error('Duplicate release asset name: ' + name)
        files.set(name, file)
      }
      continue
    }
    if (!entry.isFile()) continue
    const name = entry.name
    if (REQUIRED_NAMES.has(name) || (name.startsWith('GitSync_') && name.endsWith('.dmg'))) {
      if (files.has(name)) throw new Error('Duplicate release asset name: ' + name)
      files.set(name, path.join(directory, name))
    }
  }
  return files
}

async function releaseFiles(directory) {
  const files = await listReleaseFiles(directory)
  const dmgs = [...files.keys()].filter((name) => name.endsWith('.dmg'))
  if (dmgs.length !== 1 || [...REQUIRED_NAMES].some((name) => !files.has(name)) || files.size !== 7) {
    throw new Error('Release must contain exactly one DMG and all six required updater/installer assets')
  }
  return files
}

export async function validateReleaseState({
  release,
  manifest,
  assetsDirectory,
  expectedDraft,
  version,
  tag,
  repository,
}) {
  validateUpdaterManifest({ manifest, version, tag, repository })
  if (
    !release
    || release.tag_name !== tag
    || release.draft !== expectedDraft
    || release.prerelease !== false
    || !Number.isSafeInteger(release.id)
    || release.id < 1
  ) {
    throw new Error('Release identity, draft state, or latest-channel status does not match')
  }
  const localFiles = await releaseFiles(assetsDirectory)
  const remoteAssets = Array.isArray(release.assets) ? release.assets : []
  if (remoteAssets.length !== localFiles.size) {
    throw new Error('Release asset count does not match the validated local bundle')
  }
  const seen = new Set()
  for (const asset of remoteAssets) {
    if (!localFiles.has(asset.name) || seen.has(asset.name) || asset.state !== 'uploaded') {
      throw new Error('Release has a missing, duplicate, or incomplete asset')
    }
    const localSize = (await stat(localFiles.get(asset.name))).size
    if (!Number.isSafeInteger(asset.id) || asset.id < 1 || asset.size !== localSize || localSize < 1) {
      throw new Error('Release asset identity or size does not match: ' + asset.name)
    }
    const localDigest = 'sha256:' + createHash('sha256')
      .update(await readFile(localFiles.get(asset.name)))
      .digest('hex')
    if (asset.digest !== localDigest) {
      throw new Error('Release asset digest does not match: ' + asset.name)
    }
    seen.add(asset.name)
  }
  return release
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [releasePath, expectedState, assetsDirectory = 'release-assets'] = process.argv.slice(2)
  const version = process.env.APP_VERSION?.trim()
  const tag = process.env.TAG?.trim()
  const repository = process.env.GITHUB_REPOSITORY?.trim()
  if (!releasePath || !['draft', 'published'].includes(expectedState) || !version || !tag || !repository) {
    throw new Error('Release JSON, draft/published state, APP_VERSION, TAG, and GITHUB_REPOSITORY are required')
  }
  const [release, manifest] = await Promise.all([
    readFile(releasePath, 'utf8').then(JSON.parse),
    readFile(path.join(assetsDirectory, 'latest.json'), 'utf8').then(JSON.parse),
  ])
  await validateReleaseState({
    release,
    manifest,
    assetsDirectory,
    expectedDraft: expectedState === 'draft',
    version,
    tag,
    repository,
  })
  process.stdout.write('Validated ' + expectedState + ' Release assets for ' + version + '.\n')
}
