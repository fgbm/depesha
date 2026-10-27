//! One interface over the two kinds of server: IMAP with SMTP, and Exchange Web
//! Services. The cache, the worker and the GUI see the same folders and UIDs.

use crate::best_effort;
use std::time::{Duration, Instant};

use crate::account::{Account, Credentials};
use crate::avatar::Receiver;
use crate::clear::{self, Clearing, EMPTY_BATCH, Emptied, Emptying, Forgot, Performed};
use crate::domain::{FlagChange, Folder};
use crate::idle_pace::{DropCause, DropInfo, Dropped, IdlePace};
use crate::imap::{self, IdleOutcome};
use crate::port::{Count, MailServer};
use crate::store::Store;
use crate::sync::{self, FolderSync, SyncOptions};
use crate::{Error, Result, ews, message, smtp};
use std::collections::HashSet;
use std::sync::atomic::Ordering;

pub enum Conn {
    Imap(imap::Conn),
    Ews(ews::Session),
}

impl Conn {
    /// Whether the last work left the connection out of step, so the worker takes a fresh
    /// one (#177). Only IMAP says yes: an answer the parser refused keeps the rest of the
    /// answer in the buffer, and the next command would read the tail of the old one.
    pub fn is_broken(&self) -> bool {
        matches!(self, Conn::Imap(c) if c.broken)
    }

    /// Marks the connection out of step (#177); the worker drops it after this work.
    pub fn note_broken(&mut self) {
        if let Conn::Imap(c) = self {
            c.broken = true;
        }
    }
}

pub async fn connect(account: &Account, creds: &Credentials) -> Result<Conn> {
    let receiver = Receiver::of(account);
    Ok(match &account.ews {
        Some(cfg) => {
            let mut s = ews::connect(cfg, creds, &account.email).await?;
            s.set_receiver(receiver);
            Conn::Ews(s)
        }
        None => {
            let mut c = imap::connect(&account.imap, creds).await?;
            c.receiver = receiver;
            Conn::Imap(c)
        }
    })
}

/// Without changing anything: the error names which protocol failed.
pub async fn check(account: &Account, creds: &Credentials) -> Result<(), (&'static str, Error)> {
    if let Some(cfg) = &account.ews {
        ews::connect(cfg, creds, &account.email).await.map_err(|e| ("EWS", e))?;
        return Ok(());
    }
    let mut conn = imap::connect(&account.imap, creds).await.map_err(|e| ("IMAP", e))?;
    best_effort("log out", conn.session.logout().await);
    smtp::check(&account.smtp, creds).await.map_err(|e| ("SMTP", e))?;
    Ok(())
}

/// Sends a message: SMTP, or EWS with the copy in Sent Items made by the server.
pub async fn send(account: &Account, creds: &Credentials, msg: &lettre::Message) -> Result<Vec<u8>> {
    send_with_stage(account, creds, msg, &smtp::Stage::new()).await
}

/// Like `send`, but also tells the caller which step the attempt reached when it failed
/// (`smtp::send_with_stage`); EWS has no such detail yet, so its `stage` always reads "send"
/// once past the connect.
pub async fn send_with_stage(
    account: &Account,
    creds: &Credentials,
    msg: &lettre::Message,
    stage: &smtp::Stage,
) -> Result<Vec<u8>> {
    match &account.ews {
        Some(cfg) => {
            let mut s = ews::connect(cfg, creds, &account.email).await?;
            stage.set("send");
            ews::send(&mut s, msg).await
        }
        None => smtp::send_with_stage(&account.smtp, creds, msg, stage).await,
    }
}

/// The addresses the mailbox is reached by, the primary one first, as its server names them: none
/// when the server has no way to say, or names no name the app knows. IMAP knows no other address
/// of a mailbox than the one it signs in with (0.8.13, ступень 4).
pub async fn own_addresses(conn: &mut Conn, account: &Account) -> Result<Vec<String>> {
    match conn {
        Conn::Imap(_) => Ok(Vec::new()),
        Conn::Ews(s) => ews::own_addresses(s, &account.own_names()).await,
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

/// Reads the beginning of the text of the given letters (#177), for the list's preview:
/// the text part from IMAP, Exchange's own `Preview`. Nothing is marked read. Letters
/// gone from the server are simply missing from the answer.
pub async fn read_snippets(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> Result<Vec<(u32, String)>> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    match conn {
        Conn::Imap(c) => imap::fetch_snippets(c, folder, uids).await,
        Conn::Ews(s) => {
            let pairs = store.ews_item_ids_by_uid(account_id, folder, uids)?;
            let ids: Vec<String> = pairs.iter().map(|(_, id)| id.clone()).collect();
            let uid_of: std::collections::HashMap<String, u32> = pairs.into_iter().map(|(uid, id)| (id, uid)).collect();
            // An item Exchange answers with no `Preview` is stored as an empty text: the
            // letter leaves the backfill's selection instead of being asked for again.
            Ok(ews::previews(s, &ids)
                .await?
                .into_iter()
                .filter_map(|(id, text)| uid_of.get(&id).map(|uid| (*uid, text)))
                .collect())
        }
    }
}

/// Exchange UIDs are the cache's own: they name other items once the folder is
/// cached anew, which gives it a new UIDVALIDITY.
fn ews_check(store: &Store, account_id: &str, folder: &str, validity: u32) -> Result<()> {
    if store.folder_state(account_id, folder)?.0 != validity {
        return Err(Error::FolderChanged);
    }
    Ok(())
}

/// Changes a flag by UIDs read from the cache under `validity` (`Store::folder_state`);
/// refused with `FolderChanged` when the folder has been renumbered since. The same for
/// moving and deleting.
pub async fn set_flag(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    validity: u32,
    uids: &[u32],
    change: FlagChange,
) -> Result<()> {
    match conn {
        Conn::Imap(c) => imap::set_flag(c, folder, Some(validity), uids, change).await,
        Conn::Ews(s) => {
            ews_check(store, account_id, folder, validity)?;
            ews::set_flag(s, store, account_id, folder, uids, change).await
        }
    }
}

/// Puts labels on messages and takes them off, by the label's keyword. IMAP stores the
/// keyword; Exchange stores the category of the same name. The cache is updated after.
pub struct LabelChange<'a> {
    pub add: &'a [crate::acl::Label],
    pub remove: &'a [crate::acl::Label],
}

pub async fn set_labels(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    validity: u32,
    uids: &[u32],
    change: LabelChange<'_>,
) -> Result<()> {
    let add_kw: Vec<String> = change.add.iter().map(|l| l.keyword.clone()).collect();
    let remove_kw: Vec<String> = change.remove.iter().map(|l| l.keyword.clone()).collect();
    let changed: Vec<u32> = match conn {
        Conn::Imap(c) => {
            imap::set_keywords(c, folder, Some(validity), uids, &add_kw, &remove_kw).await?;
            // A server may store nothing and say nothing: Exchange 2019 answers FLAGS
            // without the keyword, so the set is remembered here until it is taken off
            // (#112). Exchange keeps a category itself, so its branch does not.
            store.remember_labels(account_id, folder, uids, &add_kw, &remove_kw)?;
            uids.to_vec()
        }
        Conn::Ews(s) => {
            ews_check(store, account_id, folder, validity)?;
            // Only letters with an Exchange id reached the server: a label shown for the
            // rest would vanish at the next sync without a word.
            ews::set_labels(s, store, account_id, folder, uids, change.add, change.remove).await?
        }
    };
    if changed.is_empty() {
        return Ok(());
    }
    // The server has the new keywords: the cache takes them in at once, so the row shows
    // the label without waiting for a sync.
    store.adjust_keywords(account_id, folder, &changed, &add_kw, &remove_kw)?;
    Ok(())
}

/// Takes a label's keyword off the messages of one folder (#42, frame 4Б): IMAP searches
/// the folder and clears the keyword; Exchange drops the category of the same name there.
/// Returns how many messages changed. The account-wide cache follows in `drop_keyword`,
/// run by the caller once every folder is done.
pub async fn strip_label(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    keyword: &str,
) -> Result<usize> {
    match conn {
        Conn::Imap(c) => {
            // A folder the user may only read cannot lose the keyword, and the server may
            // quietly ignore the change instead of refusing it: refuse it here, so the
            // caller skips the folder rather than thinking it is done.
            let (rights, _) = imap::folder_props(c, folder).await?;
            if rights.is_some_and(|r| r.read_only()) {
                return Err(crate::error::Error::Imap(async_imap::error::Error::No(
                    "code: Some(NOPERM), info: Some(\"the folder is read-only\")".into(),
                )));
            }
            imap::strip_keyword(c, folder, keyword).await
        }
        Conn::Ews(s) => ews::strip_category_in(s, store, account_id, folder, keyword).await,
    }
}

/// Renames a label's category on every message of the account (#42, frame 7): on Exchange
/// the name is the category, so the server rewrite is the rename. IMAP renames quietly in
/// the cache alone and never calls this.
pub async fn rename_category(conn: &mut Conn, store: &Store, account_id: &str, from: &str, to: &str) -> Result<usize> {
    match conn {
        Conn::Ews(s) => ews::rename_category(s, store, account_id, from, to).await,
        Conn::Imap(_) => Ok(0),
    }
}

/// Checks a folder without changing it: what the user may do (MYRIGHTS), whether labels
/// are kept here (PERMANENTFLAGS), the owner from NAMESPACE, and the namespaces themselves
/// on the first check. Nothing is written to the server: EXAMINE and MYRIGHTS read.
pub async fn folder_props(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
) -> Result<crate::acl::FolderProps> {
    let namespaces = ensure_namespaces(conn, store, account_id).await?;
    let display_name = store
        .folders(Some(account_id))?
        .into_iter()
        .find(|f| f.folder.name == folder)
        .map(|f| f.folder.display_name)
        .unwrap_or_else(|| folder.to_owned());
    let at = chrono::Utc::now().timestamp();
    match conn {
        Conn::Imap(c) => {
            let (rights, permanent) = imap::folder_props(c, folder).await?;
            Ok(crate::acl::FolderProps {
                folder: folder.to_owned(),
                display_name,
                owner: namespaces.owner_of(folder).unwrap_or(crate::acl::Owner::Mine),
                rights,
                labels_on_server: Some(permanent.labels_on_server()),
                permanent: permanent.standard,
                label_check: store.folder_prop(account_id, folder)?.and_then(|p| p.label_check),
                refused: None,
                checked: at,
            })
        }
        Conn::Ews(s) => {
            let rights = ews::folder_rights(s, store, account_id, folder).await?;
            Ok(crate::acl::FolderProps {
                folder: folder.to_owned(),
                display_name,
                owner: namespaces.owner_of(folder).unwrap_or(crate::acl::Owner::Mine),
                rights,
                // Exchange has no PERMANENTFLAGS: a category is always kept on the server.
                labels_on_server: Some(true),
                permanent: Vec::new(),
                label_check: store.folder_prop(account_id, folder)?.and_then(|p| p.label_check),
                refused: None,
                checked: at,
            })
        }
    }
}

/// Checks own labels on a test message in `folder` (#42, frame 9). IMAP does it whole;
/// Exchange keeps categories on the server always, so no test is needed there.
pub async fn check_labels(
    conn: &mut Conn,
    folder: &str,
    keyword: &str,
    message_id: &str,
    subject: &str,
) -> Result<crate::acl::LabelCheck> {
    match conn {
        Conn::Imap(c) => imap::check_labels(c, folder, keyword, message_id, subject).await,
        Conn::Ews(_) => Ok(crate::acl::LabelCheck::Saves),
    }
}

/// The account's namespaces, read once and kept; a server without NAMESPACE stays empty.
async fn ensure_namespaces(conn: &mut Conn, store: &Store, account_id: &str) -> Result<crate::acl::Namespace> {
    if let Some((ns, _)) = store.namespaces(account_id)? {
        return Ok(ns);
    }
    let ns = match conn {
        // A read error (a timeout, a desynced session) is passed on: the connection is
        // dropped rather than reused. A refused answer is an empty namespace, handled
        // inside `imap::namespace`.
        Conn::Imap(c) => imap::namespace(c).await?,
        // Exchange has no namespaces: delegated mailboxes are named by their owner instead.
        Conn::Ews(_) => crate::acl::Namespace::default(),
    };
    store.save_namespaces(account_id, &ns, chrono::Utc::now().timestamp())?;
    Ok(ns)
}

pub async fn move_messages(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    from: &str,
    validity: u32,
    uids: &[u32],
    to: &str,
) -> Result<Vec<(u32, u32)>> {
    match conn {
        Conn::Imap(c) => {
            let floor = new_uid_floor(c, store, account_id, from, to).await;
            let pairs = imap::move_messages(c, from, Some(validity), uids, to).await?;
            let moved = Moved {
                from,
                to,
                uids,
                pairs,
                floor,
            };
            Ok(moved_pairs(c, store, account_id, moved).await)
        }
        // A label on Exchange is a category of the letter itself: it goes with the move, and
        // nothing of `local_labels` is touched.
        Conn::Ews(s) => {
            ews_check(store, account_id, from, validity)?;
            ews::move_messages(s, store, account_id, from, uids, to).await?;
            Ok(Vec::new())
        }
    }
}

/// Finishes a move that was cut short without MOVE: letters whose copy already reached the
/// target are not copied a second time. Used by the retry after a dropped connection.
pub async fn resume_move(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    from: &str,
    validity: u32,
    uids: &[u32],
    to: &str,
) -> Result<Vec<(u32, u32)>> {
    match conn {
        Conn::Imap(c) => {
            // No floor here: the letters of the cut run may already lie in the target, and the
            // resumed COPY names only the rest (`not_yet_moved` knows the others by size).
            let pairs = imap::resume_move(c, from, Some(validity), uids, to).await?;
            let moved = Moved {
                from,
                to,
                uids,
                pairs,
                floor: None,
            };
            Ok(moved_pairs(c, store, account_id, moved).await)
        }
        // Exchange's move is atomic: a second call is the ordinary one.
        Conn::Ews(s) => {
            ews_check(store, account_id, from, validity)?;
            ews::move_messages(s, store, account_id, from, uids, to).await?;
            Ok(Vec::new())
        }
    }
}

/// One move, as the labels of its letters need it.
struct Moved<'a> {
    from: &'a str,
    to: &'a str,
    /// The letters the move took, by their UIDs in `from`.
    uids: &'a [u32],
    /// Old UID → new UID as the server named them.
    pairs: Vec<(u32, u32)>,
    /// The smallest UID `to` gives a letter that arrives now (`new_uid_floor`): what lies there
    /// below it is not a letter this move brought.
    floor: Option<u32>,
}

/// The old UID → new UID pairs of a move, with the letters the server left unpaired:
/// `COPYUID` is absent without UIDPLUS, and a resumed move names only what it copied. A
/// labelled letter is looked for in `to` by its Message-ID and size, with the retries a lagging
/// index needs. One still without a pair keeps no label, and one warning says how many, for
/// `to` alone: not the letter, and not the server's words.
async fn moved_pairs(conn: &mut imap::Conn, store: &Store, account_id: &str, moved: Moved<'_>) -> Vec<(u32, u32)> {
    let Moved {
        from,
        to,
        uids,
        mut pairs,
        floor,
    } = moved;
    // Only a letter labelled here has a label to carry: the others lose nothing with the UID.
    let labelled: HashSet<u32> = match store.local_labels(account_id, from) {
        Ok(rows) => rows.into_iter().map(|(uid, _)| uid).collect(),
        Err(e) => {
            best_effort("read the labels a move has to carry", Err::<(), _>(e));
            HashSet::new()
        }
    };
    let mut lost = 0usize;
    for &old in uids {
        if !labelled.contains(&old) || pairs.iter().any(|(paired, _)| *paired == old) {
            continue;
        }
        let found = match store.find_by_uid(account_id, from, old) {
            // A size the fetch never carried is no size: the letter is looked for by its name then.
            Ok(row) => row.and_then(|row| Some((row.message_id?, (row.size > 0).then_some(row.size)))),
            Err(e) => {
                best_effort("read the letter a move renamed", Err::<(), _>(e));
                None
            }
        };
        match found {
            Some((message_id, size)) => match find_in_target(conn, to, &message_id, size, &pairs, floor).await {
                Some(new) => pairs.push((old, new)),
                None => lost += 1,
            },
            None => lost += 1,
        }
    }
    if lost > 0 {
        tracing::warn!(folder = %to, lost, "labels of moved letters have no new UID");
    }
    pairs
}

/// The UID the letter arrived at, looked for a few times: a search index lags behind a move
/// as it does behind an APPEND (`imap::find_moved`). Another letter is no answer: not one that
/// took a UID already paired, not one of another size, and not one that lay there before the
/// move.
async fn find_in_target(
    conn: &mut imap::Conn,
    to: &str,
    message_id: &str,
    size: Option<u32>,
    pairs: &[(u32, u32)],
    floor: Option<u32>,
) -> Option<u32> {
    let taken: Vec<u32> = pairs.iter().map(|(_, new)| *new).collect();
    match imap::find_moved(conn, to, message_id, size).await {
        Ok(found) => found
            .into_iter()
            .find(|uid| !taken.contains(uid) && floor.is_none_or(|floor| *uid >= floor)),
        Err(e) => {
            best_effort("find a moved letter in the folder it arrived in", Err::<(), _>(e));
            None
        }
    }
}

/// The smallest UID `to` gives a letter that arrives now: what lies there already is not the
/// letter a move brings, even with the same Message-ID and size (#201). Asked before the move,
/// and only when a letter of `from` carries a label to carry: an ordinary move pays nothing.
async fn new_uid_floor(conn: &mut imap::Conn, store: &Store, account_id: &str, from: &str, to: &str) -> Option<u32> {
    match store.local_labels(account_id, from) {
        Ok(rows) if rows.is_empty() => return None,
        Ok(_) => {}
        Err(e) => best_effort("read the labels a move has to carry", Err::<(), _>(e)),
    }
    match imap::folder_mark(conn, to).await {
        Ok((_, _, next)) => Some(next),
        Err(e) => {
            best_effort("read the UID the next letter of the target gets", Err::<(), _>(e));
            None
        }
    }
}

pub async fn delete_permanently(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    validity: u32,
    uids: &[u32],
) -> Result<()> {
    match conn {
        Conn::Imap(c) => imap::delete_permanently(c, folder, Some(validity), uids).await,
        Conn::Ews(s) => {
            ews_check(store, account_id, folder, validity)?;
            ews::delete_permanently(s, store, account_id, folder, uids).await
        }
    }
}

/// How many messages the folder holds on the server (the cache keeps a window of it).
pub async fn folder_total(conn: &mut Conn, store: &Store, account_id: &str, folder: &str) -> Result<usize> {
    match conn {
        Conn::Imap(c) => Ok(imap::folder_total(c, folder).await? as usize),
        Conn::Ews(s) => ews::folder_total(s, store, account_id, folder).await,
    }
}

/// How many messages the folder holds on the server and the bound that counted them.
pub async fn folder_count(conn: &mut Conn, store: &Store, account_id: &str, folder: &str) -> Result<(usize, Bound)> {
    match conn {
        Conn::Imap(c) => {
            let (n, bound) = ImapServer::new(c, store, account_id, EMPTY_BATCH).count(folder).await?;
            Ok((n, Bound::Imap(bound)))
        }
        Conn::Ews(s) => {
            let (n, bound) = EwsServer { s, store, account_id }.count(folder).await?;
            Ok((n, Bound::Ews(bound)))
        }
    }
}

/// What `empty_folder` wipes and how: the folder, the way, what the dialog counted, the UIDs
/// that stay. `batch` is the size of an IMAP request; Exchange takes its own.
pub struct Wipe<'a> {
    pub folder: &'a str,
    pub how: &'a Emptying,
    pub bound: &'a Bound,
    pub keep: &'a [u32],
    pub batch: usize,
}

/// Empties the folder on the server (`clear::empty_folder`) over the port of the connection's
/// kind.
pub async fn empty_folder(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    wipe: Wipe<'_>,
    progress: &mut (dyn FnMut(usize, usize) -> bool + Send),
) -> Result<Emptied> {
    let Wipe {
        folder,
        how,
        bound,
        keep,
        batch,
    } = wipe;
    match (conn, bound) {
        (Conn::Imap(c), Bound::Imap(b)) => {
            clear::empty_folder(
                &mut ImapServer::new(c, store, account_id, batch),
                folder,
                how,
                b,
                keep,
                progress,
            )
            .await
        }
        (Conn::Ews(s), Bound::Ews(b)) => {
            clear::empty_folder(&mut EwsServer { s, store, account_id }, folder, how, b, keep, progress).await
        }
        _ => Err(not_of_this_mailbox()),
    }
}

/// Runs a queued «Clear» (`clear::perform`) over the port of the connection's kind.
pub async fn clear_folder(
    conn: &mut Conn,
    store: &Store,
    clearing: &Clearing,
    account_id: &str,
    req: &clear::Request<Bound>,
    progress: &mut (dyn FnMut(usize, usize) -> bool + Send),
    cache_forgot: &mut (dyn FnMut(Forgot) + Send),
) -> Performed {
    match (conn, &req.bound) {
        (Conn::Imap(c), Bound::Imap(b)) => {
            let mut server = ImapServer::new(c, store, account_id, EMPTY_BATCH);
            let req = req.with_bound(b.clone());
            clear::perform(&mut server, store, clearing, account_id, &req, progress, cache_forgot).await
        }
        (Conn::Ews(s), Bound::Ews(b)) => {
            let mut server = EwsServer { s, store, account_id };
            let req = req.with_bound(b.clone());
            clear::perform(&mut server, store, clearing, account_id, &req, progress, cache_forgot).await
        }
        _ => Performed {
            result: Err(not_of_this_mailbox()),
            last: (0, 0),
            kept_ids: Vec::new(),
        },
    }
}

/// What a count of a folder named (#74): the folder as it was when the dialog counted it. What
/// arrives afterwards is not in it and is never wiped, and a run repeated from the same bound
/// goes on with what is left of it. Each kind of mailbox counts its own way (`ImapBound`,
/// `EwsBound`); the app, which learns the kind only from the connection, holds either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bound {
    Imap(ImapBound),
    Ews(EwsBound),
}

/// IMAP: the messages of this UIDVALIDITY with a UID below `next` (the UIDNEXT then).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImapBound {
    pub validity: u32,
    pub next: u32,
}

/// Exchange: the items the folder held then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EwsBound(pub Vec<String>);

impl Count for Bound {
    fn covers<'a>(&'a self, store: &Store, account_id: &str, folder: &str) -> Box<dyn Fn(u32) -> bool + Send + 'a> {
        match self {
            Bound::Imap(b) => b.covers(store, account_id, folder),
            Bound::Ews(b) => b.covers(store, account_id, folder),
        }
    }
}

impl Count for ImapBound {
    /// Below the UIDNEXT of the count: a letter that arrived since is outside it.
    fn covers<'a>(&'a self, _: &Store, _: &str, _: &str) -> Box<dyn Fn(u32) -> bool + Send + 'a> {
        Box::new(|uid| uid < self.next)
    }
}

impl Count for EwsBound {
    /// An item of the snapshot, by the cache's table of items.
    fn covers<'a>(&'a self, store: &Store, account_id: &str, folder: &str) -> Box<dyn Fn(u32) -> bool + Send + 'a> {
        let snapshot: HashSet<&str> = self.0.iter().map(String::as_str).collect();
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

/// The connection and the bound of a run are of different kinds of mailbox: the one thing the
/// types cannot tell, as the app learns the kind at run time.
fn not_of_this_mailbox() -> Error {
    Error::Protocol("the bound of the clearing is not of this mailbox".into())
}

/// The UIDs of an IMAP folder (`uids`, read under `validity`) that the `bound` names, but
/// `keep`: those below the UIDNEXT of the count. A folder renumbered since is `FolderChanged`.
fn within_bound(validity: u32, uids: Vec<u32>, bound: &ImapBound, keep: &[u32]) -> Result<Vec<u32>> {
    if validity != bound.validity {
        return Err(Error::FolderChanged);
    }
    Ok(uids
        .into_iter()
        .filter(|u| *u < bound.next && !keep.contains(u))
        .collect())
}

/// The items of an Exchange folder that the `bound` (a snapshot of its items) names, but `kept`.
fn within_snapshot(bound: &EwsBound, kept: &[String]) -> Vec<String> {
    bound.0.iter().filter(|id| !kept.contains(id)).cloned().collect()
}

/// The port of the mail server over an IMAP connection. It remembers the UIDVALIDITY the
/// UIDs it handed out were read under, and every change by them is checked against it.
pub(crate) struct ImapServer<'a> {
    conn: &'a mut imap::Conn,
    store: &'a Store,
    account_id: &'a str,
    batch: usize,
    validity: Option<u32>,
}

impl<'a> ImapServer<'a> {
    pub(crate) fn new(conn: &'a mut imap::Conn, store: &'a Store, account_id: &'a str, batch: usize) -> Self {
        Self {
            conn,
            store,
            account_id,
            batch,
            validity: None,
        }
    }
}

/// The UIDVALIDITY the UIDs were read under. UIDs nobody counted name nothing, and without the
/// validity the server would not check them (`imap::select_at` skips a `None`).
fn counted_under(validity: Option<u32>) -> Result<u32> {
    validity.ok_or_else(|| Error::Protocol("UIDs were changed that were never counted".into()))
}

impl MailServer for ImapServer<'_> {
    type Item = u32;
    type Bound = ImapBound;

    async fn count(&mut self, folder: &str) -> Result<(usize, ImapBound)> {
        let (exists, validity, next) = imap::folder_mark(self.conn, folder).await?;
        Ok((exists as usize, ImapBound { validity, next }))
    }

    /// The cache numbers the messages by their UIDs.
    async fn items_of(&mut self, _folder: &str, cached: &[u32]) -> Result<Vec<u32>> {
        Ok(cached.to_vec())
    }

    async fn counted(&mut self, folder: &str, bound: &ImapBound, keep: &[u32]) -> Result<Vec<u32>> {
        let (validity, uids) = imap::folder_uids(self.conn, folder).await?;
        let uids = within_bound(validity, uids, bound, keep)?;
        self.validity = Some(validity);
        Ok(uids)
    }

    async fn erase(&mut self, folder: &str, items: &[u32]) -> Result<()> {
        imap::delete_permanently(self.conn, folder, Some(counted_under(self.validity)?), items).await
    }

    async fn move_to(&mut self, folder: &str, items: &[u32], to: &str) -> Result<()> {
        let floor = new_uid_floor(self.conn, self.store, self.account_id, folder, to).await;
        let pairs = imap::move_messages(self.conn, folder, Some(counted_under(self.validity)?), items, to).await?;
        // A folder emptied by moving loses its labels the same way a single move does (#201).
        let moved = Moved {
            from: folder,
            to,
            uids: items,
            pairs,
            floor,
        };
        let pairs = moved_pairs(self.conn, self.store, self.account_id, moved).await;
        self.store.move_local_labels(self.account_id, folder, to, &pairs)?;
        Ok(())
    }

    fn batch(&self) -> usize {
        self.batch
    }
}

/// Exchange moves items a hundred at a time.
const EWS_EMPTY_BATCH: usize = 100;

/// The port of the mail server over an Exchange session. Its items are named by id; the
/// cache says which of them the cached UIDs are.
pub(crate) struct EwsServer<'a> {
    s: &'a mut ews::Session,
    store: &'a Store,
    account_id: &'a str,
}

impl MailServer for EwsServer<'_> {
    type Item = String;
    type Bound = EwsBound;

    async fn count(&mut self, folder: &str) -> Result<(usize, EwsBound)> {
        let ids = ews::folder_item_ids(self.s, self.store, self.account_id, folder).await?;
        Ok((ids.len(), EwsBound(ids)))
    }

    async fn items_of(&mut self, folder: &str, cached: &[u32]) -> Result<Vec<String>> {
        self.store.ews_item_ids(self.account_id, folder, cached)
    }

    async fn counted(&mut self, _folder: &str, bound: &EwsBound, keep: &[String]) -> Result<Vec<String>> {
        Ok(within_snapshot(bound, keep))
    }

    async fn erase(&mut self, _folder: &str, items: &[String]) -> Result<()> {
        ews::delete_item_ids(self.s, items).await
    }

    async fn move_to(&mut self, _folder: &str, items: &[String], to: &str) -> Result<()> {
        ews::move_item_ids(self.s, self.store, self.account_id, items, to).await
    }

    fn batch(&self) -> usize {
        EWS_EMPTY_BATCH
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
        Conn::Imap(c) => imap::append_unless_exists(c, folder, raw, flags, message_id).await,
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

/// How the cache names a folder, as the server wants it said: IMAP keeps the name in modified
/// UTF-7, Exchange the path as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolNames {
    Imap,
    Exchange,
}

impl ProtocolNames {
    fn of(conn: &Conn) -> Self {
        match conn {
            Conn::Imap(_) => Self::Imap,
            Conn::Ews(_) => Self::Exchange,
        }
    }
}

/// The whole path of a folder `name` made under `parent` (a folder name as the cache keeps it),
/// as the server's create wants it. Its delimiter is the parent's, a slash when the cache does
/// not know the parent. Names come from the cache, not from the protocol: callers say which
/// folder they mean, not how the server spells it.
fn child_path(store: &Store, account_id: &str, names: ProtocolNames, parent: &str, name: &str) -> Result<String> {
    let delimiter = store
        .folders(Some(account_id))?
        .into_iter()
        .find(|f| f.folder.name == parent)
        .and_then(|f| f.folder.delimiter)
        .unwrap_or_else(|| "/".into());
    let parent = match names {
        ProtocolNames::Imap => crate::utf7::decode(parent),
        ProtocolNames::Exchange => parent.to_owned(),
    };
    Ok(format!("{parent}{delimiter}{name}"))
}

/// The name a new folder may take: one without the delimiter of the place it goes into (the
/// parent's, at the top the account's), since the server would split it into a chain of folders.
/// Where the cache knows no delimiter, a slash is assumed, as `child_path` does.
fn checked_name<'a>(store: &Store, account_id: &str, parent: Option<&str>, name: &'a str) -> Result<&'a str> {
    let folders = store.folders(Some(account_id))?;
    let delimiter = match parent {
        Some(p) => folders
            .iter()
            .find(|f| f.folder.name == p)
            .and_then(|f| f.folder.delimiter.clone()),
        None => folders.iter().find_map(|f| f.folder.delimiter.clone()),
    };
    let delimiter = delimiter.filter(|d| !d.is_empty()).unwrap_or_else(|| "/".into());
    if name.contains(&delimiter) {
        return Err(Error::FolderName(delimiter));
    }
    Ok(name)
}

/// Makes a folder `name`, inside `parent` (a folder name as the cache keeps it) or at the top.
pub async fn create_folder(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    parent: Option<&str>,
    name: &str,
) -> Result<()> {
    let name = checked_name(store, account_id, parent, name)?;
    let full = match parent {
        Some(parent) => child_path(store, account_id, ProtocolNames::of(conn), parent, name)?,
        None => name.to_owned(),
    };
    match conn {
        Conn::Imap(c) => imap::create_folder(c, &full).await,
        Conn::Ews(s) => ews::create_folder(s, store, account_id, &full).await,
    }
}

/// Moves messages found by Message-ID (UIDs change on every move). Returns how many moved, and
/// their old UID → new UID pairs (`moved_pairs`).
pub async fn move_by_message_id(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    from: &str,
    message_ids: &[String],
    to: &str,
    unseen: bool,
) -> Result<(usize, Vec<(u32, u32)>)> {
    match conn {
        Conn::Imap(c) => {
            let (validity, _) = store.folder_state(account_id, from)?;
            let mut uids = Vec::new();
            let mut cached = false;
            for mid in message_ids {
                // The cache has the UID: the move that put the message here synced the
                // folder. The server's search may not have it yet: Yandex indexes moved
                // mail with a delay, and "z" right after "e" found nothing.
                match store.find_by_message_id(account_id, from, mid)? {
                    Some(row) => {
                        uids.push(row.uid);
                        cached = true;
                    }
                    None => uids.extend(imap::find_by_message_id(c, from, mid).await?),
                }
            }
            if uids.is_empty() {
                return Ok((0, Vec::new()));
            }
            // UIDs from the cache hold only while the folder keeps its UIDVALIDITY.
            let validity = cached.then_some(validity);
            // Flags travel with the message: unread before the move, no search after it.
            if unseen {
                imap::set_flag(c, from, validity, &uids, FlagChange::Seen(false)).await?;
            }
            let floor = new_uid_floor(c, store, account_id, from, to).await;
            let pairs = imap::move_messages(c, from, validity, &uids, to).await?;
            let moved = Moved {
                from,
                to,
                uids: &uids,
                pairs,
                floor,
            };
            let pairs = moved_pairs(c, store, account_id, moved).await;
            Ok((uids.len(), pairs))
        }
        // A category of the letter goes with it on Exchange: no pairs, nothing local moved.
        Conn::Ews(s) => Ok((
            ews::move_by_message_id(s, store, account_id, from, message_ids, to, unseen).await?,
            Vec::new(),
        )),
    }
}

pub async fn load_older(conn: &mut Conn, store: &Store, account_id: &str, folder: &str, count: usize) -> Result<usize> {
    match conn {
        Conn::Imap(c) => sync::load_older(c, store, account_id, folder, count).await,
        Conn::Ews(s) => ews::load_older(s, store, account_id, folder, count).await,
    }
}

/// A subscription that broke: the error, how it broke and what the pace makes of it.
#[derive(Debug)]
pub struct IdleDrop {
    pub error: Error,
    pub cause: DropCause,
    /// Since the last thing the client wrote (the start of this wait).
    pub since_wait: Duration,
    pub since_connect: Duration,
    /// The renewal this IDLE was held under; `None` for a transport that takes none (EWS).
    pub renew: Option<Duration>,
    /// What the pace says to do next; `None` for a busy server, whose own pause is kept.
    pub dropped: Option<Dropped>,
}

/// Waits for changes in the inbox (IMAP IDLE renewed as the `pace` says, EWS streaming
/// notifications, or polling) and gives the connection back. `connected` is when the
/// connection was made. A break comes back with its cause and the pace's verdict.
pub async fn wait_for_changes(
    conn: Conn,
    store: &Store,
    account_id: &str,
    poll: Duration,
    pace: &mut IdlePace,
    connected: Instant,
) -> std::result::Result<(Conn, IdleOutcome), Box<IdleDrop>> {
    let began = Instant::now();
    let resync = pace.take_resync();
    let mut conn = conn;
    // A connection new after a drop: a letter that came in the pause is told by the mark of
    // the cache (what a sync left of EXISTS and UIDNEXT) against what the SELECT says; flags
    // changed meanwhile wait for the sync that runs every few minutes anyway. EWS has no such
    // mark, but its sync is incremental (the server keeps the state), so a sync at once is cheap.
    let mut ended = None;
    let polling = pace.polling();
    if polling {
        // A link that does not hold an IDLE is asked about the inbox every `poll`: a SELECT
        // finds out whether it is alive (a NOOP would not tell a link that died while it
        // idled), and the sync that follows finds the news.
        tokio::time::sleep(poll).await;
        ended = Some(match &mut conn {
            Conn::Imap(c) => imap::select_for_idle(c, "INBOX").await.map(|_| IdleOutcome::Changed),
            Conn::Ews(_) => Ok(IdleOutcome::Changed),
        });
    } else if resync {
        ended = match &mut conn {
            Conn::Imap(c) => match imap::select_for_idle(c, "INBOX").await.and_then(|m| {
                let saved = store.modseq_mark(account_id, "INBOX")?;
                // UIDNEXT 0 in the mark: the sync did not get one (an empty mailbox), only the count tells.
                Ok(saved.exists != m.exists || (saved.uid_next != 0 && Some(saved.uid_next) != m.uid_next))
            }) {
                Ok(true) => Some(Ok(IdleOutcome::Changed)),
                Ok(false) => None,
                Err(e) => Some(Err(e)),
            },
            Conn::Ews(_) => Some(Ok(IdleOutcome::Changed)),
        };
    }
    let mut worked = None;
    let (result, renew) = match (ended, conn) {
        (Some(r), conn) => (r.map(|o| (conn, o)), None),
        (None, Conn::Imap(c)) => {
            let renew = pace.renew();
            worked = Some(c.worked.clone());
            let r = imap::wait_for_changes(c, "INBOX", poll, renew).await;
            (r.map(|(c, o)| (Conn::Imap(c), o)), Some(renew))
        }
        (None, Conn::Ews(mut s)) => {
            worked = Some(s.worked());
            let r = ews::wait_for_changes(&mut s, store, account_id, poll).await;
            (r.map(|o| (Conn::Ews(s), o)), None)
        }
    };
    match result {
        Ok(done) => {
            if polling {
                pace.polled();
            } else if !resync {
                pace.renewed();
            }
            Ok(done)
        }
        Err(error) => {
            let info = DropInfo {
                cause: DropCause::of(&error),
                since_wait: began.elapsed(),
                since_connect: connected.elapsed(),
                renew,
                worked: pace.worked_since_drop() || worked.is_some_and(|w| w.load(Ordering::Relaxed)),
            };
            let dropped = (!error.is_busy()).then(|| pace.dropped(&info));
            // A poll that found the link dead is a poll all the same: IDLE is tried again
            // after the set number of them, whatever they met.
            if polling {
                pace.polled();
            }
            Err(Box::new(IdleDrop {
                error,
                cause: info.cause,
                since_wait: info.since_wait,
                since_connect: info.since_connect,
                renew,
                dropped,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_imap_count_names_the_uids_below_its_uidnext_of_its_own_validity() {
        let bound = ImapBound { validity: 7, next: 4 };
        // UID 4 arrived after the count, 2 must stay.
        assert_eq!(within_bound(7, vec![1, 2, 3, 4], &bound, &[2]).unwrap(), [1, 3]);
        // The folder was renumbered since: nothing is named.
        assert!(matches!(
            within_bound(8, vec![1], &bound, &[]),
            Err(Error::FolderChanged)
        ));
        let inside = bound.covers(&Store::open_in_memory().unwrap(), "a", "F");
        assert!(inside(3) && !inside(4));
    }

    #[test]
    fn an_exchange_snapshot_gives_up_what_must_stay() {
        let snapshot = EwsBound(vec!["a".into(), "b".into(), "c".into()]);
        assert_eq!(within_snapshot(&snapshot, &["b".to_owned()]), ["a", "c"]);
    }

    #[test]
    fn a_folder_is_made_under_its_parent_by_the_name_each_kind_of_server_knows_it_by() {
        let store = Store::open_in_memory().unwrap();
        let mk = |name: &str, delimiter: Option<&str>| Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: delimiter.map(str::to_owned),
            role: None,
            selectable: true,
            hidden: false,
        };
        // IMAP keeps the name in modified UTF-7, and creating encodes the whole path again.
        let parent = crate::utf7::encode("Работа");
        store.replace_folders("a", &[mk(&parent, Some("."))]).unwrap();
        assert_eq!(
            child_path(&store, "a", ProtocolNames::Imap, &parent, "Отчёты").unwrap(),
            "Работа.Отчёты"
        );
        // IMAP with a slash for a delimiter: the same, the delimiter is the parent's.
        store.replace_folders("c", &[mk(&parent, Some("/"))]).unwrap();
        assert_eq!(
            child_path(&store, "c", ProtocolNames::Imap, &parent, "Отчёты").unwrap(),
            "Работа/Отчёты"
        );
        // A parent the cache does not know (an empty cache) gets a slash, and is decoded all the
        // same: "&BCAEMAQxBD4EQgQw-" is "Работа".
        let empty = Store::open_in_memory().unwrap();
        assert_eq!(
            child_path(&empty, "a", ProtocolNames::Imap, "&BCAEMAQxBD4EQgQw-", "X").unwrap(),
            "Работа/X"
        );
        // Exchange keeps the path as it is.
        store.replace_folders("b", &[mk("Работа", Some("/"))]).unwrap();
        assert_eq!(
            child_path(&store, "b", ProtocolNames::Exchange, "Работа", "Отчёты").unwrap(),
            "Работа/Отчёты"
        );
        assert_eq!(
            child_path(&empty, "b", ProtocolNames::Exchange, "Неизвестная", "X").unwrap(),
            "Неизвестная/X"
        );
    }

    /// A delimiter inside the name would make the server build a chain of folders (#161).
    #[test]
    fn a_folder_name_with_the_delimiter_inside_is_refused() {
        let store = Store::open_in_memory().unwrap();
        let mk = |name: &str, delimiter: &str| Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: Some(delimiter.into()),
            role: None,
            selectable: true,
            hidden: false,
        };
        store.replace_folders("a", &[mk("Работа", ".")]).unwrap();
        assert!(matches!(
            checked_name(&store, "a", Some("Работа"), "Отчёты.2026"),
            Err(Error::FolderName(d)) if d == "."
        ));
        // At the top the account's delimiter counts, whichever folder tells it.
        assert!(matches!(
            checked_name(&store, "a", None, "A.B"),
            Err(Error::FolderName(_))
        ));
        // The other kind of slash is a plain letter here, and an unknown parent gets a slash.
        assert_eq!(
            checked_name(&store, "a", Some("Работа"), "Отчёты/2026").unwrap(),
            "Отчёты/2026"
        );
        assert!(checked_name(&store, "a", Some("Нет"), "A/B").is_err());
        assert_eq!(checked_name(&store, "a", None, "Отчёты").unwrap(), "Отчёты");
    }

    #[test]
    fn uids_that_were_never_counted_are_not_changed() {
        assert!(matches!(counted_under(None), Err(Error::Protocol(_))));
        assert_eq!(counted_under(Some(7)).unwrap(), 7);
    }

    /// UIDs read before an Exchange folder was cached anew name other items: refused.
    #[test]
    fn exchange_actions_on_uids_of_a_cleared_folder_are_refused() {
        let store = Store::open_in_memory().unwrap();
        let inbox = Folder {
            name: "INBOX".into(),
            display_name: "INBOX".into(),
            delimiter: Some("/".into()),
            role: None,
            selectable: true,
            hidden: false,
        };
        store.replace_folders("a", &[inbox]).unwrap();
        store.ews_set_folders("a", &[("INBOX".into(), "id-1".into())]).unwrap();
        store.set_folder_state("a", "INBOX", 1, 1000).unwrap();
        let (validity, _) = store.folder_state("a", "INBOX").unwrap();
        ews_check(&store, "a", "INBOX", validity).unwrap();

        store.ews_clear_folder("a", "INBOX").unwrap();
        assert!(matches!(
            ews_check(&store, "a", "INBOX", validity),
            Err(Error::FolderChanged)
        ));
        let (fresh, _) = store.folder_state("a", "INBOX").unwrap();
        ews_check(&store, "a", "INBOX", fresh).unwrap();
    }

    // The paths a move takes (#201), on a fake server that keeps no keywords.

    const INBOX: &str = "INBOX";
    const ARCHIVE: &str = "Archive";

    /// A letter of the fake server: its UID, the Message-ID it answers for, and its size.
    #[derive(Clone)]
    struct Letter {
        uid: u32,
        message_id: &'static str,
        size: u32,
    }

    fn letter(uid: u32, message_id: &'static str, size: u32) -> Letter {
        Letter { uid, message_id, size }
    }

    /// A fake IMAP server for the paths a move takes: two folders of letters, `MOVE` and `COPY`
    /// that may or may not name the new UIDs (`COPYUID`, RFC 4315), and no keywords at all —
    /// every `FLAGS` answer is empty, as Exchange IMAP answers a folder that keeps none (#112).
    /// The letter a move brings gets UIDs from `next` up.
    struct Fake {
        folders: [(&'static str, Vec<Letter>); 2],
        copyuid: bool,
        next: u32,
        selected: &'static str,
    }

    impl Fake {
        fn new(inbox: Vec<Letter>, archive: Vec<Letter>) -> Self {
            Self {
                folders: [(INBOX, inbox), (ARCHIVE, archive)],
                copyuid: true,
                next: 7,
                selected: INBOX,
            }
        }

        /// A server without UIDPLUS: a MOVE or a COPY names no UID, and the letters are found
        /// by their Message-IDs.
        fn without_copyuid(mut self) -> Self {
            self.copyuid = false;
            self
        }

        fn letters(&self, folder: &str) -> &[Letter] {
            &self
                .folders
                .iter()
                .find(|(f, _)| *f == folder)
                .expect("a folder of the fake")
                .1
        }

        fn letters_mut(&mut self, folder: &str) -> &mut Vec<Letter> {
            &mut self
                .folders
                .iter_mut()
                .find(|(f, _)| *f == folder)
                .expect("a folder of the fake")
                .1
        }

        /// The UID the next letter to arrive in the folder gets.
        fn uidnext(&self, folder: &str) -> u32 {
            self.letters(folder)
                .iter()
                .map(|l| l.uid)
                .max()
                .map_or(self.next, |max| max + 1)
        }

        fn answer(&mut self, line: &str) -> String {
            let up = line.to_ascii_uppercase();
            let mut parts = line.split_whitespace();
            let tag = parts.next().unwrap_or("*").to_owned();
            let verb = parts.next().unwrap_or("").to_ascii_uppercase();
            let sub = parts.next().unwrap_or("").to_ascii_uppercase();
            if verb == "CAPABILITY" {
                let uidplus = if self.copyuid { " UIDPLUS" } else { "" };
                return format!("* CAPABILITY IMAP4rev1 MOVE{uidplus}\r\n{tag} OK done\r\n");
            }
            if verb == "LIST" {
                return format!(
                    "* LIST () \"/\" \"{INBOX}\"\r\n* LIST (\\Archive) \"/\" \"{ARCHIVE}\"\r\n{tag} OK done\r\n"
                );
            }
            if verb == "SELECT" || verb == "EXAMINE" {
                self.selected = if up.contains("ARCHIVE") { ARCHIVE } else { INBOX };
                let exists = self.letters(self.selected).len();
                let next = self.uidnext(self.selected);
                return format!(
                    "* FLAGS ()\r\n* {exists} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT {next}] ok\r\n{tag} OK [READ-WRITE] done\r\n"
                );
            }
            if verb != "UID" {
                return format!("{tag} OK done\r\n");
            }
            let set = parts.next().unwrap_or_default();
            match sub.as_str() {
                "SEARCH" => self.search(&up, &tag),
                "FETCH" => self.fetch(&up, &tag, set),
                "MOVE" | "COPY" => self.move_letters(&up, &tag, set, sub == "MOVE"),
                _ => format!("{tag} OK done\r\n"),
            }
        }

        fn search(&self, up: &str, tag: &str) -> String {
            let by_header = up.contains("HEADER");
            let found: Vec<String> = self
                .letters(self.selected)
                .iter()
                .filter(|_| !up.contains("DELETED"))
                .filter(|l| !by_header || up.contains(&l.message_id.to_ascii_uppercase()))
                .map(|l| l.uid.to_string())
                .collect();
            let list = if found.is_empty() {
                String::new()
            } else {
                format!(" {}", found.join(" "))
            };
            format!("* SEARCH{list}\r\n{tag} OK done\r\n")
        }

        fn fetch(&self, up: &str, tag: &str, set: &str) -> String {
            let mut body = String::new();
            for (n, l) in self.mine(set).iter().enumerate() {
                let header = if up.contains("HEADER.FIELDS (MESSAGE-ID)") {
                    format!("Message-ID: <{}>\r\n\r\n", l.message_id)
                } else if up.contains("BODY.PEEK[HEADER]") {
                    format!(
                        "Subject: Письмо\r\nFrom: Тест <t@example.org>\r\nMessage-ID: <{}>\r\nDate: Fri, 2 Oct 2026 10:00:00 +0300\r\n\r\n",
                        l.message_id
                    )
                } else {
                    // Flags alone, or the text of a preview: no keyword and no text here.
                    body += &format!("* {} FETCH (UID {} FLAGS ())\r\n", n + 1, l.uid);
                    continue;
                };
                let part = if up.contains("HEADER.FIELDS") {
                    "HEADER.FIELDS (MESSAGE-ID)"
                } else {
                    "HEADER"
                };
                body += &format!(
                    "* {} FETCH (UID {} FLAGS () RFC822.SIZE {} BODY[{part}] {{{}}}\r\n{header})\r\n",
                    n + 1,
                    l.uid,
                    l.size,
                    header.len()
                );
            }
            format!("{body}{tag} OK done\r\n")
        }

        fn move_letters(&mut self, up: &str, tag: &str, set: &str, moving: bool) -> String {
            let target = if up.contains("ARCHIVE") { ARCHIVE } else { INBOX };
            let source = self.selected;
            let (mut from, mut to) = (Vec::new(), Vec::new());
            for l in &self.mine(set) {
                from.push(l.uid);
                to.push(self.next);
                let arrived = Letter { uid: self.next, ..*l };
                self.next += 1;
                self.letters_mut(target).push(arrived);
            }
            let taken = uid_set_of(set);
            if moving {
                self.letters_mut(source).retain(|l| !taken.contains(&l.uid));
            }
            if !self.copyuid {
                return format!("{tag} OK done\r\n");
            }
            format!("{tag} OK [COPYUID 1 {} {}] done\r\n", compress(&from), compress(&to))
        }

        /// The letters of the selected folder that `set` names.
        fn mine(&self, set: &str) -> Vec<Letter> {
            let wanted = uid_set_of(set);
            self.letters(self.selected)
                .iter()
                .filter(|l| wanted.contains(&l.uid))
                .cloned()
                .collect()
        }
    }

    /// A fake server answering on its own port.
    async fn spawn_fake(mut fake: Fake) -> u16 {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let (r, mut w) = sock.into_split();
            let mut lines = BufReader::new(r).lines();
            let greeting = "* OK IMAP4rev1 ready\r\n";
            if w.write_all(greeting.as_bytes()).await.is_err() {
                return;
            }
            while let Ok(Some(line)) = lines.next_line().await {
                if w.write_all(fake.answer(&line).as_bytes()).await.is_err() {
                    return;
                }
            }
        });
        port
    }

    async fn connect_to(port: u16) -> imap::Conn {
        let server = crate::account::ServerConfig::new("127.0.0.1", port, crate::account::Security::Plain);
        imap::connect(&server, &crate::account::Credentials::new("u", "p"))
            .await
            .expect("login")
    }

    /// The cache of the fake's mailbox, with the folder list and INBOX read.
    async fn synced(port: u16) -> (imap::Conn, Store) {
        let mut conn = connect_to(port).await;
        let store = Store::open_in_memory().unwrap();
        sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();
        sync::sync_folder(&mut conn, &store, "d", INBOX, SyncOptions::default())
            .await
            .unwrap();
        (conn, store)
    }

    /// The mail layer of a connection, and the connection again once the call is done.
    fn as_mail(conn: imap::Conn) -> Conn {
        Conn::Imap(conn)
    }

    fn back(conn: Conn) -> imap::Conn {
        let Conn::Imap(conn) = conn else {
            unreachable!("the fake is an IMAP server")
        };
        conn
    }

    /// `1:3,7` names four UIDs.
    fn uid_set_of(set: &str) -> Vec<u32> {
        let mut uids = Vec::new();
        for part in set.split(',') {
            match part.split_once(':') {
                Some((a, b)) => uids.extend(a.parse::<u32>().unwrap()..=b.parse::<u32>().unwrap()),
                None => uids.push(part.parse().unwrap()),
            }
        }
        uids
    }

    /// The set `1:3,7` that names these UIDs.
    fn compress(uids: &[u32]) -> String {
        let mut parts = Vec::new();
        let mut i = 0;
        while i < uids.len() {
            let start = uids[i];
            let mut end = start;
            while i + 1 < uids.len() && uids[i + 1] == end + 1 {
                i += 1;
                end = uids[i];
            }
            parts.push(if start == end {
                start.to_string()
            } else {
                format!("{start}:{end}")
            });
            i += 1;
        }
        parts.join(",")
    }

    /// A label the folder keeps here rather than on the server (#112).
    fn labelled(store: &Store, folder: &str, uids: &[u32], keyword: &str) {
        store
            .remember_labels("d", folder, uids, std::slice::from_ref(&keyword.to_owned()), &[])
            .unwrap();
    }

    /// The label of a letter a folder keeps here rides with it: the move names the new UID, the
    /// memory goes to it, and the letter shows the label in the folder it arrived in, though the
    /// server answers no keyword at all (#201).
    #[tokio::test]
    async fn a_moved_letter_keeps_its_label_in_the_folder_it_arrived_in() {
        let port = spawn_fake(Fake::new(vec![letter(1, "1@x", 100)], Vec::new())).await;
        let (conn, store) = synced(port).await;
        let keyword = crate::acl::keyword_of("Счета");
        labelled(&store, INBOX, &[1], &keyword);

        let mut conn = as_mail(conn);
        let pairs = move_messages(&mut conn, &store, "d", INBOX, 1, &[1], ARCHIVE)
            .await
            .unwrap();
        let mut conn = back(conn);
        assert_eq!(pairs, [(1, 7)], "the move names the new UID");
        store.move_local_labels("d", INBOX, ARCHIVE, &pairs).unwrap();
        sync::sync_folder(&mut conn, &store, "d", ARCHIVE, SyncOptions::default())
            .await
            .unwrap();

        let moved = store
            .find_by_message_id("d", ARCHIVE, "1@x")
            .unwrap()
            .expect("the letter arrived");
        assert_eq!(moved.uid, 7);
        assert_eq!(moved.keywords, [keyword], "the label is on it in its new folder");
        assert!(
            store.local_labels("d", INBOX).unwrap().is_empty(),
            "nothing stays in the folder the letter left"
        );
    }

    /// A server without UIDPLUS names no UID: the letter is found by its Message-ID, and the
    /// label rides on it all the same (#201).
    #[tokio::test]
    async fn a_move_that_names_no_uid_finds_the_letter_by_message_id() {
        let port = spawn_fake(Fake::new(vec![letter(1, "1@x", 100)], Vec::new()).without_copyuid()).await;
        let (conn, store) = synced(port).await;
        let keyword = crate::acl::keyword_of("Счета");
        labelled(&store, INBOX, &[1], &keyword);

        let mut conn = as_mail(conn);
        let pairs = move_messages(&mut conn, &store, "d", INBOX, 1, &[1], ARCHIVE)
            .await
            .unwrap();
        let mut conn = back(conn);
        assert_eq!(pairs, [(1, 7)], "the letter found by its Message-ID");
        store.move_local_labels("d", INBOX, ARCHIVE, &pairs).unwrap();
        sync::sync_folder(&mut conn, &store, "d", ARCHIVE, SyncOptions::default())
            .await
            .unwrap();

        let moved = store
            .find_by_message_id("d", ARCHIVE, "1@x")
            .unwrap()
            .expect("the letter arrived");
        assert_eq!((moved.uid, moved.keywords), (7, vec![keyword]));
    }

    /// One Message-ID and another size is another letter (#201): the label of the one a cut move
    /// left in the target goes to it, never to its namesake.
    #[tokio::test]
    async fn the_size_tells_the_moved_letter_from_its_namesake() {
        // uid 1 already reached the target before the run was cut, and the target holds another
        // letter of the same Message-ID, larger.
        let archive = vec![letter(3, "1@x", 900), letter(5, "1@x", 100)];
        let port = spawn_fake(Fake::new(vec![letter(1, "1@x", 100)], archive)).await;
        let (conn, store) = synced(port).await;
        let keyword = crate::acl::keyword_of("Счета");
        labelled(&store, INBOX, &[1], &keyword);

        let mut conn = as_mail(conn);
        let pairs = resume_move(&mut conn, &store, "d", INBOX, 1, &[1], ARCHIVE)
            .await
            .unwrap();
        let mut conn = back(conn);
        assert_eq!(pairs, [(1, 5)], "the letter of the same size is the one that moved");
        store.move_local_labels("d", INBOX, ARCHIVE, &pairs).unwrap();
        sync::sync_folder(&mut conn, &store, "d", ARCHIVE, SyncOptions::default())
            .await
            .unwrap();

        let namesake = store.find_by_uid("d", ARCHIVE, 3).unwrap().expect("the namesake");
        assert!(namesake.keywords.is_empty(), "the namesake keeps no label");
        let moved = store.find_by_uid("d", ARCHIVE, 5).unwrap().expect("the moved letter");
        assert_eq!(moved.keywords, [keyword], "the label is on the letter that moved");
    }

    /// A copy that lay in the target before the move is not the letter the move brings, though
    /// it has the same Message-ID and size (#201): its UID is below the target's own UIDNEXT.
    #[tokio::test]
    async fn a_copy_that_lay_in_the_target_is_not_the_moved_letter() {
        let port =
            spawn_fake(Fake::new(vec![letter(1, "1@x", 100)], vec![letter(5, "1@x", 100)]).without_copyuid()).await;
        let (conn, store) = synced(port).await;
        let keyword = crate::acl::keyword_of("Счета");
        labelled(&store, INBOX, &[1], &keyword);

        let mut conn = as_mail(conn);
        let pairs = move_messages(&mut conn, &store, "d", INBOX, 1, &[1], ARCHIVE)
            .await
            .unwrap();
        let mut conn = back(conn);
        assert_eq!(pairs, [(1, 7)], "the letter that arrived, not the copy that lay there");
        store.move_local_labels("d", INBOX, ARCHIVE, &pairs).unwrap();
        sync::sync_folder(&mut conn, &store, "d", ARCHIVE, SyncOptions::default())
            .await
            .unwrap();

        let moved = store.find_by_uid("d", ARCHIVE, 7).unwrap().expect("the moved letter");
        assert_eq!(moved.keywords, [keyword], "the label is on the letter that moved");
        let earlier = store
            .find_by_uid("d", ARCHIVE, 5)
            .unwrap()
            .expect("the copy that lay there");
        assert!(earlier.keywords.is_empty(), "the copy that lay there keeps no label");
    }
}
