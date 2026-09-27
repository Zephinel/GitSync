fn is_terminal_stash_journal(journal: &StashOperationJournal) -> bool {
    journal.phase == "settled"
        && journal.result.as_ref().is_some_and(|result| {
            stash_result_is_durable_terminal(result, journal.completion_validated)
        })
}

fn is_terminal_selected_stash_journal(journal: &SelectedStashOperationJournal) -> bool {
    journal.phase == "settled"
        && journal.result.as_ref().is_some_and(|result| {
            stash_result_is_durable_terminal(result, journal.completion_validated)
        })
}

fn remove_journal_family(path: &Path) {
    let _ = fs::remove_file(path);
    let backup = journal_sibling_path(path, "bak");
    let tmp = journal_sibling_path(path, "tmp");
    let _ = fs::remove_file(backup);
    let _ = fs::remove_file(tmp);
}

fn prune_terminal_paths(mut terminal: Vec<(PathBuf, u128)>) {
    let now = now_ms();
    terminal.sort_by(|left, right| right.1.cmp(&left.1));
    for (index, (path, updated_at_ms)) in terminal.into_iter().enumerate() {
        let expired = now.saturating_sub(updated_at_ms) > STASH_SETTLED_RETENTION_MS;
        let beyond_cap = index >= STASH_SETTLED_MAX_JOURNALS;
        if expired || beyond_cap {
            remove_journal_family(&path);
        }
    }
}

async fn prune_settled_stash_journals_except(
    repo_root: &str,
    protected_request_id: Option<&str>,
) -> Result<(), String> {
    let regular_directory = stash_journal_directory(repo_root).await?;
    let mut regular_terminal = Vec::new();
    for path in journal_base_paths(&regular_directory)? {
        // Unreadable evidence is deliberately retained. The snapshot authority
        // will surface it and mutation authority will block new writes.
        let Ok(Some(journal)) = load_stash_journal(&path) else {
            continue;
        };
        if protected_request_id == Some(journal.request_id.as_str()) {
            continue;
        }
        if is_terminal_stash_journal(&journal) {
            regular_terminal.push((path, journal.updated_at_ms));
        }
    }
    prune_terminal_paths(regular_terminal);

    let selected_directory = selected_stash_journal_directory(repo_root).await?;
    let mut selected_terminal = Vec::new();
    for path in journal_base_paths(&selected_directory)? {
        let Ok(Some(journal)) = load_selected_stash_journal_authoritative(&path) else {
            continue;
        };
        if protected_request_id == Some(journal.request_id.as_str()) {
            continue;
        }
        if is_terminal_selected_stash_journal(&journal) {
            selected_terminal.push((path, journal.updated_at_ms));
        }
    }
    prune_terminal_paths(selected_terminal);
    Ok(())
}

async fn prune_settled_stash_journals(repo_root: &str) -> Result<(), String> {
    prune_settled_stash_journals_except(repo_root, None).await
}
