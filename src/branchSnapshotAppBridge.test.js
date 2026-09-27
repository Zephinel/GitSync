import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildBranchSnapshotAppPatch } from './branchSnapshotAppBridge.js'
import {
  registerBranchOverview,
  registerBranchStatus,
  resetBranchDomainStoreForTests,
} from './branchDomainStore.js'

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('App source directly owns branch and Stash integration without build-time rewriting', () => {
  const app = readSource('src/App.jsx')
  const vite = readSource('vite.config.js')

  assert.match(app, /import \{ useBranchSnapshotAppBridge \} from '\.\/branchSnapshotAppBridge\.js'/)
  assert.match(app, /import BranchManagementHoverAction from '\.\/BranchManagementHoverAction\.jsx'/)
  assert.match(app, /import RepoStashMenuItem from '\.\/RepoStashMenuItem\.jsx'/)
  assert.match(app, /useBranchSnapshotAppBridge\(\{[\s\S]*setRepoBranchOverviews,[\s\S]*setRepoStatuses,[\s\S]*setDismissedBranchAttentionKeys,/)
  assert.match(app, /const branchOverview = branchOverviewSnapshot \|\| null/)
  assert.doesNotMatch(app, /\bsetBranchOverview\b/)
  assert.match(app, /ariaLabel="仓库分支总览"[\s\S]*<BranchManagementHoverAction[\s\S]*branchOverviewLoading/)
  assert.match(app, /<RepoStashMenuItem[\s\S]*repo=\{repo\}[\s\S]*onOpenAccepted=\{closeMenu\}[\s\S]*repo-card__more-item--danger/)
  assert.equal((app.match(/useBranchSnapshotAppBridge\(/g) || []).length, 1)
  assert.equal((app.match(/<BranchManagementHoverAction/g) || []).length, 1)
  assert.equal((app.match(/<RepoStashMenuItem/g) || []).length, 1)

  assert.doesNotMatch(vite, /appBranchSnapshotBridgePlugin|viteAppBranchSnapshotBridgePlugin|transformAppForBranchSnapshotBridge/)
  assert.throws(() => readSource('src/viteAppBranchSnapshotBridgePlugin.js'))
})

test('builds repository-scoped App state patches from canonical snapshots', () => {
  resetBranchDomainStoreForTests()
  const overviewA = {
    current_branch: 'main',
    branches: [{ identity: 'remote:topic', name: 'origin/topic', is_remote_only: true, is_current: false }],
  }
  const statusA = { branch: 'main', behind: 0 }
  const overviewB = { current_branch: 'develop', branches: [] }

  registerBranchOverview('C:\\Repo-A\\', overviewA)
  registerBranchStatus('C:\\Repo-A\\', statusA)
  registerBranchOverview('/repo-b', overviewB)

  const patch = buildBranchSnapshotAppPatch([
    { id: 'a', path: 'c:/Repo-A' },
    { id: 'b', path: '/repo-b' },
  ], new Set(['C:\\Repo-A\\']))
  assert.deepEqual(patch.overviewByRepoId, { a: overviewA })
  assert.deepEqual(patch.statusByRepoId, { a: statusA })

  const fullPatch = buildBranchSnapshotAppPatch([
    { id: 'a', path: 'c:/Repo-A' },
    { id: 'b', path: '/repo-b' },
  ])
  assert.equal(fullPatch.overviewByRepoId.a, overviewA)
  assert.equal(fullPatch.overviewByRepoId.b, overviewB)
  assert.deepEqual(fullPatch.dismissedRepoIdsToClear, ['b'])
})

test('keeps runtime integration narrow while literal App source owns composition', () => {
  const vite = readSource('vite.config.js')
  const main = readSource('src/main.jsx')
  const snapshotBridge = readSource('src/branchSnapshotAppBridge.js')
  const hoverAction = readSource('src/BranchManagementHoverAction.jsx')
  const branchOpenBridge = readSource('src/branchManagementAppBridge.js')
  const stashMenu = readSource('src/RepoStashMenuItem.jsx')
  const stashLayer = readSource('src/RepoStashManagerLayer.jsx')
  const stashBridge = readSource('src/stashManagerAppBridge.js')

  assert.doesNotMatch(vite, /appBranchSnapshotBridgePlugin|viteAppBranchSnapshotBridgePlugin|transformAppForBranchSnapshotBridge/)
  assert.match(hoverAction, /dispatchBranchManagementOpen/)
  assert.doesNotMatch(hoverAction, /createPortal|MutationObserver|querySelector|getBoundingClientRect/)
  assert.doesNotMatch(branchOpenBridge, /document\.|MutationObserver|querySelector|getBoundingClientRect/)

  assert.match(stashMenu, /dispatchStashManagerOpen/)
  assert.doesNotMatch(stashMenu, /useState|<StashManagerDialog/)
  assert.match(stashLayer, /subscribeStashManagerOpen/)
  assert.match(stashLayer, /<StashManagerDialog/)
  assert.match(stashBridge, /let owner = null/)
  assert.match(stashBridge, /if \(typeof owner === 'function'\) owner\(target\)/)
  assert.match(stashBridge, /if \(owner === listener\) owner = null/)
  assert.doesNotMatch(stashBridge, /const listeners = new Set/)
  assert.match(main, /const RepoStashManagerLayer = lazy/)
  assert.match(main, /<RepoStashManagerLayer \/>/)

  assert.match(snapshotBridge, /subscribeBranchOperations/)
  assert.match(snapshotBridge, /getActiveBranchOperationPaths/)
  assert.doesNotMatch(snapshotBridge, /document\.|MutationObserver|querySelector/)
})
