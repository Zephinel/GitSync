import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  FILE_GLYPH_DEFINITIONS,
  FILE_GLYPH_ICONS,
  FILE_GLYPH_KIND,
  resolveFileGlyphKind,
} from './fileGlyphIcons.js'
import { CODE_FILE_ICON, FILE_ICON, IMAGE_FILE_ICON, MARKDOWN_ICON } from './icons/iconDefinitions.js'
import { isIconDefinition } from './icons/iconDefinitions.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('file glyph kinds resolve through one extension authority', () => {
  assert.equal(resolveFileGlyphKind('src/notes.md'), FILE_GLYPH_KIND.markdown)
  assert.equal(resolveFileGlyphKind('README.MD'), FILE_GLYPH_KIND.markdown)
  assert.equal(resolveFileGlyphKind('docs/guide.markdown'), FILE_GLYPH_KIND.markdown)
  assert.equal(resolveFileGlyphKind('src/app.js'), FILE_GLYPH_KIND.code)
  assert.equal(resolveFileGlyphKind('src/app.jsx'), FILE_GLYPH_KIND.code)
  assert.equal(resolveFileGlyphKind('src/main.rs'), FILE_GLYPH_KIND.code)
  assert.equal(resolveFileGlyphKind('package.json'), FILE_GLYPH_KIND.code)
  assert.equal(resolveFileGlyphKind('src/style.css'), FILE_GLYPH_KIND.code)
  assert.equal(resolveFileGlyphKind('a.txt'), FILE_GLYPH_KIND.file)
  assert.equal(resolveFileGlyphKind('assets/unknown.bin'), FILE_GLYPH_KIND.file)
  assert.equal(resolveFileGlyphKind('src/photo.PNG'), FILE_GLYPH_KIND.image)
  assert.equal(resolveFileGlyphKind('nested/dir/icon.svg.bak'), FILE_GLYPH_KIND.image)
  assert.equal(resolveFileGlyphKind('no-extension'), FILE_GLYPH_KIND.file)
})

test('file glyph constants map every kind to one canonical icon definition', () => {
  assert.deepEqual(Object.keys(FILE_GLYPH_KIND).sort(), ['code', 'file', 'image', 'markdown'])
  assert.equal(FILE_GLYPH_DEFINITIONS[FILE_GLYPH_KIND.file], FILE_ICON)
  assert.equal(FILE_GLYPH_DEFINITIONS[FILE_GLYPH_KIND.markdown], MARKDOWN_ICON)
  assert.equal(FILE_GLYPH_DEFINITIONS[FILE_GLYPH_KIND.code], CODE_FILE_ICON)
  assert.equal(FILE_GLYPH_DEFINITIONS[FILE_GLYPH_KIND.image], IMAGE_FILE_ICON)
  for (const definition of Object.values(FILE_GLYPH_DEFINITIONS)) {
    assert.equal(isIconDefinition(definition), true)
  }
  for (const component of Object.values(FILE_GLYPH_ICONS)) {
    assert.equal(typeof component, 'function')
  }
})

test('both file lists consume the shared glyph authority without local mappings', () => {
  const workingChanges = read('./WorkingChangesView.jsx')
  const commitDiff = read('./CommitDiffView.jsx')

  for (const source of [workingChanges, commitDiff]) {
    assert.match(source, /import \{ FILE_GLYPH_ICONS, FILE_GLYPH_KIND, resolveFileGlyphKind \} from '\.\/fileGlyphIcons\.js'/)
    assert.match(source, /const GlyphIcon = FILE_GLYPH_ICONS\[kind\]/)
    assert.doesNotMatch(source, /getFileGlyphLabel/)
    assert.doesNotMatch(source, /□/)
  }
  assert.match(workingChanges, /data-image-file-glyph=\{kind === FILE_GLYPH_KIND\.image \? 'true' : undefined\}/)
  assert.match(commitDiff, /data-image-file-glyph=\{kind === FILE_GLYPH_KIND\.image \? 'true' : undefined\}/)
})
