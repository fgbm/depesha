//! Sends queued messages one by one. Transient failures (network, SMTP 4xx,
//! the Exchange rate limit) are retried later; permanent ones wait for the user.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use depesha_core::imap::FolderRole;
use depesha_core::store::{NewSentCopy, OutboxItem, SentCopy};
use depesha_core::{mail, message, smtp};
use serde_json::json;

use crate::error::CmdError;
use crate::state::AppState;
use crate::worker::Work;
use depesha_core::tr;

/// A gap between rounds this long means the app was not running (the machine slept):
/// the wall clock runs on, the monotonic one does not.
const SLEEP_GAP: Duration = Duration::from_secs(20);

pub async fn run(state: Arc<AppState>) {
    // A send cut short by a quit may or may not have left: it waits for the user.
    recover_interrupted(&state);
    // Copies in «Sent» a quit cut short are filed again.
    deliver_copies(&state);
    // When the app last ran without a break: a letter due before that was missed.
    let mut awake_since = chrono::Utc::now().timestamp();
    let mut last_wall = std::time::SystemTime::now();
    let mut last_mono = std::time::Instant::now();
    loop {
        // Wake exactly when the next message is due: the undo window and scheduled
        // sending are measured in seconds.
        let next = {
            let now = chrono::Utc::now().timestamp();
            state
                .store
                .outbox()
                .ok()
                .and_then(|items| items.iter().filter(|i| !i.failed).map(|i| i.next_attempt).min())
                .map(|t| (t - now).clamp(0, 15) as u64)
                .unwrap_or(15)
        };
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
    let Ok(items) = state.store.outbox() else {
        return;
    };
    let interrupted: Vec<i64> = items.iter().filter(|i| i.sending_started > 0).map(|i| i.id).collect();
    if interrupted.is_empty() {
        return;
    }
    let now = chrono::Utc::now().timestamp();
    let why = tr!(
        "possibly sent: check “Sent”",
        "возможно, ушло — проверьте «Отправленные»"
    );
    for id in interrupted {
        if let Err(e) = state.store.outbox_retry_later(id, now, &why, true) {
            tracing::warn!("outbox: {e}");
        }
    }
    state.emit("outbox-changed", json!({}));
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
    let mut by_account: BTreeMap<String, Vec<OutboxItem>> = BTreeMap::new();
    for item in state.store.outbox()? {
        if item.failed || item.next_attempt > now {
            continue;
        }
        by_account.entry(item.account_id.clone()).or_default().push(item);
    }
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
/// mailboxes go on.
async fn send_account(state: &AppState, items: Vec<OutboxItem>) -> Result<(), CmdError> {
    let now = chrono::Utc::now().timestamp();
    let mut blocked = false;
    for item in items {
        if item.failed || item.next_attempt > now || blocked {
            continue;
        }
        // A send that started but whose row was not removed (the removal failed after a
        // good SMTP) may have left: do not send it again, the user checks «Sent».
        if item.sending_started > 0 {
            let why = tr!(
                "possibly sent: check “Sent”",
                "возможно, ушло — проверьте «Отправленные»"
            );
            state.store.outbox_retry_later(item.id, now, &why, true)?;
            state.emit("outbox-changed", json!({}));
            continue;
        }
        let Ok(account) = state.account(&item.account_id) else {
            state.store.outbox_retry_later(
                item.id,
                now,
                &tr!("the account was removed", "учётная запись удалена"),
                true,
            )?;
            continue;
        };
        let key = format!("send:{}", item.id);
        let subject = if item.draft.subject.is_empty() {
            depesha_core::lang::pick("(no subject)", "(без темы)").to_owned()
        } else {
            item.draft.subject.clone()
        };
        state.task(
            &key,
            "send",
            Some(&item.account_id),
            tr!("Sending «{subject}»", "Отправка «{subject}»"),
            0,
            0,
        );
        // Marked before the letter leaves: a quit between here and the removal leaves the
        // mark, and the next start asks the user to check «Sent» instead of sending again.
        state.store.outbox_sending(item.id, now)?;
        let result = async {
            let msg = smtp::build(&item.draft)?;
            let account = &account;
            let msg = &msg;
            state
                .with_credentials(account, |creds| async move { mail::send(account, &creds, msg).await })
                .await
        }
        .await;

        match result {
            Ok(raw) => {
                state.task_done(&key);
                let message_id = message::parse_summary(&raw).message_id;
                let sent = state.store.folder_by_role(&account.id, FolderRole::Sent)?;
                // The client-side copy is work of its own: the send round does not wait for it
                // (a slow Sent folder would hold the whole round up). The bytes are kept in
                // the cache in the very step that removes the outbox row, so a quit, a dead
                // network or a paused mailbox cannot lose them; `deliver_copies` files them.
                let client_copy = account.save_sent_copy && !account.is_ews();
                // A wait for a reply needs its letter in the cache: with a copy to come it
                // starts when the copy has landed.
                let mut defer_wait = false;
                let mut letter_cached = true;
                match sent.as_deref() {
                    Some(folder) if client_copy => {
                        defer_wait = item.followup_secs > 0;
                        state.store.outbox_sent_with_copy(
                            item.id,
                            &NewSentCopy {
                                account_id: &account.id,
                                folder,
                                raw: &raw,
                                flags: "(\\Seen)",
                                message_id: message_id.as_deref(),
                                pending: defer_wait.then_some(&item),
                            },
                        )?;
                    }
                    _ => {
                        state.store.outbox_remove(item.id)?;
                        // No Sent folder yet: the copy cannot be made, so a wait could neither
                        // be shown nor cancelled. Say so and leave it out.
                        if client_copy {
                            letter_cached = false;
                            state.emit("app-error", json!({ "message": tr!("sent, but the Sent folder is unknown: the copy was not saved", "письмо отправлено, но папка «Отправленные» неизвестна: копия не сохранена") }));
                        }
                    }
                }
                // A letter going to wait says so once it has moved ("parked"), in one toast.
                let parking = crate::waiting::will_park(&item);
                state.emit(
                    "sent",
                    json!({ "id": item.id, "subject": item.draft.subject, "parking": parking }),
                );
                if defer_wait {
                    state.outbox_notify.notify_one();
                } else {
                    finish_sent(state, &account, &item, message_id, letter_cached).await?;
                }
                // The server keeps the copy itself (Exchange, Gmail): Sent is synced now, so the
                // answer joins its conversation at once, and again a moment later for servers
                // that file it with a delay.
                if !client_copy
                    && let Some(sent) = sent
                    && let Ok(worker) = state.worker(&account.id)
                {
                    worker.kick(Work::SyncFolder(sent.clone()));
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                        worker.kick(Work::SyncFolder(sent));
                    });
                }
            }
            Err(e) => {
                let transient = e.is_transient();
                let delay = if e.kind() == "rate-limited" {
                    65
                } else {
                    (30_i64 << item.attempts.min(6)).min(1800)
                };
                // A throttled Exchange named its pause: not a moment sooner.
                let delay = delay.max(e.back_off().map_or(0, |d| d.as_secs().min(1800) as i64 + 1));
                state
                    .store
                    .outbox_retry_later(item.id, now + delay, &e.to_string(), !transient)?;
                blocked = true;
                // A retry later is the outbox's business; a refusal waits for the user.
                if transient {
                    state.task_done(&key);
                } else {
                    let err = CmdError::from(e);
                    state.task_failed(&key, err.clone());
                    state.emit("send-failed", json!({ "id": item.id, "error": err }));
                }
            }
        }
        state.emit("outbox-changed", json!({}));
    }
    Ok(())
}

/// The letter answered or forwarded is marked, the wait for a reply starts; a plain "sent"
/// toast follows when the letter was to wait but had nothing to move after all.
async fn finish_sent(
    state: &AppState,
    account: &depesha_core::account::Account,
    item: &OutboxItem,
    message_id: Option<String>,
    letter_cached: bool,
) -> Result<(), CmdError> {
    let parks = crate::waiting::after_sent(state, account, item, message_id, letter_cached).await?;
    if crate::waiting::will_park(item) && !parks {
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

/// How many tries a wait for a reply stays held for its copy before it starts without one.
const COPY_WAIT_TRIES: u32 = 3;

async fn deliver_copy(state: &Arc<AppState>, copy: &SentCopy) -> Result<(), CmdError> {
    let Ok(account) = state.account(&copy.account_id) else {
        // See `with_known_mailbox`: the copy waits.
        return Ok(());
    };
    let outcome = match state.worker(&copy.account_id) {
        Ok(worker) => worker
            .run_background(Work::CopyToSent {
                folder: copy.folder.clone(),
                raw: copy.raw.clone(),
                flags: copy.flags.clone(),
                message_id: copy.message_id.clone(),
            })
            .await
            .map(|_| ()),
        Err(e) => Err(depesha_core::Error::Io(std::io::Error::other(e.message))),
    };
    // The wait for a reply starts before the copy is forgotten, so a quit between the two
    // repeats it and never loses it. It starts with the copy cached, or without it once
    // the copy keeps failing: the answered mark must not wait for a mailbox that is down.
    let ready = match (&outcome, copy.pending.as_ref()) {
        (Ok(()), Some(item)) => Some((item, true)),
        (Err(e), Some(item)) if !e.is_transient() || copy.attempts + 1 >= COPY_WAIT_TRIES => Some((item, false)),
        _ => None,
    };
    if let Some((item, cached)) = ready {
        if !cached {
            state.emit("app-error", json!({ "message": tr!("sent, but the copy was not saved to Sent yet: it will be filed later", "письмо отправлено, но копия в «Отправленные» пока не сохранена: её положат позже") }));
        }
        if let Err(e) = finish_sent(state, &account, item, copy.message_id.clone(), cached).await {
            // Counted as a try: otherwise the copy and the finish are repeated every round.
            settle_failed_finish(&state.store, copy, &outcome, &e, chrono::Utc::now().timestamp())?;
            return Err(e);
        }
    }
    settle_copy(&state.store, copy, &outcome, chrono::Utc::now().timestamp())?;
    if matches!(ready, Some((_, false))) {
        state.store.sent_copy_forget_wait(copy.id)?;
    }
    Ok(())
}

/// What the try at a copy leaves in the cache: nothing when the server has it, otherwise
/// the copy waits for its next try. Returns whether it was filed.
fn settle_copy(
    store: &depesha_core::store::Store,
    copy: &SentCopy,
    outcome: &Result<(), depesha_core::Error>,
    now: i64,
) -> Result<bool, CmdError> {
    match outcome {
        Ok(()) => {
            store.sent_copy_done(copy.id)?;
            Ok(true)
        }
        Err(e) => {
            let delay = (30_i64 << copy.attempts.min(6)).min(1800);
            let delay = delay.max(e.back_off().map_or(0, |d| d.as_secs().min(1800) as i64 + 1));
            store.sent_copy_retry_later(copy.id, now + delay, &e.to_string())?;
            Ok(false)
        }
    }
}

/// A finish of the sent letter that failed leaves its copy to try again later, with the
/// attempt counted. The copy itself may have gone through: a repeat finds it on the server.
fn settle_failed_finish(
    store: &depesha_core::store::Store,
    copy: &SentCopy,
    outcome: &Result<(), depesha_core::Error>,
    failure: &CmdError,
    now: i64,
) -> Result<(), CmdError> {
    match outcome {
        Err(_) => settle_copy(store, copy, outcome, now)?,
        Ok(()) => settle_copy(
            store,
            copy,
            &Err(depesha_core::Error::Io(std::io::Error::other(failure.message.clone()))),
            now,
        )?,
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use depesha_core::store::Store;

    /// A letter sent, its copy kept; the outbox row is gone.
    fn sent(store: &Store) -> SentCopy {
        let id = store
            .outbox_add("a", &Default::default(), 1, 1, 0, &Default::default())
            .unwrap();
        store
            .outbox_sent_with_copy(
                id,
                &NewSentCopy {
                    account_id: "a",
                    folder: "Sent",
                    raw: b"raw",
                    flags: "(\\Seen)",
                    message_id: Some("m@x"),
                    pending: None,
                },
            )
            .unwrap();
        store.sent_copies().unwrap().remove(0)
    }

    /// A copy that went through but whose finish failed is not forgotten and not repeated at
    /// once: the try is counted and the next one waits.
    #[test]
    fn a_failed_finish_counts_as_a_try() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent(&store);
        let now = 1_000;
        let failure = CmdError::new("other", "finish failed");
        settle_failed_finish(&store, &copy, &Ok(()), &failure, now).unwrap();
        assert_eq!(store.sent_copies().unwrap().len(), 1, "the copy is kept");
        assert!(store.sent_copies_due(now).unwrap().is_empty(), "not repeated at once");
        let later = store.sent_copies_due(now + 3_600).unwrap();
        assert_eq!(later.len(), 1);
        assert_eq!(later[0].attempts, copy.attempts + 1);
    }

    /// An accounts file that cannot be read lists no mailboxes: the copies wait, none is dropped.
    #[test]
    fn a_copy_of_an_unlisted_mailbox_stays() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent(&store);
        let due = store.sent_copies_due(i64::MAX).unwrap();
        assert!(with_known_mailbox(due.clone(), |_| false).is_empty());
        assert_eq!(store.sent_copies().unwrap().len(), 1);
        assert_eq!(with_known_mailbox(due, |id| id == copy.account_id).len(), 1);
    }

    /// A paused mailbox or a dead network does not lose the copy: it waits and goes once the
    /// mailbox answers, and the letter is not sent again meanwhile.
    #[test]
    fn a_copy_that_could_not_go_waits_and_goes_later() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent(&store);
        let now = 1_000;
        for failure in [
            depesha_core::Error::Paused,
            depesha_core::Error::Io(std::io::Error::new(
                std::io::ErrorKind::NetworkUnreachable,
                "no network",
            )),
        ] {
            let copy = store.sent_copies().unwrap().remove(0);
            assert!(!settle_copy(&store, &copy, &Err(failure), now).unwrap());
            assert!(store.sent_copies_due(now).unwrap().is_empty(), "not hammered at once");
            assert_eq!(store.sent_copies().unwrap().len(), 1, "the copy is kept");
            assert!(store.outbox().unwrap().is_empty(), "the letter is not sent twice");
        }
        let due = store.sent_copies_due(now + 3_600).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!((due[0].id, due[0].raw.as_slice()), (copy.id, &b"raw"[..]));
        assert!(settle_copy(&store, &due[0], &Ok(()), now + 3_600).unwrap());
        assert!(store.sent_copies().unwrap().is_empty());
    }
}
