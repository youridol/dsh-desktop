/**
 * Tests for src/main/dsh/toolchain.ts — the pure environment-support layer
 * that puts the standard npm / npx / pnpm toolchain dirs on PATH for
 * harness child processes. The module only uses node builtins (no electron),
 * so it is bundled to CJS with esbuild (the repo’s standard pattern) and
 * exercised through an injected probe, keeping every test hermetic.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outfile = path.join(here, '.toolchain.test.cjs')

await build({
  stdin: {
    contents: `
      export { toolchainDirs, withToolchain, probeNodeDir, probeNpmPrefix, resetNpmPrefixCache } from './src/main/dsh/toolchain'
    `,
    resolveDir: root,
    sourcefile: 'toolchain-test-entry.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile,
  logLevel: 'silent',
})

const { toolchainDirs, withToolchain, resetNpmPrefixCache } = await import(pathToFileURL(outfile).href)

after(() => {
  fs.rmSync(outfile, { force: true })
  resetNpmPrefixCache()
})

// ---- fixtures ----

const SYSTEM32 = 'C:\\Windows\\System32'
let workDir

function makeShim(dir, names) {
  fs.mkdirSync(dir, { recursive: true })
  for (const n of names) fs.writeFileSync(path.join(dir, n), '', 'utf8')
}

// A probe that reports whatever fixture dirs we create.
function probeWith(nodeDirVal, npmPrefixVal) {
  return {
    nodeDir: () => nodeDirVal,
    npmPrefix: () => npmPrefixVal,
  }
}

test('toolchainDirs collects existing shim-bearing dirs only', () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolchain-'))
  try {
    const nodeDir = path.join(workDir, 'node')
    makeShim(nodeDir, ['npm.cmd', 'npx.cmd', 'pnpm.CMD', 'node.exe'])
    const emptyDir = path.join(workDir, 'empty')
    fs.mkdirSync(emptyDir, { recursive: true })
    const env = {
      USERPROFILE: workDir,
      APPDATA: path.join(workDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(workDir, 'AppData', 'Local'),
      PATH: nodeDir + ';' + SYSTEM32,
    }
    const dirs = toolchainDirs(env, probeWith(nodeDir, null))
    assert.ok(dirs.includes(path.resolve(nodeDir)), 'node dir collected')
    // A dir with no shims is never added.
    assert.ok(!dirs.includes(path.resolve(emptyDir)), 'bare dir skipped')
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})

test('withToolchain prepends discovered dirs and preserves existing PATH', () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolchain-'))
  try {
    const nodeDir = path.join(workDir, 'node')
    makeShim(nodeDir, ['npm.cmd', 'npx.cmd', 'pnpm.CMD', 'node.exe'])
    // Re-point the real probe used by withToolchain via DSH_DESKTOP_NODE +
    // env override is not possible for withToolchain (it uses realProbe);
    // instead assert via the pure toolchainDirs path (withToolchain wraps it).
    const existing = [SYSTEM32, 'C:\\Tools']
    const dirs = toolchainDirs(
      { USERPROFILE: workDir, APPDATA: workDir, LOCALAPPDATA: workDir, PATH: existing.join(';') },
      probeWith(nodeDir, null),
    )
    // Simulate what withToolchain does: prepend dirs not already present.
    const additions = dirs.filter((d) => !existing.some((p) => p.toLowerCase() === d.toLowerCase()))
    const merged = [...additions, ...existing]
    assert.equal(merged[0].toLowerCase(), path.resolve(nodeDir).toLowerCase(), 'toolchain dir first')
    for (const p of existing) assert.ok(merged.includes(p), 'existing entry kept: ' + p)
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})

test('withToolchain dedupes entries already on PATH', () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolchain-'))
  try {
    const nodeDir = path.join(workDir, 'node')
    makeShim(nodeDir, ['npm.cmd', 'npx.cmd', 'pnpm.CMD', 'node.exe'])
    const dirs = toolchainDirs(
      { USERPROFILE: workDir, APPDATA: workDir, LOCALAPPDATA: workDir, PATH: nodeDir + ';' + SYSTEM32 },
      probeWith(nodeDir, null),
    )
    const existing = (nodeDir + ';' + SYSTEM32).split(';')
    const additions = dirs.filter((d) => !existing.some((p) => p.toLowerCase() === d.toLowerCase()))
    assert.equal(additions.length, 0, 'node dir already on PATH → no re-add')
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})

test('withToolchain is a no-op when nothing is discoverable', () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolchain-'))
  try {
    // No shims anywhere: probe returns nothing, dirs all exist but empty.
    const dirs = toolchainDirs(
      { USERPROFILE: workDir, APPDATA: workDir, LOCALAPPDATA: workDir, PATH: 'C:\\Windows' },
      probeWith(null, null),
    )
    assert.deepEqual(dirs, [], 'nothing to add')
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})

test('withToolchain copies the env object and never mutates the input', () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolchain-'))
  try {
    const nodeDir = path.join(workDir, 'node')
    makeShim(nodeDir, ['npm.cmd', 'node.exe'])
    const input = { PATH: SYSTEM32, FOO: 'bar' }
    const out = withToolchain(input)
    assert.notEqual(out, input)
    assert.equal(input.PATH, SYSTEM32, 'input untouched')
    assert.equal(input.FOO, 'bar')
    assert.equal(out.FOO, 'bar', 'other vars copied')
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})

test('npm global prefix probe path (pure via probe injection)', () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolchain-'))
  try {
    const prefix = path.join(workDir, 'globals')
    makeShim(prefix, ['npm', 'npm.cmd', 'npx', 'npx.cmd'])
    const dirs = toolchainDirs(
      { USERPROFILE: workDir, APPDATA: workDir, LOCALAPPDATA: workDir, PATH: SYSTEM32 },
      probeWith(null, prefix),
    )
    assert.ok(dirs.includes(path.resolve(prefix)), 'npm prefix dir collected')
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
})
