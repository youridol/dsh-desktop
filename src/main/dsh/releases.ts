/**
 * GitHub Releases client for deepseek-ai/deepseek-harness.
 *
 * Releases carry no binary assets — a release tag `dsh-v0.1.1-rc.2` maps 1:1 to
 * the npm package @deepseek-ai/dsh@0.1.1-rc.2, which is what actually gets
 * downloaded. Update checks therefore hit the GitHub API (authenticated with
 * the stored credentials when present, for rate limits/private access) while
 * the bits come from the npm registry.
 */
import { readCredentials } from '../config'

const REPO = 'deepseek-ai/deepseek-harness'
const API = 'https://api.github.com'

export interface ReleaseInfo {
  tag: string
  /** npm version corresponding to the release tag. */
  version: string
  publishedAt: string
  prerelease: boolean
  url: string
  notes: string
}

/** GitHub API 限流（HTTP 403 且 x-ratelimit-remaining: 0）。 */
export class GitHubRateLimitError extends Error {
  constructor(public readonly resetAt?: number) {
    super('GitHub API 403 rate limit exceeded')
    this.name = 'GitHubRateLimitError'
  }
}

/** 网络层错误（离线 / DNS / 超时）。 */
export class GitHubNetworkError extends Error {
  constructor(cause: unknown) {
    super(`GitHub API network error: ${String(cause)}`)
    this.name = 'GitHubNetworkError'
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-desktop',
  }
  const { githubToken } = readCredentials()
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`
  return headers
}

export function tagToVersion(tag: string): string {
  return tag.replace(/^dsh-v/, '')
}

async function ghFetch(pathname: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${API}${pathname}`, { headers: authHeaders() })
  } catch (err) {
    throw new GitHubNetworkError(err)
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const resetSec = Number(res.headers.get('x-ratelimit-reset') ?? '0')
    const resetAt = Number.isFinite(resetSec) && resetSec > 0 ? resetSec * 1000 : undefined
    throw new GitHubRateLimitError(resetAt)
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${pathname}`)
  }
  return res.json()
}

export async function listReleases(limit = 30): Promise<ReleaseInfo[]> {
  const raw = (await ghFetch(`/repos/${REPO}/releases?per_page=${limit}`)) as Array<{
    tag_name: string
    published_at: string
    prerelease: boolean
    html_url: string
    body: string | null
  }>
  return raw.map((r) => ({
    tag: r.tag_name,
    version: tagToVersion(r.tag_name),
    publishedAt: r.published_at,
    prerelease: r.prerelease,
    url: r.html_url,
    notes: (r.body ?? '').slice(0, 4000),
  }))
}

export interface CommitInfo {
  sha: string
  shortSha: string
  message: string
  date: string
  url: string
}

/** 默认分支最新 commit（per_page=1 即最新一条；与 CI poll-upstream 逻辑一致）。 */
export async function getLatestCommit(): Promise<CommitInfo> {
  const raw = (await ghFetch(`/repos/${REPO}/commits?per_page=1`)) as Array<{
    sha: string
    commit: { message: string; committer: { date: string } }
    html_url: string
  }>
  const c = raw[0]
  if (!c) throw new Error(`GitHub API returned no commits for ${REPO}`)
  return {
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    message: (c.commit?.message ?? '').split('\n')[0],
    date: c.commit?.committer?.date ?? '',
    url: c.html_url,
  }
}

/**
 * Semver-ish comparison for dsh versions (e.g. 0.1.1-rc.2 vs 0.1.0-rc.8).
 * Returns > 0 when a is newer than b.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(v)
    if (!m) return null
    return { major: +m[1], minor: +m[2], patch: +m[3], rc: m[4] !== undefined ? +m[4] : Number.MAX_SAFE_INTEGER }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return a === b ? 0 : a.localeCompare(b)
  for (const key of ['major', 'minor', 'patch', 'rc'] as const) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  return 0
}
