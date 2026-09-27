pub const UNSUPPORTED_GIT_PATH_ENCODING: &str = "UNSUPPORTED_GIT_PATH_ENCODING";

fn encoding_error(context: &str, valid_up_to: usize) -> String {
    format!(
        "{}: {} 包含当前 UTF-8/Tauri 协议无法无损表示的 Git 字节路径（valid_up_to={}）。为避免文件 identity 重绑定，本次读取已中止。",
        UNSUPPORTED_GIT_PATH_ENCODING, context, valid_up_to
    )
}

// Use only for Git stdout that can carry repository path identity. Any invalid
// UTF-8 byte must fail closed before the path can become executable authority.
pub fn decode_git_stdout(bytes: Vec<u8>, context: &str) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|error| {
        let valid_up_to = error.utf8_error().valid_up_to();
        encoding_error(context, valid_up_to)
    })
}

pub fn decode_git_field(bytes: &[u8], context: &str) -> Result<String, String> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|error| encoding_error(context, error.valid_up_to()))
}

// Diff/file payload bytes are display content, not path or mutation identity.
// Keep this boundary deliberately separate from decode_git_stdout/decode_git_field:
// replacement characters are acceptable for a lossy preview, but must never be
// fed back into Git as a repository-relative path.
pub fn decode_git_display_content(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        decode_git_display_content, decode_git_field, decode_git_stdout,
        UNSUPPORTED_GIT_PATH_ENCODING,
    };

    #[test]
    fn preserves_valid_utf8_exactly() {
        assert_eq!(
            decode_git_stdout(b"a\\b.txt\0a/b.txt\0".to_vec(), "test").unwrap(),
            "a\\b.txt\0a/b.txt\0"
        );
        assert_eq!(
            decode_git_field(" 文件.txt".as_bytes(), "test").unwrap(),
            " 文件.txt"
        );
    }

    #[test]
    fn invalid_utf8_fails_closed_instead_of_emitting_replacement_characters() {
        let first =
            decode_git_stdout(vec![b'x', 0x80, b'.', b't', b'x', b't'], "test").unwrap_err();
        let second = decode_git_field(&[b'x', 0x81, b'.', b't', b'x', b't'], "test").unwrap_err();

        assert!(first.starts_with(UNSUPPORTED_GIT_PATH_ENCODING));
        assert!(second.starts_with(UNSUPPORTED_GIT_PATH_ENCODING));
        assert!(!first.contains('\u{fffd}'));
        assert!(!second.contains('\u{fffd}'));
    }

    #[test]
    fn non_utf8_display_content_is_lossy_without_becoming_a_path_encoding_error() {
        let rendered = decode_git_display_content(vec![b'c', b'a', b'f', 0xe9, b'\n']);
        assert_eq!(rendered, "caf\u{fffd}\n");
        assert!(!rendered.contains(UNSUPPORTED_GIT_PATH_ENCODING));
    }

    #[cfg(unix)]
    #[test]
    fn real_git_invalid_byte_path_is_rejected_before_identity_projection() {
        use std::fs;
        use std::io::Write;
        use std::process::{Command, Stdio};
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "gitsync-invalid-git-path-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let init = Command::new("git")
            .current_dir(&root)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(init.status.success());

        let mut hash_object = Command::new("git")
            .current_dir(&root)
            .args(["hash-object", "-w", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        hash_object
            .stdin
            .take()
            .unwrap()
            .write_all(b"invalid path fixture\n")
            .unwrap();
        let hash_object_output = hash_object.wait_with_output().unwrap();
        assert!(hash_object_output.status.success());
        let blob_oid = String::from_utf8(hash_object_output.stdout)
            .unwrap()
            .trim()
            .to_string();

        let mut update_index = Command::new("git")
            .current_dir(&root)
            .args(["update-index", "-z", "--index-info"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut index_info = update_index.stdin.take().unwrap();
        write!(index_info, "100644 {blob_oid}\t").unwrap();
        index_info
            .write_all(&[b'x', 0x80, b'.', b't', b'x', b't', 0])
            .unwrap();
        drop(index_info);
        let update_index_output = update_index.wait_with_output().unwrap();
        assert!(update_index_output.status.success());

        let output = Command::new("git")
            .current_dir(&root)
            .args([
                "status",
                "--porcelain=v1",
                "-z",
                "-uall",
                "--untracked-files=all",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.contains(&0x80));

        let error = decode_git_stdout(output.stdout, "real git status").unwrap_err();
        assert!(error.starts_with(UNSUPPORTED_GIT_PATH_ENCODING));
        assert!(!error.contains('\u{fffd}'));

        let _ = fs::remove_dir_all(root);
    }
}
