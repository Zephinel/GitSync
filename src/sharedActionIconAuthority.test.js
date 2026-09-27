import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as iconDefinitionExports from './icons/iconDefinitions.js'
import {
  BRANCH_ICON,
  BRANCH_SWITCH_ICON,
  CHECK_ICON,
  CLOCK_ICON,
  CLOSE_ICON,
  COLLAPSE_ICON,
  COPY_ICON,
  DELETE_ICON,
  EXPAND_ICON,
  MORE_ICON,
  PLUS_ICON,
  REFRESH_SYNC_ICON,
  SEARCH_ICON,
  WARNING_ICON,
  getIconDefinitionSignature,
  isIconDefinition,
} from './icons/iconDefinitions.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const SRC_ROOT = fileURLToPath(new URL('./', import.meta.url))

const IA_T02_NON_UI_ALLOWLIST = Object.freeze([
  // Keep this empty until a non-UI CSS exception exists. Entries must name an
  // exact source file, rule, token, and reason instead of exempting a file.
])

const IA_T02_BANNED_PATTERNS = Object.freeze([
  { label: 'inline SVG data URI', pattern: /data:image\/svg\+xml/i },
  { label: 'SVG URL source', pattern: /url\(\s*["']?[^)]*\.svg(?:[?#][^)]*)?["']?\s*\)/i },
  {
    label: 'SVG mask source',
    pattern: /(?:-webkit-)?mask(?:-image)?\s*:[^;\n]*(?:url\(|data:image\/svg\+xml|\.svg)/i,
  },
  {
    label: 'SVG background source',
    pattern: /background(?:-image)?\s*:[^;\n]*(?:url\(|data:image\/svg\+xml|\.svg)/i,
  },
])

const IA_T02_ALLOWLIST_FIELDS = Object.freeze(['file', 'label', 'reason', 'token'])

const IA_T01_NON_UI_ALLOWLIST = Object.freeze([
  {
    file: 'src/icons/AppIcon.jsx',
    label: 'static SVG root',
    token: '<svg',
    reason: 'AppIcon is the generic React renderer for validated IconDefinition data.',
  },
  {
    file: 'src/icons/iconDom.js',
    label: 'DOM SVG construction',
    token: "documentRef.createElementNS(SVG_NAMESPACE, 'svg')",
    reason: 'iconDom may create only the canonical SVG root from validated IconDefinition data.',
  },
  {
    file: 'src/icons/iconDom.js',
    label: 'DOM SVG construction',
    token: 'documentRef.createElementNS(SVG_NAMESPACE, type)',
    reason: 'iconDom may create only validated IconDefinition element types dynamically.',
  },
  {
    file: 'src/icons/iconDefinitions.js',
    label: 'local path data',
    token: 'd:',
    reason: 'iconDefinitions.js is the ordinary IconDefinition geometry authority.',
  },
  {
    file: 'src/brand/brandDefinitions.js',
    label: 'local path data',
    token: 'd:',
    reason: 'brandDefinitions.js is the separate brand geometry authority.',
  },
  {
    file: 'src/illustrations/bootstrapIllustrations.js',
    label: 'local path data',
    token: 'd:',
    reason: 'bootstrapIllustrations.js is the separate illustration geometry authority.',
  },
])

const IA_T01_DOM_GEOMETRY_ATTRIBUTE_NAMES = Object.freeze([
  'd',
  'points',
  'x',
  'y',
  'width',
  'height',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
])

const IA_T01_DOM_GEOMETRY_ATTRIBUTE_LABEL = 'DOM SVG geometry attribute'

const IA_T01_DOM_GEOMETRY_ATTRIBUTE_PATTERN =
  /\bsetAttribute\(\s*['"](?:d|points|x|y|width|height|cx|cy|r|rx|ry|x1|y1|x2|y2)['"]\s*,|\bsetAttributeNS\(\s*[^,]+,\s*['"](?:d|points|x|y|width|height|cx|cy|r|rx|ry|x1|y1|x2|y2)['"]\s*,/

const IA_T01_BANNED_PATTERNS = Object.freeze([
  { label: 'static SVG root', pattern: /<svg\b/ },
  {
    label: 'static SVG geometry element',
    pattern: /<(?:path|rect|circle|ellipse|line|polyline|polygon)\b/,
  },
  { label: 'raw SVG HTML string', pattern: /["'\x60]\s*<svg\b/ },
  { label: 'DOM SVG construction', pattern: /createElementNS\s*\(/ },
  {
    label: IA_T01_DOM_GEOMETRY_ATTRIBUTE_LABEL,
    pattern: IA_T01_DOM_GEOMETRY_ATTRIBUTE_PATTERN,
  },
  { label: 'local path data', pattern: /\bd\s*:\s*['"\x60]M/ },
  { label: 'SVG asset reference', pattern: /['"\x60][^'"\x60\n]*\.svg(?:[?#][^'"\x60\n]*)?['"\x60]/ },
  { label: 'inline SVG data source', pattern: /data:image\/svg\+xml/i },
  { label: 'raw SVG HTML injection', pattern: /dangerouslySetInnerHTML|innerHTML\s*=/ },
  { label: 'legacy icon path constant', pattern: /\b(?:_ICON_PATH|_SVG_PATH|STANDARD_.*PATH)\b/ },
])

const IA_T01_ALLOWLIST_FIELDS = Object.freeze(['file', 'label', 'reason', 'token'])

function collectCssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) return collectCssFiles(absolutePath)
      return entry.isFile() && entry.name.endsWith('.css') ? [absolutePath] : []
    })
}

function collectProductionSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) return collectProductionSourceFiles(absolutePath)
      if (!entry.isFile() || /\.test\.(?:js|jsx)$/.test(entry.name)) return []
      return /\.(?:js|jsx)$/.test(entry.name) ? [absolutePath] : []
    })
}

function collectTestSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) return collectTestSourceFiles(absolutePath)
      return entry.isFile() && /\.test\.(?:js|jsx)$/.test(entry.name) ? [absolutePath] : []
    })
}

function assertValidIaT01Allowlist(allowlist, productionFiles) {
  const sourceFiles = new Set(productionFiles.map(toSourceRelativePath))
  const bannedLabels = new Set(IA_T01_BANNED_PATTERNS.map(({ label }) => label))

  allowlist.forEach((entry, index) => {
    assert.equal(
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      true,
      'IA-T01 allowlist entry ' + index + ' must be an object',
    )
    assert.deepEqual(
      Object.keys(entry).sort(),
      IA_T01_ALLOWLIST_FIELDS,
      'IA-T01 allowlist entry ' + index + ' must contain only file, label, token, and reason',
    )
    assert.equal(typeof entry.file, 'string', 'IA-T01 allowlist entry ' + index + ' file must be a string')
    assert.notEqual(entry.file.trim(), '', 'IA-T01 allowlist entry ' + index + ' file must be non-empty')
    assert.equal(entry.file, entry.file.trim(), 'IA-T01 allowlist entry ' + index + ' file must not have surrounding whitespace')
    assert.match(entry.file, /^src\/.+\.(?:js|jsx)$/, 'IA-T01 allowlist entry ' + index + ' file must point to src/**/*.js or src/**/*.jsx')
    assert.equal(
      sourceFiles.has(entry.file),
      true,
      'IA-T01 allowlist entry ' + index + ' file must exist in the recursive production source set',
    )
    assert.equal(typeof entry.label, 'string', 'IA-T01 allowlist entry ' + index + ' label must be a string')
    assert.equal(
      bannedLabels.has(entry.label),
      true,
      'IA-T01 allowlist entry ' + index + ' label must match a banned-pattern label',
    )
    assert.equal(typeof entry.token, 'string', 'IA-T01 allowlist entry ' + index + ' token must be a string')
    assert.notEqual(entry.token.trim(), '', 'IA-T01 allowlist entry ' + index + ' token must be non-empty')
    assert.equal(typeof entry.reason, 'string', 'IA-T01 allowlist entry ' + index + ' reason must be a string')
    assert.notEqual(entry.reason.trim(), '', 'IA-T01 allowlist entry ' + index + ' reason must be non-empty')
  })
}

function isAllowlistedIaT01Exception(file, label, line) {
  return IA_T01_NON_UI_ALLOWLIST.some(
    (entry) => entry.file === file && entry.label === label && line.includes(entry.token),
  )
}

function collectIaT01Violations(file, source) {
  const violations = []
  const lines = source.split(/\r?\n/)

  lines.forEach((line, index) => {
    for (const { label, pattern } of IA_T01_BANNED_PATTERNS) {
      if (label === IA_T01_DOM_GEOMETRY_ATTRIBUTE_LABEL) continue
      if (!pattern.test(line) || isAllowlistedIaT01Exception(file, label, line)) continue
      violations.push(file + ':' + (index + 1) + ' [' + label + '] ' + line.trim())
    }
  })

  const domGeometryRule = IA_T01_BANNED_PATTERNS.find(
    ({ label }) => label === IA_T01_DOM_GEOMETRY_ATTRIBUTE_LABEL,
  )
  const domGeometryMatch = domGeometryRule.pattern.exec(source)
  if (domGeometryMatch && !isAllowlistedIaT01Exception(file, domGeometryRule.label, source)) {
    const lineNumber = source.slice(0, domGeometryMatch.index).split(/\r?\n/).length
    violations.push(
      file + ':' + lineNumber + ' [' + domGeometryRule.label + '] source-wide match',
    )
  }

  return violations
}

function escapeRegExpForSource(value) {
  return value.replace(/[.*+?^()|[\]\\{}$]/g, '\\$&')
}

function sourceContainsPathToken(source, path) {
  const escaped = escapeRegExpForSource(path)
  return [
    path,
    escaped,
    escaped.replaceAll('\\', '\\\\'),
  ].some((token) => token && source.includes(token))
}

function splitCanonicalPathSubpaths(path) {
  return path.split(/(?=M[0-9.-])/).filter(Boolean)
}

function sourceContainsCanonicalPathCopy(source, path) {
  if (sourceContainsPathToken(source, path)) return true
  const subpaths = splitCanonicalPathSubpaths(path)
  return subpaths.length > 1 && subpaths.every((subpath) => sourceContainsPathToken(source, subpath))
}

function toSourceRelativePath(filePath) {
  return `src/${relative(SRC_ROOT, filePath).replaceAll('\\', '/')}`
}

function assertValidIaT02Allowlist(allowlist, cssFiles) {
  const sourceCssFiles = new Set(cssFiles.map(toSourceRelativePath))
  const bannedLabels = new Set(IA_T02_BANNED_PATTERNS.map(({ label }) => label))

  allowlist.forEach((entry, index) => {
    assert.equal(
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      true,
      `IA-T02 allowlist entry ${index} must be an object`,
    )
    assert.deepEqual(
      Object.keys(entry).sort(),
      IA_T02_ALLOWLIST_FIELDS,
      `IA-T02 allowlist entry ${index} must contain only file, label, token, and reason`,
    )
    assert.equal(typeof entry.file, 'string', `IA-T02 allowlist entry ${index} file must be a string`)
    assert.notEqual(entry.file.trim(), '', `IA-T02 allowlist entry ${index} file must be non-empty`)
    assert.equal(entry.file, entry.file.trim(), `IA-T02 allowlist entry ${index} file must not have surrounding whitespace`)
    assert.match(entry.file, /^src\/.+\.css$/, `IA-T02 allowlist entry ${index} file must point to src/**/*.css`)
    assert.equal(
      sourceCssFiles.has(entry.file),
      true,
      `IA-T02 allowlist entry ${index} file must exist under src/**/*.css`,
    )
    assert.equal(typeof entry.label, 'string', `IA-T02 allowlist entry ${index} label must be a string`)
    assert.equal(
      bannedLabels.has(entry.label),
      true,
      `IA-T02 allowlist entry ${index} label must match a banned-pattern label`,
    )
    assert.equal(typeof entry.token, 'string', `IA-T02 allowlist entry ${index} token must be a string`)
    assert.notEqual(entry.token.trim(), '', `IA-T02 allowlist entry ${index} token must be non-empty`)
    assert.equal(typeof entry.reason, 'string', `IA-T02 allowlist entry ${index} reason must be a string`)
    assert.notEqual(entry.reason.trim(), '', `IA-T02 allowlist entry ${index} reason must be non-empty`)
  })
}

function isAllowlistedCssException(file, label, line) {
  return IA_T02_NON_UI_ALLOWLIST.some(
    (entry) => entry.file === file && entry.label === label && line.includes(entry.token),
  )
}

const HIGH_DUPLICATION_ICONS = Object.freeze({
  BRANCH_ICON,
  BRANCH_SWITCH_ICON,
  CHECK_ICON,
  CLOCK_ICON,
  CLOSE_ICON,
  COLLAPSE_ICON,
  COPY_ICON,
  DELETE_ICON,
  EXPAND_ICON,
  MORE_ICON,
  PLUS_ICON,
  REFRESH_SYNC_ICON,
  SEARCH_ICON,
  WARNING_ICON,
})

test('high-duplication UI glyphs have one canonical IconDefinition each', () => {
  const entries = Object.entries(HIGH_DUPLICATION_ICONS)
  for (const [name, icon] of entries) {
    assert.equal(isIconDefinition(icon), true, `${name} must be canonical`)
    assert.equal(icon.svg.fill, 'currentColor', `${name} must inherit presentation color`)
    assert.equal(icon.elements.length, 1, `${name} currently resolves to one canonical path`)
    assert.equal(icon.elements[0].type, 'path', `${name} must preserve its selected path geometry`)
  }

  const signatures = entries.map(([, icon]) => getIconDefinitionSignature(icon))
  assert.equal(new Set(signatures).size, signatures.length, 'canonical glyph definitions must not duplicate geometry')
})

test('canonical named components remain geometry-neutral wrappers', () => {
  const components = read('./icons/CanonicalIcons.jsx')

  assert.match(components, /import AppIcon from '\.\/AppIcon\.jsx'/)
  assert.match(components, /function iconComponent\(icon\)/)
  assert.match(components, /return <AppIcon icon=\{icon\}/)
  assert.doesNotMatch(components, /<svg\b|<path\b|<rect\b|<circle\b|data:image\/svg/)
})

test('Stage 6 retires dead icon compatibility owners without removing canonical authorities', () => {
  assert.equal(existsSync(new URL('./RefreshSyncIcon.jsx', import.meta.url)), false)
  assert.equal(existsSync(new URL('./StashIcons.jsx', import.meta.url)), false)

  const canonicalIcons = read('./icons/CanonicalIcons.jsx')
  const directionalChevron = read('./icons/DirectionalChevronIcon.jsx')
  const managerUtils = read('./stash-manager/managerUtils.jsx')
  const legacyReferences = []
  for (const filePath of collectProductionSourceFiles(SRC_ROOT)) {
    const source = readFileSync(filePath, 'utf8')
    for (const legacyName of ['StashIcons.jsx', 'RefreshSyncIcon.jsx']) {
      if (source.includes(legacyName)) legacyReferences.push(`${toSourceRelativePath(filePath)}:${legacyName}`)
    }
  }

  assert.deepEqual(legacyReferences, [])
  assert.match(canonicalIcons, /export const RefreshSyncIcon = iconComponent\(REFRESH_SYNC_ICON\)/)
  assert.match(directionalChevron, /import \{ NavChevronIcon \} from '\.\/CanonicalIcons\.jsx'/)
  assert.match(directionalChevron, /transformOrigin: 'center'/)
  assert.match(directionalChevron, /transformBox: 'view-box'/)
  assert.doesNotMatch(directionalChevron, /defineIcon|<svg\b|<path\b|Stash/)
  assert.doesNotMatch(managerUtils, /StashIcons|export\s*\{[\s\S]*Icon/)
})

test('Stage 4 feature-local icon helpers consume canonical components without local SVG geometry', () => {
  const branchManagement = read('./BranchManagementLayer.jsx')
  const workingChanges = read('./WorkingChangesView.jsx')
  const commitDiff = read('./CommitDiffView.jsx')
  const aiReview = read('./ai/AiReviewLayer.jsx')
  const workingGroups = read('./WorkingChangesFileGroups.jsx')
  const customSelect = read('./CustomSelect.jsx')
  const loadingCard = read('./CommitDiffLoadingCard.jsx')
  const projection = read('./ImageFileGlyphProjection.jsx')
  const bootstrapBoundary = read('./AppBootstrapBoundary.jsx')

  for (const source of [
    branchManagement,
    workingChanges,
    commitDiff,
    aiReview,
    workingGroups,
    customSelect,
    loadingCard,
    bootstrapBoundary,
  ]) {
    assert.doesNotMatch(source, /<svg\b|<path\b/)
  }

  assert.match(branchManagement, /DirectionUpIcon as CanonicalDirectionUpIcon/)
  assert.match(branchManagement, /DirectionDownIcon as CanonicalDirectionDownIcon/)
  assert.match(branchManagement, /DirectionDivergedIcon as CanonicalDirectionDivergedIcon/)
  assert.match(branchManagement, /DirectionSyncedIcon as CanonicalDirectionSyncedIcon/)
  assert.match(branchManagement, /DirectionRemoteIcon as CanonicalDirectionRemoteIcon/)
  assert.match(branchManagement, /const DIRECTION_ICONS = Object\.freeze\(\{/)

  assert.match(workingChanges, /import \{ FILE_GLYPH_ICONS, FILE_GLYPH_KIND, resolveFileGlyphKind \} from '\.\/fileGlyphIcons\.js'/)
  assert.match(workingChanges, /CommitIcon as CanonicalCommitIcon/)
  assert.match(workingChanges, /MinusIcon as CanonicalMinusIcon/)
  assert.match(workingChanges, /SplitViewIcon as CanonicalSplitViewIcon/)
  assert.match(workingChanges, /ListLayoutIcon as CanonicalListLayoutIcon/)

  assert.match(commitDiff, /UserIcon as CanonicalUserIcon/)
  assert.match(commitDiff, /SplitViewIcon as CanonicalSplitViewIcon/)
  assert.match(commitDiff, /ListLayoutIcon as CanonicalListLayoutIcon/)
  assert.match(aiReview, /ReviewIcon as CanonicalReviewIcon/)
  assert.match(workingGroups, /GroupChevronIcon as CanonicalGroupChevronIcon/)
  assert.match(customSelect, /SelectChevronIcon as CanonicalSelectChevronIcon/)
  assert.match(loadingCard, /DiffIcon as CanonicalDiffIcon/)

  assert.match(projection, /import \{ FILE_GLYPH_DEFINITIONS, FILE_GLYPH_KIND, resolveFileGlyphKind \} from '\.\/fileGlyphIcons\.js'/)
  assert.match(projection, /createIconSvgElement\(icon, \{/)
  assert.doesNotMatch(projection, /IMAGE_FILE_GLYPH_SVG|innerHTML\s*=|<svg\b|<path\b/)

  assert.match(bootstrapBoundary, /import BootstrapLoadingMark from '\.\/illustrations\/BootstrapLoadingMark\.jsx'/)
  assert.match(bootstrapBoundary, /<BootstrapLoadingMark className="icon icon--md" \/>/)
})

test('Stage 5 CSS bypasses are owned by canonical React DOM without production masks or asset references', () => {
  const definitions = read('./icons/iconDefinitions.js')
  const canonicalIcons = read('./icons/CanonicalIcons.jsx')
  const branchManagement = read('./BranchManagementLayer.jsx')
  const workingChanges = read('./WorkingChangesView.jsx')
  const app = read('./App.jsx')
  const branchAttention = read('./BranchAttentionDetailLayer.jsx')
  const branchManagementCss = read('./BranchManagementPolish.css')
  const optionCss = read('./SecondaryWindowOptionSurface.css')
  const formCss = read('./FormControlSurface.css')
  const branchSwitchCss = read('./BranchSwitchActionIcon.css')

  assert.match(definitions, /export const BATCH_SELECT_ICON = defineFilledPathIcon\(/)
  assert.match(canonicalIcons, /export const BatchSelectIcon = iconComponent\(BATCH_SELECT_ICON\)/)
  assert.match(branchManagement, /BatchSelectIcon as CanonicalBatchSelectIcon/)
  assert.match(branchManagement, /<CanonicalBatchSelectIcon className="branch-management-batch-toggle__icon" \/>/)
  assert.match(workingChanges, /RefreshSyncIcon as CanonicalRefreshSyncIcon/)
  assert.match(workingChanges, /<CanonicalRefreshSyncIcon className="working-changes-staging-refresh__icon" \/>/)
  assert.match(app, /import BranchSwitchIcon from '\.\/BranchSwitchIcon\.jsx'/)
  assert.match(app, /<BranchSwitchIcon className="repo-card__branch-row-action-icon" \/>/)
  assert.match(branchAttention, /import BranchSwitchIcon from '\.\/BranchSwitchIcon\.jsx'/)
  assert.match(branchAttention, /<BranchSwitchIcon className="branch-attention-detail__primary-action-icon" \/>/)

  const cssSources = [branchManagementCss, optionCss, formCss, branchSwitchCss]
  for (const source of cssSources) {
    assert.doesNotMatch(source, /data:image\/svg\+xml|(?:-webkit-)?mask\s*:/)
  }
  assert.doesNotMatch(branchManagementCss, /\.branch-management-batch-toggle::before|::after/)
  assert.doesNotMatch(formCss, /\.working-changes-staging-refresh::before|::after/)
  assert.doesNotMatch(branchSwitchCss, /::before|::after|branch-switch-icon\.svg/)
  assert.doesNotMatch(`${app}\n${branchAttention}\n${branchSwitchCss}`, /assets\/branch-switch-icon\.svg/)
})

test('IA-T02 recursively enforces production CSS SVG authority with an exact non-UI allowlist', () => {
  const cssFiles = collectCssFiles(SRC_ROOT)
  assertValidIaT02Allowlist(IA_T02_NON_UI_ALLOWLIST, cssFiles)
  assert.ok(cssFiles.length > 0, 'IA-T02 must scan the source CSS tree')
  assert.ok(
    cssFiles.some((filePath) => filePath.endsWith('/BranchManagementPolish.css')),
    'IA-T02 must include feature CSS authorities, not only a hand-picked list',
  )

  const violations = []
  for (const filePath of cssFiles) {
    const file = toSourceRelativePath(filePath)
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)

    lines.forEach((line, index) => {
      for (const { label, pattern } of IA_T02_BANNED_PATTERNS) {
        if (!pattern.test(line) || isAllowlistedCssException(file, label, line)) continue
        violations.push(`${file}:${index + 1} [${label}] ${line.trim()}`)
      }
    })
  }

  assert.deepEqual(violations, [], 'IA-T02 forbids production CSS SVG geometry without an exact allowlist entry')
})

test('IA-T01 recursively enforces production JS and JSX SVG authority with exact exclusions', () => {
  const productionFiles = collectProductionSourceFiles(SRC_ROOT)
  assertValidIaT01Allowlist(IA_T01_NON_UI_ALLOWLIST, productionFiles)
  for (const name of IA_T01_DOM_GEOMETRY_ATTRIBUTE_NAMES) {
    assert.match(
      "element.setAttribute('" + name + "', 'value')",
      IA_T01_DOM_GEOMETRY_ATTRIBUTE_PATTERN,
      'IA-T01 must detect direct DOM geometry attributes',
    )
    assert.match(
      "element.setAttributeNS(null, '" + name + "', 'value')",
      IA_T01_DOM_GEOMETRY_ATTRIBUTE_PATTERN,
      'IA-T01 must detect namespaced DOM geometry attributes using the name argument',
    )
    assert.equal(
      collectIaT01Violations(
        'src/ia-t01-multiline-fixture.js',
        [
          'element.setAttribute(',
          "  '" + name + "',",
          "  'value',",
          ')',
        ].join('\n'),
      ).length,
      1,
      'IA-T01 must detect multiline direct DOM geometry attributes',
    )
    assert.equal(
      collectIaT01Violations(
        'src/ia-t01-multiline-fixture.js',
        [
          'element.setAttributeNS(',
          '  null,',
          "  '" + name + "',",
          "  'value',",
          ')',
        ].join('\n'),
      ).length,
      1,
      'IA-T01 must detect multiline namespaced DOM geometry attributes',
    )
  }
  assert.ok(
    productionFiles.some((filePath) => filePath.endsWith('/ai/AiReviewLayer.jsx')),
    'IA-T01 must recurse into nested production feature directories',
  )
  assert.equal(
    productionFiles.some((filePath) => filePath.endsWith('/sharedActionIconAuthority.test.js')),
    false,
    'IA-T01 must exclude test source files from the production collection',
  )

  const violations = productionFiles.flatMap((filePath) => {
    const file = toSourceRelativePath(filePath)
    return collectIaT01Violations(file, readFileSync(filePath, 'utf8'))
  })

  assert.deepEqual(violations, [], 'IA-T01 forbids ordinary production SVG geometry without an exact authority exclusion')
})

test('IA-T03 recursively rejects canonical product geometry copies in tests', () => {
  const testFiles = collectTestSourceFiles(SRC_ROOT)
  const canonicalPaths = Object.entries(iconDefinitionExports)
    .filter(([, value]) => isIconDefinition(value))
    .flatMap(([name, icon]) => icon.elements
      .filter((element) => element.type === 'path' && typeof element.d === 'string')
      .map((element) => ({ name, path: element.d })))

  assert.ok(testFiles.length > 0, 'IA-T03 must discover recursive test files')
  assert.ok(
    testFiles.some((filePath) => filePath.endsWith('/ai/aiReviewLayer.test.js')),
    'IA-T03 must recurse into nested test directories',
  )
  assert.ok(canonicalPaths.length > 30, 'IA-T03 must derive paths from the ordinary canonical definitions')

  const violations = []
  for (const filePath of testFiles) {
    const file = toSourceRelativePath(filePath)
    const source = readFileSync(filePath, 'utf8')
    for (const { name, path } of canonicalPaths) {
      if (sourceContainsCanonicalPathCopy(source, path)) {
        violations.push(file + ' copies canonical ' + name + ' path geometry')
      }
    }
  }

  assert.deepEqual(violations, [], 'IA-T03 forbids literal, escaped, and split canonical path copies in tests')
})

const IA_T05_CRITICAL_SURFACES = Object.freeze([
  {
    surface: 'App',
    files: ['./App.jsx', './icons/appIconRegistry.js'],
    dependencies: [/APP_ICONS as Icons/, /BranchSwitchIcon/],
  },
  {
    surface: 'Branch Management',
    files: ['./BranchManagementLayer.jsx'],
    dependencies: [/CanonicalIcons\.jsx/, /CanonicalBatchSelectIcon/, /BranchSwitchIcon/],
  },
  {
    surface: 'Working Changes',
    files: ['./WorkingChangesView.jsx'],
    dependencies: [/CanonicalIcons\.jsx/, /CanonicalRefreshSyncIcon/],
  },
  {
    surface: 'Commit Diff',
    files: ['./CommitDiffView.jsx'],
    dependencies: [/CanonicalIcons\.jsx/, /CanonicalCloseIcon/],
  },
  {
    surface: 'Stash',
    files: [
      './stash-manager/StashManagerDialog.jsx',
      './StashManagementPopover.jsx',
      './StashEntryActionMenu.jsx',
      './StashDetailView.jsx',
    ],
    dependencies: [/CanonicalIcons\.jsx/, /(?:CloseIcon|DeleteIcon|RefreshSyncIcon)/],
  },
  {
    surface: 'AI Review',
    files: ['./ai/AiReviewLayer.jsx'],
    dependencies: [/CanonicalIcons\.jsx/, /CanonicalReviewIcon/],
  },
  {
    surface: 'Branch Creation',
    files: ['./BranchCreationDialog.jsx'],
    dependencies: [/CanonicalIcons\.jsx/, /CanonicalCloseIcon/],
  },
  {
    surface: 'Branch Attention',
    files: ['./BranchAttentionDetailLayer.jsx'],
    dependencies: [/CanonicalIcons\.jsx/, /BranchSwitchIcon/],
  },
  {
    surface: 'CustomSelect',
    files: ['./CustomSelect.jsx'],
    dependencies: [/CanonicalIcons\.jsx/, /CanonicalSelectChevronIcon/],
  },
  {
    surface: 'secondary-window icon-only controls',
    files: [
      './WorkingChangesView.jsx',
      './BranchAttentionDetailLayer.jsx',
      './FormControlSurface.css',
    ],
    dependencies: [
      /RefreshSyncIcon as CanonicalRefreshSyncIcon/,
      /<CanonicalRefreshSyncIcon className="working-changes-staging-refresh__icon" \/>/,
      /<RefreshSyncIcon \/>/,
      /\.working-changes-staging-refresh[\s\S]*display:\s*inline-flex !important;/,
      /\.working-changes-staging-refresh[\s\S]*align-items:\s*center !important;/,
      /\.working-changes-staging-refresh[\s\S]*justify-content:\s*center !important;/,
      /\.working-changes-staging-refresh > \.working-changes-staging-refresh__icon \{[\s\S]*display:\s*block;/,
      /\.branch-attention-detail__primary-action--icon-only[\s\S]*display:\s*grid !important;/,
      /\.branch-attention-detail__primary-action--icon-only[\s\S]*place-items:\s*center !important;/,
      /\.branch-attention-detail__primary-action--icon-only svg[\s\S]*width:\s*18px;[\s\S]*height:\s*18px;[\s\S]*display:\s*block;/,
    ],
  },
])

test('IA-T05 critical surfaces depend on canonical/shared icon authority', () => {
  for (const { surface, files, dependencies } of IA_T05_CRITICAL_SURFACES) {
    const sources = files.map((file) => read(file)).join('\n')
    for (const dependency of dependencies) {
      assert.match(sources, dependency, surface + ' must retain its canonical icon dependency')
    }
    assert.doesNotMatch(
      sources,
      /<svg\b|<path\b|<rect\b|<circle\b|<ellipse\b|<line\b|<polyline\b|<polygon\b|data:image\/svg|(?:-webkit-)?mask\s*:|\.svg['")]/,
      surface + ' must not own ordinary SVG geometry or CSS fallback sources',
    )
  }
})

test('canonical RefreshSyncIcon remains the sole refresh compatibility authority after retirement', () => {
  const definitions = read('./icons/iconDefinitions.js')
  const canonical = read('./icons/CanonicalIcons.jsx')

  assert.match(definitions, /export const REFRESH_SYNC_ICON = defineFilledPathIcon\(/)
  assert.match(canonical, /export const RefreshSyncIcon = iconComponent\(REFRESH_SYNC_ICON\)/)
  assert.doesNotMatch(definitions, /REFRESH_SYNC_ICON_/)
})

test('existing Stash surfaces retain their shared component dependency', () => {
  const manager = read('./stash-manager/StashManagerDialog.jsx')
  const popover = read('./StashManagementPopover.jsx')
  const create = read('./stash-create/CreateStashDialog.jsx')
  const actions = read('./StashEntryActionMenu.jsx')
  const detail = read('./StashDetailView.jsx')

  assert.match(manager, /RefreshSyncIcon/)
  assert.match(popover, /RefreshSyncIcon/)
  assert.match(manager, /CloseIcon/)
  assert.match(create, /import \{ CloseIcon \} from '\.\.\/icons\/CanonicalIcons\.jsx'/)
  assert.match(actions, /DeleteIcon/)
  assert.match(detail, /DeleteIcon/)

  const sources = `${manager}\n${popover}\n${create}\n${actions}\n${detail}`
  assert.doesNotMatch(sources, /function RefreshIcon|function DeleteIcon|function CloseIcon/)
})

test('current Branch consumers continue through canonical shared components', () => {
  const branchAttention = read('./BranchAttentionDetailLayer.jsx')
  const branchManagement = read('./BranchManagementLayer.jsx')
  const branchActions = read('./BranchManagementActions.css')
  const commitDiff = read('./CommitDiffView.jsx')

  assert.match(branchAttention, /BranchIcon,[\s\S]*RefreshSyncIcon,[\s\S]*from '\.\/icons\/CanonicalIcons\.jsx'/)
  assert.match(commitDiff, /BranchIcon,[\s\S]*from '\.\/icons\/CanonicalIcons\.jsx'/)
  assert.match(commitDiff, /if \(type === 'branch'\) return <BranchIcon className="commit-diff-meta-icon" \/>/)
  assert.match(branchManagement, /BranchIcon,[\s\S]*from '\.\/icons\/CanonicalIcons\.jsx'/)
  assert.equal((branchManagement.match(/<BranchIcon className="icon icon--sm" \/>/g) || []).length, 2)
  assert.doesNotMatch(branchActions, /data:image\/svg\+xml/)
})

test('Stage 2 feature surfaces route high-duplication glyphs through canonical components', () => {
  const branchManagement = read('./BranchManagementLayer.jsx')
  const branchAttention = read('./BranchAttentionDetailLayer.jsx')
  const branchHover = read('./BranchManagementHoverAction.jsx')
  const branchCreation = read('./BranchCreationDialog.jsx')
  const workingChanges = read('./WorkingChangesView.jsx')
  const commitDiff = read('./CommitDiffView.jsx')
  const aiReview = read('./ai/AiReviewLayer.jsx')
  const branchSwitch = read('./BranchSwitchIcon.jsx')

  assert.match(branchManagement, /import CanonicalCheckbox from '\.\/CanonicalCheckbox\.jsx'/)
  assert.match(branchManagement, /CollapseIcon as CanonicalCollapseIcon/)
  assert.match(branchManagement, /CopyIcon as CanonicalCopyIcon/)
  assert.match(branchManagement, /DeleteIcon as CanonicalDeleteIcon/)
  assert.match(branchManagement, /RefreshSyncIcon as CanonicalRefreshSyncIcon/)
  assert.match(branchManagement, /SearchIcon as CanonicalSearchIcon/)

  assert.match(workingChanges, /import CanonicalCheckbox from '\.\/CanonicalCheckbox\.jsx'/)
  assert.match(workingChanges, /CloseIcon as CanonicalCloseIcon/)
  assert.match(workingChanges, /CollapseIcon as CanonicalCollapseIcon/)
  assert.match(workingChanges, /DeleteIcon as CanonicalDeleteIcon/)
  assert.match(workingChanges, /ExpandIcon as CanonicalExpandIcon/)
  assert.match(workingChanges, /PlusIcon as CanonicalPlusIcon/)

  assert.match(commitDiff, /ClockIcon as CanonicalClockIcon/)
  assert.match(commitDiff, /CloseIcon as CanonicalCloseIcon/)
  assert.match(commitDiff, /CollapseIcon as CanonicalCollapseIcon/)
  assert.match(commitDiff, /CopyIcon as CanonicalCopyIcon/)
  assert.match(commitDiff, /ExpandIcon as CanonicalExpandIcon/)

  assert.match(branchAttention, /CloseIcon as CanonicalCloseIcon/)
  assert.match(branchAttention, /CopyIcon as CanonicalCopyIcon/)
  assert.match(branchAttention, /DeleteIcon as CanonicalDeleteIcon/)
  assert.doesNotMatch(branchAttention, /function (?:CloseIcon|CopyIcon|TrashIcon)\(\) \{[\s\S]{0,180}<svg\b/)

  assert.match(aiReview, /CloseIcon as CanonicalCloseIcon/)
  assert.match(aiReview, /<CanonicalCloseIcon \/>/)
  assert.match(branchCreation, /CloseIcon as CanonicalCloseIcon/)
  assert.match(branchCreation, /<CanonicalCloseIcon \/>/)
  assert.match(branchHover, /import \{ EXPAND_ICON \} from '\.\/icons\/iconDefinitions\.js'/)
  assert.match(branchHover, /<AppIcon icon=\{EXPAND_ICON\}/)
  assert.match(branchSwitch, /import \{ BRANCH_SWITCH_ICON \} from '\.\/icons\/iconDefinitions\.js'/)
  assert.match(branchSwitch, /<AppIcon icon=\{BRANCH_SWITCH_ICON\}/)
})
