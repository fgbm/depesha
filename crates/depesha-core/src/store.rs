use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::imap::{FlagChange, Flags, Folder, FolderRole};
use crate::message::{Addr, Summary, Unsubscribe};
use crate::query::SearchQuery;
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
    thread          TEXT NOT NULL DEFAULT '',
    bulk            INTEGER NOT NULL DEFAULT 0,
    unsubscribe     TEXT,
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
    created       INTEGER NOT NULL,
    followup_secs INTEGER NOT NULL DEFAULT 0
);

-- Snoozed mail waits in the server's Snoozed folder; this says when and where it returns.
CREATE TABLE IF NOT EXISTS snoozed (
    account_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    folder     TEXT NOT NULL,
    return_to  TEXT NOT NULL,
    until      INTEGER NOT NULL,
    subject    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (account_id, message_id)
);

-- Sent mail the user expects an answer to.
CREATE TABLE IF NOT EXISTS followups (
    account_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    subject    TEXT NOT NULL,
    recipients TEXT NOT NULL,
    sent       INTEGER NOT NULL,
    due        INTEGER NOT NULL,
    notified   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, message_id)
);

-- Senders whose remote images are always shown.
CREATE TABLE IF NOT EXISTS trusted_senders (
    email TEXT PRIMARY KEY
);

-- Sender pictures, found or not: `photo:<account>:<email>` from Exchange,
-- `bimi:<domain>` for brand logos. uri is NULL when there is none to show.
CREATE TABLE IF NOT EXISTS avatars (
    key     TEXT PRIMARY KEY,
    uri     TEXT,
    fetched INTEGER NOT NULL
);

-- Exchange Web Services accounts: EWS folder ids behind the folder names.
-- window_date: items received since then are all cached; 0 for the whole folder,
-- -1 before the first sync.
CREATE TABLE IF NOT EXISTS ews_folders (
    account_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    folder_id   TEXT NOT NULL,
    window_date INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY (account_id, name)
);

-- EWS item ids behind the UIDs that the cache uses for every account.
CREATE TABLE IF NOT EXISTS ews_items (
    account_id TEXT NOT NULL,
    folder     TEXT NOT NULL,
    uid        INTEGER NOT NULL,
    item_id    TEXT NOT NULL,
    received   INTEGER NOT NULL,
    PRIMARY KEY (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS ews_items_by_id ON ews_items (account_id, folder, item_id);
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
    pub created: i64,
    /// Remind about a missing answer this long after sending; 0 for no reminder.
    pub followup_secs: i64,
}

/// A snoozed message that is due to come back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snooze {
    pub account_id: String,
    pub message_id: String,
    pub folder: String,
    pub return_to: String,
    pub until: i64,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Followup {
    pub account_id: String,
    pub message_id: String,
    pub subject: String,
    pub recipients: String,
    pub sent: i64,
    pub due: i64,
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
    pub thread: String,
    pub bulk: bool,
    /// Letters of the conversation, my answers in Sent included; 1 when the list is not grouped.
    pub thread_count: u32,
    /// The newest letter of the conversation, mine included; the row's own date otherwise.
    #[serde(default)]
    pub thread_date: i64,
    /// Who wrote in the conversation, in order of first appearance; empty when not grouped.
    #[serde(default)]
    pub thread_senders: Vec<Addr>,
    /// An answer is being written: the conversation has a saved draft.
    #[serde(default)]
    pub thread_draft: bool,
    pub snoozed_until: Option<i64>,
    /// The sender waits for an answer to this message until then.
    pub followup_due: Option<i64>,
}

/// Largest message downloaded for offline reading with attachments, bytes.
const OFFLINE_MAX_SIZE: u32 = 25 * 1024 * 1024;
/// Largest message without attachments downloaded for offline reading: bigger ones
/// carry files the server did not mark as attachments.
const OFFLINE_MAX_TEXT: u32 = 2 * 1024 * 1024;

/// What a list can be ordered by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortField {
    Date,
    Unread,
    Flagged,
    /// Mail from people before newsletters and robots.
    People,
    Sender,
    Subject,
    Size,
    Attachments,
    /// The search engine's rank; only in a search with words.
    Relevance,
}

/// One step of the order. `desc`: newest, biggest, Я→А; for yes/no keys the "yes" first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SortKey {
    pub by: SortField,
    #[serde(default)]
    pub desc: bool,
}

/// How a row looked when it was changed in the open list: it keeps its place by that
/// state until the list changes, so reading the top message of "unread first" does
/// not throw it down under the pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    pub id: i64,
    pub unread: bool,
    pub flagged: bool,
}

/// Pins beyond these are ignored: the expression grows with each one.
const MAX_PINS: usize = 500;

/// `CASE m.id WHEN … THEN … ELSE <now> END`: pinned rows keep their earlier state.
/// Ids and states are numbers, written into the SQL as literals.
fn pinned(pins: &[Pin], state: fn(&Pin) -> bool, now: &str) -> String {
    if pins.is_empty() {
        return now.to_owned();
    }
    let mut sql = String::from("(CASE m.id");
    for p in pins.iter().take(MAX_PINS) {
        sql.push_str(&format!(" WHEN {} THEN {}", p.id, u8::from(state(p))));
    }
    sql.push_str(&format!(" ELSE {now} END)"));
    sql
}

/// The ORDER BY of a list. `expr` gives each key's SQL; the newest first and the id
/// break ties, so pages follow each other without gaps or repeats.
fn order_by(sort: &[SortKey], expr: impl Fn(SortField) -> Option<String>, date: &str) -> String {
    let mut parts = Vec::new();
    let mut by_date = false;
    for k in sort {
        let Some(e) = expr(k.by) else { continue };
        by_date |= k.by == SortField::Date;
        // Relevance has one direction: the best match first (bm25 is lower for it).
        let desc = if k.by == SortField::Relevance { false } else { k.desc };
        parts.push(format!("{e} {}", if desc { "DESC" } else { "ASC" }));
    }
    if !by_date {
        parts.push(format!("{date} DESC"));
    }
    parts.push("m.id DESC".into());
    parts.join(", ")
}

/// Keys that are a column of the message itself.
fn message_sort_column(by: SortField) -> Option<&'static str> {
    Some(match by {
        SortField::Date => "m.date",
        SortField::Unread => "(m.seen = 0)",
        SortField::Flagged => "m.flagged",
        SortField::People => "(m.bulk = 0)",
        SortField::Sender => "m.sort_sender",
        SortField::Subject => "m.sort_subject",
        SortField::Size => "m.size",
        SortField::Attachments => "m.has_attachments",
        SortField::Relevance => return None,
    })
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
    /// Messages that stay in an unread or flagged list although they no longer
    /// match: the ones read or unflagged while it is open, as in Gmail.
    pub keep_ids: Vec<i64>,
    /// Only mail from people (`false`) or only lists and notifications (`true`).
    pub bulk: Option<bool>,
    /// One row per conversation: its newest message, with the count.
    pub threads: bool,
    /// Snoozed mail of every account, wherever it waits.
    pub snoozed_only: bool,
    /// Sent mail still waiting for an answer.
    pub followups_only: bool,
    /// The order, first key first; newest first when empty.
    pub sort: Vec<SortKey>,
    /// Rows changed in the open list: they sort by their earlier state.
    pub pins: Vec<Pin>,
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
    /// Flags changed here and not yet stored on the server: a sync in between
    /// must not bring the old value back.
    pending: Mutex<HashMap<(String, String, u32), PendingFlags>>,
}

/// Values the user set on one message, and how many changes still wait for the server.
#[derive(Debug, Default)]
struct PendingFlags {
    seen: Option<bool>,
    flagged: Option<bool>,
    answered: Option<bool>,
    waiting: u32,
}

impl PendingFlags {
    fn set(&mut self, change: FlagChange) {
        match change {
            FlagChange::Seen(v) => self.seen = Some(v),
            FlagChange::Flagged(v) => self.flagged = Some(v),
            FlagChange::Answered(v) => self.answered = Some(v),
        }
    }

    fn apply(&self, f: &mut Flags) {
        f.seen = self.seen.unwrap_or(f.seen);
        f.flagged = self.flagged.unwrap_or(f.flagged);
        f.answered = self.answered.unwrap_or(f.answered);
    }
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
        // SQLite's lower() and LIKE fold only ASCII: "иван" would not find "Иван".
        conn.create_scalar_function(
            "fold",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| Ok(ctx.get::<Option<String>>(0)?.map(|s| s.to_lowercase())),
        )?;
        // Databases created by older versions.
        for (table, column, decl) in [
            ("folders", "oldest_uid", "INTEGER NOT NULL DEFAULT 0"),
            ("messages", "thread", "TEXT NOT NULL DEFAULT ''"),
            ("messages", "bulk", "INTEGER NOT NULL DEFAULT 0"),
            ("messages", "unsubscribe", "TEXT"),
            ("outbox", "followup_secs", "INTEGER NOT NULL DEFAULT 0"),
            ("messages", "topic", "TEXT NOT NULL DEFAULT ''"),
            ("messages", "sort_sender", "TEXT NOT NULL DEFAULT ''"),
            ("messages", "sort_subject", "TEXT NOT NULL DEFAULT ''"),
        ] {
            let exists = conn
                .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))?
                .exists([column])?;
            if !exists {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
            }
        }
        // Old rows had no thread: each is its own conversation until resynced.
        conn.execute_batch(
            "UPDATE messages SET thread = COALESCE(message_id, folder || '/' || uid) WHERE thread = '';
             CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (account_id, thread);
             CREATE INDEX IF NOT EXISTS messages_by_message_id ON messages (account_id, message_id);
             CREATE INDEX IF NOT EXISTS messages_by_parent ON messages (account_id, in_reply_to);
             CREATE INDEX IF NOT EXISTS messages_by_topic ON messages (account_id, topic, date);",
        )?;
        let mut conn = conn;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            // Threads were keyed by the headers of each message alone and split apart
            // when a client dropped References: link them again, once.
            let tx = conn.transaction()?;
            rethread(&tx)?;
            tx.execute_batch("PRAGMA user_version = 1")?;
            tx.commit()?;
        }
        if version < 2 {
            // Sort keys of sender and subject for the mail cached before they existed.
            let tx = conn.transaction()?;
            fill_sort_keys(&tx)?;
            tx.execute_batch("PRAGMA user_version = 2")?;
            tx.commit()?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
            pending: Mutex::new(HashMap::new()),
        })
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<(String, String, u32), PendingFlags>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
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
                CASE f.role WHEN 'inbox' THEN 0 WHEN 'snoozed' THEN 1 WHEN 'drafts' THEN 2 WHEN 'sent' THEN 3
                            WHEN 'archive' THEN 4 WHEN 'junk' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END,
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
        let date = summary.date.unwrap_or(fallback_date);
        let links = Links::of(summary, date);
        let fallback = summary.thread_key().unwrap_or_else(|| format!("{folder}/{uid}"));
        let thread = link_thread(&tx, account_id, &links, fallback)?;
        let id: i64 = tx.query_row(
            "INSERT INTO messages (account_id, folder, uid, message_id, in_reply_to, refs, subject, from_addr,
                to_addrs, cc_addrs, reply_to, date, size, seen, answered, flagged, draft, has_attachments,
                thread, bulk, unsubscribe, topic, sort_sender, sort_subject)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
                ?23, ?24)
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
                date,
                size,
                flags.seen,
                flags.answered,
                flags.flagged,
                flags.draft,
                summary.has_attachments,
                thread,
                summary.bulk,
                summary.unsubscribe.as_ref().and_then(|u| serde_json::to_string(u).ok()),
                links.topic,
                crate::message::sender_sort_key(summary.from.as_ref()),
                crate::message::subject_sort_key(&summary.subject),
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

    /// Flags from the server. A change the user made here and the server has not
    /// stored yet keeps its value: the server's is the one from before it.
    pub fn update_flags(&self, account_id: &str, folder: &str, flags: &[(u32, Flags)]) -> Result<usize> {
        let flags: Vec<(u32, Flags)> = {
            let pending = self.pending();
            flags
                .iter()
                .map(|&(uid, mut f)| {
                    if let Some(p) = pending.get(&(account_id.to_owned(), folder.to_owned(), uid)) {
                        p.apply(&mut f);
                    }
                    (uid, f)
                })
                .collect()
        };
        self.write_flags(account_id, folder, &flags)
    }

    /// A flag changed by the user: cached at once and held against syncs until
    /// `settle_flags` reports the server's answer.
    pub fn change_flags(&self, account_id: &str, folder: &str, uids: &[u32], change: FlagChange) -> Result<usize> {
        {
            let mut pending = self.pending();
            for &uid in uids {
                let p = pending
                    .entry((account_id.to_owned(), folder.to_owned(), uid))
                    .or_default();
                p.set(change);
                p.waiting += 1;
            }
        }
        let flags: Vec<(u32, Flags)> = uids
            .iter()
            .filter_map(|&uid| self.find_by_uid(account_id, folder, uid).ok().flatten())
            .map(|r| (r.uid, r.flags))
            .collect();
        self.update_flags(account_id, folder, &flags)
    }

    /// The server answered one `change_flags`: syncs bring its flags again.
    pub fn settle_flags(&self, account_id: &str, folder: &str, uids: &[u32]) {
        let mut pending = self.pending();
        for &uid in uids {
            let key = (account_id.to_owned(), folder.to_owned(), uid);
            if let Some(p) = pending.get_mut(&key) {
                p.waiting = p.waiting.saturating_sub(1);
                if p.waiting == 0 {
                    pending.remove(&key);
                }
            }
        }
    }

    fn write_flags(&self, account_id: &str, folder: &str, flags: &[(u32, Flags)]) -> Result<usize> {
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
        let mut cond = String::from("1");
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(account) = &q.account_id {
            cond.push_str(" AND m.account_id = ?");
            args.push(account.clone().into());
        }
        if q.snoozed_only {
            cond.push_str(" AND EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id = m.account_id AND s.message_id = m.message_id)");
        } else if q.followups_only {
            cond.push_str(
                " AND f.role = 'sent' AND EXISTS (SELECT 1 FROM followups fu WHERE fu.account_id = m.account_id AND fu.message_id = m.message_id)",
            );
        } else {
            match (&q.folder, q.role) {
                (Some(folder), _) => {
                    cond.push_str(" AND m.folder = ?");
                    args.push(folder.clone().into());
                }
                (None, role) => {
                    cond.push_str(" AND f.role = ?");
                    args.push(role.unwrap_or(FolderRole::Inbox).as_str().to_owned().into());
                }
            }
        }
        let mut only = Vec::new();
        if q.unread_only {
            only.push("m.seen = 0");
        }
        if q.flagged_only {
            only.push("m.flagged = 1");
        }
        if !only.is_empty() {
            let only = only.join(" AND ");
            if q.keep_ids.is_empty() {
                cond.push_str(&format!(" AND {only}"));
            } else {
                let marks = vec!["?"; q.keep_ids.len()].join(",");
                cond.push_str(&format!(" AND ({only} OR m.id IN ({marks}))"));
                args.extend(q.keep_ids.iter().map(|&id| id.into()));
            }
        }
        if let Some(bulk) = q.bulk {
            cond.push_str(if bulk { " AND m.bulk = 1" } else { " AND m.bulk = 0" });
        }
        args.push(i64::from(if q.limit == 0 { 100 } else { q.limit }).into());
        args.push(i64::from(q.offset).into());

        let from = "messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder";
        let unread = pinned(&q.pins, |p| p.unread, "(m.seen = 0)");
        let flagged = pinned(&q.pins, |p| p.flagged, "m.flagged");
        let conn = self.conn();
        if !q.threads {
            let order = order_by(
                &q.sort,
                |by| {
                    Some(match by {
                        SortField::Date => "m.date".into(),
                        SortField::Unread => unread.clone(),
                        SortField::Flagged => flagged.clone(),
                        SortField::Relevance => return None,
                        other => message_sort_column(other)?.into(),
                    })
                },
                "m.date",
            );
            let sql = format!("SELECT {COLUMNS} FROM {from} WHERE {cond} ORDER BY {order} LIMIT ? OFFSET ?");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(args), message_row)?;
            return Ok(rows.collect::<Result<_, _>>()?);
        }
        // The newest message stands for its conversation: SQLite takes bare columns
        // from the row that holds the MAX, as long as it is the only MIN/MAX in the
        // query (hence SUM for flags). The row is unread or flagged when any message is.
        // The conversation moves up when I answer, as in Gmail: my answer in Sent counts.
        // Sorting looks at the whole conversation: unread or flagged when any letter is,
        // its size is the sum; sender and subject are the newest letter's.
        let order = order_by(
            &q.sort,
            |by| {
                Some(match by {
                    SortField::Date => "last".into(),
                    SortField::Unread => "(g.s_unread > 0)".into(),
                    SortField::Flagged => "(g.s_flagged > 0)".into(),
                    SortField::Size => "g.s_size".into(),
                    SortField::Attachments => "(g.s_files > 0)".into(),
                    SortField::Relevance => return None,
                    other => message_sort_column(other)?.into(),
                })
            },
            "last",
        );
        let sql = format!(
            "WITH g AS (
                SELECT m.id AS id, MAX(m.date) AS newest, SUM(m.seen = 0) AS unread, SUM(m.flagged) AS flagged,
                    SUM({unread}) AS s_unread, SUM({flagged}) AS s_flagged, SUM(m.size) AS s_size,
                    SUM(m.has_attachments) AS s_files
                FROM {from} WHERE {cond} GROUP BY m.account_id, m.thread
             )
             SELECT {COLUMNS}, g.unread, g.flagged,
                MAX(m.date, COALESCE((SELECT MAX(x.date) FROM messages x
                    JOIN folders xf ON xf.account_id = x.account_id AND xf.name = x.folder
                    WHERE x.account_id = m.account_id AND x.thread = m.thread
                      AND COALESCE(xf.role, '') NOT IN ('trash', 'junk', 'drafts')), 0)) AS last
             FROM g JOIN messages m ON m.id = g.id
             ORDER BY {order} LIMIT ? OFFSET ?"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| {
            let mut row = message_row(r)?;
            row.flags.seen = r.get::<_, i64>(COLUMN_COUNT)? == 0;
            row.flags.flagged = r.get::<_, i64>(COLUMN_COUNT + 1)? > 0;
            row.thread_date = r.get(COLUMN_COUNT + 2)?;
            Ok(row)
        })?;
        let mut rows: Vec<MessageRow> = rows.collect::<Result<_, _>>()?;
        drop(stmt);
        let mut letters = conn.prepare_cached(
            "SELECT m.id, m.message_id, m.from_addr, COALESCE(f.role, '') = 'drafts'
             FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
             WHERE m.account_id = ?1 AND m.thread = ?2 AND COALESCE(f.role, '') NOT IN ('trash', 'junk')
             ORDER BY m.date, m.id",
        )?;
        for row in &mut rows {
            let mut seen = HashSet::new();
            let (mut count, mut draft) = (0, false);
            let mut senders: Vec<Addr> = Vec::new();
            let found = letters.query_map(params![row.account_id, row.thread], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            })?;
            for letter in found {
                let (id, mid, from, is_draft) = letter?;
                if is_draft {
                    draft = true;
                    continue;
                }
                // A letter to oneself sits in Inbox and in Sent: one letter.
                if !seen.insert(mid.unwrap_or_else(|| format!("#{id}"))) {
                    continue;
                }
                count += 1;
                if let Some(a) = from.and_then(|s| serde_json::from_str::<Addr>(&s).ok())
                    && !senders.iter().any(|s| s.email.eq_ignore_ascii_case(&a.email))
                {
                    senders.push(a);
                }
            }
            row.thread_count = count.max(1);
            row.thread_senders = senders;
            row.thread_draft = draft;
        }
        Ok(rows)
    }

    /// The whole conversation, oldest first, from every folder but the trash and spam.
    pub fn thread(&self, account_id: &str, thread: &str) -> Result<Vec<MessageRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
             WHERE m.account_id = ?1 AND m.thread = ?2 AND COALESCE(f.role, '') NOT IN ('trash', 'junk')
             ORDER BY m.date, m.id"
        ))?;
        // A letter to oneself sits in Inbox and Sent with one Message-ID: both are
        // returned, actions need every copy; the GUI shows one.
        let rows = stmt.query_map(params![account_id, thread], message_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn unsubscribe_of(&self, id: i64) -> Result<Option<Unsubscribe>> {
        let json: Option<String> = self
            .conn()
            .query_row("SELECT unsubscribe FROM messages WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .flatten();
        Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
    }

    pub fn find_by_message_id(&self, account_id: &str, folder: &str, message_id: &str) -> Result<Option<MessageRow>> {
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM messages m WHERE m.account_id = ?1 AND m.folder = ?2 AND m.message_id = ?3"
                ),
                params![account_id, folder, message_id.trim_matches(['<', '>'])],
                message_row,
            )
            .optional()?)
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

    /// Messages to keep for offline reading: newer than `since`, outside Trash and
    /// Spam, without attachments unless `attachments`. The condition joins `m` and `f`.
    fn offline_cond(attachments: bool) -> String {
        let files = if attachments {
            format!("m.size <= {OFFLINE_MAX_SIZE}")
        } else {
            format!("m.has_attachments = 0 AND m.size <= {OFFLINE_MAX_TEXT}")
        };
        format!("m.account_id = ?1 AND m.date >= ?2 AND COALESCE(f.role, '') NOT IN ('trash', 'junk') AND {files}")
    }

    /// Offline messages whose text is not downloaded yet, newest first: `(id, folder, uid)`.
    pub fn bodies_missing(
        &self,
        account_id: &str,
        since: i64,
        attachments: bool,
        limit: u32,
    ) -> Result<Vec<(i64, String, u32)>> {
        let sql = format!(
            "SELECT m.id, m.folder, m.uid FROM messages m
             JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
             WHERE {} AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)
             ORDER BY m.date DESC LIMIT ?3",
            Self::offline_cond(attachments)
        );
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![account_id, since, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Offline messages with their text downloaded, and all of them.
    pub fn offline_progress(&self, account_id: &str, since: i64, attachments: bool) -> Result<(u64, u64)> {
        let sql = format!(
            "SELECT COUNT(b.message_id), COUNT(*) FROM messages m
             JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
             LEFT JOIN bodies b ON b.message_id = m.id
             WHERE {}",
            Self::offline_cond(attachments)
        );
        let (done, total): (i64, i64) = self
            .conn()
            .query_row(&sql, params![account_id, since], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok((done as u64, total as u64))
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

    /// Search over subject, addresses and the bodies already downloaded, with
    /// operators (see `query`). Trash and spam only with `in:`. Newest first unless `sort` says otherwise.
    pub fn search(
        &self,
        text: &str,
        account_id: Option<&str>,
        limit: u32,
        sort: &[SortKey],
    ) -> Result<Vec<MessageRow>> {
        let q = SearchQuery::parse(text);
        let mut terms: Vec<String> = Vec::new();
        let mut column = |col: Option<&str>, value: &str| {
            for w in value.split_whitespace() {
                let w = w.replace('"', "");
                if w.is_empty() {
                    continue;
                }
                terms.push(match col {
                    Some(c) => format!("{c} : \"{w}\"*"),
                    None => format!("\"{w}\"*"),
                });
            }
        };
        q.words.iter().for_each(|w| column(None, w));
        q.from.iter().for_each(|w| column(Some("sender"), w));
        q.to.iter().for_each(|w| column(Some("recipients"), w));
        q.subject.iter().for_each(|w| column(Some("subject"), w));

        let mut cond = String::from("(?1 IS NULL OR m.account_id = ?1)");
        let mut args: Vec<rusqlite::types::Value> = vec![account_id.map(str::to_owned).into()];
        let mut filtered = false;
        if q.has_attachment {
            cond.push_str(" AND m.has_attachments = 1");
            filtered = true;
        }
        if q.unread {
            cond.push_str(" AND m.seen = 0");
            filtered = true;
        }
        if q.flagged {
            cond.push_str(" AND m.flagged = 1");
            filtered = true;
        }
        if let Some(t) = q.after {
            args.push(t.into());
            cond.push_str(&format!(" AND m.date >= ?{}", args.len()));
            filtered = true;
        }
        if let Some(t) = q.before {
            args.push(t.into());
            cond.push_str(&format!(" AND m.date < ?{}", args.len()));
            filtered = true;
        }
        match &q.folder {
            Some(folder) => {
                args.push(folder.clone().into());
                let n = args.len();
                let role = role_word(folder).map(FolderRole::as_str).unwrap_or("");
                args.push(role.to_owned().into());
                cond.push_str(&format!(
                    " AND (f.name = ?{n} COLLATE NOCASE OR f.display_name = ?{n} COLLATE NOCASE OR f.role = ?{})",
                    n + 1
                ));
                filtered = true;
            }
            None => cond.push_str(" AND COALESCE(f.role, '') NOT IN ('trash', 'junk')"),
        }
        if terms.is_empty() && !filtered {
            return Ok(Vec::new());
        }
        args.push(i64::from(if limit == 0 { 100 } else { limit }).into());
        let limit_arg = args.len();
        let join = "JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder";
        let words = !terms.is_empty();
        let order = order_by(
            sort,
            |by| match by {
                SortField::Relevance => words.then(|| "bm25(search)".into()),
                other => message_sort_column(other).map(Into::into),
            },
            "m.date",
        );
        let sql = if !words {
            format!("SELECT {COLUMNS} FROM messages m {join} WHERE {cond} ORDER BY {order} LIMIT ?{limit_arg}")
        } else {
            args.push(terms.join(" ").into());
            format!(
                "SELECT {COLUMNS} FROM search s JOIN messages m ON m.id = s.rowid {join}
                 WHERE search MATCH ?{} AND {cond} ORDER BY {order} LIMIT ?{limit_arg}",
                args.len()
            )
        };
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), message_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn snooze_add(&self, s: &Snooze) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO snoozed (account_id, message_id, folder, return_to, until, subject)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![s.account_id, s.message_id, s.folder, s.return_to, s.until, s.subject],
        )?;
        Ok(())
    }

    pub fn snooze_remove(&self, account_id: &str, message_id: &str) -> Result<Option<Snooze>> {
        Ok(self
            .conn()
            .query_row(
                "DELETE FROM snoozed WHERE account_id = ?1 AND message_id = ?2
                 RETURNING account_id, message_id, folder, return_to, until, subject",
                params![account_id, message_id],
                snooze_row,
            )
            .optional()?)
    }

    pub fn snoozes_due(&self, now: i64) -> Result<Vec<Snooze>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT account_id, message_id, folder, return_to, until, subject FROM snoozed WHERE until <= ?1 ORDER BY until",
        )?;
        let rows = stmt.query_map([now], snooze_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Snoozed messages, or conversations with `threads`: a snoozed conversation is one.
    pub fn snoozed_count(&self, threads: bool) -> Result<u32> {
        let sql = if threads {
            "SELECT COUNT(DISTINCT s.account_id || char(0) || COALESCE(m.thread, '#' || s.message_id))
             FROM snoozed s LEFT JOIN messages m ON m.account_id = s.account_id AND m.message_id = s.message_id"
        } else {
            "SELECT COUNT(*) FROM snoozed"
        };
        Ok(self.conn().query_row(sql, [], |r| r.get(0))?)
    }

    pub fn followup_add(&self, f: &Followup) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO followups (account_id, message_id, subject, recipients, sent, due)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![f.account_id, f.message_id, f.subject, f.recipients, f.sent, f.due],
        )?;
        Ok(())
    }

    pub fn followup_remove(&self, account_id: &str, message_id: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM followups WHERE account_id = ?1 AND message_id = ?2",
            params![account_id, message_id.trim_matches(['<', '>'])],
        )?;
        Ok(())
    }

    /// Drops reminders that got an answer: a message outside Sent and Drafts that
    /// replies to the sent one. Returns how many were resolved.
    pub fn followups_resolve(&self) -> Result<usize> {
        Ok(self.conn().execute(
            "DELETE FROM followups WHERE EXISTS (
                SELECT 1 FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
                WHERE m.account_id = followups.account_id
                  AND COALESCE(f.role, '') NOT IN ('sent', 'drafts')
                  AND (m.in_reply_to = followups.message_id
                       OR m.refs LIKE '%\"' || followups.message_id || '\"%'))",
            [],
        )?)
    }

    /// Reminders due now that were not announced yet; marks them announced.
    pub fn followups_due(&self, now: i64) -> Result<Vec<Followup>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "UPDATE followups SET notified = 1 WHERE due <= ?1 AND notified = 0
             RETURNING account_id, message_id, subject, recipients, sent, due",
        )?;
        let rows = stmt.query_map([now], |r| {
            Ok(Followup {
                account_id: r.get(0)?,
                message_id: r.get(1)?,
                subject: r.get(2)?,
                recipients: r.get(3)?,
                sent: r.get(4)?,
                due: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn followups_count(&self) -> Result<u32> {
        Ok(self
            .conn()
            .query_row("SELECT COUNT(*) FROM followups", [], |r| r.get(0))?)
    }

    pub fn forget_account(&self, account_id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM folders WHERE account_id = ?1", [account_id])?;
        conn.execute("DELETE FROM outbox WHERE account_id = ?1", [account_id])?;
        conn.execute("DELETE FROM snoozed WHERE account_id = ?1", [account_id])?;
        conn.execute("DELETE FROM followups WHERE account_id = ?1", [account_id])?;
        conn.execute("DELETE FROM ews_folders WHERE account_id = ?1", [account_id])?;
        conn.execute("DELETE FROM ews_items WHERE account_id = ?1", [account_id])?;
        Ok(())
    }

    /// Records the EWS id of every folder name. Returns names whose id changed (the
    /// folder was deleted and created again): their cache no longer matches the server.
    pub fn ews_set_folders(&self, account_id: &str, folders: &[(String, String)]) -> Result<Vec<String>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut changed = Vec::new();
        {
            let mut get = tx.prepare("SELECT folder_id FROM ews_folders WHERE account_id = ?1 AND name = ?2")?;
            let mut upsert = tx.prepare(
                "INSERT INTO ews_folders (account_id, name, folder_id) VALUES (?1, ?2, ?3)
                 ON CONFLICT (account_id, name) DO UPDATE SET folder_id = excluded.folder_id",
            )?;
            for (name, id) in folders {
                let old: Option<String> = get.query_row(params![account_id, name], |r| r.get(0)).optional()?;
                if old.as_ref().is_some_and(|o| o != id) {
                    changed.push(name.clone());
                }
                upsert.execute(params![account_id, name, id])?;
            }
            let names: Vec<&str> = folders.iter().map(|(n, _)| n.as_str()).collect();
            let existing: Vec<String> = tx
                .prepare("SELECT name FROM ews_folders WHERE account_id = ?1")?
                .query_map([account_id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            for name in existing.iter().filter(|n| !names.contains(&n.as_str())) {
                tx.execute(
                    "DELETE FROM ews_folders WHERE account_id = ?1 AND name = ?2",
                    params![account_id, name],
                )?;
                tx.execute(
                    "DELETE FROM ews_items WHERE account_id = ?1 AND folder = ?2",
                    params![account_id, name],
                )?;
            }
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn ews_folder_id(&self, account_id: &str, name: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT folder_id FROM ews_folders WHERE account_id = ?1 AND name = ?2",
                params![account_id, name],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn ews_window(&self, account_id: &str, name: &str) -> Result<i64> {
        Ok(self
            .conn()
            .query_row(
                "SELECT window_date FROM ews_folders WHERE account_id = ?1 AND name = ?2",
                params![account_id, name],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(-1))
    }

    pub fn ews_set_window(&self, account_id: &str, name: &str, window_date: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE ews_folders SET window_date = ?3 WHERE account_id = ?1 AND name = ?2",
            params![account_id, name, window_date],
        )?;
        Ok(())
    }

    /// Forgets the cache of a folder: messages, item ids and the synced window.
    pub fn ews_clear_folder(&self, account_id: &str, name: &str) -> Result<()> {
        self.clear_folder(account_id, name)?;
        let conn = self.conn();
        conn.execute(
            "DELETE FROM ews_items WHERE account_id = ?1 AND folder = ?2",
            params![account_id, name],
        )?;
        conn.execute(
            "UPDATE ews_folders SET window_date = -1 WHERE account_id = ?1 AND name = ?2",
            params![account_id, name],
        )?;
        conn.execute(
            "UPDATE folders SET last_uid = 0 WHERE account_id = ?1 AND name = ?2",
            params![account_id, name],
        )?;
        Ok(())
    }

    /// `(uid, item id, received)` of every cached item of the folder.
    pub fn ews_items(&self, account_id: &str, folder: &str) -> Result<Vec<(u32, String, i64)>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT uid, item_id, received FROM ews_items WHERE account_id = ?1 AND folder = ?2")?;
        let rows = stmt.query_map(params![account_id, folder], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn ews_item_add(&self, account_id: &str, folder: &str, uid: u32, item_id: &str, received: i64) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO ews_items (account_id, folder, uid, item_id, received) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![account_id, folder, uid, item_id, received],
        )?;
        Ok(())
    }

    pub fn ews_items_remove(&self, account_id: &str, folder: &str, uids: &[u32]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("DELETE FROM ews_items WHERE account_id = ?1 AND folder = ?2 AND uid = ?3")?;
            for uid in uids {
                stmt.execute(params![account_id, folder, uid])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Item ids for UIDs, in the same order; unknown UIDs are skipped.
    pub fn ews_item_ids(&self, account_id: &str, folder: &str, uids: &[u32]) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT item_id FROM ews_items WHERE account_id = ?1 AND folder = ?2 AND uid = ?3")?;
        let mut out = Vec::with_capacity(uids.len());
        for uid in uids {
            if let Some(id) = stmt
                .query_row(params![account_id, folder, uid], |r| r.get(0))
                .optional()?
            {
                out.push(id);
            }
        }
        Ok(out)
    }

    pub fn ews_uid_of(&self, account_id: &str, folder: &str, item_id: &str) -> Result<Option<u32>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT uid FROM ews_items WHERE account_id = ?1 AND folder = ?2 AND item_id = ?3",
                params![account_id, folder, item_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn ews_min_uid(&self, account_id: &str, folder: &str) -> Result<Option<u32>> {
        Ok(self.conn().query_row(
            "SELECT MIN(uid) FROM ews_items WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
            |r| r.get(0),
        )?)
    }

    /// Queues a message to go out at `at` (now, after the undo delay, or a scheduled time).
    pub fn outbox_add(&self, account_id: &str, draft: &Draft, now: i64, at: i64, followup_secs: i64) -> Result<i64> {
        let json = serde_json::to_string(draft).map_err(|e| crate::Error::Compose(e.to_string()))?;
        Ok(self.conn().query_row(
            "INSERT INTO outbox (account_id, draft, next_attempt, created, followup_secs)
             VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
            params![account_id, json, at.max(now), now, followup_secs],
            |r| r.get(0),
        )?)
    }

    pub fn outbox(&self) -> Result<Vec<OutboxItem>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, account_id, draft, attempts, next_attempt, last_error, failed, created, followup_secs
             FROM outbox ORDER BY next_attempt, id",
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
                created: r.get(7)?,
                followup_secs: r.get(8)?,
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

    /// A cached sender picture: `Some((uri, fetched))`, uri `None` when there was none.
    pub fn avatar(&self, key: &str) -> Result<Option<(Option<String>, i64)>> {
        Ok(self
            .conn()
            .query_row("SELECT uri, fetched FROM avatars WHERE key = ?1", [key], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?)
    }

    pub fn set_avatar(&self, key: &str, uri: Option<&str>, fetched: i64) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO avatars (key, uri, fetched) VALUES (?1, ?2, ?3)",
            params![key, uri, fetched],
        )?;
        Ok(())
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
             WHERE fold(email) LIKE ?1 || '%' ESCAPE '\\' OR fold(name) LIKE '%' || ?1 || '%' ESCAPE '\\'
             GROUP BY fold(email) ORDER BY COUNT(*) DESC LIMIT ?2",
        )?;
        let escaped = prefix
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let rows = stmt.query_map(params![escaped, limit], |r| {
            Ok(Addr {
                email: r.get(0)?,
                name: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// Answers matched by subject alone are looked for this close to the original.
const TOPIC_WINDOW: i64 = 30 * 86_400;

/// What ties a message to the rest of its conversation.
struct Links {
    message_id: Option<String>,
    /// References and In-Reply-To: the messages this one answers.
    parents: Vec<String>,
    topic: String,
    is_reply: bool,
    from: Option<String>,
    /// Sender and recipients, lower-cased.
    people: Vec<String>,
    date: i64,
}

impl Links {
    fn of(s: &Summary, date: i64) -> Self {
        let mut parents: Vec<String> = s.references.iter().filter(|r| !r.is_empty()).cloned().collect();
        if let Some(p) = s.in_reply_to.as_ref().filter(|p| !p.is_empty() && !parents.contains(p)) {
            parents.push(p.clone());
        }
        Self {
            message_id: s.message_id.clone().filter(|m| !m.is_empty()),
            parents,
            topic: crate::message::topic(&s.subject),
            is_reply: s.is_reply(),
            from: s.from.as_ref().map(|a| a.email.to_lowercase()),
            people: people(s.from.as_ref(), &s.to, &s.cc),
            date,
        }
    }
}

fn people(from: Option<&Addr>, to: &[Addr], cc: &[Addr]) -> Vec<String> {
    from.into_iter()
        .chain(to)
        .chain(cc)
        .map(|a| a.email.to_lowercase())
        .collect()
}

/// The conversation of a new message: the one of any cached message it answers or
/// that answers it, else an earlier letter with the same subject between the same
/// people (Outlook and phones often send answers without References). Conversations
/// the message turns out to join are merged into one.
fn link_thread(conn: &Connection, account_id: &str, l: &Links, fallback: String) -> Result<String> {
    let mut found: Vec<String> = Vec::new();
    fn add(found: &mut Vec<String>, t: String) {
        if !t.is_empty() && !found.contains(&t) {
            found.push(t);
        }
    }
    {
        let mut by_id = conn
            .prepare_cached("SELECT thread FROM messages WHERE account_id = ?1 AND message_id = ?2 AND thread != ''")?;
        // Nearest parent first: its conversation is the one the others merge into.
        for p in l.parents.iter().rev().chain(&l.message_id) {
            for t in by_id.query_map(params![account_id, p], |r| r.get(0))? {
                add(&mut found, t?);
            }
        }
        if let Some(mid) = &l.message_id {
            // Answers that arrived before this message.
            let mut children = conn.prepare_cached(
                "SELECT thread FROM messages WHERE account_id = ?1 AND in_reply_to = ?2 AND thread != ''",
            )?;
            for t in children.query_map(params![account_id, mid], |r| r.get(0))? {
                add(&mut found, t?);
            }
        }
    }
    if found.is_empty()
        && l.is_reply
        && !l.topic.is_empty()
        && let Some(from) = &l.from
    {
        let mut same = conn.prepare_cached(
            "SELECT thread, from_addr, to_addrs, cc_addrs FROM messages
             WHERE account_id = ?1 AND topic = ?2 AND date BETWEEN ?3 AND ?4 AND thread != ''
             ORDER BY ABS(date - ?5) LIMIT 20",
        )?;
        let rows = same.query_map(
            params![
                account_id,
                l.topic,
                l.date - TOPIC_WINDOW,
                l.date + TOPIC_WINDOW,
                l.date
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )?;
        for row in rows {
            let (thread, f, to, cc) = row?;
            let f: Option<Addr> = f.and_then(|s| serde_json::from_str(&s).ok());
            let to: Vec<Addr> = serde_json::from_str(&to).unwrap_or_default();
            let cc: Vec<Addr> = serde_json::from_str(&cc).unwrap_or_default();
            // An answer goes between the same people: each side wrote to the other.
            let theirs = people(f.as_ref(), &to, &cc);
            let their_from = f.map(|a| a.email.to_lowercase());
            if theirs.contains(from) && their_from.is_some_and(|tf| l.people.contains(&tf)) {
                add(&mut found, thread);
                break;
            }
        }
    }
    let Some(thread) = found.first().cloned() else {
        return Ok(fallback);
    };
    let mut merge = conn.prepare_cached("UPDATE messages SET thread = ?3 WHERE account_id = ?1 AND thread = ?2")?;
    for other in &found[1..] {
        merge.execute(params![account_id, other, thread])?;
    }
    Ok(thread)
}

/// Links every cached message again, oldest first, as if it had just arrived.
fn rethread(conn: &Connection) -> Result<()> {
    struct Old {
        id: i64,
        account_id: String,
        summary: Summary,
        date: i64,
        thread: String,
    }
    let old: Vec<Old> = {
        let mut stmt = conn.prepare(
            "SELECT id, account_id, message_id, in_reply_to, refs, subject, from_addr, to_addrs, cc_addrs, date, thread
             FROM messages ORDER BY date, id",
        )?;
        stmt.query_map([], |r| {
            Ok(Old {
                id: r.get(0)?,
                account_id: r.get(1)?,
                summary: Summary {
                    message_id: r.get(2)?,
                    in_reply_to: r.get(3)?,
                    references: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                    subject: r.get(5)?,
                    from: r
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    to: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
                    cc: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
                    ..Default::default()
                },
                date: r.get(9)?,
                thread: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    conn.execute("UPDATE messages SET thread = ''", [])?;
    let mut set = conn.prepare("UPDATE messages SET thread = ?2, topic = ?3 WHERE id = ?1")?;
    for m in old {
        let links = Links::of(&m.summary, m.date);
        // The key stored before knew Exchange's thread index, which the cache does not keep.
        let thread = link_thread(conn, &m.account_id, &links, m.thread)?;
        set.execute(params![m.id, thread, links.topic])?;
    }
    Ok(())
}

/// Sort keys of every cached message, from its sender and subject.
fn fill_sort_keys(conn: &Connection) -> Result<()> {
    let rows: Vec<(i64, String, Option<String>)> = conn
        .prepare("SELECT id, subject, from_addr FROM messages")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut set = conn.prepare("UPDATE messages SET sort_sender = ?2, sort_subject = ?3 WHERE id = ?1")?;
    for (id, subject, from) in rows {
        let from: Option<Addr> = from.and_then(|s| serde_json::from_str(&s).ok());
        set.execute(params![
            id,
            crate::message::sender_sort_key(from.as_ref()),
            crate::message::subject_sort_key(&subject)
        ])?;
    }
    Ok(())
}

const COLUMNS: &str = "m.id, m.account_id, m.folder, m.uid, m.message_id, m.in_reply_to, m.refs, m.subject,
    m.from_addr, m.to_addrs, m.cc_addrs, m.reply_to, m.date, m.size,
    m.seen, m.answered, m.flagged, m.draft, m.has_attachments, m.thread, m.bulk,
    (SELECT s.until FROM snoozed s WHERE s.account_id = m.account_id AND s.message_id = m.message_id),
    (SELECT fu.due FROM followups fu WHERE fu.account_id = m.account_id AND fu.message_id = m.message_id)";
const COLUMN_COUNT: usize = 23;

fn snooze_row(r: &Row<'_>) -> rusqlite::Result<Snooze> {
    Ok(Snooze {
        account_id: r.get(0)?,
        message_id: r.get(1)?,
        folder: r.get(2)?,
        return_to: r.get(3)?,
        until: r.get(4)?,
        subject: r.get(5)?,
    })
}

/// `in:` accepts role words in both languages.
fn role_word(word: &str) -> Option<FolderRole> {
    Some(match word.to_lowercase().as_str() {
        "inbox" | "входящие" => FolderRole::Inbox,
        "sent" | "отправленные" => FolderRole::Sent,
        "drafts" | "черновики" => FolderRole::Drafts,
        "archive" | "архив" => FolderRole::Archive,
        "trash" | "корзина" => FolderRole::Trash,
        "spam" | "junk" | "спам" => FolderRole::Junk,
        "snoozed" | "отложенные" => FolderRole::Snoozed,
        _ => return None,
    })
}

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
        thread: r.get(19)?,
        bulk: r.get(20)?,
        thread_count: 1,
        thread_date: r.get(12)?,
        thread_senders: Vec::new(),
        thread_draft: false,
        snoozed_until: r.get(21)?,
        followup_due: r.get(22)?,
    })
}

fn addr_text(a: &Addr) -> String {
    match &a.name {
        Some(name) => format!("{name} {}", a.email),
        None => a.email.clone(),
    }
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

    #[test]
    fn known_addresses_ignore_case_in_any_alphabet() {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders("a", &[folder("INBOX", Some(FolderRole::Inbox))])
            .unwrap();
        let mail = summary("Привет", 100);
        let msg = NewMessage {
            uid: 1,
            summary: &mail,
            fallback_date: 0,
            size: 10,
            flags: Flags::default(),
        };
        store.insert_message("a", "INBOX", &msg).unwrap();
        for prefix in ["иван", "ИВАН", "пЕт", "IVAN", "Ivan@"] {
            let found = store.known_addresses(prefix, 8).unwrap();
            assert_eq!(found.len(), 1, "{prefix}");
            assert_eq!(found[0].email, "ivan@example.org");
        }
        assert!(store.known_addresses("сидор", 8).unwrap().is_empty());
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

        assert_eq!(store.search("счёт", None, 0, &[]).unwrap().len(), 1);
        assert_eq!(store.search("петров", None, 0, &[]).unwrap().len(), 3);
        store.save_body(id1, b"raw", "оплатить до пятницы").unwrap();
        assert_eq!(store.search("пятниц", None, 0, &[]).unwrap()[0].id, id1);
        assert!(store.search("\"", None, 0, &[]).unwrap().is_empty());

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
        // Read while the unread list is open: it stays there until the list changes.
        let unread = |keep_ids: Vec<i64>, threads: bool| {
            store
                .list(&ListQuery {
                    unread_only: true,
                    keep_ids,
                    threads,
                    ..Default::default()
                })
                .unwrap()
        };
        assert!(unread(vec![], false).is_empty());
        for threads in [false, true] {
            let kept = unread(vec![id1], threads);
            assert_eq!(kept.len(), 1);
            assert!(kept[0].flags.seen);
        }

        let folders = store.folders(Some("a")).unwrap();
        assert_eq!(folders.iter().find(|f| f.folder.name == "INBOX").unwrap().unread, 0);

        store.remove_uids("a", "INBOX", &[1]).unwrap();
        assert!(store.get(id1).unwrap().is_none());
        assert!(store.search("пятниц", None, 0, &[]).unwrap().is_empty());

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

    fn with_ids(subject: &str, date: i64, id: &str, parent: Option<&str>) -> Summary {
        Summary {
            message_id: Some(id.into()),
            in_reply_to: parent.map(Into::into),
            references: parent.map(|p| vec![p.to_owned()]).unwrap_or_default(),
            ..summary(subject, date)
        }
    }

    fn put(store: &Store, folder: &str, uid: u32, s: &Summary, seen: bool) -> i64 {
        let msg = NewMessage {
            uid,
            summary: s,
            fallback_date: 0,
            size: 1,
            flags: Flags {
                seen,
                ..Default::default()
            },
        };
        store.insert_message("a", folder, &msg).unwrap()
    }

    #[test]
    fn sync_keeps_flags_the_server_has_not_stored_yet() {
        let store = mailbox();
        let id = put(&store, "INBOX", 7, &summary("Отчёт", 100), false);
        let seen = |store: &Store| store.get(id).unwrap().unwrap().flags.seen;
        let server = |seen| {
            [(
                7,
                Flags {
                    seen,
                    ..Default::default()
                },
            )]
        };

        // Opened here; a sync from before the server stored \Seen does not unread it.
        store.change_flags("a", "INBOX", &[7], FlagChange::Seen(true)).unwrap();
        assert!(seen(&store));
        assert_eq!(store.update_flags("a", "INBOX", &server(false)).unwrap(), 0);
        assert!(seen(&store));

        // Two changes in flight: the later value holds until both are answered.
        store.change_flags("a", "INBOX", &[7], FlagChange::Seen(false)).unwrap();
        store.settle_flags("a", "INBOX", &[7]);
        store.update_flags("a", "INBOX", &server(true)).unwrap();
        assert!(!seen(&store));

        // All answered: the server is right again, other clients' changes included.
        store.settle_flags("a", "INBOX", &[7]);
        store.update_flags("a", "INBOX", &server(true)).unwrap();
        assert!(seen(&store));
        store.settle_flags("a", "INBOX", &[7]);
        store.update_flags("a", "INBOX", &server(false)).unwrap();
        assert!(!seen(&store));
    }

    #[test]
    fn offline_window_picks_recent_text_mail() {
        let store = mailbox();
        let old = put(&store, "INBOX", 1, &summary("Старое", 100), true);
        let fresh = put(&store, "INBOX", 2, &summary("Свежее", 1_000), true);
        let sent = put(&store, "Sent", 3, &summary("Ответ", 1_100), true);
        put(&store, "Trash", 4, &summary("Удалённое", 1_200), true);
        let files = Summary {
            has_attachments: true,
            ..summary("С файлом", 1_300)
        };
        let with_files = put(&store, "INBOX", 5, &files, true);

        let ids = |attachments| -> Vec<i64> {
            store
                .bodies_missing("a", 500, attachments, 10)
                .unwrap()
                .into_iter()
                .map(|(id, _, _)| id)
                .collect()
        };
        // Newest first; the old one, Trash and (by default) attachments stay out.
        assert_eq!(ids(false), [sent, fresh]);
        assert_eq!(ids(true), [with_files, sent, fresh]);
        assert_eq!(store.offline_progress("a", 500, false).unwrap(), (0, 2));

        store.save_body(fresh, b"raw", "text").unwrap();
        assert_eq!(ids(false), [sent]);
        assert_eq!(store.offline_progress("a", 500, false).unwrap(), (1, 2));
        assert_eq!(store.offline_progress("a", 0, false).unwrap(), (1, 3));
        assert!(!ids(false).contains(&old));
    }

    fn mailbox() -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders(
                "a",
                &[
                    folder("INBOX", Some(FolderRole::Inbox)),
                    folder("Sent", Some(FolderRole::Sent)),
                    folder("Trash", Some(FolderRole::Trash)),
                    folder("Snoozed", None),
                ],
            )
            .unwrap();
        store
    }

    #[test]
    fn conversations_group_into_one_row() {
        let store = mailbox();
        put(&store, "INBOX", 1, &with_ids("Договор", 100, "a@x", None), true);
        put(
            &store,
            "Sent",
            1,
            &with_ids("Re: Договор", 200, "b@x", Some("a@x")),
            true,
        );
        put(
            &store,
            "INBOX",
            2,
            &with_ids("Re: Договор", 300, "c@x", Some("a@x")),
            false,
        );
        put(&store, "INBOX", 3, &summary("Другое", 250), true);

        let q = ListQuery {
            threads: true,
            ..Default::default()
        };
        let rows = store.list(&q).unwrap();
        assert_eq!(rows.len(), 2);
        // My answer from Sent counts as a letter of the conversation.
        assert_eq!(
            (rows[0].subject.as_str(), rows[0].thread_count, rows[0].flags.seen),
            ("Re: Договор", 3, false)
        );
        assert_eq!(rows[1].thread_count, 1);

        // The conversation view includes my answer from Sent, oldest first.
        let conv = store.thread("a", &rows[0].thread).unwrap();
        assert_eq!(conv.iter().map(|m| m.date).collect::<Vec<_>>(), [100, 200, 300]);
    }

    fn from_to(mut s: Summary, from: &str, to: &str) -> Summary {
        s.from = Some(Addr {
            name: None,
            email: from.into(),
        });
        s.to = vec![Addr {
            name: None,
            email: to.into(),
        }];
        s
    }

    fn thread_of(store: &Store, id: i64) -> String {
        store.get(id).unwrap().unwrap().thread
    }

    #[test]
    fn answers_without_references_join_the_conversation() {
        let store = mailbox();
        let a = put(&store, "INBOX", 1, &with_ids("Договор", 100, "a@x", None), true);
        // Outlook: only In-Reply-To, the parent's id, no References.
        let mut b = with_ids("RE: Договор", 200, "b@x", None);
        b.in_reply_to = Some("a@x".into());
        let b = put(&store, "Sent", 1, &b, true);
        let mut c = with_ids("RE: Договор", 300, "c@x", None);
        c.in_reply_to = Some("b@x".into());
        let c = put(&store, "INBOX", 2, &c, true);
        assert_eq!(thread_of(&store, b), thread_of(&store, a));
        assert_eq!(thread_of(&store, c), thread_of(&store, a));
    }

    #[test]
    fn an_answer_that_came_first_is_joined_by_its_original() {
        let store = mailbox();
        let mut c = with_ids("Re: План", 300, "c@x", None);
        c.in_reply_to = Some("b@x".into());
        let c = put(&store, "INBOX", 1, &c, true);
        let a = put(&store, "INBOX", 2, &with_ids("План", 100, "a@x", None), true);
        let b = put(&store, "Sent", 1, &with_ids("Re: План", 200, "b@x", Some("a@x")), true);
        assert_eq!(thread_of(&store, a), thread_of(&store, b));
        assert_eq!(thread_of(&store, c), thread_of(&store, a));
    }

    #[test]
    fn answers_without_headers_match_by_subject_between_the_same_people() {
        let store = mailbox();
        let a = put(
            &store,
            "INBOX",
            1,
            &from_to(with_ids("Счёт", 100, "a@x", None), "ivan@x", "me@x"),
            true,
        );
        // My answer from a phone that sets no In-Reply-To.
        let b = put(
            &store,
            "Sent",
            1,
            &from_to(with_ids("Re: счёт ", 200, "b@x", None), "me@x", "ivan@x"),
            true,
        );
        // Someone else with the same subject is another conversation.
        let c = put(
            &store,
            "INBOX",
            2,
            &from_to(with_ids("Re: Счёт", 300, "c@x", None), "petr@x", "me@x"),
            true,
        );
        // So is the same subject a year later.
        let d = put(
            &store,
            "INBOX",
            3,
            &from_to(with_ids("Re: Счёт", 100 + 365 * 86_400, "d@x", None), "ivan@x", "me@x"),
            true,
        );
        assert_eq!(thread_of(&store, b), thread_of(&store, a));
        assert_ne!(thread_of(&store, c), thread_of(&store, a));
        assert_ne!(thread_of(&store, d), thread_of(&store, a));
    }

    #[test]
    fn grouped_rows_tell_who_wrote_and_when_last() {
        let store = mailbox();
        put(
            &store,
            "INBOX",
            1,
            &from_to(with_ids("Отпуск", 100, "a@x", None), "ivan@x", "me@x"),
            true,
        );
        put(
            &store,
            "Sent",
            1,
            &from_to(with_ids("Re: Отпуск", 500, "b@x", Some("a@x")), "me@x", "ivan@x"),
            true,
        );
        put(&store, "INBOX", 2, &summary("Другое", 300), true);
        let rows = store
            .list(&ListQuery {
                threads: true,
                ..Default::default()
            })
            .unwrap();
        // My answer at 500 moves the conversation above the letter of 300.
        assert_eq!(rows[0].subject, "Отпуск");
        assert_eq!((rows[0].date, rows[0].thread_date), (100, 500));
        let who: Vec<_> = rows[0].thread_senders.iter().map(|a| a.email.as_str()).collect();
        assert_eq!(who, ["ivan@x", "me@x"]);
    }

    #[test]
    fn old_caches_are_linked_again() {
        let store = mailbox();
        let a = put(&store, "INBOX", 1, &with_ids("Смета", 100, "a@x", None), true);
        let mut b = with_ids("RE: Смета", 200, "b@x", None);
        b.in_reply_to = Some("a@x".into());
        let b = put(&store, "INBOX", 2, &b, true);
        // As an older version stored them: each message keyed by its own headers.
        let mut conn = store.conn();
        conn.execute("UPDATE messages SET thread = message_id, topic = ''", [])
            .unwrap();
        let tx = conn.transaction().unwrap();
        rethread(&tx).unwrap();
        tx.commit().unwrap();
        drop(conn);
        assert_eq!(thread_of(&store, b), thread_of(&store, a));
    }

    #[test]
    fn search_operators() {
        let store = mailbox();
        let mut bill = with_ids("Счёт на оплату", 100, "a@x", None);
        bill.has_attachments = true;
        put(&store, "INBOX", 1, &bill, false);
        let mut other = with_ids("Отчёт", 200, "b@x", None);
        other.from = Some(Addr {
            name: Some("Мария".into()),
            email: "maria@example.org".into(),
        });
        put(&store, "INBOX", 2, &other, true);
        put(&store, "Trash", 1, &with_ids("Счёт старый", 50, "c@x", None), true);

        let subjects = |q: &str| -> Vec<String> {
            store
                .search(q, None, 0, &[])
                .unwrap()
                .into_iter()
                .map(|m| m.subject)
                .collect()
        };
        assert_eq!(subjects("from:maria"), ["Отчёт"]);
        assert_eq!(subjects("от:петров"), ["Счёт на оплату"]);
        assert_eq!(subjects("есть:вложение"), ["Счёт на оплату"]);
        assert_eq!(subjects("is:unread"), ["Счёт на оплату"]);
        assert_eq!(subjects("тема:отчёт"), ["Отчёт"]);
        // The trash is searched only when asked for.
        assert_eq!(subjects("счёт"), ["Счёт на оплату"]);
        assert_eq!(subjects("счёт in:корзина"), ["Счёт старый"]);
        assert_eq!(subjects("after:1970-01-01 before:1970-01-02").len(), 2);
    }

    #[test]
    fn followup_is_resolved_by_an_answer() {
        let store = mailbox();
        put(&store, "Sent", 1, &with_ids("Вопрос", 100, "q@x", None), true);
        store
            .followup_add(&Followup {
                account_id: "a".into(),
                message_id: "q@x".into(),
                subject: "Вопрос".into(),
                recipients: "ivan@example.org".into(),
                sent: 100,
                due: 500,
            })
            .unwrap();
        let waiting = ListQuery {
            followups_only: true,
            ..Default::default()
        };
        assert_eq!(store.list(&waiting).unwrap()[0].followup_due, Some(500));
        assert!(store.followups_due(400).unwrap().is_empty());
        assert_eq!(store.followups_due(600).unwrap().len(), 1);
        assert!(store.followups_due(700).unwrap().is_empty(), "announced once");

        // My own follow-up in Sent is not an answer.
        put(
            &store,
            "Sent",
            2,
            &with_ids("Re: Вопрос", 150, "q2@x", Some("q@x")),
            true,
        );
        assert_eq!(store.followups_resolve().unwrap(), 0);
        put(
            &store,
            "INBOX",
            1,
            &with_ids("Re: Вопрос", 200, "r@x", Some("q@x")),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert!(store.list(&waiting).unwrap().is_empty());
    }

    #[test]
    fn snoozed_mail_is_listed_with_its_time() {
        let store = mailbox();
        put(&store, "INBOX", 1, &with_ids("Позже", 100, "s@x", None), true);
        store
            .snooze_add(&Snooze {
                account_id: "a".into(),
                message_id: "s@x".into(),
                folder: "INBOX".into(),
                return_to: "INBOX".into(),
                until: 1000,
                subject: "Позже".into(),
            })
            .unwrap();
        let rows = store
            .list(&ListQuery {
                snoozed_only: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(rows[0].snoozed_until, Some(1000));
        assert!(store.snoozes_due(999).unwrap().is_empty());
        assert_eq!(store.snoozes_due(1000).unwrap().len(), 1);
        assert!(store.snooze_remove("a", "s@x").unwrap().is_some());
        assert_eq!(store.snoozed_count(false).unwrap(), 0);
    }

    #[test]
    fn a_snoozed_conversation_is_one_row_and_counts_once() {
        let store = mailbox();
        put(&store, "Snoozed", 1, &with_ids("Вопрос", 100, "q@x", None), true);
        put(
            &store,
            "Snoozed",
            2,
            &with_ids("Re: Вопрос", 200, "r@x", Some("q@x")),
            true,
        );
        for id in ["q@x", "r@x"] {
            store
                .snooze_add(&Snooze {
                    account_id: "a".into(),
                    message_id: id.into(),
                    folder: "Snoozed".into(),
                    return_to: "INBOX".into(),
                    until: 1000,
                    subject: "Вопрос".into(),
                })
                .unwrap();
        }
        let list = |threads| {
            store
                .list(&ListQuery {
                    snoozed_only: true,
                    threads,
                    ..Default::default()
                })
                .unwrap()
        };
        assert_eq!(list(false).len(), 2);
        let grouped = list(true);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].subject, "Re: Вопрос");
        assert_eq!(grouped[0].snoozed_until, Some(1000));
        assert_eq!(store.snoozed_count(true).unwrap(), 1);
        assert_eq!(store.snoozed_count(false).unwrap(), 2);
    }

    /// A letter from `name` with its own size and flags, for the sorting tests.
    fn letter(store: &Store, uid: u32, name: &str, subject: &str, date: i64, size: u32, flags: Flags) -> i64 {
        let s = Summary {
            subject: subject.into(),
            from: Some(Addr {
                name: Some(name.into()),
                email: format!("{uid}@example.org"),
            }),
            date: Some(date),
            message_id: Some(format!("m{uid}@x")),
            ..Default::default()
        };
        let msg = NewMessage {
            uid,
            summary: &s,
            fallback_date: 0,
            size,
            flags,
        };
        store.insert_message("a", "INBOX", &msg).unwrap()
    }

    fn sorted(store: &Store, sort: &[(SortField, bool)], pins: Vec<Pin>, threads: bool) -> Vec<String> {
        store
            .list(&ListQuery {
                sort: sort.iter().map(|&(by, desc)| SortKey { by, desc }).collect(),
                pins,
                threads,
                ..Default::default()
            })
            .unwrap()
            .into_iter()
            .map(|m| m.subject)
            .collect()
    }

    #[test]
    fn lists_sort_by_several_keys() {
        let store = mailbox();
        let read = Flags {
            seen: true,
            ..Default::default()
        };
        let unread = Flags::default();
        let flagged = Flags {
            seen: true,
            flagged: true,
            ..Default::default()
        };
        letter(&store, 1, "Ёлкин", "Re: Бюджет", 100, 500, read);
        letter(&store, 2, "анна", "Отчёт", 200, 9_000, unread);
        let elena = letter(&store, 3, "Елена", "Fwd: Акт", 300, 50, flagged);
        letter(&store, 4, "Анна", "Аренда", 400, 700, read);
        letter(&store, 5, "\"Борис\"", "Встреча", 500, 10, unread);

        use SortField::*;
        for threads in [false, true] {
            // Newest first, as before, when no order is set.
            assert_eq!(
                sorted(&store, &[], vec![], threads),
                ["Встреча", "Аренда", "Fwd: Акт", "Отчёт", "Re: Бюджет"]
            );
            // Case and "ё" do not split names; the newer letter first among equal ones.
            assert_eq!(
                sorted(&store, &[(Sender, false)], vec![], threads),
                ["Аренда", "Отчёт", "Встреча", "Fwd: Акт", "Re: Бюджет"]
            );
            // "Re:" and "Fwd:" do not count.
            assert_eq!(
                sorted(&store, &[(Subject, false)], vec![], threads),
                ["Fwd: Акт", "Аренда", "Re: Бюджет", "Встреча", "Отчёт"]
            );
            assert_eq!(
                sorted(&store, &[(Size, true)], vec![], threads),
                ["Отчёт", "Аренда", "Re: Бюджет", "Fwd: Акт", "Встреча"]
            );
            // Important on top: unread, then flagged, then the newest.
            assert_eq!(
                sorted(
                    &store,
                    &[(Unread, true), (Flagged, true), (Date, true)],
                    vec![],
                    threads
                ),
                ["Встреча", "Отчёт", "Fwd: Акт", "Аренда", "Re: Бюджет"]
            );
            // Two keys: unread first, A to Я inside.
            assert_eq!(
                sorted(&store, &[(Unread, true), (Sender, false)], vec![], threads),
                ["Отчёт", "Встреча", "Аренда", "Fwd: Акт", "Re: Бюджет"]
            );
        }

        // Unflagged while the list is open: it stays where it was until the list changes.
        store.update_flags("a", "INBOX", &[(3, read)]).unwrap();
        let pin = Pin {
            id: elena,
            unread: false,
            flagged: true,
        };
        for threads in [false, true] {
            let order = &[(Unread, true), (Flagged, true), (Date, true)];
            assert_eq!(sorted(&store, order, vec![pin], threads)[2], "Fwd: Акт");
            assert_eq!(sorted(&store, order, vec![], threads)[3], "Fwd: Акт");
        }
    }

    #[test]
    fn sorted_pages_follow_each_other() {
        let store = mailbox();
        // Many equal keys: the order has to stay the same from page to page.
        for uid in 1..=25 {
            letter(
                &store,
                uid,
                if uid % 2 == 0 { "Анна" } else { "Борис" },
                "Тема",
                100 + i64::from(uid % 3),
                10,
                Flags::default(),
            );
        }
        let sort = vec![SortKey {
            by: SortField::Sender,
            desc: false,
        }];
        let all = store
            .list(&ListQuery {
                sort: sort.clone(),
                limit: 100,
                ..Default::default()
            })
            .unwrap();
        let mut paged = Vec::new();
        for offset in (0..25).step_by(7) {
            paged.extend(
                store
                    .list(&ListQuery {
                        sort: sort.clone(),
                        limit: 7,
                        offset,
                        ..Default::default()
                    })
                    .unwrap(),
            );
        }
        assert_eq!(
            paged.iter().map(|m| m.id).collect::<Vec<_>>(),
            all.iter().map(|m| m.id).collect::<Vec<_>>()
        );
        assert_eq!(all.len(), 25);
    }

    #[test]
    fn search_sorts_too() {
        let store = mailbox();
        let read = Flags {
            seen: true,
            ..Default::default()
        };
        letter(&store, 1, "Борис", "Счёт за май", 100, 10, read);
        letter(&store, 2, "Анна", "Счёт за июнь", 200, 10, read);
        let by = |sort: &[SortKey]| -> Vec<String> {
            store
                .search("счёт", None, 0, sort)
                .unwrap()
                .into_iter()
                .map(|m| m.subject)
                .collect()
        };
        assert_eq!(by(&[]), ["Счёт за июнь", "Счёт за май"]);
        let sender = SortKey {
            by: SortField::Sender,
            desc: true,
        };
        assert_eq!(by(&[sender]), ["Счёт за май", "Счёт за июнь"]);
        let relevance = SortKey {
            by: SortField::Relevance,
            desc: true,
        };
        assert_eq!(by(&[relevance]).len(), 2);
        // Without words there is no rank to sort by: newest first.
        let dated = store.search("после:1970-01-01", None, 0, &[relevance]).unwrap();
        assert_eq!(dated.iter().map(|m| m.date).collect::<Vec<_>>(), [200, 100]);
    }

    #[test]
    fn old_caches_get_sort_keys() {
        let store = mailbox();
        let id = letter(&store, 1, "Ёлкин", "RE: Отчёт", 100, 10, Flags::default());
        let conn = store.conn();
        conn.execute("UPDATE messages SET sort_sender = '', sort_subject = ''", [])
            .unwrap();
        fill_sort_keys(&conn).unwrap();
        let keys: (String, String) = conn
            .query_row(
                "SELECT sort_sender, sort_subject FROM messages WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(keys, ("елкин".into(), "отчет".into()));
    }
}
