/**
 * Fetch the bundled DSH runtime into .dsh-runtime/ (a plain npm install of
 * @deepseek-ai/dsh) plus the vendored npm CLI (used at runtime to install new
 * versions). Both live OUTSIDE package.json dependencies on purpose: the
 * packaged app ships this tree as a single tarball that is extracted on first
 * launch, because electron-builder's static dependency collector drops
 * peer-loaded packages that dsh needs at runtime.
 *
 * Usage: node scripts/fetch-dsh.mjs [--version 0.1.1-rc.2] [--latest]
 * Default: newest GitHub Release tag (dsh-vX.Y.Z maps 1:1 to the npm version).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://registry.npmjs.org'

const args = process.argv.slice(2)
function argValue(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

async function latestDshVersion() {
  // GitHub release tags `dsh-vX.Y.Z(-rc.N)` map 1:1 to npm versions.
  const res = await fetch('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=10', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop-build' },
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const releases = await res.json()
  const tag = releases[0]?.tag_name
  if (!tag) throw new Error('no releases found')
  return tag.replace(/^dsh-v/, '')
}

function npmInstall(pkg, prefix) {
  fs.rmSync(prefix, { recursive: true, force: true })
  fs.mkdirSync(prefix, { recursive: true })
  // An explicit package.json pins npm to this directory.
  fs.writeFileSync(
    path.join(prefix, 'package.json'),
    JSON.stringify({ name: path.basename(prefix), private: true, version: '0.0.0' }, null, 2),
  )
  console.log(`[fetch-dsh] npm install ${pkg} -> ${prefix}`)
  execSync(`npm install ${pkg} --omit=dev --no-audit --no-fund --loglevel=error --registry=${REGISTRY}`, {
    stdio: 'inherit',
    cwd: prefix,
  })
}

const version =
  argValue('--version') ?? (args.includes('--latest') ? await latestDshVersion() : await latestDshVersion())

console.log(`[fetch-dsh] bundling DSH version ${version}`)

const runtimeDir = path.join(root, '.dsh-runtime')
const manifest = path.join(runtimeDir, 'dsh-manifest.json')
let current = null
try {
  current = JSON.parse(fs.readFileSync(manifest, 'utf8'))
} catch {
  /* not fetched yet */
}
if (current?.version === version && fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh'))) {
  console.log(`[fetch-dsh] runtime already at ${version}, skipping`)
} else {
  npmInstall(`@deepseek-ai/dsh@${version}`, runtimeDir)
  fs.writeFileSync(manifest, JSON.stringify({ version, fetchedAt: new Date().toISOString() }, null, 2))
}

// vendored npm CLI for runtime version installs
const toolsDir = path.join(root, '.dsh-runtime', 'tools')
if (!fs.existsSync(path.join(toolsDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) {
  console.log('[fetch-dsh] vendoring npm CLI')
  npmInstall('npm', toolsDir)
} else {
  console.log('[fetch-dsh] vendored npm present, skipping')
}

console.log('[fetch-dsh] done')
