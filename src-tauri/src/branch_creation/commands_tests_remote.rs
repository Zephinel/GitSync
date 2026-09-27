    #[tokio::test]
    async fn local_creation_preserves_current_branch_and_dirty_worktree() {
        let repository = init_repository("local-create");
        let repo_path = repository.path.to_string_lossy().to_string();
        let source_branch = git(&repository.path, &["branch", "--show-current"]);
        let source_commit = git(&repository.path, &["rev-parse", "HEAD"]);
        fs::write(repository.path.join("tracked.txt"), "dirty\n").expect("dirty fixture");
        let status_before = git(&repository.path, &["status", "--porcelain=v1"]);
        let signature = local_signature(
            &source_branch,
            &source_commit,
            "feature/atomic-create",
            false,
            None,
        );
        let request_id = "atomic_create_request";
        let journal_file = journal_path(&repo_path, request_id)
            .await
            .expect("journal path");
        let mut journal = new_journal(request_id.to_string(), signature.clone(), true);
        persist_journal(&journal_file, &mut journal).expect("persist initial journal");
        execute_pending_steps(&repo_path, &journal_file, &mut journal, true, None)
            .await
            .expect("execute branch creation");

        assert_eq!(journal.local_state, "created");
        assert_eq!(journal.switch_state, "not-requested");
        assert_eq!(journal.remote_state, "not-requested");
        assert_eq!(
            git(&repository.path, &["branch", "--show-current"]),
            source_branch
        );
        assert_eq!(
            git(&repository.path, &["rev-parse", "refs/heads/feature/atomic-create"]),
            source_commit
        );
        assert_eq!(
            git(&repository.path, &["rev-parse", signature.source_ref.as_str()]),
            source_commit
        );
        assert_eq!(
            git(&repository.path, &["status", "--porcelain=v1"]),
            status_before
        );
        assert_eq!(
            reconcile_local_creation(&repo_path, &signature, request_id)
                .await
                .expect("reconcile owned branch"),
            "created"
        );
        assert_eq!(
            reconcile_local_creation(&repo_path, &signature, "different_request")
                .await
                .expect("do not adopt another request's branch"),
            "unknown"
        );
        let result = build_result(&repo_path, &journal).await;
        assert_eq!(result.status, "complete");
        assert!(result.local_created);
        assert!(!result.switched);
        assert!(result.worktree_is_dirty);
    }

    #[tokio::test]
    async fn source_change_after_journal_prevents_local_creation() {
        let repository = init_repository("source-change");
        let repo_path = repository.path.to_string_lossy().to_string();
        let source_branch = git(&repository.path, &["branch", "--show-current"]);
        let source_commit = git(&repository.path, &["rev-parse", "HEAD"]);
        let signature = local_signature(
            &source_branch,
            &source_commit,
            "feature/stale-source",
            false,
            None,
        );
        fs::write(repository.path.join("tracked.txt"), "new source\n").expect("update fixture");
        git(&repository.path, &["add", "--", "tracked.txt"]);
        git(&repository.path, &["commit", "--quiet", "-m", "advance source"]);

        let result = create_local_branch_atomically(&repo_path, &signature, "stale_source_request")
            .await;
        assert!(result.is_err());
        assert!(super::resolve_ref(&repo_path, "refs/heads/feature/stale-source")
            .await
            .expect("read target ref")
            .is_none());
        assert_eq!(
            git(&repository.path, &["rev-parse", signature.source_ref.as_str()]),
            git(&repository.path, &["rev-parse", "HEAD"])
        );
    }

    #[tokio::test]
    async fn durable_pending_local_step_is_retryable_and_runs_once() {
        let repository = init_repository("pending-local");
        let repo_path = repository.path.to_string_lossy().to_string();
        let source_branch = git(&repository.path, &["branch", "--show-current"]);
        let source_commit = git(&repository.path, &["rev-parse", "HEAD"]);
        let signature = local_signature(
            &source_branch,
            &source_commit,
            "feature/resume-pending",
            false,
            None,
        );
        let request_id = "resume_pending_request";
        let journal_file = journal_path(&repo_path, request_id)
            .await
            .expect("journal path");
        let mut journal = new_journal(request_id.to_string(), signature.clone(), false);
        persist_journal(&journal_file, &mut journal).expect("persist identity before mutation");

        let before = build_result(&repo_path, &journal).await;
        assert_eq!(before.status, "failed");
        assert_eq!(before.retryable_steps, vec!["local"]);

        execute_pending_steps(&repo_path, &journal_file, &mut journal, true, None)
            .await
            .expect("continue provably unstarted step");
        let reflog_before = git(
            &repository.path,
            &[
                "reflog",
                "show",
                "--format=%gs",
                "refs/heads/feature/resume-pending",
            ],
        );
        execute_pending_steps(&repo_path, &journal_file, &mut journal, true, None)
            .await
            .expect("duplicate continuation is a no-op");
        let reflog_after = git(
            &repository.path,
            &[
                "reflog",
                "show",
                "--format=%gs",
                "refs/heads/feature/resume-pending",
            ],
        );
        assert_eq!(reflog_before, reflog_after);
        assert_eq!(journal.local_state, "created");
        assert_eq!(build_result(&repo_path, &journal).await.status, "complete");
    }

    #[tokio::test]
    async fn pending_publish_and_tracking_are_reported_as_retryable() {
        let repository = init_repository("pending-remote");
        let repo_path = repository.path.to_string_lossy().to_string();
        let source_branch = git(&repository.path, &["branch", "--show-current"]);
        let source_commit = git(&repository.path, &["rev-parse", "HEAD"]);
        let signature = local_signature(
            &source_branch,
            &source_commit,
            "feature/pending-remote",
            true,
            Some("origin"),
        );
        let mut journal = new_journal("pending_remote_request".to_string(), signature.clone(), false);
        assert_eq!(
            create_local_branch_atomically(&repo_path, &signature, "pending_remote_request")
                .await
                .expect("create owned local branch"),
            "created"
        );
        journal.local_state = "created".to_string();
        let publish_pending = build_result(&repo_path, &journal).await;
        assert!(publish_pending.retryable_steps.iter().any(|step| step == "publish"));
        assert!(!publish_pending.retryable_steps.iter().any(|step| step == "tracking"));

        journal.remote_state = "created".to_string();
        let tracking_pending = build_result(&repo_path, &journal).await;
        assert!(tracking_pending.retryable_steps.iter().any(|step| step == "tracking"));
    }

    #[test]
    fn clearing_one_step_error_preserves_other_partial_failure_reasons() {
        let repository = init_repository("step-errors");
        let source_branch = git(&repository.path, &["branch", "--show-current"]);
        let source_commit = git(&repository.path, &["rev-parse", "HEAD"]);
        let signature = local_signature(
            &source_branch,
            &source_commit,
            "feature/step-errors",
            true,
            Some("origin"),
        );
        let mut journal = new_journal("step_error_request".to_string(), signature, false);
        super::set_step_error(&mut journal, "switch", "切换失败原因");
        super::set_step_error(&mut journal, "publish", "发布失败原因");
        super::clear_step_error(&mut journal, "publish");
        let displayed = journal
            .errors
            .iter()
            .map(|error| super::display_error(error))
            .collect::<Vec<_>>();
        assert_eq!(displayed, vec!["切换失败原因"]);
    }

    #[tokio::test]
    async fn publish_creates_only_a_new_remote_branch_and_its_own_tracking() {
        let repository = init_repository("publish");
        let remote = TestDirectory::new("publish-remote");
        git(&remote.path, &["init", "--bare", "--quiet", "."]);
        git(
            &repository.path,
            &["remote", "add", "origin", remote.path.to_string_lossy().as_ref()],
        );
        let repo_path = repository.path.to_string_lossy().to_string();
        let source_branch = git(&repository.path, &["branch", "--show-current"]);
        let source_commit = git(&repository.path, &["rev-parse", "HEAD"]);
        let signature = local_signature(
            &source_branch,
            &source_commit,
            "feature/publish-new",
            true,
            Some("origin"),
        );
        let request_id = "publish_new_request";
        let journal_file = journal_path(&repo_path, request_id)
            .await
            .expect("journal path");
        let mut journal = new_journal(request_id.to_string(), signature.clone(), false);
        persist_journal(&journal_file, &mut journal).expect("persist initial journal");
        execute_pending_steps(&repo_path, &journal_file, &mut journal, true, None)
            .await
            .expect("publish new branch");

        assert_eq!(journal.remote_state, "created");
        assert_eq!(journal.tracking_state, "configured");
        assert_eq!(
            git(
                &remote.path,
                &["rev-parse", "refs/heads/feature/publish-new"]
            ),
            source_commit
        );
        assert_eq!(
            git(
                &repository.path,
                &[
                    "for-each-ref",
                    "--format=%(upstream:short)",
                    "refs/heads/feature/publish-new",
                ],
            ),
            "origin/feature/publish-new"
        );
        assert_eq!(
            super::publish_new_branch(
                &repo_path,
                "origin",
                "feature/publish-new",
                &source_commit,
            )
            .await
            .expect("existing remote branch is a conflict"),
            "conflict"
        );

        git(
            &repository.path,
            &["branch", "-D", "--", "feature/publish-new"],
        );
        let validation = validate_name_locked(
            &repo_path,
            &BranchNameValidationRequest {
                name: "feature/publish-new".to_string(),
                publish: true,
                remote: Some("origin".to_string()),
            },
        )
        .await
        .expect("validate remote duplicate");
        assert!(!validation.valid);
        assert!(!validation.local_exists);
        assert!(validation.remote_exists);
        assert!(validation.remote_checked);
        assert!(validation.errors.iter().any(|error| error.contains("不会覆盖")));
    }
