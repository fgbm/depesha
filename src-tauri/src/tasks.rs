//! Background work the user can see and steer: syncing, downloading mail for
//! offline reading, loading older mail, server search, sending. Each task has a
//! key (`sync:<account>`): the same work updates its task instead of adding one.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;

use crate::error::CmdError;
use crate::state::AppState;

/// Failed tasks kept for the user to see; the oldest go first.
const KEEP_FAILED: usize = 20;

#[derive(Default)]
pub struct Tasks {
    list: Mutex<BTreeMap<String, Task>>,
    /// When each account last finished a full sync, Unix time.
    synced: Mutex<HashMap<String, i64>>,
    /// Accounts whose offline download the user paused (until the app restarts).
    paused: Mutex<HashSet<String>>,
    /// Folder size counts under way, by account: `None` while one is claimed but its task
    /// has not been spawned yet, `Some` once its handle is kept, to be stopped.
    counts: Mutex<HashMap<String, Option<tokio::task::AbortHandle>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub key: String,
    /// `sync`, `prefetch`, `older`, `search`, `send`, `sizes`.
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub label: String,
    pub done: u64,
    /// 0 when unknown.
    pub total: u64,
    /// `running` or `failed`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CmdError>,
    pub started: i64,
}

/// What the tasks window shows about an account besides its tasks.
#[derive(Debug, Clone, Serialize)]
pub struct AccountSync {
    pub account_id: String,
    pub last_sync: Option<i64>,
    /// Messages in the offline window with their text downloaded, and all of them.
    pub offline_done: u64,
    pub offline_total: u64,
    pub paused: bool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    /// Starts the task under `key` or updates it; a failed one starts again.
    pub fn task(&self, key: &str, kind: &'static str, account_id: Option<&str>, label: String, done: u64, total: u64) {
        {
            let mut list = lock(&self.tasks.list);
            let started = list
                .get(key)
                .filter(|t| t.state == "running")
                .map(|t| t.started)
                .unwrap_or_else(|| chrono::Utc::now().timestamp());
            list.insert(
                key.to_owned(),
                Task {
                    key: key.to_owned(),
                    kind,
                    account_id: account_id.map(str::to_owned),
                    label,
                    done,
                    total,
                    state: "running",
                    error: None,
                    started,
                },
            );
        }
        self.emit_tasks();
    }

    /// The task ended well: it leaves the list.
    pub fn task_done(&self, key: &str) {
        if lock(&self.tasks.list).remove(key).is_some() {
            self.emit_tasks();
        }
    }

    /// The task failed: it stays in the list with the error until it runs again or is dismissed.
    pub fn task_failed(&self, key: &str, error: CmdError) {
        {
            let mut list = lock(&self.tasks.list);
            let Some(t) = list.get_mut(key) else {
                return;
            };
            t.state = "failed";
            t.error = Some(error);
            let failed: Vec<(i64, String)> = list
                .values()
                .filter(|t| t.state == "failed")
                .map(|t| (t.started, t.key.clone()))
                .collect();
            if failed.len() > KEEP_FAILED {
                let mut failed = failed;
                failed.sort();
                for (_, k) in failed.iter().take(failed.len() - KEEP_FAILED) {
                    list.remove(k);
                }
            }
        }
        self.emit_tasks();
    }

    pub fn task_dismiss(&self, key: &str) {
        let removed = {
            let mut list = lock(&self.tasks.list);
            match list.get(key) {
                Some(t) if t.state == "failed" => list.remove(key).is_some(),
                _ => false,
            }
        };
        if removed {
            self.emit_tasks();
        }
    }

    pub fn tasks_list(&self) -> Vec<Task> {
        let mut tasks: Vec<Task> = lock(&self.tasks.list).values().cloned().collect();
        tasks.sort_by_key(|t| t.started);
        tasks
    }

    fn emit_tasks(&self) {
        self.emit("tasks-changed", json!(self.tasks_list()));
    }

    /// Drops the tasks of a removed account.
    pub fn tasks_forget_account(&self, account_id: &str) {
        lock(&self.tasks.list).retain(|_, t| t.account_id.as_deref() != Some(account_id));
        lock(&self.tasks.synced).remove(account_id);
        lock(&self.tasks.paused).remove(account_id);
        if let Some(count) = lock(&self.tasks.counts).remove(account_id).flatten() {
            count.abort();
        }
        self.emit_tasks();
    }

    /// How far a running task is: done and total.
    pub fn task_progress(&self, key: &str) -> Option<(u64, u64)> {
        lock(&self.tasks.list)
            .get(key)
            .filter(|t| t.state == "running")
            .map(|t| (t.done, t.total))
    }

    /// Claims the account's count before its task is spawned, so a second "Count" cannot
    /// start and a stop in the meantime is not lost. False when one is already under way.
    pub fn begin_count(&self, account_id: &str) -> bool {
        lock(&self.tasks.counts).insert(account_id.to_owned(), None).is_none()
    }

    /// Gives up a claim whose task was never spawned (the window is gone, the connect failed).
    pub fn abandon_count(&self, account_id: &str) {
        lock(&self.tasks.counts).remove(account_id);
    }

    /// Keeps the running task's handle. False when a stop came first: the task must not run.
    pub fn keep_count(&self, account_id: &str, handle: tokio::task::AbortHandle) -> bool {
        let mut counts = lock(&self.tasks.counts);
        match counts.get_mut(account_id) {
            Some(slot) => {
                *slot = Some(handle);
                true
            }
            None => false,
        }
    }

    /// Takes the account's count out: the caller aborts the handle, if there is one.
    pub fn forget_count(&self, account_id: &str) -> Option<tokio::task::AbortHandle> {
        lock(&self.tasks.counts).remove(account_id).flatten()
    }

    pub fn mark_synced(&self, account_id: &str) {
        lock(&self.tasks.synced).insert(account_id.to_owned(), chrono::Utc::now().timestamp());
    }

    pub fn last_sync(&self, account_id: &str) -> Option<i64> {
        lock(&self.tasks.synced).get(account_id).copied()
    }

    pub fn prefetch_paused(&self, account_id: &str) -> bool {
        lock(&self.tasks.paused).contains(account_id)
    }

    pub fn set_prefetch_paused(&self, account_id: &str, paused: bool) {
        let mut set = lock(&self.tasks.paused);
        if paused {
            set.insert(account_id.to_owned());
        } else {
            set.remove(account_id);
        }
    }
}
