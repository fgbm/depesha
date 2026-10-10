//! The rules of «Clear» for Trash, Junk and Drafts (#74), over the port of the mail server
//! (`port::MailServer`). The folder is emptied on the server, all of it and not only the
//! window the cache loaded, in batches: a failure stops the run and reports how far it got,
//! a stop is taken between two batches. Trash and Junk are wiped; Drafts go to Trash,
//! except the draft a window has open, and the local copies of the drafts that left are
//! dropped with them (a copy that never reached the server stays: it is the only text there
//! is). A run touches only what the dialog counted (`Bound`): a letter that arrives meanwhile
//! is not wiped. The app only shows the progress and tells the windows.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::domain::{CachedDraft, FolderRole};
use crate::port::{Bound, MailServer};
use crate::store::Store;
use crate::{Error, Result};

/// What «Clear» does with the messages of a folder (#74).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Emptying {
    /// Wipes them for good (Trash, Junk).
    Erase,
    /// Moves them into the named folder (Drafts into Trash), where they can be got back.
    ToFolder(String),
}

impl Emptying {
    /// What is done with the folder of this role: Drafts are put in Trash (reversible), never
    /// wiped, so without a Trash there is nothing to do (`None`).
    pub fn of(role: FolderRole, trash: Option<String>) -> Option<Self> {
        match (role == FolderRole::Drafts, trash) {
            (true, Some(to)) => Some(Self::ToFolder(to)),
            (true, None) => None,
            (false, _) => Some(Self::Erase),
        }
    }
}

/// How far an emptying got.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct Emptied {
    /// Messages the folder held when the run began, less the ones it was told to keep.
    pub total: usize,
    pub done: usize,
    /// The run was stopped between two batches; the rest is still there.
    pub stopped: bool,
}

/// IMAP messages wiped or moved in one request: a few thousand UIDs in a single command
/// line are refused by some servers, and the batch is also where a stop can take effect.
pub const EMPTY_BATCH: usize = 500;

/// The UIDs of an IMAP folder (`uids`, read under `validity`) that the `bound` names, but
/// `keep`: those below the UIDNEXT of the count. A folder renumbered since is `FolderChanged`.
pub(crate) fn within_bound(validity: u32, uids: Vec<u32>, bound: &Bound, keep: &[u32]) -> Result<Vec<u32>> {
    let Bound::Imap { validity: asked, next } = bound else {
        return Err(not_of_this_mailbox());
    };
    if validity != *asked {
        return Err(Error::FolderChanged);
    }
    Ok(uids.into_iter().filter(|u| u < next && !keep.contains(u)).collect())
}

/// The items of an Exchange folder that the `bound` (a snapshot of its items) names, but `kept`.
pub(crate) fn within_snapshot(bound: &Bound, kept: &HashSet<String>) -> Result<Vec<String>> {
    let Bound::Items(snapshot) = bound else {
        return Err(not_of_this_mailbox());
    };
    Ok(snapshot.iter().filter(|id| !kept.contains(*id)).cloned().collect())
}

fn not_of_this_mailbox() -> Error {
    Error::Protocol("the bound of the clearing is not of this mailbox".into())
}

/// Empties the folder on the server, every message in it that `bound` names and not only
/// those the cache loaded, except `keep` (cached UIDs of messages that must stay). What came
/// into the folder after the bound was taken stays. It works in batches and calls
/// `progress(done, total)` at the start and after each; `false` from it stops the run before
/// the next batch. A failed batch ends the run with its error: what `progress` last reported
/// is what was done. The folder renumbered since the bound is `FolderChanged`.
pub async fn empty_folder<S: MailServer>(
    server: &mut S,
    folder: &str,
    how: &Emptying,
    bound: &Bound,
    keep: &[u32],
    progress: &mut (dyn FnMut(usize, usize) -> bool + Send),
) -> Result<Emptied> {
    let items = server.counted(folder, bound, keep).await?;
    let mut run = Emptied {
        total: items.len(),
        ..Emptied::default()
    };
    if !progress(0, run.total) {
        run.stopped = run.total > 0;
        return Ok(run);
    }
    for chunk in items.chunks(server.batch().max(1)) {
        match how {
            Emptying::Erase => server.erase(folder, chunk).await?,
            Emptying::ToFolder(to) => server.move_to(folder, chunk, to).await?,
        }
        run.done += chunk.len();
        if !progress(run.done, run.total) && run.done < run.total {
            run.stopped = true;
            break;
        }
    }
    Ok(run)
}

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
}

/// What came of a run: how far it got whatever the end, and the cache ids of the drafts it kept.
pub struct Performed {
    pub result: Result<Emptied>,
    /// The last `(done, total)` the run reported.
    pub last: (usize, usize),
    pub kept_ids: Vec<i64>,
}

/// Runs the request on the server. `progress` is the one of `empty_folder`; `cache_changed`
/// is told what came of dropping the cached letters (`Forgot`) the run takes, once, as the erasing
/// begins and not before: the folder shows empty while the server catches up (the sync after
/// the run brings back whatever was left).
pub async fn perform<S: MailServer>(
    server: &mut S,
    store: &Store,
    clearing: &Clearing,
    account_id: &str,
    req: &Request,
    progress: &mut (dyn FnMut(usize, usize) -> bool + Send),
    cache_forgot: &mut (dyn FnMut(Forgot) + Send),
) -> Performed {
    let mut last = (0usize, 0usize);
    let mut forgotten = false;
    // The drafts that stay are those open now, as the erasing begins: the run waited in the queue.
    let (keep, kept_ids) = if req.drafts {
        keep_uids(store, clearing, account_id, &req.folder, &req.keep_ids)
    } else {
        (Vec::new(), Vec::new())
    };
    let result = {
        let mut step = |done: usize, total: usize| {
            last = (done, total);
            if !forgotten && total > 0 {
                forgotten = true;
                cache_forgot(forget_cached(store, account_id, &req.folder, &keep, &req.bound));
            }
            progress(done, total)
        };
        empty_folder(server, &req.folder, &req.how, &req.bound, &keep, &mut step).await
    };
    Performed { result, last, kept_ids }
}

/// What came of dropping the cached letters a run takes.
#[derive(Debug)]
pub enum Forgot {
    Done,
    /// The cache could not say which letters those are: it is left as it was.
    NotRead(Error),
    /// The letters were found but not removed.
    NotCleared(Error),
}

/// Takes the folder's cached letters that the run takes (but `keep`) out of the cache.
fn forget_cached(store: &Store, account_id: &str, folder: &str, keep: &[u32], bound: &Bound) -> Forgot {
    let gone = match uids_to_forget(store, account_id, folder, keep, bound) {
        Ok(gone) => gone,
        Err(e) => return Forgot::NotRead(e),
    };
    match store.remove_uids(account_id, folder, &gone) {
        Ok(_) => Forgot::Done,
        Err(e) => Forgot::NotCleared(e),
    }
}

/// The role of a folder that «Clear» is offered for; anything else is not cleared.
pub fn clearable_role(store: &Store, account_id: &str, folder: &str) -> Option<FolderRole> {
    [FolderRole::Trash, FolderRole::Junk, FolderRole::Drafts]
        .into_iter()
        .find(|role| {
            store
                .folder_by_role(account_id, *role)
                .ok()
                .flatten()
                .is_some_and(|f| f == folder)
        })
}

/// What a run of Drafts is to know before it is queued: the cache ids of the drafts that stay
/// (the windows' own word, `window_ids`, with the backend's record) and the keys of the local
/// copies that leave with the drafts the count named.
pub fn leaving_copies(
    store: &Store,
    clearing: &Clearing,
    copies: &[CachedDraft],
    account_id: &str,
    folder: &str,
    window_ids: &[i64],
    bound: &Bound,
) -> (Vec<i64>, Vec<String>) {
    // A window the main one does not see may have a draft open: the backend's own record counts.
    // The cached UIDs of the open drafts are read when the run begins in the queue (`perform`).
    let mut keep_ids = window_ids.to_vec();
    for id in clearing.open_ids() {
        if !keep_ids.contains(&id) {
            keep_ids.push(id);
        }
    }
    let inside = counted(store, account_id, folder, bound);
    let leaving = copies_following(copies, account_id, folder, &keep_ids, &inside, |id| {
        store
            .get_at(id)
            .ok()
            .flatten()
            .filter(|(r, _)| r.account_id == account_id)
            .map(|(r, _)| (r.folder, r.message_id, r.uid))
    });
    (keep_ids, leaving)
}

/// How many drafts of the mailbox's Drafts folder windows have open: the number the dialog
/// says will stay.
pub fn open_in_drafts(store: &Store, clearing: &Clearing, account_id: &str) -> usize {
    let folder = store.folder_by_role(account_id, FolderRole::Drafts).ok().flatten();
    let Some(folder) = folder else { return 0 };
    clearing
        .open_ids()
        .into_iter()
        .filter(|id| {
            store
                .get_at(*id)
                .ok()
                .flatten()
                .is_some_and(|(r, _)| r.account_id == account_id && r.folder == folder)
        })
        .count()
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
        lock(&self.generations).remove(label);
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

    pub fn bound(&self, token: u64, account_id: &str, folder: &str) -> Option<Bound> {
        lock(&self.bounds)
            .get(&token)
            .filter(|h| h.account_id == account_id && h.folder == folder)
            .map(|h| h.bound.clone())
    }

    /// A run is asked for with the bound of `token`: the older counts of that folder are of no
    /// use any more.
    pub fn confirm(&self, token: u64) {
        let mut held = lock(&self.bounds);
        let Some((account_id, folder)) = held.get(&token).map(|h| (h.account_id.clone(), h.folder.clone())) else {
            return;
        };
        held.retain(|t, h| *t == token || !(h.account_id == account_id && h.folder == folder));
    }

    pub fn release(&self, token: u64) {
        lock(&self.bounds).remove(&token);
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
pub fn copies_to_drop(leaving: Vec<String>, copies: &[CachedDraft], kept_ids: &[i64], open_now: &[i64]) -> Vec<String> {
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
        use crate::domain::Folder;
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
        use crate::message::Summary;
        use crate::store::NewMessage;
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
    fn a_window_gone_takes_its_page_number_with_it() {
        let c = Clearing::default();
        let page = c.draft_reset("message-3");
        c.window_gone("message-3");
        // A late save of the closed window carries a number nobody holds any more.
        assert!(!c.current("message-3", Some(page)));
        assert!(c.current("message-3", None));
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

    /// A server that holds UIDs per folder and does what the port says, nothing more.
    struct Fake {
        validity: u32,
        folders: HashMap<String, Vec<u32>>,
        batch: usize,
        /// The n-th erase or move (from 1) fails, once, before it changed anything.
        fail_at: Option<usize>,
        /// The n-th erase or move (from 1) applies the first half of its batch and then
        /// fails, once: a connection that dropped in the middle of a request.
        half_at: Option<usize>,
        requests: Vec<Vec<u32>>,
    }

    impl Fake {
        fn with(folder: &str, uids: impl IntoIterator<Item = u32>) -> Self {
            Self {
                validity: 7,
                folders: HashMap::from([(folder.to_owned(), uids.into_iter().collect())]),
                batch: 2,
                fail_at: None,
                half_at: None,
                requests: Vec::new(),
            }
        }

        fn left(&self, folder: &str) -> Vec<u32> {
            self.folders.get(folder).cloned().unwrap_or_default()
        }

        /// Records a request; what of it the server applies, and how it ends.
        fn take<'a>(&mut self, items: &'a [u32]) -> (&'a [u32], Result<()>) {
            self.requests.push(items.to_vec());
            let n = self.requests.len();
            if self.fail_at == Some(n) {
                self.fail_at = None;
                return (&items[..0], Err(Error::Closed));
            }
            if self.half_at == Some(n) {
                self.half_at = None;
                return (&items[..items.len() / 2], Err(Error::Closed));
            }
            (items, Ok(()))
        }
    }

    impl MailServer for Fake {
        type Item = u32;

        async fn count(&mut self, folder: &str) -> Result<(usize, Bound)> {
            let uids = self.left(folder);
            let next = uids.iter().max().map_or(1, |m| m + 1);
            Ok((
                uids.len(),
                Bound::Imap {
                    validity: self.validity,
                    next,
                },
            ))
        }

        async fn counted(&mut self, folder: &str, bound: &Bound, keep: &[u32]) -> Result<Vec<u32>> {
            within_bound(self.validity, self.left(folder), bound, keep)
        }

        async fn erase(&mut self, folder: &str, items: &[u32]) -> Result<()> {
            let (applied, end) = self.take(items);
            self.folders
                .entry(folder.to_owned())
                .or_default()
                .retain(|u| !applied.contains(u));
            end
        }

        async fn move_to(&mut self, folder: &str, items: &[u32], to: &str) -> Result<()> {
            let (applied, end) = self.take(items);
            self.folders
                .entry(folder.to_owned())
                .or_default()
                .retain(|u| !applied.contains(u));
            self.folders
                .entry(to.to_owned())
                .or_default()
                .extend_from_slice(applied);
            end
        }

        fn batch(&self) -> usize {
            self.batch
        }
    }

    /// Runs `empty_folder` and records what `progress` was told.
    async fn empty(
        server: &mut Fake,
        how: &Emptying,
        bound: &Bound,
        keep: &[u32],
        stop_after: Option<usize>,
    ) -> (Result<Emptied>, Vec<(usize, usize)>) {
        let mut seen = Vec::new();
        let mut progress = |done, total| {
            seen.push((done, total));
            stop_after.is_none_or(|n| seen.len() <= n)
        };
        let run = empty_folder(server, "Trash", how, bound, keep, &mut progress).await;
        (run, seen)
    }

    async fn counted_bound(server: &mut Fake) -> Bound {
        server.count("Trash").await.unwrap().1
    }

    #[tokio::test]
    async fn everything_the_count_named_is_wiped_in_batches_with_progress() {
        let mut server = Fake::with("Trash", 1..=5);
        let bound = counted_bound(&mut server).await;
        let (run, seen) = empty(&mut server, &Emptying::Erase, &bound, &[], None).await;
        assert_eq!(
            run.unwrap(),
            Emptied {
                total: 5,
                done: 5,
                stopped: false
            }
        );
        assert_eq!(seen, [(0, 5), (2, 5), (4, 5), (5, 5)]);
        assert_eq!(server.requests, [vec![1, 2], vec![3, 4], vec![5]]);
        assert!(server.left("Trash").is_empty());
    }

    #[tokio::test]
    async fn what_arrived_after_the_count_and_what_must_stay_are_not_touched() {
        let mut server = Fake::with("Trash", 1..=4);
        let bound = counted_bound(&mut server).await;
        server.folders.get_mut("Trash").unwrap().extend([5, 6]);
        let (run, _) = empty(&mut server, &Emptying::Erase, &bound, &[2], None).await;
        assert_eq!(run.unwrap().total, 3);
        assert_eq!(server.left("Trash"), [2, 5, 6]);
    }

    #[tokio::test]
    async fn drafts_are_moved_to_trash_not_wiped() {
        let mut server = Fake::with("Drafts", 1..=3);
        let bound = server.count("Drafts").await.unwrap().1;
        let how = Emptying::ToFolder("Trash".into());
        let mut progress = |_, _| true;
        let run = empty_folder(&mut server, "Drafts", &how, &bound, &[3], &mut progress)
            .await
            .unwrap();
        assert_eq!((run.total, run.done), (2, 2));
        assert_eq!(server.left("Drafts"), [3]);
        assert_eq!(server.left("Trash"), [1, 2]);
    }

    #[tokio::test]
    async fn a_stop_is_taken_between_batches_and_a_repeat_goes_on_with_the_rest() {
        let mut server = Fake::with("Trash", 1..=5);
        let bound = counted_bound(&mut server).await;
        // «Stop» is pressed once the first batch is reported.
        let (run, seen) = empty(&mut server, &Emptying::Erase, &bound, &[], Some(1)).await;
        assert_eq!(
            run.unwrap(),
            Emptied {
                total: 5,
                done: 2,
                stopped: true
            }
        );
        assert_eq!(seen, [(0, 5), (2, 5)]);
        assert_eq!(server.left("Trash"), [3, 4, 5]);
        // The same bound: only what is left of it.
        let (run, _) = empty(&mut server, &Emptying::Erase, &bound, &[], None).await;
        assert_eq!(
            run.unwrap(),
            Emptied {
                total: 3,
                done: 3,
                stopped: false
            }
        );
        assert!(server.left("Trash").is_empty());
    }

    #[tokio::test]
    async fn a_stop_before_the_first_batch_wipes_nothing_and_an_empty_folder_is_not_stopped() {
        let mut server = Fake::with("Trash", 1..=3);
        let bound = counted_bound(&mut server).await;
        let (run, _) = empty(&mut server, &Emptying::Erase, &bound, &[], Some(0)).await;
        assert_eq!(
            run.unwrap(),
            Emptied {
                total: 3,
                done: 0,
                stopped: true
            }
        );
        assert_eq!(server.left("Trash"), [1, 2, 3]);
        let mut none = Fake::with("Trash", []);
        let bound = counted_bound(&mut none).await;
        let (run, _) = empty(&mut none, &Emptying::Erase, &bound, &[], Some(0)).await;
        assert_eq!(run.unwrap(), Emptied::default());
    }

    #[tokio::test]
    async fn a_failed_batch_ends_the_run_where_it_got_and_a_repeat_finishes_it() {
        let mut server = Fake::with("Trash", 1..=5);
        server.fail_at = Some(2);
        let bound = counted_bound(&mut server).await;
        let (run, seen) = empty(&mut server, &Emptying::Erase, &bound, &[], None).await;
        assert!(matches!(run, Err(Error::Closed)));
        // What was last reported is what was done.
        assert_eq!(seen, [(0, 5), (2, 5)]);
        assert_eq!(server.left("Trash"), [3, 4, 5]);
        let (run, _) = empty(&mut server, &Emptying::Erase, &bound, &[], None).await;
        assert_eq!(run.unwrap().done, 3);
        assert!(server.left("Trash").is_empty());
    }

    #[tokio::test]
    async fn a_folder_renumbered_since_the_count_is_refused_untouched() {
        let mut server = Fake::with("Trash", 1..=3);
        let bound = counted_bound(&mut server).await;
        server.validity = 8;
        let (run, seen) = empty(&mut server, &Emptying::Erase, &bound, &[], None).await;
        assert!(matches!(run, Err(Error::FolderChanged)));
        assert!(seen.is_empty());
        assert_eq!(server.left("Trash"), [1, 2, 3]);
        // A bound of the other kind of mailbox names nothing here.
        let (run, _) = empty(
            &mut server,
            &Emptying::Erase,
            &Bound::Items(vec!["x".into()]),
            &[],
            None,
        )
        .await;
        assert!(matches!(run, Err(Error::Protocol(_))));
    }

    #[test]
    fn an_exchange_snapshot_gives_up_what_must_stay() {
        let snapshot = Bound::Items(vec!["a".into(), "b".into(), "c".into()]);
        let kept = HashSet::from(["b".to_owned()]);
        assert_eq!(within_snapshot(&snapshot, &kept).unwrap(), ["a", "c"]);
        assert!(within_snapshot(&Bound::Imap { validity: 1, next: 2 }, &kept).is_err());
    }

    #[test]
    fn drafts_go_to_trash_and_are_never_wiped_for_lack_of_one() {
        assert_eq!(Emptying::of(FolderRole::Trash, None), Some(Emptying::Erase));
        assert_eq!(
            Emptying::of(FolderRole::Junk, Some("Trash".into())),
            Some(Emptying::Erase)
        );
        assert_eq!(
            Emptying::of(FolderRole::Drafts, Some("Trash".into())),
            Some(Emptying::ToFolder("Trash".into()))
        );
        assert_eq!(Emptying::of(FolderRole::Drafts, None), None);
    }

    #[test]
    fn only_trash_junk_and_drafts_can_be_cleared() {
        let store = Store::open_in_memory().unwrap();
        let folder = |name: &str, role| crate::domain::Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: Some("/".into()),
            role,
            selectable: true,
            hidden: false,
        };
        store
            .replace_folders(
                "a",
                &[
                    folder("INBOX", Some(FolderRole::Inbox)),
                    folder("Spam", Some(FolderRole::Junk)),
                    folder("Archive", Some(FolderRole::Archive)),
                ],
            )
            .unwrap();
        assert_eq!(clearable_role(&store, "a", "Spam"), Some(FolderRole::Junk));
        assert_eq!(clearable_role(&store, "a", "INBOX"), None);
        assert_eq!(clearable_role(&store, "a", "Archive"), None);
        assert_eq!(clearable_role(&store, "b", "Spam"), None);
    }

    #[tokio::test]
    async fn a_run_of_drafts_keeps_the_open_ones_and_drops_the_cache_as_the_erasing_begins() {
        let store = Store::open_in_memory().unwrap();
        drafts_folder(&store);
        for uid in 1..=4 {
            cached(&store, uid, &format!("{uid}@x"));
        }
        let mut server = Fake::with("Drafts", 1..=4);
        let bound = server.count("Drafts").await.unwrap().1;
        // UID 5 arrives after the count; the draft of UID 2 is open in a window.
        server.folders.get_mut("Drafts").unwrap().push(5);
        cached(&store, 5, "5@x");
        let clearing = Clearing::default();
        let second = store.find_by_message_id("a", "Drafts", "2@x").unwrap().unwrap().id;
        clearing.draft_set("main", "k", Some(second), None);
        let req = Request {
            folder: "Drafts".into(),
            how: Emptying::ToFolder("Trash".into()),
            bound,
            keep_ids: Vec::new(),
            drafts: true,
        };
        let mut told = Vec::new();
        let mut seen = Vec::new();
        let done = perform(
            &mut server,
            &store,
            &clearing,
            "a",
            &req,
            &mut |d, t| {
                seen.push((d, t));
                true
            },
            &mut |forgot| told.push(matches!(forgot, Forgot::Done)),
        )
        .await;
        assert_eq!(done.result.unwrap().done, 3);
        assert_eq!(done.last, (3, 3));
        assert_eq!(done.kept_ids, [second]);
        assert_eq!(told, [true], "the cache is told once");
        assert_eq!(server.left("Drafts"), [2, 5]);
        assert_eq!(server.left("Trash"), [1, 3, 4]);
        // What the run took left the cache; the kept draft and the late arrival stay on screen.
        assert_eq!(store.known_uids("a", "Drafts").unwrap(), [2, 5]);
    }

    #[test]
    fn the_copies_that_leave_are_those_of_drafts_the_count_named_but_the_open_ones() {
        let store = Store::open_in_memory().unwrap();
        drafts_folder(&store);
        let ids: Vec<i64> = (1..=3).map(|uid| cached(&store, uid, &format!("{uid}@x"))).collect();
        let copies = vec![
            copy("one", Some(ids[0]), None),
            copy("two", Some(ids[1]), None),
            copy("late", Some(ids[2]), None),
        ];
        let clearing = Clearing::default();
        // The backend knows of a window the asking one does not; UID 3 came after the count.
        clearing.draft_set("message-4", "k", Some(ids[1]), None);
        let bound = Bound::Imap { validity: 1, next: 3 };
        let (keep_ids, leaving) = leaving_copies(&store, &clearing, &copies, "a", "Drafts", &[], &bound);
        assert_eq!(keep_ids, [ids[1]]);
        assert_eq!(leaving, ["one"]);
        assert_eq!(open_in_drafts(&store, &clearing, "a"), 1);
        assert_eq!(open_in_drafts(&store, &clearing, "b"), 0);
    }

    #[tokio::test]
    async fn a_batch_cut_in_the_middle_is_repeated_from_the_same_bound_to_an_empty_folder() {
        let mut server = Fake::with("Trash", 1..=5);
        server.half_at = Some(2);
        let bound = counted_bound(&mut server).await;
        let (run, seen) = empty(&mut server, &Emptying::Erase, &bound, &[], None).await;
        assert!(run.is_err());
        // The server applied 3 and told of 2: the repeat finds what is really left.
        assert_eq!(seen, [(0, 5), (2, 5)]);
        assert_eq!(server.left("Trash"), [4, 5]);
        let (run, _) = empty(&mut server, &Emptying::Erase, &bound, &[], None).await;
        let run = run.unwrap();
        assert_eq!((run.total, run.done), (2, 2), "done is what was left");
        assert!(server.left("Trash").is_empty());
    }

    #[tokio::test]
    async fn a_failed_run_reports_how_far_it_got_and_tells_the_cache_once() {
        let store = Store::open_in_memory().unwrap();
        drafts_folder(&store);
        for uid in 1..=5 {
            cached(&store, uid, &format!("{uid}@x"));
        }
        let mut server = Fake::with("Drafts", 1..=5);
        server.fail_at = Some(2);
        let bound = server.count("Drafts").await.unwrap().1;
        let req = Request {
            folder: "Drafts".into(),
            how: Emptying::Erase,
            bound,
            keep_ids: Vec::new(),
            drafts: false,
        };
        let mut told = Vec::new();
        let done = perform(
            &mut server,
            &store,
            &Clearing::default(),
            "a",
            &req,
            &mut |_, _| true,
            &mut |forgot| told.push(matches!(forgot, Forgot::Done)),
        )
        .await;
        assert!(done.result.is_err());
        assert_eq!(done.last, (2, 5));
        assert_eq!(told, [true], "the cache is told once, as the erasing begins");
    }
}
