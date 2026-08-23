# DSH Desktop 架构文档

## 1. 系统架构总览图

```mermaid
flowchart TB
    subgraph Electron 主进程（src/main/）
        ENTRY["index.ts 入口<br/>单实例锁 → 运行目录 → 窗口 → DSH 启动"]
        IPC["ipc.ts IPC 注册中心"]
        WIN["windows/ 窗口管理<br/>main 主窗口 · floating 悬浮球 · control 控制面板"]
        TRAY["tray.ts 系统托盘"]
        AUTOSTART["autostart.ts 开机自启"]
        CFG["config.ts 配置<br/>paths.ts 路径<br/>logger.ts 环形日志"]
        DSHMGR["dsh/manager.ts DSH 生命周期"]
        DSHINST["dsh/install.ts 版本安装<br/>（npm 安装 / 源码构建 / 运行时解包）"]
        DSHREL["dsh/releases.ts GitHub Releases 客户端"]
        PLUGINS["plugins.ts 插件管理 + patch overlay"]
        VERSIONS["versions.ts 版本管理"]
    end

    subgraph preload（src/preload/）
        PLOADER["preload/loader.ts → window.dshLoader"]
        PBALL["preload/floating.ts → window.dshBall"]
        PCTRL["preload/control.ts → window.dshc"]
    end

    subgraph renderer（src/renderer/，原生 HTML/CSS/TS）
        RLOADER["loader/ 加载页（加载态 / 错误 + 重试）"]
        RBALL["floating/ 悬浮球（拖动 / 单击）"]
        RCTRL["control/ 控制面板<br/>tabs: plugins · versions · status · settings"]
    end

    subgraph 外部
        DSHUI[("DSH Web UI<br/>127.0.0.1:3080")]
        UPSTREAM[("deepseek-ai/deepseek-harness<br/>GitHub API · npm registry · codeload")]
        NPMCLI[("内置 npm CLI（tools/ 下）")]
        TAR[("System32\\tar.exe")]
    end

    ENTRY --> WIN
    ENTRY --> TRAY
    ENTRY --> AUTOSTART
    ENTRY --> IPC
    IPC <--> PCTRL
    IPC <--> PLOADER
    IPC <--> PBALL
    PCTRL <--> RCTRL
    PLOADER <--> RLOADER
    PBALL <--> RBALL
    IPC --> DSHMGR
    DSHMGR --> DSHINST
    DSHMGR --> PLUGINS
    DSHMGR --> DSHUI
    IPC --> VERSIONS
    VERSIONS --> DSHREL
    VERSIONS --> DSHINST
    DSHINST --> NPMCLI
    DSHINST --> TAR
    DSHREL --> UPSTREAM
    PLUGINS --> CFG
    CFG --> IPC
    WIN <--> DSHUI
    ENTRY --> CFG
```

> 说明：图中每个模块（`index.ts` / `ipc.ts` / `windows/` / `tray.ts` / `autostart.ts` / `config.ts` / `paths.ts` / `logger.ts` / `dsh/manager.ts` / `dsh/install.ts` / `dsh/releases.ts` / `plugins.ts` / `versions.ts` / `src/preload/` / `src/renderer/` 各页面）均可在下方目录结构（第 5 节）中定位。

## 2. 模块职责矩阵

| 模块 | 职责 | 关键文件 |
| --- | --- | --- |
| 入口（bootstrap） | 单实例锁；覆盖 userData 路径；初始化运行目录 / 日志 / IPC；创建主窗口、悬浮球、控制面板、托盘；按配置启动 DSH 与启动时更新检查；退出时同步终止 DSH 进程树 | `src/main/index.ts` |
| 路径解析 | 区分开发 / 安装版 / 便携版三种运行数据位置；解析捆绑运行时、内置 npm CLI 路径 | `src/main/paths.ts` |
| 配置存储 | `config.json` 原子写入；字段级校验回退；配置变更事件；凭据文件读写（隔离于配置） | `src/main/config.ts` |
| 日志 | 环形缓冲（4000 行）+ 事件推送 + 镜像到 `logs/main.log`；应用 / DSH / 安装三类来源 | `src/main/logger.ts` |
| IPC 注册 | 全部 `ipcMain.handle/on` 通道；日志与状态订阅推送 | `src/main/ipc.ts` |
| DSH 生命周期 | spawn `dsh web --patch --no-open --port`；端口轮询（10s 超时，300ms 间隔）；`taskkill /T` 结束进程树；状态机（stopped/starting/running/stopping/crashed/timeout/error） | `src/main/dsh/manager.ts` |
| 版本安装 | npm 版本安装（内置 npm CLI）；源码 commit 安装（codeload 下载 → pnpm install/build → 布局 junction）；捆绑运行时首次解包（`System32\tar.exe`）；junction 安全删除 | `src/main/dsh/install.ts` |
| Node 运行时解析 | 系统 node / `DSH_DESKTOP_NODE` 覆盖 / Electron 内嵌 Node 回退；`--expose-internals` | `src/main/dsh/nodebin.ts` |
| Releases 客户端 | GitHub API 查询（凭据鉴权）；tag→npm 版本映射；403 限流与网络错误分类 | `src/main/dsh/releases.ts` |
| 插件管理 | 本地 / Git 安装、启停、卸载；入口解析；生成 `cordis.patch.yml` overlay（Windows 下用 `file://` URL） | `src/main/plugins.ts` |
| 版本管理 | 更新检查（release / commit 双通道）、下载并切换、回退、删除 | `src/main/versions.ts` |
| 主窗口 | loader 页 / DSH UI 双向导航；最小化与关闭隐藏到托盘；外部链接拦截 | `src/main/windows/main.ts` |
| 悬浮球 | 56px 无边框子窗口，贴住主窗口右下角，位置记忆；单击开关控制面板 | `src/main/windows/floating.ts` |
| 控制面板 | 无边框子窗口，随主窗口隐藏 / 恢复，无任务栏项 | `src/main/windows/control.ts` |
| 托盘 | 状态提示 + 菜单（显示主窗口 / 打开控制面板 / 退出）；退出为唯一真实退出通道 | `src/main/tray.ts` |
| 开机自启 | `app.setLoginItemSettings` 同步开关（便携版指向 exe 真实路径） | `src/main/autostart.ts` |
| preload 桥 | 按窗口暴露窄桥接：`dshLoader`（文件协议守卫）/ `dshBall` / `dshc` | `src/preload/loader.ts`、`floating.ts`、`control.ts` |
| 控制面板页面 | 四页签 UI（插件 / 版本 / 日志状态 / 设置），独立初始化 | `src/renderer/control/app.ts` + `tabs/*.ts` |
| 悬浮球页面 | 指针捕获：< 5px 位移视为单击，否则按增量拖动 | `src/renderer/floating/app.ts` |
| loader 页面 | 准备中旋转、错误 + 重试按钮 | `src/renderer/loader/app.ts` |
| 构建脚本 | esbuild 编译 main/preload/renderer → `dist/`；复制 html/css/assets | `scripts/build.mjs` |
| 运行时获取 | 下载捆绑 DSH（npm 安装到 `.dsh-runtime/`）+ 内置 npm CLI | `scripts/fetch-dsh.mjs` |
| 运行时打包 | `.dsh-runtime/` → `build-assets/dsh-runtime.tgz` 单包 | `scripts/pack-runtime.mjs` |
| 图标生成 | `assets/icon.png` → 多尺寸 PNG 嵌入 ICO | `scripts/make-icons.mjs` |
| afterPack 钩子 | zip 目标写 `resources/portable.marker`；NSIS 目标不写 | `scripts/after-pack.mjs` |
| E2E 驱动 | CDP 附加控制面板页面，经 `window.dshc` 执行断言步骤 | `scripts/e2e-driver.mjs` |
| CI 工作流 | 上游巡检（poll-upstream）+ 构建发版（build-and-release） | `.github/workflows/` |
| E2E fixture | 最小 Cordis 插件（`name` + `apply(ctx)`） | `.e2e/test-plugin/` |

## 3. 数据流图

### 3.1 启动流程（输入：用户双击启动）

```
用户启动
  → index.ts：requestSingleInstanceLock（失败则退出）
  → 设置 userData（%APPDATA%\DSH Desktop）
  → ensureRuntimeDirs() 创建 runtimeDir/plugins/versions/downloads/logs
  → initLogger()（logs/main.log）
  → registerIpc()
  → createMainWindow()（加载本地 loader 页）
  → createFloatingBall() / createControlPanel() / createTray()
  → dsh.start()：
      activeVersion=bundled → ensureBundledRuntime()（首启用 tar.exe 解包 dsh-runtime.tgz）
      → spawn node dsh web --patch <overlay> --no-open --port <port>
      → pollReady：每 300ms GET http://127.0.0.1:<port>，10s 超时
      → 就绪 → mainWindowEvents 驱动 syncNavigation()：loader 页 → loadURL(DSH UI)
```

### 3.2 插件管理流程（输入：用户安装 / 启停 / 应用）

```
安装（本地目录 / .js / Git clone，plugins.ts）
  → 复制 / clone 到 runtimeDir/plugins/<name>
  → resolveEntry() 解析入口（package.json main / index.js / …）
  → 写入 config.json（PluginRecord：id/entry/dir/enabled/source/…）
  → 状态回传控制面板 UI

“应用并重启”（plugins:apply）
  → writePatchOverlay()：按启用插件写 cordis.patch.yml（绝对路径 / file:// URL）
  → dsh.restart()：taskkill /T → 重新 spawn（带 --patch 参数）
  → DSH 加载插件，输出经 logger 回传日志页
```

### 3.3 版本管理流程（输入：用户检查 / 下载 / 切换）

```
检查（versions:check，releases.ts）
  → GET api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30
      （附 credentials.json 中的 Bearer，限流/离线分类降级）
  → tag 规范化 dsh-vX.Y.Z → X.Y.Z；compareVersions 判定 hasUpdate
  → 返回发布列表 / 最新 commit（source='commit' 通道）

下载并切换（versions:download）
  → ensureVersionInstalled(version)：
      内置 npm CLI（.dsh-runtime/tools/…）→ npm install @deepseek-ai/dsh@X.Y.Z
      --omit=dev --no-audit --no-fund → runtimeDir/versions/<version>/
      进度逐行回传 'install:progress'
  → setConfig({ activeVersion }) → dsh.restart()

源码 commit 安装（versions:installCommit，install.ts ensureCommitInstalled）
  → codeload.github.com 下载 tar.gz → System32\tar.exe 解压（strip 1 层）
  → pnpm install --frozen-lockfile → pnpm run build（注入 DSH_CLIENT_COMMIT_HASH）
  → mklink /J 建立 node_modules/@deepseek-ai/dsh → apps/cli 布局 junction
  → 切换 + 重启
```

### 3.4 日志流

```
appLog / dshLog / installLog（logger.ts）
  → 环形缓冲（4000 行）
  → logs/main.log（追加镜像）
  → logEvents 'line' 事件
  → ipc.ts pushToSubscribers → 控制面板 'logs:line'
  → 日志页滚动渲染（批量 flush）
```

### 3.5 状态同步流

```
dsh/manager.ts setState()（状态机迁移）
  → dshEvents 'status' → ipc.ts forwardStatus / pushToSubscribers
  → 主窗口（loader 导航决策 / 错误态）、悬浮球可见性、托盘菜单与 tooltip、控制面板状态卡
```

## 4. 技术选型说明

| 决策 | 选型 | 理由（源码佐证） | 备选方案与排除理由 |
| --- | --- | --- | --- |
| 桌面框架 | Electron ^43.4.1 | 需要 spawn 并管理 DSH 的 Node 进程、内置 Node 兜底运行时（`src/main/dsh/nodebin.ts`）、系统托盘 / 登录自启 / 单实例（`tray.ts`、`autostart.ts`、`index.ts`）等原生集成；`package.json` 声明 devDependency | Tauri：仓库内无任何 Rust 代码（无 `Cargo.toml` / `src-tauri/`），且要复用 Node 生态的 npm CLI 与 CDP 调试，选 Electron 与既有代码目标一致 |
| 渲染层 | 原生 HTML / CSS / TypeScript，无前端框架 | 三个页面（loader / floating / control）均为 DOM 直操作（`src/renderer/control/app.ts` 等），打包为单个 IIFE（`scripts/build.mjs`）；减少依赖面与编译复杂度 | Vue / React：界面规模小、无需响应式组件体系，引入框架反而增加打包体积与维护面 |
| 编译 / 打包 | esbuild ^0.28.2 | `package.json` devDependency；`scripts/build.mjs` 单文件输出 main（CJS/node）、preload、renderer（IIFE/browser） | tsc 直出：需要与 electron-builder 的 asar 打包衔接，esbuild 一步完成 bundle 且无 tree-shaking 负担 |
| 运行时分发 | 单 tgz 经 extraResources（`build-assets/dsh-runtime.tgz`） | electron-builder 的文件收集器会静默丢弃 `node_modules` 树、静态依赖分析漏掉 peer / 动态加载包（`electron-builder.yml` 注释 + `scripts/fetch-dsh.mjs` 头注释），单包分发 + 首启解压绕开该限制 | asarUnpack 全量解包：不兼容 peer 加载且体积膨胀，已废弃（`README.original.md` 中旧描述，新版打包不再使用） |
| 解压工具 | Windows 自带 `System32\tar.exe` | Win10 1803+ 内置 bsdtar，用户机零依赖（`src/main/dsh/install.ts` 注释） | Node tar 依赖：便携版与安装版均不应要求额外工具链 |
| 运行时安装 | 内置 npm CLI（`.dsh-runtime/tools/`）| 无 Node 机器也能更新版本（`src/main/dsh/install.ts` 头注释说明） | 依赖系统 npm：与\"不依赖系统 Node\"目标冲突 |
| 源码构建通道 | pnpm（workspace: 协议）+ `mklink /J` junction | 上游 monorepo 官方构建链路（`src/main/dsh/install.ts` ensureCommitInstalled）；junction 对齐 npm 布局，`isVersionInstalled` / manager 硬编码入口零改动兼容 | 直接 git clone + npm：上游 workspace 依赖无法用 npm 解析 |
| CI | GitHub Actions 双工作流 + 上游轮询 | 更新通道固定为 deepseek-ai/deepseek-harness，可定时巡检（`.github/workflows/poll-upstream.yml`），tag 存在性作幂等真相源 | 第三方更新机器人 / 手动发版：定时轮询 + `workflow_call` 复用实现自动发版闭环 |

## 5. 目录结构详解

```
dsh-desktop/
├── .e2e/                       # 端到端测试夹具
│   └── test-plugin/            # 最小 Cordis 插件 fixture（name + apply(ctx)）
├── .github/
│   └── workflows/
│       ├── build-and-release.yml   # 构建 + 发版（push / workflow_call / 手动）
│       └── poll-upstream.yml       # 每小时巡检上游 Releases 与 commit
├── assets/                     # 图标源（icon.png）与生成的 icon.ico
├── scripts/                    # 构建 / 打包 / 获取运行时 / 图标 / E2E 驱动 / afterPack 钩子
├── src/
│   ├── main/                   # Electron 主进程（详见第 2 节矩阵）
│   │   ├── dsh/                # DSH 生命周期（manager）、安装（install）、Node 解析（nodebin）、上游客户端（releases）
│   │   └── windows/            # 主窗口 / 悬浮球 / 控制面板
│   ├── preload/                # 三个窗口的窄桥接（contextIsolation 开启）
│   └── renderer/               # 无框架页面：loader / floating / control（tabs/）
├── package.json                # 版本、scripts、devDependencies（应用本体零运行时依赖）
├── package-lock.json           # 依赖锁（lockfileVersion 3）
├── electron-builder.yml        # 打包配置（NSIS + zip、extraResources、afterPack）
├── tsconfig.json               # strict 类型检查配置（noEmit）
├── .npmrc                      # 固定 npm registry
├── .gitignore                  # node_modules / dist / release / .dsh-runtime / runtime / build-assets 忽略
├── CHANGELOG.md                # 版本变更记录
├── LICENSE                     # MIT
├── README.md                   # 项目说明（本文档为入口）
└── docs/                       # 架构 / 部署 / 贡献文档

# 以下为构建 / 运行期产物（均已 gitignore）：
├── dist/                       # esbuild 输出（main.js、preload-*.js、renderer/*）
├── .dsh-runtime/               # fetch-dsh 下载的捆绑 DSH 运行时 + 内置 npm CLI
├── build-assets/               # pack-runtime 产出的 dsh-runtime.tgz
├── runtime/                    # 开发模式运行数据（config / plugins / versions / logs）
└── release/                    # electron-builder 产物（nsis/、zip/、checksums.txt）
```

### 运行目录约定（运行时数据）

| 场景 | 运行目录 | 判定依据（`src/main/paths.ts`） |
| --- | --- | --- |
| 开发模式 | 项目 `runtime/` | `app.isPackaged === false` |
| NSIS 安装版 | `%APPDATA%\DSH Desktop\` | `index.ts` 的 `app.setPath('userData', …)` |
| zip 便携版 | exe 所在目录 | `resources/portable.marker` 存在 |

目录内包含：`config.json`（设置）、`credentials.json`（GitHub 凭据，明文，`.gitignore` 排除）、`plugins/`、`versions/`（含 `_bundled/` 与已下载版本）、`downloads/`（源码安装缓存）、`logs/`（`main.log`）、`cordis.patch.yml`（自动生成的插件 overlay）。