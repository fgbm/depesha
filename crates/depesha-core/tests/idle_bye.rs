//! What a server says before it cuts an IDLE reaches the caller (#114): a fake IMAP server
//! on a local socket answers just enough, idles, and then says `* BYE` with a reason, or
//! closes without a word. No stand needed.

#![cfg(test)]
#![allow(
    clippy::too_many_lines,
    reason = "a scenario test reads from the first line to the last: its steps are its length"
)]

use std::time::{Duration, Instant};

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::domain::FlagChange;
use depesha_core::idle_pace::{DropCause, IdlePace, Tuning};
use depesha_core::imap::{self, IdleOutcome};
use depesha_core::mail::{self, Conn};
use depesha_core::store::Store;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::net::TcpStream;

/// Serves one connection; after `+ idling` it says `ending` (if any) and closes.
async fn fake_server(ending: Option<&'static str>) -> u16 {
    fake_server_with(true, ending).await
}

/// A server with no IDLE closes the link right after its SELECT was answered.
async fn fake_server_with(idle: bool, ending: Option<&'static str>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let caps = if idle { "IMAP4rev1 IDLE" } else { "IMAP4rev1" };
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let (r, mut w) = sock.into_split();
        let mut lines = BufReader::new(r).lines();
        w.write_all(b"* OK [CAPABILITY IMAP4rev1 IDLE] ready\r\n")
            .await
            .unwrap();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut parts = line.split_whitespace();
            let (tag, cmd) = (
                parts.next().unwrap_or("*"),
                parts.next().unwrap_or("").to_ascii_uppercase(),
            );
            let reply = match cmd.as_str() {
                "CAPABILITY" => format!("* CAPABILITY {caps}\r\n{tag} OK done\r\n"),
                "SELECT" if !idle => {
                    // Answers the SELECT and closes: the link breaks while the client polls.
                    w.write_all(format!("* 0 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 1] ok\r\n{tag} OK [READ-WRITE] done\r\n").as_bytes())
                        .await
                        .unwrap();
                    return;
                }
                "SELECT" => format!(
                    "* 0 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 1] ok\r\n{tag} OK [READ-WRITE] done\r\n"
                ),
                "IDLE" => {
                    w.write_all(b"+ idling\r\n").await.unwrap();
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if let Some(text) = ending {
                        w.write_all(format!("* BYE {text}\r\n").as_bytes()).await.unwrap();
                    }
                    return;
                }
                _ => format!("{tag} OK done\r\n"),
            };
            w.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    port
}

async fn wait_on(port: u16) -> Box<mail::IdleDrop> {
    let server = ServerConfig::new("127.0.0.1", port, Security::Plain);
    let conn = imap::connect(&server, &Credentials::new("u", "p"))
        .await
        .expect("login");
    let store = Store::open_in_memory().unwrap();
    let mut pace = IdlePace::new();
    mail::wait_for_changes(
        Conn::Imap(conn),
        &store,
        "a",
        Duration::from_secs(1),
        &mut pace,
        std::time::Instant::now(),
    )
    .await
    .err()
    .expect("the server cuts the wait")
}

#[tokio::test]
async fn the_reason_of_a_bye_is_kept() {
    let d = wait_on(fake_server(Some("Idle timeout, goodbye")).await).await;
    assert_eq!(d.cause, DropCause::Bye("Idle timeout, goodbye".into()), "{:?}", d.error);
    assert!(d.error.to_string().contains("Idle timeout"), "{}", d.error);
    assert!(d.since_wait >= Duration::from_millis(250));
}

#[tokio::test]
async fn a_close_without_a_word_is_an_eof() {
    let d = wait_on(fake_server(None).await).await;
    assert!(matches!(d.cause, DropCause::Eof | DropCause::Reset), "{:?}", d.cause);
}

/// A server without IDLE is polled: once its SELECT went through, the connection has worked, and
/// a break after that does not push the reconnect further away.
#[tokio::test]
async fn a_polled_connection_that_selected_has_worked() {
    let server = ServerConfig::new("127.0.0.1", fake_server_with(false, None).await, Security::Plain);
    let conn = imap::connect(&server, &Credentials::new("u", "p"))
        .await
        .expect("login");
    let store = Store::open_in_memory().unwrap();
    let mut pace = IdlePace::new();
    // Two connections that failed at once: the pause is already 20 s.
    for _ in 0..2 {
        let info = depesha_core::idle_pace::DropInfo {
            cause: DropCause::Eof,
            since_wait: Duration::ZERO,
            since_connect: Duration::ZERO,
            renew: None,
            worked: false,
        };
        pace.dropped(&info);
        // A renewal that went through in between: the pause is not the series' doing.
        pace.renewed();
    }
    // The connection is a first one, not a reconnect after a drop: no resync.
    pace.take_resync();
    let d = mail::wait_for_changes(
        Conn::Imap(conn),
        &store,
        "a",
        Duration::from_millis(200),
        &mut pace,
        std::time::Instant::now(),
    )
    .await
    .err()
    .expect("the server cuts after the SELECT");
    assert_eq!(d.dropped.unwrap().pause, Duration::from_secs(5));
}

/// What a server does with an IDLE it has started.
#[derive(Clone, Copy)]
enum Idling {
    /// Sends `* OK Still here` every 100 ms; closes after `cut` of the IDLE, answers DONE before that.
    Keepalive { cut: Duration },
    /// Closes the link at once.
    Cut,
    /// Takes the IDLE and closes the link when DONE comes.
    CutAtDone,
}

/// Serves connections one after another, each as `idling` says; a SELECT is answered unless `select_dies`.
async fn fake_servers(idling: Idling, select_dies: bool) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (sock, _) = listener.accept().await.unwrap();
            tokio::spawn(serve(sock, idling, select_dies));
        }
    });
    port
}

async fn serve(sock: TcpStream, idling: Idling, select_dies: bool) {
    let (r, mut w) = sock.into_split();
    let mut lines = BufReader::new(r).lines();
    if w.write_all(b"* OK [CAPABILITY IMAP4rev1 IDLE] ready\r\n")
        .await
        .is_err()
    {
        return;
    }
    while let Ok(Some(line)) = lines.next_line().await {
        let mut parts = line.split_whitespace();
        let (tag, cmd) = (
            parts.next().unwrap_or("*").to_owned(),
            parts.next().unwrap_or("").to_ascii_uppercase(),
        );
        let reply = match cmd.as_str() {
            "CAPABILITY" => format!("* CAPABILITY IMAP4rev1 IDLE\r\n{tag} OK done\r\n"),
            "SELECT" if select_dies => return,
            "SELECT" => format!(
                "* 0 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 1] ok\r\n{tag} OK [READ-WRITE] done\r\n"
            ),
            "IDLE" => {
                if w.write_all(b"+ idling\r\n").await.is_err() {
                    return;
                }
                let began = Instant::now();
                loop {
                    match idling {
                        Idling::Cut => return,
                        Idling::Keepalive { cut } if began.elapsed() >= cut => return,
                        _ => {}
                    }
                    tokio::select! {
                        done = lines.next_line() => {
                            if done.ok().flatten().is_none() || matches!(idling, Idling::CutAtDone) {
                                return;
                            }
                            // DONE: the IDLE ends.
                            if w.write_all(format!("{tag} OK idle done\r\n").as_bytes()).await.is_err() {
                                return;
                            }
                            break;
                        }
                        () = tokio::time::sleep(Duration::from_millis(100)) => {
                            if matches!(idling, Idling::Keepalive { .. })
                                && w.write_all(b"* OK Still here\r\n").await.is_err()
                            {
                                return;
                            }
                        }
                    }
                }
                continue;
            }
            _ => format!("{tag} OK done\r\n"),
        };
        if w.write_all(reply.as_bytes()).await.is_err() {
            return;
        }
    }
}

async fn connect_to(port: u16) -> imap::Conn {
    let server = ServerConfig::new("127.0.0.1", port, Security::Plain);
    imap::connect(&server, &Credentials::new("u", "p"))
        .await
        .expect("login")
}

/// The server sends a keep-alive line every 100 ms and would cut the link after 3 s: the
/// renewal after 1 s must still come, counted from the start of the IDLE (#114, Yandex).
#[tokio::test]
async fn a_renewal_falls_due_on_time_though_the_server_keeps_talking() {
    let port = fake_servers(
        Idling::Keepalive {
            cut: Duration::from_secs(3),
        },
        false,
    )
    .await;
    let conn = connect_to(port).await;
    let began = Instant::now();
    let (_, outcome) = imap::wait_for_changes(conn, "INBOX", Duration::from_secs(1), Duration::from_secs(1))
        .await
        .expect("the renewal comes before the cut");
    assert!(matches!(outcome, IdleOutcome::Timeout));
    assert!(began.elapsed() < Duration::from_millis(2500), "{:?}", began.elapsed());
}

/// A server that cuts the link at once, again and again: after a few cuts the pause grows
/// and the inbox is polled, with one notice (#114, corporate server).
#[tokio::test]
async fn a_link_cut_at_once_each_time_ends_in_polling() {
    let port = fake_servers(Idling::Cut, false).await;
    let store = Store::open_in_memory().unwrap();
    let mut pace = IdlePace::with(Tuning {
        poll_after: 4,
        ..Tuning::default()
    });
    let (mut pauses, mut notices) = (Vec::new(), 0);
    while !pace.polling() {
        let conn = connect_to(port).await;
        // No resync: the cache is empty and the test is about the wait.
        pace.take_resync();
        let d = mail::wait_for_changes(
            Conn::Imap(conn),
            &store,
            "a",
            Duration::from_secs(1),
            &mut pace,
            Instant::now(),
        )
        .await
        .err()
        .expect("the server cuts the wait");
        let verdict = d.dropped.expect("not a busy server");
        pauses.push(verdict.pause.as_secs());
        notices += usize::from(verdict.to_poll);
    }
    assert_eq!(pauses, [5, 5, 10, 20]);
    assert_eq!(notices, 1);
    let conn = connect_to(port).await;
    let began = Instant::now();
    let (_, outcome) = mail::wait_for_changes(
        Conn::Imap(conn),
        &store,
        "a",
        Duration::from_millis(300),
        &mut pace,
        Instant::now(),
    )
    .await
    .map_err(|d| d.error)
    .expect("a poll needs no IDLE");
    assert!(matches!(outcome, IdleOutcome::Changed));
    assert!(began.elapsed() >= Duration::from_millis(300));
}

/// The server closes the link when our DONE of a planned renewal arrives: that is no drop in a row.
#[tokio::test]
async fn a_link_closed_at_our_renewal_is_not_counted_as_a_drop() {
    let port = fake_servers(Idling::CutAtDone, false).await;
    let store = Store::open_in_memory().unwrap();
    let mut pace = IdlePace::with(Tuning {
        max: Duration::from_millis(500),
        ..Tuning::default()
    });
    for _ in 0..3 {
        let conn = connect_to(port).await;
        // No resync: the cache is empty and the test is about the wait.
        pace.take_resync();
        let d = mail::wait_for_changes(
            Conn::Imap(conn),
            &store,
            "a",
            Duration::from_secs(1),
            &mut pace,
            Instant::now(),
        )
        .await
        .err()
        .expect("the server closes at DONE");
        let verdict = d.dropped.expect("not a busy server");
        assert!(verdict.at_renewal, "since the wait {:?}", d.since_wait);
        assert_eq!(
            (verdict.drops, verdict.log, verdict.pause),
            (0, false, Duration::from_secs(5))
        );
    }
    assert!(!pace.polling());
}

/// A SELECT on a link that has died is a broken link, to be run again on a fresh one, not a
/// folder that changed on the server (#114: "the folder changed … before the action ran").
#[tokio::test]
async fn a_dead_link_is_no_change_of_the_folder() {
    let port = fake_servers(Idling::Cut, true).await;
    let mut conn = connect_to(port).await;
    for _ in 0..2 {
        let e = imap::set_flag(&mut conn, "INBOX", Some(1), &[1], FlagChange::Seen(true))
            .await
            .expect_err("the link is dead");
        assert!(e.is_transient(), "{e:?}");
    }
}
