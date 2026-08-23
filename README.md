# DSH Desktop

## 项目简介

DeepSeek Harness（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，简称 DSH）的 Windows x64 桌面封装：以 Electron 窗口内嵌 DSH 原生 Web UI，附带悬浮球控制面板、插件管理、版本管理、系统托盘与开机自启。

项目不改动 DSH 源码，所有扩展经 Cordis patch overlay（`dsh web --patch`）以插件方式挂载，细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 功能特性

- **冷启动即用**：双击启动后自动拉起捆绑的 DSH 服务（`dsh web --patch … --no-open --port …`，见 `src/main/dsh/manager.ts`），主窗口在服务就绪后自动加载 Web UI；10 秒内未就绪显示错误页与重试按钮（`READY_TIMEOUT_MS`，`src/main/dsh/manager.ts`）。
- **悬浮球控制面板**：主窗口右下角悬浮球（可拖动、位置记忆，`src/main/windows/floating.ts`），单击开关独立子窗口控制面板（`src/main/windows/control.ts`，无任务栏项、随主窗口隐藏与恢复）。
- **插件管理**（`src/main/plugins.ts` + `src/renderer/control/tabs/plugins.ts`）：
  - 从本地目录 / `.js` 文件安装，或从 Git 仓库浅克隆安装（私有仓库可配置 GitHub 凭据）；
  - 自动生成 `cordis.patch.yml`（插件入口为绝对路径），一键"应用并重启 DSH"；
  - 启用 / 停用 / 卸载，加载日志实时查看。
- **版本管理**（`src/main/versions.ts` + `src/main/dsh/releases.ts`）：检查 `deepseek-ai/deepseek-harness` 的 GitHub Releases 与默认分支最新 commit；下载新版本（经 npm registry 安装到运行目录 `versions/`）、切换、回退、删除，本机版本列表离线可判定。
- **日志与状态**（`src/main/logger.ts` + `src/renderer/control/tabs/status.ts`）：DSH 进程状态、端口、PID、实时日志滚动（应用 / DSH / 安装三类来源，镜像到运行目录 `logs/main.log`）。
- **设置**（`src/renderer/control/tabs/settings.ts`）：DSH 端口（修改后重启生效）、开机自启、启动时检查更新、GitHub 凭据。
- **托盘常驻**（`src/main/tray.ts`）：最小化 / 关闭隐藏到托盘；托盘菜单显示主窗口、打开控制面板、彻底退出。

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
| 插件 | 安装 / 启停 / 卸载 / 应用 | "从本地目录安装…"选择目录或 `.js` 文件；"从 Git 仓库克隆"粘贴仓库 URL（私有仓库先在设置页配置凭据）；"应用并重启 DSH"使启用的插件生效 |
| 版本 | 检查 / 下载 / 切换 / 回退 / 删除 | 来源可选"最新发布版本"或"最新提交（源码）"；本机版本列表离线可读；不能删除当前使用中的版本 |
| 日志 | 进程状态 / 实时日志 | 状态卡显示 DSH 状态、端口、PID、运行版本；日志滚动显示应用 / DSH / 安装三类来源 |
| 设置 | 端口 / 自启 / 更新检查 / 凭据 | 端口修改后需"保存并重启 DSH"；开机自启开关；GitHub 凭据用于 Releases 查询与私有插件克隆，仅保存在运行目录 `credentials.json`，**明文，请勿外泄、勿提交** |

关闭主窗口（或最小化）应用隐藏到托盘而不是退出；托盘菜单提供"显示主窗口 / 打开控制面板 / 退出"。首次启动若捆绑运行时尚未解压，日志区会显示解压进度（约半分钟，见 `src/main/dsh/install.ts` 的 `ensureBundledRuntime`）。

## 开发指南

环境搭建与前置步骤见本章"快速开始"；数据目录约定见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 第 5 节。

- **调试**：`npm run dev` 以开发模式启动（`package.json`），主进程日志输出到运行目录 `logs/main.log` 并实时回传控制面板；
- **自动化验证**：以 `--remote-debugging-port=9222` 启动应用后，用 `node scripts/e2e-driver.mjs <step> [args]` 经 CDP 调用控制面板的 `window.dshc` 桥接做端到端断言（`scripts/e2e-driver.mjs`，可执行 step：`state` / `check` / `plugins` / `versions` / `download` / `switchTo` / `setPort` / `restart` 等），示例插件 fixture 在 `.e2e/test-plugin/`；
- **类型检查**：`npm run typecheck`（`tsc --noEmit`，strict）。
- **代码规范**：无 ESLint / Prettier 配置，类型层约束由 `tsconfig.json` 的 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch` + `forceConsistentCasingInFileNames` 提供；新增模块需同步更新 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。

## 架构概览

应用为 Electron main / preload / renderer 三层：主进程负责窗口、托盘、自启、DSH 进程生命周期与版本 / 插件管理；preload 提供按窗口裁剪的窄桥接（`window.dshc` / `window.dshLoader` / `window.dshBall`，见 `src/preload/`）；渲染层为纯原生 HTML/CSS/TS 页面（loader 加载页、floating 悬浮球、control 控制面板）。

DSH 服务由主进程 spawn（`dsh web --patch <overlay> --no-open --port <n>`），端口轮询就绪后主窗口从本地 loader 页导航至 `http://127.0.0.1:<port>`；异常退出自动回到错误态。详见图与模块矩阵：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 部署指南

本地构建、CI/CD 自动发版、NSIS 与 zip 产物、运行目录与环境变量详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 贡献指南

分支策略、提交格式、PR 流程与代码审查清单见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)。

## 常见问题 FAQ

- **启动后一直停留加载页 / 显示"启动超时"**：DSH 服务 10 秒内未就绪。检查端口是否被占用（设置页更换端口并重启）、查看日志页的 DSH 输出。
- **首次启动日志区显示解压进度占用约半分钟**：捆绑运行时（约 53MB 的 `dsh-runtime.tgz`）在首次启动时用 Windows 自带的 `System32\tar.exe` 解压到运行目录 `versions\_bundled\`，之后直接复用（`src/main/dsh/install.ts`）。
- **检查更新提示 GitHub 限流（403）**：匿名 API 限额耗尽。在设置页配置 GitHub 凭据后重试（`src/main/dsh/releases.ts` 的 `authHeaders`）。
- **便携版更新（切换版本）后"版本缺失"**：运行数据与 exe 同目录，整体移动目录后仍完整；若运行目录被清理，应用自动回退到捆绑版本并提示（`src/main/dsh/manager.ts` 的 `start`）。
- **插件无法加载**：插件入口须为 `package.json` 的 `main` 或 `index.js` / `index.cjs` / `index.mjs` / `lib/index.js`（`src/main/plugins.ts` 的 `resolveEntry`）；启用后执行"应用并重启 DSH"。
- **凭据保存在哪里**：仅存于运行目录 `credentials.json`（明文），`.gitignore` 已排除；卸载安装版需手动删除 `%APPDATA%\DSH Desktop\` 中的凭据文件。
- **需要不同 DSH 版本**：版本页"检查更新 → 下载并切换"；可回退到任意已安装版本或捆绑版本（`src/main/versions.ts` 的 `switchTo`）。

## 许可证

MIT License，见 [LICENSE](LICENSE)。Copyright (c) 2026 youridol。