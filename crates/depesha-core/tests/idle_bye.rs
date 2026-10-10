//! What a server says before it cuts an IDLE reaches the caller (#114): a fake IMAP server
//! on a local socket answers just enough, idles, and then says `* BYE` with a reason, or
//! closes without a word. No stand needed.

use std::time::Duration;

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::idle_pace::{DropCause, IdlePace};
use depesha_core::imap;
use depesha_core::mail::{self, Conn};
use depesha_core::store::Store;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// Serves one connection; after `+ idling` it says `ending` (if any) and closes.
async fn fake_server(ending: Option<&'static str>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
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
                "CAPABILITY" => format!("* CAPABILITY IMAP4rev1 IDLE\r\n{tag} OK done\r\n"),
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
