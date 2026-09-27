async fn finalize_validated_completion_result(
    repo_root: &str,
    mut result: StashOperationResult,
) -> StashOperationResult {
    if result.status != "complete" || result.needs_confirmation {
        return result;
    }

    if let Err(error) = persist_completion_validated(repo_root, &result).await {
        result.status = "needs_confirmation".to_string();
        result.needs_confirmation = true;
        result.errors.push(format!(
            "authoritative completion 已确认，但 completion proof 无法持久化：{}",
            error
        ));
        result.message =
            "Git 操作完成事实已确认，但 durable completion proof 尚未持久化；为避免重启后误放行，本次结果需要确认。"
                .to_string();
    }

    result
}
