import { splitGitRepoPath } from './gitPathIdentity.js'
import { isImageDiffPath } from './imageDiffUtils.js'
import { CODE_FILE_ICON, FILE_ICON, IMAGE_FILE_ICON, MARKDOWN_ICON } from './icons/iconDefinitions.js'
import { CodeFileIcon, FileIcon, ImageFileIcon, MarkdownIcon } from './icons/CanonicalIcons.jsx'

/*
 * Single authority for file-type glyphs in file lists (Working Changes and
 * Commit Diff). One extension-to-kind mapping and one icon mapping; feature
 * views only resolve a kind and render the matching canonical icon.
 */

export const FILE_GLYPH_KIND = Object.freeze({
  file: 'file',
  markdown: 'markdown',
  code: 'code',
  image: 'image',
})

export const FILE_GLYPH_ICONS = Object.freeze({
  [FILE_GLYPH_KIND.file]: FileIcon,
  [FILE_GLYPH_KIND.markdown]: MarkdownIcon,
  [FILE_GLYPH_KIND.code]: CodeFileIcon,
  [FILE_GLYPH_KIND.image]: ImageFileIcon,
})

export const FILE_GLYPH_DEFINITIONS = Object.freeze({
  [FILE_GLYPH_KIND.file]: FILE_ICON,
  [FILE_GLYPH_KIND.markdown]: MARKDOWN_ICON,
  [FILE_GLYPH_KIND.code]: CODE_FILE_ICON,
  [FILE_GLYPH_KIND.image]: IMAGE_FILE_ICON,
})

const MARKDOWN_FILE_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])

const CODE_FILE_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'css', 'scss', 'sass', 'less', 'json',
  'rs', 'py', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hh', 'hpp', 'cs', 'rb', 'php',
  'sh', 'bash', 'zsh', 'ksh', 'fish', 'yml', 'yaml', 'toml', 'xml', 'html', 'htm',
  'vue', 'svelte', 'swift', 'kt', 'kts', 'sql', 'lua', 'r', 'dart', 'zig',
  'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'ml', 'fs', 'fsx', 'pl', 'pm',
  'jl', 'gradle', 'groovy', 'ini', 'conf', 'cfg',
])

export function resolveFileGlyphKind(path) {
  if (isImageDiffPath(path)) return FILE_GLYPH_KIND.image
  const { fileName } = splitGitRepoPath(path)
  const lower = String(fileName || '').toLowerCase()
  const dot = lower.lastIndexOf('.')
  const extension = dot >= 0 ? lower.slice(dot + 1) : ''
  if (MARKDOWN_FILE_EXTENSIONS.has(extension)) return FILE_GLYPH_KIND.markdown
  if (CODE_FILE_EXTENSIONS.has(extension)) return FILE_GLYPH_KIND.code
  return FILE_GLYPH_KIND.file
}
