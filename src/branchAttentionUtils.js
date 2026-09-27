import { resolveBranchOverview } from './branchDomainStore.js'

export const BRANCH_ATTENTION_KIND = Object.freeze({
  remoteOnly: 'remote-only',
  behind: 'behind',
  diverged: 'diverged',
  upstreamGone: 'upstream-gone',
  comparisonError: 'comparison-error',
})

function toCount(value) {
  const count = Number(value)
  return Number.isFinite(count) ? Math.max(0, count) : 0
}

function classifyBranchAttentionItem(branchItem) {
  const ahead = toCount(branchItem?.ahead)
  const behind = toCount(branchItem?.behind)
  const comparisonState = String(branchItem?.comparison_state || '').trim()
  const upstreamGone = branchItem?.upstream_gone === true || comparisonState === 'upstream-gone'

  if (branchItem?.is_remote_only === true) return BRANCH_ATTENTION_KIND.remoteOnly
  if (upstreamGone) return BRANCH_ATTENTION_KIND.upstreamGone
  if (comparisonState === 'error') return BRANCH_ATTENTION_KIND.comparisonError
  if (ahead > 0 && behind > 0) return BRANCH_ATTENTION_KIND.diverged
  if (behind > 0) return BRANCH_ATTENTION_KIND.behind
  return ''
}

function getBranchDisplayName(branchItem) {
  return String(
    branchItem?.local_name
      || branchItem?.name
      || branchItem?.upstream
      || branchItem?.full_ref
      || ''
  ).trim()
}

function getBranchFullName(branchItem, fallback) {
  return String(
    branchItem?.name
      || branchItem?.upstream
      || branchItem?.full_ref
      || fallback
      || ''
  ).trim()
}

function buildBranchAttentionReason(branchItem, kind) {
  const ahead = toCount(branchItem?.ahead)
  const behind = toCount(branchItem?.behind)
  const upstream = String(branchItem?.upstream || '').trim()
  const worktreePath = String(branchItem?.worktree_path || '').trim()
  const comparisonError = String(branchItem?.comparison_error || '').trim()

  if (kind === BRANCH_ATTENTION_KIND.remoteOnly) {
    return '远端存在该分支，本地尚未建立对应分支。'
  }
  if (kind === BRANCH_ATTENTION_KIND.upstreamGone) {
    return '关联的远端分支已经不存在。'
  }
  if (kind === BRANCH_ATTENTION_KIND.comparisonError) {
    return comparisonError
      ? `无法读取分支比较状态：${comparisonError}`
      : '无法读取该分支与上游的比较状态。'
  }
  if (kind === BRANCH_ATTENTION_KIND.diverged) {
    return `本地领先 ${ahead}、落后 ${behind} 个提交，分支已经分叉。`
  }

  const base = upstream
    ? `落后 ${upstream} ${behind} 个提交。`
    : `落后远端 ${behind} 个提交。`
  return branchItem?.is_checked_out_elsewhere === true
    ? `${base}${worktreePath ? ` 该分支已在其他 worktree 检出：${worktreePath}` : ' 该分支已在其他 worktree 检出。'}`
    : base
}

function getBranchAttentionKindLabel(kind) {
  if (kind === BRANCH_ATTENTION_KIND.remoteOnly) return '仅远端'
  if (kind === BRANCH_ATTENTION_KIND.behind) return '落后远端'
  if (kind === BRANCH_ATTENTION_KIND.diverged) return '已分叉'
  if (kind === BRANCH_ATTENTION_KIND.upstreamGone) return '上游失效'
  return '读取失败'
}

export function getBranchAttentionItems(overview) {
  const effectiveOverview = resolveBranchOverview(overview)
  const branches = Array.isArray(effectiveOverview?.branches) ? effectiveOverview.branches : []

  return branches.flatMap((branchItem) => {
    if (!branchItem || typeof branchItem !== 'object' || branchItem.is_current) return []
    const kind = classifyBranchAttentionItem(branchItem)
    if (!kind) return []
    const branch = getBranchDisplayName(branchItem)

    return [{
      identity: String(branchItem.identity || branchItem.full_ref || branchItem.name || '').trim(),
      branch,
      fullName: getBranchFullName(branchItem, branch),
      upstream: String(branchItem.upstream || '').trim(),
      kind,
      kindLabel: getBranchAttentionKindLabel(kind),
      reason: buildBranchAttentionReason(branchItem, kind),
      ahead: toCount(branchItem.ahead),
      behind: toCount(branchItem.behind),
      source: branchItem,
    }]
  })
}

function countAttentionKinds(items) {
  return items.reduce((counts, item) => {
    counts[item.kind] = (counts[item.kind] || 0) + 1
    return counts
  }, {})
}

function buildKindSummary(counts) {
  const entries = [
    [BRANCH_ATTENTION_KIND.remoteOnly, '仅远端'],
    [BRANCH_ATTENTION_KIND.behind, '落后'],
    [BRANCH_ATTENTION_KIND.diverged, '分叉'],
    [BRANCH_ATTENTION_KIND.upstreamGone, '上游失效'],
    [BRANCH_ATTENTION_KIND.comparisonError, '读取失败'],
  ]
  return entries
    .filter(([kind]) => toCount(counts[kind]) > 0)
    .map(([kind, label]) => `${label} ${counts[kind]}`)
    .join(' · ')
}

function buildAttentionMessage(items, counts) {
  const count = items.length
  if (count === 1) {
    const item = items[0]
    if (item.kind === BRANCH_ATTENTION_KIND.remoteOnly) return `发现仅远端分支 ${item.branch}`
    if (item.kind === BRANCH_ATTENTION_KIND.behind) return `${item.branch} 落后远端 ${item.behind} 个提交`
    if (item.kind === BRANCH_ATTENTION_KIND.diverged) return `${item.branch} 已分叉`
    if (item.kind === BRANCH_ATTENTION_KIND.upstreamGone) return `${item.branch} 的上游已失效`
    return `${item.branch} 状态读取失败`
  }

  const kindEntries = Object.entries(counts).filter(([, value]) => value > 0)
  if (kindEntries.length === 1) {
    const [kind] = kindEntries[0]
    if (kind === BRANCH_ATTENTION_KIND.remoteOnly) return `发现 ${count} 个仅远端分支`
    if (kind === BRANCH_ATTENTION_KIND.behind) return `${count} 个其他分支落后远端`
    if (kind === BRANCH_ATTENTION_KIND.diverged) return `${count} 个其他分支已分叉`
    if (kind === BRANCH_ATTENTION_KIND.upstreamGone) return `${count} 个分支上游已失效`
    return `${count} 个分支状态读取失败`
  }

  return `其他分支：${buildKindSummary(counts)}`
}

export function getBranchAttentionSummary(overview) {
  const items = getBranchAttentionItems(overview)
  if (items.length === 0) return null
  const counts = countAttentionKinds(items)
  return {
    count: items.length,
    message: buildAttentionMessage(items, counts),
    detail: buildKindSummary(counts),
    counts,
    items,
  }
}

export function getBranchAttentionKey(overview) {
  const attentionItems = getBranchAttentionItems(overview)
  if (attentionItems.length === 0) return ''

  const snapshots = attentionItems.map((item) => [
    item.identity,
    item.branch,
    item.fullName,
    item.upstream,
    item.ahead,
    item.behind,
    item.kind,
    String(item.source?.comparison_error || '').trim(),
    item.source?.is_checked_out_elsewhere === true,
    String(item.source?.worktree_path || '').trim(),
    String(item.source?.head_hash || '').trim(),
  ])
  snapshots.sort((left, right) => left[0].localeCompare(right[0]))
  return JSON.stringify(snapshots)
}

export function parseDismissedBranchAttentionKeys(rawValue) {
  try {
    const parsed = JSON.parse(String(rawValue || ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([repoId, attentionKey]) => (
          String(repoId || '').trim()
          && typeof attentionKey === 'string'
          && attentionKey.trim()
        ))
        .map(([repoId, attentionKey]) => [repoId.trim(), attentionKey.trim()])
    )
  } catch {
    return {}
  }
}

export function getBranchAttention(overview) {
  const summary = getBranchAttentionSummary(overview)
  if (!summary) return null
  const firstItem = summary.items.length === 1 ? summary.items[0] : null

  return {
    count: summary.count,
    message: summary.message,
    reason: '',
    action: 'details',
    actionLabel: '查看详情',
    branch: firstItem?.branch || '',
    branchItem: firstItem?.source || null,
  }
}