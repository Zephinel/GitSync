use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

// The mutex is the admission linearization point: a restart token and a new
// blocking-operation lease can never be admitted together. Every GitSync flow
// that can write repository state must hold a lease before its first write;
// read-only Git work may overlap restart admission only through the
// GIT_OPTIONAL_LOCKS=0 command contract.
#[derive(Default)]
pub(crate) struct AppRestartGuard {
    inner: Arc<Mutex<GuardState>>,
}

#[derive(Default)]
struct GuardState {
    next_id: u64,
    active_operations: BTreeMap<u64, String>,
    restart_token: Option<u64>,
}

pub(crate) struct AppOperationLease {
    inner: Arc<Mutex<GuardState>>,
    id: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct RestartGuardResult {
    pub acquired: bool,
    pub token: Option<u64>,
    pub blockers: Vec<String>,
}

impl AppRestartGuard {
    pub(crate) fn begin_operation(
        &self,
        description: impl Into<String>,
    ) -> Result<AppOperationLease, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "应用操作状态不可用".to_string())?;
        if state.restart_token.is_some() {
            return Err(
                "GitSync 正在准备安装更新并重新启动，暂不能开始新的 Git 操作。".to_string(),
            );
        }
        state.next_id = state.next_id.wrapping_add(1).max(1);
        let id = state.next_id;
        state.active_operations.insert(id, description.into());
        Ok(AppOperationLease {
            inner: Arc::clone(&self.inner),
            id,
        })
    }

    pub(crate) fn blockers(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|state| state.active_operations.values().cloned().collect())
            .unwrap_or_else(|_| vec!["Git 操作状态暂时不可用".to_string()])
    }

    pub(crate) fn try_acquire_restart(&self) -> RestartGuardResult {
        let Ok(mut state) = self.inner.lock() else {
            return RestartGuardResult {
                acquired: false,
                token: None,
                blockers: vec!["Git 操作状态暂时不可用".to_string()],
            };
        };
        if state.restart_token.is_some() {
            return RestartGuardResult {
                acquired: false,
                token: None,
                blockers: vec!["已有应用更新正在准备安装或重新启动".to_string()],
            };
        }
        if !state.active_operations.is_empty() {
            return RestartGuardResult {
                acquired: false,
                token: None,
                blockers: state.active_operations.values().cloned().collect(),
            };
        }
        state.next_id = state.next_id.wrapping_add(1).max(1);
        let token = state.next_id;
        state.restart_token = Some(token);
        RestartGuardResult {
            acquired: true,
            token: Some(token),
            blockers: Vec::new(),
        }
    }

    pub(crate) fn release_restart(&self, token: u64) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if state.restart_token != Some(token) {
            return false;
        }
        state.restart_token = None;
        true
    }
}

impl Drop for AppOperationLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.lock() {
            state.active_operations.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_git_operation_blocks_restart_until_raii_lease_drops() {
        let guard = AppRestartGuard::default();
        let operation = guard.begin_operation("pull: /repo").unwrap();
        assert_eq!(guard.blockers(), vec!["pull: /repo"]);
        let denied = guard.try_acquire_restart();
        assert!(!denied.acquired);
        assert!(denied.blockers.iter().any(|item| item == "pull: /repo"));
        drop(operation);
        assert!(guard.try_acquire_restart().acquired);
    }

    #[test]
    fn restart_admission_is_atomic_and_rejects_new_git_operations() {
        let guard = AppRestartGuard::default();
        let admitted = guard.try_acquire_restart();
        let token = admitted.token.unwrap();
        assert!(guard.begin_operation("push").is_err());
        assert!(!guard.release_restart(token.wrapping_add(1)));
        assert!(guard.begin_operation("push").is_err());
        assert!(guard.release_restart(token));
        assert!(guard.begin_operation("push").is_ok());
    }

    #[test]
    fn restart_gate_and_active_operations_cannot_overlap() {
        let guard = AppRestartGuard::default();
        let operation = guard.begin_operation("commit").unwrap();
        assert!(!guard.try_acquire_restart().acquired);
        drop(operation);
        let restart = guard.try_acquire_restart();
        assert!(restart.acquired);
        assert!(guard.try_acquire_restart().blockers.len() > 0);
    }
}
