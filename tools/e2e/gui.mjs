/**
 * gui.mjs — drive the live DSH Web GUI from a headless Chrome over raw CDP.
 *
 * The GUI is a React SPA; the harness must wait for DOM milestones, not network
 * idle. Controls are clicked with real CDP pointer input (some sidebar controls
 * only respond to pointer events; `element.click()` is not enough).
 *
 * All helpers are bound to one flattened target session created against the
 * browser WebSocket by `launchGui()`.
 */
import { writeFile } from 'node:fs/promises'
import { CDP, launchChrome, sleep } from './cdp.mjs'

export { sleep }

/** Raised when a wait or assertion helper times out; carries DOM evidence. */
export class GuiTimeout extends Error {
  constructor(message, evidence) {
    super(message)
    this.name = 'GuiTimeout'
    this.evidence = evidence
  }
}

/**
 * Attach one page target and return its driver.
 * @param {CDP} cdp - browser-scoped client.
 */
export async function createPageDriver(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params = {}) => cdp.send(method, params, sessionId)

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
    })
    if (exceptionDetails) {
      const text = exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluate failed'
      throw new Error(`page evaluate failed: ${String(text).slice(0, 800)}`)
    }
    return result?.value
  }

  /** Poll `expression` until it returns a truthy value. */
  const waitFor = async (expression, { timeout = 15_000, interval = 100, label = expression } = {}) => {
    const deadline = Date.now() + timeout
    let last
    for (;;) {
      try { last = await evaluate(expression) } catch (error) { last = { __error: String(error) } }
      if (last) return last
      if (Date.now() >= deadline) {
        throw new GuiTimeout(`waitFor(${label}) timed out after ${timeout}ms`, last)
      }
      await sleep(interval)
    }
  }

  const rectOf = async (selector) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
  })()`)

  const rectOfLabel = async (label) => evaluate(`(() => {
    const el = [...document.querySelectorAll('button,[role="button"],[role="tab"]')]
      .find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)})
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
  })()`)

  const mouseClick = async (x, y, { button = 'left' } = {}) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
  }

  /** Real pointer click on an element; returns the point used (or throws). */
  const clickAt = async (rect, what) => {
    if (rect === null) throw new Error(`cannot click ${what}: no visible element`)
    await mouseClick(rect.cx, rect.cy)
    return { x: rect.cx, y: rect.cy }
  }

  const clickSelector = async (selector) => clickAt(await rectOf(selector), selector)
  const clickLabel = async (label) => clickAt(await rectOfLabel(label), `aria-label=${label}`)

  const hoverSelector = async (selector) => {
    const rect = await rectOf(selector)
    if (rect === null) throw new Error(`cannot hover ${selector}: no visible element`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.cx, y: rect.cy })
    return rect
  }

  const screenshot = async (path) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    const buffer = Buffer.from(data, 'base64')
    await writeFile(path, buffer)
    return { path, bytes: buffer.length }
  }

  /** Run a same-origin fetch from inside the authenticated GUI page. */
  const pageFetch = async (path, init) => {
    const result = await evaluate(`(async () => {
      const options = ${JSON.stringify(init ?? {})}
      try {
        const response = await fetch(${JSON.stringify(path)}, options)
        const text = await response.text()
        let body
        try { body = JSON.parse(text) } catch { body = text.slice(0, 500) }
        return { status: response.status, body }
      } catch (error) { return { status: 0, error: String(error) } }
    })()`)
    return result
  }

  const navigate = async (url) => {
    await send('Page.navigate', { url })
  }

  return {
    targetId, sessionId,
    send, evaluate, waitFor, rectOf, rectOfLabel, clickAt, clickSelector, clickLabel,
    hoverSelector, mouseClick, screenshot, pageFetch, navigate,
  }
}

/**
 * Launch headless Chrome with a fresh profile, authenticate, and open the GUI.
 * @param {string} origin - GUI origin (`http://127.0.0.1:3080`).
 * @param {{name: string, value: string}} cookie - minted browser-session cookie.
 * @param {{width?: number, height?: number, headless?: boolean}} [opts]
 */
export async function launchGui(origin, cookie, opts = {}) {
  const chrome = await launchChrome({
    headless: opts.headless ?? true,
    width: opts.width ?? 1440,
    height: opts.height ?? 960,
  })
  const cdp = await CDP.connect(chrome.browserWsUrl)
  const page = await createPageDriver(cdp)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await page.send('Network.setCookie', {
    name: cookie.name, value: cookie.value, url: origin, path: '/', httpOnly: true, sameSite: 'Strict',
  })
  await page.navigate(`${origin}/`)
  return { chrome, cdp, page }
}