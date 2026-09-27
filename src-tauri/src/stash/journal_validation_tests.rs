mod journal_validation_tests {
    use super::*;

    fn target_oid() -> String {
        "a".repeat(40)
    }

    #[test]
    fn complete_results_require_operation_specific_axes() {
        let target = target_oid();

        let mut pop = stored_result(
            "pop",
            "request_1",
            "complete",
            Some(target.clone()),
            "complete",
        );
        assert!(validate_stored_result_semantics(&pop, "pop").is_err());
        pop.mutated = true;
        pop.applied = true;
        pop.dropped = true;
        assert!(validate_stored_result_semantics(&pop, "pop").is_ok());

        let mut apply = stored_result(
            "apply",
            "request_2",
            "complete",
            Some(target),
            "complete",
        );
        apply.applied = true;
        apply.stash_retained = true;
        assert!(validate_stored_result_semantics(&apply, "apply").is_ok());

        let mut failed = stored_result("create", "request_3", "failed", None, "failed");
        failed.mutated = true;
        assert!(validate_stored_result_semantics(&failed, "create").is_err());
    }

    #[test]
    fn partial_pop_distinguishes_uncertain_from_confirmed_application() {
        let mut partial = stored_result(
            "pop",
            "request_1",
            "partial",
            Some(target_oid()),
            "partial",
        );
        partial.stash_retained = true;
        partial.needs_confirmation = true;

        assert!(validate_stored_result_semantics(&partial, "pop").is_ok());

        partial.needs_confirmation = false;
        assert!(validate_stored_result_semantics(&partial, "pop").is_err());

        partial.applied = true;
        assert!(validate_stored_result_semantics(&partial, "pop").is_ok());
    }

    #[test]
    fn phase_contracts_allow_only_persisted_operation_states() {
        assert!(regular_phase_is_valid("create", "creating-returned"));
        assert!(regular_phase_is_valid("pop", "drop-prepared"));
        assert!(!regular_phase_is_valid("apply", "drop-prepared"));
        assert!(!regular_phase_is_valid("pop", "unknown-phase"));

        assert!(selected_phase_is_valid("prepared"));
        assert!(selected_phase_is_valid("command-returned"));
        assert!(!selected_phase_is_valid("drop-prepared"));
    }

    #[test]
    fn backup_evidence_path_keeps_the_same_request_identity() {
        assert_eq!(
            evidence_path_request_id(Path::new("request_1.json")).unwrap(),
            "request_1"
        );
        assert_eq!(
            evidence_path_request_id(Path::new("request_1.json.bak")).unwrap(),
            "request_1"
        );
        assert!(evidence_path_request_id(Path::new("request_1.tmp")).is_err());
    }

    #[test]
    fn complete_requires_durable_validation_before_terminal_release() {
        let mut complete = stored_result("create", "request_4", "complete", None, "complete");
        complete.mutated = true;
        complete.created_stash_id = Some(target_oid());

        assert!(!stash_result_is_durable_terminal(&complete, false));
        assert!(stash_result_is_durable_terminal(&complete, true));

        complete.needs_confirmation = true;
        assert!(!stash_result_is_durable_terminal(&complete, true));

        let failed = stored_result("create", "request_5", "failed", None, "failed");
        let stale = stored_result("create", "request_6", "stale", None, "stale");
        let acknowledged = stored_result(
            "create",
            "request_7",
            "acknowledged",
            None,
            "acknowledged",
        );
        assert!(stash_result_is_durable_terminal(&failed, false));
        assert!(stash_result_is_durable_terminal(&stale, false));
        assert!(stash_result_is_durable_terminal(&acknowledged, false));
    }

    #[test]
    fn completion_proof_is_only_valid_for_settled_complete_result() {
        let mut complete = stored_result("create", "request_8", "complete", None, "complete");
        complete.mutated = true;
        complete.created_stash_id = Some(target_oid());

        assert!(validate_completion_proof(
            "settled",
            Some(&complete),
            false,
            None,
            None,
        )
        .is_ok());
        assert!(validate_completion_proof(
            "settled",
            Some(&complete),
            true,
            Some(true),
            None,
        )
        .is_ok());
        assert!(validate_completion_proof(
            "settled",
            Some(&complete),
            true,
            None,
            None,
        )
        .is_err());
        assert!(validate_completion_proof(
            "settled",
            Some(&complete),
            true,
            Some(false),
            Some("git failed"),
        )
        .is_err());
        assert!(validate_completion_proof(
            "creating-returned",
            Some(&complete),
            true,
            Some(true),
            None,
        )
        .is_err());
        assert!(validate_completion_proof(
            "settled",
            None,
            true,
            Some(true),
            None,
        )
        .is_err());

        complete.needs_confirmation = true;
        assert!(validate_completion_proof(
            "settled",
            Some(&complete),
            true,
            Some(true),
            None,
        )
        .is_err());
    }
}
