/**
 * 仪表盘 Widget 合约（统一扩展接口）。
 *
 * 仪表盘页签（../dashboard.ts）只是一个薄壳：负责挂载已注册的 Widget 卡片并按
 * refreshIntervalMs 驱动定时刷新。新增一个监控模块只需：
 *
 *   1. 在 ./widgets/ 下新建文件，实现 DashboardWidget；
 *   2. 调用 registerDashboardWidget(...) 注册；
 *   3. 在 ../dashboard.ts 顶部 import 该文件。
 *
 * 不需要修改仪表盘壳、app.ts、preload 或主进程 IPC —— 后续模块可独立开发、
 * 替换与扩展。
 */
import type { Bridge } from '../../api'

/** Widget 运行时可用的控制面板能力（由仪表盘壳注入）。 */
export interface DashboardWidgetContext {
  /** 访问控制面板 preload 桥接（window.dshc）。 */
  bridge(): Bridge
  /** 在控制面板底部弹出提示。 */
  toast(msg: string, err?: boolean): void
}

/** 仪表盘监控模块的统一接口。 */
export interface DashboardWidget {
  /** 全局唯一 id（用于 DOM 挂载点与刷新记账）。 */
  id: string
  /** 卡片标题。 */
  title: string
  /** 自动刷新周期（毫秒）。省略时仅由事件驱动或手动刷新。 */
  refreshIntervalMs?: number
  /** 初始化：把 Widget 内容挂到 host 中（只调用一次）。 */
  render(host: HTMLElement, ctx: DashboardWidgetContext): void
  /** 周期刷新（可选）；由壳按 refreshIntervalMs 调用。 */
  refresh?(ctx: DashboardWidgetContext): void | Promise<void>
  /** 卸载清理（可选）：用于退订事件等。 */
  dispose?(ctx: DashboardWidgetContext): void
}

const registry = new Map<string, DashboardWidget>()

/** 注册一个仪表盘 Widget；重复 id 直接报错，避免静默覆盖。 */
export function registerDashboardWidget(widget: DashboardWidget): void {
  if (registry.has(widget.id)) {
    throw new Error(`仪表盘 Widget id 重复：${widget.id}`)
  }
  registry.set(widget.id, widget)
}

/** 返回按注册顺序排列的全部 Widget。 */
export function dashboardWidgets(): DashboardWidget[] {
  return [...registry.values()]
}
