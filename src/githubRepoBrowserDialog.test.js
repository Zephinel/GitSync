import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./GithubRepoBrowserDialog.jsx', import.meta.url), 'utf8')

function sourceBetween(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `missing start marker: ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `missing end marker: ${endNeedle}`)
  return source.slice(start, end)
}

const RUN_STATE_SETTERS = ['setCloneProgress({})', 'setCloneTargets([])', 'setBatchResult(null)', 'setCloneError(\'\')']

test('clone run state has one reset authority', () => {
  const resetCloneRun = sourceBetween(
    'const resetCloneRun = useCallback(() => {',
    '}, [])'
  )
  for (const setter of RUN_STATE_SETTERS) {
    assert.ok(
      resetCloneRun.includes(setter),
      `resetCloneRun must clear all run state, missing ${setter}`
    )
  }
})

test('every end-of-run site delegates to the reset authority instead of clearing a subset', () => {
  const sites = {
    'filter/sort reset': sourceBetween(
      'const queryKey = `${visibilityFilter}:${sortValue}`',
      'void loadReposPage(1, true)'
    ),
    'target selection change': sourceBetween(
      'const toggleSelect = (repo) => {',
      'const pickClonePath ='
    ),
    'clone panel open': sourceBetween(
      'const openClonePanel = () => {',
      'const openRemoteRepo ='
    ),
  }

  for (const [label, body] of Object.entries(sites)) {
    assert.match(body, /resetCloneRun\(\)/, `${label} must call resetCloneRun()`)
    for (const setter of RUN_STATE_SETTERS) {
      assert.ok(
        !body.includes(setter),
        `${label} must not clear run state piecemeal (${setter})`
      )
    }
  }
})

test('the panel still reads the per-repo outcome to label 失败', () => {
  assert.match(source, /cloneProgress\[repo\.id\]|cloneProgress\[repo\?\.id\]/)
  assert.match(source, /getCloneProgressLabel/)
  assert.match(source, /失败/)
})
