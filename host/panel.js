/**
 * Host runtime for the browser panel: per-Session Chrome ownership, the panel
 * HTTP transport (state / action / SSE stream), element picks with context
 * injection, and the agent tools registered against the same service methods.
 *
 * Contract (source of truth): ../CONTRACT.md. Every route starts with the
 * composition's `ctx.connection.requestRejection` trust fence and answers the
 * contract's `{ ok, ... }` / `{ ok:false, code, message }` shapes instead of
 * throwing.
 *
 * Lifecycle: Chrome is strictly lazy (first `ensure` action or first SSE stream
 * connect for a Session); one Chrome process group per Session; killed on
 * `shutdown`, on Session dispose (agent ctx effect), on idle reaping, and on
 * plugin dispose. Tabs are CDP page targets, screencast is per subscribed tab.
 */

import { randomUUID } from 'node:crypto'
import {
  Browser,
  BrowserPanelError,
  NoChromeError,
  NoTabError,
  PickFailedError,
  buildHoverLabel,
} from './browser.js'
import { registerBrowserTools } from './tools.js'

/** Transport path prefix served by the panel. */
export const PANEL_PATH = '/browser-panel'

/** Request bodies are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 1024 * 1024

/** Picks retained per Session for the panel list and `browser_pick_last`. */
const MAX_PICKS = 50

/** Message-source summary bound (`ContextFormed` notice). */
const SUMMARY_MAX_CHARS = 120

/**
 * Build the panel runtime.
 * @param ctx - Host Context (webServer, tools, agents, connection).
 * @param config - row config: Chrome executable/flags, tab and stream limits.
 * @returns {{ dispose: () => Promise<void> }}
 */
export function createBrowserPanelHost(ctx, config) {
  const settings = resolveSettings(config ?? {})
  const logger = loggerOf(ctx)
  /** @type {Map<string, object>} sessionId -> owned session record */
  const sessions = new Map()
  let disposed = false

  // ---- session records ----------------------------------------------------

  function sessionFor(sessionId) {
    let session = sessions.get(sessionId)
    if (session !== undefined) {
      session.lastUsedAt = Date.now()
      return session
    }
    if (sessions.size >= settings.maxSessions) evictOne()
    session = {
      id: sessionId,
      chrome: { status: 'idle', message: '', headless: settings.headless },
      browser: null,
      launching: null,
      pickMode: false,
      picks: [],
      /** pickIds stored but not yet injected (no live agent when picked). */
      deferredPicks: new Set(),
      /** @type {Map<import('node:http').ServerResponse, object>} */
      subscribers: new Map(),
      /** Panel-owned tab keys (Sidebar tab identity) mapped to a live Chrome target. */
      tabKeys: new Map(),
      hooked: new WeakSet(),
      lastUsedAt: Date.now(),
    }
    sessions.set(sessionId, session)
    attachAgentLifecycle(session)
    return session
  }

  function attachAgentLifecycle(session) {
    const agent = agentOf(session.id)
    if (agent === undefined || session.hooked.has(agent)) return
    session.hooked.add(agent)
    try {
      // Kill Chrome when the owning Session goes away (same pattern as the
      // terminal controller: the agent context owns the process lifetime).
      agent.ctx.effect(() => () => { void disposeSession(session.id) }, 'browser-panel.session')
    } catch (err) {
      logger.warn(`[browser-panel] could not hook Session dispose: ${messageOf(err)}`)
    }
  }

  function agentOf(sessionId) {
    try {
      return ctx.agents?.get(sessionId)
    } catch {
      return undefined
    }
  }

  async function disposeSession(sessionId) {
    const session = sessions.get(sessionId)
    if (session === undefined) return
    sessions.delete(sessionId)
    for (const subscriber of session.subscribers.values()) {
      subscriber.closed = true
      if (subscriber.off) {
        try { subscriber.off() } catch { /* ignore */ }
        subscriber.off = null
      }
      if (subscriber.pingTimer) clearInterval(subscriber.pingTimer)
      try { subscriber.res.end() } catch { /* client already gone */ }
    }
    session.subscribers.clear()
    const browser = session.browser
    session.browser = null
    clearTabKeys(session)
    session.chrome = { status: 'idle', message: '', headless: settings.headless }
    if (browser !== null) {
      await browser.dispose().catch((err) => { logger.warn(`[browser-panel] Chrome dispose failed: ${messageOf(err)}`) })
    }
  }

  function evictOne() {
    let oldest = null
    for (const session of sessions.values()) {
      if (session.browser !== null || session.subscribers.size > 0) continue
      if (oldest === null || session.lastUsedAt < oldest.lastUsedAt) oldest = session
    }
    if (oldest === null) {
      for (const session of sessions.values()) {
        if (oldest === null || session.lastUsedAt < oldest.lastUsedAt) oldest = session
      }
    }
    if (oldest !== null) void disposeSession(oldest.id)
  }

  // ---- Chrome ownership ---------------------------------------------------

  async function ensureChrome(session) {
    if (disposed) throw new NoChromeError('browser panel is shutting down')
    if (session.browser !== null && session.browser.alive) return session.browser
    if (session.launching !== null) return session.launching
    // A dead Chrome keeps its tabs in memory but none of them are live; drop it
    // (and its panel keys) before a fresh process starts a new t1..tN namespace.
    if (session.browser !== null) {
      const stale = session.browser
      session.browser = null
      clearTabKeys(session)
      void stale.dispose().catch(() => { /* already dead */ })
    }
    session.chrome = { status: 'launching', message: '', headless: settings.headless }
    broadcastStatus(session)
    const launchPromise = (async () => {
      try {
        const browser = await Browser.launch({
          executablePath: settings.chromeExecutable,
          headless: settings.headless,
          chromeArgs: settings.chromeArgs,
          width: settings.width,
          height: settings.height,
          maxTabs: settings.maxTabs,
          quality: settings.quality,
          maxWidth: settings.maxWidth,
          maxHeight: settings.maxHeight,
          fps: settings.fps,
          readyTimeoutMs: settings.launchTimeoutMs,
        })
        if (disposed) {
          await browser.dispose()
          throw new NoChromeError('browser panel is shutting down')
        }
        browser.onChange = () => {
          pruneTabKeys(session)
          broadcastStatus(session)
        }
        browser.onExit = (info) => {
          if (session.browser === browser) session.browser = null
          clearTabKeys(session)
          session.chrome = {
            status: 'error',
            message: `Chrome exited unexpectedly (code ${String(info?.code)}, signal ${String(info?.signal)})`,
            headless: settings.headless,
          }
          broadcastStatus(session)
        }
        session.browser = browser
        // Tab ids restart at t1 per Browser instance, so mappings from a previous
        // process must never resolve against the new namespace.
        clearTabKeys(session)
        session.chrome = { status: 'ready', message: '', headless: settings.headless }
        broadcastStatus(session)
        return browser
      } catch (err) {
        session.chrome = { status: 'error', message: messageOf(err), headless: settings.headless }
        broadcastStatus(session)
        if (err instanceof BrowserPanelError) throw err
        throw new BrowserPanelError(`Chrome launch failed: ${messageOf(err)}`, 'launch-failed')
      } finally {
        session.launching = null
      }
    })()
    session.launching = launchPromise
    return launchPromise
  }

  async function shutdownSession(session) {
    const browser = session.browser
    session.browser = null
    clearTabKeys(session)
    session.chrome = { status: 'idle', message: '', headless: settings.headless }
    if (browser !== null) await browser.dispose().catch((err) => { logger.warn(`[browser-panel] Chrome shutdown failed: ${messageOf(err)}`) })
    broadcastStatus(session)
  }

  /**
   * Drop `key -> tabId` entries whose target no longer exists (closed by the
   * page, the client, or a Chrome-side target destruction) or whose Browser is
   * gone. Without this a stale key could resolve to an unrelated new tab when
   * tab numbering restarts.
   */
  function pruneTabKeys(session) {
    if (session.tabKeys.size === 0) return
    const browser = session.browser
    if (browser === null || !browser.alive) {
      clearTabKeys(session)
      return
    }
    for (const [panelKey, mappedTabId] of session.tabKeys) {
      if (browser.tabs.get(mappedTabId) === undefined) session.tabKeys.delete(panelKey)
    }
  }

  /** Forget every panel key for this Session (Chrome replaced or gone). */
  function clearTabKeys(session) {
    if (session.tabKeys.size > 0) session.tabKeys.clear()
  }

  function chromeRow(session) {
    return {
      status: session.chrome.status,
      message: session.chrome.message,
      headless: session.chrome.headless,
    }
  }

  function requireBrowser(session) {
    if (session.browser === null || !session.browser.alive) {
      throw new NoChromeError('Chrome is not running for this Session (use the "ensure" action first)')
    }
    return session.browser
  }

  function tabRow(browser, tab) {
    return { ...tab.snapshot(), active: tab.tabId === browser.activeTabId }
  }

  function tabRows(session) {
    const browser = session.browser
    if (browser === null || !browser.alive) return []
    return browser.rows()
  }

  async function actionTab(session, tabId, { create = false, url } = {}) {
    const browser = requireBrowser(session)
    if (typeof tabId === 'string' && tabId.length > 0) {
      const tab = browser.getTab(tabId)
      if (tab === undefined) throw new NoTabError(`unknown tab: ${tabId}`)
      return tab
    }
    const active = browser.activeTab()
    if (active !== undefined) return active
    if (create) return browser.createTab(url ?? 'about:blank', { activate: true })
    throw new NoTabError('no open tab in this Session')
  }

  // ---- SSE subscribers ----------------------------------------------------

  function sseWrite(res, event, payload) {
    if (res.writableEnded || res.destroyed) return false
    try {
      return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch {
      return false
    }
  }

  function sseFrame(subscriber, frame) {
    const res = subscriber.res
    // Slow client: drop the frame (the newest frame wins anyway) instead of
    // growing an unbounded response buffer.
    if (typeof res.writableLength === 'number' && res.writableLength > settings.maxBufferedBytes) return
    const payload = {
      seq: frame.seq,
      w: frame.w,
      h: frame.h,
      data: frame.data,
      viewport: frame.viewport,
      ts: frame.ts,
    }
    if (frame.keepalive === true) payload.keepalive = true
    sseWrite(res, 'frame', payload)
  }

  function bindSubscriber(session, subscriber, tab) {
    if (subscriber.off !== null) {
      try { subscriber.off() } catch { /* ignore */ }
      subscriber.off = null
    }
    subscriber.boundTabId = tab === null ? null : tab.tabId
    if (tab !== null) {
      subscriber.off = tab.subscribeFrames((frame) => {
        if (subscriber.closed) return
        sseFrame(subscriber, frame)
      })
    }
  }

  /** The tab a subscriber should watch: requested, else active, else first. */
  function resolveSubscriberTab(session, subscriber) {
    const browser = session.browser
    if (browser === null || !browser.alive) return { tab: null, fallbackFrom: null }
    if (typeof subscriber.tabId === 'string' && subscriber.tabId.length > 0) {
      const requested = browser.getTab(subscriber.tabId)
      if (requested !== undefined) return { tab: requested, fallbackFrom: null }
    }
    const tab = browser.activeTab() ?? null
    const fallbackFrom = subscriber.tabId !== null && subscriber.tabId !== (tab?.tabId ?? null) ? subscriber.tabId : null
    return { tab, fallbackFrom }
  }

  function writeStatus(session, subscriber) {
    if (subscriber.closed) return
    const resolved = resolveSubscriberTab(session, subscriber)
    const browser = session.browser
    const payload = {
      chrome: chromeRow(session),
      tab: resolved.tab !== null ? tabRow(browser, resolved.tab) : null,
      pickMode: session.pickMode,
    }
    if (resolved.fallbackFrom !== null) {
      // The requested tab is gone/unknown; say which tab this stream actually
      // shows so the client can recover (CONTRACT addition, additive field).
      payload.requestedTabId = resolved.fallbackFrom
      payload.tabFallback = true
    }
    sseWrite(subscriber.res, 'status', payload)
  }

  function reconcileSubscribers(session) {
    if (session.subscribers.size === 0) return
    const browser = session.browser
    for (const subscriber of session.subscribers.values()) {
      if (subscriber.closed) continue
      const bound = browser !== null && subscriber.boundTabId !== null ? browser.getTab(subscriber.boundTabId) : undefined
      if (bound !== undefined) continue
      const resolved = resolveSubscriberTab(session, subscriber)
      if (resolved.tab !== null) bindSubscriber(session, subscriber, resolved.tab)
    }
  }

  function broadcastStatus(session) {
    pruneTabKeys(session)
    reconcileSubscribers(session)
    for (const subscriber of session.subscribers.values()) writeStatus(session, subscriber)
  }

  function broadcastPicks(session) {
    for (const subscriber of session.subscribers.values()) {
      if (!subscriber.closed) sseWrite(subscriber.res, 'picks', { picks: session.picks })
    }
  }

  function broadcastHover(session, rect, label) {
    for (const subscriber of session.subscribers.values()) {
      if (!subscriber.closed) sseWrite(subscriber.res, 'hover', { rect, label })
    }
  }

  // ---- picks + context injection ------------------------------------------

  /**
   * Literal `UserMessage` per packages/llm/llm/src/message.ts:
   * MessageBase {id, content, source} + role:'user'. The source uses a
   * plugin-declared kind and the `notice` context form (unvalidated at runtime,
   * rendered by the conversation UI as an injected context row).
   */
  function injectedMessage(pick) {
    const summaryText = [pick.tag + (pick.id ? `#${pick.id}` : ''), pick.text || pick.accessibleName || pick.selector]
      .filter(Boolean)
      .join(': ')
      .replace(/\s+/g, ' ')
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: pick.contextText }],
      source: { kind: 'browser-panel', form: 'notice', summary: summaryText.slice(0, SUMMARY_MAX_CHARS) },
    }
  }

  /**
   * Inject one pick's contextText into the Session's live agent. `inject` only:
   * the context attaches to the next model step and never starts a turn.
   * @returns {boolean} whether it was injected now
   */
  function injectPick(session, pick) {
    const agent = agentOf(session.id)
    if (agent === undefined) {
      session.deferredPicks.add(pick.pickId)
      return false
    }
    try {
      agent.inject(injectedMessage(pick))
      return true
    } catch (err) {
      session.deferredPicks.add(pick.pickId)
      logger.warn(`[browser-panel] context injection failed for ${pick.pickId}: ${messageOf(err)}`)
      return false
    }
  }

  /** Opportunistically flush picks made before the agent was live. */
  function flushDeferred(session) {
    if (session.deferredPicks.size === 0) return
    const agent = agentOf(session.id)
    if (agent === undefined) return
    for (const pickId of [...session.deferredPicks]) {
      const pick = session.picks.find((candidate) => candidate.pickId === pickId)
      if (pick === undefined) {
        session.deferredPicks.delete(pickId)
        continue
      }
      try {
        agent.inject(injectedMessage(pick))
        session.deferredPicks.delete(pickId)
      } catch (err) {
        logger.warn(`[browser-panel] deferred context injection failed: ${messageOf(err)}`)
        break
      }
    }
  }

  function addPick(session, pick) {
    session.picks.push(pick)
    if (session.picks.length > MAX_PICKS) {
      const dropped = session.picks.splice(0, session.picks.length - MAX_PICKS)
      for (const old of dropped) session.deferredPicks.delete(old.pickId)
    }
    broadcastPicks(session)
    injectPick(session, pick)
  }

  // ---- actions -------------------------------------------------------------

  async function perform(sessionId, tabId, action, params) {
    const session = sessionFor(sessionId)
    flushDeferred(session)
    const input = params !== null && typeof params === 'object' && !Array.isArray(params) ? params : {}
    switch (action) {
      case 'ensure': {
        await ensureChrome(session)
        return { chrome: chromeRow(session) }
      }
      case 'openTab': {
        const browser = await ensureChrome(session)
        const url = typeof input.url === 'string' && input.url.length > 0 ? input.url : 'about:blank'
        // A panel body may mount more than once (StrictMode, HMR, remount). A caller
        // that supplies its stable Sidebar tab key gets the same Chrome target back
        // instead of accumulating duplicates up to maxTabs.
        const key = typeof input.key === 'string' && input.key.length > 0 ? input.key : undefined
        if (key !== undefined) {
          const existingId = session.tabKeys.get(key)
          const existing = existingId === undefined ? undefined : browser.tabs.get(existingId)
          if (existing !== undefined) {
            if (url !== 'about:blank' && existing.url !== url) {
              await existing.navigate(url)
              await existing.waitForReady(5000)
            }
            browser.setActive(existing.tabId)
            return { tab: tabRow(browser, existing) }
          }
          session.tabKeys.delete(key)
        }
        // Reuse Chrome's lone startup tab instead of leaving a stray about:blank
        // next to the tab the panel just asked for (the panel opens one tab for
        // its first navigation; the client calls ensure + openTab).
        const only = browser.tabOrder.length === 1 ? browser.tabs.get(browser.tabOrder[0]) : undefined
        if (only !== undefined && only.url === 'about:blank' && only.sinks.size === 0 && !only.canGoBack) {
          await only.navigate(url)
          // Report the settled page, not the pre-navigation about:blank state.
          await only.waitForReady(5000)
          browser.setActive(only.tabId)
          if (key !== undefined) session.tabKeys.set(key, only.tabId)
          return { tab: tabRow(browser, only) }
        }
        const tab = await browser.createTab(url, { activate: true })
        if (key !== undefined) session.tabKeys.set(key, tab.tabId)
        return { tab: tabRow(browser, tab) }
      }
      case 'closeTab': {
        const browser = requireBrowser(session)
        const tab = await actionTab(session, tabId, { create: false })
        await browser.closeTab(tab.tabId)
        for (const [panelKey, mappedTabId] of session.tabKeys) {
          if (mappedTabId === tab.tabId) session.tabKeys.delete(panelKey)
        }
        for (const subscriber of session.subscribers.values()) {
          if (subscriber.tabId === tab.tabId) subscriber.tabId = null
        }
        broadcastStatus(session)
        return { closed: true }
      }
      case 'activate': {
        const browser = requireBrowser(session)
        const tab = await actionTab(session, tabId, { create: false })
        browser.setActive(tab.tabId)
        broadcastStatus(session)
        return { tab: tabRow(browser, tab) }
      }
      case 'navigate': {
        const browser = await ensureChrome(session)
        const tab = await actionTab(session, tabId, { create: true, url: input.url })
        await tab.navigate(input.url)
        return { tab: tabRow(browser, tab) }
      }
      case 'back': {
        const browser = requireBrowser(session)
        const tab = await actionTab(session, tabId, { create: false })
        await tab.goBack()
        return { tab: tabRow(browser, tab) }
      }
      case 'forward': {
        const browser = requireBrowser(session)
        const tab = await actionTab(session, tabId, { create: false })
        await tab.goForward()
        return { tab: tabRow(browser, tab) }
      }
      case 'reload': {
        const browser = requireBrowser(session)
        const tab = await actionTab(session, tabId, { create: false })
        await tab.reload()
        return { tab: tabRow(browser, tab) }
      }
      case 'resize': {
        const browser = requireBrowser(session)
        const tab = await actionTab(session, tabId, { create: false })
        const viewport = await tab.resize(input.width, input.height)
        browser.onChange?.()
        return { viewport }
      }
      case 'mouse': {
        const tab = await actionTab(session, tabId, { create: false })
        await tab.mouse({
          type: input.type,
          x: input.x,
          y: input.y,
          button: input.button,
          clickCount: input.clickCount,
        })
        return { ok: true }
      }
      case 'wheel': {
        const tab = await actionTab(session, tabId, { create: false })
        await tab.wheel({
          x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY,
        })
        return { ok: true }
      }
      case 'key': {
        const tab = await actionTab(session, tabId, { create: false })
        await tab.key({
          type: input.type,
          key: input.key,
          code: input.code,
          keyCode: input.keyCode,
          text: input.text,
          modifiers: input.modifiers,
        })
        return { ok: true }
      }
      case 'text': {
        const tab = await actionTab(session, tabId, { create: false })
        await tab.insertText(input.text)
        return { ok: true }
      }
      case 'pickArm': {
        session.pickMode = input.on === true
        broadcastStatus(session)
        return { pickMode: session.pickMode }
      }
      case 'probe': {
        // Always-on pointer feedback: best-effort, never throws, no SSE events.
        if (session.browser === null) return { hit: false, rect: null, label: null, tag: null, cursor: 'default' }
        let probeTab
        try {
          probeTab = await actionTab(session, tabId, { create: false })
        } catch {
          return { hit: false, rect: null, label: null, tag: null, cursor: 'default' }
        }
        return probeTab.probeAt(input.x, input.y)
      }
      case 'pickHover': {
        const tab = await actionTab(session, tabId, { create: false })
        const hover = await tab.hoverAt(input.x, input.y)
        // CONTRACT: the `hover` event exists only while pick mode is armed.
        if (session.pickMode) broadcastHover(session, hover.rect, hover.label)
        return hover
      }
      case 'pick': {
        const tab = await actionTab(session, tabId, { create: false })
        const pick = await tab.pickAt(input.x, input.y, { sessionId: session.id })
        addPick(session, pick)
        return { pick }
      }
      case 'picksDrop': {
        const pickId = typeof input.pickId === 'string' ? input.pickId : ''
        if (pickId.length === 0) throw new BrowserPanelError('pickId is required', 'bad-request')
        const before = session.picks.length
        session.picks = session.picks.filter((pick) => pick.pickId !== pickId)
        session.deferredPicks.delete(pickId)
        if (session.picks.length !== before) broadcastPicks(session)
        return { picks: session.picks }
      }
      case 'picksClear': {
        session.picks = []
        session.deferredPicks.clear()
        broadcastPicks(session)
        return { picks: session.picks }
      }
      case 'screenshot': {
        const tab = await actionTab(session, tabId, { create: false })
        const shot = await tab.screenshot({ format: input.format, quality: settings.quality })
        return { dataUrl: shot.dataUrl }
      }
      case 'shutdown': {
        await shutdownSession(session)
        return { ok: true }
      }
      default:
        throw new BrowserPanelError(`unknown action: ${action}`, 'bad-request')
    }
  }

  /**
   * Cheap state payload: cached tab fields only, no CDP round trips. Chrome is
   * never launched here (the panel's stream connect is the lazy launch point).
   */
  function statePayload(sessionId) {
    const session = sessionFor(sessionId)
    flushDeferred(session)
    pruneTabKeys(session)
    return {
      ok: true,
      chrome: chromeRow(session),
      pickMode: session.pickMode,
      tabs: tabRows(session),
      picks: session.picks,
    }
  }

  /** Resolve a CSS selector to the element's viewport-centre CSS point. */
  async function resolvePoint(sessionId, tabId, selector) {
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      throw new BrowserPanelError('selector is required', 'bad-request')
    }
    const session = sessionFor(sessionId)
    const tab = await actionTab(session, tabId, { create: false })
    const expression = `(function (sel) {
      var el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, w: rect.width, h: rect.height, tag: el.tagName.toLowerCase() };
    })(${JSON.stringify(selector.trim())})`
    const point = await tab.evaluate(expression)
    if (point === null || point === undefined) throw new PickFailedError(`selector not found: ${selector}`)
    return point
  }

  /** Focus (and optionally select the contents of) one selector in the tab. */
  async function focusSelector(sessionId, tabId, selector, clear) {
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      throw new BrowserPanelError('selector is required', 'bad-request')
    }
    const session = sessionFor(sessionId)
    const tab = await actionTab(session, tabId, { create: false })
    const expression = `(function (sel, clear) {
      var el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
      if (clear) { try { if (typeof el.select === 'function') el.select(); } catch (e) {} }
      return { tag: el.tagName.toLowerCase(), type: el.type || '' };
    })(${JSON.stringify(selector.trim())}, ${clear === true ? 'true' : 'false'})`
    const focused = await tab.evaluate(expression)
    if (focused === null || focused === undefined) throw new PickFailedError(`selector not found: ${selector}`)
    return focused
  }

  /** Scroll metrics for a model-facing scroll result. */
  async function scrollInfo(sessionId, tabId) {
    const session = sessionFor(sessionId)
    const tab = await actionTab(session, tabId, { create: false })
    const info = await tab.evaluate(`({
      scrollY: Math.round(window.scrollY),
      scrollX: Math.round(window.scrollX),
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth
    })`)
    return info ?? { scrollY: 0, scrollX: 0, scrollHeight: 0, innerHeight: 0, innerWidth: 0 }
  }

  /** Latest pick for a Session (agent tool `browser_pick_last`). */
  function lastPick(sessionId) {
    const session = sessionFor(sessionId)
    return session.picks.length > 0 ? session.picks[session.picks.length - 1] : null
  }

  /** Shared service surface used by both the HTTP action route and the tools. */
  const service = {
    settings,
    ensure: (sessionId) => ensureChrome(sessionFor(sessionId)),
    perform,
    state: statePayload,
    actionTab: (sessionId, tabId, opts) => actionTab(sessionFor(sessionId), tabId, opts),
    resolvePoint,
    focusSelector,
    scrollInfo,
    lastPick,
    shutdown: (sessionId) => shutdownSession(sessionFor(sessionId)),
    /** Diagnostic (self-test): the Chrome user-data-dir owned by this Session. */
    chromeUserDataDir: (sessionId) => sessions.get(sessionId)?.browser?.chrome?.userDataDir ?? null,
  }

  // ---- HTTP routes ---------------------------------------------------------

  const sendJson = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  const sendMethodNotAllowed = (res, allow) => {
    res.statusCode = 405
    res.setHeader('allow', allow)
    res.end()
  }

  /** The composition's trust fence: 401/403 before any work happens. */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  const route = (name, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PANEL_PATH}/${name}`,
    handler: (req, res) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((err) => {
          logger.warn(`[browser-panel] ${name} route failed: ${messageOf(err)}`)
          if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: messageOf(err) })
          else { try { res.destroy() } catch { /* ignore */ } }
        })
    },
  }), `browser-panel: ${name}`)

  const routeDisposers = []

  routeDisposers.push(route('state', async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const problem = validateSessionId(sessionId)
    if (problem !== null) { sendJson(res, 400, { ok: false, code: 'no-session', message: problem }); return }
    sendJson(res, 200, statePayload(sessionId))
  }))

  routeDisposers.push(route('action', async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return }
    let text
    try {
      text = await readBoundedBody(req)
    } catch (err) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: `request body unreadable: ${messageOf(err)}` })
      return
    }
    if (text === null) {
      sendJson(res, 413, { ok: false, code: 'bad-request', message: `request body exceeds ${MAX_BODY_BYTES} bytes` })
      return
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body must be JSON' })
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: 'request body must be a JSON object' })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const problem = validateSessionId(sessionId)
    if (problem !== null) { sendJson(res, 400, { ok: false, code: 'no-session', message: problem }); return }
    const action = typeof body.action === 'string' ? body.action : ''
    if (action.length === 0) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: 'action is required' })
      return
    }
    const tabId = typeof body.tabId === 'string' && body.tabId.length > 0 ? body.tabId : undefined
    const params = body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {}
    try {
      const result = await perform(sessionId, tabId, action, params)
      sendJson(res, 200, { ok: true, result })
    } catch (err) {
      const code = errorCode(err)
      const message = messageOf(err)
      if (code === 'bad-request') { sendJson(res, 400, { ok: false, code, message }); return }
      sendJson(res, code === 'internal' ? 500 : 200, { ok: false, code, message })
    }
  }))

  routeDisposers.push(route('stream', async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendMethodNotAllowed(res, 'GET'); return }
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const problem = validateSessionId(sessionId)
    if (problem !== null) { sendJson(res, 400, { ok: false, code: 'no-session', message: problem }); return }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // A comment frame makes an idle channel visibly live to proxies/clients.
    try { res.write(': connected\n\n') } catch { /* client gone */ }
    if (req.method === 'HEAD') { res.end(); return }

    const session = sessionFor(sessionId)
    const requestedTabId = url.searchParams.get('tabId')
    const subscriber = {
      res,
      tabId: typeof requestedTabId === 'string' && requestedTabId.length > 0 ? requestedTabId : null,
      boundTabId: null,
      off: null,
      pingTimer: null,
      closed: false,
    }
    session.subscribers.set(res, subscriber)
    subscriber.pingTimer = setInterval(() => {
      if (!subscriber.closed) sseWrite(res, 'ping', { t: Date.now() })
    }, 15_000)
    subscriber.pingTimer.unref?.()

    const cleanup = () => {
      if (subscriber.closed) return
      subscriber.closed = true
      session.subscribers.delete(res)
      if (subscriber.off !== null) {
        try { subscriber.off() } catch { /* ignore */ }
        subscriber.off = null
      }
      if (subscriber.pingTimer !== null) clearInterval(subscriber.pingTimer)
    }
    res.on('close', cleanup)
    res.on('error', cleanup)

    // Opening the panel is the lazy Chrome launch point (never `state`).
    try {
      await ensureChrome(session)
      let tab = null
      if (subscriber.tabId !== null && session.browser !== null) {
        tab = session.browser.getTab(subscriber.tabId) ?? null
      }
      if (tab === null && session.browser !== null) tab = session.browser.activeTab() ?? null
      if (tab === null && session.browser !== null) tab = await session.browser.ensureTab('about:blank')
      writeStatus(session, subscriber)
      if (tab !== null) bindSubscriber(session, subscriber, tab)
    } catch (err) {
      // A launch failure is a `status` condition, not a fatal stream error: the
      // stream stays open so the client's retry can succeed without reconnecting.
      logger.warn(`[browser-panel] stream ensure failed: ${messageOf(err)}`)
      writeStatus(session, subscriber)
    }
  }))

  // ---- agent lifecycle + idle reaper --------------------------------------

  let offAgentCreated = null
  try {
    offAgentCreated = ctx.on('agent/created', ({ agent }) => {
      if (agent === undefined || disposed) return
      try {
        const session = sessions.get(agent.id)
        if (session === undefined) return
        attachAgentLifecycle(session)
        flushDeferred(session)
      } catch (err) {
        logger.warn(`[browser-panel] agent/created flush failed: ${messageOf(err)}`)
      }
    })
  } catch (err) {
    logger.warn(`[browser-panel] could not subscribe to agent/created: ${messageOf(err)}`)
  }

  let reaperTimer = null
  if (settings.idleChromeMs > 0) {
    reaperTimer = setInterval(() => {
      if (disposed) return
      const now = Date.now()
      for (const session of [...sessions.values()]) {
        if (session.browser === null || session.subscribers.size > 0) continue
        if (now - session.lastUsedAt < settings.idleChromeMs) continue
        const browser = session.browser
        session.browser = null
        clearTabKeys(session)
        session.chrome = { status: 'idle', message: '', headless: settings.headless }
        void browser.dispose().catch((err) => { logger.warn(`[browser-panel] idle Chrome dispose failed: ${messageOf(err)}`) })
      }
    }, 60_000)
    reaperTimer.unref?.()
  }

  // ---- tools ---------------------------------------------------------------

  let disposeTools = () => {}
  try {
    disposeTools = registerBrowserTools(ctx, service, settings)
  } catch (err) {
    logger.warn(`[browser-panel] tool registration failed: ${messageOf(err)}`)
  }

  return {
    /** Exposed for tests: the shared service used by routes and tools. */
    service,
    settings,
    async dispose() {
      if (disposed) return
      disposed = true
      if (reaperTimer !== null) { clearInterval(reaperTimer); reaperTimer = null }
      if (offAgentCreated !== null) {
        try { offAgentCreated() } catch { /* ignore */ }
        offAgentCreated = null
      }
      try { disposeTools() } catch { /* ignore */ }
      for (const dispose of routeDisposers.reverse()) {
        try { dispose() } catch { /* ignore */ }
      }
      await Promise.allSettled([...sessions.keys()].map((sessionId) => disposeSession(sessionId)))
      sessions.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Resolve row config with bounded defaults. */
function resolveSettings(config) {
  const bounded = (value, fallback, min, max) => {
    const number = Math.round(Number(value))
    if (!Number.isFinite(number)) return fallback
    return Math.max(min, Math.min(max, number))
  }
  return {
    chromeExecutable: typeof config.chromeExecutable === 'string' && config.chromeExecutable.trim().length > 0
      ? config.chromeExecutable.trim()
      : '/usr/bin/google-chrome',
    headless: config.headless !== false,
    chromeArgs: Array.isArray(config.chromeArgs) ? config.chromeArgs.filter((arg) => typeof arg === 'string') : [],
    maxTabs: bounded(config.maxTabs, 4, 1, 16),
    quality: bounded(config.quality, 55, 1, 100),
    maxWidth: bounded(config.maxWidth, 1280, 160, 3840),
    maxHeight: bounded(config.maxHeight, 800, 120, 2160),
    fps: bounded(config.fps, 20, 1, 60),
    width: bounded(config.width, 1280, 320, 3840),
    height: bounded(config.height, 800, 240, 2160),
    launchTimeoutMs: bounded(config.launchTimeoutMs, 25_000, 1_000, 120_000),
    idleChromeMs: bounded(config.idleChromeMs, 15 * 60 * 1000, 0, 24 * 60 * 60 * 1000),
    maxSessions: bounded(config.maxSessions, 64, 1, 256),
    maxBufferedBytes: bounded(config.maxBufferedBytes, 4 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),
  }
}

/** Session ids are opaque branded strings; only reject obviously hostile ones. */
function validateSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) return 'sessionId is required'
  if (value.length > 256) return 'sessionId is too long'
  if (!/^[\x21-\x7E]+$/.test(value)) return 'sessionId contains unsupported characters'
  return null
}

/** Read a bounded UTF-8 body; resolves null past the ceiling (stream drained). */
function readBoundedBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Stable panel error code for any thrown value. */
function errorCode(err) {
  if (err !== null && typeof err === 'object' && typeof err.code === 'string' && err.code.length > 0) return err.code
  return 'internal'
}

function messageOf(err) {
  if (err instanceof Error) return err.message
  if (err !== null && typeof err === 'object' && typeof err.message === 'string') return err.message
  return String(err)
}

function loggerOf(ctx) {
  const logger = ctx?.logger
  if (logger !== undefined && logger !== null) {
    return {
      warn: (message) => {
        try { logger.warn(message) } catch { /* logger gone */ }
      },
      error: (message) => {
        try { logger.error(message) } catch { /* logger gone */ }
      },
    }
  }
  return { warn: (message) => console.warn(message), error: (message) => console.error(message) }
}