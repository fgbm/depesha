//! Pictures for senders: brand logos published with BIMI (RFC draft
//! `draft-brand-indicators-for-message-identification`). Exchange's photos of
//! colleagues come from the mailbox's own server (`ews::user_photo`).

use std::time::Duration;

use base64::Engine;
use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use tokio::time::timeout;

use crate::account::Account;

/// A BIMI logo is SVG Tiny PS of at most 32 KB.
pub const MAX_LOGO: usize = 32 * 1024;
const STEP: Duration = Duration::from_secs(5);

/// The domain whose logo stands by this address: the registrable (organizational) domain by
/// the Public Suffix List built into the program, never a subdomain (#108). A subdomain is
/// free to mint (`news@r123.evil.example`): asking about it would tell its owner that the
/// letter was read, and a logo of a subdomain is the organization's logo anyway. `None` when
/// the domain is a public suffix itself or stands under a private one (`x.github.io`,
/// `paypal.us.com`, `eu.org`): everyone rents a name there, and a logo would prove nothing.
/// Internationalized names go as punycode in lower case.
pub fn logo_domain(email: &str) -> Option<String> {
    let (_, domain) = email.trim().rsplit_once('@')?;
    let host = idna::domain_to_ascii(domain.trim().trim_end_matches('.'))
        .ok()?
        .to_ascii_lowercase();
    registrable(&host)
}

/// The registrable domain of an ASCII lower-case host by the public suffix list, `None` for a
/// public suffix itself and for a name under a private one (`x.github.io`, `eu.org`).
fn registrable(host: &str) -> Option<String> {
    let registrable = psl::domain(host.as_bytes())?;
    // A top-level name the list does not know (`.example`) is a suffix of the default rule.
    if registrable.suffix().typ() == Some(psl_types::Type::Private) {
        return None;
    }
    String::from_utf8(registrable.as_bytes().to_vec()).ok()
}

/// Regional second-level zones the list may not know (`nsk.ru`): a name directly under one is
/// the zone's, so the organization is one label more. The generic ones are those of [`org_domain`].
const ZONES: [&str; 22] = [
    "co",
    "com",
    "net",
    "org",
    "gov",
    "edu",
    "ac",
    "pp",
    "or",
    "ne",
    "msk",
    "spb",
    "nsk",
    "ekb",
    "nnov",
    "kzn",
    "samara",
    "omsk",
    "chel",
    "vrn",
    "krasnodar",
    "kuban",
];

/// The domain the owner of a server holds, for judging whose `authserv-id` a header carries:
/// the registrable domain of the list, private suffixes included (`firm.msk.ru` is a firm's),
/// one label more under a regional zone the list lacks (`evil.nsk.ru`, not `nsk.ru`).
fn own_domain(host: &str) -> Option<String> {
    let registrable = psl::domain(host.as_bytes())?;
    let name = std::str::from_utf8(registrable.as_bytes()).ok()?;
    let labels: Vec<&str> = name.split('.').collect();
    let zone = matches!(labels.as_slice(), [zone, tld] if tld.len() == 2 && ZONES.contains(zone));
    if !zone {
        return Some(name.to_owned());
    }
    let host_labels: Vec<&str> = host.split('.').collect();
    let keep = (labels.len() + 1).min(host_labels.len());
    Some(host_labels[host_labels.len() - keep..].join("."))
}

/// The logo of an organizational domain as a `data:` URI, or `None` when it publishes none
/// or does not enforce DMARC (a logo then proves nothing). Only `domain` itself is asked
/// about (`_dmarc.`, `default._bimi.`): see [`logo_domain`]. The message itself must have
/// passed DMARC: see [`dmarc_passed`].
pub async fn bimi_logo(domain: &str) -> Option<String> {
    let resolver = TokioResolver::builder_tokio().ok()?.build().ok()?;
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    let dmarc = txt(&resolver, &format!("_dmarc.{domain}")).await?;
    if !dmarc_enforced(&dmarc, false) {
        return None;
    }
    let record = txt(&resolver, &format!("default._bimi.{domain}")).await?;
    fetch_logo(&bimi_location(&record)?).await.ok().flatten()
}

/// Downloads the SVG a BIMI record points at. The domain's owner chose the address:
/// only the public internet, as for one-click unsubscribe.
async fn fetch_logo(url: &str) -> crate::Result<Option<String>> {
    let resp = timeout(
        STEP * 2,
        crate::http::request_public("GET", url, &[("Accept", "image/svg+xml".into())], Vec::new()),
    )
    .await
    .map_err(|_| crate::Error::Timeout("HTTP answer"))??;
    if resp.status != 200 || resp.body.len() > MAX_LOGO || !is_svg(&resp.body) {
        return Ok(None);
    }
    Ok(Some(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&resp.body)
    )))
}

/// A picture's bytes as a `data:` URI; JPEG unless the bytes say PNG or GIF.
pub fn data_uri(bytes: &[u8]) -> String {
    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        "image/jpeg"
    };
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// The record's text, its strings joined as RFC 7208 says.
async fn txt(resolver: &TokioResolver, name: &str) -> Option<String> {
    let lookup = timeout(STEP, resolver.txt_lookup(name)).await.ok()?.ok()?;
    lookup.answers().iter().find_map(|r| match &r.data {
        RData::TXT(t) => Some(
            t.txt_data
                .iter()
                .map(|s| String::from_utf8_lossy(s).into_owned())
                .collect::<String>(),
        ),
        _ => None,
    })
}

/// The domain the registrant owns: the last two labels, three under the
/// second-level zones people actually meet (`co.uk`, `com.ru`, `msk.ru`…).
pub fn org_domain(domain: &str) -> String {
    const SECOND_LEVEL: [&str; 12] = [
        "co", "com", "net", "org", "gov", "edu", "ac", "msk", "spb", "pp", "or", "ne",
    ];
    let labels: Vec<&str> = domain.split('.').filter(|l| !l.is_empty()).collect();
    let keep = match labels.as_slice() {
        [.., second, tld] if tld.len() == 2 && SECOND_LEVEL.contains(second) => 3,
        _ => 2,
    };
    labels[labels.len().saturating_sub(keep)..].join(".")
}

/// Tags of a `k=v; k=v` record, keys lowercased.
fn tags(record: &str) -> Vec<(String, String)> {
    record
        .split(';')
        .filter_map(|t| t.split_once('='))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect()
}

/// DMARC rejects or quarantines all failing mail of the domain (BIMI requires it).
/// `sub`: the record is the organizational domain's, so `sp` decides.
pub fn dmarc_enforced(record: &str, sub: bool) -> bool {
    let tags = tags(record);
    let get = |k: &str| {
        tags.iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.to_ascii_lowercase())
    };
    if get("v").as_deref() != Some("dmarc1") {
        return false;
    }
    let policy = if sub { get("sp").or_else(|| get("p")) } else { get("p") };
    matches!(policy.as_deref(), Some("quarantine" | "reject")) && get("pct").is_none_or(|p| p == "100")
}

/// The logo URL of a BIMI record; only HTTPS counts, and an empty `l=` declines.
pub fn bimi_location(record: &str) -> Option<String> {
    let tags = tags(record);
    let v = tags.iter().find(|(k, _)| k == "v")?;
    if !v.1.eq_ignore_ascii_case("BIMI1") {
        return None;
    }
    let l = &tags.iter().find(|(k, _)| k == "l")?.1;
    let l = l.split(',').next()?.trim();
    l.to_ascii_lowercase().starts_with("https://").then(|| l.to_owned())
}

fn is_svg(body: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&body[..body.len().min(1024)]).to_ascii_lowercase();
    head.contains("<svg")
}

/// Mail services whose servers sign `Authentication-Results` with a domain other than
/// the mailbox's (`mx.google.com` for `imap.gmail.com`).
const FAMILIES: [&[&str]; 3] = [
    &["gmail.com", "googlemail.com", "google.com"],
    &["yandex.ru", "yandex.com", "ya.ru", "yandex.net"],
    &["mail.ru", "bk.ru", "inbox.ru", "list.ru", "internet.ru"],
];

/// Who received a message: the servers whose `Authentication-Results` count.
/// Anyone can write that header into a letter (RFC 8601 §5); the receiving server
/// removes copies that claim its own name, so only its name is believed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Receiver {
    /// Organizational domains of the mailbox's server and address.
    pub domains: Vec<String>,
    /// The part of `domains` that comes from the server (and its provider's family): the only
    /// part that may be written to the log, the address domain being the operator's own.
    pub servers: Vec<String>,
    /// Exchange Online: writes its verdict without a server name, on top of the
    /// header, and renames the ones that came with the letter.
    pub exchange_online: bool,
    /// Exchange (Web Services): its own `X-MS-Exchange-Organization-*` headers are
    /// stripped from mail that comes from outside, so `AuthAs: Internal` is its word.
    pub exchange: bool,
}

impl Receiver {
    pub fn of(account: &Account) -> Self {
        let server = match &account.ews {
            Some(ews) => crate::http::Url::parse(&ews.url).map(|u| u.host).unwrap_or_default(),
            None => account.imap.host.clone(),
        };
        let address = account
            .email
            .rsplit_once('@')
            .map(|(_, d)| d.to_owned())
            .unwrap_or_default();
        let mut domains = Vec::new();
        let mut servers = Vec::new();
        for (from_server, host) in [(true, server.as_str()), (false, address.as_str())] {
            let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
            // An IP address names no organization.
            if host.is_empty() || host.parse::<std::net::IpAddr>().is_ok() || !host.contains('.') {
                continue;
            }
            let Some(org) = own_domain(&host) else {
                continue;
            };
            let family = FAMILIES.iter().find(|f| f.contains(&org.as_str()));
            for d in family.map_or_else(|| vec![org.clone()], |f| f.iter().map(|d| (*d).to_owned()).collect()) {
                if from_server && !servers.contains(&d) {
                    servers.push(d.clone());
                }
                if !domains.contains(&d) {
                    domains.push(d);
                }
            }
        }
        let exchange_online = account.is_ews()
            && ["office365.com", "outlook.com"]
                .contains(&own_domain(&server.to_ascii_lowercase()).unwrap_or_default().as_str());
        Self {
            domains,
            servers,
            exchange_online,
            exchange: account.is_ews(),
        }
    }

    fn owns(&self, authserv_id: &str) -> bool {
        let id = authserv_id.trim_end_matches('.').to_ascii_lowercase();
        id.contains('.') && own_domain(&id).is_some_and(|d| self.domains.contains(&d))
    }
}

/// The DMARC verdict of one `Authentication-Results` header.
#[derive(Debug, PartialEq, Eq)]
struct Results {
    /// The server that wrote it; `None` in Exchange Online's format.
    authserv_id: Option<String>,
    /// `(result word, header.from)` of the `dmarc=` result, if there is one.
    dmarc: Option<(String, Option<String>)>,
}

fn results(value: &str) -> Results {
    let clean = without_comments(value).to_ascii_lowercase();
    let mut parts = clean.split(';').map(str::trim);
    let first = parts.next().unwrap_or_default();
    // `authserv-id [version]`, unless the header starts with a result straight away.
    let (authserv_id, first_result) = if first.contains('=') {
        (None, Some(first))
    } else {
        (first.split_whitespace().next().map(str::to_owned), None)
    };
    let dmarc = first_result.into_iter().chain(parts).find_map(|resinfo| {
        // `dmarc = pass` is allowed too: glue the `=` back to its word.
        let resinfo = resinfo
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace(" =", "=")
            .replace("= ", "=");
        let mut words = resinfo.split_whitespace();
        let result = words.next()?.strip_prefix("dmarc=")?;
        let header_from = words
            .find_map(|w| w.strip_prefix("header.from="))
            .map(|d| d.trim_matches('"').to_owned());
        Some((result.to_owned(), header_from))
    });
    Results { authserv_id, dmarc }
}

/// The header's text with `(comments)` dropped: a comment says nothing, whatever it says.
fn without_comments(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
    for c in value.chars() {
        if escaped {
            escaped = false;
            if depth == 0 {
                out.push(c);
            }
            continue;
        }
        match c {
            '\\' if quoted || depth > 0 => {
                escaped = true;
                if depth == 0 {
                    out.push(c);
                }
            }
            '"' if depth == 0 => {
                quoted = !quoted;
                out.push(c);
            }
            '(' if !quoted => depth += 1,
            ')' if !quoted && depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    out.push(' ');
                }
            }
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// Why a sender is or is not believed: the answer of [`check_sender`]. It holds domains and
/// result words only, never an address, a subject or a token, so it may go to the log. What the
/// letter itself wrote (`seen`) is cut to a few short `[a-z0-9.-]` names first; the mailbox's own
/// address domain is not in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SenderCheck {
    /// The server of the mailbox wrote no `Authentication-Results`; `seen` are the
    /// `authserv-id`s the letter did carry (`-` for a header without one).
    NoOwnHeader {
        seen: Vec<String>,
        receiver: Vec<String>,
    },
    /// The topmost header of ours has no `dmarc=` result.
    NoDmarc,
    /// The result word was not `pass`.
    DmarcNot(String),
    /// `dmarc=pass`, but about another organization than the From domain.
    NotAligned {
        header_from_domain: Option<String>,
        from_domain: String,
    },
    Passed,
}

impl std::fmt::Display for SenderCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoOwnHeader { seen, receiver } => write!(
                f,
                "no Authentication-Results of the mailbox's server (seen authserv-id: [{}], receiver domains: [{}])",
                seen.join(", "),
                receiver.join(", ")
            ),
            Self::NoDmarc => f.write_str("the server's header has no dmarc result"),
            Self::DmarcNot(word) => write!(f, "dmarc={word}"),
            Self::NotAligned {
                header_from_domain,
                from_domain,
            } => write!(
                f,
                "dmarc=pass for {}, not aligned with From domain {from_domain}",
                header_from_domain.as_deref().unwrap_or("(no header.from)")
            ),
            Self::Passed => f.write_str("dmarc=pass, aligned"),
        }
    }
}

/// The receiving server checked DMARC and it passed for the From domain.
/// `auth_results`: every `Authentication-Results`, topmost first. Only a header
/// written by the account's own server counts (others are skipped, wherever they
/// stand); the topmost of them decides, with or without a DMARC result. The verdict must name the
/// sender's domain in `header.from`, exactly: without it, it may be about another domain.
pub fn dmarc_passed(auth_results: &[String], from_domain: &str, receiver: &Receiver) -> bool {
    check_sender(auth_results, from_domain, receiver) == SenderCheck::Passed
}

/// How many foreign `authserv-id`s a [`SenderCheck`] keeps, and how long each may be.
const MAX_SEEN: usize = 8;
const MAX_SEEN_LEN: usize = 64;

/// An `authserv-id` as the log may hold it: lowercase `[a-z0-9.-]` and short, or `?`.
fn loggable(id: Option<&str>) -> String {
    match id {
        None => "-".to_owned(),
        Some(id) if id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') => {
            id.chars().take(MAX_SEEN_LEN).collect::<String>().to_ascii_lowercase()
        }
        Some(_) => "?".to_owned(),
    }
}

/// [`dmarc_passed`] with the reason of the answer.
pub fn check_sender(auth_results: &[String], from_domain: &str, receiver: &Receiver) -> SenderCheck {
    let mut seen = Vec::new();
    for (i, header) in auth_results.iter().enumerate() {
        let r = results(header);
        let ours = match &r.authserv_id {
            Some(id) => receiver.owns(id),
            None => receiver.exchange_online && i == 0,
        };
        if !ours {
            if seen.len() < MAX_SEEN {
                seen.push(loggable(r.authserv_id.as_deref()));
            }
            continue;
        }
        // The topmost header of ours decides alone: one without a DMARC result is a «no», not
        // a reason to read on, or a forged `dmarc=pass` under it would be believed (#108).
        return match r.dmarc {
            None => SenderCheck::NoDmarc,
            Some((word, _)) if word != "pass" => SenderCheck::DmarcNot(word),
            Some((_, header_from)) if header_from.as_deref().is_some_and(|d| same_domain(d, from_domain)) => {
                SenderCheck::Passed
            }
            Some((_, header_from)) => SenderCheck::NotAligned {
                header_from_domain: header_from,
                from_domain: from_domain.to_ascii_lowercase(),
            },
        };
    }
    SenderCheck::NoOwnHeader {
        seen,
        receiver: receiver.servers.clone(),
    }
}

/// `header.from` is the From domain as it stands: the server already did the aligning
/// (RFC 7489) and wrote the domain it judged, so a subdomain or a look-alike is another
/// domain here. Case, a trailing dot and IDN spelling are not differences.
fn same_domain(header_from: &str, from_domain: &str) -> bool {
    let ascii = |d: &str| idna::domain_to_ascii(d.trim().trim_end_matches('.')).ok();
    match (ascii(header_from), ascii(from_domain)) {
        (Some(a), Some(b)) => !a.is_empty() && a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bimi_and_dmarc_records() {
        assert_eq!(
            bimi_location("v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem").as_deref(),
            Some("https://example.com/logo.svg")
        );
        assert_eq!(bimi_location("v=BIMI1; l=; a=;"), None);
        assert_eq!(bimi_location("v=BIMI1; l=http://example.com/logo.svg"), None);
        assert_eq!(bimi_location("v=spf1 -all"), None);

        assert!(dmarc_enforced("v=DMARC1; p=reject; rua=mailto:d@example.com", false));
        assert!(dmarc_enforced("v=DMARC1; p=quarantine; pct=100", false));
        assert!(!dmarc_enforced("v=DMARC1; p=none", false));
        assert!(!dmarc_enforced("v=DMARC1; p=reject; pct=50", false));
        assert!(!dmarc_enforced("v=DMARC1; p=reject; sp=none", true));
        assert!(dmarc_enforced("v=DMARC1; p=reject", true));
    }

    #[test]
    fn finds_the_organizational_domain() {
        assert_eq!(org_domain("news.ozon.ru"), "ozon.ru");
        assert_eq!(org_domain("ozon.ru"), "ozon.ru");
        assert_eq!(org_domain("mail.shop.co.uk"), "shop.co.uk");
        assert_eq!(org_domain("a.b.msk.ru"), "b.msk.ru");
    }

    fn account(email: &str, host: &str) -> Account {
        Account {
            id: "a".into(),
            label: String::new(),
            color: String::new(),
            display_name: String::new(),
            email: email.into(),
            username: email.into(),
            imap: crate::account::ServerConfig::new(host, 993, crate::account::Security::Tls),
            smtp: crate::account::ServerConfig::new(host, 465, crate::account::Security::Tls),
            save_sent_copy: true,
            signature: String::new(),
            signatures: Vec::new(),
            default_signature: None,
            reply_signature: None,
            compose_format: None,
            letter_view: None,
            attachments_dir: String::new(),
            auth: Default::default(),
            ews: None,
            quota_warn: true,
            quota_limit_mb: 0,
            waiting: Default::default(),
        }
    }

    fn imap(email: &str, host: &str) -> Receiver {
        Receiver::of(&account(email, host))
    }

    fn ews(email: &str, url: &str) -> Receiver {
        Receiver::of(&Account {
            ews: Some(crate::account::EwsConfig {
                url: url.into(),
                trusted_cert: None,
            }),
            ..account(email, "")
        })
    }

    #[test]
    fn trusts_only_a_passed_dmarc_for_the_sender() {
        let gmail_box = imap("me@gmail.com", "imap.gmail.com");
        let gmail = |v: &str| vec![v.to_owned()];
        let ar = "mx.google.com; dkim=pass header.i=@ozon.ru; spf=pass; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=ozon.ru";
        assert!(dmarc_passed(&gmail(ar), "ozon.ru", &gmail_box));
        assert!(!dmarc_passed(&gmail(ar), "ozon-shop.ru", &gmail_box));
        assert!(!dmarc_passed(
            &gmail("mx.google.com; dmarc=fail header.from=bank.ru"),
            "bank.ru",
            &gmail_box
        ));
        assert!(!dmarc_passed(&[], "bank.ru", &gmail_box));
    }

    #[test]
    fn a_box_under_a_public_suffix_trusts_only_its_own_registrable_domain() {
        let ar = |id: &str| vec![format!("{id}; dmarc=pass header.from=bank.ru")];
        let kiev = imap("me@firm.kiev.ua", "imap.firm.kiev.ua");
        assert!(dmarc_passed(&ar("mx.firm.kiev.ua"), "bank.ru", &kiev));
        assert!(!dmarc_passed(&ar("mx.evil.kiev.ua"), "bank.ru", &kiev));
        let nsk = imap("me@firm.nsk.ru", "imap.firm.nsk.ru");
        assert!(dmarc_passed(&ar("mx.firm.nsk.ru"), "bank.ru", &nsk));
        assert!(!dmarc_passed(&ar("mx.evil.nsk.ru"), "bank.ru", &nsk));
        // Zones the list holds as private are no reason to leave a box without a receiver.
        for zone in ["msk.ru", "spb.ru", "com.ru", "net.ru", "org.ru", "pp.ru"] {
            let firm = imap(&format!("me@firm.{zone}"), &format!("imap.firm.{zone}"));
            assert!(
                dmarc_passed(&ar(&format!("mx.firm.{zone}")), "bank.ru", &firm),
                "{zone}"
            );
            assert!(
                !dmarc_passed(&ar(&format!("mx.evil.{zone}")), "bank.ru", &firm),
                "{zone}"
            );
        }
        // A box under a private suffix believes its own name only.
        let pages = imap("me@x.github.io", "imap.x.github.io");
        assert!(!dmarc_passed(&ar("mx.y.github.io"), "bank.ru", &pages));
        let gmail = imap("me@gmail.com", "imap.gmail.com");
        assert!(dmarc_passed(&ar("mx.google.com"), "bank.ru", &gmail));
    }

    fn letter(auth: &str, from: &str) -> Vec<u8> {
        format!("Received: by mx with SMTP;\r\n{auth}From: GitHub <{from}>\r\nTo: me@x.example\r\nSubject: Hi\r\n\r\nText\r\n")
            .into_bytes()
    }

    #[test]
    fn real_headers_of_each_provider_are_believed() {
        let gmail = "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@github.com header.s=pf2023 header.b=DDDD;\r\n       spf=pass (google.com: domain of noreply@github.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=noreply@github.com;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=github.com\r\n";
        let yandex = "Authentication-Results: mail-nwsmtp-mxfront-production-main-7.vla.yp-c.yandex.net; spf=pass (mail-nwsmtp-mxfront-production-main-7.vla.yp-c.yandex.net: domain of github.com designates 192.0.2.1 as permitted sender, rule=[ip4:192.0.2.0/24]) smtp.mailfrom=noreply@github.com; dkim=pass header.i=@github.com; dmarc=pass header.from=github.com\r\n";
        let mailru = "Authentication-Results: mxs.mail.ru; spf=pass (mx274.m.smailru.net: domain of github.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=noreply@github.com; dkim=pass header.d=github.com header.s=pf2023; dmarc=pass header.from=github.com\r\n";
        let exo = "Authentication-Results: spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=github.com; dkim=pass (signature was verified) header.d=github.com;dmarc=pass action=none header.from=github.com;compauth=pass reason=100\r\n";
        let verified =
            |r: &Receiver, auth: &str, from: &str| crate::message::authenticity(&letter(auth, from), r).verified();
        let cases = [
            ("gmail", imap("me@gmail.com", "imap.gmail.com"), gmail),
            ("gmail workspace", imap("me@firm.example", "imap.gmail.com"), gmail),
            ("yandex", imap("me@yandex.ru", "imap.yandex.ru"), yandex),
            ("mail.ru", imap("me@mail.ru", "imap.mail.ru"), mailru),
            (
                "exchange online",
                ews("me@firm.example", "https://outlook.office365.com/EWS/Exchange.asmx"),
                exo,
            ),
        ];
        for (name, receiver, auth) in cases {
            assert!(verified(&receiver, auth, "notifications@github.com"), "{name}");
            assert!(
                !verified(&receiver, auth, "notifications@mail.github.com"),
                "{name}: header.from is the From domain as it stands"
            );
            assert!(
                !verified(&receiver, auth, "notifications@github.example"),
                "{name}: other domain"
            );
            assert!(
                !verified(&receiver, auth, "notifications@evilgithub.com"),
                "{name}: look-alike"
            );
            assert!(
                !verified(
                    &receiver,
                    &auth.replace("dmarc=pass", "dmarc=fail"),
                    "notifications@github.com"
                ),
                "{name}: fail"
            );
        }
    }

    #[test]
    fn the_check_says_why() {
        let gmail = imap("me@gmail.com", "imap.gmail.com");
        let one = |s: &str| vec![s.to_owned()];
        let check = |h: &[String], from: &str| check_sender(h, from, &gmail);
        assert_eq!(
            check(&one("mx.google.com; dmarc=pass header.from=bank.ru"), "bank.ru"),
            SenderCheck::Passed
        );
        assert_eq!(
            check(&one("mx.google.com; dmarc=fail header.from=bank.ru"), "bank.ru"),
            SenderCheck::DmarcNot("fail".into())
        );
        assert_eq!(
            check(&one("mx.google.com; dmarc=none header.from=bank.ru"), "bank.ru"),
            SenderCheck::DmarcNot("none".into())
        );
        assert_eq!(check(&one("mx.google.com; spf=pass"), "bank.ru"), SenderCheck::NoDmarc);
        assert_eq!(
            check(&one("mx.google.com; dmarc=pass header.from=other.ru"), "Bank.ru"),
            SenderCheck::NotAligned {
                header_from_domain: Some("other.ru".into()),
                from_domain: "bank.ru".into()
            }
        );
        assert_eq!(
            check(&one("mx.google.com; dmarc=pass"), "bank.ru"),
            SenderCheck::NotAligned {
                header_from_domain: None,
                from_domain: "bank.ru".into()
            }
        );
        let foreign = vec![
            "mx.evil.example; dmarc=pass header.from=bank.ru".to_owned(),
            "dmarc=pass header.from=bank.ru".to_owned(),
        ];
        let SenderCheck::NoOwnHeader { seen, receiver } = check(&foreign, "bank.ru") else {
            panic!("not ours");
        };
        assert_eq!(seen, ["mx.evil.example", "-"]);
        assert!(receiver.contains(&"gmail.com".to_owned()) && receiver.contains(&"google.com".to_owned()));
        assert!(matches!(check(&[], "bank.ru"), SenderCheck::NoOwnHeader { .. }));
        // The line for the log: domains and words, nothing of the letter.
        let line = check(&foreign, "bank.ru").to_string();
        assert!(line.contains("mx.evil.example") && line.contains("gmail.com"), "{line}");
    }

    #[test]
    fn header_from_is_the_from_domain_exactly() {
        let gmail = imap("me@gmail.com", "imap.gmail.com");
        let one = |from: &str| vec![format!("mx.google.com; dmarc=pass header.from={from}")];
        assert_eq!(
            check_sender(&one("github.com"), "mail.github.com", &gmail),
            SenderCheck::NotAligned {
                header_from_domain: Some("github.com".into()),
                from_domain: "mail.github.com".into()
            }
        );
        assert!(!dmarc_passed(&one("mail.github.com"), "github.com", &gmail));
        // Case and a trailing dot are no difference.
        assert!(dmarc_passed(&one("GitHub.com."), "github.COM", &gmail));
        // Nor is the spelling of an IDN.
        assert!(dmarc_passed(&one("xn--e1afmkfd.xn--p1ai"), "пример.рф", &gmail));
        assert!(dmarc_passed(&one("пример.рф"), "xn--e1afmkfd.xn--p1ai", &gmail));
        assert!(!dmarc_passed(&one("xn--e1afmkfd.xn--p1ai"), "пример2.рф", &gmail));
    }

    #[test]
    fn the_log_line_stays_short_and_plain() {
        let gmail = imap("me@firm.example", "imap.gmail.com");
        let many: Vec<String> = (0..1000)
            .map(|i| format!("mx{i}.{}.example; dmarc=pass header.from=bank.ru", "a".repeat(200)))
            .collect();
        let SenderCheck::NoOwnHeader { seen, receiver } = check_sender(&many, "bank.ru", &gmail) else {
            panic!("not ours");
        };
        assert_eq!(seen.len(), MAX_SEEN);
        assert!(seen.iter().all(|s| s.len() <= MAX_SEEN_LEN));
        assert!(!receiver.contains(&"firm.example".to_owned()), "{receiver:?}");
        assert!(receiver.contains(&"gmail.com".to_owned()));
        let line = check_sender(&many, "bank.ru", &gmail).to_string();
        assert!(line.len() < 1500, "{}", line.len());
        // What the letter wrote under a name of ours that is no name is not copied.
        let odd = vec!["mx.evil.example\u{1b}[2J \"x\" ; dmarc=pass".to_owned()];
        let SenderCheck::NoOwnHeader { seen, .. } = check_sender(&odd, "bank.ru", &gmail) else {
            panic!("not ours");
        };
        assert!(seen.iter().all(|s| {
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '?')
        }));
    }

    #[test]
    fn a_google_oauth_mailbox_owns_the_servers_of_google() {
        let oauth = |email: &str| {
            let (imap, smtp) = crate::account::OAuthProvider::Google.servers();
            Receiver::of(&Account {
                imap,
                smtp,
                auth: crate::account::AuthMethod::OAuth {
                    provider: crate::account::OAuthProvider::Google,
                },
                ..account(email, "")
            })
        };
        // A Workspace box on the firm's own domain is read from `imap.gmail.com`.
        for email in ["me@gmail.com", "me@firm.example"] {
            let r = oauth(email);
            for d in ["gmail.com", "googlemail.com", "google.com"] {
                assert!(r.domains.contains(&d.to_owned()), "{email}: {d} in {:?}", r.domains);
            }
            assert!(r.owns("mx.google.com"), "{email}");
            assert!(!r.owns("mx.evil.example"), "{email}");
            assert!(!r.exchange && !r.exchange_online);
        }
        assert!(oauth("me@firm.example").domains.contains(&"firm.example".to_owned()));
    }

    #[test]
    fn the_topmost_header_of_ours_decides_even_without_a_dmarc_result() {
        let gmail_box = imap("me@gmail.com", "imap.gmail.com");
        let own_without = "mx.google.com; dkim=none; spf=none".to_owned();
        let forged_pass = "mx.google.com; dmarc=pass header.from=bank.ru".to_owned();
        // Ours says nothing of DMARC and stands above a pass the sender wrote under our name.
        assert!(!dmarc_passed(
            &[own_without.clone(), forged_pass.clone()],
            "bank.ru",
            &gmail_box
        ));
        // The same pass on top is the server's own word.
        assert!(dmarc_passed(&[forged_pass, own_without], "bank.ru", &gmail_box));
    }

    #[test]
    fn a_logo_is_asked_about_by_the_registrable_domain_of_the_public_suffix_list() {
        for (email, want) in [
            ("news@r123.evil.example", Some("evil.example")),
            ("News@Evil.Example", Some("evil.example")),
            ("a@kiev.ua", None),
            ("a@x.kiev.ua", Some("x.kiev.ua")),
            ("a@x.github.io", None),
            ("a@paypal.us.com", None),
            ("a@x.eu.org", None),
            ("a@a.b.co.uk", Some("b.co.uk")),
            // msk.ru is a private suffix of the list (names are rented under it).
            ("a@r1.mail.msk.ru", None),
            ("a@r1.mail.spb.ru", None),
            ("a@r1.mail.example.ru", Some("example.ru")),
            ("a@ne.jp", None),
            ("a@shop.example.ne.jp", Some("example.ne.jp")),
            ("a@почта.рф", Some("xn--80a1acny.xn--p1ai")),
            ("a@Новости.ПОЧТА.рф", Some("xn--80a1acny.xn--p1ai")),
            ("a@localhost", None),
            ("a@com", None),
            ("nobody", None),
        ] {
            assert_eq!(logo_domain(email).as_deref(), want, "{email}");
        }
    }

    #[test]
    fn reads_the_result_not_the_comments() {
        let r = imap("me@example.net", "imap.example.net");
        let one = |v: &str| vec![v.to_owned()];
        assert!(!dmarc_passed(
            &one("mx.example.net; dmarc=fail (policy said dmarc=pass) header.from=example.com"),
            "example.com",
            &r
        ));
        assert!(!dmarc_passed(
            &one("mx.example.net; spf=pass (dmarc=pass header.from=example.com) smtp.mailfrom=example.com"),
            "example.com",
            &r
        ));
        assert!(dmarc_passed(
            &one("mx.example.net 1; dmarc = pass (p=reject) header.from=\"example.com\""),
            "example.com",
            &r
        ));
        // Without header.from the verdict may be about another domain: not counted.
        assert!(!dmarc_passed(&one("mx.example.net; dmarc=pass"), "example.com", &r));
    }

    #[test]
    fn believes_only_the_receiving_servers_name() {
        let exo = "spf=pass smtp.mailfrom=bank.ru; dkim=pass header.d=bank.ru;dmarc=pass action=none header.from=bank.ru;compauth=pass";
        let one = |v: &str| vec![v.to_owned()];
        // Exchange Online writes no server name: its verdict is believed on top, for its mailboxes only.
        let m365 = ews("me@contoso.example", "https://outlook.office365.com/EWS/Exchange.asmx");
        assert!(m365.exchange_online);
        assert!(dmarc_passed(&one(exo), "bank.ru", &m365));
        assert!(!dmarc_passed(
            &["mx.contoso.example; spf=pass".into(), exo.into()],
            "bank.ru",
            &m365
        ));
        let on_prem = ews("me@contoso.example", "https://mail.contoso.example/EWS/Exchange.asmx");
        assert!(!on_prem.exchange_online);
        assert!(!dmarc_passed(&one(exo), "bank.ru", &on_prem));
        assert!(!dmarc_passed(
            &one(exo),
            "bank.ru",
            &imap("me@example.net", "imap.example.net")
        ));
        // The provider's other domain is its own; a domain like it is not.
        let yandex = imap("me@company.example", "imap.yandex.ru");
        let ar = "mail-nwsmtp-mxfront-production-main-1.vla.yp-c.yandex.net; dmarc=pass header.from=bank.ru";
        assert!(dmarc_passed(&one(ar), "bank.ru", &yandex));
        assert!(!dmarc_passed(
            &one("mx.yandex.net.evil.example; dmarc=pass header.from=bank.ru"),
            "bank.ru",
            &yandex
        ));
        // A server of the mailbox's own domain counts even when the IMAP server is elsewhere.
        assert!(dmarc_passed(
            &one("mx.company.example; dmarc=pass header.from=bank.ru"),
            "bank.ru",
            &yandex
        ));
    }

    #[tokio::test]
    async fn never_downloads_a_logo_from_a_private_address() {
        let e = fetch_logo("https://10.0.0.1/logo.svg").await.unwrap_err();
        assert!(matches!(e, crate::Error::PrivateAddress(_)), "{e}");
    }

    #[test]
    fn names_picture_types() {
        assert!(data_uri(b"\x89PNG\r\n").starts_with("data:image/png;base64,"));
        assert!(data_uri(b"\xff\xd8\xff").starts_with("data:image/jpeg;base64,"));
    }
}
