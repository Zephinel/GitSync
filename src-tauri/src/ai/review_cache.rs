use crate::ai::limits::{
    AI_CONFIG_VERSION, MAX_REVIEW_CACHE_ENTRIES, REVIEW_CACHE_TTL_SECONDS, REVIEW_PIPELINE_VERSION,
};
use crate::ai::provider::NormalizedAiEndpoint;
use crate::ai::review::REVIEW_PROMPT_VERSION;
use crate::ai::schema::{AiProviderConfig, AiReviewDelivery};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone)]
struct ReviewCacheEntry {
    inserted_at: Instant,
    result: AiReviewDelivery,
}

static REVIEW_CACHE: OnceLock<Mutex<HashMap<String, ReviewCacheEntry>>> = OnceLock::new();
static REVIEW_CACHE_GENERATION: AtomicU64 = AtomicU64::new(1);

fn cache() -> &'static Mutex<HashMap<String, ReviewCacheEntry>> {
    REVIEW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn build_review_cache_key(
    config: &AiProviderConfig,
    endpoint: &NormalizedAiEndpoint,
    snapshot_fingerprint: &str,
    scope_kind: &str,
) -> String {
    let model = config
        .review_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(config.default_model.as_str())
        .trim();
    let generation = REVIEW_CACHE_GENERATION.load(Ordering::Acquire);
    let material = format!(
        "{AI_CONFIG_VERSION}\0{REVIEW_PIPELINE_VERSION}\0{REVIEW_PROMPT_VERSION}\0{generation}\0{}\0{}\0{:?}\0{}\0{}",
        endpoint.chat_completions_url,
        model,
        config.output_language,
        config.timeout_seconds,
        scope_kind.trim(),
    ) + "\0" + snapshot_fingerprint;
    format!("review-cache-{:016x}", fnv1a64(material.as_bytes()))
}

pub async fn get_cached_review(key: &str, request_id: &str) -> Option<AiReviewDelivery> {
    let mut entries = cache().lock().await;
    purge_expired(&mut entries);
    let mut result = entries.get(key)?.result.clone();
    result.review.request_id = request_id.to_string();
    result.cache_hit = true;
    Some(result)
}

pub async fn put_cached_review(key: String, result: &AiReviewDelivery) {
    if result.partial_success || result.review.stale {
        return;
    }
    let mut entries = cache().lock().await;
    purge_expired(&mut entries);
    if entries.len() >= MAX_REVIEW_CACHE_ENTRIES {
        if let Some(oldest_key) = entries
            .iter()
            .min_by_key(|(_, entry)| entry.inserted_at)
            .map(|(key, _)| key.clone())
        {
            entries.remove(&oldest_key);
        }
    }
    let mut stored = result.clone();
    stored.cache_hit = false;
    entries.insert(
        key,
        ReviewCacheEntry {
            inserted_at: Instant::now(),
            result: stored,
        },
    );
}

pub async fn clear_review_cache() {
    REVIEW_CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    cache().lock().await.clear();
}

fn purge_expired(entries: &mut HashMap<String, ReviewCacheEntry>) {
    let ttl = Duration::from_secs(REVIEW_CACHE_TTL_SECONDS);
    entries.retain(|_, entry| entry.inserted_at.elapsed() <= ttl);
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::{build_review_cache_key, clear_review_cache, get_cached_review, put_cached_review};
    use crate::ai::provider::normalize_endpoint;
    use crate::ai::schema::{AiProviderConfig, AiReviewDelivery, AiReviewResult};

    fn sample_result() -> AiReviewDelivery {
        AiReviewDelivery {
            review: AiReviewResult {
                request_id: "original".to_string(),
                model: "model-a".to_string(),
                provider_host: "localhost".to_string(),
                summary: "summary".to_string(),
                overall_risk: "low".to_string(),
                findings: Vec::new(),
                positive_notes: Vec::new(),
                test_suggestions: Vec::new(),
                scope_kind: "all".to_string(),
                scope_label: "全部未提交文件".to_string(),
                selected_file_count: 1,
                included_file_count: 1,
                excluded_files: Vec::new(),
                summary_only_files: Vec::new(),
                binary_files: Vec::new(),
                sanitized_bytes: 10,
                redacted_line_count: 0,
                snapshot_fingerprint: "fingerprint".to_string(),
                current_snapshot_fingerprint: "fingerprint".to_string(),
                stale: false,
            },
            batch_count: 1,
            completed_batch_count: 1,
            completed_file_count: 1,
            failed_batch_count: 0,
            partial_success: false,
            batch_failures: Vec::new(),
            cache_hit: false,
            pipeline_version: "review-pipeline-v2".to_string(),
        }
    }

    #[tokio::test]
    async fn stores_sanitized_results_and_versions_cache_after_invalidation() {
        clear_review_cache().await;
        let config = AiProviderConfig {
            endpoint: "http://127.0.0.1:1234/v1".to_string(),
            default_model: "model-a".to_string(),
            ..AiProviderConfig::default()
        };
        let endpoint = normalize_endpoint(&config.endpoint).unwrap();
        let key = build_review_cache_key(&config, &endpoint, "fingerprint", "all");
        put_cached_review(key.clone(), &sample_result()).await;
        let cached = get_cached_review(&key, "new-request").await.unwrap();
        assert_eq!(cached.review.request_id, "new-request");
        assert_eq!(cached.completed_file_count, 1);
        assert!(cached.cache_hit);

        clear_review_cache().await;
        let next_key = build_review_cache_key(&config, &endpoint, "fingerprint", "all");
        assert_ne!(key, next_key);
        assert!(get_cached_review(&key, "old-generation").await.is_none());
    }

    #[test]
    fn cache_key_changes_with_snapshot_and_model() {
        let mut config = AiProviderConfig {
            endpoint: "http://127.0.0.1:1234/v1".to_string(),
            default_model: "model-a".to_string(),
            ..AiProviderConfig::default()
        };
        let endpoint = normalize_endpoint(&config.endpoint).unwrap();
        let first = build_review_cache_key(&config, &endpoint, "one", "all");
        let second = build_review_cache_key(&config, &endpoint, "two", "all");
        config.default_model = "model-b".to_string();
        let third = build_review_cache_key(&config, &endpoint, "one", "all");
        assert_ne!(first, second);
        assert_ne!(first, third);
    }
}
