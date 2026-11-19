//! A scripted SMTP server that answers like Exchange 2019 client submission,
//! including a misconfigured client connector (587 without STARTTLS, AUTH GSSAPI NTLM only).
//! Needs no network beyond localhost; always runs.

#![cfg(test)]
#![allow(
    clippy::too_many_lines,
    reason = "a scenario test reads from the first line to the last: its steps are its length"
)]

use depesha_core::account::{Account, Credentials, Security, ServerConfig};
use depesha_core::domain::Addr;
use depesha_core::domain::Draft;
use depesha_core::outbox::{self, Attempt, English, Hold, Progress, Words};
use depesha_core::port::Sender;
use depesha_core::store::Store;
use depesha_core::{Error, smtp};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// How the fake server reacts after login.
#[derive(Clone, Copy)]
enum Script {
    /// EHLO offers only GSSAPI and NTLM, as a misconfigured Exchange 587 does.
    NtlmOnly,
    /// Accepts AUTH LOGIN, then answers MAIL FROM with this reply.
    LoginThen(&'static str),
    /// Advertises a small SIZE limit.
    SmallSize,
    /// Accepts everything; records the DATA it got.
    Accept,
    FinalReply(&'static str),
}

async fn fake_exchange(script: Script) -> (u16, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (r, mut w) = stream.into_split();
        let mut lines = BufReader::new(r).lines();
        let mut seen = Vec::new();
        w.write_all(b"220 mail.example.com Microsoft ESMTP MAIL Service ready\r\n")
            .await
            .unwrap();
        let mut in_data = false;
        let mut auth_step = 0;
        while let Ok(Some(line)) = lines.next_line().await {
            seen.push(line.clone());
            if in_data {
                if line == "." {
                    if let Script::FinalReply(reply) = script {
                        w.write_all(reply.as_bytes()).await.unwrap();
                        break;
                    }
                    in_data = false;
                    w.write_all(b"250 2.6.0 <id@mail.example.com> Queued mail for delivery\r\n")
                        .await
                        .unwrap();
                }
                continue;
            }
            if auth_step == 1 {
                auth_step = 2;
                w.write_all(b"334 UGFzc3dvcmQ6\r\n").await.unwrap();
                continue;
            }
            if auth_step == 2 {
                auth_step = 0;
                w.write_all(b"235 2.7.0 Authentication successful\r\n").await.unwrap();
                continue;
            }
            let upper = line.to_ascii_uppercase();
            let reply: String = if upper.starts_with("EHLO") {
                let auth = match script {
                    Script::NtlmOnly => "250-AUTH GSSAPI NTLM\r\n",
                    _ => "250-AUTH NTLM LOGIN\r\n",
                };
                let size = match script {
                    Script::SmallSize => "250-SIZE 1024\r\n",
                    _ => "250-SIZE 37748736\r\n",
                };
                format!(
                    "250-mail.example.com Hello [192.0.2.10]\r\n{size}250-PIPELINING\r\n250-8BITMIME\r\n{auth}250 CHUNKING\r\n"
                )
            } else if upper.starts_with("AUTH LOGIN") {
                auth_step = 1;
                "334 VXNlcm5hbWU6\r\n".into()
            } else if upper.starts_with("MAIL FROM") {
                match script {
                    Script::LoginThen(reply) => format!("{reply}\r\n"),
                    _ => "250 2.1.0 Sender OK\r\n".into(),
                }
            } else if upper.starts_with("RCPT TO") {
                "250 2.1.5 Recipient OK\r\n".into()
            } else if upper == "DATA" {
                in_data = true;
                "354 Start mail input; end with <CRLF>.<CRLF>\r\n".into()
            } else if upper == "QUIT" {
                w.write_all(b"221 2.0.0 Service closing transmission channel\r\n")
                    .await
                    .unwrap();
                break;
            } else {
                "500 5.3.3 Unrecognized command\r\n".into()
            };
            w.write_all(reply.as_bytes()).await.unwrap();
        }
        seen
    });
    (port, handle)
}

fn draft() -> Draft {
    Draft {
        from: Some(Addr {
            name: Some("Иван".into()),
            email: "j.doe@example.com".into(),
        }),
        to: vec![Addr {
            name: None,
            email: "it@example.com".into(),
        }],
        subject: "Проверка".into(),
        text: "Текст".into(),
        ..Default::default()
    }
}

fn plain(port: u16) -> ServerConfig {
    ServerConfig::new("127.0.0.1", port, Security::Plain)
}

fn creds() -> Credentials {
    Credentials::new("CONTOSO\\j.doe", "pw")
}

#[tokio::test]
async fn ntlm_only_server_is_explained() {
    let (port, _) = fake_exchange(Script::NtlmOnly).await;
    let err = smtp::send(&plain(port), &creds(), &smtp::build(&draft()).unwrap())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), depesha_core::ErrorKind::Auth);
    assert!(err.to_string().contains("GSSAPI NTLM"), "{err}");
}

#[tokio::test]
async fn rate_limit_is_transient() {
    let (port, _) = fake_exchange(Script::LoginThen(
        "421 4.4.2 Message submission rate for this client has exceeded the configured limit",
    ))
    .await;
    let err = smtp::send(&plain(port), &creds(), &smtp::build(&draft()).unwrap())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), depesha_core::ErrorKind::RateLimited);
    assert!(err.is_transient());
    // The core words it in English; the edge words it for the user.
    assert!(err.to_string().contains("5 messages a minute"), "{err}");
}

#[tokio::test]
async fn send_as_denied_is_permanent() {
    let (port, _) = fake_exchange(Script::LoginThen(
        "550 5.7.60 SMTP; Client does not have permissions to send as this sender",
    ))
    .await;
    let err = smtp::send(&plain(port), &creds(), &smtp::build(&draft()).unwrap())
        .await
        .unwrap_err();
    assert!(!err.is_transient());
    assert!(err.to_string().contains("Send As"), "{err}");
}

#[tokio::test]
async fn size_limit_is_checked_before_sending() {
    let (port, _) = fake_exchange(Script::SmallSize).await;
    let mut d = draft();
    d.text = "x".repeat(4000);
    let err = smtp::send(&plain(port), &creds(), &smtp::build(&d).unwrap())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), depesha_core::ErrorKind::TooLarge, "{err}");
}

#[tokio::test]
async fn a_broken_connection_after_the_data_terminator_is_not_retried() {
    let (port, seen) = fake_exchange(Script::FinalReply("")).await;
    let stage = smtp::Stage::new();
    let err = smtp::send_with_stage(&plain(port), &creds(), &smtp::build(&draft()).unwrap(), &stage)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::SmtpUnconfirmed(_)), "{err}");
    assert!(!err.is_transient(), "the server may have accepted the message: {err}");
    assert_eq!(stage.get(), "send");
    assert_eq!(seen.await.unwrap().last().map(String::as_str), Some("."));
}

#[tokio::test]
async fn invalid_final_data_replies_do_not_confirm_delivery() {
    for reply in [
        "250 accepted",
        "250 accepted\n",
        "250!accepted\r\n",
        "250 \r accepted\r\n",
        "450-first\r\n250 last\r\n",
        "299 invalid\r\n",
        "221 closing transmission channel\r\n",
        "253 pending messages started\r\n",
        "354 unexpected continuation\r\n",
    ] {
        let (port, _) = fake_exchange(Script::FinalReply(reply)).await;
        let result = smtp::send(&plain(port), &creds(), &smtp::build(&draft()).unwrap())
            .await
            .map(|_| ());
        assert!(
            matches!(result, Err(Error::SmtpUnconfirmed(_))),
            "{reply:?}: {result:?}"
        );
    }
}

#[tokio::test]
async fn complete_final_data_replies_settle_delivery() {
    for reply in ["250\r\n", "250-first\r\n250 accepted\r\n", "259 accepted\r\n"] {
        let (port, _) = fake_exchange(Script::FinalReply(reply)).await;
        smtp::send(&plain(port), &creds(), &smtp::build(&draft()).unwrap())
            .await
            .unwrap();
    }
    for (reply, want_code) in [("451 try again\r\n", 451), ("554 refused\r\n", 554)] {
        let (port, _) = fake_exchange(Script::FinalReply(reply)).await;
        let err = smtp::send(&plain(port), &creds(), &smtp::build(&draft()).unwrap())
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Smtp { code, .. } if code == want_code), "{err}");
        assert_eq!(err.is_transient(), want_code == 451, "{err}");
    }
}

struct OutboxSender {
    server: ServerConfig,
    attempts: usize,
}

impl Sender for &mut OutboxSender {
    async fn send(&mut self, draft: &Draft) -> depesha_core::Result<Vec<u8>> {
        self.attempts += 1;
        smtp::send(&self.server, &creds(), &smtp::build_sent(draft)?).await
    }
}

#[tokio::test]
async fn outbox_holds_a_letter_whose_server_closed_before_confirming_delivery() {
    let (port, seen) = fake_exchange(Script::FinalReply("")).await;
    let store = Store::open_in_memory().unwrap();
    let account: Account = serde_json::from_value(serde_json::json!({
        "id": "a", "display_name": "", "email": "j.doe@example.com", "username": "j.doe",
        "imap": plain(port), "smtp": plain(port),
    }))
    .unwrap();
    let id = store
        .outbox_add(&account.id, &draft(), 1, 1, 0, &Default::default())
        .unwrap();
    let item = store.outbox().unwrap().remove(0);
    let mut sender = OutboxSender {
        server: plain(port),
        attempts: 0,
    };
    let progress = Progress {
        starting: &mut || {},
        aborted: &mut || {},
        words: &English,
    };

    let first = outbox::attempt(&store, &item, Some(&account), false, 10, progress, |_| &mut sender)
        .await
        .unwrap();
    assert!(matches!(first, Attempt::Held(Hold::PossiblySent)), "{first:?}");
    let row = store.outbox().unwrap().remove(0);
    assert_eq!(row.id, id);
    assert_eq!(row.last_error.as_deref(), Some(English.possibly_sent().as_str()));
    assert_eq!(seen.await.unwrap().last().map(String::as_str), Some("."));

    assert!(outbox::due_by_account(&store, 1000).unwrap().is_empty());
    let progress = Progress {
        starting: &mut || {},
        aborted: &mut || {},
        words: &English,
    };
    let stale = outbox::attempt(&store, &item, Some(&account), false, 1000, progress, |_| &mut sender)
        .await
        .unwrap();
    assert!(matches!(stale, Attempt::Skipped), "{stale:?}");
    assert_eq!(sender.attempts, 1);
}

#[tokio::test]
async fn login_and_send_with_domain_backslash_user() {
    let (port, handle) = fake_exchange(Script::Accept).await;
    smtp::send(&plain(port), &creds(), &smtp::build(&draft()).unwrap())
        .await
        .expect("send");
    let seen = handle.await.unwrap();
    // AUTH LOGIN carries the user name base64-encoded, backslash intact.
    use base64::Engine;
    let user = base64::engine::general_purpose::STANDARD.encode("CONTOSO\\j.doe");
    assert!(seen.iter().any(|l| l == &user), "{seen:?}");
    assert!(
        seen.iter()
            .any(|l| l.starts_with("MAIL FROM:<j.doe@example.com> SIZE=")),
        "{seen:?}"
    );
    assert!(seen.iter().any(|l| l == "RCPT TO:<it@example.com>"), "{seen:?}");
}

#[tokio::test]
async fn starttls_required_but_missing() {
    let (port, _) = fake_exchange(Script::NtlmOnly).await;
    let server = ServerConfig::new("127.0.0.1", port, Security::StartTls);
    let err = smtp::check(&server, &creds()).await.unwrap_err();
    assert!(matches!(err, depesha_core::Error::NoTls), "{err:?}");
}
