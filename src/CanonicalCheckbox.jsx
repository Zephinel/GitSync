import { CheckIcon as CanonicalCheckIcon } from './icons/CanonicalIcons.jsx'

/**
 * Canonical square-checkbox authority for the whole application.
 *
 * All surfaces that present a real checkbox (not a switch) must use this
 * component so the 16px / 5px / accent-blue checked visual stays in one place.
 * The native input remains in the DOM (visually hidden) so keyboard focus,
 * Space toggling, disabled state and screen-reader state are preserved.
 */
export default function CanonicalCheckbox({
  checked,
  disabled = false,
  onChange,
  label,
  title,
  className = '',
  children,
  inputProps,
  ...rest
}) {
  return (
    <label
      className={[
        'canonical-checkbox',
        disabled ? 'canonical-checkbox--disabled' : '',
        className,
      ].filter(Boolean).join(' ')}
      data-app-tooltip={title ?? label}
      {...rest}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange?.(event.target.checked)}
        {...inputProps}
      />
      <span className="canonical-checkbox__box" aria-hidden="true">
        <CanonicalCheckIcon />
      </span>
      {children}
    </label>
  )
}
