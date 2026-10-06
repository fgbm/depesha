//! The mailbox's room on the server: the quota it reports (QUOTA, RFC 9208 and RFC 2087)
//! and, asked for by the user, the size of each folder (STATUS=SIZE, RFC 8438, or the
//! sum of the messages' RFC822.SIZE).

use std::time::Duration;

use async_imap::imap_proto::Response;
use async_imap::imap_proto::rfc2087::QuotaResourceName;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

use crate::imap::{Conn, server_text};
use crate::{Error, Result};

/// A folder's size may take a while on a big mailbox; a server silent this long is gone.
const LINE_TIMEOUT: Duration = Duration::from_secs(120);

/// How full the mailbox is, by the quota root that limits INBOX.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quota {
    /// The root's name, `User quota` on Dovecot; may be empty.
    pub root: String,
    /// Bytes taken (STORAGE is counted in units of 1024 octets).
    pub used: u64,
    /// Bytes allowed; 0 when the root limits no storage.
    pub limit: u64,
    /// Messages, and how many are allowed, when the root limits them (MESSAGE).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<(u64, u64)>,
}

/// QUOTA answers of one GETQUOTAROOT.
#[derive(Debug, Default)]
struct Roots {
    names: Vec<String>,
    quotas: Vec<Quota>,
}

impl Roots {
    fn take(&mut self, resp: &Response<'_>) {
        match resp {
            Response::QuotaRoot(r) => self.names.extend(r.quota_root_names.iter().map(|n| n.to_string())),
            Response::Quota(q) => {
                let mut quota = Quota {
                    root: q.root_name.to_string(),
                    ..Quota::default()
                };
                for r in &q.resources {
                    match r.name {
                        QuotaResourceName::Storage => {
                            quota.used = r.usage.saturating_mul(1024);
                            quota.limit = r.limit.saturating_mul(1024);
                        }
                        QuotaResourceName::Message => quota.messages = Some((r.usage, r.limit)),
                        QuotaResourceName::Atom(_) => {}
                    }
                }
                self.quotas.push(quota);
            }
            _ => {}
        }
    }

    /// The root closest to its storage limit. A root shared by several folders is
    /// reported once: INBOX's roots are asked, not each folder's.
    fn tightest(self) -> Option<Quota> {
        let fill = |q: &Quota| {
            if q.limit == 0 {
                0.0
            } else {
                q.used as f64 / q.limit as f64
            }
        };
        let mut quotas: Vec<Quota> = self
            .quotas
            .into_iter()
            .filter(|q| self.names.is_empty() || self.names.contains(&q.root))
            .collect();
        quotas.sort_by(|a, b| fill(b).total_cmp(&fill(a)).then((b.limit > 0).cmp(&(a.limit > 0))));
        quotas.into_iter().next()
    }
}

/// The quota of INBOX's root (GETQUOTAROOT). `None` when the server names no root or
/// refuses: such a mailbox has no quota to show, which is not a full one.
pub async fn quota(conn: &mut Conn) -> Result<Option<Quota>> {
    use async_imap::imap_proto::Status;
    if !conn.caps.quota {
        return Ok(None);
    }
    let id = conn.session.run_command("GETQUOTAROOT INBOX").await?;
    let mut roots = Roots::default();
    loop {
        let resp = timeout(LINE_TIMEOUT, conn.session.read_response())
            .await
            .map_err(|_| Error::Timeout("quota"))??
            .ok_or(Error::Closed)?;
        match resp.parsed() {
            Response::Done { tag, status, .. } if *tag == id => {
                return Ok(match status {
                    Status::Ok => roots.tightest(),
                    _ => None,
                });
            }
            other => roots.take(other),
        }
    }
}

/// The size of one folder on the server, or why it could not be counted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderSize {
    pub folder: String,
    pub bytes: Option<u64>,
    pub messages: Option<u64>,
    /// The server's refusal (no rights, gone): the folder is left out, not counted as empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// How folder sizes are counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SizeMethod {
    /// One STATUS (SIZE) per folder: the server adds up.
    Status,
    /// RFC822.SIZE of every message, added up here: longer, the same result.
    Fetch,
}

impl SizeMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Fetch => "fetch",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "status" { Self::Status } else { Self::Fetch }
    }
}

/// Counts the size of `folders` (names as the server knows them), one after another;
/// `progress` hears how many are done. STATUS=SIZE is answered in a form the IMAP
/// library cannot read and would take for a broken connection, so this talks to the
/// server line by line itself: give it a connection of its own, to be dropped after.
pub async fn folder_sizes(
    conn: &mut Conn,
    folders: &[String],
    mut progress: impl FnMut(usize),
) -> Result<(SizeMethod, Vec<FolderSize>)> {
    let mut method = if conn.caps.status_size {
        SizeMethod::Status
    } else {
        SizeMethod::Fetch
    };
    let mut raw = Raw::new(conn);
    let mut out = Vec::with_capacity(folders.len());
    for (i, folder) in folders.iter().enumerate() {
        let size = match method {
            SizeMethod::Status => match raw.status_size(folder).await? {
                // The first STATUS (SIZE) is not understood (a server naming STATUS=SIZE
                // it gives only after ENABLE IMAP4rev2, say): every folder is counted the
                // long way.
                (_, true) if i == 0 => {
                    method = SizeMethod::Fetch;
                    raw.fetch_size(folder).await?
                }
                (size, _) => size,
            },
            SizeMethod::Fetch => raw.fetch_size(folder).await?,
        };
        out.push(size);
        progress(i + 1);
    }
    Ok((method, out))
}

/// Commands written and answers read as bytes, past the IMAP library.
struct Raw<'a> {
    conn: &'a mut Conn,
    buf: Vec<u8>,
    tag: u32,
}

/// What ended a command.
enum Done {
    Ok,
    /// NO: the server will not, for this mailbox.
    Refused(String),
    /// BAD: the server did not understand the command.
    Bad(String),
}

impl<'a> Raw<'a> {
    fn new(conn: &'a mut Conn) -> Self {
        Self {
            conn,
            buf: Vec::new(),
            tag: 0,
        }
    }

    /// Sends a command; `lines` sees each untagged answer up to the tagged one.
    async fn command(&mut self, command: &str, mut lines: impl FnMut(&[u8])) -> Result<Done> {
        self.tag += 1;
        let tag = format!("dz{}", self.tag);
        let stream = self.conn.session.get_mut();
        stream.write_all(format!("{tag} {command}\r\n").as_bytes()).await?;
        stream.flush().await?;
        loop {
            let line = self.line().await?;
            let Some(rest) = line.strip_prefix(format!("{tag} ").as_bytes()) else {
                lines(&line);
                continue;
            };
            let text = String::from_utf8_lossy(rest).into_owned();
            let (status, info) = text.split_once(' ').unwrap_or((text.as_str(), ""));
            return Ok(if status.eq_ignore_ascii_case("OK") {
                Done::Ok
            } else if status.eq_ignore_ascii_case("BAD") {
                Done::Bad(server_text(info.trim()))
            } else {
                Done::Refused(server_text(info.trim()))
            });
        }
    }

    /// One answer line without its CRLF; a literal inside it is taken in whole.
    async fn line(&mut self) -> Result<Vec<u8>> {
        let mut line = Vec::new();
        loop {
            let end = loop {
                if let Some(i) = self.buf.windows(2).position(|w| w == b"\r\n") {
                    break i;
                }
                self.fill().await?;
            };
            let part: Vec<u8> = self.buf.drain(..end + 2).take(end).collect();
            line.extend_from_slice(&part);
            let Some(n) = literal_size(&part) else {
                return Ok(line);
            };
            while self.buf.len() < n {
                self.fill().await?;
            }
            line.extend(self.buf.drain(..n));
        }
    }

    async fn fill(&mut self) -> Result<()> {
        let mut chunk = [0u8; 16 * 1024];
        let n = timeout(LINE_TIMEOUT, self.conn.session.get_mut().read(&mut chunk))
            .await
            .map_err(|_| Error::Timeout("folder size"))??;
        if n == 0 {
            return Err(Error::Closed);
        }
        self.buf.extend_from_slice(&chunk[..n]);
        Ok(())
    }

    /// The size, and whether the server answered BAD: it does not know STATUS (SIZE).
    async fn status_size(&mut self, folder: &str) -> Result<(FolderSize, bool)> {
        let mut size = FolderSize {
            folder: folder.to_owned(),
            ..FolderSize::default()
        };
        let done = self
            .command(&format!("STATUS {} (MESSAGES SIZE)", quoted(folder)), |line| {
                if let Some((bytes, messages)) = status_line(line) {
                    size.bytes = bytes.or(size.bytes);
                    size.messages = messages.or(size.messages);
                }
            })
            .await?;
        let bad = matches!(done, Done::Bad(_));
        if let Done::Refused(why) | Done::Bad(why) = done {
            size.error = Some(why);
        }
        Ok((size, bad))
    }

    async fn fetch_size(&mut self, folder: &str) -> Result<FolderSize> {
        let mut size = FolderSize {
            folder: folder.to_owned(),
            ..FolderSize::default()
        };
        let mut exists = 0u64;
        let done = self
            .command(&format!("EXAMINE {}", quoted(folder)), |line| {
                if let Some(n) = exists_line(line) {
                    exists = n;
                }
            })
            .await?;
        if let Done::Refused(why) | Done::Bad(why) = done {
            size.error = Some(why);
            return Ok(size);
        }
        let mut bytes = 0u64;
        let mut messages = 0u64;
        if exists > 0 {
            let done = self
                .command("FETCH 1:* (RFC822.SIZE)", |line| {
                    if let Some(n) = rfc822_size(line) {
                        bytes += n;
                        messages += 1;
                    }
                })
                .await?;
            if let Done::Refused(why) | Done::Bad(why) = done {
                size.error = Some(why);
                return Ok(size);
            }
        }
        size.bytes = Some(bytes);
        size.messages = Some(messages);
        Ok(size)
    }
}

/// A mailbox name as an IMAP quoted string.
fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `{123}` or `{123+}` at the end of a line: a literal of that many bytes follows.
fn literal_size(line: &[u8]) -> Option<usize> {
    let line = line.strip_suffix(b"}")?;
    let open = line.iter().rposition(|&b| b == b'{')?;
    let n = std::str::from_utf8(&line[open + 1..]).ok()?;
    n.trim_end_matches('+').parse().ok()
}

/// `* STATUS name (MESSAGES 4 SIZE 1234)`: the size and the message count named.
fn status_line(line: &[u8]) -> Option<(Option<u64>, Option<u64>)> {
    let text = std::str::from_utf8(line).ok()?;
    if !text.get(..9)?.eq_ignore_ascii_case("* STATUS ") {
        return None;
    }
    // The items close the line; a mailbox name may hold brackets of its own.
    let open = text.rfind('(')?;
    let close = text.rfind(')')?;
    let items: Vec<&str> = text.get(open + 1..close)?.split_whitespace().collect();
    let mut bytes = None;
    let mut messages = None;
    for pair in items.chunks(2) {
        if let [key, value] = pair {
            let value = value.parse().ok();
            if key.eq_ignore_ascii_case("SIZE") {
                bytes = value;
            } else if key.eq_ignore_ascii_case("MESSAGES") {
                messages = value;
            }
        }
    }
    Some((bytes, messages))
}

/// `* 12 EXISTS`.
fn exists_line(line: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(line).ok()?.strip_prefix("* ")?;
    let (n, word) = text.split_once(' ')?;
    word.trim().eq_ignore_ascii_case("EXISTS").then(|| n.parse().ok())?
}

/// `* 3 FETCH (RFC822.SIZE 5799845)`, the items in any order.
fn rfc822_size(line: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(line).ok()?;
    let upper = text.to_ascii_uppercase();
    if !upper.starts_with("* ") || !upper.contains(" FETCH ") {
        return None;
    }
    let at = upper.find("RFC822.SIZE ")? + "RFC822.SIZE ".len();
    let digits: String = text[at..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(lines: &[&[u8]]) -> Option<Quota> {
        let mut roots = Roots::default();
        for line in lines {
            let (_, resp) = Response::parse(line).unwrap();
            roots.take(&resp);
        }
        roots.tightest()
    }

    #[test]
    fn reads_the_quota_of_inbox() {
        let q = roots(&[
            b"* QUOTAROOT INBOX \"User quota\"\r\n",
            b"* QUOTA \"User quota\" (STORAGE 2097152 4194304 MESSAGE 1200 0)\r\n",
        ])
        .unwrap();
        assert_eq!(q.root, "User quota");
        // 2 GiB of 4: half full.
        assert_eq!(q.used, 2 * 1024 * 1024 * 1024);
        assert_eq!(q.limit, 4 * 1024 * 1024 * 1024);
        assert_eq!(q.messages, Some((1200, 0)));
    }

    #[test]
    fn the_tightest_root_wins_and_a_shared_one_counts_once() {
        let q = roots(&[
            b"* QUOTAROOT INBOX \"\" \"#shared\"\r\n",
            b"* QUOTA \"\" (STORAGE 10 100)\r\n",
            b"* QUOTA \"#shared\" (STORAGE 90 100)\r\n",
            // Not one of INBOX's roots: not this mailbox's room.
            b"* QUOTA \"other\" (STORAGE 100 100)\r\n",
        ])
        .unwrap();
        assert_eq!(q.root, "#shared");
        assert_eq!(q.used, 90 * 1024);
        // Without STORAGE a root limits nothing the section shows.
        let q = roots(&[b"* QUOTAROOT INBOX x\r\n", b"* QUOTA x (MESSAGE 5 100)\r\n"]).unwrap();
        assert_eq!((q.used, q.limit, q.messages), (0, 0, Some((5, 100))));
        assert_eq!(roots(&[b"* QUOTAROOT INBOX\r\n"]), None);
    }

    #[test]
    fn reads_folder_sizes_line_by_line() {
        assert_eq!(
            status_line(b"* STATUS \"Archive (2023)\" (MESSAGES 41 SIZE 14680064)"),
            Some((Some(14_680_064), Some(41)))
        );
        assert_eq!(status_line(b"* STATUS INBOX (SIZE 7)"), Some((Some(7), None)));
        assert_eq!(status_line(b"* 3 EXISTS"), None);
        assert_eq!(exists_line(b"* 12 EXISTS"), Some(12));
        assert_eq!(exists_line(b"* 0 RECENT"), None);
        assert_eq!(rfc822_size(b"* 3 FETCH (RFC822.SIZE 5799845)"), Some(5_799_845));
        assert_eq!(
            rfc822_size(b"* 4 FETCH (UID 9 RFC822.SIZE 12 FLAGS (\\Seen))"),
            Some(12)
        );
        assert_eq!(rfc822_size(b"* OK still here"), None);
        assert_eq!(literal_size(b"* STATUS {7}"), Some(7));
        assert_eq!(literal_size(b"* LIST () \"/\" {12+}"), Some(12));
        assert_eq!(literal_size(b"* OK done"), None);
        assert_eq!(quoted("Отчёты \"старые\""), "\"Отчёты \\\"старые\\\"\"");
    }
}
