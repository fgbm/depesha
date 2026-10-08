//! Sends queued messages one by one. Transient failures (network, SMTP 4xx,
//! the Exchange rate limit) are retried later; permanent ones wait for the user.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use depesha_core::imap::FolderRole;
use depesha_core::store::OutboxItem;
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
                state.store.outbox_remove(item.id)?;
                // A letter going to wait says so once it has moved ("parked"), in one toast.
                let parking = crate::waiting::will_park(&item);
                state.emit(
                    "sent",
                    json!({ "id": item.id, "subject": item.draft.subject, "parking": parking }),
                );
                let message_id = message::parse_summary(&raw).message_id;
                let sent = state.store.folder_by_role(&account.id, FolderRole::Sent)?;
                let worker = state.worker(&account.id).ok();
                // Whether a waiting-for-a-reply may be added: the wait is countable and
                // cancellable only while its letter is in the cache. The client-side copy
                // is work of its own: the send round does not wait for it (a slow Sent
                // folder would hold the whole round up), and a failure is a task, not a
                // stalled send. The copy lands shortly after, so the wait is added as if
                // it were there.
                let mut letter_cached = true;
                if account.save_sent_copy && !account.is_ews() {
                    match (sent.as_ref(), worker.as_ref()) {
                        (Some(sent), Some(worker)) => {
                            worker.kick(Work::CopyToSent {
                                folder: sent.clone(),
                                // The wait below still parses the letter: the copy takes a copy.
                                raw: raw.clone(),
                                flags: "(\\Seen)".into(),
                                message_id: message_id.clone(),
                            });
                        }
                        // No Sent folder yet (or no worker): the copy cannot be made, so a wait
                        // could neither be shown nor cancelled. Say so and leave it out.
                        _ => {
                            letter_cached = false;
                            state.emit("app-error", json!({ "message": tr!("sent, but the Sent folder is unknown: the copy was not saved", "письмо отправлено, но папка «Отправленные» неизвестна: копия не сохранена") }));
                        }
                    }
                }
                // The letter answered or forwarded is marked, the wait for a reply starts.
                let parks = crate::waiting::after_sent(state, &account, &item, message_id, letter_cached).await?;
                if parking && !parks {
                    // Nothing to move after all (the letter left the inbox meanwhile): plain "sent".
                    state.emit("sent", json!({ "id": item.id, "subject": item.draft.subject }));
                }
                // The server keeps the copy itself (Exchange, Gmail): Sent is synced now, so the
                // answer joins its conversation at once, and again a moment later for servers
                // that file it with a delay.
                if (!account.save_sent_copy || account.is_ews())
                    && let Some(sent) = sent
                    && let Some(worker) = worker
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
