/**
 * Skills 页内的 Agent 管理模块。
 *
 * 直接复用 Skills 生命周期与桥接通道：Agent 即作用域目录中的本机技能
 * （<name>/SKILL.md 目录束或 <name>.md 扁平 Markdown），global / project
 * 分别对应全局与项目 Agent 目录。这里只负责读取展示、刷新与启停/删除交互。
 */
import { bridge, type InstalledSkill, type SkillScope, type SkillsState } from '../../api'
import {
  badge,
  button,
  confirmDialog,
  emptyState,
  h,
  listContainer,
  listHint,
  row,
  switchControl,
  text,
} from '../../ui'

type ToastFn = (msg: string, err?: boolean) => void

export function renderAgentsPanel(
  body: HTMLElement,
  installed: InstalledSkill[],
  state: SkillsState | null,
  refresh: () => Promise<void>,
  toast: ToastFn,
): void {
  const globalAgents = installed.filter((s) => s.scope === 'global' && s.repoId === 'agents')
  const projectAgents = installed.filter((s) => s.scope === 'project' && s.repoId === 'agents')
  body.replaceChildren(
    row(
      button({ size: 'sm', onClick: () => void refresh() }, text('刷新')),
      listHint('读取 Agent 目录中的目录束 / 扁平 Markdown；启停与删除直接作用于对应作用域目录。'),
    ),
    h('div', { class: 'agent-cols' },
      renderScope('global', globalAgents, state, refresh, toast),
      renderScope('project', projectAgents, state, refresh, toast),
    ),
  )
}

function renderScope(
  scope: SkillScope,
  agents: InstalledSkill[],
  state: SkillsState | null,
  refresh: () => Promise<void>,
  toast: ToastFn,
): HTMLElement {
  const dir = scope === 'global' ? state?.globalDir : state?.projectDir
  const listEl = listContainer()
  if (agents.length === 0) {
    listEl.append(emptyState(scope === 'global' ? '全局 Agent 目录为空' : '项目 Agent 目录为空'))
  } else {
    for (const agent of agents) listEl.append(renderAgentItem(agent, refresh, toast))
  }
  return h('div', { class: 'agent-col' },
    h('div', { class: 'agent-col-head' },
      h('h4', { class: 'agent-col-title' }, text(scope === 'global' ? '全局 Agent' : '项目 Agent')),
      badge(`${agents.length} 个`),
      h('span', { class: 'mono muted agent-dir' }, text(dir ?? '—')),
    ),
    listEl,
  )
}

function renderAgentItem(
  agent: InstalledSkill,
  refresh: () => Promise<void>,
  toast: ToastFn,
): HTMLElement {
  const sw = switchControl(agent.enabled, (on) => {
    void (async () => {
      try {
        await bridge().setSkillEnabled(agent.key, agent.scope, on)
        toast(`Agent ${agent.name} 已${on ? '启用' : '停用'}`)
        await refresh()
      } catch (err) {
        sw.input.checked = !on
        toast(`操作失败：${String(err)}`, true)
      }
    })()
  })

  return h('div', { class: 'item', 'data-agent-key': agent.key },
    sw.root,
    h('div', { class: 'meta grow' },
      h('div', { class: 'name' }, text(agent.name), badge(agent.enabled ? '已启用' : '已停用', agent.enabled ? 'ok' : 'muted'), badge(agent.path)),
      h('div', { class: 'sub mono' }, text(agent.description ?? `${agent.path} · ${agent.files.length} 个文件`)),
    ),
    button({ size: 'sm', variant: 'danger', onClick: () => void removeAgent(agent, refresh, toast) }, text('删除')),
  )
}

async function removeAgent(
  agent: InstalledSkill,
  refresh: () => Promise<void>,
  toast: ToastFn,
): Promise<void> {
  const ok = await confirmDialog({
    title: '删除 Agent',
    message: `确定删除 Agent ${agent.name}（${agent.path}）？对应目录/文件将从 ${agent.scope === 'global' ? '全局' : '项目'} Agent 目录移除。`,
    confirmLabel: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await bridge().deleteSkill(agent.key, agent.scope)
    toast(`已删除 Agent ${agent.name}`)
    await refresh()
  } catch (err) {
    toast(`删除失败：${String(err)}`, true)
  }
}
