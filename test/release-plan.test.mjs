/**
 * Unit tests for the release-plan module (scripts/release-plan.mjs).
 *
 * Guards the GitHub Actions release decision contract:
 *   - dsh-desktop version progression (e.g. 0.0.0 -> 0.0.1) must be detected and
 *     produce a NEW composite tag (independent of upstream changes);
 *   - upstream deepseek-harness tag progression must be detected independently;
 *   - APP_VERSION and UPSTREAM must never be confused (dual-version scheme);
 *   - idempotency: an already-existing target tag must not be republished;
 *   - official / candidate (dev) / branch / workflow_call modes are preserved.
 */
import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  normalizeUpstreamTag,
  sanitizeBranch,
  isPrerelease,
  resolveMode,
  buildPlan,
} from '../scripts/release-plan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const CLI = path.join(root, 'scripts', 'release-plan.mjs')

const SHA = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const SHA7 = 'b150a55'

// ---- normalizeUpstreamTag ---- //

test('normalizeUpstreamTag: dsh-v prefix stripped', () => {
  assert.equal(normalizeUpstreamTag('dsh-v0.1.1-rc.2'), '0.1.1-rc.2')
  assert.equal(normalizeUpstreamTag('dsh-v1.2.3'), '1.2.3')
})

test('normalizeUpstreamTag: non-dsh-v tags preserved', () => {
  assert.equal(normalizeUpstreamTag('v1.2.3'), 'v1.2.3')
  assert.equal(normalizeUpstreamTag('0.1.1-rc.2'), '0.1.1-rc.2')
})

test('normalizeUpstreamTag: empty input stays empty', () => {
  assert.equal(normalizeUpstreamTag(''), '')
  assert.equal(normalizeUpstreamTag(undefined), '')
})

// ---- sanitizeBranch ---- //

test('sanitizeBranch: slashes and illegal chars become dashes', () => {
  assert.equal(sanitizeBranch('fix/version-progress-bar-and-floating-icon'), 'fix-version-progress-bar-and-floating-icon')
  assert.equal(sanitizeBranch('feat/UI v2'), 'feat-UI-v2')
})

test('sanitizeBranch: trims edge dashes/dots and caps at 60 chars', () => {
  assert.equal(sanitizeBranch('.hidden/'), 'hidden')
  const long = 'a'.repeat(80)
  assert.equal(sanitizeBranch(long).length, 60)
})

test('sanitizeBranch: empty falls back to main in buildPlan', () => {
  assert.equal(sanitizeBranch(''), '')
  const plan = buildPlan({ appVersion: '0.0.1', bundled: '0.1.1-rc.2', branch: '' })
  assert.equal(plan.branch, '')
  assert.equal(plan.tag, 'v0.0.1-0.1.1-rc.2-main')
})

// ---- isPrerelease ---- //

test('isPrerelease: rc/alpha/beta/pre suffixes', () => {
  assert.equal(isPrerelease('0.1.1-rc.2'), true)
  assert.equal(isPrerelease('1.2.3-alpha.1'), true)
  assert.equal(isPrerelease('1.2.3-beta'), true)
  assert.equal(isPrerelease('1.2.3-pre'), true)
})

test('isPrerelease: plain versions and shas are not prerelease by heuristic', () => {
  assert.equal(isPrerelease('1.2.3'), false)
  assert.equal(isPrerelease(SHA7), false)
  assert.equal(isPrerelease(''), false)
})

// ---- resolveMode ---- //

test('resolveMode: explicit mode wins', () => {
  assert.equal(resolveMode({ releaseMode: 'version', hasTagVersion: true, hasTagSha: true }), 'version')
  assert.equal(resolveMode({ releaseMode: 'dev', hasTagVersion: true, hasTagSha: true }), 'dev')
})

test('resolveMode: auto with allowDev picks version/dev/none by tag presence', () => {
  assert.equal(resolveMode({ releaseMode: 'auto', hasTagVersion: false, hasTagSha: false, allowDev: true }), 'version')
  assert.equal(resolveMode({ releaseMode: 'auto', hasTagVersion: true, hasTagSha: false, allowDev: true }), 'dev')
  assert.equal(resolveMode({ releaseMode: 'auto', hasTagVersion: true, hasTagSha: true, allowDev: true }), 'none')
  assert.equal(resolveMode({ releaseMode: 'auto', hasTagVersion: true, hasTagSha: true, allowDev: true, force: true }), 'version')
})

test('resolveMode: empty releaseMode equals auto (schedule bug regression)', () => {
  // schedule events pass an EMPTY release_mode; it must behave as auto, not as an override.
  assert.equal(resolveMode({ releaseMode: '', hasTagVersion: false, hasTagSha: false, allowDev: true }), 'version')
  assert.equal(resolveMode({ releaseMode: '', hasTagVersion: true, hasTagSha: false, allowDev: true }), 'dev')
  assert.equal(resolveMode({ releaseMode: '', hasTagVersion: true, hasTagSha: true, allowDev: true }), 'none')
})

test('resolveMode: build/push channel (no allowDev) always resolves version', () => {
  assert.equal(resolveMode({ releaseMode: 'auto', hasTagVersion: true, hasTagSha: true, allowDev: false }), 'version')
  assert.equal(resolveMode({ releaseMode: '', hasTagVersion: true, hasTagSha: true, allowDev: false }), 'version')
})

// ---- buildPlan: desktop progression (0.0.0 -> 0.0.1) ---- //

test('desktop 0.0.0 -> 0.0.1 with unchanged upstream releases a NEW tag', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    bundled: '0.1.1-rc.2',
    branch: 'main',
    existingTags: ['v0.0.0-0.1.1-rc.2'],
    releaseMode: 'auto',
    allowDev: true,
  })
  assert.equal(plan.mode, 'version')
  assert.equal(plan.changed, true)
  assert.equal(plan.app_version, '0.0.1')
  assert.equal(plan.upstream, '0.1.1-rc.2')
  assert.equal(plan.upstream_type, 'tag')
  assert.equal(plan.version, '0.0.1-0.1.1-rc.2')
  assert.equal(plan.tag, 'v0.0.1-0.1.1-rc.2')
  assert.equal(plan.skip, false)
})

test('desktop progression is detected on the push/build channel too', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    bundled: '0.1.1-rc.2',
    branch: 'main',
    existingTags: ['v0.0.0-0.1.1-rc.2'],
    releaseMode: '', // push channel passes no release_mode
  })
  assert.equal(plan.mode, 'version')
  assert.equal(plan.tag, 'v0.0.1-0.1.1-rc.2')
  assert.equal(plan.skip, false)
})

// ---- buildPlan: upstream progression ---- //

test('upstream tag progression 0.1.1-rc.2 -> 0.1.2 releases independently', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    upstreamVersion: '0.1.2',
    bundled: '0.1.2',
    upstreamSha: SHA,
    branch: 'main',
    existingTags: ['v0.0.1-0.1.1-rc.2', 'v0.0.1-b150a55'],
    releaseMode: 'auto',
    allowDev: true,
  })
  assert.equal(plan.mode, 'version')
  assert.equal(plan.version, '0.0.1-0.1.2')
  assert.equal(plan.tag, 'v0.0.1-0.1.2')
  assert.equal(plan.changed, true)
  assert.equal(plan.skip, false)
  assert.equal(plan.prerelease, false)
})

test('upstream prerelease tag progression releases a prerelease', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    upstreamVersion: '0.2.0-rc.1',
    bundled: '0.2.0-rc.1',
    branch: 'main',
    existingTags: ['v0.0.1-0.1.1-rc.2'],
    releaseMode: 'auto',
    allowDev: true,
  })
  assert.equal(plan.mode, 'version')
  assert.equal(plan.tag, 'v0.0.1-0.2.0-rc.1')
  assert.equal(plan.prerelease, true)
})

// ---- buildPlan: idempotency ---- //

test('already-published composite tag is idempotently skipped (no republish)', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    bundled: '0.1.1-rc.2',
    branch: 'main',
    existingTags: ['v0.0.1-0.1.1-rc.2'],
    releaseMode: '',
  })
  assert.equal(plan.mode, 'version')
  assert.equal(plan.skip, true)
  assert.equal(plan.changed, true) // build channel: job runs, publish is skipped
})

test('force overrides idempotent skip', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    bundled: '0.1.1-rc.2',
    branch: 'main',
    existingTags: ['v0.0.1-0.1.1-rc.2'],
    force: true,
  })
  assert.equal(plan.skip, false)
})

// ---- buildPlan: dev candidate ---- //

test('dev candidate: upstream has new commits but tag version already released', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    upstreamVersion: '0.1.1-rc.2',
    bundled: '0.1.1-rc.2',
    upstreamSha: SHA,
    branch: 'main',
    existingTags: ['v0.0.1-0.1.1-rc.2'],
    releaseMode: 'auto',
    allowDev: true,
  })
  assert.equal(plan.mode, 'dev')
  assert.equal(plan.changed, true)
  assert.equal(plan.upstream, SHA7)
  assert.equal(plan.upstream_type, 'sha')
  assert.equal(plan.version, `0.0.1-${SHA7}`)
  assert.equal(plan.tag, `v0.0.1-${SHA7}`)
  assert.equal(plan.prerelease, true)
})

test('no change: watch channel idempotently exits', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    upstreamVersion: '0.1.1-rc.2',
    bundled: '0.1.1-rc.2',
    upstreamSha: SHA,
    branch: 'main',
    existingTags: [`v0.0.1-0.1.1-rc.2`, `v0.0.1-${SHA7}`],
    releaseMode: 'auto',
    allowDev: true,
  })
  assert.equal(plan.mode, 'none')
  assert.equal(plan.changed, false)
})

// ---- buildPlan: branch releases ---- //

test('non-main branch appends sanitized branch suffix to the tag', () => {
  const plan = buildPlan({
    appVersion: '0.0.1',
    bundled: '0.1.1-rc.2',
    branch: 'fix/version-progress-bar-and-floating-icon',
    existingTags: [],
  })
  assert.equal(plan.tag, 'v0.0.1-0.1.1-rc.2-fix-version-progress-bar-and-floating-icon')
})

// ---- buildPlan: version confusion guard ---- //

test('requested upstream must match bundled version in version mode', () => {
  assert.throws(
    () =>
      buildPlan({
        appVersion: '0.0.1',
        upstreamVersion: '0.1.2',
        bundled: '0.1.1-rc.2',
        branch: 'main',
      }),
    /requested upstream '0\.1\.2' != bundled '0\.1\.1-rc\.2'/,
  )
})

test('dev mode requires a 7-hex upstream sha', () => {
  assert.throws(() => buildPlan({ appVersion: '0.0.1', releaseMode: 'dev', upstreamSha: '', branch: 'main' }), /dev mode requires upstream sha/)
  assert.throws(() => buildPlan({ appVersion: '0.0.1', releaseMode: 'dev', upstreamSha: 'xyz', branch: 'main' }), /dev mode requires upstream sha/)
})

test('app_version is required', () => {
  assert.throws(() => buildPlan({ appVersion: '', bundled: '0.1.1-rc.2' }), /app_version is required/)
})

// ---- CLI integration ---- //

function cli(...args) {
  const out = execFileSync(process.execPath, [CLI, '--json', ...args], { encoding: 'utf8' })
  return JSON.parse(out)
}

test('CLI: real-world poll scenario (0.8.0 released, desktop 0.8.1 pending)', () => {
  const plan = cli(
    '--app-version', '0.8.1',
    '--upstream-version', '0.1.1-rc.2',
    '--upstream-sha', SHA,
    '--branch', 'main',
    '--release-mode', '',
    '--force', 'false',
    '--allow-dev', 'true',
    '--existing-tags', 'v0.8.0-0.1.1-rc.2,v0.8.0-b150a55',
  )
  assert.equal(plan.mode, 'version')
  assert.equal(plan.changed, true)
  assert.equal(plan.tag, 'v0.8.1-0.1.1-rc.2')
  assert.equal(plan.skip, false)
})

test('CLI: build channel with explicit poll version input', () => {
  const plan = cli(
    '--app-version', '0.8.1',
    '--bundled', '0.1.2',
    '--upstream-version', '0.1.2',
    '--branch', 'main',
    '--release-mode', 'version',
    '--allow-dev', 'false',
    '--existing-tags', 'v0.8.1-0.1.1-rc.2',
  )
  assert.equal(plan.mode, 'version')
  assert.equal(plan.tag, 'v0.8.1-0.1.2')
  assert.equal(plan.skip, false)
})

test('CLI: GITHUB_OUTPUT mode writes key=value lines', () => {
  const tmp = path.join(here, '.release-plan.out')
  try {
    execFileSync(process.execPath, [CLI, '--app-version', '0.0.1', '--bundled', '0.1.1-rc.2', '--branch', 'main', '--existing-tags', ''], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: tmp },
    })
    const content = fs.readFileSync(tmp, "utf8")
    assert.match(content, /^tag=v0\.0\.1-0\.1\.1-rc\.2$/m)
    assert.match(content, /^mode=version$/m)
    assert.match(content, /^app_version=0\.0\.1$/m)
    assert.match(content, /^upstream=0\.1\.1-rc\.2$/m)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})

