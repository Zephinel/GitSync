import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildUpdaterManifest, UPDATER_TARGETS } from './updater-manifest.mjs'

async function listFiles(directory, parent = '') {
  const entries = await readdir(path.join(directory, parent), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relativePath = path.join(parent, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(directory, relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath.replaceAll('\\', '/'))
    }
  }
  return files
}

function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith('## ' + version + ' ('))
  if (start < 0) throw new Error('CHANGELOG.md has no entry for ' + version)
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1
  const notes = lines.slice(start + 1, end).join('\n').trim()
  if (!notes) throw new Error('CHANGELOG.md entry is empty for ' + version)
  return notes
}

const directory = process.env.RELEASE_ASSETS_DIR || 'release-assets'
const version = process.env.APP_VERSION?.trim()
const tag = process.env.TAG?.trim()
const repository = process.env.GITHUB_REPOSITORY?.trim()
if (!version || !tag || !repository) {
  throw new Error('APP_VERSION, TAG, and GITHUB_REPOSITORY are required')
}

const files = await listFiles(directory)
const builtTargets = {}
const signatures = {}
for (const [target, definition] of Object.entries(UPDATER_TARGETS)) {
  const markers = files.filter((file) => path.posix.basename(file) === definition.markerName)
  if (markers.length !== 1) throw new Error('Expected one build marker for ' + target)
  builtTargets[target] = (await readFile(path.join(directory, markers[0]), 'utf8')).trim()

  const bundles = files.filter((file) => path.posix.basename(file) === definition.artifactName)
  if (bundles.length !== 1) throw new Error('Expected one updater artifact for ' + target)
  const signaturePath = bundles[0] + '.sig'
  signatures[signaturePath] = await readFile(path.join(directory, signaturePath), 'utf8')
}

const changelog = await readFile('CHANGELOG.md', 'utf8')
const manifest = buildUpdaterManifest({
  files,
  signatures,
  builtTargets,
  version,
  tag,
  repository,
  notes: releaseNotes(changelog, version),
})
await writeFile(
  path.join(directory, 'latest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  { flag: 'wx' },
)
process.stdout.write('Created signed macOS and Windows updater manifest for ' + version + '.\n')
