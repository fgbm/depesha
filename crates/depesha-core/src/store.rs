use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::imap::{Flags, Folder, FolderRole};
use crate::message::{Addr, Summary};
use crate::smtp::Draft;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
    account_id   TEXT NOT NULL,
    name         TEXT NOT NULL,
    display_name TEXT NOT NULL,
    delimiter    TEXT,
    role         TEXT,
    selectable   INTEGER NOT NULL,
    hidden       INTEGER NOT NULL DEFAULT 0,
    uidvalidity  INTEGER NOT NULL DEFAULT 0,
    last_uid     INTEGER NOT NULL DEFAULT 0,
    oldest_uid   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, name)
);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY,
    account_id      TEXT NOT NULL,
    folder          TEXT NOT NULL,
    uid             INTEGER NOT NULL,
    message_id      TEXT,
    in_reply_to     TEXT,
    refs            TEXT NOT NULL,
    subject         TEXT NOT NULL,
    from_addr       TEXT,
    to_addrs        TEXT NOT NULL,
    cc_addrs        TEXT NOT NULL,
    reply_to        TEXT NOT NULL,
    date            INTEGER NOT NULL,
    size            INTEGER NOT NULL,
    seen            INTEGER NOT NULL,
    answered        INTEGER NOT NULL,
    flagged         INTEGER NOT NULL,
    draft           INTEGER NOT NULL,
    has_attachments INTEGER NOT NULL,
    UNIQUE (account_id, folder, uid),
    FOREIGN KEY (account_id, folder) REFERENCES folders (account_id, name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_by_date ON messages (date DESC);
CREATE INDEX IF NOT EXISTS messages_by_folder ON messages (account_id, folder, date DESC);

CREATE TABLE IF NOT EXISTS bodies (
    message_id INTEGER PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    raw        BLOB NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (
    subject, sender, recipients, body,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_search_delete AFTER DELETE ON messages BEGIN
    DELETE FROM search WHERE rowid = old.id;
END;

-- Messages waiting to be sent; they survive restarts and transient SMTP errors.
CREATE TABLE IF NOT EXISTS outbox (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL,
    draft         TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    next_attempt  INTEGER NOT NULL,
    last_error    TEXT,
    failed        INTEGER NOT NULL DEFAULT 0,
    created       INTEGER NOT NULL
);

-- Senders whose remote images are always shown.
CREATE TABLE IF NOT EXISTS trusted_senders (
    email TEXT PRIMARY KEY
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxItem {
    pub id: i64,
    pub account_id: String,
    pub draft: Draft,
    pub attempts: u32,
    pub next_attempt: i64,
    pub last_error: Option<String>,
    /// Permanent failure: waits for the user, not retried automatically.
    pub failed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderInfo {
    pub account_id: String,
    #[serde(flatten)]
    pub folder: Folder,
    pub total: u32,
    pub unread: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRow {
    pub id: i64,
    pub account_id: String,
    pub folder: String,
    pub uid: u32,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub subject: String,
    pub from: Option<Addr>,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub reply_to: Vec<Addr>,
    pub date: i64,
    pub size: u32,
    pub flags: Flags,
    pub has_attachments: bool,
}

/// Which messages to show. An empty query is the unified inbox of all accounts.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ListQuery {
    pub account_id: Option<String>,
    pub folder: Option<String>,
    /// Folder role across all accounts, e.g. every inbox. Defaults to inbox
    /// when no folder is given.
    pub role: Option<FolderRole>,
    pub unread_only: bool,
    pub flagged_only: bool,
    pub limit: u32,
    pub offset: u32,
}

/// A message header fetched from the server, ready for the cache.
#[derive(Debug, Clone, Copy)]
pub struct NewMessage<'a> {
    pub uid: u32,
    pub summary: &'a Summary,
    /// INTERNALDATE, used when the Date header is missing or broken.
    pub fallback_date: i64,
    pub size: u32,
    pub flags: Flags,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        // Databases created before the column existed.
        let has_oldest: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('folders') WHERE name = 'oldest_uid'")?
            .exists([])?;
        if !has_oldest {
            conn.execute_batch("ALTER TABLE folders ADD COLUMN oldest_uid INTEGER NOT NULL DEFAULT 0")?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock leaves SQLite consistent: every write is a transaction.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stores the server's folder list; folders gone from the server lose their cache.
    pub fn replace_folders(&self, account_id: &str, folders: &[Folder]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut upsert = tx.prepare(
                "INSERT INTO folders (account_id, name, display_name, delimiter, role, selectable, hidden)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (account_id, name) DO UPDATE SET
                    display_name = excluded.display_name, delimiter = excluded.delimiter,
                    role = excluded.role, selectable = excluded.selectable, hidden = excluded.hidden",
            )?;
            for f in folders {
                upsert.execute(params![
                    account_id,
                    f.name,
                    f.display_name,
                    f.delimiter,
                    f.role.map(FolderRole::as_str),
                    f.selectable,
                    f.hidden
                ])?;
            }
            let names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
            let existing: Vec<String> = tx
                .prepare("SELECT name FROM folders WHERE account_id = ?1")?
                .query_map([account_id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            for name in existing.iter().filter(|n| !names.contains(&n.as_str())) {
                tx.execute(
                    "DELETE FROM folders WHERE account_id = ?1 AND name = ?2",
                    params![account_id, name],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn folders(&self, account_id: Option<&str>) -> Result<Vec<FolderInfo>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT f.account_id, f.name, f.display_name, f.delimiter, f.role, f.selectable, f.hidden,
                    COUNT(m.id), COALESCE(SUM(m.seen = 0), 0)
             FROM folders f LEFT JOIN messages m ON m.account_id = f.account_id AND m.folder = f.name
             WHERE ?1 IS NULL OR f.account_id = ?1
             GROUP BY f.account_id, f.name
             ORDER BY f.account_id,
                CASE f.role WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sent' THEN 2 WHEN 'archive' THEN 3
                            WHEN 'junk' THEN 4 WHEN 'trash' THEN 5 ELSE 6 END,
                f.display_name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([account_id], |r| {
            Ok(FolderInfo {
                account_id: r.get(0)?,
                folder: Folder {
                    name: r.get(1)?,
                    display_name: r.get(2)?,
                    delimiter: r.get(3)?,
                    role: r.get::<_, Option<String>>(4)?.as_deref().and_then(FolderRole::parse),
                    selectable: r.get(5)?,
                    hidden: r.get(6)?,
                },
                total: r.get(7)?,
                unread: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn folder_by_role(&self, account_id: &str, role: FolderRole) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT name FROM folders WHERE account_id = ?1 AND role = ?2",
                params![account_id, role.as_str()],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// `(uidvalidity, last_uid)` seen at the previous sync.
    pub fn folder_state(&self, account_id: &str, folder: &str) -> Result<(u32, u32)> {
        Ok(self
            .conn()
            .query_row(
                "SELECT uidvalidity, last_uid FROM folders WHERE account_id = ?1 AND name = ?2",
                params![account_id, folder],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, 0)))
    }

    pub fn set_folder_state(&self, account_id: &str, folder: &str, uidvalidity: u32, last_uid: u32) -> Result<()> {
        self.conn().execute(
            "UPDATE folders SET uidvalidity = ?3, last_uid = ?4 WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder, uidvalidity, last_uid],
        )?;
        Ok(())
    }

    pub fn clear_folder(&self, account_id: &str, folder: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM messages WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
        )?;
        conn.execute(
            "UPDATE folders SET oldest_uid = 0 WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder],
        )?;
        Ok(())
    }

    /// Lowest UID of the contiguous range synced from the newest end. Messages below it
    /// may be cached individually (server search) without closing the gap.
    pub fn window_start(&self, account_id: &str, folder: &str) -> Result<u32> {
        Ok(self
            .conn()
            .query_row(
                "SELECT oldest_uid FROM folders WHERE account_id = ?1 AND name = ?2",
                params![account_id, folder],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    pub fn set_window_start(&self, account_id: &str, folder: &str, uid: u32) -> Result<()> {
        self.conn().execute(
            "UPDATE folders SET oldest_uid = ?3 WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder, uid],
        )?;
        Ok(())
    }

    pub fn known_uids(&self, account_id: &str, folder: &str) -> Result<Vec<u32>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2")?;
        let uids = stmt.query_map(params![account_id, folder], |r| r.get(0))?;
        Ok(uids.collect::<Result<_, _>>()?)
    }

    pub fn insert_message(&self, account_id: &str, folder: &str, msg: &NewMessage<'_>) -> Result<i64> {
        let NewMessage {
            uid,
            summary,
            fallback_date,
            size,
            flags,
        } = *msg;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let json = |v: &Vec<Addr>| serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
        let id: i64 = tx.query_row(
            "INSERT INTO messages (account_id, folder, uid, message_id, in_reply_to, refs, subject, from_addr,
                to_addrs, cc_addrs, reply_to, date, size, seen, answered, flagged, draft, has_attachments)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT (account_id, folder, uid) DO UPDATE SET
                seen = excluded.seen, answered = excluded.answered,
                flagged = excluded.flagged, draft = excluded.draft
             RETURNING id",
            params![
                account_id,
                folder,
                uid,
                summary.message_id,
                summary.in_reply_to,
                serde_json::to_string(&summary.references).unwrap_or_else(|_| "[]".into()),
                summary.subject,
                summary.from.as_ref().and_then(|a| serde_json::to_string(a).ok()),
                json(&summary.to),
                json(&summary.cc),
                json(&summary.reply_to),
                summary.date.unwrap_or(fallback_date),
                size,
                flags.seen,
                flags.answered,
                flags.flagged,
                flags.draft,
                summary.has_attachments,
            ],
            |r| r.get(0),
        )?;
        let sender = summary.from.as_ref().map(addr_text).unwrap_or_default();
        let recipients: Vec<String> = summary.to.iter().chain(&summary.cc).map(addr_text).collect();
        tx.execute(
            "INSERT OR REPLACE INTO search (rowid, subject, sender, recipients, body)
             VALUES (?1, ?2, ?3, ?4, COALESCE((SELECT body FROM search WHERE rowid = ?1), ''))",
            params![id, summary.subject, sender, recipients.join(", ")],
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn update_flags(&self, account_id: &str, folder: &str, flags: &[(u32, Flags)]) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut changed = 0;
        {
            let mut stmt = tx.prepare(
                "UPDATE messages SET seen = ?4, answered = ?5, flagged = ?6, draft = ?7
                 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3
                   AND (seen, answered, flagged, draft) IS NOT (?4, ?5, ?6, ?7)",
            )?;
            for (uid, f) in flags {
                changed += stmt.execute(params![account_id, folder, uid, f.seen, f.answered, f.flagged, f.draft])?;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn remove_uids(&self, account_id: &str, folder: &str, uids: &[u32]) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut removed = 0;
        {
            let mut stmt = tx.prepare("DELETE FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3")?;
            for uid in uids {
                removed += stmt.execute(params![account_id, folder, uid])?;
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn list(&self, q: &ListQuery) -> Result<Vec<MessageRow>> {
        let mut sql = format!(
            "SELECT {COLUMNS} FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder WHERE 1"
        );
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(account) = &q.account_id {
            sql.push_str(" AND m.account_id = ?");
            args.push(account.clone().into());
        }
        match (&q.folder, q.role) {
            (Some(folder), _) => {
                sql.push_str(" AND m.folder = ?");
                args.push(folder.clone().into());
            }
            (None, role) => {
                sql.push_str(" AND f.role = ?");
                args.push(role.unwrap_or(FolderRole::Inbox).as_str().to_owned().into());
            }
        }
        if q.unread_only {
            sql.push_str(" AND m.seen = 0");
        }
        if q.flagged_only {
            sql.push_str(" AND m.flagged = 1");
        }
        sql.push_str(" ORDER BY m.date DESC, m.id DESC LIMIT ? OFFSET ?");
        args.push(i64::from(if q.limit == 0 { 100 } else { q.limit }).into());
        args.push(i64::from(q.offset).into());

        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), message_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn get(&self, id: i64) -> Result<Option<MessageRow>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {COLUMNS} FROM messages m WHERE m.id = ?1"),
                [id],
                message_row,
            )
            .optional()?)
    }

    pub fn find_by_uid(&self, account_id: &str, folder: &str, uid: u32) -> Result<Option<MessageRow>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {COLUMNS} FROM messages m WHERE m.account_id = ?1 AND m.folder = ?2 AND m.uid = ?3"),
                params![account_id, folder, uid],
                message_row,
            )
            .optional()?)
    }

    pub fn body(&self, id: i64) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn()
            .query_row("SELECT raw FROM bodies WHERE message_id = ?1", [id], |r| r.get(0))
            .optional()?)
    }

    pub fn save_body(&self, id: i64, raw: &[u8], text: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO bodies (message_id, raw) VALUES (?1, ?2)",
            params![id, raw],
        )?;
        tx.execute("UPDATE search SET body = ?2 WHERE rowid = ?1", params![id, text])?;
        tx.commit()?;
        Ok(())
    }

    /// Full-text search over subject, addresses and the bodies already downloaded.
    pub fn search(&self, text: &str, account_id: Option<&str>, limit: u32) -> Result<Vec<MessageRow>> {
        let Some(query) = fts_query(text) else {
            return Ok(Vec::new());
        };
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM search s JOIN messages m ON m.id = s.rowid
             WHERE search MATCH ?1 AND (?2 IS NULL OR m.account_id = ?2)
             ORDER BY m.date DESC LIMIT ?3"
        ))?;
        let rows = stmt.query_map(
            params![query, account_id, if limit == 0 { 100 } else { limit }],
            message_row,
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn forget_account(&self, account_id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM folders WHERE account_id = ?1", [account_id])?;
        conn.execute("DELETE FROM outbox WHERE account_id = ?1", [account_id])?;
        Ok(())
    }

    pub fn outbox_add(&self, account_id: &str, draft: &Draft, now: i64) -> Result<i64> {
        let json = serde_json::to_string(draft).map_err(|e| crate::Error::Compose(e.to_string()))?;
        Ok(self.conn().query_row(
            "INSERT INTO outbox (account_id, draft, next_attempt, created) VALUES (?1, ?2, ?3, ?3) RETURNING id",
            params![account_id, json, now],
            |r| r.get(0),
        )?)
    }

    pub fn outbox(&self) -> Result<Vec<OutboxItem>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, account_id, draft, attempts, next_attempt, last_error, failed FROM outbox ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(OutboxItem {
                id: r.get(0)?,
                account_id: r.get(1)?,
                draft: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
                attempts: r.get(3)?,
                next_attempt: r.get(4)?,
                last_error: r.get(5)?,
                failed: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn outbox_retry_later(&self, id: i64, next_attempt: i64, error: &str, permanent: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE outbox SET attempts = attempts + 1, next_attempt = ?2, last_error = ?3, failed = ?4 WHERE id = ?1",
            params![id, next_attempt, error, permanent],
        )?;
        Ok(())
    }

    pub fn outbox_requeue(&self, id: i64, now: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE outbox SET failed = 0, next_attempt = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    }

    pub fn outbox_remove(&self, id: i64) -> Result<Option<Draft>> {
        let conn = self.conn();
        let draft: Option<String> = conn
            .query_row("DELETE FROM outbox WHERE id = ?1 RETURNING draft", [id], |r| r.get(0))
            .optional()?;
        Ok(draft.and_then(|d| serde_json::from_str(&d).ok()))
    }

    pub fn trust_sender(&self, email: &str) -> Result<()> {
        self.conn().execute(
            "INSERT OR IGNORE INTO trusted_senders (email) VALUES (lower(?1))",
            [email],
        )?;
        Ok(())
    }

    pub fn is_trusted_sender(&self, email: &str) -> Result<bool> {
        Ok(self
            .conn()
            .query_row("SELECT 1 FROM trusted_senders WHERE email = lower(?1)", [email], |_| {
                Ok(())
            })
            .optional()?
            .is_some())
    }

    /// Distinct addresses from cached mail for recipient completion, most frequent first.
    pub fn known_addresses(&self, prefix: &str, limit: u32) -> Result<Vec<Addr>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "WITH a AS (
                SELECT json_extract(from_addr, '$.email') AS email, json_extract(from_addr, '$.name') AS name
                FROM messages WHERE from_addr IS NOT NULL
                UNION ALL
                SELECT json_extract(j.value, '$.email'), json_extract(j.value, '$.name')
                FROM messages, json_each(messages.to_addrs) j
             )
             SELECT email, MAX(name) FROM a
             WHERE email LIKE ?1 || '%' ESCAPE '\\' OR name LIKE '%' || ?1 || '%' ESCAPE '\\'
             GROUP BY lower(email) ORDER BY COUNT(*) DESC LIMIT ?2",
        )?;
        let escaped = prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let rows = stmt.query_map(params![escaped, limit], |r| {
            Ok(Addr {
                email: r.get(0)?,
                name: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

const COLUMNS: &str = "m.id, m.account_id, m.folder, m.uid, m.message_id, m.in_reply_to, m.refs, m.subject,
    m.from_addr, m.to_addrs, m.cc_addrs, m.reply_to, m.date, m.size,
    m.seen, m.answered, m.flagged, m.draft, m.has_attachments";

fn message_row(r: &Row<'_>) -> rusqlite::Result<MessageRow> {
    let addrs = |i: usize| -> rusqlite::Result<Vec<Addr>> {
        Ok(serde_json::from_str(&r.get::<_, String>(i)?).unwrap_or_default())
    };
    Ok(MessageRow {
        id: r.get(0)?,
        account_id: r.get(1)?,
        folder: r.get(2)?,
        uid: r.get(3)?,
        message_id: r.get(4)?,
        in_reply_to: r.get(5)?,
        references: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
        subject: r.get(7)?,
        from: r
            .get::<_, Option<String>>(8)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        to: addrs(9)?,
        cc: addrs(10)?,
        reply_to: addrs(11)?,
        date: r.get(12)?,
        size: r.get(13)?,
        flags: Flags {
            seen: r.get(14)?,
            answered: r.get(15)?,
            flagged: r.get(16)?,
            draft: r.get(17)?,
            deleted: false,
        },
        has_attachments: r.get(18)?,
    })
}

fn addr_text(a: &Addr) -> String {
    match &a.name {
        Some(name) => format!("{name} {}", a.email),
        None => a.email.clone(),
    }
}

/// Turns user input into a safe FTS5 query: every word is a quoted prefix term.
fn fts_query(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split_whitespace()
        .map(|w| w.replace('"', ""))
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str, role: Option<FolderRole>) -> Folder {
        Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: Some("/".into()),
            role,
            selectable: true,
            hidden: false,
        }
    }

    fn summary(subject: &str, date: i64) -> Summary {
        Summary {
            subject: subject.into(),
            from: Some(Addr {
                name: Some("Иван Петров".into()),
                email: "ivan@example.org".into(),
            }),
            date: Some(date),
            ..Default::default()
        }
    }

    /// The GUI sends only the fields it sets; a folder query without `unread_only` once failed.
    #[test]
    fn list_query_accepts_partial_json() {
        let q: ListQuery =
            serde_json::from_str(r#"{"account_id":"a","folder":"INBOX","limit":200,"offset":0}"#).unwrap();
        assert_eq!(q.folder.as_deref(), Some("INBOX"));
        assert!(!q.unread_only);
    }

    #[test]
    fn unified_inbox_search_and_flags() {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders(
                "a",
                &[
                    folder("INBOX", Some(FolderRole::Inbox)),
                    folder("Sent", Some(FolderRole::Sent)),
                ],
            )
            .unwrap();
        store
            .replace_folders("b", &[folder("INBOX", Some(FolderRole::Inbox))])
            .unwrap();

        fn msg(uid: u32, summary: &Summary, seen: bool) -> NewMessage<'_> {
            NewMessage {
                uid,
                summary,
                fallback_date: 0,
                size: 10,
                flags: Flags {
                    seen,
                    ..Default::default()
                },
            }
        }
        let id1 = store
            .insert_message("a", "INBOX", &msg(1, &summary("Счёт за октябрь", 100), false))
            .unwrap();
        store
            .insert_message("b", "INBOX", &msg(7, &summary("Отчёт", 200), true))
            .unwrap();
        store
            .insert_message("a", "Sent", &msg(3, &summary("Ответ", 300), false))
            .unwrap();

        let inbox = store.list(&ListQuery::default()).unwrap();
        assert_eq!(
            inbox.iter().map(|m| m.subject.as_str()).collect::<Vec<_>>(),
            ["Отчёт", "Счёт за октябрь"]
        );
        let unread = store
            .list(&ListQuery {
                unread_only: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(unread.len(), 1);

        assert_eq!(store.search("счёт", None, 0).unwrap().len(), 1);
        assert_eq!(store.search("петров", None, 0).unwrap().len(), 3);
        store.save_body(id1, b"raw", "оплатить до пятницы").unwrap();
        assert_eq!(store.search("пятниц", None, 0).unwrap()[0].id, id1);
        assert!(store.search("\"", None, 0).unwrap().is_empty());

        assert_eq!(
            store
                .update_flags(
                    "a",
                    "INBOX",
                    &[(
                        1,
                        Flags {
                            seen: true,
                            ..Default::default()
                        }
                    )]
                )
                .unwrap(),
            1
        );
        assert!(store.get(id1).unwrap().unwrap().flags.seen);

        let folders = store.folders(Some("a")).unwrap();
        assert_eq!(folders.iter().find(|f| f.folder.name == "INBOX").unwrap().unread, 0);

        store.remove_uids("a", "INBOX", &[1]).unwrap();
        assert!(store.get(id1).unwrap().is_none());
        assert!(store.search("пятниц", None, 0).unwrap().is_empty());

        store
            .replace_folders("a", &[folder("INBOX", Some(FolderRole::Inbox))])
            .unwrap();
        assert!(
            store
                .list(&ListQuery {
                    role: Some(FolderRole::Sent),
                    ..Default::default()
                })
                .unwrap()
                .is_empty()
        );
    }
}
