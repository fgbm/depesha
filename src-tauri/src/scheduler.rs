//! Timed work: snoozed mail coming back, reminders about sent mail without an answer.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::followups;
use crate::state::AppState;
use crate::worker::{Output, Work};
use depesha_core::lang::pick;

const TICK: Duration = Duration::from_secs(10);
/// Closed waits for an answer are forgotten in days: an hour apart is soon enough.
const PRUNE_EVERY: Duration = Duration::from_secs(3600);

pub async fn run(state: Arc<AppState>) {
    let mut pruned: Option<Instant> = None;
    loop {
        tokio::select! {
            _ = state.scheduler_notify.notified() => {}
            _ = tokio::time::sleep(TICK) => {}
        }
        if pruned.is_none_or(|t| t.elapsed() >= PRUNE_EVERY) {
            pruned = Some(Instant::now());
            match followups::prune(&state, chrono::Utc::now().timestamp()) {
                Ok(true) => state.emit("counters-changed", json!({})),
                Ok(false) => {}
                Err(e) => tracing::warn!("scheduler: {e}"),
            }
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
        match worker.run_background(work).await {
            Ok(Output::Count(0)) => {
                // Moved elsewhere by hand (another client): nothing to bring back.
                state.store.snooze_remove(&s.account_id, &s.message_id)?;
            }
            Ok(_) => {
                state.store.snooze_remove(&s.account_id, &s.message_id)?;
                let subject = if s.subject.is_empty() {
                    pick("(no subject)", "(без темы)")
                } else {
                    s.subject.as_str()
                };
                state.notify(
                    pick("A snoozed message is back", "Вернулось отложенное письмо"),
                    subject,
                    false,
                );
            }
            // Offline or the account is paused: try again on the next tick.
            Err(e) => tracing::debug!(account = %s.account_id, "snooze return failed: {e}"),
        }
        state.emit("counters-changed", json!({}));
    }

    if state.store.followups_resolve()? > 0 {
        state.emit("counters-changed", json!({}));
    }
    // Letters to the folder "Waiting for reply" after an answer, and back with the reply.
    crate::waiting::round(state).await;
    for f in state.store.followups_due(now)? {
        let subject = if f.subject.is_empty() {
            pick("(no subject)", "(без темы)")
        } else {
            f.subject.as_str()
        };
        state.notify(
            pick("No answer yet", "Нет ответа"),
            &format!("{subject} — {}", f.recipients),
            false,
        );
        // The notification cannot open the letter: the app offers to, in a toast.
        state.emit(
            "followup-due",
            json!({ "account_id": f.account_id, "message_id": f.message_id, "subject": f.subject }),
        );
        state.emit("counters-changed", json!({}));
    }
    Ok(())
}
