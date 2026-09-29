import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeBranchOverviewRow, shouldShowBranchOverviewRow } from './branchOverviewUtils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(__dirname, 'App.jsx'), 'utf8')
const appCssSource = readFileSync(join(__dirname, 'App.css'), 'utf8')
const branchOverviewUtilsSource = readFileSync(join(__dirname, 'branchOverviewUtils.js'), 'utf8')
const mainSource = readFileSync(join(__dirname, 'main.jsx'), 'utf8')

function literalPattern(...parts) {
  return new RegExp(parts.join(''))
}

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `missing end marker: ${endNeedle}`)
  return source.slice(start, end)
}

test('does not restore the old remote-branch prompt surface', () => {
  assert.doesNotMatch(appSource, literalPattern('Remote', 'BranchPromptDialog'))
  assert.doesNotMatch(appSource, literalPattern('splitRepoIdsBy', 'Remote', 'Branch', 'Prompt'))
  assert.doesNotMatch(appSource, new RegExp('remoteBranch' + 'Prompt', 'i'))
  assert.doesNotMatch(appSource, literalPattern('repo-card__branch-', 'update-pill'))
  assert.doesNotMatch(appCssSource, /remote-branch-dialog/)
  assert.doesNotMatch(appCssSource, literalPattern('repo-card__branch-', 'update-pill'))
  assert.doesNotMatch(mainSource, literalPattern('branchSurface', 'Overrides'))
})

test('remote refresh surfaces branch attention with inline shortcut actions', () => {
  assert.match(appSource, /getBranchAttention\(branchOverview\)/)
  assert.match(appSource, /className="repo-card__branch-attention"/)
  assert.match(appSource, /branchAttention\.action === 'details'/)
  assert.match(appSource, /handleBranchOperation\(branchAttention\.action, branchAttention\.branchItem\)/)
  assert.match(appSource, /commandName = 'switch_and_update_repo_branch'/)
  assert.match(
    appSource,
    /invoke\('refresh_repo_remote',[\s\S]*invoke\('get_repo_branch_overview'/
  )
})

test('passive refresh overlay forwards a manual sync request instead of swallowing it', () => {
  const repoCardSource = sourceBetween(
    appSource,
    'function RepoCard({',
    'function DashboardGroupEntries({'
  )

  assert.match(
    repoCardSource,
    /const canRequestSyncFromRefreshOverlay = !isBranchSwitchBusy[\s\S]*\(isRemoteRefreshing \|\| isFocusRefreshing\)/
  )
  assert.match(
    repoCardSource,
    /if \(isActionOverlayVisible && !canRequestSyncFromRefreshOverlay\) return/
  )
  assert.match(
    repoCardSource,
    /className="repo-card__actions-checking-overlay"[\s\S]*onClick=\{canRequestSyncFromRefreshOverlay \? handleSync : undefined\}/
  )
  assert.match(
    repoCardSource,
    /onSync\(repo\.id, \{ trigger \}\)/
  )
})

test('remote refresh loading is derived from the refresh state machine', () => {
  const refreshSource = sourceBetween(
    appSource,
    'async function runRemoteRefreshRound(',
    '  const fetchRepos = useCallback'
  )

  // The round reports per-repository progress; the machine owns the busy set.
  assert.match(refreshSource, /progress\.track\(reposToRefresh\.map\(\(repo\) => repo\.id\)\)/)
  assert.match(refreshSource, /progress\.settle\(repo\.id\)/)
  assert.doesNotMatch(refreshSource, /setRemoteRefreshingRepoIds/)
  assert.match(appSource, /createRefreshMachine\(\{/)
  assert.match(appSource, /const remoteRefreshSnapshot = useSyncExternalStore/)
  assert.match(appSource, /branchRefreshSnapshot\.activeRepoIds/)
})

test('each remote refresh round tracks its active repo ids independently of visibility', () => {
  const roundStartSource = sourceBetween(
    appSource,
    'async function runRemoteRefreshRound(',
    '    const refreshFailures = []'
  )

  assert.match(
    roundStartSource,
    /progress\.track\(reposToRefresh\.map\(\(repo\) => repo\.id\)\)/
  )
  assert.doesNotMatch(roundStartSource, /shouldShowOverlay|pageRef\.current|isWindowFocusedRef\.current/)
})

test('the refresh machine owns the busy state, with no leftover mirrored identifiers', () => {
  for (const identifier of [
    'remoteRefreshingRepoIds',
    'branchRemoteRefreshingRepoIds',
    'runQueuedRemoteRefresh',
    'runQueuedSingleFlight',
    'remoteRefreshInFlightRef',
    'remoteRefreshQueuedManualOnlyRef',
  ]) {
    assert.doesNotMatch(
      appSource,
      new RegExp(`\\b${identifier}\\b`),
      `${identifier} must be gone now that the refresh machine owns it`
    )
  }
  assert.match(appSource, /remoteRefreshMachineRef\.current\.request\(/)
  assert.match(appSource, /repoFetchMachineRef\.current\.request\(/)
  assert.match(appSource, /branchRefreshMachineRef\.current\.request\(/)
})

test('sync diagnostics persist a bounded correlated lifecycle without sensitive command data', () => {
  const diagnosticNormalizerSource = sourceBetween(
    appSource,
    'function normalizeSyncDiagnosticEvent(event) {',
    'function loadSyncDiagnosticEvents() {'
  )

  assert.match(appSource, /const SYNC_DIAGNOSTIC_STORAGE_KEY = 'gitsync-sync-diagnostics'/)
  assert.match(appSource, /const MAX_SYNC_DIAGNOSTIC_EVENTS = 1000/)
  assert.match(appSource, /function trimSyncDiagnosticEvents\(events\) \{[\s\S]*slice\(-MAX_SYNC_DIAGNOSTIC_EVENTS\)/)
  assert.match(diagnosticNormalizerSource, /requestId:/)
  assert.match(diagnosticNormalizerSource, /jobId:/)
  assert.match(diagnosticNormalizerSource, /repoId:/)
  assert.match(diagnosticNormalizerSource, /trigger:/)
  assert.doesNotMatch(diagnosticNormalizerSource, /repoPath|commitMessage|command|remoteUrl|errorMessage/)
  assert.match(appSource, /phase: 'request_received'/)
  assert.match(appSource, /phase: 'guard_completed'/)
  assert.match(appSource, /phase: 'queue_enqueued'/)
  assert.match(appSource, /phase: 'job_started'/)
  assert.match(appSource, /phase: 'backend_completed'/)
  assert.match(appSource, /requestId: currentJob\.requestId,[\s\S]*didPull,[\s\S]*didPush,/)
  assert.match(appSource, />\s*复制诊断日志\s*</)
  assert.doesNotMatch(appSource, />\s*复制错误日志\s*</)
  assert.match(
    appSource,
    /const handleCopyDiagnosticBundle = async \(\) => \{[\s\S]*loadSyncDiagnosticEvents\(\)[\s\S]*loadAppErrorLog\(\)[\s\S]*createDiagnosticBundlePayload\(/
  )
  assert.match(appSource, /onCopyDiagnostics=\{handleCopyDiagnosticBundle\}/)
})

test('repository meta hover cards use delayed state instead of immediate css hover', () => {
  assert.match(appSource, /const META_HOVER_OPEN_DELAY_MS = 600/)
  assert.match(appSource, /const META_HOVER_CLOSE_DELAY_MS = 180/)
  // The delayed open/close lifecycle is owned by one key-aware controller. The previous
  // shared `metaHoverOpenTimerRef` / `metaHoverCloseTimerRef` pair is what allowed one key's
  // intent to cancel another key's pending intent, so it must not come back.
  assert.match(appSource, /createRepoMetaHoverController\(/)
  assert.match(appSource, /openDelayMs: META_HOVER_OPEN_DELAY_MS/)
  assert.match(appSource, /closeDelayMs: META_HOVER_CLOSE_DELAY_MS/)
  assert.match(appSource, /createMetaHoverRegionBindings\(/)
  assert.doesNotMatch(appSource, /metaHoverOpenTimerRef|metaHoverCloseTimerRef/)
  assert.doesNotMatch(appSource, /scheduleMetaHoverOpen|scheduleMetaHoverClose|openMetaHoverCardByKey/)
  assert.doesNotMatch(appCssSource, /\.repo-card__meta-hover-host:hover \.repo-card__meta-hover-card/)
  assert.doesNotMatch(appCssSource, /\.repo-card__meta-hover-host:focus-within \.repo-card__meta-hover-card/)
  assert.match(appCssSource, /\.repo-card__meta-hover-host--open \.repo-card__meta-hover-card/)
})

test('repository meta copy buttons stay outside path and branch hover ownership', () => {
  const pathMetaSource = sourceBetween(
    appSource,
    'className={pathMetaHostClassName}',
    'ref={branchMetaHostRef}'
  )
  const branchMetaSource = sourceBetween(
    appSource,
    'ref={branchMetaHostRef}',
    'ref={commitMetaHostRef}'
  )

  assert.match(
    pathMetaSource,
    /className="repo-card__meta-hover-target"[\s\S]*?\{\.\.\.pathMetaHostBindings\}[\s\S]*?<Icons\.folder[\s\S]*?<\/div>\s*<button[\s\S]*?className="repo-card__meta-copy-btn"/,
    'path copy should be a sibling of the path hover target'
  )
  assert.match(
    branchMetaSource,
    /className="repo-card__meta-hover-target"[\s\S]*?\{\.\.\.branchMetaHostBindings\}[\s\S]*?<Icons\.branch[\s\S]*?<\/div>\s*<button[\s\S]*?className="repo-card__meta-copy-btn"/,
    'branch copy should be a sibling of the branch hover target'
  )
  assert.match(
    appCssSource,
    /\.repo-card__meta-hover-target,\s*\.repo-card__latest-commit-hover-target\s*\{[\s\S]*?display:\s*flex;/,
    'path, branch, and commit hover targets should share the same row geometry'
  )
})

test('closing the branch hover card clears transient operation feedback', () => {
  const feedbackLifecycleSource = sourceBetween(
    appSource,
    'const previousOpenMetaHoverCardRef = useRef(null)',
    'const updateBranchHoverLayout = useCallback'
  )

  assert.match(
    feedbackLifecycleSource,
    /previousOpenMetaHoverCard === 'branch' && openMetaHoverCard !== 'branch'/
  )
  assert.match(feedbackLifecycleSource, /setBranchSwitchError\(''\)/)
  assert.match(feedbackLifecycleSource, /setBranchOperationWarning\(''\)/)
})

test('branch attention can dismiss the current snapshot with an svg icon', () => {
  assert.match(appSource, /getBranchAttentionKey\(branchOverview\)/)
  assert.match(appSource, /branchAttentionKey !== dismissedBranchAttentionKey/)
  assert.match(appSource, /aria-label="忽略本次分支动态"/)
  assert.match(appSource, /<Icons\.close className="icon icon--xs" \/>/)
  assert.match(appCssSource, /\.repo-card__branch-attention-dismiss/)
})

test('branch attention dismissals survive an app restart', () => {
  assert.match(appSource, /readLocalStorageItem\(BRANCH_ATTENTION_DISMISSALS_STORAGE_KEY\)/)
  assert.match(
    appSource,
    /writeLocalStorageItem\(BRANCH_ATTENTION_DISMISSALS_STORAGE_KEY, JSON\.stringify\(dismissedBranchAttentionKeys\)\)/
  )
})

test('branch shortcut failures surface outside the branch overview', () => {
  assert.match(appSource, /onBranchOperationFeedback\?\.\(\{[\s\S]*title: operationError/)
  assert.match(appSource, /message: branchOperationFeedbackMessage/)
  assert.match(appSource, /tone: operationError \? 'danger' : 'warning'/)
  assert.match(appSource, /operationWarning = String\(operationResult\?\.warning \|\| ''\)\.trim\(\)/)
  assert.match(appSource, /operationWarning[\s\S]*\? '分支操作部分完成'/)
  assert.match(appSource, /success: !operationError && !operationWarning/)
  assert.match(appSource, /setStatusToastData\(feedback\)/)
})

test('keychain account restore is lazy and not wired to startup effects', () => {
  const beforeLazyRestore = appSource.slice(0, appSource.indexOf('const restoreGithubAccountOnDemand'))
  assert.doesNotMatch(beforeLazyRestore, /github_get_account/)
  assert.match(
    appSource,
    /const restoreGithubAccountOnDemand = useCallback\(async \(\) => \{[\s\S]*invoke\('github_get_account'\)/
  )
  assert.match(
    appSource,
    /const handleGithubLogin = useCallback\(async \(\) => \{[\s\S]*await restoreGithubAccountOnDemand\(\)/
  )
  assert.match(
    appSource,
    /const handleSelectGithubRepos = async \(\) => \{[\s\S]*await restoreGithubAccountOnDemand\(\)/
  )
})

test('a GitHub connectivity failure is not reported as a logged-out account', () => {
  const commandsSource = readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'commands.rs'), 'utf8')
  const deviceAuthSource = readFileSync(join(__dirname, 'DeviceAuthDialog.jsx'), 'utf8')

  // 钥匙串「没有这一项」和「有但读不到」必须分开返回，否则访问受限会被显示成未登录。
  assert.match(commandsSource, /fn read_github_token\(\) -> Result<Option<String>, String>/)
  assert.match(commandsSource, /Err\(keyring::Error::NoEntry\) => Ok\(None\)/)

  // 账号查询返回结构化状态，网络/钥匙串失败不再折叠成 Err。
  assert.match(commandsSource, /pub enum GithubAccountLookup/)
  for (const variant of ['NoToken', 'Unauthorized', 'KeychainUnavailable', 'NetworkUnavailable', 'RequestFailed']) {
    assert.match(commandsSource, new RegExp(variant))
  }
  assert.match(commandsSource, /fn describe_request_error\(error: &reqwest::Error\) -> String/)
  assert.match(commandsSource, /map_err\(\|e\| format!\("请求失败: \{\}", describe_request_error\(&e\)\)\)/)

  // device flow 收尾：token 先落盘，账号信息取不到时返回可重试的结构化结果。
  const pollCommand = sourceBetween(commandsSource, 'pub async fn github_poll_token', 'pub fn github_cancel_device_auth')
  assert.ok(
    pollCommand.indexOf('store_github_token(&token)?') < pollCommand.indexOf('GITHUB_API_USER_URL'),
    'the device-flow token must be stored before the account lookup'
  )
  assert.match(pollCommand, /GithubLoginOutcome::AccountUnavailable/)

  // 前端只在「没有凭据 / 凭据失效」时回到未登录；其余失败保留状态并提示。
  assert.match(appSource, /if \(status === 'no-token' \|\| status === 'unauthorized'\) \{[\s\S]*?setGithubAccount\(null\)/)
  assert.match(appSource, /function buildGithubConnectivityNotice\(restored\) \{/)
  assert.match(appSource, /setNoticeData\(buildGithubConnectivityNotice\(restored\)\)/)
  assert.match(appSource, /scope: 'github-login'/)

  // 已授权但取账号失败时，对话框的「重试」只重取账号，不重新走一遍浏览器授权。
  assert.match(deviceAuthSource, /result\?\.status === 'account-unavailable'[\s\S]*?setRetryAccountOnly\(true\)/)
  assert.match(deviceAuthSource, /if \(retryAccountOnly\) \{[\s\S]*?invoke\('github_get_account'\)/)
})

test('branch rows use explicit action buttons instead of row click handlers', () => {
  const branchRowMarkup = sourceBetween(
    appSource,
    'className={branchRowClassName}',
    '<div className="repo-card__branch-row-main">'
  )
  assert.doesNotMatch(branchRowMarkup, /role=/)
  assert.doesNotMatch(branchRowMarkup, /tabIndex=/)
  assert.doesNotMatch(branchRowMarkup, /onKeyDown=/)
  assert.doesNotMatch(branchRowMarkup, /onClick=/)
  assert.match(appSource, /handleBranchOperation\('switch', branchItem\)/)
  assert.match(appSource, /handleBranchOperation\('track', branchItem\)/)
  assert.match(appSource, /handleBranchOperation\('rebind', branchItem\)/)
  assert.match(appSource, /handleBranchOperation\('unset-upstream', branchItem\)/)
})

test('branch row actions and disabled states cover the expected branch cases', () => {
  assert.match(appSource, /const currentBranchName = status\?\.branch \|\| repo\.branch \|\| 'main'/)
  assert.match(branchOverviewUtilsSource, /const isRemoteRow = identity\.startsWith\('remote:'\)/)
  assert.match(appSource, /key=\{String\(branchItem\?\.identity \|\| branchItem\?\.full_ref \|\| rowName\)\}/)
  assert.match(appSource, /if \(comparisonState === 'error'\)[\s\S]*return \{ text: '读取失败'/)
  assert.match(appSource, /if \(comparisonState === 'detached'\)[\s\S]*return \{ text: 'Detached'/)
  assert.match(appSource, /if \(upstreamGone \|\| comparisonState === 'upstream-gone'\)[\s\S]*上游已删除/)
  assert.match(appSource, /if \(isRemoteOnly\)[\s\S]*仅远端/)
  assert.doesNotMatch(appSource, /已有本地/)
  assert.match(branchOverviewUtilsSource, /function normalizeBranchOverviewRow\(branchItem\) \{[\s\S]*identity\.startsWith\('remote:'\)/)
  assert.match(branchOverviewUtilsSource, /function shouldShowBranchOverviewRow\(branchItem, branchItems = \[\]\) \{[\s\S]*localUpstream !== branchMeta\.rowName/)
  assert.match(appSource, /shouldShowBranchOverviewRow\(branchItem, branchOverviewList\)/)
  assert.match(appSource, /visibleBranchOverviewList\.map\(\(branchItem\) =>/)
  assert.match(appSource, /if \(isCheckedOutElsewhere\)[\s\S]*其他 worktree/)
  const branchDisableHelper = sourceBetween(
    appSource,
    'function getBranchWriteDisableReason({',
    'function getBranchSwitchOverlayState'
  )
  assert.doesNotMatch(branchDisableHelper, /isDetachedHead/)
  assert.doesNotMatch(branchDisableHelper, /detached HEAD 下不可切换分支/)
  assert.match(appSource, /if \(conflictedCount > 0\) return '存在冲突/)
  assert.match(appSource, /if \(modifiedCount > 0\) return '工作区或暂存区存在未提交改动/)
  assert.match(appSource, /if \(isBranchOperationBusy\) return branchOperationTarget/)
  assert.match(appSource, /if \(isCheckedOutElsewhere\) return worktreePath/)
  assert.match(appSource, /if \(comparisonState === 'error'\) return '分支状态读取失败/)
  assert.match(appSource, /const canSwitchLocal = !localSwitchReason && !isRemoteOnly && !isCurrent && !isRemoteRow/)
  assert.match(appSource, /const canTrackRemote = !trackReason && isRemoteOnly && !hasLocal/)
  assert.match(appSource, /const canRebind = !rebindReason && upstreamGone && !isRemoteOnly/)
  assert.match(
    appSource,
    /const canSwitchBranch = modifiedCount === 0 && conflictedCount === 0 && !isSyncing && !isQueued/
  )
  assert.match(appSource, /const canUnsetUpstream = !unsetReason && upstreamGone && !isRemoteOnly/)
  assert.match(appSource, /\{!isCurrent && upstreamGone && !isRemoteOnly && rebindUpstream \? \(/)
  assert.match(appSource, /\{!isCurrent && upstreamGone && !isRemoteOnly \? \(/)
})

test('branch rows expose delete with the canonical checkbox confirmation', () => {
  assert.match(appSource, /function BranchDeleteConfirmDialog/)
  assert.match(appSource, /className="delete-dialog branch-delete-dialog"/)
  assert.match(appSource, /import CanonicalCheckbox from '\.\/CanonicalCheckbox\.jsx'/)
  assert.match(appSource, /<CanonicalCheckbox[\s\S]*className=\{`branch-delete-dialog__remote-option/)
  assert.match(appSource, /同时删除远程分支/)
  assert.match(appSource, /const deleteRequest = buildBranchDeleteRequest\(/)
  assert.match(appSource, /normalizeBranchDeleteTarget\(branchItem\)/)
  assert.match(appSource, /commandName = 'delete_repo_branches_batch'/)
  assert.doesNotMatch(appSource, /force_delete_repo_branches_batch/)
  assert.match(appSource, /handleRequestBranchDelete\(branchItem\)/)
  assert.match(appSource, /<Icons\.trash className="icon icon--sm" \/>/)
  assert.doesNotMatch(appSource, /commandName = 'delete_repo_branch'/)
  assert.doesNotMatch(appCssSource, /\.branch-delete-dialog__checkbox-input/)
  assert.doesNotMatch(appCssSource, /\.branch-delete-dialog__checkbox-box/)
  assert.doesNotMatch(appCssSource, /accent-color/)
})

test('hover delete shares the force-delete authority and the persisted default', () => {
  const dialogSource = sourceBetween(
    appSource,
    'function BranchDeleteConfirmDialog({',
    'function RepoCard({'
  )

  assert.match(appSource, /import \{ readBranchForceDeleteDefault \} from '\.\/branchForceDeleteSettings'/)
  assert.match(dialogSource, /const hasLocalDelete = !remoteRequired && Boolean\(branchName\)/)
  assert.match(dialogSource, /setForceDelete\(Boolean\(hasLocalDelete && readBranchForceDeleteDefault\(\)\)\)/)
  assert.match(dialogSource, /className="branch-delete-dialog__force-option"/)
  assert.match(dialogSource, /强制删除本地分支（git branch -D）/)
  assert.match(dialogSource, /forceDelete: hasLocalDelete && forceDelete/)
  assert.match(dialogSource, /\{hasLocalDelete \? \(/)
  assert.match(appCssSource, /\.branch-delete-dialog__force-option/)
})

test('remote-only branch delete uses a static warning instead of a disabled checkbox', () => {
  const dialogSource = sourceBetween(
    appSource,
    'function BranchDeleteConfirmDialog({',
    'function RepoCard({'
  )

  assert.match(dialogSource, /remoteRequired \? \(/)
  assert.match(dialogSource, /className="branch-delete-dialog__remote-required"/)
  assert.match(dialogSource, /<Icons\.warning className="icon icon--xs" \/>/)
  assert.match(dialogSource, /将删除远程分支/)
  assert.match(dialogSource, /\) : \([\s\S]*<CanonicalCheckbox/)
  assert.doesNotMatch(dialogSource, /checkboxDisabled = busy \|\| remoteRequired/)
  assert.match(appCssSource, /\.branch-delete-dialog__remote-required-icon/)
})

test('branch delete stays pending through refresh and reports a successful result', () => {
  const dialogSource = sourceBetween(
    appSource,
    'function BranchDeleteConfirmDialog({',
    'function RepoCard({'
  )
  const confirmSource = sourceBetween(
    appSource,
    'const handleConfirmBranchDelete = useCallback',
    'const handleBranchAttentionAction = useCallback'
  )

  assert.match(dialogSource, /busy = false/)
  assert.match(dialogSource, /refreshing = false/)
  assert.match(dialogSource, /busy[\s\S]*\? \(forceDelete \? '强制删除中\.\.\.' : refreshing \? '更新状态\.\.\.' : '删除中\.\.\.'\)[\s\S]*: \(forceDelete \? '确认强制删除' : '确认删除'\)/)
  assert.match(appSource, /const \[branchDeleteSubmitting, setBranchDeleteSubmitting\] = useState\(false\)/)
  assert.match(appSource, /const \[branchDeletePresent, setBranchDeletePresent\] = useState\(false\)/)
  assert.match(confirmSource, /setBranchDeleteSubmitting\(true\)/)
  assert.match(confirmSource, /setBranchDeletePresent\(false\)[\s\S]*finally \{[\s\S]*setBranchDeleteSubmitting\(false\)/)
  assert.match(appSource, /present=\{branchDeletePresent\}[\s\S]*onExitComplete=\{\(\) => setBranchDeleteConfirm\(null\)\}/)
  assert.match(appSource, /busy=\{branchDeleteSubmitting \|\| isBranchSwitchBusy\}/)
  assert.match(appSource, /refreshing=\{isBranchRefreshing\}/)
  assert.match(confirmSource, /title: forced \? '分支强制删除成功' : '分支删除成功'/)
  assert.match(confirmSource, /tone: 'success'/)
})

test('branch overview folds only the remote ref already represented by a local upstream', () => {
  const rows = [
    { identity: 'local:feature', name: 'feature', local_name: 'feature', has_local: true, upstream: 'origin/feature' },
    { identity: 'remote:refs/remotes/origin/feature', name: 'origin/feature', local_name: 'feature', has_local: true },
    { identity: 'remote:refs/remotes/upstream/feature', name: 'upstream/feature', local_name: 'feature', has_local: true },
  ]

  assert.equal(shouldShowBranchOverviewRow(rows[0], rows), true)
  assert.equal(shouldShowBranchOverviewRow(rows[1], rows), false)
  assert.equal(shouldShowBranchOverviewRow(rows[2], rows), true)
  assert.deepEqual(normalizeBranchOverviewRow(rows[2]), {
    identity: 'remote:refs/remotes/upstream/feature',
    isRemoteRow: true,
    isRemoteOnly: false,
    hasLocal: true,
    rowName: 'upstream/feature',
    localName: 'feature',
    upstream: '',
  })
})

test('branch overview preserves all same-name remotes when the local branch has no upstream', () => {
  const rows = [
    { identity: 'local:feature', name: 'feature', local_name: 'feature', has_local: true, upstream: null },
    { identity: 'remote:refs/remotes/origin/feature', name: 'origin/feature', local_name: 'feature', has_local: true },
    { identity: 'remote:refs/remotes/upstream/feature', name: 'upstream/feature', local_name: 'feature', has_local: true },
  ]

  assert.equal(shouldShowBranchOverviewRow(rows[1], rows), true)
  assert.equal(shouldShowBranchOverviewRow(rows[2], rows), true)
})

test('branch rows separate branch names from right-side state and actions', () => {
  const branchRowNameArea = sourceBetween(
    appSource,
    '<div className="repo-card__branch-row-main">',
    '<div className="repo-card__branch-row-actions">'
  )
  assert.match(branchRowNameArea, /repo-card__branch-row-name-wrap/)
  assert.match(branchRowNameArea, /repo-card__branch-row-name/)
  assert.match(branchRowNameArea, /scheduleBranchNameTooltip\(rowName, event\.currentTarget\)/)
  assert.match(branchRowNameArea, /onMouseLeave=\{hideBranchNameTooltip\}/)
  assert.doesNotMatch(branchRowNameArea, /repo-card__branch-row-tags/)
  assert.match(branchRowNameArea, /aria-label=\{rowName\}/)

  const branchRowActionArea = sourceBetween(
    appSource,
    '<div className="repo-card__branch-row-actions">',
    '{!isCurrent && !isRemoteOnly ? ('
  )
  assert.match(branchRowActionArea, /repo-card__branch-row-tags/)
  assert.match(branchRowActionArea, /repo-card__branch-row-state/)
  assert.ok(
    branchRowActionArea.indexOf('repo-card__branch-row-tags') < branchRowActionArea.indexOf('repo-card__branch-row-state'),
    'branch tags should sit in the right-side action area before the state pill'
  )
})

test('branch row CSS uses a two-zone layout and portal full-name tooltip', () => {
  assert.match(
    appCssSource,
    /\.repo-card__branch-row \{[\s\S]*display: grid;[\s\S]*grid-template-columns: minmax\(0, 1fr\) max-content;/
  )
  assert.match(
    appCssSource,
    /\.repo-card__branch-row-actions \{[\s\S]*flex-wrap: nowrap;[\s\S]*min-width: max-content;/
  )
  assert.match(
    appCssSource,
    /\.app-tooltip \{[\s\S]*position: fixed;[\s\S]*z-index: var\(--z-app-tooltip\);[\s\S]*pointer-events: none;/
  )
  assert.doesNotMatch(appCssSource, /\.repo-card__branch-row-name-tooltip/)
  assert.match(
    appSource,
    /<AppTooltipSurface anchor=\{branchNameTooltip\.anchor\} text=\{branchNameTooltip\.text\} \/>/
  )
  assert.match(
    appSource,
    /branchNameTooltipTimerRef\.current = setTimeout\(\(\) => \{[\s\S]*setBranchNameTooltip\([\s\S]*\}, APP_TOOLTIP_DELAY_MS\)/
  )
  assert.match(
    appSource,
    /import \{[\s\S]*isTextVisuallyTruncated,[\s\S]*\} from '\.\/appTooltip\.js'/
  )
  assert.match(
    appSource,
    /branchNameTooltipTimerRef\.current = setTimeout\(\(\) => \{[\s\S]*if \(!isTextVisuallyTruncated\(textElement\)\) return[\s\S]*setBranchNameTooltip\([\s\S]*\}, APP_TOOLTIP_DELAY_MS\)/
  )
})

test('disabled branch actions do not expose browser-native reason tooltips', () => {
  const branchRowActionArea = sourceBetween(
    appSource,
    '<div className="repo-card__branch-row-actions">',
    'className="repo-card__branch-row-copy"'
  )

  assert.match(branchRowActionArea, /data-app-tooltip=\{canSwitchLocal \? `切换到 \$\{rowName\}` : undefined\}/)
  assert.match(branchRowActionArea, /data-app-tooltip=\{canTrackRemote \? `切换并跟踪 \$\{rowName\}` : undefined\}/)
  assert.match(branchRowActionArea, /data-app-tooltip=\{canRebind \? `重新绑定到 \$\{rebindUpstream\}` : undefined\}/)
  assert.match(branchRowActionArea, /data-app-tooltip=\{canUnsetUpstream \? `取消 \$\{rowName\} 的 upstream` : undefined\}/)
  assert.doesNotMatch(branchRowActionArea, /title=\{[^}]*Reason\}/)
  assert.doesNotMatch(branchRowActionArea, /\btitle=/)
})

test('branch tooltip closes whenever the parent hover card is repositioned', () => {
  const layoutUpdater = sourceBetween(
    appSource,
    'const updateBranchHoverLayout = useCallback(() => {',
    'const updateCommitHoverLayout = useCallback(() => {'
  )
  const branchLayoutEffect = sourceBetween(
    appSource,
    "if (openMetaHoverCard !== 'branch') {\n      setBranchHoverCardPlacement",
    "if (openMetaHoverCard !== 'commit') {\n      setCommitHoverCardPlacement"
  )

  assert.match(layoutUpdater, /hideBranchNameTooltip\(\)[\s\S]*if \(openMetaHoverCard !== 'branch'\) return/)
  assert.match(branchLayoutEffect, /window\.addEventListener\('resize', updateBranchHoverLayout\)/)
  assert.match(branchLayoutEffect, /window\.addEventListener\('scroll', updateBranchHoverLayout, true\)/)
  assert.match(branchLayoutEffect, /new ResizeObserver\(updateBranchHoverLayout\)/)
})

test('branch operations refresh only the target repo after any command outcome', () => {
  const operationHandler = sourceBetween(
    appSource,
    'const handleBranchOperation = useCallback(async (operation, branchItem, options = {}) => {',
    '  const handleRequestBranchDelete'
  )
  assert.match(operationHandler, /if \(branchOperationInFlightRef\.current\) return/)
  assert.match(operationHandler, /if \(operation === 'delete'\) \{[\s\S]*if \(isSyncing \|\| isQueued\) return[\s\S]*\} else if \(!canSwitchBranch\) \{/)
  assert.match(operationHandler, /invoke\(commandName, payload\)/)
  assert.match(operationHandler, /setBranchOperationPhase\(BRANCH_SWITCH_PHASE\.refreshing\)/)
  assert.match(
    operationHandler,
    /await onBranchChanged\(repo\.id, \{[\s\S]*remoteAlreadyFetched: operationResult\?\.remote_fetched === true/
  )
  assert.match(operationHandler, /await loadBranchOverview\(true\)/)

  const branchRefreshHandler = sourceBetween(
    appSource,
    'async function runBranchRefreshRound(',
    '  const fetchRepos = useCallback'
  )
  assert.match(branchRefreshHandler, /invoke\('refresh_repo_remote', \{ path: repo\.path \}\)/)
  assert.match(branchRefreshHandler, /invoke\('get_repo_status', \{ path: repo\.path \}\)/)
  assert.match(branchRefreshHandler, /invoke\('refresh_repo_git_metadata', \{ repoId: repo\.id \}\)/)
  assert.doesNotMatch(branchRefreshHandler, /fetchRepos\(/)
})
