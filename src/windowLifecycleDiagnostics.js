import { invoke } from '@tauri-apps/api/core'

const SIDEBAR_SELECTOR = '.sidebar'

export function createWindowLifecycleDiagnostics({
  invokeNative = invoke,
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  let started = false

  function snapshot() {
    const visualViewport = win ? win.visualViewport : null
    const sidebar = doc ? doc.querySelector(SIDEBAR_SELECTOR) : null
    return {
      device_pixel_ratio: win ? win.devicePixelRatio : null,
      inner_width: win ? win.innerWidth : null,
      inner_height: win ? win.innerHeight : null,
      outer_width: win ? win.outerWidth : null,
      outer_height: win ? win.outerHeight : null,
      client_width: doc && doc.documentElement ? doc.documentElement.clientWidth : null,
      client_height: doc && doc.documentElement ? doc.documentElement.clientHeight : null,
      visual_viewport: visualViewport
        ? {
            width: visualViewport.width,
            height: visualViewport.height,
            scale: visualViewport.scale,
          }
        : null,
      sidebar_width: sidebar ? sidebar.getBoundingClientRect().width : null,
      visibility_state: doc ? doc.visibilityState : null,
    }
  }

  function report(eventName, extra = {}) {
    const payload = { ...snapshot(), ...extra }
    return Promise.resolve(invokeNative('record_webview_diagnostics', { event: eventName, payload })).catch(
      () => null,
    )
  }

  function start() {
    if (started || !win || !doc) return
    started = true
    Promise.resolve(invokeNative('is_window_diagnostics_enabled'))
      .then((enabled) => {
        if (!enabled) return
        win.addEventListener('focus', () => report('Focus'))
        win.addEventListener('blur', () => report('Blur'))
        win.addEventListener('resize', () => report('Resize'))
        doc.addEventListener('visibilitychange', () => report('VisibilityChange'))
        if (win.visualViewport) {
          win.visualViewport.addEventListener('resize', () => report('VisualViewportResize'))
        }
        report('AppStarted')
      })
      .catch(() => null)
  }

  return { start, report, snapshot }
}

const defaultDiagnostics = createWindowLifecycleDiagnostics()
export const startWindowLifecycleDiagnostics = () => defaultDiagnostics.start()
