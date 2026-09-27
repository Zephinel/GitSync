mod git_tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command as StdCommand;

    struct TestRepo {
        path: PathBuf,
    }

    impl TestRepo {
        fn new(label: &str) -> Self {
            let path = stash_test_repo_path("gitsync-stash", label);
            fs::create_dir(&path).expect("create test repository");
            git(&path, &["init", "--quiet"]);
            git(&path, &["config", "user.name", "GitSync Test"]);
            git(
                &path,
                &["config", "user.email", "gitsync-test@example.invalid"],
            );
            fs::write(path.join("tracked.txt"), "base\n").expect("write base file");
            git(&path, &["add", "--", "tracked.txt"]);
            git(&path, &["commit", "--quiet", "-m", "initial"]);
            Self { path }
        }
    }

    impl Drop for TestRepo {
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
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn stash_entries(path: &Path) -> Vec<RepoStashEntry> {
        let raw = git(
            path,
            &[
                "stash",
                "list",
                "--format=%gd%x00%H%x00%cI%x00%gs%x00%P",
            ],
        );
        parse_stash_list(&raw)
    }

    #[test]
    fn default_create_excludes_untracked_and_keep_index_preserves_staging() {
        let repo = TestRepo::new("scope");
        fs::write(repo.path.join("tracked.txt"), "staged\n").expect("modify tracked");
        fs::write(repo.path.join("new.txt"), "untracked\n").expect("write untracked");
        git(&repo.path, &["add", "--", "tracked.txt"]);

        git(
            &repo.path,
            &["stash", "push", "--keep-index", "--message", "scope"],
        );

        assert!(repo.path.join("new.txt").exists());
        assert!(!git(&repo.path, &["diff", "--cached", "--name-only"]).is_empty());
        let entries = stash_entries(&repo.path);
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].includes_untracked);
    }

    #[test]
    fn include_untracked_removes_it_from_worktree_and_records_third_parent() {
        let repo = TestRepo::new("untracked");
        fs::write(repo.path.join("tracked.txt"), "changed\n").expect("modify tracked");
        fs::write(repo.path.join("new.txt"), "untracked\n").expect("write untracked");

        git(
            &repo.path,
            &[
                "stash",
                "push",
                "--include-untracked",
                "--message",
                "with-untracked",
            ],
        );

        assert!(!repo.path.join("new.txt").exists());
        let entries = stash_entries(&repo.path);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].includes_untracked);
    }

    #[test]
    fn apply_by_oid_retains_entry_and_two_stage_pop_drops_same_oid() {
        let repo = TestRepo::new("apply-pop");
        fs::write(repo.path.join("tracked.txt"), "stashed\n").expect("modify tracked");
        git(&repo.path, &["stash", "push", "--message", "apply-pop"]);

        let before = stash_entries(&repo.path);
        assert_eq!(before.len(), 1);
        let target = before[0].clone();

        git(
            &repo.path,
            &["stash", "apply", "--quiet", target.oid.as_str()],
        );
        assert_eq!(fs::read_to_string(repo.path.join("tracked.txt")).unwrap(), "stashed\n");
        assert!(stash_entries(&repo.path).iter().any(|entry| entry.id == target.id));

        git(&repo.path, &["reset", "--hard", "--quiet", "HEAD"]);
        git(
            &repo.path,
            &["stash", "apply", "--quiet", target.oid.as_str()],
        );
        let current = stash_entries(&repo.path);
        let selector = current
            .iter()
            .find(|entry| entry.id == target.id)
            .expect("same stable OID remains")
            .selector
            .clone();
        git(
            &repo.path,
            &["stash", "drop", "--quiet", selector.as_str()],
        );

        assert!(!stash_entries(&repo.path).iter().any(|entry| entry.id == target.id));
    }

    #[tokio::test]
    async fn linked_worktrees_share_the_same_stash_operation_authority_identity() {
        let repo = TestRepo::new("linked-authority");
        let linked_path = stash_test_repo_path("gitsync-stash-linked-worktree", "linked");
        let primary_string = repo.path.to_string_lossy().to_string();
        let linked_string = linked_path.to_string_lossy().to_string();
        git(&repo.path, &["branch", "linked-authority"]);
        git(
            &repo.path,
            &[
                "worktree",
                "add",
                "--quiet",
                linked_string.as_str(),
                "linked-authority",
            ],
        );

        let (primary_key, primary_lock_path) = stash_operation_authority_identity(&primary_string)
            .await
            .expect("primary common-dir authority identity");
        let (linked_key, linked_lock_path) = stash_operation_authority_identity(&linked_string)
            .await
            .expect("linked common-dir authority identity");

        assert_eq!(primary_key, linked_key);
        assert_eq!(primary_lock_path, linked_lock_path);

        git(
            &repo.path,
            &["worktree", "remove", "--force", linked_string.as_str()],
        );
        let _ = fs::remove_dir_all(linked_path);
    }

    #[tokio::test]
    async fn stash_operation_authority_holds_an_os_lock_on_the_common_dir() {
        let repo = TestRepo::new("cross-process-authority");
        let repo_string = repo.path.to_string_lossy().to_string();
        let (_, lock_path) = stash_operation_authority_identity(&repo_string)
            .await
            .expect("common-dir authority identity");
        let guard = acquire_stash_operation_authority(&repo_string)
            .await
            .expect("acquire Stash operation authority");
        let contender = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("open independent lock handle");

        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));

        drop(guard);
        contender
            .try_lock()
            .expect("OS lock must release with authority guard");
    }

    #[tokio::test]
    async fn different_repositories_have_independent_stash_authority_locks() {
        let (repo_a, repo_b) = tokio::join!(
            tokio::task::spawn_blocking(|| TestRepo::new("parallel-authority")),
            tokio::task::spawn_blocking(|| TestRepo::new("parallel-authority")),
        );
        let repo_a = repo_a.expect("create first repository");
        let repo_b = repo_b.expect("create second repository");
        let repo_a_path = repo_a.path.to_string_lossy().to_string();
        let repo_b_path = repo_b.path.to_string_lossy().to_string();

        let (identity_a, identity_b) = tokio::join!(
            stash_operation_authority_identity(&repo_a_path),
            stash_operation_authority_identity(&repo_b_path),
        );
        let (key_a, lock_a) = identity_a.expect("first repository authority identity");
        let (key_b, lock_b) = identity_b.expect("second repository authority identity");
        assert_ne!(key_a, key_b);
        assert_ne!(lock_a, lock_b);

        let _guard_a = acquire_stash_operation_authority(&repo_a_path)
            .await
            .expect("acquire first repository authority");
        let _guard_b = tokio::time::timeout(
            Duration::from_secs(1),
            acquire_stash_operation_authority(&repo_b_path),
        )
        .await
        .expect("first repository guard must not block a different repository")
        .expect("acquire second repository authority");
    }
}
