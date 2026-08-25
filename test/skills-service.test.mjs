/**
 * Tests for the dsh-desktop Skills service (core logic).
 *
 * Covers validation, repository discovery, repository registry + sync,
 * lifecycle (global/project scope isolation, install/enable/uninstall),
 * and backup/export/import validation. Uses esbuild to bundle the core
 * modules for plain Node (externalizing electron, like the plugin tests).
 * Git operations are faked — no real network or git binary is needed.
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
const outfile = path.join(here, '.skills-service.test.cjs')

await build({
  stdin: {
    contents: `
      export { validateRepositoryUrl, validateRepositoryName, isValidSkillScope, sanitizeSkillPath, skillKey, skillLeafName, isValidPayloadRelativePath } from './src/main/services/skills/validation'
      export { discoverSkills, parseSkillMetadata } from './src/main/services/skills/discovery'
      export { loadRepositories, saveRepositories, repoIdFromUrl, SkillsRepositoryManager } from './src/main/services/skills/repositoryManager'
      export { SkillsLifecycle } from './src/main/services/skills/lifecycle'
      export { buildExport, validateExportBundle, applyExportBundle, writeBackup, listBackups, readBackup, deleteBackup } from './src/main/services/skills/backup'
    `,
    resolveDir: root,
    sourcefile: 'skills-service-test-entry.ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  outfile,
  logLevel: 'silent',
})

const {
  validateRepositoryUrl,
  validateRepositoryName,
  isValidSkillScope,
  sanitizeSkillPath,
  skillKey,
  skillLeafName,
  isValidPayloadRelativePath,
  discoverSkills,
  parseSkillMetadata,
  loadRepositories,
  saveRepositories,
  repoIdFromUrl,
  SkillsRepositoryManager,
  SkillsLifecycle,
  buildExport,
  validateExportBundle,
  applyExportBundle,
  writeBackup,
  listBackups,
  readBackup,
  deleteBackup,
} = await import(pathToFileURL(outfile).href)

let workDir

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(outfile, { force: true })
})

function tmpDir(prefix) {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-skills-test-'))
  return workDir
}

// ---- validation ---- //

test('validation: repository URL rules', () => {
  assert.equal(validateRepositoryUrl('https://github.com/mattpocock/skills'), null)
  assert.equal(validateRepositoryUrl('http://gitlab.example.com/team/skills.git'), null)
  assert.ok(validateRepositoryUrl(''), 'empty is rejected')
  assert.ok(validateRepositoryUrl('file:///C:/tmp/skills'))
  assert.ok(validateRepositoryUrl('git@github.com:mattpocock/skills.git'))
  assert.ok(validateRepositoryUrl('https://user:pass@github.com/repo'))
  assert.ok(validateRepositoryUrl('not a url'))
  assert.ok(validateRepositoryUrl('https://github.com/mattpocock/skills'.repeat(300)))
})

test('validation: repository name rules', () => {
  assert.equal(validateRepositoryName('mattpocock/skills'), null)
  assert.ok(validateRepositoryName(''))
  assert.equal(validateRepositoryName('a/b'), null)
  assert.ok(validateRepositoryName('bad\0name'))
  assert.ok(validateRepositoryName('x'.repeat(130)))
})

test('validation: scope checks', () => {
  assert.ok(isValidSkillScope('global'))
  assert.ok(isValidSkillScope('project'))
  assert.ok(!isValidSkillScope('all'))
  assert.ok(!isValidSkillScope(''))
})

test('validation: path safety rejects traversal and absolutes', () => {
  assert.equal(sanitizeSkillPath('skills/writing-for-agents'), 'skills/writing-for-agents')
  assert.ok(!sanitizeSkillPath('../outside'))
  assert.ok(!sanitizeSkillPath('a/../../b'))
  assert.ok(!sanitizeSkillPath('/absolute'))
  assert.ok(!sanitizeSkillPath('a//b'))
})

test('validation: key + leaf derivation are stable and filesystem-safe', () => {
  assert.equal(skillKey('repo-1', 'skills/a/b'), 'repo-1:skills/a/b')
  const leaf = skillLeafName('repo-1', 'skills/a-b')
  assert.equal(leaf, 'repo-1-skills-a-b')
  assert.ok(!leaf.includes('/') && !leaf.includes('..'))
})

test('validation: payload relative path guard', () => {
  assert.ok(isValidPayloadRelativePath('SKILL.md'))
  assert.ok(isValidPayloadRelativePath('agents/openai.yaml'))
  assert.ok(!isValidPayloadRelativePath('../SKILL.md'))
  assert.ok(!isValidPayloadRelativePath('/etc/passwd'))
})

// ---- discovery ---- //

test('discovery: parses SKILL.md frontmatter and collects files', () => {
  const meta = parseSkillMetadata(`---
name: 文档写作
description: 面向 Agent 的文档写作规范
version: 1.0.0
---
# Body
content`)
  assert.equal(meta.name, '文档写作')
  assert.equal(meta.description, '面向 Agent 的文档写作规范')
  assert.equal(meta.version, '1.0.0')
})

test('discovery: walks repo, skips non-skill dirs and hidden dirs', () => {
  const dir = tmpDir('dsh-skills-discovery-')
  fs.mkdirSync(path.join(dir, 'skills', 'write'), { recursive: true })
  const agentsDir = path.join(dir, 'skills', 'write', 'agents')
  fs.mkdirSync(agentsDir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'write', 'SKILL.md'), '---\nname: 写作\n---\n正文段落', 'utf8')
  fs.writeFileSync(path.join(agentsDir, 'openai.yaml'), 'name: x\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'skills', 'no-skill'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'no-skill', 'README.md'), 'x', 'utf8')
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'x', 'utf8')

  const skills = discoverSkills(dir)
  assert.equal(skills.length, 1)
  const skill = skills[0]
  assert.equal(skill.path, 'skills/write')
  assert.equal(skill.name, '写作')
  assert.equal(skill.skillFile, 'skills/write/SKILL.md')
  assert.equal(skill.files.length, 2)
  assert.ok(skill.files.includes('skills/write/SKILL.md'))
  assert.ok(skill.files.includes('skills/write/agents/openai.yaml'))
})

// ---- repository manager ---- //

test('repo registry: load/save round-trip with invalid-file fallback', () => {
  const dir = tmpDir('dsh-skills-repo-')
  const file = path.join(dir, 'repositories.json')
  assert.deepEqual(loadRepositories(file), [])
  const record = {
    id: 'mattpocock-skills',
    name: 'skills',
    url: 'https://github.com/mattpocock/skills',
    branch: 'main',
    enabled: true,
    addedAt: 1,
    lastSyncAt: 2,
    lastCommit: 'abc123',
    lastSyncError: null,
    skillsCount: 3,
  }
  saveRepositories(file, [record])
  const loaded = loadRepositories(file)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'mattpocock-skills')
  fs.writeFileSync(file, '{broken', 'utf8')
  assert.deepEqual(loadRepositories(file), [])
})

test('repo manager: add+sync clones, records commit and skill count; duplicate URL returns existed', async () => {
  const dir = tmpDir('dsh-skills-manager-')
  const git = {
    async lsRemoteHead() {
      return { branch: 'main', sha: 'abc123def456' }
    },
    async clone(_url, cloneDir) {
      fs.mkdirSync(path.join(cloneDir, '.git'), { recursive: true })
      fs.mkdirSync(path.join(cloneDir, 'skills', 'demo'), { recursive: true })
      fs.writeFileSync(path.join(cloneDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nhello', 'utf8')
    },
    async fetchAndReset() {},
    async headSha() {
      return 'abc123def456'
    },
  }
  const manager = new SkillsRepositoryManager({
    configFile: path.join(dir, 'repositories.json'),
    reposDir: path.join(dir, 'repos'),
    git,
    now: () => 1000,
  })
  const first = await manager.add({ url: 'https://github.com/mattpocock/skills', name: 'skills' })
  assert.equal(first.existed, false)
  assert.equal(first.repo.lastCommit, 'abc123def456')
  assert.equal(first.repo.skillsCount, 1)
  assert.equal(first.repo.branch, 'main')
  assert.ok(fs.existsSync(path.join(manager.resolveRepoDir(first.repo.id), '.git')))

  const second = await manager.add({ url: 'https://github.com/mattpocock/skills' })
  assert.equal(second.existed, true)
})

test('repo manager: add rejects invalid URL before touching disk', async () => {
  const dir = tmpDir('dsh-skills-reject-')
  const manager = new SkillsRepositoryManager({
    configFile: path.join(dir, 'repositories.json'),
    reposDir: path.join(dir, 'repos'),
    git: { async lsRemoteHead() { return null }, async clone() {}, async fetchAndReset() {}, async headSha() { return null } },
  })
  await assert.rejects(() => manager.add({ url: 'file:///tmp/x' }), /http/)
})

test('repo manager: remove deletes clone cache and registry entry', async () => {
  const dir = tmpDir('dsh-skills-remove-')
  const manager = new SkillsRepositoryManager({
    configFile: path.join(dir, 'repositories.json'),
    reposDir: path.join(dir, 'repos'),
    git: { async lsRemoteHead() { return { branch: 'main', sha: 'a' } }, async clone(_u, d) { fs.mkdirSync(path.join(d, '.git'), { recursive: true }) }, async fetchAndReset() {}, async headSha() { return 'a' } },
  })
  const { repo } = await manager.add({ url: 'https://github.com/owner/skills' })
  manager.remove(repo.id)
  assert.equal(manager.list().length, 0)
  assert.ok(!fs.existsSync(manager.resolveRepoDir(repo.id)))
})

// ---- lifecycle ---- //

function makeDiscovered(overrides = {}) {
  return {
    id: 'writing-for-agents',
    name: '写作',
    description: 'desc',
    path: 'skills/writing-for-agents',
    skillFile: 'skills/writing-for-agents/SKILL.md',
    files: [
      'skills/writing-for-agents/SKILL.md',
      'skills/writing-for-agents/agents/openai.yaml',
    ],
    metadata: { name: '写作' },
    ...overrides,
  }
}

function makeRepo() {
  return {
    id: 'mattpocock-skills',
    name: 'skills',
    url: 'https://github.com/mattpocock/skills',
    branch: 'main',
    enabled: true,
    addedAt: 0,
    lastSyncAt: 0,
    lastCommit: 'abc123',
    lastSyncError: null,
    skillsCount: 1,
  }
}

function makeManager(root) {
  const git = {
    async lsRemoteHead() {
      return { branch: 'main', sha: 'abc123' }
    },
    async clone(_url, cloneDir) {
      fs.mkdirSync(path.join(cloneDir, '.git'), { recursive: true })
      fs.mkdirSync(path.join(cloneDir, 'skills', 'writing-for-agents', 'agents'), { recursive: true })
      fs.writeFileSync(path.join(cloneDir, 'skills', 'writing-for-agents', 'SKILL.md'), '---\nname: 写作\n---\n正文', 'utf8')
      fs.writeFileSync(path.join(cloneDir, 'skills', 'writing-for-agents', 'agents', 'openai.yaml'), 'x', 'utf8')
    },
    async fetchAndReset() {},
    async headSha() {
      return 'abc123'
    },
  }
  return new SkillsRepositoryManager({
    configFile: path.join(root, 'repositories.json'),
    reposDir: path.join(root, 'repos'),
    git,
    now: () => 1,
  })
}

function makeLifecycle(root) {
  return new SkillsLifecycle({
    globalDir: path.join(root, 'global'),
    projectDir: path.join(root, 'project'),
    reposDir: path.join(root, 'repos'),
    now: () => 42,
  })
}

test('lifecycle: install copies files and writes manifest; scopes isolated', () => {
  const root = tmpDir('dsh-skills-lifecycle-')
  const repoDir = path.join(root, 'repos', 'mattpocock-skills')
  fs.mkdirSync(path.join(repoDir, 'skills', 'writing-for-agents', 'agents'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'skills', 'writing-for-agents', 'SKILL.md'), 'content', 'utf8')
  fs.writeFileSync(path.join(repoDir, 'skills', 'writing-for-agents', 'agents', 'openai.yaml'), 'x', 'utf8')

  const lc = makeLifecycle(root)
  const skill = makeDiscovered()
  const installed = lc.installSkill('global', skill, makeRepo())
  assert.equal(installed.key, 'mattpocock-skills:skills/writing-for-agents')
  assert.equal(installed.enabled, true)
  assert.ok(fs.existsSync(path.join(root, 'global', installed.id, 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(root, 'global', installed.id, 'agents', 'openai.yaml')))

  const project = lc.installSkill('project', skill, makeRepo())
  assert.equal(project.id, installed.id)
  assert.ok(fs.existsSync(path.join(root, 'project', project.id, 'SKILL.md')))
  assert.equal(lc.listInstalled().length, 2)
  assert.equal(lc.listInstalled('global').length, 1)
})

test('lifecycle: enable/disable and uninstall update scope manifest only', () => {
  const root = tmpDir('dsh-skills-lifecycle-2-')
  const repoDir = path.join(root, 'repos', 'mattpocock-skills')
  fs.mkdirSync(path.join(repoDir, 'skills', 'writing-for-agents'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'skills', 'writing-for-agents', 'SKILL.md'), 'c', 'utf8')
  const lc = makeLifecycle(root)
  const installed = lc.installSkill('global', makeDiscovered(), makeRepo())

  lc.setEnabled('global', installed.key, false)
  assert.equal(lc.getSkill('global', installed.key)?.enabled, false)

  lc.uninstallSkill('global', installed.key)
  assert.equal(lc.listInstalled('global').length, 0)
  assert.ok(!fs.existsSync(path.join(root, 'global', installed.id)))
})

test('lifecycle: re-install same skill updates in place without overwrite flag', () => {
  const root = tmpDir('dsh-skills-lifecycle-3-')
  const repoDir = path.join(root, 'repos', 'mattpocock-skills')
  fs.mkdirSync(path.join(repoDir, 'skills', 'writing-for-agents'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'skills', 'writing-for-agents', 'SKILL.md'), 'c', 'utf8')
  const lc = makeLifecycle(root)
  const repo = makeRepo()
  const skill = makeDiscovered()
  lc.installSkill('global', skill, repo)
  const again = lc.installSkill('global', skill, repo)
  assert.equal(again.key, 'mattpocock-skills:skills/writing-for-agents')
  assert.equal(lc.listInstalled('global').length, 1)
})

test('lifecycle: rejects traversal paths', () => {
  const root = tmpDir('dsh-skills-lifecycle-4-')
  const lc = makeLifecycle(root)
  assert.throws(
    () => lc.installSkill('global', makeDiscovered({ path: '../outside', skillFile: '../outside/SKILL.md' }), makeRepo()),
    /路径不合法/,
  )
})

// ---- backup / export / import ---- //

test('backup: buildExport payload + validate rejects bad input', () => {
  const skill = makeDiscovered()
  const installed = {
    key: 'mattpocock-skills:skills/writing-for-agents',
    id: 'mattpocock-skills-skills-writing-for-agents',
    name: '写作',
    description: 'desc',
    repoId: 'mattpocock-skills',
    repoUrl: 'https://github.com/mattpocock/skills',
    path: 'skills/writing-for-agents',
    scope: 'global',
    commit: 'abc123',
    installedAt: 1,
    updatedAt: 2,
    enabled: true,
    files: ['SKILL.md'],
  }
  const resolver = {
    readFile: (abs) => (abs.endsWith('SKILL.md') ? 'payload-content' : null),
    installedFileAbs: (scope, id, rel) => path.join('/tmp', scope, id, rel),
  }
  const bundle = buildExport('all', [makeRepo()], [installed], true, '0.7.0', resolver)
  assert.equal(bundle.kind, 'dsh-desktop.skills-backup')
  assert.equal(bundle.payload?.global[installed.key]['SKILL.md'], 'payload-content')
  assert.equal(validateExportBundle(bundle), null)
  assert.ok(validateExportBundle({ kind: 'other' }))
  assert.ok(validateExportBundle({ ...bundle, formatVersion: 99 }))
  const badPayload = {
    ...bundle,
    payload: { global: { [installed.key]: { '../evil': 'x' } } },
  }
  assert.ok(validateExportBundle(badPayload))
})

test('backup: applyExportBundle restores payload skills and reports conflicts', async () => {
  const root = tmpDir('dsh-skills-import-')
  const lc = new SkillsLifecycle({
    globalDir: path.join(root, 'global'),
    projectDir: path.join(root, 'project'),
    reposDir: path.join(root, 'repos'),
  })
  const manager = makeManager(root)
  const installed = {
    key: 'mattpocock-skills:skills/writing-for-agents',
    id: 'mattpocock-skills-skills-writing-for-agents',
    name: '写作',
    description: 'desc',
    repoId: 'mattpocock-skills',
    repoUrl: 'https://github.com/mattpocock/skills',
    path: 'skills/writing-for-agents',
    scope: 'project',
    commit: 'abc123',
    installedAt: 1,
    updatedAt: 2,
    enabled: true,
    files: ['SKILL.md'],
  }
  const resolver = {
    readFile: () => 'content',
    installedFileAbs: (scope, id, rel) => path.join(lc.scopeDir(scope), id, rel),
  }
  const bundle = buildExport('all', [makeRepo()], [installed], true, '0.7.0', resolver)

  const report = await applyExportBundle(bundle, { manager, lifecycle: lc })
  assert.equal(report.importedRepositories, 1)
  assert.equal(report.importedSkills, 1)
  assert.equal(report.conflicts.length, 0)
  assert.ok(fs.existsSync(path.join(root, 'project', installed.id, 'SKILL.md')))

  const second = await applyExportBundle(bundle, { manager, lifecycle: lc })
  assert.equal(second.importedSkills, 0)
  assert.equal(second.conflicts.length, 1)
  assert.match(second.conflicts[0].reason, /已安装/)
})

test('backup: write/list/read/delete backup entries', () => {
  const root = tmpDir('dsh-skills-backup-')
  const data = buildExport('global', [], [], true, '0.7.0', undefined)
  const entry = writeBackup(path.join(root), data)
  assert.equal(entry.id, `backup-${data.exportedAt}`)
  const list = listBackups(path.join(root))
  assert.equal(list.length, 1)
  assert.equal(list[0].skillCount, 0)
  const read = readBackup(path.join(root), entry.id)
  assert.equal(read?.scope, 'global')
  deleteBackup(path.join(root), entry.id)
  assert.equal(listBackups(path.join(root)).length, 0)
})
export {}
