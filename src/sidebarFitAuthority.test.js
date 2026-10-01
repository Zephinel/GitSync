import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAIN_CONTENT_PADDING_FALLBACK_PX,
  SIDEBAR_FIT_SAFETY_PX,
  SIDEBAR_WIDTH_FALLBACK_PX,
  resolveSidebarFitMetrics,
  shouldCollapseSidebar,
} from './sidebarFitAuthority.js'

const BASE = { requiredRowWidth: 688, sidebarWidth: 240, mainPadding: 64 }

test('顶栏单行所需宽度 + 侧边栏 + 内边距 + 余量 决定是否收起', () => {
  // 688 + 240 + 64 + 12 = 1004
  assert.equal(resolveSidebarFitMetrics({ ...BASE, windowWidth: 1004 }).requiredWindowWidth, 1004)
  assert.equal(SIDEBAR_FIT_SAFETY_PX, 12)
  assert.equal(shouldCollapseSidebar({ ...BASE, windowWidth: 1440 }), false)
  assert.equal(shouldCollapseSidebar({ ...BASE, windowWidth: 1004 }), false)
  assert.equal(shouldCollapseSidebar({ ...BASE, windowWidth: 1003 }), true)
  assert.equal(shouldCollapseSidebar({ ...BASE, windowWidth: 900 }), true)
})

test('量不到顶栏（非仪表盘页或尚未布局）时不收起', () => {
  assert.equal(shouldCollapseSidebar({ requiredRowWidth: 0, windowWidth: 900 }), false)
  assert.equal(shouldCollapseSidebar({ windowWidth: 900 }), false)
  assert.equal(shouldCollapseSidebar({ requiredRowWidth: 688, windowWidth: 0 }), false)
  assert.equal(resolveSidebarFitMetrics({ requiredRowWidth: 0, windowWidth: 900 }).requiredWindowWidth, 0)
})

test('缺省与非法输入回落到 CSS 里的实际宽度', () => {
  const fallback = resolveSidebarFitMetrics({ requiredRowWidth: 688, windowWidth: 900 })
  assert.equal(fallback.sidebarWidth, SIDEBAR_WIDTH_FALLBACK_PX)
  assert.equal(fallback.mainPadding, MAIN_CONTENT_PADDING_FALLBACK_PX)
  assert.equal(fallback.requiredWindowWidth, 688 + SIDEBAR_WIDTH_FALLBACK_PX + MAIN_CONTENT_PADDING_FALLBACK_PX + SIDEBAR_FIT_SAFETY_PX)

  const invalid = resolveSidebarFitMetrics({
    requiredRowWidth: 'x',
    sidebarWidth: -10,
    mainPadding: Number.NaN,
    windowWidth: 'y',
  })
  assert.equal(invalid.requiredRowWidth, 0)
  assert.equal(invalid.sidebarWidth, SIDEBAR_WIDTH_FALLBACK_PX)
  assert.equal(invalid.mainPadding, MAIN_CONTENT_PADDING_FALLBACK_PX)
  assert.equal(invalid.windowWidth, 0)
  assert.equal(invalid.requiredWindowWidth, 0)
})

test('窄屏收起侧边栏的接线：测量、类名、按钮与动画都在', () => {
  const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const cssSource = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
  const registrySource = readFileSync(new URL('./icons/appIconRegistry.js', import.meta.url), 'utf8')

  // 测量：临时类强制单行，读两组自然宽度 + 行间距（不依赖写死断点）
  assert.match(appSource, /dashboard__header-actions--measure/)
  assert.match(appSource, /const requiredRowWidth = controls\.scrollWidth \+ actions\.scrollWidth \+ rowGap/)
  assert.match(cssSource, /\.dashboard__header-actions--measure \{[\s\S]*?width:\s*max-content !important;/)

  // 侧边栏宽度取 CSS 变量里的真实值，判定走纯函数
  assert.match(appSource, /getPropertyValue\('--sidebar-width'\)/)
  assert.match(appSource, /shouldCollapseSidebar\(\{/)

  // 收起状态：类名、侧边栏让位、提交历史不重复位移
  // 可见性与栅格列占用交给 sidebarCardState 的纯函数；这里只保证接线在，
  // 行为本身由 resolveSidebarPanelLayout 的专项测试覆盖。
  assert.match(appSource, /visible: sidebarVisible, columnCollapsed: sidebarColumnCollapsed/)
  assert.ok(appSource.includes("preference: sidebarPreference"))
  assert.ok(appSource.includes("sidebarColumnCollapsed ? 'app-layout--sidebar-collapsed' : ''"))
  assert.match(appSource, /collapsed=\{!sidebarVisible\}/)
  assert.match(appSource, /interactive && !collapsed \? undefined : 'true'/)
  assert.match(cssSource, /\.app-layout--sidebar-collapsed \{[\s\S]*?grid-template-columns:\s*0 minmax\(0, 1fr\);/)
  assert.match(cssSource, /\.app-layout--sidebar-collapsed\.app-layout--commit-history-open \.main-content \{[\s\S]*?transform:\s*none;/)

  // 动画：列宽与侧边栏共用同一组时长/曲线；reduced-motion 下压到 1ms
  assert.match(
    cssSource,
    /\.app-layout \{[\s\S]*?transition:\s*grid-template-columns var\(--sidebar-slide-duration\) var\(--sidebar-slide-ease\);/
  )
  assert.match(cssSource, /transform var\(--sidebar-slide-duration\) var\(--sidebar-slide-ease\),/)
  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.app-layout,\s*\.app-layout--sidebar-card,\s*\.sidebar,\s*\.app-layout--sidebar-docking \.sidebar \{\s*transition-duration: 1ms;/
  )

  // 顶栏左上角按钮：只在面板当前不可见时出现（宽屏手动收起后也用它展开），
  // 带可访问名称与 aria-controls。展开态下的收起入口在侧边栏自己的品牌行里。
  assert.match(
    appSource,
    /\{sidebarVisible \? null : \([\s\S]*?className="dashboard-toolbar__sidebar-toggle"/
  )
  assert.match(
    appSource,
    /className="sidebar__collapse-btn"[\s\S]*?aria-label="收起侧边栏"/
  )
  assert.match(appSource, /onToggle=\{handleToggleSidebar\}/)
  assert.match(cssSource, /\.sidebar__collapse-btn \{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?border-radius:\s*var\(--radius-md\);/)
  assert.match(cssSource, /\.sidebar__collapse-btn \{[\s\S]*?margin-left:\s*auto;/)
  assert.ok(appSource.includes('aria-controls="app-sidebar"'))
  assert.ok(appSource.includes('id="app-sidebar"'))
  assert.match(registrySource, /sidebarPanel: SidebarPanelIcon,/)

  // 形状与同排按钮一致：36×36 与 --radius-md（少了圆角会变成直角方块）
  assert.match(
    cssSource,
    /\.dashboard__header-actions \.dashboard-toolbar__sidebar-toggle \{[\s\S]*?width:\s*36px;[\s\S]*?height:\s*36px;[\s\S]*?border-radius:\s*var\(--radius-md\);/
  )
})
