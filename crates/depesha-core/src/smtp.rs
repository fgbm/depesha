//! Message building (lettre) and our own SMTP submission client: we need the
//! EHLO capabilities, certificate pinning and the exact server replies.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use lettre::Message;
use lettre::message::header::{ContentTransferEncoding, ContentType};
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufStream};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::account::{Credentials, Security, ServerConfig};
use crate::imap::Io;
use crate::message::Addr;
use crate::tr;
use crate::{Error, Result, tls};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Draft {
    pub from: Option<Addr>,
    pub to: Vec<Addr>,
    pub cc: Vec<Addr>,
    pub bcc: Vec<Addr>,
    pub subject: String,
    pub text: String,
    pub html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<OutgoingAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingAttachment {
    pub name: String,
    pub mime: String,
    #[serde(with = "serde_bytes_b64")]
    pub data: Vec<u8>,
}

/// Attachments travel to and from the GUI as base64 strings, not JSON arrays of numbers.
mod serde_bytes_b64 {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(data: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(data))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map_err(serde::de::Error::custom)
    }
}

fn mailbox(a: &Addr) -> Result<Mailbox> {
    let email = a
        .email
        .trim()
        .parse()
        .map_err(|_| Error::Compose(tr!("invalid address: {}", "неверный адрес: {}", a.email)))?;
    Ok(Mailbox::new(a.name.clone().filter(|n| !n.trim().is_empty()), email))
}

fn text_part(text: String) -> SinglePart {
    SinglePart::builder()
        .header(ContentType::TEXT_PLAIN)
        .header(ContentTransferEncoding::QuotedPrintable)
        .body(text)
}

fn html_part(html: String) -> SinglePart {
    SinglePart::builder()
        .header(ContentType::TEXT_HTML)
        .header(ContentTransferEncoding::QuotedPrintable)
        .body(html)
}

pub fn build(draft: &Draft) -> Result<Message> {
    let from = draft
        .from
        .as_ref()
        .ok_or_else(|| Error::Compose(tr!("no sender", "не указан отправитель")))?;
    if draft.to.is_empty() && draft.cc.is_empty() && draft.bcc.is_empty() {
        return Err(Error::Compose(tr!("no recipients", "нет ни одного получателя")));
    }
    let domain = from
        .email
        .rsplit_once('@')
        .map(|(_, d)| d.trim())
        .filter(|d| !d.is_empty())
        .unwrap_or("localhost");
    let message_id = format!(
        "<{}.{}@{domain}>",
        chrono::Utc::now().timestamp_millis(),
        random_token()
    );
    let mut builder = Message::builder()
        .from(mailbox(from)?)
        .subject(draft.subject.clone())
        .message_id(Some(message_id))
        .date_now();
    for a in &draft.to {
        builder = builder.to(mailbox(a)?);
    }
    for a in &draft.cc {
        builder = builder.cc(mailbox(a)?);
    }
    for a in &draft.bcc {
        builder = builder.bcc(mailbox(a)?);
    }
    if let Some(id) = &draft.in_reply_to {
        builder = builder.in_reply_to(angle(id));
    }
    if !draft.references.is_empty() {
        builder = builder.references(draft.references.iter().map(|r| angle(r)).collect::<Vec<_>>().join(" "));
    }

    let body = |text: String| match &draft.html {
        Some(html) => MultiPart::alternative()
            .singlepart(text_part(text))
            .singlepart(html_part(html.clone())),
        None => MultiPart::mixed().singlepart(text_part(text)),
    };
    let message = match (&draft.html, draft.attachments.is_empty()) {
        (None, true) => builder.singlepart(text_part(draft.text.clone())),
        (Some(_), true) => builder.multipart(body(draft.text.clone())),
        (html, false) => {
            let mut mixed = match html {
                Some(_) => MultiPart::mixed().multipart(body(draft.text.clone())),
                None => MultiPart::mixed().singlepart(text_part(draft.text.clone())),
            };
            for a in &draft.attachments {
                let ct = ContentType::parse(&a.mime)
                    .unwrap_or_else(|_| ContentType::parse("application/octet-stream").expect("valid mime"));
                mixed = mixed.singlepart(Attachment::new(a.name.clone()).body(a.data.clone(), ct));
            }
            builder.multipart(mixed)
        }
    };
    message.map_err(|e| Error::Compose(e.to_string()))
}

fn random_token() -> String {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut bytes = [0u8; 12];
    SystemRandom::new().fill(&mut bytes).expect("system RNG");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn angle(id: &str) -> String {
    let id = id.trim();
    if id.starts_with('<') {
        id.to_owned()
    } else {
        format!("<{id}>")
    }
}

/// What the server announced in EHLO, after STARTTLS when it was used.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SmtpCaps {
    pub starttls: bool,
    pub auth: Vec<String>,
    pub size: Option<u64>,
}

#[derive(Debug)]
struct Reply {
    code: u16,
    lines: Vec<String>,
}

impl Reply {
    fn text(&self) -> String {
        self.lines.join(" ")
    }

    fn into_error(self) -> Error {
        let text = self.text();
        let enhanced = text
            .split_whitespace()
            .next()
            .filter(|t| t.len() >= 5 && t.split('.').count() == 3 && t.split('.').all(|p| p.parse::<u16>().is_ok()))
            .map(str::to_owned);
        Error::Smtp {
            code: self.code,
            enhanced,
            message: text,
        }
    }
}

struct Conn {
    stream: BufStream<Box<dyn Io>>,
}

impl Conn {
    async fn reply(&mut self) -> Result<Reply> {
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            let n = timeout(REPLY_TIMEOUT, self.stream.read_line(&mut line))
                .await
                .map_err(|_| Error::Timeout("SMTP answer"))??;
            if n == 0 {
                return Err(Error::Closed);
            }
            let line = line.trim_end_matches(['\r', '\n']);
            let code = line
                .get(..3)
                .and_then(|c| c.parse::<u16>().ok())
                .ok_or_else(|| Error::Protocol(line.into()))?;
            let more = line.as_bytes().get(3) == Some(&b'-');
            lines.push(line.get(4..).unwrap_or_default().to_owned());
            if !more {
                return Ok(Reply { code, lines });
            }
        }
    }

    async fn command(&mut self, line: &str) -> Result<Reply> {
        self.stream.write_all(line.as_bytes()).await?;
        self.stream.write_all(b"\r\n").await?;
        self.stream.flush().await?;
        self.reply().await
    }

    async fn expect(&mut self, line: &str, ok: &[u16]) -> Result<Reply> {
        let reply = self.command(line).await?;
        if ok.contains(&reply.code) {
            Ok(reply)
        } else {
            Err(reply.into_error())
        }
    }

    async fn ehlo(&mut self) -> Result<SmtpCaps> {
        let reply = self.expect(&format!("EHLO {}", local_name()), &[250]).await?;
        let mut caps = SmtpCaps::default();
        for line in reply.lines.iter().skip(1) {
            let mut words = line.split_whitespace();
            match words.next().map(str::to_ascii_uppercase).as_deref() {
                Some("STARTTLS") => caps.starttls = true,
                Some("AUTH") => caps.auth.extend(words.map(str::to_ascii_uppercase)),
                Some("SIZE") => caps.size = words.next().and_then(|s| s.parse().ok()).filter(|s| *s > 0),
                _ => {}
            }
        }
        caps.auth.dedup();
        Ok(caps)
    }
}

fn local_name() -> String {
    // The name is checked by nobody, but a non-ASCII hostname breaks EHLO on some servers.
    hostname()
        .filter(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'))
        .unwrap_or_else(|| "localhost".into())
}

fn hostname() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_owned())
}

/// Connects, upgrades to TLS as configured and logs in when credentials are given.
async fn open(server: &ServerConfig, creds: Option<&Credentials>) -> Result<(Conn, SmtpCaps)> {
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect((server.host.as_str(), server.port)))
        .await
        .map_err(|_| Error::Timeout("connecting"))??;
    let pinned = server.trusted_cert.as_deref();
    let stream: Box<dyn Io> = match server.security {
        Security::Tls => Box::new(tls::wrap(&server.host, pinned, tcp).await?),
        Security::StartTls | Security::Plain => Box::new(tcp),
    };
    let mut conn = Conn {
        stream: BufStream::new(stream),
    };
    let greeting = timeout(CONNECT_TIMEOUT, conn.reply())
        .await
        .map_err(|_| Error::Timeout("server greeting"))??;
    if greeting.code != 220 {
        return Err(greeting.into_error());
    }
    let mut caps = conn.ehlo().await?;

    if server.security == Security::StartTls {
        if !caps.starttls {
            return Err(Error::NoTls);
        }
        conn.expect("STARTTLS", &[220]).await?;
        let plain = conn.stream.into_inner();
        let secured: Box<dyn Io> = Box::new(tls::wrap(&server.host, pinned, plain).await?);
        conn = Conn {
            stream: BufStream::new(secured),
        };
        caps = conn.ehlo().await?;
    }

    if let Some(creds) = creds {
        login(&mut conn, &caps, creds).await?;
    }
    Ok((conn, caps))
}

async fn login(conn: &mut Conn, caps: &SmtpCaps, creds: &Credentials) -> Result<()> {
    let has = |m: &str| caps.auth.iter().any(|a| a == m);
    let auth_err = |reply: Reply| match reply.code {
        535 | 534 | 530 => Error::Auth(reply.text()),
        _ => reply.into_error(),
    };
    // Gmail, Yandex and Microsoft all take XOAUTH2; try it even when EHLO forgets to list it.
    if let Some(initial) = creds.xoauth2() {
        let reply = conn.command(&format!("AUTH XOAUTH2 {}", BASE64.encode(initial))).await?;
        return match reply.code {
            235 => Ok(()),
            // The error comes as a base64 JSON challenge; an empty answer ends the exchange.
            334 => {
                let detail = BASE64
                    .decode(reply.text().trim())
                    .ok()
                    .and_then(|j| crate::imap::xoauth2_error(&j));
                let last = conn.command("").await?;
                let mut err = auth_err(last);
                if let (Error::Auth(m), Some(d)) = (&mut err, detail) {
                    m.push_str(&format!(" ({d})"));
                }
                Err(err)
            }
            _ => Err(auth_err(reply)),
        };
    }
    if has("PLAIN") {
        let token = BASE64.encode(format!("\0{}\0{}", creds.username, creds.password()));
        let reply = conn.command(&format!("AUTH PLAIN {token}")).await?;
        return if reply.code == 235 {
            Ok(())
        } else {
            Err(auth_err(reply))
        };
    }
    if has("LOGIN") {
        let steps = [
            "AUTH LOGIN".to_owned(),
            BASE64.encode(&creds.username),
            BASE64.encode(creds.password()),
        ];
        for (i, step) in steps.iter().enumerate() {
            let reply = conn.command(step).await?;
            let expected = if i < 2 { 334 } else { 235 };
            if reply.code != expected {
                return Err(auth_err(reply));
            }
        }
        return Ok(());
    }
    if caps.auth.is_empty() {
        Err(Error::AuthMechanism(tr!("nothing", "ничего")))
    } else {
        Err(Error::AuthMechanism(caps.auth.join(" ")))
    }
}

/// Checks that an SMTP server answers with the configured security, without logging in.
pub async fn probe(server: &ServerConfig) -> Result<SmtpCaps> {
    let (mut conn, caps) = open(server, None).await?;
    let _ = conn.command("QUIT").await;
    Ok(caps)
}

/// Checks connection, TLS and login without sending anything.
pub async fn check(server: &ServerConfig, creds: &Credentials) -> Result<SmtpCaps> {
    let (mut conn, caps) = open(server, Some(creds)).await?;
    let _ = conn.command("QUIT").await;
    Ok(caps)
}

/// Sends the message and returns its RFC 822 bytes for the Sent folder.
pub async fn send(server: &ServerConfig, creds: &Credentials, message: &Message) -> Result<Vec<u8>> {
    let envelope = message.envelope();
    let from = envelope.from().map(|a| a.to_string()).unwrap_or_default();
    let raw = message.formatted();

    let (mut conn, caps) = open(server, Some(creds)).await?;
    if let Some(limit) = caps.size
        && raw.len() as u64 > limit
    {
        return Err(Error::TooLarge { size: raw.len(), limit });
    }
    let size = if caps.size.is_some() {
        format!(" SIZE={}", raw.len())
    } else {
        String::new()
    };
    conn.expect(&format!("MAIL FROM:<{from}>{size}"), &[250]).await?;
    for rcpt in envelope.to() {
        conn.expect(&format!("RCPT TO:<{rcpt}>"), &[250, 251]).await?;
    }
    conn.expect("DATA", &[354]).await?;
    conn.stream.write_all(&dot_stuff(&raw)).await?;
    conn.stream.flush().await?;
    let reply = conn.reply().await?;
    if reply.code != 250 {
        return Err(reply.into_error());
    }
    let _ = conn.command("QUIT").await;
    Ok(raw)
}

/// Escapes leading dots and appends the end-of-data marker (RFC 5321, 4.5.2).
fn dot_stuff(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 64);
    let mut line_start = true;
    for &b in raw {
        if line_start && b == b'.' {
            out.push(b'.');
        }
        out.push(b);
        line_start = b == b'\n';
    }
    if !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b".\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(email: &str) -> Addr {
        Addr {
            name: None,
            email: email.into(),
        }
    }

    #[test]
    fn builds_reply_with_attachment() {
        let draft = Draft {
            from: Some(Addr {
                name: Some("Влад".into()),
                email: "me@example.org".into(),
            }),
            to: vec![addr("you@example.org")],
            bcc: vec![addr("hidden@example.org")],
            subject: "Re: Привет".into(),
            text: "Текст".into(),
            in_reply_to: Some("m1@example.org".into()),
            references: vec!["m0@example.org".into(), "<m1@example.org>".into()],
            attachments: vec![OutgoingAttachment {
                name: "a.txt".into(),
                mime: "text/plain".into(),
                data: b"hi".to_vec(),
            }],
            ..Default::default()
        };
        let message = build(&draft).unwrap();
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("In-Reply-To: <m1@example.org>"), "{raw}");
        assert!(raw.contains("References: <m0@example.org> <m1@example.org>"), "{raw}");
        assert!(raw.contains("filename=\"a.txt\""), "{raw}");
        assert!(raw.contains("Message-ID: <"), "{raw}");
        assert!(raw.contains("Date: "), "{raw}");
        assert!(!raw.contains("hidden@example.org"), "Bcc leaked into headers: {raw}");
        assert!(raw.is_ascii(), "body must be 7-bit for servers without 8BITMIME");
        let rcpts: Vec<String> = message.envelope().to().iter().map(|a| a.to_string()).collect();
        assert!(rcpts.contains(&"hidden@example.org".to_owned()));

        let parsed = crate::message::parse_view(raw.as_bytes(), false).unwrap();
        assert_eq!(parsed.summary.subject, "Re: Привет");
        assert_eq!(parsed.text.as_deref().map(str::trim), Some("Текст"));
    }

    #[test]
    fn rejects_empty_recipients() {
        let draft = Draft {
            from: Some(addr("me@example.org")),
            ..Default::default()
        };
        assert!(matches!(build(&draft), Err(Error::Compose(_))));
    }

    #[test]
    fn stuffs_dots() {
        assert_eq!(dot_stuff(b".a\r\nb\r\n.\r\n"), b"..a\r\nb\r\n..\r\n.\r\n");
        assert_eq!(dot_stuff(b"x"), b"x\r\n.\r\n");
    }

    #[test]
    fn explains_exchange_codes() {
        let e = Reply {
            code: 421,
            lines: vec!["4.4.2 Message submission rate for this client has exceeded".into()],
        }
        .into_error();
        assert_eq!(e.kind(), "rate-limited");
        assert!(e.is_transient());
        let e = Reply {
            code: 550,
            lines: vec!["5.7.60 SMTP; Client does not have permissions to send as this sender".into()],
        }
        .into_error();
        assert!(e.to_string().contains("Send As"), "{e}");
        assert!(!e.is_transient());
    }
}
