//! Background work the user can see and steer: syncing, downloading mail for
//! offline reading, loading older mail, server search, sending. Each task has a
//! key (`sync:<account>`): the same work updates its task instead of adding one.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;

use crate::error::CmdError;
use crate::state::{AppState, lock};

/// Failed tasks kept for the user to see; the oldest go first.
const KEEP_FAILED: usize = 20;

#[derive(Default)]
pub struct Tasks {
    list: Mutex<BTreeMap<String, Task>>,
    /// When each account last finished a full sync, Unix time.
    synced: Mutex<HashMap<String, i64>>,
    /// Accounts whose offline download the user paused (until the app restarts).
    paused: Mutex<HashSet<String>>,
    /// Folder size counts under way, by account.
    counts: Mutex<Counts>,
    /// Tasks the user asked to stop (the «Stop» of a folder clearing, #74), by key; the
    /// work looks at it between its batches.
    stops: Mutex<HashSet<String>>,
}

/// Folder size counts by account, each with its generation: the tail of a stopped count
/// (abort does not cut synchronous code short) must not end the count started after it.
#[derive(Default)]
struct Counts {
    next: u64,
    /// The handle is `None` while a count is claimed but its task has not been spawned
    /// yet, `Some` once it is kept, to be stopped.
    by_account: HashMap<String, (u64, Option<tokio::task::AbortHandle>)>,
}

impl Counts {
    fn begin(&mut self, account_id: &str) -> Option<u64> {
        if self.by_account.contains_key(account_id) {
            return None;
        }
        self.next += 1;
        self.by_account.insert(account_id.to_owned(), (self.next, None));
        Some(self.next)
    }

    /// The account's count is the one of `generation`; `None`: there is none.
    fn is(&self, account_id: &str, generation: Option<u64>) -> bool {
        self.by_account.get(account_id).map(|c| c.0) == generation
    }

    fn keep(&mut self, account_id: &str, generation: u64, handle: tokio::task::AbortHandle) -> bool {
        match self.by_account.get_mut(account_id) {
            Some(count) if count.0 == generation => {
                count.1 = Some(handle);
                true
            }
            _ => false,
        }
    }

    /// Removes the count of `generation`; false when it was stopped or replaced.
    fn end(&mut self, account_id: &str, generation: u64) -> bool {
        let ours = self.is(account_id, Some(generation));
        if ours {
            self.by_account.remove(account_id);
        }
        ours
    }

    /// Removes whatever count the account has: the caller aborts the handle, if there is one.
    fn stop(&mut self, account_id: &str) -> Option<tokio::task::AbortHandle> {
        self.by_account.remove(account_id).and_then(|c| c.1)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub key: String,
    /// `sync`, `prefetch`, `older`, `search`, `send`, `sizes`, `empty`.
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

impl Tasks {
    /// Remembers a stop for a running task; a task that is not running (done, failed, or
    /// never there) has nothing to stop, and the request must not outlive it.
    fn request_stop(&self, key: &str) {
        if lock(&self.list).get(key).is_some_and(|t| t.state == "running") {
            lock(&self.stops).insert(key.to_owned());
        }
    }
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
        if let Some(count) = lock(&self.tasks.counts).stop(account_id) {
            count.abort();
        }
        self.emit_tasks();
    }

    /// The user pressed «Stop» on the task: its work ends after the batch it is in.
    pub fn task_stop(&self, key: &str) {
        self.tasks.request_stop(key);
    }

    pub fn task_stop_requested(&self, key: &str) -> bool {
        lock(&self.tasks.stops).contains(key)
    }

    /// Forgets a stop request: before a run starts (a stale one must not cancel it) and when it ends.
    pub fn task_stop_clear(&self, key: &str) {
        lock(&self.tasks.stops).remove(key);
    }

    /// How far a running task is: done and total.
    pub fn task_progress(&self, key: &str) -> Option<(u64, u64)> {
        lock(&self.tasks.list)
            .get(key)
            .filter(|t| t.state == "running")
            .map(|t| (t.done, t.total))
    }

    /// Claims the account's count before its task is spawned, so a second "Count" cannot
    /// start and a stop in the meantime is not lost. `None` when one is already under way;
    /// otherwise the count's generation, for the calls below.
    pub fn begin_count(&self, account_id: &str) -> Option<u64> {
        lock(&self.tasks.counts).begin(account_id)
    }

    /// Gives up a claim whose task was never spawned (the window is gone, the connect failed).
    pub fn abandon_count(&self, account_id: &str, generation: u64) {
        lock(&self.tasks.counts).end(account_id, generation);
    }

    /// Keeps the running task's handle. False when a stop came first: the task must not run.
    pub fn keep_count(&self, account_id: &str, generation: u64, handle: tokio::task::AbortHandle) -> bool {
        lock(&self.tasks.counts).keep(account_id, generation, handle)
    }

    /// Runs `f` while the account's count is the one of `generation` (`None`: there is no
    /// count), so that a stop or a new count cannot come in between; false when it is not.
    pub fn while_count(&self, account_id: &str, generation: Option<u64>, f: impl FnOnce()) -> bool {
        let counts = lock(&self.tasks.counts);
        let ours = counts.is(account_id, generation);
        if ours {
            f();
        }
        ours
    }

    /// Ends the count of `generation` after running `f`, unless it was stopped or replaced.
    pub fn end_count(&self, account_id: &str, generation: u64, f: impl FnOnce()) {
        let mut counts = lock(&self.tasks.counts);
        if counts.is(account_id, Some(generation)) {
            f();
            counts.end(account_id, generation);
        }
    }

    /// Stops the account's count, if any, and runs `f` before another can begin.
    pub fn stop_count(&self, account_id: &str, f: impl FnOnce()) {
        let mut counts = lock(&self.tasks.counts);
        if let Some(handle) = counts.stop(account_id) {
            handle.abort();
        }
        f();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_only_reaches_a_running_task() {
        let tasks = Tasks::default();
        let running = |key: &str, state| Task {
            key: key.into(),
            kind: "empty",
            account_id: Some("a".into()),
            label: "x".into(),
            done: 0,
            total: 10,
            state,
            error: None,
            started: 0,
        };
        lock(&tasks.list).insert("empty:a:Trash".into(), running("empty:a:Trash", "running"));
        lock(&tasks.list).insert("empty:a:Spam".into(), running("empty:a:Spam", "failed"));
        tasks.request_stop("empty:a:Trash");
        tasks.request_stop("empty:a:Spam");
        tasks.request_stop("empty:a:Drafts");
        let stops = lock(&tasks.stops);
        assert_eq!(stops.iter().collect::<Vec<_>>(), ["empty:a:Trash"]);
    }

    #[tokio::test]
    async fn a_stopped_counts_tail_leaves_the_next_count_alone() {
        let handle = || tokio::spawn(async {}).abort_handle();
        let mut counts = Counts::default();
        let a = counts.begin("acc").unwrap();
        assert_eq!(counts.begin("acc"), None, "one count per account");
        assert!(counts.keep("acc", a, handle()));
        assert!(counts.stop("acc").is_some());
        assert!(counts.is("acc", None));
        // "Count" again right after "Stop": a new generation.
        let b = counts.begin("acc").unwrap();
        assert_ne!(a, b);
        // The first task's tail neither keeps its handle nor ends the new count.
        assert!(!counts.keep("acc", a, handle()));
        assert!(!counts.end("acc", a));
        assert!(counts.is("acc", Some(b)));
        assert!(counts.end("acc", b));
        assert!(counts.is("acc", None));
    }
}
