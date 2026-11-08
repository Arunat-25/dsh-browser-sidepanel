# Browser panel — blockers, risks, mitigations

Evidence paths are relative to `/path/to/dsh-checkout` (v0.2.1-rc.5).
Severity: **[BLOCK]** design cannot proceed as-is · **[HIGH]** will bite in normal use ·
**[MED]** plan around it · **[LOW]** note.

---

## 1. Hard blockers

### 1.1 [BLOCK→solved] Bare imports from a linked dir
The bundle is linked, not copied, and Node resolves a module's own imports from its
**realpath**, so `import z from '@deepseek-ai/schemastery'` or
`import { defineTool } from '@deepseek-ai/dsh-tools'` in the Host half only works if the
bundle directory sits under a tree that has those packages in `node_modules`. A bundle under
`~/coding/…` does not.
**Confirmed as avoidable:** the Host half needs *no* runtime imports at all — a shipped
plugin does exactly this, importing types only and reaching services by duck-typed
`Reflect.get(ctx, 'connection')` (`packages/host/open-in-app/src/index.ts:17-31`, `:77-79`).
Mitigation: **no imports in `index.js`; no `Config` export** (`Config` requires
`schemastery` — `packages/host/webserver/src/index.ts:279-297`). Types are irrelevant for
plain JS. If a dependency is ever unavoidable, put the bundle inside the DSH workspace tree
instead.

### 1.2 [HIGH] A broken Client bundle breaks the entire GUI, not just the panel
`bootClient` audits every entry after activation and **rejects startup** for any entry that is
failed or still `pending` (unsatisfied `inject` service), printing the missing service names —
`packages/client/web/src/boot-client.ts:66-89`. So a typo in `export const inject = [...]`, a
syntax error, or a duplicate slot key yields a dead Web GUI.
Mitigation: `node --check client.js` before install; keep the `inject` list minimal and
exactly the service names from §5 (cheat sheet); test with the plugin disabled first, then
enable.

### 1.3 [HIGH] Untested screencast transport is silently re-encoded or buffered
gzip is enabled in the shipped Web composition
(`packages/bundle/web-app/cordis.patch.yml:186-188`). The gzip filter exempts only
`text/event-stream` and `content-range` (`packages/host/webserver/src/index.ts:224-230`), and
unknown-length streams are *eligible* for gzip (`:102-103`), so a
`multipart/x-mixed-replace` or `application/octet-stream` frame stream gets deflated and
coalesced.
Mitigation: carry frames as `text/event-stream` with base64 JPEG payloads; never rely on
per-chunk boundaries of a non-SSE content type.

---

## 2. Auth and transport

* **[LOW] Custom `webServer` routes are unauthenticated unless you guard them.** `/api` routes
  get the fence for free (`packages/client/connection/src/rpc-host.ts:219-221`), raw routes do
  not — copy `authorizeIndex` (HTML) or `requestRejection` (JSON/SSE/upgrade)
  (`packages/experimental/inspector/src/host/plugin.ts:100`, `:132`;
  `packages/host/open-in-app/src/index.ts:186`).
* **[LOW] Same-origin fetch needs no token header** — auth is the `dsh-auth-*` cookie minted at
  index time (`packages/client/connection/src/browser-auth.ts:17-18`, `:263-306`, `:356-357`).
  Do not build a token-passing scheme; it would also fail the Origin fence
  (`api-request-trust.ts:141-152`).
* **[MED] `ctx.connection.fetch.register` accepts only `GET | HEAD | POST`**
  (`packages/client/connection/src/rpc.ts:147`). Mouse/key events must be POSTs to a
  `/api/...` path; no `DELETE`/`PUT` verbs, no `PATCH`.
* **[MED] Per-origin connection budget.** A long-lived `EventSource` plus the GUI's own
  socket/fetches can exhaust the browser's 6 HTTP/1.1 connections per origin if the panel is
  opened in several tabs. One SSE per *page*, multiplexed by tab id, is the safe shape.
* **[MED] A failed/aborted request body on a `streaming` route forces `connection: close`**
  (`packages/client/connection/src/http-bridge.ts:98-100`), so don't mix a half-read upload
  body with a long-lived response on the same request.

---

## 3. Chrome / CDP

* **[HIGH] Chrome must be launched with a debugging port** (`--remote-debugging-port=9222`,
  ideally `--user-data-dir=<tmp>`), and the Host must own that lifecycle. DSH gives no
  browser-provisioning service; anything shipped must either attach to an existing endpoint
  or spawn Chrome itself, and spawning is a new failure surface (missing binary, port taken,
  orphan processes on unload).
* **[MED] No CDP dependency may be imported.** The Host half cannot `import 'ws'`
  (see 1.1). Node 24 does expose a global `WebSocket` (`node -e "typeof WebSocket"` → `function`,
  verified on v24.15.0), so the CDP client is raw global `WebSocket` + JSON framing — fine, but
  it is hand-written protocol code.
* **[MED] Screencast volume.** `Page.startScreencast` JPEG frames base64-expand ~33% and must be
  drawn straight into the canvas from the socket handler; routing frames through React state
  will drop the frame rate. `keepMounted: true` on the tab type keeps the canvas alive across
  tab switches (`packages/client/ui-sidebar-right/src/client/tab-registry.ts:108`).
* **[LOW] Input mapping is yours.** CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` need
  coordinates in the *page* viewport, so the panel must map canvas CSS pixels → screencast
  viewport using the frame's `metadata.deviceWidth/Height` and its own `devicePixelRatio`.

---

## 4. Namespace, collisions, composition

* **[MED] The kind `browser` and the slot key `@deepseek-ai/dsh-client-ui-sidebar-browser` are
  already taken** by a shipped iframe/`<webview>` sidebar browser
  (`packages/client/ui-sidebar-browser/src/client/definition.tsx:9-31`; disabled by default in
  Web profiles per its README). An `extension`-priority registration may legitimately
  *shadow* that `builtin` (`tab-registry.ts:181-183`, `:291-297`) — it will not throw — but it
  means enabling both silently replaces the shipped Browser. Use a distinct kind (e.g.
  `cdpBrowser`) and a distinct slot key to avoid surprise.
* **[HIGH] Duplicate `id`, duplicate guide-entry id, or a same-band kind collision throw at
  registration time** (`tab-registry.ts:256-262`) → Client entry fails → 1.2.
* **[MED] Route-path collisions throw inside `apply`** (`webserver/src/index.ts:368-370`,
  `:382-384`), failing the Host fiber. The web-app bundle runs a required-entry audit after the
  tree settles (`packages/bundle/web-app/cordis.patch.yml:194`), so a collision inside a
  *required* row aborts the app; a third-party row fails alone. Pick a unique prefix
  (`/browser-panel`, `/api/browser-panel/*`).

---

## 5. Agent-context capture

* **[HIGH] `agent.inject()` never wakes the agent.** It is `send(msg, 'next-step', false)` —
  `packages/core/agent-loop/src/agent.ts:171-173`. With an idle agent a clicked element sits in
  the inbox and may reach the model turns later (or after its next prompt). If a click must
  start a turn, use `followup()` (`packages/core/agent/src/runtime-types.ts:222`) or
  `steer()` (`:231`); `steer` on an idle driver starts a turn, `inject` never does.
* **[MED] There is no public reference-chip API.** `InputActions` is text + attachments only
  (`packages/client/ui-conversation/src/client/contract/input.ts:255-277`); chips live behind
  `ctx.conversation.input.for(sessionScopeCtx)` (`input/hub.ts:71-76`), and the scoped
  `slash/input-insert-reference` listeners are attached to that session ctx (`:150-158`), so a
  root-level `ctx.emit` will not reach them. Treat any "chip" as unsupported API; deliver the
  capture as Host-side agent context instead (tool result / `inject`).
* **[LOW] `source.kind` is unvalidated at runtime** (`packages/llm/llm/src/message.ts:222-228`)
  but is durable log content; use a stable, product-prefixed kind and a bounded
  `form:'notice'` summary (≤120 chars, `message.ts:122-127`) so replays and UIs render sanely.

---

## 6. Dev loop / HMR

* **[HIGH] No build ⇒ no HMR.** Live reload is driven by watchers (`pnpm run dev:web`) that call
  `clientModules.rebuilt()` (`packages/client/hmr/README.md`; `packages/client/modules/src/index.ts:729-751`).
  A plain-JS bundle is only re-read on page refresh — unless you call
  `ctx.clientModules.rebuilt('<pkg-name>')` yourself from the Host half after writing
  `client.js`, which does swap the plugin in the open page.
* **[MED] Reload loses plugin state** (React state resets on swap; session/connection survive) —
  `packages/client/hmr/README.md`, "What a reload does".
* **[LOW] No CSP is served** — the GUI's index has no CSP meta
  (`apps/web/index.html:1-16`) and the static server writes only `content-type`
  (`packages/host/frontend-static/src/index.ts:104`), so `connect-src`, `img-src` with
  `data:`/`blob:`, and inline `<style>` are unrestricted. Do not add a CSP dependency to the
  design.

---

## 7. Plain-JS React constraints

* **[MED] Only seed words are requirable**: `react`, `react/jsx-runtime`, `react-dom`,
  `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`,
  `@deepseek-ai/dsh-client-store`, `-ui-slots`, `-ui-primitives`, `-ui-dockkit`
  (`packages/client/web/src/seed.ts:21-33`; resolver `…/modules/src/client/system.ts:326-334`).
  No hook libraries, no state managers, no UI kit beyond `ui-primitives`, no JSX transform:
  write `h = React.createElement` (or the jsx-runtime's `jsx`) by hand.
* **[MED] Framework-injected props are by convention, not magic**: your component receives
  `useTabInfo`, `sessionId`, `useSession`, `useProjection`, `useAccess`, plus your own inject
  face; anything you destructure and don't get is `undefined` at runtime with no error
  (`packages/client/ui-slots/src/index.ts:588-614`;
  `packages/client/ui-session/src/client/index.ts:166-175`).
* **[LOW] CSS must be injected by hand** — the built bundles embed `<style data-plugin-css>` from
  the factory (`packages/client/ui-sidebar-terminal/lib/client.js:6-17`). Do the same, guarded
  by `document.querySelector("style[data-plugin-css=...]")`, so an HMR swap does not stack
  copies.

---

## 8. Verification gaps in this report

* Nothing was executed against a live profile (no install, no page reload); all claims are
  source/build-artifact reads.
* The claim that a linked bundle's Host imports fail (1.1) is reasoned from Node's realpath
  resolution and the absence of `node_modules` above the bundle dir; it was not reproduced.
  The *mitigation* (zero imports) is verified against a shipped plugin, so the risk is retired
  either way.
* Chrome-side behaviour (CDP screencast quality, `--remote-allow-origins`) is documented
  Chromium behaviour, not verified in this checkout.