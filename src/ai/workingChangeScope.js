import { buildWorkingChangeTargets, stagingEntryIdentity } from '../stagingViewModel.js'

const WORKING_CHANGES_CONTEXT_KEY = '__gitsyncWorkingChangesContext'
const WORKING_CHANGES_SUMMARY_KEY = '__gitsyncWorkingChangesSummaryByPath'

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asPath(value) {
  return typeof value === 'string' ? value : ''
}

function readVisibleFileRows(root = document) {
  if (!root?.querySelectorAll) return []
  return Array.from(root.querySelectorAll('.working-changes-file-row')).map((row) => {
    const checkbox = row.querySelector('.working-changes-checkbox input[type="checkbox"]')
    return {
      path: asPath(row.getAttribute('data-file-path')),
      fileId: asText(checkbox?.getAttribute('data-file-id')),
      checked: checkbox?.checked === true,
    }
  }).filter((file) => file.path)
}

function readCachedWorkingSummary() {
  if (typeof window === 'undefined') return null
  const repoPath = asText(window[WORKING_CHANGES_CONTEXT_KEY]?.repoPath)
  if (!repoPath) return null
  return window[WORKING_CHANGES_SUMMARY_KEY]?.[repoPath] || null
}

export function cacheWorkingSummary(repoPath, summary) {
  if (typeof window === 'undefined' || !repoPath || !summary) return
  if (!window[WORKING_CHANGES_SUMMARY_KEY]) window[WORKING_CHANGES_SUMMARY_KEY] = {}
  window[WORKING_CHANGES_SUMMARY_KEY][repoPath] = summary
}

function pushBucket(map, key, value) {
  const bucket = map.get(key) || []
  bucket.push(value)
  map.set(key, bucket)
}

function buildSummaryIndex(files) {
  const items = (Array.isArray(files) ? files : []).map((file) => ({
    file,
    target: buildWorkingChangeTargets([file])[0] || null,
  }))
  const byIdentity = new Map()
  const byPath = new Map()
  items.forEach((item) => {
    if (!item.target?.path) return
    pushBucket(byIdentity, stagingEntryIdentity(item.file), item)
    pushBucket(byPath, item.target.path, item)
  })
  return { items, byIdentity, byPath }
}

function resolveVisibleRow(row, index) {
  if (row.fileId) {
    const matches = index.byIdentity.get(row.fileId) || []
    return matches.length === 1 ? matches[0] : null
  }
  const matches = index.byPath.get(row.path) || []
  return matches.length === 1 ? matches[0] : null
}

function isCompleteTarget(target) {
  return Boolean(
    target?.path
    && typeof target.expectedIndexCode === 'string'
    && target.expectedIndexCode.length === 1
    && typeof target.expectedWorktreeCode === 'string'
    && target.expectedWorktreeCode.length === 1
    && typeof target.expectedIsUntracked === 'boolean'
    && target.expectedAuthorityId
  )
}

export function readWorkingChangeScope(root = document, { selectedOnly = false } = {}) {
  const visibleRows = readVisibleFileRows(root)
  const selectedRows = visibleRows.filter((file) => file.checked)
  const summary = readCachedWorkingSummary()
  const summaryFiles = Array.isArray(summary?.files) ? summary.files : []
  const summaryIndex = buildSummaryIndex(summaryFiles)
  const totalCount = summaryFiles.length > 0 ? summaryFiles.length : visibleRows.length
  const hasSelectedRows = selectedRows.length > 0
  const noSelectionRequested = selectedOnly && !hasSelectedRows

  let scopedItems = []
  let complete = true
  if (noSelectionRequested) {
    scopedItems = []
  } else if (hasSelectedRows) {
    scopedItems = selectedRows.map((row) => resolveVisibleRow(row, summaryIndex))
    complete = scopedItems.every(Boolean)
    if (!complete) scopedItems = []
  } else if (summaryFiles.length > 0) {
    scopedItems = summaryIndex.items
  } else if (visibleRows.length > 0) {
    complete = false
  }

  const targets = scopedItems.map((item) => item?.target).filter(Boolean)
  complete = complete
    && targets.length === scopedItems.length
    && targets.every(isCompleteTarget)

  return {
    scopeKind: selectedOnly || hasSelectedRows ? 'selected' : 'all',
    scopeLabel: selectedOnly || hasSelectedRows ? '已勾选文件' : '全部未提交文件',
    selectedCount: selectedRows.length,
    totalCount,
    complete,
    targets: complete ? targets : [],
  }
}

export function readSelectedWorkingChangeScope(root = document) {
  return readWorkingChangeScope(root, { selectedOnly: true })
}
