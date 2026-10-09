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

/// What an answer about to be queued does with its letter (#106): `(park, archive)`. A wait
/// chosen takes it to the folder "Waiting for reply"; with none, the compose window's
/// choice or the mailbox's setting takes it to the archive; only for a letter of the inbox.
pub fn decide(
    state: &AppState,
    account: &Account,
    draft: &depesha_core::smtp::Draft,
    followup_secs: i64,
    plan: &depesha_core::store::FollowupPlan,
) -> CmdResult<(bool, bool)> {
    let inbox = state.store.folder_by_role(&account.id, FolderRole::Inbox)?;
    Ok(depesha_core::store::moves(
        draft.acts_on.as_ref(),
        plan,
        followup_secs,
        &account.id,
        &account.waiting,
        inbox.as_deref(),
    ))
}

/// The letter `item` answered or forwarded, marked now that it left as `message_id`; the
/// wait it asked for started. Returns what became of the letters.
pub async fn after_sent(
    state: &AppState,
    account: &Account,
    item: &OutboxItem,
    message_id: Option<String>,
    letter_cached: bool,
) -> CmdResult<Left> {
    let now = chrono::Utc::now().timestamp();
    let acts = item.draft.acts_on.as_ref().filter(|a| a.account_id == account.id);
    let reminder = (item.followup_secs > 0 && letter_cached).then_some(());
    let Some(message_id) = message_id else {
        return Ok(Left {
            parks: false,
            archived: false,
        });
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
            state.store.followup_add_once(&wait(item.followup_secs))?;
            state.emit("counters-changed", json!({}));
        }
        return Ok(Left {
            parks: false,
            archived: false,
        });
    };
    state
        .store
        .mark_done(&account.id, &acts.message_id, acts.act, now, Some(&message_id))?;
    mark_on_server(state, &account.id, &acts.folder, &acts.message_id, acts.act).await;

    let mut park = None;
    if will_park(item) {
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
    let in_inbox = state
        .store
        .folder_by_role(&account.id, FolderRole::Inbox)?
        .is_some_and(|i| i == acts.folder);
    let archived =
        will_archive(item) && in_inbox && archive_answered(state, account, item, &acts.folder, &acts.message_id).await;
    Ok(Left { parks, archived })
}

/// What `after_sent` moved: the letters to wait in the folder (the move is the scheduler's),
/// or to the archive (done).
pub struct Left {
    pub parks: bool,
    pub archived: bool,
}

/// The conversation of the letter answered goes from the inbox to the archive of the
/// mailbox, as the command "Archive" does it (#106). A mailbox without an archive folder
/// keeps the letter: nothing is created behind the user's back. The toast offers to undo.
async fn archive_answered(
    state: &AppState,
    account: &Account,
    item: &OutboxItem,
    from: &str,
    message_id: &str,
) -> bool {
    let Ok(Some(archive)) = state.store.folder_by_role(&account.id, FolderRole::Archive) else {
        return false;
    };
    let Ok(worker) = state.worker(&account.id) else {
        return false;
    };
    let Ok(mut chain) = state.store.inbox_chain(&account.id, from, message_id) else {
        return false;
    };
    if chain.is_empty() {
        chain.push(message_id.to_owned());
    }
    let work = Work::MoveByMessageId {
        from: from.to_owned(),
        message_ids: chain.clone(),
        to: archive.clone(),
        unseen: false,
    };
    match worker.run_background(work).await {
        Ok(Output::Count(0)) => false,
        Ok(_) => {
            state.emit("counters-changed", json!({}));
            state.emit(
                "archived-after-send",
                json!({
                    "subject": item.draft.subject,
                    "moved": { "account_id": account.id, "from": from, "to": archive, "message_ids": chain },
                }),
            );
            true
        }
        Err(e) => {
            tracing::warn!(account = %account.id, "archive of the answered letter: {e}");
            false
        }
    }
}

/// Whether the outbox item will take its letter to wait once it leaves: the "sent" toast
/// waits for the move then. A wait must be chosen: an item queued before #106 with the
/// folder asked for and no reminder only archives.
pub fn will_park(item: &OutboxItem) -> bool {
    item.followup.park == Some(true)
        && item.followup.waits(item.followup_secs)
        && item.draft.acts_on.as_ref().is_some_and(|a| a.act.answers())
}

/// Whether the outbox item will take its letter to the archive once it leaves (#106): a
/// wait chosen goes before it.
pub fn will_archive(item: &OutboxItem) -> bool {
    let archive =
        item.followup.archive == Some(true) || (item.followup.archive.is_none() && item.followup.park == Some(true));
    archive && !item.followup.waits(item.followup_secs) && item.draft.acts_on.as_ref().is_some_and(|a| a.act.answers())
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
    let now = chrono::Utc::now().timestamp();
    for job in jobs {
        // The rest of a chain whose one letter was taken out waits out the undo toast
        // before it goes back: an undo in the meantime finds it still in the folder
        // (`UNDO_SECS` in the store). The job is not lost, only held back.
        if job.since > now {
            continue;
        }
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

/// Whether a return that has been failing since `since` is given up: the letters stay
/// where they are and the user is told.
fn gives_up(since: i64, now: i64) -> bool {
    now - since >= GIVE_UP_SECS
}

async fn bring_back(state: &AppState, job: &ParkJob) -> CmdResult<()> {
    let worker = match state.worker(&job.account_id) {
        Ok(w) => w,
        // The mailbox is gone: nothing to bring back.
        Err(_) => return Ok(state.store.followup_moved_back(&job.account_id, &job.key)?),
    };
    let now = chrono::Utc::now().timestamp();
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
        // Offline, paused, refused login, busy server, folder locked, a limit, or any
        // other refusal: the next round tries again, but not for ever — a pause or a wrong
        // password must not lose the letters at once, nor be retried in silence for days.
        Err(e) if !gives_up(job.since, now) => {
            tracing::debug!(account = %job.account_id, "bringing letters back failed: {e}")
        }
        Err(e) => {
            state.store.followup_return_failed(&job.account_id, &job.key)?;
            let error = CmdError::from(e);
            // A red task stays in the tasks window until it is dismissed.
            let task = format!("bring:{}:{}", job.account_id, job.key);
            let label = pick(
                "Returning letters from the waiting folder",
                "Возврат писем из папки ожидания",
            );
            state.task(&task, "waiting", Some(&job.account_id), label.to_owned(), 0, 0);
            state.task_failed(&task, error.clone());
            state.emit(
                "bring-failed",
                json!({
                    "account_id": job.account_id,
                    "subject": job.subject,
                    "folder": job.from,
                    "error": error.message,
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

#[cfg(test)]
mod tests {
    use super::*;
    use depesha_core::smtp::{ActsOn, Draft};
    use depesha_core::store::FollowupPlan;

    fn answer(secs: i64, plan: FollowupPlan) -> OutboxItem {
        OutboxItem {
            id: 1,
            account_id: "a".into(),
            draft: Draft {
                acts_on: Some(ActsOn {
                    account_id: "a".into(),
                    folder: "INBOX".into(),
                    message_id: "q@x".into(),
                    act: Act::Reply,
                    waiting: false,
                }),
                ..Draft::default()
            },
            attempts: 0,
            next_attempt: 0,
            last_error: None,
            failed: false,
            sending_started: 0,
            created: 0,
            followup_secs: secs,
            followup: plan,
        }
    }

    #[test]
    fn without_a_wait_the_letter_is_archived_not_parked() {
        // «No reminder» with the box ticked: an old item (park only) and a new one.
        let old = answer(
            0,
            FollowupPlan {
                park: Some(true),
                ..Default::default()
            },
        );
        assert!(!will_park(&old));
        assert!(will_archive(&old));
        let new = answer(
            0,
            FollowupPlan {
                park: Some(false),
                archive: Some(true),
                ..Default::default()
            },
        );
        assert!(!will_park(&new));
        assert!(will_archive(&new));
        // A wait chosen: the folder, and no archive.
        let waits = answer(
            86_400,
            FollowupPlan {
                park: Some(true),
                archive: Some(false),
                ..Default::default()
            },
        );
        assert!(will_park(&waits));
        assert!(!will_archive(&waits));
        let by_deadline = answer(
            0,
            FollowupPlan {
                park: Some(true),
                deadline_secs: 3_600,
                ..Default::default()
            },
        );
        assert!(will_park(&by_deadline));
        assert!(!will_archive(&by_deadline));
        // The box off: neither.
        let off = answer(
            0,
            FollowupPlan {
                park: Some(false),
                archive: Some(false),
                ..Default::default()
            },
        );
        assert!(!will_park(&off) && !will_archive(&off));
    }

    #[test]
    fn a_return_failing_for_an_hour_is_given_up() {
        assert!(!gives_up(1_000, 1_000 + GIVE_UP_SECS - 1));
        assert!(gives_up(1_000, 1_000 + GIVE_UP_SECS));
    }
}
