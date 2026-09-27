//! Canonical Git subprocess builders.
//!
//! A Git command used with a repository read guard must not refresh the index's
//! cached stat data. Read-only builders enforce that with `GIT_OPTIONAL_LOCKS=0`.
//! Mutating builders deliberately remove that override so Git can take the locks
//! required by repository mutations. Mutation means any command that may write
//! Git repository state, not only the working tree: this includes object database
//! writes (`hash-object -w`, `write-tree`, `commit-tree`), index writes (`read-tree`,
//! `update-index`, `apply --cached` / `--index`), refs, config, `FETCH_HEAD`, and
//! GitSync's persistent mutation evidence.
//! In particular, `git fetch` mutates remote-tracking refs and `FETCH_HEAD` even
//! when it does not change the working tree.

use std::ffi::OsStr;
use std::process::Command as StdCommand;
use tokio::process::Command as TokioCommand;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn configure(command: &mut StdCommand, read_only: bool) {
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never");

    if read_only {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    } else {
        command.env_remove("GIT_OPTIONAL_LOCKS");
    }

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
}

pub(crate) fn new_read_only_command<I, S>(repo_path: &str, args: I) -> StdCommand
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = StdCommand::new("git");
    command.current_dir(repo_path).args(args);
    configure(&mut command, true);
    command
}

pub(crate) fn new_mutation_command<I, S>(repo_path: &str, args: I) -> StdCommand
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = StdCommand::new("git");
    command.current_dir(repo_path).args(args);
    configure(&mut command, false);
    command
}

pub(crate) fn new_read_only_async_command<I, S>(repo_path: &str, args: I) -> TokioCommand
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = TokioCommand::new("git");
    command.current_dir(repo_path).args(args);
    configure(command.as_std_mut(), true);
    command
}

pub(crate) fn new_mutation_async_command<I, S>(repo_path: &str, args: I) -> TokioCommand
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = TokioCommand::new("git");
    command.current_dir(repo_path).args(args);
    configure(command.as_std_mut(), false);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Stdio;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn env_action(command: &StdCommand, key: &OsStr) -> Option<Option<std::ffi::OsString>> {
        command
            .get_envs()
            .find_map(|(name, value)| (name == key).then(|| value.map(OsStr::to_os_string)))
    }

    #[test]
    fn read_only_and_mutation_builders_have_distinct_lock_contracts() {
        let read = new_read_only_command(".", ["status", "--porcelain"]);
        assert_eq!(
            env_action(&read, OsStr::new("GIT_OPTIONAL_LOCKS")),
            Some(Some("0".into()))
        );
        assert_eq!(
            env_action(&read, OsStr::new("GIT_TERMINAL_PROMPT")),
            Some(Some("0".into()))
        );
        assert_eq!(
            env_action(&read, OsStr::new("GCM_INTERACTIVE")),
            Some(Some("Never".into()))
        );

        let mutation = new_mutation_command(".", ["fetch", "--all"]);
        assert_eq!(
            env_action(&mutation, OsStr::new("GIT_OPTIONAL_LOCKS")),
            Some(None),
            "mutation builders must remove an inherited read-only override"
        );
        assert_eq!(
            env_action(&mutation, OsStr::new("GIT_TERMINAL_PROMPT")),
            Some(Some("0".into()))
        );
        assert_eq!(
            env_action(&mutation, OsStr::new("GCM_INTERACTIVE")),
            Some(Some("Never".into()))
        );

        let read_async = new_read_only_async_command(".", ["status"]);
        assert_eq!(
            env_action(read_async.as_std(), OsStr::new("GIT_OPTIONAL_LOCKS")),
            Some(Some("0".into()))
        );
        let mutation_async = new_mutation_async_command(".", ["push"]);
        assert_eq!(
            env_action(mutation_async.as_std(), OsStr::new("GIT_OPTIONAL_LOCKS")),
            Some(None)
        );
    }

    fn assert_mutation_runner_precedes(source: &str, marker: &str) {
        let mut checked = 0usize;
        for (index, _) in source.match_indices(marker) {
            let prefix = &source[..index];
            let runner_start = prefix
                .rfind("run_git_")
                .unwrap_or_else(|| panic!("no Git runner precedes {marker:?}"));
            let runner = prefix[runner_start..]
                .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
                .next()
                .unwrap_or_default();
            assert!(
                runner.contains("mutation"),
                "{marker:?} is dispatched through {runner:?}, expected a mutation runner"
            );
            checked += 1;
        }
        assert!(
            checked > 0,
            "did not find mutation callsite marker {marker:?}"
        );
    }

    #[test]
    fn branch_creation_remote_refresh_is_explicitly_guarded_as_mutation() {
        let commands = include_str!("branch_creation/commands_execute.rs");
        let admission = commands
            .split("async fn inspect_repo_branch_creation_in_state")
            .nth(1)
            .expect("remote inspection admission helper");
        let acquire = admission
            .find("acquire_remote_refresh_guard(state, path)")
            .expect("mutation guard before remote refresh");
        let refresh = admission
            .find("inspect_with_remote_refresh_locked(path, source)")
            .expect("explicit remote-refresh inspection");
        assert!(acquire < refresh, "fetch must follow mutation admission");

        let source = include_str!("branch_creation/source.rs");
        let pure_inspection = source
            .split("async fn inspect_with_remote_refresh_locked")
            .next()
            .expect("pure inspection definition");
        assert!(!pure_inspection.contains("fetch_remote("));
        let refresh_inspection = source
            .split("async fn inspect_with_remote_refresh_locked")
            .nth(1)
            .expect("remote refresh definition");
        assert!(refresh_inspection.contains("fetch_remote(repo_path, remote).await?"));
        assert!(refresh_inspection
            .contains("fetch_remote_branch(repo_path, remote, branch.as_str()).await?"));

        let git = include_str!("branch_creation/git.rs");
        assert_mutation_runner_precedes(git, "[\"fetch\", \"--prune\", \"--no-tags\", remote]");
        assert!(git.contains("new_mutation_async_command(repo_path, args)"));
    }

    #[test]
    fn guarded_dashboard_status_uses_the_read_only_runner() {
        let commands = include_str!("commands.rs");
        let status = commands
            .split("async fn get_repo_status_inner")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn refresh_repo_remote").next())
            .expect("dashboard status function");
        assert!(status.contains("acquire_repo_git_read_guard"));
        assert!(status.contains("run_git_read_only_async_with_timeout"));

        let staging = include_str!("staging.rs");
        assert!(staging.contains("new_read_only_async_command(repo_path, args)"));

        let metadata = commands
            .split("async fn refresh_repos_git_metadata_concurrently")
            .nth(1)
            .and_then(|tail| tail.split("fn apply_repo_git_metadata").next())
            .expect("get_repos metadata fan-out");
        assert!(metadata.contains("acquire_read_from_lock(repo_lock).await"));
    }

    #[test]
    fn audited_read_modules_use_canonical_read_only_builders() {
        let modules = [
            ("commands.rs", include_str!("commands.rs")),
            (
                "branch_creation/git.rs",
                include_str!("branch_creation/git.rs"),
            ),
            ("branch_management.rs", include_str!("branch_management.rs")),
            ("branch_delete.rs", include_str!("branch_delete.rs")),
            ("staging.rs", include_str!("staging.rs")),
            ("working_changes.rs", include_str!("working_changes.rs")),
            ("commit_diff.rs", include_str!("commit_diff.rs")),
            ("image_diff.rs", include_str!("image_diff.rs")),
            ("ai/snapshot.rs", include_str!("ai/snapshot.rs")),
            (
                "ai/branch_name_request.rs",
                include_str!("ai/branch_name_request.rs"),
            ),
            (
                "git_content_authority.rs",
                include_str!("git_content_authority.rs"),
            ),
            ("stash/git.rs", include_str!("stash/git.rs")),
        ];
        for (name, source) in modules {
            assert!(
                source.contains("new_read_only_"),
                "{name} must dispatch read commands through the canonical builder"
            );
        }
    }

    #[test]
    fn critical_repository_mutations_use_mutation_runners() {
        let commands = include_str!("commands.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production commands source");
        for marker in [
            "&[\"checkout\", \"--ours\", file_path]",
            "&[\"checkout\", \"--theirs\", file_path]",
            "&[\"commit\", \"-m\", &msg]",
            "&[\"fetch\", \"--all\", \"--prune\"]",
            "&[\"switch\", \"--track\",",
            "&[\"switch\", target_branch]",
            "&[\"stash\", \"push\",",
            "&[\"stash\", \"pop\"]",
            "&[\"branch\", \"--unset-upstream\", target_branch]",
        ] {
            assert_mutation_runner_precedes(commands, marker);
        }

        let branch_management = include_str!("branch_management.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production branch management source");
        for marker in [
            "&[\"fetch\", \"--all\", \"--prune\"]",
            "&[\"push\", remote, refspec.as_str()]",
            "&[\"merge\", \"--ff-only\", upstream.as_str()]",
            "\"update-ref\",",
        ] {
            assert_mutation_runner_precedes(branch_management, marker);
        }

        let branch_delete = include_str!("branch_delete.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production branch delete source");
        for marker in [
            "&[\"branch\", delete_flag, \"--\", target_branch]",
            "&[\"push\", remote.as_str(), \"--delete\",",
        ] {
            assert_mutation_runner_precedes(branch_delete, marker);
        }

        let branch_creation_mutations = include_str!("branch_creation/operation_mutation.rs");
        let branch_creation_git = include_str!("branch_creation/git.rs");
        assert!(branch_creation_git.contains("async fn run_git_mutation_output"));
        assert!(branch_creation_git.contains("new_mutation_async_command(repo_path, args)"));
        for marker in [
            "&[\"switch\", \"--\", branch_name]",
            "&[\"push\", \"--porcelain\", remote, refspec.as_str()]",
        ] {
            assert_mutation_runner_precedes(branch_creation_mutations, marker);
        }

        let atomic_mutation = include_str!("git_atomic_mutation_base.rs");
        assert!(atomic_mutation.contains("new_mutation_async_command(repo_path, args)"));
        let stash = include_str!("stash/git.rs");
        assert!(stash.contains("new_mutation_async_command(repo_path, args)"));
    }

    #[test]
    fn content_snapshot_persistence_uses_mutation_runner_and_plain_hash_stays_read_only() {
        let worktree = include_str!("git_content_authority_snapshot_worktree.rs");
        let hash_snapshot = worktree
            .split("async fn hash_snapshot_file")
            .nth(1)
            .and_then(|tail| tail.split("\n}\n").next())
            .expect("snapshot hash function");
        assert!(hash_snapshot.contains("\"hash-object\""));
        assert!(hash_snapshot.contains("\"-w\""));
        assert!(hash_snapshot.contains("run_git_mutation_bytes(repo_path, &args).await?"));
        assert!(!hash_snapshot.contains("run_git_bytes("));

        let authority = include_str!("git_content_authority.rs");
        let mutation_runner = authority
            .split("async fn run_git_mutation_bytes")
            .nth(1)
            .and_then(|tail| tail.split("\n}\n").next())
            .expect("content-authority mutation runner");
        assert!(mutation_runner.contains("new_git_mutation_command(repo_path, args)"));
        let mutation_builder = authority
            .split("fn new_git_mutation_command")
            .nth(1)
            .expect("content-authority mutation builder");
        assert!(mutation_builder.contains("new_mutation_async_command(repo_path, args)"));

        let read_runner = authority
            .split("async fn run_git_bytes")
            .nth(1)
            .and_then(|tail| tail.split("\n}\n").next())
            .expect("content-authority read runner");
        assert!(read_runner.contains("new_git_read_command(repo_path, args)"));
        let read_builder = authority
            .split("fn new_git_read_command")
            .nth(1)
            .expect("content-authority read builder");
        assert!(read_builder.contains("new_read_only_async_command(repo_path, args)"));

        let plain_hash = authority
            .split("async fn collect_worktree_content_ids")
            .nth(1)
            .and_then(|tail| {
                tail.split("pub async fn collect_mutation_content_ids")
                    .next()
            })
            .expect("plain content identity hash function");
        assert!(plain_hash.contains("\"hash-object\""));
        assert!(plain_hash.contains("\"--no-filters\""));
        assert!(plain_hash.contains("run_git_bytes(repo_path, &args).await?"));
        assert!(!plain_hash.contains("run_git_mutation_bytes("));
    }

    #[test]
    fn mutation_snapshot_object_writes_remain_inside_restart_blocking_entrypoints() {
        let staging = include_str!("staging_authority_operation_part1.rs");
        let stage_operation = staging
            .split("pub async fn run_staging_operation_authoritative")
            .nth(1)
            .expect("authoritative stage/unstage operation");
        let stage_guard = stage_operation
            .find("acquire_repo_git_guard(&state, &repo_path).await?")
            .expect("stage operation restart-blocking guard");
        for marker in [
            "crate::git_atomic_mutation::stage_verified_entry(",
            "crate::git_atomic_mutation::unstage_verified_entry_ref_guarded(",
        ] {
            assert!(
                stage_guard
                    < stage_operation
                        .find(marker)
                        .expect("stage/unstage mutation entry"),
                "{marker} must follow the restart-blocking guard"
            );
        }

        let working = include_str!("working_changes_authority_operations.rs");
        for (function, mutation) in [
            (
                "pub async fn discard_repo_working_files_authoritative",
                "crate::git_atomic_mutation::discard_verified_entry_ref_guarded(",
            ),
            (
                "pub async fn discard_repo_working_files_unstaged_authoritative",
                "crate::git_atomic_mutation::discard_worktree_verified_entry_ref_guarded(",
            ),
            (
                "pub async fn commit_repo_working_files_authoritative",
                "crate::git_atomic_mutation::commit_verified_entries_ref_guarded(",
            ),
        ] {
            let body = working
                .split(function)
                .nth(1)
                .and_then(|tail| tail.split("\npub async fn ").next())
                .expect("working-changes mutation entrypoint");
            let guard = body
                .find("acquire_repo_git_guard(&state, &repo_path).await?")
                .expect("working-changes restart-blocking guard");
            let mutation = body.find(mutation).expect("atomic mutation call");
            assert!(guard < mutation, "{function} must guard before mutation");
        }

        let atomic_index = include_str!("git_atomic_mutation_index.rs");
        let capture = atomic_index
            .split("async fn capture_expected_snapshots")
            .nth(1)
            .and_then(|tail| tail.split("\n}").next())
            .expect("atomic snapshot capture helper");
        assert!(capture.contains("capture_mutation_entry_snapshots(repo_path, &requested).await?"));

        for function in [
            "async fn stage_verified_entry_inner",
            "async fn unstage_verified_entry_inner",
        ] {
            let body = atomic_index
                .split(function)
                .nth(1)
                .and_then(|tail| tail.split("\n}").next())
                .expect("stage/unstage atomic mutation implementation");
            assert!(body.contains("capture_expected_snapshots("));
        }

        let discard = include_str!("git_atomic_mutation_discard.rs");
        for function in [
            "async fn discard_verified_entry_inner",
            "async fn discard_worktree_verified_entry_inner",
        ] {
            let body = discard
                .split(function)
                .nth(1)
                .and_then(|tail| tail.split("\n}").next())
                .expect("discard atomic mutation implementation");
            assert!(body.contains("capture_expected_snapshots("));
        }

        let commit = include_str!("git_atomic_mutation_commit_ref_guarded.rs");
        assert!(commit.contains("capture_expected_snapshots(repo_path, entries).await?"));
    }

    #[cfg(unix)]
    #[test]
    fn read_only_status_does_not_rewrite_index_stat_cache() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "gitsync-read-only-status-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();

        let setup = |args: &[&str]| {
            let output = StdCommand::new("git")
                .current_dir(&root)
                .args(args)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        setup(&["init", "--quiet"]);
        setup(&["config", "user.name", "GitSync Test"]);
        setup(&["config", "user.email", "gitsync-test@example.invalid"]);
        fs::write(root.join("tracked.txt"), "tracked\n").unwrap();
        setup(&["add", "--", "tracked.txt"]);
        setup(&["commit", "--quiet", "-m", "initial"]);

        let index_path = root.join(".git").join("index");
        let index_before = fs::read(&index_path).unwrap();
        let file = fs::OpenOptions::new()
            .write(true)
            .open(root.join("tracked.txt"))
            .unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(120))
            .unwrap();
        drop(file);

        let output =
            new_read_only_command(root.to_string_lossy().as_ref(), ["status", "--porcelain"])
                .stdin(Stdio::null())
                .output()
                .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).trim().is_empty());
        assert_eq!(fs::read(&index_path).unwrap(), index_before);

        let _ = fs::remove_dir_all(root);
    }
}
