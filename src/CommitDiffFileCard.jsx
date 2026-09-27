export default function CommitDiffFileCard({
  actions = null,
  actionsClassName = '',
  actionsProps = {},
  buttonProps = {},
  cardProps = {},
  children,
  className = '',
  contentClass = '',
  onClick,
  prefix = null,
  prefixClassName = '',
  selected = false,
}) {
  const cardClassName = [
    'commit-diff-file-card',
    selected ? 'commit-diff-file-card--selected' : '',
    className,
  ].filter(Boolean).join(' ')
  const contentClassName = [
    'commit-diff-file-card__content',
    'commit-diff-file-item',
    contentClass,
  ].filter(Boolean).join(' ')

  return (
    <div {...cardProps} className={cardClassName}>
      {prefix ? <div className={`commit-diff-file-card__prefix ${prefixClassName}`.trim()}>{prefix}</div> : null}
      <button
        {...buttonProps}
        className={contentClassName}
        type={buttonProps.type || 'button'}
        onClick={onClick}
        aria-pressed={selected}
      >
        {children}
      </button>
      {actions ? <div {...actionsProps} className={`commit-diff-file-card__actions ${actionsClassName}`.trim()}>{actions}</div> : null}
    </div>
  )
}
