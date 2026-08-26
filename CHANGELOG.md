# Changelog

## [v0.8.3] - 2026-08-27

### 完全放行（对 deepseek-harness 零限制）

- **机制层完全放行**：主窗口（承载 DSH Web UI）移除 `setWindowOpenHandler` 弹窗拦截，`window.open` / 新窗口由 deepseek-harness 自身行为原生决定（应用内打开），dsh-desktop 不再对 harness 的任何行为设置限制、拦截、否决或重定向；`dsh web --no-open` 为 harness 官方 CLI 选项（壳层内嵌 UI 的标准集成方式），超时仅作僵死进程看门狗，均不构成对 harness 行为的限制。
- **输入护栏与 harness 行为边界**：控制面板的插件名 / Profile 输入校验（拒绝 shell 元字符、镜像 harness 自身 profile 名校验）仅保护 dsh-desktop 自己的 UI 输入，不对 deepseek-harness 行为设限；harness 的安装 / 执行 / 构建 / 插件 / Web UI 操作全部直通、以其自身行为优先。

### 修复（pnpm 构建脚本拦截 / GitHub 插件安装）

- **pnpm 构建脚本拦截可真实放行并自动重装**：GitHub / git 插件经 `dsh plugin --profile <profile> add <spec>` 安装时，pnpm（≥10）默认拒绝依赖构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` / `build scripts are blocked by pnpm by default`），安装失败。现新增「放行构建脚本并重试」流程：
  - 安装失败时识别 pnpm 构建脚本拦截并解析 pnpm 打印的精确包 spec（`src/main/services/dsh/pnpmBuildPolicy.ts`，识别 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` / `ERR_PNPM_IGNORED_BUILDS` / `Ignored build scripts` / `blocked by pnpm by default` 等信号）；
  - 控制面板插件页在构建脚本被拦截时弹出确认框，点击「放行构建脚本并重试」将拦截包写入该 Profile 的 `pnpm-workspace.yaml` `allowBuilds`（pnpm 11 / pnpm ≥ 10.26 机制）与 `package.json` `pnpm.onlyBuiltDependencies`（pnpm 9 / pnpm 10 ≤ 10.25 兼容），随后自动重新执行安装；授权是真实策略写入，非仅 UI 状态；
  - 插件名校验支持 GitHub/git 安装地址（`github:owner/repo`、`https://github.com/...`、`git+...` 等），npm 包名与原有安全校验（拒绝 shell 元字符）保持不变；git 安装按 manifest 依赖 diff 映射回真实包名展示。
- 不修改 `deepseek-harness` 上游代码：仅操作 dsh-desktop 自身管理的 Profile 策略文件，dsh 安装 / 执行 / 构建 / 插件操作全部直通，无额外拦截、沙箱或二次阻断。

### 验证

- `test/pnpm-build-policy.test.mjs` 新增 9 个用例（信号识别、`allowBuilds` spec 与包名解析、workspace/manifest 授权合并、幂等）；`test/plugin-service.test.mjs` 新增构建拦截抛出与「授权后自动重试并持久化」用例；`npm run typecheck`、`npm run build` 与全部 119 项测试通过。
- 真实 dsh CLI 端到端验证：首次 `dsh plugin add <git-spec>` 被 pnpm 拦截 → 解析出精确 spec → 授权 → 重试 exit 0 且 `prepare` 构建产物落盘。
- 全量审计确认：dsh-desktop 对 harness 无任何二次拦截（无 `ignore-scripts` / 限制性环境变量 / webRequest / 权限处理器 / 弹窗拦截），命令层完整透传环境与参数。
- 文档规范化：README、README.original（历史存档标注）、docs/ARCHITECTURE、docs/CONTRIBUTING、docs/DEPLOYMENT 与 CHANGELOG 统一至 v0.8.3。
## [v0.8.2] - 2026-08-27

### 修复（控制面板与悬浮球自愈）

- **修复浮动图标消失 / 入口丢失**：新增窗口守护（`src/main/windows/supervisor.ts`）统一监听子窗口生命周期与渲染健康（`render-process-gone` / `did-fail-load` / 轮询）；悬浮球窗口丢失或渲染进程崩溃后自动重建并复位，可见性与位置周期对账，启动后入口稳定存在、异常场景可自动恢复。
- **修复托盘打开控制面板全白**：控制面板打开前校验渲染健康（崩溃先重建），首帧就绪后再显示避免白屏；渲染进程崩溃 / 页面加载失败自动重建或重载并恢复打开状态，隐藏期不节流（`backgroundThrottling:false`）保证打开即用。
- 恢复动作限流防抖，重建幂等（避免并发恢复竞态销毁新窗口）；不修改 `deepseek-harness` 上游代码，仅 dsh-desktop 自身实现修复。

### 验证

- `test/window-supervisor.test.mjs` 新增窗口健康决策与恢复限流用例；`npm run typecheck`、`npm run build` 与全部 106 项测试通过。
- 真实实例验证：悬浮球 / 控制面板渲染进程崩溃后均自动恢复；托盘往返（最小化 → 隐藏 → 恢复）行为无回归。
## [v0.8.1] - 2026-08-27

### 修复（插件安装方式切换）

- 修复控制面板插件安装方式按钮组无法双向自由切换的问题：`npm` / `npx` / `dsh` 三种方式均可独立切换，初始化选择任一方式后可随时切回；按钮名称统一为 `dsh`，选中状态、Profile 输入显隐与安装逻辑保持同步。

### 新增（Skills Agent 管理）

- Skills 页新增 Agent 管理模块，同时展示并管理全局目录 Agent 与项目目录 Agent（目录束 / 扁平 Markdown），支持刷新、启用 / 停用与删除。
- 项目作用域改为「清单 + 磁盘 Agent 扫描合并」，项目目录中已有的本机 Agent 可直接读取与管理；沿用现有 Skills 生命周期与 IPC，不修改 `deepseek-harness` 上游代码。

### 验证

- `test/skills-service.test.mjs` 新增项目 Agent 合并、策略启停、纯磁盘删除与扁平 `.md` 管理用例；`npm run typecheck`、`npm run build` 与全部 71 项测试通过。

## [v0.8.0] - 2026-08-26

### 重构（控制面板 UI 统一与 Skills 概览修复）

- **Skills 概览数据修复**：概览卡片改为随数据刷新重渲染，不再停留在初始化占位符；展示仓库 / 已安装 / 全局 / 项目 / 备份统计与全部路径（Skills 目录、仓库缓存、全局目录、项目目录、备份目录、Agents Home、默认仓库），不遗漏、不截断。
- **Skills 页签布局重构**：按功能分组为「概览 · 仓库 · 已安装 · GitHub 搜索 · 备份与迁移」，相关卡片横向并排（响应式 `skills-cols` 网格），移除空壳卡片与冗余留白。
- **shadcn/ui 风格统一**：新增 `src/renderer/control/ui/` 组件库（Button / Card / Badge / Switch / Segmented / Select / Dialog / Progress / List，紧凑小号设计令牌），控制面板全部页签（仪表盘 / 插件 / Skills / 版本 / 日志与状态 / 设置）及其 Widget 统一迁移，原生 `confirm`/`alert` 替换为自定义 Dialog。
- **主窗口默认尺寸**：主窗口默认 1600×900（保持可缩放，最小 960×600），控制面板其余窗口行为不变。

## [v0.7.1] - 2026-08-26

### 修复（Skills 管理页对接 deepseek-harness Agents/Skills）

- **统一路径解析**（新增 `src/main/services/skills/harnessPaths.ts`）：`~` / `~/` / `~\` 前缀一律按用户 Home（`os.homedir()`）展开，禁止把 `~` 当作普通相对路径；`agentsHome` 遵循 `$DSH_AGENTS_HOME`（缺省 `~/.agents`），与上游 `dsh-skill-filesystem` 语义一致，Windows/Linux/macOS 均正确解析。
- **全局 Skills 路径修正**：`global` 作用域从 dsh-desktop 私有 `skills/global` 改为 deepseek-harness 真实全局根 `<agentsHome>/skills`（Windows 例如 `C:\\Users\\Administrator\\.agents\\skills`）；启动、刷新、安装、启用/禁用、删除均基于该真实路径与统一路径解析逻辑。
- **已有 Skills 可见**：`skills:listInstalled`（global）改为「清单 + 磁盘扫描合并」，deepseek-harness 已有 agent 技能（`<name>/SKILL.md` 目录束或 `<name>.md` 扁平，单层扫描）直接显示并可管理；安装到全局按 harness 规范（kebab 目录名 + SKILL.md 前导 `name`/`description` 规范化）。
- **启停对上游真实生效**：全局技能启用/停用额外写/删 `disable-model-invocation` / `user-invocable` 前导策略，与 deepseek-harness 机制兼容；更新/检测更新跳过无仓库来源的本地 agent 技能。
- **测试扩充**：`test/skills-service.test.mjs` 新增路径解析（~ 展开 / agentsHome / 统一路径）、agent 单层扫描、frontmatter 修补与全局合并/启停/卸载用例，全部 28 个用例通过；`npm run typecheck` 与 `npm run build` 通过。

## [v0.7.0] - 2026-08-26

### 新增（控制面板 Skills 管理页签）

控制面板新增「Skills」页签，Skills 能力完全在 dsh-desktop 内自管理（仓库注册表、作用域安装、备份恢复），不修改 `deepseek-harness` 上游源码，未来上游升级无需本项目私有改动：

- **主进程 Skills Service**（`src/main/services/skills/`）：`validation.ts`（URL / 名称 / 路径 / 作用域校验）、`discovery.ts`（扫描仓库内 SKILL.md 技能目录与 frontmatter 元数据）、`gitRunner.ts`（浅克隆 / 拉取，凭据经 `http.extraHeader` 传递）、`repositoryManager.ts`（仓库注册表 `skills/repositories.json` + 克隆缓存 `skills/repos/`）、`lifecycle.ts`（global/project 作用域隔离安装清单 `skills/<scope>/index.json`）、`backup.ts`（JSON 导出导入 + 本地备份）、`skillsService.ts`（门面，供 IPC 调用）。
- **仓库管理**：添加 / 编辑 / 删除 / 启用停用 / 拉取刷新 / 全部同步；默认示例仓库 `https://github.com/mattpocock/skills`；私有仓库复用设置页 GitHub 凭据。
- **Skills 生命周期**：查看全局与项目 Skills；单 / 批量启用、停用、卸载、删除；查看来源仓库、路径、commit、安装状态；检测上游更新（对比来源 commit）并执行更新同步。
- **GitHub 搜索**：`skills:search` 走 GitHub Search API，支持一键添加仓库并安装到当前作用域。
- **备份与迁移**：导出配置 / 导出含技能内容 / 导入 / 创建备份 / 恢复 / 删除备份；导入校验格式版本、路径安全与冲突（已存在技能默认冲突，可覆盖）。
- **测试**（`test/skills-service.test.mjs`）：19 个用例覆盖校验、发现、仓库注册表同步、生命周期作用域隔离、备份导入恢复。

## [v0.6.0] - 2026-08-25

### 新增（控制面板仪表盘 Dashboard）

控制面板新增「仪表盘」页签（默认首个页签），统一监控 DSH 服务、插件、版本与异常汇总：

- **新增统一 Widget 合约与注册表**（`src/renderer/control/tabs/dashboard/widget.ts`）：`DashboardWidget`（id / title / refreshIntervalMs / render / refresh / dispose）+ `registerDashboardWidget()`。控制面板壳（`app.ts`）不感知具体监控内容，新增监控模块只需在 `tabs/dashboard/widgets/` 新建文件注册并在 `tabs/dashboard.ts` 顶部 import，无需修改核心架构、preload 或 IPC。
- **新增仪表盘壳**（`src/renderer/control/tabs/dashboard.ts`）：挂载已注册 Widget 卡片、注入 `bridge()/toast` 上下文，按各 Widget 的 `refreshIntervalMs` 统一周期刷新，并提供单卡片手动刷新。
- **内置四个 Widget**（`tabs/dashboard/widgets/`）：DSH 服务（状态 / 端口 / PID / 版本 / 运行时长 + 启停重启，复用 `app:getState` 与 `dsh:status` 事件）；插件概览（已安装 / 已启用 / 异常计数与最近启用插件，复用 `plugins:list`）；版本概览（当前 DSH / 桌面壳 / 本机已装版本，复用 `app:getState`）；异常与错误（错误 / 警告计数与最近异常，复用 `logs:subscribe` / `logs:line` / `logs:cleared`，含清空与查看日志入口）。
- **控制面板壳**（`app.ts` / `index.html` / `style.css`）：五页签（仪表盘 / 插件 / 版本 / 日志与状态 / 设置），仪表盘为默认激活页；新增仪表盘样式（`.dash-grid` 卡片网格、`.dash-count` 指标数等），不影响既有页签。
- **测试**（`test/dashboard-widget.test.mjs`）：Widget 注册表顺序 / 重复 id 拒绝 / 快照语义 / 可选 refresh 保留，共 4 用例。


## [v0.5.1] - 2026-08-25

### 修复

- 修复版本管理检测进度条永久动画问题（进度条由真实状态 idle → checking → success/error 驱动）
- 优化右下角控制面板入口视觉样式（去除圆形背景，仅保留图标）


## [v0.5.0] - 2026-08-25

### 新增（插件安装来源模型 + dsh Harness profile 原生安装通道）

插件安装不再只有隐性来源：dsh-desktop 引入显式安装来源模型 npm / npx / dsh Harness（dsh-profile），安装来源与安装到的 Profile 作为插件元数据持久化到 profile manifest，列表展示、卸载/启停按来源与 Profile 路由，为未来 git / url / local / marketplace 等新通道预留策略扩展点。

- **新增 `src/main/services/dsh/DshPluginInstaller.ts`**（安装策略层）：`runInstall(options)` 按显式 `source` 分发到 NpmPluginInstaller / NpxPluginInstaller / DshProfilePluginInstaller，参数数组构建（严禁 shell 拼接），`dsh plugin --profile <profile> add <plugin>` 为 dsh Harness 原生通道；校验前置（未知来源、插件名非法、dsh-profile 缺 profile）以结构化 `PluginInstallError(code/message/cause)` 返回，失败不写任何成功记录。
- **来源模型与元数据**（`src/main/services/dsh/DshPluginService.ts`）：`PluginView` 新增 `source`（npm / npx / dsh-profile）、`profile`、`installedAt`；安装记录写入 manifest 的 `dsh.desktop.plugins`（与 dsh 自身 `dsh.profile.bundles` 隔离）；`installPlugin(options)` 成功即持久化 source+profile+installedAt 并刷新列表；卸载/启停经记录中的 Profile 路由（`dsh plugin --profile <profile> remove <name>`，命令已由 dsh CLI 源码确认为 pnpm remove 转发）；旧数据无 source/profile 时回退 `dsh-profile`/`web`，列表、卸载、启停均不受影响。
- **UI 改造**（`src/renderer/control/tabs/plugins.ts`）：安装卡新增「安装方式」单选（npm / npx / dsh Harness），选 dsh Harness 时显示 Profile 输入框（默认 web），无需手填 CLI 命令；插件列表以徽标展示来源（「dsh Harness」accent / 「npm」ok / 「npx」warn）并显示 Profile；卸载确认提示来源与 Profile。
- **IPC / 桥接**：`plugins:add` 由裸 name 改为 `{ name, source, profile? }` 选项对象（`src/main/ipc.ts`、`src/preload/control.ts`、`src/renderer/control/api.ts`），`addPlugin(name)` 保留为兼容包装。
- **测试**（`test/plugin-service.test.mjs` 增加 13 用例）：三种来源策略选择与命令参数断言（`dsh plugin --profile web add dshmarket` 精确匹配）、dsh-profile 缺 profile / 插件名空白 / profile 含 shell 元字符的校验、未知来源显式拒绝、dsh CLI 缺失的明确错误（含「DeepSeek Harness」提示文案）、非零退出不写成功记录、成功安装持久化 source+profile+installedAt、旧数据无 source/profile 的兼容回退。全量 27 用例通过。
- **文档**：README.md 新增「插件安装来源」章节说明三种方式区别、Profile 作用、UI 操作与 dsh CLI 缺失处理；docs/ARCHITECTURE.md 模块表补充安装策略层与元数据说明。
## [v0.4.0] - 2026-08-25

### 重构（插件管理迁移到 dsh harness 上游插件机制）

dsh-desktop 不再自行实现插件安装/依赖/加载链路，改为 **dsh harness web 插件的桌面端衍生管理工具**：所有插件操作经 dsh harness 上游 `dsh plugin --profile web` CLI（内部转发 pnpm，npm/npx 包解析与依赖安装全部交给 dsh harness），插件列表实时读取 Web profile manifest（`$DSH_HOME/profiles/web/package.json` 的 `dependencies` + `dsh.profile.bundles`）。dsh-desktop 只做 CLI 调用方（安全参数数组、超时、stdout/stderr/exitCode 处理）与 UI 封装，未修改任何上游代码。

- **新增 `src/main/services/dsh/DshCommandExecutor.ts`**：安全 dsh CLI 执行器——参数数组（严禁 shell 拼接，防命令注入）、stdout/stderr/exitCode 捕获、超时与进程树终止、错误结构化；dsh bin 经当前激活版本运行时解析（`resolveActiveDir` 回退捆绑版）。
- **新增 `src/main/services/dsh/DshPluginService.ts`**：profile 插件服务——`listPlugins`（读 manifest 汇总 installed + enabled + isBundle + version + description）、`addPlugin`（`dsh plugin --profile web add <包名>`，包名合法性校验）、`removePlugin`/`uninstallPlugin`（`… remove <包名>`）、`enablePlugin`/`disablePlugin`（加/移 `dsh.profile.bundles`，仅改 manifest 不卸载包）、`exportPluginInfo`（读已装包 package.json 元数据，用于「导出 = 复制 包名@版本」）。
- **IPC 精简**（`src/main/ipc.ts`）：路由改为 `plugins:list/add/remove/enable/disable/uninstall/export/apply`；**删除** `plugins:addLocal`（本地目录对话框安装）与 `plugins:addGit`（GitHub URL 克隆安装）两个通道；renderer 不可执行 shell 的边界不变。
- **控制面板插件页重写**（`src/renderer/control/tabs/plugins.ts`）：移除「从本地目录安装…」「从 Git 仓库克隆」入口，改为 npm 包名输入 + 安装按钮；插件条目展示 包名 / 版本 / 插件层徽标 / 启用-禁用开关 / 卸载 / 导出（复制到剪贴板）/ 刷新；统一 idle→loading→success→error 状态处理。
- **DSH 启动不再用 `--patch` overlay**（`src/main/dsh/manager.ts`）：删除 `writePatchOverlay` 调用与 `ensureEnabledPluginsReady`（不再逐插件自行 npm install）；spawn 简化为 `dsh web --no-open --port <n>`，插件由 Web profile 在启动时自动挂载。
- **删除旧机制**：`src/main/builtin-plugins.ts`（内置预设 llm-siliconflow 的 tarball 下载/解压/依赖安装循环）、`src/main/plugin-deps.ts`（自管 npm 依赖安装）、`src/main/plugins.ts` 的 `addLocalPlugin`/`addGitPlugin`/`writePatchOverlay`/`setPluginDepsError`/`listPlugins`/`setPluginEnabled`/`removePlugin`（仅保留 `rmRobust`）、`config.ts` 的 `suppressedPresets` 与 `source: 'preset'`；对应 UI / IPC / preload / 测试一并移除。`.e2e` 驱动 `scripts/e2e-driver.mjs` 同步替换为 `add/enable/disable/uninstall/export` 步骤。
- **测试**：删除 `test/builtin-plugins.test.mjs`、`test/plugin-deps.test.mjs`；新增 `test/plugin-service.test.mjs`（12 用例：manifest 读取/排序、enable/disable 幂等、export、缺文件容错，均以临时 DSH_HOME 隔离）。
- **文档同步**：README.md 与 docs/ARCHITECTURE.md / docs/DEPLOYMENT.md 移除本地目录 / Git 克隆 / patch overlay / 内置预设描述，改为 dsh profile 插件机制说明。

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
