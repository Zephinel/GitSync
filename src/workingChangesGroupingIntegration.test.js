import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

test('renders staging authority through collapsible React groups', () => {
  const source = read('WorkingChangesView.jsx')
  const component = read('WorkingChangesFileGroups.jsx')

  assert.match(source, /import WorkingChangesFileGroups from '\.\/WorkingChangesFileGroups\.jsx'/)
  assert.match(source, /from '\.\/workingChangesGroups\.js'/)
  assert.match(source, /const \[collapsedGroupIds, setCollapsedGroupIds\] = useState\(\(\) => new Set\(\)\)/)
  assert.match(source, /groupWorkingChangesFiles\(files, filterText\)/)
  assert.match(source, /getVisibleWorkingChangeFiles\(groupedFiles, collapsedGroupIds, searching\)/)
  assert.match(source, /const selectedFile = useMemo\([\s\S]*visibleFiles\.find\(\(file\) => file\.id === selectedFileId\) \|\| visibleFiles\[0\] \|\| null/)
  assert.match(source, /<WorkingChangesFileGroups[\s\S]*groups=\{groupedFiles\}[\s\S]*renderFile=\{renderFileRow\}/)
  assert.doesNotMatch(source, /filteredFiles\.map/)

  assert.match(component, /aria-expanded=\{expanded\}/)
  assert.match(component, /aria-controls=\{panelId\}/)
  assert.match(component, /searching \|\| !collapsedGroupIds\?\.has\(group\.id\)/)
  assert.match(component, /group\.files\.map\(\(file\) => renderFile\(file, group\)\)/)
})

test('batch operations only use visible files and collapsing removes hidden selection', () => {
  const source = read('WorkingChangesView.jsx')

  assert.match(source, /const selectionProjection = useMemo/)
  assert.match(source, /const selectedFiles = visibleFiles\.filter\(\(file\) => selectedIds\.has\(file\.id\)\)/)
  assert.match(source, /allVisibleSelected: visibleFiles\.length > 0 && visibleFiles\.every\(\(file\) => selectedIds\.has\(file\.id\)\)/)
  assert.match(source, /visibleFiles\.forEach\(\(file\) =>/)
  assert.match(source, /const hiddenIds = new Set\(group\.files\.map\(\(file\) => file\.id\)\)/)
  assert.match(source, /setSelectedIds\(\(previous\) => new Set\(\[\.\.\.previous\]\.filter\(\(id\) => !hiddenIds\.has\(id\)\)\)\)/)
  assert.match(source, /getVisibleWorkingChangeFiles\(groupedFiles, nextCollapsed, false\)/)
  assert.match(source, /个可见文件/)
})

test('group visuals distinguish conflict, staged, mixed and unstaged sections', () => {
  const css = read('WorkingChangesGroups.css')

  assert.match(css, /\.working-changes-group--conflicted/)
  assert.match(css, /\.working-changes-group--staged/)
  assert.match(css, /\.working-changes-group--mixed/)
  assert.match(css, /\.working-changes-group__chevron--expanded/)
  assert.match(css, /\.working-changes-group__files/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})
