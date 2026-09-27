const STATUS_DIRECTION_RULES = Object.freeze([
  { prefix: '待推送', direction: 'up', label: '本地领先，待推送到远端' },
  { prefix: '落后', direction: 'down', label: '本地落后，需要从远端同步' },
  { prefix: '分叉', direction: 'diverged', label: '本地与远端双向分叉' },
  { prefix: '已同步', direction: 'synced', label: '本地与远端保持同步' },
  { prefix: '仅远端', direction: 'remote', label: '仅存在远端引用，可拉取到本地' },
])

export function getBranchStatusDirection(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const rule = STATUS_DIRECTION_RULES.find((item) => text.startsWith(item.prefix))
  return rule ? { direction: rule.direction, label: rule.label } : null
}
