#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_content_authority::collect_mutation_content_ids;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command as StdCommand;

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
                "gitsync-atomic-mutation-{label}-{}-{nonce}",
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
            let output = StdCommand::new("git")
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

        fn head(&self) -> String {
            String::from_utf8(self.git(&["rev-parse", "HEAD"]))
                .unwrap()
                .trim()
                .to_string()
        }

        async fn authority(&self, path: &str) -> String {
            collect_mutation_content_ids(
                self.path.to_str().unwrap(),
                &[(path.to_string(), None)],
            )
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn guard_cleanup_failure_does_not_relabel_completed_mutation() {
        let result = finish_mutation_after_guard_release(
            Ok::<_, String>("discard completed".to_string()),
            Err("cleanup failed".to_string()),
        );
        assert_eq!(result, Ok("discard completed".to_string()));

        let result = finish_mutation_after_guard_release(
            Err::<String, _>("mutation failed".to_string()),
            Err("cleanup failed".to_string()),
        );
        assert_eq!(result, Err("mutation failed".to_string()));
    }

    #[tokio::test]
    async fn expected_head_guard_releases_after_prepare_without_sigpipe() {
        let repo = TestRepo::new("head-guard-release");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        let head = repo.head();

        let guard = ExpectedHeadRefGuard::acquire(repo.path.to_str().unwrap(), Some(&head))
            .await
            .unwrap();
        guard.release().await.unwrap();
    }

    #[tokio::test]
    async fn stage_uses_verified_immutable_blob_when_worktree_changes_after_verification() {
        let repo = TestRepo::new("stage-race");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"A\n");
        let expected = repo.authority("a.txt").await;
        let hook = || repo.write("a.txt", b"B\n");
        stage_verified_entry_inner(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
            Some(&hook),
        )
        .await
        .unwrap();
        assert_eq!(repo.git(&["show", ":a.txt"]), b"A\n");
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"B\n");
    }

    #[tokio::test]
    async fn unstage_rejects_external_index_replacement_after_verification() {
        let repo = TestRepo::new("unstage-race");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"A\n");
        repo.git(&["add", "--", "a.txt"]);
        let expected = repo.authority("a.txt").await;
        let head = repo.head();
        let hook = || {
            repo.write("a.txt", b"B\n");
            repo.git(&["add", "--", "a.txt"]);
        };
        let error = unstage_verified_entry_inner(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
            Some(&head),
            Some(&hook),
        )
        .await
        .unwrap_err();
        assert!(error.contains("外部 index 变化"));
        assert_eq!(repo.git(&["show", ":a.txt"]), b"B\n");
    }

    #[tokio::test]
    async fn commit_uses_verified_blob_and_preserves_later_worktree_content() {
        let repo = TestRepo::new("commit-race");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"A\n");
        let expected = repo.authority("a.txt").await;
        let head = repo.head();
        let hook = || repo.write("a.txt", b"B\n");
        let result = commit_verified_entries_inner(
            repo.path.to_str().unwrap(),
            &[("a.txt".to_string(), None, expected)],
            Some(&head),
            "verified A",
            Some(&hook),
        )
        .await
        .unwrap();
        assert_eq!(repo.git(&["show", "HEAD:a.txt"]), b"A\n");
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"B\n");
        assert_eq!(repo.head(), result.commit_hash);
    }

    #[tokio::test]
    async fn discard_preserves_external_replacement_at_deterministic_barrier() {
        let repo = TestRepo::new("discard-race");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"A\n");
        let expected = repo.authority("a.txt").await;
        let head = repo.head();
        let hook = || {
            let replacement = repo.path.join("replacement.tmp");
            fs::write(&replacement, b"B\n").unwrap();
            fs::rename(replacement, repo.path.join("a.txt")).unwrap();
        };
        let error = discard_verified_entry_inner(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
            Some(&head),
            Some(&hook),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.contains("外部内容已保留"));
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"B\n");
    }

    #[tokio::test]
    async fn discard_overwrites_external_replacement_after_claim() {
        let repo = TestRepo::new("discard-overwrite-race");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"A\n");
        let expected = repo.authority("a.txt").await;
        let head = repo.head();
        let hook = || {
            let replacement = repo.path.join("replacement.tmp");
            fs::write(&replacement, b"B\n").unwrap();
            fs::rename(replacement, repo.path.join("a.txt")).unwrap();
        };
        let result = discard_verified_entry_inner(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
            Some(&head),
            None,
            Some(&hook),
        )
        .await
        .unwrap();
        assert!(!result.external_change_preserved);
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"base\n");
        assert_eq!(repo.git(&["status", "--porcelain"]), b"");
    }

    #[tokio::test]
    async fn discard_removes_external_replacement_for_untracked_target_after_claim() {
        let repo = TestRepo::new("discard-untracked-overwrite-race");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("new.txt", b"A\n");
        let expected = repo.authority("new.txt").await;
        let head = repo.head();
        let hook = || {
            let replacement = repo.path.join("replacement.tmp");
            fs::write(&replacement, b"B\n").unwrap();
            fs::rename(replacement, repo.path.join("new.txt")).unwrap();
        };
        let result = discard_verified_entry_inner(
            repo.path.to_str().unwrap(),
            "new.txt",
            None,
            &expected,
            Some(&head),
            None,
            Some(&hook),
        )
        .await
        .unwrap();
        assert!(!result.external_change_preserved);
        assert!(fs::metadata(repo.path.join("new.txt")).is_err());
        assert_eq!(repo.git(&["status", "--porcelain"]), b"");
    }

    #[tokio::test]
    async fn discard_worktree_only_preserves_index_for_mixed_file() {
        let repo = TestRepo::new("discard-worktree-mixed");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"staged\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.write("a.txt", b"worktree\n");
        let expected = repo.authority("a.txt").await;
        discard_worktree_verified_entry(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
        )
        .await
        .unwrap();
        assert_eq!(repo.git(&["show", ":a.txt"]), b"staged\n");
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"staged\n");
    }

    #[tokio::test]
    async fn discard_worktree_only_restores_unstaged_tracked_file() {
        let repo = TestRepo::new("discard-worktree-unstaged");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"changed\n");
        let expected = repo.authority("a.txt").await;
        discard_worktree_verified_entry(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
        )
        .await
        .unwrap();
        assert_eq!(repo.git(&["show", ":a.txt"]), b"base\n");
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"base\n");
    }

    #[tokio::test]
    async fn discard_worktree_only_deletes_untracked_file() {
        let repo = TestRepo::new("discard-worktree-untracked");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("new.txt", b"new\n");
        let expected = repo.authority("new.txt").await;
        discard_worktree_verified_entry(
            repo.path.to_str().unwrap(),
            "new.txt",
            None,
            &expected,
        )
        .await
        .unwrap();
        assert_eq!(fs::metadata(repo.path.join("new.txt")).is_err(), true);
        assert_eq!(repo.git(&["ls-files", "--", "new.txt"]), b"");
    }

    #[tokio::test]
    async fn discard_worktree_only_rejects_external_index_replacement_after_verification() {
        let repo = TestRepo::new("discard-worktree-index-race");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"staged\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.write("a.txt", b"worktree\n");
        let expected = repo.authority("a.txt").await;
        let hook = || {
            // External process stages the newer worktree content after capture.
            repo.write("a.txt", b"worktree\n");
            repo.git(&["add", "--", "a.txt"]);
        };
        let error = discard_worktree_verified_entry_inner(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
            Some(&hook),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.contains("外部 index 已变化"));
        assert_eq!(repo.git(&["show", ":a.txt"]), b"worktree\n");
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"worktree\n");
    }

    #[tokio::test]
    async fn discard_worktree_only_index_lock_blocks_external_writer_between_verify_and_materialize() {
        let repo = TestRepo::new("discard-worktree-lock-window");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"staged\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.write("a.txt", b"worktree\n");
        let expected = repo.authority("a.txt").await;
        let hook = || {
            // This runs after the captured-index comparison passed and while the
            // Git index write lock is held: an external index writer must fail.
            let output = StdCommand::new("git")
                .current_dir(&repo.path)
                .args(["add", "--", "a.txt"])
                .output()
                .unwrap();
            assert!(
                !output.status.success(),
                "external git add must fail while the index lock is held: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        discard_worktree_verified_entry_inner(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
            None,
            Some(&hook),
        )
        .await
        .unwrap();
        assert_eq!(repo.git(&["show", ":a.txt"]), b"staged\n");
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"staged\n");
        assert_eq!(fs::metadata(repo.path.join(".git/index.lock")).is_err(), true);
    }

    #[tokio::test]
    async fn discard_worktree_only_aborts_and_restores_when_index_lock_is_unavailable() {
        let repo = TestRepo::new("discard-worktree-lock-busy");
        repo.write("a.txt", b"base\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("a.txt", b"staged\n");
        repo.git(&["add", "--", "a.txt"]);
        repo.write("a.txt", b"worktree\n");
        fs::write(repo.path.join(".git/index.lock"), b"").unwrap();
        let expected = repo.authority("a.txt").await;
        let error = discard_worktree_verified_entry(
            repo.path.to_str().unwrap(),
            "a.txt",
            None,
            &expected,
        )
        .await
        .unwrap_err();
        assert!(error.contains("index 写锁"));
        assert_eq!(repo.git(&["show", ":a.txt"]), b"staged\n");
        assert_eq!(fs::read(repo.path.join("a.txt")).unwrap(), b"worktree\n");
    }
}
