import { pathToFileURL } from 'node:url'

const MAX_ANNOTATED_TAG_DEPTH = 8
const API_ROOT = 'https://api.github.com'

function validateSha(value, label) {
  const sha = String(value || '').trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) {
    throw new Error(`${label} must be a full Git object SHA`)
  }
  return sha.toLowerCase()
}

function validateRepository(repository) {
  const normalized = String(repository || '').trim()
  if (!/^[^/]+\/[^/]+$/.test(normalized)) {
    throw new Error(`Invalid GitHub repository: ${normalized || '(empty)'}`)
  }
  return normalized
}

async function getGitHubJson(url, { token, fetchImpl }) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitSync-release-tag-identity-check',
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`GitHub tag identity API returned ${response.status}: ${body?.message || response.statusText}`)
  }
  return body
}

export async function resolveTagCommitSha({
  repository,
  tag,
  token,
  fetchImpl = fetch,
  maxDepth = MAX_ANNOTATED_TAG_DEPTH,
}) {
  const repo = validateRepository(repository)
  const tagName = String(tag || '').trim()
  if (!tagName || tagName.startsWith('refs/')) throw new Error('A Git tag name is required')
  if (!token) throw new Error('GitHub token is required to verify the remote tag')
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new Error('Annotated tag resolution depth must be a positive integer')
  }

  const encodedRepository = repo.split('/').map(encodeURIComponent).join('/')
  const encodedTag = encodeURIComponent(tagName)
  const ref = await getGitHubJson(
    `${API_ROOT}/repos/${encodedRepository}/git/ref/tags/${encodedTag}`,
    { token, fetchImpl },
  )
  if (ref.ref !== `refs/tags/${tagName}`) {
    throw new Error(`GitHub returned tag ref ${ref.ref || '(empty)'}, expected refs/tags/${tagName}`)
  }

  let object = ref.object
  const visitedTagObjects = new Set()
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const objectSha = validateSha(object?.sha, 'Tag object SHA')
    if (object.type === 'commit') return objectSha
    if (object.type !== 'tag') {
      throw new Error(`Tag ${tagName} resolves to unsupported Git object type ${String(object.type)}`)
    }
    if (depth === maxDepth) {
      throw new Error(`Tag ${tagName} exceeds the ${maxDepth}-object annotated tag resolution limit`)
    }
    if (visitedTagObjects.has(objectSha)) {
      throw new Error(`Tag ${tagName} contains an annotated tag object cycle at ${objectSha}`)
    }
    visitedTagObjects.add(objectSha)

    const annotatedTag = await getGitHubJson(
      `${API_ROOT}/repos/${encodedRepository}/git/tags/${objectSha}`,
      { token, fetchImpl },
    )
    if (validateSha(annotatedTag.sha, 'Annotated tag response SHA') !== objectSha) {
      throw new Error(`GitHub returned a mismatched annotated tag object for ${objectSha}`)
    }
    object = annotatedTag.object
  }

  throw new Error(`Tag ${tagName} could not be resolved to a commit`)
}

export async function assertReleaseTagIdentity({
  repository,
  tag,
  expectedSha,
  token,
  fetchImpl = fetch,
}) {
  const expected = validateSha(expectedSha, 'Expected GITHUB_SHA')
  const resolved = await resolveTagCommitSha({ repository, tag, token, fetchImpl })
  if (resolved !== expected) {
    throw new Error(`Tag ${tag} resolves to ${resolved}, not workflow GITHUB_SHA ${expected}`)
  }
  return resolved
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY?.trim()
  const tag = process.env.TAG?.trim()
  const expectedSha = process.env.EXPECTED_GITHUB_SHA?.trim() || process.env.GITHUB_SHA?.trim()
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!repository || !tag || !expectedSha || !token) {
    throw new Error('GITHUB_REPOSITORY, TAG, EXPECTED_GITHUB_SHA/GITHUB_SHA, and GitHub token are required')
  }
  const resolvedSha = await assertReleaseTagIdentity({ repository, tag, expectedSha, token })
  process.stdout.write(`${resolvedSha}\n`)
}
