//! Background work for one account: an operations connection that syncs and
//! runs user actions one at a time, and a second connection waiting in IDLE.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use depesha_core::account::Account;
use depesha_core::imap::{self, Conn, FlagChange, FolderRole, IdleOutcome};
use depesha_core::store::ListQuery;
use depesha_core::sync::{self, SyncOptions};
use depesha_core::{Error, Result};
use serde_json::json;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::CmdError;
use crate::state::{AccountStatus, AppState};

const FULL_SYNC_EVERY: Duration = Duration::from_secs(5 * 60);
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
}

pub enum Output {
    None,
    Body(Vec<u8>),
    Count(usize),
    Ids(Vec<i64>),
}

type Reply = oneshot::Sender<Result<Output>>;

#[derive(Clone)]
pub struct Worker {
    tx: mpsc::Sender<(Work, Option<Reply>)>,
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

    /// Queues background work without waiting.
    pub fn kick(&self, work: Work) {
        let _ = self.tx.try_send((work, None));
    }

    /// Runs work on the operations connection and waits for the result.
    pub async fn run(&self, work: Work) -> Result<Output> {
        // A user action is a reason to try again even after a fatal error.
        self.paused.store(false, Ordering::Relaxed);
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
    let ops = tokio::spawn(ops_loop(state.clone(), account.clone(), rx, paused.clone()));
    let idle = tokio::spawn(idle_loop(state, account, tx.clone(), paused.clone()));
    let worker = Worker {
        tx,
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
    paused: Arc<AtomicBool>,
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
            Ok(_) => {
                if matches!(work, Work::SyncAll) {
                    notify_new = true;
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
                let fatal = needs_user(e);
                paused.store(fatal, Ordering::Relaxed);
                let status = if fatal { "paused" } else { "error" };
                // Errors of a single message action go to the caller, not to the account status.
                if reply.is_none() || conn.is_none() {
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
        Error::ImapUnavailable => Error::ImapUnavailable,
        Error::Timeout(t) => Error::Timeout(t),
        Error::Closed => Error::Closed,
        other => Error::Protocol(other.to_string()),
    }
}

async fn connect(state: &AppState, account: &Account) -> Result<Conn> {
    let creds = state.credentials(account).await?;
    imap::connect(&account.imap, &creds).await
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
            let folders = sync::sync_folder_list(conn, store, id).await?;
            state.emit("folders-changed", json!({ "account_id": id }));
            let mut order: Vec<_> = folders.iter().filter(|f| f.selectable && !f.hidden).collect();
            order.sort_by_key(|f| match f.role {
                Some(FolderRole::Inbox) => 0,
                Some(_) => 1,
                None => 2,
            });
            for f in order {
                match sync_one(state, account, conn, &f.name, *notify_new).await {
                    Ok(()) => {}
                    Err(e) if e.is_transient() => return Err(e),
                    // One broken folder (Exchange shows some odd ones) must not stop the rest.
                    Err(e) => tracing::warn!(account = %id, folder = %f.display_name, "folder sync failed: {e}"),
                }
            }
            Ok(Output::None)
        }
        Work::SyncFolder(folder) => {
            sync_one(state, account, conn, folder, *notify_new).await?;
            Ok(Output::None)
        }
        Work::LoadBody(msg_id) => Ok(Output::Body(sync::load_body(conn, store, *msg_id).await?)),
        Work::SetFlag { folder, uids, change } => {
            imap::set_flag(conn, folder, uids, *change).await?;
            Ok(Output::None)
        }
        Work::Move { from, uids, to } => {
            imap::move_messages(conn, from, uids, to).await?;
            sync_one(state, account, conn, from, false).await?;
            sync_one(state, account, conn, to, false).await?;
            Ok(Output::None)
        }
        Work::Delete { folder, uids } => {
            imap::delete_permanently(conn, folder, uids).await?;
            sync_one(state, account, conn, folder, false).await?;
            Ok(Output::None)
        }
        Work::Append {
            folder,
            raw,
            flags,
            message_id,
        } => {
            let exists = match message_id {
                Some(mid) => !imap::find_by_message_id(conn, folder, mid).await?.is_empty(),
                None => false,
            };
            if !exists {
                imap::append(conn, folder, raw, flags).await?;
            }
            sync_one(state, account, conn, folder, false).await?;
            Ok(Output::None)
        }
        Work::Search { folder, text } => Ok(Output::Ids(sync::search_server(conn, store, id, folder, text).await?)),
        Work::LoadOlder { folder } => {
            let n = sync::load_older(conn, store, id, folder, 200).await?;
            if n > 0 {
                state.emit("mail-changed", json!({ "account_id": id, "folder": folder }));
            }
            Ok(Output::Count(n))
        }
    }
}

async fn sync_one(state: &AppState, account: &Account, conn: &mut Conn, folder: &str, notify: bool) -> Result<()> {
    let id = account.id.as_str();
    let (_, before) = state.store.folder_state(id, folder)?;
    let report = sync::sync_folder(conn, &state.store, id, folder, SyncOptions::default()).await?;
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
        notify_new_mail(state, account, &fresh);
    }
    Ok(())
}

fn notify_new_mail(state: &AppState, account: &Account, fresh: &[depesha_core::store::MessageRow]) {
    let (title, body) = match fresh {
        [] => return,
        [m] => (
            m.from
                .as_ref()
                .map(|a| a.name.clone().unwrap_or_else(|| a.email.clone()))
                .unwrap_or_default(),
            if m.subject.is_empty() {
                "(без темы)".to_owned()
            } else {
                m.subject.clone()
            },
        ),
        many => (format!("{} новых писем", many.len()), account.email.clone()),
    };
    // Automated tests run on a virtual display but share the user's notification daemon.
    if std::env::var_os("DEPESHA_NO_NOTIFICATIONS").is_some() {
        tracing::debug!("notification suppressed: {title}");
        return;
    }
    if let Err(e) = state.app.notification().builder().title(title).body(body).show() {
        tracing::debug!("notification failed: {e}");
    }
}

/// Second connection that sits in IDLE on INBOX and asks the operations loop to sync.
async fn idle_loop(
    state: Arc<AppState>,
    account: Account,
    tx: mpsc::Sender<(Work, Option<Reply>)>,
    paused: Arc<AtomicBool>,
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
                r = imap::wait_for_changes(conn, "INBOX", POLL_WITHOUT_IDLE) => match r {
                    Ok((c, outcome)) => {
                        conn = c;
                        if matches!(outcome, IdleOutcome::Changed) {
                            let _ = tx.send((Work::SyncFolder("INBOX".into()), None)).await;
                        }
                    }
                    Err(e) => {
                        tracing::debug!(account = %account.id, "idle dropped: {e}");
                        break;
                    }
                },
                _ = resumed_from_sleep() => {
                    tracing::info!(account = %account.id, "resumed from sleep, reconnecting");
                    let _ = tx.send((Work::SyncAll, None)).await;
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
