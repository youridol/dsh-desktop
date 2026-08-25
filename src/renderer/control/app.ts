/** Control panel shell: tabs, toast, wiring of the five modules. */
import { initDashboard } from './tabs/dashboard'
import { initPlugins } from './tabs/plugins'
import { initVersions } from './tabs/versions'
import { initStatus } from './tabs/status'
import { initSettings } from './tabs/settings'

const toastEl = document.getElementById('toast')!

let toastTimer: number | null = null
export function toast(msg: string, err = false): void {
  toastEl.textContent = msg
  toastEl.classList.toggle('err', err)
  toastEl.classList.remove('hidden')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), err ? 6000 : 3000)
}

document.getElementById('closeBtn')!.addEventListener('click', () => {
  window.dshc?.closePanel()
})

const panes: Record<string, HTMLElement> = {
  dashboard: document.getElementById('pane-dashboard')!,
  plugins: document.getElementById('pane-plugins')!,
  versions: document.getElementById('pane-versions')!,
  status: document.getElementById('pane-status')!,
  settings: document.getElementById('pane-settings')!,
}

const initialized = new Set<string>()
const initializers: Record<string, () => void> = {
  dashboard: () => initDashboard(panes.dashboard, toast),
  plugins: () => initPlugins(panes.plugins, toast),
  versions: () => initVersions(panes.versions, toast),
  status: () => initStatus(panes.status),
  settings: () => initSettings(panes.settings, toast),
}

function activate(name: string): void {
  for (const [key, pane] of Object.entries(panes)) {
    pane.classList.toggle('active', key === name)
  }
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', (t as HTMLElement).dataset.tab === name)
  })
  if (!initialized.has(name)) {
    initialized.add(name)
    initializers[name]()
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => activate((btn as HTMLElement).dataset.tab!))
})

activate('dashboard')
