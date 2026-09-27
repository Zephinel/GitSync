import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeAiCommitMessageResult,
  readSelectedCommitTargets,
  shouldConfirmCommitMessageOverwrite,
  summarizeCommitGenerationCoverage,
} from './aiCommitMessage.js'
import { stagingEntryIdentity } from '../stagingViewModel.js'

test('normalizes generated commit message metadata and coverage', () => {
  const result = normalizeAiCommitMessageResult({
    requestId: 'req-1',
    message: 'fix(ai): keep exact scope',
    selectedFileCount: 4,
    includedFileCount: 2,
    excludedFiles: [{ path: '.env', reason: '敏感路径已排除' }],
    summaryOnlyFiles: [{ path: 'large.txt', reason: 'too large' }],
    binaryFiles: [],
    redactedLineCount: 3,
  })
  assert.equal(result.message, 'fix(ai): keep exact scope')
  assert.equal(result.excludedFiles[0].path, '.env')
  assert.match(summarizeCommitGenerationCoverage(result), /2\/4 个文件包含完整 Diff/)
  assert.match(summarizeCommitGenerationCoverage(result), /1 个敏感文件已排除/)
  assert.match(summarizeCommitGenerationCoverage(result), /3 行已脱敏/)
})

test('reads complete authoritative targets and preserves same-path Git identities', () => {
  const files = [
    {
      id: 'authority-staged-deletion',
      path: 'same.txt',
      index_code: 'D',
      worktree_code: ' ',
      is_untracked: false,
    },
    {
      id: 'authority-untracked-replacement',
      path: 'same.txt',
      index_code: '?',
      worktree_code: '?',
      is_untracked: true,
    },
  ]
  const rows = files.map((file) => {
    const fileId = stagingEntryIdentity(file)
    const input = {
      checked: true,
      getAttribute(name) {
        if (name === 'aria-label') return `选择文件 ${file.path}`
        if (name === 'data-file-id') return fileId
        return null
      },
    }
    return {
      getAttribute: (name) => name === 'data-file-path' ? file.path : null,
      querySelector: () => input,
    }
  })
  const root = {
    querySelectorAll(selector) {
      if (selector === '.working-changes-file-row') return rows
      if (selector === '.working-changes-file-row .working-changes-checkbox input:checked') return rows.map((row) => row.querySelector())
      throw new Error(`unexpected selector: ${selector}`)
    },
  }
  const previousWindow = globalThis.window
  globalThis.window = {
    __gitsyncWorkingChangesContext: { repoPath: '/repo' },
    __gitsyncWorkingChangesSummaryByPath: { '/repo': { files } },
  }
  try {
    assert.deepEqual(readSelectedCommitTargets(root), [
      {
        path: 'same.txt',
        oldPath: null,
        expectedIndexCode: 'D',
        expectedWorktreeCode: ' ',
        expectedIsUntracked: false,
        expectedAuthorityId: 'authority-staged-deletion',
      },
      {
        path: 'same.txt',
        oldPath: null,
        expectedIndexCode: '?',
        expectedWorktreeCode: '?',
        expectedIsUntracked: true,
        expectedAuthorityId: 'authority-untracked-replacement',
      },
    ])
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('requires overwrite confirmation only for non-generated existing text', () => {
  assert.equal(shouldConfirmCommitMessageOverwrite('', ''), false)
  assert.equal(shouldConfirmCommitMessageOverwrite('fix: generated', 'fix: generated'), false)
  assert.equal(shouldConfirmCommitMessageOverwrite('manual message', 'fix: generated'), true)
})
