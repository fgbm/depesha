use std::collections::HashSet;

use futures::TryStreamExt;
use serde::{Deserialize, Serialize};

use crate::blocking::off_runtime_thread;
use crate::imap::{self, Conn};

use crate::domain::Folder;
use crate::message;
use crate::query::{self, SearchQuery};
use crate::store::{ModSeqMark, NewMessage, Store};
use crate::{Error, Result};

/// UIDs per FETCH command, so a big mailbox does not land in memory at once.
const BATCH: usize = 200;

#[derive(Debug, Clone, Copy)]
pub struct SyncOptions {
    /// How many newest messages to load into a folder seen for the first time.
    pub initial_limit: usize,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self { initial_limit: 500 }
    }
}

/// Two reports are equal when they tell of the same changes; `fetched_flags`, what
/// the pass cost, does not count.
#[derive(Debug, Clone, Copy, Default, Eq, Serialize, Deserialize)]
pub struct FolderSync {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    /// Flags of cached messages read from the server: what the pass cost, not shown.
    #[serde(skip)]
    pub fetched_flags: usize,
}

impl PartialEq for FolderSync {
    fn eq(&self, other: &Self) -> bool {
        (self.added, self.updated, self.removed) == (other.added, other.updated, other.removed)
    }
}

impl FolderSync {
    pub fn changed(&self) -> bool {
        self.added + self.updated + self.removed > 0
    }
}

pub async fn sync_folder_list(conn: &mut Conn, store: &Store, account_id: &str) -> Result<Vec<Folder>> {
    let folders = imap::list_folders(conn).await?;
    apply_folder_list(conn, store, account_id, &folders, STATUS_PER_PASS).await?;
    Ok(folders)
}

/// How many `STATUS` one pass over the folder list may ask: a folder list whose names all
/// changed (a switch of the interface language in Gmail) would otherwise mean hundreds of
/// round trips at once. The folders not asked stay in the cache and are asked in the next pass.
const STATUS_PER_PASS: usize = 20;

/// Stores the listed folders and takes out of the cache only the folders the server itself
/// says are not there. A LIST on a dying connection may end early without an error, and a
/// folder missing from it would take its letters along: so each missing one is asked with
/// `STATUS` (at most `limit` per pass), and only a `NO` that names the missing mailbox
/// deletes it. Any other answer keeps the folder; a dead connection stops the asking and its
/// error is returned (the worker tries again). A missing folder with children in the list is
/// not asked: they prove it exists (Gmail's `[Gmail]`, which no `STATUS` opens).
async fn apply_folder_list<P: imap::Probing>(
    probe: &mut P,
    store: &Store,
    account_id: &str,
    folders: &[Folder],
    limit: usize,
) -> Result<()> {
    store.upsert_folders(account_id, folders)?;
    let cached = store.cached_folder_names(account_id)?;
    let has_children = |name: &str| {
        folders.iter().any(|f| {
            f.delimiter
                .as_deref()
                .filter(|d| !d.is_empty())
                .is_some_and(|d| f.name.starts_with(&format!("{name}{d}")))
        })
    };
    let missing = cached
        .iter()
        .filter(|n| !folders.iter().any(|f| &f.name == *n) && !has_children(n));
    let mut gone = Vec::new();
    let mut failure = None;
    for name in missing.take(limit) {
        match imap::folder_gone(probe, name).await {
            Ok(true) => gone.push(name.clone()),
            Ok(false) => {}
            // The connection is not to be trusted: the rest is not asked.
            Err(e) if e.is_transient() => {
                failure = Some(e);
                break;
            }
            // An answer that says nothing of existence: the folder stays.
            Err(_) => {}
        }
    }
    store.drop_folders(account_id, &gone)?;
    match failure {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Flags of the cached messages. \Deleted counts as gone (servers without UIDPLUS keep them).
/// Returns whether this pass learned of every expunged cached message by itself.
async fn sync_flags(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    saved: ModSeqMark,
    mark: ModSeqMark,
    report: &mut FolderSync,
) -> Result<bool> {
    let mut expunges_known = true;
    if let Some((min, max)) = store.uid_range(account_id, folder)? {
        let range = format!("{min}:{max}");
        let pass = flag_pass(saved, mark);
        let changes = match pass {
            FlagPass::Full => None,
            FlagPass::Unchanged => Some(imap::Changes::default()),
            FlagPass::Since(modseq) => match imap::changed_since(conn, &range, modseq).await {
                Ok(changes) => Some(changes),
                // Refused in this folder: the plain way, as without CONDSTORE.
                Err(Error::Imap(async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_))) => None,
                Err(e) => return Err(e),
            },
        };
        match changes {
            Some(changes) => {
                // VANISHED came with the answer only when QRESYNC is on.
                expunges_known = conn.qresync && pass != FlagPass::Unchanged;
                report.fetched_flags = changes.flags.len();
                let (gone, flags): (Vec<_>, Vec<_>) = changes.flags.iter().partition(|(_, f)| f.deleted);
                let mut gone: Vec<u32> = gone.into_iter().map(|(uid, _)| uid).collect();
                if !changes.vanished.is_empty() {
                    let known = store.known_uids(account_id, folder)?;
                    gone.extend(known.into_iter().filter(|u| changes.vanished(*u)));
                }
                report.updated = off_runtime_thread(|| store.update_flags(account_id, folder, &flags))?;
                store.update_keywords(account_id, folder, &changes.keywords)?;
                report.removed = off_runtime_thread(|| store.remove_uids(account_id, folder, &gone))?;
            }
            None => {
                // A cached UID the server no longer returns was expunged.
                let known = store.known_uids(account_id, folder)?;
                let fetches: Vec<_> = conn
                    .session
                    .uid_fetch(range, "(UID FLAGS)")
                    .await?
                    .try_collect()
                    .await?;
                report.fetched_flags = fetches.len();
                let mut alive = HashSet::new();
                let mut flags = Vec::with_capacity(fetches.len());
                let mut keywords = Vec::with_capacity(fetches.len());
                for f in &fetches {
                    if let Some(uid) = f.uid {
                        let fl = imap::flags_from_imap(f.flags());
                        if !fl.deleted {
                            alive.insert(uid);
                            flags.push((uid, fl));
                            keywords.push((uid, imap::keywords_of(f.flags())));
                        }
                    }
                }
                report.updated = off_runtime_thread(|| store.update_flags(account_id, folder, &flags))?;
                store.update_keywords(account_id, folder, &keywords)?;
                let gone: Vec<u32> = known.iter().copied().filter(|u| !alive.contains(u)).collect();
                report.removed = off_runtime_thread(|| store.remove_uids(account_id, folder, &gone))?;
            }
        }
    }
    Ok(expunges_known)
}

/// Brings one folder of the cache in line with the server: new headers,
/// changed flags, removed messages. UIDVALIDITY change drops the folder cache.
/// With CONDSTORE only flags changed since the last pass are fetched (`FlagPass`).
pub async fn sync_folder(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    opts: SyncOptions,
) -> Result<FolderSync> {
    let mailbox = imap::select_for_sync(conn, folder).await?;
    if let Some(enabled) = conn.enabled.take() {
        store.save_server_enable(account_id, &enabled, chrono::Utc::now().timestamp())?;
    }
    let uidvalidity = mailbox.uid_validity.unwrap_or(0);
    let (known_validity, mut last_uid) = store.folder_state(account_id, folder)?;
    if known_validity != uidvalidity {
        // Forgets the mod-sequence too: the next pass is full.
        store.clear_folder(account_id, folder)?;
        // The new number at once: the cache never has UIDs of one UIDVALIDITY under
        // another, and actions read before the change are refused (`imap::set_flag`).
        store.set_folder_state(account_id, folder, uidvalidity, 0)?;
        last_uid = 0;
    }
    let saved = store.modseq_mark(account_id, folder)?;
    let mark = ModSeqMark {
        // Dovecot sends HIGHESTMODSEQ to a plain SELECT too once the mailbox keeps
        // mod-sequences; CHANGEDSINCE goes only to a server that announced CONDSTORE.
        modseq: mailbox.highest_modseq.filter(|_| conn.caps.condstore).unwrap_or(0),
        exists: mailbox.exists,
        uid_next: mailbox.uid_next.unwrap_or(0),
    };

    let mut report = FolderSync::default();
    if mailbox.exists == 0 {
        let known = store.known_uids(account_id, folder)?;
        report.removed = off_runtime_thread(|| store.remove_uids(account_id, folder, &known))?;
        store.set_folder_state(account_id, folder, uidvalidity, last_uid)?;
        store.set_modseq_mark(account_id, folder, mark)?;
        return Ok(report);
    }

    // Flags of cached messages. \Deleted counts as gone (servers without UIDPLUS keep them).
    let expunges_known = sync_flags(conn, store, account_id, folder, saved, mark, &mut report).await?;

    // New messages: everything above last_uid, or the newest N on the first run. Without
    // VANISHED the same answer tells whether anything the last pass saw was expunged.
    let from = if expunges_known {
        last_uid
    } else {
        last_uid.min(saved.uid_next.saturating_sub(1))
    };
    // A refused search must not pass for "nothing new": it would hide expunges too.
    let found: Vec<u32> = imap::uid_search(conn, &format!("UID {}:*", from + 1))
        .await?
        .into_iter()
        .filter(|u| *u > from)
        .collect();
    if !expunges_known
        && expunged_since(
            saved,
            mark.exists,
            found.iter().filter(|u| **u >= saved.uid_next).count(),
        )
    {
        report.removed += remove_expunged(conn, store, account_id, folder).await?;
    }
    let mut new_uids: Vec<u32> = found.into_iter().filter(|u| *u > last_uid).collect();
    new_uids.sort_unstable();
    if last_uid == 0 && new_uids.len() > opts.initial_limit {
        new_uids.drain(..new_uids.len() - opts.initial_limit);
    }
    report.added = fetch_headers(conn, store, account_id, folder, &new_uids).await?;
    if store.window_start(account_id, folder)? == 0
        && let Some(&first) = new_uids.first()
    {
        store.set_window_start(account_id, folder, first)?;
    }

    let newest = new_uids.last().copied().unwrap_or(last_uid).max(last_uid);
    store.set_folder_state(account_id, folder, uidvalidity, newest)?;
    // Last: a pass broken off before here is done again from the old mod-sequence.
    store.set_modseq_mark(account_id, folder, mark)?;
    Ok(report)
}

/// How the flags of cached messages are brought up to date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlagPass {
    /// All of them: no CONDSTORE, NOMODSEQ, the first pass since start or since
    /// UIDVALIDITY changed, or the server's HIGHESTMODSEQ went back (a restored mailbox).
    Full,
    /// HIGHESTMODSEQ is the same: no flag changed.
    Unchanged,
    /// Those changed after this mod-sequence (`CHANGEDSINCE`).
    Since(u64),
}

fn flag_pass(saved: ModSeqMark, now: ModSeqMark) -> FlagPass {
    if saved.modseq == 0 || now.modseq == 0 || saved.uid_next == 0 || now.uid_next == 0 || now.modseq < saved.modseq {
        FlagPass::Full
    } else if now.modseq == saved.modseq {
        FlagPass::Unchanged
    } else {
        FlagPass::Since(saved.modseq)
    }
}

/// Whether messages the last pass found were expunged since: of its `exists`, all
/// below its `uid_next`, fewer are left. `above` counts the folder's UIDs from that
/// `uid_next` up. Mail that arrives after SELECT can only make the answer yes.
fn expunged_since(saved: ModSeqMark, exists: u32, above: usize) -> bool {
    (exists as usize).saturating_sub(above) < saved.exists as usize
}

/// Drops cached messages the server no longer has or has marked \Deleted, for a
/// server that does not say which were expunged (CONDSTORE without QRESYNC).
/// A list of UIDs is far lighter than their flags.
async fn remove_expunged(conn: &mut Conn, store: &Store, account_id: &str, folder: &str) -> Result<usize> {
    let Some((min, max)) = store.uid_range(account_id, folder)? else {
        return Ok(0);
    };
    // Checked: an empty answer would empty the cache.
    let alive: HashSet<u32> = imap::uid_search(conn, &format!("UID {min}:{max} UNDELETED"))
        .await?
        .into_iter()
        .collect();
    let gone: Vec<u32> = store
        .known_uids(account_id, folder)?
        .into_iter()
        .filter(|u| !alive.contains(u))
        .collect();
    off_runtime_thread(|| store.remove_uids(account_id, folder, &gone))
}

/// Extends the synced window `count` messages further into the past. Returns how many
/// messages the window grew by (0 when the start of the folder is reached). Messages
/// already cached by a server search are skipped, not refetched.
pub async fn load_older(conn: &mut Conn, store: &Store, account_id: &str, folder: &str, count: usize) -> Result<usize> {
    let known: HashSet<u32> = store.known_uids(account_id, folder)?.into_iter().collect();
    let mut start = store.window_start(account_id, folder)?;
    if start == 0 {
        // Caches from before the window was tracked: the oldest cached message.
        start = known.iter().copied().min().unwrap_or(0);
    }
    if start <= 1 {
        return Ok(0);
    }
    conn.session.select(folder).await?;
    let mut uids: Vec<u32> = conn
        .session
        .uid_search(format!("UID 1:{}", start - 1))
        .await?
        .into_iter()
        .filter(|u| *u < start)
        .collect();
    uids.sort_unstable();
    if uids.len() > count {
        uids.drain(..uids.len() - count);
    }
    let Some(&new_start) = uids.first() else {
        store.set_window_start(account_id, folder, 1)?;
        return Ok(0);
    };
    let missing: Vec<u32> = uids.iter().copied().filter(|u| !known.contains(u)).collect();
    fetch_headers(conn, store, account_id, folder, &missing).await?;
    store.set_window_start(account_id, folder, new_start)?;
    Ok(uids.len())
}

async fn fetch_headers(conn: &mut Conn, store: &Store, account_id: &str, folder: &str, uids: &[u32]) -> Result<usize> {
    let mut added = 0;
    for chunk in uids.chunks(BATCH) {
        let fetches: Vec<_> = conn
            .session
            .uid_fetch(
                imap::uid_set(chunk),
                "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])",
            )
            .await?
            .try_collect()
            .await?;
        let headers: Vec<_> = fetches
            .iter()
            .filter_map(|f| {
                let flags = imap::flags_from_imap(f.flags());
                let uid = f.uid.filter(|_| !flags.deleted)?;
                Some((
                    uid,
                    flags,
                    f,
                    message::parse_summary_for(f.header().unwrap_or_default(), &conn.receiver),
                ))
            })
            .collect();
        let msgs: Vec<NewMessage<'_>> = headers
            .iter()
            .map(|(uid, flags, f, summary)| NewMessage {
                uid: *uid,
                summary,
                fallback_date: f.internal_date().map(|d| d.timestamp()).unwrap_or(0),
                size: f.size.unwrap_or(0),
                flags: *flags,
                keywords: imap::keywords_of(f.flags()),
            })
            .collect();
        // One commit for the batch: either all of it is cached or none, and the
        // folder's state, written after, never claims what is missing.
        off_runtime_thread(|| store.insert_messages(account_id, folder, &msgs))?;
        added += msgs.len();
    }
    Ok(added)
}

/// Searches the folder on the server (operators included, see `query`) and brings
/// found messages missing from the cache into it. Returns local row ids, newest first.
pub async fn search_server(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    text: &str,
) -> Result<Vec<i64>> {
    let q = SearchQuery::parse(text);
    // A label is what the user typed; the server knows it by the mailbox's keyword.
    let mut uids = imap::search(
        conn,
        folder,
        &query::imap_criteria_with_labels(&q, |name| store.label_keyword(account_id, name).ok().flatten()),
    )
    .await?;
    // Old mail first is useless in a result list: keep the newest matches.
    if uids.len() > 300 {
        uids.drain(..uids.len() - 300);
    }
    let known: HashSet<u32> = store.known_uids(account_id, folder)?.into_iter().collect();
    let missing: Vec<u32> = uids.iter().copied().filter(|u| !known.contains(u)).collect();
    fetch_headers(conn, store, account_id, folder, &missing).await?;
    found_rows(store, account_id, folder, &q, &uids)
}

/// The cached rows of the UIDs the server found, newest first. A letter found by importance
/// whose headers the cache never read is high from now on; one it read keeps what it read,
/// and a substring of the server that was wrong drops out of the results.
fn found_rows(store: &Store, account_id: &str, folder: &str, q: &SearchQuery, uids: &[u32]) -> Result<Vec<i64>> {
    if q.important {
        store.set_high(account_id, folder, uids, true)?;
    }
    let mut ids = Vec::with_capacity(uids.len());
    for uid in uids.iter().rev() {
        if let Some(row) = store.find_by_uid(account_id, folder, *uid)?
            && (!q.has_attachment || row.has_attachments)
            && (!q.important || row.importance == crate::domain::Importance::High)
        {
            ids.push(row.id);
        }
    }
    Ok(ids)
}

/// Raw message from the cache, downloaded and indexed on first access.
pub async fn load_body(conn: &mut Conn, store: &Store, id: i64) -> Result<Vec<u8>> {
    if let Some(raw) = store.body(id)? {
        return Ok(raw);
    }
    let row = store.get(id)?.ok_or(Error::NotFound)?;
    let raw = imap::fetch_raw(conn, &row.folder, row.uid).await?;
    store.save_body(id, &raw, &message::index_text(&raw))?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Error;
    use crate::domain::{Flags, FolderRole};
    use crate::imap::Probing;
    use crate::store::NewMessage;
    use std::collections::HashMap;

    fn folder(name: &str) -> Folder {
        Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: Some("/".into()),
            role: (name == "INBOX").then_some(FolderRole::Inbox),
            selectable: true,
            hidden: false,
        }
    }

    /// What the server answers to `STATUS` of a folder; no entry = it exists.
    #[derive(Default)]
    struct Fake {
        answers: HashMap<&'static str, fn() -> Error>,
        asked: Vec<String>,
    }

    fn nonexistent() -> Error {
        Error::Imap(async_imap::error::Error::No(
            "[NONEXISTENT] Mailbox doesn't exist".into(),
        ))
    }

    fn cut() -> Error {
        Error::Imap(async_imap::error::Error::ConnectionLost)
    }

    impl Probing for Fake {
        async fn status(&mut self, folder: &str) -> Result<()> {
            self.asked.push(folder.to_owned());
            match self.answers.get(folder) {
                Some(make) => Err(make()),
                None => Ok(()),
            }
        }
    }

    /// A cache of the account "a" with the folders and a letter in each.
    fn cached(names: &[&str]) -> Store {
        let store = Store::open_in_memory().unwrap();
        let folders: Vec<Folder> = names.iter().map(|n| folder(n)).collect();
        store.replace_folders("a", &folders).unwrap();
        let summary = message::Summary {
            subject: "Письмо".into(),
            ..Default::default()
        };
        for n in names {
            let msg = NewMessage {
                uid: 1,
                summary: &summary,
                fallback_date: 1,
                size: 1,
                flags: Flags::default(),
                keywords: Vec::new(),
            };
            store.insert_message("a", n, &msg).unwrap();
        }
        store
    }

    fn names(store: &Store) -> Vec<String> {
        let mut n = store.cached_folder_names("a").unwrap();
        n.sort();
        n
    }

    fn listed(names: &[&str]) -> Vec<Folder> {
        names.iter().map(|n| folder(n)).collect()
    }

    #[tokio::test]
    async fn a_list_cut_short_keeps_folders_the_server_still_has() {
        let store = cached(&["INBOX", "Sent", "Work"]);
        // LIST ended after INBOX; STATUS finds the others.
        let mut p = Fake::default();
        apply_folder_list(&mut p, &store, "a", &listed(&["INBOX"]), STATUS_PER_PASS)
            .await
            .unwrap();
        assert_eq!(names(&store), ["INBOX", "Sent", "Work"]);
        assert_eq!(store.known_uids("a", "Work").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_folder_the_server_says_is_gone_loses_its_cache() {
        let store = cached(&["INBOX", "Sent", "Work"]);
        let mut p = Fake::default();
        p.answers.insert("Work", nonexistent);
        apply_folder_list(&mut p, &store, "a", &listed(&["INBOX", "Sent"]), STATUS_PER_PASS)
            .await
            .unwrap();
        assert_eq!(names(&store), ["INBOX", "Sent"]);
        assert_eq!(store.known_uids("a", "Work").unwrap().len(), 0);
    }

    #[tokio::test]
    async fn a_connection_cut_during_status_deletes_nothing() {
        let store = cached(&["INBOX", "Sent", "Work"]);
        let mut p = Fake::default();
        p.answers.insert("Sent", cut);
        let err = apply_folder_list(&mut p, &store, "a", &listed(&["INBOX"]), STATUS_PER_PASS)
            .await
            .unwrap_err();
        assert!(err.is_transient());
        assert_eq!(names(&store), ["INBOX", "Sent", "Work"]);
    }

    #[tokio::test]
    async fn a_rename_drops_the_old_name_and_adds_the_new() {
        let store = cached(&["INBOX", "Old"]);
        let mut p = Fake::default();
        p.answers.insert("Old", nonexistent);
        apply_folder_list(&mut p, &store, "a", &listed(&["INBOX", "New"]), STATUS_PER_PASS)
            .await
            .unwrap();
        assert_eq!(names(&store), ["INBOX", "New"]);
    }

    #[tokio::test]
    async fn a_no_that_is_not_about_existence_keeps_the_folder() {
        let store = cached(&["INBOX", "Shared"]);
        let mut p = Fake::default();
        p.answers.insert("Shared", || {
            Error::Imap(async_imap::error::Error::No("[NOPERM] Permission denied".into()))
        });
        apply_folder_list(&mut p, &store, "a", &listed(&["INBOX"]), STATUS_PER_PASS)
            .await
            .unwrap();
        assert_eq!(names(&store), ["INBOX", "Shared"]);
    }

    #[tokio::test]
    async fn ghosts_are_dropped_over_several_passes_when_each_asks_a_few() {
        // After a change of language Gmail's folders all get new names: most of the cache is gone.
        let store = cached(&["INBOX", "Keep", "A", "B", "C", "D", "E", "F"]);
        let mut p = Fake::default();
        for n in ["A", "B", "C", "D", "E", "F"] {
            p.answers.insert(n, nonexistent);
        }
        let list = listed(&["INBOX", "Keep"]);
        apply_folder_list(&mut p, &store, "a", &list, 3).await.unwrap();
        assert_eq!(p.asked.len(), 3);
        assert_eq!(names(&store).len(), 5);
        apply_folder_list(&mut p, &store, "a", &list, 3).await.unwrap();
        assert_eq!(names(&store), ["INBOX", "Keep"]);
    }

    #[tokio::test]
    async fn an_answer_that_does_not_say_the_folder_is_gone_keeps_it() {
        let store = cached(&["INBOX", "Odd", "Locked", "Bare"]);
        let mut p = Fake::default();
        p.answers.insert("Odd", || {
            Error::Imap(async_imap::error::Error::No("[SERVERBUG] Internal error".into()))
        });
        p.answers.insert("Locked", || {
            Error::Imap(async_imap::error::Error::No("[LOCKED] Mailbox is locked".into()))
        });
        p.answers.insert("Bare", || {
            Error::Imap(async_imap::error::Error::No("STATUS failed".into()))
        });
        apply_folder_list(&mut p, &store, "a", &listed(&["INBOX"]), STATUS_PER_PASS)
            .await
            .unwrap();
        assert_eq!(names(&store), ["Bare", "INBOX", "Locked", "Odd"]);
    }

    #[tokio::test]
    async fn a_folder_with_children_in_the_list_exists_and_is_not_asked() {
        // [Gmail] is a container no STATUS can open; its children in the list prove it.
        let store = cached(&["INBOX", "[Gmail]", "[Gmail]/Sent"]);
        let mut p = Fake::default();
        p.answers.insert("[Gmail]", nonexistent);
        apply_folder_list(
            &mut p,
            &store,
            "a",
            &listed(&["INBOX", "[Gmail]/Sent"]),
            STATUS_PER_PASS,
        )
        .await
        .unwrap();
        assert!(p.asked.is_empty());
        assert_eq!(names(&store), ["INBOX", "[Gmail]", "[Gmail]/Sent"]);
    }

    #[tokio::test]
    async fn a_full_list_asks_nothing() {
        let store = cached(&["INBOX", "Sent"]);
        let mut p = Fake::default();
        apply_folder_list(&mut p, &store, "a", &listed(&["INBOX", "Sent", "New"]), STATUS_PER_PASS)
            .await
            .unwrap();
        assert!(p.asked.is_empty());
        assert_eq!(names(&store), ["INBOX", "New", "Sent"]);
    }

    #[test]
    fn a_cached_letter_the_server_found_by_importance_is_in_the_results() {
        use crate::domain::FolderRole;
        use crate::store::NewMessage;
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders(
                "a",
                &[Folder {
                    name: "INBOX".into(),
                    display_name: "INBOX".into(),
                    delimiter: Some("/".into()),
                    role: Some(FolderRole::Inbox),
                    selectable: true,
                    hidden: false,
                }],
            )
            .unwrap();
        let summary = message::Summary {
            subject: "Старое срочное".into(),
            ..Default::default()
        };
        let msg = NewMessage {
            uid: 7,
            summary: &summary,
            fallback_date: 1,
            size: 1,
            flags: Flags::default(),
            keywords: Vec::new(),
        };
        let id = store.insert_message("a", "INBOX", &msg).unwrap();
        // Cached before the importance was read: unknown.
        store.forget_importance(id);
        assert_eq!(
            store.get(id).unwrap().unwrap().importance,
            crate::domain::Importance::Normal
        );
        let q = SearchQuery::parse("is:important");
        // The cache never read it, the server found it by its headers: it is in the results, high from now on.
        assert_eq!(found_rows(&store, "a", "INBOX", &q, &[7]).unwrap(), [id]);
        assert_eq!(
            store.get(id).unwrap().unwrap().importance,
            crate::domain::Importance::High
        );

        // A letter whose summary was read says normal: the substring of the server is not believed.
        let calm = message::Summary {
            subject: "Обычное".into(),
            ..Default::default()
        };
        let known = store
            .insert_message(
                "a",
                "INBOX",
                &NewMessage {
                    uid: 8,
                    summary: &calm,
                    fallback_date: 2,
                    size: 1,
                    flags: Flags::default(),
                    keywords: Vec::new(),
                },
            )
            .unwrap();
        assert!(found_rows(&store, "a", "INBOX", &q, &[8]).unwrap().is_empty());
        assert_eq!(
            store.get(known).unwrap().unwrap().importance,
            crate::domain::Importance::Normal
        );
        // An ordinary search leaves the cache alone.
        let ordinary = SearchQuery::parse("срочное");
        assert_eq!(found_rows(&store, "a", "INBOX", &ordinary, &[7]).unwrap(), [id]);
    }

    fn mark(modseq: u64, exists: u32, uid_next: u32) -> ModSeqMark {
        ModSeqMark {
            modseq,
            exists,
            uid_next,
        }
    }

    #[test]
    fn flags_are_fetched_in_full_without_a_usable_mod_sequence() {
        let now = mark(120, 30, 31);
        assert_eq!(flag_pass(mark(100, 30, 31), now), FlagPass::Since(100));
        assert_eq!(flag_pass(mark(120, 30, 31), now), FlagPass::Unchanged);
        // First pass, after start or a new UIDVALIDITY.
        assert_eq!(flag_pass(ModSeqMark::default(), now), FlagPass::Full);
        // NOMODSEQ or no CONDSTORE.
        assert_eq!(flag_pass(mark(100, 30, 31), mark(0, 30, 31)), FlagPass::Full);
        // The server's mod-sequences went back: a restored mailbox.
        assert_eq!(flag_pass(mark(200, 30, 31), now), FlagPass::Full);
        // No UIDNEXT: expunges could not be counted.
        assert_eq!(flag_pass(mark(100, 30, 0), now), FlagPass::Full);
        assert_eq!(flag_pass(mark(100, 30, 31), mark(120, 30, 0)), FlagPass::Full);
    }

    #[test]
    fn expunges_are_counted_from_exists_and_new_uids() {
        let saved = mark(100, 30, 31);
        assert!(!expunged_since(saved, 30, 0), "nothing happened");
        assert!(!expunged_since(saved, 32, 2), "two arrived");
        assert!(expunged_since(saved, 29, 0), "one expunged");
        assert!(expunged_since(saved, 30, 1), "one arrived, one expunged");
        // Arrived after SELECT: counted among new UIDs, not in EXISTS. Says yes, never no.
        assert!(expunged_since(saved, 30, 1));
        assert!(expunged_since(saved, 0, 5));
    }
}
