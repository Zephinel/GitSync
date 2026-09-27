import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveWorkingChangesStashEntryMode } from './workingChangesStashEntryMode.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Working Changes owns the approved Stash button pair in real source', () => {
  const view = read('./WorkingChangesView.jsx')
  const entry = read('./WorkingChangesStashEntry.jsx')
  const css = read('./WorkingChangesStashEntry.css')
  const actionAuthority = read('./ActionButtonSurface.css')
  const vite = read('../vite.config.js')

  assert.match(view, /import WorkingChangesStashEntry from '\.\/WorkingChangesStashEntry\.jsx'/)
  assert.match(view, /<WorkingChangesStashEntry/)
  assert.match(entry, /working-changes-stash-split__main/)
  assert.match(entry, /working-changes-stash-split__menu/)
  assert.match(entry, /selectedStashScopeLabel\(files\)/)
  assert.equal((entry.match(/<StashIcon/g) || []).length, 2)
  assert.match(entry, /<CreateStashDialog/)
  assert.match(entry, /<StashManagementPopover/)
  assert.doesNotMatch(vite, /workingChangesStashPlugin|viteWorkingChangesStashPlugin/)
  assert.doesNotMatch(css, /border-radius: 10px 0 0 10px|border-radius: 0 10px 10px 0/)
  assert.match(css, /\.working-changes-stash-split__main\s*\{[\s\S]*border-radius: 10px !important;/)
  assert.match(css, /\.working-changes-stash-split__menu\s*\{[\s\S]*border: 0;[\s\S]*border-radius: 10px;/)
  assert.match(css, /\.working-changes-stash-split\s*\{[\s\S]*gap: 6px;/)
  assert.match(actionAuthority, /\.working-changes-stash-split__menu/)
})

test('clean worktree replaces Stash creation with one direct management action', () => {
  const entry = read('./WorkingChangesStashEntry.jsx')
  const css = read('./WorkingChangesStashEntry.css')

  const clean = resolveWorkingChangesStashEntryMode({
    hasTrackedChanges: false,
    hasUntrackedChanges: false,
    conflictedFiles: 0,
    canCreateDefault: false,
    canCreateWithUntracked: false,
  })
  assert.equal(clean.state, 'clean')
  assert.equal(clean.manageOnly, true)
  assert.equal(clean.canCreate, false)

  const tracked = resolveWorkingChangesStashEntryMode({
    hasTrackedChanges: true,
    hasUntrackedChanges: false,
    conflictedFiles: 0,
    canCreateDefault: true,
    canCreateWithUntracked: true,
  })
  assert.equal(tracked.state, 'changes')
  assert.equal(tracked.manageOnly, false)
  assert.equal(tracked.canCreate, true)

  const untracked = resolveWorkingChangesStashEntryMode({
    hasTrackedChanges: false,
    hasUntrackedChanges: true,
    conflictedFiles: 0,
    canCreateDefault: false,
    canCreateWithUntracked: true,
  })
  assert.equal(untracked.state, 'changes')
  assert.equal(untracked.canCreate, true)

  const conflict = resolveWorkingChangesStashEntryMode({
    hasTrackedChanges: true,
    hasUntrackedChanges: false,
    conflictedFiles: 1,
    canCreateDefault: false,
    canCreateWithUntracked: false,
  })
  assert.equal(conflict.state, 'conflict')
  assert.equal(conflict.manageOnly, false)
  assert.equal(conflict.canCreate, false)

  const unknown = resolveWorkingChangesStashEntryMode(null, { loading: true })
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.manageOnly, false)
  assert.equal(unknown.canCreate, false)

  assert.match(entry, /useStashSnapshotState\(repoPath, \{ autoLoad: false \}\)/)
  assert.match(entry, /refreshSnapshot\(\{ force: true \}\)/)
  assert.match(entry, /if \(entryMode\.manageOnly\)/)
  assert.match(entry, />管理 Stash</)
  assert.match(entry, /onClick=\{\(\) => openManager\(\)\}/)
  assert.match(css, /\.working-changes-stash-manage/)
  assert.match(css, /border-radius: 10px !important/)
})

test('unsupported selected identities use one friendly range-resolution surface', () => {
  const controller = read('./stash-create/CreateStashDialog.jsx')
  const form = read('./stash-create/CreateStashForm.jsx')
  const panel = read('./StashScopeResolutionPanel.jsx')
  const scope = read('./stashScopeResolution.js')

  assert.match(controller, /selectedStashUnsupportedSummary/)
  assert.match(form, /<StashScopeResolutionPanel/)
  assert.match(panel, /import \{ WarningIcon \} from '\.\/icons\/CanonicalIcons\.jsx'/)
  assert.match(panel, /改为 Stash 全部改动/)
  assert.match(panel, /取消暂存后继续/)
  assert.match(panel, /查看 \{summary\.fileCount\} 个文件/)
  assert.match(panel, /尚未执行 Stash，也尚未修改暂存区/)
  assert.match(scope, /staged-deletion/)
  assert.match(scope, /staged-rename-copy/)
  assert.match(scope, /multiple-identities/)
})

test('Unstage and continue reuses staging authority and never constructs raw git reset', () => {
  const controller = read('./stash-create/CreateStashDialog.jsx')
  const scope = read('./stashScopeResolution.js')
  const sources = `${controller}\n${scope}`

  assert.match(controller, /get_repo_staging_snapshot/)
  assert.match(controller, /get_repo_working_diff_summary/)
  assert.match(controller, /buildScopeUnstageTargets\(staging, operationTargets, workingSummary\?\.files\)/)
  assert.match(controller, /unstage_repo_files/)
  assert.match(controller, /expectedSnapshotId/)
  assert.match(scope, /buildScopeUnstageTargets/)
  assert.match(scope, /projectResolvedScopeTargets/)
  assert.doesNotMatch(sources, /git reset|invoke\('reset|Command\.new/)
})

test('create completion closes once and selected scope cannot degrade into Stash-all after refresh', () => {
  const controller = read('./stash-create/CreateStashDialog.jsx')
  const form = read('./stash-create/CreateStashForm.jsx')

  assert.match(controller, /const \[initialTargets\] = useState\(\(\) => normalizeSelectedStashTargets\(files\)\)/)
  assert.doesNotMatch(controller, /useMemo\(\(\) => normalizeSelectedStashTargets\(files\), \[files\]\)/)
  assert.match(controller, /function isConfirmedCreateResult/)
  assert.match(controller, /function shouldLockCreateReplay/)
  assert.match(controller, /guardCompletedCreateResult/)
  assert.match(controller, /if \(shouldLockCreateReplay\(next\)\) setMutationLocked\(true\)/)
  assert.match(controller, /if \(closeAfterSettle\) onClose\?\.\(\)/)
  assert.match(controller, /runningRef\.current \|\| mutationLocked/)
  assert.match(form, /mutationLocked = false/)
  assert.match(form, /为防止把剩余文件再次 Stash/)
  assert.match(form, /disabled=\{busy \|\| mutationLocked\}/)
})

test('compact management and per-entry overflow replace inline mutation buttons', () => {
  const popover = read('./StashManagementPopover.jsx')
  const actions = read('./StashEntryActionMenu.jsx')
  const css = read('./StashManagementPopover.css')

  assert.match(popover, /slice\(0, 3\)/)
  assert.match(popover, /文件数读取中/)
  assert.match(popover, /<StashEntryActionMenu/)
  assert.doesNotMatch(popover, />应用<|>应用并删除<|>删除</)
  assert.match(actions, /应用并删除/)
  assert.match(actions, /查看详情/)
  assert.match(actions, /stash-entry-action-menu__separator/)
  assert.match(actions, /stash-entry-action-menu__danger/)
  assert.match(css, /width: min\(320px/)
})

test('full manager keeps stable OID routing, query-session filename search and bounded pagination', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const list = read('./stash-manager/StashManagerList.jsx')
  const index = read('./stash-manager/useStashDetailIndex.js')
  const repository = read('./stashDetailRepository.js')

  assert.match(manager, /findStashEntry\(snapshot, initialStashId\)/)
  assert.match(manager, /buildTargetStashRequest\(snapshot, entry\.id, requestId\)/)
  assert.match(manager, /<StashDetailView/)
  assert.match(list, /branchFilter/)
  assert.match(list, /sortDirection/)
  assert.match(list, /搜索 Stash 说明或文件名/)
  assert.match(list, /matchesQuery/)
  assert.match(list, /getFileCount/)
  assert.match(list, /PAGE_SIZE = 8/)
  assert.match(index, /DETAIL_BATCH_SIZE = 4/)
  assert.match(index, /SEARCH_PROGRESS_BATCH_SIZE = 12/)
  assert.match(index, /searchMatchesRef/)
  assert.match(index, /searchUnknownRef/)
  assert.match(index, /stashDetailSearchState/)
  assert.match(index, /matchesQuery/)
  assert.match(index, /searchIncomplete:/)
  assert.match(repository, /invokeNative\('get_repo_stash_detail'/)
})

test('one global Manager owner receives every Working Changes intent', () => {
  const entry = read('./WorkingChangesStashEntry.jsx')
  const layer = read('./RepoStashManagerLayer.jsx')
  const bridge = read('./stashManagerAppBridge.js')
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const hook = read('./useStashSnapshotState.js')
  const snapshotRepository = read('./stashSnapshotRepository.js')

  assert.doesNotMatch(entry, /WorkingChangesStashDialog|SelectedStashCreateDialog|<StashManagerDialog/)
  assert.match(entry, /dispatchStashManagerOpen/)
  assert.match(layer, /<StashManagerDialog/)
  assert.match(layer, /initialStashId=\{target\.initialStashId\}/)
  assert.match(layer, /initialOperation=\{target\.initialOperation\}/)
  assert.match(bridge, /openId/)
  assert.match(bridge, /let owner = null/)
  assert.doesNotMatch(bridge, /const listeners = new Set/)
  assert.match(manager, /useStashSnapshotState\(repoPath\)/)
  assert.match(hook, /readStashSnapshot/)
  assert.match(hook, /subscribeStashSnapshot/)
  assert.doesNotMatch(manager, /readStashSnapshot|subscribeStashSnapshot|invoke\('get_repo_stash_snapshot'/)
  assert.equal((snapshotRepository.match(/invokeNative\('get_repo_stash_snapshot'/g) || []).length, 1)
  assert.doesNotMatch(`${entry}\n${manager}`, /MutationObserver|appendChild|insertBefore|replaceChildren/)
})
