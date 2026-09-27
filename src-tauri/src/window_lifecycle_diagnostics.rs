//! Diagnostic-only window lifecycle observation.
//!
//! Phase 1 (Windows WebView lifecycle diagnostic + active reproduction).
//!
//! This module is strictly observational: it never calls `set_size`,
//! `set_position`, `request_redraw`, zoom or other mutating window APIs.
//! Its only side effect is appending structured NDJSON records to a local
//! log file inside the app data directory.
//!
//! Records are geometry/lifecycle only. No repository paths, repository
//! names, branch names, file names, Git content, usernames, hostnames,
//! IP addresses, machine identifiers or account information is captured.

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, Runtime, WebviewWindow, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";
const DIAGNOSTICS_LOG_FILE_NAME: &str = "window-lifecycle-diagnostics.ndjson";
const MAX_DIAGNOSTICS_LOG_BYTES: u64 = 64 * 1024 * 1024;
const DIAGNOSTICS_ENV_VAR: &str = "GITSYNC_WINDOW_DIAGNOSTICS";

/// Monotonic per-process event sequence. Cross-DPI bugs depend on event
/// ordering; wall clock alone cannot express it.
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn next_sequence() -> u64 {
    EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
}

/// Phase 1 diagnostics are Windows-only and opt-in via the
/// `GITSYNC_WINDOW_DIAGNOSTICS=1` environment variable. They must not run in
/// ordinary production: every window lifecycle event performs synchronous
/// file I/O, which is a hot path during window drag/resize.
pub fn is_enabled() -> bool {
    diagnostics_enabled(
        cfg!(target_os = "windows"),
        std::env::var(DIAGNOSTICS_ENV_VAR).ok().as_deref(),
    )
}

fn diagnostics_enabled(on_windows: bool, env_value: Option<&str>) -> bool {
    on_windows && env_value.is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

#[tauri::command]
pub fn is_window_diagnostics_enabled() -> bool {
    is_enabled()
}

#[cfg(test)]
const FORBIDDEN_PAYLOAD_KEY_FRAGMENTS: [&str; 8] = [
    "path", "repo", "branch", "file", "user", "host", "machine", "account",
];

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Process-local session identity derived only from start time and process id.
/// Stable across native and webview records for the lifetime of the process.
fn session_id() -> &'static str {
    static SESSION_ID: OnceLock<String> = OnceLock::new();
    SESSION_ID.get_or_init(|| {
        let start_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or(0);
        let pid = std::process::id() as u64;
        let mut hash = pid.wrapping_add(start_nanos ^ 0x9E37_79B9_7F4A_7C15);
        hash ^= hash >> 33;
        hash = hash.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
        hash ^= hash >> 33;
        hash = hash.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
        hash ^= hash >> 33;
        format!("{:016x}", hash)
    })
}

fn diagnostics_log_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DIAGNOSTICS_LOG_FILE_NAME)
}

fn log_size_exceeds_cap(byte_len: u64) -> bool {
    byte_len >= MAX_DIAGNOSTICS_LOG_BYTES
}

fn append_record(log_path: &Path, record: Value) -> Result<(), String> {
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建诊断日志目录 {} 失败: {}", parent.display(), error))?;
    }
    if let Ok(metadata) = std::fs::metadata(log_path) {
        if log_size_exceeds_cap(metadata.len()) {
            let _ = std::fs::remove_file(log_path);
        }
    }
    let mut line =
        serde_json::to_string(&record).map_err(|error| format!("序列化诊断记录失败: {}", error))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("打开诊断日志 {} 失败: {}", log_path.display(), error))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("写入诊断日志 {} 失败: {}", log_path.display(), error))
}

fn write_native_record(
    log_path: &Path,
    event: &str,
    extra: Value,
    snapshot: &Value,
) -> Result<(), String> {
    append_record(
        log_path,
        json!({
            "timestamp": epoch_millis(),
            "sequence": next_sequence(),
            "session_id": session_id(),
            "source": "native",
            "event": event,
            "extra": extra,
            "window": snapshot.get("window").cloned(),
            "monitor": snapshot.get("monitor").cloned(),
            "persisted_normal": snapshot.get("persisted_normal").cloned(),
        }),
    )
}

fn persisted_normal_value(app_data_dir: &Path) -> Value {
    let Some(snapshot) = crate::window_state::read_persisted_window_snapshot(app_data_dir) else {
        return Value::Null;
    };
    let position_unit = if cfg!(target_os = "windows") {
        "physical"
    } else {
        "logical"
    };
    json!({
        "version": snapshot.version,
        "position_unit": position_unit,
        "x": snapshot.normal_x,
        "y": snapshot.normal_y,
        "width": snapshot.normal_width,
        "height": snapshot.normal_height,
        "maximized": snapshot.maximized,
        "fullscreen": snapshot.fullscreen,
    })
}

/// Diagnostic-only transport for window-state save observations. Called by
/// the window-state observer; never changes the save result.
pub(crate) fn record_window_state_observation(
    app_data_dir: &Path,
    observation: crate::window_state::WindowStateObservation,
) {
    let log_path = diagnostics_log_path(app_data_dir);
    let _ = append_record(
        &log_path,
        json!({
            "timestamp": epoch_millis(),
            "sequence": next_sequence(),
            "session_id": session_id(),
            "source": "window_state",
            "event": "WindowStateWrite",
            "extra": {
                "trigger": observation.trigger,
                "previous_normal": {
                    "x": observation.previous_normal_x,
                    "y": observation.previous_normal_y,
                    "width": observation.previous_normal_width,
                    "height": observation.previous_normal_height,
                },
                "captured_normal": if observation.captured_normal_x.is_some() {
                    json!({
                        "x": observation.captured_normal_x.unwrap(),
                        "y": observation.captured_normal_y.unwrap(),
                        "width": observation.captured_normal_width.unwrap(),
                        "height": observation.captured_normal_height.unwrap(),
                    })
                } else {
                    Value::Null
                },
                "next_normal": {
                    "x": observation.next_normal_x,
                    "y": observation.next_normal_y,
                    "width": observation.next_normal_width,
                    "height": observation.next_normal_height,
                },
                "persisted": observation.persisted,
            },
            "window": Value::Null,
            "monitor": Value::Null,
            "persisted_normal": persisted_normal_value(app_data_dir),
        }),
    );
}

/// Observation-only snapshot of the native window and its current monitor.
/// Reads getters only; never mutates the window.
fn capture_native_snapshot<R: Runtime>(window: &WebviewWindow<R>) -> Value {
    let scale_factor = window.scale_factor().ok();
    let inner_physical = window.inner_size().ok();
    let outer_physical = window.outer_size().ok();
    let outer_position_physical = window.outer_position().ok();
    let is_maximized = window.is_maximized().ok();
    let is_fullscreen = window.is_fullscreen().ok();
    let is_minimized = window.is_minimized().ok();

    let monitor = window.current_monitor().ok().flatten();
    let monitor_scale_factor = monitor.as_ref().map(|current| current.scale_factor());
    let monitor_size = monitor.as_ref().map(|current| current.size());
    let monitor_position = monitor.as_ref().map(|current| current.position());
    let monitor_work_area = monitor.as_ref().map(|current| current.work_area());

    let inner_logical = scale_factor
        .zip(inner_physical)
        .map(|(factor, size)| size.to_logical::<f64>(factor));
    let outer_logical = scale_factor
        .zip(outer_physical)
        .map(|(factor, size)| size.to_logical::<f64>(factor));
    let position_logical = scale_factor
        .zip(outer_position_physical)
        .map(|(factor, position)| position.to_logical::<f64>(factor));
    let work_area_logical = monitor_scale_factor
        .zip(monitor_work_area)
        .map(|(factor, area)| {
            let position = area.position.to_logical::<f64>(factor);
            let size = area.size.to_logical::<f64>(factor);
            json!({
                "x": position.x,
                "y": position.y,
                "width": size.width,
                "height": size.height,
            })
        });

    json!({
        "window": {
            "scale_factor": scale_factor,
            "inner": inner_physical.map(|size| json!({"width": size.width, "height": size.height})),
            "outer": outer_physical.map(|size| json!({"width": size.width, "height": size.height})),
            "inner_logical": inner_logical.map(|size| json!({"width": size.width, "height": size.height})),
            "outer_logical": outer_logical.map(|size| json!({"width": size.width, "height": size.height})),
            "position": outer_position_physical.map(|position| json!({"x": position.x, "y": position.y})),
            "position_logical": position_logical.map(|position| json!({"x": position.x, "y": position.y})),
            "maximized": is_maximized,
            "fullscreen": is_fullscreen,
            "minimized": is_minimized,
        },
        "monitor": {
            "scale_factor": monitor_scale_factor,
            "size": monitor_size.map(|size| json!({"width": size.width, "height": size.height})),
            "position": monitor_position.map(|position| json!({"x": position.x, "y": position.y})),
            "work_area": monitor_work_area.map(|area| json!({
                "x": area.position.x,
                "y": area.position.y,
                "width": area.size.width,
                "height": area.size.height,
            })),
            "work_area_logical": work_area_logical,
        },
    })
}

fn install_observation<R, M>(manager: &M, app_data_dir: &Path)
where
    R: Runtime,
    M: Manager<R>,
{
    let Some(window) = manager.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let log_path = diagnostics_log_path(app_data_dir);
    let app_data_dir_owned = app_data_dir.to_path_buf();
    let app_data_dir_events = app_data_dir_owned.clone();

    crate::window_state::set_window_state_observer(Box::new(move |observation| {
        record_window_state_observation(&app_data_dir_owned, observation);
    }));

    let snapshot = capture_snapshot_with_persisted(&window, app_data_dir);
    let _ = write_native_record(&log_path, "AppStarted", json!({}), &snapshot);

    let window_for_events = window.clone();
    window.on_window_event(move |event| {
        let (event_name, extra) = match event {
            WindowEvent::Focused(focused) => ("Focused", json!({ "focused": focused })),
            WindowEvent::Resized(size) => (
                "Resized",
                json!({ "size": { "width": size.width, "height": size.height } }),
            ),
            WindowEvent::Moved(position) => (
                "Moved",
                json!({ "position": { "x": position.x, "y": position.y } }),
            ),
            WindowEvent::ScaleFactorChanged {
                scale_factor,
                new_inner_size,
                ..
            } => (
                "ScaleFactorChanged",
                json!({
                    "scale_factor": scale_factor,
                    "new_inner_size": { "width": new_inner_size.width, "height": new_inner_size.height },
                }),
            ),
            WindowEvent::CloseRequested { .. } => ("CloseRequested", json!({})),
            WindowEvent::Destroyed => ("Destroyed", json!({})),
            _ => return,
        };
        let snapshot = capture_snapshot_with_persisted(&window_for_events, &app_data_dir_events);
        let _ = write_native_record(&log_path, event_name, extra, &snapshot);
    });
}

/// Post-callback snapshot of window + monitor + persisted normal bounds.
fn capture_snapshot_with_persisted<R: Runtime>(
    window: &WebviewWindow<R>,
    app_data_dir: &Path,
) -> Value {
    let mut snapshot = capture_native_snapshot(window);
    if let Some(object) = snapshot.as_object_mut() {
        object.insert(
            "persisted_normal".to_string(),
            persisted_normal_value(app_data_dir),
        );
    }
    snapshot
}

pub fn setup_window_lifecycle_diagnostics<R, M>(manager: &M, app_data_dir: &Path)
where
    R: Runtime,
    M: Manager<R>,
{
    install_observation(manager, app_data_dir);
}

/// Minimal frontend-to-native diagnostic transport.
/// `payload` is a free-form JSON object produced by the WebView observer.
/// The command itself enforces the opt-in gate: even if something calls it
/// in ordinary production, it is a no-op unless diagnostics are enabled.
#[tauri::command]
pub fn record_webview_diagnostics(
    app: tauri::AppHandle,
    event: String,
    payload: Option<Value>,
) -> Result<(), String> {
    if !is_enabled() {
        return Ok(());
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取应用数据目录失败: {}", error))?;
    let log_path = diagnostics_log_path(&app_data_dir);
    record_webview_diagnostics_inner(&log_path, true, &event, payload.as_ref())
}

fn record_webview_diagnostics_inner(
    log_path: &Path,
    enabled: bool,
    event: &str,
    payload: Option<&Value>,
) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    record_webview_line(log_path, event, payload)
}

fn record_webview_line(
    log_path: &Path,
    event: &str,
    payload: Option<&Value>,
) -> Result<(), String> {
    let event = event.trim();
    if event.is_empty() {
        return Err("诊断事件名不能为空".to_string());
    }
    let payload = match payload {
        Some(Value::Object(_)) => payload.cloned().unwrap_or_else(|| json!({})),
        Some(_) => return Err("诊断 payload 必须是 JSON 对象".to_string()),
        None => json!({}),
    };
    append_record(
        log_path,
        json!({
            "timestamp": epoch_millis(),
            "sequence": next_sequence(),
            "session_id": session_id(),
            "source": "webview",
            "event": event,
            "extra": {},
            "window": null,
            "monitor": null,
            "persisted_normal": null,
            "payload": payload,
        }),
    )
}

#[cfg(test)]
fn key_tree_contains_forbidden_fragment(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                if FORBIDDEN_PAYLOAD_KEY_FRAGMENTS
                    .iter()
                    .any(|fragment| key.to_ascii_lowercase().contains(fragment))
                {
                    return Some(key.clone());
                }
                if let Some(found) = key_tree_contains_forbidden_fragment(nested) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(key_tree_contains_forbidden_fragment),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let stamp = epoch_millis();
        std::env::temp_dir().join(format!(
            "gitsync-window-lifecycle-diagnostics-{}-{}-{}",
            name,
            std::process::id(),
            stamp
        ))
    }

    #[test]
    fn session_id_is_stable_and_hex() {
        let first = session_id();
        let second = session_id();
        assert_eq!(first, second);
        assert_eq!(first.len(), 16);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn native_records_carry_monotonic_sequence_numbers() {
        let dir = unique_temp_dir("sequence");
        let path = diagnostics_log_path(&dir);
        let snapshot = json!({
            "window": { "scale_factor": 1.0, "inner": null },
            "monitor": { "scale_factor": 1.0 },
            "persisted_normal": null,
        });
        write_native_record(&path, "AppStarted", json!({}), &snapshot).unwrap();
        write_native_record(&path, "Moved", json!({}), &snapshot).unwrap();
        write_native_record(&path, "Resized", json!({}), &snapshot).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let records: Vec<Value> = content
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let sequences: Vec<u64> = records
            .iter()
            .map(|record| record["sequence"].as_u64().unwrap())
            .collect();
        assert!(
            sequences.windows(2).all(|pair| pair[0] < pair[1]),
            "sequences must be strictly increasing: {sequences:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn window_state_observation_is_recorded_with_trigger_and_before_after() {
        let dir = unique_temp_dir("window-state-observation");
        let path = diagnostics_log_path(&dir);
        let observation = crate::window_state::WindowStateObservation {
            trigger: "Resized",
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
        record_window_state_observation(&dir, observation);

        let content = std::fs::read_to_string(&path).unwrap();
        let record: Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
        assert_eq!(record["source"], "window_state");
        assert_eq!(record["event"], "WindowStateWrite");
        assert!(record["sequence"].is_u64());
        assert_eq!(record["extra"]["trigger"], "Resized");
        assert_eq!(record["extra"]["previous_normal"]["width"], 1184);
        assert_eq!(record["extra"]["captured_normal"]["width"], 1184);
        assert_eq!(record["extra"]["next_normal"]["width"], 1184);
        assert_eq!(record["extra"]["persisted"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diagnostics_require_windows_and_explicit_env_opt_in() {
        assert!(!diagnostics_enabled(false, Some("1")));
        assert!(!diagnostics_enabled(true, None));
        assert!(!diagnostics_enabled(true, Some("0")));
        assert!(diagnostics_enabled(true, Some("1")));
        assert!(diagnostics_enabled(true, Some("true")));
        assert!(diagnostics_enabled(true, Some("TRUE")));
    }

    #[test]
    fn record_command_is_a_no_op_when_diagnostics_are_disabled() {
        let dir = unique_temp_dir("gated-record");
        let path = diagnostics_log_path(&dir);
        let payload = json!({ "inner_width": 1184.0 });
        record_webview_diagnostics_inner(&path, false, "Focus", Some(&payload)).unwrap();
        assert!(!path.exists());
        record_webview_diagnostics_inner(&path, true, "Focus", Some(&payload)).unwrap();
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webview_records_are_structured_ndjson() {
        let dir = unique_temp_dir("webview-record");
        let path = diagnostics_log_path(&dir);
        let payload = json!({ "inner_width": 1200.0 });
        record_webview_line(&path, "Focus", Some(&payload)).unwrap();
        record_webview_line(&path, "Blur", None).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);

        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["source"], "webview");
        assert_eq!(first["event"], "Focus");
        assert_eq!(first["session_id"], session_id());
        assert!(first["timestamp"].is_u64());
        assert_eq!(first["payload"]["inner_width"], 1200.0);

        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["event"], "Blur");
        assert!(second["payload"].is_object());
        assert!(second["payload"].as_object().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webview_record_rejects_empty_event_and_non_object_payload() {
        let dir = unique_temp_dir("invalid-webview-record");
        let path = diagnostics_log_path(&dir);
        assert!(record_webview_line(&path, "   ", None).is_err());
        assert!(record_webview_line(&path, "Focus", Some(&json!([1, 2]))).is_err());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn native_records_append_with_stable_schema() {
        let dir = unique_temp_dir("native-record");
        let path = diagnostics_log_path(&dir);
        let snapshot = json!({
            "window": { "scale_factor": null, "inner": null },
            "monitor": { "scale_factor": null },
        });
        write_native_record(&path, "AppStarted", json!({}), &snapshot).unwrap();
        write_native_record(&path, "Focused", json!({ "focused": true }), &snapshot).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        for line in &lines {
            let record: Value = serde_json::from_str(line).unwrap();
            assert_eq!(record["source"], "native");
            assert_eq!(record["session_id"], session_id());
            assert!(record["timestamp"].is_u64());
            assert!(record.get("window").is_some());
            assert!(record.get("monitor").is_some());
        }
        assert_eq!(
            serde_json::from_str::<Value>(lines[1]).unwrap()["extra"]["focused"],
            true
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamps_allow_alignment_between_native_and_webview_records() {
        let dir = unique_temp_dir("alignment");
        let path = diagnostics_log_path(&dir);
        record_webview_line(&path, "Focus", None).unwrap();
        let native_snapshot = json!({ "window": null, "monitor": null });
        write_native_record(
            &path,
            "Focused",
            json!({ "focused": true }),
            &native_snapshot,
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let records: Vec<Value> = content
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let webview_stamp = records[0]["timestamp"].as_u64().unwrap();
        let native_stamp = records[1]["timestamp"].as_u64().unwrap();
        assert!(native_stamp >= webview_stamp);
        assert!(native_stamp - webview_stamp < 10_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_cap_detection_triggers_at_limit() {
        assert!(!log_size_exceeds_cap(MAX_DIAGNOSTICS_LOG_BYTES - 1));
        assert!(log_size_exceeds_cap(MAX_DIAGNOSTICS_LOG_BYTES));
    }

    #[test]
    fn oversized_log_is_truncated_before_append() {
        let dir = unique_temp_dir("oversized");
        let path = diagnostics_log_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, vec![b'x'; (MAX_DIAGNOSTICS_LOG_BYTES + 1) as usize]).unwrap();
        record_webview_line(&path, "Focus", None).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_schema_contains_no_forbidden_metadata_keys() {
        let dir = unique_temp_dir("schema");
        let path = diagnostics_log_path(&dir);
        record_webview_line(
            &path,
            "Resize",
            Some(&json!({
                "device_pixel_ratio": 1.0,
                "inner_width": 1200.0,
                "inner_height": 800.0,
                "outer_width": 1200.0,
                "outer_height": 800.0,
                "client_width": 1200.0,
                "client_height": 800.0,
                "visual_viewport": { "width": 1200.0, "height": 800.0, "scale": 1.0 },
                "sidebar_width": 240.0,
                "visibility_state": "visible",
            })),
        )
        .unwrap();
        let snapshot = json!({
            "window": {
                "scale_factor": 1.0,
                "inner": { "width": 1200, "height": 800 },
                "outer": { "width": 1200, "height": 800 },
                "inner_logical": { "width": 1200.0, "height": 800.0 },
                "outer_logical": { "width": 1200.0, "height": 800.0 },
                "position": { "x": 0, "y": 0 },
                "position_logical": { "x": 0.0, "y": 0.0 },
                "maximized": false,
                "fullscreen": false,
                "minimized": false,
            },
            "monitor": {
                "scale_factor": 1.0,
                "size": { "width": 1920, "height": 1080 },
                "position": { "x": 0, "y": 0 },
                "work_area": { "x": 0, "y": 0, "width": 1920, "height": 1040 },
                "work_area_logical": { "x": 0.0, "y": 0.0, "width": 1920.0, "height": 1040.0 },
            },
        });
        write_native_record(&path, "AppStarted", json!({}), &snapshot).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        for line in content.lines() {
            let record: Value = serde_json::from_str(line).unwrap();
            assert_eq!(
                key_tree_contains_forbidden_fragment(&record),
                None,
                "record contains a forbidden metadata key: {line}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
