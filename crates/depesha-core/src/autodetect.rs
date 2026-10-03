//! Finds IMAP and SMTP settings from an email address, the way Thunderbird does:
//! known providers, autoconfig XML, DNS (MX, SRV), then probing usual host names.

use std::time::Duration;

use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::account::{self, Security, ServerConfig};
use crate::tr;
use crate::{Error, imap, smtp, tls};

const STEP_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_XML: usize = 256 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub imap: Option<ServerConfig>,
    pub smtp: Option<ServerConfig>,
    /// Login to suggest: the full address or its local part.
    pub username: String,
    /// Where the settings came from, for the user.
    pub source: String,
    /// Problems found on the way, e.g. a server without STARTTLS.
    pub notes: Vec<String>,
}

pub async fn detect(email: &str) -> Detection {
    let email = email.trim();
    let Some(domain) = account::domain_of(email).map(str::to_ascii_lowercase) else {
        return Detection {
            notes: vec![tr!("the address has no domain", "адрес без домена")],
            ..Default::default()
        };
    };
    let mut d = Detection {
        username: email.to_owned(),
        ..Default::default()
    };

    if let Some((imap, smtp)) = account::known_provider(&domain) {
        d.imap = Some(imap);
        d.smtp = Some(smtp);
        d.source = tr!("known provider", "известный провайдер");
        return d;
    }

    if let Some(found) = autoconfig(email, &domain).await {
        return found;
    }

    let mx = mx_hosts(&domain).await;
    if let Some(found) = by_mx(email, &mx) {
        return found;
    }

    let (srv_imap, srv_smtp) = srv(&domain).await;
    if srv_imap.is_some() {
        d.source = "DNS SRV".into();
    }
    d.imap = srv_imap;
    d.smtp = srv_smtp;

    if d.imap.is_none() || d.smtp.is_none() {
        let (imap, smtp, notes) = probe_hosts(&domain, &mx, d.imap.is_none(), d.smtp.is_none()).await;
        if d.imap.is_none() {
            d.imap = imap;
        }
        if d.smtp.is_none() {
            d.smtp = smtp;
        }
        d.notes.extend(notes);
        if d.source.is_empty() && (d.imap.is_some() || d.smtp.is_some()) {
            d.source = tr!("probing server names", "перебор адресов сервера");
        }
    }
    d
}

async fn autoconfig(email: &str, domain: &str) -> Option<Detection> {
    let urls = [
        (
            format!("autoconfig.{domain}"),
            format!("/mail/config-v1.1.xml?emailaddress={email}"),
        ),
        (
            domain.to_owned(),
            "/.well-known/autoconfig/mail/config-v1.1.xml".to_owned(),
        ),
        ("autoconfig.thunderbird.net".to_owned(), format!("/v1.1/{domain}")),
    ];
    for (host, path) in urls {
        if let Some(xml) = https_get(&host, &path).await
            && let Some(mut d) = parse_autoconfig(&xml, email)
        {
            d.source = format!("autoconfig ({host})");
            return Some(d);
        }
    }
    None
}

async fn mx_hosts(domain: &str) -> Vec<String> {
    let Ok(builder) = TokioResolver::builder_tokio() else {
        return Vec::new();
    };
    let Ok(resolver) = builder.build() else {
        return Vec::new();
    };
    let Ok(Ok(lookup)) = timeout(STEP_TIMEOUT, resolver.mx_lookup(domain)).await else {
        return Vec::new();
    };
    let mut mx: Vec<(u16, String)> = lookup
        .answers()
        .iter()
        .filter_map(|r| match &r.data {
            RData::MX(m) => Some((
                m.preference,
                m.exchange.to_ascii().trim_end_matches('.').to_ascii_lowercase(),
            )),
            _ => None,
        })
        .filter(|(_, h)| !h.is_empty())
        .collect();
    mx.sort();
    mx.into_iter().map(|(_, h)| h).collect()
}

/// Domains hosted by a known provider (Yandex 360, VK WorkMail, Google Workspace).
fn by_mx(email: &str, mx: &[String]) -> Option<Detection> {
    let host = mx.first()?;
    let provider = if host.ends_with("yandex.net") || host.ends_with("yandex.ru") {
        "yandex.ru"
    } else if host.ends_with("mail.ru") {
        "mail.ru"
    } else if host.ends_with("google.com") || host.ends_with("googlemail.com") {
        "gmail.com"
    } else if host.ends_with("protection.outlook.com") {
        return Some(Detection {
            username: email.to_owned(),
            source: "MX: Microsoft 365".into(),
            notes: vec![tr!(
                "Microsoft 365 requires OAuth2 sign-in, which this version does not support",
                "Microsoft 365 требует вход через OAuth2, в этой версии он не поддерживается"
            )],
            ..Default::default()
        });
    } else {
        return None;
    };
    let (imap, smtp) = account::known_provider(provider)?;
    Some(Detection {
        imap: Some(imap),
        smtp: Some(smtp),
        username: email.to_owned(),
        source: format!("MX: {host}"),
        notes: Vec::new(),
    })
}

async fn srv(domain: &str) -> (Option<ServerConfig>, Option<ServerConfig>) {
    let Ok(builder) = TokioResolver::builder_tokio() else {
        return (None, None);
    };
    let Ok(resolver) = builder.build() else {
        return (None, None);
    };
    let lookup = |name: String, security: Security| {
        let resolver = &resolver;
        async move {
            let res = timeout(STEP_TIMEOUT, resolver.srv_lookup(name)).await.ok()?.ok()?;
            let mut records: Vec<(u16, String, u16)> = res
                .answers()
                .iter()
                .filter_map(|r| match &r.data {
                    RData::SRV(s) => Some((s.priority, s.target.to_ascii().trim_end_matches('.').to_owned(), s.port)),
                    _ => None,
                })
                .filter(|(_, target, port)| !target.is_empty() && *port != 0)
                .collect();
            records.sort();
            records
                .into_iter()
                .next()
                .map(|(_, host, port)| ServerConfig::new(host, port, security))
        }
    };
    let imap = match lookup(format!("_imaps._tcp.{domain}."), Security::Tls).await {
        Some(s) => Some(s),
        None => lookup(format!("_imap._tcp.{domain}."), Security::StartTls).await,
    };
    let smtp = match lookup(format!("_submissions._tcp.{domain}."), Security::Tls).await {
        Some(s) => Some(s),
        None => lookup(format!("_submission._tcp.{domain}."), Security::StartTls).await,
    };
    (imap, smtp)
}

/// Tries `mail.`, `imap.`/`smtp.` and the bare domain on standard ports in parallel.
async fn probe_hosts(
    domain: &str,
    mx: &[String],
    want_imap: bool,
    want_smtp: bool,
) -> (Option<ServerConfig>, Option<ServerConfig>, Vec<String>) {
    let hosts = |service: &str| {
        let mut hosts = vec![
            format!("mail.{domain}"),
            format!("{service}.{domain}"),
            domain.to_owned(),
        ];
        // Small companies often read mail on the same host that receives it.
        hosts.extend(mx.iter().take(2).filter(|h| h.ends_with(domain)).cloned());
        hosts.dedup();
        hosts
    };
    let imap_candidates: Vec<ServerConfig> = if want_imap {
        hosts("imap")
            .into_iter()
            .flat_map(|h| {
                [
                    ServerConfig::new(h.clone(), 993, Security::Tls),
                    ServerConfig::new(h, 143, Security::StartTls),
                ]
            })
            .collect()
    } else {
        Vec::new()
    };
    let smtp_candidates: Vec<ServerConfig> = if want_smtp {
        hosts("smtp")
            .into_iter()
            .flat_map(|h| {
                [
                    ServerConfig::new(h.clone(), 587, Security::StartTls),
                    ServerConfig::new(h, 465, Security::Tls),
                ]
            })
            .collect()
    } else {
        Vec::new()
    };

    let imap_results = futures::future::join_all(
        imap_candidates
            .iter()
            .map(|s| async move { timeout(STEP_TIMEOUT, imap::probe(s)).await }),
    );
    let smtp_results = futures::future::join_all(
        smtp_candidates
            .iter()
            .map(|s| async move { timeout(STEP_TIMEOUT, smtp::probe(s)).await.map(|r| r.map(|_| ())) }),
    );
    let (imap_results, smtp_results) = tokio::join!(imap_results, smtp_results);

    let mut notes = Vec::new();
    let pick = |candidates: &[ServerConfig],
                results: Vec<Result<crate::Result<()>, tokio::time::error::Elapsed>>,
                notes: &mut Vec<String>| {
        let mut chosen = None;
        for (server, result) in candidates.iter().zip(results) {
            match result {
                Ok(Ok(())) => {
                    if chosen.is_none() {
                        chosen = Some(server.clone());
                    }
                }
                // The server is there; the certificate question comes up when checking the login.
                Ok(Err(Error::Certificate(p))) => {
                    notes.push(format!("{}:{} — {}", server.host, server.port, p.reason));
                    if chosen.is_none() {
                        chosen = Some(server.clone());
                    }
                }
                Ok(Err(e @ Error::NoTls)) => notes.push(format!("{}:{} — {e}", server.host, server.port)),
                _ => {}
            }
        }
        chosen
    };
    let imap = pick(&imap_candidates, imap_results, &mut notes);
    let smtp = pick(&smtp_candidates, smtp_results, &mut notes);
    (imap, smtp, notes)
}

/// Minimal HTTPS GET over our own TLS stack (HTTP/1.0, so no chunked bodies).
async fn https_get(host: &str, path: &str) -> Option<String> {
    let fut = async {
        let tcp = TcpStream::connect((host, 443)).await.ok()?;
        let mut stream = tls::wrap(host, None, tcp).await.ok()?;
        let request =
            format!("GET {path} HTTP/1.0\r\nHost: {host}\r\nUser-Agent: Depesha\r\nAccept: application/xml\r\n\r\n");
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut body = Vec::new();
        stream.take(MAX_XML as u64).read_to_end(&mut body).await.ok()?;
        let text = String::from_utf8_lossy(&body).into_owned();
        let (head, body) = text.split_once("\r\n\r\n")?;
        let status = head.split_whitespace().nth(1)?;
        (status == "200").then(|| body.to_owned())
    };
    timeout(STEP_TIMEOUT, fut).await.ok().flatten()
}

/// Parses Mozilla autoconfig XML (config-v1.1). Only the parts we use.
pub fn parse_autoconfig(xml: &str, email: &str) -> Option<Detection> {
    let local = email.split('@').next().unwrap_or(email);
    let server = |kind: &str, protocol: &str| -> Option<(ServerConfig, String)> {
        let open = format!("<{kind}");
        let close = format!("</{kind}>");
        let mut rest = xml;
        while let Some(start) = rest.find(&open) {
            let block_end = rest[start..].find(&close)? + start;
            let block = &rest[start..block_end];
            rest = &rest[block_end + close.len()..];
            let tag_end = block.find('>')?;
            if !block[..tag_end].contains(&format!("type=\"{protocol}\"")) {
                continue;
            }
            let field = |name: &str| -> Option<String> {
                let s = block.find(&format!("<{name}>"))? + name.len() + 2;
                let e = block[s..].find(&format!("</{name}>"))? + s;
                Some(block[s..e].trim().to_owned())
            };
            let host = field("hostname")?.replace("%EMAILDOMAIN%", account::domain_of(email).unwrap_or_default());
            let port: u16 = field("port")?.parse().ok()?;
            let security = match field("socketType").unwrap_or_default().to_ascii_uppercase().as_str() {
                "SSL" => Security::Tls,
                "STARTTLS" => Security::StartTls,
                _ => continue, // never suggest plaintext
            };
            let username = match field("username").as_deref() {
                Some("%EMAILLOCALPART%") => local.to_owned(),
                _ => email.to_owned(),
            };
            return Some((ServerConfig::new(host, port, security), username));
        }
        None
    };
    let (imap, username) = server("incomingServer", "imap")?;
    let smtp = server("outgoingServer", "smtp").map(|(s, _)| s);
    Some(Detection {
        imap: Some(imap),
        smtp,
        username,
        source: String::new(),
        notes: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_autoconfig_and_skips_plaintext() {
        let xml = r#"<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="example.org">
  <incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
  <incomingServer type="imap"><hostname>plain.example.org</hostname><port>143</port><socketType>plain</socketType></incomingServer>
  <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType>
    <username>%EMAILLOCALPART%</username></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
</emailProvider></clientConfig>"#;
        let d = parse_autoconfig(xml, "ivan@example.org").unwrap();
        assert_eq!(d.imap, Some(ServerConfig::new("imap.example.org", 993, Security::Tls)));
        assert_eq!(
            d.smtp,
            Some(ServerConfig::new("smtp.example.org", 587, Security::StartTls))
        );
        assert_eq!(d.username, "ivan");
    }

    #[tokio::test]
    async fn known_provider_needs_no_network() {
        crate::lang::pin(crate::lang::Lang::Ru);
        let d = detect("someone@yandex.ru").await;
        assert_eq!(d.imap.unwrap().host, "imap.yandex.ru");
        assert_eq!(d.source, "известный провайдер");
        crate::lang::pin(crate::lang::Lang::En);
        assert_eq!(detect("someone@yandex.ru").await.source, "known provider");
    }
}
