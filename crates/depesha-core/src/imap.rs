use std::fmt::Debug;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_imap::Client;
use async_imap::extensions::idle::IdleResponse;
use async_imap::types::{Flag, NameAttribute, UnsolicitedResponse};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::account::{Credentials, Security, ServerConfig};
pub use crate::query::Criterion;
use crate::tr;
use crate::{Error, Result, tls, utf7};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Exchange drops idle IMAP sessions after 30 minutes; RFC 2177 asks for at most 29.
pub const IDLE_RENEW: Duration = Duration::from_secs(25 * 60);

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Debug> Io for T {}

pub type Session = async_imap::Session<Box<dyn Io>>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caps {
    pub idle: bool,
    pub move_: bool,
    pub uidplus: bool,
    pub special_use: bool,
    #[serde(default)]
    pub literal_plus: bool,
}

/// An authenticated IMAP connection and what the server supports.
pub struct Conn {
    pub session: Session,
    pub caps: Caps,
}

pub async fn connect(server: &ServerConfig, creds: &Credentials) -> Result<Conn> {
    let client = open(server).await?;
    let mut session = match creds.xoauth2() {
        Some(initial) => {
            let detail = Arc::new(Mutex::new(None));
            let auth = XOAuth2 {
                initial: Some(initial),
                detail: detail.clone(),
            };
            client.authenticate("XOAUTH2", auth).await.map_err(|(err, _)| {
                let detail = detail.lock().unwrap_or_else(|e| e.into_inner()).take();
                match (login_error(err), detail) {
                    (Error::Auth(m), Some(d)) => Error::Auth(format!("{m} ({d})")),
                    (e, _) => e,
                }
            })?
        }
        None => client
            .login(&creds.username, creds.password())
            .await
            .map_err(|(err, _)| login_error(err))?,
    };

    let caps = session.capabilities().await.map_err(login_error)?;
    let caps = Caps {
        idle: caps.has_str("IDLE"),
        move_: caps.has_str("MOVE"),
        uidplus: caps.has_str("UIDPLUS"),
        special_use: caps.has_str("SPECIAL-USE"),
        literal_plus: caps.has_str("LITERAL+"),
    };
    Ok(Conn { session, caps })
}

/// Checks that an IMAP server answers on this address with the configured security, without logging in.
pub async fn probe(server: &ServerConfig) -> Result<()> {
    let mut client = open(server).await?;
    let _ = client.run_command_and_check_ok("LOGOUT", None).await;
    Ok(())
}

/// Connected and greeted (and secured, for STARTTLS), not yet logged in.
async fn open(server: &ServerConfig) -> Result<Client<Box<dyn Io>>> {
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect((server.host.as_str(), server.port)))
        .await
        .map_err(|_| Error::Timeout("connecting"))??;
    let pinned = server.trusted_cert.as_deref();

    let stream: Box<dyn Io> = match server.security {
        Security::Plain => Box::new(tcp),
        Security::Tls => Box::new(tls::wrap(&server.host, pinned, tcp).await?),
        Security::StartTls => {
            let mut client = Client::new(tcp);
            read_greeting(&mut client).await?;
            client
                .run_command_and_check_ok("STARTTLS", None)
                .await
                .map_err(|e| match e {
                    async_imap::error::Error::Bad(_) | async_imap::error::Error::No(_) => Error::NoTls,
                    other => other.into(),
                })?;
            Box::new(tls::wrap(&server.host, pinned, client.into_inner()).await?)
        }
    };

    let mut client = Client::new(stream);
    // There is no second greeting after STARTTLS.
    if server.security != Security::StartTls {
        read_greeting(&mut client).await?;
    }
    Ok(client)
}

/// SASL XOAUTH2. A refused token comes back as a continuation with a JSON error,
/// which the client must answer with an empty line before the server says NO.
struct XOAuth2 {
    initial: Option<String>,
    detail: Arc<Mutex<Option<String>>>,
}

impl async_imap::Authenticator for XOAuth2 {
    type Response = String;

    fn process(&mut self, challenge: &[u8]) -> String {
        match self.initial.take() {
            Some(initial) => initial,
            None => {
                *self.detail.lock().unwrap_or_else(|e| e.into_inner()) = xoauth2_error(challenge);
                String::new()
            }
        }
    }
}

/// `{"status":"401","schemes":"Bearer","scope":"https://mail.google.com/"}` -> `401`.
pub(crate) fn xoauth2_error(challenge: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(challenge).ok()?;
    let status = v.get("status")?;
    Some(match status {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    })
}

fn login_error(err: async_imap::error::Error) -> Error {
    use async_imap::error::Error as E;
    match err {
        // Exchange: the password is fine but the mailbox is not reachable over IMAP.
        E::Bad(msg) | E::No(msg) if msg.contains("authenticated but not connected") => Error::ImapUnavailable,
        // Exchange with LoginType SecureLogin answers plaintext LOGIN like this.
        // Dovecot says PRIVACYREQUIRED (RFC 5530) for the same reason.
        E::Bad(msg) | E::No(msg)
            if msg.contains("LOGINDISABLED") || msg.contains("Invalid state") || msg.contains("PRIVACYREQUIRED") =>
        {
            Error::NoTls
        }
        E::No(msg) | E::Bad(msg) => Error::Auth(server_text(&msg)),
        other => other.into(),
    }
}

/// async-imap renders NO/BAD as `code: None, info: Some("LOGIN failed.")`; keep only the server's words.
pub(crate) fn server_text(raw: &str) -> String {
    let Some(start) = raw.find("info: Some(\"") else {
        return raw.to_owned();
    };
    let rest = &raw[start + 12..];
    let end = rest.rfind("\")").unwrap_or(rest.len());
    rest[..end].replace("\\\"", "\"")
}

async fn read_greeting<T: Io>(client: &mut Client<T>) -> Result<()> {
    timeout(CONNECT_TIMEOUT, client.read_response())
        .await
        .map_err(|_| Error::Timeout("server greeting"))??
        .ok_or(Error::Closed)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
    /// Not in RFC 6154: where Depesha keeps snoozed mail until it is due.
    Snoozed,
}

impl FolderRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Sent => "sent",
            Self::Drafts => "drafts",
            Self::Trash => "trash",
            Self::Junk => "junk",
            Self::Archive => "archive",
            Self::Snoozed => "snoozed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "inbox" => Self::Inbox,
            "sent" => Self::Sent,
            "drafts" => Self::Drafts,
            "trash" => Self::Trash,
            "junk" => Self::Junk,
            "archive" => Self::Archive,
            "snoozed" => Self::Snoozed,
            _ => return None,
        })
    }

    /// Fallback for servers without SPECIAL-USE (RFC 6154), Exchange included.
    pub(crate) fn guess(leaf: &str) -> Option<Self> {
        Some(match leaf.to_lowercase().as_str() {
            "inbox" | "входящие" => Self::Inbox,
            "sent" | "sent items" | "sent messages" | "sent mail" | "отправленные" | "отправленные элементы" => {
                Self::Sent
            }
            "drafts" | "draft" | "черновики" => Self::Drafts,
            "trash"
            | "deleted"
            | "deleted items"
            | "deleted messages"
            | "корзина"
            | "удаленные"
            | "удалённые"
            | "удаленные элементы" => Self::Trash,
            "junk" | "spam" | "junk e-mail" | "junk email" | "спам" | "нежелательная почта" => {
                Self::Junk
            }
            "archive" | "archives" | "архив" => Self::Archive,
            "snoozed" | "отложенные" => Self::Snoozed,
            _ => return None,
        })
    }
}

/// Exchange shows calendars, contacts and other non-mail stores as IMAP folders.
pub(crate) fn is_non_mail(leaf: &str) -> bool {
    matches!(
        leaf.to_lowercase().as_str(),
        "calendar"
            | "календарь"
            | "contacts"
            | "контакты"
            | "tasks"
            | "задачи"
            | "notes"
            | "заметки"
            | "journal"
            | "журнал"
            | "sync issues"
            | "проблемы синхронизации"
            | "outbox"
            | "исходящие"
            | "rss feeds"
            | "rss-каналы"
            | "rss-подписки"
            | "conversation history"
            | "журнал бесед"
            | "conversation action settings"
            | "quick step settings"
            | "social activity notifications"
            | "yammer root"
            | "files"
            | "external contacts"
            | "personmetadata"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    /// Name as the server knows it (modified UTF-7); used in IMAP commands.
    pub name: String,
    pub display_name: String,
    pub delimiter: Option<String>,
    pub role: Option<FolderRole>,
    pub selectable: bool,
    /// Not a mail folder (Exchange calendar, contacts...): hidden and never synced.
    #[serde(default)]
    pub hidden: bool,
}

impl Folder {
    pub fn leaf(&self) -> &str {
        match self.delimiter.as_deref().filter(|d| !d.is_empty()) {
            Some(d) => self.display_name.rsplit(d).next().unwrap_or(&self.display_name),
            None => &self.display_name,
        }
    }
}

pub async fn list_folders(conn: &mut Conn) -> Result<Vec<Folder>> {
    let names: Vec<_> = conn.session.list(Some(""), Some("*")).await?.try_collect().await?;
    let mut folders: Vec<Folder> = names
        .iter()
        .map(|n| {
            let mut role = None;
            let mut selectable = true;
            for attr in n.attributes() {
                match attr {
                    NameAttribute::NoSelect => selectable = false,
                    NameAttribute::Sent => role = Some(FolderRole::Sent),
                    NameAttribute::Drafts => role = Some(FolderRole::Drafts),
                    NameAttribute::Trash => role = Some(FolderRole::Trash),
                    NameAttribute::Junk => role = Some(FolderRole::Junk),
                    NameAttribute::Archive => role = Some(FolderRole::Archive),
                    NameAttribute::Extension(ext) if ext.eq_ignore_ascii_case("\\NonExistent") => selectable = false,
                    _ => {}
                }
            }
            if n.name().eq_ignore_ascii_case("INBOX") {
                role = Some(FolderRole::Inbox);
            }
            Folder {
                name: n.name().to_owned(),
                display_name: utf7::decode(n.name()),
                delimiter: n.delimiter().map(str::to_owned),
                role,
                selectable,
                hidden: false,
            }
        })
        .collect();
    let from_server: Vec<bool> = folders.iter().map(|f| f.role.is_some()).collect();

    // Hide non-mail folders together with everything below them.
    let hidden_roots: Vec<(String, String)> = folders
        .iter()
        .filter(|f| f.role.is_none() && is_non_mail(f.leaf()))
        .map(|f| (f.name.clone(), f.delimiter.clone().unwrap_or_default()))
        .collect();
    for f in &mut folders {
        f.hidden = hidden_roots.iter().any(|(root, delim)| {
            f.name == *root || (!delim.is_empty() && f.name.starts_with(&format!("{root}{delim}")))
        });
    }

    // Name-based roles only for top-level or INBOX children, and one folder per role.
    for f in &mut folders {
        if f.role.is_none() && !f.hidden {
            let depth_ok = match f.delimiter.as_deref().filter(|d| !d.is_empty()) {
                Some(d) => {
                    let parts: Vec<&str> = f.name.split(d).collect();
                    parts.len() == 1
                        || (parts.len() == 2 && parts[0].eq_ignore_ascii_case("INBOX"))
                        || (parts.len() == 2 && parts[0].starts_with('['))
                }
                None => true,
            };
            if depth_ok {
                f.role = FolderRole::guess(f.leaf());
            }
        }
    }
    let mut seen = Vec::new();
    // SPECIAL-USE marks and INBOX win over name guesses: handle them first.
    let mut order: Vec<usize> = (0..folders.len()).collect();
    order.sort_by_key(|&i| !from_server[i]);
    for i in order {
        if let Some(role) = folders[i].role {
            if seen.contains(&role) {
                folders[i].role = None;
            } else {
                seen.push(role);
            }
        }
    }
    Ok(folders)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Flags {
    pub seen: bool,
    pub answered: bool,
    pub flagged: bool,
    pub draft: bool,
    pub deleted: bool,
}

impl Flags {
    pub(crate) fn from_imap<'a>(flags: impl Iterator<Item = Flag<'a>>) -> Self {
        let mut out = Self::default();
        for flag in flags {
            match flag {
                Flag::Seen => out.seen = true,
                Flag::Answered => out.answered = true,
                Flag::Flagged => out.flagged = true,
                Flag::Draft => out.draft = true,
                Flag::Deleted => out.deleted = true,
                _ => {}
            }
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "flag", content = "value", rename_all = "lowercase")]
pub enum FlagChange {
    Seen(bool),
    Flagged(bool),
    Answered(bool),
}

impl FlagChange {
    fn command(self) -> &'static str {
        match self {
            Self::Seen(true) => "+FLAGS.SILENT (\\Seen)",
            Self::Seen(false) => "-FLAGS.SILENT (\\Seen)",
            Self::Flagged(true) => "+FLAGS.SILENT (\\Flagged)",
            Self::Flagged(false) => "-FLAGS.SILENT (\\Flagged)",
            Self::Answered(true) => "+FLAGS.SILENT (\\Answered)",
            Self::Answered(false) => "-FLAGS.SILENT (\\Answered)",
        }
    }
}

pub async fn set_flag(conn: &mut Conn, folder: &str, uids: &[u32], change: FlagChange) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    conn.session.select(folder).await?;
    let _: Vec<_> = conn
        .session
        .uid_store(uid_set(uids), change.command())
        .await?
        .try_collect()
        .await?;
    Ok(())
}

/// Full RFC 822 source, without setting \Seen.
pub async fn fetch_raw(conn: &mut Conn, folder: &str, uid: u32) -> Result<Vec<u8>> {
    conn.session.examine(folder).await?;
    let fetches: Vec<_> = conn
        .session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
        .await?
        .try_collect()
        .await?;
    fetches
        .iter()
        .find(|f| f.uid == Some(uid))
        .and_then(|f| f.body())
        .map(<[u8]>::to_vec)
        .ok_or(Error::NotFound)
}

/// Moves messages. Without MOVE (RFC 6851): COPY, then \Deleted, then
/// UID EXPUNGE. Without UIDPLUS the originals keep \Deleted: a plain EXPUNGE
/// would also wipe messages another client marked deleted.
pub async fn move_messages(conn: &mut Conn, from: &str, uids: &[u32], to: &str) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    conn.session.select(from).await?;
    let set = uid_set(uids);
    if conn.caps.move_ {
        conn.session.uid_mv(&set, to).await?;
        return Ok(());
    }
    conn.session.uid_copy(&set, to).await?;
    remove(conn, &set).await
}

/// Removes messages for good. Used for the trash folder itself.
pub async fn delete_permanently(conn: &mut Conn, folder: &str, uids: &[u32]) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    conn.session.select(folder).await?;
    remove(conn, &uid_set(uids)).await
}

async fn remove(conn: &mut Conn, set: &str) -> Result<()> {
    let _: Vec<_> = conn
        .session
        .uid_store(set, "+FLAGS.SILENT (\\Deleted)")
        .await?
        .try_collect()
        .await?;
    if conn.caps.uidplus {
        let _: Vec<_> = conn.session.uid_expunge(set).await?.try_collect().await?;
    }
    Ok(())
}

pub async fn append(conn: &mut Conn, folder: &str, raw: &[u8], flags: &str) -> Result<()> {
    let flags = (!flags.is_empty()).then_some(flags);
    conn.session.append(folder, flags, None, raw).await?;
    Ok(())
}

/// UIDs of messages with this Message-ID in the folder.
pub async fn find_by_message_id(conn: &mut Conn, folder: &str, message_id: &str) -> Result<Vec<u32>> {
    conn.session.examine(folder).await?;
    let id = message_id.trim_matches(['<', '>']).replace(['"', '\\'], "");
    let uids = conn.session.uid_search(format!("HEADER Message-ID \"{id}\"")).await?;
    Ok(uids.into_iter().collect())
}

/// Next server response; async-imap keeps the response type private, hence a macro.
macro_rules! next_response {
    ($conn:expr) => {
        timeout(Duration::from_secs(120), $conn.session.read_response())
            .await
            .map_err(|_| Error::Timeout("search answer"))??
            .ok_or(Error::Closed)?
    };
}

/// Server-side search in one folder (IMAP `SEARCH TEXT`): subject, addresses and body,
/// including mail that is not in the local cache.
pub async fn search_text(conn: &mut Conn, folder: &str, text: &str) -> Result<Vec<u32>> {
    let text = text.trim().replace(['\r', '\n'], " ");
    if text.is_empty() {
        return Ok(Vec::new());
    }
    search(
        conn,
        folder,
        &[Criterion {
            key: "TEXT",
            value: Some(text),
        }],
    )
    .await
}

/// `UID SEARCH` with any keys. Non-ASCII values must travel as literals (RFC 3501):
/// inline with LITERAL+, otherwise each waits for the server's continuation.
pub async fn search(conn: &mut Conn, folder: &str, criteria: &[Criterion]) -> Result<Vec<u32>> {
    use async_imap::imap_proto::Response;
    use tokio::io::AsyncWriteExt;

    conn.session.examine(folder).await?;
    if criteria.is_empty() {
        return Ok(Vec::new());
    }
    let utf8 = criteria
        .iter()
        .any(|c| c.value.as_deref().is_some_and(|v| !v.is_ascii()));
    let mut line = String::from(if utf8 { "UID SEARCH CHARSET UTF-8" } else { "UID SEARCH" });
    // (text before a synchronizing literal, the literal) pairs; `line` is what follows the last one.
    let mut segments: Vec<(String, String)> = Vec::new();
    for c in criteria {
        line.push(' ');
        line.push_str(c.key);
        let Some(value) = &c.value else { continue };
        let value = value.replace(['\r', '\n'], " ");
        if value.is_ascii() {
            line.push_str(&format!(" \"{}\"", value.replace(['\\', '"'], "")));
        } else if conn.caps.literal_plus {
            line.push_str(&format!(" {{{}+}}\r\n{value}", value.len()));
        } else {
            line.push_str(&format!(" {{{}}}", value.len()));
            segments.push((std::mem::take(&mut line), value));
        }
    }
    if segments.is_empty() {
        let id = conn.session.run_command(line).await?;
        return read_search(conn, id).await;
    }

    let mut parts = segments.into_iter();
    let (first, mut literal) = parts.next().expect("one segment at least");
    let id = conn.session.run_command(first).await?;
    loop {
        // Wait for "+ go ahead" before every synchronizing literal.
        loop {
            let resp = next_response!(conn);
            match resp.parsed() {
                Response::Continue(_) => break,
                Response::Done { tag, outcome, .. } if *tag == id => {
                    return Err(search_refused(outcome.information.as_deref().unwrap_or_default()));
                }
                _ => {}
            }
        }
        let stream = conn.session.get_mut();
        stream.write_all(literal.as_bytes()).await?;
        match parts.next() {
            Some((text, next)) => {
                stream.write_all(text.as_bytes()).await?;
                stream.write_all(b"\r\n").await?;
                stream.flush().await?;
                literal = next;
            }
            None => {
                stream.write_all(line.as_bytes()).await?;
                stream.write_all(b"\r\n").await?;
                stream.flush().await?;
                break;
            }
        }
    }
    read_search(conn, id).await
}

/// Creates a folder; one that already exists is fine.
pub async fn create_folder(conn: &mut Conn, name: &str) -> Result<()> {
    match conn.session.create(utf7::encode(name)).await {
        Ok(()) => Ok(()),
        Err(async_imap::error::Error::No(m)) if m.to_ascii_lowercase().contains("exist") => Ok(()),
        Err(e) => Err(e.into()),
    }
}

async fn read_search(conn: &mut Conn, id: async_imap::imap_proto::RequestId) -> Result<Vec<u32>> {
    use async_imap::imap_proto::{MailboxDatum, Response, Status};
    let mut uids = Vec::new();
    loop {
        let resp = next_response!(conn);
        match resp.parsed() {
            Response::MailboxData(MailboxDatum::Search(found)) => uids.extend(found),
            Response::Done { tag, status, outcome } if *tag == id => {
                if *status == Status::Ok {
                    uids.sort_unstable();
                    uids.dedup();
                    return Ok(uids);
                }
                return Err(search_refused(outcome.information.as_deref().unwrap_or_default()));
            }
            _ => {}
        }
    }
}

fn search_refused(info: &str) -> Error {
    Error::Protocol(tr!(
        "the server could not search for non-Latin text (no CHARSET UTF-8 support): {info}",
        "сервер не выполнил поиск по-русски (нет поддержки CHARSET UTF-8): {info}"
    ))
}

pub enum IdleOutcome {
    /// Something changed in the selected folder.
    Changed,
    /// Nothing happened before the timeout; renew IDLE.
    Timeout,
}

/// Waits for changes in `folder` with IDLE, or polls it when IDLE is not supported.
/// Returns the connection back so it can be reused.
pub async fn wait_for_changes(mut conn: Conn, folder: &str, poll: Duration) -> Result<(Conn, IdleOutcome)> {
    conn.session.select(folder).await?;
    drain_unsolicited(&conn.session);
    if !conn.caps.idle {
        let before = conn.session.select(folder).await?.exists;
        tokio::time::sleep(poll).await;
        conn.session.noop().await?;
        let after = conn.session.select(folder).await?.exists;
        let changed = drain_unsolicited(&conn.session) || before != after;
        return Ok((
            conn,
            if changed {
                IdleOutcome::Changed
            } else {
                IdleOutcome::Timeout
            },
        ));
    }

    let caps = conn.caps;
    let mut handle = conn.session.idle();
    handle.init().await?;
    let (wait, _stop) = handle.wait_with_timeout(IDLE_RENEW);
    let response = wait.await?;
    let session = handle.done().await?;
    let outcome = match response {
        IdleResponse::NewData(_) => IdleOutcome::Changed,
        IdleResponse::Timeout | IdleResponse::ManualInterrupt => {
            if drain_unsolicited(&session) {
                IdleOutcome::Changed
            } else {
                IdleOutcome::Timeout
            }
        }
    };
    Ok((Conn { session, caps }, outcome))
}

/// Empties the unsolicited response queue; returns whether it had mailbox changes.
fn drain_unsolicited(session: &Session) -> bool {
    let mut changed = false;
    while let Ok(r) = session.unsolicited_responses.try_recv() {
        changed |= matches!(
            r,
            UnsolicitedResponse::Exists(_) | UnsolicitedResponse::Expunge(_) | UnsolicitedResponse::Recent(_)
        );
    }
    changed
}

/// Compresses UIDs into an IMAP set: `[1,2,3,7]` -> `1:3,7`.
pub fn uid_set(uids: &[u32]) -> String {
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut out = String::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        let mut end = start;
        while i + 1 < sorted.len() && sorted[i + 1] == end + 1 {
            i += 1;
            end = sorted[i];
        }
        if !out.is_empty() {
            out.push(',');
        }
        if start == end {
            out.push_str(&start.to_string());
        } else {
            out.push_str(&format!("{start}:{end}"));
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compresses_uid_sets() {
        assert_eq!(uid_set(&[7, 1, 2, 3, 3, 9, 10]), "1:3,7,9:10");
        assert_eq!(uid_set(&[5]), "5");
        assert_eq!(uid_set(&[]), "");
    }

    #[test]
    fn guesses_roles_by_name() {
        assert_eq!(FolderRole::guess("Отправленные"), Some(FolderRole::Sent));
        assert_eq!(FolderRole::guess("Deleted Items"), Some(FolderRole::Trash));
        assert_eq!(FolderRole::guess("Нежелательная почта"), Some(FolderRole::Junk));
        assert_eq!(FolderRole::guess("Работа"), None);
        assert!(is_non_mail("Календарь"));
        assert!(is_non_mail("Sync Issues"));
        assert!(!is_non_mail("Входящие"));
    }

    #[test]
    fn extracts_server_text() {
        assert_eq!(
            server_text(r#"code: None, info: Some("LOGIN failed. Invalid login/password for user id carol")"#),
            "LOGIN failed. Invalid login/password for user id carol"
        );
        assert_eq!(server_text("plain"), "plain");
    }

    #[test]
    fn leaf_uses_delimiter() {
        let f = Folder {
            name: "INBOX/Work".into(),
            display_name: "INBOX/Work".into(),
            delimiter: Some("/".into()),
            role: None,
            selectable: true,
            hidden: false,
        };
        assert_eq!(f.leaf(), "Work");
    }
}
