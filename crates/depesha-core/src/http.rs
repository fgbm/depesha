//! A small HTTP/1.1 client over our own TLS stack, so certificate pinning works as
//! for IMAP and SMTP. One `Connection` is one TCP connection: NTLM authenticates
//! the connection, not the request, so the caller must control reuse.

use std::time::Duration;

use bytes::Bytes;
use http::HeaderMap;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::client::conn::http1::SendRequest;
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::imap::Io;
use crate::tr;
use crate::{Error, Result, tls};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
/// Largest response body read into memory: a big message as base64 MIME inside XML.
const MAX_BODY: usize = 256 * 1024 * 1024;

/// `https://host[:port]/path`; plain `http` only for local test servers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    pub https: bool,
    pub host: String,
    pub port: u16,
    /// Path with the query, starting with `/`.
    pub path: String,
}

impl Url {
    pub fn parse(s: &str) -> Result<Self> {
        let s = s.trim();
        let bad = || Error::InvalidHost(s.to_owned());
        let (https, rest) = if let Some(r) = s.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = s.strip_prefix("http://") {
            (false, r)
        } else {
            return Err(bad());
        };
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) if !h.ends_with(']') || p.parse::<u16>().is_ok() => (h, p.parse::<u16>().map_err(|_| bad())?),
            _ => (authority, if https { 443 } else { 80 }),
        };
        if host.is_empty() || host.contains(['@', ' ']) {
            return Err(bad());
        }
        Ok(Self {
            https,
            host: host.trim_matches(['[', ']']).to_ascii_lowercase(),
            port,
            path: path.to_owned(),
        })
    }

    fn authority(&self) -> String {
        match (self.https, self.port) {
            (true, 443) | (false, 80) => self.host.clone(),
            _ => format!("{}:{}", self.host, self.port),
        }
    }
}

impl std::fmt::Display for Url {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let scheme = if self.https { "https" } else { "http" };
        write!(f, "{scheme}://{}{}", self.authority(), self.path)
    }
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Response {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// Every value of a header, e.g. all `WWW-Authenticate` challenges.
    pub fn header_all(&self, name: &str) -> Vec<String> {
        self.headers
            .get_all(name)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(str::to_owned)
            .collect()
    }
}

pub struct Connection {
    sender: SendRequest<Full<Bytes>>,
    authority: String,
    /// DER of the server certificate, for NTLM channel binding (Extended Protection).
    pub peer_cert: Option<Vec<u8>>,
    task: JoinHandle<()>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Connection {
    pub async fn open(url: &Url, pinned: Option<&str>) -> Result<Self> {
        let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect((url.host.as_str(), url.port)))
            .await
            .map_err(|_| Error::Timeout("connecting"))??;
        let (stream, peer_cert): (Box<dyn Io>, _) = if url.https {
            let tls = tls::wrap(&url.host, pinned, tcp).await?;
            let cert = tls
                .get_ref()
                .1
                .peer_certificates()
                .and_then(|c| c.first())
                .map(|c| c.as_ref().to_vec());
            (Box::new(tls), cert)
        } else {
            (Box::new(tcp), None)
        };
        let (sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(http_error)?;
        // Errors of the connection surface on the next request.
        let task = tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(Self {
            sender,
            authority: url.authority(),
            peer_cert,
            task,
        })
    }

    /// The server closed the connection, or a previous request broke it.
    pub fn is_closed(&self) -> bool {
        self.sender.is_closed()
    }

    async fn start(
        &mut self,
        method: &str,
        path: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<hyper::Response<Incoming>> {
        let mut req = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header("Host", &self.authority)
            .header("User-Agent", concat!("Depesha/", env!("CARGO_PKG_VERSION")));
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let req = req
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| Error::Protocol(e.to_string()))?;
        self.sender.ready().await.map_err(http_error)?;
        self.sender.send_request(req).await.map_err(http_error)
    }

    /// Sends a request and reads the whole answer.
    pub async fn send(
        &mut self,
        method: &str,
        path: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<Response> {
        timeout(REQUEST_TIMEOUT, async {
            let resp = self.start(method, path, headers, body).await?;
            let (parts, body) = resp.into_parts();
            let body = Limited::new(body, MAX_BODY)
                .collect()
                .await
                .map_err(|e| match e.downcast::<hyper::Error>() {
                    Ok(e) => http_error(*e),
                    Err(e) => Error::Protocol(tr!("answer too large: {e}", "слишком большой ответ: {e}")),
                })?
                .to_bytes();
            Ok(Response {
                status: parts.status.as_u16(),
                headers: parts.headers,
                body,
            })
        })
        .await
        .map_err(|_| Error::Timeout("HTTP answer"))?
    }

    /// Sends a request and returns the body as a stream, for answers that last
    /// (EWS streaming notifications).
    pub async fn send_streaming(
        &mut self,
        method: &str,
        path: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<Stream> {
        let resp = timeout(REQUEST_TIMEOUT, self.start(method, path, headers, body))
            .await
            .map_err(|_| Error::Timeout("HTTP answer"))??;
        let (parts, body) = resp.into_parts();
        Ok(Stream {
            status: parts.status.as_u16(),
            body,
        })
    }
}

pub struct Stream {
    pub status: u16,
    body: Incoming,
}

impl Stream {
    /// Next piece of the body; `None` at its end.
    pub async fn next(&mut self) -> Result<Option<Bytes>> {
        loop {
            match self.body.frame().await {
                None => return Ok(None),
                Some(Err(e)) => return Err(http_error(e)),
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        return Ok(Some(data));
                    }
                }
            }
        }
    }
}

fn http_error(e: hyper::Error) -> Error {
    if e.is_incomplete_message() || e.is_closed() || e.is_canceled() {
        return Error::Closed;
    }
    if e.is_timeout() {
        return Error::Timeout("HTTP answer");
    }
    // An I/O error underneath keeps its kind, so network trouble stays transient.
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&e);
    while let Some(s) = source {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            return Error::Io(std::io::Error::new(io.kind(), io.to_string()));
        }
        source = s.source();
    }
    Error::Protocol(format!("HTTP: {e}"))
}

/// One request on a fresh connection: OAuth token endpoints and the like.
pub async fn request(method: &str, url: &str, headers: &[(&str, String)], body: Vec<u8>) -> Result<Response> {
    let url = Url::parse(url)?;
    let mut conn = Connection::open(&url, None).await?;
    conn.send(method, &url.path, headers, body).await
}

/// `application/x-www-form-urlencoded` body.
pub fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", percent(k), percent(v)))
        .collect::<Vec<_>>()
        .join("&")
        .into_bytes()
}

/// Percent-encodes everything except RFC 3986 unreserved characters.
pub fn percent(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Decodes `%XX` and `+` of a query string value.
pub fn unpercent(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                Some(b) => {
                    out.push(b);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Query parameters of a request target like `/cb?code=1&state=x`.
pub fn query_params(target: &str) -> Vec<(String, String)> {
    let Some((_, query)) = target.split_once('?') else {
        return Vec::new();
    };
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (unpercent(k), unpercent(v)),
            None => (unpercent(p), String::new()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls() {
        let u = Url::parse("https://Mail.Example.com/EWS/Exchange.asmx").unwrap();
        assert_eq!(
            (u.https, u.host.as_str(), u.port, u.path.as_str()),
            (true, "mail.example.com", 443, "/EWS/Exchange.asmx")
        );
        assert_eq!(u.to_string(), "https://mail.example.com/EWS/Exchange.asmx");
        let u = Url::parse("http://127.0.0.1:8080").unwrap();
        assert_eq!((u.https, u.port, u.path.as_str()), (false, 8080, "/"));
        assert_eq!(u.to_string(), "http://127.0.0.1:8080/");
        assert!(Url::parse("mail.example.com").is_err());
        assert!(Url::parse("https://:443/").is_err());
    }

    #[test]
    fn encodes_forms() {
        assert_eq!(percent("a b/ж"), "a%20b%2F%D0%B6");
        assert_eq!(form(&[("code", "4/0A"), ("x", "y")]), b"code=4%2F0A&x=y");
        assert_eq!(unpercent("a%20b+c%2F%D0%B6"), "a b c/ж");
        assert_eq!(unpercent("100%"), "100%");
        assert_eq!(
            query_params("/oauth/callback?code=4%2F0A&state=xyz&scope=a+b"),
            vec![
                ("code".to_owned(), "4/0A".to_owned()),
                ("state".to_owned(), "xyz".to_owned()),
                ("scope".to_owned(), "a b".to_owned())
            ]
        );
    }
}
