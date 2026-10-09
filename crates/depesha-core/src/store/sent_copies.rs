//! The copies of sent letters waiting to be filed in «Sent». The letter has left by SMTP
//! and its outbox row is gone, so the bytes of the copy live here until the server has
//! them: a quit, a dead network or a paused mailbox must not lose them, and the letter
//! itself is never sent again for the sake of a copy.

use rusqlite::{Connection, params};

use super::{OutboxItem, Store, add_column};
use crate::Result;

/// 19: the copies of sent letters not yet in «Sent».
pub(super) fn v19_sent_copies(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sent_copies (
            id           INTEGER PRIMARY KEY,
            account_id   TEXT NOT NULL,
            folder       TEXT NOT NULL,
            raw          BLOB NOT NULL,
            flags        TEXT NOT NULL,
            message_id   TEXT,
            attempts     INTEGER NOT NULL DEFAULT 0,
            next_attempt INTEGER NOT NULL DEFAULT 0,
            last_error   TEXT,
            pending      TEXT
        );",
    )?;
    Ok(())
}

/// 20: a copy the server keeps refusing is counted apart from a dead network, and is put
/// on hold after the last refusal; the subject is kept to name it in the tasks.
pub(super) fn v20_stuck_copies(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "ALTER TABLE sent_copies ADD COLUMN refusals INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE sent_copies ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE sent_copies ADD COLUMN subject TEXT NOT NULL DEFAULT '';",
    )?;
    Ok(())
}

/// 22: a copy the server has taken whose local finish (the answered mark, the wait for a
/// reply) failed is marked, so that its repeat does not upload the copy a second time; and
/// the letters an archival after an answer took to the archive are marked, so that a wait
/// finds their conversation there after a restart (`archived_mark`).
pub(super) fn v22_copy_filed(conn: &Connection) -> Result<()> {
    add_column(conn, "sent_copies", "filed", "INTEGER NOT NULL DEFAULT 0")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS archived_by_answer (
            account_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            at         INTEGER NOT NULL,
            PRIMARY KEY (account_id, message_id)
        );",
    )?;
    Ok(())
}

/// A copy to file in «Sent».
#[derive(Debug, Clone)]
pub struct SentCopy {
    pub id: i64,
    pub account_id: String,
    pub folder: String,
    pub raw: Vec<u8>,
    pub flags: String,
    pub message_id: Option<String>,
    pub attempts: u32,
    pub next_attempt: i64,
    pub last_error: Option<String>,
    /// Refusals by the server that will not change by waiting (a full mailbox, a missing
    /// folder), counted apart from attempts lost to the network.
    pub refusals: u32,
    /// After the last refusal the copy waits for the user: it is not tried again, and the
    /// letter is not uploaded again.
    pub paused: bool,
    pub subject: String,
    /// The server has the copy already; what is left is the local finish of the letter. A
    /// repeat does the finish only and never uploads the copy again.
    pub filed: bool,
    /// The sent letter whose answered mark and wait for a reply start once the copy is in
    /// the cache: a wait is countable and cancellable only while its letter is cached.
    pub pending: Option<OutboxItem>,
}

/// What the send leaves behind for the copy.
pub struct NewSentCopy<'a> {
    pub account_id: &'a str,
    pub folder: &'a str,
    pub raw: &'a [u8],
    pub flags: &'a str,
    pub message_id: Option<&'a str>,
    pub subject: &'a str,
    pub pending: Option<&'a OutboxItem>,
}

/// A paused copy as the tasks show it: no bytes, they stay in the cache.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StuckCopy {
    pub id: i64,
    pub account_id: String,
    pub subject: String,
    pub last_error: Option<String>,
    pub refusals: u32,
    /// The server has the copy: what failed is the local finish of the letter.
    pub filed: bool,
}

impl Store {
    /// The letter has gone out: its outbox row is replaced by the copy in one step, so
    /// there is no moment when neither exists.
    pub fn outbox_sent_with_copy(&self, outbox_id: i64, copy: &NewSentCopy<'_>) -> Result<i64> {
        let pending = copy
            .pending
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| crate::Error::Compose(e.to_string()))?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let id = tx.query_row(
            "INSERT INTO sent_copies (account_id, folder, raw, flags, message_id, pending, subject)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id",
            params![
                copy.account_id,
                copy.folder,
                copy.raw,
                copy.flags,
                copy.message_id,
                pending,
                copy.subject
            ],
            |r| r.get(0),
        )?;
        tx.execute("DELETE FROM outbox WHERE id = ?1", [outbox_id])?;
        tx.commit()?;
        Ok(id)
    }

    /// The copies whose time has come, oldest first.
    pub fn sent_copies_due(&self, now: i64) -> Result<Vec<SentCopy>> {
        self.sent_copies_where("WHERE next_attempt <= ?1 AND paused = 0", now)
    }

    /// Every copy still to be filed.
    pub fn sent_copies(&self) -> Result<Vec<SentCopy>> {
        self.sent_copies_where("WHERE ?1 = ?1", 0)
    }

    fn sent_copies_where(&self, filter: &str, arg: i64) -> Result<Vec<SentCopy>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT id, account_id, folder, raw, flags, message_id, attempts, next_attempt, last_error, pending, refusals, paused, subject, filed
             FROM sent_copies {filter} ORDER BY id"
        ))?;
        let rows = stmt.query_map([arg], |r| {
            Ok(SentCopy {
                id: r.get(0)?,
                account_id: r.get(1)?,
                folder: r.get(2)?,
                raw: r.get(3)?,
                flags: r.get(4)?,
                message_id: r.get(5)?,
                attempts: r.get(6)?,
                next_attempt: r.get(7)?,
                last_error: r.get(8)?,
                pending: r
                    .get::<_, Option<String>>(9)?
                    .and_then(|j| serde_json::from_str(&j).ok()),
                refusals: r.get(10)?,
                paused: r.get::<_, i64>(11)? != 0,
                subject: r.get(12)?,
                filed: r.get::<_, i64>(13)? != 0,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The copy is in «Sent» (or the mailbox is gone): nothing is left to file.
    pub fn sent_copy_done(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM sent_copies WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The copy did not reach the server: try again at `next_attempt`.
    pub fn sent_copy_retry_later(&self, id: i64, next_attempt: i64, error: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE sent_copies SET attempts = attempts + 1, next_attempt = ?2, last_error = ?3 WHERE id = ?1",
            params![id, next_attempt, error],
        )?;
        Ok(())
    }

    /// The server refused the copy for good: the refusal is counted, and at the last one
    /// (`pause`) the copy waits for the user instead of for its time.
    pub fn sent_copy_refused(&self, id: i64, next_attempt: i64, error: &str, pause: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE sent_copies SET attempts = attempts + 1, refusals = refusals + 1, next_attempt = ?2,
                    last_error = ?3, paused = ?4 WHERE id = ?1",
            params![id, next_attempt, error, pause],
        )?;
        Ok(())
    }

    /// The server has the copy but the local finish of the letter failed: the copy is
    /// marked as filed, the failure counted like a refusal, and at the last one (`pause`)
    /// the copy waits for the user.
    pub fn sent_copy_unfinished(&self, id: i64, next_attempt: i64, error: &str, pause: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE sent_copies SET filed = 1, attempts = attempts + 1, refusals = refusals + 1, next_attempt = ?2,
                    last_error = ?3, paused = ?4 WHERE id = ?1",
            params![id, next_attempt, error, pause],
        )?;
        Ok(())
    }

    /// The copies waiting for the user, without their bytes.
    pub fn sent_copies_stuck(&self) -> Result<Vec<StuckCopy>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, account_id, subject, last_error, refusals, filed FROM sent_copies WHERE paused = 1 ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(StuckCopy {
                id: r.get(0)?,
                account_id: r.get(1)?,
                subject: r.get(2)?,
                last_error: r.get(3)?,
                refusals: r.get(4)?,
                filed: r.get::<_, i64>(5)? != 0,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// One copy by its id, bytes included.
    pub fn sent_copy(&self, id: i64) -> Result<Option<SentCopy>> {
        Ok(self.sent_copies()?.into_iter().find(|c| c.id == id))
    }

    /// "Try again": the hold and the count of refusals are dropped, the copy is due now.
    /// False when there is no such copy.
    pub fn sent_copy_resume(&self, id: i64) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE sent_copies SET paused = 0, refusals = 0, attempts = 0, next_attempt = 0 WHERE id = ?1",
            [id],
        )?;
        Ok(n > 0)
    }

    /// The wait for a reply no longer waits for the copy (it was started without it).
    pub fn sent_copy_forget_wait(&self, id: i64) -> Result<()> {
        self.conn()
            .execute("UPDATE sent_copies SET pending = NULL WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy(raw: &[u8]) -> NewSentCopy<'_> {
        NewSentCopy {
            account_id: "a",
            folder: "Sent",
            raw,
            flags: "(\\Seen)",
            message_id: Some("m@x"),
            subject: "Contract",
            pending: None,
        }
    }

    #[test]
    fn a_sent_letter_leaves_its_copy_in_place_of_its_outbox_row() {
        let store = Store::open_in_memory().unwrap();
        let id = store
            .outbox_add("a", &Default::default(), 1, 1, 0, &Default::default())
            .unwrap();
        store.outbox_sent_with_copy(id, &copy(b"raw")).unwrap();
        assert!(store.outbox().unwrap().is_empty(), "the letter is not sent twice");
        let copies = store.sent_copies().unwrap();
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].raw, b"raw");
        assert_eq!(copies[0].message_id.as_deref(), Some("m@x"));
    }

    #[test]
    fn a_copy_waits_for_its_time_and_goes_only_when_filed() {
        let store = Store::open_in_memory().unwrap();
        let id = store
            .outbox_add("a", &Default::default(), 1, 1, 0, &Default::default())
            .unwrap();
        let copy_id = store.outbox_sent_with_copy(id, &copy(b"raw")).unwrap();
        assert_eq!(store.sent_copies_due(0).unwrap().len(), 1, "due at once");
        store.sent_copy_retry_later(copy_id, 500, "no network").unwrap();
        assert!(store.sent_copies_due(499).unwrap().is_empty());
        let due = store.sent_copies_due(500).unwrap();
        assert_eq!((due.len(), due[0].attempts), (1, 1));
        assert_eq!(due[0].last_error.as_deref(), Some("no network"));
        store.sent_copy_done(copy_id).unwrap();
        assert!(store.sent_copies().unwrap().is_empty());
    }

    #[test]
    fn a_refused_copy_is_held_until_the_user_resumes_it() {
        let store = Store::open_in_memory().unwrap();
        let id = store
            .outbox_add("a", &Default::default(), 1, 1, 0, &Default::default())
            .unwrap();
        let copy_id = store.outbox_sent_with_copy(id, &copy(b"raw")).unwrap();
        store.sent_copy_refused(copy_id, 100, "full", false).unwrap();
        assert!(store.sent_copies_stuck().unwrap().is_empty(), "still counting down");
        store.sent_copy_refused(copy_id, 200, "full", true).unwrap();
        assert!(
            store.sent_copies_due(i64::MAX).unwrap().is_empty(),
            "held copies are not due"
        );
        let stuck = store.sent_copies_stuck().unwrap();
        assert_eq!((stuck.len(), stuck[0].refusals), (1, 2));
        assert_eq!(stuck[0].subject, "Contract");
        assert_eq!(stuck[0].last_error.as_deref(), Some("full"));
        assert!(store.sent_copy_resume(copy_id).unwrap());
        let due = store.sent_copies_due(0).unwrap();
        assert_eq!(
            (due.len(), due[0].refusals, due[0].attempts, due[0].paused),
            (1, 0, 0, false)
        );
        assert!(!store.sent_copy_resume(copy_id + 1).unwrap());
    }

    /// A cache of 0.7.1 holds copies without the columns of step 20: they migrate, are due
    /// as before and can be refused and resumed.
    #[test]
    fn a_copy_of_the_previous_version_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        {
            let store = Store::open(&path).unwrap();
            let conn = store.conn();
            conn.execute_batch(
                "ALTER TABLE sent_copies DROP COLUMN refusals;
                 ALTER TABLE sent_copies DROP COLUMN paused;
                 ALTER TABLE sent_copies DROP COLUMN subject;
                 INSERT INTO sent_copies (account_id, folder, raw, flags, attempts)
                 VALUES ('a', 'Sent', x'72617700', '(\\Seen)', 2);
                 PRAGMA user_version = 19;",
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let due = store.sent_copies_due(0).unwrap();
        assert_eq!(
            (due.len(), due[0].attempts, due[0].refusals, due[0].paused),
            (1, 2, 0, false)
        );
        assert_eq!(due[0].subject, "");
        store.sent_copy_refused(due[0].id, 5, "full", true).unwrap();
        assert_eq!(store.sent_copies_stuck().unwrap().len(), 1);
    }

    #[test]
    fn a_copy_outlives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        {
            let store = Store::open(&path).unwrap();
            let id = store
                .outbox_add("a", &Default::default(), 1, 1, 0, &Default::default())
                .unwrap();
            store.outbox_sent_with_copy(id, &copy(b"raw")).unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.sent_copies_due(0).unwrap().len(), 1);
        assert!(store.outbox().unwrap().is_empty(), "no second send after the restart");
    }
}
