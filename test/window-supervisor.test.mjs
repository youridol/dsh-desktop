/**
 * Regression tests for the window supervisor's pure decision logic
 * (src/main/windows/supervisor.ts).
 *
 * The supervisor keeps the floating ball and the control panel self-healing:
 *  - evaluateWindowHealth decides whether a window must be rebuilt
 *    (reference lost / renderer crashed);
 *  - isRecoveryRateLimited prevents hot rebuild loops after a recovery.
 * Pure TS is bundled to CJS with esbuild (electron externalized like the
 * other main-process tests); no BrowserWindow is constructed here.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outfile = path.join(here, '.window-supervisor.test.cjs')

await build({
  stdin: {
    contents: `
      export {
        evaluateWindowHealth,
        isRecoveryRateLimited,
        MIN_RECOVERY_INTERVAL_MS,
      } from './src/main/windows/supervisor'
    `,
    resolveDir: root,
    sourcefile: 'window-supervisor-test-entry.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  outfile,
  logLevel: 'silent',
})
const m = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
})

// ---- evaluateWindowHealth ---- //

test('evaluateWindowHealth: healthy window needs no action', () => {
  assert.equal(m.evaluateWindowHealth({ exists: true, crashed: false }), 'none')
})

test('evaluateWindowHealth: missing window reference is rebuilt', () => {
  assert.equal(m.evaluateWindowHealth({ exists: false, crashed: false }), 'rebuild')
})

test('evaluateWindowHealth: crashed renderer is rebuilt', () => {
  assert.equal(m.evaluateWindowHealth({ exists: true, crashed: true }), 'rebuild')
})

test('evaluateWindowHealth: missing + crashed still maps to rebuild (single path)', () => {
  assert.equal(m.evaluateWindowHealth({ exists: false, crashed: true }), 'rebuild')
})

// ---- isRecoveryRateLimited ---- //

test('isRecoveryRateLimited: first action (never recovered) is not limited', () => {
  assert.equal(m.isRecoveryRateLimited(-1), false)
})

test('isRecoveryRateLimited: recent recovery is throttled', () => {
  assert.equal(m.isRecoveryRateLimited(0), true)
  assert.equal(m.isRecoveryRateLimited(m.MIN_RECOVERY_INTERVAL_MS - 1), true)
})

test('isRecoveryRateLimited: recovery older than the window is allowed again', () => {
  assert.equal(m.isRecoveryRateLimited(m.MIN_RECOVERY_INTERVAL_MS), false)
  assert.equal(m.isRecoveryRateLimited(m.MIN_RECOVERY_INTERVAL_MS + 1000), false)
})

test('isRecoveryRateLimited: custom interval is honored', () => {
  assert.equal(m.isRecoveryRateLimited(2000, 5000), true)
  assert.equal(m.isRecoveryRateLimited(5000, 5000), false)
  assert.equal(m.isRecoveryRateLimited(6000, 5000), false)
})
