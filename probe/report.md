# Browser-panel CDP probe — measured results

Generated: 2026-11-01T15:10:41.652Z  
Host: Linux, wayland session, DISPLAY=:0, WAYLAND_DISPLAY=wayland-0  
Node 24.15.0 · Chrome /usr/bin/google-chrome (156.0.8078.47) · zero npm dependencies

**45/45 checks passed.** All green.

## How to run

```bash
node probe/probe.mjs               # headless=new main run + headful capability test
node probe/probe.mjs --headful     # run the whole probe headful on DISPLAY=:0
node probe/probe.mjs --no-headful-test  # skip the headful side test (CI/SSH)
CDP_TRACE=1 node probe/probe.mjs   # dump every CDP frame to stderr
```

## Working Chrome invocation

```
google-chrome \
  --user-data-dir=/tmp/dsh-chrome-K5c83C \
  --remote-debugging-port=0 \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion \
  --disable-component-update \
  --disable-client-side-phishing-detection \
  --disable-sync \
  --disable-extensions \
  --metrics-recording-only \
  --mute-audio \
  --no-service-autorun \
  --password-store=basic \
  --use-mock-keychain \
  --window-size=1280,800 \
  --headless=new \
  about:blank \
```

Headless flag: `--headless=new`. No `--no-sandbox` needed (running as uid 1000).
Main run mode: **headless=new**.

## Timings (measured)

| measurement | value |
| --- | --- |
| spawn -> DevToolsActivePort readable | 125 ms |
| spawn -> browser WebSocket connected | 183 ms |
| spawn -> **first usable screencast frame** | 646 ms |
| Page.navigate -> loadEventFired | 13 ms |
| Runtime.evaluate round trip (n=25) | min 0.22 / median 0.45 / p95 2.01 / max 2.18 ms |
| Page.captureScreenshot (PNG) | 66.3 ms, 66.9 KB |
| screencast throughput | 60 fps, 45.3 KB/frame (JPEG q55) |

## Screencast

Start: `Page.startScreencast({"format":"jpeg","quality":55,"maxWidth":1280,"maxHeight":800,"everyNthFrame":1})`

- measured **60 fps**, **45.3 KB/frame**
- frame image 1280x713 px
- metadata: `{"offsetTop":0,"pageScaleFactor":1,"deviceWidth":1280,"deviceHeight":713,"scrollOffsetX":0,"scrollOffsetY":0,"timestamp":1793545835.967743,"monotonicTimestamp":8728.034198}`

### The screencast ack sessionId (verified empirically)

`Page.screencastFrame` carries **two different** session concepts:

| value | where | type | use |
| --- | --- | --- | --- |
| `1` | `params.sessionId` of the event | number | **send this as `Page.screencastFrameAck({sessionId})`** |
| `"FF7C94D7932E5D89655F7058FAAA730C"` | top-level `sessionId` envelope (flatten) | string | the CDP target session — pass it as the *envelope*, never as the ack param |

Proof: acking with the envelope value returns `Page.screencastFrameAck failed: Invalid parameters (code -32602)`; acking with the event's own `sessionId` is accepted and the stream continues.

Screencast frames are delivered **only while the page is dirty**; a static page stops producing frames. The probe page runs a `requestAnimationFrame` counter so fps is meaningful.

## Coordinate mapping

```
cssX = imageX * (metadata.deviceWidth / frameJpegWidth); cssY = imageY * (metadata.deviceHeight / frameJpegHeight)
// reverse (CSS -> point in a displayed/stored frame):
imageX = cssX * (frameJpegWidth / metadata.deviceWidth);
imageY = cssY * (frameJpegHeight / metadata.deviceHeight);
```

`metadata.deviceWidth/Height` is the viewport in **CSS pixels**. Measured: it equals `window.innerWidth/innerHeight` (1280x713), **not** `Page.getLayoutMetrics().cssVisualViewport.clientWidth` (1265x713) — the 15 px difference is the classic vertical scrollbar. Input coordinates are viewport-relative CSS px, the same space as `document.elementFromPoint`, and that space **includes** the scrollbar strip, so `metadata.deviceWidth` is the correct denominator. Using `cssVisualViewport` would scale every coordinate by 1265/1280 and drift clicks left by up to 1.2%.

`pageScaleFactor` was 1 and `offsetTop` 0 in every frame; if a future page zooms, divide the mapped CSS value by `pageScaleFactor` and subtract `offsetTop`.

Round-trip proof, at two different screencast scales:

| maxWidth | jpeg | viewport (CSS) | cssScale | button centre (CSS) | mapped image px | back to CSS | error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280 | 1280x713 | 1280x713 | 1 | 344.6,90.1 | 344.6,90.1 | 344.6,90.1 | 0 px |
| 480 | 480x267 | 1280x713 | 0.375 | 344.6,90.1 | 129.2,33.7 | 344.6,90.1 | 0 px |

A real `Input.dispatchMouseEvent` at the recovered point fired `#submit`'s click handler (`window.__clicked = true`), and a control click 300 px away did not.

## Multi-tab / targets

```
DBD30848… url=about:blank title="about:blank" attached=false
199942DB… url=file:///path/to/dsh-browser-sidepanel/probe/out/testpage.html title="DSH Browser Panel Probe Page" attached=true
98689DBD… url=about:blank#second title="about:blank#second" attached=true
```
`Target.closeTarget` removed the second target while the first kept streaming (25 frames during the close). `Target.detachFromTarget({sessionId})` makes that session unusable — subsequent commands fail with a protocol error, so re-attach after detach.

## Emulation override vs screencast metadata

`Emulation.setDeviceMetricsOverride({width:900,height:600,deviceScaleFactor:1,mobile:false})` moved metadata from 1280x713 to **900x600** and the JPEG frame followed (900x600); `clearDeviceMetricsOverride` restored 1280x713. Recompute the coordinate formula after any override.

## pick() source (single Runtime.evaluate, returnByValue)

```js
function (x, y) {
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
}
```

Sample descriptor for the Submit button (truncated `outerHTML`): `{"found":true,"tag":"button","id":"submit","classes":[],"role":"button","accessibleName":"Submit","text":"Submit","selector":"#submit","selectorMatchesSelf":true,"selectorUnique":true,"selectorUniqueCount":1,"rect":{"x":306,"y":73.59375,"w":77.171875,"h":33},"attrs":{"type":"submit"},"ancestry":[{"tag":"form","id":"form","classes":[]},{"tag":"main","id":null,"classes":[]},{"tag":"body","id":null,"classes":[]},{"tag":"html","id":null,"classes":[]}],"outerHTML":"<button id=\"submit\" type=\"submit\">Submit</button>","frameUrl":"file:///path/to/dsh-browser-sidepanel/probe/out/testpage.html","title":"DSH Browser Panel Probe Page","inShadow":false,"shadowChain":[],"shadowHostSelector":null,"point":{"x":345,"y":90}}`

Shadow DOM: point inside `#shadow-host` resolved to `<button id="shadow-btn">` with `inShadow:true` and chain `[{"tag":"div","id":"shadow-host","classes":[]}]`; `document.elementFromPoint` alone returns the **host**, so descent through `shadowRoot.elementFromPoint` is required. Note the returned `selector` is document-scoped and therefore only round-trips for light DOM — for shadow content use `shadowHostSelector` + a `shadowRoot.querySelector` step.

## Headful on this host (DISPLAY=:0, Wayland)

Headful **worked**: Chrome 205 ms to DevToolsActivePort, window attached to the Wayland session, page rendered at 1000x588 and `Page.captureScreenshot` returned a real 34 KB JPEG (innerWidth/Height 1000x588).

Non-fatal stderr seen in headful mode (do not treat as failure):

```
DevTools listening on ws://127.0.0.1:42291/devtools/browser/89ddd7a4-66c6-4408-88dc-7c6824de36cd
[34269:34269:1101/221040.231537:ERROR:media/gpu/vaapi/vaapi_wrapper.cc:1796] vaInitialize failed: unknown libva error
[34269:34269:1101/221040.233222:ERROR:ui/ozone/platform/wayland/gpu/wayland_surface_factory.cc:249] '--ozone-platform=wayland' is not compatible with Vulkan. Consider switching to '--ozone-platform=x11' or disabling Vulkan
```

The probe treats headful as **optional**: a headful launch failure is recorded as a FAIL row and the rest of the run continues.

Main-mode note: this report was generated from a **headless=new** run. A separate `node probe/probe.mjs --headful` run on the same host also passed 45/45: viewport 1256x688 for `--window-size=1280,800`, 52 fps / 41.2 KB per frame, and the click still landed on `#submit` because the mapping formula reads the live metadata rather than assuming a size.

## Gotchas

- **Screencast ack sessionId** — `Page.screencastFrameAck` takes the **event's own `params.sessionId`** (a number), not the CDP target session in the message envelope. Passing the target session id is rejected by Chrome.
- **DevToolsActivePort format** — Two lines: the bound TCP port, then `/devtools/browser/<uuid>`. The second line is written **without a trailing newline** and can lag the first, so poll until both exist (or recover the ws path from `GET /json/version`). Never hardcode a port when launching with `--remote-debugging-port=0`.
- **file:// vs data:** — `Page.navigate` to a `data:` URL is treated as a cross-origin/opaque document; `file://` is reliable. Write the page to disk and use `pathToFileURL()`. `file://` pages get normal layout, input and screencast behaviour.
- **headless vs headful** — Both work on this host. `--headless=new` is the safe default (works over SSH, no display). Headful launched fine with `DISPLAY=:0` on a Wayland session (Chrome went through its Wayland/XWayland path) but logs `vaInitialize failed` and a Wayland/Vulkan incompatibility warning; neither is fatal.
- **Chrome stderr noise** — Do not treat stderr output as failure. Success is signalled only by `DevToolsActivePort` appearing. Capture stderr for the error path: when the file never appears, print the tail and kill the process group.
- **Input.dispatchKeyEvent fields** — A useful key event needs `type`, `key`, `code`, `windowsVirtualKeyCode`, `nativeVirtualKeyCode`; printable input and Enter additionally need `text` (`"\r"` for Enter). Editing defaults (Backspace) applied with `type:'keyDown'` here; older builds need `rawKeyDown`. Implicit form submission needs the keyDown to carry `text:"\r"` so Chrome synthesises the keypress.
- **Input.insertText** — Fastest way to type text: one call, no key events, fires no `keydown`. Use `dispatchKeyEvent` only for control keys.
- **Emulation override interaction** — `setDeviceMetricsOverride` changes both `Page.getLayoutMetrics().cssLayoutViewport` **and** screencast `metadata.deviceWidth/Height`. Screencast JPEG dimensions follow `maxWidth/maxHeight` only. Always derive the CSS scale from the *current* metadata, never cache it.
- **Screencast only sends dirty frames** — A static page produces no frames and fps collapses to 0. Expect frames on change; keep the page animating (or trigger repaints) when you need liveness.
- **Flatten mode sessions** — With `flatten:true`, page-level commands take the target `sessionId` and events carry it in the envelope. Browser-level commands (`Target.*`) take no sessionId. Ids are unique per connection, so replies can be matched by `id` alone.
- **Wheel — the method is GONE** — **`Input.dispatchWheelEvent` does not exist in Chrome 156.** Sending it returns `-32601 "'Input.dispatchWheelEvent' wasn't found"`. Use the mouse domain instead: `Input.dispatchMouseEvent({type:'mouseWheel', x, y, deltaX:0, deltaY:400, modifiers:0})` — verified to scroll (scrollY 0 -> 400, exactly one `wheel` event dispatched at the element under the point, `deltaY` 400). A plugin written from older CDP docs fails exactly here.
- **--window-size is NOT the viewport** — With `--window-size=1280,800` the page saw `window.innerWidth=1280` but `window.innerHeight=713` under `--headless=new`, and `1256x688` in headful (window chrome). `cssLayoutViewport` is then a further 15 px narrower (scrollbar). Never assume viewport == flag. For an exact viewport use `Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile:false})`, which made `innerWidth/Height` exactly 900x600.
- **Process cleanup** — Spawn Chrome with `detached:true` so it gets its own process group, then `process.kill(-pid, 'SIGKILL')`. Killing only the launcher pid leaves zygote/renderer/GPU children behind. Verify with `pgrep -fa <user-data-dir>`.
- **Permissions** — No `--no-sandbox` was required as uid 1000 on this host; keep it as a fallback for containers where user namespaces are disabled.

## Check results

| # | check | result | detail |
| --- | --- | --- | --- |
| 1 | `node-version` — Node >= 22 (global WebSocket/fetch) | ✅ PASS | 24.15.0, WebSocket + fetch present |
| 2 | `chrome-binary` — Chrome binary found and executable | ✅ PASS | /usr/bin/google-chrome |
| 3 | `display-env` — DISPLAY/Wayland environment observed | ✅ PASS | DISPLAY=:0 XDG_SESSION_TYPE=wayland WAYLAND_DISPLAY=wayland-0 |
| 4 | `launch-chrome` — launch with --remote-debugging-port=0 (--headless=new) | ✅ PASS | pid=33853 ready in 125ms; user-data-dir=/tmp/dsh-chrome-K5c83C |
| 5 | `devtools-active-port` — DevToolsActivePort parsed (port + ws path, no hardcoded port) | ✅ PASS | port=38257 path=/devtools/browser/0c8264a3-c459-40e2-9b5a-85fdcea03e38 |
| 6 | `stderr-capture` — noisy Chrome stderr captured without failing launch | ✅ PASS | stderr sample: "DevTools listening on ws://127.0.0.1:38257/devtools/browser/0c8264a3-c459-40e2-9b5a-85fdcea03e38" |
| 7 | `browser-ws` — connect to browser WebSocket | ✅ PASS | ws://127.0.0.1:38257/devtools/browser/0c8264a3-c459-40e2-9b5a-85fdcea03e38 in 58ms |
| 8 | `target-create` — Target.createTarget({url}) | ✅ PASS | targetId=199942DB98D4C192C791284A9A65BF3F |
| 9 | `target-attach-flatten` — Target.attachToTarget({flatten:true}) -> sessionId | ✅ PASS | sessionId=FF7C94D7932E5D89655F7058FAAA730C |
| 10 | `target-gettargets` — Target.getTargets lists url/title | ✅ PASS | 6 targets; ours: type=page url=file:///path/to/dsh-browser-sidepanel/probe/out/testpage.html title="" |
| 11 | `session-scoped-commands` — page-level commands accept the sessionId | ✅ PASS | Page.enable + Runtime.enable + Runtime.evaluate on target session OK |
| 12 | `session-scoped-events` — events arrive tagged with the envelope sessionId | ✅ PASS | event envelope sessionId matches target session (FF7C94D7…) |
| 13 | `navigate-file` — Page.navigate to file:// (data: avoided) | ✅ PASS | DSH Browser Panel Probe Page \| complete \| 200 list items \| load in 13ms |
| 14 | `screencast-start-firstframe` — startScreencast + first frame (cold start) | ✅ PASS | first frame after 646ms from spawn (46315 B, 1280x713 jpeg) |
| 15 | `screencast-ack-sessionid` — screencastFrameAck uses the frame id, not the target session | ✅ PASS | event.sessionId (correct ack value) = 1 (type number)<br>CDP envelope sessionId (WRONG value) = "FF7C94D7932E5D89655F7058FAAA730C" (type string)<br>wrong ack rejected by Chrome: "Page.screencastFrameAck failed: Invalid parameters (code -32602)"<br>correct ack accepted; stream continued to 4+ frames, ack errors=0 |
| 16 | `screencast-metrics` — frames/sec, KB/frame, metadata fields | ✅ PASS | 60.0 fps \| 45.30 KB/frame \| image 1280x713px \| deviceWidth=1280 deviceHeight=713 pageScaleFactor=1 offsetTop=0 scrollOffsetX=0 scrollOffsetY=0 |
| 17 | `artifact-frame0` — out/frame-0.jpg written (first screencast frame) | ✅ PASS | /path/to/dsh-browser-sidepanel/probe/out/frame-0.jpg — 46315 B, JPEG 1280x713 |
| 18 | `layout-metrics` — Page.getLayoutMetrics (cssLayoutViewport/cssVisualViewport) | ✅ PASS | cssLayoutViewport=1265x713 cssVisualViewport=1265x713 pageX/Y=0,0<br>window.innerWidth/Height=1280x713 — layout viewport is 15px narrower (classic vertical scrollbar) |
| 19 | `coord-roundtrip` — image px -> CSS px mapping verified at 2 screencast scales | ✅ PASS | maxWidth=1280: jpeg 1280x713 vs viewport 1280x713 (cssScale=1) button@css(344.6,90.1) -> image(344.6,90.1) -> css(344.6,90.1) err=0px<br>maxWidth=480: jpeg 480x267 vs viewport 1280x713 (cssScale=0.375) button@css(344.6,90.1) -> image(129.2,33.7) -> css(344.6,90.1) err=0px |
| 20 | `coord-viewport-consistency` — metadata.deviceWidth == window.innerWidth (NOT cssVisualViewport) | ✅ PASS | window.innerWidth=1280 === metadata.deviceWidth=1280 (the mapping denominator)<br>BUT cssVisualViewport.clientWidth=1265 = innerWidth - 15px scrollbar<br>=> scale by metadata.deviceWidth/Height, never by cssVisualViewport (it would shift every click 15/1280 = 1.2% left) |
| 21 | `pick-at-mapped-point` — pick(mappedX, mappedY) resolves the #submit button | ✅ PASS | pick(345,90) -> <button id=submit> role=button name="Submit" |
| 22 | `mouse-click` — Input.dispatchMouseEvent at CSS coords triggers the click handler | ✅ PASS | click at css(344.6,90.1) -> __clicked=true, __submitCount=1 |
| 23 | `mouse-click-negative-control` — a click 300px away does NOT hit #submit | ✅ PASS | click at css(45,390) -> __clicked=false (landed on <li id=—>) |
| 24 | `wheel-scroll` — wheel delta increases window.scrollY | ✅ PASS | scrollY 0 -> 400 after deltaY:400 at css(400,300) via Input.dispatchMouseEvent(type:mouseWheel)<br>Input.dispatchWheelEvent is not available in this build: "Input.dispatchWheelEvent failed: 'Input.dispatchWheelEvent' wasn't found (code -32601)"<br>page saw 1 wheel event(s): [{"dy":400,"t":"LI"}] |
| 25 | `kbd-focus-and-insertText` — focus input then Input.insertText | ✅ PASS | activeElement=#text-input, value="hello world" (no key events needed) |
| 26 | `kbd-backspace` — Backspace deletes a char via dispatchKeyEvent | ✅ PASS | value "hello world" -> "hello worl" using type:'keyDown' + 'keyUp' |
| 27 | `kbd-tab` — Tab moves focus | ✅ PASS | activeElement #text-input -> #submit |
| 28 | `kbd-arrowdown-recorded` — ArrowDown keydown reaches the page listener | ✅ PASS | page saw {"key":"ArrowDown","code":"ArrowDown","keyCode":40,"target":"submit","type":"keydown"} |
| 29 | `kbd-enter-submits` — Enter submits the form (implicit submission) | ✅ PASS | submit events=1; sequence used: keyDown(text:"\r") + keyUp |
| 30 | `pick-rich-descriptor` — pick() returns a rich descriptor from ONE Runtime.evaluate | ✅ PASS | pick(345,90) -> selector="#submit" unique=true roundTrip=true rect=77.171875x33@306,74 ancestry=4 role=button |
| 31 | `pick-selector-roundtrip` — document.querySelector(selector) resolves to the same element | ✅ PASS | querySelector("#submit") === elementFromPoint(345,90) -> true, matches=1 |
| 32 | `pick-shadow-dom` — shadow-DOM descent (host + shadow button) | ✅ PASS | pick(82,673) -> <button id=shadow-btn> inShadow=true, chain [{"tag":"div","id":"shadow-host","classes":[]}]; shadowHostSelector="#shadow-host"; document.elementFromPoint alone returns the host |
| 33 | `multitab-lifecycle` — create 2nd target, list, close; 1st tab keeps streaming | ✅ PASS | 3 page targets: DBD30848… url=about:blank title="about:blank" attached=false \| 199942DB… url=file:///path/to/dsh-browser-sidepanel/probe/out/testpage.html title="DSH Browser Panel Probe Page" attached=true \| 98689DBD… url=about:blank#second title="about:blank#second" attached=true; closed 2nd; first tab streamed 25 more frames |
| 34 | `multitab-detach` — Target.detachFromTarget invalidates the session | ✅ PASS | before detach OK; after detach: "Runtime.evaluate failed: Session with given id not found. (code -32001)" |
| 35 | `emulation-override` — Emulation.setDeviceMetricsOverride changes screencast metadata | ✅ PASS | metadata 1280x713 -> 900x600 -> 1280x713 after clear<br>innerWidth/Height follows (900x600); cssLayoutViewport = 885x600 (scrollbar 15px)<br>screencast JPEG at the new size: 900x600 |
| 36 | `timing-evaluate` — Runtime.evaluate round-trip latency | ✅ PASS | n=25 min=0.22ms median=0.45ms p95=2.01ms max=2.18ms |
| 37 | `timing-screenshot` — Page.captureScreenshot latency + size vs screencast frame | ✅ PASS | PNG shot 66.9 KB in 66.3ms (screencast JPEG ≈ 45.30 KB) — 1.5x larger |
| 38 | `artifact-shot` — out/shot.png written | ✅ PASS | /path/to/dsh-browser-sidepanel/probe/out/shot.png — 66.9 KB |
| 39 | `cold-start-timings` — cold start: spawn -> DevToolsActivePort -> ws -> first frame | ✅ PASS | port file 125ms \| +ws 58ms \| first usable frame 646ms after spawn |
| 40 | `kill-terminates` — chrome.kill() terminates the process group | ✅ PASS | pid 33853 exited=true ({"code":null,"signal":"SIGKILL"}) |
| 41 | `no-orphans` — no Chrome processes left for this --user-data-dir | ✅ PASS | pgrep -fa -- /tmp/dsh-chrome-K5c83C -> 0 processes (checked all --remote-debugging-port=0 chromes too: 0 total system-wide) |
| 42 | `headful-launch` — headful Chrome with DISPLAY=:0 / Wayland | ✅ PASS | launched headful on wayland/:0: pid=34205 ready in 205ms, port=42291 |
| 43 | `headful-render` — headful: attach, navigate, real screenshot | ✅ PASS | headful rendered {"w":1000,"h":588,"title":"DSH Browser Panel Probe Page"} and captured 34.0 KB; stderr notes: [34269:34269:1101/221040.231537:ERROR:media/gpu/vaapi/vaapi_wrapper.cc:1796] vaInitialize failed: unknown libva error / [34269:34269:1101/221040.233222:ERROR:ui/ozone/platform/wayland/gpu/wayland_surface_factory.cc:249] '--ozone-platform=wayland' is not compatible with Vulkan. Consider switching to '--ozone-platform=x11' or disabling Vulkan |
| 44 | `headful-cleanup` — headful Chrome killed, no orphans | ✅ PASS | headful exited=true; pgrep -fa -- /tmp/dsh-chrome-8bsFNa -> 0 processes |
| 45 | `final-orphan-sweep` — no dsh-chrome-* processes remain at exit | ✅ PASS | clean |

## Run notes

- screencast metadata keys: offsetTop, pageScaleFactor, deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY, timestamp, monotonicTimestamp

## Artifacts

- `out/frame-0.jpg` — first screencast frame (JPEG q55, 1280x713)
- `out/shot.png` — `Page.captureScreenshot` PNG
- `out/headful-shot.jpg` — headful render (when the headful test ran)
- `out/testpage.html` — the local `file://` test page