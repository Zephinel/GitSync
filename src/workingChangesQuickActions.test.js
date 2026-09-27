import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FILE_CELL_MINUS, resolveFileCellActions } from './stagingViewModel.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('unstaged tracked cell resolves + stage and a direct discard-unstaged minus', () => {
  const actions = resolveFileCellActions({ path: 'src/a.rs', staging_state: 'unstaged', can_stage: true, can_unstage: false })
  assert.equal(actions.canStage, true)
  assert.deepEqual(actions.minus, {
    operation: 'discard-unstaged',
    tone: 'discard',
    title: '丢弃 src/a.rs 的未暂存改动',
    ariaLabel: '丢弃 src/a.rs 的未暂存改动',
  })
})

test('untracked cell resolves + stage and a direct destructive delete minus', () => {
  const actions = resolveFileCellActions({ path: 'new.txt', staging_state: 'untracked', can_stage: true, can_unstage: false, is_untracked: true })
  assert.equal(actions.canStage, true)
  assert.deepEqual(actions.minus, {
    operation: 'discard-untracked',
    tone: 'discard',
    title: '删除未跟踪文件 new.txt',
    ariaLabel: '删除未跟踪文件 new.txt',
  })
})

test('staged-only cell resolves one non-destructive unstage minus and no discard', () => {
  const actions = resolveFileCellActions({ path: 'src/b.rs', staging_state: 'staged', can_stage: false, can_unstage: true })
  assert.equal(actions.canStage, false)
  assert.deepEqual(actions.minus, {
    operation: 'unstage',
    tone: 'unstage',
    title: '取消暂存 src/b.rs',
    ariaLabel: '取消暂存 src/b.rs',
  })
})

test('mixed cell resolves + stage and a choose-minus secondary entry with both layer operations', () => {
  const actions = resolveFileCellActions({ path: 'src/m.rs', staging_state: 'mixed', can_stage: true, can_unstage: true })
  assert.equal(actions.canStage, true)
  assert.equal(actions.minus.operation, FILE_CELL_MINUS.choose)
  assert.equal(actions.minus.choices.length, 2)
  assert.deepEqual(actions.minus.choices[0], {
    operation: 'unstage',
    tone: 'unstage',
    title: '取消暂存 src/m.rs',
    ariaLabel: '取消暂存 src/m.rs',
  })
  assert.deepEqual(actions.minus.choices[1], {
    operation: 'discard-unstaged',
    tone: 'discard',
    title: '丢弃 src/m.rs 的未暂存改动',
    ariaLabel: '丢弃 src/m.rs 的未暂存改动',
  })
  assert.match(actions.minus.ariaLabel, /存在多个减除操作/)
})

test('conflicted and clean cells resolve no actions; stale authority resolves empty', () => {
  assert.deepEqual(resolveFileCellActions({ path: 'c.rs', staging_state: 'conflicted', is_conflicted: true, can_stage: true, can_unstage: true }), { canStage: false, minus: null })
  assert.deepEqual(resolveFileCellActions({ path: 'd.rs', staging_state: 'clean', can_stage: false, can_unstage: false }), { canStage: false, minus: null })
  assert.deepEqual(resolveFileCellActions({ path: 'e.rs', staging_state: 'unstaged', can_stage: true, can_unstage: false }, { authorityReady: false }), { canStage: false, minus: null })
})

test('view consumes the presentation contract and renders at most two rail slots', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /import \{[^}]*resolveFileCellActions/)
  assert.match(source, /import \{[^}]*FILE_CELL_MINUS/)
  assert.match(source, /const cellActions = resolveFileCellActions\(file, \{ authorityReady: stagingAuthorityReady \}\)/)
  assert.match(source, /const stageActions = cellActions\.canStage \|\| cellActions\.minus \?/)
  assert.match(source, /\{cellActions\.canStage \? \([\s\S]*working-changes-file-stage-action--stage/)
  assert.match(source, /\{cellActions\.minus \? \(/)
  assert.match(source, /cellActions\.minus\.operation === FILE_CELL_MINUS\.choose/)
  assert.match(source, /working-changes-file-stage-action--\$\{cellActions\.minus\.tone\}/)
  assert.doesNotMatch(source, /canUnstage \? <CanonicalDeleteIcon/)
  assert.doesNotMatch(source, /working-changes-file-stage-action--discard"[\s\S]*<CanonicalDeleteIcon/)
})

test('mixed minus opens a secondary menu that resolves to existing operations only', () => {
  const source = read('./WorkingChangesView.jsx')
  const menu = read('./WorkingChangesFileMinusMenu.jsx')

  assert.match(source, /import WorkingChangesFileMinusMenu from '\.\/WorkingChangesFileMinusMenu\.jsx'/)
  assert.match(source, /onClick=\{\(event\) => setMinusMenu\(\{ fileId: file\.id, anchor: event\.currentTarget \}\)\}/)
  assert.match(source, /<WorkingChangesFileMinusMenu/)
  assert.match(source, /onPick=\{\(operation\) => \{[\s\S]*openOperation\(operation, \[file\]\)/)
  assert.match(source, /if \(operationBusy\) setMinusMenu\(null\)/)

  assert.match(menu, /import \{ FILE_CELL_MINUS \} from '\.\/stagingViewModel\.js'/)
  assert.match(menu, /role="menu"/)
  assert.match(menu, /role="menuitem"/)
  assert.match(menu, /FILE_CELL_MINUS\.unstage/)
  assert.match(menu, /FILE_CELL_MINUS\.discardUnstaged/)
  assert.match(menu, />取消暂存</)
  assert.match(menu, /保留文件内容/)
  assert.match(menu, />丢弃未暂存改动</)
  assert.match(menu, /已暂存内容保持不变/)
  assert.doesNotMatch(menu, /FILE_CELL_MINUS\.discardUntracked/)
  assert.doesNotMatch(menu, /invoke\(/)
})

test('worktree discard and unstage reuse snapshot authority and refresh from fresh status', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /invoke\('discard_repo_working_files_unstaged',/)
  assert.match(source, /expectedSnapshotId: operationDialog\.snapshotId/)
  assert.match(source, /const targets = operationDialog\.targets/)
  assert.match(source, /await refreshAfterExistingOperation\(result\)/)
  assert.match(source, /const refreshAfterExistingOperation = async \(result\) => \{[\s\S]*await loadSummary\(\{ preserveSelection: false, silent: true \}\)/)
})

test('post-operation reloads are silent so counts and rows swap without a loading flash', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /const loadSummary = useCallback\(async \(\{ preserveSelection = false, silent = false \} = \{\}\) => \{[\s\S]*if \(!silent\) setSummaryState\(/)
  assert.match(source, /const refreshAfterExistingOperation = async \(result\) => \{[\s\S]*await loadSummary\(\{ preserveSelection: false, silent: true \}\)/)
  assert.match(source, /const executeStagingOperation = async \(type, dialog\) => \{[\s\S]*await loadSummary\(\{ preserveSelection: false, silent: true \}\)/)
})

test('success notices auto-dismiss while destructive feedback stays', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /if \(!notice \|\| notice\.tone !== 'success'\) return undefined/)
  assert.match(source, /setTimeout\(\(\) => setNotice\(null\), 4000\)/)
})

test('the view reconciles fresh status when the window regains visibility', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /window\.addEventListener\('focus', reloadWhenVisible\)/)
  assert.match(source, /document\.addEventListener\('visibilitychange', handleVisibility\)/)
  assert.match(source, /Date\.now\(\) - lastSummaryLoadAtRef\.current < 1500/)
  assert.match(source, /loadSummary\(\{ preserveSelection: true, silent: true \}\)/)
})

test('dialog copy distinguishes untracked delete from unstaged discard', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /case 'discard-unstaged':/)
  assert.match(source, /只会把确认范围内未暂存的工作区改动恢复为暂存区内容；已暂存内容保持不变/)
  assert.match(source, /case 'discard-untracked':/)
  assert.match(source, /该操作会从磁盘删除这些未跟踪文件，不是恢复到 Git 版本，无法撤销/)
  assert.match(source, /确认永久删除所选未跟踪文件？该文件会从磁盘删除，无法恢复到 Git 版本/)
  assert.match(source, /确认永久丢弃所选文件的未暂存改动？已暂存内容保持不变/)
})

test('confirmation scope is captured immutably at open time and never re-resolved', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /const targets = isStaging \? buildStagingTargets\(targetFiles, type\) : buildWorkingChangeTargets\(targetFiles\)/)
  assert.match(source, /snapshotId: isStaging \? summary\.snapshot_id : summary\.working_snapshot_id/)
  assert.match(source, /displayFiles: targetFiles\.map\(\(file\) => \(\{ id: file\.id, path: file\.path \}\)\)/)
  assert.match(source, /const targets = operationDialog\.targets/)
  assert.match(source, /expectedSnapshotId: operationDialog\.snapshotId/)
  assert.match(source, /const targets = dialog\.targets/)
  assert.match(source, /expectedSnapshotId: dialog\.snapshotId/)
  assert.doesNotMatch(source, /operationFiles/)
  assert.doesNotMatch(source, /fileIds:/)
})

test('loadSummary applies only the newest request via a sequence guard', () => {
  const source = read('./WorkingChangesView.jsx')

  assert.match(source, /const sequence = \+\+loadSummarySequenceRef\.current/)
  assert.match(source, /if \(loadSummarySequenceRef\.current !== sequence\) return/)
  assert.equal((source.match(/loadSummarySequenceRef\.current !== sequence/g) || []).length, 2)
})

test('mixed minus menu integrates with the overlay Escape authority and keyboard contract', () => {
  const source = read('./WorkingChangesView.jsx')
  const menu = read('./WorkingChangesFileMinusMenu.jsx')

  assert.match(source, /if \(minusMenu\) setMinusMenu\(null\)[\s\S]*else if \(operationDialog && !operationBusy\) setOperationDialog\(null\)/)
  assert.match(source, /aria-haspopup="menu"/)
  assert.match(source, /aria-expanded=\{minusMenu\?\.fileId === file\.id\}/)

  assert.match(menu, /rootRef\.current\?\.querySelector\('\[role="menuitem"\]'\)\?\.focus\(\)/)
  assert.match(menu, /event\.key === 'ArrowDown'/)
  assert.match(menu, /event\.key === 'ArrowUp'/)
  assert.match(menu, /event\.key === 'Home'/)
  assert.match(menu, /event\.key === 'End'/)
  assert.match(menu, /if \(!pickedRef\.current && anchor\?\.isConnected\) anchor\.focus\(\)/)
  assert.doesNotMatch(menu, /addEventListener\('keydown'/)
})
