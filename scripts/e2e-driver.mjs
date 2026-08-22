/**
 * CDP end-to-end driver: attaches to the running app's control-panel page via
 * --remote-debugging-port and exercises the real window.dshc bridge.
 * Usage: node scripts/e2e-driver.mjs <step> [args...]
 */
const PORT = 9222

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

async function findControlTarget() {
  const list = await targets()
  const t = list.find((t) => (t.url ?? '').includes('control' + String.fromCharCode(47) + 'index.html'))
  if (!t) throw new Error('control panel target not found; targets: ' + list.map((x) => x.url).join(' | '))
  return t
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(new Error('ws error: ' + e.message))
  })
}

let seq = 0
const pending = new Map()

function call(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(ws, expression) {
  const r = await call(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) {
    throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  }
  return r.result.value
}

const step = process.argv[2]
const arg = process.argv[3]

const t = await findControlTarget()
const ws = await connect(t.webSocketDebuggerUrl)
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}

const exprs = {
  state: `window.dshc.getState()`,
  saveCreds: `window.dshc.saveCredentials(${JSON.stringify(process.env.E2E_GH_USER ?? 'youridol')}, ${JSON.stringify(process.env.E2E_GH_TOKEN ?? '')})`,
  check: `window.dshc.checkUpdates()`,
  addGit: `window.dshc.addGitPlugin(${JSON.stringify(arg)}).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e) }))`,
  plugins: `window.dshc.listPlugins()`,
  setEnabled: `window.dshc.setEnabled ? 0 : window.dshc.setPluginEnabled(${JSON.stringify(arg)}, ${process.argv[4] ?? 'true'})`,
  apply: `window.dshc.applyPlugins()`,
  versions: `window.dshc.listVersions()`,
  download: `window.dshc.downloadVersion(${JSON.stringify(arg)}).then(v => ({ ok: true }), e => ({ ok: false, e: String(e) }))`,
  switchTo: `window.dshc.switchVersion(${JSON.stringify(arg)}).then(v => ({ ok: true }), e => ({ ok: false, e: String(e) }))`,
  setPort: `window.dshc.setSettings({ port: ${Number(arg)} })`,
  restart: `window.dshc.restart()`,
  enableTest: `window.dshc.setPluginEnabled('dsh-desktop-test-plugin', true)`,
  remove: `window.dshc.removePlugin(${JSON.stringify(arg)})`,
  creds: `window.dshc.getCredentials()`,
}

if (!exprs[step]) throw new Error('unknown step: ' + step)
const value = await evaluate(ws, exprs[step])
console.log(JSON.stringify(value, null, 1))
ws.close()
process.exit(0)
