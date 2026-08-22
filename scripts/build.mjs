/**
 * Build everything with esbuild:
 *  - main + preloads -> dist/*.js (CJS, node platform)
 *  - renderer entries -> dist/renderer/<page>/app.js (IIFE, browser)
 *  - copy html/css + assets -> dist/
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

const shared = {
  bundle: true,
  sourcemap: false,
  target: 'chrome130',
  logLevel: 'info',
}

await build({
  ...shared,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(dist, 'main.js'),
  entryPoints: [path.join(root, 'src/main/index.ts')],
  external: ['electron'],
  banner: { js: '// dsh-desktop main bundle' },
})

const preloads = [
  ['src/preload/loader.ts', 'preload-loader.js'],
  ['src/preload/floating.ts', 'preload-floating.js'],
  ['src/preload/control.ts', 'preload-control.js'],
]
for (const [entry, out] of preloads) {
  await build({
    ...shared,
    platform: 'node',
    format: 'cjs',
    target: 'chrome130',
    outfile: path.join(dist, out),
    entryPoints: [path.join(root, entry)],
    external: ['electron'],
  })
}

const pages = ['loader', 'floating', 'control']
for (const page of pages) {
  await build({
    ...shared,
    platform: 'browser',
    format: 'iife',
    outfile: path.join(dist, 'renderer', page, 'app.js'),
    entryPoints: [path.join(root, `src/renderer/${page}/app.ts`)],
  })
  // html + css verbatim
  const srcDir = path.join(root, 'src/renderer', page)
  const dstDir = path.join(dist, 'renderer', page)
  fs.mkdirSync(dstDir, { recursive: true })
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith('.html') || f.endsWith('.css')) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f))
  }
}

// assets (icon etc.) for renderer <img> and tray/window icons
fs.cpSync(path.join(root, 'assets'), path.join(dist, 'assets'), { recursive: true })

console.log('build: done ->', dist)
