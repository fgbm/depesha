//! The address book and the rules of a person (#66, #44), and the state of the suggestions
//! (#69). The book is built on the table of addresses the cache keeps for completion: every
//! address of the correspondence is in it, and a person's own row holds what the user
//! decided about them — the name to show, the format to write in, the form to show their
//! letters, a note, and whether completion hides the address. One person is one address in
//! 0.7; joining several addresses into one person is a task of its own. The suggestions
//! keep one row per hint and subject: accepted, refused for this person or for everyone,
//! «not now», or shown and left unanswered. Nothing here is tied to a mailbox: a rule about
//! a person follows them wherever their letters arrive.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::Store;
use crate::Result;

/// A person of the address book, as the page lists them. The record's own fields stand over
/// what the correspondence says; `uses` comes from the letters, not from the record.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub email: String,
    /// The name shown and offered in completion: the user's own over the letters' spelling.
    pub name: String,
    /// Which format letters to them are written in; empty follows the mailbox (`html`,
    /// `markdown`, `plain`).
    pub send_format: String,
    /// Which form of their letters the reader shows; empty follows the mailbox, then the
    /// app (`html`, `markdown`, `text`).
    pub view: String,
    pub note: String,
    /// Kept out of address completion.
    pub hidden: bool,
    /// Added by hand; one seen only in the correspondence is not.
    pub manual: bool,
    /// The hint that set a rule (#69); empty when it was set by hand.
    pub via: String,
    /// When the user last saved the record, Unix time; 0 for one without a record.
    pub saved: i64,
    /// Letters carrying the address, both ways; read from the cache, not kept here.
    #[serde(default)]
    pub uses: i64,
}

/// What was decided about one suggestion and one subject (#69). `subject` is the address the
/// decision is about, or empty for a decision about the hint itself («to anyone»). `decision`
/// is `accepted`, `dismissed` («not now»), `never` or `shown` (shown, left unanswered).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HintState {
    pub id: String,
    pub subject: String,
    pub decision: String,
    #[serde(default)]
    pub shows: i64,
    #[serde(default)]
    pub refusals: i64,
    #[serde(default)]
    pub decided: i64,
    #[serde(default)]
    pub shown: i64,
}

/// How many times a detector of #69 saw what it watches, per hint and subject: the Markdown
/// letters sent to an address, the view switches over a sender's letters. The engine's
/// thresholds (`hints.ts`) are read against `n`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HintCount {
    pub id: String,
    pub subject: String,
    #[serde(default)]
    pub n: i64,
    #[serde(default)]
    pub at: i64,
}

/// 13: the address book and the suggestions of 0.7. Both are new tables beside the cache's
/// own, so no old row moves: the addresses completion already keeps are the book's base, and
/// a rule about a person is a row over them.
pub(super) fn v13_people_and_hints(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "-- What the user decided about an address: the name to show, the format to write
         -- in, the form to show its letters, a note, and whether completion hides it.
         CREATE TABLE people (
             email       TEXT PRIMARY KEY,
             name        TEXT NOT NULL DEFAULT '',
             send_format TEXT NOT NULL DEFAULT '',
             view        TEXT NOT NULL DEFAULT '',
             note        TEXT NOT NULL DEFAULT '',
             hidden      INTEGER NOT NULL DEFAULT 0,
             manual      INTEGER NOT NULL DEFAULT 0,
             via         TEXT NOT NULL DEFAULT '',
             saved       INTEGER NOT NULL DEFAULT 0
         ) WITHOUT ROWID;

         -- What was decided about a suggestion: per hint, per subject (an address, or ''
         -- for the hint itself). decision: accepted / dismissed / never / shown.
         CREATE TABLE hints (
             id       TEXT NOT NULL,
             subject  TEXT NOT NULL DEFAULT '',
             decision TEXT NOT NULL,
             shows    INTEGER NOT NULL DEFAULT 0,
             refusals INTEGER NOT NULL DEFAULT 0,
             decided  INTEGER NOT NULL DEFAULT 0,
             shown    INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (id, subject)
         ) WITHOUT ROWID;",
    )?;
    Ok(())
}

/// 14: the counters of the detectors of #69 — how many Markdown letters an address got, how
/// many times a sender's letters had their form switched. One row per hint and subject; the
/// engine's thresholds are read against `n`, and a rule set or a hint answered clears its row.
pub(super) fn v14_hint_counts(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE hint_counts (
             id      TEXT NOT NULL,
             subject TEXT NOT NULL DEFAULT '',
             n       INTEGER NOT NULL DEFAULT 0,
             at      INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (id, subject)
         ) WITHOUT ROWID;",
    )?;
    Ok(())
}

/// The columns of a person row, in the order the queries below return them.
const PERSON_COLUMNS: &str = "email, name, send_format, view, note, hidden, manual, via, saved";

fn person_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Person> {
    Ok(Person {
        email: r.get(0)?,
        name: r.get(1)?,
        send_format: r.get(2)?,
        view: r.get(3)?,
        note: r.get(4)?,
        hidden: r.get(5)?,
        manual: r.get(6)?,
        via: r.get(7)?,
        saved: r.get(8)?,
        uses: 0,
    })
}

fn hint_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HintState> {
    Ok(HintState {
        id: r.get(0)?,
        subject: r.get(1)?,
        decision: r.get(2)?,
        shows: r.get(3)?,
        refusals: r.get(4)?,
        decided: r.get(5)?,
        shown: r.get(6)?,
    })
}

impl Store {
    /// The address book: every address of the correspondence with what was decided about it,
    /// and a row for every address added by hand. `query` keeps the ones whose name, address
    /// or note holds it. Sorted by the name shown, so the list reads as people, not addresses.
    pub fn people(&self, query: &str) -> Result<Vec<Person>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "WITH mail AS (
                 SELECT fold(email) AS k, MAX(email) AS email, MAX(NULLIF(name, '')) AS name,
                     SUM(uses) AS uses
                 FROM addresses GROUP BY fold(email)
             )
             SELECT COALESCE(p.email, m.email),
                 CASE WHEN p.name IS NOT NULL AND p.name != '' THEN p.name ELSE COALESCE(m.name, '') END,
                 COALESCE(p.send_format, ''), COALESCE(p.view, ''), COALESCE(p.note, ''),
                 COALESCE(p.hidden, 0), COALESCE(p.manual, 0), COALESCE(p.via, ''), COALESCE(p.saved, 0),
                 COALESCE(m.uses, 0)
             FROM mail m LEFT JOIN people p ON fold(p.email) = m.k
             UNION ALL
             SELECT p.email, p.name, p.send_format, p.view, p.note, p.hidden, p.manual, p.via, p.saved, 0
             FROM people p WHERE fold(p.email) NOT IN (SELECT k FROM mail)",
        )?;
        let mut people: Vec<Person> = stmt
            .query_map([], |r| {
                let mut p = person_row(r)?;
                p.uses = r.get(9)?;
                Ok(p)
            })?
            .collect::<rusqlite::Result<_>>()?;
        let q = query.trim().to_lowercase();
        if !q.is_empty() {
            people.retain(|p| {
                p.name.to_lowercase().contains(&q)
                    || p.email.to_lowercase().contains(&q)
                    || p.note.to_lowercase().contains(&q)
            });
        }
        people.sort_by_cached_key(|p| {
            let shown = if p.name.is_empty() {
                p.email.clone()
            } else {
                p.name.clone()
            };
            (shown.to_lowercase(), p.email.to_lowercase())
        });
        Ok(people)
    }

    /// The record kept about one address, or none: the addresses of the correspondence
    /// without a rule are not records, so this tells a rule from their absence.
    pub fn person(&self, email: &str) -> Result<Option<Person>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {PERSON_COLUMNS} FROM people WHERE fold(email) = fold(?1)"),
                [email],
                person_row,
            )
            .optional()?)
    }

    /// Saves a person's record. One row per address, whatever its case: another spelling of
    /// the same address is replaced, not added beside it.
    pub fn save_person(&self, p: &Person) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM people WHERE fold(email) = fold(?1) AND email != ?1",
            [&p.email],
        )?;
        conn.execute(
            "INSERT INTO people (email, name, send_format, view, note, hidden, manual, via, saved)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (email) DO UPDATE SET
                 name = excluded.name, send_format = excluded.send_format, view = excluded.view,
                 note = excluded.note, hidden = excluded.hidden, manual = excluded.manual,
                 via = excluded.via, saved = excluded.saved",
            params![
                p.email,
                p.name,
                p.send_format,
                p.view,
                p.note,
                p.hidden,
                p.manual,
                p.via,
                p.saved
            ],
        )?;
        Ok(())
    }

    /// Removes a record, hiding the address from the book. Only one added by hand can go: one
    /// that came from the correspondence would return with the next letter, so it stays, and
    /// the address is hidden instead. Says whether anything was removed.
    pub fn forget_person(&self, email: &str) -> Result<bool> {
        Ok(self.conn().execute(
            "DELETE FROM people WHERE fold(email) = fold(?1) AND manual = 1",
            [email],
        )? > 0)
    }

    /// Every decision about the suggestions, in a settled order.
    pub fn hints(&self) -> Result<Vec<HintState>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT id, subject, decision, shows, refusals, decided, shown FROM hints ORDER BY id, subject")?;
        Ok(stmt.query_map([], hint_row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// Writes one decision about one suggestion; the subject is kept without its case.
    pub fn save_hint(&self, h: &HintState) -> Result<()> {
        self.conn().execute(
            "INSERT INTO hints (id, subject, decision, shows, refusals, decided, shown)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (id, subject) DO UPDATE SET
                 decision = excluded.decision, shows = excluded.shows, refusals = excluded.refusals,
                 decided = excluded.decided, shown = excluded.shown",
            params![
                h.id,
                h.subject.trim().to_lowercase(),
                h.decision,
                h.shows,
                h.refusals,
                h.decided,
                h.shown
            ],
        )?;
        Ok(())
    }

    /// Forgets every decision about the suggestions: the switch of the page «Hints» that
    /// asks the refused ones again.
    pub fn clear_hints(&self) -> Result<()> {
        self.conn().execute("DELETE FROM hints", [])?;
        Ok(())
    }

    /// The counters of the detectors of #69, in a settled order.
    pub fn hint_counts(&self) -> Result<Vec<HintCount>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id, subject, n, at FROM hint_counts ORDER BY id, subject")?;
        Ok(stmt
            .query_map([], |r| {
                Ok(HintCount {
                    id: r.get(0)?,
                    subject: r.get(1)?,
                    n: r.get(2)?,
                    at: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Counts one more happening for a detector and says how many there are now; the subject
    /// is kept without its case.
    pub fn count_hint(&self, id: &str, subject: &str, now: i64) -> Result<i64> {
        let subject = subject.trim().to_lowercase();
        self.conn().execute(
            "INSERT INTO hint_counts (id, subject, n, at) VALUES (?1, ?2, 1, ?3)
             ON CONFLICT (id, subject) DO UPDATE SET n = n + 1, at = excluded.at",
            params![id, subject, now],
        )?;
        Ok(self.conn().query_row(
            "SELECT n FROM hint_counts WHERE id = ?1 AND subject = ?2",
            params![id, subject],
            |r| r.get(0),
        )?)
    }

    /// Forgets a detector's count: a rule was set or the hint was answered.
    pub fn clear_hint_count(&self, id: &str, subject: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM hint_counts WHERE id = ?1 AND subject = ?2",
            params![id, subject.trim().to_lowercase()],
        )?;
        Ok(())
    }

    /// Forgets the counters of every detector: «Ask them again» on the page «Hints».
    pub fn clear_all_hint_counts(&self) -> Result<()> {
        self.conn().execute("DELETE FROM hint_counts", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{mailbox, put};
    use super::*;
    use crate::message::{Addr, Summary};

    fn wrote(from: &str, name: &str) -> Summary {
        Summary {
            subject: "Письмо".into(),
            from: Some(Addr {
                name: Some(name.into()),
                email: from.into(),
            }),
            date: Some(100),
            ..Default::default()
        }
    }

    fn person(email: &str, fields: impl FnOnce(&mut Person)) -> Person {
        let mut p = Person {
            email: email.into(),
            ..Default::default()
        };
        fields(&mut p);
        p
    }

    #[test]
    fn the_book_reads_the_correspondence_and_keeps_a_rule_over_it() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("Ivan@Example.org", "Иван Петров"), true);
        put(&store, "INBOX", 2, &wrote("olga@example.org", "Ольга"), true);

        // Both are in the book though neither has a record yet, with the letters counted.
        let book = store.people("").unwrap();
        assert_eq!(book.len(), 2);
        let ivan = |p: &Person| p.email.eq_ignore_ascii_case("ivan@example.org");
        assert_eq!(book.iter().find(|p| ivan(p)).unwrap().name, "Иван Петров");
        assert!(book.iter().find(|p| ivan(p)).unwrap().uses >= 1);

        // A rule is a record over the address; the letters stay counted.
        store
            .save_person(&person("ivan@example.org", |p| {
                p.name = "Иван П.".into();
                p.send_format = "plain".into();
                p.view = "markdown".into();
                p.note = "зал у Ольги".into();
                p.manual = true;
                p.saved = 500;
            }))
            .unwrap();
        let back = store.person("IVAN@example.org").unwrap().unwrap();
        assert_eq!(back.name, "Иван П.");
        assert_eq!(back.send_format, "plain");
        assert_eq!(back.view, "markdown");
        assert!(back.manual && back.saved == 500);
        let shown = store.people("зал").unwrap();
        assert_eq!(shown.len(), 1, "the note is searched");
        assert_eq!(shown[0].email, "ivan@example.org");
        assert!(shown[0].uses >= 1, "the rule does not lose the counted letters");

        // Hiding keeps the record, and the address stays in the book.
        store
            .save_person(&person("ivan@example.org", |p| {
                p.hidden = true;
                p.manual = true;
            }))
            .unwrap();
        assert!(store.person("ivan@example.org").unwrap().unwrap().hidden);
    }

    #[test]
    fn one_row_per_address_whatever_its_case() {
        let store = mailbox();
        store
            .save_person(&person("Ivan@Example.org", |p| p.send_format = "html".into()))
            .unwrap();
        store
            .save_person(&person("ivan@example.org", |p| p.send_format = "plain".into()))
            .unwrap();
        // The second spelling replaced the first rather than standing beside it.
        assert_eq!(store.people("").unwrap().len(), 1);
        assert_eq!(store.person("ivan@EXAMPLE.org").unwrap().unwrap().send_format, "plain");
    }

    #[test]
    fn a_person_added_by_hand_can_go_a_sender_cannot() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("ivan@example.org", "Иван"), true);
        store
            .save_person(&person("ivan@example.org", |p| p.send_format = "plain".into()))
            .unwrap();
        // From the correspondence: the record cannot be removed, only hidden.
        assert!(!store.forget_person("ivan@example.org").unwrap());
        assert!(store.person("ivan@example.org").unwrap().is_some());
        // Added by hand: it goes.
        store
            .save_person(&person("new@example.org", |p| {
                p.manual = true;
                p.name = "Новый".into();
            }))
            .unwrap();
        assert!(store.forget_person("new@example.org").unwrap());
        assert!(store.person("new@example.org").unwrap().is_none());
    }

    #[test]
    fn the_decisions_about_suggestions_round_trip() {
        let store = mailbox();
        assert!(store.hints().unwrap().is_empty());
        store
            .save_hint(&HintState {
                id: "send-format".into(),
                subject: "Ivan@X".into(),
                decision: "dismissed".into(),
                refusals: 1,
                decided: 700,
                ..Default::default()
            })
            .unwrap();
        store
            .save_hint(&HintState {
                id: "send-format".into(),
                subject: String::new(),
                decision: "never".into(),
                decided: 800,
                ..Default::default()
            })
            .unwrap();
        let hints = store.hints().unwrap();
        assert_eq!(hints.len(), 2);
        // The subject is kept without its case; the hint's own decision under an empty one.
        assert_eq!(hints[0].subject, String::new());
        assert_eq!(hints[1].subject, "ivan@x");
        assert_eq!(hints[1].refusals, 1);
        // Answering again replaces the row rather than adding one.
        store
            .save_hint(&HintState {
                id: "send-format".into(),
                subject: "ivan@x".into(),
                decision: "accepted".into(),
                decided: 900,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(store.hints().unwrap().len(), 2);
        assert_eq!(store.person("ivan@x").unwrap(), None);
        store.clear_hints().unwrap();
        assert!(store.hints().unwrap().is_empty());
    }

    #[test]
    fn the_detectors_counters_round_trip() {
        let store = mailbox();
        assert!(store.hint_counts().unwrap().is_empty());
        // Counting one more happening returns the new count; the subject keeps no case.
        assert_eq!(store.count_hint("send-format", "ivan@x", 100).unwrap(), 1);
        assert_eq!(store.count_hint("send-format", "IVAN@X", 200).unwrap(), 2);
        let counts = store.hint_counts().unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].id, "send-format");
        assert_eq!(counts[0].subject, "ivan@x");
        assert_eq!(counts[0].n, 2);
        assert_eq!(counts[0].at, 200);
        // Another detector keeps its own row.
        assert_eq!(store.count_hint("incoming-view", "ivan@x", 300).unwrap(), 1);
        assert_eq!(store.hint_counts().unwrap().len(), 2);
        store.clear_hint_count("send-format", "ivan@X").unwrap();
        let left = store.hint_counts().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "incoming-view");
    }
}
