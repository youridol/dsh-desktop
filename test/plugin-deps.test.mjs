/**
 * Minimal unit tests for src/main/plugin-deps.ts (node:test, no framework).
 * The module is TS and imports `electron` (paths.ts), so it is compiled to CJS
 * with esbuild (`external: ['electron']`) and exercised in plain Node; none of
 * the tested paths touch Electron at runtime.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const outfile = path.join(here, '.plugin-deps.test.cjs')
await build({
  entryPoints: [path.join(here, '..', 'src', 'main', 'plugin-deps.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  outfile,
  logLevel: 'silent',
})
const { needsDepsInstall, installPluginDeps } = await import(pathToFileURL(outfile).href)
// The bundle stays loaded in this process; drop the artifact file.
fs.rmSync(outfile, { force: true })

function tmpDir(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deps-test-'))
  if (manifest != null) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
  return dir
}

test('missing package.json -> false', () => {
  const dir = tmpDir(null)
  assert.equal(needsDepsInstall(dir), false)
})

test('unparseable package.json -> false', () => {
  const dir = tmpDir(null)
  fs.writeFileSync(path.join(dir, 'package.json'), 'not json {{', 'utf8')
  assert.equal(needsDepsInstall(dir), false)
})

test('no dependencies field -> false', () => {
  const dir = tmpDir({ name: 'x', version: '1.0.0' })
  assert.equal(needsDepsInstall(dir), false)
})

test('empty dependencies -> false', () => {
  const dir = tmpDir({ name: 'x', dependencies: {} })
  assert.equal(needsDepsInstall(dir), false)
})

test('declared dep, node_modules missing -> true', () => {
  const dir = tmpDir({ name: 'x', dependencies: { 'left-pad': '1.0.0' } })
  assert.equal(needsDepsInstall(dir), true)
})

test('declared dep, resolvable -> false', () => {
  const dir = tmpDir({ name: 'x', dependencies: { 'left-pad': '^1.0.0' } })
  const mod = path.join(dir, 'node_modules', 'left-pad')
  fs.mkdirSync(mod, { recursive: true })
  fs.writeFileSync(
    path.join(mod, 'package.json'),
    JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }),
    'utf8',
  )
  fs.writeFileSync(path.join(mod, 'index.js'), 'module.exports = 1\n', 'utf8')
  assert.equal(needsDepsInstall(dir), false)
})

test('installPluginDeps skips when nothing to install (zero npm calls)', async () => {
  const dir = tmpDir({ name: 'x', dependencies: {} })
  const res = await installPluginDeps(dir)
  assert.equal(res.status, 'skipped')
})