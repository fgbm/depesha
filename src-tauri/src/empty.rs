//! «Clear» for Trash, Junk and Drafts (#74). The folder is emptied on the server, all of it
//! and not only the window the cache loaded, in batches in the mailbox's queue: the tasks
//! window shows «N of M» with «Stop», a failure stops the run and leaves a summary to retry.
//! Trash and Junk are wiped; Drafts go to Trash, except the draft a window has open, and
//! the local copies of the drafts that left are dropped with them (a copy that never
//! reached the server stays: it is the only text there is). A run touches only what the
//! dialog counted (`Bound`): a letter that arrives meanwhile is not wiped.

use depesha_core::account::Account;
use depesha_core::imap::FolderRole;
use depesha_core::lang::pick;
use depesha_core::mail::{self, Bound, Conn, EMPTY_BATCH, Emptied, Emptying};
use depesha_core::{Result, tr};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::drafts::CachedDraft;
use crate::error::CmdError;
use crate::state::AppState;
use crate::worker::{Output, Work, clone_error, sync_one};

/// One emptying, as the mailbox's queue gets it.
#[derive(Debug, Clone)]
pub struct Request {
    pub folder: String,
    pub how: Emptying,
    /// What the dialog counted: nothing else is touched.
    pub bound: Bound,
    /// Cached UIDs that stay: the drafts open in a window.
    pub keep: Vec<u32>,
    /// The task's name in the tasks window.
    pub label: String,
    pub key: String,
}

/// Bounds held at most, oldest dropped: an exchange snapshot is a list of every item id.
const BOUNDS_HELD: usize = 8;

/// What the backend knows about the clearings: the drafts that windows have open, and the
/// bounds the dialogs counted.
#[derive(Default)]
pub struct Clearing {
    /// Drafts open in a window, by the window's label: `(local_id, cache id of its server copy)`.
    /// A window reports them as it opens a composition, saves it and closes it, and the
    /// window's entry goes with it, so a letter's window the main one does not see is still
    /// spared (#74, decision 3.2 A).
    open: Mutex<HashMap<String, Vec<(String, i64)>>>,
    bounds: Mutex<HashMap<u64, HeldBound>>,
    seq: AtomicU64,
}

struct HeldBound {
    account_id: String,
    folder: String,
    bound: Bound,
}

/// What the dialog is told of the folder: how many letters it holds and the bound that
/// counted them, which the run is then asked for.
#[derive(Serialize)]
pub struct FolderCount {
    pub total: usize,
    pub bound: u64,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Clearing {
    /// A window says which server draft its composition `local_id` is now (`None`: none).
    pub fn draft_set(&self, label: &str, local_id: &str, draft_id: Option<i64>) {
        let mut open = lock(&self.open);
        let list = open.entry(label.to_owned()).or_default();
        list.retain(|(l, _)| l != local_id);
        if let Some(id) = draft_id {
            list.push((local_id.to_owned(), id));
        }
        if list.is_empty() {
            open.remove(label);
        }
    }

    /// The window is gone, and its drafts are no longer open.
    pub fn window_gone(&self, label: &str) {
        lock(&self.open).remove(label);
    }

    /// The cache ids of the drafts open in any window.
    pub fn open_ids(&self) -> Vec<i64> {
        let mut ids: Vec<i64> = lock(&self.open).values().flatten().map(|(_, id)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    /// Keeps the bound of a count; the number it is asked for by is returned.
    pub fn hold(&self, account_id: &str, folder: &str, bound: Bound) -> u64 {
        let token = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut held = lock(&self.bounds);
        // A newer count of the same folder replaces the older one.
        held.retain(|_, h| !(h.account_id == account_id && h.folder == folder));
        held.insert(
            token,
            HeldBound {
                account_id: account_id.to_owned(),
                folder: folder.to_owned(),
                bound,
            },
        );
        while held.len() > BOUNDS_HELD {
            let Some(oldest) = held.keys().min().copied() else {
                break;
            };
            held.remove(&oldest);
        }
        token
    }

    fn bound(&self, token: u64, account_id: &str, folder: &str) -> Option<Bound> {
        lock(&self.bounds)
            .get(&token)
            .filter(|h| h.account_id == account_id && h.folder == folder)
            .map(|h| h.bound.clone())
    }

    fn release(&self, token: u64) {
        lock(&self.bounds).remove(&token);
    }
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
            &req.bound,
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
/// drafts that windows have open, which stay with the ones the backend knows are open
/// (`Clearing::open_ids`). `bound` is what the dialog counted (`FolderCount`).
pub async fn run(
    state: &AppState,
    account_id: &str,
    folder: &str,
    role: FolderRole,
    trash: Option<String>,
    mut keep_ids: Vec<i64>,
    bound: u64,
) -> std::result::Result<Emptied, CmdError> {
    require_online(state, account_id)?;
    let drafts = role == FolderRole::Drafts;
    let how = match (drafts, trash) {
        (true, Some(to)) => Emptying::ToFolder(to),
        // Drafts are put in Trash (reversible), never wiped for lack of one.
        (true, None) => {
            return Err(CmdError::new(
                "other",
                tr!(
                    "there is no Trash to move the drafts to",
                    "нет Корзины, куда убрать черновики"
                ),
            ));
        }
        (false, _) => Emptying::Erase,
    };
    let held = state.clearing.bound(bound, account_id, folder).ok_or_else(|| {
        CmdError::new(
            "other",
            tr!(
                "the list to clear is out of date, clear the folder again",
                "список для очистки устарел, очистите папку заново"
            ),
        )
    })?;
    // A window the main one does not see may have a draft open: the backend's own record counts.
    for id in state.clearing.open_ids() {
        if !keep_ids.contains(&id) {
            keep_ids.push(id);
        }
    }
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
        bound: held,
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
    if !run.stopped {
        state.clearing.release(bound);
    }
    if drafts && !run.stopped {
        crate::drafts::drop_all(&state.app, &leaving).await?;
    }
    Ok(run)
}

/// How many drafts of the mailbox's Drafts folder windows have open: the number the dialog
/// says will stay.
pub fn open_drafts(state: &AppState, account_id: &str) -> usize {
    let folder = state
        .store
        .folder_by_role(account_id, FolderRole::Drafts)
        .ok()
        .flatten();
    let Some(folder) = folder else { return 0 };
    state
        .clearing
        .open_ids()
        .into_iter()
        .filter(|id| {
            state
                .store
                .get_at(*id)
                .ok()
                .flatten()
                .is_some_and(|(r, _)| r.account_id == account_id && r.folder == folder)
        })
        .count()
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
    fn drafts_open_in_any_window_are_known_until_it_closes_or_goes() {
        let c = Clearing::default();
        // The main window and a letter's window each have one; a save moves a window's draft.
        c.draft_set("main", "k1", Some(7));
        c.draft_set("message-3", "k2", Some(9));
        assert_eq!(c.open_ids(), [7, 9]);
        c.draft_set("message-3", "k2", Some(12));
        assert_eq!(c.open_ids(), [7, 12]);
        // The composition closes (or is sent): its draft is no longer spared.
        c.draft_set("main", "k1", None);
        assert_eq!(c.open_ids(), [12]);
        // The window goes with its compositions open: nothing of it is remembered.
        c.window_gone("message-3");
        assert!(c.open_ids().is_empty());
    }

    #[test]
    fn a_bound_is_kept_for_a_retry_and_a_newer_count_of_the_folder_replaces_it() {
        let c = Clearing::default();
        let first = c.hold("a", "Trash", Bound::Imap { validity: 1, next: 10 });
        let spam = c.hold("a", "Spam", Bound::Items(vec!["x".into()]));
        assert_eq!(
            c.bound(first, "a", "Trash"),
            Some(Bound::Imap { validity: 1, next: 10 })
        );
        // A number is good for the folder it was counted for and no other.
        assert_eq!(c.bound(first, "a", "Spam"), None);
        assert_eq!(c.bound(first, "b", "Trash"), None);
        let again = c.hold("a", "Trash", Bound::Imap { validity: 1, next: 20 });
        assert_eq!(c.bound(first, "a", "Trash"), None, "the older count is gone");
        assert!(c.bound(again, "a", "Trash").is_some());
        assert!(c.bound(spam, "a", "Spam").is_some(), "another folder's count stays");
        c.release(again);
        assert_eq!(c.bound(again, "a", "Trash"), None);
        // Only a few are held: the oldest goes first.
        let held: Vec<u64> = (0..BOUNDS_HELD + 2)
            .map(|n| c.hold("a", &format!("F{n}"), Bound::Items(Vec::new())))
            .collect();
        assert_eq!(c.bound(held[0], "a", "F0"), None);
        assert!(
            c.bound(*held.last().unwrap(), "a", &format!("F{}", BOUNDS_HELD + 1))
                .is_some()
        );
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
