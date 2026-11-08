/**
 * Lead smoke probe: open the live GUI in a headless Chrome, authenticate with the
 * minted cookie, and report whether the browser panel's guide entry is present.
 *
 * Usage: node tools/lead-smoke.mjs [--keep] [--out tools/out]
 * Outputs: JSON summary on stdout, screenshot at <out>/smoke.png
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { CDP, launchChrome, sleep } from '../probe/cdp.mjs'

const ORIGIN = process.env.DSH_GUI_ORIGIN ?? 'http://127.0.0.1:3080'
const OUT = process.env.SMOKE_OUT ?? 'tools/out'

const cookie = JSON.parse(execFileSync(process.execPath, ['tools/auth-cookie.mjs', '--json'], { encoding: 'utf8' }))

const chrome = await launchChrome({ headless: true, width: 1400, height: 950 })
const cdp = await CDP.connect(chrome.browserWsUrl)
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
const send = (method, params = {}) => cdp.send(method, params, sessionId)

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCookie', {
  name: cookie.name, value: cookie.value, url: ORIGIN, path: '/', httpOnly: true, sameSite: 'Strict',
})
await send('Page.navigate', { url: `${ORIGIN}/` })
await sleep(2500)

const evaluate = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result?.subtype === 'error') throw new Error(result.description ?? 'evaluate failed')
  return result?.value
}

const report = { origin: ORIGIN, steps: [] }
const record = (name, ok, detail) => {
  report.steps.push({ name, ok, detail })
}

// Wait for the app shell.
let ready = false
for (let i = 0; i < 40; i += 1) {
  ready = await evaluate(`Boolean(document.querySelector('#root')?.childElementCount)`)
  if (ready) break
  await sleep(250)
}
record('app-shell', ready === true, { waitedMs: 250 * 40 })
record('page-title', true, await evaluate('document.title'))

// The right sidebar starts collapsed: open it with the header toggle if needed.
const sidebarState = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /sidebar|侧边栏/i.test(b.getAttribute('aria-label') || b.title || ''));
  return { found: Boolean(btn), label: btn ? (btn.getAttribute('aria-label') || btn.title) : null };
})()`)
record('sidebar-toggle-found', sidebarState.found, sidebarState)

if (sidebarState.found) {
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /sidebar|侧边栏/i.test(b.getAttribute('aria-label') || b.title || ''));
    btn?.click();
    return true;
  })()`)
  await sleep(800)
}

const guide = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map(el => ({
    kind: el.getAttribute('data-sidebar-right-guide-entry'),
    text: (el.textContent || '').trim().slice(0, 120),
  }));
  const labels = [...document.querySelectorAll('button, [role="button"]')].map(el => (el.textContent || '').trim()).filter(Boolean);
  return { cards, browserMentioned: labels.some(t => t === 'Browser' || t.startsWith('Browser')) };
})()`)
record('guide-cards', guide.cards.length > 0, guide)
record('browser-guide-entry', guide.browserMentioned === true, guide.cards)

// Directly exercise the panel HTTP contract from the authenticated page context.
const state = await evaluate(`fetch('/browser-panel/state?sessionId=smoke', { headers: { accept: 'application/json' } })
  .then(r => r.json()).then(v => ({ status: 200, body: v })).catch(e => ({ status: 0, error: String(e) }))`)
record('panel-state-route', state?.status === 200, state?.body ?? state)

await mkdir(OUT, { recursive: true })
const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(join(OUT, 'smoke.png'), Buffer.from(shot.data, 'base64'))
report.screenshot = join(OUT, 'smoke.png')

await writeFile(join(OUT, 'smoke.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

cdp.close?.()
await chrome.kill()
process.exit(report.steps.every(step => step.ok) ? 0 : 1)