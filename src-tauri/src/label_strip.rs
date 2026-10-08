//! Taking a label off every letter of the mailbox (#42, frame 4Б), one folder per work in
//! the mailbox's quiet queue: a whole-account walk is not one queue item that holds the
//! mailbox for minutes, a folder without rights is skipped and remembered, and the label
//! stays in the list as "being removed" until every folder is done — so a restart or a
//! pause resumes the debt instead of losing it.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::json;

use depesha_core::lang::pick;

use crate::error::CmdError;
use crate::state::AppState;
use crate::worker::{Output, Work};

/// Labels whose strip is running, by `(account, name)`: the same debt is not started twice
/// by two rounds, or by a round and a command.
fn running() -> &'static Mutex<HashSet<(String, String)>> {
    static RUNNING: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// Starts the strip of every label marked as being removed, of every account; one already
/// running is left alone. Called at startup and on each scheduler round, so a debt left by
/// a restart or a pause is picked up rather than lost.
pub fn resume_all(state: &Arc<AppState>) {
    for account in state.accounts() {
        let Ok(labels) = state.store.stripping_labels(&account.id) else {
            continue;
        };
        for (name, keyword) in labels {
            start(state, &account.id, &name, &keyword);
        }
    }
}

/// Starts the strip of one label unless it is running already.
pub fn start(state: &Arc<AppState>, account_id: &str, name: &str, keyword: &str) {
    let key = (account_id.to_owned(), name.to_owned());
    if !running().lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone()) {
        return;
    }
    let state = state.clone();
    let (account_id, name, keyword) = (account_id.to_owned(), name.to_owned(), keyword.to_owned());
    tauri::async_runtime::spawn(async move {
        run(state, &account_id, &name, &keyword).await;
        running().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
    });
}

/// Takes the keyword off every folder of the mailbox, one work per folder, and reports the
/// outcome in the tasks window. A pause or an offline mailbox keeps the debt for the next
/// round; a folder without rights is skipped and named, the rest is cleaned, and the label
/// then leaves the list.
async fn run(state: Arc<AppState>, account_id: &str, name: &str, keyword: &str) {
    let task = format!("labels:{account_id}");
    let label = pick("Taking the label off all letters", "Снятие метки со всех писем");
    let folders: Vec<String> = state
        .store
        .folders(Some(account_id))
        .unwrap_or_default()
        .into_iter()
        .filter(|f| f.folder.selectable)
        .map(|f| f.folder.name)
        .collect();
    let total = folders.len() as u64;
    state.task(&task, "labels", Some(account_id), label.to_owned(), 0, total);
    let mut count = 0usize;
    let mut retry = false;
    let mut skipped: Vec<String> = Vec::new();
    let mut done = 0u64;
    for folder in &folders {
        let Ok(worker) = state.worker(account_id) else {
            retry = true;
            break;
        };
        match worker
            .run_background(Work::StripLabel {
                folder: folder.clone(),
                keyword: keyword.to_owned(),
            })
            .await
        {
            Ok(Output::Count(n)) => count += n,
            Ok(_) => {}
            // A pause, an offline mailbox, a busy server, a locked folder: try again later,
            // and keep the debt so the label is not removed with its keyword still on.
            Err(e) if e.retry_later() => retry = true,
            // No rights or a refusal: skip the folder and remember it; the rest is cleaned.
            Err(e) => skipped.push(format!("{folder}: {}", CmdError::from(e).message)),
        }
        done += 1;
        state.task(&task, "labels", Some(account_id), label.to_owned(), done, total);
    }
    if !retry {
        // The server is done with it: the cache follows and the label leaves the list.
        let _ = state.store.drop_keyword(account_id, keyword);
        let _ = state.store.remove_label(account_id, name);
    }
    if retry {
        // The debt stays (the row keeps `stripping`): the next round resumes it.
        state.task_failed(
            &task,
            CmdError::new(
                "network",
                pick(
                    "The label is still being taken off; it will be tried again",
                    "Метку ещё снимаем; попробуем снова",
                ),
            ),
        );
    } else if !skipped.is_empty() {
        state.task_failed(&task, CmdError::new("other", skipped.join("; ")));
    } else {
        state.task_done(&task);
    }
    state.emit("labels-changed", json!({ "account_id": account_id }));
    state.emit("mail-changed", json!({ "account_id": account_id }));
    tracing::debug!(account = %account_id, "took a label off {count} letters");
}
