//! What was done with a letter: answered, answered to all, forwarded (#55). Depesha
//! marks a letter itself, with the time, the moment its answer or forward leaves; the
//! server's flags (`\\Answered`, `$Forwarded`, Exchange's last verb) add what other
//! clients did, without a time, and never take Depesha's marks away. The marks are kept
//! by Message-ID: they follow the letter from folder to folder.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::{Store, add_column};
use crate::Result;
use crate::imap::Flags;
use crate::smtp::Act;

/// One thing done with a letter, as its row shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    pub act: Act,
    /// When Depesha did it; none when only the server says so: the time is unknown.
    pub at: Option<i64>,
}

/// An answer or forward of the letter waiting in the outbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outgoing {
    pub act: Act,
    /// When it leaves.
    pub at: i64,
    /// It takes the letter to wait for a reply when it leaves.
    pub park: bool,
    /// Sent later at a time of the user's, not after the undo delay: nothing is done yet.
    pub scheduled: bool,
}

/// When Depesha last answered, answered to all and forwarded a letter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Done {
    pub reply: Option<i64>,
    pub reply_all: Option<i64>,
    pub forward: Option<i64>,
}

/// A letter left the outbox this long after it was queued at the most is no "send later":
/// the undo delay is set in seconds.
pub(super) const UNDO_MAX_SECS: i64 = 60;

/// 10: the forward and the answer to all the servers tell, the marks Depesha keeps, and
/// what letter an answer in the outbox is for.
pub(super) fn v10_reply_marks(conn: &Connection) -> Result<()> {
    for column in ["forwarded", "answered_all"] {
        add_column(conn, "messages", column, "INTEGER NOT NULL DEFAULT 0")?;
    }
    for (column, decl) in [("acts_on", "TEXT"), ("acts_kind", "TEXT"), ("followup_park", "INTEGER")] {
        add_column(conn, "outbox", column, decl)?;
    }
    conn.execute_batch(
        "-- What Depesha did with a letter, by Message-ID, and the answer it sent last.
         CREATE TABLE marks (
             account_id TEXT NOT NULL,
             message_id TEXT NOT NULL,
             reply      INTEGER,
             reply_all  INTEGER,
             forward    INTEGER,
             answer     TEXT,
             PRIMARY KEY (account_id, message_id)
         ) WITHOUT ROWID;
         CREATE INDEX outbox_by_letter ON outbox (account_id, acts_on) WHERE acts_on IS NOT NULL;",
    )?;
    Ok(())
}

/// The marks of a letter: Depesha's own, an answer on its way, then what the server knows
/// besides them. A reply and a reply to all are two marks; the row decides how to show them.
pub fn marks_of(flags: &Flags, done: &Done, outgoing: Option<&Outgoing>) -> Vec<Mark> {
    let mut at = [done.reply, done.reply_all, done.forward];
    if let Some(o) = outgoing.filter(|o| !o.scheduled) {
        let i = slot(o.act);
        at[i] = Some(at[i].map_or(o.at, |t| t.max(o.at)));
    }
    let mine = |act| at[slot(act)].map(|t| Mark { act, at: Some(t) });
    let mut out = Vec::new();
    // Exchange's reply to all comes with \Answered: one act, not two.
    let answered_by_me = at[0].is_some() || at[1].is_some();
    match mine(Act::Reply) {
        Some(m) => out.push(m),
        None if flags.answered && !flags.answered_all && !answered_by_me => out.push(Mark {
            act: Act::Reply,
            at: None,
        }),
        None => {}
    }
    match mine(Act::ReplyAll) {
        Some(m) => out.push(m),
        None if flags.answered_all => out.push(Mark {
            act: Act::ReplyAll,
            at: None,
        }),
        None => {}
    }
    match mine(Act::Forward) {
        Some(m) => out.push(m),
        None if flags.forwarded => out.push(Mark {
            act: Act::Forward,
            at: None,
        }),
        None => {}
    }
    out
}

fn slot(act: Act) -> usize {
    match act {
        Act::Reply => 0,
        Act::ReplyAll => 1,
        Act::Forward => 2,
    }
}

/// The marks Depesha keeps for a letter as the list query reads them: `[reply, reply_all,
/// forward, the row of my latest answer]`.
pub(super) fn done_of(json: Option<String>) -> (Done, Option<i64>) {
    let Some(v) = json.and_then(|s| serde_json::from_str::<[Option<i64>; 4]>(&s).ok()) else {
        return (Done::default(), None);
    };
    (
        Done {
            reply: v[0],
            reply_all: v[1],
            forward: v[2],
        },
        v[3],
    )
}

/// The answer in the outbox as the list query reads it.
pub(super) fn outgoing_of(json: Option<String>) -> Option<Outgoing> {
    #[derive(Deserialize)]
    struct Raw {
        act: String,
        at: i64,
        park: Option<bool>,
        queued: i64,
    }
    let raw: Raw = serde_json::from_str(&json?).ok()?;
    Some(Outgoing {
        act: Act::parse(&raw.act)?,
        at: raw.at,
        park: raw.park.unwrap_or(false),
        scheduled: raw.at - raw.queued > UNDO_MAX_SECS,
    })
}

impl Store {
    /// Depesha did `act` with the letter at `at`; `answer` is the Message-ID of the letter
    /// that did it, kept for an answer: "open" in the letter's header shows it.
    pub fn mark_done(&self, account_id: &str, message_id: &str, act: Act, at: i64, answer: Option<&str>) -> Result<()> {
        let column = match act {
            Act::Reply => "reply",
            Act::ReplyAll => "reply_all",
            Act::Forward => "forward",
        };
        let answer = answer.filter(|_| act.answers()).map(|a| a.trim_matches(['<', '>']));
        self.conn().execute(
            &format!(
                "INSERT INTO marks (account_id, message_id, {column}, answer) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (account_id, message_id) DO UPDATE SET
                    {column} = MAX(COALESCE({column}, 0), excluded.{column}),
                    answer = COALESCE(excluded.answer, answer)"
            ),
            params![account_id, message_id.trim_matches(['<', '>']), at, answer],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{mailbox, put, with_ids};
    use super::*;
    use crate::imap::Flags;
    use crate::smtp::{Act, ActsOn, Draft};
    use crate::store::{FollowupPlan, ListQuery, MessageRow};

    fn mark(act: Act, at: Option<i64>) -> Mark {
        Mark { act, at }
    }

    fn row(store: &Store, id: i64) -> MessageRow {
        store.get(id).unwrap().unwrap()
    }

    fn server(change: impl FnOnce(&mut Flags)) -> Flags {
        let mut f = Flags {
            seen: true,
            ..Default::default()
        };
        change(&mut f);
        f
    }

    #[test]
    fn the_server_tells_a_reply_and_depesha_tells_which_and_when() {
        let none = Done::default();
        // IMAP knows only \Answered: a reply, the time unknown.
        assert_eq!(
            marks_of(&server(|f| f.answered = true), &none, None),
            [mark(Act::Reply, None)]
        );
        // Exchange tells a reply to all; its \Answered is the same act, not a second one.
        let all = server(|f| {
            f.answered = true;
            f.answered_all = true;
        });
        assert_eq!(marks_of(&all, &none, None), [mark(Act::ReplyAll, None)]);
        assert_eq!(
            marks_of(&server(|f| f.forwarded = true), &none, None),
            [mark(Act::Forward, None)]
        );
        assert!(marks_of(&server(|_| {}), &none, None).is_empty());

        // Depesha's own mark is exact and has its time; the server's \Answered is that reply.
        let mine = Done {
            reply_all: Some(500),
            ..Default::default()
        };
        assert_eq!(
            marks_of(&server(|f| f.answered = true), &mine, None),
            [mark(Act::ReplyAll, Some(500))]
        );
        // A reply and a reply to all both stay, in that order, the forward after them.
        let both = Done {
            reply: Some(400),
            reply_all: Some(500),
            forward: None,
        };
        assert_eq!(
            marks_of(&server(|f| f.forwarded = true), &both, None),
            [
                mark(Act::Reply, Some(400)),
                mark(Act::ReplyAll, Some(500)),
                mark(Act::Forward, None)
            ]
        );
        // Another client answered all on Exchange after my reply: both are shown.
        let reply = Done {
            reply: Some(400),
            ..Default::default()
        };
        assert_eq!(
            marks_of(&all, &reply, None),
            [mark(Act::Reply, Some(400)), mark(Act::ReplyAll, None)]
        );
        // The server lost its flag: what Depesha did stays.
        assert_eq!(marks_of(&server(|_| {}), &reply, None), [mark(Act::Reply, Some(400))]);
    }

    #[test]
    fn an_answer_on_its_way_marks_the_letter_at_once_unless_it_waits_for_later() {
        let going = |act, scheduled| Outgoing {
            act,
            at: 900,
            park: false,
            scheduled,
        };
        let nothing = Done::default();
        assert_eq!(
            marks_of(&server(|_| {}), &nothing, Some(&going(Act::Forward, false))),
            [mark(Act::Forward, Some(900))]
        );
        // "Send later": nothing is answered until it leaves.
        assert!(marks_of(&server(|_| {}), &nothing, Some(&going(Act::Reply, true))).is_empty());
        // Answered before and again now: the latest time.
        let before = Done {
            reply: Some(400),
            ..Default::default()
        };
        assert_eq!(
            marks_of(&server(|_| {}), &before, Some(&going(Act::Reply, false))),
            [mark(Act::Reply, Some(900))]
        );
    }

    #[test]
    fn depesha_marks_a_letter_it_answered_and_syncs_do_not_take_the_mark_away() {
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Счёт", 100, "q@x", None), true);
        assert!(row(&store, id).marks.is_empty());
        store.mark_done("a", "<q@x>", Act::Reply, 500, Some("r@x")).unwrap();
        assert_eq!(row(&store, id).marks, [mark(Act::Reply, Some(500))]);
        // A sync from before the server stored \Answered.
        store.update_flags("a", "INBOX", &[(1, server(|_| {}))]).unwrap();
        assert_eq!(row(&store, id).marks, [mark(Act::Reply, Some(500))]);
        // A forward from another client comes with the server and goes with it.
        store
            .update_flags("a", "INBOX", &[(1, server(|f| f.forwarded = true))])
            .unwrap();
        assert!(row(&store, id).flags.forwarded);
        assert_eq!(
            row(&store, id).marks,
            [mark(Act::Reply, Some(500)), mark(Act::Forward, None)]
        );
        store.update_flags("a", "INBOX", &[(1, server(|_| {}))]).unwrap();
        assert_eq!(row(&store, id).marks, [mark(Act::Reply, Some(500))]);

        // My answer is a click away once it is in the cache.
        assert_eq!(row(&store, id).my_answer, None);
        let answer = put(&store, "Sent", 1, &with_ids("Re: Счёт", 500, "r@x", Some("q@x")), true);
        assert_eq!(row(&store, id).my_answer, Some(answer));
        // Answered all later: both acts, and the later answer is the one to open.
        store.mark_done("a", "q@x", Act::ReplyAll, 700, Some("r2@x")).unwrap();
        assert_eq!(
            row(&store, id).marks,
            [mark(Act::Reply, Some(500)), mark(Act::ReplyAll, Some(700))]
        );
        assert_eq!(row(&store, id).my_answer, None, "not cached yet");
        // A forward does not change which answer opens.
        let later = put(&store, "Sent", 2, &with_ids("Re: Счёт", 700, "r2@x", Some("q@x")), true);
        store.mark_done("a", "q@x", Act::Forward, 800, Some("f@x")).unwrap();
        assert_eq!(row(&store, id).my_answer, Some(later));

        // Lists carry them, grouped or not.
        for threads in [false, true] {
            let rows = store
                .list(&ListQuery {
                    threads,
                    ..Default::default()
                })
                .unwrap();
            let r = rows.iter().find(|r| r.message_id.as_deref() == Some("q@x")).unwrap();
            assert_eq!(r.marks.len(), 3, "threads: {threads}");
        }
    }

    #[test]
    fn the_mark_follows_the_letter_into_another_folder() {
        let store = mailbox();
        put(&store, "INBOX", 1, &with_ids("Счёт", 100, "q@x", None), true);
        store.mark_done("a", "q@x", Act::Forward, 600, None).unwrap();
        // Moved: a new row in another folder, the same Message-ID.
        store.remove_uids("a", "INBOX", &[1]).unwrap();
        let moved = put(&store, "Trash", 7, &with_ids("Счёт", 100, "q@x", None), true);
        assert_eq!(row(&store, moved).marks, [mark(Act::Forward, Some(600))]);
        // Another mailbox's letter with the same id is not marked.
        assert!(
            store
                .list(&ListQuery {
                    account_id: Some("b".into()),
                    ..Default::default()
                })
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_server_flags_of_the_cache_are_kept() {
        let store = mailbox();
        let s = with_ids("Счёт", 100, "q@x", None);
        let msg = crate::store::NewMessage {
            uid: 1,
            summary: &s,
            fallback_date: 0,
            size: 1,
            flags: server(|f| {
                f.answered = true;
                f.answered_all = true;
                f.forwarded = true;
            }),
        };
        let id = store.insert_message("a", "INBOX", &msg).unwrap();
        let flags = row(&store, id).flags;
        assert!(flags.answered && flags.answered_all && flags.forwarded);
        assert_eq!(
            row(&store, id).marks,
            [mark(Act::ReplyAll, None), mark(Act::Forward, None)]
        );
    }

    #[test]
    fn a_queued_answer_shows_on_its_letter_at_once() {
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Счёт", 100, "q@x", None), true);
        let draft = Draft {
            acts_on: Some(ActsOn {
                account_id: "a".into(),
                message_id: "q@x".into(),
                folder: "INBOX".into(),
                act: Act::ReplyAll,
                waiting: false,
            }),
            ..Default::default()
        };
        let park = FollowupPlan {
            park: Some(true),
            ..Default::default()
        };
        // Leaves after the undo delay: the letter is marked now, and goes to wait.
        let item = store.outbox_add("a", &draft, 1_000, 1_010, 0, &park).unwrap();
        let r = row(&store, id);
        assert_eq!(
            r.outgoing,
            Some(Outgoing {
                act: Act::ReplyAll,
                at: 1_010,
                park: true,
                scheduled: false
            })
        );
        assert_eq!(r.marks, [mark(Act::ReplyAll, Some(1_010))]);
        // The outbox gives back what it was asked.
        let queued = &store.outbox().unwrap()[0];
        assert_eq!(queued.draft.acts_on, draft.acts_on);
        assert_eq!(queued.followup.park, Some(true));
        // Taken back: nothing was answered.
        store.outbox_remove(item).unwrap();
        assert_eq!(row(&store, id).outgoing, None);
        assert!(row(&store, id).marks.is_empty());

        // Sent later: no mark until it leaves, and the letter stays where it is.
        let item = store
            .outbox_add("a", &draft, 1_000, 90_000, 0, &FollowupPlan::default())
            .unwrap();
        let r = row(&store, id);
        assert_eq!(
            r.outgoing,
            Some(Outgoing {
                act: Act::ReplyAll,
                at: 90_000,
                park: false,
                scheduled: true
            })
        );
        assert!(r.marks.is_empty());
        // Refused by the server: no answer went.
        store.outbox_retry_later(item, 2_000, "refused", true).unwrap();
        assert_eq!(row(&store, id).outgoing, None);
    }

    #[test]
    fn forgetting_a_mailbox_forgets_its_marks() {
        let store = mailbox();
        put(&store, "INBOX", 1, &with_ids("Счёт", 100, "q@x", None), true);
        store.mark_done("a", "q@x", Act::Reply, 500, None).unwrap();
        store.mark_done("b", "q@x", Act::Reply, 500, None).unwrap();
        store.forget_account("a").unwrap();
        let left: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM marks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 1, "only the other mailbox's");
    }
}
