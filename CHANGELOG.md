# Changelog

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