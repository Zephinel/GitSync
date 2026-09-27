import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getVisibleWorkingChangeFiles,
  getWorkingChangeGroupId,
  groupWorkingChangesFiles,
  isWorkingChangeGroupExpanded,
  toggleCollapsedWorkingChangeGroup,
  workingChangeMatchesQuery,
} from './workingChangesGroups.js'

const files = [
  {
    id: 'conflict',
    path: 'src/conflict.js',
    staging_state: 'conflicted',
    is_conflicted: true,
    has_staged_changes: true,
    has_unstaged_changes: true,
  },
  {
    id: 'staged',
    path: 'src/staged.js',
    staging_state: 'staged',
    has_staged_changes: true,
    has_unstaged_changes: false,
  },
  {
    id: 'mixed',
    path: 'src/mixed.js',
    staging_state: 'mixed',
    has_staged_changes: true,
    has_unstaged_changes: true,
  },
  {
    id: 'unstaged',
    path: 'src/unstaged.js',
    staging_state: 'unstaged',
    has_staged_changes: false,
    has_unstaged_changes: true,
  },
  {
    id: 'untracked',
    path: 'notes/new.txt',
    staging_state: 'untracked',
    is_untracked: true,
    has_staged_changes: false,
    has_unstaged_changes: true,
  },
]

test('assigns each file to one non-duplicated authority group', () => {
  assert.equal(getWorkingChangeGroupId(files[0]), 'conflicted')
  assert.equal(getWorkingChangeGroupId(files[1]), 'staged')
  assert.equal(getWorkingChangeGroupId(files[2]), 'mixed')
  assert.equal(getWorkingChangeGroupId(files[3]), 'unstaged')
  assert.equal(getWorkingChangeGroupId(files[4]), 'unstaged')

  const groups = groupWorkingChangesFiles(files)
  assert.deepEqual(groups.map((group) => group.id), [
    'conflicted',
    'staged',
    'mixed',
    'unstaged',
  ])
  assert.equal(groups.flatMap((group) => group.files).length, files.length)
  assert.equal(new Set(groups.flatMap((group) => group.files.map((file) => file.id))).size, files.length)
})

test('keeps Chinese and English staging state search aliases', () => {
  assert.equal(workingChangeMatchesQuery(files[0], '冲突'), true)
  assert.equal(workingChangeMatchesQuery(files[1], '已暂存'), true)
  assert.equal(workingChangeMatchesQuery(files[1], 'index'), true)
  assert.equal(workingChangeMatchesQuery(files[2], '部分暂存'), true)
  assert.equal(workingChangeMatchesQuery(files[2], 'partially staged'), true)
  assert.equal(workingChangeMatchesQuery(files[3], '未暂存'), true)
  assert.equal(workingChangeMatchesQuery(files[4], '未跟踪'), true)
  assert.equal(workingChangeMatchesQuery(files[4], 'untracked'), true)
  assert.equal(workingChangeMatchesQuery(files[4], 'notes/new'), true)

  const groups = groupWorkingChangesFiles(files, '已暂存')
  assert.deepEqual(groups.map((group) => group.id), ['staged'])
  assert.deepEqual(groups[0].files.map((file) => file.id), ['staged'])
})

test('keeps untracked files in the unstaged group while preserving filtered counts', () => {
  const groups = groupWorkingChangesFiles(files, 'new.txt')
  assert.deepEqual(groups.map((group) => group.id), ['unstaged'])
  assert.deepEqual(groups[0].files.map((file) => file.id), ['untracked'])
  assert.equal(groups[0].filtered_count, 1)
  assert.equal(groups[0].total_count, 2)
})

test('search expands matching groups without destroying the stored collapsed state', () => {
  const collapsed = new Set(['staged'])
  assert.equal(isWorkingChangeGroupExpanded('staged', collapsed, false), false)
  assert.equal(isWorkingChangeGroupExpanded('staged', collapsed, true), true)
  assert.deepEqual([...collapsed], ['staged'])
})

test('visible file selection excludes collapsed groups outside search mode', () => {
  const groups = groupWorkingChangesFiles(files)
  const visible = getVisibleWorkingChangeFiles(groups, new Set(['staged', 'mixed']), false)
  assert.deepEqual(visible.map((file) => file.id), ['conflict', 'unstaged', 'untracked'])

  const searchingVisible = getVisibleWorkingChangeFiles(groups, new Set(['staged', 'mixed']), true)
  assert.deepEqual(searchingVisible.map((file) => file.id), files.map((file) => file.id))
})

test('collapse toggling is immutable and reversible', () => {
  const original = new Set(['staged'])
  const expanded = toggleCollapsedWorkingChangeGroup(original, 'staged')
  const collapsedAgain = toggleCollapsedWorkingChangeGroup(expanded, 'staged')

  assert.deepEqual([...original], ['staged'])
  assert.deepEqual([...expanded], [])
  assert.deepEqual([...collapsedAgain], ['staged'])
})
