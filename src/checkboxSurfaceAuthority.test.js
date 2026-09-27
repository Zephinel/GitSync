import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('canonical checkbox is a single shared square-checkbox implementation', () => {
  const component = read('./CanonicalCheckbox.jsx')
  const css = read('./CanonicalCheckbox.css')

  assert.match(component, /import \{ CheckIcon as CanonicalCheckIcon \} from '\.\/icons\/CanonicalIcons\.jsx'/)
  assert.match(component, /<input\s+type="checkbox"/)
  assert.match(component, /className="canonical-checkbox__box"/)
  assert.match(component, /aria-hidden="true"/)
  assert.match(component, /CanonicalCheckIcon/)
  assert.match(css, /\.canonical-checkbox__box\s*\{[\s\S]*width:\s*16px;[\s\S]*height:\s*16px;/)
  assert.match(css, /\.canonical-checkbox__box\s*\{[\s\S]*border-radius:\s*5px;/)
  assert.match(css, /\.canonical-checkbox input:checked \+ \.canonical-checkbox__box\s*\{[\s\S]*background:\s*var\(--accent-blue\);/)
  assert.match(css, /\.canonical-checkbox input:focus-visible \+ \.canonical-checkbox__box/)
  assert.match(css, /\.canonical-checkbox--disabled/)
})

test('all square-checkbox surfaces consume CanonicalCheckbox', () => {
  const surfaces = {
    workingChanges: read('./WorkingChangesView.jsx'),
    commitDiff: read('./CommitDiffView.jsx'),
    createStash: read('./stash-create/CreateStashForm.jsx'),
    branchAttention: read('./BranchAttentionDetailLayer.jsx'),
    branchManagement: read('./BranchManagementLayer.jsx'),
    branchCreation: read('./BranchCreationDialog.jsx'),
    app: read('./App.jsx'),
  }

  for (const [name, source] of Object.entries(surfaces)) {
    assert.match(source, /CanonicalCheckbox/, `${name} must consume CanonicalCheckbox`)
  }
  assert.match(surfaces.workingChanges, /className="working-changes-checkbox"/)
  assert.match(surfaces.workingChanges, /className=\{`commit-diff-wrap-toggle/)
  assert.match(surfaces.commitDiff, /className=\{`commit-diff-wrap-toggle/)
  assert.match(surfaces.createStash, /className="create-stash-option"/)
  assert.match(surfaces.branchAttention, /className="branch-attention-detail__delete-option"/)
  assert.match(surfaces.branchManagement, /className="branch-management-checkbox"/)
  assert.match(surfaces.branchCreation, /className="branch-creation-consent"/)
  assert.match(surfaces.app, /<CanonicalCheckbox/)
})

test('no production CSS keeps a second square-checkbox visual authority', () => {
  const legacySelectors = [
    /\.working-changes-checkbox__box/,
    /\.branch-management-checkbox__box/,
    /\.branch-delete-dialog__checkbox-input/,
    /\.branch-delete-dialog__checkbox-box/,
    /\.branch-creation-consent input/,
    /\.commit-diff-wrap-toggle input/,
    /\.create-stash-options label input/,
    /\.branch-attention-detail__delete-option input/,
  ]
  const productionCss = [
    read('./WorkingChangesView.css'),
    read('./WorkingChangesFileCell.css'),
    read('./BranchManagementLayer.css'),
    read('./BranchCreationDialog.css'),
    read('./CommitDiffRendered.css'),
    read('./CreateStashDialog.css'),
    read('./BranchAttentionDetailDelete.css'),
    read('./App.css'),
  ].join('\n')

  for (const pattern of legacySelectors) {
    assert.doesNotMatch(productionCss, pattern, `legacy square-checkbox authority still present: ${pattern}`)
  }
})

test('Branch Creation toggle remains a switch and is not migrated to a square checkbox', () => {
  const source = read('./BranchCreationDialog.jsx')
  const css = read('./BranchCreationDialog.css')

  assert.match(source, /function Toggle\(/)
  assert.match(source, /branch-creation-toggle__track/)
  assert.match(css, /\.branch-creation-toggle__track\s*\{[\s\S]*width:\s*34px;[\s\S]*height:\s*19px;[\s\S]*border-radius:\s*999px;/)
  assert.match(css, /\.branch-creation-toggle > input:checked \+ \.branch-creation-toggle__track/)
  assert.doesNotMatch(source, /<CanonicalCheckbox[\s\S]*branch-creation-toggle/)
})
