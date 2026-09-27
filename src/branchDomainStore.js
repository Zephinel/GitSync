const dataListeners = new Set()
const snapshotListeners = new Set()
const branchReadInvalidationListeners = new Set()
const operationListeners = new Set()
const overviewPathByObject = new WeakMap()
const overviewProxyObjects = new WeakSet()
const statusPathByObject = new WeakMap()
const latestOverviewByPath = new Map()
const latestStatusByPath = new Map()
const overviewFingerprintByPath = new Map()
const statusFingerprintByPath = new Map()
const branchReadGenerationByPath = new Map()
const operationByPath = new Map()
const dataChangeLog = []
const snapshotChangeLog = []
const CHANGE_LOG_LIMIT = 200
let dataRevision = 0
let snapshotRevision = 0
let operationRevision = 0
let operationSequence = 0
let latestDataChange = Object.freeze({ revision: 0, repoPath: '' })

export function normalizeBranchRepoPath(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized)
    ? `${normalized.slice(0, 1).toLowerCase()}${normalized.slice(1)}`
    : normalized
}

function appendBoundedChange(log, change) {
  log.push(change)
  if (log.length > CHANGE_LOG_LIMIT) log.splice(0, log.length - CHANGE_LOG_LIMIT)
}

function createFingerprint(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

function publishData(repoPath = '') {
  dataRevision += 1
  latestDataChange = Object.freeze({ revision: dataRevision, repoPath: normalizeBranchRepoPath(repoPath) })
  appendBoundedChange(dataChangeLog, latestDataChange)
  dataListeners.forEach((listener) => listener())
}

function publishSnapshotChange(repoPath, surface) {
  snapshotRevision += 1
  appendBoundedChange(snapshotChangeLog, Object.freeze({
    revision: snapshotRevision,
    repoPath: normalizeBranchRepoPath(repoPath),
    surface: String(surface || ''),
  }))
  snapshotListeners.forEach((listener) => listener())
}

function publishOperations() {
  operationRevision += 1
  operationListeners.forEach((listener) => listener())
}

function createReadThroughProxy(repoPath, getLatest, pathByObject, proxyObjects = null) {
  const proxy = new Proxy({}, {
    get(_target, property) { return getLatest(repoPath)?.[property] },
    has(_target, property) {
      const latest = getLatest(repoPath)
      return Boolean(latest && property in latest)
    },
    ownKeys() { return Reflect.ownKeys(getLatest(repoPath) || {}) },
    getOwnPropertyDescriptor(_target, property) {
      const latest = getLatest(repoPath)
      if (!latest || !(property in latest)) return undefined
      return { configurable: true, enumerable: true, writable: false, value: latest[property] }
    },
    set() { return false },
  })
  pathByObject.set(proxy, repoPath)
  proxyObjects?.add(proxy)
  return proxy
}

function getLatestOverviewObject(repoPath) { return latestOverviewByPath.get(repoPath) || null }
function createOverviewProxy(repoPath) {
  return createReadThroughProxy(repoPath, getLatestOverviewObject, overviewPathByObject, overviewProxyObjects)
}
function getLatestStatusObject(repoPath) { return latestStatusByPath.get(repoPath) || null }
function createStatusProxy(repoPath) {
  return createReadThroughProxy(repoPath, getLatestStatusObject, statusPathByObject)
}

export function subscribeBranchData(listener) {
  if (typeof listener !== 'function') return () => {}
  dataListeners.add(listener)
  return () => dataListeners.delete(listener)
}
export function getBranchDataRevision() { return dataRevision }
export function getLatestBranchDataChange() { return latestDataChange }
export function getBranchDataChangesSince(revision = 0) {
  const normalizedRevision = Number.isFinite(Number(revision)) ? Number(revision) : 0
  return dataChangeLog.filter((change) => change.revision > normalizedRevision)
}

export function subscribeBranchSnapshots(listener) {
  if (typeof listener !== 'function') return () => {}
  snapshotListeners.add(listener)
  return () => snapshotListeners.delete(listener)
}
export function subscribeBranchReadInvalidations(listener) {
  if (typeof listener !== 'function') return () => {}
  branchReadInvalidationListeners.add(listener)
  return () => branchReadInvalidationListeners.delete(listener)
}
export function getBranchSnapshotRevision() { return snapshotRevision }
export function getBranchSnapshotChangesSince(revision = 0) {
  const normalizedRevision = Number.isFinite(Number(revision)) ? Number(revision) : 0
  return snapshotChangeLog.filter((change) => change.revision > normalizedRevision)
}

export function subscribeBranchOperations(listener) {
  if (typeof listener !== 'function') return () => {}
  operationListeners.add(listener)
  return () => operationListeners.delete(listener)
}
export function getBranchOperationRevision() { return operationRevision }

export function registerBranchOverview(repoPath, overview) {
  const normalizedPath = normalizeBranchRepoPath(repoPath)
  if (!normalizedPath || !overview || typeof overview !== 'object') return overview || null
  const sourcePath = overviewPathByObject.get(overview)
  const rawOverview = sourcePath ? (latestOverviewByPath.get(sourcePath) || overview) : overview
  const nextFingerprint = createFingerprint(rawOverview)
  const changed = overviewFingerprintByPath.get(normalizedPath) !== nextFingerprint
  overviewPathByObject.set(rawOverview, normalizedPath)
  latestOverviewByPath.set(normalizedPath, rawOverview)
  overviewFingerprintByPath.set(normalizedPath, nextFingerprint)
  if (changed) publishSnapshotChange(normalizedPath, 'overview')
  return createOverviewProxy(normalizedPath)
}

export function publishBranchOverview(repoPath, overview) {
  const snapshot = registerBranchOverview(repoPath, overview)
  if (snapshot) publishData(repoPath)
  return snapshot
}

export function registerBranchStatus(repoPath, status) {
  const normalizedPath = normalizeBranchRepoPath(repoPath)
  if (!normalizedPath || !status || typeof status !== 'object') return status || null
  const sourcePath = statusPathByObject.get(status)
  const rawStatus = sourcePath ? (latestStatusByPath.get(sourcePath) || status) : status
  const nextFingerprint = createFingerprint(rawStatus)
  const changed = statusFingerprintByPath.get(normalizedPath) !== nextFingerprint
  statusPathByObject.set(rawStatus, normalizedPath)
  latestStatusByPath.set(normalizedPath, rawStatus)
  statusFingerprintByPath.set(normalizedPath, nextFingerprint)
  if (changed) publishSnapshotChange(normalizedPath, 'status')
  return createStatusProxy(normalizedPath)
}

export function publishBranchSnapshot(repoPath, { overview = null, status = null } = {}) {
  const normalizedPath = normalizeBranchRepoPath(repoPath)
  if (!normalizedPath) return false
  if (overview) registerBranchOverview(normalizedPath, overview)
  if (status) registerBranchStatus(normalizedPath, status)
  if (!overview && !status) return false
  publishData(normalizedPath)
  return true
}

export function resolveBranchOverview(overview) {
  if (!overview || typeof overview !== 'object') return overview || null
  const repoPath = overviewPathByObject.get(overview) || ''
  if (!repoPath) return overview
  return overviewProxyObjects.has(overview) ? overview : createOverviewProxy(repoPath)
}

export function getLatestBranchOverview(repoPath) {
  const normalizedPath = normalizeBranchRepoPath(repoPath)
  return latestOverviewByPath.has(normalizedPath) ? createOverviewProxy(normalizedPath) : null
}
export function getLatestBranchStatus(repoPath) {
  const normalizedPath = normalizeBranchRepoPath(repoPath)
  return latestStatusByPath.has(normalizedPath) ? createStatusProxy(normalizedPath) : null
}
export function getLatestBranchOverviewSnapshot(repoPath) {
  return latestOverviewByPath.get(normalizeBranchRepoPath(repoPath)) || null
}
export function getLatestBranchStatusSnapshot(repoPath) {
  return latestStatusByPath.get(normalizeBranchRepoPath(repoPath)) || null
}

export function getBranchReadGeneration(repoPath) {
  return branchReadGenerationByPath.get(normalizeBranchRepoPath(repoPath)) || 0
}

export function clearBranchSnapshotsForPaths(repoPaths) {
  const paths = Array.isArray(repoPaths) ? repoPaths : [repoPaths]
  let changed = false
  new Set(paths.map(normalizeBranchRepoPath).filter(Boolean)).forEach((repoPath) => {
    const nextGeneration = getBranchReadGeneration(repoPath) + 1
    branchReadGenerationByPath.set(repoPath, nextGeneration)
    const overviewRemoved = latestOverviewByPath.delete(repoPath)
    const statusRemoved = latestStatusByPath.delete(repoPath)
    const overviewFingerprintRemoved = overviewFingerprintByPath.delete(repoPath)
    const statusFingerprintRemoved = statusFingerprintByPath.delete(repoPath)
    branchReadInvalidationListeners.forEach((listener) => listener(repoPath, nextGeneration))
    if (!overviewRemoved && !statusRemoved && !overviewFingerprintRemoved && !statusFingerprintRemoved) return
    changed = true
    publishSnapshotChange(repoPath, 'clear')
  })
  return changed
}

export function beginBranchOperation({ repoPath, command = '', args = null } = {}) {
  const normalizedPath = normalizeBranchRepoPath(repoPath)
  if (!normalizedPath || operationByPath.has(normalizedPath)) return null
  operationSequence += 1
  const token = {
    id: operationSequence,
    repoPath: normalizedPath,
    command: String(command || ''),
    readGeneration: getBranchReadGeneration(normalizedPath),
  }
  operationByPath.set(normalizedPath, {
    token,
    phase: 'running',
    command: token.command,
    args: args && typeof args === 'object' ? args : null,
  })
  publishOperations()
  return token
}

export function markBranchOperationAwaitingRefresh(token) {
  if (!token?.repoPath) return false
  const current = operationByPath.get(token.repoPath)
  if (current?.token?.id !== token.id) return false
  if (token.readGeneration !== getBranchReadGeneration(token.repoPath)) {
    failBranchOperation(token)
    return false
  }
  if (current.phase === 'refreshing') return true
  operationByPath.set(token.repoPath, { ...current, phase: 'refreshing' })
  publishOperations()
  return true
}

export function completeBranchOperation(token, { overview = null, status = null } = {}) {
  if (!token?.repoPath) return false
  const current = operationByPath.get(token.repoPath)
  if (current?.token?.id !== token.id) return false
  if (token.readGeneration !== getBranchReadGeneration(token.repoPath)) {
    failBranchOperation(token)
    return false
  }
  if (overview) registerBranchOverview(token.repoPath, overview)
  if (status) registerBranchStatus(token.repoPath, status)
  operationByPath.delete(token.repoPath)
  if (overview || status) publishData(token.repoPath)
  publishOperations()
  return true
}

export function failBranchOperation(token) {
  if (!token?.repoPath) return false
  const current = operationByPath.get(token.repoPath)
  if (current?.token?.id !== token.id) return false
  operationByPath.delete(token.repoPath)
  publishOperations()
  return true
}

export function getActiveBranchOperationPaths() { return new Set(operationByPath.keys()) }

export function resetBranchDomainStoreForTests() {
  latestOverviewByPath.clear()
  latestStatusByPath.clear()
  overviewFingerprintByPath.clear()
  statusFingerprintByPath.clear()
  branchReadGenerationByPath.clear()
  operationByPath.clear()
  dataChangeLog.length = 0
  snapshotChangeLog.length = 0
  dataRevision = 0
  snapshotRevision = 0
  operationRevision = 0
  operationSequence = 0
  latestDataChange = Object.freeze({ revision: 0, repoPath: '' })
}
