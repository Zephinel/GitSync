mod selected_scope_git_tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command as StdCommand;

    struct ScopeRepo {
        path: PathBuf,
    }

    impl ScopeRepo {
        fn new(label: &str) -> Self {
            let path = stash_test_repo_path("gitsync-selected-scope", label);
            fs::create_dir(&path).expect("create selected scope repository");
            git(&path, &["init", "--quiet"]);
            git(&path, &["config", "user.name", "GitSync Test"]);
            git(
                &path,
                &["config", "user.email", "gitsync-test@example.invalid"],
            );
            fs::write(path.join("same.txt"), "base\n").unwrap();
            git(&path, &["add", "--", "same.txt"]);
            git(&path, &["commit", "--quiet", "-m", "initial"]);
            Self { path }
        }
    }

    impl Drop for ScopeRepo {
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
    async fn preserves_posix_path_identity_during_selected_scope_resolution() {
        let repo = ScopeRepo::new("path-identity");
        fs::create_dir_all(repo.path.join("a")).unwrap();
        fs::write(repo.path.join("a\\b.txt"), "backslash base\n").unwrap();
        fs::write(repo.path.join("a/b.txt"), "slash base\n").unwrap();
        fs::write(repo.path.join(" file.txt"), "leading base\n").unwrap();
        fs::write(repo.path.join("file.txt"), "normal base\n").unwrap();
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
        git(&repo.path, &["commit", "--quiet", "-m", "path identities"]);

        fs::write(repo.path.join("a\\b.txt"), "backslash changed\n").unwrap();
        fs::write(repo.path.join("a/b.txt"), "slash changed\n").unwrap();
        fs::write(repo.path.join(" file.txt"), "leading changed\n").unwrap();
        fs::write(repo.path.join("file.txt"), "normal changed\n").unwrap();

        assert_eq!(normalize_stash_scope_path("a\\b.txt").unwrap(), "a\\b.txt");
        assert_eq!(normalize_stash_scope_path(" file.txt").unwrap(), " file.txt");
        assert_ne!(
            normalize_stash_scope_path("a\\b.txt").unwrap(),
            normalize_stash_scope_path("a/b.txt").unwrap()
        );
        assert_ne!(
            normalize_stash_scope_path(" file.txt").unwrap(),
            normalize_stash_scope_path("file.txt").unwrap()
        );

        let targets = normalize_stash_scope_targets(&[
            StashPathTarget {
                path: "a\\b.txt".to_string(),
                old_path: None,
            },
            StashPathTarget {
                path: " file.txt".to_string(),
                old_path: None,
            },
        ])
        .unwrap();
        let root = repo.path.to_string_lossy().to_string();
        let candidates = read_stash_worktree_files_for_targets(&root, &targets)
            .await
            .unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().any(|file| file.path == "a\\b.txt"));
        assert!(candidates.iter().any(|file| file.path == " file.txt"));
        assert!(!candidates.iter().any(|file| file.path == "a/b.txt"));
        assert!(!candidates.iter().any(|file| file.path == "file.txt"));

        let selected = resolve_selected_scope(&candidates, &targets, true, false).unwrap();
        validate_selected_scope_git_identity(&root, &selected)
            .await
            .unwrap();
        assert_eq!(selected.len(), 2);
    }

    #[tokio::test]
    async fn rejects_staged_deletion_with_same_path_untracked_replacement() {
        let repo = ScopeRepo::new("replacement");
        git(&repo.path, &["rm", "--cached", "--quiet", "same.txt"]);
        let root = repo.path.to_string_lossy().to_string();
        let files = read_stash_worktree_files(&root).await.unwrap();
        let same = files
            .iter()
            .filter(|file| file.path == "same.txt")
            .collect::<Vec<_>>();
        assert_eq!(same.len(), 2);
        assert!(same.iter().any(|file| file.is_untracked));
        assert!(same.iter().any(|file| file.has_staged_changes));

        let error = resolve_selected_scope(
            &files,
            &[StashPathTarget {
                path: "same.txt".to_string(),
                old_path: None,
            }],
            true,
            false,
        )
        .unwrap_err();
        assert!(error.contains("多种 Git 身份"));
    }

    #[tokio::test]
    async fn rejects_staged_deletion_before_git_stash_pathspec_failure() {
        let repo = ScopeRepo::new("staged-delete");
        git(&repo.path, &["rm", "--quiet", "same.txt"]);
        let root = repo.path.to_string_lossy().to_string();
        let files = read_stash_worktree_files(&root).await.unwrap();
        let selected = resolve_selected_scope(
            &files,
            &[StashPathTarget {
                path: "same.txt".to_string(),
                old_path: None,
            }],
            true,
            false,
        )
        .unwrap();

        let error = validate_selected_scope_git_identity(&root, &selected)
            .await
            .unwrap_err();
        assert!(error.contains("已在暂存区标记为删除"));
        assert!(error.contains("Stash 全部改动"));
    }

    #[tokio::test]
    async fn rejects_staged_rename_that_cannot_be_stashed_as_one_path_scope() {
        let repo = ScopeRepo::new("staged-rename");
        git(&repo.path, &["mv", "same.txt", "renamed.txt"]);
        let root = repo.path.to_string_lossy().to_string();
        let files = read_stash_worktree_files(&root).await.unwrap();
        let renamed = files
            .iter()
            .find(|file| file.path == "renamed.txt")
            .unwrap();
        let selected = resolve_selected_scope(
            &files,
            &[StashPathTarget {
                path: renamed.path.clone(),
                old_path: renamed.old_path.clone(),
            }],
            true,
            false,
        )
        .unwrap();

        let error = validate_selected_scope_git_identity(&root, &selected)
            .await
            .unwrap_err();
        assert!(error.contains("已在暂存区标记为重命名"));
        assert!(error.contains("Stash 全部改动"));
    }

    #[tokio::test]
    async fn unselected_digest_ignores_selected_changes_and_detects_other_worktree_changes() {
        let repo = ScopeRepo::new("digest");
        fs::write(repo.path.join("selected.txt"), "base selected\n").unwrap();
        fs::write(repo.path.join("other.txt"), "base other\n").unwrap();
        git(&repo.path, &["add", "--", "selected.txt", "other.txt"]);
        git(&repo.path, &["commit", "--quiet", "-m", "scope baseline"]);

        fs::write(repo.path.join("selected.txt"), "selected v1\n").unwrap();
        fs::write(repo.path.join("other.txt"), "other v1\n").unwrap();
        let root = repo.path.to_string_lossy().to_string();
        let targets = vec![StashPathTarget {
            path: "selected.txt".to_string(),
            old_path: None,
        }];
        let candidates = read_stash_worktree_files_for_targets(&root, &targets)
            .await
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, "selected.txt");
        let selected = resolve_selected_scope(&candidates, &targets, true, false).unwrap();

        let before = hash_unselected_stash_worktree_status(&root, &selected)
            .await
            .unwrap();
        assert!(matches!(before.len(), 40 | 64));
        assert!(before.chars().all(|character| character.is_ascii_hexdigit()));

        fs::write(repo.path.join("selected.txt"), "selected v2\n").unwrap();
        let after_selected_only = hash_unselected_stash_worktree_status(&root, &selected)
            .await
            .unwrap();
        assert_eq!(before, after_selected_only);

        fs::write(repo.path.join("other.txt"), "other v2\n").unwrap();
        git(&repo.path, &["add", "--", "other.txt"]);
        let after_other = hash_unselected_stash_worktree_status(&root, &selected)
            .await
            .unwrap();
        assert_ne!(before, after_other);
    }

    #[test]
    fn selected_journal_loader_binds_selected_files_to_request_targets() {
        let selected_file = StashWorktreeFile {
            path: "selected.txt".to_string(),
            old_path: None,
            code: " M".to_string(),
            is_untracked: false,
            is_conflicted: false,
            has_staged_changes: false,
            has_unstaged_changes: true,
        };
        let journal = SelectedStashOperationJournal {
            version: SELECTED_STASH_JOURNAL_VERSION,
            request_id: "request_9".to_string(),
            origin_repo_root: "/repo".to_string(),
            completion_validated: false,
            expected_snapshot_id: "snapshot".to_string(),
            message: String::new(),
            include_untracked: true,
            keep_index: false,
            targets: vec![StashPathTarget {
                path: "selected.txt".to_string(),
                old_path: None,
            }],
            selected_files: vec![selected_file.clone()],
            before_snapshot_id: "snapshot".to_string(),
            before_worktree_id: "worktree".to_string(),
            before_stash_ids: Vec::new(),
            before_unselected_status_oid: "a".repeat(40),
            before_files: Vec::new(),
            phase: "prepared".to_string(),
            created_at_ms: 1,
            updated_at_ms: 1,
            command_success: None,
            command_error: None,
            result: None,
        };
        assert!(validate_selected_stash_journal(Path::new("request_9.json"), &journal).is_ok());

        let mut drifted = journal.clone();
        drifted.selected_files[0].path = "other.txt".to_string();
        assert!(validate_selected_stash_journal(Path::new("request_9.json"), &drifted).is_err());

        let mut duplicated = journal;
        duplicated.selected_files.push(selected_file);
        assert!(validate_selected_stash_journal(Path::new("request_9.json"), &duplicated).is_err());
    }
}
