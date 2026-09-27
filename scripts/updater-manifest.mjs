import path from 'node:path'
import semver from 'semver'

export const RELEASE_REPOSITORY = 'Zephinel/GitSync'

export const UPDATER_TARGETS = Object.freeze({
  'darwin-aarch64': {
    artifactName: 'GitSync.app.tar.gz',
    markerName: 'updater-build-target-darwin-aarch64.txt',
  },
  'windows-x86_64': {
    artifactName: 'GitSync-setup.exe',
    markerName: 'updater-build-target-windows-x86_64.txt',
  },
})

function requireVersionAndTag(version, tag, repository) {
  if (repository !== RELEASE_REPOSITORY) {
    throw new Error('Updater releases must target ' + RELEASE_REPOSITORY)
  }
  if (semver.valid(version, { loose: false }) !== version) {
    throw new Error('Invalid updater version: ' + String(version))
  }
  if (tag !== 'v' + version) {
    throw new Error('Release tag must be v' + version)
  }
}

function requireSignatureVersion(signature, version, label) {
  const encoded = String(signature || '').trim()
  const decoded = Buffer.from(encoded, 'base64')
  if (
    !encoded
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    || decoded.toString('base64') !== encoded
  ) {
    throw new Error('Invalid updater signature: ' + label)
  }
  const trustedComment = decoded.toString('utf8')
    .split(/\r?\n/)
    .find((line) => line.startsWith('trusted comment: '))
    ?.slice('trusted comment: '.length)
  const signedVersion = trustedComment
    ?.split('\t')
    .find((field) => field.startsWith('version:'))
    ?.slice('version:'.length)
  if (signedVersion !== version) {
    throw new Error('Updater signature version does not match ' + version + ': ' + label)
  }
  return encoded
}

function releaseAssetUrl(repository, tag, artifactName) {
  return [
    'https://github.com',
    repository.split('/').map(encodeURIComponent).join('/'),
    'releases',
    'download',
    encodeURIComponent(tag),
    encodeURIComponent(artifactName),
  ].join('/')
}

export function validateUpdaterArtifacts({ files, signatures, builtTargets, version }) {
  if (semver.valid(version, { loose: false }) !== version) {
    throw new Error('Invalid updater version: ' + String(version))
  }
  const normalizedFiles = (Array.isArray(files) ? files : [])
    .map((file) => String(file).replaceAll('\\', '/'))
  const artifacts = {}
  for (const [target, definition] of Object.entries(UPDATER_TARGETS)) {
    const markers = normalizedFiles.filter((file) => path.posix.basename(file) === definition.markerName)
    if (markers.length !== 1 || builtTargets?.[target] !== target) {
      throw new Error('Missing or mismatched build target marker for ' + target)
    }
    const bundles = normalizedFiles.filter((file) => path.posix.basename(file) === definition.artifactName)
    if (bundles.length !== 1) {
      throw new Error('Expected exactly one updater artifact: ' + definition.artifactName)
    }
    const bundlePath = bundles[0]
    const signaturePath = bundlePath + '.sig'
    if (!normalizedFiles.includes(signaturePath)) {
      throw new Error('Missing updater signature: ' + signaturePath)
    }
    artifacts[target] = {
      artifactName: definition.artifactName,
      signature: requireSignatureVersion(signatures?.[signaturePath], version, signaturePath),
    }
  }
  return artifacts
}

export function validateUpdaterManifest({ manifest, version, tag, repository }) {
  requireVersionAndTag(version, tag, repository)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Updater manifest must be an object')
  }
  if (Object.keys(manifest).sort().join(',') !== 'notes,platforms,pub_date,version') {
    throw new Error('Updater manifest has unexpected fields')
  }
  if (manifest.version !== version || typeof manifest.notes !== 'string') {
    throw new Error('Updater manifest version or notes do not match the release')
  }
  const date = new Date(manifest.pub_date)
  if (
    typeof manifest.pub_date !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.pub_date)
    || Number.isNaN(date.getTime())
    || date.toISOString() !== manifest.pub_date
  ) {
    throw new Error('Updater manifest pub_date must be a canonical UTC timestamp')
  }
  const targets = Object.keys(UPDATER_TARGETS).sort()
  if (
    !manifest.platforms
    || typeof manifest.platforms !== 'object'
    || Array.isArray(manifest.platforms)
    || Object.keys(manifest.platforms).sort().join(',') !== targets.join(',')
  ) {
    throw new Error('Updater manifest must contain macOS and Windows targets')
  }
  for (const target of targets) {
    const entry = manifest.platforms[target]
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'signature,url'
      || entry.url !== releaseAssetUrl(repository, tag, UPDATER_TARGETS[target].artifactName)
    ) {
      throw new Error('Updater URL must point to the exact public Release asset for ' + target)
    }
    requireSignatureVersion(entry.signature, version, target)
  }
  return manifest
}

export function buildUpdaterManifest({
  files,
  signatures,
  builtTargets,
  version,
  tag,
  repository,
  notes = '',
  pubDate = new Date().toISOString(),
}) {
  requireVersionAndTag(version, tag, repository)
  const artifacts = validateUpdaterArtifacts({ files, signatures, builtTargets, version })
  const platforms = {}
  for (const [target, artifact] of Object.entries(artifacts)) {
    platforms[target] = {
      url: releaseAssetUrl(repository, tag, artifact.artifactName),
      signature: artifact.signature,
    }
  }
  const manifest = { version, notes, pub_date: pubDate, platforms }
  return validateUpdaterManifest({ manifest, version, tag, repository })
}
