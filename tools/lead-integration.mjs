/**
 * Lead integration check for the browser panel — host-level, no GUI involved.
 *
 * Serves a fixture page, then drives the panel's real HTTP contract in the live
 * profile: ensure → openTab → SSE frames → mouse/wheel/text input → pick →
 * context injection in the Session log → shutdown.
 *
 * Usage: node tools/lead-integration.mjs [--session <id>] [--keep]
 * Exit code 0 only when every check passes.
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ORIGIN = process.env.DSH_GUI_ORIGIN ?? 'http://127.0.0.1:3080'
const SESSION = process.argv.includes('--session')
  ? process.argv[process.argv.indexOf('--session') + 1]
  : (process.env.DSH_SESSION_ID ?? 'lead-integration-session')
const KEEP = process.argv.includes('--keep')

const cookie = JSON.parse(execFileSync(process.execPath, ['tools/auth-cookie.mjs', '--json'], { encoding: 'utf8' }))
const COOKIE = `${cookie.name}=${cookie.value}`
const headers = { cookie: COOKIE, 'content-type': 'application/json' }
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

let tabId
let chromeUserDataDir
const reports = []
const waiters = new Map()
const waitFor = (type) => {
  const existing = reports.find((report) => report.type === type)
  if (existing !== undefined) return Promise.resolve(existing)
  return new Promise((resolve) => {
    const entry = { resolve: (value) => resolve(value) }
    waiters.set(type, entry)
    setTimeout(() => resolve(undefined), 5000)
  })
}

const fixture = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/report') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const report = JSON.parse(body)
        reports.push(report)
        const waiter = waiters.get(report.type)
        if (waiter !== undefined) { waiters.delete(report.type); waiter.resolve(report) }
      } catch { /* ignore malformed fixture reports */ }
      res.writeHead(204).end()
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>BP Fixture</title>
<style>body{font:14px system-ui;margin:0}header{height:80px;background:#eef}main{padding:16px}
button{font-size:16px;padding:8px 14px}ul{padding-left:20px}li{height:28px}</style></head><body>
<header><h1>Browser panel fixture</h1></header>
<main>
  <button id="save-btn" aria-label="Save changes">Save changes</button>
  <input id="name" name="name" placeholder="Your name">
  <p id="log"></p>
  <ul>${Array.from({ length: 60 }, (_, i) => `<li id="row-${i}">Row ${i}</li>`).join('')}</ul>
</main>
<script>
const send = (payload) => fetch('/report', { method: 'POST', body: JSON.stringify(payload) });
const rectOf = (id) => { const r = document.getElementById(id).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height }; };
const report = () => send({ type: 'rect', save: rectOf('save-btn'), input: rectOf('name'), viewport: { w: innerWidth, h: innerHeight }, title: document.title, scrollY });
addEventListener('load', () => { window.__clicks = 0; window.__values = []; report(); setInterval(report, 250); });
document.getElementById('save-btn').addEventListener('click', () => { window.__clicks += 1; send({ type: 'click', clicks: window.__clicks }); });
document.getElementById('name').addEventListener('input', (e) => { window.__values.push(e.target.value); send({ type: 'input', value: e.target.value }); });
addEventListener('keydown', (e) => send({ type: 'key', key: e.key, code: e.code }));
addEventListener('scroll', () => send({ type: 'scroll', y: scrollY }), { passive: true });
</script></body></html>`)
})

async function action(name, params = {}, extra = {}) {
  const response = await fetch(`${ORIGIN}/browser-panel/action`, {
    method: 'POST', headers,
    body: JSON.stringify({ sessionId: SESSION, tabId: extra.tabId ?? tabId, action: name, params }),
  })
  const json = await response.json().catch(() => ({ ok: false, code: 'bad-json', message: `HTTP ${response.status}` }))
  if (!json.ok) throw new Error(`${name}: ${json.code ?? json.message ?? 'failed'}`)
  return json.result
}

async function state() {
  const response = await fetch(`${ORIGIN}/browser-panel/state?sessionId=${encodeURIComponent(SESSION)}`, { headers })
  return response.json()
}

async function streamFrames(ms) {
  const controller = new AbortController()
  const response = await fetch(`${ORIGIN}/browser-panel/stream?sessionId=${encodeURIComponent(SESSION)}&tabId=${tabId}`, {
    headers: { cookie: COOKIE, accept: 'text/event-stream' }, signal: controller.signal,
  })
  const frames = []
  const statuses = []
  const viewport = { current: undefined }
  const picker = { current: undefined }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        let event = 'message'
        const dataLines = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length === 0) continue
        let data
        try { data = JSON.parse(dataLines.join('\n')) } catch { continue }
        if (event === 'frame') frames.push(data)
        else if (event === 'status') { statuses.push(data); if (data.tab?.viewport) viewport.current = data.tab.viewport }
        else if (event === 'hover') picker.current = data
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return { frames, statuses, viewport: viewport.current, hover: picker.current }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Latest rect report the fixture page sent. */
const latestRect = () => [...reports].reverse().find((report) => report.type === 'rect')

try {
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`

  const initial = await state()
  check('state-before', initial.ok === true && Array.isArray(initial.tabs), { chrome: initial.chrome?.status, tabs: initial.tabs?.length })

  const ensured = await action('ensure')
  check('ensure-launches-chrome', ensured.chrome?.status === 'ready', ensured.chrome)

  const opened = await action('openTab', { url: fixtureUrl, key: 'lead-panel-tab' })
  tabId = opened.tab?.tabId ?? opened.tabId
  check('openTab-returned-tab', Boolean(tabId), opened)

  // Repeated openTab for the same panel key must reuse the target (remount/StrictMode safety).
  const repeated = await action('openTab', { url: fixtureUrl, key: 'lead-panel-tab' })
  const repeatedId = repeated.tab?.tabId ?? repeated.tabId
  const afterRepeat = await state()
  check('openTab-idempotent-by-key', repeatedId === tabId && (afterRepeat.tabs?.length ?? 0) === 1,
    { tabId, repeatedId, tabs: afterRepeat.tabs?.length })

  const rectReport = await waitFor('rect')
  check('fixture-loaded', rectReport?.title === 'BP Fixture', rectReport && { viewport: rectReport.viewport })

  const stream = await streamFrames(6000)
  const jpeg = stream.frames.find((frame) => Buffer.from(frame.data ?? '', 'base64').subarray(0, 2).toString('hex') === 'ffd8')
  check('sse-frames', stream.frames.length >= 3, { frames: stream.frames.length, firstBytes: jpeg ? 'ffd8' : null })
  check('sse-viewport', Number(stream.viewport?.width) >= 300 && Number(stream.viewport?.height) >= 200, stream.viewport)
  check('sse-status', stream.statuses.length >= 1, { statuses: stream.statuses.length })

  const viewport = stream.viewport ?? rectReport?.viewport ?? { width: 1280, height: 800 }
  const frameW = stream.frames.at(-1)?.w ?? viewport.width
  const frameH = stream.frames.at(-1)?.h ?? viewport.height
  const toCss = (point) => ({
    x: point.x * viewport.width / frameW,
    y: point.y * viewport.height / frameH,
  })
  const button = toCss({ x: rectReport.save.x + rectReport.save.w / 2, y: rectReport.save.y + rectReport.save.h / 2 })
  const input = toCss({ x: rectReport.input.x + rectReport.input.w / 2, y: rectReport.input.y + rectReport.input.h / 2 })

  // Mouse click
  await action('mouse', { type: 'move', x: button.x, y: button.y })
  await action('mouse', { type: 'down', x: button.x, y: button.y, button: 'left', clickCount: 1 })
  await action('mouse', { type: 'up', x: button.x, y: button.y, button: 'left', clickCount: 1 })
  const click = await waitFor('click')
  check('mouse-click-reaches-page', click?.clicks >= 1, click)

  // Text input: focus the field (its position moved with the scroll), then type
  const fresh = latestRect()
  const freshInput = toCss({
    x: fresh.input.x + fresh.input.w / 2,
    y: fresh.input.y + fresh.input.h / 2,
  })
  await action('mouse', { type: 'down', x: freshInput.x, y: freshInput.y, button: 'left', clickCount: 1 })
  await action('mouse', { type: 'up', x: freshInput.x, y: freshInput.y, button: 'left', clickCount: 1 })
  await action('text', { text: 'hello panel' })
  const typed = await waitFor('input')
  check('text-reaches-page', typed?.value === 'hello panel', typed)

  // Pick
  await action('pickArm', { on: true })
  const hover = await action('pickHover', { x: button.x, y: button.y })
  check('pickHover-highlights', Boolean(hover.rect) && hover.rect.w > 10, hover)
  const picked = await action('pick', { x: button.x, y: button.y })
  // Wheel scroll
  await action('wheel', { x: button.x, y: button.y, deltaX: 0, deltaY: 420 })
  const scroll = await waitFor('scroll')
  check('wheel-scrolls-page', (scroll?.y ?? 0) > 0, scroll)

  const descriptor = picked.pick
  check('pick-descriptor', Boolean(descriptor?.selector) && descriptor.tag === 'button' && descriptor.id === 'save-btn',
    descriptor && { selector: descriptor.selector, tag: descriptor.tag, id: descriptor.id, text: descriptor.text, rect: descriptor.rect })
  check('pick-context-text', typeof descriptor?.contextText === 'string'
    && descriptor.contextText.startsWith('Picked browser element (user selection from the browser panel)'),
  descriptor && descriptor.contextText?.slice(0, 120))

  // The pick must be visible in state and injected into the session log.
  const afterPick = await state()
  check('state-lists-pick', Array.isArray(afterPick.picks) && afterPick.picks.length >= 1, afterPick.picks?.length)

  await sleep(1500)
  const sessionDir = process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions')
  let logged = 'no-session-log'
  try {
    const sessionName = SESSION.startsWith('session-') ? SESSION : `session-${SESSION}`
    // Session ids are unique across workspaces: find the log under any workspace.
    const path = readdirSync(sessionDir)
      .map((workspace) => join(sessionDir, workspace, sessionName, 'session.v4.jsonl.zstd'))
      .find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile())
    if (path !== undefined) {
      const size = statSync(path).size
      const text = execFileSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
      logged = text.includes('Picked browser element') ? 'found' : `missing in ${size} bytes`
    }
  } catch (error) {
    logged = `check-failed: ${error.message}`
  }
  check('pick-injected-into-session-log', logged === 'found', logged)

  await action('picksClear')
  // Shutdown
  await action('shutdown')
  await sleep(1200)
  const after = await state()
  check('shutdown-idles-chrome', after.chrome?.status === 'idle', after.chrome)
} catch (error) {
  check('run', false, error.message)
} finally {
  if (!KEEP) await action('shutdown').catch(() => {})
  fixture.close()
}

const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length === 0 ? '' : ` — failed: ${failed.map((entry) => entry.name).join(', ')}`}`)
process.exit(failed.length === 0 ? 0 : 1)