//! Labels, folder rights and folder props the cache keeps (#42). A label is the user's
//! own: its name and colour live only in Depesha, the keyword it stores on the server is
//! made from the name (`acl::keyword_of`). Folder props are what a folder's opening or
//! "Check again" learned: MYRIGHTS or Exchange's EffectiveRights, the PERMANENTFLAGS,
//! the owner from NAMESPACE, and the last refusal, remembered so the button stays off.

use rusqlite::{Connection, params};

use super::{Store, add_column};
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

impl Store {
    /// The account's labels, in the user's order (by name).
    pub fn labels(&self, account_id: &str) -> Result<Vec<Label>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT name, keyword, color FROM labels WHERE account_id = ?1 ORDER BY name COLLATE NOCASE")?;
        let rows = stmt.query_map([account_id], |r| {
            Ok(Label {
                name: r.get(0)?,
                keyword: r.get(1)?,
                color: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Adds or renames a label. The keyword goes with the name on the server; a label
    /// whose keyword would change keeps the old one, so old letters stay tagged.
    pub fn save_label(&self, account_id: &str, label: &Label) -> Result<()> {
        self.conn().execute(
            "INSERT INTO labels (account_id, name, keyword, color) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (account_id, name) DO UPDATE SET keyword = excluded.keyword, color = excluded.color",
            params![account_id, label.name, label.keyword, label.color],
        )?;
        Ok(())
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

    /// The props of one folder: what the card shows.
    pub fn folder_prop(&self, account_id: &str, folder: &str) -> Result<Option<FolderProps>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT display_name, owner_kind, owner_name, rights, labels_on_server, permanent, label_check, refused, checked
                 FROM folder_props WHERE account_id = ?1 AND folder = ?2",
                params![account_id, folder],
                row_props,
            )
            .ok())
    }

    /// Everything known about a folder list, by name; the "Folders" subsection reads it.
    pub fn folder_props(&self, account_id: &str) -> Result<Vec<FolderProps>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT display_name, owner_kind, owner_name, rights, labels_on_server, permanent, label_check, refused, checked, folder
             FROM folder_props WHERE account_id = ?1",
        )?;
        let rows = stmt.query_map([account_id], |r| {
            let mut p = row_props(r)?;
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
                    let parse = |s: String| serde_json::from_str(&s).unwrap_or_default();
                    Ok((
                        Namespace {
                            personal: parse(r.get(0)?),
                            other_users: parse(r.get(1)?),
                            shared: parse(r.get(2)?),
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

    /// A message's own keywords (labels).
    pub fn set_keywords(&self, account_id: &str, folder: &str, uid: u32, keywords: &[String]) -> Result<()> {
        let json = serde_json::to_string(keywords).unwrap_or_else(|_| "[]".into());
        self.conn().execute(
            "UPDATE messages SET keywords = ?4 WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
            params![account_id, folder, uid, json],
        )?;
        Ok(())
    }
}

fn row_props(r: &rusqlite::Row<'_>) -> rusqlite::Result<FolderProps> {
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
        permanent: serde_json::from_str(&permanent).unwrap_or_default(),
        label_check: r.get::<_, Option<String>>(6)?.and_then(|s| LabelCheck::parse(&s)),
        refused: r.get(7)?,
        checked: r.get(8)?,
    })
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
                    crate::imap::Flags {
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
                    crate::imap::Flags {
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
