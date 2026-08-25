/**
 * Regression tests for the version-check progress state machine
 * (src/renderer/control/version-check-state.ts).
 *
 * Verifies the UI contract that fixes the 'progress bar always slides'
 * bug: only the checking state may animate; success/error stop it and a
 * new check can restart from success/error (no stale state overwrite).
 * Pure TS is bundled to CJS with esbuild; no DOM required.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outfile = path.join(here, '.version-check-state.test.cjs')

await build({
  stdin: {
    contents: "export * from './src/renderer/control/version-check-state'",
    resolveDir: root,
    sourcefile: 'version-check-state-test-entry.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile,
  logLevel: 'silent',
})
const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
})

// ---- idle ---- //

test('idle: no animation and empty message', () => {
  const s = m.resetVersionCheck()
  assert.equal(s.status, 'idle')
  assert.equal(s.message, '')
  assert.equal(m.shouldAnimate(s.status), false)
})

// ---- checking ---- //

test('checking (release): animation allowed and phase message shown', () => {
  const s = m.beginVersionCheck('release')
  assert.equal(s.status, 'checking')
  assert.equal(s.message, '正在检查最新发布版本…')
  assert.equal(m.shouldAnimate(s.status), true)
})

test('checking (commit): upstream commit phase message shown', () => {
  const s = m.beginVersionCheck('commit')
  assert.equal(s.status, 'checking')
  assert.equal(s.message, '正在检查上游最新提交…')
  assert.equal(m.shouldAnimate(s.status), true)
})

test('beginInstall: real install task allows animation', () => {
  const s = m.beginInstall('正在下载安装…')
  assert.equal(s.status, 'checking')
  assert.equal(m.shouldAnimate(s.status), true)
})

// ---- success / error stop the animation ---- //

test('success: animation stops and final message is kept', () => {
  const s = m.succeedVersionCheck('检查完成：已是最新（当前 0.1.1-rc.2）')
  assert.equal(s.status, 'success')
  assert.equal(m.shouldAnimate(s.status), false)
  assert.match(s.message, /已是最新/)
})

test('error: animation stops and error info is kept', () => {
  const s = m.failVersionCheck('检查失败：GitHub API 403（限流）')
  assert.equal(s.status, 'error')
  assert.equal(m.shouldAnimate(s.status), false)
  assert.match(s.message, /403/)
})

// ---- re-check / no stale-state overwrite ---- //

test('re-check: success → checking → error keeps the latest request state', () => {
  const first = m.succeedVersionCheck('检查完成：已是最新')
  assert.equal(first.status, 'success')
  // user clicks check again
  const second = m.beginVersionCheck('commit')
  assert.equal(second.status, 'checking')
  assert.equal(m.shouldAnimate(second.status), true)
  // second request fails; final UI state must be the latest request's error
  const done = m.failVersionCheck('检查失败：网络超时')
  assert.equal(done.status, 'error')
  assert.equal(m.shouldAnimate(done.status), false)
  assert.match(done.message, /超时/)
})

test('idle→checking→error cycle can restart from error', () => {
  const failed = m.failVersionCheck('检查失败：离线')
  assert.equal(failed.status, 'error')
  const next = m.beginVersionCheck('release')
  assert.equal(next.status, 'checking')
  assert.equal(m.shouldAnimate(next.status), true)
  const ok = m.succeedVersionCheck('检查完成：发现新版本 0.2.0')
  assert.equal(ok.status, 'success')
  assert.equal(m.shouldAnimate(ok.status), false)
})
