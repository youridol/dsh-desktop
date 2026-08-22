/** Loader page logic: spinner while starting, error + retry on failure. */
export {}

interface LoaderBridge {
  onStatus: (cb: (status: { state: string; detail?: string; serviceUrl?: string }) => void) => () => void
  retry: () => Promise<unknown>
}

declare global {
  interface Window {
    dshLoader?: LoaderBridge
  }
}

const el = {
  app: document.getElementById('app')!,
  spinner: document.getElementById('spinner')!,
  statusText: document.getElementById('statusText')!,
  elapsed: document.getElementById('elapsed')!,
  error: document.getElementById('error')!,
  errorTitle: document.getElementById('errorTitle')!,
  errorDetail: document.getElementById('errorDetail')!,
  retry: document.getElementById('retry') as HTMLButtonElement,
}

const startedAt = Date.now()
const timer = setInterval(() => {
  const s = (Date.now() - startedAt) / 1000
  el.elapsed.textContent = `${s.toFixed(1)} s`
}, 100)

function showLoading(text: string): void {
  el.app.classList.remove('error')
  el.spinner.classList.remove('hidden')
  el.error.classList.add('hidden')
  el.statusText.textContent = text
}

function showError(title: string, detail: string): void {
  clearInterval(timer)
  el.app.classList.add('error')
  el.spinner.classList.add('hidden')
  el.error.classList.remove('hidden')
  el.errorTitle.textContent = title
  el.errorDetail.textContent = detail
}

const stateText: Record<string, string> = {
  stopped: '服务已停止',
  starting: '正在启动 DSH 服务…',
  running: '服务已就绪，正在打开…',
  stopping: '正在停止服务…',
}

function render(status: { state: string; detail?: string }): void {
  switch (status.state) {
    case 'running':
    case 'starting':
      showLoading(stateText[status.state])
      break
    case 'timeout':
      showError('启动超时', status.detail || '10 秒内服务端口未就绪。')
      break
    case 'crashed':
      showError('DSH 进程异常退出', status.detail || '请查看日志定位原因。')
      break
    case 'error':
      showError('启动失败', status.detail || '未知错误')
      break
    case 'stopped':
    case 'stopping':
      showError('服务已停止', '点击重试重新启动。')
      break
    default:
      showLoading('正在启动 DSH 服务…')
  }
}

el.retry.addEventListener('click', () => {
  el.retry.disabled = true
  showLoading('正在重新启动…')
  const spin = setInterval(() => {}, 1000)
  window.dshLoader
    ?.retry()
    .finally(() => {
      clearInterval(spin)
      el.retry.disabled = false
    })
})

const off = window.dshLoader?.onStatus(render)
window.addEventListener('beforeunload', () => off?.())
