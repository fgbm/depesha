//! Taking a label off every letter of the mailbox (#42, frame 4Б), one folder per work in
//! the mailbox's quiet queue: a whole-account walk is not one queue item that holds the
//! mailbox for minutes, a folder without rights is skipped and remembered, and the label
//! stays in the list as "being removed" until every folder is done — so a restart or a
//! pause resumes the debt instead of losing it.

use std::sync::Arc;

use serde_json::json;

use crate::lang::pick;
use depesha_core::label_strip::{self, Ended};

use crate::error::CmdError;
use crate::state::AppState;
use crate::worker::Queue;

/// Starts the strip of every label marked as being removed, of every account; one already
/// running is left alone. Called at startup and on each scheduler round, so a debt left by
/// a restart or a pause is picked up rather than lost.
pub fn resume_all(state: &Arc<AppState>) {
    let now = chrono::Utc::now().timestamp();
    for account in state.accounts() {
        let online = state.status(&account.id).is_some_and(|s| s.state == "online");
        let Ok(labels) = label_strip::resumable(&state.store, &state.label_strip, &account.id, online, now) else {
            continue;
        };
        for (name, keyword) in labels {
            start(state, &account.id, &name, &keyword);
        }
    }
}

/// Starts the strip of one label unless it is running already.
pub fn start(state: &Arc<AppState>, account_id: &str, name: &str, keyword: &str) {
    let Some(running) = state
        .label_strip
        .claim(account_id, name, chrono::Utc::now().timestamp())
    else {
        return;
    };
    let state = state.clone();
    let (account_id, name, keyword) = (account_id.to_owned(), name.to_owned(), keyword.to_owned());
    tauri::async_runtime::spawn(async move {
        run(&state, &account_id, &name, &keyword).await;
        drop(running);
    });
}

/// Takes the keyword off every folder of the mailbox (`label_strip::strip`) and reports the
/// outcome in the tasks window. A pause or an offline mailbox keeps the debt for the next
/// round; a folder without rights is skipped and named, the rest is cleaned, and the label
/// then leaves the list.
async fn run(state: &AppState, account_id: &str, name: &str, keyword: &str) {
    let task = format!("labels:{account_id}");
    let label = pick("Taking the label off all letters", "Снятие метки со всех писем");
    let mut queue = Queue::background(state, account_id).ok();
    let ended = label_strip::strip(
        &state.store,
        &state.label_strip,
        queue.as_mut(),
        account_id,
        name,
        keyword,
        &|| chrono::Utc::now().timestamp(),
        &mut |done, total| state.task(&task, "labels", Some(account_id), label.to_owned(), done, total),
    )
    .await;
    match ended {
        Err(e) => tracing::warn!(account = %account_id, "label strip: {e}"),
        Ok(Ended::Waiting {
            silent,
            count,
            done,
            total,
        }) => {
            // The debt stays (the row keeps `stripping`): a later round resumes it.
            if silent {
                // Nothing changed since the last try: no events, no new red task.
                return;
            }
            if count > 0 {
                state.task(&task, "labels", Some(account_id), label.to_owned(), done, total);
            }
            state.task_failed(
                &task,
                CmdError::new(
                    depesha_core::ErrorKind::Network,
                    pick(
                        "The label is still being taken off; it will be tried again",
                        "Метку ещё снимаем; попробуем снова",
                    ),
                ),
            );
            if count > 0 {
                tell(state, account_id);
            }
        }
        Ok(Ended::Finished {
            count,
            skipped,
            not_cleaned,
        }) => {
            for e in not_cleaned {
                tracing::warn!(account = %account_id, "label strip: the cache was not cleaned: {e}");
            }
            if skipped.is_empty() {
                state.task_done(&task);
            } else {
                state.task_failed(
                    &task,
                    CmdError::new(depesha_core::ErrorKind::Other, skipped_text(&skipped)),
                );
            }
            tell(state, account_id);
            tracing::debug!(account = %account_id, "took a label off {count} letters");
        }
    }
}

/// The folders that refused and why, in the language of the interface.
fn skipped_text(skipped: &[(String, depesha_core::Error)]) -> String {
    skipped
        .iter()
        .map(|(folder, e)| format!("{folder}: {}", crate::localize::error_now(e)))
        .collect::<Vec<_>>()
        .join("; ")
}

fn tell(state: &AppState, account_id: &str) {
    state.emit("labels-changed", json!({ "account_id": account_id }));
    state.emit("mail-changed", json!({ "account_id": account_id }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lang::{self, Lang};
    use depesha_core::Error;

    #[test]
    fn a_folder_that_refused_is_told_in_the_language_of_the_interface() {
        let ended = depesha_core::label_strip::Ended::Finished {
            count: 3,
            skipped: vec![(
                "Shared/Team".into(),
                Error::Imap(async_imap::error::Error::No("code: Some(NOPERM)".into())),
            )],
            not_cleaned: Vec::new(),
        };
        let depesha_core::label_strip::Ended::Finished { skipped, .. } = ended else {
            unreachable!()
        };
        lang::pin(Lang::Ru);
        assert_eq!(
            skipped_text(&skipped),
            "Shared/Team: IMAP: сервер отказал: code: Some(NOPERM)"
        );
        lang::pin(Lang::En);
        assert_eq!(skipped_text(&skipped), "Shared/Team: IMAP: refused: code: Some(NOPERM)");
    }
}
