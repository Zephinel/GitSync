import test from 'node:test'
import assert from 'node:assert/strict'
import {
  areBranchOperationOverlayLayoutsEqual,
  collectBranchOperationOverlays,
  getLockedBranchAttentionPath,
} from './branchManagementOperationOverlay.js'

function createElement({ text = '', rect = null, connected = true, attributes = {}, children = {} } = {}) {
  return {
    textContent: text,
    isConnected: connected,
    getAttribute: (name) => attributes[name] || '',
    getBoundingClientRect: () => rect || { top: 0, left: 0, width: 0, height: 0 },
    querySelector: (selector) => children[selector] || null,
  }
}

test('collects only active repository attention surfaces', () => {
  const attention = createElement({ rect: { top: 10.4, left: 20.6, width: 300.2, height: 42.3 } })
  const activeCard = createElement({
    attributes: { 'data-repo-card-id': 'repo-1' },
    children: {
      '.repo-card__path-text': createElement({ text: '/tmp/repo' }),
      '.repo-card__name': createElement({ text: 'Repo' }),
      '.repo-card__branch-attention': attention,
    },
  })
  const inactiveCard = createElement({
    attributes: { 'data-repo-card-id': 'repo-2' },
    children: {
      '.repo-card__path-text': createElement({ text: '/tmp/other' }),
      '.repo-card__name': createElement({ text: 'Other' }),
      '.repo-card__branch-attention': createElement({ rect: { top: 60, left: 20, width: 300, height: 42 } }),
    },
  })
  const documentObject = { querySelectorAll: () => [activeCard, inactiveCard] }

  assert.deepEqual(collectBranchOperationOverlays(documentObject, new Set(['/tmp/repo'])), [{
    key: 'repo-1:0',
    repoPath: '/tmp/repo',
    repoName: 'Repo',
    element: attention,
    style: {
      position: 'fixed',
      top: '10px',
      left: '21px',
      width: '300px',
      height: '42px',
    },
  }])
})

test('identifies keyboard and click targets locked by an active branch operation', () => {
  const repoCard = {
    querySelector: (selector) => selector === '.repo-card__path-text'
      ? { textContent: '/tmp/repo/' }
      : null,
  }
  const attention = { closest: (selector) => selector === '.repo-card' ? repoCard : null }
  const target = { closest: (selector) => selector === '.repo-card__branch-attention' ? attention : null }

  assert.equal(getLockedBranchAttentionPath(target, new Set(['/tmp/repo'])), '/tmp/repo')
  assert.equal(getLockedBranchAttentionPath(target, new Set(['/tmp/other'])), '')
  assert.equal(getLockedBranchAttentionPath(null, new Set(['/tmp/repo'])), '')
})

test('ignores disconnected or zero-size attention surfaces', () => {
  const disconnected = createElement({ connected: false, rect: { top: 1, left: 1, width: 100, height: 20 } })
  const zeroSize = createElement({ rect: { top: 1, left: 1, width: 0, height: 20 } })
  const cards = [disconnected, zeroSize].map((attention, index) => createElement({
    attributes: { 'data-repo-card-id': `repo-${index}` },
    children: {
      '.repo-card__path-text': createElement({ text: '/tmp/repo' }),
      '.repo-card__branch-attention': attention,
    },
  }))

  assert.deepEqual(
    collectBranchOperationOverlays({ querySelectorAll: () => cards }, new Set(['/tmp/repo'])),
    []
  )
})

test('layout equality includes accessible identity, live element and geometry', () => {
  const element = {}
  const base = [{
    key: 'repo:0',
    repoPath: '/repo',
    repoName: 'Repo',
    element,
    style: { top: '1px', left: '2px', width: '3px', height: '4px' },
  }]

  assert.equal(areBranchOperationOverlayLayoutsEqual(base, [{ ...base[0], style: { ...base[0].style } }]), true)
  assert.equal(areBranchOperationOverlayLayoutsEqual(base, [{ ...base[0], repoName: 'Renamed' }]), false)
  assert.equal(areBranchOperationOverlayLayoutsEqual(base, [{ ...base[0], element: {} }]), false)
  assert.equal(areBranchOperationOverlayLayoutsEqual(base, [{ ...base[0], style: { ...base[0].style, top: '2px' } }]), false)
})
