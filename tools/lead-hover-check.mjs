/**
 * Lead check for the hover feedback and composer-mention features, in the live GUI.
 *
 * Flow: fixture page -> panel address form -> hover the canvas (pointer dot,
 * hover outline, mirrored cursor) -> pick the fixture button -> click the
 * chip's @ button -> assert the mention lands in the composer draft.
 *
 * Usage: node tools/lead-hover-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixtureServer } from './e2e/fixture-server.mjs'
import { launchGui, sleep } from './e2e/gui.mjs'

const ORIGIN = process.env.DSH_GUI_ORIGIN ?? 'http://127.0.0.1:3080'
/** Bundle root (this file lives in <root>/tools). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Workspace row to click in the GUI sidebar. Defaults to the directory that
 * contains the bundle (the usual layout: a workspace hosting this clone);
 * set DSH_TEST_PROJECT when the clone *is* the workspace root.
 */
const project = process.env.DSH_TEST_PROJECT ?? basename(dirname(ROOT))
const OUT = 'tools/out'
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const fixture = await createFixtureServer()
const cookie = JSON.parse(execFileSync(process.execPath, ['tools/auth-cookie.mjs', '--json'], { encoding: 'utf8' }))
const { chrome, cdp, page } = await launchGui(ORIGIN, cookie, { width: 1440, height: 960 })
const problems = []
cdp.on('Runtime.exceptionThrown', (params, meta) => {
  if (meta.sessionId !== page.sessionId) return
  problems.push(String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '').slice(0, 300))
})

try {
  await page.waitFor(`document.querySelector('#root')?.childElementCount || 0`, { timeout: 25_000, label: 'root' })
  await page.waitFor(`document.querySelector('[data-composer-input]') !== null`, { timeout: 25_000, label: 'composer' })

  const row = await page.evaluate(`(() => {
    const r = [...document.querySelectorAll('[data-row-key^="workspace:"]')].find(x => (x.textContent || '').includes(${JSON.stringify(project)}))
    if (!r) return null
    const b = r.getBoundingClientRect()
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
  })()`)
  if (row) {
    await page.mouseClick(row.x, row.y)
    await sleep(400)
    const action = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(`New session in ${project}`)} && x.getBoundingClientRect().width > 0)
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (action) await page.mouseClick(action.x, action.y)
    await sleep(2500)
  }

  if ((await page.evaluate(`document.querySelectorAll('[data-sidebar-right-open]').length`)) === 0) {
    if ((await page.rectOf('[data-sidebar-right-expand]')) !== null) await page.clickSelector('[data-sidebar-right-expand]')
    await sleep(800)
  }
  await page.waitFor(`document.querySelector('[data-sidebar-right-guide-entry="browser"]') !== null`, { timeout: 10_000, label: 'browser guide card' })
  const card = await page.rectOf('[data-sidebar-right-guide-entry="browser"]')
  await page.mouseClick(card.cx, card.cy)
  check('panel-opened', await page.waitFor(`document.querySelector('[data-browser-panel]') !== null`, { timeout: 10_000, label: 'panel root' }).then(() => true).catch(() => false))

  // Point the panel at the fixture through its own address form.
  const addressSelector = '[data-dockkit-pane] input[data-browser-panel-address]'
  const address = await page.rectOf(addressSelector)
  if (address !== null) {
    await page.mouseClick(address.cx, address.cy)
    await page.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(addressSelector)})
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(fixture.url)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      input.form?.requestSubmit()
      return true
    })()`)
  }
  const onFixture = await page.waitFor(`(() => {
    const pane = document.querySelector('[data-dockkit-pane]')
    return pane !== null && (pane.innerText || '').includes(${JSON.stringify(`:${fixture.port}`)})
  })()`, { timeout: 12_000, label: 'fixture page in panel' }).then(() => true).catch(() => false)
  check('panel-navigates-to-fixture', onFixture, fixture.url)

  const layout = await fixture.waitFor((entry) => entry.type === 'ready' || entry.type === 'layout', 8_000).catch(() => null)
  const canvas = await page.rectOf('[data-dockkit-pane] canvas')
  check('canvas-visible', canvas !== null, canvas)
  check('fixture-layout-available', Boolean(layout && layout.saveRect && layout.viewport),
    layout ? { type: layout.type, saveRect: layout.saveRect, viewport: layout.viewport } : { events: fixture.events().map((entry) => entry.type).slice(0, 8) })
  if (onFixture && canvas !== null && layout?.saveRect && layout?.viewport) {
    const viewport = layout.viewport
    const point = {
      x: canvas.x + (layout.saveRect.x + layout.saveRect.w / 2) * canvas.w / viewport.w,
      y: canvas.y + (layout.saveRect.y + layout.saveRect.h / 2) * canvas.h / viewport.h,
    }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(point.x), y: Math.round(point.y) })
    await sleep(160)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(point.x + 2), y: Math.round(point.y + 3) })
    const feedback = await page.waitFor(`(() => {
      const pane = document.querySelector('[data-dockkit-pane]')
      const canvas = pane?.querySelector('canvas')
      const dot = pane?.querySelector('[data-browser-panel-cursor]')
      const rect = pane?.querySelector('[data-browser-panel-hover]')
      if (!canvas || !dot || !rect) return null
      const r = rect.getBoundingClientRect()
      const d = dot.getBoundingClientRect()
      return { cursor: getComputedStyle(canvas).cursor, rect: { w: Math.round(r.width), h: Math.round(r.height) }, dot: { w: Math.round(d.width), h: Math.round(d.height) } }
    })()`, { timeout: 6_000, label: 'hover feedback' }).catch(() => null)
    check('hover-outline-and-pointer', feedback !== null && feedback.rect.w > 4 && feedback.rect.h > 4 && feedback.dot.w >= 2, feedback)
    check('cursor-mirrors-page', feedback?.cursor === 'pointer', feedback?.cursor)
    await page.screenshot(join(OUT, 'hover-feedback.png'))

    // Pick the button through the panel UI, then insert the mention.
    const pickToggle = await page.rectOf('[data-browser-panel-pick-toggle]')
    if (pickToggle !== null) await page.mouseClick(pickToggle.cx, pickToggle.cy)
    await sleep(200)
    await page.mouseClick(Math.round(point.x), Math.round(point.y))
    const chip = await page.waitFor(`document.querySelector('[data-browser-panel-mention]') !== null`, { timeout: 8_000, label: 'pick chip' }).then(() => true).catch(() => false)
    check('pick-chip-with-mention-button', chip)
    if (chip) {
      const mention = await page.rectOf('[data-dockkit-pane] [data-browser-panel-mention]')
      await page.mouseClick(mention.cx, mention.cy)
      const draft = await page.waitFor(`(() => {
        const input = document.querySelector('[data-composer-input]')
        if (!input) return null
        const text = typeof input.value === 'string' && input.value.length > 0 ? input.value : (input.innerText || input.textContent || '')
        return text && text.includes('@browser') ? { text: text.slice(0, 200) } : null
      })()`, { timeout: 6_000, label: 'composer mention' }).catch(() => null)
      check('mention-inserted-into-composer', draft !== null, draft?.text)
      await page.screenshot(join(OUT, 'mention-in-composer.png'))
      // Leave no residue in the shared composer.
      await page.evaluate(`(() => {
        const input = document.querySelector('[data-composer-input]')
        if (!input) return false
        input.focus()
        if (typeof input.value === 'string') {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          if (setter) setter.call(input, ''); else input.value = ''
          input.dispatchEvent(new Event('input', { bubbles: true }))
        } else { document.execCommand('selectAll'); document.execCommand('delete') }
        return true
      })()`)
    }
  }
  check('no-page-exceptions', problems.length === 0, problems.slice(0, 3))
} catch (error) {
  check('run', false, String(error.message).slice(0, 300))
} finally {
  try {
    const sessionId = await page.evaluate(`document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null`)
    if (sessionId) {
      await page.pageFetch('/browser-panel/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, action: 'picksClear', params: {} }),
      }).catch(() => {})
      await page.pageFetch('/browser-panel/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, action: 'shutdown', params: {} }),
      }).catch(() => {})
    }
  } catch { /* best-effort cleanup */ }
  await fixture.close()
  await chrome.kill()
}
const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length === 0 ? '' : ` — failed: ${failed.map((entry) => entry.name).join(', ')}`}`)
process.exit(failed.length === 0 ? 0 : 1)