import { isIconDefinition } from './iconDefinitions.js'

export default function AppIcon({
  icon,
  className = '',
  size,
  style,
  ariaLabel = '',
}) {
  if (!isIconDefinition(icon)) {
    throw new TypeError('AppIcon requires a valid IconDefinition')
  }

  const accessible = Boolean(String(ariaLabel || '').trim())

  return (
    <svg
      viewBox={icon.viewBox}
      {...icon.svg}
      width={size ?? undefined}
      height={size ?? undefined}
      className={className || undefined}
      style={style}
      aria-hidden={accessible ? undefined : 'true'}
      aria-label={accessible ? ariaLabel : undefined}
      role={accessible ? 'img' : undefined}
      focusable="false"
    >
      {icon.elements.map(({ type, ...attributes }, index) => {
        const Element = type
        return <Element key={`${type}-${index}`} {...attributes} />
      })}
    </svg>
  )
}
