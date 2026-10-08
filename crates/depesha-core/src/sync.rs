use std::collections::HashSet;

use futures::TryStreamExt;
use serde::{Deserialize, Serialize};

use crate::imap::{self, Conn, Flags, Folder};
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
    store.replace_folders(account_id, &folders)?;
    Ok(folders)
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
        report.removed = store.remove_uids(account_id, folder, &known)?;
        store.set_folder_state(account_id, folder, uidvalidity, last_uid)?;
        store.set_modseq_mark(account_id, folder, mark)?;
        return Ok(report);
    }

    // Flags of cached messages. \Deleted counts as gone (servers without UIDPLUS keep them).
    // Whether this pass learns of every expunged cached message by itself.
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
                report.updated = store.update_flags(account_id, folder, &flags)?;
                store.update_keywords(account_id, folder, &changes.keywords)?;
                report.removed = store.remove_uids(account_id, folder, &gone)?;
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
                        let fl = Flags::from_imap(f.flags());
                        if !fl.deleted {
                            alive.insert(uid);
                            flags.push((uid, fl));
                            keywords.push((uid, imap::keywords_of(f.flags())));
                        }
                    }
                }
                report.updated = store.update_flags(account_id, folder, &flags)?;
                store.update_keywords(account_id, folder, &keywords)?;
                let gone: Vec<u32> = known.iter().copied().filter(|u| !alive.contains(u)).collect();
                report.removed = store.remove_uids(account_id, folder, &gone)?;
            }
        }
    }

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
    store.remove_uids(account_id, folder, &gone)
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
                let flags = Flags::from_imap(f.flags());
                let uid = f.uid.filter(|_| !flags.deleted)?;
                Some((uid, flags, f, message::parse_summary(f.header().unwrap_or_default())))
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
        store.insert_messages(account_id, folder, &msgs)?;
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
    let mut ids = Vec::with_capacity(uids.len());
    for uid in uids.iter().rev() {
        if let Some(row) = store.find_by_uid(account_id, folder, *uid)?
            && (!q.has_attachment || row.has_attachments)
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
