import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('manager is read-first and every destructive action enters confirmation', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const hook = read('./useStashSnapshotState.js')
  const snapshots = read('./stashSnapshotRepository.js')
  const surfaces = read('./stash-manager/StashOperationSurfaces.jsx')

  assert.match(manager, /useStashSnapshotState\(repoPath\)/)
  assert.match(hook, /readStashSnapshot/)
  assert.match(hook, /subscribeStashSnapshot/)
  assert.match(snapshots, /invokeNative\('get_repo_stash_snapshot'/)
  assert.doesNotMatch(manager, /create_repo_stash/)
  assert.match(manager, /setConfirm\(\{ operation, stashId: entry\.id, entry \}\)/)
  assert.match(manager, /selectedEntry && void runOperation\(confirm\.operation, selectedEntry\)/)
  assert.match(manager, /!stashSnapshotHasCompleteStashList\(snapshot\) \? confirm\.entry \|\| null : null/)
  assert.match(surfaces, /function ConfirmationDialog/)
  assert.match(surfaces, /只有应用成功且没有冲突时/)
  assert.match(surfaces, /删除后无法通过本流程恢复/)
})

test('one operation client owns response-loss reconciliation and snapshot installation', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const createMutation = read('./stash-create/createStashMutation.js')
  const client = read('./stashOperationClient.js')

  assert.match(manager, /invokeStashMutation/)
  assert.match(manager, /reconcileStashOperation/)
  assert.match(manager, /acknowledgeStashOperation/)
  assert.match(createMutation, /invokeStashMutation/)
  assert.doesNotMatch(`${manager}\n${createMutation}`, /invoke\('reconcile_repo_stash_operation'/)
  assert.match(client, /reconcile_repo_stash_operation/)
  assert.match(client, /expectedOperation/)
  assert.match(client, /expectedTargetStashId/)
  assert.match(client, /expectedSnapshotId/)
  assert.doesNotMatch(client, /NO_OPERATION_RECORD/)
  assert.doesNotMatch(client, /includes\([^)]*找不到可确认的 Stash/)
  assert.match(client, /snapshotRepository\.beginMutation/)
  assert.match(client, /snapshotRepository\.publishMutation/)
  assert.match(client, /snapshotRepository\.read\(repoPath, \{[\s\S]*force: true,[\s\S]*mutationToken: token/)
})

test('operation feedback is a floating Toast and preserves result axes', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const surfaces = read('./stash-manager/StashOperationSurfaces.jsx')
  const css = read('./StashFinalPolish.css')

  assert.match(surfaces, /stashResultTone\(result\.status\)/)
  assert.match(surfaces, /stash-manager-toast/)
  assert.match(surfaces, /result\.worktreeChanged/)
  assert.match(surfaces, /result\.applied/)
  assert.match(surfaces, /result\.dropped/)
  assert.match(surfaces, /result\.stashRetained/)
  assert.match(surfaces, /result\.needsConfirmation/)
  assert.match(manager, /SUCCESS_TOAST_DURATION_MS/)
  assert.match(css, /\.stash-manager-toast \{[\s\S]*position: absolute;/)
  assert.doesNotMatch(manager, /stash-manager-redesign-body[\s\S]*<ResultPanel/)
})

test('manager derives detail and confirmation lifetime from the authoritative snapshot', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')

  assert.match(manager, /if \(detailId && !findStashEntry\(snapshot, detailId\)\) setDetailId\(null\)/)
  assert.match(manager, /if \(confirm\?\.stashId && !findStashEntry\(snapshot, confirm\.stashId\)\) setConfirm\(null\)/)
  assert.match(manager, /\[confirm\?\.stashId, detailId, snapshot\]/)
})

test('full manager implements custom sort, query-session search, footer pagination and master-detail IA', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const list = read('./stash-manager/StashManagerList.jsx')
  const index = read('./stash-manager/useStashDetailIndex.js')
  const repository = read('./stashDetailRepository.js')
  const layout = read('./stash-manager/StashManagerLayout.css')
  const finalCss = read('./StashFinalPolish.css')
  const table = read('./stash-manager/StashManagerTable.css')
  const actions = read('./StashEntryActionMenu.jsx')

  assert.match(manager, /<StashManagerList/)
  assert.match(manager, /<StashDetailView/)
  assert.match(manager, /detailPanel=\{detailPanel\}/)
  assert.match(list, /stash-manager-sidebar/)
  assert.match(list, /搜索 Stash 说明或文件名/)
  assert.match(list, /<CustomSelect/)
  assert.match(list, /按创建时间/)
  assert.doesNotMatch(list, /<select/)
  assert.match(list, /stash-manager-table/)
  assert.match(list, /stash-manager-master-detail/)
  assert.match(list, /visiblePageNumbers/)
  assert.match(list, /<StashEntryActionMenu/)
  assert.match(list, /matchesQuery/)
  assert.match(list, /getFileCount/)
  assert.match(index, /readStashDetail/)
  assert.match(index, /searchMatchesRef/)
  assert.match(index, /searchUnknownRef/)
  assert.match(index, /stashDetailSearchState/)
  assert.match(index, /matchesQuery/)
  assert.match(index, /searchIncomplete:/)
  assert.match(repository, /invokeNative\('get_repo_stash_detail'/)
  assert.match(layout, /grid-template-columns: 216px/)
  assert.match(finalCss, /grid-template-rows: auto auto minmax\(0, 1fr\) 48px/)
  assert.match(finalCss, /\.stash-manager-pagination \{[\s\S]*border-top:/)
  assert.match(table, /grid-template-columns: minmax\(230px, 1fr\) 145px 118px 74px 42px/)
  assert.match(actions, /应用并删除/)
  assert.match(actions, /stash-entry-action-menu__danger/)
})

test('full manager viewport sizing is derived from the backdrop content box', () => {
  const baseCss = read('./StashManagerDialog.css')
  const finalCss = read('./StashFinalPolish.css')

  assert.match(baseCss, /\.stash-manager-backdrop \{[\s\S]*padding: clamp\(/)

  const managementBlocks = [...finalCss.matchAll(/\.stash-manager-dialog--management\s*\{([^}]*)\}/g)]
    .map((match) => match[1])
  assert.equal(managementBlocks.length, 2)

  assert.match(managementBlocks[0], /width:\s*min\(1120px,\s*100%\)/)
  assert.match(managementBlocks[0], /max-width:\s*100%/)
  assert.match(managementBlocks[0], /height:\s*min\(820px,\s*100%\)/)
  assert.match(managementBlocks[0], /max-height:\s*100%/)

  assert.match(managementBlocks[1], /width:\s*100%/)
  assert.match(managementBlocks[1], /max-width:\s*100%/)
  assert.match(managementBlocks[1], /height:\s*100%/)
  assert.match(managementBlocks[1], /max-height:\s*100%/)

  for (const block of managementBlocks) {
    assert.doesNotMatch(block, /100vw|100vh/)
  }
})

test('compact popover uses one approved empty-state Stash icon and routes to the global manager', () => {
  const popover = read('./StashManagementPopover.jsx')
  const hook = read('./useStashSnapshotState.js')
  const actions = read('./StashEntryActionMenu.jsx')
  const css = read('./StashManagementPopover.css')
  const microCss = read('./StashMicroPolish.css')

  assert.match(popover, /slice\(0, 3\)/)
  assert.match(popover, /useStashSnapshotState\(repoPath\)/)
  assert.match(hook, /subscribeStashSnapshot/)
  assert.doesNotMatch(popover, /subscribeStashSnapshot|readStashSnapshot|peekStashSnapshot/)
  assert.match(popover, /<StashEntryActionMenu/)
  assert.doesNotMatch(popover, /function StashIcon/)
  assert.equal((popover.match(/<StashIcon/g) || []).length, 1)
  assert.match(popover, /stash-management-popover__empty-icon/)
  assert.match(popover, /查看全部 Stash…/)
  assert.match(actions, /应用/)
  assert.match(actions, /应用并删除/)
  assert.match(actions, /查看详情/)
  assert.match(actions, /删除 Stash/)
  assert.match(css, /width: min\(320px/)
  assert.match(microCss, /\.stash-management-popover__empty-icon/)
})

test('micro polish keeps the empty state compact, create close icon-only, and sort highlight full-width', () => {
  const popover = read('./StashManagementPopover.jsx')
  const create = read('./stash-create/CreateStashDialog.jsx')
  const list = read('./stash-manager/StashManagerList.jsx')
  const css = read('./StashMicroPolish.css')

  assert.match(popover, /stash-management-popover__empty-copy/)
  assert.match(create, /import \{ CloseIcon \} from '\.\.\/icons\/CanonicalIcons\.jsx'/)
  assert.match(create, /className="stash-manager-icon-button"/)
  assert.match(create, /aria-label="关闭创建 Stash"/)
  assert.doesNotMatch(create, />关闭<\/button>/)
  assert.match(list, /<CustomSelect/)
  assert.match(css, /\.stash-management-popover__empty \{[\s\S]*display: flex;/)
  assert.match(css, /\.stash-management-popover__empty \{[\s\S]*gap: 18px;/)
  assert.match(css, /\.stash-management-popover__empty-icon \{[\s\S]*width: 28px;/)
  assert.match(css, /\.stash-manager-sort-select \{[\s\S]*width: 152px;/)
  assert.match(css, /\.stash-manager-sort-select \.custom-select__option \{[\s\S]*width: 100%;/)
})

test('Stash CSS has one root load-order authority independent of lazy mount order', () => {
  const main = read('./main.jsx')
  const authority = read('./StashStyleAuthority.css')
  const components = [
    './WorkingChangesStashEntry.jsx',
    './stash-create/CreateStashDialog.jsx',
    './stash-create/CreateStashForm.jsx',
    './StashScopeResolutionPanel.jsx',
    './StashManagementPopover.jsx',
    './StashEntryActionMenu.jsx',
    './StashDetailView.jsx',
    './stash-manager/StashManagerDialog.jsx',
    './stash-manager/StashManagerList.jsx',
    './stash-manager/StashOperationSurfaces.jsx',
  ]

  assert.match(main, /import '\.\/StashStyleAuthority\.css'/)
  for (const stylesheet of [
    'StashManagerDialog.css',
    'CreateStashDialog.css',
    'StashManagementPopover.css',
    'StashEntryActionMenu.css',
    'StashDetailView.css',
    'stash-manager/StashManagerLayout.css',
    'stash-manager/StashManagerTable.css',
    'StashFinalPolish.css',
    'StashMicroPolish.css',
  ]) {
    assert.match(authority, new RegExp(`@import ['"]\\./${stylesheet.replace('.', '\\.')}['"]`))
  }
  for (const component of components) {
    assert.doesNotMatch(read(component), /import ['"][^'"]+\.css['"]/)
  }
})

test('source-level detail and long-list tests target modular production owners', () => {
  const detailTests = read('./stashDetail.test.js')
  const longListTests = read('./stashLongList.test.js')

  assert.match(detailTests, /read\('\.\/stash-manager\/StashManagerDialog\.jsx'\)/)
  assert.match(detailTests, /read\('\.\/stash-manager\/StashManagerList\.jsx'\)/)
  assert.match(longListTests, /read\('\.\/stash-manager\/StashManagerList\.jsx'\)/)
  assert.doesNotMatch(detailTests, /const manager = read\('\.\/StashManagerDialog\.jsx'\)/)
  assert.doesNotMatch(longListTests, /const dialog = read\('\.\/StashManagerDialog\.jsx'\)/)
})

test('Stash surfaces reuse shared icon authorities for equivalent actions', () => {
  const icons = read('./icons/CanonicalIcons.jsx')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const popover = read('./StashManagementPopover.jsx')
  const actions = read('./StashEntryActionMenu.jsx')
  const detail = read('./StashDetailView.jsx')
  const workingEntry = read('./WorkingChangesStashEntry.jsx')
  const repoMenu = read('./RepoStashMenuItem.jsx')
  const utils = read('./stash-manager/managerUtils.jsx')

  assert.match(icons, /export const StashIcon = iconComponent\(STASH_ICON\)/)
  assert.match(icons, /export const BranchIcon = iconComponent\(BRANCH_ICON\)/)
  assert.match(icons, /export const RefreshSyncIcon = iconComponent\(REFRESH_SYNC_ICON\)/)
  assert.doesNotMatch(icons, /<svg\b|<path\b/)
  assert.match(manager, /RefreshSyncIcon/)
  assert.match(popover, /RefreshSyncIcon/)
  assert.match(actions, /DeleteIcon/)
  assert.match(detail, /DeleteIcon/)
  assert.match(workingEntry, /StashIcon/)
  assert.match(repoMenu, /import \{ StashIcon \} from '\.\/icons\/CanonicalIcons\.jsx'/)
  assert.doesNotMatch(repoMenu, /<svg|<path/)
  assert.doesNotMatch(utils, /StashIcons/)
  assert.doesNotMatch(`${manager}\n${popover}\n${actions}\n${detail}\n${workingEntry}`, /function RefreshIcon|function DeleteIcon|function BranchIcon|function StashIcon/)
})

test('Escape and Tab remain owned by one dialog navigation layer and sources stay React-owned', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const utils = read('./stash-manager/managerUtils.jsx')
  const detail = read('./StashDetailView.jsx')
  const sources = [
    manager,
    read('./stash-manager/StashManagerList.jsx'),
    read('./StashManagementPopover.jsx'),
    read('./StashEntryActionMenu.jsx'),
    read('./WorkingChangesStashEntry.jsx'),
  ].join('\n')

  assert.match(manager, /confirmDialogRef = useRef\(null\)/)
  assert.match(manager, /trapTabKey\(event, confirm \? confirmDialogRef\.current : dialogRef\.current\)/)
  assert.match(utils, /querySelectorAll\(FOCUSABLE_SELECTOR\)/)
  assert.match(manager, /if \(confirm\) setConfirm\(null\)/)
  assert.doesNotMatch(manager, /else if \(detailId\) setDetailId\(null\)/)
  assert.doesNotMatch(detail, /返回列表|onBack/)
  assert.doesNotMatch(sources, /MutationObserver|document\.createElement|appendChild|insertBefore|replaceChildren/)
})
