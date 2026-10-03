//! Exchange Web Services: on-premises Exchange that publishes only OWA and EWS,
//! without IMAP and SMTP. The cache stays the same as for IMAP: EWS item ids get
//! UIDs (`store::ews_*`), folders get IMAP-like names (`INBOX`, `INBOX/Работа`).

mod ops;
#[cfg(test)]
mod tests;

pub use ops::*;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use roxmltree::{Document, Node};

use crate::account::{Credentials, EwsConfig};
use crate::http::{Connection, Url};
use crate::lang::pick;
use crate::tr;
use crate::{Error, Result};

const SOAP_HEAD: &str = r#"<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">"#;

/// Exchange 2013 SP1 and later; older servers get the 2010 SP2 schema.
const VERSIONS: [&str; 2] = ["Exchange2013_SP1", "Exchange2010_SP2"];

/// An EWS connection with its login. Requests carry the login each time (Basic or
/// Bearer), so a broken connection is simply opened again.
pub struct Session {
    url: Url,
    pinned: Option<String>,
    authorization: String,
    /// Routes requests to the mailbox's server behind a load balancer.
    anchor: String,
    conn: Option<Connection>,
    version: usize,
}

impl Session {
    async fn conn(&mut self) -> Result<&mut Connection> {
        if self.conn.as_ref().is_none_or(Connection::is_closed) {
            self.conn = Some(Connection::open(&self.url, self.pinned.as_deref()).await?);
        }
        Ok(self.conn.as_mut().expect("opened above"))
    }

    fn headers(&self) -> Vec<(&'static str, String)> {
        vec![
            ("Content-Type", "text/xml; charset=utf-8".into()),
            ("Accept", "text/xml".into()),
            ("Authorization", self.authorization.clone()),
            ("X-AnchorMailbox", self.anchor.clone()),
        ]
    }

    fn envelope(&self, body: &str) -> Vec<u8> {
        format!(
            "{SOAP_HEAD}<soap:Header><t:RequestServerVersion Version=\"{}\"/></soap:Header><soap:Body>{body}</soap:Body></soap:Envelope>",
            VERSIONS[self.version]
        )
        .into_bytes()
    }

    /// Sends one SOAP request and returns the answer's XML.
    pub async fn call(&mut self, body: &str) -> Result<String> {
        loop {
            let envelope = self.envelope(body);
            let headers = self.headers();
            let path = self.url.path.clone();
            let resp = match self.conn().await?.send("POST", &path, &headers, envelope).await {
                Ok(r) => r,
                Err(e) => {
                    self.conn = None;
                    return Err(e);
                }
            };
            match resp.status {
                200 => return Ok(resp.text()),
                401 => return Err(unauthorized(&resp.header_all("WWW-Authenticate"))),
                // SOAP faults come with 500.
                500 => {
                    let text = resp.text();
                    let (code, message) = fault(&text);
                    if code == "ErrorInvalidServerVersion" && self.version + 1 < VERSIONS.len() {
                        self.version += 1;
                        continue;
                    }
                    return Err(Error::Ews { code, message });
                }
                s @ (502..=504) => {
                    return Err(Error::Io(std::io::Error::other(tr!(
                        "the Exchange server is temporarily unavailable (HTTP {s})",
                        "сервер Exchange временно недоступен (HTTP {s})"
                    ))));
                }
                s => {
                    return Err(Error::Protocol(tr!(
                        "EWS answered HTTP {s}; check the server address",
                        "EWS ответил HTTP {s}; проверьте адрес сервера"
                    )));
                }
            }
        }
    }

    /// Opens a separate connection for a long answer (streaming notifications);
    /// the connection must live as long as the stream is read.
    async fn stream(&mut self, body: &str) -> Result<(Connection, crate::http::Stream)> {
        let mut conn = Connection::open(&self.url, self.pinned.as_deref()).await?;
        let envelope = self.envelope(body);
        let headers = self.headers();
        let stream = conn.send_streaming("POST", &self.url.path, &headers, envelope).await?;
        Ok((conn, stream))
    }
}

/// Connects and checks the login with a cheap request (the inbox folder).
pub async fn connect(config: &EwsConfig, creds: &Credentials, email: &str) -> Result<Session> {
    let url = Url::parse(&config.url)?;
    let authorization = match creds.bearer() {
        Some(token) => format!("Bearer {token}"),
        None => {
            if !url.https && !is_local(&url.host) {
                return Err(Error::NoTls);
            }
            format!(
                "Basic {}",
                BASE64.encode(format!("{}:{}", creds.username, creds.password()))
            )
        }
    };
    let mut session = Session {
        url,
        pinned: config.trusted_cert.clone(),
        authorization,
        anchor: email.to_owned(),
        conn: None,
        version: 0,
    };
    let text = session
        .call(r#"<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder>"#)
        .await?;
    let doc = parse(&text)?;
    responses(&doc).into_iter().next().ok_or_else(no_answer)??;
    Ok(session)
}

fn is_local(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "::1"
}

/// 401: a wrong password, or Basic is not among the offered methods.
fn unauthorized(challenges: &[String]) -> Error {
    let schemes: Vec<String> = challenges
        .iter()
        .flat_map(|c| c.split(','))
        .filter_map(|c| c.split_whitespace().next())
        .filter(|s| !s.contains('='))
        .map(str::to_owned)
        .collect();
    let basic = schemes
        .iter()
        .any(|s| s.eq_ignore_ascii_case("Basic") || s.eq_ignore_ascii_case("Bearer"));
    if !schemes.is_empty() && !basic {
        let mut offered = schemes;
        offered.dedup();
        return Error::HttpAuth(offered.join(", "));
    }
    Error::Auth(
        pick(
            "wrong user name or password (on Exchange the login is often DOMAIN\\user)",
            "неверный логин или пароль (на Exchange логин часто ДОМЕН\\пользователь)",
        )
        .into(),
    )
}

fn no_answer() -> Error {
    Error::Protocol(pick("empty answer from EWS", "пустой ответ EWS").into())
}

pub(crate) fn parse(text: &str) -> Result<Document<'_>> {
    Document::parse(text).map_err(|e| Error::Protocol(format!("EWS XML: {e}")))
}

/// `faultcode`/`ResponseCode` and the message of a SOAP fault.
fn fault(text: &str) -> (String, String) {
    let Ok(doc) = Document::parse(text) else {
        return ("HTTP500".into(), text.chars().take(200).collect());
    };
    let root = doc.root_element();
    let code = desc(root, "ResponseCode")
        .and_then(|n| n.text())
        .or_else(|| desc(root, "faultcode").and_then(|n| n.text()))
        .unwrap_or("Fault")
        .trim()
        .trim_start_matches("a:")
        .to_owned();
    let message = desc(root, "Message")
        .and_then(|n| n.text())
        .or_else(|| desc(root, "faultstring").and_then(|n| n.text()))
        .unwrap_or_default()
        .trim()
        .to_owned();
    (code, message)
}

/// Every `*ResponseMessage` of the answer, an error for those that failed.
pub(crate) fn responses<'a, 'i>(doc: &'a Document<'i>) -> Vec<Result<Node<'a, 'i>>> {
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name().ends_with("ResponseMessage"))
        .map(|n| match n.attribute("ResponseClass") {
            Some("Error") => Err(Error::Ews {
                code: text(n, "ResponseCode").unwrap_or("Error").to_owned(),
                message: text(n, "MessageText").unwrap_or_default().to_owned(),
            }),
            _ => Ok(n),
        })
        .collect()
}

/// The only response message, or its error.
pub(crate) fn single<'a, 'i>(doc: &'a Document<'i>) -> Result<Node<'a, 'i>> {
    responses(doc).into_iter().next().ok_or_else(no_answer)?
}

pub(crate) fn child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name)
}

pub(crate) fn children<'a, 'i: 'a>(n: Node<'a, 'i>, name: &'a str) -> impl Iterator<Item = Node<'a, 'i>> + 'a {
    n.children()
        .filter(move |c| c.is_element() && c.tag_name().name() == name)
}

pub(crate) fn desc<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.descendants().find(|c| c.is_element() && c.tag_name().name() == name)
}

pub(crate) fn text<'a>(n: Node<'a, '_>, name: &str) -> Option<&'a str> {
    child(n, name).and_then(|c| c.text())
}

pub(crate) fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Control characters other than tab and newlines are not allowed in XML 1.0.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// What the user typed into the server field: a host, the OWA address or the EWS address.
pub fn url_from_server(server: &str) -> Option<String> {
    let s = server.trim().trim_end_matches('/');
    if s.is_empty() {
        return None;
    }
    let with_scheme = if s.contains("://") {
        s.to_owned()
    } else {
        format!("https://{s}")
    };
    let url = Url::parse(&with_scheme).ok()?;
    if url.path.to_ascii_lowercase().contains("/ews/") {
        return Some(url.to_string());
    }
    let base = Url {
        path: "/EWS/Exchange.asmx".into(),
        ..url
    };
    Some(base.to_string())
}

/// Where the EWS address came from.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EwsDetection {
    pub url: Option<String>,
    pub source: String,
    pub notes: Vec<String>,
}

/// Finds the EWS address: the server the user named, Autodiscover (with the login,
/// as Exchange requires), then the usual host names of OWA.
pub async fn discover(email: &str, creds: &Credentials, server: Option<&str>) -> EwsDetection {
    if let Some(url) = server.and_then(url_from_server) {
        return EwsDetection {
            url: Some(url),
            source: pick("the address you entered", "указанный адрес").into(),
            notes: Vec::new(),
        };
    }
    let Some(domain) = crate::account::domain_of(email).map(str::to_ascii_lowercase) else {
        return EwsDetection {
            notes: vec![tr!("the address has no domain", "адрес без домена")],
            ..Default::default()
        };
    };
    let mut notes = Vec::new();
    for host in [format!("autodiscover.{domain}"), domain.clone()] {
        match autodiscover(&host, email, creds).await {
            Ok(Some(url)) => {
                return EwsDetection {
                    url: Some(url),
                    source: format!("Autodiscover ({host})"),
                    notes,
                };
            }
            Ok(None) => {}
            Err(Error::Certificate(p)) => notes.push(format!("{host} — {}", p.reason)),
            Err(_) => {}
        }
    }
    // OWA hosts: a 401 on /EWS/ means the service is there.
    for host in [
        format!("mail.{domain}"),
        format!("owa.{domain}"),
        format!("exchange.{domain}"),
        format!("webmail.{domain}"),
    ] {
        let url = format!("https://{host}/EWS/Exchange.asmx");
        let probe = async {
            let parsed = Url::parse(&url)?;
            let mut conn = Connection::open(&parsed, None).await?;
            conn.send("GET", &parsed.path, &[], Vec::new()).await
        };
        match tokio::time::timeout(std::time::Duration::from_secs(8), probe).await {
            Ok(Ok(r)) if matches!(r.status, 200 | 401 | 405) => {
                return EwsDetection {
                    url: Some(url),
                    source: tr!("probing server names", "перебор адресов сервера"),
                    notes,
                };
            }
            // The server is there; the certificate question comes up when checking the login.
            Ok(Err(Error::Certificate(p))) => {
                notes.push(format!("{host} — {}", p.reason));
                return EwsDetection {
                    url: Some(url),
                    source: tr!("probing server names", "перебор адресов сервера"),
                    notes,
                };
            }
            _ => {}
        }
    }
    EwsDetection {
        url: None,
        source: String::new(),
        notes,
    }
}

/// POX Autodiscover (`autodiscover.xml`); follows one redirect.
async fn autodiscover(host: &str, email: &str, creds: &Credentials) -> Result<Option<String>> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>{}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>"#,
        escape(email)
    );
    let mut url = Url::parse(&format!("https://{host}/autodiscover/autodiscover.xml"))?;
    for _ in 0..2 {
        let headers = [
            ("Content-Type", "text/xml; charset=utf-8".to_owned()),
            (
                "Authorization",
                format!(
                    "Basic {}",
                    BASE64.encode(format!("{}:{}", creds.username, creds.password()))
                ),
            ),
        ];
        let fut = async {
            let mut conn = Connection::open(&url, None).await?;
            conn.send("POST", &url.path, &headers, body.clone().into_bytes()).await
        };
        let resp = tokio::time::timeout(std::time::Duration::from_secs(10), fut)
            .await
            .map_err(|_| Error::Timeout("connecting"))??;
        match resp.status {
            200 => return Ok(parse_autodiscover(&resp.text())),
            301 | 302 | 307 | 308 => {
                let Some(next) = resp.headers.get("Location").and_then(|v| v.to_str().ok()) else {
                    return Ok(None);
                };
                url = Url::parse(next)?;
                if !url.https {
                    return Ok(None);
                }
            }
            _ => return Ok(None),
        }
    }
    Ok(None)
}

/// EWS address from an Autodiscover answer; the external one (`EXPR`) first.
pub fn parse_autodiscover(xml: &str) -> Option<String> {
    let doc = Document::parse(xml).ok()?;
    let mut found: Vec<(String, String)> = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "Protocol")
        .filter_map(|p| Some((text(p, "Type")?.to_owned(), text(p, "EwsUrl")?.trim().to_owned())))
        .collect();
    found.sort_by_key(|(t, _)| match t.as_str() {
        "EXPR" => 0,
        "EXCH" => 1,
        _ => 2,
    });
    found.into_iter().map(|(_, u)| u).find(|u| u.starts_with("https://"))
}
