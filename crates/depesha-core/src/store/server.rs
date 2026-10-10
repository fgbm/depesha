//! What the cache keeps about an account's server, so the settings show it without a
//! network: the capabilities it listed and when, its answer to ENABLE, the quota it
//! reported last, and the folder sizes the user had counted.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::Store;
use crate::Result;
use crate::imap::Enabled;
use crate::quota::{FolderSize, Quota, SizeMethod};

/// 8: the server's capabilities, quota and folder sizes, one row per account (and folder).
pub(super) fn v8_server_caps(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "-- The CAPABILITY list after login (space-separated) and the greeting's, with the
         -- time of the login; the answer to ENABLE QRESYNC once one was given.
         CREATE TABLE IF NOT EXISTS server_caps (
             account_id    TEXT PRIMARY KEY,
             greeting      TEXT NOT NULL DEFAULT '',
             capabilities  TEXT NOT NULL DEFAULT '',
             detected      INTEGER NOT NULL DEFAULT 0,
             enable_ok     INTEGER,
             enable_answer TEXT NOT NULL DEFAULT '',
             enable_at     INTEGER NOT NULL DEFAULT 0
         ) WITHOUT ROWID;

         -- The last quota the server reported, in bytes; limit 0: no storage limit.
         CREATE TABLE IF NOT EXISTS quotas (
             account_id     TEXT PRIMARY KEY,
             root           TEXT NOT NULL,
             used           INTEGER NOT NULL,
             quota_limit    INTEGER NOT NULL,
             messages       INTEGER,
             messages_limit INTEGER,
             checked        INTEGER NOT NULL
         ) WITHOUT ROWID;

         -- Folder sizes as the user last had them counted; error: the folder was left out.
         CREATE TABLE IF NOT EXISTS folder_sizes (
             account_id TEXT NOT NULL,
             folder     TEXT NOT NULL,
             bytes      INTEGER,
             messages   INTEGER,
             error      TEXT,
             counted    INTEGER NOT NULL,
             method     TEXT NOT NULL,
             PRIMARY KEY (account_id, folder)
         ) WITHOUT ROWID;",
    )?;
    Ok(())
}

/// The capabilities of a login, as the cache keeps them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ServerCaps {
    /// The greeting's line when it listed capabilities before login; empty otherwise.
    pub greeting: String,
    pub capabilities: Vec<String>,
    /// When they were read, Unix time.
    pub detected: i64,
}

/// The answer to ENABLE QRESYNC and when it came.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct EnableAnswer {
    pub ok: bool,
    pub answer: String,
    pub at: i64,
}

/// The last quota the server reported and when.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct QuotaSeen {
    #[serde(flatten)]
    pub quota: Quota,
    pub checked: i64,
}

/// Folder sizes counted at the user's request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct FolderSizes {
    pub counted: i64,
    pub method: SizeMethod,
    pub folders: Vec<FolderSize>,
}

/// Everything the cache knows about an account's server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ServerInfo {
    pub caps: Option<ServerCaps>,
    pub enable: Option<EnableAnswer>,
    pub quota: Option<QuotaSeen>,
    pub sizes: Option<FolderSizes>,
}

impl Store {
    /// Keeps what a login found. Returns whether the list differs from the one kept.
    pub fn save_server_caps(&self, account_id: &str, caps: &ServerCaps) -> Result<bool> {
        let conn = self.conn();
        let list = caps.capabilities.join(" ");
        let before: Option<(String, String)> = conn
            .query_row(
                "SELECT capabilities, greeting FROM server_caps WHERE account_id = ?1",
                [account_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        conn.execute(
            "INSERT INTO server_caps (account_id, greeting, capabilities, detected) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id) DO UPDATE SET
                 greeting = excluded.greeting, capabilities = excluded.capabilities, detected = excluded.detected",
            params![account_id, caps.greeting, list, caps.detected],
        )?;
        Ok(before.is_none_or(|(l, g)| l != list || g != caps.greeting))
    }

    /// Keeps the answer to ENABLE; it stays until the next one.
    pub fn save_server_enable(&self, account_id: &str, enabled: &Enabled, at: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO server_caps (account_id, enable_ok, enable_answer, enable_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id) DO UPDATE SET
                 enable_ok = excluded.enable_ok, enable_answer = excluded.enable_answer, enable_at = excluded.enable_at",
            params![account_id, enabled.ok, enabled.answer, at],
        )?;
        Ok(())
    }

    /// Keeps the quota just read, or forgets it when the server reports none. Returns
    /// whether the numbers changed.
    pub fn save_quota(&self, account_id: &str, quota: Option<&Quota>, checked: i64) -> Result<bool> {
        let before = self.quota(account_id)?.map(|q| q.quota);
        let conn = self.conn();
        match quota {
            Some(q) => {
                conn.execute(
                    "INSERT OR REPLACE INTO quotas
                         (account_id, root, used, quota_limit, messages, messages_limit, checked)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        account_id,
                        q.root,
                        q.used as i64,
                        q.limit as i64,
                        q.messages.map(|m| m.0 as i64),
                        q.messages.map(|m| m.1 as i64),
                        checked
                    ],
                )?;
            }
            None => {
                conn.execute("DELETE FROM quotas WHERE account_id = ?1", [account_id])?;
            }
        }
        Ok(before.as_ref() != quota)
    }

    pub fn quota(&self, account_id: &str) -> Result<Option<QuotaSeen>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT root, used, quota_limit, messages, messages_limit, checked FROM quotas WHERE account_id = ?1",
                [account_id],
                |r| {
                    let messages: Option<i64> = r.get(3)?;
                    let messages_limit: Option<i64> = r.get(4)?;
                    Ok(QuotaSeen {
                        quota: Quota {
                            root: r.get(0)?,
                            used: r.get::<_, i64>(1)? as u64,
                            limit: r.get::<_, i64>(2)? as u64,
                            messages: messages.zip(messages_limit).map(|(n, l)| (n as u64, l as u64)),
                        },
                        checked: r.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// Replaces the folder sizes of the account with a new count.
    pub fn save_folder_sizes(&self, account_id: &str, sizes: &FolderSizes) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM folder_sizes WHERE account_id = ?1", [account_id])?;
        {
            let mut insert = tx.prepare(
                "INSERT OR REPLACE INTO folder_sizes (account_id, folder, bytes, messages, error, counted, method)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for f in &sizes.folders {
                insert.execute(params![
                    account_id,
                    f.folder,
                    f.bytes.map(|b| b as i64),
                    f.messages.map(|n| n as i64),
                    f.error,
                    sizes.counted,
                    sizes.method.as_str()
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn folder_sizes(&self, account_id: &str) -> Result<Option<FolderSizes>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT folder, bytes, messages, error, counted, method FROM folder_sizes
             WHERE account_id = ?1 ORDER BY bytes DESC, folder",
        )?;
        let mut sizes: Option<FolderSizes> = None;
        let rows = stmt.query_map([account_id], |r| {
            Ok((
                FolderSize {
                    folder: r.get(0)?,
                    bytes: r.get::<_, Option<i64>>(1)?.map(|b| b as u64),
                    messages: r.get::<_, Option<i64>>(2)?.map(|n| n as u64),
                    error: r.get(3)?,
                },
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            let (folder, counted, method) = row?;
            sizes
                .get_or_insert_with(|| FolderSizes {
                    counted,
                    method: SizeMethod::parse(&method),
                    folders: Vec::new(),
                })
                .folders
                .push(folder);
        }
        Ok(sizes)
    }

    /// What the cache knows about the account's server.
    pub fn server_info(&self, account_id: &str) -> Result<ServerInfo> {
        let row = self
            .conn()
            .query_row(
                "SELECT greeting, capabilities, detected, enable_ok, enable_answer, enable_at
                 FROM server_caps WHERE account_id = ?1",
                [account_id],
                |r| {
                    let detected: i64 = r.get(2)?;
                    let list: String = r.get(1)?;
                    let caps = (detected > 0).then(|| ServerCaps {
                        greeting: r.get(0).unwrap_or_default(),
                        capabilities: list.split_whitespace().map(str::to_owned).collect(),
                        detected,
                    });
                    let enable = r.get::<_, Option<bool>>(3)?.map(|ok| EnableAnswer {
                        ok,
                        answer: r.get(4).unwrap_or_default(),
                        at: r.get(5).unwrap_or_default(),
                    });
                    Ok((caps, enable))
                },
            )
            .optional()?;
        let (caps, enable) = row.unwrap_or_default();
        Ok(ServerInfo {
            caps,
            enable,
            quota: self.quota(account_id)?,
            sizes: self.folder_sizes(account_id)?,
        })
    }

    /// Bytes of the account's mail kept whole on this computer.
    pub fn cache_bytes(&self, account_id: &str) -> Result<u64> {
        let bytes: i64 = self.conn().query_row(
            "SELECT COALESCE(SUM(length(b.raw)), 0) FROM messages m JOIN bodies b ON b.message_id = m.id
             WHERE m.account_id = ?1",
            [account_id],
            |r| r.get(0),
        )?;
        Ok(bytes as u64)
    }

    /// Drops what the cache knows about a removed account's server.
    pub(super) fn forget_server(conn: &Connection, account_id: &str) -> Result<()> {
        for table in ["server_caps", "quotas", "folder_sizes"] {
            conn.execute(&format!("DELETE FROM {table} WHERE account_id = ?1"), [account_id])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(store: &Store, sql: &str) -> Vec<String> {
        let conn = store.conn();
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let mut rows = stmt.raw_query();
        let mut out = Vec::new();
        while let Some(r) = rows.next().unwrap() {
            out.push(r.get::<_, String>(3).unwrap());
        }
        out
    }

    #[test]
    fn keeps_the_server_for_offline_reading() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.server_info("a").unwrap(), ServerInfo::default());

        let caps = ServerCaps {
            greeting: "* OK [CAPABILITY IMAP4rev1 IDLE] ready".into(),
            capabilities: vec!["IMAP4rev1".into(), "IDLE".into(), "QUOTA".into()],
            detected: 100,
        };
        assert!(store.save_server_caps("a", &caps).unwrap());
        // The same list again: nothing to tell the windows.
        assert!(
            !store
                .save_server_caps(
                    "a",
                    &ServerCaps {
                        detected: 200,
                        ..caps.clone()
                    }
                )
                .unwrap()
        );
        store
            .save_server_enable(
                "a",
                &Enabled {
                    ok: false,
                    answer: "ENABLE not permitted".into(),
                },
                150,
            )
            .unwrap();
        let quota = Quota {
            root: "User quota".into(),
            used: 3 << 30,
            limit: 10 << 30,
            messages: None,
        };
        assert!(store.save_quota("a", Some(&quota), 300).unwrap());
        assert!(!store.save_quota("a", Some(&quota), 400).unwrap());
        store
            .save_folder_sizes(
                "a",
                &FolderSizes {
                    counted: 500,
                    method: SizeMethod::Status,
                    folders: vec![
                        FolderSize {
                            folder: "INBOX".into(),
                            bytes: Some(10),
                            messages: Some(1),
                            error: None,
                        },
                        FolderSize {
                            folder: "Shared".into(),
                            bytes: None,
                            messages: None,
                            error: Some("no rights".into()),
                        },
                        FolderSize {
                            folder: "Archive".into(),
                            bytes: Some(90),
                            messages: Some(3),
                            error: None,
                        },
                    ],
                },
            )
            .unwrap();

        let info = store.server_info("a").unwrap();
        let kept = info.caps.unwrap();
        assert_eq!(kept.capabilities, caps.capabilities);
        assert_eq!((kept.greeting.as_str(), kept.detected), (caps.greeting.as_str(), 200));
        assert_eq!(
            info.enable,
            Some(EnableAnswer {
                ok: false,
                answer: "ENABLE not permitted".into(),
                at: 150
            })
        );
        assert_eq!(info.quota, Some(QuotaSeen { quota, checked: 400 }));
        let sizes = info.sizes.unwrap();
        assert_eq!((sizes.counted, sizes.method), (500, SizeMethod::Status));
        // The largest first; the folder left out keeps its reason and no size.
        let names: Vec<_> = sizes.folders.iter().map(|f| f.folder.as_str()).collect();
        assert_eq!(names, ["Archive", "INBOX", "Shared"]);
        assert_eq!(sizes.folders[2].error.as_deref(), Some("no rights"));

        // A server that stops reporting the quota: no old number shown as current.
        assert!(store.save_quota("a", None, 600).unwrap());
        assert_eq!(store.quota("a").unwrap(), None);

        store.forget_account("a").unwrap();
        assert_eq!(store.server_info("a").unwrap(), ServerInfo::default());
    }

    #[test]
    fn looks_up_by_account_without_reading_every_row() {
        let store = Store::open_in_memory().unwrap();
        for sql in [
            "SELECT capabilities FROM server_caps WHERE account_id = 'a'",
            "SELECT used FROM quotas WHERE account_id = 'a'",
            "SELECT folder, bytes FROM folder_sizes WHERE account_id = 'a' ORDER BY bytes DESC, folder",
        ] {
            let lines = plan(&store, sql);
            assert!(lines.iter().any(|l| l.starts_with("SEARCH")), "{sql}: {lines:?}");
            assert!(!lines.iter().any(|l| l.starts_with("SCAN")), "{sql}: {lines:?}");
        }
        // The account's mail on disk: its messages by index, each body by its key.
        let lines = plan(
            &store,
            "SELECT COALESCE(SUM(length(b.raw)), 0) FROM messages m JOIN bodies b ON b.message_id = m.id
             WHERE m.account_id = 'a'",
        );
        assert!(!lines.iter().any(|l| l.starts_with("SCAN")), "{lines:?}");
    }
}
