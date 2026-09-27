async fn create_tree_from_index_map(
    repo_path: &str,
    states: &IndexStateMap,
) -> Result<String, String> {
    let git_dir = resolve_git_dir(repo_path).await?;
    let temp_index = unique_temp_path(&git_dir, "tree-index");
    let temp_lock = PathBuf::from(format!("{}.lock", temp_index.to_string_lossy()));
    let envs = vec![(
        "GIT_INDEX_FILE".to_string(),
        temp_index.to_string_lossy().to_string(),
    )];

    let result = async {
        run_git_bytes(
            repo_path,
            &["read-tree".to_string(), "--empty".to_string()],
            &envs,
            None,
        )
        .await?;
        let mut input = Vec::new();
        for (path, state) in states {
            let Some(entry) = state else { continue };
            if entry.stage != 0 {
                return Err(format!("conditional index tree 不接受非 stage-0 entry: {}", path));
            }
            input.extend_from_slice(entry.mode.as_bytes());
            input.push(b' ');
            input.extend_from_slice(entry.oid.as_bytes());
            input.push(b'\t');
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
        if !input.is_empty() {
            run_git_bytes(
                repo_path,
                &[
                    "update-index".to_string(),
                    "-z".to_string(),
                    "--index-info".to_string(),
                ],
                &envs,
                Some(&input),
            )
            .await?;
        }
        let tree = run_git_text(
            repo_path,
            &["write-tree".to_string()],
            &envs,
            None,
        )
        .await?;
        parse_oid(&tree, "git write-tree")
    }
    .await;

    let _ = tokio::fs::remove_file(&temp_index).await;
    let _ = tokio::fs::remove_file(&temp_lock).await;
    result
}

async fn build_index_patch(
    repo_path: &str,
    old_states: &IndexStateMap,
    new_states: &IndexStateMap,
) -> Result<Vec<u8>, String> {
    let old_tree = create_tree_from_index_map(repo_path, old_states).await?;
    let new_tree = create_tree_from_index_map(repo_path, new_states).await?;
    if old_tree == new_tree {
        return Ok(Vec::new());
    }
    run_git_bytes(
        repo_path,
        &[
            "diff".to_string(),
            "--binary".to_string(),
            "--full-index".to_string(),
            "--no-renames".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            old_tree,
            new_tree,
            "--".to_string(),
        ],
        &[],
        None,
    )
    .await
}

async fn apply_index_patch(
    repo_path: &str,
    patch: &[u8],
    envs: &[(String, String)],
) -> Result<(), String> {
    if patch.is_empty() {
        return Ok(());
    }
    run_git_bytes(
        repo_path,
        &[
            "apply".to_string(),
            "--cached".to_string(),
            "--index".to_string(),
            "--whitespace=nowarn".to_string(),
            "-".to_string(),
        ],
        envs,
        Some(patch),
    )
    .await
    .map(|_| ())
}

async fn read_tree_index_states(
    repo_path: &str,
    treeish: Option<&str>,
    paths: &[String],
) -> Result<IndexStateMap, String> {
    let mut result = paths
        .iter()
        .cloned()
        .map(|path| (path, None))
        .collect::<IndexStateMap>();
    let Some(treeish) = treeish.filter(|value| !value.is_empty()) else {
        return Ok(result);
    };
    if paths.is_empty() {
        return Ok(result);
    }
    let mut args = vec![
        "ls-tree".to_string(),
        "-z".to_string(),
        treeish.to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().map(|path| literal_pathspec(path)));
    let bytes = run_git_bytes(repo_path, &args, &[], None).await?;
    let text = crate::git_encoding::decode_git_stdout(bytes, "atomic mutation tree path identity")?;
    for record in text.split('\0').filter(|record| !record.is_empty()) {
        let (metadata, path) = record
            .split_once('\t')
            .ok_or_else(|| "git ls-tree 返回了无法解析的记录。".to_string())?;
        let mut fields = metadata.split_whitespace();
        let mode = fields
            .next()
            .ok_or_else(|| format!("git ls-tree 缺少 mode: {}", path))?;
        let _kind = fields
            .next()
            .ok_or_else(|| format!("git ls-tree 缺少 type: {}", path))?;
        let oid = fields
            .next()
            .ok_or_else(|| format!("git ls-tree 缺少 object id: {}", path))?;
        if !result.contains_key(path) {
            return Err(format!("git ls-tree 返回了未请求路径: {}", path));
        }
        result.insert(
            path.to_string(),
            Some(MutationIndexEntry {
                mode: mode.to_string(),
                oid: parse_oid(oid, "git ls-tree")?,
                stage: 0,
            }),
        );
    }
    Ok(result)
}

async fn capture_expected_snapshots(
    repo_path: &str,
    entries: &[(String, Option<String>, String)],
) -> Result<Vec<MutationEntrySnapshot>, String> {
    let requested = entries
        .iter()
        .map(|(path, old_path, _)| (path.clone(), old_path.clone()))
        .collect::<Vec<_>>();
    let snapshots = capture_mutation_entry_snapshots(repo_path, &requested).await?;
    if snapshots.len() != entries.len() {
        return Err("immutable mutation snapshot 数量与 requested targets 不一致。".to_string());
    }
    for (snapshot, (_, _, expected)) in snapshots.iter().zip(entries) {
        if snapshot.authority_id != *expected {
            return Err(format!(
                "文件内容或 index authority 已变化，mutation 未开始: {}",
                snapshot.path
            ));
        }
    }
    Ok(snapshots)
}

async fn stage_verified_entry_inner(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    before_apply: Option<&(dyn Fn() + Send + Sync)>,
) -> Result<(), String> {
    let snapshots = capture_expected_snapshots(
        repo_path,
        &[(
            path.to_string(),
            old_path.map(str::to_string),
            expected_authority_id.to_string(),
        )],
    )
    .await?;
    let old_states = snapshot_index_map(&snapshots)?;
    let new_states = snapshot_worktree_index_map(&snapshots)?;
    let patch = build_index_patch(repo_path, &old_states, &new_states).await?;
    if let Some(hook) = before_apply {
        hook();
    }
    apply_index_patch(repo_path, &patch, &[]).await.map_err(|error| {
        format!(
            "Stage conditional index mutation 被外部 index 变化拒绝；未覆盖外部修改: {}",
            error
        )
    })
}

pub async fn stage_verified_entry(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
) -> Result<(), String> {
    stage_verified_entry_inner(repo_path, path, old_path, expected_authority_id, None).await
}

async fn unstage_verified_entry_inner(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    expected_head: Option<&str>,
    before_apply: Option<&(dyn Fn() + Send + Sync)>,
) -> Result<(), String> {
    let snapshots = capture_expected_snapshots(
        repo_path,
        &[(
            path.to_string(),
            old_path.map(str::to_string),
            expected_authority_id.to_string(),
        )],
    )
    .await?;
    let old_states = snapshot_index_map(&snapshots)?;
    let paths = selected_paths(&snapshots);
    let new_states = read_tree_index_states(repo_path, expected_head, &paths).await?;
    let patch = build_index_patch(repo_path, &old_states, &new_states).await?;
    if let Some(hook) = before_apply {
        hook();
    }
    apply_index_patch(repo_path, &patch, &[]).await.map_err(|error| {
        format!(
            "Unstage conditional index mutation 被外部 index 变化拒绝；外部暂存内容已保留: {}",
            error
        )
    })
}

pub async fn unstage_verified_entry(
    repo_path: &str,
    path: &str,
    old_path: Option<&str>,
    expected_authority_id: &str,
    expected_head: Option<&str>,
) -> Result<(), String> {
    unstage_verified_entry_inner(
        repo_path,
        path,
        old_path,
        expected_authority_id,
        expected_head,
        None,
    )
    .await
}

async fn temp_index_from_head(
    repo_path: &str,
    expected_head: Option<&str>,
) -> Result<(PathBuf, Vec<(String, String)>), String> {
    let git_dir = resolve_git_dir(repo_path).await?;
    let temp_index = unique_temp_path(&git_dir, "commit-index");
    let envs = vec![(
        "GIT_INDEX_FILE".to_string(),
        temp_index.to_string_lossy().to_string(),
    )];
    let args = match expected_head.filter(|value| !value.is_empty()) {
        Some(head) => vec!["read-tree".to_string(), head.to_string()],
        None => vec!["read-tree".to_string(), "--empty".to_string()],
    };
    run_git_bytes(repo_path, &args, &envs, None).await?;
    Ok((temp_index, envs))
}

async fn object_zero_oid(repo_path: &str) -> Result<String, String> {
    let format = run_git_text(
        repo_path,
        &[
            "rev-parse".to_string(),
            "--show-object-format".to_string(),
        ],
        &[],
        None,
    )
    .await?;
    Ok(match format.trim() {
        "sha256" => "0".repeat(64),
        _ => "0".repeat(40),
    })
}
