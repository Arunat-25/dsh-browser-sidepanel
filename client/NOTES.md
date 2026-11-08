# client.js — implementation notes

Status: **feature-complete for MVP**, live-verified in the GUI (see "Verified live" below).
`node --check client.js` clean · plain JS · React 18 hooks · no JSX · `require('react')` only.

## What is implemented

### Registration (`apply`)
- Tab type `dsh-browser-panel`: `kind:'browser'`, `multiple:true`, `keepMounted:true`,
  `priority:'extension'` (shadows the shipped iframe browser, which is disabled in Web profiles),
  guide entry `{ id:'new', order:25, title, description, icon }` with `BrowserArtwork`.
- Body in `sidebar.right.pane.tab` (keyed by the type id), chip title in
  `sidebar.right.pane.tab.title` showing the **live page title** (body → title via a small
  module-scope `useSyncExternalStore` store; `sessionId` is the standard prop, `useTabInfo` is
  framework-injected and not registered).
- `ctx.locale.register('browserPanel','en'|'zh', …)` for every visible string; `--dsw-alias-*`
  tokens only, component-local `<style>` (no CSS files/imports).
- `ctx.sidebarRight.registerCloseHandler('browser', …)` → `POST action closeTab` for the Chrome
  target the closed panel tab owned (guarded `try/catch` so a foreign handler cannot break
  activation). Pending `openTab` flights are closed when they resolve (no orphan target).

### Toolbar / UI
Back, forward, reload (also bound as the tab's `refresh` command via `bindCommands`), editable
address bar (`Enter` navigates; missing scheme becomes `https://`; `Escape` reverts), pick toggle
(crosshair, `aria-pressed`, tooltip, disabled until the first status), new browser tab
(`tab.actions.openTab('browser', { params:{ url:'about:blank' } })`), open in system browser
(http(s) only), fit-to-panel (`resize` to the display area). Toolbar buttons use
`onMouseDown preventDefault` so clicking them never steals chat focus.
Body markers for e2e: `data-browser-panel`, `data-browser-panel-canvas`,
`data-browser-panel-pick-toggle`, `data-browser-panel-address`, `data-browser-panel-picks`,
`data-browser-panel-status`.

### Transport / stream
- Boot: `GET /state` → if chrome not ready `POST ensure` with backoff (300 ms → 2 s, ~45 s bound) →
  if ready `POST openTab {url, key}` (`key = sessionId + "\u0000" + panel tab id`, stable across
  reloads) → `EventSource /stream?sessionId&tabId`. A non-object `chrome`/`placeholder` payload is
  treated as "transport not ready" → error + Retry. Every async path is wrapped; a failed fetch can
  never throw into the slot.
- Frame painting: base64 JPEG → `createImageBitmap` (Image fallback) → one `requestAnimationFrame`
  paint with a single decode latch; newest frame wins (`seq` guard, reset when a stream opens);
  last bitmap stays on the canvas while reconnecting. `keepalive:true` frames are painted normally.
- SSE: `status` (chrome/tab/pickMode, adopts a `tabFallback`/different `tabId` instead of keeping a
  stale one), `frame`, `hover`, `picks`, `error` (message + reconnect), `ping` ignored.
- Lifecycle: one `EventSource` per **visible** mounted body; paused (`close`) while the tab is
  hidden/collapsed — `keepMounted` keeps the canvas/DOM alive, so a hidden tab costs no connection.
  Reconnect backoff 1 s → 5 s; on every SSE `open` and on `visibilitychange`→visible the client
  refetches `/state` and adopts `picks` (chips survive reconnects and page refresh).
- Canvas is sized to the **frame's** aspect ratio inside the display area; input is refused until a
  `status` viewport exists (no guessing).

### Input forwarding (CONTRACT coordinates)
`cssX = clientX * viewport.width / canvasCssWidth`, `cssY = clientY * viewport.height / canvasCssHeight`
(clamped; client coords are converted to canvas-relative first).
- pointerdown/move/up → `mouse` (`button`, `clickCount`), pointer move throttled 50 ms
- wheel → `wheel` with `deltaX/deltaY`, native listener `{ passive:false }` + `preventDefault`
- keyboard while the canvas owns focus (`tabIndex=0`, `:focus-visible` ring): printable characters →
  `text`; navigation/editing keys → `key` down/up with `key`/`code`/`keyCode`/modifiers; `Escape`
  locally disarms the picker. No global key listener, so chat shortcuts are never hijacked.
- Clicking the canvas focuses it; toolbar controls never take focus.

### Picker / picks
Pick toggle → `pickArm`; hover → `pickHover` (80 ms throttle, overlay rectangle in % of the page
viewport from the latest status viewport); click → `pick`; the returned descriptor is added to the
strip immediately (deduped by `pickId`) and its `rect` flashes green for 1.4 s. Strip shows
`selector` + `text`, per-chip **copy selector** and **remove** (`picksDrop`), **clear all**
(`picksClear`), and the one-line hint "Picked elements are attached to your next message." The Host
performs the actual context injection; the client never touches the composer API.

## openTab call sites (single per mounted body, deduped across remounts)
1. `openChromeTab(doc)` — the **only** `openTab` caller. It is single-flight through the module-level
   `tabOpenFlights` map keyed by `sessionId + "\u0000" + panel tab id`, sends `key`, and owns its own
   `AbortController` so a StrictMode/HMR/retry remount **awaits the first request** instead of racing
   a second one. Entry is released on settle; 15 s failure bound; `tab-limit` falls back to adopting
   an unclaimed existing tab.
2. Reuse path before ever creating: same panel-tab `tabMap` entry → same `tabId` in `/state` →
   a `/state` row carrying our `key` (additive, if the Host exposes it) → otherwise `openTab`.
3. Reconnect/resume/revalidate paths reuse the mapped tab from `/state`; they only call
   `openChromeTab` when the tab genuinely vanished. `status` adoption rewrites the mapping when the
   Host reports a different (fallback) tab.
4. Package-title "new tab" button is a *new Sidebar tab*, not this code path.
Host side (host-cdp) independently dedupes `openTab` by `params.key`, so double mounts across page
reloads reuse one Chrome target. `registerCloseHandler` clears `tabMap`, `tabOpenFlights`, the title
store, and closes both a known target and a still-pending flight's target.

## Verified live (headless CDP against http://127.0.0.1:3080)
- Guide card → tab opens; body renders; all six markers present; **zero** console errors/logs.
- Real Chrome frames painted (e.g. 1280×800 canvas, live page title in the chip: "DSH Browser Panel
  Probe Page" after navigation).
- Address bar `Enter` navigates; status line URL/title update; chip title updates.
- Pick: hover over the fixture's submit button returns overlay `button#submit` at
  left 23.91% / top 10.32% / 6.03% × 4.63% (correct mapping), click → chip `#submit` + text
  "Submit", host `/state` picks reflect it; remove → chip gone and host picks `[]`.
- Resize/fit: `resize {700,450}` → viewport 700×450 → canvas intrinsic 700×450.
- Close panel tab → host Chrome tab removed (`tabs:[t1] → []`).
- GUI page reload with the panel tab restored: same Chrome tab reused (`[t1] → [t1]`, no new tab).
- Wheel action is forwarded and the Host returns `ok` (visual scroll not asserted here; see gaps).
- Host death mid-run rendered "Chrome is not running … Retry" without crashing the slot.

## Known gaps / untested
- **Wheel visual scroll** was not verified from the client: the Host accepts `wheel` (`{ok:true}`),
  but the earlier CDP probe report lists `wheel-scroll` as a failing host check — confirm with
  host-cdp/verifier. Client-side mapping/throttle look correct.
- **Reconnect banner**: automatic reconnect/backoff and the subtle "Reconnecting..." state are
  implemented but forcing an SSE drop needs host cooperation; not exercised end-to-end.
- **Auto-recovery after Chrome exits**: if Chrome dies, the panel shows the error + Retry; it does
  not automatically re-`ensure`. Deliberate (avoids surprise relaunches); Retry re-runs boot.
- **Keyboard composition**: IME composition (`isComposing`) is not forwarded; paste relies on the
  Host's `key` handling (browser clipboard is unavailable to the client).
- **Space** is sent as `text` (inserts a space) rather than a page-scroll key — acceptable MVP
  behaviour, differs from a native browser for scroll-by-space pages.
- **New tab with `about:blank`** may be satisfied by the Host's lone startup tab, so two Sidebar
  tabs can share one Chrome target; the client adopts whatever `tabId` the Host returns and
  re-adopts on `tabFallback`, so it stays functional but the two views are not independent in that
  case. Host decision, not client duplication.
- Untested: multi-pane/floating panel + fullscreen presentation (layout is framework-owned; the body
  is a plain flex column and the fit observer handles resize), zh locale rendering (dictionary
  registered, not visually checked).
- `navigation.revision` re-open on the same tab occurrence navigates the page; only mounted-instance
  behaviour was exercised.