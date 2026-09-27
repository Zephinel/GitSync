import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  dispatchBranchManagementOpen,
  normalizeBranchManagementOpenDetail,
  resetBranchManagementAppBridgeForTests,
  subscribeBranchManagementOpen,
} from './branchManagementAppBridge.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('normalizes complete-view context to primitive repository identity', () => {
  const normalized = normalizeBranchManagementOpenDetail({
    repoId: ' repo-1 ',
    repoName: ' GitSync ',
    repoPath: ' /tmp/GitSync ',
    host: {},
    hoverCard: {},
  })

  assert.deepEqual(normalized, {
    repoId: 'repo-1',
    repoName: 'GitSync',
    repoPath: '/tmp/GitSync',
  })
  assert.equal('host' in normalized, false)
  assert.equal('hoverCard' in normalized, false)
  assert.equal(Object.isFrozen(normalized), true)
})

test('module channel delivers only when a complete-view listener is mounted', () => {
  resetBranchManagementAppBridgeForTests()
  const request = { repoId: '1', repoName: 'Repo', repoPath: '/repo' }

  assert.equal(dispatchBranchManagementOpen(request), false)

  const received = []
  const unsubscribe = subscribeBranchManagementOpen((detail) => received.push(detail))
  assert.equal(dispatchBranchManagementOpen(request), true)
  assert.deepEqual(received, [{ repoId: '1', repoName: 'Repo', repoPath: '/repo' }])

  unsubscribe()
  assert.equal(dispatchBranchManagementOpen(request), false)
  resetBranchManagementAppBridgeForTests()
})

test('native hover action owns the visible button and approved design independently', () => {
  const source = read('./BranchManagementHoverAction.jsx')
  const css = read('./BranchManagementHoverAction.css')
  const legacyCss = `${read('./BranchManagementLayer.css')}\n${read('./BranchManagementPolish.css')}`

  assert.match(source, /className="branch-management-hover-action"/)
  assert.match(source, /dispatchBranchManagementOpen\(detail\)/)
  assert.match(source, /onOpenAccepted\?\.\(\)/)
  assert.match(source, /data-app-tooltip="展开分支完整视图"/)
  assert.doesNotMatch(source, /branch-management-hover-expand|branch-management-icon-action/)
  assert.doesNotMatch(source, /createPortal|MutationObserver|ResizeObserver|querySelector|getBoundingClientRect/)
  assert.match(css, /aria-label="仓库分支总览"/)
  assert.match(css, /\.branch-management-hover-action/)
  assert.match(css, /position: absolute;/)
  assert.match(css, /top: 7px;/)
  assert.match(css, /right: 7px;/)
  assert.match(css, /width: 24px;/)
  assert.match(css, /height: 24px;/)
  assert.match(css, /padding-right: 34px;/)
  assert.doesNotMatch(legacyCss, /branch-management-hover-action/)
})

test('gateway is an event-only listener with no hover discovery lifecycle', () => {
  const source = read('./BranchManagementHoverGateway.jsx')

  assert.match(source, /subscribeBranchManagementOpen/)
  assert.match(source, /if \(disabled\) return undefined/)
  assert.match(source, /return null/)
  assert.doesNotMatch(source, /createPortal|MutationObserver|ResizeObserver|querySelector|getBoundingClientRect/)
  assert.doesNotMatch(source, /MouseEvent|FocusEvent|mouseover|mouseout|focusin|focusout/)
})

test('legacy gateway module is a pure context export and portal styles stay deleted', () => {
  const compatibility = read('./branchManagementHoverGateway.js')

  assert.equal(existsSync(new URL('./BranchManagementHoverGateway.css', import.meta.url)), false)
  assert.match(compatibility, /normalizeBranchManagementOpenDetail as normalizeBranchManagementOpenContext/)
  assert.doesNotMatch(compatibility, /document|window|MutationObserver|querySelector|getBoundingClientRect/)
})
