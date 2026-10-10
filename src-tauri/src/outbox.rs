//! Sends queued messages one by one. Transient failures (network, SMTP 4xx,
//! the Exchange rate limit) are retried later; permanent ones wait for the user.

use std::sync::Arc;
use std::time::Duration;

use depesha_core::account::Account;
use depesha_core::outbox::{self, Attempt, Hold, Settled};
use depesha_core::store::{OutboxItem, SentCopy, StuckCopy};
use depesha_core::{mail, smtp};
use serde_json::json;

use crate::error::CmdError;
use crate::state::AppState;
use crate::tr;
use crate::worker::{Queue, Work};

/// A gap between rounds this long means the app was not running (the machine slept):
/// the wall clock runs on, the monotonic one does not.
const SLEEP_GAP: Duration = Duration::from_secs(20);

pub async fn run(state: Arc<AppState>) {
    // A send cut short by a quit may or may not have left: it waits for the user.
    recover_interrupted(&state);
    // Copies in «Sent» a quit cut short are filed again; those the server refused for good
    // and that wait for the user are shown in the tasks again.
    restore_stuck_tasks(&state);
    deliver_copies(&state);
    // When the app last ran without a break: a letter due before that was missed.
    let mut awake_since = chrono::Utc::now().timestamp();
    let mut last_wall = std::time::SystemTime::now();
    let mut last_mono = std::time::Instant::now();
    loop {
        // Wake exactly when the next message is due: the undo window and scheduled
        // sending are measured in seconds.
        let next = state
            .store
            .outbox()
            .map_or(15, |items| outbox::next_wake(&items, chrono::Utc::now().timestamp()));
        tokio::select! {
            _ = state.outbox_notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(next)) => {}
        }
        let now = chrono::Utc::now().timestamp();
        // The machine slept: the app was not running since it went under, so letters due
        // in the gap may have missed their time. A busy queue or a dead network is not
        // this: the process kept running then, and those letters go their usual way.
        let wall = std::time::SystemTime::now();
        let mono = std::time::Instant::now();
        if wall.duration_since(last_wall).unwrap_or_default() > mono.duration_since(last_mono) + SLEEP_GAP {
            awake_since = now;
        }
        last_wall = wall;
        last_mono = mono;
        if let Err(e) = round(&state, awake_since).await {
            tracing::error!("outbox: {}", e.message);
        }
    }
}

/// A letter whose send was cut short (the app quit mid-SMTP): whether the server took it
/// cannot be known, so it is not tried again by itself; the user checks «Sent».
fn recover_interrupted(state: &AppState) {
    match outbox::hold_interrupted(&state.store, chrono::Utc::now().timestamp(), &crate::localize::Phrases) {
        Ok(true) => state.emit("outbox-changed", json!({})),
        Ok(false) => {}
        Err(e) => tracing::warn!("outbox: {e}"),
    }
}

/// One round of sending, with the background noting it is under way so a quit can wait.
async fn round(state: &Arc<AppState>, awake_since: i64) -> Result<(), CmdError> {
    state.background.outbox_begin();
    let done = round_inner(state, awake_since).await;
    state.background.outbox_end();
    done
}

async fn round_inner(state: &Arc<AppState>, awake_since: i64) -> Result<(), CmdError> {
    deliver_copies(state);
    let now = chrono::Utc::now().timestamp();
    // Hours late (the app was closed, the computer asleep), a letter waits for the user.
    crate::background::hold_missed(state, now, awake_since)?;
    // By mailbox: one that is slow or offline must not hold the others' letters up.
    let by_account = outbox::due_by_account(&state.store, now)?;
    let sent = crate::scheduler::run_bounded(
        crate::scheduler::ACCOUNTS_AT_ONCE,
        by_account.into_values().collect(),
        |items| {
            let state = state.clone();
            async move { send_account(&state, items).await }
        },
    )
    .await;
    sent.into_iter().collect()
}

/// Sends one mailbox's due letters, one after another. Once one is refused (the server
/// said no, the address is bad), the rest of that mailbox waits for the user; the other
/// mailboxes go on. The steps of one letter are the core's (`outbox::attempt`).
async fn send_account(state: &Arc<AppState>, items: Vec<OutboxItem>) -> Result<(), CmdError> {
    let now = chrono::Utc::now().timestamp();
    let mut blocked = false;
    for item in items {
        let account = state.account(&item.account_id).ok();
        let key = format!("send:{}", item.id);
        let mut starting = || {
            let subject =
                outbox::subject_or_placeholder(&item.draft.subject, crate::lang::pick("(no subject)", "(без темы)"));
            state.task(
                &key,
                "send",
                Some(&item.account_id),
                tr!("Sending «{subject}»", "Отправка «{subject}»"),
                0,
                0,
            );
        };
        let mut aborted = || state.task_done(&key);
        let progress = outbox::Progress {
            starting: &mut starting,
            aborted: &mut aborted,
        };
        let attempt = outbox::attempt(
            &state.store,
            &item,
            account.as_ref(),
            blocked,
            now,
            progress,
            &crate::localize::Phrases,
            |a| MailSender {
                state: state.clone(),
                account: a.clone(),
            },
        )
        .await?;
        match attempt {
            Attempt::Skipped => continue,
            Attempt::Held(Hold::PossiblySent) => {
                state.emit("outbox-changed", json!({}));
                continue;
            }
            Attempt::Held(Hold::NoAccount) => continue,
            Attempt::Delivered(sent) => {
                state.task_done(&key);
                let account = account.expect("a delivered letter had its mailbox");
                if !sent.letter_cached {
                    state.emit("app-error", json!({ "message": tr!("sent, but the Sent folder is unknown: the copy was not saved", "письмо отправлено, но папка «Отправленные» неизвестна: копия не сохранена") }));
                }
                // A letter going to wait says so once it has moved ("parked"), in one toast. One
                // going to the archive is "sent" at once; its move, queued behind the mailbox's
                // loads, says "archived-after-send" in a toast of its own (#106).
                let parking = depesha_core::waiting::will_park(&item);
                state.emit(
                    "sent",
                    json!({ "id": item.id, "subject": item.draft.subject, "parking": parking }),
                );
                if sent.defer_wait {
                    state.outbox_notify.notify_one();
                } else {
                    finish_sent(state, &account, &item, sent.message_id, sent.letter_cached).await?;
                }
                // The server keeps the copy itself (Exchange, Gmail): Sent is synced now, so the
                // answer joins its conversation at once, and again a moment later for servers
                // that file it with a delay.
                if !sent.client_copy
                    && let Some(folder) = sent.sent_folder
                    && let Ok(worker) = state.worker(&account.id)
                {
                    worker.kick(Work::SyncFolder(folder.clone()));
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                        worker.kick(Work::SyncFolder(folder));
                    });
                }
            }
            Attempt::Failed { error, transient } => {
                blocked = true;
                // A retry later is the outbox's business; a refusal waits for the user.
                if transient {
                    state.task_done(&key);
                } else {
                    let err = CmdError::from(error);
                    state.task_failed(&key, err.clone());
                    state.emit("send-failed", json!({ "id": item.id, "error": err }));
                }
            }
        }
        state.emit("outbox-changed", json!({}));
    }
    Ok(())
}

/// The port of the sender over SMTP, or Exchange Web Services when the mailbox is one: the
/// message is built here, and the credentials (kept in the keyring, or refreshed for OAuth)
/// are the app's.
struct MailSender {
    state: Arc<AppState>,
    account: Account,
}

impl depesha_core::port::Sender for MailSender {
    async fn send(&mut self, draft: &depesha_core::domain::Draft) -> depesha_core::Result<Vec<u8>> {
        let msg = smtp::build(draft)?;
        let account = &self.account;
        let msg = &msg;
        self.state
            .with_credentials(account, |creds| async move { mail::send(account, &creds, msg).await })
            .await
    }
}

/// The letter answered or forwarded is marked, the wait for a reply starts; a plain "sent"
/// toast follows when the letter was to wait but had nothing to move after all. A letter
/// to be archived was announced as sent when it left.
async fn finish_sent(
    state: &Arc<AppState>,
    account: &depesha_core::account::Account,
    item: &OutboxItem,
    message_id: Option<String>,
    letter_cached: bool,
) -> Result<(), CmdError> {
    let left = crate::waiting::after_sent(state, account, item, message_id, letter_cached).await?;
    if depesha_core::waiting::will_park(item) && !left.parks {
        // Nothing to move after all (the letter left the inbox meanwhile): plain "sent".
        state.emit("sent", json!({ "id": item.id, "subject": item.draft.subject }));
    }
    Ok(())
}

/// Tries at the copies of sent letters not yet in «Sent», each on its own: a slow or dead
/// mailbox holds nobody up. Called by every round and at the start, so a copy that was cut
/// short by a quit or a dead network is filed once the mailbox answers again.
pub fn deliver_copies(state: &Arc<AppState>) {
    let now = chrono::Utc::now().timestamp();
    let Ok(due) = state.store.sent_copies_due(now) else {
        return;
    };
    for copy in with_known_mailbox(due, |id| state.account(id).is_ok()) {
        if !state.copy_claim(copy.id) {
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = deliver_copy(&state, &copy).await {
                tracing::warn!("sent copy: {}", e.message);
            }
            state.copy_release(copy.id);
        });
    }
}

/// The copies whose mailbox is configured. The others stay in the cache: a broken accounts
/// file reads as no mailboxes at all, and a copy is not dropped for that. Removing a mailbox
/// clears its copies (`forget_account`).
fn with_known_mailbox(due: Vec<SentCopy>, known: impl Fn(&str) -> bool) -> Vec<SentCopy> {
    due.into_iter().filter(|c| known(&c.account_id)).collect()
}

pub(crate) async fn deliver_copy(state: &Arc<AppState>, copy: &SentCopy) -> Result<(), CmdError> {
    let Ok(account) = state.account(&copy.account_id) else {
        // See `with_known_mailbox`: the copy waits.
        return Ok(());
    };
    let mut queue = Queue::background(state, &copy.account_id).ok();
    let tried = outbox::deliver_copy(
        &state.store,
        queue.as_mut(),
        copy,
        chrono::Utc::now().timestamp(),
        refusal_delay,
        &crate::localize::Phrases,
        |item, cached| async move {
            if !cached {
                state.emit("app-error", json!({ "message": tr!("sent, but the copy was not saved to Sent yet: it will be filed later", "письмо отправлено, но копия в «Отправленные» пока не сохранена: её положат позже") }));
            }
            finish_sent(state, &account, &item, copy.message_id.clone(), cached).await
        },
    )
    .await?;
    if tried.settled == Settled::Held
        && let Some(held) = state.store.sent_copies_stuck()?.into_iter().find(|c| c.id == copy.id)
    {
        stuck_task(state, &held);
    }
    tried.finish_failed.map_or(Ok(()), Err)
}

/// A refusal waited out the longer, the more of them came (`outbox::refusal_delay`). The e2e
/// run shortens it (`DEPESHA_E2E_COPY_BACKOFF`, seconds) to see a copy held within a minute; only
/// the `e2e` build reads it, as with `DEPESHA_E2E_ROOT`.
fn refusal_delay(refusals: u32) -> i64 {
    #[cfg(feature = "e2e")]
    if let Some(secs) = crate::state::e2e_env::<i64>("DEPESHA_E2E_COPY_BACKOFF") {
        return secs;
    }
    outbox::refusal_delay(refusals)
}

/// The task of a copy on hold: plain words on top, the server's own on the line below.
fn stuck_task(state: &AppState, copy: &StuckCopy) {
    let key = stuck_key(copy.id);
    let (label, kind) = stuck_label(copy);
    state.task(&key, "stuck-copy", Some(&copy.account_id), label, 0, 0);
    let reason = copy.last_error.clone().unwrap_or_default();
    state.task_failed(&key, CmdError::new(kind, reason));
}

/// The kind of the error of a copy the server has but whose finish failed; the interface tells
/// it from a refusal by the server.
const FILED_KIND: depesha_core::ErrorKind = depesha_core::ErrorKind::CopyFiled;

/// The title and the error kind of the task of a held copy. One the server has but whose wait
/// for a reply could not start is a task of its own, and its error is ours, not the server's.
fn stuck_label(copy: &StuckCopy) -> (String, depesha_core::ErrorKind) {
    let subject = if copy.subject.is_empty() {
        crate::lang::pick("(no subject)", "(без темы)").to_owned()
    } else {
        copy.subject.clone()
    };
    if copy.filed {
        (
            tr!(
                "Copy saved, but the wait for a reply did not start: «{subject}»",
                "Копия сохранена, но не удалось начать ожидание ответа: «{subject}»"
            ),
            FILED_KIND,
        )
    } else {
        (
            tr!("Copy not saved: «{subject}»", "Копия не сохранена: «{subject}»"),
            depesha_core::ErrorKind::Other,
        )
    }
}

/// The key of the task of a held copy; the interface reads the copy's id from it.
pub(crate) fn stuck_key(id: i64) -> String {
    format!("stuck-copy:{id}")
}

/// After a start the copies on hold are in the tasks again (the tasks live in memory).
fn restore_stuck_tasks(state: &AppState) {
    for copy in state.store.sent_copies_stuck().unwrap_or_default() {
        if state.account(&copy.account_id).is_ok() {
            stuck_task(state, &copy);
        }
    }
}

/// «Don't keep the copy»: a wait for a reply still held for the copy starts first, without
/// it, so that dropping the copy never cancels the wait in silence. When the wait cannot
/// start the copy is dropped all the same, or the task would come back at every start; the
/// failure is shown in a toast of its own.
pub(crate) async fn drop_copy(state: &Arc<AppState>, id: i64) -> Result<(), CmdError> {
    let Some(copy) = state.store.sent_copy(id)? else {
        return Ok(());
    };
    let account = state.account(&copy.account_id).ok();
    if copy.pending.is_some() && account.is_some() && !state.copy_claim(id) {
        return Err(CmdError::new(
            depesha_core::ErrorKind::Other,
            tr!("the copy is being filed just now", "копия сейчас отправляется"),
        ));
    }
    let (account, held) = (&account, &copy);
    let failed = outbox::drop_with(&state.store, &copy, |item| async move {
        let Some(account) = account.as_ref() else {
            return Err(CmdError::new(
                depesha_core::ErrorKind::NotFound,
                tr!("account not found", "учётная запись не найдена"),
            ));
        };
        let done = finish_sent(state, account, &item, held.message_id.clone(), held.filed).await;
        state.copy_release(id);
        done
    })
    .await?
    .map(|e: CmdError| e.kind);
    state.task_done(&stuck_key(id));
    if let Some(kind) = failed {
        // The error is logged by its kind: its text may name the letter or its addresses.
        tracing::warn!(
            copy = id,
            kind = kind.as_str(),
            "the wait for a reply did not start while dropping the copy"
        );
        state.emit(
            "app-error",
            json!({ "message": tr!("the copy was dropped, but the wait for a reply did not start", "копия удалена, но ожидание ответа не начато") }),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(feature = "e2e"))]
    fn a_regular_build_ignores_the_e2e_backoff() {
        // SAFETY: the only test that touches this variable.
        unsafe { std::env::set_var("DEPESHA_E2E_COPY_BACKOFF", "3") };
        assert_eq!(super::refusal_delay(1), 30 * 60);
        assert_eq!(super::refusal_delay(3), 6 * 3_600);
        unsafe { std::env::remove_var("DEPESHA_E2E_COPY_BACKOFF") };
    }

    fn held(filed: bool) -> StuckCopy {
        StuckCopy {
            id: 1,
            account_id: "a".into(),
            subject: "Contract".into(),
            last_error: Some("no database".into()),
            refusals: 0,
            filed,
        }
    }

    /// The task of a copy the server took whose finish failed says the copy is saved, not that
    /// it is not; one the server refused is the old task.
    #[test]
    fn the_task_of_a_held_copy_tells_a_failed_finish_from_a_refusal() {
        let (label, kind) = stuck_label(&held(true));
        assert!(
            !label.contains("не сохранена") && !label.contains("not saved"),
            "{label}"
        );
        assert_eq!(kind, FILED_KIND);
        let (label, kind) = stuck_label(&held(false));
        assert!(label.contains("не сохранена") || label.contains("not saved"), "{label}");
        assert_eq!(kind, depesha_core::ErrorKind::Other);
    }
}
