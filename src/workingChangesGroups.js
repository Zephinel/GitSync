const GROUP_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'conflicted',
    label: '冲突',
    description: '需要先解决冲突，不能使用普通 Stage / Unstage。',
    tone: 'conflicted',
    search_aliases: '冲突 conflict conflicted unmerged',
  }),
  Object.freeze({
    id: 'staged',
    label: '已暂存改动',
    description: '这些改动已经进入暂存区，将作为下一次提交的候选内容。',
    tone: 'staged',
    search_aliases: '已暂存 暂存 staged index',
  }),
  Object.freeze({
    id: 'mixed',
    label: '部分暂存',
    description: '这些文件同时包含已暂存和未暂存改动。',
    tone: 'mixed',
    search_aliases: '部分暂存 混合 mixed partially staged',
  }),
  Object.freeze({
    id: 'unstaged',
    label: '未暂存改动',
    description: '这些改动尚未进入暂存区，其中可能包含未跟踪文件。',
    tone: 'unstaged',
    search_aliases: '未暂存 unstaged worktree changes 未跟踪 untracked',
  }),
])

const GROUP_DEFINITION_BY_ID = new Map(
  GROUP_DEFINITIONS.map((definition) => [definition.id, definition])
)

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function getWorkingChangeGroupId(file) {
  if (file?.is_conflicted || file?.staging_state === 'conflicted') return 'conflicted'
  if (
    file?.staging_state === 'mixed'
    || (file?.has_staged_changes && file?.has_unstaged_changes)
  ) return 'mixed'
  if (
    file?.staging_state === 'staged'
    || (file?.has_staged_changes && !file?.has_unstaged_changes)
  ) return 'staged'
  return 'unstaged'
}

export function workingChangeMatchesQuery(file, query) {
  const keyword = normalizeText(query)
  if (!keyword) return true
  const groupId = getWorkingChangeGroupId(file)
  const group = GROUP_DEFINITION_BY_ID.get(groupId)
  const searchable = [
    file?.path,
    file?.old_path,
    file?.status,
    file?.staging_state,
    file?.is_untracked ? '未跟踪 untracked' : '',
    file?.is_conflicted ? '冲突 conflict' : '',
    groupId,
    group?.label,
    group?.search_aliases,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return searchable.includes(keyword)
}

export function groupWorkingChangesFiles(files, query = '') {
  const source = Array.isArray(files) ? files : []
  const buckets = new Map(GROUP_DEFINITIONS.map((definition) => [definition.id, []]))

  source.forEach((file) => {
    buckets.get(getWorkingChangeGroupId(file))?.push(file)
  })

  return GROUP_DEFINITIONS.map((definition) => {
    const allFiles = buckets.get(definition.id) || []
    const filteredFiles = allFiles.filter((file) => workingChangeMatchesQuery(file, query))
    return {
      ...definition,
      files: filteredFiles,
      total_count: allFiles.length,
      filtered_count: filteredFiles.length,
    }
  }).filter((group) => group.total_count > 0 && group.filtered_count > 0)
}

export function isWorkingChangeGroupExpanded(groupId, collapsedGroupIds, searching = false) {
  if (searching) return true
  return !(collapsedGroupIds instanceof Set && collapsedGroupIds.has(groupId))
}

export function getVisibleWorkingChangeFiles(groups, collapsedGroupIds, searching = false) {
  if (!Array.isArray(groups)) return []
  return groups.flatMap((group) => (
    isWorkingChangeGroupExpanded(group.id, collapsedGroupIds, searching)
      ? group.files
      : []
  ))
}

export function toggleCollapsedWorkingChangeGroup(collapsedGroupIds, groupId) {
  const next = new Set(collapsedGroupIds instanceof Set ? collapsedGroupIds : [])
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  return next
}
