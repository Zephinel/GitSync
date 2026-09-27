use crate::ai::errors::AiUiError;
use crate::ai::sanitize::{is_sensitive_path, sanitize_commit_subject, sanitize_diff_content};
use crate::ai::schema::AiCommitInputNotice;
use crate::commands::AppState;
use crate::working_changes::WorkingChangeTarget;
use std::collections::HashSet;
use std::path::{Component, Path};
use std::process::Stdio;
use std::time::Duration;

const GIT_SNAPSHOT_TIMEOUT_MS: u64 = 20_000;
const MAX_SELECTED_FILES: usize = 200;
const MAX_COMMIT_FILE_PATCH_BYTES: usize = 96 * 1024;
const MAX_COMMIT_TOTAL_PATCH_BYTES: usize = 256 * 1024;
const MAX_RAW_FILE_BYTES: usize = 5 * 1024 * 1024;
const MAX_RECENT_SUBJECTS: usize = 20;

#[derive(Debug, Clone)]
struct StatusRecord {
    path: String,
    old_path: Option<String>,
    status: String,
    index_code: String,
    worktree_code: String,
    is_untracked: bool,
    is_conflicted: bool,
}

#[derive(Debug, Clone)]
enum PatchInput {
    Text(String),
    Binary,
    SummaryOnly(String),
}

#[derive(Debug, Clone)]
pub struct AiCommitSnapshotFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub patch: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AiCommitSnapshot {
    pub fingerprint: String,
    pub branch: String,
    pub head: String,
    pub selected_file_count: usize,
    pub included_file_count: usize,
    pub sanitized_bytes: usize,
    pub redacted_line_count: u32,
    pub files: Vec<AiCommitSnapshotFile>,
    pub excluded_files: Vec<AiCommitInputNotice>,
    pub summary_only_files: Vec<AiCommitInputNotice>,
    pub binary_files: Vec<AiCommitInputNotice>,
    pub recent_subjects: Vec<String>,
}

impl AiCommitSnapshot {
    pub fn render_prompt_input(&self) -> String {
        let mut output = String::new();
        output.push_str("Repository snapshot metadata:\n");
        output.push_str(&format!("- Branch: {}\n", display_or_unknown(&self.branch)));
        output.push_str(&format!("- HEAD: {}\n", display_or_unknown(&self.head)));
        output.push_str(&format!("- Selected files: {}\n", self.selected_file_count));
        output.push_str(&format!(
            "- Files with bounded sanitized diff: {}\n",
            self.included_file_count
        ));
        output.push_str(&format!(
            "- Sanitized diff bytes: {}\n",
            self.sanitized_bytes
        ));
        output.push_str(&format!("- Redacted lines: {}\n", self.redacted_line_count));

        if !self.excluded_files.is_empty() {
            output.push_str("\nSensitive files excluded from content:\n");
            for item in &self.excluded_files {
                output.push_str(&format!("- {} ({})\n", item.path, item.reason));
            }
        }
        if !self.binary_files.is_empty() {
            output.push_str("\nBinary files represented by metadata only:\n");
            for item in &self.binary_files {
                output.push_str(&format!("- {} ({})\n", item.path, item.reason));
            }
        }
        if !self.summary_only_files.is_empty() {
            output.push_str("\nFiles represented by metadata only:\n");
            for item in &self.summary_only_files {
                output.push_str(&format!("- {} ({})\n", item.path, item.reason));
            }
        }
        if !self.recent_subjects.is_empty() {
            output.push_str("\nRecent commit subjects for style only:\n");
            for subject in &self.recent_subjects {
                output.push_str(&format!("- {}\n", subject));
            }
        }

        output.push_str("\nSelected change details:\n");
        for file in &self.files {
            output.push_str("\n--- FILE ---\n");
            output.push_str(&format!("Path: {}\n", file.path));
            if let Some(old_path) = file.old_path.as_ref() {
                output.push_str(&format!("Old path: {}\n", old_path));
            }
            output.push_str(&format!("Status: {}\n", file.status));
            output.push_str(&format!("Stats: +{} -{}\n", file.additions, file.deletions));
            match file.patch.as_ref() {
                Some(patch) => {
                    output.push_str("Sanitized diff:\n");
                    output.push_str(patch);
                }
                None => output.push_str("Sanitized diff: not included; use metadata only.\n"),
            }
        }
        output
    }
}

pub async fn capture_commit_snapshot(
    repo_path: &str,
    targets: &[WorkingChangeTarget],
    state: &AppState,
    include_recent_subjects: bool,
) -> Result<AiCommitSnapshot, AiUiError> {
    ensure_repo_path(repo_path)?;
    if targets.is_empty() {
        return Err(snapshot_error("请至少选择一个文件。", false));
    }
    if targets.len() > MAX_SELECTED_FILES {
        return Err(snapshot_error(
            "所选文件数量超过 AI 提交信息生成上限。",
            false,
        ));
    }

    let _guard = crate::repo_git_lock::acquire_read(state, repo_path)
        .await
        .map_err(|error| snapshot_error(&error, false))?;
    let status_output = run_git_text(
        repo_path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "-uall",
            "--untracked-files=all",
        ],
    )
    .await?;
    let current_records = parse_status_porcelain_z(&status_output);
    let selected = resolve_selected_records(&current_records, targets)?;
    if selected.iter().any(|record| record.is_conflicted) {
        return Err(snapshot_error(
            "所选文件包含未解决冲突，请先解决冲突后再生成提交信息。",
            false,
        ));
    }

    let has_head = git_succeeds(repo_path, &["rev-parse", "--verify", "HEAD"]).await;
    let head = if has_head {
        run_git_text(repo_path, &["rev-parse", "--verify", "HEAD"])
            .await?
            .trim()
            .to_string()
    } else {
        String::new()
    };
    let branch = run_git_text(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .unwrap_or_default()
        .trim()
        .to_string();
    let recent_subjects = if include_recent_subjects && has_head {
        read_recent_subjects(repo_path).await
    } else {
        Vec::new()
    };

    let mut files = Vec::with_capacity(selected.len());
    let mut excluded_files = Vec::new();
    let mut summary_only_files = Vec::new();
    let mut binary_files = Vec::new();
    let mut sanitized_bytes = 0_usize;
    let mut redacted_line_count = 0_u32;
    let mut included_file_count = 0_usize;

    for record in selected {
        if is_sensitive_path(&record.path)
            || record.old_path.as_deref().is_some_and(is_sensitive_path)
        {
            excluded_files.push(AiCommitInputNotice {
                path: record.path.clone(),
                reason: "敏感路径已排除".to_string(),
            });
            files.push(metadata_only_file(record, 0, 0));
            continue;
        }

        match read_record_patch(repo_path, &record, has_head).await? {
            PatchInput::Binary => {
                binary_files.push(AiCommitInputNotice {
                    path: record.path.clone(),
                    reason: "Binary 内容未发送".to_string(),
                });
                files.push(metadata_only_file(record, 0, 0));
            }
            PatchInput::SummaryOnly(reason) => {
                summary_only_files.push(AiCommitInputNotice {
                    path: record.path.clone(),
                    reason,
                });
                files.push(metadata_only_file(record, 0, 0));
            }
            PatchInput::Text(raw_patch) => {
                let additions = count_patch_lines(&raw_patch, '+');
                let deletions = count_patch_lines(&raw_patch, '-');
                if raw_patch.trim().is_empty() {
                    summary_only_files.push(AiCommitInputNotice {
                        path: record.path.clone(),
                        reason: "没有可发送的文本 hunk".to_string(),
                    });
                    files.push(metadata_only_file(record, additions, deletions));
                    continue;
                }

                let (sanitized, redacted) = sanitize_diff_content(&raw_patch);
                redacted_line_count = redacted_line_count.saturating_add(redacted);
                let sanitized_len = sanitized.len();
                let exceeds_file_limit = sanitized_len > MAX_COMMIT_FILE_PATCH_BYTES;
                let exceeds_total_limit =
                    sanitized_bytes.saturating_add(sanitized_len) > MAX_COMMIT_TOTAL_PATCH_BYTES;
                if exceeds_file_limit || exceeds_total_limit {
                    summary_only_files.push(AiCommitInputNotice {
                        path: record.path.clone(),
                        reason: if exceeds_file_limit {
                            "单文件 Diff 超过 96 KiB 上限".to_string()
                        } else {
                            "提交信息请求达到 256 KiB 总输入上限".to_string()
                        },
                    });
                    files.push(metadata_only_file(record, additions, deletions));
                    continue;
                }

                sanitized_bytes = sanitized_bytes.saturating_add(sanitized_len);
                included_file_count = included_file_count.saturating_add(1);
                files.push(AiCommitSnapshotFile {
                    path: record.path,
                    old_path: record.old_path,
                    status: record.status,
                    additions,
                    deletions,
                    patch: Some(sanitized),
                });
            }
        }
    }

    let fingerprint = build_fingerprint(
        &head,
        &branch,
        &files,
        &excluded_files,
        &summary_only_files,
        &binary_files,
    );

    Ok(AiCommitSnapshot {
        fingerprint,
        branch,
        head,
        selected_file_count: files.len(),
        included_file_count,
        sanitized_bytes,
        redacted_line_count,
        files,
        excluded_files,
        summary_only_files,
        binary_files,
        recent_subjects,
    })
}

fn metadata_only_file(
    record: StatusRecord,
    additions: u32,
    deletions: u32,
) -> AiCommitSnapshotFile {
    AiCommitSnapshotFile {
        path: record.path,
        old_path: record.old_path,
        status: record.status,
        additions,
        deletions,
        patch: None,
    }
}

fn ensure_repo_path(repo_path: &str) -> Result<(), AiUiError> {
    let normalized = repo_path.trim();
    if normalized.is_empty() || !Path::new(normalized).is_dir() {
        return Err(snapshot_error("仓库路径无效或目录不存在。", false));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<String, AiUiError> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() || normalized.chars().any(char::is_control) {
        return Err(snapshot_error("所选文件路径为空或包含控制字符。", false));
    }
    for component in Path::new(&normalized).components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(snapshot_error("所选文件路径不安全。", false));
        }
    }
    Ok(normalized)
}

fn parse_status_porcelain_z(output: &str) -> Vec<StatusRecord> {
    let fields = output
        .split('\0')
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut records = Vec::new();
    let mut index = 0_usize;
    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.len() < 4 {
            continue;
        }
        let code = &field[..2];
        let mut code_chars = code.chars();
        let index_code = code_chars.next().unwrap_or(' ').to_string();
        let worktree_code = code_chars.next().unwrap_or(' ').to_string();
        let path = field[3..].to_string();
        let renamed = code.contains('R') || code.contains('C');
        let old_path = if renamed && index < fields.len() {
            let value = fields[index].to_string();
            index += 1;
            Some(value)
        } else {
            None
        };
        records.push(StatusRecord {
            path,
            old_path,
            status: normalize_status(code),
            index_code,
            worktree_code,
            is_untracked: code == "??",
            is_conflicted: code.contains('U')
                || matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU"),
        });
    }
    records
}

fn normalize_status(code: &str) -> String {
    if code == "??" {
        "added"
    } else if code.contains('U') {
        "unmerged"
    } else if code.contains('R') {
        "renamed"
    } else if code.contains('C') {
        "copied"
    } else if code.contains('A') {
        "added"
    } else if code.contains('D') {
        "deleted"
    } else if code.contains('T') {
        "typechange"
    } else if code.contains('M') {
        "modified"
    } else {
        "unknown"
    }
    .to_string()
}

fn resolve_selected_records(
    records: &[StatusRecord],
    targets: &[WorkingChangeTarget],
) -> Result<Vec<StatusRecord>, AiUiError> {
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    for target in targets {
        let path = validate_relative_path(&target.path)?;
        let old_path = target
            .old_path
            .as_deref()
            .map(validate_relative_path)
            .transpose()?;
        if target.expected_authority_id.trim().is_empty() {
            return Err(snapshot_error(
                "所选文件的内容 authority 无效，请刷新未提交改动详情后重试。",
                false,
            ));
        }
        let record = records
            .iter()
            .find(|record| {
                record.path == path
                    && record.old_path == old_path
                    && record.index_code == target.expected_index_code
                    && record.worktree_code == target.expected_worktree_code
                    && record.is_untracked == target.expected_is_untracked
            })
            .cloned()
            .ok_or_else(|| {
                snapshot_error("所选文件的改动已经变化，请刷新未提交改动详情后重试。", true)
            })?;
        let identity = format!(
            "{}\0{}\0{}\0{}\0{}",
            record.path,
            record.old_path.as_deref().unwrap_or(""),
            record.index_code,
            record.worktree_code,
            record.is_untracked,
        );
        if seen.insert(identity) {
            selected.push(record);
        }
    }
    Ok(selected)
}

async fn read_record_patch(
    repo_path: &str,
    record: &StatusRecord,
    has_head: bool,
) -> Result<PatchInput, AiUiError> {
    if record.is_untracked {
        let path = Path::new(repo_path).join(&record.path);
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|_| snapshot_error("无法读取所选未跟踪文件。", true))?;
        if !metadata.is_file() {
            return Ok(PatchInput::SummaryOnly(
                "不是普通文件，未读取内容".to_string(),
            ));
        }
        if metadata.len() as usize > MAX_RAW_FILE_BYTES {
            return Ok(PatchInput::SummaryOnly(
                "未跟踪文件超过 5 MiB 读取上限".to_string(),
            ));
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|_| snapshot_error("无法读取所选未跟踪文件。", true))?;
        if bytes.iter().any(|byte| *byte == 0) {
            return Ok(PatchInput::Binary);
        }
        let contents = String::from_utf8_lossy(&bytes);
        return Ok(PatchInput::Text(synthetic_untracked_patch(
            &record.path,
            &contents,
        )));
    }

    let mut args = if has_head {
        vec![
            "diff".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--find-renames".to_string(),
            "--find-copies".to_string(),
            "--unified=3".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            record.path.clone(),
        ]
    } else {
        vec![
            "diff".to_string(),
            "--cached".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--find-renames".to_string(),
            "--find-copies".to_string(),
            "--unified=3".to_string(),
            "--".to_string(),
            record.path.clone(),
        ]
    };
    if let Some(old_path) = record.old_path.as_ref() {
        if old_path != &record.path {
            args.push(old_path.clone());
        }
    }
    let patch = run_git_owned(repo_path, &args).await?;
    if patch.len() > MAX_RAW_FILE_BYTES {
        return Ok(PatchInput::SummaryOnly(
            "原始 Diff 超过 5 MiB 读取上限".to_string(),
        ));
    }
    if looks_binary_patch(&patch) {
        return Ok(PatchInput::Binary);
    }
    Ok(PatchInput::Text(patch))
}

fn synthetic_untracked_patch(path: &str, contents: &str) -> String {
    let line_count = if contents.is_empty() {
        0
    } else {
        contents.lines().count().max(1)
    };
    let mut patch = format!(
        "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1,{1} @@\n",
        path, line_count
    );
    for line in contents.split_inclusive('\n') {
        patch.push('+');
        patch.push_str(line);
    }
    if !contents.is_empty() && !contents.ends_with('\n') {
        patch.push('\n');
        patch.push_str("\\ No newline at end of file\n");
    }
    patch
}

fn looks_binary_patch(value: &str) -> bool {
    value.contains("Binary files ")
        || value.contains("GIT binary patch")
        || value.chars().any(|character| character == '\0')
}

fn count_patch_lines(value: &str, marker: char) -> u32 {
    value
        .lines()
        .filter(|line| {
            line.starts_with(marker) && !line.starts_with("+++") && !line.starts_with("---")
        })
        .count() as u32
}

async fn read_recent_subjects(repo_path: &str) -> Vec<String> {
    let count = MAX_RECENT_SUBJECTS.to_string();
    run_git_text(
        repo_path,
        &["log", "-n", count.as_str(), "--pretty=format:%s"],
    )
    .await
    .unwrap_or_default()
    .lines()
    .filter_map(sanitize_commit_subject)
    .take(MAX_RECENT_SUBJECTS)
    .collect()
}

async fn git_succeeds(repo_path: &str, args: &[&str]) -> bool {
    run_git_text(repo_path, args).await.is_ok()
}

async fn run_git_text(repo_path: &str, args: &[&str]) -> Result<String, AiUiError> {
    let owned = args
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    run_git_owned(repo_path, &owned).await
}

async fn run_git_owned(repo_path: &str, args: &[String]) -> Result<String, AiUiError> {
    let mut command = crate::git_command::new_read_only_async_command(repo_path, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = tokio::time::timeout(
        Duration::from_millis(GIT_SNAPSHOT_TIMEOUT_MS),
        command.output(),
    )
    .await
    .map_err(|_| snapshot_error("读取所选文件的 Git 快照超时。", true))?
    .map_err(|_| snapshot_error("无法执行 Git 快照命令。", true))?;
    if !output.status.success() {
        return Err(snapshot_error("无法读取所选文件的 Git 快照。", true));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn build_fingerprint(
    head: &str,
    branch: &str,
    files: &[AiCommitSnapshotFile],
    excluded: &[AiCommitInputNotice],
    summary_only: &[AiCommitInputNotice],
    binary: &[AiCommitInputNotice],
) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    update_hash(&mut hash, head.as_bytes());
    update_hash(&mut hash, branch.as_bytes());
    for file in files {
        update_hash(&mut hash, file.path.as_bytes());
        update_hash(&mut hash, file.old_path.as_deref().unwrap_or("").as_bytes());
        update_hash(&mut hash, file.status.as_bytes());
        update_hash(&mut hash, &file.additions.to_le_bytes());
        update_hash(&mut hash, &file.deletions.to_le_bytes());
        update_hash(&mut hash, file.patch.as_deref().unwrap_or("").as_bytes());
    }
    for notice in excluded.iter().chain(summary_only).chain(binary) {
        update_hash(&mut hash, notice.path.as_bytes());
        update_hash(&mut hash, notice.reason.as_bytes());
    }
    format!("fnv1a64-{hash:016x}")
}

fn update_hash(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
    *hash ^= 0xff;
    *hash = hash.wrapping_mul(0x100000001b3);
}

fn snapshot_error(message: &str, retryable: bool) -> AiUiError {
    AiUiError::new(
        "AI_SNAPSHOT_FAILED",
        "无法准备提交信息输入",
        message,
        retryable,
    )
}

fn display_or_unknown(value: &str) -> &str {
    if value.trim().is_empty() {
        "unknown"
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_fingerprint, looks_binary_patch, parse_status_porcelain_z, resolve_selected_records,
        AiCommitSnapshotFile,
    };
    use crate::working_changes::WorkingChangeTarget;

    fn target(path: &str, old_path: Option<&str>) -> WorkingChangeTarget {
        let (expected_index_code, expected_worktree_code) = if old_path.is_some() {
            ("R", " ")
        } else {
            (" ", "M")
        };
        WorkingChangeTarget {
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
            expected_index_code: expected_index_code.to_string(),
            expected_worktree_code: expected_worktree_code.to_string(),
            expected_is_untracked: false,
            expected_authority_id: format!("test-authority:{path}"),
        }
    }

    #[test]
    fn parses_and_resolves_exact_selected_paths() {
        let records =
            parse_status_porcelain_z(" M src/a.rs\0R  src/new.rs\0src/old.rs\0?? notes.txt\0");
        let targets = vec![
            target("src/a.rs", None),
            target("src/new.rs", Some("src/old.rs")),
        ];
        let selected = resolve_selected_records(&records, &targets).unwrap();
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[1].old_path.as_deref(), Some("src/old.rs"));
    }

    #[test]
    fn rejects_stale_escaping_or_control_character_targets() {
        let records = parse_status_porcelain_z(" M src/a.rs\0");
        for path in [
            "../outside",
            "/absolute",
            "src/bad\nname.rs",
            "src/missing.rs",
        ] {
            assert!(resolve_selected_records(&records, &[target(path, None)]).is_err());
        }
    }

    #[test]
    fn rejects_missing_content_authority() {
        let records = parse_status_porcelain_z(" M src/a.rs\0");
        let mut missing = target("src/a.rs", None);
        missing.expected_authority_id.clear();
        assert!(resolve_selected_records(&records, &[missing]).is_err());
    }

    #[test]
    fn empty_text_patch_is_not_misclassified_as_binary() {
        assert!(!looks_binary_patch(""));
        assert!(looks_binary_patch("Binary files a/x and b/x differ"));
    }

    #[test]
    fn fingerprint_changes_with_sanitized_content_or_stats() {
        let file = |patch: &str, additions: u32| AiCommitSnapshotFile {
            path: "src/a.rs".to_string(),
            old_path: None,
            status: "modified".to_string(),
            additions,
            deletions: 0,
            patch: Some(patch.to_string()),
        };
        let first = build_fingerprint("head", "main", &[file("+a", 1)], &[], &[], &[]);
        let second = build_fingerprint("head", "main", &[file("+b", 1)], &[], &[], &[]);
        let third = build_fingerprint("head", "main", &[file("+a", 2)], &[], &[], &[]);
        assert_ne!(first, second);
        assert_ne!(first, third);
    }
}
