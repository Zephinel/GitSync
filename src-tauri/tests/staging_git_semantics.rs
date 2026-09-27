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
    fn new(label: &str, with_initial_commit: bool) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_REPOSITORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gitsync-staging-{label}-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temporary repository");

        let repository = Self { path };
        repository.git(&["init", "-q"]);
        repository.git(&["config", "user.email", "gitsync-tests@example.invalid"]);
        repository.git(&["config", "user.name", "GitSync Tests"]);

        if with_initial_commit {
            repository.write("tracked.txt", "base\n");
            repository.git(&["add", "--", "tracked.txt"]);
            repository.git(&["commit", "-q", "-m", "initial"]);
        }

        repository
    }

    fn write(&self, relative_path: &str, contents: &str) {
        let path = self.path.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, contents).expect("write repository file");
    }

    fn read(&self, relative_path: &str) -> String {
        fs::read_to_string(self.path.join(relative_path)).expect("read repository file")
    }

    fn remove(&self, relative_path: &str) {
        fs::remove_file(self.path.join(relative_path)).expect("remove repository file");
    }

    fn rename(&self, from: &str, to: &str) {
        let destination = self.path.join(to);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).expect("create rename destination");
        }
        fs::rename(self.path.join(from), destination).expect("rename repository file");
    }

    fn git(&self, args: &[&str]) -> String {
        run_git(&self.path, args)
    }

    fn status(&self) -> String {
        self.git(&[
            "status",
            "--porcelain=v1",
            "-z",
            "-uall",
            "--untracked-files=all",
        ])
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
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).to_string()
}

mod staging {
    use super::TestRepository;
    use std::collections::HashSet;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn literal_stage_and_unstage_keep_posix_path_identities_distinct() {
        let repository = TestRepository::new("path-identity", false);
        for (path, contents) in [
            ("a\\b.txt", "backslash base\n"),
            ("a/b.txt", "slash base\n"),
            (" file.txt", "leading base\n"),
            ("file.txt", "normal base\n"),
        ] {
            repository.write(path, contents);
        }
        repository.git(&[
            "add",
            "--",
            ":(literal)a\\b.txt",
            ":(literal)a/b.txt",
            ":(literal) file.txt",
            ":(literal)file.txt",
        ]);
        repository.git(&["commit", "-q", "-m", "identity baseline"]);

        for (path, contents) in [
            ("a\\b.txt", "backslash changed\n"),
            ("a/b.txt", "slash changed\n"),
            (" file.txt", "leading changed\n"),
            ("file.txt", "normal changed\n"),
        ] {
            repository.write(path, contents);
        }

        repository.git(&[
            "add",
            "-A",
            "--",
            ":(literal)a\\b.txt",
            ":(literal) file.txt",
        ]);
        let staged = repository.git(&["diff", "--cached", "--name-only", "-z"]);
        let staged_paths = staged
            .split('\0')
            .filter(|path| !path.is_empty())
            .collect::<HashSet<_>>();
        assert_eq!(staged_paths, HashSet::from(["a\\b.txt", " file.txt"]));

        repository.git(&[
            "restore",
            "--staged",
            "--source=HEAD",
            "--",
            ":(literal)a\\b.txt",
            ":(literal) file.txt",
        ]);
        assert!(repository
            .git(&["diff", "--cached", "--name-only", "-z"])
            .is_empty());
        let status = repository.status();
        let status_paths = status
            .split('\0')
            .filter(|field| field.len() >= 4)
            .map(|field| &field[3..])
            .collect::<HashSet<_>>();
        assert_eq!(
            status_paths,
            HashSet::from(["a\\b.txt", "a/b.txt", " file.txt", "file.txt"])
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn legal_colon_paths_can_form_distinct_batch_unstage_identities() {
        let repository = TestRepository::new("colon-composite", false);
        repository.write(":a", "rename source\n");
        repository.write("a:b", "modified base\n");
        repository.git(&["add", "--", ":(literal):a", ":(literal)a:b"]);
        repository.git(&["commit", "-q", "-m", "colon identity baseline"]);

        repository.write("a:b", "modified staged\n");
        repository.git(&["add", "--", ":(literal)a:b"]);
        repository.git(&["mv", "--", ":a", "b"]);

        let status = repository.status();
        assert!(
            status.contains("M  a:b\0"),
            "missing modified colon path: {status:?}"
        );
        assert!(
            status.contains("R  b\0:a\0"),
            "missing rename colon identity: {status:?}"
        );

        repository.git(&[
            "restore",
            "--staged",
            "--source=HEAD",
            "--",
            ":(literal)a:b",
            ":(literal)b",
            ":(literal):a",
        ]);
        let after = repository.status();
        assert!(after.contains(" M a:b\0"));
        assert!(after.contains(" D :a\0"));
        assert!(after.contains("?? b\0"));
    }

    #[test]
    fn tracked_file_stage_and_unstage_preserve_worktree_contents() {
        let repository = TestRepository::new("tracked", true);
        repository.write("tracked.txt", "changed\n");
        let expected_contents = repository.read("tracked.txt");

        repository.git(&["add", "-A", "--", "tracked.txt"]);
        assert_eq!(repository.status(), "M  tracked.txt\0");
        assert_eq!(repository.read("tracked.txt"), expected_contents);

        repository.git(&["restore", "--staged", "--source=HEAD", "--", "tracked.txt"]);
        assert_eq!(repository.status(), " M tracked.txt\0");
        assert_eq!(repository.read("tracked.txt"), expected_contents);
    }

    #[test]
    fn staging_a_mixed_file_captures_remaining_worktree_changes() {
        let repository = TestRepository::new("mixed", true);
        repository.write("tracked.txt", "staged version\n");
        repository.git(&["add", "-A", "--", "tracked.txt"]);
        repository.write("tracked.txt", "final worktree version\n");
        assert_eq!(repository.status(), "MM tracked.txt\0");

        let expected_contents = repository.read("tracked.txt");
        repository.git(&["add", "-A", "--", "tracked.txt"]);
        assert_eq!(repository.status(), "M  tracked.txt\0");
        assert_eq!(repository.read("tracked.txt"), expected_contents);

        repository.git(&["restore", "--staged", "--source=HEAD", "--", "tracked.txt"]);
        assert_eq!(repository.status(), " M tracked.txt\0");
        assert_eq!(repository.read("tracked.txt"), expected_contents);
    }

    #[test]
    fn untracked_file_returns_to_untracked_after_unstage() {
        let repository = TestRepository::new("untracked", true);
        repository.write("new file.txt", "new contents\n");
        let expected_contents = repository.read("new file.txt");

        repository.git(&["add", "-A", "--", "new file.txt"]);
        assert_eq!(repository.status(), "A  new file.txt\0");

        repository.git(&["restore", "--staged", "--source=HEAD", "--", "new file.txt"]);
        assert_eq!(repository.status(), "?? new file.txt\0");
        assert_eq!(repository.read("new file.txt"), expected_contents);
    }

    #[test]
    fn deleted_file_stage_and_unstage_do_not_recreate_or_discard_it() {
        let repository = TestRepository::new("deleted", true);
        repository.remove("tracked.txt");

        repository.git(&["add", "-A", "--", "tracked.txt"]);
        assert_eq!(repository.status(), "D  tracked.txt\0");
        assert!(!repository.path.join("tracked.txt").exists());

        repository.git(&["restore", "--staged", "--source=HEAD", "--", "tracked.txt"]);
        assert_eq!(repository.status(), " D tracked.txt\0");
        assert!(!repository.path.join("tracked.txt").exists());
    }

    #[test]
    fn staged_rename_splits_safely_after_unstage() {
        let repository = TestRepository::new("rename", true);
        repository.rename("tracked.txt", "nested/moved.txt");
        let expected_contents = repository.read("nested/moved.txt");

        repository.git(&["add", "-A", "--", "nested/moved.txt", "tracked.txt"]);
        let staged_status = repository.status();
        assert!(
            staged_status.starts_with("R  "),
            "expected staged rename, got {staged_status:?}"
        );

        repository.git(&[
            "restore",
            "--staged",
            "--source=HEAD",
            "--",
            "nested/moved.txt",
            "tracked.txt",
        ]);
        let unstaged_status = repository.status();
        assert!(unstaged_status.contains(" D tracked.txt\0"));
        assert!(unstaged_status.contains("?? nested/moved.txt\0"));
        assert_eq!(repository.read("nested/moved.txt"), expected_contents);
        assert!(!repository.path.join("tracked.txt").exists());
    }

    #[test]
    fn unborn_repository_unstage_removes_only_the_index_entry() {
        let repository = TestRepository::new("unborn", false);
        repository.write("first.txt", "first contents\n");
        let expected_contents = repository.read("first.txt");

        repository.git(&["add", "-A", "--", "first.txt"]);
        assert_eq!(repository.status(), "A  first.txt\0");

        repository.git(&[
            "rm",
            "-r",
            "-f",
            "--cached",
            "--ignore-unmatch",
            "--",
            "first.txt",
        ]);
        assert_eq!(repository.status(), "?? first.txt\0");
        assert_eq!(repository.read("first.txt"), expected_contents);
    }
}
