const STASH_SELECTED_TARGET_MAX_FILES: usize = 512;
const STASH_SELECTED_PATHSPEC_BUDGET_UTF16: usize = 16 * 1024;
const STASH_SELECTED_DIGEST_PATHSPEC_BUDGET_UTF16: usize = 24 * 1024;

fn selected_scope_request_pathspecs(targets: &[StashPathTarget]) -> Vec<String> {
    let mut values = std::collections::BTreeSet::new();
    for target in targets {
        values.insert(literal_stash_pathspec(&target.path));
        if let Some(old_path) = target.old_path.as_deref() {
            values.insert(literal_stash_pathspec(old_path));
        }
    }
    values.into_iter().collect()
}

fn selected_scope_digest_pathspecs(targets: &[StashPathTarget]) -> Vec<String> {
    let mut values = std::collections::BTreeSet::new();
    for target in targets {
        values.insert(top_literal_exclude_pathspec(&target.path));
        if let Some(old_path) = target.old_path.as_deref() {
            values.insert(top_literal_exclude_pathspec(old_path));
        }
    }
    values.into_iter().collect()
}

fn pathspec_command_utf16_units(arguments: &[String]) -> usize {
    arguments
        .iter()
        .map(|argument| {
            // Reserve separator/quoting headroom per pathspec in addition to
            // the literal UTF-16 command-line representation.
            argument.encode_utf16().count().saturating_add(3)
        })
        .fold(0usize, usize::saturating_add)
}

fn selected_pathspec_command_utf16_units(targets: &[StashPathTarget]) -> usize {
    pathspec_command_utf16_units(&selected_scope_request_pathspecs(targets))
}

fn selected_digest_command_utf16_units(targets: &[StashPathTarget]) -> usize {
    pathspec_command_utf16_units(&selected_scope_digest_pathspecs(targets))
}

fn ensure_selected_scope_request_budget(targets: &[StashPathTarget]) -> Result<(), String> {
    if targets.len() > STASH_SELECTED_TARGET_MAX_FILES {
        return Err(format!(
            "单次文件级 Stash 最多允许选择 {} 个文件；当前选择 {} 个。请缩小选择范围或改用 Stash 全部改动。",
            STASH_SELECTED_TARGET_MAX_FILES,
            targets.len()
        ));
    }

    let stash_units = selected_pathspec_command_utf16_units(targets);
    if stash_units > STASH_SELECTED_PATHSPEC_BUDGET_UTF16 {
        return Err(format!(
            "所选文件路径过多或过长，预计 Stash pathspec 命令预算 {} 超过安全上限 {}。请缩小选择范围或改用 Stash 全部改动。",
            stash_units,
            STASH_SELECTED_PATHSPEC_BUDGET_UTF16
        ));
    }

    let digest_units = selected_digest_command_utf16_units(targets);
    if digest_units > STASH_SELECTED_DIGEST_PATHSPEC_BUDGET_UTF16 {
        return Err(format!(
            "所选文件路径过多或过长，预计范围 digest pathspec 命令预算 {} 超过安全上限 {}。请缩小选择范围或改用 Stash 全部改动。",
            digest_units,
            STASH_SELECTED_DIGEST_PATHSPEC_BUDGET_UTF16
        ));
    }
    Ok(())
}
