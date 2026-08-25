# DSH Desktop

## 项目简介

DeepSeek Harness（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，简称 DSH）的 Windows x64 桌面封装：以 Electron 窗口内嵌 DSH 原生 Web UI，附带悬浮球控制面板、插件管理、版本管理、系统托盘与开机自启。

项目不改动 DSH 源码，插件能力经 dsh harness 上游插件机制（`dsh plugin --profile web`，npm/pnpm 包）管理并挂载到 Web profile，桌面端仅做 CLI 调用方与 UI 封装，细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 功能特性

- **冷启动即用**：双击启动后自动拉起捆绑的 DSH 服务（`dsh web --no-open --port …`，见 `src/main/dsh/manager.ts`），主窗口在服务就绪后自动加载 Web UI；10 秒内未就绪显示错误页与重试按钮（`READY_TIMEOUT_MS`，`src/main/dsh/manager.ts`）。
- **悬浮球控制面板**：主窗口右下角悬浮球（可拖动、位置记忆，`src/main/windows/floating.ts`），单击开关独立子窗口控制面板（`src/main/windows/control.ts`，无任务栏项、随主窗口隐藏与恢复）。
- **插件管理**（`src/main/services/dsh/DshPluginService.ts` + `src/main/services/dsh/DshPluginInstaller.ts` + `src/renderer/control/tabs/plugins.ts`）：dsh-desktop 是 dsh harness 上游插件机制的桌面端管理工具——所有插件操作经 `dsh plugin --profile \u003cprofile\u003e \u003cadd|remove|…\u003e` CLI 调用（npm/pnpm 包解析与依赖安装交给 dsh harness），插件列表实时读取 profile manifest（`$DSH_HOME/profiles/web/package.json`），安装来源（npm / npx / dsh Harness）与 Profile 作为元数据写入 manifest 并展示在列表中：
  - 安装方式可选 npm / npx / dsh Harness：npm 与 npx 默认安装到 `web` profile，dsh Harness 可指定任意 Profile（对应 `dsh plugin --profile \u003cprofile\u003e add \u003c包名\u003e`），不自行 git clone / npm install / 下载 tarball；
  - 启用 / 禁用（编辑 `dsh.profile.bundles`）/ 卸载 / 导出（复制包名+版本到剪贴板）/ 刷新；
  - 来源识别：插件列表用标签展示「来源：npm / npx / dsh Harness」与「Profile：\u003c名称\u003e」，安装与卸载按记录来源与 Profile 路由（详细说明见下文「插件安装来源」）；
- **版本管理**（`src/main/versions.ts` + `src/main/dsh/releases.ts`）：检查 `deepseek-ai/deepseek-harness` 的 GitHub Releases 与默认分支最新 commit；下载新版本（经 npm registry 安装到运行目录 `versions/`）、切换、回退、删除，本机版本列表离线可判定。
- **日志与状态**（`src/main/logger.ts` + `src/renderer/control/tabs/status.ts`）：DSH 进程状态、端口、PID、实时日志滚动（应用 / DSH / 安装三类来源，镜像到运行目录 `logs/main.log`）。
- **设置**（`src/renderer/control/tabs/settings.ts`）：DSH 端口（修改后重启生效）、开机自启、启动时检查更新、GitHub 凭据（用于版本的 Releases 查询限流提升）。
- **托盘常驻**（`src/main/tray.ts`）：最小化 / 关闭隐藏到托盘；托盘菜单显示主窗口、打开控制面板、彻底退出。

## 插件安装来源

dsh-desktop 的插件全部是 npm registry 包，安装统一经 dsh harness 的原生插件通道执行：

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
| `dsh Harness` | dsh 原生 Profile 安装，需指定 Profile | `dsh plugin --profile <profile> add <包名>` |

安装后元数据（来源 + Profile + 安装时间）写入 profile manifest 的 `dsh.desktop.plugins`；插件列表以标签展示「来源：npm / npx / dsh Harness」与「Profile：<名称>」。卸载按记录中的 Profile 路由到对应 `dsh plugin --profile <profile> remove`，启用 / 禁用同样作用于记录中的 Profile。旧版本已安装的插件没有来源记录，默认按 `dsh Harness` / `web` 兼容显示与操作。

通过 UI 安装：控制面板 → 插件页签 → 选择安装方式（npm / npx / dsh Harness）→ 填写插件名称（dsh Harness 时还需填写 Profile，如 `web`）→ 点击安装。「dsh Harness」不需要手填完整 CLI 命令，Profile 与插件名作为独立参数安全传递。若本机没有可用的 dsh CLI（未安装 DeepSeek Harness 或未加入 PATH），安装会返回明确错误 `未检测到可用的 dsh CLI，请先安装 DeepSeek Harness 并确保 dsh 命令已加入 PATH`，不会导致应用崩溃。

## 技术栈

| 类别 | 选型 | 版本 | 来源 |
| --- | --- | --- | --- |
| 主语言 | TypeScript（strict，ES2023） | 5.9.x | `tsconfig.json`、`package.json` |
| 桌面框架 | Electron | ^43.4.1 | `package.json` `devDependencies` |
| 构建工具 | esbuild | ^0.28.2 | `package.json`、`scripts/build.mjs` |
| 打包工具 | electron-builder | ^26.15.3 | `package.json`、`electron-builder.yml` |
| 包管理器 | npm（lockfile 版本 3） | ≥ 20（CI 用 22） | `package-lock.json`、`.github/workflows/build-and-release.yml` |
| 渲染层 | 原生 HTML / CSS / TypeScript，无前端框架 | — | `src/renderer/`、`scripts/build.mjs` |
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

主窗口内嵌 DSH Web UI；主窗口右下角悬浮球单击弹出控制面板，含四个页签：

| 页签 | 功能 | 操作要点 |
| --- | --- | --- |
| 插件 | 安装 / 启停 / 卸载 / 导出 / 应用 | 选择安装方式（npm / npx / dsh Harness）并输入插件名（如 `dshmarket`）安装，dsh Harness 可指定 Profile（如 `web`）；列表用标签展示「来源」与「Profile」；启用 / 禁用 / 卸载按记录来源与 Profile 路由；"应用并重启 DSH"使改动生效（详见上文「插件安装来源」） |
| 版本 | 检查 / 下载 / 切换 / 回退 / 删除 | 来源可选"最新发布版本"或"最新提交（源码）"；本机版本列表离线可读；不能删除当前使用中的版本 |
| 日志 | 进程状态 / 实时日志 | 状态卡显示 DSH 状态、端口、PID、运行版本；日志滚动显示应用 / DSH / 安装三类来源 |
| 设置 | 端口 / 自启 / 更新检查 / 凭据 | 端口修改后需"保存并重启 DSH"；开机自启开关；GitHub 凭据用于版本的 Releases 查询限流提升，仅保存在运行目录 `credentials.json`，**明文，请勿外泄、勿提交** |

关闭主窗口（或最小化）应用隐藏到托盘而不是退出；托盘菜单提供"显示主窗口 / 打开控制面板 / 退出"。首次启动若捆绑运行时尚未解压，日志区会显示解压进度（约半分钟，见 `src/main/dsh/install.ts` 的 `ensureBundledRuntime`）。

## 开发指南

环境搭建与前置步骤见本章"快速开始"；数据目录约定见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 第 5 节。

- **调试**：`npm run dev` 以开发模式启动（`package.json`），主进程日志输出到运行目录 `logs/main.log` 并实时回传控制面板；
- **自动化验证**：以 `--remote-debugging-port=9222` 启动应用后，用 `node scripts/e2e-driver.mjs <step> [args]` 经 CDP 调用控制面板的 `window.dshc` 桥接做端到端断言（`scripts/e2e-driver.mjs`，可执行 step：`state` / `check` / `plugins` / `versions` / `download` / `switchTo` / `setPort` / `restart` 等），示例插件 fixture 在 `.e2e/test-plugin/`；
- **类型检查**：`npm run typecheck`（`tsc --noEmit`，strict）。
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
- **凭据保存在哪里**：仅存于运行目录 `credentials.json`（明文），`.gitignore` 已排除；卸载安装版需手动删除 `%APPDATA%\DSH Desktop\` 中的凭据文件。
- **需要不同 DSH 版本**：版本页"检查更新 → 下载并切换"；可回退到任意已安装版本或捆绑版本（`src/main/versions.ts` 的 `switchTo`）。

## 许可证

MIT License，见 [LICENSE](LICENSE)。Copyright (c) 2026 youridol。