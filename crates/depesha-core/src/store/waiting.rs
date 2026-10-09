//! The inbox as a queue (#59): an answer to a letter of the inbox takes its whole
//! conversation to a folder on the server, "Waiting for reply", and the reply brings it
//! back. It is one wait with the reminders of "Waiting for reply" (`followups`): the wait
//! keeps the letter answered (`anchor`), the letters moved (`parked`) and where they are
//! (`park`). The moves themselves are the app's: it takes `park_jobs` and reports back.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Followup, FollowupPlan, Store, add_column, json_list};
use crate::Result;
use crate::account::Waiting;
use crate::message::Addr;
use crate::smtp::ActsOn;

/// 11: a wait keeps the letter answered and the letters it took to the folder.
pub(super) fn v11_waiting_folder(conn: &Connection) -> Result<()> {
    for (column, decl) in [
        ("anchor", "TEXT NOT NULL DEFAULT ''"),
        ("park", "TEXT NOT NULL DEFAULT ''"),
        ("park_folder", "TEXT NOT NULL DEFAULT ''"),
        ("return_to", "TEXT NOT NULL DEFAULT ''"),
        ("parked", "TEXT NOT NULL DEFAULT '[]'"),
        ("park_since", "INTEGER NOT NULL DEFAULT 0"),
        ("noticed", "INTEGER NOT NULL DEFAULT 0"),
        ("auto_reply", "INTEGER"),
    ] {
        add_column(conn, "followups", column, decl)?;
    }
    conn.execute_batch(
        "CREATE INDEX followups_by_anchor ON followups (account_id, anchor) WHERE anchor != '';
         CREATE INDEX followups_by_park ON followups (park) WHERE park != '';",
    )?;
    Ok(())
}

/// Letters an answer takes to wait: the conversation of the letter answered in the inbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parking {
    /// The inbox, where they come back to.
    pub from: String,
    /// Their Message-IDs.
    pub chain: Vec<String>,
}

/// Which way letters of a wait are to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParkKind {
    /// From the inbox into the folder; `to` is the app's to find or make.
    In,
    /// Back: the reply came, or the user stopped waiting.
    Back,
    /// Back, taken back at once: a wait made only for the folder is forgotten.
    Undo,
}

/// A move the app owes a wait.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParkJob {
    pub account_id: String,
    /// The wait: the Message-ID of the answer.
    pub key: String,
    pub kind: ParkKind,
    pub from: String,
    pub to: String,
    pub message_ids: Vec<String>,
    /// The letter answered: the conversation to take in is found by it when the move comes,
    /// as `message_ids` is empty until then.
    pub anchor: String,
    pub subject: String,
    /// When the letters were to go in.
    pub since: i64,
}

/// The folder letters wait in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitFolder {
    Existing(String),
    Create(String),
}

/// Whether an answer takes the letter it answers to wait: an answer, not a forward, to a
/// letter of this mailbox's inbox (not of a subfolder); as the compose window asked, or
/// as the mailbox does.
pub fn parks(
    acts: Option<&ActsOn>,
    asked: Option<bool>,
    account_id: &str,
    waiting: &Waiting,
    inbox: Option<&str>,
) -> bool {
    let Some(a) = acts else { return false };
    a.act.answers() && a.account_id == account_id && inbox == Some(a.folder.as_str()) && asked.unwrap_or(waiting.park)
}

/// What an answer does with the letter it answers to, decided when it is queued (#106):
/// with a wait chosen it goes to the folder "Waiting for reply" (`park`), without one it
/// goes to the archive when the compose window or the mailbox says so (`archive`), and
/// never both. A mailbox without the setting does neither.
pub fn moves(
    acts: Option<&ActsOn>,
    plan: &FollowupPlan,
    followup_secs: i64,
    account_id: &str,
    waiting: &Waiting,
    inbox: Option<&str>,
) -> (bool, bool) {
    let waits = plan.waits(followup_secs);
    let park = parks(acts, Some(waits && waiting.park), account_id, waiting, inbox);
    let archive = parks(
        acts,
        Some(!waits && plan.archive.unwrap_or(waiting.park)),
        account_id,
        waiting,
        inbox,
    );
    (park, archive)
}

/// The folder to wait in: the chosen one while it is there, else one named `default`
/// (made by hand or by a policy) rather than a second one, else a new one.
/// `folders` are `(name, display name)`.
pub fn waiting_folder(chosen: &str, default: &str, folders: &[(String, String)]) -> WaitFolder {
    if !chosen.is_empty() {
        return if folders.iter().any(|(name, _)| name == chosen) {
            WaitFolder::Existing(chosen.to_owned())
        } else {
            WaitFolder::Create(chosen.to_owned())
        };
    }
    match folders
        .iter()
        .find(|(name, display)| name == default || display == default)
    {
        Some((name, _)) => WaitFolder::Existing(name.clone()),
        None => WaitFolder::Create(default.to_owned()),
    }
}

fn bare(id: &str) -> &str {
    id.trim_matches(['<', '>'])
}

/// How long the return of the rest of a chain waits after one letter was taken out of the
/// folder: the "Done" toast offers an undo for this long, and the wait's letters must stay
/// in the folder until it lapses, or an undo would find them already back in the inbox. The
/// toast lives 8 s (`ui.svelte.ts`): the margin covers the queue and a click at the last moment.
const UNDO_SECS: i64 = 12;

/// A letter joined to the one answered: row id, Message-ID, In-Reply-To, date, read, sender.
type Neighbour = (i64, String, Option<String>, i64, bool, Option<String>);

impl Store {
    /// Message-IDs of the conversation of `anchor` in the folder `inbox`, the letter
    /// itself included; empty when it is not there. Only letters joined to it by an
    /// answer — its own In-Reply-To/References, or letters answering it — and only those
    /// of the people of the conversation, read, and written not after it. A letter glued
    /// by subject, or pulled in through a stranger's References, stays in the inbox, as
    /// does a newer or unread one: a conversation grows while the answer waits to go.
    /// Only the anchor's own letter is walked up: a letter below it is walked down alone,
    /// so a forged From naming the anchor cannot drag its own neighbours in.
    pub fn inbox_chain(&self, account_id: &str, inbox: &str, anchor: &str) -> Result<Vec<String>> {
        let anchor = bare(anchor);
        let conn = self.conn();
        let Some((id, date, in_reply_to, from, to, cc)) = conn
            .query_row(
                "SELECT id, date, in_reply_to, from_addr, to_addrs, cc_addrs FROM messages
                 WHERE account_id = ?1 AND folder = ?2 AND message_id = ?3",
                params![account_id, inbox, anchor],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(Vec::new());
        };
        let from: Option<Addr> = from.and_then(|s| serde_json::from_str(&s).ok());
        let to: Vec<Addr> = serde_json::from_str(&to).unwrap_or_default();
        let cc: Vec<Addr> = serde_json::from_str(&cc).unwrap_or_default();
        let people = super::people(from.as_ref(), &to, &cc);

        let mut chain = vec![anchor.to_owned()];
        let mut known: HashSet<String> = HashSet::from([anchor.to_owned()]);
        // The anchor's own letter is trusted: its In-Reply-To/References name the letters
        // of its conversation above it, and those are walked up in turn. A letter reached
        // below the anchor is walked downward alone — a forged From naming the anchor in
        // its References must not drag its own neighbours into the wait (security).
        let mut frontier = vec![(id, anchor.to_owned(), in_reply_to, true)];
        let mut children = conn.prepare_cached(
            "SELECT DISTINCT x.id, x.message_id, x.in_reply_to, x.date, x.seen, x.from_addr FROM messages x
             WHERE x.account_id = ?1 AND x.folder = ?2 AND x.message_id IS NOT NULL
               AND (x.in_reply_to = ?3
                    OR x.id IN (SELECT r.message FROM message_refs r WHERE r.parent = ?3))",
        )?;
        let mut parents = conn.prepare_cached(
            "SELECT DISTINCT x.id, x.message_id, x.in_reply_to, x.date, x.seen, x.from_addr FROM messages x
             WHERE x.account_id = ?1 AND x.folder = ?2 AND x.message_id IS NOT NULL
               AND (x.message_id = ?3
                    OR x.message_id IN (SELECT r.parent FROM message_refs r WHERE r.message = ?4))",
        )?;
        fn neighbour(r: &rusqlite::Row<'_>) -> rusqlite::Result<Neighbour> {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        }
        while let Some((row, message_id, reply_to, up)) = frontier.pop() {
            let mut found: Vec<(Neighbour, bool)> = Vec::new();
            if up {
                found.extend(
                    parents
                        .query_map(params![account_id, inbox, reply_to, row], neighbour)?
                        .map(|r| r.map(|n| (n, true)))
                        .collect::<rusqlite::Result<Vec<_>>>()?,
                );
            }
            found.extend(
                children
                    .query_map(params![account_id, inbox, message_id], neighbour)?
                    .map(|r| r.map(|n| (n, false)))
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
            for ((nid, nmid, nreply, ndate, seen, nfrom), nup) in found {
                if known.contains(&nmid) || !seen || ndate > date {
                    continue;
                }
                let nfrom: Option<Addr> = nfrom.and_then(|s| serde_json::from_str(&s).ok());
                let sender = nfrom.map(|a| a.email.to_lowercase());
                if !sender.as_deref().is_some_and(|e| people.iter().any(|p| p == e)) {
                    continue;
                }
                known.insert(nmid.clone());
                chain.push(nmid.clone());
                frontier.push((nid, nmid, nreply, nup));
            }
        }
        Ok(chain)
    }

    /// The wait an answer starts when it goes: its reminder (`f.due`, 0 for none) and the
    /// letters it takes to the folder. An answer to a letter that waits already moves that
    /// wait on to it: one wait, from now on. Returns whether a wait was made or moved on.
    pub fn followup_start(&self, f: &Followup, anchor: Option<&str>, park: Option<&Parking>) -> Result<bool> {
        let key = bare(&f.message_id);
        let anchor = anchor.map(bare).unwrap_or("");
        let deadline = if f.deadline > 0 { f.deadline } else { f.due };
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if !anchor.is_empty() {
            let moved = tx.execute(
                "UPDATE followups SET message_id = ?3, sent = ?4, subject = ?5, recipients = ?6, auto_reply = NULL,
                    due = CASE WHEN ?7 > 0 THEN ?7 ELSE due END,
                    deadline = CASE WHEN ?7 > 0 THEN ?8 ELSE deadline END,
                    own_deadline = CASE WHEN ?7 > 0 THEN ?8 != ?7 ELSE own_deadline END,
                    repeat_secs = CASE WHEN ?7 > 0 THEN ?9 ELSE repeat_secs END,
                    expect = CASE WHEN ?7 > 0 THEN ?10 ELSE expect END,
                    kind = CASE WHEN ?7 > 0 THEN ?11 ELSE kind END,
                    notified = CASE WHEN ?7 > 0 THEN 0 ELSE notified END
                 WHERE rowid = (SELECT rowid FROM followups WHERE account_id = ?1 AND anchor = ?2
                     AND status = 'waiting' AND park IN ('pending', 'parked') LIMIT 1)",
                params![
                    f.account_id,
                    anchor,
                    key,
                    f.sent,
                    f.subject,
                    f.recipients,
                    f.due,
                    deadline,
                    f.repeat_secs,
                    f.expect,
                    f.kind
                ],
            )?;
            if moved > 0 {
                tx.commit()?;
                return Ok(true);
            }
        }
        let Some(park) = park.filter(|_| !anchor.is_empty()) else {
            if f.due <= 0 {
                return Ok(false);
            }
            drop(tx);
            drop(conn);
            self.followup_add_once(f)?;
            return Ok(true);
        };
        tx.execute(
            "INSERT OR REPLACE INTO followups
                (account_id, message_id, subject, recipients, sent, due, deadline, repeat_secs, expect, kind,
                 own_deadline, notified, anchor, park, parked, return_to, park_since)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?6 > 0 AND ?7 != ?6, ?6 <= 0, ?11, 'pending', ?12, ?13, ?5)",
            params![
                f.account_id,
                key,
                f.subject,
                f.recipients,
                f.sent,
                f.due.max(0),
                deadline.max(0),
                f.repeat_secs,
                f.expect,
                f.kind,
                anchor,
                json_list(&park.chain),
                park.from
            ],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// The moves waits owe: letters to take in, and letters to bring back.
    pub fn park_jobs(&self) -> Result<Vec<ParkJob>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT account_id, message_id, park, return_to, park_folder, parked, subject, park_since, anchor
             FROM followups WHERE park IN ('pending', 'back', 'undo') ORDER BY park_since, rowid",
        )?;
        let rows = stmt.query_map([], |r| {
            let park: String = r.get(2)?;
            let (home, folder): (String, String) = (r.get(3)?, r.get(4)?);
            let (kind, from, to) = match park.as_str() {
                "pending" => (ParkKind::In, home, String::new()),
                "back" => (ParkKind::Back, folder, home),
                _ => (ParkKind::Undo, folder, home),
            };
            Ok(ParkJob {
                account_id: r.get(0)?,
                key: r.get(1)?,
                kind,
                from,
                to,
                message_ids: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                subject: r.get(6)?,
                since: r.get(7)?,
                anchor: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The conversation a wait takes, found when its move comes (#109): where it sits and its
    /// letters. Kept before the move starts, so that a wait closed meanwhile brings them back.
    pub fn followup_park_plan(&self, account_id: &str, key: &str, park: &Parking) -> Result<()> {
        self.conn().execute(
            "UPDATE followups SET parked = ?3, return_to = ?4
             WHERE account_id = ?1 AND message_id = ?2 AND park IN ('pending', 'done')",
            params![account_id, bare(key), json_list(&park.chain), park.from],
        )?;
        Ok(())
    }

    /// The letters of the wait `key` are in `folder` now. A wait the user closed while the
    /// move was still running (`done`) has its letters brought back, not left there.
    pub fn followup_parked(&self, account_id: &str, key: &str, folder: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE followups SET park = CASE WHEN park = 'done' THEN 'back' ELSE 'parked' END, park_folder = ?3,
                park_since = CASE WHEN park = 'done' THEN CAST(strftime('%s','now') AS INTEGER) ELSE park_since END
             WHERE account_id = ?1 AND message_id = ?2 AND park IN ('pending', 'done')",
            params![account_id, bare(key), folder],
        )?;
        Ok(())
    }

    /// The letters of the wait `key` are back: with the reply they say so until opened;
    /// taken back at once, a wait without a reminder is forgotten.
    pub fn followup_moved_back(&self, account_id: &str, key: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM followups WHERE account_id = ?1 AND message_id = ?2 AND park = 'undo' AND due = 0",
            params![account_id, bare(key)],
        )?;
        tx.execute(
            "UPDATE followups SET park = CASE WHEN park = 'back' AND status = 'answered' THEN 'returned' ELSE 'done' END
             WHERE account_id = ?1 AND message_id = ?2 AND park IN ('back', 'undo')",
            params![account_id, bare(key)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The letters could not go to the folder: they stay in the inbox, and a wait made
    /// only for that is forgotten.
    pub fn followup_park_failed(&self, account_id: &str, key: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM followups WHERE account_id = ?1 AND message_id = ?2 AND park = 'pending' AND due = 0",
            params![account_id, bare(key)],
        )?;
        tx.execute(
            "UPDATE followups SET park = '' WHERE account_id = ?1 AND message_id = ?2 AND park = 'pending'",
            params![account_id, bare(key)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// "Stop waiting" (and "Back to the inbox"): closed by hand at `now`; letters in the
    /// folder go back to the inbox, or to `to`.
    pub fn followup_stop(&self, account_id: &str, message_id: &str, now: i64, to: Option<&str>) -> Result<()> {
        self.conn().execute(
            "UPDATE followups SET status = 'closed', ended = ?3,
                return_to = CASE WHEN park = 'parked' AND ?4 IS NOT NULL THEN ?4 ELSE return_to END,
                park = CASE park WHEN 'parked' THEN 'back' WHEN 'pending' THEN 'done' ELSE park END,
                park_since = CASE WHEN park = 'parked' THEN ?3 ELSE park_since END
             WHERE account_id = ?1 AND (message_id = ?2 OR anchor = ?2) AND status = 'waiting'",
            params![account_id, bare(message_id), now, to],
        )?;
        Ok(())
    }

    /// "Keep in the inbox" right after the answer: the letters go back, and a wait made
    /// only for the folder is forgotten; one with a reminder keeps it.
    pub fn followup_unpark(&self, account_id: &str, message_id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let which = "account_id = ?1 AND (message_id = ?2 OR anchor = ?2) AND status = 'waiting'";
        tx.execute(
            &format!("DELETE FROM followups WHERE {which} AND park = 'pending' AND due = 0"),
            params![account_id, bare(message_id)],
        )?;
        tx.execute(
            &format!(
                "UPDATE followups SET park = CASE park WHEN 'parked' THEN 'undo' ELSE 'done' END,
                    park_since = CASE WHEN park = 'parked' THEN CAST(strftime('%s','now') AS INTEGER) ELSE park_since END
                 WHERE {which} AND park IN ('pending', 'parked')"
            ),
            params![account_id, bare(message_id)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Letters moved by the user out of `folder` ("Done", Delete, another folder): the
    /// waits whose letters they were. A wait is over only when none of its letters is left
    /// in the folder; the rest are set to come back rather than staying there for good.
    /// Returns the Message-ID of every wait touched, so an undo can park it again.
    pub fn followups_left(
        &self,
        account_id: &str,
        folder: &str,
        message_ids: &[String],
        now: i64,
    ) -> Result<Vec<String>> {
        let moved: HashSet<&str> = message_ids.iter().map(|m| bare(m)).collect();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let parked: Vec<(String, Vec<String>)> = {
            let mut stmt = tx.prepare(
                "SELECT message_id, parked FROM followups
                 WHERE account_id = ?1 AND park = 'parked' AND park_folder = ?2",
            )?;
            let rows = stmt.query_map(params![account_id, folder], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    serde_json::from_str::<Vec<String>>(&r.get::<_, String>(1)?).unwrap_or_default(),
                ))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut touched = Vec::new();
        for (key, letters) in parked {
            if !letters.iter().any(|id| moved.contains(id.as_str())) {
                continue;
            }
            let left: Vec<String> = letters
                .iter()
                .filter(|id| !moved.contains(id.as_str()))
                .cloned()
                .collect();
            // Nothing left in the folder: the wait is over. Something left: it comes back.
            let park = if left.is_empty() { "done" } else { "back" };
            tx.execute(
                "UPDATE followups SET parked = ?3, park = ?4,
                    ended = CASE WHEN status = 'waiting' THEN ?5 ELSE ended END,
                    status = CASE WHEN status = 'waiting' THEN 'closed' ELSE status END,
                    park_since = CASE WHEN ?4 = 'back' THEN ?5 + ?6 ELSE park_since END
                 WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, key, json_list(&left), park, now, UNDO_SECS],
            )?;
            touched.push(key);
        }
        tx.commit()?;
        Ok(touched)
    }

    /// A move was undone: the letters are back in `folder`, where the wait parks them, and
    /// the wait is parked again.
    pub fn followup_reparked(&self, account_id: &str, key: &str, folder: &str, message_ids: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let parked: Option<String> = tx
            .query_row(
                "SELECT parked FROM followups WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, bare(key)],
                |r| r.get(0),
            )
            .optional()?;
        let Some(parked) = parked else {
            return Ok(());
        };
        let mut letters: Vec<String> = serde_json::from_str(&parked).unwrap_or_default();
        for id in message_ids {
            let id = bare(id);
            if !letters.iter().any(|p| p == id) {
                letters.push(id.to_owned());
            }
        }
        tx.execute(
            "UPDATE followups SET parked = ?3, park = 'parked', park_folder = ?4, status = 'waiting', ended = NULL
             WHERE account_id = ?1 AND message_id = ?2",
            params![account_id, bare(key), json_list(&letters), folder],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The letters could not be brought back (the folder they wait in is gone): the wait
    /// stops trying, and the user is told to return them by hand.
    pub fn followup_return_failed(&self, account_id: &str, key: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE followups SET park = 'done' WHERE account_id = ?1 AND message_id = ?2 AND park IN ('back', 'undo')",
            params![account_id, bare(key)],
        )?;
        Ok(())
    }

    /// A letter was opened: back with the reply, it no longer says so. Whether one did.
    pub fn followup_noticed(&self, account_id: &str, message_id: &str) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE followups SET noticed = 1
             WHERE account_id = ?1 AND park = 'returned' AND noticed = 0 AND (anchor = ?2 OR answer_id = ?2)",
            params![account_id, bare(message_id)],
        )? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{folder, from_to, put, with_ids};
    use super::*;
    use crate::account::Waiting;
    use crate::imap::FolderRole;
    use crate::message::Summary;
    use crate::smtp::{Act, ActsOn};
    use crate::store::{
        Followup, FollowupCounts, FollowupFilter, FollowupInfo, FollowupStatus, ListQuery, MessageRow, Store,
    };

    const WAIT: &str = "Ждут ответа";
    /// When my answer left.
    const SENT: i64 = 100_000;

    fn mailbox() -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders(
                "a",
                &[
                    folder("INBOX", Some(FolderRole::Inbox)),
                    folder("Sent", Some(FolderRole::Sent)),
                    folder("Archive", Some(FolderRole::Archive)),
                    folder(WAIT, None),
                ],
            )
            .unwrap();
        store
    }

    fn letter(subject: &str, date: i64, id: &str, parent: Option<&str>, from: &str) -> Summary {
        from_to(with_ids(subject, date, id, parent), from, "carol@example.org")
    }

    /// My answer `key`, sent at `sent`; a reminder when `due` is not 0.
    fn answer(key: &str, sent: i64, due: i64) -> Followup {
        Followup {
            account_id: "a".into(),
            message_id: key.into(),
            subject: "Re: Счёт".into(),
            recipients: "maria@example.org".into(),
            sent,
            due,
            ..Default::default()
        }
    }

    fn listed(store: &Store, status: FollowupFilter) -> Vec<MessageRow> {
        store
            .list(&ListQuery {
                followups_only: true,
                followup_status: status,
                ..Default::default()
            })
            .unwrap()
    }

    fn the_wait(store: &Store, status: FollowupFilter) -> FollowupInfo {
        let rows = listed(store, status);
        assert_eq!(rows.len(), 1, "{rows:#?}");
        rows[0].followup.clone().unwrap()
    }

    fn sorted(mut ids: Vec<String>) -> Vec<String> {
        ids.sort();
        ids
    }

    /// The server moved these letters: gone from one folder, in the other under new UIDs.
    fn moved(store: &Store, from: &str, uids: &[u32], to: &str, letters: &[(u32, &Summary)]) {
        store.remove_uids("a", from, uids).unwrap();
        for (uid, s) in letters {
            put(store, to, *uid, s, true);
        }
    }

    /// Maria wrote twice; I answered the second from the inbox at `SENT` as `r@x`, and the
    /// conversation went to wait. Returns her two letters.
    fn waiting(store: &Store, due: i64) -> (Summary, Summary) {
        let first = letter("Счёт", 90_000, "q1@x", None, "maria@example.org");
        let second = letter("Re: Счёт", 95_000, "q2@x", Some("q1@x"), "maria@example.org");
        put(store, "INBOX", 1, &first, true);
        put(store, "INBOX", 2, &second, true);
        let chain = store.inbox_chain("a", "INBOX", "q2@x").unwrap();
        let park = Parking {
            from: "INBOX".into(),
            chain,
        };
        assert!(
            store
                .followup_start(&answer("r@x", SENT, due), Some("q2@x"), Some(&park))
                .unwrap()
        );
        store.followup_parked("a", "r@x", WAIT).unwrap();
        moved(store, "INBOX", &[1, 2], WAIT, &[(1, &first), (2, &second)]);
        (first, second)
    }

    #[test]
    fn a_new_letter_of_the_conversation_stays_in_the_inbox() {
        let store = mailbox();
        let first = letter("Счёт", 90_000, "q1@x", None, "maria@example.org");
        let second = letter("Re: Счёт", 95_000, "q2@x", Some("q1@x"), "maria@example.org");
        put(&store, "INBOX", 1, &first, true);
        put(&store, "INBOX", 2, &second, true);
        // A colleague writes into the conversation while the answer waits to go: the
        // letter is newer than the one answered, and it stays where it is.
        let later = letter("Re: Счёт", 96_000, "c@x", Some("q2@x"), "maria@example.org");
        put(&store, "INBOX", 3, &later, true);
        // An older letter nobody read is not swept along either.
        let unread = letter("Re: Счёт", 94_000, "u@x", Some("q1@x"), "maria@example.org");
        put(&store, "INBOX", 4, &unread, false);
        let chain = store.inbox_chain("a", "INBOX", "q2@x").unwrap();
        assert_eq!(sorted(chain), ["q1@x", "q2@x"]);
    }

    #[test]
    fn a_stranger_naming_the_conversation_is_not_taken_to_wait() {
        let store = mailbox();
        put(
            &store,
            "INBOX",
            1,
            &letter("Счёт", 90_000, "imp@x", None, "maria@example.org"),
            true,
        );
        // A stranger answers nothing of it, but names it in References: a different
        // conversation that must not drag the important letter along.
        let attack = letter("Привет", 95_000, "atk@x", Some("imp@x"), "evil@example.org");
        put(&store, "INBOX", 2, &attack, true);
        let chain = store.inbox_chain("a", "INBOX", "atk@x").unwrap();
        assert_eq!(sorted(chain), ["atk@x"]);
        // And the important letter does not take the stranger's.
        let chain = store.inbox_chain("a", "INBOX", "imp@x").unwrap();
        assert_eq!(sorted(chain), ["imp@x"]);
    }

    #[test]
    fn a_letter_naming_the_anchor_does_not_drag_its_own_neighbours() {
        let store = mailbox();
        // The letter I answered.
        put(
            &store,
            "INBOX",
            1,
            &letter("Счёт", 90_000, "q1@x", None, "maria@example.org"),
            true,
        );
        // An unrelated, older letter of the same people.
        put(
            &store,
            "INBOX",
            2,
            &letter("Отпуск", 80_000, "other@x", None, "maria@example.org"),
            true,
        );
        // A forged letter: an old date, a participant's From, and References naming both
        // the anchor and the unrelated letter. Only the branch from the anchor is walked,
        // so the unrelated letter is not swept into the wait.
        let mut fake = with_ids("Re: Счёт", 85_000, "fake@x", Some("q1@x"));
        fake.references = vec!["q1@x".into(), "other@x".into()];
        put(
            &store,
            "INBOX",
            3,
            &from_to(fake, "maria@example.org", "carol@example.org"),
            true,
        );
        let chain = store.inbox_chain("a", "INBOX", "q1@x").unwrap();
        assert_eq!(sorted(chain), ["fake@x", "q1@x"]);
    }

    /// An answer starts a wait without the letters (#109): they are found when the move comes,
    /// and kept before it starts, so that a wait closed meanwhile brings them back to where
    /// they were taken from (the inbox after an "Undo" of the archive, the archive otherwise).
    #[test]
    fn a_wait_finds_its_letters_when_the_move_comes() {
        let store = mailbox();
        let park = Parking {
            from: "INBOX".into(),
            chain: Vec::new(),
        };
        assert!(
            store
                .followup_start(&answer("r@x", SENT, 0), Some("q@x"), Some(&park))
                .unwrap()
        );
        let job = store.park_jobs().unwrap().remove(0);
        assert_eq!(
            (
                job.kind,
                job.from.as_str(),
                job.anchor.as_str(),
                job.message_ids.is_empty()
            ),
            (ParkKind::In, "INBOX", "q@x", true)
        );
        let found = Parking {
            from: "Archive".into(),
            chain: vec!["q@x".into(), "p@x".into()],
        };
        store.followup_park_plan("a", "r@x", &found).unwrap();
        // The user stops waiting while the move runs: the letters go back where they were taken from.
        store.followup_stop("a", "r@x", 5, None).unwrap();
        store.followup_parked("a", "r@x", "Waiting").unwrap();
        let back = store.park_jobs().unwrap().remove(0);
        assert_eq!(
            (
                back.kind,
                back.from.as_str(),
                back.to.as_str(),
                sorted(back.message_ids)
            ),
            (
                ParkKind::Back,
                "Waiting",
                "Archive",
                vec!["p@x".to_owned(), "q@x".to_owned()]
            )
        );
    }

    #[test]
    fn answering_a_letter_of_the_inbox_takes_its_whole_conversation_to_wait() {
        let store = mailbox();
        put(
            &store,
            "INBOX",
            1,
            &letter("Счёт", 90_000, "q1@x", None, "maria@example.org"),
            true,
        );
        let second = letter("Re: Счёт", 95_000, "q2@x", Some("q1@x"), "maria@example.org");
        put(&store, "INBOX", 2, &second, true);
        put(
            &store,
            "INBOX",
            3,
            &letter("Обед", 96_000, "o@x", None, "petr@example.org"),
            true,
        );
        // My earlier answer is of the conversation too, but lives in Sent.
        put(
            &store,
            "Sent",
            1,
            &letter("Re: Счёт", 92_000, "mine@x", Some("q1@x"), "carol@example.org"),
            true,
        );

        let chain = store.inbox_chain("a", "INBOX", "q2@x").unwrap();
        assert_eq!(sorted(chain.clone()), ["q1@x", "q2@x"]);
        assert!(store.inbox_chain("a", "INBOX", "absent@x").unwrap().is_empty());
        assert!(store.inbox_chain("a", "Sent", "q2@x").unwrap().is_empty(), "not there");

        let park = Parking {
            from: "INBOX".into(),
            chain,
        };
        assert!(
            store
                .followup_start(&answer("r@x", SENT, 0), Some("q2@x"), Some(&park))
                .unwrap()
        );
        let jobs = store.park_jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        let job = &jobs[0];
        assert_eq!(
            (
                job.kind,
                job.from.as_str(),
                job.key.as_str(),
                sorted(job.message_ids.clone())
            ),
            (ParkKind::In, "INBOX", "r@x", vec!["q1@x".to_owned(), "q2@x".to_owned()])
        );
        // It waits from now on, by the letter answered: from its sender, not my answer.
        let rows = listed(&store, FollowupFilter::Active);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id.as_deref(), Some("q2@x"));
        let f = rows[0].followup.clone().unwrap();
        assert_eq!(
            (f.status, f.park.as_str(), f.due, f.deadline, f.sent),
            (FollowupStatus::Waiting, "pending", 0, 0, SENT)
        );
        assert_eq!(rows[0].followup_due, None, "no reminder");
        assert_eq!(store.followups_count().unwrap().active, 1);
        // Without a reminder it never reminds.
        assert!(store.followups_due(SENT * 100).unwrap().is_empty());

        // The server moved them.
        store.followup_parked("a", "r@x", WAIT).unwrap();
        moved(&store, "INBOX", &[2], WAIT, &[(2, &second)]);
        assert!(store.park_jobs().unwrap().is_empty());
        let rows = listed(&store, FollowupFilter::Active);
        assert_eq!(rows[0].folder, WAIT);
        let f = rows[0].followup.clone().unwrap();
        assert_eq!((f.park.as_str(), f.park_folder.as_str()), ("parked", WAIT));
    }

    #[test]
    fn the_answer_brings_the_conversation_back_and_says_so_until_it_is_opened() {
        let store = mailbox();
        let (first, second) = waiting(&store, 0);
        let reply = letter("Re: Счёт", SENT + 600, "a1@x", Some("r@x"), "maria@example.org");
        put(&store, "INBOX", 10, &reply, false);
        assert_eq!(store.followups_resolve().unwrap(), 1);

        let jobs = store.park_jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        let job = &jobs[0];
        assert_eq!(
            (
                job.kind,
                job.from.as_str(),
                job.to.as_str(),
                sorted(job.message_ids.clone())
            ),
            (
                ParkKind::Back,
                WAIT,
                "INBOX",
                vec!["q1@x".to_owned(), "q2@x".to_owned()]
            )
        );
        moved(&store, WAIT, &[1, 2], "INBOX", &[(11, &first), (12, &second)]);
        store.followup_moved_back("a", "r@x").unwrap();
        assert!(store.park_jobs().unwrap().is_empty());

        let inbox = |threads| {
            store
                .list(&ListQuery {
                    account_id: Some("a".into()),
                    folder: Some("INBOX".into()),
                    threads,
                    ..Default::default()
                })
                .unwrap()
        };
        let came = |rows: &[MessageRow], id: &str| {
            rows.iter()
                .find(|r| r.message_id.as_deref() == Some(id))
                .map(|r| r.answer_came)
                .unwrap()
        };
        // Not grouped: the letter answered says the answer came, the answer itself does not.
        let rows = inbox(false);
        assert!(came(&rows, "q2@x"));
        assert!(!came(&rows, "a1@x"));
        assert!(!came(&rows, "q1@x"));
        // Grouped: the conversation's row says it.
        let rows = inbox(true);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].answer_came);
        // In the history: answered, by whom.
        let f = the_wait(&store, FollowupFilter::Closed);
        assert_eq!((f.status, f.park.as_str()), (FollowupStatus::Answered, "returned"));
        assert_eq!(f.answered_by.unwrap().email, "maria@example.org");

        // Opening the answer (or the letter) is reading it: the mark goes.
        assert!(store.followup_noticed("a", "<a1@x>").unwrap());
        assert!(!store.followup_noticed("a", "a1@x").unwrap(), "once");
        assert!(inbox(false).iter().all(|r| !r.answer_came));
        assert!(inbox(true).iter().all(|r| !r.answer_came));
    }

    #[test]
    fn an_auto_reply_or_a_list_is_not_the_answer() {
        let store = mailbox();
        waiting(&store, 0);
        let mut auto = letter("Автоответ: Счёт", SENT + 60, "auto@x", Some("r@x"), "maria@example.org");
        auto.bulk = true;
        put(&store, "INBOX", 10, &auto, false);
        assert_eq!(store.followups_resolve().unwrap(), 0);
        assert!(store.park_jobs().unwrap().is_empty());
        // It is told, or the letter would wait with no reason seen.
        assert_eq!(the_wait(&store, FollowupFilter::Active).auto_reply, Some(SENT + 60));
        // A person's answer after it counts.
        put(
            &store,
            "INBOX",
            11,
            &letter("Re: Счёт", SENT + 900, "a1@x", Some("r@x"), "maria@example.org"),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert_eq!(the_wait(&store, FollowupFilter::Closed).ended, Some(SENT + 900));
    }

    #[test]
    fn a_new_letter_of_the_conversation_counts_when_it_was_written_after_the_answer() {
        let store = mailbox();
        waiting(&store, 0);
        // A colleague answered Maria's letter before my answer went: not an answer to me.
        put(
            &store,
            "INBOX",
            10,
            &letter("Re: Счёт", SENT - 3_600, "c@x", Some("q2@x"), "petr@example.org"),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 0);
        // Maria wrote again in the conversation after my answer: the letter comes back.
        put(
            &store,
            "INBOX",
            11,
            &letter("Re: Счёт", SENT + 3_600, "c2@x", Some("q2@x"), "maria@example.org"),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert_eq!(store.park_jobs().unwrap()[0].kind, ParkKind::Back);
    }

    #[test]
    fn answering_a_waiting_letter_again_keeps_one_wait_and_moves_its_start() {
        let store = mailbox();
        waiting(&store, 0);
        // From "Waiting for reply": the letter answered lies in the folder now.
        assert!(
            store
                .followup_start(&answer("r2@x", SENT + 50_000, 0), Some("q2@x"), None)
                .unwrap()
        );
        let rows = listed(&store, FollowupFilter::Active);
        assert_eq!(rows.len(), 1);
        let f = rows[0].followup.clone().unwrap();
        assert_eq!((f.sent, f.park.as_str()), (SENT + 50_000, "parked"));
        // An answer to the new one counts.
        put(
            &store,
            "INBOX",
            10,
            &letter("Re: Счёт", SENT + 60_000, "a@x", Some("r2@x"), "maria@example.org"),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
    }

    #[test]
    fn stop_waiting_takes_the_letters_back_to_the_inbox_or_to_the_archive() {
        let store = mailbox();
        let (first, second) = waiting(&store, 0);
        // From the row of the view: the letter answered.
        store.followup_stop("a", "q2@x", SENT + 10, None).unwrap();
        let jobs = store.park_jobs().unwrap();
        assert_eq!((jobs[0].kind, jobs[0].to.as_str()), (ParkKind::Back, "INBOX"));
        moved(&store, WAIT, &[1, 2], "INBOX", &[(11, &first), (12, &second)]);
        store.followup_moved_back("a", "r@x").unwrap();
        let f = the_wait(&store, FollowupFilter::Closed);
        assert_eq!((f.status, f.park.as_str()), (FollowupStatus::Closed, "done"));
        assert!(store.park_jobs().unwrap().is_empty());
        // Closed by hand: nothing to tell in the inbox.
        assert!(
            store
                .list(&ListQuery::default())
                .unwrap()
                .iter()
                .all(|r| !r.answer_came)
        );

        // The settings say "to the archive".
        let store = mailbox();
        waiting(&store, 0);
        store.followup_stop("a", "q2@x", SENT + 10, Some("Archive")).unwrap();
        assert_eq!(store.park_jobs().unwrap()[0].to, "Archive");
    }

    #[test]
    fn keeping_the_letter_in_the_inbox_forgets_a_wait_made_only_for_it() {
        let store = mailbox();
        let (first, second) = waiting(&store, 0);
        store.followup_unpark("a", "r@x").unwrap();
        let jobs = store.park_jobs().unwrap();
        assert_eq!((jobs[0].kind, jobs[0].to.as_str()), (ParkKind::Undo, "INBOX"));
        moved(&store, WAIT, &[1, 2], "INBOX", &[(11, &first), (12, &second)]);
        store.followup_moved_back("a", "r@x").unwrap();
        assert_eq!(
            store.followups_count().unwrap(),
            FollowupCounts { active: 0, closed: 0 }
        );

        // With a reminder the wait stays, without the folder.
        let store = mailbox();
        let (first, second) = waiting(&store, SENT + 86_400);
        store.followup_unpark("a", "q2@x").unwrap();
        moved(&store, WAIT, &[1, 2], "INBOX", &[(11, &first), (12, &second)]);
        store.followup_moved_back("a", "r@x").unwrap();
        let f = the_wait(&store, FollowupFilter::Active);
        assert_eq!(
            (f.status, f.due, f.park.as_str()),
            (FollowupStatus::Waiting, SENT + 86_400, "done")
        );

        // Not moved yet: nothing to bring back.
        let store = mailbox();
        put(
            &store,
            "INBOX",
            1,
            &letter("Счёт", 90_000, "q1@x", None, "maria@example.org"),
            true,
        );
        let park = Parking {
            from: "INBOX".into(),
            chain: vec!["q1@x".into()],
        };
        store
            .followup_start(&answer("r@x", SENT, 0), Some("q1@x"), Some(&park))
            .unwrap();
        store.followup_unpark("a", "r@x").unwrap();
        assert!(store.park_jobs().unwrap().is_empty());
        assert_eq!(store.followups_count().unwrap().active, 0);
    }

    #[test]
    fn a_folder_the_server_refused_leaves_the_letter_in_the_inbox() {
        let store = mailbox();
        put(
            &store,
            "INBOX",
            1,
            &letter("Счёт", 90_000, "q1@x", None, "maria@example.org"),
            true,
        );
        let park = Parking {
            from: "INBOX".into(),
            chain: vec!["q1@x".into()],
        };
        store
            .followup_start(&answer("r@x", SENT, 0), Some("q1@x"), Some(&park))
            .unwrap();
        store.followup_park_failed("a", "r@x").unwrap();
        assert!(store.park_jobs().unwrap().is_empty());
        // It waited only to be moved.
        assert_eq!(store.followups_count().unwrap().active, 0);

        // A reminder still reminds.
        store
            .followup_start(&answer("r@x", SENT, SENT + 500), Some("q1@x"), Some(&park))
            .unwrap();
        store.followup_park_failed("a", "r@x").unwrap();
        let f = the_wait(&store, FollowupFilter::Active);
        assert_eq!((f.due, f.park.as_str()), (SENT + 500, ""));
    }

    #[test]
    fn done_with_a_waiting_letter_closes_its_wait() {
        let store = mailbox();
        waiting(&store, 0);
        // Moved elsewhere by hand ("Done", Delete, a folder): what is not waiting is untouched.
        assert!(
            store
                .followups_left("a", "INBOX", &["q2@x".into()], SENT + 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .followups_left("a", WAIT, &["other@x".into()], SENT + 10)
                .unwrap()
                .is_empty()
        );
        // "Done" on the whole chain: the wait is over, nothing left in the folder.
        assert_eq!(
            store
                .followups_left("a", WAIT, &["<q1@x>".into(), "q2@x".into()], SENT + 10)
                .unwrap()
                .len(),
            1
        );
        let f = the_wait(&store, FollowupFilter::Closed);
        assert_eq!(
            (f.status, f.park.as_str(), f.ended),
            (FollowupStatus::Closed, "done", Some(SENT + 10))
        );
        assert!(store.park_jobs().unwrap().is_empty());
        // An answer later does not bring it back from the archive.
        put(
            &store,
            "INBOX",
            10,
            &letter("Re: Счёт", SENT + 600, "a1@x", Some("r@x"), "maria@example.org"),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 0);
    }

    #[test]
    fn moving_one_letter_out_returns_the_rest_of_the_chain() {
        let store = mailbox();
        let (_, second) = waiting(&store, 0);
        // "Done" on one letter of the chain: the rest must not stay in the folder.
        assert_eq!(
            store
                .followups_left("a", WAIT, &["q1@x".into()], SENT + 10)
                .unwrap()
                .len(),
            1
        );
        let jobs = store.park_jobs().unwrap();
        assert_eq!(jobs.len(), 1, "{jobs:#?}");
        let job = &jobs[0];
        assert_eq!(
            (
                job.kind,
                job.from.as_str(),
                job.to.as_str(),
                sorted(job.message_ids.clone())
            ),
            (ParkKind::Back, WAIT, "INBOX", vec!["q2@x".to_owned()])
        );
        // The rest comes back; the wait is over.
        moved(&store, WAIT, &[2], "INBOX", &[(12, &second)]);
        store.followup_moved_back("a", "r@x").unwrap();
        assert!(store.park_jobs().unwrap().is_empty());
        assert!(
            store.find_by_message_id("a", "INBOX", "q2@x").unwrap().is_some(),
            "the rest is back in the inbox"
        );
        let f = the_wait(&store, FollowupFilter::Closed);
        assert_eq!((f.status, f.park.as_str()), (FollowupStatus::Closed, "done"));
    }

    #[test]
    fn the_hold_outlives_the_undo_toast_with_a_margin() {
        const TOAST_SECS: i64 = 8;
        const { assert!(UNDO_SECS >= TOAST_SECS + 3) };
    }

    #[test]
    fn the_rest_of_a_chain_waits_out_the_undo_toast() {
        let store = mailbox();
        waiting(&store, 0);
        // "Done" on one letter of the chain: the rest are due back, but the move is held
        // until the undo toast lapses, or an undo would find them already in the inbox.
        let now = SENT + 10;
        store.followups_left("a", WAIT, &["q1@x".into()], now).unwrap();
        let jobs = store.park_jobs().unwrap();
        assert_eq!(jobs.len(), 1, "{jobs:#?}");
        assert_eq!(jobs[0].kind, ParkKind::Back);
        assert_eq!(jobs[0].since, now + UNDO_SECS, "held back for the undo toast");
    }

    #[test]
    fn undo_of_a_done_letter_restores_the_wait() {
        let store = mailbox();
        waiting(&store, 0);
        // "Done" on the whole chain, then "z": the letters come back and the wait with them.
        assert_eq!(
            store
                .followups_left("a", WAIT, &["q1@x".into(), "q2@x".into()], SENT + 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store.followups_count().unwrap(),
            FollowupCounts { active: 0, closed: 1 }
        );
        store
            .followup_reparked("a", "r@x", WAIT, &["q1@x".into(), "q2@x".into()])
            .unwrap();
        let f = the_wait(&store, FollowupFilter::Active);
        assert_eq!(
            (f.status, f.park.as_str(), f.park_folder.as_str()),
            (FollowupStatus::Waiting, "parked", WAIT)
        );
        assert!(store.park_jobs().unwrap().is_empty());
    }

    #[test]
    fn stopping_the_wait_while_the_move_runs_brings_the_letters_back() {
        let store = mailbox();
        put(
            &store,
            "INBOX",
            1,
            &letter("Счёт", 90_000, "q1@x", None, "maria@example.org"),
            true,
        );
        let park = Parking {
            from: "INBOX".into(),
            chain: vec!["q1@x".into()],
        };
        store
            .followup_start(&answer("r@x", SENT, SENT + 500), Some("q1@x"), Some(&park))
            .unwrap();
        // The move is still pending; "Не ждать" closes the wait meanwhile.
        store.followup_stop("a", "r@x", SENT + 10, None).unwrap();
        // The move lands: the letter must come back, not stay in the folder.
        store.followup_parked("a", "r@x", WAIT).unwrap();
        let jobs = store.park_jobs().unwrap();
        assert_eq!(jobs.len(), 1, "{jobs:#?}");
        assert_eq!(
            (jobs[0].kind, jobs[0].from.as_str(), jobs[0].to.as_str()),
            (ParkKind::Back, WAIT, "INBOX")
        );
    }

    #[test]
    fn pruning_keeps_a_wait_whose_letters_are_still_in_the_folder() {
        let store = mailbox();
        waiting(&store, 0);
        // The anchor vanishes from the cache; the rest of the chain is still in the folder.
        store.remove_uids("a", WAIT, &[2]).unwrap();
        store.followups_prune(SENT, 30).unwrap();
        let later = SENT + 8 * 86_400;
        assert_eq!(
            store.followups_prune(later, 30).unwrap(),
            0,
            "letters in the folder keep the wait"
        );
        // The wait is still there: the rest can still be brought back.
        assert_eq!(
            store.followups_left("a", WAIT, &["q1@x".into()], later).unwrap().len(),
            1
        );
    }

    #[test]
    fn an_answer_before_the_move_leaves_the_letters_where_they_are() {
        let store = mailbox();
        put(
            &store,
            "INBOX",
            1,
            &letter("Счёт", 90_000, "q1@x", None, "maria@example.org"),
            true,
        );
        let park = Parking {
            from: "INBOX".into(),
            chain: vec!["q1@x".into()],
        };
        store
            .followup_start(&answer("r@x", SENT, 0), Some("q1@x"), Some(&park))
            .unwrap();
        put(
            &store,
            "INBOX",
            10,
            &letter("Re: Счёт", SENT + 60, "a1@x", Some("r@x"), "maria@example.org"),
            false,
        );
        assert_eq!(store.followups_resolve().unwrap(), 1);
        assert!(store.park_jobs().unwrap().is_empty());
        assert_eq!(the_wait(&store, FollowupFilter::Closed).park, "done");
    }

    #[test]
    fn a_reminder_and_the_folder_are_one_wait() {
        let store = mailbox();
        waiting(&store, SENT + 500);
        assert_eq!(listed(&store, FollowupFilter::Active).len(), 1);
        assert_eq!(listed(&store, FollowupFilter::Active)[0].followup_due, Some(SENT + 500));
        // The reminder opens the letter answered, which is where the wait shows.
        let due = store.followups_due(SENT + 600).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].message_id, "q2@x");
        // "Remind me…" of the view's row reaches the wait through the letter answered.
        store.followup_postpone("a", "q2@x", SENT + 9_000, true).unwrap();
        assert_eq!(the_wait(&store, FollowupFilter::Active).due, SENT + 9_000);
    }

    #[test]
    fn a_cache_of_0_6_4_keeps_its_mail_its_marks_and_its_waits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        {
            // The nine steps 0.6.4 knew, and its data.
            let mut conn = rusqlite::Connection::open(&path).unwrap();
            super::super::migrate(&mut conn, &super::super::MIGRATIONS[..9]).unwrap();
            conn.execute_batch(
                "INSERT INTO folders (account_id, name, display_name, role, selectable) VALUES ('a', 'INBOX', 'INBOX', 'inbox', 1);
                 INSERT INTO messages (account_id, folder, uid, message_id, refs, subject, to_addrs, cc_addrs, reply_to,
                     date, size, seen, answered, flagged, draft, has_attachments, thread)
                     VALUES ('a', 'INBOX', 1, 'q@x', '[]', 'Счёт', '[]', '[]', '[]', 100, 1, 1, 1, 0, 0, 0, 'q@x');
                 INSERT INTO followups (account_id, message_id, subject, recipients, sent, due, deadline)
                     VALUES ('a', 'q@x', 'Счёт', 'maria@example.org', 100, 500, 500);
                 INSERT INTO outbox (account_id, draft, next_attempt, created) VALUES ('a', '{}', 1, 1);",
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let rows = store.list(&ListQuery::default()).unwrap();
        assert_eq!(rows.len(), 1);
        // \Answered of the old cache is a reply, its time unknown.
        assert_eq!(
            rows[0].marks,
            [crate::store::Mark {
                act: Act::Reply,
                at: None
            }]
        );
        assert!(!rows[0].flags.forwarded && !rows[0].flags.answered_all);
        // The wait is the reminder it was: no folder, waiting for an answer to its letter.
        let f = rows[0].followup.clone().unwrap();
        assert_eq!((f.status, f.due, f.park.as_str()), (FollowupStatus::Waiting, 500, ""));
        assert_eq!(store.followups_count().unwrap().active, 1);
        let item = &store.outbox().unwrap()[0];
        assert_eq!((item.draft.acts_on.as_ref(), item.followup.park), (None, None));
    }

    fn acts(folder: &str, act: Act, account: &str) -> ActsOn {
        ActsOn {
            account_id: account.into(),
            message_id: "q@x".into(),
            folder: folder.into(),
            act,
            waiting: false,
        }
    }

    #[test]
    fn only_an_answer_to_a_letter_of_the_inbox_goes_to_wait() {
        let on = Waiting {
            park: true,
            ..Default::default()
        };
        let off = Waiting::default();
        let inbox = Some("INBOX");
        let reply = acts("INBOX", Act::Reply, "a");
        assert!(parks(Some(&reply), None, "a", &on, inbox));
        assert!(parks(Some(&acts("INBOX", Act::ReplyAll, "a")), None, "a", &on, inbox));
        // The window's checkbox decides for its letter.
        assert!(!parks(Some(&reply), Some(false), "a", &on, inbox));
        assert!(parks(Some(&reply), Some(true), "a", &off, inbox));
        assert!(!parks(Some(&reply), None, "a", &off, inbox));
        // A forward, a new letter, a letter of another folder or mailbox: never.
        assert!(!parks(
            Some(&acts("INBOX", Act::Forward, "a")),
            Some(true),
            "a",
            &on,
            inbox
        ));
        assert!(!parks(None, Some(true), "a", &on, inbox));
        assert!(!parks(
            Some(&acts("INBOX/Проекты", Act::Reply, "a")),
            Some(true),
            "a",
            &on,
            inbox
        ));
        assert!(!parks(
            Some(&acts("Archive", Act::Reply, "a")),
            Some(true),
            "a",
            &on,
            inbox
        ));
        assert!(!parks(
            Some(&acts("INBOX", Act::Reply, "b")),
            Some(true),
            "a",
            &on,
            inbox
        ));
        assert!(!parks(Some(&reply), Some(true), "a", &on, None), "no inbox known");
    }

    #[test]
    fn without_a_wait_an_answer_archives_and_does_not_park() {
        let on = Waiting {
            park: true,
            ..Default::default()
        };
        let off = Waiting::default();
        let reply = acts("INBOX", Act::Reply, "a");
        let inbox = Some("INBOX");
        let none = FollowupPlan::default();
        let ticked = |archive| FollowupPlan {
            archive: Some(archive),
            ..Default::default()
        };
        let remind = FollowupPlan {
            deadline_secs: 3_600,
            ..Default::default()
        };
        // «No reminder»: nothing waits, the letter goes to the archive as the box says.
        assert_eq!(moves(Some(&reply), &none, 0, "a", &on, inbox), (false, true));
        assert_eq!(moves(Some(&reply), &ticked(true), 0, "a", &on, inbox), (false, true));
        assert_eq!(moves(Some(&reply), &ticked(false), 0, "a", &on, inbox), (false, false));
        // A wait chosen: the folder, no archive, whatever the box says.
        assert_eq!(moves(Some(&reply), &none, 86_400, "a", &on, inbox), (true, false));
        assert_eq!(moves(Some(&reply), &remind, 0, "a", &on, inbox), (true, false));
        assert_eq!(
            moves(Some(&reply), &ticked(true), 86_400, "a", &on, inbox),
            (true, false)
        );
        // A mailbox without the setting, a forward, another folder: neither.
        assert_eq!(moves(Some(&reply), &none, 0, "a", &off, inbox), (false, false));
        assert_eq!(
            moves(Some(&reply), &ticked(true), 86_400, "a", &off, inbox),
            (false, false)
        );
        let fwd = acts("INBOX", Act::Forward, "a");
        assert_eq!(moves(Some(&fwd), &none, 0, "a", &on, inbox), (false, false));
        let other = acts("Archive", Act::Reply, "a");
        assert_eq!(moves(Some(&other), &none, 0, "a", &on, inbox), (false, false));
    }

    #[test]
    fn the_folder_to_wait_in_is_the_chosen_one_or_one_named_so() {
        let f = |name: &str, display: &str| (name.to_owned(), display.to_owned());
        let folders = [
            f("INBOX", "Входящие"),
            f("Archive", "Архив"),
            f("INBOX/Ждут ответа", "Ждут ответа"),
        ];
        // Chosen and still there.
        assert_eq!(
            waiting_folder("Archive", "Ждут ответа", &folders),
            WaitFolder::Existing("Archive".into())
        );
        // Not chosen: one already named so is taken, not a second one made.
        assert_eq!(
            waiting_folder("", "Ждут ответа", &folders),
            WaitFolder::Existing("INBOX/Ждут ответа".into())
        );
        assert_eq!(
            waiting_folder("", "Waiting for reply", &folders),
            WaitFolder::Create("Waiting for reply".into())
        );
        // Chosen and gone: made again under its name.
        assert_eq!(
            waiting_folder("Ожидание", "Ждут ответа", &folders),
            WaitFolder::Create("Ожидание".into())
        );
    }
}
