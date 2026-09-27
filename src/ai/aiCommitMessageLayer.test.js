import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

test('mounts the commit message layer after working changes ownership', () => {
  const main = read('../main.jsx')
  assert.match(main, /const AiCommitMessageLayer = lazy\(\(\) => import\('\.\/ai\/AiCommitMessageLayer\.jsx'\)\)/)
  const working = main.indexOf('<WorkingChangesLayer />')
  const commit = main.indexOf('<AiCommitMessageLayer />')
  const settings = main.indexOf('<AiSettingsSection />')
  assert.ok(working >= 0 && working < commit && commit < settings)
})

test('commit generation uses a fresh checked-file scope and never overwrites newer manual text silently', () => {
  const source = read('AiCommitMessageLayer.jsx')
  assert.match(source, /const selectedScope = readSelectedCommitScope\(document\)/)
  assert.match(source, /const freshTargets = freshScope\.targets/)
  assert.match(source, /invoke\('get_repo_working_diff_summary', \{ repoPath: context\.repoPath \}\)/)
  assert.match(source, /当前未提交改动的 authority 尚未准备好/)
  assert.match(source, /invoke\('generate_ai_commit_message'/)
  assert.match(source, /repoPath: context\.repoPath/)
  assert.match(source, /files: freshTargets/)
  assert.match(source, /shouldConfirmCommitMessageOverwrite/)
  assert.match(source, /覆盖并生成/)
  assert.match(source, /if \(textareaNode\.value !== startMessage\)/)
  assert.match(source, /setPendingResult\(normalized\)/)
  assert.match(source, /应用生成结果/)
  assert.match(source, /setControlledTextareaValue\(textareaNode, generatedResult\.message\)/)
})

test('commit cancellation is unavailable until backend progress confirms registration', () => {
  const source = read('AiCommitMessageLayer.jsx')
  assert.match(source, /NON_CANCELLABLE_PHASES = new Set\(\['starting', 'cancelling'\]\)/)
  assert.match(source, /const requestCancellable = requestBusy && !NON_CANCELLABLE_PHASES\.has\(request\.phase\)/)
  assert.match(source, /if \(!requestId \|\| !requestCancellable\) return/)
  assert.match(source, /requestCancellable \? \(/)
  assert.match(source, /invoke\('cancel_ai_request'/)
})

test('backend captures bounded sanitized input and rejects a changed post-generation snapshot', () => {
  const commands = read('../../src-tauri/src/ai/commands.rs')
  const snapshot = read('../../src-tauri/src/ai/snapshot.rs')
  const prompt = read('../../src-tauri/src/ai/prompts.rs')
  const client = read('../../src-tauri/src/ai/commit_message.rs')
  const lib = read('../../src-tauri/src/lib.rs')

  assert.match(commands, /pub async fn generate_ai_commit_message/)
  assert.match(commands, /let original_fingerprint = snapshot\.fingerprint\.clone\(\)/)
  assert.match(commands, /capture_commit_snapshot\(&repo_path, &files, &state, false\)/)
  assert.match(commands, /AI_SCOPE_CHANGED/)
  assert.match(snapshot, /MAX_COMMIT_FILE_PATCH_BYTES: usize = 96 \* 1024/)
  assert.match(snapshot, /MAX_COMMIT_TOTAL_PATCH_BYTES: usize = 256 \* 1024/)
  assert.match(snapshot, /resolve_selected_records/)
  assert.match(snapshot, /is_sensitive_path/)
  assert.match(snapshot, /sanitize_diff_content/)
  assert.match(snapshot, /crate::repo_git_lock::acquire/)
  assert.match(snapshot, /PatchInput::SummaryOnly/)
  assert.match(prompt, /COMMIT_MESSAGE_PROMPT_VERSION: &str = "commit-message-v1"/)
  assert.match(prompt, /untrusted repository data/)
  assert.match(prompt, /Do not claim tests passed/)
  assert.match(client, /normalize_generated_commit_message/)
  assert.match(lib, /ai::commands::generate_ai_commit_message/)
})

test('commit-loading spinner is vertically centered inside the action button', () => {
  const css = read('AiCommitMessageLayer.css')

  assert.match(css, /\.ai-commit-button \.ai-commit-spinner\s*\{[\s\S]*?margin-top:\s*0;/)
})
