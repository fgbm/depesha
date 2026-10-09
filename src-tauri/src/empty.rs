//! «Clear» for Trash, Junk and Drafts (#74). The folder is emptied on the server, all of it
//! and not only the window the cache loaded, in batches in the mailbox's queue: the tasks
//! window shows «N of M» with «Stop», a failure stops the run and leaves a summary to retry.
//! Trash and Junk are wiped; Drafts go to Trash, except the draft a window has open, and
//! the local copies of the drafts that left are dropped with them (a copy that never
//! reached the server stays: it is the only text there is).

use depesha_core::account::Account;
use depesha_core::imap::FolderRole;
use depesha_core::lang::pick;
use depesha_core::mail::{self, Conn, EMPTY_BATCH, Emptied, Emptying};
use depesha_core::{Result, tr};
use serde_json::json;

use crate::drafts::CachedDraft;
use crate::error::CmdError;
use crate::state::AppState;
use crate::worker::{Output, Work, clone_error, sync_one};

/// One emptying, as the mailbox's queue gets it.
#[derive(Debug, Clone)]
pub struct Request {
    pub folder: String,
    pub how: Emptying,
    /// Cached UIDs that stay: the drafts open in a window.
    pub keep: Vec<u32>,
    /// The task's name in the tasks window.
    pub label: String,
    pub key: String,
}

/// The task key: the tasks window retries by it, so it names the folder.
pub fn task_key(account_id: &str, folder: &str) -> String {
    format!("empty:{account_id}:{folder}")
}

pub fn label(role: FolderRole) -> String {
    match role {
        FolderRole::Trash => pick("Clearing Trash", "Очистка корзины").to_owned(),
        FolderRole::Junk => pick("Clearing Spam", "Очистка спама").to_owned(),
        _ => pick("Clearing Drafts", "Очистка черновиков").to_owned(),
    }
}

/// What the tasks window says about a run that failed: how far it got, how much is left, why.
pub fn summary(how: &Emptying, done: usize, total: usize, error: &str) -> String {
    let left = total.saturating_sub(done);
    match how {
        Emptying::Erase => tr!(
            "Erased {done} of {total}, {left} left. {error}",
            "Стёрто {done} из {total}, осталось {left}. {error}"
        ),
        Emptying::ToFolder(_) => tr!(
            "Moved {done} of {total}, {left} left. {error}",
            "Перенесено {done} из {total}, осталось {left}. {error}"
        ),
    }
}

/// Runs in the mailbox's queue (`Work::EmptyFolder`).
pub async fn perform(state: &AppState, account: &Account, conn: &mut Conn, req: &Request) -> Result<Output> {
    let id = account.id.as_str();
    let key = req.key.as_str();
    state.task_stop_clear(key);
    state.task(key, "empty", Some(id), req.label.clone(), 0, 0);
    let mut last = (0usize, 0usize);
    let mut forgotten = false;
    let run = {
        let mut step = |done: usize, total: usize| {
            last = (done, total);
            // The counters drop to zero when the erasing begins, not before: the sync after
            // the run brings back whatever was left (a stop, a failure).
            if !forgotten && total > 0 {
                forgotten = true;
                forget_cached(state, id, &req.folder, &req.keep);
            }
            state.task(key, "empty", Some(id), req.label.clone(), done as u64, total as u64);
            !state.task_stop_requested(key)
        };
        mail::empty_folder(
            conn,
            &state.store,
            id,
            &req.folder,
            &req.how,
            &req.keep,
            EMPTY_BATCH,
            &mut step,
        )
        .await
    };
    state.task_stop_clear(key);
    // The cache follows the server whatever came of the run.
    let mut synced = vec![&req.folder];
    if let Emptying::ToFolder(to) = &req.how {
        synced.push(to);
    }
    for folder in synced {
        if let Err(e) = sync_one(state, account, conn, folder, false).await {
            tracing::warn!(account = %id, "sync of {folder} after clearing failed: {e}");
        }
    }
    match run {
        Ok(run) => {
            state.task_done(key);
            Ok(Output::Emptied(run))
        }
        Err(e) => {
            let mut shown = CmdError::from(clone_error(&e));
            shown.message = summary(&req.how, last.0, last.1, &e.to_string());
            state.task_failed(key, shown);
            Err(e)
        }
    }
}

/// Takes the folder's cached letters out of the cache (but `keep`) and tells the lists and
/// the counters, so the folder shows empty while the server catches up.
fn forget_cached(state: &AppState, account_id: &str, folder: &str, keep: &[u32]) {
    let gone = match state.store.known_uids(account_id, folder) {
        Ok(known) => known.into_iter().filter(|u| !keep.contains(u)).collect::<Vec<_>>(),
        Err(e) => {
            tracing::warn!(account = %account_id, "cache of {folder} not read: {e}");
            return;
        }
    };
    if let Err(e) = state.store.remove_uids(account_id, folder, &gone) {
        tracing::warn!(account = %account_id, "cache of {folder} not cleared: {e}");
        return;
    }
    state.emit("mail-changed", json!({ "account_id": account_id, "folder": folder }));
    state.emit("counters-changed", json!({}));
}

/// The local copies that continue a server draft of `folder` that is about to leave it:
/// the keys to drop once it has. A copy without a server draft, or whose draft stays
/// (`keep_ids`, the open windows), is not among them. `row_of` tells where a cache id
/// stands now: its folder and Message-ID.
pub fn copies_following(
    copies: &[CachedDraft],
    account_id: &str,
    folder: &str,
    keep_ids: &[i64],
    row_of: impl Fn(i64) -> Option<(String, Option<String>)>,
) -> Vec<String> {
    let bare = |m: &str| m.trim().trim_matches(['<', '>']).to_owned();
    copies
        .iter()
        .filter(|c| c.account_id == account_id)
        .filter_map(|c| {
            let draft_id = c.draft_id?;
            if keep_ids.contains(&draft_id) {
                return None;
            }
            let (row_folder, row_mid) = row_of(draft_id)?;
            // The number may have been handed out again to another draft (#92).
            let same = match (&c.draft_message_id, &row_mid) {
                (Some(a), Some(b)) => bare(a) == bare(b),
                _ => true,
            };
            (row_folder == folder && same).then(|| c.key.clone())
        })
        .collect()
}

/// The role of a folder that «Clear» is offered for; anything else is refused.
pub fn role_of(state: &AppState, account_id: &str, folder: &str) -> std::result::Result<FolderRole, CmdError> {
    [FolderRole::Trash, FolderRole::Junk, FolderRole::Drafts]
        .into_iter()
        .find(|role| {
            state
                .store
                .folder_by_role(account_id, *role)
                .ok()
                .flatten()
                .is_some_and(|f| f == folder)
        })
        .ok_or_else(|| {
            CmdError::new(
                "other",
                tr!(
                    "only Trash, Spam and Drafts can be cleared",
                    "очистить можно только Корзину, Спам и Черновики"
                ),
            )
        })
}

/// Empties the folder. `trash` is where Drafts go; `keep_ids` are the cache ids of the
/// drafts that windows have open, which stay.
pub async fn run(
    state: &AppState,
    account_id: &str,
    folder: &str,
    role: FolderRole,
    trash: Option<String>,
    keep_ids: Vec<i64>,
) -> std::result::Result<Emptied, CmdError> {
    require_online(state, account_id)?;
    let drafts = role == FolderRole::Drafts;
    let how = match trash {
        Some(to) if drafts => Emptying::ToFolder(to),
        _ => Emptying::Erase,
    };
    // Cached UIDs of the open drafts; a number that names no draft of this folder is ignored.
    let mut keep = Vec::new();
    let mut copies = Vec::new();
    if drafts {
        for id in &keep_ids {
            if let Some((row, _)) = state.store.get_at(*id)?
                && row.account_id == account_id
                && row.folder == folder
            {
                keep.push(row.uid);
            }
        }
        copies = crate::drafts::read_all(&crate::drafts::dir(&state.app)?).await?;
    }
    let leaving = copies_following(&copies, account_id, folder, &keep_ids, |id| {
        state
            .store
            .get_at(id)
            .ok()
            .flatten()
            .filter(|(r, _)| r.account_id == account_id)
            .map(|(r, _)| (r.folder, r.message_id))
    });
    let request = Request {
        folder: folder.to_owned(),
        how,
        keep,
        label: label(role),
        key: task_key(account_id, folder),
    };
    let run = match state.worker(account_id)?.run(Work::EmptyFolder(request)).await? {
        Output::Emptied(run) => run,
        _ => Emptied::default(),
    };
    // Only a finished run takes the copies with it: after a stop the drafts left in the folder
    // keep theirs.
    if drafts && !run.stopped {
        crate::drafts::drop_all(&state.app, &leaving).await?;
    }
    Ok(run)
}

/// A run that began is refused while the mailbox is not online: the queue would hold an
/// irreversible action for as long as the network is down.
pub fn require_online(state: &AppState, account_id: &str) -> std::result::Result<(), CmdError> {
    if state.status(account_id).is_some_and(|s| s.state == "online") {
        return Ok(());
    }
    Err(CmdError::new(
        "network",
        tr!("no connection to the server", "нет соединения с сервером"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn copy(key: &str, draft_id: Option<i64>, mid: Option<&str>) -> CachedDraft {
        CachedDraft {
            key: key.into(),
            account_id: "a".into(),
            draft: json!({}),
            draft_id,
            draft_message_id: mid.map(str::to_owned),
            updated: 1,
        }
    }

    #[test]
    fn only_copies_of_leaving_server_drafts_follow_them() {
        let copies = vec![
            copy("linked", Some(1), Some("x@depesha.local")),
            copy("open", Some(2), None),
            copy("local-only", None, None),
            copy("reused-number", Some(3), Some("old@depesha.local")),
            copy("elsewhere", Some(4), None),
            copy("no-mid-recorded", Some(5), None),
        ];
        let rows = |id: i64| match id {
            1 => Some(("Drafts".to_owned(), Some("x@depesha.local".to_owned()))),
            2 => Some(("Drafts".to_owned(), None)),
            3 => Some(("Drafts".to_owned(), Some("new@depesha.local".to_owned()))),
            4 => Some(("INBOX".to_owned(), None)),
            5 => Some(("Drafts".to_owned(), Some("y@depesha.local".to_owned()))),
            _ => None,
        };
        let keys = copies_following(&copies, "a", "Drafts", &[2], rows);
        assert_eq!(keys, ["linked", "no-mid-recorded"]);
        // Another mailbox's copies are never touched.
        assert!(copies_following(&copies, "b", "Drafts", &[], rows).is_empty());
    }

    #[test]
    fn a_failed_run_says_how_far_it_got_and_what_is_left() {
        pick_lang_ru();
        assert_eq!(
            summary(&Emptying::Erase, 1200, 2100, "превышено время ожидания"),
            "Стёрто 1200 из 2100, осталось 900. превышено время ожидания"
        );
        assert_eq!(
            summary(&Emptying::ToFolder("Trash".into()), 3, 4, "x"),
            "Перенесено 3 из 4, осталось 1. x"
        );
    }

    fn pick_lang_ru() {
        depesha_core::lang::pin(depesha_core::lang::Lang::Ru);
    }
}
