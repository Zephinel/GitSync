@echo off
setlocal

REM Build GitSync (Tauri)
REM Usage:
REM   build-app.bat              -> release build (with cache clean)
REM   build-app.bat --debug      -> debug build (with cache clean)
REM   build-app.bat --no-clean   -> skip cache clean for faster incremental builds
REM   set BUILD_APP_AUTO_CLOSE=0 && build-app.bat -> keep the current cmd window open after a successful build
REM
REM   Flags can be combined: build-app.bat --debug --no-clean

set "ROOT_DIR=%~dp0"
set "TAURI_DIR=%ROOT_DIR%src-tauri"

if not exist "%TAURI_DIR%\Cargo.toml" (
  echo [ERROR] src-tauri\Cargo.toml not found.
  echo Expected path: "%TAURI_DIR%\Cargo.toml"
  exit /b 1
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo [ERROR] cargo not found in PATH.
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found in PATH.
  exit /b 1
)

if not exist "%ROOT_DIR%node_modules" (
  echo [INFO] Installing frontend dependencies...
  pushd "%ROOT_DIR%" >nul
  call npm install
  if errorlevel 1 (
    popd >nul
    echo [ERROR] npm install failed.
    exit /b 1
  )
  popd >nul
)

REM Parse arguments
set "DO_DEBUG="
set "NO_CLEAN="

:parse_args
if "%~1"=="" goto :done_args
if /I "%~1"=="--debug"    ( set "DO_DEBUG=1" & shift & goto :parse_args )
if /I "%~1"=="--no-clean" ( set "NO_CLEAN=1" & shift & goto :parse_args )
shift
goto :parse_args
:done_args

REM Clean by default unless --no-clean is specified
if not defined NO_CLEAN (
  echo [INFO] Cleaning build cache...
  pushd "%TAURI_DIR%" >nul
  cargo clean
  popd >nul
  echo [INFO] Build cache cleaned.
)

pushd "%ROOT_DIR%" >nul

if defined DO_DEBUG (
  echo [INFO] Running: npm run tauri build -- --debug
  call npm run tauri build -- --debug
) else (
  echo [INFO] Running: npm run tauri build
  call npm run tauri build
)

set "BUILD_CODE=%ERRORLEVEL%"
popd >nul

if not "%BUILD_CODE%"=="0" (
  echo [ERROR] Build failed with code %BUILD_CODE%.
  exit /b %BUILD_CODE%
)

echo.
echo [OK] Build finished.
if defined DO_DEBUG (
  echo [INFO] Build artifacts: %TAURI_DIR%\target\debug\
  set "OUTPUT_DIR=%TAURI_DIR%\target\debug"
  if exist "%TAURI_DIR%\target\debug\bundle" (
    set "OUTPUT_DIR=%TAURI_DIR%\target\debug\bundle"
  )
) else (
  echo [INFO] Build artifacts: %TAURI_DIR%\target\release\
  set "OUTPUT_DIR=%TAURI_DIR%\target\release\bundle"
  if not exist "%OUTPUT_DIR%" (
    set "OUTPUT_DIR=%TAURI_DIR%\target\release"
  )
)
echo [INFO] Bundles (Windows exe/msi): %TAURI_DIR%\target\release\bundle
if exist "%OUTPUT_DIR%" (
  echo [INFO] Opening output directory: %OUTPUT_DIR%
  start "" "%OUTPUT_DIR%"
) else (
  echo [WARN] Output directory not found: %OUTPUT_DIR%
)

if /I "%BUILD_APP_AUTO_CLOSE%"=="0" (
  exit /b 0
)

exit 0
