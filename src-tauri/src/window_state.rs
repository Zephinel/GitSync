use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "windows"))]
use tauri::LogicalPosition;
#[cfg(target_os = "windows")]
use tauri::PhysicalPosition;
use tauri::{LogicalSize, Manager, Monitor, Runtime, WebviewWindow, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";
const WINDOW_STATE_FILE_NAME: &str = "window-state.json";
/// Current schema version. On Windows this is v3: `normal.x/y` are PHYSICAL
/// global virtual-desktop pixels (the Windows position authority). On
/// macOS/Linux it stays v2: `normal.x/y` are LOGICAL under the window's
/// scale factor (the pre-existing, platform-verified contract). The
/// platform position contract must never leak across platforms.
const WINDOW_STATE_VERSION: u32 = if cfg!(target_os = "windows") { 3 } else { 2 };
/// Historical schema (v2, Windows-only migration source): `normal.x/y` were
/// logical under the save-time window scale factor, whose value was not
/// recorded.
#[cfg(target_os = "windows")]
const LEGACY_WINDOW_STATE_VERSION: u32 = 2;
/// Transient schema written by commit 0ba6ac8 on ALL platforms before the
/// physical position contract was confined to Windows. macOS/Linux users
/// who ran that intermediate build may still have a v3 file.
#[cfg(not(target_os = "windows"))]
const TRANSIENT_V3_STATE_VERSION: u32 = 3;
const MIN_WINDOW_WIDTH: u32 = 900;
const MIN_WINDOW_HEIGHT: u32 = 600;
const MAX_WINDOW_WIDTH: u32 = 10000;
const MAX_WINDOW_HEIGHT: u32 = 10000;
const DEFAULT_WINDOW_WIDTH: u32 = 1200;
const DEFAULT_WINDOW_HEIGHT: u32 = 800;
const WORK_AREA_MARGIN: f64 = 0.0;
const NEAR_MAXIMIZED_WIDTH_RATIO: f64 = 0.95;
const NEAR_MAXIMIZED_HEIGHT_RATIO: f64 = 0.94;
const NEAR_MAXIMIZED_EDGE_TOLERANCE: f64 = 48.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct WindowSizeState {
    width: u32,
    height: u32,
}

/// Platform current normal bounds.
/// Windows v3: `x/y` are physical global virtual-desktop pixels,
/// `width/height` are logical.
/// macOS/Linux v2: `x/y` and `width/height` are logical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct WindowBoundsState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct WindowState {
    version: u32,
    normal: WindowBoundsState,
    maximized: bool,
    fullscreen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LoadedWindowState {
    state: WindowState,
    has_trusted_position: bool,
}

/// Restore work area in the platform's persisted position space.
///
/// Windows (v3): physical monitor work area plus its scale factor.
/// macOS/Linux (v2): logical work area converted with the monitor's own
/// scale factor.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq)]
struct RestoreWorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
}

#[cfg(not(target_os = "windows"))]
#[derive(Debug, Clone, Copy, PartialEq)]
struct RestoreWorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PersistedWindowState {
    Current(WindowState),
    Legacy(WindowSizeState),
}

pub fn setup_main_window_state<R, M>(manager: &M, app_data_dir: &Path)
where
    R: Runtime,
    M: Manager<R>,
{
    let state_path = window_state_path(app_data_dir);
    let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let restored = restore_window_state(&window, &state_path);
    let initial_state = restored
        .map(|loaded| loaded.state)
        .or_else(|| capture_normal_window_bounds(&window).map(default_window_state))
        .unwrap_or_else(|| default_window_state(default_window_bounds()));
    let shared_state = Arc::new(Mutex::new(initial_state));

    let save_path = state_path.clone();
    let window_for_events = window.clone();
    let state_for_events = Arc::clone(&shared_state);
    window.on_window_event(move |event| {
        let trigger = match event {
            WindowEvent::Resized(_) => "Resized",
            WindowEvent::Moved(_) => "Moved",
            WindowEvent::CloseRequested { .. } => "CloseRequested",
            _ => return,
        };
        save_observed_window_state(&save_path, &window_for_events, &state_for_events, trigger);
    });
}

fn window_state_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(WINDOW_STATE_FILE_NAME)
}

/// Persisted normal (logical) inner size, validated through the
/// authoritative reader (version check, legacy migration, normalization).
/// Consumed by the window scale guard so the window-state schema stays
/// owned by this module alone.
pub(crate) fn read_persisted_normal_size(app_data_dir: &Path) -> Option<LogicalSize<f64>> {
    let loaded = read_window_state(&window_state_path(app_data_dir))?;
    let normal = loaded.state.normal;
    Some(LogicalSize::new(normal.width as f64, normal.height as f64))
}

/// Diagnostic-only snapshot of the persisted window state, read through the
/// authoritative reader. Consumed by the lifecycle diagnostics module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PersistedWindowSnapshot {
    pub version: u32,
    pub normal_x: i32,
    pub normal_y: i32,
    pub normal_width: u32,
    pub normal_height: u32,
    pub maximized: bool,
    pub fullscreen: bool,
}

pub(crate) fn read_persisted_window_snapshot(
    app_data_dir: &Path,
) -> Option<PersistedWindowSnapshot> {
    let loaded = read_window_state(&window_state_path(app_data_dir))?;
    let normal = loaded.state.normal;
    Some(PersistedWindowSnapshot {
        version: loaded.state.version,
        normal_x: normal.x,
        normal_y: normal.y,
        normal_width: normal.width,
        normal_height: normal.height,
        maximized: loaded.state.maximized,
        fullscreen: loaded.state.fullscreen,
    })
}

/// Diagnostic-only observation emitted after every window-state save.
/// Does not influence the save result; it only reports what happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowStateObservation {
    pub trigger: &'static str,
    pub previous_normal_x: i32,
    pub previous_normal_y: i32,
    pub previous_normal_width: u32,
    pub previous_normal_height: u32,
    pub captured_normal_x: Option<i32>,
    pub captured_normal_y: Option<i32>,
    pub captured_normal_width: Option<u32>,
    pub captured_normal_height: Option<u32>,
    pub next_normal_x: i32,
    pub next_normal_y: i32,
    pub next_normal_width: u32,
    pub next_normal_height: u32,
    pub persisted: bool,
}

pub(crate) type WindowStateObserver = Box<dyn Fn(WindowStateObservation) + Send + 'static>;

static WINDOW_STATE_OBSERVER: Mutex<Option<WindowStateObserver>> = Mutex::new(None);
static WINDOW_STATE_OBSERVER_SET: AtomicBool = AtomicBool::new(false);

/// Registers a diagnostic observer. Diagnostic-only; the observer must not
/// mutate window state.
pub(crate) fn set_window_state_observer(observer: WindowStateObserver) {
    if let Ok(mut slot) = WINDOW_STATE_OBSERVER.lock() {
        *slot = Some(observer);
        WINDOW_STATE_OBSERVER_SET.store(true, Ordering::Relaxed);
    }
}

/// Cheap guard so ordinary production (no observer) never pays for
/// observation construction.
fn has_window_state_observer() -> bool {
    WINDOW_STATE_OBSERVER_SET.load(Ordering::Relaxed)
}

fn notify_window_state_observation(observation: WindowStateObservation) {
    let Ok(slot) = WINDOW_STATE_OBSERVER.lock() else {
        return;
    };
    if let Some(observer) = slot.as_ref() {
        observer(observation);
    }
}

fn default_window_bounds() -> WindowBoundsState {
    WindowBoundsState {
        x: 0,
        y: 0,
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
    }
}

fn default_window_state(normal: WindowBoundsState) -> WindowState {
    WindowState {
        version: WINDOW_STATE_VERSION,
        normal,
        maximized: false,
        fullscreen: false,
    }
}

fn restore_window_state<R: Runtime>(
    window: &WebviewWindow<R>,
    state_path: &Path,
) -> Option<LoadedWindowState> {
    let loaded = read_window_state(state_path)?;
    let work_area = restore_work_area(window, loaded.state.normal);
    let normal = work_area
        .map(|area| {
            constrain_window_bounds(loaded.state.normal, &area, loaded.has_trusted_position)
        })
        .unwrap_or(loaded.state.normal);
    let restore_maximized = !loaded.state.fullscreen
        && (loaded.state.maximized
            || work_area
                .map(|area| should_restore_maximized(normal, &area, loaded.has_trusted_position))
                .unwrap_or(false));

    if let Err(error) = window.set_size(LogicalSize::new(normal.width as f64, normal.height as f64))
    {
        eprintln!("恢复窗口尺寸失败: {}", error);
    }

    if work_area.is_some() {
        #[cfg(target_os = "windows")]
        let position_result = window.set_position(PhysicalPosition::new(normal.x, normal.y));
        #[cfg(not(target_os = "windows"))]
        let position_result =
            window.set_position(LogicalPosition::new(normal.x as f64, normal.y as f64));
        if let Err(error) = position_result {
            eprintln!("恢复窗口位置失败: {}", error);
        }
    } else if !loaded.has_trusted_position {
        if let Err(error) = window.center() {
            eprintln!("居中窗口失败: {}", error);
        }
    }

    if loaded.state.fullscreen {
        if let Err(error) = window.set_fullscreen(true) {
            eprintln!("恢复窗口全屏状态失败: {}", error);
        }
    } else if restore_maximized {
        if let Err(error) = window.maximize() {
            eprintln!("恢复窗口最大化状态失败: {}", error);
        }
    }

    Some(LoadedWindowState {
        state: WindowState {
            version: WINDOW_STATE_VERSION,
            normal,
            maximized: restore_maximized,
            fullscreen: loaded.state.fullscreen,
        },
        has_trusted_position: true,
    })
}

/// A genuine window move preserves the window size; a maximize/fullscreen
/// transition changes it. Tao emits WM_MOVE before WM_SIZE/SIZE_MAXIMIZED,
/// so a Moved event can still report the OLD maximized flag while carrying
/// the NEW maximized geometry. Accepting such a capture would replace the
/// user's normal bounds with the maximized geometry. Tolerance covers
/// rounding in logical conversions.
fn size_matches_previous(captured: WindowBoundsState, previous: WindowBoundsState) -> bool {
    const SIZE_TOLERANCE: u32 = 2;
    captured.width.abs_diff(previous.width) <= SIZE_TOLERANCE
        && captured.height.abs_diff(previous.height) <= SIZE_TOLERANCE
}

fn save_observed_window_state<R: Runtime>(
    state_path: &Path,
    window: &WebviewWindow<R>,
    shared_state: &Arc<Mutex<WindowState>>,
    trigger: &'static str,
) {
    let (previous, fullscreen, maximized) = {
        let Ok(state) = shared_state.lock() else {
            eprintln!("窗口状态锁已损坏，跳过本次保存。");
            return;
        };
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let maximized = !fullscreen && window.is_maximized().unwrap_or(false);
        (*state, fullscreen, maximized)
    };
    let normal_bounds = if fullscreen || maximized {
        None
    } else {
        let captured = capture_normal_window_bounds(window);
        if trigger == "Moved" {
            match captured {
                Some(bounds) if size_matches_previous(bounds, previous.normal) => Some(bounds),
                // Maximize/fullscreen transition in flight: the Moved event
                // carries the new geometry while the maximized flag is not
                // yet visible. Keep the previous normal bounds instead.
                _ => None,
            }
        } else {
            captured
        }
    };

    let (state, previous) = {
        let Ok(mut state) = shared_state.lock() else {
            eprintln!("窗口状态锁已损坏，跳过本次保存。");
            return;
        };
        let previous = *state;
        let next = merge_window_observation(*state, normal_bounds, maximized, fullscreen);
        *state = next;
        (next, previous)
    };

    let write_result = write_window_state(state_path, state);
    if let Err(error) = &write_result {
        eprintln!("保存窗口状态失败: {}", error);
    }

    if has_window_state_observer() {
        let observation = WindowStateObservation {
            trigger,
            previous_normal_x: previous.normal.x,
            previous_normal_y: previous.normal.y,
            previous_normal_width: previous.normal.width,
            previous_normal_height: previous.normal.height,
            captured_normal_x: normal_bounds.map(|bounds| bounds.x),
            captured_normal_y: normal_bounds.map(|bounds| bounds.y),
            captured_normal_width: normal_bounds.map(|bounds| bounds.width),
            captured_normal_height: normal_bounds.map(|bounds| bounds.height),
            next_normal_x: state.normal.x,
            next_normal_y: state.normal.y,
            next_normal_width: state.normal.width,
            next_normal_height: state.normal.height,
            persisted: write_result.is_ok(),
        };
        notify_window_state_observation(observation);
    }
}

/// Captures the current normal bounds under the platform position contract.
///
/// Windows (v3): position is PHYSICAL (stored verbatim, never
/// DPI-converted, so a Moved event with a stale window scale factor can
/// never produce an incoherent position); size is LOGICAL.
///
/// macOS/Linux (v2): position and size are both LOGICAL (physical
/// values converted with the current window scale factor).
#[cfg(target_os = "windows")]
fn capture_normal_window_bounds<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Option<WindowBoundsState> {
    let scale_factor = window.scale_factor().ok()?;
    let physical_position = window.outer_position().ok()?;
    let physical_size = window.inner_size().ok()?;
    let logical_size = physical_size.to_logical::<f64>(scale_factor);
    normalize_observed_window_bounds(
        physical_position.x as f64,
        physical_position.y as f64,
        logical_size.width,
        logical_size.height,
    )
}

#[cfg(not(target_os = "windows"))]
fn capture_normal_window_bounds<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Option<WindowBoundsState> {
    let scale_factor = window.scale_factor().ok()?;
    let physical_position = window.outer_position().ok()?;
    let physical_size = window.inner_size().ok()?;
    let logical_position = physical_position.to_logical::<f64>(scale_factor);
    let logical_size = physical_size.to_logical::<f64>(scale_factor);
    normalize_observed_window_bounds(
        logical_position.x,
        logical_position.y,
        logical_size.width,
        logical_size.height,
    )
}

fn merge_window_observation(
    previous: WindowState,
    normal_bounds: Option<WindowBoundsState>,
    maximized: bool,
    fullscreen: bool,
) -> WindowState {
    WindowState {
        version: WINDOW_STATE_VERSION,
        normal: normal_bounds.unwrap_or(previous.normal),
        maximized: !fullscreen && maximized,
        fullscreen,
    }
}

/// Selects the work area whose bounds contain the persisted position,
/// falling back to current monitor then primary monitor.
#[cfg(target_os = "windows")]
fn restore_work_area<R: Runtime>(
    window: &WebviewWindow<R>,
    bounds: WindowBoundsState,
) -> Option<RestoreWorkArea> {
    let available = window.available_monitors().unwrap_or_default();

    available
        .iter()
        .map(monitor_work_area)
        .find(|area| {
            let physical_width = bounds.width as f64 * area.scale_factor;
            let physical_height = bounds.height as f64 * area.scale_factor;
            let center_x = bounds.x as f64 + physical_width / 2.0;
            let center_y = bounds.y as f64 + physical_height / 2.0;
            point_is_inside_work_area(center_x, center_y, *area)
        })
        .or_else(|| {
            window
                .current_monitor()
                .ok()
                .flatten()
                .as_ref()
                .map(monitor_work_area)
        })
        .or_else(|| {
            window
                .primary_monitor()
                .ok()
                .flatten()
                .as_ref()
                .map(monitor_work_area)
        })
}

#[cfg(not(target_os = "windows"))]
fn restore_work_area<R: Runtime>(
    window: &WebviewWindow<R>,
    bounds: WindowBoundsState,
) -> Option<RestoreWorkArea> {
    let available = window.available_monitors().unwrap_or_default();
    let center_x = bounds.x as f64 + bounds.width as f64 / 2.0;
    let center_y = bounds.y as f64 + bounds.height as f64 / 2.0;

    available
        .iter()
        .map(monitor_work_area)
        .find(|area| point_is_inside_work_area(center_x, center_y, *area))
        .or_else(|| {
            window
                .current_monitor()
                .ok()
                .flatten()
                .as_ref()
                .map(monitor_work_area)
        })
        .or_else(|| {
            window
                .primary_monitor()
                .ok()
                .flatten()
                .as_ref()
                .map(monitor_work_area)
        })
}

#[cfg(target_os = "windows")]
fn monitor_work_area(monitor: &Monitor) -> RestoreWorkArea {
    let work_area = monitor.work_area();
    RestoreWorkArea {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
        scale_factor: monitor.scale_factor(),
    }
}

#[cfg(not(target_os = "windows"))]
fn monitor_work_area(monitor: &Monitor) -> RestoreWorkArea {
    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    let position = work_area.position.to_logical::<f64>(scale_factor);
    let size = work_area.size.to_logical::<f64>(scale_factor);
    RestoreWorkArea {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

#[cfg(target_os = "windows")]
fn point_is_inside_work_area(x: f64, y: f64, area: RestoreWorkArea) -> bool {
    x >= area.x as f64
        && x < area.x as f64 + area.width as f64
        && y >= area.y as f64
        && y < area.y as f64 + area.height as f64
}

#[cfg(not(target_os = "windows"))]
fn point_is_inside_work_area(x: f64, y: f64, area: RestoreWorkArea) -> bool {
    x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height
}

#[cfg(target_os = "windows")]
fn should_restore_maximized(
    bounds: WindowBoundsState,
    area: &RestoreWorkArea,
    has_trusted_position: bool,
) -> bool {
    let area_width_logical = area.width as f64 / area.scale_factor;
    let area_height_logical = area.height as f64 / area.scale_factor;
    if area_width_logical <= 0.0 || area_height_logical <= 0.0 {
        return false;
    }
    let width_ratio = bounds.width as f64 / area_width_logical;
    let height_ratio = bounds.height as f64 / area_height_logical;
    if width_ratio < NEAR_MAXIMIZED_WIDTH_RATIO || height_ratio < NEAR_MAXIMIZED_HEIGHT_RATIO {
        return false;
    }
    if !has_trusted_position {
        return true;
    }
    // Edge gap is physical; the tolerance is defined in logical pixels, so
    // convert the gap back through the monitor scale factor.
    let left_gap = (bounds.x as f64 - area.x as f64).abs() / area.scale_factor;
    let top_gap = (bounds.y as f64 - area.y as f64).abs() / area.scale_factor;
    left_gap <= NEAR_MAXIMIZED_EDGE_TOLERANCE && top_gap <= NEAR_MAXIMIZED_EDGE_TOLERANCE
}

#[cfg(not(target_os = "windows"))]
fn should_restore_maximized(
    bounds: WindowBoundsState,
    area: &RestoreWorkArea,
    has_trusted_position: bool,
) -> bool {
    if area.width <= 0.0 || area.height <= 0.0 {
        return false;
    }
    let width_ratio = bounds.width as f64 / area.width;
    let height_ratio = bounds.height as f64 / area.height;
    if width_ratio < NEAR_MAXIMIZED_WIDTH_RATIO || height_ratio < NEAR_MAXIMIZED_HEIGHT_RATIO {
        return false;
    }
    if !has_trusted_position {
        return true;
    }
    let left_gap = (bounds.x as f64 - area.x).abs();
    let top_gap = (bounds.y as f64 - area.y).abs();
    left_gap <= NEAR_MAXIMIZED_EDGE_TOLERANCE && top_gap <= NEAR_MAXIMIZED_EDGE_TOLERANCE
}

/// Constrains the persisted bounds into the work area in the platform's
/// persisted position space.
#[cfg(target_os = "windows")]
fn constrain_window_bounds(
    bounds: WindowBoundsState,
    area: &RestoreWorkArea,
    has_trusted_position: bool,
) -> WindowBoundsState {
    let area_width_logical = area.width as f64 / area.scale_factor;
    let area_height_logical = area.height as f64 / area.scale_factor;
    let maximum_width = (area_width_logical - WORK_AREA_MARGIN * 2.0).max(1.0);
    let maximum_height = (area_height_logical - WORK_AREA_MARGIN * 2.0).max(1.0);
    let minimum_width = (MIN_WINDOW_WIDTH as f64).min(maximum_width);
    let minimum_height = (MIN_WINDOW_HEIGHT as f64).min(maximum_height);
    let width = (bounds.width as f64).clamp(minimum_width, maximum_width);
    let height = (bounds.height as f64).clamp(minimum_height, maximum_height);

    let physical_width = width * area.scale_factor;
    let physical_height = height * area.scale_factor;
    let minimum_x = area.x as f64 + WORK_AREA_MARGIN;
    let minimum_y = area.y as f64 + WORK_AREA_MARGIN;
    let maximum_x = area.x as f64 + area.width as f64 - WORK_AREA_MARGIN - physical_width;
    let maximum_y = area.y as f64 + area.height as f64 - WORK_AREA_MARGIN - physical_height;

    let (x, y) = if has_trusted_position {
        (
            (bounds.x as f64).clamp(minimum_x, maximum_x.max(minimum_x)),
            (bounds.y as f64).clamp(minimum_y, maximum_y.max(minimum_y)),
        )
    } else {
        (
            area.x as f64 + (area.width as f64 - physical_width) / 2.0,
            area.y as f64 + (area.height as f64 - physical_height) / 2.0,
        )
    };

    WindowBoundsState {
        x: round_position(x),
        y: round_position(y),
        width: width.round() as u32,
        height: height.round() as u32,
    }
}

#[cfg(not(target_os = "windows"))]
fn constrain_window_bounds(
    bounds: WindowBoundsState,
    area: &RestoreWorkArea,
    has_trusted_position: bool,
) -> WindowBoundsState {
    let maximum_width = (area.width - WORK_AREA_MARGIN * 2.0).max(1.0);
    let maximum_height = (area.height - WORK_AREA_MARGIN * 2.0).max(1.0);
    let minimum_width = (MIN_WINDOW_WIDTH as f64).min(maximum_width);
    let minimum_height = (MIN_WINDOW_HEIGHT as f64).min(maximum_height);
    let width = (bounds.width as f64).clamp(minimum_width, maximum_width);
    let height = (bounds.height as f64).clamp(minimum_height, maximum_height);
    let minimum_x = area.x + WORK_AREA_MARGIN;
    let minimum_y = area.y + WORK_AREA_MARGIN;
    let maximum_x = area.x + area.width - WORK_AREA_MARGIN - width;
    let maximum_y = area.y + area.height - WORK_AREA_MARGIN - height;

    let (x, y) = if has_trusted_position {
        (
            (bounds.x as f64).clamp(minimum_x, maximum_x.max(minimum_x)),
            (bounds.y as f64).clamp(minimum_y, maximum_y.max(minimum_y)),
        )
    } else {
        (
            area.x + (area.width - width) / 2.0,
            area.y + (area.height - height) / 2.0,
        )
    };

    WindowBoundsState {
        x: round_position(x),
        y: round_position(y),
        width: width.round() as u32,
        height: height.round() as u32,
    }
}

fn round_position(value: f64) -> i32 {
    value.round().clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

fn normalize_window_size(width: f64, height: f64) -> Option<WindowSizeState> {
    if !width.is_finite() || !height.is_finite() {
        return None;
    }

    Some(WindowSizeState {
        width: (width.round() as u32).clamp(MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
        height: (height.round() as u32).clamp(MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT),
    })
}

fn normalize_window_bounds(x: f64, y: f64, width: f64, height: f64) -> Option<WindowBoundsState> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let size = normalize_window_size(width, height)?;
    Some(WindowBoundsState {
        x: round_position(x),
        y: round_position(y),
        width: size.width,
        height: size.height,
    })
}

fn normalize_observed_window_bounds(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Option<WindowBoundsState> {
    if width < MIN_WINDOW_WIDTH as f64 || height < MIN_WINDOW_HEIGHT as f64 {
        return None;
    }
    normalize_window_bounds(x, y, width, height)
}

/// Migration for a transiently-written v3 state on a platform whose current
/// contract is not physical. Size and flags migrate unchanged; the physical
/// x/y cannot be converted back to logical (the save-time monitor scale is
/// unrecorded), so the position is dropped (untrusted -> centered on
/// restore) and the next save writes the platform's native schema.
/// Mirrors the Windows v2 -> v3 position policy.
///
/// Only macOS/Linux invoke this at runtime (Windows treats v3 as its
/// current contract); the function stays compiled on Windows so the shared
/// migration test can run on every platform.
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn migrate_foreign_v3_state(state: WindowState) -> Option<LoadedWindowState> {
    let size = normalize_window_size(state.normal.width as f64, state.normal.height as f64)?;
    Some(LoadedWindowState {
        state: WindowState {
            version: WINDOW_STATE_VERSION,
            normal: WindowBoundsState {
                x: 0,
                y: 0,
                width: size.width,
                height: size.height,
            },
            maximized: state.maximized,
            fullscreen: state.fullscreen,
        },
        has_trusted_position: false,
    })
}

fn read_window_state(state_path: &Path) -> Option<LoadedWindowState> {
    let content = std::fs::read_to_string(state_path).ok()?;
    match serde_json::from_str::<PersistedWindowState>(&content).ok()? {
        PersistedWindowState::Current(state) if state.version == WINDOW_STATE_VERSION => {
            // Current schema: Windows v3 (x/y physical, width/height
            // logical) and macOS/Linux v2 (all logical) share the same
            // normalization: position is rounded, size is clamped.
            let normal = normalize_window_bounds(
                state.normal.x as f64,
                state.normal.y as f64,
                state.normal.width as f64,
                state.normal.height as f64,
            )?;
            Some(LoadedWindowState {
                state: WindowState { normal, ..state },
                has_trusted_position: true,
            })
        }
        #[cfg(target_os = "windows")]
        PersistedWindowState::Current(state) if state.version == LEGACY_WINDOW_STATE_VERSION => {
            // v2 (Windows): x/y were logical under the save-time window
            // scale factor, whose value is not recorded. They cannot be
            // safely reinterpreted as physical, so the position is dropped
            // (untrusted -> centered on restore) while size, maximized and
            // fullscreen migrate unchanged.
            let size =
                normalize_window_size(state.normal.width as f64, state.normal.height as f64)?;
            Some(LoadedWindowState {
                state: WindowState {
                    version: WINDOW_STATE_VERSION,
                    normal: WindowBoundsState {
                        x: 0,
                        y: 0,
                        width: size.width,
                        height: size.height,
                    },
                    maximized: state.maximized,
                    fullscreen: state.fullscreen,
                },
                has_trusted_position: false,
            })
        }
        #[cfg(not(target_os = "windows"))]
        PersistedWindowState::Current(state) if state.version == TRANSIENT_V3_STATE_VERSION => {
            // Transient v3 written by commit 0ba6ac8 on all platforms.
            migrate_foreign_v3_state(state)
        }
        PersistedWindowState::Legacy(size) => {
            let size = normalize_window_size(size.width as f64, size.height as f64)?;
            Some(LoadedWindowState {
                state: default_window_state(WindowBoundsState {
                    x: 0,
                    y: 0,
                    width: size.width,
                    height: size.height,
                }),
                has_trusted_position: false,
            })
        }
        PersistedWindowState::Current(_) => None,
    }
}

fn write_window_state(state_path: &Path, state: WindowState) -> Result<(), String> {
    if let Some(parent) = state_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建窗口状态目录 {} 失败: {}", parent.display(), error))?;
    }

    let json = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("序列化窗口状态失败: {}", error))?;
    let tmp_path = window_state_tmp_path(state_path);

    {
        let mut file = std::fs::File::create(&tmp_path).map_err(|error| {
            format!(
                "创建临时窗口状态文件 {} 失败: {}",
                tmp_path.display(),
                error
            )
        })?;
        file.write_all(json.as_bytes()).map_err(|error| {
            format!(
                "写入临时窗口状态文件 {} 失败: {}",
                tmp_path.display(),
                error
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "同步临时窗口状态文件 {} 失败: {}",
                tmp_path.display(),
                error
            )
        })?;
    }

    #[cfg(target_os = "windows")]
    {
        let backup_path = window_state_backup_path(state_path);
        let had_previous = state_path.exists();
        if had_previous {
            if backup_path.exists() {
                std::fs::remove_file(&backup_path).map_err(|error| {
                    format!(
                        "清理旧窗口状态备份 {} 失败: {}",
                        backup_path.display(),
                        error
                    )
                })?;
            }
            std::fs::rename(state_path, &backup_path).map_err(|error| {
                format!("备份窗口状态文件 {} 失败: {}", state_path.display(), error)
            })?;
        }
        if let Err(error) = std::fs::rename(&tmp_path, state_path) {
            if had_previous {
                let _ = std::fs::rename(&backup_path, state_path);
            }
            return Err(format!(
                "更新窗口状态文件 {} 失败: {}",
                state_path.display(),
                error
            ));
        }
        if backup_path.exists() {
            let _ = std::fs::remove_file(&backup_path);
        }
    }

    #[cfg(not(target_os = "windows"))]
    std::fs::rename(&tmp_path, state_path)
        .map_err(|error| format!("更新窗口状态文件 {} 失败: {}", state_path.display(), error))?;

    if let Some(parent) = state_path.parent() {
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn window_state_tmp_path(state_path: &Path) -> PathBuf {
    window_state_sibling_path(state_path, "tmp")
}

#[cfg(target_os = "windows")]
fn window_state_backup_path(state_path: &Path) -> PathBuf {
    window_state_sibling_path(state_path, "bak")
}

fn window_state_sibling_path(state_path: &Path, suffix: &str) -> PathBuf {
    let file_name = state_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(WINDOW_STATE_FILE_NAME);
    state_path.with_file_name(format!("{}.{}", file_name, suffix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "gitsync-window-state-{}-{}-{}",
            name,
            std::process::id(),
            stamp
        ))
    }

    fn normal_state(bounds: WindowBoundsState) -> WindowState {
        default_window_state(bounds)
    }

    // ================= platform-specific helpers =================

    #[cfg(target_os = "windows")]
    fn work_area() -> RestoreWorkArea {
        RestoreWorkArea {
            x: 0,
            y: 25,
            width: 1920,
            height: 1050,
            scale_factor: 1.0,
        }
    }

    #[cfg(target_os = "windows")]
    fn high_dpi_work_area() -> RestoreWorkArea {
        RestoreWorkArea {
            x: -3840,
            y: -370,
            width: 3840,
            height: 2114,
            scale_factor: 1.5,
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn work_area() -> RestoreWorkArea {
        RestoreWorkArea {
            x: 0.0,
            y: 25.0,
            width: 1728.0,
            height: 1055.0,
        }
    }

    #[test]
    fn normalize_window_bounds_rejects_non_finite_values() {
        assert_eq!(normalize_window_bounds(f64::NAN, 0.0, 1200.0, 800.0), None);
        assert_eq!(
            normalize_window_bounds(0.0, f64::INFINITY, 1200.0, 800.0),
            None
        );
    }

    #[test]
    fn normalize_observed_window_bounds_ignores_transient_small_sizes() {
        assert_eq!(
            normalize_observed_window_bounds(0.0, 0.0, 899.0, 700.0),
            None
        );
        assert_eq!(
            normalize_observed_window_bounds(-2400.0, 800.0, 901.0, 601.0),
            Some(WindowBoundsState {
                x: -2400,
                y: 800,
                width: 901,
                height: 601,
            })
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn oversized_legacy_bounds_fill_the_available_work_area_without_artificial_gaps() {
        let constrained = constrain_window_bounds(
            WindowBoundsState {
                x: 0,
                y: 0,
                width: 2200,
                height: 1400,
            },
            &work_area(),
            false,
        );

        assert_eq!(constrained.width, 1920);
        assert_eq!(constrained.height, 1050);
        assert_eq!(constrained.x, 0);
        assert_eq!(constrained.y, 25);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn offscreen_physical_position_is_pulled_back_inside_the_saved_monitor() {
        let constrained = constrain_window_bounds(
            WindowBoundsState {
                x: 1400,
                y: 900,
                width: 1200,
                height: 800,
            },
            &work_area(),
            true,
        );

        assert_eq!(constrained.x, 720);
        assert_eq!(constrained.y, 275);
        assert_eq!(constrained.width, 1200);
        assert_eq!(constrained.height, 800);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn high_dpi_monitor_constrains_physical_position_against_physical_work_area() {
        let constrained = constrain_window_bounds(
            WindowBoundsState {
                x: -4200,
                y: 1200,
                width: 1184,
                height: 800,
            },
            &high_dpi_work_area(),
            true,
        );

        assert_eq!(constrained.width, 1184);
        assert_eq!(constrained.height, 800);
        assert!(constrained.x >= -3840);
        assert!(constrained.x + 1776 <= -3840 + 3840);
        assert!(constrained.y <= -370 + 2114 - 1200);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn high_dpi_untrusted_position_centers_in_physical_work_area() {
        let constrained = constrain_window_bounds(
            WindowBoundsState {
                x: 0,
                y: 0,
                width: 1184,
                height: 800,
            },
            &high_dpi_work_area(),
            false,
        );

        let expected_x = -3840 + (3840 - 1776) / 2;
        let expected_y = -370 + (2114 - 1200) / 2;
        assert_eq!(constrained.x, expected_x);
        assert_eq!(constrained.y, expected_y);
        assert_eq!(constrained.width, 1184);
        assert_eq!(constrained.height, 800);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn legacy_near_full_size_is_inferred_as_maximized() {
        assert!(should_restore_maximized(
            WindowBoundsState {
                x: 0,
                y: 0,
                width: 1840,
                height: 1010,
            },
            &work_area(),
            false,
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn trusted_near_full_bounds_are_inferred_as_maximized_only_near_work_area_edges() {
        assert!(should_restore_maximized(
            WindowBoundsState {
                x: 16,
                y: 41,
                width: 1840,
                height: 1010,
            },
            &work_area(),
            true,
        ));
        assert!(!should_restore_maximized(
            WindowBoundsState {
                x: 120,
                y: 120,
                width: 1840,
                height: 1010,
            },
            &work_area(),
            true,
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn near_maximized_edge_tolerance_remains_logical_on_high_dpi_monitors() {
        let area = high_dpi_work_area();
        // 72 physical px gap == 48 logical px at 1.5x -> accepted.
        assert!(should_restore_maximized(
            WindowBoundsState {
                x: -3840 + 72,
                y: -370 + 72,
                width: 2432,
                height: 1325,
            },
            &area,
            true,
        ));
        // 75 physical px gap == 50 logical px at 1.5x -> rejected.
        assert!(!should_restore_maximized(
            WindowBoundsState {
                x: -3840 + 75,
                y: -370 + 72,
                width: 2432,
                height: 1325,
            },
            &area,
            true,
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ordinary_large_window_is_not_mistaken_for_maximized() {
        assert!(!should_restore_maximized(
            WindowBoundsState {
                x: 80,
                y: 70,
                width: 1440,
                height: 900,
            },
            &work_area(),
            true,
        ));
    }

    #[test]
    fn moved_capture_with_maximized_geometry_is_rejected_as_normal_bounds() {
        let previous = WindowBoundsState {
            x: 174,
            y: 110,
            width: 1184,
            height: 800,
        };
        // Maximize transition: same-ish size within tolerance is a genuine move.
        assert!(size_matches_previous(
            WindowBoundsState {
                x: 100,
                y: 200,
                width: 1184,
                height: 800,
            },
            previous,
        ));
        assert!(size_matches_previous(
            WindowBoundsState {
                x: 100,
                y: 200,
                width: 1185,
                height: 799,
            },
            previous,
        ));
        // Maximized geometry differs by far more than rounding.
        assert!(!size_matches_previous(
            WindowBoundsState {
                x: -8,
                y: -8,
                width: 1920,
                height: 1027,
            },
            previous,
        ));
        // Cross-DPI maximized geometry (logical) also differs.
        assert!(!size_matches_previous(
            WindowBoundsState {
                x: -2560,
                y: -247,
                width: 1280,
                height: 685,
            },
            previous,
        ));
    }

    #[test]
    fn fullscreen_and_maximized_observations_preserve_normal_bounds() {
        let normal = WindowBoundsState {
            x: 120,
            y: 90,
            width: 1200,
            height: 800,
        };
        let state = normal_state(normal);

        let maximized = merge_window_observation(state, None, true, false);
        assert_eq!(maximized.normal, normal);
        assert!(maximized.maximized);
        assert!(!maximized.fullscreen);

        let fullscreen = merge_window_observation(maximized, None, true, true);
        assert_eq!(fullscreen.normal, normal);
        assert!(!fullscreen.maximized);
        assert!(fullscreen.fullscreen);
    }

    #[test]
    fn normal_observation_replaces_bounds_and_clears_special_state() {
        let previous = WindowState {
            version: WINDOW_STATE_VERSION,
            normal: default_window_bounds(),
            maximized: true,
            fullscreen: false,
        };
        let observed = WindowBoundsState {
            x: 80,
            y: 70,
            width: 1360,
            height: 900,
        };
        let next = merge_window_observation(previous, Some(observed), false, false);

        assert_eq!(next.normal, observed);
        assert!(!next.maximized);
        assert!(!next.fullscreen);
    }

    #[test]
    fn legacy_state_migrates_without_trusting_an_old_position() {
        let dir = unique_temp_dir("legacy");
        let path = window_state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, r#"{"width":1900,"height":1030}"#).unwrap();

        let loaded = read_window_state(&path).unwrap();
        assert_eq!(loaded.state.version, WINDOW_STATE_VERSION);
        assert_eq!(loaded.state.normal.width, 1900);
        assert_eq!(loaded.state.normal.height, 1030);
        assert_eq!(loaded.state.normal.x, 0);
        assert_eq!(loaded.state.normal.y, 0);
        assert!(!loaded.has_trusted_position);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn v2_state_migrates_size_and_flags_but_drops_unconvertible_position() {
        let dir = unique_temp_dir("v2-migration");
        let path = window_state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"version":2,"normal":{"x":-1600,"y":533,"width":1184,"height":800},"maximized":true,"fullscreen":false}"#,
        )
        .unwrap();

        let loaded = read_window_state(&path).unwrap();
        assert_eq!(loaded.state.version, WINDOW_STATE_VERSION);
        assert_eq!(loaded.state.normal.width, 1184);
        assert_eq!(loaded.state.normal.height, 800);
        // v2 logical x/y cannot be reinterpreted as physical: dropped.
        assert_eq!(loaded.state.normal.x, 0);
        assert_eq!(loaded.state.normal.y, 0);
        assert!(loaded.state.maximized);
        assert!(!loaded.state.fullscreen);
        assert!(!loaded.has_trusted_position);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn v3_round_trips_with_physical_position_and_logical_size() {
        let dir = unique_temp_dir("v3-round-trip");
        let path = window_state_path(&dir);
        let state = WindowState {
            version: WINDOW_STATE_VERSION,
            normal: WindowBoundsState {
                x: -2400,
                y: 800,
                width: 1184,
                height: 800,
            },
            maximized: false,
            fullscreen: true,
        };

        write_window_state(&path, state).unwrap();
        let loaded = read_window_state(&path).unwrap();
        assert_eq!(loaded.state.version, WINDOW_STATE_VERSION);
        assert_eq!(loaded.state.normal.x, -2400);
        assert_eq!(loaded.state.normal.y, 800);
        assert_eq!(loaded.state.normal.width, 1184);
        assert_eq!(loaded.state.normal.height, 800);
        assert!(!loaded.state.maximized);
        assert!(loaded.state.fullscreen);
        assert!(loaded.has_trusted_position);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn one_point_twenty_five_scale_conversion_is_exact_in_both_directions() {
        let area = RestoreWorkArea {
            x: 0,
            y: 0,
            width: 2400,
            height: 1350,
            scale_factor: 1.25,
        };
        let constrained = constrain_window_bounds(
            WindowBoundsState {
                x: 100,
                y: 100,
                width: 1200,
                height: 800,
            },
            &area,
            true,
        );
        assert_eq!(constrained.width, 1200);
        assert_eq!(constrained.height, 800);
        assert_eq!(constrained.x, 100);
        assert_eq!(constrained.y, 100);
        // physical projection: 1200 * 1.25 = 1500 stays inside 2400-wide area
        assert_eq!(1500 + 100, 1600);
        assert!(constrained.x as u32 + 1500 <= area.width);
    }

    #[test]
    fn migrate_foreign_v3_state_preserves_size_and_flags_but_drops_position() {
        let migrated = migrate_foreign_v3_state(WindowState {
            version: 3,
            normal: WindowBoundsState {
                x: -2400,
                y: 800,
                width: 1184,
                height: 800,
            },
            maximized: true,
            fullscreen: false,
        })
        .unwrap();
        assert_eq!(migrated.state.version, WINDOW_STATE_VERSION);
        assert_eq!(migrated.state.normal.x, 0);
        assert_eq!(migrated.state.normal.y, 0);
        assert_eq!(migrated.state.normal.width, 1184);
        assert_eq!(migrated.state.normal.height, 800);
        assert!(migrated.state.maximized);
        assert!(!migrated.state.fullscreen);
        assert!(!migrated.has_trusted_position);
    }

    #[test]
    fn v3_file_is_handled_per_platform_contract() {
        let dir = unique_temp_dir("v3-file");
        let path = window_state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"version":3,"normal":{"x":-2400,"y":800,"width":1184,"height":800},"maximized":false,"fullscreen":true}"#,
        )
        .unwrap();

        let loaded = read_window_state(&path).unwrap();
        #[cfg(target_os = "windows")]
        {
            // Windows: v3 is the current contract; position stays physical.
            assert_eq!(loaded.state.version, WINDOW_STATE_VERSION);
            assert_eq!(loaded.state.normal.x, -2400);
            assert_eq!(loaded.state.normal.y, 800);
            assert!(loaded.has_trusted_position);
        }
        #[cfg(not(target_os = "windows"))]
        {
            // macOS/Linux: transient v3 from 0ba6ac8; position dropped.
            assert_eq!(loaded.state.version, WINDOW_STATE_VERSION);
            assert_eq!(loaded.state.normal.x, 0);
            assert_eq!(loaded.state.normal.y, 0);
            assert_eq!(loaded.state.normal.width, 1184);
            assert_eq!(loaded.state.normal.height, 800);
            assert!(loaded.state.fullscreen);
            assert!(!loaded.has_trusted_position);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_window_state_ignores_invalid_or_unknown_versions() {
        let dir = unique_temp_dir("invalid");
        let path = window_state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{broken").unwrap();
        assert_eq!(read_window_state(&path), None);

        std::fs::write(
            &path,
            r#"{"version":99,"normal":{"x":0,"y":0,"width":1200,"height":800},"maximized":false,"fullscreen":false}"#,
        )
        .unwrap();
        assert_eq!(read_window_state(&path), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn persisted_normal_size_is_available_to_the_scale_guard() {
        let dir = unique_temp_dir("scale-guard-normal");
        let path = window_state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"version":3,"normal":{"x":-2400,"y":800,"width":1184,"height":800},"maximized":false,"fullscreen":false}"#,
        )
        .unwrap();
        let size = read_persisted_normal_size(&dir).unwrap();
        assert_eq!(size.width, 1184.0);
        assert_eq!(size.height, 800.0);

        std::fs::write(&path, "{broken").unwrap();
        assert_eq!(read_persisted_normal_size(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn persisted_window_snapshot_carries_bounds_and_modes() {
        let dir = unique_temp_dir("persisted-snapshot");
        let path = window_state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"version":3,"normal":{"x":-2400,"y":800,"width":950,"height":650},"maximized":false,"fullscreen":true}"#,
        )
        .unwrap();
        let snapshot = read_persisted_window_snapshot(&dir).unwrap();
        assert_eq!(snapshot.version, WINDOW_STATE_VERSION);
        assert_eq!(snapshot.normal_x, -2400);
        assert_eq!(snapshot.normal_y, 800);
        assert_eq!(snapshot.normal_width, 950);
        assert_eq!(snapshot.normal_height, 650);
        assert!(!snapshot.maximized);
        assert!(snapshot.fullscreen);

        std::fs::write(&path, "{broken").unwrap();
        assert_eq!(read_persisted_window_snapshot(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn window_state_observer_delivers_save_observations_without_mutating() {
        use std::sync::mpsc;
        assert!(!has_window_state_observer());
        let (tx, rx) = mpsc::channel();
        set_window_state_observer(Box::new(move |observation| {
            let _ = tx.send(observation);
        }));
        assert!(has_window_state_observer());
        let observation = WindowStateObservation {
            trigger: "Moved",
            previous_normal_x: 174,
            previous_normal_y: 110,
            previous_normal_width: 1184,
            previous_normal_height: 800,
            captured_normal_x: Some(174),
            captured_normal_y: Some(110),
            captured_normal_width: Some(1184),
            captured_normal_height: Some(800),
            next_normal_x: 174,
            next_normal_y: 110,
            next_normal_width: 1184,
            next_normal_height: 800,
            persisted: true,
        };
        notify_window_state_observation(observation);
        let delivered = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(delivered, observation);
        set_window_state_observer(Box::new(|_| {}));
    }

    // ================= non-Windows (v2, logical position contract) =================

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn oversized_legacy_bounds_fill_the_available_work_area_without_artificial_gaps() {
        let constrained = constrain_window_bounds(
            WindowBoundsState {
                x: 0,
                y: 0,
                width: 2200,
                height: 1400,
            },
            &work_area(),
            false,
        );

        assert_eq!(constrained.width, 1728);
        assert_eq!(constrained.height, 1055);
        assert_eq!(constrained.x, 0);
        assert_eq!(constrained.y, 25);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn offscreen_logical_position_is_pulled_back_inside_the_saved_monitor() {
        let constrained = constrain_window_bounds(
            WindowBoundsState {
                x: 1400,
                y: 900,
                width: 1200,
                height: 800,
            },
            &work_area(),
            true,
        );

        assert_eq!(constrained.x, 528);
        assert_eq!(constrained.y, 280);
        assert_eq!(constrained.width, 1200);
        assert_eq!(constrained.height, 800);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn near_full_size_is_inferred_as_maximized_in_logical_space() {
        assert!(should_restore_maximized(
            WindowBoundsState {
                x: 0,
                y: 0,
                width: 1696,
                height: 1023,
            },
            &work_area(),
            false,
        ));
        assert!(should_restore_maximized(
            WindowBoundsState {
                x: 16,
                y: 41,
                width: 1696,
                height: 1023,
            },
            &work_area(),
            true,
        ));
        assert!(!should_restore_maximized(
            WindowBoundsState {
                x: 120,
                y: 120,
                width: 1696,
                height: 1023,
            },
            &work_area(),
            true,
        ));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn v2_round_trips_with_logical_position_and_size() {
        let dir = unique_temp_dir("v2-round-trip");
        let path = window_state_path(&dir);
        let state = WindowState {
            version: WINDOW_STATE_VERSION,
            normal: WindowBoundsState {
                x: -1200,
                y: 60,
                width: 1440,
                height: 900,
            },
            maximized: false,
            fullscreen: true,
        };

        write_window_state(&path, state).unwrap();
        let loaded = read_window_state(&path).unwrap();
        assert_eq!(loaded.state.version, WINDOW_STATE_VERSION);
        assert_eq!(loaded.state.normal.x, -1200);
        assert_eq!(loaded.state.normal.y, 60);
        assert_eq!(loaded.state.normal.width, 1440);
        assert_eq!(loaded.state.normal.height, 900);
        assert!(loaded.state.fullscreen);
        assert!(loaded.has_trusted_position);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn persisted_normal_size_is_available_to_the_scale_guard() {
        let dir = unique_temp_dir("scale-guard-normal");
        let path = window_state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"version":2,"normal":{"x":174,"y":110,"width":1184,"height":800},"maximized":false,"fullscreen":false}"#,
        )
        .unwrap();
        let size = read_persisted_normal_size(&dir).unwrap();
        assert_eq!(size.width, 1184.0);
        assert_eq!(size.height, 800.0);

        std::fs::write(&path, "{broken").unwrap();
        assert_eq!(read_persisted_normal_size(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn persisted_window_snapshot_carries_bounds_and_modes() {
        let dir = unique_temp_dir("persisted-snapshot");
        let path = window_state_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            r#"{"version":2,"normal":{"x":-1920,"y":100,"width":950,"height":650},"maximized":false,"fullscreen":true}"#,
        )
        .unwrap();
        let snapshot = read_persisted_window_snapshot(&dir).unwrap();
        assert_eq!(snapshot.version, WINDOW_STATE_VERSION);
        assert_eq!(snapshot.normal_x, -1920);
        assert_eq!(snapshot.normal_y, 100);
        assert_eq!(snapshot.normal_width, 950);
        assert_eq!(snapshot.normal_height, 650);
        assert!(!snapshot.maximized);
        assert!(snapshot.fullscreen);

        std::fs::write(&path, "{broken").unwrap();
        assert_eq!(read_persisted_window_snapshot(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
