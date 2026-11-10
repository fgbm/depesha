//! A body read on a plain IMAP socket whose answer the caller waits for: a short window
//! for the operator's sake ends a silence quickly, and a body that keeps arriving is read
//! to the end however long it takes. A scripted server sends the header of a BODY literal
//! and then either goes quiet or feeds the literal in pieces. Needs no network beyond
//! localhost; always runs.

#![cfg(test)]

use std::io;
use std::time::Duration;

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap::{self, Conn};
use depesha_core::unheard;
use depesha_core::{Error, mail};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::TcpListener;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::oneshot;

/// What the operator waits for: short enough to fail inside the test's budget, and far
/// longer than the fake takes to answer anything it does answer.
const LIMIT: Duration = Duration::from_millis(300);
const SILENCE: Duration = Duration::from_millis(300);
/// A body read the operator waits for must fail well inside this once the server is quiet.
const FAILURE_BUDGET: Duration = Duration::from_secs(2);
/// How long the test waits for a stage of the scripted server; not a timing assertion.
const READY: Duration = Duration::from_secs(5);

const CHUNK: usize = 400;
const CHUNKS: usize = 8;
/// The gap between two pieces of the literal: inside the silence window, so the whole
/// answer may take as long as it likes.
const GAP: Duration = Duration::from_millis(120);

fn body() -> Vec<u8> {
    (0..CHUNK * CHUNKS).map(|n| b'a' + (n % 26) as u8).collect()
}

/// One logged-in socket, and the line of the fetch that came after the login.
type Socket = (Lines<BufReader<OwnedReadHalf>>, OwnedWriteHalf);

/// Answers the greeting, the login, the capability list and the selection; gives the socket
/// back with the fetch command that came next, still unanswered.
async fn greet(sock: tokio::net::TcpStream) -> Option<(Socket, String)> {
    let (r, mut w) = sock.into_split();
    let mut lines = BufReader::new(r).lines();
    w.write_all(b"* OK IMAP4rev1 ready\r\n").await.ok()?;
    while let Some(line) = lines.next_line().await.ok()? {
        let mut parts = line.split_whitespace();
        let tag = parts.next().unwrap_or("*");
        let command = parts.next().unwrap_or("").to_ascii_uppercase();
        if command == "UID" {
            return Some(((lines, w), line));
        }
        let reply = match command.as_str() {
            "CAPABILITY" => format!("* CAPABILITY IMAP4rev1 UIDPLUS\r\n{tag} OK done\r\n"),
            "EXAMINE" | "SELECT" => {
                format!("* 1 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n{tag} OK [READ-ONLY] done\r\n")
            }
            "LOGIN" => format!("{tag} OK logged in\r\n"),
            "LOGOUT" => format!("* BYE bye\r\n{tag} OK done\r\n"),
            other => unreachable!("the client asks nothing else: {other}"),
        };
        w.write_all(reply.as_bytes()).await.ok()?;
    }
    None
}

/// Serves one login and the header of a BODY literal for the fetch, then nothing: `ready`
/// says when that header is on the wire.
async fn quiet_body_server() -> (u16, oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sent, ready) = oneshot::channel();
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let Some(((_, mut w), _fetch)) = greet(sock).await else {
            return;
        };
        let header = format!("* 1 FETCH (UID 1 BODY[] {{{}}}\r\n", body().len());
        if w.write_all(header.as_bytes()).await.is_err() {
            return;
        }
        unheard(sent.send(()));
        // The socket stays open and quiet: the rest of the literal never comes.
        std::future::pending::<()>().await;
    });
    (port, ready)
}

/// Serves one login, then the whole literal in pieces, each after a gap inside the silence
/// window: `ready` says when the first piece is about to go.
async fn chunked_body_server() -> (u16, oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sent, ready) = oneshot::channel();
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let Some(((_, mut w), fetch)) = greet(sock).await else {
            return;
        };
        let tag = fetch.split_whitespace().next().unwrap_or("*").to_owned();
        let whole = body();
        let header = format!("* 1 FETCH (UID 1 BODY[] {{{}}}\r\n", whole.len());
        if w.write_all(header.as_bytes()).await.is_err() {
            return;
        }
        unheard(sent.send(()));
        for piece in whole.chunks(CHUNK) {
            tokio::time::sleep(GAP).await;
            if w.write_all(piece).await.is_err() {
                return;
            }
        }
        let tail = format!(")\r\n{tag} OK fetch done\r\n");
        unheard(w.write_all(tail.as_bytes()).await);
    });
    (port, ready)
}

async fn connect(port: u16) -> Conn {
    let server = ServerConfig::new("127.0.0.1", port, Security::Plain);
    imap::connect(&server, &Credentials::new("u", "p"))
        .await
        .expect("login over a plain socket")
}

/// `unheard` hides only a receiver that is gone; the test's own stages must arrive.
async fn arrived(ready: oneshot::Receiver<()>) {
    tokio::time::timeout(READY, ready)
        .await
        .expect("the server reaches its stage")
        .expect("the server still runs");
}

#[tokio::test]
async fn a_body_that_stops_coming_fails_inside_the_short_window() {
    let (port, header_sent) = quiet_body_server().await;
    let conn = mail::Conn::Imap(connect(port).await);
    // The worker's way in: the window is asked for on the connection and outlives the
    // borrow the read takes of it.
    let window = conn.interactive_with(LIMIT, SILENCE).expect("IMAP gives a window");
    let mail::Conn::Imap(mut conn) = conn else {
        unreachable!("the fake is an IMAP server")
    };
    let read = tokio::spawn(async move {
        let _window = window;
        imap::fetch_raw(&mut conn, "INBOX", 1).await
    });
    arrived(header_sent).await;
    let answer = tokio::time::timeout(FAILURE_BUDGET, read)
        .await
        .expect("the read gives up on the silent literal inside the short window")
        .expect("the read task");
    match answer {
        Err(Error::Imap(async_imap::error::Error::Io(e))) => assert_eq!(e.kind(), io::ErrorKind::TimedOut),
        Err(other) => panic!("unexpected: {other:?}"),
        Ok(raw) => panic!("the body came whole: {} bytes", raw.len()),
    }
}

#[tokio::test]
async fn a_body_that_keeps_coming_is_read_to_the_end() {
    let (port, started) = chunked_body_server().await;
    let mut conn = connect(port).await;
    let window = conn.interactive_with(LIMIT, SILENCE);
    let began = tokio::time::Instant::now();
    let read = tokio::spawn(async move {
        let _window = window;
        imap::fetch_raw(&mut conn, "INBOX", 1).await
    });
    arrived(started).await;
    let raw = read.await.expect("the read task").expect("the whole body");
    assert_eq!(raw, body());
    assert!(
        began.elapsed() > SILENCE * 2,
        "the answer was too quick to stand for a long one: {:?}",
        began.elapsed()
    );
}
