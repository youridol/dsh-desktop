# DSH Desktop

DeepSeek Harness（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，简称 DSH）的 Windows x64 桌面封装。

主窗口直接内嵌 DSH 原生 Web UI；右下角悬浮球单击弹出控制面板，提供 **插件管理 / 版本管理 / 日志与状态 / 设置**；支持系统托盘常驻、开机自启。**不修改 DSH 源码**，所有扩展通过 Cordis patch overlay（`dsh web --patch`）以插件方式挂载。

```
┌─────────────────────────────┐
│  DSH Desktop (Electron)     │
│  ┌───────────────────────┐  │
│  │  DSH Web UI           │  │
│  │  127.0.0.1:3080       │  │
│  │                 ( ● ) │  │ ← 悬浮球（可拖动，单击开面板）
│  └───────────────────────┘  │
│   ┌ 控制面板（子窗口）┐      │
│   │ 插件|版本|日志|设置│      │
│   └───────────────────┘      │
│  托盘常驻 · 开机自启          │
└─────────────────────────────┘
```

## 功能

- **冷启动即用**：双击启动后自动拉起捆绑的 DSH（`dsh web --patch … --port …`），主窗口在服务就绪后自动加载 Web UI；10 秒未就绪显示错误与重试按钮。
- **悬浮球控制面板**：主窗口右下角悬浮球（可拖动、位置记忆），单击打开独立子窗口控制面板（无任务栏项，随主窗口隐藏/恢复）。
- **插件管理**：
  - 从本地目录 / `.js` 文件安装，或从 Git 仓库克隆（私有仓库可用保存的 GitHub 凭据），示例仓库：[youridol/dsh-plugin-demo](https://github.com/youridol/dsh-plugin-demo)；
  - 自动生成 `cordis.patch.yml`（插件路径为绝对路径），一键“应用并重启 DSH”；
  - 启用/停用/卸载，插件加载日志实时查看。
- **版本管理**：检查 `deepseek-ai/deepseek-harness` 的 GitHub Releases；下载新版本（经 npm registry 拉取并解压到运行目录 `versions/`）、切换、回退、删除，全部离线可判定（本地版本列表不依赖网络）。
- **日志与状态**：DSH 进程状态、端口、PID、实时日志滚动（应用/DSH/安装三类来源）。
- **设置**：DSH 端口（修改后重启生效）、开机自启、启动时检查更新、GitHub 凭据。
- **托盘常驻**：最小化/关闭隐藏到托盘；托盘菜单可显示主窗口、打开控制面板、彻底退出。

## 运行目录（配置 / 凭据 / 插件 / 版本）

| 安装方式 | 运行目录 |
| --- | --- |
| NSIS 安装版 | `%APPDATA%\DSH Desktop\` |
| zip 便携版 | exe 所在目录（`resources\portable.marker` 标记） |
| 开发模式 | 项目 `runtime\` |

运行目录内包含：`config.json`（设置）、`credentials.json`（GitHub 凭据，**明文，仅存于此，勿提交**）、`plugins\`、`versions\`、`logs\`、`cordis.patch.yml`（自动生成）。

## 从源码构建

环境要求：Node.js ≥ 20、npm、Git、Windows x64。

```bash
npm install          # 安装 electron/electron-builder/esbuild 等开发依赖
npm run fetch-dsh    # 下载捆绑版 DSH + 内置 npm CLI 到 .dsh-runtime/（默认最新 Release，--version 可指定）
npm run make-icons   # 由 assets/icon.png 生成 assets/icon.ico
npm run build        # esbuild 编译 main/preload/renderer -> dist/
npm run dev          # 启动开发运行

npm run dist         # 打包运行时 tgz 并产出 release/nsis/*.exe（安装包）与 release/zip/*.zip（便携版）
```

- 两种产物捆绑的 DSH 版本一致，图标均为 `assets/icon.png`。
- `scripts/e2e-driver.mjs` 是端到端驱动脚本：应用以 `--remote-debugging-port=9222` 启动后，可经 CDP 调用控制面板的 `window.dshc` 桥接接口做自动化验证。

## CI / 自动发版

更新通道固定为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 上游，由两个工作流协作（`.github/workflows/`）：

| 工作流 | 触发 | 行为 |
| --- | --- | --- |
| `poll-upstream.yml` | 每小时定时 + `workflow_dispatch`（可 `force` / `release_mode` / `override_version`） | 巡检上游最新 Release tag 与默认分支最新 commit：**新 Release**（本仓库无对应 tag `v{版本}`）→ 以 main 代码调 `build-and-release.yml` 发正式版；**仅上游新 commit** → 发候选版 `v{版本}-dev-{sha7}`（prerelease）；无变化 → 幂等退出 |
| `build-and-release.yml` | 任意分支 push + 被前者 `workflow_call` 复用 + 手动 | windows-latest / Node 22 上执行 typecheck → make-icons → fetch-dsh（上游最新，poll 通道按指定版本固定捆绑）→ 构建 → NSIS + zip → 校验和 → 按分支规则打 tag 并 `gh release` 发布（标题 `DSH Desktop v{版本}`，附 exe/zip/checksums 三资产），最终写 run summary |

发版规则：
- **tag 规则**：main 分支 → `v{版本}`；其它分支 → `v{版本}-{清洗后分支名}`（`/` 与非法字符转 `-`）；dev 候选版 → `v{版本}-dev-{上游sha7}`。
- **版本映射**：上游 tag `dsh-v0.1.1-rc.2` → 桌面端版本 `0.1.1-rc.2`（去 `dsh-` 前缀）；Release 标题统一为 `DSH Desktop v{版本}`。
- **幂等**：以本仓库 tag 存在性为真相源——目标 tag 已存在即跳过发版，同一版本连跑多次调度只有第一次发版；`force=true` 时才覆盖资产（修复通道）。
- **无循环**：tag push 不匹配 `branches` 过滤，不会触发构建回流。
- 所有 Release 产物均含 SHA-256 校验和（`checksums.txt`）。

## 打包产物说明

- **NSIS 安装包**：常规向导安装（默认每用户，可改目录），运行数据在 `%APPDATA%\DSH Desktop`。
- **zip 便携版**：解压即用，运行数据保留在解压目录内。
- 捆绑的 DSH 运行时以单个 `resources\dsh-runtime.tgz`（约 53MB）随包分发：electron-builder 的文件收集器会静默丢弃 `node_modules` 树、其静态依赖分析也会漏掉 dsh 运行时按 peer/dynamic 方式加载的包，因此应用在**首次启动**时用 Windows 自带的 `System32\tar.exe` 把 tgz 解压到运行目录 `versions\_bundled\`（约半分钟，日志可见进度），之后直接从该目录运行。
- 应用本体不依赖系统 Node：优先使用系统 `node`（带 `--expose-internals`，DSH 的 HMR 需要），无 Node 时自动回退到 `ELECTRON_RUN_AS_NODE` 模式使用自带运行时（已实测）；DSH 依赖的原生模块均为 NAPI ABI 稳定构建。

## 技术要点

- Electron + TypeScript，main / preload / renderer 三层分离；渲染层纯原生 HTML/CSS/TS，无前端框架；esbuild 编译。
- 主窗口在服务未就绪时加载本地 loader 页（加载态 / 错误 + 重试），就绪后导航至 `http://127.0.0.1:<port>`；preload 按 URL 协议守卫，在远端页面上自动失效。
- DSH 生命周期：spawn 后轮询端口（10s 超时），`taskkill /T` 结束进程树；异常退出自动进入错误态并提示。
- 版本源：GitHub Releases 的 tag（`dsh-v0.1.1-rc.2` ↔ npm `@deepseek-ai/dsh@0.1.1-rc.2` 一一对应）；Release 不附资产，实际安装包经 npm registry 下载解压到运行目录 `versions/`。
- 打包通道：捆绑运行时以生产依赖 + `asarUnpack` 全量解包交付（electron-builder 原生 node_modules 收集，兼容 NSIS 与 zip）；`afterPack` 仅负责给 zip 写 `portable.marker`。
- 凭据安全：GitHub 凭据仅保存在运行目录 `credentials.json`（`.gitignore` 已排除），运行时读取，用于 Releases 查询与私有插件仓库克隆；源码与仓库中不含任何凭据。

## License

MIT
