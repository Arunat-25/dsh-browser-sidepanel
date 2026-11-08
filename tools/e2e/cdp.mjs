// cdp.mjs — dependency-free Chrome DevTools Protocol client + Chrome launcher.
//
// PROVENANCE: verbatim copy of browser-panel/probe/cdp.mjs (the verified CDP
// prototype: launch flags, DevToolsActivePort discovery, flattened target
// sessions, screencast ack, JPEG SOF parsing). Copied into the e2e harness scope
// so the verifier owns its own client and the probe can keep evolving.
// Node >= 22 required (global WebSocket + fetch). Verified on Node 24.
//
//   import { CDP, launchChrome, readDevToolsActivePort, jpegSize } from './cdp.mjs';
//
//   const chrome = await launchChrome({ headless: true });
//   const cdp = await CDP.connect(chrome.browserWsUrl);
//   const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
//   const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
//   await cdp.send('Page.enable', {}, sessionId);
//   cdp.on('Page.screencastFrame', (p, meta) => {
//     // p.sessionId  -> screencast id, echo it in screenCastFrameAck
//     // meta.sessionId -> CDP target session (flatten mode envelope)
//     cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, meta.sessionId);
//   });
//
// Key protocol subtleties are documented in report.md.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDPError extends Error {
  constructor(msg) { super(msg); this.name = 'CDPError'; }
}
export class CDPTimeoutError extends CDPError {
  constructor(msg) { super(msg); this.name = 'CDPTimeoutError'; }
}
export class CDPClosedError extends CDPError {
  constructor(msg) { super(msg); this.name = 'CDPClosedError'; }
}
/** Chrome replied with a protocol-level error object. */
export class CDPProtocolError extends CDPError {
  constructor(method, error) {
    super(`${method} failed: ${error?.message ?? JSON.stringify(error)} (code ${error?.code})`);
    this.name = 'CDPProtocolError';
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

/**
 * Minimal CDP client.
 *
 * - `send(method, params?, sessionId?, { timeout }?)` resolves with `result`
 *   and rejects on protocol error, socket close, or timeout.
 * - `on(event, handler, { sessionId }?)` -> unsubscribe fn. `handler(params, meta)`
 *   where `meta = { method, sessionId }`. sessionId is undefined for
 *   browser-scoped events.
 * - flatten:true sessions put the target session id in the top-level
 *   `sessionId` field of every message in both directions; this class forwards
 *   it verbatim.
 */
export class CDP {
  constructor(ws, opts = {}) {
    this._ws = ws;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, method, timer }
    this._handlers = new Set(); // { event, handler, sessionId }
    this._closed = false;
    this._closeError = null;
    this.defaultTimeout = opts.timeout ?? 30_000;
    /** Optional debug sink: (direction, payload) => void */
    this.trace = opts.trace ?? null;

    this._onMessage = this._onMessage.bind(this);
    this._onClose = this._onClose.bind(this);
    ws.addEventListener('message', this._onMessage);
    ws.addEventListener('close', () => this._onClose(new CDPClosedError('CDP socket closed')));
    ws.addEventListener('error', () => this._onClose(new CDPClosedError('CDP socket error')));
    ws.addEventListener('open', () => { /* already open when CDP.connect returns */ });
  }

  /** Connect to a `ws://...` DevTools URL. */
  static async connect(url, opts = {}) {
    const { connectTimeout = 10_000 } = opts;
    if (typeof WebSocket === 'undefined') {
      throw new CDPError('global WebSocket missing: needs Node >= 22');
    }
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new CDPTimeoutError(`WebSocket connect timeout after ${connectTimeout}ms: ${url}`)),
        connectTimeout,
      );
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CDPClosedError(`WebSocket connect failed: ${url}`));
      }, { once: true });
    });
    return new CDP(ws, opts);
  }

  get closed() { return this._closed; }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] flattened target session; omit for browser scope
   * @param {{timeout?: number}} [opts]
   */
  send(method, params = {}, sessionId = undefined, opts = {}) {
    if (this._closed) {
      return Promise.reject(this._closeError ?? new CDPClosedError('CDP connection is closed'));
    }
    const id = this._nextId++;
    const payload = { id, method, params: params ?? {} };
    if (sessionId) payload.sessionId = sessionId;
    const timeout = opts.timeout ?? this.defaultTimeout;

    return new Promise((resolve, reject) => {
      const timer = timeout > 0
        ? setTimeout(() => {
            this._pending.delete(id);
            reject(new CDPTimeoutError(
              `${method} timed out after ${timeout}ms (scope=${sessionId ?? 'browser'})`,
            ));
          }, timeout)
        : null;
      this._pending.set(id, { resolve, reject, method, timer });
      try {
        if (this.trace) this.trace('out', payload);
        this._ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new CDPClosedError(`send failed for ${method}: ${err?.message ?? err}`));
      }
    });
  }

  /**
   * Subscribe to a CDP event. Use '*' to see every event.
   * @returns {() => void} unsubscribe
   */
  on(event, handler, { sessionId } = {}) {
    const entry = { event, handler, sessionId };
    this._handlers.add(entry);
    return () => this._handlers.delete(entry);
  }

  /** Resolve with the first matching event's params. */
  waitFor(event, { predicate, timeout = 10_000, sessionId } = {}) {
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        reject(new CDPTimeoutError(`waitFor(${event}) timed out after ${timeout}ms`));
      }, timeout);
      off = this.on(event, (params, meta) => {
        if (predicate && !predicate(params, meta)) return;
        clearTimeout(timer);
        off();
        resolve({ params, meta });
      }, { sessionId });
    });
  }

  /** Resolve with a promise that settles when the socket closes. */
  closedPromise() {
    if (this._closed) return Promise.resolve(this._closeError);
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this._closed) { clearInterval(check); resolve(this._closeError); }
      }, 50);
      check.unref?.();
    });
  }

  async close() {
    if (this._closed) return;
    try { this._ws.close(); } catch { /* ignore */ }
    this._onClose(new CDPClosedError('closed locally'));
  }

  // ---- internals -----------------------------------------------------------

  _onMessage(ev) {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '');
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (this.trace) this.trace('in', msg);

    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this._pending.get(msg.id);
      if (!entry) return;
      this._pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) entry.reject(new CDPProtocolError(entry.method, msg.error));
      else entry.resolve(msg.result ?? {});
      return;
    }

    if (msg.method) {
      const meta = { method: msg.method, sessionId: msg.sessionId };
      for (const h of [...this._handlers]) {
        if (h.event !== '*' && h.event !== msg.method) continue;
        if (h.sessionId && h.sessionId !== msg.sessionId) continue;
        try { h.handler(msg.params ?? {}, meta); }
        catch (err) { console.error(`[cdp] handler for ${msg.method} threw:`, err); }
      }
    }
  }

  _onClose(err) {
    if (this._closed) return;
    this._closed = true;
    this._closeError = err;
    for (const [, entry] of this._pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Chrome launcher
// ---------------------------------------------------------------------------

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/opt/google/chrome/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new CDPError(`no Chrome binary found in: ${CHROME_CANDIDATES.join(', ')}`);
}

/**
 * Read `<userDataDir>/DevToolsActivePort`.
 *
 * File format (2 lines, second line may lack a trailing newline):
 *   line 1: the actual TCP port Chrome bound (authoritative when you passed port 0)
 *   line 2: the browser-level WebSocket path, e.g. /devtools/browser/<uuid>
 *
 * The file can appear before line 2 is flushed, so poll until both lines exist.
 */
export async function readDevToolsActivePort(userDataDir, { timeoutMs = 25_000, pollMs = 40, isDead } = {}) {
  const file = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (isDead?.()) {
      throw new CDPClosedError(`Chrome exited before writing ${file}`);
    }
    try {
      const raw = await readFile(file, 'utf8');
      last = raw;
      const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length >= 1 && /^\d+$/.test(lines[0])) {
        if (lines.length >= 2 && lines[1].startsWith('/devtools/')) {
          return { port: Number(lines[0]), wsPath: lines[1], raw, file };
        }
        // Port known but path not flushed yet -> can still recover via /json/version.
        try {
          const res = await fetch(`http://127.0.0.1:${lines[0]}/json/version`, {
            signal: AbortSignal.timeout(1000),
          });
          if (res.ok) {
            const v = await res.json();
            if (v.webSocketDebuggerUrl) {
              const u = new URL(v.webSocketDebuggerUrl);
              return {
                port: Number(lines[0]),
                wsPath: u.pathname,
                raw,
                file,
                recoveredFromHttp: true,
              };
            }
          }
        } catch { /* keep polling */ }
      }
    } catch (err) {
      last = last ?? String(err?.message ?? err);
    }
    await sleep(pollMs);
  }
  throw new CDPTimeoutError(
    `DevToolsActivePort not ready after ${timeoutMs}ms (${file}); last content: ${JSON.stringify(last)}`,
  );
}

/**
 * Spawn Chrome with a fresh temp --user-data-dir and --remote-debugging-port=0.
 * Resolves once DevToolsActivePort is readable.
 *
 * Returns an object with: proc, pid, userDataDir, port, wsPath, browserWsUrl,
 * stderrTail(), stdoutTail(), kill(), plus a `group` handle to kill the whole
 * process group (Chrome's zygotes/renderers must not be orphaned).
 */
export async function launchChrome(opts = {}) {
  const {
    headless = true,
    width = 1280,
    height = 800,
    extraArgs = [],
    executablePath,
    userDataDir: providedDir,
    readyTimeoutMs = 25_000,
    cleanupUserDataDir = false,
    env: extraEnv = {},
    spawnFn = spawn,
  } = opts;

  const bin = executablePath || findChrome();
  const userDataDir = providedDir ?? await mkdtemp(join(tmpdir(), 'dsh-chrome-'));
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
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
    `--window-size=${width},${height}`,
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];

  const t0 = Date.now();
  const proc = spawnFn(bin, args, {
    detached: true, // own process group -> we can kill every descendant
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });

  const stdout = [];
  const stderr = [];
  let exited = false;
  let exitInfo = null;
  proc.stdout?.on('data', (b) => { stdout.push(b.toString()); if (stdout.length > 400) stdout.shift(); });
  proc.stderr?.on('data', (b) => { stderr.push(b.toString()); if (stderr.length > 400) stderr.shift(); });
  proc.on('exit', (code, signal) => { exited = true; exitInfo = { code, signal }; });

  const stderrTail = (n = 25) => stderr.join('').split('\n').filter(Boolean).slice(-n).join('\n');
  const stdoutTail = (n = 25) => stdout.join('').split('\n').filter(Boolean).slice(-n).join('\n');

  const kill = async (signal = 'SIGKILL') => {
    if (exited) return true;
    // Kill the whole group: Chrome's zygote/renderer/GPU children carry the
    // same pgid because we spawned detached.
    try { process.kill(-proc.pid, signal); } catch { /* group already gone */ }
    try { proc.kill(signal); } catch { /* already gone */ }
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(25);
    if (!exited) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* ignore */ }
      const d2 = Date.now() + 3000;
      while (!exited && Date.now() < d2) await sleep(25);
    }
    if (cleanupUserDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    return exited;
  };

  let active;
  try {
    active = await readDevToolsActivePort(userDataDir, {
      timeoutMs: readyTimeoutMs,
      isDead: () => exited,
    });
  } catch (err) {
    const tail = stderrTail(30);
    await kill();
    const e = new CDPError(
      `${err.message}\n--- chrome stderr (tail) ---\n${tail || '(empty)'}`,
    );
    e.cause = err;
    e.stderrTail = tail;
    e.stdoutTail = stdoutTail(10);
    throw e;
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
    readyMs: Date.now() - t0,
    exited: () => exited,
    exitInfo: () => exitInfo,
    stderrTail,
    stdoutTail,
    kill,
  };
}

/**
 * Parse a JPEG's real pixel dimensions from the SOF marker (no deps).
 * Screencast frames are scaled by maxWidth/maxHeight, so the delivered image
 * size is the only reliable source for the image->CSS mapping.
 */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), marker: `0xFF${marker.toString(16).toUpperCase()}` };
    }
    if (marker === 0xda) break; // start of scan
    i += 2 + len;
  }
  return null;
}
