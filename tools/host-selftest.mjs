#!/usr/bin/env node
/**
 * Standalone self-test for the browser panel Host half.
 *
 * No DSH runtime is needed: this script launches a real Chrome, serves a local
 * fixture page over http, drives the CDP layer directly (phase A), then hosts
 * `createBrowserPanelHost` behind a minimal stub Cordis context + node http
 * server and exercises the CONTRACT.md transport end to end (phase B).
 *
 * Run:  node tools/host-selftest.mjs
 * Exit: 0 when every check passes, 1 otherwise.
 */

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Browser,
  NavRejectedError,
  buildContextText,
  findChrome,
  jpegSize,
  normalizePanelUrl,
} from '../host/browser.js'
import { BROWSER_TOOL_NAMES } from '../host/tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PANEL_ROOT = join(__dirname, '..')

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

const results = []
const cleanups = []

function record(name, passed, detail, ms) {
  results.push({ name, passed, detail, ms })
  const tag = passed ? 'PASS' : 'FAIL'
  const timing = Number.isFinite(ms) ? ` (${Math.round(ms)} ms)` : ''
  console.log(`${tag}  ${name}${timing}  ${detail}`)
}

async function check(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    record(name, true, detail ?? '', Date.now() - started)
    return true
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err), Date.now() - started)
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pgrep(pattern) {
  return new Promise((resolve) => {
    execFile('pgrep', ['-fa', pattern], (err, stdout) => {
      if (err && err.code === 1) return resolve(0)
      if (err) return resolve(-1)
      resolve(String(stdout).split('\n').filter(Boolean).length)
    })
  })
}

async function waitUntil(predicate, timeoutMs, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

// ---------------------------------------------------------------------------
// Fixture page + server
// ---------------------------------------------------------------------------

const FIXTURE_ROWS = Array.from({ length: 60 }, (_, index) =>
  `<div class="row" id="row-${index + 1}">Row ${index + 1} — the quick brown fox jumps over the lazy dog</div>`).join('\n')

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>panel-fixture</title>
<style>
  html, body { margin: 0; padding: 0; font: 14px/1.4 system-ui, sans-serif; color: #111; background: #fff; }
  #save-btn { position: absolute; left: 120px; top: 180px; width: 120px; height: 40px;
    background: #1f6feb; color: #fff; border: 0; border-radius: 6px; font: inherit; }
  #name { position: absolute; left: 40px; top: 260px; width: 300px; height: 36px;
    border: 1px solid #999; border-radius: 4px; padding: 0 8px; font: inherit; }
  #rows { position: absolute; top: 340px; left: 0; right: 0; }
  .row { height: 40px; border-bottom: 1px solid #e5e5e5; padding: 0 12px; line-height: 40px; }
</style>
</head>
<body>
<button id="save-btn" class="btn btn-primary" type="button" aria-label="Save">Save changes</button>
<input id="name" type="text" placeholder="Your name" aria-label="Name">
<div id="rows">
${FIXTURE_ROWS}
</div>
<script>
  window.__clicks = 0;
  window.__typed = '';
  window.__clickTargets = [];
  document.getElementById('save-btn').addEventListener('click', function () {
    window.__clicks += 1;
    window.__clickTargets.push('save-btn');
    document.title = 'clicked:' + window.__clicks;
  });
  var input = document.getElementById('name');
  input.addEventListener('input', function () {
    window.__typed = input.value;
    document.title = 'typed:' + input.value;
  });
  window.addEventListener('scroll', function () {
    document.title = 'scroll:' + Math.round(window.scrollY);
  });
</script>
</body>
</html>`

async function startFixtureServer() {
  const server = createServer((req, res) => {
    const path = new URL(String(req.url ?? '/'), 'http://localhost').pathname
    if (path === '/fixture' || path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(FIXTURE_HTML)
      return
    }
    if (path === '/blank') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>blank</title><p>blank page</p>')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    fixtureUrl: `${origin}/fixture`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// ---------------------------------------------------------------------------
// Phase A — the ctx-independent CDP layer
// ---------------------------------------------------------------------------

async function phaseA(fixture) {
  console.log('\n--- Phase A: Chrome + CDP layer (standalone) ---')
  let browser = null
  const chromeBaseline = await pgrep('dsh-chrome-')

  await check('A1 chrome-binary', () => {
    const bin = findChrome()
    assert(bin.length > 0, 'no chrome binary resolved')
    return bin
  })

  const launchedAt = Date.now()
  const firstFrame = { at: null, frame: null }
  const frames = []
  let offFrames = () => {}

  const launched = await check('A2 chrome-launch-first-frame', async () => {
    browser = await Browser.launch({
      executablePath: findChrome(),
      headless: true,
      width: 1280,
      height: 800,
      quality: 55,
      maxWidth: 1280,
      maxHeight: 800,
      fps: 20,
      readyTimeoutMs: 30_000,
    })
    cleanups.push(() => browser?.dispose())
    const tab = await browser.ensureTab('about:blank')
    offFrames = tab.subscribeFrames((frame) => {
      if (firstFrame.at === null) firstFrame.at = Date.now()
      frames.push(frame)
    })
    const got = await waitUntil(() => (firstFrame.at !== null ? frames[0] : null), 8000)
    assert(got !== null, 'no screencast frame within 8s of launch')
    const image = jpegSize(Buffer.from(got.data, 'base64'))
    assert(image !== null, 'first frame is not a JPEG')
    assert(image.width > 0 && image.height > 0, 'first frame has no pixel size')
    const latency = firstFrame.at - launchedAt
    firstFrame.frame = got
    return `ready in ${browser.chrome.readyMs} ms, first frame after ${latency} ms (${image.width}x${image.height} jpeg, ${Math.round(got.data.length * 0.75 / 1024)} KiB), viewport ${got.viewport.width}x${got.viewport.height}`
  })
  if (!launched || browser === null) return

  const tab = browser.activeTab()

  await check('A3 screencast-ack-and-keepalive', async () => {
    // A static page: screencast delivers only damage frames, so the additive
    // screenshot keepalive must keep frames coming. Broken acks would stall the
    // screencast after the first frame.
    await waitUntil(() => frames.length >= 2, 4000)
    const real = frames.filter((frame) => frame.keepalive !== true)
    const keepalive = frames.filter((frame) => frame.keepalive === true)
    assert(real.length >= 1, `expected at least one real screencast frame, got ${real.length}`)
    const gotKeepalive = await waitUntil(() => frames.some((frame) => frame.keepalive === true), 3000)
    assert(gotKeepalive, 'no keepalive frame on a static page')
    assert(offFrames !== null, 'frame subscription missing')
    return `${frames.length} frames (${real.length} screencast, ${keepalive.length} keepalive)`
  })

  await check('A4 viewport-consistency', async () => {
    const inner = await tab.evaluate('({ width: window.innerWidth, height: window.innerHeight })')
    assert(inner.width === tab.viewport.width && inner.height === tab.viewport.height,
      `tab viewport ${tab.viewport.width}x${tab.viewport.height} != innerWidth/innerHeight ${inner.width}x${inner.height}`)
    const newest = frames[frames.length - 1]
    assert(newest.viewport.width === tab.viewport.width, 'frame viewport width drifted from the tab viewport')
    const image = jpegSize(Buffer.from(newest.data, 'base64'))
    assert(Math.abs(image.width - tab.viewport.width) <= 2,
      `frame image ${image.width}px != CSS viewport ${tab.viewport.width}px at maxWidth 1280`)
    assert(tab.viewport.width >= 600 && tab.viewport.height >= 400, 'viewport below the contract minimum')
    return `viewport ${tab.viewport.width}x${tab.viewport.height}, frame image ${image.width}x${image.height}`
  })

  let pickPage = null
  await check('A5 click-lands-and-mapping', async () => {
    await tab.navigate(fixture.fixtureUrl)
    await waitUntil(async () => (await tab.evaluate('document.readyState')) === 'complete', 5000)
    const point = await tab.evaluate(`(function () {
      var el = document.getElementById('save-btn');
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height };
    })()`)
    assert(point !== null, 'save button not found in the fixture page')
    assert(point.x >= 179 && point.x <= 181 && point.y >= 199 && point.y <= 201,
      `fixture button centre moved to ${point.x},${point.y}`)
    await tab.clickAt(point.x, point.y)
    const clicked = await waitUntil(async () => (await tab.evaluate('window.__clicks')) >= 1, 3000)
    assert(clicked, 'mouse click did not reach the fixture button')
    // Negative control: a click far away must not reach the button.
    await tab.clickAt(point.x + 300, point.y + 120)
    await sleep(120)
    const clicks = await tab.evaluate('window.__clicks')
    assert(clicks === 1, `negative-control click also hit the button (clicks=${clicks})`)
    pickPage = point
    return `click landed at CSS ${Math.round(point.x)},${Math.round(point.y)} (${point.w}x${point.h}); control click missed`
  })

  await check('A6 typing-insertText', async () => {
    const inputPoint = await tab.evaluate(`(function () {
      var el = document.getElementById('name');
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`)
    await tab.clickAt(inputPoint.x, inputPoint.y)
    await tab.insertText('hello panel')
    const value = await waitUntil(async () => (await tab.evaluate('document.activeElement && document.activeElement.id')) === 'name'
      ? tab.evaluate('document.getElementById("name").value')
      : null, 2000)
    assert(value === 'hello panel', `input value is ${JSON.stringify(value)}`)
    return `value ${JSON.stringify(value)}`
  })

  await check('A7 pick-descriptor-roundtrip', async () => {
    assert(pickPage !== null, 'no page point from A5')
    const pick = await tab.pickAt(pickPage.x, pickPage.y, { sessionId: 'selftest' })
    assert(pick.tag === 'button', `pick tag ${pick.tag} != button`)
    assert(pick.id === 'save-btn', `pick id ${pick.id} != save-btn`)
    assert(pick.selector === '#save-btn', `pick selector ${JSON.stringify(pick.selector)} != "#save-btn"`)
    assert(pick.rect.w > 100 && pick.rect.h > 30, `pick rect looks wrong: ${JSON.stringify(pick.rect)}`)
    assert(pick.accessibleName.length > 0, 'pick has no accessible name')
    assert(pick.contextText.startsWith('Picked browser element (user selection from the browser panel)\n'),
      'contextText does not start with the contract first line')
    assert(pick.contextText.includes('selector: #save-btn'), 'contextText lacks the selector line')
    assert(/^box: -?\d+(\.\d+)?,-?\d+(\.\d+)? \d+(\.\d+)?×\d+(\.\d+)?$/m.test(pick.contextText), 'contextText box line malformed')
    const roundTrip = await tab.evaluate(`(function (sel) {
      var el = document.querySelector(sel);
      return el ? { tag: el.tagName.toLowerCase(), id: el.id || '', count: document.querySelectorAll(sel).length } : null;
    })(${JSON.stringify(pick.selector)})`)
    assert(roundTrip !== null && roundTrip.tag === 'button' && roundTrip.id === 'save-btn' && roundTrip.count === 1,
      `selector round-trip failed: ${JSON.stringify(roundTrip)}`)
    return `selector #save-btn, rect ${JSON.stringify(pick.rect)}, text ${JSON.stringify(pick.text.slice(0, 24))}, contextText ${pick.contextText.length} chars / 8 lines`
  })

  await check('A8 pick-failed-outside-viewport', async () => {
    let error = null
    try {
      await tab.pickAt(-50, -50)
    } catch (err) {
      error = err
    }
    assert(error !== null, 'pick outside the viewport did not fail')
    assert(error.code === 'pick-failed', `pick error code ${error.code} != pick-failed`)
    return `${error.name}: ${error.message}`
  })

  await check('A9 resize-and-mapping', async () => {
    const viewport = await tab.resize(900, 600)
    assert(viewport.width >= 884 && viewport.width <= 900, `resized viewport width ${viewport.width} is off`)
    // The override changes screencast metadata; wait for a frame that reflects it.
    const updated = await waitUntil(() => frames.some((frame) => Math.abs(frame.viewport.width - viewport.width) <= 1), 4000)
    assert(updated, 'no frame carried the resized viewport metadata')
    const pick = await tab.pickAt(180, 200)
    assert(pick.selector === '#save-btn', `pick after resize resolved ${JSON.stringify(pick.selector)}`)
    return `viewport ${viewport.width}x${viewport.height}; pick after resize still resolved #save-btn`
  })

  await check('A10 second-tab-lifecycle', async () => {
    const before = browser.rows().length
    const second = await browser.createTab(fixture.origin + '/blank')
    await waitUntil(async () => (await second.evaluate('document.readyState')) === 'complete', 5000)
    const rowsWithSecond = browser.rows()
    assert(rowsWithSecond.length === before + 1, `tab count ${rowsWithSecond.length} != ${before + 1}`)
    assert(second.tabId !== tab.tabId, 'second tab reused the first tab id')
    await browser.closeTab(second.tabId)
    const rowsAfter = browser.rows()
    assert(rowsAfter.length === before, `tab count after close ${rowsAfter.length} != ${before}`)
    assert(rowsAfter.some((row) => row.tabId === tab.tabId), 'first tab vanished when the second closed')
    const alive = await tab.evaluate('document.title')
    assert(typeof alive === 'string', 'first tab stopped answering after the second tab closed')
    return `${before} -> ${before + 1} -> ${before} tabs; first tab still answers (${JSON.stringify(alive)})`
  })

  await check('A11 screenshot', async () => {
    const shot = await tab.screenshot({ format: 'jpeg' })
    assert(shot.dataUrl.startsWith('data:image/jpeg;base64,'), 'screenshot dataUrl has the wrong prefix')
    const buffer = Buffer.from(shot.base64, 'base64')
    assert(buffer.length > 1000, `screenshot is suspiciously small (${buffer.length} bytes)`)
    const image = jpegSize(buffer)
    assert(image !== null && image.width === tab.viewport.width, `screenshot ${image?.width}px wide vs viewport ${tab.viewport.width}px`)
    return `${buffer.length} bytes, ${image.width}x${image.height}`
  })

  await check('A12 url-policy', () => {
    for (const rejected of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings']) {
      let error = null
      try { normalizePanelUrl(rejected) } catch (err) { error = err }
      assert(error instanceof NavRejectedError, `${rejected} was not rejected`)
      assert(error.code === 'nav-rejected', `${rejected} rejection code ${error.code}`)
    }
    assert(normalizePanelUrl('example.com') === 'https://example.com/', 'bare host was not upgraded to https')
    assert(normalizePanelUrl('about:blank') === 'about:blank', 'about:blank was not allowed')
    return 'file:/javascript:/data:/chrome: rejected as nav-rejected; bare host -> https; about:blank allowed'
  })

  await check('A13 contextText-format', () => {
    const synthetic = {
      pickId: 'p-test', sessionId: 's', tabId: 't1',
      url: 'https://example.com/form', pageTitle: 'Example',
      selector: '#save.btn-primary',
      tag: 'button', id: 'save', classes: ['btn', 'btn-primary'],
      role: 'button', accessibleName: 'Save changes', text: 'Save changes',
      rect: { x: 812, y: 421, w: 96, h: 36 },
      attrs: {}, ancestors: [
        { tag: 'div', id: '', classes: ['actions'] },
        { tag: 'form', id: '', classes: ['card'] },
        { tag: 'main', id: '', classes: [] },
      ],
      outerHTML: '<button id="save" class="btn btn-primary" type="submit">Save changes</button>',
      ts: Date.now(),
    }
    synthetic.contextText = buildContextText(synthetic)
    const expected = [
      'Picked browser element (user selection from the browser panel)',
      'page: Example — https://example.com/form',
      'selector: #save.btn-primary',
      'element: <button id="save" class="btn btn-primary" role="button" name="Save changes">',
      'text: "Save changes"',
      'box: 812,421 96×36',
      'path: main > form.card > div.actions > button#save.btn.btn-primary',
      'html: <button id="save" class="btn btn-primary" type="submit">Save changes</button>',
    ].join('\n')
    assert(synthetic.contextText === expected, `contextText mismatch:\n--- got ---\n${synthetic.contextText}\n--- want ---\n${expected}`)
    return 'all 8 contract lines match exactly'
  })

  await check('A14 no-orphans-after-dispose', async () => {
    const userDataDir = browser.chrome.userDataDir
    assert(typeof userDataDir === 'string' && userDataDir.includes('dsh-chrome-'), 'unexpected Chrome user-data-dir')
    if (offFrames !== null) { try { offFrames() } catch { /* ignore */ } offFrames = null }
    await browser.dispose()
    browser = null
    await sleep(300)
    const matching = await pgrep(userDataDir)
    assert(matching === 0, `${matching} Chrome process(es) still match ${userDataDir}`)
    const baseline = await pgrep('dsh-chrome-')
    assert(baseline <= chromeBaseline, `Chrome process count ${baseline} exceeds baseline ${chromeBaseline}`)
    return `process group gone; dsh-chrome-* count back to ${baseline} (baseline ${chromeBaseline})`
  })
}

// ---------------------------------------------------------------------------
// Phase B — the panel transport behind a stub Cordis context
// ---------------------------------------------------------------------------

function createStubContext() {
  const routes = new Map()
  const tools = new Map()
  const injected = []
  const sessionId = 'selftest-session'
  const agent = {
    id: sessionId,
    session: { id: sessionId },
    ctx: {
      effect: (fn) => {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    },
    inject: (message) => { injected.push(message) },
  }
  const ctx = {
    logger: {
      warn: (message) => console.log(`  [warn] ${typeof message === 'string' ? message : (message?.message ?? message)}`),
      error: (message) => console.log(`  [error] ${typeof message === 'string' ? message : (message?.message ?? message)}`),
    },
    webServer: {
      register: (route) => {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: { requestRejection: () => undefined },
    tools: {
      register: (definition) => {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    agents: { get: (id) => (id === sessionId ? agent : undefined) },
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, routes, tools, injected, sessionId, agent }
}

async function startRouteServer(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(String(req.url ?? '/'), 'http://localhost').pathname
    const route = routes.get(pathname)
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch((err) => {
        if (!res.headersSent) { res.statusCode = 500; res.end(String(err)) } else res.destroy()
      })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

async function postAction(origin, payload) {
  const res = await fetch(`${origin}/browser-panel/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await res.json()
  return { status: res.status, ...json }
}

async function getState(origin, sessionId) {
  const res = await fetch(`${origin}/browser-panel/state?sessionId=${encodeURIComponent(sessionId)}`)
  const json = await res.json()
  return { status: res.status, ...json }
}

/** Minimal SSE client on global fetch: collects parsed events. */
async function openSse(url) {
  const controller = new AbortController()
  const response = await fetch(url, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  const events = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary < 0) break
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseSseBlock(raw)
          if (parsed !== null) events.push(parsed)
        }
      }
    } catch {
      // Aborted by close(); expected.
    }
  })()
  return {
    contentType: String(response.headers.get('content-type') ?? ''),
    events,
    async waitFor(predicate, timeoutMs) {
      return (await waitUntil(() => predicate(events), timeoutMs)) ? true : false
    },
    close() {
      controller.abort()
      return pump.catch(() => {})
    },
  }
}

function parseSseBlock(raw) {
  let event = 'message'
  const dataLines = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  let data = null
  try { data = JSON.parse(dataLines.join('\n')) } catch { return null }
  return { event, data }
}

async function phaseB(fixture) {
  console.log('\n--- Phase B: panel transport, picker, tools (stub ctx) ---')
  const stub = createStubContext()
  const chromeBaseline = await pgrep('dsh-chrome-')
  const { createBrowserPanelHost } = await import('../host/panel.js')
  const host = createBrowserPanelHost(stub.ctx, {
    chromeExecutable: findChrome(),
    headless: true,
    maxTabs: 4,
    quality: 55,
    maxWidth: 1280,
    maxHeight: 800,
    fps: 20,
    idleChromeMs: 0,
    launchTimeoutMs: 30_000,
  })
  cleanups.push(() => host.dispose())

  // The host registers routes with the stub web server; serve them over http.
  const server = await startRouteServer(stub.routes)
  cleanups.push(() => server.close())
  const { origin, sessionId } = { origin: server.origin, sessionId: stub.sessionId }
  let sse = null

  await check('B1 state-is-cheap-and-idle', async () => {
    const state = await getState(origin, sessionId)
    assert(state.status === 200 && state.ok === true, `state failed: ${JSON.stringify(state)}`)
    assert(state.chrome.status === 'idle', `chrome status ${state.chrome.status} != idle before panel open`)
    assert(Array.isArray(state.tabs) && state.tabs.length === 0, 'idle state should have no tabs')
    assert(Array.isArray(state.picks) && state.picks.length === 0, 'idle state should have no picks')
    const chromeCount = await pgrep('dsh-chrome-')
    assert(chromeCount <= chromeBaseline, `state launched Chrome (count ${chromeCount} > baseline ${chromeBaseline})`)
    return `ok, chrome idle, tabs [], picks [] and no Chrome spawned by state`
  })

  let chromeDir = null
  await check('B2 action-ensure', async () => {
    const response = await postAction(origin, { sessionId, action: 'ensure', params: {} })
    assert(response.status === 200 && response.ok === true, `ensure failed: ${JSON.stringify(response)}`)
    assert(response.result.chrome.status === 'ready', `chrome status ${response.result.chrome.status} != ready`)
    chromeDir = host.service.chromeUserDataDir(sessionId)
    assert(typeof chromeDir === 'string' && chromeDir.includes('dsh-chrome-'), 'panel did not own a Chrome user-data-dir')
    return `chrome ${response.result.chrome.status} (headless=${response.result.chrome.headless}, dir=${chromeDir})`
  })

  let tabId = null
  await check('B3 action-openTab', async () => {
    const response = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl } })
    assert(response.ok === true, `openTab failed: ${JSON.stringify(response)}`)
    assert(typeof response.result.tab.tabId === 'string', 'openTab returned no tabId')
    tabId = response.result.tab.tabId
    return `tab ${tabId} at ${response.result.tab.url}`
  })

  await check('B3b openTab-key-idempotent', async () => {
    // A panel body may mount more than once; the Sidebar occurrence key must
    // resolve to the same Chrome target instead of accumulating tabs to the limit.
    const first = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl, key: 'panel-k1' } })
    assert(first.ok === true, `keyed openTab failed: ${JSON.stringify(first)}`)
    const keyedTabId = first.result.tab.tabId
    assert(keyedTabId !== tabId, 'keyed openTab did not create a target for a new key')
    const stateAfterFirst = await getState(origin, sessionId)
    assert(stateAfterFirst.tabs.length === 2, `expected 2 tabs after first keyed open, got ${stateAfterFirst.tabs.length}`)
    const repeat = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl, key: 'panel-k1' } })
    assert(repeat.ok === true, `repeated keyed openTab failed: ${JSON.stringify(repeat)}`)
    assert(repeat.result.tab.tabId === keyedTabId, `repeated key ${repeat.result.tab.tabId} != first ${keyedTabId}`)
    const stateAfterRepeat = await getState(origin, sessionId)
    assert(stateAfterRepeat.tabs.length === 2, `repeated keyed openTab created another tab (${stateAfterRepeat.tabs.length})`)
    const moved = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.origin + '/blank', key: 'panel-k1' } })
    assert(moved.ok === true, `keyed openTab with a new URL failed: ${JSON.stringify(moved)}`)
    assert(moved.result.tab.tabId === keyedTabId, 'keyed openTab with a new URL created a target')
    assert(moved.result.tab.url.endsWith('/blank'), `keyed tab did not navigate (${moved.result.tab.url})`)
    // Put the keyed tab back on the fixture for the rest of the flow.
    const back = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl, key: 'panel-k1' } })
    assert(back.ok === true && back.result.tab.url === fixture.fixtureUrl, `keyed tab did not navigate back (${back.result?.tab?.url})`)

    // closeTab clears the mapping: the same key must build a fresh target.
    const closed = await postAction(origin, { sessionId, tabId: keyedTabId, action: 'closeTab', params: {} })
    assert(closed.ok === true, `closing the keyed tab failed: ${JSON.stringify(closed)}`)
    const afterClose = await getState(origin, sessionId)
    assert(afterClose.tabs.length === 1, `expected 1 tab after close, got ${afterClose.tabs.length}`)
    const recreated = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl, key: 'panel-k1' } })
    assert(recreated.ok === true, `re-open after close failed: ${JSON.stringify(recreated)}`)
    assert(recreated.result.tab.tabId !== keyedTabId, 'the closed (cleared) key returned the closed tab')
    const cleanup = await postAction(origin, { sessionId, tabId: recreated.result.tab.tabId, action: 'closeTab', params: {} })
    assert(cleanup.ok === true, `cleanup close failed: ${JSON.stringify(cleanup)}`)

    // Without a key the historical behaviour stands: a new target every call.
    const unkeyed = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl } })
    assert(unkeyed.ok === true, `unkeyed openTab failed: ${JSON.stringify(unkeyed)}`)
    assert(unkeyed.result.tab.tabId !== tabId, 'unkeyed openTab reused the previous target')
    const unkeyedClosed = await postAction(origin, { sessionId, tabId: unkeyed.result.tab.tabId, action: 'closeTab', params: {} })
    assert(unkeyedClosed.ok === true, 'unkeyed cleanup close failed')
    const finalState = await getState(origin, sessionId)
    assert(finalState.tabs.length === 1 && finalState.tabs[0].tabId === tabId, `tab accounting drifted: ${JSON.stringify(finalState.tabs.map((tab) => tab.tabId))}`)
    return `key panel-k1: ${keyedTabId} reused across 4 calls (url nav included); cleared on close; unkeyed still creates`
  })

  await check('B4 stream-frames', async () => {
    sse = await openSse(`${origin}/browser-panel/stream?sessionId=${encodeURIComponent(sessionId)}&tabId=${encodeURIComponent(tabId)}`)
    assert(sse.contentType.startsWith('text/event-stream'), `SSE content-type ${sse.contentType}`)
    const gotFrames = await sse.waitFor(
      (events) => events.filter((event) => event.event === 'frame').length >= 3,
      10_000,
    )
    assert(gotFrames, `expected >=3 frames in 10s, got ${sse.events.filter((event) => event.event === 'frame').length}`)
    const frames = sse.events.filter((event) => event.event === 'frame').map((event) => event.data)
    for (const frame of frames) {
      assert(Number.isFinite(frame.seq) && frame.w > 0 && frame.h > 0, `frame missing seq/w/h: ${JSON.stringify(Object.keys(frame))}`)
      const bytes = Buffer.from(frame.data, 'base64')
      assert(bytes[0] === 0xff && bytes[1] === 0xd8, 'frame data is not a JPEG')
      assert(frame.viewport && frame.viewport.width >= 600 && frame.viewport.height >= 400,
        `frame viewport below 600x400: ${JSON.stringify(frame.viewport)}`)
    }
    const first = frames[0]
    const image = jpegSize(Buffer.from(first.data, 'base64'))
    assert(image !== null && image.width === first.w && image.height === first.h,
      'frame w/h do not match the JPEG bytes')
    return `${frames.length} JPEG frames, first seq=${first.seq} ${first.w}x${first.h} px / viewport ${first.viewport.width}x${first.viewport.height}`
  })

  await check('B5 stream-status', async () => {
    assert(sse !== null, 'no stream from B4')
    const gotStatus = await sse.waitFor((events) => events.some((event) => event.event === 'status'), 3000)
    assert(gotStatus, 'no status event on the stream')
    const statuses = sse.events.filter((event) => event.event === 'status').map((event) => event.data)
    const latest = statuses[statuses.length - 1]
    assert(latest.chrome.status === 'ready', `status chrome ${latest.chrome.status}`)
    assert(latest.tab !== null && latest.tab.tabId === tabId, `status tab ${JSON.stringify(latest.tab)}`)
    return `status chrome=${latest.chrome.status} tab=${latest.tab.tabId} viewport=${latest.tab.viewport.width}x${latest.tab.viewport.height} pickMode=${latest.pickMode}`
  })

  await check('B6 action-mouse-click-lands', async () => {
    for (const type of ['down', 'up']) {
      const response = await postAction(origin, { sessionId, tabId, action: 'mouse', params: { type, x: 180, y: 200, button: 'left', clickCount: 1 } })
      assert(response.ok === true, `mouse ${type} failed: ${JSON.stringify(response)}`)
    }
    const clicked = await waitUntil(async () => {
      const state = await getState(origin, sessionId)
      return String(state.tabs[0]?.title ?? '').startsWith('clicked:1') ? state.tabs[0].title : null
    }, 4000)
    assert(clicked !== null, 'the fixture button did not receive the forwarded click (title never became clicked:1)')
    return `forwarded CSS(180,200) click -> page title ${JSON.stringify(clicked)}`
  })

  await check('B7 action-text-types', async () => {
    for (const type of ['down', 'up']) {
      await postAction(origin, { sessionId, tabId, action: 'mouse', params: { type, x: 190, y: 278, button: 'left', clickCount: 1 } })
    }
    const response = await postAction(origin, { sessionId, tabId, action: 'text', params: { text: 'hello panel' } })
    assert(response.ok === true, `text action failed: ${JSON.stringify(response)}`)
    const typed = await waitUntil(async () => {
      const state = await getState(origin, sessionId)
      return String(state.tabs[0]?.title ?? '').startsWith('typed:hello panel') ? state.tabs[0].title : null
    }, 4000)
    assert(typed !== null, 'the fixture input did not receive the inserted text')
    return `Input.insertText reached #name -> page title ${JSON.stringify(typed)}`
  })

  let lastPick = null
  await check('B8 action-pick-descriptor-and-sse', async () => {
    const arm = await postAction(origin, { sessionId, tabId, action: 'pickArm', params: { on: true } })
    assert(arm.ok === true && arm.result.pickMode === true, `pickArm failed: ${JSON.stringify(arm)}`)
    const hover = await postAction(origin, { sessionId, tabId, action: 'pickHover', params: { x: 180, y: 200 } })
    assert(hover.ok === true, `pickHover failed: ${JSON.stringify(hover)}`)
    assert(hover.result.rect !== null && hover.result.label === 'button#save-btn',
      `pickHover returned ${JSON.stringify(hover.result)}`)
    const response = await postAction(origin, { sessionId, tabId, action: 'pick', params: { x: 180, y: 200 } })
    assert(response.ok === true, `pick failed: ${JSON.stringify(response)}`)
    lastPick = response.result.pick
    assert(lastPick.selector === '#save-btn', `pick selector ${JSON.stringify(lastPick.selector)}`)
    assert(lastPick.tag === 'button' && lastPick.id === 'save-btn', 'pick descriptor tag/id mismatch')
    assert(lastPick.rect.x >= 119 && lastPick.rect.x <= 121 && lastPick.rect.w >= 119 && lastPick.rect.w <= 121,
      `pick rect off: ${JSON.stringify(lastPick.rect)}`)
    assert(lastPick.contextText.startsWith('Picked browser element (user selection from the browser panel)'),
      'contextText does not start with the contract first line')
    const gotPicks = await sse.waitFor((events) => events.some((event) =>
      event.event === 'picks' && Array.isArray(event.data.picks)
      && event.data.picks.some((pick) => pick.pickId === lastPick.pickId)), 3000)
    assert(gotPicks, 'the pick never arrived on the SSE picks event')
    const hoverEvent = sse.events.find((event) => event.event === 'hover')
    assert(hoverEvent !== undefined && hoverEvent.data.label === 'button#save-btn', 'hover event missing from SSE')
    return `pick ${lastPick.pickId} #save-btn rect ${JSON.stringify(lastPick.rect)}; picks+hover events on SSE`
  })

  await check('B9 context-injection', async () => {
    assert(lastPick !== null, 'no pick from B8')
    assert(stub.injected.length >= 1, 'agent.inject was never called')
    const message = stub.injected[stub.injected.length - 1]
    assert(message.role === 'user', `injected message role ${message.role}`)
    assert(typeof message.id === 'string' && message.id.length > 0, 'injected message has no id')
    assert(Array.isArray(message.content) && message.content[0]?.type === 'text', 'injected content is not a text block')
    assert(message.content[0].text === lastPick.contextText, 'injected text is not the pick contextText')
    assert(message.source.kind === 'browser-panel' && message.source.form === 'notice', `injected source ${JSON.stringify(message.source)}`)
    assert(typeof message.source.summary === 'string' && message.source.summary.length <= 120,
      `notice summary is not bounded: ${JSON.stringify(message.source.summary)}`)
    return `agent.inject got source.kind=browser-panel/form=notice, summary ${JSON.stringify(message.source.summary)}`
  })

  await check('B10 tool-browser-pick-last', async () => {
    const tool = stub.tools.get('browser_pick_last')
    assert(tool !== undefined, 'browser_pick_last was not registered')
    const value = await tool.execute({}, { agent: stub.agent, signal: new AbortController().signal })
    assert(value.ok === true, `browser_pick_last failed: ${JSON.stringify(value)}`)
    assert(value.pick.pickId === lastPick.pickId, 'browser_pick_last returned a different pick')
    const text = tool.output.render({}, value)
    assert(Array.isArray(text) && text[0]?.type === 'text' && text[0].text.includes('#save-btn'),
      'tool render did not project the pick')
    return `browser_pick_last -> ${value.pick.pickId} (#save-btn), ${text[0].text.length} chars rendered`
  })

  await check('B10b action-picksDrop', async () => {
    assert(lastPick !== null, 'no pick from B8')
    const response = await postAction(origin, { sessionId, tabId, action: 'picksDrop', params: { pickId: lastPick.pickId } })
    assert(response.ok === true, `picksDrop failed: ${JSON.stringify(response)}`)
    assert(Array.isArray(response.result.picks) && response.result.picks.length === 0, 'picksDrop left the pick in the list')
    const state = await getState(origin, sessionId)
    assert(state.picks.length === 0, 'picksDrop did not persist')
    const gotEmpty = await sse.waitFor((events) => events.some((event) =>
      event.event === 'picks' && Array.isArray(event.data.picks) && event.data.picks.length === 0), 3000)
    assert(gotEmpty, 'the drops change never arrived on the SSE picks event')
    return `removed ${lastPick.pickId}; picks list and SSE are empty`
  })

  await check('B11 tool-browser-click-selector', async () => {
    const tool = stub.tools.get('browser_click')
    assert(tool !== undefined, 'browser_click was not registered')
    const value = await tool.execute({ selector: '#save-btn' }, { agent: stub.agent, signal: new AbortController().signal })
    assert(value.ok === true, `browser_click failed: ${JSON.stringify(value)}`)
    const clicked = await waitUntil(async () => {
      const state = await getState(origin, sessionId)
      return String(state.tabs[0]?.title ?? '') === 'clicked:2' ? true : null
    }, 4000)
    assert(clicked === true, `selector click did not land (title never became clicked:2)`)
    return `selector click resolved #save-btn to CSS ${value.x},${value.y} and landed (title clicked:2)`
  })

  await check('B12 tool-browser-type-and-scroll', async () => {
    const typeTool = stub.tools.get('browser_type')
    const scrollTool = stub.tools.get('browser_scroll')
    assert(typeTool !== undefined && scrollTool !== undefined, 'browser_type/browser_scroll were not registered')
    const typed = await typeTool.execute({ selector: '#name', text: 'hello again', clear: true }, { agent: stub.agent, signal: new AbortController().signal })
    assert(typed.ok === true, `browser_type failed: ${JSON.stringify(typed)}`)
    const typedState = await waitUntil(async () => {
      const state = await getState(origin, sessionId)
      return String(state.tabs[0]?.title ?? '').startsWith('typed:hello again') ? state.tabs[0].title : null
    }, 4000)
    assert(typedState !== null, 'browser_type did not reach #name')
    const scrolled = await scrollTool.execute({ deltaY: 400 }, { agent: stub.agent, signal: new AbortController().signal })
    assert(scrolled.ok === true, `browser_scroll failed: ${JSON.stringify(scrolled)}`)
    assert(scrolled.scrollY > 0, `browser_scroll reported scrollY ${scrolled.scrollY}`)
    const scrollState = await waitUntil(async () => {
      const state = await getState(origin, sessionId)
      return String(state.tabs[0]?.title ?? '').startsWith('scroll:') ? state.tabs[0].title : null
    }, 4000)
    assert(scrollState !== null, 'wheel event did not scroll the fixture page')
    return `typed #name then wheel 400 -> ${JSON.stringify(scrollState)} (scrollHeight ${scrolled.scrollHeight})`
  })

  await check('B13 tools-registered-and-session-guard', async () => {
    assert(stub.tools.size === BROWSER_TOOL_NAMES.length, `expected ${BROWSER_TOOL_NAMES.length} tools, got ${stub.tools.size}`)
    for (const name of BROWSER_TOOL_NAMES) assert(stub.tools.has(name), `missing tool ${name}`)
    const nav = stub.tools.get('browser_navigate')
    const withoutSession = await nav.execute({ url: fixture.fixtureUrl }, { signal: new AbortController().signal })
    assert(withoutSession.ok === false && withoutSession.code === 'no-session',
      `session-less tool call returned ${JSON.stringify(withoutSession)}`)
    const tabsTool = stub.tools.get('browser_tabs')
    const listed = await tabsTool.execute({ action: 'list' }, { agent: stub.agent, signal: new AbortController().signal })
    assert(listed.ok === true && listed.tabs.length === 1, `browser_tabs list returned ${JSON.stringify(listed)}`)
    return `${stub.tools.size} tools; no-session call -> ok:false/no-session; list -> ${listed.tabs.length} tab`
  })

  await check('B14 nav-rejected-and-bad-request', async () => {
    const nav = await postAction(origin, { sessionId, tabId, action: 'navigate', params: { url: 'file:///etc/passwd' } })
    assert(nav.ok === false && nav.code === 'nav-rejected', `file: navigation returned ${JSON.stringify(nav)}`)
    const badSession = await postAction(origin, { sessionId: 'bad session id', action: 'ensure', params: {} })
    assert(badSession.status === 400 && badSession.ok === false && badSession.code === 'no-session',
      `bad session returned ${JSON.stringify(badSession)}`)
    const badAction = await postAction(origin, { sessionId, action: 'does-not-exist', params: {} })
    assert(badAction.ok === false && badAction.code === 'bad-request', `unknown action returned ${JSON.stringify(badAction)}`)
    const malformed = await fetch(`${origin}/browser-panel/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
    assert(malformed.status === 400, `malformed JSON returned ${malformed.status}`)
    return 'file: -> nav-rejected; bad session -> 400 no-session; unknown action -> bad-request; malformed JSON -> 400'
  })

  await check('B15 tab-limit', async () => {
    const opened = []
    for (let index = 0; index < 3; index++) {
      const response = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.origin + '/blank' } })
      assert(response.ok === true, `tab ${index} failed: ${JSON.stringify(response)}`)
      opened.push(response.result.tab.tabId)
    }
    const state = await getState(origin, sessionId)
    assert(state.tabs.length === 4, `expected 4 tabs, got ${state.tabs.length}`)
    const overflow = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.origin + '/blank' } })
    assert(overflow.ok === false && overflow.code === 'tab-limit', `5th tab returned ${JSON.stringify(overflow)}`)
    for (const id of opened) {
      const closed = await postAction(origin, { sessionId, tabId: id, action: 'closeTab', params: {} })
      assert(closed.ok === true, `closing ${id} failed: ${JSON.stringify(closed)}`)
    }
    const after = await getState(origin, sessionId)
    assert(after.tabs.length === 1, `expected 1 tab after closing extras, got ${after.tabs.length}`)
    return `4 tabs open, 5th -> tab-limit, extras closed (${opened.length})`
  })

  await check('B16 shutdown-no-orphans', async () => {
    if (sse !== null) { await sse.close(); sse = null }
    const response = await postAction(origin, { sessionId, action: 'shutdown', params: {} })
    assert(response.ok === true, `shutdown failed: ${JSON.stringify(response)}`)
    const state = await getState(origin, sessionId)
    assert(state.chrome.status === 'idle', `chrome status after shutdown ${state.chrome.status}`)
    assert(state.tabs.length === 0, 'tabs survived shutdown')
    assert(typeof chromeDir === 'string', 'no Chrome user-data-dir recorded in B2')
    const gone = await waitUntil(async () => (await pgrep(chromeDir)) === 0, 5000)
    assert(gone, `Chrome processes still match ${chromeDir}`)
    return `chrome idle, tabs [], no Chrome processes match ${chromeDir}`
  })

  await check('B16b recovery-after-shutdown', async () => {
    // The idle reaper and shutdown take the same path: browser = null, keys
    // cleared, tab list empty. A later ensure/openTab must recover on a fresh
    // Chrome without resurrecting dead tabs or stale key mappings.
    const ensured = await postAction(origin, { sessionId, action: 'ensure', params: {} })
    assert(ensured.ok === true && ensured.result.chrome.status === 'ready', `re-ensure failed: ${JSON.stringify(ensured)}`)
    const reopened = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl, key: 'after-shutdown' } })
    assert(reopened.ok === true, `openTab after re-ensure failed: ${JSON.stringify(reopened)}`)
    const state = await getState(origin, sessionId)
    assert(state.tabs.length === 1, `recovered session has ${state.tabs.length} tabs, expected 1`)
    assert(state.tabs[0].url === fixture.fixtureUrl, `recovered tab url ${state.tabs[0].url}`)
    const again = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl, key: 'after-shutdown' } })
    assert(again.ok === true && again.result.tab.tabId === reopened.result.tab.tabId, 'key mapping did not survive a live re-ensure')
    const stateAgain = await getState(origin, sessionId)
    assert(stateAgain.tabs.length === 1, `repeated keyed open after recovery created a tab (${stateAgain.tabs.length})`)

    // Shutdown + openTab without an explicit ensure: the key from the previous
    // Chrome must NOT resolve against the new process's restarted t1 namespace.
    const shut = await postAction(origin, { sessionId, action: 'shutdown', params: {} })
    assert(shut.ok === true, `second shutdown failed: ${JSON.stringify(shut)}`)
    const deadState = await getState(origin, sessionId)
    assert(deadState.tabs.length === 0, 'tab list survived the second shutdown')
    const fresh = await postAction(origin, { sessionId, action: 'openTab', params: { url: fixture.fixtureUrl, key: 'after-shutdown' } })
    assert(fresh.ok === true, `openTab on the fresh Chrome failed: ${JSON.stringify(fresh)}`)
    assert(fresh.result.tab.url === fixture.fixtureUrl, `fresh Chrome tab url ${fresh.result.tab.url}`)
    const freshState = await getState(origin, sessionId)
    assert(freshState.tabs.length === 1, `fresh session has ${freshState.tabs.length} tabs, expected 1`)
    assert(freshState.chrome.status === 'ready', `fresh session chrome ${freshState.chrome.status}`)
    await postAction(origin, { sessionId, action: 'shutdown', params: {} })
    return `recovered after shutdown: 1 tab, key stable while live, cleared across Chrome processes`
  })

  await check('B17 dispose-unroutes-and-closes', async () => {
    await host.dispose()
    // Routes and tools unregister on dispose.
    const stateResponse = await fetch(`${origin}/browser-panel/state?sessionId=${encodeURIComponent(sessionId)}`)
    assert(stateResponse.status === 404, `state route still served after dispose (${stateResponse.status})`)
    assert(stub.tools.size === 0, `${stub.tools.size} tools survived dispose`)
    assert(stub.routes.size === 0, `${stub.routes.size} routes survived dispose`)
    return 'routes and tools unregistered; no resources left'
  })

  if (sse !== null) { await sse.close(); sse = null }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log('browser-panel host self-test')
  console.log(`node ${process.version} | ${findChrome()} | headless`)
  console.log(`panel root: ${PANEL_ROOT}`)

  const initialChromeCount = await pgrep('dsh-chrome-')
  const fixture = await startFixtureServer()
  cleanups.push(() => fixture.close())

  try {
    await phaseA(fixture)
    await phaseB(fixture)
  } catch (err) {
    console.error('\nFATAL:', err)
    record('fatal', false, err instanceof Error ? err.message : String(err))
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() } catch { /* ignore cleanup failures */ }
    }
  }

  const failed = results.filter((result) => !result.passed)
  const total = results.length
  const passed = total - failed.length
  console.log('\n================ SUMMARY ================')
  console.log(`${passed}/${total} checks passed`)
  if (failed.length > 0) {
    console.log('failed:')
    for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`)
  }
  console.log('=========================================')

  const leftover = await pgrep('dsh-chrome-')
  if (leftover > initialChromeCount) {
    console.log(`WARNING: dsh-chrome-* count ${leftover} exceeds the baseline ${initialChromeCount} after cleanup`)
    process.exitCode = 1
  } else {
    console.log(`cleanup: dsh-chrome-* count ${leftover} (baseline ${initialChromeCount} — other agents' browsers may be running)`)
  }
  if (failed.length > 0) process.exitCode = 1
}

await main()