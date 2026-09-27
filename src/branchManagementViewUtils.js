export const BRANCH_MANAGEMENT_VIEW_MODE = Object.freeze({
  branches: 'branches',
  refs: 'refs',
})

function asText(value) {
  return String(value ?? '').trim()
}

function isRemote(row) {
  return Boolean(row?.isRemote ?? row?.isRemoteRow ?? row?.isRemoteOnly)
}

function isLocal(row) {
  if (!row) return false
  if (typeof row.isLocal === 'boolean') return row.isLocal
  return !isRemote(row)
}

export function normalizeBranchManagementViewMode(value) {
  return value === BRANCH_MANAGEMENT_VIEW_MODE.refs
    ? BRANCH_MANAGEMENT_VIEW_MODE.refs
    : BRANCH_MANAGEMENT_VIEW_MODE.branches
}

export function getPairedRemoteRefNames(rows) {
  const list = Array.isArray(rows) ? rows : []
  return new Set(
    list
      .filter(isLocal)
      .map((row) => asText(row.upstream || row.remoteRef))
      .filter(Boolean)
  )
}

export function isPairedRemoteRefRow(row, pairedRemoteRefs) {
  if (!isRemote(row)) return false
  const paired = pairedRemoteRefs instanceof Set ? pairedRemoteRefs : new Set()
  const rowName = asText(row.rowName)
  const upstream = asText(row.upstream || row.remoteRef)
  return Boolean((rowName && paired.has(rowName)) || (upstream && paired.has(upstream)))
}

export function getBranchManagementVisibleRows(rows, mode = BRANCH_MANAGEMENT_VIEW_MODE.branches) {
  const list = Array.isArray(rows) ? rows : []
  if (normalizeBranchManagementViewMode(mode) === BRANCH_MANAGEMENT_VIEW_MODE.refs) return list
  const pairedRemoteRefs = getPairedRemoteRefNames(list)
  return list.filter((row) => !isPairedRemoteRefRow(row, pairedRemoteRefs))
}

export function getBranchManagementViewSummary(rows, mode = BRANCH_MANAGEMENT_VIEW_MODE.branches) {
  const normalizedMode = normalizeBranchManagementViewMode(mode)
  const allRows = Array.isArray(rows) ? rows : []
  const visibleRows = getBranchManagementVisibleRows(allRows, normalizedMode)
  const localCount = visibleRows.filter(isLocal).length
  const remoteCount = visibleRows.filter(isRemote).length
  const syncCount = visibleRows.filter((row) => row.canSync).length
  const defaultCount = visibleRows.filter((row) => row.isDefault).length

  return normalizedMode === BRANCH_MANAGEMENT_VIEW_MODE.refs
    ? [
      ['引用', visibleRows.length],
      ['本地', localCount],
      ['远端引用', remoteCount],
      ['可同步', syncCount],
      ['默认引用', defaultCount],
    ]
    : [
      ['分支', visibleRows.length],
      ['本地', localCount],
      ['仅远端', remoteCount],
      ['可同步', syncCount],
      ['默认分支', defaultCount],
    ]
}
