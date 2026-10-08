//! The copies of sent letters waiting to be filed in «Sent». The letter has left by SMTP
//! and its outbox row is gone, so the bytes of the copy live here until the server has
//! them: a quit, a dead network or a paused mailbox must not lose them, and the letter
//! itself is never sent again for the sake of a copy.

use rusqlite::{Connection, params};

use super::{OutboxItem, Store};
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
    pub pending: Option<&'a OutboxItem>,
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
            "INSERT INTO sent_copies (account_id, folder, raw, flags, message_id, pending)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id",
            params![
                copy.account_id,
                copy.folder,
                copy.raw,
                copy.flags,
                copy.message_id,
                pending
            ],
            |r| r.get(0),
        )?;
        tx.execute("DELETE FROM outbox WHERE id = ?1", [outbox_id])?;
        tx.commit()?;
        Ok(id)
    }

    /// The copies whose time has come, oldest first.
    pub fn sent_copies_due(&self, now: i64) -> Result<Vec<SentCopy>> {
        self.sent_copies_where("WHERE next_attempt <= ?1", now)
    }

    /// Every copy still to be filed.
    pub fn sent_copies(&self) -> Result<Vec<SentCopy>> {
        self.sent_copies_where("WHERE ?1 = ?1", 0)
    }

    fn sent_copies_where(&self, filter: &str, arg: i64) -> Result<Vec<SentCopy>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT id, account_id, folder, raw, flags, message_id, attempts, next_attempt, last_error, pending
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
