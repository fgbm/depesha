//! One interface over the two kinds of server: IMAP with SMTP, and Exchange Web
//! Services. The cache, the worker and the GUI see the same folders and UIDs.

use std::time::Duration;

use crate::account::{Account, Credentials};
use crate::imap::{self, FlagChange, Folder, IdleOutcome};
use crate::store::Store;
use crate::sync::{self, FolderSync, SyncOptions};
use crate::{Error, Result, ews, message, smtp};

pub enum Conn {
    Imap(imap::Conn),
    Ews(ews::Session),
}

pub async fn connect(account: &Account, creds: &Credentials) -> Result<Conn> {
    Ok(match &account.ews {
        Some(cfg) => Conn::Ews(ews::connect(cfg, creds, &account.email).await?),
        None => Conn::Imap(imap::connect(&account.imap, creds).await?),
    })
}

/// Checks the login without changing anything. The error says which protocol failed.
pub async fn check(account: &Account, creds: &Credentials) -> Result<(), (&'static str, Error)> {
    if let Some(cfg) = &account.ews {
        ews::connect(cfg, creds, &account.email).await.map_err(|e| ("EWS", e))?;
        return Ok(());
    }
    let mut conn = imap::connect(&account.imap, creds).await.map_err(|e| ("IMAP", e))?;
    let _ = conn.session.logout().await;
    smtp::check(&account.smtp, creds).await.map_err(|e| ("SMTP", e))?;
    Ok(())
}

/// Sends a message: SMTP, or EWS with the copy in Sent Items made by the server.
pub async fn send(account: &Account, creds: &Credentials, msg: &lettre::Message) -> Result<Vec<u8>> {
    match &account.ews {
        Some(cfg) => {
            let mut s = ews::connect(cfg, creds, &account.email).await?;
            ews::send(&mut s, msg).await
        }
        None => smtp::send(&account.smtp, creds, msg).await,
    }
}

pub async fn sync_folder_list(conn: &mut Conn, store: &Store, account_id: &str) -> Result<Vec<Folder>> {
    match conn {
        Conn::Imap(c) => sync::sync_folder_list(c, store, account_id).await,
        Conn::Ews(s) => ews::sync_folder_list(s, store, account_id).await,
    }
}

pub async fn sync_folder(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    opts: SyncOptions,
) -> Result<FolderSync> {
    match conn {
        Conn::Imap(c) => sync::sync_folder(c, store, account_id, folder, opts).await,
        Conn::Ews(s) => ews::sync_folder(s, store, account_id, folder, opts).await,
    }
}

/// Raw message from the cache, downloaded and indexed on first access.
pub async fn load_body(conn: &mut Conn, store: &Store, id: i64) -> Result<Vec<u8>> {
    match conn {
        Conn::Imap(c) => sync::load_body(c, store, id).await,
        Conn::Ews(s) => {
            if let Some(raw) = store.body(id)? {
                return Ok(raw);
            }
            let row = store.get(id)?.ok_or(Error::NotFound)?;
            let raw = ews::fetch_raw(s, store, &row.account_id, &row.folder, row.uid).await?;
            store.save_body(id, &raw, &message::index_text(&raw))?;
            Ok(raw)
        }
    }
}

/// Downloads messages of one folder for offline reading: `(id, uid)` pairs.
/// Returns how many were saved; messages gone from the server are skipped.
pub async fn prefetch_bodies(conn: &mut Conn, store: &Store, folder: &str, messages: &[(i64, u32)]) -> Result<usize> {
    let mut saved = 0;
    match conn {
        Conn::Imap(c) => {
            let uids: Vec<u32> = messages.iter().map(|&(_, uid)| uid).collect();
            for (uid, raw) in imap::fetch_raw_many(c, folder, &uids).await? {
                if let Some(&(id, _)) = messages.iter().find(|&&(_, u)| u == uid) {
                    store.save_body(id, &raw, &message::index_text(&raw))?;
                    saved += 1;
                }
            }
        }
        Conn::Ews(_) => {
            for &(id, _) in messages {
                match load_body(conn, store, id).await {
                    Ok(_) => saved += 1,
                    Err(Error::NotFound) => {}
                    Err(e) => return Err(e),
                }
            }
        }
    }
    Ok(saved)
}

pub async fn set_flag(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    change: FlagChange,
) -> Result<()> {
    match conn {
        Conn::Imap(c) => imap::set_flag(c, folder, uids, change).await,
        Conn::Ews(s) => ews::set_flag(s, store, account_id, folder, uids, change).await,
    }
}

pub async fn move_messages(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    from: &str,
    uids: &[u32],
    to: &str,
) -> Result<()> {
    match conn {
        Conn::Imap(c) => imap::move_messages(c, from, uids, to).await,
        Conn::Ews(s) => ews::move_messages(s, store, account_id, from, uids, to).await,
    }
}

pub async fn delete_permanently(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> Result<()> {
    match conn {
        Conn::Imap(c) => imap::delete_permanently(c, folder, uids).await,
        Conn::Ews(s) => ews::delete_permanently(s, store, account_id, folder, uids).await,
    }
}

/// Puts a message into a folder unless one with the same Message-ID is already there.
pub async fn append_unless_exists(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    raw: &[u8],
    flags: &str,
    message_id: Option<&str>,
) -> Result<()> {
    match conn {
        Conn::Imap(c) => {
            let exists = match message_id {
                Some(mid) => !imap::find_by_message_id(c, folder, mid).await?.is_empty(),
                None => false,
            };
            if !exists {
                imap::append(c, folder, raw, flags).await?;
            }
            Ok(())
        }
        Conn::Ews(s) => ews::append_unless_exists(s, store, account_id, folder, raw, flags, message_id).await,
    }
}

pub async fn search_server(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    text: &str,
) -> Result<Vec<i64>> {
    match conn {
        Conn::Imap(c) => sync::search_server(c, store, account_id, folder, text).await,
        Conn::Ews(s) => ews::search_server(s, store, account_id, folder, text).await,
    }
}

/// The photo of a colleague from Exchange; IMAP servers have none.
pub async fn user_photo(conn: &mut Conn, email: &str) -> Result<Option<Vec<u8>>> {
    match conn {
        Conn::Imap(_) => Ok(None),
        Conn::Ews(s) => ews::user_photo(s, email).await,
    }
}

pub async fn create_folder(conn: &mut Conn, store: &Store, account_id: &str, name: &str) -> Result<()> {
    match conn {
        Conn::Imap(c) => imap::create_folder(c, name).await,
        Conn::Ews(s) => ews::create_folder(s, store, account_id, name).await,
    }
}

/// Moves messages found by Message-ID (UIDs change on every move). Returns how many moved.
pub async fn move_by_message_id(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    from: &str,
    message_ids: &[String],
    to: &str,
    unseen: bool,
) -> Result<usize> {
    match conn {
        Conn::Imap(c) => {
            let mut uids = Vec::new();
            for mid in message_ids {
                uids.extend(imap::find_by_message_id(c, from, mid).await?);
            }
            imap::move_messages(c, from, &uids, to).await?;
            if unseen && !uids.is_empty() {
                let mut moved = Vec::new();
                for mid in message_ids {
                    moved.extend(imap::find_by_message_id(c, to, mid).await?);
                }
                imap::set_flag(c, to, &moved, FlagChange::Seen(false)).await?;
            }
            Ok(uids.len())
        }
        Conn::Ews(s) => ews::move_by_message_id(s, store, account_id, from, message_ids, to, unseen).await,
    }
}

pub async fn load_older(conn: &mut Conn, store: &Store, account_id: &str, folder: &str, count: usize) -> Result<usize> {
    match conn {
        Conn::Imap(c) => sync::load_older(c, store, account_id, folder, count).await,
        Conn::Ews(s) => ews::load_older(s, store, account_id, folder, count).await,
    }
}

/// Waits for changes in the inbox (IMAP IDLE, EWS streaming notifications, or polling)
/// and gives the connection back.
pub async fn wait_for_changes(
    conn: Conn,
    store: &Store,
    account_id: &str,
    poll: Duration,
) -> Result<(Conn, IdleOutcome)> {
    match conn {
        Conn::Imap(c) => {
            let (c, outcome) = imap::wait_for_changes(c, "INBOX", poll).await?;
            Ok((Conn::Imap(c), outcome))
        }
        Conn::Ews(mut s) => {
            let outcome = ews::wait_for_changes(&mut s, store, account_id, poll).await?;
            Ok((Conn::Ews(s), outcome))
        }
    }
}
