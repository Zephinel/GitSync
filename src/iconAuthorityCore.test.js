import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as iconDefinitionExports from './icons/iconDefinitions.js'
import {
  defineIcon,
  getIconDefinitionSignature,
  isIconDefinition,
} from './icons/iconDefinitions.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const APP_ICON_KEYS = [
  'batch',
  'bolt',
  'dashboard',
  'settings',
  'sync',
  'refresh',
  'folder',
  'branch',
  'github',
  'clock',
  'copy',
  'diff',
  'commitHistory',
  'search',
  'edit',
  'pause',
  'play',
  'trash',
  'warning',
  'warningMissingRepo',
  'sun',
  'moon',
  'monitor',
  'terminal',
  'check',
  'close',
  'externalLink',
  'arrowDown',
  'arrowUp',
  'plus',
  'cloneRepo',
  'listLayout',
  'masonryLayout',
  'sidebarPanel',
  'more',
]

test('IconDefinition supports fill, stroke and multi-element geometry without presentation state', () => {
  const fillIcon = defineIcon({
    svg: { fill: 'currentColor' },
    elements: [
      { type: 'path', d: 'M2 2H22V22H2Z' },
      { type: 'rect', x: 6, y: 6, width: 12, height: 12, fill: 'none', stroke: 'currentColor' },
    ],
  })
  const strokeIcon = defineIcon({
    viewBox: '0 0 16 16',
    svg: {
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    elements: [
      { type: 'path', d: 'M1.25 2.5L4.75 5.25H7.5' },
      { type: 'path', d: 'M10.5 11.25C12 12.75 14.25 13.5 15.5 16.75' },
    ],
  })

  assert.equal(isIconDefinition(fillIcon), true)
  assert.equal(isIconDefinition(strokeIcon), true)
  assert.equal(isIconDefinition({ ...fillIcon }), false)
  assert.equal(fillIcon.elements[1].width, 12)
  assert.equal(strokeIcon.elements.length, 2)
  assert.equal(Object.isFrozen(strokeIcon), true)
  assert.equal(Object.isFrozen(strokeIcon.svg), true)
  assert.equal(Object.isFrozen(strokeIcon.elements), true)
  assert.equal(Object.isFrozen(strokeIcon.elements[0]), true)
})

test('IconDefinition rejects presentation ownership, hard-coded colors and incomplete primitives', () => {
  assert.throws(() => defineIcon({
    svg: { width: 16 },
    elements: [{ type: 'path', d: 'M0 0H1' }],
  }), /cannot own presentation attribute: width/)

  assert.throws(() => defineIcon({
    elements: [{ type: 'path', d: 'M0 0H1', className: 'temporary-icon' }],
  }), /cannot own presentation attribute: className/)

  assert.throws(() => defineIcon({
    svg: { fill: '#ff0000' },
    elements: [{ type: 'path', d: 'M0 0H1' }],
  }), /fill must use currentColor or none/)

  assert.throws(() => defineIcon({
    elements: [{ type: 'circle', cx: 8, cy: 8 }],
  }), /requires r/)
})

test('IconDefinition signatures are stable across attribute insertion order', () => {
  const first = defineIcon({
    svg: { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 },
    elements: [{ type: 'path', strokeLinecap: 'round', d: 'M2 12H22' }],
  })
  const second = defineIcon({
    svg: { strokeWidth: 1.7, stroke: 'currentColor', fill: 'none' },
    elements: [{ d: 'M2 12H22', type: 'path', strokeLinecap: 'round' }],
  })
  const different = defineIcon({
    svg: { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 },
    elements: [{ type: 'path', strokeLinecap: 'round', d: 'M3 12H21' }],
  })

  assert.equal(getIconDefinitionSignature(first), getIconDefinitionSignature(second))
  assert.notEqual(getIconDefinitionSignature(first), getIconDefinitionSignature(different))
})

test('all exported ordinary IconDefinitions have unique full geometry signatures', () => {
  const entries = Object.entries(iconDefinitionExports)
    .filter(([, value]) => isIconDefinition(value))
  const signatureOwners = new Map()

  for (const [name, icon] of entries) {
    const signature = getIconDefinitionSignature(icon)
    assert.equal(
      signatureOwners.has(signature),
      false,
      `${name} duplicates canonical geometry already owned by ${signatureOwners.get(signature)}`
    )
    signatureOwners.set(signature, name)
  }

  assert.ok(entries.length > 30, 'expected the canonical ordinary icon surface to be inventoried')
})

test('Stage 5 batch selection uses a canonical definition and named component export', () => {
  const canonicalIcons = read('./icons/CanonicalIcons.jsx')
  const batchSelect = iconDefinitionExports.BATCH_SELECT_ICON

  assert.equal(isIconDefinition(batchSelect), true)
  assert.equal(batchSelect.svg.fill, 'currentColor')
  assert.equal(batchSelect.elements.length, 1)
  assert.equal(batchSelect.elements[0].type, 'path')
  assert.match(canonicalIcons, /BATCH_SELECT_ICON/)
  assert.match(canonicalIcons, /export const BatchSelectIcon = iconComponent\(BATCH_SELECT_ICON\)/)
})

test('AppIcon is a geometry-neutral renderer', () => {
  const renderer = read('./icons/AppIcon.jsx')

  assert.match(renderer, /import \{ isIconDefinition \} from '\.\/iconDefinitions\.js'/)
  assert.match(renderer, /viewBox=\{icon\.viewBox\}/)
  assert.match(renderer, /\{\.\.\.icon\.svg\}/)
  assert.match(renderer, /icon\.elements\.map/)
  assert.match(renderer, /const Element = type/)
  assert.match(renderer, /<Element key=/)
  assert.doesNotMatch(renderer, /<path\b|<rect\b|<circle\b|<polygon\b|<polyline\b/)
})

test('IconDefinition DOM renderer derives SVG nodes from canonical data without owning geometry', () => {
  const renderer = read('./icons/iconDom.js')

  assert.match(renderer, /import \{ isIconDefinition \} from '\.\/iconDefinitions\.js'/)
  assert.match(renderer, /export function createIconSvgElement\(icon/)
  assert.match(renderer, /documentRef\.createElementNS\(SVG_NAMESPACE, 'svg'\)/)
  assert.match(renderer, /icon\.elements\.forEach/)
  assert.match(renderer, /strokeLinecap: 'stroke-linecap'/)
  assert.match(renderer, /strokeLinejoin: 'stroke-linejoin'/)
  assert.match(renderer, /strokeWidth: 'stroke-width'/)
  assert.doesNotMatch(
    renderer,
    /documentRef\.createElementNS\(SVG_NAMESPACE,\s*['"](?:path|rect|circle|ellipse|line|polyline|polygon)['"]\)/,
  )
  assert.doesNotMatch(
    renderer,
    /\bsetAttribute\(\s*['"](?:d|points|x|y|width|height|cx|cy|r|rx|ry|x1|y1|x2|y2)['"]\s*,|\bsetAttributeNS\(\s*[^,]+,\s*['"](?:d|points|x|y|width|height|cx|cy|r|rx|ry|x1|y1|x2|y2)['"]\s*,/,
  )
  assert.doesNotMatch(renderer, /\bd:\s*['"`]|<svg\b|<path\b|innerHTML/)
})

test('App consumes the semantic icon registry without owning SVG geometry', () => {
  const app = read('./App.jsx')
  const registry = read('./icons/appIconRegistry.js')

  assert.match(app, /import \{ APP_ICONS as Icons \} from '\.\/icons\/appIconRegistry\.js'/)
  assert.doesNotMatch(app, /const\s+Icons\s*=/)
  assert.doesNotMatch(app, /<svg\b|<path\b|<rect\b|<circle\b|<polygon\b|<polyline\b/)

  assert.match(registry, /export const APP_ICONS = Object\.freeze\(\{/)
  assert.doesNotMatch(registry, /<svg\b|<path\b|defineIcon\(|\bd:\s*['"`]/)

  const registryBody = registry.match(/export const APP_ICONS = Object\.freeze\(\{([\s\S]*?)\}\)\s*$/)?.[1] || ''
  const registryKeys = [...registryBody.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)]
    .map((match) => match[1])

  assert.deepEqual(registryKeys, APP_ICON_KEYS)
})

test('GitHub brand geometry stays outside the ordinary UI icon authority', () => {
  const definitions = read('./icons/iconDefinitions.js')
  const canonicalIcons = read('./icons/CanonicalIcons.jsx')
  const brandDefinitions = read('./brand/brandDefinitions.js')
  const githubMark = read('./brand/GitHubMark.jsx')
  const registry = read('./icons/appIconRegistry.js')

  assert.doesNotMatch(definitions, /\bGITHUB_ICON\b/)
  assert.doesNotMatch(canonicalIcons, /\bGITHUB_ICON\b|\bGitHubIcon\b/)
  assert.match(brandDefinitions, /export const GITHUB_MARK = defineIcon\(/)
  assert.match(githubMark, /import \{ GITHUB_MARK \} from '\.\/brandDefinitions\.js'/)
  assert.match(githubMark, /<AppIcon icon=\{GITHUB_MARK\}/)
  assert.match(registry, /import GitHubMark from '\.\.\/brand\/GitHubMark\.jsx'/)
  assert.match(registry, /github: GitHubMark/)
})

test('bootstrap loading artwork has an explicit illustration authority outside ordinary icons', () => {
  const boundary = read('./AppBootstrapBoundary.jsx')
  const definitions = read('./illustrations/bootstrapIllustrations.js')
  const component = read('./illustrations/BootstrapLoadingMark.jsx')
  const ordinaryDefinitions = read('./icons/iconDefinitions.js')

  assert.match(boundary, /import BootstrapLoadingMark from '\.\/illustrations\/BootstrapLoadingMark\.jsx'/)
  assert.match(boundary, /<BootstrapLoadingMark className="icon icon--md" \/>/)
  assert.doesNotMatch(boundary, /<svg\b|<path\b/)
  assert.match(definitions, /export const BOOTSTRAP_LOADING_MARK = defineIcon\(/)
  assert.match(component, /import \{ BOOTSTRAP_LOADING_MARK \} from '\.\/bootstrapIllustrations\.js'/)
  assert.match(component, /<AppIcon icon=\{BOOTSTRAP_LOADING_MARK\}/)
  assert.doesNotMatch(ordinaryDefinitions, /\bBOOTSTRAP_LOADING_MARK\b/)
})
