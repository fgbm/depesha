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
        for host in [server.as_str(), address.as_str()] {
            let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
            // An IP address names no organization.
            if host.is_empty() || host.parse::<std::net::IpAddr>().is_ok() || !host.contains('.') {
                continue;
            }
            let Some(org) = registrable(&host) else {
                continue;
            };
            let family = FAMILIES.iter().find(|f| f.contains(&org.as_str()));
            for d in family.map_or_else(|| vec![org.clone()], |f| f.iter().map(|d| (*d).to_owned()).collect()) {
                if !domains.contains(&d) {
                    domains.push(d);
                }
            }
        }
        let exchange_online = account.is_ews()
            && ["office365.com", "outlook.com"]
                .contains(&registrable(&server.to_ascii_lowercase()).unwrap_or_default().as_str());
        Self {
            domains,
            exchange_online,
            exchange: account.is_ews(),
        }
    }

    fn owns(&self, authserv_id: &str) -> bool {
        let id = authserv_id.trim_end_matches('.').to_ascii_lowercase();
        id.contains('.') && registrable(&id).is_some_and(|d| self.domains.contains(&d))
    }
}

/// The DMARC verdict of one `Authentication-Results` header.
#[derive(Debug, PartialEq, Eq)]
struct Results {
    /// The server that wrote it; `None` in Exchange Online's format.
    authserv_id: Option<String>,
    /// `(passed, header.from)` of the `dmarc=` result, if there is one.
    dmarc: Option<(bool, Option<String>)>,
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
        Some((result == "pass", header_from))
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

/// The receiving server checked DMARC and it passed for the From domain.
/// `auth_results`: every `Authentication-Results`, topmost first. Only a header
/// written by the account's own server counts (others are skipped, wherever they
/// stand); the topmost of them decides, with or without a DMARC result. The verdict must name the
/// sender's domain in `header.from`: without it, it may be about another domain.
pub fn dmarc_passed(auth_results: &[String], from_domain: &str, receiver: &Receiver) -> bool {
    for (i, header) in auth_results.iter().enumerate() {
        let r = results(header);
        let ours = match &r.authserv_id {
            Some(id) => receiver.owns(id),
            None => receiver.exchange_online && i == 0,
        };
        if !ours {
            continue;
        }
        // The topmost header of ours decides alone: one without a DMARC result is a «no», not
        // a reason to read on, or a forged `dmarc=pass` under it would be believed (#108).
        return r.dmarc.is_some_and(|(passed, header_from)| {
            passed && header_from.is_some_and(|d| d.eq_ignore_ascii_case(from_domain))
        });
    }
    false
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
        // A box on a private suffix has no organization of its own to believe.
        let pages = imap("me@x.github.io", "imap.x.github.io");
        assert!(!dmarc_passed(&ar("mx.y.github.io"), "bank.ru", &pages));
        let gmail = imap("me@gmail.com", "imap.gmail.com");
        assert!(dmarc_passed(&ar("mx.google.com"), "bank.ru", &gmail));
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
