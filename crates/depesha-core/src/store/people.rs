//! The address book and the rules of a person (#66, #44, #104), and the state of the
//! suggestions (#69). A person is a record with one or more addresses: the name to show, the
//! format to write in, the form to show their letters, a note, and whether completion hides
//! them. The addresses of the correspondence the cache keeps for completion are the book's
//! base: one without a record is a person of that one address (`id` 0) until the user decides
//! something about it. Several addresses join into one person by a merge, which hands back a
//! snapshot that restores everything as it was; an address leaves a person by a split. The
//! suggestions keep one row per hint and subject: accepted, refused for this person or for
//! everyone, «not now», or shown and left unanswered. Nothing here is tied to a mailbox: a
//! rule about a person follows them wherever their letters arrive.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::Store;
use crate::message::clean_name;
use crate::{Error, Result};

/// One address of a person.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PersonAddress {
    pub email: String,
    /// The one shown in the list and offered first in completion; exactly one per person.
    pub primary: bool,
    /// Letters carrying the address, both ways; read from the cache, not kept here.
    pub uses: i64,
    /// The name the letters give this address; empty when they give none. Kept apart from
    /// the person's own name: it is what an address gets back when it leaves the person.
    pub name: String,
    /// The address is in the correspondence (a letter carries it), whatever the count of letters:
    /// the key a forgetting reads to tell «gone» from «only unmarked».
    pub heard: bool,
}

/// A person of the address book, as the page lists them. The record's own fields stand over
/// what the correspondence says; `uses` comes from the letters, not from the record.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Person {
    /// The record's key; 0 for an address seen only in the correspondence, which has no
    /// record yet.
    pub id: i64,
    /// The primary address.
    pub email: String,
    /// Every address, the primary one first.
    pub emails: Vec<PersonAddress>,
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
    /// Letters carrying any of the addresses; read from the cache, not kept here.
    pub uses: i64,
    /// Any of the addresses is in the correspondence: forgetting the person only unmarks them
    /// then (see `forget_person`).
    pub heard: bool,
}

/// What a merge asks for: the people to join (any one address of each), and what the dialog
/// settled — the name to keep, the primary address and the rules.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Merge {
    pub emails: Vec<String>,
    pub name: String,
    pub primary: String,
    pub send_format: String,
    pub view: String,
    pub hidden: bool,
}

/// One row of `persons`, kept in a snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonRow {
    pub id: i64,
    pub name: String,
    pub send_format: String,
    pub view: String,
    pub note: String,
    pub hidden: bool,
    pub manual: bool,
    pub via: String,
    pub saved: i64,
}

/// One row of `person_addresses`, kept in a snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddressRow {
    pub key: String,
    pub email: String,
    pub person_id: i64,
    pub primary: bool,
    pub ord: i64,
}

/// Everything a merge or a split touched, as it was before: handing it back to `restore`
/// puts the people, their rules, notes and the order of their addresses back.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub persons: Vec<PersonRow>,
    pub addresses: Vec<AddressRow>,
    /// Records the operation created: they go on a restore.
    pub created: Vec<i64>,
    /// Decisions about «the same person» the operation wrote: they go too.
    pub hints: Vec<String>,
    /// Addresses of the correspondence without a record that the operation joined to a person:
    /// they are the snapshot's too, though no row of theirs is in it.
    #[serde(default)]
    pub loose: Vec<String>,
    /// The operation only took the mark «added by hand» off (a forgetting of a person the
    /// correspondence knows): a restore puts the mark back and leaves what was written since.
    #[serde(default)]
    pub unmarked: bool,
}

/// The outcome of a merge: the joint person and the way back.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Merged {
    pub person: Person,
    pub undo: Snapshot,
}

/// The outcome of a split: the address as a person of its own, the person it left, and the
/// way back.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Split {
    pub person: Person,
    pub origin: Person,
    pub undo: Snapshot,
}

/// The outcome of adding an address to a person: the person, or — when the address is
/// already another person's — that person, and nothing is added.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Added {
    pub person: Option<Person>,
    pub owner: Option<Person>,
}

/// The outcome of forgetting a person: gone whole, or only unmarked (see `forget_person`), and
/// the way back.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Forgotten {
    pub removed: bool,
    pub unmarked: bool,
    pub undo: Snapshot,
}

/// A person for address completion: the primary address to insert, and all of the person's
/// addresses to choose from (the primary one first).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Suggestion {
    pub email: String,
    pub name: Option<String>,
    pub emails: Vec<String>,
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

/// The hint that remembers two people are not one (#104): a refusal per pair of addresses.
pub const SAME_PERSON: &str = "same-person";

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

/// 23: a person with several addresses (#104). A person gets a key of their own and their
/// addresses hang on it; each old row of `people` — one address and its rules — becomes one
/// person with that one address as the primary, every field carried over, so no rule is
/// lost. The old table is kept under another name for a release, so the rules stay readable
/// if the step must be looked at again; nothing reads it. The step touches nothing else, and
/// uses no function of the connection, as the others before it.
pub(super) fn v23_persons_and_addresses(conn: &Connection) -> Result<()> {
    // A cache set back to an earlier number by hand (the tests of other steps do) already
    // has the tables, and its old book is gone: nothing to carry over twice.
    let done: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'persons')",
        [],
        |r| r.get(0),
    )?;
    if done {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TABLE persons (
             -- AUTOINCREMENT: the key of a person that went (merged away, forgotten) is never given
             -- to another, so the snapshot of an undo cannot meet a stranger under its key.
             id          INTEGER PRIMARY KEY AUTOINCREMENT,
             name        TEXT NOT NULL DEFAULT '',
             send_format TEXT NOT NULL DEFAULT '',
             view        TEXT NOT NULL DEFAULT '',
             note        TEXT NOT NULL DEFAULT '',
             hidden      INTEGER NOT NULL DEFAULT 0,
             manual      INTEGER NOT NULL DEFAULT 0,
             via         TEXT NOT NULL DEFAULT '',
             saved       INTEGER NOT NULL DEFAULT 0
         );

         -- An address belongs to at most one person: `key` is the address without its case.
         CREATE TABLE person_addresses (
             key        TEXT PRIMARY KEY,
             email      TEXT NOT NULL,
             person_id  INTEGER NOT NULL REFERENCES persons (id) ON DELETE CASCADE,
             is_primary INTEGER NOT NULL DEFAULT 0,
             ord        INTEGER NOT NULL DEFAULT 0
         ) WITHOUT ROWID;
         CREATE UNIQUE INDEX person_one_primary ON person_addresses (person_id) WHERE is_primary = 1;
         CREATE INDEX person_addresses_by_person ON person_addresses (person_id, ord);",
    )?;
    let old: Vec<(String, PersonRow)> = {
        let mut stmt = conn.prepare(
            "SELECT email, name, send_format, view, note, hidden, manual, via, saved FROM people ORDER BY saved DESC, email",
        )?;
        stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                PersonRow {
                    id: 0,
                    name: r.get(1)?,
                    send_format: r.get(2)?,
                    view: r.get(3)?,
                    note: r.get(4)?,
                    hidden: r.get(5)?,
                    manual: r.get(6)?,
                    via: r.get(7)?,
                    saved: r.get(8)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    for (email, p) in old {
        let key = email.trim().to_lowercase();
        // Two old rows differing only in case would be one address: the one saved last stands.
        let taken: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM person_addresses WHERE key = ?1)",
            [&key],
            |r| r.get(0),
        )?;
        if key.is_empty() || taken {
            continue;
        }
        conn.execute(
            "INSERT INTO persons (name, send_format, view, note, hidden, manual, via, saved)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
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
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO person_addresses (key, email, person_id, is_primary, ord) VALUES (?1, ?2, ?3, 1, 0)",
            params![key, email, id],
        )?;
    }
    conn.execute_batch("ALTER TABLE people RENAME TO people_v22;")?;
    Ok(())
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

/// The address without its case: the key an address is told apart by.
fn key_of(email: &str) -> String {
    email.trim().to_lowercase()
}

/// A letter-name of an address as the book shows it: cleaned of its quotes.
type MailIndex = HashMap<String, (String, String, i64)>;

/// What the letters hold, by address key: the spelling, the name (cleaned of the quotes its
/// mail program wrapped it in) and the count of letters. With `keys`, only those addresses.
fn mail_index(conn: &Connection, keys: Option<&[String]>) -> Result<MailIndex> {
    let mut sql =
        String::from("SELECT fold(email), MAX(email), COALESCE(MAX(NULLIF(name, '')), ''), SUM(uses) FROM addresses");
    if let Some(keys) = keys {
        if keys.is_empty() {
            return Ok(MailIndex::new());
        }
        sql.push_str(&format!(" WHERE fold(email) IN ({})", vec!["?"; keys.len()].join(",")));
    }
    sql.push_str(" GROUP BY fold(email)");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(keys.unwrap_or(&[]).iter()), |r| {
        Ok((
            r.get::<_, String>(0)?,
            (
                r.get::<_, String>(1)?,
                clean_name(&r.get::<_, String>(2)?),
                r.get::<_, i64>(3)?,
            ),
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn person_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Person> {
    Ok(Person {
        id: r.get(0)?,
        name: r.get(1)?,
        send_format: r.get(2)?,
        view: r.get(3)?,
        note: r.get(4)?,
        hidden: r.get(5)?,
        manual: r.get(6)?,
        via: r.get(7)?,
        saved: r.get(8)?,
        ..Default::default()
    })
}

const PERSON_COLUMNS: &str = "id, name, send_format, view, note, hidden, manual, via, saved";

/// The addresses of a person as the book lists them: the primary first, the rest as they
/// were added, each with its letters and its name from them.
fn addresses_with_mail(rows: Vec<AddressRow>, mail: &MailIndex) -> Vec<PersonAddress> {
    rows.into_iter()
        .map(|a| {
            let (name, uses) = mail.get(&a.key).map(|(_, n, u)| (n.clone(), *u)).unwrap_or_default();
            PersonAddress {
                email: a.email,
                primary: a.primary,
                uses,
                name,
                heard: mail.contains_key(&a.key),
            }
        })
        .collect()
}

/// Fills in what the cache says of a person: the primary address, the count of letters, and
/// the name — the user's own, else the first the letters give.
fn finish(p: &mut Person) {
    p.email = p.emails.first().map(|a| a.email.clone()).unwrap_or_default();
    p.uses = p.emails.iter().map(|a| a.uses).sum();
    p.heard = p.emails.iter().any(|a| a.heard);
    if p.name.is_empty() {
        p.name = letters_name(&p.emails);
    }
}

/// The name the letters give a person: the primary address's, else the next that has one.
fn letters_name(emails: &[PersonAddress]) -> String {
    emails
        .iter()
        .map(|a| a.name.clone())
        .find(|n| !n.is_empty())
        .unwrap_or_default()
}

fn owner(conn: &Connection, key: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row("SELECT person_id FROM person_addresses WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}

fn address_rows(conn: &Connection, id: i64) -> Result<Vec<AddressRow>> {
    let mut stmt = conn.prepare(
        "SELECT key, email, person_id, is_primary, ord FROM person_addresses
         WHERE person_id = ?1 ORDER BY is_primary DESC, ord, key",
    )?;
    Ok(stmt
        .query_map([id], |r| {
            Ok(AddressRow {
                key: r.get(0)?,
                email: r.get(1)?,
                person_id: r.get(2)?,
                primary: r.get(3)?,
                ord: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn person_rows(conn: &Connection, ids: &[i64]) -> Result<Vec<PersonRow>> {
    let mut out = Vec::new();
    for id in ids {
        out.extend(
            conn.query_row(
                &format!("SELECT {PERSON_COLUMNS} FROM persons WHERE id = ?1"),
                [id],
                |r| {
                    Ok(PersonRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        send_format: r.get(2)?,
                        view: r.get(3)?,
                        note: r.get(4)?,
                        hidden: r.get(5)?,
                        manual: r.get(6)?,
                        via: r.get(7)?,
                        saved: r.get(8)?,
                    })
                },
            )
            .optional()?,
        );
    }
    Ok(out)
}

fn insert_address(conn: &Connection, a: &AddressRow) -> Result<()> {
    conn.execute(
        "INSERT INTO person_addresses (key, email, person_id, is_primary, ord) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![a.key, a.email, a.person_id, a.primary, a.ord],
    )?;
    Ok(())
}

fn insert_person_row(conn: &Connection, p: &PersonRow) -> Result<()> {
    conn.execute(
        "INSERT INTO persons (id, name, send_format, view, note, hidden, manual, via, saved)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            p.id,
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

/// Reads one person with their addresses and letters; none when the key is gone.
fn load(conn: &Connection, id: i64) -> Result<Option<Person>> {
    let Some(mut p) = conn
        .query_row(
            &format!("SELECT {PERSON_COLUMNS} FROM persons WHERE id = ?1"),
            [id],
            person_from,
        )
        .optional()?
    else {
        return Ok(None);
    };
    let rows = address_rows(conn, id)?;
    let keys: Vec<String> = rows.iter().map(|a| a.key.clone()).collect();
    p.emails = addresses_with_mail(rows, &mail_index(conn, Some(&keys))?);
    finish(&mut p);
    Ok(Some(p))
}

/// Reads several people at once: their rows, their addresses and what the letters hold of
/// those, in three queries whatever their number.
fn load_many(conn: &Connection, ids: &[i64]) -> Result<HashMap<i64, Person>> {
    let mut out: HashMap<i64, Person> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let marks = vec!["?"; ids.len()].join(",");
    {
        let mut stmt = conn.prepare(&format!("SELECT {PERSON_COLUMNS} FROM persons WHERE id IN ({marks})"))?;
        for p in stmt.query_map(rusqlite::params_from_iter(ids), person_from)? {
            let p = p?;
            out.insert(p.id, p);
        }
    }
    let mut rows: HashMap<i64, Vec<AddressRow>> = HashMap::new();
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT key, email, person_id, is_primary, ord FROM person_addresses
             WHERE person_id IN ({marks}) ORDER BY person_id, is_primary DESC, ord, key"
        ))?;
        let all = stmt.query_map(rusqlite::params_from_iter(ids), |r| {
            Ok(AddressRow {
                key: r.get(0)?,
                email: r.get(1)?,
                person_id: r.get(2)?,
                primary: r.get(3)?,
                ord: r.get(4)?,
            })
        })?;
        for a in all {
            let a = a?;
            rows.entry(a.person_id).or_default().push(a);
        }
    }
    let keys: Vec<String> = rows.values().flatten().map(|a| a.key.clone()).collect();
    let mail = mail_index(conn, Some(&keys))?;
    for (id, p) in &mut out {
        p.emails = addresses_with_mail(rows.remove(id).unwrap_or_default(), &mail);
        finish(p);
    }
    Ok(out)
}

/// The record of an address, made when there is none: a person of that one address with no
/// rule yet.
fn ensure(conn: &Connection, email: &str) -> Result<i64> {
    let key = key_of(email);
    if let Some(id) = owner(conn, &key)? {
        return Ok(id);
    }
    conn.execute("INSERT INTO persons DEFAULT VALUES", [])?;
    let id = conn.last_insert_rowid();
    let spelled = spelling(conn, &key, email)?;
    insert_address(
        conn,
        &AddressRow {
            key,
            email: spelled,
            person_id: id,
            primary: true,
            ord: 0,
        },
    )?;
    Ok(id)
}

/// How an address is written: as the letters spell it, else as it was given.
fn spelling(conn: &Connection, key: &str, given: &str) -> Result<String> {
    let seen: Option<String> = conn
        .query_row("SELECT MAX(email) FROM addresses WHERE fold(email) = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();
    Ok(seen.unwrap_or_else(|| given.trim().to_owned()))
}

/// The pair of keys a decision «the same person» is kept under.
fn pair_subject(a: &str, b: &str) -> String {
    let (a, b) = (key_of(a), key_of(b));
    if a <= b { format!("{a}|{b}") } else { format!("{b}|{a}") }
}

impl Store {
    /// The address book: every person with a record, and every address of the correspondence
    /// without one as a person of that address. `query` keeps the ones whose name, an
    /// address or note holds it. Sorted by the name shown, so the list reads as people.
    pub fn people(&self, query: &str) -> Result<Vec<Person>> {
        let conn = self.conn();
        let mail = mail_index(&conn, None)?;
        let mut by_person: HashMap<i64, Vec<AddressRow>> = HashMap::new();
        let mut owned: std::collections::HashSet<String> = std::collections::HashSet::new();
        {
            let mut stmt = conn.prepare(
                "SELECT key, email, person_id, is_primary, ord FROM person_addresses
                 ORDER BY person_id, is_primary DESC, ord, key",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(AddressRow {
                    key: r.get(0)?,
                    email: r.get(1)?,
                    person_id: r.get(2)?,
                    primary: r.get(3)?,
                    ord: r.get(4)?,
                })
            })?;
            for row in rows {
                let row = row?;
                owned.insert(row.key.clone());
                by_person.entry(row.person_id).or_default().push(row);
            }
        }
        let mut people: Vec<Person> = {
            let mut stmt = conn.prepare(&format!("SELECT {PERSON_COLUMNS} FROM persons"))?;
            stmt.query_map([], person_from)?.collect::<rusqlite::Result<_>>()?
        };
        for p in &mut people {
            p.emails = addresses_with_mail(by_person.remove(&p.id).unwrap_or_default(), &mail);
            finish(p);
        }
        people.retain(|p| !p.emails.is_empty());
        // The addresses of the correspondence nobody has decided about: one person each.
        for (key, (email, name, uses)) in &mail {
            if owned.contains(key) {
                continue;
            }
            let mut p = Person {
                emails: vec![PersonAddress {
                    email: email.clone(),
                    primary: true,
                    uses: *uses,
                    name: name.clone(),
                    heard: true,
                }],
                ..Default::default()
            };
            finish(&mut p);
            people.push(p);
        }
        let q = query.trim().to_lowercase();
        if !q.is_empty() {
            people.retain(|p| {
                p.name.to_lowercase().contains(&q)
                    || p.emails.iter().any(|a| a.email.to_lowercase().contains(&q))
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

    /// The record kept about one address (whichever of the person's it is), or none: the
    /// addresses of the correspondence without a rule are not records, so this tells a rule
    /// from their absence.
    pub fn person(&self, email: &str) -> Result<Option<Person>> {
        let conn = self.conn();
        match owner(&conn, &key_of(email))? {
            Some(id) => load(&conn, id),
            None => Ok(None),
        }
    }

    /// Saves a person's record: the fields of the person, not their addresses (those change
    /// by `person_add_address`, `person_set_primary`, merges and splits). A record without a
    /// key is looked for by its address, and made when the address has none. A name that is
    /// only what the letters say is not kept as the user's own, so a rule set on a person
    /// does not freeze the name the letters give them. Returns the record as it is now.
    pub fn save_person(&self, p: &Person) -> Result<Person> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let live: Option<i64> = if p.id != 0 {
            tx.query_row("SELECT id FROM persons WHERE id = ?1", [p.id], |r| r.get(0))
                .optional()?
        } else {
            None
        };
        let id = match live {
            Some(id) => id,
            None => {
                if key_of(&p.email).is_empty() {
                    return Err(Error::NotFound);
                }
                ensure(&tx, &p.email)?
            }
        };
        let rows = address_rows(&tx, id)?;
        let keys: Vec<String> = rows.iter().map(|a| a.key.clone()).collect();
        let emails = addresses_with_mail(rows, &mail_index(&tx, Some(&keys))?);
        let name = if p.name == letters_name(&emails) {
            ""
        } else {
            p.name.as_str()
        };
        tx.execute(
            "UPDATE persons SET name = ?2, send_format = ?3, view = ?4, note = ?5, hidden = ?6,
                 manual = ?7, via = ?8, saved = ?9 WHERE id = ?1",
            params![
                id,
                name,
                p.send_format,
                p.view,
                p.note,
                p.hidden,
                p.manual,
                p.via,
                p.saved
            ],
        )?;
        let saved = load(&tx, id)?.ok_or(Error::NotFound)?;
        tx.commit()?;
        Ok(saved)
    }

    /// Removes a person added by hand (#104). One whose addresses are all unknown to the
    /// correspondence goes whole, with their addresses. One with an address that is in the
    /// correspondence would return with the next letter and keep the rules of that address, so
    /// it stays and only the mark «added by hand» comes off. Anyone not added by hand stays as
    /// they are. The snapshot restores what was done.
    pub fn forget_person(&self, email: &str) -> Result<Forgotten> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let none = Forgotten::default();
        let Some(id) = owner(&tx, &key_of(email))? else {
            return Ok(none);
        };
        let rows = person_rows(&tx, &[id])?;
        if !rows.first().is_some_and(|p| p.manual) {
            return Ok(none);
        }
        let mut undo = Snapshot {
            persons: rows,
            addresses: address_rows(&tx, id)?,
            ..Default::default()
        };
        let mut heard = false;
        for a in &undo.addresses {
            heard |= tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM addresses WHERE fold(email) = ?1)",
                [&a.key],
                |r| r.get::<_, bool>(0),
            )?;
        }
        if heard {
            undo.unmarked = true;
            tx.execute("UPDATE persons SET manual = 0 WHERE id = ?1", [id])?;
        } else {
            tx.execute("DELETE FROM persons WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(Forgotten {
            removed: !heard,
            unmarked: heard,
            undo,
        })
    }

    /// Adds an address to the person who has `to` among theirs (made a person if it was an
    /// address of the correspondence alone). An address that is already another person's is
    /// not moved: that person comes back as `owner`, for the caller to offer a merge.
    pub fn person_add_address(&self, to: &str, email: &str) -> Result<Added> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let key = key_of(email);
        if !key.contains('@') || key.contains(char::is_whitespace) {
            return Err(Error::NotFound);
        }
        // Another person's address is refused before anything is made: no empty record for `to`.
        if let Some(other) = owner(&tx, &key)?
            && owner(&tx, &key_of(to))? != Some(other)
        {
            return Ok(Added {
                person: None,
                owner: load(&tx, other)?,
            });
        }
        let id = ensure(&tx, to)?;
        match owner(&tx, &key)? {
            Some(_) => {}
            None => {
                let ord: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(ord), 0) + 1 FROM person_addresses WHERE person_id = ?1",
                    [id],
                    |r| r.get(0),
                )?;
                let spelled = spelling(&tx, &key, email)?;
                insert_address(
                    &tx,
                    &AddressRow {
                        key,
                        email: spelled,
                        person_id: id,
                        primary: false,
                        ord,
                    },
                )?;
            }
        }
        let person = load(&tx, id)?;
        tx.commit()?;
        Ok(Added { person, owner: None })
    }

    /// Makes an address the primary one of its person. None when it is not one of a
    /// person's with a record (a lone address of the correspondence is its own primary).
    pub fn person_set_primary(&self, email: &str) -> Result<Option<Person>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let key = key_of(email);
        let Some(id) = owner(&tx, &key)? else {
            return Ok(None);
        };
        tx.execute("UPDATE person_addresses SET is_primary = 0 WHERE person_id = ?1", [id])?;
        tx.execute("UPDATE person_addresses SET is_primary = 1 WHERE key = ?1", [&key])?;
        let person = load(&tx, id)?;
        tx.commit()?;
        Ok(person)
    }

    /// Joins people into one (#104). Each of `emails` names a person by any of their
    /// addresses; the first with a record is kept and the others, with the addresses of the
    /// correspondence alone, are folded into it. The name, primary address and rules are
    /// what the dialog settled; the notes are joined by an empty line, in the order given.
    /// None when fewer than two people were named. The snapshot restores it all.
    pub fn person_merge(&self, req: &Merge) -> Result<Option<Merged>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        // The people named, once each: their record when they have one, else the lone address.
        struct Part {
            id: Option<i64>,
            rows: Vec<AddressRow>,
        }
        let mut parts: Vec<Part> = Vec::new();
        for email in &req.emails {
            let key = key_of(email);
            if key.is_empty() {
                continue;
            }
            match owner(&tx, &key)? {
                Some(id) if parts.iter().any(|p| p.id == Some(id)) => {}
                Some(id) => parts.push(Part {
                    id: Some(id),
                    rows: address_rows(&tx, id)?,
                }),
                None if parts.iter().any(|p| p.id.is_none() && p.rows[0].key == key) => {}
                None => parts.push(Part {
                    id: None,
                    rows: vec![AddressRow {
                        email: spelling(&tx, &key, email)?,
                        key,
                        ..Default::default()
                    }],
                }),
            }
        }
        if parts.len() < 2 {
            return Ok(None);
        }
        let involved: Vec<i64> = parts.iter().filter_map(|p| p.id).collect();
        let mut undo = Snapshot {
            persons: person_rows(&tx, &involved)?,
            addresses: involved
                .iter()
                .map(|&id| address_rows(&tx, id))
                .collect::<Result<Vec<_>>>()?
                .concat(),
            ..Default::default()
        };
        undo.loose = parts
            .iter()
            .filter(|p| p.id.is_none())
            .map(|p| p.rows[0].key.clone())
            .collect();
        let keep = match involved.first() {
            Some(&id) => id,
            None => {
                tx.execute("INSERT INTO persons DEFAULT VALUES", [])?;
                let id = tx.last_insert_rowid();
                undo.created.push(id);
                id
            }
        };
        // The notes, the origin and the «added by hand» mark of everyone named are kept.
        let mut notes: Vec<String> = Vec::new();
        let (mut manual, mut via) = (false, String::new());
        for row in &undo.persons {
            let note = row.note.trim();
            if !note.is_empty() && !notes.iter().any(|n| n == note) {
                notes.push(note.to_owned());
            }
            manual |= row.manual;
            if via.is_empty() {
                via = row.via.clone();
            }
        }
        // The addresses in order: the primary the dialog chose first, then the rest as they
        // stood, person after person.
        let primary = key_of(&req.primary);
        let mut all: Vec<AddressRow> = parts.iter().flat_map(|p| p.rows.iter().cloned()).collect();
        if let Some(at) = all.iter().position(|a| a.key == primary) {
            let first = all.remove(at);
            all.insert(0, first);
        }
        for id in &involved {
            tx.execute("DELETE FROM person_addresses WHERE person_id = ?1", [id])?;
        }
        for id in involved.iter().filter(|&&id| id != keep) {
            tx.execute("DELETE FROM persons WHERE id = ?1", [id])?;
        }
        for (i, a) in all.iter().enumerate() {
            insert_address(
                &tx,
                &AddressRow {
                    key: a.key.clone(),
                    email: a.email.clone(),
                    person_id: keep,
                    primary: i == 0,
                    ord: i as i64,
                },
            )?;
        }
        // The name the letters give, or an address standing for a name, is not the user's own: it is
        // not kept, so the person goes on showing what their letters say.
        let keys: Vec<String> = all.iter().map(|a| a.key.clone()).collect();
        let joint = addresses_with_mail(all.clone(), &mail_index(&tx, Some(&keys))?);
        let wanted = key_of(&req.name);
        let name = if req.name == letters_name(&joint) || keys.contains(&wanted) {
            ""
        } else {
            req.name.as_str()
        };
        tx.execute(
            "UPDATE persons SET name = ?2, send_format = ?3, view = ?4, note = ?5, hidden = ?6,
                 manual = ?7, via = ?8 WHERE id = ?1",
            params![
                keep,
                name,
                req.send_format,
                req.view,
                notes.join("\n\n"),
                req.hidden,
                manual,
                via
            ],
        )?;
        let person = load(&tx, keep)?.ok_or(Error::NotFound)?;
        tx.commit()?;
        Ok(Some(Merged { person, undo }))
    }

    /// Lets an address leave its person and become one of its own (#104): the name from the
    /// letters, the rules (format, form, hiding) copied, no note and no mark of the hint that set a rule. The pair is remembered as
    /// two people, so it is not offered as a duplicate. None when the person has only that
    /// address. The snapshot restores it.
    pub fn person_split(&self, email: &str) -> Result<Option<Split>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let key = key_of(email);
        let Some(id) = owner(&tx, &key)? else {
            return Ok(None);
        };
        let rows = address_rows(&tx, id)?;
        if rows.len() < 2 || !rows.iter().any(|a| a.key == key) {
            return Ok(None);
        }
        let mut undo = Snapshot {
            persons: person_rows(&tx, &[id])?,
            addresses: rows.clone(),
            ..Default::default()
        };
        let origin = &undo.persons[0];
        let (send_format, view, hidden) = (origin.send_format.clone(), origin.view.clone(), origin.hidden);
        let leaving = rows.iter().find(|a| a.key == key).cloned().unwrap_or_default();
        tx.execute("DELETE FROM person_addresses WHERE key = ?1", [&key])?;
        // The primary address left: the next in order takes its place.
        if leaving.primary
            && let Some(next) = rows.iter().find(|a| a.key != key)
        {
            tx.execute("UPDATE person_addresses SET is_primary = 1 WHERE key = ?1", [&next.key])?;
        }
        tx.execute(
            "INSERT INTO persons (send_format, view, hidden) VALUES (?1, ?2, ?3)",
            params![send_format, view, hidden],
        )?;
        let fresh = tx.last_insert_rowid();
        undo.created.push(fresh);
        insert_address(
            &tx,
            &AddressRow {
                person_id: fresh,
                primary: true,
                ord: 0,
                ..leaving
            },
        )?;
        // The leaving address and the one that stays first are two people, not duplicates.
        let stays = address_rows(&tx, id)?;
        if let Some(first) = stays.first() {
            let subject = pair_subject(&key, &first.key);
            let had: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM hints WHERE id = ?1 AND subject = ?2)",
                params![SAME_PERSON, subject],
                |r| r.get(0),
            )?;
            if !had {
                tx.execute(
                    "INSERT INTO hints (id, subject, decision, refusals, decided) VALUES (?1, ?2, 'never', 1, 0)",
                    params![SAME_PERSON, subject],
                )?;
                undo.hints.push(subject);
            }
        }
        let person = load(&tx, fresh)?.ok_or(Error::NotFound)?;
        let origin = load(&tx, id)?.ok_or(Error::NotFound)?;
        tx.commit()?;
        Ok(Some(Split { person, origin, undo }))
    }

    /// Puts back what a merge, a split or a forgetting changed, as the snapshot holds it. A record
    /// that is not the snapshot's — one that holds an address the snapshot does not know — is not
    /// touched: the snapshot's addresses leave it, and a person of the snapshot whose key it
    /// took is put back under a key of its own.
    pub fn person_restore(&self, undo: &Snapshot) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let known: std::collections::HashSet<&str> = undo
            .addresses
            .iter()
            .map(|a| a.key.as_str())
            .chain(undo.loose.iter().map(String::as_str))
            .collect();
        if undo.unmarked {
            // Only the mark came off: it goes back, and the record keeps whatever was written since.
            // A record that no longer holds the snapshot's addresses is not that person: the general way.
            let mut left = Vec::new();
            for p in &undo.persons {
                let theirs = address_rows(&tx, p.id)?;
                if theirs.iter().any(|a| known.contains(a.key.as_str())) {
                    tx.execute("UPDATE persons SET manual = ?2 WHERE id = ?1", params![p.id, p.manual])?;
                } else {
                    left.push(p.clone());
                }
            }
            if left.is_empty() {
                tx.commit()?;
                return Ok(());
            }
            return Self::restore_into(
                tx,
                &Snapshot {
                    persons: left,
                    ..undo.clone()
                },
                &known,
            );
        }
        Self::restore_into(tx, undo, &known)
    }

    /// The general way back: the records of the snapshot are put as it holds them.
    fn restore_into(
        tx: rusqlite::Transaction<'_>,
        undo: &Snapshot,
        known: &std::collections::HashSet<&str>,
    ) -> Result<()> {
        let mut affected: Vec<i64> = undo.persons.iter().map(|p| p.id).collect();
        affected.extend(&undo.created);
        // Addresses written by hand into a record that goes: they are not in the letters, so they have
        // nowhere to return to, and stay with the owner of the record's primary address.
        let mut carry: Vec<(AddressRow, String)> = Vec::new();
        for id in &affected {
            let theirs: Vec<AddressRow> = address_rows(&tx, *id)?;
            if let Some(home) = theirs
                .iter()
                .find(|a| a.primary && known.contains(a.key.as_str()))
                .or_else(|| theirs.iter().find(|a| known.contains(a.key.as_str())))
            {
                for a in theirs.iter().filter(|a| !known.contains(a.key.as_str())) {
                    let heard: bool = tx.query_row(
                        "SELECT EXISTS (SELECT 1 FROM addresses WHERE fold(email) = ?1)",
                        [&a.key],
                        |r| r.get(0),
                    )?;
                    if !heard {
                        carry.push((a.clone(), home.key.clone()));
                    }
                }
            }
            // A record that holds an address of the snapshot, or none, is the snapshot's own, whatever
            // it gained since (an address added to the joint person goes back to the correspondence
            // with it). One that holds none of them is a stranger under the key: it stays.
            if theirs.is_empty() || theirs.iter().any(|a| known.contains(a.key.as_str())) {
                tx.execute("DELETE FROM persons WHERE id = ?1", [id])?;
            }
        }
        let mut placed: HashMap<i64, i64> = HashMap::new();
        for p in &undo.persons {
            let taken: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM persons WHERE id = ?1)", [p.id], |r| {
                r.get(0)
            })?;
            if taken {
                tx.execute(
                    "INSERT INTO persons (name, send_format, view, note, hidden, manual, via, saved)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
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
                placed.insert(p.id, tx.last_insert_rowid());
            } else {
                insert_person_row(&tx, p)?;
                placed.insert(p.id, p.id);
            }
        }
        for a in &undo.addresses {
            // An address another person took meanwhile stays theirs.
            if owner(&tx, &a.key)?.is_none() {
                insert_address(
                    &tx,
                    &AddressRow {
                        person_id: placed.get(&a.person_id).copied().unwrap_or(a.person_id),
                        ..a.clone()
                    },
                )?;
            }
        }
        for (a, home) in carry {
            let (Some(to), None) = (owner(&tx, &home)?, owner(&tx, &a.key)?) else {
                continue;
            };
            let ord: i64 = tx.query_row(
                "SELECT COALESCE(MAX(ord), 0) + 1 FROM person_addresses WHERE person_id = ?1",
                [to],
                |r| r.get(0),
            )?;
            insert_address(
                &tx,
                &AddressRow {
                    person_id: to,
                    primary: false,
                    ord,
                    ..a
                },
            )?;
        }
        // A person whose every address another person took meanwhile has no address to be reached by.
        // What was written about them is not lost: it goes to whoever holds their address now, the
        // note joined to the holder's by an empty line, a format or a view only where the holder has none.
        for (old, new) in &placed {
            let alone: bool = tx.query_row(
                "SELECT NOT EXISTS (SELECT 1 FROM person_addresses WHERE person_id = ?1)",
                [new],
                |r| r.get(0),
            )?;
            if !alone {
                continue;
            }
            let row = undo.persons.iter().find(|p| p.id == *old);
            let holder = undo
                .addresses
                .iter()
                .filter(|a| a.person_id == *old)
                .find_map(|a| owner(&tx, &a.key).transpose())
                .transpose()?;
            if let (Some(row), Some(holder)) = (row, holder) {
                let note = row.note.trim();
                // Whole paragraphs only: a short note ("Иван") is not "found" inside a longer one,
                // and a note of several paragraphs is found as the run of them.
                let held: String = tx.query_row("SELECT note FROM persons WHERE id = ?1", [holder], |r| r.get(0))?;
                let lines = |t: &str| t.replace("\r\n", "\n").trim().to_owned();
                let note = if format!("\n\n{}\n\n", lines(&held)).contains(&format!("\n\n{}\n\n", lines(note))) {
                    ""
                } else {
                    note
                };
                tx.execute(
                    "UPDATE persons SET
                         note = CASE WHEN ?2 = '' THEN note
                                     WHEN note = '' THEN ?2 ELSE note || char(10) || char(10) || ?2 END,
                         send_format = CASE WHEN send_format = '' THEN ?3 ELSE send_format END,
                         view = CASE WHEN view = '' THEN ?4 ELSE view END
                     WHERE id = ?1",
                    params![holder, note, row.send_format, row.view],
                )?;
            }
            tx.execute("DELETE FROM persons WHERE id = ?1", [new])?;
        }
        for subject in &undo.hints {
            tx.execute(
                "DELETE FROM hints WHERE id = ?1 AND subject = ?2",
                params![SAME_PERSON, subject],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// People for address completion (#104): who matches what was typed, as a person with
    /// the primary address to insert and the others to choose. A hidden person is not
    /// offered by any of their addresses. Most written to first. Read from the reading
    /// connection, and in a fixed number of queries however many people match: one for the
    /// owners of the candidates, one for the people, one for their addresses, one for what
    /// the letters hold of them.
    pub fn suggest_addresses(&self, prefix: &str, limit: u32) -> Result<Vec<Suggestion>> {
        let found = self.known_addresses(prefix, limit.saturating_mul(6).max(40))?;
        let conn = self.read();
        let marks = |n: usize| vec!["?"; n].join(",");
        let keys: Vec<String> = found.iter().map(|a| key_of(&a.email)).collect();
        let mut owners: HashMap<String, i64> = HashMap::new();
        if !keys.is_empty() {
            let mut stmt = conn.prepare(&format!(
                "SELECT key, person_id FROM person_addresses WHERE key IN ({})",
                marks(keys.len())
            ))?;
            for row in stmt.query_map(rusqlite::params_from_iter(&keys), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })? {
                let (key, id) = row?;
                owners.insert(key, id);
            }
        }
        // A person known by a name the user gave them is found by it too.
        let needle = prefix.trim().to_lowercase();
        let named: Vec<i64> = if needle.is_empty() {
            Vec::new()
        } else {
            let mut stmt =
                conn.prepare("SELECT id FROM persons WHERE name != '' AND fold(name) LIKE '%' || ?1 || '%' LIMIT 50")?;
            stmt.query_map([&needle], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut ids: Vec<i64> = owners.values().copied().chain(named.iter().copied()).collect();
        ids.sort_unstable();
        ids.dedup();
        let people = load_many(&conn, &ids)?;

        let mut out: Vec<Suggestion> = Vec::new();
        let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
        let mut offer = |id: i64, out: &mut Vec<Suggestion>| {
            let Some(p) = people.get(&id) else { return };
            if !seen.insert(id) || p.hidden {
                return;
            }
            out.push(Suggestion {
                email: p.email.clone(),
                name: Some(p.name.clone()).filter(|n| !n.is_empty()),
                emails: p.emails.iter().map(|a| a.email.clone()).collect(),
            });
        };
        for (a, key) in found.into_iter().zip(&keys) {
            match owners.get(key) {
                Some(&id) => offer(id, &mut out),
                None => out.push(Suggestion {
                    emails: vec![a.email.clone()],
                    email: a.email,
                    name: a.name,
                }),
            }
        }
        for id in named {
            offer(id, &mut out);
        }
        out.truncate(limit as usize);
        Ok(out)
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
        // The address stays spelled the way the letters spell it.
        assert_eq!(shown[0].email, "Ivan@Example.org");
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

    /// A name the user typed in the book is shown as it is, quotes and all; a name gathered
    /// from the correspondence is cleaned of the quotes its mail program wrapped it in.
    #[test]
    fn a_name_typed_by_hand_keeps_its_quotes() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("ivan@example.org", "\"Иван\""), true);
        store
            .save_person(&person("olga@example.org", |p| {
                p.manual = true;
                p.name = "\"A\" \"B\"".into();
            }))
            .unwrap();
        let book = store.people("").unwrap();
        let by = |email: &str| book.iter().find(|p| p.email.eq_ignore_ascii_case(email)).unwrap();
        // Gathered from the mail: the wrapping quotes come off.
        assert_eq!(by("ivan@example.org").name, "Иван");
        // Typed by hand: kept as it is.
        assert_eq!(by("olga@example.org").name, "\"A\" \"B\"");
    }

    #[test]
    fn a_person_added_by_hand_can_go_a_sender_cannot() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("ivan@example.org", "Иван"), true);
        store
            .save_person(&person("ivan@example.org", |p| p.send_format = "plain".into()))
            .unwrap();
        // From the correspondence: the record cannot be removed, only hidden.
        assert!(!store.forget_person("ivan@example.org").unwrap().removed);
        assert!(store.person("ivan@example.org").unwrap().is_some());
        // Added by hand: it goes.
        store
            .save_person(&person("new@example.org", |p| {
                p.manual = true;
                p.name = "Новый".into();
            }))
            .unwrap();
        assert!(store.forget_person("new@example.org").unwrap().removed);
        assert!(store.person("new@example.org").unwrap().is_none());
    }

    #[test]
    fn names_wrapped_in_quotes_are_cleaned_when_read() {
        let store = mailbox();
        put(
            &store,
            "INBOX",
            1,
            &wrote("avalon@booking.com", "\"Avalon через Booking.com\""),
            true,
        );
        put(&store, "INBOX", 2, &wrote("fadin@example.org", "'FADIN Alexey'"), true);
        put(
            &store,
            "INBOX",
            3,
            &wrote("ryzhkov@example.org", "\"Рыжков, Дмитрий Евгеньевич\""),
            true,
        );
        let book = store.people("").unwrap();
        let name = |email: &str| book.iter().find(|p| p.email == email).unwrap().name.clone();
        assert_eq!(name("avalon@booking.com"), "Avalon через Booking.com");
        assert_eq!(name("fadin@example.org"), "FADIN Alexey");
        assert_eq!(name("ryzhkov@example.org"), "Рыжков, Дмитрий Евгеньевич");
        // The list sorts by the name without its quotes, so the quote-free «A» leads.
        assert_eq!(book[0].email, "avalon@booking.com");
        // A quote inside a name is legitimate and stays.
        put(
            &store,
            "INBOX",
            4,
            &wrote("vanya@example.org", "Иван \"Ваня\" Петров"),
            true,
        );
        assert_eq!(
            store
                .people("")
                .unwrap()
                .iter()
                .find(|p| p.email == "vanya@example.org")
                .unwrap()
                .name,
            "Иван \"Ваня\" Петров"
        );
    }

    fn merge(emails: &[&str], name: &str, primary: &str, fields: impl FnOnce(&mut Merge)) -> Merge {
        let mut m = Merge {
            emails: emails.iter().map(|e| (*e).to_owned()).collect(),
            name: name.into(),
            primary: primary.into(),
            ..Default::default()
        };
        fields(&mut m);
        m
    }

    /// Two people of the old book, one of them an address added by hand, and a letter from
    /// each: the book of a cache left by 0.7.
    fn book_of_0_7(path: &std::path::Path) {
        let mut conn = Connection::open(path).unwrap();
        super::super::register_fold(&conn).unwrap();
        super::super::migrate(&mut conn, &super::super::MIGRATIONS[..22]).unwrap();
        assert_eq!(super::super::user_version(&conn).unwrap(), 22);
        conn.execute_batch(
            "INSERT INTO addresses (email, name, uses) VALUES ('olga@example.org', 'Ольга', 31), ('o.smirnova@example.com', 'Смирнова Ольга', 9);
             INSERT INTO people (email, name, send_format, view, note, hidden, manual, via, saved)
             VALUES ('olga@example.org', 'Ольга Смирнова', 'plain', 'markdown', 'Заказывает залы', 1, 0, 'hint:send-format', 700),
                    ('New@Example.org', 'Новый', '', 'text', '', 0, 1, '', 800),
                    ('NEW@example.org', 'Дубль', '', '', '', 0, 0, '', 0);
             INSERT INTO hints (id, subject, decision, refusals) VALUES ('send-format', 'olga@example.org', 'never', 1);",
        )
        .unwrap();
    }

    /// Step 23: every old row becomes a person with that one address as the primary, every
    /// field carried over; the hints stay as they were and the old table is kept aside.
    #[test]
    fn the_old_book_becomes_people_with_one_address_each_without_losing_a_rule() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.sqlite");
        book_of_0_7(&path);
        let store = Store::open(&path).unwrap();

        let olga = store.person("OLGA@example.org").unwrap().expect("the rule survived");
        assert_eq!(olga.name, "Ольга Смирнова");
        assert_eq!(
            (olga.send_format.as_str(), olga.view.as_str(), olga.note.as_str()),
            ("plain", "markdown", "Заказывает залы")
        );
        assert!(olga.hidden && !olga.manual);
        assert_eq!((olga.via.as_str(), olga.saved), ("hint:send-format", 700));
        assert_eq!(olga.email, "olga@example.org");
        assert_eq!(olga.emails.len(), 1);
        assert!(olga.emails[0].primary);
        assert_eq!(olga.uses, 31, "the letters are still counted");

        // The two rows that differed only in case were one address: the one saved last stands.
        let new = store.person("new@example.org").unwrap().unwrap();
        assert_eq!((new.name.as_str(), new.view.as_str()), ("Новый", "text"));
        let book = store.people("").unwrap();
        assert_eq!(book.len(), 3, "olga, new, and the address of the letters alone");
        assert!(
            book.iter()
                .any(|p| p.email == "o.smirnova@example.com" && p.id == 0 && p.name == "Смирнова Ольга")
        );

        let conn = store.conn();
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM people_v22"),
            3,
            "the old table is kept"
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM hints"), 1);
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM person_addresses WHERE is_primary = 1"),
            count(&conn, "SELECT COUNT(*) FROM persons")
        );
        assert_eq!(
            super::super::user_version(&conn).unwrap(),
            super::super::MIGRATIONS.len() as i64
        );
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_person_keeps_several_addresses_with_one_primary() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("olga@example.org", "Ольга Смирнова"), true);
        put(
            &store,
            "INBOX",
            2,
            &wrote("o.smirnova@example.com", "Смирнова Ольга"),
            true,
        );
        put(
            &store,
            "INBOX",
            3,
            &wrote("o.smirnova@example.com", "Смирнова Ольга"),
            true,
        );

        // A lone address becomes a person by getting a second one; the first stays primary.
        let added = store
            .person_add_address("olga@example.org", "O.Smirnova@Example.com")
            .unwrap();
        assert!(added.owner.is_none());
        let olga = added.person.unwrap();
        assert_ne!(olga.id, 0);
        assert_eq!(
            olga.emails
                .iter()
                .map(|a| (a.email.as_str(), a.primary))
                .collect::<Vec<_>>(),
            [("olga@example.org", true), ("o.smirnova@example.com", false)],
            "the spelling of the letters, the primary first"
        );
        assert_eq!(olga.uses, 3, "the letters of both addresses count");
        assert_eq!(olga.name, "Ольга Смирнова");
        assert_eq!(
            olga.emails[1].name, "Смирнова Ольга",
            "an address keeps the name of its letters"
        );
        assert_eq!(store.people("").unwrap().len(), 1, "one person, not two");
        assert_eq!(store.person("o.smirnova@example.com").unwrap().unwrap().id, olga.id);

        let moved = store.person_set_primary("o.smirnova@example.com").unwrap().unwrap();
        assert_eq!(moved.email, "o.smirnova@example.com");
        assert_eq!(moved.emails.iter().filter(|a| a.primary).count(), 1);
        assert_eq!(moved.emails[0].email, "o.smirnova@example.com");

        // An address cannot belong to two people: the owner is named, nothing moves.
        let ivan = store
            .save_person(&person("ivan@example.org", |p| p.name = "Иван".into()))
            .unwrap();
        let clash = store
            .person_add_address("ivan@example.org", "olga@example.org")
            .unwrap();
        assert!(clash.person.is_none());
        assert_eq!(clash.owner.unwrap().id, olga.id);
        assert_eq!(store.person("ivan@example.org").unwrap().unwrap().emails.len(), 1);
        assert_eq!(ivan.emails.len(), 1);
        // Adding what a person has already changes nothing.
        let again = store
            .person_add_address("ivan@example.org", "IVAN@example.org")
            .unwrap();
        assert_eq!(again.person.unwrap().emails.len(), 1);
        assert!(store.person_add_address("ivan@example.org", "not an address").is_err());
    }

    #[test]
    fn a_rule_set_on_a_person_does_not_freeze_the_name_of_the_letters() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("olga@example.org", "Ольга"), true);
        // The card hands back the name it was shown with the rule it changed.
        let mut shown = store.people("").unwrap().remove(0);
        assert_eq!(shown.name, "Ольга");
        shown.send_format = "plain".into();
        let saved = store.save_person(&shown).unwrap();
        assert_eq!((saved.name.as_str(), saved.send_format.as_str()), ("Ольга", "plain"));
        let raw: String = store
            .conn()
            .query_row("SELECT name FROM persons WHERE id = ?1", [saved.id], |r| r.get(0))
            .unwrap();
        assert_eq!(raw, "", "no name of the user's own was written");
        // A name the user wrote stands over the letters; clearing it returns the letters'.
        let mut own = saved.clone();
        own.name = "Оля".into();
        assert_eq!(store.save_person(&own).unwrap().name, "Оля");
        own.name = String::new();
        assert_eq!(store.save_person(&own).unwrap().name, "Ольга");
    }

    /// Two people with rules of their own join into one and come back exactly as they were.
    #[test]
    fn merging_joins_addresses_notes_and_rules_and_the_snapshot_restores_everything() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("olga@example.org", "Ольга Смирнова"), true);
        put(
            &store,
            "INBOX",
            2,
            &wrote("o.smirnova@example.com", "Смирнова Ольга"),
            true,
        );
        put(&store, "INBOX", 3, &wrote("alone@example.net", "Одна"), true);
        store
            .save_person(&person("olga@example.org", |p| {
                p.send_format = "plain".into();
                p.note = "Заказывает залы".into();
                p.manual = true;
            }))
            .unwrap();
        store
            .save_person(&person("o.smirnova@example.com", |p| {
                p.send_format = "markdown".into();
                p.view = "markdown".into();
                p.note = "Личная почта".into();
                p.hidden = true;
            }))
            .unwrap();
        let before = store.people("").unwrap();
        let rows_before = rows_of(&store.conn(), "SELECT * FROM persons ORDER BY id");
        let addresses_before = rows_of(&store.conn(), "SELECT * FROM person_addresses ORDER BY key");

        let merged = store
            .person_merge(&merge(
                &[
                    "olga@example.org",
                    "O.SMIRNOVA@example.com",
                    "alone@example.net",
                    "olga@EXAMPLE.org",
                ],
                "Ольга Смирнова",
                "o.smirnova@example.com",
                |m| {
                    m.send_format = "plain".into();
                    m.view = "markdown".into();
                    m.hidden = true;
                },
            ))
            .unwrap()
            .unwrap();
        let p = &merged.person;
        assert_eq!(p.name, "Ольга Смирнова");
        assert_eq!(
            p.emails
                .iter()
                .map(|a| (a.email.as_str(), a.primary))
                .collect::<Vec<_>>(),
            [
                ("o.smirnova@example.com", true),
                ("olga@example.org", false),
                ("alone@example.net", false)
            ],
            "the chosen primary first, then the rest in the order given"
        );
        assert_eq!(
            p.note, "Заказывает залы\n\nЛичная почта",
            "notes are joined by an empty line"
        );
        assert_eq!(
            (p.send_format.as_str(), p.view.as_str(), p.hidden),
            ("plain", "markdown", true)
        );
        assert!(p.manual, "added by hand stays so if any of them was");
        let after = store.people("").unwrap();
        assert_eq!(after.len(), 1, "three became one");
        assert_eq!(after[0].uses, 3);
        assert_eq!(merged.undo.persons.len(), 2);

        store.person_restore(&merged.undo).unwrap();
        assert_eq!(store.people("").unwrap(), before, "the book is as it was");
        assert_eq!(rows_of(&store.conn(), "SELECT * FROM persons ORDER BY id"), rows_before);
        assert_eq!(
            rows_of(&store.conn(), "SELECT * FROM person_addresses ORDER BY key"),
            addresses_before
        );
    }

    fn rows_of(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| {
            Ok((0..n)
                .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                .collect::<Vec<_>>()
                .join(", "))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    }

    #[test]
    fn merging_one_person_or_unknown_ones_does_nothing_and_lone_addresses_make_a_new_record() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("a@example.org", "А"), true);
        put(&store, "INBOX", 2, &wrote("b@example.org", "Б"), true);
        assert!(
            store
                .person_merge(&merge(
                    &["a@example.org", "A@example.org"],
                    "А",
                    "a@example.org",
                    |_| {}
                ))
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .person_merge(&merge(&["a@example.org"], "А", "a@example.org", |_| {}))
                .unwrap()
                .is_none()
        );
        assert_eq!(store.people("").unwrap().len(), 2);
        // Two lone addresses of the correspondence: a record is made, and the snapshot removes it.
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "b@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        assert_eq!(merged.undo.created.len(), 1);
        assert_eq!(store.people("").unwrap().len(), 1);
        store.person_restore(&merged.undo).unwrap();
        assert_eq!(store.people("").unwrap().len(), 2);
        assert_eq!(
            count(&store.conn(), "SELECT COUNT(*) FROM persons"),
            0,
            "no record is left behind"
        );
    }

    #[test]
    fn splitting_gives_the_address_the_rules_but_not_the_note_and_remembers_it_is_not_a_duplicate() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("olga@example.org", "Ольга Смирнова"), true);
        put(&store, "INBOX", 2, &wrote("maria@example.com", "Maria O."), true);
        store
            .person_add_address("olga@example.org", "maria@example.com")
            .unwrap();
        store
            .save_person(&person("olga@example.org", |p| {
                p.name = "Ольга".into();
                p.send_format = "plain".into();
                p.view = "text".into();
                p.hidden = true;
                p.note = "Два ящика".into();
                p.via = "hint:send-format".into();
            }))
            .unwrap();
        let before = store.people("").unwrap();

        let split = store.person_split("MARIA@example.com").unwrap().unwrap();
        let (gone, stays) = (&split.person, &split.origin);
        assert_eq!(gone.email, "maria@example.com");
        assert_eq!(gone.name, "Maria O.", "the name comes from the letters");
        assert_eq!(
            (
                gone.send_format.as_str(),
                gone.view.as_str(),
                gone.hidden,
                gone.note.as_str()
            ),
            ("plain", "text", true, ""),
            "the rules are copied, the note is not"
        );
        assert_eq!(gone.via, "", "the mark of the hint that set the rule is not copied");
        assert_eq!(stays.emails.len(), 1);
        assert_eq!(stays.note, "Два ящика");
        assert_eq!(store.people("").unwrap().len(), 2);
        let refusal = store.hints().unwrap();
        assert_eq!(refusal.len(), 1);
        assert_eq!(
            (refusal[0].id.as_str(), refusal[0].subject.as_str()),
            (SAME_PERSON, "maria@example.com|olga@example.org")
        );

        // The primary leaving hands it to the next address.
        store.person_add_address("olga@example.org", "o2@example.org").unwrap();
        let s2 = store.person_split("olga@example.org").unwrap().unwrap();
        assert_eq!(s2.origin.email, "o2@example.org");
        assert!(s2.origin.emails[0].primary);

        // A person of one address has nothing to split.
        assert!(store.person_split("maria@example.com").unwrap().is_none());
        store.person_restore(&s2.undo).unwrap();
        store.person_restore(&split.undo).unwrap();
        assert!(
            store.hints().unwrap().is_empty(),
            "the refusal written by the split goes with it"
        );
        assert_eq!(
            store.person("maria@example.com").unwrap().unwrap().id,
            store.person("olga@example.org").unwrap().unwrap().id
        );
        let _ = before;
    }

    #[test]
    fn suggestions_group_the_addresses_of_a_person_and_never_offer_a_hidden_one() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("olga@example.org", "Ольга Смирнова"), true);
        put(
            &store,
            "INBOX",
            2,
            &wrote("o.smirnova@example.com", "Смирнова Ольга"),
            true,
        );
        put(
            &store,
            "INBOX",
            3,
            &wrote("o.smirnova@example.com", "Смирнова Ольга"),
            true,
        );
        put(
            &store,
            "INBOX",
            4,
            &wrote("booking@example.com", "Бюро путешествий"),
            true,
        );
        store
            .person_add_address("olga@example.org", "o.smirnova@example.com")
            .unwrap();

        let found = store.suggest_addresses("смирн", 8).unwrap();
        assert_eq!(found.len(), 1, "two addresses, one person");
        assert_eq!(found[0].email, "olga@example.org", "the primary is the one to insert");
        assert_eq!(found[0].emails, ["olga@example.org", "o.smirnova@example.com"]);
        assert_eq!(found[0].name.as_deref(), Some("Ольга Смирнова"));

        // Typing a part of the second address finds the same person.
        let by_other = store.suggest_addresses("o.smir", 8).unwrap();
        assert_eq!(by_other.len(), 1);
        assert_eq!(by_other[0].email, "olga@example.org");

        // Hiding the person hides every address; the others are still offered.
        store
            .save_person(&person("olga@example.org", |p| p.hidden = true))
            .unwrap();
        assert!(store.suggest_addresses("смирн", 8).unwrap().is_empty());
        assert!(store.suggest_addresses("o.smir", 8).unwrap().is_empty());
        assert_eq!(
            store.suggest_addresses("бюро", 8).unwrap()[0].email,
            "booking@example.com"
        );

        // A name the user gave finds the person by it, though no letter spells it so.
        store
            .save_person(&person("booking@example.com", |p| p.name = "Турагентство".into()))
            .unwrap();
        assert_eq!(
            store.suggest_addresses("тураг", 8).unwrap()[0].email,
            "booking@example.com"
        );
    }

    #[test]
    fn forgetting_a_person_added_by_hand_takes_all_their_addresses() {
        let store = mailbox();
        store
            .save_person(&person("new@example.org", |p| {
                p.manual = true;
                p.name = "Новый".into();
            }))
            .unwrap();
        store.person_add_address("new@example.org", "new2@example.org").unwrap();
        assert!(store.forget_person("NEW2@example.org").unwrap().removed);
        assert!(store.person("new@example.org").unwrap().is_none());
        assert!(store.person("new2@example.org").unwrap().is_none());
        assert_eq!(count(&store.conn(), "SELECT COUNT(*) FROM person_addresses"), 0);
    }

    /// The key of a person merged away is not given to a record made afterwards, and an undo does
    /// not meet a stranger under it: the new record stays.
    #[test]
    fn an_undo_leaves_a_record_made_after_the_merge_alone() {
        let store = mailbox();
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = "Б".into()))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        let fresh = store
            .save_person(&person("c@example.org", |p| p.note = "Новый".into()))
            .unwrap();
        assert!(
            !merged.undo.persons.iter().any(|p| p.id == fresh.id),
            "a new key, not the merged-away one"
        );
        store.person_restore(&merged.undo).unwrap();
        assert_eq!(store.person("c@example.org").unwrap().unwrap().note, "Новый");
        assert_eq!(store.person("b@example.org").unwrap().unwrap().note, "Б");
        assert_eq!(store.people("").unwrap().len(), 3);
    }

    /// Even if a stranger holds a key of the snapshot, it is not deleted: the person comes back under another.
    #[test]
    fn an_undo_does_not_delete_a_stranger_under_a_key_of_the_snapshot() {
        let store = mailbox();
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        let b = store
            .save_person(&person("b@example.org", |p| p.note = "Б".into()))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        {
            let conn = store.conn();
            conn.execute("INSERT INTO persons (id, note) VALUES (?1, 'чужой')", [b.id])
                .unwrap();
            conn.execute(
                "INSERT INTO person_addresses (key, email, person_id, is_primary, ord) VALUES ('x@x', 'x@x', ?1, 1, 0)",
                [b.id],
            )
            .unwrap();
        }
        store.person_restore(&merged.undo).unwrap();
        assert_eq!(store.person("x@x").unwrap().unwrap().note, "чужой");
        assert_eq!(store.person("b@example.org").unwrap().unwrap().note, "Б");
        assert_ne!(store.person("b@example.org").unwrap().unwrap().id, b.id);
        assert_eq!(store.person("a@example.org").unwrap().unwrap().note, "А");
    }

    #[test]
    fn forgetting_a_merged_person_keeps_the_rules_of_an_address_from_the_letters_and_can_be_undone() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("heard@example.org", "Слышанный"), true);
        store
            .save_person(&person("heard@example.org", |p| p.send_format = "plain".into()))
            .unwrap();
        store
            .save_person(&person("mine@example.org", |p| p.manual = true))
            .unwrap();
        store
            .person_merge(&merge(
                &["mine@example.org", "heard@example.org"],
                "Он",
                "mine@example.org",
                |m| {
                    m.send_format = "plain".into();
                },
            ))
            .unwrap()
            .unwrap();
        let before = store.people("").unwrap();
        let gone = store.forget_person("mine@example.org").unwrap();
        assert!(!gone.removed && gone.unmarked);
        let kept = store.person("heard@example.org").unwrap().unwrap();
        assert_eq!(
            kept.send_format, "plain",
            "the rule of the address from the letters is whole"
        );
        assert!(!kept.manual);
        assert_eq!(kept.emails.len(), 2);
        store.person_restore(&gone.undo).unwrap();
        assert_eq!(store.people("").unwrap(), before);

        // A person none of whose addresses the letters know goes whole, and comes back.
        store
            .save_person(&person("lone@example.org", |p| p.manual = true))
            .unwrap();
        let lone = store.forget_person("lone@example.org").unwrap();
        assert!(lone.removed && !lone.unmarked);
        assert!(store.person("lone@example.org").unwrap().is_none());
        store.person_restore(&lone.undo).unwrap();
        assert!(store.person("lone@example.org").unwrap().is_some());
    }

    #[test]
    fn a_merge_does_not_keep_the_name_of_the_letters_or_an_address_as_the_users_own() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("a@example.org", "Анна"), true);
        put(&store, "INBOX", 2, &wrote("b@example.org", "Anna K."), true);
        let m = |name: &str| merge(&["a@example.org", "b@example.org"], name, "a@example.org", |_| {});
        let raw = |store: &Store| -> String {
            store
                .conn()
                .query_row("SELECT name FROM persons", [], |r| r.get(0))
                .unwrap()
        };
        let merged = store.person_merge(&m("Анна")).unwrap().unwrap();
        assert_eq!(raw(&store), "", "the letters' name is not frozen");
        store.person_restore(&merged.undo).unwrap();
        store.person_merge(&m("B@example.org")).unwrap().unwrap();
        assert_eq!(raw(&store), "", "an address is not a name");
        let p = store.person("a@example.org").unwrap().unwrap();
        assert_eq!(p.name, "Анна");
        // A name of the user's own is kept.
        store
            .person_restore(&store.person_split("b@example.org").unwrap().unwrap().undo)
            .unwrap();
    }

    #[test]
    fn an_address_that_is_another_persons_makes_no_record_for_the_one_asking() {
        let store = mailbox();
        store.save_person(&person("olga@example.org", |_| {})).unwrap();
        let clash = store
            .person_add_address("virtual@example.org", "olga@example.org")
            .unwrap();
        assert!(clash.owner.is_some() && clash.person.is_none());
        assert!(
            store.person("virtual@example.org").unwrap().is_none(),
            "no empty record was left behind"
        );
        assert_eq!(count(&store.conn(), "SELECT COUNT(*) FROM persons"), 1);
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

    /// A person forgotten (unmarked) and then edited within the ten seconds of the undo: taking the
    /// unmarking back puts the mark back and leaves what was written since alone.
    #[test]
    fn taking_back_an_unmarking_leaves_what_was_written_since() {
        let store = mailbox();
        put(&store, "INBOX", 1, &wrote("heard@example.org", "Слышанный"), true);
        store
            .save_person(&person("heard@example.org", |p| {
                p.manual = true;
                p.note = "было".into();
            }))
            .unwrap();
        let gone = store.forget_person("heard@example.org").unwrap();
        assert!(gone.unmarked);
        store
            .save_person(&person("heard@example.org", |p| {
                p.note = "стало".into();
                p.send_format = "plain".into();
            }))
            .unwrap();
        store.person_restore(&gone.undo).unwrap();
        let back = store.person("heard@example.org").unwrap().unwrap();
        assert!(back.manual, "the mark is back");
        assert_eq!(back.note, "стало", "the note written since is kept");
        assert_eq!(back.send_format, "plain");
    }

    /// An address added to the joint person after a merge is not the snapshot's: it goes back to the
    /// correspondence, and the joint record (the joined note and all) does not stay beside the two.
    #[test]
    fn taking_back_a_merge_does_not_leave_the_joint_record_that_gained_an_address() {
        let store = mailbox();
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = "Б".into()))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        put(&store, "INBOX", 1, &wrote("y@example.org", "Игрек"), true);
        store.person_add_address("a@example.org", "y@example.org").unwrap();
        store.person_restore(&merged.undo).unwrap();
        assert_eq!(store.person("a@example.org").unwrap().unwrap().note, "А");
        assert_eq!(store.person("b@example.org").unwrap().unwrap().note, "Б");
        assert!(
            store.person("y@example.org").unwrap().is_none(),
            "the address is back in the correspondence"
        );
        assert_eq!(count(&store.conn(), "SELECT COUNT(*) FROM persons"), 2);
        assert_eq!(count(&store.conn(), "SELECT COUNT(*) FROM person_addresses"), 2);
    }

    /// A person of the snapshot whose every address another person has taken meanwhile is not put
    /// back empty: an empty record would only be a name nobody can reach.
    #[test]
    fn taking_back_a_merge_does_not_put_back_a_person_without_addresses() {
        let store = mailbox();
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = "Б".into()))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        let split = store.person_split("b@example.org").unwrap().unwrap();
        store.person_restore(&merged.undo).unwrap();
        assert_eq!(
            count(
                &store.conn(),
                "SELECT COUNT(*) FROM persons p WHERE NOT EXISTS (SELECT 1 FROM person_addresses WHERE person_id = p.id)"
            ),
            0
        );
        assert_eq!(store.person("b@example.org").unwrap().unwrap().id, split.person.id);
        assert_eq!(store.person("a@example.org").unwrap().unwrap().note, "А");
    }

    /// One mark for «in the correspondence», from the backend: the question before forgetting and
    /// the forgetting itself read the same thing, whatever the count of letters says.
    #[test]
    fn a_person_knows_whether_their_address_is_in_the_correspondence() {
        let store = mailbox();
        // An address of the letters whose count fell to nothing is still in the correspondence.
        store
            .conn()
            .execute(
                "INSERT INTO addresses (email, name, uses) VALUES ('old@example.org', '', 0)",
                [],
            )
            .unwrap();
        store
            .save_person(&person("old@example.org", |p| p.manual = true))
            .unwrap();
        store
            .save_person(&person("mine@example.org", |p| p.manual = true))
            .unwrap();
        let old = store.person("old@example.org").unwrap().unwrap();
        assert_eq!(old.uses, 0);
        assert!(old.heard && old.emails[0].heard);
        assert!(!store.person("mine@example.org").unwrap().unwrap().heard);
        let listed = store.people("").unwrap();
        assert!(listed.iter().find(|p| p.email == "old@example.org").unwrap().heard);
        assert!(!listed.iter().find(|p| p.email == "mine@example.org").unwrap().heard);
        // The forgetting agrees with the mark.
        assert!(store.forget_person("old@example.org").unwrap().unmarked);
        assert!(store.forget_person("mine@example.org").unwrap().removed);
    }

    /// An address written by hand, not in the letters, has nowhere to go back to: it stays with the
    /// owner of the primary address of the record it was added to.
    #[test]
    fn taking_back_a_merge_keeps_an_address_added_by_hand() {
        let store = mailbox();
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = "Б".into()))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        store.person_add_address("a@example.org", "mine@example.org").unwrap();
        store.person_restore(&merged.undo).unwrap();
        let a = store.person("a@example.org").unwrap().unwrap();
        assert_eq!(store.person("mine@example.org").unwrap().unwrap().id, a.id);
        assert_ne!(store.person("b@example.org").unwrap().unwrap().id, a.id);
        assert_eq!(a.note, "А");
    }

    /// Split, then the merge taken back: the person the address went to keeps what the taken-back
    /// record said about it, the note joined to theirs and the rules only where they have none.
    #[test]
    fn taking_back_a_merge_after_a_split_keeps_the_note_of_the_one_whose_address_went() {
        let store = mailbox();
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        store
            .save_person(&person("b@example.org", |p| {
                p.note = "Б".into();
                p.send_format = "plain".into();
                p.view = "markdown".into();
            }))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |m| {
                    m.view = "text".into();
                },
            ))
            .unwrap()
            .unwrap();
        let split = store.person_split("b@example.org").unwrap().unwrap();
        store.person_restore(&merged.undo).unwrap();
        let b = store.person("b@example.org").unwrap().unwrap();
        assert_eq!(b.id, split.person.id);
        assert_eq!(b.note, "Б", "the note is not lost");
        assert_eq!(b.send_format, "plain", "a rule the holder lacks is taken");
        assert_eq!(b.view, "text", "a rule the holder has stays");
    }

    #[test]
    fn a_note_the_holder_already_has_is_joined_with_an_empty_line() {
        let store = mailbox();
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = "Б".into()))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        let split = store.person_split("b@example.org").unwrap().unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = "свой".into()))
            .unwrap();
        store.person_restore(&merged.undo).unwrap();
        let held = store.person("b@example.org").unwrap().unwrap();
        assert_eq!(held.id, split.person.id);
        assert_eq!(held.note, "свой\n\nБ");
    }

    #[test]
    fn a_short_note_is_not_taken_for_a_part_of_a_longer_one() {
        let store = mailbox();
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = "Иван".into()))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        store.person_split("b@example.org").unwrap().unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = "Иван Петров, бухгалтер".into()))
            .unwrap();
        store.person_restore(&merged.undo).unwrap();
        let held = store.person("b@example.org").unwrap().unwrap();
        assert_eq!(held.note, "Иван Петров, бухгалтер\n\nИван");
    }

    #[test]
    fn a_note_of_two_paragraphs_the_holder_already_has_is_not_doubled() {
        let store = mailbox();
        let two = "Бухгалтер\n\nЗвонить после обеда";
        store
            .save_person(&person("a@example.org", |p| p.note = "А".into()))
            .unwrap();
        store
            .save_person(&person("b@example.org", |p| p.note = two.into()))
            .unwrap();
        let merged = store
            .person_merge(&merge(
                &["a@example.org", "b@example.org"],
                "АБ",
                "a@example.org",
                |_| {},
            ))
            .unwrap()
            .unwrap();
        store.person_split("b@example.org").unwrap().unwrap();
        store
            .save_person(&person("b@example.org", |p| {
                p.note = format!("Свой\r\n\r\n{two}\r\n\r\nЕщё")
            }))
            .unwrap();
        store.person_restore(&merged.undo).unwrap();
        let held = store.person("b@example.org").unwrap().unwrap();
        assert_eq!(held.note.matches("Бухгалтер").count(), 1, "{:?}", held.note);
    }
}
