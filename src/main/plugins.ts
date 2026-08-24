/**
 * Plugin utilities — kept minimal after migrating plugin management to
 * dsh harness profiles (DshPluginService). Only the robust recursive
 * delete helper remains, used by version management and cleanup paths.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Recursive delete that survives Windows read-only files (git object files).
 * chmod each entry first, then remove; `attrib -R` as a belt-and-braces pass.
 */
export function rmRobust(target: string): void {
  if (!fs.existsSync(target)) return
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return
  } catch {
    /* fall through to read-only stripping */
  }
  const strip = (p: string) => {
    const stat = fs.lstatSync(p)
    if (stat.isFile() || stat.isSymbolicLink()) {
      try {
        fs.chmodSync(p, 0o666)
      } catch {
        /* best effort */
      }
    } else if (stat.isDirectory()) {
      for (const child of fs.readdirSync(p)) strip(path.join(p, child))
      try {
        fs.chmodSync(p, 0o666)
      } catch {
        /* best effort */
      }
    }
  }
  strip(target)
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}