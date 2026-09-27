import { memo } from 'react'
import { GroupChevronIcon as CanonicalGroupChevronIcon } from './icons/CanonicalIcons.jsx'

function GroupChevronIcon({ expanded }) {
  return (
    <CanonicalGroupChevronIcon
      className={`working-changes-group__chevron ${expanded ? 'working-changes-group__chevron--expanded' : ''}`}
    />
  )
}

function WorkingChangesFileGroups({
  groups,
  collapsedGroupIds,
  searching,
  onToggleGroup,
  renderFile,
}) {
  if (!Array.isArray(groups) || groups.length === 0) return null

  return (
    <div className="working-changes-groups">
      {groups.map((group) => {
        const expanded = searching || !collapsedGroupIds?.has(group.id)
        const panelId = `working-changes-group-${group.id}`
        const headingId = `${panelId}-heading`
        const countLabel = searching && group.filtered_count !== group.total_count
          ? `${group.filtered_count} / ${group.total_count}`
          : String(group.total_count)

        return (
          <section
            className={`working-changes-group working-changes-group--${group.tone}`}
            data-working-changes-group={group.id}
            aria-labelledby={headingId}
            key={group.id}
          >
            <button
              className="working-changes-group__header"
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              aria-disabled={searching}
              data-app-tooltip={searching ? '搜索期间匹配分组会自动展开' : (expanded ? `收起${group.label}` : `展开${group.label}`)}
              onClick={() => {
                if (!searching) onToggleGroup?.(group.id)
              }}
            >
              <GroupChevronIcon expanded={expanded} />
              <span className="working-changes-group__heading">
                <strong id={headingId}>{group.label}</strong>
                <small>{group.description}</small>
              </span>
              <span className="working-changes-group__count" aria-label={`${group.label} ${countLabel} 个文件`}>
                {countLabel}
              </span>
            </button>

            {expanded ? (
              <div className="working-changes-group__files" id={panelId}>
                {group.files.map((file) => renderFile(file, group))}
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

export default memo(WorkingChangesFileGroups)
