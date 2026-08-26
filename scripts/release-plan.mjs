/**
 * release-plan.mjs — dsh-desktop 版本发布决策（双版本号规范）的单一事实源。
 *
 * 供 build-and-release.yml 与 poll-upstream.yml 共用，避免两处工作流重复内联
 * 逻辑（版本归一化 / 分支清洗 / tag 生成 / prerelease 启发式 / 幂等判定）。
 *
 * 【双版本号规范】（严禁混淆）
 *   APP_VERSION = dsh-desktop 自身版本（package.json 的 version）
 *   UPSTREAM    = 本次捆绑的 DeepSeek Harness 上游标识：
 *                 - version 模式：上游最新发布 tag 规范化结果（dsh-vX.Y.Z → X.Y.Z）
 *                 - dev 模式：上游默认分支最新 commit 的 sha 前 7 位
 *   V（发版版本）= APP_VERSION-UPSTREAM（如 0.3.0-0.1.1-rc.2 / 0.3.0-a1b2c3d）
 *
 * 决策（auto 模式，poll 巡检）：
 *   - 目标 v{APP}-{上游 tag 版本} 不存在 → version（正式版）
 *   - 否则 v{APP}-{sha7} 不存在    → dev（候选版，prerelease）
 *   - 否则（force 除外）            → none（无变化，幂等退出）
 * build/push 通道：空/auto 一律解析为 version，由 tag 存在性做幂等跳过。
 *
 * 纯函数可直接单测；CLI 由工作流调用：
 *   GITHUB_OUTPUT 已设置 → 追加 key=value 输出；否则 stdout 打印 JSON。
 *   远端 tag 通过 --remote origin 查询，或由 --existing-tags 注入（测试用）。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 上游发布 tag 规范化：dsh-v0.1.1-rc.2 → 0.1.1-rc.2；非 dsh-v 前缀保留原样兜底。 */
export function normalizeUpstreamTag(tag) {
  if (typeof tag !== 'string') return ''
  return tag.replace(/^dsh-v/, '') || tag
}

/** 分支名 → git ref 安全后缀（与既有 bash 清洗规则一致：/ 与非法字符转 -，裁剪 60 字符）。 */
export function sanitizeBranch(branch) {
  return String(branch ?? '')
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 60)
}

/** 上游标识后缀启发式：rc/alpha/beta/pre 结尾 → prerelease（与既有 bash 正则一致）。 */
export function isPrerelease(upstream) {
  return /-?(rc|alpha|beta|pre)[.-]?[0-9]*$/.test(String(upstream ?? ''))
}

/**
 * 解析发布模式。
 * @param {object} o
 * @param {string} o.releaseMode  输入：'' | 'auto' | 'version' | 'dev'（空等价 auto）
 * @param {boolean} o.hasTagVersion v{APP}-{tag 版本} 是否已发布
 * @param {boolean} o.hasTagSha      v{APP}-{sha7} 是否已发布
 * @param {boolean} o.force
 * @param {boolean} o.allowDev      poll 巡检允许 auto→dev 候选；build/push 通道为 false
 * @returns {'version'|'dev'|'none'}
 */
export function resolveMode({ releaseMode, hasTagVersion, hasTagSha, force, allowDev }) {
  const mode = releaseMode === '' ? 'auto' : releaseMode
  if (mode === 'version' || mode === 'dev') return mode
  // auto
  if (allowDev) {
    if (!hasTagVersion) return 'version'
    if (!hasTagSha) return 'dev'
    if (force) return 'version'
    return 'none'
  }
  return 'version'
}

/**
 * 计算完整发布计划。所有输入显式传入（真实版本来自 package.json / 上游 API / 捆绑运行时），
 * 无任何硬编码版本。
 * @returns {object} plan（见下方字段）
 */
export function buildPlan({
  appVersion,
  upstreamVersion = '',
  upstreamSha = '',
  bundled = '',
  branch = 'main',
  existingTags = [],
  releaseMode = 'auto',
  force = false,
  prereleaseOverride = '',
  allowDev = false,
}) {
  if (!appVersion) throw new Error('app_version is required (package.json version)')

  const sha7 = String(upstreamSha || '').slice(0, 7)
  const tagUpstream = upstreamVersion || bundled

  // auto 决策用的 main 风格 tag（发布永远发生在 main）
  const tagVersion = appVersion && tagUpstream ? `v${appVersion}-${tagUpstream}` : ''
  const tagSha = appVersion && sha7 ? `v${appVersion}-${sha7}` : ''
  const hasTagVersion = tagVersion !== '' && existingTags.includes(tagVersion)
  const hasTagSha = tagSha !== '' && existingTags.includes(tagSha)

  const mode = resolveMode({ releaseMode, hasTagVersion, hasTagSha, force, allowDev })

  // 上游标识：dev 用 sha7；否则 tag 版本（未给则用捆绑版本）
  let upstream
  let upstreamType
  if (mode === 'dev') {
    upstream = sha7
    upstreamType = 'sha'
    if (!/^[0-9a-f]{7}$/.test(upstream)) {
      throw new Error(`dev mode requires upstream sha (7 hex chars), got '${upstreamSha}'`)
    }
  } else {
    upstream = upstreamVersion || bundled
    upstreamType = 'tag'
    if (upstreamVersion && bundled && upstreamVersion !== bundled) {
      throw new Error(`requested upstream '${upstreamVersion}' != bundled '${bundled}'`)
    }
  }
  if (!upstream) throw new Error('upstream identifier is empty (no upstream release tag and no bundled version)')

  const version = `${appVersion}-${upstream}`
  const branchLabel = sanitizeBranch(branch) || 'main'
  const tag = branch === 'main' ? `v${version}` : `v${version}-${branchLabel}`

  // prerelease：dev 恒为候选；否则显式标记；空则按上游标识后缀启发式
  let prerelease
  if (mode === 'dev') prerelease = true
  else if (prereleaseOverride === 'true') prerelease = true
  else if (prereleaseOverride !== '') prerelease = false
  else prerelease = isPrerelease(upstream)

  const skip = tag !== '' && existingTags.includes(tag) && !force

  return {
    app_version: appVersion,
    bundled,
    upstream,
    upstream_type: upstreamType,
    version,
    tag,
    branch,
    mode,
    changed: mode !== 'none',
    skip,
    prerelease,
    // 诊断信息（决策依据）
    tag_version: tagVersion,
    tag_sha: tagSha,
    has_tag_version: hasTagVersion,
    has_tag_sha: hasTagSha,
  }
}

/** 从远端查询全部 tag（返回 refs/tags/ 名称，去掉 ^{} 附注 tag 剥离行）。 */
export function listRemoteTags(remote) {
  const out = execFileSync('git', ['ls-remote', '--tags', remote], { encoding: 'utf8' })
  const tags = new Set()
  for (const line of out.split('\n')) {
    const m = line.match(/refs\/tags\/(.+)$/)
    if (!m) continue
    const ref = m[1]
    if (ref.endsWith('^{}')) continue
    tags.add(ref)
  }
  return [...tags]
}

const OUTPUT_KEYS = [
  'bundled',
  'app_version',
  'upstream',
  'upstream_type',
  'version',
  'tag',
  'branch',
  'mode',
  'changed',
  'skip',
  'prerelease',
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

function bool(args, key) {
  if (!(key in args)) return false
  const v = args[key]
  if (v === true) return true
  return v === 'true' || v === '1'
}

function splitTags(s) {
  return String(s ?? '')
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const existingTags =
    args['existing-tags'] !== undefined ? splitTags(args['existing-tags']) : args.remote ? listRemoteTags(args.remote) : []

  const plan = buildPlan({
    appVersion: args['app-version'] ?? '',
    upstreamVersion: args['upstream-version'] ?? '',
    upstreamSha: args['upstream-sha'] ?? '',
    bundled: args.bundled ?? '',
    branch: args.branch ?? 'main',
    existingTags,
    releaseMode: args['release-mode'] ?? 'auto',
    force: bool(args, 'force'),
    prereleaseOverride: args['prerelease-override'] ?? '',
    allowDev: bool(args, 'allow-dev'),
  })

  if (process.env.GITHUB_OUTPUT) {
    const lines = OUTPUT_KEYS.map((k) => `${k}=${plan[k]}`)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  }

  if (args.json || !process.env.GITHUB_OUTPUT) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  } else {
    // 日志友好摘要
    for (const k of OUTPUT_KEYS) process.stdout.write(`${k}=${plan[k]}\n`)
    process.stdout.write(`tag_version=${plan.tag_version} tag_sha=${plan.tag_sha}\n`)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}

