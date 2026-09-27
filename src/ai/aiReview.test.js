import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatAiReviewForClipboard,
  getReviewCoverageItems,
  normalizeAiReviewPreview,
  normalizeAiReviewResult,
  readWorkingReviewScope,
} from './aiReview.js'
import { parseFindingLocation } from './aiReviewNavigation.js'
import { stagingEntryIdentity } from '../stagingViewModel.js'

test('normalizes review scope previews and coverage notices', () => {
  const preview = normalizeAiReviewPreview({
    scopeKind: 'selected',
    scopeLabel: '已勾选文件',
    selectedFileCount: 3,
    includedFileCount: 2,
    excludedFiles: [{ path: '.env', reason: '敏感路径已排除' }],
    summaryOnlyFiles: [{ path: 'large.js', reason: '过大' }],
    binaryFiles: [{ path: 'logo.png', reason: 'Binary' }],
    sanitizedBytes: 1234,
    redactedLineCount: 2,
    snapshotFingerprint: 'fnv1a64-example',
  })
  assert.equal(preview.scopeKind, 'selected')
  assert.equal(preview.selectedFileCount, 3)
  assert.equal(preview.includedFileCount, 2)
  assert.equal(getReviewCoverageItems(preview).length, 3)
})

test('reads selected Working Changes scope from the authoritative row identity contract', () => {
  const exactPath = ' image.png '
  const file = {
    id: 'authority-image',
    path: exactPath,
    index_code: ' ',
    worktree_code: 'M',
    is_untracked: false,
  }
  const fileId = stagingEntryIdentity(file)
  const input = {
    checked: true,
    getAttribute: (name) => name === 'data-file-id' ? fileId : null,
  }
  const row = {
    getAttribute: (name) => name === 'data-file-path' ? exactPath : null,
    querySelector: () => input,
  }
  const root = {
    querySelectorAll: () => [row],
    querySelector: () => ({ textContent: '1' }),
  }

  const previousWindow = globalThis.window
  globalThis.window = {
    __gitsyncWorkingChangesContext: { repoPath: '/repo' },
    __gitsyncWorkingChangesSummaryByPath: { '/repo': { files: [file] } },
  }
  try {
    assert.deepEqual(readWorkingReviewScope(root), {
      scopeKind: 'selected',
      scopeLabel: '已勾选文件',
      selectedCount: 1,
      totalCount: 1,
      complete: true,
      targets: [{
        path: exactPath,
        oldPath: null,
        expectedIndexCode: ' ',
        expectedWorktreeCode: 'M',
        expectedIsUntracked: false,
        expectedAuthorityId: 'authority-image',
      }],
    })
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('normalizes structured review results without trusting invalid enums', () => {
  const result = normalizeAiReviewResult({
    requestId: 'review-1',
    overallRisk: 'HIGH',
    summary: 'Review summary',
    scopeKind: 'all',
    selectedFileCount: 2,
    findings: [{
      severity: 'P1',
      title: 'Potential bug',
      file: 'src/main.js',
      startLine: 12,
      endLine: 14,
      explanation: 'The branch can fail.',
      suggestion: 'Add a guard.',
    }, {
      severity: 'invalid',
      title: 'Fallback severity',
      explanation: 'Still normalized.',
    }],
    positiveNotes: ['Good boundary'],
    testSuggestions: ['Test cancellation'],
    stale: true,
  })
  assert.equal(result.overallRisk, 'high')
  assert.equal(result.findings[0].severity, 'P1')
  assert.equal(result.findings[1].severity, 'P3')
  assert.equal(result.stale, true)
})

test('formats a copyable review with findings and test suggestions', () => {
  const text = formatAiReviewForClipboard(normalizeAiReviewResult({
    overallRisk: 'medium',
    summary: 'Summary',
    scopeKind: 'selected',
    scopeLabel: '已勾选文件',
    selectedFileCount: 1,
    findings: [{
      id: 'finding-1',
      severity: 'P2',
      title: 'Example',
      file: 'src/a.js',
      startLine: 8,
      endLine: 8,
      explanation: 'Explanation',
      suggestion: 'Suggestion',
    }],
    positiveNotes: ['Positive'],
    testSuggestions: ['Test it'],
  }))
  assert.match(text, /# AI Review/)
  assert.match(text, /P2 · Example/)
  assert.match(text, /src\/a\.js:8/)
  assert.match(text, /## Test suggestions/)
})

test('parses finding paths and best-effort line ranges without corrupting path colons', () => {
  assert.deepEqual(parseFindingLocation('src/a.js:8–12'), { path: 'src/a.js', line: 8 })
  assert.deepEqual(parseFindingLocation('C:/repo/src/a.js:19'), { path: 'C:/repo/src/a.js', line: 19 })
  assert.deepEqual(parseFindingLocation('src/no-line.js'), { path: 'src/no-line.js', line: null })
  assert.equal(parseFindingLocation('跨文件'), null)
})
