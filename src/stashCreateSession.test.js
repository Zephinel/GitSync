import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createStashCreateSession,
  stashCreateSessionMatchesContext,
} from './stashCreateSession.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('create session freezes repository, selection and refresh callback at open time', () => {
  const file = { path: 'src/a.js', indexCode: ' ', worktreeCode: 'M' }
  const onChanged = () => {}
  const session = createStashCreateSession({
    openId: 7,
    repoPath: ' /repo-a ',
    repoName: ' Repo A ',
    files: [file],
    onChanged,
  })

  file.path = 'src/changed.js'

  assert.equal(session.openId, 7)
  assert.equal(session.repoPath, '/repo-a')
  assert.equal(session.repoName, 'Repo A')
  assert.equal(session.files[0].path, 'src/a.js')
  assert.equal(session.onChanged, onChanged)
  assert.equal(Object.isFrozen(session), true)
  assert.equal(Object.isFrozen(session.files), true)
  assert.equal(Object.isFrozen(session.files[0]), true)
})

test('create session closes when its repository or visible context changes', () => {
  const session = createStashCreateSession({
    openId: 1,
    repoPath: '/repo-a',
    files: [],
  })

  assert.equal(stashCreateSessionMatchesContext(session, {
    repoPath: '/repo-a',
    visible: true,
  }), true)
  assert.equal(stashCreateSessionMatchesContext(session, {
    repoPath: '/repo-b',
    visible: true,
  }), false)
  assert.equal(stashCreateSessionMatchesContext(session, {
    repoPath: '/repo-a',
    visible: false,
  }), false)
})

test('Working Changes passes only immutable session data to the create dialog', () => {
  const entry = read('./WorkingChangesStashEntry.jsx')

  assert.match(entry, /const \[createSession, setCreateSession\] = useState\(null\)/)
  assert.match(entry, /const \[createPresent, setCreatePresent\] = useState\(false\)/)
  assert.match(entry, /createStashCreateSession\(\{/)
  assert.match(entry, /stashCreateSessionMatchesContext\(createSession, \{ repoPath, visible \}\)/)
  assert.match(entry, /setCreatePresent\(false\)/)
  assert.match(entry, /key=\{createSession\.openId\}/)
  assert.match(entry, /repoPath=\{createSession\.repoPath\}/)
  assert.match(entry, /files=\{createSession\.files\}/)
  assert.match(entry, /present=\{createPresent\}/)
  assert.match(entry, /onExitComplete=\{\(\) => setCreateSession\(null\)\}/)
  assert.match(entry, /onChanged=\{createSession\.onChanged\}/)
  assert.doesNotMatch(entry, /const \[createOpen, setCreateOpen\]/)
  assert.doesNotMatch(entry, /files=\{files\}[\s\S]*<CreateStashDialog/)
})
