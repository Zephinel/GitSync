import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SIDEBAR_CARD_DOCK_DURATION_MS,
  SIDEBAR_CARD_DOCK_FALLBACK_MS,
  SIDEBAR_CARD_INSET_PX,
  SIDEBAR_CARD_RADIUS_PX,
  SIDEBAR_CARD_SCROLLBAR_GUTTER_PX,
  SIDEBAR_CARD_Z_INDEX,
  resolveSidebarCardRect,
} from './sidebarCardAuthority.js'
import {
  SIDEBAR_CARD_MODE,
  isSidebarCardDocking,
  isSidebarCardFloating,
  isSidebarCardOpen,
  resolveSidebarCardMode,
  resolveSidebarCardTransition,
  normalizeSidebarPanelPreference,
  readSidebarPanelPreference,
  resolveSidebarPanelLayout,
  writeSidebarPanelPreference,
  SIDEBAR_PANEL_PREFERENCE_STORAGE_KEY,
} from './sidebarCardState.js'
import { SIDEBAR_WIDTH_FALLBACK_PX as NUMBER_OF_SIDEBAR_COLUMNS_WIDTH, shouldCollapseSidebar } from './sidebarFitAuthority.js'

test('卡片形态的断点只有一处 authority：sidebarFitAuthority 的收起判定', () => {
  const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const authoritySource = readFileSync(new URL('./sidebarCardAuthority.js', import.meta.url), 'utf8')

  // 卡片形态跟随顶栏量测出来的 toolbarNeedsCollapse，不自己再算一套断点。
  assert.match(appSource, /enabled: toolbarNeedsCollapse,/)
  assert.match(appSource, /setToolbarNeedsCollapse\(shouldCollapseSidebar\(\{/)
  // 去掉重复断点实现：曾经这里有个 shouldFloatSidebarCard，生产代码从不调用它，
  // 等于一个只有测试在用的影子 authority。
  assert.doesNotMatch(authoritySource, /shouldFloatSidebarCard/)
  assert.doesNotMatch(appSource, /shouldFloatSidebarCard/)
})

test('量不到顶栏时 sidebarFitAuthority 不收起（卡片形态也就不会出现）', () => {
  assert.equal(shouldCollapseSidebar({ requiredRowWidth: 0, windowWidth: 900 }), false)
  assert.equal(shouldCollapseSidebar({ windowWidth: 900 }), false)
  assert.equal(shouldCollapseSidebar({ requiredRowWidth: 688, windowWidth: 0 }), false)
})

test('卡片几何：四周留白 + 圆角 + 浮在仪表盘之上的 z 轴', () => {
  const card = resolveSidebarCardRect()
  assert.equal(card.inset, SIDEBAR_CARD_INSET_PX)
  assert.equal(card.radius, SIDEBAR_CARD_RADIUS_PX)
  assert.equal(card.zIndex, SIDEBAR_CARD_Z_INDEX)
  assert.ok(SIDEBAR_CARD_INSET_PX > 0, '卡片必须离开视口边缘，才看得出是浮层而不是面板')
  assert.ok(SIDEBAR_CARD_RADIUS_PX > 0, '圆角是卡片形态的外观前提')
  assert.ok(
    card.edgeRight > 0,
    '右边缘必须真的让出滚动条宽度：卡片宽度是显式的，只靠 max-width 才收得住'
  )

  const fallback = resolveSidebarCardRect({
    inset: 'x',
    radius: Number.NaN,
    zIndex: 0,
    scrollbarGutter: -1,
  })
  assert.equal(fallback.inset, SIDEBAR_CARD_INSET_PX)
  assert.equal(fallback.radius, SIDEBAR_CARD_RADIUS_PX)
  assert.equal(fallback.zIndex, SIDEBAR_CARD_Z_INDEX)
  assert.equal(fallback.edgeRight, SIDEBAR_CARD_SCROLLBAR_GUTTER_PX)
})

test('回位动画靠真实过渡事件收尾，时长只是兜底', () => {
  const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const authoritySource = readFileSync(new URL('./sidebarCardAuthority.js', import.meta.url), 'utf8')

  // 结束信号来自 sidebar 自身的 transform 过渡，而不是「等够 280ms」。
  assert.match(appSource, /addEventListener\('transitionend', handleTransitionEnd\)/)
  assert.match(appSource, /event\.propertyName !== 'transform'/)
  // 必须按 id 直接取：ref 的声明在 hook 作用域内，App 的 JSX 拿不到，
  // 之前写成 dockRootRef.current 会让它永远是 undefined，transitionend 等于没接。
  assert.match(appSource, /const sidebar = document\.getElementById\('app-sidebar'\)/)
  assert.doesNotMatch(appSource, /dockRootRef/)
  assert.doesNotMatch(
    appSource,
    /setTimeout\([^)]*SIDEBAR_CARD_DOCK_DURATION_MS/,
    '不能再把「动画结束」押在 JS 这边的固定时长上'
  )
  assert.match(appSource, /setTimeout\(finish, SIDEBAR_CARD_DOCK_FALLBACK_MS\)/)
  assert.match(authoritySource, /SIDEBAR_CARD_DOCK_FALLBACK_MS = SIDEBAR_CARD_DOCK_DURATION_MS \+ 220/)
  // 兜底必须比动画本身长，否则会在过渡结束前抢先切断动画。
  assert.ok(SIDEBAR_CARD_DOCK_FALLBACK_MS > SIDEBAR_CARD_DOCK_DURATION_MS)
})

test('渲染期保持纯净：边沿只在 effect 里写，不用状态盒伪装常量', () => {
  const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')

  // StrictMode 会把渲染跑两遍，渲染期写 ref / setState 会被重复应用。
  assert.doesNotMatch(appSource, /previousTransitionRef\.current = \{/)
  assert.doesNotMatch(appSource, /const \[initialTransitionRef\] = useState/)
  assert.match(appSource, /const wasEnabledRef = useRef\(initialTransitionRef\.current\.wasEnabled\)/)
  assert.match(
    appSource,
    /const transition = resolveSidebarCardTransition\(\s*\{ wasEnabled: wasEnabledRef\.current, wasOpen: wasOpenRef\.current \}/
  )
  // 每个回位会话只能有一个触发点与一个兜底定时器，不能被复制成两份。
  assert.equal((appSource.match(/setShouldDock\(true\)/g) || []).length, 1)
  assert.equal((appSource.match(/setTimeout\(finish, SIDEBAR_CARD_DOCK_FALLBACK_MS\)/g) || []).length, 1)
})

test('形态判定：四种形态各自的输入组合', () => {
  const mode = (input) => resolveSidebarCardMode(input)

  // 宽屏：面板在栅格列里，和仪表盘同一图层。
  assert.equal(mode({ enabled: false, isOpen: false, isDocked: true }), SIDEBAR_CARD_MODE.docked)
  // 窄屏未展开：卡片收在屏幕外。
  assert.equal(mode({ enabled: true, isOpen: false, isDocked: false }), SIDEBAR_CARD_MODE.floating)
  // 窄屏展开：卡片贴在左边缘，盖住仪表盘。
  assert.equal(mode({ enabled: true, isOpen: true, isDocked: false }), SIDEBAR_CARD_MODE.open)
  // 变宽回位中：仍然带浮层类，left 与栅格列一起反向。
  assert.equal(
    mode({ enabled: false, isOpen: false, isDocked: true, isDocking: true }),
    SIDEBAR_CARD_MODE.docking
  )

  assert.equal(isSidebarCardFloating(SIDEBAR_CARD_MODE.floating), true)
  assert.equal(isSidebarCardFloating(SIDEBAR_CARD_MODE.open), true)
  assert.equal(isSidebarCardFloating(SIDEBAR_CARD_MODE.docking), true)
  assert.equal(isSidebarCardFloating(SIDEBAR_CARD_MODE.docked), false)
  assert.equal(isSidebarCardOpen(SIDEBAR_CARD_MODE.open), true)
  assert.equal(isSidebarCardOpen(SIDEBAR_CARD_MODE.docking), false)
  assert.equal(isSidebarCardDocking(SIDEBAR_CARD_MODE.docking), true)
})

test('回位动画只由「窗口变宽」触发，窄屏按下展开不触发', () => {
  // 窄屏按下展开：isOpen 上升沿，不该回位。
  assert.deepEqual(
    resolveSidebarCardTransition(
      { wasEnabled: true, wasOpen: false },
      { enabled: true, isOpen: true, isDocked: false }
    ),
    { wasEnabled: true, wasOpen: true, shouldStartDocking: false }
  )
  // 展开态重复渲染：不重复触发。
  assert.equal(
    resolveSidebarCardTransition(
      { wasEnabled: true, wasOpen: true },
      { enabled: true, isOpen: true, isDocked: false }
    ).shouldStartDocking,
    false
  )
  // 窗口变宽（override 同时被清成 closed）：这才是回位。
  assert.equal(
    resolveSidebarCardTransition(
      { wasEnabled: true, wasOpen: true },
      { enabled: false, isOpen: false, isDocked: true }
    ).shouldStartDocking,
    true
  )
  // 宽屏稳定态：不触发。
  assert.equal(
    resolveSidebarCardTransition(
      { wasEnabled: false, wasOpen: false },
      { enabled: false, isOpen: false, isDocked: true }
    ).shouldStartDocking,
    false
  )
  // 窗口从宽变窄：进入卡片形态，不触发回位。
  assert.equal(
    resolveSidebarCardTransition(
      { wasEnabled: false, wasOpen: false },
      { enabled: true, isOpen: false, isDocked: false }
    ).shouldStartDocking,
    false
  )
})

test('卡片展开不能让主区变窄：栅格第一列在浮层形态下恒为 0', () => {
  /*
   * 这条是行为断言，不是文本断言——测试的就是 App.jsx 里那行推导的语义。
   *
   * 踩过的坑：拿「用户展开了侧边栏」当收起判据，于是卡片一展开，第一列从 0 回到
   * 240px，主区被挤窄、顶栏折成两行——而做悬浮卡片的全部意义就是不让它折。
   */
  const columnWidthFor = ({ toolbarNeedsCollapse, isOpen, isDocking }) => {
    const mode = resolveSidebarCardMode({
      enabled: toolbarNeedsCollapse,
      isOpen,
      isDocked: !toolbarNeedsCollapse,
      isDocking,
    })
    // 与 App.jsx 的 sidebarColumnCollapsed 保持同一条规则。
    const columnCollapsed = isSidebarCardFloating(mode) || isSidebarCardDocking(mode)
    return { mode, columnWidth: columnCollapsed ? 0 : NUMBER_OF_SIDEBAR_COLUMNS_WIDTH }
  }

  const collapsedCard = columnWidthFor({ toolbarNeedsCollapse: true, isOpen: false, isDocking: false })
  const openedCard = columnWidthFor({ toolbarNeedsCollapse: true, isOpen: true, isDocking: false })

  assert.equal(collapsedCard.mode, SIDEBAR_CARD_MODE.floating)
  assert.equal(openedCard.mode, SIDEBAR_CARD_MODE.open)
  assert.equal(
    openedCard.columnWidth,
    collapsedCard.columnWidth,
    '展开卡片前后栅格第一列宽度必须一致，否则主区会重排、顶栏会折行'
  )
  assert.equal(openedCard.columnWidth, 0, '浮层形态下这一列必须完全不占宽度')

  // 宽屏回到同一图层时才把这一列还给栅格。
  assert.equal(
    columnWidthFor({ toolbarNeedsCollapse: false, isOpen: false, isDocking: false }).columnWidth,
    NUMBER_OF_SIDEBAR_COLUMNS_WIDTH
  )
  // 回位动画结束后同样还给栅格（那时卡片已卸掉浮层类）。
  assert.equal(
    columnWidthFor({ toolbarNeedsCollapse: false, isOpen: false, isDocking: true }).mode,
    SIDEBAR_CARD_MODE.docking
  )
})

test('宽屏默认展开；点右上角收起后让出这一列，偏好看开合而不看宽度', () => {
  // 还没有偏好：默认展开，宽屏下栅格第一列占 240。
  assert.deepEqual(
    resolveSidebarPanelLayout({}),
    { visible: true, dockCollapsed: false, columnCollapsed: false, preference: '' }
  )

  // 按下侧边栏右上角的收起按钮：写进偏好，面板收进屏幕外，这一列让给主区。
  const collapsed = resolveSidebarPanelLayout({ preference: 'collapsed' })
  assert.equal(collapsed.visible, false)
  assert.equal(collapsed.dockCollapsed, true)
  assert.equal(collapsed.columnCollapsed, true, '收起后必须让出这一列，主区才会变宽')

  // 顶栏那个按钮把它放回来。
  assert.equal(resolveSidebarPanelLayout({ preference: 'expanded' }).visible, true)
})

test('调整窗口尺寸不再改变开合：偏好一旦存在就压过宽度', () => {
  // 偏好=收起时，无论窗口宽窄都保持收起——这正是「改尺寸不会自动展开/收起」。
  for (const toolbarNeedsCollapse of [false, true]) {
    const collapsed = resolveSidebarPanelLayout({ preference: 'collapsed', toolbarNeedsCollapse })
    assert.equal(collapsed.visible, false, `偏好收起时 toolbarNeedsCollapse=${toolbarNeedsCollapse} 也必须收起`)
  }

  // 偏好=展开时同理，宽窄都保持展开。
  for (const toolbarNeedsCollapse of [false, true]) {
    const expanded = resolveSidebarPanelLayout({ preference: 'expanded', toolbarNeedsCollapse })
    assert.equal(expanded.visible, true, `偏好展开时 toolbarNeedsCollapse=${toolbarNeedsCollapse} 也必须展开`)
  }

  // 没有偏好时默认「展开」，且与宽度无关——拖窗口边框永远不会改变可见性。
  // （曾经把宽度当默认值来源，结果就是「变窄自动收、变宽自动放」，等于没改。）
  assert.equal(resolveSidebarPanelLayout({ toolbarNeedsCollapse: false }).visible, true)
  assert.equal(resolveSidebarPanelLayout({ toolbarNeedsCollapse: true }).visible, true)

  // 直接穷举一遍宽度序列：三种偏好下可见性都必须恒定。
  const widths = [800, 1004, 1400, 1600, 1200, 900]
  for (const preference of ['', 'collapsed', 'expanded']) {
    const seen = widths.map((width) => resolveSidebarPanelLayout({
      preference,
      toolbarNeedsCollapse: width < 1004,
      isCardFloating: width < 1004,
    }).visible)
    assert.equal(
      new Set(seen).size,
      1,
      `偏好=${JSON.stringify(preference)} 时可见性必须与宽度无关，实际 ${JSON.stringify(seen)}`
    )
  }
})

test('偏好读写：非法值收敛为空偏好，空偏好会清掉存储项', () => {
  assert.equal(normalizeSidebarPanelPreference('expanded'), 'expanded')
  assert.equal(normalizeSidebarPanelPreference('collapsed'), 'collapsed')
  assert.equal(normalizeSidebarPanelPreference(''), '')
  assert.equal(normalizeSidebarPanelPreference('open'), '')
  assert.equal(normalizeSidebarPanelPreference(null), '')
  assert.equal(normalizeSidebarPanelPreference(undefined), '')

  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }

  assert.equal(readSidebarPanelPreference(storage), '', '空存储读出来是「没有偏好」')
  assert.equal(writeSidebarPanelPreference('collapsed', storage), 'collapsed')
  assert.equal(readSidebarPanelPreference(storage), 'collapsed')
  assert.equal(store.get(SIDEBAR_PANEL_PREFERENCE_STORAGE_KEY), 'collapsed')
  assert.equal(writeSidebarPanelPreference('expanded', storage), 'expanded')
  assert.equal(readSidebarPanelPreference(storage), 'expanded')
  // 写空值等于清除这一项，回到「跟随宽度」。
  writeSidebarPanelPreference('', storage)
  assert.equal(store.has(SIDEBAR_PANEL_PREFERENCE_STORAGE_KEY), false)
  assert.equal(readSidebarPanelPreference(storage), '')

  // 存储抛异常时保持当前 UI 状态，不冒泡。
  const brokenStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.equal(readSidebarPanelPreference(brokenStorage), '')
  assert.equal(writeSidebarPanelPreference('collapsed', brokenStorage), 'collapsed')
})

test('回位动画期间这一列要还给栅格，否则卡片会滑到屏幕外', () => {
  const docking = resolveSidebarPanelLayout({ isCardDocking: true })
  assert.equal(docking.columnCollapsed, true, '回位动画本身仍由浮层的 fixed 定位驱动')

  // 动画结束后 isCardDocking 归 false，列交给栅格——这正是 App.jsx 传参的形状。
  const docked = resolveSidebarPanelLayout({})
  assert.equal(docked.columnCollapsed, false)
})

test('浮层接线：类名、退场位移、回位动画与关闭入口都在', () => {
  const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')
  const cssSource = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
  const authoritySource = readFileSync(new URL('./sidebarCardAuthority.js', import.meta.url), 'utf8')

  // 形态判定走纯函数，时长常量在 JS 与 CSS 之间对齐。
  assert.match(appSource, /useFloatingSidebarCard\(\{/)
  assert.match(appSource, /resolveSidebarCardRect\(\)/)
  assert.match(appSource, /resolveSidebarCardMode\(\{/)
  assert.match(appSource, /resolveSidebarCardTransition\(/)
  assert.match(authoritySource, /SIDEBAR_CARD_DOCK_DURATION_MS = 280/)
  assert.match(cssSource, /--sidebar-card-dock-duration:\s*280ms;/)
  assert.equal(SIDEBAR_CARD_DOCK_DURATION_MS, 280)

  // 类名：浮层本身、展开态、回位动画。
  assert.match(appSource, /sidebarCardMode \? 'app-layout--sidebar-card' : ''/)
  assert.match(appSource, /sidebarCardOpen \? 'app-layout--sidebar-card-open' : ''/)
  assert.match(appSource, /sidebarCardDocking \? 'app-layout--sidebar-card-docking' : ''/)
  assert.match(appSource, /sidebarCardDocking \? 'app-layout--sidebar-docking' : ''/)
  assert.match(appSource, /floating \? 'sidebar--card' : ''/)
  assert.match(appSource, /docking \? 'sidebar--card-docking' : ''/)

  // 收起：整张卡片宽度 + 左边距一起退到视口之外（镜像位移）。
  assert.match(
    cssSource,
    /--sidebar-card-offset:\s*calc\(-1 \* \(var\(--sidebar-width\) \+ var\(--sidebar-card-inset\)\)\);/
  )
  assert.match(cssSource, /\.app-layout--sidebar-card \.sidebar \{[\s\S]*?position:\s*fixed;/)
  assert.match(cssSource, /\.app-layout--sidebar-card \.sidebar \{[\s\S]*?transform:\s*translateX\(var\(--sidebar-card-offset\)\);/)
  assert.match(cssSource, /\.app-layout--sidebar-card-open \.sidebar \{[\s\S]*?transform:\s*translateX\(0\);/)

  // 浮层时侧边栏脱离栅格流，主区必须钉死在第二列，否则会被自动放到第一列。
  assert.match(cssSource, /\.app-layout > \.sidebar \{[\s\S]*?grid-column:\s*1;/)
  assert.match(cssSource, /\.main-content \{[\s\S]*?grid-column:\s*2;/)

  // 回位：栅格列与侧边栏位移一起反向，终点正好是原来的列边界。
  assert.match(
    cssSource,
    /\.app-layout--sidebar-docking \{[\s\S]*?grid-template-columns:\s*var\(--sidebar-width\) minmax\(0, 1fr\);/
  )
  assert.match(
    cssSource,
    /\.app-layout--sidebar-docking \{[\s\S]*?transition:\s*grid-template-columns var\(--sidebar-card-dock-duration\) var\(--sidebar-slide-ease\);/
  )
  // 回位期间不能还挂着「列宽为 0」那一档，否则卡片会滑到屏幕外而不是回到列里。
  // 该推导现在收在 resolveSidebarPanelLayout 里，由它的专项测试保证。
  assert.match(appSource, /visible: sidebarVisible, columnCollapsed: sidebarColumnCollapsed/)

  // 卡片打开与回位动画期间，根节点都裁掉溢出，滑出边缘不会撑出滚动条。
  assert.match(appSource, /root\.classList\.toggle\('sidebar-card-mode', sidebarCardMode \|\| sidebarCardDocking\)/)
  assert.match(cssSource, /html\.sidebar-card-mode \{[\s\S]*?overflow:\s*hidden;/)

  // 关闭入口：点击卡片外部与 Esc 都收起。
  assert.match(appSource, /className="sidebar-card-backdrop"/)
  assert.match(appSource, /onClick=\{closeSidebarCard\}/)
  assert.match(appSource, /if \(event\.key === 'Escape'\) onRequestClose\(\)/)
  assert.match(cssSource, /\.sidebar-card-backdrop \{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;/)
  assert.match(cssSource, /\.sidebar-card-backdrop \{[\s\S]*?z-index:\s*calc\(var\(--sidebar-card-z-index, 60\) - 10\);/)

  // 动画：卡片自己的位移/left 用与侧边栏同一组时长与曲线。
  assert.match(
    cssSource,
    /\.sidebar \{[\s\S]*?left var\(--sidebar-slide-duration\) var\(--sidebar-slide-ease\),/
  )
  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.app-layout,\s*\.app-layout--sidebar-card,\s*\.sidebar,\s*\.app-layout--sidebar-docking \.sidebar \{\s*transition-duration: 1ms;/
  )
})
