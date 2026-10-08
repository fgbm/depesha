//! What an answer does after it leaves (#55, #59): the letter answered or forwarded is
//! marked at once, here and on the server, and an answer to a letter of the inbox takes
//! its conversation to the folder "Waiting for reply" until the reply brings it back. The
//! decisions are the core's (`depesha_core::store::waiting`); here are the moves.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use depesha_core::account::Account;
use depesha_core::imap::FolderRole;
use depesha_core::lang::pick;
use depesha_core::smtp::Act;
use depesha_core::store::{Followup, OutboxItem, ParkJob, ParkKind, Parking, WaitFolder, waiting_folder};
use serde_json::json;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;
use crate::worker::{Output, Work};

/// Letters still in the inbox this long after the answer, the server out of reach all the
/// while, stay there: the user is told.
const GIVE_UP_SECS: i64 = 3_600;

/// Folders a server refused to make, by mailbox: not tried again, and the user is not
/// told again, until another folder is chosen.
fn refused() -> &'static Mutex<HashSet<(String, String)>> {
    static REFUSED: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    REFUSED.get_or_init(Default::default)
}

/// Whether an answer about to be queued takes its letter to wait: the compose window's
/// choice, the mailbox's setting otherwise, and only for a letter of the inbox.
pub fn decide(
    state: &AppState,
    account: &Account,
    draft: &depesha_core::smtp::Draft,
    asked: Option<bool>,
) -> CmdResult<bool> {
    let inbox = state.store.folder_by_role(&account.id, FolderRole::Inbox)?;
    Ok(depesha_core::store::parks(
        draft.acts_on.as_ref(),
        asked,
        &account.id,
        &account.waiting,
        inbox.as_deref(),
    ))
}

/// The letter `item` answered or forwarded, marked now that it left as `message_id`; the
/// wait it asked for started. Returns whether its letters are to go to the folder.
pub async fn after_sent(
    state: &AppState,
    account: &Account,
    item: &OutboxItem,
    message_id: Option<String>,
    letter_cached: bool,
) -> CmdResult<bool> {
    let now = chrono::Utc::now().timestamp();
    let acts = item.draft.acts_on.as_ref().filter(|a| a.account_id == account.id);
    let reminder = (item.followup_secs > 0 && letter_cached).then_some(());
    let Some(message_id) = message_id else {
        return Ok(false);
    };
    let wait = |due_secs: i64| {
        Followup::after_sending(
            &account.id,
            message_id.clone(),
            &item.draft,
            now,
            due_secs,
            &item.followup,
        )
    };
    let Some(acts) = acts else {
        // A new letter: a reminder, as before.
        if reminder.is_some() {
            state.store.followup_add(&wait(item.followup_secs))?;
            state.emit("counters-changed", json!({}));
        }
        return Ok(false);
    };
    state
        .store
        .mark_done(&account.id, &acts.message_id, acts.act, now, Some(&message_id))?;
    mark_on_server(state, &account.id, &acts.folder, &acts.message_id, acts.act).await;

    let mut park = None;
    if item.followup.park == Some(true) && acts.act.answers() {
        let inbox = state.store.folder_by_role(&account.id, FolderRole::Inbox)?;
        if let Some(inbox) = inbox.filter(|i| *i == acts.folder) {
            let chain = state.store.inbox_chain(&account.id, &inbox, &acts.message_id)?;
            if !chain.is_empty() {
                park = Some(Parking { from: inbox, chain });
            }
        }
    }
    let f = match reminder {
        Some(()) => wait(item.followup_secs),
        None => Followup {
            due: 0,
            deadline: 0,
            ..wait(0)
        },
    };
    let parks = park.is_some();
    if state.store.followup_start(&f, Some(&acts.message_id), park.as_ref())? {
        state.emit("counters-changed", json!({}));
        if parks {
            state.scheduler_notify.notify_one();
        }
    }
    Ok(parks)
}

/// Whether the outbox item will take its letter to wait once it leaves: the "sent" toast
/// waits for the move then.
pub fn will_park(item: &OutboxItem) -> bool {
    item.followup.park == Some(true) && item.draft.acts_on.as_ref().is_some_and(|a| a.act.answers())
}

/// The server's flag for what was done: `\Answered` and `$Forwarded`, Exchange's verb.
/// The mark Depesha keeps does not depend on it: a refusal is only logged.
async fn mark_on_server(state: &AppState, account_id: &str, folder: &str, message_id: &str, act: Act) {
    let change = match act {
        Act::Reply => depesha_core::imap::FlagChange::Answered(true),
        Act::ReplyAll => depesha_core::imap::FlagChange::AnsweredAll(true),
        Act::Forward => depesha_core::imap::FlagChange::Forwarded(true),
    };
    let found = state
        .store
        .find_by_message_id(account_id, folder, message_id)
        .ok()
        .flatten()
        .and_then(|r| state.store.get_at(r.id).ok().flatten());
    let (Some((row, validity)), Ok(worker)) = (found, state.worker(account_id)) else {
        return;
    };
    let work = Work::SetFlag {
        folder: row.folder.clone(),
        validity,
        uids: vec![row.uid],
        change,
    };
    if let Err(e) = worker.run_background(work).await {
        tracing::debug!(account = %account_id, "the server did not take the mark: {e}");
    }
    state.emit(
        "mail-changed",
        json!({ "account_id": account_id, "folder": row.folder }),
    );
}

/// The moves waits owe: letters into the folder after an answer, back when the reply came
/// or the user stopped waiting. Run by the scheduler. By mailbox, in parallel: one that
/// hangs or is offline must not hold the others' letters up.
pub async fn round(state: Arc<AppState>) {
    let jobs = match state.store.park_jobs() {
        Ok(jobs) => jobs,
        Err(e) => {
            tracing::warn!("waiting: {e}");
            return;
        }
    };
    let mut by_account: BTreeMap<String, Vec<ParkJob>> = BTreeMap::new();
    for job in jobs {
        by_account.entry(job.account_id.clone()).or_default().push(job);
    }
    crate::scheduler::run_bounded(
        crate::scheduler::ACCOUNTS_AT_ONCE,
        by_account.into_values().collect(),
        |jobs| {
            let state = state.clone();
            async move { jobs_of_account(&state, jobs).await }
        },
    )
    .await;
}

async fn jobs_of_account(state: &AppState, jobs: Vec<ParkJob>) {
    for job in jobs {
        let done = match job.kind {
            ParkKind::In => take_in(state, &job).await,
            ParkKind::Back | ParkKind::Undo => bring_back(state, &job).await,
        };
        if let Err(e) = done {
            tracing::warn!(account = %job.account_id, "waiting: {}", e.message);
        }
    }
}

async fn take_in(state: &AppState, job: &ParkJob) -> CmdResult<()> {
    let Ok(account) = state.account(&job.account_id) else {
        return Ok(state.store.followup_park_failed(&job.account_id, &job.key)?);
    };
    let worker = state.worker(&account.id)?;
    let now = chrono::Utc::now().timestamp();
    let fail = |refused: bool, folder: &str, error: Option<String>| -> CmdResult<()> {
        state.store.followup_park_failed(&job.account_id, &job.key)?;
        state.emit(
            "park-failed",
            json!({ "account_id": job.account_id, "subject": job.subject, "folder": folder, "refused": refused, "error": error }),
        );
        state.emit("counters-changed", json!({}));
        Ok(())
    };
    let default = pick("Waiting for reply", "Ждут ответа");
    let folders: Vec<(String, String)> = state
        .store
        .folders(Some(&account.id))?
        .into_iter()
        .map(|f| (f.folder.name, f.folder.display_name))
        .collect();
    let folder = match waiting_folder(&account.waiting.folder, default, &folders) {
        WaitFolder::Existing(name) => name,
        WaitFolder::Create(name) => {
            let key = (account.id.clone(), name.clone());
            if refused().lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
                // Told once already: the letter stays in the inbox quietly.
                state.store.followup_park_failed(&job.account_id, &job.key)?;
                state.emit("counters-changed", json!({}));
                return Ok(());
            }
            match worker.run_background(Work::CreateFolder(name.clone())).await {
                Ok(_) => {}
                Err(e) if e.is_transient() && now - job.since < GIVE_UP_SECS => return Ok(()),
                Err(e) if e.is_transient() => return fail(false, &name, Some(CmdError::from(e).message)),
                Err(_) => {
                    refused().lock().unwrap_or_else(|e| e.into_inner()).insert(key);
                    return fail(true, &name, None);
                }
            }
            let made = state
                .store
                .folders(Some(&account.id))?
                .into_iter()
                .find(|f| f.folder.display_name == name || f.folder.name == name);
            match made {
                Some(f) => f.folder.name,
                None => return fail(true, &name, None),
            }
        }
    };
    let work = Work::MoveByMessageId {
        from: job.from.clone(),
        message_ids: job.message_ids.clone(),
        to: folder.clone(),
        unseen: false,
    };
    match worker.run_background(work).await {
        Ok(Output::Count(0)) => {
            // Moved elsewhere meanwhile: nothing waits in the folder.
            state.store.followup_park_failed(&job.account_id, &job.key)?;
            state.emit("counters-changed", json!({}));
        }
        Ok(_) => {
            state.store.followup_parked(&job.account_id, &job.key, &folder)?;
            state.emit(
                "parked",
                json!({ "account_id": job.account_id, "key": job.key, "subject": job.subject, "folder": folder }),
            );
            state.emit("counters-changed", json!({}));
        }
        Err(e) if e.is_transient() && now - job.since < GIVE_UP_SECS => {}
        Err(e) => return fail(false, &folder, Some(CmdError::from(e).message)),
    }
    Ok(())
}

async fn bring_back(state: &AppState, job: &ParkJob) -> CmdResult<()> {
    let worker = match state.worker(&job.account_id) {
        Ok(w) => w,
        // The mailbox is gone: nothing to bring back.
        Err(_) => return Ok(state.store.followup_moved_back(&job.account_id, &job.key)?),
    };
    let work = Work::MoveByMessageId {
        from: job.from.clone(),
        message_ids: job.message_ids.clone(),
        to: job.to.clone(),
        unseen: false,
    };
    match worker.run_background(work).await {
        // Moved: back. None found: moved elsewhere by hand, nothing to bring.
        Ok(_) => {
            state.store.followup_moved_back(&job.account_id, &job.key)?;
            state.emit("counters-changed", json!({}));
        }
        // Offline or paused: the next round tries again.
        Err(e) if e.is_transient() => {
            tracing::debug!(account = %job.account_id, "bringing letters back failed: {e}")
        }
        // The folder is gone: the letters cannot be brought back; the user is told to do it.
        Err(e) => {
            state.store.followup_return_failed(&job.account_id, &job.key)?;
            state.emit(
                "bring-failed",
                json!({
                    "account_id": job.account_id,
                    "subject": job.subject,
                    "folder": job.from,
                    "error": CmdError::from(e).message,
                }),
            );
            state.emit("counters-changed", json!({}));
        }
    }
    Ok(())
}

/// Where "Stop waiting" takes letters waiting in the folder: the archive when the
/// mailbox says so and has one, the inbox otherwise.
pub fn stop_to(state: &AppState, account_id: &str) -> Option<String> {
    let account = state.account(account_id).ok()?;
    if !account.waiting.stop_to_archive {
        return None;
    }
    state
        .store
        .folder_by_role(account_id, FolderRole::Archive)
        .ok()
        .flatten()
}
