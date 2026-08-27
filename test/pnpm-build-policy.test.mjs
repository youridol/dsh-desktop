/**
 * Tests for src/main/services/dsh/pnpmBuildPolicy.ts — detection of pnpm
 * blocked-build failures and real authorization (allowBuilds in
 * pnpm-workspace.yaml + pnpm.onlyBuiltDependencies in the profile manifest).
 * The module logs via src/main/logger (which pulls in electron), so it is
 * bundled to CJS with esbuild and electron aliased to a dev stub, matching
 * the other main-process unit tests.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outfile = path.join(here, '.pnpm-build-policy.test.cjs')
const stub = path.join(here, '.pnpm-build-policy-electron-stub.cjs')

fs.writeFileSync(stub, 'module.exports = { app: { isPackaged: false, getPath: () => "" } }\n', 'utf8')

await build({
  stdin: {
    contents: [
      `export { hasBlockedBuildSignal, parseBlockedBuildInfo, authorizeBuildScripts } from './src/main/services/dsh/pnpmBuildPolicy'`,
      `export { resolveProfileDir, resolveDshHome } from './src/main/services/dsh/profilePaths'`,
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'pnpm-build-policy-test-entry.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  alias: { electron: stub },
  outfile,
  logLevel: 'silent',
})

const { hasBlockedBuildSignal, parseBlockedBuildInfo, authorizeBuildScripts, resolveProfileDir } =
  await import(pathToFileURL(outfile).href)

// ---- fixtures ----

const GIT_BLOCKED_OUTPUT = [
  '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/abidhmuhsin/dsh-visualizer/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662": The git-hosted package "dsh-visualizer@0.2.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
  '',
  'This error happened while installing a direct dependency of C:\\Users\\t\\.dsh\\profiles\\web',
  '',
  'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
  'allowBuilds:',
  '  dsh-visualizer@https://codeload.github.com/abidhmuhsin/dsh-visualizer/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662: true',
  '',
].join('\n')

const SCOPED_GIT_BLOCKED_OUTPUT = [
  '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/linxin666/dsh-chat-recovery/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662": The git-hosted package "@linxin666/dsh-chat-recovery@0.3.5" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
  '',
  'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
  'allowBuilds:',
  '  @linxin666/dsh-chat-recovery@https://codeload.github.com/linxin666/dsh-chat-recovery/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662: true',
  '',
].join('\n')

const IGNORED_BUILDS_OUTPUT = [
  'Progress: resolved 12, reused 12, downloaded 0, added 0',
  'Ignored build scripts: esbuild, cpu-features. Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
  'Done in 2.1s',
].join('\n')

const TASK_PHRASE_OUTPUT = [
  '@linxin666/dsh-chat-recovery',
  'build scripts are blocked by pnpm by default',
].join('\n')

const UNRELATED_OUTPUT = 'pnpm failed in profile directory C:\\Users\\t\\.dsh\\profiles\\web\nnpm error code 1'

// ---- helpers ----

let workDir
let savedHome

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pnpm-policy-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(workDir, '.dsh')
})

after(() => {
  if (savedHome !== undefined) process.env.DSH_HOME = savedHome
  else delete process.env.DSH_HOME
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
  fs.rmSync(stub, { force: true })
})

function profileDir(profile = 'web') {
  return resolveProfileDir(profile)
}

function writeWorkspace(dir, text) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), text, 'utf8')
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', 'utf8')
}

// ---- detection ----

test('hasBlockedBuildSignal recognizes pnpm git-dep and wording signals', () => {
  assert.equal(hasBlockedBuildSignal(GIT_BLOCKED_OUTPUT), true)
  assert.equal(hasBlockedBuildSignal(TASK_PHRASE_OUTPUT), true)
  assert.equal(hasBlockedBuildSignal(IGNORED_BUILDS_OUTPUT), true)
  assert.equal(hasBlockedBuildSignal('dsh: pnpm blocks until allowed'), true)
  assert.equal(hasBlockedBuildSignal(UNRELATED_OUTPUT), false)
  assert.equal(hasBlockedBuildSignal(''), false)
})

test('parseBlockedBuildInfo extracts the exact allowBuilds spec key from pnpm 11 git-dep errors', () => {
  const info = parseBlockedBuildInfo(GIT_BLOCKED_OUTPUT)
  // The commit-pinned codeload key pnpm prints, plus the stable git+https
  // key derived from the same codeload URL (pnpm >= 11.21 matches the
  // stable form; the pinned form covers pnpm < 11.21).
  assert.deepEqual(info.keys, [
    'dsh-visualizer@https://codeload.github.com/abidhmuhsin/dsh-visualizer/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662',
    'dsh-visualizer@git+https://github.com/abidhmuhsin/dsh-visualizer.git',
  ])
  // The package name from the "git-hosted package" line feeds onlyBuiltDependencies.
  assert.deepEqual(info.names, ['dsh-visualizer'])
})

test('parseBlockedBuildInfo handles scoped packages', () => {
  const info = parseBlockedBuildInfo(SCOPED_GIT_BLOCKED_OUTPUT)
  // Pinned codeload key + derived stable git+https key.
  assert.equal(info.keys.length, 2)
  assert.ok(info.keys[0].startsWith('@linxin666/dsh-chat-recovery@https://'))
  assert.ok(info.keys.includes('@linxin666/dsh-chat-recovery@git+https://github.com/linxin666/dsh-chat-recovery.git'))
  assert.deepEqual(info.names, ['@linxin666/dsh-chat-recovery'])
})

test('parseBlockedBuildInfo extracts plain names from Ignored build scripts', () => {
  const info = parseBlockedBuildInfo(IGNORED_BUILDS_OUTPUT)
  assert.deepEqual(info.keys, [])
  assert.deepEqual(info.names, ['esbuild', 'cpu-features'])
})

test('parseBlockedBuildInfo returns empty info for unrelated failures', () => {
  assert.deepEqual(parseBlockedBuildInfo(UNRELATED_OUTPUT), { keys: [], names: [] })
  assert.deepEqual(parseBlockedBuildInfo(''), { keys: [], names: [] })
})

// ---- authorization ----

test('authorizeBuildScripts creates pnpm-workspace.yaml with allowBuilds when missing', () => {
  const dir = profileDir()
  const info = parseBlockedBuildInfo(SCOPED_GIT_BLOCKED_OUTPUT)
  const res = authorizeBuildScripts('web', info)

  assert.equal(res.workspacePath, path.join(dir, 'pnpm-workspace.yaml'))
  // Both the pinned codeload key and the derived stable git+https key are
  // authorized (the bare name also lands in allowBuilds for pnpm 11).
  assert.equal(res.keys.length, 3)
  assert.equal(res.names.length, 1)

  const yamlText = fs.readFileSync(res.workspacePath, 'utf8')
  assert.ok(yamlText.includes('allowBuilds:'))
  // Keys with reserved YAML prefixes (e.g. @scope) may be quoted — parse
  // back and assert the effective map entry, which is what pnpm reads.
  const doc = yaml.load(yamlText)
  for (const key of info.keys) assert.equal(doc.allowBuilds[key], true, key)
  assert.equal(doc.allowBuilds['@linxin666/dsh-chat-recovery'], true)
  assert.equal(doc.allowBuilds['@linxin666/dsh-chat-recovery@git+https://github.com/linxin666/dsh-chat-recovery.git'], true)

  const manifest = JSON.parse(fs.readFileSync(res.manifestPath, 'utf8'))
  assert.deepEqual(manifest.pnpm.onlyBuiltDependencies, ['@linxin666/dsh-chat-recovery'])
})

test('authorizeBuildScripts merges into an existing workspace file and preserves other keys', () => {
  const dir = profileDir()
  writeWorkspace(dir, [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    'allowBuilds:',
    '  cloudflared: set this to true or false',
    'minimumReleaseAgeExclude:',
    '  - dshmarket@1.31.1',
    '',
  ].join('\n'))
  writeManifest(dir, { name: 'dsh-profile-web', private: true, dependencies: {} })

  const res = authorizeBuildScripts('web', parseBlockedBuildInfo(GIT_BLOCKED_OUTPUT))

  const yaml = fs.readFileSync(res.workspacePath, 'utf8')
  assert.ok(yaml.includes('cloudflared: set this to true or false'), 'existing entry preserved')
  assert.ok(yaml.includes('nodeLinker: hoisted'), 'existing settings preserved')
  assert.ok(yaml.includes('minimumReleaseAgeExclude:'), 'sibling section preserved')
  assert.ok(yaml.includes('dsh-visualizer@https://codeload.github.com/abidhmuhsin/dsh-visualizer/tar.gz/3582d6cf621d2946bdc8cfb36a06ef568f60d662: true'))
})

test('authorizeBuildScripts is idempotent', () => {
  const dir = profileDir()
  writeWorkspace(dir, 'packages:\n  - .\n')
  const info = { keys: ['pkg-a@https://example.com/a#1'], names: ['pkg-a'] }
  const first = authorizeBuildScripts('web', info)
  const second = authorizeBuildScripts('web', info)

  assert.deepEqual(second.keys, [])
  assert.deepEqual(second.names, [])
  const yaml = fs.readFileSync(first.workspacePath, 'utf8')
  const occurrences = yaml.split('pkg-a@https://example.com/a#1: true').length - 1
  assert.equal(occurrences, 1)
  const manifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'))
  assert.equal(manifest.pnpm.onlyBuiltDependencies.filter((n) => n === 'pkg-a').length, 1)
})

test('authorizeBuildScripts with no keys/names writes nothing new', () => {
  const res = authorizeBuildScripts('web', { keys: [], names: [] })
  assert.deepEqual(res.keys, [])
  assert.deepEqual(res.names, [])
})


// ---- version-suffixed ignored builds + stable git keys ---- //

const IGNORED_VERSIONED_OUTPUT = [
  'Progress: resolved 8, reused 7, downloaded 1, added 8, done',
  '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cloudflared@0.7.3, esbuild@0.25.0',
  '',
  'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
  'dsh: pnpm failed in profile directory C:\\Users\\t\\.dsh\\profiles\\web',
].join('\n')

test('parseBlockedBuildInfo strips version suffixes from ignored-build names', () => {
  const info = parseBlockedBuildInfo(IGNORED_VERSIONED_OUTPUT)
  assert.deepEqual(info.keys, [])
  assert.deepEqual(info.names, ['cloudflared', 'esbuild'])
})

test('parseBlockedBuildInfo derives the stable git+https allowBuilds key for git-dep failures', () => {
  const info = parseBlockedBuildInfo(GIT_BLOCKED_OUTPUT)
  assert.ok(
    info.keys.includes('dsh-visualizer@git+https://github.com/abidhmuhsin/dsh-visualizer.git'),
    'stable key must be derived from the codeload URL',
  )
  assert.ok(info.keys.includes(GIT_BLOCKED_OUTPUT.match(/  ([^\n]+): true/)[1]), 'pinned codeload key kept')
  assert.ok(info.names.includes('dsh-visualizer'))
})

test('authorizeBuildScripts writes bare names into allowBuilds (pnpm 11 path)', () => {
  const dir = profileDir()
  writeWorkspace(dir, 'packages:\n  - .\n')
  writeManifest(dir, { name: 'dsh-profile-web', private: true, dependencies: {} })

  const res = authorizeBuildScripts('web', { keys: [], names: ['cloudflared'] })

  const doc = yaml.load(fs.readFileSync(res.workspacePath, 'utf8'))
  assert.equal(doc.allowBuilds.cloudflared, true, 'bare name must be allowed in pnpm-workspace.yaml')
  const manifest = JSON.parse(fs.readFileSync(res.manifestPath, 'utf8'))
  assert.deepEqual(manifest.pnpm.onlyBuiltDependencies, ['cloudflared'])
})

test('authorizeBuildScripts git-dep keys include stable + pinned + bare forms', () => {
  const dir = profileDir()
  writeWorkspace(dir, 'packages:\n  - .\n')
  writeManifest(dir, { name: 'dsh-profile-web', private: true, dependencies: {} })

  const info = parseBlockedBuildInfo(SCOPED_GIT_BLOCKED_OUTPUT)
  const res = authorizeBuildScripts('web', info)

  const doc = yaml.load(fs.readFileSync(res.workspacePath, 'utf8'))
  assert.equal(doc.allowBuilds['@linxin666/dsh-chat-recovery@git+https://github.com/linxin666/dsh-chat-recovery.git'], true)
  assert.ok(Object.keys(doc.allowBuilds).some((k) => k.startsWith('@linxin666/dsh-chat-recovery@https://codeload.github.com/')))
  assert.equal(doc.allowBuilds['@linxin666/dsh-chat-recovery'], true)
})

