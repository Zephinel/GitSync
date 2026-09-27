import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('routes Tauri invocations through a race-safe branch command boundary', () => {
  const vite = readSource('vite.config.js')
  const bridge = readSource('src/tauriCoreBridge.js')
  assert.match(vite, /"@tauri-apps\/api\/core": fileURLToPath/)
  assert.match(bridge, /const BRANCH_OPERATION_COMMANDS = new Set/)
  assert.match(bridge, /export function createBranchCommandBoundary/)
  assert.match(bridge, /beginBranchOperation/)
  assert.match(bridge, /markBranchOperationAwaitingRefresh/)
  assert.match(bridge, /settlePendingRefresh/)
  assert.match(bridge, /failBranchOperation/)
  assert.match(bridge, /recordPendingSnapshot/)
  assert.match(bridge, /getBranchReadGeneration/)
  assert.match(bridge, /subscribeBranchReadInvalidations/)
  assert.match(bridge, /readGeneration !== getBranchReadGeneration/)
  assert.match(bridge, /pending\.readGeneration !== readGeneration/)
  assert.match(bridge, /pendingRefreshByPath\.get\(token\.repoPath\) !== pending/)
  assert.match(bridge, /readSequenceByPath/)
  assert.match(bridge, /appliedOverviewSequenceByPath/)
  assert.match(bridge, /appliedStatusSequenceByPath/)
  assert.match(bridge, /function|const shouldApplyRead/)
  assert.match(bridge, /readSequence < latestApplied/)
  assert.match(bridge, /minimumReadSequence/)
  assert.match(bridge, /readSequence < pending\.minimumReadSequence/)
  assert.match(bridge, /getLatestBranchOverview/)
  assert.match(bridge, /getLatestBranchStatus/)
  assert.match(bridge, /Promise\.allSettled/)
  assert.match(bridge, /BRANCH_OPERATION_REFRESH_FALLBACK_MS = 5000/)
  assert.match(bridge, /BRANCH_OPERATION_BUSY_MESSAGE/)
  assert.match(bridge, /if \(!token\) throw new Error\(BRANCH_OPERATION_BUSY_MESSAGE\)/)
  assert.doesNotMatch(bridge, /setInterval|65000|BRANCH_MANAGEMENT_META_NO_WINDOW_COMMAND/)

  const operationSetStart = bridge.indexOf('const BRANCH_OPERATION_COMMANDS = new Set')
  const operationSetEnd = bridge.indexOf('])', operationSetStart)
  const operationSetSource = bridge.slice(operationSetStart, operationSetEnd + 2)
  assert.doesNotMatch(
    operationSetSource,
    /get_repo_branch_overview|get_repo_status|get_repo_branch_management_meta/,
    'hover-triggered reads must never enter the write-operation loading lifecycle'
  )
})

test('keeps overview and status as stable canonical snapshots plus read-through views', () => {
  const store = readSource('src/branchDomainStore.js')
  assert.match(store, /function createReadThroughProxy/)
  assert.match(store, /overviewPathByObject/)
  assert.match(store, /statusPathByObject/)
  assert.match(store, /function createOverviewProxy/)
  assert.match(store, /function createStatusProxy/)
  assert.match(store, /export function resolveBranchOverview/)
  assert.match(store, /export function getLatestBranchOverviewSnapshot/)
  assert.match(store, /export function getLatestBranchStatusSnapshot/)
  assert.match(store, /overviewFingerprintByPath/)
  assert.match(store, /statusFingerprintByPath/)
  assert.match(store, /export function subscribeBranchSnapshots/)
  assert.match(store, /export function subscribeBranchReadInvalidations/)
  assert.match(store, /export function getBranchSnapshotChangesSince/)
  assert.match(store, /token\.readGeneration !== getBranchReadGeneration\(token\.repoPath\)/)
  assert.match(store, /operationByPath\.has\(normalizedPath\)/)
})

test('integrates canonical snapshots directly in App source without build-time source rewriting', () => {
  const vite = readSource('vite.config.js')
  const app = readSource('src/App.jsx')
  const appBridge = readSource('src/branchSnapshotAppBridge.js')
  const main = readSource('src/main.jsx')

  assert.doesNotMatch(vite, /appBranchSnapshotBridgePlugin|viteAppBranchSnapshotBridgePlugin|transformAppForBranchSnapshotBridge/)
  assert.match(app, /import \{ useBranchSnapshotAppBridge \} from '\.\/branchSnapshotAppBridge\.js'/)
  assert.match(app, /import BranchManagementHoverAction from '\.\/BranchManagementHoverAction\.jsx'/)
  assert.match(app, /import RepoStashMenuItem from '\.\/RepoStashMenuItem\.jsx'/)
  assert.match(app, /useBranchSnapshotAppBridge\(\{[\s\S]*setRepoBranchOverviews,[\s\S]*setRepoStatuses,[\s\S]*setDismissedBranchAttentionKeys,/)
  assert.match(app, /const branchOverview = branchOverviewSnapshot \|\| null/)
  assert.doesNotMatch(app, /\bsetBranchOverview\b/)
  assert.match(app, /ariaLabel="仓库分支总览"[\s\S]*<BranchManagementHoverAction[\s\S]*branchOverviewLoading/)
  assert.equal((app.match(/<BranchManagementHoverAction/g) || []).length, 1)
  assert.equal((app.match(/<RepoStashMenuItem/g) || []).length, 1)
  assert.match(appBridge, /subscribeBranchSnapshots/)
  assert.match(appBridge, /getBranchSnapshotChangesSince/)
  assert.match(appBridge, /setRepoBranchOverviews/)
  assert.match(appBridge, /setRepoStatuses/)
  assert.match(appBridge, /setDismissedBranchAttentionKeys/)
  assert.doesNotMatch(main, /BranchCardProjectionLayer|useSyncExternalStore|subscribeBranchData/)
  assert.throws(() => readSource('src/viteAppBranchSnapshotBridgePlugin.js'))
})

test('keeps RepoCard branch overview state parent-owned', () => {
  const app = readSource('src/App.jsx')
  const cardStart = app.indexOf('function RepoCard(')
  const cardEnd = app.indexOf('const MemoizedRepoCard = memo(RepoCard)')
  const cardSource = app.slice(cardStart, cardEnd)

  assert.doesNotMatch(
    cardSource,
    /useState\(\(\) => branchOverviewSnapshot/
  )
  assert.match(
    cardSource,
    /const branchOverview = branchOverviewSnapshot \|\| null/
  )
  assert.match(
    cardSource,
    /onBranchOverviewChanged\?\.\(repo\.id, nextOverview, repo\.path\)/
  )
  assert.doesNotMatch(cardSource, /\bsetBranchOverview\b/)
})

test('clears branch snapshots and dismissals after successful repository removal', () => {
  const app = readSource('src/App.jsx')
  const removalStart = app.indexOf('  const handleConfirmRemove = async () => {')
  const undoStart = app.indexOf('  const handleUndoRemove = async () => {', removalStart)
  const removalSource = app.slice(removalStart, undoStart)

  assert.match(app, /clearBranchSnapshotsForPaths,[\s\S]*normalizeBranchRepoPath[\s\S]*from '\.\/branchDomainStore\.js'/)
  assert.match(removalSource, /const removedRepoPaths = reposToRemove[\s\S]*clearBranchSnapshotsForPaths\(removedRepoPaths\)/)
  assert.match(removalSource, /setRepoBranchOverviews\(\(prev\) => \{[\s\S]*removedSet/)
  assert.match(removalSource, /setDismissedBranchAttentionKeys\(\(prev\) => \{[\s\S]*removedSet/)

  const handlerStart = app.indexOf('const handleRepoBranchOverviewChanged = useCallback')
  const handlerEnd = app.indexOf('const handleDismissBranchAttention', handlerStart)
  const handlerSource = app.slice(handlerStart, handlerEnd)
  assert.match(handlerSource, /const currentRepo = reposRef\.current\.find/)
  assert.match(handlerSource, /if \(!currentRepo\) return/)
  assert.match(handlerSource, /useCallback\(\(repoId, overview, repoPath\) =>/)
  assert.match(handlerSource, /!normalizedCallbackPath/)
  assert.match(handlerSource, /normalizeBranchRepoPath\(currentRepo\.path\)/)
})

test('leaves the original React RepoCard as the sole reminder renderer', () => {
  const app = readSource('src/App.jsx')
  const main = readSource('src/main.jsx')
  const packageJson = readSource('package.json')

  assert.match(app, /function RepoCard\(/)
  assert.match(app, /className="repo-card__branch-attention"/)
  assert.match(app, /<Icons\.branch className="icon icon--xs" \/>/)
  assert.match(app, /className="repo-card__branch-attention-action"/)
  assert.doesNotMatch(main, /BranchCardProjectionLayer/)
  assert.doesNotMatch(packageJson, /branchCardProjectionLayer\.test/)
  assert.throws(() => readSource('src/BranchCardProjectionLayer.jsx'))
  assert.throws(() => readSource('src/BranchCardProjectionLayer.css'))
})

test('does not replay native focus transitions through the application root', () => {
  const main = readSource('src/main.jsx')
  const packageJson = readSource('package.json')
  assert.doesNotMatch(main, /nativeWindowFocusBridge|getCurrentWindow|onFocusChanged|installNativeWindowFocusBridge/)
  assert.doesNotMatch(packageJson, /nativeWindowFocusBridge\.test/)
})

test('resolves branch attention from the latest read-through overview on rerender', () => {
  const source = readSource('src/branchAttentionUtils.js')
  assert.match(source, /import \{ resolveBranchOverview \} from '\.\/branchDomainStore\.js'/)
  assert.match(source, /const effectiveOverview = resolveBranchOverview\(overview\)/)
  assert.doesNotMatch(source, /createLiveBranchAttention|getBranchOverviewRepoPath/)
})

test('keeps the interaction layer scoped to read-only repository-card operation presentation', () => {
  const source = readSource('src/BranchManagementInteractionLayer.jsx')

  assert.doesNotMatch(source, /@tauri-apps\/api\/core/)
  assert.doesNotMatch(source, /invoke\(|get_repo_branch_overview|get_repo_status|refresh_repo_git_metadata/)
  assert.doesNotMatch(source, /toggleBatchRow|branch-management-row--batch/)
  assert.doesNotMatch(source, /readBranchSurfaceSignature|watchOperationCompletion|applyLatestRepoSnapshot|setInterval|setTimeout/)
  assert.doesNotMatch(source, /classList\.(?:add|remove|toggle)|setAttribute|removeAttribute/)
  assert.doesNotMatch(source, /replaceChildren|appendChild|insertBefore|document\.createElement/)
  assert.doesNotMatch(source, /\.disabled\s*=|dataset\.[A-Za-z_$][\w$]*\s*=/)

  assert.match(source, /subscribeBranchOperations/)
  assert.match(source, /getBranchOperationRevision/)
  assert.match(source, /getActiveBranchOperationPaths/)
  assert.match(source, /createPortal/)
  assert.match(source, /collectBranchOperationOverlays/)
  assert.match(source, /const activePaths = getActiveBranchOperationPaths\(\)/)
  assert.match(source, /if \(activePaths\.size === 0\) \{[\s\S]*return undefined/)
  assert.match(source, /new MutationObserver\(scheduleUpdate\)/)
  assert.match(source, /attributeFilter: \['class'\]/)
  assert.match(source, /ResizeObserver/)
})
