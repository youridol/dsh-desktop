/**
 * Tests for DshPluginService — manifest reading/writing and plugin validation.
 * Uses esbuild to bundle the service for plain Node (externalizing electron).
 * Does NOT test actual dsh CLI execution (that requires a real dsh runtime).
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outfile = path.join(here, '.plugin-service.test.cjs')

// Bundle the service module (CJS, external electron)
await build({
  stdin: {
    contents: `
      export { listPlugins, enablePlugin, disablePlugin, exportPluginInfo, addPlugin, removePlugin, uninstallPlugin } from './src/main/services/dsh/DshPluginService'
      export { execDsh } from './src/main/services/dsh/DshCommandExecutor'
    `,
    resolveDir: root,
    sourcefile: 'plugin-service-test-entry.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  outfile,
  logLevel: 'silent',
})

const {
  listPlugins,
  enablePlugin,
  disablePlugin,
  exportPluginInfo,
} = await import(pathToFileURL(outfile).href)

// ---- test helpers ----

let savedHome
let tmpProfileDir

function setProfileHome(dir) {
  savedHome = process.env.DSH_HOME
  // Override DSH_HOME so the service reads from our temp dir
  process.env.DSH_HOME = path.join(dir, '.dsh')
  tmpProfileDir = path.join(process.env.DSH_HOME, 'profiles', 'web')
  fs.mkdirSync(tmpProfileDir, { recursive: true })
}

function restoreProfileHome() {
  if (savedHome !== undefined) process.env.DSH_HOME = savedHome
  else delete process.env.DSH_HOME
}

function writeManifest(manifest) {
  fs.writeFileSync(
    path.join(tmpProfileDir, 'package.json'),
    JSON.stringify(manifest, undefined, 2) + '\n',
    'utf8',
  )
}

function writePackageMeta(packageName, meta) {
  const dir = path.join(tmpProfileDir, 'node_modules', ...packageName.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(meta, undefined, 2) + '\n',
    'utf8',
  )
}

let workDir

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-test-'))
  setProfileHome(workDir)
})

after(() => {
  restoreProfileHome()
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
})

// ---- tests ----

test('listPlugins: empty profile returns empty array', () => {
  writeManifest({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  })
  const result = listPlugins()
  assert.equal(result.plugins.length, 0)
  assert.ok(result.profileDir.endsWith(path.join('.dsh', 'profiles', 'web')))
})

test('listPlugins: installed plugin with bundle flag shows as enabled', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: { '@scope/test-plugin': '^1.0.0' },
    dsh: { profile: { bundles: ['@scope/test-plugin'] } },
  })
  writePackageMeta('@scope/test-plugin', {
    name: '@scope/test-plugin',
    version: '1.2.3',
    description: 'A test plugin',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  const result = listPlugins()
  assert.equal(result.plugins.length, 1)
  const p = result.plugins[0]
  assert.equal(p.id, '@scope/test-plugin')
  assert.equal(p.packageName, '@scope/test-plugin')
  assert.equal(p.version, '1.2.3')
  assert.equal(p.enabled, true)
  assert.equal(p.isBundle, true)
  assert.equal(p.description, 'A test plugin')
})

test('listPlugins: dependency without bundle shows isBundle=false', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: { 'plain-lib': '^2.0.0' },
    dsh: { profile: { bundles: [] } },
  })
  writePackageMeta('plain-lib', {
    name: 'plain-lib',
    version: '2.0.0',
    description: 'Just a library',
  })
  const result = listPlugins()
  assert.equal(result.plugins.length, 1)
  const p = result.plugins[0]
  assert.equal(p.isBundle, false)
  assert.equal(p.enabled, false)
})

test('listPlugins: sorting — bundles before non-bundles', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: { 'z-lib': '^1.0.0', 'a-plugin': '^1.0.0' },
    dsh: { profile: { bundles: ['a-plugin'] } },
  })
  writePackageMeta('a-plugin', {
    name: 'a-plugin',
    version: '1.0.0',
    dsh: { bundle: {} },
  })
  writePackageMeta('z-lib', {
    name: 'z-lib',
    version: '1.0.0',
  })
  const result = listPlugins()
  assert.equal(result.plugins.length, 2)
  // a-plugin (bundle) should come before z-lib
  assert.equal(result.plugins[0].id, 'a-plugin')
  assert.equal(result.plugins[1].id, 'z-lib')
})

test('enablePlugin: adds to bundles', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: { 'my-plugin': '^1.0.0' },
    dsh: { profile: { bundles: [] } },
  })
  enablePlugin('my-plugin')
  const raw = JSON.parse(
    fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'),
  )
  assert.deepStrictEqual(raw.dsh.profile.bundles, ['my-plugin'])
})

test('enablePlugin: no-op when already enabled', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['existing'] } },
  })
  enablePlugin('existing')
  const raw = JSON.parse(
    fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'),
  )
  assert.deepStrictEqual(raw.dsh.profile.bundles, ['existing'])
})

test('disablePlugin: removes from bundles', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['a', 'b', 'c'] } },
  })
  disablePlugin('b')
  const raw = JSON.parse(
    fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'),
  )
  assert.deepStrictEqual(raw.dsh.profile.bundles, ['a', 'c'])
})

test('disablePlugin: no-op when not in bundles', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: {},
    dsh: { profile: { bundles: ['a'] } },
  })
  disablePlugin('nonexistent')
  const raw = JSON.parse(
    fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'),
  )
  assert.deepStrictEqual(raw.dsh.profile.bundles, ['a'])
})

test('disablePlugin: no-op when no bundles field', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: {},
  })
  disablePlugin('anything')
  // Should not throw
  assert.ok(true)
})

test('exportPluginInfo: returns package info', () => {
  writeManifest({
    name: 'dsh-profile-web',
    dependencies: { 'export-me': '^3.0.0' },
  })
  writePackageMeta('export-me', {
    name: 'export-me',
    version: '3.0.0',
    description: 'Exported plugin',
  })
  const info = exportPluginInfo('export-me')
  assert.ok(info)
  assert.equal(info.packageName, 'export-me')
  assert.equal(info.version, '3.0.0')
  assert.equal(info.description, 'Exported plugin')
})

test('exportPluginInfo: returns null for missing plugin', () => {
  const info = exportPluginInfo('does-not-exist')
  assert.equal(info, null)
})

test('listPlugins: missing profile file returns empty', () => {
  // No manifest written — service should handle gracefully
  const result = listPlugins()
  assert.equal(result.plugins.length, 0)
})