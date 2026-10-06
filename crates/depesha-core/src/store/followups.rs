//! "Waiting for reply": sent letters the user expects an answer to. A wait is waiting
//! until an answer comes (answered, with the date and author kept) or the user stops it
//! (closed by hand); either way it stays as history until it is older than the retention
//! the user set. A reminder may come again, wait for one recipient, and have a deadline
//! of its own apart from the reminder.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Store, add_column};
use crate::Result;
use crate::message::Addr;
use crate::smtp::Draft;

/// What a wait for an answer asks besides the time of the first reminder.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FollowupPlan {
    /// The answer is expected by this long after sending; 0: by the first reminder.
    pub deadline_secs: i64,
    /// The first reminder at this time (unix seconds) instead of `secs` after sending: a
    /// day of the week, a date, a time before a deadline do not move with the sending.
    /// 0: `secs` after sending.
    pub due_at: i64,
    /// The answer is expected by this time (unix seconds) instead of `deadline_secs`; 0: none.
    pub deadline_at: i64,
    /// Remind again this often until an answer comes; 0: once.
    pub repeat_secs: i64,
    /// Only an answer from this address counts; empty: from anyone.
    pub expect: String,
    /// The name of the choice the wait was set with, shown with it.
    pub kind: String,
}

/// Where a wait for an answer stands. Overdue is a waiting one past its deadline.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FollowupStatus {
    #[default]
    Waiting,
    /// An answer came: when and from whom is kept.
    Answered,
    /// The user stopped waiting.
    Closed,
}

/// Which waits a list of them shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FollowupFilter {
    /// Still waiting, overdue or not.
    #[default]
    Active,
    /// Answered or closed by hand.
    Closed,
}

/// A sent letter's wait for an answer, as a list row shows it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FollowupInfo {
    pub status: FollowupStatus,
    /// The next reminder.
    pub due: i64,
    pub deadline: i64,
    /// The deadline was given apart from the reminder ("a day before the deadline").
    pub own_deadline: bool,
    pub repeat_secs: i64,
    pub expect: String,
    pub kind: String,
    /// When it ended: the date of the answer, or when it was closed by hand.
    pub ended: Option<i64>,
    pub answered_by: Option<Addr>,
    /// The answer in the cache, when it is there.
    pub answer: Option<i64>,
    /// When the reminders came, oldest first.
    pub reminded: Vec<i64>,
}

/// The wait of a letter in a list row: the JSON the list query makes of it.
pub(super) fn info_of(json: Option<String>) -> Option<FollowupInfo> {
    json.and_then(|s| serde_json::from_str(&s).ok())
}

/// The next reminder of a wait still waiting.
pub(super) fn waiting_due(info: Option<&FollowupInfo>) -> Option<i64> {
    info.filter(|f| f.status == FollowupStatus::Waiting).map(|f| f.due)
}

/// The condition of a list of sent mail with a wait, `m` being the message: from the
/// waits to their letters, not through every message.
pub(super) fn list_condition(filter: FollowupFilter) -> String {
    let which = match filter {
        FollowupFilter::Active => "fu.status = 'waiting'",
        FollowupFilter::Closed => "fu.status != 'waiting'",
    };
    format!(
        " AND f.role = 'sent' AND m.id IN (SELECT x.id FROM followups fu CROSS JOIN messages x
            ON x.account_id = fu.account_id AND x.message_id = fu.message_id WHERE {which})"
    )
}

/// 6: a wait is kept when the answer comes or it is closed by hand, with its state, when it
/// ended, the author and Message-ID of the answer and the times it reminded; a reminder may
/// come again, wait for one recipient and be set apart from the deadline; a wait taken up
/// again counts only answers dated `since` then. The outbox carries
/// these from sending. Waits of earlier versions are still waiting, their deadline the
/// reminder's time.
pub(super) fn v6_followups_history(conn: &Connection) -> Result<()> {
    for (column, decl) in [
        ("status", "TEXT NOT NULL DEFAULT 'waiting'"),
        ("deadline", "INTEGER NOT NULL DEFAULT 0"),
        ("repeat_secs", "INTEGER NOT NULL DEFAULT 0"),
        ("expect", "TEXT NOT NULL DEFAULT ''"),
        ("kind", "TEXT NOT NULL DEFAULT ''"),
        ("ended", "INTEGER"),
        ("answered_by", "TEXT"),
        ("answer_id", "TEXT"),
        ("reminded", "TEXT NOT NULL DEFAULT '[]'"),
        ("own_deadline", "INTEGER NOT NULL DEFAULT 0"),
        ("since", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        add_column(conn, "followups", column, decl)?;
    }
    for (column, decl) in [
        ("followup_deadline_secs", "INTEGER NOT NULL DEFAULT 0"),
        ("followup_repeat_secs", "INTEGER NOT NULL DEFAULT 0"),
        ("followup_expect", "TEXT NOT NULL DEFAULT ''"),
        ("followup_kind", "TEXT NOT NULL DEFAULT ''"),
    ] {
        add_column(conn, "outbox", column, decl)?;
    }
    conn.execute_batch(
        "UPDATE followups SET deadline = due;
         CREATE INDEX followups_by_status ON followups (status, due);
         CREATE INDEX followups_by_end ON followups (ended) WHERE status != 'waiting';",
    )?;
    Ok(())
}

/// 9: the outbox keeps a reminder and a deadline set for a time, not counted from sending;
/// a wait notes since when its letter has been gone from the cache.
pub(super) fn v9_followup_times(conn: &Connection) -> Result<()> {
    for column in ["followup_due_at", "followup_deadline_at"] {
        add_column(conn, "outbox", column, "INTEGER NOT NULL DEFAULT 0")?;
    }
    add_column(conn, "followups", "missing", "INTEGER")?;
    Ok(())
}

/// A wait as it is started and announced.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Followup {
    pub account_id: String,
    pub message_id: String,
    pub subject: String,
    pub recipients: String,
    pub sent: i64,
    /// The next reminder.
    pub due: i64,
    /// When the answer is expected by; 0: by the first reminder.
    pub deadline: i64,
    /// Remind again this often until an answer comes; 0: once.
    pub repeat_secs: i64,
    /// Only an answer from this address counts, lowercase; empty: from anyone.
    pub expect: String,
    pub kind: String,
}

/// Repeats closer than this would be a stream of notifications.
pub(super) const MIN_REPEAT_SECS: i64 = 60;

/// A reminder or deadline comes a minute after sending at the soonest: a time that passed
/// while the letter waited in the outbox is not a reminder at once.
const MIN_DUE_SECS: i64 = 60;

impl Followup {
    /// The wait that begins when `draft` went out at `sent` as `message_id`: the first
    /// reminder `secs` later or at `plan.due_at`, the rest as `plan` asks. An awaited
    /// address the letter did not go to is dropped: no answer of theirs would come by it,
    /// so any answer counts.
    pub fn after_sending(
        account_id: &str,
        message_id: String,
        draft: &Draft,
        sent: i64,
        secs: i64,
        plan: &FollowupPlan,
    ) -> Self {
        let expect = plan.expect.trim().to_lowercase();
        let addressed = draft
            .to
            .iter()
            .chain(&draft.cc)
            .chain(&draft.bcc)
            .any(|a| a.email.to_lowercase() == expect);
        let recipients: Vec<&str> = draft.to.iter().chain(&draft.cc).map(|a| a.email.as_str()).collect();
        let soonest = sent + MIN_DUE_SECS;
        let due = if plan.due_at > 0 {
            plan.due_at.max(soonest)
        } else {
            sent + secs
        };
        let deadline = if plan.deadline_at > 0 {
            plan.deadline_at.max(soonest)
        } else if plan.deadline_secs > 0 {
            sent + plan.deadline_secs
        } else {
            due
        };
        Followup {
            account_id: account_id.to_owned(),
            message_id,
            subject: draft.subject.clone(),
            recipients: recipients.join(", "),
            sent,
            due,
            deadline,
            repeat_secs: if plan.repeat_secs > 0 {
                plan.repeat_secs.max(MIN_REPEAT_SECS)
            } else {
                0
            },
            expect: if addressed { expect } else { String::new() },
            kind: plan.kind.trim().to_owned(),
        }
    }
}

/// How many waits there are: still waiting, and kept after they ended.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct FollowupCounts {
    pub active: u32,
    pub closed: u32,
}

/// A waiting wait whose letter has been gone from the cache this long is forgotten: it can
/// be neither shown nor cancelled, and the letter is not coming back (a folder resynced
/// brings it back within minutes, and the wait with it).
const GONE_SECS: i64 = 7 * 86_400;

/// The reminders a wait remembers: the latest, not every one of a repeat that runs for months.
const REMINDED_KEPT: i64 = 20;

/// How far behind a reply's `Date` may be and still count after "wait for a reply again":
/// the sender's clock, not ours, dates it.
const CLOCK_SKEW_SECS: i64 = 15 * 60;

/// Closed waits are kept this long unless the user says otherwise.
pub const DEFAULT_KEEP_DAYS: u32 = 90;

impl Store {
    /// Starts waiting for an answer to a sent letter.
    pub fn followup_add(&self, f: &Followup) -> Result<()> {
        let deadline = if f.deadline > 0 { f.deadline } else { f.due };
        self.conn().execute(
            "INSERT OR REPLACE INTO followups
                (account_id, message_id, subject, recipients, sent, due, deadline, repeat_secs, expect, kind, own_deadline)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?7 != ?6)",
            params![
                f.account_id,
                f.message_id,
                f.subject,
                f.recipients,
                f.sent,
                f.due,
                deadline,
                f.repeat_secs,
                f.expect,
                f.kind
            ],
        )?;
        Ok(())
    }

    /// The user stops waiting: closed by hand at `now`, out of the active list.
    pub fn followup_close(&self, account_id: &str, message_id: &str, now: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE followups SET status = 'closed', ended = ?3
             WHERE account_id = ?1 AND message_id = ?2 AND status = 'waiting'",
            params![account_id, message_id.trim_matches(['<', '>']), now],
        )?;
        Ok(())
    }

    /// A new time for the reminder of a waiting letter; it is announced again when that
    /// comes. With `deadline` the answer is expected by then too.
    pub fn followup_postpone(&self, account_id: &str, message_id: &str, due: i64, deadline: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE followups SET due = ?3, notified = 0,
                deadline = CASE WHEN ?4 THEN ?3 ELSE deadline END,
                own_deadline = CASE WHEN ?4 THEN 0 ELSE own_deadline END
             WHERE account_id = ?1 AND message_id = ?2 AND status = 'waiting'",
            params![account_id, message_id.trim_matches(['<', '>']), due, deadline],
        )?;
        Ok(())
    }

    /// "Wait for a reply again" on a wait that ended, answered or closed by hand: waiting
    /// until `due`, and only an answer dated from `now` on ends it, give or take a sender's
    /// clock running a little behind; never one dated by the time it ended, as the answer
    /// that ended it was.
    pub fn followup_reopen(&self, account_id: &str, message_id: &str, due: i64, now: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE followups SET status = 'waiting', due = ?3, deadline = ?3, own_deadline = 0, notified = 0,
                since = MAX(?4 - ?5, COALESCE(ended, 0) + 1), ended = NULL, answered_by = NULL, answer_id = NULL
             WHERE account_id = ?1 AND message_id = ?2 AND status != 'waiting'",
            params![
                account_id,
                message_id.trim_matches(['<', '>']),
                due,
                now,
                CLOCK_SKEW_SECS
            ],
        )?;
        Ok(())
    }

    /// Marks waits that got an answer: the first message outside Sent and Drafts that
    /// replies to the sent one, its Message-ID in In-Reply-To or References exactly, and
    /// from the awaited address when there is one. Its date, sender and Message-ID are
    /// kept; the date is the sender's word, so it is kept between sending and now: a
    /// bogus one must not make the history look older (and pruned at once) or newer.
    /// Returns how many were answered.
    pub fn followups_resolve(&self) -> Result<usize> {
        let now = chrono::Utc::now().timestamp();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        type Waiting = (i64, String, String, String, i64, i64);
        let waiting: Vec<Waiting> = tx
            .prepare(
                "SELECT rowid, account_id, message_id, expect, since, sent FROM followups WHERE status = 'waiting'",
            )?
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })?
            .collect::<Result<_, _>>()?;
        let mut answered = 0;
        {
            // The candidates first, from the indexes: never through every message.
            let mut answer = tx.prepare(
                "SELECT m.date, m.from_addr, m.message_id FROM (
                     SELECT id FROM messages WHERE account_id = ?1 AND in_reply_to = ?2
                     UNION SELECT message FROM message_refs WHERE parent = ?2
                 ) c CROSS JOIN messages m ON m.id = c.id
                 JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
                 WHERE m.account_id = ?1 AND COALESCE(f.role, '') NOT IN ('sent', 'drafts')
                   AND (?3 = '' OR fold(json_extract(m.from_addr, '$.email')) = ?3) AND m.date >= ?4
                 ORDER BY m.date, m.id LIMIT 1",
            )?;
            let mut mark = tx.prepare(
                "UPDATE followups SET status = 'answered', ended = ?2, answered_by = ?3, answer_id = ?4
                 WHERE rowid = ?1",
            )?;
            for (rowid, account_id, message_id, expect, since, sent) in waiting {
                type Answer = (i64, Option<String>, Option<String>);
                let found: Option<Answer> = answer
                    .query_row(params![account_id, message_id, expect, since], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })
                    .optional()?;
                if let Some((date, from, id)) = found {
                    mark.execute(params![rowid, date.min(now).max(sent), from, id])?;
                    answered += 1;
                }
            }
        }
        tx.commit()?;
        Ok(answered)
    }

    /// Reminders due now that were not announced yet; each is noted in the wait's history,
    /// which keeps the last `REMINDED_KEPT` of them.
    /// One that repeats is set to the next of its times after `now`; any other is marked
    /// announced.
    pub fn followups_due(&self, now: i64) -> Result<Vec<Followup>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "UPDATE followups SET
                notified = repeat_secs <= 0,
                due = CASE WHEN repeat_secs > 0 THEN due + repeat_secs * ((?1 - due) / repeat_secs + 1) ELSE due END,
                reminded = (SELECT json_group_array(value ORDER BY key) FROM (
                    SELECT key, value FROM json_each(json_insert(
                        CASE WHEN json_valid(reminded) THEN reminded ELSE '[]' END, '$[#]', ?1))
                    ORDER BY key DESC LIMIT ?2))
             WHERE status = 'waiting' AND notified = 0 AND due <= ?1
               AND EXISTS (SELECT 1 FROM messages m
                   WHERE m.account_id = followups.account_id AND m.message_id = followups.message_id)
             RETURNING account_id, message_id, subject, recipients, sent, due, deadline, repeat_secs, expect, kind",
        )?;
        let rows = stmt.query_map([now, REMINDED_KEPT], |r| {
            Ok(Followup {
                account_id: r.get(0)?,
                message_id: r.get(1)?,
                subject: r.get(2)?,
                recipients: r.get(3)?,
                sent: r.get(4)?,
                due: r.get(5)?,
                deadline: r.get(6)?,
                repeat_secs: r.get(7)?,
                expect: r.get(8)?,
                kind: r.get(9)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Letters still waiting for an answer, and waits kept after they ended. A wait whose
    /// letter is no longer in the cache is not counted: it is not in the list either, and
    /// counting it would leave a badge pointing at nothing.
    pub fn followups_count(&self) -> Result<FollowupCounts> {
        Ok(self.conn().query_row(
            "SELECT COUNT(*) FILTER (WHERE fu.status = 'waiting'), COUNT(*) FILTER (WHERE fu.status != 'waiting')
             FROM followups fu
             WHERE EXISTS (SELECT 1 FROM messages m
                 WHERE m.account_id = fu.account_id AND m.message_id = fu.message_id)",
            [],
            |r| {
                Ok(FollowupCounts {
                    active: r.get(0)?,
                    closed: r.get(1)?,
                })
            },
        )?)
    }

    /// Forgets waits that ended more than `keep_days` days before `now`, and waiting ones
    /// whose letter has been gone from the cache for `GONE_SECS`; notes which letters are
    /// gone now. Returns how many were forgotten.
    pub fn followups_prune(&self, now: i64, keep_days: u32) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE followups SET missing = CASE WHEN missing IS NULL THEN ?1 END
             WHERE status = 'waiting' AND (missing IS NULL) = NOT EXISTS (SELECT 1 FROM messages m
                 WHERE m.account_id = followups.account_id AND m.message_id = followups.message_id)",
            [now],
        )?;
        let gone = tx.execute(
            "DELETE FROM followups WHERE status = 'waiting' AND missing < ?1",
            [now - GONE_SECS],
        )?;
        let ended = tx.execute(
            "DELETE FROM followups WHERE status != 'waiting' AND ended < ?1",
            [now - i64::from(keep_days) * 86_400],
        )?;
        tx.commit()?;
        Ok(gone + ended)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{from_to, mailbox, put, with_ids};
    use super::*;
    use crate::store::{ListQuery, MessageRow};

    fn listed(store: &Store, status: FollowupFilter) -> Vec<MessageRow> {
        store
            .list(&ListQuery {
                followups_only: true,
                followup_status: status,
                ..Default::default()
            })
            .unwrap()
    }

    fn subjects(store: &Store, status: FollowupFilter) -> Vec<String> {
        let mut s: Vec<String> = listed(store, status).into_iter().map(|r| r.subject).collect();
        s.sort();
        s
    }

    fn info(store: &Store, status: FollowupFilter, subject: &str) -> FollowupInfo {
        listed(store, status)
            .into_iter()
            .find(|r| r.subject == subject)
            .and_then(|r| r.followup)
            .unwrap()
    }

    fn wait_for(store: &Store, id: &str, due: i64, change: impl FnOnce(&mut Followup)) {
        let mut f = Followup {
            account_id: "a".into(),
            message_id: id.into(),
            subject: "Вопрос".into(),
            sent: 100,
            due,
            ..Default::default()
        };
        change(&mut f);
        store.followup_add(&f).unwrap();
    }

    #[test]
    fn followup_is_resolved_by_an_answer() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Вопрос", 100, "q@x", None), true);
        wait_for(&store, "q@x", 500, |f| f.recipients = "ivan@example.org".into());
        assert_eq!(listed(&store, FollowupFilter::Active)[0].followup_due, Some(500));
        assert!(store.followups_due(400).unwrap().is_empty());
        assert_eq!(store.followups_due(600).unwrap().len(), 1);
        assert!(store.followups_due(700).unwrap().is_empty(), "announced once");
        // Put off: it comes again at the new time, once.
        store.followup_postpone("a", "<q@x>", 900, false).unwrap();
        assert_eq!(listed(&store, FollowupFilter::Active)[0].followup_due, Some(900));
        assert!(store.followups_due(800).unwrap().is_empty());
        assert_eq!(store.followups_due(900).unwrap().len(), 1);
        assert_eq!(info(&store, FollowupFilter::Active, "Вопрос").reminded, [600, 900]);

        // My own follow-up in Sent is not an answer.
        put(
            &store,
            "Sent",
            2,
            &with_ids("Re: Вопрос", 150, "q2@x", Some("q@x")),
            true,
        );
        assert_eq!(store.followups_resolve().unwrap(), 0);
        let answer = put(
            &store,
            "INBOX",
            1,
            &with_ids("Re: Вопрос", 200, "r@x", Some("q@x")),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert!(listed(&store, FollowupFilter::Active).is_empty());
        // The answer itself is a click away.
        assert_eq!(info(&store, FollowupFilter::Closed, "Вопрос").answer, Some(answer));
    }

    #[test]
    fn an_awaited_answer_is_one_to_exactly_that_letter() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Вопрос", 100, "a_b@x", None), true);
        let waiting = || wait_for(&store, "a_b@x", 500, |_| {});
        waiting();
        // `_` and `%` are characters of the id, not wildcards.
        let mut uid = 0;
        for other in ["axb@x", "a%b@x"] {
            uid += 1;
            let mut s = with_ids("Re: Вопрос", 200, &format!("r{uid}@x"), None);
            s.references = vec!["root@x".into(), other.into()];
            put(&store, "INBOX", uid, &s, false);
        }
        assert_eq!(store.followups_resolve().unwrap(), 0);
        // In References, even not the last one.
        let mut s = with_ids("Re: Вопрос", 300, "r3@x", None);
        s.references = vec!["a_b@x".into(), "later@x".into()];
        put(&store, "INBOX", 3, &s, false);
        assert_eq!(store.followups_resolve().unwrap(), 1);
        // In In-Reply-To alone.
        waiting();
        store.remove_uids("a", "INBOX", &[3]).unwrap();
        assert_eq!(store.followups_resolve().unwrap(), 0);
        let mut s = with_ids("Re: Вопрос", 400, "r4@x", None);
        s.in_reply_to = Some("a_b@x".into());
        put(&store, "INBOX", 4, &s, false);
        assert_eq!(store.followups_resolve().unwrap(), 1);
    }

    #[test]
    fn a_reminder_repeats_until_the_answer_comes() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Вопрос", 100, "q@x", None), true);
        wait_for(&store, "q@x", 500, |f| f.repeat_secs = 300);
        assert!(store.followups_due(499).unwrap().is_empty());
        // Announced, and due again a period later.
        let due = store.followups_due(500).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].due, 800);
        assert!(store.followups_due(799).unwrap().is_empty());
        assert_eq!(store.followups_due(800).unwrap().len(), 1);
        // The app was off for a while: one reminder, the next one in the future, on the grid.
        let due = store.followups_due(2_050).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].due, 2_300);
        // The deadline stays where it was: the letter is overdue since then.
        let row = &listed(&store, FollowupFilter::Active)[0];
        assert_eq!(row.followup_due, Some(2_300));
        let f = row.followup.as_ref().unwrap();
        assert_eq!((f.deadline, f.reminded.as_slice()), (500, &[500, 800, 2_050][..]));
        // Repeats for months keep only the latest reminders.
        let mut at = 2_300;
        for _ in 0..30 {
            store.followups_due(at).unwrap();
            at += 300;
        }
        let f = info(&store, FollowupFilter::Active, "Вопрос");
        assert_eq!(f.reminded.len(), REMINDED_KEPT as usize);
        assert_eq!(f.reminded.first(), Some(&(at - 300 * REMINDED_KEPT)));
        assert_eq!(f.reminded.last(), Some(&(at - 300)));
        // An answer stops the repeats.
        put(
            &store,
            "INBOX",
            1,
            &with_ids("Re: Вопрос", 2_100, "r@x", Some("q@x")),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert!(store.followups_due(10_000).unwrap().is_empty());
    }

    #[test]
    fn a_wait_whose_letter_left_the_cache_is_not_counted_or_reminded() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Вопрос", 100, "q@x", None), true);
        wait_for(&store, "q@x", 500, |_| {});
        assert_eq!(store.followups_count().unwrap().active, 1);
        // The sent letter left the cache (a recreated folder, an expunge, a cleared Sent):
        // the wait can no longer be shown or cancelled, so it must not be counted or remind.
        store.remove_uids("a", "Sent", &[1]).unwrap();
        assert!(listed(&store, FollowupFilter::Active).is_empty());
        assert_eq!(store.followups_count().unwrap().active, 0);
        assert!(store.followups_due(600).unwrap().is_empty());
        // A letter with the same id coming back makes the wait visible and countable again.
        put(&store, "Sent", 2, &with_ids("Вопрос", 100, "q@x", None), true);
        assert_eq!(store.followups_count().unwrap().active, 1);
        assert_eq!(store.followups_due(600).unwrap().len(), 1);
    }

    #[test]
    fn a_letter_is_found_by_message_id_in_any_folder() {
        // The outbox asks this after a failed copy and a Sent sync: a wait may only be
        // added while its letter is in the cache, wherever the copy was filed.
        let store = mailbox();
        assert_eq!(store.find_any_by_message_id("a", "q@x").unwrap(), None);
        let id = put(&store, "Sent", 1, &with_ids("Вопрос", 100, "q@x", None), true);
        assert_eq!(store.find_any_by_message_id("a", "q@x").unwrap(), Some(id));
        // Angle brackets and the folder are irrelevant.
        assert_eq!(store.find_any_by_message_id("a", "<q@x>").unwrap(), Some(id));
        // Another account's letter with the same id is not this account's.
        assert_eq!(store.find_any_by_message_id("b", "q@x").unwrap(), None);
    }

    #[test]
    fn an_answer_counts_only_from_the_awaited_recipient() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Вопрос", 100, "q@x", None), true);
        wait_for(&store, "q@x", 500, |f| f.expect = "boss@example.org".into());
        // A colleague in copy answers first: still waiting.
        let colleague = from_to(
            with_ids("Re: Вопрос", 200, "r1@x", Some("q@x")),
            "colleague@example.org",
            "me@x",
        );
        put(&store, "INBOX", 1, &colleague, false);
        assert_eq!(store.followups_resolve().unwrap(), 0);
        assert_eq!(store.followups_count().unwrap().active, 1);
        // The awaited one answers the colleague, not the letter: not linked to it.
        let unlinked = from_to(
            with_ids("Re: Вопрос", 300, "r2@x", Some("r1@x")),
            "Boss@Example.org",
            "me@x",
        );
        put(&store, "INBOX", 2, &unlinked, false);
        assert_eq!(store.followups_resolve().unwrap(), 0);
        // Linked by References, the address spelled in capitals.
        let mut s = from_to(
            with_ids("Re: Вопрос", 400, "r3@x", Some("r1@x")),
            "Boss@Example.org",
            "me@x",
        );
        s.references = vec!["q@x".into(), "r1@x".into()];
        put(&store, "INBOX", 3, &s, false);
        assert_eq!(store.followups_resolve().unwrap(), 1);
        let f = info(&store, FollowupFilter::Closed, "Вопрос");
        assert_eq!((f.status, f.ended), (FollowupStatus::Answered, Some(400)));
        assert_eq!(f.answered_by.unwrap().email, "Boss@Example.org");
    }

    #[test]
    fn a_wait_ends_answered_or_closed_and_stays_in_the_history() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Вопрос", 100, "q1@x", None), true);
        put(&store, "Sent", 2, &with_ids("Смета", 110, "q2@x", None), true);
        put(&store, "Sent", 3, &with_ids("Отчёт", 120, "q3@x", None), true);
        let now = chrono::Utc::now().timestamp();
        wait_for(&store, "q1@x", now + 86_400, |f| f.kind = "Каждые 3 дня".into());
        wait_for(&store, "q2@x", now - 60, |_| {});
        wait_for(&store, "q3@x", now + 3_600, |f| f.deadline = now + 90_000);
        assert_eq!(subjects(&store, FollowupFilter::Active), ["Вопрос", "Отчёт", "Смета"]);
        assert_eq!(
            store.followups_count().unwrap(),
            FollowupCounts { active: 3, closed: 0 }
        );
        assert_eq!(info(&store, FollowupFilter::Active, "Вопрос").kind, "Каждые 3 дня");

        // An answer: kept with its date and author, out of the active list.
        let mut s = from_to(
            with_ids("Re: Вопрос", 300, "r@x", Some("q1@x")),
            "ivan@example.org",
            "me@x",
        );
        s.from.as_mut().unwrap().name = Some("Иван".into());
        put(&store, "INBOX", 1, &s, false);
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert_eq!(store.followups_resolve().unwrap(), 0, "once");
        // Closed by hand.
        store.followup_close("a", "<q2@x>", 700).unwrap();
        assert_eq!(subjects(&store, FollowupFilter::Active), ["Отчёт"]);
        assert_eq!(subjects(&store, FollowupFilter::Closed), ["Вопрос", "Смета"]);
        assert_eq!(
            store.followups_count().unwrap(),
            FollowupCounts { active: 1, closed: 2 }
        );
        let answered = listed(&store, FollowupFilter::Closed)
            .into_iter()
            .find(|r| r.subject == "Вопрос")
            .unwrap();
        assert_eq!(answered.followup_due, None, "not waiting");
        let f = answered.followup.unwrap();
        assert_eq!((f.status, f.ended), (FollowupStatus::Answered, Some(300)));
        assert_eq!(f.answered_by.unwrap().name.as_deref(), Some("Иван"));
        let closed = info(&store, FollowupFilter::Closed, "Смета");
        assert_eq!((closed.status, closed.ended), (FollowupStatus::Closed, Some(700)));
        // Neither reminds any more.
        assert_eq!(store.followups_due(now + 200_000).unwrap().len(), 1);

        // "Remind tomorrow" moves the reminder only; it does not reopen a closed wait.
        store.followup_postpone("a", "q3@x", now + 7_200, false).unwrap();
        let f = info(&store, FollowupFilter::Active, "Отчёт");
        assert_eq!((f.due, f.deadline), (now + 7_200, now + 90_000));
        store.followup_postpone("a", "q2@x", now + 7_200, false).unwrap();
        assert_eq!(
            info(&store, FollowupFilter::Closed, "Смета").status,
            FollowupStatus::Closed
        );
        // "Wait for a reply again": waiting, the deadline with the reminder.
        store.followup_reopen("a", "q2@x", now + 7_200, now).unwrap();
        let f = info(&store, FollowupFilter::Active, "Смета");
        assert_eq!((f.due, f.deadline, f.ended), (now + 7_200, now + 7_200, None));
        // Reopening a waiting one changes nothing.
        store.followup_reopen("a", "q3@x", now + 10, now).unwrap();
        assert_eq!(info(&store, FollowupFilter::Active, "Отчёт").due, now + 7_200);
        // An answered one too: the answer that came before does not end it again.
        store.followup_reopen("a", "q1@x", now + 7_200, now).unwrap();
        assert_eq!(store.followups_resolve().unwrap(), 0);
        let f = info(&store, FollowupFilter::Active, "Вопрос");
        assert_eq!(
            (f.status, f.answered_by, f.answer),
            (FollowupStatus::Waiting, None, None)
        );
        // A new one does, even from a clock a few minutes behind.
        put(
            &store,
            "INBOX",
            2,
            &with_ids("Re: Вопрос", now - 300, "r2@x", Some("q1@x")),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert_eq!(info(&store, FollowupFilter::Closed, "Вопрос").ended, Some(now - 300));
    }

    #[test]
    fn an_answer_dated_wrong_does_not_skew_the_history() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Вопрос", 100_000, "q@x", None), true);
        wait_for(&store, "q@x", 200_000, |f| f.sent = 100_000);
        // Dated long before the letter: it ended no earlier than the letter went out, so
        // the retention does not forget it at once.
        put(
            &store,
            "INBOX",
            1,
            &with_ids("Re: Вопрос", 5, "r1@x", Some("q@x")),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert_eq!(info(&store, FollowupFilter::Closed, "Вопрос").ended, Some(100_000));
        assert_eq!(store.followups_prune(100_000 + 86_400, 90).unwrap(), 0);
        // Taken up again right away: the answer that ended it does not end it again, even
        // though "now" is within a clock's lag of it.
        store.followup_reopen("a", "q@x", 300_000, 100_100).unwrap();
        assert_eq!(store.followups_resolve().unwrap(), 0);
        // Dated in the future: it ended by now, not later.
        put(
            &store,
            "INBOX",
            2,
            &with_ids("Re: Вопрос", i64::MAX / 2, "r2@x", Some("q@x")),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        let ended = info(&store, FollowupFilter::Closed, "Вопрос").ended.unwrap();
        assert!(ended <= chrono::Utc::now().timestamp());

        // An answer a minute before "wait again" is within a clock's lag, yet it is the one
        // that ended the wait: not counted again.
        put(&store, "Sent", 2, &with_ids("Смета", 100_000, "s@x", None), true);
        wait_for(&store, "s@x", 200_000, |f| f.sent = 100_000);
        put(
            &store,
            "INBOX",
            3,
            &with_ids("Re: Смета", 100_040, "r3@x", Some("s@x")),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        store.followup_reopen("a", "s@x", 300_000, 100_100).unwrap();
        assert_eq!(store.followups_resolve().unwrap(), 0);
    }

    #[test]
    fn a_deadline_of_its_own_is_told_apart() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Смета", 100, "q@x", None), true);
        wait_for(&store, "q@x", 500, |f| f.deadline = 900);
        let f = info(&store, FollowupFilter::Active, "Смета");
        assert_eq!((f.due, f.deadline, f.own_deadline), (500, 900, true));
        // "Remind tomorrow" keeps it; a new date is the deadline.
        store.followup_postpone("a", "q@x", 600, false).unwrap();
        assert!(info(&store, FollowupFilter::Active, "Смета").own_deadline);
        store.followup_postpone("a", "q@x", 1_000, true).unwrap();
        let f = info(&store, FollowupFilter::Active, "Смета");
        assert_eq!((f.due, f.deadline, f.own_deadline), (1_000, 1_000, false));
    }

    #[test]
    fn ended_waits_are_forgotten_after_the_retention() {
        let store = mailbox();
        for (uid, id) in [(1, "old@x"), (2, "recent@x"), (3, "open@x")] {
            put(&store, "Sent", uid, &with_ids(id, 100, id, None), true);
            wait_for(&store, id, 500, |f| f.subject = id.into());
        }
        let day = 86_400;
        let now = 200 * day;
        store.followup_close("a", "old@x", now - 91 * day).unwrap();
        store.followup_close("a", "recent@x", now - 89 * day).unwrap();
        // Waiting ones stay however old they are.
        assert_eq!(store.followups_prune(now, 90).unwrap(), 1);
        assert_eq!(subjects(&store, FollowupFilter::Closed), ["recent@x"]);
        assert_eq!(subjects(&store, FollowupFilter::Active), ["open@x"]);
        // A shorter retention takes more.
        assert_eq!(store.followups_prune(now, 30).unwrap(), 1);
        assert_eq!(
            store.followups_count().unwrap(),
            FollowupCounts { active: 1, closed: 0 }
        );
    }

    #[test]
    fn a_wait_whose_letter_is_gone_for_good_is_forgotten() {
        let store = mailbox();
        let day = 86_400;
        for (uid, id) in [(1, "kept@x"), (2, "gone@x")] {
            put(&store, "Sent", uid, &with_ids(id, 100, id, None), true);
            wait_for(&store, id, 500, |f| f.subject = id.into());
        }
        let now = 100 * day;
        // Gone for a while: the wait waits a week for the letter to come back.
        store.remove_uids("a", "Sent", &[2]).unwrap();
        assert_eq!(store.followups_prune(now, 90).unwrap(), 0);
        assert_eq!(store.followups_prune(now + 6 * day, 90).unwrap(), 0);
        // Back (a resynced folder): it counts from the start when it goes again.
        put(&store, "Sent", 3, &with_ids("gone@x", 100, "gone@x", None), true);
        assert_eq!(store.followups_prune(now + 6 * day, 90).unwrap(), 0);
        store.remove_uids("a", "Sent", &[3]).unwrap();
        assert_eq!(store.followups_prune(now + 10 * day, 90).unwrap(), 0);
        assert_eq!(store.followups_prune(now + 16 * day, 90).unwrap(), 0);
        assert_eq!(store.followups_prune(now + 17 * day + 1, 90).unwrap(), 1);
        // The one whose letter stayed stays, however old.
        put(&store, "Sent", 4, &with_ids("gone@x", 100, "gone@x", None), true);
        assert_eq!(subjects(&store, FollowupFilter::Active), ["kept@x"]);
    }

    #[test]
    fn a_wait_is_made_from_the_letter_sent() {
        let addr = |email: &str| Addr {
            name: None,
            email: email.into(),
        };
        let draft = Draft {
            to: vec![addr("ivan@example.org")],
            cc: vec![addr("Boss@Example.org")],
            bcc: vec![addr("hidden@example.org")],
            subject: "Смета".into(),
            ..Default::default()
        };
        let plan = FollowupPlan {
            deadline_secs: 86_400,
            repeat_secs: 10,
            expect: " BOSS@example.org ".into(),
            kind: "За сутки до срока".into(),
            ..Default::default()
        };
        let f = Followup::after_sending("a", "m@x".into(), &draft, 1_000, 3_600, &plan);
        assert_eq!(f.recipients, "ivan@example.org, Boss@Example.org");
        assert_eq!((f.due, f.deadline), (4_600, 87_400));
        assert_eq!(f.repeat_secs, MIN_REPEAT_SECS, "not a stream of notifications");
        assert_eq!(f.expect, "boss@example.org");
        assert_eq!(f.kind, "За сутки до срока");
        // Without a deadline of its own, the first reminder is the deadline.
        let f = Followup::after_sending("a", "m@x".into(), &draft, 1_000, 3_600, &FollowupPlan::default());
        assert_eq!(
            (f.due, f.deadline, f.repeat_secs, f.expect.as_str()),
            (4_600, 4_600, 0, "")
        );
        // Someone the letter did not go to: any answer counts.
        let expect = |who: &str| {
            let plan = FollowupPlan {
                expect: who.into(),
                ..Default::default()
            };
            Followup::after_sending("a", "m@x".into(), &draft, 0, 60, &plan).expect
        };
        assert_eq!(expect("stranger@example.org"), "");
        assert_eq!(expect("hidden@example.org"), "hidden@example.org");
    }

    #[test]
    fn a_reminder_set_for_a_time_does_not_move_with_the_sending() {
        let draft = Draft::default();
        // "Monday 9:00" chosen at 1_000, the letter left 40 minutes later: still at 9:00,
        // and so is the deadline set for a day.
        let plan = FollowupPlan {
            due_at: 90_000,
            deadline_at: 100_000,
            deadline_secs: 99_000,
            ..Default::default()
        };
        let f = Followup::after_sending("a", "m@x".into(), &draft, 3_400, 89_000, &plan);
        assert_eq!((f.due, f.deadline), (90_000, 100_000));
        // Sent after both had passed (the outbox waited): a minute later, never at once.
        let f = Followup::after_sending("a", "m@x".into(), &draft, 200_000, 89_000, &plan);
        assert_eq!((f.due, f.deadline), (200_060, 200_060));
        // A plan of an earlier version, only counted from sending, works as it did.
        let old = FollowupPlan {
            deadline_secs: 7_200,
            ..Default::default()
        };
        let f = Followup::after_sending("a", "m@x".into(), &draft, 1_000, 3_600, &old);
        assert_eq!((f.due, f.deadline), (4_600, 8_200));
        let old: FollowupPlan =
            serde_json::from_str(r#"{"deadline_secs":7200,"repeat_secs":0,"expect":"","kind":""}"#).unwrap();
        assert_eq!((old.due_at, old.deadline_at), (0, 0));
    }

    #[test]
    fn the_outbox_keeps_what_the_wait_asks() {
        let store = mailbox();
        let plan = FollowupPlan {
            deadline_secs: 7_200,
            due_at: 50_000,
            deadline_at: 60_000,
            repeat_secs: 86_400,
            expect: "ivan@example.org".into(),
            kind: "Каждый день".into(),
        };
        store.outbox_add("a", &Draft::default(), 1, 1, 3_600, &plan).unwrap();
        let item = &store.outbox().unwrap()[0];
        assert_eq!((item.followup_secs, &item.followup), (3_600, &plan));
    }
}
