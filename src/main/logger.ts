/**
 * Ring-buffer logger. Everything (app lifecycle, DSH stdout/stderr, install
 * progress) funnels through here; control-panel windows tail it over IPC and
 * it is mirrored to logs/main.log in the runtime dir.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { getPaths } from './paths'

export interface LogLine {
  ts: number
  source: 'app' | 'dsh' | 'install'
  level: 'info' | 'warn' | 'error'
  text: string
}

const MAX_LINES = 4000

const lines: LogLine[] = []
export const logEvents = new EventEmitter()
let fileStream: fs.WriteStream | null = null

export function initLogger(): void {
  const file = path.join(getPaths().logsDir, 'main.log')
  try {
    fileStream = fs.createWriteStream(file, { flags: 'a' })
  } catch {
    fileStream = null
  }
}

export function log(source: LogLine['source'], level: LogLine['level'], text: string): void {
  const entry: LogLine = { ts: Date.now(), source, level, text: text.replace(/\s+$/, '') }
  lines.push(entry)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  fileStream?.write(`[${new Date(entry.ts).toISOString()}] [${source}] [${level}] ${entry.text}\n`)
  logEvents.emit('line', entry)
}

export const appLog = {
  info: (t: string) => log('app', 'info', t),
  warn: (t: string) => log('app', 'warn', t),
  error: (t: string) => log('app', 'error', t),
}

export const dshLog = {
  info: (t: string) => log('dsh', 'info', t),
  warn: (t: string) => log('dsh', 'warn', t),
  error: (t: string) => log('dsh', 'error', t),
}

export const installLog = {
  info: (t: string) => log('install', 'info', t),
  warn: (t: string) => log('install', 'warn', t),
  error: (t: string) => log('install', 'error', t),
}

export function recentLogs(): LogLine[] {
  return [...lines]
}

export function clearLogs(): void {
  lines.length = 0
  logEvents.emit('cleared')
}
