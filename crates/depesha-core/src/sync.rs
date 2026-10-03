use std::collections::HashSet;

use futures::TryStreamExt;
use serde::{Deserialize, Serialize};

use crate::imap::{self, Conn, Flags, Folder};
use crate::message;
use crate::store::{NewMessage, Store};
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderSync {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
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
pub async fn sync_folder(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    opts: SyncOptions,
) -> Result<FolderSync> {
    let mailbox = conn.session.select(folder).await?;
    let uidvalidity = mailbox.uid_validity.unwrap_or(0);
    let (known_validity, mut last_uid) = store.folder_state(account_id, folder)?;
    if known_validity != uidvalidity {
        store.clear_folder(account_id, folder)?;
        last_uid = 0;
    }

    let mut report = FolderSync::default();
    if mailbox.exists == 0 {
        let known = store.known_uids(account_id, folder)?;
        report.removed = store.remove_uids(account_id, folder, &known)?;
        store.set_folder_state(account_id, folder, uidvalidity, last_uid)?;
        return Ok(report);
    }

    // Flags of cached messages. A cached UID the server no longer returns was
    // expunged; \Deleted counts as gone too (servers without UIDPLUS keep them).
    let known = store.known_uids(account_id, folder)?;
    if let (Some(&min), Some(&max)) = (known.iter().min(), known.iter().max()) {
        let fetches: Vec<_> = conn
            .session
            .uid_fetch(format!("{min}:{max}"), "(UID FLAGS)")
            .await?
            .try_collect()
            .await?;
        let mut alive = HashSet::new();
        let mut flags = Vec::with_capacity(fetches.len());
        for f in &fetches {
            if let Some(uid) = f.uid {
                let fl = Flags::from_imap(f.flags());
                if !fl.deleted {
                    alive.insert(uid);
                    flags.push((uid, fl));
                }
            }
        }
        report.updated = store.update_flags(account_id, folder, &flags)?;
        let gone: Vec<u32> = known.iter().copied().filter(|u| !alive.contains(u)).collect();
        report.removed = store.remove_uids(account_id, folder, &gone)?;
    }

    // New messages: everything above last_uid, or the newest N on the first run.
    let mut new_uids: Vec<u32> = conn
        .session
        .uid_search(format!("UID {}:*", last_uid + 1))
        .await?
        .into_iter()
        .filter(|u| *u > last_uid)
        .collect();
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
    Ok(report)
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
        for f in &fetches {
            let Some(uid) = f.uid else { continue };
            let flags = Flags::from_imap(f.flags());
            if flags.deleted {
                continue;
            }
            let summary = message::parse_summary(f.header().unwrap_or_default());
            let msg = NewMessage {
                uid,
                summary: &summary,
                fallback_date: f.internal_date().map(|d| d.timestamp()).unwrap_or(0),
                size: f.size.unwrap_or(0),
                flags,
            };
            store.insert_message(account_id, folder, &msg)?;
            added += 1;
        }
    }
    Ok(added)
}

/// Searches the folder on the server and brings found messages missing from the cache
/// into it. Returns local row ids of the matches, newest first.
pub async fn search_server(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    text: &str,
) -> Result<Vec<i64>> {
    let mut uids = imap::search_text(conn, folder, text).await?;
    // Old mail first is useless in a result list: keep the newest matches.
    if uids.len() > 300 {
        uids.drain(..uids.len() - 300);
    }
    let known: HashSet<u32> = store.known_uids(account_id, folder)?.into_iter().collect();
    let missing: Vec<u32> = uids.iter().copied().filter(|u| !known.contains(u)).collect();
    fetch_headers(conn, store, account_id, folder, &missing).await?;
    let mut ids = Vec::with_capacity(uids.len());
    for uid in uids.iter().rev() {
        if let Some(row) = store.find_by_uid(account_id, folder, *uid)? {
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
