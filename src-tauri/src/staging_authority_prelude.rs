#[derive(Debug, Deserialize, Clone, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritativeStagingTarget {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub expected_index_code: String,
    pub expected_worktree_code: String,
    pub expected_authority_id: String,
}

// Staging remains status-only. The Working Changes projection carries the
// preview mutation-content authority; the atomic mutation layer recaptures an
// immutable selected-path snapshot and binds the actual index mutation to it.
async fn read_staging_snapshot_authoritative_inner(
    repo_path: &str,
) -> Result<RepoStagingSnapshot, String> {
    let mut snapshot = read_staging_snapshot_inner(repo_path).await?;
    for file in &mut snapshot.files {
        file.id.clear();
    }
    Ok(snapshot)
}

fn normalize_authoritative_target(
    target: &AuthoritativeStagingTarget,
) -> Result<AuthoritativeStagingTarget, String> {
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
        return Err(format!("文件 mutation authority 无效: {}", path));
    }
    Ok(AuthoritativeStagingTarget {
        path,
        old_path,
        expected_index_code: target.expected_index_code.clone(),
        expected_worktree_code: target.expected_worktree_code.clone(),
        expected_authority_id: target.expected_authority_id.clone(),
    })
}

fn normalize_authoritative_targets(
    targets: &[AuthoritativeStagingTarget],
) -> Result<Vec<AuthoritativeStagingTarget>, String> {
    let mut normalized_files = Vec::new();
    let mut seen = HashSet::new();
    for target in targets {
        let normalized = normalize_authoritative_target(target)?;
        if seen.insert(normalized.clone()) {
            normalized_files.push(normalized);
        }
    }
    Ok(normalized_files)
}

async fn read_authoritative_target_status(
    repo_path: &str,
    target: &AuthoritativeStagingTarget,
) -> Result<Vec<RepoStagingFile>, String> {
    let mut args = vec![
        "status".to_string(),
        "--porcelain=v1".to_string(),
        "-z".to_string(),
        "-uall".to_string(),
        "--untracked-files=all".to_string(),
        "--".to_string(),
        literal_pathspec(&target.path),
    ];
    if let Some(old_path) = target.old_path.as_ref() {
        if old_path != &target.path {
            args.push(literal_pathspec(old_path));
        }
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_git(repo_path, &refs, GIT_STAGING_STATUS_TIMEOUT_MS).await?;
    Ok(parse_status_porcelain_z(&output))
}

fn find_authoritative_status_file(
    files: &[RepoStagingFile],
    target: &AuthoritativeStagingTarget,
) -> Option<RepoStagingFile> {
    let matches = files
        .iter()
        .filter(|file| {
            file.path == target.path
                && file.old_path == target.old_path
                && file.index_code == target.expected_index_code
                && file.worktree_code == target.expected_worktree_code
        })
        .collect::<Vec<_>>();
    (matches.len() == 1).then(|| matches[0].clone())
}

fn authoritative_skipped_results(
    targets: &[AuthoritativeStagingTarget],
    message: &str,
) -> Vec<StagingFileOperationResult> {
    targets
        .iter()
        .map(|target| StagingFileOperationResult {
            path: target.path.clone(),
            old_path: target.old_path.clone(),
            status: "skipped".to_string(),
            message: message.to_string(),
        })
        .collect()
}

fn authoritative_failed_results(
    targets: &[AuthoritativeStagingTarget],
    message: &str,
) -> Vec<StagingFileOperationResult> {
    targets
        .iter()
        .map(|target| StagingFileOperationResult {
            path: target.path.clone(),
            old_path: target.old_path.clone(),
            status: "failed".to_string(),
            message: message.to_string(),
        })
        .collect()
}
