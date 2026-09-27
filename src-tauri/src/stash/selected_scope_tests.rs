mod selected_scope_tests {
    use super::*;

    fn file(
        path: &str,
        old_path: Option<&str>,
        untracked: bool,
        staged: bool,
        unstaged: bool,
    ) -> StashWorktreeFile {
        StashWorktreeFile {
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
            code: if untracked { "??" } else { " M" }.to_string(),
            is_untracked: untracked,
            is_conflicted: false,
            has_staged_changes: staged,
            has_unstaged_changes: unstaged,
        }
    }

    fn target(path: String, old_path: Option<String>) -> StashPathTarget {
        StashPathTarget { path, old_path }
    }

    #[test]
    fn normalizes_literal_repository_relative_targets() {
        let targets = normalize_stash_scope_targets(&[
            StashPathTarget {
                path: "src/new.rs".to_string(),
                old_path: Some("src/old.rs".to_string()),
            },
            StashPathTarget {
                path: "notes.txt".to_string(),
                old_path: None,
            },
        ])
        .unwrap();

        assert_eq!(targets.len(), 2);
        assert_eq!(targets[1].old_path.as_deref(), Some("src/old.rs"));
        assert!(normalize_stash_scope_path("../outside").is_err());
        assert!(normalize_stash_scope_path("/absolute").is_err());
        assert!(normalize_stash_scope_path(".").is_err());
    }

    #[test]
    fn selected_untracked_file_is_authorized_by_selection_itself() {
        let files = vec![file("new.txt", None, true, false, true)];
        let targets = vec![StashPathTarget {
            path: "new.txt".to_string(),
            old_path: None,
        }];

        assert!(resolve_selected_scope(&files, &targets, false, false).is_ok());
        assert!(resolve_selected_scope(&files, &targets, true, false).is_ok());
    }

    #[test]
    fn rejects_ambiguous_replacement_identity_and_stale_rename() {
        let files = vec![
            file("same.txt", None, false, true, false),
            file("same.txt", None, true, false, true),
            file("src/new.rs", Some("src/old.rs"), false, true, true),
        ];
        let ambiguous = vec![StashPathTarget {
            path: "same.txt".to_string(),
            old_path: None,
        }];
        assert!(resolve_selected_scope(&files, &ambiguous, false, false)
            .unwrap_err()
            .contains("多种 Git 身份"));

        let stale_rename = vec![StashPathTarget {
            path: "src/new.rs".to_string(),
            old_path: Some("wrong.rs".to_string()),
        }];
        assert!(resolve_selected_scope(&files, &stale_rename, false, false).is_err());
    }

    #[test]
    fn builds_literal_pathspecs_for_both_rename_paths() {
        let selected = vec![file(
            "src/new[1].rs",
            Some("src/old*.rs"),
            false,
            true,
            true,
        )];
        assert_eq!(
            selected_scope_pathspecs(&selected),
            vec![
                ":(literal)src/new[1].rs".to_string(),
                ":(literal)src/old*.rs".to_string(),
            ]
        );
        assert_eq!(
            top_literal_pathspec("src/new[1].rs"),
            ":(top,literal)src/new[1].rs"
        );
        assert_eq!(
            top_literal_exclude_pathspec("src/new[1].rs"),
            ":(top,literal,exclude)src/new[1].rs"
        );
    }

    #[test]
    fn new_selected_requests_have_a_bounded_target_and_command_budget() {
        let within_count = (0..STASH_SELECTED_TARGET_MAX_FILES)
            .map(|index| target(format!("f{:03}.txt", index), None))
            .collect::<Vec<_>>();
        assert!(ensure_selected_scope_request_budget(&within_count).is_ok());

        let over_count = (0..=STASH_SELECTED_TARGET_MAX_FILES)
            .map(|index| target(format!("f{:03}.txt", index), None))
            .collect::<Vec<_>>();
        assert!(ensure_selected_scope_request_budget(&over_count).is_err());

        let oversized = vec![target(
            "x".repeat(STASH_SELECTED_PATHSPEC_BUDGET_UTF16),
            None,
        )];
        assert!(ensure_selected_scope_request_budget(&oversized).is_err());
    }

    #[test]
    fn selected_pathspec_budget_deduplicates_the_same_literal_identity() {
        let single = vec![target("same.txt".to_string(), None)];
        let same_old_path = vec![target(
            "same.txt".to_string(),
            Some("same.txt".to_string()),
        )];
        assert_eq!(
            selected_pathspec_command_utf16_units(&single),
            selected_pathspec_command_utf16_units(&same_old_path)
        );
    }

    #[test]
    fn verifies_selected_files_and_preserves_every_unselected_file() {
        let selected = file("a.txt", None, false, false, true);
        let untouched = file("b.txt", None, false, false, true);
        let before = vec![selected.clone(), untouched.clone()];
        let after = vec![untouched.clone()];
        assert!(verify_selected_scope_after_create(
            &before,
            &after,
            &[selected.clone()],
            false,
        ));

        let changed_unselected = vec![file("b.txt", None, false, true, true)];
        assert!(!verify_selected_scope_after_create(
            &before,
            &changed_unselected,
            &[selected],
            false,
        ));
    }

    #[test]
    fn digest_verification_requires_both_unselected_identity_and_selected_residual() {
        let selected = file("a.txt", None, false, false, true);
        assert!(verify_selected_scope_digest_after_create(
            "aabb",
            "aabb",
            &[],
            &[selected.clone()],
            false,
        ));
        assert!(!verify_selected_scope_digest_after_create(
            "aabb",
            "ccdd",
            &[],
            &[selected.clone()],
            false,
        ));
        assert!(!verify_selected_scope_digest_after_create(
            "aabb",
            "aabb",
            &[selected.clone()],
            &[selected],
            false,
        ));
    }

    #[test]
    fn keep_index_requires_and_preserves_selected_staged_content() {
        let staged_only = file("staged.txt", None, false, true, false);
        let target = vec![StashPathTarget {
            path: "staged.txt".to_string(),
            old_path: None,
        }];
        assert!(resolve_selected_scope(
            &[staged_only.clone()],
            &target,
            false,
            true,
        )
        .is_err());

        let mixed = file("mixed.txt", None, false, true, true);
        let after = file("mixed.txt", None, false, true, false);
        assert!(verify_selected_scope_after_create(
            &[mixed.clone()],
            &[after.clone()],
            &[mixed.clone()],
            true,
        ));
        assert!(verify_selected_scope_digest_after_create(
            "same",
            "same",
            &[after],
            &[mixed],
            true,
        ));
    }
}
