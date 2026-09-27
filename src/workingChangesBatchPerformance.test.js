import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('always-visible Git operations retain stable file-row geometry', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /import WorkingChangesStashEntry from '\.\/WorkingChangesStashEntry\.jsx'/)
  assert.match(source, /import '\.\/WorkingChangesPerformance\.css'/)
  assert.match(source, /const operationBusyRef = useRef\(false\)/)
  assert.match(source, /const renderFileRow = useCallback\(\(file, group\) => \{/)
  assert.match(source, /checkbox=\{<CanonicalCheckbox/)
  assert.match(source, /<WorkingChangesFileCell/)
  assert.doesNotMatch(source, /working-changes-file-row \$\{batchMode \?/)
  assert.doesNotMatch(source, /\{batchMode \? <WorkingCheckbox/)
  assert.match(source, /<WorkingChangesStashEntry/)
})

test('operation selection changes retain stable callback identities', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /const selectionProjection = useMemo\(\(\) => \{/)
  assert.match(source, /const toggleSelected = useCallback/)
  assert.match(source, /const toggleGroup = useCallback/)
  assert.match(source, /const handleFilePreview = useCallback/)
  assert.match(source, /const openOperation = useCallback/)
  assert.doesNotMatch(source, /toggleBatchMode|batchModeRef/)
  assert.match(source, /operationBusyRef\.current/)
})

test('file groups can bail out when only operation selection changes', () => {
  const groups = read('./WorkingChangesFileGroups.jsx')

  assert.match(groups, /import \{ memo \} from 'react'/)
  assert.match(groups, /export default memo\(WorkingChangesFileGroups\)/)
  assert.doesNotMatch(groups, /batchMode/)
})

test('active Diff rendering bails out when operation selection changes', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /import \{ Fragment, memo, useCallback, useEffect, useMemo, useRef, useState \} from 'react'/)
  assert.match(source, /const MemoizedFileDiffRenderer = memo\(/)
  assert.match(source, /previous\.repoPath === next\.repoPath/)
  assert.match(source, /previous\.file === next\.file/)
  assert.match(source, /previous\.state === next\.state/)
  assert.match(source, /previous\.lineWrap === next\.lineWrap/)
  assert.match(source, /previous\.viewMode === next\.viewMode/)
  assert.match(source, /previous\.allowLarge === next\.allowLarge/)
  assert.match(source, /<MemoizedFileDiffRenderer repoPath=\{data\.repoPath\}/)
  assert.doesNotMatch(source, /<FileDiffRenderer repoPath=\{data\.repoPath\}/)
})

test('file rows do not create a second paint-contained surface', () => {
  const css = read('./WorkingChangesPerformance.css')
  const fileCell = read('./WorkingChangesFileCell.css')
  const entry = read('./WorkingChangesStashEntry.jsx')
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /import '\.\/WorkingChangesPerformance\.css'/)
  assert.doesNotMatch(css, /content-visibility|contain-intrinsic-size|contain:\s*[^;]*paint/)
  assert.match(fileCell, /\.working-changes-file-cell__selection\s*\{[\s\S]*display:\s*grid/)
  assert.match(entry, /hidden=\{!visible\}/)
  assert.doesNotMatch(entry, /if \(!visible && !open\) return null/)
})

test('production build has no source-string rewriting path', () => {
  const vite = read('../vite.config.js')
  const workingChanges = read('./WorkingChangesView.jsx')

  assert.doesNotMatch(vite, /viteWorkingChangesStashPlugin|workingChangesStashPlugin/)
  assert.match(workingChanges, /import WorkingChangesStashEntry/)
  assert.match(workingChanges, /<WorkingChangesStashEntry/)
  assert.doesNotMatch(workingChanges, /partial Git operation performance integration detected|replaceExactlyOnce/)
})

test('performance work contains no timer polling or delayed visual patch', () => {
  const source = [
    read('./WorkingChangesView.jsx'),
    read('./WorkingChangesFileGroups.jsx'),
    read('./WorkingChangesPerformance.css'),
    read('./WorkingChangesStashEntry.jsx'),
  ].join('\n')

  assert.doesNotMatch(source, /setInterval|requestIdleCallback|MutationObserver/)
})
