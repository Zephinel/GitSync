// Shared markup authority for interval-style stepper controls.
//
// Callers own the value, the allowed range, and the unit state; this component
// only renders the `.interval-control` surface. The sync interval in Settings
// and the AI request timeout therefore cannot drift apart visually, and a
// single-unit caller keeps that unit on the stepper's row instead of switching
// it.

import { INTERVAL_UNIT_OPTIONS, INTERVAL_UNIT_ORDER } from './intervalUnits.js'

export default function IntervalControl({
  unit,
  units = INTERVAL_UNIT_ORDER,
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
  const unitKeys = (Array.isArray(units) ? units : INTERVAL_UNIT_ORDER)
    .filter((key) => INTERVAL_UNIT_OPTIONS[key])
  const resolvedUnitKeys = unitKeys.length > 0 ? unitKeys : [INTERVAL_UNIT_OPTIONS.seconds.key]
  const activeUnit = INTERVAL_UNIT_OPTIONS[unit] || INTERVAL_UNIT_OPTIONS[resolvedUnitKeys[0]]
  const switchable = resolvedUnitKeys.length > 1
  const layoutClassName = switchable ? 'interval-control' : 'interval-control interval-control--inline-unit'

  return (
    <div className={`${layoutClassName} ${disabled ? 'interval-control--disabled' : ''}`.trim()}>
      <div className="interval-control__main">
        <button
          type="button"
          className="interval-control__step"
          onClick={() => onStep(-1)}
          aria-label={decreaseAriaLabel}
          disabled={disabled}
        >
          -
        </button>
        <input
          type="text"
          inputMode="numeric"
          className="interval-control__input"
          value={amountDraft}
          onChange={(event) => onAmountDraftChange(event.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => onCommit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          aria-label={inputAriaLabel}
          disabled={disabled}
        />
        <button
          type="button"
          className="interval-control__step"
          onClick={() => onStep(1)}
          aria-label={increaseAriaLabel}
          disabled={disabled}
        >
          +
        </button>
      </div>
      <div className="interval-control__units">
        {switchable ? resolvedUnitKeys.map((key) => (
          <button
            key={key}
            type="button"
            className={`interval-control__unit-btn ${unit === key ? 'interval-control__unit-btn--active' : ''}`.trim()}
            onClick={() => onUnitChange?.(key)}
            aria-pressed={unit === key}
            disabled={disabled}
          >
            {INTERVAL_UNIT_OPTIONS[key].label}
          </button>
        )) : (
          <span className="interval-control__unit-btn interval-control__unit-btn--active" aria-hidden="true">
            {activeUnit.label}
          </span>
        )}
      </div>
    </div>
  )
}
