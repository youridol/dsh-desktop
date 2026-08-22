/**
 * Pack the bundled DSH runtime (.dsh-runtime) into build-assets/dsh-runtime.tgz.
 * A single tarball travels through electron-builder's extraResources without
 * touching any node_modules filtering; the app extracts it on first launch.
 * Uses the system tar (Git-for-Windows / bsdtar both fine).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, '.dsh-runtime')
const outDir = path.join(root, 'build-assets')
const out = path.join(outDir, 'dsh-runtime.tgz')

if (!fs.existsSync(path.join(src, 'node_modules', '@deepseek-ai', 'dsh'))) {
  console.error('[pack-runtime] .dsh-runtime missing — run `npm run fetch-dsh` first')
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
fs.rmSync(out, { force: true })

console.log('[pack-runtime] creating dsh-runtime.tgz (this can take a minute)')
// Pack the stage contents (node_modules + tools + manifest); the output path
// is absolute because tar resolves it against its own cwd. --force-local
// stops GNU tar from reading "Y:" as a remote host specifier.
execSync(`tar --force-local -czf "${out}" node_modules tools dsh-manifest.json`, {
  stdio: 'inherit',
  cwd: src,
})

const size = fs.statSync(out).size
console.log(`[pack-runtime] wrote ${out} (${(size / 1e6).toFixed(1)} MB)`)
