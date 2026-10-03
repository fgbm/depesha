//! Pictures for senders: brand logos published with BIMI (RFC draft
//! `draft-brand-indicators-for-message-identification`). Exchange's photos of
//! colleagues come from the mailbox's own server (`ews::user_photo`).

use std::time::Duration;

use base64::Engine;
use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use tokio::time::timeout;

/// A BIMI logo is SVG Tiny PS of at most 32 KB.
pub const MAX_LOGO: usize = 32 * 1024;
const STEP: Duration = Duration::from_secs(5);

/// The logo of a sender's domain as a `data:` URI, or `None` when the domain
/// publishes none or does not enforce DMARC (a logo then proves nothing).
/// The message itself must have passed DMARC: see [`dmarc_passed`].
pub async fn bimi_logo(domain: &str) -> Option<String> {
    let resolver = TokioResolver::builder_tokio().ok()?.build().ok()?;
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    let org = org_domain(&domain);

    let dmarc = match txt(&resolver, &format!("_dmarc.{domain}")).await {
        Some(t) => Some(t),
        None if org != domain => txt(&resolver, &format!("_dmarc.{org}")).await,
        None => None,
    };
    if !dmarc.as_deref().is_some_and(|d| dmarc_enforced(d, org != domain)) {
        return None;
    }

    let record = match txt(&resolver, &format!("default._bimi.{domain}")).await {
        Some(t) => Some(t),
        None if org != domain => txt(&resolver, &format!("default._bimi.{org}")).await,
        None => None,
    }?;
    let url = bimi_location(&record)?;
    let resp = timeout(
        STEP * 2,
        crate::http::request("GET", &url, &[("Accept", "image/svg+xml".into())], Vec::new()),
    )
    .await
    .ok()?
    .ok()?;
    if resp.status != 200 || resp.body.len() > MAX_LOGO || !is_svg(&resp.body) {
        return None;
    }
    Some(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&resp.body)
    ))
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

/// The receiving server checked DMARC and it passed for the From domain.
/// Only the topmost `Authentication-Results` counts: the ones below it came
/// with the message and could be written by anyone.
pub fn dmarc_passed(auth_results: Option<&str>, from_domain: &str) -> bool {
    let Some(ar) = auth_results else {
        return false;
    };
    let ar = ar.to_ascii_lowercase();
    let Some(at) = ar.find("dmarc=pass") else {
        return false;
    };
    // The header.from of the DMARC result, when given, must be the sender's.
    let rest = &ar[at..];
    let rest = &rest[..rest.find(';').unwrap_or(rest.len())];
    match rest.split_whitespace().find_map(|w| w.strip_prefix("header.from=")) {
        Some(d) => d
            .trim_matches(|c| c == '"' || c == ')')
            .eq_ignore_ascii_case(from_domain),
        None => true,
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

    #[test]
    fn trusts_only_a_passed_dmarc_for_the_sender() {
        let gmail = "mx.google.com; dkim=pass header.i=@ozon.ru; spf=pass; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=ozon.ru";
        assert!(dmarc_passed(Some(gmail), "ozon.ru"));
        assert!(!dmarc_passed(Some(gmail), "ozon-shop.ru"));
        let exo = "spf=pass smtp.mailfrom=bank.ru; dkim=pass header.d=bank.ru;dmarc=pass action=none header.from=bank.ru;compauth=pass";
        assert!(dmarc_passed(Some(exo), "bank.ru"));
        assert!(!dmarc_passed(
            Some("mx.example; dmarc=fail header.from=bank.ru"),
            "bank.ru"
        ));
        assert!(!dmarc_passed(None, "bank.ru"));
    }

    #[test]
    fn names_picture_types() {
        assert!(data_uri(b"\x89PNG\r\n").starts_with("data:image/png;base64,"));
        assert!(data_uri(b"\xff\xd8\xff").starts_with("data:image/jpeg;base64,"));
    }
}
