//! What an answer does after it leaves (#55, #59, #106): the letter answered or forwarded is
//! marked at once, and an answer to a letter of the inbox takes its conversation to the folder
//! "Waiting for reply" until the reply brings it back, or to the archive. The state of a wait
//! (its time, stopping it, the undo of a stop) is the store's (`store::waiting`); here are the
//! decisions and the moves they ask of the mailbox's queue (`port::MailQueue`). The app only
//! shows the outcomes. The clock is the caller's: the rules take `now`.

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::Result;
use crate::account::Account;
use crate::domain::{Act, Draft, FlagChange, FolderRole};
use crate::lang::pick;
use crate::port::{MailQueue, Move};
use crate::store::{Followup, FollowupPlan, OutboxItem, ParkJob, Parking, Store, WaitFolder, moves, waiting_folder};

/// Letters still in the inbox this long after the answer, the server out of reach all the
/// while, stay there: the user is told.
pub const GIVE_UP_SECS: i64 = 3_600;

/// A move that has been failing since `since` is given up at `now`: the letters stay where
/// they are and the user is told.
pub fn gives_up(since: i64, now: i64) -> bool {
    now - since >= GIVE_UP_SECS
}

fn bare(id: &str) -> &str {
    id.trim_matches(['<', '>'])
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Folders a server refused to make, by mailbox: not tried again, and the user is not told
/// again, until another folder is chosen.
#[derive(Default)]
pub struct Refused(Mutex<HashSet<(String, String)>>);

impl Refused {
    fn contains(&self, account_id: &str, folder: &str) -> bool {
        lock(&self.0).contains(&(account_id.to_owned(), folder.to_owned()))
    }

    fn insert(&self, account_id: &str, folder: &str) {
        lock(&self.0).insert((account_id.to_owned(), folder.to_owned()));
    }
}

/// Archivals of answered letters under way (#106), by mailbox and conversation. They run apart
/// from the outbox's round, so a wait must neither take a conversation before its archival is
/// done (the move to the archive would take the letters out from under the move to the folder,
/// #109) nor wait for any other archival of the mailbox.
#[derive(Default)]
pub struct Archivals {
    list: Mutex<Vec<Running>>,
    next: AtomicU64,
}

struct Running {
    id: u64,
    account_id: String,
    /// The letter answered, whose conversation the archival takes.
    anchor: String,
    /// The Message-IDs it moved; known once the move is done. What it took stays marked in
    /// the cache (`archived_mark`), this is only for the wait that comes while it runs.
    chain: Vec<String>,
}

impl Archivals {
    /// An archival of the conversation of `anchor` begins; it is over when the guard is
    /// dropped, however its task ends.
    pub fn begin(self: &Arc<Self>, account_id: &str, anchor: &str) -> Archival {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        lock(&self.list).push(Running {
            id,
            account_id: account_id.to_owned(),
            anchor: bare(anchor).to_owned(),
            chain: Vec::new(),
        });
        Archival {
            archivals: self.clone(),
            id,
        }
    }

    /// Whether an archival under way takes the conversation of `anchor`, whose letters in
    /// the inbox are `inbox_chain`. An archival of another conversation does not count.
    fn busy_with(&self, account_id: &str, anchor: &str, inbox_chain: &[String]) -> bool {
        let anchor = bare(anchor);
        lock(&self.list).iter().any(|a| {
            a.account_id == account_id
                && (a.anchor == anchor
                    || a.chain.iter().any(|m| m == anchor)
                    || inbox_chain.iter().any(|m| bare(m) == a.anchor))
        })
    }
}

/// An archival under way.
pub struct Archival {
    archivals: Arc<Archivals>,
    id: u64,
}

impl Archival {
    /// The archival moved these letters to the archive.
    fn moved(&self, chain: &[String]) {
        if let Some(a) = lock(&self.archivals.list).iter_mut().find(|a| a.id == self.id) {
            a.chain = chain.iter().map(|m| bare(m).to_owned()).collect();
        }
    }
}

impl Drop for Archival {
    fn drop(&mut self) {
        lock(&self.archivals.list).retain(|a| a.id != self.id);
    }
}

/// What a wait finds when its move comes.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    /// The archival of its conversation is still going: the move is put off.
    Later,
    /// The conversation is nowhere to take.
    Nothing,
    Take(Parking),
}

/// The letters a wait takes: the conversation of the letter answered, where it sits when the
/// move comes (#109). In the inbox as a rule, and also after the user's "Undo" of an
/// archival. In the archive only when the archival of an answer took it there: what the user
/// archived by hand stays. While the archival of this conversation is under way the wait waits
/// (`may_wait`), and other archivals of the mailbox do not hold it.
pub fn find_parking(
    store: &Store,
    archivals: &Archivals,
    account_id: &str,
    inbox: &str,
    archive: Option<&str>,
    anchor: &str,
    may_wait: bool,
) -> Result<Found> {
    let chain = store.inbox_chain(account_id, inbox, anchor)?;
    if may_wait && archivals.busy_with(account_id, anchor, &chain) {
        return Ok(Found::Later);
    }
    if !chain.is_empty() {
        return Ok(Found::Take(Parking {
            from: inbox.to_owned(),
            chain,
        }));
    }
    let Some(archive) = archive.filter(|_| store.archived_marked(account_id, anchor).unwrap_or(false)) else {
        return Ok(Found::Nothing);
    };
    let chain = store.inbox_chain(account_id, archive, anchor)?;
    Ok(if chain.is_empty() {
        Found::Nothing
    } else {
        Found::Take(Parking {
            from: archive.to_owned(),
            chain,
        })
    })
}

/// What an answer about to be queued does with its letter (#106): `(park, archive)`. A wait
/// chosen takes it to the folder "Waiting for reply"; with none, the compose window's
/// choice or the mailbox's setting takes it to the archive; only for a letter of the inbox.
pub fn decide(
    store: &Store,
    account: &Account,
    draft: &Draft,
    followup_secs: i64,
    plan: &FollowupPlan,
) -> Result<(bool, bool)> {
    let inbox = store.folder_by_role(&account.id, FolderRole::Inbox)?;
    Ok(moves(
        draft.acts_on.as_ref(),
        plan,
        followup_secs,
        &account.id,
        &account.waiting,
        inbox.as_deref(),
    ))
}

/// Whether the outbox item will take its letter to wait once it leaves: the "sent" toast
/// waits for the move then. A wait must be chosen: an item queued before #106 with the
/// folder asked for and no reminder only archives.
pub fn will_park(item: &OutboxItem) -> bool {
    item.followup.park == Some(true)
        && item.followup.waits(item.followup_secs)
        && item.draft.acts_on.as_ref().is_some_and(|a| a.act.answers())
}

/// Whether the outbox item will take its letter to the archive once it leaves (#106): a
/// wait chosen goes before it.
pub fn will_archive(item: &OutboxItem) -> bool {
    let archive =
        item.followup.archive == Some(true) || (item.followup.archive.is_none() && item.followup.park == Some(true));
    archive && !item.followup.waits(item.followup_secs) && item.draft.acts_on.as_ref().is_some_and(|a| a.act.answers())
}

/// What `record_sent` leaves for the caller to do.
pub struct Sent {
    /// The lists' counters are to be read again.
    pub counters: bool,
    /// Letters were put to wait in the folder: the scheduler is to wake and move them.
    pub parks: bool,
    /// The folder whose letters the server was asked to mark: the lists are to be read again.
    pub marked: Option<String>,
    /// The conversation goes to the archive: the task is the caller's, and the guard is
    /// counted already, so a wait that follows at once sees it.
    pub archive: Option<Archiving>,
}

pub struct Archiving {
    pub folder: String,
    pub message_id: String,
    pub guard: Archival,
}

/// The letter `item` answered or forwarded, marked now that it left as `message_id`; the
/// wait it asked for started. `letter_cached`: the letter is in the cache, which a reminder
/// needs. `queue`: the mailbox's, to ask the server for the mark; none when it is not running
/// (the mark Depesha keeps does not depend on the server's, a refusal is only not seen).
#[allow(clippy::too_many_arguments)]
pub async fn record_sent<Q: MailQueue>(
    store: &Store,
    queue: Option<&mut Q>,
    archivals: &Arc<Archivals>,
    account: &Account,
    item: &OutboxItem,
    message_id: Option<String>,
    letter_cached: bool,
    now: i64,
) -> Result<Sent> {
    let mut sent = Sent {
        counters: false,
        parks: false,
        marked: None,
        archive: None,
    };
    let acts = item.draft.acts_on.as_ref().filter(|a| a.account_id == account.id);
    let reminder = item.followup_secs > 0 && letter_cached;
    let Some(message_id) = message_id else {
        return Ok(sent);
    };
    let wait = |due_secs: i64| {
        Followup::after_sending(
            &account.id,
            message_id.clone(),
            &item.draft,
            now,
            due_secs,
            &item.followup,
        )
    };
    let Some(acts) = acts else {
        // A new letter: a reminder, as before.
        if reminder {
            store.followup_add_once(&wait(item.followup_secs))?;
            sent.counters = true;
        }
        return Ok(sent);
    };
    store.mark_done(&account.id, &acts.message_id, acts.act, now, Some(&message_id))?;
    sent.marked = mark_on_server(store, queue, &account.id, &acts.folder, &acts.message_id, acts.act).await;

    // The conversation is found when the scheduler's move comes, not now: an archival of an
    // earlier answer may be taking it just now, and the send does not wait for it (#109).
    let inbox = store.folder_by_role(&account.id, FolderRole::Inbox)?;
    let park = if will_park(item) {
        inbox.clone().filter(|i| *i == acts.folder).map(|from| Parking {
            from,
            chain: Vec::new(),
        })
    } else {
        None
    };
    let f = if reminder {
        wait(item.followup_secs)
    } else {
        Followup {
            due: 0,
            deadline: 0,
            ..wait(0)
        }
    };
    sent.parks = park.is_some();
    if store.followup_start(&f, Some(&acts.message_id), park.as_ref())? {
        sent.counters = true;
    }
    // The move to the archive waits for the mailbox's queue behind background loads and syncs
    // of two folders: it must not hold the outbox's round, and the next letters' sending, up
    // (#106). "Sent" was said when the letter left; the move adds a toast of its own when
    // something moved.
    if will_archive(item) && inbox.is_some_and(|i| i == acts.folder) {
        sent.archive = Some(Archiving {
            folder: acts.folder.clone(),
            message_id: acts.message_id.clone(),
            guard: archivals.begin(&account.id, &acts.message_id),
        });
    }
    Ok(sent)
}

/// The server's flag for what was done: `\Answered` and `$Forwarded`, Exchange's verb.
/// The folder to read again, when the server was asked.
async fn mark_on_server<Q: MailQueue>(
    store: &Store,
    queue: Option<&mut Q>,
    account_id: &str,
    folder: &str,
    message_id: &str,
    act: Act,
) -> Option<String> {
    let change = match act {
        Act::Reply => FlagChange::Answered(true),
        Act::ReplyAll => FlagChange::AnsweredAll(true),
        Act::Forward => FlagChange::Forwarded(true),
    };
    let found = store
        .find_by_message_id(account_id, folder, message_id)
        .ok()
        .flatten()
        .and_then(|r| store.get_at(r.id).ok().flatten());
    let ((row, validity), queue) = found.zip(queue)?;
    // A refusal is the server's: the mark Depesha keeps stands.
    let _ = queue.set_flag(&row.folder, validity, &[row.uid], change).await;
    Some(row.folder)
}

/// What came of taking the conversation of an answer to the folder.
#[derive(Debug)]
pub enum Taken {
    /// Not now: the archival of its conversation is under way, or the server is out of reach
    /// and has been for less than `GIVE_UP_SECS`. The job stays.
    Later,
    /// The letters left the inbox meanwhile: nothing waits in the folder.
    Vanished,
    /// Told once already that the folder cannot be made: the letters stay in the inbox quietly.
    Quiet,
    /// Moved elsewhere meanwhile: nothing waits in the folder.
    Elsewhere,
    /// The letters stay in the inbox and the user is told. `refused`: the server will not make
    /// the folder (and is not asked again); else it was out of reach too long.
    Failed {
        refused: bool,
        folder: String,
        error: Option<crate::Error>,
    },
    Parked {
        folder: String,
    },
}

/// Takes the conversation of an answer from where it sits to the folder the mailbox waits in,
/// making the folder when there is none. The state of the wait follows what came of it.
pub async fn take_in<Q: MailQueue>(
    store: &Store,
    queue: &mut Q,
    archivals: &Archivals,
    refused: &Refused,
    account: &Account,
    job: &ParkJob,
    now: i64,
) -> Result<Taken> {
    // The conversation is found now (#109): a wait put off for the archival of its own
    // conversation comes round again; one made before that carries its letters already.
    let (from, message_ids) = if job.message_ids.is_empty() {
        let archive = store.folder_by_role(&account.id, FolderRole::Archive)?;
        let found = find_parking(
            store,
            archivals,
            &account.id,
            &job.from,
            archive.as_deref(),
            &job.anchor,
            now - job.since < GIVE_UP_SECS,
        )?;
        match found {
            Found::Later => return Ok(Taken::Later),
            Found::Nothing => {
                store.followup_park_failed(&job.account_id, &job.key)?;
                return Ok(Taken::Vanished);
            }
            Found::Take(park) => {
                store.followup_park_plan(&job.account_id, &job.key, &park)?;
                (park.from, park.chain)
            }
        }
    } else {
        (job.from.clone(), job.message_ids.clone())
    };
    let fail = |refused: bool, folder: &str, error: Option<crate::Error>| -> Result<Taken> {
        store.followup_park_failed(&job.account_id, &job.key)?;
        Ok(Taken::Failed {
            refused,
            folder: folder.to_owned(),
            error,
        })
    };
    let default = pick("Waiting for reply", "Ждут ответа");
    let folders: Vec<(String, String)> = store
        .folders(Some(&account.id))?
        .into_iter()
        .map(|f| (f.folder.name, f.folder.display_name))
        .collect();
    let folder = match waiting_folder(&account.waiting.folder, default, &folders) {
        WaitFolder::Existing(name) => name,
        WaitFolder::Create(name) => {
            if refused.contains(&account.id, &name) {
                store.followup_park_failed(&job.account_id, &job.key)?;
                return Ok(Taken::Quiet);
            }
            match queue.create_folder(&name).await {
                Ok(()) => {}
                Err(e) if e.is_transient() && now - job.since < GIVE_UP_SECS => return Ok(Taken::Later),
                Err(e) if e.is_transient() => return fail(false, &name, Some(e)),
                Err(_) => {
                    refused.insert(&account.id, &name);
                    return fail(true, &name, None);
                }
            }
            let made = store
                .folders(Some(&account.id))?
                .into_iter()
                .find(|f| f.folder.display_name == name || f.folder.name == name);
            match made {
                Some(f) => f.folder.name,
                None => return fail(true, &name, None),
            }
        }
    };
    let moved = queue
        .move_by_message_id(Move {
            from,
            message_ids,
            to: folder.clone(),
            unseen: false,
        })
        .await;
    match moved {
        Ok(0) => {
            store.followup_park_failed(&job.account_id, &job.key)?;
            Ok(Taken::Elsewhere)
        }
        Ok(_) => {
            store.followup_parked(&job.account_id, &job.key, &folder)?;
            Ok(Taken::Parked { folder })
        }
        Err(e) if e.is_transient() && now - job.since < GIVE_UP_SECS => Ok(Taken::Later),
        Err(e) => fail(false, &folder, Some(e)),
    }
}

/// What came of bringing the letters of a wait back.
#[derive(Debug)]
pub enum Brought {
    /// Moved, or none found (moved elsewhere by hand): nothing is left to bring.
    Back,
    /// Offline, paused, refused login, busy server, folder locked, a limit, or any other
    /// refusal: the next round tries again, but not for ever — a pause or a wrong password
    /// must not lose the letters at once, nor be retried in silence for days.
    Retry(crate::Error),
    /// Failing for `GIVE_UP_SECS`: the letters stay where they are and the user is told.
    GaveUp(crate::Error),
}

/// Brings the letters of a wait back: the reply came, or the user stopped waiting.
pub async fn bring_back<Q: MailQueue>(store: &Store, queue: &mut Q, job: &ParkJob, now: i64) -> Result<Brought> {
    let moved = queue
        .move_by_message_id(Move {
            from: job.from.clone(),
            message_ids: job.message_ids.clone(),
            to: job.to.clone(),
            unseen: false,
        })
        .await;
    match moved {
        Ok(_) => {
            store.followup_moved_back(&job.account_id, &job.key)?;
            Ok(Brought::Back)
        }
        Err(e) if !gives_up(job.since, now) => Ok(Brought::Retry(e)),
        Err(e) => {
            store.followup_return_failed(&job.account_id, &job.key)?;
            Ok(Brought::GaveUp(e))
        }
    }
}

/// The jobs waits owe, by mailbox: one that hangs or is offline must not hold the others'
/// letters up. A job held back (the rest of a chain whose one letter was taken out waits out
/// the undo toast before it goes back: an undo in the meantime finds it still in the folder,
/// `UNDO_SECS` in the store) is not due yet, and not lost.
pub fn jobs_due(store: &Store, now: i64) -> Result<BTreeMap<String, Vec<ParkJob>>> {
    let mut by_account: BTreeMap<String, Vec<ParkJob>> = BTreeMap::new();
    for job in store.park_jobs()? {
        if job.since <= now {
            by_account.entry(job.account_id.clone()).or_default().push(job);
        }
    }
    Ok(by_account)
}

/// What came of taking the conversation of an answer to the archive.
#[derive(Debug)]
pub enum Archived {
    /// The mailbox has no archive folder: nothing is created behind the user's back.
    NoArchive,
    /// The conversation was not read.
    NotRead(crate::Error),
    /// No letter was found to move.
    NothingFound,
    /// Moved; the mark that tells a wait to take it from the archive may have failed.
    Moved {
        archive: String,
        chain: Vec<String>,
        not_marked: Option<crate::Error>,
    },
    Failed(crate::Error),
}

/// The conversation of the letter answered goes from the inbox to the archive of the mailbox,
/// as the command "Archive" does it (#106). A mailbox without an archive folder keeps the
/// letter. What it took is marked (`archived_mark`), so a wait can take it from the archive.
pub async fn archive_answered<Q: MailQueue>(
    store: &Store,
    queue: &mut Q,
    account_id: &str,
    from: &str,
    message_id: &str,
    guard: &Archival,
    now: i64,
) -> Archived {
    let Ok(Some(archive)) = store.folder_by_role(account_id, FolderRole::Archive) else {
        return Archived::NoArchive;
    };
    let mut chain = match store.inbox_chain(account_id, from, message_id) {
        Ok(chain) => chain,
        Err(e) => return Archived::NotRead(e),
    };
    if chain.is_empty() {
        chain.push(message_id.to_owned());
    }
    let moved = queue
        .move_by_message_id(Move {
            from: from.to_owned(),
            message_ids: chain.clone(),
            to: archive.clone(),
            unseen: false,
        })
        .await;
    match moved {
        Ok(0) => Archived::NothingFound,
        Ok(_) => {
            guard.moved(&chain);
            let not_marked = store.archived_mark(account_id, &chain, now).err();
            Archived::Moved {
                archive,
                chain,
                not_marked,
            }
        }
        Err(e) => Archived::Failed(e),
    }
}

/// Where "Stop waiting" takes letters waiting in the folder: the archive when the mailbox
/// says so (`to_archive`) and has one, the inbox otherwise (`None`).
pub fn stop_to(store: &Store, account_id: &str, to_archive: bool) -> Option<String> {
    if !to_archive {
        return None;
    }
    store.folder_by_role(account_id, FolderRole::Archive).ok().flatten()
}

/// The shortest postponement of a reminder.
const POSTPONE_MIN_SECS: i64 = 60;

/// No answer yet and not now: the reminder comes again `secs` from `now`, at least a minute.
/// With `deadline` ("Set a new date", "Wait for a reply again") the answer is expected by then
/// too, and a wait that ended is waiting again for an answer from now on. Answers the new time.
pub fn postpone(
    store: &Store,
    account_id: &str,
    message_id: Option<&str>,
    now: i64,
    secs: i64,
    deadline: bool,
) -> Result<i64> {
    let due = now + secs.max(POSTPONE_MIN_SECS);
    if let Some(mid) = message_id {
        store.followup_postpone(account_id, mid, due, deadline)?;
        if deadline {
            store.followup_reopen(account_id, mid, due, now)?;
        }
    }
    Ok(due)
}

/// Stops waiting for an answer: the wait is closed by hand and kept in the history. Answers the
/// moment it was closed at, which the undo of the stop takes (`Store::followup_resume`); none
/// when no wait was waiting (it ended meanwhile): there is nothing to tell or to take back.
pub fn stop(
    store: &Store,
    account_id: &str,
    to_archive: bool,
    message_id: Option<&str>,
    now: i64,
) -> Result<Option<i64>> {
    let stopped = match message_id {
        Some(mid) => {
            let to = stop_to(store, account_id, to_archive);
            store.followup_stop_undoable(account_id, mid, now, to.as_deref())?
        }
        None => false,
    };
    Ok(stopped.then_some(now))
}

/// Days a closed wait is kept, as the "Reminders" plugin's settings say; the default when they
/// say nothing usable. At least a day: zero would forget an answer the moment it came.
pub fn keep_days(plugin_settings: &BTreeMap<String, serde_json::Value>) -> u32 {
    plugin_settings
        .get("followups")
        .and_then(|s| s.get("keep_days"))
        .and_then(serde_json::Value::as_u64)
        .map_or(crate::store::DEFAULT_KEEP_DAYS, |d| d.clamp(1, 3650) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Error;
    use crate::account::{Security, ServerConfig, Waiting};
    use crate::domain::{ActsOn, Folder};
    use crate::message::Summary;
    use crate::port::fake::Queue;
    use crate::store::{NewMessage, ParkKind};

    fn plain(name: &str, role: Option<FolderRole>) -> Folder {
        Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: Some("/".into()),
            role,
            selectable: true,
            hidden: false,
        }
    }

    /// A mailbox with an inbox, an archive and a folder to wait in.
    fn store() -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders(
                "a",
                &[
                    plain("INBOX", Some(FolderRole::Inbox)),
                    plain("Archive", Some(FolderRole::Archive)),
                    plain("Wait", None),
                ],
            )
            .unwrap();
        store
    }

    fn letter(store: &Store, folder: &str, uid: u32, mid: &str) {
        let s = Summary {
            message_id: Some(mid.into()),
            date: Some(1),
            ..Default::default()
        };
        let msg = NewMessage {
            uid,
            summary: &s,
            fallback_date: 0,
            size: 1,
            flags: Default::default(),
            keywords: Vec::new(),
        };
        store.insert_message("a", folder, &msg).unwrap();
    }

    fn account(waiting: Waiting) -> Account {
        Account {
            id: "a".into(),
            label: String::new(),
            color: String::new(),
            display_name: String::new(),
            email: "me@x".into(),
            username: "me@x".into(),
            imap: ServerConfig::new("imap.x", 993, Security::Tls),
            smtp: ServerConfig::new("smtp.x", 465, Security::Tls),
            save_sent_copy: true,
            signature: String::new(),
            signatures: Vec::new(),
            default_signature: None,
            reply_signature: None,
            compose_format: None,
            letter_view: None,
            attachments_dir: String::new(),
            auth: Default::default(),
            ews: None,
            quota_warn: true,
            quota_limit_mb: 0,
            waiting,
        }
    }

    /// The waiting folder is the one the mailbox names.
    fn waits_in_wait() -> Account {
        account(Waiting {
            park: true,
            folder: "Wait".into(),
            stop_to_archive: false,
        })
    }

    fn answer(secs: i64, plan: FollowupPlan) -> OutboxItem {
        OutboxItem {
            id: 1,
            account_id: "a".into(),
            draft: Draft {
                acts_on: Some(ActsOn {
                    account_id: "a".into(),
                    folder: "INBOX".into(),
                    message_id: "q@x".into(),
                    act: Act::Reply,
                    waiting: false,
                }),
                ..Draft::default()
            },
            attempts: 0,
            next_attempt: 0,
            last_error: None,
            failed: false,
            sending_started: 0,
            created: 0,
            followup_secs: secs,
            followup: plan,
        }
    }

    fn parks() -> OutboxItem {
        answer(
            86_400,
            FollowupPlan {
                park: Some(true),
                ..Default::default()
            },
        )
    }

    /// An answer sent at `now` whose letter waits in the folder: the job to take it in is the
    /// store's.
    async fn sent_to_wait(store: &Store, now: i64) -> ParkJob {
        letter(store, "INBOX", 1, "q@x");
        let mut queue = Queue::default();
        let sent = record_sent(
            store,
            Some(&mut queue),
            &Arc::default(),
            &waits_in_wait(),
            &parks(),
            Some("<s@x>".into()),
            true,
            now,
        )
        .await
        .unwrap();
        assert!(sent.parks);
        store.park_jobs().unwrap().remove(0)
    }

    fn take(from: &str, chain: &[&str]) -> Found {
        Found::Take(Parking {
            from: from.to_owned(),
            chain: chain.iter().map(|m| (*m).to_owned()).collect(),
        })
    }

    fn found(store: &Store, archivals: &Archivals, anchor: &str, may_wait: bool) -> Found {
        find_parking(store, archivals, "a", "INBOX", Some("Archive"), anchor, may_wait).unwrap()
    }

    #[test]
    fn without_a_wait_the_letter_is_archived_not_parked() {
        // «No reminder» with the box ticked: an old item (park only) and a new one.
        let old = answer(
            0,
            FollowupPlan {
                park: Some(true),
                ..Default::default()
            },
        );
        assert!(!will_park(&old));
        assert!(will_archive(&old));
        let new = answer(
            0,
            FollowupPlan {
                park: Some(false),
                archive: Some(true),
                ..Default::default()
            },
        );
        assert!(!will_park(&new));
        assert!(will_archive(&new));
        // A wait chosen: the folder, and no archive.
        let waits = parks();
        assert!(will_park(&waits));
        assert!(!will_archive(&waits));
        let by_deadline = answer(
            0,
            FollowupPlan {
                park: Some(true),
                deadline_secs: 3_600,
                ..Default::default()
            },
        );
        assert!(will_park(&by_deadline));
        assert!(!will_archive(&by_deadline));
        // The box off: neither.
        let off = answer(
            0,
            FollowupPlan {
                park: Some(false),
                archive: Some(false),
                ..Default::default()
            },
        );
        assert!(!will_park(&off) && !will_archive(&off));
    }

    /// A wait takes a conversation from the archive only when the archival of an answer put it
    /// there; what the user archived himself stays, and an "Undo" of the archival puts the
    /// conversation back in the inbox, where the wait takes it from and returns it to (#109).
    #[test]
    fn a_wait_takes_from_the_archive_only_what_an_archival_took() {
        let store = store();
        let reg = Archivals::default();
        letter(&store, "INBOX", 1, "q@x");
        assert_eq!(found(&store, &reg, "q@x", true), take("INBOX", &["q@x"]));
        // Archived by the user: no archival of an answer took it, so the wait leaves it.
        letter(&store, "Archive", 7, "mine@x");
        assert_eq!(found(&store, &reg, "mine@x", true), Found::Nothing);
        // An archival of an answer took it: the wait takes it from the archive.
        // The mark is in the cache: a new, empty memory (after a restart, or an hour later) finds it.
        store.archived_mark("a", &["r@x".to_owned()], 1).unwrap();
        letter(&store, "Archive", 8, "r@x");
        assert_eq!(found(&store, &reg, "r@x", true), take("Archive", &["r@x"]));
        assert_eq!(found(&store, &reg, "gone@x", true), Found::Nothing);
        // "Undo": the conversation is back in the inbox, and is taken from there.
        letter(&store, "INBOX", 2, "r@x");
        assert_eq!(found(&store, &reg, "r@x", true), take("INBOX", &["r@x"]));
        assert_eq!(
            find_parking(&store, &reg, "a", "INBOX", None, "r@x", true).unwrap(),
            take("INBOX", &["r@x"])
        );
    }

    /// "Undo" of the archival after an answer takes its mark off: what the user archives
    /// himself afterwards is not taken by a wait.
    #[test]
    fn undoing_the_archival_takes_the_mark_off() {
        let store = store();
        let reg = Archivals::default();
        store.archived_mark("a", &["<r@x>".to_owned()], 1).unwrap();
        letter(&store, "Archive", 8, "r@x");
        assert_eq!(found(&store, &reg, "r@x", true), take("Archive", &["r@x"]));
        store.archived_unmark("a", &["r@x".to_owned()]).unwrap();
        // The user archives it himself later: it stays.
        assert_eq!(found(&store, &reg, "r@x", true), Found::Nothing);
    }

    /// A wait put off by the archival of its own conversation goes on once it is over, from
    /// where the archival put the conversation; the archivals of other conversations, and of
    /// other mailboxes, do not hold it up.
    #[test]
    fn a_wait_is_put_off_by_the_archival_of_its_own_conversation_only() {
        let store = store();
        let reg = Arc::new(Archivals::default());
        letter(&store, "INBOX", 1, "q@x");
        let _other = reg.begin("a", "other@x");
        let _elsewhere = reg.begin("b", "q@x");
        assert_eq!(found(&store, &reg, "q@x", true), take("INBOX", &["q@x"]));
        let own = reg.begin("a", "q@x");
        assert_eq!(found(&store, &reg, "q@x", true), Found::Later);
        // A wait given up on waiting goes by what the cache shows.
        assert_eq!(found(&store, &reg, "q@x", false), take("INBOX", &["q@x"]));
        // The archival moves the conversation and ends: the wait finds it in the archive.
        own.moved(&["q@x".to_owned()]);
        store.remove_uids("a", "INBOX", &[1]).unwrap();
        letter(&store, "Archive", 5, "q@x");
        assert_eq!(found(&store, &reg, "q@x", true), Found::Later, "not over yet");
        drop(own);
        store.archived_mark("a", &["q@x".to_owned()], 1).unwrap();
        assert_eq!(found(&store, &reg, "q@x", true), take("Archive", &["q@x"]));
    }

    #[test]
    fn a_move_failing_for_an_hour_is_given_up() {
        assert!(!gives_up(1_000, 1_000 + GIVE_UP_SECS - 1));
        assert!(gives_up(1_000, 1_000 + GIVE_UP_SECS));
    }

    #[test]
    fn the_retention_comes_from_the_plugin_settings() {
        use serde_json::json;
        let with = |v: serde_json::Value| BTreeMap::from([("followups".to_owned(), v)]);
        assert_eq!(keep_days(&BTreeMap::new()), 90);
        assert_eq!(keep_days(&with(json!({ "keep_days": 30 }))), 30);
        assert_eq!(keep_days(&with(json!({ "keep_days": "30" }))), 90, "not a number");
        assert_eq!(keep_days(&with(json!({ "keep_days": 0 }))), 1);
        assert_eq!(keep_days(&with(json!({ "presets": [] }))), 90);
    }

    #[tokio::test]
    async fn an_answer_with_a_wait_marks_the_letter_and_puts_it_to_wait() {
        let store = store();
        let job = sent_to_wait(&store, 1_000).await;
        // The server is asked for the mark of what was done, by the UID the cache knows.
        assert_eq!(job.kind, ParkKind::In);
        assert_eq!((job.anchor.as_str(), job.from.as_str()), ("q@x", "INBOX"));
        assert!(
            job.message_ids.is_empty(),
            "the conversation is found when the move comes (#109)"
        );
        assert_eq!(job.since, 1_000);
    }

    #[tokio::test]
    async fn the_mark_is_asked_of_the_server_when_the_mailbox_runs_and_kept_when_it_does_not() {
        let store = store();
        letter(&store, "INBOX", 4, "q@x");
        let archivals = Arc::new(Archivals::default());
        let mut queue = Queue::default();
        let sent = record_sent(
            &store,
            Some(&mut queue),
            &archivals,
            &waits_in_wait(),
            &parks(),
            Some("<s@x>".into()),
            true,
            50,
        )
        .await
        .unwrap();
        assert_eq!(sent.marked.as_deref(), Some("INBOX"));
        assert_eq!(queue.flags.len(), 1);
        let (folder, _, uids, change) = &queue.flags[0];
        assert_eq!(
            (folder.as_str(), uids.as_slice(), *change),
            ("INBOX", &[4][..], FlagChange::Answered(true))
        );
        // No queue: nothing asked of the server, the wait starts all the same.
        let store = self::store();
        letter(&store, "INBOX", 4, "q@x");
        let sent = record_sent::<Queue>(
            &store,
            None,
            &archivals,
            &waits_in_wait(),
            &parks(),
            Some("<s@x>".into()),
            true,
            50,
        )
        .await
        .unwrap();
        assert!(sent.marked.is_none() && sent.parks && sent.counters);
        assert_eq!(store.park_jobs().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_new_letter_with_a_reminder_starts_a_wait_and_one_without_starts_nothing() {
        let store = store();
        let mut item = answer(86_400, FollowupPlan::default());
        item.draft.acts_on = None;
        let archivals = Arc::new(Archivals::default());
        let go = |item: &OutboxItem, cached: bool, mid: Option<&str>| {
            let (store, archivals, item) = (&store, &archivals, item.clone());
            let mid = mid.map(str::to_owned);
            async move {
                record_sent::<Queue>(store, None, archivals, &waits_in_wait(), &item, mid, cached, 10)
                    .await
                    .unwrap()
            }
        };
        // The letter left but its Message-ID is unknown, or it is not in the cache: no reminder.
        assert!(!go(&item, true, None).await.counters);
        assert!(!go(&item, false, Some("<n@x>")).await.counters);
        // The sent copy is in the cache, which the list of waits reads.
        letter(&store, "INBOX", 9, "<n@x>");
        let sent = go(&item, true, Some("<n@x>")).await;
        assert!(sent.counters && !sent.parks && sent.archive.is_none());
        assert_eq!(store.followups_count().unwrap().active, 1);
    }

    #[tokio::test]
    async fn an_answer_without_a_wait_goes_to_the_archive_and_a_wait_for_its_conversation_waits_for_that() {
        let store = store();
        letter(&store, "INBOX", 1, "q@x");
        let archivals = Arc::new(Archivals::default());
        let item = answer(
            0,
            FollowupPlan {
                park: Some(false),
                archive: Some(true),
                ..Default::default()
            },
        );
        let sent = record_sent::<Queue>(
            &store,
            None,
            &archivals,
            &waits_in_wait(),
            &item,
            Some("<s@x>".into()),
            false,
            1,
        )
        .await
        .unwrap();
        let archiving = sent.archive.unwrap();
        assert_eq!(
            (archiving.folder.as_str(), archiving.message_id.as_str()),
            ("INBOX", "q@x")
        );
        // It is counted before the task starts, so a wait that follows at once sees it.
        assert_eq!(found(&store, &archivals, "q@x", true), Found::Later);
        let mut queue = Queue::default();
        let done = archive_answered(&store, &mut queue, "a", "INBOX", "q@x", &archiving.guard, 5).await;
        let Archived::Moved {
            archive,
            chain,
            not_marked,
        } = done
        else {
            panic!("{done:?}");
        };
        assert_eq!(
            (archive.as_str(), chain.as_slice()),
            ("Archive", &["q@x".to_owned()][..])
        );
        assert!(not_marked.is_none());
        assert!(
            store.archived_marked("a", "q@x").unwrap(),
            "a wait may take it from the archive"
        );
        assert_eq!(queue.moves[0].to, "Archive");
        assert!(!queue.moves[0].unseen);
        // Still going until the guard is dropped, whatever the task came to.
        assert_eq!(found(&store, &archivals, "q@x", true), Found::Later);
        drop(archiving);
        assert!(!matches!(found(&store, &archivals, "q@x", true), Found::Later));
    }

    #[tokio::test]
    async fn the_archive_leaves_the_letter_when_there_is_nothing_to_move_to_or_to_move() {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders("a", &[plain("INBOX", Some(FolderRole::Inbox))])
            .unwrap();
        let archivals = Arc::new(Archivals::default());
        let guard = archivals.begin("a", "q@x");
        let mut queue = Queue::default();
        // A mailbox without an archive folder keeps the letter; nothing is created.
        let done = archive_answered(&store, &mut queue, "a", "INBOX", "q@x", &guard, 1).await;
        assert!(matches!(done, Archived::NoArchive) && queue.log.lock().unwrap().is_empty());
        let store = self::store();
        let mut queue = Queue {
            moved: [Ok(0), Err(Error::Closed)].into(),
            ..Default::default()
        };
        assert!(matches!(
            archive_answered(&store, &mut queue, "a", "INBOX", "q@x", &guard, 1).await,
            Archived::NothingFound
        ));
        assert!(matches!(
            archive_answered(&store, &mut queue, "a", "INBOX", "q@x", &guard, 1).await,
            Archived::Failed(_)
        ));
        assert!(
            !store.archived_marked("a", "q@x").unwrap(),
            "nothing moved, nothing marked"
        );
    }

    async fn take_in_at(store: &Store, queue: &mut Queue, job: &ParkJob, now: i64) -> Taken {
        take_in(
            store,
            queue,
            &Archivals::default(),
            &Refused::default(),
            &waits_in_wait(),
            job,
            now,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn the_conversation_goes_to_the_folder_once_and_the_wait_is_parked() {
        let store = store();
        let job = sent_to_wait(&store, 100).await;
        letter(&store, "INBOX", 2, "q@x");
        let mut queue = Queue::default();
        let taken = take_in_at(&store, &mut queue, &job, 110).await;
        assert!(
            matches!(&taken, Taken::Parked { folder } if folder == "Wait"),
            "{taken:?}"
        );
        assert_eq!(
            queue.moves,
            [Move {
                from: "INBOX".into(),
                message_ids: vec!["q@x".into()],
                to: "Wait".into(),
                unseen: false
            }]
        );
        // The job is done: the next round owes this wait nothing.
        assert!(store.park_jobs().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_move_that_failed_for_now_is_made_again_with_the_same_letters_and_not_twice() {
        let store = store();
        let job = sent_to_wait(&store, 100).await;
        let mut queue = Queue {
            moved: [Err(Error::Timeout("move")), Ok(1)].into(),
            ..Default::default()
        };
        assert!(matches!(take_in_at(&store, &mut queue, &job, 200).await, Taken::Later));
        // The plan was kept: the letters are told by name, whatever the cache shows next.
        let again = store.park_jobs().unwrap().remove(0);
        assert_eq!(again.message_ids, ["q@x"]);
        store.remove_uids("a", "INBOX", &[1]).unwrap();
        let taken = take_in_at(&store, &mut queue, &again, 300).await;
        assert!(matches!(taken, Taken::Parked { .. }), "{taken:?}");
        assert_eq!(queue.moves.len(), 2);
        assert_eq!(queue.moves[0].message_ids, queue.moves[1].message_ids);
        assert!(
            store.park_jobs().unwrap().is_empty(),
            "moved once: no job left to move it again"
        );
    }

    #[tokio::test]
    async fn a_move_that_keeps_failing_for_an_hour_leaves_the_letters_and_tells_the_user() {
        let store = store();
        let job = sent_to_wait(&store, 100).await;
        let mut queue = Queue {
            moved: [Err(Error::Timeout("move"))].into(),
            ..Default::default()
        };
        let taken = take_in_at(&store, &mut queue, &job, 100 + GIVE_UP_SECS).await;
        let Taken::Failed { refused, folder, error } = taken else {
            panic!("{taken:?}");
        };
        assert!(!refused && folder == "Wait" && error.is_some());
        assert!(
            store.park_jobs().unwrap().is_empty(),
            "the wait stays, its letters do not move"
        );
        assert_eq!(store.followups_count().unwrap().active, 1, "the reminder is not lost");
    }

    #[tokio::test]
    async fn letters_that_left_the_inbox_or_moved_by_hand_are_not_waited_for_in_the_folder() {
        let store = store();
        let job = sent_to_wait(&store, 100).await;
        // The conversation is nowhere to take.
        store.remove_uids("a", "INBOX", &[1]).unwrap();
        let mut queue = Queue::default();
        assert!(matches!(
            take_in_at(&store, &mut queue, &job, 110).await,
            Taken::Vanished
        ));
        assert!(queue.moves.is_empty());
        // Found, but gone by the time the server looks.
        let store = self::store();
        let job = sent_to_wait(&store, 100).await;
        let mut queue = Queue {
            moved: [Ok(0)].into(),
            ..Default::default()
        };
        assert!(matches!(
            take_in_at(&store, &mut queue, &job, 110).await,
            Taken::Elsewhere
        ));
        assert!(store.park_jobs().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_archival_of_its_own_conversation_puts_the_move_off() {
        let store = store();
        let job = sent_to_wait(&store, 100).await;
        let archivals = Arc::new(Archivals::default());
        let guard = archivals.begin("a", "q@x");
        let mut queue = Queue::default();
        let account = waits_in_wait();
        let taken = take_in(&store, &mut queue, &archivals, &Refused::default(), &account, &job, 110)
            .await
            .unwrap();
        assert!(matches!(taken, Taken::Later) && queue.moves.is_empty());
        // After an hour it does not wait any longer: it goes by what the cache shows.
        let taken = take_in(
            &store,
            &mut queue,
            &archivals,
            &Refused::default(),
            &account,
            &job,
            100 + GIVE_UP_SECS,
        )
        .await
        .unwrap();
        assert!(matches!(taken, Taken::Parked { .. }), "{taken:?}");
        drop(guard);
    }

    #[tokio::test]
    async fn a_folder_the_server_refuses_to_make_is_not_asked_for_again_and_the_user_is_told_once() {
        let store = store();
        let account = account(Waiting {
            park: true,
            folder: String::new(),
            stop_to_archive: false,
        });
        let (archivals, refused) = (Archivals::default(), Refused::default());
        let job = sent_to_wait(&store, 100).await;
        let mut queue = Queue {
            created: [Err(Error::Protocol("no".into()))].into(),
            ..Default::default()
        };
        let first = take_in(&store, &mut queue, &archivals, &refused, &account, &job, 110)
            .await
            .unwrap();
        assert!(
            matches!(
                first,
                Taken::Failed {
                    refused: true,
                    error: None,
                    ..
                }
            ),
            "{first:?}"
        );
        // The next answer: quietly in the inbox, and the server is not asked again.
        let store = self::store();
        let job = sent_to_wait(&store, 200).await;
        let second = take_in(&store, &mut queue, &archivals, &refused, &account, &job, 210)
            .await
            .unwrap();
        assert!(matches!(second, Taken::Quiet), "{second:?}");
        assert_eq!(queue.log.lock().unwrap().len(), 1, "one attempt to make it");
        assert!(store.park_jobs().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_folder_that_cannot_be_made_for_now_is_tried_again_until_the_hour_is_out() {
        let store = store();
        let account = account(Waiting {
            park: true,
            folder: String::new(),
            stop_to_archive: false,
        });
        let job = sent_to_wait(&store, 100).await;
        let (archivals, refused) = (Archivals::default(), Refused::default());
        let down = || [Err(Error::Timeout("create"))].into();
        let mut queue = Queue {
            created: down(),
            ..Default::default()
        };
        let early = take_in(&store, &mut queue, &archivals, &refused, &account, &job, 110)
            .await
            .unwrap();
        assert!(matches!(early, Taken::Later));
        queue.created = down();
        let late = take_in(
            &store,
            &mut queue,
            &archivals,
            &refused,
            &account,
            &job,
            100 + GIVE_UP_SECS,
        )
        .await
        .unwrap();
        assert!(
            matches!(
                late,
                Taken::Failed {
                    refused: false,
                    error: Some(_),
                    ..
                }
            ),
            "{late:?}"
        );
        // Failing for now is not refusing: the next answer tries again.
        assert!(!refused.contains("a", pick("Waiting for reply", "Ждут ответа")));
    }

    /// A wait parked in the folder and stopped by hand: its letters are to come back.
    async fn stopped_wait(store: &Store, now: i64) -> ParkJob {
        let job = sent_to_wait(store, 100).await;
        let mut queue = Queue::default();
        take_in_at(store, &mut queue, &job, 110).await;
        let stopped = stop(store, "a", false, Some("<s@x>"), now).unwrap();
        assert_eq!(stopped, Some(now));
        store.park_jobs().unwrap().remove(0)
    }

    #[tokio::test]
    async fn the_letters_of_a_stopped_wait_come_back_after_the_undo_toast_and_not_before() {
        let store = store();
        let job = stopped_wait(&store, 1_000).await;
        assert!(matches!(job.kind, ParkKind::Back | ParkKind::Undo));
        assert_eq!((job.from.as_str(), job.to.as_str()), ("Wait", "INBOX"));
        // Held back while the toast offers the undo: the job is not due, and not lost.
        assert!(jobs_due(&store, 1_000).unwrap().is_empty());
        assert_eq!(jobs_due(&store, job.since).unwrap()["a"].len(), 1);
        // The undo within the toast: the wait waits again and nothing moves.
        assert!(store.followup_resume("a", "<s@x>", 1_000).unwrap());
        assert!(jobs_due(&store, job.since + 1).unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_letters_come_back_and_a_return_that_keeps_failing_is_given_up_at_the_hour() {
        let store = store();
        let job = stopped_wait(&store, 1_000).await;
        let mut queue = Queue::default();
        let brought = bring_back(&store, &mut queue, &job, job.since).await.unwrap();
        assert!(matches!(brought, Brought::Back));
        assert_eq!(queue.moves[0].to, "INBOX");
        assert!(!queue.moves[0].unseen);
        assert!(store.park_jobs().unwrap().is_empty());
        // A return that fails is tried again, but not for ever.
        let store = self::store();
        let job = stopped_wait(&store, 1_000).await;
        let mut queue = Queue {
            moved: [Err(Error::Closed), Err(Error::Closed)].into(),
            ..Default::default()
        };
        let early = bring_back(&store, &mut queue, &job, job.since + GIVE_UP_SECS - 1)
            .await
            .unwrap();
        assert!(matches!(early, Brought::Retry(_)));
        assert_eq!(store.park_jobs().unwrap().len(), 1, "the job stays");
        let late = bring_back(&store, &mut queue, &job, job.since + GIVE_UP_SECS)
            .await
            .unwrap();
        assert!(matches!(late, Brought::GaveUp(_)));
        assert!(
            store.park_jobs().unwrap().is_empty(),
            "given up: the letters stay in the folder"
        );
    }

    #[tokio::test]
    async fn a_wait_is_stopped_once_to_the_place_the_mailbox_says() {
        let store = store();
        sent_to_wait(&store, 100).await;
        let mut queue = Queue::default();
        let job = store.park_jobs().unwrap().remove(0);
        take_in_at(&store, &mut queue, &job, 110).await;
        // To the archive when the mailbox says so and has one, the inbox otherwise.
        assert_eq!(stop_to(&store, "a", true).as_deref(), Some("Archive"));
        assert_eq!(stop_to(&store, "a", false), None);
        assert_eq!(stop_to(&store, "b", true), None);
        assert_eq!(stop(&store, "a", true, Some("<s@x>"), 500).unwrap(), Some(500));
        let back = store.park_jobs().unwrap().remove(0);
        assert_eq!(back.to, "Archive");
        // Stopped already: nothing to tell or to take back.
        assert_eq!(stop(&store, "a", true, Some("<s@x>"), 600).unwrap(), None);
        assert_eq!(stop(&store, "a", true, None, 600).unwrap(), None);
    }

    #[tokio::test]
    async fn a_reminder_is_put_off_by_at_least_a_minute_and_a_new_date_waits_for_an_answer_again() {
        let store = store();
        sent_to_wait(&store, 100).await;
        let due = |secs| postpone(&store, "a", Some("<s@x>"), 1_000, secs, false).unwrap();
        assert_eq!(due(3_600), 1_000 + 3_600);
        assert_eq!(due(5), 1_000 + 60, "not sooner than a minute");
        assert_eq!(due(-1), 1_000 + 60);
        // The message is not known: the time is told, nothing is changed.
        assert_eq!(postpone(&store, "a", None, 1_000, 120, true).unwrap(), 1_120);
        assert_eq!(postpone(&store, "a", Some("<s@x>"), 2_000, 3_600, true).unwrap(), 5_600);
    }
}
