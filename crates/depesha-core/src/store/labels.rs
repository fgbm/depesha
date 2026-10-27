//! Labels, folder rights and folder props the cache keeps (#42). A label is the user's
//! own: its name and colour live only in Depesha, the keyword it stores on the server is
//! made from the name (`acl::keyword_of`). Folder props are what a folder's opening or
//! "Check again" learned: MYRIGHTS or Exchange's EffectiveRights, the PERMANENTFLAGS,
//! the owner from NAMESPACE, and the last refusal, remembered so the button stays off.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use super::{Store, add_column, json_list};
use crate::Result;
use crate::acl::{FolderProps, Label, LabelCheck, Namespace, Owner};

/// 12: labels, folder props (rights, permanent flags, owner, remembered refusal),
/// per-message keywords, and the account's namespaces.
pub(super) fn v12_labels_and_rights(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "-- A label the user made: name and colour are Depesha's, the keyword is the server's.
         CREATE TABLE IF NOT EXISTS labels (
             account_id TEXT NOT NULL,
             name       TEXT NOT NULL,
             keyword    TEXT NOT NULL,
             color      TEXT NOT NULL DEFAULT '',
             PRIMARY KEY (account_id, name)
         ) WITHOUT ROWID;

         -- What a folder's opening or check learned; `owner` is from NAMESPACE.
         CREATE TABLE IF NOT EXISTS folder_props (
             account_id       TEXT NOT NULL,
             folder           TEXT NOT NULL,
             display_name     TEXT NOT NULL DEFAULT '',
             owner_kind       TEXT NOT NULL DEFAULT 'mine',
             owner_name       TEXT NOT NULL DEFAULT '',
             rights           TEXT,
             labels_on_server INTEGER,
             permanent        TEXT NOT NULL DEFAULT '[]',
             label_check      TEXT,
             refused          TEXT,
             checked          INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (account_id, folder)
         ) WITHOUT ROWID;

         -- The namespaces the server named, one row per account.
         CREATE TABLE IF NOT EXISTS namespaces (
             account_id TEXT PRIMARY KEY,
             personal   TEXT NOT NULL DEFAULT '[]',
             other_users TEXT NOT NULL DEFAULT '[]',
             shared     TEXT NOT NULL DEFAULT '[]',
             checked    INTEGER NOT NULL DEFAULT 0
         ) WITHOUT ROWID;

         -- A message's own keywords (labels) as the last FETCH reported them.
         ALTER TABLE messages ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';

         -- A read mark kept only here because the server has no right to set it: a folder
         -- read-only without `s`, or a refusal (#42). Syncs do not bring the server's
         -- value back while a row is here; the mark is local, as the design asks.
         CREATE TABLE IF NOT EXISTS local_seen (
             account_id TEXT NOT NULL,
             folder     TEXT NOT NULL,
             uid        INTEGER NOT NULL,
             at         INTEGER NOT NULL,
             PRIMARY KEY (account_id, folder, uid)
         ) WITHOUT ROWID;",
    )?;
    Ok(())
}

/// 15: the first v12 created `folder_props` without `label_check`; a cache an intermediate
/// build or CI numbered 12 lacks the column. Added here only when it is not there, so a
/// fresh cache (whose v12 already has it) changes nothing.
pub(super) fn v15_folder_props_label_check(conn: &Connection) -> Result<()> {
    add_column(conn, "folder_props", "label_check", "TEXT")?;
    Ok(())
}

/// 18: a label being taken off every letter of the mailbox (#42, frame 4Б). The row stays
/// while the server work runs, so the debt survives a restart and a pause and the UI can
/// show "being removed"; the row goes when every folder has been handled.
pub(super) fn v18_label_stripping(conn: &Connection) -> Result<()> {
    add_column(conn, "labels", "stripping", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(())
}

/// 28: a label set here that the folder may not keep on the server: Exchange IMAP answers
/// FLAGS without it, and a sync would wipe it (#112). Goes when the user takes the label off,
/// when the server returns it at least once (then the folder keeps it), or with the letter,
/// the folder's cache or the mailbox.
pub(super) fn v28_local_labels(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_labels (
             account_id TEXT NOT NULL,
             folder     TEXT NOT NULL,
             uid        INTEGER NOT NULL,
             keyword    TEXT NOT NULL,
             PRIMARY KEY (account_id, folder, uid, keyword)
         ) WITHOUT ROWID;",
    )?;
    Ok(())
}

impl Store {
    /// The account's labels, in the user's order (by name).
    pub fn labels(&self, account_id: &str) -> Result<Vec<Label>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT name, keyword, color, stripping FROM labels WHERE account_id = ?1 ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([account_id], |r| {
            Ok(Label {
                name: r.get(0)?,
                keyword: r.get(1)?,
                color: r.get(2)?,
                stripping: r.get::<_, i64>(3)? != 0,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Marks a label as being taken off every letter (or clears the mark). The row stays in
    /// the list meanwhile, so the debt is resumed after a restart or a pause.
    pub fn set_label_stripping(&self, account_id: &str, name: &str, stripping: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE labels SET stripping = ?3 WHERE account_id = ?1 AND name = ?2",
            params![account_id, name, i64::from(stripping)],
        )?;
        Ok(())
    }

    /// The labels whose keyword is still to be taken off the mailbox: name and keyword.
    pub fn stripping_labels(&self, account_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT name, keyword FROM labels WHERE account_id = ?1 AND stripping != 0")?;
        let rows = stmt.query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Adds or renames a label. The keyword goes with the name on the server; a label
    /// whose keyword would change keeps the old one, so old letters stay tagged.
    /// A label being taken off every letter is refused (`LabelStripping`): the strip would
    /// take the keyword off what the new one tags.
    pub fn save_label(&self, account_id: &str, label: &Label) -> Result<()> {
        let changed = self.conn().execute(
            "INSERT INTO labels (account_id, name, keyword, color) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id, name) DO UPDATE SET keyword = excluded.keyword, color = excluded.color
             WHERE stripping = 0",
            params![account_id, label.name, label.keyword, label.color],
        )?;
        if changed == 0 {
            return Err(crate::Error::LabelStripping);
        }
        Ok(())
    }

    /// Whether the label is being taken off every letter just now.
    pub fn label_is_stripping(&self, account_id: &str, name: &str) -> Result<bool> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT 1 FROM labels WHERE account_id = ?1 AND name = ?2 AND stripping != 0")?;
        Ok(stmt.exists(params![account_id, name])?)
    }

    pub fn remove_label(&self, account_id: &str, name: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM labels WHERE account_id = ?1 AND name = ?2",
            params![account_id, name],
        )?;
        Ok(())
    }

    /// The keyword of a label, or `None` when the account has no such label.
    pub fn label_keyword(&self, account_id: &str, name: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT keyword FROM labels WHERE account_id = ?1 AND name = ?2",
                params![account_id, name],
                |r| r.get(0),
            )
            .ok())
    }

    /// The name of another label of the account that already stores this keyword, if any:
    /// a new label then takes a hashed keyword instead of merging with it.
    pub fn keyword_owner(&self, account_id: &str, keyword: &str, except: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT name FROM labels WHERE account_id = ?1 AND keyword = ?2 AND name != ?3",
                params![account_id, keyword, except],
                |r| r.get(0),
            )
            .ok())
    }

    /// A label's displayed name changes, its keyword staying (#42, frame 3): letters keep
    /// the label. A name another label already uses is a conflict (the caller says so).
    pub fn rename_label(&self, account_id: &str, from: &str, to: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE labels SET name = ?3 WHERE account_id = ?1 AND name = ?2",
            params![account_id, from, to],
        )?;
        Ok(())
    }

    /// Rewrites a keyword on every cached message of the account, for a label whose keyword
    /// itself changed — an Exchange category, which is the label's name (#42, frame 7).
    pub fn rename_keyword(&self, account_id: &str, from: &str, to: &str) -> Result<usize> {
        Ok(self.conn().execute(
            "UPDATE messages SET keywords = (
                 SELECT json_group_array(CASE WHEN value = ?2 THEN ?3 ELSE value END)
                 FROM json_each(messages.keywords)
             )
             WHERE account_id = ?1 AND EXISTS (SELECT 1 FROM json_each(messages.keywords) WHERE value = ?2)",
            params![account_id, from, to],
        )?)
    }

    /// The props of one folder: what the card shows.
    pub fn folder_prop(&self, account_id: &str, folder: &str) -> Result<Option<FolderProps>> {
        Ok(folder_prop_of(&self.conn(), account_id, folder))
    }

    /// Everything known about a folder list, by name; the "Folders" subsection reads it.
    pub fn folder_props(&self, account_id: &str) -> Result<Vec<FolderProps>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT display_name, owner_kind, owner_name, rights, labels_on_server, permanent, label_check, refused, checked, folder
             FROM folder_props WHERE account_id = ?1",
        )?;
        let rows = stmt.query_map([account_id], |r| {
            let mut p = row_props(r, account_id)?;
            p.folder = r.get(9)?;
            Ok(p)
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Keeps what a check of `props.folder` learned. `rights` and `labels_on_server` are
    /// left as they were when `None` here: a server without ACL tells nothing, and the
    /// old answer is not "no rights".
    pub fn save_folder_props(&self, account_id: &str, props: &FolderProps) -> Result<()> {
        let permanent = serde_json::to_string(&props.permanent).unwrap_or_else(|_| "[]".into());
        let rights = props.rights.map(|r| r.letters());
        let labels = props.labels_on_server.map(i64::from);
        let (kind, name) = owner_parts(&props.owner);
        self.conn().execute(
            "INSERT INTO folder_props
                (account_id, folder, display_name, owner_kind, owner_name, rights, labels_on_server, permanent, label_check, refused, checked)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT (account_id, folder) DO UPDATE SET
                display_name = excluded.display_name,
                owner_kind = COALESCE(NULLIF(excluded.owner_kind, 'mine'), folder_props.owner_kind),
                owner_name = excluded.owner_name,
                rights = COALESCE(excluded.rights, folder_props.rights),
                labels_on_server = COALESCE(excluded.labels_on_server, folder_props.labels_on_server),
                permanent = excluded.permanent,
                label_check = COALESCE(excluded.label_check, folder_props.label_check),
                refused = excluded.refused,
                checked = excluded.checked",
            params![
                account_id,
                props.folder,
                props.display_name,
                kind,
                name,
                rights,
                labels,
                permanent,
                props.label_check.map(LabelCheck::as_str),
                props.refused,
                props.checked
            ],
        )?;
        Ok(())
    }

    /// Keeps the outcome of a label check on a test message (#42, frame 9); it sets the
    /// "where stored" line of the folder until a new check. A `None` clears it.
    pub fn set_label_check(&self, account_id: &str, folder: &str, check: Option<LabelCheck>, at: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO folder_props (account_id, folder, label_check, checked) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id, folder) DO UPDATE SET label_check = excluded.label_check, checked = excluded.checked",
            params![account_id, folder, check.map(LabelCheck::as_str), at],
        )?;
        Ok(())
    }

    /// Remembers a refusal in this folder (`no-rights`), without touching the rights.
    pub fn refuse_folder(&self, account_id: &str, folder: &str, kind: &str, at: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO folder_props (account_id, folder, refused, checked) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id, folder) DO UPDATE SET refused = excluded.refused",
            params![account_id, folder, kind, at],
        )?;
        Ok(())
    }

    /// A successful action clears the remembered refusal of that folder.
    pub fn clear_refusal(&self, account_id: &str, folder: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE folder_props SET refused = NULL WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
        )?;
        Ok(())
    }

    /// The namespaces the server named, or none.
    pub fn namespaces(&self, account_id: &str) -> Result<Option<(Namespace, i64)>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT personal, other_users, shared, checked FROM namespaces WHERE account_id = ?1",
                [account_id],
                |r| {
                    let parse = |column: &'static str, s: String| {
                        super::json_col_or_default("namespaces", column, account_id, &s)
                    };
                    Ok((
                        Namespace {
                            personal: parse("personal", r.get(0)?),
                            other_users: parse("other_users", r.get(1)?),
                            shared: parse("shared", r.get(2)?),
                        },
                        r.get(3)?,
                    ))
                },
            )
            .ok())
    }

    /// Keeps the namespaces; a successful read replaces the old set.
    pub fn save_namespaces(&self, account_id: &str, ns: &Namespace, at: i64) -> Result<()> {
        let json = |v: &Vec<crate::acl::NamespaceFolder>| serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
        self.conn().execute(
            "INSERT INTO namespaces (account_id, personal, other_users, shared, checked)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (account_id) DO UPDATE SET
                personal = excluded.personal, other_users = excluded.other_users,
                shared = excluded.shared, checked = excluded.checked",
            params![
                account_id,
                json(&ns.personal),
                json(&ns.other_users),
                json(&ns.shared),
                at
            ],
        )?;
        Ok(())
    }

    /// Keeps a message's keywords (labels). Called after a set, and by the sync.
    /// A read mark kept only here: the server has no right to store it (#42). Syncs do
    /// not bring the server's value back while the row is here.
    pub fn set_local_seen(&self, account_id: &str, folder: &str, uids: &[u32], at: i64) -> Result<usize> {
        let conn = self.conn();
        let mut n = 0;
        for &uid in uids {
            n += conn.execute(
                "INSERT OR REPLACE INTO local_seen (account_id, folder, uid, at) VALUES (?1, ?2, ?3, ?4)",
                params![account_id, folder, uid, at],
            )?;
        }
        Ok(n)
    }

    /// Forgets a local read mark: the server's value holds again.
    pub fn clear_local_seen(&self, account_id: &str, folder: &str, uids: &[u32]) -> Result<usize> {
        let conn = self.conn();
        let mut n = 0;
        for &uid in uids {
            n += conn.execute(
                "DELETE FROM local_seen WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                params![account_id, folder, uid],
            )?;
        }
        Ok(n)
    }

    /// Remembers a label set here until the folder is known to keep it (#112): a sync
    /// brings the server's keywords back and would lose it otherwise.
    pub(crate) fn remember_labels(
        &self,
        account_id: &str,
        folder: &str,
        uids: &[u32],
        add: &[String],
        remove: &[String],
    ) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut n = 0;
        {
            let mut insert = tx.prepare_cached(
                "INSERT OR IGNORE INTO local_labels (account_id, folder, uid, keyword) VALUES (?1, ?2, ?3, ?4)",
            )?;
            let mut delete = tx.prepare_cached(
                "DELETE FROM local_labels WHERE account_id = ?1 AND folder = ?2 AND uid = ?3 AND keyword = ?4",
            )?;
            for &uid in uids {
                for kw in add {
                    n += insert.execute(params![account_id, folder, uid, kw])?;
                }
                for kw in remove {
                    n += delete.execute(params![account_id, folder, uid, kw])?;
                }
            }
        }
        tx.commit()?;
        Ok(n)
    }

    /// Moves the labels remembered here (#112) as a letter moves: its rows follow it to the
    /// new UID in `to`, so a folder that keeps no keywords does not lose the label. `pairs` is
    /// old UID → new UID as the move named it; a row already under the new UID is not doubled.
    pub fn move_local_labels(&self, account_id: &str, from: &str, to: &str, pairs: &[(u32, u32)]) -> Result<usize> {
        if pairs.is_empty() {
            return Ok(0);
        }
        let moved_to: HashMap<u32, u32> = pairs.iter().copied().collect();
        let old: Vec<u32> = pairs.iter().map(|(old, _)| *old).collect();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let rows = tx
            .prepare_cached(
                "SELECT uid, keyword FROM local_labels WHERE account_id = ?1 AND folder = ?2
                 AND uid IN (SELECT value FROM json_each(?3))",
            )?
            .query_map(params![account_id, from, json_list(&old)], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<Result<Vec<(u32, String)>, _>>()?;
        let mut moved = 0;
        {
            let mut insert = tx.prepare_cached(
                "INSERT OR IGNORE INTO local_labels (account_id, folder, uid, keyword) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (uid, keyword) in &rows {
                if let Some(new) = moved_to.get(uid) {
                    moved += insert.execute(params![account_id, to, new, keyword])?;
                }
            }
        }
        tx.execute(
            "DELETE FROM local_labels WHERE account_id = ?1 AND folder = ?2 AND uid IN (SELECT value FROM json_each(?3))",
            params![account_id, from, json_list(&old)],
        )?;
        tx.commit()?;
        Ok(moved)
    }

    /// The labels remembered for a folder, by UID.
    pub(crate) fn local_labels(&self, account_id: &str, folder: &str) -> Result<Vec<(u32, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(
            "SELECT uid, keyword FROM local_labels WHERE account_id = ?1 AND folder = ?2 ORDER BY uid, keyword",
        )?;
        let rows = stmt.query_map(params![account_id, folder], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Writes the message's own keywords (labels) into the cache.
    pub fn set_keywords(&self, account_id: &str, folder: &str, uid: u32, keywords: &[String]) -> Result<()> {
        let json = serde_json::to_string(keywords).unwrap_or_else(|_| "[]".into());
        self.conn().execute(
            "UPDATE messages SET keywords = ?4 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
            params![account_id, folder, uid, json],
        )?;
        Ok(())
    }

    /// The own keywords of many messages as one fetch reported them: the sync writes here
    /// for IMAP `FLAGS` and Exchange `Categories`, so a label another client set reaches
    /// the cache, not only the first insert of a letter.
    pub fn update_keywords(&self, account_id: &str, folder: &str, rows: &[(u32, Vec<String>)]) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let changed = merge_keywords(&tx, account_id, folder, rows)?;
        tx.commit()?;
        Ok(changed)
    }

    /// How many cached messages carry each label's keyword, by keyword. The label list
    /// shows it as approximate («≈N»): older mail beyond the sync window is not cached.
    pub fn label_counts(&self, account_id: &str) -> Result<Vec<(String, u32)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT l.keyword, COUNT(m.id)
             FROM labels l
             LEFT JOIN messages m ON m.account_id = l.account_id
                 AND EXISTS (SELECT 1 FROM json_each(m.keywords) WHERE json_each.value = l.keyword)
             WHERE l.account_id = ?1
             GROUP BY l.keyword",
        )?;
        let rows = stmt.query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Takes a keyword off every cached message of the account (#42, frame 4Б), after the
    /// server dropped it. Returns how many rows changed.
    pub fn drop_keyword(&self, account_id: &str, keyword: &str) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE messages SET keywords = (
                 SELECT json_group_array(value) FROM json_each(messages.keywords) WHERE value != ?2
             )
             WHERE account_id = ?1 AND EXISTS (SELECT 1 FROM json_each(messages.keywords) WHERE value = ?2)",
            params![account_id, keyword],
        )?;
        // The label is off every letter for good: a memory of setting it here would put it
        // back on the next sync.
        tx.execute(
            "DELETE FROM local_labels WHERE account_id = ?1 AND keyword = ?2",
            params![account_id, keyword],
        )?;
        tx.commit()?;
        Ok(changed)
    }

    /// Adds and removes keywords on messages here alone, as a label set by the user just
    /// did on the server: the row shows it at once, without waiting for a sync.
    pub fn adjust_keywords(
        &self,
        account_id: &str,
        folder: &str,
        uids: &[u32],
        add: &[String],
        remove: &[String],
    ) -> Result<usize> {
        if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
            return Ok(0);
        }
        let conn = self.conn();
        let mut n = 0;
        for &uid in uids {
            let current: Option<(i64, String)> = conn
                .query_row(
                    "SELECT id, keywords FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                    params![account_id, folder, uid],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((row, current)) = current else { continue };
            // Written back below: keywords that do not parse are left as they are, not replaced.
            let Ok(mut kw) = super::json_col::<Vec<String>>("messages", "keywords", row, &current) else {
                continue;
            };
            kw.retain(|k| !remove.contains(k));
            for a in add {
                if !kw.contains(a) {
                    kw.push(a.clone());
                }
            }
            let json = serde_json::to_string(&kw).unwrap_or_else(|_| "[]".into());
            n += conn.execute(
                "UPDATE messages SET keywords = ?4 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                params![account_id, folder, uid, json],
            )?;
        }
        Ok(n)
    }
}

/// Writes the keywords the server answered for `rows` into the cache, merged with the labels
/// remembered here for the same letters (#112): a letter that arrives by a move carries them
/// (#201). In the caller's transaction, so a batch of headers stays one commit.
pub(super) fn merge_keywords(
    tx: &Connection,
    account_id: &str,
    folder: &str,
    rows: &[(u32, Vec<String>)],
) -> Result<usize> {
    if rows.is_empty() {
        return Ok(0);
    }
    // Only a check on a test message proves the folder keeps a keyword (#42, frame 9):
    // PERMANENTFLAGS promise `\*` on servers that lose the label, and Exchange keeps a
    // keyword only for the session, so its own answer is no proof either (#112).
    let keeps = folder_prop_of(tx, account_id, folder)
        .and_then(|p| p.label_check)
        .is_some_and(LabelCheck::saves);
    let mut local: HashMap<u32, Vec<String>> = HashMap::new();
    // One read of the folder's memory, for the merge or for the drop below.
    let remembered: Vec<(u32, String)> = tx
        .prepare_cached("SELECT uid, keyword FROM local_labels WHERE account_id = ?1 AND folder = ?2")?
        .query_map(params![account_id, folder], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    if !keeps {
        for (uid, keyword) in &remembered {
            local.entry(*uid).or_default().push(keyword.clone());
        }
    }
    let merged: Vec<(u32, Vec<String>)> = rows
        .iter()
        .map(|(uid, keywords)| {
            let mut keywords = keywords.clone();
            for keyword in local.get(uid).into_iter().flatten() {
                if !keywords.contains(keyword) {
                    keywords.push(keyword.clone());
                }
            }
            (*uid, keywords)
        })
        .collect();
    // Each listed UID found by the index, as in `write_flags`.
    let changed = tx
        .prepare_cached(
            "WITH s AS MATERIALIZED (
                SELECT m.id AS id, j.value ->> 1 AS keywords
                FROM json_each(?3) j CROSS JOIN messages m
                    ON m.account_id = ?1 AND m.folder = ?2 AND m.uid = j.value ->> 0
             )
             UPDATE messages SET keywords = s.keywords FROM s
             WHERE messages.id = s.id AND messages.keywords IS NOT s.keywords",
        )?
        .execute(params![account_id, folder, json_list(&merged)])?;
    // The folder keeps keywords: its word is the truth, and the memory of a set here is
    // no longer needed.
    if keeps && !remembered.is_empty() {
        tx.execute(
            "DELETE FROM local_labels WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
        )?;
    }
    Ok(changed)
}

fn row_props(r: &rusqlite::Row<'_>, account_id: &str) -> rusqlite::Result<FolderProps> {
    let rights: Option<String> = r.get(3)?;
    let permanent: String = r.get(5).unwrap_or_else(|_| "[]".into());
    let kind: String = r.get(1)?;
    let name: String = r.get(2)?;
    Ok(FolderProps {
        folder: String::new(),
        display_name: r.get(0)?,
        owner: owner_of(&kind, name),
        rights: rights.map(|s| crate::acl::Rights::from_letters(&s)),
        labels_on_server: r.get::<_, Option<i64>>(4)?.map(|v| v != 0),
        permanent: super::json_col_or_default("folder_props", "permanent", account_id, &permanent),
        label_check: r.get::<_, Option<String>>(6)?.and_then(|s| LabelCheck::parse(&s)),
        refused: r.get(7)?,
        checked: r.get(8)?,
    })
}

/// What a folder's opening or check learned, read from any connection of the cache.
fn folder_prop_of(conn: &Connection, account_id: &str, folder: &str) -> Option<FolderProps> {
    conn.query_row(
        "SELECT display_name, owner_kind, owner_name, rights, labels_on_server, permanent, label_check, refused, checked
         FROM folder_props WHERE account_id = ?1 AND folder = ?2",
        params![account_id, folder],
        |r| row_props(r, account_id),
    )
    .ok()
}

fn owner_of(kind: &str, name: String) -> Owner {
    match kind {
        "shared" => Owner::Shared,
        "other" => Owner::Other(name),
        _ => Owner::Mine,
    }
}

fn owner_parts(owner: &Owner) -> (&'static str, String) {
    match owner {
        Owner::Mine => ("mine", String::new()),
        Owner::Shared => ("shared", String::new()),
        Owner::Other(name) => ("other", name.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::mailbox;
    use super::*;
    use crate::acl::{Rights, keyword_of};

    fn label(name: &str, color: &str) -> Label {
        Label {
            name: name.into(),
            keyword: keyword_of(name),
            color: color.into(),
            stripping: false,
        }
    }

    #[test]
    fn keeps_labels_and_finds_the_keyword() {
        let store = mailbox();
        assert!(store.labels("a").unwrap().is_empty());
        store.save_label("a", &label("Счета", "#d0573f")).unwrap();
        store.save_label("a", &label("Клиент Север", "#3f7fd0")).unwrap();
        let names: Vec<String> = store.labels("a").unwrap().into_iter().map(|l| l.name).collect();
        assert_eq!(names, ["Клиент Север", "Счета"]);
        assert_eq!(store.label_keyword("a", "Счета").unwrap(), Some(keyword_of("Счета")));
        assert_eq!(store.label_keyword("a", "Нет такой").unwrap(), None);
        // Renamed: the colour changes, the name too.
        store.save_label("a", &label("Счета", "#000000")).unwrap();
        assert_eq!(store.labels("a").unwrap()[1].color, "#000000");
        store.remove_label("a", "Счета").unwrap();
        assert_eq!(store.labels("a").unwrap().len(), 1);
        // Another account's labels stay apart.
        store.save_label("b", &label("Личное", "#8a5ad0")).unwrap();
        assert_eq!(store.labels("a").unwrap().len(), 1);
        assert_eq!(store.labels("b").unwrap().len(), 1);
    }

    #[test]
    fn renaming_keeps_the_keyword_on_the_server() {
        let store = mailbox();
        let old = label("Счета", "#d0573f");
        store.save_label("a", &old).unwrap();
        // The name changes; the keyword the letters carry stays.
        store.rename_label("a", "Счета", "Счёты").unwrap();
        let labels = store.labels("a").unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "Счёты");
        assert_eq!(labels[0].keyword, old.keyword);
        assert_eq!(store.label_keyword("a", "Счёты").unwrap(), Some(old.keyword.clone()));
        // An Exchange category is the name: the keyword follows it, and the cache too.
        use super::super::tests::put;
        use crate::store::tests::with_ids;
        let id = put(&store, "INBOX", 1, &with_ids("Письмо", 100, "q@x", None), false);
        store
            .set_keywords("a", "INBOX", 1, std::slice::from_ref(&old.keyword))
            .unwrap();
        store.rename_keyword("a", &old.keyword, "Счета-новая").unwrap();
        assert_eq!(store.get(id).unwrap().unwrap().keywords, ["Счета-новая"]);
    }

    #[test]
    fn a_label_being_taken_off_is_marked_and_remembered() {
        let store = mailbox();
        store.save_label("a", &label("Счета", "#d0573f")).unwrap();
        assert!(store.stripping_labels("a").unwrap().is_empty());
        // Marked: the row stays in the list, and the debt is listed for resumption.
        store.set_label_stripping("a", "Счета", true).unwrap();
        let listed = store.labels("a").unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].stripping, "the row is marked as being removed");
        assert_eq!(
            store.stripping_labels("a").unwrap(),
            [("Счета".to_owned(), keyword_of("Счета"))]
        );
        // Made anew meanwhile: refused, so the strip does not take the new label's keyword off.
        assert!(store.label_is_stripping("a", "Счета").unwrap());
        assert!(matches!(
            store.save_label("a", &label("Счета", "#000000")),
            Err(crate::Error::LabelStripping)
        ));
        assert_eq!(store.labels("a").unwrap()[0].color, "#d0573f", "the row is untouched");
        // The work done, the label is gone for good.
        store.remove_label("a", "Счета").unwrap();
        assert!(store.stripping_labels("a").unwrap().is_empty());
    }

    #[test]
    fn counts_letters_and_drops_a_keyword_in_the_cache() {
        use super::super::tests::put;
        use crate::store::tests::with_ids;
        let store = mailbox();
        let a = put(&store, "INBOX", 1, &with_ids("Раз", 100, "q@x", None), false);
        let b = put(&store, "INBOX", 2, &with_ids("Два", 200, "q@x", None), false);
        let kw = keyword_of("Счета");
        store.save_label("a", &label("Счета", "#d0573f")).unwrap();
        store.set_keywords("a", "INBOX", 1, std::slice::from_ref(&kw)).unwrap();
        store.set_keywords("a", "INBOX", 2, std::slice::from_ref(&kw)).unwrap();
        assert_eq!(store.label_counts("a").unwrap(), [(kw.clone(), 2)]);
        // The keyword goes off every cached letter at once (#42, frame 4Б).
        assert_eq!(store.drop_keyword("a", &kw).unwrap(), 2);
        assert_eq!(store.label_counts("a").unwrap(), [(kw.clone(), 0)]);
        assert!(store.get(a).unwrap().unwrap().keywords.is_empty());
        assert!(store.get(b).unwrap().unwrap().keywords.is_empty());
    }

    #[test]
    fn a_keyword_with_a_quote_is_matched_as_a_json_value() {
        use super::super::tests::put;
        use crate::store::tests::with_ids;
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Раз", 100, "q@x", None), false);
        // A category name an Exchange user may type: it holds `"` and `\`, which the JSON
        // array escapes. A quoted-substring search would miss it; `json_each` does not.
        let kw = "Отдел \"Продаж\"\\Север".to_owned();
        store
            .save_label(
                "a",
                &Label {
                    name: "Странная".into(),
                    keyword: kw.clone(),
                    color: String::new(),
                    stripping: false,
                },
            )
            .unwrap();
        store.set_keywords("a", "INBOX", 1, std::slice::from_ref(&kw)).unwrap();
        assert_eq!(store.label_counts("a").unwrap(), [(kw.clone(), 1)]);
        // Renaming it rewrites the value, not a quoted substring.
        assert_eq!(store.rename_keyword("a", &kw, "Новая").unwrap(), 1);
        assert_eq!(store.get(id).unwrap().unwrap().keywords, ["Новая"]);
        // And dropping it clears the value.
        store.set_keywords("a", "INBOX", 1, std::slice::from_ref(&kw)).unwrap();
        assert_eq!(store.drop_keyword("a", &kw).unwrap(), 1);
        assert!(store.get(id).unwrap().unwrap().keywords.is_empty());
    }

    #[test]
    fn keeps_folder_props_and_remembers_a_refusal() {
        let store = mailbox();
        assert!(store.folder_prop("a", "INBOX").unwrap().is_none());

        let shared = FolderProps {
            folder: "shared/Бухгалтерия".into(),
            display_name: "shared/Бухгалтерия".into(),
            owner: Owner::Shared,
            rights: Some(Rights::from_letters("rs")),
            labels_on_server: Some(false),
            permanent: vec!["Seen".into()],
            label_check: None,
            refused: None,
            checked: 100,
        };
        store.save_folder_props("a", &shared).unwrap();
        let got = store.folder_prop("a", "shared/Бухгалтерия").unwrap().unwrap();
        assert_eq!(got.owner, Owner::Shared);
        assert_eq!(got.rights.map(|r| r.letters()), Some("rs".into()));
        assert_eq!(got.labels_on_server, Some(false));
        assert!(got.read_only());
        assert_eq!(got.checked, 100);

        // A later check that could not read MYRIGHTS keeps the old rights, does not wipe them.
        let bare = FolderProps {
            folder: "shared/Бухгалтерия".into(),
            display_name: "shared/Бухгалтерия".into(),
            owner: Owner::Mine,
            rights: None,
            labels_on_server: None,
            permanent: vec![],
            label_check: None,
            refused: None,
            checked: 200,
        };
        store.save_folder_props("a", &bare).unwrap();
        let got = store.folder_prop("a", "shared/Бухгалтерия").unwrap().unwrap();
        assert_eq!(got.rights.map(|r| r.letters()), Some("rs".into()), "rights kept");
        assert_eq!(got.owner, Owner::Shared, "owner kept");
        assert_eq!(got.checked, 200);

        // A refusal is remembered and can be cleared.
        store.refuse_folder("a", "Отдел продаж", "no-rights", 300).unwrap();
        assert_eq!(
            store
                .folder_prop("a", "Отдел продаж")
                .unwrap()
                .unwrap()
                .refused
                .as_deref(),
            Some("no-rights")
        );
        store.clear_refusal("a", "Отдел продаж").unwrap();
        assert!(
            store
                .folder_prop("a", "Отдел продаж")
                .unwrap()
                .unwrap()
                .refused
                .is_none()
        );
    }

    #[test]
    fn keeps_the_outcome_of_a_label_check() {
        use crate::acl::LabelCheck;
        let store = mailbox();
        assert!(store.folder_prop("a", "INBOX").unwrap().is_none());
        // A run that ended well: the labels are kept on the server.
        store
            .set_label_check("a", "INBOX", Some(LabelCheck::Saves), 100)
            .unwrap();
        let got = store.folder_prop("a", "INBOX").unwrap().unwrap();
        assert_eq!(got.label_check, Some(LabelCheck::Saves));
        assert_eq!(got.checked, 100);
        // A later check replaces it: the server claimed support but lost the label.
        store
            .set_label_check("a", "INBOX", Some(LabelCheck::ClaimedButLost), 200)
            .unwrap();
        assert_eq!(
            store.folder_prop("a", "INBOX").unwrap().unwrap().label_check,
            Some(LabelCheck::ClaimedButLost)
        );
        // A properties read does not wipe the outcome.
        store
            .save_folder_props(
                "a",
                &FolderProps {
                    folder: "INBOX".into(),
                    display_name: "INBOX".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            store.folder_prop("a", "INBOX").unwrap().unwrap().label_check,
            Some(LabelCheck::ClaimedButLost)
        );
        // Cleared by a `None`, so the "where stored" line goes back to "not confirmed".
        store.set_label_check("a", "INBOX", None, 300).unwrap();
        assert!(store.folder_prop("a", "INBOX").unwrap().unwrap().label_check.is_none());
        // Forgetting the mailbox takes it away.
        store
            .set_label_check("a", "INBOX", Some(LabelCheck::NotSaves), 400)
            .unwrap();
        store.forget_account("a").unwrap();
        assert!(store.folder_prop("a", "INBOX").unwrap().is_none());
    }

    #[test]
    fn keeps_a_read_mark_local_and_syncs_do_not_unread_it() {
        use super::super::tests::put;
        use crate::store::tests::with_ids;
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Письмо", 100, "q@x", None), false);
        assert!(!store.get(id).unwrap().unwrap().flags.seen);

        // Marked read for this device alone: a sync reporting it unread does not undo it.
        store.set_local_seen("a", "INBOX", &[1], 500).unwrap();
        store
            .update_flags(
                "a",
                "INBOX",
                &[(
                    1,
                    crate::domain::Flags {
                        seen: false,
                        ..Default::default()
                    },
                )],
            )
            .unwrap();
        assert!(store.get(id).unwrap().unwrap().flags.seen);

        // Forgetting it lets the server's value hold again.
        store.clear_local_seen("a", "INBOX", &[1]).unwrap();
        store
            .update_flags(
                "a",
                "INBOX",
                &[(
                    1,
                    crate::domain::Flags {
                        seen: false,
                        ..Default::default()
                    },
                )],
            )
            .unwrap();
        assert!(!store.get(id).unwrap().unwrap().flags.seen);

        // Forgetting the mailbox takes the local marks too.
        store.set_local_seen("a", "INBOX", &[1], 600).unwrap();
        store.forget_account("a").unwrap();
        let left: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM local_seen", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    /// A label Exchange IMAP took but answers FLAGS without (#112): remembered here, so
    /// neither the next sync nor the one after it loses it.
    #[test]
    fn a_label_set_here_survives_a_sync_that_reports_none() {
        use super::super::tests::put;
        use crate::store::tests::with_ids;
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Письмо", 100, "q@x", None), false);
        let kw = keyword_of("Счета");
        store
            .remember_labels("a", "INBOX", &[1], std::slice::from_ref(&kw), &[])
            .unwrap();
        store
            .adjust_keywords("a", "INBOX", &[1], std::slice::from_ref(&kw), &[])
            .unwrap();
        assert_eq!(store.get(id).unwrap().unwrap().keywords, std::slice::from_ref(&kw));

        for _ in 0..2 {
            store.update_keywords("a", "INBOX", &[(1, Vec::new())]).unwrap();
            assert_eq!(store.get(id).unwrap().unwrap().keywords, std::slice::from_ref(&kw));
        }
        assert_eq!(store.local_labels("a", "INBOX").unwrap(), [(1, kw)]);
    }

    /// A letter that arrives in a folder by a move carries the label remembered here (#201):
    /// the server's keywords of a new row are merged with the memory, as a flags pass does, or
    /// the list shows the letter without the label the user gave it.
    #[test]
    fn a_letter_arriving_by_a_move_gets_the_label_it_carried() {
        use super::super::tests::put;
        use crate::store::tests::with_ids;
        let store = mailbox();
        let invoices = keyword_of("Счета");
        store
            .remember_labels("a", "INBOX", &[1], std::slice::from_ref(&invoices), &[])
            .unwrap();
        store.move_local_labels("a", "INBOX", "Trash", &[(1, 7)]).unwrap();

        let id = put(&store, "Trash", 7, &with_ids("Письмо", 100, "q@x", None), false);
        assert_eq!(store.get(id).unwrap().unwrap().keywords, [invoices]);
    }

    /// A label the user took off here is not put back by the sync that follows.
    #[test]
    fn a_label_taken_off_here_does_not_come_back() {
        use super::super::tests::put;
        use crate::store::tests::with_ids;
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Письмо", 100, "q@x", None), false);
        let kw = keyword_of("Счета");
        store
            .remember_labels("a", "INBOX", &[1], std::slice::from_ref(&kw), &[])
            .unwrap();
        store
            .adjust_keywords("a", "INBOX", &[1], std::slice::from_ref(&kw), &[])
            .unwrap();

        // Off here, and the server answers without it: it stays off.
        store
            .remember_labels("a", "INBOX", &[1], &[], std::slice::from_ref(&kw))
            .unwrap();
        store
            .adjust_keywords("a", "INBOX", &[1], &[], std::slice::from_ref(&kw))
            .unwrap();
        store.update_keywords("a", "INBOX", &[(1, Vec::new())]).unwrap();
        assert!(store.get(id).unwrap().unwrap().keywords.is_empty());
        assert!(store.local_labels("a", "INBOX").unwrap().is_empty());
    }

    /// A folder whose test message kept its label is trusted: the server's keywords are
    /// the truth, and a label another client took off goes away here as well.
    #[test]
    fn a_folder_proven_to_keep_labels_trusts_the_server() {
        use super::super::tests::put;
        use crate::acl::LabelCheck;
        use crate::store::tests::with_ids;
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Письмо", 100, "q@x", None), false);
        let kw = keyword_of("Счета");
        store
            .set_label_check("a", "INBOX", Some(LabelCheck::Saves), 100)
            .unwrap();
        store
            .remember_labels("a", "INBOX", &[1], std::slice::from_ref(&kw), &[])
            .unwrap();
        store
            .adjust_keywords("a", "INBOX", &[1], std::slice::from_ref(&kw), &[])
            .unwrap();

        // Set in this folder before the check, taken off in another client: the server wins.
        store.update_keywords("a", "INBOX", &[(1, Vec::new())]).unwrap();
        assert!(store.get(id).unwrap().unwrap().keywords.is_empty());
        assert!(
            store.local_labels("a", "INBOX").unwrap().is_empty(),
            "the memory goes with the proof"
        );
    }

    /// A keyword the server returned once may live only for the session (#112): the memory is
    /// kept until the user takes the label off, so the next answer without it loses nothing.
    #[test]
    fn a_label_the_server_confirmed_once_is_still_kept_here() {
        use super::super::tests::put;
        use crate::store::tests::with_ids;
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Письмо", 100, "q@x", None), false);
        let kw = keyword_of("Счета");
        store
            .remember_labels("a", "INBOX", &[1], std::slice::from_ref(&kw), &[])
            .unwrap();
        store
            .adjust_keywords("a", "INBOX", &[1], std::slice::from_ref(&kw), &[])
            .unwrap();

        // The session still has it: not a proof that the folder keeps keywords.
        let confirmed = vec![kw.clone()];
        store.update_keywords("a", "INBOX", &[(1, confirmed)]).unwrap();
        assert_eq!(store.get(id).unwrap().unwrap().keywords, std::slice::from_ref(&kw));
        assert_eq!(
            store.local_labels("a", "INBOX").unwrap(),
            [(1, kw.clone())],
            "the server may lose it with the session"
        );

        // Another SELECT or a reconnect answers without it: the label stays.
        store.update_keywords("a", "INBOX", &[(1, Vec::new())]).unwrap();
        assert_eq!(store.get(id).unwrap().unwrap().keywords, [kw]);
    }

    /// A moved letter keeps the labels remembered here (#112, #201): the rows follow it to its
    /// new UID, the folder it left keeps none of them, and a row already under the new UID is
    /// not doubled.
    #[test]
    fn moved_letters_keep_their_remembered_labels() {
        let store = mailbox();
        let invoices = keyword_of("Счета");
        let work = keyword_of("Работа");
        store
            .remember_labels("a", "INBOX", &[1], &[invoices.clone(), work.clone()], &[])
            .unwrap();
        store
            .remember_labels("a", "INBOX", &[2], std::slice::from_ref(&invoices), &[])
            .unwrap();
        // The letter at 7 was labelled in Trash before: its row is there already.
        store
            .remember_labels("a", "Trash", &[7], std::slice::from_ref(&invoices), &[])
            .unwrap();

        assert_eq!(
            store
                .move_local_labels("a", "INBOX", "Trash", &[(1, 7), (2, 8)])
                .unwrap(),
            2,
            "two rows are new; the third was in Trash already"
        );

        assert!(
            store.local_labels("a", "INBOX").unwrap().is_empty(),
            "nothing stays under the folder the letters left"
        );
        let mut moved = store.local_labels("a", "Trash").unwrap();
        moved.sort();
        let mut expected = vec![(7, work), (7, invoices.clone()), (8, invoices)];
        expected.sort();
        assert_eq!(moved, expected);
    }

    /// A label taken off every letter is gone for good, the local memory with it.
    #[test]
    fn dropping_a_keyword_forgets_the_labels_remembered_here() {
        let store = mailbox();
        let kw = keyword_of("Счета");
        store
            .remember_labels("a", "INBOX", &[1, 2], std::slice::from_ref(&kw), &[])
            .unwrap();
        store.drop_keyword("a", &kw).unwrap();
        assert!(store.local_labels("a", "INBOX").unwrap().is_empty());
    }

    /// A letter removed from the cache takes its remembered labels with it.
    #[test]
    fn removing_letters_forgets_their_remembered_labels() {
        let store = mailbox();
        let kw = keyword_of("Счета");
        store
            .remember_labels("a", "INBOX", &[1, 2], std::slice::from_ref(&kw), &[])
            .unwrap();
        store.remove_uids("a", "INBOX", &[1]).unwrap();
        assert_eq!(store.local_labels("a", "INBOX").unwrap(), [(2, kw)]);
    }

    /// A new UIDVALIDITY renumbers the folder: the UIDs the local read marks were kept
    /// under name other messages now, so the marks must go with the messages.
    #[test]
    fn clearing_a_folder_forgets_its_local_read_marks() {
        use super::super::tests::{put, with_ids};
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &with_ids("Письмо", 100, "q@x", None), false);
        store.set_local_seen("a", "INBOX", &[1], 500).unwrap();

        store.clear_folder("a", "INBOX").unwrap();
        assert!(store.get(id).unwrap().is_none());
        let left: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM local_seen", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    /// The same for a label remembered here (#112): the new letters under those UIDs were
    /// never labelled.
    #[test]
    fn clearing_a_folder_forgets_its_remembered_labels() {
        let store = mailbox();
        store
            .remember_labels("a", "INBOX", &[1], &[keyword_of("Счета")], &[])
            .unwrap();
        store.clear_folder("a", "INBOX").unwrap();
        assert!(store.local_labels("a", "INBOX").unwrap().is_empty());
    }

    #[test]
    fn keeps_namespaces_and_forgets_them_with_the_account() {
        let store = mailbox();
        assert!(store.namespaces("a").unwrap().is_none());
        let ns = Namespace::parse(r#"(("" "/")) (("Other Users/" "/")) (("shared/" "/"))"#);
        store.save_namespaces("a", &ns, 100).unwrap();
        let (kept, at) = store.namespaces("a").unwrap().unwrap();
        assert_eq!(at, 100);
        assert_eq!(kept.shared[0].prefix, "shared/");
        store.forget_account("a").unwrap();
        assert!(store.namespaces("a").unwrap().is_none());
        assert!(store.labels("a").unwrap().is_empty());
        assert!(store.folder_prop("a", "shared/Бухгалтерия").unwrap().is_none());
    }
}
