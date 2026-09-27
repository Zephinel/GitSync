import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBinaryFileDiff, diffInlineTokens, parsePatchRows, parseSplitPatchRows } from './commitDiffUtils.js'
import { getImageDiffExtension, getImageDiffSupportedExtensions, isImageDiffCandidate } from './imageDiffUtils.js'

test('parsePatchRows parses hunk, context, deletion, addition, and note rows', () => {
  const rows = parsePatchRows([
    'diff --git a/file.txt b/file.txt',
    '@@ -2,3 +2,4 @@',
    ' unchanged',
    '-old line',
    '+new line',
    '\\ No newline at end of file',
    '',
  ].join('\n'))

  assert.deepEqual(
    rows.map((row) => [row.type, row.oldNumber, row.newNumber, row.text]),
    [
      ['hunk', '', '', '@@ -2,3 +2,4 @@'],
      ['context', '2', '2', ' unchanged'],
      ['del', '3', '', '-old line'],
      ['add', '', '3', '+new line'],
      ['note', '', '', '\\ No newline at end of file'],
    ]
  )
})

test('parseSplitPatchRows pairs delete/add blocks and keeps blanks for uneven changes', () => {
  const rows = parseSplitPatchRows([
    'diff --git a/file.txt b/file.txt',
    '@@ -10,5 +10,3 @@',
    ' keep me',
    '-old one',
    '-old two',
    '-old three',
    '+new one',
    '\\ No newline at end of file',
    '',
  ].join('\n'))

  assert.deepEqual(
    rows.map((row) => [row.type, row.oldNumber, row.newNumber, row.oldText, row.newText, row.oldType, row.newType]),
    [
      ['hunk', '', '', '@@ -10,5 +10,3 @@', '@@ -10,5 +10,3 @@', undefined, undefined],
      ['context', '10', '10', 'keep me', 'keep me', 'context', 'context'],
      ['pair', '11', '11', 'old one', 'new one', 'del', 'add'],
      ['del', '12', '', 'old two', '', 'del', 'blank'],
      ['del', '13', '', 'old three', '', 'del', 'blank'],
      ['note', '', '', '\\ No newline at end of file', '\\ No newline at end of file', undefined, undefined],
    ]
  )
})

test('parseSplitPatchRows returns no rows for empty or header-only patches', () => {
  assert.deepEqual(parseSplitPatchRows(''), [])
  assert.deepEqual(parseSplitPatchRows('diff --git a/file.txt b/file.txt\nindex 1..2 100644'), [])
})

test('parseSplitPatchRows renders add-only hunks with blank old cells', () => {
  const rows = parseSplitPatchRows([
    '@@ -0,0 +1,2 @@',
    '+new one',
    '+new two',
    '',
  ].join('\n'))

  assert.deepEqual(
    rows.map((row) => [row.type, row.oldNumber, row.newNumber, row.oldText, row.newText, row.oldType, row.newType]),
    [
      ['hunk', '', '', '@@ -0,0 +1,2 @@', '@@ -0,0 +1,2 @@', undefined, undefined],
      ['add', '', '1', '', 'new one', 'blank', 'add'],
      ['add', '', '2', '', 'new two', 'blank', 'add'],
    ]
  )
})

test('parseSplitPatchRows renders delete-only hunks with blank new cells', () => {
  const rows = parseSplitPatchRows([
    '@@ -4,2 +4,0 @@',
    '-old one',
    '-old two',
    '',
  ].join('\n'))

  assert.deepEqual(
    rows.map((row) => [row.type, row.oldNumber, row.newNumber, row.oldText, row.newText, row.oldType, row.newType]),
    [
      ['hunk', '', '', '@@ -4,2 +4,0 @@', '@@ -4,2 +4,0 @@', undefined, undefined],
      ['del', '4', '', 'old one', '', 'del', 'blank'],
      ['del', '5', '', 'old two', '', 'del', 'blank'],
    ]
  )
})

test('parseSplitPatchRows renders context-only hunks with matching old and new cells', () => {
  const rows = parseSplitPatchRows([
    '@@ -5,2 +5,2 @@',
    ' keep one',
    ' keep two',
    '',
  ].join('\n'))

  assert.deepEqual(
    rows.map((row) => [row.type, row.oldNumber, row.newNumber, row.oldText, row.newText, row.oldType, row.newType]),
    [
      ['hunk', '', '', '@@ -5,2 +5,2 @@', '@@ -5,2 +5,2 @@', undefined, undefined],
      ['context', '5', '5', 'keep one', 'keep one', 'context', 'context'],
      ['context', '6', '6', 'keep two', 'keep two', 'context', 'context'],
    ]
  )
})

test('parseSplitPatchRows flushes pending changes before no-newline notes', () => {
  const rows = parseSplitPatchRows([
    '@@ -1,1 +1,1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '',
  ].join('\n'))

  assert.deepEqual(
    rows.map((row) => [row.type, row.oldNumber, row.newNumber, row.oldText, row.newText, row.oldType, row.newType]),
    [
      ['hunk', '', '', '@@ -1,1 +1,1 @@', '@@ -1,1 +1,1 @@', undefined, undefined],
      ['del', '1', '', 'old', '', 'del', 'blank'],
      ['note', '', '', '\\ No newline at end of file', '\\ No newline at end of file', undefined, undefined],
      ['add', '', '1', '', 'new', 'blank', 'add'],
    ]
  )
})

test('parseSplitPatchRows does not leak pending changes across hunks', () => {
  const rows = parseSplitPatchRows([
    '@@ -1,1 +1,0 @@',
    '-old',
    '@@ -8,0 +7,1 @@',
    '+new',
    '',
  ].join('\n'))

  assert.deepEqual(
    rows.map((row) => [row.type, row.oldNumber, row.newNumber, row.oldText, row.newText, row.oldType, row.newType]),
    [
      ['hunk', '', '', '@@ -1,1 +1,0 @@', '@@ -1,1 +1,0 @@', undefined, undefined],
      ['del', '1', '', 'old', '', 'del', 'blank'],
      ['hunk', '', '', '@@ -8,0 +7,1 @@', '@@ -8,0 +7,1 @@', undefined, undefined],
      ['add', '', '7', '', 'new', 'blank', 'add'],
    ]
  )
})

test('parseSplitPatchRows keeps extra additions as blank old cells in uneven groups', () => {
  const rows = parseSplitPatchRows([
    '@@ -1,1 +1,3 @@',
    '-old',
    '+new one',
    '+new two',
    '+new three',
    '',
  ].join('\n'))

  assert.deepEqual(
    rows.map((row) => [row.type, row.oldNumber, row.newNumber, row.oldText, row.newText, row.oldType, row.newType]),
    [
      ['hunk', '', '', '@@ -1,1 +1,3 @@', '@@ -1,1 +1,3 @@', undefined, undefined],
      ['pair', '1', '1', 'old', 'new one', 'del', 'add'],
      ['add', '', '2', '', 'new two', 'blank', 'add'],
      ['add', '', '3', '', 'new three', 'blank', 'add'],
    ]
  )
})

test('diffInlineTokens marks only changed non-whitespace tokens', () => {
  const result = diffInlineTokens('const size = 38', 'const size = 44')

  assert.deepEqual(
    result.oldTokens.map((token) => [token.text, token.type]),
    [['const', 'same'], [' ', 'same'], ['size', 'same'], [' ', 'same'], ['=', 'same'], [' ', 'same'], ['38', 'removed']]
  )
  assert.deepEqual(
    result.newTokens.map((token) => [token.text, token.type]),
    [['const', 'same'], [' ', 'same'], ['size', 'same'], [' ', 'same'], ['=', 'same'], [' ', 'same'], ['44', 'added']]
  )
})

test('buildBinaryFileDiff preserves the resolved full commit hash', () => {
  const fullHash = '1234567890abcdef1234567890abcdef12345678'
  const diff = buildBinaryFileDiff(
    {
      path: 'assets/logo.png',
      old_path: 'assets/old-logo.png',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    },
    { commitHash: '1234567', fullHash }
  )

  assert.equal(diff.hash, '1234567')
  assert.equal(diff.full_hash, fullHash)
  assert.equal(diff.path, 'assets/logo.png')
  assert.equal(diff.old_path, 'assets/old-logo.png')
  assert.equal(diff.is_binary, true)
  assert.equal(diff.patch, '')
})

test('image diff candidate classification covers binary, vector, and extended image paths', () => {
  assert.equal(getImageDiffExtension('src/icons/logo.SVG'), 'svg')
  assert.equal(getImageDiffExtension('src\\icons\\photo.JPEG'), 'jpeg')
  assert.equal(isImageDiffCandidate({ path: 'src/icons/logo.svg', is_binary: false }), true)
  assert.equal(isImageDiffCandidate({ path: 'assets/photo.heic', is_binary: false }), true)
  assert.equal(isImageDiffCandidate({ path: 'assets/icon.png.bak', is_binary: true }), true)
  assert.equal(isImageDiffCandidate({ path: 'src/index.js', is_binary: false }), false)
  const extensions = getImageDiffSupportedExtensions()
  assert.ok(extensions.includes('png'))
  assert.ok(extensions.includes('svg'))
  assert.ok(extensions.includes('heic'))
  assert.ok(extensions.includes('exr'))
  assert.ok(extensions.includes('qoi'))
})
