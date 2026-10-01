import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, useSyncExternalStore, forwardRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { getBundleType, getVersion } from '@tauri-apps/api/app'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { relaunch } from '@tauri-apps/plugin-process'
import { load as loadStore } from '@tauri-apps/plugin-store'
import { check as checkForAppUpdate } from '@tauri-apps/plugin-updater'
import brandIcon from '../src-tauri/icons/icon.png'
import { createRefreshMachine } from './refreshStateMachine'
import { refreshRepoAfterBranchChangeWithGroupRetention } from './branchChangeRefresh'
import { formatReleaseVersion } from './releaseMetadata'
import {
  buildRefreshFailureNoticeMessage,
  buildSuccessfulSyncTimesByRepoId,
  compareReposByDashboardSortOrder,
  createRepoStatusIssue,
  DASHBOARD_REPO_FILTER_MODE,
  DASHBOARD_REPO_SORT_MODE,
  matchesDashboardRepoFilter,
  normalizeDashboardRepoFilterMode,
  getRepoStatusIssueDisplay,
  hasRepoStatusIssue,
  isRepoInFailedState,
  getRepoSyncSortTimestamp,
  normalizeDashboardRepoSortMode,
} from './repoStatusUtils'
import {
  getDashboardEmptyStateImage,
  getDashboardFilterEmptyState,
} from './dashboardEmptyStates.js'
import {
  DASHBOARD_EMPTY_PROJECTION_KIND,
  getDashboardEmptyProjection,
} from './dashboardEmptyProjection.js'
import { shouldCollapseSidebar } from './sidebarFitAuthority.js'
import {
  SIDEBAR_CARD_DOCK_FALLBACK_MS,
  resolveSidebarCardRect,
} from './sidebarCardAuthority.js'
import {
  SIDEBAR_PANEL_PREFERENCE,
  isSidebarCardDocking,
  isSidebarCardFloating,
  isSidebarCardOpen,
  readSidebarPanelPreference,
  resolveSidebarCardMode,
  resolveSidebarCardTransition,
  resolveSidebarPanelLayout,
  writeSidebarPanelPreference,
} from './sidebarCardState.js'
import {
  buildDashboardColumns,
  normalizeDashboardLayout,
} from './dashboardLayoutUtils.js'
import { parseGitCommitDateToMs, formatGitCommitLocalTime } from './gitDateUtils.js'
import { formatSyncTimePresentation } from './dashboardTimeUtils.js'
import {
  areAllVisibleReposSelected,
  getDashboardVisibleRepoIds,
  getHiddenSelectedRepoIds,
  getVisibleSelectedRepoIds,
  toggleVisibleRepoSelection,
} from './dashboardSelectionUtils.js'
import {
  readDashboardRepoFilter,
  readDashboardRepoSortMode,
  writeDashboardRepoFilter,
  writeDashboardRepoSortMode,
} from './dashboardPreferences.js'
import {
  buildRemoveReposOutcome,
  normalizeRepoIdsForRemoval,
} from './removeRepoUtils'
import {
  DASHBOARD_REFRESH_ACTION,
  FOCUS_REFRESH_REASON,
  getDashboardIntervalRefreshAction,
  getForegroundRefreshAction,
  getPendingFocusRefreshReasonsAfterBackgroundSyncCompletion,
  getPendingFocusRefreshReasonsAfterBackgroundSyncStart,
  getPendingFocusRefreshReasonsAfterHidden,
  getSyncCompletionRefreshAction,
  hasPendingFocusRefreshReasons,
} from './dashboardRefreshPolicy'
import {
  buildUndoRemovedRepos,
  createRepoRemovalSnapshot,
  getFailedRepoIds,
  removeMissingRepoStatesByIdSet,
  removeReposByIdSet,
  removeRepoStatusesByIdSet,
  rollbackMissingRepoStatesState,
  rollbackReposState,
  rollbackRepoStatusesState,
  rollbackSelectedRepoIdsState,
} from './repoRemoveState'
import { getExistingGithubRepoNameFallbackKeys } from './githubRepoVisibility'
import {
  getRepoCardFloatingLayout,
  getRepoCardFloatingHoverBridgeLayout,
  getRepoCardMoreMenuLayout,
  isRepoCardMoreMenuAnchorVisible,
  REPO_CARD_FLOATING_ALIGNMENT,
  REPO_CARD_MORE_MENU_PLACEMENT,
} from './repoCardMenuLayout'
import { normalizeBranchOverviewRow, shouldShowBranchOverviewRow } from './branchOverviewUtils'
import {
  createRepoMetaHoverController,
  REPO_META_HOVER_KEYS,
} from './repoMetaHoverController.js'
import { createRepoMetaHoverPointerTracker } from './repoMetaHoverPointerTracker.js'
import { buildBranchDeleteRequest, normalizeBranchDeleteTarget } from './branchManagementUtils'
import { readBranchForceDeleteDefault } from './branchForceDeleteSettings'
import {
  appendAppErrorLogEntries,
  loadAppErrorLog,
  APP_ERROR_LOG_SCHEMA_VERSION,
} from './appErrorLog'
import {
  APP_TOOLTIP_DELAY_MS,
  isTextVisuallyTruncated,
} from './appTooltip.js'
import { AppTooltipSurface } from './AppTooltip.jsx'
import IntervalControl from './IntervalControl.jsx'
import { INTERVAL_UNIT_OPTIONS } from './intervalUnits.js'
import {
  createDiagnosticBundlePayload,
  formatDiagnosticBundleForClipboard,
  isDiagnosticBundleEmpty,
} from './diagnosticBundle.js'
import {
  getBranchAttention,
  getBranchAttentionKey,
  parseDismissedBranchAttentionKeys,
} from './branchAttentionUtils'
import { CloneRepoDialog, ImportEntryMenu } from './importUi'
import { DeviceAuthDialog } from './DeviceAuthDialog.jsx'
import { GithubRepoBrowserDialog } from './GithubRepoBrowserDialog.jsx'
import { AppUpdateDialog } from './AppUpdateDialog.jsx'
import { createAppUpdaterController } from './appUpdater.js'
import { supportsUpdaterForBundle } from './appUpdaterBundleSupport.js'
import { COMMIT_DIFF_OPEN_EVENT, REPO_WORKING_CHANGES_CHANGED_EVENT } from './events'
import {
  clearBranchSnapshotsForPaths,
  getActiveBranchOperationPaths,
  normalizeBranchRepoPath,
} from './branchDomainStore.js'
import { getActiveStashOperationPaths } from './stashOperationClient.js'
import { useBranchSnapshotAppBridge } from './branchSnapshotAppBridge.js'
import BranchManagementHoverAction from './BranchManagementHoverAction.jsx'
import BranchSwitchIcon from './BranchSwitchIcon.jsx'
import CanonicalCheckbox from './CanonicalCheckbox.jsx'
import SharedCustomSelect from './CustomSelect.jsx'
import RepoStashMenuItem from './RepoStashMenuItem.jsx'
import OverlayPortal from './OverlayPortal.jsx'
import { OVERLAY_ID, OVERLAY_LEVEL } from './overlayLayerContract.js'
import { APP_ICONS as Icons } from './icons/appIconRegistry.js'
import './App.css'

const DEFAULT_APP_SETTINGS = {
  defaultSyncInterval: 30,
  backgroundFetchInterval: 10,
  defaultSyncMode: 'manual',
  defaultPullStrategy: 'rebase',
  maxSyncConcurrency: 2,
  notifications: true,
  autoOpenScriptLogDialog: true,
  postSyncScriptPullOnly: false,
  hideExistingGithubReposByDefault: false,
  defaultOpenApp: '',
  defaultTerminalApp: '',
  syncGuardPolicies: {
    localChanges: 'warn',
    missingRemote: 'block',
    conflictRisk: 'warn',
  },
}

const REPO_CARD_MIN_WIDTH = 360
const REPO_GRID_GAP = 16
const DASHBOARD_LAYOUT_KEY = 'gitsync-dashboard-layout'
const DASHBOARD_GROUP_COLLAPSE_ANIMATION_MS = 280
const BRANCH_ATTENTION_DISMISSALS_STORAGE_KEY = 'gitsync-branch-attention-dismissals'
const DASHBOARD_REPO_FILTER_OPTIONS = [
  { value: DASHBOARD_REPO_FILTER_MODE.all, label: '全部仓库' },
  { value: DASHBOARD_REPO_FILTER_MODE.synced, label: '已同步' },
  {
    value: DASHBOARD_REPO_FILTER_MODE.newChanges,
    label: '有新改动',
    description: '待拉取、待推送或正在同步',
  },
  {
    value: DASHBOARD_REPO_FILTER_MODE.localChanges,
    label: '本地有未提交改动',
    description: '工作区或暂存区存在未提交内容',
  },
  {
    value: DASHBOARD_REPO_FILTER_MODE.newAndLocalChanges,
    // Persisted value / constant keep the legacy `newAndLocalChanges` name, but the shipped
    // semantics are a union (remote new changes OR local uncommitted changes OR both), so
    // the label must not read like an intersection. See ARCHITECTURE.md.
    label: '同步或本地有改动',
    description: '待拉取、待推送，或本地有未提交内容',
  },
]
const DASHBOARD_REPO_SORT_OPTIONS = [
  { value: DASHBOARD_REPO_SORT_MODE.nameAsc, label: '名称升序', description: 'A → Z' },
  { value: DASHBOARD_REPO_SORT_MODE.nameDesc, label: '名称降序', description: 'Z → A' },
  { value: DASHBOARD_REPO_SORT_MODE.commitAsc, label: '提交时间升序', description: '旧 → 新' },
  { value: DASHBOARD_REPO_SORT_MODE.commitDesc, label: '提交时间降序', description: '新 → 旧' },
  { value: DASHBOARD_REPO_SORT_MODE.syncAsc, label: '同步时间升序', description: '旧 → 新' },
  { value: DASHBOARD_REPO_SORT_MODE.syncDesc, label: '同步时间降序', description: '新 → 旧' },
]

const MIN_SYNC_INTERVAL_SECONDS = 5
const MAX_SYNC_INTERVAL_SECONDS = 24 * 60 * 60
const INTERVAL_UNITS = INTERVAL_UNIT_OPTIONS
const MIN_SYNC_CONCURRENCY = 1
const MAX_SYNC_CONCURRENCY = 10
const DEFAULT_SYNC_CONCURRENCY = 2
const MAX_FINISHED_SYNC_JOBS = 40
const SYNC_HISTORY_STORAGE_KEY = 'gitsync-sync-history'
const SYNC_DIAGNOSTIC_STORAGE_KEY = 'gitsync-sync-diagnostics'
const SYNC_DIAGNOSTIC_SCHEMA_VERSION = 1
const MAX_SYNC_DIAGNOSTIC_EVENTS = 1000
const COMMIT_HISTORY_STORE_FILE = 'commit-history-cache.json'
const COMMIT_HISTORY_STORE_KEY = 'commitHistoryCache'
const COMMIT_HISTORY_CACHE_VERSION = 1
const COMMIT_HISTORY_DEFAULT_COUNT = 30
const COMMIT_HISTORY_COUNT_OPTIONS = [30, 100]
const COMMIT_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000
const COMMIT_HISTORY_MAX_CACHE_ENTRIES = 80
const COMMIT_HISTORY_STORE_SAVE_DEBOUNCE_MS = 350
const COMMIT_HISTORY_LOADING_MIN_MS = 360
const COMMIT_HISTORY_DRAWER_EXIT_MS = 820
const COMMIT_HISTORY_DRAWER_EXIT_FALLBACK_MS = COMMIT_HISTORY_DRAWER_EXIT_MS + 180
const COMMIT_HISTORY_HANDOFF_REVEAL_MS = 180
const COMMIT_HISTORY_FLIGHT_PHASE = {
  closed: 'closed',
  preparingOpen: 'preparing-open',
  opening: 'opening',
  open: 'open',
  preparingClose: 'preparing-close',
  closing: 'closing',
  handoff: 'handoff',
  aborting: 'aborting',
}
const COMMIT_HISTORY_GEOMETRY_TOLERANCE_PX = 1
const CLONE_PARENT_PATH_STORAGE_KEY = 'gitsync-clone-parent-path'
const MAX_SYNC_HISTORY_ENTRIES = 300
const REPO_LIST_REFRESH_INTERVAL_MS = 10000
const BRANCH_OVERVIEW_CACHE_TTL_MS = 30000

const noop = () => {}
const BATCH_IMPORT_CONCURRENCY = 4
const SYNC_FAILED_HOVER_REVEAL_MS = 2000
const SYNC_FAILED_HOVER_HIDE_MS = 500
const SYNC_VISUAL_PHASE = {
  idle: 'idle',
  entering: 'entering',
  active: 'active',
  leaving: 'leaving',
}
const BRANCH_SWITCH_PHASE = {
  idle: 'idle',
  switching: 'switching',
  deleting: 'deleting',
  refreshing: 'refreshing',
}
const META_HOVER_VIEWPORT_PADDING = 24
const META_HOVER_OPEN_DELAY_MS = 600
const META_HOVER_CLOSE_DELAY_MS = 180
const SYNC_VISUAL_DELAY_MS = {
  enterToActive: 320,
  leaveToIdle: 420,
}
const REPO_STATUS_LABELS = {
  idle: '已同步',
  syncing: '同步中...',
  conflict: '存在冲突',
  error: '同步错误',
  paused: '已暂停',
}
const SYNC_JOB_STATUS = {
  queued: 'queued',
  running: 'running',
  success: 'success',
  failed: 'failed',
  canceled: 'canceled',
}
const SYNC_BUTTON_MODE = {
  idle: 'idle',
  queued: 'queued',
  syncing: 'syncing',
}
const SYNC_MODE_LABELS = {
  auto: '自动',
  manual: '手动',
}
const SYNC_CANCEL_MESSAGE_PRESETS = {
  manual: {
    queuedMessage: '任务已取消',
    runningMessage: '取消请求已提交，当前步骤结束后停止',
  },
  paused: {
    queuedMessage: '仓库已暂停，任务取消',
    runningMessage: '仓库已暂停，等待当前步骤结束',
  },
}
const RETRY_SYNC_NOTICE_TITLE = '重试任务'
const UNDO_REMOVE_TIMEOUT_MS = 10000
const MISSING_REPO_DEFAULT_MESSAGE = '仓库目录不存在，可能已被删除或移动。'
const MISSING_REPO_SYNC_GUARD_RULE = 'missingRepoPath'
const SYNC_GUARD_POLICY = {
  block: 'block',
  warn: 'warn',
}
const SYNC_GUARD_SOURCE_LABELS = {
  manual: '手动同步',
  retry: '重试同步',
  batch: '批量同步',
  syncAll: '全部同步',
  syncChanged: '按改动同步',
  syncFiltered: '当前筛选同步',
  groupChanged: '分组同步（有新改动）',
  groupClean: '分组同步（已同步）',
  auto: '自动同步',
}
const SYNC_GUARD_RULE_CONFIG = {
  localChanges: {
    label: '本地未提交改动',
    helpText: '检测工作区未提交文件，避免同步时覆盖或打断你的本地修改。',
  },
  missingRemote: {
    label: '未配置远端',
    helpText: '检测 origin 远端是否可用，避免 pull/push 直接失败。',
  },
  conflictRisk: {
    label: '冲突风险',
    helpText: '检测未解决冲突或分叉分支（ahead+behind），提前预警冲突可能性。',
  },
}
const SYNC_HISTORY_RESULT_LABELS = {
  success: '成功',
  failed: '失败',
  canceled: '已取消',
}
const SYNC_HISTORY_SOURCE_LABELS = {
  manual: '手动',
  auto: '自动',
  syncAll: '全部同步',
  syncChanged: '按改动同步',
  syncFiltered: '当前筛选',
  groupChanged: '分组-有改动',
  groupClean: '分组-已同步',
  batch: '批量',
  retry: '重试',
  syncFailed: '失败仓库',
}
const SYNC_HISTORY_RESULT_FILTER_OPTIONS = [
  { value: 'all', label: '全部结果' },
  { value: SYNC_JOB_STATUS.success, label: '成功' },
  { value: SYNC_JOB_STATUS.failed, label: '失败' },
  { value: SYNC_JOB_STATUS.canceled, label: '取消' },
]
const SYNC_HISTORY_SOURCE_FILTER_OPTIONS = [
  { value: 'all', label: '全部来源' },
  ...Object.entries(SYNC_HISTORY_SOURCE_LABELS).map(([value, label]) => ({ value, label })),
]
const REPO_CARD_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, label, [role="button"]'
const BUILD_SCRIPT_EXTENSIONS = ['sh', 'command', 'bat', 'cmd', 'ps1']
const NON_WINDOWS_BUILD_SCRIPT_EXTENSIONS = ['sh', 'command']
const POST_SYNC_BUILD_STATE = {
  idle: 'idle',
  running: 'running',
  success: 'success',
  failed: 'failed',
}
const POST_SYNC_BUILD_SUCCESS_BADGE_DURATION_MS = 5000
const SCRIPT_LOG_STATUS = {
  running: 'running',
  success: 'success',
  failed: 'failed',
}
const SCRIPT_LOG_STATUS_TEXT_MAP = {
  [SCRIPT_LOG_STATUS.running]: '执行中',
  [SCRIPT_LOG_STATUS.success]: '执行成功',
  [SCRIPT_LOG_STATUS.failed]: '执行失败',
}
const MAX_SCRIPT_LOG_SESSIONS = 30
const LOCAL_ONLY_SETTING_KEYS = new Set([
  'notifications',
  'autoOpenScriptLogDialog',
  'backgroundFetchInterval',
  'postSyncScriptPullOnly',
  'hideExistingGithubReposByDefault',
  'defaultOpenApp',
  'defaultTerminalApp',
  'maxSyncConcurrency',
  'syncGuardPolicies',
])
const FETCH_REPOS_MODE = {
  light: 'light',
  full: 'full',
}
const EMPTY_REPO_ID_SET = new Set()

function normalizeRepoIdSet(repoIdSet) {
  return repoIdSet instanceof Set ? repoIdSet : EMPTY_REPO_ID_SET
}

function normalizeFetchReposMode(mode) {
  return mode === FETCH_REPOS_MODE.full ? FETCH_REPOS_MODE.full : FETCH_REPOS_MODE.light
}

function mergeFetchReposMode(currentMode, incomingMode) {
  const normalizedCurrent = normalizeFetchReposMode(currentMode)
  const normalizedIncoming = normalizeFetchReposMode(incomingMode)
  return normalizedCurrent === FETCH_REPOS_MODE.full || normalizedIncoming === FETCH_REPOS_MODE.full
    ? FETCH_REPOS_MODE.full
    : FETCH_REPOS_MODE.light
}

function normalizeIntervalSeconds(value, fallbackSeconds = 30) {
  const parsed = parseInt(String(value), 10)
  const fallbackParsed = parseInt(String(fallbackSeconds), 10)
  const safeFallback = Number.isNaN(fallbackParsed) ? MIN_SYNC_INTERVAL_SECONDS : fallbackParsed
  const baseValue = Number.isNaN(parsed) ? safeFallback : parsed
  return Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.min(MAX_SYNC_INTERVAL_SECONDS, baseValue))
}

function normalizeIntervalAmountByUnit(value, unit, secondsValue, fallbackSeconds = 30) {
  const parsed = parseInt(String(value), 10)
  const unitConfig = INTERVAL_UNITS[unit] || INTERVAL_UNITS.seconds
  const minAmount = Math.ceil(MIN_SYNC_INTERVAL_SECONDS / unitConfig.factor)
  const maxAmount = Math.floor(MAX_SYNC_INTERVAL_SECONDS / unitConfig.factor)
  const safeSeconds = normalizeIntervalSeconds(secondsValue, fallbackSeconds)
  const fallbackAmount = Math.max(minAmount, Math.min(maxAmount, Math.round(safeSeconds / unitConfig.factor)))
  const amount = Number.isNaN(parsed) ? fallbackAmount : Math.max(minAmount, Math.min(maxAmount, parsed))
  return { amount, seconds: amount * unitConfig.factor }
}

function toIntervalUnitDraft(secondsValue, fallbackSeconds = 30) {
  const safeSeconds = normalizeIntervalSeconds(secondsValue, fallbackSeconds)
  if (safeSeconds % INTERVAL_UNITS.hours.factor === 0) {
    return { unit: 'hours', amount: safeSeconds / INTERVAL_UNITS.hours.factor }
  }
  if (safeSeconds % INTERVAL_UNITS.minutes.factor === 0) {
    return { unit: 'minutes', amount: safeSeconds / INTERVAL_UNITS.minutes.factor }
  }
  return { unit: 'seconds', amount: safeSeconds }
}

function normalizeSyncConcurrency(value) {
  const parsed = parseInt(String(value), 10)
  if (Number.isNaN(parsed)) return DEFAULT_SYNC_CONCURRENCY
  return Math.max(MIN_SYNC_CONCURRENCY, Math.min(MAX_SYNC_CONCURRENCY, parsed))
}

function isLocalOnlySettingKey(key) {
  return LOCAL_ONLY_SETTING_KEYS.has(key)
}

function normalizeSyncGuardPolicy(value) {
  return value === SYNC_GUARD_POLICY.block ? SYNC_GUARD_POLICY.block : SYNC_GUARD_POLICY.warn
}

function normalizeSyncGuardPolicies(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    localChanges: normalizeSyncGuardPolicy(input.localChanges),
    missingRemote: normalizeSyncGuardPolicy(input.missingRemote),
    conflictRisk: normalizeSyncGuardPolicy(input.conflictRisk),
  }
}

function trimSyncHistoryEntries(entries) {
  return entries.slice(-MAX_SYNC_HISTORY_ENTRIES)
}

function readLocalStorageItem(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocalStorageItem(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore storage write failures and keep the app usable.
  }
}

function createSyncDiagnosticRequestId() {
  return `sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function trimSyncDiagnosticEvents(events) {
  return events.slice(-MAX_SYNC_DIAGNOSTIC_EVENTS)
}

function normalizeSyncDiagnosticEvent(event) {
  const timestamp = Number(event?.timestamp) || Date.now()
  const normalized = {
    schemaVersion: SYNC_DIAGNOSTIC_SCHEMA_VERSION,
    id: `syncdiag_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    requestId: String(event?.requestId || '').slice(0, 80),
    jobId: String(event?.jobId || '').slice(0, 80),
    repoId: String(event?.repoId || '').slice(0, 120),
    repoName: String(event?.repoName || '').slice(0, 160),
    source: String(event?.source || 'unknown').slice(0, 40),
    trigger: String(event?.trigger || '').slice(0, 60),
    phase: String(event?.phase || 'unknown').slice(0, 60),
    outcome: String(event?.outcome || '').slice(0, 40),
  }

  if (Number.isFinite(event?.attempt)) normalized.attempt = event.attempt
  if (event?.syncBehavior) normalized.syncBehavior = String(event.syncBehavior).slice(0, 40)
  if (Number.isFinite(event?.guardIssueCount)) normalized.guardIssueCount = event.guardIssueCount
  if (typeof event?.didPull === 'boolean') normalized.didPull = event.didPull
  if (typeof event?.didPush === 'boolean') normalized.didPush = event.didPush
  if (typeof event?.conflict === 'boolean') normalized.conflict = event.conflict
  if (typeof event?.responseReceived === 'boolean') normalized.responseReceived = event.responseReceived
  return normalized
}

function loadSyncDiagnosticEvents() {
  try {
    const raw = readLocalStorageItem(SYNC_DIAGNOSTIC_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return trimSyncDiagnosticEvents(parsed.filter((item) => item && typeof item === 'object'))
  } catch {
    return []
  }
}

function appendSyncDiagnosticEvents(events) {
  const nextEvents = Array.isArray(events)
    ? events.filter((event) => event && typeof event === 'object').map(normalizeSyncDiagnosticEvent)
    : []
  if (nextEvents.length === 0) return
  const entries = trimSyncDiagnosticEvents([
    ...loadSyncDiagnosticEvents(),
    ...nextEvents,
  ])
  writeLocalStorageItem(SYNC_DIAGNOSTIC_STORAGE_KEY, JSON.stringify(entries))
}

function loadSyncHistoryEntries() {
  try {
    const raw = readLocalStorageItem(SYNC_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return trimSyncHistoryEntries(parsed.filter((item) => item && typeof item === 'object'))
  } catch {
    return []
  }
}

function createEmptyCommitHistoryCache() {
  return {
    version: COMMIT_HISTORY_CACHE_VERSION,
    entries: {},
  }
}

function normalizeCommitHistoryCount(value) {
  const parsed = Number.parseInt(String(value), 10)
  return COMMIT_HISTORY_COUNT_OPTIONS.includes(parsed) ? parsed : COMMIT_HISTORY_DEFAULT_COUNT
}

function hashCachePath(value) {
  const text = String(value || '')
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function buildCommitHistoryCacheKey(repo, branch, count) {
  const repoId = String(repo?.id || '').trim()
  if (!repoId) return ''
  const pathHash = hashCachePath(repo?.path || '')
  const branchName = String(branch || repo?.branch || 'main').trim() || 'main'
  const safeCount = normalizeCommitHistoryCount(count)
  return `${repoId}:${pathHash}:${branchName}:${safeCount}`
}

function getRepoCardScreenRect(repoId) {
  if (typeof document === 'undefined') return null
  const normalizedRepoId = String(repoId || '').trim()
  if (!normalizedRepoId) return null

  const nodes = Array.from(document.querySelectorAll('[data-repo-card-id]'))
  const node = nodes.find((item) => (
    item?.dataset?.repoCardId === normalizedRepoId
      && !item.closest('.commit-history-stage')
  ))
  if (!node) return null

  const rect = node.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

function getMainContentTranslateX() {
  if (typeof document === 'undefined') return 0
  const mainContent = document.querySelector('.main-content')
  if (!mainContent) return 0

  const transform = getComputedStyle(mainContent).transform
  if (!transform || transform === 'none') return 0

  try {
    if (typeof DOMMatrixReadOnly !== 'undefined') {
      return new DOMMatrixReadOnly(transform).m41 || 0
    }
    const values = transform.match(/^matrix(?:3d)?\(([^)]+)\)$/)?.[1]
      ?.split(',')
      .map((value) => Number.parseFloat(value.trim()))
    if (transform.startsWith('matrix3d(')) return Number.isFinite(values?.[12]) ? values[12] : 0
    return Number.isFinite(values?.[4]) ? values[4] : 0
  } catch (_) {
    return 0
  }
}

function getRepoCardProjectedRestingRect(repoId) {
  const rect = getRepoCardScreenRect(repoId)
  if (!rect) return null

  const mainTranslateX = getMainContentTranslateX()
  return {
    ...rect,
    left: rect.left - mainTranslateX,
  }
}

function areCommitHistoryFlightEndpointsAligned(
  firstRect,
  secondRect,
  tolerance = COMMIT_HISTORY_GEOMETRY_TOLERANCE_PX
) {
  if (!firstRect || !secondRect) return false
  return ['left', 'top', 'width'].every((key) => (
    Math.abs(Number(firstRect[key]) - Number(secondRect[key])) <= tolerance
  ))
}

function normalizeCommitHistoryBranchName(value) {
  return String(value || '').trim()
}

function getCommitHistoryDefaultBranch(repo, status) {
  return normalizeCommitHistoryBranchName(status?.branch || repo?.branch || 'main') || 'main'
}

function getCommitHistoryBranchOptionRef(branchItem) {
  if (!branchItem || typeof branchItem !== 'object') return ''
  const name = normalizeCommitHistoryBranchName(branchItem.name)
  const upstream = normalizeCommitHistoryBranchName(branchItem.upstream)
  if (branchItem.is_remote_only && upstream) return upstream
  return name || upstream
}

function buildCommitHistoryBranchOptions(overview, currentBranch, selectedBranch) {
  const options = []
  const seenRefs = new Set()
  const optionByRef = new Map()
  const fallbackBranch = normalizeCommitHistoryBranchName(currentBranch) || 'main'
  const branches = Array.isArray(overview?.branches) ? overview.branches : []
  const remoteHeadHashByRef = new Map()

  branches.forEach((branchItem) => {
    const identity = String(branchItem?.identity || '').trim()
    const ref = getCommitHistoryBranchOptionRef(branchItem)
    const headHash = String(branchItem?.head_hash || '').trim()
    if (identity.startsWith('remote:') && ref && headHash) {
      remoteHeadHashByRef.set(ref, headHash)
    }
  })

  const addOption = (option) => {
    const ref = normalizeCommitHistoryBranchName(option.ref)
    if (!ref) return
    const existing = optionByRef.get(ref)
    if (existing) {
      if (!existing.headHash && option.headHash) existing.headHash = option.headHash
      if (!existing.remoteHeadHash && option.remoteHeadHash) existing.remoteHeadHash = option.remoteHeadHash
      if (!existing.upstream && option.upstream) existing.upstream = option.upstream
      existing.isCurrent = existing.isCurrent || Boolean(option.isCurrent)
      existing.isRemoteOnly = existing.isRemoteOnly || Boolean(option.isRemoteOnly)
      return
    }
    seenRefs.add(ref)
    const nextOption = {
      value: ref,
      label: option.label || ref,
      displayName: option.displayName || ref,
      isCurrent: Boolean(option.isCurrent),
      isRemoteOnly: Boolean(option.isRemoteOnly),
      upstream: option.upstream || '',
      headHash: option.headHash || '',
      remoteHeadHash: option.remoteHeadHash || '',
    }
    options.push(nextOption)
    optionByRef.set(ref, nextOption)
  }

  addOption({
    ref: fallbackBranch,
    label: `${fallbackBranch} · 当前`,
    displayName: fallbackBranch,
    isCurrent: true,
  })

  branches.forEach((branchItem) => {
    const ref = getCommitHistoryBranchOptionRef(branchItem)
    const displayName = normalizeCommitHistoryBranchName(branchItem?.name) || ref
    if (!ref) return
    const upstream = normalizeCommitHistoryBranchName(branchItem?.upstream)
    const headHash = String(branchItem?.head_hash || '').trim()

    const tags = []
    if (branchItem?.is_current) tags.push('当前')
    if (branchItem?.is_remote_only) tags.push('远端')
    addOption({
      ref,
      label: tags.length > 0 ? `${displayName} · ${tags.join('/')}` : displayName,
      displayName,
      isCurrent: Boolean(branchItem?.is_current),
      isRemoteOnly: Boolean(branchItem?.is_remote_only),
      upstream,
      headHash,
      remoteHeadHash: upstream ? remoteHeadHashByRef.get(upstream) || '' : '',
    })
  })

  const normalizedSelectedBranch = normalizeCommitHistoryBranchName(selectedBranch)
  if (normalizedSelectedBranch && !seenRefs.has(normalizedSelectedBranch)) {
    addOption({
      ref: normalizedSelectedBranch,
      label: `${normalizedSelectedBranch} · 自定义`,
      displayName: normalizedSelectedBranch,
    })
  }

  return options
}

function getCommitHistoryBranchDisplayName(options, branchRef) {
  const normalizedRef = normalizeCommitHistoryBranchName(branchRef)
  const option = (Array.isArray(options) ? options : [])
    .find((item) => item.value === normalizedRef)
  return option?.displayName || normalizedRef || 'main'
}

function getCommitHistoryBranchOption(options, branchRef) {
  const normalizedRef = normalizeCommitHistoryBranchName(branchRef)
  return (Array.isArray(options) ? options : [])
    .find((item) => item.value === normalizedRef) || null
}

function normalizeCommitHistoryCommit(commit, options = {}) {
  if (!commit || typeof commit !== 'object') return null
  const opts = options && typeof options === 'object' ? options : {}
  const hash = String(commit.hash || '').trim()
  const message = String(commit.message || '').trim()
  const date = String(commit.date || '').trim()
  const author = String(commit.author || '').trim()
  const source = opts.source === 'remote' ? 'remote' : 'local'
  const branch = normalizeCommitHistoryBranchName(opts.branch)
  if (!hash && !message && !date && !author) return null
  return {
    hash,
    message: message || '暂无提交信息',
    date,
    author,
    source,
    branch,
  }
}

function normalizeCommitHistoryCache(value) {
  const input = value && typeof value === 'object' ? value : {}
  const output = createEmptyCommitHistoryCache()
  const entries = input.entries && typeof input.entries === 'object' ? input.entries : {}

  Object.entries(entries).forEach(([key, entry]) => {
    if (!key || !entry || typeof entry !== 'object') return
    const commits = Array.isArray(entry.commits)
      ? entry.commits.map(normalizeCommitHistoryCommit).filter(Boolean)
      : []
    const remoteBranch = normalizeCommitHistoryBranchName(entry.remoteBranch)
    const remoteCommits = Array.isArray(entry.remoteCommits)
      ? entry.remoteCommits
        .map((commit) => normalizeCommitHistoryCommit(commit, { source: 'remote', branch: remoteBranch }))
        .filter(Boolean)
      : []
    output.entries[key] = {
      repoId: String(entry.repoId || '').trim(),
      repoPath: String(entry.repoPath || '').trim(),
      branch: String(entry.branch || '').trim() || 'main',
      remoteBranch,
      count: normalizeCommitHistoryCount(entry.count),
      headHash: String(entry.headHash || '').trim(),
      remoteHeadHash: String(entry.remoteHeadHash || '').trim(),
      fetchedAt: Number(entry.fetchedAt) || 0,
      commits,
      remoteCommits,
    }
  })

  return pruneCommitHistoryCache(output)
}

function pruneCommitHistoryCache(cache) {
  const normalized = cache && typeof cache === 'object' ? cache : createEmptyCommitHistoryCache()
  const entries = normalized.entries && typeof normalized.entries === 'object' ? normalized.entries : {}
  const sortedEntries = Object.entries(entries)
    .filter(([, entry]) => entry && typeof entry === 'object')
    .sort((a, b) => (Number(b[1].fetchedAt) || 0) - (Number(a[1].fetchedAt) || 0))
    .slice(0, COMMIT_HISTORY_MAX_CACHE_ENTRIES)

  return {
    version: COMMIT_HISTORY_CACHE_VERSION,
    entries: Object.fromEntries(sortedEntries),
  }
}

function removeCommitHistoryCacheForRepo(cache, repoIds) {
  const repoIdSet = new Set(Array.isArray(repoIds) ? repoIds.filter(Boolean) : [repoIds].filter(Boolean))
  if (repoIdSet.size === 0) return cache
  const current = normalizeCommitHistoryCache(cache)
  const nextEntries = {}
  Object.entries(current.entries).forEach(([key, entry]) => {
    if (!repoIdSet.has(entry.repoId)) nextEntries[key] = entry
  })
  return {
    ...current,
    entries: nextEntries,
  }
}

function upsertCommitHistoryCacheEntry(cache, cacheKey, entry) {
  if (!cacheKey) return normalizeCommitHistoryCache(cache)
  return pruneCommitHistoryCache({
    version: COMMIT_HISTORY_CACHE_VERSION,
    entries: {
      ...(cache?.entries || {}),
      [cacheKey]: entry,
    },
  })
}

function formatCommitHistoryCacheAge(fetchedAt) {
  const timestamp = Number(fetchedAt) || 0
  if (!timestamp) return '尚未缓存'
  const diffMs = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return '刚刚缓存'
  if (minutes < 60) return `缓存于 ${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `缓存于 ${hours} 小时前`
  return `缓存于 ${Math.floor(hours / 24)} 天前`
}

function areCommitHistoryHashesEqual(left, right) {
  const leftHash = String(left || '').trim()
  const rightHash = String(right || '').trim()
  if (!leftHash || !rightHash) return false
  return leftHash === rightHash || leftHash.startsWith(rightHash) || rightHash.startsWith(leftHash)
}

function isCommitHistoryCacheCurrent(entry, headHash, remoteHeadHash = '') {
  if (!entry) return false
  const normalizedHeadHash = String(headHash || '').trim()
  const normalizedRemoteHeadHash = String(remoteHeadHash || '').trim()
  if (!normalizedHeadHash) return Date.now() - (Number(entry.fetchedAt) || 0) < COMMIT_HISTORY_CACHE_TTL_MS
  if (!areCommitHistoryHashesEqual(entry.headHash, normalizedHeadHash)) return false
  if (!normalizedRemoteHeadHash) return true
  return areCommitHistoryHashesEqual(entry.remoteHeadHash, normalizedRemoteHeadHash)
}

function shouldRefreshCommitHistoryCache(entry, headHash, remoteHeadHash = '') {
  if (!entry) return true
  if (!isCommitHistoryCacheCurrent(entry, headHash, remoteHeadHash)) return true
  return Date.now() - (Number(entry.fetchedAt) || 0) > COMMIT_HISTORY_CACHE_TTL_MS
}

function getCommitHistoryDateGroupLabel(dateStr) {
  const ts = parseGitCommitDateToMs(dateStr)
  if (!ts) return '时间未知'
  const date = new Date(ts)
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays = Math.round((startOfToday - startOfDate) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}/${m}/${d}`
}

function groupCommitHistoryCommits(commits) {
  const groups = []
  const groupByLabel = new Map()
  ;(Array.isArray(commits) ? commits : []).forEach((commit) => {
    const label = getCommitHistoryDateGroupLabel(commit.date)
    if (!groupByLabel.has(label)) {
      const group = { label, commits: [] }
      groupByLabel.set(label, group)
      groups.push(group)
    }
    groupByLabel.get(label).commits.push(commit)
  })
  return groups
}

function isSyncJobActive(job) {
  return job.status === SYNC_JOB_STATUS.queued || job.status === SYNC_JOB_STATUS.running
}

function isSyncJobRetryable(job) {
  return job.status === SYNC_JOB_STATUS.failed || job.status === SYNC_JOB_STATUS.canceled
}

function getSyncJobOrderTime(job) {
  return job.finishedAt || job.startedAt || job.createdAt || 0
}

function getActiveSyncRepoIds(jobs) {
  return new Set(jobs.filter(isSyncJobActive).map((job) => job.repoId))
}

function getCurrentActiveSyncRepoIds(jobs, syncingRepoIds) {
  const activeRepoIds = getActiveSyncRepoIds(Array.isArray(jobs) ? jobs : [])
  if (syncingRepoIds instanceof Set) {
    syncingRepoIds.forEach((repoId) => {
      if (repoId) activeRepoIds.add(repoId)
    })
  }
  return activeRepoIds
}

function setPendingFocusRefreshReasons(ref, reasons) {
  ref.current = new Set(Array.isArray(reasons) ? reasons.filter(Boolean) : [])
}

function addPendingFocusRefreshReason(ref, reason) {
  if (!reason) return
  const current = ref.current instanceof Set ? ref.current : new Set()
  current.add(reason)
  ref.current = current
}

function getRepoSyncDisplayState(repoStatus, queueState) {
  const isSyncing = repoStatus === 'syncing' || queueState === SYNC_JOB_STATUS.running
  const isQueued = queueState === SYNC_JOB_STATUS.queued

  let statusDotType = repoStatus
  if (isSyncing) statusDotType = 'syncing'
  if (isQueued) statusDotType = 'queued'

  let statusLabel = REPO_STATUS_LABELS[repoStatus] || repoStatus
  if (isSyncing) statusLabel = REPO_STATUS_LABELS.syncing
  if (isQueued) statusLabel = '排队中'

  return {
    isSyncing,
    isQueued,
    isActiveSyncTask: isSyncing || isQueued,
    statusDotType,
    statusLabel,
  }
}

function getRepoDashboardSearchName(repo) {
  return String(repo?.name || '')
    .trim()
    .toLowerCase()
}

function getSyncButtonMode(isSyncing, isQueued) {
  if (isSyncing) return SYNC_BUTTON_MODE.syncing
  if (isQueued) return SYNC_BUTTON_MODE.queued
  return SYNC_BUTTON_MODE.idle
}

function getSyncButtonClassName(mode) {
  const classes = ['action-btn', 'action-btn--sync']
  if (mode === SYNC_BUTTON_MODE.queued || mode === SYNC_BUTTON_MODE.syncing) classes.push('action-btn--cancel')
  if (mode === SYNC_BUTTON_MODE.syncing) classes.push('action-btn--syncing')
  return classes.join(' ')
}

function getLatestRetryableJobsByRepo(jobs) {
  return jobs.reduce((acc, job) => {
    if (!isSyncJobRetryable(job)) return acc
    const previous = acc[job.repoId]
    if (!previous || getSyncJobOrderTime(job) >= getSyncJobOrderTime(previous)) {
      acc[job.repoId] = job
    }
    return acc
  }, {})
}

function mapSyncJobById(jobs, jobId, updater) {
  return jobs.map((job) => (job.id === jobId ? updater(job) : job))
}

function getRepoSyncTimerSignature(repos) {
  return repos
    .map((repo) => `${repo.id}:${repo.sync_mode}:${repo.auto_sync}:${repo.status}:${repo.sync_interval}`)
    .join(',')
}

function isRepoAutoSyncEnabled(repo) {
  if (!repo || typeof repo !== 'object') return false
  return repo.sync_mode === 'auto' && repo.auto_sync === true && repo.status !== 'paused'
}

function shouldPollRepoRemote(repo) {
  if (!repo || typeof repo !== 'object') return false
  if (repo.status === 'paused') return false
  return !isRepoAutoSyncEnabled(repo)
}

function getReposForRemoteRefresh(repoList, manualOnly, missingRepoIdSet = null) {
  if (!Array.isArray(repoList)) return []
  return repoList.filter((repo) => {
    if (typeof repo?.path !== 'string' || !repo.path.trim()) return false
    if (missingRepoIdSet && missingRepoIdSet.has(repo.id)) return false
    return manualOnly ? shouldPollRepoRemote(repo) : repo.status !== 'paused'
  })
}

function createSyncJob(
  repoId,
  source = 'manual',
  attempt = 1,
  syncBehavior = 'default',
  requestId = '',
  trigger = ''
) {
  const normalizedSyncBehavior = syncBehavior === 'changesOnly' ? 'changesOnly' : 'default'
  return {
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    requestId: String(requestId || '').trim() || createSyncDiagnosticRequestId(),
    repoId,
    source,
    trigger,
    attempt,
    syncBehavior: normalizedSyncBehavior,
    status: SYNC_JOB_STATUS.queued,
    cancelRequested: false,
    message: '',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  }
}

function getSyncDiagnosticRepoName(repoList, repoId) {
  const repo = (Array.isArray(repoList) ? repoList : []).find((item) => item?.id === repoId)
  return repo?.name || repoId || 'unknown-repo'
}

function createSyncHistoryEntry(payload) {
  return {
    id: `history_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    ...payload,
  }
}

function createScriptLogSession(payload) {
  const source = payload?.source === 'manual' ? 'manual' : 'auto'
  const scriptPath = String(payload?.scriptPath || '').trim()
  return {
    id: `scriptlog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    repoId: payload?.repoId || '',
    repoName: payload?.repoName || payload?.repoId || '未知仓库',
    source,
    status: SCRIPT_LOG_STATUS.running,
    scriptPath,
    command: scriptPath,
    message: '脚本执行中...',
    output: '',
    startedAt: Date.now(),
    finishedAt: null,
  }
}

function createPendingScriptLogSession(sessionId, repoId) {
  const normalizedRepoId = String(repoId || '').trim()
  return {
    ...createScriptLogSession({
      repoId: normalizedRepoId,
      repoName: normalizedRepoId || '未知仓库',
      source: 'auto',
      scriptPath: '',
    }),
    id: sessionId,
  }
}

function getScriptLogStatusText(status) {
  return SCRIPT_LOG_STATUS_TEXT_MAP[status] || '未知状态'
}

function getScriptLogStatusClassName(baseClassName, status, extraClasses = []) {
  const classes = [baseClassName]
  if (Array.isArray(extraClasses)) {
    classes.push(...extraClasses.filter(Boolean))
  } else if (extraClasses) {
    classes.push(extraClasses)
  }

  if (status === SCRIPT_LOG_STATUS.running) classes.push(`${baseClassName}--running`)
  if (status === SCRIPT_LOG_STATUS.success) classes.push(`${baseClassName}--success`)
  if (status === SCRIPT_LOG_STATUS.failed) classes.push(`${baseClassName}--failed`)

  return classes.join(' ')
}

function trimScriptLogSessions(sessions) {
  return sessions.slice(-MAX_SCRIPT_LOG_SESSIONS)
}

function trimSyncJobs(jobs) {
  const active = jobs.filter(isSyncJobActive)
  const finished = jobs
    .filter((job) => !isSyncJobActive(job))
    .slice(-MAX_FINISHED_SYNC_JOBS)
  return [...active, ...finished].sort((a, b) => a.createdAt - b.createdAt)
}

function getAppDisplayName(path) {
  if (!path) return '未设置'
  const normalized = String(path).replace(/\\/g, '/')
  const parts = normalized.split('/')
  const fileName = parts[parts.length - 1] || path
  if (fileName.endsWith('.app')) {
    return fileName.slice(0, -4)
  }
  return fileName
}

function formatSyncHistoryDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0)
  if (safeMs < 1000) return `${safeMs}ms`
  const seconds = Math.round(safeMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  return `${minutes}m ${remainSeconds}s`
}

function formatSyncHistoryDateTime(timestamp) {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatRelativeSyncTimeCompact(timestamp) {
  if (!timestamp) return '无记录'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '-'
  const diffSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (diffSeconds < 60) return '刚刚'
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m 前`
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h 前`
  return `${Math.floor(diffSeconds / 86400)}d 前`
}

function getSyncHistorySortTime(entry) {
  return entry.finishedAt || entry.createdAt || 0
}

function getSyncHistoryGroupKey(entry) {
  return entry.repoId || entry.repoPath || entry.repoName || 'unknown-repo'
}

function getSyncHistorySearchText(entry) {
  return [
    entry.requestId,
    entry.jobId,
    entry.trigger,
    entry.repoName,
    entry.repoPath,
    entry.message,
    entry.errorSummary,
    entry.branch,
    entry.commitHash,
    entry.commitMessage,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function normalizeRepoPath(value) {
  const input = String(value || '').trim()
  if (!input) return ''
  const trimmed = input.replace(/[\\/]+$/, '')
  return trimmed || input
}

function normalizeFsPath(value) {
  return String(value || '').trim().replace(/\\/g, '/')
}

function getGitHubRepoUrlFromRemote(remoteValue) {
  const remote = String(remoteValue || '').trim()
  if (!remote) return ''

  const normalizeRemoteRepoPath = (value) => String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')

  const buildGitHubUrl = (host, repoPath) => {
    const normalizedHost = String(host || '').trim().toLowerCase()
    const normalizedRepoPath = normalizeRemoteRepoPath(repoPath)
    if (!normalizedHost || !normalizedRepoPath) return ''
    if (!normalizedHost.includes('github')) return ''
    return `https://${normalizedHost}/${normalizedRepoPath}`
  }

  try {
    const parsed = new URL(remote)
    const fromStandardUrl = buildGitHubUrl(parsed.host || parsed.hostname, parsed.pathname)
    if (fromStandardUrl) return fromStandardUrl
  } catch {
    // Fallback to scp-like Git remote format: git@host:owner/repo.git
  }

  const scpLikeMatch = remote.match(/^(?:.+@)?([^:/]+):(.+)$/)
  if (scpLikeMatch) {
    return buildGitHubUrl(scpLikeMatch[1], scpLikeMatch[2])
  }

  return ''
}

function getGitHubRepoFullNameFromRemote(remoteValue) {
  const gitHubUrl = getGitHubRepoUrlFromRemote(remoteValue)
  if (!gitHubUrl) return ''

  try {
    const parsed = new URL(gitHubUrl)
    if (!parsed.hostname.toLowerCase().includes('github')) return ''
    const parts = parsed.pathname
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .split('/')
      .filter(Boolean)
    if (parts.length < 2) return ''
    return `${parts[0]}/${parts[1]}`.toLowerCase()
  } catch {
    return ''
  }
}

function getFileExtension(path) {
  const normalized = normalizeFsPath(path)
  const fileName = normalized.split('/').pop() || ''
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return ''
  return fileName.slice(dotIndex + 1).toLowerCase()
}

function isWindowsPlatform() {
  if (typeof navigator === 'undefined') return false
  const userAgent = String(navigator.userAgent || '').toLowerCase()
  const platform = String(navigator.platform || '').toLowerCase()
  return userAgent.includes('windows') || platform.includes('win')
}

function getSupportedBuildScriptExtensions() {
  return isWindowsPlatform()
    ? BUILD_SCRIPT_EXTENSIONS
    : NON_WINDOWS_BUILD_SCRIPT_EXTENSIONS
}

function getBuildScriptFileFilters(extensions) {
  return [{ name: '编译脚本', extensions }]
}

function formatBuildScriptExtensions(extensions) {
  return extensions.map((ext) => `.${ext}`).join(' / ')
}

function getBuildScriptSupport() {
  const extensions = getSupportedBuildScriptExtensions()
  return {
    extensions,
    extensionsText: formatBuildScriptExtensions(extensions),
    filters: getBuildScriptFileFilters(extensions),
  }
}

function isSupportedBuildScriptFile(path, supportedExtensions = BUILD_SCRIPT_EXTENSIONS) {
  const extension = getFileExtension(path)
  return supportedExtensions.includes(extension)
}

function toRepoRelativeScriptPath(repoPath, filePath) {
  const normalizedRepo = normalizeFsPath(normalizeRepoPath(repoPath))
  const normalizedFile = normalizeFsPath(filePath)
  if (!normalizedRepo || !normalizedFile) return ''

  const repoPrefix = normalizedRepo.endsWith('/')
    ? normalizedRepo
    : `${normalizedRepo}/`
  if (normalizedFile.toLowerCase().startsWith(repoPrefix.toLowerCase())) {
    return normalizedFile.slice(repoPrefix.length)
  }
  return ''
}

function getWindowActivityState() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function getErrorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return '未知错误'
  }
}

function isMacOSWebView() {
  return typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent)
}

function getAppUpdateSettingsMessage(state) {
  const version = state.version ? `v${state.version}` : ''
  if (state.phase === 'current') return '当前已是最新版本'
  if (state.phase === 'checking') return '正在后台检查更新…'
  if (state.phase === 'downloading') {
    const percent = state.contentLength > 0
      ? ` ${Math.min(100, Math.round((state.downloadedBytes / state.contentLength) * 100))}%`
      : ''
    return `正在后台下载 ${version}${percent}`.trim()
  }
  if (state.phase === 'ready') {
    return `${version} 已下载，等待安装${state.error ? `；${state.error}` : ''}`.trim()
  }
  if (state.phase === 'preparing') return '正在确认 Git 操作并准备安装更新…'
  if (state.phase === 'installing') return `正在安装 ${version}`.trim()
  if (state.phase === 'relaunching') return '正在重新启动 GitSync'
  if (state.phase === 'restartRequired') {
    return `${version} 已安装，等待重新启动${state.error ? `；${state.error}` : ''}`.trim()
  }
  if (state.phase === 'error') return `更新检查失败：${state.error}`
  return ''
}

function isRepoPathMissingError(message) {
  const normalized = String(message || '').trim().toLowerCase()
  if (!normalized) return false
  return [
    '目录不存在',
    '目标路径不是目录',
    '路径不存在',
    'no such file or directory',
    'not a directory',
    'os error 2',
    'os error 3',
    'cannot find the path',
    'system cannot find the path',
  ].some((pattern) => normalized.includes(pattern))
}

function normalizeMissingRepoMessage(message) {
  const text = String(message || '').trim()
  if (!text) return MISSING_REPO_DEFAULT_MESSAGE
  return text.split('\n')[0].trim() || MISSING_REPO_DEFAULT_MESSAGE
}

function shouldShowMissingRepoMessage(message) {
  const normalized = normalizeMissingRepoMessage(message)
  const compact = normalized.replace(/\s+/g, '')
  return compact !== '目录不存在' && compact !== MISSING_REPO_DEFAULT_MESSAGE.replace(/\s+/g, '')
}

function buildRefreshFailureToastMessage(failures) {
  const failureList = Array.isArray(failures) ? failures : []
  if (failureList.length === 0) return ''
  const firstFailure = failureList[0]
  const prefix = failureList.length === 1
    ? `${firstFailure.name} 获取失败`
    : `${failureList.length} 个仓库刷新失败`
  return `${prefix}，已标记为“待刷新”，可稍后手动重试。`
}

function getMissingRepoIdentity(repo) {
  const name = String(repo?.name || '').trim()
  const path = String(repo?.path || '').trim()
  const id = String(repo?.id || '').trim()
  const primary = name || path || id || '未命名仓库'
  let secondary = ''
  if (path && path !== primary) {
    secondary = path
  } else if (id && id !== primary) {
    secondary = `ID: ${id}`
  }
  return {
    primary,
    secondary,
  }
}

function createMissingRepoSyncGuardIssue(message) {
  return {
    rule: MISSING_REPO_SYNC_GUARD_RULE,
    label: '仓库目录缺失',
    policy: SYNC_GUARD_POLICY.block,
    message: normalizeMissingRepoMessage(message),
  }
}

function createSyncGuardCheckFailedIssue(message) {
  return {
    rule: 'missingRemote',
    label: '检查失败',
    policy: SYNC_GUARD_POLICY.warn,
    message: `同步前检查执行失败：${message}`,
  }
}

function summarizeImportResults(results) {
  let successCount = 0
  const failures = []
  const warnings = []

  results.forEach((result) => {
    if (result.success) {
      successCount += 1
    } else if (result.failure) {
      failures.push(result.failure)
    }
    if (result.warning) {
      warnings.push(result.warning)
    }
  })

  return { successCount, failures, warnings }
}

function groupSyncHistoryEntries(entries) {
  const groupedEntries = new Map()
  entries.forEach((entry) => {
    const key = getSyncHistoryGroupKey(entry)
    if (!groupedEntries.has(key)) {
      groupedEntries.set(key, {
        key,
        repoName: entry.repoName || '未知仓库',
        repoPath: entry.repoPath || '',
        entries: [],
        success: 0,
        failed: 0,
        canceled: 0,
      })
    }

    const group = groupedEntries.get(key)
    group.entries.push(entry)
    if (entry.result === SYNC_JOB_STATUS.success) group.success += 1
    if (entry.result === SYNC_JOB_STATUS.failed) group.failed += 1
    if (entry.result === SYNC_JOB_STATUS.canceled) group.canceled += 1
  })

  return Array.from(groupedEntries.values())
}

function createSyncHistoryStats() {
  return {
    total: 0,
    success: 0,
    failed: 0,
    canceled: 0,
    durationTotal: 0,
    durationCount: 0,
  }
}

function filterSyncHistoryEntries(entries, normalizedKeyword, resultFilter, sourceFilter) {
  return [...entries]
    .sort((a, b) => getSyncHistorySortTime(b) - getSyncHistorySortTime(a))
    .filter((entry) => {
      if (resultFilter !== 'all' && entry.result !== resultFilter) return false
      if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false
      if (!normalizedKeyword) return true
      return getSyncHistorySearchText(entry).includes(normalizedKeyword)
    })
}

function getSyncHistoryStats(entries) {
  return entries.reduce((stats, entry) => {
    stats.total += 1
    if (entry.result === SYNC_JOB_STATUS.success) stats.success += 1
    if (entry.result === SYNC_JOB_STATUS.failed) stats.failed += 1
    if (entry.result === SYNC_JOB_STATUS.canceled) stats.canceled += 1
    if (typeof entry.durationMs === 'number') {
      stats.durationTotal += Math.max(0, entry.durationMs)
      stats.durationCount += 1
    }
    return stats
  }, createSyncHistoryStats())
}

function getSyncGuardIssueItems(checkResult, policies) {
  if (!checkResult || typeof checkResult !== 'object') return []

  const issues = []
  if (checkResult.has_local_changes) {
    issues.push({
      rule: 'localChanges',
      label: SYNC_GUARD_RULE_CONFIG.localChanges.label,
      policy: policies.localChanges,
      message: '检测到工作区存在未提交改动，同步可能改写当前工作树。',
    })
  }
  if (checkResult.missing_remote) {
    issues.push({
      rule: 'missingRemote',
      label: SYNC_GUARD_RULE_CONFIG.missingRemote.label,
      policy: policies.missingRemote,
      message: '未检测到 origin 远端，当前仓库无法执行 pull/push。',
    })
  }
  if (checkResult.conflict_risk) {
    let riskMessage = '检测到潜在冲突风险，请先确认仓库状态。'
    if (checkResult.has_unmerged_conflicts) {
      riskMessage = '检测到未解决冲突文件，请先完成冲突处理后再同步。'
    } else if (checkResult.ahead > 0 && checkResult.behind > 0) {
      riskMessage = `本地分支与远端分叉（ahead ${checkResult.ahead} / behind ${checkResult.behind}），同步可能触发冲突。`
    }
    issues.push({
      rule: 'conflictRisk',
      label: SYNC_GUARD_RULE_CONFIG.conflictRisk.label,
      policy: policies.conflictRisk,
      message: riskMessage,
    })
  }
  return issues
}

function formatSyncGuardSummaryText(source, blockedCount, warningCount) {
  const sourceLabel = SYNC_GUARD_SOURCE_LABELS[source] || '同步'
  if (blockedCount > 0 && warningCount > 0) {
    return `${sourceLabel}前检测到 ${blockedCount} 项阻断风险、${warningCount} 项警告风险。`
  }
  if (blockedCount > 0) {
    return `${sourceLabel}前检测到 ${blockedCount} 项阻断风险。`
  }
  return `${sourceLabel}前检测到 ${warningCount} 项警告风险。`
}

function createEmptySyncGuardCheckResult() {
  return { allowedRepoIds: [], warningItems: [], blockedItems: [] }
}

function classifySyncGuardCheckResults(checkResults) {
  const classified = createEmptySyncGuardCheckResult()
  checkResults.forEach((item) => {
    const issues = toArray(item?.issues)
    const hasBlockingIssue = issues.some((issue) => issue.policy === SYNC_GUARD_POLICY.block)
    const hasWarningIssue = issues.some((issue) => issue.policy === SYNC_GUARD_POLICY.warn)

    if (hasBlockingIssue) {
      classified.blockedItems.push(item)
      return
    }

    classified.allowedRepoIds.push(item.repoId)
    if (hasWarningIssue) {
      classified.warningItems.push(item)
    }
  })
  return classified
}

function formatSyncQueueNoticeMessage({ enqueuedCount, skippedCount, blockedCount, warningCount, skippedLabel }) {
  const parts = [`已加入队列 ${enqueuedCount} 个`]
  if (skippedCount > 0) parts.push(`跳过 ${skippedCount} 个${skippedLabel ? `（${skippedLabel}）` : ''}`)
  if (blockedCount > 0) parts.push(`阻断 ${blockedCount} 个`)
  if (warningCount > 0) parts.push(`警告 ${warningCount} 个`)
  return `${parts.join('，')}。`
}

function clearTimerRef(timerRef) {
  if (!timerRef.current) return
  clearTimeout(timerRef.current)
  timerRef.current = null
}

function getImmediateSyncVisualPhase(isSyncing, prevPhase) {
  if (isSyncing) {
    if (prevPhase === SYNC_VISUAL_PHASE.active) {
      return SYNC_VISUAL_PHASE.active
    }
    return SYNC_VISUAL_PHASE.entering
  }
  if (prevPhase === SYNC_VISUAL_PHASE.idle) {
    return SYNC_VISUAL_PHASE.idle
  }
  return SYNC_VISUAL_PHASE.leaving
}

function buildRepoCardClassName({
  batchMode,
  selected,
  syncVisualPhase,
  menuOpen,
  commitHistoryOpen,
  commitHistoryFlight,
  commitHistoryHandoff,
}) {
  const classes = ['repo-card']
  if (batchMode) classes.push('repo-card--batch-selectable')
  if (batchMode && selected) classes.push('repo-card--selected')
  if (commitHistoryOpen) classes.push('repo-card--history-open')
  if (commitHistoryFlight) classes.push('repo-card--history-flight')
  if (commitHistoryHandoff) classes.push('repo-card--history-handoff')
  if (syncVisualPhase !== SYNC_VISUAL_PHASE.idle) classes.push('repo-card--syncing')
  if (syncVisualPhase === SYNC_VISUAL_PHASE.active) classes.push('repo-card--syncing-pulse')
  if (syncVisualPhase === SYNC_VISUAL_PHASE.leaving) classes.push('repo-card--syncing-leaving')
  if (menuOpen) classes.push('repo-card--menu-open')
  return classes.join(' ')
}

function createRepoCornerBadge(tone, icon, label, spinning = false) {
  return { tone, icon, label, spinning }
}

function createRepoStateCallout(tone, icon, message, title = message) {
  return { tone, icon, message, title }
}

function getRepoCornerBadge({
  repoStatus,
  isSyncing,
  isQueued,
  modifiedCount,
  aheadCount,
  behindCount,
  needsUpstreamPublish,
  errorMessage,
  statusIssueMessage,
  comparisonState,
  comparisonError,
  isDetachedHead,
}) {
  if (errorMessage || repoStatus === 'error') {
    return createRepoCornerBadge('danger', 'warning', '错误')
  }
  if (repoStatus === 'conflict') {
    return createRepoCornerBadge('warning', 'warning', '冲突')
  }
  if (isSyncing) {
    return createRepoCornerBadge('info', 'sync', '同步中', true)
  }
  if (isQueued) {
    return createRepoCornerBadge('info', 'pause', '排队中')
  }
  if (repoStatus === 'paused') {
    return createRepoCornerBadge('muted', 'pause', '已暂停')
  }
  if (statusIssueMessage) {
    return createRepoCornerBadge('warning', 'warning', '待刷新')
  }
  if (comparisonState === 'error' || comparisonError) {
    return createRepoCornerBadge('warning', 'warning', '待刷新')
  }
  if (comparisonState === 'upstream-gone') {
    return createRepoCornerBadge('warning', 'branch', '上游失效')
  }
  if (isDetachedHead) {
    return createRepoCornerBadge('muted', 'branch', 'Detached')
  }
  if (modifiedCount > 0) {
    return createRepoCornerBadge('warning', 'edit', '有改动')
  }
  if (behindCount > 0) {
    return createRepoCornerBadge('info', 'arrowDown', '待拉取')
  }
  if (aheadCount > 0) {
    return createRepoCornerBadge('info', 'arrowUp', '待推送')
  }
  if (needsUpstreamPublish) {
    return createRepoCornerBadge('info', 'branch', '待发布')
  }
  return createRepoCornerBadge('success', 'check', '已同步')
}

function getRepoStateCallout({
  repoStatus,
  modifiedCount,
  behindCount,
  needsUpstreamPublish,
  errorMessage,
  statusIssueMessage,
  statusIssueDetail,
  comparisonState,
  comparisonError,
  isDetachedHead,
}) {
  if (errorMessage) {
    return createRepoStateCallout('danger', 'warning', errorMessage)
  }
  if (repoStatus === 'conflict') {
    return createRepoStateCallout('warning', 'warning', '检测到冲突文件，请先处理冲突后再同步。')
  }
  if (statusIssueMessage) {
    return createRepoStateCallout('warning', 'warning', statusIssueMessage, statusIssueDetail || statusIssueMessage)
  }
  if (comparisonState === 'error' || comparisonError) {
    return createRepoStateCallout('warning', 'warning', '当前分支状态待刷新。', comparisonError || '当前分支比较失败')
  }
  if (comparisonState === 'upstream-gone') {
    return createRepoStateCallout('warning', 'branch', '当前分支上游已删除。')
  }
  if (isDetachedHead) {
    return createRepoStateCallout('info', 'branch', '当前处于 detached HEAD。')
  }
  if (modifiedCount > 0) {
    return createRepoStateCallout('warning', 'warning', `本地有 ${modifiedCount} 个未提交改动`)
  }
  if (behindCount > 0) {
    return createRepoStateCallout('info', 'arrowDown', `远端有 ${behindCount} 个新提交，建议先同步。`)
  }
  if (needsUpstreamPublish) {
    return createRepoStateCallout('info', 'branch', '当前分支尚未发布到远端。')
  }
  return null
}

function getRepoStateIcon(iconType) {
  switch (iconType) {
    case 'sync':
      return Icons.sync
    case 'pause':
      return Icons.pause
    case 'edit':
      return Icons.edit
    case 'arrowUp':
      return Icons.arrowUp
    case 'arrowDown':
      return Icons.arrowDown
    case 'branch':
      return Icons.branch
    case 'check':
      return Icons.check
    default:
      return Icons.warning
  }
}

function getRepoLatestCommitDisplay(status, repo) {
  const latestCommit = status?.last_commit || repo?.last_commit || null
  const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

  const hash = normalizeText(latestCommit?.hash)
  const message = normalizeText(latestCommit?.message)
  const author = normalizeText(latestCommit?.author)
  const date = normalizeText(latestCommit?.date)
  const detailMessage = message || '暂无提交信息'

  let summary = detailMessage
  if (hash) {
    const shortHash = hash.slice(0, 7)
    summary = message ? `${shortHash} · ${message}` : shortHash
  }

  return {
    hash,
    message: detailMessage,
    author,
    date,
    summary,
  }
}

function getBranchRowStatus({ ahead, behind, isRemoteOnly, comparisonState, upstreamGone, isCheckedOutElsewhere }) {
  if (comparisonState === 'error') {
    return { text: '读取失败', tone: 'warning' }
  }
  if (upstreamGone || comparisonState === 'upstream-gone') {
    return { text: '上游已删除', tone: 'warning' }
  }
  if (isRemoteOnly) {
    return { text: '仅远端', tone: 'warning' }
  }
  if (isCheckedOutElsewhere) {
    return { text: '其他 worktree', tone: 'info' }
  }
  if (comparisonState === 'no-upstream') {
    return { text: '无 upstream', tone: 'info' }
  }
  if (comparisonState === 'detached') {
    return { text: 'Detached', tone: 'info' }
  }
  if (ahead > 0 && behind > 0) {
    return { text: `分叉 ${ahead}/${behind}`, tone: 'warning' }
  }
  if (behind > 0) {
    return { text: `落后 ${behind}`, tone: 'warning' }
  }
  if (ahead > 0) {
    return { text: `领先 ${ahead}`, tone: 'info' }
  }
  return { text: '已同步', tone: 'ok' }
}

function getBranchWriteDisableReason({
  isCurrent,
  modifiedCount,
  conflictedCount,
  isSyncing,
  isQueued,
  isSyncChecking,
  isRemoteRefreshing,
  branchOverviewLoading,
  branchOverviewError,
  isBranchOperationBusy,
  branchOperationTarget,
  isCheckedOutElsewhere,
  worktreePath,
  comparisonState,
}) {
  if (isCurrent) return '当前分支'
  if (conflictedCount > 0) return '存在冲突，请先解决冲突后再切换分支。'
  if (modifiedCount > 0) return '工作区或暂存区存在未提交改动，请先提交、stash 或清理后再切换分支。'
  if (isSyncing) return '正在同步，暂不能切换分支。'
  if (isQueued) return '正在排队同步，暂不能切换分支。'
  if (isBranchOperationBusy) return branchOperationTarget ? `正在处理 ${branchOperationTarget}，请稍候。` : '正在切换其他分支，请稍候。'
  if (isSyncChecking) return '正在检查同步条件，暂不能切换分支。'
  if (isRemoteRefreshing) return '正在获取远端状态，暂不能切换分支。'
  if (branchOverviewLoading) return '正在获取分支状态，暂不能切换分支。'
  if (branchOverviewError) return '分支状态读取失败，暂不能切换分支。'
  if (isCheckedOutElsewhere) return worktreePath ? `该分支已在另一个 worktree 检出：${worktreePath}` : '该分支已在另一个 worktree 检出。'
  if (comparisonState === 'error') return '分支状态读取失败，暂不能切换分支。'
  return ''
}

function getBranchSwitchOverlayState(branchSwitchPhase, branchName) {
  const targetLabel = String(branchName || '').trim()
  if (!targetLabel || branchSwitchPhase === BRANCH_SWITCH_PHASE.idle) return null

  if (branchSwitchPhase === BRANCH_SWITCH_PHASE.switching) {
    return {
      text: '正在切换分支...',
      title: `正在切换分支到 ${targetLabel}...`,
    }
  }
  if (branchSwitchPhase === BRANCH_SWITCH_PHASE.deleting) {
    return {
      text: '正在删除分支...',
      title: `正在删除分支 ${targetLabel}...`,
    }
  }

  return {
    text: '正在更新状态...',
    title: `已处理 ${targetLabel}，正在获取最新远端状态...`,
  }
}

function getBranchSwitchRowStatusText(rowStatusText, isSwitchingRow, branchSwitchPhase) {
  if (!isSwitchingRow) return rowStatusText
  if (branchSwitchPhase === BRANCH_SWITCH_PHASE.switching) return '切换中...'
  if (branchSwitchPhase === BRANCH_SWITCH_PHASE.deleting) return '删除中...'
  if (branchSwitchPhase === BRANCH_SWITCH_PHASE.refreshing) return '更新中...'
  return rowStatusText
}

function getBranchSwitchHint(branchSwitchPhase, branchName) {
  const targetLabel = String(branchName || '').trim()
  if (!targetLabel || branchSwitchPhase === BRANCH_SWITCH_PHASE.idle) return ''
  if (branchSwitchPhase === BRANCH_SWITCH_PHASE.switching) {
    return `正在切换到 ${targetLabel}，切换完成后会继续刷新远端状态。`
  }
  if (branchSwitchPhase === BRANCH_SWITCH_PHASE.deleting) {
    return `正在删除 ${targetLabel}，完成后会继续刷新分支状态。`
  }
  return `已处理 ${targetLabel}，正在获取最新远端信息并更新卡片状态。`
}

function isElementTextTruncated(element) {
  if (!element) return false
  return element.scrollWidth > element.clientWidth
}

function useTruncationState(textRef, signature) {
  const [isTruncated, setIsTruncated] = useState(false)

  useEffect(() => {
    const element = textRef.current
    if (!element) {
      setIsTruncated(false)
      return
    }

    const updateTruncatedState = () => {
      const nextValue = isElementTextTruncated(element)
      setIsTruncated((prev) => (prev === nextValue ? prev : nextValue))
    }

    updateTruncatedState()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateTruncatedState)
    observer.observe(element)
    return () => observer.disconnect()
  }, [textRef, signature])

  return isTruncated
}

function useEventCallback(callback) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  return useCallback((...args) => callbackRef.current(...args), [])
}

function isInteractiveEventFromChild(event) {
  const target = event.target
  if (!(target instanceof Element)) return false
  const interactiveAncestor = target.closest(REPO_CARD_INTERACTIVE_SELECTOR)
  return Boolean(interactiveAncestor && interactiveAncestor !== event.currentTarget)
}

function loadAppSettings() {
  try {
    const raw = readLocalStorageItem('gitsync-settings')
    if (!raw) return { ...DEFAULT_APP_SETTINGS }
    const parsed = JSON.parse(raw)
    const merged = { ...DEFAULT_APP_SETTINGS, ...parsed }
    merged.defaultSyncInterval = normalizeIntervalSeconds(
      merged.defaultSyncInterval,
      DEFAULT_APP_SETTINGS.defaultSyncInterval
    )
    merged.backgroundFetchInterval = normalizeIntervalSeconds(
      merged.backgroundFetchInterval,
      DEFAULT_APP_SETTINGS.backgroundFetchInterval
    )
    merged.autoOpenScriptLogDialog = merged.autoOpenScriptLogDialog !== false
    merged.postSyncScriptPullOnly = merged.postSyncScriptPullOnly === true
    merged.hideExistingGithubReposByDefault = merged.hideExistingGithubReposByDefault === true
    merged.syncGuardPolicies = normalizeSyncGuardPolicies(parsed?.syncGuardPolicies)
    return merged
  } catch {
    return { ...DEFAULT_APP_SETTINGS }
  }
}

function waitForMinimumElapsed(startedAt, minimumMs) {
  const remainingMs = minimumMs - (Date.now() - startedAt)
  if (remainingMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, remainingMs))
}

async function mapWithConcurrencyLimit(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return []

  const parsedConcurrency = parseInt(String(concurrency), 10)
  const safeConcurrency = Number.isNaN(parsedConcurrency)
    ? 1
    : Math.max(1, Math.min(list.length, parsedConcurrency))

  const results = new Array(list.length)
  let cursor = 0

  async function runWorker() {
    while (true) {
      const index = cursor
      if (index >= list.length) return
      cursor += 1
      results[index] = await mapper(list[index], index)
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()))
  return results
}

// ==================== 主题管理 ====================

function subscribeToMediaQueryChange(mediaQuery, handler) {
  if (typeof mediaQuery?.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }
  if (typeof mediaQuery?.addListener === 'function') {
    mediaQuery.addListener(handler)
    return () => mediaQuery.removeListener(handler)
  }
  return undefined
}

function getSystemTheme() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function resolveTheme(theme) {
  return theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : getSystemTheme()
}

function useTheme() {
  const [theme, setTheme] = useState(() => readLocalStorageItem('gitsync-theme') || 'system')
  const [resolvedTheme, setResolvedTheme] = useState(() => resolveTheme(theme))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined
    }

    const applyTheme = (nextTheme) => {
      const nextResolvedTheme = resolveTheme(nextTheme)
      setResolvedTheme(nextResolvedTheme)
      document.documentElement.setAttribute('data-theme', nextResolvedTheme)
    }

    applyTheme(theme)
    writeLocalStorageItem('gitsync-theme', theme)

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => applyTheme('system')
      return subscribeToMediaQueryChange(mq, handler)
    }

    return undefined
  }, [theme])

  return [theme, setTheme, resolvedTheme]
}

// ==================== 子组件 ====================

function DashboardFilterEmptyState({ filterMode, resolvedTheme }) {
  const config = getDashboardFilterEmptyState(filterMode)
  const image = getDashboardEmptyStateImage(config, resolvedTheme)

  return (
    <div className="dashboard__filter-empty">
      <div className="dashboard__filter-empty-art">
        <img
          className="dashboard__filter-empty-image"
          src={image}
          alt=""
          aria-hidden="true"
        />
      </div>
      <div className="dashboard__filter-empty-title">{config.title}</div>
      <div className="dashboard__filter-empty-desc">{config.description}</div>
    </div>
  )
}

/*
 * 窄屏下侧边栏的悬浮卡片形态。
 *
 * 打开：面板变成一张浮在仪表盘之上的圆角卡片，贴着左边缘从屏幕外推进来；
 * 收起：镜像退回边缘之外（位移量是整张卡片宽度加上左边距）。
 * 窗口再次变宽：卸掉浮层类，让卡片跟着栅格第一列一起从 0 长回 240px，
 * 同时位移归零——动画结束那一刻正好与列边界重合，所以切回同一图层不会跳。
 */
function useFloatingSidebarCard({
  enabled,
  isOpen,
  isDocked,
  isCommitHistoryOpen,
  isSidebarActive,
  onRequestClose,
}) {
  // 唯一的真状态：这一次变宽是否要走「滑回栅格列」的回位动画。
  const [shouldDock, setShouldDock] = useState(false)
  // 上一次渲染结束时的 enable/open 边沿。只在 effect 里写，渲染期保持纯净
  // （StrictMode 会把渲染跑两遍，渲染期写 ref / setState 会被重复应用）。
  // 初值取首帧输入：否则首帧会被当成一次「变宽」，在启动时误播回位动画。
  const initialTransitionRef = useRef(null)
  if (initialTransitionRef.current === null) {
    initialTransitionRef.current = { wasEnabled: enabled, wasOpen: enabled && isOpen && !isDocked }
  }
  const wasEnabledRef = useRef(initialTransitionRef.current.wasEnabled)
  const wasOpenRef = useRef(initialTransitionRef.current.wasOpen)
  const dockSessionRef = useRef(false)

  useEffect(() => {
    // 判定走纯函数，effect 只负责读写边沿与控制状态。
    const transition = resolveSidebarCardTransition(
      { wasEnabled: wasEnabledRef.current, wasOpen: wasOpenRef.current },
      { enabled, isOpen, isDocked }
    )
    wasEnabledRef.current = transition.wasEnabled
    wasOpenRef.current = transition.wasOpen

    if (isDocked) {
      // 宽度够了：面板已经回收进栅格列，这次回位会话到此结束。
      // 少了这一句，回位动画结束的那一帧会倒回「收在屏幕外」。
      if (dockSessionRef.current) {
        dockSessionRef.current = false
        setShouldDock(false)
      }
      return
    }

    if (transition.shouldStartDocking) {
      if (!dockSessionRef.current) {
        dockSessionRef.current = true
        setShouldDock(true)
      }
      return
    }

    // 回位中途又变窄：立刻中止，否则栅格列会一直停在「还给栅格」那一档。
    if (dockSessionRef.current) {
      dockSessionRef.current = false
      setShouldDock(false)
    }
  }, [enabled, isOpen, isDocked])

  const mode = resolveSidebarCardMode({ enabled, isOpen, isDocked, isDocking: shouldDock })
  const isFloating = isSidebarCardFloating(mode)
  const isCardVisible = isSidebarCardOpen(mode) && isSidebarActive
  const isCardBackdropVisible = isCardVisible && !isCommitHistoryOpen

  // 回位动画的结束以真实的过渡事件为准，`SIDEBAR_CARD_DOCK_FALLBACK_MS` 只是兜底：
  // 元素被卸载、`prefers-reduced-motion` 把过渡压到 1ms、或者过渡压根没触发时，
  // 状态都必须能自己收敛，不能把「动画结束」这件事只押在 JS 这边的时长上。
  useEffect(() => {
    if (!shouldDock) return undefined
    // 直接查 DOM：侧边栏的 id 是稳定的唯一入口（App 有 id="app-sidebar"）。
    // 这里不能再引入 ref —— 它的声明在 hook 作用域内，App 的 JSX 拿不到，
    // 之前那样写会让 current 永远是 undefined，transitionend 等于没接。
    const sidebar = document.getElementById('app-sidebar')
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      setShouldDock(false)
    }
    const handleTransitionEnd = (event) => {
      if (event.target !== sidebar) return
      if (event.propertyName !== 'transform') return
      finish()
    }
    sidebar?.addEventListener('transitionend', handleTransitionEnd)
    const fallbackTimer = setTimeout(finish, SIDEBAR_CARD_DOCK_FALLBACK_MS)
    return () => {
      sidebar?.removeEventListener('transitionend', handleTransitionEnd)
      clearTimeout(fallbackTimer)
    }
  }, [shouldDock])

  // 卡片展开时把圆角与四周留白交给 CSS 变量，退场时再交还给 CSS 里的断点值。
  useLayoutEffect(() => {
    if (!isFloating) return undefined
    const card = resolveSidebarCardRect()
    const root = document.documentElement
    const properties = {
      '--sidebar-card-inset': `${card.inset}px`,
      '--sidebar-card-radius': `${card.radius}px`,
      '--sidebar-card-z-index': String(card.zIndex),
      '--sidebar-card-edge-right': `${card.edgeRight}px`,
      '--sidebar-card-edge-bottom': `${card.edgeRight}px`,
    }
    Object.entries(properties).forEach(([name, value]) => root.style.setProperty(name, value))
    return () => {
      Object.keys(properties).forEach((name) => root.style.removeProperty(name))
    }
  }, [isFloating])

  // 卡片浮在仪表盘上时，Esc 与点击卡片外部都收起，和抽屉的关闭手势保持一致。
  useEffect(() => {
    if (!isCardBackdropVisible) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onRequestClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isCardBackdropVisible, onRequestClose])

  return {
    isFloating,
    isDocking: isSidebarCardDocking(mode),
    isCardVisible,
    isCardBackdropVisible,
  }
}

function Sidebar({
  currentPage,
  onNavigate,
  stats,
  currentSyncMode,
  onSyncAll,
  onSyncChangedOnly,
  isSyncAllRunning,
  isSyncChangedOnlyRunning,
  syncAllButtonLabel = '全部同步',
  syncChangedOnlyButtonLabel = '按改动同步',
  onSyncFailedOnly,
  failedRepoCount,
  canRevealFailedSync,
  interactive = true,
  collapsed = false,
  floating = false,
  open = false,
  docking = false,
  onToggle,
}) {
  const [showHoverSyncActions, setShowHoverSyncActions] = useState(false)
  const revealTimerRef = useRef(null)
  const hideTimerRef = useRef(null)
  const canShowChangedSyncHoverAction = Boolean(onSyncChangedOnly)
  const canShowFailedSyncHoverAction = canRevealFailedSync && failedRepoCount > 0
  const canShowHoverSyncActions = canShowChangedSyncHoverAction || canShowFailedSyncHoverAction
  const modeType = currentSyncMode === 'auto' ? 'auto' : 'manual'
  const modeLabel = SYNC_MODE_LABELS[modeType]

  const clearRevealTimer = () => {
    clearTimerRef(revealTimerRef)
  }

  const clearHideTimer = () => {
    clearTimerRef(hideTimerRef)
  }

  const keepHoverSyncActionsVisible = () => {
    clearHideTimer()
  }

  const scheduleHideHoverSyncActions = () => {
    if (!showHoverSyncActions) return
    clearHideTimer()
    hideTimerRef.current = setTimeout(() => {
      setShowHoverSyncActions(false)
      hideTimerRef.current = null
    }, SYNC_FAILED_HOVER_HIDE_MS)
  }

  const handleSyncAllMouseEnter = () => {
    if (!canShowHoverSyncActions || showHoverSyncActions) return
    keepHoverSyncActionsVisible()
    clearRevealTimer()
    revealTimerRef.current = setTimeout(() => {
      setShowHoverSyncActions(true)
      revealTimerRef.current = null
    }, SYNC_FAILED_HOVER_REVEAL_MS)
  }

  const handleSyncAllMouseLeave = () => {
    clearRevealTimer()
  }

  const handleHoverSyncActionMouseEnter = () => {
    keepHoverSyncActionsVisible()
  }

  const handleSidebarMouseEnter = () => {
    keepHoverSyncActionsVisible()
  }

  const handleSidebarMouseLeave = () => {
    clearRevealTimer()
    scheduleHideHoverSyncActions()
  }

  useEffect(() => {
    if (canShowHoverSyncActions) return
    clearRevealTimer()
    clearHideTimer()
    setShowHoverSyncActions(false)
  }, [canShowHoverSyncActions])

  useEffect(() => () => {
    clearRevealTimer()
    clearHideTimer()
  }, [])

  const failedButtonLabel = `同步失败仓库（${failedRepoCount}）`
  const sidebarClassName = [
    'sidebar',
    floating ? 'sidebar--card' : '',
    floating && open ? 'sidebar--card-open' : '',
    docking ? 'sidebar--card-docking' : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      id="app-sidebar"
      className={sidebarClassName}
      aria-hidden={interactive && !collapsed ? undefined : 'true'}
      inert={interactive && !collapsed ? undefined : true}
      onMouseEnter={handleSidebarMouseEnter}
      onMouseLeave={handleSidebarMouseLeave}
    >
      <div className="sidebar__brand">
        <img src={brandIcon} alt="" aria-hidden="true" className="sidebar__brand-logo" />
        <span className="sidebar__brand-name">GitSync</span>
        {/* `collapsed` 表示面板收在屏幕外（浮层形态），那种状态它只是透明但
            仍然可聚焦，所以用 interactive 而不是 !collapsed 作为渲染条件。 */}
        {onToggle && interactive ? (
          <button
            type="button"
            className="sidebar__collapse-btn"
            onClick={onToggle}
            aria-label="收起侧边栏"
            aria-expanded
            aria-controls="app-sidebar"
            data-app-tooltip="收起侧边栏"
          >
            <Icons.sidebarPanel className="icon icon--sm" />
          </button>
        ) : null}
      </div>

      <div className="sidebar__stats">
        <div className="sidebar__stats-grid">
          <div className="stat-item">
            <div className="stat-item__value stat-item__value--total">{stats.total}</div>
            <div className="stat-item__label">仓库</div>
          </div>
          <div className="stat-item">
            <div className="stat-item__value stat-item__value--syncing">{stats.syncing}</div>
            <div className="stat-item__label">同步中</div>
          </div>
          <div className="stat-item">
            <div className="stat-item__value stat-item__value--conflict">{stats.conflict}</div>
            <div className="stat-item__label">冲突</div>
          </div>
          <div className="stat-item">
            <div className="stat-item__value stat-item__value--error">{stats.error}</div>
            <div className="stat-item__label">错误</div>
          </div>
          <div className="stat-item stat-item--mode">
            <div className={`stat-item__value stat-item__value--mode-${modeType}`}>
              {modeLabel}
            </div>
            <div className="stat-item__label">当前同步模式</div>
          </div>
        </div>
      </div>

      <div className="sidebar__nav">
        <button
          className={`nav-item ${currentPage === 'dashboard' ? 'nav-item--active' : ''}`}
          onClick={() => onNavigate('dashboard')}
        >
          <Icons.dashboard className="icon nav-item__icon" />
          仪表盘
        </button>
        <button
          className={`nav-item ${currentPage === 'history' ? 'nav-item--active' : ''}`}
          onClick={() => onNavigate('history')}
        >
          <Icons.clock className="icon nav-item__icon" />
          历史
        </button>
        <button
          className={`nav-item ${currentPage === 'settings' ? 'nav-item--active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          <Icons.settings className="icon nav-item__icon" />
          设置
        </button>
      </div>

      <div className="sidebar__footer">
        {canShowHoverSyncActions && showHoverSyncActions ? (
          <>
            <div
              className="sidebar__sync-hover-bridge"
              onMouseEnter={handleHoverSyncActionMouseEnter}
              aria-hidden="true"
            />
            <div className="sidebar__sync-hover-actions" onMouseEnter={handleHoverSyncActionMouseEnter}>
              {canShowChangedSyncHoverAction ? (
                <button
                  className={`sidebar__sync-hover-btn sidebar__sync-hover-btn--changed ${isSyncChangedOnlyRunning ? 'sidebar__sync-hover-btn--syncing' : ''}`}
                  onClick={onSyncChangedOnly}
                  disabled={isSyncChangedOnlyRunning}
                  data-app-tooltip="仅同步有改动（ahead/behind）的仓库"
                >
                  {isSyncChangedOnlyRunning
                    ? <span className="spinning"><Icons.bolt className="icon icon--sm" /></span>
                    : <Icons.bolt className="icon icon--sm" />}
                  {syncChangedOnlyButtonLabel}
                </button>
              ) : null}
              {canShowFailedSyncHoverAction ? (
                <button
                  className="sidebar__sync-hover-btn sidebar__sync-hover-btn--failed"
                  onClick={onSyncFailedOnly}
                  data-app-tooltip="仅同步失败仓库"
                >
                  <Icons.warning className="icon icon--sm" />
                  {failedButtonLabel}
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        <button
          className={`sidebar__sync-all-btn ${isSyncAllRunning ? 'sidebar__sync-all-btn--syncing' : ''}`}
          onClick={onSyncAll}
          disabled={isSyncAllRunning}
          onMouseEnter={handleSyncAllMouseEnter}
          onMouseLeave={handleSyncAllMouseLeave}
        >
          {isSyncAllRunning
            ? <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
            : <Icons.sync className="icon icon--sm" />}
          {syncAllButtonLabel}
        </button>
      </div>
    </div>
  )
}

function CustomSelect({ value, options, onChange, ariaLabel, className }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const selectedOption = options.find((option) => option.value === value) || options[0] || null

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const handleSelect = (nextValue) => {
    setOpen(false)
    if (nextValue !== value) {
      onChange(nextValue)
    }
  }

  return (
    <div className={`custom-select ${className || ''}`.trim()} ref={rootRef}>
      <button
        type="button"
        className={`custom-select__trigger ${open ? 'custom-select__trigger--open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="custom-select__label">{selectedOption?.label || '-'}</span>
        <Icons.arrowDown className={`icon icon--xs custom-select__arrow ${open ? 'custom-select__arrow--open' : ''}`} />
      </button>

      {open ? (
        <div className="custom-select__menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`custom-select__option ${option.value === value ? 'custom-select__option--active' : ''}`}
              onClick={() => handleSelect(option.value)}
              role="option"
              aria-selected={option.value === value}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const RepoMetaHoverCard = forwardRef(function RepoMetaHoverCard(
  { title, ariaLabel, className = '', children, ...rest },
  ref
) {
  const hoverCardClassName = ['repo-card__meta-hover-card', className].filter(Boolean).join(' ')
  return (
    <div ref={ref} className={hoverCardClassName} role="tooltip" aria-label={ariaLabel} {...rest}>
      {title ? <div className="repo-card__meta-hover-card-title">{title}</div> : null}
      {children}
    </div>
  )
})

function BranchDeleteConfirmDialog({
  repo,
  branchName,
  remoteBranchName,
  remoteRequired = false,
  busy = false,
  refreshing = false,
  onCancel,
  onConfirm,
}) {
  const hasRemoteTarget = Boolean(remoteBranchName)
  const hasLocalDelete = !remoteRequired && Boolean(branchName)
  const [deleteRemote, setDeleteRemote] = useState(Boolean(remoteRequired))
  const [forceDelete, setForceDelete] = useState(false)

  useEffect(() => {
    setDeleteRemote(Boolean(remoteRequired))
    setForceDelete(Boolean(hasLocalDelete && readBranchForceDeleteDefault()))
  }, [branchName, remoteBranchName, remoteRequired, hasLocalDelete])

  const remoteChecked = remoteRequired || (hasRemoteTarget && deleteRemote)
  const checkboxDisabled = busy || !hasRemoteTarget
  const subtitle = remoteRequired
    ? '该行是仅远端分支，将删除远端引用。'
    : '默认只删除本地分支，可选择同时删除远端分支。'

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div data-overlay-motion="surface" className="delete-dialog branch-delete-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="delete-dialog__header">
          <div className="delete-dialog__icon">
            <Icons.trash className="icon icon--warning" />
          </div>
          <div>
            <div className="delete-dialog__title">确认删除分支</div>
            <div className="delete-dialog__subtitle">{subtitle}</div>
          </div>
        </div>

        <div className="delete-dialog__body branch-delete-dialog__body">
          <div className="branch-delete-dialog__repo">{repo?.name || repo?.id || '当前仓库'}</div>
          <div className="branch-delete-dialog__branch">{branchName}</div>
          {remoteRequired ? (
            <div className="branch-delete-dialog__remote-required" role="note">
              <span className="branch-delete-dialog__remote-required-icon" aria-hidden="true">
                <Icons.warning className="icon icon--xs" />
              </span>
              <span className="branch-delete-dialog__checkbox-copy">
                <span>将删除远程分支</span>
                <small>{remoteBranchName}</small>
              </span>
            </div>
          ) : (
            <CanonicalCheckbox
              className={`branch-delete-dialog__remote-option ${checkboxDisabled ? 'branch-delete-dialog__remote-option--disabled' : ''}`}
              checked={remoteChecked}
              disabled={checkboxDisabled}
              onChange={(checked) => setDeleteRemote(checked)}
              label="同时删除远程分支"
            >
              <span className="branch-delete-dialog__checkbox-copy">
                <span>同时删除远程分支</span>
                <small>{hasRemoteTarget ? remoteBranchName : '没有可删除的远程分支'}</small>
              </span>
            </CanonicalCheckbox>
          )}
          {hasLocalDelete ? (
            <CanonicalCheckbox
              className="branch-delete-dialog__force-option"
              checked={forceDelete}
              disabled={busy}
              onChange={setForceDelete}
              label="强制删除本地分支（git branch -D）"
            >
              <span className="branch-delete-dialog__checkbox-copy">
                <span>强制删除本地分支</span>
                <small>跳过“尚未合并”检查（git branch -D）</small>
              </span>
            </CanonicalCheckbox>
          ) : null}
        </div>

        <div className="delete-dialog__footer">
          <button className="dialog-btn" onClick={onCancel} disabled={busy}>取消</button>
          <button
            className="dialog-btn dialog-btn--danger"
            onClick={() => onConfirm?.({ deleteRemote: remoteChecked, forceDelete: hasLocalDelete && forceDelete })}
            disabled={busy || !branchName}
          >
            {busy
              ? (forceDelete ? '强制删除中...' : refreshing ? '更新状态...' : '删除中...')
              : (forceDelete ? '确认强制删除' : '确认删除')}
          </button>
        </div>
      </div>
    </div>
  )
}

function RepoCard({
  repo,
  status,
  statusIssue,
  statusIssueNow,
  queueState,
  isSyncChecking,
  isRemoteRefreshing,
  isFocusRefreshing,
  isPathMissing,
  pathMissingMessage,
  postSyncBuildState,
  canRetrySync,
  batchMode,
  selected,
  onToggleSelect,
  onSync,
  onCancelSync,
  onRetrySync,
  onPause,
  onResume,
  onOpenDirectory,
  onOpenWithApp,
  onOpenWithTerminal,
  onOpenGitHubRepo,
  onViewCommitHistory,
  openWithAppText,
  openWithTerminalText,
  onRequestRemove,
  onViewErrors,
  onTogglePostSyncBuild,
  onSelectPostSyncBuildScript,
  onClearPostSyncBuildScript,
  onRunPostSyncBuildScriptNow,
  onBranchChanged,
  branchOverviewSnapshot,
  onBranchOverviewChanged,
  dismissedBranchAttentionKey,
  onDismissBranchAttention,
  onBranchOperationFeedback,
  onCopyRepoMeta,
  commitHistoryOpen = false,
  commitHistoryOverlayActive = false,
  commitHistoryClosing = false,
  commitHistoryFlight = false,
  commitHistoryHandoff = false,
  commitHistoryHandoffHeight = null,
  commitHistoryHandoffSourceHeight = null,
  commitHistoryTransitionHidden = false,
  historyToolbar = null,
  dashboardSortMode = DASHBOARD_REPO_SORT_MODE.nameAsc,
  syncTimestamp = 0,
}) {
  const [syncVisualPhase, setSyncVisualPhase] = useState(SYNC_VISUAL_PHASE.idle)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAnimationReady, setMenuAnimationReady] = useState(false)
  const [moreMenuPlacement, setMoreMenuPlacement] = useState(REPO_CARD_MORE_MENU_PLACEMENT.bottom)
  const [moreMenuStyle, setMoreMenuStyle] = useState(null)
  const branchOverview = branchOverviewSnapshot || null
  const [branchOverviewLoading, setBranchOverviewLoading] = useState(false)
  const [branchOverviewError, setBranchOverviewError] = useState('')
  const [branchSwitchError, setBranchSwitchError] = useState('')
  const [branchOperationPhase, setBranchOperationPhase] = useState(BRANCH_SWITCH_PHASE.idle)
  const [branchOperationTarget, setBranchOperationTarget] = useState('')
  const [branchOperationWarning, setBranchOperationWarning] = useState('')
  const [branchDeleteConfirm, setBranchDeleteConfirm] = useState(null)
  const [branchDeletePresent, setBranchDeletePresent] = useState(false)
  const [branchDeleteSubmitting, setBranchDeleteSubmitting] = useState(false)
  const [openMetaHoverCard, setOpenMetaHoverCard] = useState(null)
  const [metaHoverActive, setMetaHoverActive] = useState(false)
  const [branchHoverCardPlacement, setBranchHoverCardPlacement] = useState(REPO_CARD_MORE_MENU_PLACEMENT.bottom)
  const [branchHoverCardStyle, setBranchHoverCardStyle] = useState(null)
  const [branchHoverBridgeStyle, setBranchHoverBridgeStyle] = useState(null)
  const [commitHoverCardPlacement, setCommitHoverCardPlacement] = useState(REPO_CARD_MORE_MENU_PLACEMENT.bottom)
  const [commitHoverCardStyle, setCommitHoverCardStyle] = useState(null)
  const [commitHoverBridgeStyle, setCommitHoverBridgeStyle] = useState(null)
  const [branchNameTooltip, setBranchNameTooltip] = useState(null)
  const moreActionAreaRef = useRef(null)
  const moreButtonRef = useRef(null)
  const moreMenuRef = useRef(null)
  const branchMetaHostRef = useRef(null)
  const branchHoverCardRef = useRef(null)
  const previousOpenMetaHoverCardRef = useRef(null)
  const commitMetaHostRef = useRef(null)
  const commitHoverCardRef = useRef(null)
  // The hover *region* of a key is trigger + bridge + hover card. The `*MetaHostRef`
  // wrappers above are deliberately NOT part of it: they also contain the copy button and
  // the commit-history link, which must not keep a hover card alive.
  const pathMetaTargetRef = useRef(null)
  const pathHoverCardRef = useRef(null)
  const branchMetaTargetRef = useRef(null)
  const branchHoverBridgeRef = useRef(null)
  const commitMetaTargetRef = useRef(null)
  const commitHoverBridgeRef = useRef(null)
  const metaHoverPointerTrackerRef = useRef(null)
  const latestCommitTextRef = useRef(null)
  const repoPathTextRef = useRef(null)
  const branchOverviewTaskRef = useRef(null)
  const branchOverviewLoadedAtRef = useRef(0)
  const branchOperationInFlightRef = useRef(false)
  const branchNameTooltipTimerRef = useRef(null)
  const repoStatus = repo.status || 'idle'
  const isMissingRepoPath = Boolean(isPathMissing)
  const missingRepoOverlayMessage = normalizeMissingRepoMessage(pathMissingMessage)
  const shouldShowMissingRepoDetails = shouldShowMissingRepoMessage(pathMissingMessage)
  const missingRepoIdentity = getMissingRepoIdentity(repo)
  const statusIssueDisplay = getRepoStatusIssueDisplay(statusIssue, statusIssueNow)
  const statusIssueMessage = statusIssueDisplay.message && statusIssueDisplay.relativeTime
    ? `${statusIssueDisplay.message}（${statusIssueDisplay.relativeTime}）`
    : statusIssueDisplay.message
  const statusIssueDetail = statusIssueDisplay.relativeTime
    ? `${statusIssueDisplay.detail}\n最后失败：${statusIssueDisplay.relativeTime}`
    : statusIssueDisplay.detail
  const {
    isSyncing,
    isQueued,
    isActiveSyncTask,
    statusDotType,
    statusLabel,
  } = getRepoSyncDisplayState(repoStatus, queueState)
  const hasErrors = Boolean(repo.last_error) || (repo.error_logs?.length || 0) > 0
  const gitHubRepoUrl = getGitHubRepoUrlFromRemote(repo.remote)
  const hasGitHubRepo = gitHubRepoUrl.length > 0
  const selectedBuildScript = String(repo.post_sync_build_script || '').trim()
  const hasSelectedBuildScript = selectedBuildScript.length > 0
  const postSyncBuildEnabled = Boolean(repo.post_sync_build_enabled)
  const showAutoScriptIndicator = postSyncBuildEnabled && hasSelectedBuildScript
  const normalizedPostSyncBuildState = postSyncBuildState || POST_SYNC_BUILD_STATE.idle
  const isPostSyncBuildRunning = normalizedPostSyncBuildState === POST_SYNC_BUILD_STATE.running
  const isPostSyncBuildSuccess = normalizedPostSyncBuildState === POST_SYNC_BUILD_STATE.success
  const isPostSyncBuildFailed = normalizedPostSyncBuildState === POST_SYNC_BUILD_STATE.failed
  const autoScriptIndicatorClassName = [
    'repo-card__auto-script-indicator',
    isPostSyncBuildRunning ? 'repo-card__auto-script-indicator--running' : '',
    isPostSyncBuildSuccess ? 'repo-card__auto-script-indicator--success' : '',
    isPostSyncBuildFailed ? 'repo-card__auto-script-indicator--failed' : '',
  ].filter(Boolean).join(' ')
  let autoScriptIndicatorLabel = '自动脚本'
  if (isPostSyncBuildRunning) autoScriptIndicatorLabel = '脚本执行中'
  else if (isPostSyncBuildSuccess) autoScriptIndicatorLabel = '脚本完成'
  else if (isPostSyncBuildFailed) autoScriptIndicatorLabel = '脚本失败'
  const syncButtonMode = getSyncButtonMode(isSyncing, isQueued)
  const syncButtonClassName = getSyncButtonClassName(syncButtonMode)
  const currentBranchName = status?.branch || repo.branch || 'main'
  const branchDisplayName = currentBranchName
  const isBranchSwitching = branchOperationPhase === BRANCH_SWITCH_PHASE.switching
  const isBranchDeleting = branchOperationPhase === BRANCH_SWITCH_PHASE.deleting
  const isBranchRefreshing = branchOperationPhase === BRANCH_SWITCH_PHASE.refreshing
  const isBranchSwitchBusy = isBranchSwitching || isBranchDeleting || isBranchRefreshing
  const branchSwitchTargetLabel = branchOperationTarget || branchDisplayName
  const branchSwitchOverlayState = getBranchSwitchOverlayState(
    branchOperationPhase,
    branchSwitchTargetLabel
  )
  const branchSwitchHint = getBranchSwitchHint(branchOperationPhase, branchOperationTarget)
  const isActionOverlayVisible = isBranchSwitchBusy || isSyncChecking || isRemoteRefreshing || isFocusRefreshing
  const actionControlsDisabled = isActionOverlayVisible || isMissingRepoPath || commitHistoryOverlayActive
  const canRequestSyncFromRefreshOverlay = !isBranchSwitchBusy
    && !isSyncChecking
    && !isActiveSyncTask
    && !isMissingRepoPath
    && !commitHistoryOverlayActive
    && (isRemoteRefreshing || isFocusRefreshing)
  let actionOverlayText = ''
  let actionOverlayTitle = undefined
  if (branchSwitchOverlayState) {
    actionOverlayText = branchSwitchOverlayState.text
    actionOverlayTitle = branchSwitchOverlayState.title
  } else if (isSyncChecking) {
    actionOverlayText = '检查中...'
    actionOverlayTitle = '正在检查同步前条件...'
  } else if (isRemoteRefreshing) {
    actionOverlayText = '获取更新中...'
    actionOverlayTitle = '正在获取远程更新...'
  } else if (isFocusRefreshing) {
    actionOverlayText = '刷新状态中...'
    actionOverlayTitle = '正在刷新仓库状态...'
  }
  const modifiedCount = status?.modified?.length || 0
  const behindCount = Math.max(0, status?.behind || 0)
  const aheadCount = Math.max(0, status?.ahead || 0)
  const needsUpstreamPublish = status?.needs_upstream_publish === true
  const latestCommit = getRepoLatestCommitDisplay(status, repo)
  const hasLatestCommitMeta = Boolean(latestCommit.author || latestCommit.date)
  const repoPathTruncated = useTruncationState(repoPathTextRef, repo.path)
  const latestCommitTruncated = useTruncationState(latestCommitTextRef, latestCommit.summary)
  const branchRemoteOnlyCount = Math.max(0, Number(branchOverview?.remote_only_count) || 0)
  const branchAheadCount = Math.max(0, Number(branchOverview?.ahead_branch_count) || 0)
  const branchBehindCount = Math.max(0, Number(branchOverview?.behind_branch_count) || 0)
  const branchDivergentCount = Math.max(0, Number(branchOverview?.divergent_branch_count) || 0)
  const branchUpstreamGoneCount = Math.max(0, Number(branchOverview?.upstream_gone_count) || 0)
  const branchComparisonErrorCount = Math.max(0, Number(branchOverview?.comparison_error_count) || 0)
  const branchCheckedOutElsewhereCount = Math.max(0, Number(branchOverview?.checked_out_elsewhere_count) || 0)
  const branchOverviewList = Array.isArray(branchOverview?.branches) ? branchOverview.branches : []
  const visibleBranchOverviewList = branchOverviewList.filter(
    (branchItem) => shouldShowBranchOverviewRow(branchItem, branchOverviewList)
  )
  const conflictedCount = Array.isArray(status?.conflicted) ? status.conflicted.length : 0
  const isDetachedHead = status?.detached_head === true
  const canSwitchBranch = modifiedCount === 0 && conflictedCount === 0 && !isSyncing && !isQueued
  const branchAttention = getBranchAttention(branchOverview)
  const branchAttentionKey = getBranchAttentionKey(branchOverview)
  const visibleBranchAttention = branchAttentionKey !== dismissedBranchAttentionKey
    ? branchAttention
    : null
  const branchAttentionItem = branchAttention?.branchItem
  const branchAttentionDisableReason = branchAttention && branchAttention.action !== 'details'
    ? getBranchWriteDisableReason({
      isCurrent: Boolean(branchAttentionItem?.is_current),
      modifiedCount,
      conflictedCount,
      isSyncing,
      isQueued,
      isSyncChecking,
      isRemoteRefreshing,
      branchOverviewLoading,
      branchOverviewError,
      isBranchOperationBusy: isBranchSwitchBusy,
      branchOperationTarget,
      isCheckedOutElsewhere: Boolean(branchAttentionItem?.is_checked_out_elsewhere),
      worktreePath: String(branchAttentionItem?.worktree_path || '').trim(),
      comparisonState: String(branchAttentionItem?.comparison_state || '').trim(),
    })
    : ''
  const hasLocalChanges = modifiedCount > 0
  const modifiedBadgeClassName = `sync-badge ${hasLocalChanges ? 'sync-badge--warning' : 'sync-badge--neutral'}`
  const repoCornerBadge = isMissingRepoPath
    ? createRepoCornerBadge('danger', 'warning', '目录缺失')
    : getRepoCornerBadge({
      repoStatus,
      isSyncing,
      isQueued,
      modifiedCount,
      aheadCount,
      behindCount,
      needsUpstreamPublish,
      errorMessage: repo.last_error,
      statusIssueMessage,
      comparisonState: status?.comparison_state,
      comparisonError: status?.comparison_error,
      isDetachedHead,
    })
  const repoStateCallout = isMissingRepoPath
    ? createRepoStateCallout('danger', 'warning', '仓库目录不存在，已跳过刷新与同步任务。')
    : getRepoStateCallout({
      repoStatus,
      modifiedCount,
      behindCount,
      needsUpstreamPublish,
      errorMessage: repo.last_error,
      statusIssueMessage,
      statusIssueDetail,
      comparisonState: status?.comparison_state,
      comparisonError: status?.comparison_error,
      isDetachedHead,
    })
  const RepoStateCalloutIcon = repoStateCallout ? getRepoStateIcon(repoStateCallout.icon) : null
  const RepoCornerBadgeIcon = getRepoStateIcon(repoCornerBadge.icon)

  let syncButtonLabel = '同步'
  let syncButtonIcon = <Icons.sync className="icon icon--sm" />
  if (syncButtonMode === SYNC_BUTTON_MODE.syncing) {
    syncButtonLabel = '取消同步'
    syncButtonIcon = <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
  } else if (syncButtonMode === SYNC_BUTTON_MODE.queued) {
    syncButtonLabel = '取消排队'
    syncButtonIcon = <Icons.pause className="icon icon--sm" />
  }

  const commitTs = parseGitCommitDateToMs(latestCommit.date)
  const commitTimeDisplay = commitTs > 0
    ? formatGitCommitLocalTime(latestCommit.date)
    : '无提交'
  const syncTimePresentation = formatSyncTimePresentation(syncTimestamp)
  const syncTimeDisplay = syncTimePresentation.relative
  const isSyncSort = dashboardSortMode === DASHBOARD_REPO_SORT_MODE.syncAsc
    || dashboardSortMode === DASHBOARD_REPO_SORT_MODE.syncDesc
  const isCommitSort = dashboardSortMode === DASHBOARD_REPO_SORT_MODE.commitAsc
    || dashboardSortMode === DASHBOARD_REPO_SORT_MODE.commitDesc
  const primaryTimeLabel = isSyncSort
    ? '上次同步'
    : (!isCommitSort && commitTs <= 0 ? '上次同步' : '提交时间')
  const primaryTimeDisplay = isSyncSort
    ? syncTimeDisplay
    : (!isCommitSort && commitTs <= 0 ? syncTimeDisplay : commitTimeDisplay)
  const primaryTimeTooltip = isSyncSort || (!isCommitSort && commitTs <= 0)
    ? syncTimePresentation.tooltip
    : `${primaryTimeLabel}：${primaryTimeDisplay}`

  const handleSync = () => {
    if (isMissingRepoPath) return
    if (isActionOverlayVisible && !canRequestSyncFromRefreshOverlay) return
    if (isActiveSyncTask) {
      onCancelSync(repo.id)
      return
    }
    const trigger = canRequestSyncFromRefreshOverlay
      ? (isRemoteRefreshing ? 'remote_refresh_overlay' : 'focus_refresh_overlay')
      : 'card_button'
    onSync(repo.id, { trigger })
  }

  const handleViewCommitHistory = (event) => {
    event?.stopPropagation?.()
    if (isMissingRepoPath) return
    onViewCommitHistory?.(repo.id)
  }

  const handleCopyMeta = useCallback((kind, value, event) => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (typeof onCopyRepoMeta !== 'function') return
    onCopyRepoMeta(kind, value)
  }, [onCopyRepoMeta])

  const loadBranchOverview = useCallback(async (force = false) => {
    if (isMissingRepoPath) return null
    const loadedAt = branchOverviewLoadedAtRef.current
    const isFresh = (
      !force
      && branchOverview
      && loadedAt > 0
      && (Date.now() - loadedAt) < BRANCH_OVERVIEW_CACHE_TTL_MS
    )
    if (isFresh) return branchOverview
    if (branchOverviewTaskRef.current) return branchOverviewTaskRef.current

    const task = (async () => {
      setBranchOverviewLoading(true)
      setBranchOverviewError('')
      try {
        const overview = await invoke('get_repo_branch_overview', { path: repo.path })
        const nextOverview = overview || null
        onBranchOverviewChanged?.(repo.id, nextOverview, repo.path)
        branchOverviewLoadedAtRef.current = Date.now()
        return nextOverview
      } catch (error) {
        setBranchOverviewError(getErrorMessage(error))
        return null
      } finally {
        setBranchOverviewLoading(false)
        branchOverviewTaskRef.current = null
      }
    })()

    branchOverviewTaskRef.current = task
    return task
  }, [branchOverview, isMissingRepoPath, onBranchOverviewChanged, repo.id, repo.name, repo.path])

  const handleBranchMetaHoverStart = () => {
    if (isMissingRepoPath) return
    void loadBranchOverview(false)
  }

  // One key-aware lifecycle authority owns path/branch/commit metadata hover. It replaces
  // the previous single shared open/close timer pair, whose cross-key cancellation could
  // strand a surface with the pointer over nothing. See repoMetaHoverController.js.
  const metaHoverBlocked = Boolean(
    commitHistoryOpen || commitHistoryOverlayActive || commitHistoryFlight || commitHistoryHandoff
  )
  const metaHoverBlockedRef = useRef(metaHoverBlocked)
  metaHoverBlockedRef.current = metaHoverBlocked

  // Pointer region = trigger + bridge + card. Focus region = trigger + card only: the bridge
  // is aria-hidden decoration that never carries focusable content. Keeping the two concepts
  // separate stops an unrelated control from being mistaken for hover geometry.
  const metaHoverPointerRegionRef = useRef(null)
  if (metaHoverPointerRegionRef.current === null) {
    metaHoverPointerRegionRef.current = {
      path: { trigger: pathMetaTargetRef, bridge: null, card: pathHoverCardRef },
      branch: { trigger: branchMetaTargetRef, bridge: branchHoverBridgeRef, card: branchHoverCardRef },
      commit: { trigger: commitMetaTargetRef, bridge: commitHoverBridgeRef, card: commitHoverCardRef },
    }
  }
  const metaHoverFocusRegionRef = useRef(null)
  if (metaHoverFocusRegionRef.current === null) {
    metaHoverFocusRegionRef.current = {
      path: { trigger: pathMetaTargetRef, card: pathHoverCardRef },
      branch: { trigger: branchMetaTargetRef, card: branchHoverCardRef },
      commit: { trigger: commitMetaTargetRef, card: commitHoverCardRef },
    }
  }

  const isTargetInsideRegionMap = useCallback((regionMap, key, target) => {
    if (!target || typeof target !== 'object' || typeof target.nodeType !== 'number') return false
    const region = regionMap[key]
    if (!region) return false
    return Object.values(region).some(
      (elementRef) => elementRef?.current && elementRef.current.contains(target)
    )
  }, [])

  const isTargetInsideMetaPointerRegion = useCallback(
    (key, target) => isTargetInsideRegionMap(metaHoverPointerRegionRef.current, key, target),
    [isTargetInsideRegionMap]
  )
  const isTargetInsideMetaFocusRegion = useCallback(
    (key, target) => isTargetInsideRegionMap(metaHoverFocusRegionRef.current, key, target),
    [isTargetInsideRegionMap]
  )

  if (metaHoverPointerTrackerRef.current === null) {
    metaHoverPointerTrackerRef.current = createRepoMetaHoverPointerTracker()
  }

  const metaHoverHandlersRef = useRef(null)
  const metaHoverControllerRef = useRef(null)
  if (metaHoverControllerRef.current === null) {
    metaHoverControllerRef.current = createRepoMetaHoverController({
      openDelayMs: META_HOVER_OPEN_DELAY_MS,
      closeDelayMs: META_HOVER_CLOSE_DELAY_MS,
      isBlocked: () => metaHoverHandlersRef.current.isBlocked(),
      onOpenChange: (key, meta) => metaHoverHandlersRef.current.onOpenChange(key, meta),
      onActivityChange: (value) => metaHoverHandlersRef.current.onActivityChange(value),
      onOpen: (key, meta) => metaHoverHandlersRef.current.onOpen(key, meta),
    })
  }
  const metaHoverController = metaHoverControllerRef.current
  metaHoverHandlersRef.current = {
    isBlocked: () => metaHoverBlockedRef.current,
    onOpenChange: (key) => setOpenMetaHoverCard(key),
    // The controller owns state ownership. Everything the pointer integration owns (last
    // coordinate, lifecycle epoch, scheduled reconcile frame) is dropped the moment the
    // lifecycle leaves the active state, so nothing from a finished hover leaks forward.
    onActivityChange: (value) => {
      metaHoverPointerTrackerRef.current.setActive(value)
      setMetaHoverActive(value)
    },
    onOpen: (key) => {
      if (key === 'branch') handleBranchMetaHoverStart()
    },
  }

  const clearBranchNameTooltipTimer = useCallback(() => {
    clearTimerRef(branchNameTooltipTimerRef)
  }, [])

  const hideBranchNameTooltip = useCallback(() => {
    clearBranchNameTooltipTimer()
    setBranchNameTooltip(null)
  }, [clearBranchNameTooltipTimer])

  // The App-side local pointer-enter authority.
  //
  // Blocked is checked FIRST, before anything is written. The controller refuses a blocked
  // intent on its own, but by then the local fast path would already have seeded a tracker
  // coordinate — and because the controller never went active, no `onActivityChange(false)`
  // follows to clear it. That coordinate would then leak into the NEXT lifecycle (an explicit
  // or focus open, which never seeds) and be used for a post-layout hit test.
  //
  // Order is fixed: blocked guard -> seed -> enter. Seeding after the guard and before
  // `enter()` is what makes the first post-layout hit test of a fresh hover use the real
  // position, so `seedPointerFromLocalEnter` must stay allowed while the tracker is inactive.
  const enterMetaHoverPointerRegion = useCallback((key, event) => {
    if (metaHoverBlockedRef.current) return
    metaHoverPointerTrackerRef.current.seedPointerFromLocalEnter(event)
    metaHoverController.enter(key)
  }, [metaHoverController])

  // The symmetric App-side local leave authority.
  //
  // The tracker coordinate means "the last pointer position still trusted as truth", not "the
  // last position ever seen". Once the pointer leaves its region that coordinate is stale, so
  // it is invalidated BEFORE the leave reaches the controller: the surface may be sitting in
  // its 180ms close delay, and a layout change during that window would otherwise hit-test the
  // old inside position, re-enter the region and cancel the very close that was pending.
  //
  // Order is fixed: invalidate -> controller.leave. The lifecycle itself stays active here
  // (a focus or explicit owner may still hold the surface); only the pointer basis is dropped.
  const leaveMetaHoverPointerRegion = useCallback((key) => {
    metaHoverPointerTrackerRef.current.invalidatePointerFromLocalLeave()
    metaHoverController.leave(key)
  }, [metaHoverController])

  // The App-side dismissal authority. The controller owns *state* ownership; this owns the
  // DOM integration bookkeeping. Every dismissal path goes through here so none of them can
  // forget to reset the pointer epoch and the scheduled reconcile frame.
  const closeAllMetaHover = useCallback((reason) => {
    metaHoverController.closeAll(reason)
    metaHoverPointerTrackerRef.current.reset()
    hideBranchNameTooltip()
  }, [hideBranchNameTooltip, metaHoverController])

  const scheduleBranchNameTooltip = useCallback((branchName, targetElement) => {
    clearBranchNameTooltipTimer()
    setBranchNameTooltip(null)
    const tooltipText = String(branchName || '').trim()
    if (!tooltipText || !targetElement) return

    branchNameTooltipTimerRef.current = setTimeout(() => {
      branchNameTooltipTimerRef.current = null
      if (!targetElement.isConnected) return
      const textElement = targetElement.querySelector?.('.repo-card__branch-row-name') || targetElement
      if (!isTextVisuallyTruncated(textElement)) return
      setBranchNameTooltip({ text: tooltipText, anchor: targetElement })
    }, APP_TOOLTIP_DELAY_MS)
  }, [clearBranchNameTooltipTimer])

  // Region bindings. `enter`/`leave` are key-scoped, and focus ownership is tracked
  // separately so an internal focus move between card buttons never schedules a close.
  const createMetaHoverRegionBindings = (key, { focus = true } = {}) => {
    const bindings = {
      // Pointer events (not mouse events) so the local fast path shares one event family
      // with the document-level reconciliation, and so the first hover after an idle period
      // already seeds the real coordinate instead of reusing the previous lifecycle's.
      onPointerEnter: (event) => enterMetaHoverPointerRegion(key, event),
      onPointerLeave: () => leaveMetaHoverPointerRegion(key),
    }
    if (focus) {
      bindings.onFocusCapture = () => metaHoverController.focusEnter(key)
      bindings.onBlurCapture = (event) => {
        if (isTargetInsideMetaFocusRegion(key, event?.relatedTarget)) return
        // Focus may still be travelling between descendants of this region; re-check on the
        // next microtask before releasing focus ownership.
        Promise.resolve().then(() => {
          const activeElement = typeof document === 'undefined' ? null : document.activeElement
          if (isTargetInsideMetaFocusRegion(key, activeElement)) return
          metaHoverController.focusLeave(key)
        })
      }
    }
    return bindings
  }

  // An already-open surface must close the moment the commit-history overlay takes over.
  useEffect(() => {
    if (!metaHoverBlocked) return
    closeAllMetaHover('commit-history')
  }, [closeAllMetaHover, metaHoverBlocked])

  useEffect(() => {
    const previousOpenMetaHoverCard = previousOpenMetaHoverCardRef.current
    previousOpenMetaHoverCardRef.current = openMetaHoverCard
    if (previousOpenMetaHoverCard === 'branch' && openMetaHoverCard !== 'branch') {
      setBranchSwitchError('')
      setBranchOperationWarning('')
    }
  }, [openMetaHoverCard])

  // ---- pointer reconciliation -------------------------------------------------------
  // The local pointerenter/pointerleave bindings stay the fast path, but they cannot be the
  // only close authority: these surfaces are fixed/portaled and get repositioned by
  // ResizeObserver, requestAnimationFrame and async branch data, so the card can move out
  // from under a stationary pointer without ever delivering a leave event.
  const reconcileMetaHoverPointer = useCallback((target) => {
    const insideKey = REPO_META_HOVER_KEYS.find(
      (key) => isTargetInsideMetaPointerRegion(key, target)
    ) || null
    metaHoverController.reconcile(insideKey)
  }, [isTargetInsideMetaPointerRegion, metaHoverController])

  // Hit-test the last known pointer position after a layout change, because a reposition can
  // deliver no pointer event at all. The tracker refuses to schedule when the lifecycle is
  // inactive or no real coordinate has ever been seen, so a reposition can never hit-test
  // the previous lifecycle's position; the frame itself is fenced by epoch + active.
  const reconcileMetaHoverAfterLayout = useCallback(() => {
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return
    metaHoverPointerTrackerRef.current.scheduleAfterLayout((point) => {
      reconcileMetaHoverPointer(document.elementFromPoint(point.x, point.y))
    })
  }, [reconcileMetaHoverPointer])

  // Installed only while the lifecycle is actually active, so the app never carries a
  // permanent pointer scanner.
  useEffect(() => {
    if (!metaHoverActive) return undefined

    const handlePointer = (event) => {
      const tracker = metaHoverPointerTrackerRef.current
      // Belt and braces: React may not have run this effect's cleanup yet, so an event can
      // still arrive after the lifecycle ended. An inactive lifecycle must neither record a
      // coordinate (that would re-pollute the next hover) nor reconcile (that would stir the
      // next controller state).
      if (!tracker.isActive()) return
      tracker.recordPointerWhileActive(event)
      reconcileMetaHoverPointer(event.target)
    }
    const dismiss = () => closeAllMetaHover('window-inactive')
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') dismiss()
    }

    document.addEventListener('pointermove', handlePointer, true)
    document.addEventListener('pointerover', handlePointer, true)
    window.addEventListener('blur', dismiss)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('pointermove', handlePointer, true)
      document.removeEventListener('pointerover', handlePointer, true)
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [metaHoverActive, metaHoverController, reconcileMetaHoverPointer])

  // Fail closed when a key stops being eligible to render, instead of relying on the portal
  // simply not rendering while the lifecycle still believes it is open.
  useEffect(() => {
    if (!repoPathTruncated) metaHoverController.invalidate('path')
  }, [metaHoverController, repoPathTruncated])

  useEffect(() => {
    if (!latestCommitTruncated) metaHoverController.invalidate('commit')
  }, [latestCommitTruncated, metaHoverController])

  const updateBranchHoverLayout = useCallback(() => {
    hideBranchNameTooltip()
    if (openMetaHoverCard !== 'branch') return
    const hostElement = branchMetaHostRef.current
    const cardElement = branchHoverCardRef.current
    if (!hostElement || !cardElement) return

    const hostRect = hostElement.getBoundingClientRect()
    if (!isRepoCardMoreMenuAnchorVisible(hostRect)) {
      metaHoverController.invalidate('branch')
      return
    }

    const cardRect = cardElement.getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const targetWidth = Math.max(1, Math.min(
      Math.floor(hostRect.width),
      Math.floor(viewportWidth - META_HOVER_VIEWPORT_PADDING)
    ))
    const nextWidth = `${targetWidth}px`
    const floatingHeight = Math.max(cardRect.height, cardElement.scrollHeight || 0)
    const layout = getRepoCardFloatingLayout(
      hostRect,
      {
        width: targetWidth,
        height: floatingHeight,
      },
      {},
      { horizontalAlignment: REPO_CARD_FLOATING_ALIGNMENT.left }
    )
    const bridgeLayout = getRepoCardFloatingHoverBridgeLayout(
      hostRect,
      { width: targetWidth, height: floatingHeight },
      layout
    )
    setBranchHoverCardPlacement(layout.placement)
    setBranchHoverCardStyle((prev) => (
      prev?.top === `${layout.top}px`
        && prev?.left === `${layout.left}px`
        && prev?.maxHeight === `${layout.maxHeight}px`
        && prev?.width === nextWidth
        && prev?.maxWidth === nextWidth
        && prev?.['--repo-branch-hover-max-width'] === nextWidth
        ? prev
        : {
          top: `${layout.top}px`,
          left: `${layout.left}px`,
          width: nextWidth,
          maxWidth: nextWidth,
          maxHeight: `${layout.maxHeight}px`,
          '--repo-branch-hover-max-width': nextWidth,
        }
    ))
    setBranchHoverBridgeStyle((prev) => {
      const next = bridgeLayout
        ? {
          top: `${bridgeLayout.top}px`,
          left: `${bridgeLayout.left}px`,
          width: `${bridgeLayout.width}px`,
          height: `${bridgeLayout.height}px`,
        }
        : null
      return prev?.top === next?.top
        && prev?.left === next?.left
        && prev?.width === next?.width
        && prev?.height === next?.height
        ? prev
        : next
    })
    reconcileMetaHoverAfterLayout()
  }, [hideBranchNameTooltip, metaHoverController, openMetaHoverCard, reconcileMetaHoverAfterLayout])

  // Unmount safety: cancel every pending timer, frame and pointer fact.
  // `closeAllMetaHover` uses the controller's closeAll rather than destroy on purpose —
  // React StrictMode runs effect cleanup once on the throwaway first mount, and a permanently
  // destroyed controller would leave hover dead for the rest of the session.
  useEffect(() => () => {
    closeAllMetaHover('unmount')
  }, [closeAllMetaHover])

  useEffect(() => {
    if (openMetaHoverCard !== 'branch') hideBranchNameTooltip()
  }, [hideBranchNameTooltip, openMetaHoverCard])

  const updateCommitHoverLayout = useCallback(() => {
    if (openMetaHoverCard !== 'commit') return
    const hostElement = commitMetaHostRef.current
    const cardElement = commitHoverCardRef.current
    if (!hostElement || !cardElement) return

    const hostRect = hostElement.getBoundingClientRect()
    if (!isRepoCardMoreMenuAnchorVisible(hostRect)) {
      metaHoverController.invalidate('commit')
      return
    }

    const cardRect = cardElement.getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const targetWidth = Math.max(1, Math.min(
      Math.floor(hostRect.width),
      Math.floor(viewportWidth - META_HOVER_VIEWPORT_PADDING)
    ))
    const nextWidth = `${targetWidth}px`
    const floatingHeight = Math.max(cardRect.height, cardElement.scrollHeight || 0)
    const layout = getRepoCardFloatingLayout(
      hostRect,
      {
        width: targetWidth,
        height: floatingHeight,
      },
      {},
      { horizontalAlignment: REPO_CARD_FLOATING_ALIGNMENT.left }
    )
    const bridgeLayout = getRepoCardFloatingHoverBridgeLayout(
      hostRect,
      { width: targetWidth, height: floatingHeight },
      layout
    )
    setCommitHoverCardPlacement(layout.placement)
    setCommitHoverCardStyle((prev) => (
      prev?.top === `${layout.top}px`
        && prev?.left === `${layout.left}px`
        && prev?.maxHeight === `${layout.maxHeight}px`
        && prev?.width === nextWidth
        && prev?.maxWidth === nextWidth
        ? prev
        : {
          top: `${layout.top}px`,
          left: `${layout.left}px`,
          width: nextWidth,
          maxWidth: nextWidth,
          maxHeight: `${layout.maxHeight}px`,
        }
    ))
    setCommitHoverBridgeStyle((prev) => {
      const next = bridgeLayout
        ? {
          top: `${bridgeLayout.top}px`,
          left: `${bridgeLayout.left}px`,
          width: `${bridgeLayout.width}px`,
          height: `${bridgeLayout.height}px`,
        }
        : null
      return prev?.top === next?.top
        && prev?.left === next?.left
        && prev?.width === next?.width
        && prev?.height === next?.height
        ? prev
        : next
    })
    reconcileMetaHoverAfterLayout()
  }, [metaHoverController, openMetaHoverCard, reconcileMetaHoverAfterLayout])

  useLayoutEffect(() => {
    if (openMetaHoverCard !== 'branch') {
      setBranchHoverCardPlacement(REPO_CARD_MORE_MENU_PLACEMENT.bottom)
      setBranchHoverCardStyle(null)
      setBranchHoverBridgeStyle(null)
      return undefined
    }

    updateBranchHoverLayout()
    const animationFrame = window.requestAnimationFrame(updateBranchHoverLayout)
    window.addEventListener('resize', updateBranchHoverLayout)
    window.addEventListener('scroll', updateBranchHoverLayout, true)

    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateBranchHoverLayout)
      if (branchMetaHostRef.current) observer.observe(branchMetaHostRef.current)
      if (branchHoverCardRef.current) observer.observe(branchHoverCardRef.current)
    }

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', updateBranchHoverLayout)
      window.removeEventListener('scroll', updateBranchHoverLayout, true)
      if (observer) observer.disconnect()
    }
  }, [
    branchOverview,
    branchOverviewError,
    branchOverviewLoading,
    branchSwitchError,
    branchOperationPhase,
    branchOperationTarget,
    branchOperationWarning,
    canSwitchBranch,
    openMetaHoverCard,
    updateBranchHoverLayout,
  ])

  useLayoutEffect(() => {
    if (openMetaHoverCard !== 'commit') {
      setCommitHoverCardPlacement(REPO_CARD_MORE_MENU_PLACEMENT.bottom)
      setCommitHoverCardStyle(null)
      setCommitHoverBridgeStyle(null)
      return undefined
    }

    updateCommitHoverLayout()
    const animationFrame = window.requestAnimationFrame(updateCommitHoverLayout)
    window.addEventListener('resize', updateCommitHoverLayout)
    window.addEventListener('scroll', updateCommitHoverLayout, true)

    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateCommitHoverLayout)
      if (commitMetaHostRef.current) observer.observe(commitMetaHostRef.current)
      if (commitHoverCardRef.current) observer.observe(commitHoverCardRef.current)
    }

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', updateCommitHoverLayout)
      window.removeEventListener('scroll', updateCommitHoverLayout, true)
      if (observer) observer.disconnect()
    }
  }, [openMetaHoverCard, updateCommitHoverLayout])

  const handleBranchOperation = useCallback(async (operation, branchItem, options = {}) => {
    if (isMissingRepoPath) return
    if (branchOperationInFlightRef.current) return
    const displayName = String(branchItem?.name || '').trim()
    const localName = String(branchItem?.local_name || branchItem?.localName || '').trim()
    const upstream = String(branchItem?.upstream || '').trim()
    const rebindUpstream = String(branchItem?.rebind_upstream || branchItem?.rebindUpstream || '').trim()
    const isRemoteOnlyBranch = Boolean(branchItem?.is_remote_only || branchItem?.isRemoteOnly)
    const isRemoteRow = String(branchItem?.identity || '').trim().startsWith('remote:')
    const target = operation === 'track'
      ? (upstream || displayName)
      : operation === 'delete' && (isRemoteOnlyBranch || isRemoteRow)
        ? (upstream || displayName)
      : (localName || displayName)
    if (!target) return
    if (operation === 'delete') {
      if (isSyncing || isQueued) return
    } else if (!canSwitchBranch) {
      return
    }

    branchOperationInFlightRef.current = true
    setBranchSwitchError('')
    setBranchOperationWarning('')
    setBranchOperationTarget(target)
    setBranchOperationPhase(operation === 'delete' ? BRANCH_SWITCH_PHASE.deleting : BRANCH_SWITCH_PHASE.switching)

    let operationError = null
    let operationResult = null
    let operationWarning = ''
    let branchOperationFeedbackMessage = ''
    const appendBranchOperationFeedback = (message) => {
      const normalizedMessage = String(message || '').trim()
      if (!normalizedMessage) return
      branchOperationFeedbackMessage = branchOperationFeedbackMessage
        ? `${branchOperationFeedbackMessage}；${normalizedMessage}`
        : normalizedMessage
    }
    try {
      let payload
      let commandName = 'switch_repo_branch'
      if (operation === 'track') {
        payload = {
          path: repo.path,
          branch: localName,
          remoteBranch: upstream || displayName,
        }
      } else if (operation === 'switch-update') {
        commandName = 'switch_and_update_repo_branch'
        payload = {
          path: repo.path,
          branch: localName || displayName,
        }
      } else if (operation === 'rebind') {
        commandName = 'rebind_repo_branch_upstream'
        payload = {
          path: repo.path,
          branch: localName || displayName,
          upstream: rebindUpstream,
        }
      } else if (operation === 'unset-upstream') {
        commandName = 'unset_repo_branch_upstream'
        payload = {
          path: repo.path,
          branch: localName || displayName,
        }
      } else if (operation === 'delete') {
        const deleteRequest = buildBranchDeleteRequest(
          normalizeBranchDeleteTarget(branchItem),
          {
            includeRemote: options?.deleteRemote === true,
            forceDelete: options?.forceDelete === true,
          }
        )
        if (!deleteRequest) throw new Error('没有可删除的本地或远端分支引用。')
        // One delete command serves safe and forced deletes; the request carries forceDelete.
        commandName = 'delete_repo_branches_batch'
        payload = { path: repo.path, requests: [deleteRequest] }
      } else {
        payload = {
          path: repo.path,
          branch: localName || displayName,
        }
      }

      operationResult = await invoke(commandName, payload)
    } catch (error) {
      operationError = error
    }

    operationWarning = String(operationResult?.warning || '').trim()
    if (operation === 'delete' && Array.isArray(operationResult?.results)) {
      const failedItems = operationResult.results.filter((item) => !item?.success)
      if (failedItems.length && !operationError) {
        operationError = failedItems
          .map((item) => item?.message || item?.warning)
          .filter(Boolean)
          .join('；') || '分支删除失败。'
      }
      const itemWarnings = operationResult.results
        .map((item) => item?.warning)
        .filter(Boolean)
        .join('；')
      if (!operationWarning && itemWarnings) operationWarning = itemWarnings
    }
    if (operationWarning) {
      appendBranchOperationFeedback(operationWarning)
      setBranchOperationWarning(branchOperationFeedbackMessage)
    }
    if (operationError) {
      appendAppErrorLogEntries([{
        scope: `branch-${operation}`,
        repoId: repo.id,
        repoName: repo.name || repo.id,
        message: getErrorMessage(operationError),
      }])
    }

    try {
      branchOverviewLoadedAtRef.current = 0
      setBranchOperationPhase(BRANCH_SWITCH_PHASE.refreshing)
      if (typeof onBranchChanged === 'function') {
        try {
          const refreshResult = await onBranchChanged(repo.id, {
            remoteAlreadyFetched: operationResult?.remote_fetched === true,
          })
          if (refreshResult?.warning) {
            appendBranchOperationFeedback(`分支操作完成，但状态刷新异常：${refreshResult.warning}`)
            setBranchOperationWarning(branchOperationFeedbackMessage)
          }
        } catch (error) {
          console.warn(`切换分支后刷新仓库状态失败: ${repo.path}`, error)
          const warningMessage = getErrorMessage(error)
          appendBranchOperationFeedback(`分支操作完成，但状态刷新异常：${warningMessage}`)
          setBranchOperationWarning(branchOperationFeedbackMessage)
        }
      }
      await loadBranchOverview(true)
      if (operationError) {
        branchOperationFeedbackMessage = getErrorMessage(operationError)
        setBranchSwitchError(branchOperationFeedbackMessage)
      }
    } catch (refreshError) {
      const refreshMessage = getErrorMessage(refreshError)
      if (operationError) {
        branchOperationFeedbackMessage = `${getErrorMessage(operationError)}；状态刷新失败：${refreshMessage}`
      } else {
        appendBranchOperationFeedback(`状态刷新失败：${refreshMessage}`)
      }
      setBranchSwitchError(branchOperationFeedbackMessage)
    } finally {
      if (branchOperationFeedbackMessage) {
        onBranchOperationFeedback?.({
          title: operationError
            ? '分支操作未完成'
            : operationWarning
              ? '分支操作部分完成'
              : '分支状态刷新异常',
          message: branchOperationFeedbackMessage,
          tone: operationError ? 'danger' : 'warning',
        })
      }
      setBranchOperationPhase(BRANCH_SWITCH_PHASE.idle)
      setBranchOperationTarget('')
      branchOperationInFlightRef.current = false
    }

    return {
      success: !operationError && !operationWarning,
      feedbackMessage: branchOperationFeedbackMessage,
    }
  }, [
    canSwitchBranch,
    isQueued,
    isSyncing,
    isMissingRepoPath,
    loadBranchOverview,
    onBranchChanged,
    onBranchOperationFeedback,
    repo.id,
    repo.name,
    repo.path,
  ])

  const handleRequestBranchDelete = useCallback((branchItem) => {
    const branchMeta = normalizeBranchOverviewRow(branchItem)
    const upstreamGone = Boolean(branchItem?.upstream_gone || branchItem?.upstreamGone)
    const remoteDeleteOnly = branchMeta.isRemoteRow || branchMeta.isRemoteOnly
    const remoteBranchName = remoteDeleteOnly
      ? (branchMeta.upstream || branchMeta.rowName)
      : (upstreamGone ? '' : branchMeta.upstream)
    const branchName = remoteDeleteOnly
      ? (remoteBranchName || branchMeta.rowName)
      : (branchMeta.localName || branchMeta.rowName)
    if (!branchName || branchName === '-') return

    setBranchDeleteConfirm({
      branchItem,
      branchName,
      remoteBranchName,
      remoteRequired: remoteDeleteOnly,
    })
    setBranchDeletePresent(true)
  }, [])

  const handleConfirmBranchDelete = useCallback(async ({ deleteRemote, forceDelete } = {}) => {
    const branchItem = branchDeleteConfirm?.branchItem
    if (!branchItem) return
    const branchName = branchDeleteConfirm.branchName
    const remoteBranchName = branchDeleteConfirm.remoteBranchName
    const remoteRequired = branchDeleteConfirm.remoteRequired
    const forced = forceDelete === true
    setBranchDeleteSubmitting(true)
    try {
      const deleteResult = await handleBranchOperation('delete', branchItem, { deleteRemote, forceDelete: forced })
      setBranchDeletePresent(false)

      if (!deleteResult?.success || deleteResult.feedbackMessage) return

      const message = remoteRequired
        ? `远程分支 ${branchName} 已删除。`
        : deleteRemote && remoteBranchName
          ? `本地分支 ${branchName} 和远程分支 ${remoteBranchName} 已删除。`
          : `本地分支 ${branchName} 已${forced ? '强制删除' : '删除'}。`
      onBranchOperationFeedback?.({
        title: forced ? '分支强制删除成功' : '分支删除成功',
        message,
        tone: 'success',
      })
    } finally {
      setBranchDeleteSubmitting(false)
    }
  }, [branchDeleteConfirm, handleBranchOperation, onBranchOperationFeedback])

  const handleBranchAttentionAction = useCallback(() => {
    if (!branchAttention) return
    if (branchAttention.action === 'details' || branchAttentionDisableReason) {
      // This is a deliberate "show me the branch panel" action, NOT a focus event: the button
      // is not part of the branch hover region, so it must never forge focus ownership.
      // Explicit ownership is released as soon as the pointer or real focus enters the
      // branch region, or by any of the normal dismissal paths.
      metaHoverController.openExplicit('branch')
      return
    }
    void handleBranchOperation(branchAttention.action, branchAttention.branchItem)
  }, [
    branchAttention,
    branchAttentionDisableReason,
    handleBranchOperation,
    metaHoverController,
  ])

  const handleDismissBranchAttention = useCallback((event) => {
    event.stopPropagation()
    if (!branchAttentionKey) return
    onDismissBranchAttention?.(repo.id, branchAttentionKey)
  }, [branchAttentionKey, onDismissBranchAttention, repo.id])

  useEffect(() => {
    setBranchOverviewLoading(false)
    setBranchOverviewError('')
    setBranchSwitchError('')
    setBranchOperationPhase(BRANCH_SWITCH_PHASE.idle)
    setBranchOperationTarget('')
    setBranchOperationWarning('')
    setBranchDeletePresent(false)
    setBranchDeleteConfirm(null)
    setBranchDeleteSubmitting(false)
    branchOperationInFlightRef.current = false
    closeAllMetaHover('repo-identity-changed')
    setBranchHoverCardPlacement(REPO_CARD_MORE_MENU_PLACEMENT.bottom)
    setBranchHoverCardStyle(null)
    setBranchHoverBridgeStyle(null)
    setCommitHoverCardPlacement(REPO_CARD_MORE_MENU_PLACEMENT.bottom)
    setCommitHoverCardStyle(null)
    setCommitHoverBridgeStyle(null)
    clearBranchNameTooltipTimer()
    setBranchNameTooltip(null)
    branchOverviewTaskRef.current = null
  }, [clearBranchNameTooltipTimer, metaHoverController, repo.path])

  useLayoutEffect(() => {
    branchOverviewLoadedAtRef.current = branchOverviewSnapshot ? Date.now() : 0
  }, [branchOverviewSnapshot, repo.path])

  useEffect(() => {
    const settlePhase = isSyncing ? SYNC_VISUAL_PHASE.active : SYNC_VISUAL_PHASE.idle
    const delay = isSyncing ? SYNC_VISUAL_DELAY_MS.enterToActive : SYNC_VISUAL_DELAY_MS.leaveToIdle
    setSyncVisualPhase((prev) => getImmediateSyncVisualPhase(isSyncing, prev))
    const timer = setTimeout(() => setSyncVisualPhase(settlePhase), delay)
    return () => clearTimeout(timer)
  }, [isSyncing])

  const openMenu = useCallback(() => {
    setMenuAnimationReady(false)
    setMenuOpen(true)
  }, [])

  const closeMenu = useCallback(() => {
    setMenuAnimationReady(false)
    setMenuOpen(false)
    setMoreMenuStyle(null)
  }, [])

  useEffect(() => {
    if ((!isActionOverlayVisible && !isMissingRepoPath && !commitHistoryOverlayActive) || !menuOpen) return
    closeMenu()
  }, [commitHistoryOverlayActive, isActionOverlayVisible, isMissingRepoPath, menuOpen, closeMenu])

  useEffect(() => {
    if (!menuOpen) return
    const handlePointerDown = (event) => {
      const target = event.target
      const isInsideActionArea = moreActionAreaRef.current?.contains(target)
      const isInsideMenu = moreMenuRef.current?.contains(target)
      if (!isInsideActionArea && !isInsideMenu) {
        closeMenu()
      }
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen, closeMenu])

  const updateMoreMenuLayout = useCallback(() => {
    const anchorElement = moreButtonRef.current
    const menuElement = moreMenuRef.current
    if (!anchorElement || !menuElement) return

    const anchorRect = anchorElement.getBoundingClientRect()
    if (!isRepoCardMoreMenuAnchorVisible(anchorRect)) {
      closeMenu()
      return
    }

    const menuRect = menuElement.getBoundingClientRect()
    const layout = getRepoCardMoreMenuLayout(anchorRect, {
      width: Math.max(menuRect.width, menuElement.scrollWidth || 0),
      height: Math.max(menuRect.height, menuElement.scrollHeight || 0),
    })
    setMoreMenuPlacement(layout.placement)
    setMoreMenuStyle((prev) => {
      const next = {
        top: `${layout.top}px`,
        left: `${layout.left}px`,
        maxHeight: `${layout.maxHeight}px`,
      }
      return prev?.top === next.top
        && prev?.left === next.left
        && prev?.maxHeight === next.maxHeight
        ? prev
        : next
    })
  }, [closeMenu])

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMoreMenuPlacement(REPO_CARD_MORE_MENU_PLACEMENT.bottom)
      setMoreMenuStyle(null)
      return
    }

    updateMoreMenuLayout()
    const animationFrame = window.requestAnimationFrame(() => {
      updateMoreMenuLayout()
      setMenuAnimationReady(true)
    })
    window.addEventListener('resize', updateMoreMenuLayout)
    window.addEventListener('scroll', updateMoreMenuLayout, true)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', updateMoreMenuLayout)
      window.removeEventListener('scroll', updateMoreMenuLayout, true)
    }
  }, [menuOpen, updateMoreMenuLayout])

  const toggleMenu = () => {
    if (isActionOverlayVisible || commitHistoryOverlayActive) return
    if (menuOpen) {
      closeMenu()
      return
    }
    openMenu()
  }
  const runMoreAction = (action) => {
    if (isActionOverlayVisible || commitHistoryOverlayActive) return
    closeMenu()
    action()
  }

  const handleCardSelection = (event) => {
    if (!batchMode) return
    if (event.defaultPrevented) return
    if (isInteractiveEventFromChild(event)) return
    onToggleSelect(repo.id)
  }

  const repoCardClassName = [
    buildRepoCardClassName({
      batchMode,
      selected,
      syncVisualPhase,
      menuOpen,
      commitHistoryOpen,
      commitHistoryFlight,
      commitHistoryHandoff,
    }),
    isMissingRepoPath ? 'repo-card--path-missing' : '',
  ].filter(Boolean).join(' ')
  const handoffHeight = Number(commitHistoryHandoffHeight)
  const handoffSourceHeight = Number(commitHistoryHandoffSourceHeight)
  const hasHandoffGeometry = commitHistoryHandoff
    && Number.isFinite(handoffHeight)
    && handoffHeight > 0
    && Number.isFinite(handoffSourceHeight)
    && handoffSourceHeight > 0
  const resolvedHandoffSourceHeight = hasHandoffGeometry
    ? Math.max(handoffHeight, handoffSourceHeight)
    : null
  const repoCardStyle = hasHandoffGeometry
    ? {
      '--commit-history-handoff-height': `${handoffHeight}px`,
      '--commit-history-handoff-source-height': `${resolvedHandoffSourceHeight}px`,
      '--commit-history-handoff-reserve-height': `${Math.max(0, resolvedHandoffSourceHeight - handoffHeight)}px`,
    }
    : undefined
  const pathMetaHostClassName = [
    'meta-item',
    'meta-item--overlay-clearance',
    'repo-card__path',
    'repo-card__meta-hover-host',
    openMetaHoverCard === 'path' ? 'repo-card__meta-hover-host--open' : '',
  ].filter(Boolean).join(' ')
  const branchMetaHostClassName = [
    'meta-item',
    'repo-card__branch-meta',
    'repo-card__meta-hover-host',
    openMetaHoverCard === 'branch' ? 'repo-card__meta-hover-host--open' : '',
  ].filter(Boolean).join(' ')
  const commitMetaHostClassName = [
    'meta-item',
    'repo-card__latest-commit',
    'repo-card__meta-hover-host',
    openMetaHoverCard === 'commit' ? 'repo-card__meta-hover-host--open' : '',
  ].filter(Boolean).join(' ')
  // A key that cannot render a hover card must not accept hover intent either, otherwise the
  // lifecycle would report an "open" surface with no DOM behind it. Eligibility loss while
  // already open is still handled by the invalidate() effects above.
  const pathMetaHostBindings = repoPathTruncated ? createMetaHoverRegionBindings('path') : {}
  const branchMetaHostBindings = createMetaHoverRegionBindings('branch')
  const commitMetaHostBindings = latestCommitTruncated ? createMetaHoverRegionBindings('commit') : {}
  const pathMetaCardBindings = repoPathTruncated ? createMetaHoverRegionBindings('path', { focus: false }) : {}
  const branchMetaCardBindings = createMetaHoverRegionBindings('branch')
  const commitMetaCardBindings = latestCommitTruncated ? createMetaHoverRegionBindings('commit') : {}
  const moreMenuClassName = [
    'repo-card__more-menu',
    `repo-card__more-menu--${moreMenuPlacement}`,
    menuAnimationReady ? 'repo-card__more-menu--animating' : 'repo-card__more-menu--preparing',
  ].join(' ')
  const branchHoverCardClassName = [
    'repo-card__meta-hover-card--branch',
    'repo-card__meta-hover-card--fixed',
    `repo-card__meta-hover-card--${branchHoverCardPlacement}`,
    branchHoverCardStyle ? 'repo-card__meta-hover-card--fixed-ready' : 'repo-card__meta-hover-card--fixed-preparing',
  ].join(' ')
  const commitHoverCardClassName = [
    'repo-card__meta-hover-card--commit',
    'repo-card__meta-hover-card--fixed',
    `repo-card__meta-hover-card--${commitHoverCardPlacement}`,
    commitHoverCardStyle ? 'repo-card__meta-hover-card--fixed-ready' : 'repo-card__meta-hover-card--fixed-preparing',
  ].join(' ')

  return (
    <div
      className={repoCardClassName}
      style={repoCardStyle}
      data-repo-card-id={repo.id}
      aria-hidden={commitHistoryTransitionHidden || commitHistoryClosing ? 'true' : undefined}
      inert={commitHistoryTransitionHidden || commitHistoryClosing || undefined}
      onClick={handleCardSelection}
    >
      <div className={`repo-card__summary ${showAutoScriptIndicator ? 'repo-card__summary--with-script' : 'repo-card__summary--badge-only'}`}>
        <div className="repo-card__summary-main">
          <div className="repo-card__header">
            <div className="repo-card__name">
              {batchMode ? (
                <button
                  className={`repo-select ${selected ? 'repo-select--active' : ''}`}
                  onClick={() => onToggleSelect(repo.id)}
                  data-app-tooltip={selected ? '取消选择' : '选择仓库'}
                  aria-label={selected ? `取消选择 ${repo.name}` : `选择 ${repo.name}`}
                >
                  {selected ? '✓' : ''}
                </button>
              ) : null}
              <span className={`status-dot status-dot--${statusDotType}`}></span>
              {repo.name}
            </div>
          </div>

          <div className="repo-card__meta">
            <div
              className={pathMetaHostClassName}
            >
              <div
                className="repo-card__meta-hover-target"
                ref={pathMetaTargetRef}
                {...pathMetaHostBindings}
              >
                <Icons.folder className="icon icon--meta" />
                <span ref={repoPathTextRef} className="meta-value repo-card__path-text">{repo.path}</span>
              </div>
              <button
                type="button"
                className="repo-card__meta-copy-btn"
                onClick={(event) => handleCopyMeta('path', repo.path, event)}
                data-app-tooltip={`复制路径：${repo.path}`}
                aria-label={`复制 ${repo.name} 的路径`}
              >
                <Icons.copy className="icon icon--sm" />
              </button>
              {repoPathTruncated ? (
                <RepoMetaHoverCard
                  ref={pathHoverCardRef}
                  title="仓库路径"
                  ariaLabel="仓库路径完整内容"
                  className="repo-card__meta-hover-card--path"
                  {...pathMetaCardBindings}
                >
                  <div className="repo-card__meta-hover-card-body">{repo.path}</div>
                </RepoMetaHoverCard>
              ) : null}
            </div>
            <div
              ref={branchMetaHostRef}
              className={branchMetaHostClassName}
            >
              <div
                className="repo-card__meta-hover-target"
                ref={branchMetaTargetRef}
                {...branchMetaHostBindings}
              >
                <Icons.branch className="icon icon--meta" />
                <span className="meta-value repo-card__branch-text">{branchDisplayName}</span>
              </div>
              <button
                type="button"
                className="repo-card__meta-copy-btn"
                onClick={(event) => handleCopyMeta('branch', branchDisplayName, event)}
                data-app-tooltip={`复制分支：${branchDisplayName}`}
                aria-label={`复制 ${repo.name} 的当前分支`}
              >
                <Icons.copy className="icon icon--sm" />
              </button>
              {openMetaHoverCard === 'branch' && branchHoverBridgeStyle && typeof document !== 'undefined' ? createPortal((
                <div
                  className="repo-card__meta-hover-bridge"
                  ref={branchHoverBridgeRef}
                  style={branchHoverBridgeStyle}
                  aria-hidden="true"
                  {...branchMetaCardBindings}
                />
              ), document.body) : null}
              {openMetaHoverCard === 'branch' && typeof document !== 'undefined' ? createPortal((
                <RepoMetaHoverCard
                  ref={branchHoverCardRef}
                  title="分支总览"
                  ariaLabel="仓库分支总览"
                  className={branchHoverCardClassName}
                  style={branchHoverCardStyle || undefined}
                  {...branchMetaCardBindings}
                >
                  <BranchManagementHoverAction
                    repo={repo}
                    onOpenAccepted={() => {
                      closeAllMetaHover('branch-opened')
                      setBranchHoverCardStyle(null)
                      setBranchHoverBridgeStyle(null)
                      hideBranchNameTooltip()
                    }}
                  />
                {branchOverviewLoading ? (
                  <div className="repo-card__branch-hover-state">读取分支信息中...</div>
                ) : null}

                {!branchOverviewLoading && branchOverviewError ? (
                  <div className="repo-card__branch-hover-state repo-card__branch-hover-state--error">
                    {branchOverviewError}
                  </div>
                ) : null}

                {!branchOverviewLoading && !branchOverviewError && branchOverview ? (
                  <>
                    <div className="repo-card__branch-hover-summary">
                      <span>本地 {branchOverview.local_branch_count || 0}</span>
                      <span>远端 {branchOverview.remote_branch_count || 0}</span>
                      {branchAheadCount > 0 ? <span>待推送 {branchAheadCount}</span> : null}
                      {branchBehindCount > 0 ? <span>落后 {branchBehindCount}</span> : null}
                      {branchDivergentCount > 0 ? <span>有分叉 {branchDivergentCount}</span> : null}
                      {branchRemoteOnlyCount > 0 ? <span>仅远端 {branchRemoteOnlyCount}</span> : null}
                      {branchUpstreamGoneCount > 0 ? <span>上游失效 {branchUpstreamGoneCount}</span> : null}
                      {branchComparisonErrorCount > 0 ? <span>读取失败 {branchComparisonErrorCount}</span> : null}
                      {branchCheckedOutElsewhereCount > 0 ? <span>其他 worktree {branchCheckedOutElsewhereCount}</span> : null}
                    </div>
                    <div className="repo-card__branch-hover-list" onScroll={hideBranchNameTooltip}>
                      {visibleBranchOverviewList.length === 0 ? (
                        <div className="repo-card__branch-hover-state">暂无可展示分支</div>
                      ) : null}
                      {visibleBranchOverviewList.map((branchItem) => {
                        const ahead = Math.max(0, Number(branchItem?.ahead) || 0)
                        const behind = Math.max(0, Number(branchItem?.behind) || 0)
                        const branchMeta = normalizeBranchOverviewRow(branchItem)
                        const isRemoteOnly = branchMeta.isRemoteOnly
                        const isCurrent = Boolean(branchItem?.is_current)
                        const hasLocal = branchMeta.hasLocal
                        const isCheckedOutElsewhere = Boolean(branchItem?.is_checked_out_elsewhere || branchItem?.isCheckedOutElsewhere)
                        const isRemoteRow = branchMeta.isRemoteRow
                        const rowName = branchMeta.rowName
                        const localName = branchMeta.localName
                        const comparisonState = String(branchItem?.comparison_state || branchItem?.comparisonState || '').trim()
                        const upstreamGone = Boolean(branchItem?.upstream_gone || branchItem?.upstreamGone)
                        const rebindUpstream = String(branchItem?.rebind_upstream || branchItem?.rebindUpstream || '').trim()
                        const worktreePath = String(branchItem?.worktree_path || branchItem?.worktreePath || '').trim()
                        const isOperationTarget = branchOperationTarget === rowName
                          || branchOperationTarget === localName
                          || branchOperationTarget === branchItem?.upstream
                        const rowStatus = getBranchRowStatus({
                          ahead,
                          behind,
                          isRemoteOnly,
                          comparisonState,
                          upstreamGone,
                          isCheckedOutElsewhere,
                        })
                        const rowStatusText = getBranchSwitchRowStatusText(
                          rowStatus.text,
                          isOperationTarget,
                          branchOperationPhase
                        )
                        const baseDisableReason = getBranchWriteDisableReason({
                          isCurrent,
                          modifiedCount,
                          conflictedCount,
                          isSyncing,
                          isQueued,
                          isSyncChecking,
                          isRemoteRefreshing,
                          branchOverviewLoading,
                          branchOverviewError,
                          isBranchOperationBusy: isBranchSwitchBusy,
                          branchOperationTarget,
                          isCheckedOutElsewhere,
                          worktreePath,
                          comparisonState,
                        })
                        const localSwitchReason = baseDisableReason
                          || (isRemoteRow ? '远端引用已有对应本地分支，请在本地分支行操作。' : '')
                          || (!localName && !isRemoteOnly ? '本地分支名称无效。' : '')
                        const trackReason = baseDisableReason
                          || (hasLocal && isRemoteRow ? '本地分支已存在，请在本地分支行操作。' : '')
                          || (!branchItem?.upstream && isRemoteOnly ? '远端分支引用无效。' : '')
                        const rebindReason = baseDisableReason || (!rebindUpstream ? '没有唯一同名远端分支可重新绑定。' : '')
                        const unsetReason = baseDisableReason || (!localName ? '本地分支名称无效。' : '')
                        const remoteBranchName = (isRemoteRow || isRemoteOnly)
                          ? (branchMeta.upstream || rowName)
                          : (upstreamGone ? '' : branchMeta.upstream)
                        const hasLocalDeleteTarget = !isRemoteRow && !isRemoteOnly && Boolean(localName)
                        const hasRemoteDeleteTarget = Boolean(remoteBranchName)
                        const deleteReason = (isCurrent ? '不能删除当前分支。' : '')
                          || (isSyncing || isQueued ? '仓库正在同步或排队，暂不能删除分支。' : '')
                          || (isSyncChecking ? '正在检查同步前条件，暂不能删除分支。' : '')
                          || (isRemoteRefreshing ? '正在获取远程状态，暂不能删除分支。' : '')
                          || (branchOverviewLoading ? '正在获取分支状态，暂不能删除分支。' : '')
                          || (branchOverviewError ? '分支状态读取失败，暂不能删除分支。' : '')
                          || (isBranchSwitchBusy ? (branchOperationTarget ? `正在处理 ${branchOperationTarget}，请稍候。` : '正在处理其他分支，请稍候。') : '')
                          || (isCheckedOutElsewhere ? (worktreePath ? `该分支已在另一个 worktree 检出: ${worktreePath}` : '该分支已在另一个 worktree 检出。') : '')
                          || (comparisonState === 'error' ? '分支状态读取失败，请刷新后重试。' : '')
                          || (!hasLocalDeleteTarget && !hasRemoteDeleteTarget ? '没有可删除的分支引用。' : '')
                        const canSwitchLocal = !localSwitchReason && !isRemoteOnly && !isCurrent && !isRemoteRow
                        const canTrackRemote = !trackReason && isRemoteOnly && !hasLocal
                        const canRebind = !rebindReason && upstreamGone && !isRemoteOnly
                        const canUnsetUpstream = !unsetReason && upstreamGone && !isRemoteOnly
                        const canDeleteBranch = !deleteReason
                        const branchRowClassName = [
                          'repo-card__branch-row',
                          isCurrent ? 'repo-card__branch-row--current' : '',
                          (canSwitchLocal || canTrackRemote || canRebind || canUnsetUpstream || canDeleteBranch) ? '' : 'repo-card__branch-row--disabled',
                        ].filter(Boolean).join(' ')

                        return (
                          <div
                            className={branchRowClassName}
                            key={String(branchItem?.identity || branchItem?.full_ref || rowName)}
                          >
                            <div className="repo-card__branch-row-main">
                              <span
                                className="repo-card__branch-row-name-wrap"
                                aria-label={rowName}
                                onMouseEnter={(event) => scheduleBranchNameTooltip(rowName, event.currentTarget)}
                                onMouseLeave={hideBranchNameTooltip}
                              >
                                <span className="repo-card__branch-row-name">{rowName}</span>
                              </span>
                            </div>
                            <div className="repo-card__branch-row-actions">
                              <div className="repo-card__branch-row-tags">
                                {isCurrent ? <span className="repo-card__branch-tag repo-card__branch-tag--current">当前</span> : null}
                                {isRemoteRow || isRemoteOnly ? <span className="repo-card__branch-tag repo-card__branch-tag--remote">远端</span> : null}
                              </div>
                              <span className={`repo-card__branch-row-state repo-card__branch-row-state--${rowStatus.tone}`}>
                                {rowStatusText}
                              </span>
                              {!isCurrent && !isRemoteOnly ? (
                                <button
                                  type="button"
                                  className="repo-card__branch-row-action"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (canSwitchLocal) void handleBranchOperation('switch', branchItem)
                                  }}
                                  disabled={!canSwitchLocal}
                                  data-app-tooltip={canSwitchLocal ? `切换到 ${rowName}` : undefined}
                                  aria-label={canSwitchLocal ? `切换到分支 ${rowName}` : `不能切换到分支 ${rowName}：${localSwitchReason}`}
                                >
                                  <BranchSwitchIcon className="repo-card__branch-row-action-icon" />
                                  切换
                                </button>
                              ) : null}
                              {isRemoteOnly ? (
                                <button
                                  type="button"
                                  className="repo-card__branch-row-action"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (canTrackRemote) void handleBranchOperation('track', branchItem)
                                  }}
                                  disabled={!canTrackRemote}
                                  data-app-tooltip={canTrackRemote ? `切换并跟踪 ${rowName}` : undefined}
                                  aria-label={canTrackRemote ? `切换并跟踪远端分支 ${rowName}` : `不能切换并跟踪远端分支 ${rowName}：${trackReason}`}
                                >
                                  <BranchSwitchIcon className="repo-card__branch-row-action-icon" />
                                  切换并跟踪
                                </button>
                              ) : null}
                              {!isCurrent && upstreamGone && !isRemoteOnly && rebindUpstream ? (
                                <button
                                  type="button"
                                  className="repo-card__branch-row-action"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (canRebind) void handleBranchOperation('rebind', branchItem)
                                  }}
                                  disabled={!canRebind}
                                  data-app-tooltip={canRebind ? `重新绑定到 ${rebindUpstream}` : undefined}
                                  aria-label={canRebind ? `将 ${rowName} 重新绑定到 ${rebindUpstream}` : `不能重新绑定 ${rowName}：${rebindReason}`}
                                >
                                  重新绑定
                                </button>
                              ) : null}
                              {!isCurrent && upstreamGone && !isRemoteOnly ? (
                                <button
                                  type="button"
                                  className="repo-card__branch-row-action"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (canUnsetUpstream) void handleBranchOperation('unset-upstream', branchItem)
                                  }}
                                  disabled={!canUnsetUpstream}
                                  data-app-tooltip={canUnsetUpstream ? `取消 ${rowName} 的 upstream` : undefined}
                                  aria-label={canUnsetUpstream ? `取消 ${rowName} 的 upstream` : `不能取消 ${rowName}：${unsetReason}`}
                                >
                                  取消上游
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="repo-card__branch-row-copy"
                                onClick={(event) => handleCopyMeta('branch', rowName, event)}
                                data-app-tooltip={`复制分支：${rowName}`}
                                aria-label={`复制分支 ${rowName}`}
                              >
                                <Icons.copy className="icon icon--sm" />
                              </button>
                              <button
                                type="button"
                                className="repo-card__branch-row-copy repo-card__branch-row-delete"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  if (canDeleteBranch) handleRequestBranchDelete(branchItem)
                                }}
                                disabled={!canDeleteBranch}
                                data-app-tooltip={canDeleteBranch ? `删除分支：${rowName}` : deleteReason}
                                aria-label={canDeleteBranch ? `删除分支 ${rowName}` : `不能删除分支 ${rowName}：${deleteReason}`}
                              >
                                <Icons.trash className="icon icon--sm" />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {branchSwitchHint ? (
                      <div className="repo-card__branch-hover-hint repo-card__branch-hover-hint--info">
                        {branchSwitchHint}
                      </div>
                    ) : null}
                    {!canSwitchBranch ? (
                      <div className="repo-card__branch-hover-hint">
                        {getBranchWriteDisableReason({
                          isCurrent: false,
                          modifiedCount,
                          conflictedCount,
                          isSyncing,
                          isQueued,
                          isSyncChecking,
                          isRemoteRefreshing,
                          branchOverviewLoading,
                          branchOverviewError,
                          isBranchOperationBusy: isBranchSwitchBusy,
                          branchOperationTarget,
                          isCheckedOutElsewhere: false,
                          worktreePath: '',
                          comparisonState: '',
                        })}
                      </div>
                    ) : null}
                    {branchOperationWarning ? (
                      <div className="repo-card__branch-hover-hint repo-card__branch-hover-hint--warning">{branchOperationWarning}</div>
                    ) : null}
                    {branchSwitchError ? (
                      <div className="repo-card__branch-hover-hint repo-card__branch-hover-hint--error">{branchSwitchError}</div>
                    ) : null}
                  </>
                ) : null}

                {!branchOverviewLoading && !branchOverviewError && !branchOverview ? (
                  <div className="repo-card__branch-hover-state">悬停后将展示全部分支与更新状态</div>
                ) : null}
                </RepoMetaHoverCard>
              ), document.body) : null}
              {branchNameTooltip ? (
                <AppTooltipSurface anchor={branchNameTooltip.anchor} text={branchNameTooltip.text} />
              ) : null}
              {branchDeleteConfirm && typeof document !== 'undefined' ? (
                <OverlayPortal
                  level={OVERLAY_LEVEL.dialog}
                  overlayId={OVERLAY_ID.repoBranchDelete}
                  present={branchDeletePresent}
                  onExitComplete={() => setBranchDeleteConfirm(null)}
                  onEscape={() => {
                    if (!branchDeleteSubmitting && !isBranchSwitchBusy) setBranchDeletePresent(false)
                  }}
                >
                  <BranchDeleteConfirmDialog
                    repo={repo}
                    branchName={branchDeleteConfirm.branchName}
                    remoteBranchName={branchDeleteConfirm.remoteBranchName}
                    remoteRequired={branchDeleteConfirm.remoteRequired}
                    busy={branchDeleteSubmitting || isBranchSwitchBusy}
                    refreshing={isBranchRefreshing}
                    onCancel={() => {
                      if (!branchDeleteSubmitting && !isBranchSwitchBusy) setBranchDeletePresent(false)
                    }}
                    onConfirm={handleConfirmBranchDelete}
                  />
                </OverlayPortal>
              ) : null}
            </div>
            <div
              ref={commitMetaHostRef}
              className={commitMetaHostClassName}
              onClick={(event) => event.stopPropagation()}
            >
              <div
                className="repo-card__latest-commit-hover-target"
                ref={commitMetaTargetRef}
                {...commitMetaHostBindings}
              >
                <Icons.edit className="icon icon--meta" />
                <span ref={latestCommitTextRef} className="meta-value repo-card__latest-commit-text">
                  最新提交：{latestCommit.summary}
                </span>
              </div>
              <button
                className={`repo-card__history-link ${commitHistoryOpen ? 'repo-card__history-link--hidden' : ''}`}
                onClick={handleViewCommitHistory}
                disabled={isMissingRepoPath || commitHistoryOpen}
                data-app-tooltip="查看提交历史"
                aria-label={`查看 ${repo.name} 的提交历史`}
                type="button"
                aria-hidden={commitHistoryOpen}
                tabIndex={commitHistoryOpen ? -1 : 0}
              >
                <Icons.commitHistory className="icon icon--sm" />
              </button>
              {latestCommitTruncated && openMetaHoverCard === 'commit' && commitHoverBridgeStyle && typeof document !== 'undefined' ? createPortal((
                <div
                  className="repo-card__meta-hover-bridge"
                  ref={commitHoverBridgeRef}
                  style={commitHoverBridgeStyle}
                  aria-hidden="true"
                  {...commitMetaCardBindings}
                />
              ), document.body) : null}
              {latestCommitTruncated && openMetaHoverCard === 'commit' && typeof document !== 'undefined' ? createPortal((
                <RepoMetaHoverCard
                  ref={commitHoverCardRef}
                  title="最新提交"
                  ariaLabel="最新提交完整内容"
                  className={commitHoverCardClassName}
                  style={commitHoverCardStyle || undefined}
                  {...commitMetaCardBindings}
                >
                  <div className="repo-card__meta-hover-card-hash">{latestCommit.hash || '-'}</div>
                  <div className="repo-card__meta-hover-card-body">{latestCommit.message}</div>
                  {hasLatestCommitMeta ? (
                    <div className="repo-card__meta-hover-card-meta">
                      {latestCommit.author ? <span>{latestCommit.author}</span> : null}
                      {latestCommit.date ? <span>{formatGitCommitLocalTime(latestCommit.date)} 提交</span> : null}
                    </div>
                  ) : null}
                </RepoMetaHoverCard>
              ), document.body) : null}
            </div>
            <div className="meta-item repo-card__primary-time">
              <Icons.clock className="icon icon--meta" />
              <span data-app-tooltip={primaryTimeTooltip}>
                <span className="repo-card__primary-time-label">{primaryTimeLabel}：</span>
                {primaryTimeDisplay}
              </span>
              <span className="repo-card__status-text">
                {statusLabel}
              </span>
            </div>
          </div>
        </div>
        <div className="repo-card__status-overlay">
          <div className={`repo-card__corner-badge repo-card__corner-badge--${repoCornerBadge.tone}`}>
            {repoCornerBadge.spinning ? (
              <span className="spinning"><RepoCornerBadgeIcon className="icon icon--xs" /></span>
            ) : (
              <RepoCornerBadgeIcon className="icon icon--xs" />
            )}
            <span>{repoCornerBadge.label}</span>
          </div>
          {showAutoScriptIndicator ? (
            <div className={autoScriptIndicatorClassName} data-app-tooltip={`自动脚本：${selectedBuildScript}`}>
              <Icons.bolt className="icon icon--xs" />
              <span>{autoScriptIndicatorLabel}</span>
            </div>
          ) : null}
        </div>
      </div>

      {status && (
        <div className="sync-info">
          <span className={modifiedBadgeClassName}><Icons.edit className="icon icon--xs" /> {modifiedCount} 已修改</span>
          {behindCount > 0 && <span className="sync-badge sync-badge--behind"><Icons.arrowDown className="icon icon--xs" /> {behindCount} 落后</span>}
          {aheadCount > 0 && <span className="sync-badge sync-badge--ahead"><Icons.arrowUp className="icon icon--xs" /> {aheadCount} 领先</span>}
          {needsUpstreamPublish && <span className="sync-badge sync-badge--ahead"><Icons.branch className="icon icon--xs" /> 待发布</span>}
          {status?.comparison_state === 'error' && <span className="sync-badge sync-badge--warning"><Icons.warning className="icon icon--xs" /> 状态待刷新</span>}
          {isDetachedHead && <span className="sync-badge sync-badge--neutral"><Icons.branch className="icon icon--xs" /> Detached</span>}
          {behindCount === 0 && aheadCount === 0 && modifiedCount === 0 && !needsUpstreamPublish && status?.comparison_state !== 'error' && !isDetachedHead && (
            <span className="sync-badge sync-badge--ok"><Icons.check className="icon icon--xs" /> 已同步</span>
          )}
        </div>
      )}

      {visibleBranchAttention ? (
        <div
          className="repo-card__branch-attention"
          role="status"
          data-app-tooltip={branchAttentionDisableReason || visibleBranchAttention.message}
        >
          <Icons.branch className="icon icon--xs" />
          <div className="repo-card__branch-attention-copy">
            <span className="repo-card__branch-attention-text">{visibleBranchAttention.message}</span>
            {branchAttentionDisableReason ? (
              <span className="repo-card__branch-attention-reason">{branchAttentionDisableReason}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="repo-card__branch-attention-action"
            onClick={handleBranchAttentionAction}
          >
            {branchAttentionDisableReason ? '查看详情' : visibleBranchAttention.actionLabel}
          </button>
          <button
            type="button"
            className="repo-card__branch-attention-dismiss"
            onClick={handleDismissBranchAttention}
            aria-label="忽略本次分支动态"
            data-app-tooltip="忽略本次分支动态"
          >
            <Icons.close className="icon icon--xs" />
          </button>
        </div>
      ) : null}

      {repoStateCallout && RepoStateCalloutIcon ? (
        <div
          className={`repo-card__state-callout repo-card__state-callout--${repoStateCallout.tone}`}
          data-app-tooltip={repoStateCallout.title || repoStateCallout.message}
        >
          <RepoStateCalloutIcon className="icon icon--xs" />
          <span className="repo-card__state-callout-text">{repoStateCallout.message}</span>
        </div>
      ) : null}

      {isMissingRepoPath ? (
        <div
          className="repo-card__missing-overlay"
          role="status"
          aria-live="polite"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="repo-card__missing-overlay-title">
            <Icons.warningMissingRepo className="icon icon--sm" />
            <span>仓库目录已不存在</span>
          </div>
          <div className="repo-card__missing-overlay-card" data-app-tooltip={missingRepoIdentity.primary}>
            <div className="repo-card__missing-overlay-card-name">
              {missingRepoIdentity.primary}
            </div>
            {missingRepoIdentity.secondary ? (
              <div
                className="repo-card__missing-overlay-card-meta"
                data-app-tooltip={missingRepoIdentity.secondary}
              >
                {missingRepoIdentity.secondary}
              </div>
            ) : null}
          </div>
          {shouldShowMissingRepoDetails ? (
            <div className="repo-card__missing-overlay-message" data-app-tooltip={missingRepoOverlayMessage}>
              {missingRepoOverlayMessage}
            </div>
          ) : null}
          <button
            className="repo-card__missing-overlay-remove-btn"
            onClick={() => onRequestRemove(repo.id)}
          >
            <Icons.trash className="icon icon--sm" />
            从列表移除
          </button>
        </div>
      ) : null}

      <div className={`repo-card__actions-wrap ${isActionOverlayVisible ? 'repo-card__actions-wrap--checking' : ''}`} ref={moreActionAreaRef}>
        <div className="repo-card__actions">
          <button
            className={syncButtonClassName}
            onClick={handleSync}
            disabled={actionControlsDisabled}
            data-app-tooltip={actionOverlayTitle}
            aria-busy={isActionOverlayVisible}
          >
            {syncButtonIcon}
            {syncButtonLabel}
          </button>

          {repoStatus === 'paused' ? (
            <button className="action-btn" onClick={() => onResume(repo.id)} disabled={actionControlsDisabled}>
              <Icons.play className="icon icon--sm" /> 恢复
            </button>
          ) : (
            <button className="action-btn" onClick={() => onPause(repo.id)} disabled={actionControlsDisabled}>
              <Icons.pause className="icon icon--sm" /> 暂停
            </button>
          )}

          <button
            className={`action-btn ${hasErrors ? 'action-btn--error' : ''}`}
            onClick={() => onViewErrors(repo.id)}
            disabled={!hasErrors || actionControlsDisabled}
            data-app-tooltip={hasErrors ? '查看同步错误日志' : '暂无同步错误'}
          >
            <Icons.warning className="icon icon--sm" /> 错误
          </button>

          <button
            ref={moreButtonRef}
            className="action-btn action-btn--more"
            onClick={toggleMenu}
            disabled={actionControlsDisabled}
            data-app-tooltip="更多操作"
            aria-label={`更多操作 ${repo.name}`}
            aria-expanded={menuOpen}
          >
            <Icons.more className="icon icon--sm" /> 更多
          </button>
        </div>

        {menuOpen && typeof document !== 'undefined' ? createPortal((
          <div
            ref={moreMenuRef}
            className={moreMenuClassName}
            style={moreMenuStyle || undefined}
            role="menu"
            aria-label={`${repo.name} 更多操作`}
          >
            <button
              className="repo-card__more-item"
              role="menuitem"
              onClick={() => runMoreAction(() => onOpenDirectory(repo.id))}
              disabled={actionControlsDisabled}
            >
              <Icons.folder className="icon icon--sm" />
              <span className="repo-card__more-text">打开目录</span>
            </button>
            <button
              className="repo-card__more-item"
              role="menuitem"
              onClick={() => runMoreAction(() => onOpenWithApp(repo.id))}
              disabled={actionControlsDisabled}
            >
              <Icons.monitor className="icon icon--sm" />
              <span className="repo-card__more-text">{openWithAppText}</span>
            </button>
            <button
              className="repo-card__more-item"
              role="menuitem"
              onClick={() => runMoreAction(() => onOpenWithTerminal(repo.id))}
              disabled={actionControlsDisabled}
            >
              <Icons.terminal className="icon icon--sm" />
              <span className="repo-card__more-text">{openWithTerminalText}</span>
            </button>
            {hasGitHubRepo ? (
              <button
                className="repo-card__more-item"
                role="menuitem"
                onClick={() => runMoreAction(() => onOpenGitHubRepo(repo.id))}
                data-app-tooltip={gitHubRepoUrl}
                disabled={actionControlsDisabled}
              >
                <Icons.github className="icon icon--sm" />
                <span className="repo-card__more-text">打开 GitHub 仓库</span>
              </button>
            ) : null}
            <button
              className="repo-card__more-item"
              role="menuitem"
              onClick={() => runMoreAction(() => onViewCommitHistory(repo.id))}
              disabled={actionControlsDisabled}
            >
              <Icons.commitHistory className="icon icon--sm" />
              <span className="repo-card__more-text">查看提交历史</span>
            </button>
            <button
              className="repo-card__more-item repo-card__more-item--split"
              role="menuitem"
              onClick={() => runMoreAction(() => onTogglePostSyncBuild(repo.id))}
              disabled={actionControlsDisabled}
            >
              <div className="repo-card__more-main">
                <Icons.bolt className="icon icon--sm" />
                <span className="repo-card__more-text">同步后执行脚本</span>
              </div>
              <span className={`toggle toggle--compact ${postSyncBuildEnabled ? 'toggle--active' : ''}`} />
            </button>
            <button
              className="repo-card__more-item repo-card__more-item--stack"
              role="menuitem"
              onClick={() => runMoreAction(() => onSelectPostSyncBuildScript(repo.id))}
              disabled={actionControlsDisabled}
            >
              <Icons.edit className="icon icon--sm" />
              <span className="repo-card__more-text">
                {hasSelectedBuildScript ? `已选脚本：${selectedBuildScript}` : '选择同步后脚本'}
              </span>
            </button>
            {hasSelectedBuildScript ? (
              <button
                className="repo-card__more-item"
                role="menuitem"
                onClick={() => runMoreAction(() => onClearPostSyncBuildScript(repo.id))}
                disabled={actionControlsDisabled}
              >
                <Icons.trash className="icon icon--sm" />
                <span className="repo-card__more-text">清空脚本选择</span>
              </button>
            ) : null}
            {hasSelectedBuildScript ? (
              <button
                className="repo-card__more-item"
                role="menuitem"
                onClick={() => runMoreAction(() => onRunPostSyncBuildScriptNow(repo.id))}
                disabled={isPostSyncBuildRunning || actionControlsDisabled}
              >
                <Icons.play className="icon icon--sm" />
                <span className="repo-card__more-text">
                  {isPostSyncBuildRunning ? '脚本执行中...' : '执行脚本'}
                </span>
              </button>
            ) : null}
            {canRetrySync ? (
              <button
                className="repo-card__more-item"
                role="menuitem"
                onClick={() => runMoreAction(() => onRetrySync(repo.id))}
                disabled={actionControlsDisabled}
              >
                <Icons.sync className="icon icon--sm" />
                <span className="repo-card__more-text">重试失败任务</span>
              </button>
            ) : null}
            <RepoStashMenuItem
              repo={repo}
              disabled={actionControlsDisabled}
              onOpenAccepted={closeMenu}
              onChanged={async () => {
                branchOverviewLoadedAtRef.current = 0
                if (typeof onBranchChanged === 'function') {
                  await onBranchChanged(repo.id)
                }
                await loadBranchOverview(true)
              }}
            />
            <button
              className="repo-card__more-item repo-card__more-item--danger"
              role="menuitem"
              onClick={() => runMoreAction(() => onRequestRemove(repo.id))}
              disabled={actionControlsDisabled}
            >
              <Icons.trash className="icon icon--sm" />
              <span className="repo-card__more-text">移除</span>
            </button>
          </div>
        ), document.body) : null}
        {isActionOverlayVisible ? (
          <button
            type="button"
            className="repo-card__actions-checking-overlay"
            onClick={canRequestSyncFromRefreshOverlay ? handleSync : undefined}
            disabled={!canRequestSyncFromRefreshOverlay}
            role={canRequestSyncFromRefreshOverlay ? undefined : 'status'}
            aria-live="polite"
            data-app-tooltip={actionOverlayTitle}
            style={{ cursor: canRequestSyncFromRefreshOverlay ? 'pointer' : 'progress' }}
          >
            <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
            <span>{actionOverlayText}</span>
            {canRequestSyncFromRefreshOverlay ? <span>点击同步</span> : null}
          </button>
        ) : null}
      </div>
      {historyToolbar ? (
        <div className="repo-card__history-toolbar-slot">
          {historyToolbar}
        </div>
      ) : null}
      </div>
  )
}

const MemoizedRepoCard = memo(RepoCard)

function DashboardGroupEntries({
  group,
  isCollapsed,
  dashboardLayout,
  repoGridColumns,
  dashboardRepoSortMode,
  syncTimestampsByRepoId,
  effectiveRepoStatuses,
  repoStatusIssues,
  statusIssueNowTick,
  repoQueueStateMap,
  syncCheckingRepoIdSet,
  remoteRefreshingRepoIdSet,
  isFocusRefreshingAll,
  missingRepoStates,
  postSyncBuildStates,
  latestRetryableJobMap,
  batchMode,
  selectedRepoIdSet,
  onToggleSelect,
  onSync,
  onCancelSync,
  onRetrySync,
  onPause,
  onResume,
  onOpenDirectory,
  onOpenWithApp,
  onOpenWithTerminal,
  onOpenGitHubRepo,
  onViewCommitHistory,
  openWithAppText,
  openWithTerminalText,
  onRequestRemove,
  onViewErrors,
  onTogglePostSyncBuild,
  onSelectPostSyncBuildScript,
  onClearPostSyncBuildScript,
  onRunPostSyncBuildScriptNow,
  onBranchChanged,
  repoBranchOverviews,
  onBranchOverviewChanged,
  dismissedBranchAttentionKeys,
  onDismissBranchAttention,
  onBranchOperationFeedback,
  onCopyRepoMeta,
  activeCommitHistoryRepoId,
  commitHistoryHandoffRepoId,
  commitHistoryHandoffHeight,
  commitHistoryHandoffSourceHeight,
  commitHistoryOverlayActive,
  commitHistoryClosing,
}) {
  const [shouldRenderContent, setShouldRenderContent] = useState(() => !isCollapsed)
  const [isAnimatingClosed, setIsAnimatingClosed] = useState(() => isCollapsed)
  const animationFrameRef = useRef(null)
  const collapseTimerRef = useRef(null)
  const hasMountedRef = useRef(false)

  useLayoutEffect(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = null
    }

    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      setShouldRenderContent(!isCollapsed)
      setIsAnimatingClosed(isCollapsed)
      return undefined
    }

    if (!isCollapsed) {
      setShouldRenderContent(true)
      setIsAnimatingClosed(true)
      animationFrameRef.current = requestAnimationFrame(() => {
        setIsAnimatingClosed(false)
        animationFrameRef.current = null
      })
      return undefined
    }

    setIsAnimatingClosed(true)
    collapseTimerRef.current = setTimeout(() => {
      setShouldRenderContent(false)
      collapseTimerRef.current = null
    }, DASHBOARD_GROUP_COLLAPSE_ANIMATION_MS)
    return undefined
  }, [isCollapsed])

  useEffect(() => () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current)
  }, [])

  // 卡片布局按 `index % 列数` 保序分发到列容器；列容器是 flex column，
  // 卡片高度才由各自内容决定（等宽行 + grid 会把同一行拉齐，瀑布流就没了）。
  const repoColumns = useMemo(
    () => (shouldRenderContent ? buildDashboardColumns(group.repos, dashboardLayout, repoGridColumns) : []),
    [dashboardLayout, group.repos, repoGridColumns, shouldRenderContent]
  )

  if (!shouldRenderContent) return null

  const entriesWrapClassName = [
    'dashboard-group__entries-wrap',
    isAnimatingClosed ? 'dashboard-group__entries-wrap--collapsed' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={entriesWrapClassName} aria-hidden={isCollapsed}>
      <div className="dashboard-group__entries">
        <div className={`repo-grid repo-grid--${dashboardLayout}`}>
          {repoColumns.map((column, columnIndex) => (
            <div className="repo-grid__column" key={group.key + '-repo-column-' + columnIndex}>
              {column.map((item) => (
                <MemoizedRepoCard
                  key={item.id}
                  repo={item}
                  dashboardSortMode={dashboardRepoSortMode}
                  syncTimestamp={syncTimestampsByRepoId[item.id] || 0}
                  status={effectiveRepoStatuses[item.id]}
                  statusIssue={repoStatusIssues[item.id]}
                  statusIssueNow={statusIssueNowTick}
                  queueState={repoQueueStateMap[item.id]}
                  isSyncChecking={syncCheckingRepoIdSet.has(item.id)}
                  isRemoteRefreshing={remoteRefreshingRepoIdSet.has(item.id)}
                  isFocusRefreshing={isFocusRefreshingAll}
                  isPathMissing={Boolean(missingRepoStates[item.id])}
                  pathMissingMessage={missingRepoStates[item.id]?.message || ''}
                  postSyncBuildState={postSyncBuildStates[item.id]}
                  canRetrySync={Boolean(latestRetryableJobMap[item.id]) && !repoQueueStateMap[item.id]}
                  batchMode={batchMode}
                  selected={selectedRepoIdSet.has(item.id)}
                  onToggleSelect={onToggleSelect}
                  onSync={onSync}
                  onCancelSync={onCancelSync}
                  onRetrySync={onRetrySync}
                  onPause={onPause}
                  onResume={onResume}
                  onOpenDirectory={onOpenDirectory}
                  onOpenWithApp={onOpenWithApp}
                  onOpenWithTerminal={onOpenWithTerminal}
                  onOpenGitHubRepo={onOpenGitHubRepo}
                  onViewCommitHistory={onViewCommitHistory}
                  openWithAppText={openWithAppText}
                  openWithTerminalText={openWithTerminalText}
                  onRequestRemove={onRequestRemove}
                  onViewErrors={onViewErrors}
                  onTogglePostSyncBuild={onTogglePostSyncBuild}
                  onSelectPostSyncBuildScript={onSelectPostSyncBuildScript}
                  onClearPostSyncBuildScript={onClearPostSyncBuildScript}
                  onRunPostSyncBuildScriptNow={onRunPostSyncBuildScriptNow}
                  onBranchChanged={onBranchChanged}
                  branchOverviewSnapshot={repoBranchOverviews[item.id] || null}
                  onBranchOverviewChanged={onBranchOverviewChanged}
                  dismissedBranchAttentionKey={dismissedBranchAttentionKeys[item.id] || ''}
                  onDismissBranchAttention={onDismissBranchAttention}
                  onBranchOperationFeedback={onBranchOperationFeedback}
                  onCopyRepoMeta={onCopyRepoMeta}
                  commitHistoryOpen={activeCommitHistoryRepoId === item.id}
                  commitHistoryHandoff={commitHistoryHandoffRepoId === item.id}
                  commitHistoryHandoffHeight={commitHistoryHandoffRepoId === item.id ? commitHistoryHandoffHeight : null}
                  commitHistoryHandoffSourceHeight={commitHistoryHandoffRepoId === item.id ? commitHistoryHandoffSourceHeight : null}
                  commitHistoryOverlayActive={commitHistoryOverlayActive}
                  commitHistoryClosing={commitHistoryClosing && activeCommitHistoryRepoId === item.id}
                  commitHistoryTransitionHidden={commitHistoryOverlayActive && activeCommitHistoryRepoId === item.id}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const MemoizedDashboardGroupEntries = memo(DashboardGroupEntries)

function ConflictDialog({ conflict, onClose, onRefresh }) {
  const [resolving, setResolving] = useState(null)
  const files = conflict?.conflict_files || []

  const resolveFile = async (file, strategy) => {
    setResolving(file)
    try {
      await invoke('resolve_conflict', { repoPath: conflict.repoPath, filePath: file, strategy })
      onRefresh()
    } catch (e) { console.error(e) }
    finally { setResolving(null) }
  }

  const resolveAll = async (strategy) => {
    setResolving('all')
    try {
      await invoke('resolve_all_conflicts', {
        repoPath: conflict.repoPath, strategy, repoId: conflict.repoId
      })
      onRefresh()
      onClose()
    } catch (e) { console.error(e) }
    finally { setResolving(null) }
  }

  const abortMerge = async () => {
    try {
      await invoke('abort_merge', { repoPath: conflict.repoPath, repoId: conflict.repoId })
      onRefresh()
      onClose()
    } catch (e) { console.error(e) }
  }

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={onClose}>
      <div data-overlay-motion="surface" className="conflict-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="conflict-dialog__header">
          <Icons.warning className="icon icon--warning" />
          <div>
            <div className="conflict-dialog__title">{conflict.repoName} - 合并冲突</div>
            <div className="conflict-dialog__subtitle">{files.length} 个文件存在冲突</div>
          </div>
        </div>

        <div className="conflict-dialog__body">
          {files.map((file) => (
            <div className="conflict-file" key={file}>
              <div className="conflict-file__name">{file}</div>
              <div className="conflict-file__actions">
                <button className="conflict-file__btn" onClick={() => resolveFile(file, 'ours')} disabled={resolving === file}>
                  保留本地
                </button>
                <button className="conflict-file__btn conflict-file__btn--theirs" onClick={() => resolveFile(file, 'theirs')} disabled={resolving === file}>
                  保留远程
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="conflict-dialog__footer">
          <div className="conflict-dialog__batch">
            <button className="dialog-btn dialog-btn--primary" onClick={() => resolveAll('ours')} disabled={resolving === 'all'}>
              全部保留本地
            </button>
            <button className="dialog-btn" onClick={() => resolveAll('theirs')} disabled={resolving === 'all'}>
              全部保留远程
            </button>
          </div>
          <button className="dialog-btn dialog-btn--danger" onClick={abortMerge}>
            中止合并
          </button>
        </div>
      </div>
    </div>
  )
}

function ErrorLogDialog({ data, onClose }) {
  const logs = data?.errorLogs || []
  const isEmpty = logs.length === 0

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={onClose}>
      <div data-overlay-motion="surface" className={`error-log-dialog ${isEmpty ? 'error-log-dialog--empty' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="error-log-dialog__header">
          <div className={`error-log-dialog__header-icon ${isEmpty ? 'error-log-dialog__header-icon--ok' : ''}`}>
            {isEmpty ? <Icons.check className="icon icon--warning" /> : <Icons.warning className="icon icon--warning" />}
          </div>
          <div>
            <div className="error-log-dialog__title">{data.repoName || '仓库'} - 同步错误日志</div>
            <div className="error-log-dialog__subtitle">共 {logs.length} 条记录</div>
          </div>
        </div>

        <div className="error-log-dialog__body">
          {isEmpty ? (
            <div className="error-log-dialog__empty">
              <div className="error-log-dialog__empty-title">暂无错误日志</div>
              <div className="error-log-dialog__empty-desc">当同步出现失败时，错误详情会显示在这里。</div>
            </div>
          ) : (
            logs.map((entry, index) => (
              <pre className="error-log-entry" key={`${index}-${entry.slice(0, 20)}`}>
                {entry}
              </pre>
            ))
          )}
        </div>

        <div className="error-log-dialog__footer">
          <button className="dialog-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

function DeleteConfirmDialog({ repos, removing, onCancel, onConfirm }) {
  const repoList = Array.isArray(repos) ? repos : []
  const count = repoList.length
  const isBatch = count > 1
  const preview = repoList.slice(0, 5)
  const moreCount = Math.max(0, count - preview.length)

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={removing ? undefined : onCancel}>
      <div data-overlay-motion="surface" className="delete-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="delete-dialog__header">
          <div className="delete-dialog__icon">
            <Icons.trash className="icon icon--warning" />
          </div>
          <div>
            <div className="delete-dialog__title">{isBatch ? '确认批量移除仓库' : '确认移除仓库'}</div>
            <div className="delete-dialog__subtitle">仅从 GitSync 移除，不会删除本地文件</div>
          </div>
        </div>

        <div className="delete-dialog__body">
          <div>{isBatch ? `你将要移除 ${count} 个仓库：` : '你将要移除以下仓库：'}</div>
          <div className="delete-dialog__repo-list">
            {preview.map((repo) => (
              <div className="delete-dialog__repo" key={repo.id}>
                <strong>{repo.name || '未命名仓库'}</strong>
                {repo.path ? <div>{repo.path}</div> : null}
              </div>
            ))}
            {moreCount > 0 ? (
              <div className="delete-dialog__repo-more">... 另有 {moreCount} 个仓库</div>
            ) : null}
          </div>
        </div>

        <div className="delete-dialog__footer">
          <button className="dialog-btn" onClick={onCancel} disabled={removing}>取消</button>
          <button className="dialog-btn dialog-btn--danger" onClick={onConfirm} disabled={removing || count === 0}>
            {removing ? '移除中...' : `确认移除${isBatch ? `（${count}）` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function ImportResultDialog({ data, onClose }) {
  const title = data?.title || '导入结果'
  const selectedCount = data?.selectedCount || 0
  const uniqueCount = data?.uniqueCount || 0
  const attemptedCount = data?.attemptedCount || 0
  const successCount = data?.successCount || 0
  const duplicateInSelection = toArray(data?.duplicateInSelection)
  const skippedExisting = toArray(data?.skippedExisting)
  const failures = toArray(data?.failures)
  const warnings = toArray(data?.warnings)

  const duplicateCount = duplicateInSelection.length
  const skippedCount = skippedExisting.length
  const failureCount = failures.length
  const warningCount = warnings.length
  const hasIssues = failureCount > 0 || warningCount > 0
  const subtitleText = hasIssues
    ? `导入已完成，成功 ${successCount} 个，失败 ${failureCount} 个`
    : `导入已完成，成功 ${successCount} 个`
  const isFullyCleanResult = duplicateCount === 0 && skippedCount === 0 && failureCount === 0 && warningCount === 0

  const statItems = [
    { label: '已选择', value: selectedCount },
    { label: '去重后', value: uniqueCount },
    { label: '选择内重复', value: duplicateCount },
    { label: '已存在跳过', value: skippedCount },
    { label: '实际导入', value: attemptedCount },
    { label: '导入成功', value: successCount, tone: 'success' },
    { label: '导入失败', value: failureCount, tone: failureCount > 0 ? 'danger' : null },
    { label: '设置警告', value: warningCount, tone: warningCount > 0 ? 'warning' : null },
  ]

  const renderPathList = (items, type) => {
    const list = toArray(items)
    const preview = list.slice(0, 5)
    const moreCount = Math.max(0, list.length - preview.length)

    return (
      <>
        <div className="import-result-dialog__list">
          {preview.map((item, index) => {
            const path = typeof item === 'string' ? item : item.path
            const message = typeof item === 'string' ? '' : item.message
            return (
              <div className="import-result-dialog__item" key={`${type}-${index}-${path || 'unknown'}`}>
                <div className="import-result-dialog__item-path">{path || '未知路径'}</div>
                {message ? <div className="import-result-dialog__item-message">{message}</div> : null}
              </div>
            )
          })}
        </div>
        {moreCount > 0 ? (
          <div className="import-result-dialog__more">... 另有 {moreCount} 项</div>
        ) : null}
      </>
    )
  }

  const renderSection = (titleText, items, type, extraClassName = '') => {
    if (items.length === 0) return null
    const className = extraClassName
      ? `import-result-dialog__section ${extraClassName}`
      : 'import-result-dialog__section'

    return (
      <div className={className}>
        <div className="import-result-dialog__section-title">{titleText}</div>
        {renderPathList(items, type)}
      </div>
    )
  }

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={onClose}>
      <div data-overlay-motion="surface" className="import-result-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="import-result-dialog__header">
          <div className={`import-result-dialog__icon ${hasIssues ? 'import-result-dialog__icon--warning' : ''}`}>
            {hasIssues ? <Icons.warning className="icon icon--warning" /> : <Icons.check className="icon icon--warning" />}
          </div>
          <div>
            <div className="import-result-dialog__title">{title}</div>
            <div className="import-result-dialog__subtitle">{subtitleText}</div>
          </div>
        </div>

        <div className="import-result-dialog__body">
          <div className="import-result-dialog__stats">
            {statItems.map((item) => (
              <div
                className={`import-result-dialog__stat ${item.tone ? `import-result-dialog__stat--${item.tone}` : ''}`}
                key={item.label}
              >
                <div className="import-result-dialog__stat-label">{item.label}</div>
                <div className="import-result-dialog__stat-value">{item.value}</div>
              </div>
            ))}
          </div>

          {renderSection('本次选择内重复目录（已去除）', duplicateInSelection, 'duplicates')}
          {renderSection('已存在目录（已跳过）', skippedExisting, 'existing')}
          {renderSection('导入失败详情', failures, 'failures', 'import-result-dialog__section--danger')}
          {renderSection('导入成功但设置应用失败', warnings, 'warnings', 'import-result-dialog__section--warning')}

          {isFullyCleanResult ? (
            <div className="import-result-dialog__empty">
              本次导入无重复、无错误，所有选择目录均已成功添加。
            </div>
          ) : null}
        </div>

        <div className="import-result-dialog__footer">
          <button className="dialog-btn dialog-btn--primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  )
}

function NoticeDialog({ title, message, onClose }) {
  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={onClose}>
      <div data-overlay-motion="surface" className="notice-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="notice-dialog__header">
          <div className="notice-dialog__title">{title || '提示'}</div>
        </div>
        <div className="notice-dialog__body">
          <pre className="notice-dialog__message">{message || ''}</pre>
        </div>
        <div className="notice-dialog__footer">
          <button className="dialog-btn dialog-btn--primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  )
}

function ScriptLogDialog({
  sessions,
  activeSessionId,
  onSelectSession,
  onClear,
  onClose,
}) {
  const list = Array.isArray(sessions) ? sessions : []
  const activeSession = list.find((item) => item.id === activeSessionId) || list[list.length - 1] || null
  const hasRunningSession = list.some((item) => item.status === SCRIPT_LOG_STATUS.running)
  const outputRef = useRef(null)

  useEffect(() => {
    const element = outputRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [activeSession?.id, activeSession?.output])

  const statusText = getScriptLogStatusText(activeSession?.status)
  const statusClassName = getScriptLogStatusClassName('script-log-dialog__status', activeSession?.status)

  const sourceText = activeSession?.source === 'manual'
    ? '手动触发'
    : '同步后自动触发'
  const outputText = String(activeSession?.output || '').trim()
  const displayOutput = outputText || (activeSession?.status === SCRIPT_LOG_STATUS.running
    ? '执行中，等待脚本输出...'
    : '(无输出)')

  let statusIcon = <Icons.sync className="icon icon--sm" />
  if (activeSession?.status === SCRIPT_LOG_STATUS.success) {
    statusIcon = <Icons.check className="icon icon--sm" />
  } else if (activeSession?.status === SCRIPT_LOG_STATUS.failed) {
    statusIcon = <Icons.warning className="icon icon--sm" />
  }

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={onClose}>
      <div data-overlay-motion="surface" className="script-log-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="script-log-dialog__header">
          <div className="script-log-dialog__header-icon">
            <Icons.bolt className="icon icon--warning" />
          </div>
          <div className="script-log-dialog__header-main">
            <div className="script-log-dialog__title">脚本执行日志</div>
            <div className="script-log-dialog__subtitle">
              {activeSession ? `${activeSession.repoName} · ${statusText}` : '暂无执行记录'}
            </div>
          </div>
          {activeSession ? (
            <div className={statusClassName}>
              {statusIcon}
              <span>{statusText}</span>
            </div>
          ) : null}
        </div>

        <div className="script-log-dialog__body">
          {list.length > 0 ? (
            <div className="script-log-dialog__session-list">
              {[...list].reverse().map((session) => {
                const selected = session.id === activeSession?.id
                const label = session.repoName || session.repoId || '未知仓库'
                const sessionStateText = getScriptLogStatusText(session.status)
                const sessionClassName = getScriptLogStatusClassName(
                  'script-log-dialog__session-item',
                  session.status,
                  selected ? 'script-log-dialog__session-item--active' : ''
                )
                return (
                  <button
                    key={session.id}
                    className={sessionClassName}
                    onClick={() => onSelectSession?.(session.id)}
                  >
                    <span>{label}</span>
                    <small>{sessionStateText}</small>
                  </button>
                )
              })}
            </div>
          ) : null}

          <div className="script-log-dialog__meta-grid">
            <div className="script-log-dialog__meta-item">
              <div className="script-log-dialog__meta-label">仓库</div>
              <div className="script-log-dialog__meta-value">{activeSession?.repoName || '-'}</div>
            </div>
            <div className="script-log-dialog__meta-item">
              <div className="script-log-dialog__meta-label">触发来源</div>
              <div className="script-log-dialog__meta-value">{activeSession ? sourceText : '-'}</div>
            </div>
            <div className="script-log-dialog__meta-item">
              <div className="script-log-dialog__meta-label">开始时间</div>
              <div className="script-log-dialog__meta-value">{formatSyncHistoryDateTime(activeSession?.startedAt)}</div>
            </div>
            <div className="script-log-dialog__meta-item">
              <div className="script-log-dialog__meta-label">结束时间</div>
              <div className="script-log-dialog__meta-value">{formatSyncHistoryDateTime(activeSession?.finishedAt)}</div>
            </div>
          </div>

          <div className="script-log-dialog__kv">
            <div className="script-log-dialog__kv-label">脚本</div>
            <div className="script-log-dialog__kv-value" data-app-tooltip={activeSession?.scriptPath || ''}>
              {activeSession?.scriptPath || '-'}
            </div>
          </div>
          <div className="script-log-dialog__kv">
            <div className="script-log-dialog__kv-label">命令</div>
            <div className="script-log-dialog__kv-value" data-app-tooltip={activeSession?.command || ''}>
              {activeSession?.command || '-'}
            </div>
          </div>
          <div className="script-log-dialog__kv">
            <div className="script-log-dialog__kv-label">结果</div>
            <div className="script-log-dialog__kv-value">
              {activeSession?.message || '-'}
            </div>
          </div>

          <div className="script-log-dialog__output-wrap">
            <div className="script-log-dialog__output-title">输出</div>
            <pre ref={outputRef} className="script-log-dialog__output">{displayOutput}</pre>
          </div>
        </div>

        <div className="script-log-dialog__footer">
          <button className="dialog-btn" onClick={onClear} disabled={hasRunningSession || list.length === 0}>
            清空
          </button>
          <button className="dialog-btn dialog-btn--primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function SyncGuardDialog({ data, onCancel, onConfirm }) {
  const blockedItems = toArray(data?.blockedItems)
  const warningItems = toArray(data?.warningItems)
  const continueCount = data?.continueCount || 0
  const canContinue = continueCount > 0
  const source = data?.source || 'manual'
  const summaryText = formatSyncGuardSummaryText(source, blockedItems.length, warningItems.length)

  const renderIssueSection = (title, items, tone) => {
    if (items.length === 0) return null
    return (
      <div className={`sync-guard-dialog__section sync-guard-dialog__section--${tone}`}>
        <div className="sync-guard-dialog__section-title">{title}</div>
        <div className="sync-guard-dialog__list">
          {items.map((item) => (
            <div className="sync-guard-dialog__item" key={`${item.repoId}-${tone}`}>
              <div className="sync-guard-dialog__repo">{item.repoName || item.repoId}</div>
              <div className="sync-guard-dialog__issues">
                {(item.issues || []).map((issue, index) => (
                  <div className="sync-guard-dialog__issue" key={`${item.repoId}-${issue.rule}-${index}`}>
                    <span className={`sync-guard-dialog__badge sync-guard-dialog__badge--${issue.policy}`}>
                      {issue.policy === SYNC_GUARD_POLICY.block ? '阻断' : '警告'}
                    </span>
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div data-overlay-motion="backdrop" className="modal-overlay" onClick={onCancel}>
      <div data-overlay-motion="surface" className="sync-guard-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="sync-guard-dialog__header">
          <div className="sync-guard-dialog__icon">
            <Icons.warning className="icon icon--warning" />
          </div>
          <div>
            <div className="sync-guard-dialog__title">同步前检查</div>
            <div className="sync-guard-dialog__subtitle">{summaryText}</div>
          </div>
        </div>

        <div className="sync-guard-dialog__body">
          {renderIssueSection('阻断项', blockedItems, 'block')}
          {renderIssueSection('警告项', warningItems, 'warn')}
        </div>

        <div className="sync-guard-dialog__footer">
          <button className="dialog-btn" onClick={onCancel}>
            {canContinue ? '取消' : '知道了'}
          </button>
          {canContinue ? (
            <button className="dialog-btn dialog-btn--primary" onClick={onConfirm}>
              继续同步（{continueCount}）
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function RemoveUndoToast({ data, restoring, onUndo, onDismiss }) {
  const repos = toArray(data?.repos)
  if (repos.length === 0) return null

  const count = repos.length
  const text = count === 1 ? `已移除仓库：${repos[0].name || repos[0].id}` : `已移除 ${count} 个仓库`

  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <div className="undo-toast__text">{text}</div>
      <div className="undo-toast__actions">
        <button
          className="undo-toast__btn undo-toast__btn--primary"
          onClick={onUndo}
          disabled={restoring}
        >
          {restoring ? '恢复中...' : '撤销'}
        </button>
        <button className="undo-toast__btn" onClick={onDismiss} disabled={restoring}>关闭</button>
      </div>
    </div>
  )
}

function ImportLoadingToast({ data, hasUndoToast = false }) {
  const totalCount = Number(data?.totalCount || 0)
  if (totalCount <= 0) return null

  const completedCount = Math.max(0, Math.min(totalCount, Number(data?.completedCount || 0)))
  const phase = data?.phase === 'refreshing' ? 'refreshing' : 'importing'
  let description = '正在导入仓库并应用默认设置...'
  if (phase === 'refreshing') {
    description = '正在刷新仓库状态，请稍候...'
  } else if (totalCount > 1) {
    description = `正在导入仓库（${completedCount}/${totalCount}）...`
  }
  const className = hasUndoToast
    ? 'import-loading-toast import-loading-toast--with-undo'
    : 'import-loading-toast'

  return (
    <div className={className} role="status" aria-live="polite" aria-atomic="true">
      <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
      <div className="import-loading-toast__content">
        <div className="import-loading-toast__title">仓库导入进行中</div>
        <div className="import-loading-toast__desc">{description}</div>
      </div>
    </div>
  )
}

function DashboardLoadingState() {
  return (
    <div className="dashboard-loading" role="status" aria-live="polite" aria-label="正在加载仓库">
      <div className="dashboard-loading__panel">
        <div className="dashboard-loading__header">
          <span className="dashboard-loading__mark">
            <span className="spinning"><Icons.sync className="icon icon--md" /></span>
          </span>
          <div className="dashboard-loading__copy">
            <div className="dashboard-loading__title">正在加载仓库</div>
            <div className="dashboard-loading__subtitle">读取本地配置和仓库状态</div>
          </div>
        </div>
        <div className="dashboard-loading__preview" aria-hidden="true">
          <div className="dashboard-loading__row dashboard-loading__row--primary">
            <span className="dashboard-loading__dot" />
            <span className="dashboard-loading__line dashboard-loading__line--wide" />
            <span className="dashboard-loading__pill" />
          </div>
          <div className="dashboard-loading__row">
            <span className="dashboard-loading__dot" />
            <span className="dashboard-loading__line dashboard-loading__line--medium" />
            <span className="dashboard-loading__pill" />
          </div>
          <div className="dashboard-loading__row">
            <span className="dashboard-loading__dot" />
            <span className="dashboard-loading__line dashboard-loading__line--short" />
            <span className="dashboard-loading__pill" />
          </div>
        </div>
      </div>
    </div>
  )
}

function StatusToast({ data, stacked = false, withUndo = false, onDismiss }) {
  if (!data?.message) return null
  const className = [
    'status-toast',
    data.tone ? `status-toast--${data.tone}` : '',
    stacked ? 'status-toast--stacked' : '',
    withUndo ? 'status-toast--with-undo' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={className} role="status" aria-live="polite" aria-atomic="true">
      <div className="status-toast__content">
        <div className="status-toast__title">{data.title || '提示'}</div>
        <div className="status-toast__message">{data.message}</div>
      </div>
      <button className="status-toast__btn" onClick={onDismiss} aria-label="关闭提示">
        知道了
      </button>
    </div>
  )
}

function useIntervalSettingControl({
  secondsValue,
  fallbackSeconds,
  onChange,
  disabled = false,
}) {
  const [unit, setUnit] = useState('seconds')
  const [amountDraft, setAmountDraft] = useState(String(fallbackSeconds))

  useEffect(() => {
    const next = toIntervalUnitDraft(secondsValue, fallbackSeconds)
    setUnit(next.unit)
    setAmountDraft(String(next.amount))
  }, [secondsValue, fallbackSeconds])

  function commit(value = amountDraft, nextUnit = unit) {
    if (disabled) return
    const normalized = normalizeIntervalAmountByUnit(value, nextUnit, secondsValue, fallbackSeconds)
    setAmountDraft(String(normalized.amount))
    if (normalized.seconds !== secondsValue) {
      onChange(normalized.seconds)
    }
  }

  function changeUnit(nextUnit) {
    if (disabled || nextUnit === unit) return
    const current = normalizeIntervalAmountByUnit(amountDraft, unit, secondsValue, fallbackSeconds)
    const converted = Math.round(current.seconds / (INTERVAL_UNITS[nextUnit]?.factor || 1))
    const normalized = normalizeIntervalAmountByUnit(converted, nextUnit, current.seconds, fallbackSeconds)
    setUnit(nextUnit)
    setAmountDraft(String(normalized.amount))
    if (normalized.seconds !== secondsValue) {
      onChange(normalized.seconds)
    }
  }

  function step(delta) {
    if (disabled) return
    const current = normalizeIntervalAmountByUnit(amountDraft, unit, secondsValue, fallbackSeconds)
    const normalized = normalizeIntervalAmountByUnit(current.amount + delta, unit, secondsValue, fallbackSeconds)
    setAmountDraft(String(normalized.amount))
    if (normalized.seconds !== secondsValue) {
      onChange(normalized.seconds)
    }
  }

  return {
    unit,
    amountDraft,
    setAmountDraft,
    commit,
    changeUnit,
    step,
  }
}

function IntervalSettingRow({
  label,
  helpText,
  unit,
  amountDraft,
  onAmountDraftChange,
  onCommit,
  onStep,
  onUnitChange,
  decreaseAriaLabel,
  inputAriaLabel,
  increaseAriaLabel,
  disabled = false,
}) {
  return (
    <div className="settings__row">
      <div className="settings__label">
        {label}
        <small>{helpText}</small>
      </div>
      <IntervalControl
        unit={unit}
        amountDraft={amountDraft}
        onAmountDraftChange={onAmountDraftChange}
        onCommit={onCommit}
        onStep={onStep}
        onUnitChange={onUnitChange}
        decreaseAriaLabel={decreaseAriaLabel}
        inputAriaLabel={inputAriaLabel}
        increaseAriaLabel={increaseAriaLabel}
        disabled={disabled}
      />
    </div>
  )
}

function Settings({
  theme,
  onThemeChange,
  settings,
  onUpdateSetting,
  onShowNotice,
  appVersion = '未知版本',
  updaterSupported = false,
  updatePhase = 'idle',
  updateMessage = '',
  onCheckForUpdates,
  onInstallUpdate,
  githubAccount,
  onGithubLogin,
  onGithubLogout,
  onCopyDiagnostics,
}) {
  const update = (k, v) => onUpdateSetting(k, v)
  const isManualMode = settings.defaultSyncMode === 'manual'
  const openAppPath = settings.defaultOpenApp || ''
  const terminalAppPath = settings.defaultTerminalApp || ''
  const maxSyncConcurrency = normalizeSyncConcurrency(settings.maxSyncConcurrency)
  const syncGuardPolicies = normalizeSyncGuardPolicies(settings.syncGuardPolicies)
  const updateBusy = ['checking', 'downloading', 'preparing', 'installing', 'relaunching'].includes(updatePhase)
  const updateActionLabel = updatePhase === 'ready'
    ? '现在重启并安装'
    : updatePhase === 'restartRequired'
      ? '重新启动 GitSync'
    : updateBusy
      ? (updatePhase === 'checking' ? '正在检查…' : updatePhase === 'preparing' ? '正在准备…' : updatePhase === 'installing' ? '正在安装…' : updatePhase === 'relaunching' ? '正在重启…' : '正在下载…')
      : '检查更新'

  const pickAppForSetting = async ({ key, title, errorTitle }) => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title,
      })
      if (!picked) return
      const appPath = Array.isArray(picked) ? picked[0] : picked
      if (!appPath) return
      update(key, String(appPath))
    } catch (error) {
      if (!onShowNotice) return
      onShowNotice({
        title: errorTitle,
        message: getErrorMessage(error),
      })
    }
  }

  const pickDefaultOpenApp = async () => {
    await pickAppForSetting({
      key: 'defaultOpenApp',
      title: '选择默认打开应用',
      errorTitle: '选择应用失败',
    })
  }

  const pickDefaultTerminalApp = async () => {
    await pickAppForSetting({
      key: 'defaultTerminalApp',
      title: '选择默认终端应用',
      errorTitle: '选择终端失败',
    })
  }

  const syncIntervalControl = useIntervalSettingControl({
    secondsValue: settings.defaultSyncInterval,
    fallbackSeconds: DEFAULT_APP_SETTINGS.defaultSyncInterval,
    onChange: (value) => update('defaultSyncInterval', value),
    disabled: isManualMode,
  })

  const backgroundFetchIntervalControl = useIntervalSettingControl({
    secondsValue: settings.backgroundFetchInterval,
    fallbackSeconds: DEFAULT_APP_SETTINGS.backgroundFetchInterval,
    onChange: (value) => update('backgroundFetchInterval', value),
  })

  const setSyncConcurrency = (value) => {
    const normalized = normalizeSyncConcurrency(value)
    if (normalized === maxSyncConcurrency) return
    update('maxSyncConcurrency', normalized)
  }

  const stepSyncConcurrency = (delta) => {
    setSyncConcurrency(maxSyncConcurrency + delta)
  }

  const updateSyncGuardPolicy = (rule, policy) => {
    if (!SYNC_GUARD_RULE_CONFIG[rule]) return
    if (syncGuardPolicies[rule] === policy) return
    update('syncGuardPolicies', {
      ...syncGuardPolicies,
      [rule]: normalizeSyncGuardPolicy(policy),
    })
  }

  return (
    <div className="settings">
      <h1 className="settings__title">设置</h1>

      {/* 同步设置 */}
      <div className="settings__section">
        <h2 className="settings__section-title">同步设置</h2>
        <IntervalSettingRow
          label="同步间隔"
          helpText={isManualMode ? '手动模式下无需设置同步间隔' : '自动同步的执行间隔（5 秒 - 24 小时）'}
          unit={syncIntervalControl.unit}
          amountDraft={syncIntervalControl.amountDraft}
          onAmountDraftChange={syncIntervalControl.setAmountDraft}
          onCommit={syncIntervalControl.commit}
          onStep={syncIntervalControl.step}
          onUnitChange={syncIntervalControl.changeUnit}
          decreaseAriaLabel="减少同步间隔"
          inputAriaLabel="同步间隔数值"
          increaseAriaLabel="增加同步间隔"
          disabled={isManualMode}
        />
        <IntervalSettingRow
          label="定时远端 Fetch 间隔"
          helpText="对未启用自动同步仓库按间隔执行远端 git fetch（5 秒 - 24 小时），仅刷新远端状态，不自动拉取"
          unit={backgroundFetchIntervalControl.unit}
          amountDraft={backgroundFetchIntervalControl.amountDraft}
          onAmountDraftChange={backgroundFetchIntervalControl.setAmountDraft}
          onCommit={backgroundFetchIntervalControl.commit}
          onStep={backgroundFetchIntervalControl.step}
          onUnitChange={backgroundFetchIntervalControl.changeUnit}
          decreaseAriaLabel="减少定时远端 Fetch 间隔"
          inputAriaLabel="定时远端 Fetch 间隔数值"
          increaseAriaLabel="增加定时远端 Fetch 间隔"
        />
        <div className="settings__row">
          <div className="settings__label">
            Git 任务并发数
            <small>统一限制同步、状态读取、远端刷新、同步前检查的并发数量（{MIN_SYNC_CONCURRENCY} - {MAX_SYNC_CONCURRENCY}）</small>
          </div>
          <div className="concurrency-control">
            <button
              className="concurrency-control__step"
              onClick={() => stepSyncConcurrency(-1)}
              aria-label="减少 Git 任务并发数"
            >
              -
            </button>
            <input
              type="text"
              inputMode="numeric"
              className="concurrency-control__input"
              value={String(maxSyncConcurrency)}
              onChange={(e) => setSyncConcurrency(e.target.value.replace(/[^\d]/g, ''))}
              aria-label="Git 任务并发数"
            />
            <button
              className="concurrency-control__step"
              onClick={() => stepSyncConcurrency(1)}
              aria-label="增加 Git 任务并发数"
            >
              +
            </button>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__label">同步模式<small>自动：按间隔执行；手动：仅点击同步时执行</small></div>
          <div className="mode-btn-group">
            <button className={`mode-btn ${settings.defaultSyncMode === 'auto' ? 'mode-btn--active' : ''}`}
              onClick={() => update('defaultSyncMode', 'auto')}>自动</button>
            <button className={`mode-btn ${settings.defaultSyncMode === 'manual' ? 'mode-btn--active' : ''}`}
              onClick={() => update('defaultSyncMode', 'manual')}>手动</button>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__label">拉取策略<small>rebase 保持历史线性（推荐），merge 保留完整合并记录</small></div>
          <div className="mode-btn-group">
            <button className={`mode-btn ${settings.defaultPullStrategy === 'rebase' ? 'mode-btn--active' : ''}`}
              onClick={() => update('defaultPullStrategy', 'rebase')}>Rebase</button>
            <button className={`mode-btn ${settings.defaultPullStrategy === 'merge' ? 'mode-btn--active' : ''}`}
              onClick={() => update('defaultPullStrategy', 'merge')}>Merge</button>
          </div>
        </div>
        {Object.entries(SYNC_GUARD_RULE_CONFIG).map(([rule, config]) => (
          <div className="settings__row" key={rule}>
            <div className="settings__label">
              同步前检查：{config.label}
              <small>{config.helpText}</small>
            </div>
            <div className="mode-btn-group">
              <button
                className={`mode-btn ${syncGuardPolicies[rule] === SYNC_GUARD_POLICY.block ? 'mode-btn--active' : ''}`}
                onClick={() => updateSyncGuardPolicy(rule, SYNC_GUARD_POLICY.block)}
              >
                阻断
              </button>
              <button
                className={`mode-btn ${syncGuardPolicies[rule] === SYNC_GUARD_POLICY.warn ? 'mode-btn--active' : ''}`}
                onClick={() => updateSyncGuardPolicy(rule, SYNC_GUARD_POLICY.warn)}
              >
                仅警告
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* GitHub */}
      <div className="settings__section">
        <h2 className="settings__section-title">GitHub</h2>
        <div className="settings__row">
          <div className="settings__label">
            GitHub 账号
            <small>登录后可浏览账号仓库并从 GitHub 批量克隆</small>
          </div>
          {githubAccount ? (
            <div className="github-settings-account">
              <img src={githubAccount.avatar_url} alt="" className="github-settings-account__avatar" />
              <div className="github-settings-account__main">
                <strong>{githubAccount.login}</strong>
                {githubAccount.name ? <span>{githubAccount.name}</span> : null}
              </div>
              <button className="github-settings-account__btn" onClick={onGithubLogout}>
                登出
              </button>
            </div>
          ) : (
            <button className="github-settings-login-btn" onClick={onGithubLogin}>
              <Icons.github className="icon icon--sm" />
              <span>登录 GitHub</span>
            </button>
          )}
        </div>
        <div className="settings__row">
          <div className="settings__label">
            默认隐藏已添加仓库
            <small>打开 GitHub 仓库浏览器时，默认隐藏已经在列表中的仓库</small>
          </div>
          <button
            className={`toggle ${settings.hideExistingGithubReposByDefault ? 'toggle--active' : ''}`}
            onClick={() => update('hideExistingGithubReposByDefault', !settings.hideExistingGithubReposByDefault)}
            aria-pressed={settings.hideExistingGithubReposByDefault}
            aria-label="切换默认隐藏已添加仓库"
          />
        </div>
      </div>

      {/* 应用设置 */}
      <div className="settings__section">
        <h2 className="settings__section-title">应用设置</h2>
        <div className="settings__row">
          <div className="settings__label">外观设置<small>主题</small></div>
          <div className="theme-switcher">
            <button
              className={`theme-btn ${theme === 'light' ? 'theme-btn--active' : ''}`}
              onClick={() => onThemeChange('light')}
              data-app-tooltip="浅色"
              aria-label="浅色"
            >
              <Icons.sun className="icon icon--sm" />
            </button>
            <button
              className={`theme-btn ${theme === 'dark' ? 'theme-btn--active' : ''}`}
              onClick={() => onThemeChange('dark')}
              data-app-tooltip="深色"
              aria-label="深色"
            >
              <Icons.moon className="icon icon--sm" />
            </button>
            <button
              className={`theme-btn ${theme === 'system' ? 'theme-btn--active' : ''}`}
              onClick={() => onThemeChange('system')}
              data-app-tooltip="跟随系统"
              aria-label="跟随系统"
            >
              <Icons.monitor className="icon icon--sm" />
            </button>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__label">系统通知<small>同步完成或遇到冲突时发送通知</small></div>
          <button className={`toggle ${settings.notifications ? 'toggle--active' : ''}`}
            onClick={() => update('notifications', !settings.notifications)}
            aria-pressed={settings.notifications}
            aria-label="切换系统通知" />
        </div>
        <div className="settings__row">
          <div className="settings__label">
            自动脚本日志弹窗
            <small>同步后自动触发脚本时，是否自动弹出日志窗口</small>
          </div>
          <button
            className={`toggle ${settings.autoOpenScriptLogDialog ? 'toggle--active' : ''}`}
            onClick={() => update('autoOpenScriptLogDialog', !settings.autoOpenScriptLogDialog)}
            aria-pressed={settings.autoOpenScriptLogDialog}
            aria-label="切换自动脚本日志弹窗"
          />
        </div>
        <div className="settings__row">
          <div className="settings__label">
            只在拉取后执行脚本
            <small>开启后仅在本次同步发生拉取时执行脚本；关闭后拉取或推送都执行</small>
          </div>
          <button
            className={`toggle ${settings.postSyncScriptPullOnly ? 'toggle--active' : ''}`}
            onClick={() => update('postSyncScriptPullOnly', !settings.postSyncScriptPullOnly)}
            aria-pressed={settings.postSyncScriptPullOnly}
            aria-label="切换只在拉取后执行脚本"
          />
        </div>
        <div className="settings__row">
          <div className="settings__label">
            默认打开应用
            <small>用于“用应用打开仓库”按钮，例如 VSCode</small>
          </div>
          <div className="open-app-picker">
            <div className="open-app-picker__value" data-app-tooltip={openAppPath || '未设置'}>
              {getAppDisplayName(openAppPath)}
            </div>
            <div className="open-app-picker__actions">
              <button className="open-app-picker__btn" onClick={pickDefaultOpenApp}>选择应用</button>
              {openAppPath ? (
                <button className="open-app-picker__btn open-app-picker__btn--ghost" onClick={() => update('defaultOpenApp', '')}>
                  清除
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="settings__row">
          <div className="settings__label">
            默认终端应用
            <small>用于“用终端打开”按钮，例如 Terminal、iTerm、Windows Terminal</small>
          </div>
          <div className="open-app-picker">
            <div className="open-app-picker__value" data-app-tooltip={terminalAppPath || '未设置'}>
              {getAppDisplayName(terminalAppPath)}
            </div>
            <div className="open-app-picker__actions">
              <button className="open-app-picker__btn" onClick={pickDefaultTerminalApp}>选择终端</button>
              {terminalAppPath ? (
                <button className="open-app-picker__btn open-app-picker__btn--ghost" onClick={() => update('defaultTerminalApp', '')}>
                  清除
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* 诊断 */}
      <div className="settings__section">
        <h2 className="settings__section-title">诊断</h2>
        <div className="settings__row">
          <div className="settings__label">
            诊断日志
            <small>合并复制同步阶段/结果与最近的应用错误（含未捕获异常和 Git 错误原文）到剪贴板，可能包含仓库名</small>
          </div>
          <button type="button" className="settings__action-btn" onClick={onCopyDiagnostics}>
            复制诊断日志
          </button>
        </div>
      </div>

      {/* 关于 */}
      <div className="settings__section">
        <h2 className="settings__section-title">关于</h2>
        <div className="settings__row">
          <div className="settings__label">GitSync<small>自动同步你的 Git 仓库，保持多设备代码一致</small></div>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{formatReleaseVersion(appVersion)}</span>
        </div>
        <div className="settings__row">
          <div className="settings__label">
            软件更新
            <small>{updaterSupported ? (updateMessage || '启动时在后台检查并下载 GitSync 更新') : 'Windows 便携版仍需手动更新；NSIS 安装版支持应用内更新'}</small>
          </div>
          {updaterSupported ? (
            <button
              type="button"
              className="settings__action-btn"
              disabled={updateBusy}
              onClick={['ready', 'restartRequired'].includes(updatePhase) ? onInstallUpdate : onCheckForUpdates}
            >
              {updateActionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SyncHistoryCenter({ entries, onClear, totalReposCount = 0 }) {
  const [keyword, setKeyword] = useState('')
  const [resultFilter, setResultFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [collapsedGroups, setCollapsedGroups] = useState({})

  const normalizedKeyword = keyword.trim().toLowerCase()
  const filteredEntries = filterSyncHistoryEntries(entries, normalizedKeyword, resultFilter, sourceFilter)
  const groupedEntries = groupSyncHistoryEntries(filteredEntries)
  const historyGroups = groupSyncHistoryEntries(entries)
  const historyRepoCount = historyGroups.length
  const filteredRepoCount = groupedEntries.length
  const failedRepoCount = historyGroups.filter((group) => group.failed > 0).length
  const latestSyncTimestamp = entries.reduce((latest, entry) => Math.max(latest, getSyncHistorySortTime(entry)), 0)
  const latestSyncText = formatRelativeSyncTimeCompact(latestSyncTimestamp)
  const historyMetaItems = [
    { key: 'total', text: `仓库总数 ${totalReposCount}` },
    { key: 'history', text: `有历史仓库 ${historyRepoCount}` },
    { key: 'filtered', text: `当前筛选 ${filteredRepoCount}`, tone: 'accent' },
    { key: 'failed', text: `失败仓库 ${failedRepoCount}`, tone: 'alert' },
    { key: 'latest', text: `最近同步 ${latestSyncText}` },
  ]
  const stats = getSyncHistoryStats(entries)
  const averageDuration = stats.durationCount > 0
    ? Math.round(stats.durationTotal / stats.durationCount)
    : 0
  const toggleGroup = (key) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="history-center">
      <div className="history-center__header">
        <div>
          <h1 className="history-center__title">同步历史中心</h1>
          <p className="history-center__subtitle">追踪每次同步的开始/结束、耗时、结果和错误摘要。</p>
        </div>
        <div className="batch-toolbar__actions">
          <button className="history-center__clear-btn" onClick={onClear}>
            清空历史
          </button>
        </div>
      </div>

      <div className="history-center__stats">
        <div className="history-stat-card">
          <div className="history-stat-card__label">总记录</div>
          <div className="history-stat-card__value">{stats.total}</div>
        </div>
        <div className="history-stat-card">
          <div className="history-stat-card__label">成功</div>
          <div className="history-stat-card__value history-stat-card__value--success">{stats.success}</div>
        </div>
        <div className="history-stat-card">
          <div className="history-stat-card__label">失败</div>
          <div className="history-stat-card__value history-stat-card__value--failed">{stats.failed}</div>
        </div>
        <div className="history-stat-card">
          <div className="history-stat-card__label">取消</div>
          <div className="history-stat-card__value history-stat-card__value--canceled">{stats.canceled}</div>
        </div>
        <div className="history-stat-card">
          <div className="history-stat-card__label">平均耗时</div>
          <div className="history-stat-card__value">{formatSyncHistoryDuration(averageDuration)}</div>
        </div>
      </div>

      <div className="history-center__filters">
        <input
          className="history-center__search"
          type="text"
          placeholder="搜索仓库、分支、提交、错误摘要"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <CustomSelect
          className="history-center__select"
          value={resultFilter}
          options={SYNC_HISTORY_RESULT_FILTER_OPTIONS}
          onChange={setResultFilter}
          ariaLabel="历史结果筛选"
        />
        <CustomSelect
          className="history-center__select"
          value={sourceFilter}
          options={SYNC_HISTORY_SOURCE_FILTER_OPTIONS}
          onChange={setSourceFilter}
          ariaLabel="历史来源筛选"
        />
      </div>

      <div className="history-center__list-meta">
        {historyMetaItems.map((item, index) => (
          <span
            className={`history-center__meta-item ${item.tone ? `history-center__meta-item--${item.tone}` : ''}`.trim()}
            key={item.key}
          >
            {index > 0 ? <span className="history-center__meta-sep">·</span> : null}
            {item.text}
          </span>
        ))}
      </div>

      <div className="history-center__list">
        {groupedEntries.length === 0 ? (
          <div className="history-center__empty">暂无符合条件的同步历史记录。</div>
        ) : (
          groupedEntries.map((group) => {
            const isCollapsed = Boolean(collapsedGroups[group.key])
            return (
              <section className="history-group" key={group.key}>
                <button
                  className={`history-group__header ${isCollapsed ? 'history-group__header--collapsed' : ''}`}
                  onClick={() => toggleGroup(group.key)}
                >
                  <div className="history-group__head-main">
                    <div className="history-group__repo">{group.repoName}</div>
                    <div className="history-group__path" data-app-tooltip={group.repoPath || ''}>{group.repoPath || '-'}</div>
                  </div>
                  <div className="history-group__head-right">
                    <span className="history-group__count">共 {group.entries.length} 条</span>
                    <span className="history-group__summary history-group__summary--success">成功 {group.success}</span>
                    <span className="history-group__summary history-group__summary--failed">失败 {group.failed}</span>
                    <span className="history-group__summary history-group__summary--canceled">取消 {group.canceled}</span>
                    <span className={`history-group__arrow ${isCollapsed ? 'history-group__arrow--collapsed' : ''}`}>
                      <Icons.arrowDown className="icon icon--xs" />
                    </span>
                  </div>
                </button>

                <div className={`history-group__entries-wrap ${isCollapsed ? 'history-group__entries-wrap--collapsed' : ''}`}>
                  <div className="history-group__entries">
                    {group.entries.map((entry) => (
                      <article className="history-entry" key={entry.id}>
                        <div className="history-entry__head">
                          <div className="history-entry__repo">{entry.repoName || '未知仓库'}</div>
                          <div className="history-entry__head-right">
                            <span className={`history-entry__result history-entry__result--${entry.result}`}>
                              {SYNC_HISTORY_RESULT_LABELS[entry.result] || entry.result}
                            </span>
                            <span className="history-entry__time">{formatSyncHistoryDateTime(entry.finishedAt)}</span>
                          </div>
                        </div>

                        <div className="history-entry__meta">
                          <span>来源：{SYNC_HISTORY_SOURCE_LABELS[entry.source] || entry.source || '未知'}</span>
                          <span>尝试：#{entry.attempt || 1}</span>
                          <span data-app-tooltip={entry.requestId || entry.jobId || ''}>诊断：{entry.requestId || entry.jobId || '-'}</span>
                          <span>耗时：{formatSyncHistoryDuration(entry.durationMs)}</span>
                          <span>分支：{entry.branch || '-'}</span>
                          <span>提交：{entry.commitHash || '-'}</span>
                        </div>

                        {entry.commitMessage ? (
                          <div className="history-entry__commit" data-app-tooltip={entry.commitMessage}>
                            提交信息：{entry.commitMessage}
                          </div>
                        ) : null}

                        {entry.message ? (
                          <div className="history-entry__message">{entry.message}</div>
                        ) : null}

                        {entry.errorSummary && entry.errorSummary !== entry.message ? (
                          <div className="history-entry__error">{entry.errorSummary}</div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}

function CommitHistorySkeleton() {
  const skeletonGroups = [
    { label: '今天', rows: 3 },
    { label: '昨天', rows: 2 },
    { label: '2026/07/03', rows: 2 },
  ]

  return (
    <div className="commit-history-timeline commit-history-timeline--skeleton" aria-hidden="true">
      {skeletonGroups.map((group) => (
        <section className="commit-history-day" key={`commit-history-skeleton-${group.label}`}>
          <div className="commit-history-day__label">{group.label}</div>
          <div className="commit-history-day__list">
            {Array.from({ length: group.rows }).map((_, index) => (
              <article
                className="commit-history-row commit-history-row--skeleton"
                key={`commit-history-skeleton-${group.label}-${index}`}
              >
                <div className="commit-history-row__rail" aria-hidden="true">
                  <span className="commit-history-row__dot" />
                </div>
                <div className="commit-history-row__bubble">
                  <div className="commit-history-row__summary">
                    <span className="commit-history-skeleton__line commit-history-skeleton__line--hash" />
                    <div className="commit-history-row__message-wrap">
                      <span className="commit-history-skeleton__line commit-history-skeleton__line--title" />
                    </div>
                  </div>
                  <div className="commit-history-row__meta">
                    <span className="commit-history-skeleton__line commit-history-skeleton__line--author" />
                    <span className="commit-history-skeleton__line commit-history-skeleton__line--time" />
                  </div>
                  <div className="commit-history-row__actions" aria-hidden="true">
                    <span className="commit-history-row__icon-btn commit-history-row__copy commit-history-row__icon-btn--skeleton" />
                    <span className="commit-history-row__icon-btn commit-history-row__diff commit-history-row__icon-btn--skeleton" />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function CommitHistoryHeroCard({
  repoId,
  heroStartRect,
  closing = false,
  layoutSignature = '',
  onReturnComplete,
  onFlightAbort,
  onFlightStart,
  onFlightReady,
  children,
}) {
  const rootRef = useRef(null)
  const [flightStyle, setFlightStyle] = useState(null)
  const [slotStyle, setSlotStyle] = useState(null)
  const [flightPhase, setFlightPhase] = useState('preparing')
  const flightPhaseRef = useRef('preparing')
  const completeReturn = useCallback((finalFlightRect = null) => {
    if (!closing) return
    if (
      finalFlightRect
      && !areCommitHistoryFlightEndpointsAligned(finalFlightRect, heroStartRect)
    ) {
      onFlightAbort?.()
      return
    }
    const currentTargetRect = getRepoCardProjectedRestingRect(repoId)
    if (!areCommitHistoryFlightEndpointsAligned(currentTargetRect, heroStartRect)) {
      onFlightAbort?.()
      return
    }
    onReturnComplete?.(finalFlightRect)
  }, [closing, heroStartRect, onFlightAbort, onReturnComplete, repoId])
  const settleOpening = useCallback((preserveSlot = false) => {
    if (closing) return
    flightPhaseRef.current = 'settled'
    setFlightPhase('settled')
    setFlightStyle(null)
    setSlotStyle((current) => {
      if (!preserveSlot || !current?.height) return null
      return {
        width: current.width,
        height: current.height,
        minHeight: current.height,
      }
    })
    onFlightReady?.()
  }, [closing, onFlightReady])

  useLayoutEffect(() => {
    flightPhaseRef.current = 'preparing'
    setFlightPhase('preparing')
    setFlightStyle(null)
    setSlotStyle(null)
  }, [closing, heroStartRect, layoutSignature])

  useLayoutEffect(() => {
    if (flightPhase !== 'preparing') return

    const node = rootRef.current
    if (!node) return

    if (!heroStartRect) {
      if (closing) {
        // Closing waits for the parent to measure the post-close dashboard
        // layout. The source card remains a hidden layout placeholder while
        // that measurement transaction is prepared.
        return
      } else {
        settleOpening(false)
      }
      return
    }

    const targetRect = node.getBoundingClientRect()
    if (!targetRect.width || !targetRect.height) {
      if (closing) {
        onFlightAbort?.()
      } else {
        settleOpening(false)
      }
      return
    }

    const startRect = closing ? targetRect : heroStartRect
    const endRect = closing ? heroStartRect : targetRect
    const nextFlightStyle = {
      '--commit-history-flight-start-left': `${startRect.left}px`,
      '--commit-history-flight-start-top': `${startRect.top}px`,
      '--commit-history-flight-start-width': `${startRect.width}px`,
      '--commit-history-flight-end-left': `${endRect.left}px`,
      '--commit-history-flight-end-top': `${endRect.top}px`,
      '--commit-history-flight-end-width': `${endRect.width}px`,
    }
    const nextSlotStyle = {
      width: `${targetRect.width}px`,
      height: `${targetRect.height}px`,
    }

    flightPhaseRef.current = 'flying'
    setSlotStyle(nextSlotStyle)
    setFlightStyle(nextFlightStyle)
    setFlightPhase('flying')
    onFlightStart?.(closing ? 'closing' : 'opening')
  }, [closing, flightPhase, heroStartRect, onFlightAbort, onFlightStart, settleOpening])

  useEffect(() => {
    if (flightPhase !== 'flying' || typeof window === 'undefined') return undefined

    const mainContent = document.querySelector('.main-content')
    const dashboardShell = document.querySelector('.dashboard-shell')
    const sourceCard = Array.from(document.querySelectorAll('[data-repo-card-id]')).find((item) => (
      item?.dataset?.repoCardId === String(repoId || '')
        && !item.closest('.commit-history-stage')
    ))
    const baseline = {
      mainWidth: mainContent?.getBoundingClientRect().width || 0,
      shellWidth: dashboardShell?.getBoundingClientRect().width || 0,
      sourceRect: getRepoCardProjectedRestingRect(repoId),
      scrollTop: mainContent?.scrollTop || 0,
    }
    let armed = false
    let armFrame = 0
    let observer = null

    const safeSettle = () => {
      if (!armed || flightPhaseRef.current !== 'flying') return
      if (closing) {
        completeReturn()
        return
      }
      settleOpening(false)
    }

    const handleScroll = (event) => {
      if (event.target !== mainContent) return
      if (Math.abs((mainContent?.scrollTop || 0) - baseline.scrollTop) > 0.5) {
        safeSettle()
      }
    }

    const handleResize = () => safeSettle()
    const handleResizeObservation = () => {
      if (!armed) return
      const currentMain = mainContent?.getBoundingClientRect()
      const currentShell = dashboardShell?.getBoundingClientRect()
      const currentSource = getRepoCardProjectedRestingRect(repoId)
      // Status refreshes may change natural height without changing the
      // compact Hero endpoint. Project the source rect out of the main-content
      // transform so the normal panel handoff does not look like invalidation.
      // Explicit resize/scroll handlers still abort the flight when the
      // viewport or scroll position actually changes.
      const changed = [
        [currentMain?.width || 0, baseline.mainWidth],
        [currentShell?.width || 0, baseline.shellWidth],
      ].some(([current, initial]) => Math.abs(current - initial) > 0.5)
        || !areCommitHistoryFlightEndpointsAligned(currentSource, baseline.sourceRect)
      if (changed) safeSettle()
    }

    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleScroll, true)
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(handleResizeObservation)
      if (mainContent) observer.observe(mainContent)
      if (dashboardShell) observer.observe(dashboardShell)
      if (sourceCard) observer.observe(sourceCard)
    }
    armFrame = window.requestAnimationFrame(() => {
      armed = true
    })

    return () => {
      window.cancelAnimationFrame(armFrame)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
      observer?.disconnect()
    }
  }, [closing, completeReturn, flightPhase, repoId, settleOpening])

  const className = [
    'commit-history-hero-card',
    flightPhase === 'preparing' ? 'commit-history-hero-card--preparing' : '',
    flightPhase === 'flying' ? 'commit-history-hero-card--geometry-ready' : '',
    flightPhase === 'settled' ? 'commit-history-hero-card--settled' : '',
    !closing && flightPhase !== 'settled' ? 'commit-history-hero-card--opening' : '',
    closing ? 'commit-history-hero-card--closing' : '',
  ].filter(Boolean).join(' ')
  const handleAnimationEnd = (event) => {
    if (
      event.target !== rootRef.current
      || event.animationName !== 'commitHistoryFlight'
      || flightPhaseRef.current !== 'flying'
    ) {
      return
    }
    if (closing) {
      const finalFlightRect = rootRef.current?.getBoundingClientRect()
      completeReturn(finalFlightRect)
      return
    }
    settleOpening(true)
  }

  return (
    <div
      className="commit-history-hero-slot"
      style={slotStyle || undefined}
    >
      <div
        ref={rootRef}
        className={className}
        style={flightStyle || undefined}
        data-commit-history-flight-phase={flightPhase}
        data-commit-history-flight-direction={closing ? 'closing' : 'opening'}
        aria-hidden={closing || flightPhase !== 'settled' ? 'true' : undefined}
        inert={closing || flightPhase !== 'settled' || undefined}
        onAnimationEnd={handleAnimationEnd}
      >
        {children}
      </div>
    </div>
  )
}

function CommitHistoryToolbar({
  cacheEntry,
  count,
  loadState,
  storeReady,
  fallbackHeadHash = '',
  selectedBranchRef,
  selectedBranchLabel,
  branchOptions,
  branchOverviewLoading,
  branchOverviewError,
  embedded = false,
  interactive = true,
  onRefresh,
  onCountChange,
  onBranchChange,
}) {
  const branch = selectedBranchLabel || selectedBranchRef || 'main'
  const safeBranchOptions = Array.isArray(branchOptions) && branchOptions.length > 0
    ? branchOptions
    : [{ value: selectedBranchRef || branch, label: branch, displayName: branch }]
  const branchSelectValue = normalizeCommitHistoryBranchName(
    selectedBranchRef || safeBranchOptions[0]?.value || branch
  )
  const isLoading = Boolean(loadState?.loading)
  const isRefreshing = Boolean(loadState?.refreshing)
  const errorMessage = String(loadState?.error || '').trim()
  const cacheText = cacheEntry
    ? formatCommitHistoryCacheAge(cacheEntry.fetchedAt)
    : (storeReady ? '尚未缓存' : '读取缓存中')
  const headHash = String(cacheEntry?.headHash || fallbackHeadHash || '').trim()
  const headHashText = headHash || (isRefreshing || isLoading ? '读取中' : '暂无提交')
  const branchHelperText = branchOverviewLoading
    ? '读取分支中...'
    : '切换下拉分支仅影响历史记录，不会切换仓库分支'
  const refreshButtonText = isRefreshing || isLoading ? '刷新中' : '刷新'
  const refreshAriaLabel = isRefreshing || isLoading ? '正在刷新提交历史' : '刷新提交历史'
  const refreshErrorText = errorMessage
    ? (cacheEntry ? '刷新失败，正在显示缓存内容' : `刷新失败：${errorMessage}`)
    : ''
  const className = [
    'commit-history-toolbar',
    embedded ? 'commit-history-toolbar--embedded' : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={className}
      aria-label="提交历史选项"
      aria-hidden={interactive ? undefined : 'true'}
      inert={interactive ? undefined : true}
    >
      <div className="commit-history-toolbar__head">
        <div className="commit-history-toolbar__title">
          <Icons.commitHistory className="icon icon--sm" />
          <span>历史选项</span>
        </div>
        <div className="commit-history-toolbar__cache">
          <Icons.clock className="icon icon--xs" />
          <span>{cacheText}</span>
        </div>
      </div>

      <div className="commit-history-toolbar__body">
        <div className="commit-history-toolbar__branch">
          <div className="commit-history-toolbar__label-row">
            <span>历史分支</span>
            <span>{branchHelperText}</span>
          </div>
          <div className="commit-history-toolbar__control-row">
            <CustomSelect
              value={branchSelectValue}
              options={safeBranchOptions}
              onChange={onBranchChange}
              ariaLabel="选择提交历史分支"
              className="commit-history-toolbar__branch-select"
            />
            <div className="commit-history-toolbar__actions">
              <div className="commit-history-toolbar__count" role="group" aria-label="提交数量">
                {COMMIT_HISTORY_COUNT_OPTIONS.map((option) => (
                  <button
                    key={option}
                    className={`commit-history-toolbar__count-btn ${count === option ? 'commit-history-toolbar__count-btn--active' : ''}`}
                    onClick={() => onCountChange(option)}
                    type="button"
                  >
                    {option}
                  </button>
                ))}
              </div>
              <button
                className="commit-history-toolbar__refresh"
                onClick={() => onRefresh({ force: true })}
                disabled={isRefreshing || isLoading}
                type="button"
                aria-label={refreshAriaLabel}
              >
                {isRefreshing || isLoading ? <span className="spinning"><Icons.sync className="icon icon--xs" /></span> : <Icons.sync className="icon icon--xs" />}
                <span>{refreshButtonText}</span>
              </button>
            </div>
          </div>
          <div
            className="commit-history-toolbar__branch-meta"
            data-app-tooltip={headHash ? `历史分支 HEAD: ${headHash}` : undefined}
          >
            <span>历史分支 HEAD</span>
            <span className={`commit-history-toolbar__hash ${headHash ? '' : 'commit-history-toolbar__hash--pending'}`}>{headHashText}</span>
          </div>
        </div>
      </div>

      {branchOverviewError || refreshErrorText ? (
        <div className="commit-history-toolbar__meta">
          {branchOverviewError ? <span className="commit-history-toolbar__warning">分支列表读取失败：{branchOverviewError}</span> : null}
          {refreshErrorText ? <span className="commit-history-toolbar__warning">{refreshErrorText}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function CommitHistoryRow({ commit, index, repoContext, onCopyHash }) {
  const [expanded, setExpanded] = useState(false)
  const [messageOverflowing, setMessageOverflowing] = useState(false)
  const messageTextRef = useRef(null)
  const message = String(commit?.message || '').trim() || '-'
  const hash = String(commit?.hash || '').trim()
  const author = String(commit?.author || '').trim()
  const commitDate = String(commit?.date || '').trim()
  const localDate = commit?.date ? formatGitCommitLocalTime(commit.date) : ''
  const rowTime = localDate.includes(' ')
    ? localDate.split(' ')[1].slice(0, 5)
    : localDate
  const isRemoteCommit = commit?.source === 'remote'
  const commitBranchName = normalizeCommitHistoryBranchName(commit?.branch) || repoContext?.branchName
  const canToggle = expanded || messageOverflowing
  const canOpenDiff = Boolean(hash && repoContext?.repoPath)
  const rowClassName = [
    'commit-history-row',
    isRemoteCommit ? 'commit-history-row--remote' : '',
    expanded ? 'commit-history-row--expanded' : '',
  ].filter(Boolean).join(' ')
  const measureMessageOverflow = useCallback(() => {
    if (expanded) return
    const node = messageTextRef.current
    const nextOverflowing = Boolean(node && node.scrollWidth > node.clientWidth + 1)
    setMessageOverflowing((prev) => (prev === nextOverflowing ? prev : nextOverflowing))
  }, [expanded])

  useLayoutEffect(() => {
    if (expanded) return undefined
    const node = messageTextRef.current
    if (!node) return undefined

    measureMessageOverflow()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measureMessageOverflow)
      observer.observe(node)
      if (node.parentElement) observer.observe(node.parentElement)
      return () => observer.disconnect()
    }

    if (typeof window === 'undefined') return undefined
    window.addEventListener('resize', measureMessageOverflow)
    return () => window.removeEventListener('resize', measureMessageOverflow)
  }, [expanded, measureMessageOverflow, message])

  const openCommitDiff = () => {
    if (!canOpenDiff || typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(COMMIT_DIFF_OPEN_EVENT, {
      detail: {
        repoName: repoContext.repoName,
        repoPath: repoContext.repoPath,
        branchName: commitBranchName,
        commit: {
          hash,
          message,
          author,
          date: commitDate,
        },
      },
    }))
  }

  return (
    <article className={rowClassName} key={`${hash}-${commit?.date}-${index}`}>
      <div className="commit-history-row__rail" aria-hidden="true">
        <span className="commit-history-row__dot" />
      </div>
      <div className="commit-history-row__bubble">
        <div className="commit-history-row__summary">
          <span className="commit-history-row__hash">{hash || '-'}</span>
          <div className="commit-history-row__message-wrap">
            <div className="commit-history-row__title" data-app-tooltip={message}>
              <span ref={messageTextRef} className="commit-history-row__message-text">{message}</span>
              {canToggle ? (
                <button
                  className="commit-history-row__toggle"
                  onClick={() => setExpanded((prev) => !prev)}
                  type="button"
                >
                  {expanded ? '收起' : '展开'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="commit-history-row__meta">
          {isRemoteCommit ? <span className="commit-history-row__source">远端</span> : null}
          {author ? <span>{author}</span> : null}
          {rowTime ? (
            <span>
              <Icons.clock className="icon icon--xs" />
              {rowTime}
            </span>
          ) : null}
        </div>
        <div className="commit-history-row__actions" aria-label="提交操作">
          <button
            className="commit-history-row__icon-btn commit-history-row__copy"
            onClick={() => onCopyHash(hash)}
            disabled={!hash}
            data-app-tooltip={hash ? `复制 ${hash}` : '没有可复制的 hash'}
            aria-label={hash ? `复制提交 ${hash}` : '没有可复制的提交 hash'}
            type="button"
          >
            <Icons.copy className="icon icon--xs" />
          </button>
          <button
            className="commit-history-row__icon-btn commit-history-row__diff"
            onClick={openCommitDiff}
            disabled={!canOpenDiff}
            data-app-tooltip={canOpenDiff ? `查看 ${hash} 的文件改动` : '没有可查看的提交 Diff'}
            aria-label={canOpenDiff ? `查看提交 ${hash} 的文件改动` : '没有可查看的提交 Diff'}
            type="button"
          >
            <Icons.diff className="icon icon--xs" />
          </button>
        </div>
      </div>
    </article>
  )
}

function CommitHistoryDrawer({
  repo,
  status,
  branchName,
  cacheEntry,
  loadState,
  closing,
  interactive = true,
  onClose,
  onRefresh,
  onCopyHash,
  onCopyBranchName,
}) {
  const closeButtonRef = useRef(null)

  useEffect(() => {
    if (!repo || closing || !interactive) return
    closeButtonRef.current?.focus({ preventScroll: true })
  }, [closing, interactive, repo?.id])

  if (!repo) return null

  const latestCommit = getRepoLatestCommitDisplay(status, repo)
  const currentBranchName = getCommitHistoryDefaultBranch(repo, status)
  const viewedBranchName = normalizeCommitHistoryBranchName(branchName || currentBranchName)
  const commits = Array.isArray(cacheEntry?.commits) ? cacheEntry.commits : []
  const remoteCommits = Array.isArray(cacheEntry?.remoteCommits) ? cacheEntry.remoteCommits : []
  const groups = groupCommitHistoryCommits(commits)
  const remoteGroups = groupCommitHistoryCommits(remoteCommits)
  const isLoading = Boolean(loadState?.loading)
  const errorMessage = String(loadState?.error || '').trim()
  const hasCommits = commits.length > 0
  const hasRemoteCommits = remoteCommits.length > 0
  const hasAnyCommits = hasCommits || hasRemoteCommits
  const showSkeleton = isLoading && !hasAnyCommits
  const showErrorOnly = Boolean(errorMessage) && !hasAnyCommits && !isLoading
  const drawerSubtitle = `${repo.path || '-'}`
  const latestHash = String(latestCommit.hash || '').trim()
  const repoContext = {
    repoName: String(repo.name || '未知仓库').trim() || '未知仓库',
    repoPath: String(repo.path || '').trim(),
    branchName: viewedBranchName,
  }
  const drawerClassName = [
    'commit-history-drawer',
    closing ? 'commit-history-drawer--closing' : '',
  ].filter(Boolean).join(' ')

  return (
    <aside
      className={drawerClassName}
      aria-label={`${repo.name} 提交历史`}
      aria-hidden={interactive ? undefined : 'true'}
      inert={interactive ? undefined : true}
    >
      <div className="commit-history-drawer__header">
        <div className="commit-history-drawer__title-row">
          <div>
            <div className="commit-history-drawer__eyebrow">提交历史</div>
            <h2 className="commit-history-drawer__title">{repo.name || '未知仓库'}</h2>
          </div>
          <button ref={closeButtonRef} className="github-repo-browser__close commit-history-drawer__close" onClick={onClose} aria-label="关闭提交历史">
            <Icons.close className="icon icon--sm" />
          </button>
        </div>

        <div className="commit-history-drawer__path" data-app-tooltip={drawerSubtitle}>{drawerSubtitle}</div>

        {latestHash ? (
          <div className="commit-history-drawer__latest">
            <span>当前分支</span>
            <span className="commit-history-drawer__branch-name" data-app-tooltip={currentBranchName}>{currentBranchName}</span>
            <span>最新提交</span>
            <span className="commit-history-drawer__hash">{latestHash}</span>
          </div>
        ) : null}
      </div>

      <div className="commit-history-drawer__body">
        <div className="commit-history-drawer__view-branch" data-app-tooltip={`查看分支: ${viewedBranchName}`}>
          <span>查看分支</span>
          <span className="commit-history-drawer__branch-name">{viewedBranchName}</span>
          <button
            className="commit-history-row__icon-btn commit-history-drawer__branch-copy"
            onClick={() => onCopyBranchName?.(viewedBranchName)}
            disabled={!viewedBranchName}
            data-app-tooltip={viewedBranchName ? `复制查看分支 ${viewedBranchName}` : '没有可复制的查看分支'}
            aria-label={viewedBranchName ? `复制查看分支 ${viewedBranchName}` : '没有可复制的查看分支'}
            type="button"
          >
            <Icons.copy className="icon icon--xs" />
          </button>
        </div>

        {showSkeleton ? <CommitHistorySkeleton /> : null}

        {showErrorOnly ? (
          <div className="commit-history-drawer__empty commit-history-drawer__empty--error">
            <Icons.warning className="icon icon--md" />
            <div>
              <strong>无法读取提交历史</strong>
              <p>{errorMessage}</p>
            </div>
            <button className="commit-history-drawer__retry" onClick={() => onRefresh({ force: true })}>
              重试
            </button>
          </div>
        ) : null}

        {!showSkeleton && !showErrorOnly && !hasAnyCommits ? (
          <div className="commit-history-drawer__empty">
            <Icons.clock className="icon icon--md" />
            <div>
              <strong>当前历史暂无提交</strong>
              <p>本地分支和已缓存的远端跟踪分支都没有可显示的提交。</p>
            </div>
          </div>
        ) : null}

        {!showSkeleton && hasAnyCommits ? (
          <div className="commit-history-timeline">
            {hasRemoteCommits ? remoteGroups.map((group) => (
              <section className="commit-history-day commit-history-day--remote" key={`remote-${group.label}`}>
                <div className="commit-history-day__label">{group.label}</div>
                <div className="commit-history-day__list">
                  {group.commits.map((commit, index) => (
                    <CommitHistoryRow
                      commit={commit}
                      index={index}
                      key={`remote-${commit.hash}-${commit.date}-${index}`}
                      repoContext={repoContext}
                      onCopyHash={onCopyHash}
                    />
                  ))}
                </div>
              </section>
            )) : null}

            {hasRemoteCommits ? (
              <div className="commit-history-remote-divider" role="separator">
                <span className="commit-history-remote-divider__line" />
                <span className="commit-history-remote-divider__label">
                  <strong>本地提交</strong>
                  {viewedBranchName ? <span>{viewedBranchName}</span> : null}
                </span>
                <span className="commit-history-remote-divider__line" />
              </div>
            ) : null}

            {hasCommits ? groups.map((group, groupIndex) => (
              <section
                className={[
                  'commit-history-day',
                  hasRemoteCommits && groupIndex === 0 ? 'commit-history-day--after-remote-divider' : '',
                ].filter(Boolean).join(' ')}
                key={group.label}
              >
                <div className="commit-history-day__label">{group.label}</div>
                <div className="commit-history-day__list">
                  {group.commits.map((commit, index) => (
                    <CommitHistoryRow
                      commit={commit}
                      index={index}
                      key={`${commit.hash}-${commit.date}-${index}`}
                      repoContext={repoContext}
                      onCopyHash={onCopyHash}
                    />
                  ))}
                </div>
              </section>
            )) : null}
          </div>
        ) : null}
      </div>

    </aside>
  )
}

// ==================== 主应用 ====================

// 「连不上 GitHub」和「没登录」必须给用户不同的出路：前者要保留凭据并提示网络/代理，
// 后者才该走登录流程。设置页的登录按钮与导入菜单的「GitHub 仓库」共用这段文案。
function buildGithubConnectivityNotice(restored) {
  const detail = restored?.message ? `：${restored.message}` : ''
  return {
    title: '无法连接 GitHub',
    message:
      `读取 GitHub 账号失败${detail}\n\n` +
      '你的登录凭据仍然保存在钥匙串中。如果正在使用代理或 VPN，请确认 api.github.com 可访问后重试。',
  }
}

function App() {
  const [page, setPage] = useState('dashboard')
  const [repos, setRepos] = useState([])
  const [repoStatuses, setRepoStatuses] = useState({})
  const [repoBranchOverviews, setRepoBranchOverviews] = useState({})
  const [dismissedBranchAttentionKeys, setDismissedBranchAttentionKeys] = useState(() => (
    parseDismissedBranchAttentionKeys(
      readLocalStorageItem(BRANCH_ATTENTION_DISMISSALS_STORAGE_KEY)
    )
  ))

  useBranchSnapshotAppBridge({
    repos,
    setRepoBranchOverviews,
    setRepoStatuses,
    setDismissedBranchAttentionKeys,
  })

  const [showLoading, setShowLoading] = useState(false)
  const loadingTimerRef = useRef(null)
  const loadingStartRef = useRef(0)
  const [conflictData, setConflictData] = useState(null)
  const [appReady, setAppReady] = useState(false)
  const [errorLogData, setErrorLogData] = useState(null)
  const [deleteConfirmData, setDeleteConfirmData] = useState(null)
  const [syncGuardDialogData, setSyncGuardDialogData] = useState(null)
  const [pendingGuardedSyncData, setPendingGuardedSyncData] = useState(null)
  const [importResultData, setImportResultData] = useState(null)
  const [importLoadingData, setImportLoadingData] = useState(null)
  const [importMenuAnchor, setImportMenuAnchor] = useState(null)
  /*
   * 侧边栏的开合是**持久偏好**，不是窗口宽度的函数：宽度只决定「用户还没表过态」时
   * 的默认值；一旦按下过收起/展开就写进 localStorage，之后调整窗口尺寸不再改变它。
   * 空字符串表示还没有偏好。
   */
  const [sidebarPreference, setSidebarPreference] = useState(() => readSidebarPanelPreference())
  const [toolbarNeedsCollapse, setToolbarNeedsCollapse] = useState(false)
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false)
  const [isCloningRepo, setIsCloningRepo] = useState(false)
  const [lastCloneParentPath, setLastCloneParentPath] = useState(() => readLocalStorageItem(CLONE_PARENT_PATH_STORAGE_KEY) || '')
  const [statusToastData, setStatusToastData] = useState(null)
  const [noticeData, setNoticeData] = useState(null)
  const [scriptLogDialogOpen, setScriptLogDialogOpen] = useState(false)
  const [scriptLogSessions, setScriptLogSessions] = useState([])
  const [activeScriptLogSessionId, setActiveScriptLogSessionId] = useState(null)
  const [removingRepo, setRemovingRepo] = useState(false)
  const [isRemoveMutationRunning, setIsRemoveMutationRunning] = useState(false)
  const [restoringRemovedRepos, setRestoringRemovedRepos] = useState(false)
  const [undoRemoveData, setUndoRemoveData] = useState(null)
  const [syncJobs, setSyncJobs] = useState([])
  const [postSyncBuildStates, setPostSyncBuildStates] = useState({})
  const [syncHistory, setSyncHistory] = useState(loadSyncHistoryEntries)
  const [commitHistoryRepoId, setCommitHistoryRepoId] = useState(null)
  const [commitHistoryCount, setCommitHistoryCount] = useState(COMMIT_HISTORY_DEFAULT_COUNT)
  const [commitHistoryCache, setCommitHistoryCache] = useState(createEmptyCommitHistoryCache)
  const [commitHistoryStoreReady, setCommitHistoryStoreReady] = useState(false)
  const [commitHistoryBranchByRepo, setCommitHistoryBranchByRepo] = useState({})
  const [commitHistoryBranchOverviewState, setCommitHistoryBranchOverviewState] = useState({
    repoId: '',
    loading: false,
    error: '',
    overview: null,
  })
  const [commitHistoryDrawerClosing, setCommitHistoryDrawerClosing] = useState(false)
  const [commitHistoryHeroStartRect, setCommitHistoryHeroStartRect] = useState(null)
  const [commitHistoryHeroReady, setCommitHistoryHeroReady] = useState(false)
  const [commitHistoryFlightPhase, setCommitHistoryFlightPhase] = useState(COMMIT_HISTORY_FLIGHT_PHASE.closed)
  const [commitHistoryHandoffRepoId, setCommitHistoryHandoffRepoId] = useState(null)
  const [commitHistoryHandoffHeight, setCommitHistoryHandoffHeight] = useState(null)
  const [commitHistoryHandoffSourceHeight, setCommitHistoryHandoffSourceHeight] = useState(null)
  const commitHistoryFlightSnapshotRef = useRef(null)
  const commitHistoryHandoffHeightRef = useRef(null)
  const commitHistoryFocusReturnRepoIdRef = useRef(null)
  const commitHistoryFocusRestoreFrameRef = useRef(null)
  const [commitHistoryLoadState, setCommitHistoryLoadState] = useState({
    cacheKey: '',
    loading: false,
    refreshing: false,
    error: '',
  })
  const [batchMode, setBatchMode] = useState(false)
  const [selectedRepoIds, setSelectedRepoIds] = useState([])
  const [batchAction, setBatchAction] = useState(null)
  const [syncAllPreparingRepoIds, setSyncAllPreparingRepoIds] = useState([])
  const [syncChangedPreparingRepoIds, setSyncChangedPreparingRepoIds] = useState([])
  const [syncFilteredPreparingRepoIds, setSyncFilteredPreparingRepoIds] = useState([])
  const [syncCheckingRepoIds, setSyncCheckingRepoIds] = useState([])
  const [branchRefreshingRepoIds, setBranchRefreshingRepoIds] = useState([])
  const [missingRepoStates, setMissingRepoStates] = useState({})
  const [repoStatusIssues, setRepoStatusIssues] = useState({})
  const [statusIssueNowTick, setStatusIssueNowTick] = useState(() => Date.now())
  const [isFocusRefreshingAll, setIsFocusRefreshingAll] = useState(false)
  const [isDashboardSearchOpen, setIsDashboardSearchOpen] = useState(false)
  const [dashboardSearchKeyword, setDashboardSearchKeyword] = useState('')
  const [theme, setTheme, resolvedTheme] = useTheme()
  const [settings, setSettings] = useState(loadAppSettings)
  const [dashboardLayout, setDashboardLayout] = useState(() => {
    const saved = readLocalStorageItem(DASHBOARD_LAYOUT_KEY)
    // `masonry` is the legacy persisted value for the user-facing card layout.
    return normalizeDashboardLayout(saved)
  })
  const [dashboardRepoFilter, setDashboardRepoFilter] = useState(readDashboardRepoFilter)
  const [dashboardRepoSortMode, setDashboardRepoSortMode] = useState(readDashboardRepoSortMode)
  const [isWindowFocused, setIsWindowFocused] = useState(getWindowActivityState)
  const [appVersion, setAppVersion] = useState('读取中...')
  const [appUpdateState, setAppUpdateState] = useState({
    phase: 'idle',
    version: '',
    notes: '',
    downloadedBytes: 0,
    contentLength: 0,
    dismissed: true,
    error: '',
    restartBlocked: false,
  })
  const appUpdateControllerRef = useRef(null)
  const updateRestartAdmissionRef = useRef(false)
  const [updateRestartAdmissionActive, setUpdateRestartAdmissionActive] = useState(false)
  const [appUpdaterBundleType, setAppUpdaterBundleType] = useState(undefined)
  const updaterPlatform = isMacOSWebView() ? 'macos' : (isWindowsPlatform() ? 'windows' : null)
  const updaterSupported = isTauri()
    && supportsUpdaterForBundle(updaterPlatform, appUpdaterBundleType)
  const [isFetchingRemote, setIsFetchingRemote] = useState(false)
  // Synchronous guard: React state lags a fast double-click, so the state flag alone let a
  // second manual fetch enqueue a full extra remote-refresh round.
  const fetchAllRemotesInFlightRef = useRef(false)
  const isImportingRepos = Boolean(importLoadingData)
  const isRepoImportBusy = isImportingRepos || isCloningRepo

  // GitHub 登录状态
  const [githubAccount, setGithubAccount] = useState(null)
  const [deviceAuthDialogOpen, setDeviceAuthDialogOpen] = useState(false)
  const [githubRepoBrowserOpen, setGithubRepoBrowserOpen] = useState(false)
  const pendingGithubRepoBrowserOpenRef = useRef(false)
  const commitHistoryStoreRef = useRef(null)
  const commitHistorySaveTimerRef = useRef(null)
  const commitHistoryPendingSaveRef = useRef(null)
  const commitHistoryRequestIdRef = useRef(0)
  const commitHistoryBranchOverviewRequestIdRef = useRef(0)
  const commitHistoryCloseTimerRef = useRef(null)

  const flushCommitHistoryCacheSave = useCallback(async () => {
    const store = commitHistoryStoreRef.current
    const pendingCache = commitHistoryPendingSaveRef.current
    if (!store || !pendingCache) return

    try {
      await store.set(COMMIT_HISTORY_STORE_KEY, pendingCache)
      await store.save()
      if (commitHistoryPendingSaveRef.current === pendingCache) {
        commitHistoryPendingSaveRef.current = null
      }
    } catch (error) {
      console.error('提交历史缓存保存失败:', error)
    }
  }, [])

  const scheduleCommitHistoryCacheSave = useCallback((nextCache) => {
    commitHistoryPendingSaveRef.current = nextCache

    if (commitHistorySaveTimerRef.current) {
      clearTimeout(commitHistorySaveTimerRef.current)
      commitHistorySaveTimerRef.current = null
    }

    commitHistorySaveTimerRef.current = setTimeout(() => {
      commitHistorySaveTimerRef.current = null
      void flushCommitHistoryCacheSave()
    }, COMMIT_HISTORY_STORE_SAVE_DEBOUNCE_MS)
  }, [flushCommitHistoryCacheSave])

  const updateCommitHistoryCache = useCallback((updater, persist = true) => {
    setCommitHistoryCache((prev) => {
      const baseCache = normalizeCommitHistoryCache(prev)
      const nextCache = normalizeCommitHistoryCache(
        typeof updater === 'function' ? updater(baseCache) : updater
      )
      if (persist) scheduleCommitHistoryCacheSave(nextCache)
      return nextCache
    })
  }, [scheduleCommitHistoryCacheSave])

  useEffect(() => {
    let disposed = false

    async function loadCommitHistoryCacheStore() {
      try {
        const store = await loadStore(COMMIT_HISTORY_STORE_FILE, {
          defaults: {
            [COMMIT_HISTORY_STORE_KEY]: createEmptyCommitHistoryCache(),
          },
          autoSave: false,
        })
        const storedCache = await store.get(COMMIT_HISTORY_STORE_KEY)
        if (disposed) return
        commitHistoryStoreRef.current = store
        const normalizedStoredCache = normalizeCommitHistoryCache(storedCache)
        const pendingCache = commitHistoryPendingSaveRef.current
        if (pendingCache) {
          const normalizedPendingCache = normalizeCommitHistoryCache(pendingCache)
          const mergedCache = pruneCommitHistoryCache({
            version: COMMIT_HISTORY_CACHE_VERSION,
            entries: {
              ...normalizedStoredCache.entries,
              ...normalizedPendingCache.entries,
            },
          })
          commitHistoryPendingSaveRef.current = mergedCache
          setCommitHistoryCache(mergedCache)
          void flushCommitHistoryCacheSave()
          return
        }
        setCommitHistoryCache(normalizedStoredCache)
      } catch (error) {
        console.error('提交历史缓存读取失败:', error)
      } finally {
        if (!disposed) setCommitHistoryStoreReady(true)
      }
    }

    void loadCommitHistoryCacheStore()

    return () => {
      disposed = true
      if (commitHistorySaveTimerRef.current) {
        clearTimeout(commitHistorySaveTimerRef.current)
        commitHistorySaveTimerRef.current = null
      }
      void flushCommitHistoryCacheSave()
    }
  }, [flushCommitHistoryCacheSave])

  useEffect(() => {
    let isActive = true

    async function loadAppVersion() {
      try {
        const version = await getVersion()
        if (isActive && typeof version === 'string' && version.trim()) {
          setAppVersion(version.trim())
          return
        }
      } catch {
        // Ignore and fall back to unknown text.
      }

      if (isActive) {
        setAppVersion('未知版本')
      }
    }

    void loadAppVersion()

    return () => {
      isActive = false
    }
  }, [])

  useEffect(() => {
    if (!isTauri() || (!isMacOSWebView() && !isWindowsPlatform())) return undefined
    let isActive = true

    void getBundleType()
      .then((bundleType) => {
        if (isActive) setAppUpdaterBundleType(bundleType)
      })
      .catch(() => {
        if (isActive) setAppUpdaterBundleType(undefined)
      })

    return () => {
      isActive = false
    }
  }, [])

  useEffect(() => {
    const controller = createAppUpdaterController({
      checkForUpdate: () => checkForAppUpdate(),
      relaunch: () => relaunch(),
      acquireRestartGuard: () => invoke('acquire_app_restart_guard'),
      releaseRestartGuard: (token) => invoke('release_app_restart_guard', { token }),
      getRestartBlockers: async () => {
        const localBlockers = []
        const activeSyncJobs = syncJobsRef.current.filter((job) => (
          job.status === SYNC_JOB_STATUS.queued || job.status === SYNC_JOB_STATUS.running
        ))
        activeSyncJobs.forEach((job) => {
          localBlockers.push(`同步：${getSyncDiagnosticRepoName(reposRef.current, job.repoId) || job.repoId}`)
        })
        getActiveBranchOperationPaths().forEach((repoPath) => {
          localBlockers.push(`分支操作：${repoPath}`)
        })
        getActiveStashOperationPaths().forEach((repoPath) => {
          localBlockers.push(`Stash 操作：${repoPath}`)
        })
        runningPostSyncBuildRepoIdsRef.current.forEach((repoId) => {
          localBlockers.push(`同步后脚本：${getSyncDiagnosticRepoName(reposRef.current, repoId) || repoId}`)
        })
        const backendBlockers = await invoke('get_app_restart_blockers')
        return Array.from(new Set([
          ...localBlockers,
          ...(Array.isArray(backendBlockers) ? backendBlockers : []),
        ]))
      },
      onRestartIntent: (active) => {
        updateRestartAdmissionRef.current = active
        setUpdateRestartAdmissionActive(active)
      },
      onStateChange: setAppUpdateState,
      onManualCurrent: () => setNoticeData({ title: '检查更新', message: '当前已是最新版本。' }),
      onManualError: (message) => setNoticeData({ title: '检查更新失败', message }),
    })
    appUpdateControllerRef.current = controller
    return () => {
      if (appUpdateControllerRef.current === controller) {
        appUpdateControllerRef.current = null
      }
      void controller.dispose()
    }
  }, [])

  const checkForAppUpdates = useCallback(async ({ manual = false } = {}) => {
    if (!updaterSupported || import.meta.env.DEV) {
      if (manual) {
        setNoticeData({
          title: '自动更新不可用',
          message: isWindowsPlatform()
            ? '当前 Windows 便携版不支持应用内安装更新。请手动安装 GitSync NSIS 安装版；之后可在应用内更新。'
            : '应用内更新只在正式版 macOS 和 Windows NSIS 安装版中启用。',
        })
      }
      return
    }
    return appUpdateControllerRef.current?.check({ manual })
  }, [updaterSupported])

  const installAppUpdate = useCallback(() => (
    appUpdateControllerRef.current?.installOrRestart()
  ), [])

  useEffect(() => {
    if (!appReady || !updaterSupported || import.meta.env.DEV) return
    void checkForAppUpdates()
  }, [appReady, updaterSupported, checkForAppUpdates])

  const restoreGithubAccountOnDemand = useCallback(async () => {
    try {
      const result = await invoke('github_get_account')
      const status = result?.status
      if (status === 'ok' && result.account?.login) {
        setGithubAccount(result.account)
        return { account: result.account }
      }
      if (status === 'no-token' || status === 'unauthorized') {
        setGithubAccount(null)
        return { reason: status }
      }
      // 钥匙串读不到、网络不可达、GitHub 返回异常：这些都不是「未登录」。
      // 不清空已登录状态，也不要把用户推去重新走一遍授权，只记录原因交给调用方提示。
      const message = result?.message || '未知错误'
      appendAppErrorLogEntries([{
        scope: 'github-login',
        message: `读取 GitHub 账号失败（${status || 'unknown'}）：${message}`,
      }])
      return { reason: status || 'unknown', message }
    } catch (e) {
      const message = String(e?.message ?? e)
      appendAppErrorLogEntries([{
        scope: 'github-login',
        message: `读取 GitHub 账号失败：${message}`,
      }])
      return { reason: 'invoke-failed', message }
    }
  }, [])

  const handleGithubLogin = useCallback(async () => {
    const restored = await restoreGithubAccountOnDemand()
    if (restored?.account) {
      if (pendingGithubRepoBrowserOpenRef.current) {
        pendingGithubRepoBrowserOpenRef.current = false
        setGithubRepoBrowserOpen(true)
      }
      return
    }
    if (restored && restored.reason !== 'no-token' && restored.reason !== 'unauthorized') {
      // 连不上/读不到 ≠ 未登录：凭据还在，只提示问题，不把用户推去重新授权。
      setNoticeData(buildGithubConnectivityNotice(restored))
      return
    }
    pendingGithubRepoBrowserOpenRef.current = true
    setDeviceAuthDialogOpen(true)
  }, [restoreGithubAccountOnDemand])

  const handleGithubLogout = useCallback(async () => {
    try {
      await invoke('github_logout')
    } catch (_) {
      // 忽略错误
    }
    setGithubAccount(null)
    pendingGithubRepoBrowserOpenRef.current = false
    setGithubRepoBrowserOpen(false)
  }, [])

  useEffect(() => {
    if (!statusToastData) return
    const timer = setTimeout(() => {
      setStatusToastData(null)
    }, 6000)
    return () => clearTimeout(timer)
  }, [statusToastData])

  // Auto sync timers
  const syncTimersRef = useRef({})
  const syncingRepoIdsRef = useRef(new Set())
  const syncJobsRef = useRef([])
  const processingSyncJobIdsRef = useRef(new Set())
  const runningPostSyncBuildRepoIdsRef = useRef(new Set())
  const postSyncBuildResetTimersRef = useRef({})
  const scriptLogSessionsRef = useRef([])
  const reposRef = useRef([])
  const pageRef = useRef(page)
  const isWindowFocusedRef = useRef(isWindowFocused)
  const pendingRefreshOnFocusRef = useRef(new Set())
  const backgroundSyncRefreshRepoIdsRef = useRef(new Set())
  const fetchReposRequestedModeRef = useRef(FETCH_REPOS_MODE.light)
  const removeMutationCountRef = useRef(0)
  const removeInFlightRef = useRef(false)
  const initialRepoLoadStartedRef = useRef(false)
  const startupRemoteRefreshStartedRef = useRef(false)
  // The refresh state machines own the round counter, request coalescing, the in-flight
  // marker and the busy repository set; App only issues requests and reads snapshots.
  const remoteRefreshRunnerRef = useRef(null)
  const repoFetchRunnerRef = useRef(null)
  const branchRefreshRunnerRef = useRef(null)
  const remoteRefreshMachineRef = useRef(null)
  const repoFetchMachineRef = useRef(null)
  const branchRefreshMachineRef = useRef(null)
  if (!remoteRefreshMachineRef.current) {
    remoteRefreshMachineRef.current = createRefreshMachine({
      name: 'remote-refresh',
      runRound: (input, progress) => remoteRefreshRunnerRef.current(input, progress),
      mergeInput: (previous, next) => ({
        ...(previous || {}),
        ...next,
        manualOnly: Boolean(previous?.manualOnly && next?.manualOnly),
      }),
      getLatestInput: (input) => ({ ...input, repoList: reposRef.current }),
      onIdle: () => {
        lastRemoteRefreshFinishedAtRef.current = Date.now()
      },
    })
    repoFetchMachineRef.current = createRefreshMachine({
      name: 'repo-fetch',
      runRound: (input, progress) => repoFetchRunnerRef.current(input, progress),
      mergeInput: (previous, next) => ({
        ...(previous || {}),
        ...next,
        triggerStartupRemoteFetch: Boolean(
          previous?.triggerStartupRemoteFetch || next?.triggerStartupRemoteFetch
        ),
      }),
    })
    branchRefreshMachineRef.current = createRefreshMachine({
      name: 'branch-refresh',
      runRound: (input, progress) => branchRefreshRunnerRef.current(input, progress),
    })
  }
  const subscribeRemoteRefresh = useCallback(
    (listener) => remoteRefreshMachineRef.current.subscribe(listener),
    []
  )
  const readRemoteRefresh = useCallback(
    () => remoteRefreshMachineRef.current.getSnapshot(),
    []
  )
  const remoteRefreshSnapshot = useSyncExternalStore(subscribeRemoteRefresh, readRemoteRefresh)
  const subscribeBranchRefresh = useCallback(
    (listener) => branchRefreshMachineRef.current.subscribe(listener),
    []
  )
  const readBranchRefresh = useCallback(
    () => branchRefreshMachineRef.current.getSnapshot(),
    []
  )
  const branchRefreshSnapshot = useSyncExternalStore(subscribeBranchRefresh, readBranchRefresh)
  const syncCheckingRepoIdsRef = useRef(new Set())
  const branchRefreshingRepoIdsRef = useRef(new Set())
  const missingRepoIdsRef = useRef(new Set())
  const lastRemoteRefreshFinishedAtRef = useRef(0)
  const repoGridRef = useRef(null)
  const dashboardSearchToggleRef = useRef(null)
  const dashboardSearchFiltersRef = useRef(null)
  const dashboardToolbarControlsRef = useRef(null)
  const dashboardSearchInputRef = useRef(null)
  const dashboardToolbarRowRef = useRef(null)
  const [repoGridColumns, setRepoGridColumns] = useState(1)
  const gitTaskConcurrency = normalizeSyncConcurrency(settings.maxSyncConcurrency)

  const escDialogRefs = useRef({
    cloneDialogOpen: false,
    isCloningRepo: false,
    githubRepoBrowserOpen: false,
    scriptLogDialogOpen: false,
    conflictData: null,
    errorLogData: null,
    syncGuardDialogData: null,
    deviceAuthDialogOpen: false,
    noticeData: null,
    commitHistoryRepoId: null,
    isRepoImportBusy: false,
  })
  // Keep refs in sync with current state (runs every render)
  escDialogRefs.current.cloneDialogOpen = cloneDialogOpen
  escDialogRefs.current.isCloningRepo = isCloningRepo
  escDialogRefs.current.githubRepoBrowserOpen = githubRepoBrowserOpen
  escDialogRefs.current.scriptLogDialogOpen = scriptLogDialogOpen
  escDialogRefs.current.conflictData = conflictData
  escDialogRefs.current.errorLogData = errorLogData
  escDialogRefs.current.syncGuardDialogData = syncGuardDialogData
  escDialogRefs.current.deviceAuthDialogOpen = deviceAuthDialogOpen
  escDialogRefs.current.noticeData = noticeData
  escDialogRefs.current.commitHistoryRepoId = commitHistoryRepoId
  escDialogRefs.current.isRepoImportBusy = isRepoImportBusy

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== 'Escape') return
      const s = escDialogRefs.current
      let handled = false
      if (s.cloneDialogOpen && !s.isCloningRepo) { setCloneDialogOpen(false); handled = true }
      else if (s.githubRepoBrowserOpen && !s.isRepoImportBusy) { setGithubRepoBrowserOpen(false); handled = true }
      else if (s.scriptLogDialogOpen) { setScriptLogDialogOpen(false); handled = true }
      else if (s.conflictData) { setConflictData(null); handled = true }
      else if (s.errorLogData) { setErrorLogData(null); handled = true }
      else if (s.syncGuardDialogData) { setSyncGuardDialogData(null); handled = true }
      else if (s.deviceAuthDialogOpen) { setDeviceAuthDialogOpen(false); handled = true }
      else if (s.noticeData) { setNoticeData(null); handled = true }
      else if (s.commitHistoryRepoId) {
        setCommitHistoryRepoId(null)
        setCommitHistoryLoadState({ cacheKey: '', loading: false, refreshing: false, error: '' })
        handled = true
      }
      if (handled) {
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  const beginRemoveMutation = useCallback(() => {
    removeMutationCountRef.current += 1
    if (removeMutationCountRef.current > 0) {
      setIsRemoveMutationRunning(true)
    }
  }, [])

  const endRemoveMutation = useCallback(() => {
    removeMutationCountRef.current = Math.max(0, removeMutationCountRef.current - 1)
    if (removeMutationCountRef.current === 0) {
      setIsRemoveMutationRunning(false)
    }
  }, [])

  const setRepoSyncChecking = useCallback((repoId, checking) => {
    if (repoId == null || repoId === '') return
    const next = new Set(syncCheckingRepoIdsRef.current)
    const hasRepoId = next.has(repoId)
    if (checking && hasRepoId) return
    if (!checking && !hasRepoId) return
    if (checking) next.add(repoId)
    else next.delete(repoId)
    syncCheckingRepoIdsRef.current = next
    setSyncCheckingRepoIds(Array.from(next))
  }, [])

  const setRepoBranchRefreshing = useCallback((repoId, branchRefreshing) => {
    if (repoId == null || repoId === '') return
    const next = new Set(branchRefreshingRepoIdsRef.current)
    const hasRepoId = next.has(repoId)
    if (branchRefreshing && hasRepoId) return
    if (!branchRefreshing && !hasRepoId) return
    if (branchRefreshing) next.add(repoId)
    else next.delete(repoId)
    branchRefreshingRepoIdsRef.current = next
    setBranchRefreshingRepoIds(Array.from(next))
  }, [])

  const markRepoPathMissing = useCallback((repoId, message = '') => {
    const normalizedRepoId = String(repoId || '').trim()
    if (!normalizedRepoId) return
    const normalizedMessage = normalizeMissingRepoMessage(message)
    setMissingRepoStates((prev) => {
      const current = prev[normalizedRepoId]
      if (current?.message === normalizedMessage) return prev
      return {
        ...prev,
        [normalizedRepoId]: {
          message: normalizedMessage,
          detectedAt: Date.now(),
        },
      }
    })
  }, [])

  const clearRepoPathMissing = useCallback((repoId) => {
    const normalizedRepoId = String(repoId || '').trim()
    if (!normalizedRepoId) return
    setMissingRepoStates((prev) => {
      if (!prev[normalizedRepoId]) return prev
      const next = { ...prev }
      delete next[normalizedRepoId]
      return next
    })
  }, [])

  const clearRepoStatusIssue = useCallback((repoId, kind = null) => {
    const normalizedRepoId = String(repoId || '').trim()
    if (!normalizedRepoId) return
    setRepoStatusIssues((prev) => {
      const current = prev[normalizedRepoId]
      if (!current) return prev
      if (!kind) {
        const next = { ...prev }
        delete next[normalizedRepoId]
        return next
      }
      if (!current[kind]) return prev
      const nextEntry = { ...current }
      delete nextEntry[kind]
      const next = { ...prev }
      if (!hasRepoStatusIssue(nextEntry)) {
        delete next[normalizedRepoId]
      } else {
        next[normalizedRepoId] = nextEntry
      }
      return next
    })
  }, [])

  const markRepoStatusIssue = useCallback((repoId, kind, detail) => {
    const normalizedRepoId = String(repoId || '').trim()
    if (!normalizedRepoId || !kind) return
    const issue = createRepoStatusIssue(kind, detail)
    setRepoStatusIssues((prev) => {
      const current = prev[normalizedRepoId] || {}
      const existing = current[kind]
      if (existing?.message === issue.message && existing?.detail === issue.detail) {
        return prev
      }
      return {
        ...prev,
        [normalizedRepoId]: {
          ...current,
          [kind]: issue,
        },
      }
    })
  }, [])

  const getRepoFallbackName = useCallback((repoId) => {
    return reposRef.current.find((repo) => repo.id === repoId)?.name || repoId
  }, [])

  // General error log: every failure funnel records through this helper so a packaged
  // build can copy the real reason instead of only the generic card text.
  const recordAppError = useCallback(({ scope, repoId = '', repoName = '', message }) => {
    const normalizedMessage = String(message || '').trim()
    if (!normalizedMessage) return
    appendAppErrorLogEntries([{
      scope,
      repoId,
      repoName: repoName || (repoId ? getRepoFallbackName(repoId) : ''),
      message: normalizedMessage,
    }])
  }, [getRepoFallbackName])

  useEffect(() => {
    const handleWindowError = (event) => {
      const message = String(event?.message || '').trim()
      if (!message) return
      recordAppError({ scope: 'uncaught-error', message })
    }
    const handleUnhandledRejection = (event) => {
      const message = getErrorMessage(event?.reason)
      if (!message || message === 'undefined' || message === 'null') return
      recordAppError({ scope: 'unhandled-rejection', message })
    }
    window.addEventListener('error', handleWindowError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    return () => {
      window.removeEventListener('error', handleWindowError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [recordAppError])

  const markMissingRepoFromMessage = useCallback((repoId, sourceMessage) => {
    const errorMessage = getErrorMessage(sourceMessage)
    if (!isRepoPathMissingError(errorMessage)) {
      return { matched: false, errorMessage }
    }
    markRepoPathMissing(repoId, errorMessage)
    return { matched: true, errorMessage }
  }, [markRepoPathMissing])

  // The single place a `get_repo_status` result is applied. A watchdog expiry
  // (`status_timed_out`) means the working tree is unknown, not empty: keep the last
  // known status and surface a precise warning instead of reporting the repo clean.
  const applyRepoStatusResult = useCallback((repoId, status) => {
    const normalizedRepoId = String(repoId || '').trim()
    if (!normalizedRepoId) return false
    if (status?.status_timed_out) {
      markRepoStatusIssue(
        normalizedRepoId,
        'statusRefresh',
        '读取工作区状态超时，已保留上次结果'
      )
      return false
    }
    clearRepoStatusIssue(normalizedRepoId, 'statusRefresh')
    setRepoStatuses((prev) => (
      prev[normalizedRepoId] === status ? prev : { ...prev, [normalizedRepoId]: status }
    ))
    return true
  }, [clearRepoStatusIssue, markRepoStatusIssue])

  const resolveRepoStatusIssueFromError = useCallback((repoId, kind, error, onMissing = null) => {
    const { matched, errorMessage } = markMissingRepoFromMessage(repoId, error)
    recordAppError({
      scope: kind === 'remoteFetch' ? 'remote-fetch' : 'status-refresh',
      repoId,
      message: errorMessage,
    })
    if (matched) {
      clearRepoStatusIssue(repoId)
      onMissing?.()
      return { matched: true, errorMessage }
    }
    markRepoStatusIssue(repoId, kind, errorMessage)
    return { matched: false, errorMessage }
  }, [clearRepoStatusIssue, markMissingRepoFromMessage, markRepoStatusIssue, recordAppError])

  const reportRefreshFailures = useCallback((failures, failureFeedback) => {
    if (!Array.isArray(failures) || failures.length === 0) return
    if (failureFeedback === 'dialog') {
      setNoticeData({
        title: '获取更新失败',
        message: buildRefreshFailureNoticeMessage(failures),
      })
      return
    }
    if (failureFeedback === 'toast') {
      setStatusToastData({
        title: '初始刷新失败',
        message: buildRefreshFailureToastMessage(failures),
      })
    }
  }, [])

  const handleRepoBranchOverviewChanged = useCallback((repoId, overview, repoPath) => {
    const normalizedRepoId = String(repoId || '').trim()
    if (!normalizedRepoId) return
    const currentRepo = reposRef.current.find((repo) => (
      String(repo?.id || '').trim() === normalizedRepoId
    ))
    if (!currentRepo) return
    const normalizedCallbackPath = normalizeBranchRepoPath(repoPath)
    if (
      !normalizedCallbackPath
      || normalizeBranchRepoPath(currentRepo.path) !== normalizedCallbackPath
    ) return
    if (!getBranchAttentionKey(overview)) {
      setDismissedBranchAttentionKeys((prev) => {
        if (!prev[normalizedRepoId]) return prev
        const next = { ...prev }
        delete next[normalizedRepoId]
        return next
      })
    }
    setRepoBranchOverviews((prev) => {
      if (prev[normalizedRepoId] === overview) return prev
      return { ...prev, [normalizedRepoId]: overview || null }
    })
  }, [])

  const handleDismissBranchAttention = useCallback((repoId, attentionKey) => {
    const normalizedRepoId = String(repoId || '').trim()
    const normalizedAttentionKey = String(attentionKey || '').trim()
    if (!normalizedRepoId || !normalizedAttentionKey) return
    setDismissedBranchAttentionKeys((prev) => (
      prev[normalizedRepoId] === normalizedAttentionKey
        ? prev
        : { ...prev, [normalizedRepoId]: normalizedAttentionKey }
    ))
  }, [])

  const handleBranchOperationFeedback = useCallback((feedback) => {
    if (!feedback?.message) return
    setStatusToastData(feedback)
  }, [])

  async function runRemoteRefreshRound(input, progress) {
    const { repoList, manualOnly = false, failureFeedback = 'none' } = input || {}
    const syncingRepoIdSet = syncingRepoIdsRef.current
    const reposToRefresh = getReposForRemoteRefresh(
      repoList,
      manualOnly,
      missingRepoIdsRef.current
    )
      .filter((repo) => !syncingRepoIdSet.has(repo.id))
    if (reposToRefresh.length === 0) return
    progress.track(reposToRefresh.map((repo) => repo.id))
    const refreshFailures = []

    await mapWithConcurrencyLimit(
      reposToRefresh,
      gitTaskConcurrency,
      async (repo) => {
        const repoLabel = repo.name || repo.id || repo.path
        try {
          await invoke('refresh_repo_remote', { path: repo.path })
          clearRepoStatusIssue(repo.id, 'remoteFetch')
          try {
            const overview = await invoke('get_repo_branch_overview', { path: repo.path })
            handleRepoBranchOverviewChanged(repo.id, overview || null, repo.path)
          } catch (overviewError) {
            console.warn(`读取分支动态失败: ${repo.path}`, overviewError)
          }
        } catch (error) {
          const { matched, errorMessage } = resolveRepoStatusIssueFromError(
            repo.id,
            'remoteFetch',
            error
          )
          if (matched) {
            return
          }
          refreshFailures.push({
            name: repoLabel,
            message: errorMessage,
          })
          console.warn(`刷新远程信息失败: ${repo.path}`, error)
        } finally {
          // Retire this repo's overlay as soon as its own fetch settles: the machine
          // derives 获取更新中... from these calls instead of a whole-round flag.
          progress.settle(repo.id)
        }
      }
    )

    reportRefreshFailures(refreshFailures, failureFeedback)

    if (pageRef.current === 'dashboard') {
      if (isWindowFocusedRef.current) {
        const refreshMode = removeMutationCountRef.current > 0
          ? FETCH_REPOS_MODE.light
          : FETCH_REPOS_MODE.full
        await fetchRepos({ mode: refreshMode })
      } else {
        addPendingFocusRefreshReason(
          pendingRefreshOnFocusRef,
          FOCUS_REFRESH_REASON.remoteRefresh
        )
      }
    }
  }
  remoteRefreshRunnerRef.current = runRemoteRefreshRound

  async function refreshRepoRemoteState(repoList, options = {}) {
    return await remoteRefreshMachineRef.current.request({
      repoList,
      manualOnly: options?.manualOnly === true,
      failureFeedback: options?.failureFeedback || 'none',
    })
  }

  const handleFetchAllRemotes = async () => {
    if (fetchAllRemotesInFlightRef.current) return
    fetchAllRemotesInFlightRef.current = true
    setIsFetchingRemote(true)
    try {
      await refreshRepoRemoteState(reposRef.current, {
        manualOnly: false,
        failureFeedback: 'dialog',
      })
    } finally {
      fetchAllRemotesInFlightRef.current = false
      setIsFetchingRemote(false)
    }
  }

  async function runBranchRefreshRound(input, progress) {
    const repo = input?.repo
    if (!repo) return
    progress.track([repo.id])
    try {
      await invoke('refresh_repo_remote', { path: repo.path })
      clearRepoStatusIssue(repo.id, 'remoteFetch')
    } catch (error) {
      const { matched, errorMessage } = resolveRepoStatusIssueFromError(
        repo.id,
        'remoteFetch',
        error
      )
      if (matched) return
      throw new Error(errorMessage)
    } finally {
      progress.settle(repo.id)
    }
  }
  branchRefreshRunnerRef.current = runBranchRefreshRound

  async function handleRepoBranchChanged(repoId, options = {}) {
    const remoteAlreadyFetched = options?.remoteAlreadyFetched === true
    return await refreshRepoAfterBranchChangeWithGroupRetention({
      repoId,
      repoList: reposRef.current,
      refreshRepoRemote: remoteAlreadyFetched ? undefined : async (repo) => {
        await branchRefreshMachineRef.current.request({ repo })
      },
      refreshRepoStatus: async (repo) => {
        const repoLabel = repo.name || repo.id || repo.path
        const nextStatus = await invoke('get_repo_status', { path: repo.path })
        clearRepoPathMissing(repo.id)
        applyRepoStatusResult(repo.id, nextStatus)
      },
      refreshRepoMetadata: async (repo) => {
        const updatedRepo = await invoke('refresh_repo_git_metadata', { repoId: repo.id })
        if (!updatedRepo?.id) return
        setRepos((prev) => {
          const next = prev.map((item) => (item.id === updatedRepo.id ? updatedRepo : item))
          reposRef.current = next
          return next
        })
      },
      setRepoBranchRefreshing,
    })
  }

  async function runFetchReposRound(input) {
    const shouldTriggerStartupRemoteFetch = input?.triggerStartupRemoteFetch === true
    const roundMode = normalizeFetchReposMode(fetchReposRequestedModeRef.current)
    fetchReposRequestedModeRef.current = FETCH_REPOS_MODE.light
    let data = null
    let hasRepos = false
    try {
      data = await invoke('get_repos', { metadataConcurrency: gitTaskConcurrency })
      const fetchedRepos = Array.isArray(data) ? data : []
      // Foreground refresh chains read reposRef immediately after fetchRepos resolves.
      // Keep the ref in step with this fresh backend snapshot before React effects run.
      reposRef.current = fetchedRepos
      setRepos(fetchedRepos)
      hasRepos = fetchedRepos.length > 0

      if (pageRef.current === 'dashboard' && roundMode === FETCH_REPOS_MODE.full) {
        const nextMissingRepoIds = new Set(missingRepoIdsRef.current)
        const activeSyncingRepoIds = new Set(syncingRepoIdsRef.current)
        await mapWithConcurrencyLimit(
          fetchedRepos,
          gitTaskConcurrency,
          async (repo) => {
            if (nextMissingRepoIds.has(repo.id)) {
              return
            }
            if (activeSyncingRepoIds.has(repo.id) || repo.status === 'syncing') {
              clearRepoStatusIssue(repo.id, 'statusRefresh')
              return
            }
            const repoLabel = repo.name || repo.id || repo.path
            try {
              const status = await invoke('get_repo_status', { path: repo.path })
              nextMissingRepoIds.delete(repo.id)
              clearRepoPathMissing(repo.id)
              // 渐进式更新：每拿到一个仓库状态立即刷新 UI，避免一次性批量更新的卡顿感
              applyRepoStatusResult(repo.id, status)
            } catch (error) {
              const { matched, errorMessage } = resolveRepoStatusIssueFromError(
                repo.id,
                'statusRefresh',
                error,
                () => {
                  nextMissingRepoIds.add(repo.id)
                }
              )
              if (matched) {
                return
              }
              console.warn(`获取仓库状态失败: ${repo.path}`, error)
            }
          }
        )
        // 收尾：标记缺失仓库为 null，并清理已失效的 repo
        const finalMissing = new Set(nextMissingRepoIds)
        setRepoStatuses((prev) => {
          const next = {}
          fetchedRepos.forEach((repo) => {
            if (finalMissing.has(repo.id)) {
              next[repo.id] = null
              return
            }
            next[repo.id] = prev[repo.id] ?? null
          })
          return next
        })
      } else {
        const validIds = new Set(fetchedRepos.map((repo) => repo.id))
        setRepoStatuses((prev) => {
          let changed = false
          const next = {}
          fetchedRepos.forEach((repo) => {
            if (Object.prototype.hasOwnProperty.call(prev, repo.id)) {
              next[repo.id] = prev[repo.id]
            } else {
              next[repo.id] = null
              changed = true
            }
          })
          Object.keys(prev).forEach((repoId) => {
            if (!validIds.has(repoId)) {
              changed = true
            }
          })
          return changed || Object.keys(prev).length !== Object.keys(next).length ? next : prev
        })
      }

      if (
        shouldTriggerStartupRemoteFetch
        && !startupRemoteRefreshStartedRef.current
        && hasRepos
      ) {
        startupRemoteRefreshStartedRef.current = true
        setTimeout(() => {
          const latestRepoList = reposRef.current.length > 0 ? reposRef.current : fetchedRepos
          void refreshRepoRemoteState(latestRepoList, {
            manualOnly: false,
            failureFeedback: 'toast',
          })
        }, 0)
      }

    } catch (e) {
      console.error('加载仓库失败:', e)
    } finally {
      clearTimeout(loadingTimerRef.current)
      const finishLoad = () => {
        setShowLoading(false)
        if (!appReady) {
          setAppReady(true)
        }
      }
      if (loadingStartRef.current > 0) {
        const elapsed = Date.now() - loadingStartRef.current
        const MIN_VISIBLE = 600
        if (elapsed < MIN_VISIBLE) {
          setTimeout(finishLoad, MIN_VISIBLE - elapsed)
        } else {
          finishLoad()
        }
      } else {
        finishLoad()
      }
    }
  }
  repoFetchRunnerRef.current = runFetchReposRound

  const fetchRepos = useCallback(async (options = {}) => {
    const requestedMode = options?.mode === FETCH_REPOS_MODE.light
      ? FETCH_REPOS_MODE.light
      : FETCH_REPOS_MODE.full
    fetchReposRequestedModeRef.current = mergeFetchReposMode(
      fetchReposRequestedModeRef.current,
      requestedMode
    )
    await repoFetchMachineRef.current.request({
      mode: requestedMode,
      triggerStartupRemoteFetch: options?.triggerStartupRemoteFetch === true,
    })
  }, [])

  const refreshRepoStatusesByIds = useCallback(async (repoIds) => {
    if (!repoIds || repoIds.length === 0) return
    const repoIdSet = repoIds instanceof Set
      ? repoIds
      : new Set(Array.isArray(repoIds) ? repoIds : Array.from(repoIds || []))
    if (repoIdSet.size === 0) return
    const activeSyncingRepoIds = new Set(syncingRepoIdsRef.current)
    const targetRepos = reposRef.current.filter((repo) => {
      if (!repoIdSet.has(repo.id)) return false
      if (missingRepoIdsRef.current.has(repo.id)) return false
      if (activeSyncingRepoIds.has(repo.id) || repo.status === 'syncing') return false
      return typeof repo.path === 'string' && repo.path.trim().length > 0
    })
    if (targetRepos.length === 0) return

    await mapWithConcurrencyLimit(
      targetRepos,
      gitTaskConcurrency,
      async (repo) => {
        const repoLabel = repo.name || repo.id || repo.path
        try {
          const status = await invoke('get_repo_status', { path: repo.path })
          clearRepoPathMissing(repo.id)
          applyRepoStatusResult(repo.id, status)
        } catch (error) {
          resolveRepoStatusIssueFromError(
            repo.id,
            'statusRefresh',
            error,
            () => {
              setRepoStatuses((prev) => ({ ...prev, [repo.id]: null }))
            }
          )
          console.warn(`获取仓库状态失败: ${repo.path}`, error)
        }
      }
    )
  }, [clearRepoPathMissing, clearRepoStatusIssue, gitTaskConcurrency, resolveRepoStatusIssueFromError])

  const refreshAfterSyncCompletion = useCallback(async (repoId) => {
    const normalizedRepoId = String(repoId || '').trim()
    if (!normalizedRepoId) return

    const action = getSyncCompletionRefreshAction({
      isWindowFocused: isWindowFocusedRef.current,
    })
    if (action === DASHBOARD_REFRESH_ACTION.repoListAndLocalStatuses) {
      await fetchRepos()
      return
    }

    if (action === DASHBOARD_REFRESH_ACTION.completedRepoStatus) {
      await fetchRepos({ mode: FETCH_REPOS_MODE.light })
      await refreshRepoStatusesByIds([normalizedRepoId])
    }
  }, [fetchRepos, refreshRepoStatusesByIds])

  useEffect(() => {
    const handleWorkingChangesChanged = (event) => {
      const repoId = String(event?.detail?.repoId || '').trim()
      if (!repoId) return
      void refreshRepoStatusesByIds([repoId])
    }
    window.addEventListener(REPO_WORKING_CHANGES_CHANGED_EVENT, handleWorkingChangesChanged)
    return () => window.removeEventListener(REPO_WORKING_CHANGES_CHANGED_EVENT, handleWorkingChangesChanged)
  }, [refreshRepoStatusesByIds])

  useEffect(() => {
    if (initialRepoLoadStartedRef.current) return
    initialRepoLoadStartedRef.current = true
    loadingTimerRef.current = setTimeout(() => {
      loadingStartRef.current = Date.now()
      setShowLoading(true)
    }, 400)
    void fetchRepos({ triggerStartupRemoteFetch: true })
    return () => clearTimeout(loadingTimerRef.current)
  }, [fetchRepos])

  useEffect(() => {
    pageRef.current = page
  }, [page])

  useEffect(() => {
    if (page !== 'dashboard') {
      setImportMenuAnchor(null)
    }
  }, [page])

  // 顶栏一行放不下时收起侧边栏，把这 240px 还给主区，而不是让顶栏换行。
  // 宽度是实测的：字号、字体回退和语言都会改变顶栏的自然宽度，写死断点会漂移。
  const measureToolbarFit = useCallback(() => {
    const row = dashboardToolbarRowRef.current
    const controls = row?.querySelector('.dashboard-toolbar__controls')
    const actions = row?.querySelector('.dashboard-toolbar__actions')
    if (!row || !controls || !actions) {
      setToolbarNeedsCollapse(false)
      return
    }

    const rowGap = Number.parseFloat(getComputedStyle(row).columnGap) || 0
    // 强制单行量一次，得到的是「一行所需宽度」而不是当前换行后的宽度。
    // 类在同一帧内加删，浏览器不会把它绘制出来。
    row.classList.add('dashboard__header-actions--measure')
    const requiredRowWidth = controls.scrollWidth + actions.scrollWidth + rowGap
    row.classList.remove('dashboard__header-actions--measure')

    const rootStyle = getComputedStyle(document.documentElement)
    const sidebarWidth = Number.parseFloat(rootStyle.getPropertyValue('--sidebar-width'))
    const mainContent = document.querySelector('.main-content')
    const mainStyle = mainContent ? getComputedStyle(mainContent) : null
    const mainPadding = mainStyle
      ? (Number.parseFloat(mainStyle.paddingLeft) || 0) + (Number.parseFloat(mainStyle.paddingRight) || 0)
      : 0

    setToolbarNeedsCollapse(shouldCollapseSidebar({
      requiredRowWidth,
      sidebarWidth,
      mainPadding,
      windowWidth: window.innerWidth,
    }))
  }, [])

  // 顶栏那个开关按钮：窄屏走浮层形态，宽屏走「让不让出这一列」。
  // 两条路径分开是因为它们的落点不同（浮层 vs 栅格列），动画也不一样。
  // 侧边栏右上角的收起、顶栏左上角的展开，是同一件事：翻转并持久化这个偏好。
  // 形态（浮层 vs 栅格列）仍由宽度决定，但**开合本身不再由宽度决定**。
  const handleToggleSidebar = useCallback(() => {
    setSidebarPreference((previous) => {
      // 默认值与 resolveSidebarPanelLayout 必须一致：没有偏好时是「展开」。
      const isVisible = previous
        ? previous === SIDEBAR_PANEL_PREFERENCE.expanded
        : true
      return isVisible
        ? SIDEBAR_PANEL_PREFERENCE.collapsed
        : SIDEBAR_PANEL_PREFERENCE.expanded
    })
  }, [toolbarNeedsCollapse])

  useEffect(() => {
    // 离开仪表盘时不再动开合偏好（那是跨会话的持久选择），只清掉导入菜单这类瞬时状态。
    if (page === 'dashboard') return
    setImportMenuAnchor(null)
  }, [page])

  useEffect(() => {
    if (page !== 'dashboard' || !appReady) {
      setToolbarNeedsCollapse(false)
      return undefined
    }
    measureToolbarFit()
    // 顶栏用的 Inter 是外部字体，字体就绪后宽度会变，就绪后再量一次。
    let cancelled = false
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready
        .then(() => { if (!cancelled) measureToolbarFit() })
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [page, appReady, measureToolbarFit])

  useEffect(() => {
    let frame = 0
    const handleResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => measureToolbarFit())
    }
    window.addEventListener('resize', handleResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', handleResize)
    }
  }, [measureToolbarFit])

  useEffect(() => {
    // 偏好一旦变化就落盘；空字符串会清掉这一项（回到「跟随宽度」）。
    writeSidebarPanelPreference(sidebarPreference)
  }, [sidebarPreference])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined

    const setWindowActivity = (next) => {
      setIsWindowFocused((prev) => (prev === next ? prev : next))
    }

    const handleWindowFocus = () => setWindowActivity(true)
    const handleWindowBlur = () => setWindowActivity(false)
    const handleVisibilityChange = () => setWindowActivity(document.visibilityState !== 'hidden')

    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    isWindowFocusedRef.current = isWindowFocused
    if (!isWindowFocused) {
      const activeSyncRepoIds = getCurrentActiveSyncRepoIds(
        syncJobsRef.current,
        syncingRepoIdsRef.current
      )
      activeSyncRepoIds.forEach((repoId) => {
        backgroundSyncRefreshRepoIdsRef.current.add(repoId)
      })
      setPendingFocusRefreshReasons(
        pendingRefreshOnFocusRef,
        getPendingFocusRefreshReasonsAfterHidden(
          pendingRefreshOnFocusRef.current,
          { hasActiveSync: activeSyncRepoIds.size > 0 }
        )
      )
      setIsFocusRefreshingAll(false)
    }
  }, [isWindowFocused])

  useEffect(() => {
    if (!isWindowFocused) return
    if (!hasPendingFocusRefreshReasons(pendingRefreshOnFocusRef.current)) return
    if (isRemoveMutationRunning) return
    setPendingFocusRefreshReasons(pendingRefreshOnFocusRef, [])
    backgroundSyncRefreshRepoIdsRef.current.clear()
    if (pageRef.current === 'dashboard' && reposRef.current.length > 0) {
      setIsFocusRefreshingAll(true)
    }
    void (async () => {
      try {
        const action = getForegroundRefreshAction({
          repoCount: reposRef.current.length,
        })
        if (action === DASHBOARD_REFRESH_ACTION.repoListAndLocalStatuses) {
          await fetchRepos({ mode: FETCH_REPOS_MODE.light })
          await refreshRepoStatusesByIds(reposRef.current.map((repo) => repo.id))
        } else if (action === DASHBOARD_REFRESH_ACTION.repoList) {
          await fetchRepos({ mode: FETCH_REPOS_MODE.light })
        }
      } finally {
        setIsFocusRefreshingAll(false)
      }
    })()
  }, [fetchRepos, isRemoveMutationRunning, isWindowFocused, refreshRepoStatusesByIds])

  useEffect(() => {
    writeLocalStorageItem('gitsync-settings', JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    writeLocalStorageItem(SYNC_HISTORY_STORAGE_KEY, JSON.stringify(syncHistory))
  }, [syncHistory])

  useEffect(() => {
    writeLocalStorageItem(BRANCH_ATTENTION_DISMISSALS_STORAGE_KEY, JSON.stringify(dismissedBranchAttentionKeys))
  }, [dismissedBranchAttentionKeys])

  useEffect(() => {
    writeLocalStorageItem(CLONE_PARENT_PATH_STORAGE_KEY, lastCloneParentPath)
  }, [lastCloneParentPath])

  useEffect(() => {
    reposRef.current = repos
  }, [repos])

  useEffect(() => {
    missingRepoIdsRef.current = new Set(Object.keys(missingRepoStates))
  }, [missingRepoStates])

  useEffect(() => {
    const validRepoIds = new Set(repos.map((repo) => repo.id))
    setMissingRepoStates((prev) => {
      let changed = false
      const next = {}
      Object.entries(prev).forEach(([repoId, info]) => {
        if (!validRepoIds.has(repoId)) {
          changed = true
          return
        }
        next[repoId] = info
      })
      return changed ? next : prev
    })
  }, [repos])

  useEffect(() => {
    const validRepoIds = new Set(repos.map((repo) => repo.id))
    setRepoStatusIssues((prev) => {
      let changed = false
      const next = {}
      Object.entries(prev).forEach(([repoId, info]) => {
        if (!validRepoIds.has(repoId)) {
          changed = true
          return
        }
        next[repoId] = info
      })
      return changed ? next : prev
    })
  }, [repos])

  useEffect(() => {
    const issueCount = Object.keys(repoStatusIssues).length
    if (issueCount === 0) return undefined
    setStatusIssueNowTick(Date.now())
    const timer = setInterval(() => {
      setStatusIssueNowTick(Date.now())
    }, 60000)
    return () => clearInterval(timer)
  }, [repoStatusIssues])

  useEffect(() => {
    const validRepoIds = new Set(repos.map((repo) => repo.id))
    setSyncCheckingRepoIds((prev) => {
      const next = prev.filter((repoId) => validRepoIds.has(repoId))
      if (next.length === prev.length) return prev
      syncCheckingRepoIdsRef.current = new Set(next)
      return next
    })
  }, [repos])

  useEffect(() => {
    const validRepoIds = new Set(repos.map((repo) => repo.id))
    setBranchRefreshingRepoIds((prev) => {
      const next = prev.filter((repoId) => validRepoIds.has(repoId))
      if (next.length === prev.length) return prev
      branchRefreshingRepoIdsRef.current = new Set(next)
      return next
    })
  }, [repos])

  useEffect(() => {
    const validRepoIds = new Set(repos.map((repo) => repo.id))
    setPostSyncBuildStates((prev) => {
      let changed = false
      const next = {}
      Object.entries(prev).forEach(([repoId, state]) => {
        if (!validRepoIds.has(repoId)) {
          changed = true
          const timer = postSyncBuildResetTimersRef.current[repoId]
          if (timer) {
            clearTimeout(timer)
            delete postSyncBuildResetTimersRef.current[repoId]
          }
          runningPostSyncBuildRepoIdsRef.current.delete(repoId)
          return
        }
        next[repoId] = state
      })
      return changed ? next : prev
    })
  }, [repos])

  useEffect(() => () => {
    Object.values(postSyncBuildResetTimersRef.current).forEach(clearTimeout)
    postSyncBuildResetTimersRef.current = {}
  }, [])

  const clearPostSyncBuildStateAfterDelay = useCallback((repoId, delayMs = POST_SYNC_BUILD_SUCCESS_BADGE_DURATION_MS) => {
    const currentTimer = postSyncBuildResetTimersRef.current[repoId]
    if (currentTimer) {
      clearTimeout(currentTimer)
    }
    postSyncBuildResetTimersRef.current[repoId] = setTimeout(() => {
      setPostSyncBuildStates((prev) => {
        if (!prev[repoId]) return prev
        const next = { ...prev }
        delete next[repoId]
        return next
      })
      delete postSyncBuildResetTimersRef.current[repoId]
    }, delayMs)
  }, [])

  const setPostSyncBuildState = useCallback((repoId, state) => {
    const currentTimer = postSyncBuildResetTimersRef.current[repoId]
    if (currentTimer) {
      clearTimeout(currentTimer)
      delete postSyncBuildResetTimersRef.current[repoId]
    }
    setPostSyncBuildStates((prev) => {
      if (!state || state === POST_SYNC_BUILD_STATE.idle) {
        if (!prev[repoId]) return prev
        const next = { ...prev }
        delete next[repoId]
        return next
      }
      if (prev[repoId] === state) return prev
      return {
        ...prev,
        [repoId]: state,
      }
    })
  }, [])

  const openScriptLogSession = useCallback(({ repoId, repoName, source, scriptPath }) => {
    const session = createScriptLogSession({
      repoId,
      repoName,
      source,
      scriptPath,
    })
    setScriptLogSessions((prev) => {
      const next = trimScriptLogSessions([...prev, session])
      scriptLogSessionsRef.current = next
      return next
    })
    setActiveScriptLogSessionId(session.id)
    setScriptLogDialogOpen(true)
    return session.id
  }, [])

  const updateScriptLogSession = useCallback((sessionId, patch) => {
    if (!sessionId) return
    setScriptLogSessions((prev) => {
      let changed = false
      const next = prev.map((session) => {
        if (session.id !== sessionId) return session
        changed = true
        return {
          ...session,
          ...patch,
        }
      })
      if (!changed) return prev
      scriptLogSessionsRef.current = next
      return next
    })
  }, [])

  const appendScriptLogChunk = useCallback(({ repoId, sessionId, chunk }) => {
    const text = String(chunk || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
    if (!text) return

    setScriptLogSessions((prev) => {
      let next = [...prev]
      let targetIndex = -1

      if (sessionId) {
        targetIndex = next.findIndex((session) => session.id === sessionId)
      }
      if (targetIndex < 0 && repoId) {
        for (let i = next.length - 1; i >= 0; i -= 1) {
          if (next[i].repoId === repoId) {
            targetIndex = i
            break
          }
        }
      }

      if (targetIndex < 0) {
        if (!sessionId) return prev
        next.push(createPendingScriptLogSession(sessionId, repoId))
        targetIndex = next.length - 1
      }

      const target = next[targetIndex]
      next[targetIndex] = {
        ...target,
        output: `${target.output || ''}${text}`,
      }
      next = trimScriptLogSessions(next)
      scriptLogSessionsRef.current = next
      return next
    })

    if (sessionId) {
      setActiveScriptLogSessionId((prev) => prev || sessionId)
    }
  }, [])

  const focusLatestScriptLogSession = useCallback((repoId) => {
    const session = [...scriptLogSessionsRef.current]
      .reverse()
      .find((item) => item.repoId === repoId)
    if (!session) return
    setActiveScriptLogSessionId(session.id)
    setScriptLogDialogOpen(true)
  }, [])

  const clearScriptLogSessions = useCallback(() => {
    setScriptLogSessions([])
    scriptLogSessionsRef.current = []
    setActiveScriptLogSessionId(null)
    setScriptLogDialogOpen(false)
  }, [])

  useEffect(() => {
    if (!undoRemoveData) return
    const timer = setTimeout(() => {
      setUndoRemoveData(null)
    }, UNDO_REMOVE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [undoRemoveData])

  useLayoutEffect(() => {
    syncJobsRef.current = syncJobs
  }, [syncJobs])

  useEffect(() => {
    scriptLogSessionsRef.current = scriptLogSessions
  }, [scriptLogSessions])

  useEffect(() => {
    let disposed = false
    let unlisten = null

    const setupListener = async () => {
      try {
        const nextUnlisten = await listen('repo-build-script-log-chunk', (event) => {
          const payload = event?.payload || {}
          const repoId = String(payload.repo_id || payload.repoId || '').trim()
          const sessionId = String(payload.session_id || payload.sessionId || '').trim()
          const chunk = String(payload.chunk || '')
          appendScriptLogChunk({
            repoId,
            sessionId: sessionId || null,
            chunk,
          })
        })
        if (disposed) {
          nextUnlisten()
          return
        }
        unlisten = nextUnlisten
      } catch (error) {
        console.error('脚本日志监听失败:', error)
      }
    }

    void setupListener()
    return () => {
      disposed = true
      if (unlisten) {
        unlisten()
      }
    }
  }, [appendScriptLogChunk])

  useEffect(() => {
    const validIds = new Set(repos.map((repo) => repo.id))
    setSelectedRepoIds((prev) => {
      const next = prev.filter((id) => validIds.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [repos])

  useEffect(() => {
    if (page !== 'dashboard' || dashboardLayout !== 'masonry') return
    const grid = repoGridRef.current
    if (!grid) return

    const updateColumns = () => {
      const width = grid.clientWidth || 0
      const nextColumns = Math.max(
        1,
        Math.floor((width + REPO_GRID_GAP) / (REPO_CARD_MIN_WIDTH + REPO_GRID_GAP))
      )
      setRepoGridColumns((prev) => (prev === nextColumns ? prev : nextColumns))
    }

    updateColumns()
    const observer = new ResizeObserver(updateColumns)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [page, repos.length, dashboardLayout, appReady])

  useEffect(() => {
    writeLocalStorageItem(DASHBOARD_LAYOUT_KEY, dashboardLayout)
  }, [dashboardLayout])

  useEffect(() => {
    writeDashboardRepoFilter(dashboardRepoFilter)
  }, [dashboardRepoFilter])

  useEffect(() => {
    writeDashboardRepoSortMode(dashboardRepoSortMode)
  }, [dashboardRepoSortMode])

  useEffect(() => {
    if (!isWindowFocused || page !== 'dashboard') return
    const timer = setInterval(() => {
      const action = getDashboardIntervalRefreshAction({
        page: pageRef.current,
        isWindowFocused: isWindowFocusedRef.current,
        isRemoveMutationRunning: removeMutationCountRef.current > 0,
        repoCount: reposRef.current.length,
      })
      if (action === DASHBOARD_REFRESH_ACTION.localStatuses) {
        void refreshRepoStatusesByIds(reposRef.current.map((repo) => repo.id))
      } else if (action === DASHBOARD_REFRESH_ACTION.repoList) {
        void fetchRepos({ mode: FETCH_REPOS_MODE.light })
      }
    }, REPO_LIST_REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [fetchRepos, isWindowFocused, page, refreshRepoStatusesByIds])

  useEffect(() => {
    const intervalMs = normalizeIntervalSeconds(
      settings.backgroundFetchInterval,
      DEFAULT_APP_SETTINGS.backgroundFetchInterval
    ) * 1000
    let disposed = false
    let timer = null

    function scheduleNext(delayMs = intervalMs) {
      if (disposed) return
      timer = setTimeout(() => {
        void runRound()
      }, delayMs)
    }

    async function runRound() {
      if (disposed) return
      const elapsedSinceLastRefresh = Date.now() - lastRemoteRefreshFinishedAtRef.current
      if (lastRemoteRefreshFinishedAtRef.current > 0 && elapsedSinceLastRefresh < intervalMs) {
        scheduleNext(intervalMs - elapsedSinceLastRefresh)
        return
      }
      try {
        await refreshRepoRemoteState(reposRef.current, { manualOnly: true })
      } finally {
        scheduleNext(intervalMs)
      }
    }

    scheduleNext(intervalMs)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [settings.backgroundFetchInterval])

  const currentSyncMode = settings.defaultSyncMode === 'auto' ? 'auto' : 'manual'
  const stats = {
    total: repos.length,
    syncing: repos.filter((r) => r.status === 'syncing').length,
    conflict: repos.filter((r) => r.status === 'conflict').length,
    error: repos.filter((r) => r.status === 'error').length,
  }
  const syncGuardPolicies = normalizeSyncGuardPolicies(settings.syncGuardPolicies)
  const syncGuardPolicySignature = `${syncGuardPolicies.localChanges}:${syncGuardPolicies.missingRemote}:${syncGuardPolicies.conflictRisk}`

  const runSyncGuardChecks = async (repoIds) => {
    const uniqueRepoIds = Array.isArray(repoIds)
      ? Array.from(new Set(repoIds.filter(Boolean)))
      : []
    if (uniqueRepoIds.length === 0) {
      return createEmptySyncGuardCheckResult()
    }

    const createRepoCheckResult = (repoId, issues, repoName = '') => ({
      repoId,
      repoName: repoName || getRepoFallbackName(repoId),
      issues,
    })

    const immediateBlockedResults = []
    const repoIdsToCheck = []

    uniqueRepoIds.forEach((repoId) => {
      if (missingRepoIdsRef.current.has(repoId)) {
        immediateBlockedResults.push(
          createRepoCheckResult(
            repoId,
            [createMissingRepoSyncGuardIssue(missingRepoStates?.[repoId]?.message)]
          )
        )
        return
      }
      repoIdsToCheck.push(repoId)
    })

    const checkResults = repoIdsToCheck.length > 0
      ? await mapWithConcurrencyLimit(
        repoIdsToCheck,
        gitTaskConcurrency,
        async (repoId) => {
          try {
            const result = await invoke('check_sync_prerequisites', { repoId })
            clearRepoPathMissing(repoId)
            return createRepoCheckResult(
              repoId,
              getSyncGuardIssueItems(result, syncGuardPolicies),
              result?.repo_name
            )
          } catch (error) {
            const { matched, errorMessage } = markMissingRepoFromMessage(repoId, error)
            if (matched) {
              return createRepoCheckResult(
                repoId,
                [createMissingRepoSyncGuardIssue(errorMessage)]
              )
            }
            return createRepoCheckResult(
              repoId,
              [createSyncGuardCheckFailedIssue(errorMessage)]
            )
          }
        }
      )
      : []

    return classifySyncGuardCheckResults([
      ...immediateBlockedResults,
      ...checkResults,
    ])
  }

  const enqueueWithSyncGuards = async (repoIds, source = 'manual', options = {}, showDialog = true) => {
    const syncRepoIds = Array.isArray(repoIds)
      ? Array.from(new Set(repoIds.filter(Boolean)))
      : []
    if (syncRepoIds.length === 0) {
      return {
        enqueuedCount: 0,
        skippedCount: 0,
        blockedCount: 0,
        warningCount: 0,
        delayedByGuardDialog: false,
      }
    }

    const requestId = String(options?.requestId || '').trim() || createSyncDiagnosticRequestId()
    const diagnosticOptions = { ...options, requestId }
    const createRepoEvent = (repoId, event) => ({
      requestId,
      repoId,
      repoName: getSyncDiagnosticRepoName(reposRef.current, repoId),
      source,
      trigger: diagnosticOptions.trigger || source,
      syncBehavior: diagnosticOptions.syncBehavior || 'default',
      attempt: diagnosticOptions.attempt || 1,
      ...event,
    })
    appendSyncDiagnosticEvents(syncRepoIds.map((repoId) => createRepoEvent(repoId, {
      phase: 'request_received',
      outcome: 'accepted',
    })))

    let checks
    try {
      checks = await runSyncGuardChecks(syncRepoIds)
    } catch (error) {
      appendSyncDiagnosticEvents(syncRepoIds.map((repoId) => createRepoEvent(repoId, {
        phase: 'guard_completed',
        outcome: 'error',
      })))
      throw error
    }
    const {
      allowedRepoIds,
      warningItems,
      blockedItems,
    } = checks
    const warningByRepoId = new Map(warningItems.map((item) => [item.repoId, item]))
    const blockedByRepoId = new Map(blockedItems.map((item) => [item.repoId, item]))
    appendSyncDiagnosticEvents(syncRepoIds.map((repoId) => {
      const blockedItem = blockedByRepoId.get(repoId)
      const warningItem = warningByRepoId.get(repoId)
      const guardItem = blockedItem || warningItem
      return createRepoEvent(repoId, {
        phase: 'guard_completed',
        outcome: blockedItem ? 'blocked' : (warningItem ? 'warning' : 'allowed'),
        guardIssueCount: Array.isArray(guardItem?.issues) ? guardItem.issues.length : 0,
      })
    }))

    const shouldOpenDialog = showDialog && (warningItems.length > 0 || blockedItems.length > 0)
    if (shouldOpenDialog) {
      appendSyncDiagnosticEvents(allowedRepoIds.map((repoId) => createRepoEvent(repoId, {
        phase: 'guard_dialog',
        outcome: 'waiting',
      })))
      setPendingGuardedSyncData({
        repoIds: allowedRepoIds,
        source,
        options: diagnosticOptions,
      })
      setSyncGuardDialogData({
        source,
        warningItems,
        blockedItems,
        continueCount: allowedRepoIds.length,
      })
      return {
        requestId,
        enqueuedCount: 0,
        skippedCount: 0,
        blockedCount: blockedItems.length,
        warningCount: warningItems.length,
        delayedByGuardDialog: true,
      }
    }

    const { enqueuedCount, skippedCount } = enqueueSyncJobs(
      allowedRepoIds,
      source,
      diagnosticOptions
    )
    return {
      requestId,
      enqueuedCount,
      skippedCount,
      blockedCount: blockedItems.length,
      warningCount: warningItems.length,
      delayedByGuardDialog: false,
    }
  }

  const closeSyncGuardDialog = () => {
    const pending = pendingGuardedSyncData
    if (pending) {
      appendSyncDiagnosticEvents(pending.repoIds.map((repoId) => ({
        requestId: pending.options?.requestId,
        repoId,
        repoName: getSyncDiagnosticRepoName(reposRef.current, repoId),
        source: pending.source,
        trigger: pending.options?.trigger || pending.source,
        phase: 'guard_dialog',
        outcome: 'canceled',
        attempt: pending.options?.attempt || 1,
        syncBehavior: pending.options?.syncBehavior || 'default',
      })))
    }
    setSyncGuardDialogData(null)
    setPendingGuardedSyncData(null)
  }

  const confirmSyncGuardDialog = () => {
    const pending = pendingGuardedSyncData
    if (!pending) {
      closeSyncGuardDialog()
      return
    }
    appendSyncDiagnosticEvents(pending.repoIds.map((repoId) => ({
      requestId: pending.options?.requestId,
      repoId,
      repoName: getSyncDiagnosticRepoName(reposRef.current, repoId),
      source: pending.source,
      trigger: pending.options?.trigger || pending.source,
      phase: 'guard_dialog',
      outcome: 'confirmed',
      attempt: pending.options?.attempt || 1,
      syncBehavior: pending.options?.syncBehavior || 'default',
    })))
    enqueueSyncJobs(pending.repoIds, pending.source, pending.options || {})
    setSyncGuardDialogData(null)
    setPendingGuardedSyncData(null)
  }

  const applySyncSettingToAllRepos = useCallback(async (key, value) => {
    const payload = {}

    if (key === 'defaultSyncInterval') payload.syncInterval = value
    if (key === 'defaultSyncMode') payload.syncMode = value
    if (key === 'defaultPullStrategy') payload.pullStrategy = value

    if (Object.keys(payload).length === 0) return

    const repoIds = reposRef.current.map((repo) => repo.id)
    if (repoIds.length === 0) return

    try {
      const updatedCount = await invoke('update_repos_batch', { repoIds, ...payload })
      const expectedCount = repoIds.length
      if (updatedCount < expectedCount) {
        const failedCount = expectedCount - updatedCount
        setNoticeData({
          title: '设置应用结果',
          message: `同步设置已保存，但有 ${failedCount} 个仓库未更新，请稍后重试。`,
        })
      }
    } catch (error) {
      setNoticeData({
        title: '设置应用结果',
        message: `同步设置保存失败：${getErrorMessage(error)}`,
      })
      return
    }

    await fetchRepos()
  }, [fetchRepos])

  const updateSetting = useCallback(async (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }))

    if (isLocalOnlySettingKey(key)) return
    await applySyncSettingToAllRepos(key, value)
  }, [applySyncSettingToAllRepos])

  const appendSyncHistory = useCallback((entry) => {
    setSyncHistory((prev) => trimSyncHistoryEntries([
      ...prev,
      createSyncHistoryEntry(entry),
    ]))
  }, [])

  const getRepoSyncContext = useCallback(async (repoId) => {
    const repo = reposRef.current.find((item) => item.id === repoId)
    let statusSnapshot = repoStatuses[repoId] || null
    if (repo?.path) {
      try {
        statusSnapshot = await invoke('get_repo_status', { path: repo.path })
      } catch {
        statusSnapshot = statusSnapshot || null
      }
    }

    const lastCommit = statusSnapshot?.last_commit || null
    return {
      repoName: repo?.name || repoId,
      repoPath: repo?.path || '',
      branch: statusSnapshot?.branch || repo?.branch || '',
      commitHash: lastCommit?.hash || '',
      commitMessage: lastCommit?.message || '',
      commitDate: lastCommit?.date || '',
      commitAuthor: lastCommit?.author || '',
    }
  }, [repoStatuses])

  const loadCommitHistoryBranchOverview = useCallback(async (repo, force = false) => {
    if (!repo?.id || !repo?.path) return
    if (
      !force
      && commitHistoryBranchOverviewState.repoId === repo.id
      && (commitHistoryBranchOverviewState.overview || commitHistoryBranchOverviewState.loading)
    ) {
      return
    }

    const requestId = commitHistoryBranchOverviewRequestIdRef.current + 1
    commitHistoryBranchOverviewRequestIdRef.current = requestId
    setCommitHistoryBranchOverviewState((prev) => ({
      repoId: repo.id,
      loading: true,
      error: '',
      overview: prev.repoId === repo.id ? prev.overview : null,
    }))

    try {
      const overview = await invoke('get_repo_branch_overview', { path: repo.path })
      if (commitHistoryBranchOverviewRequestIdRef.current === requestId) {
        setCommitHistoryBranchOverviewState({
          repoId: repo.id,
          loading: false,
          error: '',
          overview: overview || null,
        })
      }
    } catch (error) {
      if (commitHistoryBranchOverviewRequestIdRef.current === requestId) {
        setCommitHistoryBranchOverviewState((prev) => ({
          repoId: repo.id,
          loading: false,
          error: getErrorMessage(error),
          overview: prev.repoId === repo.id ? prev.overview : null,
        }))
      }
    }
  }, [commitHistoryBranchOverviewState])

  const loadCommitHistoryForRepo = useCallback(async ({
    repo,
    status,
    count,
    branch,
    branchHeadHash = '',
    remoteHeadHash = '',
    force = false,
  }) => {
    if (!repo?.id || !repo?.path) return
    const safeCount = normalizeCommitHistoryCount(count)
    const currentBranch = getCommitHistoryDefaultBranch(repo, status)
    const branchRef = normalizeCommitHistoryBranchName(branch) || currentBranch
    const expectedHeadHash = String(branchHeadHash || '').trim()
    const latestCommit = getRepoLatestCommitDisplay(status, repo)
    const cacheKey = buildCommitHistoryCacheKey(repo, branchRef, safeCount)
    if (!cacheKey) return

    const cachedEntry = commitHistoryCache.entries[cacheKey]
    const isCurrentBranch = branchRef === currentBranch
    const needsRefresh = force || shouldRefreshCommitHistoryCache(
      cachedEntry,
      expectedHeadHash || (isCurrentBranch ? latestCommit.hash : ''),
      remoteHeadHash
    )
    if (!needsRefresh) {
      setCommitHistoryLoadState({
        cacheKey,
        loading: false,
        refreshing: false,
        error: '',
      })
      return
    }

    const requestId = commitHistoryRequestIdRef.current + 1
    commitHistoryRequestIdRef.current = requestId
    const loadingStartedAt = Date.now()
    const shouldHoldLoading = !cachedEntry
    setCommitHistoryLoadState({
      cacheKey,
      loading: !cachedEntry,
      refreshing: Boolean(cachedEntry),
      error: '',
    })

    try {
      const result = await invoke('get_repo_commit_history', {
        repoPath: repo.path,
        count: safeCount,
        branch: branchRef,
      })

      const commits = Array.isArray(result?.commits)
        ? result.commits
          .map((commit) => normalizeCommitHistoryCommit(commit, { branch: result?.branch || branchRef }))
          .filter(Boolean)
        : []
      const remoteBranch = normalizeCommitHistoryBranchName(result?.remote_branch)
      const remoteCommits = Array.isArray(result?.remote_commits)
        ? result.remote_commits
          .map((commit) => normalizeCommitHistoryCommit(commit, { source: 'remote', branch: remoteBranch }))
          .filter(Boolean)
        : []
      const nextEntry = {
        repoId: repo.id,
        repoPath: repo.path,
        branch: result?.branch || branchRef,
        remoteBranch,
        count: safeCount,
        headHash: String(result?.head_hash || latestCommit.hash || '').trim(),
        remoteHeadHash: String(result?.remote_head_hash || '').trim(),
        fetchedAt: Date.now(),
        commits,
        remoteCommits,
      }

      if (shouldHoldLoading) {
        await waitForMinimumElapsed(loadingStartedAt, COMMIT_HISTORY_LOADING_MIN_MS)
      }

      if (commitHistoryRequestIdRef.current === requestId) {
        updateCommitHistoryCache((prev) => upsertCommitHistoryCacheEntry(prev, cacheKey, nextEntry))
        setCommitHistoryLoadState({
          cacheKey,
          loading: false,
          refreshing: false,
          error: '',
        })
      }
    } catch (error) {
      if (shouldHoldLoading) {
        await waitForMinimumElapsed(loadingStartedAt, COMMIT_HISTORY_LOADING_MIN_MS)
      }

      if (commitHistoryRequestIdRef.current === requestId) {
        setCommitHistoryLoadState({
          cacheKey,
          loading: false,
          refreshing: false,
          error: getErrorMessage(error),
        })
      }
    }
  }, [commitHistoryCache, updateCommitHistoryCache])

  const runSyncRepo = useCallback(async (repoId, options = {}) => {
    const { refreshAfter = true, syncBehavior = 'default' } = options

    if (syncingRepoIdsRef.current.has(repoId)) return null
    syncingRepoIdsRef.current.add(repoId)
    setRepos((prev) => prev.map((repo) => (
      repo.id === repoId ? { ...repo, status: 'syncing' } : repo
    )))

    try {
      const payload = { repoId }
      if (syncBehavior === 'changesOnly') {
        payload.syncBehavior = 'changes_only'
      }
      const result = await invoke('sync_repo', payload)
      const isMissingPath = markMissingRepoFromMessage(repoId, result?.message).matched
      if (!isMissingPath && result?.success) {
        clearRepoPathMissing(repoId)
        updateCommitHistoryCache((prev) => removeCommitHistoryCacheForRepo(prev, repoId))
      }
      if (result.conflict) {
        const repo = reposRef.current.find((r) => r.id === repoId)
        setConflictData({
          repoId,
          repoName: repo?.name || '',
          repoPath: repo?.path || '',
          conflict_files: result.conflict_files,
        })
      }
      if (!isMissingPath && result?.success === false) {
        recordAppError({
          scope: 'sync',
          repoId,
          message: result?.message || '同步失败',
        })
      }
      return result
    } catch (e) {
      markMissingRepoFromMessage(repoId, e)
      console.error('同步失败:', e)
      recordAppError({ scope: 'sync', repoId, message: getErrorMessage(e) })
      return null
    } finally {
      syncingRepoIdsRef.current.delete(repoId)
      if (refreshAfter) fetchRepos()
    }
  }, [clearRepoPathMissing, fetchRepos, markMissingRepoFromMessage, recordAppError, updateCommitHistoryCache])

  const runRepoBuildScriptByPath = useCallback(async (
    repoId,
    scriptPath,
    logSessionId = null,
    useSystemTerminal = false
  ) => {
    try {
      return await invoke('run_repo_build_script', {
        repoId,
        scriptPath,
        logSessionId,
        useSystemTerminal,
      })
    } catch (error) {
      return {
        success: false,
        message: getErrorMessage(error),
        script_path: scriptPath,
        command: scriptPath,
        output: '',
      }
    }
  }, [])

  const executePostSyncBuildScript = useCallback(async (repoId, {
    allowDisabled = false,
    showResultNotice = false,
    openLogDialog = true,
    triggerSource = 'auto',
    useSystemTerminal = false,
  } = {}) => {
    const repo = reposRef.current.find((item) => item.id === repoId)
    if (!repo) return null

    const selectedScript = String(repo.post_sync_build_script || '').trim()
    if (!selectedScript) {
      if (showResultNotice) {
        setNoticeData({
          title: '脚本测试失败',
          message: '请先为该仓库选择脚本。',
        })
      }
      return null
    }

    if (!allowDisabled && !repo.post_sync_build_enabled) {
      return null
    }

    if (runningPostSyncBuildRepoIdsRef.current.has(repoId)) {
      focusLatestScriptLogSession(repoId)
      if (showResultNotice) {
        setNoticeData({
          title: '脚本测试',
          message: '该仓库脚本正在执行中，请稍后再试。',
        })
      }
      return null
    }

    const scriptSupport = getBuildScriptSupport()
    if (!isSupportedBuildScriptFile(selectedScript, scriptSupport.extensions)) {
      setPostSyncBuildState(repoId, POST_SYNC_BUILD_STATE.failed)
      const message = `当前系统仅支持 ${scriptSupport.extensionsText} 脚本，请重新选择。`
      setNoticeData({
        title: showResultNotice ? '脚本测试失败' : '自动脚本执行失败',
        message: `[${repo.name || repoId}] ${selectedScript}：${message}`,
      })
      return null
    }

    const repoLabel = repo.name || repoId
    const logSessionId = openLogDialog
      ? openScriptLogSession({
        repoId,
        repoName: repoLabel,
        source: triggerSource,
        scriptPath: selectedScript,
      })
      : null

    setPostSyncBuildState(repoId, POST_SYNC_BUILD_STATE.running)
    runningPostSyncBuildRepoIdsRef.current.add(repoId)
    try {
      const buildResult = await runRepoBuildScriptByPath(
        repoId,
        selectedScript,
        logSessionId,
        useSystemTerminal
      )
      const scriptLabel = buildResult?.script_path || selectedScript
      const outputText = String(buildResult?.output || '').trim()
      const resultMessage = buildResult?.message || '未知结果'
      const commandText = buildResult?.command || selectedScript

      if (buildResult?.success) {
        setPostSyncBuildState(repoId, POST_SYNC_BUILD_STATE.success)
        clearPostSyncBuildStateAfterDelay(repoId)
      } else {
        setPostSyncBuildState(repoId, POST_SYNC_BUILD_STATE.failed)
      }

      if (logSessionId) {
        const existingSessionOutput = String(
          scriptLogSessionsRef.current.find((session) => session.id === logSessionId)?.output || ''
        )
        const finalOutput = existingSessionOutput.length >= outputText.length
          ? existingSessionOutput
          : outputText
        updateScriptLogSession(logSessionId, {
          status: buildResult?.success ? SCRIPT_LOG_STATUS.success : SCRIPT_LOG_STATUS.failed,
          scriptPath: scriptLabel,
          command: commandText,
          message: resultMessage,
          output: finalOutput,
          finishedAt: Date.now(),
        })
      }

      if (showResultNotice && !openLogDialog) {
        const resultTitle = buildResult?.success ? '脚本测试成功' : '脚本测试失败'
        setNoticeData({
          title: resultTitle,
          message: [
            `仓库：${repoLabel}`,
            `脚本：${scriptLabel}`,
            `命令：${commandText}`,
            `结果：${resultMessage}`,
            '',
            '输出：',
            outputText || '(无输出)',
          ].join('\n'),
        })
      } else if (!buildResult?.success && !showResultNotice) {
        setNoticeData({
          title: '自动脚本执行失败',
          message: `[${repoLabel}] ${scriptLabel}：${buildResult?.message || '未知错误'}`,
        })
      }

      return buildResult
    } finally {
      runningPostSyncBuildRepoIdsRef.current.delete(repoId)
    }
  }, [
    clearPostSyncBuildStateAfterDelay,
    focusLatestScriptLogSession,
    openScriptLogSession,
    runRepoBuildScriptByPath,
    setPostSyncBuildState,
    updateScriptLogSession,
  ])

  const runPostSyncBuildScriptInBackground = useCallback((repoId) => {
    void executePostSyncBuildScript(repoId, {
      allowDisabled: false,
      showResultNotice: false,
      openLogDialog: settings.autoOpenScriptLogDialog,
      triggerSource: 'auto',
      useSystemTerminal: true,
    })
  }, [executePostSyncBuildScript, settings.autoOpenScriptLogDialog])

  const enqueueSyncJobs = useCallback((repoIds, source = 'manual', options = {}) => {
    if (updateRestartAdmissionRef.current) {
      return { enqueuedCount: 0, skippedCount: Array.isArray(repoIds) ? repoIds.length : 0 }
    }
    const targetIds = Array.isArray(repoIds)
      ? Array.from(new Set(repoIds.filter(Boolean)))
      : []
    if (targetIds.length === 0) return { enqueuedCount: 0, skippedCount: 0 }

    const requestId = String(options?.requestId || '').trim() || createSyncDiagnosticRequestId()
    const snapshotLockedRepoIds = getActiveSyncRepoIds(syncJobsRef.current)
    const plannedRepoIds = []
    const skippedRepoIds = []
    for (const repoId of targetIds) {
      if (snapshotLockedRepoIds.has(repoId)) {
        skippedRepoIds.push(repoId)
        continue
      }
      snapshotLockedRepoIds.add(repoId)
      plannedRepoIds.push(repoId)
    }

    const attempt = options.attempt || 1
    const syncBehavior = options.syncBehavior === 'changesOnly' ? 'changesOnly' : 'default'
    appendSyncDiagnosticEvents(skippedRepoIds.map((repoId) => ({
      requestId,
      repoId,
      repoName: getSyncDiagnosticRepoName(reposRef.current, repoId),
      source,
      trigger: options.trigger || source,
      phase: 'queue_skipped',
      outcome: 'already_active',
      attempt,
      syncBehavior,
    })))
    if (plannedRepoIds.length === 0) {
      return { requestId, enqueuedCount: 0, skippedCount: skippedRepoIds.length }
    }

    const plannedJobs = plannedRepoIds.map((repoId) => (
      createSyncJob(repoId, source, attempt, syncBehavior, requestId, options.trigger || source)
    ))
    appendSyncDiagnosticEvents(plannedJobs.map((job) => ({
      requestId: job.requestId,
      jobId: job.id,
      repoId: job.repoId,
      repoName: getSyncDiagnosticRepoName(reposRef.current, job.repoId),
      source: job.source,
      trigger: job.trigger,
      phase: 'queue_enqueued',
      outcome: 'queued',
      attempt: job.attempt,
      syncBehavior: job.syncBehavior,
    })))

    setSyncJobs((prev) => {
      const runtimeLockedRepoIds = getActiveSyncRepoIds(prev)
      const next = [...prev]
      for (const job of plannedJobs) {
        if (runtimeLockedRepoIds.has(job.repoId)) {
          continue
        }
        next.push(job)
        runtimeLockedRepoIds.add(job.repoId)
      }
      return trimSyncJobs(next)
    })

    return {
      requestId,
      enqueuedCount: plannedJobs.length,
      skippedCount: skippedRepoIds.length,
    }
  }, [])

  const repoSyncTimerSignature = getRepoSyncTimerSignature(repos)

  useEffect(() => {
    const clearTimers = () => {
      Object.values(syncTimersRef.current).forEach(clearInterval)
      syncTimersRef.current = {}
    }

    clearTimers()
    if (!isWindowFocused) return clearTimers

    const newTimers = {}
    repos.forEach((repo) => {
      if (missingRepoIdsRef.current.has(repo.id)) return
      if (isRepoAutoSyncEnabled(repo)) {
        const interval = (repo.sync_interval || 30) * 1000
        newTimers[repo.id] = setInterval(() => {
          enqueueWithSyncGuards([repo.id], 'auto', {}, false)
        }, interval)
      }
    })

    syncTimersRef.current = newTimers
    return clearTimers
  }, [repoSyncTimerSignature, syncGuardPolicySignature, isWindowFocused])

  const syncQueueConcurrency = gitTaskConcurrency

  const startSyncJob = useCallback(async (jobId, repoId) => {
    if (updateRestartAdmissionRef.current) return
    if (processingSyncJobIdsRef.current.has(jobId)) return
    const currentJob = syncJobsRef.current.find((job) => job.id === jobId)
    if (!currentJob || currentJob.status !== SYNC_JOB_STATUS.queued) return

    if (!isWindowFocusedRef.current) {
      backgroundSyncRefreshRepoIdsRef.current.add(repoId)
      setPendingFocusRefreshReasons(
        pendingRefreshOnFocusRef,
        getPendingFocusRefreshReasonsAfterBackgroundSyncStart(
          pendingRefreshOnFocusRef.current
        )
      )
    }

    const startedAt = Date.now()
    processingSyncJobIdsRef.current.add(jobId)
    const diagnosticBase = {
      requestId: currentJob.requestId,
      jobId,
      repoId,
      repoName: getSyncDiagnosticRepoName(reposRef.current, repoId),
      source: currentJob.source || 'manual',
      trigger: currentJob.trigger || currentJob.source || 'manual',
      attempt: currentJob.attempt || 1,
      syncBehavior: currentJob.syncBehavior || 'default',
    }
    appendSyncDiagnosticEvents([{
      ...diagnosticBase,
      timestamp: startedAt,
      phase: 'job_started',
      outcome: 'running',
    }])
    setSyncJobs((prev) => mapSyncJobById(prev, jobId, (job) => {
      if (job.status !== SYNC_JOB_STATUS.queued) return job
      return {
        ...job,
        status: SYNC_JOB_STATUS.running,
        startedAt,
        message: '',
      }
    }))

    try {
      const result = await runSyncRepo(repoId, {
        refreshAfter: false,
        syncBehavior: currentJob.syncBehavior || 'default',
      })
      const finishedAt = Date.now()
      const latestJob = syncJobsRef.current.find((job) => job.id === jobId)
      let finalStatus = SYNC_JOB_STATUS.failed
      let finalMessage = result?.message || '同步失败'
      if (latestJob?.cancelRequested) {
        finalStatus = SYNC_JOB_STATUS.canceled
        finalMessage = '已取消'
      } else if (result?.success) {
        finalStatus = SYNC_JOB_STATUS.success
        finalMessage = result?.message || '同步完成'
      }
      const didPull = Boolean(result?.did_pull || result?.didPull)
      const didPush = Boolean(result?.did_push || result?.didPush)
      const shouldRunPostSyncBuild = finalStatus === SYNC_JOB_STATUS.success && (
        settings.postSyncScriptPullOnly ? didPull : (didPull || didPush)
      )

      setSyncJobs((prev) => mapSyncJobById(prev, jobId, (job) => {
        return {
          ...job,
          status: finalStatus,
          message: finalMessage,
          finishedAt,
        }
      }))
      appendSyncDiagnosticEvents([{
        ...diagnosticBase,
        timestamp: finishedAt,
        phase: 'backend_completed',
        outcome: finalStatus,
        didPull,
        didPush,
        conflict: Boolean(result?.conflict),
        responseReceived: result !== null && result !== undefined,
      }])

      const context = await getRepoSyncContext(repoId)
      appendSyncHistory({
        requestId: currentJob.requestId,
        jobId,
        repoId,
        repoName: context.repoName,
        repoPath: context.repoPath,
        source: currentJob.source || 'manual',
        trigger: currentJob.trigger || currentJob.source || 'manual',
        attempt: currentJob.attempt || 1,
        queuedAt: currentJob.createdAt || startedAt,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        result: finalStatus,
        message: finalMessage,
        errorSummary: finalStatus === SYNC_JOB_STATUS.failed ? finalMessage : '',
        didPull,
        didPush,
        branch: context.branch,
        commitHash: context.commitHash,
        commitMessage: context.commitMessage,
        commitDate: context.commitDate,
        commitAuthor: context.commitAuthor,
      })

      const wasTrackedBackgroundSync = backgroundSyncRefreshRepoIdsRef.current.has(repoId)
      try {
        await refreshAfterSyncCompletion(repoId)
      } finally {
        if (wasTrackedBackgroundSync) {
          backgroundSyncRefreshRepoIdsRef.current.delete(repoId)
          setPendingFocusRefreshReasons(
            pendingRefreshOnFocusRef,
            getPendingFocusRefreshReasonsAfterBackgroundSyncCompletion(
              pendingRefreshOnFocusRef.current,
              { hasRemainingBackgroundSync: backgroundSyncRefreshRepoIdsRef.current.size > 0 }
            )
          )
        }
      }

      if (shouldRunPostSyncBuild) {
        runPostSyncBuildScriptInBackground(repoId)
      }
    } finally {
      processingSyncJobIdsRef.current.delete(jobId)
    }
  }, [
    appendSyncHistory,
    fetchRepos,
    getRepoSyncContext,
    refreshAfterSyncCompletion,
    runPostSyncBuildScriptInBackground,
    runSyncRepo,
    settings.postSyncScriptPullOnly,
  ])

  useEffect(() => {
    if (updateRestartAdmissionActive) return
    const runningJobs = syncJobs.filter((job) => job.status === SYNC_JOB_STATUS.running)
    if (runningJobs.length >= syncQueueConcurrency) return

    const queuedJobs = syncJobs.filter((job) => job.status === SYNC_JOB_STATUS.queued)
    if (queuedJobs.length === 0) return

    const slots = syncQueueConcurrency - runningJobs.length
    queuedJobs.slice(0, slots).forEach((job) => {
      startSyncJob(job.id, job.repoId)
    })
  }, [startSyncJob, syncJobs, syncQueueConcurrency, updateRestartAdmissionActive])

  const cancelSyncJobsByRepoIds = useCallback((repoIds, {
    queuedMessage = SYNC_CANCEL_MESSAGE_PRESETS.manual.queuedMessage,
    runningMessage = SYNC_CANCEL_MESSAGE_PRESETS.manual.runningMessage,
  } = {}) => {
    const targetRepoIds = Array.isArray(repoIds) ? repoIds.filter(Boolean) : []
    if (targetRepoIds.length === 0) {
      return { canceledQueuedCount: 0, requestedRunningCount: 0 }
    }

    const targetRepoIdSet = new Set(targetRepoIds)
    const now = Date.now()

    let canceledQueuedCount = 0
    let requestedRunningCount = 0
    const diagnosticEvents = []
    syncJobsRef.current.forEach((job) => {
      if (!targetRepoIdSet.has(job.repoId)) return
      if (job.status === SYNC_JOB_STATUS.queued) {
        canceledQueuedCount += 1
        diagnosticEvents.push({
          requestId: job.requestId,
          jobId: job.id,
          repoId: job.repoId,
          repoName: getSyncDiagnosticRepoName(reposRef.current, job.repoId),
          source: job.source,
          trigger: job.trigger || job.source,
          phase: 'job_canceled',
          outcome: 'queued',
          attempt: job.attempt || 1,
          syncBehavior: job.syncBehavior || 'default',
        })
        return
      }
      if (job.status === SYNC_JOB_STATUS.running && !job.cancelRequested) {
        requestedRunningCount += 1
        diagnosticEvents.push({
          requestId: job.requestId,
          jobId: job.id,
          repoId: job.repoId,
          repoName: getSyncDiagnosticRepoName(reposRef.current, job.repoId),
          source: job.source,
          trigger: job.trigger || job.source,
          phase: 'cancel_requested',
          outcome: 'running',
          attempt: job.attempt || 1,
          syncBehavior: job.syncBehavior || 'default',
        })
      }
    })

    if (canceledQueuedCount === 0 && requestedRunningCount === 0) {
      return { canceledQueuedCount, requestedRunningCount }
    }
    appendSyncDiagnosticEvents(diagnosticEvents)

    setSyncJobs((prev) => prev.map((job) => {
      if (!targetRepoIdSet.has(job.repoId)) return job
      if (job.status === SYNC_JOB_STATUS.queued) {
        return {
          ...job,
          status: SYNC_JOB_STATUS.canceled,
          message: queuedMessage,
          cancelRequested: false,
          finishedAt: now,
        }
      }
      if (job.status === SYNC_JOB_STATUS.running && !job.cancelRequested) {
        return {
          ...job,
          cancelRequested: true,
          message: runningMessage,
        }
      }
      return job
    }))

    return { canceledQueuedCount, requestedRunningCount }
  }, [])

  const closeImportEntryMenu = useCallback(() => {
    setImportMenuAnchor(null)
  }, [])

  const openImportEntryMenu = useCallback((event) => {
    if (isRepoImportBusy) return
    const anchorRect = event?.currentTarget?.getBoundingClientRect?.()
    if (!anchorRect) return
    setImportMenuAnchor({
      top: Math.round(anchorRect.top),
      bottom: Math.round(anchorRect.bottom),
      left: Math.round(anchorRect.left),
      right: Math.round(anchorRect.right),
    })
  }, [isRepoImportBusy])

  useEffect(() => {
    if (!importMenuAnchor) return undefined

    const closeMenu = () => setImportMenuAnchor(null)
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [importMenuAnchor])

  const applyDefaultRepoSettings = useCallback(async (repoId) => {
    await invoke('update_repo', {
      repoId,
      syncMode: settings.defaultSyncMode,
      syncInterval: settings.defaultSyncInterval,
      pullStrategy: settings.defaultPullStrategy,
    })
  }, [settings.defaultPullStrategy, settings.defaultSyncInterval, settings.defaultSyncMode])

  const handleImportLocalRepos = async () => {
    if (isRepoImportBusy) return

    try {
      const selected = await open({
        directory: true,
        multiple: true,
        title: '选择一个或多个 Git 仓库目录',
      })
      if (!selected) return

      const selectedPaths = (Array.isArray(selected) ? selected : [selected])
        .map((path) => String(path || '').trim())
        .filter(Boolean)
      if (selectedPaths.length === 0) return

      const uniquePathMap = new Map()
      const duplicateInSelection = []
      for (const path of selectedPaths) {
        const key = normalizeRepoPath(path)
        if (!key) continue
        if (uniquePathMap.has(key)) {
          duplicateInSelection.push(path)
          continue
        }
        uniquePathMap.set(key, path)
      }
      const uniquePaths = Array.from(uniquePathMap.values())

      const existingPathSet = new Set((reposRef.current || []).map((repo) => normalizeRepoPath(repo.path)))
      const pathsToImport = []
      const skippedExisting = []
      for (const path of uniquePaths) {
        const key = normalizeRepoPath(path)
        if (existingPathSet.has(key)) {
          skippedExisting.push(path)
        } else {
          pathsToImport.push(path)
        }
      }

      const shouldShowImportLoading = pathsToImport.length > 0
      let completedImportCount = 0
      if (shouldShowImportLoading) {
        setImportLoadingData({
          phase: 'importing',
          totalCount: pathsToImport.length,
          completedCount: 0,
        })
      }

      const importResults = await mapWithConcurrencyLimit(
        pathsToImport,
        BATCH_IMPORT_CONCURRENCY,
        async (path) => {
          try {
            const addedRepo = await invoke('add_repo', { path })
            try {
              await applyDefaultRepoSettings(addedRepo.id)
              return {
                path,
                success: true,
                warning: null,
              }
            } catch (error) {
              return {
                path,
                success: true,
                warning: {
                  path,
                  message: `仓库已导入，但默认设置应用失败: ${getErrorMessage(error)}`,
                },
              }
            }
          } catch (error) {
            return {
              path,
              success: false,
              failure: {
                path,
                message: getErrorMessage(error),
              },
            }
          } finally {
            if (!shouldShowImportLoading) return
            completedImportCount += 1
            setImportLoadingData((prev) => {
              if (!prev || prev.phase !== 'importing') return prev
              return {
                ...prev,
                completedCount: Math.min(pathsToImport.length, completedImportCount),
              }
            })
          }
        }
      )

      const { successCount, failures, warnings } = summarizeImportResults(importResults)

      if (successCount > 0) {
        if (shouldShowImportLoading) {
          setImportLoadingData((prev) => {
            if (!prev) return prev
            return {
              ...prev,
              phase: 'refreshing',
              completedCount: prev.totalCount,
            }
          })
        }
        await fetchRepos()
      }

      if (shouldShowImportLoading) {
        setImportLoadingData(null)
      }

      const title = selectedPaths.length > 1 ? '批量导入结果' : '本地导入结果'
      setImportResultData({
        title,
        selectedCount: selectedPaths.length,
        uniqueCount: uniquePaths.length,
        duplicateInSelection,
        skippedExisting,
        attemptedCount: pathsToImport.length,
        successCount,
        failures,
        warnings,
      })
    } catch (error) {
      setImportLoadingData(null)
      setNoticeData({
        title: '导入失败',
        message: getErrorMessage(error),
      })
    }
  }

  const handleCloneRepo = useCallback(async ({ repoUrl, localPath }) => {
    if (isRepoImportBusy) {
      return {
        success: false,
        message: '当前有导入或克隆任务正在进行，请稍后再试。',
      }
    }

    setIsCloningRepo(true)
    try {
      const addedRepo = await invoke('clone_repo', {
        repoUrl,
        parentPath: localPath,
        cloneTaskId: null,
      })

      let warningMessage = ''
      try {
        await applyDefaultRepoSettings(addedRepo.id)
      } catch (error) {
        warningMessage = `默认设置应用失败：${getErrorMessage(error)}`
      }

      setLastCloneParentPath(String(localPath || '').trim())
      await fetchRepos()
      setCloneDialogOpen(false)
      setNoticeData({
        title: warningMessage ? '克隆完成（含警告）' : '克隆成功',
        message: warningMessage
          ? `${addedRepo.name || '仓库'} 已克隆并导入。\n${warningMessage}`
          : `${addedRepo.name || '仓库'} 已克隆并导入列表。`,
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        message: getErrorMessage(error),
      }
    } finally {
      setIsCloningRepo(false)
    }
  }, [applyDefaultRepoSettings, fetchRepos, isRepoImportBusy])

  const handleSelectImportLocal = () => {
    closeImportEntryMenu()
    void handleImportLocalRepos()
  }

  const handleSelectCloneRepo = () => {
    closeImportEntryMenu()
    if (isRepoImportBusy) return
    setCloneDialogOpen(true)
  }

  const handleSelectGithubRepos = async () => {
    closeImportEntryMenu()
    if (isRepoImportBusy) return
    if (!githubAccount) {
      const restored = await restoreGithubAccountOnDemand()
      if (!restored?.account) {
        if (restored && restored.reason !== 'no-token' && restored.reason !== 'unauthorized') {
          setNoticeData(buildGithubConnectivityNotice(restored))
          return
        }
        pendingGithubRepoBrowserOpenRef.current = true
        setPage('settings')
        return
      }
    }
    setGithubRepoBrowserOpen(true)
  }

  const handleCloneGithubRepo = useCallback(async (githubRepo, parentPath, options = {}) => {
    if (isRepoImportBusy) {
      return {
        success: false,
        message: '当前有导入或克隆任务正在进行，请稍后再试。',
      }
    }

    try {
      const addedRepo = await invoke('clone_repo', {
        repoUrl: githubRepo.ssh_url,
        parentPath,
        cloneTaskId: options?.cloneTaskId || null,
      })

      let warning = ''
      try {
        await applyDefaultRepoSettings(addedRepo.id)
      } catch (error) {
        warning = `默认设置应用失败：${getErrorMessage(error)}`
      }

      return { success: true, warning }
    } catch (error) {
      const message = getErrorMessage(error)
      return {
        success: false,
        canceled: message.includes('克隆已取消'),
        message,
      }
    }
  }, [applyDefaultRepoSettings, isRepoImportBusy])

  const handleCancelGithubClone = useCallback(async (cloneTaskId) => {
    await invoke('cancel_clone_task', { cloneTaskId })
    return { success: true }
  }, [])

  const handleGithubBatchCloneComplete = useCallback(async ({
    parentPath,
    totalCount,
    successCount,
    failureCount,
    canceledCount = 0,
    warnings,
  }) => {
    setLastCloneParentPath(String(parentPath || '').trim())
    await fetchRepos()

    // 关闭 GitHub 浏览弹窗，回到 dashboard
    setGithubRepoBrowserOpen(false)

    const warningCount = Array.isArray(warnings) ? warnings.length : 0
    const detailParts = [
      `成功 ${successCount}/${totalCount} 个`,
      failureCount > 0 ? `失败 ${failureCount} 个` : '',
      canceledCount > 0 ? `取消 ${canceledCount} 个` : '',
      warningCount > 0 ? `警告 ${warningCount} 个` : '',
    ].filter(Boolean)

    const hasIncomplete = failureCount > 0 || canceledCount > 0
    const isSingle = totalCount === 1
    let title = 'GitHub 批量克隆完成'
    if (isSingle) {
      title = 'GitHub 克隆完成'
    } else if (hasIncomplete) {
      title = 'GitHub 批量克隆完成（含未完成）'
    }
    setNoticeData({
      title,
      message: detailParts.join('，'),
    })
  }, [fetchRepos])

  const activeSyncJobs = useMemo(
    () => syncJobs.filter(isSyncJobActive),
    [syncJobs]
  )
  const latestRetryableJobMap = useMemo(
    () => getLatestRetryableJobsByRepo(syncJobs),
    [syncJobs]
  )
  const repoQueueStateMap = useMemo(() => {
    const next = activeSyncJobs.reduce((acc, job) => {
      if (acc[job.repoId] === SYNC_JOB_STATUS.running) return acc
      acc[job.repoId] = job.status
      return acc
    }, {})
    for (const repoId of syncAllPreparingRepoIds) {
      if (next[repoId]) continue
      next[repoId] = SYNC_JOB_STATUS.queued
    }
    for (const repoId of syncChangedPreparingRepoIds) {
      if (next[repoId]) continue
      next[repoId] = SYNC_JOB_STATUS.queued
    }
    for (const repoId of syncFilteredPreparingRepoIds) {
      if (next[repoId]) continue
      next[repoId] = SYNC_JOB_STATUS.queued
    }
    return next
  }, [activeSyncJobs, syncAllPreparingRepoIds, syncChangedPreparingRepoIds, syncFilteredPreparingRepoIds])
  const hasActiveSyncJobs = activeSyncJobs.length > 0
  const isSyncAllPreparing = syncAllPreparingRepoIds.length > 0
  const isSyncChangedOnlyPreparing = syncChangedPreparingRepoIds.length > 0
  const isSyncFilteredPreparing = syncFilteredPreparingRepoIds.length > 0
  const isSyncAllActive = activeSyncJobs.some((job) => job.source === 'syncAll')
  const isSyncChangedOnlyActive = activeSyncJobs.some((job) => job.source === 'syncChanged')
  const isSyncFilteredActive = activeSyncJobs.some((job) => job.source === 'syncFiltered')
  const isSyncAllRunning = isSyncAllPreparing || isSyncAllActive
  const isSyncChangedOnlyRunning = isSyncChangedOnlyPreparing || isSyncChangedOnlyActive
  const isSyncFilteredRunning = isSyncFilteredPreparing || isSyncFilteredActive
  const syncAllButtonLabel = isSyncAllRunning ? '同步中...' : '全部同步'
  const syncChangedOnlyButtonLabel = isSyncChangedOnlyRunning ? '同步中...' : '按改动同步'
  const isBatchSyncing = activeSyncJobs.some((job) => job.source === 'batch')
  const failedRepoIds = repos
    .filter((repo) => !missingRepoIdsRef.current.has(repo.id))
    .filter(isRepoInFailedState)
    .map((repo) => repo.id)
  const failedRepoCount = failedRepoIds.length
  const syncCheckingRepoIdSet = useMemo(() => new Set(syncCheckingRepoIds), [syncCheckingRepoIds])
  const remoteRefreshingRepoIdSet = useMemo(() => {
    const next = new Set(remoteRefreshSnapshot.activeRepoIds)
    branchRefreshSnapshot.activeRepoIds.forEach((repoId) => next.add(repoId))
    return next
  }, [branchRefreshSnapshot, remoteRefreshSnapshot])
  const branchRefreshingRepoIdSet = useMemo(
    () => new Set(branchRefreshingRepoIds),
    [branchRefreshingRepoIds]
  )

  const createCommitHistoryFlightSnapshot = useCallback((repoId) => {
    const repo = reposRef.current.find((item) => item.id === repoId)
    if (!repo) return null
    const status = repoStatuses[repoId] || null
    return {
      repo,
      status,
      statusIssue: repoStatusIssues[repoId],
      statusIssueNow: statusIssueNowTick,
      queueState: repoQueueStateMap[repoId],
      isSyncChecking: syncCheckingRepoIdSet.has(repoId),
      isRemoteRefreshing: remoteRefreshingRepoIdSet.has(repoId),
      isFocusRefreshing: isFocusRefreshingAll,
      isPathMissing: Boolean(missingRepoStates[repoId]),
      pathMissingMessage: missingRepoStates[repoId]?.message || '',
      postSyncBuildState: postSyncBuildStates[repoId],
      canRetrySync: Boolean(latestRetryableJobMap[repoId]) && !repoQueueStateMap[repoId],
      branchOverviewSnapshot: repoBranchOverviews[repoId] || null,
      dismissedBranchAttentionKey: dismissedBranchAttentionKeys[repoId] || '',
    }
  }, [
    dismissedBranchAttentionKeys,
    isFocusRefreshingAll,
    latestRetryableJobMap,
    missingRepoStates,
    postSyncBuildStates,
    remoteRefreshingRepoIdSet,
    repoBranchOverviews,
    repoQueueStateMap,
    repoStatusIssues,
    repoStatuses,
    statusIssueNowTick,
    syncCheckingRepoIdSet,
  ])

  const handleSync = async (repoId, requestOptions = {}) => {
    if (syncCheckingRepoIdsRef.current.has(repoId)) return
    setRepoSyncChecking(repoId, true)
    try {
      await enqueueWithSyncGuards(
        [repoId],
        'manual',
        { trigger: requestOptions.trigger || 'card_button' }
      )
    } finally {
      setRepoSyncChecking(repoId, false)
    }
  }

  const handleCancelSync = (repoId) => {
    cancelSyncJobsByRepoIds([repoId], SYNC_CANCEL_MESSAGE_PRESETS.manual)
  }

  const handleRetrySync = async (repoId) => {
    if (syncCheckingRepoIdsRef.current.has(repoId)) return
    const latestJob = latestRetryableJobMap[repoId]
    if (!latestJob) {
      setNoticeData({
        title: RETRY_SYNC_NOTICE_TITLE,
        message: '当前仓库暂无可重试任务。',
      })
      return
    }

    setRepoSyncChecking(repoId, true)
    try {
      const nextAttempt = Math.max(1, (latestJob.attempt || 1) + 1)
      const { enqueuedCount, skippedCount, blockedCount, warningCount, delayedByGuardDialog } = await enqueueWithSyncGuards(
        [repoId],
        'retry',
        { attempt: nextAttempt }
      )
      if (delayedByGuardDialog) return

      if (blockedCount > 0 && enqueuedCount === 0) {
        return
      }
      if (enqueuedCount === 0 && skippedCount > 0) {
        setNoticeData({
          title: RETRY_SYNC_NOTICE_TITLE,
          message: '任务已在队列或正在执行中。',
        })
        return
      }
      if (warningCount > 0) {
        setNoticeData({
          title: RETRY_SYNC_NOTICE_TITLE,
          message: `已加入重试队列 ${enqueuedCount} 个，存在 ${warningCount} 个警告项。`,
        })
      }
    } finally {
      setRepoSyncChecking(repoId, false)
    }
  }

  const handlePause = async (repoId) => {
    cancelSyncJobsByRepoIds([repoId], SYNC_CANCEL_MESSAGE_PRESETS.paused)
    await invoke('update_repo', { repoId, status: 'paused' })
    await fetchRepos()
  }

  const handleResume = async (repoId) => {
    await invoke('update_repo', { repoId, status: 'idle' })
    await fetchRepos()
  }

  const resolveRepoById = (repoId) => repos.find((r) => r.id === repoId)

  const updateRepoAndRefresh = useCallback(async (repoId, payload, errorTitle) => {
    try {
      await invoke('update_repo', { repoId, ...payload })
      await fetchRepos()
      return true
    } catch (error) {
      setNoticeData({
        title: errorTitle,
        message: getErrorMessage(error),
      })
      return false
    }
  }, [fetchRepos])

  const pickRepoBuildScript = async (repoId, { enableAfterSelect = false } = {}) => {
    const repo = resolveRepoById(repoId)
    if (!repo) return
    const scriptSupport = getBuildScriptSupport()

    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: `选择 ${repo.name || repoId} 的同步后脚本`,
        defaultPath: repo.path,
        filters: scriptSupport.filters,
      })
      if (!picked) return

      const selectedPath = Array.isArray(picked) ? picked[0] : picked
      if (!selectedPath) return

      if (!isSupportedBuildScriptFile(selectedPath, scriptSupport.extensions)) {
        setNoticeData({
          title: '脚本选择',
          message: `仅支持 ${scriptSupport.extensionsText} 文件。`,
        })
        return
      }

      const relativePath = toRepoRelativeScriptPath(repo.path, selectedPath)
      if (!relativePath) {
        setNoticeData({
          title: '脚本选择',
          message: '请选择当前仓库目录内的脚本文件。',
        })
        return
      }

      const payload = {
        postSyncBuildScript: relativePath,
        ...(enableAfterSelect ? { postSyncBuildEnabled: true } : {}),
      }
      await updateRepoAndRefresh(repoId, payload, '脚本选择失败')
    } catch (error) {
      setNoticeData({
        title: '脚本选择失败',
        message: getErrorMessage(error),
      })
    }
  }

  const handleSelectPostSyncBuildScript = async (repoId) => {
    await pickRepoBuildScript(repoId, { enableAfterSelect: false })
  }

  const handleTogglePostSyncBuild = async (repoId) => {
    const repo = resolveRepoById(repoId)
    if (!repo) return

    const scriptSupport = getBuildScriptSupport()
    const selectedScript = String(repo.post_sync_build_script || '').trim()
    const enabled = Boolean(repo.post_sync_build_enabled)
    if (enabled) {
      await updateRepoAndRefresh(repoId, { postSyncBuildEnabled: false }, '关闭开关失败')
      setPostSyncBuildState(repoId, POST_SYNC_BUILD_STATE.idle)
      return
    }

    if (!selectedScript) {
      await pickRepoBuildScript(repoId, { enableAfterSelect: true })
      return
    }

    if (!isSupportedBuildScriptFile(selectedScript, scriptSupport.extensions)) {
      setNoticeData({
        title: '开启开关失败',
        message: `当前系统仅支持 ${scriptSupport.extensionsText} 脚本，请重新选择。`,
      })
      return
    }

    await updateRepoAndRefresh(repoId, { postSyncBuildEnabled: true }, '开启开关失败')
  }

  const handleClearPostSyncBuildScript = async (repoId) => {
    await updateRepoAndRefresh(
      repoId,
      {
        postSyncBuildEnabled: false,
        postSyncBuildScript: '',
      },
      '清空脚本失败'
    )
    setPostSyncBuildState(repoId, POST_SYNC_BUILD_STATE.idle)
  }

  const handleRunPostSyncBuildScriptNow = async (repoId) => {
    await executePostSyncBuildScript(repoId, {
      allowDisabled: true,
      showResultNotice: true,
      openLogDialog: true,
      triggerSource: 'manual',
      useSystemTerminal: true,
    })
  }

  const handleOpenDirectory = async (repoId) => {
    const repo = resolveRepoById(repoId)
    if (!repo) return
    try {
      await invoke('open_repo_directory', { path: repo.path })
      clearRepoPathMissing(repoId)
    } catch (error) {
      const { errorMessage } = markMissingRepoFromMessage(repoId, error)
      setNoticeData({
        title: '打开目录失败',
        message: errorMessage,
      })
    }
  }

  const handleOpenWithApp = async (repoId) => {
    const repo = resolveRepoById(repoId)
    if (!repo) return

    const app = String(settings.defaultOpenApp || '').trim()
    if (!app) {
      setNoticeData({
        title: '未设置默认应用',
        message: '请先到「设置 > 应用设置」中选择默认打开应用。',
      })
      return
    }

    try {
      await invoke('open_repo_directory_with_app', { path: repo.path, app })
      clearRepoPathMissing(repoId)
    } catch (error) {
      const { errorMessage } = markMissingRepoFromMessage(repoId, error)
      setNoticeData({
        title: '应用打开失败',
        message: errorMessage,
      })
    }
  }

  const handleOpenWithTerminal = async (repoId) => {
    const repo = resolveRepoById(repoId)
    if (!repo) return

    const terminalApp = String(settings.defaultTerminalApp || '').trim()
    if (!terminalApp) {
      setNoticeData({
        title: '未设置终端应用',
        message: '请先到「设置 > 应用设置」中选择默认终端应用。',
      })
      return
    }

    try {
      await invoke('open_repo_directory_with_app', { path: repo.path, app: terminalApp })
      clearRepoPathMissing(repoId)
    } catch (error) {
      const { errorMessage } = markMissingRepoFromMessage(repoId, error)
      setNoticeData({
        title: '终端打开失败',
        message: errorMessage,
      })
    }
  }

  const handleOpenGitHubRepo = async (repoId) => {
    const repo = resolveRepoById(repoId)
    if (!repo) return

    const gitHubRepoUrl = getGitHubRepoUrlFromRemote(repo.remote)
    if (!gitHubRepoUrl) {
      setNoticeData({
        title: '未检测到 GitHub 仓库',
        message: '当前仓库的 origin 远端不是 GitHub 地址。',
      })
      return
    }

    try {
      await openUrl(gitHubRepoUrl)
    } catch (error) {
      setNoticeData({
        title: '打开 GitHub 仓库失败',
        message: getErrorMessage(error),
      })
    }
  }

  const handleViewCommitHistory = useCallback((repoId) => {
    const repo = reposRef.current.find((item) => item.id === repoId)
    if (!repo) return
    if (commitHistoryFocusRestoreFrameRef.current) {
      cancelAnimationFrame(commitHistoryFocusRestoreFrameRef.current)
      commitHistoryFocusRestoreFrameRef.current = null
    }
    commitHistoryFocusReturnRepoIdRef.current = String(repoId)
    commitHistoryFlightSnapshotRef.current = createCommitHistoryFlightSnapshot(repoId)
    if (commitHistoryCloseTimerRef.current) {
      clearTimeout(commitHistoryCloseTimerRef.current)
      commitHistoryCloseTimerRef.current = null
    }
    const defaultBranch = getCommitHistoryDefaultBranch(repo, repoStatuses[repoId])
    setImportMenuAnchor(null)
    setIsDashboardSearchOpen(false)
    setDashboardSearchKeyword('')
    setPage('dashboard')
    setCommitHistoryDrawerClosing(false)
    setCommitHistoryHeroReady(false)
    setCommitHistoryFlightPhase(COMMIT_HISTORY_FLIGHT_PHASE.preparingOpen)
    setCommitHistoryHandoffRepoId(null)
    setCommitHistoryHandoffHeight(null)
    setCommitHistoryHandoffSourceHeight(null)
    commitHistoryHandoffHeightRef.current = null
    setCommitHistoryHeroStartRect(getRepoCardScreenRect(repoId))
    setCommitHistoryBranchByRepo((prev) => (
      prev[repoId] ? prev : { ...prev, [repoId]: defaultBranch }
    ))
    setCommitHistoryRepoId(repoId)
  }, [createCommitHistoryFlightSnapshot, repoStatuses])

  const finishCommitHistoryClose = useCallback((finalFlightRect = null, terminalPhase = COMMIT_HISTORY_FLIGHT_PHASE.handoff) => {
    const focusReturnRepoId = commitHistoryFocusReturnRepoIdRef.current
    const shouldRevealSource = terminalPhase === COMMIT_HISTORY_FLIGHT_PHASE.handoff && focusReturnRepoId
    const finalFlightHeight = Number(finalFlightRect?.height)
    const measuredHandoffHeight = Number(commitHistoryHandoffHeightRef.current)
    const handoffRevealHeight = Number.isFinite(finalFlightHeight) && finalFlightHeight > 0
      ? finalFlightHeight
      : measuredHandoffHeight
    const sourceTargetRect = shouldRevealSource
      ? getRepoCardProjectedRestingRect(focusReturnRepoId)
      : null
    const sourceTargetHeight = Number(sourceTargetRect?.height)
    const hasSourceTargetHeight = Number.isFinite(sourceTargetHeight) && sourceTargetHeight > 0
    const canRevealSource = Boolean(
      shouldRevealSource
      && Number.isFinite(handoffRevealHeight)
      && handoffRevealHeight > 0
      && hasSourceTargetHeight
      && sourceTargetHeight >= handoffRevealHeight
    )
    const resolvedSourceHeight = canRevealSource ? sourceTargetHeight : null
    if (commitHistoryCloseTimerRef.current) {
      clearTimeout(commitHistoryCloseTimerRef.current)
      commitHistoryCloseTimerRef.current = null
    }
    setCommitHistoryRepoId(null)
    setCommitHistoryDrawerClosing(false)
    setCommitHistoryLoadState({
      cacheKey: '',
      loading: false,
      refreshing: false,
      error: '',
    })
    setCommitHistoryHeroStartRect(null)
    setCommitHistoryHeroReady(false)
    setCommitHistoryFlightPhase(terminalPhase)
    setCommitHistoryHandoffRepoId(canRevealSource ? focusReturnRepoId : null)
    setCommitHistoryHandoffHeight(
      canRevealSource
        ? handoffRevealHeight
        : null
    )
    setCommitHistoryHandoffSourceHeight(canRevealSource ? resolvedSourceHeight : null)
    commitHistoryHandoffHeightRef.current = null
    commitHistoryFlightSnapshotRef.current = null

    if (focusReturnRepoId && typeof window !== 'undefined') {
      commitHistoryFocusRestoreFrameRef.current = requestAnimationFrame(() => {
        commitHistoryFocusRestoreFrameRef.current = null
        if (commitHistoryFocusReturnRepoIdRef.current !== focusReturnRepoId) return
        const sourceCard = Array.from(document.querySelectorAll('[data-repo-card-id]')).find((item) => (
          item?.dataset?.repoCardId === focusReturnRepoId
            && !item.closest('.commit-history-stage')
        ))
        const focusTarget = sourceCard?.querySelector('.repo-card__history-link')
        if (!focusTarget || focusTarget.disabled || focusTarget.getAttribute('aria-hidden') === 'true') {
          commitHistoryFocusReturnRepoIdRef.current = null
          return
        }
        commitHistoryFocusReturnRepoIdRef.current = null
        try {
          focusTarget.focus({ preventScroll: true })
        } catch (_) {
          focusTarget.focus()
        }
      })
    }
  }, [])

  const handleCommitHistoryFlightStart = useCallback((direction) => {
    setCommitHistoryFlightPhase(
      direction === 'closing'
        ? COMMIT_HISTORY_FLIGHT_PHASE.closing
        : COMMIT_HISTORY_FLIGHT_PHASE.opening
    )
  }, [])

  const handleCommitHistoryFlightReady = useCallback(() => {
    // The snapshot owns the opening flight only. Once the live hero has
    // reached its settled geometry, release it so normal dashboard updates
    // can flow through the stable card again.
    commitHistoryFlightSnapshotRef.current = null
    setCommitHistoryHeroReady(true)
    setCommitHistoryFlightPhase(COMMIT_HISTORY_FLIGHT_PHASE.open)
  }, [])

  const handleCommitHistoryFlightAbort = useCallback(() => {
    finishCommitHistoryClose(null, COMMIT_HISTORY_FLIGHT_PHASE.aborting)
  }, [finishCommitHistoryClose])

  const handleCloseCommitHistory = useCallback(() => {
    if (commitHistoryCloseTimerRef.current) {
      clearTimeout(commitHistoryCloseTimerRef.current)
      commitHistoryCloseTimerRef.current = null
    }
    if (!commitHistoryRepoId) return
    const heroSurface = typeof document !== 'undefined'
      ? document.querySelector('.commit-history-hero-card .repo-card--history-flight')
      : null
    const measuredHandoffHeight = Number(heroSurface?.getBoundingClientRect().height)
    commitHistoryHandoffHeightRef.current = Number.isFinite(measuredHandoffHeight) && measuredHandoffHeight > 0
      ? measuredHandoffHeight
      : null
    if (!commitHistoryFlightSnapshotRef.current) {
      commitHistoryFlightSnapshotRef.current = createCommitHistoryFlightSnapshot(commitHistoryRepoId)
    }
    setCommitHistoryFlightPhase(COMMIT_HISTORY_FLIGHT_PHASE.preparingClose)
    setCommitHistoryHeroReady(false)
    setCommitHistoryHeroStartRect(null)
    setCommitHistoryDrawerClosing(true)
  }, [commitHistoryRepoId, createCommitHistoryFlightSnapshot])

  useLayoutEffect(() => {
    if (!commitHistoryDrawerClosing || !commitHistoryRepoId || commitHistoryHeroStartRect) return

    const targetRect = getRepoCardProjectedRestingRect(commitHistoryRepoId) || getRepoCardScreenRect(commitHistoryRepoId)
    if (!targetRect) {
      setCommitHistoryFlightPhase(COMMIT_HISTORY_FLIGHT_PHASE.aborting)
      finishCommitHistoryClose(null, COMMIT_HISTORY_FLIGHT_PHASE.aborting)
      return
    }

    setCommitHistoryHeroStartRect(targetRect)
    commitHistoryCloseTimerRef.current = setTimeout(
      finishCommitHistoryClose,
      COMMIT_HISTORY_DRAWER_EXIT_FALLBACK_MS
    )
  }, [
    commitHistoryDrawerClosing,
    commitHistoryHeroStartRect,
    commitHistoryRepoId,
    finishCommitHistoryClose,
  ])

  useEffect(() => {
    if (
      commitHistoryFlightPhase !== COMMIT_HISTORY_FLIGHT_PHASE.handoff
      && commitHistoryFlightPhase !== COMMIT_HISTORY_FLIGHT_PHASE.aborting
    ) return undefined

    const frameId = requestAnimationFrame(() => {
      setCommitHistoryFlightPhase(COMMIT_HISTORY_FLIGHT_PHASE.closed)
    })
    if (commitHistoryFlightPhase === COMMIT_HISTORY_FLIGHT_PHASE.aborting) {
      setCommitHistoryHandoffRepoId(null)
      setCommitHistoryHandoffHeight(null)
      setCommitHistoryHandoffSourceHeight(null)
      return () => cancelAnimationFrame(frameId)
    }

    return () => cancelAnimationFrame(frameId)
  }, [commitHistoryFlightPhase])

  useEffect(() => {
    if (!commitHistoryHandoffRepoId) return undefined

    const revealTimerId = window.setTimeout(() => {
      setCommitHistoryHandoffRepoId(null)
      setCommitHistoryHandoffHeight(null)
      setCommitHistoryHandoffSourceHeight(null)
    }, COMMIT_HISTORY_HANDOFF_REVEAL_MS)

    return () => window.clearTimeout(revealTimerId)
  }, [commitHistoryHandoffRepoId])

  const handleCommitHistoryCountChange = useCallback((nextCount) => {
    setCommitHistoryCount(normalizeCommitHistoryCount(nextCount))
  }, [])

  const handleCommitHistoryBranchChange = useCallback((nextBranch) => {
    const normalizedBranch = normalizeCommitHistoryBranchName(nextBranch)
    if (!commitHistoryRepoId || !normalizedBranch) return
    setCommitHistoryBranchByRepo((prev) => ({
      ...prev,
      [commitHistoryRepoId]: normalizedBranch,
    }))
  }, [commitHistoryRepoId])

  const handleCopyCommitHash = useCallback(async (hash) => {
    const text = String(hash || '').trim()
    if (!text) return
    try {
      await invoke('write_clipboard', { text })
      setStatusToastData({
        title: '已复制提交 hash',
        message: text,
        tone: 'success',
      })
    } catch (error) {
      setNoticeData({
        title: '复制失败',
        message: getErrorMessage(error),
      })
    }
  }, [])

  const handleCopyRepoMeta = useCallback(async (kind, value) => {
    const text = String(value || '').trim()
    if (!text) return
    const label = kind === 'path' ? '路径' : '分支'
    try {
      await invoke('write_clipboard', { text })
      setStatusToastData({
        title: '复制成功',
        message: `已复制${label}：${text}`,
        tone: 'success',
      })
    } catch (error) {
      setNoticeData({
        title: '复制失败',
        message: getErrorMessage(error),
      })
    }
  }, [])

  useEffect(() => () => {
    if (commitHistoryCloseTimerRef.current) {
      clearTimeout(commitHistoryCloseTimerRef.current)
      commitHistoryCloseTimerRef.current = null
    }
    if (commitHistoryFocusRestoreFrameRef.current) {
      cancelAnimationFrame(commitHistoryFocusRestoreFrameRef.current)
      commitHistoryFocusRestoreFrameRef.current = null
    }
  }, [])

  const removeReposFromBackend = async (targetRepos) => {
    const reposToRemove = Array.isArray(targetRepos) ? targetRepos : []
    if (reposToRemove.length === 0) return { successCount: 0, failures: [], removedIds: [] }
    const repoIds = normalizeRepoIdsForRemoval(reposToRemove)
    if (repoIds.length === 0) return { successCount: 0, failures: [], removedIds: [] }

    const batchResult = await invoke('remove_repos_batch', { repoIds })
    return buildRemoveReposOutcome(reposToRemove, batchResult)
  }

  const handleSyncAll = async () => {
    if (isSyncAllRunning) return
    const targets = repos.filter((repo) => repo.status !== 'paused').map((repo) => repo.id)
    if (targets.length === 0) return

    setSyncAllPreparingRepoIds(targets)
    try {
      const {
        enqueuedCount,
        skippedCount,
        blockedCount,
        warningCount,
        delayedByGuardDialog,
      } = await enqueueWithSyncGuards(targets, 'syncAll')
      if (delayedByGuardDialog) return
      if (enqueuedCount === 0 && skippedCount > 0) {
        setNoticeData({
          title: '全部同步',
          message: '目标仓库已在队列或正在同步中。',
        })
        return
      }
      if (skippedCount > 0 || blockedCount > 0 || warningCount > 0) {
        setNoticeData({
          title: '全部同步',
          message: formatSyncQueueNoticeMessage({
            enqueuedCount,
            skippedCount,
            blockedCount,
            warningCount,
            skippedLabel: '已在队列或执行中',
          }),
        })
      }
    } finally {
      setSyncAllPreparingRepoIds([])
    }
  }

  const handleSyncChangedOnly = async () => {
    if (isSyncChangedOnlyRunning) return
    const targets = repos.filter((repo) => repo.status !== 'paused').map((repo) => repo.id)
    if (targets.length === 0) return

    setSyncChangedPreparingRepoIds(targets)
    try {
      const {
        enqueuedCount,
        skippedCount,
        blockedCount,
        warningCount,
        delayedByGuardDialog,
      } = await enqueueWithSyncGuards(
        targets,
        'syncChanged',
        {
          syncBehavior: 'changesOnly',
        }
      )
      if (delayedByGuardDialog) return
      if (enqueuedCount === 0 && skippedCount > 0) {
        setNoticeData({
          title: '按改动同步',
          message: '目标仓库已在队列或正在同步中。',
        })
        return
      }
      if (skippedCount > 0 || blockedCount > 0 || warningCount > 0) {
        setNoticeData({
          title: '按改动同步',
          message: formatSyncQueueNoticeMessage({
            enqueuedCount,
            skippedCount,
            blockedCount,
            warningCount,
            skippedLabel: '已在队列或执行中',
          }),
        })
      }
    } finally {
      setSyncChangedPreparingRepoIds([])
    }
  }

  const handleSyncFailedOnly = async () => {
    if (hasActiveSyncJobs) return
    if (failedRepoIds.length === 0) {
      setNoticeData({
        title: '失败仓库同步',
        message: '当前没有可同步的失败仓库。',
      })
      return
    }

    const {
      enqueuedCount,
      skippedCount,
      blockedCount,
      warningCount,
      delayedByGuardDialog,
    } = await enqueueWithSyncGuards(failedRepoIds, 'syncFailed')

    if (delayedByGuardDialog) return
    if (enqueuedCount === 0 && skippedCount > 0) {
      setNoticeData({
        title: '失败仓库同步',
        message: '目标仓库已在队列或正在同步中。',
      })
      return
    }
    if (skippedCount > 0 || blockedCount > 0 || warningCount > 0) {
      setNoticeData({
        title: '失败仓库同步',
        message: formatSyncQueueNoticeMessage({
          enqueuedCount,
          skippedCount,
          blockedCount,
          warningCount,
          skippedLabel: '已在队列或执行中',
        }),
      })
    }
  }

  const handleViewErrors = (repoId) => {
    const repo = repos.find((r) => r.id === repoId)
    if (!repo) return
    const hasErrors = Boolean(repo.last_error) || (repo.error_logs?.length || 0) > 0
    if (!hasErrors) return
    setErrorLogData({
      repoId: repo.id,
      repoName: repo.name,
      errorLogs: repo.error_logs || [],
    })
  }

  const handleClearSyncHistory = () => {
    setSyncHistory([])
    writeLocalStorageItem(SYNC_DIAGNOSTIC_STORAGE_KEY, '[]')
  }

  const handleCopyDiagnosticBundle = async () => {
    const events = loadSyncDiagnosticEvents()
    const errorEntries = loadAppErrorLog()
    const payload = createDiagnosticBundlePayload({
      appVersion,
      syncDiagnostics: { schemaVersion: SYNC_DIAGNOSTIC_SCHEMA_VERSION, events },
      appErrorLog: { schemaVersion: APP_ERROR_LOG_SCHEMA_VERSION, entries: errorEntries },
    })

    if (isDiagnosticBundleEmpty(payload)) {
      setNoticeData({
        title: '诊断日志',
        message: '暂无可复制的同步诊断或错误记录。',
      })
      return
    }

    try {
      await invoke('write_clipboard', { text: formatDiagnosticBundleForClipboard(payload) })
      setStatusToastData({
        title: '诊断日志已复制',
        message: `已复制 ${events.length} 条同步事件和 ${errorEntries.length} 条错误记录。`,
        tone: 'success',
      })
    } catch (error) {
      setNoticeData({
        title: '复制失败',
        message: getErrorMessage(error),
      })
    }
  }

  const toggleRepoSelection = (repoId) => {
    if (!batchMode) return
    setSelectedRepoIds((prev) => (
      prev.includes(repoId)
        ? prev.filter((id) => id !== repoId)
        : [...prev, repoId]
    ))
  }

  const clearSelectedRepos = () => {
    setSelectedRepoIds([])
  }

  const toggleSelectAllRepos = () => {
    if (!batchMode) return
    setSelectedRepoIds((prev) => toggleVisibleRepoSelection(prev, dashboardVisibleRepoIds))
  }
  const isBatchRunning = Boolean(batchAction)

  const enterBatchMode = () => {
    setBatchMode(true)
  }

  const exitBatchMode = () => {
    if (isBatchRunning || removingRepo) return
    setBatchMode(false)
    setSelectedRepoIds([])
    if ((deleteConfirmData?.repos?.length || 0) > 1) {
      setDeleteConfirmData(null)
    }
  }

  const handleBatchSync = async () => {
    if (isBatchRunning || isBatchSyncing) return
    const targets = visibleSelectedRepos.filter((repo) => repo.status !== 'paused').map((repo) => repo.id)
    if (targets.length === 0) return

    const {
      enqueuedCount,
      skippedCount,
      blockedCount,
      warningCount,
      delayedByGuardDialog,
    } = await enqueueWithSyncGuards(targets, 'batch')
    if (delayedByGuardDialog) return
    if (enqueuedCount === 0 && skippedCount > 0) {
      setNoticeData({
        title: '批量同步',
        message: '所选仓库已在队列或正在执行中。',
      })
      return
    }
    if (skippedCount > 0 || blockedCount > 0 || warningCount > 0) {
      setNoticeData({
        title: '批量同步',
        message: formatSyncQueueNoticeMessage({
          enqueuedCount,
          skippedCount,
          blockedCount,
          warningCount,
        }),
      })
    }
  }

  const handleBatchPause = async () => {
    if (isBatchRunning) return
    const targets = visibleSelectedRepos.filter((repo) => repo.status !== 'paused')
    if (targets.length === 0) return

    cancelSyncJobsByRepoIds(targets.map((repo) => repo.id), SYNC_CANCEL_MESSAGE_PRESETS.paused)

    setBatchAction('pause')
    try {
      const results = await Promise.allSettled(
        targets.map((repo) => invoke('update_repo', { repoId: repo.id, status: 'paused' }))
      )
      const failures = results.filter((item) => item.status === 'rejected')
      if (failures.length > 0) {
        setNoticeData({
          title: '批量暂停结果',
          message: `批量暂停完成，但有 ${failures.length} 个仓库失败。`,
        })
      }
      await fetchRepos()
    } finally {
      setBatchAction(null)
    }
  }

  const handleBatchResume = async () => {
    if (isBatchRunning) return
    const targets = visibleSelectedRepos.filter((repo) => repo.status === 'paused')
    if (targets.length === 0) return

    setBatchAction('resume')
    try {
      const results = await Promise.allSettled(
        targets.map((repo) => invoke('update_repo', { repoId: repo.id, status: 'idle' }))
      )
      const failures = results.filter((item) => item.status === 'rejected')
      if (failures.length > 0) {
        setNoticeData({
          title: '批量恢复结果',
          message: `批量恢复完成，但有 ${failures.length} 个仓库失败。`,
        })
      }
      await fetchRepos()
    } finally {
      setBatchAction(null)
    }
  }

  const handleRequestRemove = (repoId) => {
    const repo = repos.find((r) => r.id === repoId)
    if (!repo) return
    setDeleteConfirmData({
      repos: [{ ...repo }],
    })
  }

  const handleRequestBatchRemove = () => {
    if (!batchMode || visibleSelectedRepos.length === 0) return
    setDeleteConfirmData({
      repos: visibleSelectedRepos.map((repo) => ({ ...repo })),
    })
  }

  const handleConfirmRemove = async () => {
    if (!deleteConfirmData || removingRepo || removeInFlightRef.current) return
    const reposToRemove = toArray(deleteConfirmData.repos).filter((repo) => Boolean(repo?.id))
    if (reposToRemove.length === 0) {
      setDeleteConfirmData(null)
      return
    }
    removeInFlightRef.current = true

    const removeSnapshot = createRepoRemovalSnapshot({
      reposToRemove,
      repoStatuses,
      missingRepoStates,
      selectedRepoIds,
      repoOrderSource: reposRef.current,
    })
    const { targetRepoIds, targetRepoIdSet } = removeSnapshot

    const rollbackRemovedRepos = (repoIdsToRollback) => {
      setRepos((prev) => {
        const next = rollbackReposState(prev, removeSnapshot, repoIdsToRollback)
        reposRef.current = next
        return next
      })
      setRepoStatuses((prev) => rollbackRepoStatusesState(prev, removeSnapshot, repoIdsToRollback))
      setMissingRepoStates((prev) => rollbackMissingRepoStatesState(prev, removeSnapshot, repoIdsToRollback))
      setSelectedRepoIds((prev) => rollbackSelectedRepoIdsState(prev, removeSnapshot, repoIdsToRollback))
    }

    setRemovingRepo(true)
    setDeleteConfirmData(null)
    beginRemoveMutation()

    // 秒响应：先本地移除，再后台执行删除与校准。
    setRepos((prev) => {
      const next = removeReposByIdSet(prev, targetRepoIdSet)
      reposRef.current = next
      return next
    })
    setRepoStatuses((prev) => removeRepoStatusesByIdSet(prev, targetRepoIdSet))
    setMissingRepoStates((prev) => removeMissingRepoStatesByIdSet(prev, targetRepoIdSet))
    try {
      const { successCount, failures, removedIds } = await removeReposFromBackend(reposToRemove)
      const removedSet = new Set(removedIds)
      const failedRepoIds = getFailedRepoIds(targetRepoIds, removedIds)

      if (failedRepoIds.length > 0) {
        rollbackRemovedRepos(failedRepoIds)
      }

      if (removedSet.size > 0) {
        const removedRepoPaths = reposToRemove
          .filter((repo) => removedSet.has(String(repo?.id || '').trim()))
          .map((repo) => repo?.path)
        clearBranchSnapshotsForPaths(removedRepoPaths)
        setRepoBranchOverviews((prev) => {
          let changed = false
          const next = { ...(prev || {}) }
          removedSet.forEach((repoId) => {
            if (!Object.prototype.hasOwnProperty.call(next, repoId)) return
            delete next[repoId]
            changed = true
          })
          return changed ? next : prev
        })
        setDismissedBranchAttentionKeys((prev) => {
          let changed = false
          const next = { ...(prev || {}) }
          removedSet.forEach((repoId) => {
            if (!Object.prototype.hasOwnProperty.call(next, repoId)) return
            delete next[repoId]
            changed = true
          })
          return changed ? next : prev
        })
        setSelectedRepoIds((prev) => prev.filter((id) => !removedSet.has(id)))
        setSyncJobs((prev) => prev.filter((job) => !removedSet.has(job.repoId)))
        updateCommitHistoryCache((prev) => removeCommitHistoryCacheForRepo(prev, Array.from(removedSet)))
        setCommitHistoryBranchByRepo((prev) => {
          const next = { ...prev }
          removedSet.forEach((repoId) => {
            delete next[repoId]
          })
          return next
        })
        const removedRepos = buildUndoRemovedRepos(reposToRemove, removeSnapshot, removedSet)

        if (removedRepos.length > 0) {
          setUndoRemoveData({
            repos: removedRepos,
            at: Date.now(),
          })
        }
      }

      if (failures.length > 0) {
        const preview = failures
          .slice(0, 3)
          .map((item) => `${item.name}: ${item.message}`)
          .join('\n')
        const more = failures.length > 3 ? `\n... 另有 ${failures.length - 3} 个仓库失败` : ''
        setNoticeData({
          title: '移除结果',
          message: `移除完成：成功 ${successCount}/${successCount + failures.length}\n\n${preview}${more}`,
        })
      }
    } catch (error) {
      rollbackRemovedRepos(targetRepoIds)
      setNoticeData({
        title: '移除失败',
        message: getErrorMessage(error),
      })
    } finally {
      void fetchRepos({ mode: FETCH_REPOS_MODE.light })
      endRemoveMutation()
      removeInFlightRef.current = false
      setRemovingRepo(false)
    }
  }

  const handleUndoRemove = async () => {
    if (!undoRemoveData || restoringRemovedRepos) return
    const reposToRestore = toArray(undoRemoveData.repos)
    if (reposToRestore.length === 0) {
      setUndoRemoveData(null)
      return
    }

    setRestoringRemovedRepos(true)
    try {
      const restoredCount = await invoke('restore_repos', { repos: reposToRestore })
      await fetchRepos()
      if (restoredCount <= 0) {
        setNoticeData({
          title: '撤销移除',
          message: '没有可恢复的仓库（可能已被重新添加）。',
        })
      }
      setUndoRemoveData(null)
    } catch (error) {
      setNoticeData({
        title: '撤销移除失败',
        message: getErrorMessage(error),
      })
    } finally {
      setRestoringRemovedRepos(false)
    }
  }

  const defaultOpenAppValue = String(settings.defaultOpenApp || '').trim()
  const defaultTerminalAppValue = String(settings.defaultTerminalApp || '').trim()
  const openWithAppText = defaultOpenAppValue
    ? `用 ${getAppDisplayName(defaultOpenAppValue)} 打开`
    : '用默认应用打开（未设置）'
  const openWithTerminalText = defaultTerminalAppValue
    ? `用 ${getAppDisplayName(defaultTerminalAppValue)} 打开终端`
    : '用终端打开（未设置）'
  const stableToggleRepoSelection = useEventCallback(toggleRepoSelection)
  const stableHandleSync = useEventCallback(handleSync)
  const stableHandleCancelSync = useEventCallback(handleCancelSync)
  const stableHandleRetrySync = useEventCallback(handleRetrySync)
  const stableHandlePause = useEventCallback(handlePause)
  const stableHandleResume = useEventCallback(handleResume)
  const stableHandleOpenDirectory = useEventCallback(handleOpenDirectory)
  const stableHandleOpenWithApp = useEventCallback(handleOpenWithApp)
  const stableHandleOpenWithTerminal = useEventCallback(handleOpenWithTerminal)
  const stableHandleOpenGitHubRepo = useEventCallback(handleOpenGitHubRepo)
  const stableHandleViewCommitHistory = useEventCallback(handleViewCommitHistory)
  const stableHandleRequestRemove = useEventCallback(handleRequestRemove)
  const stableHandleViewErrors = useEventCallback(handleViewErrors)
  const stableHandleTogglePostSyncBuild = useEventCallback(handleTogglePostSyncBuild)
  const stableHandleSelectPostSyncBuildScript = useEventCallback(handleSelectPostSyncBuildScript)
  const stableHandleClearPostSyncBuildScript = useEventCallback(handleClearPostSyncBuildScript)
  const stableHandleRunPostSyncBuildScriptNow = useEventCallback(handleRunPostSyncBuildScriptNow)
  const stableHandleRepoBranchChanged = useEventCallback(handleRepoBranchChanged)
  const stableHandleCopyRepoMeta = useEventCallback(handleCopyRepoMeta)
  const normalizedDashboardSearchKeyword = dashboardSearchKeyword.trim().toLowerCase()

  const effectiveRepoStatuses = repoStatuses
  const successfulSyncTimesByRepoId = useMemo(
    () => buildSuccessfulSyncTimesByRepoId(syncHistory),
    [syncHistory]
  )
  const dashboardSyncTimestampsByRepoId = useMemo(
    () => repos.reduce((timestamps, repo) => {
      timestamps[repo.id] = getRepoSyncSortTimestamp(repo, successfulSyncTimesByRepoId)
      return timestamps
    }, {}),
    [repos, successfulSyncTimesByRepoId]
  )

  const statusFilteredDashboardRepos = useMemo(
    () => repos.filter((repo) => matchesDashboardRepoFilter(
      repo,
      effectiveRepoStatuses[repo.id],
      repoQueueStateMap[repo.id],
      repoStatusIssues[repo.id],
      dashboardRepoFilter
    )),
    [repos, effectiveRepoStatuses, repoQueueStateMap, repoStatusIssues, dashboardRepoFilter]
  )
  const sortedDashboardRepos = useMemo(
    () => [...statusFilteredDashboardRepos].sort((a, b) => compareReposByDashboardSortOrder(
      a,
      b,
      dashboardRepoSortMode,
      successfulSyncTimesByRepoId,
      effectiveRepoStatuses
    )),
    [
      statusFilteredDashboardRepos,
      dashboardRepoSortMode,
      successfulSyncTimesByRepoId,
      effectiveRepoStatuses,
    ]
  )
  const filteredDashboardRepos = useMemo(
    () => normalizedDashboardSearchKeyword
      ? sortedDashboardRepos.filter((repo) => getRepoDashboardSearchName(repo).includes(normalizedDashboardSearchKeyword))
      : sortedDashboardRepos,
    [sortedDashboardRepos, normalizedDashboardSearchKeyword]
  )
  const dashboardVisibleRepos = filteredDashboardRepos
  const dashboardVisibleRepoIds = useMemo(
    () => getDashboardVisibleRepoIds(dashboardVisibleRepos),
    [dashboardVisibleRepos]
  )
  const selectedRepoIdSet = useMemo(() => new Set(selectedRepoIds), [selectedRepoIds])
  const globallySelectedRepos = useMemo(
    () => repos.filter((repo) => selectedRepoIdSet.has(repo.id)),
    [repos, selectedRepoIdSet]
  )
  const globalSelectedCount = globallySelectedRepos.length
  const visibleSelectedRepoIds = useMemo(
    () => getVisibleSelectedRepoIds(selectedRepoIds, dashboardVisibleRepoIds),
    [selectedRepoIds, dashboardVisibleRepoIds]
  )
  const visibleSelectedRepoIdSet = useMemo(
    () => new Set(visibleSelectedRepoIds),
    [visibleSelectedRepoIds]
  )
  const visibleSelectedRepos = useMemo(
    () => dashboardVisibleRepos.filter((repo) => visibleSelectedRepoIdSet.has(repo.id)),
    [dashboardVisibleRepos, visibleSelectedRepoIdSet]
  )
  const visibleSelectedCount = visibleSelectedRepos.length
  const hiddenSelectedRepoIds = useMemo(
    () => getHiddenSelectedRepoIds(selectedRepoIds, dashboardVisibleRepoIds, repos),
    [selectedRepoIds, dashboardVisibleRepoIds, repos]
  )
  const hiddenSelectedCount = hiddenSelectedRepoIds.length
  const allSelected = areAllVisibleReposSelected(selectedRepoIds, dashboardVisibleRepoIds)
  const canBatchSync = visibleSelectedRepos.some((repo) => (
    repo.status !== 'paused' && repoQueueStateMap[repo.id] !== SYNC_JOB_STATUS.queued && repoQueueStateMap[repo.id] !== SYNC_JOB_STATUS.running
  ))
  const canBatchPause = visibleSelectedRepos.some((repo) => repo.status !== 'paused')
  const canBatchResume = visibleSelectedRepos.some((repo) => repo.status === 'paused')
  const dashboardSummaryGroup = useMemo(
    () => ({ key: 'summary', repos: filteredDashboardRepos }),
    [filteredDashboardRepos]
  )
  const filteredRepoCount = useMemo(
    () => filteredDashboardRepos.length,
    [filteredDashboardRepos]
  )
  const syncFilteredTargetRepos = useMemo(
    () => dashboardVisibleRepos.filter((repo) => repo.status !== 'paused'),
    [dashboardVisibleRepos]
  )
  const syncFilteredTargetCount = syncFilteredTargetRepos.length

  const handleSyncCurrentFilter = async () => {
    if (isSyncFilteredRunning) return
    const targets = syncFilteredTargetRepos.map((repo) => repo.id)
    if (targets.length === 0) {
      setNoticeData({
        title: '同步当前筛选',
        message: '当前筛选下没有可同步仓库。',
      })
      return
    }

    setSyncFilteredPreparingRepoIds(targets)
    try {
      const {
        enqueuedCount,
        skippedCount,
        blockedCount,
        warningCount,
        delayedByGuardDialog,
      } = await enqueueWithSyncGuards(targets, 'syncFiltered')
      if (delayedByGuardDialog) return
      if (enqueuedCount === 0 && skippedCount > 0) {
        setNoticeData({
          title: '同步当前筛选',
          message: '当前筛选中的目标仓库已在队列或正在同步中。',
        })
        return
      }
      if (skippedCount > 0 || blockedCount > 0 || warningCount > 0) {
        setNoticeData({
          title: '同步当前筛选',
          message: formatSyncQueueNoticeMessage({
            enqueuedCount,
            skippedCount,
            blockedCount,
            warningCount,
            skippedLabel: '已在队列或执行中',
          }),
        })
      }
    } finally {
      setSyncFilteredPreparingRepoIds([])
    }
  }
  const existingGithubRepoKeys = useMemo(() => {
    const keys = new Set()
    for (const repo of repos) {
      const fullName = getGitHubRepoFullNameFromRemote(repo.remote)
      if (fullName) keys.add(fullName)
    }
    return keys
  }, [repos])
  const existingGithubRepoNameKeys = useMemo(() => {
    return getExistingGithubRepoNameFallbackKeys(repos, getGitHubRepoFullNameFromRemote)
  }, [repos])
  const hasDashboardSearchKeyword = normalizedDashboardSearchKeyword.length > 0
  const dashboardEmptyProjection = getDashboardEmptyProjection({
    isAppReady: appReady,
    isLoading: showLoading,
    hasSearchKeyword: hasDashboardSearchKeyword,
    resultCount: filteredDashboardRepos.length,
    filterMode: dashboardRepoFilter,
  })
  const activeCommitHistoryRepo = useMemo(
    () => repos.find((repo) => repo.id === commitHistoryRepoId) || null,
    [repos, commitHistoryRepoId]
  )
  const activeCommitHistoryStatus = activeCommitHistoryRepo
    ? effectiveRepoStatuses[activeCommitHistoryRepo.id]
    : null
  const commitHistoryHeroSnapshot = commitHistoryFlightSnapshotRef.current
  const commitHistoryHeroRepo = commitHistoryHeroSnapshot?.repo || activeCommitHistoryRepo
  const commitHistoryHeroStatus = commitHistoryHeroSnapshot?.status || activeCommitHistoryStatus
  const activeCommitHistoryDefaultBranch = activeCommitHistoryRepo
    ? getCommitHistoryDefaultBranch(activeCommitHistoryRepo, activeCommitHistoryStatus)
    : 'main'
  const activeCommitHistoryBranch = activeCommitHistoryRepo
    ? normalizeCommitHistoryBranchName(
      commitHistoryBranchByRepo[activeCommitHistoryRepo.id] || activeCommitHistoryDefaultBranch
    )
    : ''
  const activeCommitHistoryBranchOverview = (
    activeCommitHistoryRepo
    && commitHistoryBranchOverviewState.repoId === activeCommitHistoryRepo.id
  )
    ? commitHistoryBranchOverviewState.overview
    : null
  const activeCommitHistoryBranchOptions = useMemo(
    () => buildCommitHistoryBranchOptions(
      activeCommitHistoryBranchOverview,
      activeCommitHistoryDefaultBranch,
      activeCommitHistoryBranch
    ),
    [
      activeCommitHistoryBranchOverview,
      activeCommitHistoryDefaultBranch,
      activeCommitHistoryBranch,
    ]
  )
  const activeCommitHistoryBranchLabel = getCommitHistoryBranchDisplayName(
    activeCommitHistoryBranchOptions,
    activeCommitHistoryBranch
  )
  const activeCommitHistoryBranchOption = getCommitHistoryBranchOption(
    activeCommitHistoryBranchOptions,
    activeCommitHistoryBranch
  )
  const activeCommitHistoryLatestCommit = activeCommitHistoryRepo
    ? getRepoLatestCommitDisplay(activeCommitHistoryStatus, activeCommitHistoryRepo)
    : null
  const activeCommitHistoryExpectedHeadHash = String(
    activeCommitHistoryBranchOption?.headHash
      || (activeCommitHistoryBranch === activeCommitHistoryDefaultBranch
        ? activeCommitHistoryLatestCommit?.hash
        : '')
      || ''
  ).trim()
  const activeCommitHistoryExpectedRemoteHeadHash = String(activeCommitHistoryBranchOption?.remoteHeadHash || '').trim()
  const activeCommitHistoryFallbackHeadHash = activeCommitHistoryExpectedHeadHash
  const activeCommitHistoryCacheKey = activeCommitHistoryRepo
    ? buildCommitHistoryCacheKey(activeCommitHistoryRepo, activeCommitHistoryBranch, commitHistoryCount)
    : ''
  const activeCommitHistoryCacheEntry = activeCommitHistoryCacheKey
    ? commitHistoryCache.entries[activeCommitHistoryCacheKey]
    : null
  const isCommitHistoryDrawerOpen = page === 'dashboard' && Boolean(activeCommitHistoryRepo)
  const isCommitHistoryLayoutOpen = isCommitHistoryDrawerOpen && !commitHistoryDrawerClosing
  const isCommitHistoryHeroReturning = commitHistoryDrawerClosing
  const activeCommitHistoryBranchOverviewLoading = Boolean(
    activeCommitHistoryRepo
      && commitHistoryBranchOverviewState.repoId === activeCommitHistoryRepo.id
      && commitHistoryBranchOverviewState.loading
  )
  const activeCommitHistoryBranchOverviewError = (
    activeCommitHistoryRepo
      && commitHistoryBranchOverviewState.repoId === activeCommitHistoryRepo.id
  )
    ? commitHistoryBranchOverviewState.error
    : ''
  // 展开态的判定必须先于浮层形态：浮层形态要用它决定「卡片进不进场」。
  const sidebarVisibleFromPreference = sidebarPreference
    ? sidebarPreference === SIDEBAR_PANEL_PREFERENCE.expanded
    : !toolbarNeedsCollapse
  const sidebarCardRequested = toolbarNeedsCollapse && sidebarVisibleFromPreference
  // 点卡片外部 / Esc：这是一次显式的「我要收起」，所以写进持久偏好。
  const closeSidebarCard = useCallback(() => {
    setSidebarPreference(SIDEBAR_PANEL_PREFERENCE.collapsed)
  }, [])
  // 窄屏展开时侧边栏是浮在仪表盘上的卡片；宽到一列放得下就滑回它原来的栅格列。
  const {
    isFloating: sidebarCardFloating,
    isDocking: sidebarCardDocking,
    isCardVisible: sidebarCardOpen,
    isCardBackdropVisible: sidebarCardBackdropOpen,
  } = useFloatingSidebarCard({
    enabled: toolbarNeedsCollapse,
    isOpen: sidebarCardRequested,
    isDocked: !toolbarNeedsCollapse,
    isCommitHistoryOpen: isCommitHistoryDrawerOpen,
    isSidebarActive: !isCommitHistoryDrawerOpen,
    onRequestClose: closeSidebarCard,
  })
  const sidebarCardMode = sidebarCardFloating || sidebarCardDocking
  // 可见性与栅格列占用都来自 sidebarCardState 的纯函数（宽度与偏好在竞争，单独测）。
  const { visible: sidebarVisible, columnCollapsed: sidebarColumnCollapsed } = resolveSidebarPanelLayout({
    toolbarNeedsCollapse,
    preference: sidebarPreference,
    isCardFloating: sidebarCardFloating,
    isCardDocking: sidebarCardDocking,
  })
  const appLayoutClassName = [
    'app-layout',
    sidebarColumnCollapsed ? 'app-layout--sidebar-collapsed' : '',
    sidebarCardDocking ? 'app-layout--sidebar-docking' : '',
    sidebarCardMode ? 'app-layout--sidebar-card' : '',
    sidebarCardOpen ? 'app-layout--sidebar-card-open' : '',
    sidebarCardDocking ? 'app-layout--sidebar-card-docking' : '',
    isCommitHistoryDrawerOpen ? 'app-layout--commit-history-session' : '',
    isCommitHistoryLayoutOpen ? 'app-layout--commit-history-open' : '',
  ].filter(Boolean).join(' ')

  // 必须放在 sidebarCardMode / sidebarCardDocking 之后：effect 的依赖数组在渲染期
  // 就会求值，提前引用会直接踩中 TDZ。
  useEffect(() => {
    // 卡片形态需要根节点裁剪溢出的部分，否则滑出边缘时会短暂撑出横向滚动条。
    // 回位动画同样在移动这张卡片，也一并裁掉。
    const root = document.documentElement
    root.classList.toggle('sidebar-card-mode', sidebarCardMode || sidebarCardDocking)
    return () => root.classList.remove('sidebar-card-mode')
  }, [sidebarCardMode, sidebarCardDocking])
  const dashboardShellClassName = [
    'dashboard-shell',
    dashboardEmptyProjection.kind === DASHBOARD_EMPTY_PROJECTION_KIND.filter ? 'dashboard-shell--filter-empty' : '',
    isCommitHistoryDrawerOpen ? 'dashboard-shell--commit-history-open' : '',
    commitHistoryDrawerClosing ? 'dashboard-shell--commit-history-closing' : '',
    isCommitHistoryDrawerOpen ? `dashboard-shell--${dashboardLayout}` : '',
  ].filter(Boolean).join(' ')
  const hasUndoToast = toArray(undoRemoveData?.repos).length > 0
  const hasImportLoadingToast = Number(importLoadingData?.totalCount || 0) > 0
  const handleDashboardRepoFilterChange = useCallback((filterMode) => {
    setDashboardRepoFilter(normalizeDashboardRepoFilterMode(filterMode))
  }, [])
  const handleDashboardRepoSortChange = useCallback((sortMode) => {
    const normalizedSortMode = normalizeDashboardRepoSortMode(sortMode)
    if (normalizedSortMode) setDashboardRepoSortMode(normalizedSortMode)
  }, [])
  const closeDashboardSearch = useCallback(() => {
    setIsDashboardSearchOpen(false)
    setDashboardSearchKeyword('')
  }, [])
  const toggleDashboardSearch = useCallback(() => {
    if (isDashboardSearchOpen) {
      closeDashboardSearch()
      return
    }
    setIsDashboardSearchOpen(true)
  }, [closeDashboardSearch, isDashboardSearchOpen])
  const handleNavigatePage = useCallback((nextPage) => {
    const normalizedPage = String(nextPage || '').trim() || 'dashboard'
    setPage(normalizedPage)
  }, [])

  const refreshActiveCommitHistory = useCallback((options = {}) => {
    if (!activeCommitHistoryRepo) return
    void loadCommitHistoryForRepo({
      repo: activeCommitHistoryRepo,
      status: activeCommitHistoryStatus,
      count: commitHistoryCount,
      branch: activeCommitHistoryBranch,
      branchHeadHash: activeCommitHistoryExpectedHeadHash,
      remoteHeadHash: activeCommitHistoryExpectedRemoteHeadHash,
      force: options.force === true,
    })
  }, [
    activeCommitHistoryRepo,
    activeCommitHistoryStatus,
    activeCommitHistoryBranch,
    activeCommitHistoryExpectedHeadHash,
    activeCommitHistoryExpectedRemoteHeadHash,
    commitHistoryCount,
    loadCommitHistoryForRepo,
  ])

  useEffect(() => {
    if (!isCommitHistoryDrawerOpen || !activeCommitHistoryRepo || commitHistoryDrawerClosing) return
    setCommitHistoryBranchByRepo((prev) => (
      prev[activeCommitHistoryRepo.id]
        ? prev
        : { ...prev, [activeCommitHistoryRepo.id]: activeCommitHistoryDefaultBranch }
    ))
    void loadCommitHistoryBranchOverview(activeCommitHistoryRepo, false)
    void loadCommitHistoryForRepo({
      repo: activeCommitHistoryRepo,
      status: activeCommitHistoryStatus,
      count: commitHistoryCount,
      branch: activeCommitHistoryBranch || activeCommitHistoryDefaultBranch,
      branchHeadHash: activeCommitHistoryExpectedHeadHash,
      remoteHeadHash: activeCommitHistoryExpectedRemoteHeadHash,
      force: false,
    })
  }, [
    isCommitHistoryDrawerOpen,
    commitHistoryDrawerClosing,
    activeCommitHistoryRepo,
    activeCommitHistoryStatus,
    activeCommitHistoryCacheKey,
    activeCommitHistoryBranch,
    activeCommitHistoryDefaultBranch,
    activeCommitHistoryExpectedHeadHash,
    activeCommitHistoryExpectedRemoteHeadHash,
    activeCommitHistoryLatestCommit?.hash,
    commitHistoryCount,
    loadCommitHistoryBranchOverview,
    loadCommitHistoryForRepo,
  ])

  useEffect(() => {
    if (page !== 'dashboard' && commitHistoryRepoId) {
      finishCommitHistoryClose(null, COMMIT_HISTORY_FLIGHT_PHASE.aborting)
    }
  }, [page, commitHistoryRepoId, finishCommitHistoryClose])

  useEffect(() => {
    if (commitHistoryRepoId && !activeCommitHistoryRepo) {
      finishCommitHistoryClose(null, COMMIT_HISTORY_FLIGHT_PHASE.aborting)
    }
  }, [commitHistoryRepoId, activeCommitHistoryRepo, finishCommitHistoryClose])

  useEffect(() => {
    if (!isDashboardSearchOpen) return
    const frameId = requestAnimationFrame(() => {
      dashboardSearchInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(frameId)
  }, [isDashboardSearchOpen])

  useEffect(() => {
    if (!isDashboardSearchOpen) return

    const handlePointerDown = (event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (dashboardSearchToggleRef.current?.contains(target)) return
      if (dashboardSearchFiltersRef.current?.contains(target)) return
      if (dashboardToolbarControlsRef.current?.contains(target)) return
      closeDashboardSearch()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isDashboardSearchOpen, closeDashboardSearch])

  return (
    <div className={appLayoutClassName}>
      <Sidebar
        currentPage={page}
        onNavigate={handleNavigatePage}
        stats={stats}
        currentSyncMode={currentSyncMode}
        onSyncAll={handleSyncAll}
        onSyncChangedOnly={handleSyncChangedOnly}
        isSyncAllRunning={isSyncAllRunning}
        isSyncChangedOnlyRunning={isSyncChangedOnlyRunning}
        syncAllButtonLabel={syncAllButtonLabel}
        syncChangedOnlyButtonLabel={syncChangedOnlyButtonLabel}
        onSyncFailedOnly={handleSyncFailedOnly}
        failedRepoCount={failedRepoCount}
        canRevealFailedSync={!hasActiveSyncJobs}
        interactive={!isCommitHistoryDrawerOpen}
        collapsed={!sidebarVisible}
        floating={sidebarCardMode}
        open={sidebarCardOpen}
        docking={sidebarCardDocking}
        onToggle={handleToggleSidebar}
      />
      {sidebarCardBackdropOpen ? (
        <button
          type="button"
          className="sidebar-card-backdrop"
          aria-label="收起侧边栏"
          onClick={closeSidebarCard}
        />
      ) : null}
      <main
        className="main-content"
        aria-hidden={isCommitHistoryDrawerOpen ? 'true' : undefined}
        inert={isCommitHistoryDrawerOpen || undefined}
      >
        {page === 'settings' ? (
          <Settings
            theme={theme}
            onThemeChange={setTheme}
            settings={settings}
            onUpdateSetting={updateSetting}
            onShowNotice={setNoticeData}
            appVersion={appVersion}
            updaterSupported={updaterSupported}
            updatePhase={appUpdateState.phase}
            updateMessage={getAppUpdateSettingsMessage(appUpdateState)}
            onCheckForUpdates={() => void checkForAppUpdates({ manual: true })}
            onInstallUpdate={installAppUpdate}
            githubAccount={githubAccount}
            onGithubLogin={handleGithubLogin}
            onGithubLogout={handleGithubLogout}
            onCopyDiagnostics={handleCopyDiagnosticBundle}
          />
        ) : page === 'history' ? (
          <SyncHistoryCenter
            entries={syncHistory}
            onClear={handleClearSyncHistory}
            totalReposCount={repos.length}
          />
        ) : !appReady ? (
          showLoading ? <DashboardLoadingState /> : null
        ) : (
          <div className={dashboardShellClassName}>
            <div className="dashboard-shell__main">
              <div className="dashboard__header">
              <div className="dashboard__header-actions" ref={dashboardToolbarRowRef}>
                {sidebarVisible ? null : (
                  <button
                    type="button"
                    className="dashboard-toolbar__sidebar-toggle"
                    onClick={handleToggleSidebar}
                    aria-label="展开侧边栏"
                    aria-expanded={false}
                    aria-controls="app-sidebar"
                    data-app-tooltip="展开侧边栏"
                  >
                    <Icons.sidebarPanel className="icon icon--sm" />
                  </button>
                )}
                <div className="dashboard-toolbar__controls" ref={dashboardToolbarControlsRef}>
                  <div className="dashboard-toolbar__field">
                    <span className="dashboard-toolbar__label">筛选</span>
                    <SharedCustomSelect
                      value={dashboardRepoFilter}
                      options={DASHBOARD_REPO_FILTER_OPTIONS}
                      onChange={handleDashboardRepoFilterChange}
                      ariaLabel="筛选仓库状态"
                      className="dashboard-toolbar__select dashboard-toolbar__filter-select"
                    />
                    <button
                      className="dashboard-toolbar__filter-sync-btn"
                      onClick={handleSyncCurrentFilter}
                      disabled={isSyncFilteredRunning || removingRepo || batchMode || syncFilteredTargetCount === 0}
                      aria-label="同步当前筛选"
                      data-app-tooltip={`同步当前筛选/搜索结果（${syncFilteredTargetCount} 个仓库）`}
                    >
                      {isSyncFilteredRunning
                        ? <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
                        : <Icons.sync className="icon icon--sm" />}
                    </button>
                  </div>
                  <div className="dashboard-toolbar__field">
                    <span className="dashboard-toolbar__label">排序</span>
                    <SharedCustomSelect
                      value={dashboardRepoSortMode}
                      options={DASHBOARD_REPO_SORT_OPTIONS}
                      onChange={handleDashboardRepoSortChange}
                      ariaLabel="仓库排序方式"
                      className="dashboard-toolbar__select dashboard-toolbar__sort-select"
                    />
                  </div>
                </div>
                <div className="dashboard-toolbar__actions">
                  <div className="layout-switcher" role="group" aria-label="布局样式切换">
                    <button
                      className={`layout-switcher__btn ${dashboardLayout === 'list' ? 'layout-switcher__btn--active' : ''}`}
                      onClick={() => setDashboardLayout('list')}
                      data-app-tooltip="列表布局"
                      aria-label="列表布局"
                    >
                      <Icons.listLayout className="icon icon--sm" />
                    </button>
                    <button
                      className={`layout-switcher__btn ${dashboardLayout === 'masonry' ? 'layout-switcher__btn--active' : ''}`}
                      onClick={() => setDashboardLayout('masonry')}
                      data-app-tooltip="卡片布局"
                      aria-label="卡片布局"
                    >
                      <Icons.masonryLayout className="icon icon--sm" />
                    </button>
                  </div>
                  <button
                    ref={dashboardSearchToggleRef}
                    className={`dashboard__batch-btn ${isDashboardSearchOpen ? 'dashboard__batch-btn--active' : ''}`}
                    onClick={toggleDashboardSearch}
                    data-app-tooltip={isDashboardSearchOpen ? '收起搜索' : '搜索仓库'}
                    aria-label={isDashboardSearchOpen ? '收起搜索' : '搜索仓库'}
                    aria-expanded={isDashboardSearchOpen}
                  >
                    <Icons.search className="icon icon--sm" />
                  </button>
                  <button
                    className="dashboard__batch-btn"
                    onClick={handleFetchAllRemotes}
                    disabled={isFetchingRemote || removingRepo || batchMode || repos.length === 0}
                    data-app-tooltip={isFetchingRemote ? '正在获取所有仓库的远程最新状态' : '获取所有仓库的远程最新状态'}
                    aria-label={isFetchingRemote ? '正在获取更新' : '获取更新'}
                  >
                    {isFetchingRemote ? (
                      <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
                    ) : (
                      <Icons.sync className="icon icon--sm" />
                    )}
                  </button>
                  <button
                    className={`dashboard__batch-btn ${batchMode ? 'dashboard__batch-btn--active' : ''}`}
                    onClick={batchMode ? exitBatchMode : enterBatchMode}
                    disabled={isBatchRunning || removingRepo || repos.length === 0}
                    data-app-tooltip={batchMode ? '退出批量操作' : '批量操作'}
                    aria-label={batchMode ? '退出批量操作' : '批量操作'}
                    aria-pressed={batchMode}
                  >
                    <Icons.batch className="icon icon--sm" />
                  </button>
                  <button
                    className="dashboard__add-btn"
                    onClick={openImportEntryMenu}
                    disabled={isRepoImportBusy}
                    data-app-tooltip={isRepoImportBusy ? (isCloningRepo ? '正在克隆仓库' : '正在导入仓库') : '导入仓库'}
                    aria-label={isRepoImportBusy ? (isCloningRepo ? '正在克隆仓库' : '正在导入仓库') : '导入仓库'}
                    aria-haspopup="menu"
                    aria-expanded={Boolean(importMenuAnchor)}
                  >
                    {isRepoImportBusy ? (
                      <span className="spinning"><Icons.sync className="icon icon--sm" /></span>
                    ) : (
                      <Icons.plus className="icon icon--sm" />
                    )}
                  </button>
                </div>
              </div>
              </div>
              {isDashboardSearchOpen ? (
              <div className="dashboard__filters" ref={dashboardSearchFiltersRef}>
                <input
                  ref={dashboardSearchInputRef}
                  className="dashboard__search"
                  type="text"
                  placeholder="搜索仓库名"
                  value={dashboardSearchKeyword}
                  onChange={(event) => setDashboardSearchKeyword(event.target.value)}
                  aria-label="搜索仓库"
                />
                {hasDashboardSearchKeyword ? (
                  <button
                    className="dashboard__search-clear"
                    onClick={() => setDashboardSearchKeyword('')}
                    aria-label="清空仓库搜索"
                  >
                    清空
                  </button>
                ) : null}
                <span className="dashboard__search-meta">
                  {hasDashboardSearchKeyword
                    ? `匹配 ${filteredRepoCount}/${statusFilteredDashboardRepos.length}`
                    : `共 ${statusFilteredDashboardRepos.length} 个仓库`}
                </span>
              </div>
              ) : null}
              {batchMode ? (
              <div className="batch-toolbar">
                <div className="batch-toolbar__left">
                  <button className="batch-toggle-btn" onClick={toggleSelectAllRepos}>
                    {allSelected ? '取消当前全选' : '全选当前可见'}
                  </button>
                  <span className="batch-toolbar__count">已选 {globalSelectedCount} 个</span>
                  <span className="batch-toolbar__scope">
                    当前可见 {dashboardVisibleRepos.length} 个，已选 {visibleSelectedCount} 个
                  </span>
                  {hiddenSelectedCount > 0 ? (
                    <span className="batch-toolbar__scope">
                      筛选/搜索隐藏 {hiddenSelectedCount} 个
                    </span>
                  ) : null}
                  <span className="batch-toolbar__scope-note">
                    批量操作仅作用于当前可见已选仓库
                  </span>
                  {globalSelectedCount > 0 ? (
                    <button className="batch-clear-btn" onClick={clearSelectedRepos}>清空所有选择</button>
                  ) : null}
                </div>
                <div className="batch-toolbar__actions">
                  <button
                    className="batch-action-btn batch-action-btn--sync"
                    onClick={handleBatchSync}
                    disabled={visibleSelectedCount === 0 || !canBatchSync || isBatchRunning || isBatchSyncing}
                  >
                    {isBatchSyncing ? '排队中...' : '批量同步'}
                  </button>
                  <button
                    className="batch-action-btn"
                    onClick={handleBatchPause}
                    disabled={visibleSelectedCount === 0 || !canBatchPause || isBatchRunning}
                  >
                    {batchAction === 'pause' ? '处理中...' : '批量暂停'}
                  </button>
                  <button
                    className="batch-action-btn"
                    onClick={handleBatchResume}
                    disabled={visibleSelectedCount === 0 || !canBatchResume || isBatchRunning}
                  >
                    {batchAction === 'resume' ? '处理中...' : '批量恢复'}
                  </button>
                  <button
                    className="batch-action-btn batch-action-btn--danger"
                    onClick={handleRequestBatchRemove}
                    disabled={visibleSelectedCount === 0 || isBatchRunning || removingRepo}
                  >
                    批量移除
                  </button>
                </div>
              </div>
              ) : null}

              <div className="dashboard-repo-summary" ref={repoGridRef}>
              {dashboardEmptyProjection.kind !== DASHBOARD_EMPTY_PROJECTION_KIND.none ? (
                dashboardEmptyProjection.kind === DASHBOARD_EMPTY_PROJECTION_KIND.search ? (
                    <div className="dashboard__search-empty">
                      未找到匹配仓库，请尝试其他关键词。
                    </div>
                ) : (
                    <DashboardFilterEmptyState
                      filterMode={dashboardEmptyProjection.filterMode}
                      resolvedTheme={resolvedTheme}
                    />
                )
              ) : (
                  <section className="dashboard-group dashboard-group--summary" aria-label="仓库汇总">
                    <MemoizedDashboardGroupEntries
                      group={dashboardSummaryGroup}
                      isCollapsed={false}
                      dashboardLayout={dashboardLayout}
                      repoGridColumns={repoGridColumns}
                      dashboardRepoSortMode={dashboardRepoSortMode}
                      syncTimestampsByRepoId={dashboardSyncTimestampsByRepoId}
                      effectiveRepoStatuses={effectiveRepoStatuses}
                      repoStatusIssues={repoStatusIssues}
                      statusIssueNowTick={statusIssueNowTick}
                      repoQueueStateMap={repoQueueStateMap}
                      syncCheckingRepoIdSet={syncCheckingRepoIdSet}
                      remoteRefreshingRepoIdSet={remoteRefreshingRepoIdSet}
                      isFocusRefreshingAll={isFocusRefreshingAll}
                      missingRepoStates={missingRepoStates}
                      postSyncBuildStates={postSyncBuildStates}
                      latestRetryableJobMap={latestRetryableJobMap}
                      batchMode={batchMode}
                      selectedRepoIdSet={selectedRepoIdSet}
                      onToggleSelect={stableToggleRepoSelection}
                      onSync={stableHandleSync}
                      onCancelSync={stableHandleCancelSync}
                      onRetrySync={stableHandleRetrySync}
                      onPause={stableHandlePause}
                      onResume={stableHandleResume}
                      onOpenDirectory={stableHandleOpenDirectory}
                      onOpenWithApp={stableHandleOpenWithApp}
                      onOpenWithTerminal={stableHandleOpenWithTerminal}
                      onOpenGitHubRepo={stableHandleOpenGitHubRepo}
                      onViewCommitHistory={stableHandleViewCommitHistory}
                      openWithAppText={openWithAppText}
                      openWithTerminalText={openWithTerminalText}
                      onRequestRemove={stableHandleRequestRemove}
                      onViewErrors={stableHandleViewErrors}
                      onTogglePostSyncBuild={stableHandleTogglePostSyncBuild}
                      onSelectPostSyncBuildScript={stableHandleSelectPostSyncBuildScript}
                      onClearPostSyncBuildScript={stableHandleClearPostSyncBuildScript}
                      onRunPostSyncBuildScriptNow={stableHandleRunPostSyncBuildScriptNow}
                      onBranchChanged={stableHandleRepoBranchChanged}
                      repoBranchOverviews={repoBranchOverviews}
                      onBranchOverviewChanged={handleRepoBranchOverviewChanged}
                      dismissedBranchAttentionKeys={dismissedBranchAttentionKeys}
                      onDismissBranchAttention={handleDismissBranchAttention}
                      onBranchOperationFeedback={handleBranchOperationFeedback}
                      onCopyRepoMeta={stableHandleCopyRepoMeta}
                      activeCommitHistoryRepoId={commitHistoryRepoId}
                      commitHistoryHandoffRepoId={commitHistoryHandoffRepoId}
                      commitHistoryHandoffHeight={commitHistoryHandoffHeight}
                      commitHistoryHandoffSourceHeight={commitHistoryHandoffSourceHeight}
                      commitHistoryOverlayActive={isCommitHistoryDrawerOpen}
                      commitHistoryClosing={commitHistoryDrawerClosing}
                    />
                  </section>
              )}
              </div>
            </div>
          </div>
        )}
      </main>

      {isCommitHistoryDrawerOpen ? (
        <>
          <button
            className={`commit-history-backdrop ${commitHistoryDrawerClosing ? 'commit-history-backdrop--closing' : ''}`}
            onClick={handleCloseCommitHistory}
            aria-label="关闭提交历史"
            type="button"
          />
          <div className={[
            'commit-history-stage',
            commitHistoryDrawerClosing ? 'commit-history-stage--closing' : '',
            !commitHistoryDrawerClosing && !commitHistoryHeroReady ? 'commit-history-stage--opening' : '',
          ].filter(Boolean).join(' ')}>
            <div className="commit-history-stage__context">
              <CommitHistoryHeroCard
                key={`commit-history-hero-${commitHistoryHeroRepo.id}`}
                repoId={commitHistoryHeroRepo.id}
                heroStartRect={commitHistoryHeroStartRect}
                closing={commitHistoryDrawerClosing}
                layoutSignature={isCommitHistoryHeroReturning ? 'returning' : 'history'}
                onReturnComplete={finishCommitHistoryClose}
                onFlightAbort={handleCommitHistoryFlightAbort}
                onFlightStart={handleCommitHistoryFlightStart}
                onFlightReady={handleCommitHistoryFlightReady}
              >
                <MemoizedRepoCard
                  repo={commitHistoryHeroRepo}
                  dashboardSortMode={dashboardRepoSortMode}
                  syncTimestamp={dashboardSyncTimestampsByRepoId[commitHistoryHeroRepo.id] || 0}
                  status={commitHistoryHeroStatus}
                  statusIssue={commitHistoryHeroSnapshot?.statusIssue ?? repoStatusIssues[commitHistoryHeroRepo.id]}
                  statusIssueNow={commitHistoryHeroSnapshot?.statusIssueNow ?? statusIssueNowTick}
                  queueState={commitHistoryHeroSnapshot?.queueState ?? repoQueueStateMap[commitHistoryHeroRepo.id]}
                  isSyncChecking={commitHistoryHeroSnapshot?.isSyncChecking ?? syncCheckingRepoIdSet.has(commitHistoryHeroRepo.id)}
                  isRemoteRefreshing={commitHistoryHeroSnapshot?.isRemoteRefreshing ?? remoteRefreshingRepoIdSet.has(commitHistoryHeroRepo.id)}
                  isFocusRefreshing={commitHistoryHeroSnapshot?.isFocusRefreshing ?? isFocusRefreshingAll}
                  isPathMissing={commitHistoryHeroSnapshot?.isPathMissing ?? Boolean(missingRepoStates[commitHistoryHeroRepo.id])}
                  pathMissingMessage={commitHistoryHeroSnapshot?.pathMissingMessage ?? missingRepoStates[commitHistoryHeroRepo.id]?.message ?? ''}
                  postSyncBuildState={commitHistoryHeroSnapshot?.postSyncBuildState ?? postSyncBuildStates[commitHistoryHeroRepo.id]}
                  canRetrySync={commitHistoryHeroSnapshot?.canRetrySync ?? (Boolean(latestRetryableJobMap[commitHistoryHeroRepo.id]) && !repoQueueStateMap[commitHistoryHeroRepo.id])}
                  batchMode={false}
                  selected={false}
                  onToggleSelect={noop}
                  onSync={stableHandleSync}
                  onCancelSync={stableHandleCancelSync}
                  onRetrySync={stableHandleRetrySync}
                  onPause={stableHandlePause}
                  onResume={stableHandleResume}
                  onOpenDirectory={stableHandleOpenDirectory}
                  onOpenWithApp={stableHandleOpenWithApp}
                  onOpenWithTerminal={stableHandleOpenWithTerminal}
                  onOpenGitHubRepo={stableHandleOpenGitHubRepo}
                  onViewCommitHistory={stableHandleViewCommitHistory}
                  openWithAppText={openWithAppText}
                  openWithTerminalText={openWithTerminalText}
                  onRequestRemove={stableHandleRequestRemove}
                  onViewErrors={stableHandleViewErrors}
                  onTogglePostSyncBuild={stableHandleTogglePostSyncBuild}
                  onSelectPostSyncBuildScript={stableHandleSelectPostSyncBuildScript}
                  onClearPostSyncBuildScript={stableHandleClearPostSyncBuildScript}
                  onRunPostSyncBuildScriptNow={stableHandleRunPostSyncBuildScriptNow}
                  onBranchChanged={stableHandleRepoBranchChanged}
                  branchOverviewSnapshot={commitHistoryHeroSnapshot?.branchOverviewSnapshot ?? repoBranchOverviews[commitHistoryHeroRepo.id] ?? null}
                  onBranchOverviewChanged={handleRepoBranchOverviewChanged}
                  dismissedBranchAttentionKey={commitHistoryHeroSnapshot?.dismissedBranchAttentionKey ?? dismissedBranchAttentionKeys[commitHistoryHeroRepo.id] ?? ''}
                  onDismissBranchAttention={handleDismissBranchAttention}
                  onBranchOperationFeedback={handleBranchOperationFeedback}
                  onCopyRepoMeta={stableHandleCopyRepoMeta}
                  commitHistoryOpen={false}
                  commitHistoryOverlayActive={isCommitHistoryDrawerOpen}
                  commitHistoryClosing={commitHistoryDrawerClosing}
                  commitHistoryFlight
                  historyToolbar={!isCommitHistoryHeroReturning ? (
                    <CommitHistoryToolbar
                      cacheEntry={activeCommitHistoryCacheEntry}
                      count={commitHistoryCount}
                      loadState={commitHistoryLoadState}
                      storeReady={commitHistoryStoreReady}
                      fallbackHeadHash={activeCommitHistoryFallbackHeadHash}
                      selectedBranchRef={activeCommitHistoryBranch}
                      selectedBranchLabel={activeCommitHistoryBranchLabel}
                      branchOptions={activeCommitHistoryBranchOptions}
                      branchOverviewLoading={activeCommitHistoryBranchOverviewLoading}
                      branchOverviewError={activeCommitHistoryBranchOverviewError}
                      embedded
                      interactive={commitHistoryHeroReady}
                      onRefresh={refreshActiveCommitHistory}
                      onCountChange={handleCommitHistoryCountChange}
                      onBranchChange={handleCommitHistoryBranchChange}
                    />
                  ) : null}
                />
              </CommitHistoryHeroCard>
            </div>

            <CommitHistoryDrawer
              repo={commitHistoryHeroRepo}
              status={commitHistoryHeroStatus}
              branchName={activeCommitHistoryBranch}
              cacheEntry={activeCommitHistoryCacheEntry}
              loadState={commitHistoryLoadState}
              closing={commitHistoryDrawerClosing}
              interactive={commitHistoryHeroReady && !commitHistoryDrawerClosing}
              onClose={handleCloseCommitHistory}
              onRefresh={refreshActiveCommitHistory}
              onCopyHash={handleCopyCommitHash}
              onCopyBranchName={(branch) => stableHandleCopyRepoMeta('branch', branch)}
            />
          </div>
        </>
      ) : null}

      <ImportEntryMenu
        Icons={Icons}
        anchor={importMenuAnchor}
        disabled={isRepoImportBusy}
        githubAccount={githubAccount}
        onClose={closeImportEntryMenu}
        onImportLocal={handleSelectImportLocal}
        onCloneRepo={handleSelectCloneRepo}
        onGithubRepos={handleSelectGithubRepos}
      />

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.cloneRepo} present={cloneDialogOpen} onEscape={() => { if (!isCloningRepo) setCloneDialogOpen(false) }}>
        {cloneDialogOpen ? (
          <CloneRepoDialog
            Icons={Icons}
            getErrorMessage={getErrorMessage}
            initialLocalPath={lastCloneParentPath}
            cloning={isCloningRepo}
            onCancel={() => { if (!isCloningRepo) setCloneDialogOpen(false) }}
            onConfirm={handleCloneRepo}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.githubRepoBrowser} present={githubRepoBrowserOpen} onEscape={() => setGithubRepoBrowserOpen(false)}>
        {githubRepoBrowserOpen ? (
          <GithubRepoBrowserDialog
            Icons={Icons}
            getErrorMessage={getErrorMessage}
            existingRepoKeys={existingGithubRepoKeys}
            existingRepoNameKeys={existingGithubRepoNameKeys}
            initialHideExisting={settings.hideExistingGithubReposByDefault}
            initialLocalPath={lastCloneParentPath}
            busy={isRepoImportBusy}
            onClose={() => setGithubRepoBrowserOpen(false)}
            onCloneRepo={handleCloneGithubRepo}
            onCancelCloneRepo={handleCancelGithubClone}
            onBatchCloneComplete={handleGithubBatchCloneComplete}
            onAuthExpired={() => {
              setGithubAccount(null)
            }}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.deviceAuth} present={deviceAuthDialogOpen} onEscape={() => {
        pendingGithubRepoBrowserOpenRef.current = false
        setDeviceAuthDialogOpen(false)
      }}>
        {deviceAuthDialogOpen ? (
          <DeviceAuthDialog
            Icons={Icons}
            onAccountUpdate={(account) => {
              setGithubAccount(account)
              setDeviceAuthDialogOpen(false)
              if (pendingGithubRepoBrowserOpenRef.current) {
                pendingGithubRepoBrowserOpenRef.current = false
                setGithubRepoBrowserOpen(true)
              }
            }}
            onClose={() => {
              pendingGithubRepoBrowserOpenRef.current = false
              setDeviceAuthDialogOpen(false)
            }}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.conflict} present={Boolean(conflictData)} onEscape={() => setConflictData(null)}>
        {conflictData ? (
          <ConflictDialog
            conflict={conflictData}
            onClose={() => setConflictData(null)}
            onRefresh={fetchRepos}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.errorLog} present={Boolean(errorLogData)} onEscape={() => setErrorLogData(null)}>
        {errorLogData ? (
          <ErrorLogDialog
            data={errorLogData}
            onClose={() => setErrorLogData(null)}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.removeRepo} present={Boolean(deleteConfirmData)} onEscape={() => { if (!removingRepo) setDeleteConfirmData(null) }}>
        {deleteConfirmData ? (
          <DeleteConfirmDialog
            repos={deleteConfirmData.repos}
            removing={removingRepo}
            onCancel={() => { if (!removingRepo) setDeleteConfirmData(null) }}
            onConfirm={handleConfirmRemove}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.importResult} present={Boolean(importResultData)} onEscape={() => setImportResultData(null)}>
        {importResultData ? (
          <ImportResultDialog
            data={importResultData}
            onClose={() => setImportResultData(null)}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.syncGuard} present={Boolean(syncGuardDialogData)} onEscape={closeSyncGuardDialog}>
        {syncGuardDialogData ? (
          <SyncGuardDialog
            data={syncGuardDialogData}
            onCancel={closeSyncGuardDialog}
            onConfirm={confirmSyncGuardDialog}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.scriptLog} present={scriptLogDialogOpen} onEscape={() => setScriptLogDialogOpen(false)}>
        {scriptLogDialogOpen ? (
          <ScriptLogDialog
            sessions={scriptLogSessions}
            activeSessionId={activeScriptLogSessionId}
            onSelectSession={setActiveScriptLogSessionId}
            onClose={() => setScriptLogDialogOpen(false)}
            onClear={clearScriptLogSessions}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal level={OVERLAY_LEVEL.dialog} overlayId={OVERLAY_ID.notice} present={Boolean(noticeData)} onEscape={() => setNoticeData(null)}>
        {noticeData ? (
          <NoticeDialog
            title={noticeData.title}
            message={noticeData.message}
            onClose={() => setNoticeData(null)}
          />
        ) : null}
      </OverlayPortal>

      <OverlayPortal
        level={OVERLAY_LEVEL.dialog}
        overlayId={OVERLAY_ID.appUpdate}
        present={!appUpdateState.dismissed && ['ready', 'preparing', 'installing', 'restartRequired', 'relaunching'].includes(appUpdateState.phase)}
        onEscape={() => appUpdateControllerRef.current?.dismiss()}
      >
        {!appUpdateState.dismissed && ['ready', 'preparing', 'installing', 'restartRequired', 'relaunching'].includes(appUpdateState.phase) ? (
          <AppUpdateDialog
            version={appUpdateState.version}
            notes={appUpdateState.notes}
            status={appUpdateState.phase}
            downloadedBytes={appUpdateState.downloadedBytes}
            contentLength={appUpdateState.contentLength}
            error={appUpdateState.error}
            onDismiss={() => appUpdateControllerRef.current?.dismiss()}
            onInstall={installAppUpdate}
          />
        ) : null}
      </OverlayPortal>

      <StatusToast
        data={statusToastData}
        stacked={hasImportLoadingToast}
        withUndo={hasUndoToast}
        onDismiss={() => setStatusToastData(null)}
      />

      <ImportLoadingToast
        data={importLoadingData}
        hasUndoToast={hasUndoToast}
      />

      <RemoveUndoToast
        data={undoRemoveData}
        restoring={restoringRemovedRepos}
        onUndo={handleUndoRemove}
        onDismiss={() => {
          if (!restoringRemovedRepos) setUndoRemoveData(null)
        }}
      />
    </div>
  )
}

export default App
