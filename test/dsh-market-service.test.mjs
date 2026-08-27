/**
 * Tests for DshMarketService — the dsh-market quick-config entry layer.
 *
 * Uses esbuild to bundle the service for plain Node (externalizing electron
 * and the DSH manager/windows modules). Does NOT test real dsh CLI execution
 * or the DSH web server; install orchestration is exercised with a fake
 * executor (mirroring plugin-service.test.mjs) and HTTP probing with a fake
 * fetch.
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
const outfile = path.join(here, '.dsh-market-service.test.cjs')

// Bundle the service module (CJS, external electron + the window/manager
// modules that need an Electron runtime — those are only used by openMarket,
// which the tests do not exercise).
await build({
  stdin: {
    contents: `
      export {
        MARKET_PACKAGE,
        MARKET_PROFILE,
        marketStatus,
        ensureMarketInstalled,
        probeMarketHttp,
        setMarketHostForTest,
      } from './src/main/services/dsh/DshMarketService'
      export { listPlugins } from './src/main/services/dsh/DshPluginService'
      export { DEFAULT_PROFILE } from './src/main/services/dsh/DshPluginInstaller'
    `,
    resolveDir: root,
    sourcefile: 'dsh-market-service-test-entry.ts',
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
  MARKET_PACKAGE,
  MARKET_PROFILE,
  marketStatus,
  ensureMarketInstalled,
  probeMarketHttp,
  setMarketHostForTest,
} = await import(pathToFileURL(outfile).href)

// ---- test helpers ----

let savedHome
let tmpProfileDir

function setProfileHome(dir) {
  savedHome = process.env.DSH_HOME
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
    JSON.stringify(manifest, undefined, 2),
    'utf8',
  )
}

function writePackageMeta(packageName, meta) {
  const dir = path.join(tmpProfileDir, 'node_modules', ...packageName.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(meta, undefined, 2),
    'utf8',
  )
}

function emptyManifest() {
  return { name: 'dsh-profile-web', private: true, dependencies: {} }
}

/** Fake dsh executor: on 'add' records the dep into the temp profile so
 * listPlugins picks it up, mirroring a real pnpm add. */
function fakeExecutor() {
  const calls = []
  const executor = async (args) => {
    calls.push({ args })
    const name = args[args.length - 1]
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'))
    if (!manifest.dependencies) manifest.dependencies = {}
    manifest.dependencies[name] = '^1.0.0'
    fs.writeFileSync(path.join(tmpProfileDir, 'package.json'), JSON.stringify(manifest, undefined, 2), 'utf8')
    fs.mkdirSync(path.join(tmpProfileDir, 'node_modules', name), { recursive: true })
    fs.writeFileSync(
      path.join(tmpProfileDir, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dsh: { bundle: {} } }, undefined, 2),
      'utf8',
    )
    return { ok: true, exitCode: 0, stdout: 'installed', stderr: '', timedOut: false }
  }
  executor.calls = calls
  return executor
}

let workDir

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-market-test-'))
  setProfileHome(workDir)
  // 注入替身宿主：marketStatus/openMarket 不触碰真实 manager / 主窗口
  setMarketHostForTest({
    getStatus: () => ({ state: 'stopped', serviceUrl: 'http://127.0.0.1:3080' }),
    restart: async () => {},
    reveal: async () => {},
    execute: async () => false,
  })
})

after(() => {
  restoreProfileHome()
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
})

// ---- tests ----

test('ensureMarketInstalled: installs dshmarket via the npm channel when missing', async () => {
  writeManifest(emptyManifest())
  const exec = fakeExecutor()
  const result = await ensureMarketInstalled(exec)

  assert.equal(result.installed, true)
  assert.equal(result.enabled, true)
  // Reused the existing npm install channel (dsh plugin --profile web add dshmarket)
  assert.equal(exec.calls.length, 1)
  assert.deepEqual(exec.calls[0].args, ['plugin', '--profile', 'web', 'add', MARKET_PACKAGE])

  const manifest = JSON.parse(fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies[MARKET_PACKAGE])
  // Enabled (added to bundles) so the market section loads after restart
  assert.ok(manifest.dsh.profile.bundles.includes(MARKET_PACKAGE))
})

test('ensureMarketInstalled: installs into the web profile (MARKET_PROFILE)', async () => {
  writeManifest(emptyManifest())
  const exec = fakeExecutor()
  await ensureMarketInstalled(exec)
  assert.equal(MARKET_PROFILE, 'web')
  assert.deepEqual(exec.calls[0].args.slice(0, 4), ['plugin', '--profile', 'web', 'add'])
})

test('ensureMarketInstalled: idempotent when already installed and enabled', async () => {
  writeManifest({
    ...emptyManifest(),
    dependencies: { [MARKET_PACKAGE]: '^1.0.0' },
    dsh: { profile: { bundles: [MARKET_PACKAGE] } },
  })
  writePackageMeta(MARKET_PACKAGE, { name: MARKET_PACKAGE, version: '1.2.3', dsh: { bundle: {} } })
  const exec = fakeExecutor()

  const result = await ensureMarketInstalled(exec)
  assert.equal(result.installed, true)
  assert.equal(result.enabled, true)
  // No install attempt when already present
  assert.equal(exec.calls.length, 0)
})

test('ensureMarketInstalled: enables an installed-but-disabled market', async () => {
  writeManifest({
    ...emptyManifest(),
    dependencies: { [MARKET_PACKAGE]: '^1.0.0' },
    dsh: { profile: { bundles: [] } },
  })
  writePackageMeta(MARKET_PACKAGE, { name: MARKET_PACKAGE, version: '1.0.0', dsh: { bundle: {} } })
  const exec = fakeExecutor()

  const result = await ensureMarketInstalled(exec)
  assert.equal(result.installed, true)
  assert.equal(result.enabled, true)
  assert.equal(exec.calls.length, 0) // no install, only enable
  const manifest = JSON.parse(fs.readFileSync(path.join(tmpProfileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes(MARKET_PACKAGE))
})

test('marketStatus: reports installed/enabled/version from the profile', async () => {
  writeManifest({
    ...emptyManifest(),
    dependencies: { [MARKET_PACKAGE]: '^1.0.0' },
    dsh: { profile: { bundles: [MARKET_PACKAGE] } },
  })
  writePackageMeta(MARKET_PACKAGE, { name: MARKET_PACKAGE, version: '1.2.3', dsh: { bundle: {} } })

  // DSH not running in this environment: active must be false, dshRunning false
  const status = await marketStatus()
  assert.equal(status.installed, true)
  assert.equal(status.enabled, true)
  assert.equal(status.version, '1.2.3')
  assert.equal(status.active, false)
  assert.equal(status.available, false)
})

test('marketStatus: reports not installed', async () => {
  writeManifest(emptyManifest())
  const status = await marketStatus()
  assert.equal(status.installed, false)
  assert.equal(status.enabled, false)
  assert.equal(status.version, null)
  assert.equal(status.active, false)
  assert.equal(status.available, false)
})

test('probeMarketHttp: 404 means not mounted', async () => {
  // Stub global fetch
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 404 })
  try {
    const probe = await probeMarketHttp('http://127.0.0.1:3080')
    assert.equal(probe.active, false)
    assert.equal(probe.version, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('probeMarketHttp: 200 with version means mounted', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ version: '1.31.2', active: false }), { status: 200 })
  try {
    const probe = await probeMarketHttp('http://127.0.0.1:3080')
    assert.equal(probe.active, true)
    assert.equal(probe.version, '1.31.2')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('probeMarketHttp: network failure is treated as not mounted', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  try {
    const probe = await probeMarketHttp('http://127.0.0.1:3080')
    assert.equal(probe.active, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('marketStatus: legacy manifest without bundles field keeps working', async () => {
  writeManifest({
    ...emptyManifest(),
    dependencies: { [MARKET_PACKAGE]: '^1.0.0' },
  })
  writePackageMeta(MARKET_PACKAGE, { name: MARKET_PACKAGE, version: '1.0.0', dsh: { bundle: {} } })
  const status = await marketStatus()
  assert.equal(status.installed, true)
  assert.equal(status.enabled, false)
})
