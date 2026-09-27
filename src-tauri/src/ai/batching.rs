use crate::ai::errors::AiUiError;
use crate::ai::limits::{
    MAX_MERGED_REVIEW_FINDINGS, MAX_MERGED_REVIEW_LIST_ITEMS, MAX_REVIEW_BATCHES,
    MAX_REVIEW_BATCH_FILES, MAX_SELECTED_FILES, REVIEW_PIPELINE_VERSION,
};
use crate::ai::review::scope_kind_label;
use crate::ai::schema::{
    AiCommitInputNotice, AiReviewBatchFailure, AiReviewDelivery, AiReviewResult,
    AiReviewScopeDelivery, AiReviewScopePreview,
};
use crate::ai::snapshot::AiCommitSnapshot;
use crate::working_changes::WorkingChangeTarget;
use std::collections::HashSet;

pub fn deterministic_target_batches(
    targets: &[WorkingChangeTarget],
) -> Result<Vec<Vec<WorkingChangeTarget>>, AiUiError> {
    if targets.is_empty() {
        return Err(AiUiError::new(
            "AI_SNAPSHOT_FAILED",
            "没有可 Review 的文件",
            "请至少选择一个未提交文件。",
            false,
        ));
    }
    if targets.len() > MAX_SELECTED_FILES {
        return Err(AiUiError::new(
            "AI_SNAPSHOT_FAILED",
            "Review 文件过多",
            format!("单次 Review 最多支持 {MAX_SELECTED_FILES} 个文件。"),
            false,
        ));
    }

    let mut normalized = targets.to_vec();
    normalized.sort_by(|left, right| {
        left.path
            .replace('\\', "/")
            .cmp(&right.path.replace('\\', "/"))
            .then_with(|| left.old_path.cmp(&right.old_path))
            .then_with(|| left.expected_index_code.cmp(&right.expected_index_code))
            .then_with(|| {
                left.expected_worktree_code
                    .cmp(&right.expected_worktree_code)
            })
            .then_with(|| left.expected_is_untracked.cmp(&right.expected_is_untracked))
            .then_with(|| left.expected_authority_id.cmp(&right.expected_authority_id))
    });
    normalized.dedup_by(|left, right| {
        left.path == right.path
            && left.old_path == right.old_path
            && left.expected_index_code == right.expected_index_code
            && left.expected_worktree_code == right.expected_worktree_code
            && left.expected_is_untracked == right.expected_is_untracked
            && left.expected_authority_id == right.expected_authority_id
    });

    let batches = normalized
        .chunks(MAX_REVIEW_BATCH_FILES)
        .map(|chunk| chunk.to_vec())
        .collect::<Vec<_>>();
    if batches.len() > MAX_REVIEW_BATCHES {
        return Err(AiUiError::new(
            "AI_SNAPSHOT_FAILED",
            "Review 批次数量过多",
            "当前改动无法在安全批次数量内完成 Review。",
            false,
        ));
    }
    Ok(batches)
}

pub fn aggregate_snapshot_fingerprint(snapshots: &[AiCommitSnapshot], scope_kind: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    update_hash(&mut hash, REVIEW_PIPELINE_VERSION.as_bytes());
    update_hash(&mut hash, scope_kind.trim().as_bytes());
    for snapshot in snapshots {
        update_hash(&mut hash, snapshot.fingerprint.as_bytes());
        update_hash(&mut hash, &snapshot.selected_file_count.to_le_bytes());
        update_hash(&mut hash, &snapshot.sanitized_bytes.to_le_bytes());
    }
    format!("review-fnv1a64-{hash:016x}")
}

pub fn build_batched_scope_preview(
    snapshots: &[AiCommitSnapshot],
    scope_kind: &str,
    fingerprint: String,
) -> AiReviewScopeDelivery {
    let (scope_kind, scope_label) = scope_kind_label(scope_kind);
    AiReviewScopeDelivery {
        preview: AiReviewScopePreview {
            scope_kind: scope_kind.to_string(),
            scope_label: scope_label.to_string(),
            selected_file_count: snapshots.iter().map(|item| item.selected_file_count).sum(),
            included_file_count: snapshots.iter().map(|item| item.included_file_count).sum(),
            excluded_files: collect_notices(snapshots, |item| &item.excluded_files),
            summary_only_files: collect_notices(snapshots, |item| &item.summary_only_files),
            binary_files: collect_notices(snapshots, |item| &item.binary_files),
            sanitized_bytes: snapshots.iter().map(|item| item.sanitized_bytes).sum(),
            redacted_line_count: snapshots
                .iter()
                .map(|item| item.redacted_line_count)
                .fold(0_u32, u32::saturating_add),
            snapshot_fingerprint: fingerprint,
        },
        batch_count: snapshots.len(),
        batch_file_limit: MAX_REVIEW_BATCH_FILES,
        pipeline_version: REVIEW_PIPELINE_VERSION.to_string(),
    }
}

pub fn merge_review_batches(
    request_id: &str,
    scope_kind: &str,
    snapshots: &[AiCommitSnapshot],
    fingerprint: String,
    successes: Vec<AiReviewResult>,
    mut failures: Vec<AiReviewBatchFailure>,
) -> Result<AiReviewDelivery, AiUiError> {
    if successes.is_empty() {
        return Err(AiUiError::new(
            "AI_INVALID_RESPONSE",
            "AI Review 未生成结果",
            "所有 Review 批次均失败，请检查 Provider 后重试。",
            true,
        )
        .with_request_id(request_id));
    }

    let model = successes[0].model.clone();
    let provider_host = successes[0].provider_host.clone();
    let completed_batch_count = successes.len();
    let batch_count = snapshots.len();
    let selected_file_count = snapshots
        .iter()
        .map(|item| item.selected_file_count)
        .sum::<usize>();
    let failed_file_count = failures
        .iter()
        .filter(|failure| failure.batch_index > 0)
        .map(|failure| failure.file_count)
        .sum::<usize>()
        .min(selected_file_count);
    let completed_file_count = selected_file_count.saturating_sub(failed_file_count);
    let actual_failed_batch_count = failures.len();

    let mut findings = Vec::new();
    let mut finding_keys = HashSet::new();
    for result in &successes {
        for finding in &result.findings {
            let key = format!(
                "{}\0{}\0{}\0{}\0{}",
                finding.severity,
                finding.file.as_deref().unwrap_or(""),
                finding.start_line.unwrap_or_default(),
                finding.end_line.unwrap_or_default(),
                finding.title.to_lowercase(),
            );
            if finding_keys.insert(key) {
                findings.push(finding.clone());
            }
        }
    }
    findings.sort_by(|left, right| {
        severity_rank(&left.severity)
            .cmp(&severity_rank(&right.severity))
            .then_with(|| left.file.cmp(&right.file))
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.title.cmp(&right.title))
    });

    let mut truncated = false;
    if findings.len() > MAX_MERGED_REVIEW_FINDINGS {
        findings.truncate(MAX_MERGED_REVIEW_FINDINGS);
        truncated = true;
        failures.push(AiReviewBatchFailure {
            batch_index: 0,
            file_count: 0,
            code: "AI_RESULT_TRUNCATED".to_string(),
            message: format!(
                "合并后的 Findings 超过 {MAX_MERGED_REVIEW_FINDINGS} 条，已按严重级别截断。"
            ),
            retryable: false,
        });
    }
    for (index, finding) in findings.iter_mut().enumerate() {
        finding.id = format!("finding-{}", index + 1);
    }

    let positive_notes = merge_lists(
        successes.iter().flat_map(|item| item.positive_notes.iter()),
        MAX_MERGED_REVIEW_LIST_ITEMS,
    );
    let test_suggestions = merge_lists(
        successes
            .iter()
            .flat_map(|item| item.test_suggestions.iter()),
        MAX_MERGED_REVIEW_LIST_ITEMS,
    );
    let overall_risk = successes
        .iter()
        .map(|item| item.overall_risk.as_str())
        .max_by_key(|value| risk_rank(value))
        .unwrap_or("medium")
        .to_string();
    let summary = merged_summary(
        &successes,
        batch_count,
        actual_failed_batch_count,
        truncated,
    );
    let (scope_kind, scope_label) = scope_kind_label(scope_kind);

    Ok(AiReviewDelivery {
        review: AiReviewResult {
            request_id: request_id.to_string(),
            model,
            provider_host,
            summary,
            overall_risk,
            findings,
            positive_notes,
            test_suggestions,
            scope_kind: scope_kind.to_string(),
            scope_label: scope_label.to_string(),
            selected_file_count,
            included_file_count: snapshots.iter().map(|item| item.included_file_count).sum(),
            excluded_files: collect_notices(snapshots, |item| &item.excluded_files),
            summary_only_files: collect_notices(snapshots, |item| &item.summary_only_files),
            binary_files: collect_notices(snapshots, |item| &item.binary_files),
            sanitized_bytes: snapshots.iter().map(|item| item.sanitized_bytes).sum(),
            redacted_line_count: snapshots
                .iter()
                .map(|item| item.redacted_line_count)
                .fold(0_u32, u32::saturating_add),
            snapshot_fingerprint: fingerprint.clone(),
            current_snapshot_fingerprint: fingerprint,
            stale: false,
        },
        batch_count,
        completed_batch_count,
        completed_file_count,
        failed_batch_count: actual_failed_batch_count,
        partial_success: actual_failed_batch_count > 0 || truncated,
        batch_failures: failures,
        cache_hit: false,
        pipeline_version: REVIEW_PIPELINE_VERSION.to_string(),
    })
}

fn merged_summary(
    successes: &[AiReviewResult],
    batch_count: usize,
    failed_batch_count: usize,
    truncated: bool,
) -> String {
    if batch_count == 1 && failed_batch_count == 0 && !truncated {
        return successes[0].summary.clone();
    }
    let mut output = format!("已完成 {}/{} 个 Review 批次", successes.len(), batch_count);
    if failed_batch_count > 0 {
        output.push_str(&format!("，{} 个批次失败", failed_batch_count));
    }
    if truncated {
        output.push_str("，合并结果已按安全上限截断");
    }
    output.push_str("。\n\n");
    for (index, result) in successes.iter().enumerate() {
        output.push_str(&format!(
            "成功结果 {}：{}",
            index + 1,
            result.summary.trim()
        ));
        if index + 1 < successes.len() {
            output.push_str("\n\n");
        }
    }
    output.chars().take(12_000).collect()
}

fn collect_notices<F>(snapshots: &[AiCommitSnapshot], select: F) -> Vec<AiCommitInputNotice>
where
    F: Fn(&AiCommitSnapshot) -> &Vec<AiCommitInputNotice>,
{
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    for snapshot in snapshots {
        for notice in select(snapshot) {
            let key = format!("{}\0{}", notice.path, notice.reason);
            if seen.insert(key) {
                output.push(notice.clone());
            }
        }
    }
    output.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.reason.cmp(&right.reason))
    });
    output
}

fn merge_lists<'a>(values: impl Iterator<Item = &'a String>, limit: usize) -> Vec<String> {
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let normalized = value.trim();
        if !normalized.is_empty() && seen.insert(normalized.to_lowercase()) {
            output.push(normalized.to_string());
            if output.len() >= limit {
                break;
            }
        }
    }
    output
}

fn severity_rank(value: &str) -> u8 {
    match value {
        "P0" => 0,
        "P1" => 1,
        "P2" => 2,
        _ => 3,
    }
}

fn risk_rank(value: &str) -> u8 {
    match value {
        "critical" => 4,
        "high" => 3,
        "medium" => 2,
        _ => 1,
    }
}

fn update_hash(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

#[cfg(test)]
mod tests {
    use super::{aggregate_snapshot_fingerprint, deterministic_target_batches};
    use crate::working_changes::WorkingChangeTarget;

    fn target(path: &str) -> WorkingChangeTarget {
        WorkingChangeTarget {
            path: path.to_string(),
            old_path: None,
            expected_index_code: " ".to_string(),
            expected_worktree_code: "M".to_string(),
            expected_is_untracked: false,
            expected_authority_id: format!("test-authority:{path}"),
        }
    }

    #[test]
    fn batches_targets_deterministically_and_deduplicates_exact_identities() {
        let targets = vec![target("z.rs"), target("a.rs"), target("a.rs")];
        let batches = deterministic_target_batches(&targets).unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 2);
        assert_eq!(batches[0][0].path, "a.rs");
        assert_eq!(batches[0][1].path, "z.rs");
    }

    #[test]
    fn preserves_same_path_targets_with_different_git_identities() {
        let mut staged = target("same.txt");
        staged.expected_index_code = "D".to_string();
        staged.expected_worktree_code = " ".to_string();
        let mut untracked = target("same.txt");
        untracked.expected_index_code = "?".to_string();
        untracked.expected_worktree_code = "?".to_string();
        untracked.expected_is_untracked = true;
        untracked.expected_authority_id = "test-authority:untracked".to_string();

        let batches = deterministic_target_batches(&[staged, untracked]).unwrap();
        assert_eq!(batches.iter().map(Vec::len).sum::<usize>(), 2);
    }

    #[test]
    fn aggregate_fingerprint_is_scope_sensitive() {
        assert_ne!(
            aggregate_snapshot_fingerprint(&[], "all"),
            aggregate_snapshot_fingerprint(&[], "selected")
        );
    }
}
