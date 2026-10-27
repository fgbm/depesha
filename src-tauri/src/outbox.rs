//! Sends queued messages one by one. Transient failures (network, SMTP 4xx,
//! the Exchange rate limit) are retried later; permanent ones wait for the user.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use depesha_core::account::Account;
use depesha_core::outbox::{self, Attempt, Hold, Settled};
use depesha_core::store::{OutboxItem, Requeued, SentCopy, StuckCopy};
use depesha_core::{mail, smtp};
use serde_json::json;

use crate::error::CmdError;
use crate::state::AppState;
use crate::tr;
use crate::worker::{Queue, Work};

/// A gap between rounds this long means the app was not running (the machine slept):
/// the wall clock runs on, the monotonic one does not.
const SLEEP_GAP: Duration = Duration::from_secs(20);

pub async fn run(state: Arc<AppState>) {
    // A send cut short by a quit may or may not have left: it waits for the user.
    recover_interrupted(&state);
    // Copies in «Sent» a quit cut short are filed again; those the server refused for good
    // and that wait for the user are shown in the tasks again.
    restore_stuck_tasks(&state);
    deliver_copies(&state);
    // When the app last ran without a break: a letter due before that was missed.
    let mut awake_since = chrono::Utc::now().timestamp();
    let mut last_wall = std::time::SystemTime::now();
    let mut last_mono = std::time::Instant::now();
    loop {
        // Wake exactly when the next message is due: the undo window and scheduled
        // sending are measured in seconds.
        let next = state
            .store
            .outbox()
            .map_or(15, |items| outbox::next_wake(&items, chrono::Utc::now().timestamp()));
        tokio::select! {
            _ = state.outbox_notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(next)) => {}
        }
        let now = chrono::Utc::now().timestamp();
        // The machine slept: the app was not running since it went under, so letters due
        // in the gap may have missed their time. A busy queue or a dead network is not
        // this: the process kept running then, and those letters go their usual way.
        let wall = std::time::SystemTime::now();
        let mono = std::time::Instant::now();
        if wall.duration_since(last_wall).unwrap_or_default() > mono.duration_since(last_mono) + SLEEP_GAP {
            awake_since = now;
        }
        last_wall = wall;
        last_mono = mono;
        if let Err(e) = round(&state, awake_since).await {
            note_round_failure(&e);
        }
    }
}

/// A round of sending that failed: the notice names the reason in words, the log keeps the kind
/// and the variant, since a refusal may quote the server's reply with an address in it.
fn note_round_failure(e: &CmdError) {
    tracing::error!(kind = e.kind.as_str(), tag = e.tag, "outbox: a round failed");
}

/// A copy of a sent letter that stayed behind: the same rule as `note_round_failure`.
fn note_copy_failure(copy: i64, e: &CmdError) {
    tracing::warn!(copy, kind = e.kind.as_str(), tag = e.tag, "sent copy: it was not filed");
}

/// A letter whose send was cut short (the app quit mid-SMTP): whether the server took it
/// cannot be known, so it is not tried again by itself; the user checks «Sent».
fn recover_interrupted(state: &AppState) {
    match outbox::hold_interrupted(&state.store, chrono::Utc::now().timestamp(), &crate::localize::Phrases) {
        Ok(true) => state.emit("outbox-changed", json!({})),
        Ok(false) => {}
        Err(e) => tracing::warn!("outbox: {e}"),
    }
}

/// One round of sending, with the background noting it is under way so a quit can wait.
async fn round(state: &Arc<AppState>, awake_since: i64) -> Result<(), CmdError> {
    state.background.outbox_begin();
    let done = round_inner(state, awake_since).await;
    state.background.outbox_end();
    done
}

async fn round_inner(state: &Arc<AppState>, awake_since: i64) -> Result<(), CmdError> {
    deliver_copies(state);
    let now = chrono::Utc::now().timestamp();
    // Hours late (the app was closed, the computer asleep), a letter waits for the user.
    crate::background::hold_missed(state, now, awake_since)?;
    // By mailbox: one that is slow or offline must not hold the others' letters up.
    let by_account = outbox::due_by_account(&state.store, now)?;
    let sent = crate::scheduler::run_bounded(
        crate::scheduler::ACCOUNTS_AT_ONCE,
        by_account.into_values().collect(),
        |items| {
            let state = state.clone();
            async move { send_account(&state, items).await }
        },
    )
    .await;
    sent.into_iter().collect()
}

/// Drops what the app remembered about a letter whose attempt has ended. `outbox.id` has no
/// `AUTOINCREMENT`, so SQLite reuses a freed id: a new letter would otherwise inherit the
/// «send now» or the run of connect timeouts of the one before it (#173).
fn forget(settled: &mut HashSet<i64>, streaks: &mut HashMap<i64, u32>, id: i64) {
    settled.remove(&id);
    streaks.remove(&id);
}

/// Drops what the app remembered about a letter the outbox is done with: sent, discarded, taken
/// back into editing, or refused for good.
pub(crate) fn forget_letter(state: &AppState, id: i64) {
    forget(
        &mut crate::state::lock(&state.resend_requested),
        &mut crate::state::lock(&state.connect_timeout_streak),
        id,
    );
}

/// Puts a «send now» in memory before the store is asked. The insert cannot come after the
/// answer: the attempt in flight may settle in between, and `honour_resend` would then find an
/// empty set and leave the request unserved for a settle that never comes.
pub(crate) fn remember_send_now(
    requested: &mut HashSet<i64>,
    id: i64,
    requeue: impl FnOnce() -> depesha_core::Result<Requeued>,
) -> depesha_core::Result<()> {
    requested.insert(id);
    match requeue() {
        Ok(Requeued::InFlight) => Ok(()),
        Ok(Requeued::Now | Requeued::Gone) => {
            requested.remove(&id);
            Ok(())
        }
        Err(e) => {
            requested.remove(&id);
            Err(e)
        }
    }
}

/// Honours a «send now» that landed while this very attempt was on the wire: it could not
/// requeue the letter then (`outbox_requeue` answered `InFlight`), and the attempt has just
/// settled with its own backoff, so the request is honoured now instead of being lost under it.
fn honour_resend(state: &AppState, id: i64, now: i64) {
    if !crate::state::lock(&state.resend_requested).remove(&id) {
        return;
    }
    match state.store.outbox_requeue(id, now) {
        Ok(Requeued::Now) => state.outbox_notify.notify_one(),
        // `InFlight`: another round has claimed the letter by now; `Gone`: there is nothing left
        // to send.
        Ok(Requeued::InFlight | Requeued::Gone) => {}
        Err(e) => tracing::warn!("outbox: {e}"),
    }
}

/// A refusal is for good: the letter waits for the user and is not tried again, so a «send now»
/// remembered during the attempt has nothing left to honour and the run of connect timeouts is
/// over.
fn refused(state: &AppState, key: &str, item: &OutboxItem, error: depesha_core::Error) {
    forget_letter(state, item.id);
    let err = CmdError::from(error);
    state.task_failed(key, err.clone());
    state.emit("send-failed", json!({ "id": item.id, "error": err }));
}

/// Sends one mailbox's due letters, one after another. Once one is refused (the server
/// said no, the address is bad), the rest of that mailbox waits for the user; the other
/// mailboxes go on. The steps of one letter are the core's (`outbox::attempt`).
async fn send_account(state: &Arc<AppState>, items: Vec<OutboxItem>) -> Result<(), CmdError> {
    let now = chrono::Utc::now().timestamp();
    let mut blocked = false;
    for item in items {
        let account = state.account(&item.account_id).ok();
        let key = format!("send:{}", item.id);
        let mut starting = || {
            let subject =
                outbox::subject_or_placeholder(&item.draft.subject, crate::lang::pick("(no subject)", "(без темы)"));
            state.task(
                &key,
                crate::tasks::TaskKind::Send,
                Some(&item.account_id),
                tr!("Sending «{subject}»", "Отправка «{subject}»"),
                0,
                0,
            );
            // The letter is marked and about to leave: the Outbox shows "Sending…" from this
            // moment, not only once the attempt settles, which could be twenty seconds later.
            state.emit("outbox-changed", json!({}));
        };
        let mut aborted = || state.task_done(&key);
        let progress = outbox::Progress {
            starting: &mut starting,
            aborted: &mut aborted,
            words: &crate::localize::Phrases,
        };
        // Built once, outside the closure `attempt` calls: its `stage` is read below, after
        // `attempt` is done with it, to say where a failure happened (`smtp::open`/`send`),
        // not guessed from the kind of error (a dropped connection reads the same at the
        // greeting as at DATA).
        let stage = smtp::Stage::new();
        let mut mail_sender = account.clone().map(|a| MailSender {
            state: state.clone(),
            account: a,
            stage: &stage,
        });
        let attempt = outbox::attempt(&state.store, &item, account.as_ref(), blocked, now, progress, |_| {
            #[allow(
                clippy::expect_used,
                reason = "`attempt` calls this only once a mailbox was found, which is when `mail_sender` was made"
            )]
            mail_sender.as_mut().expect("a mailbox was found")
        })
        .await?;
        match attempt {
            Attempt::Skipped => continue,
            Attempt::Held(Hold::PossiblySent) => {
                state.emit("outbox-changed", json!({}));
                continue;
            }
            Attempt::Held(Hold::NoAccount) => continue,
            Attempt::Delivered(sent) => {
                state.task_done(&key);
                forget_letter(state, item.id);
                #[allow(
                    clippy::expect_used,
                    reason = "`attempt` delivers only with a mailbox: without one it answers `Held(NoAccount)`"
                )]
                let account = account.expect("a delivered letter had its mailbox");
                if !sent.letter_cached {
                    state.emit("app-error", json!({ "message": tr!("sent, but the Sent folder is unknown: the copy was not saved", "письмо отправлено, но папка «Отправленные» неизвестна: копия не сохранена") }));
                }
                // A letter going to wait says so once it has moved ("parked"), in one toast. One
                // going to the archive is "sent" at once; its move, queued behind the mailbox's
                // loads, says "archived-after-send" in a toast of its own (#106).
                let parking = depesha_core::waiting::will_park(&item);
                state.emit(
                    "sent",
                    json!({ "id": item.id, "subject": item.draft.subject, "parking": parking }),
                );
                if sent.defer_wait {
                    state.outbox_notify.notify_one();
                } else {
                    finish_sent(state, &account, &item, sent.message_id, sent.letter_cached).await?;
                }
                // The server keeps the copy itself (Exchange, Gmail): Sent is synced now, so the
                // answer joins its conversation at once, and again a moment later for servers
                // that file it with a delay.
                if !sent.client_copy
                    && let Some(folder) = sent.sent_folder
                    && let Ok(worker) = state.worker(&account.id)
                {
                    worker.kick(Work::SyncFolder(folder.clone()));
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                        worker.kick(Work::SyncFolder(folder));
                    });
                }
            }
            Attempt::Failed { error, transient } => {
                blocked = true;
                // Used to leave no trace at all: one line per attempt, the mailbox by a short
                // hash (never its address), the server, the step `smtp::open`/`send` actually
                // reached and the kind of error — never the letter's text or its recipients.
                log_send_trouble(&item, account.as_ref(), &error, transient, stage.get());
                note_connect_trouble(state, account.as_ref(), &item, &error);
                // A retry later is the outbox's business; a refusal waits for the user.
                if transient {
                    state.task_done(&key);
                    honour_resend(state, item.id, now);
                } else {
                    refused(state, &key, &item, error);
                }
            }
        }
        state.emit("outbox-changed", json!({}));
    }
    Ok(())
}

/// What the log keeps of a failed attempt: never the mailbox's address, the server's own
/// wording of an SMTP reply (it may quote an address, e.g. "<x@y> rejected"), the letter or its
/// recipients — only what tells one failing mailbox from another and what kind of trouble it
/// was. A pure function (`send_trouble_fields`) so it is tested without a store or a mailbox.
struct SendTroubleFields {
    /// A short, stable stand-in for the account id, which is `email-timestamp` (`account_save`):
    /// never the id itself.
    mailbox: String,
    host: String,
    port: u16,
    tls: &'static str,
    /// `ErrorKind`, as the interface branches on it.
    kind: &'static str,
    /// The tag and the numeric codes of a reply, as one field (`smtp 550 5.1.1`).
    error: String,
}

fn send_trouble_fields(account_id: &str, account: Option<&Account>, error: &depesha_core::Error) -> SendTroubleFields {
    let (host, port, tls) = match account {
        Some(a) => (a.smtp.host.clone(), a.smtp.port, tls_name(a.smtp.security)),
        None => (String::new(), 0, "-"),
    };
    SendTroubleFields {
        mailbox: mailbox_hash(account_id),
        host,
        port,
        tls,
        kind: error.kind().as_str(),
        error: error.journal(),
    }
}

fn tls_name(security: depesha_core::account::Security) -> &'static str {
    use depesha_core::account::Security;
    match security {
        Security::Tls => "tls",
        Security::StartTls => "starttls",
        Security::Plain => "plain",
    }
}

/// A short, non-reversible stand-in for an account id, so the same mailbox's lines can be told
/// apart in the log without naming it: the id itself is `email-timestamp` (`account_save`).
fn mailbox_hash(account_id: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    account_id.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

/// One line per failed attempt: the mailbox by a short hash (never its address), the server and
/// port it tried, the TLS mode, the step `smtp::open`/`send` actually reached (not guessed from
/// the kind of error) and the error by its kind, variant and codes — never the letter's text,
/// its recipients or the server's own wording.
fn log_send_trouble(
    item: &OutboxItem,
    account: Option<&Account>,
    error: &depesha_core::Error,
    transient: bool,
    stage: &'static str,
) {
    let f = send_trouble_fields(&item.account_id, account, error);
    tracing::warn!(
        mailbox = f.mailbox,
        host = f.host,
        port = f.port,
        tls = f.tls,
        attempt = item.attempts + 1,
        stage,
        transient,
        kind = f.kind,
        error = f.error,
        "outbox: send attempt failed"
    );
}

/// After the sending server stops answering in time several attempts running, the plain
/// "the server did not answer in time" is replaced by one naming the address and the likely
/// cause: a network that blocks the port, not Depesha (reported after a user could not tell
/// one from the other on a Wi-Fi that drops the outgoing port in silence). Counted in memory,
/// not by `attempts` (which counts every kind of failure): any other kind of trouble, DNS
/// included, breaks the streak, so a one-off blip among connect timeouts does not count double.
const CONNECT_FAILURE_STREAK: u32 = 3;

/// The streak after this error: one more if it is a connect timeout, zero for anything else
/// (including none at all, and a DNS failure, which is its own stage, `resolve`, not `connect`).
/// Pure, so the streak's rules are tested without a mailbox or a store.
fn update_connect_streak(streak: u32, error: &depesha_core::Error) -> u32 {
    if error.is_connect_timeout() { streak + 1 } else { 0 }
}

/// `None` unless the streak given is long enough to replace the plain wording — pure, so it is
/// tested without a mailbox or a store.
fn connect_trouble_text(streak: u32, host: &str, port: u16) -> Option<String> {
    if streak < CONNECT_FAILURE_STREAK {
        return None;
    }
    Some(tr!(
        "can't connect to {host}:{port} — the network may be blocking this port, or the server may be unreachable",
        "не удаётся подключиться к {host}:{port} — возможно, сеть блокирует этот порт, или сервер недоступен"
    ))
}

fn note_connect_trouble(state: &AppState, account: Option<&Account>, item: &OutboxItem, error: &depesha_core::Error) {
    let streak = {
        let mut streaks = crate::state::lock(&state.connect_timeout_streak);
        let streak = update_connect_streak(streaks.get(&item.id).copied().unwrap_or(0), error);
        if streak == 0 {
            streaks.remove(&item.id);
        } else {
            streaks.insert(item.id, streak);
        }
        streak
    };
    let Some(account) = account else { return };
    let Some(text) = connect_trouble_text(streak, &account.smtp.host, account.smtp.port) else {
        return;
    };
    if let Err(e) = state.store.outbox_set_last_error(item.id, &text) {
        tracing::warn!("outbox: {e}");
    }
}

/// The port of the sender over SMTP, or Exchange Web Services when the mailbox is one: the
/// message is built here, and the credentials (kept in the keyring, or refreshed for OAuth)
/// are the app's. `stage` is set as the attempt goes, so the caller can log where a failure
/// happened once this is done with it.
struct MailSender<'a> {
    state: Arc<AppState>,
    account: Account,
    stage: &'a smtp::Stage,
}

impl depesha_core::port::Sender for MailSender<'_> {
    async fn send(&mut self, draft: &depesha_core::domain::Draft) -> depesha_core::Result<Vec<u8>> {
        // The letter as it goes out: the plain part stands for the pictures of the text.
        let msg = smtp::build_sent(draft)?;
        let account = &self.account;
        let msg = &msg;
        let stage = self.stage;
        self.state
            .with_credentials(account, |creds| async move {
                mail::send_with_stage(account, &creds, msg, stage).await
            })
            .await
    }
}

/// The letter answered or forwarded is marked, the wait for a reply starts; a plain "sent"
/// toast follows when the letter was to wait but had nothing to move after all. A letter
/// to be archived was announced as sent when it left.
async fn finish_sent(
    state: &Arc<AppState>,
    account: &depesha_core::account::Account,
    item: &OutboxItem,
    message_id: Option<String>,
    letter_cached: bool,
) -> Result<(), CmdError> {
    let left = crate::waiting::after_sent(state, account, item, message_id, letter_cached).await?;
    if depesha_core::waiting::will_park(item) && !left.parks {
        // Nothing to move after all (the letter left the inbox meanwhile): plain "sent".
        state.emit("sent", json!({ "id": item.id, "subject": item.draft.subject }));
    }
    Ok(())
}

/// Tries at the copies of sent letters not yet in «Sent», each on its own: a slow or dead
/// mailbox holds nobody up. Called by every round and at the start, so a copy that was cut
/// short by a quit or a dead network is filed once the mailbox answers again.
pub fn deliver_copies(state: &Arc<AppState>) {
    let now = chrono::Utc::now().timestamp();
    let Ok(due) = state.store.sent_copies_due(now) else {
        return;
    };
    for copy in outbox::with_known_mailbox(due, |id| state.account(id).is_ok()) {
        if !state.copy_claim(copy.id) {
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = deliver_copy(&state, &copy).await {
                note_copy_failure(copy.id, &e);
            }
            state.copy_release(copy.id);
        });
    }
}

pub(crate) async fn deliver_copy(state: &Arc<AppState>, copy: &SentCopy) -> Result<(), CmdError> {
    let Ok(account) = state.account(&copy.account_id) else {
        // See `outbox::with_known_mailbox`: the copy waits.
        return Ok(());
    };
    let mut queue = Queue::background(state, &copy.account_id).ok();
    let tried = outbox::deliver_copy(
        &state.store,
        queue.as_mut(),
        copy,
        chrono::Utc::now().timestamp(),
        refusal_delay,
        &crate::localize::Phrases,
        |item, cached| async move {
            if !cached {
                state.emit("app-error", json!({ "message": tr!("sent, but the copy was not saved to Sent yet: it will be filed later", "письмо отправлено, но копия в «Отправленные» пока не сохранена: её положат позже") }));
            }
            finish_sent(state, &account, &item, copy.message_id.clone(), cached).await
        },
    )
    .await?;
    if tried.settled == Settled::Held
        && let Some(held) = state.store.sent_copies_stuck()?.into_iter().find(|c| c.id == copy.id)
    {
        stuck_task(state, &held);
    }
    tried.finish_failed.map_or(Ok(()), Err)
}

/// A refusal waited out the longer, the more of them came (`outbox::refusal_delay`). The e2e
/// run shortens it (`DEPESHA_E2E_COPY_BACKOFF`, seconds) to see a copy held within a minute; only
/// the `e2e` build reads it, as with `DEPESHA_E2E_ROOT`.
fn refusal_delay(refusals: u32) -> i64 {
    #[cfg(feature = "e2e")]
    if let Some(secs) = crate::state::e2e_env::<i64>("DEPESHA_E2E_COPY_BACKOFF") {
        return secs;
    }
    outbox::refusal_delay(refusals)
}

/// The task of a copy on hold: plain words on top, the server's own on the line below.
fn stuck_task(state: &AppState, copy: &StuckCopy) {
    let key = stuck_key(copy.id);
    let (label, kind) = stuck_label(copy);
    state.task(
        &key,
        crate::tasks::TaskKind::StuckCopy,
        Some(&copy.account_id),
        label,
        0,
        0,
    );
    let reason = copy.last_error.clone().unwrap_or_default();
    state.task_failed(&key, CmdError::new(kind, reason));
}

/// The kind of the error of a copy the server has but whose finish failed; the interface tells
/// it from a refusal by the server.
const FILED_KIND: depesha_core::ErrorKind = depesha_core::ErrorKind::CopyFiled;

/// The title and the error kind of the task of a held copy. One the server has but whose wait
/// for a reply could not start is a task of its own, and its error is ours, not the server's.
fn stuck_label(copy: &StuckCopy) -> (String, depesha_core::ErrorKind) {
    let subject = outbox::subject_or_placeholder(&copy.subject, crate::lang::pick("(no subject)", "(без темы)"));
    if copy.filed {
        (
            tr!(
                "Copy saved, but the wait for a reply did not start: «{subject}»",
                "Копия сохранена, но не удалось начать ожидание ответа: «{subject}»"
            ),
            FILED_KIND,
        )
    } else {
        (
            tr!("Copy not saved: «{subject}»", "Копия не сохранена: «{subject}»"),
            depesha_core::ErrorKind::Other,
        )
    }
}

/// The key of the task of a held copy; the interface reads the copy's id from it.
pub(crate) fn stuck_key(id: i64) -> String {
    format!("stuck-copy:{id}")
}

/// After a start the copies on hold are in the tasks again (the tasks live in memory).
fn restore_stuck_tasks(state: &AppState) {
    for copy in state.store.sent_copies_stuck().unwrap_or_default() {
        if state.account(&copy.account_id).is_ok() {
            stuck_task(state, &copy);
        }
    }
}

/// «Don't keep the copy»: a wait for a reply still held for the copy starts first, without
/// it, so that dropping the copy never cancels the wait in silence. When the wait cannot
/// start the copy is dropped all the same, or the task would come back at every start; the
/// failure is shown in a toast of its own.
pub(crate) async fn drop_copy(state: &Arc<AppState>, id: i64) -> Result<(), CmdError> {
    let Some(copy) = state.store.sent_copy(id)? else {
        return Ok(());
    };
    let account = state.account(&copy.account_id).ok();
    if copy.pending.is_some() && account.is_some() && !state.copy_claim(id) {
        return Err(CmdError::new(
            depesha_core::ErrorKind::Other,
            tr!("the copy is being filed just now", "копия сейчас отправляется"),
        ));
    }
    let (account, held) = (&account, &copy);
    let failed = outbox::drop_with(&state.store, &copy, |item| async move {
        let Some(account) = account.as_ref() else {
            return Err(CmdError::new(
                depesha_core::ErrorKind::NotFound,
                tr!("account not found", "учётная запись не найдена"),
            ));
        };
        let done = finish_sent(state, account, &item, held.message_id.clone(), held.filed).await;
        state.copy_release(id);
        done
    })
    .await?
    .map(|e: CmdError| e.kind);
    state.task_done(&stuck_key(id));
    if let Some(kind) = failed {
        // The error is logged by its kind: its text may name the letter or its addresses.
        tracing::warn!(
            copy = id,
            kind = kind.as_str(),
            "the wait for a reply did not start while dropping the copy"
        );
        state.emit(
            "app-error",
            json!({ "message": tr!("the copy was dropped, but the wait for a reply did not start", "копия удалена, но ожидание ответа не начато") }),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_sink::logged;

    #[test]
    #[cfg(not(feature = "e2e"))]
    fn a_regular_build_ignores_the_e2e_backoff() {
        // SAFETY: the only test that touches this variable.
        unsafe { std::env::set_var("DEPESHA_E2E_COPY_BACKOFF", "3") };
        assert_eq!(super::refusal_delay(1), 30 * 60);
        assert_eq!(super::refusal_delay(3), 6 * 3_600);
        unsafe { std::env::remove_var("DEPESHA_E2E_COPY_BACKOFF") };
    }

    /// Only connect timeouts truly in a row get the plainer wording: a different kind of
    /// trouble in between (even one that repeats) breaks the streak, so two unrelated failures
    /// followed by a single timeout read as "one", not "three".
    #[test]
    fn only_connect_timeouts_truly_in_a_row_get_the_plainer_wording() {
        let timeout = depesha_core::Error::Timeout("connecting");
        let mut streak = 0;
        for e in [
            depesha_core::Error::Closed,
            depesha_core::Error::Closed,
            timeout.clone(),
        ] {
            streak = update_connect_streak(streak, &e);
        }
        assert!(
            connect_trouble_text(streak, "smtp.yandex.ru", 465).is_none(),
            "two unrelated failures do not count toward the streak"
        );
        let mut streak = 0;
        for _ in 0..3 {
            streak = update_connect_streak(streak, &timeout);
        }
        let text = connect_trouble_text(streak, "smtp.yandex.ru", 465).unwrap();
        assert!(text.contains("smtp.yandex.ru:465"), "{text}");
        assert!(
            text.contains("may be blocking this port") || text.contains("блокирует этот порт"),
            "{text}"
        );
        // A refusal is not a connect timeout: it keeps its own wording, however often it repeats.
        let mut streak = 0;
        for _ in 0..10 {
            streak = update_connect_streak(streak, &depesha_core::Error::Closed);
        }
        assert!(connect_trouble_text(streak, "h", 1).is_none());
    }

    /// Account ids are `email-timestamp` (`account_save`): nothing the log keeps of a failed
    /// attempt may carry the `@` that gives the mailbox away, and an SMTP reply's own text
    /// (which may quote a recipient back) is dropped, kept to its code.
    #[test]
    fn the_fields_of_a_send_trouble_have_no_address() {
        let account: Account = serde_json::from_str(
            r#"{"id":"a@b.ru-1","display_name":"J","email":"a@b.ru","username":"a@b.ru",
                "imap":{"host":"imap.example.com","port":993,"security":"tls"},
                "smtp":{"host":"smtp.example.com","port":465,"security":"tls"},
                "save_sent_copy":true}"#,
        )
        .unwrap();
        let error = depesha_core::Error::Smtp {
            code: 550,
            enhanced: None,
            message: "<x@y.ru> rejected".into(),
        };
        let f = send_trouble_fields("a@b.ru-1", Some(&account), &error);
        let joined = format!("{} {} {} {} {}", f.mailbox, f.host, f.port, f.tls, f.error);
        assert!(!joined.contains('@'), "{joined}");
        assert_eq!(f.error, "smtp 550", "no server text, which may quote an address");
        assert_eq!((f.host.as_str(), f.port, f.tls), ("smtp.example.com", 465, "tls"));
        // Enhanced codes are kept: they are ours to read, not the server's free text.
        let enhanced = depesha_core::Error::Smtp {
            code: 421,
            enhanced: Some("4.4.2".into()),
            message: "<a@b> too many".into(),
        };
        assert_eq!(send_trouble_fields("x", None, &enhanced).error, "smtp 421 4.4.2");
    }

    /// A failure that is not an SMTP reply has no words in the log either: its own text names
    /// the login, a letter or the server's answer, and the user reads that from the notice.
    #[test]
    fn the_fields_of_a_send_trouble_of_another_failure_have_no_server_text() {
        let login = depesha_core::Error::Auth("535 login user@example.org refused".into());
        let f = send_trouble_fields("a@b.ru-1", None, &login);
        let line = format!("{} {} {} {} {}", f.mailbox, f.host, f.port, f.tls, f.error);
        for word in ["example.org", "user@", "535 login"] {
            assert!(!line.contains(word), "{word} in {line}");
        }
        assert_eq!((f.kind, f.error.as_str()), ("auth", "auth"), "{line}");
        // The greeting the server refused names the client's own machine: the code stays alone.
        let hello = depesha_core::Error::SmtpHello {
            name: "workstation.local".into(),
            code: 550,
            message: "no such host <user@example.org>".into(),
        };
        let f = send_trouble_fields("x", None, &hello);
        assert_eq!((f.kind, f.error.as_str()), ("other", "smtp-hello 550"), "{line}");
    }

    /// A log line about a failure that already has the words of the interface: the notice names
    /// the reason to the user, the log may keep the kind and the variant.
    #[test]
    fn the_line_of_a_failed_round_or_a_stuck_copy_has_no_server_text() {
        let refused = CmdError::from(depesha_core::Error::CopyRefused(
            "550-<user@example.org> rejected by policy".into(),
        ));
        let line = logged(|| {
            note_round_failure(&refused);
            note_copy_failure(7, &refused);
        });
        for word in ["example.org", "user@", "rejected by policy"] {
            assert!(!line.contains(word), "{word} in {line}");
        }
        assert!(
            line.contains("kind=\"other\"") && line.contains("tag=\"copy-refused\""),
            "{line}"
        );
        assert_eq!(refused.tag, "copy-refused", "the variant is kept for the log");
    }

    /// The flow `outbox_retry` and `send_account` follow together without a database column:
    /// a «send now» that cannot requeue (the letter is on the wire) is remembered in memory,
    /// and once the attempt in flight settles with a transient failure, the memory of it is
    /// spent on an immediate requeue — the backoff `outbox_retry_later` just applied is
    /// overridden, not left to strand the user's request.
    #[test]
    fn a_pending_resend_is_honoured_once_the_attempt_in_flight_settles() {
        let store = depesha_core::store::Store::open_in_memory().unwrap();
        let id = store
            .outbox_add("a", &Default::default(), 1, 100, 0, &Default::default())
            .unwrap();
        // The round claims the letter: it is on the wire.
        assert!(store.outbox_sending(id, 100).unwrap().is_some());
        // "Send now" lands while it is in flight: `outbox_retry` cannot requeue it and keeps
        // the request in memory for the attempt that will settle.
        let mut resend_requested: HashSet<i64> = Default::default();
        remember_send_now(&mut resend_requested, id, || store.outbox_requeue(id, 110)).unwrap();
        assert!(resend_requested.contains(&id));
        // The attempt settles with a transient failure and applies its own backoff.
        store.outbox_retry_later(id, 130, "timeout", false).unwrap();
        assert_eq!(
            store.outbox().unwrap()[0].next_attempt,
            130,
            "the backoff, before it is honoured"
        );
        // `send_account` sees `Attempt::Failed { transient: true, .. }` and honours the request.
        if resend_requested.remove(&id) {
            assert_eq!(store.outbox_requeue(id, 150).unwrap(), Requeued::Now);
        }
        assert_eq!(
            store.outbox().unwrap()[0].next_attempt,
            150,
            "the manual retry is not lost to the attempt's own backoff"
        );
    }

    /// A letter that left or was discarded asks nothing of the next one: the memory of its
    /// «send now» and of its run of connect timeouts goes with the attempt that ended, so a
    /// row id SQLite reuses does not bring either back (#173).
    #[test]
    fn a_settled_attempt_forgets_its_letter() {
        let mut settled: HashSet<i64> = [7].into();
        let mut streaks: HashMap<i64, u32> = [(7, 2), (8, 1)].into();
        forget(&mut settled, &mut streaks, 7);
        assert!(settled.is_empty(), "the request was spent, not kept for a reused id");
        assert_eq!(
            streaks.keys().copied().collect::<Vec<_>>(),
            [8],
            "another letter keeps the run it has"
        );
    }

    /// Only a letter on the wire keeps a «send now»: it is the one an attempt still has to
    /// settle for. One due at once, one that is gone and one whose store call failed leave
    /// nothing behind.
    #[test]
    fn a_send_now_is_kept_only_for_a_letter_on_the_wire() {
        let mut requested: HashSet<i64> = Default::default();
        remember_send_now(&mut requested, 7, || Ok(Requeued::InFlight)).unwrap();
        assert_eq!(requested.iter().copied().collect::<Vec<_>>(), [7]);
        remember_send_now(&mut requested, 8, || Ok(Requeued::Now)).unwrap();
        remember_send_now(&mut requested, 9, || Ok(Requeued::Gone)).unwrap();
        assert_eq!(
            requested.iter().copied().collect::<Vec<_>>(),
            [7],
            "a letter due at once and a letter that is gone are not remembered"
        );
        let failed = remember_send_now(&mut requested, 10, || Err(depesha_core::Error::Closed));
        assert!(failed.is_err(), "the store's error reaches the caller");
        assert!(!requested.contains(&10), "a failed call leaves no request behind");
    }

    fn held(filed: bool) -> StuckCopy {
        StuckCopy {
            id: 1,
            account_id: "a".into(),
            subject: "Contract".into(),
            last_error: Some("no database".into()),
            refusals: 0,
            filed,
        }
    }

    /// The task of a copy the server took whose finish failed says the copy is saved, not that
    /// it is not; one the server refused is the old task.
    #[test]
    fn the_task_of_a_held_copy_tells_a_failed_finish_from_a_refusal() {
        let (label, kind) = stuck_label(&held(true));
        assert!(
            !label.contains("не сохранена") && !label.contains("not saved"),
            "{label}"
        );
        assert_eq!(kind, FILED_KIND);
        let (label, kind) = stuck_label(&held(false));
        assert!(label.contains("не сохранена") || label.contains("not saved"), "{label}");
        assert_eq!(kind, depesha_core::ErrorKind::Other);
    }
}
