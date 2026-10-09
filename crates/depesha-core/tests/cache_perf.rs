//! Cache timings on a large mailbox, without a server: the operations that once went
//! over every message of the folder or the account (issue #31).
//!
//!   cargo test --release -p depesha-core --test cache_perf -- --ignored --nocapture
//!
//! The cache file lives under `target/tmp`, on the disk: syncs to it cost what they cost.
//! `DEPESHA_PERF_N` sets the size of the mailbox (default 50 000); with `DEPESHA_PERF_KEEP`
//! the cache file stays for a look in the sqlite3 shell.

use std::time::{Duration, Instant};

use depesha_core::imap::{FlagChange, Flags, Folder, FolderRole};
use depesha_core::message::{Addr, Summary};
use depesha_core::store::{Followup, ListQuery, NewMessage, Store};

const ACCOUNT: &str = "a";
const SENDERS: usize = 300;
const COLLEAGUES: usize = 60;
/// Conversations of 2 to 10 letters; the rest of the mailbox is single letters.
const CONVERSATIONS: usize = 1500;
/// Questions in Sent nobody answered: reminders that stay.
const WAITING: usize = 150;

fn folder(name: &str, role: FolderRole) -> Folder {
    Folder {
        name: name.into(),
        display_name: name.into(),
        delimiter: Some("/".into()),
        role: Some(role),
        selectable: true,
        hidden: false,
    }
}

fn me() -> Addr {
    Addr {
        name: Some("Я Сам".into()),
        email: "me@example.org".into(),
    }
}

fn sender(s: usize) -> Addr {
    Addr {
        name: Some(if s.is_multiple_of(2) {
            format!("Отправитель {s}")
        } else {
            format!("Sender Number {s}")
        }),
        email: format!("sender{s}@example.org"),
    }
}

/// Me and two to four colleagues.
fn recipients(i: usize) -> Vec<Addr> {
    let mut to = vec![me()];
    for k in 0..2 + i % 3 {
        let c = (i * 7 + k * 13) % COLLEAGUES;
        to.push(Addr {
            name: Some(format!("Коллега {c}")),
            email: format!("colleague{c}@example.org"),
        });
    }
    to
}

/// A message of the mailbox: folder, UID, headers.
struct Letter {
    folder: &'static str,
    summary: Summary,
}

fn mailbox(n: usize) -> Vec<Letter> {
    let start = 1_700_000_000;
    let mut out = Vec::with_capacity(n);
    let mut threaded = 0;
    for c in 0..CONVERSATIONS {
        let size = 2 + c % 9;
        let s = sender(c % SENDERS);
        let mut ids: Vec<String> = Vec::new();
        for j in 0..size {
            let mine = j % 3 == 1;
            // Underscores in Message-IDs: LIKE patterns must not take them as wildcards.
            let id = format!("c{c}_{j}@perf.example.org");
            let folder = if mine {
                "Sent"
            } else if j == 0 && c.is_multiple_of(20) {
                "Archive"
            } else if j + 1 == size && c % 50 == 1 {
                "Trash"
            } else {
                "INBOX"
            };
            let (from, to) = if mine {
                (me(), vec![s.clone()])
            } else {
                (s.clone(), recipients(c + j))
            };
            out.push(Letter {
                folder,
                summary: Summary {
                    message_id: Some(id.clone()),
                    in_reply_to: ids.last().cloned(),
                    references: ids.iter().rev().take(10).rev().cloned().collect(),
                    subject: if j == 0 {
                        format!("Обсуждение {c}")
                    } else {
                        format!("Re: Обсуждение {c}")
                    },
                    from: Some(from),
                    to,
                    date: Some(start + ((c * 29 + j * 7) % n) as i64 * 60),
                    ..Default::default()
                },
            });
            ids.push(id);
            threaded += 1;
        }
        if c.is_multiple_of(30) {
            out.push(Letter {
                folder: "Drafts",
                summary: Summary {
                    message_id: Some(format!("c{c}_draft@perf.example.org")),
                    in_reply_to: ids.last().cloned(),
                    references: ids.clone(),
                    subject: format!("Re: Обсуждение {c}"),
                    from: Some(me()),
                    to: vec![s.clone()],
                    date: Some(start + n as i64 * 60),
                    ..Default::default()
                },
            });
            threaded += 1;
        }
    }
    for w in 0..WAITING {
        out.push(Letter {
            folder: "Sent",
            summary: Summary {
                message_id: Some(format!("q{w}_x@perf.example.org")),
                subject: format!("Вопрос {w}"),
                from: Some(me()),
                to: vec![sender(w % SENDERS)],
                date: Some(start + (w * 300 % n) as i64 * 60),
                ..Default::default()
            },
        });
    }
    for i in 0..n.saturating_sub(threaded + WAITING) {
        let k = i % 97;
        out.push(Letter {
            folder: "INBOX",
            summary: Summary {
                message_id: Some(format!("{i}@perf.example.org")),
                subject: format!("Письмо номер {i} про счёт {k}"),
                from: Some(sender(i % SENDERS)),
                to: recipients(i),
                date: Some(start + i as i64 * 60),
                ..Default::default()
            },
        });
    }
    // Sync brings the newest first.
    out.sort_by_key(|l| std::cmp::Reverse(l.summary.date));
    out
}

/// Fills the cache as sync does, 200 headers of a folder at a time. Returns the UIDs of the inbox.
fn fill(store: &Store, letters: &[Letter]) -> Vec<u32> {
    let mut by_folder = std::collections::BTreeMap::<&str, Vec<NewMessage<'_>>>::new();
    for l in letters {
        let msgs = by_folder.entry(l.folder).or_default();
        let uid = msgs.len() as u32 + 1;
        msgs.push(NewMessage {
            uid,
            summary: &l.summary,
            fallback_date: 0,
            size: 2_000,
            flags: Flags {
                seen: !uid.is_multiple_of(3),
                ..Default::default()
            },
            keywords: Vec::new(),
        });
    }
    // Folders take turns, newest first, as syncs of several folders do.
    let mut batches: Vec<_> = by_folder.iter().map(|(f, msgs)| (*f, msgs.chunks(200))).collect();
    while !batches.is_empty() {
        batches.retain_mut(|(folder, chunks)| match chunks.next() {
            Some(batch) => {
                store.insert_messages(ACCOUNT, folder, batch).unwrap();
                true
            }
            None => false,
        });
    }
    by_folder["INBOX"].iter().map(|m| m.uid).collect()
}

/// Median of five runs; `longest` keeps the longest hold of the cache by any of them.
fn time<T>(
    store: &Store,
    name: &str,
    longest: &mut Vec<(String, Duration)>,
    mut f: impl FnMut() -> T,
) -> (Duration, T) {
    store.take_longest_lock();
    let mut runs = Vec::new();
    let mut out = None;
    for _ in 0..5 {
        let t = Instant::now();
        out = Some(f());
        runs.push(t.elapsed());
    }
    runs.sort();
    let held = store.take_longest_lock();
    longest.push((name.to_owned(), held));
    println!("{name}: {:.2} ms (lock held at most {:.2} ms)", ms(runs[2]), ms(held));
    (runs[2], out.unwrap())
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn open(n: usize) -> (tempfile::TempDir, Store, Vec<u32>, Duration) {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let store = Store::open(dir.path().join("mail.sqlite")).unwrap();
    store
        .replace_folders(
            ACCOUNT,
            &[
                folder("INBOX", FolderRole::Inbox),
                folder("Sent", FolderRole::Sent),
                folder("Archive", FolderRole::Archive),
                folder("Drafts", FolderRole::Drafts),
                folder("Trash", FolderRole::Trash),
            ],
        )
        .unwrap();
    let letters = mailbox(n);
    let t = Instant::now();
    let inbox = fill(&store, &letters);
    let filled = t.elapsed();
    (dir, store, inbox, filled)
}

#[test]
#[ignore = "slow: fills a cache with 50 000 messages"]
fn large_cache() {
    let n: usize = std::env::var("DEPESHA_PERF_N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(50_000);
    let (dir, store, inbox, filled) = open(n);
    println!("all headers ({n}): {:.1} s", filled.as_secs_f64());
    if std::env::var_os("DEPESHA_PERF_KEEP").is_some() {
        // For EXPLAIN QUERY PLAN in the sqlite3 shell.
        println!("cache kept in {}", dir.keep().display());
    }
    store.take_longest_lock();
    let mut longest = Vec::new();

    // Bodies of every tenth message, for the offline download.
    let some: Vec<i64> = store
        .list(&ListQuery {
            limit: (n / 10) as u32,
            ..Default::default()
        })
        .unwrap()
        .iter()
        .map(|r| r.id)
        .collect();
    for id in &some {
        store.save_body(*id, b"Subject: x\r\n\r\ntext", "text").unwrap();
    }
    // Reminders on my letters: the questions nobody answered, and conversations answered long ago.
    for (w, id) in (0..WAITING)
        .map(|w| format!("q{w}_x@perf.example.org"))
        .chain((0..30).map(|c| format!("c{c}_1@perf.example.org")))
        .enumerate()
    {
        store
            .followup_add(&Followup {
                account_id: ACCOUNT.into(),
                message_id: id,
                subject: "Вопрос".into(),
                recipients: "sender@example.org".into(),
                sent: 0,
                due: w as i64,
                ..Default::default()
            })
            .unwrap();
    }
    for &uid in inbox.iter().take(1000) {
        store
            .ews_item_add(ACCOUNT, "INBOX", uid, &format!("AAMk{uid}"), 0)
            .unwrap();
    }
    store.take_longest_lock();

    let page = |offset: u32, threads: bool| ListQuery {
        limit: 200,
        offset,
        threads,
        ..Default::default()
    };
    let (flat, rows) = time(&store, "inbox page", &mut longest, || {
        store.list(&page(0, false)).unwrap()
    });
    assert_eq!(rows.len(), 200);
    let (deep, _) = time(&store, "inbox, offset 40000", &mut longest, || {
        store.list(&page(40_000, false)).unwrap()
    });
    let (grouped, rows) = time(&store, "conversations page", &mut longest, || {
        store.list(&page(0, true)).unwrap()
    });
    assert_eq!(rows.len(), 200);
    assert!(rows.iter().any(|r| r.thread_count > 1));
    let (grouped_deep, rows) = time(&store, "conversations, offset 40000", &mut longest, || {
        store.list(&page(40_000, true)).unwrap()
    });
    if n >= 50_000 {
        assert!(!rows.is_empty());
    }

    let (one, found) = time(&store, "known_addresses, 1 letter", &mut longest, || {
        store.known_addresses("s", 8).unwrap()
    });
    assert_eq!(found.len(), 8);
    let (three, found) = time(&store, "known_addresses, 3 letters", &mut longest, || {
        store.known_addresses("кол", 8).unwrap()
    });
    assert_eq!(found.len(), 8);

    // People for completion (#104): some of the matches are people with two addresses, some hidden;
    // the number of queries does not grow with them, so the time stays that of the plain list.
    let wide = store.known_addresses("s", 40).unwrap();
    for pair in wide.chunks(2).take(10) {
        if let [a, b] = pair {
            store.person_add_address(&a.email, &b.email).unwrap();
        }
    }
    for a in wide.iter().skip(20).take(5) {
        store
            .save_person(&depesha_core::store::Person {
                email: a.email.clone(),
                hidden: true,
                ..Default::default()
            })
            .unwrap();
    }
    let (suggest_one, found) = time(&store, "suggest_addresses, 1 letter", &mut longest, || {
        store.suggest_addresses("s", 8).unwrap()
    });
    assert_eq!(found.len(), 8);
    let (suggest_three, found) = time(&store, "suggest_addresses, 3 letters", &mut longest, || {
        store.suggest_addresses("кол", 8).unwrap()
    });
    assert!(!found.is_empty());

    store.followups_resolve().unwrap();
    // Conversations of two letters end with mine: nobody answered them either.
    let unanswered = WAITING + (0..30usize).filter(|c| c.is_multiple_of(9)).count();
    assert_eq!(store.followups_count().unwrap().active as usize, unanswered);
    let (resolve, resolved) = time(&store, "followups_resolve", &mut longest, || {
        store.followups_resolve().unwrap()
    });
    assert_eq!(resolved, 0);

    let uids: Vec<u32> = inbox.iter().take(1000).copied().collect();
    let (flags, _) = time(&store, "change_flags, 1000", &mut longest, || {
        let n = store
            .change_flags(ACCOUNT, "INBOX", &uids, FlagChange::Flagged(true))
            .unwrap();
        store.settle_flags(ACCOUNT, "INBOX", &uids);
        n
    });
    let ids: Vec<i64> = store
        .list(&ListQuery {
            limit: 1000,
            ..Default::default()
        })
        .unwrap()
        .iter()
        .map(|r| r.id)
        .collect();
    // What a group action reads (`group_rows` of the commands).
    let (rows_at, got) = time(&store, "rows of 1000 ids", &mut longest, || {
        store.get_many_at(&ids).unwrap().len()
    });
    assert_eq!(got, 1000);
    let (items, got) = time(&store, "ews_item_ids, 1000", &mut longest, || {
        store.ews_item_ids(ACCOUNT, "INBOX", &uids).unwrap()
    });
    assert_eq!(got.len(), 1000);

    let (progress, (done, total)) = time(&store, "offline_progress", &mut longest, || {
        store.offline_progress(ACCOUNT, 0, false).unwrap()
    });
    assert!(done > 0 && total > done);
    let (missing, batch) = time(&store, "bodies_missing", &mut longest, || {
        store.bodies_missing(ACCOUNT, 0, false, 25).unwrap()
    });
    assert_eq!(batch.len(), 25);

    // The plain list was not part of the issue: its deep page walks the folder by date.
    let (worst, held) = longest
        .iter()
        .filter(|(name, _)| !name.starts_with("inbox"))
        .max_by_key(|(_, d)| *d)
        .unwrap();
    println!("longest hold of the cache: {:.2} ms ({worst})", ms(*held));
    println!("plain list: {:.2} ms, offset 40000: {:.2} ms", ms(flat), ms(deep));

    if n < 50_000 {
        return;
    }
    // Issue #31 on 50 000 messages. Ordering conversations by their newest letter needs
    // every conversation of the folder (a letter in another folder can put any of them
    // on top): the first page costs a pass over the folder's index, near 50 ms here.
    assert!(filled.as_secs() < 30, "headers in batches: {filled:?}");
    assert!(grouped.as_millis() < 100, "conversations page: {grouped:?}");
    assert!(
        grouped_deep.as_millis() < 150,
        "conversations, offset 40000: {grouped_deep:?}"
    );
    for (name, t) in [
        ("known_addresses, 1 letter", one),
        ("known_addresses, 3 letters", three),
        ("suggest_addresses, 1 letter", suggest_one),
        ("suggest_addresses, 3 letters", suggest_three),
        ("followups_resolve", resolve),
        ("offline_progress", progress),
        ("bodies_missing", missing),
    ] {
        assert!(t.as_millis() < 10, "{name}: {t:?}");
    }
    for (name, t) in [
        ("change_flags", flags),
        ("rows of ids", rows_at),
        ("ews_item_ids", items),
    ] {
        assert!(t.as_millis() < 20, "{name}: {t:?}");
    }
    assert!(held.as_millis() < 100, "{worst} held the cache {held:?}");
}
