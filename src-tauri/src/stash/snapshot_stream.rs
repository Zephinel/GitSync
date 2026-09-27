const STASH_WORKTREE_STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
    "--untracked-files=all",
];
const STASH_LIST_ARGS: &[&str] = &[
    "stash",
    "list",
    "--format=%gd%x00%H%x00%cI%x00%gs%x00%P",
];

#[derive(Debug, Default)]
struct WorktreeSummary {
    staged_files: usize,
    unstaged_files: usize,
    mixed_files: usize,
    untracked_files: usize,
    conflicted_files: usize,
    conflict_paths: Vec<String>,
    has_tracked_changes: bool,
}

#[derive(Debug)]
enum WorktreeStatusStreamState {
    Entry,
    RenameOld { file_index: Option<usize> },
}

struct WorktreeStatusStreamParser {
    state: WorktreeStatusStreamState,
    summary: WorktreeSummary,
    files: Vec<StashWorktreeFile>,
    collect_files: bool,
}

impl WorktreeStatusStreamParser {
    fn new(collect_files: bool) -> Self {
        Self {
            state: WorktreeStatusStreamState::Entry,
            summary: WorktreeSummary::default(),
            files: Vec::new(),
            collect_files,
        }
    }

    fn push_field(&mut self, field: String) -> Result<(), String> {
        let state = std::mem::replace(&mut self.state, WorktreeStatusStreamState::Entry);
        match state {
            WorktreeStatusStreamState::Entry => {
                if field.is_empty() {
                    return Ok(());
                }
                if field.len() < 3 || field.as_bytes().get(2) != Some(&b' ') {
                    return Err("Git status --porcelain=v1 -z 返回了无效字段。".to_string());
                }
                let code = &field[..2];
                let path = field[3..].to_string();
                if path.is_empty() {
                    return Err("Git status 返回了空文件路径。".to_string());
                }
                let mut characters = code.chars();
                let index_code = characters.next().unwrap_or(' ');
                let worktree_code = characters.next().unwrap_or(' ');
                let rename_or_copy = matches!(index_code, 'R' | 'C')
                    || matches!(worktree_code, 'R' | 'C');
                let untracked = code == "??";
                let conflicted = is_conflict_code(code);
                let has_index = !untracked && !matches!(index_code, ' ' | '?' | '!');
                let has_worktree = untracked || !matches!(worktree_code, ' ' | '!');

                if untracked {
                    self.summary.untracked_files = self.summary.untracked_files.saturating_add(1);
                } else {
                    self.summary.has_tracked_changes = true;
                    if has_index {
                        self.summary.staged_files = self.summary.staged_files.saturating_add(1);
                    }
                    if has_worktree {
                        self.summary.unstaged_files = self.summary.unstaged_files.saturating_add(1);
                    }
                    if has_index && has_worktree {
                        self.summary.mixed_files = self.summary.mixed_files.saturating_add(1);
                    }
                }
                if conflicted {
                    self.summary.conflicted_files = self.summary.conflicted_files.saturating_add(1);
                    self.summary.conflict_paths.push(path.clone());
                }

                let file_index = if self.collect_files {
                    self.files.push(StashWorktreeFile {
                        path,
                        old_path: None,
                        code: code.to_string(),
                        is_untracked: untracked,
                        is_conflicted: conflicted,
                        has_staged_changes: has_index,
                        has_unstaged_changes: has_worktree,
                    });
                    Some(self.files.len() - 1)
                } else {
                    None
                };

                if rename_or_copy {
                    self.state = WorktreeStatusStreamState::RenameOld { file_index };
                }
                Ok(())
            }
            WorktreeStatusStreamState::RenameOld { file_index } => {
                if field.is_empty() {
                    return Err("Git status rename/copy 输出缺少旧路径。".to_string());
                }
                if let Some(index) = file_index {
                    let file = self
                        .files
                        .get_mut(index)
                        .ok_or_else(|| "Git status 文件身份索引失效。".to_string())?;
                    file.old_path = Some(field);
                }
                Ok(())
            }
        }
    }

    fn finish(self) -> Result<(WorktreeSummary, Vec<StashWorktreeFile>), String> {
        if !matches!(self.state, WorktreeStatusStreamState::Entry) {
            return Err("Git status 输出在完整 rename/copy 身份之前结束。".to_string());
        }
        Ok((self.summary, self.files))
    }
}

fn is_conflict_code(code: &str) -> bool {
    matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
        || code.contains('U')
}

#[cfg(test)]
fn parse_worktree_status(raw: &str) -> WorktreeSummary {
    let mut parser = WorktreeStatusStreamParser::new(false);
    for field in raw.split('\0').filter(|field| !field.is_empty()) {
        if parser.push_field(field.to_string()).is_err() {
            return WorktreeSummary::default();
        }
    }
    parser
        .finish()
        .map(|(summary, _)| summary)
        .unwrap_or_default()
}

fn stable_hash_stream_seed(prefix: &str, leading_parts: &[&str]) -> DefaultHasher {
    let mut hasher = DefaultHasher::new();
    prefix.hash(&mut hasher);
    for part in leading_parts {
        part.hash(&mut hasher);
        0xff_u8.hash(&mut hasher);
    }
    hasher
}

fn stable_hash_stream_nul_field(hasher: &mut DefaultHasher, field: &str) {
    hasher.write(field.as_bytes());
    hasher.write_u8(0);
}

fn stable_hash_stream_newline_record(hasher: &mut DefaultHasher, record: &str) {
    hasher.write(record.as_bytes());
    hasher.write_u8(b'\n');
}

fn stable_hash_stream_finish_str_part(hasher: &mut DefaultHasher) {
    // `Hash for str` writes its UTF-8 bytes followed by 0xff. `stable_hash`
    // then hashes another 0xff byte between logical parts. Streamed status/list
    // data has already written its lossy UTF-8 bytes and original delimiters.
    hasher.write_u8(0xff);
    0xff_u8.hash(hasher);
}

fn stable_hash_stream_finish(prefix: &str, hasher: &DefaultHasher) -> String {
    format!("{}-{:016x}", prefix, hasher.finish())
}

async fn read_snapshot_worktree_status(
    repo_root: &str,
    branch_value: &str,
    head_value: &str,
) -> Result<(WorktreeSummary, String, DefaultHasher), String> {
    let leading = [repo_root, branch_value, head_value];
    let mut worktree_hasher = stable_hash_stream_seed("stash-worktree-v1", &leading);
    let mut snapshot_hasher = stable_hash_stream_seed("stash-snapshot-v1", &leading);
    let mut parser = WorktreeStatusStreamParser::new(false);

    run_git_nul_fields(
        repo_root,
        STASH_WORKTREE_STATUS_ARGS,
        GIT_STASH_STATUS_TIMEOUT_MS,
        |field| {
            stable_hash_stream_nul_field(&mut worktree_hasher, &field);
            stable_hash_stream_nul_field(&mut snapshot_hasher, &field);
            parser.push_field(field)
        },
    )
    .await?;
    let (summary, _) = parser.finish()?;
    stable_hash_stream_finish_str_part(&mut worktree_hasher);
    stable_hash_stream_finish_str_part(&mut snapshot_hasher);
    let worktree_id = stable_hash_stream_finish("stash-worktree-v1", &worktree_hasher);
    Ok((summary, worktree_id, snapshot_hasher))
}

fn parse_stash_list_record(record: &str) -> Result<RepoStashEntry, String> {
    let fields = record.split('\0').collect::<Vec<_>>();
    if fields.len() != 5 {
        return Err("Git stash list 返回了字段数量不完整的记录。".to_string());
    }
    let selector = fields[0].trim().to_string();
    let oid = fields[1].trim().to_ascii_lowercase();
    if selector.is_empty() || oid.is_empty() {
        return Err("Git stash list 返回了缺少 selector/OID 的记录。".to_string());
    }
    let created_at = fields[2].trim().to_string();
    let subject = fields[3].trim().to_string();
    let parents = fields[4]
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let (branch_context, message) = parse_stash_subject(&subject);
    let includes_untracked = parents.len() >= 3;
    let scope_summary = if includes_untracked {
        "已跟踪修改与未跟踪文件"
    } else {
        "已跟踪修改（含暂存区快照）"
    }
    .to_string();

    Ok(RepoStashEntry {
        id: oid.clone(),
        oid,
        selector: selector.clone(),
        ordinal: parse_stash_ordinal(&selector),
        message,
        subject,
        branch_context,
        created_at,
        base_commit: parents.first().cloned(),
        base_summary: None,
        includes_untracked,
        scope_summary,
    })
}

async fn read_snapshot_stash_list(
    repo_root: &str,
    snapshot_hasher: &mut DefaultHasher,
) -> Result<Vec<RepoStashEntry>, String> {
    let mut entries = Vec::new();
    run_git_newline_records(
        repo_root,
        STASH_LIST_ARGS,
        GIT_STASH_META_TIMEOUT_MS,
        |record| {
            stable_hash_stream_newline_record(snapshot_hasher, &record);
            if !record.is_empty() {
                entries.push(parse_stash_list_record(&record)?);
            }
            Ok(())
        },
    )
    .await?;
    stable_hash_stream_finish_str_part(snapshot_hasher);
    Ok(entries)
}

fn finish_snapshot_identity(snapshot_hasher: DefaultHasher) -> String {
    stable_hash_stream_finish("stash-snapshot-v1", &snapshot_hasher)
}

async fn read_stash_worktree_files_streamed(
    repo_root: &str,
) -> Result<Vec<StashWorktreeFile>, String> {
    let mut parser = WorktreeStatusStreamParser::new(true);
    run_git_nul_fields(
        repo_root,
        STASH_WORKTREE_STATUS_ARGS,
        GIT_STASH_STATUS_TIMEOUT_MS,
        |field| parser.push_field(field),
    )
    .await?;
    let (_, files) = parser.finish()?;
    Ok(files)
}
