# GitSync

GitSync 是一款管理多个本地 Git 仓库的桌面应用。它把仓库状态、同步、工作区改动和提交历史集中在一个界面中，支持 macOS 和 Windows。

## 下载与安装

从 [最新 GitHub Release](https://github.com/Zephinel/GitSync/releases/latest) 下载与你的系统对应的文件：

| 平台 | 下载文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `GitSync_<版本>_aarch64.dmg` | 打开 DMG，将 GitSync 拖入“应用程序”。支持应用内更新。 |
| Windows（x64，推荐） | `GitSync-setup.exe` | NSIS 安装版，支持应用内更新。 |
| Windows（x64，便携版） | `GitSync.exe` | 直接运行；新版本需要自行下载并替换文件。 |

目前没有发布 Intel Mac 或 Linux 安装包。使用仓库同步功能前，请确保系统已安装 Git，并且你有目标仓库所需的远端访问权限。

**macOS 首次启动：** 当前公开版的 DMG 未经过 Apple 开发者签名和公证，macOS 可能拦截首次打开。遇到提示时，可在系统的“隐私与安全性”中允许打开 GitSync。应用更新包的签名验证与 Apple 签名是两回事。

## 能做什么

- **查看多个仓库：** 仪表盘显示当前分支、工作区改动、领先或落后的提交、冲突及同步结果；可按状态筛选、排序和搜索仓库名，并切换列表或卡片布局。
- **导入与克隆：** 添加本地仓库、通过远端地址克隆，或登录 GitHub 后浏览并批量克隆账号下的仓库。GitHub 登录使用 Device Flow；仅需管理本地仓库时无需登录。
- **同步与检查远端：** 对单个仓库、当前筛选结果或选中的多个仓库执行同步；可暂停仓库、设置自动同步间隔与 Pull 策略，并在同步前检查本地改动和冲突风险。“获取更新”会抓取远端状态，不会直接合并改动。
- **处理改动与历史：** 查看工作区 Diff，暂存或取消暂存文件并提交；查看提交历史与提交 Diff，管理 Stash，以及查看、创建或切换分支。
- **追踪任务：** 在同步历史中查看结果和诊断信息；可为仓库配置同步后脚本。设置页还提供深色、浅色与跟随系统的外观选项。
- **可选 AI 辅助：** 自行配置 AI Provider 与 API Key 后，可生成提交信息、Review 改动或辅助命名分支。未配置 AI 时，常规 Git 功能仍可使用。

## 开始使用

1. 打开仪表盘，点击右上角的 **＋**，选择导入本地仓库、克隆仓库或浏览 GitHub 仓库。默认同步模式为“手动”，可在“设置 → 同步设置”调整。
2. 顶部左侧的下拉菜单用于**筛选**和**排序**；右侧图标依次用于切换布局、搜索、获取远端更新、进入批量操作及导入仓库。悬停图标可查看功能提示。
3. 在仓库卡片中查看状态并点击“同步”；通过卡片的改动入口处理工作区文件，通过分支行或“更多”查看分支、提交历史和其他操作。
4. 在侧边栏的“历史”查看同步记录；在“设置”配置同步策略、GitHub 登录、AI 和软件更新。

同步可能执行 Git Pull 或 Push。首次操作前建议检查仓库当前分支、未提交改动以及“设置 → 同步设置”中的同步前检查规则。

## 软件更新

正式版 macOS `.app` 和 Windows NSIS 安装版会在启动后检查公开 GitHub Release，并在后台下载可用更新；下载完成后由你确认安装。也可以在“设置 → 软件更新”手动检查。检查更新不需要登录 GitHub。Windows 便携版及开发构建不支持应用内安装更新。

安装前如果仍有 Git 任务或其他操作正在运行，GitSync 会显示等待或阻止重启；任务结束后可重试。`v0.1.0` 是首次公开版本，跨版本的应用内升级流程要等后续版本发布后才能完成真实验证。

## 从源码运行

需要 Node.js（`^20.19.0` 或 `>=22.12.0`）、npm、Rust、Git，以及对应平台的 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)。在仓库根目录运行：

```bash
npm ci
npm run tauri:dev
```

`npm run tauri:dev` 会启动当前源码的桌面调试版。`npm run dev` 只启动前端页面，不包含 GitSync 的桌面能力。

如需在开发版使用 GitHub 登录，请创建自己的 GitHub OAuth App、启用 Device Flow，并通过环境变量 `GITSYNC_GITHUB_CLIENT_ID` 提供 Client ID。Client ID 也可写在仓库根目录的 `github_client_id` 文件中；该文件已被 Git 忽略。不要把 Client Secret、访问令牌或 AI API Key 提交到仓库。

常用检查：

```bash
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

桌面发布由 [tag 发布工作流](.github/workflows/release-on-tag.yml)构建；它要求 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 的版本一致，并使用仓库配置的更新签名密钥。更新签名密钥与 Apple 开发者签名独立。

## 数据与许可

仓库配置保存在本机的应用数据目录；GitHub 登录令牌和 AI API Key 使用系统凭据管理器。GitSync 基于 Tauri、React 和 Rust，采用 [MIT License](LICENSE)。版本变化见 [CHANGELOG.md](CHANGELOG.md)。
