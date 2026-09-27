import { invoke } from '@tauri-apps/api/core'

export function createWindowScaleGuard({
  invokeNative = invoke,
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  let started = false

  function report() {
    if (!win) return
    Promise.resolve(
      invokeNative('webview_scale_guard', { dpr: win.devicePixelRatio, innerWidth: win.innerWidth }),
    ).catch(() => null)
  }

  function start() {
    if (started || !win || !doc) return
    started = true
    Promise.resolve(invokeNative('is_window_scale_guard_enabled'))
      .then((enabled) => {
        if (!enabled) return
        win.addEventListener('focus', report)
        doc.addEventListener('visibilitychange', () => {
          if (doc.visibilityState === 'visible') report()
        })
      })
      .catch(() => null)
  }

  return { start, report }
}

const defaultGuard = createWindowScaleGuard()
export const startWindowScaleGuard = () => defaultGuard.start()
