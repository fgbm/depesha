//! Finds IMAP and SMTP settings from an email address, the way Thunderbird does:
//! known providers, autoconfig XML, DNS (MX, SRV), then probing usual host names.

use std::net::IpAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::account::{self, Security, ServerConfig};
use crate::{Error, imap, smtp, tls};

const STEP_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_XML: usize = 256 * 1024;

/// Where the settings came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
pub enum Source {
    #[error("known provider")]
    KnownProvider,
    #[error("DNS SRV")]
    DnsSrv,
    #[error("probing server names")]
    ProbingNames,
    #[error("autoconfig ({0})")]
    Autoconfig(String),
    #[error("MX: {0}")]
    Mx(String),
    #[error("MX: Microsoft 365")]
    MxMicrosoft365,
    #[error("Autodiscover ({0})")]
    Autodiscover(String),
    #[error("the address you entered")]
    EnteredAddress,
}

/// A problem found on the way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
pub enum Note {
    #[error("the address has no domain")]
    NoDomain,
    #[error("Microsoft 365 accepts only sign-in through the browser: go back and use «Sign in with Microsoft»")]
    Microsoft365BrowserOnly,
    #[error("{0} from autoconfig does not exist")]
    AutoconfigHostMissing(String),
    /// The certificate of `server` (a host, or host:port) is not trusted.
    #[error("{server} — {}", .problem.reason)]
    Untrusted {
        server: String,
        problem: Box<crate::tls::CertProblem>,
    },
    #[error("{server} — the server does not support encryption (STARTTLS); the password was not sent")]
    NoTls { server: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub imap: Option<ServerConfig>,
    pub smtp: Option<ServerConfig>,
    /// Login to suggest: the full address or its local part.
    pub username: String,
    /// Where the settings came from, for the user.
    pub source: Option<Source>,
    /// Problems found on the way, e.g. a server without STARTTLS.
    pub notes: Vec<Note>,
}

pub async fn detect(email: &str) -> Detection {
    let email = email.trim();
    let Some(domain) = account::domain_of(email).map(str::to_ascii_lowercase) else {
        return Detection {
            notes: vec![Note::NoDomain],
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
        d.source = Some(Source::KnownProvider);
        return d;
    }

    if let Some(found) = autoconfig(email, &domain).await {
        if found.smtp.is_some() {
            return found;
        }
        // No usable outgoing server in it: keep the incoming one and look for the rest below.
        d = found;
    }

    let mx = mx_hosts(&domain).await;
    if d.imap.is_none()
        && let Some(found) = by_mx(email, &mx)
    {
        return found;
    }

    let (srv_imap, srv_smtp) = srv(&domain).await;
    if d.source.is_none() && srv_imap.is_some() {
        d.source = Some(Source::DnsSrv);
    }
    if d.imap.is_none() {
        d.imap = srv_imap;
    }
    if d.smtp.is_none() {
        d.smtp = srv_smtp;
    }

    if d.imap.is_none() || d.smtp.is_none() {
        let (imap, smtp, notes) = probe_hosts(&domain, &mx, d.imap.as_ref(), d.smtp.is_none()).await;
        if d.imap.is_none() {
            d.imap = imap;
        }
        if d.smtp.is_none() {
            d.smtp = smtp;
        }
        d.notes.extend(notes);
        if d.source.is_none() && (d.imap.is_some() || d.smtp.is_some()) {
            d.source = Some(Source::ProbingNames);
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
    let resolver = resolver();
    for (host, path) in urls {
        if let Some(xml) = https_get(&host, &path).await
            && let Some(mut d) = parse_autoconfig(&xml, email)
        {
            // Hosting panels serve templates like smtp.%EMAILDOMAIN% whether such a host exists or not.
            if let Some(resolver) = &resolver {
                if let Some(imap) = &d.imap
                    && addresses(resolver, &imap.host).await.is_empty()
                {
                    continue;
                }
                if let Some(smtp) = &d.smtp
                    && addresses(resolver, &smtp.host).await.is_empty()
                {
                    d.notes.push(Note::AutoconfigHostMissing(smtp.host.clone()));
                    d.smtp = None;
                }
            }
            d.source = Some(Source::Autoconfig(host.to_string()));
            return Some(d);
        }
    }
    None
}

fn resolver() -> Option<TokioResolver> {
    TokioResolver::builder_tokio().ok()?.build().ok()
}

/// Sorted addresses of a host; empty when it does not resolve.
async fn addresses(resolver: &TokioResolver, host: &str) -> Vec<IpAddr> {
    let Ok(Ok(lookup)) = timeout(STEP_TIMEOUT, resolver.lookup_ip(host)).await else {
        return Vec::new();
    };
    let mut ips: Vec<IpAddr> = lookup.iter().collect();
    ips.sort();
    ips.dedup();
    ips
}

async fn mx_hosts(domain: &str) -> Vec<String> {
    let Some(resolver) = resolver() else {
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
        let (imap, smtp) = account::known_provider("outlook.com")?;
        return Some(Detection {
            imap: Some(imap),
            smtp: Some(smtp),
            username: email.to_owned(),
            source: Some(Source::MxMicrosoft365),
            notes: vec![Note::Microsoft365BrowserOnly],
        });
    } else {
        return None;
    };
    let (imap, smtp) = account::known_provider(provider)?;
    Some(Detection {
        imap: Some(imap),
        smtp: Some(smtp),
        username: email.to_owned(),
        source: Some(Source::Mx(host.to_string())),
        notes: Vec::new(),
    })
}

async fn srv(domain: &str) -> (Option<ServerConfig>, Option<ServerConfig>) {
    let Some(resolver) = resolver() else {
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

/// Tries `mail.`, `imap.`/`smtp.`, the bare domain and the MX hosts on standard ports in parallel.
/// `known_imap` is an incoming server found earlier: it is not probed again, and the outgoing
/// server is looked for on the same host first.
async fn probe_hosts(
    domain: &str,
    mx: &[String],
    known_imap: Option<&ServerConfig>,
    want_smtp: bool,
) -> (Option<ServerConfig>, Option<ServerConfig>, Vec<Note>) {
    let guessed = real_guesses(domain, &["mail", "imap", "smtp"]).await;
    let hosts = |service: &str| {
        let mut hosts: Vec<String> = [format!("mail.{domain}"), format!("{service}.{domain}")]
            .into_iter()
            .filter(|h| guessed.contains(h))
            .collect();
        hosts.push(domain.to_owned());
        // Small companies often read mail on the same host that receives it.
        hosts.extend(mx.iter().take(2).filter(|h| h.ends_with(domain)).cloned());
        hosts.extend(known_imap.map(|s| s.host.clone()));
        unique(hosts)
    };
    let imap_candidates: Vec<ServerConfig> = if known_imap.is_none() {
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
            .map(|s| async move { timeout(STEP_TIMEOUT, imap::probe(s)).await.ok() }),
    );
    let smtp_results = futures::future::join_all(
        smtp_candidates
            .iter()
            .map(|s| async move { timeout(STEP_TIMEOUT, smtp::probe(s)).await.ok().map(|r| r.map(|_| ())) }),
    );
    let (imap_results, smtp_results) = tokio::join!(imap_results, smtp_results);

    let mut notes = Vec::new();
    let imap = pick(&imap_candidates, imap_results, None, &mut notes);
    // Mail is usually sent through the same server it is read from.
    let same_host = imap.as_ref().or(known_imap).map(|s| s.host.clone());
    let smtp = pick(&smtp_candidates, smtp_results, same_host.as_deref(), &mut notes);
    (imap, smtp, notes)
}

/// Which of `prefix.domain` really exist. With a wildcard record every such name resolves,
/// usually to the web hosting rather than the mail server; those that resolve exactly like
/// a made-up name are dropped.
async fn real_guesses(domain: &str, prefixes: &[&str]) -> Vec<String> {
    let names: Vec<String> = prefixes.iter().map(|p| format!("{p}.{domain}")).collect();
    let Some(resolver) = resolver() else {
        return names;
    };
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    let wildcard = addresses(&resolver, &format!("depesha-{nonce:x}.{domain}")).await;
    if wildcard.is_empty() {
        return names;
    }
    let found = futures::future::join_all(names.iter().map(|n| addresses(&resolver, n))).await;
    names
        .into_iter()
        .zip(found)
        .filter(|(_, ips)| *ips != wildcard)
        .map(|(n, _)| n)
        .collect()
}

fn unique(hosts: Vec<String>) -> Vec<String> {
    let mut seen = Vec::with_capacity(hosts.len());
    for h in hosts {
        if !seen.contains(&h) {
            seen.push(h);
        }
    }
    seen
}

/// The first server that answered with a valid certificate; failing that, the first one with
/// an untrusted certificate (the user decides about it when the login is checked). Within each
/// group a server on `prefer` goes first. `None` in `results` is a timeout.
fn pick(
    candidates: &[ServerConfig],
    results: Vec<Option<crate::Result<()>>>,
    prefer: Option<&str>,
    notes: &mut Vec<Note>,
) -> Option<ServerConfig> {
    let mut valid = Vec::new();
    let mut untrusted = Vec::new();
    for (server, result) in candidates.iter().zip(results) {
        match result {
            Some(Ok(())) => valid.push(server),
            Some(Err(Error::Certificate(p))) => {
                notes.push(Note::Untrusted {
                    server: format!("{}:{}", server.host, server.port),
                    problem: p,
                });
                untrusted.push(server);
            }
            Some(Err(Error::NoTls)) => notes.push(Note::NoTls {
                server: format!("{}:{}", server.host, server.port),
            }),
            _ => {}
        }
    }
    let first = |group: &[&ServerConfig]| {
        group
            .iter()
            .find(|s| Some(s.host.as_str()) == prefer)
            .or_else(|| group.first())
            .map(|s| (*s).clone())
    };
    first(&valid).or_else(|| first(&untrusted))
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
        source: None,
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

    fn untrusted(host: &str) -> crate::Result<()> {
        Err(Error::Certificate(Box::new(crate::tls::CertProblem {
            host: host.into(),
            reason: "name mismatch".into(),
            why: crate::tls::CertWhy::WrongName,
            sha256: String::new(),
            subject: String::new(),
            issuer: String::new(),
            not_after: None,
        })))
    }

    #[test]
    fn a_valid_certificate_beats_the_candidate_order() {
        // smtp.example.org is a wildcard landing on the web hosting with somebody else's certificate.
        let candidates = [
            ServerConfig::new("smtp.example.org", 587, Security::StartTls),
            ServerConfig::new("mx.example.org", 587, Security::StartTls),
        ];
        let mut notes = Vec::new();
        let chosen = pick(
            &candidates,
            vec![Some(untrusted("smtp.example.org")), Some(Ok(()))],
            None,
            &mut notes,
        );
        assert_eq!(chosen.unwrap().host, "mx.example.org");
        assert_eq!(notes.len(), 1);

        // With nothing better, an untrusted certificate still counts: the user decides later.
        let chosen = pick(
            &candidates,
            vec![Some(untrusted("smtp.example.org")), None],
            None,
            &mut notes,
        );
        assert_eq!(chosen.unwrap().host, "smtp.example.org");
    }

    #[test]
    fn outgoing_prefers_the_incoming_host() {
        let candidates = [
            ServerConfig::new("mail.example.org", 587, Security::StartTls),
            ServerConfig::new("mx.example.org", 587, Security::StartTls),
            ServerConfig::new("mx.example.org", 465, Security::Tls),
        ];
        let results = || vec![Some(Ok(())), Some(Ok(())), Some(Ok(()))];
        let mut notes = Vec::new();
        let chosen = pick(&candidates, results(), Some("mx.example.org"), &mut notes).unwrap();
        assert_eq!((chosen.host.as_str(), chosen.port), ("mx.example.org", 587));
        assert_eq!(
            pick(&candidates, results(), None, &mut notes).unwrap().host,
            "mail.example.org"
        );
        // A preferred host with a bad certificate does not beat a valid one elsewhere.
        let mixed = vec![Some(Ok(())), Some(untrusted("mx.example.org")), None];
        assert_eq!(
            pick(&candidates, mixed, Some("mx.example.org"), &mut notes)
                .unwrap()
                .host,
            "mail.example.org"
        );
    }

    #[test]
    fn unique_keeps_the_first_occurrence() {
        let hosts = ["a", "b", "a", "c", "b"].map(String::from).to_vec();
        assert_eq!(unique(hosts), ["a", "b", "c"]);
    }

    #[tokio::test]
    async fn known_provider_needs_no_network() {
        let d = detect("someone@yandex.ru").await;
        assert_eq!(d.imap.unwrap().host, "imap.yandex.ru");
        assert_eq!(d.source, Some(Source::KnownProvider));
    }
}
