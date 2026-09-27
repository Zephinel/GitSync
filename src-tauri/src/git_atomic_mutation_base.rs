use crate::git_content_authority::{
    capture_mutation_entry_snapshots, MutationEntrySnapshot, MutationIndexEntry,
    MutationPathSnapshot, MutationWorktreeState,
};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const GIT_ATOMIC_MUTATION_TIMEOUT_MS: u64 = crate::git_timeouts::ATOMIC_MUTATION;

#[derive(Debug, Clone)]
pub struct AtomicCommitResult {
    pub commit_hash: String,
    pub index_reconciled: bool,
}

#[derive(Debug, Clone)]
pub struct AtomicDiscardResult {
    pub recovery_paths: Vec<String>,
    pub external_change_preserved: bool,
}

type IndexStateMap = BTreeMap<String, Option<MutationIndexEntry>>;

fn literal_pathspec(path: &str) -> String {
    format!(":(literal){}", path)
}

fn new_git_command(
    repo_path: &str,
    args: &[String],
    envs: &[(String, String)],
    stdin_piped: bool,
) -> Command {
    let mut command = crate::git_command::new_mutation_async_command(repo_path, args);
    command
        .stdin(if stdin_piped { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in envs {
        command.env(key, value);
    }

    command
}

async fn run_git_bytes(
    repo_path: &str,
    args: &[String],
    envs: &[(String, String)],
    stdin: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut command = new_git_command(repo_path, args, envs, stdin.is_some());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Git atomic mutation 命令: {}", error))?;
    if let Some(input) = stdin {
        let mut child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Git atomic mutation stdin 不可用。".to_string())?;
        child_stdin
            .write_all(input)
            .await
            .map_err(|error| format!("写入 Git atomic mutation stdin 失败: {}", error))?;
        drop(child_stdin);
    }
    let output = tokio::time::timeout(
        Duration::from_millis(GIT_ATOMIC_MUTATION_TIMEOUT_MS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("Git atomic mutation 命令超时: git {}", args.join(" ")))?
    .map_err(|error| format!("等待 Git atomic mutation 命令失败: {}", error))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "Git atomic mutation 命令失败: git {}（退出码 {:?}）",
                args.join(" "),
                output.status.code()
            )
        } else {
            stderr
        });
    }
    Ok(output.stdout)
}

async fn run_git_text(
    repo_path: &str,
    args: &[String],
    envs: &[(String, String)],
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let bytes = run_git_bytes(repo_path, args, envs, stdin).await?;
    String::from_utf8(bytes)
        .map_err(|_| format!("Git atomic mutation 返回了非 UTF-8 元数据: git {}", args.join(" ")))
}

fn parse_oid(value: &str, context: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if !matches!(value.len(), 40 | 64) || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(format!("{} 返回了无效 Git object id: {}", context, value));
    }
    Ok(value)
}

fn snapshot_paths(snapshot: &MutationEntrySnapshot) -> Vec<&MutationPathSnapshot> {
    let mut values = vec![&snapshot.current];
    if let Some(old) = snapshot.old.as_ref() {
        if old.path != snapshot.current.path {
            values.push(old);
        }
    }
    values
}

fn merge_index_state(
    map: &mut IndexStateMap,
    path: &str,
    state: Option<MutationIndexEntry>,
) -> Result<(), String> {
    match map.get(path) {
        Some(existing) if existing != &state => Err(format!(
            "同一路径出现不一致的 immutable index preimage: {}",
            path
        )),
        Some(_) => Ok(()),
        None => {
            map.insert(path.to_string(), state);
            Ok(())
        }
    }
}

fn snapshot_index_map(snapshots: &[MutationEntrySnapshot]) -> Result<IndexStateMap, String> {
    let mut map = IndexStateMap::new();
    for snapshot in snapshots {
        for path in snapshot_paths(snapshot) {
            merge_index_state(&mut map, &path.path, path.stage0_index_entry()?)?;
        }
    }
    Ok(map)
}

fn snapshot_worktree_index_map(
    snapshots: &[MutationEntrySnapshot],
) -> Result<IndexStateMap, String> {
    let mut map = IndexStateMap::new();
    for snapshot in snapshots {
        for path in snapshot_paths(snapshot) {
            merge_index_state(&mut map, &path.path, path.worktree.index_entry()?)?;
        }
    }
    Ok(map)
}

fn selected_paths(snapshots: &[MutationEntrySnapshot]) -> Vec<String> {
    let mut map = BTreeMap::<String, ()>::new();
    for snapshot in snapshots {
        map.insert(snapshot.path.clone(), ());
        if let Some(old_path) = snapshot.old_path.as_ref() {
            map.insert(old_path.clone(), ());
        }
    }
    map.into_keys().collect()
}

async fn resolve_git_dir(repo_path: &str) -> Result<PathBuf, String> {
    let args = vec!["rev-parse".to_string(), "--git-dir".to_string()];
    let value = run_git_text(repo_path, &args, &[], None).await?;
    let value = value.trim();
    if value.is_empty() {
        return Err("无法解析 Git dir。".to_string());
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        Path::new(repo_path).join(path)
    })
}

fn unique_temp_path(base: &Path, label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    base.join(format!(
        "gitsync-{label}-{}-{nonce}",
        std::process::id()
    ))
}


include!("git_atomic_mutation_index.rs");
include!("git_atomic_mutation_commit.rs");
include!("git_atomic_mutation_discard.rs");
include!("git_atomic_mutation_tests.rs");
