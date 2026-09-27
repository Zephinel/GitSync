import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downloadReleaseAsset } from './download-release-asset.mjs'
import { assertReleaseTagIdentity, resolveTagCommitSha } from './verify-release-tag-identity.mjs'

const repository = 'Zephinel/GitSync'
const commitA = 'a'.repeat(40)
const commitB = 'b'.repeat(40)
const tagObject = 'c'.repeat(40)
const nestedTagObject = 'd'.repeat(40)

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'test response',
    headers: new Headers(headers),
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

test('lightweight tag resolves to the triggering GITHUB_SHA', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    return response({ ref: 'refs/tags/v0.1.0', object: { type: 'commit', sha: commitA } })
  }

  assert.equal(await assertReleaseTagIdentity({
    repository,
    tag: 'v0.1.0',
    expectedSha: commitA,
    token: 'secret',
    fetchImpl,
  }), commitA)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/git\/ref\/tags\/v0\.1\.0$/)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret')
})

test('tag identity mismatch rejects artifacts from a different workflow commit', async () => {
  await assert.rejects(assertReleaseTagIdentity({
    repository,
    tag: 'v0.1.0',
    expectedSha: commitA,
    token: 'secret',
    fetchImpl: async () => response({
      ref: 'refs/tags/v0.1.0',
      object: { type: 'commit', sha: commitB },
    }),
  }), /not workflow GITHUB_SHA/)
})

test('annotated tag and bounded tag-of-tag chain resolve to the commit', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    const value = String(url)
    calls.push(value)
    if (value.endsWith('/git/ref/tags/v0.1.0')) {
      return response({ ref: 'refs/tags/v0.1.0', object: { type: 'tag', sha: tagObject } })
    }
    if (value.endsWith(`/git/tags/${tagObject}`)) {
      return response({ sha: tagObject, object: { type: 'tag', sha: nestedTagObject } })
    }
    if (value.endsWith(`/git/tags/${nestedTagObject}`)) {
      return response({ sha: nestedTagObject, object: { type: 'commit', sha: commitA } })
    }
    throw new Error(`Unexpected request ${value}`)
  }

  assert.equal(await resolveTagCommitSha({
    repository,
    tag: 'v0.1.0',
    token: 'secret',
    fetchImpl,
  }), commitA)
  assert.equal(calls.length, 3)
})

test('annotated tag cycles and excessive nesting are rejected', async () => {
  const cycleFetch = async (url) => String(url).includes('/git/ref/')
    ? response({ ref: 'refs/tags/v0.1.0', object: { type: 'tag', sha: tagObject } })
    : response({ sha: tagObject, object: { type: 'tag', sha: tagObject } })
  await assert.rejects(resolveTagCommitSha({
    repository,
    tag: 'v0.1.0',
    token: 'secret',
    fetchImpl: cycleFetch,
  }), /cycle/)

  const deepFetch = async (url) => {
    const value = String(url)
    if (value.includes('/git/ref/')) {
      return response({ ref: 'refs/tags/v0.1.0', object: { type: 'tag', sha: tagObject } })
    }
    const sha = value.split('/').at(-1)
    const nextSha = (Number.parseInt(sha[0], 16) + 1).toString(16).repeat(40)
    return response({ sha, object: { type: 'tag', sha: nextSha } })
  }
  await assert.rejects(resolveTagCommitSha({
    repository,
    tag: 'v0.1.0',
    token: 'secret',
    fetchImpl: deepFetch,
    maxDepth: 2,
  }), /resolution limit/)
})

test('Release asset verification uses only the canonical API URL and does not forward its token on redirect', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      return response({}, 302, { location: 'https://release-assets.githubusercontent.com/signed/latest.json?token=asset' })
    }
    return response('remote-manifest-bytes')
  }

  const bytes = await downloadReleaseAsset({
    repository,
    assetId: 500,
    token: 'secret',
    fetchImpl,
  })
  assert.equal(bytes.toString('utf8'), 'remote-manifest-bytes')
  assert.equal(calls[0].url, 'https://api.github.com/repos/Zephinel/GitSync/releases/assets/500')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret')
  assert.equal(calls[1].options.headers.Authorization, undefined)
  assert.equal(calls[1].options.redirect, 'follow')
})

test('Release asset download rejects noncanonical repo, unsafe ID, and insecure redirect', async () => {
  await assert.rejects(downloadReleaseAsset({
    repository: 'other/repo', assetId: 1, token: 'secret', fetchImpl: async () => response('x'),
  }), /restricted/)
  await assert.rejects(downloadReleaseAsset({
    repository, assetId: '1.2', token: 'secret', fetchImpl: async () => response('x'),
  }), /positive integer/)
  await assert.rejects(downloadReleaseAsset({
    repository,
    assetId: 1,
    token: 'secret',
    fetchImpl: async () => response({}, 302, { location: 'http://evil.example/file' }),
  }), /unsafe Release asset redirect/)
})
