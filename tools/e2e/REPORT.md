# Browser panel — end-to-end verification report

**FINAL BUILD · PASS**

```
Run 2026-11-01T15:59:41Z (= 22:59:41 Asia/Tomsk)   duration 23.3 s   exit 0
26 PASS / 0 FAIL / 2 SKIP of 28 checks
origin  http://127.0.0.1:3080
build   clientPlaceholder=false  hostPlaceholder=false
        client.js       22:51:36 local  84 550 B
        host/panel.js   22:43:57 local  40 195 B
        host/browser.js 22:24:28 local
        host/tools.js   22:25:51 local
```

Two consecutive runs against this loaded build were green (22.9 s and 23.3 s); `out/summary.json` holds
the second. The bundle is the live `dsh-browser-panel` installed in the `web` profile and served by the
running `dsh web` GUI. The harness drives the real GUI in a fresh headless Chrome (own temp profile, own
process group, removed on every exit path) and browses a local fixture page, so the assertions cover the
real HTTP transport, the real CDP Chrome, the real SSE stream, the real Session log and the real
sidebar UI.

The two skips are deliberate and documented below: `browser_pick_last` (agent-tool invocation) and the
forced-SSE-reconnect check (the client renders no observable disconnect state). Neither hides a
failure.

## How to run

```bash
cd /path/to/dsh-browser-sidepanel
node tools/e2e/verify.mjs            # exit 0 only when no check FAILs
node tools/e2e/verify.mjs --keep     # keep the GUI Chrome for debugging
node tools/e2e/verify.mjs --out=/tmp/e2e-out --origin=http://127.0.0.1:3080
```

Prerequisites: GUI up at `http://127.0.0.1:3080`, `node >= 22` (global `fetch`/`WebSocket`),
`/usr/bin/google-chrome`, `zstd` on PATH, and the profile credential that
`node tools/auth-cookie.mjs --json` mints. The harness never starts a second `dsh` server, never edits
the profile, and never calls host/client internals — only the HTTP contract, the SSE stream, the GUI
DOM, and the Session log files.

| file (write scope `tools/e2e/**`) | role |
|---|---|
| `cdp.mjs` | dependency-free CDP client + headless-Chrome launcher (documented copy of the verified `probe/cdp.mjs`) |
| `fixture-server.mjs` | fixture page (`#save-btn`, `#name`, 60-row list) that beacons clicks/scroll/typing/layout back, with request-peer attribution |
| `gui.mjs` | GUI driver: cookie-authenticated SPA boot, real CDP pointer input, DOM waits, page-context `fetch`, screenshots, console/log collection |
| `verify.mjs` | the 28 numbered checks, artifacts, machine-readable summary, defect list, exit code |
| `out/summary.json`, `out/last-run.txt` | machine-readable / human-readable result (checks, evidence, defects, diagnostics, build provenance) |

## Check table

Evidence is from `out/summary.json` of the final run; every check prints PASS/FAIL/SKIP with timings and
writes artifacts on both pass and fail paths.

| # | check | status | evidence |
|---|---|---|---|
| C01 | fixture server | PASS | port 37173, 5 999 B HTML, 60 rows, `#save-btn` + `#name` |
| C02 | headless Chrome (fresh profile) | PASS | pid 82148, port 37567, DevToolsActivePort ready in 167 ms; profile `/tmp/dsh-chrome-PLINfT` **removed after the run** |
| C03 | GUI boot (authenticated) | PASS | title `DSH Local Build`, `#root` mounted, 1 cookie, composer present |
| C04 | isolated blank test session | PASS | `session-3fc2d336-…`, 0 turn nodes, 0 conversation records (`conversationLines:0`); refuses non-blank sessions |
| C05 | `GET /browser-panel/state` contract | PASS | 200, `chrome.status=idle`, `tabs[]=[]`, `picks[]=[]`, `pickMode` present |
| C06 | `POST action ensure` (clean slate) | PASS | `shutdown` → tabs 0/chrome idle, `picksClear` → 0, then `chrome.status=ready` |
| C07 | `POST action openTab` (fixture) + viewport | PASS | session `session-3fc2d336-…`; `tabsBeforeOpenTab=[{t1,about:blank,ready,active}]`; opens `t1` at the fixture URL `ready`, viewport 1280×800 ≥ 600×400, page loaded |
| C08 | tab url/status settle after `openTab` | PASS | fixture URL + `ready` in 10 ms |
| C09 | `navigate` settles tab url/status | PASS | fixture URL + `ready`, `canGoBack=true` |
| C10 | SSE ≥ 5 JPEG frames in 10 s | PASS | **5 frames in 1 329 ms** (seq 1–5), all `FFD8`, 36 311/36 311/36 785 B, image 1280×800, 109 407 B total, 1 `status` event, 0 errors |
| C11 | mouse click reaches the fixture page | PASS | down/up at (87, 146.5) → fixture `click` for `save-btn` |
| C12 | wheel scrolls the fixture page | PASS | `deltaY:600` → `scrollY=600`, restored to 0 |
| C13 | text + key reach `input#name` | PASS | click focused `#name`; `text:"E2E typed text"` set the live value; key `a` produced keydown |
| C14 | `pickArm` + `pickHover` agree with the box | PASS | `pickMode=true`; hover rect `{20,125,133.66,43}` = fixture box, label `button#save-btn` |
| C15 | `pick` returns a descriptor for `#save-btn` | PASS | `p-618d93ce-…`, `selector=#save-btn`, `tag=button`, `id=save-btn`, `text="Save changes"`, rect matches, `contextText` 368 B, `outerHTML` 83 B — 0 problems |
| C16 | SSE `picks` event carries the pick | PASS | 1 `picks` event with the same `pickId` |
| C17 | Session log receives the injected context | PASS | `agent/inbox/spliced` seq 17 (15 splices in the log), `role=user`, `target=next-step`, 368 B, matched by **this run's** unique fixture URL: `Picked browser element … box: 20,125 133.66×43 …` |
| C18 | guide lists the plugin Browser card | PASS | 3 cards (`files`,`terminal`,`browser`); Browser card text `Browser / Browse a page and pick elements into the conversation`; screenshot `01` |
| C19 | browser card opens the panel | PASS | one selected `Browser` tab; body mounted; `panelMounts {canvasAdded:1, tabAdded:1}` (single mount, no duplicate target); panel navigated to the fixture through its own address form (`panelShowsFixture=true`); screenshot `02` |
| C20 | panel body is a real browser body | PASS | `canvas=1`, toolbar `Back/Forward/Reload/Go to URL/Stop picking/New browser tab/Open in system browser`, live title `Browser Panel E2E Fixture` |
| C21 | panel canvas paints a non-uniform image | PASS | 625/625 sampled pixels painted, **20 distinct colours**, avg 247, canvas 1280×800; screenshot `03` |
| C22 | panel UI lists the pick chip | PASS | `<span>Save changes</span>`; pane `Picked elements (1) / Clear all / #save-btn / Save changes / Connected / http://127.0.0.1:37173/`; screenshot `04` |
| C23 | wheel over the panel canvas scrolls the page (UI path) | PASS | CDP `mouseWheel` at canvas centre (1117, 503) over the 647×404 canvas → fixture `scrollY=420`; screenshot `05` |
| C24 | panel surfaces a disconnect and resumes | SKIP | client renders no observable disconnect state within 6 s of offline emulation (see limitations) |
| C25 | `browser_pick_last` agent tool | SKIP | no agent-tool call path from the harness; lead-accepted, HTTP `pick` covers the same service method |
| C26 | `POST action shutdown` closes Session Chrome | PASS | `picksClear` → 0 pending, `shutdown` → `{ok:true}` |
| C27 | no host Chrome process survives shutdown | PASS | host group **82538** (attributed by its TCP peer to the fixture port) gone in 34 ms, 0 leftovers |
| C28 | state still answers after shutdown | PASS | 200, `chrome.status=idle`, `tabs=[]`, `picks=[]` |

## Artifacts

| artifact | what it shows |
|---|---|
| [`out/01-guide-browser-card.png`](out/01-guide-browser-card.png) | right sidebar guide with the plugin's **Browser** card (91 185 B) |
| [`out/02-panel-opened.png`](out/02-panel-opened.png) | Browser panel mounted from the card, showing the fixture page (130 002 B) |
| [`out/03-panel-frames.png`](out/03-panel-frames.png) | panel rendering live JPEG screencast frames (128 546 B) |
| [`out/04-panel-pick-chip.png`](out/04-panel-pick-chip.png) | **panel with the pick chip** — `Picked elements (1)`, `#save-btn`, `Save changes` (128 558 B) |
| [`out/05-panel-ui-wheel.png`](out/05-panel-ui-wheel.png) | the page scrolled by a wheel dispatched over the panel canvas (125 873 B) |
| [`out/06-panel-reconnect.png`](out/06-panel-reconnect.png) | panel state after the offline/online interruption attempt used by the SKIPped reconnect check (127 789 B) |
| [`out/frame-01.jpg`](out/frame-01.jpg) … [`out/frame-03.jpg`](out/frame-03.jpg) | raw SSE frames as delivered (36 311/36 311/36 785 B, 1280×800 JPEG) |
| [`out/summary.json`](out/summary.json) | machine-readable result: checks, evidence, defects, console diagnostics, build mtimes |
| [`out/last-run.txt`](out/last-run.txt) | human-readable run summary |

## Defect register (integration history)

Defects found by this harness while the bundle was being built. All were fixed and re-verified; the
numbers are the harness's numbering at discovery time.

| # | owner | defect | minimal reproduction | status |
|---|---|---|---|---|
| D1 | client | panel body was a placeholder: `Browser panel loading...`, no canvas/toolbar | open the Browser guide card | **fixed** (C20/C21 pass) |
| D2 | host | `/browser-panel/state` served `{ok:true,placeholder:true,chrome:…}` | `GET /browser-panel/state?sessionId=<sid>` | **fixed** (C05) |
| D3 | host | `openTab` left the tab row `url:"about:blank"`, `status:"loading"` for ≥5 s although the page loaded (title updated); SSE `status` carried the same stale row | `openTab` then poll `state` 5 s | **fixed** (C08/C09 settle in ≤10 ms) |
| D4 | host + client | duplicate Chrome targets: the panel body auto-opened a tab and an extra `openTab` hit `tab-limit (4)` because tabs accumulated across runs (`tabs=5`) | `openTab` → `{"code":"tab-limit"}` with 5 rows for one panel | **fixed** (host idempotent `openTab` per `params.key`, client single-flight/tab reuse; C19 now `canvasAdded:1, tabAdded:1` on every run) |
| D5 | harness | element geometry went stale after the wheel-restore gesture (fixture republished layout only in the throttled path) → false C12/C13/C14 failures | wheel `+600` then `-1200`; click computed at `y=-375.5` | **fixed in harness** |
| D6 | harness | `zstdDecompressSync` decoded only the first zstd frame of the live Session log, hiding the injected context | `zstd -dc <log> \| grep "Picked browser element"` (CLI sees it, node binding did not) | **fixed in harness** (`zstd -dc`, node binding only as single-frame fallback) |
| D7 | harness | blocked checks counted twice / attributed as defects | duplicate skip paths | **fixed in harness** |
| D8 | harness | the panel's own tab could not be addressed when a concurrent GUI client already owned the reused tab (blank canvas, failed wheel) | panel shows `about:blank` while the fixture tab exists under another `tabId` | **fixed in harness**: C19 now navigates the panel through its own address form (`[data-browser-panel-address]` + form submit), with `/state` tabFallback as a second path |

No open product defects. Residual flakiness observed during the build came from **concurrent GUI test
clients sharing the workspace's single blank Session** (e.g. one run saw `chrome.status=error … SIGKILL`
because another harness had shut that Chrome down); the harness tolerates this by resetting the Session
first, navigating the panel through its own UI, and never asserting which `tabId` the client adopts.

## Method notes and limitations

### Session isolation
Picks inject context into the owning Session, so the harness refuses to pick into a live conversation.
It mounts the workspace's **blank** Session (`session-3fc2d336-b58b-4e8a-9e2c-fc4670d516ee`), checks
blankness twice — 0 turn nodes in the DOM **and** no `turn/start`, `turn/end`, `user/message`,
`assistant/message` or `step/start` records in the Session log — and fails C04 rather than picking
otherwise. The Lead's live Session has conversation records, so C04 would refuse it. Each run starts and
ends with `shutdown` + `picksClear`, so tabs and pending picks never accumulate (C06/C26 evidence shows
`tabs 0`, `picks 0`).

### Selector resolution (C15)
The descriptor's `selector` must be exactly `#save-btn` — the unique CSS path for that id in the fixture
DOM — and the same point is cross-checked with `pickHover`, whose rect must equal the fixture-reported
button box within 3 px. This proves the Host's `elementFromPoint` → descriptor mapping agrees with an
independent measurement. The Host itself owns `querySelector` verification per `CONTRACT.md`; the
harness cannot execute JS inside the Host's Chrome tab by design (CDP is Host-only).

### Canvas paint (C21)
`getImageData` samples a 24×24 grid over the real canvas: it requires ≥ 1 painted pixel **and** ≥ 2
distinct quantised colours (final run: 20), so a present-but-blank canvas fails. The Chrome warning
`Canvas2D: … willReadFrequently` in `summary.json.diagnostics` is caused by this sampling, not the
plugin.

### Chrome cleanup (C27) and profile cleanup
The Host's Chrome is attributed by **socket ownership**: the fixture server records the TCP peer port,
`ss -tnp` maps it to a pid, and that pid's process group is the Host Chrome (Host spawns it detached
with its own group). This is immune to unrelated Chrome processes running concurrently. Chrome's own
detached `chrome_crashpad_handler` helpers are outside the group and are not counted as plugin leaks.
The harness's own Chrome profile is removed on success, failure and crash paths (C02 records
`/tmp/dsh-chrome-PLINfT`, which does not exist after the run). Residual `/tmp/dsh-chrome-*` profiles on
the machine at the time of writing belong to other concurrently running test harnesses.

### SKIP rationale — `browser_pick_last` (C25)
Invoking an agent tool would require a real LLM turn in the test Session (minutes, non-deterministic,
and it would write conversation records into the blank Session). The Lead accepted the skip and has
independent evidence that the tool and the HTTP `pick` action call the same Host service method; the
HTTP path is fully asserted by C15–C17.

### SKIP rationale — forced SSE reconnect (C24)
The check takes the GUI page offline with `Network.emulateNetworkConditions` for 6 s and watches the
panel for a disconnect state. The panel never exposed one (the Client keeps its last rendered frame and
the status line remained `Connected`), so the post-resume canvas assertion could not be attributed to a
reconnect rather than an uninterrupted stream; per the Lead's guidance it is SKIPped rather than made
flaky. The Client's reconnect logic therefore remains unverified by this harness. Screenshot `06` is
captured in case it helps a follow-up.

### Composer-side chip is not asserted
The plugin surface verified here is the right-sidebar panel (`Picked elements (1)` / `Clear all` /
`#save-btn` / `Save changes`) plus the injected context in the Session log. The composer chip is not a
public DOM/API contract, and per the design the pick arrives as **context spliced into the next agent
step** (`agent/inbox/spliced`, `target=next-step`), not as a chat message — C17 asserts exactly that,
including that it is the *current* pick (matched by the run-unique fixture URL).

### Panel navigation under a concurrently used Session
The GUI reuses the workspace's single blank Session, so another headless client can own the Chrome tab
the panel would otherwise adopt. C19 therefore points the panel at the fixture through the panel's own
address form (`input[data-browser-panel-address]` → React `input` event → `requestSubmit()`), with
`/state` tabFallback as a second path. This is the only place the harness scripts the DOM instead of
issuing real pointer/key input; the panel's pointer and wheel forwarding are covered separately by C23
(real CDP wheel over the canvas → page scrolled 420 px).

## Re-runnability

`verify.mjs` is safe to re-run: it mints a fresh cookie, launches its own Chrome with a fresh profile,
resets the Session, regenerates all artifacts, and exits non-zero with a numbered defect list on any
failure. Two consecutive runs against the final build returned `26 PASS / 0 FAIL / 2 SKIP` with exit 0
(23.3 s / 22.9 s). GUI console/log warnings are collected into `summary.json.diagnostics` so a
client-side regression is visible even when a DOM assertion passes.

## Run history (delta)

| when | build | result | note |
|---|---|---|---|
| 22:18 | host & client placeholders | 2 PASS / 5 FAIL / 21 SKIP | proved guide card, cookie auth, GUI automation |
| 22:21 | host still placeholder | 6 PASS / 2 FAIL / 16 SKIP | fixture + session + guide + panel-open green |
| 22:22 | host landed | 14 / 5 / 5 | state/ensure/openTab/frames/click/wheel green; `openTab` metadata defect (D3) found |
| 22:26 | 〃 | 8 / 3 / 13 | isolated D3 |
| 22:28 | client landed | 9 / 1 / 15 | real canvas/toolbar; duplicate-tab `tab-limit` (D4) found |
| 22:31 | host idempotent `openTab` + client single-flight | 24 / 1 / 1 | only harness zstd-framing bug (D6) left |
| 22:49 | build before final client pass | 25 / 0 / 1 ×2 | two consecutive green runs |
| 22:55–22:59 | client robustness pass (`client.js` 22:51) + host tabKeys hardening | 26 / 0 / 2 ×2 | final build, green with C23/C24 added; C24/C25 documented SKIPs |

---

## Round 2 — hover feedback and composer mention (2026-11-02)

Two features were added after the first green run, and the harness grew three checks.

**Added**
- Host action `probe` (`{x,y}` → `{hit, rect, label, tag, cursor}`) — works with pick mode off, never
  throws, one `Runtime.evaluate`; shares the `elementFromPoint` helper with `pickHover`.
- Client pointer feedback outside pick mode: a pointer dot at the cursor, a dashed animated hover
  outline around the element under the cursor, a selector caption above it, and the panel canvas
  mirrors the page's own CSS cursor (`pointer`/`text`/`grab`/…).
- Client composer mention: the `@` button on a pick chip inserts a visible
  `@browser <selector> "<text>"` token into the message draft (`InputActions.captureInsertion` +
  `insertText`). The full element descriptor still arrives automatically as agent context.

**New checks (run 2026-11-02T07:01:33Z)**

| id | check | result | evidence |
|---|---|---|---|
| C29 | `probe` reports hover geometry and the page cursor | PASS | button rect matches the fixture beacon (±3 px); `cursor:"pointer"`; probe at `(-50,-50)` → `{hit:false,rect:null}` |
| C30 | panel mirrors the cursor and outlines the hovered element | PASS | `[data-browser-panel-hover]` 68×22 box, `[data-browser-panel-cursor]` dot, canvas `cursor:pointer` |
| C31 | pick chip inserts an `@browser` mention into the composer | PASS | draft read back as `@browser #save-btn "Save changes"`; draft cleared afterwards |

**Result:** 29 PASS / 0 FAIL / 2 SKIP of 31 (24.4 s). Artifacts: `out/07-panel-hover-feedback.png`,
`out/mention-in-composer.png`, plus the earlier set.

**Resolved harness defect D9:** C19 intermittently failed because the right column animates open and
the guide-card click could land while it was still moving; the click now waits for the slide and
retries once, and it asserts the panel root instead of a pane-text heuristic. This was a harness
flake, not a client regression — the same flow with explicit waits was green throughout.
