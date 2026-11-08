/**
 * Agent tools for the browser panel.
 *
 * Every tool calls the *same* service methods as the panel's HTTP actions (one
 * operation, two callers). The browser is the panel's own CDP-controlled Chrome,
 * not the user's browser: coordinates are CSS pixels in the page viewport, the
 * same space as `PickDescriptor.rect` and the screencast frame's `viewport`.
 *
 * Tool failures are returned as normal output values `{ ok:false, code, error }`
 * (never thrown) so the model can read and recover from them; `render` turns
 * any value into model-facing content.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jpegSize } from './browser.js'

/** Output schema shared by every tool (free-form JSON object). */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

/** Model-facing text bound; the canonical value is unchanged. */
const RENDER_MAX_CHARS = 4000

/** Directory for screenshots handed to the model as files. */
const SCREENSHOT_DIR = join(tmpdir(), 'dsh-browser-sidepanel')

/**
 * Register the browser tools on the host tool registry.
 * @param ctx - Host Context with `tools`.
 * @param service - the panel service shared with the HTTP routes.
 * @param settings - resolved panel settings.
 * @returns disposer removing every registered tool.
 */
export function registerBrowserTools(ctx, service, settings) {
  const disposers = []
  for (const definition of buildToolDefinitions(service, settings)) {
    disposers.push(ctx.effect(
      () => ctx.tools.register(definition),
      `browser-panel.tool.${definition.name}`,
    ))
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* already disposed */ }
    }
  }
}

/** Resolve the owning Session id from a tool execution, or null. */
function sessionIdOf(exec) {
  const agent = exec?.agent
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** One failed tool value (rendered, never thrown). */
function failure(code, message) {
  return { ok: false, code, error: message }
}

/** Convert any thrown value into a failed tool value. */
function thrown(exec, err) {
  if (exec?.signal?.aborted === true) return failure('cancelled', 'the tool call was cancelled')
  const code = err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'internal'
  const message = err instanceof Error ? err.message : String(err)
  return failure(code, message)
}

/** Wrap a tool body: session resolution, cancellation, and error normalization. */
function body(service, fn) {
  return async (args, exec) => {
    if (exec?.signal?.aborted === true) return failure('cancelled', 'the tool call was cancelled')
    const sessionId = sessionIdOf(exec)
    if (sessionId === null) {
      return failure('no-session', 'browser tools need a live agent Session; this call has no Session identity')
    }
    try {
      return await fn(sessionId, args ?? {}, exec)
    } catch (err) {
      return thrown(exec, err)
    }
  }
}

/** Total, model-facing rendering of a tool value. */
function renderValue(value) {
  try {
    if (value === null || value === undefined) return [{ type: 'text', text: '(no result)' }]
    if (typeof value !== 'object') return [{ type: 'text', text: String(value) }]
    if (value.ok === false) {
      return [{ type: 'text', text: `browser action failed (${String(value.code ?? 'error')}): ${String(value.error ?? value.message ?? 'unknown error')}` }]
    }
    const text = JSON.stringify(value, null, 2)
    return [{ type: 'text', text: text.length > RENDER_MAX_CHARS ? `${text.slice(0, RENDER_MAX_CHARS)}\n… (truncated)` : text }]
  } catch {
    return [{ type: 'text', text: '(unrenderable result)' }]
  }
}

/** PNG intrinsic size from the IHDR chunk. */
function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Registry-facing renderer: `render(args, value)` projects the canonical value. */
const renderTool = (_args, value) => renderValue(value)

/** Total tab row for the requested tab (or the active one). */
function tabRowOf(state, tabId) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : []
  if (typeof tabId === 'string' && tabId.length > 0) return tabs.find((tab) => tab.tabId === tabId) ?? null
  return tabs.find((tab) => tab.active === true) ?? tabs[0] ?? null
}

/** Build the tool definitions (exported shape kept private to this module). */
function buildToolDefinitions(service, settings) {
  // Settings are resolved by the panel and shared through the service; the
  // parameter is kept so future per-limit tool knobs have one place to land.
  void settings
  return [
    {
      name: 'browser_navigate',
      description:
        'Navigate the browser panel\'s own Chrome (a real Chrome the panel controls over CDP, shown in the '
        + 'right-sidebar Browser tab) to an http(s) URL. The panel Chrome is not the user\'s normal browser: it '
        + 'starts empty and persists per conversation. Opens a tab when none is open. Only http/https URLs are '
        + 'allowed; bare hosts such as "example.com" are treated as https.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Absolute http(s) URL to load, e.g. "https://example.com/pricing". A bare host becomes https.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderTool },
      execute: body(service, async (sessionId, args) => {
        const tab = await service.perform(sessionId, undefined, 'navigate', { url: args.url })
        return { ok: true, ...tab }
      }),
    },
    {
      name: 'browser_click',
      description:
        'Click in the browser panel\'s Chrome page. Coordinates are CSS pixels relative to the page viewport '
        + '(the same coordinates as a pick\'s "rect" and the frame "viewport"; NOT screen pixels and NOT image '
        + 'pixels if the canvas is scaled). Prefer "selector" when you know the element: the tool scrolls it into '
        + 'view and clicks its centre. Otherwise pass x/y from the page coordinates you are targeting.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Horizontal CSS pixel position in the page viewport.' },
          y: { type: 'number', description: 'Vertical CSS pixel position in the page viewport.' },
          selector: {
            type: 'string',
            description: 'Optional CSS selector. When present its centre is used instead of x/y.',
          },
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: 'Mouse button (default left).',
          },
          clickCount: {
            type: 'integer',
            enum: [1, 2],
            description: '1 for a single click (default), 2 for a double click.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderTool },
      execute: body(service, async (sessionId, args) => {
        let x = Number(args.x)
        let y = Number(args.y)
        let selector = null
        if (typeof args.selector === 'string' && args.selector.trim().length > 0) {
          selector = args.selector.trim()
          const point = await service.resolvePoint(sessionId, undefined, selector)
          x = point.x
          y = point.y
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return failure('bad-request', 'pass finite x/y CSS pixels or a selector')
        }
        const button = typeof args.button === 'string' ? args.button : 'left'
        const clickCount = Number(args.clickCount) === 2 ? 2 : 1
        await service.perform(sessionId, undefined, 'mouse', { type: 'down', x, y, button, clickCount })
        await service.perform(sessionId, undefined, 'mouse', { type: 'up', x, y, button, clickCount })
        return { ok: true, x: Math.round(x), y: Math.round(y), button, clickCount, ...(selector !== null ? { selector } : {}) }
      }),
    },
    {
      name: 'browser_type',
      description:
        'Type text into the browser panel\'s Chrome page. With "selector" the element is focused first (and '
        + 'optionally cleared), otherwise text goes to whatever currently has focus. set "submit": true to press '
        + 'Enter afterwards (useful for search boxes and single-field forms).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to insert (CDP Input.insertText).' },
          selector: {
            type: 'string',
            description: 'Optional CSS selector of the input/textarea/contenteditable to focus before typing.',
          },
          clear: {
            type: 'boolean',
            description: 'When true, select the focused field\'s existing contents so the typed text replaces them.',
          },
          submit: {
            type: 'boolean',
            description: 'When true, press Enter after typing.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderTool },
      execute: body(service, async (sessionId, args) => {
        if (typeof args.text !== 'string') return failure('bad-request', 'text must be a string')
        const selector = typeof args.selector === 'string' && args.selector.trim().length > 0 ? args.selector.trim() : null
        let focused = null
        if (selector !== null) focused = await service.focusSelector(sessionId, undefined, selector, args.clear === true)
        await service.perform(sessionId, undefined, 'text', { text: args.text })
        if (args.submit === true) {
          await service.perform(sessionId, undefined, 'key', {
            type: 'down', key: 'Enter', code: 'Enter', keyCode: 13, text: '\r',
          })
          await service.perform(sessionId, undefined, 'key', { type: 'up', key: 'Enter', code: 'Enter', keyCode: 13 })
        }
        const state = service.state(sessionId)
        return {
          ok: true,
          typed: args.text.length,
          submitted: args.submit === true,
          tabId: tabRowOf(state)?.tabId ?? null,
          ...(selector !== null ? { selector } : {}),
          ...(focused !== null ? { element: focused.tag } : {}),
        }
      }),
    },
    {
      name: 'browser_scroll',
      description:
        'Scroll the browser panel\'s Chrome page with a mouse wheel event. Coordinates are CSS pixels in the page '
        + 'viewport; they default to the viewport centre. Positive deltaY scrolls down, negative up. Returns the '
        + 'resulting scroll position so the caller can confirm the page moved.',
      parameters: {
        type: 'object',
        properties: {
          deltaY: { type: 'number', description: 'Vertical wheel delta in CSS pixels; positive scrolls down (default 400).' },
          deltaX: { type: 'number', description: 'Horizontal wheel delta in CSS pixels (default 0).' },
          x: { type: 'number', description: 'Optional CSS x anchor for the wheel event (default viewport centre).' },
          y: { type: 'number', description: 'Optional CSS y anchor for the wheel event (default viewport centre).' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderTool },
      execute: body(service, async (sessionId, args) => {
        const state = service.state(sessionId)
        const row = tabRowOf(state)
        const viewport = row?.viewport ?? { width: 1280, height: 800 }
        const x = Number.isFinite(Number(args.x)) ? Number(args.x) : Math.round(viewport.width / 2)
        const y = Number.isFinite(Number(args.y)) ? Number(args.y) : Math.round(viewport.height / 2)
        const deltaY = Number.isFinite(Number(args.deltaY)) ? Number(args.deltaY) : 400
        const deltaX = Number.isFinite(Number(args.deltaX)) ? Number(args.deltaX) : 0
        const before = await service.scrollInfo(sessionId, undefined)
        await service.perform(sessionId, undefined, 'wheel', { x, y, deltaX, deltaY })
        // Wheel scrolling is applied asynchronously by the compositor; give it a
        // bounded moment and report the settled position.
        let info = before
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 80))
          info = await service.scrollInfo(sessionId, undefined)
          if (info.scrollY !== before.scrollY || info.scrollX !== before.scrollX) break
        }
        return { ok: true, deltaY, deltaX, scrolledY: info.scrollY - before.scrollY, ...info }
      }),
    },
    {
      name: 'browser_screenshot',
      description:
        'Capture the browser panel\'s Chrome page as a JPEG or PNG file and return its path. The screenshot is '
        + 'saved under the system temp directory so it can be opened with the file-reading tools; the live page '
        + 'is also visible in the panel. Coordinates reported elsewhere (picks, clicks) are CSS pixels in the '
        + 'captured viewport.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['jpeg', 'png'],
            description: 'Image format; JPEG (default) is smaller, PNG is lossless.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderTool },
      execute: body(service, async (sessionId, args) => {
        const format = args.format === 'png' ? 'png' : 'jpeg'
        const shot = await service.perform(sessionId, undefined, 'screenshot', { format })
        const base64 = String(shot.dataUrl).split(',', 2)[1] ?? ''
        const buffer = Buffer.from(base64, 'base64')
        await mkdir(SCREENSHOT_DIR, { recursive: true })
        const extension = format === 'png' ? 'png' : 'jpeg'
        const path = join(SCREENSHOT_DIR, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`)
        await writeFile(path, buffer)
        const size = format === 'png' ? pngSize(buffer) : jpegSize(buffer)
        const state = service.state(sessionId)
        const row = tabRowOf(state)
        return {
          ok: true,
          path,
          format,
          bytes: buffer.length,
          width: size?.width ?? row?.viewport?.width ?? null,
          height: size?.height ?? row?.viewport?.height ?? null,
          url: row?.url ?? null,
          title: row?.title ?? null,
        }
      }),
    },
    {
      name: 'browser_tabs',
      description:
        'List, open, close, or activate tabs in the browser panel\'s Chrome. The panel owns up to a configured '
        + 'number of tabs; each tab is a separate CDP page target. "list" never launches Chrome.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'new', 'close', 'activate'],
            description: 'Tab operation; defaults to "list".',
          },
          tabId: {
            type: 'string',
            description: 'Existing tab id (for close/activate), as reported by "list" or by a navigate result.',
          },
          url: {
            type: 'string',
            description: 'Optional http(s) URL for "new"; defaults to about:blank.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderTool },
      execute: body(service, async (sessionId, args) => {
        const action = typeof args.action === 'string' ? args.action : 'list'
        if (action === 'list') {
          const state = service.state(sessionId)
          return { ok: true, chrome: state.chrome, tabs: state.tabs }
        }
        if (action === 'new') {
          const opened = await service.perform(sessionId, undefined, 'openTab', {
            url: typeof args.url === 'string' && args.url.length > 0 ? args.url : 'about:blank',
          })
          const state = service.state(sessionId)
          return { ok: true, tab: opened.tab, tabs: state.tabs }
        }
        if (action === 'close') {
          const tabId = typeof args.tabId === 'string' && args.tabId.length > 0 ? args.tabId : undefined
          await service.perform(sessionId, tabId, 'closeTab', {})
          const state = service.state(sessionId)
          return { ok: true, closed: true, tabs: state.tabs }
        }
        if (action === 'activate') {
          if (typeof args.tabId !== 'string' || args.tabId.length === 0) {
            return failure('bad-request', 'tabId is required for action "activate"')
          }
          const activated = await service.perform(sessionId, args.tabId, 'activate', {})
          const state = service.state(sessionId)
          return { ok: true, tab: activated.tab, tabs: state.tabs }
        }
        return failure('bad-request', `unknown tab action: ${action}`)
      }),
    },
    {
      name: 'browser_pick_last',
      description:
        'Return the most recent element the user picked from the browser panel, as a PickDescriptor: selector, '
        + 'tag/id/classes, role, accessible name, text, viewport-relative CSS-pixel rect, attributes, ancestors '
        + 'and outerHTML. Use it to locate the element the user is talking about; combine the rect with '
        + 'browser_click (CSS pixels) or the selector with browser_click/browser_type.',
      parameters: {
        type: 'object',
        properties: {
          index: {
            type: 'integer',
            description: 'Optional 0-based index from the end: 0 is the newest pick (default), 1 the one before it.',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderTool },
      execute: body(service, async (sessionId, args) => {
        const state = service.state(sessionId)
        const picks = Array.isArray(state.picks) ? state.picks : []
        const back = Number.isSafeInteger(Number(args.index)) && Number(args.index) > 0
          ? Math.round(Number(args.index))
          : 0
        const pick = picks.length > back ? picks[picks.length - 1 - back] : null
        if (pick === null) return failure('pick-failed', 'the user has not picked any element in the browser panel yet')
        return { ok: true, pick, totalPicks: picks.length }
      }),
    },
  ]
}

/** Exported for the self-test: the tool names this module registers. */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_screenshot',
  'browser_tabs',
  'browser_pick_last',
]