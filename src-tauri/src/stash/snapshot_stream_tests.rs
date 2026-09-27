mod snapshot_stream_tests {
    use super::*;

    #[test]
    fn streamed_stash_list_hash_matches_the_existing_v1_snapshot_identity_contract() {
        let repo_root = "/repo";
        let branch = "main";
        let head = "0123456789abcdef0123456789abcdef01234567";
        let status = "M  tracked.rs\0?? note.txt\0";
        let stash_raw = concat!(
            "stash@{0}\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0",
            "2026-08-07T00:00:00Z\0On main: save\0",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
            "stash@{1}\0cccccccccccccccccccccccccccccccccccccccc\0",
            "2026-08-06T00:00:00Z\0WIP on feature: work\0",
            "dddddddddddddddddddddddddddddddddddddddd eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n",
        );
        let leading = [repo_root, branch, head];
        let mut hasher = stable_hash_stream_seed("stash-snapshot-v1", &leading);
        for field in status.split_terminator('\0') {
            stable_hash_stream_nul_field(&mut hasher, field);
        }
        stable_hash_stream_finish_str_part(&mut hasher);
        for record in stash_raw.lines() {
            stable_hash_stream_newline_record(&mut hasher, record);
        }
        stable_hash_stream_finish_str_part(&mut hasher);

        assert_eq!(
            finish_snapshot_identity(hasher),
            stable_hash(
                "stash-snapshot-v1",
                &[repo_root, branch, head, status, stash_raw],
            )
        );
    }

    #[test]
    fn empty_streamed_stash_list_hashes_as_the_same_empty_string_part() {
        let repo_root = "/repo";
        let branch = "main";
        let head = "0123456789abcdef0123456789abcdef01234567";
        let status = "";
        let leading = [repo_root, branch, head];
        let mut hasher = stable_hash_stream_seed("stash-snapshot-v1", &leading);
        stable_hash_stream_finish_str_part(&mut hasher);
        stable_hash_stream_finish_str_part(&mut hasher);

        assert_eq!(
            finish_snapshot_identity(hasher),
            stable_hash(
                "stash-snapshot-v1",
                &[repo_root, branch, head, status, ""],
            )
        );
    }

    #[test]
    fn streamed_stash_record_preserves_stable_oid_and_display_metadata() {
        let record = concat!(
            "stash@{0}\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0",
            "2026-08-07T00:00:00Z\0On main: save work\0",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ",
            "cccccccccccccccccccccccccccccccccccccccc ",
            "dddddddddddddddddddddddddddddddddddddddd",
        );
        let entry = parse_stash_list_record(record).unwrap();

        assert_eq!(entry.id, "a".repeat(40));
        assert_eq!(entry.selector, "stash@{0}");
        assert_eq!(entry.ordinal, 0);
        assert_eq!(entry.branch_context.as_deref(), Some("main"));
        assert_eq!(entry.message, "save work");
        assert!(entry.includes_untracked);
        assert_eq!(entry.base_commit.as_deref(), Some(&"b".repeat(40)[..]));
    }
}
