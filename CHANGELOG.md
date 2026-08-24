# Changelog

## [v0.3.1] - 2026-08-24

### 修复（插件管理模块）

- **Git 克隆插件导致面板卡死**：`addGitPlugin` 原用 `spawnSync` 同步执行 `git clone`（最长阻塞主进程 5 分钟），期间所有窗口无响应。现改为异步 `spawn` + Promise（`cloneGitAsync`），克隆期间主进程保持事件循环，面板可正常操作；
- **卸载插件后条目未删除**：`removePlugin` 中 `rmRobust(rec.dir)` 在 Windows 上可能因只读/文件锁定抛异常，导致后续 `mutateConfig` 不执行、配置记录残留、列表条目一直在。现以 try/catch 包裹磁盘删除，无论删除成败配置记录均被移除（失败仅记警告日志）；
- **多层级子目录插件无法识别**：原仅在克隆仓库根目录找入口（`package.json main` / `index.js`），monorepo 布局（如 `packages/<plugin>/`）直接报"未找到插件入口"。现根目录无入口时扫描 `packages/*/` 与 `plugins/*/` 子目录，每个有效插件独立复制安装为一条插件记录，安装完成后清理克隆裸仓库；`addGitPlugin` 返回值改为 `PluginView[]`，面板 toast 显示"已克隆 N 个插件：…"。

## [v0.3.0] - 2026-08-24

### 新增

- **双版本号发版规范**（`package.json` / `.github/workflows/`）：发版版本 = `dsh-desktop版本-上游DeepSeek Harness标识`（如 `0.3.0-0.1.1-rc.2`），两个版本号严禁混淆；
  - 上游标识按最新程度自动选择：发布 tag 版本更新 → tag 规范化版本号（`dsh-vX.Y.Z` → `X.Y.Z`）；上游默认分支仅提交更新 → 提交 sha 前 7 位；
  - tag 规则：main 分支 → `v{APP_VERSION}-{上游标识}`；其它分支 → 追加清洗后分支名；
  - `poll-upstream.yml` 与 `build-and-release.yml` 幂等判定与 Release notes 同步改为复合 tag/复合版本。
- 文档交付（`docs/ARCHITECTURE.md` / `docs/DEPLOYMENT.md` / `docs/CONTRIBUTING.md` + 重写 `README.md` 12 章节，原 README 备份为 `README.original.md`）。

### 修复

- `package-lock.json` 根版本与 `package.json` 同步（此前为 0.1.0，落后于 0.2.1）。

## [v0.2.1] - 2026-08-23

### 修复

- `build-and-release.yml`：NSIS/zip 两个 electron-builder 步骤注入 `GH_TOKEN`（`${{ github.token }}`）。此前未设置时，electron-builder 下载 winCodeSign/nsis 工具链的匿名 GitHub API 请求被限流，构建报 “GitHub Personal Access Token is not set” 中止，导致无任何 Release 产物。

## [v0.2.0] - 2026-08-23

### 新增

- CI/CD 双工作流（`.github/workflows/`）：
  - `poll-upstream.yml`：每小时定时 + `workflow_dispatch`（`force` / `release_mode` / `override_version`）巡检 `deepseek-ai/deepseek-harness` 上游最新 Release tag 与默认分支最新 commit；新版本 → 调 `build-and-release.yml` 发正式版，仅 commit 变化 → 发 `v{V}-dev-{sha7}` 候选版（prerelease），无变化幂等退出；run summary 记录巡检结果。
  - `build-and-release.yml`：任意分支 push / `workflow_call` 复用 / 手动触发；Node 22 + `npm ci` 构建链（typecheck → make-icons → fetch-dsh → build → pack-runtime → NSIS + zip → checksums）；tag 规则 main = `v{V}`、其它分支 = `v{V}-{清洗后分支名}`；目标 tag 已存在即幂等跳过；`gh release` 标题 `DSH Desktop v{V}`，资产 exe/zip/checksums，run summary 含版本/tag/资产/上游引用。

### 变更

- 移除旧三工作流 `ci.yml` / `upstream.yml` / `release-build.yml` 与陈旧状态文件 `.github/upstream-state.json`（备份于 `Y:\zcode\dsh-ci-backup\workflows-20260823`）。

## [v0.1.0] - 2026-08-23

- 首版：Electron + TypeScript 的 DeepSeek Harness 桌面封装（主窗口 + 悬浮球控制面板 + 托盘 + 开机自启），NSIS 安装包与 zip 便携版双产物，捆绑上游最新 DSH 运行时。