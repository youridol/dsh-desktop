/**
 * dsh-market（dshmarket 插件）桌面端快捷配置入口服务。
 *
 * dsh-desktop 只作为 dsh-market 的快捷入口与状态层，不重复实现插件逻辑：
 * dsh-market 的 Web UI 由 DSH Web UI 原生承载（设置 → 插件市场，
 * `settings.section` 槽位 id `market`），本模块只做三件事：
 *
 *  1. 探测市场是否已安装 / 已启用 / 已挂载（复用 DshPluginService 读取
 *     profile manifest，并通过 DSH Web 服务的 /dsh-market/status 判断挂载）；
 *  2. 本地未安装时自动安装（复用既有 npm 安装通道 + 启用逻辑，安装来源
 *     记为 npm，与手动安装行为完全一致）；
 *  3. 打开市场：确保已装 → 未生效则重启 DSH → 聚焦主窗口 → 在 DSH Web UI
 *     内打开设置对话框并定位「插件市场」区（等效用户点击，不修改任何
 *     deepseek-harness / dsh-market 代码、配置或行为）。
 *
 * 与上游机制保持一致：市场本体始终从 npm 安装 `dshmarket` 原包，不做任何
 * 源码修改或打包改写，未来可直接随上游同步更新。
 */
import { getStatus as realGetStatus, restart as realRestart } from '../../dsh/manager'
import { getMainWindow as realGetMainWindow, showMainWindow as realShowMainWindow, syncNavigation as realSyncNavigation } from '../../windows/main'
import { appLog } from '../../logger'
import {
  listPlugins,
  installPlugin,
  enablePlugin,
  type PluginView,
} from './DshPluginService'
import { openProfilePnpmPolicy } from './pnpmBuildPolicy'
import { execDsh, type ExecResult } from './DshCommandExecutor'

/** dsh-market 的 npm 包名（上游 dshmarket 包）。 */
export const MARKET_PACKAGE = 'dshmarket'

/** 市场安装到（并管理）的 profile —— 与 dsh-desktop 既有插件管理一致。 */
export const MARKET_PROFILE = 'web'

/** 打开市场时，等待 DSH 重启就绪的最长时间。 */
const OPEN_READY_TIMEOUT_MS = 30_000

// ---- types ----

export interface DshMarketStatus {
  /** DSH 服务是否在运行。 */
  dshRunning: boolean
  /** DSH 服务地址（http://127.0.0.1:<port>），用于内嵌市场 iframe。 */
  serviceUrl: string
  /** dshmarket 是否已安装到 web profile（dependencies 存在）。 */
  installed: boolean
  /** dshmarket 是否已在 dsh.profile.bundles 中启用。 */
  enabled: boolean
  /** 已安装版本（来自 profile node_modules 的 package.json）。 */
  version: string | null
  /** 市场是否已挂载（当前运行中的 DSH Web 服务 /dsh-market/status 可达）。 */
  active: boolean
  /** 市场自报的版本（来自 /dsh-market/status 的 version 字段）。 */
  activeVersion: string | null
  /** 市场是否可用（已安装 + 已启用 + 已挂载）。 */
  available: boolean
}

/** DSH 宿主交互面：默认接真实模块，测试注入替身，保持低耦合。 */
export interface MarketHost {
  /** 当前 DSH 状态（manager.getStatus 的结构子集）。 */
  getStatus(): { state: string; serviceUrl: string }
  /** 重启 DSH 服务。 */
  restart(): Promise<void>
  /** 聚焦主窗口并确保其导航到 DSH UI（windows/main 的结构子集）。 */
  reveal(): Promise<void>
  /** 在主窗口 webContents 上执行脚本（打开设置对话框用）。 */
  execute(script: string): Promise<unknown>
}

/** 默认宿主：对接真实 manager / windows/main（生产路径）。 */
const realHost: MarketHost = {
  getStatus: () => realGetStatus(),
  restart: () => realRestart(),
  reveal: async () => {
    const win = realGetMainWindow()
    if (win && !win.isDestroyed()) {
      realShowMainWindow()
      await realSyncNavigation()
    }
  },
  execute: async (script) => {
    const win = realGetMainWindow()
    if (!win || win.isDestroyed()) return false
    return win.webContents.executeJavaScript(script, true)
  },
}

/** 当前宿主（生产用 realHost，测试可注入）。 */
let activeHost: MarketHost = realHost
export function setMarketHostForTest(host: MarketHost): void {
  activeHost = host
}

// ---- profile / manifest read (reuse DshPluginService) ----

/** 从既有插件列表中取 dshmarket 的行（未安装时返回 null）。 */
function marketPlugin(): PluginView | null {
  try {
    return listPlugins().plugins.find((p) => p.packageName === MARKET_PACKAGE) ?? null
  } catch (err) {
    appLog.warn(`marketStatus: 读取插件列表失败: ${String(err)}`)
    return null
  }
}

/** 探测 DSH Web 服务上的市场挂载状态（仅当服务运行时有效）。 */
export async function probeMarketHttp(serviceUrl: string): Promise<{ active: boolean; version: string | null }> {
  try {
    const res = await fetch(`${serviceUrl}/dsh-market/status`, {
      signal: AbortSignal.timeout(4000),
    })
    if (res.status === 404) return { active: false, version: null }
    if (!res.ok) return { active: false, version: null }
    const body = (await res.json().catch(() => null)) as { version?: unknown } | null
    return {
      active: true,
      version: typeof body?.version === 'string' ? body.version : null,
    }
  } catch (err) {
    appLog.warn(`marketStatus: /dsh-market/status 探测失败: ${String(err)}`)
    return { active: false, version: null }
  }
}

/** 组装当前市场状态。 */
export async function marketStatus(): Promise<DshMarketStatus> {
  const status = activeHost.getStatus()
  const plugin = marketPlugin()
  const installed = plugin !== null
  const enabled = plugin?.enabled ?? false
  const version = plugin?.version ?? null

  let active = false
  let activeVersion: string | null = null
  if (status.state === 'running') {
    const probe = await probeMarketHttp(status.serviceUrl)
    active = probe.active
    activeVersion = probe.version
  }

  return {
    dshRunning: status.state === 'running',
    serviceUrl: status.serviceUrl,
    installed,
    enabled,
    version,
    active,
    activeVersion,
    available: installed && enabled && active,
  }
}

// ---- install / enable ----

/**
 * 确保 dshmarket 已安装并启用（复用既有 npm 安装通道）。
 *
 * 前置：打开目标 profile 的 pnpm 策略（minimumReleaseAge: 0 +
 * dangerouslyAllowAllBuilds），使 pnpm 的供应链闸门（新鲜发布等待期、
 * 构建脚本拦截）完全不拦截任何安装——包括市场后续安装 git 类插件
 * （如 dsh-git-graph）时一次性成功。
 *
 * - 未安装 → `dsh plugin --profile web add dshmarket`（source 记为 npm，
 *   与手动安装完全一致）；
 * - 已安装但未启用 → 加入 dsh.profile.bundles（启用后重启 DSH 生效）。
 *
 * 幂等：已安装且已启用时直接返回。
 */
export async function ensureMarketInstalled(
  executor?: (args: string[], options?: { timeoutMs?: number }) => Promise<ExecResult>,
): Promise<{ installed: boolean; enabled: boolean; changed: boolean }> {
  // Open the profile's pnpm policy first so the market's own installs (and
  // every plugin install the market runs later) are never blocked by pnpm's
  // supply-chain gates — minimumReleaseAge hold and build-script blocking
  // are both disabled at the policy level, matching the desktop's own
  // installPlugin behavior.
  openProfilePnpmPolicy(MARKET_PROFILE)
  let plugin = marketPlugin()

  if (!plugin) {
    appLog.info('[DshMarket] 检测到 dshmarket 未安装，自动安装（npm 通道）')
    const installed = await installPlugin({ name: MARKET_PACKAGE, source: 'npm', profile: MARKET_PROFILE }, executor ?? execDsh)
    plugin = installed.find((p) => p.packageName === MARKET_PACKAGE) ?? marketPlugin()
  }

  const installedNow = plugin !== null
  const enabledNow = plugin?.enabled ?? false

  if (installedNow && !enabledNow) {
    appLog.info('[DshMarket] 启用 dshmarket（写入 dsh.profile.bundles）')
    enablePlugin(MARKET_PACKAGE)
  }

  return { installed: installedNow, enabled: installedNow, changed: installedNow }
}

// ---- open market ----

/**
 * 在应用内打开插件市场：
 *  1. 确保已安装 + 已启用（缺失自动安装）；
 *  2. 若市场尚未挂载（安装/启用后未重启，或服务未运行）→ 启动/重启 DSH；
 *  3. 聚焦主窗口（必要时从 loader 页导航到 DSH UI）；
 *  4. 在 DSH Web UI 内打开设置对话框并定位「插件市场」区（等效用户点击的
 *     尽力而为自动化，失败则仅聚焦主窗口，用户手动点设置 → 插件市场）。
 *
 * 全程不修改 deepseek-harness / dsh-market 的代码、配置或行为。
 */
export async function openMarket(): Promise<DshMarketStatus> {
  await ensureMarketInstalled()

  let status = activeHost.getStatus()
  if (status.state !== 'running') {
    appLog.info('[DshMarket] DSH 未运行，启动服务')
    const { start } = await import('../../dsh/manager')
    await start()
    status = activeHost.getStatus()
  }

  // 安装/启用后市场需要 DSH 重启才会挂载（dsh.profile.bundles 生效）
  const probe = await marketStatus()
  if (status.state === 'running' && !probe.active) {
    appLog.info('[DshMarket] 市场尚未挂载，重启 DSH 使其生效')
    await activeHost.restart()
    const deadline = Date.now() + OPEN_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const s = activeHost.getStatus()
      if (s.state === 'running') {
        const again = await marketStatus()
        if (again.active) break
      } else if (s.state === 'error' || s.state === 'crashed') {
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  const finalStatus = await marketStatus()

  // 聚焦主窗口并确保其已导航到 DSH UI
  await activeHost.reveal()
  if (finalStatus.active) {
    await openMarketSectionViaHost()
  }

  return finalStatus
}

/**
 * 在 DSH Web UI 内打开设置对话框并定位「插件市场」区（可在任意承载 DSH
 * Web UI 的页面/iframe 中执行，包括市场窗口与内嵌容器）。
 *
 * 选择器依据 DSH Web UI 官方产物（dsh-client-ui-settings-general）：
 * 设置触发器按钮带 `aria-haspopup="dialog"`；设置面板是 `role="dialog"`；
 * 导航项是含 label 的按钮（市场区 id `market`，label 随 UI 语言为
 * 「插件市场」/「Plugin Market」）。与用户点击等价，失败即静默回退。
 *
 * 该脚本通过 IPC 提供给内嵌市场 iframe（与主窗口宿主共用同一套选择器）。
 */
export function openMarketSectionScript(): string {
  return OPEN_MARKET_SECTION_SCRIPT
}

export const OPEN_MARKET_SECTION_SCRIPT = `
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    try {
      const trigger = document.querySelector('button[aria-haspopup="dialog"]');
      if (trigger) trigger.click();
    } catch {}
    for (let i = 0; i < 30; i++) {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const cells = [...dialog.querySelectorAll('button')];
        const target = cells.find((b) => /插件市场|Plugin Market|Market/.test(b.textContent || ''));
        if (target) { target.click(); return true; }
      }
      await sleep(200);
    }
    return false;
  })();
})()
`

/** 在 DSH Web UI 内打开设置对话框并定位「插件市场」区（主窗口宿主）。 */
async function openMarketSectionViaHost(): Promise<void> {
  const triggerScript = `
    (() => {
      try {
        const trigger = document.querySelector('button[aria-haspopup="dialog"]');
        if (!trigger) return false;
        trigger.click();
        return true;
      } catch { return false; }
    })()
  `
  try {
    const opened = await activeHost.execute(triggerScript)
    if (opened !== true) {
      appLog.info('[DshMarket] 设置触发器未找到，回退为仅聚焦主窗口')
      return
    }
    const navScript = `
      (() => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        return (async () => {
          for (let i = 0; i < 20; i++) {
            const dialog = document.querySelector('[role="dialog"]');
            if (dialog) {
              const cells = [...dialog.querySelectorAll('button')];
              const target = cells.find((b) => /插件市场|Plugin Market|Market/.test(b.textContent || ''));
              if (target) { target.click(); return true; }
            }
            await sleep(150);
          }
          return false;
        })();
      })()
    `
    const navigated = await activeHost.execute(navScript)
    if (navigated !== true) {
      appLog.info('[DshMarket] 未定位到「插件市场」导航项（可能语言/布局差异），设置面板已打开')
    }
  } catch (err) {
    appLog.warn(`[DshMarket] 打开市场区失败（不影响使用，可手动进入设置 → 插件市场）: ${String(err)}`)
  }
}
