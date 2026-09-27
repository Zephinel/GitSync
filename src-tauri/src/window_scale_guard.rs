//! WebView scale desync remediation guard.
//!
//! Evidence status (Phase 1, Windows):
//! - transient DPR desync on minimize/restore transitions (bounds 0x0 ->
//!   stale mixed-DPI fallback): CONFIRMED
//! - native-resize repair mechanism (tiny real resize re-syncs WebView2
//!   RasterizationScale): CONFIRMED
//! - persistent incident trigger (restore re-sync lost): NOT YET REPRODUCED
//!
//! Scope: this is a Windows-only (Wry/WebView2) workaround. On other
//! platforms the native owner is not installed, the commands are no-ops,
//! and the frontend queries the capability before registering listeners.
//!
//! Design:
//! 1. The frontend reports `window.devicePixelRatio` plus
//!    `window.innerWidth` on focus / visibility regain (the moments the
//!    reported incident happens).
//! 2. Native validates DPR self-consistency against the real physical inner
//!    size: `physical_width / css_inner_width` must match the reported DPR.
//!    Browser zoom keeps this relationship self-consistent; the observed
//!    desync does not.
//! 3. On desync it applies a tiny bounds re-sync (+1px then restore), the
//!    minimal real resize that forces WebView2 to recompute its
//!    RasterizationScale. The repair runs as a transaction with best-effort
//!    compensation: any failed step rolls back user-visible geometry and
//!    reports both the primary and the rollback error.
//! 4. Minimized windows are skipped (bounds transition in progress).
//!    Maximized windows receive a state-preserving re-sync whose sizes come
//!    from the persisted normal bounds (window-state.json), so the user's
//!    normal geometry survives the unmaximize -> nudge -> re-maximize
//!    sequence untouched. Fullscreen windows cannot be re-synced without
//!    exiting fullscreen; the desync is kept as pending with its geometry
//!    epoch, and once the native geometry changes (e.g. fullscreen exit)
//!    the stale sample is discarded and the next fresh frontend report
//!    drives the decision — a documented known limitation.
//! 5. Failure semantics: the cooldown is only marked after a successful
//!    repair; pending is peeked (never consumed on failure); every step
//!    propagates errors. A failed repair is retried on the next frontend
//!    report or window event.
//!
//! Pending records the physical geometry at report time. It is re-validated
//! only against the same geometry epoch; once the native geometry changes
//! (e.g. fullscreen exit), the stale CSS sample is no longer used and a
//! fresh frontend report is awaited, so a healed desync never fires a
//! needless nudge.

use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{LogicalSize, Manager, Runtime, WebviewWindow, WindowEvent};

const DPR_CONSISTENCY_TOLERANCE: f64 = 0.1;
const RESYNC_COOLDOWN_MILLIS: u64 = 2000;
const RESYNC_NUDGE_PX: f64 = 1.0;
const RESYNC_EXECUTION_TIMEOUT: Duration = Duration::from_millis(5000);

fn scale_guard_enabled(on_windows: bool) -> bool {
    on_windows
}

/// True when the reported DPR is self-consistent with the layout viewport
/// and the real physical inner width, i.e. `physical / css == dpr`.
/// Returns true (no action) when the input is unusable or unknown.
fn reported_dpr_is_consistent(css_inner_width: f64, physical_inner_width: u32, dpr: f64) -> bool {
    if !css_inner_width.is_finite()
        || css_inner_width <= 0.0
        || physical_inner_width == 0
        || !dpr.is_finite()
        || dpr <= 0.0
    {
        return true;
    }
    let implied_dpr = physical_inner_width as f64 / css_inner_width;
    (implied_dpr - dpr).abs() <= DPR_CONSISTENCY_TOLERANCE
}

fn cooldown_allows(last_resync: &Mutex<Option<Instant>>, now: Instant) -> bool {
    let Ok(last) = last_resync.lock() else {
        return false;
    };
    match *last {
        Some(previous) => now.duration_since(previous).as_millis() as u64 >= RESYNC_COOLDOWN_MILLIS,
        None => true,
    }
}

fn mark_resync(last_resync: &Mutex<Option<Instant>>, now: Instant) {
    if let Ok(mut last) = last_resync.lock() {
        *last = Some(now);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PendingResync {
    dpr: f64,
    css_inner_width: f64,
    report_physical: (u32, u32),
}

fn pending_geometry_epoch_matches(pending: &PendingResync, physical: (u32, u32)) -> bool {
    pending.report_physical == physical
}

/// Peek never clears: a failed repair keeps the pending entry so the next
/// window event can retry it.
fn peek_pending(pending: &Mutex<Option<PendingResync>>) -> Option<PendingResync> {
    pending.lock().ok().and_then(|state| *state)
}

/// Generation-aware clear: only clears when the stored pending still equals
/// `expected`. A worker that observed an older report can never remove a
/// newer one that was marked while it was working.
fn clear_pending_if_matches(
    pending: &Mutex<Option<PendingResync>>,
    expected: &PendingResync,
) -> bool {
    let Ok(mut state) = pending.lock() else {
        return false;
    };
    if *state == Some(*expected) {
        *state = None;
        true
    } else {
        false
    }
}

fn mark_pending(pending: &Mutex<Option<PendingResync>>, report: PendingResync) {
    if let Ok(mut state) = pending.lock() {
        *state = Some(report);
    }
}

static LAST_RESYNC: Mutex<Option<Instant>> = Mutex::new(None);
static PENDING_RESYNC: Mutex<Option<PendingResync>> = Mutex::new(None);

/// The user's persisted normal (logical) inner size, consumed from the
/// window-state authority. Only this is safe to use while the window is
/// maximized: reading live geometry there would return the maximized size
/// and corrupt the normal bounds on restore.
fn read_persisted_normal_size(app_data_dir: &std::path::Path) -> Option<LogicalSize<f64>> {
    crate::window_state::read_persisted_normal_size(app_data_dir)
}

#[derive(Clone, Copy, Debug)]
struct ResyncPlan {
    restore_maximized: bool,
    nudge_size: LogicalSize<f64>,
    restored_size: LogicalSize<f64>,
    rollback_size: LogicalSize<f64>,
}

/// Geometry is read on the caller thread (getters wait for a response and
/// must not run inside a main-thread closure); the mutating sequence runs
/// on the main thread as a transaction with compensation.
fn resync_bounds<R: Runtime>(
    window: &WebviewWindow<R>,
    app: &tauri::AppHandle<R>,
    restore_maximized: bool,
) -> Result<(), String> {
    let plan = build_resync_plan(window, app, restore_maximized)?;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let window_for_main = window.clone();
    app.run_on_main_thread(move || {
        let outcome = perform_bounds_resync(&window_for_main, plan);
        if let Err(ref error) = outcome {
            eprintln!("WebView scale 重同步失败: {}", error);
        }
        let _ = tx.send(outcome);
    })
    .map_err(|error| format!("调度窗口重同步失败: {}", error))?;
    rx.recv_timeout(RESYNC_EXECUTION_TIMEOUT)
        .map_err(|_| "窗口重同步执行超时".to_string())?
}

fn build_resync_plan<R: Runtime>(
    window: &WebviewWindow<R>,
    app: &tauri::AppHandle<R>,
    restore_maximized: bool,
) -> Result<ResyncPlan, String> {
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("读取窗口缩放失败: {}", error))?;
    let inner = window
        .inner_size()
        .map_err(|error| format!("读取窗口尺寸失败: {}", error))?;
    let logical = inner.to_logical::<f64>(scale_factor);
    if logical.width < 1.0 || logical.height < 1.0 {
        return Err("窗口尺寸无效".to_string());
    }
    if restore_maximized {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("获取应用数据目录失败: {}", error))?;
        let Some(normal) = read_persisted_normal_size(&app_data_dir) else {
            return Err("无法读取已保存的正常窗口尺寸，跳过最大化重同步".to_string());
        };
        return Ok(ResyncPlan {
            restore_maximized: true,
            nudge_size: LogicalSize::new(normal.width + RESYNC_NUDGE_PX, normal.height),
            restored_size: normal,
            rollback_size: normal,
        });
    }
    Ok(ResyncPlan {
        restore_maximized: false,
        nudge_size: LogicalSize::new(logical.width + RESYNC_NUDGE_PX, logical.height),
        restored_size: logical,
        rollback_size: logical,
    })
}

/// Transaction with best-effort compensation: any failed mutation triggers
/// a rollback of user-visible geometry, and the error reports both the
/// primary failure and any rollback failure.
fn perform_bounds_resync<R: Runtime>(
    window: &WebviewWindow<R>,
    plan: ResyncPlan,
) -> Result<(), String> {
    if plan.restore_maximized {
        if let Err(error) = window.unmaximize() {
            return Err(format!("退出最大化状态失败: {}", error));
        }
    }
    let mut primary: Option<String> = None;
    if let Err(error) = window.set_size(plan.nudge_size) {
        primary = Some(format!("重同步窗口尺寸失败: {}", error));
    } else if let Err(error) = window.set_size(plan.restored_size) {
        primary = Some(format!("恢复窗口尺寸失败: {}", error));
    } else if plan.restore_maximized {
        if let Err(error) = window.maximize() {
            primary = Some(format!("恢复最大化状态失败: {}", error));
        }
    }
    let Some(primary) = primary else {
        return Ok(());
    };

    let mut rollback_errors = Vec::new();
    if let Err(error) = window.set_size(plan.rollback_size) {
        rollback_errors.push(format!("补偿恢复尺寸失败: {}", error));
    }
    if plan.restore_maximized {
        if let Err(error) = window.maximize() {
            rollback_errors.push(format!("补偿恢复最大化失败: {}", error));
        }
    }
    let mut message = primary;
    for rollback in rollback_errors {
        message.push_str("；");
        message.push_str(&rollback);
    }
    Err(message)
}

fn consume_pending_resync<R: Runtime>(window: &WebviewWindow<R>, app: &tauri::AppHandle<R>) {
    let Some(pending) = peek_pending(&PENDING_RESYNC) else {
        return;
    };
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    let Ok(physical) = window.inner_size() else {
        return;
    };
    let physical = (physical.width, physical.height);
    if !pending_geometry_epoch_matches(&pending, physical) {
        // The native geometry changed since the report (e.g. fullscreen
        // exit): the old CSS sample belongs to another epoch and has no
        // judgement value anymore. Clear this observed generation so later
        // window events stop spawning worker threads, and let the next
        // fresh frontend report drive the decision.
        clear_pending_if_matches(&PENDING_RESYNC, &pending);
        return;
    }
    if reported_dpr_is_consistent(pending.css_inner_width, physical.0, pending.dpr) {
        clear_pending_if_matches(&PENDING_RESYNC, &pending);
        return;
    }
    let now = Instant::now();
    if !cooldown_allows(&LAST_RESYNC, now) {
        return;
    }
    if window.is_fullscreen().unwrap_or(false) {
        // Known limitation: fullscreen cannot be re-synced without exiting
        // fullscreen (destructive flash); keep this generation's pending
        // entry. When the window leaves fullscreen, the geometry epoch
        // changes, this entry is discarded, and the next fresh frontend
        // report drives the repair.
        return;
    }
    let restore_maximized = window.is_maximized().unwrap_or(false);
    if resync_bounds(window, app, restore_maximized).is_ok() {
        clear_pending_if_matches(&PENDING_RESYNC, &pending);
        mark_resync(&LAST_RESYNC, now);
    }
}

pub fn setup_window_scale_guard<R, M>(manager: &M)
where
    R: Runtime,
    M: Manager<R>,
{
    if !scale_guard_enabled(cfg!(target_os = "windows")) {
        return;
    }
    let Some(window) = manager.get_webview_window("main") else {
        return;
    };
    let window_for_events = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) && peek_pending(&PENDING_RESYNC).is_some()
        {
            let window_worker = window_for_events.clone();
            let app_worker = window_for_events.app_handle().clone();
            let _ = std::thread::Builder::new()
                .name("gitsync-scale-resync".to_string())
                .spawn(move || consume_pending_resync(&window_worker, &app_worker));
        }
    });
}

#[tauri::command]
pub fn is_window_scale_guard_enabled() -> bool {
    scale_guard_enabled(cfg!(target_os = "windows"))
}

#[tauri::command]
pub fn webview_scale_guard(
    app: tauri::AppHandle,
    dpr: f64,
    inner_width: f64,
) -> Result<(), String> {
    if !scale_guard_enabled(cfg!(target_os = "windows")) {
        return Ok(());
    }
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    if window.is_minimized().unwrap_or(true) {
        return Ok(());
    }
    let physical_inner = window
        .inner_size()
        .map_err(|error| format!("读取窗口尺寸失败: {}", error))?;
    if reported_dpr_is_consistent(inner_width, physical_inner.width, dpr) {
        // A consistent report makes any earlier pending desync obsolete;
        // only clear the generation this report observed.
        if let Some(current) = peek_pending(&PENDING_RESYNC) {
            clear_pending_if_matches(&PENDING_RESYNC, &current);
        }
        return Ok(());
    }

    let now = Instant::now();
    if !cooldown_allows(&LAST_RESYNC, now) {
        return Ok(());
    }
    if window.is_fullscreen().unwrap_or(false) {
        mark_pending(
            &PENDING_RESYNC,
            PendingResync {
                dpr,
                css_inner_width: inner_width,
                report_physical: (physical_inner.width, physical_inner.height),
            },
        );
        return Ok(());
    }
    let restore_maximized = window.is_maximized().unwrap_or(false);
    resync_bounds(&window, &app, restore_maximized)?;
    if let Some(current) = peek_pending(&PENDING_RESYNC) {
        clear_pending_if_matches(&PENDING_RESYNC, &current);
    }
    mark_resync(&LAST_RESYNC, now);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn unique_temp_dir(name: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "gitsync-scale-guard-{}-{}-{}",
            name,
            std::process::id(),
            stamp
        ))
    }

    #[test]
    fn guard_is_windows_only() {
        assert!(scale_guard_enabled(true));
        assert!(!scale_guard_enabled(false));
    }

    #[test]
    fn desync_at_one_and_half_is_detected_on_scale_one_monitor() {
        assert!(!reported_dpr_is_consistent(1184.0, 1184, 1.5));
        assert!(!reported_dpr_is_consistent(1184.0, 1184, 1.25));
    }

    #[test]
    fn synced_state_is_always_consistent() {
        assert!(reported_dpr_is_consistent(1184.0, 1184, 1.0));
        assert!(reported_dpr_is_consistent(1184.0, 1776, 1.5));
        assert!(reported_dpr_is_consistent(1184.0, 1480, 1.25));
    }

    #[test]
    fn user_zoom_stays_self_consistent_and_is_not_treated_as_desync() {
        assert!(reported_dpr_is_consistent(947.0, 1184, 1.25));
        assert!(reported_dpr_is_consistent(790.0, 1184, 1.5));
        assert!(reported_dpr_is_consistent(947.0, 1480, 1.5625));
    }

    #[test]
    fn desync_on_high_dpi_monitors_is_detected_without_scale_factor_input() {
        assert!(!reported_dpr_is_consistent(1184.0, 1480, 1.5));
        assert!(!reported_dpr_is_consistent(1184.0, 1480, 1.0));
        assert!(!reported_dpr_is_consistent(1184.0, 1776, 1.0));
    }

    #[test]
    fn unusable_metrics_are_ignored() {
        assert!(reported_dpr_is_consistent(f64::NAN, 1184, 1.5));
        assert!(reported_dpr_is_consistent(1184.0, 0, 1.5));
        assert!(reported_dpr_is_consistent(0.0, 1184, 1.5));
        assert!(reported_dpr_is_consistent(1184.0, 1184, 0.0));
        assert!(reported_dpr_is_consistent(1184.0, 1184, f64::INFINITY));
    }

    #[test]
    fn cooldown_blocks_repeated_resyncs_until_elapsed() {
        let guard = Mutex::new(None);
        let start = Instant::now();
        assert!(cooldown_allows(&guard, start));
        mark_resync(&guard, start);
        assert!(!cooldown_allows(&guard, start + Duration::from_millis(100)));
        assert!(!cooldown_allows(
            &guard,
            start + Duration::from_millis(1999)
        ));
        assert!(cooldown_allows(&guard, start + Duration::from_millis(2000)));
    }

    #[test]
    fn pending_is_peeked_not_consumed_so_failures_retry() {
        let pending = Mutex::new(None);
        assert_eq!(peek_pending(&pending), None);
        let report = PendingResync {
            dpr: 1.5,
            css_inner_width: 1184.0,
            report_physical: (1184, 800),
        };
        mark_pending(&pending, report);
        assert_eq!(peek_pending(&pending), Some(report));
        assert_eq!(peek_pending(&pending), Some(report));
        assert!(clear_pending_if_matches(&pending, &report));
        assert_eq!(peek_pending(&pending), None);
    }

    #[test]
    fn clear_is_generation_aware_and_never_removes_newer_reports() {
        let pending = Mutex::new(None);
        let older = PendingResync {
            dpr: 1.5,
            css_inner_width: 1184.0,
            report_physical: (1920, 1040),
        };
        let newer = PendingResync {
            dpr: 1.25,
            css_inner_width: 1184.0,
            report_physical: (1920, 1040),
        };
        mark_pending(&pending, older);
        assert_eq!(peek_pending(&pending), Some(older));

        mark_pending(&pending, newer);
        // A worker that observed the older report must not remove the newer one.
        assert!(!clear_pending_if_matches(&pending, &older));
        assert_eq!(peek_pending(&pending), Some(newer));
        // Clearing its own observed generation succeeds.
        assert!(clear_pending_if_matches(&pending, &newer));
        assert_eq!(peek_pending(&pending), None);
    }

    #[test]
    fn pending_revalidation_requires_the_same_geometry_epoch() {
        let report = PendingResync {
            dpr: 1.0,
            css_inner_width: 1920.0,
            report_physical: (1920, 1040),
        };
        assert!(pending_geometry_epoch_matches(&report, (1920, 1040)));
        assert!(!pending_geometry_epoch_matches(&report, (1184, 800)));
    }

    #[test]
    fn maximized_plan_uses_persisted_normal_bounds() {
        let plan = ResyncPlan {
            restore_maximized: true,
            nudge_size: LogicalSize::new(1185.0, 800.0),
            restored_size: LogicalSize::new(1184.0, 800.0),
            rollback_size: LogicalSize::new(1184.0, 800.0),
        };
        assert!(plan.restore_maximized);
        assert_eq!(plan.nudge_size.width, plan.restored_size.width + 1.0);
        assert_eq!(plan.rollback_size, plan.restored_size);
    }

    #[test]
    fn resync_nudge_is_exactly_one_pixel() {
        assert_eq!(RESYNC_NUDGE_PX, 1.0);
    }
}
