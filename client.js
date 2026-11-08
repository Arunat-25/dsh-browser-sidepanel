/**
 * Client half of the `dsh-browser-sidepanel` bundle.
 *
 * One plain-JS module, no build step, no JSX, no imports beyond React:
 * - registers the right-Sidebar tab type (`kind: 'browser'`, `multiple`, `keepMounted`),
 *   its guide card (order 25), its body and its live chip title;
 * - the body is a CDP screencast viewer: it boots Chrome through the Host transport
 *   (`POST /browser-panel/action`), opens one `EventSource` per *visible* tab, paints
 *   JPEG frames into a canvas, forwards mouse/wheel/keyboard as CSS-px input, and
 *   implements the element picker (hover rectangle, pick, pending-picks strip).
 *
 * Source of truth for the transport is browser-panel/CONTRACT.md.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-sidepanel',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useRef = React.useRef
    const useEffect = React.useEffect
    const useLayoutEffect = React.useLayoutEffect
    const useCallback = React.useCallback
    const useSyncExternalStore = React.useSyncExternalStore

    /** Tab type identity in the tab system; also the key of the body/title seats. */
    const PLUGIN_ID = 'dsh-browser-panel'
    /** Locale namespace for every visible string. */
    const NS = 'browserPanel'
    /** Tab kind. The shipped iframe browser owns the same kind as `builtin`; ours is the extension. */
    const KIND = 'browser'
    /** Host transport prefix (CONTRACT.md). */
    const BASE = '/browser-panel'

    /** Pick-hover throttle while the crosshair is armed (ms). */
    const HOVER_THROTTLE_MS = 80
    /** Idle pointer-probe cadence (hover feedback outside pick mode). */
    const PROBE_THROTTLE_MS = 110
    /** Pointer-move forwarding throttle (ms). */
    const MOVE_THROTTLE_MS = 50
    /** How long a freshly picked rectangle stays highlighted (ms). */
    const FLASH_MS = 1400
    /** Reconnect backoff bounds (ms). */
    const START_BACKOFF_MS = 1000
    const MAX_BACKOFF_MS = 5000
    /** Give the Host this many failed `/state` probes before showing the retry error. */
    const HOST_MISS_LIMIT = 8
    /** Bound the Chrome-launch wait (each iteration is one `/state` probe). */
    const LAUNCH_ATTEMPT_LIMIT = 40
    /** Failure bound for one shared openTab request (ms). */
    const OPEN_TIMEOUT_MS = 15000

    // ------------------------------------------------------------------
    // Locale dictionaries (every visible string goes through these)
    // ------------------------------------------------------------------
    const EN = {
      'type.label': 'Browser',
      'guide.title': 'Browser',
      'guide.description': 'Browse a page and pick elements into the conversation',
      back: 'Back',
      forward: 'Forward',
      reload: 'Reload',
      'pick.enable': 'Pick an element',
      'pick.disable': 'Stop picking',
      'newTab': 'New browser tab',
      external: 'Open in system browser',
      fit: 'Fit page to panel',
      'address.placeholder': 'Enter a URL',
      'address.go': 'Go to URL',
      'canvas.label': 'Browser page viewport',
      'picks.title': 'Picked elements ({count})',
      'picks.hint': 'Picked elements are attached to your next message.',
      'picks.remove': 'Remove picked element',
      'picks.copy': 'Copy selector',
      'picks.clear': 'Clear all',
      'picks.mention': 'Insert mention into the message input',
      'picks.mentionUnavailable': 'The message input is not available in this panel.',
      'picks.mentionFailed': 'Could not insert the mention; the draft changed. Try again.',
      'pick.hint': 'Click an element on the page',
      'chrome.idle': 'Chrome idle',
      'chrome.launching': 'Starting Chrome...',
      'chrome.ready': 'Connected',
      'chrome.error': 'Chrome error',
      'status.reconnecting': 'Reconnecting...',
      'status.retry': 'Retry',
      'status.waitingFrame': 'Waiting for the first frame...',
      'status.waitingSize': 'Waiting for page size...',
      'status.noPage': 'No page',
      'error.host': 'The browser transport is not available yet.',
      'error.chrome': 'Chrome failed to start.',
      'error.openTab': 'Could not open a browser tab.',
      'error.noTab': 'The browser did not return a tab.',
      'error.action': 'Browser action failed.',
      'error.navigate': 'Navigation failed.',
      'error.pick': 'Could not pick that element.',
      'error.stream': 'The browser stream failed.',
      'error.generic': 'Something went wrong.',
    }
    const ZH = {
      'type.label': '浏览器',
      'guide.title': '浏览器',
      'guide.description': '在会话中浏览网页并选取元素',
      back: '后退',
      forward: '前进',
      reload: '重新加载',
      'pick.enable': '选取元素',
      'pick.disable': '退出选取',
      'newTab': '新建浏览器标签页',
      external: '在系统浏览器中打开',
      fit: '页面适配面板',
      'address.placeholder': '输入网址',
      'address.go': '打开网址',
      'canvas.label': '浏览器页面视图',
      'picks.title': '已选元素({count})',
      'picks.hint': '已选元素会附加到你下一条消息。',
      'picks.remove': '移除已选元素',
      'picks.copy': '复制选择器',
      'picks.clear': '全部清除',
      'picks.mention': '在输入框中插入提及',
      'picks.mentionUnavailable': '当前面板无法访问消息输入框。',
      'picks.mentionFailed': '插入提及失败，草稿已变化，请重试。',
      'pick.hint': '点击页面上的一个元素',
      'chrome.idle': 'Chrome 未启动',
      'chrome.launching': '正在启动 Chrome...',
      'chrome.ready': '已连接',
      'chrome.error': 'Chrome 出错',
      'status.reconnecting': '正在重新连接...',
      'status.retry': '重试',
      'status.waitingFrame': '等待第一帧画面...',
      'status.waitingSize': '等待页面尺寸...',
      'status.noPage': '没有页面',
      'error.host': '浏览器传输通道尚未就绪。',
      'error.chrome': 'Chrome 启动失败。',
      'error.openTab': '无法新建浏览器标签页。',
      'error.noTab': '浏览器没有返回标签页。',
      'error.action': '浏览器操作失败。',
      'error.navigate': '页面跳转失败。',
      'error.pick': '无法选取该元素。',
      'error.stream': '浏览器画面流中断。',
      'error.generic': '出现了问题。',
    }

    // ------------------------------------------------------------------
    // Small pure helpers
    // ------------------------------------------------------------------
    function clamp(value, min, max) {
      if (value < min) return min
      if (value > max) return max
      return value
    }

    /** Add the scheme a user omitted; `about:` and friends are left alone. */
    function normalizeUrl(raw) {
      const value = String(raw === null || raw === undefined ? '' : raw).trim()
      if (value === '') return null
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value
      return 'https://' + value
    }

    /** Only http(s) URLs may be handed to the system browser. */
    function isSafeExternal(url) {
      return typeof url === 'string' && /^https?:\/\//i.test(url)
    }

    /** Abort-aware sleep used by the boot backoff. */
    function sleep(ms, signal) {
      return new Promise(function (resolve) {
        if (signal && signal.aborted) {
          resolve()
          return
        }
        const timer = setTimeout(function () {
          cleanup()
          resolve()
        }, ms)
        function onAbort() {
          cleanup()
          resolve()
        }
        function cleanup() {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
      })
    }

    // ------------------------------------------------------------------
    // HTTP transport (same-origin; the dsh-auth cookie authorizes it)
    // ------------------------------------------------------------------
    function readJsonBody(response) {
      return response.text().then(function (text) {
        if (!text) return null
        try {
          return JSON.parse(text)
        } catch (error) {
          return null
        }
      })
    }

    function actionFailure(payload, status) {
      const error = new Error((payload && (payload.message || payload.code)) || 'HTTP ' + status)
      error.code = payload && payload.code
      error.status = status
      return error
    }

    function isAbortError(error) {
      return !!error && (error.name === 'AbortError' || error.code === 20)
    }

    /** `GET /browser-panel/state?sessionId=` */
    function fetchState(sessionId, signal) {
      return fetch(BASE + '/state?sessionId=' + encodeURIComponent(sessionId), {
        signal: signal,
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then(function (response) {
        return readJsonBody(response).then(function (payload) {
          if (!response.ok || payload === null || payload.ok === false) {
            throw actionFailure(payload, response.status)
          }
          return payload
        })
      })
    }

    /** `POST /browser-panel/action` */
    function postAction(sessionId, tabId, action, params, signal) {
      const body = { sessionId: sessionId, action: action, params: params || {} }
      if (tabId) body.tabId = tabId
      return fetch(BASE + '/action', {
        method: 'POST',
        signal: signal,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      }).then(function (response) {
        return readJsonBody(response).then(function (payload) {
          if (!response.ok || payload === null || payload.ok !== true) {
            throw actionFailure(payload, response.status)
          }
          return payload.result
        })
      })
    }

    // ------------------------------------------------------------------
    // Live page title shared between the body (writer) and the chip (reader)
    //
    // The framework gives body and title seats the same tab occurrence but no
    // shared React state. A tiny module-scope observable bridges that; the
    // title subscribes through useSyncExternalStore.
    // ------------------------------------------------------------------
    const titleStores = new Map()

    function titleEntry(key) {
      let entry = titleStores.get(key)
      if (entry === undefined) {
        entry = { snapshot: undefined, listeners: new Set() }
        titleStores.set(key, entry)
      }
      return entry
    }

    function publishTitle(key, patch) {
      const entry = titleEntry(key)
      const prev = entry.snapshot
      const title = patch.title !== undefined ? patch.title : (prev ? prev.title : undefined)
      const url = patch.url !== undefined ? patch.url : (prev ? prev.url : undefined)
      const chrome = patch.chrome !== undefined ? patch.chrome : (prev ? prev.chrome : undefined)
      if (prev && prev.title === title && prev.url === url && prev.chrome === chrome) return
      entry.snapshot = Object.freeze({ title: title, url: url, chrome: chrome })
      const listeners = Array.from(entry.listeners)
      for (let i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i]()
        } catch (error) {
          /* a broken subscriber must not break the writer */
        }
      }
    }

    function readTitle(key) {
      const entry = titleStores.get(key)
      return entry ? entry.snapshot : undefined
    }

    function subscribeTitle(key, listener) {
      const entry = titleEntry(key)
      entry.listeners.add(listener)
      return function () {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0 && entry.snapshot === undefined && titleStores.get(key) === entry) {
          titleStores.delete(key)
        }
      }
    }

    /** Subscribe one title seat to the live snapshot for a tab occurrence. */
    function useLiveTitle(key) {
      const subscribe = useCallback(function (listener) {
        return subscribeTitle(key, listener)
      }, [key])
      const getSnapshot = useCallback(function () {
        return readTitle(key)
      }, [key])
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    // ------------------------------------------------------------------
    // Icons (inline SVG: no UI-primitives import is allowed here)
    // ------------------------------------------------------------------
    function iconFrame(props, children) {
      const size = props && props.size ? props.size : 16
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': true,
        focusable: 'false',
        className: props && props.className,
      }, children)
    }

    function IconBack() {
      return iconFrame(null, h('path', {
        d: 'M10 3.5 5.5 8 10 12.5', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function IconForward() {
      return iconFrame(null, h('path', {
        d: 'M6 3.5 10.5 8 6 12.5', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function IconReload() {
      return iconFrame(null, [
        h('path', {
          key: 'arc', d: 'M13 8a5 5 0 1 1-1.55-3.6', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'head', d: 'M13 2.6v3.2H9.8', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      ])
    }

    function IconPick() {
      return iconFrame(null, [
        h('circle', { key: 'c', cx: 8, cy: 8, r: 3.7, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          key: 'lines', d: 'M8 1.2v2.6M8 12.2v2.6M1.2 8h2.6M12.2 8h2.6',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
      ])
    }

    function IconPlus() {
      return iconFrame(null, h('path', {
        d: 'M8 3v10M3 8h10', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }))
    }

    function IconExternal() {
      return iconFrame(null, [
        h('path', {
          key: 'box',
          d: 'M6.4 3.2H3.9c-.75 0-1.4.65-1.4 1.4v7.5c0 .75.65 1.4 1.4 1.4h7.5c.75 0 1.4-.65 1.4-1.4v-2.5',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
        h('path', {
          key: 'arrow', d: 'M9.4 2.6h4v4M13.1 2.9 7.3 8.7',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      ])
    }

    function IconFit() {
      return iconFrame(null, h('path', {
        d: 'M2.4 5.6V2.4h3.2M10.4 2.4h3.2v3.2M13.6 10.4v3.2h-3.2M5.6 13.6H2.4v-3.2',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function IconGo() {
      return iconFrame(null, h('path', {
        d: 'M3.2 8h9M8.4 4.2 12.2 8l-3.8 3.8', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    function IconClose() {
      return iconFrame({ size: 12 }, h('path', {
        d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }))
    }

    function IconCopy() {
      return iconFrame({ size: 12 }, [
        h('rect', {
          key: 'sheet', x: 2.6, y: 2.6, width: 7.4, height: 8.8, rx: 1.4,
          stroke: 'currentColor', strokeWidth: 1.3,
        }),
        h('path', {
          key: 'flap', d: 'M6 5.4h5.8c.66 0 1.2.54 1.2 1.2v6.8c0 .66-.54 1.2-1.2 1.2H6.8',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
      ])
    }

    /** Guide-card artwork; literals are allowed for artwork only. */
    function BrowserArtwork(props) {
      const size = props && props.size ? props.size : 36
      return h('svg', {
        width: size, height: size, viewBox: '0 0 36 36', fill: 'none',
        'aria-hidden': true, className: props && props.className,
        xmlns: 'http://www.w3.org/2000/svg',
      }, [
        h('rect', {
          key: 'frame', x: 4.5, y: 6.5, width: 27, height: 23, rx: 4,
          stroke: '#8F9BA8', strokeWidth: 1.8,
        }),
        h('path', { key: 'bar', d: 'M4.5 12h27', stroke: '#8F9BA8', strokeWidth: 1.8 }),
        h('circle', { key: 'd1', cx: 8.4, cy: 9.2, r: 1.05, fill: '#FF7B72' }),
        h('circle', { key: 'd2', cx: 11.8, cy: 9.2, r: 1.05, fill: '#FFCD78' }),
        h('circle', { key: 'd3', cx: 15.2, cy: 9.2, r: 1.05, fill: '#7ED6A5' }),
        h('circle', { key: 'globe', cx: 18, cy: 21, r: 5.3, stroke: '#4C9AFF', strokeWidth: 1.9 }),
        h('path', {
          key: 'meridians',
          d: 'M12.7 21h10.6M18 15.7c2.85 3.35 2.85 7.25 0 10.6M18 15.7c-2.85 3.35-2.85 7.25 0 10.6',
          stroke: '#4C9AFF', strokeWidth: 1.35,
        }),
      ])
    }

    // ------------------------------------------------------------------
    // Stylesheet (component-local <style>; --dsw-alias-* tokens only)
    // ------------------------------------------------------------------
    const STYLE_TEXT = [
      '.dshbp-root{display:flex;flex:1 1 auto;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;',
      'overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:var(--dsw-font-xxs-12)}',
      '.dshbp-toolbar{display:flex;flex:0 0 auto;align-items:center;gap:4px;box-sizing:border-box;height:38px;',
      'padding:5px 6px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshbp-tool{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:28px;height:28px;',
      'padding:0;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:var(--dsw-radius-sm);',
      'cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.dshbp-tool:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshbp-tool:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.dshbp-tool:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.45}',
      '.dshbp-tool[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshbp-tool[aria-pressed="true"]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-accent)}',
      '.dshbp-addressWrap{position:relative;flex:1 1 auto;min-width:0;margin:0}',
      '.dshbp-address{width:100%;height:28px;box-sizing:border-box;padding:0 30px 0 9px;color:var(--dsw-alias-label-primary);',
      'font:var(--dsw-font-xxs-12);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);',
      'border-radius:var(--dsw-radius-sm);outline:none}',
      '.dshbp-address:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dshbp-address::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dshbp-go{position:absolute;top:0;right:0;display:inline-flex;align-items:center;justify-content:center;',
      'width:26px;height:28px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);',
      'cursor:pointer;opacity:0;visibility:hidden;transition:opacity .12s ease}',
      '.dshbp-addressWrap:focus-within .dshbp-go{opacity:1;visibility:visible}',
      '.dshbp-go:hover{color:var(--dsw-alias-label-primary)}',
      '.dshbp-picks{flex:0 0 auto;display:flex;flex-direction:column;gap:5px;padding:6px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}',
      '.dshbp-picksHead{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dshbp-picksTitle{color:var(--dsw-alias-label-secondary)}',
      '.dshbp-picksList{display:flex;flex-wrap:wrap;gap:4px;overflow:auto;max-height:96px}',
      '.dshbp-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;padding:2px 4px 2px 8px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      '.dshbp-chipLabel{min-width:0;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.dshbp-chipText{min-width:0;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshbp-chipBtn{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:18px;height:18px;',
      'padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dshbp-chipBtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshbp-picksHint{margin:0;color:var(--dsw-alias-label-tertiary)}',
      '.dshbp-stageWrap{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;',
      'justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
      '.dshbp-stage{position:relative;flex:0 0 auto;max-width:100%;max-height:100%;overflow:hidden;',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);',
      'box-shadow:0 0 0 .5px var(--dsw-alias-border-l2)}',
      '.dshbp-canvas{display:block;width:100%;height:100%;outline:none;background:transparent;',
      'user-select:none;-webkit-user-select:none;touch-action:none}',
      '.dshbp-canvas:focus-visible{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary)}',
      '.dshbp-overlayRect{position:absolute;box-sizing:border-box;pointer-events:none;border-radius:2px;',
      'border:1.5px solid var(--dsw-alias-brand-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);',
      'transition:left .09s linear,top .09s linear,width .09s linear,height .09s linear,opacity .12s ease}',
      '.dshbp-hoverRect{position:absolute;box-sizing:border-box;pointer-events:none;border-radius:3px;',
      'border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 65%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent);',
      'transition:left .09s linear,top .09s linear,width .09s linear,height .09s linear,opacity .12s ease}',
      '.dshbp-pointer{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;',
      'pointer-events:none;background:var(--dsw-alias-brand-primary);',
      'box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base),0 0 0 3.5px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);',
      'animation:dshbp-pulse .5s ease-out}',
      '@keyframes dshbp-pulse{0%{transform:scale(.55);opacity:.35}100%{transform:scale(1);opacity:1}}',
      '.dshbp-chipGlyph{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dshbp-hoverTag{position:absolute;transform:translateY(-100%);margin-top:-4px;max-width:70%;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;',
      'font:500 10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 4px;border-radius:3px;',
      'color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 88%,transparent);',
      'border:.5px solid var(--dsw-alias-border-l3)}',
      '.dshbp-flashRect{position:absolute;box-sizing:border-box;pointer-events:none;border-radius:2px;',
      'border:2px solid var(--dsw-alias-state-success-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);',
      'animation:dshbp-flash 1.4s ease-out forwards}',
      '@keyframes dshbp-flash{0%{opacity:1}70%{opacity:.9}100%{opacity:0}}',
      '.dshbp-stageOverlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:10px;padding:16px;box-sizing:border-box;text-align:center;',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);pointer-events:none}',
      '.dshbp-spinner{width:22px;height:22px;box-sizing:border-box;border-radius:50%;',
      'border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary);',
      'animation:dshbp-spin .9s linear infinite}',
      '@keyframes dshbp-spin{to{transform:rotate(360deg)}}',
      '.dshbp-stageError{max-width:100%;color:var(--dsw-alias-label-error);word-break:break-word}',
      '.dshbp-pickHint{position:absolute;top:8px;left:50%;transform:translateX(-50%);padding:3px 10px;',
      'border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);',
      'color:var(--dsw-alias-label-primary);white-space:nowrap;pointer-events:none;',
      'box-shadow:0 2px 8px var(--dsw-alias-bg-mask-2)}',
      '.dshbp-statusArea{flex:0 0 auto;display:flex;flex-direction:column;gap:2px;box-sizing:border-box;',
      'min-height:27px;padding:4px 8px;border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}',
      '.dshbp-statusRow{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dshbp-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.dshbp-dot[data-state="ready"]{background:var(--dsw-alias-state-success-primary)}',
      '.dshbp-dot[data-state="starting"]{background:var(--dsw-alias-state-warn-primary)}',
      '.dshbp-dot[data-state="reconnecting"]{background:var(--dsw-alias-state-warn-primary)}',
      '.dshbp-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary)}',
      '.dshbp-statusText{flex:0 0 auto;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshbp-statusSep{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
      '.dshbp-pageText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dshbp-linkBtn{flex:0 0 auto;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);',
      'font:var(--dsw-font-xxs-12);cursor:pointer}',
      '.dshbp-linkBtn:hover{text-decoration:underline}',
      '.dshbp-noticeRow{display:flex;align-items:flex-start;gap:6px;min-width:0}',
      '.dshbp-noticeText{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-error);word-break:break-word}',
    ].join('')

    // ------------------------------------------------------------------
    // Body
    // ------------------------------------------------------------------
    function BrowserBody(props) {
      const t = props.t
      const sessionId = props.sessionId
      const info = props.useTabInfo()
      const tab = info.tab
      const tabId = tab.id
      const titleKey = sessionId + '\u0000' + tabId

      // ---- view state -------------------------------------------------
      const [epoch, setEpoch] = useState(0)
      const [phase, setPhase] = useState('starting') // starting | ready | reconnecting | error
      const [chrome, setChrome] = useState(null)
      const [page, setPage] = useState(null)
      const [viewport, setViewport] = useState(null)
      const [pickMode, setPickMode] = useState(false)
      const [picks, setPicks] = useState([])
      const [hover, setHover] = useState(null)
      const [flash, setFlash] = useState(null)
      const [notice, setNotice] = useState(null)
      const [hasFrame, setHasFrame] = useState(false)
      const [frameSize, setFrameSize] = useState(null)
      const [fit, setFit] = useState(null)
      const [draft, setDraft] = useState('')
      const [addressFocused, setAddressFocused] = useState(false)
      const [pointer, setPointer] = useState(null)
      const [pageCursor, setPageCursor] = useState('default')

      // ---- stable refs ------------------------------------------------
      const tRef = useRef(t)
      tRef.current = t
      const visibleRef = useRef(!!tab.visible)
      const pickModeRef = useRef(false)
      const viewportRef = useRef(null)
      const engineRef = useRef(null)
      const canvasRef = useRef(null)
      const stageWrapRef = useRef(null)
      const initialParams = tab.navigation ? tab.navigation.params : undefined
      const initialUrlRef = useRef(normalizeUrl(initialParams && initialParams.url) || 'about:blank')

      useLayoutEffect(function () {
        visibleRef.current = !!tab.visible
      }, [tab.visible])

      useEffect(function () {
        pickModeRef.current = pickMode
      }, [pickMode])

      useEffect(function () {
        viewportRef.current = viewport
      }, [viewport])

      // Publish the live title to the chip seat as early as the first status.
      useEffect(function () {
        if (page) publishTitle(titleKey, { title: page.title, url: page.url })
      }, [titleKey, page])

      // Keep the address draft in sync with the page unless the user is editing it.
      const pageUrl = page && page.url ? page.url : ''
      useEffect(function () {
        if (!addressFocused && pageUrl) setDraft(pageUrl)
      }, [pageUrl, addressFocused])

      // ---- fit: keep the stage at the frame's aspect ratio -------------
      const frameW = frameSize ? frameSize.w : 0
      const frameH = frameSize ? frameSize.h : 0
      const viewportW = viewport ? viewport.width : 0
      const viewportH = viewport ? viewport.height : 0
      useEffect(function () {
        const wrapper = stageWrapRef.current
        if (!wrapper) return undefined
        let raf = 0
        function measure() {
          raf = 0
          const rect = wrapper.getBoundingClientRect()
          if (!rect || !rect.width || !rect.height) return
          let aspect = 16 / 10
          if (frameW > 0 && frameH > 0) aspect = frameW / frameH
          else if (viewportW > 0 && viewportH > 0) aspect = viewportW / viewportH
          let width = rect.width
          let height = width / aspect
          if (height > rect.height) {
            height = rect.height
            width = height * aspect
          }
          const next = { w: Math.max(1, Math.round(width)), h: Math.max(1, Math.round(height)) }
          setFit(function (prev) {
            return prev && prev.w === next.w && prev.h === next.h ? prev : next
          })
        }
        function schedule() {
          if (!raf) raf = requestAnimationFrame(measure)
        }
        schedule()
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule)
          observer.observe(wrapper)
        }
        window.addEventListener('resize', schedule)
        return function () {
          if (raf) cancelAnimationFrame(raf)
          if (observer) observer.disconnect()
          window.removeEventListener('resize', schedule)
        }
      }, [frameW, frameH, viewportW, viewportH])

      // ---- one engine per mount: transport, input forwarding, picker --
      useEffect(function () {
        if (!sessionId) return undefined

        const session = sessionId
        const storeKey = titleKey
        const initialUrl = initialUrlRef.current
        const controller = new AbortController()
        const rt = {
          alive: true,
          chromeTabId: null,
          stream: null,
          reconnectTimer: 0,
          backoff: START_BACKOFF_MS,
          paintRaf: 0,
          decoding: false,
          pendingFrame: null,
          lastSeq: -1,
          firstFrame: false,
          flashTimer: 0,
          hoverTimer: 0,
          hoverBusy: false,
          hoverPoint: null,
          moveTimer: 0,
          movePoint: null,
          pickBusy: false,
        }

        function isAlive() {
          return rt.alive && !controller.signal.aborted
        }

        function showError(error, fallbackKey) {
          if (!isAlive()) return
          let message = error && error.message ? error.message : ''
          if (!message) message = tRef.current(fallbackKey || 'error.generic')
          setNotice(message)
        }

        function clearNotice() {
          if (isAlive()) setNotice(null)
        }

        // ---------- state application ----------
        function chromeStateOf(doc) {
          const candidate = doc && doc.chrome
          if (candidate && typeof candidate === 'object' && typeof candidate.status === 'string') return candidate
          return null
        }

        function applyTabRow(row) {
          if (!isAlive() || !row || typeof row !== 'object') return
          setPage(row)
          if (row.viewport && row.viewport.width > 0 && row.viewport.height > 0) {
            setViewport({ width: row.viewport.width, height: row.viewport.height })
          }
          publishTitle(storeKey, { title: row.title, url: row.url })
        }

        function applyStateDoc(doc) {
          if (!isAlive() || !doc) return
          const state = chromeStateOf(doc)
          if (state) {
            setChrome(state)
            publishTitle(storeKey, { chrome: state.status })
          }
          if (typeof doc.pickMode === 'boolean') {
            setPickMode(doc.pickMode)
            pickModeRef.current = doc.pickMode
          }
          if (Array.isArray(doc.picks)) setPicks(doc.picks)
          const tabs = Array.isArray(doc.tabs) ? doc.tabs : []
          if (rt.chromeTabId) {
            for (let i = 0; i < tabs.length; i += 1) {
              const row = tabs[i]
              if (row && row.tabId === rt.chromeTabId) {
                applyTabRow(row)
                break
              }
            }
          }
        }

        function applyStatusEvent(payload) {
          if (!isAlive() || !payload) return
          const state = chromeStateOf(payload)
          if (state) {
            setChrome(state)
            publishTitle(storeKey, { chrome: state.status })
            if (state.status === 'ready') {
              setPhase(function (current) {
                return current === 'error' ? 'ready' : current
              })
            } else if (state.status === 'error') {
              setPhase('error')
              if (state.message) setNotice(state.message)
            }
          }
          if (typeof payload.pickMode === 'boolean') {
            setPickMode(payload.pickMode)
            pickModeRef.current = payload.pickMode
          }
          const row = payload.tab
          if (row && typeof row === 'object' && row.tabId) {
            // The Host may fall back to another target when the requested tab is
            // gone (payload.tabFallback/requestedTabId). Adopt whatever it shows
            // instead of keeping a stale id that would make the next action
            // create yet another Chrome tab.
            if (!rt.chromeTabId || row.tabId !== rt.chromeTabId) {
              rt.chromeTabId = row.tabId
              tabMap.set(storeKey, row.tabId)
            }
            applyTabRow(row)
          }
        }

        // ---------- frame painting (one paint per animation frame) ----------
        function closeBitmap(bitmap) {
          if (bitmap && typeof bitmap.close === 'function') {
            try {
              bitmap.close()
            } catch (error) {
              /* ignore */
            }
          }
        }

        function decodeFrame(data) {
          const url = typeof data === 'string' && data.indexOf('data:') === 0
            ? data
            : 'data:image/jpeg;base64,' + data
          if (typeof createImageBitmap === 'function') {
            return fetch(url).then(function (response) {
              return response.blob()
            }).then(function (blob) {
              return createImageBitmap(blob)
            })
          }
          return new Promise(function (resolve, reject) {
            const image = new Image()
            image.onload = function () {
              resolve(image)
            }
            image.onerror = function () {
              reject(new Error('frame decode failed'))
            }
            image.src = url
          })
        }

        function schedulePaint() {
          if (rt.paintRaf || rt.decoding || rt.pendingFrame === null || !isAlive()) return
          rt.paintRaf = requestAnimationFrame(paintFrame)
        }

        function paintFrame() {
          rt.paintRaf = 0
          const frame = rt.pendingFrame
          if (frame === null || !isAlive()) return
          rt.pendingFrame = null
          if (typeof frame.seq === 'number') rt.lastSeq = frame.seq
          rt.decoding = true
          decodeFrame(frame.data).then(function (bitmap) {
            rt.decoding = false
            if (!isAlive()) {
              closeBitmap(bitmap)
              return
            }
            drawBitmap(bitmap, frame)
            schedulePaint()
          }, function () {
            rt.decoding = false
            /* a frame that fails to decode is dropped; the next one wins */
            schedulePaint()
          })
        }

        function drawBitmap(bitmap, frame) {
          const canvas = canvasRef.current
          if (!canvas) {
            closeBitmap(bitmap)
            return
          }
          const width = bitmap.width || frame.w || 0
          const height = bitmap.height || frame.h || 0
          if (!width || !height) {
            closeBitmap(bitmap)
            return
          }
          if (canvas.width !== width) canvas.width = width
          if (canvas.height !== height) canvas.height = height
          const context = canvas.getContext('2d')
          if (!context) {
            closeBitmap(bitmap)
            return
          }
          try {
            context.drawImage(bitmap, 0, 0, width, height)
          } catch (error) {
            /* ignore an undecodable frame */
          }
          closeBitmap(bitmap)
          if (frame.w > 0 && frame.h > 0) {
            setFrameSize(function (prev) {
              return prev && prev.w === frame.w && prev.h === frame.h ? prev : { w: frame.w, h: frame.h }
            })
          }
          if (!rt.firstFrame) {
            rt.firstFrame = true
            setHasFrame(true)
          }
        }

        function queueFrame(frame) {
          if (!isAlive() || !frame || typeof frame.data !== 'string' || frame.data === '') return
          if (typeof frame.seq === 'number' && frame.seq <= rt.lastSeq) return
          rt.pendingFrame = frame
          schedulePaint()
        }

        // ---------- input ----------
        function pagePoint(clientX, clientY) {
          const canvas = canvasRef.current
          const size = viewportRef.current
          if (!canvas || !size || !size.width || !size.height) return null
          const rect = canvas.getBoundingClientRect()
          if (!rect || !rect.width || !rect.height) return null
          return {
            x: clamp((clientX - rect.left) * size.width / rect.width, 0, size.width - 1),
            y: clamp((clientY - rect.top) * size.height / rect.height, 0, size.height - 1),
          }
        }

        function buttonName(button) {
          if (button === 1) return 'middle'
          if (button === 2) return 'right'
          return 'left'
        }

        function modifiersOf(event) {
          return {
            alt: !!event.altKey,
            ctrl: !!event.ctrlKey,
            meta: !!event.metaKey,
            shift: !!event.shiftKey,
          }
        }

        function keyNameOf(event) {
          if (typeof event.key === 'string' && event.key !== '' && event.key !== 'Unidentified') return event.key
          const map = {
            8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape', 32: ' ', 33: 'PageUp', 34: 'PageDown',
            35: 'End', 36: 'Home', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
            45: 'Insert', 46: 'Delete',
          }
          return map[event.keyCode] || ''
        }

        function keyCodeOf(event) {
          if (typeof event.keyCode === 'number' && event.keyCode > 0) return event.keyCode
          const key = event.key
          if (key === 'Enter') return 13
          if (key === 'Tab') return 9
          if (key === 'Escape') return 27
          if (key === 'Backspace') return 8
          if (key === ' ') return 32
          if (typeof key === 'string' && key.length === 1) return key.toUpperCase().charCodeAt(0)
          return undefined
        }

        /** Fire-and-forget action; input must not surface transient errors. */
        function sendQuiet(action, params) {
          if (!isAlive() || !rt.chromeTabId) return
          postAction(session, rt.chromeTabId, action, params, controller.signal).then(function () {}, function (error) {
            if (isAbortError(error) || !isAlive()) return
          })
        }

        /** Action whose failure is worth showing in the status line. */
        function send(action, params, fallbackKey) {
          if (!isAlive() || !rt.chromeTabId) return
          clearNotice()
          postAction(session, rt.chromeTabId, action, params, controller.signal).then(function (result) {
            if (!isAlive()) return
            return result
          }, function (error) {
            if (isAbortError(error) || !isAlive()) return
            showError(error, fallbackKey)
          })
        }

        function flushMove() {
          rt.moveTimer = 0
          const point = rt.movePoint
          rt.movePoint = null
          if (!point || !isAlive()) return
          sendQuiet('mouse', { type: 'move', x: point.x, y: point.y })
        }

        function onPointerDown(event) {
          if (!isAlive()) return
          const canvas = canvasRef.current
          if (canvas && typeof canvas.focus === 'function') {
            try {
              canvas.focus({ preventScroll: true })
            } catch (error) {
              canvas.focus()
            }
          }
          if (pickModeRef.current) {
            event.preventDefault()
            return
          }
          const point = pagePoint(event.clientX, event.clientY)
          if (!point) return
          event.preventDefault()
          sendQuiet('mouse', {
            type: 'down',
            x: point.x,
            y: point.y,
            button: buttonName(event.button),
            clickCount: event.detail > 0 ? event.detail : 1,
          })
        }

        function onPointerUp(event) {
          if (!isAlive()) return
          const point = pagePoint(event.clientX, event.clientY)
          if (!point) return
          event.preventDefault()
          if (pickModeRef.current) {
            if (event.button === 0) performPick(point)
            return
          }
          sendQuiet('mouse', {
            type: 'up',
            x: point.x,
            y: point.y,
            button: buttonName(event.button),
            clickCount: event.detail > 0 ? event.detail : 1,
          })
        }

        function onPointerMove(event) {
          if (!isAlive()) return
          const point = pagePoint(event.clientX, event.clientY)
          if (!point) return
          setPointer(pointerPercent(event.clientX, event.clientY))
          // Both modes probe the element under the cursor: pick mode drives the
          // pick outline, normal mode mirrors hover feedback and the page cursor.
          requestHover(point)
          if (pickModeRef.current) return
          rt.movePoint = point
          if (!rt.moveTimer) rt.moveTimer = setTimeout(flushMove, MOVE_THROTTLE_MS)
        }

        function onPointerLeave() {
          if (!isAlive()) return
          rt.movePoint = null
          setPointer(null)
          setPageCursor('default')
          setHover(null)
        }

        /** Pointer position as a percentage of the visible stage. */
        function pointerPercent(clientX, clientY) {
          const canvas = canvasRef.current
          if (!canvas || typeof canvas.getBoundingClientRect !== 'function') return null
          const rect = canvas.getBoundingClientRect()
          if (!rect || !rect.width || !rect.height) return null
          return {
            left: clamp((clientX - rect.left) / rect.width, 0, 1) * 100,
            top: clamp((clientY - rect.top) / rect.height, 0, 1) * 100,
          }
        }

        function onWheel(event) {
          if (!isAlive()) return
          const point = pagePoint(event.clientX, event.clientY)
          event.preventDefault()
          if (!point) return
          sendQuiet('wheel', { x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY })
        }

        function onKeyDown(event) {
          if (!isAlive() || !rt.chromeTabId) return
          if (event.isComposing || event.keyCode === 229) return
          const key = keyNameOf(event)
          if (key === '') return
          // Escape disarms the picker locally instead of reaching the page.
          if (key === 'Escape' && pickModeRef.current) {
            event.preventDefault()
            setPickMode(false)
            pickModeRef.current = false
            setHover(null)
            sendQuiet('pickArm', { on: false })
            return
          }
          const mods = modifiersOf(event)
          event.preventDefault()
          if (key === 'Unidentified' || key === 'Process' || key === 'Dead') return
          if (key.length === 1 && !mods.ctrl && !mods.meta && !mods.alt) {
            sendQuiet('text', { text: key })
            return
          }
          sendQuiet('key', {
            type: 'down',
            key: key,
            code: event.code || '',
            keyCode: keyCodeOf(event),
            modifiers: mods,
          })
        }

        function onKeyUp(event) {
          if (!isAlive() || !rt.chromeTabId) return
          if (event.isComposing || event.keyCode === 229) return
          const key = keyNameOf(event)
          if (key === '') return
          if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return
          event.preventDefault()
          if (key === 'Unidentified') return
          sendQuiet('key', {
            type: 'up',
            key: key,
            code: event.code || '',
            keyCode: keyCodeOf(event),
            modifiers: modifiersOf(event),
          })
        }

        function onContextMenu(event) {
          event.preventDefault()
        }

        // ---------- picker ----------
        function flushHover() {
          rt.hoverTimer = 0
          const point = rt.hoverPoint
          rt.hoverPoint = null
          if (!point || !isAlive() || !rt.chromeTabId) {
            rt.hoverBusy = false
            return
          }
          const picking = pickModeRef.current
          rt.hoverBusy = true
          postAction(session, rt.chromeTabId, picking ? 'pickHover' : 'probe', { x: point.x, y: point.y }, controller.signal)
            .then(function (result) {
              rt.hoverBusy = false
              if (!isAlive()) return
              const rect = result && result.rect ? result.rect : null
              setHover(rect ? { rect: rect, label: result.label || '' } : null)
              if (!picking) {
                setPageCursor(rect && result && typeof result.cursor === 'string' && result.cursor ? result.cursor : 'default')
              }
              if (rt.hoverPoint !== null && !rt.hoverTimer) {
                rt.hoverTimer = setTimeout(flushHover, picking ? HOVER_THROTTLE_MS : PROBE_THROTTLE_MS)
              }
            }, function (error) {
              rt.hoverBusy = false
              if (isAbortError(error) || !isAlive()) return
              if (rt.hoverPoint !== null && !rt.hoverTimer) {
                rt.hoverTimer = setTimeout(flushHover, pickModeRef.current ? HOVER_THROTTLE_MS : PROBE_THROTTLE_MS)
              }
            })
        }

        function requestHover(point) {
          if (!isAlive() || !rt.chromeTabId) return
          rt.hoverPoint = point
          if (rt.hoverBusy || rt.hoverTimer) return
          rt.hoverTimer = setTimeout(flushHover, HOVER_THROTTLE_MS)
        }

        function showFlash(rect, label) {
          if (!isAlive()) return
          setFlash({ rect: rect, label: label || '', nonce: Date.now() })
          if (rt.flashTimer) clearTimeout(rt.flashTimer)
          rt.flashTimer = setTimeout(function () {
            rt.flashTimer = 0
            if (isAlive()) setFlash(null)
          }, FLASH_MS)
        }

        function performPick(point) {
          if (!isAlive() || !rt.chromeTabId || rt.pickBusy) return
          rt.pickBusy = true
          postAction(session, rt.chromeTabId, 'pick', { x: point.x, y: point.y }, controller.signal)
            .then(function (result) {
              rt.pickBusy = false
              if (!isAlive()) return
              const pick = result && result.pick
              if (!pick || !pick.pickId) return
              setPicks(function (prev) {
                for (let i = 0; i < prev.length; i += 1) {
                  if (prev[i] && prev[i].pickId === pick.pickId) return prev
                }
                return prev.concat([pick])
              })
              if (pick.rect) showFlash(pick.rect, pick.selector || pick.tag || '')
              setHover(null)
            }, function (error) {
              rt.pickBusy = false
              if (isAbortError(error) || !isAlive()) return
              showError(error, 'error.pick')
            })
        }

        // ---------- bootstrap / stream ----------
        function closeStream() {
          if (rt.stream) {
            try {
              rt.stream.close()
            } catch (error) {
              /* ignore */
            }
            rt.stream = null
          }
          if (rt.reconnectTimer) {
            clearTimeout(rt.reconnectTimer)
            rt.reconnectTimer = 0
          }
        }

        function openStream() {
          if (!isAlive() || !rt.chromeTabId || rt.stream || !visibleRef.current) return
          // A fresh stream may restart its sequence counter; never drop its first frames.
          rt.lastSeq = -1
          let source = null
          try {
            source = new EventSource(BASE + '/stream?sessionId=' + encodeURIComponent(session)
              + '&tabId=' + encodeURIComponent(rt.chromeTabId))
          } catch (error) {
            scheduleReconnect()
            return
          }
          rt.stream = source

          source.addEventListener('open', function () {
            if (!isAlive()) return
            rt.backoff = START_BACKOFF_MS
            setPhase('ready')
            resync()
          })
          source.addEventListener('status', function (event) {
            parseEvent(event, applyStatusEvent)
          })
          source.addEventListener('frame', function (event) {
            // `keepalive: true` frames are ordinary frames with the flag set.
            parseEvent(event, queueFrame)
          })
          source.addEventListener('hover', function (event) {
            parseEvent(event, function (payload) {
              if (!isAlive()) return
              const rect = payload && payload.rect ? payload.rect : null
              setHover(rect ? { rect: rect, label: payload.label || '' } : null)
            })
          })
          source.addEventListener('picks', function (event) {
            parseEvent(event, function (payload) {
              if (isAlive() && payload && Array.isArray(payload.picks)) setPicks(payload.picks)
            })
          })
          source.addEventListener('ping', function () {
            /* liveness only */
          })
          source.addEventListener('error', function (event) {
            if (!isAlive()) return
            if (event && typeof event.data === 'string' && event.data !== '') {
              parseEvent(event, function (payload) {
                if (payload && payload.message) setNotice(payload.message)
              })
            }
            scheduleReconnect()
          })
        }

        function parseEvent(event, apply) {
          if (!isAlive()) return
          let payload = null
          try {
            payload = JSON.parse(event.data)
          } catch (error) {
            return
          }
          if (payload === null || payload === undefined) return
          try {
            apply(payload)
          } catch (error) {
            /* a malformed event never breaks the stream */
          }
        }

        function scheduleReconnect() {
          if (!isAlive()) return
          closeStream()
          if (rt.reconnectTimer || !visibleRef.current) return
          setPhase('reconnecting')
          const delay = rt.backoff
          rt.backoff = Math.min(Math.round(rt.backoff * 1.8), MAX_BACKOFF_MS)
          rt.reconnectTimer = setTimeout(function () {
            rt.reconnectTimer = 0
            revalidateAndOpen()
          }, delay)
        }

        function resync() {
          fetchState(session, controller.signal).then(function (doc) {
            if (!isAlive()) return
            applyStateDoc(doc)
          }, function (error) {
            if (isAbortError(error) || !isAlive()) return
          })
        }

        function revalidateAndOpen() {
          if (!isAlive() || !visibleRef.current) return
          fetchState(session, controller.signal).then(function (doc) {
            if (!isAlive()) return
            applyStateDoc(doc)
            const tabs = Array.isArray(doc.tabs) ? doc.tabs : []
            let exists = false
            for (let i = 0; i < tabs.length; i += 1) {
              if (tabs[i] && tabs[i].tabId === rt.chromeTabId) {
                exists = true
                break
              }
            }
            if (exists) {
              openStream()
              return
            }
            openChromeTab(doc).then(function (row) {
              if (!isAlive()) return
              if (row) {
                claimRow(row)
                setPhase('ready')
                openStream()
                return
              }
              // The flight was aborted (superseded mount): retry on the backoff.
              scheduleReconnect()
            }, function (error) {
              if (!isAlive()) return
              scheduleReconnect()
            })
          }, function (error) {
            if (!isAlive()) return
            openStream()
          })
        }

        function adoptTabRow(tabs) {
          const claimed = new Set()
          tabMap.forEach(function (value, mapKey) {
            if (mapKey !== storeKey) claimed.add(value)
          })
          let candidate = null
          for (let i = 0; i < tabs.length; i += 1) {
            const row = tabs[i]
            if (row && row.tabId && !claimed.has(row.tabId)) {
              candidate = row
              break
            }
          }
          if (candidate === null) candidate = tabs[0] || null
          return candidate
        }

        /** A tab row the Host already owns for this panel key (additive field, when present). */
        function findKeyedRow(tabs) {
          for (let i = 0; i < tabs.length; i += 1) {
            const row = tabs[i]
            if (row && row.tabId && (row.key === storeKey || row.panelKey === storeKey)) return row
          }
          return null
        }

        function adoptRow(row) {
          if (!row || !row.tabId) return
          rt.chromeTabId = row.tabId
          tabMap.set(storeKey, row.tabId)
          applyTabRow(row)
        }

        /** Adopt a row returned by a (possibly shared) openTab flight into this effect. */
        function claimRow(row) {
          if (!row || !row.tabId) return row
          if (rt.chromeTabId !== row.tabId || tabMap.get(storeKey) !== row.tabId) {
            rt.chromeTabId = row.tabId
            tabMap.set(storeKey, row.tabId)
            applyTabRow(row)
          }
          return row
        }

        /**
         * Ensure this panel tab owns a Chrome target; reuse the mapped one when possible.
         *
         * The request deliberately uses its own AbortController and is shared
         * through `tabOpenFlights`: under React StrictMode (or an HMR/epoch
         * remount) the first mount's request must outlive its cleanup so the
         * second mount *awaits* it instead of racing a second `openTab` at the
         * Host. The Host also dedupes by `key`, so the two halves cannot create
         * two Chrome targets.
         */
        function openChromeTab(doc) {
          const tabs = doc && Array.isArray(doc.tabs) ? doc.tabs : []
          const inflight = tabOpenFlights.get(storeKey)
          if (inflight !== undefined) return inflight
          const flightController = new AbortController()
          const request = postAction(session, null, 'openTab', { url: initialUrl, key: storeKey }, flightController.signal)
          const flight = new Promise(function (resolve, reject) {
            const timer = setTimeout(function () {
              flightController.abort()
              reject(new Error(tRef.current('error.openTab')))
            }, OPEN_TIMEOUT_MS)
            request.then(function (value) {
              clearTimeout(timer)
              resolve(value)
            }, function (error) {
              clearTimeout(timer)
              reject(error)
            })
          }).then(function (result) {
            const row = result && result.tab
            if (!row || !row.tabId) throw new Error(tRef.current('error.noTab'))
            adoptRow(row)
            return row
          }, function (error) {
            if (error && error.code === 'tab-limit' && tabs.length > 0) {
              const candidate = adoptTabRow(tabs)
              if (candidate && candidate.tabId) {
                adoptRow(candidate)
                return candidate
              }
            }
            throw error
          })
          tabOpenFlights.set(storeKey, flight)
          const release = function release() {
            if (tabOpenFlights.get(storeKey) === flight) tabOpenFlights.delete(storeKey)
          }
          flight.then(release, release)
          return flight
        }

        function ensureChromeTab(doc) {
          const tabs = doc && Array.isArray(doc.tabs) ? doc.tabs : []
          if (rt.chromeTabId) {
            for (let i = 0; i < tabs.length; i += 1) {
              const row = tabs[i]
              if (row && row.tabId === rt.chromeTabId) {
                applyTabRow(row)
                return Promise.resolve(row)
              }
            }
            rt.chromeTabId = null
          }
          const mapped = tabMap.get(storeKey)
          if (mapped) {
            for (let i = 0; i < tabs.length; i += 1) {
              const row = tabs[i]
              if (row && row.tabId === mapped) {
                adoptRow(row)
                return Promise.resolve(row)
              }
            }
            tabMap.delete(storeKey)
          }
          const keyed = findKeyedRow(tabs)
          if (keyed) {
            adoptRow(keyed)
            return Promise.resolve(keyed)
          }
          return openChromeTab(doc).then(claimRow)
        }

        async function bootstrap() {
          setPhase('starting')
          setNotice(null)
          let hostMisses = 0
          let attempts = 0
          while (isAlive()) {
            let doc = null
            try {
              doc = await fetchState(session, controller.signal)
            } catch (error) {
              if (isAbortError(error)) return
              doc = null
            }
            if (!isAlive()) return
            const state = chromeStateOf(doc)
            if (state === null) {
              hostMisses += 1
              if (hostMisses >= HOST_MISS_LIMIT) {
                setPhase('error')
                setNotice(tRef.current('error.host'))
                return
              }
              try {
                await postAction(session, null, 'ensure', {}, controller.signal)
              } catch (error) {
                if (isAbortError(error)) return
              }
            } else {
              setChrome(state)
              publishTitle(storeKey, { chrome: state.status })
              if (state.status === 'ready') {
                applyStateDoc(doc)
                let row = null
                try {
                  row = await ensureChromeTab(doc)
                } catch (error) {
                  if (!isAlive()) return
                  if (!isAbortError(error)) {
                    setPhase('error')
                    setNotice(error && error.message ? error.message : tRef.current('error.openTab'))
                    return
                  }
                  // A superseded/aborted request (a concurrent mount owns the
                  // flight): treat it as transient and retry instead of hanging.
                }
                if (!isAlive()) return
                if (row) {
                  setPhase('ready')
                  openStream()
                  return
                }
                setPhase('error')
                setNotice(tRef.current('error.noTab'))
                return
              }
              if (state.status === 'error') {
                setPhase('error')
                setNotice(state.message || tRef.current('error.chrome'))
                return
              }
              // idle | launching: ask the Host to ensure and wait.
              try {
                const result = await postAction(session, null, 'ensure', {}, controller.signal)
                const next = result && result.chrome
                if (isAlive() && next && typeof next === 'object' && typeof next.status === 'string') {
                  setChrome(next)
                  publishTitle(storeKey, { chrome: next.status })
                }
              } catch (error) {
                if (isAbortError(error)) return
              }
            }
            attempts += 1
            if (attempts > LAUNCH_ATTEMPT_LIMIT) {
              setPhase('error')
              setNotice(tRef.current('error.chrome'))
              return
            }
            await sleep(Math.min(300 + attempts * 250, 2000), controller.signal)
          }
        }

        // ---------- engine API used by the React handlers ----------
        const engine = {
          navigate: function (raw) {
            const url = normalizeUrl(raw)
            if (!url || !rt.chromeTabId) return
            clearNotice()
            postAction(session, rt.chromeTabId, 'navigate', { url: url }, controller.signal)
              .then(function (result) {
                if (!isAlive()) return
                if (result && result.tab) applyTabRow(result.tab)
              }, function (error) {
                if (isAbortError(error) || !isAlive()) return
                showError(error, 'error.navigate')
              })
          },
          back: function () {
            send('back', {}, 'error.navigate')
          },
          forward: function () {
            send('forward', {}, 'error.navigate')
          },
          reload: function () {
            send('reload', {}, 'error.navigate')
          },
          setPickMode: function (on) {
            if (!isAlive() || !rt.chromeTabId) return
            const next = !!on
            setPickMode(next)
            pickModeRef.current = next
            if (!next) setHover(null)
            postAction(session, rt.chromeTabId, 'pickArm', { on: next }, controller.signal)
              .then(function (result) {
                if (!isAlive()) return
                const armed = !!(result && result.pickMode)
                setPickMode(armed)
                pickModeRef.current = armed
              }, function (error) {
                if (isAbortError(error) || !isAlive()) return
                setPickMode(!next)
                pickModeRef.current = !next
                showError(error, 'error.pick')
              })
          },
          dropPick: function (pickId) {
            if (!isAlive() || !pickId) return
            setPicks(function (prev) {
              return prev.filter(function (pick) {
                return !pick || pick.pickId !== pickId
              })
            })
            postAction(session, rt.chromeTabId, 'picksDrop', { pickId: pickId }, controller.signal)
              .then(function (result) {
                if (!isAlive()) return
                if (result && Array.isArray(result.picks)) setPicks(result.picks)
              }, function (error) {
                if (isAbortError(error) || !isAlive()) return
                showError(error, 'error.action')
                resync()
              })
          },
          clearPicks: function () {
            if (!isAlive()) return
            setPicks([])
            postAction(session, rt.chromeTabId, 'picksClear', {}, controller.signal)
              .then(function (result) {
                if (!isAlive()) return
                if (result && Array.isArray(result.picks)) setPicks(result.picks)
              }, function (error) {
                if (isAbortError(error) || !isAlive()) return
                showError(error, 'error.action')
                resync()
              })
          },
          resizeFit: function (width, height) {
            if (!isAlive() || !rt.chromeTabId) return
            const w = Math.max(240, Math.round(width))
            const hh = Math.max(160, Math.round(height))
            clearNotice()
            postAction(session, rt.chromeTabId, 'resize', { width: w, height: hh }, controller.signal)
              .then(function (result) {
                if (!isAlive()) return
                const size = result && result.viewport
                if (size && size.width > 0 && size.height > 0) {
                  setViewport({ width: size.width, height: size.height })
                }
              }, function (error) {
                if (isAbortError(error) || !isAlive()) return
                showError(error, 'error.action')
              })
          },
          retry: function () {
            setEpoch(function (value) {
              return value + 1
            })
          },
          resume: function () {
            if (!isAlive() || rt.stream) return
            if (!rt.chromeTabId) return
            revalidateAndOpen()
          },
          pause: function () {
            if (!rt.alive) return
            closeStream()
            setPhase(function (current) {
              return current === 'reconnecting' ? 'ready' : current
            })
            setHover(null)
          },
        }
        engineRef.current = engine

        // ---------- DOM listeners (attached directly: wheel must be non-passive) ----------
        const canvas = canvasRef.current
        const cleanups = []
        if (canvas) {
          const wheelOptions = { passive: false }
          canvas.addEventListener('pointerdown', onPointerDown)
          canvas.addEventListener('pointerup', onPointerUp)
          canvas.addEventListener('pointermove', onPointerMove)
          canvas.addEventListener('pointerleave', onPointerLeave)
          canvas.addEventListener('wheel', onWheel, wheelOptions)
          canvas.addEventListener('keydown', onKeyDown)
          canvas.addEventListener('keyup', onKeyUp)
          canvas.addEventListener('contextmenu', onContextMenu)
          cleanups.push(function () {
            canvas.removeEventListener('pointerdown', onPointerDown)
            canvas.removeEventListener('pointerup', onPointerUp)
            canvas.removeEventListener('pointermove', onPointerMove)
            canvas.removeEventListener('pointerleave', onPointerLeave)
            canvas.removeEventListener('wheel', onWheel, wheelOptions)
            canvas.removeEventListener('keydown', onKeyDown)
            canvas.removeEventListener('keyup', onKeyUp)
            canvas.removeEventListener('contextmenu', onContextMenu)
          })
        }

        // Returning from a backgrounded browser tab: refetch state (picks survive),
        // and reopen the stream if it was closed or dropped.
        function onVisibilityChange() {
          if (!isAlive() || document.visibilityState !== 'visible' || !visibleRef.current) return
          resync()
          if (!rt.stream && rt.chromeTabId) revalidateAndOpen()
        }
        document.addEventListener('visibilitychange', onVisibilityChange)

        bootstrap()

        return function () {
          rt.alive = false
          controller.abort()
          closeStream()
          // In-flight openTab flights are intentionally kept: they own their own
          // controller and a remount awaits them (host-side `key` dedupe makes
          // the reuse safe, and racing a second request could open two targets).
          document.removeEventListener('visibilitychange', onVisibilityChange)
          if (rt.paintRaf) cancelAnimationFrame(rt.paintRaf)
          if (rt.flashTimer) clearTimeout(rt.flashTimer)
          if (rt.hoverTimer) clearTimeout(rt.hoverTimer)
          if (rt.moveTimer) clearTimeout(rt.moveTimer)
          rt.pendingFrame = null
          rt.hoverPoint = null
          rt.movePoint = null
          for (let i = 0; i < cleanups.length; i += 1) cleanups[i]()
          if (engineRef.current === engine) engineRef.current = null
        }
      }, [sessionId, tabId, titleKey, epoch])

      // Pause the stream while this tab is hidden; keepMounted keeps the canvas.
      useEffect(function () {
        const engine = engineRef.current
        if (!engine) return
        if (tab.visible) engine.resume()
        else engine.pause()
      }, [tab.visible, epoch])

      // Keep the sidebar's refresh command wired to the panel reload.
      useEffect(function () {
        const actions = tab.actions
        if (!actions || typeof actions.bindCommands !== 'function') return undefined
        try {
          return actions.bindCommands({
            refresh: function () {
              const engine = engineRef.current
              if (engine) engine.reload()
            },
          })
        } catch (error) {
          return undefined
        }
      }, [tab.actions])

      // A re-open of the same tab occurrence with new params navigates the page.
      const navigationRevision = tab.navigation ? tab.navigation.revision : 0
      const navigationSettled = useRef(false)
      useEffect(function () {
        if (!navigationSettled.current) {
          navigationSettled.current = true
          return
        }
        const params = tab.navigation ? tab.navigation.params : undefined
        const url = normalizeUrl(params && params.url)
        if (!url) return
        const engine = engineRef.current
        if (engine) engine.navigate(url)
      }, [navigationRevision])

      // ---- derived view data ------------------------------------------
      const interactive = phase === 'ready' || phase === 'reconnecting'
      const chromeStatus = chrome && typeof chrome.status === 'string' ? chrome.status : 'idle'
      const chromeLabel = (function () {
        if (phase === 'reconnecting') return t('status.reconnecting')
        if (phase === 'starting' && chromeStatus !== 'error') return t('chrome.launching')
        if (chromeStatus === 'ready') return t('chrome.ready')
        if (chromeStatus === 'launching') return t('chrome.launching')
        if (chromeStatus === 'error') return t('chrome.error')
        return t('chrome.idle')
      })()
      const dotState = (function () {
        if (phase === 'error' || chromeStatus === 'error') return 'error'
        if (phase === 'reconnecting') return 'reconnecting'
        if (chromeStatus === 'ready' && phase !== 'starting') return 'ready'
        return 'starting'
      })()
      const pageLabel = (function () {
        if (!page) return t('status.noPage')
        if (page.url) return page.url
        if (page.title) return page.title
        return t('status.noPage')
      })()
      const pageTitleAttr = page
        ? [page.title, page.url].filter(function (value) { return !!value }).join(' — ')
        : ''
      const addressValue = draft
      const externalEnabled = !!(page && isSafeExternal(page.url) && interactive)

      function rectStyle(rect) {
        if (!rect || !viewport || !viewport.width || !viewport.height) return null
        const vw = viewport.width
        const vh = viewport.height
        return {
          left: clamp(rect.x / vw, 0, 1) * 100 + '%',
          top: clamp(rect.y / vh, 0, 1) * 100 + '%',
          width: clamp(rect.w / vw, 0, 1) * 100 + '%',
          height: clamp(rect.h / vh, 0, 1) * 100 + '%',
        }
      }

      const hoverStyle = hover && hover.rect ? rectStyle(hover.rect) : null
      const flashStyle = flash && flash.rect ? rectStyle(flash.rect) : null

      function preventFocus(event) {
        event.preventDefault()
      }

      function submitAddress(event) {
        event.preventDefault()
        const engine = engineRef.current
        if (engine) engine.navigate(addressValue)
      }

      function openNewTab() {
        try {
          tab.actions.openTab(KIND, { params: { url: 'about:blank' } })
        } catch (error) {
          setNotice(t('error.openTab'))
        }
      }

      function openExternal() {
        if (!page || !isSafeExternal(page.url)) return
        try {
          window.open(page.url, '_blank', 'noopener,noreferrer')
        } catch (error) {
          /* popup blocked; nothing else to do */
        }
      }

      function fitToPanel() {
        const wrapper = stageWrapRef.current
        const engine = engineRef.current
        if (!wrapper || !engine) return
        const rect = wrapper.getBoundingClientRect()
        if (!rect || !rect.width || !rect.height) return
        engine.resizeFit(rect.width, rect.height)
      }

      function togglePick() {
        const engine = engineRef.current
        if (!engine) return
        engine.setPickMode(!pickMode)
      }

      function retry() {
        const engine = engineRef.current
        if (engine) engine.retry()
      }

      /** Human-readable mention inserted into the composer; the full descriptor still comes from the Host. */
      function mentionText(pick) {
        const target = pick && (pick.selector || pick.tag) ? (pick.selector || pick.tag) : 'element'
        const text = pick && pick.text ? String(pick.text).replace(/\s+/g, ' ').trim().slice(0, 40) : ''
        return text ? '@browser ' + target + ' "' + text + '"' : '@browser ' + target
      }

      /** Insert a visible mention into the composer draft without sending it. */
      function insertMention(pick) {
        const actions = props.inputActions
        if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') {
          setNotice(t('picks.mentionUnavailable'))
          return
        }
        try {
          const span = actions.captureInsertion()
          const ok = actions.insertText(' ' + mentionText(pick) + ' ', span)
          if (ok === false) setNotice(t('picks.mentionFailed'))
        } catch (error) {
          setNotice(t('picks.mentionFailed'))
        }
      }

      function copySelector(pick) {
        if (!pick || !pick.selector) return
        const selector = pick.selector
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            Promise.resolve(navigator.clipboard.writeText(selector)).catch(function () {})
          }
        } catch (error) {
          /* clipboard unavailable: the selector is still visible in the chip */
        }
      }

      if (!sessionId) return null

      const overlay = (function () {
        if (phase === 'starting') {
          return h('div', { className: 'dshbp-stageOverlay' },
            h('div', { className: 'dshbp-spinner' }),
            h('span', null, t('chrome.launching')))
        }
        if (phase === 'error') {
          return h('div', { className: 'dshbp-stageOverlay' },
            h('span', { className: 'dshbp-stageError' }, notice || t('error.generic')))
        }
        if (!hasFrame) {
          return h('div', { className: 'dshbp-stageOverlay' },
            h('div', { className: 'dshbp-spinner' }),
            h('span', null, phase === 'reconnecting' ? t('status.reconnecting') : t('status.waitingFrame')))
        }
        return null
      })()

      const picksStrip = h('section', {
        className: 'dshbp-picks',
        'data-browser-panel-picks': '',
        'aria-label': t('picks.title', { count: picks.length }),
      },
      picks.length > 0
        ? h('div', { className: 'dshbp-picksHead' },
          h('span', { className: 'dshbp-picksTitle' }, t('picks.title', { count: picks.length })),
          h('button', {
            type: 'button',
            className: 'dshbp-linkBtn',
            onMouseDown: preventFocus,
            onClick: function () {
              const engine = engineRef.current
              if (engine) engine.clearPicks()
            },
          }, t('picks.clear')))
        : null,
      picks.length > 0
        ? h('div', { className: 'dshbp-picksList' }, picks.map(function (pick, index) {
          const id = pick && pick.pickId ? pick.pickId : 'pick-' + index
          const label = pick && (pick.selector || pick.tag) ? (pick.selector || pick.tag) : id
          return h('div', { className: 'dshbp-chip', key: id, title: pick && pick.text ? pick.text : label },
            h('span', { className: 'dshbp-chipLabel' }, label),
            pick && pick.text ? h('span', { className: 'dshbp-chipText' }, pick.text) : null,
            h('button', {
              type: 'button',
              className: 'dshbp-chipBtn',
              'data-browser-panel-mention': '',
              'aria-label': t('picks.mention'),
              title: t('picks.mention'),
              onMouseDown: preventFocus,
              onClick: function () {
                insertMention(pick)
              },
            }, h('span', { className: 'dshbp-chipGlyph' }, '@')),
            h('button', {
              type: 'button',
              className: 'dshbp-chipBtn',
              'aria-label': t('picks.copy'),
              title: t('picks.copy'),
              onMouseDown: preventFocus,
              onClick: function () {
                copySelector(pick)
              },
            }, h(IconCopy, null)),
            h('button', {
              type: 'button',
              className: 'dshbp-chipBtn',
              'aria-label': t('picks.remove'),
              title: t('picks.remove'),
              onMouseDown: preventFocus,
              onClick: function () {
                const engine = engineRef.current
                if (engine) engine.dropPick(pick && pick.pickId)
              },
            }, h(IconClose, null)))
        }))
        : null,
      h('p', { className: 'dshbp-picksHint' }, t('picks.hint')))

      const statusArea = h('div', { className: 'dshbp-statusArea', 'data-browser-panel-status': '' },
        h('div', { className: 'dshbp-statusRow' },
          h('span', { className: 'dshbp-dot', 'data-state': dotState }),
          h('span', { className: 'dshbp-statusText' }, chromeLabel),
          h('span', { className: 'dshbp-statusSep' }, '·'),
          h('span', { className: 'dshbp-pageText', title: pageTitleAttr }, pageLabel),
          notice !== null
            ? h('button', {
              type: 'button',
              className: 'dshbp-linkBtn',
              onMouseDown: preventFocus,
              onClick: retry,
            }, t('status.retry'))
            : null),
        notice !== null
          ? h('div', { className: 'dshbp-noticeRow' },
            h('span', { className: 'dshbp-noticeText' }, notice))
          : null)

      const toolbar = h('div', { className: 'dshbp-toolbar' },
        h('button', {
          type: 'button',
          className: 'dshbp-tool',
          'aria-label': t('back'),
          title: t('back'),
          disabled: !interactive || !page || !page.canGoBack,
          onMouseDown: preventFocus,
          onClick: function () {
            const engine = engineRef.current
            if (engine) engine.back()
          },
        }, h(IconBack, null)),
        h('button', {
          type: 'button',
          className: 'dshbp-tool',
          'aria-label': t('forward'),
          title: t('forward'),
          disabled: !interactive || !page || !page.canGoForward,
          onMouseDown: preventFocus,
          onClick: function () {
            const engine = engineRef.current
            if (engine) engine.forward()
          },
        }, h(IconForward, null)),
        h('button', {
          type: 'button',
          className: 'dshbp-tool',
          'aria-label': t('reload'),
          title: t('reload'),
          disabled: !interactive,
          onMouseDown: preventFocus,
          onClick: function () {
            const engine = engineRef.current
            if (engine) engine.reload()
          },
        }, h(IconReload, null)),
        h('form', { className: 'dshbp-addressWrap', onSubmit: submitAddress },
          h('input', {
            className: 'dshbp-address',
            type: 'text',
            value: addressValue,
            placeholder: t('address.placeholder'),
            'aria-label': t('address.placeholder'),
            spellCheck: false,
            autoComplete: 'off',
            'data-browser-panel-address': '',
            onChange: function (event) {
              setDraft(event.target.value)
            },
            onFocus: function () {
              setAddressFocused(true)
            },
            onBlur: function () {
              setAddressFocused(false)
            },
            onKeyDown: function (event) {
              if (event.key === 'Escape') {
                event.preventDefault()
                setDraft(pageUrl)
                if (event.currentTarget) event.currentTarget.blur()
              }
            },
          }),
          h('button', {
            type: 'submit',
            className: 'dshbp-go',
            'aria-label': t('address.go'),
            title: t('address.go'),
          }, h(IconGo, null))),
        h('button', {
          type: 'button',
          className: 'dshbp-tool',
          'data-browser-panel-pick-toggle': '',
          'aria-label': pickMode ? t('pick.disable') : t('pick.enable'),
          title: pickMode ? t('pick.disable') : t('pick.enable'),
          'aria-pressed': pickMode ? 'true' : 'false',
          disabled: !interactive,
          onMouseDown: preventFocus,
          onClick: togglePick,
        }, h(IconPick, null)),
        h('button', {
          type: 'button',
          className: 'dshbp-tool',
          'aria-label': t('newTab'),
          title: t('newTab'),
          onMouseDown: preventFocus,
          onClick: openNewTab,
        }, h(IconPlus, null)),
        h('button', {
          type: 'button',
          className: 'dshbp-tool',
          'aria-label': t('external'),
          title: t('external'),
          disabled: !externalEnabled,
          onMouseDown: preventFocus,
          onClick: openExternal,
        }, h(IconExternal, null)),
        h('button', {
          type: 'button',
          className: 'dshbp-tool',
          'aria-label': t('fit'),
          title: t('fit'),
          disabled: !interactive,
          onMouseDown: preventFocus,
          onClick: fitToPanel,
        }, h(IconFit, null)))

      const stageStyle = fit ? { width: fit.w + 'px', height: fit.h + 'px' } : undefined
      const canvasCursor = pickMode
        ? 'crosshair'
        : (pageCursor && pageCursor !== 'auto' ? pageCursor : 'default')

      return h('div', { className: 'dshbp-root', 'data-browser-panel': '' },
        h('style', { key: 'dsh-browser-panel-style' }, STYLE_TEXT),
        toolbar,
        picksStrip,
        h('div', { className: 'dshbp-stageWrap', ref: stageWrapRef },
          h('div', { className: 'dshbp-stage', style: stageStyle },
            h('canvas', {
              className: 'dshbp-canvas',
              ref: canvasRef,
              tabIndex: 0,
              'data-browser-panel-canvas': '',
              'aria-label': t('canvas.label'),
              style: { cursor: canvasCursor },
            }),
            hoverStyle
              ? h('div', {
                className: pickMode ? 'dshbp-overlayRect' : 'dshbp-hoverRect',
                'data-browser-panel-hover': '',
                style: hoverStyle,
                title: hover.label || '',
              })
              : null,
            !pickMode && hoverStyle && hover && hover.label
              ? h('div', { className: 'dshbp-hoverTag', style: { left: hoverStyle.left, top: hoverStyle.top } }, hover.label)
              : null,
            flashStyle
              ? h('div', { className: 'dshbp-flashRect', style: flashStyle, title: flash.label || '' })
              : null,
            pointer
              ? h('div', {
                className: 'dshbp-pointer',
                'data-browser-panel-cursor': '',
                key: 'pointer-' + (hover && hover.label ? hover.label : 'none'),
                style: { left: pointer.left + '%', top: pointer.top + '%' },
              })
              : null),
          overlay,
          pickMode && hasFrame
            ? h('div', { className: 'dshbp-pickHint' }, t('pick.hint'))
            : null),
        statusArea)
    }

    // ------------------------------------------------------------------
    // Chip title: the live page title published by the body
    // ------------------------------------------------------------------
    function BrowserTitle(props) {
      const info = props.useTabInfo()
      const tab = info.tab
      const titleKey = props.sessionId + '\u0000' + tab.id
      const live = useLiveTitle(titleKey)
      const text = live && live.title ? live.title : (tab.title || '')
      const tooltip = live && live.url ? live.url : text
      return h('span', {
        style: {
          display: 'block',
          minWidth: 0,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
        title: tooltip,
      }, text)
    }

    // ------------------------------------------------------------------
    // Module
    // ------------------------------------------------------------------
    /** Chrome target per panel tab, so a remount reuses its target instead of spawning one. */
    const tabMap = new Map()
    /** In-flight openTab calls per panel tab, so concurrent mounts share one Chrome target. */
    const tabOpenFlights = new Map()

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],

      apply: function apply(ctx) {
        const t = ctx.locale.bind(NS)

        ctx.effect(function () {
          return ctx.locale.register(NS, 'en', EN)
        }, 'dsh-browser-panel.locale.en')
        ctx.effect(function () {
          return ctx.locale.register(NS, 'zh', ZH)
        }, 'dsh-browser-panel.locale.zh')

        // Tab type + guide card.
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: KIND,
            multiple: true,
            keepMounted: true,
            priority: 'extension',
            title: function () {
              return t('type.label')
            },
            guide: [{
              id: 'new',
              order: 25,
              title: function () {
                return t('guide.title')
              },
              description: function () {
                return t('guide.description')
              },
              icon: BrowserArtwork,
            }],
          })
        }, 'dsh-browser-panel.type')

        // Body.
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: PLUGIN_ID,
              locale: NS,
              inject: function (sessionId) {
                return { sessionId: sessionId }
              },
            }, BrowserBody)
          })
        }, 'dsh-browser-panel.body')

        // Chip title (live page title from the body).
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
            return ctx.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: PLUGIN_ID,
              locale: NS,
              inject: function (sessionId) {
                return { sessionId: sessionId }
              },
            }, BrowserTitle)
          })
        }, 'dsh-browser-panel.title')

        // Explicit tab close closes the Chrome target it owned.
        ctx.effect(function () {
          try {
            return ctx.sidebarRight.registerCloseHandler(KIND, function (sessionId, tab) {
              const storeKey = sessionId + '\u0000' + tab.id
              const chromeTabId = tabMap.get(storeKey)
              const pending = tabOpenFlights.get(storeKey)
              tabMap.delete(storeKey)
              tabOpenFlights.delete(storeKey)
              titleStores.delete(storeKey)
              // A closed panel tab that is still waiting for its target must not
              // leave that target behind once openTab resolves.
              if (pending !== undefined) {
                pending.then(function (row) {
                  if (!row || !row.tabId) return
                  tabMap.delete(storeKey)
                  Promise.resolve(postAction(sessionId, row.tabId, 'closeTab', {})).catch(function () {})
                }, function () {})
              }
              if (!chromeTabId) return
              Promise.resolve(postAction(sessionId, chromeTabId, 'closeTab', {})).catch(function () {})
            })
          } catch (error) {
            return function () {}
          }
        }, 'dsh-browser-panel.close')
      },
    }
  },
})