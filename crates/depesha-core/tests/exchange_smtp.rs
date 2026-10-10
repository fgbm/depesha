//! A scripted SMTP server that answers like Exchange 2019 client submission,
//! including a misconfigured client connector (587 without STARTTLS, AUTH GSSAPI NTLM only).
//! Needs no network beyond localhost; always runs.

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::domain::Addr;
use depesha_core::domain::Draft;
use depesha_core::smtp;
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
    assert_eq!(err.kind(), "auth");
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
    assert_eq!(err.kind(), "rate-limited");
    assert!(err.is_transient());
    // Worded for the user in either language, at display time.
    depesha_core::lang::pin(depesha_core::lang::Lang::Ru);
    assert!(err.to_string().contains("5 писем в минуту"), "{err}");
    depesha_core::lang::pin(depesha_core::lang::Lang::En);
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
    assert_eq!(err.kind(), "too-large", "{err}");
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
