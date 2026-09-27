#[derive(Debug)]
enum NameStatusStreamState {
    Code,
    Path(String),
    RenameOld(String),
    RenameNew { code: String, old_path: String },
}

struct NameStatusStreamParser {
    state: NameStatusStreamState,
    untracked: bool,
}

impl NameStatusStreamParser {
    fn new(untracked: bool) -> Self {
        Self {
            state: NameStatusStreamState::Code,
            untracked,
        }
    }

    fn file(
        &self,
        code: String,
        path: String,
        old_path: Option<String>,
    ) -> RepoStashDetailFile {
        RepoStashDetailFile {
            path,
            old_path: if self.untracked { None } else { old_path },
            status: stash_detail_status(&code, self.untracked),
            additions: 0,
            deletions: 0,
            is_binary: false,
            is_untracked: self.untracked,
        }
    }

    fn push_field(&mut self, field: String) -> Result<Option<RepoStashDetailFile>, String> {
        let state = std::mem::replace(&mut self.state, NameStatusStreamState::Code);
        match state {
            NameStatusStreamState::Code => {
                if field.is_empty() {
                    return Ok(None);
                }
                self.state = if field.starts_with('R') || field.starts_with('C') {
                    NameStatusStreamState::RenameOld(field)
                } else {
                    NameStatusStreamState::Path(field)
                };
                Ok(None)
            }
            NameStatusStreamState::Path(code) => {
                if field.is_empty() {
                    return Err("Git name-status 输出缺少文件路径。".to_string());
                }
                Ok(Some(self.file(code, field, None)))
            }
            NameStatusStreamState::RenameOld(code) => {
                if field.is_empty() {
                    return Err("Git rename/copy 输出缺少旧路径。".to_string());
                }
                self.state = NameStatusStreamState::RenameNew {
                    code,
                    old_path: field,
                };
                Ok(None)
            }
            NameStatusStreamState::RenameNew { code, old_path } => {
                if field.is_empty() {
                    return Err("Git rename/copy 输出缺少新路径。".to_string());
                }
                Ok(Some(self.file(code, field, Some(old_path))))
            }
        }
    }

    fn finish(self) -> Result<(), String> {
        if matches!(self.state, NameStatusStreamState::Code) {
            Ok(())
        } else {
            Err("Git name-status 输出在完整文件身份之前结束。".to_string())
        }
    }
}

#[derive(Debug)]
enum NumstatStreamState {
    Entry,
    RenameOld { additions: u32, deletions: u32, binary: bool },
    RenameNew { additions: u32, deletions: u32, binary: bool },
}

#[derive(Debug)]
struct NumstatStreamEntry {
    path: String,
    additions: u32,
    deletions: u32,
    binary: bool,
}

struct NumstatStreamParser {
    state: NumstatStreamState,
}

impl NumstatStreamParser {
    fn new() -> Self {
        Self {
            state: NumstatStreamState::Entry,
        }
    }

    fn push_field(&mut self, field: String) -> Result<Option<NumstatStreamEntry>, String> {
        let state = std::mem::replace(&mut self.state, NumstatStreamState::Entry);
        match state {
            NumstatStreamState::Entry => {
                if field.is_empty() {
                    return Ok(None);
                }
                let mut parts = field.splitn(3, '\t');
                let additions_raw = parts.next().unwrap_or_default();
                let deletions_raw = parts.next().unwrap_or_default();
                let path = parts
                    .next()
                    .ok_or_else(|| "Git numstat 输出字段不完整。".to_string())?;
                let binary = additions_raw == "-" || deletions_raw == "-";
                let additions = additions_raw.parse::<u32>().unwrap_or(0);
                let deletions = deletions_raw.parse::<u32>().unwrap_or(0);
                if path.is_empty() {
                    self.state = NumstatStreamState::RenameOld {
                        additions,
                        deletions,
                        binary,
                    };
                    Ok(None)
                } else {
                    Ok(Some(NumstatStreamEntry {
                        path: path.to_string(),
                        additions,
                        deletions,
                        binary,
                    }))
                }
            }
            NumstatStreamState::RenameOld {
                additions,
                deletions,
                binary,
            } => {
                if field.is_empty() {
                    return Err("Git numstat rename/copy 输出缺少旧路径。".to_string());
                }
                self.state = NumstatStreamState::RenameNew {
                    additions,
                    deletions,
                    binary,
                };
                Ok(None)
            }
            NumstatStreamState::RenameNew {
                additions,
                deletions,
                binary,
            } => {
                if field.is_empty() {
                    return Err("Git numstat rename/copy 输出缺少新路径。".to_string());
                }
                Ok(Some(NumstatStreamEntry {
                    path: field,
                    additions,
                    deletions,
                    binary,
                }))
            }
        }
    }

    fn finish(self) -> Result<(), String> {
        if matches!(self.state, NumstatStreamState::Entry) {
            Ok(())
        } else {
            Err("Git numstat 输出在完整文件身份之前结束。".to_string())
        }
    }
}

#[derive(Default)]
struct StashDetailAccumulator {
    retained: BTreeMap<(String, String), RepoStashDetailFile>,
    file_count: usize,
    additions: u32,
    deletions: u32,
    added_files: usize,
    modified_files: usize,
    deleted_files: usize,
    renamed_files: usize,
    untracked_files: usize,
}

impl StashDetailAccumulator {
    fn observe_file(&mut self, file: RepoStashDetailFile) {
        let key = (file.path.clone(), file.status.clone());
        if self.retained.contains_key(&key) {
            return;
        }
        self.file_count = self.file_count.saturating_add(1);
        match file.status.as_str() {
            "added" => self.added_files = self.added_files.saturating_add(1),
            "modified" | "typechange" => {
                self.modified_files = self.modified_files.saturating_add(1)
            }
            "deleted" => self.deleted_files = self.deleted_files.saturating_add(1),
            "renamed" | "copied" => self.renamed_files = self.renamed_files.saturating_add(1),
            "untracked" => self.untracked_files = self.untracked_files.saturating_add(1),
            _ => {}
        }
        self.retained.insert(key, file);
        if self.retained.len() > STASH_DETAIL_MAX_FILES {
            if let Some(last_key) = self.retained.keys().next_back().cloned() {
                self.retained.remove(&last_key);
            }
        }
    }

    fn retained_paths(&self) -> HashSet<String> {
        self.retained
            .values()
            .map(|file| file.path.clone())
            .collect()
    }

    fn observe_numstat(
        &mut self,
        entry: NumstatStreamEntry,
        retained_paths: &HashSet<String>,
        retained_stats: &mut HashMap<String, (u32, u32, bool)>,
    ) {
        self.additions = self.additions.saturating_add(entry.additions);
        self.deletions = self.deletions.saturating_add(entry.deletions);
        if retained_paths.contains(&entry.path) {
            retained_stats.insert(
                entry.path,
                (entry.additions, entry.deletions, entry.binary),
            );
        }
    }

    fn into_detail(
        self,
        entry: RepoStashEntry,
        retained_stats: &HashMap<String, (u32, u32, bool)>,
    ) -> RepoStashDetail {
        let files = self
            .retained
            .into_values()
            .map(|mut file| {
                if let Some((additions, deletions, binary)) = retained_stats.get(&file.path) {
                    file.additions = *additions;
                    file.deletions = *deletions;
                    file.is_binary = *binary;
                }
                file
            })
            .collect::<Vec<_>>();
        RepoStashDetail {
            entry,
            file_count: self.file_count,
            additions: self.additions,
            deletions: self.deletions,
            added_files: self.added_files,
            modified_files: self.modified_files,
            deleted_files: self.deleted_files,
            renamed_files: self.renamed_files,
            untracked_files: self.untracked_files,
            files_truncated: self.file_count > files.len(),
            files,
        }
    }
}

async fn stream_name_status_command(
    repo_root: &str,
    args: &[&str],
    untracked: bool,
    accumulator: &mut StashDetailAccumulator,
) -> Result<(), String> {
    let mut parser = NameStatusStreamParser::new(untracked);
    run_git_nul_fields(repo_root, args, GIT_STASH_STATUS_TIMEOUT_MS, |field| {
        if let Some(file) = parser.push_field(field)? {
            accumulator.observe_file(file);
        }
        Ok(())
    })
    .await?;
    parser.finish()
}

async fn stream_numstat_command(
    repo_root: &str,
    args: &[&str],
    accumulator: &mut StashDetailAccumulator,
    retained_paths: &HashSet<String>,
    retained_stats: &mut HashMap<String, (u32, u32, bool)>,
) -> Result<(), String> {
    let mut parser = NumstatStreamParser::new();
    run_git_nul_fields(repo_root, args, GIT_STASH_STATUS_TIMEOUT_MS, |field| {
        if let Some(entry) = parser.push_field(field)? {
            accumulator.observe_numstat(entry, retained_paths, retained_stats);
        }
        Ok(())
    })
    .await?;
    parser.finish()
}

async fn read_repo_stash_detail_streamed(
    repo_root: &str,
    stash_id: &str,
) -> Result<RepoStashDetail, String> {
    let context = resolve_stash_detail_context(repo_root, stash_id).await?;
    let mut accumulator = StashDetailAccumulator::default();

    stream_name_status_command(
        repo_root,
        &[
            "diff",
            "--name-status",
            "-z",
            "-M",
            context.base_commit.as_str(),
            context.entry.oid.as_str(),
        ],
        false,
        &mut accumulator,
    )
    .await?;

    if let Some(untracked_commit) = context.untracked_commit.as_deref() {
        stream_name_status_command(
            repo_root,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-z",
                "-r",
                untracked_commit,
            ],
            true,
            &mut accumulator,
        )
        .await?;
    }

    let retained_paths = accumulator.retained_paths();
    let mut retained_stats = HashMap::new();
    stream_numstat_command(
        repo_root,
        &[
            "diff",
            "--numstat",
            "-z",
            "-M",
            context.base_commit.as_str(),
            context.entry.oid.as_str(),
        ],
        &mut accumulator,
        &retained_paths,
        &mut retained_stats,
    )
    .await?;

    if let Some(untracked_commit) = context.untracked_commit.as_deref() {
        stream_numstat_command(
            repo_root,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--numstat",
                "-z",
                "-r",
                untracked_commit,
            ],
            &mut accumulator,
            &retained_paths,
            &mut retained_stats,
        )
        .await?;
    }

    Ok(accumulator.into_detail(context.entry, &retained_stats))
}

async fn find_file_in_name_status(
    repo_root: &str,
    args: &[&str],
    target_path: &str,
    untracked: bool,
) -> Result<Option<RepoStashDetailFile>, String> {
    let mut parser = NameStatusStreamParser::new(untracked);
    let mut found = None;
    run_git_nul_fields(repo_root, args, GIT_STASH_STATUS_TIMEOUT_MS, |field| {
        if let Some(file) = parser.push_field(field)? {
            if file.path == target_path {
                found = Some(file);
            }
        }
        Ok(())
    })
    .await?;
    parser.finish()?;
    Ok(found)
}

async fn apply_target_numstat(
    repo_root: &str,
    args: &[&str],
    target_path: &str,
    file: &mut RepoStashDetailFile,
) -> Result<(), String> {
    let mut parser = NumstatStreamParser::new();
    let mut found = false;
    run_git_nul_fields(repo_root, args, GIT_STASH_STATUS_TIMEOUT_MS, |field| {
        if let Some(entry) = parser.push_field(field)? {
            if entry.path == target_path {
                file.additions = entry.additions;
                file.deletions = entry.deletions;
                file.is_binary = entry.binary;
                found = true;
            }
        }
        Ok(())
    })
    .await?;
    parser.finish()?;
    if found {
        Ok(())
    } else {
        Err("Git numstat 未返回所选 Stash 文件的统计身份。".to_string())
    }
}

async fn read_repo_stash_file_metadata_streamed(
    repo_root: &str,
    context: &StashDetailContext,
    path: &str,
) -> Result<RepoStashDetailFile, String> {
    let tracked_status_args = [
        "diff",
        "--name-status",
        "-z",
        "-M",
        context.base_commit.as_str(),
        context.entry.oid.as_str(),
    ];
    if let Some(mut file) = find_file_in_name_status(
        repo_root,
        &tracked_status_args,
        path,
        false,
    )
    .await?
    {
        let tracked_numstat_args = [
            "diff",
            "--numstat",
            "-z",
            "-M",
            context.base_commit.as_str(),
            context.entry.oid.as_str(),
        ];
        apply_target_numstat(repo_root, &tracked_numstat_args, path, &mut file).await?;
        return Ok(file);
    }

    if let Some(untracked_commit) = context.untracked_commit.as_deref() {
        let untracked_status_args = [
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-status",
            "-z",
            "-r",
            untracked_commit,
        ];
        if let Some(mut file) = find_file_in_name_status(
            repo_root,
            &untracked_status_args,
            path,
            true,
        )
        .await?
        {
            let untracked_numstat_args = [
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--numstat",
                "-z",
                "-r",
                untracked_commit,
            ];
            apply_target_numstat(repo_root, &untracked_numstat_args, path, &mut file).await?;
            return Ok(file);
        }
    }

    Err("所选文件不在该 Stash 中，列表可能已经变化。".to_string())
}
