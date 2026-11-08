# Browser panel — interface contract

Two halves ship in one bundle (`dsh-browser-sidepanel`):

- **Host** (`index.js` → `host/*.js`): one CDP-controlled Chrome per Session, the panel HTTP
  transport, element picking, agent tools, context injection.
- **Client** (`client.js`, single file): the right-Sidebar tab type, guide entry, React body
  (canvas renderer, toolbar, input forwarding, picker UI).

The halves share **only** the HTTP contract below. Do not import Client modules from the Host,
and do not `require()` anything but `react` / `react/jsx-runtime` in the Client artifact.

## Transport (same origin as the GUI)

All routes are registered by the Host with `ctx.webServer.register(...)` under the prefix
`/browser-panel`, and every handler starts with the guard:

```js
const rejection = ctx.connection.requestRejection(req)
if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
```

`ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })` — the handler owns the whole
response and **may hold it open** (SSE is explicitly supported); compression is off by default.

### `GET /browser-panel/state?sessionId=<sid>`

```json
{
  "ok": true,
  "chrome": { "status": "idle" | "launching" | "ready" | "error", "message": "…", "headless": true },
  "pickMode": false,
  "tabs": [
    { "tabId": "t1", "url": "https://…", "title": "…", "status": "loading" | "ready",
      "viewport": { "width": 1280, "height": 800 },
      "canGoBack": true, "canGoForward": false, "active": true }
  ],
  "picks": [PickDescriptor]
}
```

### `POST /browser-panel/action`

Request body (JSON, ≤ 1 MiB): `{ "sessionId": "<sid>", "tabId": "t1", "action": "<name>", "params": { … } }`

Response: `{ "ok": true, "result": <any> }` or `{ "ok": false, "code": "…", "message": "…" }`
(HTTP status is still 200/4xx as appropriate; the client shows `message` on failure).

| action | params | result |
|---|---|---|
| `ensure` | `{}` | `{ chrome }` — launch Chrome if not running; idempotent |
| `openTab` | `{ url, key? }` | `{ tab }` — new Chrome target + screencast. Additive `key` (the Sidebar tab occurrence id) makes the call idempotent: a repeated call for the same key returns the existing target (navigating it when the url differs), so StrictMode double-mounts and remounts cannot accumulate targets up to `maxTabs` |
| `closeTab` | `{}` | `{ closed: true }` |
| `activate` | `{}` | `{ tab }` |
| `navigate` | `{ url }` | `{ tab }` |
| `back` / `forward` / `reload` | `{}` | `{ tab }` |
| `resize` | `{ width, height }` | `{ viewport }` |
| `mouse` | `{ type: "move"\|"down"\|"up", x, y, button?: "left"\|"right"\|"middle", clickCount? }` | `{ ok: true }` — x/y in **CSS px** |
| `wheel` | `{ x, y, deltaX?, deltaY? }` | `{ ok: true }` |
| `key` | `{ type: "down"\|"up", key, code, keyCode?, text?, modifiers?: { alt, ctrl, meta, shift } }` | `{ ok: true }` |
| `text` | `{ text }` | `{ ok: true }` — CDP `Input.insertText` |
| `pickArm` | `{ on }` | `{ pickMode }` |
| `pickHover` | `{ x, y }` | `{ rect: {x,y,w,h} \| null, label: "button#save" }` |
| `probe` | `{ x, y }` | `{ hit: boolean, rect: {x,y,w,h} \| null, label: string \| null, tag: string \| null, cursor: string }` — lightweight hover probe for always-on pointer feedback; works with pick mode off and never throws for an empty point |
| `pick` | `{ x, y }` | `{ pick: PickDescriptor }` — stores pending pick + injects context |
| `picksDrop` | `{ pickId }` | `{ picks }` |
| `picksClear` | `{}` | `{ picks }` |
| `screenshot` | `{ format?: "jpeg"\|"png" }` | `{ dataUrl: "data:image/…;base64,…" }` |
| `shutdown` | `{}` | `{ ok: true }` — closes Chrome for this Session |

Errors use stable codes: `no-session`, `no-chrome`, `no-tab`, `tab-limit`, `nav-rejected`,
`pick-failed`, `launch-failed`, `timeout`.

### `GET /browser-panel/stream?sessionId=<sid>&tabId=<tid>` — `text/event-stream`

One SSE connection per visible panel tab. Events (`event:` name + `data:` JSON):

- `status` — `{ chrome, tab: { …state row… }, pickMode }`, sent on connect and on every change.
- `frame` — `{ seq, w, h, data }` — base64 JPEG of `Page.startScreencast`; `w/h` are the image
  pixels. Throttle to ≤ 20 fps and drop intermediate frames; the newest frame wins.
- `hover` — `{ rect: {x,y,w,h} | null, label }` (only while `pickMode`, from `pickHover`).
- `picks` — `{ picks: [PickDescriptor] }` on change.
- `error` — `{ message }` (fatal stream error; client reconnects with backoff).
- `ping` — `{ t }` every 15 s.

**Coordinate mapping**: the canvas draws the JPEG at some CSS size `cw × ch`; the page viewport
is `viewport.width × viewport.height` CSS px. So
`cssX = clientX * viewport.width / cw`, `cssY = clientY * viewport.height / ch`.
Input actions always carry CSS px.

### `PickDescriptor`

```ts
{
  pickId: string,            // "p-<random>"
  sessionId: string, tabId: string,
  url: string, pageTitle: string,
  selector: string,          // unique CSS path, verified by querySelector
  tag: string,               // lower-case
  id: string, classes: string[],
  role: string,              // explicit or implicit
  accessibleName: string,
  text: string,              // trimmed innerText, ≤ 200 chars
  rect: { x, y, w, h },      // CSS px, viewport-relative
  attrs: Record<string,string>,   // selected: name/type/placeholder/href/src/alt/data-*/aria-*
  ancestors: Array<{ tag, id, classes }>,  // nearest first, ≤ 4
  outerHTML: string,         // trimmed ≤ 800 chars
  ts: number,                // Date.now()
  contextText: string        // exact text injected into the conversation
}
```

`contextText` format (the Host builds it; the Client only lists picks):

```
Picked browser element (user selection from the browser panel)
page: <title> — <url>
selector: #save.btn-primary
element: <button id="save" class="btn btn-primary" role="button" name="Save">
text: "Save changes"
box: 812,421 96×36
path: form.card > div.actions > button#save
html: <button id="save" class="btn btn-primary" type="submit">Save changes</button>
```

## Client responsibilities

- Register the sidebar tab type: `id: 'dsh-browser-panel'`, `kind: 'browser'`, `multiple: true`,
  `priority: 'extension'`, a `guide` entry `{ id: 'new', order: 25, title, description, icon }`.
- Register the body in slot `sidebar.right.pane.tab` under that id (and a title in
  `sidebar.right.pane.tab.title` showing the live page title).
- Body: toolbar (back, forward, reload, address bar, pick toggle, new tab, open external,
  fullscreen?), canvas + overlay, status/error line, pending-picks list with the element label and
  a remove button.
- Send input only while the canvas has pointer/focus ownership; do not steal focus from chat.
- All visible text through `ctx.locale` (`namespace: 'browserPanel'`), styling through
  `--dsw-alias-*` theme tokens.
- One SSE stream per mounted body; close it on unmount (and on tab close via
  `ctx.sidebarRight.registerCloseHandler`).

## Host responsibilities

- Never expose CDP to the browser; screen content only leaves as JPEG frames.
- One Chrome process per Session, lazily launched, killed on Session dispose and plugin dispose
  (`process.kill(-pid)`; never leave orphans). Tab limit from config (default 4).
- Reject `file:`/`javascript:`/`data:` URLs (`nav-rejected`); allow http(s) only.
- `pick` = `Runtime.evaluate` of `document.elementFromPoint(cssX, cssY)` + descriptor builder;
  store into the Session's pending picks and inject the context text into the next agent step.
- Tools: `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`,
  `browser_screenshot`, `browser_tabs`, `browser_pick_last` — each calls the *same* service
  method as the HTTP action (one operation, two callers).