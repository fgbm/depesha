//! Background work for one account: an operations connection that syncs and
//! runs user actions one at a time, and a second connection waiting for changes
//! (IMAP IDLE or EWS streaming notifications). User actions go ahead of background
//! work: a full sync is a pass taken one folder at a time, and actions sent
//! meanwhile run between its folders.

use std::collections::{HashSet, VecDeque};
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
use tokio::sync::mpsc::error::TryRecvError;
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
/// How often INBOX is checked on a server without IDLE; the "Server" section says so.
pub const POLL_WITHOUT_IDLE: Duration = Duration::from_secs(120);
/// Pause after "server busy" (Exchange throttling) when the server names none; it
/// doubles while the server stays busy.
const BUSY_PAUSE: Duration = Duration::from_secs(5);
/// The longest pause after "server busy": a wrong value must not silence the mailbox.
const BUSY_PAUSE_MAX: Duration = Duration::from_secs(5 * 60);
/// A user action waits out a busy pause this short; a longer one is answered at once.
const USER_WAITS_BUSY: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum Work {
    /// Every visible folder, one at a time: user actions run between them.
    SyncAll,
    SyncFolder(String),
    LoadBody(i64),
    /// `validity`: the folder's UIDVALIDITY when the UIDs were read from the cache; the
    /// server refuses the action when the folder was renumbered since (`FolderChanged`).
    SetFlag {
        folder: String,
        validity: u32,
        uids: Vec<u32>,
        change: FlagChange,
    },
    Move {
        from: String,
        validity: u32,
        uids: Vec<u32>,
        to: String,
    },
    Delete {
        folder: String,
        validity: u32,
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
    /// The start of a full sync: the folders to sync in order, name and display name.
    Folders(Vec<(String, String)>),
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
async fn queue(tx: &mpsc::Sender<Work>, queued: &Queued, work: Work) {
    let key = sync_key(&work);
    if let Some(k) = &key
        && !hold(queued, k)
    {
        return;
    }
    if tx.send(work).await.is_err()
        && let Some(k) = &key
    {
        release(queued, k);
    }
}

/// Like `queue`, without waiting for room: a full queue has enough work in it.
fn offer(tx: &mpsc::Sender<Work>, queued: &Queued, work: Work) {
    let key = sync_key(&work);
    if let Some(k) = &key
        && !hold(queued, k)
    {
        return;
    }
    if tx.try_send(work).is_err()
        && let Some(k) = &key
    {
        release(queued, k);
    }
}

#[derive(Clone)]
pub struct Worker {
    /// User actions and other work somebody waits for; they go ahead of `background`.
    urgent: mpsc::Sender<(Work, Reply)>,
    background: mpsc::Sender<Work>,
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
        offer(&self.background, &self.queued, work);
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
        self.urgent.send((work, reply)).await.map_err(|_| Error::Closed)?;
        rx.await.map_err(|_| Error::Closed)?
    }
}

/// Errors that repeat until the user acts; retrying them may also lock an AD account.
fn needs_user(e: &Error) -> bool {
    matches!(e.kind(), "auth" | "certificate" | "no-tls" | "imap-unavailable")
}

/// How long to send nothing after "server busy": the server's own word, within
/// bounds; otherwise `BUSY_PAUSE`, doubled for each busy answer in a row (`streak`).
fn busy_pause(back_off: Option<Duration>, streak: u32) -> Duration {
    match back_off {
        Some(d) if !d.is_zero() => d.min(BUSY_PAUSE_MAX),
        _ => BUSY_PAUSE.saturating_mul(1 << streak.min(16)).min(BUSY_PAUSE_MAX),
    }
}

pub fn spawn(state: Arc<AppState>, account: Account) -> Worker {
    let (urgent, urgent_rx) = mpsc::channel(64);
    let (background, background_rx) = mpsc::channel(64);
    let paused = Arc::new(AtomicBool::new(false));
    let queued: Queued = Arc::default();
    let ops = Ops {
        state: state.clone(),
        account: account.clone(),
        conn: None,
        notify_new: false,
        pass: None,
        busy_until: None,
        busy_streak: 0,
        background: background.clone(),
        paused: paused.clone(),
        queued: queued.clone(),
    };
    let ops = tokio::spawn(ops.run(urgent_rx, background_rx));
    let idle = tokio::spawn(idle_loop(
        state,
        account,
        background.clone(),
        paused.clone(),
        queued.clone(),
    ));
    let worker = Worker {
        urgent,
        background,
        queued,
        tasks: Arc::new(vec![ops, idle]),
        paused,
    };
    worker.kick(Work::SyncAll);
    worker
}

/// What the operations loop takes up next.
enum Next {
    User(Work, Reply),
    Background(Work),
    /// The next folder of the full sync under way.
    Step,
    Tick,
    Closed,
}

/// User actions first, in the order sent; then the full sync under way (`stepping`),
/// one folder per call; then other background work. While a busy server asks to
/// wait (`busy_until`), only user actions are taken: they get their answer at once.
async fn next(
    urgent: &mut mpsc::Receiver<(Work, Reply)>,
    background: &mut mpsc::Receiver<Work>,
    tick: &mut tokio::time::Interval,
    stepping: bool,
    busy_until: Option<tokio::time::Instant>,
) -> Next {
    if let Some(until) = busy_until
        && until > tokio::time::Instant::now()
    {
        tokio::select! {
            biased;
            item = urgent.recv() => return item.map_or(Next::Closed, |(w, r)| Next::User(w, r)),
            _ = tokio::time::sleep_until(until) => {}
        }
    }
    if stepping {
        return match urgent.try_recv() {
            Ok((w, r)) => Next::User(w, r),
            Err(TryRecvError::Empty) => Next::Step,
            Err(TryRecvError::Disconnected) => Next::Closed,
        };
    }
    tokio::select! {
        biased;
        item = urgent.recv() => item.map_or(Next::Closed, |(w, r)| Next::User(w, r)),
        item = background.recv() => item.map_or(Next::Closed, Next::Background),
        _ = tick.tick() => Next::Tick,
    }
}

/// A full sync under way: the folders left. It ends after the last one, so the task in
/// the tasks window and `mark_synced` stay one per pass.
struct Pass {
    folders: VecDeque<(String, String)>,
    done: u64,
    total: u64,
    /// `sync_now` callers waiting for the end of the pass.
    waiting: Vec<Reply>,
}

/// What the operations connection does in one go.
#[derive(Clone, Copy)]
enum Op<'a> {
    Work(&'a Work),
    /// One folder of a full sync: its own errors are logged and the pass goes on.
    PassFolder(&'a str),
}

/// The operations loop and what it keeps between tasks.
struct Ops {
    state: Arc<AppState>,
    account: Account,
    conn: Option<Conn>,
    notify_new: bool,
    pass: Option<Pass>,
    /// Exchange said it is busy: nothing goes to the server before this.
    busy_until: Option<tokio::time::Instant>,
    /// Busy answers in a row, for the growing pause.
    busy_streak: u32,
    /// For work the loop queues itself: the next offline batch, a retry after "busy".
    background: mpsc::Sender<Work>,
    paused: Arc<AtomicBool>,
    queued: Queued,
}

impl Ops {
    async fn run(mut self, mut urgent: mpsc::Receiver<(Work, Reply)>, mut background: mpsc::Receiver<Work>) {
        let mut tick = tokio::time::interval(FULL_SYNC_EVERY);
        // Ticks missed during a long pass do not bring several passes in a row.
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            match next(
                &mut urgent,
                &mut background,
                &mut tick,
                self.pass.is_some(),
                self.busy_until,
            )
            .await
            {
                Next::Closed => return,
                Next::User(Work::SyncAll, reply) => self.user_sync_all(reply).await,
                Next::User(work, reply) => {
                    let result = self.user(&work).await;
                    self.report(&work, &result, true);
                    let _ = reply.send(result);
                }
                Next::Step => self.step().await,
                Next::Background(work) => {
                    if let Some(k) = sync_key(&work) {
                        release(&self.queued, &k);
                    }
                    if !self.paused.load(Ordering::Relaxed) {
                        self.background(work).await;
                    }
                }
                Next::Tick => {
                    if !self.paused.load(Ordering::Relaxed) {
                        self.background(Work::SyncAll).await;
                    }
                }
            }
        }
    }

    fn sync_task(&self) -> String {
        format!("sync:{}", self.account.id)
    }

    fn busy_left(&self) -> Option<Duration> {
        let left = self.busy_until?.checked_duration_since(tokio::time::Instant::now())?;
        (!left.is_zero()).then_some(left)
    }

    /// Notes a busy answer and returns how long nothing goes to the server.
    fn throttled(&mut self, e: &Error) -> Duration {
        let pause = busy_pause(e.back_off(), self.busy_streak);
        self.busy_streak += 1;
        self.busy_until = Some(tokio::time::Instant::now() + pause);
        tracing::info!(account = %self.account.id, "server busy, pausing {pause:?}");
        pause
    }

    /// Background work waits out a busy server; the account shows why it stands still.
    fn show_busy(&self, wait: Duration) {
        self.state.set_status(
            &self.account.id,
            AccountStatus {
                state: "error",
                error: Some(CmdError::from(Error::Busy { wait, retrying: true })),
            },
        );
    }

    /// Runs `op`, connecting first if needed. A dropped connection (server timeout,
    /// sleep) gets one fresh retry; a busy server keeps its connection and comes back
    /// as is: the caller decides how long to wait.
    async fn attempt(&mut self, op: Op<'_>) -> Result<Output> {
        let mut result = Err(Error::Closed);
        for attempt in 0..2 {
            if self.conn.is_none() {
                self.state.set_status(
                    &self.account.id,
                    AccountStatus {
                        state: "connecting",
                        error: None,
                    },
                );
                match connect(&self.state, &self.account).await {
                    Ok(c) => self.conn = Some(c),
                    Err(e) => return Err(e),
                }
            }
            let c = self.conn.as_mut().expect("connected above");
            match perform(&self.state, &self.account, c, op, &mut self.notify_new).await {
                Ok(out) => {
                    self.busy_streak = 0;
                    return Ok(out);
                }
                Err(e) => {
                    let dropped = e.is_transient() && !e.is_busy();
                    if dropped {
                        self.conn = None;
                    }
                    result = Err(e);
                    if !(dropped && attempt == 0) {
                        break;
                    }
                }
            }
        }
        result
    }

    /// A user action. A busy server's short pause is waited out; with a longer one
    /// the user hears at once how long it is, instead of a silent wait.
    async fn user(&mut self, work: &Work) -> Result<Output> {
        if let Some(left) = self.busy_left() {
            if left > USER_WAITS_BUSY {
                return Err(Error::Busy {
                    wait: left,
                    retrying: false,
                });
            }
            tokio::time::sleep(left).await;
        }
        let mut waited = false;
        loop {
            match self.attempt(Op::Work(work)).await {
                Err(e) if e.is_busy() => {
                    let pause = self.throttled(&e);
                    if waited || pause > USER_WAITS_BUSY {
                        return Err(Error::Busy {
                            wait: pause,
                            retrying: false,
                        });
                    }
                    waited = true;
                    tokio::time::sleep(pause).await;
                }
                result => return result,
            }
        }
    }

    /// "Sync now": joins the pass under way, or starts one, and answers at its end.
    async fn user_sync_all(&mut self, reply: Reply) {
        if let Some(pass) = &mut self.pass {
            pass.waiting.push(reply);
            return;
        }
        if let Some(wait) = self.busy_left() {
            offer(&self.background, &self.queued, Work::SyncAll);
            let _ = reply.send(Err(Error::Busy { wait, retrying: true }));
            return;
        }
        self.start_pass(Some(reply)).await;
    }

    /// Background work. After "server busy" it is queued again and waits the pause out.
    async fn background(&mut self, work: Work) {
        if matches!(work, Work::SyncAll) {
            return self.start_pass(None).await;
        }
        let result = self.attempt(Op::Work(&work)).await;
        if let Err(e) = &result
            && e.is_busy()
        {
            let pause = self.throttled(e);
            self.show_busy(pause);
            offer(&self.background, &self.queued, work);
            return;
        }
        self.report(&work, &result, false);
    }

    /// Reads the folder list; the folders themselves are synced by `step`, between user actions.
    async fn start_pass(&mut self, reply: Option<Reply>) {
        let id = self.account.id.clone();
        let key = self.sync_task();
        self.state
            .task(&key, "sync", Some(&id), tr!("Syncing", "Синхронизация"), 0, 0);
        match self.attempt(Op::Work(&Work::SyncAll)).await {
            Ok(out) => {
                let folders = match out {
                    Output::Folders(f) => f,
                    _ => Vec::new(),
                };
                self.pass = Some(Pass {
                    total: folders.len() as u64,
                    folders: folders.into(),
                    done: 0,
                    waiting: reply.into_iter().collect(),
                });
                self.online();
                // A pass with no folders ends here.
                if self.pass.as_ref().is_some_and(|p| p.folders.is_empty()) {
                    self.finish_pass();
                }
            }
            Err(e) if e.is_busy() => {
                let pause = self.throttled(&e);
                self.show_busy(pause);
                self.state.task_done(&key);
                offer(&self.background, &self.queued, Work::SyncAll);
                if let Some(reply) = reply {
                    let _ = reply.send(Err(Error::Busy {
                        wait: pause,
                        retrying: true,
                    }));
                }
            }
            Err(e) => {
                let result = Err(e);
                self.report(&Work::SyncAll, &result, reply.is_some());
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
            }
        }
    }

    /// Syncs the next folder of the pass. After "server busy" the same folder is
    /// tried again once the pause is over; the folders done are not done again.
    async fn step(&mut self) {
        let key = self.sync_task();
        let Some(pass) = &mut self.pass else { return };
        if self.paused.load(Ordering::Relaxed) {
            // A user action ran into an error only the user can fix: background work waits.
            for reply in pass.waiting.drain(..) {
                let _ = reply.send(Err(Error::Paused));
            }
            self.pass = None;
            self.state.task_done(&key);
            return;
        }
        let Some((folder, name)) = pass.folders.front().cloned() else {
            return self.finish_pass();
        };
        self.state.task(
            &key,
            "sync",
            Some(&self.account.id),
            tr!("Syncing: {name}", "Синхронизация: {name}"),
            pass.done,
            pass.total,
        );
        match self.attempt(Op::PassFolder(&folder)).await {
            Ok(_) => {
                if let Some(pass) = &mut self.pass {
                    pass.folders.pop_front();
                    pass.done += 1;
                }
                self.online();
                if self.pass.as_ref().is_some_and(|p| p.folders.is_empty()) {
                    self.finish_pass();
                }
            }
            Err(e) if e.is_busy() => {
                let pause = self.throttled(&e);
                self.show_busy(pause);
            }
            // The connection broke twice or the login failed: the pass stops here,
            // the timer or the next change starts a new one.
            Err(e) => {
                let waiting = self.pass.take().map(|p| p.waiting).unwrap_or_default();
                let result = Err(e);
                self.report(&Work::SyncAll, &result, false);
                if let Err(e) = &result {
                    for reply in waiting {
                        let _ = reply.send(Err(clone_error(e)));
                    }
                }
            }
        }
    }

    fn finish_pass(&mut self) {
        let Some(pass) = self.pass.take() else { return };
        let id = &self.account.id;
        self.state.task_done(&self.sync_task());
        self.state.mark_synced(id);
        // Fresh headers: download their text for offline reading.
        self.notify_new = true;
        offer(&self.background, &self.queued, Work::Prefetch);
        for reply in pass.waiting {
            let _ = reply.send(Ok(Output::None));
        }
    }

    fn online(&self) {
        if self.state.status(&self.account.id).is_none_or(|s| s.state != "online") {
            self.state.set_status(
                &self.account.id,
                AccountStatus {
                    state: "online",
                    error: None,
                },
            );
        }
    }

    /// The outcome of work in the account's status and the tasks window.
    fn report(&self, work: &Work, result: &Result<Output>, user: bool) {
        let state = &self.state;
        let account = &self.account;
        match result {
            Ok(out) => {
                // The next offline batch; mail that came between full syncs (IDLE, the
                // copy in Sent) is downloaded at once, not at the next pass.
                if let (Work::Prefetch | Work::SyncFolder(_), Output::Count(n)) = (work, out)
                    && *n > 0
                {
                    offer(&self.background, &self.queued, Work::Prefetch);
                }
                self.online();
            }
            Err(e) => {
                tracing::warn!(account = %account.id, kind = e.kind(), "operation failed: {e}");
                match work {
                    Work::SyncAll => state.task_failed(&self.sync_task(), CmdError::from(clone_error(e))),
                    Work::Prefetch => {
                        state.task_failed(&format!("prefetch:{}", account.id), CmdError::from(clone_error(e)))
                    }
                    _ => {}
                }
                let fatal = needs_user(e);
                self.paused.store(fatal, Ordering::Relaxed);
                let status = if fatal { "paused" } else { "error" };
                // Errors of a single message action go to the caller, not to the account status;
                // a message the offline download could not take shows in its task.
                if (!user && !matches!(work, Work::Prefetch)) || self.conn.is_none() {
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
        Error::Ews {
            code,
            message,
            back_off,
        } => Error::Ews {
            code: code.clone(),
            message: message.clone(),
            back_off: *back_off,
        },
        Error::Busy { wait, retrying } => Error::Busy {
            wait: *wait,
            retrying: *retrying,
        },
        Error::ImapUnavailable => Error::ImapUnavailable,
        Error::Timeout(t) => Error::Timeout(t),
        Error::Closed => Error::Closed,
        Error::Paused => Error::Paused,
        other => Error::Protocol(other.to_string()),
    }
}

async fn connect(state: &AppState, account: &Account) -> Result<Conn> {
    let conn = state.connect(account).await?;
    if let Conn::Imap(c) = &conn {
        crate::server::keep_login(state, &account.id, c);
    }
    Ok(conn)
}

async fn perform(
    state: &AppState,
    account: &Account,
    conn: &mut Conn,
    op: Op<'_>,
    notify_new: &mut bool,
) -> Result<Output> {
    let store = &state.store;
    let id = account.id.as_str();
    let work = match op {
        Op::Work(work) => work,
        Op::PassFolder(folder) => {
            return match sync_one(state, account, conn, folder, *notify_new).await {
                Ok(_) => Ok(Output::None),
                Err(e) if e.is_transient() => Err(e),
                // One broken folder (Exchange shows some odd ones) must not stop the rest.
                Err(e) => {
                    tracing::warn!(account = %id, folder = %folder, "folder sync failed: {e}");
                    Ok(Output::None)
                }
            };
        }
    };
    match work {
        Work::SyncAll => {
            let folders = mail::sync_folder_list(conn, store, id).await?;
            state.emit("folders-changed", json!({ "account_id": id }));
            let mut order: Vec<_> = folders.iter().filter(|f| f.selectable && !f.hidden).collect();
            order.sort_by_key(|f| match f.role {
                Some(FolderRole::Inbox) => 0,
                Some(_) => 1,
                None => 2,
            });
            Ok(Output::Folders(
                order
                    .into_iter()
                    .map(|f| (f.name.clone(), f.display_name.clone()))
                    .collect(),
            ))
        }
        Work::Prefetch => prefetch(state, conn, id).await,
        Work::SyncFolder(folder) => Ok(Output::Count(
            sync_one(state, account, conn, folder, *notify_new).await?,
        )),
        Work::LoadBody(msg_id) => Ok(Output::Body(mail::load_body(conn, store, *msg_id).await?)),
        Work::SetFlag {
            folder,
            validity,
            uids,
            change,
        } => {
            mail::set_flag(conn, store, id, folder, *validity, uids, *change).await?;
            Ok(Output::None)
        }
        Work::Move {
            from,
            validity,
            uids,
            to,
        } => {
            mail::move_messages(conn, store, id, from, *validity, uids, to).await?;
            sync_one(state, account, conn, from, false).await?;
            sync_one(state, account, conn, to, false).await?;
            Ok(Output::None)
        }
        Work::Delete { folder, validity, uids } => {
            mail::delete_permanently(conn, store, id, folder, *validity, uids).await?;
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
        // Counted once a batch: what it saved is added, not counted again.
        let done = (done + saved as u64).min(total);
        state.task(&key, "prefetch", Some(account_id), label(), done, total);
    }
    // The cache got text to search in.
    state.emit("offline-progress", json!({ "account_id": account_id }));
    Ok(Output::Count(if last { 0 } else { saved }))
}

/// Returns how many messages came new.
async fn sync_one(state: &AppState, account: &Account, conn: &mut Conn, folder: &str, notify: bool) -> Result<usize> {
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
    Ok(report.added)
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
    tx: mpsc::Sender<Work>,
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
                // A busy Exchange named its pause: the subscription waits it out too.
                let wait = if e.is_busy() {
                    backoff.max(busy_pause(e.back_off(), 0))
                } else {
                    backoff
                };
                tokio::time::sleep(wait).await;
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
                        // A link that breaks at once (a proxy cutting long answers) must not spin;
                        // a busy Exchange gets the pause it asked for.
                        let wait = if e.is_busy() { busy_pause(e.back_off(), 0) } else { Duration::from_secs(5) };
                        tokio::time::sleep(wait).await;
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
        while let Ok(w) = rx.try_recv() {
            got.push(sync_key(&w).unwrap());
        }
        assert_eq!(got, ["INBOX", "Sent", ""]);

        // Started: changes during the sync bring the next one.
        release(&queued, "INBOX");
        queue(&tx, &queued, Work::SyncFolder("INBOX".into())).await;
        assert!(matches!(rx.try_recv(), Ok(Work::SyncFolder(f)) if f == "INBOX"));

        // Retries the loop queues itself keep the same guarantee.
        offer(&tx, &queued, Work::SyncFolder("INBOX".into()));
        assert!(rx.try_recv().is_err());
    }

    fn load(id: i64) -> (Work, Reply) {
        (Work::LoadBody(id), oneshot::channel().0)
    }

    fn loaded(next: Next) -> Option<i64> {
        match next {
            Next::User(Work::LoadBody(id), _) => Some(id),
            _ => None,
        }
    }

    async fn ticker() -> tokio::time::Interval {
        let mut tick = tokio::time::interval(FULL_SYNC_EVERY);
        tick.tick().await;
        tick
    }

    #[tokio::test]
    async fn user_actions_go_between_the_folders_of_a_full_sync() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        let (background_tx, mut background) = mpsc::channel(8);
        let mut tick = ticker().await;
        background_tx.send(Work::SyncFolder("INBOX".into())).await.unwrap();

        // A pass under way goes on folder by folder; other background work waits for its end.
        assert!(matches!(
            next(&mut urgent, &mut background, &mut tick, true, None).await,
            Next::Step
        ));

        // Actions sent meanwhile run before the next folder, in the order sent.
        urgent_tx.send(load(1)).await.unwrap();
        urgent_tx.send(load(2)).await.unwrap();
        assert_eq!(
            loaded(next(&mut urgent, &mut background, &mut tick, true, None).await),
            Some(1)
        );
        assert_eq!(
            loaded(next(&mut urgent, &mut background, &mut tick, true, None).await),
            Some(2)
        );
        assert!(matches!(
            next(&mut urgent, &mut background, &mut tick, true, None).await,
            Next::Step
        ));

        // Without a pass, background work comes after user actions too.
        urgent_tx.send(load(3)).await.unwrap();
        assert_eq!(
            loaded(next(&mut urgent, &mut background, &mut tick, false, None).await),
            Some(3)
        );
        assert!(matches!(
            next(&mut urgent, &mut background, &mut tick, false, None).await,
            Next::Background(Work::SyncFolder(f)) if f == "INBOX"
        ));
    }

    #[tokio::test]
    async fn a_busy_server_holds_background_work_but_not_the_users_answer() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        let (background_tx, mut background) = mpsc::channel(8);
        let mut tick = ticker().await;
        background_tx.send(Work::Prefetch).await.unwrap();
        let pause = Duration::from_millis(300);

        // Background work and the pass wait the pause out…
        let start = tokio::time::Instant::now();
        let until = Some(start + pause);
        assert!(matches!(
            next(&mut urgent, &mut background, &mut tick, false, until).await,
            Next::Background(Work::Prefetch)
        ));
        assert!(start.elapsed() >= pause);
        let start = tokio::time::Instant::now();
        let until = Some(start + pause);
        assert!(matches!(
            next(&mut urgent, &mut background, &mut tick, true, until).await,
            Next::Step
        ));
        assert!(start.elapsed() >= pause);

        // …a user action is taken at once, to be answered with the time left.
        urgent_tx.send(load(7)).await.unwrap();
        let start = tokio::time::Instant::now();
        let until = Some(start + Duration::from_secs(60));
        assert_eq!(
            loaded(next(&mut urgent, &mut background, &mut tick, true, until).await),
            Some(7)
        );
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn busy_pause_follows_the_server_within_bounds() {
        // The server's word, however short…
        assert_eq!(busy_pause(Some(Duration::from_millis(2000)), 0), Duration::from_secs(2));
        assert_eq!(busy_pause(Some(Duration::from_secs(30)), 3), Duration::from_secs(30));
        // …but never hours.
        assert_eq!(busy_pause(Some(Duration::from_secs(3600)), 0), BUSY_PAUSE_MAX);
        // No word, or zero: never an instant retry, longer while the server stays busy.
        assert_eq!(busy_pause(None, 0), BUSY_PAUSE);
        assert_eq!(busy_pause(Some(Duration::ZERO), 0), BUSY_PAUSE);
        assert_eq!(busy_pause(None, 1), BUSY_PAUSE * 2);
        assert_eq!(busy_pause(None, 2), BUSY_PAUSE * 4);
        assert_eq!(busy_pause(None, 40), BUSY_PAUSE_MAX);
    }
}
