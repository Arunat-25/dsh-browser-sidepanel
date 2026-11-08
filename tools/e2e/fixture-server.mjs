/**
 * fixture-server.mjs — the page the browser panel is pointed at during E2E.
 *
 * The page reports everything the harness must observe back to this server:
 * the panel's Chrome is driven only through CDP by the Host, so the verifier can
 * never read `window.__clicked` in that page directly. Instead every DOM fact
 * the harness asserts (click landed, wheel scrolled, text arrived, element rect)
 * is POSTed here as a `page` event, and the harness polls `events()`.
 *
 * Endpoints:
 *   GET  /            the fixture document (header, #save-btn, #name, 60-row list)
 *   POST /event       page -> server event sink (sendBeacon / fetch)
 *   GET  /events      JSON array of everything received, in order
 *   GET  /health      readiness probe
 *
 * Usage:
 *   import { createFixtureServer } from './fixture-server.mjs'
 *   const fixture = await createFixtureServer()
 *   fixture.url                    // http://127.0.0.1:<port>/
 *   await fixture.waitFor(e => e.type === 'click', 5000)
 *   await fixture.close()
 */
import { createServer } from 'node:http'

/** The 60-row list, rendered statically so the served HTML itself carries every row. */
const ROWS = Array.from({ length: 60 }, (_, index) => `  <li id="row-${index + 1}">Row ${index + 1}</li>`).join('\n')

/** The fixture document. Everything the harness asserts exists in the page itself. */
export const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Browser Panel E2E Fixture</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: #f6f7f9; color: #16181d; }
  header { position: sticky; top: 0; background: #fffbe6; border-bottom: 2px solid #e0b400; padding: 12px 20px; }
  main { padding: 20px; }
  h1 { margin: 0; font-size: 20px; }
  button { font: inherit; margin: 0; padding: 10px 18px; border: 1px solid #1f6feb; border-radius: 8px;
           background: #1f6feb; color: #fff; cursor: pointer; }
  button:active { transform: translateY(1px); }
  input { font: inherit; padding: 9px 12px; border: 1px solid #9aa4b2; border-radius: 8px; width: 260px; }
  ul { list-style: none; margin: 16px 0 0; padding: 0; }
  li { height: 28px; line-height: 28px; border-bottom: 1px solid #e3e6ea; }
  li:nth-child(odd) { background: #fff; }
  .muted { color: #667085; }
</style>
</head>
<body>
<header><h1>E2E fixture — browser panel</h1><p class="muted" id="hint">click, wheel, type and pick are all observed by the harness</p></header>
<main>
  <button id="save-btn" type="submit" name="Save" role="button">Save changes</button>
  <span id="click-count" class="muted">clicks: 0</span>
  <p><label for="name">Name</label><br><input id="name" name="name" type="text" placeholder="Type your name"></p>
  <ul id="list">
${ROWS}
  </ul>
</main>
<script>
(() => {
  const state = { clicked: 0, scrollY: 0, value: '', keys: [] };
  window.__clicked = false;
  window.__state = state;
  const report = (type, extra) => {
    const body = JSON.stringify(Object.assign({ type, ts: Date.now() }, extra || {}));
    try { navigator.sendBeacon('/event', new Blob([body], { type: 'application/json' })); }
    catch { fetch('/event', { method: 'POST', body, keepalive: true }).catch(() => {}); }
  };
  const rectOf = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const save = document.getElementById('save-btn');
  const name = document.getElementById('name');
  const count = document.getElementById('click-count');
  save.addEventListener('click', () => {
    state.clicked += 1;
    window.__clicked = true;
    count.textContent = 'clicks: ' + state.clicked;
    report('click', { target: 'save-btn', count: state.clicked });
  });
  name.addEventListener('input', () => { state.value = name.value; report('input', { value: name.value }); });
  name.addEventListener('keydown', (event) => {
    state.keys.push(event.key);
    report('key', { key: event.key, value: name.value });
  });
  document.addEventListener('click', (event) => {
    report('document-click', { id: event.target && event.target.id, x: event.clientX, y: event.clientY });
  }, true);
  let lastScrollReport = 0;
  let scrollLayoutTimer = 0;
  addEventListener('scroll', () => {
    state.scrollY = Math.round(scrollY);
    // Element boxes move with the scroll offset; republish them for later
    // gestures on every scroll, even while the scroll events themselves throttle.
    clearTimeout(scrollLayoutTimer);
    scrollLayoutTimer = setTimeout(() => publishLayout('scroll'), 80);
    const now = Date.now();
    if (now - lastScrollReport < 120) return;
    lastScrollReport = now;
    report('scroll', { y: Math.round(scrollY) });
  }, { passive: true });
  const publishLayout = (why) => report('layout', {
    why,
    viewport: { w: innerWidth, h: innerHeight },
    scrollY: Math.round(scrollY),
    saveRect: rectOf(save),
    nameRect: rectOf(name),
    headerText: (document.querySelector('h1')?.textContent || ''),
    title: document.title,
    url: location.href,
    clicked: window.__clicked,
  });
  report('ready', {
    viewport: { w: innerWidth, h: innerHeight },
    saveRect: rectOf(save),
    nameRect: rectOf(name),
    scrollHeight: document.documentElement.scrollHeight,
    title: document.title,
  });
  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => publishLayout('resize'), 100);
  });
})();
</script>
</body>
</html>`

/**
 * Start the fixture HTTP server on an ephemeral loopback port.
 * @returns {Promise<{ url: string, port: number, events: () => object[], reset: () => void,
 *   waitFor: (predicate: (event: object) => boolean, timeoutMs?: number) => Promise<object>,
 *   last: (predicate?: (event: object) => boolean) => object | undefined, close: () => Promise<void> }>}
 */
export async function createFixtureServer() {
  /** @type {object[]} */
  const events = []

  /** Requests seen so far, with the peer socket, for host-Chrome attribution. */
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ path: url.pathname, remotePort: req.socket.remotePort ?? null, remoteAddress: req.socket.remoteAddress ?? null, ts: Date.now() })
    if (req.method === 'POST' && url.pathname === '/event') {
      const chunks = []
      req.on('data', (chunk) => { chunks.push(chunk) })
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          events.push(body)
        } catch { /* ignore malformed beacons */ }
        res.statusCode = 204
        res.end()
      })
      return
    }
    if (url.pathname === '/events') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(events))
      return
    }
    if (url.pathname === '/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain')
      res.end('ok')
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(FIXTURE_HTML)
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const last = (predicate) => {
    const filtered = predicate === undefined ? events : events.filter(predicate)
    return filtered[filtered.length - 1]
  }

  const waitFor = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = last(predicate)
      if (hit !== undefined) return hit
      if (Date.now() >= deadline) throw new Error(`fixture: no event matched within ${timeoutMs}ms`)
      await new Promise((resolve) => { setTimeout(resolve, 40) })
    }
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    events: () => events.slice(),
    // Interaction events are per-gesture; geometry/ready events must survive a
    // reset so later checks can still address element boxes.
    reset: () => {
      const interactions = new Set(['click', 'document-click', 'scroll', 'input', 'key'])
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (interactions.has(events[index].type)) events.splice(index, 1)
      }
    },
    requests: () => requests.slice(),
    remotePorts: () => [...new Set(requests.map((request) => request.remotePort).filter((value) => value !== null))],
    waitFor,
    last,
    close: () => new Promise((resolve) => { server.close(() => { resolve() }) }),
  }
}

// Direct invocation: serve the fixture and print the URL (manual poking).
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await createFixtureServer()
  console.log(fixture.url)
}