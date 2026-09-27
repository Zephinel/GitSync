#[cfg(test)]
mod tests {
    use super::{
        acquire_remote_refresh_guard, build_result, create_local_branch_atomically,
        execute_pending_steps, inspect_locked, inspect_repo_branch_creation_in_state, journal_path,
        new_journal, parse_remote_ref, persist_journal, push_created_new_branch,
        reconcile_local_creation, stable_fingerprint, validate_branch_name_shape,
        validate_name_locked, BranchCreationOperationSignature, BranchCreationSourceRequest,
        BranchNameValidationRequest, GitCommandOutput,
    };
    use crate::commands::AppState;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command as StdCommand;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "gitsync-branch-create-{}-{}-{}",
                label,
                std::process::id(),
                nonce
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self { path }
        }
    }

    impl Drop for TestDirectory {
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

    fn init_repository(label: &str) -> TestDirectory {
        let directory = TestDirectory::new(label);
        git(&directory.path, &["init", "--quiet"]);
        git(&directory.path, &["config", "user.name", "GitSync Test"]);
        git(
            &directory.path,
            &["config", "user.email", "gitsync-test@example.invalid"],
        );
        fs::write(directory.path.join("tracked.txt"), "base\n").expect("write fixture");
        git(&directory.path, &["add", "--", "tracked.txt"]);
        git(&directory.path, &["commit", "--quiet", "-m", "initial"]);
        directory
    }

    fn local_signature(
        source_branch: &str,
        source_commit: &str,
        branch_name: &str,
        publish: bool,
        target_remote: Option<&str>,
    ) -> BranchCreationOperationSignature {
        BranchCreationOperationSignature {
            source: BranchCreationSourceRequest {
                kind: "local".to_string(),
                name: source_branch.to_string(),
                display_name: Some(source_branch.to_string()),
            },
            source_option_id: "local".to_string(),
            source_ref: format!("refs/heads/{}", source_branch),
            source_commit: source_commit.to_string(),
            branch_name: branch_name.to_string(),
            switch_after_create: false,
            publish,
            target_remote: target_remote.map(str::to_string),
        }
    }

    #[test]
    fn parses_the_longest_remote_prefix() {
        let remotes = vec!["up".to_string(), "up/stream".to_string()];
        let parsed = parse_remote_ref("up/stream/feature/name", &remotes).unwrap();
        assert_eq!(parsed.0, "up/stream");
        assert_eq!(parsed.1, "feature/name");
    }

    #[test]
    fn rejects_empty_head_and_oversized_names() {
        assert!(!validate_branch_name_shape("").is_empty());
        assert!(!validate_branch_name_shape("HEAD").is_empty());
        assert!(!validate_branch_name_shape(&"a".repeat(241)).is_empty());
    }

    #[test]
    fn fingerprint_changes_when_source_state_changes() {
        assert_ne!(
            stable_fingerprint(&["refs/heads/main", "a"]),
            stable_fingerprint(&["refs/heads/main", "b"])
        );
    }

    #[test]
    fn only_porcelain_new_branch_is_confirmed_as_created() {
        let created = GitCommandOutput {
            success: true,
            code: Some(0),
            stdout: "To example\n*\trefs/heads/feature:refs/heads/feature\t[new branch]".into(),
            stderr: String::new(),
        };
        let existing = GitCommandOutput {
            success: true,
            code: Some(0),
            stdout: "=\trefs/heads/feature:refs/heads/feature\t[up to date]".into(),
            stderr: String::new(),
        };
        assert!(push_created_new_branch(&created));
        assert!(!push_created_new_branch(&existing));
    }

    #[tokio::test]
    async fn local_only_source_does_not_contact_an_unrelated_remote() {
        let repository = init_repository("local-only");
        let unreachable = repository.path.join("missing-remote.git");
        git(
            &repository.path,
            &["remote", "add", "broken", unreachable.to_string_lossy().as_ref()],
        );
        let branch = git(&repository.path, &["branch", "--show-current"]);
        let repo_path = repository.path.to_string_lossy().to_string();
        let inspection = inspect_locked(
            &repo_path,
            &BranchCreationSourceRequest {
                kind: "local".to_string(),
                name: branch.clone(),
                display_name: Some(branch),
            },
        )
        .await
        .expect("local-only inspection must not fetch an unrelated remote");
        assert_eq!(inspection.relationship, "local-only");
        assert_eq!(inspection.source_options.len(), 1);
        assert_eq!(inspection.default_source_option_id.as_deref(), Some("local"));
    }

    #[tokio::test]
    async fn disappeared_remote_configuration_is_reported_as_upstream_gone() {
        let repository = init_repository("missing-upstream");
        let branch = git(&repository.path, &["branch", "--show-current"]);
        let repo_path = repository.path.to_string_lossy().to_string();
        let remote_key = format!("branch.{}.remote", branch);
        let merge_key = format!("branch.{}.merge", branch);
        let merge_ref = format!("refs/heads/{}", branch);
        git(&repository.path, &["config", remote_key.as_str(), "missing"]);
        git(
            &repository.path,
            &["config", merge_key.as_str(), merge_ref.as_str()],
        );
        let inspection = inspect_locked(
            &repo_path,
            &BranchCreationSourceRequest {
                kind: "local".to_string(),
                name: branch.clone(),
                display_name: Some(branch),
            },
        )
        .await
        .expect("missing remote config should still allow a local source");
        assert_eq!(inspection.relationship, "upstream-gone");
        assert_eq!(inspection.default_source_option_id.as_deref(), Some("local"));
        assert!(inspection
            .warnings
            .iter()
            .any(|warning| warning.contains("无法对应当前远端配置")));
    }

    #[tokio::test]
    async fn remote_refresh_inspection_is_rejected_after_restart_admission() {
        let repository = TestDirectory::new("restart-before-remote-inspection");
        let repo_path = repository.path.to_string_lossy().to_string();
        let state = AppState::new();
        let restart = state.app_restart_guard.try_acquire_restart();
        assert!(restart.acquired);

        let error = match inspect_repo_branch_creation_in_state(
            &repo_path,
            &BranchCreationSourceRequest {
                kind: "remote".to_string(),
                name: "origin/main".to_string(),
                display_name: None,
            },
            &state,
        )
        .await
        {
            Ok(_) => panic!("remote refresh must be rejected while restart is admitted"),
            Err(error) => error,
        };
        assert!(error.contains("暂不能开始新的 Git 操作"));
        assert!(!repository.path.join(".git/FETCH_HEAD").exists());
        assert!(state
            .app_restart_guard
            .release_restart(restart.token.unwrap()));
    }

    #[tokio::test]
    async fn active_remote_refresh_inspection_blocks_restart_admission() {
        let state = AppState::new();
        let operation = acquire_remote_refresh_guard(&state, "/tmp/gitsync-branch-create-fetch")
            .await
            .expect("remote inspection acquires mutation operation lease");

        let restart = state.app_restart_guard.try_acquire_restart();
        assert!(!restart.acquired);
        assert!(restart
            .blockers
            .iter()
            .any(|blocker| blocker.contains("gitsync-branch-create-fetch")));
        drop(operation);
    }

    include!("commands_tests_remote.rs");
}
