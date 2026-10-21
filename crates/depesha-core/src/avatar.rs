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
pub(crate) fn registrable(host: &str) -> Option<String> {
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

/// How many `Received` headers the walk reads: the mailbox's own hops stand at the top, and a
/// letter relayed many times is no reason to read the whole chain.
const MAX_RECEIVED: usize = 5;

/// How many leading hops name no organization: Gmail's own first hop is `by 2002:…`, but a hop
/// further down may already be the sender's, so the provider's named hop must be at the top.
const LEADING_HOPS: usize = 2;

/// A dotless `authserv-id` counts only as a long, provider-chosen per-machine name
/// (`mail-nwsmtp-mxfront-production-main-60`): `mx`, `mail` and `smtp` are short labels anyone
/// guesses, and a hoster may not strip a copy of one.
const MIN_DOTLESS_LABEL: usize = 12;

/// The mail system that took the letter from the internet, from the topmost `Received` headers
/// (#167). The mailbox's own system writes those headers, and the sender's copies of them stand
/// below.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Delivery {
    /// Organizational domain of the first named `by` host.
    pub domain: String,
    /// Full `by` host names of the provider's consecutive hops, lower case. Yandex signs its
    /// verdict with the first label of one of them in place of a domain.
    pub hosts: Vec<String>,
}

/// [`Delivery`] from the topmost `Received` headers. The provider's MX that took the letter
/// names itself (`mx.google.com`); Gmail's topmost hop is `by 2002:…`, an address literal that
/// names no organization, so the walk passes over hosts that name nothing. The first host that
/// does gives the delivery domain; every hop after it of the same organization is the provider's
/// too. The first hop of another organization ends the run: whatever stands below is the
/// sender's. So does a hop that cannot be read at all, and nothing below [`LEADING_HOPS`] is
/// read while no organization has been found.
pub(crate) fn delivery_hops(received: &[String]) -> Option<Delivery> {
    let mut domain: Option<String> = None;
    let mut hosts = Vec::new();
    for (i, header) in received.iter().take(MAX_RECEIVED).enumerate() {
        if domain.is_none() && i >= LEADING_HOPS {
            break;
        }
        match hop(header) {
            // The text around the clause is the sender's: two `by` tokens make it anyone's.
            Hop::Ambiguous => break,
            Hop::Host(host) => match by_org(&host) {
                None if domain.is_some() => break,
                None => continue,
                Some(org) => match &domain {
                    None => {
                        domain = Some(org);
                        hosts.push(host);
                    }
                    Some(d) if *d == org => hosts.push(host),
                    Some(_) => break,
                },
            },
        }
    }
    domain.map(|domain| Delivery { domain, hosts })
}

/// The organization of a `by` host: `None` for an address literal, a name without a dot or one
/// the public suffix list does not know (`mail.local` names no organization).
fn by_org(host: &str) -> Option<String> {
    let literal = host.starts_with('[') && host.ends_with(']');
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let host = host.strip_prefix("ipv6:").unwrap_or(host);
    if literal || host.parse::<std::net::IpAddr>().is_ok() || !host.contains('.') || !known_suffix(host) {
        return None;
    }
    own_domain(host)
}

/// Whether the public suffix list knows the name's suffix: the list's fallback rule makes any
/// two labels a domain, and `mail.local` names no organization.
fn known_suffix(host: &str) -> bool {
    psl::suffix(host.as_bytes()).is_some_and(|s| s.is_known())
}

/// What a `Received` header's `by` clause says.
enum Hop {
    /// Exactly one clause, naming this host (lower case, without punctuation around it).
    Host(String),
    /// Not exactly one readable clause: a `by` in a comment or a quote, a second `by`, a
    /// comment or quote left open, or no `by` at all. The text around the clause is the
    /// sender's, so such a hop belongs to no one.
    Ambiguous,
}

/// The `by` clause of a `Received` value. Every `by` in the raw text counts, comments and
/// quotes included, and the text between them must be balanced: the HELO in `from <HELO> (…)`
/// is the sender's, and a `(` or `"` left open there would otherwise swallow the real clause.
/// An odd but honest header is therefore refused, which only falls back to the configured and
/// family domains: less trust, never more.
fn hop(value: &str) -> Hop {
    let raw = value
        .split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | '"'))
        .filter(|word| word.eq_ignore_ascii_case("by"))
        .count();
    if raw != 1 {
        return Hop::Ambiguous;
    }
    let Some(clean) = without_comments_or_quotes(value) else {
        return Hop::Ambiguous;
    };
    let words: Vec<&str> = clean.split_whitespace().collect();
    let mut clauses = words.iter().enumerate().filter(|(_, w)| w.eq_ignore_ascii_case("by"));
    let Some((at, _)) = clauses.next() else {
        // The one `by` was in a comment or a quote: no clause at all.
        return Hop::Ambiguous;
    };
    if clauses.next().is_some() {
        return Hop::Ambiguous;
    }
    match words.get(at + 1).map(|host| trim_host(host)) {
        Some(host) if !host.is_empty() => Hop::Host(host),
        _ => Hop::Ambiguous,
    }
}

/// A `by` host lower case and without what the punctuation around it leaves: a trailing comma,
/// a closing comment or the like (`mx.google.com,`, `mx.google.com)`), but an address literal
/// keeps its brackets.
fn trim_host(word: &str) -> String {
    let lower = word.to_ascii_lowercase();
    if let Some(end) = lower.strip_prefix('[').and_then(|w| w.find(']')).map(|i| i + 2) {
        return lower[..end].to_owned();
    }
    lower
        .trim_end_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .trim_end_matches('.')
        .to_owned()
}

/// `value` with comments dropped and quoted strings blanked out: neither says what the header
/// means here. `None` when a comment or a quote is still open at the end: the rest of the
/// header then has no reading.
fn without_comments_or_quotes(value: &str) -> Option<String> {
    let mut out = String::with_capacity(value.len());
    let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
    for c in value.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' if quoted || depth > 0 => escaped = true,
            '"' if depth == 0 => {
                quoted = !quoted;
                out.push(' ');
            }
            '(' if !quoted => depth += 1,
            ')' if !quoted && depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    out.push(' ');
                }
            }
            _ if depth == 0 && !quoted => out.push(c),
            _ => {}
        }
    }
    (depth == 0 && !quoted).then_some(out)
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

/// Mail services whose servers sign `Authentication-Results` with a domain other than the
/// mailbox's (`mx.google.com` for `imap.gmail.com`). A fallback for when the letter's own
/// `Received` headers name no provider hop.
const FAMILIES: [&[&str]; 3] = [
    &["gmail.com", "googlemail.com", "google.com"],
    &["yandex.ru", "yandex.com", "ya.ru", "yandex.net"],
    &["mail.ru", "bk.ru", "inbox.ru", "list.ru", "internet.ru"],
];

/// Mail systems of Microsoft 365 that serve EWS: the worldwide one (`outlook.office365.com`,
/// `outlook.office.com`), US Government (`outlook.office365.us`) and the one 21Vianet runs in
/// China (`partner.outlook.cn`).
const EXCHANGE_ONLINE: [&str; 5] = [
    "office365.com",
    "outlook.com",
    "office.com",
    "office365.us",
    "outlook.cn",
];

/// Who received a message: the servers whose `Authentication-Results` count.
/// Anyone can write that header into a letter (RFC 8601 §5); the receiving server
/// removes copies that claim its own name, so only its name is believed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Receiver {
    /// Whose `authserv-id` counts: the organization of the mailbox's server, or its provider's
    /// whole family. Not the address domain: no server strips a forged copy written under it.
    pub domains: Vec<String>,
    /// The mailbox's server writes its own `Authentication-Results` on top and strips copies
    /// that claim its name: Gmail, Yandex and Mail.ru by IMAP, Exchange Online by EWS. Any
    /// other server (Postfix and Dovecot without OpenDMARC, Exchange of the firm's own, Exchange
    /// Online by IMAP) may hand a forged one over as it came, so none is believed there (#35):
    /// the app checks the DKIM signature itself.
    pub vouches: bool,
    /// The mail system that took the letter from the internet, from the letter's own `Received`
    /// headers ([`delivery_hops`]): a provider may sign its verdict with a name that is none of
    /// the configured ones (`mx.google.com` for `imap.gmail.com`), or with no domain at all.
    pub delivery: Option<Delivery>,
    /// Exchange Online: writes its verdict without a server name, on top of the
    /// header, and renames the ones that came with the letter.
    pub exchange_online: bool,
    /// Exchange (Web Services): its own `X-MS-Exchange-Organization-*` headers are
    /// stripped from mail that comes from outside, so `AuthAs: Internal` is its word. An
    /// Exchange of the firm's own (not Exchange Online) strips no `Authentication-Results`
    /// that claim its name, so none of them is believed there.
    pub exchange: bool,
}

impl Receiver {
    pub fn of(account: &Account) -> Self {
        let server = match &account.ews {
            Some(ews) => crate::http::Url::parse(&ews.url).map(|u| u.host).unwrap_or_default(),
            None => account.imap.host.clone(),
        };
        let host = server.trim().trim_end_matches('.').to_ascii_lowercase();
        // An IP address names no organization.
        let org = (!host.is_empty() && host.parse::<std::net::IpAddr>().is_err() && host.contains('.'))
            .then(|| own_domain(&host))
            .flatten();
        let family = org
            .as_deref()
            .and_then(|org| FAMILIES.iter().find(|f| f.contains(&org)));
        let domains = match (family, org.clone()) {
            (Some(f), _) => f.iter().map(|d| (*d).to_owned()).collect(),
            (None, org) => org.into_iter().collect(),
        };
        let exchange_online = account.is_ews() && org.is_some_and(|org| EXCHANGE_ONLINE.contains(&org.as_str()));
        Self {
            domains,
            vouches: exchange_online || (!account.is_ews() && family.is_some()),
            delivery: None,
            exchange_online,
            exchange: account.is_ews(),
        }
    }

    /// The same receiver, also believing the mail system the letter's `Received` headers name.
    pub fn with_delivery(&self, delivery: Option<Delivery>) -> Self {
        Self {
            delivery,
            ..self.clone()
        }
    }

    fn owns(&self, authserv_id: &str) -> bool {
        let id = authserv_id.trim_end_matches('.').to_ascii_lowercase();
        // Yandex writes the first label of its own MX where a server name goes. The sender
        // chooses its `from` host, so only the `by` hosts of the provider count here, and only
        // a provider-chosen per-machine name: `mx` or `mail` is a guess anyone makes.
        if !id.contains('.') {
            return id.len() >= MIN_DOTLESS_LABEL
                && self.delivery.as_ref().is_some_and(|delivery| {
                    delivery
                        .hosts
                        .iter()
                        .any(|host| host.split('.').next() == Some(id.as_str()))
                });
        }
        own_domain(&id).is_some_and(|d| {
            self.domains.contains(&d) || self.delivery.as_ref().is_some_and(|delivery| delivery.domain == d)
        })
    }
}

/// The DMARC verdict of one `Authentication-Results` header.
#[derive(Debug, PartialEq, Eq)]
struct Results {
    /// The server that wrote it; `None` in Exchange Online's format.
    authserv_id: Option<String>,
    /// `(result word, header.from)` of the `dmarc=` result, if there is one.
    dmarc: Option<(String, Option<String>)>,
    /// `(result word, signing domain)` of every `dkim=` result.
    dkim: Vec<(String, Option<String>)>,
    /// `(result word, envelope domain)` of every `spf=` result.
    spf: Vec<(String, Option<String>)>,
}

/// The domain of `user@domain`, `@domain` or a bare `domain`.
fn mail_domain(value: &str) -> String {
    value.rsplit('@').next().unwrap_or_default().to_owned()
}

fn results(value: &str) -> Results {
    let clean = without_comments(value).to_ascii_lowercase();
    let mut parts = split_unquoted(&clean, |c| c == ';').into_iter().map(str::trim);
    let first = parts.next().unwrap_or_default();
    // `authserv-id [version]`, unless the header starts with a result straight away.
    let (authserv_id, first_result) = if first.contains('=') {
        (None, Some(first))
    } else {
        (first.split_whitespace().next().map(str::to_owned), None)
    };
    let mut dmarc = None;
    let (mut dkim, mut spf) = (Vec::new(), Vec::new());
    for resinfo in first_result.into_iter().chain(parts) {
        // `dmarc = pass` is allowed too: glue the `=` back to its word.
        let resinfo = split_unquoted(resinfo, char::is_whitespace)
            .join(" ")
            .replace(" =", "=")
            .replace("= ", "=");
        let words = split_unquoted(&resinfo, char::is_whitespace);
        let Some(&first) = words.first() else { continue };
        let property = |name: &str| {
            words[1..]
                .iter()
                .find_map(|w| w.strip_prefix(name))
                .map(|d| d.trim_matches('"').to_owned())
        };
        if let Some(result) = first.strip_prefix("dmarc=") {
            if dmarc.is_none() {
                dmarc = Some((result.to_owned(), property("header.from=")));
            }
        } else if let Some(result) = first.strip_prefix("dkim=") {
            // The signing domain: `header.d`, or the domain of `header.i` (`@d` or `u@d`).
            let domain = property("header.d=")
                .or_else(|| property("header.i="))
                .map(|d| mail_domain(&d));
            dkim.push((result.to_owned(), domain));
        } else if let Some(result) = first.strip_prefix("spf=") {
            let domain = property("smtp.mailfrom=")
                .or_else(|| property("smtp.mail="))
                .map(|d| mail_domain(&d));
            spf.push((result.to_owned(), domain));
        }
    }
    Results {
        authserv_id,
        dmarc,
        dkim,
        spf,
    }
}

/// `value` cut at the characters `sep` accepts, except inside a quoted string (`\\` escapes
/// there): a quoted value is one word, whatever it holds. Empty pieces are dropped for a
/// whitespace separator only by the caller's `trim`/`join`.
fn split_unquoted(value: &str, sep: impl Fn(char) -> bool) -> Vec<&str> {
    let (mut parts, mut start) = (Vec::new(), 0);
    let (mut quoted, mut escaped) = (false, false);
    for (i, c) in value.char_indices() {
        if escaped {
            escaped = false;
        } else if quoted && c == '\\' {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
        } else if !quoted && sep(c) {
            parts.push(&value[start..i]);
            start = i + c.len_utf8();
        }
    }
    parts.push(&value[start..]);
    parts.retain(|p| !p.is_empty());
    parts
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
/// letter itself wrote (`seen`, `delivery`) is cut to a few short `[a-z0-9.-]` names first; the
/// mailbox's own address domain is not in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SenderCheck {
    /// The server of the mailbox wrote no `Authentication-Results`; `seen` are the
    /// `authserv-id`s the letter did carry (`-` for a header without one), `delivery` the
    /// organization the letter's own `Received` headers name.
    NoOwnHeader {
        seen: Vec<String>,
        receiver: Vec<String>,
        delivery: Option<String>,
    },
    /// The topmost header of ours has no `dmarc=` result and no passed `dkim`/`spf` at all.
    NoDmarc,
    /// No `dmarc=` result (the server did not check DMARC), and no passed `dkim`/`spf` is
    /// about exactly the From domain.
    NotAlignedWithoutDmarc,
    /// No `dmarc=` result, but a passed `dkim` or `spf` is about exactly the From domain.
    /// Not a DMARC verdict: the server did not check DMARC, but it did check the signature on
    /// the original bytes, which is as much as a DMARC verdict says (0.8.13, 2.1 Б).
    AlignedWithoutDmarc {
        via: &'static str,
    },
    /// The result word was not `pass`.
    DmarcNot(String),
    /// No `dmarc=` result, no passed `dkim`/`spf` about the From domain, and a `dkim=fail` or
    /// `permerror` of the From domain's organization: the server's «no».
    DkimFailed,
    /// `dmarc=pass`, but about another organization than the From domain.
    NotAligned {
        header_from_domain: Option<String>,
        from_domain: String,
    },
    Passed,
}

impl SenderCheck {
    /// The sender's domain is believed: the server's own `dmarc=pass`, or (a server that
    /// writes no `dmarc=`) a passed DKIM/SPF result about exactly the From domain.
    pub fn passed(&self) -> bool {
        matches!(self, Self::Passed | Self::AlignedWithoutDmarc { .. })
    }

    /// The server's own DMARC verdict: `dmarc=pass` about the From domain. A passed
    /// signature without a DMARC result is not this: the server did not check DMARC.
    pub fn dmarc_passed(&self) -> bool {
        matches!(self, Self::Passed)
    }

    /// The mailbox's server gave no verdict on the sender: no header of its own, or no DMARC
    /// check in it. The app may then check the DKIM signature itself ([`crate::dkim`]); a `no`
    /// of the server (`dmarc=fail`, another organization) stays a `no`.
    pub fn no_verdict(&self) -> bool {
        matches!(
            self,
            Self::NoOwnHeader { .. } | Self::NoDmarc | Self::NotAlignedWithoutDmarc
        )
    }

    /// The server's word alone confirms the sender. A passed signature of the sender's
    /// organization without a DMARC result does too (0.8.13, 2.1 Б): the server checked the
    /// body hash on the original bytes when it took the letter, and the app cannot check it
    /// better later. What may still go wrong is that the server read the `From` differently
    /// than the app does; the one From both readers see ([`crate::message::sole_from`]) closes
    /// that way in.
    pub fn confirmed(&self) -> bool {
        self.passed()
    }
}

impl std::fmt::Display for SenderCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoOwnHeader {
                seen,
                receiver,
                delivery,
            } => write!(
                f,
                "no Authentication-Results of the mailbox's server (seen authserv-id: [{}], receiver domains: [{}], delivery domain: {})",
                seen.join(", "),
                receiver.join(", "),
                loggable(delivery.as_deref())
            ),
            Self::NoDmarc => f.write_str("the server's header has no dmarc result"),
            Self::NotAlignedWithoutDmarc => {
                f.write_str("the server did not check DMARC; no passed DKIM/SPF is about the From domain")
            }
            Self::AlignedWithoutDmarc { via } => {
                write!(f, "the server did not check DMARC; {via} passed for the From domain")
            }
            Self::DmarcNot(word) => write!(f, "dmarc={word}"),
            Self::DkimFailed => f.write_str("the server did not check DMARC; DKIM of the From domain failed"),
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
/// sender's organization in `header.from` (relaxed alignment): without it, it may be about another
/// domain.
pub fn dmarc_passed(auth_results: &[String], from_domain: &str, receiver: &Receiver) -> bool {
    check_sender(auth_results, from_domain, receiver).passed()
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
        // A server that may leave a forged copy in place vouches for nothing (#35).
        let ours = receiver.vouches
            && match &r.authserv_id {
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
            None => without_dmarc(&r, from_domain),
            Some((word, _)) if word != "pass" => SenderCheck::DmarcNot(word),
            Some((_, header_from)) if header_from.as_deref().is_some_and(|d| aligned(d, from_domain)) => {
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
        receiver: receiver.domains.clone(),
        delivery: receiver.delivery.as_ref().map(|d| d.domain.clone()),
    }
}

/// For a server that writes no `dmarc=` result at all (Yandex): the sender is believed when a
/// passed SPF check is about exactly the From domain, or (once the app's own check of the
/// signature agrees, [`SenderCheck::confirmed`]) a passed DKIM signature is about the From
/// domain's organization (relaxed alignment, the default of DMARC; #167). Not a DMARC
/// verdict: the sender's `adkim`/`aspf` and policy are unknown. An explicit
/// `dmarc=none`/`fail` never gets here, and a failed signature of the sender's organization
/// without a pass is a «no» the app's own check does not overrule.
fn without_dmarc(r: &Results, from_domain: &str) -> SenderCheck {
    let passed_for = |list: &[(String, Option<String>)], same: fn(&str, &str) -> bool| {
        list.iter()
            .any(|(word, d)| word == "pass" && d.as_deref().is_some_and(|d| same(d, from_domain)))
    };
    if passed_for(&r.spf, same_domain) {
        SenderCheck::AlignedWithoutDmarc { via: "spf" }
    } else if passed_for(&r.dkim, aligned) {
        SenderCheck::AlignedWithoutDmarc { via: "dkim" }
    } else if r.dkim.iter().any(|(word, d)| {
        matches!(word.as_str(), "fail" | "permerror") && d.as_deref().is_some_and(|d| aligned(d, from_domain))
    }) {
        SenderCheck::DkimFailed
    } else if r.dkim.iter().chain(&r.spf).any(|(word, _)| word == "pass") {
        SenderCheck::NotAlignedWithoutDmarc
    } else {
        SenderCheck::NoDmarc
    }
}

/// The same domain name: case, a trailing dot and IDN spelling are not differences.
pub(crate) fn same_domain(header_from: &str, from_domain: &str) -> bool {
    let ascii = |d: &str| idna::domain_to_ascii(d.trim().trim_end_matches('.')).ok();
    match (ascii(header_from), ascii(from_domain)) {
        (Some(a), Some(b)) => !a.is_empty() && a == b,
        _ => false,
    }
}

/// Relaxed alignment of DMARC (RFC 7489 §3.1.1): the same name, or the same registrable
/// domain by the public suffix list (#167: `openai.com` signs for `email.openai.com`). Under a
/// public or private suffix (`co.uk`, `github.io`) only the same name: everyone rents a name
/// there, and a neighbour is another organization.
pub(crate) fn aligned(a: &str, b: &str) -> bool {
    let ascii = |d: &str| {
        idna::domain_to_ascii(d.trim().trim_end_matches('.'))
            .ok()
            .map(|d| d.to_ascii_lowercase())
    };
    match (ascii(a), ascii(b)) {
        (Some(a), Some(b)) if !a.is_empty() && a == b => true,
        (Some(a), Some(b)) => registrable(&a).is_some_and(|org| registrable(&b).as_ref() == Some(&org)),
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

    /// A delivery of one organization alone: a letter whose `Received` names one provider hop.
    fn delivery(domain: &str) -> Option<Delivery> {
        Some(Delivery {
            domain: domain.into(),
            hosts: Vec::new(),
        })
    }

    #[test]
    fn trusts_only_a_passed_dmarc_for_the_sender() {
        // Google's MX names itself; the box is read from `imap.gmail.com`.
        let gmail_box = imap("me@gmail.com", "imap.gmail.com").with_delivery(delivery("google.com"));
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
    fn a_box_under_a_public_suffix_owns_only_its_own_registrable_domain() {
        let kiev = imap("me@firm.kiev.ua", "imap.firm.kiev.ua");
        assert!(kiev.owns("mx.firm.kiev.ua"));
        assert!(!kiev.owns("mx.evil.kiev.ua"));
        let nsk = imap("me@firm.nsk.ru", "imap.firm.nsk.ru");
        assert!(nsk.owns("mx.firm.nsk.ru"));
        assert!(!nsk.owns("mx.evil.nsk.ru"));
        // Zones the list holds as private are no reason to leave a box without a receiver.
        for zone in ["msk.ru", "spb.ru", "com.ru", "net.ru", "org.ru", "pp.ru"] {
            let firm = imap(&format!("me@firm.{zone}"), &format!("imap.firm.{zone}"));
            assert!(firm.owns(&format!("mx.firm.{zone}")), "{zone}");
            assert!(!firm.owns(&format!("mx.evil.{zone}")), "{zone}");
        }
        // A box under a private suffix owns its own name only.
        let pages = imap("me@x.github.io", "imap.x.github.io");
        assert!(!pages.owns("mx.y.github.io"));
        // None of these servers is known to strip a forged copy: its own name is believed
        // nowhere (#35). A provider's is.
        let ar = |id: &str| vec![format!("{id}; dmarc=pass header.from=bank.ru")];
        assert!(!dmarc_passed(&ar("mx.firm.kiev.ua"), "bank.ru", &kiev));
        let gmail = imap("me@gmail.com", "imap.gmail.com").with_delivery(delivery("google.com"));
        assert!(dmarc_passed(&ar("mx.google.com"), "bank.ru", &gmail));
    }

    /// A letter as the mailbox's server hands it over: its own `Received` hops on top, then
    /// its verdict, then what the sender wrote.
    fn letter_with(received: &[&str], auth: &str, from: &str) -> Vec<u8> {
        let mut raw = String::new();
        for hop in received {
            raw.push_str("Received: ");
            raw.push_str(hop);
            raw.push_str("\r\n");
        }
        raw.push_str(auth);
        raw.push_str(&format!(
            "From: GitHub <{from}>\r\nTo: me@x.example\r\nSubject: Hi\r\n\r\nText\r\n"
        ));
        raw.into_bytes()
    }

    /// Gmail's own two hops (#167): the top one is an address literal, the MX below names itself.
    const GMAIL_RECEIVED: &[&str] = &[
        "by 2002:a05:6a00:1234:b0:1:2:3 with SMTP id a1csp123456xyz;\r\n        Mon, 5 Oct 2026 10:00:00 -0700 (PDT)",
        "from out-1.smtp.github.com (out-1.smtp.github.com. [192.0.2.1])\r\n        by mx.google.com with ESMTPS id x1si1234567pgb.1.2026.10.05.10.00.00;\r\n        Mon, 05 Oct 2026 10:00:00 -0700 (PDT)",
    ];
    /// Yandex's hop: the box is on `yandex.ru`, while the MX names `yandex.net`.
    const YANDEX_RECEIVED: &[&str] = &[
        "from mail-nwsmtp-mxfront-production-main-38.iva.yp-c.yandex.net (mail-nwsmtp-mxfront-production-main-38.iva.yp-c.yandex.net [95.108.252.38])\r\n\tby mail-nwsmtp-iva-1.iva.yp-c.yandex.net with LMTPS\r\n\tid 4F8C1D2E3A5B;\r\n\tMon, 5 Oct 2026 20:00:00 +0300",
    ];
    const MAILRU_RECEIVED: &[&str] = &[
        "from mx.github.com (mx.github.com [192.0.2.1])\r\n\tby mxs.mail.ru (Postfix) with ESMTPS id 1A2B3C4D;\r\n\tMon, 5 Oct 2026 20:00:00 +0300 (MSK)",
    ];
    /// Yandex's chain in the form it reaches the operator (#167): two provider hops, both
    /// `yandex.net`, and a verdict signed with the first label of the second one.
    const YANDEX_HOPS: &[&str] = &[
        "from mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net (mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net [2a02:6b8:c0f:1:0:605:9c1f:2a4d]) by mail-nwsmtp-mxback-production-main-11.vla.yp-c.yandex.net (mxback/Yandex) with ESMTPS id 1A2B3C4D5E6F; Mon, 19 Oct 2026 10:00:00 +0300",
        "from out-21.smtp.github.com (out-21.smtp.github.com [192.30.252.204]) by mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net (smtp/Yandex) with ESMTPS id 7F8E9D0C; Mon, 19 Oct 2026 10:00:00 +0300",
    ];

    #[test]
    fn real_headers_of_each_provider_are_believed() {
        let gmail = "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@github.com header.s=pf2023 header.b=DDDD;\r\n       spf=pass (google.com: domain of noreply@github.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=noreply@github.com;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=github.com\r\n";
        let yandex = "Authentication-Results: mail-nwsmtp-mxfront-production-main-7.vla.yp-c.yandex.net; spf=pass (mail-nwsmtp-mxfront-production-main-7.vla.yp-c.yandex.net: domain of github.com designates 192.0.2.1 as permitted sender, rule=[ip4:192.0.2.0/24]) smtp.mailfrom=noreply@github.com; dkim=pass header.i=@github.com; dmarc=pass header.from=github.com\r\n";
        let mailru = "Authentication-Results: mxs.mail.ru; spf=pass (mx274.m.smailru.net: domain of github.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=noreply@github.com; dkim=pass header.d=github.com header.s=pf2023; dmarc=pass header.from=github.com\r\n";
        let exo = "Authentication-Results: spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=github.com; dkim=pass (signature was verified) header.d=github.com;dmarc=pass action=none header.from=github.com;compauth=pass reason=100\r\n";
        let verified = |r: &Receiver, received: &[&str], auth: &str, from: &str| {
            crate::message::authenticity(&letter_with(received, auth, from), r).verified()
        };
        let cases: [(&str, Receiver, &[&str], &str); 5] = [
            ("gmail", imap("me@gmail.com", "imap.gmail.com"), GMAIL_RECEIVED, gmail),
            (
                "gmail workspace",
                imap("me@firm.example", "imap.gmail.com"),
                GMAIL_RECEIVED,
                gmail,
            ),
            (
                "yandex",
                imap("me@yandex.ru", "imap.yandex.ru"),
                YANDEX_RECEIVED,
                yandex,
            ),
            ("mail.ru", imap("me@mail.ru", "imap.mail.ru"), MAILRU_RECEIVED, mailru),
            (
                "exchange online",
                ews("me@firm.example", "https://outlook.office365.com/EWS/Exchange.asmx"),
                &[],
                exo,
            ),
        ];
        for (name, receiver, received, auth) in cases {
            assert!(
                verified(&receiver, received, auth, "notifications@github.com"),
                "{name}"
            );
            assert!(
                verified(&receiver, received, auth, "notifications@mail.github.com"),
                "{name}: relaxed alignment, the same organization"
            );
            assert!(
                !verified(&receiver, received, auth, "notifications@github.example"),
                "{name}: other domain"
            );
            assert!(
                !verified(&receiver, received, auth, "notifications@evilgithub.com"),
                "{name}: look-alike"
            );
            assert!(
                !verified(
                    &receiver,
                    received,
                    &auth.replace("dmarc=pass", "dmarc=fail"),
                    "notifications@github.com"
                ),
                "{name}: fail"
            );
        }
        // A server that writes no `dmarc=` (Yandex): the server's passed signature of the From
        // organization confirms the sender (0.8.13, 2.1 Б).
        let yandex_box = imap("user@yandex.ru", "imap.yandex.ru");
        let plain = "Authentication-Results: mail-nwsmtp-mxfront-production-main-94.klg.yp-c.yandex.net; spf=pass (mail-nwsmtp-mxfront-production-main-94.klg.yp-c.yandex.net: domain of github.com designates 192.0.2.1 as permitted sender, rule=[ip4:192.0.2.0/24]) smtp.mail=notifications@github.com; dkim=pass header.i=@github.com\r\n";
        assert!(verified(
            &yandex_box,
            YANDEX_RECEIVED,
            plain,
            "notifications@github.com"
        ));
        assert!(!verified(
            &yandex_box,
            YANDEX_RECEIVED,
            plain,
            "notifications@evilgithub.com"
        ));
        // A subdomain of the same organization: relaxed alignment, the server's word holds.
        assert!(verified(
            &yandex_box,
            YANDEX_RECEIVED,
            plain,
            "notifications@mail.github.com"
        ));
    }

    #[test]
    fn the_delivery_domain_comes_from_the_by_clause() {
        let one = |header: &str| delivery_hops(&[header.to_owned()]).map(|d| d.domain);
        assert_eq!(
            one("from mx.github.com (mx.github.com [192.0.2.1]) by MX.Example-Mail.KZ with ESMTPS id 1; Mon"),
            Some("example-mail.kz".into())
        );
        // A comment is no clause, and a folded line is one line.
        assert_eq!(
            one("from x (r [192.0.2.1]) by\tmx.example.org with ESMTP id 1;\r\n\tMon"),
            Some("example.org".into())
        );
        // A `by` in a comment makes the raw count two: an honest header refused, no more trust.
        assert_eq!(
            one("from x (by evil.example) by mx.example.org with ESMTP id 1; Mon"),
            None
        );
        // An address literal names no organization.
        assert_eq!(one("by [IPv6:2001:db8::1] with SMTP id 1; Mon"), None);
        assert_eq!(one("by [192.0.2.1] with SMTP id 1; Mon"), None);
        assert_eq!(one("by 192.0.2.1 with SMTP id 1"), None);
        // Nor does a name without a dot, or one the list does not know.
        assert_eq!(one("by localhost with SMTP id 1"), None);
        assert_eq!(one("by mail.local with SMTP id 1"), None);
        // No `by` clause at all.
        assert_eq!(one("from x with SMTP id 1; Mon"), None);
        // The punctuation around the host is not part of it.
        assert_eq!(
            one("from x by mx.google.com, with ESMTP id 1; Mon"),
            Some("google.com".into())
        );
        assert_eq!(
            one("from x by mx.google.com) with ESMTP id 1; Mon"),
            Some("google.com".into())
        );
        assert_eq!(
            one("from x by mx.example.org. with ESMTP id 1; Mon"),
            Some("example.org".into())
        );
        // Only the first few headers are read.
        let mut hidden: Vec<String> = (0..MAX_RECEIVED)
            .map(|_| "by [192.0.2.1] with SMTP".to_owned())
            .collect();
        hidden.push("by mx.example.org with SMTP".to_owned());
        assert_eq!(delivery_hops(&hidden), None);
        // The named hop must stand within the first two headers: below them it may be the
        // sender's, and one literal hop above it is all a provider's own chain may need.
        let late = [
            "by [2001:db8::1] with SMTP id 0; Mon",
            "by [2001:db8::2] with SMTP id 1; Mon",
            "by mx.example.org with SMTP id 2; Mon",
        ];
        let hops: Vec<String> = late.iter().map(|h| (*h).to_owned()).collect();
        assert_eq!(delivery_hops(&hops), None);
        let early = [
            "by [2001:db8::1] with SMTP id 0; Mon",
            "by mx.example.org with SMTP id 1; Mon",
        ];
        let hops: Vec<String> = early.iter().map(|h| (*h).to_owned()).collect();
        assert_eq!(delivery_hops(&hops).map(|d| d.domain), Some("example.org".into()));
        // The run stops at the first hop of another organization; only the provider's remain.
        let chain = [
            "from out-21.smtp.github.com (out-21.smtp.github.com [192.30.252.204]) by MX.GOOGLE.COM with ESMTPS id 1; Mon",
            "from mail.github.com by out-21.smtp.github.com with ESMTP id 2; Mon",
        ];
        let hops: Vec<String> = chain.iter().map(|h| (*h).to_owned()).collect();
        assert_eq!(
            delivery_hops(&hops),
            Some(Delivery {
                domain: "google.com".into(),
                hosts: vec!["mx.google.com".into()],
            })
        );
    }

    #[test]
    fn a_sender_written_by_in_the_helo_is_no_delivery_domain() {
        // The HELO is the sender's text: a `by` in it makes the hop unreadable, and no hop
        // below it is read either.
        let one = |header: &str| delivery_hops(&[header.to_owned()]);
        for written in [
            "from z by evil.com (r [1.2.3.4]) by mail-nwsmtp-x.yandex.net with ESMTPS id 1; Mon",
            // An unclosed comment or quote would swallow the real clause, leaving evil.com.
            "from z by evil.com ( (h [1.2.3.4]) by mail-nwsmtp-x.yandex.net with ESMTPS id 1; Mon",
            "from z by evil.com \" (h [1.2.3.4]) by mail-nwsmtp-x.yandex.net with ESMTPS id 1; Mon",
            "from z (h [1.2.3.4] by mail-nwsmtp-x.yandex.net with ESMTPS id 1; Mon",
            "from z \"h [1.2.3.4] by mail-nwsmtp-x.yandex.net with ESMTPS id 1; Mon",
            // A `by` glued to the HELO counts the same.
            "from z x(by (h [1.2.3.4]) by mail-nwsmtp-x.yandex.net with ESMTPS id 1; Mon",
        ] {
            assert_eq!(one(written), None, "{written}");
            let chain = vec![written.to_owned(), YANDEX_HOPS[1].to_owned()];
            assert_eq!(delivery_hops(&chain), None, "{written}");
        }
        // What was collected above the unreadable hop stays; it is not replaced.
        let written = "from x by evil.com (r [1.2.3.4]) by mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net with ESMTPS id 1; Mon".to_owned();
        let chain = vec![YANDEX_HOPS[1].to_owned(), written, YANDEX_HOPS[0].to_owned()];
        assert_eq!(
            delivery_hops(&chain),
            Some(Delivery {
                domain: "yandex.net".into(),
                hosts: vec!["mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net".into()],
            })
        );
        // An honest chain of each provider is still read.
        let hops = |chain: &[&str]| chain.iter().map(|h| (*h).to_owned()).collect::<Vec<String>>();
        assert_eq!(
            delivery_hops(&hops(GMAIL_RECEIVED)).map(|d| d.domain),
            Some("google.com".into())
        );
        assert_eq!(
            delivery_hops(&hops(YANDEX_HOPS)).map(|d| d.domain),
            Some("yandex.net".into())
        );
    }

    #[test]
    fn a_dotless_id_needs_a_specific_provider_label() {
        // A hoster that writes `Received` but no verdict of its own: `mx` is what anyone guesses.
        let hoster = imap("me@firm.kz", "imap.mailhost.kz");
        let received: &[&str] =
            &["from mx.github.com (mx.github.com [192.0.2.1]) by mx.hoster.example-mail.kz with ESMTPS id 1; Mon"];
        let forged = "Authentication-Results: mx; dmarc=pass header.from=bank.ru\r\n";
        let check =
            |auth: &str| crate::message::authenticity(&letter_with(received, auth, "security@bank.ru"), &hoster).check;
        assert!(matches!(
            check(forged),
            Some(SenderCheck::NoOwnHeader { delivery: Some(domain), .. }) if domain == "example-mail.kz"
        ));
        let generic = hoster.with_delivery(Some(Delivery {
            domain: "example-mail.kz".into(),
            hosts: vec!["mx.hoster.example-mail.kz".into()],
        }));
        assert!(!generic.owns("mx") && !generic.owns("mail") && !generic.owns("smtp"));
        // A provider-chosen per-machine name of the same hop is its own.
        let specific = hoster.with_delivery(Some(Delivery {
            domain: "example-mail.kz".into(),
            hosts: vec!["mail-nwsmtp-mxfront-production-main-60.example-mail.kz".into()],
        }));
        assert!(specific.owns("mail-nwsmtp-mxfront-production-main-60"));
        assert!(!specific.owns("mail-nwsmtp-mxfront-production-main-6"));
    }

    #[test]
    fn the_letter_names_the_mailboxs_own_mail_system() {
        let check = |receiver: &Receiver, received: &[&str], auth: &str, from: &str| {
            crate::message::authenticity(&letter_with(received, auth, from), receiver).check
        };
        // Gmail: the top hop is an address literal, the MX below it names itself.
        let gmail = imap("me@firm.example", "imap.gmail.com");
        let gmail_ar = "Authentication-Results: mx.google.com; dkim=pass header.i=@github.com; dmarc=pass header.from=github.com\r\n";
        assert_eq!(
            check(&gmail, GMAIL_RECEIVED, gmail_ar, "notifications@github.com"),
            Some(SenderCheck::Passed)
        );

        // Yandex: the box is on `yandex.ru`, while the server signs as `…yandex.net`.
        let yandex = imap("user@yandex.ru", "imap.yandex.ru");
        let google_alert = "Authentication-Results: mail-nwsmtp-mxfront-production-main-38.iva.yp-c.yandex.net; spf=pass (mail-nwsmtp-mxfront-production-main-38.iva.yp-c.yandex.net: domain of accounts.google.com designates 192.0.2.1 as permitted sender) smtp.mail=noreply@bounces.google.com; dkim=pass header.i=@accounts.google.com\r\n";
        assert_eq!(
            check(&yandex, YANDEX_RECEIVED, google_alert, "no-reply@accounts.google.com"),
            Some(SenderCheck::AlignedWithoutDmarc { via: "dkim" })
        );
        let github_ar = "Authentication-Results: mail-nwsmtp-mxfront-production-main-38.iva.yp-c.yandex.net; spf=pass (domain of github.com designates 192.0.2.1 as permitted sender) smtp.mail=noreply@github.com; dkim=pass header.i=@github.com\r\n";
        assert_eq!(
            check(&yandex, YANDEX_RECEIVED, github_ar, "notifications@github.com"),
            Some(SenderCheck::AlignedWithoutDmarc { via: "spf" })
        );
        // The family stands in when no hop names Yandex: a letter of another MX or none at all.
        let other_hop: &[&str] = &[
            "from out-21.smtp.github.com (out-21.smtp.github.com [192.30.252.204]) by out-21.smtp.github.com with ESMTP id 3; Mon, 19 Oct 2026 10:00:00 +0300",
        ];
        for received in [other_hop, &[]] {
            assert_eq!(
                check(&yandex, received, github_ar, "notifications@github.com"),
                Some(SenderCheck::AlignedWithoutDmarc { via: "spf" })
            );
        }

        // A Yandex 360 box on a custom domain: `corp.example` is the only domain of its own.
        let yandex360 = imap("me@corp.example", "imap.yandex.ru");
        assert_eq!(
            check(&yandex360, YANDEX_RECEIVED, github_ar, "notifications@github.com"),
            Some(SenderCheck::AlignedWithoutDmarc { via: "spf" })
        );

        // A provider in no list may leave a forged copy in place, even under its MX's own
        // name: nothing it hands over is believed (#35).
        let unknown = imap("me@firm.kz", "imap.mailhost.kz");
        let unknown_received: &[&str] = &[
            "from mx.github.com (mx.github.com [192.0.2.1]) by mx3.example-mail.kz with ESMTPS id 7; Mon, 5 Oct 2026 20:00:00 +0600",
        ];
        let unknown_ar = "Authentication-Results: mx3.example-mail.kz; dkim=pass header.i=@github.com; dmarc=pass header.from=github.com\r\n";
        assert!(matches!(
            check(&unknown, unknown_received, unknown_ar, "notifications@github.com"),
            Some(SenderCheck::NoOwnHeader { delivery: Some(d), .. }) if d == "example-mail.kz"
        ));
        assert!(matches!(
            check(&unknown, &[], unknown_ar, "notifications@github.com"),
            Some(SenderCheck::NoOwnHeader { delivery: None, .. })
        ));
    }

    #[test]
    fn a_header_below_the_providers_own_is_no_own_server() {
        let yandex = imap("user@yandex.ru", "imap.yandex.ru");
        let check = |received: &[&str], auth: &str, from: &str| {
            crate::message::authenticity(&letter_with(received, auth, from), &yandex).check
        };
        let our_word = || SenderCheck::NoOwnHeader {
            seen: vec!["evil.example".into()],
            receiver: yandex.domains.clone(),
            delivery: Some("yandex.net".into()),
        };
        let forged = "Authentication-Results: evil.example; dmarc=pass header.from=bank.ru\r\n";
        // A pass the sender wrote under a name of its own, below the provider's hop.
        assert_eq!(check(YANDEX_RECEIVED, forged, "security@bank.ru"), Some(our_word()));
        // The sender's own `Received` below the provider's names no delivery domain either.
        let mut chain = YANDEX_RECEIVED.to_vec();
        chain
            .push("from bank.ru (bank.ru [192.0.2.9]) by evil.example with ESMTP id 1; Mon, 5 Oct 2026 20:00:00 +0300");
        assert_eq!(check(&chain, forged, "security@bank.ru"), Some(our_word()));
        // The topmost hop is an address literal: the walk takes the provider's named MX next
        // and stops there, so the attacker's block further down is never reached.
        let mut chain = vec!["by [2001:db8::1] with SMTP id 0; Mon, 5 Oct 2026 20:00:00 +0300"];
        chain.extend_from_slice(YANDEX_RECEIVED);
        chain
            .push("from bank.ru (bank.ru [192.0.2.9]) by evil.example with ESMTP id 2; Mon, 5 Oct 2026 20:00:00 +0300");
        assert_eq!(check(&chain, forged, "security@bank.ru"), Some(our_word()));
        // No `Received` at all: the configured domains decide, as before.
        let own = "Authentication-Results: mx.yandex.ru; dmarc=pass header.from=bank.ru\r\n";
        assert_eq!(check(&[], own, "security@bank.ru"), Some(SenderCheck::Passed));
    }

    #[test]
    fn a_dotless_authserv_id_is_the_providers_own_mx() {
        let yandex = imap("user@yandex.ru", "imap.yandex.ru");
        let hops: Vec<String> = YANDEX_HOPS.iter().map(|h| (*h).to_owned()).collect();
        let delivery = delivery_hops(&hops).expect("the provider's hops");
        assert_eq!(delivery.domain, "yandex.net");
        assert_eq!(delivery.hosts.len(), 2, "{:?}", delivery.hosts);
        // `before`: how many `Received` headers stand above the verdict; 2 puts it below both.
        let letter = |before: usize, auth: &str, from: &str| {
            let mut raw = String::new();
            for (i, hop) in YANDEX_HOPS.iter().enumerate() {
                if i == before {
                    raw.push_str(auth);
                }
                raw.push_str("Received: ");
                raw.push_str(hop);
                raw.push_str("\r\n");
            }
            if before == YANDEX_HOPS.len() {
                raw.push_str(auth);
            }
            raw.push_str(&format!(
                "From: <{from}>\r\nTo: me@yandex.ru\r\nSubject: Hi\r\n\r\nText\r\n"
            ));
            raw.into_bytes()
        };
        let check = |before: usize, auth: &str, from: &str| {
            crate::message::authenticity(&letter(before, auth, from), &yandex).check
        };
        let github = "Authentication-Results: mail-nwsmtp-mxfront-production-main-60; spf=pass (mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net: domain of github.com designates 192.30.252.204 as permitted sender, rule=[ip4:192.30.252.0/22]) smtp.mail=noreply@github.com; dkim=pass header.i=@github.com\r\n";
        let alert = "Authentication-Results: mail-nwsmtp-mxfront-production-main-60; spf=pass (mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net: domain of bounces.google.com designates 192.30.252.204 as permitted sender, rule=[ip4:192.30.252.0/22]) smtp.mail=noreply@bounces.google.com; dkim=pass header.i=@accounts.google.com\r\n";
        // Wherever the verdict sits among the headers, the provider's own hops name its id.
        for before in 0..=2 {
            assert_eq!(
                check(before, github, "notifications@github.com"),
                Some(SenderCheck::AlignedWithoutDmarc { via: "spf" }),
                "{before}"
            );
            assert_eq!(
                check(before, alert, "no-reply@accounts.google.com"),
                Some(SenderCheck::AlignedWithoutDmarc { via: "dkim" }),
                "{before}"
            );
        }
        // A label of the provider's that took no hop of this letter is not its id.
        let other = github.replace("production-main-60", "production-main-61");
        assert!(matches!(
            check(1, &other, "notifications@github.com"),
            Some(SenderCheck::NoOwnHeader { delivery: Some(domain), .. }) if domain == "yandex.net"
        ));
        // The sender chooses its `from` host: only the `by` hosts of the provider carry its id.
        let entered = "Received: from mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net (mail-nwsmtp-mxfront-production-main-60.vla.yp-c.yandex.net [192.0.2.7]) by mail-nwsmtp-mxfront-production-main-59.vla.yp-c.yandex.net (smtp/Yandex) with ESMTPS id 9; Mon, 19 Oct 2026 10:00:00 +0300\r\n";
        let bank = "Authentication-Results: mail-nwsmtp-mxfront-production-main-60; dmarc=pass header.from=bank.ru\r\n";
        let raw = format!("{entered}{bank}From: <security@bank.ru>\r\nSubject: Hi\r\n\r\nText\r\n");
        assert!(!crate::message::authenticity(raw.as_bytes(), &yandex).verified());
        // The provider's own header stands above a forged copy of the same short id.
        let forged =
            "Authentication-Results: mail-nwsmtp-mxfront-production-main-60; dmarc=pass header.from=bank.ru\r\n";
        assert_eq!(
            check(0, &format!("{github}{forged}"), "security@bank.ru"),
            Some(SenderCheck::NotAlignedWithoutDmarc)
        );
        // No `Received`: a dotless id names nothing.
        let raw = format!("{bank}From: <security@bank.ru>\r\nSubject: Hi\r\n\r\nText\r\n");
        assert!(matches!(
            crate::message::authenticity(raw.as_bytes(), &yandex).check,
            Some(SenderCheck::NoOwnHeader { delivery: None, .. })
        ));
    }

    #[test]
    fn without_a_dmarc_result_an_aligned_dkim_or_spf_is_the_pass() {
        let yandex = imap("user@yandex.ru", "imap.yandex.ru").with_delivery(delivery("yandex.net"));
        let yx = |tail: &str| {
            format!(
                "mail-nwsmtp-mxfront-production-main-94.klg.yp-c.yandex.net; spf=pass (mail-nwsmtp-mxfront-production-main-94.klg.yp-c.yandex.net: domain of github.com designates 192.0.2.1 as permitted sender, rule=[ip4:192.0.2.0/24]) smtp.mail=notifications@github.com; dkim=pass header.i=@github.com{tail}"
            )
        };
        let check = |h: String, from: &str| check_sender(&[h], from, &yandex);
        // The real form of Yandex's own header.
        assert_eq!(
            check(yx(""), "github.com"),
            SenderCheck::AlignedWithoutDmarc { via: "spf" }
        );
        assert!(dmarc_passed(&[yx("")], "github.com", &yandex));
        // Both about a foreign domain.
        let evil = "mail-nwsmtp-mxfront-production-main-94.klg.yp-c.yandex.net; spf=pass smtp.mail=x@evil.example; dkim=pass header.i=@evil.example";
        assert_eq!(check(evil.into(), "github.com"), SenderCheck::NotAlignedWithoutDmarc);
        // A signature of the same organization is aligned (relaxed, #167); SPF stays exact.
        let sub = "mx.yandex.net; dkim=pass header.d=em.bank.ru";
        assert!(dmarc_passed(&[sub.into()], "bank.ru", &yandex));
        assert!(dmarc_passed(
            &["mx.yandex.net; dkim=pass header.i=@mail.github.com".into()],
            "github.com",
            &yandex
        ));
        assert!(!dmarc_passed(
            &["mx.yandex.net; dkim=pass header.d=bank.ru.evil.example".into()],
            "bank.ru",
            &yandex
        ));
        // Under a private suffix everyone rents a name: only the same name is aligned.
        assert!(!dmarc_passed(
            &["mx.yandex.net; dkim=pass header.d=evil.github.io".into()],
            "bank.github.io",
            &yandex
        ));
        assert!(!dmarc_passed(
            &["mx.yandex.net; spf=pass smtp.mailfrom=a@mail.github.com".into()],
            "github.com",
            &yandex
        ));
        assert!(dmarc_passed(
            &["mx.yandex.net; dkim=pass header.d=Bank.RU.".into()],
            "bank.ru",
            &yandex
        ));
        // SPF alone, and `header.d` before `header.i`.
        assert_eq!(
            check(
                "mx.yandex.net; spf=pass smtp.mailfrom=a@github.com; dkim=fail header.d=github.com".into(),
                "github.com"
            ),
            SenderCheck::AlignedWithoutDmarc { via: "spf" }
        );
        assert!(dmarc_passed(
            &["mx.yandex.net; dkim=pass header.d=github.com header.i=@evil.example".into()],
            "github.com",
            &yandex
        ));
        // Look-alike and a private suffix.
        assert!(!dmarc_passed(
            &["mx.yandex.net; dkim=pass header.i=@github.com".into()],
            "evilgithub.com",
            &yandex
        ));
        assert!(!dmarc_passed(
            &["mx.yandex.net; dkim=pass header.i=@a.github.io".into()],
            "b.github.io",
            &yandex
        ));
        // The exact name of the sender itself is its own, a private suffix or not.
        assert!(dmarc_passed(
            &["mx.yandex.net; dkim=pass header.i=@a.github.io".into()],
            "a.github.io",
            &yandex
        ));
        // Failed or soft-failed checks are no pass; a failed signature of the sender is a no.
        assert_eq!(
            check(
                "mx.yandex.net; dkim=fail header.i=@github.com; spf=softfail smtp.mail=a@github.com".into(),
                "github.com"
            ),
            SenderCheck::DkimFailed
        );
        assert_eq!(
            check(
                "mx.yandex.net; dkim=none; spf=softfail smtp.mail=a@github.com".into(),
                "github.com"
            ),
            SenderCheck::NoDmarc
        );
        // A dmarc result, when there is one, decides alone.
        for word in ["fail", "none", "temperror"] {
            let h = format!("{}; dmarc={word} header.from=github.com", yx(""));
            assert_eq!(check(h, "github.com"), SenderCheck::DmarcNot(word.into()));
        }
        // A pass written by the sender under another name, below ours, which says nothing.
        let ours = "mx.yandex.net; spf=none; dkim=none".to_owned();
        let foreign = "evil.example; dkim=pass header.i=@github.com".to_owned();
        assert!(!dmarc_passed(&[ours, foreign.clone()], "github.com", &yandex));
        assert!(!dmarc_passed(&[foreign], "github.com", &yandex));
    }

    #[test]
    fn a_quoted_value_cannot_write_a_result_of_its_own() {
        let yandex = imap("user@yandex.ru", "imap.yandex.ru").with_delivery(delivery("yandex.net"));
        for forged in [
            r#"mx.yandex.net; spf=pass smtp.mail="a;dkim=pass header.d=bank.ru x"@evil.example"#,
            r#"mx.yandex.net; spf=pass smtp.mail="a;dmarc=pass header.from=bank.ru x"@evil.example"#,
            r#"mx.yandex.net; dkim=pass header.i="x header.d=bank.ru y"@evil.example"#,
            r#"mx.yandex.net; dkim=pass header.i="x;dmarc=pass header.from=bank.ru"@evil.example"#,
        ] {
            assert!(!dmarc_passed(&[forged.into()], "bank.ru", &yandex), "{forged}");
        }
        // A quoted local part is still the address it is.
        assert!(dmarc_passed(
            &[r#"mx.yandex.net; spf=pass smtp.mail="a;b"@bank.ru"#.into()],
            "bank.ru",
            &yandex
        ));
    }

    #[test]
    fn a_comment_is_no_part_of_the_dkim_result() {
        let yandex = imap("user@yandex.ru", "imap.yandex.ru").with_delivery(delivery("yandex.net"));
        let h = "mx.yandex.net; dkim=pass (header.d=example.com) header.i=@evil.example";
        assert!(!dmarc_passed(&[h.into()], "example.com", &yandex));
    }

    #[test]
    fn an_explicit_dmarc_none_is_no_absence_of_dmarc() {
        let yandex = imap("user@yandex.ru", "imap.yandex.ru").with_delivery(delivery("yandex.net"));
        let h = "mx.yandex.net; dmarc=none header.from=github.com; dkim=pass header.d=github.com";
        assert_eq!(
            check_sender(&[h.into()], "github.com", &yandex),
            SenderCheck::DmarcNot("none".into())
        );
    }

    #[test]
    fn a_passed_signature_of_the_server_confirms_the_sender() {
        // 0.8.13, 2.1 Б: the server hashed the body of the letter on arrival; its word about the
        // signature is as much as its word about DMARC.
        let yandex = imap("user@yandex.ru", "imap.yandex.ru").with_delivery(delivery("yandex.net"));
        let dkim = check_sender(
            &["mx.yandex.net; dkim=pass header.d=bank.ru".into()],
            "bank.ru",
            &yandex,
        );
        assert_eq!(dkim, SenderCheck::AlignedWithoutDmarc { via: "dkim" });
        assert!(dkim.confirmed() && !dkim.no_verdict());
        let spf = check_sender(
            &["mx.yandex.net; spf=pass smtp.mailfrom=a@bank.ru; dkim=pass header.d=bank.ru".into()],
            "bank.ru",
            &yandex,
        );
        assert_eq!(spf, SenderCheck::AlignedWithoutDmarc { via: "spf" });
        assert!(spf.confirmed() && !spf.no_verdict());
        // A signature of another organization is not about the From: no confirmation.
        let raw = letter_with(
            YANDEX_RECEIVED,
            "Authentication-Results: mx.yandex.net; dkim=pass header.d=github.com\r\n",
            "notifications@github.com",
        );
        assert!(crate::message::authenticity(&raw, &yandex).verified());
        // A signature of a look-alike domain: not the From domain, no confirmation.
        let other = letter_with(
            YANDEX_RECEIVED,
            "Authentication-Results: mx.yandex.net; dkim=pass header.d=evilgithub.com\r\n",
            "notifications@github.com",
        );
        assert!(!crate::message::authenticity(&other, &yandex).verified());
    }

    #[test]
    fn any_own_server_without_dmarc_is_judged_by_dkim_and_spf() {
        // Any server of ours that writes dkim/spf but no `dmarc=`, in the form of the standard.
        let mailru = imap("user@mail.ru", "imap.mail.ru");
        let h = "mxs.mail.ru; spf=pass (mx1.m.smailru.net: domain of github.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=notifications@github.com; dkim=pass header.d=github.com header.s=pf2026";
        assert!(dmarc_passed(&[h.into()], "github.com", &mailru));
        assert!(!dmarc_passed(&[h.into()], "github.example", &mailru));
    }

    #[test]
    fn the_check_says_why() {
        // The letter's `Received` names Google's MX, whose name is not the box's.
        let gmail = imap("me@gmail.com", "imap.gmail.com").with_delivery(delivery("google.com"));
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
        assert_eq!(check(&one("mx.google.com; spf=none"), "bank.ru"), SenderCheck::NoDmarc);
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
        let SenderCheck::NoOwnHeader { seen, receiver, .. } = check(&foreign, "bank.ru") else {
            panic!("not ours");
        };
        assert_eq!(seen, ["mx.evil.example", "-"]);
        assert!(receiver.contains(&"gmail.com".to_owned()));
        assert!(matches!(check(&[], "bank.ru"), SenderCheck::NoOwnHeader { .. }));
        // The line for the log: domains and words, nothing of the letter.
        let line = check(&foreign, "bank.ru").to_string();
        assert!(line.contains("mx.evil.example") && line.contains("gmail.com"), "{line}");
        assert!(line.contains("delivery domain: google.com"), "{line}");
    }

    #[test]
    fn header_from_is_aligned_with_the_from_domain_by_organization() {
        let gmail = imap("me@gmail.com", "imap.gmail.com").with_delivery(delivery("google.com"));
        let one = |from: &str| vec![format!("mx.google.com; dmarc=pass header.from={from}")];
        // The operator's letter (#167): Gmail judged `openai.com` for From `email.openai.com`.
        assert_eq!(
            check_sender(&one("openai.com"), "email.openai.com", &gmail),
            SenderCheck::Passed
        );
        assert!(dmarc_passed(&one("mail.github.com"), "github.com", &gmail));
        assert_eq!(
            check_sender(&one("openai.com"), "openai.com.evil.example", &gmail),
            SenderCheck::NotAligned {
                header_from_domain: Some("openai.com".into()),
                from_domain: "openai.com.evil.example".into()
            }
        );
        assert!(!dmarc_passed(&one("evilopenai.com"), "openai.com", &gmail));
        // A public suffix is no organization: `co.uk` does not align `a.co.uk` and `b.co.uk`.
        assert!(!dmarc_passed(&one("a.co.uk"), "b.co.uk", &gmail));
        assert!(!dmarc_passed(&one("co.uk"), "b.co.uk", &gmail));
        assert!(!dmarc_passed(&one("evil.github.io"), "bank.github.io", &gmail));
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
        let SenderCheck::NoOwnHeader { seen, receiver, .. } = check_sender(&many, "bank.ru", &gmail) else {
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
        assert!(!oauth("me@firm.example").domains.contains(&"firm.example".to_owned()));
        assert!(oauth("me@firm.example").vouches);
    }

    #[test]
    fn the_topmost_header_of_ours_decides_even_without_a_dmarc_result() {
        let gmail_box = imap("me@gmail.com", "imap.gmail.com").with_delivery(delivery("google.com"));
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
        let r = imap("me@gmail.com", "imap.gmail.com");
        let one = |v: &str| vec![v.to_owned()];
        assert!(!dmarc_passed(
            &one("mx.google.com; dmarc=fail (policy said dmarc=pass) header.from=example.com"),
            "example.com",
            &r
        ));
        assert!(!dmarc_passed(
            &one("mx.google.com; spf=pass (dmarc=pass header.from=example.com) smtp.mailfrom=evil.example"),
            "example.com",
            &r
        ));
        assert!(dmarc_passed(
            &one("mx.google.com 1; dmarc = pass (p=reject) header.from=\"example.com\""),
            "example.com",
            &r
        ));
        // Without header.from the verdict may be about another domain: not counted.
        assert!(!dmarc_passed(&one("mx.google.com; dmarc=pass"), "example.com", &r));
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
        let yandex = imap("me@company.example", "imap.yandex.ru").with_delivery(delivery("yandex.net"));
        let ar = "mail-nwsmtp-mxfront-production-main-1.vla.yp-c.yandex.net; dmarc=pass header.from=bank.ru";
        assert!(dmarc_passed(&one(ar), "bank.ru", &yandex));
        assert!(!dmarc_passed(
            &one("mx.yandex.net.evil.example; dmarc=pass header.from=bank.ru"),
            "bank.ru",
            &yandex
        ));
        // A server of the mailbox's own domain is not the provider's, which strips no copy of it.
        assert!(!dmarc_passed(
            &one("mx.company.example; dmarc=pass header.from=bank.ru"),
            "bank.ru",
            &yandex
        ));
    }

    #[test]
    fn an_exchange_of_its_own_believes_no_authentication_results() {
        // Nobody strips a forged header on the way into the firm's own Exchange (#35): a name
        // under the firm's domain is anyone's to write.
        let on_prem = ews("me@contoso.example", "https://mail.contoso.example/EWS/Exchange.asmx");
        let forged = vec!["mx.contoso.example; dmarc=pass header.from=bank.ru".to_owned()];
        assert!(!dmarc_passed(&forged, "bank.ru", &on_prem));
        assert!(matches!(
            check_sender(&forged, "bank.ru", &on_prem),
            SenderCheck::NoOwnHeader { .. }
        ));
        let raw = letter_with(
            &[],
            "Authentication-Results: mx.contoso.example; dmarc=pass header.from=bank.ru\r\n",
            "security@bank.ru",
        );
        assert!(!crate::message::authenticity(&raw, &on_prem).dmarc);
    }

    #[test]
    fn a_server_of_the_firms_own_believes_no_authentication_results() {
        // Postfix and Dovecot without OpenDMARC hand over what came: a sender writes a pass under
        // the firm's name as easily (#35).
        let firm = imap("me@firm.example", "mail.firm.example");
        assert!(!firm.vouches);
        let forged = vec!["mail.firm.example; dmarc=pass header.from=bank.ru".to_owned()];
        assert!(!dmarc_passed(&forged, "bank.ru", &firm));
        assert!(check_sender(&forged, "bank.ru", &firm).no_verdict());
        let raw = letter_with(
            &["from mx.bank.ru by mail.firm.example with ESMTPS id 1; Mon"],
            "Authentication-Results: mail.firm.example; dmarc=pass header.from=bank.ru\r\n",
            "security@bank.ru",
        );
        assert!(!crate::message::authenticity(&raw, &firm).verified());
        // Exchange Online by IMAP is no Exchange Online by EWS.
        let m365_imap = imap("me@contoso.example", "outlook.office365.com");
        assert!(!m365_imap.vouches && !m365_imap.exchange_online);
    }

    #[test]
    fn every_exchange_online_of_microsoft_writes_its_own_verdict() {
        for url in [
            "https://outlook.office365.com/EWS/Exchange.asmx",
            "https://outlook.office.com/EWS/Exchange.asmx",
            "https://outlook.office365.us/EWS/Exchange.asmx",
            "https://partner.outlook.cn/EWS/Exchange.asmx",
        ] {
            let r = ews("me@contoso.example", url);
            assert!(r.exchange_online && r.vouches, "{url}");
        }
        assert!(
            !ews(
                "me@contoso.example",
                "https://outlook.contoso.example/EWS/Exchange.asmx"
            )
            .exchange_online
        );
    }

    #[test]
    fn a_failed_signature_of_the_senders_organization_is_the_servers_no() {
        let yandex = imap("user@yandex.ru", "imap.yandex.ru").with_delivery(delivery("yandex.net"));
        for word in ["fail", "permerror"] {
            for d in ["bank.ru", "em.bank.ru"] {
                let check = check_sender(
                    &[format!("mx.yandex.net; dkim={word} header.d={d}")],
                    "bank.ru",
                    &yandex,
                );
                assert!(!check.passed() && !check.no_verdict(), "{word} {d}: {check}");
            }
        }
        // A failed signature of someone else says nothing about the sender.
        let other = check_sender(
            &["mx.yandex.net; dkim=fail header.d=list.example".into()],
            "bank.ru",
            &yandex,
        );
        assert!(other.no_verdict(), "{other}");
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
