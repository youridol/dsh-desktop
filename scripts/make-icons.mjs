/**
 * Generate assets/icon.ico (multi-size, PNG-embedded entries) from
 * assets/icon.png using Electron's nativeImage, run headlessly via
 * ELECTRON_RUN_AS_NODE-free `electron <script>`? Electron needs a main; we use
 * the ELECTRON_RUN_AS_NODE trick instead — but nativeImage is unavailable in
 * pure node mode, so this script is *executed by electron itself*:
 *   electron scripts/_icon-main.cjs
 * (wired from package.json's make-icons wrapper below).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const helper = `
const { nativeImage, app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
app.whenReady().then(() => {
  const root = process.argv[2]
  const src = path.join(root, 'assets', 'icon.png')
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = sizes.map((s) => nativeImage.createFromPath(src).resize({ width: s, height: s }).toPNG())
  // Assemble an ICO with PNG-compressed entries (valid on Vista+).
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)      // reserved
  header.writeUInt16LE(1, 2)      // type: icon
  header.writeUInt16LE(sizes.length, 4)
  const entries = []
  let offset = 6 + 16 * sizes.length
  for (let i = 0; i < sizes.length; i++) {
    const e = Buffer.alloc(16)
    const s = sizes[i]
    e.writeUInt8(s >= 256 ? 0 : s, 0)
    e.writeUInt8(s >= 256 ? 0 : s, 1)
    e.writeUInt8(0, 2)             // colors
    e.writeUInt8(0, 3)             // reserved
    e.writeUInt16LE(1, 4)          // planes
    e.writeUInt16LE(32, 6)         // bpp
    e.writeUInt32LE(pngs[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += pngs[i].length
    entries.push(e)
  }
  const ico = Buffer.concat([header, ...entries, ...pngs])
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), ico)
  console.log('icon.ico written:', ico.length, 'bytes')
  app.exit(0)
})
`

const helperPath = path.join(root, 'scripts', '_icon-helper.cjs')
fs.writeFileSync(helperPath, helper)

const electron = path.join(root, 'node_modules', 'electron', 'cli.js')
const res = spawnSync(process.execPath, [electron, helperPath, root], { stdio: 'inherit' })
fs.rmSync(helperPath, { force: true })
if (res.status !== 0) {
  console.error('icon generation failed')
  process.exit(res.status ?? 1)
}
