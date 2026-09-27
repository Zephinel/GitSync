use crate::ai::batching::{
    aggregate_snapshot_fingerprint, build_batched_scope_preview, deterministic_target_batches,
    merge_review_batches,
};
use crate::ai::errors::AiUiError;
use crate::ai::limits::{MAX_REVIEW_BATCH_FILES, REVIEW_PIPELINE_VERSION};
use crate::ai::provider::NormalizedAiEndpoint;
use crate::ai::review::{build_scope_preview, generate_review};
use crate::ai::review_cache::{build_review_cache_key, get_cached_review, put_cached_review};
use crate::ai::schema::{
    AiProgressEvent, AiProviderConfig, AiReviewBatchFailure, AiReviewDelivery,
    AiReviewScopeDelivery,
};
use crate::ai::snapshot::{capture_commit_snapshot, AiCommitSnapshot};
use crate::ai::AI_PROGRESS_EVENT;
use crate::commands::AppState;
use crate::working_changes::WorkingChangeTarget;
use std::time::Duration;
use tauri::Emitter;

const MAX_BATCH_ATTEMPTS: usize = 2;

#[derive(Debug, Clone)]
pub struct ReviewBatchPlan {
    pub scope_kind: String,
    pub snapshots: Vec<AiCommitSnapshot>,
    pub fingerprint: String,
}

impl ReviewBatchPlan {
    pub fn preview(&self) -> AiReviewScopeDelivery {
        if let [snapshot] = self.snapshots.as_slice() {
            let mut preview = build_scope_preview(snapshot, &self.scope_kind);
            preview.snapshot_fingerprint = self.fingerprint.clone();
            return AiReviewScopeDelivery {
                preview,
                batch_count: 1,
                batch_file_limit: MAX_REVIEW_BATCH_FILES,
                pipeline_version: REVIEW_PIPELINE_VERSION.to_string(),
            };
        }
        build_batched_scope_preview(&self.snapshots, &self.scope_kind, self.fingerprint.clone())
    }
}

pub async fn capture_review_plan(
    repo_path: &str,
    files: &[WorkingChangeTarget],
    scope_kind: &str,
    state: &AppState,
) -> Result<ReviewBatchPlan, AiUiError> {
    let target_batches = deterministic_target_batches(files)?;
    let mut snapshots = Vec::with_capacity(target_batches.len());
    for targets in &target_batches {
        snapshots.push(capture_commit_snapshot(repo_path, targets, state, false).await?);
    }
    let normalized_scope = if scope_kind.trim() == "selected" {
        "selected".to_string()
    } else {
        "all".to_string()
    };
    let fingerprint = aggregate_snapshot_fingerprint(&snapshots, &normalized_scope);
    Ok(ReviewBatchPlan {
        scope_kind: normalized_scope,
        snapshots,
        fingerprint,
    })
}

pub async fn capture_stable_review_plan(
    repo_path: &str,
    files: &[WorkingChangeTarget],
    scope_kind: &str,
    state: &AppState,
) -> Result<ReviewBatchPlan, AiUiError> {
    let first = capture_review_plan(repo_path, files, scope_kind, state).await?;
    if first.snapshots.len() <= 1 {
        return Ok(first);
    }

    let second = capture_review_plan(repo_path, files, scope_kind, state).await?;
    if first.fingerprint != second.fingerprint {
        return Err(AiUiError::new(
            "AI_SCOPE_CHANGED",
            "Review 输入正在变化",
            "捕获多批次 Review 输入时工作区发生了变化，请等待改动稳定后重试。",
            true,
        ));
    }
    Ok(second)
}

pub async fn execute_review_plan(
    app: &tauri::AppHandle,
    request_id: &str,
    config: &AiProviderConfig,
    endpoint: &NormalizedAiEndpoint,
    api_key: &str,
    plan: &ReviewBatchPlan,
) -> Result<AiReviewDelivery, AiUiError> {
    let cache_key = build_review_cache_key(config, endpoint, &plan.fingerprint, &plan.scope_kind);
    if let Some(mut cached) = get_cached_review(&cache_key, request_id).await {
        cached.review.current_snapshot_fingerprint = plan.fingerprint.clone();
        emit_batch_progress(
            app,
            request_id,
            "running",
            "cache-hit",
            "已命中相同快照的短期缓存，正在确认工作区…",
            plan.snapshots.len(),
            plan.snapshots.len(),
        );
        return Ok(cached);
    }

    let total = plan.snapshots.len();
    let mut successes = Vec::new();
    let mut failures = Vec::new();

    for (index, snapshot) in plan.snapshots.iter().cloned().enumerate() {
        let batch_number = index + 1;
        emit_batch_progress(
            app,
            request_id,
            "running",
            "reviewing-batch",
            &format!("正在分析批次 {batch_number}/{total}…"),
            index,
            total,
        );

        let mut last_error = None;
        for attempt in 1..=MAX_BATCH_ATTEMPTS {
            match generate_review(
                app,
                request_id,
                config,
                endpoint,
                api_key,
                snapshot.clone(),
                &plan.scope_kind,
            )
            .await
            {
                Ok(result) => {
                    successes.push(result);
                    last_error = None;
                    break;
                }
                Err(error) if error.code == "AI_CANCELLED" => return Err(error),
                Err(error) => {
                    let should_retry = error.retryable && attempt < MAX_BATCH_ATTEMPTS;
                    last_error = Some(error);
                    if should_retry {
                        emit_batch_progress(
                            app,
                            request_id,
                            "running",
                            "retrying-batch",
                            &format!("批次 {batch_number} 暂时失败，正在重试…"),
                            index,
                            total,
                        );
                        tokio::time::sleep(Duration::from_millis(250 * attempt as u64)).await;
                        continue;
                    }
                    break;
                }
            }
        }

        if let Some(error) = last_error {
            let terminal = !error.retryable;
            failures.push(AiReviewBatchFailure {
                batch_index: batch_number,
                file_count: snapshot.selected_file_count,
                code: error.code.clone(),
                message: error.message.clone(),
                retryable: error.retryable,
            });
            if terminal {
                for skipped in batch_number + 1..=total {
                    failures.push(AiReviewBatchFailure {
                        batch_index: skipped,
                        file_count: plan.snapshots[skipped - 1].selected_file_count,
                        code: "AI_BATCH_SKIPPED".to_string(),
                        message: "前一个批次返回不可重试错误，后续批次未发送。".to_string(),
                        retryable: false,
                    });
                }
                break;
            }
        }

        emit_batch_progress(
            app,
            request_id,
            "running",
            "reviewing-batch",
            &format!("已处理批次 {}/{}", batch_number, total),
            batch_number,
            total,
        );
    }

    if successes.is_empty() {
        if let Some(failure) = failures.first() {
            return Err(AiUiError::new(
                failure.code.clone(),
                "AI Review 批次失败",
                failure.message.clone(),
                failure.retryable,
            )
            .with_request_id(request_id));
        }
    }

    let merged = merge_review_batches(
        request_id,
        &plan.scope_kind,
        &plan.snapshots,
        plan.fingerprint.clone(),
        successes,
        failures,
    )?;
    if !merged.partial_success {
        put_cached_review(cache_key, &merged).await;
    }
    Ok(merged)
}

fn emit_batch_progress(
    app: &tauri::AppHandle,
    request_id: &str,
    status: &str,
    phase: &str,
    label: &str,
    completed: usize,
    total: usize,
) {
    let _ = app.emit(
        AI_PROGRESS_EVENT,
        AiProgressEvent {
            request_id: request_id.to_string(),
            kind: "review".to_string(),
            status: status.to_string(),
            phase: phase.to_string(),
            label: label.to_string(),
            completed_units: Some(completed.min(u32::MAX as usize) as u32),
            total_units: Some(total.min(u32::MAX as usize) as u32),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::ReviewBatchPlan;
    use crate::ai::snapshot::AiCommitSnapshot;

    #[test]
    fn empty_plan_reports_zero_batches() {
        let plan = ReviewBatchPlan {
            scope_kind: "all".to_string(),
            snapshots: Vec::<AiCommitSnapshot>::new(),
            fingerprint: "empty".to_string(),
        };
        assert_eq!(plan.preview().batch_count, 0);
    }
}
