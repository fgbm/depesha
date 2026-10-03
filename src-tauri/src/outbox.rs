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
                if item.followup_secs > 0
                    && let Some(message_id) = message::parse_summary(&raw).message_id
                {
                    let sent = chrono::Utc::now().timestamp();
                    let recipients: Vec<String> = item
                        .draft
                        .to
                        .iter()
                        .chain(&item.draft.cc)
                        .map(|a| a.email.clone())
                        .collect();
                    state.store.followup_add(&Followup {
                        account_id: account.id.clone(),
                        message_id,
                        subject: item.draft.subject.clone(),
                        recipients: recipients.join(", "),
                        sent,
                        due: sent + item.followup_secs,
                    })?;
                    state.emit("counters-changed", json!({}));
                }
                // Exchange Web Services already put the copy into Sent Items.
                if account.save_sent_copy
                    && !account.is_ews()
                    && let Some(sent) = state.store.folder_by_role(&account.id, FolderRole::Sent)?
                    && let Ok(worker) = state.worker(&account.id)
                {
                    let message_id = message::parse_summary(&raw).message_id;
                    let work = Work::Append {
                        folder: sent,
                        raw,
                        flags: "(\\Seen)".into(),
                        message_id,
                    };
                    if let Err(e) = worker.run(work).await {
                        tracing::warn!(account = %account.id, "copy to Sent failed: {e}");
                        state.emit("app-error", json!({ "message": tr!("sent, but the copy was not saved to Sent: {e}", "письмо отправлено, но копия в «Отправленные» не сохранена: {e}") }));
                    }
                }
            }
            Err(e) => {
                let transient = e.is_transient();
                let delay = if e.kind() == "rate-limited" {
                    65
                } else {
                    (30_i64 << item.attempts.min(6)).min(1800)
                };
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
