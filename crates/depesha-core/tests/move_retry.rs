//! A move on a link that has died is run again on a fresh one, once, and the letter ends up
//! in one folder (#114 review): a fake IMAP server whose first connection dies at the
//! SELECT, and which counts the MOVE commands it gets.

#![cfg(test)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap::{self, Conn};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// The first connection dies when it selects; the later ones answer. Every `UID MOVE` is counted.
async fn fake_server(moves: Arc<AtomicUsize>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut first = true;
        loop {
            let (sock, _) = listener.accept().await.unwrap();
            tokio::spawn(serve(sock, std::mem::take(&mut first), moves.clone()));
        }
    });
    port
}

async fn serve(sock: TcpStream, select_dies: bool, moves: Arc<AtomicUsize>) {
    let (r, mut w) = sock.into_split();
    let mut lines = BufReader::new(r).lines();
    if w.write_all(b"* OK [CAPABILITY IMAP4rev1 MOVE] ready\r\n")
        .await
        .is_err()
    {
        return;
    }
    while let Ok(Some(line)) = lines.next_line().await {
        let mut parts = line.split_whitespace();
        let tag = parts.next().unwrap_or("*").to_owned();
        let cmd = parts.next().unwrap_or("").to_ascii_uppercase();
        let sub = parts.next().unwrap_or("").to_ascii_uppercase();
        let reply = match (cmd.as_str(), sub.as_str()) {
            ("CAPABILITY", _) => format!("* CAPABILITY IMAP4rev1 MOVE\r\n{tag} OK done\r\n"),
            ("SELECT", _) if select_dies => return,
            ("SELECT", _) => {
                format!(
                    "* 1 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 2] ok\r\n{tag} OK [READ-WRITE] done\r\n"
                )
            }
            ("UID", "MOVE") => {
                moves.fetch_add(1, Ordering::SeqCst);
                format!("{tag} OK moved\r\n")
            }
            _ => format!("{tag} OK done\r\n"),
        };
        if w.write_all(reply.as_bytes()).await.is_err() {
            return;
        }
    }
}

async fn connect_to(port: u16) -> Conn {
    let server = ServerConfig::new("127.0.0.1", port, Security::Plain);
    imap::connect(&server, &Credentials::new("u", "p"))
        .await
        .expect("login")
}

#[tokio::test]
async fn a_move_cut_at_the_select_is_run_again_on_a_new_link_and_moves_the_letter_once() {
    let moves = Arc::new(AtomicUsize::new(0));
    let port = fake_server(moves.clone()).await;
    let mut dead = connect_to(port).await;
    let e = imap::move_messages(&mut dead, "INBOX", Some(1), &[1], "Archive")
        .await
        .expect_err("the link is dead");
    assert!(matches!(e, depesha_core::Error::Closed), "{e:?}");
    assert!(e.is_transient());
    assert_eq!(moves.load(Ordering::SeqCst), 0, "nothing moved on the dead link");
    let mut fresh = connect_to(port).await;
    imap::move_messages(&mut fresh, "INBOX", Some(1), &[1], "Archive")
        .await
        .expect("the second try goes through");
    assert_eq!(
        moves.load(Ordering::SeqCst),
        1,
        "the letter is moved once, to one folder"
    );
}
