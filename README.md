# Browser panel for DeepSeek Harness

A right-Sidebar **Browser** tab for the DSH Web GUI that streams a real Chrome page over
CDP, forwards mouse/keyboard input, and turns a clicked page element into conversation
context — the "pick element into context" flow familiar from Cursor/opencode.

Everything ships as one installable DSH plugin bundle (`dsh-browser-sidepanel`): a Host half that
owns Chrome and the transport, and a Client half that renders the Sidebar tab.

## What it does

- **Browser tab in the right Sidebar** — the guide card sits next to *Workspace files* and
  *New terminal*. The tab keeps its page (and canvas) mounted across tab switches, collapse,
  and Session switches.
- **Real Chrome, not an iframe** — every Session gets its own lazily-launched Chrome with a
  temporary profile. That means arbitrary sites, logins, SPAs, and sites that refuse framing.
  The page is streamed as JPEG frames over SSE; CDP never reaches the browser.
- **Full interaction** — pointer, wheel, and keyboard (printable text via `Input.insertText`,
  control keys via `Input.dispatchKeyEvent`), address bar with navigation, back/forward/reload,
  multiple tabs, viewport resize. `--headless=new` by default; set `headless: false` to watch
  the real window.
- **Pointer feedback** — moving the mouse in the panel shows a pointer dot, draws an animated
  hover outline around the element under the cursor with its selector caption, and mirrors the
  page's own CSS cursor (`pointer`, `text`, `grab`, …), so it is obvious when the page reacts.
- **Element picking** — press the pick toggle, hover to outline the element under the cursor,
  click it, and the element is captured: unique CSS selector, tag/id/classes, role and
  accessible name, text, bounding box, selected attributes, up to four ancestors, and a
  trimmed `outerHTML`.
- **Mention in the composer** — the `@` button on a pick chip inserts a visible
  `@browser #save-btn "Save changes"` token into the message draft, so you can see (and edit)
  what is attached before sending. The full descriptor is still attached automatically by the
  Host, and the token is plain text, not an atomic `@file` chip (see limitations).
- **Element into context** — each pick is injected into the owning Session as a user-role
  context message (`source: {kind: 'browser-panel', form: 'notice'}`), so it reaches the model
  at the next step / next message. Picks are listed as chips in the panel until sent and can be
  removed individually or cleared.
- **Agent tools** — `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`,
  `browser_screenshot`, `browser_tabs`, `browser_pick_last`, so the model can drive the same
  browser the user sees (one implementation serves both the UI actions and the tools).

## Requirements

- DeepSeek Harness Web profile (`dsh web`) ≥ 0.2.0, Node ≥ 22 (global `WebSocket`/`fetch`).
- A Chrome/Chromium executable. Default `/usr/bin/google-chrome`; override with
  `chromeExecutable` in the row config.

## Install

```bash
# from npm
plugin_manager install_bundle dsh-browser-sidepanel

# straight from GitHub
plugin_manager install_bundle github:<owner>/dsh-browser-sidepanel

# from a local checkout (development)
plugin_manager install_bundle <abs path to this directory>
```

The same specs work through the CLI: `dsh plugin --profile web add <spec>`.
The agent `plugin_manager` tool answers with install hints when a spec needs one.

A **local checkout** install is a symlink into the profile, so re-running the install after
edits picks up new files — but it also means deleting that checkout breaks the plugin.
The npm/GitHub forms install a real copy instead. The Host row is inserted by
`cordis.patch.yml`:

```yaml
- insert:
    - id: browser-panel
      name: 'dsh-browser-sidepanel'
      config:
        chromeExecutable: /usr/bin/google-chrome
        headless: true
```

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `chromeExecutable` | `/usr/bin/google-chrome` | Chrome binary |
| `headless` | `true` | `false` opens a visible Chrome window |
| `chromeArgs` | `[]` | extra launch arguments |
| `maxTabs` | `4` | Chrome targets per Session |
| `quality` / `maxWidth` / `maxHeight` / `fps` | `55` / `1280` / `800` / `20` | screencast budget |
| `width` / `height` | `1280` / `800` | initial viewport |
| `launchTimeoutMs` | `25000` | Chrome cold start budget |
| `idleChromeMs` | `900000` | reclaim an unused Chrome |
| `maxSessions` | `64` | Session owners kept at once |

## How it works

```
Client (React, plain JS)                Host (Node)                       Chrome
─────────────────────                   ──────────                        ──────
eventSource /stream  ◀── SSE ───────  /browser-panel/stream  ◀── Page.startScreencast
fetch POST /action   ─── JSON ─────▶  /browser-panel/action  ─── Input.dispatch*, Page.*
GET /state           ◀── JSON ──────  /browser-panel/state
                                        pick → Runtime.evaluate(document.elementFromPoint)
                                        pick → agent.inject(contextText)
```

- **Transport**: three same-origin HTTP routes registered on the Host web server, guarded by
  `ctx.connection.requestRejection` (the GUI's `dsh-auth-*` cookie). SSE is used for the frame
  stream because the Host web server exempts `text/event-stream` from gzip; a static page is
  kept alive with ≤2 fps JPEG `keepalive` frames.
- **Coordinates**: frames are sent with the CSS viewport they were captured at, and the client
  maps pointer positions with `css = client * viewport / canvas` before dispatching CDP input.
  The denominator is Chrome's `metadata.deviceWidth/Height` (= `innerWidth/innerHeight`,
  scrollbar included), not `cssVisualViewport` — that distinction is what makes clicks land
  exactly.
- **Lifecycle**: one Chrome per Session, one target per panel tab, lazily launched on first use,
  killed via its process group on tab close, Session dispose, plugin dispose, or idle reaper.
- **No npm dependencies, no build step**: the Host half imports Node builtins only; the Client
  artifact is a single `window.__ModuleLoader__.load(...)` module that requires only `react`
  and uses the DSH theme tokens.

## Files

| Path | Role |
|---|---|
| `index.js` | Host entry; stages `host/` into a fresh temp generation per activation (restart-free reload) |
| `host/browser.js` | ctx-free CDP layer: Chrome launcher, CDP client, tabs, screencast, input, picker |
| `host/panel.js` | `createBrowserPanelHost`: per-Session owners, routes/SSE, picks, injection, reaper |
| `host/tools.js` | the seven agent tools |
| `client.js` | Client artifact: tab type + guide entry + body (canvas, toolbar, input, picker UI) |
| `tools/lead-integration.mjs` | Host-level contract test (16 checks) against the live profile |
| `tools/host-selftest.mjs` | Standalone Host self-test (32 checks, no DSH needed) |
| `tools/e2e/` | Browser-driven end-to-end harness against the live GUI |
| `probe/` | CDP/screencast/picker capability probe and its measured report |
| `research/` | Verified DSH plugin API cheat sheet and risk list |

## Verification

- `node tools/host-selftest.mjs` — 34/34 PASS, standalone (Chrome launch, first frame, input,
  picker round-trip, tabs, idempotent `openTab`, recovery after shutdown, tools, SSE,
  injection, cleanup).
- `node tools/lead-integration.mjs` — 17/17 PASS against the live profile: `ensure` → Chrome
  ready, `openTab` → 19 JPEG frames / 6 s at 1280×713, idempotent keyed `openTab`, click/wheel/
  text land on a fixture page, pick returns `#save-btn` with the contract `contextText`, the
  text appears in the Session log, `shutdown` returns Chrome to idle.
- `node tools/e2e/verify.mjs` — GUI-level **29 PASS / 0 FAIL / 2 SKIP of 31** on the final build:
  guide card, panel render, non-uniform canvas pixels, click/wheel/text through the panel UI,
  pick chip, injected context in the Session log, hover probe + pointer feedback, composer
  mention, shutdown/cleanup. The two SKIPs are the agent-tool call (needs a live LLM turn; the
  shared service method is covered by the HTTP pick path) and forced-SSE-reconnect.
  See `tools/e2e/REPORT.md`.
- `node tools/lead-hover-check.mjs` — 9/9: panel navigation, hover outline + pointer dot,
  cursor mirroring, pick chip, and the `@browser` mention landing in the composer.

## Limitations and notes

- **Reference chips in the composer are not public DSH API.** A pick shows as a chip inside the
  panel and is injected as Session context automatically; the `@` chip button inserts a
  *plain-text* `@browser <selector> "<text>"` mention through the public `InputActions.insertText`
  API, not an `@file`-style atomic chip.
- Auth is the GUI cookie, so the routes only answer the authenticated page; there is no token
  handshake to configure.
- Headful Chrome works on this host but prints harmlessly about VA-API/Wayland-Vulkan.
- Sites with heavy bot protection may still dislike an automated Chrome; the plugin sends no
  automation flags by default.
- Editing `client.js` needs a page refresh (or a plugin toggle) to load; editing `host/`
  needs only a `plugin_manager set_plugin` off/on, because `index.js` stages a fresh module
  generation per activation.

## Development loop

```bash
node tools/host-selftest.mjs                      # host only, fast
node tools/lead-integration.mjs                   # real profile, real Chrome
node tools/e2e/verify.mjs                         # GUI end-to-end (headless Chrome)
node tools/lead-hover-check.mjs                   # hover feedback + composer mention
```

The GUI-level checks locate their workspace row from the clone's parent directory (the usual
"a workspace hosts this clone" layout). Set `DSH_TEST_PROJECT` when the workspace is named
differently — for example when the clone itself is the workspace root — and `DSH_SESSIONS_ROOT`
when the DSH home is not `~/.dsh`.

After changing Host files, toggle the plugin row to reload it:

```
plugin_manager set_plugin include:browser-panel enabled=false
plugin_manager set_plugin include:browser-panel enabled=true
```