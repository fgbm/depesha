//! The beginning of a letter's text, shown in the list row (#177). It is kept in a
//! table of its own, created when the cache opens, so that the shape of the mail cache
//! (`messages`, its numbered migrations and `user_version`) does not change: a cache
//! written with this table opens in 0.8.2, which never reads it.
//!
//! A letter the server no longer has takes its text with it: the foreign key cascades
//! (`PRAGMA foreign_keys = ON`), so no orphan row is left behind.

use rusqlite::{Connection, OptionalExtension, params};

use crate::Result;

/// The table, made with `IF NOT EXISTS` at every open: an existing cache grows it once,
/// a cache written with it is left as it is. Not a numbered migration, so `user_version`
/// does not move.
pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS snippets (
    message_id INTEGER PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    text       TEXT NOT NULL
);";

/// Makes the table if the cache does not have it yet.
pub(super) fn schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

/// Stores one letter's text; the same letter read again replaces it.
pub(super) fn save(conn: &Connection, id: i64, text: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO snippets (message_id, text) VALUES (?1, ?2)",
        params![id, text],
    )?;
    Ok(())
}

/// The letter's text, or none when it was never read.
pub(super) fn of(conn: &Connection, id: i64) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT text FROM snippets WHERE message_id = ?1", [id], |r| r.get(0))
        .optional()?)
}

/// Letters of a folder whose text was never read, newest first: what the background
/// backfill asks the server for. `limit` bounds one round.
pub(super) fn missing(conn: &Connection, account_id: &str, folder: &str, limit: u32) -> Result<Vec<(i64, u32)>> {
    let mut stmt = conn.prepare_cached(
        "SELECT m.id, m.uid FROM messages m
         WHERE m.account_id = ?1 AND m.folder = ?2
           AND NOT EXISTS (SELECT 1 FROM snippets s WHERE s.message_id = m.id)
         ORDER BY m.date DESC, m.id DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![account_id, folder, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// How many letters of a folder have no text read yet.
pub(super) fn missing_count(conn: &Connection, account_id: &str, folder: &str) -> Result<u64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages m
         WHERE m.account_id = ?1 AND m.folder = ?2
           AND NOT EXISTS (SELECT 1 FROM snippets s WHERE s.message_id = m.id)",
        params![account_id, folder],
        |r| r.get(0),
    )?;
    Ok(n as u64)
}

#[cfg(test)]
mod tests {
    use crate::domain::{Flags, FolderRole};
    use crate::message::Summary;
    use crate::store::{NewMessage, Store};

    fn letter(store: &Store, uid: u32) -> i64 {
        let summary = Summary {
            subject: format!("Letter {uid}"),
            ..Default::default()
        };
        store
            .insert_message(
                "a",
                "INBOX",
                &NewMessage {
                    uid,
                    summary: &summary,
                    fallback_date: 0,
                    size: 1,
                    flags: Flags::default(),
                    keywords: Vec::new(),
                },
            )
            .unwrap()
    }

    fn inbox(store: &Store) {
        store
            .replace_folders(
                "a",
                &[crate::domain::Folder {
                    name: "INBOX".into(),
                    display_name: "INBOX".into(),
                    delimiter: Some("/".into()),
                    role: Some(FolderRole::Inbox),
                    selectable: true,
                    hidden: false,
                }],
            )
            .unwrap();
    }

    /// The table is made at open and `user_version` does not move with it: a cache that
    /// 0.8.2 can still read. Reopening does not make it twice.
    #[test]
    fn the_table_is_made_without_moving_the_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        let (before, id) = {
            let store = Store::open(&path).unwrap();
            inbox(&store);
            let id = letter(&store, 1);
            store.save_snippet(id, "Привет, мир").unwrap();
            (crate::store::user_version(&store.conn()).unwrap(), id)
        };
        let store = Store::open(&path).unwrap();
        assert_eq!(
            crate::store::user_version(&store.conn()).unwrap(),
            before,
            "reopening does not bump the version"
        );
        assert_eq!(
            store.snippet(id).unwrap().as_deref(),
            Some("Привет, мир"),
            "the text survives"
        );
    }

    /// A letter the server no longer has takes its text with it.
    #[test]
    fn a_deleted_letter_takes_its_text() {
        let store = Store::open_in_memory().unwrap();
        inbox(&store);
        let id = letter(&store, 1);
        store.save_snippet(id, "Письмо").unwrap();
        assert_eq!(store.snippet(id).unwrap().as_deref(), Some("Письмо"));
        store.remove_uids("a", "INBOX", &[1]).unwrap();
        let orphans: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM snippets WHERE message_id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(orphans, 0, "no orphan text is left");
    }

    /// Criterion (#177): a letter that carries no text at all (files only, calendar,
    /// S/MIME) is stored with an empty preview, so it leaves the selection at once. A round
    /// of 50 starting at the newest therefore reaches the one letter with text in the
    /// second round instead of being stuck on the letters that can never answer.
    #[test]
    fn a_round_of_letters_without_text_leaves_the_one_with_text_for_the_next() {
        let store = Store::open_in_memory().unwrap();
        inbox(&store);
        // The one with text, cached first (the oldest); then 50 of only files, newest.
        let with_text = letter(&store, 1);
        for uid in 2..=51 {
            letter(&store, uid);
        }
        let round = store.snippets_missing("a", "INBOX", 50).unwrap();
        assert_eq!(round.len(), 50, "a round holds its limit");
        assert!(!round.iter().any(|(id, _)| *id == with_text), "the newest first");
        // All 50 carry no text: the empty preview is stored, and they leave the selection.
        let empty: Vec<(i64, String)> = round.iter().map(|(id, _)| (*id, String::new())).collect();
        store.save_snippets(&empty).unwrap();
        let round = store.snippets_missing("a", "INBOX", 50).unwrap();
        assert_eq!(round, vec![(with_text, 1)], "the letter with text is all that is left");
        store.save_snippet(with_text, "Тело письма").unwrap();
        assert_eq!(store.snippets_missing_count("a", "INBOX").unwrap(), 0);
    }

    /// The backfill sees only the letters without a text, newest first, and counts them.
    #[test]
    fn missing_lists_letters_without_a_text() {
        let store = Store::open_in_memory().unwrap();
        inbox(&store);
        let (a, b) = (letter(&store, 1), letter(&store, 2));
        store.save_snippet(a, "есть").unwrap();
        assert_eq!(store.snippets_missing("a", "INBOX", 10).unwrap(), vec![(b, 2)]);
        assert_eq!(store.snippets_missing_count("a", "INBOX").unwrap(), 1);
        store.save_snippet(b, "тоже есть").unwrap();
        assert_eq!(store.snippets_missing_count("a", "INBOX").unwrap(), 0);
    }
}
