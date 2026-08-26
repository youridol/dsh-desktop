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
      export { listPlugins, enablePlugin, disablePlugin, exportPluginInfo, addPlugin, removePlugin, uninstallPlugin, installPlugin, validatePluginName } from './src/main/services/dsh/DshPluginService'
      export { runInstall, validateProfile, DEFAULT_PROFILE, isBuildBlockedError } from './src/main/services/dsh/DshPluginInstaller'
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
  installPlugin,
  runInstall,
  validateProfile,
  validatePluginName,
  isBuildBlockedError,
  DEFAULT_PROFILE,
  execDsh,
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

// ---- install source model & install channel ---- //

/** Fake executor capturing the forwarded dsh args. On success it also
 * records the plugin into the (temp) profile manifest so listPlugins picks it
 * up, mirroring what a real pnpm add into node_modules + manifest would do. */
function fakeExecutor() {
  const calls = []
  const executor = async (args, options) => {
    calls.push({ args, options })
    // args: ['plugin','--profile',profile,'add',name]
    const name = args[args.length - 1]
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'))
    if (!manifest.dependencies) manifest.dependencies = {}
    manifest.dependencies[name] = '^1.0.0'
    fs.writeFileSync(path.join(tmpProfileDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', 'utf8')
    fs.mkdirSync(path.join(tmpProfileDir, 'node_modules', name), { recursive: true })
    fs.writeFileSync(
      path.join(tmpProfileDir, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dsh: { bundle: {} } }, undefined, 2) + '\n',
      'utf8',
    )
    return { ok: true, exitCode: 0, stdout: 'installed', stderr: '', timedOut: false }
  }
  executor.calls = calls
  return executor
}

test('installer strategy: source=npm forwards dsh plugin --profile web add <name>', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  const exec = fakeExecutor()
  const [p] = await installPlugin({ name: 'dshmarket', source: 'npm' }, exec)
  assert.equal(exec.calls.length, 1)
  assert.deepEqual(exec.calls[0].args, ['plugin', '--profile', 'web', 'add', 'dshmarket'])
  assert.equal(p.packageName, 'dshmarket')
  assert.equal(p.source, 'npm')
  assert.equal(p.profile, 'web')
})

test('installer strategy: source=npx uses the npx channel label', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  const exec = fakeExecutor()
  const [p] = await installPlugin({ name: 'dshmarket', source: 'npx' }, exec)
  assert.equal(exec.calls.length, 1)
  assert.deepEqual(exec.calls[0].args, ['plugin', '--profile', 'web', 'add', 'dshmarket'])
  assert.equal(p.source, 'npx')
})

test('installer strategy: source=dsh-profile requires a profile and builds the profile command', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  const exec = fakeExecutor()
  const [p] = await installPlugin({ name: 'dshmarket', source: 'dsh-profile', profile: 'web' }, exec)
  assert.equal(exec.calls.length, 1)
  // dsh plugin --profile web add dshmarket — the requested native channel
  assert.deepEqual(exec.calls[0].args, ['plugin', '--profile', 'web', 'add', 'dshmarket'])
  assert.equal(p.source, 'dsh-profile')
  assert.equal(p.profile, 'web')
})

test('installer: unknown source is rejected explicitly', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  await assert.rejects(
    () => installPlugin({ name: 'x', source: 'git' }, fakeExecutor()),
    (err) => err.code === 'INVALID_REQUEST' && /未知安装来源/.test(err.message),
  )
})

// ---- validation ---- //

test('validation: dsh-profile without profile fails before any exec', async () => {
  const exec = fakeExecutor()
  await assert.rejects(
    () => installPlugin({ name: 'dshmarket', source: 'dsh-profile' }, exec),
    (err) => err.code === 'INVALID_REQUEST' && /Profile/.test(err.message),
  )
  assert.equal(exec.calls.length, 0)
})

test('validation: empty plugin name fails', async () => {
  await assert.rejects(
    () => runInstall({ name: '  ', source: 'npm' }, validatePluginName, fakeExecutor()),
    (err) => err.code === 'INVALID_REQUEST' && /插件名称不能为空/.test(err.message),
  )
})

test('validation: profile names with shell metacharacters are rejected', () => {
  assert.equal(validateProfile('web'), null)
  assert.equal(validateProfile(''), 'Profile 不能为空')
  assert.equal(validateProfile('web;rm'), 'Profile 名称非法（仅允许字母、数字、连字符、下划线）')
  assert.equal(validateProfile('../etc'), 'Profile 名称非法（仅允许字母、数字、连字符、下划线）')
})

// ---- execution failures ---- //

test('exec: dsh CLI unavailable returns a clear user-facing error', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  const exec = async () => ({
    ok: false, exitCode: null, stdout: '', stderr: '',
    timedOut: false, error: 'dsh runtime not found',
  })
  await assert.rejects(
    () => installPlugin({ name: 'dshmarket', source: 'dsh-profile', profile: 'web' }, exec),
    (err) =>
      err.code === 'EXEC_FAILED' &&
      /未检测到可用的 dsh CLI/.test(err.message) &&
      /DeepSeek Harness/.test(err.message),
  )
})

test('exec: non-zero exit reports failure and writes no success record', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  const exec = async () => ({
    ok: false, exitCode: 1, stdout: '', stderr: 'pnpm failed',
    timedOut: false, error: 'exit 1',
  })
  await assert.rejects(() => installPlugin({ name: 'dshmarket', source: 'npm' }, exec))
  const raw = JSON.parse(fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'))
  // No metadata record written for a failed install
  assert.equal(raw.dsh?.desktop?.plugins?.['dshmarket'], undefined)
})

// ---- success record persistence ---- //

test('successful install persists source+profile+installedAt metadata', async () => {
  writeManifest({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { dshmarket: '^1.0.0' },
    dsh: { profile: { bundles: ['dshmarket'] } },
  })
  writePackageMeta('dshmarket', { name: 'dshmarket', version: '1.0.0', dsh: { bundle: {} } })
  const exec = fakeExecutor()
  const [p] = await installPlugin({ name: 'dshmarket', source: 'dsh-profile', profile: 'web' }, exec)

  const raw = JSON.parse(fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'))
  const rec = raw.dsh?.desktop?.plugins?.['dshmarket']
  assert.ok(rec, 'install record must be written')
  assert.equal(rec.source, 'dsh-profile')
  assert.equal(rec.profile, 'web')
  assert.ok(Number.isInteger(rec.installedAt))
  assert.equal(p.source, 'dsh-profile')
  assert.equal(p.profile, 'web')
})

// ---- legacy data compatibility ---- //

test('legacy records without source/profile keep working and fall back', () => {
  // Old data: manifest has dependencies but no dsh.desktop metadata
  writeManifest({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'old-plugin': '^0.1.0' },
    dsh: { profile: { bundles: ['old-plugin'] } },
  })
  writePackageMeta('old-plugin', { name: 'old-plugin', version: '0.1.0', dsh: { bundle: {} } })

  const result = listPlugins()
  assert.equal(result.plugins.length, 1)
  const p = result.plugins[0]
  // Fallbacks: no crash, source defaults to the dsh profile channel, profile web
  assert.equal(p.id, 'old-plugin')
  assert.equal(p.source, 'dsh-profile')
  assert.equal(p.profile, DEFAULT_PROFILE)
  assert.equal(p.installedAt, null)
})

// ---- pnpm blocked build scripts (allow-builds retry) ---- //

const GIT_BLOCKED_OUTPUT = [
  '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/abidhmuhsin/dsh-visualizer/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662": The git-hosted package "dsh-visualizer@0.2.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
  '',
  'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
  'allowBuilds:',
  '  dsh-visualizer@https://codeload.github.com/abidhmuhsin/dsh-visualizer/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662: true',
  '',
].join('\n')


/** Executor that fails once with blocked-build output, then installs. */
function blockedThenOkExecutor(blockedOutput, resolvedName) {
  const calls = []
  const executor = async (args) => {
    calls.push({ args })
    if (calls.length === 1) {
      return { ok: false, exitCode: 1, stdout: blockedOutput, stderr: '', timedOut: false }
    }
    const dep = resolvedName ?? args[args.length - 1]
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'))
    if (!manifest.dependencies) manifest.dependencies = {}
    manifest.dependencies[dep] = '^1.0.0'
    fs.writeFileSync(path.join(tmpProfileDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', 'utf8')
    fs.mkdirSync(path.join(tmpProfileDir, 'node_modules', dep), { recursive: true })
    fs.writeFileSync(
      path.join(tmpProfileDir, 'node_modules', dep, 'package.json'),
      JSON.stringify({ name: dep, version: '1.0.0', dsh: { bundle: {} } }, undefined, 2) + '\n',
      'utf8',
    )
    return { ok: true, exitCode: 0, stdout: 'installed', stderr: '', timedOut: false }
  }
  executor.calls = calls
  return executor
}

test('validation: git/GitHub install specs are accepted', () => {
  for (const spec of [
    'github:abidhmuhsin/dsh-visualizer',
    'github:linxin666/dsh-chat-recovery',
    'https://github.com/abidhmuhsin/dsh-visualizer',
    'git+https://github.com/abidhmuhsin/dsh-visualizer.git',
    'git@github.com:abidhmuhsin/dsh-visualizer.git',
    'abidhmuhsin/dsh-visualizer',
  ]) {
    assert.equal(validatePluginName(spec), null, spec)
  }
  // Shell metacharacters and whitespace are still rejected in git specs.
  assert.ok(validatePluginName('github:a/b;rm -rf'))
  assert.ok(validatePluginName('https://github.com/a b'))
})

test('installer: pnpm blocked build scripts throw BUILD_BLOCKED with parsed keys', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  const exec = async () => ({
    ok: false, exitCode: 1, stdout: GIT_BLOCKED_OUTPUT, stderr: '', timedOut: false,
  })
  await assert.rejects(
    () => installPlugin({ name: 'github:abidhmuhsin/dsh-visualizer', source: 'npm' }, exec),
    (err) =>
      isBuildBlockedError(err) &&
      err.keys.length === 1 &&
      err.keys[0].startsWith('dsh-visualizer@https://') &&
      /放行构建脚本/.test(err.message),
  )
})

test('installer: allowBuilds retry authorizes pnpm policy, re-runs and persists', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  const exec = blockedThenOkExecutor(GIT_BLOCKED_OUTPUT, 'dsh-visualizer')
  const plugins = await installPlugin(
    { name: 'github:abidhmuhsin/dsh-visualizer', source: 'npm' },
    exec,
    { allowBuilds: true },
  )
  // Two attempts: original + retry after authorization.
  assert.equal(exec.calls.length, 2)
  assert.equal(plugins.length, 1)
  assert.equal(plugins[0].packageName, 'dsh-visualizer')
  // The real authorization must have happened: pnpm-workspace.yaml now
  // carries the allowBuilds spec and the manifest the plain name.
  const workspace = fs.readFileSync(path.join(tmpProfileDir, 'pnpm-workspace.yaml'), 'utf8')
  assert.ok(workspace.includes('allowBuilds:'))
  assert.ok(workspace.includes('dsh-visualizer@https://codeload.github.com/abidhmuhsin/dsh-visualizer/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662'))
  const manifest = JSON.parse(fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.pnpm.onlyBuiltDependencies.includes('dsh-visualizer'))
  // Install metadata persisted keyed by the requested spec.
  assert.ok(manifest.dsh.desktop.plugins['github:abidhmuhsin/dsh-visualizer'])
})

test('installer: allowBuilds retry that stays blocked surfaces BUILD_BLOCKED again', async () => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: {} })
  const exec = async () => ({
    ok: false, exitCode: 1, stdout: GIT_BLOCKED_OUTPUT, stderr: '', timedOut: false,
  })
  exec.calls = []
  await assert.rejects(
    () => installPlugin({ name: 'github:abidhmuhsin/dsh-visualizer', source: 'npm' }, exec, { allowBuilds: true }),
    (err) => isBuildBlockedError(err) && err.keys.length === 1,
  )
})
