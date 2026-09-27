//! Single authority for git subprocess time budgets.
//!
//! Every module's deadline is defined here and imported, so the same git
//! operation can no longer silently get a different deadline in a different
//! module. Before this module existed, `git log -1` was allowed 1200 ms in
//! `commands.rs` while the same operation got 4000 ms in `branch_management`,
//! `force_branch_delete`, `staging` and `working_changes`.
//!
//! `crate::git_timeouts` is also the authority for how a timeout is spelled:
//! `TIMEOUT_ERROR_PREFIX` is used both to build the error and to recognise it,
//! so a caller never has to pattern-match a hand-written string.
//!
//! A regression test (`src/gitTimeoutAuthority.test.js`) rejects any literal
//! `_TIMEOUT_MS` assignment outside this file, so a new budget cannot bypass
//! the policy.

/// Marker shared by the timeout constructor and its recogniser.
pub const TIMEOUT_ERROR_PREFIX: &str = "执行 git 命令超时: ";

/// Prefix used when the git child could not be spawned at all.
pub const SPAWN_ERROR_PREFIX: &str = "执行 git 命令失败: ";

/// Local metadata reads: rev-parse, for-each-ref, log -1, config, remote, name-rev.
pub const META: u64 = 4_000;
/// Repository working-tree status (`status --porcelain`).
pub const STATUS: u64 = 6_000;
/// Branch overview construction (many small local reads).
pub const BRANCH_OVERVIEW: u64 = 8_000;
/// Commit history construction.
pub const COMMIT_HISTORY: u64 = 8_000;
/// Synchronization pre-flight checks.
pub const PRECHECK: u64 = 5_000;
/// Small local mutations: unset-upstream, remote bookkeeping.
pub const SYNC_MISC: u64 = 8_000;
/// Local ref mutations: branch -d/-D, update-ref.
pub const DELETE: u64 = 60_000;
/// Stash push/pop/apply.
pub const SYNC_STASH: u64 = 15_000;
/// Remote HEAD / ls-remote lookups.
pub const REMOTE_HEAD: u64 = 12_000;
/// Network fetch.
pub const FETCH: u64 = 45_000;
/// Network push (including remote branch delete).
pub const PUSH: u64 = 45_000;
/// Network pull / fast-forward update.
pub const PULL: u64 = 60_000;
/// Clone.
pub const CLONE: u64 = 180_000;
/// Commit diff summary reads.
pub const COMMIT_DIFF_SUMMARY: u64 = 12_000;
/// Commit file diff reads.
pub const COMMIT_FILE_DIFF: u64 = 15_000;
/// Staging metadata reads.
pub const STAGING_META: u64 = 4_000;
/// Staging status reads.
pub const STAGING_STATUS: u64 = 15_000;
/// Staging mutations.
#[cfg(test)]
pub const STAGING_OPERATION: u64 = 60_000;
/// Working-changes summary reads.
pub const WORKING_SUMMARY: u64 = 15_000;
/// Working-changes file diff reads.
pub const WORKING_FILE_DIFF: u64 = 20_000;
/// Working-changes mutations.
#[cfg(test)]
pub const WORKING_OPERATION: u64 = 60_000;
/// Working-changes commit.
#[cfg(test)]
pub const WORKING_COMMIT: u64 = 120_000;
/// Image diff materialisation.
pub const IMAGE: u64 = 15_000;
/// Atomic mutation transactions.
pub const ATOMIC_MUTATION: u64 = 120_000;
/// Content-authority snapshot capture.
pub const CONTENT_AUTHORITY: u64 = 30_000;
/// How long a command waits for the per-repository git lock before giving up.
/// The wait is part of the contract: an unbounded wait let a read queued behind a
/// pull hold the frontend far past its own budget with no attributable error.
pub const GUARD_WAIT: u64 = 30_000;

/// Whole-command ceilings checked at the Tauri command boundary.
pub const SYNC_COMMAND: u64 = 180_000;
pub const REPO_LIST_COMMAND: u64 = 120_000;
/// User build scripts are long-running by design.
pub const BUILD_SCRIPT: u64 = 30 * 60 * 1_000;

/// True when a `run_git_*` error came from the watchdog rather than git itself.
///
/// Callers use this to degrade (keep the data they already have and mark the
/// gap) instead of discarding a partially successful read.
pub fn is_timeout_error(message: &str) -> bool {
    message.contains(TIMEOUT_ERROR_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_only_watchdog_expiry() {
        assert!(is_timeout_error(
            "执行 git 命令超时: git status --porcelain"
        ));
        assert!(!is_timeout_error("fatal: not a git repository"));
        assert!(!is_timeout_error(""));
    }

    #[test]
    fn budgets_are_ordered_by_expected_cost() {
        // Local reads stay below local mutations, which stay below network work.
        assert!(META < STATUS);
        assert!(STATUS <= STAGING_STATUS);
        assert!(META < STAGING_OPERATION);
        assert!(STAGING_STATUS <= DELETE);
        assert!(FETCH <= PULL);
        assert!(PULL <= CLONE);
        assert!(SYNC_COMMAND >= CLONE);
    }
}
