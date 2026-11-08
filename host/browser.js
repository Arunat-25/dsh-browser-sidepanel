/**
 * ctx-independent Chrome/CDP layer for the browser panel.
 *
 * This module knows nothing about Cordis, the harness, or the panel transport:
 * it launches Chrome, speaks the DevTools Protocol, owns one Browser with N tabs
 * (CDP page targets), streams JPEG screencast frames, forwards CSS-pixel input,
 * builds element-pick descriptors, and kills the whole Chrome process group on
 * dispose.
 *
 * Verified protocol facts (probe/report.md, Chrome 156 on this host):
 * - `--remote-debugging-port=0` + `<user-data-dir>/DevToolsActivePort`; line 2 of
 *   that file has no trailing newline and can lag line 1, so poll for both.
 * - Flatten mode: page commands carry the target `sessionId`; browser-level
 *   `Target.*` commands carry none. Event envelopes carry the target session.
 * - `Page.screencastFrame` params.sessionId is the INTEGER screencast id and is
 *   what `Page.screencastFrameAck` expects; acking with the envelope session id
 *   is rejected (-32602).
 * - `Input.dispatchWheelEvent` does not exist in this build (-32601); wheel is
 *   `Input.dispatchMouseEvent({ type: 'mouseWheel' })`.
 * - Screencast `metadata.deviceWidth/Height` is the CSS viewport including the
 *   scrollbar and equals `window.innerWidth/innerHeight`; it is the denominator
 *   for image<->CSS mapping. Never use `cssVisualViewport` and never cache it.
 * - Screencast frames arrive only while the page is damaged. Static pages are
 *   kept alive by an additive `Page.captureScreenshot` keepalive (see
 *   Tab#_maybeKeepalive) so the panel is never blank.
 * - Spawn Chrome with `detached: true` and kill the process group: Chrome's
 *   zygote/renderer/GPU children otherwise survive the launcher pid.
 *
 * No npm dependencies: Node builtins only (global WebSocket/fetch, Node >= 22).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Errors. Each carries the panel's stable error `code` where one exists so the
// HTTP/tool layers can map failures without inspecting messages.
// ---------------------------------------------------------------------------

/** Base error for the browser layer. */
export class BrowserPanelError extends Error {
  /** Stable panel error code, when one applies. */
  constructor(message, code = 'internal') {
    super(message)
    this.name = 'BrowserPanelError'
    this.code = code
  }
}

/** Generic CDP failure. */
export class CDPError extends BrowserPanelError {
  constructor(message, code = 'internal') {
    super(message, code)
    this.name = 'CDPError'
  }
}

/** A CDP command or connect did not settle inside its deadline. */
export class CDPTimeoutError extends CDPError {
  constructor(message) {
    super(message, 'timeout')
    this.name = 'CDPTimeoutError'
  }
}

/** The CDP socket closed or was never usable. */
export class CDPClosedError extends CDPError {
  constructor(message) {
    super(message, 'no-chrome')
    this.name = 'CDPClosedError'
  }
}

/** Chrome answered a command with a protocol-level error object. */
export class CDPProtocolError extends CDPError {
  constructor(method, error) {
    super(`${method} failed: ${error?.message ?? JSON.stringify(error)} (code ${error?.code})`)
    this.name = 'CDPProtocolError'
    this.method = method
    this.protocolCode = error?.code
    this.data = error?.data
  }
}

/** Chrome could not be launched or never published its DevTools endpoint. */
export class ChromeLaunchError extends BrowserPanelError {
  constructor(message, { stderrTail = '' } = {}) {
    super(message, 'launch-failed')
    this.name = 'ChromeLaunchError'
    this.stderrTail = stderrTail
  }
}

/** A navigation target is outside the allowed scheme set. */
export class NavRejectedError extends BrowserPanelError {
  constructor(message) {
    super(message, 'nav-rejected')
    this.name = 'NavRejectedError'
  }
}

/** `document.elementFromPoint` found nothing usable at the requested point. */
export class PickFailedError extends BrowserPanelError {
  constructor(message) {
    super(message, 'pick-failed')
    this.name = 'PickFailedError'
  }
}

/** The tab limit or an unknown tab was hit. */
export class TabLimitError extends BrowserPanelError {
  constructor(message) {
    super(message, 'tab-limit')
    this.name = 'TabLimitError'
  }
}

/** Unknown tab for this Session. */
export class NoTabError extends BrowserPanelError {
  constructor(message) {
    super(message, 'no-tab')
    this.name = 'NoTabError'
  }
}

/** No Chrome for this Session (or it is not ready). */
export class NoChromeError extends BrowserPanelError {
  constructor(message) {
    super(message, 'no-chrome')
    this.name = 'NoChromeError'
  }
}

// ---------------------------------------------------------------------------
// Minimal CDP client over the global WebSocket.
// ---------------------------------------------------------------------------

/**
 * Minimal flattened-session CDP client.
 *
 * - `send(method, params?, sessionId?, opts?)` resolves with `result` and
 *   rejects on protocol error, socket close, or timeout.
 * - `on(event, handler, { sessionId }?)` -> unsubscribe; `handler(params, meta)`
 *   where `meta = { method, sessionId }`.
 */
export class CDP {
  constructor(ws, opts = {}) {
    this._ws = ws
    this._nextId = 1
    this._pending = new Map()
    this._handlers = new Set()
    this._closed = false
    this._closeError = null
    this.defaultTimeout = opts.timeout ?? 30_000
    /** Optional debug sink: (direction, payload) => void */
    this.trace = opts.trace ?? null

    this._onMessage = this._onMessage.bind(this)
    ws.addEventListener('message', this._onMessage)
    ws.addEventListener('close', () => this._onClose(new CDPClosedError('CDP socket closed')))
    ws.addEventListener('error', () => this._onClose(new CDPClosedError('CDP socket error')))
  }

  /** Connect to a `ws://...` DevTools URL. */
  static async connect(url, opts = {}) {
    const { connectTimeout = 10_000 } = opts
    if (typeof WebSocket === 'undefined') {
      throw new CDPError('global WebSocket missing: this plugin needs Node >= 22')
    }
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* already gone */ }
        reject(new CDPTimeoutError(`WebSocket connect timeout after ${connectTimeout}ms: ${url}`))
      }, connectTimeout)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new CDPClosedError(`WebSocket connect failed: ${url}`))
      }, { once: true })
    })
    return new CDP(ws, opts)
  }

  get closed() { return this._closed }

  /**
   * Send one CDP command.
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] flattened target session; omit for browser scope
   * @param {{timeout?: number}} [opts]
   */
  send(method, params = {}, sessionId = undefined, opts = {}) {
    if (this._closed) {
      return Promise.reject(this._closeError ?? new CDPClosedError('CDP connection is closed'))
    }
    const id = this._nextId++
    const payload = { id, method, params: params ?? {} }
    if (sessionId) payload.sessionId = sessionId
    const timeout = opts.timeout ?? this.defaultTimeout

    return new Promise((resolve, reject) => {
      const timer = timeout > 0
        ? setTimeout(() => {
          this._pending.delete(id)
          reject(new CDPTimeoutError(`${method} timed out after ${timeout}ms (scope=${sessionId ?? 'browser'})`))
        }, timeout)
        : null
      this._pending.set(id, { resolve, reject, method, timer })
      try {
        if (this.trace) this.trace('out', payload)
        this._ws.send(JSON.stringify(payload))
      } catch (err) {
        if (timer) clearTimeout(timer)
        this._pending.delete(id)
        reject(new CDPClosedError(`send failed for ${method}: ${err?.message ?? err}`))
      }
    })
  }

  /**
   * Subscribe to a CDP event. Use '*' for every event.
   * @returns {() => void} unsubscribe
   */
  on(event, handler, { sessionId } = {}) {
    const entry = { event, handler, sessionId }
    this._handlers.add(entry)
    return () => this._handlers.delete(entry)
  }

  /** Resolve with the first matching event's params. */
  waitFor(event, { predicate, timeout = 10_000, sessionId } = {}) {
    return new Promise((resolve, reject) => {
      let off = () => {}
      const timer = setTimeout(() => {
        off()
        reject(new CDPTimeoutError(`waitFor(${event}) timed out after ${timeout}ms`))
      }, timeout)
      off = this.on(event, (params, meta) => {
        if (predicate && !predicate(params, meta)) return
        clearTimeout(timer)
        off()
        resolve({ params, meta })
      }, { sessionId })
    })
  }

  async close() {
    if (this._closed) return
    try { this._ws.close() } catch { /* ignore */ }
    this._onClose(new CDPClosedError('closed locally'))
  }

  // ---- internals -----------------------------------------------------------

  _onMessage(ev) {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '')
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (this.trace) this.trace('in', msg)

    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this._pending.get(msg.id)
      if (!entry) return
      this._pending.delete(msg.id)
      if (entry.timer) clearTimeout(entry.timer)
      if (msg.error) entry.reject(new CDPProtocolError(entry.method, msg.error))
      else entry.resolve(msg.result ?? {})
      return
    }

    if (msg.method) {
      const meta = { method: msg.method, sessionId: msg.sessionId }
      for (const handler of [...this._handlers]) {
        if (handler.event !== '*' && handler.event !== msg.method) continue
        if (handler.sessionId && handler.sessionId !== msg.sessionId) continue
        try { handler.handler(msg.params ?? {}, meta) } catch (err) {
          // A listener must never break the protocol loop.
          console.error(`[browser-panel] CDP handler for ${msg.method} threw:`, err)
        }
      }
    }
  }

  _onClose(err) {
    if (this._closed) return
    this._closed = true
    this._closeError = err
    for (const [, entry] of this._pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
    this._pending.clear()
  }
}

// ---------------------------------------------------------------------------
// Chrome process
// ---------------------------------------------------------------------------

/** Candidate Chrome executables, most specific first. */
export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/opt/google/chrome/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

/** Resolve a Chrome binary, or throw a launch error. */
export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  throw new ChromeLaunchError(`no Chrome binary found in: ${CHROME_CANDIDATES.join(', ')}`)
}

/**
 * Read `<userDataDir>/DevToolsActivePort`.
 *
 * File format (2 lines, second line may lack a trailing newline):
 *   line 1: the TCP port Chrome bound (authoritative with --remote-debugging-port=0)
 *   line 2: the browser-level WebSocket path, e.g. /devtools/browser/<uuid>
 *
 * The file can appear before line 2 is flushed, so recover the path from
 * `GET /json/version` when only the port is readable, and keep polling otherwise.
 */
export async function readDevToolsActivePort(userDataDir, { timeoutMs = 25_000, pollMs = 40, isDead } = {}) {
  const file = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    if (isDead?.()) throw new CDPClosedError(`Chrome exited before writing ${file}`)
    try {
      const raw = await readFile(file, 'utf8')
      last = raw
      const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
      if (lines.length >= 1 && /^\d+$/.test(lines[0])) {
        const port = Number(lines[0])
        if (lines.length >= 2 && lines[1].startsWith('/devtools/')) {
          return { port, wsPath: lines[1], raw, file }
        }
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(1000),
          })
          if (res.ok) {
            const version = await res.json()
            if (version.webSocketDebuggerUrl) {
              const url = new URL(version.webSocketDebuggerUrl)
              return { port, wsPath: url.pathname, raw, file, recoveredFromHttp: true }
            }
          }
        } catch { /* port not serving yet: keep polling */ }
      }
    } catch (err) {
      last = last ?? String(err?.message ?? err)
    }
    await sleep(pollMs)
  }
  throw new CDPTimeoutError(
    `DevToolsActivePort not ready after ${timeoutMs}ms (${file}); last content: ${JSON.stringify(last)}`,
  )
}

const DEFAULT_CHROME_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
  '--disable-component-update',
  '--disable-client-side-phishing-detection',
  '--disable-sync',
  '--disable-extensions',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-service-autorun',
  '--password-store=basic',
  '--use-mock-keychain',
]

/**
 * Spawn Chrome with a fresh temp `--user-data-dir` and `--remote-debugging-port=0`.
 * Resolves once DevToolsActivePort is readable and the process has its own
 * process group (detached) so `kill()` can take down zygote/renderer/GPU children.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.headless=true]
 * @param {string} [opts.executablePath]
 * @param {string[]} [opts.extraArgs]
 * @param {number} [opts.width=1280]
 * @param {number} [opts.height=800]
 * @param {number} [opts.readyTimeoutMs=25000]
 * @param {object} [opts.env]
 */
export async function launchChrome(opts = {}) {
  const {
    headless = true,
    width = 1280,
    height = 800,
    extraArgs = [],
    executablePath,
    readyTimeoutMs = 25_000,
    env: extraEnv = {},
  } = opts

  const bin = executablePath || findChrome()
  const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-chrome-'))
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    ...DEFAULT_CHROME_ARGS,
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs.map(String),
    'about:blank',
  ]

  const startedAt = Date.now()
  const proc = spawn(bin, args, {
    detached: true, // own process group -> kill every descendant on dispose
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  })

  const stdout = []
  const stderr = []
  let exited = false
  let exitInfo = null
  proc.stdout?.on('data', (chunk) => {
    stdout.push(chunk.toString())
    if (stdout.length > 400) stdout.shift()
  })
  proc.stderr?.on('data', (chunk) => {
    stderr.push(chunk.toString())
    if (stderr.length > 400) stderr.shift()
  })
  proc.on('error', (err) => {
    exited = true
    exitInfo = { code: null, signal: null, error: String(err?.message ?? err) }
  })
  proc.on('exit', (code, signal) => {
    exited = true
    exitInfo = { code, signal }
  })

  const stderrTail = (n = 25) => stderr.join('').split('\n').filter(Boolean).slice(-n).join('\n')
  const stdoutTail = (n = 10) => stdout.join('').split('\n').filter(Boolean).slice(-n).join('\n')

  const kill = async (signal = 'SIGKILL') => {
    if (exited) {
      await removeUserDataDir(userDataDir)
      return true
    }
    try { process.kill(-proc.pid, signal) } catch { /* group already gone */ }
    try { proc.kill(signal) } catch { /* already gone */ }
    const deadline = Date.now() + 5000
    while (!exited && Date.now() < deadline) await sleep(25)
    if (!exited) {
      try { process.kill(-proc.pid, 'SIGKILL') } catch { /* ignore */ }
      const second = Date.now() + 3000
      while (!exited && Date.now() < second) await sleep(25)
    }
    await removeUserDataDir(userDataDir)
    return exited
  }

  let active
  try {
    active = await readDevToolsActivePort(userDataDir, { timeoutMs: readyTimeoutMs, isDead: () => exited })
  } catch (err) {
    const tail = stderrTail(30)
    await kill()
    throw new ChromeLaunchError(`${err.message}\n--- chrome stderr (tail) ---\n${tail || '(empty)'}`, { stderrTail: tail })
  }

  return {
    proc,
    pid: proc.pid,
    bin,
    args,
    userDataDir,
    port: active.port,
    wsPath: active.wsPath,
    browserWsUrl: `ws://127.0.0.1:${active.port}${active.wsPath}`,
    readyMs: Date.now() - startedAt,
    exited: () => exited,
    exitInfo: () => exitInfo,
    stdoutTail,
    stderrTail,
    kill,
  }
}

/** Remove only directories this module created under the OS temp dir. */
async function removeUserDataDir(userDataDir) {
  const base = tmpdir()
  if (!userDataDir.startsWith(join(base, 'dsh-chrome-'))) return
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/**
 * Normalize one navigation target and reject schemes the panel must never
 * expose (`file:`, `javascript:`, `data:`, `chrome:`, ...).
 *
 * A bare host like `example.com` becomes `https://example.com`. Only http(s)
 * and `about:blank` are allowed.
 *
 * @param {unknown} raw
 * @returns {string} normalized absolute URL
 * @throws {NavRejectedError}
 */
export function normalizePanelUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new NavRejectedError('empty URL')
  if (text.length > 4096) throw new NavRejectedError('URL is too long')
  let candidate = text
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    if (candidate.startsWith('//')) candidate = `https:${candidate}`
    else candidate = `https://${candidate}`
  }
  let url
  try {
    url = new URL(candidate)
  } catch {
    throw new NavRejectedError(`not a valid URL: ${text}`)
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  if (/^about:blank($|[#?])/i.test(candidate)) return candidate
  throw new NavRejectedError(`scheme "${url.protocol}" is not allowed (http/https only)`)
}

// ---------------------------------------------------------------------------
// JPEG intrinsic size (no dependencies)
// ---------------------------------------------------------------------------

/**
 * Parse a JPEG's real pixel dimensions from the SOF marker.
 * Screencast frames are scaled by maxWidth/maxHeight, so the delivered image
 * size is the only reliable source for the image->CSS mapping.
 *
 * @param {Buffer|Uint8Array|null} buffer
 * @returns {{width: number, height: number, marker: string}|null}
 */
export function jpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) { i++; continue }
    const marker = buffer[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const length = buffer.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return {
        height: buffer.readUInt16BE(i + 5),
        width: buffer.readUInt16BE(i + 7),
        marker: `0xFF${marker.toString(16).toUpperCase()}`,
      }
    }
    if (marker === 0xda) break // start of scan: no SOF before it
    i += 2 + length
  }
  return null
}

// ---------------------------------------------------------------------------
// In-page descriptor sources (single Runtime.evaluate each, returnByValue)
// ---------------------------------------------------------------------------

const PICK_SOURCE = `function (x, y) {
  var MAX_TEXT = 200, MAX_HTML = 800;
  function esc(value) {
    return (window.CSS && CSS.escape)
      ? CSS.escape(String(value))
      : String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; });
  }
  function uniqueSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    var parts = [], cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 60) {
      var tag = cur.tagName.toLowerCase();
      if (cur.id) {
        var idSel = '#' + esc(cur.id);
        try { if (document.querySelectorAll(idSel).length === 1) { parts.unshift(idSel); break; } } catch (e) {}
      }
      var part = tag;
      var parent = cur.parentElement;
      if (parent) {
        var same = [], kids = parent.children;
        for (var i = 0; i < kids.length; i++) if (kids[i].tagName === cur.tagName) same.push(kids[i]);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      if (cur === document.documentElement) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  function classes(el) {
    try { return Array.prototype.slice.call(el.classList).map(String); } catch (e) { return []; }
  }
  function accName(el) {
    try { if (el.computedLabel) return String(el.computedLabel); } catch (e) {}
    var a = el.getAttribute && el.getAttribute('aria-label');
    if (a) return a.trim();
    var lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      var t = lb.split(/\\\\s+/).map(function (id) { var n = document.getElementById(id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ').trim();
      if (t) return t.slice(0, MAX_TEXT);
    }
    var alt = el.getAttribute && el.getAttribute('alt'); if (alt) return alt.trim();
    var ti = el.getAttribute && el.getAttribute('title'); if (ti) return ti.trim();
    return ((el.innerText || el.textContent || '').trim()).slice(0, MAX_TEXT);
  }
  function accRole(el) {
    try { if (el.computedRole) return String(el.computedRole); } catch (e) {}
    var r = el.getAttribute && el.getAttribute('role'); if (r) return r;
    var t = el.tagName.toLowerCase();
    if (t === 'button') return 'button';
    if (t === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (t === 'input') {
      var ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'range') return 'slider';
      return 'textbox';
    }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'ul' || t === 'ol') return 'list';
    if (t === 'li') return 'listitem';
    if (t === 'img') return 'img';
    if (t === 'form') return 'form';
    return null;
  }
  function attrsOf(el) {
    var out = {}, allow = { name: 1, type: 1, placeholder: 1, href: 1, src: 1, alt: 1, value: 1, role: 1, title: 1, action: 1, method: 1, target: 1, for: 1, rel: 1 };
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i++) {
      var n = attrs[i].name;
      if (/^(data-|aria-)/.test(n) || allow[n]) out[n] = String(attrs[i].value).slice(0, 200);
    }
    return out;
  }
  function shallow(el) {
    return { tag: el.tagName.toLowerCase(), id: el.id || '', classes: classes(el) };
  }
  function ancestry(el) {
    var out = [], cur = el.parentElement, n = 0;
    while (cur && n < 4) { out.push(shallow(cur)); cur = cur.parentElement; n++; }
    return out;
  }

  var el = document.elementFromPoint(x, y);
  if (!el) return { found: false, reason: 'elementFromPoint returned null (point outside the viewport)' };

  var selector = uniqueSelector(el);
  var matchesSelf = false, uniqueCount = null;
  if (selector) {
    try {
      matchesSelf = document.querySelector(selector) === el;
      uniqueCount = document.querySelectorAll(selector).length;
    } catch (e) { matchesSelf = false; }
  }
  var rect = el.getBoundingClientRect();
  var text = ((el.innerText || el.textContent || '').trim()).slice(0, MAX_TEXT);
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: classes(el),
    role: accRole(el) || '',
    accessibleName: accName(el) || '',
    text: text,
    selector: selector || '',
    selectorMatchesSelf: matchesSelf,
    selectorUnique: uniqueCount === 1,
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    attrs: attrsOf(el),
    ancestry: ancestry(el),
    outerHTML: String(el.outerHTML || '').slice(0, MAX_HTML),
    inShadow: !!(el.getRootNode && el.getRootNode() !== document),
    url: location.href,
    title: document.title
  };
}`

const HOVER_SOURCE = `function (x, y) {
  var el = document.elementFromPoint(x, y);
  if (!el) return { found: false };
  var rect = el.getBoundingClientRect();
  var cursor = 'default';
  try { cursor = (getComputedStyle(el).cursor || 'default'); } catch (e) { cursor = 'default'; }
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: (function () { try { return Array.prototype.slice.call(el.classList).map(String); } catch (e) { return []; } })(),
    role: (el.getAttribute && el.getAttribute('role')) || '',
    cursor: cursor,
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
  };
}`

/** CSS-ident-safe text for a selector segment (keeps descriptor readable). */
function cssIdent(text) {
  return String(text).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/** One compact `tag#id.class` path segment. */
function pathSegment(node) {
  const tag = String(node?.tag || '')
  if (!tag) return ''
  const id = node?.id ? `#${node.id}` : ''
  const classes = Array.isArray(node?.classes) ? node.classes.slice(0, 2).map((name) => `.${cssIdent(name)}`).join('') : ''
  return `${tag}${id}${classes}`
}

/** Round to at most 2 decimals, no trailing zeros (stable contextText). */
function trimNumber(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  const rounded = Math.round(n * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

/** Collapse whitespace so one descriptor line stays one line. */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Escape one HTML attribute value for the human-readable `element:` line. */
function attrValue(text) {
  return oneLine(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Build the exact CONTRACT.md `contextText` for one pick descriptor.
 * Exported for tests and for host/tools.js summaries.
 *
 * @param {object} pick
 * @returns {string}
 */
export function buildContextText(pick) {
  const title = oneLine(pick.pageTitle) || '(untitled)'
  const url = oneLine(pick.url) || '(unknown)'
  let element = `<${pick.tag || 'element'}`
  if (pick.id) element += ` id="${attrValue(pick.id)}"`
  if (pick.classes && pick.classes.length) element += ` class="${attrValue(pick.classes.join(' '))}"`
  if (pick.role) element += ` role="${attrValue(pick.role)}"`
  if (pick.accessibleName) element += ` name="${attrValue(pick.accessibleName)}"`
  element += '>'
  const rect = pick.rect || { x: 0, y: 0, w: 0, h: 0 }
  const chain = (pick.ancestors || [])
    .slice()
    .reverse()
    .map(pathSegment)
    .filter((segment) => segment && !/^(html|body)([#.]|$)/.test(segment))
  const self = pathSegment(pick)
  const path = [...chain, self].filter(Boolean).join(' > ') || (pick.selector || '(unknown)')
  return [
    'Picked browser element (user selection from the browser panel)',
    `page: ${title} — ${url}`,
    `selector: ${pick.selector || '(no selector)'}`,
    `element: ${element}`,
    `text: ${JSON.stringify(oneLine(pick.text).slice(0, 200))}`,
    `box: ${trimNumber(rect.x)},${trimNumber(rect.y)} ${trimNumber(rect.w)}×${trimNumber(rect.h)}`,
    `path: ${path}`,
    `html: ${oneLine(pick.outerHTML).slice(0, 800) || '(empty)'}`,
  ].join('\n')
}

/** Hover label in the CONTRACT's `button#save` shape (id preferred, else first class). */
export function buildHoverLabel(raw) {
  const tag = String(raw?.tag || '')
  if (!tag) return ''
  if (raw?.id) return `${tag}#${raw.id}`
  const firstClass = Array.isArray(raw?.classes) && raw.classes.length ? `.${raw.classes[0]}` : ''
  return `${tag}${firstClass}`
}

/** Normalize a rect payload into finite numbers. */
function normalizeRect(rect) {
  const r = rect && typeof rect === 'object' ? rect : {}
  return {
    x: round2(r.x), y: round2(r.y), w: round2(r.w), h: round2(r.h),
  }
}

function round2(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

function requireFinite(value, name) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new BrowserPanelError(`${name} must be a finite number`, 'bad-request')
  return n
}

// ---------------------------------------------------------------------------
// Tab: one CDP page target
// ---------------------------------------------------------------------------

/** Let a tab ask its Browser for shared limits. */
const TAB_DEFAULTS = {
  quality: 55,
  maxWidth: 1280,
  maxHeight: 800,
  fps: 20,
  captureTimeoutMs: 15_000,
  evaluateTimeoutMs: 10_000,
  keepaliveIdleMs: 500,
  keepaliveMinMs: 500,
}

/**
 * One attached page target: navigation, viewport, input, picker, screenshot,
 * and the throttled screencast pipeline.
 */
export class Tab {
  /**
   * @param {Browser} browser
   * @param {{tabId: string, targetId: string, sessionId: string}} identity
   * @param {object} [options] stream limits shared from the panel config
   */
  constructor(browser, identity, options = {}) {
    this.browser = browser
    this.cdp = browser.cdp
    this.tabId = identity.tabId
    this.targetId = identity.targetId
    this.sessionId = identity.sessionId
    this.options = { ...TAB_DEFAULTS, ...options }

    this.url = 'about:blank'
    this.title = ''
    this.status = 'loading' // 'loading' | 'ready'
    this.viewport = { width: 1280, height: 800 }
    this.canGoBack = false
    this.canGoForward = false
    this.mainFrameId = null
    this.closed = false

    /** @type {Set<(frame: object) => void>} */
    this.sinks = new Set()
    this.screencastOn = false
    this.frameSeq = 0
    this.latestFrame = null
    this.lastFrameAt = 0
    this.lastSentAt = 0
    this.pendingFrame = null
    this.pendingTimer = null
    this.keepaliveTimer = null
    this.captureInFlight = false
    this.lastCaptureAt = 0

    this.disposers = []
    /** Called by the owner on any user-visible state change. */
    this.onChange = null
  }

  /** Attach lifecycle events and read initial state. */
  async init() {
    await this.cdp.send('Page.enable', {}, this.sessionId)
    await this.cdp.send('Runtime.enable', {}, this.sessionId)

    this.disposers.push(this.cdp.on('Page.screencastFrame', (params) => {
      this._handleScreencastFrame(params)
    }, { sessionId: this.sessionId }))

    this.disposers.push(this.cdp.on('Page.frameNavigated', (params) => {
      const frame = params?.frame
      if (!frame) return
      if (!frame.parentId) {
        this.mainFrameId = frame.frameId
        if (frame.url) this.url = frame.url
        this._setStatus('loading')
        this._refreshHistory().catch(() => {})
      }
    }, { sessionId: this.sessionId }))

    this.disposers.push(this.cdp.on('Page.frameStartedLoading', (params) => {
      if (params?.frameId && this.mainFrameId && params.frameId === this.mainFrameId) this._setStatus('loading')
    }, { sessionId: this.sessionId }))

    this.disposers.push(this.cdp.on('Page.loadEventFired', () => {
      this._setStatus('ready')
      this._refreshHistory().catch(() => {})
      this._refreshViewport().catch(() => {})
      this._refreshTitle().catch(() => {})
    }, { sessionId: this.sessionId }))

    this.disposers.push(this.cdp.on('Page.navigatedWithinDocument', (params) => {
      if (params?.url) this.url = params.url
      this._refreshHistory().catch(() => {})
      this._emitChange()
    }, { sessionId: this.sessionId }))

    await this._refreshViewport().catch(() => {})
    await this._refreshHistory().catch(() => {})
    await this.refreshMetadata().catch(() => {})
    return this
  }

  /** Read the CSS viewport from the page (`innerWidth` includes the scrollbar). */
  async _refreshViewport() {
    const value = await this.evaluate('({ width: window.innerWidth, height: window.innerHeight })')
    if (value && Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0) {
      this.viewport = { width: Math.round(value.width), height: Math.round(value.height) }
    }
    return this.viewport
  }

  /**
   * Refresh url/title/readyState in one round trip; emit a change on any
   * difference. `Target.targetInfoChanged` is not reliable for title updates on
   * background targets (Chrome can coalesce them until detach), so the panel
   * refreshes this cached metadata itself.
   */
  async refreshMetadata() {
    if (this.closed) return
    const value = await this.evaluate('({ url: location.href, title: document.title, ready: document.readyState })')
    if (!value || typeof value !== 'object') return
    let changed = false
    if (typeof value.url === 'string' && value.url.length > 0 && value.url !== this.url) {
      this.url = value.url
      changed = true
    }
    if (typeof value.title === 'string' && value.title !== this.title) {
      this.title = value.title
      changed = true
    }
    const status = value.ready === 'complete' ? 'ready' : 'loading'
    if (status !== this.status) {
      this.status = status
      changed = true
    }
    if (changed) this._emitChange()
  }

  /** Poll until `document.readyState === 'complete'` (bounded), then refresh metadata. */
  async waitForReady(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (!this.closed && Date.now() < deadline) {
      try {
        if ((await this.evaluate('document.readyState')) === 'complete') {
          await this.refreshMetadata().catch(() => {})
          return true
        }
      } catch {
        // The execution context is swapped mid-navigation; retry until the deadline.
      }
      await sleep(40)
    }
    await this.refreshMetadata().catch(() => {})
    return false
  }

  async _refreshTitle() {
    const value = await this.evaluate('document.title')
    if (typeof value === 'string' && value !== this.title) {
      this.title = value
      this._emitChange()
    }
  }

  async _refreshHistory() {
    try {
      const history = await this.cdp.send('Page.getNavigationHistory', {}, this.sessionId)
      const entries = Array.isArray(history?.entries) ? history.entries : []
      const index = Number(history?.currentIndex) || 0
      const canGoBack = index > 0
      const canGoForward = index < entries.length - 1
      if (canGoBack !== this.canGoBack || canGoForward !== this.canGoForward) {
        this.canGoBack = canGoBack
        this.canGoForward = canGoForward
        this._emitChange()
      }
    } catch {
      // A target that just closed answers with a protocol error; state stays stale on purpose.
    }
  }

  _setStatus(status) {
    if (this.status === status) return
    this.status = status
    this._emitChange()
  }

  _emitChange() {
    if (this.closed) return
    try { this.onChange?.(this) } catch (err) {
      console.error('[browser-panel] tab change handler threw:', err)
    }
  }

  /** Browser-scope `Target.targetInfoChanged` update. */
  applyTargetInfo(info) {
    if (!info || this.closed) return
    let changed = false
    if (typeof info.url === 'string' && info.url && info.url !== this.url) {
      // about:blank is the initial value; adopt the first real URL silently.
      this.url = info.url
      changed = true
    }
    if (typeof info.title === 'string' && info.title !== this.title) {
      this.title = info.title
      changed = true
    }
    if (changed) this._emitChange()
  }

  /** Update the viewport from screencast metadata (authoritative CSS size). */
  _applyViewportFromMetadata(meta) {
    const width = Number(meta?.deviceWidth)
    const height = Number(meta?.deviceHeight)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    if (this.viewport.width === Math.round(width) && this.viewport.height === Math.round(height)) return
    this.viewport = { width: Math.round(width), height: Math.round(height) }
    this._emitChange()
  }

  /** Evaluate one expression in the page and return its value by value. */
  async evaluate(expression, opts = {}) {
    const { returnByValue = true, awaitPromise = false, timeout = this.options.evaluateTimeoutMs } = opts
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise,
      userGesture: false,
      includeCommandLineAPI: false,
    }, this.sessionId, { timeout })
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails
      const description = details.exception?.description ?? details.text ?? 'evaluation failed'
      throw new CDPError(`Runtime.evaluate threw: ${String(description).split('\n')[0]}`)
    }
    return returnByValue ? result?.result?.value : result?.result
  }

  // ---- navigation ----------------------------------------------------------

  async navigate(rawUrl) {
    const url = normalizePanelUrl(rawUrl)
    this._setStatus('loading')
    const result = await this.cdp.send('Page.navigate', { url }, this.sessionId, { timeout: 20_000 })
    if (result?.errorText) {
      this._setStatus('ready')
      throw new CDPError(`navigation failed: ${result.errorText}`, 'nav-rejected')
    }
    if (result?.frameId) this.mainFrameId = result.frameId
    this.url = url
    this._emitChange()
    return this
  }

  async goBack() {
    const history = await this.cdp.send('Page.getNavigationHistory', {}, this.sessionId)
    const entries = Array.isArray(history?.entries) ? history.entries : []
    const index = Number(history?.currentIndex) || 0
    if (index <= 0) return this
    this._setStatus('loading')
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entries[index - 1].id }, this.sessionId)
    this._refreshHistory().catch(() => {})
    return this
  }

  async goForward() {
    const history = await this.cdp.send('Page.getNavigationHistory', {}, this.sessionId)
    const entries = Array.isArray(history?.entries) ? history.entries : []
    const index = Number(history?.currentIndex) || 0
    if (index >= entries.length - 1) return this
    this._setStatus('loading')
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entries[index + 1].id }, this.sessionId)
    this._refreshHistory().catch(() => {})
    return this
  }

  async reload() {
    this._setStatus('loading')
    await this.cdp.send('Page.reload', { ignoreCache: false }, this.sessionId)
    return this
  }

  /**
   * Resize by device-metrics override. The screencast metadata follows the
   * override, so the mapping scale is recomputed from the next frame.
   */
  async resize(width, height) {
    const w = Math.round(requireFinite(width, 'width'))
    const h = Math.round(requireFinite(height, 'height'))
    if (w < 100 || w > 4000 || h < 100 || h > 4000) {
      throw new BrowserPanelError('width/height must be between 100 and 4000', 'bad-request')
    }
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h,
    }, this.sessionId)
    await this._refreshViewport().catch(() => {})
    this._emitChange()
    return this.viewport
  }

  // ---- input (CSS pixels) --------------------------------------------------

  async mouse({ type, x, y, button = 'left', clickCount = 1 }) {
    const px = requireFinite(x, 'x')
    const py = requireFinite(y, 'y')
    const kind = String(type || '')
    if (kind !== 'move' && kind !== 'down' && kind !== 'up') {
      throw new BrowserPanelError('mouse type must be move|down|up', 'bad-request')
    }
    const btn = normalizeButton(button)
    const params = {
      type: kind === 'move' ? 'mouseMoved' : kind === 'down' ? 'mousePressed' : 'mouseReleased',
      x: px,
      y: py,
      button: kind === 'move' ? 'none' : btn,
      buttons: kind === 'move' ? (btn === 'left' ? 1 : btn === 'right' ? 2 : btn === 'middle' ? 4 : 0) : (kind === 'down' ? buttonMask(btn) : 0),
      clickCount: Math.max(1, Math.min(3, Math.round(Number(clickCount) || 1))),
      modifiers: 0,
    }
    await this.cdp.send('Input.dispatchMouseEvent', params, this.sessionId)
    return { ok: true }
  }

  /** Full click (press+release, or press/release twice for clickCount 2). */
  async clickAt(x, y, { button = 'left', clickCount = 1 } = {}) {
    const px = requireFinite(x, 'x')
    const py = requireFinite(y, 'y')
    const btn = normalizeButton(button)
    const clicks = Math.max(1, Math.min(2, Math.round(Number(clickCount) || 1)))
    // A preceding move makes the renderer see the pointer before the press.
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0, modifiers: 0,
    }, this.sessionId).catch(() => {})
    for (let index = 1; index <= clicks; index++) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: px, y: py, button: btn, buttons: buttonMask(btn), clickCount: index, modifiers: 0,
      }, this.sessionId)
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: px, y: py, button: btn, buttons: 0, clickCount: index, modifiers: 0,
      }, this.sessionId)
    }
    return { ok: true }
  }

  /**
   * Wheel scroll. Chrome 156 has no `Input.dispatchWheelEvent`; the verified
   * replacement is `Input.dispatchMouseEvent({ type: 'mouseWheel' })`.
   */
  async wheel({ x, y, deltaX = 0, deltaY = 0 }) {
    const px = requireFinite(x, 'x')
    const py = requireFinite(y, 'y')
    const dx = requireFinite(deltaX ?? 0, 'deltaX')
    const dy = requireFinite(deltaY ?? 0, 'deltaY')
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0, modifiers: 0,
    }, this.sessionId).catch(() => {})
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: px, y: py, deltaX: dx, deltaY: dy, buttons: 0, modifiers: 0,
    }, this.sessionId)
    return { ok: true }
  }

  async key({ type, key, code, keyCode, text, modifiers }) {
    const kind = String(type || '')
    if (kind !== 'down' && kind !== 'up') throw new BrowserPanelError('key type must be down|up', 'bad-request')
    const keyName = typeof key === 'string' && key.length > 0 ? key : 'Unidentified'
    const codeName = typeof code === 'string' ? code : ''
    const virtualKeyCode = resolveVirtualKeyCode(keyName, codeName, keyCode)
    const params = {
      type: kind === 'down' ? 'keyDown' : 'keyUp',
      key: keyName,
      code: codeName,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      modifiers: modifierMask(modifiers),
    }
    if (kind === 'down' && typeof text === 'string' && text.length > 0) {
      params.text = text
      params.unmodifiedText = text
    }
    await this.cdp.send('Input.dispatchKeyEvent', params, this.sessionId)
    return { ok: true }
  }

  async insertText(value) {
    const text = typeof value === 'string' ? value : ''
    if (text.length === 0) return { ok: true }
    if (text.length > 100_000) throw new BrowserPanelError('text is too large', 'bad-request')
    await this.cdp.send('Input.insertText', { text }, this.sessionId)
    return { ok: true }
  }

  // ---- picker --------------------------------------------------------------

  /**
   * Always-on hover probe for pointer feedback: the element's rect, a compact
   * label, its tag and the page's own CSS cursor. Unlike `hoverAt` it never
   * throws for an empty point and is not tied to pick mode, so the panel can
   * mirror hover feedback on every pointer move.
   */
  async probeAt(x, y) {
    const empty = { hit: false, rect: null, label: null, tag: null, cursor: 'default' }
    let px
    let py
    try {
      px = requireFinite(x, 'x')
      py = requireFinite(y, 'y')
    } catch {
      return empty
    }
    let raw
    try {
      raw = await this.evaluate(`(${HOVER_SOURCE})(${px}, ${py})`)
    } catch {
      return empty
    }
    if (!raw || raw.found !== true) return empty
    return {
      hit: true,
      rect: normalizeRect(raw.rect),
      label: buildHoverLabel(raw),
      tag: raw.tag || null,
      cursor: typeof raw.cursor === 'string' && raw.cursor.length > 0 ? raw.cursor : 'default',
    }
  }

  /** Lightweight hover descriptor: rect + `tag#id.class` label. */
  async hoverAt(x, y) {
    const px = requireFinite(x, 'x')
    const py = requireFinite(y, 'y')
    const raw = await this.evaluate(`(${HOVER_SOURCE})(${px}, ${py})`)
    if (!raw || raw.found !== true) return { rect: null, label: '' }
    return { rect: normalizeRect(raw.rect), label: buildHoverLabel(raw) }
  }

  /**
   * Full pick descriptor from ONE `Runtime.evaluate` of `elementFromPoint`.
   * The returned `selector` is the document-scoped CSS path that the page
   * itself verified with `querySelector(selector) === element`.
   */
  async pickAt(x, y, { sessionId = '' } = {}) {
    const px = requireFinite(x, 'x')
    const py = requireFinite(y, 'y')
    let raw
    try {
      raw = await this.evaluate(`(${PICK_SOURCE})(${px}, ${py})`)
    } catch (err) {
      throw new PickFailedError(`element pick failed: ${err?.message ?? err}`)
    }
    if (!raw || raw.found !== true) {
      throw new PickFailedError(raw?.reason || 'no element at that point')
    }
    const selector = raw.selectorMatchesSelf && raw.selector ? raw.selector : (raw.selector || '')
    const pick = {
      pickId: `p-${randomUUID()}`,
      sessionId: String(sessionId || ''),
      tabId: this.tabId,
      url: String(raw.url || this.url || ''),
      pageTitle: String(raw.title || this.title || ''),
      selector: String(selector),
      tag: String(raw.tag || ''),
      id: String(raw.id || ''),
      classes: Array.isArray(raw.classes) ? raw.classes.map(String) : [],
      role: String(raw.role || ''),
      accessibleName: String(raw.accessibleName || ''),
      text: String(raw.text || '').slice(0, 200),
      rect: normalizeRect(raw.rect),
      attrs: raw.attrs && typeof raw.attrs === 'object' && !Array.isArray(raw.attrs) ? raw.attrs : {},
      ancestors: (Array.isArray(raw.ancestry) ? raw.ancestry : []).slice(0, 4).map((node) => ({
        tag: String(node?.tag || ''),
        id: String(node?.id || ''),
        classes: Array.isArray(node?.classes) ? node.classes.map(String) : [],
      })),
      outerHTML: String(raw.outerHTML || '').slice(0, 800),
      ts: Date.now(),
    }
    pick.contextText = buildContextText(pick)
    return pick
  }

  // ---- screenshot ----------------------------------------------------------

  async screenshot({ format = 'jpeg', quality } = {}) {
    const fmt = format === 'png' ? 'png' : 'jpeg'
    const params = { format: fmt, fromSurface: true, captureBeyondViewport: false }
    if (fmt === 'jpeg') params.quality = clampInt(quality ?? this.options.quality, 1, 100)
    const result = await this.cdp.send('Page.captureScreenshot', params, this.sessionId, { timeout: 20_000 })
    const data = String(result?.data || '')
    if (!data) throw new CDPError('Page.captureScreenshot returned no data')
    return { dataUrl: `data:image/${fmt};base64,${data}`, format: fmt, base64: data }
  }

  // ---- screencast ----------------------------------------------------------

  /**
   * Subscribe one frame consumer. The screencast runs while at least one sink
   * exists; the newest frame wins and delivery is throttled to `fps`.
   * @param {(frame: object) => void} sink
   * @returns {() => void} unsubscribe
   */
  subscribeFrames(sink) {
    this.sinks.add(sink)
    if (this.sinks.size === 1) {
      this.lastFrameAt = Date.now()
      this._startScreencast()
      this._startKeepalive()
    }
    if (this.latestFrame !== null && Date.now() - this.latestFrame.ts < 5000) {
      try { sink(this.latestFrame) } catch (err) {
        console.error('[browser-panel] frame sink threw:', err)
      }
    }
    return () => {
      this.sinks.delete(sink)
      if (this.sinks.size === 0) {
        this._stopKeepalive()
        this._stopScreencast()
      }
    }
  }

  _startScreencast() {
    if (this.closed || this.screencastOn) return
    this.screencastOn = true
    this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: clampInt(this.options.quality, 1, 100),
      maxWidth: Math.max(1, Math.round(this.options.maxWidth)),
      maxHeight: Math.max(1, Math.round(this.options.maxHeight)),
      everyNthFrame: 1,
    }, this.sessionId).catch((err) => {
      this.screencastOn = false
      console.error('[browser-panel] startScreencast failed:', err)
    })
  }

  _stopScreencast() {
    if (!this.screencastOn) return
    this.screencastOn = false
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    this.pendingFrame = null
    this.cdp.send('Page.stopScreencast', {}, this.sessionId).catch(() => {})
  }

  _handleScreencastFrame(params) {
    // Ack FIRST, on the target session, with the event's own integer session id:
    // Chrome stops producing frames until every frame is acknowledged.
    const ackId = params?.sessionId
    if (ackId !== undefined) {
      this.cdp.send('Page.screencastFrameAck', { sessionId: ackId }, this.sessionId).catch(() => {})
    }
    const data = typeof params?.data === 'string' ? params.data : ''
    if (!data) return
    this.lastFrameAt = Date.now()
    this._applyViewportFromMetadata(params?.metadata)
    const image = jpegSize(Buffer.from(data, 'base64'))
    const frame = {
      seq: ++this.frameSeq,
      w: image?.width ?? this.viewport.width,
      h: image?.height ?? this.viewport.height,
      data,
      viewport: { width: this.viewport.width, height: this.viewport.height },
      ts: Date.now(),
    }
    this.latestFrame = frame
    this._queueFrame(frame)
  }

  /** Throttle to `fps`: send now, or keep only the newest pending frame. */
  _queueFrame(frame) {
    const now = Date.now()
    const minGap = this.options.fps > 0 ? 1000 / this.options.fps : 0
    const wait = this.lastSentAt + minGap - now
    if (wait <= 0) {
      this._sendFrame(frame)
      return
    }
    this.pendingFrame = frame
    if (this.pendingTimer) return
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const pending = this.pendingFrame
      this.pendingFrame = null
      if (pending) this._sendFrame(pending)
    }, wait)
    this.pendingTimer.unref?.()
  }

  _sendFrame(frame) {
    if (this.closed || this.sinks.size === 0) return
    this.lastSentAt = Date.now()
    for (const sink of [...this.sinks]) {
      try { sink(frame) } catch (err) {
        console.error('[browser-panel] frame sink threw:', err)
      }
    }
  }

  _startKeepalive() {
    if (this.keepaliveTimer) return
    this.keepaliveTimer = setInterval(() => { void this._maybeKeepalive() }, 200)
    this.keepaliveTimer.unref?.()
  }

  _stopKeepalive() {
    if (!this.keepaliveTimer) return
    clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  /**
   * Additive liveness for static pages: the screencast only emits on page
   * damage, so after `keepaliveIdleMs` without a real frame we capture one JPEG
   * at most every `keepaliveMinMs` and emit it as a normal frame marked
   * `keepalive: true`. Only runs while this tab has subscribers.
   */
  async _maybeKeepalive() {
    if (this.closed || this.sinks.size === 0 || this.captureInFlight) return
    const now = Date.now()
    if (now - this.lastFrameAt < this.options.keepaliveIdleMs) return
    if (now - this.lastCaptureAt < this.options.keepaliveMinMs) return
    this.captureInFlight = true
    this.lastCaptureAt = now
    try {
      const result = await this.cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: clampInt(this.options.quality, 1, 100),
        fromSurface: true,
        captureBeyondViewport: false,
      }, this.sessionId, { timeout: 8000 })
      const data = String(result?.data || '')
      if (!data) return
      const image = jpegSize(Buffer.from(data, 'base64'))
      const frame = {
        seq: ++this.frameSeq,
        w: image?.width ?? this.viewport.width,
        h: image?.height ?? this.viewport.height,
        data,
        viewport: { width: this.viewport.width, height: this.viewport.height },
        ts: Date.now(),
        keepalive: true,
      }
      this.latestFrame = frame
      this._sendFrame(frame)
    } catch {
      // Failure is non-fatal: the next tick retries while subscribers exist.
    } finally {
      this.captureInFlight = false
    }
  }

  // ---- state / dispose -----------------------------------------------------

  /** The CONTRACT.md tab row. */
  snapshot() {
    return {
      tabId: this.tabId,
      url: this.url,
      title: this.title,
      status: this.status,
      viewport: { width: this.viewport.width, height: this.viewport.height },
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
    }
  }

  async dispose() {
    if (this.closed) return
    this.closed = true
    this._stopKeepalive()
    this._stopScreencast()
    this.sinks.clear()
    for (const off of this.disposers) {
      try { off() } catch { /* ignore */ }
    }
    this.disposers = []
    try { await this.cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }) } catch { /* target may be gone */ }
  }
}

function normalizeButton(button) {
  return button === 'right' || button === 'middle' ? button : 'left'
}

function buttonMask(button) {
  return button === 'right' ? 2 : button === 'middle' ? 4 : 1
}

function modifierMask(modifiers) {
  if (!modifiers || typeof modifiers !== 'object') return 0
  let mask = 0
  if (modifiers.alt) mask |= 1
  if (modifiers.ctrl) mask |= 2
  if (modifiers.meta) mask |= 4
  if (modifiers.shift) mask |= 8
  return mask
}

const VIRTUAL_KEYS = {
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, ' ': 32, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20,
}

function resolveVirtualKeyCode(key, code, keyCode) {
  if (Number.isFinite(Number(keyCode)) && Number(keyCode) > 0) return Math.round(Number(keyCode))
  if (VIRTUAL_KEYS[key] !== undefined) return VIRTUAL_KEYS[key]
  if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1))
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5)
  if (key.length === 1) {
    const upper = key.toUpperCase()
    if (/^[A-Z]$/.test(upper)) return upper.charCodeAt(0)
    if (/^[0-9]$/.test(key)) return key.charCodeAt(0)
  }
  return 0
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

// ---------------------------------------------------------------------------
// Browser: one Chrome process + its page targets
// ---------------------------------------------------------------------------

/** Chrome defaults for the panel. */
const BROWSER_DEFAULTS = {
  headless: true,
  width: 1280,
  height: 800,
  maxTabs: 4,
  quality: 55,
  maxWidth: 1280,
  maxHeight: 800,
  fps: 20,
  readyTimeoutMs: 25_000,
}

/**
 * One Chrome process per Session. Owns the CDP connection, the tab map
 * (tabId `t1..tN` -> attached page target), and the active tab.
 */
export class Browser {
  /**
   * Launch Chrome and connect CDP.
   * @param {object} [options] Chrome + stream options
   * @returns {Promise<Browser>}
   */
  static async launch(options = {}) {
    const resolved = { ...BROWSER_DEFAULTS, ...options }
    const chrome = await launchChrome({
      headless: resolved.headless !== false,
      executablePath: resolved.executablePath,
      extraArgs: Array.isArray(resolved.chromeArgs) ? resolved.chromeArgs : [],
      width: resolved.width,
      height: resolved.height,
      readyTimeoutMs: resolved.readyTimeoutMs,
      env: resolved.env,
    })
    let cdp
    try {
      cdp = await CDP.connect(chrome.browserWsUrl, { connectTimeout: resolved.readyTimeoutMs })
    } catch (err) {
      await chrome.kill()
      throw err
    }
    const browser = new Browser(cdp, chrome, resolved)
    await browser.prepare()
    return browser
  }

  constructor(cdp, chrome, options = {}) {
    this.cdp = cdp
    this.chrome = chrome
    this.options = { ...BROWSER_DEFAULTS, ...options }
    this.tabs = new Map()
    this.tabOrder = []
    this.nextTabNumber = 1
    this.activeTabId = null
    this.closed = false
    /** Called on every tab state change; the owner broadcasts `status`. */
    this.onChange = null
    /** Called when Chrome exits unexpectedly (not during dispose). */
    this.onExit = null

    this.disposers = []
    this.metadataTimer = null
    this.metadataInFlight = false
    this.disposers.push(this.cdp.on('Target.targetInfoChanged', (params) => {
      const info = params?.targetInfo
      if (!info) return
      const tab = this._tabByTargetId(info.targetId)
      if (tab) tab.applyTargetInfo(info)
    }))
    this.disposers.push(this.cdp.on('Target.targetDestroyed', (params) => {
      const tab = this._tabByTargetId(params?.targetId)
      if (tab) {
        this._removeTab(tab)
        this.onChange?.()
      }
    }))
    this.disposers.push(this.cdp.on('Target.targetCrashed', (params) => {
      const tab = this._tabByTargetId(params?.targetId)
      if (tab) {
        tab.status = 'ready'
        tab.title = 'Page crashed'
        tab._emitChange()
      }
    }))

    const proc = chrome.proc
    proc?.on('exit', (code, signal) => {
      if (this.closed) return
      this.closed = true
      try { this.onExit?.({ code, signal }) } catch (err) {
        console.error('[browser-panel] browser exit handler threw:', err)
      }
    })
  }

  /** Enable target discovery (targetInfoChanged/targetDestroyed events). */
  async prepare() {
    try {
      await this.cdp.send('Target.setDiscoverTargets', { discover: true })
    } catch {
      // Optional: newer Chrome versions still deliver targetInfoChanged.
    }
    try {
      const { targetInfos } = await this.cdp.send('Target.getTargets')
      for (const info of targetInfos ?? []) {
        if (info.type !== 'page') continue
        // Adopt Chrome's startup about:blank target instead of leaking it.
        await this._adopt(info)
        break
      }
    } catch {
      // No adoptable target: ensureTab() creates one on demand.
    }
    this._startMetadataPoll()
    return this
  }

  /**
   * Keep cached url/title/status fresh while the panel is watching or the tab
   * is active. A static page produces no CDP events for a title change, so the
   * panel must poll; this is cheap (one Runtime.evaluate per tab per tick).
   */
  _startMetadataPoll() {
    if (this.metadataTimer !== null) return
    this.metadataTimer = setInterval(() => { void this._pollMetadata() }, 1500)
    this.metadataTimer.unref?.()
  }

  async _pollMetadata() {
    if (this.closed || this.metadataInFlight) return
    this.metadataInFlight = true
    try {
      for (const tab of [...this.tabs.values()]) {
        if (this.closed) break
        if (tab.sinks.size === 0 && tab.tabId !== this.activeTabId) continue
        await tab.refreshMetadata().catch(() => { /* tab mid-navigation or closing */ })
      }
    } finally {
      this.metadataInFlight = false
    }
  }

  get alive() {
    return !this.closed && this.chrome.exited() !== true
  }

  /** Full tab rows in creation order. */
  rows() {
    return this.tabOrder
      .map((tabId) => this.tabs.get(tabId))
      .filter((tab) => tab !== undefined)
      .map((tab) => ({ ...tab.snapshot(), active: tab.tabId === this.activeTabId }))
  }

  getTab(tabId) {
    return typeof tabId === 'string' ? this.tabs.get(tabId) : undefined
  }

  activeTab() {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (tab) return tab
    const first = this.tabOrder[0]
    return first ? this.tabs.get(first) : undefined
  }

  /** Activate one existing tab, bringing the Chrome tab to the front. */
  setActive(tabId) {
    const tab = this.getTab(tabId)
    if (!tab) throw new NoTabError(`unknown tab: ${tabId}`)
    this.activeTabId = tab.tabId
    this.cdp.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {})
    this.onChange?.()
    return tab
  }

  /**
   * Ensure a tab exists (adopt the startup target, else create one).
   * @param {string} [url] initial URL for a newly created tab
   * @returns {Promise<Tab>}
   */
  async ensureTab(url) {
    const existing = this.activeTab() ?? this.tabOrder.map((id) => this.tabs.get(id)).find(Boolean)
    if (existing) return existing
    return this.createTab(url ?? 'about:blank', { activate: true })
  }

  /**
   * Create one page target and attach it in flatten mode.
   * @param {string} url
   * @param {{activate?: boolean}} [opts]
   */
  async createTab(url, opts = {}) {
    if (this.closed) throw new NoChromeError('Chrome is not running')
    if (this.tabs.size >= this.options.maxTabs) {
      throw new TabLimitError(`tab limit reached (${this.options.maxTabs})`)
    }
    const normalized = url === undefined || url === null || url === '' ? 'about:blank' : normalizePanelUrl(url)
    const created = await this.cdp.send('Target.createTarget', { url: normalized })
    const attached = await this.cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    const tab = new Tab(this, {
      tabId: `t${this.nextTabNumber++}`,
      targetId: created.targetId,
      sessionId: attached.sessionId,
    }, this.tabOptions())
    tab.onChange = () => this.onChange?.()
    await tab.init()
    if (normalized !== 'about:blank') await tab.waitForReady(8000)
    this.tabs.set(tab.tabId, tab)
    this.tabOrder.push(tab.tabId)
    if (opts.activate !== false || this.activeTabId === null) {
      this.activeTabId = tab.tabId
      this.cdp.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {})
    }
    this.onChange?.()
    return tab
  }

  /** Attach an existing page target (Chrome's startup tab). */
  async _adopt(info) {
    if (this.closed) return null
    if (this.tabs.size >= this.options.maxTabs) throw new TabLimitError(`tab limit reached (${this.options.maxTabs})`)
    const attached = await this.cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
    const tab = new Tab(this, {
      tabId: `t${this.nextTabNumber++}`,
      targetId: info.targetId,
      sessionId: attached.sessionId,
    }, this.tabOptions())
    tab.onChange = () => this.onChange?.()
    await tab.init()
    if (info.url && info.url !== 'about:blank') tab.url = info.url
    if (info.title) tab.title = info.title
    this.tabs.set(tab.tabId, tab)
    this.tabOrder.push(tab.tabId)
    if (this.activeTabId === null) this.activeTabId = tab.tabId
    this.onChange?.()
    return tab
  }

  tabOptions() {
    return {
      quality: this.options.quality,
      maxWidth: this.options.maxWidth,
      maxHeight: this.options.maxHeight,
      fps: this.options.fps,
    }
  }

  /** Close one tab target; the caller decides the next active tab. */
  async closeTab(tabId) {
    const tab = this.getTab(tabId)
    if (!tab) throw new NoTabError(`unknown tab: ${tabId}`)
    await tab.dispose()
    await this.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {})
    this._removeTab(tab)
    this.onChange?.()
    return { closed: true }
  }

  _removeTab(tab) {
    this.tabs.delete(tab.tabId)
    this.tabOrder = this.tabOrder.filter((id) => id !== tab.tabId)
    if (this.activeTabId === tab.tabId) this.activeTabId = this.tabOrder[0] ?? null
  }

  _tabByTargetId(targetId) {
    if (!targetId) return undefined
    for (const tab of this.tabs.values()) {
      if (tab.targetId === targetId) return tab
    }
    return undefined
  }

  /** Stop streaming, close targets, close CDP, and kill the process group. */
  async dispose() {
    if (this.closed) {
      await this.chrome.kill().catch(() => {})
      return
    }
    this.closed = true
    if (this.metadataTimer !== null) { clearInterval(this.metadataTimer); this.metadataTimer = null }
    for (const off of this.disposers) {
      try { off() } catch { /* ignore */ }
    }
    this.disposers = []
    for (const tab of [...this.tabs.values()]) {
      try { await tab.dispose() } catch { /* ignore */ }
    }
    this.tabs.clear()
    this.tabOrder = []
    this.activeTabId = null
    try { await this.cdp.close() } catch { /* ignore */ }
    // Kill the whole process group last: zygote/renderer/GPU children die too.
    await this.chrome.kill().catch(() => {})
  }
}