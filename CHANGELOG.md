# Changelog

## [v0.3.4] - 2026-08-25

### 修复（捆绑运行时自愈）

- **捆绑运行时不完整时自动重解压**（`src/main/dsh/install.ts`）：此前 `ensureBundledRuntime` 仅以 `@deepseek-ai/dsh` 目录存在 + `.extract-complete` 标记判断「已解压」，若某次解压不完整（如首次解压被中断/早期 tar 版本漏文件，缺 `dsh-app-boot` 或 `js-yaml`），已写标记会让残缺树被永久跳过，DSH spawn 时报 `ERR_MODULE_NOT_FOUND: Cannot find package 'js-yaml'`（Web 服务无法启动）：
  - 新增 `bundledRuntimeComplete(dir)` 完整性门：解压树必须同时存在 `@deepseek-ai/dsh/lib/bin.js`、`@deepseek-ai/dsh-app-boot/lib/index.js`、`js-yaml/package.json`；
  - `ensureBundledRuntime` 在解压前（含标记已存在时）与解压后双重校验，残缺则清目录从随包 tarball 重解压，解压结果校验通过才写标记（未通过不写、下次启动重试）；
  - dev 模式下 `.dsh-runtime` 残缺时提示 `npm run fetch-dsh` 修复，不落入无人使用的解压路径；
  - `switchTo('bundled')` 改用同一完整性判定（`versions.ts`），残缺树不再被当成可用运行时不预检放行；
  - 新增 `test/install-runtime.test.mjs`（4 用例：空目录/仅 dsh 包判定、dev 完整分支、缺 tgz 分支）。

## [v0.3.3] - 2026-08-25

### 新增（内置插件预设）

- **内置插件预设**（`src/main/builtin-plugins.ts`）：dsh-desktop 内置 `@siliconflow-official/dsh-llm-siliconflow` 插件清单，应用启动时幂等安装并默认启用，随后经既有 patch overlay 自动挂载进 DSH——安装完成即出现「内置」来源的 `llm-siliconflow` 插件（控制面板可启停/卸载，来源徽标「内置」），DSH Web 模型/提供方选择器出现 `SiliconFlow` 提供方路由，用户全程零操作：
  - 清单锁定版本（`0.2.0-rc.1`），与插件目录内 `package.json` 版本比对决定是否重装；已就绪时启动检查零网络、零 npm（仅读目录 + 读一个 `package.json` + 一次入口检查）；
  - 安装编排：下载固定 registry tarball（60s 超时）→ `rmRobust` 替换旧目录 → 系统 `tar.exe` 解压（`--strip-components=1`）→ `resolveEntry` 校验后写 `PluginRecord`（`source: 'preset'`、`enabled: true`）→ 依赖安装（沿用 `installPluginDeps` 串行队列，npm ≥ 7 自动装 peerDependencies）；
  - 失败隔离：任一环节失败仅 `appLog.warn` 告警（中文原因，如「tarball 下载失败: …」），不写虚假记录、不阻断应用与 DSH 启动（DSH 无启用插件时按现状不带 `--patch` 启动）；
  - 卸载抑制：卸载 preset 插件时写入 `config.json` 的 `suppressedPresets`，重启不再自动重装（恢复方式：手工移除 `suppressedPresets` 对应项后重启，本期无恢复 UI）。

## [v0.3.2] - 2026-08-24

### 修复（插件管理模块）

- **插件依赖未安装导致 DSH 启动即崩溃（crashed code 1）**：安装本地/Git 插件只拷贝源码目录，未安装其 npm `dependencies`（如 `@deepseek-ai/dsh-tools`），DSH 启动时 cordis 加载器 import 插件入口抛 `ERR_MODULE_NOT_FOUND`、进程退出。现新增 `src/main/plugin-deps.ts` 依赖探测与串行安装：`needsDepsInstall` 纯同步探测（零网络），`installPluginDeps` 串行执行 `npm install`（npm 解析顺序：Node 同目录自带 npm → 捆绑运行时 vendored npm → PATH 上 npm；10 分钟超时杀进程树；失败返回中文摘要 + stderr 末 500 字符）；本地/Git 插件（含 monorepo 子插件）安装完成后异步触发依赖安装；启动前 `ensureEnabledPluginsReady` 对启用插件补装缺失依赖，安装失败插件从本次 patch overlay 剔除、继续启动其余插件，失败原因写入插件记录 `depsError` 并在控制面板展示「依赖安装失败：<原因>」、聚合进 `DshStatus.detail`；依赖已满足时零 npm 调用、无额外启动延迟。

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