//! Sending (#99, #106): the queue of the outbox, the order of the steps of one letter, the
//! pause after a failure, the copy in «Sent», the letters a sleeping machine missed. The queue
//! is the store's (`Store::outbox`); the SMTP or Exchange send is the port's (`port::Sender`),
//! and so is the copy's upload (`port::MailQueue`). The app only runs the rounds and shows the
//! outcomes. The clock is the caller's: the rules take `now`.
//!
//! The order is what keeps a letter from being sent twice or lost: it is marked as sending
//! before it leaves (`Store::outbox_sending`), so a quit in between leaves a mark and the next
//! start asks the user to look in «Sent» instead of sending again; and the outbox row goes in
//! the very step that keeps the bytes of the copy, so the letter is never gone from the queue
//! without its copy being kept, and the copy is never made of a letter that did not leave.

use std::collections::BTreeMap;
use std::future::Future;

use crate::Result;
use crate::account::Account;
use crate::domain::FolderRole;
use crate::lang::pick;
use crate::message;
use crate::port::{MailQueue, Sender};
use crate::store::{NewSentCopy, OutboxItem, SentCopy, Store};
use crate::tr;

/// A letter due longer than this before the app was running again is not sent at once: it
/// waits for the user instead of leaving hours late.
pub const MISSED_AFTER: i64 = 10 * 60;

/// A letter is missed only when the app was not running since it was due: `awake_since`
/// is when the app last (re)started or woke from sleep. A letter held back while the app
/// ran — the queue is busy, the network is down — is not missed: it goes its usual way.
pub fn missed(item: &OutboxItem, now: i64, awake_since: i64) -> bool {
    !item.failed
        && item.sending_started == 0
        && item.attempts == 0
        && item.next_attempt < awake_since
        && now - item.next_attempt > MISSED_AFTER
}

/// The words of a letter that may have left: the user looks in «Sent».
fn possibly_sent() -> String {
    tr!(
        "possibly sent: check “Sent”",
        "возможно, ушло — проверьте «Отправленные»"
    )
}

/// Hours late (the app was closed, the computer asleep), a letter waits for the user. The ids
/// of the letters it put on hold.
pub fn hold_missed(store: &Store, now: i64, awake_since: i64) -> Result<Vec<i64>> {
    let late: Vec<i64> = store
        .outbox()?
        .iter()
        .filter(|i| missed(i, now, awake_since))
        .map(|i| i.id)
        .collect();
    let why = tr!(
        "not sent on time: Depesha was closed or the computer was asleep",
        "не ушло вовремя: Депеша была закрыта или компьютер спал"
    );
    for id in &late {
        store.outbox_retry_later(*id, now, &why, true)?;
    }
    Ok(late)
}

/// Letters whose send was cut short (the app quit mid-send): whether the server took them
/// cannot be known, so they are not tried again by themselves; the user checks «Sent». Whether
/// there were any.
pub fn hold_interrupted(store: &Store, now: i64) -> Result<bool> {
    let interrupted: Vec<i64> = store
        .outbox()?
        .iter()
        .filter(|i| i.sending_started > 0)
        .map(|i| i.id)
        .collect();
    let why = possibly_sent();
    for id in &interrupted {
        store.outbox_retry_later(*id, now, &why, true)?;
    }
    Ok(!interrupted.is_empty())
}

/// How long to sleep before the next round, in seconds: until the next letter is due, at most
/// a quarter of a minute. The undo delay and scheduled sending are measured in seconds.
pub fn next_wake(items: &[OutboxItem], now: i64) -> u64 {
    items
        .iter()
        .filter(|i| !i.failed)
        .map(|i| i.next_attempt)
        .min()
        .map_or(15, |t| (t - now).clamp(0, 15) as u64)
}

/// The letters due at `now`, by mailbox: one that is slow or offline must not hold the others'
/// letters up.
pub fn due_by_account(store: &Store, now: i64) -> Result<BTreeMap<String, Vec<OutboxItem>>> {
    let mut by_account: BTreeMap<String, Vec<OutboxItem>> = BTreeMap::new();
    for item in store.outbox()? {
        if item.failed || item.next_attempt > now {
            continue;
        }
        by_account.entry(item.account_id.clone()).or_default().push(item);
    }
    Ok(by_account)
}

/// How long a letter waits before the next try after a failure: 30 s, doubling to half an
/// hour; a throttled Exchange named its pause, and not a moment sooner.
fn retry_delay(attempts: u32, e: &crate::Error) -> i64 {
    let delay = if e.kind() == "rate-limited" {
        65
    } else {
        (30_i64 << attempts.min(6)).min(1800)
    };
    delay.max(e.back_off().map_or(0, |d| d.as_secs().min(1800) as i64 + 1))
}

/// Why a letter was not sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Hold {
    /// Marked as sending but not removed: it may have left. Not sent again.
    PossiblySent,
    /// Its mailbox was removed.
    NoAccount,
}

/// What a letter that was sent leaves for the caller.
#[derive(Debug)]
pub struct Delivered {
    pub message_id: Option<String>,
    /// The Sent folder as the cache names it, if the mailbox has one.
    pub sent_folder: Option<String>,
    /// The copy is the client's to file: the server (Exchange, Gmail) does not keep it itself.
    pub client_copy: bool,
    /// A wait for a reply needs its letter in the cache: it starts when the copy has landed.
    pub defer_wait: bool,
    /// The letter is in the cache, which a wait for a reply needs.
    pub letter_cached: bool,
    /// The copy cannot be made: there is no Sent folder yet. The user is told.
    pub copy_unsaved: bool,
}

#[derive(Debug)]
pub enum Attempt {
    /// Not now: failed, not due, or an earlier letter of the mailbox was refused.
    Skipped,
    Held(Hold),
    Delivered(Delivered),
    /// The send failed. `transient`: it is tried again later; else the letter waits for the
    /// user, and the rest of the mailbox's letters with it.
    Failed {
        error: crate::Error,
        transient: bool,
    },
}

/// One letter: the steps in the order that keeps it from being sent twice or lost. `blocked`:
/// an earlier letter of this mailbox was refused, and the rest wait for the user. `starting`
/// is told once the letter is certain to be sent, before it leaves. `sender` makes the port
/// of the account's kind.
pub async fn attempt<S: Sender>(
    store: &Store,
    item: &OutboxItem,
    account: Option<&Account>,
    blocked: bool,
    now: i64,
    starting: &mut (dyn FnMut() + Send),
    sender: impl FnOnce(&Account) -> S,
) -> Result<Attempt> {
    if item.failed || item.next_attempt > now || blocked {
        return Ok(Attempt::Skipped);
    }
    // A send that started but whose row was not removed (the removal failed after a good send)
    // may have left: do not send it again, the user checks «Sent».
    if item.sending_started > 0 {
        store.outbox_retry_later(item.id, now, &possibly_sent(), true)?;
        return Ok(Attempt::Held(Hold::PossiblySent));
    }
    let Some(account) = account else {
        store.outbox_retry_later(
            item.id,
            now,
            &tr!("the account was removed", "учётная запись удалена"),
            true,
        )?;
        return Ok(Attempt::Held(Hold::NoAccount));
    };
    starting();
    // Marked before the letter leaves: a quit between here and the removal leaves the mark,
    // and the next start asks the user to check «Sent» instead of sending again.
    store.outbox_sending(item.id, now)?;
    let sent = sender(account).send(&item.draft).await;
    match sent {
        Ok(raw) => Ok(Attempt::Delivered(delivered(store, item, account, &raw)?)),
        Err(error) => {
            let transient = error.is_transient();
            let delay = retry_delay(item.attempts, &error);
            store.outbox_retry_later(item.id, now + delay, &error.to_string(), !transient)?;
            Ok(Attempt::Failed { error, transient })
        }
    }
}

/// The letter left: its row is removed, and its copy kept. The client-side copy is work of its
/// own: the send round does not wait for it (a slow Sent folder would hold the whole round up).
/// The bytes are kept in the cache in the very step that removes the outbox row, so a quit, a
/// dead network or a paused mailbox cannot lose them; `deliver_copy` files them.
fn delivered(store: &Store, item: &OutboxItem, account: &Account, raw: &[u8]) -> Result<Delivered> {
    let message_id = message::parse_summary(raw).message_id;
    let sent_folder = store.folder_by_role(&account.id, FolderRole::Sent)?;
    let client_copy = account.save_sent_copy && !account.is_ews();
    let mut out = Delivered {
        message_id: message_id.clone(),
        sent_folder: sent_folder.clone(),
        client_copy,
        defer_wait: false,
        letter_cached: true,
        copy_unsaved: false,
    };
    match sent_folder.as_deref() {
        Some(folder) if client_copy => {
            out.defer_wait = item.followup_secs > 0;
            store.outbox_sent_with_copy(
                item.id,
                &NewSentCopy {
                    account_id: &account.id,
                    folder,
                    raw,
                    flags: "(\\Seen)",
                    message_id: message_id.as_deref(),
                    subject: &item.draft.subject,
                    pending: out.defer_wait.then_some(item),
                },
            )?;
        }
        _ => {
            store.outbox_remove(item.id)?;
            // No Sent folder yet: the copy cannot be made, so a wait could neither be shown nor
            // cancelled. Say so and leave it out.
            if client_copy {
                out.letter_cached = false;
                out.copy_unsaved = true;
            }
        }
    }
    Ok(out)
}

/// What a try at a copy came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Settled {
    /// The server has it: nothing is left to file.
    Filed,
    /// It waits for its next try.
    Waiting,
    /// The server refused it for the last time: it waits for the user, and is not uploaded again.
    Held,
}

/// Refusals the server may give before the copy is put on hold.
pub const REFUSALS_BEFORE_HOLD: u32 = 3;

/// How many tries a wait for a reply stays held for its copy before it starts without one.
pub const COPY_WAIT_TRIES: u32 = 3;

/// A refusal waited out the longer, the more of them came: 30 min, 2 h, 6 h.
pub fn refusal_delay(refusals: u32) -> i64 {
    match refusals {
        0 | 1 => 30 * 60,
        2 => 2 * 3_600,
        _ => 6 * 3_600,
    }
}

/// The worker found the server's answer to the APPEND final (`append_refused`).
pub fn copy_refused(e: &crate::Error) -> bool {
    matches!(e, crate::Error::CopyRefused(_))
}

/// The copies whose mailbox is configured. The others stay in the cache: a broken accounts
/// file reads as no mailboxes at all, and a copy is not dropped for that. Removing a mailbox
/// clears its copies (`forget_account`).
pub fn with_known_mailbox(due: Vec<SentCopy>, known: impl Fn(&str) -> bool) -> Vec<SentCopy> {
    due.into_iter().filter(|c| known(&c.account_id)).collect()
}

/// What the try at a copy leaves in the cache: nothing when the server has it, otherwise
/// the copy waits for its next try. A network trouble repeats with a growing pause; a
/// refusal is counted apart, and the third one puts the copy on hold. `delay` is the pause
/// after the n-th refusal (`refusal_delay`).
pub fn settle_copy(
    store: &Store,
    copy: &SentCopy,
    outcome: &Result<()>,
    now: i64,
    delay: &(dyn Fn(u32) -> i64 + Sync),
) -> Result<Settled> {
    match outcome {
        Ok(()) => {
            store.sent_copy_done(copy.id)?;
            Ok(Settled::Filed)
        }
        Err(e) if copy_refused(e) => {
            let refusals = copy.refusals + 1;
            let hold = refusals >= REFUSALS_BEFORE_HOLD;
            store.sent_copy_refused(copy.id, now + delay(refusals), &e.to_string(), hold)?;
            Ok(if hold { Settled::Held } else { Settled::Waiting })
        }
        Err(e) => {
            let pause = (30_i64 << copy.attempts.min(6)).min(1800);
            let pause = pause.max(e.back_off().map_or(0, |d| d.as_secs().min(1800) as i64 + 1));
            store.sent_copy_retry_later(copy.id, now + pause, &e.to_string())?;
            Ok(Settled::Waiting)
        }
    }
}

/// A finish of the sent letter that failed leaves its copy to try again later. It counts like
/// a refusal (30 min, 2 h, 6 h, then on hold with a task): a finish that fails for good
/// must not repeat itself forever. With the copy on the server (`filed`) the failure is the
/// local one and the copy is marked, so the repeat does the finish only and does not upload
/// the copy again; otherwise the copy is the one that was not saved.
pub fn settle_failed_finish(
    store: &Store,
    copy: &SentCopy,
    failure: &str,
    filed: bool,
    now: i64,
    delay: &(dyn Fn(u32) -> i64 + Sync),
) -> Result<Settled> {
    if !filed {
        let failed = Err(crate::Error::CopyRefused(failure.to_owned()));
        return settle_copy(store, copy, &failed, now, delay);
    }
    let refusals = copy.refusals + 1;
    let hold = refusals >= REFUSALS_BEFORE_HOLD;
    store.sent_copy_unfinished(copy.id, now + delay(refusals), failure, hold)?;
    Ok(if hold { Settled::Held } else { Settled::Waiting })
}

/// What a try at a copy did.
#[derive(Debug)]
pub struct CopyTry<E> {
    pub settled: Settled,
    /// The finish of the letter (the wait for a reply) failed; the copy was settled as such.
    pub finish_failed: Option<E>,
}

/// Files the copy of a sent letter in «Sent», and when a wait for a reply was held for it,
/// starts the wait through `finish(item, cached)`: with the copy cached, or, if the copy cannot
/// be filed for good (a refusal, or the third try), without it. A copy the server took already
/// is not uploaded again: only its local finish is repeated. `queue`: the mailbox's, none when
/// it is not running.
pub async fn deliver_copy<Q, E, F, Fut>(
    store: &Store,
    queue: Option<&mut Q>,
    copy: &SentCopy,
    now: i64,
    delay: &(dyn Fn(u32) -> i64 + Sync),
    finish: F,
) -> Result<CopyTry<E>>
where
    Q: MailQueue,
    E: std::fmt::Display,
    F: FnOnce(OutboxItem, bool) -> Fut,
    Fut: Future<Output = std::result::Result<(), E>>,
{
    let outcome = if copy.filed {
        Ok(())
    } else {
        match queue {
            Some(queue) => {
                queue
                    .copy_to_sent(&copy.folder, &copy.raw, &copy.flags, copy.message_id.as_deref())
                    .await
            }
            None => Err(crate::Error::Io(std::io::Error::other(tr!(
                "the account is not running",
                "учётная запись не запущена"
            )))),
        }
    };
    let ready = match (&outcome, copy.pending.as_ref()) {
        (Ok(()), Some(item)) => Some((item, true)),
        (Err(e), Some(item)) if !e.is_transient() || copy.attempts + 1 >= COPY_WAIT_TRIES => Some((item, false)),
        _ => None,
    };
    if let Some((item, cached)) = ready
        && let Err(e) = finish(item.clone(), cached).await
    {
        // Counted as a refusal: otherwise the copy and the finish are repeated for ever.
        let settled = settle_failed_finish(store, copy, &e.to_string(), outcome.is_ok(), now, delay)?;
        return Ok(CopyTry {
            settled,
            finish_failed: Some(e),
        });
    }
    let settled = settle_copy(store, copy, &outcome, now, delay)?;
    if matches!(ready, Some((_, false))) {
        store.sent_copy_forget_wait(copy.id)?;
    }
    Ok(CopyTry {
        settled,
        finish_failed: None,
    })
}

/// The wait for a reply that «Don't keep» must start before the copy goes: one still held for
/// the copy.
pub fn wait_before_drop(copy: &SentCopy) -> Option<&OutboxItem> {
    copy.pending.as_ref()
}

/// «Don't keep the copy»: starts the wait held for the copy with `finish`, without the copy, so
/// that dropping the copy never cancels the wait in silence; then drops the copy whatever came
/// of it. When the wait cannot start the copy is dropped all the same, or its task would come
/// back at every start. Gives what the wait failed with.
pub async fn drop_with<E, F, Fut>(store: &Store, copy: &SentCopy, finish: F) -> Result<Option<E>>
where
    F: FnOnce(OutboxItem) -> Fut,
    Fut: Future<Output = std::result::Result<(), E>>,
{
    let failed = match wait_before_drop(copy) {
        Some(item) => finish(item.clone()).await.err(),
        None => None,
    };
    store.sent_copy_done(copy.id)?;
    Ok(failed)
}

/// What the subject of a letter reads as in the tasks and toasts.
pub fn subject_or_placeholder(subject: &str) -> String {
    if subject.is_empty() {
        pick("(no subject)", "(без темы)").to_owned()
    } else {
        subject.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::Error;
    use crate::account::{EwsConfig, Security, ServerConfig, Waiting};
    use crate::domain::{Draft, Folder};
    use crate::port::fake::Queue;
    use crate::port::fake_sender::{RAW, Sender as FakeSender};
    use crate::store::{FollowupPlan, StuckCopy};

    const DELAY: &(dyn Fn(u32) -> i64 + Sync) = &refusal_delay;

    fn account(save_copy: bool, ews: bool) -> Account {
        Account {
            id: "a".into(),
            label: String::new(),
            color: String::new(),
            display_name: String::new(),
            email: "me@x".into(),
            username: "me@x".into(),
            imap: ServerConfig::new("imap.x", 993, Security::Tls),
            smtp: ServerConfig::new("smtp.x", 465, Security::Tls),
            save_sent_copy: save_copy,
            signature: String::new(),
            signatures: Vec::new(),
            default_signature: None,
            reply_signature: None,
            compose_format: None,
            letter_view: None,
            attachments_dir: String::new(),
            auth: Default::default(),
            ews: ews.then(|| EwsConfig {
                url: "https://ews.x".into(),
                trusted_cert: None,
            }),
            quota_warn: true,
            quota_limit_mb: 0,
            waiting: Waiting::default(),
        }
    }

    /// A mailbox with a Sent folder.
    fn store() -> Store {
        let store = Store::open_in_memory().unwrap();
        let sent = Folder {
            name: "Sent".into(),
            display_name: "Sent".into(),
            delimiter: Some("/".into()),
            role: Some(FolderRole::Sent),
            selectable: true,
            hidden: false,
        };
        store.replace_folders("a", &[sent]).unwrap();
        store
    }

    fn queued(store: &Store, at: i64, followup_secs: i64) -> OutboxItem {
        let draft = Draft {
            subject: "Contract".into(),
            ..Draft::default()
        };
        let id = store
            .outbox_add("a", &draft, 1, at, followup_secs, &FollowupPlan::default())
            .unwrap();
        store.outbox().unwrap().into_iter().find(|i| i.id == id).unwrap()
    }

    async fn go(
        store: &Store,
        sender: &mut FakeSender,
        item: &OutboxItem,
        account: Option<&Account>,
        blocked: bool,
        now: i64,
    ) -> Attempt {
        let mut started = 0;
        let got = attempt(store, item, account, blocked, now, &mut || started += 1, |_| {
            std::mem::take(sender)
        })
        .await
        .unwrap();
        // `starting` is told only for a letter that is going to leave.
        let leaves = matches!(got, Attempt::Delivered(_) | Attempt::Failed { .. });
        assert_eq!(started, usize::from(leaves));
        got
    }

    /// A letter sent, its copy kept; the outbox row is gone.
    fn sent(store: &Store) -> SentCopy {
        let id = store
            .outbox_add("a", &Default::default(), 1, 1, 0, &Default::default())
            .unwrap();
        store
            .outbox_sent_with_copy(
                id,
                &NewSentCopy {
                    account_id: "a",
                    folder: "Sent",
                    raw: b"raw",
                    flags: "(\\Seen)",
                    message_id: Some("m@x"),
                    subject: "Contract",
                    pending: None,
                },
            )
            .unwrap();
        store.sent_copies().unwrap().remove(0)
    }

    fn sent_pending(store: &Store) -> SentCopy {
        let id = store
            .outbox_add("a", &Default::default(), 1, 1, 0, &Default::default())
            .unwrap();
        let item = store.outbox().unwrap().remove(0);
        store
            .outbox_sent_with_copy(
                id,
                &NewSentCopy {
                    account_id: "a",
                    folder: "Sent",
                    raw: b"raw",
                    flags: "(\\Seen)",
                    message_id: Some("m@x"),
                    subject: "Contract",
                    pending: Some(&item),
                },
            )
            .unwrap();
        store.sent_copies().unwrap().remove(0)
    }

    fn refused(text: &str) -> Error {
        Error::CopyRefused(text.into())
    }

    #[tokio::test]
    async fn a_letter_is_marked_as_sending_before_it_leaves_and_its_row_goes_with_the_copy_kept() {
        let store = Arc::new(store());
        let item = queued(&store, 5, 0);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut sender = FakeSender::default();
        let (probe_store, probe_seen) = (store.clone(), seen.clone());
        sender.probe = Some(Box::new(move |_| {
            let rows = probe_store.outbox().unwrap();
            probe_seen.lock().unwrap().push((rows.len(), rows[0].sending_started));
        }));
        let acct = account(true, false);
        let got = go(&store, &mut sender, &item, Some(&acct), false, 100).await;
        // At the moment it left, the row was there and marked: a quit now sends nothing twice.
        assert_eq!(*seen.lock().unwrap(), [(1, 100)]);
        let Attempt::Delivered(d) = got else {
            panic!("{got:?}");
        };
        assert!(d.client_copy && d.letter_cached && !d.defer_wait && !d.copy_unsaved);
        assert_eq!(d.sent_folder.as_deref(), Some("Sent"));
        assert!(d.message_id.as_deref().is_some_and(|m| m.contains("sent@x")));
        // The row is gone in the very step that kept the bytes of the copy.
        assert!(store.outbox().unwrap().is_empty());
        let copy = store.sent_copies().unwrap().remove(0);
        assert_eq!((copy.folder.as_str(), copy.raw.as_slice()), ("Sent", RAW));
        assert_eq!(copy.flags, "(\\Seen)");
        assert!(copy.pending.is_none());
    }

    #[tokio::test]
    async fn a_wait_for_a_reply_is_held_for_the_copy_that_lands_first() {
        let store = store();
        let item = queued(&store, 5, 86_400);
        let acct = account(true, false);
        let got = go(&store, &mut FakeSender::default(), &item, Some(&acct), false, 100).await;
        let Attempt::Delivered(d) = got else {
            panic!("{got:?}");
        };
        assert!(d.defer_wait && d.letter_cached);
        assert_eq!(
            store.sent_copies().unwrap()[0].pending.as_ref().map(|i| i.id),
            Some(item.id)
        );
    }

    #[tokio::test]
    async fn without_a_copy_to_make_the_row_goes_and_nothing_is_filed() {
        // The mailbox does not keep copies.
        let store = store();
        let item = queued(&store, 5, 86_400);
        let acct = account(false, false);
        let got = go(&store, &mut FakeSender::default(), &item, Some(&acct), false, 100).await;
        let Attempt::Delivered(d) = got else {
            panic!("{got:?}");
        };
        assert!(!d.client_copy && !d.defer_wait && d.letter_cached && !d.copy_unsaved);
        assert!(store.outbox().unwrap().is_empty() && store.sent_copies().unwrap().is_empty());
        // Exchange files the copy itself.
        let item = queued(&store, 5, 0);
        let acct = account(true, true);
        let got = go(&store, &mut FakeSender::default(), &item, Some(&acct), false, 100).await;
        let Attempt::Delivered(d) = got else {
            panic!("{got:?}");
        };
        assert!(!d.client_copy && d.sent_folder.as_deref() == Some("Sent"));
        assert!(store.sent_copies().unwrap().is_empty());
        // A mailbox with no Sent folder yet cannot file a copy: the user is told, no wait starts.
        let bare = Store::open_in_memory().unwrap();
        let item = queued(&bare, 5, 86_400);
        let acct = account(true, false);
        let got = go(&bare, &mut FakeSender::default(), &item, Some(&acct), false, 100).await;
        let Attempt::Delivered(d) = got else {
            panic!("{got:?}");
        };
        assert!(d.copy_unsaved && !d.letter_cached && d.sent_folder.is_none());
        assert!(bare.outbox().unwrap().is_empty() && bare.sent_copies().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_letter_that_failed_for_now_stays_in_the_queue_and_waits_longer_each_time() {
        let store = store();
        let acct = account(true, false);
        let first = queued(&store, 5, 0);
        let mut sender = FakeSender {
            results: [Err(Error::Closed)].into(),
            ..Default::default()
        };
        let got = go(&store, &mut sender, &first, Some(&acct), false, 100).await;
        assert!(matches!(got, Attempt::Failed { transient: true, .. }));
        let row = store.outbox().unwrap().remove(0);
        assert_eq!(
            (row.failed, row.next_attempt),
            (false, 130),
            "30 s, and it is tried again"
        );
        assert_eq!(
            row.sending_started, 0,
            "no mark: a failed send is not a possibly sent one"
        );
        assert!(
            store.sent_copies().unwrap().is_empty(),
            "no copy of a letter that did not leave"
        );
        // Not due yet: left alone.
        let got = go(&store, &mut sender, &row, Some(&acct), false, 129).await;
        assert!(matches!(got, Attempt::Skipped));
        // 30 s, 60 s, ... up to half an hour.
        let mut later = row.clone();
        for (attempts, want) in [(1, 60), (2, 120), (6, 1800), (9, 1800)] {
            later.attempts = attempts;
            later.next_attempt = 0;
            let mut sender = FakeSender {
                results: [Err(Error::Closed)].into(),
                ..Default::default()
            };
            go(&store, &mut sender, &later, Some(&acct), false, 1_000).await;
            assert_eq!(
                store.outbox().unwrap()[0].next_attempt,
                1_000 + want,
                "attempt {attempts}"
            );
        }
    }

    #[tokio::test]
    async fn a_refusal_waits_for_the_user_and_so_does_the_rest_of_the_mailbox() {
        let store = store();
        let acct = account(true, false);
        let item = queued(&store, 5, 0);
        let refused = Error::Smtp {
            code: 550,
            enhanced: None,
            message: "no such user".into(),
        };
        let mut sender = FakeSender {
            results: [Err(refused)].into(),
            ..Default::default()
        };
        let got = go(&store, &mut sender, &item, Some(&acct), false, 100).await;
        assert!(matches!(got, Attempt::Failed { transient: false, .. }));
        let row = store.outbox().unwrap().remove(0);
        assert!(row.failed && row.last_error.as_deref().is_some_and(|e| e.contains("no such user")));
        // Blocked: the next letter of the mailbox is not sent, however due.
        let other = queued(&store, 5, 0);
        let mut sender = FakeSender::default();
        assert!(matches!(
            go(&store, &mut sender, &other, Some(&acct), true, 100).await,
            Attempt::Skipped
        ));
        assert!(sender.sent.is_empty());
        // A refused letter is not tried again by itself.
        assert!(matches!(
            go(&store, &mut sender, &row, Some(&acct), false, 10_000).await,
            Attempt::Skipped
        ));
    }

    #[tokio::test]
    async fn a_throttled_server_is_not_asked_again_before_it_said() {
        let store = store();
        let acct = account(true, false);
        let item = queued(&store, 5, 0);
        let throttled = Error::Smtp {
            code: 421,
            enhanced: Some("4.4.2".into()),
            message: "slow down".into(),
        };
        let mut sender = FakeSender {
            results: [Err(throttled)].into(),
            ..Default::default()
        };
        go(&store, &mut sender, &item, Some(&acct), false, 100).await;
        assert_eq!(store.outbox().unwrap()[0].next_attempt, 165, "a minute and a bit");
        let named = Error::Ews {
            code: "ErrorServerBusy".into(),
            message: "busy".into(),
            back_off: Some(std::time::Duration::from_secs(400)),
        };
        let mut sender = FakeSender {
            results: [Err(named)].into(),
            ..Default::default()
        };
        let row = store.outbox().unwrap().remove(0);
        let row = OutboxItem { next_attempt: 0, ..row };
        go(&store, &mut sender, &row, Some(&acct), false, 100).await;
        assert_eq!(
            store.outbox().unwrap()[0].next_attempt,
            100 + 401,
            "not a moment sooner"
        );
    }

    #[tokio::test]
    async fn a_letter_that_may_have_left_or_has_no_mailbox_is_never_sent() {
        let store = store();
        let acct = account(true, false);
        // The send was cut short (or the removal failed after a good send).
        let item = queued(&store, 5, 0);
        store.outbox_sending(item.id, 50).unwrap();
        let marked = store.outbox().unwrap().remove(0);
        let mut sender = FakeSender::default();
        let got = go(&store, &mut sender, &marked, Some(&acct), false, 100).await;
        assert!(matches!(got, Attempt::Held(Hold::PossiblySent)));
        assert!(sender.sent.is_empty(), "not sent again");
        let row = store.outbox().unwrap().remove(0);
        assert!(row.failed, "it waits for the user");
        assert!(row.last_error.unwrap().contains("Sent"), "who is asked to look in Sent");
        assert_eq!(store.outbox().unwrap().len(), 1, "and not lost");
        // The mailbox was removed meanwhile.
        let store = self::store();
        let item = queued(&store, 5, 0);
        let got = go(&store, &mut sender, &item, None, false, 100).await;
        assert!(matches!(got, Attempt::Held(Hold::NoAccount)));
        assert!(sender.sent.is_empty());
        assert!(store.outbox().unwrap()[0].failed, "it waits for the user");
        assert!(store.sent_copies().unwrap().is_empty(), "no copy without a send");
    }

    #[test]
    fn the_queue_reports_what_is_due_by_mailbox_and_when_to_look_again() {
        let store = store();
        let a = queued(&store, 100, 0);
        queued(&store, 500, 0);
        let due = due_by_account(&store, 100).unwrap();
        assert_eq!(due["a"].iter().map(|i| i.id).collect::<Vec<_>>(), [a.id]);
        assert!(due_by_account(&store, 99).unwrap().is_empty());
        // Sleep until the next letter, but no more than 15 s, and not a negative time.
        let all = store.outbox().unwrap();
        assert_eq!(next_wake(&all, 95), 5);
        assert_eq!(next_wake(&all, 50), 15);
        assert_eq!(next_wake(&all, 400), 0);
        assert_eq!(next_wake(&[], 0), 15);
        // A refused letter waits for the user: it does not wake the queue.
        store.outbox_retry_later(a.id, 100, "no", true).unwrap();
        assert_eq!(next_wake(&store.outbox().unwrap(), 98), 15);
    }

    #[test]
    fn the_start_holds_the_letters_a_quit_cut_short_and_those_a_sleeping_machine_missed() {
        let store = store();
        let cut = queued(&store, 1, 0);
        store.outbox_sending(cut.id, 5).unwrap();
        let late = queued(&store, 1, 0);
        let fresh = queued(&store, 1_000_000, 0);
        assert!(hold_interrupted(&store, 10).unwrap());
        assert!(!hold_interrupted(&store, 10).unwrap(), "nothing more is cut short");
        let rows = store.outbox().unwrap();
        let by = |id| rows.iter().find(|i| i.id == id).unwrap();
        assert!(by(cut.id).failed && !by(late.id).failed);
        // Overdue by hours from before the app woke: held, with the word.
        let held = hold_missed(&store, 1_000_000 - 100, 1_000_000 - 200).unwrap();
        assert_eq!(held, [late.id]);
        assert!(store.outbox().unwrap().iter().all(|i| i.id == fresh.id || i.failed));
    }

    fn row(id: i64, next_attempt: i64, attempts: u32, failed: bool) -> OutboxItem {
        OutboxItem {
            id,
            account_id: "a".into(),
            draft: Draft::default(),
            attempts,
            next_attempt,
            last_error: None,
            failed,
            sending_started: 0,
            created: 0,
            followup_secs: 0,
            followup: FollowupPlan::default(),
        }
    }

    #[test]
    fn a_letter_late_by_minutes_is_missed() {
        let now = 1_000_000;
        // The app just started: a letter due before that and long overdue was missed.
        assert!(!missed(&row(1, now, 0, false), now, now));
        assert!(!missed(&row(1, now - MISSED_AFTER, 0, false), now, now));
        assert!(missed(&row(1, now - MISSED_AFTER - 1, 0, false), now, now));
        // A retry after a network error keeps its turn; a refused one waits already.
        assert!(!missed(&row(1, now - 3600, 2, false), now, now));
        assert!(!missed(&row(1, now - 3600, 0, true), now, now));
    }

    #[test]
    fn a_letter_held_back_while_the_app_ran_is_not_missed() {
        let now = 1_000_000;
        // The app has been running for two hours; a letter due an hour ago is overdue
        // because the queue or the network held it, not because the app was away: it
        // goes its usual way rather than waiting for the user.
        let awake = now - 7200;
        assert!(!missed(&row(1, now - 3600, 0, false), now, awake));
        // One due before the app started (while it was closed) is missed.
        assert!(missed(&row(1, now - 8000, 0, false), now, awake));
        // A letter whose send was already started is never a miss: the restart asks the
        // user to check «Sent» instead.
        let mut sending = row(1, now - 8000, 0, false);
        sending.sending_started = now - 9000;
        assert!(!missed(&sending, now, awake));
    }

    /// A copy that went through but whose finish keeps failing is not forgotten and not
    /// repeated at once: the pause grows (30 min, 2 h, 6 h) and the third failure puts it on
    /// hold, where it is no longer due.
    #[test]
    fn a_failing_finish_backs_off_and_is_held() {
        let store = Store::open_in_memory().unwrap();
        sent(&store);
        let now = 1_000;
        for (n, (wait, expect)) in [
            (1_800, Settled::Waiting),
            (7_200, Settled::Waiting),
            (21_600, Settled::Held),
        ]
        .into_iter()
        .enumerate()
        {
            let copy = store.sent_copies().unwrap().remove(0);
            assert_eq!(copy.refusals, n as u32);
            assert_eq!(
                settle_failed_finish(&store, &copy, "finish failed", false, now, DELAY).unwrap(),
                expect
            );
            assert_eq!(
                store.sent_copies().unwrap()[0].next_attempt,
                now + wait,
                "failure {}",
                n + 1
            );
        }
        assert!(
            store.sent_copies_due(i64::MAX).unwrap().is_empty(),
            "no automatic retry on hold"
        );
        assert_eq!(store.sent_copies_stuck().unwrap().len(), 1);
        assert_eq!(store.sent_copies().unwrap().len(), 1, "the copy is kept");
    }

    /// An accounts file that cannot be read lists no mailboxes: the copies wait, none is dropped.
    #[test]
    fn a_copy_of_an_unlisted_mailbox_stays() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent(&store);
        let due = store.sent_copies_due(i64::MAX).unwrap();
        assert!(with_known_mailbox(due.clone(), |_| false).is_empty());
        assert_eq!(store.sent_copies().unwrap().len(), 1);
        assert_eq!(with_known_mailbox(due, |id| id == copy.account_id).len(), 1);
    }

    /// A paused mailbox or a dead network does not lose the copy: it waits and goes once the
    /// mailbox answers, and the letter is not sent again meanwhile.
    #[test]
    fn a_copy_that_could_not_go_waits_and_goes_later() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent(&store);
        let now = 1_000;
        for failure in [
            Error::Paused,
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::NetworkUnreachable,
                "no network",
            )),
        ] {
            let copy = store.sent_copies().unwrap().remove(0);
            assert_eq!(
                settle_copy(&store, &copy, &Err(failure), now, DELAY).unwrap(),
                Settled::Waiting
            );
            assert!(store.sent_copies_due(now).unwrap().is_empty(), "not hammered at once");
            assert_eq!(store.sent_copies().unwrap().len(), 1, "the copy is kept");
            assert!(store.outbox().unwrap().is_empty(), "the letter is not sent twice");
        }
        let due = store.sent_copies_due(now + 3_600).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!((due[0].id, due[0].raw.as_slice()), (copy.id, &b"raw"[..]));
        assert_eq!(
            settle_copy(&store, &due[0], &Ok(()), now + 3_600, DELAY).unwrap(),
            Settled::Filed
        );
        assert!(store.sent_copies().unwrap().is_empty());
    }

    /// Only the worker's verdict counts as a refusal: a dead network or a paused mailbox
    /// passes by and is retried as before.
    #[test]
    fn a_refusal_is_told_from_a_trouble_that_passes() {
        assert!(copy_refused(&refused("mailbox is full")));
        assert!(!copy_refused(&Error::Timeout("operation")));
        assert!(!copy_refused(&Error::Closed));
        assert!(!copy_refused(&Error::Paused));
        assert!(!copy_refused(&Error::Io(std::io::Error::new(
            std::io::ErrorKind::NetworkUnreachable,
            "no network"
        ))));
    }

    /// Any `NO`/`BAD` is a refusal that is counted; the third in a row holds the copy, whatever code (or none) it carries.
    #[test]
    fn any_server_answer_three_times_puts_the_copy_on_hold() {
        for answer in ["BAD command", "NO [TRYAGAIN] later", "NO APPEND failed"] {
            let store = Store::open_in_memory().unwrap();
            sent(&store);
            for n in 0..3 {
                let copy = store.sent_copies().unwrap().remove(0);
                let got = settle_copy(&store, &copy, &Err(refused(answer)), 0, DELAY).unwrap();
                assert_eq!(got, if n == 2 { Settled::Held } else { Settled::Waiting });
            }
            assert_eq!(store.sent_copies_stuck().unwrap().len(), 1);
        }
    }

    /// A connection trouble (`Io`, timeout) is retried without touching the refusal count.
    #[test]
    fn a_connection_trouble_does_not_count_as_a_refusal() {
        let store = Store::open_in_memory().unwrap();
        sent(&store);
        for failure in [
            Error::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, "x")),
            Error::Timeout("operation"),
            Error::Closed,
        ] {
            assert!(!failure.append_refused());
            let copy = store.sent_copies().unwrap().remove(0);
            assert_eq!(
                settle_copy(&store, &copy, &Err(failure), 0, DELAY).unwrap(),
                Settled::Waiting
            );
        }
        assert_eq!(store.sent_copies().unwrap()[0].refusals, 0);
    }

    /// Refusals are waited out 30 min, 2 h, 6 h; the third puts the copy on hold, where it is
    /// neither due nor uploaded again, and the network's attempts do not count among them.
    #[test]
    fn a_copy_refused_three_times_is_put_on_hold() {
        let store = Store::open_in_memory().unwrap();
        sent(&store);
        let now = 10_000;
        // A dead network between the refusals does not count as one.
        let copy = store.sent_copies().unwrap().remove(0);
        assert_eq!(
            settle_copy(&store, &copy, &Err(Error::Closed), now, DELAY).unwrap(),
            Settled::Waiting
        );
        for (n, (wait, expect)) in [
            (1_800, Settled::Waiting),
            (7_200, Settled::Waiting),
            (21_600, Settled::Held),
        ]
        .into_iter()
        .enumerate()
        {
            let copy = store.sent_copies().unwrap().remove(0);
            assert_eq!(copy.refusals, n as u32);
            let got = settle_copy(&store, &copy, &Err(refused("OVERQUOTA full")), now, DELAY).unwrap();
            assert_eq!(got, expect);
            assert_eq!(
                store.sent_copies().unwrap()[0].next_attempt,
                now + wait,
                "refusal {}",
                n + 1
            );
        }
        assert!(
            store.sent_copies_due(i64::MAX).unwrap().is_empty(),
            "no automatic retry on hold"
        );
        let stuck = store.sent_copies_stuck().unwrap();
        assert_eq!(stuck.len(), 1);
        assert!(stuck[0].last_error.as_deref().unwrap().contains("full"));
        assert_eq!(
            store.sent_copies().unwrap()[0].raw,
            b"raw",
            "the letter is kept, not dropped"
        );
    }

    /// «Try again» lifts the hold and the count; «Don't keep» removes the copy.
    #[test]
    fn a_held_copy_can_be_resumed_or_dropped() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent(&store);
        let held = SentCopy {
            refusals: 2,
            ..copy.clone()
        };
        settle_copy(&store, &held, &Err(refused("OVERQUOTA")), 0, DELAY).unwrap();
        assert!(store.sent_copies_due(i64::MAX).unwrap().is_empty());
        assert!(store.sent_copy_resume(copy.id).unwrap());
        let due = store.sent_copies_due(0).unwrap();
        assert_eq!((due.len(), due[0].refusals, due[0].paused), (1, 0, false));
        // It is refused once more: the count starts from one again, not on hold.
        assert_eq!(
            settle_copy(&store, &due[0], &Err(refused("OVERQUOTA")), 0, DELAY).unwrap(),
            Settled::Waiting
        );
        store.sent_copy_done(copy.id).unwrap();
        assert!(store.sent_copies().unwrap().is_empty());
        assert!(!store.sent_copy_resume(copy.id).unwrap());
    }

    /// A copy the server took whose finish failed is marked as filed: its repeat does the
    /// finish only.
    #[test]
    fn a_copy_on_the_server_with_a_failed_finish_is_marked_filed() {
        let store = Store::open_in_memory().unwrap();
        sent(&store);
        for n in 0..3 {
            let copy = store.sent_copies().unwrap().remove(0);
            assert_eq!(copy.filed, n > 0, "the copy is marked after the first failure");
            settle_failed_finish(&store, &copy, "no database", true, 1_000, DELAY).unwrap();
        }
        let held: StuckCopy = store.sent_copies_stuck().unwrap().remove(0);
        assert!(held.filed);
        assert_eq!(held.last_error.as_deref(), Some("no database"));
    }

    /// «Don't keep» finds the wait still held for the copy, so it starts it before the copy goes.
    #[test]
    fn dropping_a_copy_does_not_lose_the_wait_held_for_it() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent_pending(&store);
        assert!(wait_before_drop(&copy).is_some());
        let plain = sent(&Store::open_in_memory().unwrap());
        assert!(wait_before_drop(&plain).is_none());
    }

    /// A wait that cannot start does not keep the copy: it is dropped, so that its task is
    /// not left to come back after every start.
    #[tokio::test]
    async fn dropping_a_copy_whose_wait_cannot_start_still_drops_it() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent_pending(&store);
        let failed = drop_with(&store, &copy, |_| async { Err("no database") })
            .await
            .unwrap();
        assert_eq!(failed, Some("no database"));
        assert!(store.sent_copies().unwrap().is_empty(), "the copy is gone");
    }

    async fn deliver(
        store: &Store,
        queue: Option<&mut Queue>,
        copy: &SentCopy,
        finishes: &std::sync::Mutex<Vec<bool>>,
        finish_fails: bool,
    ) -> CopyTry<&'static str> {
        deliver_copy(store, queue, copy, 1_000, DELAY, |_, cached| async move {
            finishes.lock().unwrap().push(cached);
            if finish_fails { Err("finish failed") } else { Ok(()) }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_copy_is_filed_once_and_the_wait_held_for_it_starts_with_it() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent_pending(&store);
        let (mut queue, finishes) = (Queue::default(), std::sync::Mutex::new(Vec::new()));
        let got = deliver(&store, Some(&mut queue), &copy, &finishes, false).await;
        assert_eq!(got.settled, Settled::Filed);
        assert_eq!(queue.copies, [("Sent".to_owned(), b"raw".to_vec())]);
        assert_eq!(
            *finishes.lock().unwrap(),
            [true],
            "the wait starts with the copy cached"
        );
        assert!(store.sent_copies().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_copy_the_server_took_is_not_uploaded_again() {
        let store = Store::open_in_memory().unwrap();
        let copy = SentCopy {
            filed: true,
            ..sent(&store)
        };
        let (mut queue, finishes) = (Queue::default(), std::sync::Mutex::new(Vec::new()));
        let got = deliver(&store, Some(&mut queue), &copy, &finishes, false).await;
        assert_eq!(got.settled, Settled::Filed);
        assert!(queue.copies.is_empty(), "only its local finish is repeated");
    }

    #[tokio::test]
    async fn a_copy_that_cannot_be_filed_waits_and_the_wait_for_a_reply_gives_up_on_it_at_the_third_try() {
        let store = Store::open_in_memory().unwrap();
        sent_pending(&store);
        let finishes = std::sync::Mutex::new(Vec::new());
        // The mailbox is not running: a trouble that passes. The wait is held for the copy.
        let copy = store.sent_copies().unwrap().remove(0);
        let got = deliver(&store, None, &copy, &finishes, false).await;
        assert_eq!(got.settled, Settled::Waiting);
        assert!(finishes.lock().unwrap().is_empty());
        // Two tries failed already: the third starts the wait without the copy, and forgets it.
        let third = SentCopy {
            attempts: COPY_WAIT_TRIES - 1,
            ..store.sent_copies().unwrap().remove(0)
        };
        let got = deliver(&store, None, &third, &finishes, false).await;
        assert_eq!(got.settled, Settled::Waiting);
        assert_eq!(*finishes.lock().unwrap(), [false]);
        assert!(
            store.sent_copies().unwrap()[0].pending.is_none(),
            "the wait does not start twice"
        );
        // A refusal for good starts it at once.
        let store = Store::open_in_memory().unwrap();
        let copy = sent_pending(&store);
        let finishes = std::sync::Mutex::new(Vec::new());
        let mut queue = Queue {
            copied: [Err(refused("OVERQUOTA"))].into(),
            ..Default::default()
        };
        let got = deliver(&store, Some(&mut queue), &copy, &finishes, false).await;
        assert_eq!(*finishes.lock().unwrap(), [false]);
        assert_eq!(got.settled, Settled::Waiting);
    }

    #[tokio::test]
    async fn a_finish_that_fails_is_counted_and_the_copy_is_kept_marked() {
        let store = Store::open_in_memory().unwrap();
        let copy = sent_pending(&store);
        let (mut queue, finishes) = (Queue::default(), std::sync::Mutex::new(Vec::new()));
        let got = deliver(&store, Some(&mut queue), &copy, &finishes, true).await;
        assert_eq!(got.finish_failed, Some("finish failed"));
        assert_eq!(got.settled, Settled::Waiting);
        let kept = store.sent_copies().unwrap().remove(0);
        assert!(
            kept.filed && kept.refusals == 1,
            "the server has it: only the finish is repeated"
        );
    }
}
