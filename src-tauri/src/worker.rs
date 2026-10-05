//! Background work for one account: an operations connection that syncs and
//! runs user actions one at a time, and a second connection waiting for changes
//! (IMAP IDLE or EWS streaming notifications).

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use depesha_core::account::Account;
use depesha_core::imap::{FlagChange, FolderRole, IdleOutcome};
use depesha_core::mail::{self, Conn};
use depesha_core::store::ListQuery;
use depesha_core::sync::SyncOptions;
use depesha_core::{Error, Result};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::CmdError;
use crate::state::{AccountStatus, AppState};
use depesha_core::lang::pick;
use depesha_core::tr;

const FULL_SYNC_EVERY: Duration = Duration::from_secs(5 * 60);
/// Messages downloaded for offline reading per round: user actions wait for a
/// round at most, they are queued between rounds.
const PREFETCH_BATCH: u32 = 25;
const POLL_WITHOUT_IDLE: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub enum Work {
    SyncAll,
    SyncFolder(String),
    LoadBody(i64),
    SetFlag {
        folder: String,
        uids: Vec<u32>,
        change: FlagChange,
    },
    Move {
        from: String,
        uids: Vec<u32>,
        to: String,
    },
    Delete {
        folder: String,
        uids: Vec<u32>,
    },
    /// Puts a message into a folder unless one with the same Message-ID is already there.
    Append {
        folder: String,
        raw: Vec<u8>,
        flags: String,
        message_id: Option<String>,
    },
    LoadOlder {
        folder: String,
    },
    /// IMAP SEARCH in the folder; found messages are cached. Returns row ids.
    Search {
        folder: String,
        text: String,
    },
    /// Creates a folder and refreshes the folder list.
    CreateFolder(String),
    /// A colleague's photo from Exchange: `Body` with the picture, `None` without one.
    UserPhoto(String),
    /// Downloads one batch of messages for offline reading; queues the next batch itself.
    Prefetch,
    /// Moves messages found by Message-ID: UIDs change on every move, so undo and
    /// returning snoozed mail cannot rely on them. `unseen` marks them unread there.
    MoveByMessageId {
        from: String,
        message_ids: Vec<String>,
        to: String,
        unseen: bool,
    },
}

pub enum Output {
    None,
    Body(Vec<u8>),
    Count(usize),
    Ids(Vec<i64>),
}

type Reply = oneshot::Sender<Result<Output>>;

/// Background syncs waiting in the queue, by `sync_key`: a second one of the same folder
/// is not queued (a burst of IDLE notices, clicks through folders). The key is let go
/// when the sync starts, so changes during it bring the next one.
type Queued = Arc<std::sync::Mutex<HashSet<String>>>;

fn sync_key(work: &Work) -> Option<String> {
    match work {
        Work::SyncAll => Some(String::new()),
        Work::SyncFolder(f) => Some(f.clone()),
        _ => None,
    }
}

fn hold(queued: &Queued, key: &str) -> bool {
    queued.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_owned())
}

fn release(queued: &Queued, key: &str) {
    queued.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
}

/// Queues background work unless the same sync already waits there.
async fn queue(tx: &mpsc::Sender<(Work, Option<Reply>)>, queued: &Queued, work: Work) {
    let key = sync_key(&work);
    if let Some(k) = &key
        && !hold(queued, k)
    {
        return;
    }
    if tx.send((work, None)).await.is_err()
        && let Some(k) = &key
    {
        release(queued, k);
    }
}

#[derive(Clone)]
pub struct Worker {
    tx: mpsc::Sender<(Work, Option<Reply>)>,
    queued: Queued,
    tasks: Arc<Vec<JoinHandle<()>>>,
    /// Set after errors only the user can fix; stops automatic reconnects.
    paused: Arc<AtomicBool>,
}

impl Worker {
    pub fn stop(&self) {
        for t in self.tasks.iter() {
            t.abort();
        }
    }

    /// Queues background work without waiting; a sync already waiting is not queued twice.
    pub fn kick(&self, work: Work) {
        let key = sync_key(&work);
        if let Some(k) = &key
            && !hold(&self.queued, k)
        {
            return;
        }
        if self.tx.try_send((work, None)).is_err()
            && let Some(k) = &key
        {
            release(&self.queued, k);
        }
    }

    /// Runs work on the operations connection and waits for the result.
    pub async fn run(&self, work: Work) -> Result<Output> {
        // A user action is a reason to try again even after a fatal error.
        self.paused.store(false, Ordering::Relaxed);
        self.call(work).await
    }

    /// Like `run`, for work nobody asked for just now (snoozed mail coming back, a
    /// colleague's photo, the copy in Sent): a paused mailbox stays paused, so a
    /// wrong password is not tried every few seconds and an AD account is not locked.
    pub async fn run_background(&self, work: Work) -> Result<Output> {
        if self.paused.load(Ordering::Relaxed) {
            return Err(Error::Paused);
        }
        self.call(work).await
    }

    async fn call(&self, work: Work) -> Result<Output> {
        let (reply, rx) = oneshot::channel();
        self.tx.send((work, Some(reply))).await.map_err(|_| Error::Closed)?;
        rx.await.map_err(|_| Error::Closed)?
    }
}

/// Errors that repeat until the user acts; retrying them may also lock an AD account.
fn needs_user(e: &Error) -> bool {
    matches!(e.kind(), "auth" | "certificate" | "no-tls" | "imap-unavailable")
}

pub fn spawn(state: Arc<AppState>, account: Account) -> Worker {
    let (tx, rx) = mpsc::channel(64);
    let paused = Arc::new(AtomicBool::new(false));
    let queued: Queued = Arc::default();
    let ops = tokio::spawn(ops_loop(
        state.clone(),
        account.clone(),
        rx,
        tx.clone(),
        paused.clone(),
        queued.clone(),
    ));
    let idle = tokio::spawn(idle_loop(state, account, tx.clone(), paused.clone(), queued.clone()));
    let worker = Worker {
        tx,
        queued,
        tasks: Arc::new(vec![ops, idle]),
        paused,
    };
    worker.kick(Work::SyncAll);
    worker
}

async fn ops_loop(
    state: Arc<AppState>,
    account: Account,
    mut rx: mpsc::Receiver<(Work, Option<Reply>)>,
    tx: mpsc::Sender<(Work, Option<Reply>)>,
    paused: Arc<AtomicBool>,
    queued: Queued,
) {
    let mut conn: Option<Conn> = None;
    let mut notify_new = false;
    let mut tick = tokio::time::interval(FULL_SYNC_EVERY);
    tick.tick().await;
    loop {
        let (work, reply) = tokio::select! {
            item = rx.recv() => match item {
                Some(item) => item,
                None => return,
            },
            _ = tick.tick() => {
                if paused.load(Ordering::Relaxed) {
                    continue;
                }
                (Work::SyncAll, None)
            }
        };
        if reply.is_none()
            && let Some(k) = sync_key(&work)
        {
            release(&queued, &k);
        }
        if reply.is_none() && paused.load(Ordering::Relaxed) {
            continue;
        }

        let mut result = Err(Error::Closed);
        for attempt in 0..2 {
            if conn.is_none() {
                state.set_status(
                    &account.id,
                    AccountStatus {
                        state: "connecting",
                        error: None,
                    },
                );
                match connect(&state, &account).await {
                    Ok(c) => conn = Some(c),
                    Err(e) => {
                        result = Err(e);
                        break;
                    }
                }
            }
            let c = conn.as_mut().expect("connected above");
            match perform(&state, &account, c, &work, &mut notify_new).await {
                Ok(out) => {
                    result = Ok(out);
                    break;
                }
                Err(e) => {
                    // A dropped connection (server timeout, sleep) gets one fresh retry.
                    let retry = e.is_transient() && attempt == 0;
                    if e.is_transient() {
                        conn = None;
                    }
                    result = Err(e);
                    if !retry {
                        break;
                    }
                }
            }
        }

        match &result {
            Ok(out) => {
                match (&work, out) {
                    // Fresh headers: download their text for offline reading.
                    (Work::SyncAll, _) => {
                        notify_new = true;
                        let _ = tx.try_send((Work::Prefetch, None));
                    }
                    (Work::Prefetch, Output::Count(n)) if *n > 0 => {
                        let _ = tx.try_send((Work::Prefetch, None));
                    }
                    _ => {}
                }
                if state.status(&account.id).is_none_or(|s| s.state != "online") {
                    state.set_status(
                        &account.id,
                        AccountStatus {
                            state: "online",
                            error: None,
                        },
                    );
                }
            }
            Err(e) => {
                tracing::warn!(account = %account.id, kind = e.kind(), "operation failed: {e}");
                match work {
                    Work::SyncAll => state.task_failed(&format!("sync:{}", account.id), CmdError::from(clone_error(e))),
                    Work::Prefetch => {
                        state.task_failed(&format!("prefetch:{}", account.id), CmdError::from(clone_error(e)))
                    }
                    _ => {}
                }
                let fatal = needs_user(e);
                paused.store(fatal, Ordering::Relaxed);
                let status = if fatal { "paused" } else { "error" };
                // Errors of a single message action go to the caller, not to the account status;
                // a message the offline download could not take shows in its task.
                if (reply.is_none() && !matches!(work, Work::Prefetch)) || conn.is_none() {
                    state.set_status(
                        &account.id,
                        AccountStatus {
                            state: status,
                            error: Some(CmdError::from(clone_error(e))),
                        },
                    );
                }
            }
        }
        if let Some(reply) = reply {
            let _ = reply.send(result);
        }
    }
}

/// `Error` is not `Clone`; the status needs a copy of what the caller also gets.
fn clone_error(e: &Error) -> Error {
    match e {
        Error::Certificate(p) => Error::Certificate(p.clone()),
        Error::NoTls => Error::NoTls,
        Error::Auth(m) => Error::Auth(m.clone()),
        Error::AuthMechanism(m) => Error::AuthMechanism(m.clone()),
        Error::HttpAuth(m) => Error::HttpAuth(m.clone()),
        Error::Ews { code, message } => Error::Ews {
            code: code.clone(),
            message: message.clone(),
        },
        Error::ImapUnavailable => Error::ImapUnavailable,
        Error::Timeout(t) => Error::Timeout(t),
        Error::Closed => Error::Closed,
        Error::Paused => Error::Paused,
        other => Error::Protocol(other.to_string()),
    }
}

async fn connect(state: &AppState, account: &Account) -> Result<Conn> {
    state.connect(account).await
}

async fn perform(
    state: &AppState,
    account: &Account,
    conn: &mut Conn,
    work: &Work,
    notify_new: &mut bool,
) -> Result<Output> {
    let store = &state.store;
    let id = account.id.as_str();
    match work {
        Work::SyncAll => {
            let key = format!("sync:{id}");
            state.task(&key, "sync", Some(id), tr!("Syncing", "Синхронизация"), 0, 0);
            let folders = mail::sync_folder_list(conn, store, id).await?;
            state.emit("folders-changed", json!({ "account_id": id }));
            let mut order: Vec<_> = folders.iter().filter(|f| f.selectable && !f.hidden).collect();
            order.sort_by_key(|f| match f.role {
                Some(FolderRole::Inbox) => 0,
                Some(_) => 1,
                None => 2,
            });
            let total = order.len() as u64;
            for (i, f) in order.into_iter().enumerate() {
                let name = &f.display_name;
                state.task(
                    &key,
                    "sync",
                    Some(id),
                    tr!("Syncing: {name}", "Синхронизация: {name}"),
                    i as u64,
                    total,
                );
                match sync_one(state, account, conn, &f.name, *notify_new).await {
                    Ok(()) => {}
                    Err(e) if e.is_transient() => return Err(e),
                    // One broken folder (Exchange shows some odd ones) must not stop the rest.
                    Err(e) => tracing::warn!(account = %id, folder = %f.display_name, "folder sync failed: {e}"),
                }
            }
            state.task_done(&key);
            state.mark_synced(id);
            Ok(Output::None)
        }
        Work::Prefetch => prefetch(state, conn, id).await,
        Work::SyncFolder(folder) => {
            sync_one(state, account, conn, folder, *notify_new).await?;
            Ok(Output::None)
        }
        Work::LoadBody(msg_id) => Ok(Output::Body(mail::load_body(conn, store, *msg_id).await?)),
        Work::SetFlag { folder, uids, change } => {
            mail::set_flag(conn, store, id, folder, uids, *change).await?;
            Ok(Output::None)
        }
        Work::Move { from, uids, to } => {
            mail::move_messages(conn, store, id, from, uids, to).await?;
            sync_one(state, account, conn, from, false).await?;
            sync_one(state, account, conn, to, false).await?;
            Ok(Output::None)
        }
        Work::Delete { folder, uids } => {
            mail::delete_permanently(conn, store, id, folder, uids).await?;
            sync_one(state, account, conn, folder, false).await?;
            Ok(Output::None)
        }
        Work::Append {
            folder,
            raw,
            flags,
            message_id,
        } => {
            mail::append_unless_exists(conn, store, id, folder, raw, flags, message_id.as_deref()).await?;
            sync_one(state, account, conn, folder, false).await?;
            Ok(Output::None)
        }
        Work::Search { folder, text } => Ok(Output::Ids(mail::search_server(conn, store, id, folder, text).await?)),
        Work::UserPhoto(email) => Ok(match mail::user_photo(conn, email).await? {
            Some(bytes) => Output::Body(bytes),
            None => Output::None,
        }),
        Work::CreateFolder(name) => {
            mail::create_folder(conn, store, id, name).await?;
            mail::sync_folder_list(conn, store, id).await?;
            state.emit("folders-changed", json!({ "account_id": id }));
            Ok(Output::None)
        }
        Work::MoveByMessageId {
            from,
            message_ids,
            to,
            unseen,
        } => {
            let n = mail::move_by_message_id(conn, store, id, from, message_ids, to, *unseen).await?;
            sync_one(state, account, conn, from, false).await?;
            sync_one(state, account, conn, to, false).await?;
            Ok(Output::Count(n))
        }
        Work::LoadOlder { folder } => {
            let n = mail::load_older(conn, store, id, folder, 200).await?;
            if n > 0 {
                state.emit("mail-changed", json!({ "account_id": id, "folder": folder }));
            }
            Ok(Output::Count(n))
        }
    }
}

/// One batch of the offline download. `Count` is what the next batch may still
/// find: 0 when everything is downloaded, paused or switched off.
async fn prefetch(state: &AppState, conn: &mut Conn, account_id: &str) -> Result<Output> {
    let key = format!("prefetch:{account_id}");
    let settings = state.settings();
    let since = match settings.offline_since() {
        Some(since) if !state.prefetch_paused(account_id) => since,
        _ => {
            state.task_done(&key);
            return Ok(Output::Count(0));
        }
    };
    let files = settings.offline_attachments;
    let store = &state.store;
    let batch = store.bodies_missing(account_id, since, files, PREFETCH_BATCH)?;
    if batch.is_empty() {
        state.task_done(&key);
        return Ok(Output::Count(0));
    }
    let label = || tr!("Downloading mail for offline reading", "Скачивание писем для офлайна");
    let (done, total) = store.offline_progress(account_id, since, files)?;
    state.task(&key, "prefetch", Some(account_id), label(), done, total);

    let mut by_folder: Vec<(String, Vec<(i64, u32)>)> = Vec::new();
    for (id, folder, uid) in &batch {
        match by_folder.iter_mut().find(|(f, _)| f == folder) {
            Some((_, list)) => list.push((*id, *uid)),
            None => by_folder.push((folder.clone(), vec![(*id, *uid)])),
        }
    }
    let mut saved = 0;
    for (folder, messages) in &by_folder {
        saved += mail::prefetch_bodies(conn, store, folder, messages).await?;
    }
    let last = saved == 0 || batch.len() < PREFETCH_BATCH as usize;
    if last {
        state.task_done(&key);
    } else {
        let (done, total) = store.offline_progress(account_id, since, files)?;
        state.task(&key, "prefetch", Some(account_id), label(), done, total);
    }
    // The cache got text to search in.
    state.emit("offline-progress", json!({ "account_id": account_id }));
    Ok(Output::Count(if last { 0 } else { saved }))
}

async fn sync_one(state: &AppState, account: &Account, conn: &mut Conn, folder: &str, notify: bool) -> Result<()> {
    let id = account.id.as_str();
    let (_, before) = state.store.folder_state(id, folder)?;
    let report = mail::sync_folder(conn, &state.store, id, folder, SyncOptions::default()).await?;
    if report.changed() {
        state.emit("mail-changed", json!({ "account_id": id, "folder": folder }));
    }
    if notify && report.added > 0 && folder.eq_ignore_ascii_case("INBOX") && before > 0 {
        let fresh: Vec<_> = state
            .store
            .list(&ListQuery {
                account_id: Some(id.to_owned()),
                folder: Some(folder.to_owned()),
                unread_only: true,
                limit: 20,
                ..Default::default()
            })?
            .into_iter()
            .filter(|m| m.uid > before)
            .collect();
        // Extensions with mail rules see new mail before the notification.
        state.emit(
            "mail-arrived",
            json!({ "ids": fresh.iter().map(|m| m.id).collect::<Vec<_>>() }),
        );
        notify_new_mail(state, account, &fresh);
    }
    Ok(())
}

fn new_messages(n: usize) -> String {
    let ru = match (n % 10, n % 100) {
        (1, r) if r != 11 => "новое письмо",
        (2..=4, r) if !(12..=14).contains(&r) => "новых письма",
        _ => "новых писем",
    };
    depesha_core::tr!("{n} new messages", "{n} {ru}")
}

fn notify_new_mail(state: &AppState, account: &Account, fresh: &[depesha_core::store::MessageRow]) {
    // Newsletters and robots stay silent by default (settings: notify).
    let people: Vec<_> = fresh.iter().filter(|m| !m.bulk).collect();
    let bulk = people.is_empty();
    let shown: Vec<_> = if bulk { fresh.iter().collect() } else { people };
    let (title, body) = match shown.as_slice() {
        [] => return,
        [m] => (
            m.from
                .as_ref()
                .map(|a| a.name.clone().unwrap_or_else(|| a.email.clone()))
                .unwrap_or_default(),
            if m.subject.is_empty() {
                pick("(no subject)", "(без темы)").to_owned()
            } else {
                m.subject.clone()
            },
        ),
        many => (new_messages(many.len()), account.email.clone()),
    };
    state.notify(&title, &body, bulk);
}

/// Second connection that waits for changes in INBOX and asks the operations loop to sync.
async fn idle_loop(
    state: Arc<AppState>,
    account: Account,
    tx: mpsc::Sender<(Work, Option<Reply>)>,
    paused: Arc<AtomicBool>,
    queued: Queued,
) {
    let mut backoff = Duration::from_secs(5);
    loop {
        if paused.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        }
        let mut conn = match connect(&state, &account).await {
            Ok(c) => c,
            Err(e) => {
                tracing::debug!(account = %account.id, "idle connect failed: {e}");
                // A wrong password retried every few minutes locks an AD account: wait for the user.
                if needs_user(&e) {
                    paused.store(true, Ordering::Relaxed);
                    state.set_status(
                        &account.id,
                        AccountStatus {
                            state: "paused",
                            error: Some(CmdError::from(e)),
                        },
                    );
                    continue;
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(300));
                continue;
            }
        };
        backoff = Duration::from_secs(5);
        loop {
            tokio::select! {
                r = mail::wait_for_changes(conn, &state.store, &account.id, POLL_WITHOUT_IDLE) => match r {
                    Ok((c, outcome)) => {
                        conn = c;
                        if matches!(outcome, IdleOutcome::Changed) {
                            queue(&tx, &queued, Work::SyncFolder("INBOX".into())).await;
                        }
                    }
                    Err(e) => {
                        tracing::debug!(account = %account.id, "idle dropped: {e}");
                        // A link that breaks at once (a proxy cutting long answers) must not spin.
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        break;
                    }
                },
                _ = resumed_from_sleep() => {
                    tracing::info!(account = %account.id, "resumed from sleep, reconnecting");
                    queue(&tx, &queued, Work::SyncAll).await;
                    break;
                }
            }
        }
    }
}

/// Completes when the wall clock jumps ahead of the monotonic one: the machine slept
/// and TCP connections are probably dead.
async fn resumed_from_sleep() {
    loop {
        let wall = SystemTime::now();
        let mono = Instant::now();
        tokio::time::sleep(Duration::from_secs(15)).await;
        let wall_elapsed = wall.elapsed().unwrap_or_default();
        if wall_elapsed > mono.elapsed() + Duration::from_secs(20) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_waiting_sync_is_not_queued_twice() {
        let (tx, mut rx) = mpsc::channel(8);
        let queued: Queued = Arc::default();
        for _ in 0..5 {
            queue(&tx, &queued, Work::SyncFolder("INBOX".into())).await;
        }
        queue(&tx, &queued, Work::SyncFolder("Sent".into())).await;
        queue(&tx, &queued, Work::SyncAll).await;
        queue(&tx, &queued, Work::SyncAll).await;
        let mut got = Vec::new();
        while let Ok((w, _)) = rx.try_recv() {
            got.push(sync_key(&w).unwrap());
        }
        assert_eq!(got, ["INBOX", "Sent", ""]);

        // Started: changes during the sync bring the next one.
        release(&queued, "INBOX");
        queue(&tx, &queued, Work::SyncFolder("INBOX".into())).await;
        assert!(matches!(rx.try_recv(), Ok((Work::SyncFolder(f), None)) if f == "INBOX"));
    }
}
