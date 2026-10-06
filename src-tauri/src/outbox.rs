//! Sends queued messages one by one. Transient failures (network, SMTP 4xx,
//! the Exchange rate limit) are retried later; permanent ones wait for the user.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use depesha_core::imap::FolderRole;
use depesha_core::store::Followup;
use depesha_core::{mail, message, smtp};
use serde_json::json;

use crate::error::CmdError;
use crate::state::AppState;
use crate::worker::Work;
use depesha_core::tr;

pub async fn run(state: Arc<AppState>) {
    loop {
        // Wake exactly when the next message is due: the undo window and scheduled
        // sending are measured in seconds.
        let now = chrono::Utc::now().timestamp();
        let next = state
            .store
            .outbox()
            .ok()
            .and_then(|items| items.iter().filter(|i| !i.failed).map(|i| i.next_attempt).min())
            .map(|t| (t - now).clamp(0, 15) as u64)
            .unwrap_or(15);
        tokio::select! {
            _ = state.outbox_notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(next)) => {}
        }
        if let Err(e) = round(&state).await {
            tracing::error!("outbox: {}", e.message);
        }
    }
}

async fn round(state: &AppState) -> Result<(), CmdError> {
    let now = chrono::Utc::now().timestamp();
    let mut blocked = HashSet::new();
    for item in state.store.outbox()? {
        if item.failed || item.next_attempt > now || blocked.contains(&item.account_id) {
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
                state.emit("sent", json!({ "id": item.id, "subject": item.draft.subject }));
                let message_id = message::parse_summary(&raw).message_id;
                let sent = state.store.folder_by_role(&account.id, FolderRole::Sent)?;
                let worker = state.worker(&account.id).ok();
                // Whether a waiting-for-a-reply may be added: the wait is countable and
                // cancellable only while its letter is in the cache. A server that keeps its
                // own copy (Exchange, Gmail) files it, and the Sent sync below brings it; a
                // client-side copy is appended here, and the append syncs the folder.
                let mut letter_cached = true;
                if account.save_sent_copy && !account.is_ews() {
                    match (sent.as_ref(), worker.as_ref()) {
                        (Some(sent), Some(worker)) => {
                            let work = Work::Append {
                                folder: sent.clone(),
                                // The wait below still parses the letter: the copy takes a copy.
                                raw: raw.clone(),
                                flags: "(\\Seen)".into(),
                                message_id: message_id.clone(),
                            };
                            let copied = worker.run_background(work).await;
                            if let Err(e) = &copied {
                                tracing::warn!(account = %account.id, "copy to Sent failed: {e}");
                            }
                            // A wait whose letter never arrived would show badge 0 and could not
                            // be cancelled. The copy may have landed after a failed append, and a
                            // good one may be missing when the sync after it failed: look, and
                            // sync Sent once more if it is not there.
                            letter_cached = match &message_id {
                                Some(mid) => {
                                    state.store.find_any_by_message_id(&account.id, mid)?.is_some()
                                        || (worker.run_background(Work::SyncFolder(sent.clone())).await.is_ok()
                                            && state.store.find_any_by_message_id(&account.id, mid)?.is_some())
                                }
                                None => copied.is_ok(),
                            };
                            // Only a failed append is a copy not saved: a good one is on the
                            // server whether or not the cache has it yet.
                            if let Err(e) = copied
                                && !letter_cached
                            {
                                state.emit("app-error", json!({ "message": tr!("sent, but the copy was not saved to Sent: {e}", "письмо отправлено, но копия в «Отправленные» не сохранена: {e}") }));
                            }
                        }
                        // No Sent folder yet (or no worker): the copy cannot be made, so a wait
                        // could neither be shown nor cancelled. Say so and leave it out.
                        _ => {
                            letter_cached = false;
                            state.emit("app-error", json!({ "message": tr!("sent, but the Sent folder is unknown: the copy was not saved", "письмо отправлено, но папка «Отправленные» неизвестна: копия не сохранена") }));
                        }
                    }
                }
                if item.followup_secs > 0
                    && letter_cached
                    && let Some(message_id) = message_id
                {
                    state.store.followup_add(&Followup::after_sending(
                        &account.id,
                        message_id,
                        &item.draft,
                        chrono::Utc::now().timestamp(),
                        item.followup_secs,
                        &item.followup,
                    ))?;
                    state.emit("counters-changed", json!({}));
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
                blocked.insert(item.account_id.clone());
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
