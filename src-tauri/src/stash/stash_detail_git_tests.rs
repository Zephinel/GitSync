mod stash_detail_git_tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command as StdCommand;

    struct DetailRepo {
        path: PathBuf,
    }

    impl DetailRepo {
        fn new(label: &str) -> Self {
            let path = stash_test_repo_path("gitsync-stash-detail", label);
            fs::create_dir(&path).expect("create detail repository");
            git(&path, &["init", "--quiet"]);
            git(&path, &["config", "user.name", "GitSync Test"]);
            git(
                &path,
                &["config", "user.email", "gitsync-test@example.invalid"],
            );
            fs::write(path.join("tracked.txt"), "base\n").unwrap();
            git(&path, &["add", "--", "tracked.txt"]);
            git(&path, &["commit", "--quiet", "-m", "initial"]);
            Self { path }
        }
    }

    impl Drop for DetailRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn git(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .current_dir(path)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string()
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn file_diff_preserves_backslash_slash_and_whitespace_path_identity() {
        let repo = DetailRepo::new("path-identity");
        fs::create_dir_all(repo.path.join("a")).unwrap();
        let fixtures = [
            ("a\\b.txt", "backslash base\n", "backslash changed\n"),
            ("a/b.txt", "slash base\n", "slash changed\n"),
            (" file.txt", "leading base\n", "leading changed\n"),
            ("file.txt", "normal base\n", "normal changed\n"),
        ];
        for (path, base, _) in fixtures {
            fs::write(repo.path.join(path), base).unwrap();
        }
        git(
            &repo.path,
            &[
                "add",
                "--",
                ":(literal)a\\b.txt",
                ":(literal)a/b.txt",
                ":(literal) file.txt",
                ":(literal)file.txt",
            ],
        );
        git(&repo.path, &["commit", "--quiet", "-m", "path identity baseline"]);
        for (path, _, changed) in fixtures {
            fs::write(repo.path.join(path), changed).unwrap();
        }
        git(
            &repo.path,
            &["stash", "push", "--message", "path identity detail"],
        );
        let oid = git(&repo.path, &["rev-parse", "stash@{0}"]);
        let root = repo.path.to_string_lossy().to_string();

        for (path, base, changed) in fixtures {
            let diff = read_repo_stash_file_diff(&root, &oid, path).await.unwrap();
            assert_eq!(diff.path, path);
            assert!(diff.patch.contains(base.trim_end()), "missing base marker for {path:?}");
            assert!(
                diff.patch.contains(changed.trim_end()),
                "missing changed marker for {path:?}"
            );
        }
    }

    #[tokio::test]
    async fn reads_tracked_and_untracked_detail_with_on_demand_patches() {
        let repo = DetailRepo::new("tracked-untracked");
        fs::write(repo.path.join("tracked.txt"), "changed\n").unwrap();
        fs::write(repo.path.join("note.txt"), "note\n").unwrap();
        git(
            &repo.path,
            &[
                "stash",
                "push",
                "--include-untracked",
                "--message",
                "detail fixture",
            ],
        );
        let oid = git(&repo.path, &["rev-parse", "stash@{0}"]);
        let root = repo.path.to_string_lossy().to_string();

        let detail = read_repo_stash_detail(&root, &oid).await.unwrap();
        assert_eq!(detail.file_count, 2);
        assert_eq!(detail.untracked_files, 1);
        assert!(detail.additions >= 2);
        assert!(detail.deletions >= 1);

        let tracked = detail
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        assert_eq!(tracked.status, "modified");
        assert!(!tracked.is_untracked);

        let untracked = detail
            .files
            .iter()
            .find(|file| file.path == "note.txt")
            .unwrap();
        assert_eq!(untracked.status, "untracked");
        assert!(untracked.is_untracked);
        assert_eq!(untracked.additions, 1);

        let tracked_diff = read_repo_stash_file_diff(&root, &oid, "tracked.txt")
            .await
            .unwrap();
        assert!(tracked_diff.patch.contains("-base"));
        assert!(tracked_diff.patch.contains("+changed"));
        assert!(!tracked_diff.too_large);

        let untracked_diff = read_repo_stash_file_diff(&root, &oid, "note.txt")
            .await
            .unwrap();
        assert!(untracked_diff.patch.contains("--- /dev/null"));
        assert!(untracked_diff.patch.contains("+note"));
        assert!(!untracked_diff.too_large);
    }
}
