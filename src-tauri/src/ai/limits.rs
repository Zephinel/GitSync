//! Centralized AI Assistant v1 Stage 4 reliability and compatibility limits.
//!
//! Stage 4 batch, cache, and merged-delivery code must use this module. Earlier
//! accepted Stage 1–3 modules retain their local behavior-specific limits until a
//! dedicated behavior-preserving cleanup migrates them.

pub const AI_CONFIG_VERSION: &str = "ai-config-v1";
pub const REVIEW_PIPELINE_VERSION: &str = "review-pipeline-v2";

pub const MAX_PROVIDER_ERROR_CHARS: usize = 400;
pub const MAX_RECENT_SUBJECT_CHARS: usize = 180;

pub const MAX_SELECTED_FILES: usize = 200;
pub const MAX_REVIEW_BATCH_FILES: usize = 8;
pub const MAX_REVIEW_BATCHES: usize = 32;
pub const MAX_MERGED_REVIEW_FINDINGS: usize = 250;
pub const MAX_MERGED_REVIEW_LIST_ITEMS: usize = 100;
pub const MAX_ACTIVE_REVIEW_REQUESTS: usize = 8;
pub const MAX_PENDING_REVIEW_PREVIEWS: usize = 64;

pub const REVIEW_CACHE_TTL_SECONDS: u64 = 300;
pub const MAX_REVIEW_CACHE_ENTRIES: usize = 32;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_batch_capacity_covers_the_selected_file_limit() {
        assert!(MAX_REVIEW_BATCH_FILES > 0);
        assert!(MAX_REVIEW_BATCHES * MAX_REVIEW_BATCH_FILES >= MAX_SELECTED_FILES);
    }

    #[test]
    fn cache_limits_are_bounded() {
        assert!(MAX_REVIEW_CACHE_ENTRIES <= 64);
        assert!(REVIEW_CACHE_TTL_SECONDS <= 15 * 60);
    }
}
