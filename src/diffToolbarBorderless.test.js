import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

function cssBlock(source, selector) {
  const start = source.indexOf(selector)
  assert.notEqual(start, -1, `missing CSS selector: ${selector}`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `missing CSS block open for: ${selector}`)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  assert.fail(`missing CSS block close for: ${selector}`)
}

test('commit diff view switcher removes its perimeter border', () => {
  const splitCss = read('./CommitDiffSplit.css')
  const block = cssBlock(splitCss, '.commit-diff-view-switcher')
  assert.match(block, /border:\s*0;/)
  assert.doesNotMatch(block, /border:\s*1px solid/)
  assert.doesNotMatch(block, /border-color:/)
})

test('commit diff wrap toggle removes its perimeter border and native checkbox skin', () => {
  const renderedCss = read('./CommitDiffRendered.css')
  const block = cssBlock(renderedCss, '.commit-diff-wrap-toggle')
  assert.match(block, /border:\s*0;/)
  assert.doesNotMatch(block, /border:\s*1px solid/)
  assert.doesNotMatch(renderedCss, /\.commit-diff-wrap-toggle input/)
  assert.doesNotMatch(renderedCss, /accent-color/)
})

test('wrap toggle active state does not depend on border color', () => {
  const renderedCss = read('./CommitDiffRendered.css')
  const block = cssBlock(renderedCss, '.commit-diff-wrap-toggle--active')
  assert.doesNotMatch(block, /border-color:/)
  assert.doesNotMatch(block, /border:\s*1px solid/)
  assert.match(block, /background:/)
  assert.match(block, /color:/)
})

test('both diff surfaces share the borderless shared control contract', () => {
  const commitView = read('./CommitDiffView.jsx')
  const workingChangesView = read('./WorkingChangesView.jsx')

  for (const source of [commitView, workingChangesView]) {
    assert.match(source, /className=\{`commit-diff-wrap-toggle/)
    assert.match(source, /commit-diff-view-switcher/)
  }
})
