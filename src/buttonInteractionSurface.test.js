import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('root entry loads neutral button interaction before final secondary-window authorities', () => {
  const main = read('./main.jsx')
  const baseImport = "import './ActionButtonSurface.css'"
  const settingsImport = "import './SettingsControlSurface.css'"
  const viewportImport = "import './SecondaryWindowViewport.css'"
  const interactionImport = "import './ButtonInteractionSurface.css'"
  const chromeImport = "import './SecondaryWindowChrome.css'"
  const optionImport = "import './SecondaryWindowOptionSurface.css'"
  const formImport = "import './FormControlSurface.css'"

  assert.equal((main.match(/import '\.\/ButtonInteractionSurface\.css'/g) || []).length, 1)
  assert.equal((main.match(/import '\.\/SecondaryWindowChrome\.css'/g) || []).length, 1)
  assert.equal((main.match(/import '\.\/SecondaryWindowOptionSurface\.css'/g) || []).length, 1)
  assert.equal((main.match(/import '\.\/FormControlSurface\.css'/g) || []).length, 1)
  assert.ok(main.indexOf(interactionImport) > main.indexOf(baseImport))
  assert.ok(main.indexOf(interactionImport) > main.indexOf(settingsImport))
  assert.ok(main.indexOf(interactionImport) > main.indexOf(viewportImport))
  assert.ok(main.indexOf(chromeImport) > main.indexOf(interactionImport))
  assert.ok(main.indexOf(optionImport) > main.indexOf(chromeImport))
  assert.ok(main.indexOf(formImport) > main.indexOf(optionImport))
})

test('registered action buttons use shared hover motion without reintroducing outline effects', () => {
  const interaction = read('./ButtonInteractionSurface.css')

  assert.match(interaction, /body:has\(#root\) button\s*\{/)
  assert.match(interaction, /--app-action-hover-shadow:\s*var\(--app-action-surface-hover-shadow\) !important;/)
  assert.match(interaction, /--app-action-hover-transform:\s*translateY\(-1px\) !important;/)
  assert.match(interaction, /--app-action-pressed-transform:\s*translateY\(0\) scale\(0\.985\) !important;/)
  assert.doesNotMatch(interaction, /--app-action-hover-color:/)
  assert.doesNotMatch(interaction, /--app-action-hover-background:/)
  assert.doesNotMatch(interaction, /inset 0 0 0 1px/)
  assert.doesNotMatch(interaction, /accent-blue/)
  assert.doesNotMatch(interaction, /transition:\s*all/)
})

test('semantic button colors remain owned by the base action-button authority', () => {
  const base = read('./ActionButtonSurface.css')
  const interaction = read('./ButtonInteractionSurface.css')

  assert.match(base, /--app-action-color:\s*var\(--accent-blue\);/)
  assert.match(base, /--app-action-color:\s*var\(--status-error\);/)
  assert.match(base, /--app-action-color:\s*var\(--status-warning\);/)
  assert.match(base, /--app-action-color:\s*var\(--status-success\);/)
  assert.doesNotMatch(interaction, /--app-action-color:/)
})

test('keyboard focus remains accessible and separate from pointer hover styling', () => {
  const base = read('./ActionButtonSurface.css')
  const interaction = read('./ButtonInteractionSurface.css')

  assert.match(base, /--app-action-focus-shadow:[\s\S]*var\(--accent-blue\)/)
  assert.match(base, /:focus-visible/)
  assert.doesNotMatch(interaction, /:focus-visible/)
})

test('secondary-window chrome uses compact spacing and borderless neutral shells', () => {
  const chrome = read('./SecondaryWindowChrome.css')

  assert.doesNotMatch(chrome, /@import '\.\/SecondaryWindowOptionSurface\.css';/)
  assert.match(chrome, /--secondary-window-header-action-gap:\s*12px;/)
  assert.doesNotMatch(chrome, /--secondary-window-header-action-gap:\s*16px;/)
  assert.match(chrome, /\.commit-diff-brand-mark/)
  assert.match(chrome, /\.commit-diff-preload-card__icon/)
  assert.match(chrome, /\.branch-attention-detail__delete-icon/)
  assert.match(chrome, /\.stash-manager-search-field/)
  assert.match(chrome, /\.stash-manager-sort-select \.custom-select__trigger/)
  assert.match(chrome, /\.branch-management-summary \.branch-management-view-toggle/)
  assert.match(chrome, /box-shadow:\s*none !important;/)
})

test('CustomSelect panels stay white in light mode and every option uses the same symmetric inset', () => {
  const options = read('./SecondaryWindowOptionSurface.css')

  assert.match(options, /html\[data-theme="light"\][\s\S]*\.custom-select__menu[\s\S]*background:\s*#fff !important;/)
  assert.match(options, /\.custom-select__menu[\s\S]*padding-inline:\s*0 !important;/)
  assert.match(options, /\.custom-select__menu[\s\S]*scrollbar-gutter:\s*auto !important;/)
  assert.match(options, /\.custom-select__options[\s\S]*scrollbar-gutter:\s*auto !important;/)
  assert.match(options, /\.custom-select__option[\s\S]*width:\s*calc\(100% - 12px\) !important;/)
  assert.match(options, /\.custom-select__option[\s\S]*margin-inline:\s*6px !important;/)
  assert.match(options, /\.custom-select__option[\s\S]*border:\s*0 !important;/)
  assert.match(options, /\.custom-select__option-label[\s\S]*white-space:\s*normal !important;/)
})

test('all CustomSelect menus share the Dashboard hover and selected colors', () => {
  const options = read('./SecondaryWindowOptionSurface.css')

  assert.match(
    options,
    /body:has\(#root\) \.custom-select__option:hover:not\(\.custom-select__option--active\)[\s\S]*?color:\s*var\(--text-primary\) !important;[\s\S]*?background:\s*color-mix\(in srgb, var\(--text-primary\) 8%, var\(--bg-elevated\) 92%\) !important;/
  )
  assert.match(
    options,
    /body:has\(#root\) \.custom-select__option--active,[\s\S]*?body:has\(#root\) \.custom-select__option--active:hover[\s\S]*?color:\s*var\(--accent-blue\) !important;[\s\S]*?background:\s*color-mix\(in srgb, var\(--accent-blue\) 24%, var\(--bg-elevated\) 76%\) !important;/
  )
})

test('Dashboard summary uses shared CustomSelect controls for filter and global sort', () => {
  const app = read('./App.jsx')
  const statusUtils = read('./repoStatusUtils.js')
  const appCss = read('./App.css')
  const options = read('./SecondaryWindowOptionSurface.css')

  assert.match(app, /import SharedCustomSelect from '\.\/CustomSelect\.jsx'/)
  assert.match(app, /<SharedCustomSelect[\s\S]*dashboard-toolbar__filter-select/)
  assert.match(app, /<SharedCustomSelect[\s\S]*dashboard-toolbar__sort-select/)
  assert.match(app, /dashboardRepoFilter/)
  assert.match(app, /dashboardRepoSortMode/)
  assert.match(app, /dashboard-repo-summary/)
  assert.doesNotMatch(app, /<h1 className="dashboard__title">仓库管理<\/h1>/)
  assert.doesNotMatch(app, /dashboard-group__header/)
  assert.match(app, /DASHBOARD_REPO_SORT_MODE\.nameAsc/)
  assert.match(app, /DASHBOARD_REPO_SORT_MODE\.nameDesc/)
  assert.match(app, /DASHBOARD_REPO_SORT_MODE\.commitAsc/)
  assert.match(app, /DASHBOARD_REPO_SORT_MODE\.commitDesc/)
  assert.match(app, /DASHBOARD_REPO_SORT_MODE\.syncAsc/)
  assert.match(app, /DASHBOARD_REPO_SORT_MODE\.syncDesc/)
  assert.match(statusUtils, /compareReposByDashboardSortOrder/)
  assert.match(appCss, /\.dashboard-toolbar__field\s*\{[\s\S]*?display:\s*inline-flex;/)
  assert.match(appCss, /\.dashboard-toolbar__filter-select\s*\{\s*width:\s*164px;\s*flex:\s*0 1 164px;/)
  assert.match(appCss, /\.dashboard-toolbar__sort-select\s*\{\s*width:\s*140px;\s*flex:\s*0 1 140px;/)
  assert.match(appCss, /\.dashboard__add-btn\s*\{[\s\S]*?white-space:\s*nowrap;/)
  assert.match(options, /\.dashboard-toolbar__select \.custom-select__trigger/)
  assert.match(options, /\.dashboard-toolbar__filter-select \.custom-select__menu\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*calc\(100vw - 24px\);/)
  assert.match(options, /\.dashboard-toolbar__sort-select \.custom-select__menu\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*calc\(100vw - 24px\);/)
  assert.match(options, /\.dashboard-toolbar__select \.custom-select__options[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?gap:\s*6px;/)
  assert.doesNotMatch(app, /<select[^>]*dashboard-toolbar__/)
})

test('Dashboard toolbar filters and sorting preserve the shared custom control height', () => {
  const appCss = read('./App.css')
  const options = read('./SecondaryWindowOptionSurface.css')

  assert.match(appCss, /\.dashboard-toolbar__field\s*\{[\s\S]*?align-items:\s*center;/)
  assert.match(options, /\.dashboard-toolbar__select\s*\{[\s\S]*?--custom-select-trigger-min-height:\s*36px;/)
  assert.match(options, /\.dashboard-toolbar__select \.custom-select__trigger\s*\{[\s\S]*?min-height:\s*36px;/)
})

test('Commit History keeps the shared option inset without a layout-width scrollbar lane', () => {
  const options = read('./SecondaryWindowOptionSurface.css')

  assert.match(options, /\.commit-history-toolbar__branch-select[\s\S]*\.commit-history-drawer__branch-select[\s\S]*\.custom-select__trigger[\s\S]*background:\s*var\(--bg-input\) !important;/)
  assert.match(options, /\.commit-history-toolbar__branch-select[\s\S]*\.commit-history-drawer__branch-select[\s\S]*\.custom-select__menu[\s\S]*scrollbar-width:\s*none !important;/)
  assert.match(options, /\.custom-select__menu::\-webkit-scrollbar[\s\S]*width:\s*0 !important;/)
  assert.doesNotMatch(options, /scrollbar-gutter:\s*stable both-edges !important;/)
  assert.doesNotMatch(options, /\.stash-manager-sort-select \.custom-select__option[\s\S]*width:/)
})

test('AI model selection preserves a minimum select width and lets explanatory copy shrink and wrap', () => {
  const options = read('./SecondaryWindowOptionSurface.css')

  assert.match(options, /\.ai-model-picker__selection[\s\S]*display:\s*flex !important;/)
  assert.match(options, /\.ai-model-select[\s\S]*flex:\s*1 1 260px;/)
  assert.match(options, /\.ai-model-select[\s\S]*min-width:\s*220px;/)
  assert.match(options, /\.ai-model-picker__selection > small[\s\S]*flex:\s*0 1 max-content;/)
  assert.match(options, /\.ai-model-picker__selection > small[\s\S]*max-width:\s*360px !important;/)
  assert.match(options, /\.ai-model-picker__selection > small[\s\S]*white-space:\s*normal !important;/)
})

test('final form-control authority removes legacy input and dropdown borders', () => {
  const form = read('./FormControlSurface.css')

  assert.match(form, /input:not\(\[type='checkbox'\]\)/)
  assert.match(form, /textarea/)
  assert.match(form, /select/)
  assert.match(form, /\.custom-select__menu[\s\S]*border:\s*0 !important;/)
  assert.match(form, /\.github-repo-browser__search[\s\S]*border:\s*0 !important;/)
  assert.match(form, /\.github-repo-browser__filter-toggle[\s\S]*border:\s*0 !important;/)
})

test('GitHub repository filters and clone panel use one aligned neutral control geometry', () => {
  const form = read('./FormControlSurface.css')

  assert.match(form, /\.github-repo-browser__select \.custom-select__trigger[\s\S]*background:\s*var\(--bg-input\) !important;/)
  assert.match(form, /\.github-repo-browser__select \.custom-select__trigger[\s\S]*border-radius:\s*var\(--radius-md\) !important;/)
  assert.match(form, /\.github-repo-browser__clone-scroll[\s\S]*padding-inline:\s*0 !important;/)
  assert.match(form, /\.github-repo-browser__clone-actions[\s\S]*padding-inline:\s*0 !important;/)
  assert.match(form, /\.github-repo-browser__path-row/)
  assert.match(form, /\.github-repo-browser__clone-list/)
  assert.match(form, /\.github-repo-browser__clone-item[\s\S]*padding-inline:\s*0 !important;/)
})

test('GitHub repository names preserve descenders before the description line', () => {
  const appCss = read('./App.css')

  assert.match(
    appCss,
    /\.github-repo-browser__item-name\s*\{[\s\S]*?font-size:\s*14px;[\s\S]*?line-height:\s*1\.25;[\s\S]*?overflow:\s*hidden;/
  )
})

test('Working Changes and branch sync use canonical icon-only refresh actions', () => {
  const form = read('./FormControlSurface.css')
  const branchAttention = read('./BranchAttentionDetailLayer.jsx')
  const workingChanges = read('./WorkingChangesView.jsx')

  assert.match(form, /\.working-changes-staging-refresh[\s\S]*font-size:\s*0 !important;/)
  assert.match(form, /\.working-changes-staging-refresh[\s\S]*display:\s*inline-flex !important;/)
  assert.match(form, /\.working-changes-staging-refresh[\s\S]*align-items:\s*center !important;/)
  assert.match(form, /\.working-changes-staging-refresh[\s\S]*justify-content:\s*center !important;/)
  assert.match(form, /\.working-changes-staging-refresh > \.working-changes-staging-refresh__icon \{[\s\S]*display:\s*block;/)
  assert.doesNotMatch(form, /working-changes-staging-refresh::before|secondary-window-refresh-sync-mask|(?:-webkit-)?mask\s*:/)
  assert.match(workingChanges, /RefreshSyncIcon as CanonicalRefreshSyncIcon/)
  assert.match(workingChanges, /<CanonicalRefreshSyncIcon className="working-changes-staging-refresh__icon" \/>/)
  assert.match(form, /\.branch-attention-detail__primary-action--icon-only/)
  assert.match(branchAttention, /syncAction = action\?\.command === 'sync_repo_branch'/)
  assert.match(branchAttention, /branch-attention-detail__primary-action--icon-only/)
  assert.match(branchAttention, /<RefreshSyncIcon \/>/)
})


test('Dashboard filter empty states use WebP configuration and preserve scoped sync', () => {
  const app = read('./App.jsx')
  const appCss = read('./App.css')
  const emptyStates = read('./dashboardEmptyStates.js')

  assert.match(emptyStates, /DASHBOARD_EMPTY_STATE_CONFIG/)
  assert.match(emptyStates, /lightImage:/)
  assert.match(emptyStates, /darkImage:/)
  assert.match(emptyStates, /title: '还没有导入仓库'/)
  assert.match(emptyStates, /title: '暂无已同步仓库'/)
  assert.match(emptyStates, /title: '所有仓库都很干净'/)
  assert.match(emptyStates, /title: '没有未提交的本地改动'/)
  assert.match(emptyStates, /title: '没有待处理的改动'/)
  assert.match(app, /getDashboardFilterEmptyState/)
  assert.match(app, /getDashboardEmptyStateImage/)
  assert.match(app, /getDashboardEmptyProjection/)
  assert.doesNotMatch(app, /SHOW_EMPTY_STATE_KEY|showEmptyState|setShowEmptyState/)
  assert.match(app, /<DashboardFilterEmptyState[\s\S]*resolvedTheme=\{resolvedTheme\}/)
  assert.match(app, /const \[theme, setTheme, resolvedTheme\] = useTheme\(\)/)
  assert.match(app, /setResolvedTheme\(nextResolvedTheme\)/)
  assert.match(app, /formatSyncTimePresentation\(syncTimestamp\)/)
  assert.match(app, /data-app-tooltip="卡片布局"/)
  assert.doesNotMatch(app, /DashboardEmptyRepoCard|DashboardEmptyDocumentCard|DASHBOARD_FILTER_EMPTY_STATES/)
  assert.match(app, /const handleSyncCurrentFilter = async \(\) =>/)
  assert.match(app, /dashboardVisibleRepos\.filter\(\(repo\) => repo\.status !== 'paused'\)/)
  assert.match(app, /enqueueWithSyncGuards\(targets, 'syncFiltered'\)/)
  assert.match(app, /syncFiltered: '当前筛选'/)
  assert.match(app, /className="dashboard-toolbar__filter-sync-btn"/)
  assert.match(app, /aria-label="同步当前筛选"/)
  assert.match(app, /同步当前筛选\/搜索结果/)
  assert.match(appCss, /\.dashboard-toolbar__filter-sync-btn\s*\{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;/)
  assert.match(appCss, /\.dashboard__filter-empty\s*\{[\s\S]*?min-height:\s*430px;/)
  assert.match(appCss, /\.dashboard__filter-empty-art/)
  assert.match(appCss, /object-fit:\s*contain/)
  assert.doesNotMatch(appCss, /dashboard-empty-art__/)
})
