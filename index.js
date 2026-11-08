/**
 * Host half of the browser panel bundle.
 *
 * Owns the CDP Chrome sessions, the panel HTTP/SSE transport, agent tools, and
 * the element-pick context injection. The Client half (`./client.js`) renders
 * the right-Sidebar tab and speaks the same transport.
 *
 * Reload strategy: the bundle is installed as a *linked* directory and the Host
 * process caches ES modules by URL, so re-activating the plugin would otherwise
 * re-run stale code. Each activation therefore copies `host/` into a fresh
 * temporary generation directory and imports it from there, which gives every
 * `plugin_manager set_plugin` toggle a clean module generation without
 * restarting `dsh web`.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Loader entry name. */
export const name = 'browser-panel'

/** Host services the panel needs before it activates. */
export const inject = ['webServer', 'tools', 'agents', 'connection']

/**
 * Mount the panel Host runtime for this profile.
 * @param ctx - Host Context with web server, tools, and agent registry.
 * @param config - row config: Chrome executable/flags, stream limits.
 */
export function apply(ctx, config) {
  const staged = stageHostModules(ctx)

  /** @type {{ dispose(): Promise<void> | void } | undefined} */
  let host
  let disposed = false
  const ready = import(staged.href).then((module) => {
    if (disposed) return
    try {
      host = module.createBrowserPanelHost(ctx, config ?? {})
    } catch (error) {
      ctx.logger.error('browser-panel: Host runtime failed to start', error)
    }
  }).catch((error) => {
    ctx.logger.error('browser-panel: Host runtime failed to load', error)
  })

  ctx.effect(() => () => {
    disposed = true
    void ready.then(async () => {
      try {
        await host?.dispose()
      } catch (error) {
        ctx.logger.warn('browser-panel: Host runtime dispose failed', error)
      }
    })
    if (staged.generation !== undefined) rmSync(staged.generation, { recursive: true, force: true })
  }, 'browser-panel.lifetime')
}

/**
 * Copy the Host implementation next to a fresh module URL so this activation
 * loads current code instead of the previously cached ES module.
 * @param ctx - Host Context, used only for warnings.
 * @returns The module URL and the temporary generation directory to remove.
 */
function stageHostModules(ctx) {
  const source = fileURLToPath(new URL('./host', import.meta.url))
  try {
    const generation = mkdtempSync(join(tmpdir(), 'dsh-browser-sidepanel-'))
    cpSync(source, join(generation, 'host'), { recursive: true })
    return { href: pathToFileURL(join(generation, 'host', 'panel.js')).href, generation }
  } catch (error) {
    ctx.logger.warn('browser-panel: Host staging failed, loading modules in place', error)
    return { href: new URL('./host/panel.js', import.meta.url).href, generation: undefined }
  }
}