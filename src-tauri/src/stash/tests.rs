mod tests {
    use super::*;

    fn entry(oid: &str, selector: &str) -> RepoStashEntry {
        RepoStashEntry {
            id: oid.to_string(),
            oid: oid.to_string(),
            selector: selector.to_string(),
            ordinal: parse_stash_ordinal(selector),
            message: "message".to_string(),
            subject: "On main: message".to_string(),
            branch_context: Some("main".to_string()),
            created_at: "2026-08-02T00:00:00Z".to_string(),
            base_commit: Some("a".repeat(40)),
            base_summary: Some("base".to_string()),
            includes_untracked: false,
            scope_summary: "已跟踪修改（含暂存区快照）".to_string(),
        }
    }

    fn snapshot(
        snapshot_id: &str,
        worktree_id: &str,
        stashes: Vec<RepoStashEntry>,
        conflicts: Vec<&str>,
    ) -> RepoStashSnapshot {
        let all_stashes = stashes.clone();
        RepoStashSnapshot {
            repo_path: "/repo".to_string(),
            branch: Some("main".to_string()),
            detached_head: false,
            head_hash: Some("b".repeat(40)),
            snapshot_id: snapshot_id.to_string(),
            worktree_id: worktree_id.to_string(),
            staged_files: 0,
            unstaged_files: 0,
            mixed_files: 0,
            untracked_files: 0,
            conflicted_files: conflicts.len(),
            conflict_paths: conflicts.into_iter().map(str::to_string).collect(),
            has_tracked_changes: false,
            has_untracked_changes: false,
            can_create_default: false,
            can_create_with_untracked: false,
            stash_total: stashes.len(),
            stashes_truncated: false,
            stashes,
            all_stashes,
            pending_operation_total: 0,
            pending_operations_truncated: false,
            pending_operations: Vec::new(),
        }
    }

    fn journal(operation: &str, target: Option<&str>, before: &RepoStashSnapshot) -> StashOperationJournal {
        new_stash_journal(
            "request_1".to_string(),
            StashOperationSignature {
                operation: operation.to_string(),
                expected_snapshot_id: before.snapshot_id.clone(),
                target_stash_id: target.map(str::to_string),
                message: String::new(),
                include_untracked: false,
                keep_index: false,
            },
            before,
        )
    }

    #[test]
    fn parses_worktree_scope_without_treating_untracked_as_default_stash_content() {
        let status = parse_worktree_status(
            "M  staged.rs\0 M unstaged.rs\0MM mixed.rs\0?? new.txt\0UU conflict.rs\0",
        );

        assert_eq!(status.staged_files, 3);
        assert_eq!(status.unstaged_files, 3);
        assert_eq!(status.mixed_files, 2);
        assert_eq!(status.untracked_files, 1);
        assert_eq!(status.conflicted_files, 1);
        assert_eq!(status.conflict_paths, vec!["conflict.rs"]);
        assert!(status.has_tracked_changes);
    }

    #[test]
    fn streamed_worktree_inventory_preserves_rename_identity_without_forcing_snapshot_inventory() {
        let raw = "M  staged.rs\0R  new.rs\0old.rs\0?? note.txt\0";
        let mut summary_only = WorktreeStatusStreamParser::new(false);
        let mut inventory = WorktreeStatusStreamParser::new(true);
        for field in raw.split_terminator('\0') {
            summary_only.push_field(field.to_string()).unwrap();
            inventory.push_field(field.to_string()).unwrap();
        }
        let (summary, no_files) = summary_only.finish().unwrap();
        let (inventory_summary, files) = inventory.finish().unwrap();

        assert!(no_files.is_empty());
        assert_eq!(summary.staged_files, inventory_summary.staged_files);
        assert_eq!(summary.untracked_files, inventory_summary.untracked_files);
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].path, "new.rs");
        assert_eq!(files[1].old_path.as_deref(), Some("old.rs"));
        assert!(files[2].is_untracked);
    }

    #[test]
    fn streamed_status_hash_matches_the_existing_v1_snapshot_identity_contract() {
        let repo_root = "/repo";
        let branch = "main";
        let head = "0123456789abcdef0123456789abcdef01234567";
        let status = "M  tracked.rs\0?? note.txt\0R  new.rs\0old.rs\0";
        let stash_raw = "stash@{0}\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\02026-08-07T00:00:00Z\0On main: save\0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
        let leading = [repo_root, branch, head];

        let mut worktree_hasher = stable_hash_stream_seed("stash-worktree-v1", &leading);
        let mut snapshot_hasher = stable_hash_stream_seed("stash-snapshot-v1", &leading);
        for field in status.split_terminator('\0') {
            stable_hash_stream_nul_field(&mut worktree_hasher, field);
            stable_hash_stream_nul_field(&mut snapshot_hasher, field);
        }
        stable_hash_stream_finish_str_part(&mut worktree_hasher);
        stable_hash_stream_finish_str_part(&mut snapshot_hasher);

        assert_eq!(
            stable_hash_stream_finish("stash-worktree-v1", &worktree_hasher),
            stable_hash("stash-worktree-v1", &[repo_root, branch, head, status])
        );
        stable_hash_stream_push_str_part(&mut snapshot_hasher, stash_raw);
        assert_eq!(
            stable_hash_stream_finish("stash-snapshot-v1", &snapshot_hasher),
            stable_hash(
                "stash-snapshot-v1",
                &[repo_root, branch, head, status, stash_raw],
            )
        );
    }

    #[test]
    fn stash_list_uses_oid_identity_and_treats_selector_as_current_display_position() {
        let first = "1".repeat(40);
        let second = "2".repeat(40);
        let raw = format!(
            "stash@{{0}}\0{}\02026-08-02T00:00:00Z\0On main: save work\0{} {} {}\n\
             stash@{{1}}\0{}\02026-08-01T00:00:00Z\0WIP on feature: abc123 subject\0{} {}\n",
            first,
            "a".repeat(40),
            "b".repeat(40),
            "c".repeat(40),
            second,
            "d".repeat(40),
            "e".repeat(40),
        );
        let entries = parse_stash_list(&raw);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, first);
        assert_eq!(entries[0].selector, "stash@{0}");
        assert_eq!(entries[0].ordinal, 0);
        assert_eq!(entries[0].branch_context.as_deref(), Some("main"));
        assert_eq!(entries[0].message, "save work");
        assert!(entries[0].includes_untracked);
        assert_eq!(entries[1].id, second);
        assert!(!entries[1].includes_untracked);
    }

    #[test]
    fn display_cap_never_truncates_internal_mutation_identity_authority() {
        let mut all = (0..101)
            .map(|index| {
                let oid = format!("{:040x}", index + 1);
                entry(&oid, &format!("stash@{{{}}}", index))
            })
            .collect::<Vec<_>>();
        let hidden = all.last().unwrap().id.clone();
        let display = all.iter().take(100).cloned().collect::<Vec<_>>();
        let mut value = snapshot("snapshot", "worktree", display, vec![]);
        value.stash_total = all.len();
        value.stashes_truncated = true;
        value.all_stashes = std::mem::take(&mut all);

        assert_eq!(value.stashes.len(), 100);
        assert_eq!(value.stash_total, 101);
        assert!(find_stash_entry(&value, &hidden).is_some());
        assert!(stash_ids(&value).contains(&hidden));
    }

    #[test]
    fn pending_projection_prioritizes_actionable_worktree_evidence_and_preserves_total() {
        let mut unresolved = (0..21)
            .map(|index| UnresolvedStashAuthority {
                request_id: format!("foreign_{}", index),
                operation: "create".to_string(),
                target_stash_id: None,
                origin_repo_path: Some("/other-worktree".to_string()),
                status: "needs_confirmation".to_string(),
                message: "foreign pending".to_string(),
                applied: false,
                needs_confirmation: true,
                updated_at_ms: (100 - index) as u128,
            })
            .collect::<Vec<_>>();
        unresolved.push(UnresolvedStashAuthority {
            request_id: "legacy".to_string(),
            operation: "create_selected".to_string(),
            target_stash_id: None,
            origin_repo_path: None,
            status: "needs_confirmation".to_string(),
            message: "legacy pending".to_string(),
            applied: false,
            needs_confirmation: true,
            updated_at_ms: 1,
        });
        unresolved.push(UnresolvedStashAuthority {
            request_id: "current".to_string(),
            operation: "create".to_string(),
            target_stash_id: None,
            origin_repo_path: Some(stash_worktree_origin("/repo")),
            status: "needs_confirmation".to_string(),
            message: "current pending".to_string(),
            applied: false,
            needs_confirmation: true,
            updated_at_ms: 0,
        });

        let value = apply_pending_projection(
            snapshot("snapshot", "worktree", Vec::new(), vec![]),
            unresolved,
        );

        assert_eq!(value.pending_operation_total, 23);
        assert_eq!(value.pending_operations.len(), 20);
        assert!(value.pending_operations_truncated);
        assert_eq!(value.pending_operations[0].request_id, "current");
        assert_eq!(value.pending_operations[1].request_id, "legacy");
    }

    #[test]
    fn interrupted_create_accepts_only_one_new_stable_stash_identity() {
        let before = snapshot("before", "worktree-a", vec![entry(&"1".repeat(40), "stash@{0}")], vec![]);
        let mut current_entries = before.stashes.clone();
        current_entries.insert(0, entry(&"2".repeat(40), "stash@{0}"));
        current_entries[1].selector = "stash@{1}".to_string();
        current_entries[1].ordinal = 1;
        let current = snapshot("after", "worktree-b", current_entries, vec![]);

        let result = derive_interrupted_result(&journal("create", None, &before), &current);
        assert_eq!(result.status, "complete");
        assert_eq!(result.created_stash_id.as_deref(), Some("2222222222222222222222222222222222222222"));
        assert!(!result.needs_confirmation);
    }

    #[test]
    fn interrupted_pop_with_conflicts_keeps_the_exact_target_stash() {
        let target = "3".repeat(40);
        let before = snapshot("before", "worktree-a", vec![entry(&target, "stash@{0}")], vec![]);
        let current = snapshot(
            "after",
            "worktree-b",
            vec![entry(&target, "stash@{0}")],
            vec!["src/conflict.rs"],
        );

        let result = derive_interrupted_result(&journal("pop", Some(&target), &before), &current);
        assert_eq!(result.status, "conflict");
        assert!(result.stash_retained);
        assert_eq!(result.conflicts, vec!["src/conflict.rs"]);
        assert!(!result.dropped);
    }

    #[test]
    fn recorded_pop_application_is_never_replayed_after_restart() {
        let target = "5".repeat(40);
        let before = snapshot("before", "worktree-a", vec![entry(&target, "stash@{0}")], vec![]);
        let mut operation = journal("pop", Some(&target), &before);
        let mut applied = stored_result(
            "pop",
            "request_1",
            "partial",
            Some(target.clone()),
            "应用阶段已完成",
        );
        applied.applied = true;
        applied.mutated = true;
        applied.stash_retained = true;
        operation.phase = "drop-prepared".to_string();
        operation.result = Some(applied);

        let retained = snapshot(
            "after-apply",
            "worktree-b",
            vec![entry(&target, "stash@{0}")],
            vec![],
        );
        let retained_result = derive_interrupted_result(&operation, &retained);
        assert_eq!(retained_result.status, "partial");
        assert!(retained_result.applied);
        assert!(!retained_result.dropped);
        assert!(retained_result.stash_retained);
        assert!(retained_result.message.contains("不会再次 Apply"));

        let deleted = snapshot("after-drop", "worktree-b", Vec::new(), vec![]);
        let deleted_result = derive_interrupted_result(&operation, &deleted);
        assert_eq!(deleted_result.status, "complete");
        assert!(deleted_result.applied);
        assert!(deleted_result.dropped);
        assert!(!deleted_result.stash_retained);
    }

    #[test]
    fn interrupted_drop_completes_only_when_the_exact_oid_is_absent() {
        let target = "4".repeat(40);
        let before = snapshot("before", "worktree-a", vec![entry(&target, "stash@{0}")], vec![]);
        let current = snapshot("after", "worktree-a", Vec::new(), vec![]);

        let result = derive_interrupted_result(&journal("drop", Some(&target), &before), &current);
        assert_eq!(result.status, "complete");
        assert!(result.dropped);
        assert!(!result.stash_retained);
        assert!(!result.needs_confirmation);
    }

    #[test]
    fn messages_and_identifiers_are_bounded_before_any_git_operation() {
        assert_eq!(normalize_stash_message("  first\nsecond\r\nthird  ").unwrap(), "first second third");
        assert!(normalize_stash_message(&"x".repeat(STASH_MESSAGE_MAX_CHARS + 1)).is_err());
        assert!(normalize_request_id("stash_request-1").is_ok());
        assert!(normalize_request_id("bad request").is_err());
        assert!(normalize_stash_id(&"a".repeat(40)).is_ok());
        assert!(normalize_stash_id("stash@{0}").is_err());
    }
}
