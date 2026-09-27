import { isIconDefinition } from './iconDefinitions.js'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const SVG_ATTRIBUTE_NAMES = Object.freeze({
  clipPath: 'clip-path',
  clipRule: 'clip-rule',
  fillRule: 'fill-rule',
  strokeDasharray: 'stroke-dasharray',
  strokeDashoffset: 'stroke-dashoffset',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeMiterlimit: 'stroke-miterlimit',
  strokeWidth: 'stroke-width',
})

function svgAttributeName(name) {
  return SVG_ATTRIBUTE_NAMES[name] || name
}

function setSvgAttributes(element, attributes) {
  Object.entries(attributes || {}).forEach(([name, value]) => {
    if (value === undefined || value === null) return
    element.setAttribute(svgAttributeName(name), String(value))
  })
}

export function createIconSvgElement(icon, {
  className = '',
  documentRef = typeof document === 'undefined' ? null : document,
} = {}) {
  if (!isIconDefinition(icon)) throw new TypeError('expected a valid IconDefinition')
  if (!documentRef?.createElementNS) throw new TypeError('documentRef must support createElementNS')

  const svg = documentRef.createElementNS(SVG_NAMESPACE, 'svg')
  svg.setAttribute('viewBox', icon.viewBox)
  svg.setAttribute('aria-hidden', 'true')
  if (className) svg.setAttribute('class', className)
  setSvgAttributes(svg, icon.svg)

  icon.elements.forEach(({ type, ...attributes }) => {
    const element = documentRef.createElementNS(SVG_NAMESPACE, type)
    setSvgAttributes(element, attributes)
    svg.appendChild(element)
  })

  return svg
}
