import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const readBackend = () => [
  '../src-tauri/src/branch_creation/mod.rs',
  '../src-tauri/src/branch_creation/git.rs',
  '../src-tauri/src/branch_creation/source.rs',
  '../src-tauri/src/branch_creation/operation.rs',
  '../src-tauri/src/branch_creation/operation_mutation.rs',
  '../src-tauri/src/branch_creation/operation_steps.rs',
  '../src-tauri/src/branch_creation/operation_result.rs',
  '../src-tauri/src/branch_creation/commands.rs',
  '../src-tauri/src/branch_creation/commands_execute.rs',
  '../src-tauri/src/branch_creation/commands_resume.rs',
].map(read).join('\n')

const readAi = () => [
  '../src-tauri/src/ai/branch_name.rs',
  '../src-tauri/src/ai/branch_name_request.rs',
  '../src-tauri/src/ai/branch_name_prompt.rs',
  '../src-tauri/src/ai/branch_name_http.rs',
  '../src-tauri/src/ai/branch_name_http_errors.rs',
  '../src-tauri/src/ai/branch_name_http_request.rs',
  '../src-tauri/src/ai/branch_name_commands.rs',
].map(read).join('\n')

test('branch creation is owned by the real complete-view component', () => {
  const main = read('./main.jsx')
  const layer = read('./BranchManagementLayer.jsx')
  assert.match(main, /<BranchManagementLayer \/>/)
  assert.doesNotMatch(main, /BranchCreationLayer|BranchManagementSwitchActionLayer/)
  assert.match(layer, /<BranchCreationDialog/)
  assert.match(layer, /className="branch-management-create-header branch-management-btn"/)
  assert.match(layer, /className="branch-management-create-row"/)
})

test('dialog defaults are conservative and AI is user-triggered only', () => {
  const dialog = read('./BranchCreationDialog.jsx')
  assert.match(dialog, /useState\(true\)[\s\S]*setSwitchAfterCreate/)
  assert.match(dialog, /useState\(false\)[\s\S]*setPublish/)
  assert.match(dialog, /useState\(false\)[\s\S]*setIncludeRepositoryContext/)
  assert.match(dialog, /onClick=\{generateAiSuggestions\}/)
  assert.doesNotMatch(dialog, /useEffect\(\(\) => \{[\s\S]{0,300}generateAiSuggestions\(/)
})

test('AI suggestions keep selection synchronized with the editable branch name', () => {
  const dialog = read('./BranchCreationDialog.jsx')
  const css = read('./BranchManagementActions.css')
  assert.match(dialog, /const selected = branchName\.trim\(\) === suggestion\.name/)
  assert.match(dialog, /branch-creation-suggestion--selected/)
  assert.match(dialog, /aria-pressed=\{selected\}/)
  assert.match(dialog, /onClick=\{\(\) => setBranchName\(suggestion\.name\)\}/)
  assert.match(css, /\.branch-creation-suggestions \.branch-creation-suggestion--selected/)
  assert.match(css, /content: '✓ 已选择'/)
})

test('source inspection is refreshed before mutation and divergence requires an explicit choice', () => {
  const backend = readBackend()
  assert.match(backend, /inspect_with_remote_refresh_locked\(&path, &request\.source\)\.await\?/)
  assert.match(backend, /acquire_remote_refresh_guard\(state, path\)\.await\?/)
  assert.match(backend, /inspection\.fingerprint != request\.inspection_fingerprint/)
  assert.match(backend, /"diverged" => None/)
  assert.match(backend, /requires_source_choice: relationship == "diverged"/)
})

test('local creation is a ref transaction and publishing never force-updates', () => {
  const backend = readBackend()
  assert.match(backend, /"update-ref", "--stdin", "--create-reflog"/)
  assert.match(backend, /\["push", "--porcelain", remote, refspec\.as_str\(\)\]/)
  assert.doesNotMatch(backend, /--force|force-with-lease|"-f"/)
  assert.doesNotMatch(backend, /\["merge"|\["rebase"|\["reset"/)
})

test('duplicate execution only reconciles and explicit resume continues incomplete work', () => {
  const backend = readBackend()
  const duplicateBlock = backend.match(/if let Some\(mut journal\) = load_journal[\s\S]*?return Ok\(result\);/)?.[0] || ''
  assert.match(duplicateBlock, /reconcile_journal_and_persist_without_repo_mutation/)
  assert.doesNotMatch(duplicateBlock, /execute_pending_steps/)
  assert.match(backend, /pub async fn resume_repo_branch_creation/)
})

test('AI naming sends minimal data and cannot decide Git operations', () => {
  const ai = readAi()
  assert.match(ai, /let samples = if request\.include_repository_context/)
  assert.match(ai, /must never choose a Git source, switch policy, publish policy, remote, or execute any repository operation/)
  assert.doesNotMatch(ai, /git diff|recent commit|file content|file path/i)
})

test('backend commands are registered and Git children are hidden on Windows', () => {
  const lib = read('../src-tauri/src/lib.rs')
  const gitCommand = read('../src-tauri/src/git_command.rs')
  const backend = readBackend()
  const ai = readAi()
  for (const command of [
    'branch_creation::inspect_repo_branch_creation',
    'branch_creation::validate_repo_branch_creation_name',
    'branch_creation::execute_repo_branch_creation',
    'branch_creation::resume_repo_branch_creation',
    'branch_creation::reconcile_repo_branch_creation',
    'ai::branch_name::generate_ai_branch_names',
    'ai::branch_name::cancel_ai_branch_name_request',
  ]) assert.match(lib, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(gitCommand, /std::os::windows::process::CommandExt/)
  assert.match(gitCommand, /const CREATE_NO_WINDOW: u32 = 0x08000000/)
  assert.match(gitCommand, /command\.creation_flags\(CREATE_NO_WINDOW\)/)
  for (const source of [backend, ai]) {
    assert.match(source, /new_(read_only|mutation)_async_command/)
    assert.match(source, /\.kill_on_drop\(true\)/)
  }
})
