/**
 * 版本检测进度条状态机（纯逻辑、无 DOM 依赖，可独立回归测试）。
 *
 * 进度条必须由真实检测状态驱动：
 *   idle → checking → success | error
 * 只有 checking 状态允许 indeterminate loading 动画；
 * 进入 success/error 后动画立即停止，避免「进度条一直左右横移」。
 */
export type VersionCheckStatus = 'idle' | 'checking' | 'success' | 'error'

export interface VersionCheckUiState {
  status: VersionCheckStatus
  /** 进度行文案；idle 时为空。 */
  message: string
}

/** 开始版本检测：release = GitHub Releases，commit = 上游默认分支最新提交。 */
export function beginVersionCheck(source: 'release' | 'commit'): VersionCheckUiState {
  return {
    status: 'checking',
    message: source === 'commit' ? '正在检查上游最新提交…' : '正在检查最新发布版本…',
  }
}

/** 下载 / 安装等真实任务进行中（允许 indeterminate loading）。 */
export function beginInstall(message: string): VersionCheckUiState {
  return { status: 'checking', message }
}

/** 检测正常完成：动画停止，保留完成文案。 */
export function succeedVersionCheck(message: string): VersionCheckUiState {
  return { status: 'success', message }
}

/** 检测异常：动画停止，保留错误信息，可再次检测。 */
export function failVersionCheck(message: string): VersionCheckUiState {
  return { status: 'error', message }
}

/** 回到初始空闲态。 */
export function resetVersionCheck(): VersionCheckUiState {
  return { status: 'idle', message: '' }
}

/** 只有 checking 状态才允许 loading 动画。 */
export function shouldAnimate(status: VersionCheckStatus): boolean {
  return status === 'checking'
}
