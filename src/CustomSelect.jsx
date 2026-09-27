import { useEffect, useMemo, useRef, useState } from 'react'
import { SelectChevronIcon as CanonicalSelectChevronIcon } from './icons/CanonicalIcons.jsx'
import { APP_TOOLTIP_DELAY_MS, isTextVisuallyTruncated } from './appTooltip.js'
import { AppTooltipSurface } from './AppTooltip.jsx'

function ArrowDownIcon({ open = false }) {
  return (
    <CanonicalSelectChevronIcon
      className={`icon icon--xs custom-select__arrow ${open ? 'custom-select__arrow--open' : ''}`}
    />
  )
}

export default function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  disabled = false,
  placeholder = '请选择',
  searchable = false,
  searchPlaceholder = '搜索',
  emptyText = '没有匹配项',
}) {
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [tooltip, setTooltip] = useState(null)
  const rootRef = useRef(null)
  const searchRef = useRef(null)
  const tooltipTimerRef = useRef(null)
  const normalizedOptions = Array.isArray(options) ? options.filter((option) => option?.value) : []
  const selectedOption = normalizedOptions.find((option) => option.value === value) || null

  const filteredOptions = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase()
    if (!normalizedKeyword) return normalizedOptions
    return normalizedOptions.filter((option) => (
      `${option.label || ''} ${option.value || ''}`.toLowerCase().includes(normalizedKeyword)
    ))
  }, [keyword, normalizedOptions])

  const hideTooltip = () => {
    if (tooltipTimerRef.current) {
      window.clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
    }
    setTooltip(null)
  }

  const scheduleTooltip = (text, textElement) => {
    hideTooltip()
    const normalizedText = String(text || '').trim()
    if (!normalizedText || !textElement) return
    tooltipTimerRef.current = window.setTimeout(() => {
      tooltipTimerRef.current = null
      if (!isTextVisuallyTruncated(textElement)) return
      setTooltip({ text: normalizedText, anchor: textElement })
    }, APP_TOOLTIP_DELAY_MS)
  }

  useEffect(() => {
    if (disabled) {
      setOpen(false)
      hideTooltip()
    }
  }, [disabled])

  useEffect(() => {
    if (!open) {
      setKeyword('')
      hideTooltip()
      return undefined
    }

    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    if (searchable) window.requestAnimationFrame(() => searchRef.current?.focus())
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, searchable])

  useEffect(() => {
    if (!tooltip) return undefined
    const close = () => hideTooltip()
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [tooltip])

  useEffect(() => () => {
    if (tooltipTimerRef.current) window.clearTimeout(tooltipTimerRef.current)
  }, [])

  const handleSelect = (nextValue) => {
    hideTooltip()
    setOpen(false)
    if (nextValue !== value) onChange?.(nextValue)
  }

  return (
    <>
      <div className={`custom-select ${className}`.trim()} ref={rootRef}>
        <button
          type="button"
          className={`custom-select__trigger ${open ? 'custom-select__trigger--open' : ''}`}
          onClick={() => setOpen((previous) => !previous)}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span
            className={`custom-select__label ${selectedOption ? '' : 'custom-select__label--placeholder'}`.trim()}
            onMouseEnter={(event) => scheduleTooltip(selectedOption?.label || selectedOption?.value, event.currentTarget)}
            onMouseLeave={hideTooltip}
          >
            {selectedOption?.label || placeholder}
          </span>
          <ArrowDownIcon open={open} />
        </button>

        {open && !disabled ? (
          <div className="custom-select__menu" role="listbox" aria-label={ariaLabel}>
            {searchable ? (
              <div className="custom-select__search-wrap">
                <input
                  ref={searchRef}
                  className="custom-select__search"
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                />
              </div>
            ) : null}
            <div className="custom-select__options">
              {filteredOptions.length > 0 ? filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`custom-select__option ${option.value === value ? 'custom-select__option--active' : ''}`}
                  onClick={() => handleSelect(option.value)}
                  role="option"
                  aria-selected={option.value === value}
                >
                  <span
                    className="custom-select__option-label"
                    onMouseEnter={(event) => scheduleTooltip(option.label || option.value, event.currentTarget)}
                    onMouseLeave={hideTooltip}
                  >
                    {option.label || option.value}
                  </span>
                  {option.description ? <small>{option.description}</small> : null}
                </button>
              )) : <div className="custom-select__empty">{emptyText}</div>}
            </div>
          </div>
        ) : null}
      </div>

      {tooltip ? <AppTooltipSurface anchor={tooltip.anchor} text={tooltip.text} /> : null}
    </>
  )
}
