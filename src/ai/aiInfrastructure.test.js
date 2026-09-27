import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

test('mounts the AI settings extension without disturbing existing root siblings', () => {
  const main = read('../main.jsx')
  assert.match(main, /const AiSettingsSection = lazy\(\(\) => import\('\.\/ai\/AiSettingsSection\.jsx'\)\)/)
  assert.match(main, /<App \/>[\s\S]*<BranchManagementLayer \/>[\s\S]*<WorkingChangesLayer \/>[\s\S]*<AiSettingsSection \/>/)
  assert.match(main, /<Suspense fallback=\{null\}>/)
  assert.match(main, /import '\.\/ai\/AiStage1Polish\.css'/)
})

test('AI settings expose secure configuration, model discovery, and request feedback', () => {
  const source = read('AiSettingsSection.jsx')
  assert.match(source, /import CustomSelect from '\.\.\/CustomSelect\.jsx'/)
  assert.match(source, /invoke\('get_ai_configuration_status'\)/)
  assert.match(source, /invoke\('save_ai_configuration'/)
  assert.match(source, /invoke\('set_ai_api_key'/)
  assert.match(source, /invoke\('clear_ai_api_key'\)/)
  assert.match(source, /invoke\('list_ai_models'/)
  assert.match(source, /invoke\('test_ai_connection'/)
  assert.match(source, /invoke\('cancel_ai_request'/)
  assert.match(source, /listen\(AI_PROGRESS_EVENT/)
  assert.match(source, /NON_CANCELLABLE_REQUEST_PHASES/)
  assert.match(source, /requestCancellable/)
  assert.match(source, /正在取消 AI 请求/)
  assert.match(source, /正在保存并准备 AI 配置/)
  assert.match(source, /前端不会读取或回显已保存的明文 Key/)
  assert.match(source, /拉取模型/)
  assert.match(source, /searchable/)
  assert.match(source, /disabled=\{formDisabled \|\| !status\.hasApiKey\}/)
})

test('AI settings use the native settings typography instead of bold custom labels', () => {
  const source = read('AiSettingsSection.jsx')
  const polish = read('AiStage1Polish.css')
  const settingLabel = source.slice(source.indexOf('function SettingLabel'), source.indexOf('function RequestFeedback'))
  assert.match(settingLabel, /className="settings__label ai-settings-label"/)
  assert.doesNotMatch(settingLabel, /<strong>/)
  assert.match(polish, /\.settings__label\.ai-settings-label \{[\s\S]*color: var\(--text-secondary\);[\s\S]*font-size: 13px;[\s\S]*font-weight: 400;/)
  assert.match(polish, /\.settings__label\.ai-settings-label small \{[\s\S]*font-weight: 400;/)
  assert.match(polish, /\.ai-model-overrides label \{[\s\S]*font-weight: 400;/)
})

test('AI input rows use the full settings width instead of narrow fixed inputs', () => {
  const css = read('Ai.css')
  assert.match(css, /\.ai-settings-section \.ai-settings-row \{[\s\S]*display: grid;[\s\S]*grid-template-columns: minmax\(176px, 0\.46fr\) minmax\(0, 1\.54fr\);/)
  assert.match(css, /\.ai-settings-input \{[\s\S]*width: 100%;[\s\S]*min-width: 0;/)
  assert.match(css, /\.ai-key-control \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto auto;/)
  assert.match(css, /\.ai-model-picker__input-row \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/)
})

test('the AI action divider keeps the same spacing as every settings row divider', () => {
  const css = read('Ai.css')
  const polish = read('AiStage1Polish.css')

  // Rows own the space above their divider through their own vertical padding.
  assert.match(css, /\.ai-settings-section \.ai-settings-row \{[^}]*padding: 15px 0;/)
  // So the action bar must not add a second top gap above its divider.
  assert.match(css, /\.ai-settings-actions \{[^}]*margin-top: 0;[^}]*padding-top: 15px;/)
  assert.match(polish, /\.ai-settings-section \.ai-settings-actions \{[^}]*margin-top: 0;/)
  assert.doesNotMatch(polish, /\.ai-settings-section \.ai-settings-actions \{[^}]*margin-top: 16px;/)
  // A visible feedback or save message supplies that separation instead.
  assert.match(
    css,
    /\.ai-settings-section \.ai-request-feedback \+ \.ai-settings-actions,[\s\S]*?\.ai-settings-section \.ai-save-message \+ \.ai-settings-actions \{[^}]*margin-top: 12px;/,
  )
})

test('AI loading feedback matches the 93bbf48 inline structure with fixed in-flight dimensions', () => {
  const source = read('AiSettingsSection.jsx')
  const polish = read('AiStage1Polish.css')
  const feedbackSource = source.slice(source.indexOf('function RequestFeedback'), source.indexOf('export default function AiSettingsSection'))
  assert.match(feedbackSource, /if \(request\.status === 'idle'\) return null/)
  assert.match(source, /<RequestFeedback request=\{request\} \/>/)
  assert.match(source, /\{saveMessage \? <div className="ai-save-message" role="status">\{saveMessage\}<\/div> : null\}/)
  assert.doesNotMatch(source, /SecondaryFeedback|feedbackClosing|FEEDBACK_SUCCESS_MS|ai-feedback-stack/)
  assert.match(polish, /\.ai-settings-section \.ai-request-feedback \{[\s\S]*height: 64px;[\s\S]*min-height: 64px;[\s\S]*max-height: 64px;/)
  assert.match(polish, /\.ai-settings-section \.ai-settings-actions \{[\s\S]*display: flex;[\s\S]*justify-content: flex-end;/)
  assert.match(polish, /\.ai-settings-section \.ai-settings-actions > \.ai-primary-button,[\s\S]*width: 96px;/)
  assert.doesNotMatch(polish, /grid-template-rows: 0fr|position: fixed|ai-feedback-stack--visible/)
})

test('clearing the key also clears and persists all model choices', () => {
  const source = read('AiSettingsSection.jsx')
  assert.match(source, /defaultModel: '',[\s\S]*reviewModel: '',[\s\S]*commitModel: ''/)
  assert.match(source, /invoke\('clear_ai_api_key'\)[\s\S]*invoke\('save_ai_configuration'/)
  assert.match(source, /API Key 和模型设置已清除/)
})

test('model dropdown uses separated white cards and the branch tooltip interaction', () => {
  const select = read('../CustomSelect.jsx')
  const polish = read('AiStage1Polish.css')
  assert.match(select, /APP_TOOLTIP_DELAY_MS/)
  assert.match(select, /isTextVisuallyTruncated/)
  assert.match(select, /AppTooltipSurface anchor=\{tooltip\.anchor\} text=\{tooltip\.text\}/)
  assert.doesNotMatch(select, /title=\{option\.title/)
  assert.match(polish, /\[data-theme="light"\][\s\S]*\.custom-select__menu \{[\s\S]*background: #ffffff;/)
  assert.match(polish, /\.custom-select__options \{[\s\S]*display: grid;[\s\S]*gap: 6px;/)
  assert.match(polish, /\.custom-select__option-label \{[\s\S]*text-overflow: ellipsis;/)
})

test('Rust command boundary never returns the API key or connection model output', () => {
  const schema = read('../../src-tauri/src/ai/schema.rs')
  const commands = read('../../src-tauri/src/ai/commands.rs')
  assert.match(schema, /pub struct AiConfigurationStatus/)
  assert.match(schema, /pub has_api_key: bool/)
  assert.doesNotMatch(schema, /AiConfigurationStatus[\s\S]*pub api_key:/)
  assert.match(schema, /pub struct AiConnectionTestResult/)
  assert.doesNotMatch(schema, /response_preview|response_content|provider_output/)
  assert.match(schema, /pub struct AiModelListResult/)
  assert.match(commands, /pub async fn set_ai_api_key/)
  assert.match(commands, /pub async fn clear_ai_api_key/)
  assert.match(commands, /pub async fn list_ai_models/)
  assert.match(commands, /pub async fn cancel_ai_request/)
})

test('Rust client bounds responses, sanitizes models, classifies failures, and emits progress', () => {
  const client = read('../../src-tauri/src/ai/client.rs')
  assert.match(client, /const MAX_AI_RESPONSE_BYTES: usize = 256 \* 1024/)
  assert.match(client, /const MAX_MODEL_LIST_RESPONSE_BYTES: usize = 1024 \* 1024/)
  assert.match(client, /const MAX_MODEL_COUNT: usize = 2_000/)
  assert.match(client, /while let Some\(chunk\) = response/)
  assert.match(client, /extract_model_ids/)
  assert.match(client, /sanitize_model_id/)
  assert.match(client, /AI_AUTH_FAILED/)
  assert.match(client, /AI_RATE_LIMITED/)
  assert.match(client, /AI_TIMEOUT/)
  assert.match(client, /AI_INVALID_RESPONSE/)
  assert.match(client, /AI_PROGRESS_EVENT/)
  assert.match(client, /sanitize_provider_error_message/)
})

test('API keys are isolated to stable operating-system keychain identifiers', () => {
  const secrets = read('../../src-tauri/src/ai/secrets.rs')
  assert.match(secrets, /AI_KEYRING_SERVICE: &str = "GitSync\.AI"/)
  assert.match(secrets, /AI_KEYRING_ACCOUNT: &str = "default-provider-api-key"/)
  assert.match(secrets, /entry\.set_password\(&normalized\)/)
  assert.match(secrets, /entry\.get_password\(\)/)
  assert.match(secrets, /entry\.delete_credential\(\)/)
  assert.match(secrets, /keyring::Error::NoEntry/)
})

test('Tauri registers all Stage 1 commands', () => {
  const lib = read('../../src-tauri/src/lib.rs')
  for (const command of [
    'get_ai_configuration_status',
    'save_ai_configuration',
    'set_ai_api_key',
    'clear_ai_api_key',
    'list_ai_models',
    'test_ai_connection',
    'cancel_ai_request',
  ]) {
    assert.match(lib, new RegExp(`ai::commands::${command}`))
  }
})
