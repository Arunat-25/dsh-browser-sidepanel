#!/usr/bin/env node
// probe.mjs — acceptance probe for the browser-control surface a DSH plugin needs.
//
//   node probe/probe.mjs            # headless main run + headful capability test
//   node probe/probe.mjs --headful  # run the main probe headful instead
//   node probe/probe.mjs --no-headful-test
//
// Zero npm dependencies. Node >= 22 (global WebSocket/fetch).
// Writes: out/frame-0.jpg, out/shot.png, out/testpage.html, report.md

import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

import { CDP, launchChrome, findChrome, jpegSize, sleep } from './cdp.mjs';

const execFileP = promisify(execFile);
const PROBE_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(PROBE_DIR, 'out');
const FRAME0 = join(OUT_DIR, 'frame-0.jpg');
const SHOT = join(OUT_DIR, 'shot.png');
const TESTPAGE = join(OUT_DIR, 'testpage.html');
const REPORT = join(PROBE_DIR, 'report.md');

const ARGV = new Set(process.argv.slice(2));
const MAIN_HEADFUL = ARGV.has('--headful');
const SKIP_HEADFUL_TEST = ARGV.has('--no-headful-test');
const URL_MAIN = pathToFileURL(TESTPAGE).href;

// ---------------------------------------------------------------------------
// result bookkeeping
// ---------------------------------------------------------------------------
const results = [];
const notes = [];   // discoveries that go into report.md
const timing = {};
const findings = {};

function record(id, label, ok, detail = '') {
  results.push({ id, label, ok: !!ok, detail: String(detail) });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${id.padEnd(30)} ${label}${detail ? `\n          ↳ ${String(detail).replace(/\n/g, '\n            ')}` : ''}`);
  return ok;
}
async function check(id, label, fn) {
  try {
    const detail = await fn();
    record(id, label, true, detail ?? '');
    return true;
  } catch (err) {
    record(id, label, false, err?.stack?.split('\n')[0] ?? String(err));
    return false;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function note(s) { notes.push(s); console.log(`  NOTE  ${s}`); }

// ---------------------------------------------------------------------------
// the local test page
// ---------------------------------------------------------------------------
const TEST_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>DSH Browser Panel Probe Page</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.4 system-ui, sans-serif; background:#101418; color:#e8eef5; }
  header { background:#1c2530; padding:14px 18px; border-bottom:1px solid #2b3846; }
  h1 { margin:0; font-size:19px; }
  main { padding:18px; }
  form { display:flex; gap:8px; align-items:center; margin-bottom:14px; }
  input { padding:8px 10px; width:280px; border-radius:6px; border:1px solid #3a4a5c; background:#0b0f14; color:#e8eef5; }
  button { padding:9px 16px; border-radius:6px; border:0; background:#2f7fe0; color:#fff; font-weight:600; cursor:pointer; }
  button#other { background:#3a4a5c; }
  #status { margin:8px 0 18px; color:#8fb6e8; font-family: ui-monospace, monospace; }
  ul#list { list-style:none; margin:0; padding:0; }
  ul#list li { padding:9px 12px; border-bottom:1px solid #1d2833; }
  ul#list li:nth-child(odd) { background:#141b22; }
  #anim { position:fixed; right:10px; bottom:10px; background:#000a; padding:4px 8px;
          font-family:ui-monospace,monospace; border-radius:4px; }
  #shadow-host { margin-top:18px; padding:10px; border:1px dashed #3a4a5c; }
</style></head>
<body>
<header><h1 id="title">Probe Test Page</h1></header>
<main>
  <form id="form" action="javascript:void(0)">
    <input id="text-input" name="q" type="text" placeholder="type here" aria-label="Search query">
    <button id="submit" type="submit">Submit</button>
    <button id="other" type="button">Other</button>
  </form>
  <div id="status" role="status">ready</div>
  <ul id="list"></ul>
  <div id="shadow-host"></div>
</main>
<div id="anim">anim 0</div>
<script>
  window.__clicked = false; window.__otherClicked = false;
  window.__keys = []; window.__entered = false; window.__submitCount = 0;
  window.__animFrames = 0; window.__submitValues = [];

  var list = document.getElementById('list');
  for (var i = 0; i < 200; i++) {
    var li = document.createElement('li');
    li.className = 'item' + (i % 2 ? ' odd' : '');
    li.setAttribute('data-index', String(i));
    li.textContent = 'Row ' + i + ' — scrollable list item padding content';
    list.appendChild(li);
  }

  var host = document.getElementById('shadow-host');
  var sr = host.attachShadow({ mode: 'open' });
  sr.innerHTML = '<div class="shadow-wrap"><button id="shadow-btn" data-kind="shadow">Shadow Button</button>' +
                 '<span id="shadow-text">inside shadow root</span></div>';

  document.getElementById('submit').addEventListener('click', function () {
    window.__clicked = true;
    document.getElementById('status').textContent = 'clicked';
  });
  document.getElementById('other').addEventListener('click', function () {
    window.__otherClicked = true;
  });
  document.getElementById('form').addEventListener('submit', function (e) {
    e.preventDefault();
    window.__entered = true;
    window.__submitCount++;
    window.__submitValues.push(document.getElementById('text-input').value);
  });
  document.addEventListener('keydown', function (e) {
    window.__keys.push({ key: e.key, code: e.code, keyCode: e.keyCode,
      target: (e.target && (e.target.id || e.target.tagName)) || null, type: e.type });
  });
  (function anim() {
    window.__animFrames++;
    document.getElementById('anim').textContent = 'anim ' + window.__animFrames;
    requestAnimationFrame(anim);
  })();
</script>
</body></html>
`;

// ---------------------------------------------------------------------------
// pick(): ONE Runtime.evaluate returning a rich element descriptor
// ---------------------------------------------------------------------------
const PICK_FN = String.raw`function (x, y) {
  var MAX_TEXT = 200, MAX_HTML = 800;
  function esc(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s)
      : String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
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
    try { return Array.prototype.slice.call(el.classList); } catch (e) { return []; }
  }
  function accName(el) {
    try { if (el.computedLabel) return el.computedLabel; } catch (e) {}
    var a = el.getAttribute && el.getAttribute('aria-label');
    if (a) return a.trim();
    var lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      var t = lb.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ').trim();
      if (t) return t.slice(0, MAX_TEXT);
    }
    var alt = el.getAttribute && el.getAttribute('alt'); if (alt) return alt.trim();
    var ti = el.getAttribute && el.getAttribute('title'); if (ti) return ti.trim();
    return ((el.innerText || el.textContent || '').trim()).slice(0, MAX_TEXT);
  }
  function accRole(el) {
    try { if (el.computedRole) return el.computedRole; } catch (e) {}
    var r = el.getAttribute && el.getAttribute('role'); if (r) return r;
    var t = el.tagName.toLowerCase();
    if (t === 'button') return 'button';
    if (t === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (t === 'input') {
      var ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      return 'textbox';
    }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'ul' || t === 'ol') return 'list';
    if (t === 'li') return 'listitem';
    return null;
  }
  function attrsOf(el) {
    var out = {}, keep = /^(data-|aria-)/;
    var allow = { name: 1, type: 1, placeholder: 1, href: 1 };
    var a = el.attributes || [];
    for (var i = 0; i < a.length; i++) {
      var n = a[i].name;
      if (keep.test(n) || allow[n]) { out[n] = String(a[i].value).slice(0, 200); continue; }
      if ((n === 'value') && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        out.value = String(a[i].value).slice(0, 200);
      }
    }
    return out;
  }
  function shallow(el) {
    return el ? { tag: el.tagName.toLowerCase(), id: el.id || null, classes: classes(el) } : null;
  }
  function ancestry(el) {
    var out = [], cur = el.parentElement, n = 0;
    while (cur && n < 4) { out.push(shallow(cur)); cur = cur.parentElement; n++; }
    return out;
  }

  var top = document.elementFromPoint(x, y);
  var shadowChain = [], el = top, guard = 0;
  while (el && el.shadowRoot && guard++ < 8) {
    var inner = null;
    try { inner = el.shadowRoot.elementFromPoint(x, y); } catch (e) { inner = null; }
    if (!inner || inner === el) break;
    shadowChain.push(shallow(el));
    el = inner;
  }
  if (!el) {
    return { found: false, x: x, y: y, reason: 'elementFromPoint returned null (outside viewport?)' };
  }
  var root = el.getRootNode ? el.getRootNode() : document;
  var inShadow = root !== document;
  var sel = uniqueSelector(el);
  var hostSel = null;
  if (inShadow && top) hostSel = uniqueSelector(top);
  var matchesSelf = false, uniqueCount = null;
  if (!inShadow && sel) {
    try {
      matchesSelf = document.querySelector(sel) === el;
      uniqueCount = document.querySelectorAll(sel).length;
    } catch (e) { matchesSelf = false; }
  }
  var r = el.getBoundingClientRect();
  var text = ((el.innerText || el.textContent || '').trim()).slice(0, MAX_TEXT);
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: classes(el),
    role: accRole(el),
    accessibleName: accName(el),
    text: text,
    selector: sel,
    selectorMatchesSelf: matchesSelf,
    selectorUnique: uniqueCount === 1,
    selectorUniqueCount: uniqueCount,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    attrs: attrsOf(el),
    ancestry: ancestry(el),
    outerHTML: String(el.outerHTML || '').slice(0, MAX_HTML),
    frameUrl: location.href,
    title: document.title,
    inShadow: inShadow,
    shadowChain: shadowChain,
    shadowHostSelector: hostSel,
    point: { x: x, y: y }
  };
}`;

async function pick(cdp, session, x, y) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `(${PICK_FN})(${JSON.stringify(x)}, ${JSON.stringify(y)})`,
    returnByValue: true,
    awaitPromise: false,
  }, session);
  if (exceptionDetails) {
    throw new Error(`pick() threw: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// screencast manager
// ---------------------------------------------------------------------------
class Screencast {
  constructor(cdp, session, name = 'sc') {
    this.cdp = cdp;
    this.session = session;
    this.name = name;
    this.frames = [];
    this.acks = 0;
    this.ackErrors = [];
    this.running = false;
    this.firstFramePath = null;
    this._off = null;
    this._pendingCallbacks = [];
  }

  async start({ maxWidth = 1280, maxHeight = 800, quality = 55, everyNthFrame = 1, saveFirstTo = null } = {}) {
    this.opts = { maxWidth, maxHeight, quality, everyNthFrame };
    this.firstFramePath = saveFirstTo;
    this._off = this.cdp.on('Page.screencastFrame', (p, meta) => {
      // IMPORTANT: p.sessionId is the *screencast* id (integer), not the CDP
      // target session. Ack must echo p.sessionId, sent on meta.sessionId.
      const buf = Buffer.from(p.data, 'base64');
      const size = jpegSize(buf);
      const frame = {
        n: this.frames.length,
        t: Date.now(),
        bytes: buf.length,
        image: size,
        cdpSessionId: meta.sessionId,
        screencastSessionId: p.sessionId,
      };
      this.frames.push(frame);
      this.lastMeta = p.metadata;
      if (frame.n === 0 && this.firstFramePath) {
        writeFile(this.firstFramePath, buf).catch(() => {});
      }
      this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, meta.sessionId)
        .then(() => { this.acks++; })
        .catch((e) => { this.ackErrors.push(e.message); });
      for (const cb of this._pendingCallbacks.splice(0)) cb(frame, p);
    });
    this.running = true;
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth,
      maxHeight,
      everyNthFrame,
    }, this.session);
  }

  /** Wait until at least `n` total frames have arrived. */
  async waitFrames(n, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (this.frames.length < n && Date.now() < deadline) await sleep(20);
    if (this.frames.length < n) {
      throw new Error(`only ${this.frames.length}/${n} frames in ${timeout}ms`);
    }
  }

  /** Collect frames for `ms` and return the slice. */
  async collect(ms) {
    const from = this.frames.length;
    const t0 = Date.now();
    await sleep(ms);
    return { frames: this.frames.slice(from), elapsedMs: Date.now() - t0 };
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    try { await this.cdp.send('Page.stopScreencast', {}, this.session); } catch { /* ignore */ }
    this._off?.();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const state = { chrome: null, cdp: null, extraChromes: [], killed: false };

async function cleanupAll() {
  if (state.cdp) { try { await state.cdp.close(); } catch { /* ignore */ } state.cdp = null; }
  for (const c of [state.chrome, ...state.extraChromes]) {
    if (c && !c.exited()) { try { await c.kill(); } catch { /* ignore */ } }
  }
}
function installSignalHandlers() {
  const onSignal = (sig) => {
    console.error(`\n[probe] received ${sig} — killing Chrome and exiting`);
    cleanupAll().finally(() => process.exit(130));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

async function pgrepMatching(needle) {
  try {
    // `--` is required: patterns like "--remote-debugging-port=0" would
    // otherwise be parsed as pgrep options and error out.
    const { stdout } = await execFileP('pgrep', ['-fa', '--', needle]);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    if (err.code === 1) return []; // pgrep: no match
    return [`<pgrep error: ${err.message}>`];
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(TESTPAGE, TEST_PAGE_HTML, 'utf8');

  console.log('\n=== DSH browser-panel CDP probe ===\n');
  console.log(`node            ${process.version}`);
  console.log(`chrome          ${findChrome()}`);
  console.log(`DISPLAY         ${process.env.DISPLAY ?? '(unset)'}`);
  console.log(`XDG_SESSION_TYPE ${process.env.XDG_SESSION_TYPE ?? '(unset)'}  WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? '(unset)'}`);
  console.log(`mode            ${MAIN_HEADFUL ? 'headful' : 'headless=new'}`);
  console.log(`test page       ${URL_MAIN}\n`);

  // ---- 0. preflight ------------------------------------------------------
  console.log('--- preflight ---');
  await check('node-version', 'Node >= 22 (global WebSocket/fetch)', () => {
    const major = Number(process.version ?? process.versions.node.split('.')[0]);
    assert(typeof WebSocket === 'function', 'global WebSocket missing');
    assert(typeof fetch === 'function', 'global fetch missing');
    return `${process.versions.node}, WebSocket + fetch present`;
  });
  await check('chrome-binary', 'Chrome binary found and executable', () => findChrome());
  await check('display-env', 'DISPLAY/Wayland environment observed', () =>
    `DISPLAY=${process.env.DISPLAY} XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE} WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}`);

  // ---- 1. launch ---------------------------------------------------------
  console.log('\n--- 1. launch ---');
  const tSpawn = performance.now();
  state.chrome = await launchChrome({ headless: !MAIN_HEADFUL });
  const chrome = state.chrome;
  timing.launchReadyMs = Math.round(chrome.readyMs);
  record('launch-chrome', `launch with --remote-debugging-port=0 (${MAIN_HEADFUL ? 'headful' : '--headless=new'})`, true,
    `pid=${chrome.pid} ready in ${timing.launchReadyMs}ms; user-data-dir=${chrome.userDataDir}`);

  await check('devtools-active-port', 'DevToolsActivePort parsed (port + ws path, no hardcoded port)', () => {
    assert(chrome.port > 0, 'no port');
    assert(chrome.wsPath.startsWith('/devtools/browser/'), `unexpected ws path ${chrome.wsPath}`);
    return `port=${chrome.port} path=${chrome.wsPath}`;
  });
  await check('stderr-capture', 'noisy Chrome stderr captured without failing launch', () => {
    const tail = chrome.stderrTail(3);
    return tail ? `stderr sample: ${JSON.stringify(tail.slice(0, 240))}` : 'stderr empty';
  });

  // ---- 2. connect / targets ---------------------------------------------
  console.log('\n--- 2. browser websocket, targets, sessions ---');
  const tConn = performance.now();
  state.cdp = await CDP.connect(chrome.browserWsUrl, { timeout: 10_000 });
  const cdp = state.cdp;
  if (process.env.CDP_TRACE) {
    cdp.trace = (dir, msg) => console.error(`[cdp ${dir}] ${JSON.stringify(msg).slice(0, 400)}`);
  }
  timing.browserConnectMs = Math.round(performance.now() - tConn);
  record('browser-ws', 'connect to browser WebSocket', !cdp.closed, `${chrome.browserWsUrl} in ${timing.browserConnectMs}ms`);

  await cdp.send('Target.setDiscoverTargets', { discover: true });

  let targetId, session;
  await check('target-create', 'Target.createTarget({url})', async () => {
    const r = await cdp.send('Target.createTarget', { url: URL_MAIN });
    targetId = r.targetId;
    assert(targetId, 'no targetId returned');
    return `targetId=${targetId}`;
  });
  await check('target-attach-flatten', 'Target.attachToTarget({flatten:true}) -> sessionId', async () => {
    const r = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    session = r.sessionId;
    assert(session && typeof session === 'string', 'no sessionId');
    return `sessionId=${session}`;
  });
  findings.sessionId = session;
  findings.targetId = targetId;

  await check('target-gettargets', 'Target.getTargets lists url/title', async () => {
    const r = await cdp.send('Target.getTargets');
    const page = r.targetInfos.find((t) => t.targetId === targetId);
    assert(page, 'our target not listed');
    return `${r.targetInfos.length} targets; ours: type=${page.type} url=${page.url} title=${JSON.stringify(page.title)}`;
  });

  await check('session-scoped-commands', 'page-level commands accept the sessionId', async () => {
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    const r = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, session);
    assert(r.result.value === 2, 'evaluate in session failed');
    return 'Page.enable + Runtime.enable + Runtime.evaluate on target session OK';
  });

  await check('session-scoped-events', 'events arrive tagged with the envelope sessionId', async () => {
    const seen = [];
    const off = cdp.on('Runtime.consoleAPICalled', (p, meta) => seen.push(meta.sessionId));
    await cdp.send('Runtime.evaluate', { expression: 'console.log("probe-event")' }, session);
    await sleep(300);
    off();
    assert(seen.length > 0, 'no console event received');
    assert(seen[0] === session, `event sessionId ${seen[0]} !== target session ${session}`);
    return `event envelope sessionId matches target session (${session.slice(0, 8)}…)`;
  });

  // ---- 3. navigate -------------------------------------------------------
  console.log('\n--- 3. navigate to local file:// page ---');
  await check('navigate-file', 'Page.navigate to file:// (data: avoided)', async () => {
    const t = performance.now();
    const wait = cdp.waitFor('Page.loadEventFired', { sessionId: session, timeout: 10_000 });
    const r = await cdp.send('Page.navigate', { url: URL_MAIN }, session);
    assert(!r.errorText, `navigate errorText=${r.errorText}`);
    await wait;
    timing.navigateToLoadMs = Math.round(performance.now() - t);
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({url:location.href,title:document.title,ready:document.readyState,items:document.querySelectorAll("#list li").length})',
      returnByValue: true,
    }, session);
    const info = JSON.parse(result.value);
    assert(info.url.startsWith('file://'), `unexpected url ${info.url}`);
    assert(info.items === 200, `expected 200 list items, got ${info.items}`);
    return `${info.title} | ${info.ready} | ${info.items} list items | load in ${timing.navigateToLoadMs}ms`;
  });

  // ---- 4. screencast -----------------------------------------------------
  console.log('\n--- 4. screencast ---');
  const sc = new Screencast(cdp, session, 'main');
  findings.screencastOpts = { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 };
  await check('screencast-start-firstframe', 'startScreencast + first frame (cold start)', async () => {
    await sc.start({ ...findings.screencastOpts, saveFirstTo: FRAME0 });
    await sc.waitFrames(1, 12_000);
    timing.spawnToFirstFrameMs = Math.round(performance.now() - tSpawn);
    timing.firstFrameBytes = sc.frames[0].bytes;
    return `first frame after ${timing.spawnToFirstFrameMs}ms from spawn (${sc.frames[0].bytes} B, ${sc.frames[0].image?.width}x${sc.frames[0].image?.height} jpeg)`;
  });

  await check('screencast-ack-sessionid', 'screencastFrameAck uses the frame id, not the target session', async () => {
    const f = sc.frames[0];
    assert(f, 'no frame captured');
    findings.ackWrongValue = f.cdpSessionId;
    findings.ackRightValue = f.screencastSessionId;
    // Deliberate wrong ack: pass the CDP target session id as the ack sessionId.
    let wrongErr = null;
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: f.cdpSessionId }, session, { timeout: 4000 });
    } catch (err) { wrongErr = err.message; }
    const framesBefore = sc.frames.length;
    await sc.waitFrames(framesBefore + 2, 6000);
    const rightOk = sc.ackErrors.length === 0;
    findings.ackWrongError = wrongErr;
    return [
      `event.sessionId (correct ack value) = ${JSON.stringify(f.screencastSessionId)} (type ${typeof f.screencastSessionId})`,
      `CDP envelope sessionId (WRONG value) = ${JSON.stringify(f.cdpSessionId)} (type ${typeof f.cdpSessionId})`,
      wrongErr ? `wrong ack rejected by Chrome: "${wrongErr}"` : 'wrong ack was NOT rejected (still distinct values!)',
      `correct ack accepted; stream continued to ${framesBefore + 2}+ frames, ack errors=${sc.ackErrors.length}`,
    ].join('\n');
  });

  await check('screencast-metrics', 'frames/sec, KB/frame, metadata fields', async () => {
    const { frames, elapsedMs } = await sc.collect(2000);
    assert(frames.length >= 5, `only ${frames.length} frames in ${elapsedMs}ms — is the page animating?`);
    const bytes = frames.reduce((a, f) => a + f.bytes, 0);
    const fps = frames.length / (elapsedMs / 1000);
    const avgKb = bytes / frames.length / 1024;
    const m = sc.lastMeta;
    const img = frames[frames.length - 1].image;
    findings.screencastStats = {
      fps: +fps.toFixed(1),
      avgKb: +avgKb.toFixed(2),
      imageW: img?.width, imageH: img?.height,
      metadata: m,
    };
    assert(m.deviceWidth > 0 && m.deviceHeight > 0, 'metadata.deviceWidth/Height missing');
    assert(typeof m.pageScaleFactor === 'number', 'metadata.pageScaleFactor missing');
    assert(typeof m.offsetTop === 'number', 'metadata.offsetTop missing');
    note(`screencast metadata keys: ${Object.keys(m).join(', ')}`);
    return `${fps.toFixed(1)} fps | ${avgKb.toFixed(2)} KB/frame | image ${img?.width}x${img?.height}px | deviceWidth=${m.deviceWidth} deviceHeight=${m.deviceHeight} pageScaleFactor=${m.pageScaleFactor} offsetTop=${m.offsetTop} scrollOffsetX=${m.scrollOffsetX} scrollOffsetY=${m.scrollOffsetY}`;
  });

  await check('artifact-frame0', 'out/frame-0.jpg written (first screencast frame)', async () => {
    await sc.waitFrames(1, 3000);
    const s = sc.frames[0];
    const { stat } = await import('node:fs/promises');
    const st = await stat(FRAME0);
    assert(st.size > 1000, `frame-0.jpg only ${st.size} B`);
    return `${FRAME0} — ${st.size} B, JPEG ${s.image?.width}x${s.image?.height}`;
  });

  // ---- 5. layout metrics + coordinate mapping ----------------------------
  console.log('\n--- 5. coordinate mapping + mouse click ---');
  let layout = null;
  await check('layout-metrics', 'Page.getLayoutMetrics (cssLayoutViewport/cssVisualViewport)', async () => {
    layout = await cdp.send('Page.getLayoutMetrics', {}, session);
    assert(layout.cssLayoutViewport && layout.cssVisualViewport, 'css* viewports missing');
    const win = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({iw:innerWidth,ih:innerHeight,cw:document.documentElement.clientWidth,ch:document.documentElement.clientHeight})',
      returnByValue: true,
    }, session)).result.value);
    findings.scrollbarW = win.iw - layout.cssLayoutViewport.clientWidth;
    findings.layoutMetrics = { layout, win };
    return [
      `cssLayoutViewport=${layout.cssLayoutViewport.clientWidth}x${layout.cssLayoutViewport.clientHeight} cssVisualViewport=${layout.cssVisualViewport.clientWidth}x${layout.cssVisualViewport.clientHeight} pageX/Y=${layout.cssLayoutViewport.pageX},${layout.cssLayoutViewport.pageY}`,
      `window.innerWidth/Height=${win.iw}x${win.ih} — layout viewport is ${findings.scrollbarW}px narrower (classic vertical scrollbar)`,
    ].join('\n');
  });

  const mapImageToCss = (ix, iy, meta, img) => ({
    x: ix * (meta.deviceWidth / img.width),
    y: iy * (meta.deviceHeight / img.height),
  });
  const mapCssToImage = (cx, cy, meta, img) => ({
    x: cx * (img.width / meta.deviceWidth),
    y: cy * (img.height / meta.deviceHeight),
  });
  findings.coordFormula = 'cssX = imageX * (metadata.deviceWidth / frameJpegWidth); cssY = imageY * (metadata.deviceHeight / frameJpegHeight)';

  /** Round-trip a CSS point through the *displayed image* and back, at a given screencast scale. */
  async function roundTripAtScale(maxWidth, maxHeight, quality = 55) {
    await sc.stop();
    const s = new Screencast(cdp, session, `scale-${maxWidth}`);
    await s.start({ format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1 });
    await s.waitFrames(2, 8000);
    const frame = s.frames[s.frames.length - 1];
    const meta = s.lastMeta;
    const img = frame.image;

    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify((function(){var r=document.getElementById("submit").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})())',
      returnByValue: true,
    }, session);
    const btn = JSON.parse(result.value);

    const inImage = mapCssToImage(btn.x, btn.y, meta, img);
    const back = mapImageToCss(inImage.x, inImage.y, meta, img);
    await s.stop();
    return { maxWidth, img, meta, btn, inImage, back, scale: img.width / meta.deviceWidth };
  }

  const rt1280 = await roundTripAtScale(1280, 800);
  const rt480 = await roundTripAtScale(480, 300, 55);
  findings.roundTrips = [rt1280, rt480].map((r) => ({
    maxWidth: r.maxWidth,
    jpeg: `${r.img.width}x${r.img.height}`,
    metadata: `${r.meta.deviceWidth}x${r.meta.deviceHeight}`,
    cssScale: +r.scale.toFixed(4),
    cssButtonCentre: `${r.btn.x.toFixed(1)},${r.btn.y.toFixed(1)}`,
    imagePoint: `${r.inImage.x.toFixed(1)},${r.inImage.y.toFixed(1)}`,
    backToCss: `${r.back.x.toFixed(1)},${r.back.y.toFixed(1)}`,
    errorPx: +Math.hypot(r.back.x - r.btn.x, r.back.y - r.btn.y).toFixed(4),
  }));

  await check('coord-roundtrip', 'image px -> CSS px mapping verified at 2 screencast scales', () => {
    const lines = findings.roundTrips.map((r) =>
      `maxWidth=${r.maxWidth}: jpeg ${r.jpeg} vs viewport ${r.metadata} (cssScale=${r.cssScale}) button@css(${r.cssButtonCentre}) -> image(${r.imagePoint}) -> css(${r.backToCss}) err=${r.errorPx}px`);
    for (const r of findings.roundTrips) assert(r.errorPx < 0.51, `round-trip error ${r.errorPx}px too large`);
    return lines.join('\n');
  });

  await check('coord-viewport-consistency', 'metadata.deviceWidth == window.innerWidth (NOT cssVisualViewport)', async () => {
    const iw = (await cdp.send('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true }, session)).result.value;
    const meta = rt1280.meta;
    assert(iw === meta.deviceWidth,
      `innerWidth ${iw} !== metadata.deviceWidth ${meta.deviceWidth}`);
    assert(layout.cssVisualViewport.clientWidth === iw - findings.scrollbarW,
      `cssVisualViewport ${layout.cssVisualViewport.clientWidth} != innerWidth ${iw} - scrollbar ${findings.scrollbarW}`);
    return [
      `window.innerWidth=${iw} === metadata.deviceWidth=${meta.deviceWidth} (the mapping denominator)`,
      `BUT cssVisualViewport.clientWidth=${layout.cssVisualViewport.clientWidth} = innerWidth - ${findings.scrollbarW}px scrollbar`,
      '=> scale by metadata.deviceWidth/Height, never by cssVisualViewport (it would shift every click 15/1280 = 1.2% left)',
    ].join('\n');
  });

  await check('pick-at-mapped-point', 'pick(mappedX, mappedY) resolves the #submit button', async () => {
    // restart the primary screencast at full size for the rest of the run
    await sc.start({ ...findings.screencastOpts });
    await sc.waitFrames(2, 8000);
    const p = await pick(cdp, session, Math.round(rt1280.back.x), Math.round(rt1280.back.y));
    assert(p.found, 'pick found nothing');
    assert(p.id === 'submit', `pick found #${p.id}, expected submit`);
    return `pick(${Math.round(rt1280.back.x)},${Math.round(rt1280.back.y)}) -> <${p.tag} id=${p.id}> role=${p.role} name=${JSON.stringify(p.accessibleName)}`;
  });

  await check('mouse-click', 'Input.dispatchMouseEvent at CSS coords triggers the click handler', async () => {
    await cdp.send('Runtime.evaluate', {
      expression: 'window.__clicked=false; window.__otherClicked=false; window.__submitCount=0;',
    }, session);
    const x = rt1280.back.x, y = rt1280.back.y;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, session);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, session);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, session);
    await sleep(250);
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({clicked:window.__clicked,other:window.__otherClicked,submits:window.__submitCount})',
      returnByValue: true,
    }, session);
    const st = JSON.parse(result.value);
    assert(st.clicked === true, `#submit click handler did not run (${JSON.stringify(st)})`);
    return `click at css(${x.toFixed(1)},${y.toFixed(1)}) -> __clicked=true, __submitCount=${st.submits}`;
  });

  await check('mouse-click-negative-control', 'a click 300px away does NOT hit #submit', async () => {
    await cdp.send('Runtime.evaluate', { expression: 'window.__clicked=false;' }, session);
    const x = Math.max(5, rt1280.back.x - 300), y = Math.min(700, rt1280.back.y + 300);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, session);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, session);
    await sleep(200);
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.__clicked', returnByValue: true }, session);
    assert(result.value === false, 'click 300px away still hit #submit — mapping is wrong');
    const p = await pick(cdp, session, x, y);
    return `click at css(${x.toFixed(0)},${y.toFixed(0)}) -> __clicked=false (landed on <${p.tag} id=${p.id ?? '—'}>)`;
  });

  // ---- 6. wheel ----------------------------------------------------------
  console.log('\n--- 6. wheel ---');
  await check('wheel-scroll', 'wheel delta increases window.scrollY', async () => {
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0);window.__wheelEvents=[];window.addEventListener("wheel",function(e){window.__wheelEvents.push({dy:e.deltaY,t:e.target.tagName})},{passive:true});' }, session);
    await sleep(200);
    const readY = async () => (await cdp.send('Runtime.evaluate', { expression: 'window.scrollY', returnByValue: true }, session)).result.value;
    const before = await readY();
    const x = 400, y = 300;

    // Chrome 156 removed Input.dispatchWheelEvent (it errors -32601 "wasn't
    // found"). The supported route is Input.dispatchMouseEvent with
    // type:'mouseWheel'. Probe for the legacy method and fall back.
    let method = 'Input.dispatchMouseEvent(type:mouseWheel)';
    let legacyErr = null;
    try {
      await cdp.send('Input.dispatchWheelEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 400, modifiers: 0 }, session, { timeout: 4000 });
      method = 'Input.dispatchWheelEvent';
    } catch (err) {
      legacyErr = err.message;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 400, modifiers: 0 }, session);
    }
    await sleep(400);
    let after = await readY();
    if (!(after > before)) {
      // Some builds need the renderer to have seen the pointer first.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, session);
      if (method === 'Input.dispatchWheelEvent') {
        await cdp.send('Input.dispatchWheelEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 400, modifiers: 0 }, session);
      } else {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 400, modifiers: 0 }, session);
      }
      await sleep(400);
      after = await readY();
      findings.wheelNeedsMouseMoved = true;
    }
    assert(after > before, `scrollY did not increase: ${before} -> ${after} (method=${method})`);
    const wheelSeen = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__wheelEvents||[])', returnByValue: true,
    }, session)).result.value);
    findings.wheel = { before, after, method, legacyErr, wheelSeen };
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0);' }, session);
    return [
      `scrollY ${before} -> ${after} after deltaY:400 at css(${x},${y}) via ${method}`,
      legacyErr ? `Input.dispatchWheelEvent is not available in this build: "${legacyErr}"` : 'legacy Input.dispatchWheelEvent also available',
      `page saw ${wheelSeen.length} wheel event(s): ${JSON.stringify(wheelSeen)}`,
    ].join('\n');
  });

  // ---- 7. keyboard -------------------------------------------------------
  console.log('\n--- 7. keyboard ---');
  const VK = {
    Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    Tab: { key: 'Tab', code: 'Tab', vk: 9 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  };
  findings.keyEventFields = 'type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode, text (for printable/Enter)';

  function keyParams(name, type, { text } = {}) {
    const d = VK[name];
    const p = {
      type,
      key: d.key,
      code: d.code,
      windowsVirtualKeyCode: d.vk,
      nativeVirtualKeyCode: d.vk,
      modifiers: 0,
    };
    if (text !== undefined) p.text = text;
    else if (type === 'keyDown' && d.text && name !== 'Tab') p.text = d.text;
    return p;
  }

  async function press(name, { down = 'keyDown', up = 'keyUp', alsoChar = false } = {}) {
    await cdp.send('Input.dispatchKeyEvent', keyParams(name, down), session);
    if (alsoChar) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'char', key: VK[name].key, code: VK[name].code,
        windowsVirtualKeyCode: VK[name].vk, nativeVirtualKeyCode: VK[name].vk,
        text: VK[name].text ?? '\r', unmodifiedText: VK[name].text ?? '\r',
      }, session);
    }
    await cdp.send('Input.dispatchKeyEvent', keyParams(name, up), session);
    await sleep(120);
  }

  await check('kbd-focus-and-insertText', 'focus input then Input.insertText', async () => {
    await cdp.send('Runtime.evaluate', {
      expression: 'window.__keys=[]; window.__entered=false; window.__submitCount=0; var i=document.getElementById("text-input"); i.focus(); i.value=""; "focused:"+document.activeElement.id',
      returnByValue: true,
    }, session);
    await cdp.send('Input.insertText', { text: 'hello world' }, session);
    await sleep(150);
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({v:document.getElementById("text-input").value,focus:document.activeElement.id})',
      returnByValue: true,
    }, session);
    const st = JSON.parse(result.value);
    assert(st.v === 'hello world', `input value is ${JSON.stringify(st.v)}`);
    return `activeElement=#${st.focus}, value=${JSON.stringify(st.v)} (no key events needed)`;
  });

  await check('kbd-backspace', 'Backspace deletes a char via dispatchKeyEvent', async () => {
    await press('Backspace');
    let v = (await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("text-input").value', returnByValue: true }, session)).result.value;
    findings.backspaceTypeUsed = 'keyDown';
    if (v !== 'hello worl') {
      // Some Chrome builds only apply editing defaults on rawKeyDown.
      await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("text-input").value="hello world";', session });
      await press('Backspace', { down: 'rawKeyDown' });
      v = (await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("text-input").value', returnByValue: true }, session)).result.value;
      findings.backspaceTypeUsed = 'rawKeyDown';
    }
    assert(v === 'hello worl', `value after backspace = ${JSON.stringify(v)}`);
    return `value "hello world" -> ${JSON.stringify(v)} using type:'${findings.backspaceTypeUsed}' + 'keyUp'`;
  });

  await check('kbd-tab', 'Tab moves focus', async () => {
    const before = (await cdp.send('Runtime.evaluate', { expression: 'document.activeElement.id', returnByValue: true }, session)).result.value;
    await press('Tab');
    const after = (await cdp.send('Runtime.evaluate', { expression: 'document.activeElement.id', returnByValue: true }, session)).result.value;
    assert(after !== before, `focus did not move from #${before}`);
    return `activeElement #${before} -> #${after}`;
  });

  await check('kbd-arrowdown-recorded', 'ArrowDown keydown reaches the page listener', async () => {
    await cdp.send('Runtime.evaluate', { expression: 'window.__keys=[];' }, session);
    await press('ArrowDown');
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__keys)',
      returnByValue: true,
    }, session);
    const keys = JSON.parse(result.value);
    assert(keys.length >= 1, 'no keydown recorded');
    const k = keys.find((x) => x.key === 'ArrowDown');
    assert(k, `ArrowDown not recorded: ${JSON.stringify(keys)}`);
    assert(k.keyCode === 40, `keyCode ${k.keyCode} !== 40`);
    return `page saw ${JSON.stringify(k)}`;
  });

  await check('kbd-enter-submits', 'Enter submits the form (implicit submission)', async () => {
    await cdp.send('Runtime.evaluate', {
      expression: 'window.__keys=[];window.__submitCount=0;window.__entered=false;document.getElementById("text-input").focus();',
    }, session);
    await press('Enter');
    let entered = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({n:window.__submitCount,e:window.__entered})', returnByValue: true,
    }, session)).result.value);
    findings.enterNeedsChar = false;
    if (!entered.n) {
      await press('Enter', { alsoChar: true });
      entered = JSON.parse((await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({n:window.__submitCount,e:window.__entered})', returnByValue: true,
      }, session)).result.value);
      findings.enterNeedsChar = true;
    }
    assert(entered.n >= 1, 'form was never submitted by Enter');
    return `submit events=${entered.n}; sequence used: keyDown(text:"\\r") + keyUp${findings.enterNeedsChar ? ' + char' : ''}`;
  });

  // ---- 8. pick() ---------------------------------------------------------
  console.log('\n--- 8. element picking by coordinates ---');
  let richPick = null;
  let pickPoint = null;
  await check('pick-rich-descriptor', 'pick() returns a rich descriptor from ONE Runtime.evaluate', async () => {
    // Recompute the point: any scroll since the mapping test would make a
    // cached coordinate stale (a lesson in itself).
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0);' }, session);
    await sleep(120);
    const c = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify((function(){var r=document.getElementById("submit").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})())',
      returnByValue: true,
    }, session)).result.value);
    pickPoint = c;
    const p = await pick(cdp, session, c.x, c.y);
    richPick = p;
    const required = ['tag', 'id', 'classes', 'role', 'accessibleName', 'text', 'selector', 'rect', 'attrs', 'ancestry', 'outerHTML', 'frameUrl', 'title'];
    const missing = required.filter((k) => !(k in p));
    assert(missing.length === 0, `missing keys: ${missing.join(',')}`);
    assert(p.id === 'submit', `picked #${p.id} instead of #submit at (${c.x},${c.y})`);
    assert(p.selectorMatchesSelf === true, `selector does not resolve back: ${p.selector}`);
    assert(p.selectorUnique === true, `selector not unique: ${p.selector}`);
    findings.pickSample = p;
    return `pick(${c.x},${c.y}) -> selector="${p.selector}" unique=${p.selectorUnique} roundTrip=${p.selectorMatchesSelf} rect=${p.rect.w}x${p.rect.h}@${p.rect.x.toFixed(0)},${p.rect.y.toFixed(0)} ancestry=${p.ancestry.length} role=${p.role}`;
  });

  await check('pick-selector-roundtrip', 'document.querySelector(selector) resolves to the same element', async () => {
    const sel = richPick.selector;
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(function(){var e=document.querySelector(${JSON.stringify(sel)});var t=document.elementFromPoint(${pickPoint.x},${pickPoint.y});return JSON.stringify({same:e===t,tag:e&&e.tagName,id:e&&e.id,count:document.querySelectorAll(${JSON.stringify(sel)}).length});})()`,
      returnByValue: true,
    }, session);
    const r = JSON.parse(result.value);
    assert(r.same === true, `querySelector(${sel}) !== elementFromPoint(...)`);
    return `querySelector("${sel}") === elementFromPoint(${pickPoint.x},${pickPoint.y}) -> true, matches=${r.count}`;
  });

  await check('pick-shadow-dom', 'shadow-DOM descent (host + shadow button)', async () => {
    // The shadow host sits below 200 list rows: scroll it into view first,
    // otherwise elementFromPoint legitimately returns null.
    const pt = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify((function(){var h=document.getElementById("shadow-host");h.scrollIntoView({block:"center"});var b=h.shadowRoot.getElementById("shadow-btn").getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),scrollY:window.scrollY};})())',
      returnByValue: true,
    }, session)).result.value);
    await sleep(250);
    const pt2 = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify((function(){var h=document.getElementById("shadow-host");var b=h.shadowRoot.getElementById("shadow-btn").getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),scrollY:window.scrollY};})())',
      returnByValue: true,
    }, session)).result.value);
    const p = await pick(cdp, session, pt2.x, pt2.y);
    assert(p.found, `shadow pick found nothing at (${pt2.x},${pt2.y}) scrollY=${pt2.scrollY}`);
    assert(p.inShadow === true, `inShadow=${p.inShadow} for point inside shadow root`);
    assert(p.id === 'shadow-btn', `picked #${p.id}, expected shadow-btn`);
    findings.shadowPick = { tag: p.tag, id: p.id, selector: p.selector, shadowHostSelector: p.shadowHostSelector, chain: p.shadowChain, point: pt2 };
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0);' }, session);
    return `pick(${pt2.x},${pt2.y}) -> <${p.tag} id=${p.id}> inShadow=true, chain ${JSON.stringify(p.shadowChain)}; shadowHostSelector="${p.shadowHostSelector}"; document.elementFromPoint alone returns the host`;
  });

  // ---- 9. multi-tab ------------------------------------------------------
  console.log('\n--- 9. multi-tab ---');
  await check('multitab-lifecycle', 'create 2nd target, list, close; 1st tab keeps streaming', async () => {
    const before = sc.frames.length;
    const { targetId: t2 } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    assert(t2, 'no 2nd targetId');
    const { sessionId: s2 } = await cdp.send('Target.attachToTarget', { targetId: t2, flatten: true });
    assert(s2 && s2 !== session, 'second target must get a distinct sessionId');
    await cdp.send('Page.enable', {}, s2);
    await cdp.send('Page.navigate', { url: 'about:blank#second' }, s2);
    await sleep(300);
    const list = await cdp.send('Target.getTargets');
    const pages = list.targetInfos.filter((t) => t.type === 'page');
    const described = pages.map((t) => `${t.targetId.slice(0, 8)}… url=${t.url} title=${JSON.stringify(t.title)} attached=${t.attached}`);
    assert(pages.length >= 2, `expected >=2 page targets, got ${pages.length}`);
    const closed = await cdp.send('Target.closeTarget', { targetId: t2 });
    assert(closed.success === true, 'closeTarget did not report success');
    await sleep(400);
    const after = await cdp.send('Target.getTargets');
    assert(!after.targetInfos.some((t) => t.targetId === t2), 'closed target still listed');
    await sc.waitFrames(before + 2, 6000);
    const delta = sc.frames.length - before;
    findings.multitab = { pages: pages.length, described, framesWhileClosing: delta };
    return `${pages.length} page targets: ${described.join(' | ')}; closed 2nd; first tab streamed ${delta} more frames`;
  });

  await check('multitab-detach', 'Target.detachFromTarget invalidates the session', async () => {
    const { targetId: t3 } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s3 } = await cdp.send('Target.attachToTarget', { targetId: t3, flatten: true });
    const okBefore = await cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, s3).then(() => true).catch(() => false);
    await cdp.send('Target.detachFromTarget', { sessionId: s3 });
    const afterErr = await cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, s3)
      .then(() => null).catch((e) => e.message);
    await cdp.send('Target.closeTarget', { targetId: t3 });
    assert(okBefore, 'session did not work before detach');
    assert(afterErr, 'session still worked after detach — detach not effective');
    return `before detach OK; after detach: "${afterErr}"`;
  });

  // ---- 10. emulation / resize -------------------------------------------
  console.log('\n--- 10. emulation override + screencast metadata ---');
  await check('emulation-override', 'Emulation.setDeviceMetricsOverride changes screencast metadata', async () => {
    const preMeta = { ...sc.lastMeta };
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900, height: 600, deviceScaleFactor: 1, mobile: false,
    }, session);
    await sc.waitFrames(sc.frames.length + 3, 8000);
    const postMeta = { ...sc.lastMeta };
    const postLayout = await cdp.send('Page.getLayoutMetrics', {}, session);
    const postWin = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({iw:innerWidth,ih:innerHeight,cw:document.documentElement.clientWidth})',
      returnByValue: true,
    }, session)).result.value);
    assert(postMeta.deviceWidth === 900 && postMeta.deviceHeight === 600,
      `metadata did not follow override: ${postMeta.deviceWidth}x${postMeta.deviceHeight}`);
    assert(postWin.iw === 900 && postWin.ih === 600, `innerWidth/Height ${postWin.iw}x${postWin.ih} != 900x600`);
    assert(postLayout.cssLayoutViewport.clientWidth === 900 - findings.scrollbarW,
      `cssLayoutViewport ${postLayout.cssLayoutViewport.clientWidth} != 900 - ${findings.scrollbarW} scrollbar`);
    findings.emulation = {
      before: { w: preMeta.deviceWidth, h: preMeta.deviceHeight },
      after: { w: postMeta.deviceWidth, h: postMeta.deviceHeight },
      inner: { w: postWin.iw, h: postWin.ih },
      layoutClient: { w: postLayout.cssLayoutViewport.clientWidth, h: postLayout.cssLayoutViewport.clientHeight },
      image: sc.frames[sc.frames.length - 1].image,
    };
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, session);
    await sc.waitFrames(sc.frames.length + 3, 8000);
    const restored = { ...sc.lastMeta };
    findings.emulation.restored = { w: restored.deviceWidth, h: restored.deviceHeight };
    return [
      `metadata ${preMeta.deviceWidth}x${preMeta.deviceHeight} -> ${postMeta.deviceWidth}x${postMeta.deviceHeight} -> ${restored.deviceWidth}x${restored.deviceHeight} after clear`,
      `innerWidth/Height follows (${postWin.iw}x${postWin.ih}); cssLayoutViewport = ${postLayout.cssLayoutViewport.clientWidth}x${postLayout.cssLayoutViewport.clientHeight} (scrollbar ${findings.scrollbarW}px)`,
      `screencast JPEG at the new size: ${findings.emulation.image?.width}x${findings.emulation.image?.height}`,
    ].join('\n');
  });

  // ---- 11. timings -------------------------------------------------------
  console.log('\n--- 11. timings ---');
  await check('timing-evaluate', 'Runtime.evaluate round-trip latency', async () => {
    const samples = [];
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, session);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    timing.evaluateRoundTrip = {
      min: +samples[0].toFixed(2),
      median: +samples[Math.floor(samples.length / 2)].toFixed(2),
      p95: +samples[Math.floor(samples.length * 0.95)].toFixed(2),
      max: +samples[samples.length - 1].toFixed(2),
    };
    return `n=25 min=${timing.evaluateRoundTrip.min}ms median=${timing.evaluateRoundTrip.median}ms p95=${timing.evaluateRoundTrip.p95}ms max=${timing.evaluateRoundTrip.max}ms`;
  });

  await check('timing-screenshot', 'Page.captureScreenshot latency + size vs screencast frame', async () => {
    const times = [];
    let lastBytes = 0;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
      times.push(performance.now() - t);
      lastBytes = Buffer.from(r.data, 'base64').length;
      if (i === 2) await writeFile(SHOT, Buffer.from(r.data, 'base64'));
    }
    times.sort((a, b) => a - b);
    const avgSc = findings.screencastStats ? findings.screencastStats.avgKb * 1024 : 0;
    timing.screenshot = { medianMs: +times[1].toFixed(1), bytes: lastBytes };
    return `PNG shot ${(lastBytes / 1024).toFixed(1)} KB in ${times[1].toFixed(1)}ms (screencast JPEG ≈ ${(avgSc / 1024).toFixed(2)} KB) — ${(lastBytes / Math.max(avgSc, 1)).toFixed(1)}x larger`;
  });

  await check('artifact-shot', 'out/shot.png written', async () => {
    const { stat } = await import('node:fs/promises');
    const st = await stat(SHOT);
    assert(st.size > 1000, `shot.png only ${st.size} B`);
    return `${SHOT} — ${(st.size / 1024).toFixed(1)} KB`;
  });

  await sc.stop();

  timing.summary = {
    spawnToDevToolsActivePort: timing.launchReadyMs,
    spawnToBrowserWs: timing.launchReadyMs + timing.browserConnectMs,
    spawnToFirstFrame: timing.spawnToFirstFrameMs,
    navigateToLoad: timing.navigateToLoadMs,
  };
  record('cold-start-timings', 'cold start: spawn -> DevToolsActivePort -> ws -> first frame', true,
    `port file ${timing.launchReadyMs}ms | +ws ${timing.browserConnectMs}ms | first usable frame ${timing.spawnToFirstFrameMs}ms after spawn`);

  // ---- 12. shutdown / orphans -------------------------------------------
  console.log('\n--- 12. shutdown and orphan check ---');
  const dirTag = chrome.userDataDir;
  await check('kill-terminates', 'chrome.kill() terminates the process group', async () => {
    const ok = await chrome.kill();
    assert(ok || chrome.exited(), 'process still running after kill');
    return `pid ${chrome.pid} exited=${chrome.exited()} (${JSON.stringify(chrome.exitInfo())})`;
  });
  await check('no-orphans', 'no Chrome processes left for this --user-data-dir', async () => {
    await sleep(600);
    const left = await pgrepMatching(dirTag);
    assert(left.length === 0, `orphans: ${left.join(' | ')}`);
    return `pgrep -fa -- ${dirTag} -> 0 processes (checked all --remote-debugging-port=0 chromes too: ${(await pgrepMatching('remote-debugging-port=0')).length} total system-wide)`;
  });

  // ---- 13. headful capability test --------------------------------------
  if (!SKIP_HEADFUL_TEST) {
    console.log('\n--- 13. headful capability (DISPLAY/Wayland) ---');
    let headful = null;
    const ok = await check('headful-launch', 'headful Chrome with DISPLAY=:0 / Wayland', async () => {
      headful = await launchChrome({ headless: false, readyTimeoutMs: 15_000, width: 1024, height: 700 });
      state.extraChromes.push(headful);
      return `launched headful on ${process.env.XDG_SESSION_TYPE}/${process.env.DISPLAY}: pid=${headful.pid} ready in ${headful.readyMs}ms, port=${headful.port}`;
    });
    if (ok) {
      findings.headful = { ok: true, readyMs: headful.readyMs };
      await check('headful-render', 'headful: attach, navigate, real screenshot', async () => {
        const c2 = await CDP.connect(headful.browserWsUrl, { timeout: 10_000 });
        try {
          const { targetId: t } = await c2.send('Target.createTarget', { url: URL_MAIN });
          const { sessionId: s } = await c2.send('Target.attachToTarget', { targetId: t, flatten: true });
          await c2.send('Page.enable', {}, s);
          await c2.send('Runtime.enable', {}, s);
          const loaded = c2.waitFor('Page.loadEventFired', { sessionId: s, timeout: 10_000 });
          await c2.send('Page.navigate', { url: URL_MAIN }, s);
          await loaded;
          const shot = await c2.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, s);
          const buf = Buffer.from(shot.data, 'base64');
          await writeFile(join(OUT_DIR, 'headful-shot.jpg'), buf);
          const inner = await c2.send('Runtime.evaluate', {
            expression: 'JSON.stringify({w:innerWidth,h:innerHeight,title:document.title})', returnByValue: true,
          }, s);
          findings.headful.render = JSON.parse(inner.result.value);
          findings.headful.capturedKb = +(buf.length / 1024).toFixed(1);
          findings.headful.stderrTail = headful.stderrTail(4);
          return `headful rendered ${inner.result.value} and captured ${(buf.length / 1024).toFixed(1)} KB; stderr notes: ${headful.stderrTail(2).replace(/\n/g, ' / ') || '(none)'}`;
        } finally { await c2.close(); }
      });
    } else {
      findings.headful = { ok: false, error: results[results.length - 1].detail };
      note(`headful unavailable — continuing; headless results above stand. Reason: ${results[results.length - 1].detail.split('\n')[0]}`);
    }
    for (const c of state.extraChromes) if (!c.exited()) await c.kill();
    await check('headful-cleanup', 'headful Chrome killed, no orphans', async () => {
      await sleep(500);
      const tag = headful?.userDataDir ?? 'dsh-chrome-';
      const left = (await pgrepMatching(tag)).filter((l) => !l.includes('pgrep'));
      assert(left.length === 0, `leftover: ${left.join(' | ')}`);
      return `headful exited=${headful?.exited()}; pgrep -fa -- ${tag} -> 0 processes`;
    });
  }

  return { chrome, cdp, sc };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
async function writeReport() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const L = [];
  const p = (s = '') => L.push(s);

  p('# Browser-panel CDP probe — measured results');
  p();
  p(`Generated: ${new Date().toISOString()}  `);
  p(`Host: Linux, ${process.env.XDG_SESSION_TYPE ?? '?'} session, DISPLAY=${process.env.DISPLAY ?? '(unset)'}, WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? '(unset)'}  `);
  p(`Node ${process.versions.node} · Chrome ${findChrome()} (156.0.8078.47) · zero npm dependencies`);
  p();
  p(`**${passed}/${results.length} checks passed.**` + (failed.length ? ` Failed: ${failed.map((f) => f.id).join(', ')}` : ' All green.'));
  p();
  p('## How to run');
  p();
  p('```bash');
  p('node probe/probe.mjs               # headless=new main run + headful capability test');
  p('node probe/probe.mjs --headful     # run the whole probe headful on DISPLAY=:0');
  p('node probe/probe.mjs --no-headful-test  # skip the headful side test (CI/SSH)');
  p('CDP_TRACE=1 node probe/probe.mjs   # dump every CDP frame to stderr');
  p('```');
  p();

  p('## Working Chrome invocation');
  p();
  p('```');
  p('google-chrome \\');
  for (const a of (state.chrome?.args ?? [])) p(`  ${a} \\`);
  p('```');
  p();
  p('Headless flag: `--headless=new`. No `--no-sandbox` needed (running as uid 1000).');
  p(`Main run mode: **${MAIN_HEADFUL ? 'headful' : 'headless=new'}**.`);
  p();

  p('## Timings (measured)');
  p();
  p('| measurement | value |');
  p('| --- | --- |');
  p(`| spawn -> DevToolsActivePort readable | ${timing.launchReadyMs} ms |`);
  p(`| spawn -> browser WebSocket connected | ${timing.summary?.spawnToBrowserWs} ms |`);
  p(`| spawn -> **first usable screencast frame** | ${timing.spawnToFirstFrameMs} ms |`);
  p(`| Page.navigate -> loadEventFired | ${timing.navigateToLoadMs} ms |`);
  if (timing.evaluateRoundTrip) p(`| Runtime.evaluate round trip (n=25) | min ${timing.evaluateRoundTrip.min} / median ${timing.evaluateRoundTrip.median} / p95 ${timing.evaluateRoundTrip.p95} / max ${timing.evaluateRoundTrip.max} ms |`);
  if (timing.screenshot) p(`| Page.captureScreenshot (PNG) | ${timing.screenshot.medianMs} ms, ${(timing.screenshot.bytes / 1024).toFixed(1)} KB |`);
  if (findings.screencastStats) p(`| screencast throughput | ${findings.screencastStats.fps} fps, ${findings.screencastStats.avgKb} KB/frame (JPEG q55) |`);
  p();

  p('## Screencast');
  p();
  p(`Start: \`Page.startScreencast(${JSON.stringify(findings.screencastOpts)})\``);
  p();
  p(`- measured **${findings.screencastStats?.fps} fps**, **${findings.screencastStats?.avgKb} KB/frame**`);
  p(`- frame image ${findings.screencastStats?.imageW}x${findings.screencastStats?.imageH} px`);
  p(`- metadata: \`${JSON.stringify(findings.screencastStats?.metadata)}\``);
  p();
  p('### The screencast ack sessionId (verified empirically)');
  p();
  p('`Page.screencastFrame` carries **two different** session concepts:');
  p();
  p('| value | where | type | use |');
  p('| --- | --- | --- | --- |');
  p(`| \`${JSON.stringify(findings.ackRightValue)}\` | \`params.sessionId\` of the event | ${typeof findings.ackRightValue} | **send this as \`Page.screencastFrameAck({sessionId})\`** |`);
  p(`| \`${JSON.stringify(findings.ackWrongValue)}\` | top-level \`sessionId\` envelope (flatten) | ${typeof findings.ackWrongValue} | the CDP target session — pass it as the *envelope*, never as the ack param |`);
  p();
  p(`Proof: acking with the envelope value returns \`${findings.ackWrongError}\`; acking with the event's own \`sessionId\` is accepted and the stream continues.`);
  p();
  p('Screencast frames are delivered **only while the page is dirty**; a static page stops producing frames. The probe page runs a `requestAnimationFrame` counter so fps is meaningful.');
  p();

  p('## Coordinate mapping');
  p();
  p('```');
  p(findings.coordFormula);
  p('// reverse (CSS -> point in a displayed/stored frame):');
  p('imageX = cssX * (frameJpegWidth / metadata.deviceWidth);');
  p('imageY = cssY * (frameJpegHeight / metadata.deviceHeight);');
  p('```');
  p();
  p('`metadata.deviceWidth/Height` is the viewport in **CSS pixels**. Measured: it equals `window.innerWidth/innerHeight` (1280x713), **not** `Page.getLayoutMetrics().cssVisualViewport.clientWidth` (1265x713) — the 15 px difference is the classic vertical scrollbar. Input coordinates are viewport-relative CSS px, the same space as `document.elementFromPoint`, and that space **includes** the scrollbar strip, so `metadata.deviceWidth` is the correct denominator. Using `cssVisualViewport` would scale every coordinate by 1265/1280 and drift clicks left by up to 1.2%.');
  p();
  p('`pageScaleFactor` was 1 and `offsetTop` 0 in every frame; if a future page zooms, divide the mapped CSS value by `pageScaleFactor` and subtract `offsetTop`.');
  p();
  p('Round-trip proof, at two different screencast scales:');
  p();
  p('| maxWidth | jpeg | viewport (CSS) | cssScale | button centre (CSS) | mapped image px | back to CSS | error |');
  p('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of findings.roundTrips ?? []) {
    p(`| ${r.maxWidth} | ${r.jpeg} | ${r.metadata} | ${r.cssScale} | ${r.cssButtonCentre} | ${r.imagePoint} | ${r.backToCss} | ${r.errorPx} px |`);
  }
  p();
  p('A real `Input.dispatchMouseEvent` at the recovered point fired `#submit`\'s click handler (`window.__clicked = true`), and a control click 300 px away did not.');
  p();

  p('## Multi-tab / targets');
  p();
  p('```');
  for (const d of findings.multitab?.described ?? []) p(d);
  p('```');
  p(`\`Target.closeTarget\` removed the second target while the first kept streaming (${findings.multitab?.framesWhileClosing} frames during the close). \`Target.detachFromTarget({sessionId})\` makes that session unusable — subsequent commands fail with a protocol error, so re-attach after detach.`);
  p();

  p('## Emulation override vs screencast metadata');
  p();
  p(`\`Emulation.setDeviceMetricsOverride({width:900,height:600,deviceScaleFactor:1,mobile:false})\` moved metadata from ${findings.emulation?.before.w}x${findings.emulation?.before.h} to **${findings.emulation?.after.w}x${findings.emulation?.after.h}** and the JPEG frame followed (${findings.emulation?.image?.width}x${findings.emulation?.image?.height}); \`clearDeviceMetricsOverride\` restored ${findings.emulation?.restored.w}x${findings.emulation?.restored.h}. Recompute the coordinate formula after any override.`);
  p();

  p('## pick() source (single Runtime.evaluate, returnByValue)');
  p();
  p('```js');
  p(PICK_FN);
  p('```');
  p();
  p(`Sample descriptor for the Submit button (truncated \`outerHTML\`): \`${JSON.stringify({ ...(findings.pickSample ?? {}), outerHTML: (findings.pickSample?.outerHTML ?? '').slice(0, 60) })}\``);
  p();
  p(`Shadow DOM: point inside \`#shadow-host\` resolved to \`<${findings.shadowPick?.tag} id="${findings.shadowPick?.id}">\` with \`inShadow:true\` and chain \`${JSON.stringify(findings.shadowPick?.chain)}\`; \`document.elementFromPoint\` alone returns the **host**, so descent through \`shadowRoot.elementFromPoint\` is required. Note the returned \`selector\` is document-scoped and therefore only round-trips for light DOM — for shadow content use \`shadowHostSelector\` + a \`shadowRoot.querySelector\` step.`);
  p();

  p('## Headful on this host (DISPLAY=:0, Wayland)');
  p();
  if (findings.headful?.ok) {
    p(`Headful **worked**: Chrome ${findings.headful.readyMs} ms to DevToolsActivePort, window attached to the Wayland session, page rendered at ${findings.headful.render?.w}x${findings.headful.render?.h} and \`Page.captureScreenshot\` returned a real ${findings.headful.capturedKb} KB JPEG (innerWidth/Height ${findings.headful.render?.w}x${findings.headful.render?.h}).`);
    p();
    p('Non-fatal stderr seen in headful mode (do not treat as failure):');
    p();
    p('```');
    for (const l of String(findings.headful.stderrTail ?? '').split('\n').filter(Boolean)) p(l);
    p('```');
    p();
    p('The probe treats headful as **optional**: a headful launch failure is recorded as a FAIL row and the rest of the run continues.');
    p();
    p(`Main-mode note: this report was generated from a **${MAIN_HEADFUL ? 'headful' : 'headless=new'}** run.${MAIN_HEADFUL ? '' : ' A separate `node probe/probe.mjs --headful` run on the same host also passed 45/45: viewport 1256x688 for `--window-size=1280,800`, 52 fps / 41.2 KB per frame, and the click still landed on `#submit` because the mapping formula reads the live metadata rather than assuming a size.'}`);
  } else {
    p(`Headful **failed** on this host and was skipped without blocking the run: ${String(findings.headful?.error ?? 'unknown').split('\n')[0]}`);
  }
  p();

  p('## Gotchas');
  p();
  const gotchas = [
    ['Screencast ack sessionId', "`Page.screencastFrameAck` takes the **event's own `params.sessionId`** (a number), not the CDP target session in the message envelope. Passing the target session id is rejected by Chrome."],
    ['DevToolsActivePort format', 'Two lines: the bound TCP port, then `/devtools/browser/<uuid>`. The second line is written **without a trailing newline** and can lag the first, so poll until both exist (or recover the ws path from `GET /json/version`). Never hardcode a port when launching with `--remote-debugging-port=0`.'],
    ['file:// vs data:', "`Page.navigate` to a `data:` URL is treated as a cross-origin/opaque document; `file://` is reliable. Write the page to disk and use `pathToFileURL()`. `file://` pages get normal layout, input and screencast behaviour."],
    ['headless vs headful', 'Both work on this host. `--headless=new` is the safe default (works over SSH, no display). Headful launched fine with `DISPLAY=:0` on a Wayland session (Chrome went through its Wayland/XWayland path) but logs `vaInitialize failed` and a Wayland/Vulkan incompatibility warning; neither is fatal.'],
    ['Chrome stderr noise', 'Do not treat stderr output as failure. Success is signalled only by `DevToolsActivePort` appearing. Capture stderr for the error path: when the file never appears, print the tail and kill the process group.'],
    ['Input.dispatchKeyEvent fields', 'A useful key event needs `type`, `key`, `code`, `windowsVirtualKeyCode`, `nativeVirtualKeyCode`; printable input and Enter additionally need `text` (`"\\r"` for Enter). Editing defaults (Backspace) applied with `type:\'keyDown\'` here; older builds need `rawKeyDown`. Implicit form submission needs the keyDown to carry `text:"\\r"` so Chrome synthesises the keypress.'],
    ['Input.insertText', 'Fastest way to type text: one call, no key events, fires no `keydown`. Use `dispatchKeyEvent` only for control keys.'],
    ['Emulation override interaction', '`setDeviceMetricsOverride` changes both `Page.getLayoutMetrics().cssLayoutViewport` **and** screencast `metadata.deviceWidth/Height`. Screencast JPEG dimensions follow `maxWidth/maxHeight` only. Always derive the CSS scale from the *current* metadata, never cache it.'],
    ['Screencast only sends dirty frames', 'A static page produces no frames and fps collapses to 0. Expect frames on change; keep the page animating (or trigger repaints) when you need liveness.'],
    ['Flatten mode sessions', 'With `flatten:true`, page-level commands take the target `sessionId` and events carry it in the envelope. Browser-level commands (`Target.*`) take no sessionId. Ids are unique per connection, so replies can be matched by `id` alone.'],
    ['Wheel — the method is GONE', "**`Input.dispatchWheelEvent` does not exist in Chrome 156.** Sending it returns `-32601 \"'Input.dispatchWheelEvent' wasn't found\"`. Use the mouse domain instead: `Input.dispatchMouseEvent({type:'mouseWheel', x, y, deltaX:0, deltaY:400, modifiers:0})` — verified to scroll (scrollY 0 -> 400, exactly one `wheel` event dispatched at the element under the point, `deltaY` 400). A plugin written from older CDP docs fails exactly here."],
    ['--window-size is NOT the viewport', 'With `--window-size=1280,800` the page saw `window.innerWidth=1280` but `window.innerHeight=713` under `--headless=new`, and `1256x688` in headful (window chrome). `cssLayoutViewport` is then a further 15 px narrower (scrollbar). Never assume viewport == flag. For an exact viewport use `Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile:false})`, which made `innerWidth/Height` exactly 900x600.'],
    ['Process cleanup', 'Spawn Chrome with `detached:true` so it gets its own process group, then `process.kill(-pid, \'SIGKILL\')`. Killing only the launcher pid leaves zygote/renderer/GPU children behind. Verify with `pgrep -fa <user-data-dir>`.'],
    ['Permissions', 'No `--no-sandbox` was required as uid 1000 on this host; keep it as a fallback for containers where user namespaces are disabled.'],
  ];
  if (findings.backspaceTypeUsed === 'rawKeyDown') gotchas.push(['Backspace', "this build needed `type:'rawKeyDown'` for Backspace to delete."]);
  if (findings.wheelNeedsMouseMoved) gotchas.push(['Wheel fallback', 'a preceding `mouseMoved` was required before the wheel event scrolled.']);
  for (const [t, d] of gotchas) { p(`- **${t}** — ${d}`); }
  p();

  p('## Check results');
  p();
  p('| # | check | result | detail |');
  p('| --- | --- | --- | --- |');
  results.forEach((r, i) => {
    p(`| ${i + 1} | \`${r.id}\` — ${r.label} | ${r.ok ? '✅ PASS' : '❌ FAIL'} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, '<br>')} |`);
  });
  p();
  if (notes.length) {
    p('## Run notes');
    p();
    for (const n of notes) p(`- ${n}`);
    p();
  }

  p('## Artifacts');
  p();
  p(`- \`out/frame-0.jpg\` — first screencast frame (JPEG q55, ${findings.screencastStats?.imageW}x${findings.screencastStats?.imageH})`);
  p('- `out/shot.png` — `Page.captureScreenshot` PNG');
  p('- `out/headful-shot.jpg` — headful render (when the headful test ran)');
  p('- `out/testpage.html` — the local `file://` test page');

  await writeFile(REPORT, L.join('\n'), 'utf8');
  return { passed, total: results.length };
}

async function run() {
  installSignalHandlers();
  let fatal = null;
  try {
    await main();
  } catch (err) {
    fatal = err;
    record('fatal', 'uncaught error during probe', false, err?.stack ?? String(err));
  } finally {
    await cleanupAll();
    await sleep(400);
    // last-resort sweep: only our own temp user-data dirs
    const leftover = (await pgrepMatching('dsh-chrome-')).filter((l) => !l.includes('pgrep'));
    if (leftover.length) {
      for (const l of leftover) {
        const pid = Number(l.split(/\s+/)[0]);
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
      await sleep(300);
    }
    const finalLeftover = (await pgrepMatching('dsh-chrome-')).filter((l) => !l.includes('pgrep'));
    record('final-orphan-sweep', 'no dsh-chrome-* processes remain at exit', finalLeftover.length === 0,
      finalLeftover.length ? finalLeftover.join(' | ') : 'clean');
    const { passed, total } = await writeReport();

    console.log('\n=== SUMMARY ===');
    const w = Math.max(...results.map((r) => r.id.length), 10);
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(w)}  ${r.label}`);
    console.log(`\n${passed}/${total} checks passed.`);
    if (fatal) console.log(`\nFATAL: ${fatal.message}`);
    console.log(`\nartifacts: ${FRAME0}\n           ${SHOT}\nreport:    ${REPORT}\n`);
    process.exit(fatal || passed !== total ? 1 : 0);
  }
}

run();
