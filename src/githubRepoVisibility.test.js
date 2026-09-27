import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getExistingGithubRepoNameFallbackKeys,
  getGithubRepoFullNameKey,
  getGithubRepoNameKey,
  isGithubRepoAlreadyAdded,
} from './githubRepoVisibility.js'

test('normalizes github repo full name and name keys', () => {
  assert.equal(getGithubRepoFullNameKey({ full_name: 'ExampleUser/SampleRepo' }), 'exampleuser/samplerepo')
  assert.equal(getGithubRepoNameKey({ name: 'SampleRepo' }), 'samplerepo')
})

test('detects added github repos by exact owner and repo full name', () => {
  const existingFullNameKeys = new Set(['exampleuser/samplerepo'])
  const existingNameKeys = new Set()

  assert.equal(
    isGithubRepoAlreadyAdded(
      { full_name: 'exampleuser/SampleRepo', name: 'SampleRepo' },
      existingFullNameKeys,
      existingNameKeys
    ),
    true
  )
})

test('falls back to local repo name when no github remote full name is available', () => {
  const existingFullNameKeys = new Set()
  const existingNameKeys = new Set(['samplerepo'])

  assert.equal(
    isGithubRepoAlreadyAdded(
      { full_name: 'exampleuser/SampleRepo', name: 'SampleRepo' },
      existingFullNameKeys,
      existingNameKeys
    ),
    true
  )
})

test('uses local repo names as fallback only when github remote full name is unavailable', () => {
  const existingNameKeys = getExistingGithubRepoNameFallbackKeys([
    { name: 'SampleRepo', remote: '' },
    { name: 'AnotherRepo', remote: 'git@github.com:exampleuser/AnotherRepo.git' },
  ], (remote) => (remote ? 'exampleuser/anotherrepo' : ''))

  assert.deepEqual(Array.from(existingNameKeys), ['samplerepo'])
})

test('does not hide unrelated github repos', () => {
  const existingFullNameKeys = new Set(['exampleuser/samplerepo'])
  const existingNameKeys = new Set(['samplerepo'])

  assert.equal(
    isGithubRepoAlreadyAdded(
      { full_name: 'exampleuser/AnotherRepo', name: 'AnotherRepo' },
      existingFullNameKeys,
      existingNameKeys
    ),
    false
  )
})
