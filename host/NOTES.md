# Host half — implemented surface, decisions, and deviations

Scope: `host/browser.js` (CDP Chrome layer, ctx-independent), `host/panel.js`
(Cordis wiring: sessions, routes, SSE, picks/injection), `host/tools.js` (agent
tools), `tools/host-selftest.mjs` (standalone proof). Node 24, plain ESM, node
builtins + relative imports only — no npm packages, no build step.

Verified end to end by `node tools/host-selftest.mjs`: **34/34 checks** (phase A =
raw CDP layer, phase B = real `createBrowserPanelHost` behind a stub Cordis
context + node http server: state/ensure/openTab/SSE frames/status/click/typing/
pick/hover/picks/`picksDrop`/injection/tools/tab-limit/`openTab` key dedupe/
shutdown/recovery-after-shutdown/dispose).

---

## 1. `host/browser.js` — ctx-independent CDP layer

Exports:

| export | purpose |
|---|---|
| `Browser` | one Chrome process + CDP connection + tabs (`static launch(opts)`, `prepare()`, `rows()`, `getTab`, `activeTab`, `setActive`, `ensureTab`, `createTab`, `closeTab`, `dispose`, `alive`, `onChange`, `onExit`) |
| `Tab` | one attached page target (`init`, `navigate`, `goBack`, `goForward`, `reload`, `resize`, `mouse`, `clickAt`, `wheel`, `key`, `insertText`, `hoverAt`, `pickAt`, `screenshot`, `subscribeFrames`, `snapshot`, `dispose`) |
| `CDP` | minimal flattened-session DevTools client (`connect`, `send`, `on`, `waitFor`, `close`) |
| `launchChrome` | spawn with fresh temp `--user-data-dir`, `--remote-debugging-port=0`, detached process group; resolves on DevToolsActivePort |
| `readDevToolsActivePort` | poll for both lines; recovers the ws path from `GET /json/version` when line 2 lags |
| `findChrome`, `CHROME_CANDIDATES` | binary resolution (`CHROME_PATH`, google-chrome, chromium) |
| `normalizePanelUrl` | http/https (+ `about:blank`) policy; bare host → https; `NavRejectedError` otherwise |
| `jpegSize` | intrinsic JPEG SOF dimensions (no deps) |
| `buildContextText` | exact CONTRACT `contextText` builder (8 lines) |
| `buildHoverLabel` | `button#save` / `button.btn` label |
| error classes | carry stable `.code`: `launch-failed`, `nav-rejected`, `pick-failed`, `tab-limit`, `no-tab`, `no-chrome`, `timeout`, `internal` |

Protocol facts coded to (from `probe/report.md` + the CDP probe follow-up):

- Screencast ack uses the **event's own** `params.sessionId` (integer) sent on
  the target session; acking with the envelope session id is rejected (-32602).
  Frames are acked before any await so Chrome never stalls.
- Wheel = `Input.dispatchMouseEvent({type:'mouseWheel', deltaX, deltaY})`;
  `Input.dispatchWheelEvent` does not exist in Chrome 156 (-32601).
- Mapping denominator is the screencast `metadata.deviceWidth/deviceHeight`
  (== `window.innerWidth/innerHeight`, includes the scrollbar), applied per frame
  (never cached). `Page.getLayoutMetrics().cssVisualViewport` is **not** used.
- `--window-size` is the window, not the viewport (1280×800 → 1280×713 inner).
  `resize` uses `Emulation.setDeviceMetricsOverride` and re-reads `innerWidth`.
- Static pages produce no screencast frames; see the keepalive below.
- Keyboard sends `windowsVirtualKeyCode`/`nativeVirtualKeyCode`; Enter carries
  `text:"\r"` on keyDown. Printable text uses `Input.insertText`.
- Chrome is spawned `detached:true`; `dispose()` kills the process group with
  `process.kill(-pid, 'SIGKILL')` and removes only the temp dir it created.

### Screencast pipeline (one per subscribed tab)

`Tab.subscribeFrames(sink)` starts `Page.startScreencast({format:'jpeg',
quality, maxWidth, maxHeight, everyNthFrame:1})` when the first sink arrives and
stops it with `Page.stopScreencast` when the last sink leaves. Delivery is
throttled to `fps` (default 20): frames are sent immediately unless the gap is
too small, otherwise only the **newest** pending frame is kept and sent on a
timer; every CDP frame is acked regardless. Frame object:
`{seq, w, h, data, viewport:{width,height}, ts, keepalive?}` where `w/h` are the
JPEG pixels and `viewport` is the CSS viewport for the contract's mapping.

**Decision / CONTRACT addition — keepalive frames.** Chrome only screencasts
damaged frames, so a static page would leave the panel blank after the first
frame and would fail the verifier's "≥5 frames in 10 s" check. While a tab has at
least one SSE subscriber and no real screencast frame for 500 ms, the host emits
a `Page.captureScreenshot` JPEG at ≤2 fps as a normal `frame` event with the
additive field `keepalive: true`. Shape otherwise unchanged; the panel still shows
live content, and a static page is not "legitimately low frame count". Cheap:
~25 KB / 500 ms only for a subscribed tab with no damage.

**Tab-screencast choice (documented per task):** screencast runs for every tab
that has at least one SSE subscriber and stops when the last subscriber leaves.
Inactive tabs therefore keep streaming only while someone watches them; a tab
switch by itself does not keep the old tab streaming (the panel closes/reopens a
stream per visible body). Multiple subscribed tabs each stream independently
(≈45 KB/frame, 20 fps max) and frame delivery is per-tab.

### Metadata freshness

`Target.targetInfoChanged` is unreliable for title updates on background targets
(Chrome can coalesce them until detach — observed directly), and a tab created
with `Target.createTarget({url})` finishes navigation before the session attaches
(events missed). So `Browser` runs a light poll (1.5 s) that re-reads
`{url, title, readyState}` for tabs with subscribers **or** the active tab, plus
`waitForReady()` after create/open navigation. This is background CDP, never on
the `/state` request path.

---

## 2. `host/panel.js` — sessions, transport, picks, injection

`createBrowserPanelHost(ctx, config) -> { service, settings, dispose }`.

Config (row config from `cordis.patch.yml`, all optional):

| key | default | meaning |
|---|---|---|
| `chromeExecutable` | `/usr/bin/google-chrome` | Chrome binary |
| `headless` | `true` | `--headless=new` |
| `chromeArgs` | `[]` | extra Chrome flags |
| `maxTabs` | `4` | per-Session tab limit |
| `quality` / `maxWidth` / `maxHeight` / `fps` | `55` / `1280` / `800` / `20` | stream limits |
| `width` / `height` | `1280` / `800` | initial Chrome window |
| `launchTimeoutMs` | `25000` | DevToolsActivePort deadline |
| `idleChromeMs` | `900000` | kill Chrome after no subscribers/actions (`0` disables) |
| `maxSessions` | `64` | session-record cap (LRU evicts Chrome-less records) |
| `maxBufferedBytes` | `4 MiB` | per-SSE-connection frame drop threshold |

Routes (exact paths under `/browser-panel`, every handler starts with
`ctx.connection.requestRejection(req)`; a rejection answers its 401/403 and stops):

- `GET /state?sessionId=` → `{ok, chrome:{status,message,headless}, pickMode, tabs[], picks[]}`.
  **Cheap:** cached tab fields only, no CDP round trips, and Chrome is never
  launched by `state` (a Session that never opened the panel gets no process).
  Invalid/missing sessionId → `400 {ok:false, code:'no-session'}`.
- `POST /action` (`{sessionId, tabId?, action, params?}`, ≤1 MiB) →
  `{ok:true, result}` or `{ok:false, code, message}`. Domain failures answer
  HTTP 200 with `ok:false`; malformed JSON/body/session answer 400, oversize 413.
- `GET /stream?sessionId=&tabId=` → `text/event-stream`; events `status`,
  `frame`, `hover` (only while `pickMode`), `picks`, `error`, `ping` every 15 s.
  Writes are guarded; frames are dropped when a client's response buffer exceeds
  `maxBufferedBytes`. A stale/unknown `tabId` falls back to the session's active
  tab and the `status` payload carries additive `requestedTabId` + `tabFallback`.
  Opening the stream is the lazy Chrome launch point (auto-`ensure` + auto tab).

Actions (all CONTRACT verbs implemented): `ensure`, `openTab`, `closeTab`,
`activate`, `navigate`, `back`, `forward`, `reload`, `resize`, `mouse`, `wheel`,
`key`, `text`, `pickArm`, `pickHover`, `pick`, `picksDrop`, `picksClear`,
`screenshot`, `shutdown`. Navigation allowlist: http/https only (+ internal
`about:blank` for a fresh tab); `file:`/`javascript:`/`data:`/`chrome:` →
`nav-rejected`. `openTab` reuses Chrome's lone untouched `about:blank` startup
tab and waits for the load, so the returned row has the post-navigation URL and
`status`, not `about:blank` + `loading`.

**`openTab` is idempotent per `params.key` (additive; client sends
`key: "<sessionId>\u0000<sidebarTabId>"`).** A panel body can mount more than once
(StrictMode, HMR, remount, retry), and each mount calling `openTab` used to
accumulate real Chrome targets until `tab-limit`. Now, per Session, the host
keeps `key -> tabId`: a repeated `openTab {url, key}` with the same key returns
the existing target (navigating it only when the requested URL differs) instead
of creating another one. Without `key`, behaviour is unchanged: every call
creates a new target (subject to `maxTabs`). The binding is cleared by
`closeTab` of that target, by a Chrome-side target destruction, and whenever the
Chrome process is replaced or gone (shutdown, Session dispose, idle reaper,
unexpected exit) — because tab ids restart at `t1` per `Browser` instance, a
stale key must never resolve into a new process's namespace. `state` prunes dead
mappings as well, so `tabs` only ever lists live targets.

### Picks + context injection

A pick is one `Runtime.evaluate` of `document.elementFromPoint(cssX, cssY)` with
`returnByValue` (probe's descriptor builder, extended with src/alt/value attrs).
The page itself verifies `document.querySelector(selector) === element`; that
verified selector is what the descriptor reports (shadow-DOM content resolves to
its host element, which keeps the selector document-scoped and round-trippable).
`contextText` is built by `buildContextText` and matches CONTRACT.md line for
line (asserted exactly by the self-test, including the `—`, `×`, `box: x,y wxh`
and `Picked browser element (user selection from the browser panel)` first line).

Injection is **`agent.inject` only** (never `followup`/`steer`, so a pick attaches
to the user's next message and never starts a turn). The message is a literal
`UserMessage` — the Host half cannot import `@deepseek-ai/dsh-llm`, so it builds
`{ id: crypto.randomUUID(), role:'user', content:[{type:'text',text: contextText}],
source:{kind:'browser-panel', form:'notice', summary: ≤120 chars} }`. `kind` is
merge-extensible and only non-emptiness is validated at the session boundary;
`form:'notice'` + `summary` is the `ContextFormed` shape, which the conversation
UI renders as an injected context row. If the Session has no live agent at pick
time the pick is kept in `session.deferredPicks` and flushed (a) from the
`agent/created` listener, (b) opportunistically on the next `/state` or action;
removal (`picksDrop`/`picksClear`) also drops it from the deferred set. Injection
failures are logged with `ctx.logger.warn` and retried, never silently dropped.

### Ownership / lifecycle

- One Chrome process group per Session, owned by the record; `shutdown` kills it.
- Session dispose: `agent.ctx.effect(() => () => disposeSession(...))` (same
  pattern as `terminal-controller`); the `agent/created` listener re-hooks a
  recreated agent. Plugin `dispose()` ends every SSE response, kills every Chrome,
  clears timers, unregisters routes/tools. Idle reaper (15 min default) kills
  Chrome for Sessions with no subscribers and no recent activity; records are
  capped (`maxSessions`).
- One SSE subscriber map per Session; a subscriber is rebound when its tab closes.

---

## 3. `host/tools.js` — agent tools

Registered globally with `ctx.tools.register` (`effect`-scoped; disposer returned).
Session identity is `exec.agent.session.id`; a call with no agent returns a
**normal failure value** `{ok:false, code:'no-session', error}` (the registry never
sees a throw from a tool body; every tool body also catches and returns
`{ok:false, code, error}`). Tools share the panel service methods with the HTTP
actions (one operation, two callers); `browser_click`/`browser_type` additionally
resolve a `selector` to a CSS-pixel point/focus through the same tab.

| tool | params | notes |
|---|---|---|
| `browser_navigate` | `url` | ensures Chrome, reuses/creates a tab |
| `browser_click` | `x`,`y` or `selector`; `button`, `clickCount` | CSS px, same space as a pick's `rect`; selector is scrolled into view |
| `browser_type` | `text`; `selector`, `clear`, `submit` | focuses/selects first, `Input.insertText`, optional Enter |
| `browser_scroll` | `deltaY?` (400), `deltaX?`, `x?`, `y?` | viewport-centre default; waits for the async scroll to settle and returns `scrollY/scrollHeight` |
| `browser_screenshot` | `format?` (`jpeg`/`png`) | writes the image under `<tmp>/dsh-browser-sidepanel/shot-*.jpeg` and returns `{path,width,height,bytes}` so the model can open it with file tools (no base64 in context) |
| `browser_tabs` | `action` (`list`/`new`/`close`/`activate`), `tabId?`, `url?` | `list` never launches Chrome |
| `browser_pick_last` | `index?` (0 = newest) | the exact `PickDescriptor` from `/state` |

`output.schema = {type:'object', additionalProperties:true}`; `render(args,value)`
projects `{ok:false}` to a readable failure line and JSON otherwise (≤4000 chars).

---

## 4. Deviations / additions to CONTRACT.md (additive only — no shape changed)

1. `frame` events carry additive `viewport` and `ts`, and `keepalive: true` for
   the static-page keepalive frames. `seq/w/h/data` unchanged.
2. `status` events may carry additive `requestedTabId` + `tabFallback` when the
   requested stream tab was stale/unknown and the stream fell back to the active tab.
3. `openTab` reuses Chrome's lone untouched startup tab (a fresh Chrome starts
   with one `about:blank` target; without this the first `openTab` left a stray
   blank tab). It is still "a new Chrome target" from the client's perspective; a
   new target is created whenever any other tab exists.
4. `openTab` accepts an optional `params.key` (stable Sidebar tab occurrence id)
   for idempotent remounts — same `{tab}` shape, no new action/event. See the
   actions section. This was added after the live GUI e2e run hit `tab-limit`
   from a double-mounted panel body.
5. `about:blank` is allowed as a navigation target (needed for `openTab` with no
   URL); every other non-http(s) scheme is `nav-rejected`.
6. Extra error codes used only for protocol-level conditions the contract list
   does not cover: `bad-request` (malformed body / unknown action / invalid
   coordinates) and `internal` (unexpected host failure; HTTP 500).
7. `screenshot` action keeps the contract `{dataUrl}`; the agent tool variant
   writes a temp file instead (see above) to avoid base64 in model context.
8. Tools are also listed under an exported `BROWSER_TOOL_NAMES` for the self-test.
9. Pick list is capped at 50 per Session (`maxPicks` is a constant, not config).

No transport shape, action name, event name, or descriptor field was changed.

---

## 5. What the client must know

- **Coordinate mapping** (unchanged): `cssX = clientX * viewport.width / cw`,
  `cssY = clientY * viewport.height / ch`, where `cw×ch` is the canvas's CSS
  size and `viewport` comes from the frame event (or `status.tab.viewport`). The
  viewport is `window.innerWidth/innerHeight` (includes the scrollbar), which is
  exactly the space of `Input.dispatchMouseEvent` and `elementFromPoint`. Send
  CSS pixels only.
- `frame.w/h` are the JPEG pixels; scale the canvas aspect from them, but map
  input with `viewport`, not `w/h`.
- The stream may deliver frames before the first `status` on a fast connect;
  treat both as idempotent. `status.tab` can be `null` while Chrome is
  launching/errored; `chrome.message` carries the failure text.
- After a tab close, the next `status` shows the fallback tab; close the SSE
  connection when the body unmounts. Unknown `tabId` streams do not error — they
  show the active tab and set `tabFallback: true`.
- `state` never launches Chrome. Call `ensure` (or just open the SSE stream) to
  launch. Expect `chrome.status` transitions `idle → launching → ready|error`
  (status events pushed on each transition).
- Pick chips: keep `pickId`; `picksDrop` removes from both the list and any
  not-yet-injected queue. `pickHover` results are also broadcast as `hover` SSE
  events while `pickMode` is on.
- `openTab` should carry `params.key = <sessionId> + "\0" + <sidebarTabId>` so
  remounts/double-mounts are idempotent; single-flight the call client-side as
  well. Repeating with the same key returns the same `tabId`; only the first
  call after a `closeTab`/Chrome restart creates a target.

## 6. Known limitations

- Shadow-DOM picks resolve to the shadow **host** element (document-scoped,
  `querySelector`-verified selector). The probe's shadow descent failed; the
  contract only requires a verified unique selector.
- `Page.captureScreenshot` keepalive does not capture beyond the viewport and
  skips pages with no layout (errors are swallowed; the next tick retries).
- If the harness process is SIGKILLed, the Chrome process group cannot be reaped
  by this code (normal plugin dispose is clean; `shutdown`/idle/session dispose
  are clean).
- No audio, no file: URLs, no downloads, no devtools protocol exposure to the
  browser: screen content leaves only as JPEG frames and picks leave only as
  descriptors.
- `idleChromeMs` reaping uses wall-clock and only fires when a Session has no SSE
  subscribers, so an open panel is never reaped.

## 7. Reproduce

```bash
cd /path/to/dsh-browser-sidepanel
node --check host/browser.js && node --check host/panel.js && node --check host/tools.js
node tools/host-selftest.mjs   # 34/34 PASS, exit 0
```