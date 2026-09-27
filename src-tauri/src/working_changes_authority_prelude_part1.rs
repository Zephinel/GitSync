#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritativeWorkingChangeTarget {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub expected_index_code: String,
    pub expected_worktree_code: String,
    pub expected_is_untracked: bool,
    pub expected_authority_id: String,
}

// The visible Working summary captures preview mutation-content authority once.
// Actual Stage/Unstage/Commit/Discard inputs are recaptured as immutable selected
// snapshots inside git_atomic_mutation before any executable mutation begins.
async fn read_working_summary_authoritative_inner(
    repo_path: &str,
) -> Result<RepoWorkingChangesSummary, String> {
    let mut summary = read_working_summary_inner(repo_path).await?;
    let entries = summary
        .files
        .iter()
        .map(|file| (file.path.clone(), file.old_path.clone()))
        .collect::<Vec<_>>();
    let content_ids = crate::git_content_authority::collect_mutation_content_ids(repo_path, &entries)
        .await?;
    if content_ids.len() != summary.files.len() {
        return Err("Working Changes 内容 authority 数量与状态条目不一致。".to_string());
    }
    for (file, content_id) in summary.files.iter_mut().zip(content_ids) {
        file.id = content_id;
    }
    Ok(summary)
}

fn normalize_authoritative_working_target(
    target: &AuthoritativeWorkingChangeTarget,
) -> Result<AuthoritativeWorkingChangeTarget, String> {
    let path = validate_relative_path(&target.path)?;
    let old_path = target
        .old_path
        .as_deref()
        .map(validate_relative_path)
        .transpose()?;
    if target.expected_index_code.chars().count() != 1
        || target.expected_worktree_code.chars().count() != 1
        || target.expected_authority_id.is_empty()
    {
        return Err(format!("Working Changes mutation authority 无效: {}", path));
    }
    Ok(AuthoritativeWorkingChangeTarget {
        path,
        old_path,
        expected_index_code: target.expected_index_code.clone(),
        expected_worktree_code: target.expected_worktree_code.clone(),
        expected_is_untracked: target.expected_is_untracked,
        expected_authority_id: target.expected_authority_id.clone(),
    })
}

fn normalize_authoritative_working_targets(
    targets: &[AuthoritativeWorkingChangeTarget],
) -> Result<Vec<AuthoritativeWorkingChangeTarget>, String> {
    if targets.is_empty() {
        return Err("请至少选择一个文件".to_string());
    }
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for target in targets {
        let target = normalize_authoritative_working_target(target)?;
        if seen.insert(target.clone()) {
            normalized.push(target);
        }
    }
    Ok(normalized)
}

fn authoritative_working_status_matches_file(
    target: &AuthoritativeWorkingChangeTarget,
    file: &RepoWorkingChangeFile,
) -> bool {
    file.path == target.path
        && file.old_path == target.old_path
        && file.index_code == target.expected_index_code
        && file.worktree_code == target.expected_worktree_code
        && file.is_untracked == target.expected_is_untracked
}

fn find_authoritative_requested_status_files(
    current_files: &[RepoWorkingChangeFile],
    targets: &[AuthoritativeWorkingChangeTarget],
) -> Result<Vec<RepoWorkingChangeFile>, String> {
    let targets = normalize_authoritative_working_targets(targets)?;
    let mut selected = Vec::with_capacity(targets.len());
    for target in &targets {
        let matches = current_files
            .iter()
            .filter(|file| authoritative_working_status_matches_file(target, file))
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(format!(
                "文件 status authority 已变化，请刷新后重试: {}",
                target.path
            ));
        }
        let file = matches[0];
        if current_files.iter().any(|candidate| {
            candidate.id != file.id && files_share_identity_path(candidate, file)
        }) {
            return Err(format!(
                "同一路径同时存在多个 Git status identity，Commit / Discard 不会猜测目标；请先用 Stage / Unstage 消解状态后刷新: {}",
                file.path
            ));
        }
        selected.push(file.clone());
    }
    Ok(selected)
}
