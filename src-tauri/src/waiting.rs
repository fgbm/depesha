//! What an answer does after it leaves (#55, #59): the letter answered or forwarded is
//! marked at once, here and on the server, and an answer to a letter of the inbox takes
//! its conversation to the folder "Waiting for reply" until the reply brings it back. The
//! decisions are the core's (`depesha_core::store::waiting`); here are the moves.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use depesha_core::account::Account;
use depesha_core::imap::FolderRole;
use depesha_core::lang::pick;
use depesha_core::smtp::Act;
use depesha_core::store::{Followup, OutboxItem, ParkJob, ParkKind, Parking, WaitFolder, waiting_folder};
use serde_json::json;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;
use crate::worker::{Output, Work};

/// Letters still in the inbox this long after the answer, the server out of reach all the
/// while, stay there: the user is told.
const GIVE_UP_SECS: i64 = 3_600;

/// Folders a server refused to make, by mailbox: not tried again, and the user is not
/// told again, until another folder is chosen.
fn refused() -> &'static Mutex<HashSet<(String, String)>> {
    static REFUSED: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    REFUSED.get_or_init(Default::default)
}

/// Archivals of answered letters under way (#106), by mailbox and conversation. They run apart from the
/// outbox's round, so a wait must neither take a conversation before its archival is done (the
/// move to the archive would take the letters out from under the move to the folder, #109) nor
/// wait for any other archival of the mailbox.
#[derive(Default)]
struct Archivals(Mutex<Vec<Archived>>);

struct Archived {
    id: u64,
    account_id: String,
    /// The letter answered, whose conversation the archival takes.
    anchor: String,
    /// The Message-IDs it moved; known once the move is done. What it took stays marked in
    /// the cache (`archived_mark`), this is only for the wait that comes while it runs.
    chain: Vec<String>,
}

fn archivals() -> &'static Archivals {
    static ARCHIVALS: OnceLock<Archivals> = OnceLock::new();
    ARCHIVALS.get_or_init(Default::default)
}

fn bare(id: &str) -> &str {
    id.trim_matches(['<', '>'])
}

impl Archivals {
    fn list(&self) -> std::sync::MutexGuard<'_, Vec<Archived>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// An archival of the conversation of `anchor` begins.
    fn begin(&self, account_id: &str, anchor: &str) -> u64 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.list().push(Archived {
            id,
            account_id: account_id.to_owned(),
            anchor: bare(anchor).to_owned(),
            chain: Vec::new(),
        });
        id
    }

    /// The archival `id` moved these letters to the archive.
    fn moved(&self, id: u64, chain: &[String]) {
        if let Some(a) = self.list().iter_mut().find(|a| a.id == id) {
            a.chain = chain.iter().map(|m| bare(m).to_owned()).collect();
        }
    }

    /// The archival `id` is over, however its task ended.
    fn end(&self, id: u64) {
        self.list().retain(|a| a.id != id);
    }

    /// Whether an archival under way takes the conversation of `anchor`, whose letters in
    /// the inbox are `inbox_chain`. An archival of another conversation does not count.
    fn busy_with(&self, account_id: &str, anchor: &str, inbox_chain: &[String]) -> bool {
        let anchor = bare(anchor);
        self.list().iter().any(|a| {
            a.account_id == account_id
                && (a.anchor == anchor
                    || a.chain.iter().any(|m| m == anchor)
                    || inbox_chain.iter().any(|m| bare(m) == a.anchor))
        })
    }
}

/// An archival under way; it is over when this is dropped, however the task ends.
struct Archival(u64);

impl Archival {
    fn begin(account_id: &str, anchor: &str) -> Self {
        Self(archivals().begin(account_id, anchor))
    }
}

impl Drop for Archival {
    fn drop(&mut self) {
        archivals().end(self.0);
    }
}

/// What a wait finds when its move comes.
#[derive(Debug, PartialEq, Eq)]
enum Found {
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
fn find_parking(
    store: &depesha_core::store::Store,
    archivals: &Archivals,
    account_id: &str,
    inbox: &str,
    archive: Option<&str>,
    anchor: &str,
    may_wait: bool,
) -> depesha_core::Result<Found> {
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
    state: &AppState,
    account: &Account,
    draft: &depesha_core::smtp::Draft,
    followup_secs: i64,
    plan: &depesha_core::store::FollowupPlan,
) -> CmdResult<(bool, bool)> {
    let inbox = state.store.folder_by_role(&account.id, FolderRole::Inbox)?;
    Ok(depesha_core::store::moves(
        draft.acts_on.as_ref(),
        plan,
        followup_secs,
        &account.id,
        &account.waiting,
        inbox.as_deref(),
    ))
}

/// The letter `item` answered or forwarded, marked now that it left as `message_id`; the
/// wait it asked for started. Returns what became of the letters.
pub async fn after_sent(
    state: &Arc<AppState>,
    account: &Account,
    item: &OutboxItem,
    message_id: Option<String>,
    letter_cached: bool,
) -> CmdResult<Left> {
    let now = chrono::Utc::now().timestamp();
    let acts = item.draft.acts_on.as_ref().filter(|a| a.account_id == account.id);
    let reminder = (item.followup_secs > 0 && letter_cached).then_some(());
    let Some(message_id) = message_id else {
        return Ok(Left { parks: false });
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
        if reminder.is_some() {
            state.store.followup_add_once(&wait(item.followup_secs))?;
            state.emit("counters-changed", json!({}));
        }
        return Ok(Left { parks: false });
    };
    state
        .store
        .mark_done(&account.id, &acts.message_id, acts.act, now, Some(&message_id))?;
    mark_on_server(state, &account.id, &acts.folder, &acts.message_id, acts.act).await;

    // The conversation is found when the scheduler's move comes, not now: an archival of an
    // earlier answer may be taking it just now, and the send does not wait for it (#109).
    let park = if will_park(item) {
        state
            .store
            .folder_by_role(&account.id, FolderRole::Inbox)?
            .filter(|i| *i == acts.folder)
            .map(|from| Parking {
                from,
                chain: Vec::new(),
            })
    } else {
        None
    };
    let f = match reminder {
        Some(()) => wait(item.followup_secs),
        None => Followup {
            due: 0,
            deadline: 0,
            ..wait(0)
        },
    };
    let parks = park.is_some();
    if state.store.followup_start(&f, Some(&acts.message_id), park.as_ref())? {
        state.emit("counters-changed", json!({}));
        if parks {
            state.scheduler_notify.notify_one();
        }
    }
    let in_inbox = state
        .store
        .folder_by_role(&account.id, FolderRole::Inbox)?
        .is_some_and(|i| i == acts.folder);
    // The move waits for the mailbox's queue behind background loads and syncs of two folders:
    // it must not hold the outbox's round, and the next letters' sending, up (#106). "Sent" was
    // said when the letter left; the move adds a toast of its own when something moved.
    let archiving = will_archive(item) && in_inbox;
    if archiving {
        let (state, account, item) = (state.clone(), account.clone(), item.clone());
        let (folder, message_id) = (acts.folder.clone(), acts.message_id.clone());
        // Counted before the task starts, so a wait that follows at once sees it.
        let archival = Archival::begin(&account.id, &message_id);
        tokio::spawn(async move {
            let archival = archival;
            archive_answered(&state, &account, &item, &folder, &message_id, archival.0).await;
        });
    }
    Ok(Left { parks })
}

/// What `after_sent` moved: the letters to wait in the folder (the move is the scheduler's).
/// The move to the archive is a task of its own, with a toast of its own.
pub struct Left {
    pub parks: bool,
}

/// The conversation of the letter answered goes from the inbox to the archive of the
/// mailbox, as the command "Archive" does it (#106). A mailbox without an archive folder
/// keeps the letter: nothing is created behind the user's back. The toast offers to undo.
async fn archive_answered(
    state: &AppState,
    account: &Account,
    item: &OutboxItem,
    from: &str,
    message_id: &str,
    archival: u64,
) -> bool {
    let Ok(Some(archive)) = state.store.folder_by_role(&account.id, FolderRole::Archive) else {
        tracing::debug!(account = %account.id, "archive of the answered letter: the mailbox has no archive folder");
        return false;
    };
    let worker = match state.worker(&account.id) {
        Ok(worker) => worker,
        Err(e) => {
            tracing::warn!(account = %account.id, "archive of the answered letter: no worker: {}", e.message);
            return false;
        }
    };
    let mut chain = match state.store.inbox_chain(&account.id, from, message_id) {
        Ok(chain) => chain,
        Err(e) => {
            tracing::warn!(account = %account.id, "archive of the answered letter: the conversation was not read: {e}");
            return false;
        }
    };
    if chain.is_empty() {
        chain.push(message_id.to_owned());
    }
    let work = Work::MoveByMessageId {
        from: from.to_owned(),
        message_ids: chain.clone(),
        to: archive.clone(),
        unseen: false,
    };
    match worker.run_background(work).await {
        Ok(Output::Count(0)) => {
            tracing::debug!(account = %account.id, "archive of the answered letter: no letter found to move");
            false
        }
        Ok(_) => {
            archivals().moved(archival, &chain);
            if let Err(e) = state
                .store
                .archived_mark(&account.id, &chain, chrono::Utc::now().timestamp())
            {
                tracing::warn!(account = %account.id, "archive of the answered letter: not marked: {e}");
            }
            state.emit("counters-changed", json!({}));
            state.emit(
                "archived-after-send",
                json!({
                    "subject": item.draft.subject,
                    "moved": { "account_id": account.id, "from": from, "to": archive, "message_ids": chain },
                }),
            );
            true
        }
        Err(e) => {
            tracing::warn!(account = %account.id, "archive of the answered letter: {e}");
            false
        }
    }
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

/// The server's flag for what was done: `\Answered` and `$Forwarded`, Exchange's verb.
/// The mark Depesha keeps does not depend on it: a refusal is only logged.
async fn mark_on_server(state: &AppState, account_id: &str, folder: &str, message_id: &str, act: Act) {
    let change = match act {
        Act::Reply => depesha_core::imap::FlagChange::Answered(true),
        Act::ReplyAll => depesha_core::imap::FlagChange::AnsweredAll(true),
        Act::Forward => depesha_core::imap::FlagChange::Forwarded(true),
    };
    let found = state
        .store
        .find_by_message_id(account_id, folder, message_id)
        .ok()
        .flatten()
        .and_then(|r| state.store.get_at(r.id).ok().flatten());
    let (Some((row, validity)), Ok(worker)) = (found, state.worker(account_id)) else {
        return;
    };
    let work = Work::SetFlag {
        folder: row.folder.clone(),
        validity,
        uids: vec![row.uid],
        change,
    };
    if let Err(e) = worker.run_background(work).await {
        tracing::debug!(account = %account_id, "the server did not take the mark: {e}");
    }
    state.emit(
        "mail-changed",
        json!({ "account_id": account_id, "folder": row.folder }),
    );
}

/// The moves waits owe: letters into the folder after an answer, back when the reply came
/// or the user stopped waiting. Run by the scheduler. By mailbox, in parallel: one that
/// hangs or is offline must not hold the others' letters up.
pub async fn round(state: Arc<AppState>) {
    let jobs = match state.store.park_jobs() {
        Ok(jobs) => jobs,
        Err(e) => {
            tracing::warn!("waiting: {e}");
            return;
        }
    };
    let mut by_account: BTreeMap<String, Vec<ParkJob>> = BTreeMap::new();
    for job in jobs {
        by_account.entry(job.account_id.clone()).or_default().push(job);
    }
    crate::scheduler::run_bounded(
        crate::scheduler::ACCOUNTS_AT_ONCE,
        by_account.into_values().collect(),
        |jobs| {
            let state = state.clone();
            async move { jobs_of_account(&state, jobs).await }
        },
    )
    .await;
}

async fn jobs_of_account(state: &AppState, jobs: Vec<ParkJob>) {
    let now = chrono::Utc::now().timestamp();
    for job in jobs {
        // The rest of a chain whose one letter was taken out waits out the undo toast
        // before it goes back: an undo in the meantime finds it still in the folder
        // (`UNDO_SECS` in the store). The job is not lost, only held back.
        if job.since > now {
            continue;
        }
        let done = match job.kind {
            ParkKind::In => take_in(state, &job).await,
            ParkKind::Back | ParkKind::Undo => bring_back(state, &job).await,
        };
        if let Err(e) = done {
            tracing::warn!(account = %job.account_id, "waiting: {}", e.message);
        }
    }
}

async fn take_in(state: &AppState, job: &ParkJob) -> CmdResult<()> {
    let Ok(account) = state.account(&job.account_id) else {
        return Ok(state.store.followup_park_failed(&job.account_id, &job.key)?);
    };
    let worker = state.worker(&account.id)?;
    let now = chrono::Utc::now().timestamp();
    // The conversation is found now (#109): a wait put off for the archival of its own
    // conversation comes round again; one made before that carries its letters already.
    let (from, message_ids) = if job.message_ids.is_empty() {
        let archive = state.store.folder_by_role(&account.id, FolderRole::Archive)?;
        let found = find_parking(
            &state.store,
            archivals(),
            &account.id,
            &job.from,
            archive.as_deref(),
            &job.anchor,
            now - job.since < GIVE_UP_SECS,
        )?;
        match found {
            Found::Later => return Ok(()),
            Found::Nothing => {
                // The letters left the inbox meanwhile: nothing to wait in the folder.
                state.store.followup_park_failed(&job.account_id, &job.key)?;
                state.emit("sent", json!({ "subject": job.subject }));
                state.emit("counters-changed", json!({}));
                return Ok(());
            }
            Found::Take(park) => {
                state.store.followup_park_plan(&job.account_id, &job.key, &park)?;
                (park.from, park.chain)
            }
        }
    } else {
        (job.from.clone(), job.message_ids.clone())
    };
    let fail = |refused: bool, folder: &str, error: Option<String>| -> CmdResult<()> {
        state.store.followup_park_failed(&job.account_id, &job.key)?;
        state.emit(
            "park-failed",
            json!({ "account_id": job.account_id, "subject": job.subject, "folder": folder, "refused": refused, "error": error }),
        );
        state.emit("counters-changed", json!({}));
        Ok(())
    };
    let default = pick("Waiting for reply", "Ждут ответа");
    let folders: Vec<(String, String)> = state
        .store
        .folders(Some(&account.id))?
        .into_iter()
        .map(|f| (f.folder.name, f.folder.display_name))
        .collect();
    let folder = match waiting_folder(&account.waiting.folder, default, &folders) {
        WaitFolder::Existing(name) => name,
        WaitFolder::Create(name) => {
            let key = (account.id.clone(), name.clone());
            if refused().lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
                // Told once already: the letter stays in the inbox quietly.
                state.store.followup_park_failed(&job.account_id, &job.key)?;
                state.emit("counters-changed", json!({}));
                return Ok(());
            }
            match worker.run_background(Work::CreateFolder(name.clone())).await {
                Ok(_) => {}
                Err(e) if e.is_transient() && now - job.since < GIVE_UP_SECS => return Ok(()),
                Err(e) if e.is_transient() => return fail(false, &name, Some(CmdError::from(e).message)),
                Err(_) => {
                    refused().lock().unwrap_or_else(|e| e.into_inner()).insert(key);
                    return fail(true, &name, None);
                }
            }
            let made = state
                .store
                .folders(Some(&account.id))?
                .into_iter()
                .find(|f| f.folder.display_name == name || f.folder.name == name);
            match made {
                Some(f) => f.folder.name,
                None => return fail(true, &name, None),
            }
        }
    };
    let work = Work::MoveByMessageId {
        from,
        message_ids,
        to: folder.clone(),
        unseen: false,
    };
    match worker.run_background(work).await {
        Ok(Output::Count(0)) => {
            // Moved elsewhere meanwhile: nothing waits in the folder.
            state.store.followup_park_failed(&job.account_id, &job.key)?;
            state.emit("counters-changed", json!({}));
        }
        Ok(_) => {
            state.store.followup_parked(&job.account_id, &job.key, &folder)?;
            state.emit(
                "parked",
                json!({ "account_id": job.account_id, "key": job.key, "subject": job.subject, "folder": folder }),
            );
            state.emit("counters-changed", json!({}));
        }
        Err(e) if e.is_transient() && now - job.since < GIVE_UP_SECS => {}
        Err(e) => return fail(false, &folder, Some(CmdError::from(e).message)),
    }
    Ok(())
}

/// Whether a return that has been failing since `since` is given up: the letters stay
/// where they are and the user is told.
fn gives_up(since: i64, now: i64) -> bool {
    now - since >= GIVE_UP_SECS
}

async fn bring_back(state: &AppState, job: &ParkJob) -> CmdResult<()> {
    let worker = match state.worker(&job.account_id) {
        Ok(w) => w,
        // The mailbox is gone: nothing to bring back.
        Err(_) => return Ok(state.store.followup_moved_back(&job.account_id, &job.key)?),
    };
    let now = chrono::Utc::now().timestamp();
    let work = Work::MoveByMessageId {
        from: job.from.clone(),
        message_ids: job.message_ids.clone(),
        to: job.to.clone(),
        unseen: false,
    };
    match worker.run_background(work).await {
        // Moved: back. None found: moved elsewhere by hand, nothing to bring.
        Ok(_) => {
            state.store.followup_moved_back(&job.account_id, &job.key)?;
            state.emit("counters-changed", json!({}));
        }
        // Offline, paused, refused login, busy server, folder locked, a limit, or any
        // other refusal: the next round tries again, but not for ever — a pause or a wrong
        // password must not lose the letters at once, nor be retried in silence for days.
        Err(e) if !gives_up(job.since, now) => {
            tracing::debug!(account = %job.account_id, "bringing letters back failed: {e}")
        }
        Err(e) => {
            state.store.followup_return_failed(&job.account_id, &job.key)?;
            let error = CmdError::from(e);
            // A red task stays in the tasks window until it is dismissed.
            let task = format!("bring:{}:{}", job.account_id, job.key);
            let label = pick(
                "Returning letters from the waiting folder",
                "Возврат писем из папки ожидания",
            );
            state.task(&task, "waiting", Some(&job.account_id), label.to_owned(), 0, 0);
            state.task_failed(&task, error.clone());
            state.emit(
                "bring-failed",
                json!({
                    "account_id": job.account_id,
                    "subject": job.subject,
                    "folder": job.from,
                    "error": error.message,
                }),
            );
            state.emit("counters-changed", json!({}));
        }
    }
    Ok(())
}

/// Where "Stop waiting" takes letters waiting in the folder: the archive when the
/// mailbox says so and has one, the inbox otherwise.
pub fn stop_to(state: &AppState, account_id: &str) -> Option<String> {
    let account = state.account(account_id).ok()?;
    if !account.waiting.stop_to_archive {
        return None;
    }
    state
        .store
        .folder_by_role(account_id, FolderRole::Archive)
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use depesha_core::smtp::{ActsOn, Draft};
    use depesha_core::store::FollowupPlan;

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
        let waits = answer(
            86_400,
            FollowupPlan {
                park: Some(true),
                archive: Some(false),
                ..Default::default()
            },
        );
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

    fn letter(store: &depesha_core::store::Store, folder: &str, uid: u32, mid: &str) {
        use depesha_core::message::Summary;
        use depesha_core::store::NewMessage;
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

    fn folders(store: &depesha_core::store::Store) {
        use depesha_core::imap::Folder;
        let plain = |name: &str, role| Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: Some("/".into()),
            role,
            selectable: true,
            hidden: false,
        };
        store
            .replace_folders(
                "a",
                &[
                    plain("INBOX", Some(FolderRole::Inbox)),
                    plain("Archive", Some(FolderRole::Archive)),
                ],
            )
            .unwrap();
    }

    fn found(store: &depesha_core::store::Store, archivals: &Archivals, anchor: &str, may_wait: bool) -> Found {
        find_parking(store, archivals, "a", "INBOX", Some("Archive"), anchor, may_wait).unwrap()
    }

    fn take(from: &str, chain: &[&str]) -> Found {
        Found::Take(Parking {
            from: from.to_owned(),
            chain: chain.iter().map(|m| (*m).to_owned()).collect(),
        })
    }

    /// A wait takes a conversation from the archive only when the archival of an answer put it
    /// there; what the user archived himself stays, and an "Undo" of the archival puts the
    /// conversation back in the inbox, where the wait takes it from and returns it to (#109).
    #[test]
    fn a_wait_takes_from_the_archive_only_what_an_archival_took() {
        let store = depesha_core::store::Store::open_in_memory().unwrap();
        folders(&store);
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
        let store = depesha_core::store::Store::open_in_memory().unwrap();
        folders(&store);
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
        let store = depesha_core::store::Store::open_in_memory().unwrap();
        folders(&store);
        let reg = Archivals::default();
        letter(&store, "INBOX", 1, "q@x");
        let other = reg.begin("a", "other@x");
        let elsewhere = reg.begin("b", "q@x");
        assert_eq!(found(&store, &reg, "q@x", true), take("INBOX", &["q@x"]));
        let own = reg.begin("a", "q@x");
        assert_eq!(found(&store, &reg, "q@x", true), Found::Later);
        // A wait given up on waiting goes by what the cache shows.
        assert_eq!(found(&store, &reg, "q@x", false), take("INBOX", &["q@x"]));
        // The archival moves the conversation and ends: the wait finds it in the archive.
        reg.moved(own, &["q@x".to_owned()]);
        store.remove_uids("a", "INBOX", &[1]).unwrap();
        letter(&store, "Archive", 5, "q@x");
        assert_eq!(found(&store, &reg, "q@x", true), Found::Later, "not over yet");
        reg.end(own);
        store.archived_mark("a", &["q@x".to_owned()], 1).unwrap();
        assert_eq!(found(&store, &reg, "q@x", true), take("Archive", &["q@x"]));
        reg.end(other);
        reg.end(elsewhere);
    }

    #[test]
    fn a_return_failing_for_an_hour_is_given_up() {
        assert!(!gives_up(1_000, 1_000 + GIVE_UP_SECS - 1));
        assert!(gives_up(1_000, 1_000 + GIVE_UP_SECS));
    }
}
