use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_REPOSITORY_ID: AtomicU64 = AtomicU64::new(1);

struct TestRepository {
    path: PathBuf,
}

impl TestRepository {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_REPOSITORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gitsync-working-identity-{label}-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temporary repository");
        let repository = Self { path };
        repository.git(&["init", "-q"]);
        repository.git(&["config", "user.email", "gitsync-tests@example.invalid"]);
        repository.git(&["config", "user.name", "GitSync Tests"]);
        repository
    }

    fn write(&self, path: &str, contents: &str) {
        let destination = self.path.join(path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(destination, contents).expect("write fixture");
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.path.join(path)).expect("read fixture")
    }

    fn git(&self, args: &[&str]) -> String {
        run_git(&self.path, args)
    }
}

impl Drop for TestRepository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn run_git(repository: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(repository)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .output()
        .expect("execute git");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("identity fixtures must produce UTF-8 Git stdout")
}

#[cfg(not(target_os = "windows"))]
#[test]
fn literal_commit_scope_does_not_expand_git_pathspec_magic_or_posix_backslash() {
    let repository = TestRepository::new("commit-scope");
    for (path, contents) in [
        (":(glob)*.txt", "magic base\n"),
        ("a.txt", "a base\n"),
        ("b.txt", "b base\n"),
        ("a\\b.txt", "backslash base\n"),
        ("a/b.txt", "slash base\n"),
    ] {
        repository.write(path, contents);
    }
    repository.git(&[
        "add",
        "--",
        ":(literal):(glob)*.txt",
        ":(literal)a.txt",
        ":(literal)b.txt",
        ":(literal)a\\b.txt",
        ":(literal)a/b.txt",
    ]);
    repository.git(&["commit", "-q", "-m", "baseline"]);

    for (path, contents) in [
        (":(glob)*.txt", "magic changed\n"),
        ("a.txt", "a changed\n"),
        ("b.txt", "b changed\n"),
        ("a\\b.txt", "backslash changed\n"),
        ("a/b.txt", "slash changed\n"),
    ] {
        repository.write(path, contents);
    }

    repository.git(&[
        "add",
        "-A",
        "--",
        ":(literal):(glob)*.txt",
        ":(literal)a\\b.txt",
    ]);
    let staged = repository.git(&["diff", "--cached", "--name-only", "-z"]);
    let mut staged_paths = staged
        .split('\0')
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    staged_paths.sort_unstable();
    assert_eq!(staged_paths, vec![":(glob)*.txt", "a\\b.txt"]);

    repository.git(&[
        "reset",
        "-q",
        "HEAD",
        "--",
        ":(literal):(glob)*.txt",
        ":(literal)a\\b.txt",
    ]);
    assert!(repository
        .git(&["diff", "--cached", "--name-only", "-z"])
        .is_empty());
}

#[cfg(not(target_os = "windows"))]
#[test]
fn literal_discard_scope_restores_only_the_selected_special_filename() {
    let repository = TestRepository::new("discard-scope");
    repository.write(":(glob)*.txt", "magic base\n");
    repository.write("a.txt", "a base\n");
    repository.git(&["add", "--", ":(literal):(glob)*.txt", ":(literal)a.txt"]);
    repository.git(&["commit", "-q", "-m", "baseline"]);

    repository.write(":(glob)*.txt", "magic changed\n");
    repository.write("a.txt", "a changed\n");
    repository.git(&[
        "restore",
        "--source=HEAD",
        "--worktree",
        "--",
        ":(literal):(glob)*.txt",
    ]);

    assert_eq!(repository.read(":(glob)*.txt"), "magic base\n");
    assert_eq!(repository.read("a.txt"), "a changed\n");

    repository.write(":(glob)*.txt", "untracked magic\n");
    repository.git(&["rm", "-q", "--cached", "--", ":(literal):(glob)*.txt"]);
    repository.write("other.txt", "other untracked\n");
    repository.git(&["clean", "-f", "--", ":(literal):(glob)*.txt"]);

    assert!(!repository.path.join(":(glob)*.txt").exists());
    assert!(repository.path.join("other.txt").exists());
}
