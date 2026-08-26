# DSH Desktop 部署文档

## 1. 环境要求

| 项 | 要求 | 说明 | 来源 |
| --- | --- | --- | --- |
| 操作系统 | Windows x64 | 打包目标仅 `--win x64`；运行时解包依赖 Win10 1803+ 内置 `System32\tar.exe` | `package.json` `dist:nsis`/`dist:zip`、`src/main/dsh/install.ts` |
| 构建机 Node.js | ≥ 20（CI 使用 Node 22） | `README.original.md` 构建说明；`.github/workflows/build-and-release.yml` 的 `node-version: 22` | `README.original.md`、`.github/workflows/` |
| 构建机 npm | 与 Node 配套 | 依赖锁为 `package-lock.json`（lockfileVersion 3），构建环境用 `npm ci` | `package-lock.json`、`.github/workflows/build-and-release.yml` |
| 构建机 Git | 有 | 源码 commit 安装通道与 CI checkout 需要 Git | `.github/workflows/` |
| 运行机 | 不要求 Node / Git / npm | 应用自带回退运行时不依赖系统 Node（`ELECTRON_RUN_AS_NODE`）；版本安装用内置 npm CLI | `src/main/dsh/nodebin.ts`、`src/main/dsh/install.ts` |
| 硬件最低配置 | 无特殊声明 | 项目未声明最低硬件需求；服务为本地 127.0.0.1 端口，占用资源即 DSH 进程本身 | — |
| 网络 | 构建期需访问 registry.npmjs.org 与 GitHub API | 安装依赖、fetch-dsh、electron-builder 下载工具链均需网络 | `scripts/fetch-dsh.mjs`、`.npmrc` |

## 2. 依赖安装步骤

```bash
# 安装开发依赖（Electron / electron-builder / esbuild / typescript 等，见 package.json devDependencies）
npm ci            # 干净环境（有 lockfile 时推荐，CI 同款）；或 npm install

# 获取捆绑的 DSH 运行时 + 内置 npm CLI（必做，构建产物依赖它）
npm run fetch-dsh # 默认捆绑上游最新 Release；可用 --version 0.1.1-rc.2 固定版本
```

- 应用本体**无运行时 node_modules**：`package.json` 的 `dependencies` 仅 `js-yaml`（^4.3，用于解析 Profile 的 `pnpm-workspace.yaml` 构建策略），由 esbuild 打入 `dist/main.js`，打包产物不携带运行时 node_modules；`devDependencies` 为 `@types/js-yaml`、`@types/node`、`electron`、`electron-builder`、`esbuild`、`typescript`。运行时数据全部来自 `src/` 编译产物与捆绑的 DSH 运行时包。
- 版本来源：`dsh-vX.Y.Z(-rc.N)` 发布 tag 与 npm 包 `@deepseek-ai/dsh@X.Y.Z(-rc.N)` 一一对应（`src/main/dsh/releases.ts` 的 `tagToVersion`）；`GITHUB_TOKEN` 环境变量存在时用于规避匿名 API 限流（`scripts/fetch-dsh.mjs`）。
- 可选：`npm run make-icons` —— 从 `assets/icon.png` 生成多尺寸 `assets/icon.ico`（`assets/icon.ico` 已入库，仅在图标源变更后需要）。

## 3. 构建步骤

### 3.1 开发构建

```bash
npm run typecheck   # tsc --noEmit（strict）
npm run build       # esbuild 编译 main / preload / renderer -> dist/
npm run dev         # 上述 build + electron . 启动开发运行（运行数据在项目 runtime/ 下）
```

`scripts/build.mjs` 产出：`dist/main.js`（main 入口，CJS）、`dist/preload-*.js`（三个 preload）、`dist/renderer/<page>/app.js`（三个页面 IIFE）+ 相应 html/css 与 `assets/` 拷贝。

### 3.2 生产构建（打包分发）

```bash
npm run dist        # 完整链：build -> pack-runtime -> dist:nsis -> dist:zip
```

等价拆分：

```bash
npm run build           # 编译应用
npm run pack-runtime    # .dsh-runtime/ -> build-assets/dsh-runtime.tgz（单包捆绑运行时）
npm run dist:nsis       # electron-builder --win nsis --x64 -> release/nsis/
npm run dist:zip        # electron-builder --win zip  --x64 -> release/zip/
```

> `electron-builder` 首次构建需从 GitHub 下载 winCodeSign / nsis 工具链，匿名请求会限流报 “GitHub Personal Access Token is not set”——本地构建需设置有效的 `GH_TOKEN`（CI 已注入 `${{ github.token }}`，见 `.github/workflows/build-and-release.yml`）。

### 3.3 产物路径表

| 步骤 | 命令 | 产物 | 来源 |
| --- | --- | --- | --- |
| 编译 | `npm run build` | `dist/main.js`、`dist/preload-*.js`、`dist/renderer/*/app.js`（html/css/assets） | `scripts/build.mjs` |
| 运行时打包 | `npm run pack-runtime` | `build-assets/dsh-runtime.tgz`（约 53MB） | `scripts/pack-runtime.mjs`、`electron-builder.yml` |
| NSIS 安装包 | `npm run dist:nsis` | `release/nsis/DSH Desktop Setup *.exe` | `package.json`、`electron-builder.yml` |
| 便携版 | `npm run dist:zip` | `release/zip/DSH Desktop-*-win.zip` | `package.json`、`electron-builder.yml` |
| 校验和 | CI 内 | `release/checksums.txt`（SHA-256） | `.github/workflows/build-and-release.yml` |

## 4. 部署方式

### 4.1 本地部署

- 安装版：运行 `release/nsis/*.exe` 向导安装（默认每用户，可改目录），运行数据在 `%APPDATA%\DSH Desktop\`。
- 便携版：解压 `release/zip/*.zip` 到任意目录，运行 `DSH Desktop.exe`；`scripts/after-pack.mjs` 写入的 `resources\portable.marker` 使运行数据保留在 exe 目录，整体移动目录即完成迁移。

### 4.2 CI/CD（自动发版）

更新通道固定为 `deepseek-ai/deepseek-harness` 上游，两个工作流协作：

| 工作流 | 触发 | 行为 |
| --- | --- | --- |
| `poll-upstream.yml` | 每小时 37 分定时 + `workflow_dispatch`（`force` / `release_mode` / `override_version`） | 巡检上游最新 Release tag 与默认分支最新 commit；本仓库无对应 `v{版本}` tag → 以 main 代码调 `build-and-release.yml` 发正式版；仅上游 commit 变化 → 发 `v{APP_VERSION}-{sha7}` 候选版（prerelease）；无变化幂等退出 |
| `build-and-release.yml` | 任意分支 push + `workflow_call` 复用 + 手动 | windows-latest / Node 22：checkout → `npm ci` → `tsc --noEmit` → `make-icons` → `fetch-dsh`（poll 通道按指定版本固定捆绑）→ `build` → `pack-runtime` → NSIS + zip（注入 `GH_TOKEN`）→ `sha256sum` checksums → 打 tag 并 `gh release` 发布（标题 `DSH Desktop v{版本}`，资产 exe/zip/checksums） |

发版规则（双版本号规范，`.github/workflows/`，严禁混淆两个版本号）：
- **dsh-desktop 版本**（APP_VERSION）：取自 `package.json` 的 `version`，唯一桌面壳版本事实源；
- **上游 DSH 标识**（UPSTREAM）：本次捆绑的 DeepSeek Harness 版本标识，按最新程度二选一——发布 tag 版本更新时用 tag 规范化版本（上游 tag `dsh-v0.1.1-rc.2` → `0.1.1-rc.2`）；上游默认分支仅提交更新时用提交 sha 前 7 位；
- **发版版本**（V）= `APP_VERSION-UPSTREAM`（如 `0.3.0-0.1.1-rc.2` / `0.3.0-a1b2c3d`）；
- **tag 规则**：main 分支 → `v{V}`；其它分支 → `v{V}-{清洗后分支名}`；dev 候选版同复合格式（prerelease 由 release 标志标记）；
- 幂等：目标 tag 已存在即跳过发版（tag 存在性为真相源），`force=true` 才覆盖资产；
- 防循环：tag push 不匹配 `branches` 过滤，不会回流触发；
- 决策复用：版本递进识别 / tag 生成 / 幂等判定统一由 `scripts/release-plan.mjs` 实现，单测见 `test/release-plan.test.mjs`（CI 构建前自动执行）。

### 4.3 部署产物分发

全部 Release 产物经 [GitHub Releases](https://github.com/youridol/dsh-desktop/releases) 分发，每次发布附 `exe` / `zip` / `checksums.txt` 三资产；`poll-upstream.yml` 与 `build-and-release.yml` 的 run summary 记录巡检结果与发布信息。

## 5. 配置说明

### 5.1 环境变量

| 变量 | 默认值 | 用途 | 来源 |
| --- | --- | --- | --- |
| `DSH_DESKTOP_NODE` | 空（自动探测） | 指定用于运行 DSH 与 npm 安装的 Node 可执行文件路径；未设置时优先系统 `node`，其次 Electron 内嵌 Node | `src/main/dsh/nodebin.ts` |
| `DSH_DESKTOP_SHOT` | 空（不截图） | 非空时主窗口导航至 DSH UI 4 秒后保存调试截图到该路径 | `src/main/windows/main.ts` `maybeDebugScreenshot` |
| `DSH_DESKTOP` | 注入为 `'1'` | 应用启动 DSH 子进程时注入的内部标记（标识由桌面壳拉起的实例） | `src/main/dsh/manager.ts` |
| `ELECTRON_RUN_AS_NODE` | 未设置 | 兜底模式：探测不到系统 node 时置 `'1'`，把 Electron 二进制当作纯 Node 解释器 | `src/main/dsh/nodebin.ts` |
| `GITHUB_TOKEN` | 空（匿名） | 构建期 GitHub API 鉴权（fetch-dsh 查 Releases、electron-builder 下载工具链），规避匿名限流；CI 自动注入 `${{ github.token }}` | `scripts/fetch-dsh.mjs`、`.github/workflows/build-and-release.yml` |
| `GH_TOKEN` | CI 注入 | electron-builder 构建时下载 winCodeSign/nsis 工具链的认证（同 `GITHUB_TOKEN` 通道） | `.github/workflows/build-and-release.yml` |
| `E2E_GH_USER` | `youridol` | e2e-driver 的 `saveCreds` 步注入的 GitHub 用户名 | `scripts/e2e-driver.mjs` |
| `E2E_GH_TOKEN` | 空 | e2e-driver 的 `saveCreds` 步注入的 GitHub Token | `scripts/e2e-driver.mjs` |

### 5.2 运行目录配置文件

| 文件 | 默认内容 | 说明 | 来源 |
| --- | --- | --- | --- |
| `config.json` | `{ port: 3080, autoStart: false, activeVersion: \"bundled\", plugins: [], ballOffset: null, checkUpdatesOnStart: true }` | 应用设置，原子写入（临时文件 + rename）；字段级校验回退；`plugins` 数组仅保留旧版本兼容（插件管理已迁移到 dsh profile） | `src/main/config.ts` `DEFAULT_CONFIG` |
| `credentials.json` | `{}` | GitHub 凭据（用户名 + Token），**明文**存于运行目录，不随配置传播、不入库 | `src/main/config.ts` `readCredentials` / `writeCredentials` |
| `（插件由 dsh 管理）` | — | 插件本体与状态存于 dsh harness 的 Web profile（`$DSH_HOME/profiles/web/`），不在运行目录；插件操作经 `dsh plugin --profile web` CLI（`src/main/services/dsh/DshPluginService.ts`） | `src/main/services/dsh/` |
| `logs/main.log` | 追加写入 | 应用 / DSH / 安装三类日志镜像 | `src/main/logger.ts` `initLogger` |

运行目录随安装方式变化：NSIS 装 → `%APPDATA%\DSH Desktop\`；便携版 → exe 同目录；开发 → 项目 `runtime\`（`src/main/paths.ts` 的 `resolveRuntimeDir`）。

## 6. 打包发布说明

| 项 | 说明 | 来源 |
| --- | --- | --- |
| 目标平台 | Windows x64（`win.nsis` + `win.zip` 双目标） | `electron-builder.yml` |
| 产物路径 | `release/nsis/DSH Desktop Setup*.exe`、`release/zip/DSH Desktop-*-win.zip` | `package.json`、`electron-builder.yml` |
| 校验和 | `release/checksums.txt`（SHA-256，CI 生成并作为 Release 资产） | `.github/workflows/build-and-release.yml` |
| 代码签名 | **未配置**：`electron-builder.yml` 无 `win.certificateFile` / `sign` 配置，产物不带 Authenticode 签名；未签名 exe 会被 Windows SmartScreen 标为"未知发布者" | `electron-builder.yml` |
| appId / 产品名 | `com.youridol.dsh-desktop` / `DSH Desktop`（`app.setPath('userData', …'DSH Desktop')` 与之对齐） | `electron-builder.yml`、`src/main/index.ts` |
| 捆绑运行时 | `resources\dsh-runtime.tgz` 单包随包分发（`extraResources`）；两产物捆绑的 DSH 版本一致（同一 fetch-dsh/pack-runtime） | `electron-builder.yml`、`scripts/pack-runtime.mjs` |
| 安装向导 | oneClick=false（向导式）；perMachine=false（每用户）；允许改目录；创建桌面与开始菜单快捷方式 | `electron-builder.yml` `nsis` 段 |
| 便携标记 | zip 构建经 `afterPack` 写 `resources/portable.marker`；NSIS 不写 | `scripts/after-pack.mjs` |
| 发版通道 | 手动/分支 push 直接发版；上游巡检自动发版（正式版 + dev 候选版） | `.github/workflows/` |
| 风险提示 | 无签名、无自动更新通道（更新 = 用户经控制面板版本页或新装包）；构建需 `GH_TOKEN/GITHUB_TOKEN` 避开 GitHub 匿名限流 | `electron-builder.yml`、`.github/workflows/build-and-release.yml` |