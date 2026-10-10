//! Leaving a mailing list. One click (RFC 8058) is a single HTTPS POST, no page to
//! visit, no cookies, no redirects followed, the same certificate checks as mail and
//! only to the public internet. A request by mail is sent only as the user saw it.

use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use crate::message::Unsubscribe;
use crate::say::Say;
use crate::{Error, Result, http, tls};

const TIMEOUT: Duration = Duration::from_secs(20);
const BODY: &str = "List-Unsubscribe=One-Click";

/// A way to leave a list, as the user confirms it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Way {
    /// A POST to `host`.
    OneClick { host: String },
    /// A letter from the user's mailbox, exactly this one.
    Mail { to: String, subject: String, text: String },
    /// A page the user opens in the browser.
    Link { url: String },
}

/// The ways the sender offers, best first: one click, a letter, a page. Addresses that
/// cannot be used safely are left out: a private IP, a letter to several addresses or
/// with control characters.
pub fn ways(u: &Unsubscribe) -> Vec<Way> {
    let mut out = Vec::new();
    if let Some(url) = &u.one_click
        && let Ok((host, _, _)) = split_url(url)
        && !private_literal(&host)
    {
        out.push(Way::OneClick { host });
    }
    if let Some(Ok((to, subject, text))) = u.mailto.as_deref().map(mailto) {
        out.push(Way::Mail { to, subject, text });
    }
    if let Some(url) = &u.http
        && http::Url::parse(url).is_ok_and(|p| !private_literal(&p.host))
    {
        out.push(Way::Link { url: url.clone() });
    }
    out
}

/// Why none of the offered ways can be used, worded for the user.
pub fn no_way(u: &Unsubscribe) -> Error {
    if let Some(Err(e)) = u.mailto.as_deref().map(mailto) {
        return e;
    }
    Error::Said(Say::UnsubscribeNoSafeWay)
}

/// The letter to offer when one click did not work.
pub fn after_one_click(ways: &[Way]) -> Option<&Way> {
    ways.iter().find(|w| matches!(w, Way::Mail { .. }))
}

/// The address to unsubscribe at belongs to another organization than the sender's
/// (it may be the mailing service; the user should know before writing there).
pub fn foreign(to: &str, sender: &str) -> bool {
    let org = |a: &str| {
        a.rsplit_once('@')
            .map(|(_, d)| crate::avatar::org_domain(&d.to_ascii_lowercase()))
    };
    org(to) != org(sender)
}

fn private_literal(host: &str) -> bool {
    host.parse::<std::net::IpAddr>().is_ok_and(|ip| !http::is_public(ip))
}

/// `(host, port, path)` of an https URL.
fn split_url(url: &str) -> Result<(String, u16, String)> {
    let rest = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("HTTPS://"))
        .ok_or(Error::Said(Say::UnsubscribeHttpsOnly))?;
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) if rest[i..].starts_with('/') => (&rest[..i], rest[i..].to_owned()),
        Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
        None => (rest, "/".to_owned()),
    };
    let (host, port) = http::split_authority(authority, 443).ok_or_else(|| Error::InvalidHost(authority.into()))?;
    let path: String = path.chars().take_while(|c| !c.is_whitespace() && *c != '#').collect();
    Ok((host, port, path))
}

pub fn request(host: &str, path: &str) -> String {
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Depesha\r\n\
         Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
        BODY.len()
    )
}

/// Sends the unsubscribe POST. Ok when the sender's server answered 2xx or 3xx.
/// A host in a private network is refused before any connection.
pub async fn one_click(url: &str) -> Result<u16> {
    let (host, port, path) = split_url(url)?;
    let tcp = http::connect_public(&host, port).await?;
    let mut stream = tls::wrap(&host, None, tcp).await?;
    stream.write_all(request(&host, &path).as_bytes()).await?;
    stream.flush().await?;
    let mut line = String::new();
    timeout(TIMEOUT, BufReader::new(stream).read_line(&mut line))
        .await
        .map_err(|_| Error::Timeout("list server answer"))??;
    let status: u16 = line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| {
            Error::Said(Say::ListUnexpected {
                line: line.trim().to_owned(),
            })
        })?;
    if (200..400).contains(&status) {
        Ok(status)
    } else {
        Err(Error::Said(Say::ListRefused { status }))
    }
}

/// `mailto:` unsubscribe address with its `subject` and `body` parameters. Refused
/// unless it is one plain address, and the subject and text carry no control
/// characters (line breaks are allowed in the text): a header line smuggled in
/// through them would send the letter elsewhere.
pub fn mailto(url: &str) -> Result<(String, String, String)> {
    let bad = || {
        Error::Said(Say::UnsubscribeBadAddress {
            url: url.trim().to_owned(),
        })
    };
    let rest = url
        .trim()
        .strip_prefix("mailto:")
        .or_else(|| url.trim().strip_prefix("MAILTO:"))
        .ok_or_else(bad)?;
    let (addr, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut subject = "unsubscribe".to_owned();
    let mut body = "unsubscribe".to_owned();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let v = percent_decode(v);
            match k.to_ascii_lowercase().as_str() {
                "subject" if !v.is_empty() => subject = v,
                "body" if !v.is_empty() => body = v,
                _ => {}
            }
        }
    }
    let addr = percent_decode(addr);
    if !single_address(&addr) {
        return Err(bad());
    }
    if subject.chars().any(char::is_control) || body.chars().any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
    {
        return Err(Error::Said(Say::UnsubscribeControlChars));
    }
    Ok((addr, subject, body))
}

/// `local@domain` and nothing more: no list, no display name, no spaces or control characters.
fn single_address(addr: &str) -> bool {
    let Some((local, domain)) = addr.split_once('@') else {
        return false;
    };
    let local_ok = !local.is_empty()
        && !local
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "@,;:<>()[]\"\\".contains(c));
    let domain_ok = !domain.is_empty()
        && !domain.starts_with(['.', '-'])
        && !domain.ends_with(['.', '-'])
        && !domain.contains("..")
        && domain.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '.');
    local_ok && domain_ok
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_urls() {
        assert_eq!(
            split_url("https://Shop.example/u/1?t=a%20b").unwrap(),
            ("shop.example".into(), 443, "/u/1?t=a%20b".into())
        );
        assert_eq!(
            split_url("https://x.example:8443").unwrap(),
            ("x.example".into(), 8443, "/".into())
        );
        assert_eq!(split_url("https://x.example?id=1").unwrap().2, "/?id=1");
        assert_eq!(
            split_url("https://[::1]:8443/u").unwrap(),
            ("::1".into(), 8443, "/u".into())
        );
        assert!(split_url("http://x.example/u").is_err());
        assert!(split_url("https://user@evil.example/").is_err());
    }

    #[test]
    fn builds_the_rfc8058_request() {
        let r = request("shop.example", "/u/1");
        assert!(r.starts_with("POST /u/1 HTTP/1.1\r\nHost: shop.example\r\n"));
        assert!(r.ends_with("\r\n\r\nList-Unsubscribe=One-Click"));
        assert!(r.contains("Content-Length: 26\r\n"));
    }

    #[test]
    fn parses_mailto() {
        assert_eq!(
            mailto("mailto:unsub@shop.example?subject=stop%20it&body=x").unwrap(),
            ("unsub@shop.example".into(), "stop it".into(), "x".into())
        );
        assert_eq!(mailto("mailto:u@x.example").unwrap().1, "unsubscribe");
        assert_eq!(
            mailto("mailto:u@x.example?body=line%0D%0Aline").unwrap().2,
            "line\r\nline"
        );
        assert!(mailto("https://x").is_err());
    }

    #[test]
    fn refuses_a_mailto_that_writes_to_more_than_one_address() {
        for url in [
            "mailto:a@example.com,b@example.org",
            "mailto:a@example.com;b@example.org",
            "mailto:a%0D%0ABcc:x@example.org@example.com",
            "mailto:a@example.com%0D%0ABcc:x@example.org",
            "mailto:Name <a@example.com>",
            "mailto:@example.com",
            "mailto:a@",
            "mailto:a@exa mple.com",
            "mailto:unsub@example.com?subject=stop%0D%0ABcc:%20x@example.org",
            "mailto:unsub@example.com?body=x%00y",
        ] {
            assert!(mailto(url).is_err(), "{url}");
        }
    }

    #[test]
    fn offers_only_ways_safe_to_use() {
        let u = |one_click: Option<&str>, mailto: Option<&str>| Unsubscribe {
            mailto: mailto.map(str::to_owned),
            http: one_click.map(str::to_owned),
            one_click: one_click.map(str::to_owned),
        };
        // A private one-click address is not offered, nor is the same page.
        for url in [
            "https://127.0.0.1/",
            "https://10.0.0.1/",
            "https://192.168.1.1:8443/",
            "https://169.254.169.254/",
            "https://[::1]/",
            "https://[fd00::1]/",
            "https://100.64.0.1/",
        ] {
            let w = ways(&u(Some(url), Some("mailto:unsub@example.com")));
            assert_eq!(
                w,
                vec![Way::Mail {
                    to: "unsub@example.com".into(),
                    subject: "unsubscribe".into(),
                    text: "unsubscribe".into()
                }],
                "{url}"
            );
        }
        let w = ways(&u(
            Some("https://shop.example/u"),
            Some("mailto:a@x.example,b@y.example"),
        ));
        assert_eq!(
            w,
            vec![
                Way::OneClick {
                    host: "shop.example".into()
                },
                Way::Link {
                    url: "https://shop.example/u".into()
                }
            ]
        );
        let bad = u(None, Some("mailto:a@x.example,b@y.example"));
        assert!(ways(&bad).is_empty());
        assert!(no_way(&bad).to_string().contains("a@x.example,b@y.example"));
    }

    #[tokio::test]
    async fn falls_back_to_a_letter_when_one_click_leads_inside() {
        // A name, not a literal: only the lookup tells it is private, and nothing connects.
        let u = Unsubscribe {
            mailto: Some("mailto:unsub@example.com".into()),
            http: Some("https://localhost:9/u".into()),
            one_click: Some("https://localhost:9/u".into()),
        };
        let w = ways(&u);
        assert!(matches!(&w[0], Way::OneClick { host } if host == "localhost"));
        let e = one_click(u.one_click.as_deref().unwrap()).await.unwrap_err();
        assert!(matches!(e, Error::PrivateAddress(_)), "{e}");
        assert!(matches!(after_one_click(&w), Some(Way::Mail { to, .. }) if to == "unsub@example.com"));
    }

    #[test]
    fn notes_an_address_of_another_organization() {
        assert!(foreign("someone@example.org", "news@example.com"));
        assert!(!foreign("unsub@lists.example.com", "news@example.com"));
        assert!(!foreign("Unsub@Example.com", "news@example.com"));
    }
}
