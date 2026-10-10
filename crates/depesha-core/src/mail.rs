//! One interface over the two kinds of server: IMAP with SMTP, and Exchange Web
//! Services. The cache, the worker and the GUI see the same folders and UIDs.

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
    match conn {
        Conn::Imap(c) => {
            let add_kw: Vec<String> = change.add.iter().map(|l| l.keyword.clone()).collect();
            let remove_kw: Vec<String> = change.remove.iter().map(|l| l.keyword.clone()).collect();
            imap::set_keywords(c, folder, Some(validity), uids, &add_kw, &remove_kw).await
        }
        Conn::Ews(s) => {
            ews_check(store, account_id, folder, validity)?;
            ews::set_labels(s, store, account_id, folder, uids, change.add, change.remove).await
        }
    }?;
    // The server has the new keywords: the cache takes them in at once, so the row shows
    // the label without waiting for a sync.
    let add_kw: Vec<String> = change.add.iter().map(|l| l.keyword.clone()).collect();
    let remove_kw: Vec<String> = change.remove.iter().map(|l| l.keyword.clone()).collect();
    store.adjust_keywords(account_id, folder, uids, &add_kw, &remove_kw)?;
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
) -> Result<()> {
    match conn {
        Conn::Imap(c) => imap::move_messages(c, from, Some(validity), uids, to).await,
        Conn::Ews(s) => {
            ews_check(store, account_id, from, validity)?;
            ews::move_messages(s, store, account_id, from, uids, to).await
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
) -> Result<()> {
    match conn {
        Conn::Imap(c) => imap::resume_move(c, from, Some(validity), uids, to).await,
        // Exchange's move is atomic: a second call is the ordinary one.
        Conn::Ews(s) => {
            ews_check(store, account_id, from, validity)?;
            ews::move_messages(s, store, account_id, from, uids, to).await
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
            let (n, bound) = ImapServer::new(c, EMPTY_BATCH).count(folder).await?;
            Ok((n, Bound::Imap(bound)))
        }
        Conn::Ews(s) => {
            let (n, bound) = EwsServer { s, store, account_id }.count(folder).await?;
            Ok((n, Bound::Ews(bound)))
        }
    }
}

/// Empties the folder on the server (`clear::empty_folder`) over the port of the connection's
/// kind. `batch` is the size of an IMAP request; Exchange takes its own.
#[allow(clippy::too_many_arguments)]
pub async fn empty_folder(
    conn: &mut Conn,
    store: &Store,
    account_id: &str,
    folder: &str,
    how: &Emptying,
    bound: &Bound,
    keep: &[u32],
    batch: usize,
    progress: &mut (dyn FnMut(usize, usize) -> bool + Send),
) -> Result<Emptied> {
    match (conn, bound) {
        (Conn::Imap(c), Bound::Imap(b)) => {
            clear::empty_folder(&mut ImapServer::new(c, batch), folder, how, b, keep, progress).await
        }
        (Conn::Ews(s), Bound::Ews(b)) => {
            clear::empty_folder(&mut EwsServer { s, store, account_id }, folder, how, b, keep, progress).await
        }
        _ => Err(not_of_this_mailbox()),
    }
}

/// Runs a queued «Clear» (`clear::perform`) over the port of the connection's kind.
#[allow(clippy::too_many_arguments)]
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
            let mut server = ImapServer::new(c, EMPTY_BATCH);
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
    batch: usize,
    validity: Option<u32>,
}

impl<'a> ImapServer<'a> {
    pub(crate) fn new(conn: &'a mut imap::Conn, batch: usize) -> Self {
        Self {
            conn,
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
        imap::move_messages(self.conn, folder, Some(counted_under(self.validity)?), items, to).await
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
                return Ok(0);
            }
            // UIDs from the cache hold only while the folder keeps its UIDVALIDITY.
            let validity = cached.then_some(validity);
            // Flags travel with the message: unread before the move, no search after it.
            if unseen {
                imap::set_flag(c, from, validity, &uids, FlagChange::Seen(false)).await?;
            }
            imap::move_messages(c, from, validity, &uids, to).await?;
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

/// A subscription that broke: the error, how it broke and what the pace makes of it.
#[derive(Debug)]
pub struct IdleDrop {
    pub error: Error,
    pub cause: DropCause,
    /// Since the last thing the client wrote (the start of this wait).
    pub since_wait: Duration,
    /// Since the connect.
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
    let mut worked = None;
    let (result, renew) = match conn {
        // The connection is new after a drop: what came in meanwhile is read by a sync that
        // starts after this SELECT, so the wait ends at once.
        Conn::Imap(mut c) if resync => {
            let r = imap::select_for_idle(&mut c, "INBOX").await;
            (r.map(|()| (Conn::Imap(c), IdleOutcome::Changed)), None)
        }
        c @ Conn::Ews(_) if resync => (Ok((c, IdleOutcome::Changed)), None),
        Conn::Imap(c) => {
            let renew = pace.renew();
            worked = Some(c.worked.clone());
            let r = imap::wait_for_changes(c, "INBOX", poll, renew).await;
            (r.map(|(c, o)| (Conn::Imap(c), o)), Some(renew))
        }
        Conn::Ews(mut s) => {
            let r = ews::wait_for_changes(&mut s, store, account_id, poll).await;
            (r.map(|o| (Conn::Ews(s), o)), None)
        }
    };
    match result {
        Ok(done) => {
            if !resync {
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
}
