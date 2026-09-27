import './WorkingChangesFileCell.css'

export default function WorkingChangesFileCell({
  actions = null,
  actionsProps = {},
  checkbox,
  filePath,
  filename,
  glyph,
  metadata = null,
  metrics,
  onPreview,
  previewLabel,
  selected = false,
  stagingState = 'clean',
  stagingStateContext = 'row',
  stagingStateLabel = null,
  status,
}) {
  const className = [
    'working-changes-file-cell',
    'working-changes-file-row',
    selected ? 'working-changes-file-cell--selected' : '',
    actions ? 'working-changes-file-cell--has-actions' : 'working-changes-file-cell--no-actions',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={className}
      data-staging-context={stagingStateContext}
      data-staging-state={stagingState}
      data-file-path={filePath}
    >
      <div className="working-changes-file-cell__selection">
        {checkbox}
      </div>

      <button
        className="working-changes-file-cell__preview"
        type="button"
        onClick={onPreview}
        aria-label={previewLabel}
        aria-pressed={selected}
      >
        {glyph}
        <span className="working-changes-file-cell__identity">
          <span className="working-changes-file-cell__filename" data-app-tooltip={filePath}>
            {filename}
          </span>
          <span className="working-changes-file-cell__path" data-app-tooltip={filePath}>
            {filePath}
          </span>
        </span>
        <span className="working-changes-file-cell__status">
          {status}
        </span>
        <span className="working-changes-file-cell__details">
          {metrics}
          {stagingStateContext === 'row' ? stagingStateLabel : null}
          {metadata}
        </span>
      </button>

      {actions ? (
        <div
          role="group"
          {...actionsProps}
          className="working-changes-file-cell__actions"
        >
          {actions}
        </div>
      ) : null}
    </div>
  )
}
