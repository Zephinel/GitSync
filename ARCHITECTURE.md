# GitSync 项目架构文档

> 跨平台 Git 仓库自动同步桌面应用

## 技术栈

| 层 | 技术 | 版本 |
|---|------|------|
| 前端 | React + Vite | React 19, Vite 8 |
| 后端 | Rust + Tauri | Tauri v2 |
| Git 操作 | 系统 git CLI | 通过 `tokio::process::Command`（带超时控制） |
| GitHub API | `reqwest` | Device Flow 登录、账号信息、仓库分页浏览 |
| 持久化 | JSON 文件 | `serde_json` |
| 安全凭据 | `keyring` | macOS Keychain / Windows Credential Manager |
| 样式 | Vanilla CSS | CSS 变量驱动的双主题系统 |

---

## 目录结构

```
GitSync/
├── .gitattributes              # Git 行尾策略（默认 LF，Windows 脚本除外）
├── .editorconfig               # 编辑器行尾策略（文本文件统一 LF）
├── src/                        # 前端源码
│   ├── App.jsx                 # React 主组件（所有 UI 逻辑）
│   ├── App.css                 # 样式（含浅色/深色主题）
│   ├── DeviceAuthDialog.jsx    # GitHub Device Flow 登录弹窗
│   ├── GithubRepoBrowserDialog.jsx # GitHub 仓库浏览与批量克隆弹窗
│   ├── importUi.jsx            # 导入入口菜单与克隆弹窗
│   └── main.jsx                # 入口文件
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── lib.rs              # Tauri 应用入口 + 插件注册 + setup
│   │   ├── commands.rs         # 所有 Tauri 命令和业务逻辑
│   │   └── main.rs             # bin 入口（调用 lib::run）
│   ├── Cargo.toml              # Rust 依赖
│   ├── tauri.conf.json         # Tauri 配置
│   └── capabilities/
│       └── default.json        # 权限声明
├── index.html                  # HTML 模板
├── package.json                # Node 依赖和脚本
└── vite.config.js              # Vite 配置（自动生成）
```

---

## 核心数据结构

### RepoConfig（仓库配置）

```rust
struct RepoConfig {
    id: String,              // 唯一 ID (repo_时间戳_随机)
    name: String,            // 仓库名（目录名）
    path: String,            // 本地路径
    branch: String,          // 当前分支
    remote: Option<String>,  // 远程 URL
    sync_interval: u64,      // 同步间隔（秒）
    auto_sync: bool,         // 是否启用自动同步
    sync_mode: String,       // "auto" | "manual"
    pull_strategy: String,   // "rebase" | "merge"
    status: String,          // "idle" | "syncing" | "conflict" | "error" | "paused"
    last_sync_at: Option<String>,  // GitSync 同步成功时间，兼容秒/毫秒字符串
    last_error: Option<String>,    // 最近一次错误摘要
    error_logs: Vec<String>,       // 错误日志（最多保留固定条数）
    post_sync_build_enabled: bool, // 是否启用同步后脚本
    post_sync_build_script: Option<String>, // 仓库内脚本相对路径
    created_at: String,      // 添加时间戳
}
```

### AppState（应用状态）

```rust
struct AppState {
    repos: Mutex<Vec<RepoConfig>>,            // 仓库列表（内存）
    data_path: Mutex<Option<PathBuf>>,        // 持久化文件路径
    syncing_repos: Mutex<HashSet<String>>,    // 运行中的同步仓库（后端互斥防重）
    git_repo_locks: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>, // 同仓库 Git 命令互斥
    http_client: reqwest::Client,             // 复用的 GitHub HTTP client
}
```

**持久化位置**: `{app_data_dir}/repos.json`（保存时维护 `repos.json.bak` 作为恢复备份）
- macOS: `~/Library/Application Support/com.gitsync.desktop/repos.json`
- Windows: `%APPDATA%/com.gitsync.desktop/repos.json`

**GitHub token 位置**: 系统凭据管理器，service 为 `gitsync-github`，account 为 `default`。token 不写入 `repos.json` 或前端 localStorage。前端启动时不主动读取 token，只有用户打开 GitHub 登录/仓库浏览入口时才按需调用 `github_get_account`。

---

## 同步流程

```
sync_repo(repo_id)
│
├── 1. git fetch --all --prune
│
├── 2. 检查本地是否有未提交改动
│   └── 有 → git stash push -m "GitSync: 同步前暂存"
│
├── 3. 拉取远程（根据策略）
│   ├── rebase → git pull --rebase --autostash [remote] [branch]
│   └── merge  → git pull --no-edit [remote] [branch]
│      （优先读取 `branch.<name>.remote` + `branch.<name>.merge` 作为显式目标，缺失时回退到默认 pull）
│
├── 4. 如果 stash 了 → git stash pop
│   └── pop 冲突 → 通知用户
│
├── 5. 检查 pull 结果
│   ├── 成功 + ahead > 0 → git push
│   └── 冲突 → 弹出冲突解决对话框
│
└── 6. 更新状态 + save()
```

`sync_repo` 返回结果除 `success/message/conflict` 外，还包含 `did_pull` / `did_push` 标记。
其中 `did_pull` 仅在本次 `pull` 真实同步到远端新提交时为 `true`（`Already up to date` 等无新提交场景为 `false`），用于前端判断同步后脚本触发条件。

### 同仓库 Git 命令互斥

- 后端维护按仓库路径归一化后的互斥锁表（`git_repo_locks`）。
- 对同一仓库的 `sync_repo`、`get_repo_status`、`refresh_repo_remote`、`check_sync_prerequisites` 统一串行化执行。
- 该机制与 `syncing_repos`（仅同步任务防重）互补，目标是降低 `index.lock` 竞争。

### 冲突解决

| 方式 | 命令 |
|------|------|
| 保留本地（单文件） | `git checkout --ours <file>` + `git add` |
| 保留远程（单文件） | `git checkout --theirs <file>` + `git add` |
| 全部保留本地 | 批量 `--ours` + `git commit` |
| 全部保留远程 | 批量 `--theirs` + `git commit` |
| 中止合并 | `git merge --abort` 或 `git rebase --abort` |

## GitHub 账号与仓库浏览

```
Settings GitHub 区块
│
├── 登录 -> DeviceAuthDialog
│   ├── github_start_device_auth
│   ├── github_poll_token -> keyring 保存 token -> github_get_account
│   └── 授权成功后更新 App.githubAccount 并打开 GithubRepoBrowserDialog
├── 打开 GitHub 仓库入口 -> 按需 github_get_account；未恢复账号时再进入 Device Flow
├── 登出 -> github_logout -> 清空 App.githubAccount
└── hideExistingGithubReposByDefault 默认隐藏开关

GithubRepoBrowserDialog
│
├── github_get_repos(page) 分页加载 /user/repos
├── 前端按 full_name/name/description/language 搜索
├── 前端根据当前仓库列表识别已添加仓库，隐藏或禁选已添加仓库
└── 多选后逐个调用 clone_repo(repo.clone_url, parent_path)
    └── clone_repo 成功后复用 add_repo_internal，自动进入仓库列表
```

- `github_get_repos` 只负责拉取当前 GitHub 账号可见仓库；是否隐藏“已添加仓库”属于前端显示策略。
- `get_repos` 返回本地仓库列表前会从真实 Git 仓库刷新当前 branch 与 preferred remote，并在变化时写回 `repos.json`；这样即使缓存里曾保存了旧 remote，也不会影响 GitHub 已添加仓库判断。
- “已添加仓库”优先使用刷新后的 GitHub remote URL 解析出的 `owner/repo` 精确匹配；如果某个本地仓库当前没有可解析的 GitHub remote，则用本地仓库名作为兜底匹配。
- 设置项 `hideExistingGithubReposByDefault` 只决定浏览器打开时的默认过滤状态；浏览器内的“隐藏已添加”开关可临时覆盖。
- 批量克隆采用串行执行，单个仓库失败不阻断后续仓库；克隆完成后统一 `fetchRepos()` 刷新列表。

---

## 前端架构

### 组件结构

```
App (主组件，管理全局状态)
├── Sidebar            侧边栏：品牌、统计面板（含当前同步模式）、导航、全部同步
├── Dashboard          仪表盘：列表布局/卡片布局切换、批量工具条、仓库网格
├── SyncHistoryCenter  同步历史中心：统计、筛选、仓库分组折叠
├── Settings           设置页：外观主题、同步配置、默认打开应用
├── RepoCard           仓库卡片：分层状态提示（右上角标签徽标 + 自动脚本标识/中部状态徽标/下方提示条）、元信息（路径/分支/最新提交悬浮卡片 + 分支总览）、目录缺失遮罩（半透明提示 + 移除按钮）、主操作 + 更多菜单
├── CustomSelect       自定义下拉控件（历史筛选使用）
├── ConflictDialog     冲突解决对话框
├── ErrorLogDialog     同步错误日志对话框
├── DeleteConfirmDialog 删除确认对话框（支持批量）
├── CloneRepoDialog    克隆仓库对话框（输入远程地址与本地保存路径）
├── DeviceAuthDialog   GitHub Device Flow 登录弹窗（验证码、打开浏览器、轮询状态）
├── GithubRepoBrowserDialog GitHub 仓库浏览器（搜索、隐藏已添加、多选、批量克隆进度）
├── ImportResultDialog 导入结果对话框（成功/跳过/失败明细）
├── NoticeDialog       通用提示对话框
├── StatusToast        轻提示 toast（启动自动刷新失败等非阻断反馈）
├── ScriptLogDialog    脚本执行日志窗口（实时输出 + 会话切换）
├── ImportEntryMenu    导入入口菜单（本地导入 / 克隆仓库 / GitHub 仓库）
└── Icons              SVG 图标组件集
```

### 前端关键模块（2026-04-03）

- `src/importUi.jsx`：导入入口菜单与手动克隆弹窗 UI，和 `App` 主流程解耦。
- `src/DeviceAuthDialog.jsx`：GitHub Device Flow 登录 UI，负责启动授权、轮询 token、处理重试与 Strict Mode 竞态。
- `src/GithubRepoBrowserDialog.jsx`：GitHub 仓库浏览器 UI，负责分页加载、搜索、多选、默认/临时隐藏已添加仓库、批量克隆进度展示。
- `src/removeRepoUtils.js`：删除结果归一化与后端返回解析（兼容 `snake_case`/`camelCase`）。
- `src/repoRemoveState.js`：删除乐观更新、失败回滚、撤销数据构建等状态逻辑工具。
- `src/repoStatusUtils.js`：仓库改动判定、Dashboard filter 分类、commit/sync 时间归一化与排序契约、状态刷新异常展示文案与相对时间格式化。
- `src/roundCompletionQueue.js`：按“请求对应轮次”结算等待者的共享队列状态工具。
- `src/remoteRefreshQueue.js` / `src/singleFlightQueue.js`：远端刷新与仓库列表刷新的 single-flight/排队合并。

### 主题系统

- 通过 `data-theme` 属性切换 CSS 变量
- 三种模式：`light` / `dark` / `system`
- 主题状态由 `App.jsx` 管理，保存到 `localStorage`（`gitsync-theme`）
- 跟随系统模式使用 `prefers-color-scheme` media query
- `useTheme()` 同时维护用户选择的 `theme` 与实际生效的 `resolvedTheme`；系统主题变化会更新 `resolvedTheme` 与 `data-theme`，依赖主题的资源不得只判断用户选择值
- 布局与设置同样保存到 `localStorage`（`gitsync-dashboard-layout`、`gitsync-settings`）
- 同步历史持久化到 `localStorage`（`gitsync-sync-history`）
- 同步诊断事件持久化到 `localStorage`（`gitsync-sync-diagnostics`），采用版本化安全字段并最多保留 1,000 条
- 应用错误日志持久化到 `localStorage`（`gitsync-error-log`），最多保留 200 条原始错误文本
- `gitsync-settings.hideExistingGithubReposByDefault` 控制 GitHub 仓库浏览器打开时是否默认隐藏已添加仓库

### 自动同步定时器

- 每个启用自动同步的仓库创建一个 `setInterval`
- 依赖数组通过序列化仓库关键字段判断变化
- 组件卸载时清理所有定时器
- 窗口失焦时暂停自动同步定时器，回焦后恢复
- 仓库状态轮询仅在 `Dashboard + 窗口聚焦` 条件下运行；本地状态刷新保持 10 秒周期
- 失焦恢复后会补一次本地状态刷新，卡片底部可能短暂显示“刷新状态中...”
- 应用启动后会自动触发一轮远端 `fetch`（全量未暂停仓库）
- 定时远端 `fetch` 周期由应用设置控制，且仅作用于未启用自动同步的仓库
- 已标记“目录缺失”的仓库会跳过状态刷新、远端 `fetch` 与自动同步定时器，减少无效任务与错误噪音
- 非 Dashboard 页面仅刷新仓库列表，不做全量状态抓取
- `maxSyncConcurrency` 统一控制 Git 任务并发：同步队列、状态读取、定时远端 Fetch、同步前检查
- Dashboard 顶部“获取更新”按钮可手动触发全部未暂停仓库执行远端 `fetch`
- 手动触发与定时触发共享同一远端刷新队列，采用串行排队与请求合并：当队列中存在“全量刷新”请求时，后续 `manualOnly` 请求不会降级它
- 顶部“获取更新”按钮的加载态只等待覆盖本次手动请求的那一轮远端刷新与状态回填完成，不再被后续追加的后台轮次拖住
- 仓库卡片的 `获取更新中...` 与 `刷新状态中...` 遮罩允许点击同步，请求分别记录 `remote_refresh_overlay` 与 `focus_refresh_overlay` 触发来源；同步前检查和分支操作遮罩仍阻止点击

### Dashboard 统一列表、排序与空状态

- Dashboard 的数据管线固定为：`status filter -> global sort -> search -> layout projection`。所有仓库共享一份 `dashboardVisibleRepos`，筛选后的同步入口只消费这份可见列表，并跳过暂停仓库。
- Dashboard empty projection 只看当前 `dashboardVisibleRepos` 是否为空：有搜索关键词时显示独立 search empty，否则显示当前 filter 对应插画；初次加载由 `appReady`/loading 生命周期 gate，不能由全局 `repos.length` 决定。
- status filter 依据当前分支与工作区状态：`all`、`synced`、`new-changes`、`local-changes`、`new-and-local-changes`。搜索无结果是独立的文本状态，不复用 filter empty state 插画。
- `new-and-local-changes`（常量 `newAndLocalChanges`）是保留的 LEGACY KEY 名称，只为兼容已持久化的筛选值，不做任何数据迁移。其当前匹配语义是并集 `new ∪ local`：远端有新改动、本地有未提交改动、或两者都有都命中；两个单条件 filter（`new-changes`、`local-changes`）保持精确且互斥。后续维护者不要把它“修正”回交集。
- `commitAsc` / `commitDesc` 的唯一排序来源是当前分支卡片上的 latest commit `date`（Git `%ai`，含时区）；缺失 commit 时间永远排在有时间仓库之后。
- `syncAsc` / `syncDesc` 的唯一排序来源是 `getRepoSyncSortTimestamp()`：`max(repo.last_sync_at, latest successful syncHistory.finishedAt)`。两类输入都兼容 legacy seconds 与当前 milliseconds；`failed` / `canceled` history 不参与，时间单位只按结构化 seconds/milliseconds contract 归一化，不依赖当前 wall clock 猜测合法性。branch switch、fetch、status refresh 不更新 `last_sync_at`，只有真正成功的 `sync_repo` 才记录同步完成时间。
- 所有时间排序的缺失值在 asc/desc 两个方向都永远最后；相同时间按仓库名称再按 id 做确定性回退。名称排序只比较名称/id，不读取时间。
- 排序与视觉阅读顺序使用同一契约：列表布局每行一个仓库，卡片布局按已排序数组以 row-major（从左到右、从上到下）分行后渲染；布局只是投影，不重新解释排序。历史 persisted value `masonry` 只作为卡片布局兼容 key，当前实现不是 variable-height masonry。
- 卡片主时间会随 active sort mode 标明排序依据：commit sort 显示“提交时间”，sync sort 显示“上次同步”；同步相对时间的 tooltip 同时显示来自同一个最终 sync sort timestamp 的精确本地时间；两种时间保持独立。
- empty state 的唯一视觉 authority 是 `src/dashboardEmptyStates.js` 中的五态配置与 `src/assets/dashboard-empty-states/{light,dark}/*.webp` 十张资源，文案由 React 渲染。透明 WebP 使用实际 `resolvedTheme` 切换，应用背景保持主要背景 authority。
- 仓库卡片仍只消费 `get_repo_status` 返回的当前分支状态；远端刷新后，前端额外缓存 `get_repo_branch_overview`，将非当前分支落后与远端新分支投影为卡片内非模态提示，完整分支状态仍由分支悬浮窗展示。
- 分支写操作必须通过显式按钮触发：卡片提示可处理唯一安全目标，分支悬浮窗提供“切换”“切换并跟踪”“重新绑定”或“取消上游”。分支操作完成后只刷新目标仓库，不会把分支切换计入 `last_sync_at`。

### 同步行为模式

- `sync_repo` 支持可选参数 `sync_behavior`：
  - 默认模式：`fetch -> stash(如有本地未提交改动) -> pull -> stash pop -> push(如 ahead)`
  - 按改动模式（`changes_only`）：`fetch -> push(如 ahead) -> pull(如 behind) -> push(如 ahead)`
- pull 执行策略：优先按当前分支上游配置显式指定 `remote + branch`，减少 `rebase` 模式下因跟踪目标歧义导致的偶发失败。
- 前端侧边栏提供“按改动同步”按钮，触发 `changes_only` 模式并接入统一同步队列。

### 同步后脚本执行

- 每个仓库可独立配置“同步后执行脚本”开关与脚本路径。
- 首次开启时前端要求选择脚本，后续仅切换开关，不重复选择。
- 脚本在同步成功后后台执行，不阻塞同步任务收敛到 `success`。
- 脚本失败仅触发前端提示，不改写本次 Git 同步结果。
- 应用级设置 `autoOpenScriptLogDialog` 控制“自动触发脚本时是否自动弹出日志窗口”。
- 应用级设置 `postSyncScriptPullOnly` 控制脚本触发条件：
  - 关闭：同步中发生“有效 pull”（拉取到新提交）或 `push` 任一动作即可触发
  - 开启：仅在同步中发生“有效 pull”时触发
- 后端命令 `run_repo_build_script` 负责脚本执行：
  - 脚本必须位于仓库目录内（防越界）
  - 扩展名校验按平台生效：Windows 支持 `.sh` / `.command` / `.bat` / `.cmd` / `.ps1`；macOS/Linux 支持 `.sh` / `.command`
  - Windows 终端分支会先将 `canonicalize()` 路径标准化（去除 `\\?\` 前缀）再执行，避免 `cmd` 解析路径失败
  - Windows 系统终端通过 `start /D <repo> cmd /K ...` 启动，保证工作目录稳定且与手动双击行为一致
  - macOS 系统终端分支会优先复用 Terminal 当前前台窗口执行脚本，避免在 Terminal 初次拉起时额外留下一个空白窗口
  - 使用超时与输出截断保护，避免卡死和超长日志撑爆 UI
  - 前端可选择“应用内执行（可流式日志）”或“系统终端执行（行为贴近双击脚本）”
  - 当前默认策略：手动测试与同步后自动触发都使用系统终端执行

### 同步历史中心（P1）

- 历史记录在前端按仓库分组聚合，支持展开/收起。
- 展开区域使用 `history-group__entries-wrap` 做平滑过渡动画（高度、透明度、位移）。
- 支持结果/来源双筛选与关键词搜索（仓库、路径、分支、提交、错误摘要）。
- 统计面板展示总量、成功、失败、取消、平均耗时。
- `设置 → 诊断 → 复制诊断日志` 一次导出同步生命周期事件与应用错误日志两个分区，合并 payload 由 `src/diagnosticBundle.js` 统一生成，`kind` 为 `gitsync-diagnostic-bundle`。
- 同步分区用 `requestId` 与 `jobId` 关联一次请求和实际任务。
- 正常事件顺序为 `request_received -> guard_completed -> queue_enqueued -> job_started -> backend_completed`。警告确认会插入 `guard_dialog`，重复入队与取消分别记录 `queue_skipped`、`job_canceled` 或 `cancel_requested`。
- `backend_completed` 记录 `didPull`、`didPush`、`conflict` 与 `responseReceived` 等安全结果字段。成功且 `didPull`、`didPush` 均为 `false` 表示同步完成但没有 Git 拉取或推送动作。
- 同步诊断事件不持久化仓库路径、提交信息、Git 命令、远端地址或原始错误文本；`appErrorLog` 分区仍包含仓库名与 Git 原始错误，分享前需自行确认内容。
- 清空同步历史时一并清空同步诊断事件，但不会清空应用错误日志。

### 悬浮 Tooltip 统一权威

- `src/AppTooltip.jsx` 是全局唯一的悬浮提示权威，挂载于应用根节点。
- 提示文本在源码里用 `data-app-tooltip` 显式声明；浏览器原生 `title` 由系统外壳绘制、无法换肤，因此 DOM 元素不再使用 `title`，并由 `src/appTooltip.test.js` 守护（组件自身的 `title` 属性不受影响）。
- 该层只做触发：委托监听 `pointerover` / `pointerout` / `pointermove`，把带 `data-app-tooltip` 的元素在延迟后交给共享浮层，并在离开、滚动、缩放、点击或 Escape 时收起。
- 显式提示跟随鼠标：位置取延迟到期那一刻的指针坐标（右下偏移、自动避开视口边缘），因为锚点常常是撑满宽度的容器；分支名截断提示与 `CustomSelect` 则贴自己所在的元素左边缘。
- 几何计算统一走 `src/appTooltip.js`，层级使用 `--z-app-tooltip`；`AppTooltipSurface` 先以 `visibility: hidden` 渲染自身再测量真实宽高，因此不会用最大宽度预估产生偏移。

### RepoCard 更多菜单定位

- 菜单默认从“更多”按钮向下弹出。
- 弹出时根据按钮位置和菜单高度计算可视区域空间：
  - 下方空间不足且上方空间更大时，切换为向上弹出；
  - 其他情况保持向下弹出。
- 打开期间监听 `resize` 与滚动事件，保证窗口尺寸或滚动变化后位置仍正确。

### RepoCard 元信息悬浮卡片

- 路径与最新提交共享同一套悬浮卡片样式组件，保证视觉一致。
- 元信息行常态保持单行省略，仅在文本被截断时显示悬浮卡片（分支总览除外，悬停即展示）。
- 提交悬浮卡片内容包含 hash、message、author、date，路径悬浮卡片展示完整仓库路径。
- 分支悬浮卡片展示：本地/远端分支数量、更新摘要（新分支/落后分支/有分叉/upstream gone/比对失败/其它 worktree 检出）、分支列表状态。
- 指标口径区分：卡片“落后 N”表示当前分支落后提交数；分支总览“落后分支 N”表示落后分支数量。
- 分支列表支持内部滚动与高度上限，避免分支过多时遮挡其他卡片。
- 悬浮显示采用 `hover + open-state + 延迟关闭` 组合，减少相邻元信息区域切换时的闪烁。
- 层级约束：元信息悬浮卡片 > 更多菜单 > 底部操作条“检查中/获取更新中”遮罩，避免遮罩阻断分支/提交悬浮提示。

### RepoCard 分支总览与切换

- 前端在远端刷新成功后通过 `get_repo_branch_overview(path)` 更新卡片级分支快照；用户打开分支总览时复用短时缓存，过期后再按需加载。
- 分支状态按 `comparison_state/ahead/behind/is_remote_only/upstream_gone/is_checked_out_elsewhere` 归类为：已同步、领先、落后、分叉、仅远端、无上游、upstream gone、detached、其它 worktree、比对失败。
- 当仓库满足“可写分支”条件（无未提交改动、无冲突、当前不在同步/排队/检查/刷新）时，分支行显示对应按钮；整行不执行写操作。
- 本地非当前分支按钮调用 `switch_repo_branch(path, branch)`；远端仅存在分支按钮调用 `switch_repo_branch(path, branch, remote_branch)`，必须传入精确远端引用（如 `origin/topic`），不再猜测 preferred remote。
- 卡片提示只有在唯一目标为“本地分支仅落后 upstream”时才调用 `switch_and_update_repo_branch(path, branch)`；后端在同一仓库 Git 锁内执行 clean-worktree 检查、fetch、ahead/behind 复核、切换和 `merge --ff-only <upstream>`。目标有本地领先提交时会在切换前拒绝。
- upstream gone 分支可调用 `rebind_repo_branch_upstream(path, branch, upstream)` 重新绑定唯一同名远端，或调用 `unset_repo_branch_upstream(path, branch)` 取消上游。
- 分支写操作结束后会刷新目标仓库远端引用、当前状态、缓存元数据和分支总览，保证卡片分支显示与实际一致。

### 目录缺失仓库处理（2026-04-03）

- 前端通过路径相关错误关键词识别“仓库目录缺失”，并在内存中记录 missing 状态与提示文案。
- RepoCard 在 missing 状态显示半透明遮罩，集中展示错误说明与“从列表移除”操作；主操作按钮与更多菜单会被禁用。
- 同步前检查会对 missing 仓库直接返回阻断项，不再调用后续远端检查。
- `fetch`/状态轮询/自动同步会跳过 missing 仓库，直到目录恢复并重新成功访问后自动清除该状态。

### 远端刷新失败与状态待刷新（2026-04-06）

- 前端把 `refresh_repo_remote` 失败与 `get_repo_status` 失败统一记录到 `repoStatusIssues`，并按仓库维度存储最近一次失败时间。
- RepoCard 在保留原有“错误 / 冲突 / 有改动”优先级的前提下，会追加“待刷新”徽标与提示条，用来表达“当前展示的是最近一次成功快照，可能不是最新状态”。
- Dashboard 统一列表继续通过卡片“待刷新”徽标表达刷新失败，不再把刷新失败仓库移入独立分组；status filter 只在明确的状态语义下筛选。
- 手动点击“获取更新”失败时展示完整失败汇总；首次启动自动执行的初始化 `fetch` 失败则显示轻提示 toast，减少打断但仍保留可见反馈。

---

## Tauri 命令清单

| 命令 | 说明 | 参数 |
|------|------|------|
| `is_git_repo` | 检查路径是否为 Git 仓库 | `path` |
| `open_repo_directory` | 使用系统文件管理器打开仓库目录 | `path` |
| `open_repo_directory_with_app` | 使用指定应用打开仓库目录 | `path`, `app` |
| `get_repo_status` | 获取当前分支与工作区状态（执行前校验仓库目录存在且为目录；不枚举非当前分支） | `path` |
| `refresh_repo_remote` | 刷新仓库远端引用（`git fetch --all --prune`） | `path` |
| `get_repo_branch_overview` | 获取按需分支总览（本地/远端分支、ahead/behind、remote-only、upstream gone、worktree、detached HEAD） | `path` |
| `switch_repo_branch` | 切换本地分支，或按精确远端引用创建并跟踪远端分支；工作区/暂存区有未提交改动时拒绝 | `path`, `branch`, `remote_branch?` |
| `switch_and_update_repo_branch` | 切换到唯一安全的落后本地分支并 fast-forward；会先 fetch，分叉或本地领先时在切换前拒绝 | `path`, `branch` |
| `rebind_repo_branch_upstream` | 将本地分支重新绑定到指定远端 upstream | `path`, `branch`, `upstream` |
| `unset_repo_branch_upstream` | 取消本地分支 upstream | `path`, `branch` |
| `refresh_repo_git_metadata` | 刷新单个仓库缓存的当前 branch 与 preferred remote | `repo_id` |
| `get_repos` | 获取所有仓库列表 | — |
| `add_repo` | 添加仓库 | `path` |
| `clone_repo` | 克隆远程仓库并自动加入仓库列表 | `repo_url`, `parent_path` |
| `remove_repo` | 移除单仓库（内部复用批量删除逻辑） | `repo_id` |
| `remove_repos_batch` | 批量移除仓库（返回 `requested_count/removed_ids/missing_ids`） | `repo_ids` |
| `restore_repos` | 批量恢复已移除仓库（Undo） | `repos` |
| `check_sync_prerequisites` | 同步前检查（本地改动/远端/冲突风险；执行前校验仓库目录） | `repo_id` |
| `update_repo` | 更新仓库配置 | `repo_id`, 可选字段 |
| `update_repos_batch` | 批量更新仓库配置（单次保存） | `repo_ids`, 可选字段 |
| `sync_repo` | 同步仓库（异步；开始阶段先校验仓库目录，缺失时直接失败返回） | `repo_id` |
| `run_repo_build_script` | 执行仓库同步后脚本 | `repo_id`, `script_path`, `log_session_id?`, `use_system_terminal?` |
| `resolve_conflict` | 解决单个文件冲突 | `repo_path`, `file_path`, `strategy` |
| `resolve_all_conflicts` | 批量解决所有冲突 | `repo_path`, `strategy`, `repo_id` |
| `abort_merge` | 中止合并/rebase | `repo_path`, `repo_id` |
| `get_conflict_files` | 获取冲突文件列表 | `repo_path` |
| `get_log` | 获取提交历史 | `repo_path`, `count` |
| `github_start_device_auth` | 开始 GitHub Device Flow 授权 | — |
| `github_poll_token` | 轮询 GitHub token，成功后保存 token 并返回账号信息 | `device_code` |
| `github_get_account` | 从系统凭据读取 token 并获取当前 GitHub 账号 | — |
| `github_get_repos` | 分页获取当前 GitHub 账号可见仓库 | `page` |
| `github_logout` | 删除系统凭据中的 GitHub token | — |

---

## Rust 依赖

| Crate | 用途 |
|-------|------|
| `tauri` v2 | 框架核心 |
| `tauri-plugin-dialog` | 系统文件选择对话框 |
| `tauri-plugin-store` | 插件注册（备用） |
| `tauri-plugin-shell` | Shell 命令权限 |
| `tauri-plugin-opener` | 打开外部链接 |
| `serde` / `serde_json` | 序列化/反序列化 |
| `tokio` | 异步运行时 |
| `chrono` | 日期时间格式化 |
| `reqwest` | GitHub OAuth 与 REST API HTTP 请求 |
| `keyring` | GitHub access token 安全存储 |

---

## 开发与构建

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run tauri dev

# 构建生产版本
npm run tauri build
```

---

## 后续迭代建议

### P0：任务编排层（已完成，2026-03-01）

- [x] 同步队列（统一调度入口）
- [x] 并发数限制（全局/可配置）
- [x] 任务取消、失败重试
- [x] 队列状态可视化（排队、执行、完成、失败）

实现说明：
- 调度层统一管理 `enqueue -> running -> finished` 生命周期，避免散点触发。
- 并发数由设置项 `maxSyncConcurrency` 统一控制（同步队列、状态读取、定时远端 Fetch、同步前检查）。
- 取消支持“排队任务直接取消”和“运行中任务软取消（当前步骤后停止）”。
- 重试支持按仓库最近失败/取消任务重新入队（尝试次数递增）。
- 队列状态以仓库卡片维度展示；顶部全局队列面板已移除。

### P1：可观测性（已完成，2026-03-01）

- [x] 同步历史中心（时间线 + 统计）
- [x] 记录每次同步的开始/结束/耗时/结果
- [x] 错误摘要与仓库、分支、提交关联
- [x] 历史检索与筛选
- [x] 按仓库分组，支持收起/展开及动画过渡

### P2：安全兜底（已完成，2026-03-01）

- [x] 同步前检查规则：本地改动、远端配置、冲突风险
- [x] 规则策略：阻断 / 仅警告
- [x] 仓库移除支持 Undo
- [x] 仓库卡片显示本地未提交改动提示

实现说明：
- 新增后端命令 `check_sync_prerequisites` 统一返回检查结果（本地改动、远端、冲突风险）。
- 同步入口统一走 guard 流程，按设置策略决定阻断或仅警告后继续。
- 删除仓库后提供限时撤销（Undo），通过 `restore_repos` 进行恢复。

### 其他高价值候选

- [ ] 全局搜索与筛选（名称、路径、分支、状态）+ 筛选后批量操作
- [ ] 每仓库独立配置（间隔、pull 策略、参与全部同步、默认打开应用覆盖）
- [ ] 托盘运行 + 开机启动 + 后台自动同步
- [ ] 导入增强：目录扫描发现 Git 仓库并分组导入
- [ ] 通知中心（成功静默、失败提醒、点击直达日志）
- [x] 设置持久化（主题、布局、同步默认配置、默认打开应用）
- [ ] Windows 平台测试与打包
- [ ] 多语言国际化 (i18n)
