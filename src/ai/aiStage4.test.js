import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatAiReviewForClipboard,
  normalizeAiReviewPreview,
  normalizeAiReviewResult,
} from './aiReview.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relativePath) => readFileSync(join(here, relativePath), 'utf8')

test('normalizes truthful batch preview and partial-success metadata', () => {
  const preview = normalizeAiReviewPreview({
    scopeKind: 'all',
    selectedFileCount: 17,
    includedFileCount: 14,
    batchCount: 3,
    batchFileLimit: 8,
    pipelineVersion: 'review-pipeline-v2',
  })
  assert.equal(preview.batchCount, 3)
  assert.equal(preview.batchFileLimit, 8)

  const result = normalizeAiReviewResult({
    requestId: 'review-1',
    summary: 'Partial result',
    overallRisk: 'high',
    selectedFileCount: 17,
    batchCount: 3,
    completedBatchCount: 2,
    completedFileCount: 16,
    failedBatchCount: 1,
    partialSuccess: true,
    cacheHit: false,
    pipelineVersion: 'review-pipeline-v2',
    batchFailures: [{
      batchIndex: 3,
      fileCount: 1,
      code: 'AI_TIMEOUT',
      message: 'Timed out',
      retryable: true,
    }],
  })
  assert.equal(result.batchCount, 3)
  assert.equal(result.completedBatchCount, 2)
  assert.equal(result.completedFileCount, 16)
  assert.equal(result.failedBatchCount, 1)
  assert.equal(result.partialSuccess, true)
  assert.equal(result.batchFailures[0].code, 'AI_TIMEOUT')
  const copied = formatAiReviewForClipboard(result)
  assert.match(copied, /Reviewed files: 16\/17/)
  assert.match(copied, /Partial coverage/)
})

test('Stage 4 Rust pipeline centralizes new limits, batches deterministically and bounds cache state', () => {
  const limits = read('../../src-tauri/src/ai/limits.rs')
  const batching = read('../../src-tauri/src/ai/batching.rs')
  const pipeline = read('../../src-tauri/src/ai/review_pipeline.rs')
  const cache = read('../../src-tauri/src/ai/review_cache.rs')
  const commands = read('../../src-tauri/src/ai/review_commands.rs')
  const settingsCommands = read('../../src-tauri/src/ai/commands.rs')
  const schema = read('../../src-tauri/src/ai/schema.rs')

  assert.match(limits, /REVIEW_PIPELINE_VERSION: &str = "review-pipeline-v2"/)
  assert.match(limits, /MAX_REVIEW_BATCH_FILES: usize = 8/)
  assert.match(limits, /REVIEW_CACHE_TTL_SECONDS: u64 = 300/)
  assert.match(batching, /pub fn deterministic_target_batches/)
  assert.match(batching, /chunks\(MAX_REVIEW_BATCH_FILES\)/)
  assert.match(batching, /pub fn merge_review_batches/)
  assert.match(batching, /completed_file_count/)
  assert.match(pipeline, /MAX_BATCH_ATTEMPTS: usize = 2/)
  assert.match(pipeline, /pub async fn capture_stable_review_plan/)
  assert.match(pipeline, /if first\.snapshots\.len\(\) <= 1/)
  assert.match(pipeline, /preview\.snapshot_fingerprint = self\.fingerprint\.clone\(\)/)
  assert.match(pipeline, /first\.fingerprint != second\.fingerprint/)
  assert.match(pipeline, /emit_batch_progress/)
  assert.match(pipeline, /put_cached_review/)
  assert.match(pipeline, /if successes\.is_empty\(\)/)
  assert.match(cache, /MAX_REVIEW_CACHE_ENTRIES/)
  assert.match(cache, /REVIEW_CACHE_GENERATION/)
  assert.match(cache, /purge_expired/)
  assert.match(cache, /fetch_add\(1, Ordering::AcqRel\)/)
  assert.match(commands, /capture_stable_review_plan/)
  assert.match(commands, /execute_review_plan/)
  assert.match(settingsCommands, /use crate::ai::review_cache::clear_review_cache;/)
  assert.match(settingsCommands, /save_ai_configuration[\s\S]*clear_review_cache\(\)\.await;/)
  assert.match(settingsCommands, /set_ai_api_key[\s\S]*clear_review_cache\(\)\.await;/)
  assert.match(settingsCommands, /clear_ai_api_key[\s\S]*clear_review_cache\(\)\.await;/)
  assert.match(schema, /pub struct AiReviewDelivery/)
  assert.match(schema, /pub completed_file_count: usize/)
  assert.match(schema, /pub struct AiReviewBatchFailure/)
})

test('provider contract fixtures cover OpenAI, OpenRouter, DeepSeek and local envelopes', () => {
  const fixtures = read('../../src-tauri/src/ai/provider_fixtures.rs')
  const modSource = read('../../src-tauri/src/ai/mod.rs')
  assert.match(fixtures, /accepts_openai_chat_completion_contract/)
  assert.match(fixtures, /accepts_openrouter_content_part_contract/)
  assert.match(fixtures, /accepts_deepseek_message_content_with_reasoning_metadata/)
  assert.match(fixtures, /accepts_local_legacy_text_contract/)
  assert.match(fixtures, /accepts_models_contract_variants/)
  assert.match(modSource, /#\[cfg\(test\)\][\s\S]*mod provider_fixtures;/)
})

test('Review response parsing accepts common wrappers without accepting prose-only output', () => {
  const review = read('../../src-tauri/src/ai/review.rs')
  assert.match(review, /"temperature": 0,/)
  assert.match(review, /fn parse_review_content\(value: &str\)/)
  assert.match(review, /fn balanced_json_object_end\(bytes: &\[u8\], start: usize\)/)
  assert.match(review, /parses_json_wrapped_in_fences_or_provider_commentary/)
  assert.match(review, /rejects_prose_without_a_structured_review_object/)
  assert.match(review, /no Markdown fences, analysis tags, preface, or trailing commentary/)
})

test('Review keeps in-scope findings when only the model line range is untrusted', () => {
  const review = read('../../src-tauri/src/ai/review.rs')
  assert.match(review, /Review finding 引用了分析范围之外的文件/)
  assert.match(review, /If you are not certain of an exact visible line, return null line fields/)
  assert.match(review, /fn validate_lines\([\s\S]*\) -> \(Option<u32>, Option<u32>\)/)
  assert.match(review, /scoped_lines\.is_empty\(\)[\s\S]*return \(None, None\)/)
  assert.match(review, /keeps_verified_lines_and_downgrades_untrusted_locations/)
  assert.doesNotMatch(review, /行号不在已分析的 Diff hunk 内/)
})

test('Stage 4 UI shows batch progress, cache hits and explicit partial coverage', () => {
  const layer = read('AiReviewLayer.jsx')
  const css = read('AiReviewStage4.css')
  const main = read('../main.jsx')

  assert.match(main, /import '\.\/ai\/AiReviewStage4\.css'/)
  assert.match(layer, /completedUnits/)
  assert.match(layer, /totalUnits/)
  assert.match(layer, /progress\.completedUnits == null/)
  assert.match(layer, /setRequest\(\(previous\) => \(\{/)
  assert.match(layer, /Review 部分完成/)
  assert.match(layer, /result\.completedFileCount\}\/\{result\.selectedFileCount/)
  assert.match(layer, /缓存命中/)
  assert.match(layer, /batchFailures/)
  assert.match(layer, /scopeKind: scope\.scopeKind/)
  assert.match(css, /\.ai-review-request__bar/)
  assert.match(css, /\.ai-review-partial/)
  assert.match(css, /\.ai-review-batch-failures/)
})

test('Review loading and terminal errors stay compact and avoid duplicate state cards', () => {
  const css = read('AiReviewStage4.css')
  assert.match(css, /\.ai-review-drawer > \.ai-review-request,[\s\S]*align-self: start;/)
  assert.match(css, /\.ai-review-request--failed,[\s\S]*display: none !important;/)
  assert.match(css, /\.ai-review-request--cancelled/)
  assert.match(css, /:has\(~ \.ai-review-drawer__error\)/)
})
