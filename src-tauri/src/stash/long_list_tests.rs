mod long_list_tests {
    use super::*;

    #[test]
    fn parser_keeps_every_stash_identity_beyond_summary_enrichment_limit() {
        let raw = (0..150)
            .map(|index| {
                let oid = format!("{:040x}", index + 1);
                format!(
                    "stash@{{{}}}\0{}\02026-08-02T00:00:00Z\0On main: item {}\0{} {}",
                    index,
                    oid,
                    index,
                    "a".repeat(40),
                    "b".repeat(40),
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        let entries = parse_stash_list(&raw);
        assert_eq!(entries.len(), 150);
        assert_eq!(entries.first().unwrap().selector, "stash@{0}");
        assert_eq!(entries.last().unwrap().selector, "stash@{149}");
        assert_eq!(entries.last().unwrap().id, format!("{:040x}", 150));
        assert_eq!(GIT_STASH_BASE_SUMMARY_LIMIT, 100);
    }
}
