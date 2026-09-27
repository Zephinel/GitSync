#!/usr/bin/env bash
set -e

# Build GitSync (Tauri)
# Usage:
#   ./build-app.sh              -> release build (with cache clean)
#   ./build-app.sh --debug      -> debug build (with cache clean)
#   ./build-app.sh --no-clean   -> skip cache clean for faster incremental builds
#   ./build-app.sh --skip-dmg-ui -> macOS only: skip DMG temporary Finder window (also skips custom DMG layout)
#   BUILD_APP_AUTO_CLOSE=0 ./build-app.sh -> keep the current Terminal/iTerm window open after a successful macOS build
#
#   Flags can be combined: ./build-app.sh --debug --no-clean --skip-dmg-ui

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$ROOT_DIR/src-tauri"

finish_and_exit() {
  local code="${1:-0}"

  if [[ "$code" -eq 0 ]] && should_auto_close_terminal_window; then
    schedule_terminal_window_close > /dev/null 2>&1 || true
  fi

  exit "$code"
}

finish_with_error() {
  echo "[ERROR] $1"
  finish_and_exit "${2:-1}"
}

has_supported_terminal_session() {
  [[ "${TERM_PROGRAM:-}" == "Apple_Terminal" ]] || [[ -n "${ITERM_SESSION_ID:-}" ]]
}

should_auto_close_terminal_window() {
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  has_supported_terminal_session || return 1

  [[ "${BUILD_APP_AUTO_CLOSE:-1}" != "0" ]]
}

schedule_terminal_window_close() {
  command -v osascript > /dev/null 2>&1 || return 1

  local terminal_app
  local window_id

  terminal_app="$(detect_terminal_app)" || return 1
  window_id="$(current_terminal_window_id "$terminal_app")"
  [[ "$window_id" =~ ^[0-9]+$ ]] || return 1

  case "$terminal_app" in
    terminal)
      schedule_window_close_job "$terminal_app" "$window_id" \
        -e 'if application "Terminal" is not running then return' \
        -e 'tell application "Terminal"' \
        -e 'repeat 50 times' \
        -e 'set targetWindows to every window whose id is targetWindowId' \
        -e 'if (count of targetWindows) is 0 then return' \
        -e 'set targetWindow to item 1 of targetWindows' \
        -e 'if not busy of selected tab of targetWindow then exit repeat' \
        -e 'delay 0.2' \
        -e 'end repeat' \
        -e 'set targetWindows to every window whose id is targetWindowId' \
        -e 'if (count of targetWindows) is not 0 then close (item 1 of targetWindows)' \
        -e 'end tell'
      ;;
    iterm)
      schedule_window_close_job "$terminal_app" "$window_id" \
        -e 'if application id "com.googlecode.iterm2" is not running then return' \
        -e 'tell application id "com.googlecode.iterm2"' \
        -e 'set targetWindows to every window whose id is targetWindowId' \
        -e 'if (count of targetWindows) is not 0 then close (item 1 of targetWindows)' \
        -e 'end tell'
      ;;
    *)
      return 1
      ;;
  esac
}

detect_terminal_app() {
  if [[ "${TERM_PROGRAM:-}" == "Apple_Terminal" ]]; then
    echo "terminal"
    return 0
  fi

  if [[ -n "${ITERM_SESSION_ID:-}" ]]; then
    echo "iterm"
    return 0
  fi

  return 1
}

current_terminal_window_id() {
  case "$1" in
    terminal)
      osascript -e 'tell application "Terminal" to id of front window' 2> /dev/null | tr -d '[:space:]'
      ;;
    iterm)
      osascript -e 'tell application id "com.googlecode.iterm2" to id of current window' 2> /dev/null | tr -d '[:space:]'
      ;;
    *)
      return 1
      ;;
  esac
}

submit_detached_osascript_job() {
  local label="$1"
  shift

  if command -v launchctl > /dev/null 2>&1; then
    launchctl submit -l "$label" -- /usr/bin/osascript "$@" > /dev/null 2>&1
    return $?
  fi

  nohup /usr/bin/osascript "$@" < /dev/null > /dev/null 2>&1 &
  disown > /dev/null 2>&1 || true
}

schedule_window_close_job() {
  local terminal_app="$1"
  local window_id="$2"
  shift 2

  submit_detached_osascript_job "com.gitsync.close-${terminal_app}.$$.$window_id.$RANDOM" \
    -e "set targetWindowId to $window_id" \
    -e 'delay 0.35' \
    "$@"
}

run_build() {
  local suffix=""
  local -a build_cmd=(npm run tauri build)

  if [ $DO_DEBUG -eq 1 ]; then
    suffix=" -- --debug"
    build_cmd+=(-- --debug)
  fi

  if [ $USE_CI_FOR_BUILD -eq 1 ]; then
    echo "[INFO] Running: CI=true npm run tauri build$suffix"
    CI=true "${build_cmd[@]}"
  else
    echo "[INFO] Running: npm run tauri build$suffix"
    "${build_cmd[@]}"
  fi
}

resolve_output_dir() {
  if [ $DO_DEBUG -eq 1 ]; then
    if [ -d "$TAURI_DIR/target/debug/bundle" ]; then
      echo "$TAURI_DIR/target/debug/bundle"
      return 0
    fi

    echo "$TAURI_DIR/target/debug"
    return 0
  fi

  if [ -d "$TAURI_DIR/target/release/bundle" ]; then
    echo "$TAURI_DIR/target/release/bundle"
    return 0
  fi

  echo "$TAURI_DIR/target/release"
}

open_output_dir() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo "[WARN] Output directory not found: $dir"
    return 0
  fi

  echo "[INFO] Opening output directory: $dir"
  if command -v open &> /dev/null; then
    open "$dir" &> /dev/null &
    return 0
  fi

  if command -v xdg-open &> /dev/null; then
    xdg-open "$dir" &> /dev/null &
    return 0
  fi

  echo "[WARN] Cannot open directory automatically (missing open/xdg-open)."
  return 0
}

# Check requirements
if [ ! -f "$TAURI_DIR/Cargo.toml" ]; then
  echo "[ERROR] src-tauri/Cargo.toml not found."
  echo "Expected path: $TAURI_DIR/Cargo.toml"
  finish_and_exit 1
fi

if ! command -v cargo &> /dev/null; then
  finish_with_error "cargo not found in PATH."
fi

if ! command -v npm &> /dev/null; then
  finish_with_error "npm not found in PATH."
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "[INFO] Installing frontend dependencies..."
  cd "$ROOT_DIR"
  if ! npm install; then
    finish_with_error "npm install failed."
  fi
fi

# Parse arguments
DO_DEBUG=0
NO_CLEAN=0
SKIP_DMG_UI=0

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --debug) DO_DEBUG=1; shift ;;
    --no-clean) NO_CLEAN=1; shift ;;
    --skip-dmg-ui) SKIP_DMG_UI=1; shift ;;
    *) finish_with_error "Unknown parameter: $1" ;;
  esac
done

USE_CI_FOR_BUILD=0
if [ $SKIP_DMG_UI -eq 1 ]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    USE_CI_FOR_BUILD=1
    echo "[INFO] --skip-dmg-ui enabled: will skip DMG Finder styling window and custom DMG layout."
  else
    echo "[WARN] --skip-dmg-ui is only meaningful on macOS; ignoring this flag."
  fi
fi

# Clean by default unless --no-clean is specified
if [ $NO_CLEAN -eq 0 ]; then
  echo "[INFO] Cleaning build cache..."
  cd "$TAURI_DIR"
  cargo clean
  echo "[INFO] Build cache cleaned."
fi

# Build
cd "$ROOT_DIR"
echo ""

if run_build; then
  BUILD_CODE=0
else
  BUILD_CODE=$?
fi
if [ $BUILD_CODE -ne 0 ]; then
  finish_with_error "Build failed with code $BUILD_CODE." "$BUILD_CODE"
fi

echo ""
echo "[OK] Build finished."
if [ $DO_DEBUG -eq 1 ]; then
  echo "[INFO] Build artifacts: $TAURI_DIR/target/debug/"
else
  echo "[INFO] Build artifacts: $TAURI_DIR/target/release/"
fi
OUTPUT_DIR="$(resolve_output_dir)"
echo "[INFO] Application Bundles (macOS/Linux): $TAURI_DIR/target/release/bundle"
open_output_dir "$OUTPUT_DIR"

finish_and_exit 0
