async fn capture_index_snapshots(
    repo_path: &str,
    paths: &[String],
) -> Result<HashMap<String, (String, Vec<MutationIndexEntry>)>, String> {
    let mut raw_records = paths
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
            "Immutable mutation index path identity",
        )?;
        for record in output.split('\0').filter(|value| !value.is_empty()) {
            let (metadata, path) = record.split_once('\t').ok_or_else(|| {
                "Git index immutable snapshot 返回了无法解析的 ls-files 记录。".to_string()
            })?;
            let bucket = raw_records.get_mut(path).ok_or_else(|| {
                format!("Git index immutable snapshot 返回了未请求路径: {}", path)
            })?;
            bucket.push(metadata.to_string());
        }
    }

    let mut result = HashMap::with_capacity(raw_records.len());
    for (path, mut raw) in raw_records {
        raw.sort();
        let index_id = if raw.is_empty() {
            "index-v1:absent".to_string()
        } else {
            format!("index-v1:{}", raw.join("|"))
        };
        let entries = raw
            .iter()
            .map(|metadata| parse_index_metadata(metadata, &path))
            .collect::<Result<Vec<_>, _>>()?;
        result.insert(path, (index_id, entries));
    }
    Ok(result)
}

#[cfg(unix)]
fn regular_git_mode(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o111 != 0 {
        "100755".to_string()
    } else {
        "100644".to_string()
    }
}

#[cfg(not(unix))]
fn regular_git_mode(_metadata: &std::fs::Metadata) -> String {
    "100644".to_string()
}

#[cfg(unix)]
fn symlink_target_bytes(target: &OsStr) -> Result<Vec<u8>, String> {
    use std::os::unix::ffi::OsStrExt;
    Ok(target.as_bytes().to_vec())
}

#[cfg(target_os = "windows")]
fn symlink_target_bytes(target: &OsStr) -> Result<Vec<u8>, String> {
    target
        .to_str()
        .map(|value| value.as_bytes().to_vec())
        .ok_or_else(|| "Windows 符号链接 target 无法无损转换为 Git blob。".to_string())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn symlink_target_bytes(target: &OsStr) -> Result<Vec<u8>, String> {
    target
        .to_str()
        .map(|value| value.as_bytes().to_vec())
        .ok_or_else(|| "符号链接 target 无法无损转换为 Git blob。".to_string())
}

fn snapshot_temp_path(label: &str) -> std::path::PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "gitsync-immutable-{label}-{}-{nonce}",
        std::process::id()
    ))
}
