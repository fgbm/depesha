//! What an answer does after it leaves (#55, #59): the letter answered or forwarded is
//! marked at once, here and on the server, and an answer to a letter of the inbox takes
//! its conversation to the folder "Waiting for reply" until the reply brings it back. The
//! decisions and the moves are the core's (`depesha_core::waiting`); here are the events
//! that tell the windows and the tasks window.

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::lang::pick;
use depesha_core::account::Account;
use depesha_core::store::{OutboxItem, ParkJob, ParkKind};
use depesha_core::waiting::{self, Archived, Archiving, Brought, Taken};
use serde_json::json;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;
use crate::worker::Queue;

/// The letter `item` answered or forwarded, marked now that it left as `message_id`; the
/// wait it asked for started. Returns what became of the letters.
pub async fn after_sent(
    state: &Arc<AppState>,
    account: &Account,
    item: &OutboxItem,
    message_id: Option<String>,
    letter_cached: bool,
) -> CmdResult<Left> {
    let mut queue = Queue::background(state, &account.id).ok();
    let sent = waiting::record_sent(
        &state.store,
        queue.as_mut(),
        &state.archivals,
        account,
        item,
        message_id,
        letter_cached,
        chrono::Utc::now().timestamp(),
    )
    .await?;
    if let Some(e) = &sent.mark_failed {
        tracing::debug!(account = %account.id, "the server did not take the mark: {e}");
    }
    if let Some(folder) = &sent.marked {
        state.emit("mail-changed", json!({ "account_id": account.id, "folder": folder }));
    }
    if sent.counters {
        state.emit("counters-changed", json!({}));
        if sent.parks {
            state.scheduler_notify.notify_one();
        }
    }
    if let Some(archiving) = sent.archive {
        let (state, account, item) = (state.clone(), account.clone(), item.clone());
        tokio::spawn(async move { archive_answered(&state, &account, &item, archiving).await });
    }
    Ok(Left { parks: sent.parks })
}

/// What `after_sent` moved: the letters to wait in the folder (the move is the scheduler's).
/// The move to the archive is a task of its own, with a toast of its own.
pub struct Left {
    pub parks: bool,
}

/// The conversation of the letter answered goes from the inbox to the archive of the
/// mailbox (`waiting::archive_answered`). The toast offers to undo.
async fn archive_answered(state: &AppState, account: &Account, item: &OutboxItem, archiving: Archiving) {
    let Archiving {
        folder: from,
        message_id,
        guard,
    } = archiving;
    let now = chrono::Utc::now().timestamp();
    let mut queue = Queue::background(state, &account.id).ok();
    match waiting::archive_answered(
        &state.store,
        queue.as_mut(),
        &account.id,
        &from,
        &message_id,
        &guard,
        now,
    )
    .await
    {
        Archived::NoQueue => {
            tracing::warn!(account = %account.id, "archive of the answered letter: the mailbox is not running")
        }
        Archived::NoArchive => {
            tracing::debug!(account = %account.id, "archive of the answered letter: the mailbox has no archive folder")
        }
        Archived::NotRead(e) => {
            tracing::warn!(account = %account.id, "archive of the answered letter: the conversation was not read: {e}")
        }
        Archived::NothingFound => {
            tracing::debug!(account = %account.id, "archive of the answered letter: no letter found to move")
        }
        Archived::Failed(e) => tracing::warn!(account = %account.id, "archive of the answered letter: {e}"),
        Archived::Moved {
            archive,
            chain,
            not_marked,
        } => {
            if let Some(e) = not_marked {
                tracing::warn!(account = %account.id, "archive of the answered letter: not marked: {e}");
            }
            state.emit("counters-changed", json!({}));
            state.emit(
                "archived-after-send",
                json!({
                    "subject": item.draft.subject,
                    "moved": { "account_id": account.id, "from": from, "to": archive, "message_ids": chain },
                }),
            );
        }
    }
}

/// The moves waits owe: letters into the folder after an answer, back when the reply came
/// or the user stopped waiting. Run by the scheduler. By mailbox, in parallel: one that
/// hangs or is offline must not hold the others' letters up.
pub async fn round(state: Arc<AppState>) {
    let jobs: BTreeMap<String, Vec<ParkJob>> = match waiting::jobs_due(&state.store, chrono::Utc::now().timestamp()) {
        Ok(jobs) => jobs,
        Err(e) => {
            tracing::warn!("waiting: {e}");
            return;
        }
    };
    crate::scheduler::run_bounded(
        crate::scheduler::ACCOUNTS_AT_ONCE,
        jobs.into_values().collect(),
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
    let mut queue = Queue::background(state, &account.id)?;
    let now = chrono::Utc::now().timestamp();
    let taken = waiting::take_in(
        &state.store,
        &mut queue,
        &state.archivals,
        &state.refused,
        &account,
        job,
        &depesha_core::waiting::Round {
            now,
            words: &crate::localize::Phrases,
        },
    )
    .await?;
    match taken {
        Taken::Later => {}
        Taken::Vanished => {
            // The letters left the inbox meanwhile: nothing to wait in the folder.
            state.emit("sent", json!({ "subject": job.subject }));
            state.emit("counters-changed", json!({}));
        }
        Taken::Quiet | Taken::Elsewhere => state.emit("counters-changed", json!({})),
        Taken::Failed { refused, folder, error } => {
            let error = error.map(|e| CmdError::from(e).message);
            state.emit(
                "park-failed",
                json!({ "account_id": job.account_id, "subject": job.subject, "folder": folder, "refused": refused, "error": error }),
            );
            state.emit("counters-changed", json!({}));
        }
        Taken::Parked { folder } => {
            state.emit(
                "parked",
                json!({ "account_id": job.account_id, "key": job.key, "subject": job.subject, "folder": folder }),
            );
            state.emit("counters-changed", json!({}));
        }
    }
    Ok(())
}

async fn bring_back(state: &AppState, job: &ParkJob) -> CmdResult<()> {
    let Ok(mut queue) = Queue::background(state, &job.account_id) else {
        // The mailbox is gone: nothing to bring back.
        return Ok(state.store.followup_moved_back(&job.account_id, &job.key)?);
    };
    let now = chrono::Utc::now().timestamp();
    match waiting::bring_back(&state.store, &mut queue, job, now).await? {
        Brought::Back => state.emit("counters-changed", json!({})),
        Brought::Retry(e) => {
            tracing::debug!(account = %job.account_id, "bringing letters back failed: {e}")
        }
        Brought::GaveUp(e) => {
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
