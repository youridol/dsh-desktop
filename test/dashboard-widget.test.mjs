/**
 * Regression tests for the dashboard widget registry
 * (src/renderer/control/tabs/dashboard/widget.ts).
 *
 * Pure TS is bundled to CJS with esbuild; no DOM required. The registry is
 * module-level, so tests share one module instance and use unique ids.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outfile = path.join(here, '.dashboard-widget.test.cjs')

await build({
  stdin: {
    contents: "export * from './src/renderer/control/tabs/dashboard/widget'",
    resolveDir: root,
    sourcefile: 'dashboard-widget-test-entry.ts',
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

function mkWidget(id, extra = {}) {
  return { id, title: id, render() {}, ...extra }
}

// ---- registry basics ---- //

test('dashboardWidgets: returns registered widgets in registration order', () => {
  const a = mkWidget('dash-test-a')
  const b = mkWidget('dash-test-b', { refreshIntervalMs: 5000 })
  m.registerDashboardWidget(a)
  m.registerDashboardWidget(b)
  const ids = m.dashboardWidgets().map((w) => w.id)
  assert.ok(ids.includes('dash-test-a'))
  assert.ok(ids.includes('dash-test-b'))
  assert.ok(ids.indexOf('dash-test-a') < ids.indexOf('dash-test-b'))
})

test('registerDashboardWidget: duplicate id is rejected explicitly', () => {
  assert.throws(() => m.registerDashboardWidget(mkWidget('dash-test-a')), /重复/)
})

test('dashboardWidgets: returned array is a snapshot (mutating it is safe)', () => {
  const before = m.dashboardWidgets().length
  const snapshot = m.dashboardWidgets()
  snapshot.length = 0
  assert.equal(m.dashboardWidgets().length, before)
})

test('dashboardWidgets: optional refresh handler is preserved', () => {
  const w = mkWidget('dash-test-c', { refresh() {} })
  m.registerDashboardWidget(w)
  const found = m.dashboardWidgets().find((x) => x.id === 'dash-test-c')
  assert.ok(found)
  assert.equal(typeof found.refresh, 'function')
})
