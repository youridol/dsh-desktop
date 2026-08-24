/**
 * Minimal unit tests for src/main/builtin-plugins.ts (node:test, no framework).
 * The module tree imports `electron` (paths.ts), so it is compiled to CJS with
 * esbuild; `electron` is aliased to a temporary stub (isPackaged=false) so
 * getPaths() resolves the dev runtime dir (checkout/runtime) in plain Node.
 * All fixture data is written under that runtime dir and removed afterwards,
 * restoring the checkout's pre-test state.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outfile = path.join(here, '.builtin-plugins.test.cjs')
const stub = path.join(here, '.electron-stub.cjs')

fs.writeFileSync(
  stub,
  'module.exports = { app: { isPackaged: false, getPath: () => "" } }\n',
  'utf8',
)

await build({
  stdin: {
    contents: [
      `export { BUILTIN_PLUGINS, installedVersionOf, tarballUrl, presetNeedsInstall, isSuppressed } from './src/main/builtin-plugins'`,
      `export { getPaths } from './src/main/paths'`,
      `export { getConfig, mutateConfig } from './src/main/config'`,
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'builtin-plugins-test-entry.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  alias: { electron: stub },
  outfile,
  logLevel: 'silent',
})
const { BUILTIN_PLUGINS, installedVersionOf, tarballUrl, presetNeedsInstall, isSuppressed, getPaths, mutateConfig } =
  await import(pathToFileURL(outfile).href)

after(() => {
  // Restore the checkout: remove the test runtime dir (gitignored, did not
  // exist before) and the temporary bundle/stub artifacts.
  fs.rmSync(path.join(root, 'runtime'), { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
  fs.rmSync(stub, { force: true })
})

function presetDir(name) {
  return path.join(getPaths().pluginsDir, name)
}

/** Write a fake plugin dir (package.json + entry) under the runtime pluginsDir. */
function writePluginDir(name, version) {
  const dir = presetDir(name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: 'lib/index.js' }), 'utf8')
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'module.exports = {}\n', 'utf8')
  return dir
}

test('installedVersionOf: missing dir -> null', () => {
  assert.equal(installedVersionOf(path.join(getPaths().pluginsDir, 'does-not-exist')), null)
})

test('installedVersionOf: no package.json -> null', () => {
  const dir = presetDir('no-manifest')
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(installedVersionOf(dir), null)
})

test('installedVersionOf: unparseable package.json -> null', () => {
  const dir = presetDir('bad-manifest')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), 'not json {{', 'utf8')
  assert.equal(installedVersionOf(dir), null)
})

test('installedVersionOf: reads the declared version', () => {
  const dir = writePluginDir('dsh-llm-siliconflow', '0.2.0-rc.1')
  assert.equal(installedVersionOf(dir), '0.2.0-rc.1')
})

test('tarballUrl: scoped npm package encodes / and uses short name', () => {
  assert.equal(
    tarballUrl(BUILTIN_PLUGINS[0]),
    'https://registry.npmjs.org/@siliconflow-official%2Fdsh-llm-siliconflow/-/dsh-llm-siliconflow-0.2.0-rc.1.tgz',
  )
})

test('presetNeedsInstall: target dir absent -> true', () => {
  fs.rmSync(presetDir('dsh-llm-siliconflow'), { recursive: true, force: true })
  assert.equal(presetNeedsInstall(BUILTIN_PLUGINS[0]), true)
})

test('presetNeedsInstall: entry file missing -> true', () => {
  const dir = presetDir('dsh-llm-siliconflow')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'llm-siliconflow', version: '0.2.0-rc.1' }), 'utf8')
  assert.equal(presetNeedsInstall(BUILTIN_PLUGINS[0]), true)
})

test('presetNeedsInstall: version mismatch -> true', () => {
  writePluginDir('dsh-llm-siliconflow', '0.1.0')
  assert.equal(presetNeedsInstall(BUILTIN_PLUGINS[0]), true)
})

test('presetNeedsInstall: dir + entry + matching version -> false', () => {
  writePluginDir('dsh-llm-siliconflow', '0.2.0-rc.1')
  assert.equal(presetNeedsInstall(BUILTIN_PLUGINS[0]), false)
})

test('isSuppressed: not suppressed by default', () => {
  mutateConfig((draft) => {
    draft.suppressedPresets = []
  })
  assert.equal(isSuppressed(BUILTIN_PLUGINS[0]), false)
})

test('isSuppressed: true after preset id is recorded', () => {
  mutateConfig((draft) => {
    draft.suppressedPresets = ['llm-siliconflow']
  })
  assert.equal(isSuppressed(BUILTIN_PLUGINS[0]), true)
})