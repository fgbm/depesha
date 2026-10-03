//! Timed work: snoozed mail coming back, reminders about sent mail without an answer.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::state::AppState;
use crate::worker::{Output, Work};

const TICK: Duration = Duration::from_secs(10);

pub async fn run(state: Arc<AppState>) {
    loop {
        tokio::select! {
            _ = state.scheduler_notify.notified() => {}
            _ = tokio::time::sleep(TICK) => {}
        }
        if let Err(e) = round(&state).await {
            tracing::warn!("scheduler: {e}");
        }
    }
}

async fn round(state: &AppState) -> depesha_core::Result<()> {
    let now = chrono::Utc::now().timestamp();
    for s in state.store.snoozes_due(now)? {
        let Ok(worker) = state.worker(&s.account_id) else {
            continue;
        };
        let work = Work::MoveByMessageId {
            from: s.folder.clone(),
            message_ids: vec![s.message_id.clone()],
            to: s.return_to.clone(),
            unseen: true,
        };
        match worker.run(work).await {
            Ok(Output::Count(0)) => {
                // Moved elsewhere by hand (another client): nothing to bring back.
                state.store.snooze_remove(&s.account_id, &s.message_id)?;
            }
            Ok(_) => {
                state.store.snooze_remove(&s.account_id, &s.message_id)?;
                let subject = if s.subject.is_empty() {
                    "(без темы)"
                } else {
                    s.subject.as_str()
                };
                state.notify("Вернулось отложенное письмо", subject, false);
            }
            // Offline or the account is paused: try again on the next tick.
            Err(e) => tracing::debug!(account = %s.account_id, "snooze return failed: {e}"),
        }
        state.emit("counters-changed", json!({}));
    }

    if state.store.followups_resolve()? > 0 {
        state.emit("counters-changed", json!({}));
    }
    for f in state.store.followups_due(now)? {
        let subject = if f.subject.is_empty() {
            "(без темы)"
        } else {
            f.subject.as_str()
        };
        state.notify("Нет ответа", &format!("{subject} — {}", f.recipients), false);
        state.emit("counters-changed", json!({}));
    }
    Ok(())
}
