# DSH plain-JS Host+Client plugin — verified API cheat sheet

Checkout: `/path/to/dsh-checkout` (v0.2.1-rc.5). All `path:line` are relative to that root.
Everything below was read from `src/**` (host) or built `lib/**` (client); nothing is guessed.

## 0. Shape of a no-build bundle

Three files: `package.json` (`type:module`, `main`, `exports["./client"]`, `dsh.client`),
`index.js` (Host: `apply`/`inject`/`name`, no imports), `client.js` (Client: module-loader
registration). Locale dictionaries are inlined in `client.js` — the shipped packages use TS
modules, not JSON files.

* Host half is a Cordis function plugin: exports `name`, `inject`, optional `Config`, and
  `apply(ctx, config)`; `open-in-app` is the canonical example — **all its imports are
  `import type`**, i.e. erased, so the runtime module imports nothing:
  `packages/host/open-in-app/src/index.ts:44-46` (`export const name`, `export const inject`).
* It even reaches the connection service without importing its package:
  `Reflect.get(ctx, 'connection')` — `packages/host/open-in-app/src/index.ts:77-79`.
  Copy this pattern; it is the proof that a linked dir needs zero bare imports.
* Client half is a factory registration, not an ES module graph:
  `window.__ModuleLoader__.load({ id: '<pkg-name>', factory: (require) => { ...; exports.apply = apply; exports.inject = inject; return module.exports } })`
  — see `packages/client/ui-sidebar-terminal/lib/client.js:1-5` and its tail (`exports.apply/inject`).
* `package.json` client wiring: `"exports": { "./client": { "default": "./lib/client.js" } }` is
  resolved by the Host and served byte-for-byte from the package dir, so a **linked dir is
  served from its real location** (no copy): `packages/client/modules/src/index.ts:195-205`,
  `:866-871` (`join(dirname(pkgPath), clientRel)`).
* `dsh.client` fields: `platform` (required), `inject?`, `immediately?`, `external?` —
  `packages/util/package-manifest/src/types.ts:81-94`; parsed at
  `packages/client/modules/src/client/manifest.ts:173-193`. Its `inject` is *package-name*
  edges for factory arrival, **not** Cordis services (`types.ts:84-85`).

## 1. Host: HTTP routes (`ctx.webServer`)

```js
export const inject = ['webServer', 'connection']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',                    // 'exact' | 'prefix'
    path: '/browser-panel',            // absolute, no trailing slash
    handler: (req, res) => { /* owns the whole response lifecycle */ },
  }), 'browser-panel: routes')
}
```

* `kind`: `'exact'` matches pathname verbatim; `'prefix'` matches `p` and `p/<anything>`;
  longest prefix wins — `packages/host/webserver/src/index.ts:43-44`, `:543-552`.
* `handler(req, res): void | Promise<void>` — doc comment explicitly allows holding the
  response open: *"Owns the full response lifecycle (may hold the response open, e.g. SSE)"*
  — `webserver/src/index.ts:51-52`.
* `register()` returns a disposer and throws on duplicate `(kind, path)`
  — `webserver/src/index.ts:366-373`. Wrap in `ctx.effect` so unload removes it.
* Upgrade (WebSocket) routes — exact path only, one protocol owner:
  `webserver/src/index.ts:56-61`, `:381-387`; handler gets `(req, socket: Duplex, head: Buffer)`.
  Unmatched upgrades are `socket.destroy()`ed — `:499-502`.

### Streaming: what is safe

* No response timeout, no buffering of your writes: the handler gets the raw
  `ServerResponse`. Chunked `res.write()` + `res.end()` is fine.
* gzip is **on** in a `dsh web` profile: `packages/bundle/web-app/cordis.patch.yml:186-188`
  (`compression: gzip`, level 1, threshold 1024, defaults at `webserver/src/index.ts:106-108`).
* gzip filter exempts `text/event-stream` and `content-range`, and treats
  `multipart/form-data` as compressible — `webserver/src/index.ts:224-230`:
  ```js
  // :227  if (contentType.startsWith('text/event-stream')) return false
  ```
  ⇒ **SSE survives gzip; a `multipart/x-mixed-replace` or `application/octet-stream`
  screencast stream does NOT** (unknown-length streams are eligible for gzip:
  `webserver/src/index.ts:102-103`). Use `text/event-stream` + base64/binary-in-JSON frames.
* The server still answers 400 and logs on a thrown handler — `webserver/src/index.ts:443-457`.

### Auth guard for custom routes (do this, it is not optional)

A route registered directly on `webServer` is **outside** the `/api` fence, so it must guard
itself. Two idioms, both shipped:

```js
// HTML/asset-style route: use the index authenticator (it also mints the cookie)
if (!ctx.connection.authorizeIndex(req, res)) return
//   packages/experimental/inspector/src/host/plugin.ts:100

// JSON/SSE/upgrade route: trust fence + cookie check, no body written for you
const rejection = ctx.connection.requestRejection(req)   // 401 | 403 | undefined
if (rejection !== undefined) { res.writeHead(rejection).end(); return }
//   packages/host/open-in-app/src/index.ts:186
//   upgrade: socket.end(`HTTP/1.1 ${rejection} ...`) — inspector/src/host/plugin.ts:132-137
```

Exact signatures (`packages/client/connection/src/rpc.ts`):

| member | line | signature |
|---|---|---|
| `requestRejection` | `:233` | `(ConnectionTrustRequest) => 401 \| 403 \| undefined` |
| `admit` | `:240` | `(ConnectionTrustRequest) => { peer } \| { rejection }` |
| `admitConnection` | `:256` | `(…) => { peer, release } \| { rejection: 401\|403\|409 }` |
| `authorizeIndex` | `:266` | `(ConnectionIndexRequest, ConnectionIndexResponse) => boolean` |
| `createPeer` | `:247` | `({ principal, interactions? }) => PeerScope` |
| `browserPeer` | `:211` | the owner Peer every authenticated browser connection shares |

* `ConnectionTrustRequest` = `{ headers }` — `rpc.ts:98-101`.
* `requestRejection` is literally `admit()` folded to a status — `rpc-host.ts:123-126`;
  `admit` = Host/Origin fence (`api-request-trust.ts:121-152`) then cookie/API credential
  (`rpc-host.ts:129-137`).
* `authorizeIndex` serves the token→cookie exchange, a `303 ./` redirect, or a 401 —
  `browser-auth.ts:263-306`.

### Same-origin fetch from the GUI page: no token header

Auth is a **cookie** (`dsh-auth-<sha256(authority)>`, `browser-auth.ts:17-18`, `:116-118`)
set when the index was served. A same-origin `fetch()`/`EventSource` from the GUI carries it
automatically; `isAuthenticated` only reads `cookie` (`browser-auth.ts:356-357`). The
`?token=` query exists solely for first login (`:17`, `:266-289`). The Origin/Host checks are
satisfied by a same-origin request (`api-request-trust.ts:141-152`).

## 2. Host: exact `/api` Fetch routes (better than a raw route)

```js
export const inject = ['connection']

export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/browser-panel/stream',   // must be under /api
    methods: ['GET'],                    // GET | HEAD | POST only
    requestBody: 'buffered',             // or 'streaming'
    fetch: async (request) => new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    }),
  }), 'browser-panel: stream')
}
```

* Type: `ConnectionFetchRoute` — `rpc.ts:152-166` (`path` `:155`, `methods` `:157`,
  `requestBody` `:159`, `fetch(request) => Promise<Response>` `:165`).
* Auth is applied by the carrier; non-owner Peers get 403, and only owner Peers reach your
  route — `rpc-host.ts:219-221`. **You write no auth code here.**
* Path validation: must be `/api/<segment>[/<segment>…]`, segments `[A-Za-z0-9_$.-]+`
  (`rpc-host.ts:404-412`, pattern `:38`, endpoint parser `:361-370`). Duplicate path throws
  (`:245-247`).
* Streaming responses ARE streamed to the socket with backpressure: the bridge iterates
  `response.body` and awaits `drain` — `http-bridge.ts:106-125`. Client disconnect aborts via
  `res.on('close')` — `:50-52`.
* `requestBody: 'streaming'` gives `Readable.toWeb(req)` and no aggregate cap (`:88-96`);
  buffered bodies are capped at 300 MiB → 413 (`:15`, `:61-88`).
* Gotcha: after a streaming request body, the bridge sets `connection: close` if the request
  was not fully read — `http-bridge.ts:98-100`.
* SSE over `/api` still passes the gzip filter (content-type test at
  `webserver/src/index.ts:227`), so this is the recommended screencast carrier.

## 3. Host: tools (`ctx.tools.register`)

Runtime shape is stricter than a bare literal — `output` is **mandatory**:

```js
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'browser_clicked_element',
    description: 'Report the element the user last clicked in the Browser panel.',
    parameters: {                       // raw JSON Schema object
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.ok ? 'captured' : 'missing' }],
    },
    async execute(args, exec) {         // exec: ToolRunContext
      exec.signal.throwIfAborted()
      return { ok: true }               // the canonical value, NOT content blocks
    },
  }), 'browser-panel: tool')
}
```

Verified facts:

* `ToolSchema = { deferLoading?, name, description, parameters: Record<string, unknown> }`
  — `packages/llm/llm/src/types.ts:491-502`. `parameters` is plain JSON Schema.
* `ToolDefinition extends ToolSchema` with **required** `output: { schema, render(args,value): ContentBlock[], presentationMeta? }`
  — `packages/core/tools/src/index.ts:224-231`.
* `execute(args: unknown, exec: ToolRunContext): Promise<unknown>` returns the canonical
  JSON value that `output.schema` validates — `index.ts:240-246`; `render` is the only place
  content blocks are produced (`:226-229`).
* `exec` (ToolRunContext) carries `callId`, `rootCallId`, `name`, `arguments`, `agent?`,
  `signal`, `token`, plus `deferContext(msg)` and `concludeTurn()`
  — `index.ts:327-346`, `:394-419`, `:409`, `:415`.
* A **plain object literal is supported**; `register()` validates at runtime and throws
  `TypeError: tool "x" must declare output { schema, render, presentationMeta? }`
  — `index.ts:1071-1085`. `defineTool` (`schema.ts:554`) is a typing convenience only.
* Reserved name `run_code` throws — `index.ts:1089-1091`. Invalid `timeoutMs` throws (`:1081-1084`).
* Content block: `{ type: 'text', text }` — `packages/llm/llm/src/types.ts:62-65`.

## 4. Host: agent context

```js
const agent = ctx.agents.get(sessionId)      // Agent | undefined
if (agent) agent.inject({
  role: 'user',
  id: crypto.randomUUID(),
  content: [{ type: 'text', text: 'User clicked <button#buy> on example.com' }],
  source: { kind: 'browser-panel', form: 'notice', summary: 'clicked #buy' },
})
```

* `UserMessage extends MessageBase { role: 'user' }` = `{ id, content: ContentBlock[], source, role }`
  — `packages/llm/llm/src/message.ts:160-163`, `MessageBase` `:130-140`.
* `Agent.inject(message)` — `packages/core/agent/src/runtime-types.ts:241`; implementation is
  `send(input, 'next-step', false)` — **queues, never wakes** —
  `packages/core/agent-loop/src/agent.ts:171-173`, `:151-158`.
* Therefore: `inject` is safe from a timer/HTTP handler (pure synchronous inbox splice, no
  throw for a live agent) but an idle agent will not act until something wakes it. Use
  `followup(msg)` (new turn + wake, `runtime-types.ts:222`) or `steer(msg)` (`:231`) when the
  click must produce an immediate turn; `inject` is for "next time you run".
* `ctx.agents.get(sessionId): Agent | undefined` — `packages/core/agent/src/index.ts:568-570`;
  `agents.list()` `:585-587`. Session ids and agent ids are the same value (`:261-266`).
* `source.kind` is merge-extensible and **not validated at runtime** (`createMessage` only
  deep-freezes, `packages/llm/llm/src/message.ts:222-228`); `form:'notice'` requires
  `summary` (max 120 chars, `message.ts:122-127`). Shipped precedent for injecting from a
  plugin: `packages/jobs/tool-jobs/src/index.ts:288-300` (`createUserMessage` + `inject`).

## 5. Client: sidebar tab type + body

```js
const ID = 'browser-panel'
const NS = 'browserPanel'

export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

function Body(props) {
  const { tab } = props.useTabInfo()        // framework-injected
  const sessionId = props.sessionId         // standard session-scope prop
  return React.createElement('section', { 'data-browser-panel': '' },
    React.createElement('canvas', { ref: /* … */ }))
}

export function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, 'en', { title: 'Browser', new: 'New Browser' }), 'bp:copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: 'browserPanel',            // kind is what openTab() names
    title: () => t('title'),                 // (address: string) => string
    multiple: true,
    keepMounted: true,
    priority: 'extension',                   // 'extension' | 'builtin' | 'fallback'
    guide: [{ id: 'new', order: 10, title: () => t('new'), icon: MyIcon }],
  }), 'bp:type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: ID, locale: NS },
    Body,
  )), 'bp:body')
}
```

* `SidebarRightTabDefinition` — `packages/client/ui-sidebar-right/src/client/tab-registry.ts:94-139`:
  `id` (`:102`, unique implementation identity = the slot `key`), `kind` (`:104`), `multiple`
  (`:106`), `keepMounted` (`:108`), `patterns` (`:119`, omit for a page type), `priority`
  (`:121`, default `'extension'` `:59`), `canOpen` (`:130`), `title(address)` (`:136`),
  `guide` (`:138`).
* Guide entry: `{ id, order, title(), description?(), icon?: ComponentType<IconProps>, commandId? }`
  — `tab-registry.ts:62-83`. Duplicate guide ids throw (`:256`); duplicate `id` throws (`:258`).
* Registration is per-plugin-lifetime; `register` returns a disposer (`:253-281`).
* Body slot declaration (owned by ui-sidebar-right, not by you):
  `'sidebar.right.pane.tab': { kind:'keyed', scope:'session', hookContext, inject: SidebarRightTabInjected }`
  — `packages/client/ui-sidebar-right/src/client/contract/slots.ts:59-64`; child registration
  at `.../client/index.ts:219-220`.
* Body props = `PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<NS> & InjectFace<yourInject>`
  (`packages/client/ui-slots/src/index.ts:605-614`):
  – framework-injected `useTabInfo()` comes from the slot's declared
    `inject.hooks.tabInfo` (`slots.ts:195-197`; hooks become `use<Name>` —
    `ui-slots/src/index.ts:567-574`); you do **not** register it.
  – `sessionId: SessionId`, `useSession`, `useProjection`, `useAccess` are the session-scope
    standard props — `packages/client/ui-session/src/client/index.ts:166-175`.
  – your `inject: (sessionId) => face` return value arrives as plain props (or `use<Name>`
    hooks if you use `hooks:` / `keyedHooks:`) — `ui-slots/src/index.ts:588-595`.
* `useTabInfo()` returns `{ sidebar:{expanded,fullscreen}, panel:{id}, tab }` where
  `tab = TabRecord & { visible, navigation, signal, refreshShortcut?, actions }`
  — `contract/slots.ts:166-186`.
* Self-service from the body: `tab.actions.openTab(kind, opts)`, `.openResource`,
  `.close()`, `.bindCommands({refresh})` — `contract/slots.ts:141-163`.
  Example: `packages/client/ui-sidebar-terminal/src/client/terminal.tsx:31`
  (`tab.actions.openTab('terminal', { replaceTab: true })`), `:42`.
* From outside: `ctx.sidebarRight.openTab(kind, { params })` acts on the **on-screen** session
  (`service.ts:209-216`, `:332`); `openTabIn(sessionId, kind, opts)` (`:358`);
  `openTabFromTarget(kind, target)` (`:534`); `registerCloseHandler(kind, fn)` (`:277-281`).
  `params` are unvalidated JSON (`contract/params.ts:1-10`), read back via
  `tab.navigation.params` / `tabDomain.occurrence(...).navigation`.
* Optional live title: register the same `key` into `'sidebar.right.pane.tab.title'`
  (`contract/slots.ts:73-78`; terminal example `src/client/index.ts:139-141`).

## 6. Client: locale

```js
ctx.locale.register('browserPanel', 'en', { title: 'Browser' })   // untyped, single locale
ctx.locale.register('browserPanel', { en: {...}, zh: {...} })     // typed, both builtins
const t = ctx.locale.bind('browserPanel')
```

* Overloads: `register(ns, dicts: Record<BuiltInLocaleId, LocaleDict>)` —
  `packages/client/locale/src/client/index.ts:389`; `register(ns, locale, dict)` — `:399`.
  Implementation `:400-441`; duplicate `(ns, locale)` throws (`:412-416`); bad tag throws
  (`:404-407`).
* `LocaleDict = Record<string, string>` — `locale/src/client/index.ts:51`.
* `BuiltInLocaleId = 'zh' | 'en'` — `locale/src/locale-settings.ts:15,18`; fallback `'en'`
  (`client/index.ts:109`). Missing key returns the key itself (`:468-470`).
* `bind(ns)` returns a stable function, safe to pass through inject faces — `:447-466`.

## 7. Client: module table (what `require` may name) — hard limit

`require(spec)` in your factory resolves **only** from this frozen seed table, then from other
registered client bundles, else it throws (`packages/client/modules/src/client/system.ts:326-334`,
`:379-390`).

Seed words — `packages/client/web/src/seed.ts:21-33`:

```
react   react/jsx-runtime   react-dom   react-dom/client
@deepseek-ai/cordis   zod   @tanstack/react-virtual
@deepseek-ai/dsh-client-store   @deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives   @deepseek-ai/dsh-client-ui-dockkit
```

* Anything else must be a loaded client plugin package (`system.ts:340-352`) and must be
  declared in `dsh.client.external` (`package-manifest/src/types.ts:88-93`). `/client`
  subpaths are normalized by `stripClientSuffix` (`modules/src/client/manifest.ts:218-220`).
* There is no `require('./x')`; relative chunks go through `require.async('./chunk-…')`
  (`system.ts:336-350`). For a no-build plugin: one file, seed words only.

## 8. Theme tokens (use `var(--…)`, no service needed)

`packages/client/ui-theme/src/client/index.ts:137-152` (the inspect registry):

```
--dsw-alias-bg-base          --dsw-alias-bg-layer-1      --dsw-alias-bg-layer-2
--dsw-alias-bg-overlay       --dsw-alias-border-l1       --dsw-alias-border-l2
--dsw-alias-brand-primary    --dsw-alias-label-primary   --dsw-alias-label-secondary
--dsw-alias-state-error-primary  --dsw-alias-state-idle-primary
--dsw-alias-state-success-primary  --dsw-alias-state-warn-primary
--dsw-specific-sidebar-fill   (sidebar column + title-row background)
```

Additional tokens actually used by shipped sidebar CSS (not in the inspect list):
`--dsw-alias-border-l3`, `--dsw-alias-border-l4`, `--dsw-alias-label-tertiary`,
`--dsw-alias-bg-layer-3`, `--dsw-alias-bg-layer-4`, `--dsw-alias-interactive-bg-hover`,
`--dsw-alias-interactive-bg-active`, `--dsw-alias-button-tool-bar-fill`,
`--dsw-alias-button-tool-bar-hover`, `--dsw-alias-separator-primary`,
`--dsw-alias-fill-tertiary`, `--dsw-alias-scrollbar-bg-l1` (grep of
`packages/client/**/*.css`; sample use `ui-sidebar-terminal/src/client/TerminalGuide.module.css:1`:
`border: .5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1)`).

Concrete mapping for the panel: surface `--dsw-alias-bg-layer-1`; page/stage
`--dsw-alias-bg-base`; divider `.5px solid var(--dsw-alias-border-l3)`; text primary
`--dsw-alias-label-primary`, secondary `-secondary`, muted `-tertiary`; accent/hover
`--dsw-alias-brand-primary` / `--dsw-alias-interactive-bg-hover`.

`ctx.theme` exists but is only needed for JS-side values (fonts/sizes) or for a
`useTheme` hook: `ThemeRuntime.getTheme()` + `'theme/change'` event, forwarded as an
observable exactly as `ui-sidebar-terminal/src/client/index.ts:121-124` does.

## 9. Composer reference chip: what is actually possible

* [NO] Public `InputActions` (props of every session-scope input slot) is text + attachments
  only: `captureInsertion`, `insertText`, `setDraft`, `persistDraft`, `addAttachments`,
  `removeAttachment`, `pruneAttachments`, `submit` —
  `ui-conversation/src/client/contract/input.ts:255-277`.
* [YES, lower layer] `SessionInput.insertReference(ref, span)` — `contract/input.ts:183-187`,
  `InputTarget.insertReference` `:172-181`; `ref = { source, ref, label, appearance?:
  'session'|'file'|'folder', clipboardText }` (`contract/draft-editor.ts:14-20`),
  `span = { start, end, draftRev }` (`:6-10`).
* [GATE] Reachable only through a **session-scope Context**:
  `ctx.conversation.input.for(actx)` (`ui-conversation/src/client/service.ts:40-42`;
  `contract/input.ts:216-225`), which throws without a retained Session scope
  (`input/hub.ts:71-76`). The `slash/input-insert-reference` listeners sit on that session ctx
  (`input/hub.ts:150-158`), so a root-level `ctx.emit` never reaches them.
* [HACK] Runtime-only: `ctx.conversation.input` is the `InputHub` instance, so
  `hub.shell(sessionId)` returns the `SessionInput` (`input/hub.ts:180-186`); `keyboard(id)` is
  documented package-internal (`:191-197`).
* Verdict: plain text into the composer is public (`insertText`/`setDraft`) — a real reference
  chip is **not** public API. Either accept the duck-typed `shell(id).insertReference(...)`
  (needs a mounted composer and a fresh `draftRev`) or deliver the click as Host-side agent
  context (§4).

## 10. Patterns to copy

* Toolbar button: `ui-primitives` `Button` with `variant`/`size`/`icon` —
  `Button variant="outline" size="sm"` (`ui-sidebar-terminal/src/client/terminal.tsx:60-64`),
  `Button variant="primary" size="sm|md"` (`:31-33`).
* Icon-only 20×20 button (`border-radius: 4px`, 14×14 svg, `--dsw-alias-label-tertiary`):
  `.trigger` in `ui-sidebar-terminal/src/client/TerminalGuide.module.css`; smaller variant in
  `ui-sidebar-right/src/client/shell/ExpandButton.tsx`.
* Splitter: the right sidebar's own resize belongs to the dock kit
  (`@deepseek-ai/dsh-client-ui-dockkit` is a seed word). For a panel-local divider there is no
  shipped helper — `pointerdown` + `setPointerCapture` driving a CSS custom property on the
  body root is the self-contained option.
* Test markers are attributes only: `data-sidebar-terminal` (`terminal.tsx:37`, `:57`);
  use `data-browser-panel` likewise.
* `keepMounted: true` on the type is what keeps the canvas/DOM alive across tab switches,
  session switches and collapse (`tab-registry.ts:108`) — the shipped browser tab relies on it
  (`packages/client/ui-sidebar-browser/README.md`, "Controller").

## 11. Dev loop without a build

* Edits to `client.js` do **not** hot-apply: HMR only reloads on watcher rebuilds, which come
  from `pnpm run dev:web` (`packages/client/hmr/README.md`, "Starting the reload chain").
  A plain refresh picks up new bytes, because the bundle is read from disk per request.
* Manual swap without a page reload is possible: `ctx.clientModules.rebuilt('<pkg-name>')`
  republishes the bundle revision and notifies the browser
  — `packages/client/modules/src/index.ts:729-751`; call it from your Host half after writing
  `client.js`.
* A broken client entry rejects the whole GUI boot audit — `boot-client.ts:70-95`
  (`assertEntriesActive`). Ship a syntax-checked file: `node --check client.js`.