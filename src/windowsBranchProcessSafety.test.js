import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function assertUsesNoWindowGitRunner(source) {
  assert.match(source, /new_(read_only|mutation)_async_command/)
  assert.match(source, /\.kill_on_drop\(true\)/)
  assert.equal(
    Array.from(source.matchAll(/crate::git_command::new_(?:read_only|mutation)_async_command/g)).length > 0,
    true,
    'branch backend modules must create git through the shared cross-platform builder'
  )
}

test('uses hidden child processes for every hover-triggered and branch-creation Git command path on Windows', () => {
  const commands = readSource('src-tauri/src/commands.rs')
  const branchManagement = readSource('src-tauri/src/branch_management.rs')
  const branchCreation = [
    'src-tauri/src/branch_creation/mod.rs',
    'src-tauri/src/branch_creation/git.rs',
    'src-tauri/src/branch_creation/source.rs',
    'src-tauri/src/branch_creation/operation.rs',
    'src-tauri/src/branch_creation/operation_mutation.rs',
    'src-tauri/src/branch_creation/operation_steps.rs',
    'src-tauri/src/branch_creation/operation_result.rs',
    'src-tauri/src/branch_creation/commands.rs',
    'src-tauri/src/branch_creation/commands_execute.rs',
    'src-tauri/src/branch_creation/commands_resume.rs',
  ].map(readSource).join('\n')
  const branchNaming = [
    'src-tauri/src/ai/branch_name.rs',
    'src-tauri/src/ai/branch_name_request.rs',
    'src-tauri/src/ai/branch_name_prompt.rs',
    'src-tauri/src/ai/branch_name_http.rs',
    'src-tauri/src/ai/branch_name_http_errors.rs',
    'src-tauri/src/ai/branch_name_http_request.rs',
    'src-tauri/src/ai/branch_name_commands.rs',
  ].map(readSource).join('\n')
  const branchDelete = readSource('src-tauri/src/branch_delete.rs')
  const gitCommand = readSource('src-tauri/src/git_command.rs')
  const lib = readSource('src-tauri/src/lib.rs')

  assert.match(commands, /fn new_git_async_command\(repo_path: &str, args: &\[&str\]\) -> tokio::process::Command/)
  assert.match(commands, /crate::git_command::new_read_only_async_command\(repo_path, args\)/)
  assert.match(gitCommand, /std::os::windows::process::CommandExt/)
  assert.match(gitCommand, /const CREATE_NO_WINDOW: u32 = 0x08000000/)
  assert.match(gitCommand, /command\.creation_flags\(CREATE_NO_WINDOW\)/)
  assertUsesNoWindowGitRunner(branchManagement)
  assertUsesNoWindowGitRunner(branchCreation)
  assertUsesNoWindowGitRunner(branchNaming)
  assertUsesNoWindowGitRunner(branchDelete)

  assert.match(lib, /commands::get_repo_status/)
  assert.match(lib, /commands::get_repo_branch_overview/)
  assert.match(lib, /branch_management::get_repo_branch_management_meta/)
  assert.match(lib, /branch_management::sync_repo_branch/)
  assert.match(lib, /branch_creation::inspect_repo_branch_creation/)
  assert.match(lib, /branch_creation::execute_repo_branch_creation/)
  assert.match(lib, /branch_creation::resume_repo_branch_creation/)
  assert.match(lib, /branch_creation::reconcile_repo_branch_creation/)
  assert.match(lib, /ai::branch_name::generate_ai_branch_names/)
  assert.match(lib, /branch_delete::delete_repo_branches_batch/)
  assert.doesNotMatch(lib, /force_branch_delete/)
  assert.doesNotMatch(lib, /^\s*mod\s+branch_management_meta\s*;/m)
  assert.doesNotMatch(lib, /branch_management_meta::/)
})

test('does not reintroduce frontend focus replay or metadata command aliases', () => {
  const main = readSource('src/main.jsx')
  const packageJson = readSource('package.json')
  const bridge = readSource('src/tauriCoreBridge.js')

  assert.doesNotMatch(main, /nativeWindowFocusBridge|installNativeWindowFocusBridge|onFocusChanged/)
  assert.doesNotMatch(packageJson, /nativeWindowFocusBridge\.test/)
  assert.doesNotMatch(bridge, /get_repo_branch_management_meta_no_window|BRANCH_MANAGEMENT_META_NO_WINDOW_COMMAND/)
})

test('retains unrelated Tauri commands while adding branch creation', () => {
  const lib = readSource('src-tauri/src/lib.rs')
  const requiredCommands = [
    'ai::commands::cancel_ai_request',
    'commands::github_start_device_auth',
    'commands::github_poll_token',
    'commands::github_get_account',
    'commands::github_get_repos',
    'commands::github_logout',
    'commands::write_clipboard',
  ]

  requiredCommands.forEach((command) => {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(lib, new RegExp(escaped))
  })
})

test('write_clipboard uses a cross-platform native clipboard implementation', () => {
  const cargo = readSource('src-tauri/Cargo.toml')
  const commands = readSource('src-tauri/src/commands.rs')

  assert.match(cargo, /arboard\s*=\s*\{\s*version\s*=\s*"3\.6\.1",\s*default-features\s*=\s*false\s*\}/)
  assert.match(commands, /use arboard::Clipboard;/)
  assert.match(commands, /let mut clipboard\s*=\s*Clipboard::new\(\)/)
  assert.match(commands, /clipboard\s*\.set_text\(text\.to_string\(\)\)/)
  assert.doesNotMatch(commands, /当前平台暂不支持写入剪贴板/)
})
