/**
 * electron-builder afterPack hook: the portable zip build writes
 * `resources/portable.marker` so the app keeps runtime data (config,
 * credentials, plugins, versions) next to the exe instead of userData.
 * NSIS installs deliberately get no marker.
 */
import fs from 'node:fs'
import path from 'node:path'

export default async function afterPack(context) {
  const targets = (context.targets ?? []).map((t) => t.name)
  const marker = path.join(context.appOutDir, 'resources', 'portable.marker')
  if (targets.includes('zip')) {
    fs.writeFileSync(marker, 'portable build — keep runtime data next to the exe\n')
    console.log(`[after-pack] portable marker written (targets: ${targets.join(',')})`)
  } else {
    fs.rmSync(marker, { force: true })
    console.log(`[after-pack] installer build, no marker (targets: ${targets.join(',')})`)
  }
}
