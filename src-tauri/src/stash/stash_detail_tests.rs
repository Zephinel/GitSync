mod stash_detail_tests {
    use super::*;

    fn detail_entry() -> RepoStashEntry {
        RepoStashEntry {
            id: "a".repeat(40),
            oid: "a".repeat(40),
            selector: "stash@{0}".to_string(),
            ordinal: 0,
            message: "detail".to_string(),
            subject: "On main: detail".to_string(),
            branch_context: Some("main".to_string()),
            created_at: "2026-08-07T00:00:00Z".to_string(),
            base_commit: Some("b".repeat(40)),
            base_summary: None,
            includes_untracked: false,
            scope_summary: "tracked".to_string(),
        }
    }

    #[test]
    fn parses_stash_parent_shape_with_optional_untracked_parent() {
        let (base, untracked) = parse_stash_parents("stash base index untracked\n").unwrap();
        assert_eq!(base, "base");
        assert_eq!(untracked.as_deref(), Some("untracked"));

        let (base, untracked) = parse_stash_parents("stash base index\n").unwrap();
        assert_eq!(base, "base");
        assert_eq!(untracked, None);
        assert!(parse_stash_parents("stash base").is_err());
    }

    #[test]
    fn parses_tracked_name_status_and_rename_identity() {
        let files = parse_name_status_z("M\0src/a.rs\0R100\0old.rs\0new.rs\0D\0gone.rs\0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[1].status, "renamed");
        assert_eq!(files[1].old_path.as_deref(), Some("old.rs"));
        assert_eq!(files[1].path, "new.rs");
        assert_eq!(files[2].status, "deleted");
    }

    #[test]
    fn merges_numstat_and_preserves_binary_marker() {
        let mut files = parse_name_status_z("M\0src/a.rs\0M\0asset.png\0");
        let stats = parse_numstat_z("12\t3\tsrc/a.rs\0-\t-\tasset.png\0");
        merge_stash_detail_stats(&mut files, &stats);

        assert_eq!(files[0].additions, 12);
        assert_eq!(files[0].deletions, 3);
        assert!(!files[0].is_binary);
        assert!(files[1].is_binary);
    }

    #[test]
    fn marks_untracked_files_without_losing_numstat() {
        let mut files = parse_name_status_z("A\0notes/a.txt\0A\0notes/b.bin\0");
        let stats = parse_numstat_z("2\t0\tnotes/a.txt\0-\t-\tnotes/b.bin\0");
        merge_stash_detail_stats(&mut files, &stats);
        mark_untracked_detail_files(&mut files);

        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|file| file.is_untracked));
        assert!(files.iter().all(|file| file.status == "untracked"));
        assert_eq!(files[0].additions, 2);
        assert!(files[1].is_binary);
    }

    #[test]
    fn streaming_parsers_preserve_rename_and_numstat_identity() {
        let mut status = NameStatusStreamParser::new(false);
        assert!(status.push_field("M".to_string()).unwrap().is_none());
        let modified = status
            .push_field("src/a.rs".to_string())
            .unwrap()
            .unwrap();
        assert_eq!(modified.status, "modified");
        assert!(status.push_field("R100".to_string()).unwrap().is_none());
        assert!(status.push_field("old.rs".to_string()).unwrap().is_none());
        let renamed = status
            .push_field("new.rs".to_string())
            .unwrap()
            .unwrap();
        assert_eq!(renamed.status, "renamed");
        assert_eq!(renamed.old_path.as_deref(), Some("old.rs"));
        status.finish().unwrap();

        let mut numstat = NumstatStreamParser::new();
        let tracked = numstat
            .push_field("12\t3\tsrc/a.rs".to_string())
            .unwrap()
            .unwrap();
        assert_eq!(tracked.additions, 12);
        assert_eq!(tracked.deletions, 3);
        assert!(!tracked.binary);
        let binary = numstat
            .push_field("-\t-\tasset.png".to_string())
            .unwrap()
            .unwrap();
        assert!(binary.binary);
        assert!(numstat.push_field("1\t2\t".to_string()).unwrap().is_none());
        assert!(numstat.push_field("old.rs".to_string()).unwrap().is_none());
        let rename_stats = numstat
            .push_field("new.rs".to_string())
            .unwrap()
            .unwrap();
        assert_eq!(rename_stats.path, "new.rs");
        assert_eq!(rename_stats.additions, 1);
        assert_eq!(rename_stats.deletions, 2);
        numstat.finish().unwrap();
    }

    #[test]
    fn streamed_detail_retains_only_the_bounded_sorted_surface_but_counts_every_file() {
        let total = STASH_DETAIL_MAX_FILES + 3;
        let mut accumulator = StashDetailAccumulator::default();
        for index in (0..total).rev() {
            accumulator.observe_file(RepoStashDetailFile {
                path: format!("src/{:05}.txt", index),
                old_path: None,
                status: "modified".to_string(),
                additions: 0,
                deletions: 0,
                is_binary: false,
                is_untracked: false,
            });
        }

        assert_eq!(accumulator.file_count, total);
        assert_eq!(accumulator.modified_files, total);
        assert_eq!(accumulator.retained.len(), STASH_DETAIL_MAX_FILES);

        let retained_paths = accumulator.retained_paths();
        let mut retained_stats = HashMap::new();
        for index in 0..total {
            accumulator.observe_numstat(
                NumstatStreamEntry {
                    path: format!("src/{:05}.txt", index),
                    additions: 1,
                    deletions: 2,
                    binary: false,
                },
                &retained_paths,
                &mut retained_stats,
            );
        }

        let detail = accumulator.into_detail(detail_entry(), &retained_stats);
        assert_eq!(detail.file_count, total);
        assert_eq!(detail.files.len(), STASH_DETAIL_MAX_FILES);
        assert!(detail.files_truncated);
        assert_eq!(detail.additions, total as u32);
        assert_eq!(detail.deletions, (total * 2) as u32);
        assert_eq!(detail.files.first().unwrap().path, "src/00000.txt");
        assert_eq!(
            detail.files.last().unwrap().path,
            format!("src/{:05}.txt", STASH_DETAIL_MAX_FILES - 1)
        );
        assert!(detail.files.iter().all(|file| file.additions == 1));
        assert!(detail.files.iter().all(|file| file.deletions == 2));
    }

    #[test]
    fn creates_bounded_new_file_patch_for_untracked_text() {
        let patch = untracked_file_patch("notes.txt", "first\nsecond\n");
        assert!(patch.contains("--- /dev/null"));
        assert!(patch.contains("+++ b/notes.txt"));
        assert!(patch.contains("+first"));
        assert!(patch.contains("+second"));
    }

    #[test]
    fn patch_bounding_reports_truncation() {
        let input = "x".repeat(STASH_DETAIL_MAX_PATCH_BYTES + 20);
        let (bounded, truncated) = bounded_patch(input);
        assert!(truncated);
        assert!(bounded.len() <= STASH_DETAIL_MAX_PATCH_BYTES);
    }
}
