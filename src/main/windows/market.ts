/**
 * 插件市场原生界面窗口。
 *
 * dsh-market 的原生 Web UI（MarketSection）是注册在 DSH 设置对话框
 * settings.section 槽位（id = 'market'）里的 React 组件，没有独立 URL。
 * 要在 dsh-desktop 内展示它，本窗口直接以与主窗口完全相同的路径加载
 * DSH Web UI（loadURL serviceUrl），再通过原生选择器（设置触发器
 * button[aria-haspopup=dialog] → 对话框内「插件市场」导航项）打开该分节
 * ——所有交互仍是 dsh-market 官方 React 组件，行为与主窗口完全一致，
 * 不改动 deepseek-harness / dsh-market 任何代码。
 *
 * 与 DshMarketService.openMarket 的自动化脚本保持一致（同源选择器）；
 * 差异仅在于本窗口不聚焦主窗口，而是自身承载市场界面。
 */
import { BrowserWindow } from 'electron'
import { getStatus } from '../dsh/manager'
import { iconPath } from './main'
import { appLog } from '../logger'

let marketWin: BrowserWindow | null = null
let autoOpening = false

export function getMarketWindow(): BrowserWindow | null {
  return marketWin
}

/** 当前 DSH 服务地址；未运行时返回 null。 */
function serviceUrl(): string | null {
  const status = getStatus()
  return status.state === 'running' ? status.serviceUrl : null
}

/**
 * 打开（或聚焦）市场原生界面窗口。
 *  - DSH 未运行 → 启动 DSH 后重试（调用方负责启动，这里直接返回 false）；
 *  - 已存在 → 聚焦并重新尝试打开市场分节；
 *  - 新建 → 加载 DSH Web UI，dom-ready 后执行原生自动化打开 设置 → 插件市场。
 */
export function openMarketWindow(): boolean {
  const url = serviceUrl()
  if (!url) return false

  let win = marketWin
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      title: 'DSH 插件市场',
      autoHideMenuBar: true,
      icon: iconPath(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    marketWin = win
    win.on('closed', () => {
      if (marketWin === win) marketWin = null
    })
    win.webContents.setWindowOpenHandler(() => {
      // 与主窗口一致：完全放行 harness 原生弹窗行为（不拦截）。
      return { action: 'allow' }
    })
    void win.loadURL(url)
    win.webContents.on('dom-ready', () => {
      void openMarketSection(win!)
    })
    win.once('ready-to-show', () => win?.show())
  } else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    void openMarketSection(win)
  }
  return true
}

/** 关闭市场窗口（销毁）。 */
export function destroyMarketWindow(): void {
  if (marketWin && !marketWin.isDestroyed()) marketWin.destroy()
  marketWin = null
}

/**
 * 在窗口内打开设置 → 插件市场分节（等效用户点击，与
 * DshMarketService.openMarketSectionViaHost 共用同一套原生选择器）。
 */
async function openMarketSection(win: BrowserWindow): Promise<void> {
  if (autoOpening) return
  if (win.isDestroyed()) return
  autoOpening = true
  try {
    const wc = win.webContents
    // 1. 设置触发器（sidebar.settings occupant 的按钮）。
    const triggerScript = `
      (() => {
        try {
          const t = document.querySelector('button[aria-haspopup="dialog"]');
          if (!t) return false;
          t.click();
          return true;
        } catch { return false; }
      })()
    `
    // executeJavaScript 在页面 SPA 启动高峰期可能长时间不 resolve；
    // 套一层超时避免自动化流程卡死窗口。
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`executeJavaScript timeout after ${ms}ms`)), ms)),
      ])
    const opened = await withTimeout(wc.executeJavaScript(triggerScript, true), 10_000)
    if (opened !== true) {
      appLog.info('[MarketWin] 设置触发器未找到（页面可能仍在加载），等待后重试')
      // 页面可能尚未完成 SPA 启动：等 3 秒重试一次。
      await new Promise((r) => setTimeout(r, 3000))
      const retry = await withTimeout(wc.executeJavaScript(triggerScript, true), 10_000)
      if (retry !== true) return
    }
    // 2. 在设置对话框内点击「插件市场」导航项。
    const navScript = `
      (() => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        return (async () => {
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
    const navigated = await withTimeout(wc.executeJavaScript(navScript, true), 15_000)
    if (navigated !== true) {
      appLog.info('[MarketWin] 未定位到「插件市场」导航项（可能语言/布局差异），设置面板已打开')
    }
  } catch (err) {
    appLog.warn(`[MarketWin] 打开市场分节失败（不影响使用，可手动点 设置 → 插件市场）: ${String(err)}`)
  } finally {
    autoOpening = false
  }
}
