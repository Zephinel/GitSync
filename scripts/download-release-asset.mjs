import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const RELEASE_REPOSITORY = 'Zephinel/GitSync'
const API_ROOT = 'https://api.github.com'

function parseAssetId(value) {
  const text = String(value ?? '')
  if (!/^[1-9]\d*$/.test(text)) throw new Error('Release asset ID must be a positive integer')
  const assetId = Number(text)
  if (!Number.isSafeInteger(assetId)) throw new Error('Release asset ID exceeds the safe integer range')
  return assetId
}

function releaseAssetUrl(repository, assetId) {
  if (repository !== RELEASE_REPOSITORY) {
    throw new Error(`Release asset downloads are restricted to ${RELEASE_REPOSITORY}`)
  }
  return `${API_ROOT}/repos/${RELEASE_REPOSITORY}/releases/assets/${parseAssetId(assetId)}`
}

function requireHttpsRedirect(location) {
  let target
  try {
    target = new URL(location)
  } catch {
    throw new Error('GitHub returned an invalid Release asset redirect URL')
  }
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw new Error('GitHub returned an unsafe Release asset redirect URL')
  }
  return target.href
}

async function requireResponseBytes(response, label) {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${label} returned ${response.status}: ${body.slice(0, 240) || response.statusText}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error(`${label} returned an empty Release asset`)
  return bytes
}

export async function downloadReleaseAsset({
  repository,
  assetId,
  token,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error('GitHub token is required to verify the Release asset')
  const url = releaseAssetUrl(repository, assetId)
  const response = await fetchImpl(url, {
    redirect: 'manual',
    headers: {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitSync-release-verification',
    },
  })

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (!location) throw new Error('GitHub Release asset redirect is missing Location')
    const target = requireHttpsRedirect(location)
    // The OAuth token is never forwarded to the signed asset URL.
    const redirected = await fetchImpl(target, {
      redirect: 'follow',
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'GitSync-release-verification',
      },
    })
    return requireResponseBytes(redirected, 'GitHub Release asset redirect')
  }

  return requireResponseBytes(response, 'GitHub Release asset API')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [assetId, outputPath] = process.argv.slice(2)
  const repository = process.env.GITHUB_REPOSITORY?.trim()
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!assetId || !outputPath || !repository || !token) {
    throw new Error('Asset ID, output path, GITHUB_REPOSITORY, and GitHub token are required')
  }
  const bytes = await downloadReleaseAsset({ repository, assetId, token })
  await writeFile(outputPath, bytes, { flag: 'wx' })
  process.stdout.write(`Downloaded Release asset ${assetId} to ${outputPath}.\n`)
}
