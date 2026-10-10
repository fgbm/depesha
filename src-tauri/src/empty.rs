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
use depesha_core::store::Store;
use depesha_core::{Result, tr};
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
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
    /// Cache ids of the drafts the calling window has open, on top of the backend's own record
    /// (`Clearing`). Read when the erasing begins, not when it is asked for: the queue may
    /// hold the run back, and a draft opened meanwhile must stay.
    pub keep_ids: Vec<i64>,
    /// Drafts: the open ones stay.
    pub drafts: bool,
    /// The task's name in the tasks window.
    pub label: String,
    pub key: String,
}

/// Bounds held at most, oldest dropped: an exchange snapshot is a list of every item id.
const BOUNDS_HELD: usize = 8;

/// Closed compositions remembered, oldest dropped.
const CLOSED_HELD: usize = 256;

/// A draft a window has open: its composition, its cache id and the Message-ID of that copy,
/// by which it is found again if the id was handed out anew.
#[derive(Clone, Debug, PartialEq, Eq)]
struct OpenDraft {
    local_id: String,
    id: i64,
    message_id: Option<String>,
}

/// What the backend knows about the clearings: the drafts that windows have open, and the
/// bounds the dialogs counted.
#[derive(Default)]
pub struct Clearing {
    /// Drafts open in a window, by the window's label: `(local_id, cache id of its server copy)`.
    /// A window reports them as it opens a composition, saves it and closes it, and the
    /// window's entry goes with it, so a letter's window the main one does not see is still
    /// spared (#74, decision 3.2 A).
    open: Mutex<HashMap<String, Vec<OpenDraft>>>,
    /// Compositions that closed: a save still on its way must not register one again.
    closed: Mutex<VecDeque<String>>,
    /// The page of each window by its load: a save of a page that is gone (an older number) is
    /// not heard.
    generations: Mutex<HashMap<String, u64>>,
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
    /// A window says which server draft its composition `local_id` is now (`None`: none, the
    /// composition closed), and the Message-ID of that copy when it knows it. A composition
    /// that closed stays closed: a save that was still running does not bring it back.
    pub fn draft_set(&self, label: &str, local_id: &str, draft_id: Option<i64>, message_id: Option<String>) {
        let mut closed = lock(&self.closed);
        let mut open = lock(&self.open);
        if draft_id.is_some() && closed.iter().any(|l| l == local_id) {
            return;
        }
        let list = open.entry(label.to_owned()).or_default();
        list.retain(|d| d.local_id != local_id);
        match draft_id {
            Some(id) => list.push(OpenDraft {
                local_id: local_id.to_owned(),
                id,
                message_id,
            }),
            None => {
                closed.push_back(local_id.to_owned());
                while closed.len() > CLOSED_HELD {
                    closed.pop_front();
                }
            }
        }
        if list.is_empty() {
            open.remove(label);
        }
    }

    /// The composition has no draft to spare (a save the server hid), and has not closed.
    pub fn draft_forget(&self, label: &str, local_id: &str) {
        let mut open = lock(&self.open);
        if let Some(list) = open.get_mut(label) {
            list.retain(|d| d.local_id != local_id);
            if list.is_empty() {
                open.remove(label);
            }
        }
    }

    /// The window is gone, and its drafts are no longer open.
    pub fn window_gone(&self, label: &str) {
        lock(&self.open).remove(label);
    }

    /// The page of the window was loaded anew: what it said before belongs to a page that is
    /// gone. Answers the number of the new page, which its saves carry (`current`).
    pub fn draft_reset(&self, label: &str) -> u64 {
        let generation = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        lock(&self.generations).insert(label.to_owned(), generation);
        lock(&self.open).remove(label);
        generation
    }

    /// Whether a save that carries `generation` comes from the page the window has now. A save
    /// without a number (the page had not heard its own yet) is taken.
    pub fn current(&self, label: &str, generation: Option<u64>) -> bool {
        generation.is_none_or(|g| lock(&self.generations).get(label) == Some(&g))
    }

    /// The cache ids of the drafts open in any window.
    pub fn open_ids(&self) -> Vec<i64> {
        let mut ids: Vec<i64> = lock(&self.open).values().flatten().map(|d| d.id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    fn open_drafts(&self) -> Vec<OpenDraft> {
        lock(&self.open).values().flatten().cloned().collect()
    }

    /// Keeps the bound of a count; the number it is asked for by is returned. The older count
    /// of the folder stays until a run is confirmed (`confirm`): a count that was cancelled
    /// leaves the «Retry» of an earlier run its bound.
    pub fn hold(&self, account_id: &str, folder: &str, bound: Bound) -> u64 {
        let token = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut held = lock(&self.bounds);
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

    /// A run is asked for with the bound of `token`: the older counts of that folder are of no
    /// use any more.
    fn confirm(&self, token: u64) {
        let mut held = lock(&self.bounds);
        let Some((account_id, folder)) = held.get(&token).map(|h| (h.account_id.clone(), h.folder.clone())) else {
            return;
        };
        held.retain(|t, h| *t == token || !(h.account_id == account_id && h.folder == folder));
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
    // The drafts that stay are those open now, as the erasing begins: the run waited in the queue.
    let (keep, kept_ids) = if req.drafts {
        keep_uids(&state.store, &state.clearing, id, &req.folder, &req.keep_ids)
    } else {
        (Vec::new(), Vec::new())
    };
    let run = {
        let mut step = |done: usize, total: usize| {
            last = (done, total);
            // The counters drop to zero when the erasing begins, not before: the sync after
            // the run brings back whatever was left (a stop, a failure).
            if !forgotten && total > 0 {
                forgotten = true;
                forget_cached(state, id, &req.folder, &keep, &req.bound);
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
            &keep,
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
            Ok(Output::Emptied(run, kept_ids))
        }
        Err(e) => {
            let mut shown = CmdError::from(clone_error(&e));
            shown.message = summary(&req.how, last.0, last.1, &e.to_string());
            state.task_failed(key, shown);
            Err(e)
        }
    }
}

/// What the dialog counted, as a test of a cached UID: below the UIDNEXT of the count, or an
/// item of its snapshot. A letter that arrived since is outside it. When the cache cannot say
/// (Exchange), nothing is inside.
fn counted<'a>(
    store: &Store,
    account_id: &str,
    folder: &str,
    bound: &'a Bound,
) -> Box<dyn Fn(u32) -> bool + Send + 'a> {
    match bound {
        Bound::Imap { next, .. } => Box::new(move |uid| uid < *next),
        Bound::Items(snapshot) => {
            let snapshot: HashSet<&str> = snapshot.iter().map(String::as_str).collect();
            let inside: HashSet<u32> = store
                .ews_items(account_id, folder)
                .unwrap_or_default()
                .into_iter()
                .filter(|(_, item, _)| snapshot.contains(item.as_str()))
                .map(|(uid, _, _)| uid)
                .collect();
            Box::new(move |uid| inside.contains(&uid))
        }
    }
}

/// The cached UIDs of `folder` that the run takes out of the cache: those the count named,
/// but `keep`. A letter that arrived after the count stays on screen, as it stays on the server.
fn uids_to_forget(store: &Store, account_id: &str, folder: &str, keep: &[u32], bound: &Bound) -> Result<Vec<u32>> {
    let inside = counted(store, account_id, folder, bound);
    Ok(store
        .known_uids(account_id, folder)?
        .into_iter()
        .filter(|u| inside(*u) && !keep.contains(u))
        .collect())
}

/// The cached UIDs of the drafts open in a window (`window_ids`, with the backend's own
/// record) that stand in `folder` now. A number handed out anew to another draft is not
/// taken for the open one: the record's Message-ID has to agree, else the copy is looked for
/// by it.
pub fn keep_uids(
    store: &Store,
    clearing: &Clearing,
    account_id: &str,
    folder: &str,
    window_ids: &[i64],
) -> (Vec<u32>, Vec<i64>) {
    let mut open = clearing.open_drafts();
    for id in window_ids {
        if !open.iter().any(|d| d.id == *id) {
            open.push(OpenDraft {
                local_id: String::new(),
                id: *id,
                message_id: None,
            });
        }
    }
    let bare = |m: &str| m.trim().trim_matches(['<', '>']).to_owned();
    let mut uids = Vec::new();
    let mut ids = Vec::new();
    for d in open {
        let row = store.get_at(d.id).ok().flatten().map(|(r, _)| r).filter(|r| {
            r.account_id == account_id
                && r.folder == folder
                && d.message_id
                    .as_deref()
                    .is_none_or(|want| r.message_id.as_deref().map(bare) == Some(bare(want)))
        });
        let row = row.or_else(|| {
            d.message_id
                .as_deref()
                .and_then(|mid| store.find_by_message_id(account_id, folder, mid).ok().flatten())
        });
        if let Some(r) = row {
            if !uids.contains(&r.uid) {
                uids.push(r.uid);
            }
            // The copy on disk names the draft by the number the window knew (`d.id`), which may
            // not be the row's now: both are kept.
            for id in [d.id, r.id] {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    uids.sort_unstable();
    ids.sort_unstable();
    (uids, ids)
}

/// The keys of the local copies to drop once the drafts left: not those of the drafts the run
/// kept (`kept_ids`, as the queue found them when the erasing began). A draft that was open
/// then stayed on the server, and its copy stays, though its window has closed since. Nor
/// those of the drafts open at the end of the run (`open_now`): a window may have opened one
/// after the queue read the record.
fn copies_to_drop(leaving: Vec<String>, copies: &[CachedDraft], kept_ids: &[i64], open_now: &[i64]) -> Vec<String> {
    leaving
        .into_iter()
        .filter(|key| {
            copies
                .iter()
                .find(|c| &c.key == key)
                .and_then(|c| c.draft_id)
                .is_none_or(|id| !kept_ids.contains(&id) && !open_now.contains(&id))
        })
        .collect()
}

/// Takes the folder's cached letters that the run takes (but `keep`) out of the cache and
/// tells the lists and the counters, so the folder shows empty while the server catches up.
fn forget_cached(state: &AppState, account_id: &str, folder: &str, keep: &[u32], bound: &Bound) {
    let gone = match uids_to_forget(&state.store, account_id, folder, keep, bound) {
        Ok(gone) => gone,
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
/// (`keep_ids`, the open windows), or that the count did not name (`counted`: it arrived
/// after, and stays on the server), is not among them. `row_of` tells where a cache id
/// stands now: its folder, Message-ID and UID.
pub fn copies_following(
    copies: &[CachedDraft],
    account_id: &str,
    folder: &str,
    keep_ids: &[i64],
    counted: impl Fn(u32) -> bool,
    row_of: impl Fn(i64) -> Option<(String, Option<String>, u32)>,
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
            let (row_folder, row_mid, uid) = row_of(draft_id)?;
            if !counted(uid) {
                return None;
            }
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
    // The cached UIDs of the open drafts are read when the run begins in the queue (`perform`).
    state.clearing.confirm(bound);
    for id in state.clearing.open_ids() {
        if !keep_ids.contains(&id) {
            keep_ids.push(id);
        }
    }
    let mut copies = Vec::new();
    if drafts {
        copies = crate::drafts::read_all(&crate::drafts::dir(&state.app)?).await?;
    }
    let inside = counted(&state.store, account_id, folder, &held);
    let leaving = copies_following(&copies, account_id, folder, &keep_ids, &inside, |id| {
        state
            .store
            .get_at(id)
            .ok()
            .flatten()
            .filter(|(r, _)| r.account_id == account_id)
            .map(|(r, _)| (r.folder, r.message_id, r.uid))
    });
    drop(inside);
    let request = Request {
        folder: folder.to_owned(),
        how,
        bound: held,
        keep_ids: keep_ids.clone(),
        drafts,
        label: label(role),
        key: task_key(account_id, folder),
    };
    let (run, kept_ids) = match state.worker(account_id)?.run(Work::EmptyFolder(request)).await? {
        Output::Emptied(run, kept) => (run, kept),
        _ => (Emptied::default(), Vec::new()),
    };
    // Only a finished run takes the copies with it: after a stop the drafts left in the folder
    // keep theirs.
    if !run.stopped {
        state.clearing.release(bound);
    }
    if drafts && !run.stopped {
        // A draft opened while the run waited stayed in the folder, and so does its copy.
        crate::drafts::drop_all(
            &state.app,
            &copies_to_drop(leaving, &copies, &kept_ids, &state.clearing.open_ids()),
        )
        .await?;
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
            1 => Some(("Drafts".to_owned(), Some("x@depesha.local".to_owned()), 1)),
            2 => Some(("Drafts".to_owned(), None, 2)),
            3 => Some(("Drafts".to_owned(), Some("new@depesha.local".to_owned()), 3)),
            4 => Some(("INBOX".to_owned(), None, 4)),
            5 => Some(("Drafts".to_owned(), Some("y@depesha.local".to_owned()), 5)),
            _ => None,
        };
        let keys = copies_following(&copies, "a", "Drafts", &[2], |_| true, rows);
        assert_eq!(keys, ["linked", "no-mid-recorded"]);
        // Another mailbox's copies are never touched.
        assert!(copies_following(&copies, "b", "Drafts", &[], |_| true, rows).is_empty());
        // A draft that arrived after the count (UID 5 is not below 5) stays, and so does its copy.
        let keys = copies_following(&copies, "a", "Drafts", &[2], |uid| uid < 5, rows);
        assert_eq!(keys, ["linked"]);
    }

    fn drafts_folder(store: &Store) {
        use depesha_core::imap::Folder;
        store
            .replace_folders(
                "a",
                &[Folder {
                    name: "Drafts".into(),
                    display_name: "Drafts".into(),
                    delimiter: Some("/".into()),
                    role: Some(FolderRole::Drafts),
                    selectable: true,
                    hidden: false,
                }],
            )
            .unwrap();
    }

    fn cached(store: &Store, uid: u32, mid: &str) -> i64 {
        use depesha_core::message::Summary;
        use depesha_core::store::NewMessage;
        let s = Summary {
            message_id: Some(mid.into()),
            date: Some(1),
            ..Default::default()
        };
        let msg = NewMessage {
            uid,
            summary: &s,
            fallback_date: 0,
            size: 1,
            flags: Default::default(),
            keywords: Vec::new(),
        };
        store.insert_message("a", "Drafts", &msg).unwrap()
    }

    #[test]
    fn a_draft_opened_after_the_run_was_asked_for_still_stays() {
        let store = Store::open_in_memory().unwrap();
        drafts_folder(&store);
        let (first, second) = (
            cached(&store, 1, "one@depesha.local"),
            cached(&store, 2, "two@depesha.local"),
        );
        let c = Clearing::default();
        c.draft_set("main", "k1", Some(first), None);
        // What the queue reads when the erasing begins, not what `run` read earlier.
        assert_eq!(keep_uids(&store, &c, "a", "Drafts", &[]).0, [1]);
        c.draft_set("message-4", "k2", Some(second), Some("two@depesha.local".into()));
        assert_eq!(keep_uids(&store, &c, "a", "Drafts", &[]).0, [1, 2]);
        // The window's own word counts too, and a number of another folder or mailbox names nothing.
        assert_eq!(keep_uids(&store, &Clearing::default(), "a", "Drafts", &[second]).0, [2]);
        assert!(
            keep_uids(&store, &Clearing::default(), "a", "Trash", &[second])
                .0
                .is_empty()
        );
        assert!(
            keep_uids(&store, &Clearing::default(), "b", "Drafts", &[second])
                .0
                .is_empty()
        );
    }

    #[test]
    fn the_copy_of_a_draft_the_run_kept_stays_though_its_window_closed_before_the_end() {
        let store = Store::open_in_memory().unwrap();
        drafts_folder(&store);
        let open = cached(&store, 1, "one@depesha.local");
        let gone = cached(&store, 2, "two@depesha.local");
        let c = Clearing::default();
        // Registered after `run` was asked for, as the queue reads the record.
        c.draft_set("main", "k1", Some(open), None);
        let (_, kept) = keep_uids(&store, &c, "a", "Drafts", &[]);
        assert_eq!(kept, [open]);
        // The window closes before the run ends: the record is empty, the kept draft is not.
        c.draft_set("main", "k1", None, None);
        assert!(c.open_ids().is_empty());
        let copies = vec![copy("kept", Some(open), None), copy("left", Some(gone), None)];
        let leaving = vec!["kept".to_owned(), "left".to_owned()];
        assert_eq!(copies_to_drop(leaving.clone(), &copies, &kept, &[]), ["left"]);

        // A draft a window opened after the queue read the record is open at the end: it stays.
        let late = cached(&store, 3, "three@depesha.local");
        let copies = vec![copy("late", Some(late), None), copy("left", Some(gone), None)];
        let leaving = vec!["late".to_owned(), "left".to_owned()];
        assert_eq!(copies_to_drop(leaving, &copies, &kept, &[late]), ["left"]);
    }

    #[test]
    fn the_copy_of_a_draft_found_by_its_message_id_stays_under_the_number_the_window_knew() {
        let store = Store::open_in_memory().unwrap();
        drafts_folder(&store);
        let other = cached(&store, 1, "other@depesha.local");
        let mine = cached(&store, 2, "mine@depesha.local");
        let c = Clearing::default();
        // The window knows its draft by `other`'s old number; the Message-ID finds it as `mine`.
        c.draft_set("main", "k1", Some(other), Some("<mine@depesha.local>".into()));
        let (uids, kept) = keep_uids(&store, &c, "a", "Drafts", &[]);
        assert_eq!(uids, [2]);
        assert_eq!(kept, [other, mine]);
        let copies = vec![copy("known", Some(other), Some("mine@depesha.local"))];
        assert!(copies_to_drop(vec!["known".to_owned()], &copies, &kept, &[]).is_empty());
    }

    #[test]
    fn a_number_handed_out_anew_is_not_taken_for_the_open_draft() {
        let store = Store::open_in_memory().unwrap();
        drafts_folder(&store);
        let other = cached(&store, 1, "other@depesha.local");
        cached(&store, 2, "mine@depesha.local");
        let c = Clearing::default();
        // The window's draft was saved as `mine`, but its old number now names `other`.
        c.draft_set("main", "k1", Some(other), Some("<mine@depesha.local>".into()));
        assert_eq!(keep_uids(&store, &c, "a", "Drafts", &[]).0, [2]);
    }

    #[test]
    fn only_what_the_count_named_leaves_the_cache() {
        let store = Store::open_in_memory().unwrap();
        drafts_folder(&store);
        for uid in 1..=4 {
            cached(&store, uid, &format!("{uid}@x"));
        }
        let bound = Bound::Imap { validity: 1, next: 4 };
        // UID 4 arrived after the count: it stays on the server and on the screen.
        assert_eq!(uids_to_forget(&store, "a", "Drafts", &[2], &bound).unwrap(), [1, 3]);
    }

    #[test]
    fn drafts_open_in_any_window_are_known_until_it_closes_or_goes() {
        let c = Clearing::default();
        // The main window and a letter's window each have one; a save moves a window's draft.
        c.draft_set("main", "k1", Some(7), None);
        c.draft_set("message-3", "k2", Some(9), None);
        assert_eq!(c.open_ids(), [7, 9]);
        c.draft_set("message-3", "k2", Some(12), None);
        assert_eq!(c.open_ids(), [7, 12]);
        // The composition closes (or is sent): its draft is no longer spared.
        c.draft_set("main", "k1", None, None);
        assert_eq!(c.open_ids(), [12]);
        // The window goes with its compositions open: nothing of it is remembered.
        c.window_gone("message-3");
        assert!(c.open_ids().is_empty());
    }

    #[test]
    fn a_save_that_hung_does_not_bring_a_closed_composition_back() {
        let c = Clearing::default();
        c.draft_set("main", "k1", Some(7), None);
        c.draft_set("main", "k1", None, None);
        // The save that was still on its way reports its copy after the window closed.
        c.draft_set("main", "k1", Some(8), Some("x@depesha.local".into()));
        assert!(c.open_ids().is_empty());
        // Another composition is not affected.
        c.draft_set("main", "k2", Some(9), None);
        assert_eq!(c.open_ids(), [9]);
        // A save the server hid leaves the composition open but with nothing to spare.
        c.draft_forget("main", "k2");
        assert!(c.open_ids().is_empty());
        c.draft_set("main", "k2", Some(10), None);
        assert_eq!(c.open_ids(), [10]);
    }

    #[test]
    fn a_window_closed_without_a_draft_is_not_registered_by_a_late_save() {
        let c = Clearing::default();
        // The composition never had a server draft; closing says so all the same.
        c.draft_set("main", "k1", None, None);
        c.draft_set("main", "k1", Some(8), Some("x@depesha.local".into()));
        assert!(c.open_ids().is_empty());
    }

    #[test]
    fn a_save_of_a_page_that_was_reloaded_registers_nothing() {
        let c = Clearing::default();
        let old = c.draft_reset("main");
        assert!(c.current("main", Some(old)));
        // The page is loaded anew; the save of the old one comes late with its number.
        let new = c.draft_reset("main");
        assert_ne!(old, new);
        assert!(!c.current("main", Some(old)));
        assert!(c.current("main", Some(new)));
        // Another window's numbers are its own, and a save that has none yet is taken.
        assert!(!c.current("message-3", Some(new)));
        assert!(c.current("main", None));
    }

    #[test]
    fn a_page_loaded_anew_forgets_what_the_page_before_reported() {
        let c = Clearing::default();
        c.draft_set("main", "k1", Some(7), None);
        c.draft_set("message-3", "k2", Some(9), None);
        c.draft_reset("main");
        assert_eq!(c.open_ids(), [9]);
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
        // A count that is then cancelled leaves the earlier one to retry with.
        let again = c.hold("a", "Trash", Bound::Imap { validity: 1, next: 20 });
        assert!(
            c.bound(first, "a", "Trash").is_some(),
            "the older count stays until a run is confirmed"
        );
        assert!(c.bound(again, "a", "Trash").is_some());
        c.confirm(again);
        assert_eq!(
            c.bound(first, "a", "Trash"),
            None,
            "the confirmed count replaces the older one"
        );
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
