/**
 * Minimal unit tests for the bundled-runtime self-healing in
 * src/main/dsh/install.ts (node:test, no framework). The module tree imports
 * `electron` (paths.ts), so it is compiled to CJS with esbuild and `electron`
 * is aliased to a dev-mode stub (isPackaged=false), which makes getPaths()
 * resolve the checkout runtime dir and runtimeTgzPath() the local
 * build-assets/dsh-runtime.tgz. Every fixture is written under that runtime
 * dir and removed afterwards.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outfile = path.join(here, '.install-runtime.test.cjs')
const stub = path.join(here, '.electron-stub.cjs')

fs.writeFileSync(
  stub,
  'module.exports = { app: { isPackaged: false, getPath: () => "" } }\n',
  'utf8',
)

await build({
  stdin: {
    contents: [
      `export { ensureBundledRuntime, bundledRuntimeComplete } from './src/main/dsh/install'`,
      `export { bundledExtractDir, bundledDshDir, runtimeTgzPath, getPaths } from './src/main/paths'`,
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'install-runtime-test-entry.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  alias: { electron: stub },
  outfile,
  logLevel: 'silent',
})
const { ensureBundledRuntime, bundledRuntimeComplete, bundledExtractDir, bundledDshDir, runtimeTgzPath, getPaths } =
  await import(pathToFileURL(outfile).href)

after(() => {
  // Restore the checkout: remove the test runtime dir (gitignored, did not
  // exist before) and the temporary bundle/stub artifacts.
  fs.rmSync(path.join(root, 'runtime'), { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
  fs.rmSync(stub, { force: true })
})

function bundledDir() {
  return bundledExtractDir()
}

test('bundledRuntimeComplete is false on an empty dir', () => {
  const dir = bundledDir()
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(bundledRuntimeComplete(dir), false)
})

test('bundledRuntimeComplete is false when only the dsh package exists', () => {
  // This is the stale-marker scenario: the old completeness check looked only
  // for @deepseek-ai/dsh, so a tree missing dsh-app-boot/js-yaml passed.
  const dir = bundledDir()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
  fs.writeFileSync(path.join(dir, '.extract-complete'), new Date().toISOString(), 'utf8')
  assert.equal(bundledRuntimeComplete(dir), false)
})

test('ensureBundledRuntime serves the complete dev .dsh-runtime without extracting', () => {
  // Dev mode: the bundled runtime is the checkout's .dsh-runtime. When it is
  // complete the function must return true and must NOT create/extract into
  // runtime/versions/_bundled (that dir only exists in packaged installs).
  const devDir = bundledDshDir()
  if (!bundledRuntimeComplete(devDir)) return // checkout without fetch-dsh
  const tgz = runtimeTgzPath()
  assert.ok(tgz, 'dev .dsh-runtime complete implies tgz cache exists')
  // Remove any residue from earlier runs so we prove the dev branch does not
  // re-create the packaged extract dir.
  const extractDir = bundledExtractDir()
  fs.rmSync(extractDir, { recursive: true, force: true })
  const ok = ensureBundledRuntime()
  assert.equal(ok, true)
  assert.equal(bundledRuntimeComplete(devDir), true)
  assert.equal(fs.existsSync(path.join(extractDir, 'node_modules')), false)
})

test('ensureBundledRuntime serves dev .dsh-runtime even when the tgz cache is gone', () => {
  // Dev mode does not depend on the tarball: a complete checkout .dsh-runtime
  // is served directly. Hiding the tgz must not break dev startup.
  const devDir = bundledDshDir()
  if (!bundledRuntimeComplete(devDir)) return
  const tgz = runtimeTgzPath()
  if (!tgz) return
  const moved = tgz + '.test-hidden'
  fs.renameSync(tgz, moved)
  try {
    const ok = ensureBundledRuntime()
    assert.equal(ok, true)
  } finally {
    fs.renameSync(moved, tgz)
  }
})