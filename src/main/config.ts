/**
 * Persistent JSON settings. Written atomically; subscribers get notified so
 * windows/panels can refresh. Credentials intentionally live elsewhere
 * (credentials.json in the runtime dir) and never pass through this store.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { getPaths } from './paths'

export interface PluginRecord {
  id: string
  /** Absolute entry file of the plugin. */
  entry: string
  /** Install source directory/file under pluginsDir. */
  dir: string
  enabled: boolean
  /** 'preset' = 内置插件预设（清单自动安装，卸载即写入 suppressedPresets）。 */
  source: 'local' | 'git' | 'preset'
  gitUrl?: string
  installedAt: number
  /** Dependency install failure reason; undefined when deps are installed/absent. */
  depsError?: string
}

export interface AppConfig {
  port: number
  autoStart: boolean
  /** 'bundled' or an npm version string of a downloaded release. */
  activeVersion: string
  plugins: PluginRecord[]
  /** 用户卸载过的内置插件预设 id；启动时跳过这些预设的自动安装。 */
  suppressedPresets: string[]
  /** Floating ball offset from the main window's bottom-right corner (px). */
  ballOffset: { x: number; y: number } | null
  checkUpdatesOnStart: boolean
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 3080,
  autoStart: false,
  activeVersion: 'bundled',
  plugins: [],
  suppressedPresets: [],
  ballOffset: null,
  checkUpdatesOnStart: true,
}


export const configEvents = new EventEmitter()

// Lazy-initialized: paths depend on the userData override that index.ts sets
// at startup, which must not race module loading.
let state: AppConfig | null = null

function ensureState(): AppConfig {
  if (!state) state = load()
  return state
}

function load(): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(getPaths().configFile, 'utf8')) as Partial<AppConfig>
    // Field-by-field normalization: a hand-edited or foreign config.json must
    // never crash the app — invalid values fall back to defaults.
    const merged: AppConfig = { ...DEFAULT_CONFIG }
    if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536) {
      merged.port = raw.port
    }
    if (typeof raw.autoStart === 'boolean') merged.autoStart = raw.autoStart
    if (typeof raw.activeVersion === 'string' && raw.activeVersion) merged.activeVersion = raw.activeVersion
    if (Array.isArray(raw.plugins)) {
      merged.plugins = raw.plugins.filter(
        (p): p is PluginRecord =>
          !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.entry === 'string',
      )
    }
    if (Array.isArray(raw.suppressedPresets) && raw.suppressedPresets.every((s) => typeof s === 'string')) {
      merged.suppressedPresets = raw.suppressedPresets
    }
    if (raw.ballOffset && typeof raw.ballOffset === 'object' && typeof raw.ballOffset.x === 'number') {
      merged.ballOffset = raw.ballOffset
    }
    if (typeof raw.checkUpdatesOnStart === 'boolean') merged.checkUpdatesOnStart = raw.checkUpdatesOnStart
    return merged
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function getConfig(): AppConfig {
  return ensureState()
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...ensureState(), ...patch }
  state = next
  persist()
  configEvents.emit('changed', next)
  return next
}

export function mutateConfig(fn: (draft: AppConfig) => void): AppConfig {
  const draft: AppConfig = JSON.parse(JSON.stringify(ensureState()))
  fn(draft)
  state = draft
  persist()
  configEvents.emit('changed', draft)
  return draft
}

function persist(): void {
  const file = getPaths().configFile
  const tmp = path.join(path.dirname(file), `.config.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(ensureState(), null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** Read (or replace) the plaintext credentials file in the runtime dir. */
export interface Credentials {
  githubUser?: string
  githubToken?: string
}

export function readCredentials(): Credentials {
  try {
    return JSON.parse(fs.readFileSync(getPaths().credentialsFile, 'utf8')) as Credentials
  } catch {
    return {}
  }
}

export function writeCredentials(creds: Credentials): void {
  fs.writeFileSync(getPaths().credentialsFile, JSON.stringify(creds, null, 2), 'utf8')
}
