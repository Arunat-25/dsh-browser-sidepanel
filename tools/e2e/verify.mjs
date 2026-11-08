#!/usr/bin/env node
/**
 * verify.mjs — end-to-end verification of the `dsh-browser-sidepanel` bundle against
 * the live DSH Web GUI (http://127.0.0.1:3080), with a fresh headless Chrome as
 * the GUI browser and a local fixture page as the browsed page.
 *
 * What it proves, in order (see CONTRACT.md for the asserted contract). The
 * contract half runs before the panel is opened so the fixture page under test
 * is the only page interacting with the panel transport; the UI half then checks
 * the mounted body on top of a real pick.
 *   C01 fixture server          local page with #save-btn / #name / 60-row list
 *   C02 chrome                  fresh-profile headless Chrome, DevToolsActivePort
 *   C03 gui                     authenticated SPA boot (cookie set before navigate)
 *   C04 test session            an isolated, blank GUI Session (never a live one)
 *   C05 http state              GET /browser-panel/state contract shape
 *   C06 action ensure           reset stale Chrome/tabs, then ensure -> ready
 *   C07 action openTab          POST action openTab + resize -> viewport >= 600x400
 *   C08 tab metadata            tabs[] converges to the fixture url + status ready
 *   C09 navigate                an explicit navigate settles url/status (usable tab)
 *   C10 sse frames              >= 5 JPEG screencast frames within 10 s
 *   C11 input click             mouse down/up reaches the fixture page
 *   C12 input wheel             wheel scrolls the fixture page
 *   C13 input text+key          text and key reach input#name
 *   C14 pick arm+hover          pickMode + hover rect agrees with the button box
 *   C15 pick descriptor         selector resolves to #save-btn; full descriptor
 *   C16 sse picks               the SSE `picks` event carries the same pickId
 *   C17 context injection       the owning Session log receives the contextText
 *   C18 guide entry             right sidebar's guide lists the plugin's Browser card
 *   C19 panel opens             picking the card mounts a Browser tab body
 *   C20 panel body              the body owns a canvas and toolbar (not a placeholder)
 *   C21 panel renders frames    the canvas paints screencast pixels (not blank)
 *   C22 panel pick chip         the panel UI lists the pick (screenshot)
 *   C29 host probe              probe reports hover geometry and the page cursor
 *   C30 hover feedback          panel mirrors the cursor and outlines the hovered element
 *   C31 composer mention        the pick chip inserts an @browser mention into the input
 *   C23 wheel via panel UI      a CDP wheel over the canvas reaches the browsed page
 *   C24 forced SSE reconnect    panel shows a disconnect, then resumes painting
 *   C25 browser_pick_last tool  SKIP (no agent-tool call path from the harness)
 *   C26 shutdown                clear picks, then shutdown closes the Session Chrome
 *   C27 chrome cleanup          every process of the Host Chrome group is gone
 *   C28 state after shutdown    the route still answers, chrome idle
 *
 * Every check prints PASS/FAIL/SKIP with its evidence (bytes, counts, ms).
 * Exit code 0 only when every check passed (skips do not fail the run).
 * Machine-readable result: tools/e2e/out/summary.json (plus last-run.txt).
 *
 * Usage:
 *   node tools/e2e/verify.mjs                 # full run, kills its Chrome
 *   node tools/e2e/verify.mjs --keep          # keep Chrome for debugging
 *   node tools/e2e/verify.mjs --out=…         # artifact directory override
 *   node tools/e2e/verify.mjs --origin=…      # GUI origin override
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { launchChrome, jpegSize, sleep } from './cdp.mjs'
import { launchGui } from './gui.mjs'
import { createFixtureServer } from './fixture-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..', '..')
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const hit = argv.find((value) => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const ORIGIN = option('origin', process.env.DSH_GUI_ORIGIN ?? 'http://127.0.0.1:3080')
const OUT = option('out', join(HERE, 'out'))
const KEEP_CHROME = flag('keep')

/** Milliseconds since the run started, for evidence timings. */
const runStart = Date.now()
const elapsed = () => Date.now() - runStart
const iso = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-')

const checks = []
const defects = []
const artifacts = { screenshots: [], frames: [], json: [] }

const statusOf = (id) => checks.find((check) => check.id === id)?.status
const passed = (id) => statusOf(id) === 'PASS'

/**
 * Run one numbered check. A check throws to fail; its thrown message/evidence is
 * recorded and a defect is attributed to `owner`.
 */
async function step(id, name, owner, fn) {
  const started = Date.now()
  try {
    const evidence = await fn()
    const record = { id, name, status: 'PASS', owner, ms: Date.now() - started, evidence: evidence ?? null }
    checks.push(record)
    console.log(`[PASS] ${id} ${name} — ${formatEvidence(record.evidence)} (${record.ms}ms)`)
    return record
  } catch (error) {
    if (error instanceof Blocked) {
      const record = { id, name, status: 'SKIP', owner, reason: `blocked by ${error.upstream}`, ms: Date.now() - started, evidence: error.evidence ?? null }
      checks.push(record)
      console.log(`[SKIP] ${id} ${name} — blocked by ${error.upstream}`)
      return record
    }
    if (error?.name === 'SkipCheck') {
      const record = { id, name, status: 'SKIP', owner, reason: error.reason, ms: Date.now() - started, evidence: error.evidence ?? null }
      checks.push(record)
      console.log(`[SKIP] ${id} ${name} — ${error.reason}`)
      return record
    }
    const record = {
      id, name, status: 'FAIL', owner, ms: Date.now() - started,
      evidence: error.evidence ?? null,
      error: String(error.message ?? error).slice(0, 1200),
      repro: error.repro ?? '',
    }
    checks.push(record)
    console.log(`[FAIL] ${id} ${name} — ${record.error} (${record.ms}ms) [owner: ${owner}]`)
    if (record.evidence !== null) console.log(`       evidence: ${formatEvidence(record.evidence)}`)
    return record
  }
}

function skip(id, name, owner, reason) {
  const record = { id, name, status: 'SKIP', owner, reason, ms: 0, evidence: null }
  checks.push(record)
  console.log(`[SKIP] ${id} ${name} — ${reason}`)
  return record
}

/** Skip because an upstream check failed; no new defect is attributed. */
function blockedBy(id, name, owner, upstream) {
  return skip(id, name, owner, `blocked by ${upstream} (${checks.find((c) => c.id === upstream)?.error ?? 'failed'})`)
}

function formatEvidence(evidence) {
  if (evidence === null || evidence === undefined) return '(no evidence)'
  if (typeof evidence === 'string') return evidence
  return Object.entries(evidence)
    .map(([key, value]) => {
      const rendered = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
      return `${key}=${rendered.length > 180 ? `${rendered.slice(0, 180)}…` : rendered}`
    })
    .join(' ')
}

const fail = (message, { evidence, repro } = {}) => {
  const error = new Error(message)
  if (evidence !== undefined) error.evidence = evidence
  if (repro !== undefined) error.repro = repro
  return error
}

/** Thrown by a check whose upstream check failed: records SKIP, not a defect. */
class Blocked extends Error {
  constructor(upstream) {
    super(`blocked by ${upstream}`)
    this.name = 'Blocked'
    this.upstream = upstream
  }
}
const blocked = (upstream) => new Blocked(upstream)

/** Thrown by a check that cannot test its subject in this environment: SKIP, no defect. */
const skipBecause = (reason) => {
  const error = new Error(reason)
  error.name = 'SkipCheck'
  error.reason = reason
  return error
}

// ---------------------------------------------------------------------------
// process + session-log helpers
// ---------------------------------------------------------------------------

/** Every Chrome/Chromium process, as `{pid, pgid, args, display}` (args kept whole for ownership tests). */
function listChromeProcesses() {
  let raw = ''
  try { raw = execFileSync('ps', ['-eo', 'pid=,pgid=,args='], { encoding: 'utf8' }) } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const args = match[3]
    // Only real browser executables, not node processes whose script name says "chrome".
    if (!/^\/usr\/bin\/(google-chrome|chrome|chromium)|^\/opt\/google\/chrome\/chrome|^\/snap\/bin\/chromium/u.test(args)) continue
    out.push({ pid: Number(match[1]), pgid: Number(match[2]), args, display: args.slice(0, 160) })
  }
  return out
}

/** PIDs holding a TCP connection whose peer port is `port` (own-user processes only). */
function pidsWithPeerPort(port) {
  let raw = ''
  try { raw = execFileSync('ss', ['-tnp'], { encoding: 'utf8' }) } catch { return [] }
  const pids = new Set()
  for (const line of raw.split('\n')) {
    const columns = line.trim().split(/\s+/u)
    if (columns.length < 5) continue
    const peer = columns[4]
    if (peer === undefined || !peer.endsWith(`:${port}`)) continue
    const match = /pid=(\d+)/u.exec(line)
    if (match !== null) pids.add(Number(match[1]))
  }
  return [...pids]
}

/**
 * The process group led by the Chrome main process serving `port`, or null.
 * The Host spawns Chrome detached with its own group, so the group id is the
 * browser process; renderers/utilities/network share it. This is the only
 * attribution that survives concurrent unrelated Chrome processes on the host.
 */
function hostChromeGroupForPort(port) {
  if (!Number.isInteger(port) || port === 0) return null
  const chromeMainIds = new Set(listChromeProcesses().map((process) => process.pid))
  for (const pid of pidsWithPeerPort(port)) {
    let pgid
    try { pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) } catch { continue }
    if (Number.isInteger(pgid) && chromeMainIds.has(pgid)) return pgid
  }
  return null
}

/**
 * Decode a session log (`.zstd` or plain `.jsonl`).
 *
 * The live writer appends one zstd *frame* per flush, so a decompressor that
 * returns only the first frame silently hides every later record. The zstd CLI
 * decodes the whole stream; the node binding is the single-frame fallback.
 */
async function readSessionLog(file) {
  if (!file.endsWith('.zstd')) return (await readFile(file)).toString('utf8')
  try {
    return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch {
    const raw = await readFile(file)
    return zstdDecompressSync(raw).toString('utf8')
  }
}

/** Find the session log for `sessionId` under the DSH sessions tree. */
async function findSessionLogs(sessionId) {
  const roots = []
  try {
    roots.push(...(await readdir(SESSIONS_ROOT)).map((name) => join(SESSIONS_ROOT, name)))
  } catch { return [] }
  const found = []
  // A GUI Session's directory is named after its id, so the direct hit is cheap.
  for (const root of roots) {
    let entries = []
    try { entries = await readdir(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name !== sessionId) continue
      const directory = join(root, entry.name)
      const files = await readdir(directory).catch(() => [])
      for (const logName of files.filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/u.test(name))) {
        const file = join(directory, logName)
        try { found.push({ file, text: await readSessionLog(file) }) } catch { /* ignore */ }
      }
    }
  }
  return found
}

/** Read the plugin build state so the report can say which integration round ran. */
async function readBuildState() {
  const read = async (relative) => {
    try { return await readFile(join(PLUGIN_ROOT, relative), 'utf8') } catch { return '' }
  }
  const mtimeOf = async (relative) => {
    try { return new Date((await stat(join(PLUGIN_ROOT, relative))).mtimeMs).toISOString() } catch { return null }
  }
  const client = await read('client.js')
  const host = await read('host/panel.js')
  const hostFiles = await readdir(join(PLUGIN_ROOT, 'host')).catch(() => [])
  const clientFiles = await readdir(join(PLUGIN_ROOT, 'client')).catch(() => [])
  return {
    clientPlaceholder: /PLACEHOLDER/u.test(client),
    hostPlaceholder: /PLACEHOLDER/u.test(host),
    hostFiles,
    clientFiles,
    clientBytes: client.length,
    hostPanelBytes: host.length,
    // Build provenance: the bundle is served from these files, so the mtimes say
    // exactly which build a run exercised.
    clientMtime: await mtimeOf('client.js'),
    hostMtimes: {
      'host/panel.js': await mtimeOf('host/panel.js'),
      'host/browser.js': await mtimeOf('host/browser.js'),
      'host/tools.js': await mtimeOf('host/tools.js'),
    },
  }
}

/**
 * Make sure the mounted conversation is an isolated blank Session. Picks inject
 * context into the owning Session, so the harness must never pick while a live
 * session is mounted.
 */
async function ensureBlankSession(page, projectName) {
  const read = async () => page.evaluate(`(() => {
    const id = document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null
    return {
      sessionId: id,
      turns: document.querySelectorAll('[data-turn-process],[data-turn-trigger],[data-turn-tail]').length,
      composer: document.querySelectorAll('[data-composer-input]').length,
    }
  })()`)
  const current = await read()
  if (current.sessionId === null) throw fail('no conversation is mounted', { repro: 'page has no [data-conversation-session]' })
  if (current.turns === 0 && current.composer > 0) return { sessionId: current.sessionId, blank: true, switched: false }

  // The mounted conversation has turns: try to open the workspace's blank Session
  // through the workspace row's New-session action.
  const workspace = await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
      .find(r => (r.textContent || '').includes(${JSON.stringify(projectName)}))
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (workspace !== null) {
    await page.mouseClick(workspace.x, workspace.y, { button: 'left' })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: workspace.x, y: workspace.y })
    await sleep(400)
    const action = await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(b => b.getAttribute('aria-label') === ${JSON.stringify(`New session in ${projectName}`)}
                   && b.getBoundingClientRect().width > 0)
      if (!button) return null
      const r = button.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (action !== null) {
      await page.mouseClick(action.x, action.y, { button: 'left' })
      await sleep(2500)
      const next = await read()
      if (next.sessionId !== null && next.turns === 0) {
        return { sessionId: next.sessionId, blank: true, switched: true }
      }
    }
  }

  // Last resort: a workspace keeps one blank Session in the list ("New Session").
  // Open it by its row rather than creating another.
  const blankRow = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')]
      .filter(row => /^New Session$/u.test((row.textContent || '').trim()))
    const row = rows[0]
    if (!row) return null
    const r = row.getBoundingClientRect()
    return { key: row.getAttribute('data-row-key'), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  if (blankRow !== null) {
    await page.mouseClick(blankRow.x, blankRow.y, { button: 'left' })
    await sleep(2000)
    const next = await read()
    if (next.sessionId !== null && next.turns === 0) {
      return { sessionId: next.sessionId, blank: true, switched: true, via: 'blank-row' }
    }
  }
  return { sessionId: current.sessionId, blank: false, switched: false, turns: current.turns }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

let chrome = null
let guiCdp = null
let page = null
let fixture = null
const chromeBaseline = []
/** Browser console/log errors seen in the GUI page (client-side defect signal). */
const consoleEvents = []
const ctx = { sessionId: null, sessionBlank: false, tabId: null, tab: null, state: null, pick: null, sseInstalled: false }

const main = async () => {
  await mkdir(OUT, { recursive: true })
  const runId = iso(Date.now())
  console.log(`\n=== browser-panel E2E verification ${runId} ===`)
  console.log(`origin: ${ORIGIN}   out: ${OUT}`)
  const build = await readBuildState()
  console.log(`build: clientPlaceholder=${build.clientPlaceholder} hostPlaceholder=${build.hostPlaceholder} hostFiles=[${build.hostFiles.join(',')}] clientFiles=[${build.clientFiles.join(',')}]`)

  chromeBaseline.push(...listChromeProcesses())

  // -- C01 fixture server ---------------------------------------------------
  await step('C01', 'fixture server', 'harness', async () => {
    fixture = await createFixtureServer()
    const health = await fetch(`${fixture.url}health`).then((response) => response.status).catch(() => 0)
    const html = await fetch(fixture.url).then((response) => response.text()).catch(() => '')
    const rows = (html.match(/id="row-\d+"/gu) ?? []).length
    if (health !== 200) throw fail(`fixture /health -> ${health}`, { repro: `curl ${fixture.url}health` })
    if (!html.includes('id="save-btn"') || !html.includes('id="name"') || rows !== 60) {
      throw fail('fixture document missing #save-btn / #name / 60 rows', { evidence: { health, bytes: html.length, rows } })
    }
    return { port: fixture.port, bytes: html.length, rows }
  })

  // -- C02 chrome -----------------------------------------------------------
  await step('C02', 'headless Chrome (fresh profile)', 'harness', async () => {
    chrome = await launchChrome({ headless: true, width: 1440, height: 960, cleanupUserDataDir: true })
    const fresh = chrome.userDataDir.includes('dsh-chrome-')
    return { pid: chrome.pid, port: chrome.port, readyMs: chrome.readyMs, freshProfile: fresh, userDataDir: chrome.userDataDir }
  })
  if (!chrome) {
    for (const id of ['C04', 'C18', 'C19', 'C20', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C21', 'C22', 'C29', 'C30', 'C31', 'C23', 'C24', 'C25', 'C26', 'C27', 'C28']) {
      skip(id, 'blocked: no GUI browser', 'harness', 'Chrome failed to launch')
    }
    return finish(runId, build)
  }

  // -- C03 GUI boot ---------------------------------------------------------
  await step('C03', 'GUI boot (authenticated)', 'harness', async () => {
    const cookie = JSON.parse(execFileSync(process.execPath, [join(HERE, '..', 'auth-cookie.mjs'), '--json'], { encoding: 'utf8' }))
    const launched = await launchGui(ORIGIN, cookie, { width: 1440, height: 960 })
    guiCdp = launched.cdp
    page = launched.page
    // Client-side exceptions are the most likely cause of a blank panel; collect
    // them for the report.
    await page.send('Log.enable').catch(() => {})
    guiCdp.on('Runtime.consoleAPICalled', (params, meta) => {
      if (meta.sessionId !== page.sessionId) return
      if (params.type !== 'error' && params.type !== 'warning') return
      const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type ?? '').join(' ')
      consoleEvents.push({ kind: `console.${params.type}`, text: String(text).slice(0, 300), ts: Date.now() })
    })
    guiCdp.on('Log.entryAdded', (params, meta) => {
      if (meta.sessionId !== page.sessionId) return
      const entry = params.entry ?? {}
      if (entry.level !== 'error' && entry.level !== 'warning') return
      consoleEvents.push({ kind: `log.${entry.level}`, text: String(entry.text ?? '').slice(0, 300), ts: Date.now() })
    })
    const title = await page.waitFor(`document.title`, { timeout: 20_000, label: 'document.title' })
    const root = await page.waitFor(`document.querySelector('#root')?.childElementCount || 0`, { timeout: 25_000, label: '#root children' })
    await page.waitFor(`document.querySelectorAll('[data-composer-input]').length > 0`, { timeout: 25_000, label: 'composer' })
    ctx.cookie = cookie
    const cookieCount = await page.send('Network.getCookies', { urls: [`${ORIGIN}/`] }).then((r) => r.cookies?.length ?? 0)
    // Everything Chrome spawns for the harness browser already exists here; any
    // later Chrome pid outside this set belongs to the plugin Host.
    ctx.chromeIdsBeforeHost = new Set(listChromeProcesses().map((process) => process.pid))
    return { title, rootChildren: root, cookies: cookieCount, bootMs: elapsed(), harnessChromePids: ctx.chromeIdsBeforeHost.size }
  })
  if (!page) {
    for (const id of ['C04', 'C18', 'C19', 'C20', 'C05', 'C06', 'C07', 'C10', 'C21', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C22', 'C29', 'C30', 'C31', 'C17', 'C26', 'C27', 'C28']) {
      skip(id, 'blocked: GUI did not boot', 'harness', 'C03 failed')
    }
    return finish(runId, build)
  }

  // -- C04 isolated blank test session --------------------------------------
  await step('C04', 'isolated blank test session', 'harness', async () => {
    const projectName = process.env.DSH_TEST_PROJECT ?? basename(dirname(PLUGIN_ROOT))
    // The shell boots before a Conversation is mounted; wait for the session host.
    await page.waitFor(`document.querySelector('[data-conversation-session]') !== null || document.querySelector('[data-sidebar-right-session]') !== null`, {
      timeout: 25_000, label: 'conversation session mounted',
    })
    await sleep(600)
    const session = await ensureBlankSession(page, projectName)
    ctx.sessionId = session.sessionId
    ctx.sessionBlank = session.blank
    ctx.sessionSwitched = session.switched
    // Cross-check blankness against the Session's own log. A Session whose log
    // holds conversation records must never receive a pick; the plugin's own
    // `agent/inbox/spliced` records (pending context from earlier runs) do not
    // make a Session a live conversation.
    const conversationEvents = ['"type":"turn/start"', '"type":"turn/end"', '"type":"user/message"',
      '"type":"assistant/message"', '"type":"step/start"']
    const logs = await findSessionLogs(session.sessionId)
    const logLines = logs.length === 0 ? null : logs[0].text.split('\n').filter(Boolean).length
    const conversationLines = logs.length === 0 ? 0
      : logs[0].text.split('\n').filter((line) => conversationEvents.some((needle) => line.includes(needle))).length
    const splicedCount = logs.length === 0 ? 0
      : (logs[0].text.match(/"type":"agent\/inbox\/spliced"/gu) ?? []).length
    if (session.blank && conversationLines > 0) {
      session.blank = false
      session.logLines = logLines
      ctx.sessionBlank = false
    }
    if (!session.blank) {
      throw fail(`mounted Session ${session.sessionId} is not blank (conversation records: ${conversationLines}, log lines: ${logLines}); refusing to pick into a live Session`, {
        evidence: { ...session, logLines, conversationLines, splicedCount },
        repro: 'open the GUI fresh: the last-active Session is restored; the harness needs an empty Session',
      })
    }
    return {
      sessionId: session.sessionId, switched: session.switched, via: session.via ?? 'mounted',
      turns: 0, logLines, conversationLines, splicedCount,
    }
  })

  // -- C05 plugin HTTP state ------------------------------------------------
  await step('C05', 'GET /browser-panel/state contract', 'host', async () => {
    const response = await page.pageFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)
    ctx.state = response.body
    if (response.status !== 200) {
      throw fail(`GET /browser-panel/state -> ${response.status}`, {
        evidence: response,
        repro: `fetch('/browser-panel/state?sessionId=${ctx.sessionId}') from the authenticated GUI page`,
      })
    }
    const body = response.body
    if (body?.placeholder === true) {
      throw fail('state route still serves the placeholder body `{placeholder:true}` (Host not implemented)', {
        evidence: body,
        repro: "GET /browser-panel/state?sessionId=<sid> returns {ok:true,placeholder:true,chrome:'/usr/bin/google-chrome'}",
      })
    }
    const problems = []
    if (body?.ok !== true) problems.push('ok!==true')
    if (typeof body?.chrome?.status !== 'string') problems.push('chrome.status missing')
    if (!Array.isArray(body?.tabs)) problems.push('tabs[] missing')
    if (!Array.isArray(body?.picks)) problems.push('picks[] missing')
    if (typeof body?.pickMode !== 'boolean') problems.push('pickMode missing')
    if (problems.length > 0) throw fail(`state contract violations: ${problems.join(', ')}`, { evidence: body })
    return { status: response.status, chrome: body.chrome, tabs: body.tabs.length, picks: body.picks.length, bytes: JSON.stringify(body).length }
  })

  // -- C06 ensure -----------------------------------------------------------
  const action = async (name, params = {}) => page.pageFetch('/browser-panel/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: ctx.sessionId, tabId: ctx.tabId ?? undefined, action: name, params }),
  })

  /** Same requests from the harness process, used when the GUI page is recovering. */
  const serverFetch = async (path, init = {}) => {
    try {
      const response = await fetch(`${ORIGIN}${path}`, {
        ...init,
        headers: { cookie: `${ctx.cookie.name}=${ctx.cookie.value}`, ...(init.headers ?? {}) },
      })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = text.slice(0, 400) }
      return { status: response.status, body }
    } catch (error) { return { status: 0, error: String(error) } }
  }
  const serverAction = async (name, params = {}) => serverFetch('/browser-panel/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: ctx.sessionId, tabId: ctx.tabId ?? undefined, action: name, params }),
  })

  await step('C06', 'POST action ensure starts Chrome (clean slate)', 'host', async () => {
    if (!passed('C05')) throw blocked('C05')
    const statePath = `/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`
    const before = await page.pageFetch(statePath)
    const tabsBefore = before.body?.tabs?.length ?? null
    // A previous run (or an aborted run) can leave Chrome and tabs behind; both
    // would consume the tab limit and inject stale picks. `shutdown` clears both.
    const reset = await action('shutdown')
    const cleared = await action('picksClear')
    const resetDeadline = Date.now() + 5_000
    let afterReset = null
    for (;;) {
      afterReset = await page.pageFetch(statePath)
      if ((afterReset.body?.chrome?.status === 'idle') && (afterReset.body?.tabs?.length ?? 0) === 0) break
      if (Date.now() >= resetDeadline) break
      await sleep(200)
    }
    const response = await action('ensure')
    if (response.status !== 200 || response.body?.ok !== true) {
      throw fail(`POST action ensure -> ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`, {
        evidence: { response, tiles: afterReset?.body },
        repro: "POST /browser-panel/action {action:'ensure'}",
      })
    }
    const chromeStatus = response.body.result?.chrome?.status
    ctx.chromeStatus = chromeStatus
    if (chromeStatus !== 'ready' && chromeStatus !== 'launching') {
      throw fail(`ensure returned chrome.status=${JSON.stringify(chromeStatus)}`, { evidence: response.body })
    }
    return {
      status: response.status, chromeStatus, ms: elapsed(),
      tabsBefore, tabsAfterReset: afterReset?.body?.tabs?.length ?? null,
      chromeAfterReset: afterReset?.body?.chrome?.status ?? null,
      shutdownOk: reset.body?.ok === true, shutdownCode: reset.body?.code ?? null,
      picksAfterClear: cleared.body?.result?.picks?.length ?? null,
    }
  })

  // -- C07 openTab + resize -------------------------------------------------
  await step('C07', 'POST action openTab (fixture) + viewport', 'host', async () => {
    if (!passed('C06')) throw blocked('C06')
    // Snapshot the tab list the request will be judged against (Lead asked for it).
    const preState = await page.pageFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)
    const tabsBeforeOpenTab = (preState.body?.tabs ?? []).map((row) => ({ tabId: row.tabId, url: row.url, status: row.status, active: row.active }))
    const open = await action('openTab', { url: fixture.url })
    if (open.status !== 200 || open.body?.ok !== true) {
      throw fail(`POST action openTab -> ${open.status} ${JSON.stringify(open.body).slice(0, 200)}`, {
        evidence: open,
        repro: `POST /browser-panel/action {action:'openTab', params:{url:'${fixture.url}'}}`,
      })
    }
    const tab = open.body.result?.tab
    if (tab === undefined || typeof tab.tabId !== 'string') throw fail('openTab result.tab.tabId missing', { evidence: open.body })
    ctx.tab = tab
    ctx.tabId = tab.tabId
    const resized = await action('resize', { width: 1280, height: 800 })
    if (resized.status !== 200 || resized.body?.ok !== true) {
      throw fail(`POST action resize -> ${resized.status} ${JSON.stringify(resized.body).slice(0, 200)}`, { evidence: resized })
    }
    const viewport = resized.body.result?.viewport ?? tab.viewport
    if (!viewport || viewport.width < 600 || viewport.height < 400) {
      throw fail(`viewport too small: ${JSON.stringify(viewport)} (need >= 600x400)`, {
        evidence: { viewport, tab },
        repro: "POST action resize {width:1280,height:800}",
      })
    }
    const layout = await fixture.waitFor((event) => (event.type === 'ready' || event.type === 'layout') && event.saveRect !== null, 10_000).catch(() => null)
    if (layout === null) {
      throw fail('the fixture page never reported itself loaded in the Host tab', {
        evidence: { tabId: ctx.tabId, openResult: tab, fixtureRequests: fixture.requests().length },
        repro: `POST openTab {url:'${fixture.url}'}; the fixture page must load and beacon its layout`,
      })
    }
    // The Host's Chrome is the process group serving the fixture port; capture it
    // now so the shutdown check can attribute exactly its processes.
    ctx.hostChromeGroup = hostChromeGroupForPort(fixture.port)
    return {
      sessionId: ctx.sessionId, tabId: ctx.tabId, tabsBeforeOpenTab,
      openResultUrl: tab.url, openResultStatus: tab.status, viewport,
      fixtureViewport: layout.viewport ?? null, fixtureRequests: fixture.requests().length,
      hostChromeGroup: ctx.hostChromeGroup ?? null, ms: elapsed(),
    }
  })

  // -- C08 tab metadata settles --------------------------------------------
  await step('C08', 'tab url/status settle after openTab', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    const wanted = fixture.url.slice(0, -1)
    let tabRow = null
    const deadline = Date.now() + 6_000
    for (;;) {
      const live = await page.pageFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)
      tabRow = (live.body?.tabs ?? []).find((entry) => entry.tabId === ctx.tabId) ?? null
      if (tabRow !== null && typeof tabRow.url === 'string' && tabRow.url.startsWith(wanted) && tabRow.status === 'ready') break
      if (Date.now() >= deadline) break
      await sleep(500)
    }
    const problems = []
    if (tabRow === null) problems.push('no tabs[] row for the opened tab')
    else {
      if (typeof tabRow.url !== 'string' || !tabRow.url.startsWith(wanted)) problems.push(`tabs[].url=${tabRow.url} (expected ${fixture.url})`)
      if (tabRow.status !== 'ready') problems.push(`tabs[].status=${tabRow.status} (expected ready)`)
    }
    if (problems.length > 0) {
      throw fail(`tab metadata never settled after openTab: ${problems.join('; ')}`, {
        evidence: { tabRow, wantedUrl: fixture.url, fixtureRequests: fixture.requests().map((request) => request.path) },
        repro: "POST openTab {url:<fixture>}; poll GET /browser-panel/state for 6s: the tab row must converge to url=<fixture>, status=ready",
      })
    }
    return { url: tabRow.url, status: tabRow.status, title: tabRow.title, canGoBack: tabRow.canGoBack, waitedMs: 6_000 - Math.max(0, deadline - Date.now()) }
  })

  // -- C09 navigate settles tab metadata --------------------------------
  await step('C09', 'navigate settles tab url/status', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    const wanted = fixture.url.slice(0, -1)
    const navigated = await action('navigate', { url: fixture.url })
    if (navigated.status !== 200 || navigated.body?.ok !== true) {
      throw fail(`POST action navigate -> ${navigated.status} ${JSON.stringify(navigated.body).slice(0, 200)}`, {
        evidence: navigated,
        repro: `POST /browser-panel/action {action:'navigate', params:{url:'${fixture.url}'}}`,
      })
    }
    let tabRow = null
    const deadline = Date.now() + 6_000
    for (;;) {
      const live = await page.pageFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)
      tabRow = (live.body?.tabs ?? []).find((entry) => entry.tabId === ctx.tabId) ?? null
      if (tabRow !== null && typeof tabRow.url === 'string' && tabRow.url.startsWith(wanted) && tabRow.status === 'ready') break
      if (Date.now() >= deadline) break
      await sleep(500)
    }
    if (tabRow === null || typeof tabRow.url !== 'string' || !tabRow.url.startsWith(wanted) || tabRow.status !== 'ready') {
      throw fail(`tab metadata did not settle after navigate: ${JSON.stringify(tabRow)}`, {
        evidence: { tabRow, wantedUrl: fixture.url },
        repro: "POST navigate to the fixture URL, then poll GET /browser-panel/state for 6s",
      })
    }
    return { url: tabRow.url, status: tabRow.status, title: tabRow.title, canGoBack: tabRow.canGoBack }
  })

  // -- C10 SSE frames -------------------------------------------------------
  await step('C10', 'SSE yields >= 5 JPEG frames in 10 s', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    const url = `/browser-panel/stream?sessionId=${encodeURIComponent(ctx.sessionId)}&tabId=${encodeURIComponent(ctx.tabId)}`
    await page.evaluate(`(() => {
      const collector = window.__e2eSse = { events: [], frames: [], frameData: [], errors: [], picks: [], status: [], opened: 0, url: ${JSON.stringify(url)} }
      try {
        const source = new EventSource(${JSON.stringify(url)})
        collector.source = source
        source.addEventListener('open', () => { collector.opened += 1 })
        source.addEventListener('status', (event) => {
          try { collector.status.push(JSON.parse(event.data)) } catch { collector.status.push({ raw: String(event.data).slice(0, 200) }) }
        })
        source.addEventListener('frame', (event) => {
          try {
            const data = JSON.parse(event.data)
            collector.frames.push({ seq: data.seq, w: data.w, h: data.h, base64: (data.data || '').length, t: Date.now() })
            if (collector.frameData.length < 3) collector.frameData.push(data.data || '')
          } catch { collector.errors.push('frame parse: ' + String(event.data).slice(0, 120)) }
        })
        source.addEventListener('picks', (event) => {
          try { collector.picks.push(JSON.parse(event.data)) } catch { collector.errors.push('picks parse') }
        })
        source.addEventListener('error', (event) => {
          if (event?.data) collector.errors.push(String(event.data).slice(0, 200))
          else collector.errorEvents = (collector.errorEvents || 0) + 1
        })
      } catch (error) { collector.errors.push(String(error)) }
      return true
    })()`)
    ctx.sseInstalled = true
    const started = Date.now()
    const snapshot = await page.waitFor(`(() => {
      const c = window.__e2eSse
      if (!c) return null
      return c.frames.length >= 5 ? c : null
    })()`, { timeout: 10_000, label: '5 SSE frames' }).catch(() => null)
    const waitedMs = Date.now() - started
    const detail = snapshot ?? await page.evaluate(`(() => {
      const c = window.__e2eSse || {}
      return { frames: c.frames || [], errors: c.errors || [], status: c.status || [], opened: c.opened, errorEvents: c.errorEvents || 0 }
    })()`)
    if (!snapshot) {
      throw fail(`SSE yielded ${(detail.frames ?? []).length} frame events in 10 000ms (need >= 5)`, {
        evidence: { frames: (detail.frames ?? []).length, errors: detail.errors, statusEvents: (detail.status ?? []).length, opened: detail.opened, errorEvents: detail.errorEvents ?? 0 },
        repro: `new EventSource('${url}') from the GUI page while the panel tab is mounted`,
      })
    }
    // Validate the JPEG payloads.
    const frames = await page.evaluate(`window.__e2eSse.frameData`)
    const decoded = frames.map((base64) => Buffer.from(base64, 'base64'))
    const sizes = decoded.map((buffer) => buffer.length)
    const magic = decoded.every((buffer) => buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8)
    const dimensions = decoded.map((buffer) => jpegSize(buffer))
    for (let index = 0; index < decoded.length; index += 1) {
      const file = join(OUT, `frame-${String(index + 1).padStart(2, '0')}.jpg`)
      await writeFile(file, decoded[index])
      artifacts.frames.push(file)
    }
    const evidence = {
      frames: snapshot.frames.length,
      waitedMs,
      firstSeq: snapshot.frames[0]?.seq,
      lastSeq: snapshot.frames[snapshot.frames.length - 1]?.seq,
      jpegMagic: magic,
      sizes,
      imageSize: dimensions[0] ? `${dimensions[0].width}x${dimensions[0].height}` : null,
      sseW: snapshot.frames[0]?.w,
      sseH: snapshot.frames[0]?.h,
      bytes: sizes.reduce((sum, size) => sum + size, 0),
      statusEvents: snapshot.status?.length ?? 0,
      errors: snapshot.errors ?? [],
    }
    if (!magic) throw fail('frame payloads are not JPEG (missing FFD8 SOI magic)', { evidence })
    if (snapshot.frames.length < 5) throw fail(`only ${snapshot.frames.length} frames in ${waitedMs}ms`, { evidence })
    return evidence
  })

  // -- fixture layout -------------------------------------------------------
  /** Latest element geometry reported by the fixture page (republished after scrolls). */
  const latestLayout = async (sinceMs = 0) => {
    const event = await fixture.waitFor((entry) => (entry.type === 'ready' || entry.type === 'layout')
      && entry.saveRect !== null && (entry.ts ?? 0) >= sinceMs, 8_000).catch(() => null)
    if (event === null) return null
    return { saveRect: event.saveRect, nameRect: event.nameRect, viewport: event.viewport, scrollY: event.scrollY ?? 0 }
  }

  // -- C11 click ------------------------------------------------------------
  await step('C11', 'mouse click reaches the fixture page', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    const layout = await latestLayout()
    if (layout === null) throw fail('fixture never reported #save-btn geometry')
    fixture.reset()
    const { saveRect } = layout
    const down = await action('mouse', { type: 'move', x: saveRect.x + saveRect.w / 2, y: saveRect.y + saveRect.h / 2 })
    if (down.body?.ok !== true) throw fail(`mouse move action failed: ${JSON.stringify(down.body).slice(0, 200)}`, { evidence: down })
    await action('mouse', { type: 'down', x: saveRect.x + saveRect.w / 2, y: saveRect.y + saveRect.h / 2, button: 'left', clickCount: 1 })
    await action('mouse', { type: 'up', x: saveRect.x + saveRect.w / 2, y: saveRect.y + saveRect.h / 2, button: 'left', clickCount: 1 })
    const event = await fixture.waitFor((entry) => entry.type === 'click' && entry.target === 'save-btn', 6_000).catch(() => null)
    if (event === null) {
      throw fail('click at #save-btn centre never reached the fixture page (no click event)', {
        evidence: { point: { x: saveRect.x + saveRect.w / 2, y: saveRect.y + saveRect.h / 2 }, saveRect, fixtureEvents: fixture.events().length },
        repro: `POST action mouse down/up at ${saveRect.x + saveRect.w / 2},${saveRect.y + saveRect.h / 2}`,
      })
    }
    return { point: { x: saveRect.cx ?? saveRect.x + saveRect.w / 2, y: saveRect.y + saveRect.h / 2 }, fixtureClicks: event.count, ms: elapsed() }
  })

  // -- C12 wheel ------------------------------------------------------------
  await step('C12', 'wheel scrolls the fixture page', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    fixture.reset()
    const response = await action('wheel', { x: 400, y: 400, deltaX: 0, deltaY: 600 })
    if (response.body?.ok !== true) throw fail(`wheel action failed: ${JSON.stringify(response.body).slice(0, 200)}`, { evidence: response })
    const event = await fixture.waitFor((entry) => entry.type === 'scroll' && entry.y > 0, 6_000).catch(() => null)
    if (event === null) {
      throw fail('wheel did not scroll the fixture page (no scroll event)', {
        evidence: { fixtureEvents: fixture.events().map((entry) => entry.type) },
        repro: "POST action wheel {x:400,y:400,deltaX:0,deltaY:600}",
      })
    }
    // Return to the top: later gestures address element boxes measured at scrollY 0.
    let restored = null
    for (let attempt = 0; attempt < 3 && restored === null; attempt += 1) {
      const restoreAt = Date.now()
      await action('wheel', { x: 400, y: 400, deltaX: 0, deltaY: -1200 })
      const deadline = Date.now() + 1_500
      for (;;) {
        const latest = await latestLayout(restoreAt)
        if (latest !== null && latest.scrollY === 0) { restored = latest.scrollY; break }
        if (Date.now() >= deadline) break
        await sleep(150)
      }
    }
    if (restored === null) {
      throw fail('wheel did not return the fixture page to the top', {
        evidence: { lastScroll: fixture.last((entry) => entry.type === 'scroll'), lastLayout: await latestLayout() },
        repro: 'wheel deltaY:+600 then deltaY:-1200; the fixture must report scrollY 0 again',
      })
    }
    return { scrollY: event.y, restoredTo: restored, fixtureEvents: fixture.events().length }
  })

  // -- C13 text + key -------------------------------------------------------
  await step('C13', 'text and key reach input#name', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    const layout = await latestLayout()
    if (layout?.nameRect === null || layout?.nameRect === undefined) throw fail('fixture never reported #name geometry')
    fixture.reset()
    const { nameRect } = layout
    const x = nameRect.x + nameRect.w / 2
    const y = nameRect.y + nameRect.h / 2
    await action('mouse', { type: 'move', x, y })
    await action('mouse', { type: 'down', x, y, button: 'left', clickCount: 1 })
    await action('mouse', { type: 'up', x, y, button: 'left', clickCount: 1 })
    const landed = await fixture.waitFor((entry) => entry.type === 'document-click', 4_000).catch(() => null)
    if (landed === null || landed.id !== 'name') {
      throw fail(`click at ${x},${y} hit ${JSON.stringify(landed?.id ?? null)} instead of input#name`, {
        evidence: { point: { x, y }, nameRect, landed },
        repro: `POST action mouse down/up at ${x},${y}; the fixture reports which element was clicked`,
      })
    }
    const typed = 'E2E typed text'
    const textResult = await action('text', { text: typed })
    if (textResult.body?.ok !== true) throw fail(`text action failed: ${JSON.stringify(textResult.body).slice(0, 200)}`, { evidence: textResult })
    const input = await fixture.waitFor((entry) => entry.type === 'input' && String(entry.value).includes('E2E'), 6_000).catch(() => null)
    await action('key', { type: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })
    await action('key', { type: 'up', key: 'a', code: 'KeyA', keyCode: 65 })
    const keyEvent = await fixture.waitFor((entry) => entry.type === 'key' && entry.key === 'a', 6_000).catch(() => null)
    if (input === null) {
      throw fail('typed text never reached input#name', {
        evidence: { fixtureEvents: fixture.events().map((entry) => entry.type) },
        repro: "click the input, then POST action text {text:'E2E typed text'}",
      })
    }
    if (keyEvent === null) throw fail('key down/up never reached the fixture page', { evidence: { fixtureEvents: fixture.events().map((entry) => entry.type) } })
    return { inputValue: input.value, key: keyEvent.key, valueAfterKey: keyEvent.value ?? null }
  })

  // -- C14 pickArmed + hover ------------------------------------------------
  await step('C14', 'pickArm + pickHover agree with the button box', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    const armed = await action('pickArm', { on: true })
    if (armed.body?.ok !== true || armed.body.result?.pickMode !== true) {
      throw fail(`pickArm -> ${JSON.stringify(armed.body).slice(0, 200)}`, { evidence: armed, repro: "POST action pickArm {on:true}" })
    }
    const layout = await latestLayout()
    if (layout === null) throw fail('fixture never reported #save-btn geometry')
    const { saveRect } = layout
    const x = saveRect.x + saveRect.w / 2
    const y = saveRect.y + saveRect.h / 2
    const hovered = await action('pickHover', { x, y })
    if (hovered.body?.ok !== true) throw fail(`pickHover failed: ${JSON.stringify(hovered.body).slice(0, 200)}`, { evidence: hovered })
    const rect = hovered.body.result?.rect
    if (!rect || typeof rect.x !== 'number') throw fail('pickHover returned no rect for the button centre', { evidence: hovered.body })
    const near = Math.abs(rect.x - saveRect.x) <= 3 && Math.abs(rect.y - saveRect.y) <= 3
      && Math.abs(rect.w - saveRect.w) <= 3 && Math.abs(rect.h - saveRect.h) <= 3
    if (!near) throw fail(`pickHover rect ${JSON.stringify(rect)} disagrees with fixture box ${JSON.stringify(saveRect)}`, { evidence: { rect, saveRect } })
    return { pickMode: armed.body.result.pickMode, hoverRect: rect, label: hovered.body.result.label ?? null, near }
  })

  // -- C15 pick descriptor --------------------------------------------------
  await step('C15', 'pick returns a descriptor for #save-btn', 'host', async () => {
    if (!passed('C14')) throw blocked('C14')
    const layout = await latestLayout()
    if (layout === null) throw fail('fixture never reported #save-btn geometry')
    const { saveRect } = layout
    const x = saveRect.x + saveRect.w / 2
    const y = saveRect.y + saveRect.h / 2
    const picked = await action('pick', { x, y })
    if (picked.body?.ok !== true) throw fail(`pick -> ${JSON.stringify(picked.body).slice(0, 300)}`, { evidence: picked, repro: `POST action pick {x:${x},y:${y}}` })
    const pick = picked.body.result?.pick
    if (!pick || typeof pick !== 'object') throw fail('pick result has no descriptor', { evidence: picked.body })
    ctx.pick = pick
    const problems = []
    if (typeof pick.pickId !== 'string' || !pick.pickId.startsWith('p-')) problems.push('pickId not p-…')
    if (pick.sessionId !== ctx.sessionId) problems.push(`sessionId ${pick.sessionId} != ${ctx.sessionId}`)
    if (pick.tabId !== ctx.tabId) problems.push(`tabId ${pick.tabId} != ${ctx.tabId}`)
    if (typeof pick.url !== 'string' || !pick.url.startsWith(fixture.url.slice(0, -1))) problems.push(`url ${pick.url}`)
    if (typeof pick.selector !== 'string' || !pick.selector.includes('#save-btn')) problems.push(`selector ${pick.selector} does not resolve to #save-btn`)
    if (String(pick.tag).toLowerCase() !== 'button') problems.push(`tag ${pick.tag}`)
    if (pick.id !== 'save-btn') problems.push(`id ${pick.id}`)
    if (!String(pick.text ?? '').includes('Save changes')) problems.push(`text ${JSON.stringify(pick.text)}`)
    if (!pick.rect || Math.abs(pick.rect.x - saveRect.x) > 3 || Math.abs(pick.rect.y - saveRect.y) > 3
        || Math.abs(pick.rect.w - saveRect.w) > 3 || Math.abs(pick.rect.h - saveRect.h) > 3) {
      problems.push(`rect ${JSON.stringify(pick.rect)} != ${JSON.stringify(saveRect)}`)
    }
    if (!Array.isArray(pick.classes) || !Array.isArray(pick.ancestors) || typeof pick.attrs !== 'object') problems.push('classes/ancestors/attrs shape')
    if (typeof pick.ts !== 'number' || Math.abs(Date.now() - pick.ts) > 120_000) problems.push(`ts ${pick.ts}`)
    if (typeof pick.outerHTML !== 'string' || !pick.outerHTML.includes('save-btn')) problems.push('outerHTML')
    if (typeof pick.contextText !== 'string') problems.push('contextText missing')
    const expectedContext = [
      /Picked browser element/u,
      /page: .+ — http/u,
      /selector: .*#save-btn/u,
      /element: <button/u,
      /text: ".*Save changes.*"/u,
      /box: [\d.]+,[\d.]+ [\d.]+×[\d.]+/u,
      /path: .+/u,
      /html: <button/u,
    ]
    const contextMissing = expectedContext.filter((pattern) => !pattern.test(pick.contextText ?? '')).map((pattern) => pattern.source)
    if (contextMissing.length > 0) problems.push(`contextText missing ${contextMissing.join(' | ')}`)
    const evidence = {
      pickId: pick.pickId, selector: pick.selector, tag: pick.tag, id: pick.id,
      text: String(pick.text ?? '').slice(0, 40), rect: pick.rect, url: pick.url,
      contextBytes: (pick.contextText ?? '').length, outerHTMLBytes: (pick.outerHTML ?? '').length,
      problems,
    }
    if (problems.length > 0) {
      throw fail(`pick descriptor violations: ${problems.join('; ')}`, {
        evidence,
        repro: `POST action pick {x:${x},y:${y}} and inspect result.pick`,
      })
    }
    return evidence
  })

  // -- C16 SSE picks --------------------------------------------------------
  await step('C16', 'SSE picks event carries the pick', 'host', async () => {
    if (!passed('C15')) throw blocked('C15')
    const picks = await page.waitFor(`(() => {
      const collector = window.__e2eSse
      if (!collector) return null
      const match = collector.picks.find(event => Array.isArray(event.picks) && event.picks.some(p => p.pickId === ${JSON.stringify(ctx.pick.pickId)}))
      return match ? { events: collector.picks.length, picks: match.picks.length, pickIds: match.picks.map(p => p.pickId) } : null
    })()`, { timeout: 8_000, label: 'SSE picks event' }).catch(() => null)
    if (picks === null) {
      const seen = await page.evaluate(`(() => { const c = window.__e2eSse || {}; return { picksEvents: (c.picks || []).length, errors: c.errors || [] } })()`)
      throw fail(`no SSE picks event carried pickId ${ctx.pick.pickId}`, {
        evidence: seen,
        repro: 'pick an element while an EventSource to /browser-panel/stream is open',
      })
    }
    return picks
  })

  // -- C17 context injection into the owning Session log --------------------
  await step('C17', 'owning Session log receives the injected context', 'host', async () => {
    if (!passed('C15')) throw blocked('C15')
    if (ctx.sessionBlank !== true) throw blocked('C04')
    // The fixture's ephemeral port makes this run's page URL unique, so matching
    // it proves the *current* pick was injected (not a record from an earlier run).
    const needles = {
      headline: 'Picked browser element',
      url: fixture.url,
      selector: 'selector: #save-btn',
      spliced: 'agent/inbox/spliced',
    }
    const deadline = Date.now() + 10_000
    let logs = []
    let match = null
    let splicedTotal = 0
    for (;;) {
      logs = await findSessionLogs(ctx.sessionId)
      for (const log of logs) {
        const lines = log.text.split('\n').filter(Boolean)
        splicedTotal = lines.filter((line) => line.includes(needles.spliced)).length
        const hits = lines.filter((line) => line.includes(needles.spliced)
          && line.includes(needles.headline) && line.includes(needles.url))
        if (hits.length > 0) { match = { log, line: hits[hits.length - 1], count: hits.length }; break }
      }
      if (match !== null) break
      if (Date.now() >= deadline) break
      await sleep(400)
    }
    const evidence = {
      sessionId: ctx.sessionId,
      logFiles: logs.map((log) => log.file),
      splicedTotal,
      matchedThisRun: match?.count ?? 0,
      fixtureUrl: fixture.url,
    }
    if (match === null) {
      throw fail(`the owning Session log has no ${needles.spliced} record carrying this run's context (${fixture.url})`, {
        evidence: { ...evidence, hint: 'search session.v*.jsonl.zstd for "Picked browser element" + the fixture URL' },
        repro: `POST pick on the fixture page, then: zstd -dc <session log> | grep "Picked browser element"`,
      })
    }
    let parsed = null
    try { parsed = JSON.parse(match.line) } catch { /* keep raw evidence */ }
    const injectedText = parsed?.data?.inserted?.[0]?.content?.[0]?.text ?? ''
    const problems = []
    if (!injectedText.includes(needles.headline)) problems.push('injected text missing the headline')
    if (!injectedText.includes(needles.url)) problems.push('injected text missing the page URL')
    if (!injectedText.includes(needles.selector)) problems.push('injected text missing `selector: #save-btn`')
    if (injectedText.includes(ctx.pick.contextText) === false && !injectedText.includes(needles.selector)) problems.push('injected text does not match the pick contextText')
    if (problems.length > 0) {
      throw fail(`injected context mismatch: ${problems.join('; ')}`, {
        evidence: { ...evidence, injectedText: injectedText.slice(0, 400) },
        repro: 'compare pick.result.pick.contextText with the agent/inbox/spliced payload in the session log',
      })
    }
    return {
      ...evidence,
      splicedSeq: parsed?.seq ?? null,
      splicedTime: parsed?.time ?? null,
      role: parsed?.data?.inserted?.[0]?.role ?? null,
      target: parsed?.data?.target ?? null,
      injectedBytes: injectedText.length,
      injectedText: injectedText.slice(0, 400),
    }
  })

  // -- C18 guide entry ------------------------------------------------------
  await step('C18', 'guide lists the plugin Browser card', 'client', async () => {
    const open = await page.evaluate(`document.querySelectorAll('[data-sidebar-right-open]').length`)
    if (open === 0) {
      // While collapsed the way in is the conversation header's expand button;
      // the panel's own toggle is slid off-screen.
      const expand = await page.rectOf('[data-sidebar-right-expand]')
      if (expand !== null) await page.clickSelector('[data-sidebar-right-expand]')
      else await page.clickLabel('Open right sidebar')
      await page.waitFor(`document.querySelectorAll('[data-sidebar-right-open]').length > 0`, { timeout: 8_000, label: 'sidebar expanded' })
      // The column animates open; a click during the slide can miss the card.
      await sleep(700)
    }
    const cards = await page.waitFor(`(() => {
      const cards = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')]
      return cards.length === 0 ? null : cards.map(card => ({
        kind: card.getAttribute('data-sidebar-right-guide-entry'),
        text: (card.textContent || '').trim().slice(0, 140),
      }))
    })()`, { timeout: 10_000, label: 'guide cards' })
    const browserCards = cards.filter((card) => card.kind === 'browser')
    const shot = await page.screenshot(join(OUT, '01-guide-browser-card.png'))
    artifacts.screenshots.push(shot.path)
    if (browserCards.length !== 1) {
      throw fail(`expected exactly one guide card with kind "browser", found ${browserCards.length}`, {
        evidence: { cards },
        repro: 'open the right sidebar on a blank Session; the guide must list the plugin type',
      })
    }
    if (!/^Browser/u.test(browserCards[0].text)) {
      throw fail(`Browser guide card text does not start with "Browser": ${JSON.stringify(browserCards[0].text)}`, { evidence: browserCards[0] })
    }
    return { cards: cards.length, kinds: cards.map((card) => card.kind), browserText: browserCards[0].text, shot: shot.path, shotBytes: shot.bytes }
  })
  // -- C19 open the panel from the card -------------------------------------
  await step('C19', 'browser card opens the panel', 'client', async () => {
      if (!passed('C18')) throw blocked('C18')
      // Count body mounts: a double mount (StrictMode/remount) would multiply
      // Chrome targets, so it is evidence for the tab-reuse checks.
      await page.evaluate(`(() => {
        const host = document.querySelector('[data-rightbar-col]') ?? document.body
        window.__e2ePanelMounts = { canvasAdded: 0, tabAdded: 0, records: 0 }
        const observer = new MutationObserver((records) => {
          window.__e2ePanelMounts.records += records.length
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof HTMLElement)) continue
              if (node.matches('canvas') || node.querySelector('canvas') !== null) window.__e2ePanelMounts.canvasAdded += 1
              if (node.matches('[data-sidebar-right-tab]') || node.querySelector('[data-sidebar-right-tab]') !== null) window.__e2ePanelMounts.tabAdded += 1
            }
          }
        })
        observer.observe(host, { childList: true, subtree: true })
        return true
      })()`)
      const rect = await page.rectOf('[data-sidebar-right-guide-entry="browser"]')
      if (rect === null) throw fail('browser guide card vanished before clicking')
      await page.mouseClick(rect.cx, rect.cy)
      const opened = await page.waitFor(`document.querySelector('[data-browser-panel]') !== null`, { timeout: 4_000, label: 'panel root' }).then(() => true).catch(() => false)
      if (!opened) {
        // One retry: the first click may have landed while the sidebar was still moving.
        await sleep(500)
        const again = await page.rectOf('[data-sidebar-right-guide-entry="browser"]')
        if (again !== null) await page.mouseClick(again.cx, again.cy)
      }
      const tab = await page.waitFor(`(() => {
        const tabs = [...document.querySelectorAll('[role="tab"]')].filter(t => t.querySelector('[data-sidebar-right-tab]'))
        if (tabs.length === 0) return null
        const selected = tabs.find(t => t.getAttribute('aria-selected') === 'true') ?? tabs[0]
        return { count: tabs.length, text: (selected.textContent || '').trim().slice(0, 60), selected: selected.getAttribute('aria-selected') }
      })()`, { timeout: 10_000, label: 'browser tab' })
      const body = await page.waitFor(`(() => {
        const pane = document.querySelector('[data-dockkit-pane]')
        if (!pane) return null
        const text = (pane.innerText || '').trim()
        return text.length === 0 ? null : { text: text.slice(0, 300), empty: /^Empty pane$/u.test(text) }
      })()`, { timeout: 10_000, label: 'panel body' })
      // Point the panel at the fixture through its *own* address form. This works
      // no matter which Chrome tab the Client adopted from /state, and it goes
      // through the real Client submit handler (form requestSubmit -> navigate).
      const addressSelector = '[data-dockkit-pane] input[data-browser-panel-address]'
      const hasAddress = await page.evaluate(`document.querySelector(${JSON.stringify(addressSelector)}) !== null`)
      let panelShowsFixture = false
      if (hasAddress) {
        await page.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(addressSelector)})
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(input, ${JSON.stringify(fixture.url)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.focus()
          input.form?.requestSubmit()
          return input.value
        })()`)
        panelShowsFixture = await page.waitFor(`(() => {
          const pane = document.querySelector('[data-dockkit-pane]')
          return pane !== null && /Browser Panel E2E Fixture/u.test(pane.innerText || '')
        })()`, { timeout: 10_000, label: 'panel shows the fixture page' }).then(() => true).catch(() => false)
      }
      if (!panelShowsFixture) {
        // Fallback: drop the panel's blank tab and let its tabFallback adoption
        // pick up the fixture tab from /state.
        const rows = (await page.pageFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)).body?.tabs ?? []
        for (const row of rows.filter((entry) => entry.url === 'about:blank' && entry.tabId !== ctx.tabId)) {
          await page.pageFetch('/browser-panel/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: ctx.sessionId, tabId: row.tabId, action: 'closeTab', params: {} }),
          })
        }
        panelShowsFixture = await page.waitFor(`(() => {
          const pane = document.querySelector('[data-dockkit-pane]')
          return pane !== null && /Browser Panel E2E Fixture/u.test(pane.innerText || '')
        })()`, { timeout: 10_000, label: 'panel adopts the fixture tab' }).then(() => true).catch(() => false)
      }
      if (!panelShowsFixture) {
        throw fail('panel did not show the fixture page after submitting its address form (and tabFallback got no fixture tab)', {
          evidence: {
            fixtureUrl: fixture.url,
            paneText: await page.evaluate(`(document.querySelector('[data-dockkit-pane]')?.innerText || '').slice(0, 400)`),
            debug: await page.evaluate(`(() => ({
              panes: [...document.querySelectorAll('[data-dockkit-pane]')].map(p => (p.innerText || '').slice(0, 60)),
              tabs: [...document.querySelectorAll('[data-sidebar-right-tab]')].map(t => t.getAttribute('data-sidebar-right-tab')),
              canvases: document.querySelectorAll('canvas').length,
              panelRoots: document.querySelectorAll('[data-browser-panel]').length,
              bodyTail: (document.body.innerText || '').slice(-500),
            }))()`),
            tabs: (await page.pageFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)).body?.tabs ?? null,
            consoleErrors: consoleEvents.slice(-5),
          },
          repro: `set the panel address input to ${fixture.url} and submit its form; the panel must render that page`,
        })
      }
      const shot = await page.screenshot(join(OUT, '02-panel-opened.png'))
      artifacts.screenshots.push(shot.path)
      if (body.empty) throw fail('panel body is the dockkit "Empty pane" placeholder: the tab body is not registered', { evidence: { tab, body } })
      const mounts = await page.evaluate(`window.__e2ePanelMounts ?? null`)
      const afterState = await page.pageFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)
      ctx.panelMounts = mounts
      return {
        tab, bodyText: body.text, panelShowsFixture, panelMounts: mounts,
        tabs: (afterState.body?.tabs ?? []).map((row) => ({ tabId: row.tabId, url: row.url, status: row.status })),
        shot: shot.path, shotBytes: shot.bytes,
      }
  })

  // -- C20 panel body is a real browser body, not a placeholder -------------
  await step('C20', 'panel body is a real browser body', 'client', async () => {
    if (!passed('C19')) throw blocked('C19')
    const shape = await page.evaluate(`(() => {
      const pane = document.querySelector('[data-dockkit-pane]')
      if (!pane) return null
      const text = (pane.innerText || '').trim()
      return {
        canvas: pane.querySelectorAll('canvas').length,
        images: pane.querySelectorAll('img').length,
        buttons: [...pane.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || (b.textContent || '').trim()).filter(Boolean).slice(0, 12),
        text: text.slice(0, 300),
        placeholder: /Browser panel loading|placeholder/iu.test(text),
        hasAddressInput: pane.querySelectorAll('input').length,
        pickUi: pane.querySelectorAll('[data-pick-id],[data-browser-panel-pick],[data-pick]').length,
      }
    })()`)
    if (shape === null) throw fail('panel pane disappeared')
    if (shape.canvas === 0) {
      throw fail(`panel body renders no canvas (client placeholder): ${JSON.stringify(shape.text.slice(0, 120))}`, {
        evidence: shape,
        repro: 'click the Browser guide card; the body must contain the screencast canvas',
      })
    }
    return shape
  })

  // -- C21 canvas paints ----------------------------------------------------
  await step('C21', 'panel canvas paints a non-uniform screencast image', 'client', async () => {
    if (!passed('C20')) throw blocked('C20')
    if (!passed('C19')) throw blocked('C19')
    const paint = await page.waitFor(`(() => {
      const canvas = document.querySelector('[data-dockkit-pane] canvas')
      if (!canvas) return null
      const context = canvas.getContext('2d')
      if (!context) return null
      let painted = 0, sampled = 0, sum = 0
      const colors = new Set()
      try {
        const w = canvas.width, h = canvas.height
        const stepX = Math.max(1, Math.floor(w / 24)), stepY = Math.max(1, Math.floor(h / 24))
        for (let y = 0; y < h; y += stepY) for (let x = 0; x < w; x += stepX) {
          const [r, g, b, a] = context.getImageData(x, y, 1, 1).data
          sampled += 1
          sum += r + g + b
          if (a > 0 && r + g + b > 0) painted += 1
          colors.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3))
        }
      } catch (error) { return { error: String(error) } }
      return { painted, sampled, distinctColors: colors.size, avg: Math.round(sum / Math.max(1, sampled) / 3), width: canvas.width, height: canvas.height }
    })()`, { timeout: 12_000, label: 'canvas pixels' }).catch(() => null)
    const shot = await page.screenshot(join(OUT, '03-panel-frames.png'))
    artifacts.screenshots.push(shot.path)
    if (paint === null) {
      throw fail('panel canvas is missing or still blank after frames arrived', {
        evidence: { canvasCount: await page.evaluate(`document.querySelectorAll('[data-dockkit-pane] canvas').length`), consoleErrors: consoleEvents.slice(-5) },
        repro: 'wait for SSE frames, then inspect the panel canvas pixels',
      })
    }
    if (paint.painted === 0 || paint.distinctColors < 2) {
      throw fail(`panel canvas is uniform (painted=${paint.painted}/${paint.sampled}, distinctColors=${paint.distinctColors})`, {
        evidence: { ...paint, panelMounts: ctx.panelMounts ?? null },
        repro: 'open the panel with a live tab, wait for SSE frames, sample the canvas pixels',
      })
    }
    return { ...paint, panelMounts: ctx.panelMounts ?? null, shot: shot.path, shotBytes: shot.bytes }
  })

  // -- C22 panel pick chip --------------------------------------------------
  await step('C22', 'panel UI lists the pick chip', 'client', async () => {
    if (!passed('C15')) throw blocked('C15')
    const chip = await page.waitFor(`(() => {
      const pane = document.querySelector('[data-dockkit-pane]')
      if (!pane) return null
      const marked = [...pane.querySelectorAll('[data-pick-id],[data-browser-panel-pick],[data-pick]')]
        .map(el => ({ kind: [...el.attributes].map(a => a.name).find(n => /pick/u.test(n)), text: (el.textContent || '').trim().slice(0, 120) }))
      const text = pane.innerText || ''
      // The pick chip names the element's text; the canvas paints are not text, so
      // a text match here can only come from the panel chrome or the pick list.
      const nodes = [...pane.querySelectorAll('*')]
        .filter(el => (el.textContent || '').includes('Save changes') && el.children.length <= 3)
      const leaf = nodes[nodes.length - 1]
      return {
        marked,
        chipTag: leaf?.tagName ?? null,
        chipText: leaf ? (leaf.textContent || '').trim().slice(0, 160) : null,
        hasPickText: /Save changes|#save-btn/u.test(text),
        mentions: (text.match(/Save changes/gu) ?? []).length,
        paneTail: text.slice(-400),
      }
    })()`, { timeout: 10_000, label: 'pick chip' }).catch(() => null)
    const shot = await page.screenshot(join(OUT, '04-panel-pick-chip.png'))
    artifacts.screenshots.push(shot.path)
    if (chip === null) throw fail('panel pane disappeared while looking for the pick chip')
    if (chip.marked.length === 0 && chip.chipText === null && !chip.hasPickText) {
      throw fail('panel UI shows no pick chip for the descriptor', {
        evidence: { paneText: chip.paneTail, consoleErrors: consoleEvents.slice(-5) },
        repro: 'pick #save-btn, then read the panel body: it must list the pending pick',
      })
    }
    return {
      marked: chip.marked.length, chipTag: chip.chipTag, chipText: chip.chipText,
      mentions: chip.mentions, paneTail: chip.paneTail, shot: shot.path, shotBytes: shot.bytes,
    }
  })

  // -- C29 host probe -------------------------------------------------------
  await step('C29', 'probe reports hover geometry and the page cursor', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    await action('pickArm', { on: false })
    const layout = await fixture.waitFor((entry) => entry.type === 'ready' || entry.type === 'layout', 8_000).catch(() => null)
    if (!layout || !layout.saveRect || !layout.viewport) {
      throw fail('fixture published no layout for the probe', { evidence: { layout, events: fixture.events().map((entry) => entry.type) } })
    }
    const point = { x: layout.saveRect.x + layout.saveRect.w / 2, y: layout.saveRect.y + layout.saveRect.h / 2 }
    const hit = (await action('probe', point)).body?.result
    const miss = (await action('probe', { x: -50, y: -50 })).body?.result
    const near = (a, b) => Math.abs(a - b) <= 3
    const rectOk = Boolean(hit?.rect) && near(hit.rect.x, layout.saveRect.x) && near(hit.rect.w, layout.saveRect.w)
    if (!hit || hit.hit !== true || hit.tag !== 'button' || !rectOk) {
      throw fail(`probe at the fixture button returned ${JSON.stringify(hit)}`, {
        evidence: { point, saveRect: layout.saveRect, miss },
        repro: 'POST action probe at the fixture button centre with pick mode off',
      })
    }
    if (hit.cursor !== 'pointer') {
      throw fail(`probe does not mirror the page cursor (expected "pointer" for a button styled cursor:pointer, got ${JSON.stringify(hit.cursor)})`, { evidence: { hit } })
    }
    if (!miss || miss.hit !== false || miss.rect !== null) {
      throw fail(`probe outside the viewport must miss cleanly, got ${JSON.stringify(miss)}`, { evidence: { miss } })
    }
    return { point, hit: { tag: hit.tag, label: hit.label, cursor: hit.cursor, rect: hit.rect }, miss: { hit: miss.hit, rect: miss.rect } }
  })

  // -- C30 pointer feedback in the panel ------------------------------------
  await step('C30', 'panel mirror cursor and outline the hovered element', 'client', async () => {
    if (!passed('C19')) throw blocked('C19')
    if (!passed('C29')) throw blocked('C29')
    await action('pickArm', { on: false })
    const canvas = await page.rectOf('[data-dockkit-pane] canvas')
    if (canvas === null) throw fail('panel canvas is not visible; cannot hover the page')
    const layout = await fixture.waitFor((entry) => entry.type === 'ready' || entry.type === 'layout', 8_000).catch(() => null)
    if (!layout || !layout.saveRect || !layout.viewport) throw fail('fixture published no layout for the hover check', { evidence: { layout } })
    const viewport = layout.viewport
    const target = {
      x: canvas.x + (layout.saveRect.x + layout.saveRect.w / 2) * canvas.w / viewport.w,
      y: canvas.y + (layout.saveRect.y + layout.saveRect.h / 2) * canvas.h / viewport.h,
    }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(target.x), y: Math.round(target.y) })
    await sleep(140)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(target.x + 2), y: Math.round(target.y + 3) })
    const feedback = await page.waitFor(`(() => {
      const pane = document.querySelector('[data-dockkit-pane]')
      const canvas = pane?.querySelector('canvas')
      const dot = pane?.querySelector('[data-browser-panel-cursor]')
      const rect = pane?.querySelector('[data-browser-panel-hover]')
      if (!canvas || !dot || !rect) return null
      const r = rect.getBoundingClientRect()
      const d = dot.getBoundingClientRect()
      return {
        cursor: getComputedStyle(canvas).cursor,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        dot: { w: Math.round(d.width), h: Math.round(d.height), x: Math.round(d.x), y: Math.round(d.y) },
      }
    })()`, { timeout: 6_000, label: 'hover feedback' }).catch(() => null)
    const shot = await page.screenshot(join(OUT, '07-panel-hover-feedback.png'))
    artifacts.screenshots.push(shot.path)
    if (feedback === null) {
      throw fail('panel shows no pointer dot / hover outline while hovering the page', {
        evidence: { canvas, target, consoleErrors: consoleEvents.slice(-5) },
        repro: 'move the pointer over the panel canvas; expect [data-browser-panel-cursor] and [data-browser-panel-hover]',
      })
    }
    if (feedback.cursor !== 'pointer') {
      throw fail(`panel canvas cursor does not mirror the page cursor: ${JSON.stringify(feedback.cursor)}`, { evidence: { feedback, target } })
    }
    if (feedback.rect.w < 4 || feedback.rect.h < 4 || feedback.dot.w < 2) {
      throw fail('hover outline or pointer dot has no size', { evidence: { feedback } })
    }
    return { canvas, target, feedback, shot: shot.path, shotBytes: shot.bytes }
  })

  // -- C31 mention into the composer ----------------------------------------
  await step('C31', 'pick chip inserts an @browser mention into the composer', 'client', async () => {
    if (!passed('C22')) throw blocked('C22')
    const button = await page.rectOf('[data-dockkit-pane] [data-browser-panel-mention]')
    if (button === null) {
      throw fail('the pick chip has no mention button', {
        evidence: { paneTail: await page.evaluate(`(document.querySelector('[data-dockkit-pane]')?.innerText || '').slice(-300)`) },
        repro: 'pick an element and look for [data-browser-panel-mention] inside the chip',
      })
    }
    await page.mouseClick(button.cx, button.cy)
    const draft = await page.waitFor(`(() => {
      const input = document.querySelector('[data-composer-input]')
      if (!input) return null
      const text = typeof input.value === 'string' && input.value.length > 0 ? input.value : (input.innerText || input.textContent || '')
      return text && text.includes('@browser') ? { text: text.slice(0, 240) } : null
    })()`, { timeout: 6_000, label: 'composer mention' }).catch(() => null)
    const cleaned = await page.evaluate(`(() => {
      const input = document.querySelector('[data-composer-input]')
      if (!input) return false
      input.focus()
      if (typeof input.value === 'string') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        if (setter) setter.call(input, '')
        else input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        document.execCommand('selectAll')
        document.execCommand('delete')
      }
      return true
    })()`)
    if (draft === null) {
      throw fail('clicking the mention button did not put "@browser ..." into the composer', {
        evidence: { cleaned, consoleErrors: consoleEvents.slice(-5) },
        repro: 'pick an element, click the @ button on its chip, read [data-composer-input]',
      })
    }
    return { draft: draft.text, click: { x: button.cx, y: button.cy }, cleaned }
  })

  // -- C23 wheel through the panel UI --------------------------------------
  await step('C23', 'wheel over the panel canvas scrolls the browsed page', 'client', async () => {
    if (!passed('C19')) throw blocked('C19')
    if (!passed('C07')) throw blocked('C07')
    // Leave picking so a canvas click is forwarded as page input, not as a pick.
    await action('pickArm', { on: false })
    // Start from the top so the assertion is unambiguous.
    await action('wheel', { x: 400, y: 400, deltaX: 0, deltaY: -4000 })
    await sleep(300)
    const canvas = await page.rectOf('[data-dockkit-pane] canvas')
    if (canvas === null) throw fail('panel canvas is not visible; cannot drive the UI input path')
    fixture.reset()
    // One click gives the canvas pointer ownership; then a real wheel over it goes
    // through the Client's canvas handler -> POST action wheel -> Host -> page.
    await page.mouseClick(canvas.cx, canvas.cy)
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: canvas.cx, y: canvas.cy, deltaX: 0, deltaY: 420,
    })
    const scrolled = await fixture.waitFor((entry) => entry.type === 'scroll' && entry.y > 0, 6_000).catch(() => null)
    const shot = await page.screenshot(join(OUT, '05-panel-ui-wheel.png'))
    artifacts.screenshots.push(shot.path)
    if (scrolled === null) {
      throw fail(`wheel over the panel canvas did not scroll the page (fixture events: ${JSON.stringify(fixture.events().map((entry) => entry.type))})`, {
        evidence: {
          canvas,
          scrollEvents: fixture.events().filter((entry) => entry.type === 'scroll'),
          consoleErrors: consoleEvents.slice(-5),
        },
        repro: 'click once on the panel canvas for pointer ownership, then dispatch a CDP mouseWheel at the canvas centre',
      })
    }
    await action('wheel', { x: 400, y: 400, deltaX: 0, deltaY: -4000 })
    return { canvas, scrollY: scrolled.y, fixtureEvents: fixture.events().length, shot: shot.path, shotBytes: shot.bytes }
  })

  // -- C24 forced SSE disconnect -------------------------------------------
  await step('C24', 'panel surfaces a disconnect and resumes', 'client', async () => {
    if (!passed('C19')) throw blocked('C19')
    const readPanel = async () => page.evaluate(`(() => {
      const pane = document.querySelector('[data-dockkit-pane]')
      if (!pane) return null
      const text = pane.innerText || ''
      return {
        connected: /Connected/u.test(text),
        reconnecting: /(reconnect|connection lost|disconnected|offline|failed)/iu.test(text),
        tail: text.slice(-260),
      }
    })()`).catch(() => null)
    const before = await readPanel()
    if (before === null || before.connected !== true) {
      throw skipBecause('the mounted panel exposes no connected/disconnected status line to observe')
    }
    // Interrupt the page's network: the panel's SSE connection must fail and the
    // Client must render a non-connected state, then re-establish the stream.
    await page.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none',
    })
    let noticed = null
    const offlineDeadline = Date.now() + 6_000
    while (Date.now() < offlineDeadline) {
      const now = await readPanel()
      if (now !== null && (now.reconnecting || now.connected === false)) { noticed = now; break }
      await sleep(200)
    }
    await page.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi',
    })
    let resumed = null
    const onlineDeadline = Date.now() + 15_000
    while (Date.now() < onlineDeadline) {
      const now = await readPanel()
      if (now !== null && now.connected === true) { resumed = now; break }
      await sleep(300)
    }
    const shot = await page.screenshot(join(OUT, '06-panel-reconnect.png'))
    artifacts.screenshots.push(shot.path)
    if (noticed === null) {
      throw skipBecause('the panel did not surface a disconnect state within 6 s of the network going offline (no reconnect status rendered)')
    }
    if (resumed === null) {
      throw fail('panel did not return to the connected state after the network came back', {
        evidence: { before: before.tail, noticed: noticed.tail, consoleErrors: consoleEvents.slice(-6) },
        repro: 'CDP Network.emulateNetworkConditions offline ~2 s, then online; watch the panel status line and canvas',
      })
    }
    // The canvas must still paint after the stream resumed.
    const paint = await page.evaluate(`(() => {
      const canvas = document.querySelector('[data-dockkit-pane] canvas')
      if (!canvas) return null
      const context = canvas.getContext('2d')
      if (!context) return null
      let painted = 0, sampled = 0
      const colors = new Set()
      try {
        const w = canvas.width, h = canvas.height
        const stepX = Math.max(1, Math.floor(w / 16)), stepY = Math.max(1, Math.floor(h / 16))
        for (let y = 0; y < h; y += stepY) for (let x = 0; x < w; x += stepX) {
          const [r, g, b, a] = context.getImageData(x, y, 1, 1).data
          sampled += 1
          if (a > 0 && r + g + b > 0) painted += 1
          colors.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3))
        }
      } catch (error) { return { error: String(error) } }
      return { painted, sampled, distinctColors: colors.size, width: canvas.width, height: canvas.height }
    })()`).catch(() => null)
    if (paint === null || paint.painted === 0) {
      throw fail('panel canvas did not resume painting after the reconnect', { evidence: { paint, noticed: noticed.tail, resumed: resumed.tail } })
    }
    return {
      before: before.tail, noticed: noticed.tail, resumed: resumed.tail,
      canvasAfterReconnect: paint, shot: shot.path, shotBytes: shot.bytes,
    }
  })

  // -- C25 browser_pick_last tool (SKIP) ------------------------------------
  skip('C25', 'browser_pick_last agent tool', 'host', 'no supported way to invoke an agent tool from the harness: it would require a live LLM turn in the test Session (non-deterministic, minutes long). The HTTP `pick` path returning the same descriptor is covered by C15; per CONTRACT.md both call the same service method.')

  // -- C26 shutdown ---------------------------------------------------------
  await step('C26', 'POST action shutdown closes Session Chrome', 'host', async () => {
    if (!passed('C07')) throw blocked('C07')
    // Pending picks stay queued per Session and would re-inject on a later run.
    let picksCleared = null
    if (passed('C05')) {
      const cleared = await action('picksClear')
      picksCleared = cleared.body?.ok === true ? (cleared.body.result?.picks?.length ?? 0) : null
    }
    let response = await action('shutdown')
    if (response.status === 0) response = await serverAction('shutdown')
    if (response.status !== 200 || response.body?.ok !== true) {
      throw fail(`POST action shutdown -> ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`, { evidence: response, repro: "POST /browser-panel/action {action:'shutdown'}" })
    }
    return { status: response.status, result: response.body.result ?? null, picksRemainingAfterClear: picksCleared }
  })

  // -- C27 chrome cleanup ---------------------------------------------------
  await step('C27', 'no host Chrome process survives shutdown', 'host', async () => {
    if (!passed('C26')) throw blocked('C26')
    const group = ctx.hostChromeGroup
    if (typeof group !== 'number' || group <= 0) {
      throw skipBecause('could not attribute the Host Chrome process group (no own-user TCP socket to the fixture port was observable)')
    }
    const started = Date.now()
    let alive = []
    for (;;) {
      alive = listChromeProcesses().filter((process) => process.pid === group || process.pgid === group)
      if (alive.length === 0) break
      if (Date.now() - started > 8_000) break
      await sleep(300)
    }
    if (alive.length > 0) {
      throw fail(`${alive.length} process(es) of the Host Chrome group ${group} survived shutdown`, {
        evidence: { group, leftovers: alive.slice(0, 6).map((process) => ({ pid: process.pid, head: process.display.slice(0, 120) })) },
        repro: "POST action shutdown, then `ps -eo pid,pgid,args | grep <chrome pgid>`",
      })
    }
    return { hostChromeGroup: group, waitedMs: Date.now() - started, leftovers: 0 }
  })

  // -- C28 state after shutdown ---------------------------------------------
  await step('C28', 'state still answers after shutdown (chrome idle)', 'host', async () => {
    if (!passed('C05')) throw blocked('C05')
    if (!passed('C26')) throw blocked('C26')
    let response = await page.pageFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)
    if (response.status === 0) response = await serverFetch(`/browser-panel/state?sessionId=${encodeURIComponent(ctx.sessionId)}`)
    if (response.status !== 200) throw fail(`GET state after shutdown -> ${response.status}`, { evidence: response })
    const status = response.body?.chrome?.status
    if (status !== 'idle' && status !== 'error') {
      throw fail(`state after shutdown reports chrome.status=${JSON.stringify(status)} (expected idle)`, { evidence: response.body })
    }
    return { status: response.status, chromeStatus: status, tabs: response.body?.tabs?.length ?? null, picks: response.body?.picks?.length ?? null }
  })

  return finish(runId, build)
}

/** Write artifacts and return the exit code. */
async function finish(runId, build) {
  const durationMs = elapsed()
  let defectNumber = 0
  for (const check of checks) {
    if (check.status !== 'FAIL') continue
    defectNumber += 1
    defects.push({
      n: defectNumber,
      checkId: check.id,
      title: check.name,
      owner: check.owner,
      summary: check.error,
      repro: check.repro || check.name,
      evidence: check.evidence,
    })
  }
  const totals = {
    checks: checks.length,
    pass: checks.filter((check) => check.status === 'PASS').length,
    fail: checks.filter((check) => check.status === 'FAIL').length,
    skip: checks.filter((check) => check.status === 'SKIP').length,
  }
  const summary = {
    runId,
    startedAt: new Date(runStart).toISOString(),
    durationMs,
    origin: ORIGIN,
    build,
    environment: {
      node: process.version,
      chromePid: chrome?.pid ?? null,
      chromePort: chrome?.port ?? null,
      fixturePort: fixture?.port ?? null,
    },
    session: { id: ctx.sessionId, blank: ctx.sessionBlank, switched: ctx.sessionSwitched ?? false },
    diagnostics: {
      consoleEvents: consoleEvents.slice(-25),
      consoleEventCount: consoleEvents.length,
      panelMounts: ctx.panelMounts ?? null,
    },
    totals,
    checks,
    defects,
    artifacts,
  }
  const summaryPath = join(OUT, 'summary.json')
  await writeFile(summaryPath, JSON.stringify(summary, null, 2))
  artifacts.json.push(summaryPath)

  const lines = []
  lines.push(`browser-panel E2E run ${runId}`)
  lines.push(`duration ${durationMs}ms  origin ${ORIGIN}`)
  lines.push(`build: clientPlaceholder=${build.clientPlaceholder} hostPlaceholder=${build.hostPlaceholder}`)
  lines.push(`${totals.pass} PASS / ${totals.fail} FAIL / ${totals.skip} SKIP of ${totals.checks}`)
  lines.push('')
  for (const check of checks) {
    lines.push(`${check.status.padEnd(4)} ${check.id} ${check.name} (${check.ms}ms)${check.status === 'FAIL' ? ` [owner: ${check.owner}] ${check.error}` : check.status === 'SKIP' ? ` — ${check.reason}` : ''}`)
  }
  if (defects.length > 0) {
    lines.push('', 'DEFECTS')
    for (const defect of defects) {
      lines.push(`${defect.n}. [${defect.owner}] ${defect.title} (${defect.checkId}): ${defect.summary}`)
      lines.push(`   repro: ${defect.repro}`)
    }
  }
  lines.push('', `summary: ${summaryPath}`)
  const text = lines.join('\n')
  const textPath = join(OUT, 'last-run.txt')
  await writeFile(textPath, text)
  artifacts.json.push(textPath)
  console.log(`\n${text}`)
  return totals.fail === 0 ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  console.error('\n[fatal] harness crashed:', error)
  exitCode = 2
} finally {
  try { await fixture?.close() } catch { /* ignore */ }
  if (chrome !== null && KEEP_CHROME !== true) {
    try { await chrome.kill() } catch { /* ignore */ }
  } else if (chrome !== null) {
    console.log(`[keep] Chrome pid ${chrome.pid} userDataDir ${chrome.userDataDir}`)
  }
  process.exit(exitCode)
}