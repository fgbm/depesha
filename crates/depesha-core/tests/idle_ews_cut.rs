//! A proxy that resets the streaming request of Exchange after a second (#114): the stream
//! was opened with 200, so the connection has worked and the reconnect does not wait longer
//! with every drop. A fake Exchange on a local socket; no stand needed.

use std::time::{Duration, Instant};

use depesha_core::account::{Credentials, EwsConfig};
use depesha_core::ews;
use depesha_core::idle_pace::{DropCause, IdlePace};
use depesha_core::mail::{self, Conn};
use depesha_core::store::Store;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const NS: &str = r#"xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types""#;

fn soap(op: &str, inner: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:{op}Response {NS}><m:ResponseMessages><m:{op}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{inner}</m:{op}ResponseMessage></m:ResponseMessages></m:{op}Response></s:Body></s:Envelope>"#
    )
}

/// Answers GetFolder and Subscribe; to GetStreamingEvents gives 200 and a chunk, then resets
/// the connection after a second.
async fn fake_exchange() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut r = BufReader::new(stream);
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let mut len = 0;
                    loop {
                        let mut h = String::new();
                        r.read_line(&mut h).await.unwrap();
                        let h = h.trim_end().to_ascii_lowercase();
                        if h.is_empty() {
                            break;
                        }
                        if let Some(v) = h.strip_prefix("content-length:") {
                            len = v.trim().parse().unwrap();
                        }
                    }
                    let mut body = vec![0; len];
                    r.read_exact(&mut body).await.unwrap();
                    let body = String::from_utf8_lossy(&body);
                    if body.contains("GetStreamingEvents") {
                        let w = r.get_mut();
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nTransfer-Encoding: chunked\r\n\r\n";
                        let beat = "<Heartbeat/>";
                        let _ = w
                            .write_all(format!("{head}{:x}\r\n{beat}\r\n", beat.len()).as_bytes())
                            .await;
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        // A reset, not a close: the proxy killed the connection.
                        #[allow(deprecated)] // SO_LINGER 0 is the reset this test needs
                        let _ = w.set_linger(Some(Duration::ZERO));
                        return;
                    }
                    let reply = if body.contains("Subscribe") {
                        soap("Subscribe", "<m:SubscriptionId>sub1</m:SubscriptionId>")
                    } else if body.contains("Unsubscribe") {
                        soap("Unsubscribe", "")
                    } else {
                        soap("GetFolder", "")
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/xml; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
                        reply.len()
                    );
                    let w = r.get_mut();
                    if w.write_all(head.as_bytes()).await.is_err() || w.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn a_stream_reset_after_it_opened_does_not_lengthen_the_pause() {
    let port = fake_exchange().await;
    let config = EwsConfig {
        url: format!("http://127.0.0.1:{port}/EWS/Exchange.asmx"),
        trusted_cert: None,
    };
    let creds = Credentials::new("me", "secret");
    let store = Store::open_in_memory().unwrap();
    store.ews_set_folders("a", &[("INBOX".into(), "I".into())]).unwrap();
    let mut pace = IdlePace::new();
    let mut pauses = Vec::new();
    while pauses.len() < 4 {
        let session = ews::connect(&config, &creds, "me@corp.ru").await.unwrap();
        let connected = Instant::now();
        let mut conn = Conn::Ews(session);
        // The first wait of a connection after a drop ends at once (a sync is due); the next opens the stream.
        loop {
            match mail::wait_for_changes(conn, &store, "a", Duration::from_secs(1), &mut pace, connected).await {
                Ok((c, _)) => conn = c,
                Err(d) => {
                    assert!(matches!(d.cause, DropCause::Reset | DropCause::Eof), "{:?}", d.cause);
                    pauses.push(d.dropped.expect("not a busy server").pause);
                    break;
                }
            }
        }
    }
    assert!(pauses.iter().all(|p| *p == Duration::from_secs(5)), "{pauses:?}");
}
