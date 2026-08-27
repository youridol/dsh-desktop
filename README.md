# DSH Desktop

## 项目简介

DeepSeek Harness（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，简称 DSH）的 Windows x64 桌面封装：以 Electron 窗口内嵌 DSH 原生 Web UI，附带悬浮球控制面板、插件管理、版本管理、系统托盘与开机自启。

项目不改动 DSH 源码，插件能力经 dsh harness 上游插件机制（`dsh plugin --profile web`，npm/pnpm 包）管理并挂载到 Web profile，Skills 为桌面端自管理的仓库/作用域/备份体系，桌面端仅做 CLI 调用方与 UI 封装，细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 与 deepseek-harness 的关系（完全放行）

dsh-desktop 对 deepseek-harness 采取**完全放行、行为优先**原则：

- **零限制**：不对 harness 的安装 / 执行 / 构建 / 插件 / Web UI 操作设置任何拦截、限制、沙箱、安全保护或二次阻断；命令层完整透传环境与参数（`DshCommandExecutor` / `manager` / `install` 均以数组参数直传，不注入 `ignore-scripts` 或任何限制性环境变量）。
- **环境支持（npm / npx / pnpm 均可调用）**：harness 自行决定并调用 npm / npx / pnpm（如 `dsh plugin` 在 Profile 目录内 `spawnSync("pnpm", …)`）。dsh-desktop 在启动 harness 子进程时自动将本机标准工具链目录（Node 安装目录、`npm prefix -g` 全局 bin、`%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、`~/.pnpm/bin`、nvm / volta 目录等）合并进 PATH（`src/main/dsh/toolchain.ts`）——只做环境准备，绝不代理 / 拦截 / 转换 / 重写任何包管理命令，harness 的包管理行为完全保持原生。
- **行为优先**：主窗口承载 DSH Web UI 时不拦截弹窗 / 新窗口（`window.open` 由 harness 自身原生决定）；仅使用 harness 官方 CLI 选项（如 `--no-open`，壳层内嵌 UI 的标准集成方式）与僵死进程看门狗超时，均不构成对 harness 行为的限制。
- **不修改上游**：从不改写 deepseek-harness 源码 / 配置；唯一写入的是 dsh-desktop 自身管理的 Profile 策略文件（如 pnpm `allowBuilds`），目的是**解除** pnpm 默认的构建脚本拦截，让安装 / 构建照常进行。
- **输入护栏**：控制面板的插件名 / Profile 输入校验（拒绝 shell 元字符、镜像 harness 自身 profile 名校验）只保护 dsh-desktop 自己的 UI 输入，不对 harness 行为设限。

## 功能特性

- **冷启动即用**：双击启动后自动拉起捆绑的 DSH 服务（`dsh web --no-open --port …`，见 `src/main/dsh/manager.ts`），主窗口在服务就绪后自动加载 Web UI；10 秒内未就绪显示错误页与重试按钮（`READY_TIMEOUT_MS`，`src/main/dsh/manager.ts`）。
- **悬浮球控制面板**：主窗口右下角悬浮球（可拖动、位置记忆，`src/main/windows/floating.ts`），单击开关独立子窗口控制面板（`src/main/windows/control.ts`，无任务栏项、随主窗口隐藏与恢复）；控制面板 UI 设计令牌与组件表现完全对齐 deepseek-harness 原生 Web UI（`src/renderer/control/style.css`，取自官方主题包 `@deepseek-ai/dsh-client-ui-theme` 暗色语义色板 / 字体 / 圆角 / 阴影，左侧导航栏布局）。
- **仪表盘（Dashboard）**（`src/renderer/control/tabs/dashboard.ts` + `tabs/dashboard/widgets/`）：控制面板默认页签，统一监控 DSH 服务运行状态、插件概要、版本概要与最近异常；监控模块经统一 Widget 注册表挂载，新增监控模块无需改核心架构。
- **Skills 管理**（`src/main/services/skills/` + `src/renderer/control/tabs/skills.ts`）：独立 Skills 页签，全部能力在 dsh-desktop 内自管理，不修改 deepseek-harness 上游源码：
  - 自定义 Skills 仓库（默认示例 `https://github.com/mattpocock/skills`），添加 / 编辑 / 删除 / 启用停用 / 拉取刷新 / 全部同步；
  - 全局作用域 = deepseek-harness 真实 Agents/Skills 目录（`~/.agents/skills`，经 `$DSH_AGENTS_HOME` / 用户 Home 统一解析）：已有 Skills 自动发现并展示，安装按 harness 目录束规范（kebab 名 + SKILL.md 前导），启停写 `disable-model-invocation` / `user-invocable` 前导策略对上游真实生效；单 / 批量启用、停用、卸载、删除；查看技能信息（来源仓库 / 路径 / commit / 状态）；
  - Agent 管理：全局 / 项目 Agent 目录中的本机技能（目录束 / 扁平 Markdown）自动读取、区分展示，支持刷新、启停与删除，不修改 deepseek-harness 上游源码；
  - 检测上游更新并执行更新同步；GitHub Skills 搜索与一键安装；
  - 导出 / 导入 / 备份 / 恢复，导入时校验格式、版本、路径与冲突（`test/skills-service.test.mjs` 覆盖核心逻辑）。
- **插件管理**（`src/main/services/dsh/DshPluginService.ts` + `src/main/services/dsh/DshPluginInstaller.ts` + `src/renderer/control/tabs/plugins.ts`）：dsh-desktop 是 dsh harness 上游插件机制的桌面端管理工具——所有插件操作经 `dsh plugin --profile \u003cprofile\u003e \u003cadd|remove|…\u003e` CLI 调用（npm/pnpm 包解析与依赖安装交给 dsh harness），插件列表实时读取 profile manifest（`$DSH_HOME/profiles/web/package.json`），安装来源（npm / npx / dsh）与 Profile 作为元数据写入 manifest 并展示在列表中：
  - 安装方式可选 npm / npx / dsh：npm 与 npx 默认安装到 `web` profile，dsh 可指定任意 Profile（对应 `dsh plugin --profile \u003cprofile\u003e add \u003c包名\u003e`），不自行 git clone / npm install / 下载 tarball；
  - 插件名可填 GitHub / git 地址（`github:owner/repo`、`https://github.com/...` 等）；pnpm 拦截构建脚本时可一键「放行构建脚本并重试」（真实写入 Profile 的 `pnpm-workspace.yaml` `allowBuilds` 并自动重装，详见下文「插件安装来源」）；
  - 启用 / 禁用（编辑 `dsh.profile.bundles`）/ 卸载 / 导出（复制包名+版本到剪贴板）/ 刷新；
  - 来源识别：插件列表用标签展示「来源：npm / npx / dsh」与「Profile：\u003c名称\u003e」，安装与卸载按记录来源与 Profile 路由（详细说明见下文「插件安装来源」）；
- **插件市场（dsh-market）**（`src/main/services/dsh/DshMarketService.ts` + `src/main/windows/market.ts` + `src/renderer/control/tabs/plugins.ts`）：dsh-desktop 仅作为官方插件市场 dsh-market 的快捷配置入口，不重复实现市场逻辑——
  - 本地未安装 dshmarket 时自动安装（复用既有 npm 安装通道：`dsh plugin --profile web add dshmarket`，安装来源记为 npm）；
  - 「打开市场原生界面」打开独立窗口，以与主窗口完全相同的路径加载 DSH Web UI 并自动定位到 设置 → 插件市场——直接承载 dsh-market 官方原生 React 组件（浏览 / 搜索 / 一键安装 / 更新 / 卸载），行为与主窗口完全一致（`src/main/windows/market.ts`）；
  - 「在主窗口打开」聚焦主窗口并打开 DSH Web 界面的 设置 → 插件市场（等效用户点击的定位，不改动 deepseek-harness / dsh-market 任何代码）；
  - 市场状态展示：已安装版本 / 已启用 / 已挂载（探测 /dsh-market/status）；
  - 三通道安装（npm / npx / dsh）与已安装列表保留，作为市场不可用（离线等）时的本地管理兜底；
- **版本管理**（`src/main/versions.ts` + `src/main/dsh/releases.ts`）：检查 `deepseek-ai/deepseek-harness` 的 GitHub Releases 与默认分支最新 commit；下载新版本（经 npm registry 安装到运行目录 `versions/`）、切换、回退、删除，本机版本列表离线可判定。
- **日志与状态**（`src/main/logger.ts` + `src/renderer/control/tabs/status.ts`）：DSH 进程状态、端口、PID、实时日志滚动（应用 / DSH / 安装三类来源，镜像到运行目录 `logs/main.log`）。
- **设置**（`src/renderer/control/tabs/settings.ts`）：DSH 端口（修改后重启生效）、开机自启、启动时检查更新、GitHub 凭据（用于版本的 Releases 查询限流提升）。
- **托盘常驻**（`src/main/tray.ts`）：最小化 / 关闭隐藏到托盘；托盘菜单显示主窗口、打开控制面板、彻底退出。

## 插件安装来源

dsh-desktop 的插件安装统一经 dsh harness 的原生插件通道执行（npm registry 包，或 GitHub / git 安装地址）：

```bash
dsh plugin --profile <profile> add <plugin>
```

例如：

```bash
dsh plugin --profile web add dshmarket
```

三种安装方式的区别（来源在安装时确定，并作为插件元数据持久化保存）：

| 安装方式 | 含义 | 执行通道 |
| --- | --- | --- |
| `npm` | 以 npm 包形式安装为 profile 依赖（默认 `web` profile） | `dsh plugin --profile web add <包名>` |
| `npx` | 以 npx 工具包形式安装（CLI 类工具，同样为 npm 包） | `dsh plugin --profile web add <包名>` |
| `dsh` | dsh 原生 Profile 安装，需指定 Profile | `dsh plugin --profile <profile> add <包名>` |

安装后元数据（来源 + Profile + 安装时间）写入 profile manifest 的 `dsh.desktop.plugins`；插件列表以标签展示「来源：npm / npx / dsh」与「Profile：<名称>」。卸载按记录中的 Profile 路由到对应 `dsh plugin --profile <profile> remove`，启用 / 禁用同样作用于记录中的 Profile。旧版本已安装的插件没有来源记录，默认按 `dsh` / `web` 兼容显示与操作。

通过 UI 安装：控制面板 → 插件页签 → 选择安装方式（npm / npx / dsh）→ 填写插件名称或 GitHub/git 地址（dsh 时还需填写 Profile，如 `web`）→ 点击安装。「dsh」不需要手填完整 CLI 命令，Profile 与插件名作为独立参数安全传递。若本机没有可用的 dsh CLI（未安装 DeepSeek Harness 或未加入 PATH），安装会返回明确错误 `未检测到可用的 dsh CLI，请先安装 DeepSeek Harness 并确保 dsh 命令已加入 PATH`，不会导致应用崩溃。

**GitHub / git 插件安装**：插件名可直接填 `github:owner/repo`、`https://github.com/owner/repo`、`git+https://...` 等 pnpm 支持的 git 安装地址，由 `dsh plugin --profile <profile> add <spec>` 转发。pnpm（≥10）默认出于供应链安全拒绝依赖构建脚本（如 GitHub 插件的 `prepare`，报 `build scripts are blocked by pnpm by default` / `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），此时控制面板会弹出「放行构建脚本并重试」：确认后 dsh-desktop 将 pnpm 打印的精确包 spec 写入该 Profile 的 `pnpm-workspace.yaml` `allowBuilds`（并同步 `pnpm.onlyBuiltDependencies` 兼容 pnpm 9 / pnpm 10 ≤ 10.25），随后自动重新安装 / 构建——授权是真实策略写入并立即重试，不是仅修改 UI 状态；该放行记录会持久化，后续更新同一插件不再被拦截。dsh-desktop 只操作 Profile 策略文件，不修改 `deepseek-harness` 上游代码，也不对 Harness 安装 / 执行 / 构建 / 插件操作设置任何额外拦截、沙箱或二次阻断。

## 技术栈

| 类别 | 选型 | 版本 | 来源 |
| --- | --- | --- | --- |
| 主语言 | TypeScript（strict，ES2023） | 5.9.x | `tsconfig.json`、`package.json` |
| 桌面框架 | Electron | ^43.4.1 | `package.json` `devDependencies` |
| 构建工具 | esbuild | ^0.28.2 | `package.json`、`scripts/build.mjs` |
| 打包工具 | electron-builder | ^26.15.3 | `package.json`、`electron-builder.yml` |
| 包管理器 | npm（lockfile 版本 3） | ≥ 20（CI 用 22） | `package-lock.json`、`.github/workflows/build-and-release.yml` |
| 渲染层 | 原生 HTML / CSS / TypeScript，无前端框架；控制面板 UI 对齐 DSH 原生 Web UI 设计系统（`--dsw-*` 令牌） | — | `src/renderer/`、`scripts/build.mjs` |
| 运行时依赖（bundled） | `js-yaml`（pnpm-workspace.yaml 策略解析，esbuild 打入 `dist/main.js`，打包产物无运行时 node_modules） | ^4.3 | `package.json` `dependencies`、`src/main/services/dsh/pnpmBuildPolicy.ts` |
| 工具链环境支持 | npm / npx / pnpm 标准目录发现 + PATH 合并（仅环境准备，不拦截 / 改写命令） | — | `src/main/dsh/toolchain.ts`、`src/main/dsh/nodebin.ts` |
| 捆绑运行时 | `@deepseek-ai/dsh` + 内置 npm CLI | 随上游 Release | `scripts/fetch-dsh.mjs` |
| 许可证 | MIT | — | `LICENSE`、`package.json` |

## 快速开始

前置条件：Windows x64、Node.js ≥ 20、npm、Git。

```bash
git clone https://github.com/youridol/dsh-desktop
cd dsh-desktop
npm install        # 安装 Electron / electron-builder / esbuild 等开发依赖
npm run fetch-dsh  # 下载捆绑版 DSH 运行时与内置 npm CLI 到 .dsh-runtime/
npm run dev        # esbuild 编译并启动应用（开发模式，运行数据在项目 runtime/）
```

`npm run dev` 弹出主窗口，等待 DSH 服务就绪后加载 Web UI；右下角悬浮球单击打开控制面板。

## 安装指南

面向终端用户：从本项目 [GitHub Releases](https://github.com/youridol/dsh-desktop/releases) 下载两种产物之一。

1. **NSIS 安装包**（`DSH Desktop Setup*.exe`）：
   - 双击运行，按向导安装（默认每用户安装，可修改安装目录）；
   - 安装完成自动创建桌面与开始菜单快捷方式；
   - 运行数据（配置 / 凭据 / 插件 / 版本 / 日志）保存在 `%APPDATA%\DSH Desktop\`。
2. **zip 便携版**（`DSH Desktop-*-win.zip`）：
   - 解压到任意目录，运行解压目录内的 `DSH Desktop.exe`；
   - 运行数据保留在 exe 所在目录（`resources\portable.marker` 标记，见 `scripts/after-pack.mjs`），整体移动目录即可迁移。

两种产物的应用本体不依赖系统 Node：优先使用系统 `node`（DSH 的 HMR 需要 `--expose-internals`），无 Node 时自动回退到 `ELECTRON_RUN_AS_NODE` 模式使用 Electron 自带的 Node 运行时（`src/main/dsh/nodebin.ts`）。

## 使用说明

主窗口内嵌 DSH Web UI；主窗口右下角悬浮球单击弹出控制面板，含五个页签：

| 页签 | 功能 | 操作要点 |
| --- | --- | --- |
| 仪表盘 | 统一监控：DSH 服务 / 插件概要 / 版本概要 / 异常汇总 | 各监控卡片独立刷新（DSH 服务卡含启停操作）；卡片内的「管理插件 / 版本管理 / 查看日志」可直接跳转对应页签；异常卡支持清空日志 |
| 插件 | 插件市场 / 安装 / 启停 / 卸载 / 导出 / 应用 | 顶部「插件市场」卡片：本地未装自动安装；「打开市场原生界面」在独立窗口直接承载 dsh-market 原生 Web UI（设置 → 插件市场，浏览 / 搜索 / 一键安装社区插件）；「在主窗口打开」聚焦主窗口定位到市场；下方保留 npm / npx / dsh 三通道安装与已安装列表作为本地管理兜底；"应用并重启 DSH"使改动生效（详见上文「插件安装来源」与「插件市场」） |
| Skills | 仓库管理 / 安装 / 启停 / 批量 / 更新 / 搜索 / 备份迁移 | 先添加仓库并同步（默认示例 mattpocock/skills）；展开仓库查看可安装技能，安装到全局或项目作用域；"检测更新"对比来源 commit；"创建备份"写入运行目录备份 |
| 版本 | 检查 / 下载 / 切换 / 回退 / 删除 | 来源可选"最新发布版本"或"最新提交（源码）"；本机版本列表离线可读；不能删除当前使用中的版本 |
| 日志 | 进程状态 / 实时日志 | 状态卡显示 DSH 状态、端口、PID、运行版本；日志滚动显示应用 / DSH / 安装三类来源 |
| 设置 | 端口 / 自启 / 更新检查 / 凭据 | 端口修改后需"保存并重启 DSH"；开机自启开关；GitHub 凭据用于版本的 Releases 查询限流提升，仅保存在运行目录 `credentials.json`，**明文，请勿外泄、勿提交** |

关闭主窗口（或最小化）应用隐藏到托盘而不是退出；托盘菜单提供"显示主窗口 / 打开控制面板 / 退出"。首次启动若捆绑运行时尚未解压，日志区会显示解压进度（约半分钟，见 `src/main/dsh/install.ts` 的 `ensureBundledRuntime`）。

## 开发指南

环境搭建与前置步骤见本章"快速开始"；数据目录约定见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 第 5 节。

- **调试**：`npm run dev` 以开发模式启动（`package.json`），主进程日志输出到运行目录 `logs/main.log` 并实时回传控制面板；
- **自动化验证**：以 `--remote-debugging-port=9222` 启动应用后，用 `node scripts/e2e-driver.mjs <step> [args]` 经 CDP 调用控制面板的 `window.dshc` 桥接做端到端断言（`scripts/e2e-driver.mjs`，可执行 step：`state` / `check` / `plugins` / `versions` / `download` / `switchTo` / `setPort` / `restart` 等），示例插件 fixture 在 `.e2e/test-plugin/`；
- **类型检查**：`npm run typecheck`（`tsc --noEmit`，strict）。
- **Skills 逻辑测试**：`node --test test/skills-service.test.mjs`（校验 / 发现 / 仓库注册表 / 生命周期作用域隔离 / 备份导入）。
- **扩展仪表盘**：新增监控模块只需在 `src/renderer/control/tabs/dashboard/widgets/` 新建文件实现 `DashboardWidget` 并 `registerDashboardWidget` 注册，再在 `tabs/dashboard.ts` 顶部 import；无需改 app.ts / preload / IPC（注册表见 `tabs/dashboard/widget.ts`）。
- **代码规范**：无 ESLint / Prettier 配置，类型层约束由 `tsconfig.json` 的 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch` + `forceConsistentCasingInFileNames` 提供；新增模块需同步更新 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。

## 架构概览

应用为 Electron main / preload / renderer 三层：主进程负责窗口、托盘、自启、DSH 进程生命周期与版本 / 插件管理；preload 提供按窗口裁剪的窄桥接（`window.dshc` / `window.dshLoader` / `window.dshBall`，见 `src/preload/`）；渲染层为纯原生 HTML/CSS/TS 页面（loader 加载页、floating 悬浮球、control 控制面板）。

DSH 服务由主进程 spawn（`dsh web --no-open --port <n>`），插件经 Web profile（`dsh.profile.bundles`）在启动时自动挂载；端口轮询就绪后主窗口从本地 loader 页导航至 `http://127.0.0.1:<port>`；异常退出自动回到错误态。详见图与模块矩阵：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 部署指南

本地构建、CI/CD 自动发版、NSIS 与 zip 产物、运行目录与环境变量详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 贡献指南

分支策略、提交格式、PR 流程与代码审查清单见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。

## 常见问题 FAQ

- **启动后一直停留加载页 / 显示"启动超时"**：DSH 服务 10 秒内未就绪。检查端口是否被占用（设置页更换端口并重启）、查看日志页的 DSH 输出。
- **首次启动日志区显示解压进度占用约半分钟**：捆绑运行时（约 53MB 的 `dsh-runtime.tgz`）在首次启动时用 Windows 自带的 `System32\tar.exe` 解压到运行目录 `versions\_bundled\`，之后直接复用（`src/main/dsh/install.ts`）。
- **检查更新提示 GitHub 限流（403）**：匿名 API 限额耗尽。在设置页配置 GitHub 凭据后重试（`src/main/dsh/releases.ts` 的 `authHeaders`）。
- **便携版更新（切换版本）后"版本缺失"**：运行数据与 exe 同目录，整体移动目录后仍完整；若运行目录被清理，应用自动回退到捆绑版本并提示（`src/main/dsh/manager.ts` 的 `start`）。
- **插件无法加载**：确认插件是 npm 包且声明了 `dsh.bundle`（否则 dsh 只当普通依赖安装）；安装后点击"应用并重启 DSH"使其挂载（插件状态以 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 为准）。
- **GitHub 插件安装报「build scripts are blocked by pnpm by default」**：pnpm（≥10）默认拒绝依赖构建脚本（GitHub 插件的 `prepare`）。控制面板会弹出「放行构建脚本并重试」，确认后 dsh-desktop 将该包的精确 spec 写入该 Profile 的 `pnpm-workspace.yaml` `allowBuilds`（并同步 `pnpm.onlyBuiltDependencies` 兼容 pnpm 9 / 10 ≤ 10.25）并自动重新安装；放行记录持久化，后续更新同一插件不再被拦截。
- **插件 / 版本操作报「npm / npx / pnpm 不是内部或外部命令」（从快捷方式 / 开机自启启动时）**：桌面程序以精简 PATH 启动时，harness 自身的 npm / npx / pnpm 解析可能失败。dsh-desktop 已自动把本机标准工具链目录合并进 harness 子进程的 PATH（`src/main/dsh/toolchain.ts`，仅环境准备、不改写任何命令），一般无需手动处理；若本机使用自定义安装路径，可用环境变量 `DSH_DESKTOP_NODE` 指定 Node 目录（见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)）。
- **凭据保存在哪里**：仅存于运行目录 `credentials.json`（明文），`.gitignore` 已排除；卸载安装版需手动删除 `%APPDATA%\DSH Desktop\` 中的凭据文件。
- **需要不同 DSH 版本**：版本页"检查更新 → 下载并切换"；可回退到任意已安装版本或捆绑版本（`src/main/versions.ts` 的 `switchTo`）。

## 许可证

MIT License，见 [LICENSE](LICENSE)。Copyright (c) 2026 youridol。