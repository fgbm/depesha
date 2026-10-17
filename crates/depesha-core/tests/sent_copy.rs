//! The copy of a sent letter in «Sent» against a scripted IMAP server that refuses
//! `SEARCH HEADER`, as Yandex does (`NO [UNAVAILABLE] UID SEARCH Backend error`): the copy is
//! looked for another way, and is neither uploaded twice nor counted as refused. Needs no
//! network beyond localhost; always runs.

#![cfg(test)]

use std::sync::{Arc, Mutex};

use depesha_core::Error;
use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap::{self, Conn};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(Default)]
struct Server {
    /// The letters of «Sent»: UID and Message-ID, oldest first.
    letters: Vec<(u32, String)>,
    /// The UID the next appended letter gets.
    uid_next: u32,
    /// Answers `UID SEARCH HEADER …` with NO.
    refuse_header: bool,
    /// Answers `UID SEARCH SINCE …` with NO.
    refuse_since: bool,
    /// Answers every FETCH with NO as well.
    refuse_fetch: bool,
    log: Vec<String>,
}

type Shared = Arc<Mutex<Server>>;

const MID: &str = "copy-1@depesha.local";

fn letter(mid: &str) -> Vec<u8> {
    format!("Date: Fri, 16 Oct 2026 10:00:00 +0300\r\nMessage-ID: <{mid}>\r\nSubject: x\r\n\r\nbody\r\n").into_bytes()
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
    let mut r = BufReader::new(r);
    w.write_all(b"* OK [CAPABILITY IMAP4rev1 UIDPLUS] scripted ready\r\n")
        .await
        .unwrap();
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end().to_owned();
        let (tag, cmd) = line.split_once(' ').unwrap();
        server.lock().unwrap().log.push(cmd.to_owned());
        if cmd.to_ascii_uppercase().starts_with("APPEND ") {
            // The literal follows the "+" (no LITERAL+ is listed).
            let size: usize = cmd[cmd.rfind('{').unwrap() + 1..cmd.len() - 1].parse().unwrap();
            w.write_all(b"+ go on\r\n").await.unwrap();
            let mut raw = vec![0; size + 2];
            r.read_exact(&mut raw).await.unwrap();
            let text = String::from_utf8_lossy(&raw);
            let mid = text
                .lines()
                .find_map(|l| l.strip_prefix("Message-ID: <"))
                .map(|m| m.trim_end_matches('>').to_owned())
                .unwrap_or_default();
            let reply = {
                let mut s = server.lock().unwrap();
                let uid = s.uid_next;
                s.uid_next += 1;
                s.letters.push((uid, mid));
                format!("{tag} OK [APPENDUID 7 {uid}] done\r\n")
            };
            w.write_all(reply.as_bytes()).await.unwrap();
            continue;
        }
        let reply = respond(&server.lock().unwrap(), tag, cmd);
        w.write_all(reply.as_bytes()).await.unwrap();
        if cmd.starts_with("LOGOUT") {
            return;
        }
    }
}

/// The UIDs (or, with `by_seq`, the sequence numbers) an IMAP set names among the letters.
fn picked(server: &Server, set: &str, by_seq: bool) -> Vec<usize> {
    let keys: Vec<u32> = if by_seq {
        (1..=server.letters.len() as u32).collect()
    } else {
        server.letters.iter().map(|l| l.0).collect()
    };
    let max = keys.last().copied().unwrap_or(0);
    let num = |s: &str| if s == "*" { max } else { s.parse().unwrap() };
    let mut out = Vec::new();
    for part in set.split(',') {
        let (a, b) = part
            .split_once(':')
            .map_or_else(|| (num(part), num(part)), |(a, b)| (num(a), num(b)));
        let (lo, hi) = (a.min(b), a.max(b));
        out.extend(
            keys.iter()
                .enumerate()
                .filter(|(_, k)| (lo..=hi).contains(*k))
                .map(|(i, _)| i),
        );
    }
    out
}

fn respond(server: &Server, tag: &str, cmd: &str) -> String {
    let ok = |out: String| format!("{out}{tag} OK done\r\n");
    let upper = cmd.to_ascii_uppercase();
    if upper.starts_with("CAPABILITY") {
        return ok("* CAPABILITY IMAP4rev1 UIDPLUS\r\n".into());
    }
    if upper.starts_with("EXAMINE ") {
        return format!(
            "* FLAGS (\\Seen)\r\n* {} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT {}] ok\r\n{tag} OK [READ-ONLY] done\r\n",
            server.letters.len(),
            server.uid_next
        );
    }
    if upper.starts_with("UID SEARCH HEADER") {
        if server.refuse_header {
            return format!("{tag} NO [UNAVAILABLE] UID SEARCH Backend error. sc=abc\r\n");
        }
        let needle = cmd.split('"').nth(1).unwrap();
        let uids: Vec<String> = server
            .letters
            .iter()
            .filter(|l| l.1.contains(needle))
            .map(|l| l.0.to_string())
            .collect();
        return ok(format!("* SEARCH {}\r\n", uids.join(" ")));
    }
    if upper.starts_with("UID SEARCH SINCE") {
        if server.refuse_since {
            return format!("{tag} NO [UNAVAILABLE] UID SEARCH Backend error. sc=def\r\n");
        }
        let uids: Vec<String> = server.letters.iter().map(|l| l.0.to_string()).collect();
        return ok(format!("* SEARCH {}\r\n", uids.join(" ")));
    }
    if let Some(rest) = upper
        .strip_prefix("UID FETCH ")
        .or_else(|| upper.strip_prefix("FETCH "))
    {
        let by_seq = upper.starts_with("FETCH ");
        if server.refuse_fetch {
            return format!("{tag} NO [UNAVAILABLE] FETCH Backend error\r\n");
        }
        let (set, items) = rest.split_once(' ').unwrap();
        let mut out = String::new();
        for i in picked(server, set, by_seq) {
            let (uid, mid) = &server.letters[i];
            let seq = i + 1;
            if items.contains("HEADER.FIELDS") {
                let header = format!("Message-ID: <{mid}>\r\n\r\n");
                out += &format!(
                    "* {seq} FETCH (UID {uid} FLAGS () RFC822.SIZE 100 BODY[HEADER.FIELDS (MESSAGE-ID)] {{{}}}\r\n{header})\r\n",
                    header.len()
                );
            } else {
                out += &format!("* {seq} FETCH (UID {uid})\r\n");
            }
        }
        return ok(out);
    }
    ok(String::new())
}

async fn fixture(server: Server) -> (Shared, Conn) {
    let server = Arc::new(Mutex::new(server));
    let port = serve(server.clone()).await;
    let config = ServerConfig::new("127.0.0.1", port, Security::Plain);
    let conn = imap::connect(&config, &Credentials::new("alice", "secret"))
        .await
        .unwrap();
    (server, conn)
}

/// «Sent» with the copy among other letters: the copy filed by the server itself, as Yandex
/// does with a letter sent over SMTP.
fn with_copy() -> Server {
    Server {
        letters: vec![
            (3, "other@depesha.local".into()),
            (5, MID.into()),
            (6, format!("x{MID}")),
        ],
        uid_next: 7,
        refuse_header: true,
        ..Server::default()
    }
}

fn without_copy() -> Server {
    Server {
        letters: vec![(3, "other@depesha.local".into()), (6, format!("x{MID}"))],
        ..with_copy()
    }
}

fn appends(server: &Shared) -> usize {
    server
        .lock()
        .unwrap()
        .log
        .iter()
        .filter(|c| c.starts_with("APPEND"))
        .count()
}

async fn file(conn: &mut Conn) -> depesha_core::Result<()> {
    imap::append_unless_exists(conn, "Sent", &letter(MID), "\\Seen", Some(MID)).await
}

#[tokio::test]
async fn a_refused_header_search_finds_the_copy_the_server_filed_itself() {
    let (server, mut conn) = fixture(with_copy()).await;
    file(&mut conn).await.unwrap();
    assert_eq!(appends(&server), 0);
    let log = server.lock().unwrap().log.clone();
    assert!(
        log.iter().any(|c| c.starts_with("UID SEARCH SINCE 15-Oct-2026")),
        "{log:?}"
    );
}

#[tokio::test]
async fn a_refused_header_search_without_the_copy_uploads_it_once() {
    let (server, mut conn) = fixture(without_copy()).await;
    file(&mut conn).await.unwrap();
    assert_eq!(appends(&server), 1);
    // The next try finds the copy it made and does not upload it again.
    file(&mut conn).await.unwrap();
    assert_eq!(appends(&server), 1);
}

#[tokio::test]
async fn both_searches_refused_read_the_newest_uids() {
    let (server, mut conn) = fixture(Server {
        refuse_since: true,
        ..with_copy()
    })
    .await;
    file(&mut conn).await.unwrap();
    assert_eq!(appends(&server), 0);
    let log = server.lock().unwrap().log.clone();
    assert!(log.iter().any(|c| c == "UID FETCH 1:* (UID)"), "{log:?}");

    let (server, mut conn) = fixture(Server {
        refuse_since: true,
        ..without_copy()
    })
    .await;
    file(&mut conn).await.unwrap();
    assert_eq!(appends(&server), 1);
}

#[tokio::test]
async fn a_check_refused_every_way_is_unchecked_and_uploads_nothing() {
    let (server, mut conn) = fixture(Server {
        refuse_since: true,
        refuse_fetch: true,
        ..without_copy()
    })
    .await;
    let e = file(&mut conn).await.unwrap_err();
    assert!(matches!(e, Error::CopyUnchecked(_)), "{e:?}");
    assert!(e.append_refused());
    assert!(e.to_string().contains("could not check"), "{e}");
    assert_eq!(appends(&server), 0);
}

#[tokio::test]
async fn a_header_search_that_works_is_the_only_search() {
    let (server, mut conn) = fixture(Server {
        refuse_header: false,
        ..with_copy()
    })
    .await;
    file(&mut conn).await.unwrap();
    assert_eq!(appends(&server), 0);
    let log = server.lock().unwrap().log.clone();
    assert!(!log.iter().any(|c| c.contains("SINCE")), "{log:?}");
}

#[tokio::test]
async fn a_refused_header_read_is_an_error_not_a_missing_copy() {
    // async-imap ends a fetch at its tagged answer whatever the status: read as "no such
    // letter", a refusal would upload the copy a second time.
    let (server, mut conn) = fixture(Server {
        refuse_header: false,
        refuse_fetch: true,
        ..with_copy()
    })
    .await;
    let e = file(&mut conn).await.unwrap_err();
    assert!(e.append_refused(), "{e:?}");
    assert_eq!(appends(&server), 0);
}
