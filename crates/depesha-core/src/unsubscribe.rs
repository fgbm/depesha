//! One-click unsubscribe (RFC 8058): a single HTTPS POST, no page to visit, no
//! cookies, no redirects followed. Uses the same certificate checks as mail.

use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::{Error, Result, tls};

const TIMEOUT: Duration = Duration::from_secs(20);
const BODY: &str = "List-Unsubscribe=One-Click";

/// `(host, port, path)` of an https URL.
fn split_url(url: &str) -> Result<(String, u16, String)> {
    let rest = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("HTTPS://"))
        .ok_or_else(|| Error::Protocol("отписка в один клик возможна только по https".into()))?;
    let (authority, path) = match rest.find(['/', '?']) {
        Some(i) if rest[i..].starts_with('/') => (&rest[..i], rest[i..].to_owned()),
        Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
        None => (rest, "/".to_owned()),
    };
    if authority.contains('@') || authority.is_empty() {
        return Err(Error::InvalidHost(authority.into()));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().map_err(|_| Error::InvalidHost(authority.into()))?),
        None => (authority, 443),
    };
    let path: String = path.chars().take_while(|c| !c.is_whitespace() && *c != '#').collect();
    Ok((host.to_ascii_lowercase(), port, path))
}

pub fn request(host: &str, path: &str) -> String {
    format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Depesha\r\n\
         Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{BODY}",
        BODY.len()
    )
}

/// Sends the unsubscribe POST. Ok when the sender's server answered 2xx or 3xx.
pub async fn one_click(url: &str) -> Result<u16> {
    let (host, port, path) = split_url(url)?;
    let tcp = timeout(TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| Error::Timeout("подключение к серверу рассылки"))??;
    let mut stream = tls::wrap(&host, None, tcp).await?;
    stream.write_all(request(&host, &path).as_bytes()).await?;
    stream.flush().await?;
    let mut line = String::new();
    timeout(TIMEOUT, BufReader::new(stream).read_line(&mut line))
        .await
        .map_err(|_| Error::Timeout("ответ сервера рассылки"))??;
    let status: u16 = line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| Error::Protocol(format!("сервер рассылки ответил непонятно: {}", line.trim())))?;
    if (200..400).contains(&status) {
        Ok(status)
    } else {
        Err(Error::Protocol(format!(
            "сервер рассылки отказал в отписке: HTTP {status}"
        )))
    }
}

/// `mailto:` unsubscribe address with its `subject` and `body` parameters.
pub fn mailto(url: &str) -> Option<(String, String, String)> {
    let rest = url
        .trim()
        .strip_prefix("mailto:")
        .or_else(|| url.trim().strip_prefix("MAILTO:"))?;
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
    addr.contains('@').then_some((addr, subject, body))
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
        assert!(mailto("https://x").is_none());
    }
}
