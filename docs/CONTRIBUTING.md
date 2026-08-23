# DSH Desktop 贡献指南

## 1. 开发环境搭建

前置条件：Windows x64、Node.js ≥ 20、npm、Git。

```bash
git clone https://github.com/youridol/dsh-desktop
cd dsh-desktop
npm ci                # 或 npm install（依赖锁为 package-lock.json v3）
npm run fetch-dsh     # 下载捆绑 DSH 运行时与内置 npm CLI 到 .dsh-runtime/
npm run dev           # esbuild 编译并启动应用（运行数据在项目 runtime/ 下）
```

开发期校验命令：

```bash
npm run typecheck     # tsc --noEmit（strict），改动后必须通过
npm run build         # esbuild 编译，验证打包链
```

可选：`npm run make-icons`（改动 `assets/icon.png` 后重新生成 `icon.ico`）。

## 2. 代码规范

仓库不使用 ESLint / Prettier / `.editorconfig`，类型层约束由 `tsconfig.json` 提供：

- `strict: true`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`、`forceConsistentCasingInFileNames`、`isolatedModules`；
- TypeScript 目标 ES2023，`moduleResolution: Bundler`，`noEmit`（类型检查由 `npm run typecheck` 执行）；
- 分层约束：main 进程、preload、renderer 三层分离，renderer 无前端框架（原生 HTML/CSS/TS + esbuild IIFE 打包，见 `scripts/build.mjs`）。

代码编写应遵循仓库既有风格：

- 每个模块顶部保留模块职责注释（参考 `src/main/dsh/manager.ts`、`scripts/build.mjs` 的头部文档注释）；
- 错误处理显式化：可恢复场景用 try-catch 并分类（参考 `src/main/dsh/releases.ts` 的 `GitHubRateLimitError` / `GitHubNetworkError`），不静默吞异常，关键失败写入 `appLog` / `installLog`（`src/main/logger.ts`）；
- 新增 IPC 通道时同步更新对应 preload 桥（`src/preload/`）与 renderer 类型声明（`src/renderer/control/api.ts`）；
- 配置项新增时同步维护 `src/main/config.ts` 的 `DEFAULT_CONFIG` 与字段校验归一化逻辑；
- 路径 / 运行目录逻辑统一走 `src/main/paths.ts`，勿在业务代码中硬编码。

## 3. 提交格式（Conventional Commits）

提交消息统一使用 Conventional Commits 格式：`<type>(<scope>): <subject>`，subject 用简体中文描述，type 小写：

- `feat:` 新功能 / 新命令 / 新组件
- `fix:` 缺陷修复
- `docs:` 文档变更
- `refactor:` 不改行为的结构性重构
- `test:` 测试新增或调整
- `chore:` 依赖 / 构建 / 配置等杂项

示例（对应仓库既有提交）：

```
feat(install): add source-commit install pipeline (ensureCommitInstalled/installCommit)
fix(install): safe rm for junction dirs and dual entry check
docs(install): correct ensureCommitInstalled pipeline comment
chore(deps): bump electron to 43.x
refactor(ipc): split status forwarding from control-panel handlers
test(e2e): add plugin install/uninstall round-trip steps
```

## 4. 分支策略

- `main`：**稳定分支**，唯一接受发布的分支；任何时间点保持可构建、可运行（`npm run build` 与 `typecheck` 通过）。发版 tag 规则绑定 main（`v{版本}`，见 `.github/workflows/build-and-release.yml`）。
- `dev`：集成分支，收集待合入 `main` 的功能；从 `main` 拉出，保持与 `main` 同步。
- `feature/*`：功能 / 修复分支，从 `main`（小改）或 `dev`（跨功能）拉出，命名如 `feature/settings-ui`、`fix/port-conflict`。

规则：

- 禁止直接向 `main` 推送提交（紧急修复走 PR 并附验证）；
- 分支合并前与目标分支 rebase 或 merge 同步，解决冲突后在本地完整验证；
- 非 main 分支的 push 会触发 `build-and-release.yml` 的构建（tag 带分支后缀），注意避免无谓构建。

## 5. PR 流程

1. Fork 本仓库（或使用直接分支开发）；
2. 从 `main`（必要时 `dev`）拉出工作分支 `feature/<name>`；
3. 在分支上完成改动，运行 `npm run typecheck` 与 `npm run build` 自检；
4. 按第 3 节格式提交（一条 PR 对应一个清晰主题，提交粒度适中）；
5. `git push` 分支并创建 Pull Request，标题说明变更主题，描述包含：改动内容、验证方式（typecheck/build/E2E）、关联问题；
6. 等待代码审查（见第 7 节），按评审意见修改后在 PR 内补充提交；
7. 全部通过后合入：功能合并 `dev` → 稳定化后再 `main`（小修复可直接合并 `main`）。

## 6. 测试要求

- 新增功能必须附带可执行的验证；缺陷修复必须附复现 / 回归说明；
- 类型检查：`npm run typecheck` 必须零错误（CI 强制，见 `.github/workflows/build-and-release.yml`）；
- 打包链验证：`npm run build` +（涉及运行时变更时）`npm run fetch-dsh && npm run dist` 本地通过；
- 端到端：以 `--remote-debugging-port=9222` 启动应用，用 `node scripts/e2e-driver.mjs <step> [args]` 走通 `window.dshc` 桥接断言（`scripts/e2e-driver.mjs`；可用 step 见 `exprs` 表）；涉及插件功能时使用 `.e2e/test-plugin/` fixture；
- CI 全绿后方可合并；`build-and-release.yml` 在 push 后会自动构建，以该运行结果为准。

## 7. 代码审查标准（checklist）

审查 PR 时逐项核对：

- [ ] 类型与编译：`tsc --noEmit` 零错误；无 `any` 泄漏；`src/` 内无 `unsafe` / 绕过类型声明
- [ ] 错误处理：新增 IPC handler 与异步链路有异常兜底，错误信息可定位（含上下文与建议）
- [ ] 路径安全：文件操作经 `paths.ts`；无硬编码绝对路径；删除操作沿用 `rmRobust` / `rmDirRecursiveSafe` 对 Windows junction / 只读文件的处理
- [ ] 凭据安全：任何改动不得引入 Token / 凭据到日志、源码、提交或配置文件（`.gitignore` 已排除 `runtime/`、`credentials.json` 仅存运行目录）
- [ ] 进程与生命周期：DSH spawn / 停止沿用状态机与 `taskkill /T` 进程树清理，不引入孤儿进程
- [ ] IPC 边界：preload 桥保持窄、按窗口隔离；远端页面（DSH Web UI）不得获得 node / 敏感通道（`preload/loader.ts` 文件协议守卫逻辑）
- [ ] 兼容性：改动兼容 NSIS 与 zip 便携两种运行目录形态（`paths.ts` 的 `isPortable` 判定）；Windows 分隔符 / `file://` URL 处理
- [ ] 文档同步：行为 / 配置 / 构建步骤变化同步更新 `README.md` 与 `docs/`（或对应 `CHANGELOG.md` 条目）
- [ ] 测试：第 6 节验证项完成并记录

## 许可

贡献即表示同意在 MIT License（`LICENSE`）下发布您的贡献。