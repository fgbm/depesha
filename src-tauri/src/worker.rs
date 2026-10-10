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
use depesha_core::domain::{FlagChange, FolderRole};
use depesha_core::idle_pace::{Dropped, IdlePace};
use depesha_core::imap::IdleOutcome;
use depesha_core::mail::{self, Conn};
use depesha_core::store::ListQuery;
use depesha_core::sync::SyncOptions;
use depesha_core::{Error, Result};
use serde_json::json;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::CmdError;
use crate::state::{AccountStatus, AppState, lock};
use depesha_core::tr;

const FULL_SYNC_EVERY: Duration = Duration::from_secs(5 * 60);
/// Messages downloaded for offline reading per round: user actions wait for a
/// round at most, they are queued between rounds.
const PREFETCH_BATCH: u32 = 25;
/// A prefetch batch is bounded by bytes too: with attachments, 25 messages can be hundreds
/// of megabytes, and the whole mailbox waits for them. A short batch lets a body somebody
/// opens (or their next action) run between them.
const PREFETCH_BYTES: u64 = 20 * 1024 * 1024;
/// How often INBOX is checked on a server without IDLE; the "Server" section says so.
pub const POLL_WITHOUT_IDLE: Duration = Duration::from_secs(120);
/// Pause after "server busy" (Exchange throttling) when the server names none; it
/// doubles while the server stays busy.
const BUSY_PAUSE: Duration = Duration::from_secs(5);
/// The longest pause after "server busy": a wrong value must not silence the mailbox.
const BUSY_PAUSE_MAX: Duration = Duration::from_secs(5 * 60);
/// A user action waits out a busy pause this short; a longer one is answered at once.
const USER_WAITS_BUSY: Duration = Duration::from_secs(5);
/// The most moves of one source and target merged into a single `UID MOVE`. A held
/// "archive" key is dozens of them; the cap only keeps one enormous backlog from
/// becoming a single request the server may refuse.
const MAX_COALESCED_MOVES: usize = 1000;
/// The most user actions taken out of the queue in one gather; the rest wait their turn.
const MAX_GATHERED: usize = 2000;
/// A move series is not run at once: the loop waits this long for more moves of the same
/// source and target, so a held key becomes a couple of requests. A lone move never waits.
const MOVE_SETTLE_STEP: Duration = Duration::from_millis(50);
/// How long a move series is gathered before it runs, at most.
const MOVE_SETTLE_MAX: Duration = Duration::from_millis(500);
/// How many quiet steps (no new move) end the gather early.
const MOVE_SETTLE_QUIET: u32 = 2;
/// A single piece of work cannot run forever: long enough for a big body download, short
/// enough that a stall the silence watchdog misses (a server that keeps dribbling bytes)
/// cannot hold the mailbox for hours.
const WORK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The first pause after a failed connect; it doubles while the network stays down.
const NET_BACKOFF: Duration = Duration::from_secs(5);
/// The longest pause between connect attempts: often enough to notice the network back.
const NET_BACKOFF_MAX: Duration = Duration::from_secs(5 * 60);
/// A wall-clock jump this far ahead of the monotonic clock means the machine slept.
const SLEEP_GAP: Duration = Duration::from_secs(20);
/// A user action is a reason to try the connection again once the last attempt is older
/// than this: the pause after a failed connect is not waited out in full for a user who is
/// right there, but a very fresh attempt is not repeated (it is still in flight).
const USER_RETRY_GAP: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub enum Work {
    /// Every visible folder, one at a time: user actions run between them.
    SyncAll,
    SyncFolder(String),
    LoadBody {
        id: i64,
        /// The window and open sequence the load belongs to: a load whose sequence is
        /// no longer the window's newest is dropped before the server is asked (#71).
        gate: Option<(String, u64)>,
    },
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
        /// Of `uids`, the letters the action itself is about: only they are marked read
        /// before the move. The rest of a conversation, a letter coming back from the
        /// trash or dragged to a folder keeps its flags.
        seen: Vec<u32>,
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
    /// The copy of a sent letter in «Sent», as work of its own: the send round does not
    /// wait for it, and a failure shows in the tasks window, not as a stalled send.
    CopyToSent {
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
    /// Reads the mailbox's quota again (the "Storage" section opened).
    Quota,
    /// How many messages the folder holds on the server (the cache keeps a window of it) and
    /// the bound that counted them.
    FolderCount(String),
    /// Empties Trash, Junk or Drafts on the server (#74).
    EmptyFolder(crate::empty::Request),
    /// Puts labels on messages, or takes them off, by their names.
    SetLabels {
        folder: String,
        validity: u32,
        uids: Vec<u32>,
        add: Vec<depesha_core::acl::Label>,
        remove: Vec<depesha_core::acl::Label>,
    },
    /// Reads a folder's rights, permanent flags and owner; the "Properties" card.
    FolderProps(String),
    /// Checks own labels on a test message in the folder (#42, frame 9).
    CheckLabels {
        folder: String,
        keyword: String,
        message_id: String,
        subject: String,
    },
    /// Takes a label's keyword off the messages of one folder (#42, frame 4Б): IMAP
    /// searches the folder, Exchange drops the category of the same name there. One folder
    /// per work, so the mailbox's queue is not held for the whole account.
    StripLabel {
        folder: String,
        keyword: String,
    },
    /// Renames an Exchange category on every item of the account (#42, frame 7): the name
    /// is the category, so the server rewrite is the rename. IMAP renames quietly, with none.
    RenameCategory {
        from: String,
        to: String,
    },
}

pub enum Output {
    None,
    Body(Vec<u8>),
    Count(usize),
    Ids(Vec<i64>),
    /// The start of a full sync: the folders to sync in order, name and display name.
    Folders(Vec<(String, String)>),
    /// A folder's props, as the "Properties" card shows them.
    Props(depesha_core::acl::FolderProps),
    /// The outcome of a label check on a test message (#42, frame 9).
    LabelCheck(depesha_core::acl::LabelCheck),
    /// What a folder held on the server when it was counted.
    Counted(usize, mail::Bound),
    /// How far an emptying of a folder got.
    /// How far it got, and the cache ids of the drafts it kept.
    Emptied(depesha_core::clear::Emptied, Vec<i64>),
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
    lock(queued).insert(key.to_owned())
}

fn release(queued: &Queued, key: &str) {
    lock(queued).remove(key);
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

/// Takes the moves of one source and target waiting in `urgent` into `uids`, `seen` and `replies`:
/// a held "archive" key becomes a single `UID MOVE` for all the letters, and both folders
/// are synced once, not once per letter. Every caller keeps its own answer. Only a
/// **continuous** series is merged: the first action of another kind stops the gather and
/// waits in `deferred` in its place, so the order the user asked for is kept (a move, then
/// a flag on a letter, then a move of it must not run as one move and a stale store).
/// Returns how many moves were merged.
#[allow(clippy::too_many_arguments)]
fn drain_moves(
    urgent: &mut mpsc::Receiver<(Work, Reply)>,
    deferred: &mut VecDeque<(Work, Reply)>,
    from: &str,
    validity: u32,
    to: &str,
    uids: &mut Vec<u32>,
    seen: &mut Vec<u32>,
    replies: &mut Vec<Reply>,
) -> usize {
    let mut merged = 0usize;
    let mut taken = 0usize;
    while replies.len() < MAX_COALESCED_MOVES && taken < MAX_GATHERED {
        match urgent.try_recv() {
            Ok((
                Work::Move {
                    from: f,
                    validity: v,
                    uids: u,
                    to: t,
                    seen: s,
                },
                reply,
            )) if f == from && v == validity && t == to => {
                uids.extend(u);
                seen.extend(s);
                replies.push(reply);
                merged += 1;
                taken += 1;
            }
            Ok(item) => {
                deferred.push_back(item);
                break;
            }
            Err(_) => break,
        }
    }
    merged
}

/// The same for a flag: a continuous series of `SetFlag` of one folder becomes one `STORE`
/// per change. A UID said more than once ends as the last thing said of it (Seen, then
/// Unseen, then Seen runs as Seen once), so a held "read" or "flag" key is a couple of
/// requests and not one per letter. Another kind of work stops the series and waits its
/// turn. `series` collects `(uid, change)` in the order they arrived.
fn drain_flags(
    urgent: &mut mpsc::Receiver<(Work, Reply)>,
    deferred: &mut VecDeque<(Work, Reply)>,
    folder: &str,
    validity: u32,
    series: &mut Vec<(u32, FlagChange)>,
    replies: &mut Vec<Reply>,
) -> usize {
    let mut merged = 0usize;
    let mut taken = 0usize;
    while replies.len() < MAX_COALESCED_MOVES && taken < MAX_GATHERED {
        match urgent.try_recv() {
            Ok((
                Work::SetFlag {
                    folder: f,
                    validity: v,
                    uids: u,
                    change: c,
                },
                reply,
            )) if f == folder && v == validity => {
                series.extend(u.into_iter().map(|uid| (uid, c)));
                replies.push(reply);
                merged += 1;
                taken += 1;
            }
            Ok(item) => {
                deferred.push_back(item);
                break;
            }
            Err(_) => break,
        }
    }
    merged
}

/// A flag series by change: each UID once per kind of flag, carrying the last change said
/// of that flag, grouped by change so each group is one `STORE`. Groups come in the order
/// their change first took effect, which is only cosmetic. A UID can be in two groups: Seen
/// and Flagged are different flags, and the last word on one does not cancel the other.
fn compact_flags(series: &[(u32, FlagChange)]) -> Vec<(FlagChange, Vec<u32>)> {
    type Slot = (u32, std::mem::Discriminant<FlagChange>);
    let slot = |uid: &u32, change: &FlagChange| -> Slot { (*uid, std::mem::discriminant(change)) };
    let mut last: std::collections::HashMap<Slot, FlagChange> = std::collections::HashMap::new();
    for (uid, change) in series {
        last.insert(slot(uid, change), *change);
    }
    let mut placed: HashSet<Slot> = HashSet::new();
    let mut groups: Vec<(FlagChange, Vec<u32>)> = Vec::new();
    for (uid, change) in series {
        let key = slot(uid, change);
        if !placed.insert(key) || last.get(&key) != Some(change) {
            continue;
        }
        match groups.iter_mut().find(|(g, _)| g == change) {
            Some((_, u)) => u.push(*uid),
            None => groups.push((*change, vec![*uid])),
        }
    }
    groups
}

/// The same for labels: a continuous series of `SetLabels` of one folder with the same
/// labels becomes one request for all the UIDs. Another kind of work stops the series and
/// waits its turn.
#[allow(clippy::too_many_arguments)]
fn drain_labels(
    urgent: &mut mpsc::Receiver<(Work, Reply)>,
    deferred: &mut VecDeque<(Work, Reply)>,
    folder: &str,
    validity: u32,
    add: &[depesha_core::acl::Label],
    remove: &[depesha_core::acl::Label],
    uids: &mut Vec<u32>,
    replies: &mut Vec<Reply>,
) -> usize {
    let mut merged = 0usize;
    let mut taken = 0usize;
    while replies.len() < MAX_COALESCED_MOVES && taken < MAX_GATHERED {
        match urgent.try_recv() {
            Ok((
                Work::SetLabels {
                    folder: f,
                    validity: v,
                    uids: u,
                    add: a,
                    remove: r,
                },
                reply,
            )) if f == folder && v == validity && a == add && r == remove => {
                uids.extend(u);
                replies.push(reply);
                merged += 1;
                taken += 1;
            }
            Ok(item) => {
                deferred.push_back(item);
                break;
            }
            Err(_) => break,
        }
    }
    merged
}

/// A series of the same work is under way (more than one caller): let it gather a moment, so
/// a held key is a couple of requests, not one per letter. A lone one runs at once. `drain`
/// takes whatever has queued meanwhile into `replies`. The first action of another kind
/// ends the series: it waits in `deferred`, and the gather stops there so the order the
/// user asked for is kept.
async fn settle_series(
    urgent: &mut mpsc::Receiver<(Work, Reply)>,
    deferred: &mut VecDeque<(Work, Reply)>,
    replies: &mut Vec<Reply>,
    mut drain: impl FnMut(&mut mpsc::Receiver<(Work, Reply)>, &mut VecDeque<(Work, Reply)>, &mut Vec<Reply>),
) {
    if replies.len() <= 1 {
        return;
    }
    let deadline = tokio::time::Instant::now() + MOVE_SETTLE_MAX;
    let mut settled = 0u32;
    while replies.len() < MAX_COALESCED_MOVES && settled < MOVE_SETTLE_QUIET && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(MOVE_SETTLE_STEP).await;
        let before = replies.len();
        let queued = deferred.len();
        drain(urgent, deferred, replies);
        // A foreign action was set aside: the series is over, nothing behind it is merged.
        if deferred.len() > queued {
            break;
        }
        settled = if replies.len() == before { settled + 1 } else { 0 };
    }
}

/// Every caller of a merged batch gets its own answer; the work itself answers `None`.
fn answer_all(replies: Vec<Reply>, result: Result<Output>) {
    match result {
        Ok(_) => {
            for reply in replies {
                let _ = reply.send(Ok(Output::None));
            }
        }
        Err(e) => {
            for reply in replies {
                let _ = reply.send(Err(clone_error(&e)));
            }
        }
    }
}

#[derive(Clone)]
pub struct Worker {
    /// Reading a letter's body: it goes ahead of the moves waiting in `urgent`, so
    /// opening mail does not stand in line behind a series of archives.
    reads: mpsc::Sender<(Work, Reply)>,
    /// User actions and other work somebody waits for; they go ahead of `background`.
    urgent: mpsc::Sender<(Work, Reply)>,
    /// Work nobody asked for just now (snoozed mail coming back, a Sent copy, a photo):
    /// it waits behind the user's actions and the bodies being read, ahead of `background`.
    quiet: mpsc::Sender<(Work, Reply)>,
    background: mpsc::Sender<Work>,
    queued: Queued,
    tasks: Arc<Vec<JoinHandle<()>>>,
    /// Set after errors only the user can fix; stops automatic reconnects.
    paused: Arc<AtomicBool>,
}

/// The mailbox's queue as the core's scenarios see it (`MailQueue`): background work by
/// default, which a paused mailbox refuses, or the user's own (`Queue::urgent`).
pub struct Queue {
    worker: Worker,
    store: Arc<depesha_core::store::Store>,
    account_id: String,
    background: bool,
}

impl Queue {
    /// The queue of the mailbox `account_id`; the error says it is not running.
    pub fn background(state: &AppState, account_id: &str) -> crate::error::CmdResult<Self> {
        Ok(Self {
            worker: state.worker(account_id)?,
            store: state.store.clone(),
            account_id: account_id.to_owned(),
            background: true,
        })
    }

    pub fn urgent(state: &AppState, account_id: &str) -> crate::error::CmdResult<Self> {
        Ok(Self {
            background: false,
            ..Self::background(state, account_id)?
        })
    }

    async fn run(&self, work: Work) -> Result<Output> {
        if self.background {
            self.worker.run_background(work).await
        } else {
            self.worker.run(work).await
        }
    }
}

impl depesha_core::port::MailQueue for Queue {
    async fn move_by_message_id(&mut self, m: depesha_core::port::Move) -> Result<usize> {
        let work = Work::MoveByMessageId {
            from: m.from,
            message_ids: m.message_ids,
            to: m.to,
            unseen: m.unseen,
        };
        match self.run(work).await? {
            Output::Count(n) => Ok(n),
            _ => Err(Error::Protocol(
                "a move was answered with something else than a count".into(),
            )),
        }
    }

    async fn create_folder(&mut self, name: &str) -> Result<()> {
        self.run(Work::CreateFolder(name.to_owned())).await.map(drop)
    }

    async fn strip_label(&mut self, folder: &str, label: &str) -> Result<usize> {
        let work = Work::StripLabel {
            folder: folder.to_owned(),
            keyword: label.to_owned(),
        };
        // Any other answer is a folder with nothing to count.
        Ok(match self.run(work).await? {
            Output::Count(n) => n,
            _ => 0,
        })
    }

    async fn copy_to_sent(&mut self, folder: &str, raw: &[u8], flags: &str, message_id: Option<&str>) -> Result<()> {
        let work = Work::CopyToSent {
            folder: folder.to_owned(),
            raw: raw.to_vec(),
            flags: flags.to_owned(),
            message_id: message_id.map(str::to_owned),
        };
        self.run(work).await.map(drop)
    }

    async fn set_flag(&mut self, folder: &str, message_id: &str, change: FlagChange) -> Result<()> {
        // The UID and the UIDVALIDITY it was read under are the cache's.
        let (row, validity) = self
            .store
            .find_by_message_id(&self.account_id, folder, message_id)?
            .and_then(|r| self.store.get_at(r.id).ok().flatten())
            .ok_or(Error::NotFound)?;
        let work = Work::SetFlag {
            folder: row.folder,
            validity,
            uids: vec![row.uid],
            change,
        };
        self.run(work).await.map(drop)
    }
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
        self.call_quiet(work).await
    }

    async fn call(&self, work: Work) -> Result<Output> {
        let (reply, rx) = oneshot::channel();
        // Reading a body jumps ahead of the moves waiting to run; everything else queues
        // behind them.
        let tx = if matches!(work, Work::LoadBody { .. }) {
            &self.reads
        } else {
            &self.urgent
        };
        tx.send((work, reply)).await.map_err(|_| Error::Closed)?;
        rx.await.map_err(|_| Error::Closed)?
    }

    /// Work nobody waits on with their hand on the keyboard: it queues behind the user's
    /// actions and the bodies being opened, not among them.
    async fn call_quiet(&self, work: Work) -> Result<Output> {
        let (reply, rx) = oneshot::channel();
        self.quiet.send((work, reply)).await.map_err(|_| Error::Closed)?;
        rx.await.map_err(|_| Error::Closed)?
    }
}

/// More than this many unfinished moves are forgotten, so a mailbox that is down for good
/// does not make the set grow without end.
const MAX_UNFINISHED_MOVES: usize = 10_000;

/// Whether `op` is a move some of whose letters were already tried and did not finish.
fn is_unfinished(unfinished: &HashSet<(String, String, u32)>, op: &Op<'_>) -> bool {
    let Op::Work(Work::Move { from, uids, to, .. }) = op else {
        return false;
    };
    uids.iter()
        .any(|u| unfinished.contains(&(from.clone(), to.clone(), *u)))
}

/// Remembers a move that failed, forgets one that went through.
fn note_move(unfinished: &mut HashSet<(String, String, u32)>, op: &Op<'_>, done: bool) {
    let Op::Work(Work::Move { from, uids, to, .. }) = op else {
        return;
    };
    for u in uids {
        let key = (from.clone(), to.clone(), *u);
        if done {
            unfinished.remove(&key);
        } else {
            unfinished.insert(key);
        }
    }
    if unfinished.len() > MAX_UNFINISHED_MOVES {
        unfinished.clear();
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

/// The pause after a failed connect, doubled each time with a ceiling: with no network
/// every action would otherwise wait out its own 20 s connect before failing.
fn net_backoff(current: Duration) -> Duration {
    if current.is_zero() {
        NET_BACKOFF
    } else {
        (current * 2).min(NET_BACKOFF_MAX)
    }
}

/// "No network" as a transient error; the wording comes from `io_text`.
fn no_network() -> Error {
    Error::Io(std::io::Error::new(
        std::io::ErrorKind::NetworkUnreachable,
        "no network",
    ))
}

/// Whether the machine slept since the last call: the wall clock ran on, the monotonic
/// one did not. Updates both marks.
fn slept_since(last_wall: &mut SystemTime, last_mono: &mut Instant) -> bool {
    let wall = SystemTime::now();
    let mono = Instant::now();
    let slept = wall.duration_since(*last_wall).unwrap_or_default() > mono.duration_since(*last_mono) + SLEEP_GAP;
    *last_wall = wall;
    *last_mono = mono;
    slept
}

/// Whether a failed connect still holds the mailbox out of touch: work gets an error at
/// once then, instead of another 20 s connect. Wall clock, not the monotonic one, so the
/// pause runs on while the machine sleeps rather than freezing until it wakes.
fn out_of_touch(until: Option<SystemTime>, now: SystemTime) -> bool {
    until.is_some_and(|t| t > now)
}

/// Whether a user action is a reason to try the connection again: yes once the last
/// attempt is older than `USER_RETRY_GAP` (or there was none). A very fresh attempt is
/// not repeated — it is probably still in flight.
fn may_retry_now(last_try: Option<SystemTime>, now: SystemTime) -> bool {
    last_try.is_none_or(|t| now.duration_since(t).unwrap_or_default() >= USER_RETRY_GAP)
}

/// Whether the network pause is let go before the work: only for the user, who is waiting.
/// Background work with a caller (a Sent copy, a photo) sits the pause out like the rest.
fn lifts_net_pause(user_waits: bool, last_try: Option<SystemTime>, now: SystemTime) -> bool {
    user_waits && may_retry_now(last_try, now)
}

pub fn spawn(state: Arc<AppState>, account: Account) -> Worker {
    let (reads, reads_rx) = mpsc::channel(64);
    let (urgent, urgent_rx) = mpsc::channel(64);
    let (quiet, quiet_rx) = mpsc::channel(64);
    let (background, background_rx) = mpsc::channel(64);
    let paused = Arc::new(AtomicBool::new(false));
    let queued: Queued = Arc::default();
    // Set by the waiting connection on a successful connect: the operations connection
    // takes it as a reason to connect at once rather than wait its pause out.
    let net_up = Arc::new(AtomicBool::new(false));
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
        deferred: VecDeque::new(),
        no_network_until: None,
        net_backoff: Duration::ZERO,
        last_net_try: None,
        net_up: net_up.clone(),
        prefetch_failed: HashSet::new(),
        unfinished_moves: HashSet::new(),
        last_wall: SystemTime::now(),
        last_mono: Instant::now(),
    };
    let ops = tokio::spawn(ops.run(reads_rx, urgent_rx, quiet_rx, background_rx));
    let idle = tokio::spawn(idle_loop(
        state,
        account,
        background.clone(),
        paused.clone(),
        queued.clone(),
        net_up,
    ));
    let worker = Worker {
        reads,
        urgent,
        quiet,
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
    /// Work nobody is waiting on with their hand on the keyboard; it answers its caller.
    Quiet(Work, Reply),
    Background(Work),
    /// The next folder of the full sync under way.
    Step,
    Tick,
    Closed,
}

/// Reads first (a body somebody is opening), then user actions in the order sent, then the
/// quiet work (snoozed mail coming back, a Sent copy, a photo), then the full sync under way
/// (`stepping`), one folder per call, and other background work last. Actions taken out of
/// `urgent` but not run yet wait in `deferred` and go before it. While a busy server asks to
/// wait (`busy_until`), only user actions are taken: they get their answer at once.
#[allow(clippy::too_many_arguments)]
async fn next(
    reads: &mut mpsc::Receiver<(Work, Reply)>,
    urgent: &mut mpsc::Receiver<(Work, Reply)>,
    quiet: &mut mpsc::Receiver<(Work, Reply)>,
    deferred: &mut VecDeque<(Work, Reply)>,
    background: &mut mpsc::Receiver<Work>,
    tick: &mut tokio::time::Interval,
    stepping: bool,
    busy_until: Option<tokio::time::Instant>,
) -> Next {
    // What a previous gather took out of the queue and did not run yet.
    if let Some((work, reply)) = deferred.pop_front() {
        return Next::User(work, reply);
    }
    if let Some(until) = busy_until
        && until > tokio::time::Instant::now()
    {
        tokio::select! {
            biased;
            item = reads.recv() => return item.map_or(Next::Closed, |(w, r)| Next::User(w, r)),
            item = urgent.recv() => return item.map_or(Next::Closed, |(w, r)| Next::User(w, r)),
            _ = tokio::time::sleep_until(until) => {}
        }
    }
    if stepping {
        match reads.try_recv() {
            Ok((w, r)) => return Next::User(w, r),
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return Next::Closed,
        }
        match urgent.try_recv() {
            Ok((w, r)) => return Next::User(w, r),
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return Next::Closed,
        }
        // The quiet work runs between the folders too: a Sent copy or a snooze coming
        // back must not wait for the whole pass (it would hold the send round up).
        return match quiet.try_recv() {
            Ok((w, r)) => Next::Quiet(w, r),
            Err(TryRecvError::Empty) => Next::Step,
            Err(TryRecvError::Disconnected) => Next::Closed,
        };
    }
    tokio::select! {
        biased;
        item = reads.recv() => item.map_or(Next::Closed, |(w, r)| Next::User(w, r)),
        item = urgent.recv() => item.map_or(Next::Closed, |(w, r)| Next::User(w, r)),
        item = quiet.recv() => item.map_or(Next::Closed, |(w, r)| Next::Quiet(w, r)),
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
    /// User actions taken out of `urgent` while gathering a move batch, in the order they
    /// were sent: they run before the queue is read again.
    deferred: VecDeque<(Work, Reply)>,
    /// A failed connect puts the mailbox out of touch until this: work gets an error at
    /// once instead of one 20 s connect after another. Wall clock: the pause runs on
    /// while the machine sleeps.
    no_network_until: Option<SystemTime>,
    /// The current pause after a failed connect, growing with each failure.
    net_backoff: Duration,
    /// When the operations connection last tried to connect: a user action past
    /// `USER_RETRY_GAP` tries again rather than waiting the pause out.
    last_net_try: Option<SystemTime>,
    /// Set when the waiting connection (IDLE) connected: proof the network is back, so the
    /// operations connection does not sit out the rest of its pause.
    net_up: Arc<AtomicBool>,
    /// Messages the offline download gave up on (their batch timed out on a slow link):
    /// they are not picked again, they load when opened.
    prefetch_failed: HashSet<i64>,
    /// `(source, target, UID)` of the moves that failed and were not done since. The same
    /// move asked again (the toast's «Retry», or after «no answer») is a resumed one: without
    /// MOVE it may have got as far as the COPY, and a plain repeat would copy the letter twice.
    unfinished_moves: HashSet<(String, String, u32)>,
    /// When the loop last ran: a wall clock ahead of the monotonic one means sleep.
    last_wall: SystemTime,
    last_mono: Instant,
}

impl Ops {
    async fn run(
        mut self,
        mut reads: mpsc::Receiver<(Work, Reply)>,
        mut urgent: mpsc::Receiver<(Work, Reply)>,
        mut quiet: mpsc::Receiver<(Work, Reply)>,
        mut background: mpsc::Receiver<Work>,
    ) {
        let mut tick = tokio::time::interval(FULL_SYNC_EVERY);
        // Ticks missed during a long pass do not bring several passes in a row.
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            match next(
                &mut reads,
                &mut urgent,
                &mut quiet,
                &mut self.deferred,
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
                    // A move gathers the moves of the same source and target waiting
                    // behind it: a held "archive" key is one `UID MOVE`, not dozens.
                    match work {
                        Work::Move {
                            from,
                            validity,
                            mut uids,
                            to,
                            mut seen,
                        } => {
                            let mut replies = vec![reply];
                            let queued = self.deferred.len();
                            drain_moves(
                                &mut urgent,
                                &mut self.deferred,
                                &from,
                                validity,
                                &to,
                                &mut uids,
                                &mut seen,
                                &mut replies,
                            );
                            // A foreign action was set aside: the series is over, settle not.
                            if self.deferred.len() == queued {
                                settle_series(&mut urgent, &mut self.deferred, &mut replies, |u, d, r| {
                                    drain_moves(u, d, &from, validity, &to, &mut uids, &mut seen, r);
                                })
                                .await;
                            }
                            let merged = Work::Move {
                                from,
                                validity,
                                uids,
                                to,
                                seen,
                            };
                            let result = self.user(&merged).await;
                            self.report(&merged, &result, true);
                            answer_all(replies, result);
                        }
                        // A held "read" or "flag" key: one `STORE` per change for the
                        // whole series, and a UID said twice ends as the last thing said.
                        Work::SetFlag {
                            folder,
                            validity,
                            mut uids,
                            change,
                        } => {
                            let mut series: Vec<(u32, FlagChange)> = uids.drain(..).map(|uid| (uid, change)).collect();
                            let mut replies = vec![reply];
                            let queued = self.deferred.len();
                            drain_flags(
                                &mut urgent,
                                &mut self.deferred,
                                &folder,
                                validity,
                                &mut series,
                                &mut replies,
                            );
                            if self.deferred.len() == queued {
                                settle_series(&mut urgent, &mut self.deferred, &mut replies, |u, d, r| {
                                    drain_flags(u, d, &folder, validity, &mut series, r);
                                })
                                .await;
                            }
                            let mut result = Ok(Output::None);
                            for (change, uids) in compact_flags(&series) {
                                let merged = Work::SetFlag {
                                    folder: folder.clone(),
                                    validity,
                                    uids,
                                    change,
                                };
                                result = self.user(&merged).await;
                                self.report(&merged, &result, true);
                                if result.is_err() {
                                    // The rest of the series is not applied either: the
                                    // caller hears why, and retries the whole thing.
                                    break;
                                }
                            }
                            answer_all(replies, result);
                        }
                        // A held label key: one request for the whole series.
                        Work::SetLabels {
                            folder,
                            validity,
                            mut uids,
                            add,
                            remove,
                        } => {
                            let mut replies = vec![reply];
                            let queued = self.deferred.len();
                            drain_labels(
                                &mut urgent,
                                &mut self.deferred,
                                &folder,
                                validity,
                                &add,
                                &remove,
                                &mut uids,
                                &mut replies,
                            );
                            if self.deferred.len() == queued {
                                settle_series(&mut urgent, &mut self.deferred, &mut replies, |u, d, r| {
                                    drain_labels(u, d, &folder, validity, &add, &remove, &mut uids, r);
                                })
                                .await;
                            }
                            let merged = Work::SetLabels {
                                folder,
                                validity,
                                uids,
                                add,
                                remove,
                            };
                            let result = self.user(&merged).await;
                            self.report(&merged, &result, true);
                            answer_all(replies, result);
                        }
                        other => {
                            let result = self.user(&other).await;
                            self.report(&other, &result, true);
                            let _ = reply.send(result);
                        }
                    }
                }
                // Background work with a caller: the same handling as a user action, only
                // queued below the user's own and behind the bodies being read.
                Next::Quiet(work, reply) => {
                    let result = self.serve(&work, false).await;
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
        // The machine slept: TCP connections are probably dead, and the next command
        // would wait out its whole watchdog before failing. Start fresh; the network
        // pause has run on while the machine was under, so it is let go too.
        if slept_since(&mut self.last_wall, &mut self.last_mono) {
            self.conn = None;
            self.no_network_until = None;
            self.net_backoff = Duration::ZERO;
        }
        let mut result = Err(Error::Closed);
        for attempt in 0..2 {
            if self.conn.is_none() {
                // The waiting connection connected successfully: the network is back, so
                // do not sit out the rest of the pause.
                if self.net_up.swap(false, Ordering::Relaxed) {
                    self.no_network_until = None;
                }
                // No network a moment ago: fail at once, do not try to connect again
                // (one 20 s connect per action is what makes an offline mailbox crawl).
                if out_of_touch(self.no_network_until, SystemTime::now()) {
                    return Err(no_network());
                }
                self.state.set_status(
                    &self.account.id,
                    AccountStatus {
                        state: "connecting",
                        error: None,
                    },
                );
                self.last_net_try = Some(SystemTime::now());
                match connect(&self.state, &self.account).await {
                    Ok(c) => {
                        self.conn = Some(c);
                        self.net_backoff = Duration::ZERO;
                        self.no_network_until = None;
                        self.last_net_try = None;
                    }
                    Err(e) => {
                        // A failure the user must fix (a wrong password) is not "no
                        // network"; a network one backs off, growing, with a ceiling.
                        if e.is_transient() && !needs_user(&e) {
                            self.net_backoff = net_backoff(self.net_backoff);
                            self.no_network_until = Some(SystemTime::now() + self.net_backoff);
                        }
                        return Err(e);
                    }
                }
            }
            let c = self.conn.as_mut().expect("connected above");
            let retry = attempt > 0 || is_unfinished(&self.unfinished_moves, &op);
            let outcome = match tokio::time::timeout(
                WORK_TIMEOUT,
                perform(
                    &self.state,
                    &self.account,
                    c,
                    op,
                    &mut self.notify_new,
                    &mut self.prefetch_failed,
                    retry,
                ),
            )
            .await
            {
                Ok(r) => r,
                // The work never finished: the connection is unusable, and a fresh login
                // would hang the same way, so it is dropped and not retried.
                Err(_) => {
                    self.conn = None;
                    note_move(&mut self.unfinished_moves, &op, false);
                    return Err(Error::Timeout("operation"));
                }
            };
            note_move(&mut self.unfinished_moves, &op, outcome.is_ok());
            match outcome {
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
                    // A server stuck on GETQUOTAROOT would be stuck again on a fresh login.
                    if !(dropped && attempt == 0) || matches!(op, Op::Work(Work::Quota)) {
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
        self.serve(work, true).await
    }

    /// Runs the work of a caller. `user_waits`: a person asked for it just now.
    async fn serve(&mut self, work: &Work, user_waits: bool) -> Result<Output> {
        // The user is waiting: a network pause is not sat out in full for them. If the
        // last connect attempt was long enough ago, try again right away.
        if lifts_net_pause(user_waits, self.last_net_try, SystemTime::now()) {
            self.no_network_until = None;
        }
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
        // The quota after the folders, as work of its own: a server stuck on it cannot
        // hold up or fail the sync.
        offer(&self.background, &self.queued, Work::Quota);
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
            // The quota is a number in the settings: not reading it is no account error, and
            // the next work logs in again if its connection was dropped.
            Err(e) if matches!(work, Work::Quota) => {
                tracing::warn!(account = %account.id, kind = e.kind(), "quota not read: {e}");
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
pub(crate) fn clone_error(e: &Error) -> Error {
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
        Error::CopyRefused(m) => Error::CopyRefused(m.clone()),
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

/// The quota once per full sync, after its folders: often enough for a warning, not on
/// every change IDLE reports. A refusal is only logged; a timeout drops the connection.
async fn refresh_quota(state: &AppState, account_id: &str, conn: &mut Conn) -> Result<()> {
    let read = match conn {
        Conn::Imap(c) => crate::server::refresh_quota(state, account_id, c).await,
        // EWS reports no limit, only the occupied space; it is counted over the folders.
        Conn::Ews(s) => crate::server::refresh_ews_quota(state, account_id, s).await,
    };
    match read {
        Err(e) if e.is_transient() => Err(e),
        Err(e) => {
            tracing::warn!(account = %account_id, "quota not read: {e}");
            Ok(())
        }
        Ok(()) => Ok(()),
    }
}

async fn perform(
    state: &AppState,
    account: &Account,
    conn: &mut Conn,
    op: Op<'_>,
    notify_new: &mut bool,
    prefetch_failed: &mut HashSet<i64>,
    retry: bool,
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
        Work::Prefetch => prefetch(state, conn, id, prefetch_failed).await,
        Work::Quota => {
            refresh_quota(state, id, conn).await?;
            Ok(Output::None)
        }
        Work::SyncFolder(folder) => Ok(Output::Count(
            sync_one(state, account, conn, folder, *notify_new).await?,
        )),
        Work::LoadBody { id: msg_id, gate } => {
            // The user has moved to another letter meanwhile: do not ask the server for a
            // body nobody is waiting on any more (#71).
            if let Some((window, seq)) = gate
                && !crate::state::open_is_current(&state.open_seq, window, *seq)
            {
                return Ok(Output::None);
            }
            Ok(Output::Body(mail::load_body(conn, store, *msg_id).await?))
        }
        Work::SetFlag {
            folder,
            validity,
            uids,
            change,
        } => {
            mail::set_flag(conn, store, id, folder, *validity, uids, *change).await?;
            Ok(Output::None)
        }
        Work::SetLabels {
            folder,
            validity,
            uids,
            add,
            remove,
        } => {
            mail::set_labels(
                conn,
                store,
                id,
                folder,
                *validity,
                uids,
                mail::LabelChange { add, remove },
            )
            .await?;
            // The keywords changed on the server: the folder's own sync brings them back.
            Ok(Output::None)
        }
        Work::FolderCount(folder) => {
            let (total, bound) = mail::folder_count(conn, store, id, folder).await?;
            Ok(Output::Counted(total, bound))
        }
        Work::EmptyFolder(req) => crate::empty::perform(state, account, conn, req).await,
        Work::FolderProps(folder) => {
            let props = mail::folder_props(conn, store, id, folder).await?;
            Ok(Output::Props(props))
        }
        Work::CheckLabels {
            folder,
            keyword,
            message_id,
            subject,
        } => {
            let check = mail::check_labels(conn, folder, keyword, message_id, subject).await?;
            Ok(Output::LabelCheck(check))
        }
        Work::StripLabel { folder, keyword } => {
            // No event per folder: `label_strip::run` sends one when the whole walk is done.
            let n = mail::strip_label(conn, store, id, folder, keyword).await?;
            Ok(Output::Count(n))
        }
        Work::RenameCategory { from, to } => {
            let key = format!("labels:{id}");
            state.task(
                &key,
                "labels",
                Some(id),
                tr!(
                    "Renaming the category on all letters",
                    "Переименование категории во всех письмах"
                ),
                0,
                0,
            );
            match mail::rename_category(conn, store, id, from, to).await {
                Ok(n) => {
                    state.task_done(&key);
                    state.emit("mail-changed", json!({ "account_id": id }));
                    Ok(Output::Count(n))
                }
                Err(e) => {
                    state.task_failed(&key, CmdError::from(clone_error(&e)));
                    Err(e)
                }
            }
        }
        Work::Move {
            from,
            validity,
            uids,
            to,
            seen,
        } => {
            // A move cut short without MOVE would copy the letters a second time on the
            // retry: finish it by looking at what already reached the target. With MOVE
            // the move is atomic, and a repeated one finds the originals gone.
            let resume = retry && matches!(conn, Conn::Imap(c) if !c.caps.move_);
            // Dealt with, so read: one store for the whole series, then one move. A flag
            // queued between the moves would split the series into one request per letter.
            // A folder that cannot store flags still moves.
            if !seen.is_empty()
                && let Err(e) = mail::set_flag(conn, store, id, from, *validity, seen, FlagChange::Seen(true)).await
            {
                tracing::debug!(account = %id, folder = %from, "seen before move: {e}");
            }
            if resume {
                mail::resume_move(conn, store, id, from, *validity, uids, to).await?;
            } else {
                mail::move_messages(conn, store, id, from, *validity, uids, to).await?;
            }
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
            // The message is on the server now: a failed sync after it is not a failed append
            // (the caller would report a copy that was made, or append it twice). It shows in
            // the cache with the folder's next sync.
            if let Err(e) = sync_one(state, account, conn, folder, false).await {
                tracing::warn!(account = %id, "sync after append to {folder} failed: {e}");
            }
            Ok(Output::None)
        }
        // The copy of a sent letter in «Sent», on its own: the send round does not wait for
        // it, and a failure is a task, not a stalled send.
        Work::CopyToSent {
            folder,
            raw,
            flags,
            message_id,
        } => {
            let key = format!("sent-copy:{id}");
            state.task(
                &key,
                "send",
                Some(id),
                tr!("Saving the copy in «Sent»", "Сохранение копии в «Отправленные»"),
                0,
                0,
            );
            match mail::append_unless_exists(conn, store, id, folder, raw, flags, message_id.as_deref()).await {
                Ok(()) => {
                    if let Err(e) = sync_one(state, account, conn, folder, false).await {
                        tracing::warn!(account = %id, "sync after the Sent copy failed: {e}");
                    }
                    state.task_done(&key);
                    Ok(Output::None)
                }
                Err(e) if e.append_refused() => {
                    // A refusal that waiting will not mend is counted by the outbox, which shows
                    // one task when the copy is put on hold; a red task per try is only noise.
                    state.task_done(&key);
                    Err(Error::CopyRefused(e.to_string()))
                }
                Err(e) => {
                    state.task_failed(&key, CmdError::from(clone_error(&e)));
                    Err(e)
                }
            }
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
            // The letters are moved: a failed sync is not a failed move. An error here would
            // cut short the caller's next run (the undo of an archive does two, read and
            // unread). The cache catches up with the next sync.
            for folder in [from, to] {
                if let Err(e) = sync_one(state, account, conn, folder, false).await {
                    tracing::warn!(account = %id, "sync of {folder} after a move by Message-ID failed: {e}");
                }
            }
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
async fn prefetch(state: &AppState, conn: &mut Conn, account_id: &str, failed: &mut HashSet<i64>) -> Result<Output> {
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
    // A batch bounded by bytes as well as by count: a short one leaves the mailbox's queue
    // free for a body somebody opens between them.
    let mut batch: Vec<(i64, String, u32)> = Vec::new();
    let mut bytes = 0u64;
    for (id, folder, uid, size) in store.bodies_missing(account_id, since, files, PREFETCH_BATCH)? {
        // A letter whose download already timed out on this slow link is not picked
        // again: it would fill every round. It loads when opened.
        if failed.contains(&id) {
            continue;
        }
        if !batch.is_empty() && bytes + u64::from(size) > PREFETCH_BYTES {
            break;
        }
        bytes += u64::from(size);
        batch.push((id, folder, uid));
    }
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
        // Marked before the fetch: if the batch times out here, the future is dropped and
        // the marks stay, so the same letters are not tried again next round. A fetch that
        // came back (saved or failed on a dropped link) clears them: only a stall sticks.
        failed.extend(messages.iter().map(|(id, _)| *id));
        match mail::prefetch_bodies(conn, store, folder, messages).await {
            Ok(n) => {
                saved += n;
                for (id, _) in messages {
                    failed.remove(id);
                }
            }
            Err(e) => {
                for (id, _) in messages {
                    failed.remove(id);
                }
                return Err(e);
            }
        }
    }
    // Done only when the count was short of the limit and the byte cap did not cut it: a
    // batch stopped at the cap has more behind it.
    let last = saved == 0 || (batch.len() < PREFETCH_BATCH as usize && bytes < PREFETCH_BYTES);
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
pub(crate) async fn sync_one(
    state: &AppState,
    account: &Account,
    conn: &mut Conn,
    folder: &str,
    notify: bool,
) -> Result<usize> {
    let id = account.id.as_str();
    let (_, before) = state.store.folder_state(id, folder)?;
    let report = mail::sync_folder(conn, &state.store, id, folder, SyncOptions::default()).await?;
    state.tray.checked();
    if report.changed() {
        state.emit("mail-changed", json!({ "account_id": id, "folder": folder }));
        // The folder's letters changed: a "waiting for a reply" of one that just arrived in
        // Sent, or an answer resolved, moves the counters. Cheap, and it also keeps badges
        // right for plugin-driven lists; the main list reload stays on `mail-changed`.
        state.emit("counters-changed", json!({}));
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
        notify_new_mail(state, &fresh);
    }
    Ok(report.added)
}

/// New letters from people (and, with «notify about all», newsletters) are told; letters
/// of all mailboxes arriving together make one notification.
fn notify_new_mail(state: &AppState, fresh: &[depesha_core::store::MessageRow]) {
    let letters = fresh.iter().map(crate::desktop_notify::Letter::new).collect();
    state.notifier.arrived(&state.app, letters);
}

/// Second connection that waits for changes in INBOX and asks the operations loop to sync.
async fn idle_loop(
    state: Arc<AppState>,
    account: Account,
    tx: mpsc::Sender<Work>,
    paused: Arc<AtomicBool>,
    queued: Queued,
    net_up: Arc<AtomicBool>,
) {
    let mut backoff = Duration::from_secs(5);
    let mut pace = IdlePace::new();
    loop {
        if paused.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        }
        let mut conn = match connect(&state, &account).await {
            Ok(c) => {
                // This connection is on the network: the operations connection need not
                // sit out the rest of its pause after a failed connect.
                net_up.store(true, Ordering::Relaxed);
                c
            }
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
        let connected = Instant::now();
        loop {
            tokio::select! {
                r = mail::wait_for_changes(conn, &state.store, &account.id, POLL_WITHOUT_IDLE, &mut pace, connected) => match r {
                    Ok((c, outcome)) => {
                        conn = c;
                        if matches!(outcome, IdleOutcome::Changed) {
                            queue(&tx, &queued, Work::SyncFolder("INBOX".into())).await;
                        }
                    }
                    Err(d) => {
                        // A link that breaks at once (a proxy cutting long answers) must not spin;
                        // a busy Exchange gets the pause it asked for. The pace learns from a
                        // server or proxy that cuts an idle link every N seconds, and keeps the
                        // log to a line per power of two of a series.
                        let wait = match &d.dropped {
                            Some(p) => {
                                log_idle_drop(&account.id, &d, p);
                                p.pause
                            }
                            None => {
                                tracing::debug!(account = %account.id, "idle dropped: {}", d.error);
                                busy_pause(d.error.back_off(), 0)
                            }
                        };
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

/// The line for a dropped subscription: the cause the server gave and both times (since the
/// last write and since the connect) say who cuts, so the first of a series and every
/// power of two after it are `warn`, the rest `debug`.
fn log_idle_drop(account: &str, d: &depesha_core::mail::IdleDrop, p: &Dropped) {
    let renew = match d.renew {
        Some(r) => format!(", renewing IDLE every {}s", r.as_secs()),
        None => String::new(),
    };
    let note = match (p.by_age, p.shortened) {
        (true, _) => "; the connection is cut by its age, not by idleness: renewal kept",
        (_, Some(_)) => "; cut after the same idle time twice: renewal shortened",
        _ => "",
    };
    let line = format!(
        "idle dropped ({}) after {}s of the wait, {}s of the connection: {} (in a row: {}{}, pause {}s){}",
        d.cause,
        d.since_wait.as_secs(),
        d.since_connect.as_secs(),
        d.error,
        p.drops,
        renew,
        p.pause.as_secs(),
        note
    );
    if p.log {
        tracing::warn!(account = %account, "{line}");
    } else {
        tracing::debug!(account = %account, "{line}");
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

    #[test]
    fn a_failed_move_asked_again_is_a_resumed_one() {
        let (work, _) = mv("INBOX", "Archive", 7);
        let mut unfinished = HashSet::new();
        assert!(
            !is_unfinished(&unfinished, &Op::Work(&work)),
            "the first try is a plain move"
        );
        note_move(&mut unfinished, &Op::Work(&work), false);
        let (again, _) = mv("INBOX", "Archive", 7);
        assert!(is_unfinished(&unfinished, &Op::Work(&again)));
        let (other, _) = mv("INBOX", "Trash", 7);
        assert!(
            !is_unfinished(&unfinished, &Op::Work(&other)),
            "another target is another move"
        );
        note_move(&mut unfinished, &Op::Work(&again), true);
        assert!(
            !is_unfinished(&unfinished, &Op::Work(&again)),
            "a move that went through is done"
        );
    }

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
        (Work::LoadBody { id, gate: None }, oneshot::channel().0)
    }

    fn loaded(next: Next) -> Option<i64> {
        match next {
            Next::User(Work::LoadBody { id, .. }, _) => Some(id),
            _ => None,
        }
    }

    async fn ticker() -> tokio::time::Interval {
        let mut tick = tokio::time::interval(FULL_SYNC_EVERY);
        tick.tick().await;
        tick
    }

    /// `next` with nothing waiting to read and nothing deferred, as most tests need.
    async fn pick(
        urgent: &mut mpsc::Receiver<(Work, Reply)>,
        background: &mut mpsc::Receiver<Work>,
        tick: &mut tokio::time::Interval,
        stepping: bool,
        busy_until: Option<tokio::time::Instant>,
    ) -> Next {
        // Kept alive for the call: a dropped sender would read as closed.
        let (_reads_tx, mut reads) = mpsc::channel(1);
        let (_quiet_tx, mut quiet) = mpsc::channel(1);
        let mut deferred = VecDeque::new();
        next(
            &mut reads,
            urgent,
            &mut quiet,
            &mut deferred,
            background,
            tick,
            stepping,
            busy_until,
        )
        .await
    }

    fn mv(from: &str, to: &str, uid: u32) -> (Work, Reply) {
        (
            Work::Move {
                from: from.into(),
                validity: 1,
                uids: vec![uid],
                to: to.into(),
                seen: Vec::new(),
            },
            oneshot::channel().0,
        )
    }

    #[tokio::test]
    async fn user_actions_go_between_the_folders_of_a_full_sync() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        let (background_tx, mut background) = mpsc::channel(8);
        let mut tick = ticker().await;
        background_tx.send(Work::SyncFolder("INBOX".into())).await.unwrap();

        // A pass under way goes on folder by folder; other background work waits for its end.
        assert!(matches!(
            pick(&mut urgent, &mut background, &mut tick, true, None).await,
            Next::Step
        ));

        // Actions sent meanwhile run before the next folder, in the order sent.
        urgent_tx.send(load(1)).await.unwrap();
        urgent_tx.send(load(2)).await.unwrap();
        assert_eq!(
            loaded(pick(&mut urgent, &mut background, &mut tick, true, None).await),
            Some(1)
        );
        assert_eq!(
            loaded(pick(&mut urgent, &mut background, &mut tick, true, None).await),
            Some(2)
        );
        assert!(matches!(
            pick(&mut urgent, &mut background, &mut tick, true, None).await,
            Next::Step
        ));

        // Without a pass, background work comes after user actions too.
        urgent_tx.send(load(3)).await.unwrap();
        assert_eq!(
            loaded(pick(&mut urgent, &mut background, &mut tick, false, None).await),
            Some(3)
        );
        assert!(matches!(
            pick(&mut urgent, &mut background, &mut tick, false, None).await,
            Next::Background(Work::SyncFolder(f)) if f == "INBOX"
        ));
    }

    #[tokio::test]
    async fn quiet_work_runs_between_the_folders_of_a_full_sync() {
        let (_reads_tx, mut reads) = mpsc::channel(8);
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        let (quiet_tx, mut quiet) = mpsc::channel(8);
        let (_background_tx, mut background) = mpsc::channel(8);
        let mut deferred = VecDeque::new();
        let mut tick = ticker().await;

        // A pass under way serves the quiet work between its folders, so a Sent copy or a
        // snooze coming back is not held up by the whole sync.
        quiet_tx.send((Work::Quota, oneshot::channel().0)).await.unwrap();
        assert!(matches!(
            next(
                &mut reads,
                &mut urgent,
                &mut quiet,
                &mut deferred,
                &mut background,
                &mut tick,
                true,
                None
            )
            .await,
            Next::Quiet(Work::Quota, _)
        ));

        // The user's action still goes ahead of it.
        urgent_tx.send(load(4)).await.unwrap();
        assert_eq!(
            loaded(
                next(
                    &mut reads,
                    &mut urgent,
                    &mut quiet,
                    &mut deferred,
                    &mut background,
                    &mut tick,
                    true,
                    None
                )
                .await
            ),
            Some(4)
        );

        // Neither waiting: the next folder.
        assert!(matches!(
            next(
                &mut reads,
                &mut urgent,
                &mut quiet,
                &mut deferred,
                &mut background,
                &mut tick,
                true,
                None
            )
            .await,
            Next::Step
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
            pick(&mut urgent, &mut background, &mut tick, false, until).await,
            Next::Background(Work::Prefetch)
        ));
        assert!(start.elapsed() >= pause);
        let start = tokio::time::Instant::now();
        let until = Some(start + pause);
        assert!(matches!(
            pick(&mut urgent, &mut background, &mut tick, true, until).await,
            Next::Step
        ));
        assert!(start.elapsed() >= pause);

        // …a user action is taken at once, to be answered with the time left.
        urgent_tx.send(load(7)).await.unwrap();
        let start = tokio::time::Instant::now();
        let until = Some(start + Duration::from_secs(60));
        assert_eq!(
            loaded(pick(&mut urgent, &mut background, &mut tick, true, until).await),
            Some(7)
        );
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn moves_of_one_source_and_target_are_one_uid_move() {
        // A held "archive" key: 50 moves of one folder into one folder, one request.
        let (urgent_tx, mut urgent) = mpsc::channel(64);
        for uid in 10..60 {
            urgent_tx.send(mv("INBOX", "Archive", uid)).await.unwrap();
        }
        let mut deferred = VecDeque::new();
        let first = urgent.recv().await.unwrap();
        let Work::Move {
            from,
            validity,
            mut uids,
            to,
            ..
        } = first.0
        else {
            panic!("not a move");
        };
        let mut replies = vec![first.1];
        let merged = drain_moves(
            &mut urgent,
            &mut deferred,
            &from,
            validity,
            &to,
            &mut uids,
            &mut Vec::new(),
            &mut replies,
        );
        assert_eq!(merged, 49, "the rest of the series is merged in");
        assert_eq!(replies.len(), 50, "every caller keeps its answer");
        assert_eq!(from, "INBOX");
        assert_eq!(to, "Archive");
        assert_eq!(validity, 1);
        assert_eq!(uids.len(), 50);
        assert_eq!(uids[0], 10);
        assert_eq!(uids[49], 59);
        assert!(deferred.is_empty());
    }

    /// Merged moves keep what each said to read: the letters of the action, not the rest.
    #[tokio::test]
    async fn merged_moves_read_only_what_they_asked_for() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        let both = |uids: Vec<u32>, seen: Vec<u32>| {
            (
                Work::Move {
                    from: "INBOX".into(),
                    validity: 1,
                    uids,
                    to: "Archive".into(),
                    seen,
                },
                oneshot::channel().0,
            )
        };
        urgent_tx.send(both(vec![2, 3], vec![3])).await.unwrap();
        let (mut uids, mut seen, mut replies) = (vec![1, 4], vec![1], vec![oneshot::channel().0]);
        let mut deferred = VecDeque::new();
        drain_moves(
            &mut urgent,
            &mut deferred,
            "INBOX",
            1,
            "Archive",
            &mut uids,
            &mut seen,
            &mut replies,
        );
        assert_eq!(uids, [1, 4, 2, 3]);
        assert_eq!(seen, [1, 3], "the unread answer of the conversation is not read");
    }

    #[tokio::test]
    async fn a_move_to_another_folder_stops_the_series() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        urgent_tx.send(mv("INBOX", "Archive", 1)).await.unwrap();
        urgent_tx.send(mv("INBOX", "Trash", 2)).await.unwrap();
        urgent_tx.send(mv("INBOX", "Archive", 3)).await.unwrap();
        let mut deferred = VecDeque::new();
        let first = urgent.recv().await.unwrap();
        let Work::Move {
            from,
            validity,
            mut uids,
            to,
            ..
        } = first.0
        else {
            panic!("not a move");
        };
        let mut replies = vec![first.1];
        drain_moves(
            &mut urgent,
            &mut deferred,
            &from,
            validity,
            &to,
            &mut uids,
            &mut Vec::new(),
            &mut replies,
        );
        // Only a continuous series is merged: the other target stops the gather, waits its
        // turn, and the later move of the same source and target keeps its place behind it.
        assert_eq!(replies.len(), 1);
        assert_eq!(uids, [1]);
        assert_eq!(deferred.len(), 1, "the move to another folder waits its turn");
        assert!(matches!(deferred[0].0, Work::Move { ref to, .. } if to == "Trash"));
        assert!(matches!(urgent.try_recv(), Ok((Work::Move { ref to, .. }, _)) if to == "Archive"));
    }

    /// The first review scenario: Move(1), SetFlag(2), Move(2). The flag stops the gather,
    /// so the second move runs after it — the store must not find uid 2 already gone.
    #[tokio::test]
    async fn a_move_series_stops_at_a_flag_of_the_same_folder() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        urgent_tx.send(mv("INBOX", "Archive", 1)).await.unwrap();
        urgent_tx.send(flag("INBOX", 2, FlagChange::Seen(true))).await.unwrap();
        urgent_tx.send(mv("INBOX", "Archive", 2)).await.unwrap();
        let mut deferred = VecDeque::new();
        let first = urgent.recv().await.unwrap();
        let Work::Move {
            from,
            validity,
            mut uids,
            to,
            ..
        } = first.0
        else {
            panic!("not a move");
        };
        let mut replies = vec![first.1];
        drain_moves(
            &mut urgent,
            &mut deferred,
            &from,
            validity,
            &to,
            &mut uids,
            &mut Vec::new(),
            &mut replies,
        );
        assert_eq!(uids, [1], "the flag stops the move series");
        assert_eq!(deferred.len(), 1);
        assert!(matches!(deferred[0].0, Work::SetFlag { ref uids, .. } if uids == &[2]));
        assert!(matches!(urgent.try_recv(), Ok((Work::Move { uids, .. }, _)) if uids == vec![2]));
    }

    /// Two moves, then a foreign action, then another move: the foreign action closes the
    /// series, so the later move is not merged ahead of it.
    #[tokio::test]
    async fn a_foreign_action_closes_the_move_series() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        urgent_tx.send(mv("INBOX", "Archive", 1)).await.unwrap();
        urgent_tx.send(mv("INBOX", "Archive", 2)).await.unwrap();
        urgent_tx.send(flag("INBOX", 3, FlagChange::Seen(true))).await.unwrap();
        urgent_tx.send(mv("INBOX", "Archive", 4)).await.unwrap();
        let mut deferred = VecDeque::new();
        let first = urgent.recv().await.unwrap();
        let Work::Move {
            from,
            validity,
            mut uids,
            to,
            ..
        } = first.0
        else {
            panic!("not a move");
        };
        let mut replies = vec![first.1];
        let queued = deferred.len();
        drain_moves(
            &mut urgent,
            &mut deferred,
            &from,
            validity,
            &to,
            &mut uids,
            &mut Vec::new(),
            &mut replies,
        );
        assert_eq!(uids, [1, 2]);
        // The caller settles only while the series stayed open; here it did not.
        assert!(deferred.len() > queued, "the flag closes the series");
        assert!(matches!(urgent.try_recv(), Ok((Work::Move { uids, .. }, _)) if uids == vec![4]));
    }

    /// A foreign action arriving while the series settles also closes it: the move behind
    /// it keeps its place.
    #[tokio::test]
    async fn settle_series_stops_at_a_foreign_action() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        urgent_tx.send(mv("INBOX", "Archive", 1)).await.unwrap();
        urgent_tx.send(mv("INBOX", "Archive", 2)).await.unwrap();
        let mut deferred = VecDeque::new();
        let first = urgent.recv().await.unwrap();
        let Work::Move {
            from,
            validity,
            mut uids,
            to,
            ..
        } = first.0
        else {
            panic!("not a move");
        };
        let mut replies = vec![first.1];
        drain_moves(
            &mut urgent,
            &mut deferred,
            &from,
            validity,
            &to,
            &mut uids,
            &mut Vec::new(),
            &mut replies,
        );
        assert_eq!(uids, [1, 2]);
        urgent_tx.send(flag("INBOX", 3, FlagChange::Seen(true))).await.unwrap();
        urgent_tx.send(mv("INBOX", "Archive", 4)).await.unwrap();
        settle_series(&mut urgent, &mut deferred, &mut replies, |u, d, r| {
            drain_moves(u, d, &from, validity, &to, &mut uids, &mut Vec::new(), r);
        })
        .await;
        assert_eq!(uids, [1, 2], "the foreign action ends the series");
        assert!(matches!(deferred[0].0, Work::SetFlag { .. }));
        assert!(matches!(urgent.try_recv(), Ok((Work::Move { uids, .. }, _)) if uids == vec![4]));
    }

    fn flag(folder: &str, uid: u32, change: FlagChange) -> (Work, Reply) {
        (
            Work::SetFlag {
                folder: folder.into(),
                validity: 1,
                uids: vec![uid],
                change,
            },
            oneshot::channel().0,
        )
    }

    #[tokio::test]
    async fn flags_of_one_folder_become_one_store_per_change() {
        // A held "read" key: 50 stores of one folder become one request.
        let (urgent_tx, mut urgent) = mpsc::channel(64);
        for uid in 10..60 {
            urgent_tx
                .send(flag("INBOX", uid, FlagChange::Seen(true)))
                .await
                .unwrap();
        }
        // A different flag of the same folder is part of the series too.
        urgent_tx
            .send(flag("INBOX", 99, FlagChange::Flagged(true)))
            .await
            .unwrap();
        let mut deferred = VecDeque::new();
        let first = urgent.recv().await.unwrap();
        let Work::SetFlag {
            folder,
            validity,
            uids,
            change,
        } = first.0
        else {
            panic!("not a flag");
        };
        let mut series: Vec<(u32, FlagChange)> = uids.into_iter().map(|uid| (uid, change)).collect();
        let mut replies = vec![first.1];
        let merged = drain_flags(&mut urgent, &mut deferred, &folder, validity, &mut series, &mut replies);
        assert_eq!(merged, 50);
        assert_eq!(replies.len(), 51);
        assert!(deferred.is_empty());
        let groups = compact_flags(&series);
        assert_eq!(groups.len(), 2, "one store per change");
        assert_eq!(groups[0].0, FlagChange::Seen(true));
        assert_eq!(groups[0].1.len(), 50);
        assert_eq!(groups[1].0, FlagChange::Flagged(true));
        assert_eq!(groups[1].1, [99]);
    }

    /// The second review scenario: Seen(1), Unseen(1), Seen(1). The last word on a UID
    /// wins, so the letter ends read, in a single store.
    #[tokio::test]
    async fn the_last_flag_of_a_uid_wins() {
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        urgent_tx.send(flag("INBOX", 1, FlagChange::Seen(true))).await.unwrap();
        urgent_tx.send(flag("INBOX", 1, FlagChange::Seen(false))).await.unwrap();
        urgent_tx.send(flag("INBOX", 1, FlagChange::Seen(true))).await.unwrap();
        let mut deferred = VecDeque::new();
        let first = urgent.recv().await.unwrap();
        let Work::SetFlag {
            folder,
            validity,
            uids,
            change,
        } = first.0
        else {
            panic!("not a flag");
        };
        let mut series: Vec<(u32, FlagChange)> = uids.into_iter().map(|uid| (uid, change)).collect();
        let mut replies = vec![first.1];
        drain_flags(&mut urgent, &mut deferred, &folder, validity, &mut series, &mut replies);
        assert_eq!(replies.len(), 3, "every caller keeps its answer");
        assert_eq!(compact_flags(&series), [(FlagChange::Seen(true), vec![1])]);
    }

    #[test]
    fn quiet_work_does_not_lift_the_network_pause() {
        let now = SystemTime::now();
        let long_ago = Some(now - USER_RETRY_GAP * 2);
        assert!(lifts_net_pause(true, long_ago, now));
        assert!(!lifts_net_pause(false, long_ago, now));
        assert!(!lifts_net_pause(false, None, now));
    }

    /// Seen and Flagged on one UID are two flags: the last word on one does not cancel the other.
    #[test]
    fn two_flags_of_a_uid_are_both_kept() {
        let series = [(1, FlagChange::Seen(true)), (1, FlagChange::Flagged(true))];
        assert_eq!(
            compact_flags(&series),
            [(FlagChange::Seen(true), vec![1]), (FlagChange::Flagged(true), vec![1])]
        );
    }

    #[tokio::test]
    async fn labels_of_one_folder_and_set_are_one_request() {
        let label = depesha_core::acl::Label {
            name: "Работа".into(),
            keyword: "depesha-rabota".into(),
            color: String::new(),
            stripping: false,
        };
        let (urgent_tx, mut urgent) = mpsc::channel(64);
        for uid in 10..40 {
            urgent_tx
                .send((
                    Work::SetLabels {
                        folder: "INBOX".into(),
                        validity: 1,
                        uids: vec![uid],
                        add: vec![label.clone()],
                        remove: Vec::new(),
                    },
                    oneshot::channel().0,
                ))
                .await
                .unwrap();
        }
        let mut deferred = VecDeque::new();
        let first = urgent.recv().await.unwrap();
        let Work::SetLabels {
            folder,
            validity,
            mut uids,
            add,
            remove,
        } = first.0
        else {
            panic!("not labels");
        };
        let mut replies = vec![first.1];
        let merged = drain_labels(
            &mut urgent,
            &mut deferred,
            &folder,
            validity,
            &add,
            &remove,
            &mut uids,
            &mut replies,
        );
        assert_eq!(merged, 29);
        assert_eq!(uids.len(), 30);
        assert_eq!(replies.len(), 30);
        assert!(deferred.is_empty());
    }

    #[tokio::test]
    async fn a_body_read_goes_before_queued_moves() {
        let (reads_tx, mut reads) = mpsc::channel(8);
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        let (_quiet_tx, mut quiet) = mpsc::channel(8);
        let (_background_tx, mut background) = mpsc::channel(8);
        let mut deferred = VecDeque::new();
        let mut tick = ticker().await;
        for uid in 0..3 {
            urgent_tx.send(mv("INBOX", "Archive", uid)).await.unwrap();
        }
        reads_tx.send(load(42)).await.unwrap();
        // Opening a letter jumps ahead of the archives waiting to run.
        assert_eq!(
            loaded(
                next(
                    &mut reads,
                    &mut urgent,
                    &mut quiet,
                    &mut deferred,
                    &mut background,
                    &mut tick,
                    false,
                    None
                )
                .await
            ),
            Some(42)
        );
        // Then the moves are taken in the order they were sent.
        assert!(matches!(
            next(
                &mut reads,
                &mut urgent,
                &mut quiet,
                &mut deferred,
                &mut background,
                &mut tick,
                false,
                None
            )
            .await,
            Next::User(Work::Move { .. }, _)
        ));
    }

    #[tokio::test]
    async fn deferred_actions_run_before_the_queue() {
        let (reads_tx, mut reads) = mpsc::channel(8);
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        let (_quiet_tx, mut quiet) = mpsc::channel(8);
        let (_background_tx, mut background) = mpsc::channel(8);
        let mut tick = ticker().await;
        // A body read taken out while gathering a batch runs before anything else.
        let mut deferred = VecDeque::new();
        deferred.push_back(load(7));
        reads_tx.send(load(8)).await.unwrap();
        urgent_tx.send(mv("INBOX", "Archive", 1)).await.unwrap();
        assert_eq!(
            loaded(
                next(
                    &mut reads,
                    &mut urgent,
                    &mut quiet,
                    &mut deferred,
                    &mut background,
                    &mut tick,
                    false,
                    None
                )
                .await
            ),
            Some(7)
        );
    }

    #[tokio::test]
    async fn quiet_work_waits_behind_the_users_actions() {
        let (reads_tx, mut reads) = mpsc::channel(8);
        let (urgent_tx, mut urgent) = mpsc::channel(8);
        let (quiet_tx, mut quiet) = mpsc::channel(8);
        let (_background_tx, mut background) = mpsc::channel(8);
        let mut deferred = VecDeque::new();
        let mut tick = ticker().await;
        quiet_tx.send((Work::Quota, oneshot::channel().0)).await.unwrap();
        urgent_tx.send(mv("INBOX", "Archive", 1)).await.unwrap();
        // The user's move goes first; the quiet work after it.
        assert!(matches!(
            next(
                &mut reads,
                &mut urgent,
                &mut quiet,
                &mut deferred,
                &mut background,
                &mut tick,
                false,
                None
            )
            .await,
            Next::User(Work::Move { .. }, _)
        ));
        assert!(matches!(
            next(
                &mut reads,
                &mut urgent,
                &mut quiet,
                &mut deferred,
                &mut background,
                &mut tick,
                false,
                None
            )
            .await,
            Next::Quiet(Work::Quota, _)
        ));
        // And a body somebody is opening goes before the quiet work too.
        reads_tx.send(load(5)).await.unwrap();
        quiet_tx.send((Work::Quota, oneshot::channel().0)).await.unwrap();
        assert_eq!(
            loaded(
                next(
                    &mut reads,
                    &mut urgent,
                    &mut quiet,
                    &mut deferred,
                    &mut background,
                    &mut tick,
                    false,
                    None
                )
                .await
            ),
            Some(5)
        );
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

    #[test]
    fn a_failed_connect_backs_off_with_a_ceiling() {
        let mut pause = Duration::ZERO;
        pause = net_backoff(pause);
        assert_eq!(pause, NET_BACKOFF);
        pause = net_backoff(pause);
        assert_eq!(pause, NET_BACKOFF * 2);
        for _ in 0..20 {
            pause = net_backoff(pause);
        }
        assert_eq!(pause, NET_BACKOFF_MAX);
        // 30 actions in the pause wait no time at all: not 30 × the 20 s connect.
        assert!(NET_BACKOFF_MAX < Duration::from_secs(30) * 30);
    }

    #[test]
    fn work_is_refused_at_once_while_the_network_is_down() {
        let now = SystemTime::now();
        assert!(out_of_touch(Some(now + Duration::from_secs(5)), now));
        // The pause over, or never set: connecting is tried again.
        assert!(!out_of_touch(Some(now), now));
        assert!(!out_of_touch(None, now));
    }

    #[test]
    fn a_user_action_tries_again_after_the_pause() {
        let now = SystemTime::now();
        // Never tried, or long ago: a waiting user is a reason to connect.
        assert!(may_retry_now(None, now));
        assert!(may_retry_now(Some(now - USER_RETRY_GAP), now));
        // A very fresh attempt is not repeated: it is probably still in flight.
        assert!(!may_retry_now(Some(now), now));
        assert!(!may_retry_now(Some(now - Duration::from_secs(1)), now));
    }

    #[test]
    fn a_wall_clock_jump_is_sleep() {
        let mut wall = SystemTime::now();
        let mut mono = Instant::now();
        assert!(!slept_since(&mut wall, &mut mono));
        // The machine slept: the wall clock is a minute ahead, the monotonic one is not.
        wall -= Duration::from_secs(60);
        assert!(slept_since(&mut wall, &mut mono));
        // Right after, no.
        assert!(!slept_since(&mut wall, &mut mono));
    }
}
