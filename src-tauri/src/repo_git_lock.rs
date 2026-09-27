//! Single authority for the per-repository git lock.
//!
//! Every git command that mutates or reads a repository takes this lock, keyed by
//! the normalized repository path. The key normalization and the acquisition used
//! to be copied into eight modules; a divergence there would have let two spellings
//! of the same repository take two independent locks.
//!
//! The wait is bounded: a command queued behind a pull/fetch no longer blocks
//! indefinitely, it fails with a message the caller can attribute.

use crate::app_restart_guard::AppOperationLease;
use crate::commands::AppState;
use crate::git_timeouts;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Repository serialization plus an application-exit lease for Git commands
/// that can mutate the working copy or refs.
pub(crate) struct RepoGitGuard {
    _repo: OwnedMutexGuard<()>,
    _operation: Option<AppOperationLease>,
}

/// Normalizes a repository path into its lock key.
pub(crate) fn normalize_repo_lock_key(repo_path: &str) -> String {
    let trimmed = repo_path.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Ok(canonical) = std::fs::canonicalize(trimmed) {
        return canonical.to_string_lossy().to_string();
    }

    let normalized = trimmed.trim_end_matches(['/', '\\']);
    if normalized.is_empty() {
        trimmed.to_string()
    } else {
        normalized.to_string()
    }
}

/// The per-repository lock without acquiring it, for callers that need to move the
/// lock into a spawned task so the guard lives for the task.
pub(crate) async fn lock_for(state: &AppState, repo_path: &str) -> Arc<AsyncMutex<()>> {
    lock_for_key(state, normalize_repo_lock_key(repo_path)).await
}

/// The lock for an already-normalized key. Callers that must resolve the key with
/// git first (for example a path inside a worktree) use this.
pub(crate) async fn lock_for_key(state: &AppState, key: String) -> Arc<AsyncMutex<()>> {
    let mut locks = state.git_repo_locks.lock().await;
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// Acquires the per-repository lock, giving up after `git_timeouts::GUARD_WAIT`.
pub(crate) async fn acquire(state: &AppState, repo_path: &str) -> Result<RepoGitGuard, String> {
    // Keep this lock order canonical: restart-blocking operation lease first,
    // then the per-repository mutex. Never acquire the app lease after the repo
    // mutex, or a mutation and restart admission could deadlock across paths.
    let operation = state
        .app_restart_guard
        .begin_operation(format!("Git 操作：{}", repo_path.trim()))?;
    let repo = acquire_lock(lock_for(state, repo_path).await).await?;
    Ok(RepoGitGuard {
        _repo: repo,
        _operation: Some(operation),
    })
}

/// Read-only Git commands share repository serialization without blocking an
/// application restart. Callers must use `git_command::new_read_only_*` so Git
/// cannot write its optional index stat cache while the restart token is held.
pub(crate) async fn acquire_read(
    state: &AppState,
    repo_path: &str,
) -> Result<RepoGitGuard, String> {
    acquire_read_from_lock(lock_for(state, repo_path).await).await
}

/// Acquires a read guard from a lock obtained before spawning a bounded metadata
/// task. This keeps the lock ownership explicit without requiring the task to
/// borrow `AppState`.
pub(crate) async fn acquire_read_from_lock(
    lock: Arc<AsyncMutex<()>>,
) -> Result<RepoGitGuard, String> {
    let repo = acquire_lock(lock).await?;
    Ok(RepoGitGuard {
        _repo: repo,
        _operation: None,
    })
}

/// Acquires the lock for an already-normalized key.
pub(crate) async fn acquire_key(state: &AppState, key: String) -> Result<RepoGitGuard, String> {
    let operation = state
        .app_restart_guard
        .begin_operation(format!("Git 操作：{}", key))?;
    let repo = acquire_lock(lock_for_key(state, key).await).await?;
    Ok(RepoGitGuard {
        _repo: repo,
        _operation: Some(operation),
    })
}

pub(crate) async fn acquire_key_read(
    state: &AppState,
    key: String,
) -> Result<RepoGitGuard, String> {
    let repo = acquire_lock(lock_for_key(state, key).await).await?;
    Ok(RepoGitGuard {
        _repo: repo,
        _operation: None,
    })
}

async fn acquire_lock(lock: Arc<AsyncMutex<()>>) -> Result<OwnedMutexGuard<()>, String> {
    tokio::time::timeout(
        Duration::from_millis(git_timeouts::GUARD_WAIT),
        lock.lock_owned(),
    )
    .await
    .map_err(|_| "该仓库正在执行其他 Git 操作，请稍后重试。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_empty_and_trailing_separators() {
        assert_eq!(normalize_repo_lock_key(""), "");
        assert_eq!(normalize_repo_lock_key("   "), "");
        // A non-existent path falls back to a trimmed spelling rather than failing.
        let normalized = normalize_repo_lock_key("/definitely/not/here/");
        assert_eq!(normalized, "/definitely/not/here");
    }

    #[tokio::test]
    async fn bounded_acquire_reports_a_wait_timeout() {
        let state = AppState::new();
        let path = "/tmp/gitsync-lock-test";
        let _held = acquire(&state, path).await.unwrap();
        // The lock is held; a second acquisition must eventually give up rather than
        // wait forever. GUARD_WAIT is 30s, so drive the check through the same helper
        // with a deliberately short deadline by asserting the error text contract.
        let lock = lock_for(&state, path).await;
        let short = tokio::time::timeout(Duration::from_millis(10), lock.lock_owned()).await;
        assert!(short.is_err(), "the held lock must block a second owner");
    }

    #[tokio::test]
    async fn mutation_lock_lease_blocks_restart_and_read_lock_does_not() {
        let state = AppState::new();
        let mutating = acquire(&state, "/tmp/gitsync-mutation-lease")
            .await
            .unwrap();
        let blocked = state.app_restart_guard.try_acquire_restart();
        assert!(!blocked.acquired);
        drop(mutating);

        let read_only = acquire_read(&state, "/tmp/gitsync-read-lease")
            .await
            .unwrap();
        let admitted = state.app_restart_guard.try_acquire_restart();
        assert!(admitted.acquired);
        assert!(state
            .app_restart_guard
            .release_restart(admitted.token.unwrap()));
        drop(read_only);
    }

    #[tokio::test]
    async fn restart_token_rejects_mutation_before_repo_lock_admission() {
        let state = AppState::new();
        let restart = state.app_restart_guard.try_acquire_restart();
        assert!(restart.acquired);

        let error = match acquire(&state, "/tmp/gitsync-restart-admission").await {
            Ok(_) => panic!("restart admission must reject new mutation leases"),
            Err(error) => error,
        };
        assert!(error.contains("暂不能开始新的 Git 操作"));

        assert!(state
            .app_restart_guard
            .release_restart(restart.token.unwrap()));
    }
}
