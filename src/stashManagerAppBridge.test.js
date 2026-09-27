import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchStashManagerOpen,
  normalizeStashManagerTarget,
  resetStashManagerAppBridgeForTests,
  subscribeStashManagerOpen,
} from './stashManagerAppBridge.js'

test.afterEach(() => resetStashManagerAppBridgeForTests())

test('normalizes repository and initial navigation intent without retaining menu DOM', () => {
  const onChanged = () => {}
  const target = normalizeStashManagerTarget({
    repoId: ' repo-1 ',
    repoName: ' GitSync ',
    repoPath: ' /tmp/GitSync ',
    stashId: ' stash-id ',
    initialOperation: 'pop',
    overlayParentId: ' working-changes ',
    onChanged,
    menuElement: {},
  })

  assert.equal(target.openId, 1)
  assert.equal(target.repoId, 'repo-1')
  assert.equal(target.repoName, 'GitSync')
  assert.equal(target.repoPath, '/tmp/GitSync')
  assert.equal(target.initialStashId, 'stash-id')
  assert.equal(target.initialOperation, 'pop')
  assert.equal(target.overlayParentId, 'working-changes')
  assert.equal(target.onChanged, onChanged)
  assert.equal('menuElement' in target, false)
  assert.equal(Object.isFrozen(target), true)
})

test('lazy owner receives the latest pending request and every later request exactly once', () => {
  assert.equal(dispatchStashManagerOpen({ repoPath: '/first' }), true)
  assert.equal(dispatchStashManagerOpen({ repoPath: '/latest', initialOperation: 'drop' }), true)

  const accepted = []
  const unsubscribe = subscribeStashManagerOpen((target) => accepted.push(target))
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].repoPath, '/latest')
  assert.equal(accepted[0].initialOperation, 'drop')

  assert.equal(dispatchStashManagerOpen({ repoPath: '/repo', repoName: 'Repo' }), true)
  assert.equal(dispatchStashManagerOpen({ repoPath: '/repo', initialOperation: 'pop' }), true)
  assert.equal(accepted.length, 3)
  assert.notEqual(accepted[1].openId, accepted[2].openId)
  assert.equal(accepted[1].repoName, 'Repo')
  assert.equal(accepted[2].initialOperation, 'pop')

  unsubscribe()
  assert.equal(dispatchStashManagerOpen({ repoPath: '/after-unmount' }), true)
})

test('a newer global owner replaces an old owner instead of creating two managers', () => {
  const first = []
  const second = []
  const unsubscribeFirst = subscribeStashManagerOpen((target) => first.push(target))
  const unsubscribeSecond = subscribeStashManagerOpen((target) => second.push(target))

  dispatchStashManagerOpen({ repoPath: '/repo' })
  assert.equal(first.length, 0)
  assert.equal(second.length, 1)

  unsubscribeFirst()
  dispatchStashManagerOpen({ repoPath: '/repo-2' })
  assert.equal(second.length, 2)
  unsubscribeSecond()
})

test('rejects invalid targets, invalid operations and invalid listeners safely', () => {
  assert.equal(normalizeStashManagerTarget({ repoPath: '  ' }), null)
  assert.equal(normalizeStashManagerTarget({ repoPath: '/repo', initialOperation: 'create' }).initialOperation, null)
  assert.equal(dispatchStashManagerOpen({ repoPath: ' ' }), false)
  const unsubscribe = subscribeStashManagerOpen(null)
  assert.equal(typeof unsubscribe, 'function')
  assert.doesNotThrow(unsubscribe)
})
