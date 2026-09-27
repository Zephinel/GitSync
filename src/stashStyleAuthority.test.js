import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('root entry loads the complete Stash style authority exactly once', () => {
  const main = read('./main.jsx')
  const authority = read('./StashStyleAuthority.css')
  const expected = [
    'StashManagerDialog.css',
    'CreateStashDialog.css',
    'StashScopeResolutionPanel.css',
    'StashManagementPopover.css',
    'StashEntryActionMenu.css',
    'StashDetailView.css',
    'stash-manager/StashManagerLayout.css',
    'stash-manager/StashManagerTable.css',
    'StashFinalPolish.css',
    'StashMicroPolish.css',
    'StashManagementRedesign.css',
    'StashManagerLongList.css',
    'WorkingChangesStashEntry.css',
  ]

  assert.equal((main.match(/import '\.\/StashStyleAuthority\.css'/g) || []).length, 1)
  for (const path of expected) {
    assert.equal((authority.match(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1)
  }
})

test('lazy Stash components cannot own stylesheet load order', () => {
  const components = [
    './WorkingChangesStashEntry.jsx',
    './CreateStashDialog.jsx',
    './stash-create/CreateStashDialog.jsx',
    './stash-create/CreateStashForm.jsx',
    './StashScopeResolutionPanel.jsx',
    './StashManagementPopover.jsx',
    './StashEntryActionMenu.jsx',
    './StashDetailView.jsx',
    './StashManagerDialog.jsx',
    './stash-manager/StashManagerDialog.jsx',
    './stash-manager/StashManagerList.jsx',
    './stash-manager/StashOperationSurfaces.jsx',
    './stash-manager/StashPendingOperations.jsx',
  ]

  for (const component of components) {
    assert.doesNotMatch(read(component), /import ['"][^'"]+\.css['"]/)
  }
})

test('same semantic actions use the canonical Stash icon authority', () => {
  const icons = read('./icons/CanonicalIcons.jsx')
  const directionalChevron = read('./icons/DirectionalChevronIcon.jsx')
  const repoMenu = read('./RepoStashMenuItem.jsx')
  const actionMenu = read('./StashEntryActionMenu.jsx')
  const operationSurfaces = read('./stash-manager/StashOperationSurfaces.jsx')
  const detail = read('./StashDetailView.jsx')
  const scope = read('./StashScopeResolutionPanel.jsx')

  for (const icon of ['StashIcon', 'RefreshSyncIcon', 'CloseIcon', 'DeleteIcon', 'WarningIcon']) {
    assert.match(icons, new RegExp(`export const ${icon} = iconComponent`))
  }
  assert.match(directionalChevron, /NavChevronIcon/)
  assert.match(directionalChevron, /transformOrigin: 'center'/)
  assert.match(directionalChevron, /transformBox: 'view-box'/)
  assert.doesNotMatch(directionalChevron, /transformBox: 'fill-box'/)
  assert.match(repoMenu, /import \{ StashIcon \} from '\.\/icons\/CanonicalIcons\.jsx'/)
  assert.match(actionMenu, /DeleteIcon/)
  assert.match(operationSurfaces, /DeleteIcon/)
  assert.match(detail, /DeleteIcon/)
  assert.match(scope, /WarningIcon/)
  assert.doesNotMatch(repoMenu, /<svg|<path/)
})
