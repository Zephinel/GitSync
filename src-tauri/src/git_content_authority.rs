use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const GIT_CONTENT_AUTHORITY_TIMEOUT_MS: u64 = crate::git_timeouts::CONTENT_AUTHORITY;
const GIT_CONTENT_AUTHORITY_ARG_BUDGET: usize = 24 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PathContentAuthority {
    index_id: String,
    worktree_id: String,
}

fn literal_pathspec(path: &str) -> String {
    format!(":(literal){}", path)
}

fn encode_component(value: &str) -> String {
    format!("{}:{}", value.len(), value)
}

fn encode_entry_content_authority(
    current: &PathContentAuthority,
    old: Option<&PathContentAuthority>,
) -> String {
    let old_index = old.map(|value| value.index_id.as_str()).unwrap_or("index-v1:absent");
    let old_worktree = old
        .map(|value| value.worktree_id.as_str())
        .unwrap_or("worktree-v1:missing");
    format!(
        "mutation-content-v1:{}:{}:{}:{}",
        encode_component(&current.index_id),
        encode_component(&current.worktree_id),
        encode_component(old_index),
        encode_component(old_worktree),
    )
}

fn chunk_path_ranges(paths: &[String], fixed_arg_bytes: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    while start < paths.len() {
        let mut end = start;
        let mut bytes = fixed_arg_bytes;
        while end < paths.len() {
            let next = paths[end].len().saturating_add(16);
            if end > start && bytes.saturating_add(next) > GIT_CONTENT_AUTHORITY_ARG_BUDGET {
                break;
            }
            bytes = bytes.saturating_add(next);
            end += 1;
        }
        if end == start {
            end += 1;
        }
        ranges.push((start, end));
        start = end;
    }
    ranges
}

fn new_git_read_command(repo_path: &str, args: &[String]) -> Command {
    let mut command = crate::git_command::new_read_only_async_command(repo_path, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    command
}

fn new_git_mutation_command(repo_path: &str, args: &[String]) -> Command {
    let mut command = crate::git_command::new_mutation_async_command(repo_path, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    command
}

async fn run_git_command_bytes(
    mut command: Command,
    args: &[String],
) -> Result<Vec<u8>, String> {
    let output = tokio::time::timeout(
        Duration::from_millis(GIT_CONTENT_AUTHORITY_TIMEOUT_MS),
        command.output(),
    )
    .await
    .map_err(|_| format!("Git 内容 authority 命令执行超时: git {}", args.join(" ")))?
    .map_err(|error| format!("无法执行 Git 内容 authority 命令: {}", error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "Git 内容 authority 命令失败: git {}（退出码 {:?}）",
                args.join(" "),
                output.status.code()
            )
        } else {
            stderr
        });
    }
    Ok(output.stdout)
}

async fn run_git_bytes(repo_path: &str, args: &[String]) -> Result<Vec<u8>, String> {
    run_git_command_bytes(new_git_read_command(repo_path, args), args).await
}

async fn run_git_mutation_bytes(repo_path: &str, args: &[String]) -> Result<Vec<u8>, String> {
    run_git_command_bytes(new_git_mutation_command(repo_path, args), args).await
}

fn bytes_hex(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    value
}

#[cfg(unix)]
fn os_str_bytes_identity(value: &OsStr) -> String {
    use std::os::unix::ffi::OsStrExt;
    bytes_hex(value.as_bytes())
}

#[cfg(target_os = "windows")]
fn os_str_bytes_identity(value: &OsStr) -> String {
    use std::os::windows::ffi::OsStrExt;
    let units = value.encode_wide().collect::<Vec<_>>();
    let mut bytes = Vec::with_capacity(units.len().saturating_mul(2));
    for unit in units {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes_hex(&bytes)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn os_str_bytes_identity(value: &OsStr) -> String {
    bytes_hex(value.to_string_lossy().as_bytes())
}

#[cfg(unix)]
fn metadata_mode(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    format!("{:o}", metadata.permissions().mode())
}

#[cfg(not(unix))]
fn metadata_mode(metadata: &std::fs::Metadata) -> String {
    format!("readonly={}", metadata.permissions().readonly())
}

async fn collect_index_content_ids(
    repo_path: &str,
    paths: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut records = paths
        .iter()
        .cloned()
        .map(|path| (path, Vec::<String>::new()))
        .collect::<BTreeMap<_, _>>();

    for (start, end) in chunk_path_ranges(paths, 64) {
        let mut args = vec![
            "ls-files".to_string(),
            "--stage".to_string(),
            "-z".to_string(),
            "--".to_string(),
        ];
        args.extend(paths[start..end].iter().map(|path| literal_pathspec(path)));
        let bytes = run_git_bytes(repo_path, &args).await?;
        let output = crate::git_encoding::decode_git_stdout(
            bytes,
            "Mutation content index path identity",
        )?;
        for record in output.split('\0').filter(|value| !value.is_empty()) {
            let (metadata, path) = record.split_once('\t').ok_or_else(|| {
                "Git index 内容 authority 返回了无法解析的 ls-files 记录。".to_string()
            })?;
            let bucket = records.get_mut(path).ok_or_else(|| {
                format!("Git index 内容 authority 返回了未请求的路径: {}", path)
            })?;
            bucket.push(metadata.to_string());
        }
    }

    let mut result = HashMap::with_capacity(records.len());
    for (path, mut values) in records {
        values.sort();
        let id = if values.is_empty() {
            "index-v1:absent".to_string()
        } else {
            format!("index-v1:{}", values.join("|"))
        };
        result.insert(path, id);
    }
    Ok(result)
}

async fn directory_head(repo_path: &str, relative_path: &str) -> Result<Option<String>, String> {
    let absolute = Path::new(repo_path).join(relative_path);
    let args = vec![
        "-C".to_string(),
        absolute.to_string_lossy().to_string(),
        "rev-parse".to_string(),
        "--verify".to_string(),
        "HEAD".to_string(),
    ];
    let mut command = new_git_read_command(repo_path, &args);
    let output = tokio::time::timeout(
        Duration::from_millis(GIT_CONTENT_AUTHORITY_TIMEOUT_MS),
        command.output(),
    )
    .await
    .map_err(|_| format!("读取目录 Git HEAD 超时: {}", relative_path))?
    .map_err(|error| format!("读取目录 Git HEAD 失败: {}", error))?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| format!("目录 Git HEAD 返回了非 UTF-8 元数据: {}", relative_path))?
        .trim()
        .to_string();
    Ok((!value.is_empty()).then_some(value))
}

async fn collect_worktree_content_ids(
    repo_path: &str,
    paths: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::with_capacity(paths.len());
    let mut regular_paths = Vec::new();
    let mut regular_modes = HashMap::new();

    for path in paths {
        let absolute = Path::new(repo_path).join(path);
        let metadata = match tokio::fs::symlink_metadata(&absolute).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                result.insert(path.clone(), "worktree-v1:missing".to_string());
                continue;
            }
            Err(error) => {
                return Err(format!("读取文件内容 authority 元数据失败（{}）: {}", path, error));
            }
        };
        let mode = metadata_mode(&metadata);
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            let target = tokio::fs::read_link(&absolute)
                .await
                .map_err(|error| format!("读取符号链接 authority 失败（{}）: {}", path, error))?;
            result.insert(
                path.clone(),
                format!(
                    "worktree-v1:symlink:{}:{}",
                    mode,
                    os_str_bytes_identity(target.as_os_str())
                ),
            );
        } else if file_type.is_file() {
            regular_modes.insert(path.clone(), mode);
            regular_paths.push(path.clone());
        } else if file_type.is_dir() {
            let head = directory_head(repo_path, path).await?;
            result.insert(
                path.clone(),
                format!(
                    "worktree-v1:directory:{}:{}",
                    mode,
                    head.unwrap_or_else(|| "no-git-head".to_string())
                ),
            );
        } else {
            result.insert(
                path.clone(),
                format!("worktree-v1:special:{}:{}", mode, metadata.len()),
            );
        }
    }

    for (start, end) in chunk_path_ranges(&regular_paths, 64) {
        let chunk = &regular_paths[start..end];
        let mut args = vec![
            "hash-object".to_string(),
            "--no-filters".to_string(),
            "--".to_string(),
        ];
        args.extend(chunk.iter().cloned());
        let output = run_git_bytes(repo_path, &args).await?;
        let text = String::from_utf8(output)
            .map_err(|_| "git hash-object 返回了非 UTF-8 对象 ID。".to_string())?;
        let hashes = text.lines().filter(|line| !line.is_empty()).collect::<Vec<_>>();
        if hashes.len() != chunk.len() {
            return Err("git hash-object 返回数量与请求文件数量不一致；内容 authority 已中止。".to_string());
        }
        for (path, hash) in chunk.iter().zip(hashes) {
            if !matches!(hash.len(), 40 | 64) || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
                return Err(format!("git hash-object 返回了无效对象 ID: {}", hash));
            }
            let mode = regular_modes
                .get(path)
                .ok_or_else(|| format!("缺少文件权限 authority: {}", path))?;
            result.insert(
                path.clone(),
                format!("worktree-v1:file:{}:{}", mode, hash.to_ascii_lowercase()),
            );
        }
    }

    Ok(result)
}

pub async fn collect_mutation_content_ids(
    repo_path: &str,
    entries: &[(String, Option<String>)],
) -> Result<Vec<String>, String> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let mut unique = BTreeMap::<String, ()>::new();
    for (path, old_path) in entries {
        unique.insert(path.clone(), ());
        if let Some(old_path) = old_path {
            unique.insert(old_path.clone(), ());
        }
    }
    let paths = unique.into_keys().collect::<Vec<_>>();
    let index = collect_index_content_ids(repo_path, &paths).await?;
    let worktree = collect_worktree_content_ids(repo_path, &paths).await?;

    let mut path_authorities = HashMap::with_capacity(paths.len());
    for path in paths {
        let index_id = index
            .get(&path)
            .cloned()
            .ok_or_else(|| format!("缺少 index 内容 authority: {}", path))?;
        let worktree_id = worktree
            .get(&path)
            .cloned()
            .ok_or_else(|| format!("缺少 worktree 内容 authority: {}", path))?;
        path_authorities.insert(path, PathContentAuthority { index_id, worktree_id });
    }

    entries
        .iter()
        .map(|(path, old_path)| {
            let current = path_authorities
                .get(path)
                .ok_or_else(|| format!("缺少当前路径内容 authority: {}", path))?;
            let old = old_path
                .as_ref()
                .map(|old_path| {
                    path_authorities
                        .get(old_path)
                        .ok_or_else(|| format!("缺少旧路径内容 authority: {}", old_path))
                })
                .transpose()?;
            Ok(encode_entry_content_authority(current, old))
        })
        .collect()
}

#[cfg(test)]
pub fn attach_mutation_content_id(status_id: &str, content_id: &str) -> String {
    format!("{}\0{}", status_id, content_id)
}

#[cfg(test)]
mod tests {
    use super::{attach_mutation_content_id, collect_mutation_content_ids, hash_snapshot_file};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRepo {
        path: PathBuf,
    }

    impl TestRepo {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "gitsync-content-authority-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            let repo = Self { path };
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.email", "gitsync-tests@example.invalid"]);
            repo.git(&["config", "user.name", "GitSync Tests"]);
            repo
        }

        fn git(&self, args: &[&str]) -> Vec<u8> {
            let output = Command::new("git")
                .current_dir(&self.path)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        }

        fn write(&self, path: &str, bytes: &[u8]) {
            fs::write(self.path.join(path), bytes).unwrap();
        }

        fn status(&self, path: &str) -> String {
            String::from_utf8(self.git(&["status", "--porcelain=v1", "--", path])).unwrap()
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    async fn authority(repo: &Path, path: &str) -> String {
        collect_mutation_content_ids(repo.to_str().unwrap(), &[(path.to_string(), None)])
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
    }

    #[tokio::test]
    async fn immutable_snapshot_hash_persists_blob_in_object_database() {
        let repo = TestRepo::new("snapshot-object-write");
        let snapshot = repo.path.join("snapshot-input.txt");
        fs::write(&snapshot, b"captured mutation input\n").unwrap();

        let oid = hash_snapshot_file(repo.path.to_str().unwrap(), &snapshot, None)
            .await
            .unwrap();
        let blob_spec = format!("{}^{{blob}}", oid);
        repo.git(&["cat-file", "-e", blob_spec.as_str()]);
    }

    #[tokio::test]
    async fn unstaged_content_change_invalidates_authority_even_when_xy_status_is_unchanged() {
        let repo = TestRepo::new("unstaged");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);

        repo.write("a.txt", b"A\n");
        let status_a = repo.status("a.txt");
        let authority_a = authority(&repo.path, "a.txt").await;
        repo.write("a.txt", b"B\n");
        let status_b = repo.status("a.txt");
        let authority_b = authority(&repo.path, "a.txt").await;

        assert_eq!(status_a, status_b);
        assert_eq!(status_a, " M a.txt\n");
        assert_ne!(authority_a, authority_b);
    }

    #[tokio::test]
    async fn staged_content_change_invalidates_authority_even_when_xy_status_is_unchanged() {
        let repo = TestRepo::new("staged");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);

        repo.write("a.txt", b"A\n");
        repo.git(&["add", "--", "a.txt"]);
        let status_a = repo.status("a.txt");
        let authority_a = authority(&repo.path, "a.txt").await;
        repo.write("a.txt", b"B\n");
        repo.git(&["add", "--", "a.txt"]);
        let status_b = repo.status("a.txt");
        let authority_b = authority(&repo.path, "a.txt").await;

        assert_eq!(status_a, status_b);
        assert_eq!(status_a, "M  a.txt\n");
        assert_ne!(authority_a, authority_b);
    }

    #[tokio::test]
    async fn non_utf8_file_content_can_form_authority_without_path_decoding() {
        let repo = TestRepo::new("non-utf8-content");
        repo.write("latin.txt", b"caf\xe9\n");
        let id = authority(&repo.path, "latin.txt").await;
        assert!(id.starts_with("mutation-content-v1:"));
        assert!(!id.contains('\u{fffd}'));
    }

    #[test]
    fn status_and_content_authority_composition_is_injective_for_nul_free_git_fields() {
        let first = attach_mutation_content_id("M\0 \0\0a:b\0false", "content:one");
        let second = attach_mutation_content_id("R\0 \0:a\0b\0false", "content:two");
        assert_ne!(first, second);
    }
}
