//! Incremental flag sync (CONDSTORE and QRESYNC, RFC 7162) against a scripted IMAP
//! server that keeps mod-sequences like Dovecot does, and the fallbacks when a server
//! or a folder has none. Needs no network beyond localhost; always runs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap::{self, Conn, FlagChange};
use depesha_core::store::{ModSeqMark, Store};
use depesha_core::sync::{self, FolderSync, SyncOptions};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

struct Msg {
    uid: u32,
    flags: Vec<&'static str>,
    modseq: u64,
}

#[derive(Default)]
struct Mailbox {
    uidvalidity: u32,
    uid_next: u32,
    highest: u64,
    msgs: Vec<Msg>,
    /// Expunged UIDs with the mod-sequence of their expunge, for VANISHED (EARLIER).
    expunged: Vec<(u32, u64)>,
    /// Answers SELECT (CONDSTORE) with NOMODSEQ.
    nomodseq: bool,
    /// Answers UID FETCH … (CHANGEDSINCE …) with BAD.
    refuse_changedsince: bool,
}

impl Mailbox {
    fn new(n: u32) -> Self {
        let mut m = Self {
            uidvalidity: 7,
            uid_next: 1,
            highest: 1,
            ..Self::default()
        };
        for _ in 0..n {
            m.add(&[]);
        }
        m
    }

    fn bump(&mut self) -> u64 {
        self.highest += 1;
        self.highest
    }

    fn add(&mut self, flags: &[&'static str]) -> u32 {
        let uid = self.uid_next;
        self.uid_next += 1;
        let modseq = self.bump();
        self.msgs.push(Msg {
            uid,
            flags: flags.to_vec(),
            modseq,
        });
        uid
    }

    fn set_flags(&mut self, uid: u32, flags: &[&'static str]) {
        let modseq = self.bump();
        let m = self.msgs.iter_mut().find(|m| m.uid == uid).unwrap();
        m.flags = flags.to_vec();
        m.modseq = modseq;
    }

    fn expunge(&mut self, uid: u32) {
        let modseq = self.bump();
        self.msgs.retain(|m| m.uid != uid);
        self.expunged.push((uid, modseq));
    }

    fn max_uid(&self) -> u32 {
        self.msgs.last().map_or(0, |m| m.uid)
    }
}

/// The server's mailboxes and every command it got, without tags.
#[derive(Default)]
struct Server {
    caps: &'static str,
    folders: HashMap<String, Mailbox>,
    log: Vec<String>,
    /// Answers NO to the first command starting with this.
    fail_on: Option<&'static str>,
    /// Sends HIGHESTMODSEQ to a plain SELECT too, as Dovecot does for a mailbox that
    /// keeps mod-sequences.
    modseq_unasked: bool,
}

type Shared = Arc<Mutex<Server>>;

/// `1:3,7,9:*` with `*` the largest UID.
fn in_set(set: &str, uid: u32, max: u32) -> bool {
    set.split(',').any(|part| {
        let num = |s: &str| if s == "*" { max } else { s.parse().unwrap() };
        let (a, b) = match part.split_once(':') {
            Some((a, b)) => (num(a), num(b)),
            None => (num(part), num(part)),
        };
        (a.min(b)..=a.max(b)).contains(&uid)
    })
}

fn header(uid: u32) -> String {
    format!(
        "From: test@example.org\r\nSubject: Письмо {uid}\r\nMessage-ID: <{uid}@example.org>\r\n\
         Date: Fri, 2 Oct 2026 10:00:00 +0300\r\n\r\n"
    )
}

async fn serve(server: Shared) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(session(stream, server.clone()));
        }
    });
    port
}

async fn session(stream: tokio::net::TcpStream, server: Shared) {
    let (r, mut w) = stream.into_split();
    let mut lines = BufReader::new(r).lines();
    w.write_all(b"* OK ready\r\n").await.unwrap();
    let mut selected: Option<String> = None;
    let mut condstore = false;
    let mut qresync = false;
    while let Ok(Some(line)) = lines.next_line().await {
        let (tag, cmd) = line.split_once(' ').unwrap();
        let out = {
            let mut server = server.lock().unwrap();
            server.log.push(cmd.to_owned());
            if server.fail_on.is_some_and(|p| cmd.starts_with(p)) {
                server.fail_on = None;
                FAILED.to_owned()
            } else {
                respond(&mut server, cmd, &mut selected, &mut condstore, &mut qresync)
            }
        };
        let done = cmd.starts_with("LOGOUT");
        let reply = if out == REFUSED {
            format!("{tag} BAD unknown modifier\r\n")
        } else if out == FAILED {
            format!("{tag} NO try again later\r\n")
        } else {
            format!("{out}{tag} OK done\r\n")
        };
        w.write_all(reply.as_bytes()).await.unwrap();
        if done {
            return;
        }
    }
}

/// Untagged answers to a command, the tagged OK follows; `REFUSED` for a BAD instead.
/// `FAILED` (a NO) comes from `session` alone.
fn respond(
    server: &mut Server,
    cmd: &str,
    selected: &mut Option<String>,
    condstore: &mut bool,
    qresync: &mut bool,
) -> String {
    let upper = cmd.to_ascii_uppercase();
    if upper.starts_with("CAPABILITY") {
        return format!("* CAPABILITY IMAP4rev1 IDLE {}\r\n", server.caps);
    }
    if upper.starts_with("ENABLE QRESYNC") {
        *qresync = true;
        *condstore = true;
        return "* ENABLED QRESYNC\r\n".into();
    }
    if let Some(rest) = upper.strip_prefix("SELECT ") {
        let name = cmd[7..].split(' ').next().unwrap().trim_matches('"').to_owned();
        *condstore |= rest.contains("(CONDSTORE)");
        let m = &server.folders[&name];
        let mut out = format!(
            "* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* {} EXISTS\r\n\
             * OK [UIDVALIDITY {}] ok\r\n* OK [UIDNEXT {}] ok\r\n",
            m.msgs.len(),
            m.uidvalidity,
            m.uid_next
        );
        if *condstore || server.modseq_unasked {
            out += &if m.nomodseq {
                "* OK [NOMODSEQ] no mod-sequences here\r\n".to_owned()
            } else {
                format!("* OK [HIGHESTMODSEQ {}] ok\r\n", m.highest)
            };
        }
        *selected = Some(name);
        return out;
    }
    if let Some(rest) = cmd.strip_prefix("UID FETCH ") {
        let m = &server.folders[selected.as_ref().unwrap()];
        let (set, items) = rest.split_once(' ').unwrap();
        let since: Option<u64> = items
            .split_once("CHANGEDSINCE ")
            .map(|(_, s)| s.split([' ', ')']).next().unwrap().parse().unwrap());
        if since.is_some() && m.refuse_changedsince {
            return REFUSED.into();
        }
        let max = m.max_uid();
        let mut out = String::new();
        if let (Some(since), true) = (since, items.contains("VANISHED")) {
            let gone: Vec<String> = m
                .expunged
                .iter()
                .filter(|(uid, modseq)| *modseq > since && in_set(set, *uid, u32::MAX))
                .map(|(uid, _)| uid.to_string())
                .collect();
            if !gone.is_empty() {
                out += &format!("* VANISHED (EARLIER) {}\r\n", gone.join(","));
            }
        }
        for (i, msg) in m.msgs.iter().enumerate() {
            if !in_set(set, msg.uid, max) || since.is_some_and(|s| msg.modseq <= s) {
                continue;
            }
            let modseq = if *condstore {
                format!(" MODSEQ ({})", msg.modseq)
            } else {
                String::new()
            };
            let flags = msg.flags.join(" ");
            if items.contains("BODY.PEEK[HEADER]") {
                let h = header(msg.uid);
                out += &format!(
                    "* {} FETCH (UID {} FLAGS ({flags}){modseq} RFC822.SIZE 100 \
                     INTERNALDATE \"02-Oct-2026 10:00:00 +0300\" BODY[HEADER] {{{}}}\r\n{h})\r\n",
                    i + 1,
                    msg.uid,
                    h.len()
                );
            } else {
                out += &format!("* {} FETCH (UID {} FLAGS ({flags}){modseq})\r\n", i + 1, msg.uid);
            }
        }
        return out;
    }
    if let Some(rest) = cmd.strip_prefix("UID SEARCH UID ") {
        let m = &server.folders[selected.as_ref().unwrap()];
        let set = rest.split(' ').next().unwrap();
        let undeleted = rest.contains("UNDELETED");
        let max = m.max_uid();
        let uids: Vec<String> = m
            .msgs
            .iter()
            .filter(|msg| in_set(set, msg.uid, max) && !(undeleted && msg.flags.contains(&"\\Deleted")))
            .map(|msg| msg.uid.to_string())
            .collect();
        return format!("* SEARCH {}\r\n", uids.join(" "));
    }
    String::new()
}

const REFUSED: &str = "REFUSED";
const FAILED: &str = "FAILED";

fn options() -> SyncOptions {
    SyncOptions { initial_limit: 500 }
}

struct Fixture {
    server: Shared,
    port: u16,
}

impl Fixture {
    async fn new(caps: &'static str, folders: &[(&str, u32)]) -> Self {
        let server = Arc::new(Mutex::new(Server {
            caps,
            folders: folders
                .iter()
                .map(|(name, n)| (name.to_string(), Mailbox::new(*n)))
                .collect(),
            ..Server::default()
        }));
        let port = serve(server.clone()).await;
        Self { server, port }
    }

    async fn connect(&self) -> Conn {
        let config = ServerConfig::new("127.0.0.1", self.port, Security::Plain);
        imap::connect(&config, &Credentials::new("alice", "secret"))
            .await
            .unwrap()
    }

    fn with<T>(&self, folder: &str, f: impl FnOnce(&mut Mailbox) -> T) -> T {
        f(self.server.lock().unwrap().folders.get_mut(folder).unwrap())
    }

    /// Commands since the last call.
    fn commands(&self) -> Vec<String> {
        std::mem::take(&mut self.server.lock().unwrap().log)
    }
}

fn store_with(folders: &[&str]) -> Store {
    let store = Store::open_in_memory().unwrap();
    let folders: Vec<imap::Folder> = folders
        .iter()
        .map(|name| imap::Folder {
            name: name.to_string(),
            display_name: name.to_string(),
            delimiter: Some("/".into()),
            role: None,
            selectable: true,
            hidden: false,
        })
        .collect();
    store.replace_folders("a", &folders).unwrap();
    store
}

async fn sync(conn: &mut Conn, store: &Store, folder: &str) -> FolderSync {
    sync::sync_folder(conn, store, "a", folder, options()).await.unwrap()
}

fn flag_fetches(commands: &[String]) -> Vec<&String> {
    commands
        .iter()
        .filter(|c| c.starts_with("UID FETCH") && c.contains("(UID FLAGS)"))
        .collect()
}

/// `[added, updated, removed, fetched_flags]`: the report with what the pass cost.
fn report(added: usize, updated: usize, removed: usize, fetched_flags: usize) -> [usize; 4] {
    [added, updated, removed, fetched_flags]
}

fn counts(r: FolderSync) -> [usize; 4] {
    [r.added, r.updated, r.removed, r.fetched_flags]
}

#[tokio::test]
async fn with_qresync_only_changes_and_vanished_uids_come() {
    let fx = Fixture::new("CONDSTORE QRESYNC", &[("INBOX", 25)]).await;
    let mut conn = fx.connect().await;
    assert!(conn.caps.condstore && conn.caps.qresync);
    let store = store_with(&["INBOX"]);
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(25, 0, 0, 0));
    let commands = fx.commands();
    assert!(commands.iter().any(|c| c == "ENABLE QRESYNC"), "{commands:?}");
    assert!(
        commands.iter().any(|c| c == "SELECT \"INBOX\" (CONDSTORE)"),
        "{commands:?}"
    );

    // Nothing changed: no FETCH at all, and no list of UIDs either.
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 0, 0, 0));
    let commands = fx.commands();
    assert!(!commands.iter().any(|c| c.starts_with("UID FETCH")), "{commands:?}");
    assert!(!commands.iter().any(|c| c.contains("UNDELETED")), "{commands:?}");

    // One flag changed elsewhere: only that message comes.
    let since = fx.with("INBOX", |m| m.highest);
    fx.with("INBOX", |m| m.set_flags(7, &["\\Seen"]));
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 1, 0, 1));
    assert_eq!(
        flag_fetches(&fx.commands()),
        [&format!("UID FETCH 1:25 (UID FLAGS) (CHANGEDSINCE {since} VANISHED)")]
    );
    assert!(store.find_by_uid("a", "INBOX", 7).unwrap().unwrap().flags.seen);

    // Expunged elsewhere: VANISHED, without the flags of the rest.
    fx.with("INBOX", |m| m.expunge(3));
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 0, 1, 0));
    assert!(store.find_by_uid("a", "INBOX", 3).unwrap().is_none());

    // \Deleted without EXPUNGE leaves the cache too.
    fx.with("INBOX", |m| m.set_flags(4, &["\\Deleted"]));
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 0, 1, 1));
    assert!(store.find_by_uid("a", "INBOX", 4).unwrap().is_none());

    // New mail is found as before.
    fx.with("INBOX", |m| m.add(&["\\Flagged"]));
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(1, 0, 0, 0));
    assert_eq!(store.known_uids("a", "INBOX").unwrap().len(), 24);
}

#[tokio::test]
async fn with_condstore_alone_expunges_are_counted_then_listed() {
    let fx = Fixture::new("CONDSTORE", &[("INBOX", 25)]).await;
    let mut conn = fx.connect().await;
    assert!(conn.caps.condstore && !conn.caps.qresync);
    let store = store_with(&["INBOX"]);
    sync(&mut conn, &store, "INBOX").await;
    fx.commands();

    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 0, 0, 0));
    let commands = fx.commands();
    assert!(!commands.iter().any(|c| c.starts_with("UID FETCH")), "{commands:?}");
    assert!(!commands.iter().any(|c| c.contains("UNDELETED")), "{commands:?}");

    fx.with("INBOX", |m| m.set_flags(7, &["\\Flagged"]));
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 1, 0, 1));
    let commands = fx.commands();
    assert!(flag_fetches(&commands)[0].ends_with(")"), "{commands:?}");
    assert!(!flag_fetches(&commands)[0].contains("VANISHED"), "{commands:?}");

    // An expunge with no flag change and no QRESYNC: EXISTS tells, a list of UIDs says which.
    fx.with("INBOX", |m| m.expunge(3));
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 0, 1, 0));
    assert!(fx.commands().iter().any(|c| c == "UID SEARCH UID 1:25 UNDELETED"));

    // One expunged and one new: EXISTS is the same, still seen.
    fx.with("INBOX", |m| {
        m.expunge(10);
        m.add(&[]);
    });
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(1, 0, 1, 0));
    assert!(store.find_by_uid("a", "INBOX", 10).unwrap().is_none());
    assert_eq!(store.known_uids("a", "INBOX").unwrap().len(), 24);
}

#[tokio::test]
async fn a_refused_list_of_uids_does_not_empty_the_cache() {
    let fx = Fixture::new("CONDSTORE", &[("INBOX", 25)]).await;
    let mut conn = fx.connect().await;
    let store = store_with(&["INBOX"]);
    sync(&mut conn, &store, "INBOX").await;
    fx.with("INBOX", |m| m.expunge(3));
    fx.server.lock().unwrap().fail_on = Some("UID SEARCH UID 1:25 UNDELETED");
    assert!(
        sync::sync_folder(&mut conn, &store, "a", "INBOX", options())
            .await
            .is_err()
    );
    assert_eq!(store.known_uids("a", "INBOX").unwrap().len(), 25);
    assert_eq!(
        counts(sync(&mut conn, &store, "INBOX").await),
        report(0, 0, 1, 0),
        "next time"
    );
}

#[tokio::test]
async fn without_condstore_every_pass_fetches_all_flags() {
    let fx = Fixture::new("UIDPLUS", &[("INBOX", 25)]).await;
    let mut conn = fx.connect().await;
    assert!(!conn.caps.condstore);
    let store = store_with(&["INBOX"]);
    sync(&mut conn, &store, "INBOX").await;
    fx.commands();
    fx.with("INBOX", |m| {
        m.set_flags(7, &["\\Seen"]);
        m.expunge(3);
    });
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 1, 1, 24));
    let commands = fx.commands();
    assert!(commands.iter().any(|c| c == "SELECT \"INBOX\""), "{commands:?}");
    assert_eq!(flag_fetches(&commands), ["UID FETCH 1:25 (UID FLAGS)"]);
}

#[tokio::test]
async fn highestmodseq_from_a_server_without_condstore_is_not_used() {
    let fx = Fixture::new("UIDPLUS", &[("INBOX", 25)]).await;
    fx.server.lock().unwrap().modseq_unasked = true;
    let mut conn = fx.connect().await;
    assert!(!conn.caps.condstore);
    let store = store_with(&["INBOX"]);
    sync(&mut conn, &store, "INBOX").await;
    fx.with("INBOX", |m| m.set_flags(7, &["\\Seen"]));
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 1, 0, 25));
    let commands = fx.commands();
    assert!(!commands.iter().any(|c| c.contains("CHANGEDSINCE")), "{commands:?}");
}

#[tokio::test]
async fn a_folder_without_mod_sequences_or_refusing_them_is_synced_in_full() {
    let fx = Fixture::new("CONDSTORE QRESYNC", &[("INBOX", 20), ("Plain", 20), ("Picky", 20)]).await;
    fx.with("Plain", |m| m.nomodseq = true);
    fx.with("Picky", |m| m.refuse_changedsince = true);
    let mut conn = fx.connect().await;
    let store = store_with(&["INBOX", "Plain", "Picky"]);
    for folder in ["INBOX", "Plain", "Picky"] {
        sync(&mut conn, &store, folder).await;
    }
    for folder in ["INBOX", "Plain", "Picky"] {
        fx.with(folder, |m| m.set_flags(5, &["\\Answered"]));
    }
    fx.commands();

    assert_eq!(
        counts(sync(&mut conn, &store, "Plain").await),
        report(0, 1, 0, 20),
        "NOMODSEQ"
    );
    assert_eq!(
        counts(sync(&mut conn, &store, "Picky").await),
        report(0, 1, 0, 20),
        "BAD"
    );
    assert_eq!(
        counts(sync(&mut conn, &store, "INBOX").await),
        report(0, 1, 0, 1),
        "the rest stay incremental"
    );
    let commands = fx.commands();
    assert_eq!(
        flag_fetches(&commands)
            .iter()
            .filter(|c| !c.contains("CHANGEDSINCE"))
            .count(),
        2,
        "{commands:?}"
    );
    // The connection is still in step after the refusal.
    conn.session.noop().await.unwrap();
}

#[tokio::test]
async fn a_lower_highestmodseq_or_a_new_uidvalidity_makes_a_full_pass() {
    let fx = Fixture::new("CONDSTORE QRESYNC", &[("INBOX", 20)]).await;
    let mut conn = fx.connect().await;
    let store = store_with(&["INBOX"]);
    sync(&mut conn, &store, "INBOX").await;
    assert_ne!(store.modseq_mark("a", "INBOX").unwrap(), ModSeqMark::default());

    // Restored from a backup: mod-sequences went back.
    fx.with("INBOX", |m| {
        m.highest = 2;
        m.set_flags(5, &["\\Seen"]);
    });
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 1, 0, 20));

    // Deleted and created again with other mail.
    fx.with("INBOX", |m| {
        *m = Mailbox::new(3);
        m.uidvalidity = 8;
    });
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(3, 0, 0, 0));
    assert_eq!(store.folder_state("a", "INBOX").unwrap(), (8, 3));
    assert_eq!(store.known_uids("a", "INBOX").unwrap().len(), 3);
    fx.commands();
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 0, 0, 0));
    assert!(!fx.commands().iter().any(|c| c.starts_with("UID FETCH")));
}

#[tokio::test]
async fn a_broken_pass_keeps_the_old_mod_sequence() {
    let fx = Fixture::new("CONDSTORE QRESYNC", &[("INBOX", 20)]).await;
    let mut conn = fx.connect().await;
    let store = store_with(&["INBOX"]);
    sync(&mut conn, &store, "INBOX").await;
    let before = store.modseq_mark("a", "INBOX").unwrap();

    fx.with("INBOX", |m| m.set_flags(5, &["\\Seen"]));
    // The changes come, then the pass breaks off.
    fx.server.lock().unwrap().fail_on = Some("UID SEARCH");
    assert!(
        sync::sync_folder(&mut conn, &store, "a", "INBOX", options())
            .await
            .is_err()
    );
    assert_eq!(store.modseq_mark("a", "INBOX").unwrap(), before);
    fx.commands();

    let r = sync(&mut conn, &store, "INBOX").await;
    assert_eq!(r.fetched_flags, 1, "the same changes again");
    assert!(
        flag_fetches(&fx.commands())[0].contains(&format!("CHANGEDSINCE {}", before.modseq)),
        "from the old mod-sequence"
    );
    assert!(store.find_by_uid("a", "INBOX", 5).unwrap().unwrap().flags.seen);
}

#[tokio::test]
async fn a_local_flag_the_server_has_not_stored_survives_an_incremental_pass() {
    let fx = Fixture::new("CONDSTORE QRESYNC", &[("INBOX", 20)]).await;
    let mut conn = fx.connect().await;
    let store = store_with(&["INBOX"]);
    sync(&mut conn, &store, "INBOX").await;

    // Read here, not yet stored on the server; meanwhile another client flags it.
    store.change_flags("a", "INBOX", &[5], FlagChange::Seen(true)).unwrap();
    fx.with("INBOX", |m| m.set_flags(5, &["\\Flagged"]));
    sync(&mut conn, &store, "INBOX").await;
    let flags = store.find_by_uid("a", "INBOX", 5).unwrap().unwrap().flags;
    assert!(flags.seen && flags.flagged, "{flags:?}");
}

#[tokio::test]
async fn the_first_pass_after_start_is_full_and_the_next_incremental() {
    let fx = Fixture::new("CONDSTORE QRESYNC", &[("INBOX", 20)]).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mail.sqlite");
    let mut conn = fx.connect().await;
    {
        let store = Store::open(&path).unwrap();
        store
            .replace_folders(
                "a",
                &[imap::Folder {
                    name: "INBOX".into(),
                    display_name: "INBOX".into(),
                    delimiter: None,
                    role: None,
                    selectable: true,
                    hidden: false,
                }],
            )
            .unwrap();
        sync(&mut conn, &store, "INBOX").await;
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 0, 0, 20));
    assert_eq!(counts(sync(&mut conn, &store, "INBOX").await), report(0, 0, 0, 0));
}

#[test]
fn uid_sets_of_the_scripted_server() {
    assert!(in_set("1:3,7", 2, 9) && in_set("1:3,7", 7, 9) && !in_set("1:3,7", 5, 9));
    assert!(in_set("26:*", 20, 20), "n:* holds the largest UID even below n");
}
