use std::collections::{HashMap, HashSet};
use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::imap::{FlagChange, Flags, Folder, FolderRole};
use crate::message::{Addr, Summary, Unsubscribe};
use crate::query::SearchQuery;
use crate::smtp::Draft;

mod followups;
pub use followups::{
    DEFAULT_KEEP_DAYS, Followup, FollowupCounts, FollowupFilter, FollowupInfo, FollowupPlan, FollowupStatus,
};
mod labels;
mod marks;
pub use marks::{Done, Mark, Outgoing, marks_of};
mod people;
pub use people::{HintCount, HintState, Person};
mod server;
pub use server::{EnableAnswer, FolderSizes, QuotaSeen, ServerCaps, ServerInfo};
mod waiting;
pub use waiting::{ParkJob, ParkKind, Parking, WaitFolder, parks, waiting_folder};

/// Settings of the connection, made at every open: not part of the cache itself.
/// `synchronous = NORMAL`: in WAL mode a power cut may lose the last commits, never
/// corrupt the file, and commits are lost from the end only: folder states are written
/// after their mail, so they never run ahead of it, and the next sync fetches it again.
const PRAGMAS: &str = "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;";

/// A change of the cache: run once, in one transaction with the new `user_version`.
type Step = fn(&Connection) -> Result<()>;

/// The cache's history, `PRAGMA user_version` counting the steps done. A released step
/// is never edited: a new change of tables or data is a new step at the end.
const MIGRATIONS: &[Step] = &[
    v1_tables_and_threads,
    v2_sort_keys,
    v3_unversioned_columns,
    v4_modseq,
    v5_lookups,
    followups::v6_followups_history,
    v7_size_index,
    server::v8_server_caps,
    followups::v9_followup_times,
    marks::v10_reply_marks,
    waiting::v11_waiting_folder,
    labels::v12_labels_and_rights,
    people::v13_people_and_hints,
    people::v14_hint_counts,
    labels::v15_folder_props_label_check,
    v16_folder_counters,
];

/// Tables as step 1 creates them; later columns are added by their steps. Caches of the
/// versions before numbered steps have these tables, maybe without the columns below.
const TABLES: &str = r#"
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

/// Columns added at every start before the steps were numbered, in the order they came:
/// a cache of those versions may lack any of them.
const UNVERSIONED_COLUMNS: [(&str, &str, &str); 6] = [
    ("folders", "oldest_uid", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "thread", "TEXT NOT NULL DEFAULT ''"),
    ("messages", "bulk", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "unsubscribe", "TEXT"),
    ("outbox", "followup_secs", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "topic", "TEXT NOT NULL DEFAULT ''"),
];

const SORT_COLUMNS: [(&str, &str, &str); 2] = [
    ("messages", "sort_sender", "TEXT NOT NULL DEFAULT ''"),
    ("messages", "sort_subject", "TEXT NOT NULL DEFAULT ''"),
];

/// Rows of caches from before conversations: each is its own until resynced.
const THREADS: &str = "
UPDATE messages SET thread = COALESCE(message_id, folder || '/' || uid) WHERE thread = '';
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (account_id, thread);
CREATE INDEX IF NOT EXISTS messages_by_message_id ON messages (account_id, message_id);
CREATE INDEX IF NOT EXISTS messages_by_parent ON messages (account_id, in_reply_to);
CREATE INDEX IF NOT EXISTS messages_by_topic ON messages (account_id, topic, date);";

/// Adds a column unless the table has it. Returns whether it was added.
fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<bool> {
    let exists = conn
        .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))?
        .exists([column])?;
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(!exists)
}

/// 1: the tables with the columns of the versions before numbered steps, and threads
/// linked again: they were keyed by the headers of each message alone and split apart
/// when a client dropped References.
fn v1_tables_and_threads(conn: &Connection) -> Result<()> {
    conn.execute_batch(TABLES)?;
    for (table, column, decl) in UNVERSIONED_COLUMNS {
        add_column(conn, table, column, decl)?;
    }
    conn.execute_batch(THREADS)?;
    rethread(conn)
}

/// 2: sort keys of sender and subject, filled for the mail cached before them.
fn v2_sort_keys(conn: &Connection) -> Result<()> {
    for (table, column, decl) in SORT_COLUMNS {
        add_column(conn, table, column, decl)?;
    }
    fill_sort_keys(conn)
}

/// 3: versions 1 and 2 were set by builds that also added columns at every start,
/// outside the count: a cache of number 1 or 2 is not sure to have them all.
fn v3_unversioned_columns(conn: &Connection) -> Result<()> {
    for (table, column, decl) in UNVERSIONED_COLUMNS {
        add_column(conn, table, column, decl)?;
    }
    let mut sort_added = false;
    for (table, column, decl) in SORT_COLUMNS {
        sort_added |= add_column(conn, table, column, decl)?;
    }
    if sort_added {
        fill_sort_keys(conn)?;
    }
    conn.execute_batch(THREADS)?;
    Ok(())
}

/// 4: where incremental sync of a folder resumes (`ModSeqMark`); zero, a full pass, for all.
fn v4_modseq(conn: &Connection) -> Result<()> {
    for column in ["highest_modseq", "modseq_exists", "modseq_uidnext"] {
        add_column(conn, "folders", column, "INTEGER NOT NULL DEFAULT 0")?;
    }
    Ok(())
}

/// Addresses of a message for completion: the sender and the To recipients, each as
/// `(email, name)`, name '' when there is none. `{0}` is `new` or `old`.
const MESSAGE_ADDRESSES: &str = "
    SELECT email, name FROM (
        SELECT json_extract({0}.from_addr, '$.email') AS email,
            COALESCE(json_extract({0}.from_addr, '$.name'), '') AS name
        WHERE json_valid({0}.from_addr)
        UNION ALL
        SELECT json_extract(j.value, '$.email'), COALESCE(json_extract(j.value, '$.name'), '')
        FROM json_each(CASE WHEN json_valid({0}.to_addrs) THEN {0}.to_addrs ELSE '[]' END) j
    ) WHERE email IS NOT NULL";

/// Message-IDs a message refers to in References. `{0}` is `new` or `old`.
const MESSAGE_REFS: &str = "
    SELECT j.value FROM json_each(CASE WHEN json_valid({0}.refs) THEN {0}.refs ELSE '[]' END) j
    WHERE j.type = 'text' AND j.value != ''";

/// 5: what the frequent questions look up kept beside the messages, so they are not
/// answered by reading every message: addresses for completion, References for the
/// answers awaited, the window of offline reading.
fn v5_lookups(conn: &Connection) -> Result<()> {
    conn.execute_batch(&format!(
        "-- Senders and To recipients of cached mail, each spelling with the count of
         -- messages that carry it: completion reads these, not every message.
         CREATE TABLE addresses (
             email TEXT NOT NULL,
             name  TEXT NOT NULL,
             uses  INTEGER NOT NULL,
             PRIMARY KEY (email, name)
         ) WITHOUT ROWID;
         INSERT INTO addresses (email, name, uses)
             SELECT email, name, COUNT(*) FROM (
                 SELECT json_extract(from_addr, '$.email') AS email,
                     COALESCE(json_extract(from_addr, '$.name'), '') AS name
                 FROM messages WHERE json_valid(from_addr)
                 UNION ALL
                 SELECT json_extract(j.value, '$.email'), COALESCE(json_extract(j.value, '$.name'), '')
                 FROM messages m, json_each(CASE WHEN json_valid(m.to_addrs) THEN m.to_addrs ELSE '[]' END) j
             ) WHERE email IS NOT NULL GROUP BY email, name;

         -- The Message-IDs in References of each message: what it answers.
         CREATE TABLE message_refs (
             parent  TEXT NOT NULL,
             message INTEGER NOT NULL,
             PRIMARY KEY (parent, message)
         ) WITHOUT ROWID;
         INSERT OR IGNORE INTO message_refs (parent, message)
             SELECT j.value, m.id FROM messages m, json_each(CASE WHEN json_valid(m.refs) THEN m.refs ELSE '[]' END) j
             WHERE j.type = 'text' AND j.value != '';

         CREATE TRIGGER messages_lookups_insert AFTER INSERT ON messages BEGIN
             -- An upsert's SELECT needs a WHERE to be read as one.
             INSERT INTO addresses (email, name, uses) SELECT email, name, 1 FROM ({new_addresses}) WHERE 1
                 ON CONFLICT (email, name) DO UPDATE SET uses = uses + 1;
             INSERT OR IGNORE INTO message_refs (parent, message) SELECT value, new.id FROM ({new_refs});
         END;
         CREATE TRIGGER messages_lookups_delete AFTER DELETE ON messages BEGIN
             UPDATE addresses SET uses = uses - (
                 SELECT COUNT(*) FROM ({old_addresses}) o WHERE o.email = addresses.email AND o.name = addresses.name)
             WHERE (email, name) IN ({old_addresses});
             DELETE FROM addresses WHERE uses <= 0 AND (email, name) IN ({old_addresses});
             DELETE FROM message_refs WHERE message = old.id AND parent IN ({old_refs});
         END;

         -- The newest letters of each conversation, from every folder: what places it in
         -- a list. incoming: outside Sent, Drafts, Trash and Junk; latest: outside the last three.
         CREATE TABLE threads (
             account_id TEXT NOT NULL,
             thread     TEXT NOT NULL,
             incoming   INTEGER,
             latest     INTEGER,
             PRIMARY KEY (account_id, thread)
         ) WITHOUT ROWID;
         {count_all}

         -- A letter can only make its conversation newer.
         CREATE TRIGGER messages_threads_insert AFTER INSERT ON messages BEGIN
             INSERT INTO threads (account_id, thread, incoming, latest)
                 SELECT new.account_id, new.thread,
                     CASE WHEN COALESCE(f.role, '') NOT IN ('trash', 'junk', 'drafts', 'sent') THEN new.date END,
                     CASE WHEN COALESCE(f.role, '') NOT IN ('trash', 'junk', 'drafts') THEN new.date END
                 FROM folders f WHERE f.account_id = new.account_id AND f.name = new.folder
                 ON CONFLICT (account_id, thread) DO UPDATE SET
                     incoming = CASE WHEN incoming IS NULL OR excluded.incoming > incoming
                         THEN excluded.incoming ELSE incoming END,
                     latest = CASE WHEN latest IS NULL OR excluded.latest > latest
                         THEN excluded.latest ELSE latest END;
         END;
         -- Counted again only when the letter gone was the newest or the last.
         CREATE TRIGGER messages_threads_delete AFTER DELETE ON messages
         WHEN EXISTS (SELECT 1 FROM threads WHERE account_id = old.account_id AND thread = old.thread
                         AND (incoming = old.date OR latest = old.date))
             OR NOT EXISTS (SELECT 1 FROM messages WHERE account_id = old.account_id AND thread = old.thread)
         BEGIN
             {count_old}
         END;
         -- Conversations merged when a letter linking them comes.
         CREATE TRIGGER messages_threads_update AFTER UPDATE OF thread, folder, date ON messages
         WHEN old.thread IS NOT new.thread OR old.folder IS NOT new.folder OR old.date IS NOT new.date
         BEGIN
             {count_old}
             {count_new}
         END;
         CREATE TRIGGER folders_threads_role AFTER UPDATE OF role ON folders
         WHEN old.role IS NOT new.role
         BEGIN
             {count_folder}
         END;

         -- A conversation list groups a folder by conversation from the index alone.
         CREATE INDEX messages_by_folder_thread
             ON messages (account_id, folder, thread, date, seen, flagged, size, has_attachments, bulk);

         -- Offline reading: an account's mail by date, with what picks it.
         CREATE INDEX messages_by_account_date ON messages (account_id, date, folder, has_attachments, size);",
        new_addresses = MESSAGE_ADDRESSES.replace("{0}", "new"),
        new_refs = MESSAGE_REFS.replace("{0}", "new"),
        old_addresses = MESSAGE_ADDRESSES.replace("{0}", "old"),
        old_refs = MESSAGE_REFS.replace("{0}", "old"),
        count_all = count_threads("1"),
        count_old = count_threads("{0}account_id = old.account_id AND {0}thread = old.thread"),
        count_new = count_threads("{0}account_id = new.account_id AND {0}thread = new.thread"),
        count_folder = count_threads(
            "{0}account_id = new.account_id
             AND {0}thread IN (SELECT thread FROM messages WHERE account_id = new.account_id AND folder = new.name)"
        ),
    ))?;
    Ok(())
}

/// 7: large mail is found by size: the biggest first, or everything above a threshold,
/// counted and summed from the index alone. Sizes were cached from the start (RFC822.SIZE,
/// EWS Size), so nothing is fetched again.
fn v7_size_index(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS messages_by_size ON messages (size, date, account_id, folder, has_attachments, seen, flagged);",
    )?;
    Ok(())
}

/// Counts again the rows of `threads` that match `which`, `{0}` standing for the table.
fn count_threads(which: &str) -> String {
    let rows = which.replace("{0}", "");
    let which = which.replace("{0}", "x.");
    format!(
        "DELETE FROM threads WHERE {rows};
         INSERT INTO threads (account_id, thread, incoming, latest)
             SELECT x.account_id, x.thread,
                 MAX(CASE WHEN COALESCE(f.role, '') NOT IN ('trash', 'junk', 'drafts', 'sent') THEN x.date END),
                 MAX(CASE WHEN COALESCE(f.role, '') NOT IN ('trash', 'junk', 'drafts') THEN x.date END)
             FROM messages x JOIN folders f ON f.account_id = x.account_id AND f.name = x.folder
             WHERE {which} GROUP BY x.account_id, x.thread;"
    )
}

/// 16: the counts a folder shows (`total`, `unread`) are kept beside it and updated by
/// triggers, not counted over every message at each ask. `folders` is asked on every
/// change and by the tray, and the scan held the cache while it ran; on a large mailbox
/// that stalled the other mailboxes. The counters are recomputed once here.
fn v16_folder_counters(conn: &Connection) -> Result<()> {
    add_column(conn, "folders", "total", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "folders", "unread", "INTEGER NOT NULL DEFAULT 0")?;
    conn.execute_batch(
        "UPDATE folders SET
             total = (SELECT COUNT(*) FROM messages m
                      WHERE m.account_id = folders.account_id AND m.folder = folders.name),
             unread = (SELECT COALESCE(SUM(m.seen = 0), 0) FROM messages m
                       WHERE m.account_id = folders.account_id AND m.folder = folders.name);

         -- A message cached, gone, or read elsewhere moves the folder's counters with it.
         -- `insert_message` upserts, so a new row fires the insert trigger and a changed
         -- one the `seen` trigger; deletes (expunges, moves, a cleared folder) fire theirs.
         CREATE TRIGGER IF NOT EXISTS messages_count_insert AFTER INSERT ON messages BEGIN
             UPDATE folders SET total = total + 1, unread = unread + (new.seen = 0)
             WHERE account_id = new.account_id AND name = new.folder;
         END;
         CREATE TRIGGER IF NOT EXISTS messages_count_delete AFTER DELETE ON messages BEGIN
             UPDATE folders SET total = total - 1, unread = unread - (old.seen = 0)
             WHERE account_id = old.account_id AND name = old.folder;
         END;
         CREATE TRIGGER IF NOT EXISTS messages_count_seen AFTER UPDATE OF seen ON messages BEGIN
             UPDATE folders SET unread = unread + (new.seen = 0) - (old.seen = 0)
             WHERE account_id = new.account_id AND name = new.folder;
         END;",
    )?;
    Ok(())
}

fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Runs the steps the cache has not had yet. A cache from a newer version is refused
/// and left as it is: this version does not know what its steps changed.
fn migrate(conn: &mut Connection, steps: &[Step]) -> Result<()> {
    let version = user_version(conn)?;
    let known = steps.len() as i64;
    if version > known {
        return Err(crate::Error::CacheTooNew { found: version, known });
    }
    for (done, step) in steps.iter().enumerate().skip(version.max(0) as usize) {
        let tx = conn.transaction()?;
        step(&tx)?;
        tx.pragma_update(None, "user_version", done as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

/// A folder as the last complete sync found it when selected (CONDSTORE, RFC 7162).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModSeqMark {
    /// HIGHESTMODSEQ: flags changed after it are fetched again. 0: the next pass is full.
    pub modseq: u64,
    /// Messages the folder had (EXISTS), all of them with UIDs below `uid_next`
    /// (UIDNEXT): fewer of those later means some were expunged.
    pub exists: u32,
    pub uid_next: u32,
}

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
    /// The rest of that wait.
    pub followup: FollowupPlan,
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
    /// The message's own keywords (labels) on the server, by their keyword names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    pub has_attachments: bool,
    pub thread: String,
    pub bulk: bool,
    /// Letters of the conversation, my answers in Sent included; 1 when the list is not grouped.
    pub thread_count: u32,
    /// The newest letter of the conversation, mine included; the row's own date otherwise.
    #[serde(default)]
    pub thread_date: i64,
    /// Bytes of the conversation's letters in the list; the row's own size otherwise.
    #[serde(default)]
    pub thread_size: u64,
    /// Who wrote in the conversation, in order of first appearance; empty when not grouped.
    #[serde(default)]
    pub thread_senders: Vec<Addr>,
    /// An answer is being written: the conversation has a saved draft.
    #[serde(default)]
    pub thread_draft: bool,
    pub snoozed_until: Option<i64>,
    /// The sender waits for an answer to this message: the next reminder.
    pub followup_due: Option<i64>,
    /// The wait for an answer to this message, also when it is over.
    #[serde(default)]
    pub followup: Option<FollowupInfo>,
    /// What was done with the letter: answered, answered to all, forwarded.
    #[serde(default)]
    pub marks: Vec<Mark>,
    /// My latest answer to it, when it is in the cache.
    #[serde(default)]
    pub my_answer: Option<i64>,
    /// An answer or forward of it waiting in the outbox.
    #[serde(default)]
    pub outgoing: Option<Outgoing>,
    /// It came back from waiting with the reply, not opened since; for a conversation's
    /// row, any letter of it.
    #[serde(default)]
    pub answer_came: bool,
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
fn order_by(sort: &[SortKey], expr: impl Fn(SortField) -> Option<String>, date: &str, id: &str) -> String {
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
    parts.push(format!("{id} DESC"));
    parts.join(", ")
}

/// The WHERE of a list over `messages m JOIN folders f`, with its parameters.
fn list_filter(q: &ListQuery) -> (String, Vec<rusqlite::types::Value>) {
    let mut cond = String::from("1");
    let mut args: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(account) = &q.account_id {
        cond.push_str(" AND m.account_id = ?");
        args.push(account.clone().into());
    }
    if q.snoozed_only {
        cond.push_str(
            " AND EXISTS (SELECT 1 FROM snoozed s WHERE s.account_id = m.account_id AND s.message_id = m.message_id)",
        );
    } else if q.followups_only {
        cond.push_str(&followups::list_condition(q.followup_status));
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
    (cond, args)
}

/// What a search found in the cache: letters and their bytes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchTotals {
    pub count: u64,
    pub size: u64,
}

/// A search as SQL over `messages m` and its folder `f`: the FROM, the WHERE and its
/// parameters, numbered. `None` when the query asks for nothing.
struct SearchSql {
    from: &'static str,
    cond: String,
    args: Vec<rusqlite::types::Value>,
    /// There are words to match: the FROM has the full-text table and its MATCH.
    words: bool,
}

fn search_sql(q: &SearchQuery, account_id: Option<&str>) -> Option<SearchSql> {
    // `account:` is resolved to an id by the caller; without one it would be no filter.
    if q.account.is_some() && account_id.is_none() {
        return None;
    }
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
    // A mailbox named in the query is a filter; one the caller picked is only the scope.
    let mut filtered = q.account.is_some();
    let mut push = |cond: &mut String, sql: &str| {
        cond.push_str(sql);
        filtered = true;
    };
    if q.has_attachment {
        push(&mut cond, " AND m.has_attachments = 1");
    }
    if q.unread {
        push(&mut cond, " AND m.seen = 0");
    }
    if q.flagged {
        push(&mut cond, " AND m.flagged = 1");
    }
    if let Some(t) = q.after {
        args.push(t.into());
        push(&mut cond, &format!(" AND m.date >= ?{}", args.len()));
    }
    if let Some(t) = q.before {
        args.push(t.into());
        push(&mut cond, &format!(" AND m.date < ?{}", args.len()));
    }
    if let Some(n) = q.larger {
        args.push(i64::try_from(n).unwrap_or(i64::MAX).into());
        push(&mut cond, &format!(" AND m.size > ?{}", args.len()));
    }
    if let Some(n) = q.smaller {
        args.push(i64::try_from(n).unwrap_or(i64::MAX).into());
        push(&mut cond, &format!(" AND m.size < ?{}", args.len()));
    }
    match &q.folder {
        // The folder named, by its name or role, and with `/*` the folders inside it.
        Some(folder) if q.subfolders => {
            args.push(folder.clone().into());
            let n = args.len();
            let role = role_word(folder).map(FolderRole::as_str).unwrap_or("");
            args.push(role.to_owned().into());
            push(
                &mut cond,
                &format!(
                    " AND EXISTS (SELECT 1 FROM folders p WHERE p.account_id = m.account_id
                        AND (p.name = ?{n} COLLATE NOCASE OR p.display_name = ?{n} COLLATE NOCASE OR p.role = ?{})
                        AND (p.name = m.folder OR (COALESCE(p.delimiter, '') != ''
                            AND substr(m.folder, 1, length(p.name) + length(p.delimiter)) = p.name || p.delimiter)))",
                    n + 1
                ),
            );
        }
        Some(folder) => {
            args.push(folder.clone().into());
            let n = args.len();
            let role = role_word(folder).map(FolderRole::as_str).unwrap_or("");
            args.push(role.to_owned().into());
            push(
                &mut cond,
                &format!(
                    " AND (f.name = ?{n} COLLATE NOCASE OR f.display_name = ?{n} COLLATE NOCASE OR f.role = ?{})",
                    n + 1
                ),
            );
        }
        None => cond.push_str(" AND COALESCE(f.role, '') NOT IN ('trash', 'junk')"),
    }
    if terms.is_empty() && !filtered {
        return None;
    }
    if terms.is_empty() {
        return Some(SearchSql {
            from: "messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder",
            cond,
            args,
            words: false,
        });
    }
    args.push(terms.join(" ").into());
    Some(SearchSql {
        from: "search s JOIN messages m ON m.id = s.rowid JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder",
        cond: format!("search MATCH ?{} AND {cond}", args.len()),
        args,
        words: true,
    })
}

/// A letter of a conversation for its row in a list: id, Message-ID, sender, a draft, back
/// from waiting with the reply and not opened since.
type Letter = (i64, Option<String>, Option<String>, bool, bool);

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
    /// Sent mail with a wait for an answer: those still waiting, or `followup_status`.
    pub followups_only: bool,
    pub followup_status: FollowupFilter,
    /// The order, first key first; newest first when empty.
    pub sort: Vec<SortKey>,
    /// Rows changed in the open list: they sort by their earlier state.
    pub pins: Vec<Pin>,
    pub limit: u32,
    pub offset: u32,
}

/// A message header fetched from the server, ready for the cache.
#[derive(Debug, Clone)]
pub struct NewMessage<'a> {
    pub uid: u32,
    pub summary: &'a Summary,
    /// INTERNALDATE, used when the Date header is missing or broken.
    pub fallback_date: i64,
    pub size: u32,
    pub flags: Flags,
    /// The message's own IMAP keywords (labels) as the fetch reported them.
    pub keywords: Vec<String>,
}

pub struct Store {
    conn: Mutex<Connection>,
    /// A second connection the heavy reads use (list, search, folders). In WAL mode it
    /// reads the cache while a sync writes it, so a long read never holds the writer's
    /// lock and the other mailboxes keep answering. None for an in-memory cache, which
    /// has no file to open again: its reads share the writer's connection.
    read: Option<Mutex<Connection>>,
    /// Flags changed here and not yet stored on the server: a sync in between
    /// must not bring the old value back.
    pending: Mutex<HashMap<(String, String, u32), PendingFlags>>,
    /// The longest the connection was held at once, nanoseconds: every other call waits
    /// that long. See `take_longest_lock`.
    longest_lock: AtomicU64,
}

/// The connection, held: the time it is held counts in `Store::longest_lock`.
struct ConnGuard<'a> {
    conn: MutexGuard<'a, Connection>,
    since: Instant,
    longest: &'a AtomicU64,
}

impl Deref for ConnGuard<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        &self.conn
    }
}

impl DerefMut for ConnGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}

impl Drop for ConnGuard<'_> {
    fn drop(&mut self) {
        let held = u64::try_from(self.since.elapsed().as_nanos()).unwrap_or(u64::MAX);
        self.longest.fetch_max(held, Ordering::Relaxed);
    }
}

/// SQLite's lower() and LIKE fold only ASCII: "иван" would not find "Иван". Every
/// connection that runs a search needs it, the read one included.
fn register_fold(conn: &Connection) -> Result<()> {
    conn.create_scalar_function(
        "fold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| Ok(ctx.get::<Option<String>>(0)?.map(|s| s.to_lowercase())),
    )?;
    Ok(())
}

/// The read connection: the same settings and the `fold` function, and nothing that writes.
fn prepare_read(conn: &Connection) -> Result<()> {
    conn.execute_batch(PRAGMAS)?;
    register_fold(conn)
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
            FlagChange::Answered(v) | FlagChange::AnsweredAll(v) => self.answered = Some(v),
            // Depesha's own mark of a forward is kept apart (`marks`): the server's may go.
            FlagChange::Forwarded(_) => {}
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
        let path = path.as_ref();
        let mut store = Self::init(Connection::open(path)?)?;
        // A second connection for the heavy reads. Opened after the migrations, so it
        // reads the current shape. A failure is not fatal: reads then share the writer's.
        if let Ok(read) = Connection::open(path)
            && prepare_read(&read).is_ok()
        {
            store.read = Some(Mutex::new(read));
        }
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        // Before anything writes to the file: a newer cache is left untouched.
        let version = user_version(&conn)?;
        if version > MIGRATIONS.len() as i64 {
            return Err(crate::Error::CacheTooNew {
                found: version,
                known: MIGRATIONS.len() as i64,
            });
        }
        conn.execute_batch(PRAGMAS)?;
        register_fold(&conn)?;
        migrate(&mut conn, MIGRATIONS)?;
        // The first pass over a folder after start is full: a mod-sequence the server or
        // this client got wrong is not carried from one run to the next.
        conn.execute("UPDATE folders SET highest_modseq = 0 WHERE highest_modseq != 0", [])?;
        Ok(Self {
            conn: Mutex::new(conn),
            read: None,
            pending: Mutex::new(HashMap::new()),
            longest_lock: AtomicU64::new(0),
        })
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<(String, String, u32), PendingFlags>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The connection the heavy reads use: a second one when the cache is a file (WAL
    /// lets it read while a sync writes), the writer's otherwise. Writes and the reads
    /// that must not race one stay on `conn()`.
    fn read(&self) -> MutexGuard<'_, Connection> {
        match &self.read {
            Some(read) => read.lock().unwrap_or_else(|e| e.into_inner()),
            None => self.conn.lock().unwrap_or_else(|e| e.into_inner()),
        }
    }

    fn conn(&self) -> ConnGuard<'_> {
        ConnGuard {
            // A panic while holding the lock leaves SQLite consistent: every write is a transaction.
            conn: self.conn.lock().unwrap_or_else(|e| e.into_inner()),
            since: Instant::now(),
            longest: &self.longest_lock,
        }
    }

    /// The longest one call held the cache since the previous ask, the opening aside:
    /// how long opening a letter could have waited.
    pub fn take_longest_lock(&self) -> Duration {
        Duration::from_nanos(self.longest_lock.swap(0, Ordering::Relaxed))
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
        // The counts are kept in `folders` (v16): asking is a scan of the folder rows
        // alone, never of every message. Read on the read connection, so a sync writing
        // the cache does not hold it up.
        let conn = self.read();
        let mut stmt = conn.prepare(
            "SELECT f.account_id, f.name, f.display_name, f.delimiter, f.role, f.selectable, f.hidden,
                    f.total, f.unread
             FROM folders f
             WHERE ?1 IS NULL OR f.account_id = ?1
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

    /// Where incremental sync of the folder resumes; `modseq == 0` when the next pass is full.
    pub fn modseq_mark(&self, account_id: &str, folder: &str) -> Result<ModSeqMark> {
        Ok(self
            .conn()
            .query_row(
                "SELECT highest_modseq, modseq_exists, modseq_uidnext FROM folders
                 WHERE account_id = ?1 AND name = ?2",
                params![account_id, folder],
                |r| {
                    Ok(ModSeqMark {
                        modseq: r.get::<_, i64>(0)? as u64,
                        exists: r.get(1)?,
                        uid_next: r.get(2)?,
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }

    /// Saved after a pass has done all it read: an interrupted one is repeated.
    pub fn set_modseq_mark(&self, account_id: &str, folder: &str, mark: ModSeqMark) -> Result<()> {
        // RFC 7162 keeps mod-sequences below 2^63; a larger one would read back negative.
        let modseq = i64::try_from(mark.modseq).unwrap_or(0);
        self.conn().execute(
            "UPDATE folders SET highest_modseq = ?3, modseq_exists = ?4, modseq_uidnext = ?5
             WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder, modseq, mark.exists, mark.uid_next],
        )?;
        Ok(())
    }

    /// Lowest and highest cached UID of the folder.
    pub fn uid_range(&self, account_id: &str, folder: &str) -> Result<Option<(u32, u32)>> {
        let (min, max): (Option<u32>, Option<u32>) = self.conn().query_row(
            "SELECT min(uid), max(uid) FROM messages WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(min.zip(max))
    }

    /// Forgets the messages of a folder, all or none of them. Flags the user set on them
    /// no longer hold: a new message may come under the same UID.
    pub fn clear_folder(&self, account_id: &str, folder: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        clear_folder(&tx, account_id, folder)?;
        tx.commit()?;
        drop(conn);
        self.forget_pending(account_id, Some(folder));
        Ok(())
    }

    fn forget_pending(&self, account_id: &str, folder: Option<&str>) {
        self.pending()
            .retain(|(a, f, _), _| a != account_id || folder.is_some_and(|folder| f != folder));
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
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let id = insert_message(&tx, account_id, folder, msg)?;
        tx.commit()?;
        Ok(id)
    }

    /// Headers of one fetch in one commit, all or none of them: a failure half way
    /// leaves no part of the batch, and the folder's state is written after it.
    pub fn insert_messages(&self, account_id: &str, folder: &str, msgs: &[NewMessage<'_>]) -> Result<Vec<i64>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ids = msgs
            .iter()
            .map(|m| insert_message(&tx, account_id, folder, m))
            .collect::<Result<_>>()?;
        tx.commit()?;
        Ok(ids)
    }

    /// Flags from the server. A change the user made here and the server has not
    /// stored yet keeps its value: the server's is the one from before it.
    pub fn update_flags(&self, account_id: &str, folder: &str, flags: &[(u32, Flags)]) -> Result<usize> {
        let flags = self.with_pending(account_id, folder, flags.iter().copied());
        let conn = self.conn();
        let flags = with_local_seen(&conn, account_id, folder, flags)?;
        write_flags(&conn, account_id, folder, &flags)
    }

    /// Flags with the changes still waiting for the server on top.
    fn with_pending(
        &self,
        account_id: &str,
        folder: &str,
        flags: impl Iterator<Item = (u32, Flags)>,
    ) -> Vec<(u32, Flags)> {
        let pending = self.pending();
        flags
            .map(|(uid, mut f)| {
                if let Some(p) = pending.get(&(account_id.to_owned(), folder.to_owned(), uid)) {
                    p.apply(&mut f);
                }
                (uid, f)
            })
            .collect()
    }

    /// A flag changed by the user: cached at once and held against syncs until
    /// `settle_flags` reports the server's answer.
    /// Nothing is held when the cache could not be written: the change never reaches
    /// the server, and syncs must not hide the server's flags.
    pub fn change_flags(&self, account_id: &str, folder: &str, uids: &[u32], change: FlagChange) -> Result<usize> {
        let written = self.hold_flags(account_id, folder, uids, change);
        if written.is_err() {
            self.settle_flags(account_id, folder, uids);
        }
        written
    }

    fn hold_flags(&self, account_id: &str, folder: &str, uids: &[u32], change: FlagChange) -> Result<usize> {
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
        // Read and written under one hold of the cache, the UIDs in one query.
        let conn = self.conn();
        let cached: Vec<(u32, Flags)> = conn
            .prepare_cached(
                "SELECT m.uid, m.seen, m.answered, m.flagged, m.draft, m.forwarded, m.answered_all FROM json_each(?3) j
                 CROSS JOIN messages m ON m.account_id = ?1 AND m.folder = ?2 AND m.uid = j.value",
            )?
            .query_map(params![account_id, folder, json_list(uids)], |r| {
                Ok((
                    r.get(0)?,
                    Flags {
                        seen: r.get(1)?,
                        answered: r.get(2)?,
                        flagged: r.get(3)?,
                        draft: r.get(4)?,
                        deleted: false,
                        forwarded: r.get(5)?,
                        answered_all: r.get(6)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let flags = self.with_pending(account_id, folder, cached.into_iter());
        write_flags(&conn, account_id, folder, &flags)
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
        let (cond, mut args) = list_filter(q);
        args.push(i64::from(if q.limit == 0 { 100 } else { q.limit }).into());
        args.push(i64::from(q.offset).into());

        let from = "messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder";
        let unread = pinned(&q.pins, |p| p.unread, "(m.seen = 0)");
        let flagged = pinned(&q.pins, |p| p.flagged, "m.flagged");
        // The list is the heaviest read: on the read connection, off the writer's lock.
        let conn = self.read();
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
                "m.id",
            );
            let sql = format!("SELECT {COLUMNS} FROM {from} WHERE {cond} ORDER BY {order} LIMIT ? OFFSET ?");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(args), message_row)?;
            return Ok(rows.collect::<Result<_, _>>()?);
        }
        // The newest message stands for its conversation: SQLite takes bare columns
        // from the row that holds the MAX, as long as it is the only MIN/MAX in the
        // query (hence SUM for flags). The row is unread or flagged when any message is.
        // A conversation stands where its last incoming letter puts it: my answer does not
        // move it up. In Sent my letters date it; where nothing counts as incoming (Trash,
        // Junk, Drafts), its newest letter does.
        // Sorting looks at the whole conversation: unread or flagged when any letter is,
        // its size is the sum; sender and subject are the newest letter's.
        // The newest letters of the conversation in every folder come from `threads`,
        // one lookup per conversation; the folder itself is grouped from its index.
        // Ordering needs every conversation of the folder: the newest letter elsewhere
        // can put any of them on top. Columns of the message itself are read only when
        // the order looks at them, and for the page alone.
        let by_message = q
            .sort
            .iter()
            .any(|k| matches!(k.by, SortField::Sender | SortField::Subject | SortField::People));
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
            "g.id",
        );
        let message = if by_message {
            "JOIN messages m ON m.id = g.id"
        } else {
            ""
        };
        // Folders first: each folder's messages come from the index that has every column
        // the grouping reads, not row by row from the table.
        let sql = format!(
            "WITH g AS (
                SELECT m.id AS id, m.account_id AS account_id, m.thread AS thread, f.role AS role,
                    MAX(m.date) AS date, SUM(m.seen = 0) AS unread, SUM(m.flagged) AS flagged,
                    SUM({unread}) AS s_unread, SUM({flagged}) AS s_flagged, SUM(m.size) AS s_size,
                    SUM(m.has_attachments) AS s_files
                FROM folders f CROSS JOIN messages m ON m.account_id = f.account_id AND m.folder = f.name
                WHERE {cond} GROUP BY m.account_id, m.thread
             )
             SELECT g.id, g.unread, g.flagged,
                CASE WHEN COALESCE(g.role, '') = 'sent' THEN g.date
                     ELSE COALESCE(t.incoming, t.latest, g.date) END AS last, g.s_size
             FROM g LEFT JOIN threads t ON t.account_id = g.account_id AND t.thread = g.thread
                {message}
             ORDER BY {order} LIMIT ? OFFSET ?"
        );
        let page: Vec<(i64, i64, i64, i64, u64)> = conn
            .prepare(&sql)?
            .query_map(params_from_iter(args), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, unsigned(r.get(4)?)))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let ids: Vec<i64> = page.iter().map(|p| p.0).collect();
        let mut rows: Vec<MessageRow> = conn
            .prepare_cached(&format!(
                "SELECT {COLUMNS} FROM json_each(?1) j CROSS JOIN messages m ON m.id = j.value ORDER BY j.key"
            ))?
            .query_map([json_list(&ids)], message_row)?
            .collect::<rusqlite::Result<_>>()?;
        for (row, &(_, unread, flagged, last, size)) in rows.iter_mut().zip(&page) {
            row.flags.seen = unread == 0;
            row.flags.flagged = flagged > 0;
            row.thread_date = last;
            row.thread_size = size;
        }

        // The letters of every conversation on the page, in one query.
        let keys: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| (r.account_id.as_str(), r.thread.as_str()))
            .collect();
        let mut letters: HashMap<(String, String), Vec<Letter>> = HashMap::new();
        let found = conn
            .prepare_cached(
                "SELECT m.account_id, m.thread, m.id, m.message_id, m.from_addr, COALESCE(f.role, '') = 'drafts',
                    EXISTS (SELECT 1 FROM followups fu WHERE fu.park = 'returned' AND fu.noticed = 0
                        AND fu.account_id = m.account_id AND (fu.anchor = m.message_id OR fu.answer_id = m.message_id))
                 FROM json_each(?1) k
                 CROSS JOIN messages m ON m.account_id = k.value ->> 0 AND m.thread = k.value ->> 1
                 JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
                 WHERE COALESCE(f.role, '') NOT IN ('trash', 'junk')
                 ORDER BY k.key, m.date, m.id",
            )?
            .query_map([json_list(&keys)], |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                    (
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, bool>(5)?,
                        r.get::<_, bool>(6)?,
                    ),
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (key, letter) in found {
            letters.entry(key).or_default().push(letter);
        }
        for row in &mut rows {
            let mut seen = HashSet::new();
            let (mut count, mut draft) = (0, false);
            let mut senders: Vec<Addr> = Vec::new();
            let found = letters
                .remove(&(row.account_id.clone(), row.thread.clone()))
                .unwrap_or_default();
            for (id, mid, from, is_draft, came) in found {
                // Back from waiting with the reply, not opened since: the conversation says so.
                row.answer_came |= came;
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

    /// The id of a cached letter with this Message-ID anywhere in the account. A waiting
    /// for a reply is countable and cancellable only while its letter is in the cache
    /// (`followups_count`), so after a copy into Sent this is the check that it landed.
    pub fn find_any_by_message_id(&self, account_id: &str, message_id: &str) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT id FROM messages WHERE account_id = ?1 AND message_id = ?2 LIMIT 1",
                params![account_id, message_id.trim_matches(['<', '>'])],
                |r| r.get(0),
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

    /// A message with the UIDVALIDITY of its folder, read at once: a sync renumbering the
    /// folder cannot come between them. For actions on the server by UID.
    pub fn get_at(&self, id: i64) -> Result<Option<(MessageRow, u32)>> {
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {COLUMNS}, f.uidvalidity FROM messages m
                     JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
                     WHERE m.id = ?1"
                ),
                [id],
                |r| Ok((message_row(r)?, r.get(COLUMN_COUNT)?)),
            )
            .optional()?)
    }

    /// `get_at` of many messages in one query, in the order of `ids`; unknown ids are skipped.
    pub fn get_many_at(&self, ids: &[i64]) -> Result<Vec<(MessageRow, u32)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {COLUMNS}, f.uidvalidity FROM json_each(?1) j
             CROSS JOIN messages m ON m.id = j.value
             JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
             ORDER BY j.key"
        ))?;
        let rows = stmt.query_map([json_list(ids)], |r| Ok((message_row(r)?, r.get(COLUMN_COUNT)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
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
    /// Spam, without attachments unless `attachments`. Read from the index of the
    /// account's mail by date alone; Trash and Spam are looked up once, not per message.
    fn offline_cond(attachments: bool) -> String {
        let files = if attachments {
            format!("m.size <= {OFFLINE_MAX_SIZE}")
        } else {
            format!("m.has_attachments = 0 AND m.size <= {OFFLINE_MAX_TEXT}")
        };
        format!(
            "m.account_id = ?1 AND m.date >= ?2 AND {files}
             AND m.folder NOT IN (SELECT name FROM folders WHERE account_id = ?1 AND role IN ('trash', 'junk'))"
        )
    }

    /// Offline messages whose text is not downloaded yet, newest first: `(id, folder, uid)`.
    /// Goes from the newest down and stops at `limit`.
    pub fn bodies_missing(
        &self,
        account_id: &str,
        since: i64,
        attachments: bool,
        limit: u32,
    ) -> Result<Vec<(i64, String, u32)>> {
        let sql = format!(
            "SELECT m.id, m.folder, m.uid FROM messages m
             WHERE {} AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)
             ORDER BY m.date DESC LIMIT ?3",
            Self::offline_cond(attachments)
        );
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(params![account_id, since, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Offline messages with their text downloaded, and all of them. The downloaded
    /// are counted from the texts, all of them from the index.
    pub fn offline_progress(&self, account_id: &str, since: i64, attachments: bool) -> Result<(u64, u64)> {
        let cond = Self::offline_cond(attachments);
        let sql = format!(
            "SELECT (SELECT COUNT(*) FROM bodies b CROSS JOIN messages m ON m.id = b.message_id WHERE {cond}),
                    (SELECT COUNT(*) FROM messages m WHERE {cond})"
        );
        let (done, total): (i64, i64) = self
            .conn()
            .prepare_cached(&sql)?
            .query_row(params![account_id, since], |r| Ok((r.get(0)?, r.get(1)?)))?;
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
        let Some(SearchSql {
            from,
            cond,
            mut args,
            words,
        }) = search_sql(&SearchQuery::parse(text), account_id)
        else {
            return Ok(Vec::new());
        };
        args.push(i64::from(if limit == 0 { 100 } else { limit }).into());
        let limit_arg = args.len();
        let order = order_by(
            sort,
            |by| match by {
                SortField::Relevance => words.then(|| "bm25(search)".into()),
                other => message_sort_column(other).map(Into::into),
            },
            "m.date",
            "m.id",
        );
        let sql = format!("SELECT {COLUMNS} FROM {from} WHERE {cond} ORDER BY {order} LIMIT ?{limit_arg}");
        let conn = self.read();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), message_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// How many letters the search finds in the cache and their size, beyond the
    /// rows `search` returns.
    pub fn search_totals(&self, text: &str, account_id: Option<&str>) -> Result<SearchTotals> {
        let Some(SearchSql { from, cond, args, .. }) = search_sql(&SearchQuery::parse(text), account_id) else {
            return Ok(SearchTotals::default());
        };
        let sql = format!("SELECT COUNT(*), COALESCE(SUM(m.size), 0) FROM {from} WHERE {cond}");
        Ok(self.read().query_row(&sql, params_from_iter(args), |r| {
            Ok(SearchTotals {
                count: unsigned(r.get(0)?),
                size: unsigned(r.get(1)?),
            })
        })?)
    }

    pub fn snooze_add(&self, s: &Snooze) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO snoozed (account_id, message_id, folder, return_to, until, subject)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![s.account_id, s.message_id, s.folder, s.return_to, s.until, s.subject],
        )?;
        Ok(())
    }

    /// Snoozes a series of letters in one commit: "Snooze" on a hundred letters wrote a
    /// hundred transactions. `rows` are `(message_id, subject)`; `folder` is where they are
    /// now, `snoozed` where they wait. A letter snoozed again keeps where it first came from,
    /// and a letter already waiting in `snoozed` goes back where it was.
    pub fn snooze_add_batch(
        &self,
        account_id: &str,
        snoozed: &str,
        folder: &str,
        until: i64,
        rows: &[(String, String)],
    ) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut previous = tx.prepare("SELECT return_to FROM snoozed WHERE account_id = ?1 AND message_id = ?2")?;
            let mut put = tx.prepare(
                "INSERT OR REPLACE INTO snoozed (account_id, message_id, folder, return_to, until, subject)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (message_id, subject) in rows {
                let was: Option<String> = previous
                    .query_row(params![account_id, message_id], |r| r.get(0))
                    .optional()?;
                let return_to = was.filter(|r| r != snoozed).unwrap_or_else(|| folder.to_owned());
                put.execute(params![account_id, message_id, snoozed, return_to, until, subject])?;
            }
        }
        tx.commit()?;
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

    /// Everything cached for an account, all or none of it; shared data (trusted senders,
    /// brand logos) stays.
    pub fn forget_account(&self, account_id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        // Messages, bodies and search go with their folders.
        tx.execute("DELETE FROM folders WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM outbox WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM snoozed WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM followups WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM marks WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM ews_folders WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM ews_items WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM labels WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM folder_props WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM namespaces WHERE account_id = ?1", [account_id])?;
        tx.execute("DELETE FROM local_seen WHERE account_id = ?1", [account_id])?;
        Self::forget_server(&tx, account_id)?;
        tx.execute(
            "DELETE FROM avatars WHERE substr(key, 1, length(?1) + 7) = 'photo:' || ?1 || ':'",
            [account_id],
        )?;
        tx.commit()?;
        drop(conn);
        self.forget_pending(account_id, None);
        Ok(())
    }

    /// Records the EWS id of every folder name. A folder whose id changed was deleted and
    /// created again: its cache no longer matches the server and is cleared with the new
    /// id at once, so an interruption cannot keep the old cache under the new id.
    /// Returns the names of the cleared folders.
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
                upsert.execute(params![account_id, name, id])?;
                if old.as_ref().is_some_and(|o| o != id) {
                    ews_clear_folder(&tx, account_id, name)?;
                    changed.push(name.clone());
                }
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
        drop(conn);
        for name in &changed {
            self.forget_pending(account_id, Some(name));
        }
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

    /// Forgets the cache of a folder, all or none of it: messages, item ids and the
    /// synced window. UIDs start again from the bottom and name other items, so the
    /// folder gets a new UIDVALIDITY, as IMAP would give it: actions on the old UIDs
    /// still waiting in the queue are refused.
    pub fn ews_clear_folder(&self, account_id: &str, name: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        ews_clear_folder(&tx, account_id, name)?;
        tx.commit()?;
        drop(conn);
        self.forget_pending(account_id, Some(name));
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

    /// Exchange items with their ids `(message, item id, received)`, in one commit as
    /// `insert_messages`: a message is never cached without the id that reaches it.
    pub fn ews_insert_items(
        &self,
        account_id: &str,
        folder: &str,
        items: &[(NewMessage<'_>, &str, i64)],
    ) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for (msg, item_id, received) in items {
            insert_message(&tx, account_id, folder, msg)?;
            tx.prepare_cached(
                "INSERT OR REPLACE INTO ews_items (account_id, folder, uid, item_id, received) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?
            .execute(params![account_id, folder, msg.uid, item_id, received])?;
        }
        tx.commit()?;
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
        let mut stmt = conn.prepare_cached(
            "SELECT e.item_id FROM json_each(?3) j
             CROSS JOIN ews_items e ON e.account_id = ?1 AND e.folder = ?2 AND e.uid = j.value
             ORDER BY j.key",
        )?;
        let rows = stmt.query_map(params![account_id, folder, json_list(uids)], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
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
    /// `followup_secs`: wait for an answer and remind that long after sending, as `followup` asks.
    pub fn outbox_add(
        &self,
        account_id: &str,
        draft: &Draft,
        now: i64,
        at: i64,
        followup_secs: i64,
        followup: &FollowupPlan,
    ) -> Result<i64> {
        let json = serde_json::to_string(draft).map_err(|e| crate::Error::Compose(e.to_string()))?;
        let acts = draft.acts_on.as_ref().filter(|a| a.account_id == account_id);
        Ok(self.conn().query_row(
            "INSERT INTO outbox (account_id, draft, next_attempt, created, followup_secs,
                followup_deadline_secs, followup_repeat_secs, followup_expect, followup_kind,
                followup_due_at, followup_deadline_at, acts_on, acts_kind, followup_park)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) RETURNING id",
            params![
                account_id,
                json,
                at.max(now),
                now,
                followup_secs,
                followup.deadline_secs,
                followup.repeat_secs,
                followup.expect,
                followup.kind,
                followup.due_at,
                followup.deadline_at,
                acts.map(|a| a.message_id.trim_matches(['<', '>'])),
                acts.map(|a| a.act.as_str()),
                followup.park
            ],
            |r| r.get(0),
        )?)
    }

    pub fn outbox(&self) -> Result<Vec<OutboxItem>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, account_id, draft, attempts, next_attempt, last_error, failed, created, followup_secs,
                followup_deadline_secs, followup_repeat_secs, followup_expect, followup_kind,
                followup_due_at, followup_deadline_at, followup_park
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
                followup: FollowupPlan {
                    deadline_secs: r.get(9)?,
                    repeat_secs: r.get(10)?,
                    expect: r.get(11)?,
                    kind: r.get(12)?,
                    due_at: r.get(13)?,
                    deadline_at: r.get(14)?,
                    park: r.get(15)?,
                },
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
    /// Reads the table of addresses the cache keeps: as long as the number of people,
    /// not of messages.
    pub fn known_addresses(&self, prefix: &str, limit: u32) -> Result<Vec<Addr>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT email, MAX(NULLIF(name, '')) FROM addresses
             WHERE fold(email) LIKE ?1 || '%' ESCAPE '\\' OR fold(name) LIKE '%' || ?1 || '%' ESCAPE '\\'
             GROUP BY fold(email) ORDER BY SUM(uses) DESC LIMIT ?2",
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

fn insert_message(tx: &Connection, account_id: &str, folder: &str, msg: &NewMessage<'_>) -> Result<i64> {
    let NewMessage {
        uid,
        summary,
        fallback_date,
        size,
        flags,
        ..
    } = *msg;
    let json = |v: &Vec<Addr>| serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
    let date = summary.date.unwrap_or(fallback_date);
    let links = Links::of(summary, date);
    let fallback = summary.thread_key().unwrap_or_else(|| format!("{folder}/{uid}"));
    let thread = link_thread(tx, account_id, &links, fallback)?;
    let id: i64 = tx
        .prepare_cached(
            "INSERT INTO messages (account_id, folder, uid, message_id, in_reply_to, refs, subject, from_addr,
                to_addrs, cc_addrs, reply_to, date, size, seen, answered, flagged, draft, has_attachments,
                thread, bulk, unsubscribe, topic, sort_sender, sort_subject, forwarded, answered_all, keywords)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
                ?23, ?24, ?25, ?26, ?27)
             ON CONFLICT (account_id, folder, uid) DO UPDATE SET
                seen = excluded.seen, answered = excluded.answered,
                flagged = excluded.flagged, draft = excluded.draft,
                forwarded = excluded.forwarded, answered_all = excluded.answered_all,
                keywords = excluded.keywords
             RETURNING id",
        )?
        .query_row(
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
                flags.forwarded,
                flags.answered_all,
                serde_json::to_string(&msg.keywords).unwrap_or_else(|_| "[]".into()),
            ],
            |r| r.get(0),
        )?;
    let sender = summary.from.as_ref().map(addr_text).unwrap_or_default();
    let recipients: Vec<String> = summary.to.iter().chain(&summary.cc).map(addr_text).collect();
    tx.prepare_cached(
        "INSERT OR REPLACE INTO search (rowid, subject, sender, recipients, body)
         VALUES (?1, ?2, ?3, ?4, COALESCE((SELECT body FROM search WHERE rowid = ?1), ''))",
    )?
    .execute(params![id, summary.subject, sender, recipients.join(", ")])?;
    Ok(id)
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

/// Values as one JSON array: a set of any size is one parameter, read by `json_each`.
/// Queries take it as the left side of a CROSS JOIN, which SQLite keeps as the outer
/// loop: each item is found by an index, not each row of a folder matched to the list.
fn json_list<T: Serialize>(items: &[T]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".into())
}

/// Flags of many UIDs in one statement, rows already holding them untouched.
/// Returns how many changed.
/// The rows whose read state is kept only here (#42): the server's value is overridden
/// with "read", so a sync does not unread them.
fn with_local_seen(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    flags: Vec<(u32, Flags)>,
) -> Result<Vec<(u32, Flags)>> {
    let local: std::collections::HashSet<u32> = conn
        .prepare_cached("SELECT uid FROM local_seen WHERE account_id = ?1 AND folder = ?2")?
        .query_map(params![account_id, folder], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if local.is_empty() {
        return Ok(flags);
    }
    Ok(flags
        .into_iter()
        .map(|(uid, mut f)| {
            if local.contains(&uid) {
                f.seen = true;
            }
            (uid, f)
        })
        .collect())
}

fn write_flags(conn: &Connection, account_id: &str, folder: &str, flags: &[(u32, Flags)]) -> Result<usize> {
    if flags.is_empty() {
        return Ok(0);
    }
    let rows: Vec<[u32; 7]> = flags
        .iter()
        .map(|(uid, f)| {
            [
                *uid,
                f.seen.into(),
                f.answered.into(),
                f.flagged.into(),
                f.draft.into(),
                f.forwarded.into(),
                f.answered_all.into(),
            ]
        })
        .collect();
    // Each listed UID found by the index; left to itself the planner reads the whole
    // folder once per UID.
    Ok(conn
        .prepare_cached(
            "WITH s AS MATERIALIZED (
                SELECT m.id AS id, j.value ->> 1 AS seen, j.value ->> 2 AS answered, j.value ->> 3 AS flagged,
                    j.value ->> 4 AS draft, j.value ->> 5 AS forwarded, j.value ->> 6 AS answered_all
                FROM json_each(?3) j CROSS JOIN messages m
                    ON m.account_id = ?1 AND m.folder = ?2 AND m.uid = j.value ->> 0
             )
             UPDATE messages SET seen = s.seen, answered = s.answered, flagged = s.flagged, draft = s.draft,
                forwarded = s.forwarded, answered_all = s.answered_all
             FROM s WHERE messages.id = s.id
               AND (messages.seen, messages.answered, messages.flagged, messages.draft, messages.forwarded,
                    messages.answered_all)
                   IS NOT (s.seen, s.answered, s.flagged, s.draft, s.forwarded, s.answered_all)",
        )?
        .execute(params![account_id, folder, json_list(&rows)])?)
}

fn clear_folder(tx: &Connection, account_id: &str, folder: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM messages WHERE account_id = ?1 AND folder = ?2",
        params![account_id, folder],
    )?;
    // The read marks are kept by UID: a new UIDVALIDITY makes them name other messages.
    tx.execute(
        "DELETE FROM local_seen WHERE account_id = ?1 AND folder = ?2",
        params![account_id, folder],
    )?;
    tx.execute(
        "UPDATE folders SET oldest_uid = 0, highest_modseq = 0 WHERE account_id = ?1 AND name = ?2",
        params![account_id, folder],
    )?;
    Ok(())
}

fn ews_clear_folder(tx: &Connection, account_id: &str, name: &str) -> Result<()> {
    clear_folder(tx, account_id, name)?;
    tx.execute(
        "DELETE FROM ews_items WHERE account_id = ?1 AND folder = ?2",
        params![account_id, name],
    )?;
    tx.execute(
        "UPDATE ews_folders SET window_date = -1 WHERE account_id = ?1 AND name = ?2",
        params![account_id, name],
    )?;
    tx.execute(
        "UPDATE folders SET last_uid = 0, uidvalidity = uidvalidity + 1 WHERE account_id = ?1 AND name = ?2",
        params![account_id, name],
    )?;
    Ok(())
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
    (SELECT json_object('status', fu.status, 'due', fu.due,
            'deadline', fu.deadline, 'own_deadline', json(CASE WHEN fu.own_deadline THEN 'true' ELSE 'false' END),
            'repeat_secs', fu.repeat_secs, 'expect', fu.expect, 'kind', fu.kind,
            'ended', fu.ended, 'answered_by', CASE WHEN json_valid(fu.answered_by) THEN json(fu.answered_by) END,
            'answer', (SELECT a.id FROM messages a WHERE a.account_id = fu.account_id AND a.message_id = fu.answer_id LIMIT 1),
            'reminded', CASE WHEN json_valid(fu.reminded) THEN json(fu.reminded) ELSE json('[]') END,
            'sent', fu.sent, 'park', fu.park, 'park_folder', fu.park_folder, 'auto_reply', fu.auto_reply)
        FROM followups fu WHERE fu.account_id = m.account_id AND (fu.message_id = m.message_id OR fu.anchor = m.message_id)
        ORDER BY fu.status = 'waiting' DESC, fu.sent DESC LIMIT 1),
    m.forwarded, m.answered_all, m.keywords,
    (SELECT json_array(k.reply, k.reply_all, k.forward,
            (SELECT a.id FROM messages a WHERE a.account_id = k.account_id AND a.message_id = k.answer LIMIT 1))
        FROM marks k WHERE k.account_id = m.account_id AND k.message_id = m.message_id),
    (SELECT json_object('act', o.acts_kind, 'at', o.next_attempt, 'park', json(CASE WHEN o.followup_park THEN 'true' ELSE 'false' END),
            'queued', o.created)
        FROM outbox o WHERE o.account_id = m.account_id AND o.acts_on = m.message_id AND o.failed = 0
        ORDER BY o.id DESC LIMIT 1),
    EXISTS (SELECT 1 FROM followups fu WHERE fu.account_id = m.account_id AND fu.anchor = m.message_id
        AND fu.park = 'returned' AND fu.noticed = 0)";
const COLUMN_COUNT: usize = 29;

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
    let followup = followups::info_of(r.get(22)?);
    let flags = Flags {
        seen: r.get(14)?,
        answered: r.get(15)?,
        flagged: r.get(16)?,
        draft: r.get(17)?,
        deleted: false,
        forwarded: r.get(23)?,
        answered_all: r.get(24)?,
    };
    let (done, my_answer) = marks::done_of(r.get(26)?);
    let outgoing = marks::outgoing_of(r.get(27)?);
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
        marks: marks::marks_of(&flags, &done, outgoing.as_ref()),
        flags,
        keywords: serde_json::from_str(&r.get::<_, String>(25)?).unwrap_or_default(),
        has_attachments: r.get(18)?,
        thread: r.get(19)?,
        bulk: r.get(20)?,
        thread_count: 1,
        thread_date: r.get(12)?,
        thread_size: unsigned(r.get(13)?),
        thread_senders: Vec::new(),
        thread_draft: false,
        snoozed_until: r.get(21)?,
        followup_due: followups::waiting_due(followup.as_ref()),
        followup,
        my_answer,
        outgoing,
        answer_came: r.get(28)?,
    })
}

/// A count or a sum of sizes, never negative.
fn unsigned(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
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

    pub(super) fn folder(name: &str, role: Option<FolderRole>) -> Folder {
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
            keywords: Vec::new(),
        };
        store.insert_message("a", "INBOX", &msg).unwrap();
        for prefix in ["иван", "ИВАН", "пЕт", "IVAN", "Ivan@"] {
            let found = store.known_addresses(prefix, 8).unwrap();
            assert_eq!(found.len(), 1, "{prefix}");
            assert_eq!(found[0].email, "ivan@example.org");
        }
        assert!(store.known_addresses("сидор", 8).unwrap().is_empty());
    }

    /// The folder's counts are kept by triggers (v16), not counted at each ask.
    #[test]
    fn folder_counters_follow_inserts_reads_and_deletes() {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders("a", &[folder("INBOX", Some(FolderRole::Inbox))])
            .unwrap();
        let counts = |store: &Store| {
            let f = store.folders(Some("a")).unwrap();
            let f = f.iter().find(|f| f.folder.name == "INBOX").unwrap();
            (f.total, f.unread)
        };
        let mail = summary("Привет", 100);
        let msg = |uid: u32, seen: bool| NewMessage {
            uid,
            summary: &mail,
            fallback_date: 0,
            size: 10,
            flags: Flags {
                seen,
                ..Default::default()
            },
            keywords: Vec::new(),
        };
        assert_eq!(counts(&store), (0, 0));

        store.insert_message("a", "INBOX", &msg(1, false)).unwrap();
        store.insert_message("a", "INBOX", &msg(2, true)).unwrap();
        assert_eq!(counts(&store), (2, 1));

        let seen = |seen: bool| Flags {
            seen,
            ..Default::default()
        };
        store.update_flags("a", "INBOX", &[(1, seen(true))]).unwrap();
        assert_eq!(counts(&store), (2, 0), "read: unread drops, total stays");
        store.update_flags("a", "INBOX", &[(1, seen(false))]).unwrap();
        assert_eq!(counts(&store), (2, 1), "unread again");

        store.remove_uids("a", "INBOX", &[1]).unwrap();
        assert_eq!(counts(&store), (1, 0), "gone: both drop");

        // A UID cached again is an upsert, not a second message.
        store.insert_message("a", "INBOX", &msg(2, false)).unwrap();
        assert_eq!(counts(&store), (1, 1));

        store.clear_folder("a", "INBOX").unwrap();
        assert_eq!(counts(&store), (0, 0), "a cleared folder");
    }

    /// A file cache has a second connection for the heavy reads; a write on the writer is
    /// visible to it (WAL), so the list, search and folder counts stay right.
    #[test]
    fn a_file_cache_reads_through_its_own_connection() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("mail.sqlite")).unwrap();
        assert!(store.read.is_some(), "a file cache opens a read connection");
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
            keywords: Vec::new(),
        };
        store.insert_message("a", "INBOX", &msg).unwrap();
        assert_eq!(store.list(&ListQuery::default()).unwrap().len(), 1);
        assert_eq!(store.folders(Some("a")).unwrap()[0].total, 1);
        assert_eq!(store.search("привет", None, 0, &[]).unwrap().len(), 1);
    }

    /// "Snooze" on a series is one commit; a letter snoozed again keeps where it first came
    /// from, and one already waiting in Snoozed goes back where it was.
    #[test]
    fn snoozing_a_series_is_one_commit_and_keeps_the_first_destination() {
        let store = Store::open_in_memory().unwrap();
        let return_to = |store: &Store, now: i64, mid: &str| {
            store
                .snoozes_due(now)
                .unwrap()
                .into_iter()
                .find(|s| s.message_id == mid)
                .unwrap()
                .return_to
        };
        store
            .snooze_add_batch("a", "Snoozed", "INBOX", 100, &[("m1".into(), "Письмо".into())])
            .unwrap();
        assert_eq!(return_to(&store, 100, "m1"), "INBOX");
        // Snoozed again while it waits in Snoozed: the first destination stays.
        store
            .snooze_add_batch("a", "Snoozed", "Snoozed", 200, &[("m1".into(), "Письмо".into())])
            .unwrap();
        assert_eq!(return_to(&store, 200, "m1"), "INBOX", "the first destination stays");
        // From Sent it goes back to Sent.
        store
            .snooze_add_batch("a", "Snoozed", "Sent", 300, &[("m2".into(), "Ответ".into())])
            .unwrap();
        assert_eq!(return_to(&store, 300, "m2"), "Sent");
        // A whole series lands in one call.
        let batch: Vec<(String, String)> = (0..50).map(|i| (format!("b{i}"), format!("S{i}"))).collect();
        store.snooze_add_batch("a", "Snoozed", "INBOX", 400, &batch).unwrap();
        assert_eq!(store.snoozes_due(1000).unwrap().len(), 52, "m1, m2 and the fifty");
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
                keywords: Vec::new(),
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

    pub(super) fn with_ids(subject: &str, date: i64, id: &str, parent: Option<&str>) -> Summary {
        Summary {
            message_id: Some(id.into()),
            in_reply_to: parent.map(Into::into),
            references: parent.map(|p| vec![p.to_owned()]).unwrap_or_default(),
            ..summary(subject, date)
        }
    }

    pub(super) fn put(store: &Store, folder: &str, uid: u32, s: &Summary, seen: bool) -> i64 {
        let msg = NewMessage {
            uid,
            summary: s,
            fallback_date: 0,
            size: 1,
            flags: Flags {
                seen,
                ..Default::default()
            },
            keywords: Vec::new(),
        };
        store.insert_message("a", folder, &msg).unwrap()
    }

    /// A label set elsewhere reaches the cache only if a later fetch of the same letter
    /// updates its keywords: `keywords` was written at the first insert and never again.
    #[test]
    fn a_later_fetch_updates_the_keywords_it_brought() {
        let store = mailbox();
        let s = summary("Отчёт", 100);
        let first = NewMessage {
            uid: 7,
            summary: &s,
            fallback_date: 0,
            size: 1,
            flags: Flags {
                seen: true,
                ..Default::default()
            },
            keywords: Vec::new(),
        };
        let id = store.insert_message("a", "INBOX", &first).unwrap();
        assert!(store.get(id).unwrap().unwrap().keywords.is_empty());

        let again = NewMessage {
            keywords: vec!["depesha-work".into()],
            ..first
        };
        store.insert_message("a", "INBOX", &again).unwrap();
        assert_eq!(store.get(id).unwrap().unwrap().keywords, ["depesha-work"]);
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

    pub(super) fn mailbox() -> Store {
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

    pub(super) fn from_to(mut s: Summary, from: &str, to: &str) -> Summary {
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
        let list = |folder: Option<&str>| {
            store
                .list(&ListQuery {
                    folder: folder.map(Into::into),
                    threads: true,
                    ..Default::default()
                })
                .unwrap()
        };
        // My answer at 500 does not move the conversation above the letter of 300.
        let rows = list(None);
        assert_eq!(rows[1].subject, "Отпуск");
        assert_eq!((rows[1].date, rows[1].thread_date), (100, 100));
        let who: Vec<_> = rows[1].thread_senders.iter().map(|a| a.email.as_str()).collect();
        assert_eq!(who, ["ivan@x", "me@x"]);
        // In Sent, my letters date it.
        assert_eq!(list(Some("Sent"))[0].thread_date, 500);

        // A new letter at 600 in it does.
        put(
            &store,
            "INBOX",
            3,
            &from_to(with_ids("Re: Отпуск", 600, "c@x", Some("b@x")), "ivan@x", "me@x"),
            true,
        );
        let rows = list(None);
        assert_eq!(rows[0].subject, "Re: Отпуск");
        assert_eq!(rows[0].thread_date, 600);
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
    fn large_mail_by_size_year_folder_and_mailbox() {
        let store = Store::open_in_memory().unwrap();
        let folders = [
            folder("INBOX", Some(FolderRole::Inbox)),
            folder("Projects", None),
            folder("Projects/2024", None),
            folder("ProjectsOld", None),
            folder("Trash", Some(FolderRole::Trash)),
        ];
        store.replace_folders("a", &folders).unwrap();
        store.replace_folders("b", &folders[..1]).unwrap();
        let mb = 1 << 20;
        let jan_2024 = crate::query::SearchQuery::parse("year:2024").after.unwrap();
        let jan_2025 = crate::query::SearchQuery::parse("year:2025").after.unwrap();
        let add = |account: &str, folder: &str, uid: u32, subject: &str, date: i64, size: u32, files: bool| {
            let mut s = summary(subject, date);
            s.has_attachments = files;
            let msg = NewMessage {
                uid,
                summary: &s,
                fallback_date: 0,
                size,
                flags: Flags::default(),
                keywords: Vec::new(),
            };
            store.insert_message(account, folder, &msg).unwrap();
        };
        add("a", "INBOX", 1, "Фото с отпуска", jan_2024 + 100, 30 * mb, true);
        // The last second of 2024 and the first of 2025: the year is exact.
        add("a", "Projects", 1, "Смета", jan_2025 - 1, 60 * mb, true);
        add("a", "Projects/2024", 1, "Чертежи", jan_2025, 120 * mb, true);
        add("a", "ProjectsOld", 1, "Архив проекта", jan_2024 + 200, 40 * mb, false);
        add("a", "INBOX", 2, "Записка", jan_2024 + 300, 25 * mb, false);
        add("a", "Trash", 1, "Старый дистрибутив", jan_2024 + 400, 500 * mb, true);
        add("b", "INBOX", 1, "Видео", jan_2024 + 500, 80 * mb, true);

        let subjects = |q: &str, account: Option<&str>| -> Vec<String> {
            store
                .search(
                    q,
                    account,
                    0,
                    &[SortKey {
                        by: SortField::Size,
                        desc: true,
                    }],
                )
                .unwrap()
                .into_iter()
                .map(|m| m.subject)
                .collect()
        };
        // Bigger than the threshold, not equal to it; the biggest first; the trash only when asked for.
        assert_eq!(
            subjects("larger:25M", None),
            ["Чертежи", "Видео", "Смета", "Архив проекта", "Фото с отпуска"]
        );
        assert_eq!(subjects("больше:50МБ меньше:100МБ", None), ["Видео", "Смета"]);
        assert_eq!(
            subjects("larger:25M year:2024", None),
            ["Видео", "Смета", "Архив проекта", "Фото с отпуска"]
        );
        // A folder alone, or with `/*` the folders inside it, not one that only starts the same.
        assert_eq!(subjects("larger:1M in:projects", None), ["Смета"]);
        assert_eq!(subjects("larger:1M в:Projects/*", None), ["Чертежи", "Смета"]);
        assert_eq!(subjects("larger:1M in:projects/2024", None), ["Чертежи"]);
        assert_eq!(
            subjects("larger:1M has:attachment year:2024", Some("a")),
            ["Смета", "Фото с отпуска"]
        );
        assert_eq!(subjects("larger:1M in:trash", None), ["Старый дистрибутив"]);

        let totals = store.search_totals("larger:25M year:2024", None).unwrap();
        assert_eq!(
            totals,
            SearchTotals {
                count: 4,
                size: u64::from(210 * mb),
            }
        );
        assert_eq!(store.search_totals("larger:25M", Some("b")).unwrap().count, 1);
        assert_eq!(store.search_totals("", None).unwrap(), SearchTotals::default());
        assert_eq!(store.search_totals("фото", None).unwrap().count, 1);
        // A mailbox named but not resolved to an id finds nothing, not every mailbox.
        assert!(subjects("ящик:work larger:25M", None).is_empty());
        assert_eq!(store.search_totals("account:b", None).unwrap(), SearchTotals::default());
        assert_eq!(subjects("account:b larger:25M", Some("b")), ["Видео"]);
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
            keywords: Vec::new(),
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

    // Versions of the cache.

    /// A cache before numbered steps, as the first versions left it: without the
    /// columns added later, the avatars and the Exchange tables.
    const CACHE_V0: &str = "
        CREATE TABLE folders (
            account_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL, delimiter TEXT,
            role TEXT, selectable INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
            uidvalidity INTEGER NOT NULL DEFAULT 0, last_uid INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, name)
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
            message_id TEXT, in_reply_to TEXT, refs TEXT NOT NULL, subject TEXT NOT NULL, from_addr TEXT,
            to_addrs TEXT NOT NULL, cc_addrs TEXT NOT NULL, reply_to TEXT NOT NULL, date INTEGER NOT NULL,
            size INTEGER NOT NULL, seen INTEGER NOT NULL, answered INTEGER NOT NULL, flagged INTEGER NOT NULL,
            draft INTEGER NOT NULL, has_attachments INTEGER NOT NULL,
            UNIQUE (account_id, folder, uid),
            FOREIGN KEY (account_id, folder) REFERENCES folders (account_id, name) ON DELETE CASCADE
        );
        CREATE INDEX messages_by_date ON messages (date DESC);
        CREATE INDEX messages_by_folder ON messages (account_id, folder, date DESC);
        CREATE TABLE bodies (
            message_id INTEGER PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
            raw BLOB NOT NULL
        );
        CREATE VIRTUAL TABLE search USING fts5 (
            subject, sender, recipients, body, tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
            DELETE FROM search WHERE rowid = old.id;
        END;
        CREATE TABLE outbox (
            id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, draft TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, last_error TEXT,
            failed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
        );
        CREATE TABLE snoozed (
            account_id TEXT NOT NULL, message_id TEXT NOT NULL, folder TEXT NOT NULL,
            return_to TEXT NOT NULL, until INTEGER NOT NULL, subject TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (account_id, message_id)
        );
        CREATE TABLE followups (
            account_id TEXT NOT NULL, message_id TEXT NOT NULL, subject TEXT NOT NULL,
            recipients TEXT NOT NULL, sent INTEGER NOT NULL, due INTEGER NOT NULL,
            notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, message_id)
        );
        CREATE TABLE trusted_senders (email TEXT PRIMARY KEY);";

    /// Mail, outbox, snoozed and awaited answers in the columns every version has.
    const OLD_DATA: &str = r#"
        INSERT INTO folders (account_id, name, display_name, selectable) VALUES ('a', 'INBOX', 'INBOX', 1);
        INSERT INTO messages (account_id, folder, uid, message_id, in_reply_to, refs, subject, from_addr,
            to_addrs, cc_addrs, reply_to, date, size, seen, answered, flagged, draft, has_attachments)
        VALUES
            ('a', 'INBOX', 1, 'a@x', NULL, '[]', 'Смета', '{"name":"Ёлкин","email":"e@x"}', '[]', '[]', '[]', 100, 1, 1, 0, 0, 0, 0),
            ('a', 'INBOX', 2, 'b@x', 'a@x', '[]', 'RE: Смета', NULL, '[]', '[]', '[]', 200, 1, 0, 0, 1, 0, 0);
        INSERT INTO outbox (account_id, draft, next_attempt, created) VALUES ('a', '{}', 300, 300);
        INSERT INTO snoozed (account_id, message_id, folder, return_to, until) VALUES ('a', 'c@x', 'Snoozed', 'INBOX', 400);
        INSERT INTO followups (account_id, message_id, subject, recipients, sent, due) VALUES ('a', 'a@x', 'Отчёт', 'b@x', 1, 500);"#;

    /// A cache file left by an older version: its tables with the data, `version` steps done.
    fn old_cache(dir: &tempfile::TempDir, tables: impl Fn(&Connection), version: i64) -> std::path::PathBuf {
        let path = dir.path().join("mail.sqlite");
        let conn = Connection::open(&path).unwrap();
        tables(&conn);
        conn.execute_batch(OLD_DATA).unwrap();
        conn.pragma_update(None, "user_version", version).unwrap();
        path
    }

    /// Tables of version 1 and 2 as their builds left them: the tables, the columns and
    /// indexes added at every start, the sort keys with version 2.
    fn tables_of(version: i64) -> impl Fn(&Connection) {
        move |conn| {
            conn.execute_batch(TABLES).unwrap();
            for (table, column, decl) in UNVERSIONED_COLUMNS {
                add_column(conn, table, column, decl).unwrap();
            }
            if version >= 2 {
                for (table, column, decl) in SORT_COLUMNS {
                    add_column(conn, table, column, decl).unwrap();
                }
            }
            conn.execute_batch(THREADS).unwrap();
        }
    }

    /// Columns of every table, indexes and triggers: what makes the cache's shape.
    fn shape(conn: &Connection) -> Vec<String> {
        let mut out: Vec<String> = conn
            .prepare(
                "SELECT t.name || '.' || c.name || ' ' || c.type || ' ' || c.\"notnull\" || ' '
                        || COALESCE(c.dflt_value, 'NULL') || ' ' || c.pk
                 FROM sqlite_schema t JOIN pragma_table_info(t.name) c
                 WHERE t.type = 'table' ORDER BY t.name, c.name",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let objects: Vec<String> = conn
            .prepare("SELECT type || ' ' || name FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        out.extend(objects);
        out
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn caches_of_every_version_reach_the_same_shape_with_their_data() {
        let fresh = Store::open_in_memory().unwrap();
        let fresh_shape = shape(&fresh.conn());
        assert_eq!(user_version(&fresh.conn()).unwrap(), MIGRATIONS.len() as i64);

        let v0 = |conn: &Connection| conn.execute_batch(CACHE_V0).unwrap();
        type Tables = Box<dyn Fn(&Connection)>;
        let v4 = |conn: &Connection| {
            tables_of(2)(conn);
            v4_modseq(conn).unwrap();
        };
        let v5 = move |conn: &Connection| {
            v4(conn);
            v5_lookups(conn).unwrap();
        };
        let olds: [(&str, Tables, i64); 6] = [
            ("v0", Box::new(v0), 0),
            ("v1", Box::new(tables_of(1)), 1),
            ("v2 (0.5.6)", Box::new(tables_of(2)), 2),
            // Step 3 changes nothing a cache of 0.5.6 lacks: the same tables, numbered 3.
            ("v3", Box::new(tables_of(2)), 3),
            ("v4", Box::new(v4), 4),
            ("v5 (0.5.7)", Box::new(v5), 5),
        ];
        for (name, tables, version) in olds {
            let dir = tempfile::tempdir().unwrap();
            let store = Store::open(old_cache(&dir, tables, version)).unwrap();
            // What step 5 keeps beside the messages is filled from the mail already there.
            assert_eq!(store.known_addresses("ёлк", 8).unwrap()[0].email, "e@x", "{name}");
            // The folder counters are recomputed from the mail already cached.
            let counts = store.folders(Some("a")).unwrap();
            let inbox = counts.iter().find(|f| f.folder.name == "INBOX").unwrap();
            assert_eq!((inbox.total, inbox.unread), (2, 1), "{name}");
            lookups_hold(&store);
            let conn = store.conn();
            assert!(count(&conn, "SELECT COUNT(*) FROM threads") > 0, "{name}");
            assert!(count(&conn, "SELECT COUNT(*) FROM addresses") > 0, "{name}");
            assert_eq!(shape(&conn), fresh_shape, "{name}");
            assert_eq!(user_version(&conn).unwrap(), MIGRATIONS.len() as i64, "{name}");
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM messages"), 2, "{name}");
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM outbox"), 1, "{name}");
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM snoozed"), 1, "{name}");
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM followups"), 1, "{name}");
            // The awaited answer is still awaited, by the time of its reminder.
            assert_eq!(
                rows_of(
                    &conn,
                    "SELECT status, due, deadline, repeat_secs, expect, ended, reminded FROM followups"
                ),
                ["Text(\"waiting\"), Integer(500), Integer(500), Integer(0), Text(\"\"), Null, Text(\"[]\")"],
                "{name}"
            );
            assert_eq!(
                rows_of(&conn, "SELECT followup_repeat_secs, followup_expect FROM outbox"),
                ["Integer(0), Text(\"\")"],
                "{name}"
            );
            drop(conn);
            assert_eq!(store.followups_count().unwrap().active, 1, "{name}");
            // The address book of 0.7 reads the addresses the old cache kept; the
            // suggestions start empty, and no old row was lost on the way.
            assert!(!store.people("").unwrap().is_empty(), "{name}");
            assert!(store.hints().unwrap().is_empty(), "{name}");
            assert!(store.hint_counts().unwrap().is_empty(), "{name}");
            let conn = store.conn();
            // Mail of a cache numbered 3 or later was linked as it came; these rows were not.
            if version < 3 {
                assert_eq!(
                    count(&conn, "SELECT COUNT(*) FROM messages WHERE thread = ''"),
                    0,
                    "{name}"
                );
            }
            if version == 0 {
                // Linked into one conversation by the step it missed.
                assert_eq!(count(&conn, "SELECT COUNT(DISTINCT thread) FROM messages"), 1, "{name}");
            }
            if version < 2 {
                let sender: String = conn
                    .query_row("SELECT sort_sender FROM messages WHERE uid = 1", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(sender, "елкин", "{name}");
            }
        }
    }

    /// Step 12 first shipped without `label_check`; intermediate builds and CI left caches
    /// numbered 12 that lack the column. A later step must add it, and a fresh cache must
    /// already have it.
    #[test]
    fn a_cache_that_ran_the_first_v12_gains_the_label_check_column() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        {
            let mut conn = Connection::open(&path).unwrap();
            migrate(&mut conn, &MIGRATIONS[..12]).unwrap();
            conn.execute_batch("ALTER TABLE folder_props DROP COLUMN label_check")
                .unwrap();
            assert_eq!(user_version(&conn).unwrap(), 12);
            assert!(
                !conn
                    .prepare("SELECT 1 FROM pragma_table_info('folder_props') WHERE name = 'label_check'")
                    .unwrap()
                    .exists([])
                    .unwrap(),
                "the column is gone: this is the first v12"
            );
        }
        let store = Store::open(&path).unwrap();
        let conn = store.conn();
        assert_eq!(user_version(&conn).unwrap(), MIGRATIONS.len() as i64);
        assert!(
            conn.prepare("SELECT 1 FROM pragma_table_info('folder_props') WHERE name = 'label_check'")
                .unwrap()
                .exists([])
                .unwrap(),
            "the column was added back"
        );
    }

    #[test]
    fn a_failed_step_changes_nothing_and_the_next_start_goes_on() {
        fn broken(conn: &Connection) -> Result<()> {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN doomed TEXT")?;
            Err(crate::Error::Parse)
        }
        let dir = tempfile::tempdir().unwrap();
        let mut conn = Connection::open(old_cache(&dir, tables_of(2), 2)).unwrap();
        let steps: Vec<Step> = MIGRATIONS.iter().copied().chain([broken as Step]).collect();
        assert!(migrate(&mut conn, &steps).is_err());
        // The real steps went through; the broken one left neither its column nor its number.
        assert_eq!(user_version(&conn).unwrap(), MIGRATIONS.len() as i64);
        assert_eq!(shape(&conn), shape(&Store::open_in_memory().unwrap().conn()));

        // A step interrupted in the middle of the history: the same.
        let dir = tempfile::tempdir().unwrap();
        let mut conn = Connection::open(old_cache(&dir, tables_of(1), 1)).unwrap();
        let steps: [Step; 2] = [v1_tables_and_threads, broken];
        assert!(migrate(&mut conn, &steps).is_err());
        assert_eq!(user_version(&conn).unwrap(), 1);
        assert!(
            !conn
                .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'doomed'")
                .unwrap()
                .exists([])
                .unwrap()
        );
        migrate(&mut conn, MIGRATIONS).unwrap();
        assert_eq!(user_version(&conn).unwrap(), MIGRATIONS.len() as i64);
        assert_eq!(shape(&conn), shape(&Store::open_in_memory().unwrap().conn()));
    }

    #[test]
    fn an_up_to_date_cache_runs_no_step() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        let store = Store::open(&path).unwrap();
        store
            .replace_folders("a", &[folder("INBOX", Some(FolderRole::Inbox))])
            .unwrap();
        let id = put(&store, "INBOX", 1, &with_ids("Смета", 100, "a@x", None), false);
        // A row the old fill at every start would have changed.
        store
            .conn()
            .execute("UPDATE messages SET thread = '', sort_sender = '' WHERE id = ?1", [id])
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        let (thread, sender): (String, String) = store
            .conn()
            .query_row("SELECT thread, sort_sender FROM messages WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((thread.as_str(), sender.as_str()), ("", ""));
    }

    #[test]
    fn a_cache_of_a_newer_version_is_refused_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE future (x TEXT); INSERT INTO future VALUES ('outbox');")
                .unwrap();
            conn.pragma_update(None, "user_version", 99).unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        let err = Store::open(&path).err().expect("refused");
        assert!(
            matches!(err, crate::Error::CacheTooNew { found: 99, known } if known == MIGRATIONS.len() as i64),
            "{err:?}"
        );
        assert_eq!(err.kind(), "cache-too-new");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "no journal next to it"
        );
    }

    // Clearing.

    /// Makes the statement on `table` fail as a full disk would.
    fn fail_on(store: &Store, op: &str, table: &str) {
        store
            .conn()
            .execute_batch(&format!(
                "CREATE TEMP TRIGGER fail_{table} BEFORE {op} ON {table} BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
            ))
            .unwrap();
    }

    fn heal(store: &Store, table: &str) {
        store
            .conn()
            .execute_batch(&format!("DROP TRIGGER fail_{table}"))
            .unwrap();
    }

    /// Every row of the tables an account has data in, for comparing before and after.
    fn dump(store: &Store) -> Vec<String> {
        let conn = store.conn();
        let mut out = Vec::new();
        for table in [
            "folders",
            "messages",
            "bodies",
            "outbox",
            "snoozed",
            "followups",
            "trusted_senders",
            "avatars",
            "ews_folders",
            "ews_items",
            "labels",
            "folder_props",
            "namespaces",
            "local_seen",
        ] {
            let mut stmt = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
            let n = stmt.column_count();
            let rows = stmt
                .query_map([], |r| {
                    (0..n)
                        .map(|i| r.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}")))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap();
            for row in rows {
                out.push(format!("{table}: {}", row.unwrap().join(", ")));
            }
        }
        out.push(format!("search: {}", count(&conn, "SELECT COUNT(*) FROM search")));
        out
    }

    /// Accounts "a" (Exchange-like, with item ids and photos) and "ab" with mail of their own.
    fn two_accounts() -> Store {
        let store = mailbox();
        store
            .replace_folders("ab", &[folder("INBOX", Some(FolderRole::Inbox))])
            .unwrap();
        for (account, uid) in [("a", 1), ("ab", 1)] {
            let s = with_ids("Смета", 100, &format!("{account}@x"), None);
            let msg = NewMessage {
                uid,
                summary: &s,
                fallback_date: 0,
                size: 1,
                flags: Flags::default(),
                keywords: Vec::new(),
            };
            let id = store.insert_message(account, "INBOX", &msg).unwrap();
            store.save_body(id, b"raw", "текст").unwrap();
            store
                .ews_set_folders(account, &[("INBOX".into(), format!("{account}-inbox"))])
                .unwrap();
            store
                .ews_item_add(account, "INBOX", uid, &format!("{account}-item"), 100)
                .unwrap();
            store.ews_set_window(account, "INBOX", 0).unwrap();
            store.set_folder_state(account, "INBOX", 1, uid).unwrap();
            store
                .set_avatar(&format!("photo:{account}:boss@x"), Some("data:"), 1)
                .unwrap();
            store
                .outbox_add(account, &Draft::default(), 1, 1, 0, &FollowupPlan::default())
                .unwrap();
            store
                .mark_done(account, "q@x", crate::smtp::Act::Reply, 1, None)
                .unwrap();
            store
                .save_label(
                    account,
                    &crate::acl::Label {
                        name: "Смета".into(),
                        keyword: crate::acl::keyword_of("Смета"),
                        color: "#000000".into(),
                    },
                )
                .unwrap();
            store
                .save_folder_props(
                    account,
                    &crate::acl::FolderProps {
                        folder: "INBOX".into(),
                        display_name: "INBOX".into(),
                        ..Default::default()
                    },
                )
                .unwrap();
            store
                .save_namespaces(account, &crate::acl::Namespace::default(), 1)
                .unwrap();
            store.set_local_seen(account, "INBOX", &[uid], 1).unwrap();
            store
                .save_server_caps(
                    account,
                    &ServerCaps {
                        capabilities: vec!["IMAP4rev1".into()],
                        detected: 1,
                        ..ServerCaps::default()
                    },
                )
                .unwrap();
            store
                .save_quota(account, Some(&crate::quota::Quota::default()), 1)
                .unwrap();
            store
                .save_folder_sizes(
                    account,
                    &FolderSizes {
                        counted: 1,
                        method: crate::quota::SizeMethod::Fetch,
                        folders: vec![crate::quota::FolderSize {
                            folder: "INBOX".into(),
                            ..Default::default()
                        }],
                    },
                )
                .unwrap();
            store
                .snooze_add(&Snooze {
                    account_id: account.into(),
                    message_id: format!("{account}@x"),
                    folder: "Snoozed".into(),
                    return_to: "INBOX".into(),
                    until: 10,
                    subject: String::new(),
                })
                .unwrap();
            store
                .followup_add(&Followup {
                    account_id: account.into(),
                    message_id: format!("{account}@x"),
                    subject: String::new(),
                    recipients: String::new(),
                    sent: 1,
                    due: 2,
                    ..Default::default()
                })
                .unwrap();
        }
        store.set_avatar("bimi:example.org", None, 1).unwrap();
        store.trust_sender("friend@example.org").unwrap();
        store
    }

    #[test]
    fn clearing_is_all_or_nothing() {
        let store = two_accounts();
        let before = dump(&store);

        fail_on(&store, "UPDATE", "folders");
        assert!(store.clear_folder("a", "INBOX").is_err());
        assert_eq!(dump(&store), before);

        fail_on(&store, "UPDATE", "ews_folders");
        heal(&store, "folders");
        assert!(store.ews_clear_folder("a", "INBOX").is_err());
        assert_eq!(dump(&store), before);
        // A folder created again on the server: the new id is kept only with the cleared cache.
        assert!(
            store
                .ews_set_folders("a", &[("INBOX".into(), "a-inbox-2".into())])
                .is_err()
        );
        assert_eq!(dump(&store), before);
        heal(&store, "ews_folders");

        fail_on(&store, "DELETE", "avatars");
        assert!(store.forget_account("a").is_err());
        assert_eq!(dump(&store), before);
        heal(&store, "avatars");

        store.clear_folder("a", "INBOX").unwrap();
        assert!(store.known_uids("a", "INBOX").unwrap().is_empty());
        assert_eq!(store.known_uids("ab", "INBOX").unwrap().len(), 1);
    }

    #[test]
    fn a_forgotten_account_leaves_nothing_behind() {
        let store = two_accounts();
        store.change_flags("a", "INBOX", &[1], FlagChange::Seen(true)).unwrap();
        store.forget_account("a").unwrap();
        let conn = store.conn();
        let tables: Vec<String> = conn
            .prepare(
                "SELECT t.name FROM sqlite_schema t JOIN pragma_table_info(t.name) c
                 WHERE t.type = 'table' AND c.name = 'account_id'",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(tables.len() >= 7, "{tables:?}");
        for table in &tables {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE account_id = ?1");
            let left = |account: &str| -> i64 { conn.query_row(&sql, [account], |r| r.get(0)).unwrap() };
            assert_eq!(left("a"), 0, "{table}");
            assert!(left("ab") > 0, "{table}");
        }
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM bodies"), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM search"), 1);
        let avatars: Vec<String> = conn
            .prepare("SELECT key FROM avatars ORDER BY key")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(avatars, ["bimi:example.org", "photo:ab:boss@x"]);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM trusted_senders"), 1);
        drop(conn);
        assert!(store.pending().is_empty());
    }

    #[test]
    fn an_exchange_folder_cleared_gets_a_new_uidvalidity() {
        let store = two_accounts();
        let (validity, _) = store.folder_state("a", "INBOX").unwrap();
        store.ews_clear_folder("a", "INBOX").unwrap();
        let (cleared, last_uid) = store.folder_state("a", "INBOX").unwrap();
        assert_ne!(cleared, validity);
        assert_eq!(last_uid, 0);
        assert!(store.ews_item_ids("a", "INBOX", &[1]).unwrap().is_empty());

        // Deleted and created again on the server: cleared with the new id.
        assert_eq!(
            store
                .ews_set_folders("ab", &[("INBOX".into(), "ab-inbox-2".into())])
                .unwrap(),
            ["INBOX"]
        );
        assert_ne!(store.folder_state("ab", "INBOX").unwrap().0, 1);
        assert!(store.known_uids("ab", "INBOX").unwrap().is_empty());
        assert_eq!(store.ews_window("ab", "INBOX").unwrap(), -1);
    }

    // Flags held against syncs.

    #[test]
    fn a_flag_of_a_cleared_folder_does_not_pass_to_a_new_message() {
        let store = mailbox();
        put(&store, "INBOX", 7, &summary("Старое", 100), false);
        store.change_flags("a", "INBOX", &[7], FlagChange::Seen(true)).unwrap();
        // UIDVALIDITY changed before the server answered: another letter comes as UID 7.
        store.clear_folder("a", "INBOX").unwrap();
        let id = put(&store, "INBOX", 7, &summary("Новое", 200), false);
        store.update_flags("a", "INBOX", &[(7, Flags::default())]).unwrap();
        assert!(!store.get(id).unwrap().unwrap().flags.seen);
        // The answer to the old change comes later and touches nothing.
        store.settle_flags("a", "INBOX", &[7]);
        assert!(store.pending().is_empty());
    }

    #[test]
    fn a_flag_the_cache_could_not_take_is_not_held() {
        let store = mailbox();
        let id = put(&store, "INBOX", 7, &summary("Отчёт", 100), false);
        fail_on(&store, "UPDATE", "messages");
        assert!(store.change_flags("a", "INBOX", &[7], FlagChange::Seen(true)).is_err());
        heal(&store, "messages");
        assert!(store.pending().is_empty());
        // The server's flags show again: still unread there.
        store.update_flags("a", "INBOX", &[(7, Flags::default())]).unwrap();
        assert!(!store.get(id).unwrap().unwrap().flags.seen);
        store
            .update_flags(
                "a",
                "INBOX",
                &[(
                    7,
                    Flags {
                        seen: true,
                        ..Default::default()
                    },
                )],
            )
            .unwrap();
        assert!(store.get(id).unwrap().unwrap().flags.seen);
    }

    #[test]
    fn actions_read_the_uidvalidity_with_the_message() {
        let store = mailbox();
        let id = put(&store, "INBOX", 7, &summary("Отчёт", 100), false);
        store.set_folder_state("a", "INBOX", 42, 7).unwrap();
        let (row, validity) = store.get_at(id).unwrap().unwrap();
        assert_eq!((row.uid, validity), (7, 42));
        assert!(store.get_at(id + 1).unwrap().is_none());
    }

    // Mod-sequences (CONDSTORE).

    #[test]
    fn a_cache_of_version_3_syncs_its_folders_in_full_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = old_cache(&dir, tables_of(2), 3);
        Connection::open(&path)
            .unwrap()
            .execute("UPDATE folders SET uidvalidity = 9, last_uid = 2", [])
            .unwrap();
        let store = Store::open(&path).unwrap();
        assert_eq!(shape(&store.conn()), shape(&Store::open_in_memory().unwrap().conn()));
        assert_eq!(store.folder_state("a", "INBOX").unwrap(), (9, 2));
        assert_eq!(store.uid_range("a", "INBOX").unwrap(), Some((1, 2)));
        assert_eq!(store.modseq_mark("a", "INBOX").unwrap(), ModSeqMark::default());
    }

    #[test]
    fn a_mod_sequence_is_forgotten_with_the_folder_and_at_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        let store = Store::open(&path).unwrap();
        store
            .replace_folders("a", &[folder("INBOX", Some(FolderRole::Inbox))])
            .unwrap();
        assert_eq!(store.uid_range("a", "INBOX").unwrap(), None);
        let mark = ModSeqMark {
            modseq: 90_060_115_205_545_359,
            exists: 30,
            uid_next: 31,
        };
        store.set_modseq_mark("a", "INBOX", mark).unwrap();
        store.set_folder_state("a", "INBOX", 5, 30).unwrap();
        assert_eq!(store.modseq_mark("a", "INBOX").unwrap(), mark);
        // The folder list comes again: the mark stays.
        store
            .replace_folders("a", &[folder("INBOX", Some(FolderRole::Inbox))])
            .unwrap();
        assert_eq!(store.modseq_mark("a", "INBOX").unwrap(), mark);

        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.modseq_mark("a", "INBOX").unwrap().modseq, 0, "a new start");
        assert_eq!(store.folder_state("a", "INBOX").unwrap(), (5, 30));

        store.set_modseq_mark("a", "INBOX", mark).unwrap();
        store.clear_folder("a", "INBOX").unwrap();
        assert_eq!(store.modseq_mark("a", "INBOX").unwrap().modseq, 0, "a new UIDVALIDITY");
    }

    // A large mailbox (#31): what each question costs, and that the answers stay.

    thread_local! {
        static RAN: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    /// The statements `f` ran on the cache, the bodies of triggers aside.
    fn statements<T>(store: &Store, f: impl FnOnce() -> T) -> (T, Vec<String>) {
        use rusqlite::trace::{TraceEvent, TraceEventCodes};
        store.conn().trace_v2(
            TraceEventCodes::SQLITE_TRACE_STMT,
            Some(|e| {
                if let TraceEvent::Stmt(_, sql) = e
                    && !sql.starts_with("--")
                {
                    RAN.with(|r| r.borrow_mut().push(sql.to_owned()));
                }
            }),
        );
        RAN.with(|r| r.borrow_mut().clear());
        let out = f();
        store.conn().trace_v2(TraceEventCodes::empty(), None);
        (out, RAN.with(|r| r.take()))
    }

    /// How SQLite goes through the statements `f` ran: the lines of their query plans.
    fn plans<T>(store: &Store, f: impl FnOnce() -> T) -> Vec<String> {
        let (_, ran) = statements(store, f);
        let conn = store.conn();
        let mut out = Vec::new();
        for sql in ran {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let mut rows = stmt.raw_query();
            while let Some(r) = rows.next().unwrap() {
                out.push(r.get::<_, String>(3).unwrap());
            }
        }
        out
    }

    /// A plan line that reads every message, or every message of a folder by its index.
    fn reads_every_message(line: &str) -> bool {
        ["SCAN m", "SCAN x", "SCAN messages"]
            .iter()
            .any(|scan| line == *scan || line.starts_with(&format!("{scan} ")))
    }

    fn rows_of(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| {
            (0..n)
                .map(|i| r.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}")))
                .collect::<rusqlite::Result<Vec<_>>>()
                .map(|v| v.join(", "))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    }

    /// The tables of step 4 say what counting the messages again would say.
    fn lookups_hold(store: &Store) {
        let conn = store.conn();
        assert_eq!(
            rows_of(
                &conn,
                "SELECT account_id, thread, incoming, latest FROM threads ORDER BY 1, 2"
            ),
            rows_of(
                &conn,
                "SELECT x.account_id, x.thread,
                    MAX(CASE WHEN COALESCE(f.role, '') NOT IN ('trash', 'junk', 'drafts', 'sent') THEN x.date END),
                    MAX(CASE WHEN COALESCE(f.role, '') NOT IN ('trash', 'junk', 'drafts') THEN x.date END)
                 FROM messages x JOIN folders f ON f.account_id = x.account_id AND f.name = x.folder
                 GROUP BY 1, 2 ORDER BY 1, 2"
            ),
            "threads"
        );
        assert_eq!(
            rows_of(&conn, "SELECT email, name, uses FROM addresses ORDER BY 1, 2"),
            rows_of(
                &conn,
                "SELECT email, name, COUNT(*) FROM (
                    SELECT json_extract(from_addr, '$.email') AS email,
                        COALESCE(json_extract(from_addr, '$.name'), '') AS name
                    FROM messages WHERE from_addr IS NOT NULL
                    UNION ALL
                    SELECT json_extract(j.value, '$.email'), COALESCE(json_extract(j.value, '$.name'), '')
                    FROM messages m, json_each(m.to_addrs) j
                 ) GROUP BY 1, 2 ORDER BY 1, 2"
            ),
            "addresses"
        );
        assert_eq!(
            rows_of(&conn, "SELECT parent, message FROM message_refs ORDER BY 1, 2"),
            rows_of(
                &conn,
                "SELECT DISTINCT j.value, m.id FROM messages m, json_each(m.refs) j WHERE j.value != '' ORDER BY 1, 2"
            ),
            "message_refs"
        );
    }

    /// `Store::list` of conversations as it was before #31, for comparing: the newest
    /// letters counted for each conversation of the folder, a query per row for the letters.
    fn old_list(store: &Store, q: &ListQuery) -> Vec<MessageRow> {
        let (cond, mut args) = list_filter(q);
        args.push(i64::from(if q.limit == 0 { 100 } else { q.limit }).into());
        args.push(i64::from(q.offset).into());
        let from = "messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder";
        let unread = pinned(&q.pins, |p| p.unread, "(m.seen = 0)");
        let flagged = pinned(&q.pins, |p| p.flagged, "m.flagged");
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
            "m.id",
        );
        let sql = format!(
            "WITH g AS (
                SELECT m.id AS id, MAX(m.date) AS newest, SUM(m.seen = 0) AS unread, SUM(m.flagged) AS flagged,
                    SUM({unread}) AS s_unread, SUM({flagged}) AS s_flagged, SUM(m.size) AS s_size,
                    SUM(m.has_attachments) AS s_files
                FROM {from} WHERE {cond} GROUP BY m.account_id, m.thread
             )
             SELECT {COLUMNS}, g.unread, g.flagged,
                CASE WHEN COALESCE(mf.role, '') = 'sent' THEN m.date ELSE COALESCE(
                    (SELECT MAX(x.date) FROM messages x
                        JOIN folders xf ON xf.account_id = x.account_id AND xf.name = x.folder
                        WHERE x.account_id = m.account_id AND x.thread = m.thread
                          AND COALESCE(xf.role, '') NOT IN ('trash', 'junk', 'drafts', 'sent')),
                    (SELECT MAX(x.date) FROM messages x
                        JOIN folders xf ON xf.account_id = x.account_id AND xf.name = x.folder
                        WHERE x.account_id = m.account_id AND x.thread = m.thread
                          AND COALESCE(xf.role, '') NOT IN ('trash', 'junk', 'drafts')),
                    m.date) END AS last, g.s_size
             FROM g JOIN messages m ON m.id = g.id
                LEFT JOIN folders mf ON mf.account_id = m.account_id AND mf.name = m.folder
             ORDER BY {order} LIMIT ? OFFSET ?"
        );
        let conn = store.conn();
        let mut stmt = conn.prepare(&sql).unwrap();
        let mut rows: Vec<MessageRow> = stmt
            .query_map(params_from_iter(args), |r| {
                let mut row = message_row(r)?;
                row.flags.seen = r.get::<_, i64>(COLUMN_COUNT)? == 0;
                row.flags.flagged = r.get::<_, i64>(COLUMN_COUNT + 1)? > 0;
                row.thread_date = r.get(COLUMN_COUNT + 2)?;
                row.thread_size = unsigned(r.get(COLUMN_COUNT + 3)?);
                Ok(row)
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut letters = conn
            .prepare(
                "SELECT m.id, m.message_id, m.from_addr, COALESCE(f.role, '') = 'drafts'
                 FROM messages m JOIN folders f ON f.account_id = m.account_id AND f.name = m.folder
                 WHERE m.account_id = ?1 AND m.thread = ?2 AND COALESCE(f.role, '') NOT IN ('trash', 'junk')
                 ORDER BY m.date, m.id",
            )
            .unwrap();
        for row in &mut rows {
            let mut seen = HashSet::new();
            let (mut count, mut draft) = (0, false);
            let mut senders: Vec<Addr> = Vec::new();
            let found: Vec<(i64, Option<String>, Option<String>, bool)> = letters
                .query_map(params![row.account_id, row.thread], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            for (id, mid, from, is_draft) in found {
                if is_draft {
                    draft = true;
                    continue;
                }
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
        rows
    }

    const BUSY_FOLDERS: [(&str, Option<FolderRole>); 8] = [
        ("INBOX", Some(FolderRole::Inbox)),
        ("Sent", Some(FolderRole::Sent)),
        ("Drafts", Some(FolderRole::Drafts)),
        ("Trash", Some(FolderRole::Trash)),
        ("Archive", Some(FolderRole::Archive)),
        ("Junk", Some(FolderRole::Junk)),
        ("Snoozed", None),
        ("Lists", None),
    ];

    /// Conversations of one to six letters spread over every kind of folder, of two
    /// accounts, with letters to oneself, drafts, snoozes and awaited answers. Dates
    /// differ: which letter is the newest is never a draw.
    fn busy_mailbox(conversations: usize) -> Store {
        let store = Store::open_in_memory().unwrap();
        let folders: Vec<Folder> = BUSY_FOLDERS.iter().map(|&(n, r)| folder(n, r)).collect();
        store.replace_folders("a", &folders).unwrap();
        store.replace_folders("b", &folders[..2]).unwrap();
        let mut k = 0usize;
        let mut uid = HashMap::<(&str, &str), u32>::new();
        let mut add = |account: &'static str, folder: &'static str, s: &Summary, k: usize| {
            let next = uid.entry((account, folder)).or_insert(0);
            *next += 1;
            let msg = NewMessage {
                uid: *next,
                summary: s,
                fallback_date: 0,
                size: (k * 13 % 1000) as u32,
                flags: Flags {
                    seen: !k.is_multiple_of(3),
                    flagged: k.is_multiple_of(5),
                    ..Default::default()
                },
                keywords: Vec::new(),
            };
            store.insert_message(account, folder, &msg).unwrap()
        };
        let person = |p: usize| Addr {
            name: Some(["Анна", "Борис", "Ёлкин", "Dana"][p % 4].into()),
            email: format!("p{p}@example.org"),
        };
        for c in 0..conversations {
            let account = if c % 7 == 6 { "b" } else { "a" };
            let mut ids: Vec<String> = Vec::new();
            for j in 0..1 + c % 6 {
                k += 1;
                let folder = match (c + j) % 9 {
                    0 | 2 | 7 => "INBOX",
                    1 | 8 => "Sent",
                    3 => "Archive",
                    4 => "Trash",
                    5 => "Drafts",
                    _ if j.is_multiple_of(2) => "Junk",
                    _ => "Lists",
                };
                let folder = if account == "b" && folder != "Sent" {
                    "INBOX"
                } else {
                    folder
                };
                let id = format!("c{c}.{j}@x");
                let s = Summary {
                    message_id: Some(id.clone()),
                    in_reply_to: ids.last().cloned(),
                    references: ids.clone(),
                    subject: format!("{}Тема {c}", if j > 0 { "Re: " } else { "" }),
                    from: Some(person(c + j)),
                    to: vec![person(c + j + 1), person(c + 2)],
                    date: Some(1_000 + (k * 7919 % 1000) as i64 * 10),
                    has_attachments: k.is_multiple_of(4),
                    bulk: c % 6 == 5,
                    ..Default::default()
                };
                add(account, folder, &s, k);
                // A letter to myself: the same one in Inbox and in Sent.
                if folder == "Sent" && c.is_multiple_of(4) {
                    add(account, "INBOX", &s, k);
                }
                ids.push(id);
            }
            if c.is_multiple_of(5) {
                store
                    .snooze_add(&Snooze {
                        account_id: account.into(),
                        message_id: format!("c{c}.0@x"),
                        folder: "Snoozed".into(),
                        return_to: "INBOX".into(),
                        until: 5_000,
                        subject: String::new(),
                    })
                    .unwrap();
            }
            if c % 3 == 1 {
                store
                    .followup_add(&Followup {
                        account_id: account.into(),
                        message_id: format!("c{c}.1@x"),
                        subject: String::new(),
                        recipients: String::new(),
                        sent: 0,
                        due: 9_000,
                        ..Default::default()
                    })
                    .unwrap();
            }
        }
        store
    }

    #[test]
    fn conversation_lists_are_what_they_were() {
        let store = busy_mailbox(40);
        let ids: Vec<i64> = store
            .list(&ListQuery::default())
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect();
        let base = ListQuery {
            threads: true,
            ..Default::default()
        };
        let mut queries = vec![base.clone()];
        for (name, role) in BUSY_FOLDERS {
            queries.push(ListQuery {
                folder: Some(name.into()),
                ..base.clone()
            });
            queries.push(ListQuery { role, ..base.clone() });
        }
        queries.extend([
            ListQuery {
                account_id: Some("b".into()),
                ..base.clone()
            },
            ListQuery {
                unread_only: true,
                ..base.clone()
            },
            ListQuery {
                flagged_only: true,
                keep_ids: ids[..3].to_vec(),
                ..base.clone()
            },
            ListQuery {
                bulk: Some(true),
                ..base.clone()
            },
            ListQuery {
                bulk: Some(false),
                ..base.clone()
            },
            ListQuery {
                snoozed_only: true,
                ..base.clone()
            },
            ListQuery {
                followups_only: true,
                ..base.clone()
            },
        ]);
        use SortField::*;
        for by in [
            Date,
            Unread,
            Flagged,
            People,
            Sender,
            Subject,
            Size,
            Attachments,
            Relevance,
        ] {
            for desc in [false, true] {
                queries.push(ListQuery {
                    sort: vec![SortKey { by, desc }],
                    ..base.clone()
                });
            }
        }
        queries.push(ListQuery {
            sort: vec![
                SortKey { by: Unread, desc: true },
                SortKey {
                    by: Sender,
                    desc: false,
                },
            ],
            pins: vec![Pin {
                id: ids[1],
                unread: true,
                flagged: true,
            }],
            ..base.clone()
        });
        for offset in 0..12 {
            queries.push(ListQuery {
                limit: 3,
                offset: offset * 3,
                sort: vec![SortKey { by: Size, desc: true }],
                ..base.clone()
            });
        }
        for q in &queries {
            let now = store.list(q).unwrap();
            assert_eq!(now, old_list(&store, q), "{q:?}");
        }
        // The set has what the comparison is about.
        let all = store.list(&base).unwrap();
        assert!(all.iter().any(|r| r.thread_count > 2));
        assert!(all.iter().any(|r| r.thread_draft));
        assert!(all.iter().any(|r| r.thread_date != r.date));
        assert!(all.iter().any(|r| r.thread_senders.len() > 1));
    }

    #[test]
    fn a_conversation_page_is_three_queries_whatever_its_size() {
        let store = busy_mailbox(300);
        let page = |limit| {
            statements(&store, || {
                store
                    .list(&ListQuery {
                        threads: true,
                        limit,
                        ..Default::default()
                    })
                    .unwrap()
                    .len()
            })
        };
        let (small, few) = page(20);
        let (large, many) = page(200);
        assert_eq!((small, large), (20, 200));
        assert_eq!(few.len(), 3, "{few:#?}");
        assert_eq!(many.len(), few.len());
    }

    #[test]
    fn group_actions_take_the_same_queries_for_ten_messages_or_three_hundred() {
        let store = mailbox();
        let mut ids = Vec::new();
        for uid in 1..=300 {
            ids.push(put(&store, "INBOX", uid, &summary("Отчёт", i64::from(uid)), false));
            store.ews_item_add("a", "INBOX", uid, &format!("item{uid}"), 0).unwrap();
        }
        let uids: Vec<u32> = (1..=300).collect();
        let costs = |n: usize, unread: usize| {
            let (changed, flags) = statements(&store, || {
                store
                    .change_flags("a", "INBOX", &uids[..n], FlagChange::Seen(true))
                    .unwrap()
            });
            assert_eq!(changed, unread);
            store.settle_flags("a", "INBOX", &uids[..n]);
            let (rows, read) = statements(&store, || store.get_many_at(&ids[..n]).unwrap());
            assert_eq!(rows.len(), n);
            let (items, found) = statements(&store, || store.ews_item_ids("a", "INBOX", &uids[..n]).unwrap());
            assert_eq!(items.len(), n);
            [flags.len(), read.len(), found.len()]
        };
        assert_eq!(costs(10, 10), [2, 1, 1]);
        assert_eq!(costs(300, 290), [2, 1, 1]);

        // In the order asked, unknown ones skipped.
        let rows = store.get_many_at(&[ids[5], 999_999, ids[2]]).unwrap();
        assert_eq!(rows.iter().map(|(r, _)| r.id).collect::<Vec<_>>(), [ids[5], ids[2]]);
        assert_eq!(
            store.ews_item_ids("a", "INBOX", &[7, 9_999, 3]).unwrap(),
            ["item7", "item3"]
        );
        assert!(store.get_many_at(&[]).unwrap().is_empty());
    }

    #[test]
    fn a_batch_of_headers_is_one_commit_or_nothing() {
        let store = mailbox();
        let mails: Vec<Summary> = (0..200)
            .map(|i| from_to(with_ids("Счёт", 100 + i, &format!("m{i}@x"), None), "ivan@x", "me@x"))
            .collect();
        let batch = |base: u32| -> Vec<NewMessage<'_>> {
            mails
                .iter()
                .enumerate()
                .map(|(i, s)| NewMessage {
                    uid: base + i as u32,
                    summary: s,
                    fallback_date: 0,
                    size: 1,
                    flags: Flags::default(),
                    keywords: Vec::new(),
                })
                .collect()
        };
        let commits = |ran: &[String]| ran.iter().filter(|s| s.trim().eq_ignore_ascii_case("COMMIT")).count();
        let (ids, ran) = statements(&store, || store.insert_messages("a", "INBOX", &batch(1)).unwrap());
        assert_eq!((ids.len(), commits(&ran)), (200, 1));
        let items: Vec<(NewMessage<'_>, String, i64)> = batch(1_001)
            .into_iter()
            .map(|m| {
                let id = format!("item{}", m.uid);
                (m, id, 0)
            })
            .collect();
        let items: Vec<(NewMessage<'_>, &str, i64)> =
            items.iter().map(|(m, id, r)| (m.clone(), id.as_str(), *r)).collect();
        let ((), ran) = statements(&store, || store.ews_insert_items("a", "Sent", &items).unwrap());
        assert_eq!(commits(&ran), 1);
        assert_eq!(
            store.ews_item_ids("a", "Sent", &[1_001, 1_200]).unwrap(),
            ["item1001", "item1200"]
        );

        // A failure half way leaves nothing of the batch: no message without its search row.
        let before = dump(&store);
        store
            .conn()
            .execute_batch(
                "CREATE TEMP TRIGGER fail_half BEFORE INSERT ON messages WHEN new.uid = 2100
                 BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
            )
            .unwrap();
        assert!(store.insert_messages("a", "Trash", &batch(2_001)).is_err());
        assert_eq!(dump(&store), before);
        lookups_hold(&store);
        // The next sync brings it whole.
        store.conn().execute_batch("DROP TRIGGER fail_half").unwrap();
        assert_eq!(store.insert_messages("a", "Trash", &batch(2_001)).unwrap().len(), 200);
        let conn = store.conn();
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM messages WHERE folder = 'Trash'"),
            200
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM messages WHERE id NOT IN (SELECT rowid FROM search)"
            ),
            0
        );
    }

    #[test]
    fn lookups_follow_every_change_of_the_mail() {
        let store = busy_mailbox(60);
        lookups_hold(&store);
        // An answer that came first is joined by its original: conversations merge.
        let mut c = with_ids("Re: План", 300, "late-c@x", None);
        c.in_reply_to = Some("late-b@x".into());
        put(&store, "INBOX", 900, &c, true);
        put(&store, "INBOX", 901, &with_ids("План", 100, "late-a@x", None), true);
        put(
            &store,
            "Sent",
            900,
            &with_ids("Re: План", 200, "late-b@x", Some("late-a@x")),
            true,
        );
        lookups_hold(&store);
        // Letters go, some of them the newest of their conversation, some the last one.
        // As a sync takes them by UID: removals (VANISHED) and changed flags (CHANGEDSINCE).
        store.remove_uids("a", "INBOX", &[1, 2, 3, 900]).unwrap();
        lookups_hold(&store);
        let read = Flags {
            seen: true,
            flagged: true,
            ..Default::default()
        };
        store
            .update_flags("a", "INBOX", &[(4, read), (5, read), (6, read)])
            .unwrap();
        lookups_hold(&store);
        // A folder changes its role.
        let renamed: Vec<Folder> = BUSY_FOLDERS
            .iter()
            .map(|&(n, r)| match n {
                "Archive" => folder(n, Some(FolderRole::Trash)),
                "Junk" => folder(n, None),
                _ => folder(n, r),
            })
            .collect();
        store.replace_folders("a", &renamed).unwrap();
        lookups_hold(&store);
        // A folder cleared, one gone from the server, an account forgotten.
        store.clear_folder("a", "Sent").unwrap();
        lookups_hold(&store);
        store.replace_folders("a", &renamed[..4]).unwrap();
        lookups_hold(&store);
        store.forget_account("b").unwrap();
        lookups_hold(&store);
        // The same headers again change nothing.
        let before = dump(&store);
        put(&store, "INBOX", 901, &with_ids("План", 100, "late-a@x", None), true);
        assert_eq!(dump(&store), before);
        lookups_hold(&store);
    }

    #[test]
    fn frequent_questions_go_by_index_not_through_every_message() {
        let store = busy_mailbox(30);
        store.ews_item_add("a", "INBOX", 1, "item", 0).unwrap();
        let checked: Vec<(&str, Vec<String>)> = vec![
            (
                "offline_progress",
                plans(&store, || store.offline_progress("a", 0, false)),
            ),
            (
                "bodies_missing",
                plans(&store, || store.bodies_missing("a", 0, true, 25)),
            ),
            ("followups_resolve", plans(&store, || store.followups_resolve())),
            ("followups_due", plans(&store, || store.followups_due(1))),
            ("followups_prune", plans(&store, || store.followups_prune(1, 90))),
            (
                "closed followups",
                plans(&store, || {
                    store.list(&ListQuery {
                        followups_only: true,
                        followup_status: FollowupFilter::Closed,
                        ..Default::default()
                    })
                }),
            ),
            ("known_addresses", plans(&store, || store.known_addresses("ан", 8))),
            (
                "change_flags",
                plans(&store, || {
                    store.change_flags("a", "INBOX", &[1, 2], FlagChange::Seen(true))
                }),
            ),
            ("get_many_at", plans(&store, || store.get_many_at(&[1, 2]))),
            ("ews_item_ids", plans(&store, || store.ews_item_ids("a", "INBOX", &[1]))),
            (
                "folder conversations",
                plans(&store, || {
                    store.list(&ListQuery {
                        folder: Some("INBOX".into()),
                        threads: true,
                        ..Default::default()
                    })
                }),
            ),
            (
                "unified conversations",
                plans(&store, || {
                    store.list(&ListQuery {
                        threads: true,
                        ..Default::default()
                    })
                }),
            ),
        ];
        for (name, plan) in checked {
            assert!(!plan.is_empty(), "{name}");
            assert!(!plan.iter().any(|l| reads_every_message(l)), "{name}: {plan:#?}");
        }
        // The conversations of a folder come from the index made for them.
        let plan = plans(&store, || {
            store.list(&ListQuery {
                folder: Some("INBOX".into()),
                threads: true,
                ..Default::default()
            })
        });
        assert!(
            plan.iter()
                .any(|l| l.contains("COVERING INDEX messages_by_folder_thread")),
            "{plan:#?}"
        );
        // Ended waits are forgotten by the index of their end, not by reading every wait.
        let plan = plans(&store, || store.followups_prune(1, 90));
        assert!(plan.iter().any(|l| l.contains("followups_by_end")), "{plan:#?}");
        let plan = plans(&store, || store.offline_progress("a", 0, false));
        assert!(
            plan.iter()
                .any(|l| l.contains("COVERING INDEX messages_by_account_date")),
            "{plan:#?}"
        );
        // Large mail (#16): the biggest first and the totals above a threshold go by size;
        // a year narrower than the sizes may go by date.
        let biggest = [SortKey {
            by: SortField::Size,
            desc: true,
        }];
        for (name, plan) in [
            (
                "largest",
                plans(&store, || store.search("larger:900", None, 300, &biggest)),
            ),
            (
                "large of a year",
                plans(&store, || store.search("larger:900 year:2024", Some("a"), 300, &[])),
            ),
            (
                "large in total",
                plans(&store, || store.search_totals("larger:900 older:1y", None)),
            ),
        ] {
            assert!(!plan.iter().any(|l| reads_every_message(l)), "{name}: {plan:#?}");
            assert!(
                plan.iter()
                    .any(|l| l.starts_with("SEARCH m USING ") && l.contains("INDEX messages_by_")),
                "{name}: {plan:#?}"
            );
        }
        for plan in [
            plans(&store, || store.search("larger:900", None, 300, &biggest)),
            plans(&store, || store.search_totals("larger:900 older:1y", None)),
        ] {
            assert!(
                plan.iter().any(|l| l.contains("INDEX messages_by_size (size>?)")),
                "{plan:#?}"
            );
        }
        let plan = plans(&store, || store.search_totals("larger:900", None));
        assert!(
            plan.iter().any(|l| l.contains("COVERING INDEX messages_by_size")),
            "{plan:#?}"
        );
    }

    #[test]
    fn the_cache_counts_how_long_it_was_held() {
        let store = mailbox();
        store.take_longest_lock();
        assert_eq!(store.take_longest_lock(), Duration::ZERO);
        {
            let _held = store.conn();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(store.take_longest_lock() >= Duration::from_millis(5));
        assert_eq!(store.take_longest_lock(), Duration::ZERO);
    }
}
