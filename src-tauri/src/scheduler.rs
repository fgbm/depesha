//! Timed work: snoozed mail coming back, reminders about sent mail without an answer.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::followups;
use crate::state::AppState;
use crate::worker::{Output, Work};
use depesha_core::lang::pick;
use depesha_core::snooze;

const TICK: Duration = Duration::from_secs(10);
/// Closed waits for an answer are forgotten in days: an hour apart is soon enough.
const PRUNE_EVERY: Duration = Duration::from_secs(3600);
/// The waits that got an answer are re-read on a folder sync; this is the fallback.
const RESOLVE_EVERY: Duration = Duration::from_secs(3 * 60);
/// How many mailboxes the background touches at once: one that hangs or is offline must
/// not hold the others up, and a handful at a time keeps the server side calm.
pub(crate) const ACCOUNTS_AT_ONCE: usize = 4;

pub async fn run(state: Arc<AppState>) {
    let mut pruned: Option<Instant> = None;
    let mut resolved: Option<Instant> = None;
    loop {
        // An event is a folder sync that brought mail (or a park to do): the waits that
        // got an answer are re-read then; the timer is only the fallback.
        let event = tokio::select! {
            _ = state.scheduler_notify.notified() => true,
            _ = tokio::time::sleep(TICK) => false,
        };
        if pruned.is_none_or(|t| t.elapsed() >= PRUNE_EVERY) {
            pruned = Some(Instant::now());
            match followups::prune(&state, chrono::Utc::now().timestamp()) {
                Ok(true) => state.emit("counters-changed", json!({})),
                Ok(false) => {}
                Err(e) => tracing::warn!("scheduler: {e}"),
            }
        }
        let resolve = event || resolved.is_none_or(|t| t.elapsed() >= RESOLVE_EVERY);
        if resolve {
            resolved = Some(Instant::now());
        }
        if let Err(e) = round(state.clone(), resolve).await {
            tracing::warn!("scheduler: {e}");
        }
    }
}

async fn round(state: Arc<AppState>, resolve: bool) -> depesha_core::Result<()> {
    let now = chrono::Utc::now().timestamp();
    // A label whose strip was held back by a pause or an offline mailbox is resumed here.
    crate::label_strip::resume_all(&state);
    // By mailbox: one that hangs or is offline must not hold the others' snoozes up.
    let due = snooze::due_by_account(&state.store, now)?;
    run_bounded(ACCOUNTS_AT_ONCE, due.into_values().collect(), |due| {
        let state = state.clone();
        async move { return_snoozes(&state, due).await }
    })
    .await;
    if resolve && state.store.followups_resolve()? > 0 {
        state.emit("counters-changed", json!({}));
    }
    // Letters to the folder "Waiting for reply" after an answer, and back with the reply.
    crate::waiting::round(state.clone()).await;
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

/// Brings one mailbox's due snoozes back, one after another; the mailboxes run in parallel.
async fn return_snoozes(state: &AppState, due: Vec<depesha_core::store::Snooze>) {
    let Some(account_id) = due.first().map(|s| s.account_id.clone()) else {
        return;
    };
    // The user is told of each letter as soon as it is back, not after the whole batch.
    let mut on_back = |s: &depesha_core::store::Snooze| {
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
    };
    let returned = snooze::return_due(
        &state.store,
        &due,
        |bring| {
            let worker = state.worker(&account_id);
            async move {
                let work = Work::MoveByMessageId {
                    from: bring.from,
                    message_ids: bring.message_ids,
                    to: bring.to,
                    unseen: bring.unseen,
                };
                // Offline or the account is paused: tried again on the next tick.
                match worker?.run_background(work).await? {
                    Output::Count(n) => Ok::<usize, crate::error::CmdError>(n),
                    _ => Ok(1),
                }
            }
        },
        &mut on_back,
    )
    .await;
    for e in &returned.not_dropped {
        tracing::warn!("scheduler: {e}");
    }
    for e in &returned.failed {
        tracing::debug!(account = %account_id, "snooze return failed: {}", e.message);
    }
    if returned.changed {
        state.emit("counters-changed", json!({}));
    }
}

/// Runs per-mailbox jobs at most `limit` at a time, each on its own task: one mailbox that
/// hangs or is offline must not hold the others. Returns the outputs of the jobs that
/// finished (a task that panicked is left out).
pub(crate) async fn run_bounded<T, O, F, Fut>(limit: usize, jobs: Vec<T>, run: F) -> Vec<O>
where
    T: Send + 'static,
    O: Send + 'static,
    F: Fn(T) -> Fut,
    Fut: std::future::Future<Output = O> + Send + 'static,
{
    let limit = limit.max(1);
    let mut set = tokio::task::JoinSet::new();
    let mut out = Vec::new();
    for job in jobs {
        set.spawn(run(job));
        while set.len() >= limit {
            if let Some(Ok(o)) = set.join_next().await {
                out.push(o);
            }
        }
    }
    while let Some(joined) = set.join_next().await {
        if let Ok(o) = joined {
            out.push(o);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn mailboxes_run_a_few_at_a_time() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicUsize::new(0));
        let (r, p, d) = (running.clone(), peak.clone(), done.clone());
        run_bounded(2, (0..6).collect::<Vec<usize>>(), move |_| {
            let (r, p, d) = (r.clone(), p.clone(), d.clone());
            async move {
                let now = r.fetch_add(1, Ordering::SeqCst) + 1;
                p.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                r.fetch_sub(1, Ordering::SeqCst);
                d.fetch_add(1, Ordering::SeqCst);
            }
        })
        .await;
        // Every job ran, and no more than the limit were in flight at once.
        assert_eq!(done.load(Ordering::SeqCst), 6);
        assert!(peak.load(Ordering::SeqCst) <= 2);
        assert!(peak.load(Ordering::SeqCst) >= 1);
    }

    #[tokio::test]
    async fn a_finished_job_comes_back() {
        let out = run_bounded(2, vec![1, 2, 3], |n| async move { n * 10 }).await;
        let mut sorted = out;
        sorted.sort();
        assert_eq!(sorted, [10, 20, 30]);
    }
}
