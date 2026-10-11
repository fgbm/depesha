use crate::best_effort;
use std::fmt::Debug;
use std::ops::RangeInclusive;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_imap::Client;
use async_imap::extensions::idle::IdleResponse;
use async_imap::imap_proto::{AttributeValue, Response};
use async_imap::types::{Flag, Mailbox, NameAttribute, UnsolicitedResponse};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::account::{Credentials, Security, ServerConfig};
use crate::acl::{LabelCheck, Namespace, PermanentFlags, Rights};
use crate::avatar::Receiver;
use crate::domain::{FlagChange, Flags, Folder, FolderRole, is_non_mail};
pub use crate::query::Criterion;
use crate::say::{Say, Xoauth2Detail};
use crate::watchdog::Watchdog;
use crate::{Error, Result, tls, utf7};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Exchange drops idle IMAP sessions after 30 minutes; RFC 2177 asks for at most 29.
pub const IDLE_RENEW: Duration = Duration::from_secs(25 * 60);
/// The first byte of an answer must come this soon after a command (`Watchdog`):
/// longer than a slow SEARCH or MOVE of many messages, far shorter than TCP's own hours.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(150);
/// Once an answer has started, it must not fall silent for longer than this: a link that
/// broke in the middle of a long `BODY.PEEK[]` or `UID FETCH` would otherwise wait forever.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(60);

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
    /// Mod-sequences (RFC 7162): only changed flags are fetched again.
    #[serde(default)]
    pub condstore: bool,
    /// Expunged UIDs reported as VANISHED (RFC 7162), once ENABLEd on a session.
    #[serde(default)]
    pub qresync: bool,
    /// How full the mailbox is (RFC 9208, RFC 2087): GETQUOTAROOT.
    #[serde(default)]
    pub quota: bool,
    /// A folder's size in one STATUS (RFC 8438).
    #[serde(default)]
    pub status_size: bool,
}

impl Caps {
    /// What Depesha uses out of a CAPABILITY list; names are compared ignoring case.
    /// IMAP4rev2 (RFC 9051) folds IDLE, MOVE, UIDPLUS, SPECIAL-USE and STATUS=SIZE into
    /// the base protocol (RFC 9051, 7.2.2 and Appendix E.2), so a server of that version
    /// has them without naming them. CONDSTORE and QRESYNC are not implied: they stay
    /// recommended extensions (Appendix F.1). A server listing IMAP4rev1 too speaks rev1
    /// until the client sends ENABLE IMAP4rev2 (RFC 9051, Appendix E), which Depesha
    /// does not, so only a rev2-only server gets the base set.
    pub fn from_names<S: AsRef<str>>(names: &[S]) -> Self {
        let has = |name: &str| names.iter().any(|n| n.as_ref().eq_ignore_ascii_case(name));
        let rev2 = has("IMAP4rev2") && !has("IMAP4rev1");
        Self {
            idle: rev2 || has("IDLE"),
            move_: rev2 || has("MOVE"),
            uidplus: rev2 || has("UIDPLUS"),
            special_use: rev2 || has("SPECIAL-USE"),
            literal_plus: has("LITERAL+"),
            // QRESYNC implies CONDSTORE (RFC 7162, 3.2).
            condstore: has("CONDSTORE") || has("QRESYNC"),
            qresync: has("QRESYNC"),
            quota: has("QUOTA"),
            status_size: rev2 || has("STATUS=SIZE"),
        }
    }
}

/// The answer to ENABLE QRESYNC on the session that syncs folders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Enabled {
    pub ok: bool,
    /// The server's words: `ENABLED QRESYNC`, or why it refused.
    pub answer: String,
}

/// An authenticated IMAP connection and what the server supports.
pub struct Conn {
    pub session: Session,
    pub caps: Caps,
    /// QRESYNC is enabled on this session: its expunges come as VANISHED, not EXPUNGE.
    /// Only a connection that syncs folders enables it; IDLE keeps plain EXPUNGE.
    pub qresync: bool,
    /// The CAPABILITY list after login, as the server named it.
    pub capabilities: Vec<String>,
    /// The greeting's line when it lists capabilities before login, as received.
    pub greeting: Option<String>,
    /// How ENABLE went on this session, until the cache takes it (`take`).
    pub enabled: Option<Enabled>,
    /// Set while this connection idles (`wait_for_changes`): the silence watchdog lets
    /// the server stay quiet then, since nothing was asked of it.
    pub idling: Arc<AtomicBool>,
    /// Whose `Authentication-Results` the headers it fetches are believed by (#108); set
    /// by `mail::connect`, empty (never vouches) on a connection made without an account.
    pub receiver: Receiver,
    /// The folder the last `wait_for_changes` left selected: the next wait on it skips the
    /// SELECT (it would hide a letter that came in the gap between two IDLEs). Only
    /// `wait_for_changes` sets and reads it, so a connection that selects other folders
    /// between waits is not meant to carry it.
    pub idle_folder: Option<String>,
    /// Set once an IDLE of this connection has started: it has worked, so a later break is
    /// the server's way (a limit on age or idleness), not a connection that fails at once.
    pub worked: Arc<AtomicBool>,
}

pub async fn connect(server: &ServerConfig, creds: &Credentials) -> Result<Conn> {
    let (client, greeting, idling) = open(server).await?;
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
                    (Error::Auth(m), Some(d)) => Error::Said(Say::AuthDetail { message: m, detail: d }),
                    (e, _) => e,
                }
            })?
        }
        None => client
            .login(&creds.username, creds.password())
            .await
            .map_err(|(err, _)| login_error(err))?,
    };

    let listed = session.capabilities().await.map_err(login_error)?;
    let capabilities = capability_names(listed.iter().map(|c| match c {
        async_imap::types::Capability::Imap4rev1 => "IMAP4rev1".to_owned(),
        async_imap::types::Capability::Auth(m) => format!("AUTH={m}"),
        async_imap::types::Capability::Atom(a) => a.clone(),
    }));
    Ok(Conn {
        session,
        caps: Caps::from_names(&capabilities),
        qresync: false,
        capabilities,
        greeting,
        enabled: None,
        idling,
        receiver: Receiver::default(),
        idle_folder: None,
        worked: Arc::new(AtomicBool::new(false)),
    })
}

/// A CAPABILITY list in a steady order (the library keeps it as a set): the protocol
/// versions first, then the rest by name.
pub(crate) fn capability_names(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut names: Vec<String> = names.collect();
    names.sort_by_cached_key(|n| (!n.to_ascii_uppercase().starts_with("IMAP4"), n.to_ascii_uppercase()));
    names.dedup();
    names
}

/// The greeting as a line, when it lists capabilities: `* OK [CAPABILITY ...] text`.
fn greeting_line(resp: &Response<'_>) -> Option<String> {
    use async_imap::imap_proto::{Capability, ResponseCode, Status};
    let Response::Data { status, outcome } = resp else {
        return None;
    };
    let Some(ResponseCode::Capabilities(caps)) = &outcome.code else {
        return None;
    };
    let information = &outcome.information;
    let status = match status {
        Status::PreAuth => "PREAUTH",
        Status::Bye => "BYE",
        _ => "OK",
    };
    let caps = capability_names(caps.iter().map(|c| match c {
        Capability::Imap4rev1 => "IMAP4rev1".to_owned(),
        Capability::Auth(m) => format!("AUTH={m}"),
        Capability::Atom(a) => a.to_string(),
    }));
    let text = information.as_deref().map(|i| format!(" {i}")).unwrap_or_default();
    Some(format!("* {status} [CAPABILITY {}]{text}", caps.join(" ")))
}

/// Checks that an IMAP server answers on this address with the configured security, without logging in.
pub async fn probe(server: &ServerConfig) -> Result<()> {
    let (mut client, _, _) = open(server).await?;
    best_effort("log out", client.run_command_and_check_ok("LOGOUT", None).await);
    Ok(())
}

/// Connected and greeted (and secured, for STARTTLS), not yet logged in; with the
/// greeting's line when it lists capabilities and the flag the silence watchdog reads.
async fn open(server: &ServerConfig) -> Result<(Client<Box<dyn Io>>, Option<String>, Arc<AtomicBool>)> {
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect((server.host.as_str(), server.port)))
        .await
        .map_err(|_| Error::Timeout("connecting"))??;
    crate::net::keepalive(&tcp);
    let pinned = server.trusted_cert.as_deref();
    let mut greeting = None;

    let stream: Box<dyn Io> = match server.security {
        Security::Plain => Box::new(tcp),
        Security::Tls => Box::new(tls::wrap(&server.host, pinned, tcp).await?),
        Security::StartTls => {
            let mut client = Client::new(tcp);
            greeting = read_greeting(&mut client).await?;
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

    let idling = Arc::new(AtomicBool::new(false));
    let stream: Box<dyn Io> = Box::new(Watchdog::new(stream, ANSWER_TIMEOUT, SILENCE_TIMEOUT, idling.clone()));
    let mut client = Client::new(stream);
    // There is no second greeting after STARTTLS.
    if server.security != Security::StartTls {
        greeting = read_greeting(&mut client).await?;
    }
    Ok((client, greeting, idling))
}

/// SASL XOAUTH2. A refused token comes back as a continuation with a JSON error,
/// which the client must answer with an empty line before the server says NO.
struct XOAuth2 {
    initial: Option<String>,
    detail: Arc<Mutex<Option<Xoauth2Detail>>>,
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

/// `{"status":"401","schemes":"Bearer","scope":"https://mail.google.com/"}` -> what to do, and the status.
/// Gmail answers 400 when the token lacks the mail scope (the user left Gmail unticked
/// on the consent page) and 401 when the token is expired or revoked.
pub(crate) fn xoauth2_error(challenge: &[u8]) -> Option<Xoauth2Detail> {
    let v: serde_json::Value = serde_json::from_slice(challenge).ok()?;
    let status = match v.get("status")? {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    Some(match status.as_str() {
        "400" => Xoauth2Detail::NoMailAccess(status),
        "401" => Xoauth2Detail::Expired(status),
        _ => Xoauth2Detail::Other(status),
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

async fn read_greeting<T: Io>(client: &mut Client<T>) -> Result<Option<String>> {
    let resp = timeout(CONNECT_TIMEOUT, client.read_response())
        .await
        .map_err(|_| Error::Timeout("server greeting"))??
        .ok_or(Error::Closed)?;
    Ok(greeting_line(resp.parsed()))
}

/// A LIST on a connection that died mid-way ends as an empty stream, not as an error, and
/// the cache would take the empty list for "every folder is gone" and wipe the account's
/// folders with all their letters. Every mailbox has an INBOX: a list without one is a
/// broken connection.
fn require_inbox(folders: &[Folder]) -> Result<()> {
    if folders.iter().any(|f| f.name.eq_ignore_ascii_case("INBOX")) {
        Ok(())
    } else {
        Err(Error::Imap(async_imap::error::Error::ConnectionLost))
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
    require_inbox(&folders)?;
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

pub(crate) fn flags_from_imap<'a>(flags: impl Iterator<Item = Flag<'a>>) -> Flags {
    let mut out = Flags::default();
    for flag in flags {
        match flag {
            Flag::Seen => out.seen = true,
            Flag::Answered => out.answered = true,
            Flag::Flagged => out.flagged = true,
            Flag::Draft => out.draft = true,
            Flag::Deleted => out.deleted = true,
            // A keyword by convention (RFC 5788 registry), spelled as each client likes.
            Flag::Custom(k) if k.eq_ignore_ascii_case(FORWARDED) => out.forwarded = true,
            _ => {}
        }
    }
    out
}

/// Next server response; async-imap keeps the response type private, hence a macro.
macro_rules! next_response {
    ($conn:expr) => {
        next_response!($conn, "search answer")
    };
    ($conn:expr, $what:expr) => {
        timeout(Duration::from_secs(120), $conn.session.read_response())
            .await
            .map_err(|_| Error::Timeout($what))??
            .ok_or(Error::Closed)?
    };
}

/// The keyword other clients set on a forwarded letter (Thunderbird, Apple Mail, Dovecot).
const FORWARDED: &str = "$Forwarded";

/// Whether a folder takes own keywords, and the standard flags it keeps, from the
/// `PERMANENTFLAGS` a SELECT reported (RFC 3501, 7.1).
pub fn permanent_flags(flags: &[Flag<'_>]) -> PermanentFlags {
    let mut may_create = false;
    let mut standard = Vec::new();
    for flag in flags {
        match flag {
            Flag::MayCreate => may_create = true,
            Flag::Seen => standard.push("Seen".to_owned()),
            Flag::Answered => standard.push("Answered".to_owned()),
            Flag::Flagged => standard.push("Flagged".to_owned()),
            Flag::Deleted => standard.push("Deleted".to_owned()),
            Flag::Draft => standard.push("Draft".to_owned()),
            Flag::Recent => standard.push("Recent".to_owned()),
            // A named keyword is a permanent flag too, but not a standard one.
            Flag::Custom(_) => {}
        }
    }
    standard.sort();
    standard.dedup();
    PermanentFlags { may_create, standard }
}

/// A message's own keywords as `FLAGS` reported them: the custom names, without the
/// system flags and without the convention keywords (`$Forwarded`, `$MDNSent`…).
pub fn keywords_of<'a>(flags: impl Iterator<Item = Flag<'a>>) -> Vec<String> {
    let mut out: Vec<String> = flags
        .filter_map(|f| match f {
            Flag::Custom(k) => {
                let k = k.to_string();
                (!k.starts_with('$')).then_some(k)
            }
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// A folder's props from one connection: MYRIGHTS (rights) and the PERMANENTFLAGS of a
/// SELECT (whether own labels can be stored). The owner is filled by the caller from the
/// account's namespaces. SELECT, not EXAMINE: only a read-write select reports the
/// PERMANENTFLAGS the server keeps; a read-only folder answers with none.
pub async fn folder_props(conn: &mut Conn, folder: &str) -> Result<(Option<Rights>, PermanentFlags)> {
    let mailbox = conn.session.select(folder).await?;
    let permanent = permanent_flags(&mailbox.permanent_flags);
    // MYRIGHTS only exists where ACL is offered; a server without it says nothing.
    let rights = myrights(conn, folder).await.unwrap_or(None);
    Ok((rights, permanent))
}

/// A mailbox name as an IMAP quoted string: `"` and `\` are escaped. Names arrive as
/// modified UTF-7 from the folder list, so they are already ASCII.
fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The folder's rights as the server reports them in MYRIGHTS (RFC 4314). `None` when
/// the server has no ACL extension or refused: nothing is known, which is not "no
/// rights". Read-only folders are the common case and this is where they are told.
pub async fn myrights(conn: &mut Conn, folder: &str) -> Result<Option<Rights>> {
    use async_imap::imap_proto::{Response, Status};
    let id = conn.session.run_command(format!("MYRIGHTS {}", quoted(folder))).await?;
    let mut rights = None;
    loop {
        let resp = next_response!(conn, "MYRIGHTS answer");
        match resp.parsed() {
            Response::MyRights(r) => {
                let letters: String = r.rights.iter().map(|&x| char::from(x)).collect();
                rights = Some(Rights::from_letters(&letters));
            }
            Response::Done { tag, status, .. } if *tag == id => {
                return match status {
                    Status::Ok => Ok(rights),
                    // No ACL extension or the folder is unreadable to us: unknown, not forbidden.
                    _ => Ok(None),
                };
            }
            _ => {}
        }
    }
}

/// Reads the server's NAMESPACE answer (RFC 2342). imap-proto does not parse this
/// response and would kill the connection on the untagged line, so the command is tagged
/// and its answer read from the raw stream, line by line. A malformed or refused answer
/// whose tagged line was reached is an empty namespace: the folders simply stay ungrouped.
/// A read error (a timeout, an over-long answer, a closed link) leaves the rest of the
/// answer unread and the session out of step, so it is passed on and the connection is
/// not used again.
pub async fn namespace(conn: &mut Conn) -> Result<Namespace> {
    let id = conn.session.run_command("NAMESPACE").await?;
    let tag = id.0.clone();
    let text = read_tagged(conn.session.get_mut(), &tag).await?;
    let line = text.lines().find(|l| l.starts_with("* NAMESPACE")).unwrap_or_default();
    Ok(Namespace::parse(line.trim_start_matches("* NAMESPACE").trim()))
}

/// Reads lines from `stream` until the one carrying `tag`, returning the text read on the
/// way (the untagged lines), and leaves everything after the tagged line unread. One byte
/// at a time on purpose: a chunked read could swallow the first bytes of the next answer,
/// which are then missing from the session's own buffer, and the session would desync.
/// One deadline covers the whole answer: a server that dribbles one byte at a time cannot
/// hold the session open forever.
async fn read_tagged(stream: &mut (impl AsyncRead + Unpin), tag: &str) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let deadline = tokio::time::Instant::now() + ANSWER_TIMEOUT;
    let tag = tag.as_bytes();
    let mut text = String::new();
    let mut line: Vec<u8> = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        match tokio::time::timeout_at(deadline, stream.read(&mut byte)).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => return Err(Error::Closed),
            Ok(Ok(_)) => {}
        }
        if byte[0] != b'\n' {
            line.push(byte[0]);
            if line.len() > 64 * 1024 {
                return Err(Error::Protocol("the server's answer is too long".into()));
            }
            continue;
        }
        let done = line.starts_with(tag) && line.get(tag.len()).is_none_or(|&c| c == b' ' || c == b'\r');
        let end = line.iter().position(|&c| c == b'\r').unwrap_or(line.len());
        text.push_str(&String::from_utf8_lossy(&line[..end]));
        text.push('\n');
        line.clear();
        if done {
            return Ok(text);
        }
        if text.len() > 64 * 1024 {
            return Err(Error::Protocol("the server's answer is too long".into()));
        }
    }
}

fn flag_command(change: FlagChange) -> &'static str {
    match change {
        FlagChange::Seen(true) => "+FLAGS.SILENT (\\Seen)",
        FlagChange::Seen(false) => "-FLAGS.SILENT (\\Seen)",
        FlagChange::Flagged(true) => "+FLAGS.SILENT (\\Flagged)",
        FlagChange::Flagged(false) => "-FLAGS.SILENT (\\Flagged)",
        FlagChange::Answered(true) | FlagChange::AnsweredAll(true) => "+FLAGS.SILENT (\\Answered)",
        FlagChange::Answered(false) | FlagChange::AnsweredAll(false) => "-FLAGS.SILENT (\\Answered)",
        FlagChange::Forwarded(true) => "+FLAGS.SILENT ($Forwarded)",
        FlagChange::Forwarded(false) => "-FLAGS.SILENT ($Forwarded)",
    }
}

/// Selects a folder to change messages by UID. `validity` is the UIDVALIDITY the UIDs
/// were read under, `None` for UIDs just found on the server: when the folder has a
/// different one now, the UIDs name other messages and nothing is changed.
async fn select_at(conn: &mut Conn, folder: &str, validity: Option<u32>) -> Result<()> {
    let mailbox = conn.session.select(folder).await?;
    match validity {
        Some(v) if mailbox.uid_validity.unwrap_or(0) != v => Err(Error::FolderChanged),
        _ => Ok(()),
    }
}

pub async fn set_flag(
    conn: &mut Conn,
    folder: &str,
    validity: Option<u32>,
    uids: &[u32],
    change: FlagChange,
) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    select_at(conn, folder, validity).await?;
    let _: Vec<_> = conn
        .session
        .uid_store(uid_set(uids), flag_command(change))
        .await?
        .try_collect()
        .await?;
    Ok(())
}

/// Sets (`add`) and clears (`remove`) own keywords (labels) on messages by UID. A keyword
/// is an atom; the caller passes the ones `acl::keyword_of` made.
pub async fn set_keywords(
    conn: &mut Conn,
    folder: &str,
    validity: Option<u32>,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> Result<()> {
    if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(());
    }
    select_at(conn, folder, validity).await?;
    let set = uid_set(uids);
    let keywords = |list: &[String]| list.join(" ");
    if !add.is_empty() {
        let _: Vec<_> = conn
            .session
            .uid_store(&set, format!("+FLAGS.SILENT ({})", keywords(add)))
            .await?
            .try_collect()
            .await?;
    }
    if !remove.is_empty() {
        let _: Vec<_> = conn
            .session
            .uid_store(&set, format!("-FLAGS.SILENT ({})", keywords(remove)))
            .await?
            .try_collect()
            .await?;
    }
    Ok(())
}

/// Takes a label's keyword off every message of `folder` (#42, frame 4Б): `UID SEARCH
/// KEYWORD` finds the messages, `UID STORE -FLAGS` clears the keyword. Nothing is expunged.
/// Returns how many messages carried it.
pub async fn strip_keyword(conn: &mut Conn, folder: &str, keyword: &str) -> Result<usize> {
    conn.session.examine(folder).await?;
    let uids = uid_search(conn, &format!("KEYWORD {keyword}")).await?;
    if uids.is_empty() {
        return Ok(0);
    }
    conn.session.select(folder).await?;
    let _: Vec<_> = conn
        .session
        .uid_store(uid_set(&uids), format!("-FLAGS.SILENT ({keyword})"))
        .await?
        .try_collect()
        .await?;
    Ok(uids.len())
}

/// The own keywords of one message, as `FLAGS` reports them (`acl::keywords_of`).
pub async fn fetch_keywords(conn: &mut Conn, folder: &str, uid: u32) -> Result<Vec<String>> {
    conn.session.examine(folder).await?;
    let fetches: Vec<_> = conn
        .session
        .uid_fetch(uid.to_string(), "(UID FLAGS)")
        .await?
        .try_collect()
        .await?;
    Ok(fetches
        .iter()
        .find(|f| f.uid == Some(uid))
        .map(|f| keywords_of(f.flags()))
        .unwrap_or_default())
}

/// Checks own labels on a test message (#42, frame 9): appends a test letter to `folder`,
/// stores `keyword` on it, reads it back through a fresh SELECT, and removes both again.
/// The test letter is deleted on every path, a failure included. Returns what the server
/// did with the label, told apart by whether `PERMANENTFLAGS` promised `\*` (RFC 3501).
///
/// `message_id` is the Message-ID of the test letter, so a caller can look it up if the
/// run is interrupted before the delete; `subject` is what the letter says.
pub async fn check_labels(
    conn: &mut Conn,
    folder: &str,
    keyword: &str,
    message_id: &str,
    subject: &str,
) -> Result<LabelCheck> {
    // A letter an interrupted run left behind goes first, before a new one is added.
    best_effort(
        "remove the test letters an interrupted run left",
        cleanup_test_messages(conn, folder).await,
    );
    // Without UIDPLUS the test letter cannot be expunged by UID: it would stay marked
    // \Deleted until the whole folder is cleaned. Depesha does not check there, and says
    // so instead of leaving something behind.
    if !conn.caps.uidplus {
        return Err(Error::LabelCheckUnsupported);
    }
    let raw = format!(
        "From: Depesha <noreply@depesha.local>\r\nTo: noreply@depesha.local\r\nSubject: {subject}\r\n\
         Message-ID: <{message_id}>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{subject}\r\n"
    );
    // APPEND with \Seen, so the test letter does not show unread on the user's phone. The
    // UID comes from APPENDUID; when the server does not name it, the letter is found by
    // its exact Message-ID, with retries for a search index that lags behind APPEND.
    let uid = match append_uid(conn, folder, raw.as_bytes(), "\\Seen").await? {
        Some(uid) => uid,
        None => match find_after_append(conn, folder, message_id).await? {
            Some(uid) => uid,
            // Appended but not found: nothing to check. The next run's cleanup takes it.
            None => return Ok(LabelCheck::NotSaves),
        },
    };
    // From here the test letter must go away whatever happens.
    let outcome = labels_round(conn, folder, uid, keyword).await;
    best_effort("remove the test letter", remove_uids(conn, folder, &[uid]).await);
    outcome
}

/// Finds a just-appended letter by its exact Message-ID, retrying a few times with a
/// growing pause: a server's search index (Yandex, some Exchange setups) may lag.
async fn find_after_append(conn: &mut Conn, folder: &str, message_id: &str) -> Result<Option<u32>> {
    for attempt in 0..5 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(300 * attempt)).await;
        }
        if let Some(&uid) = find_by_message_id(conn, folder, message_id).await?.first() {
            return Ok(Some(uid));
        }
    }
    Ok(None)
}

/// UIDs of Depesha's label-check test letters left in the folder
/// (`depesha-test-*@depesha.local`), from an interrupted check.
pub async fn find_test_messages(conn: &mut Conn, folder: &str) -> Result<Vec<u32>> {
    conn.session.examine(folder).await?;
    let uids = uid_search(conn, "HEADER Message-ID \"depesha-test-\"").await?;
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let fetches: Vec<_> = conn
        .session
        .uid_fetch(uid_set(&uids), "(UID FLAGS BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
        .await?
        .try_collect()
        .await?;
    Ok(fetches
        .iter()
        .filter(|f| {
            f.header()
                .and_then(message_id_of)
                .is_some_and(|id| is_test_message_id(&id))
        })
        .filter_map(|f| f.uid)
        .collect())
}

/// Removes the test letters an interrupted check left behind; returns how many.
pub async fn cleanup_test_messages(conn: &mut Conn, folder: &str) -> Result<usize> {
    let uids = find_test_messages(conn, folder).await?;
    if uids.is_empty() {
        return Ok(0);
    }
    remove_uids(conn, folder, &uids).await?;
    Ok(uids.len())
}

/// Whether a Message-ID is one of the label-check test letters.
fn is_test_message_id(id: &str) -> bool {
    id.starts_with("depesha-test-") && id.ends_with("@depesha.local")
}

async fn labels_round(conn: &mut Conn, folder: &str, uid: u32, keyword: &str) -> Result<LabelCheck> {
    // The server promised `\*` in this folder: whether a lost label is "claimed but lost".
    let promised = conn
        .session
        .select(folder)
        .await
        .map(|m| permanent_flags(&m.permanent_flags).labels_on_server())
        .unwrap_or(false);
    // Store the label, then read it back the plain way: a fresh FETCH of the flags.
    let set = uid.to_string();
    let _: Vec<_> = conn
        .session
        .uid_store(&set, format!("+FLAGS.SILENT ({keyword})"))
        .await?
        .try_collect()
        .await?;
    conn.session.select(folder).await?;
    let fetches: Vec<_> = conn.session.uid_fetch(&set, "(UID FLAGS)").await?.try_collect().await?;
    let kept = fetches
        .iter()
        .filter(|f| f.uid == Some(uid))
        .any(|f| keywords_of(f.flags()).iter().any(|k| k == keyword));
    Ok(if kept {
        LabelCheck::Saves
    } else if promised {
        LabelCheck::ClaimedButLost
    } else {
        LabelCheck::NotSaves
    })
}

/// Removes messages for good, tolerating their absence (the check's test letter). A folder that
/// cannot be selected ends it there: `STORE` and `EXPUNGE` would reach whatever folder is
/// selected, and take its letters under these UIDs.
async fn remove_uids(conn: &mut Conn, folder: &str, uids: &[u32]) -> Result<()> {
    conn.session.select(folder).await?;
    let set = uid_set(uids);
    let _: Vec<_> = conn
        .session
        .uid_store(&set, "+FLAGS.SILENT (\\Deleted)")
        .await?
        .try_collect()
        .await?;
    if conn.caps.uidplus {
        let _: Vec<_> = conn.session.uid_expunge(set).await?.try_collect().await?;
    }
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

/// Several whole messages of a folder in one FETCH; PEEK leaves them unread.
/// Messages gone from the server are simply missing from the answer.
pub async fn fetch_raw_many(conn: &mut Conn, folder: &str, uids: &[u32]) -> Result<Vec<(u32, Vec<u8>)>> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    conn.session.examine(folder).await?;
    let fetches: Vec<_> = conn
        .session
        .uid_fetch(uid_set(uids), "(UID BODY.PEEK[])")
        .await?
        .try_collect()
        .await?;
    Ok(fetches
        .iter()
        .filter_map(|f| Some((f.uid?, f.body()?.to_vec())))
        .collect())
}

/// Moves messages. Without MOVE (RFC 6851): COPY, then \Deleted, then
/// UID EXPUNGE. Without UIDPLUS: a plain EXPUNGE that spares what another client marked
/// deleted (see `remove`).
pub async fn move_messages(conn: &mut Conn, from: &str, validity: Option<u32>, uids: &[u32], to: &str) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    select_at(conn, from, validity).await?;
    let set = uid_set(uids);
    if conn.caps.move_ {
        conn.session.uid_mv(&set, to).await?;
        return Ok(());
    }
    conn.session.uid_copy(&set, to).await?;
    remove(conn, &set).await
}

/// Finishes a move that was cut short before MOVE was available. Without MOVE a move is
/// `COPY` then `\Deleted`: a connection that dropped after the COPY and before the
/// removal would copy the letters a second time if the move were run again. Letters whose
/// Message-ID and size already reached the target are not copied again, the rest are, and every
/// original is marked deleted.
pub async fn resume_move(conn: &mut Conn, from: &str, validity: Option<u32>, uids: &[u32], to: &str) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    select_at(conn, from, validity).await?;
    let missing = not_yet_moved(conn, from, uids, to).await?;
    // Reading the target moved the selection there: come back to the source for the COPY.
    select_at(conn, from, validity).await?;
    if !missing.is_empty() {
        conn.session.uid_copy(&uid_set(&missing), to).await?;
    }
    remove(conn, &uid_set(uids)).await
}

/// The UIDs of `from` whose Message-ID is not yet in `to`: those a move cut short after
/// COPY did not reach the target, and copying them again would duplicate the letters.
async fn not_yet_moved(conn: &mut Conn, from: &str, uids: &[u32], to: &str) -> Result<Vec<u32>> {
    conn.session.examine(from).await?;
    let fetches: Vec<_> = conn
        .session
        .uid_fetch(uid_set(uids), "(UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
        .await?
        .try_collect()
        .await?;
    let mut missing = Vec::new();
    for f in &fetches {
        let Some(uid) = f.uid else { continue };
        match f.header().and_then(message_id_of) {
            // No Message-ID to look the letter up by: it still has to move.
            None => missing.push(uid),
            Some(mid) => {
                // The size too: another letter of the same Message-ID at the target (a
                // crosspost) is not this one's copy, and the original would be lost.
                if find_matching(conn, to, &mid, f.size).await?.is_empty() {
                    missing.push(uid);
                }
            }
        }
    }
    Ok(missing)
}

/// The folder's UIDVALIDITY and the UID of every message in it, asked of the server: the
/// cache holds only a window of a big folder (#74).
pub async fn folder_uids(conn: &mut Conn, folder: &str) -> Result<(u32, Vec<u32>)> {
    let mailbox = conn.session.select(folder).await?;
    let uids = uid_search(conn, "ALL").await?;
    Ok((mailbox.uid_validity.unwrap_or(0), uids))
}

/// How many messages the folder holds on the server.
pub async fn folder_total(conn: &mut Conn, folder: &str) -> Result<u32> {
    Ok(conn.session.examine(folder).await?.exists)
}

/// What one `EXAMINE` says of the folder: how many messages it holds, its UIDVALIDITY and the
/// UID the next message will get. «Clear» touches only the UIDs below that one: what arrives
/// after the dialog counted is not wiped (#74).
pub async fn folder_mark(conn: &mut Conn, folder: &str) -> Result<(u32, u32, u32)> {
    let mailbox = conn.session.examine(folder).await?;
    let next = match mailbox.uid_next {
        Some(next) => next,
        // UIDNEXT is only a SHOULD for the server: one past the highest UID does as well.
        None => uid_search(conn, "ALL")
            .await?
            .into_iter()
            .max()
            .map_or(1, |m| m.saturating_add(1)),
    };
    Ok((mailbox.exists, mailbox.uid_validity.unwrap_or(0), next))
}

/// Removes messages for good. Used for the trash folder itself.
pub async fn delete_permanently(conn: &mut Conn, folder: &str, validity: Option<u32>, uids: &[u32]) -> Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    select_at(conn, folder, validity).await?;
    remove(conn, &uid_set(uids)).await
}

/// Marks the messages `\Deleted` and wipes them. Without UIDPLUS there is no `UID EXPUNGE`,
/// and a plain `EXPUNGE` would also wipe what another client marked deleted: those
/// messages lose the mark for the moment of the `EXPUNGE` and get it back after.
async fn remove(conn: &mut Conn, set: &str) -> Result<()> {
    let foreign = if conn.caps.uidplus {
        Vec::new()
    } else {
        uid_search(conn, &format!("DELETED NOT UID {set}")).await?
    };
    let _: Vec<_> = conn
        .session
        .uid_store(set, "+FLAGS.SILENT (\\Deleted)")
        .await?
        .try_collect()
        .await?;
    if conn.caps.uidplus {
        let _: Vec<_> = conn.session.uid_expunge(set).await?.try_collect().await?;
        return Ok(());
    }
    expunge_keeping(conn, set, &foreign).await
}

/// What `folder_gone` asks of the connection: `STATUS` of one folder, which touches no
/// selection. A trait so that a cut connection can be tried.
pub(crate) trait Probing {
    async fn status(&mut self, folder: &str) -> Result<()>;
}

impl Probing for Conn {
    async fn status(&mut self, folder: &str) -> Result<()> {
        self.session.status(folder, "(MESSAGES)").await?;
        Ok(())
    }
}

/// Whether the server says the folder does not exist: only a `NO` that names the missing
/// mailbox counts (`Error::folder_gone`, by its code `NONEXISTENT` or its words). Any other
/// `NO` (no code, `SERVERBUG`, `LOCKED`, `NOPERM`, `INUSE` ...) is no proof and keeps the
/// folder (`false`). A dead connection, a timeout or any other error is no answer and comes
/// back as the error.
pub(crate) async fn folder_gone<P: Probing>(p: &mut P, folder: &str) -> Result<bool> {
    match p.status(folder).await {
        Ok(()) => Ok(false),
        Err(e @ Error::Imap(async_imap::error::Error::No(_))) => Ok(e.folder_gone()),
        Err(e) => Err(e),
    }
}

/// What `expunge_keeping` asks of the connection: the `\Deleted` mark of a set of UIDs set or
/// cleared, and the plain `EXPUNGE`. A trait so that a failure in the middle can be tried.
trait Expunging {
    async fn mark(&mut self, set: String, deleted: bool) -> Result<()>;
    async fn expunge(&mut self) -> Result<()>;
}

impl Expunging for Conn {
    async fn mark(&mut self, set: String, deleted: bool) -> Result<()> {
        let op = if deleted {
            "+FLAGS.SILENT (\\Deleted)"
        } else {
            "-FLAGS.SILENT (\\Deleted)"
        };
        let _: Vec<_> = self.session.uid_store(set, op).await?.try_collect().await?;
        Ok(())
    }

    async fn expunge(&mut self) -> Result<()> {
        let _: Vec<_> = self.session.expunge().await?.try_collect().await?;
        Ok(())
    }
}

/// Plain `EXPUNGE` that spares `kept`: their `\Deleted` is cleared first and set again
/// afterwards, also when the `EXPUNGE` failed. A batch that could not be cleared stops the
/// `EXPUNGE` (the marks of others still on would be wiped), and every batch gets its mark
/// back all the same: one that failed to come back must not keep the rest from it. When the
/// run fails, the `\Deleted` of `ours` (the set marked for wiping) is taken off again, so that
/// no mark of ours stays on the server for another client's `EXPUNGE` to wipe.
async fn expunge_keeping(conn: &mut impl Expunging, ours: &str, kept: &[u32]) -> Result<()> {
    // Many marks of others are cleared and set again in batches: a command line with a
    // thousand UIDs is refused by some servers.
    let mut failure = None;
    for chunk in kept.chunks(SPARED_BATCH) {
        if let Err(e) = conn.mark(uid_set(chunk), false).await {
            failure = Some(e);
            break;
        }
    }
    if failure.is_none() {
        failure = conn.expunge().await.err();
    }
    for chunk in kept.chunks(SPARED_BATCH) {
        if let Err(e) = conn.mark(uid_set(chunk), true).await {
            failure.get_or_insert(e);
        }
    }
    if failure.is_some() {
        best_effort("take the mark off", conn.mark(ours.to_owned(), false).await);
    }
    failure.map_or(Ok(()), Err)
}

/// UIDs of other clients' `\Deleted` marks cleared or set in one command.
const SPARED_BATCH: usize = 500;

/// `flags` as `(\Seen)` or `\Seen`; empty for none.
pub async fn append(conn: &mut Conn, folder: &str, raw: &[u8], flags: &str) -> Result<()> {
    let flags = append_flags(flags);
    conn.session.append(folder, flags.as_deref(), None, raw).await?;
    Ok(())
}

/// APPEND that returns the UID the server gave, from `APPENDUID` (RFC 4315), when the
/// server offers UIDPLUS; `None` otherwise. The UID lets a just-appended letter be
/// deleted without searching for it, so a lagging index cannot leave it behind.
pub async fn append_uid(conn: &mut Conn, folder: &str, raw: &[u8], flags: &str) -> Result<Option<u32>> {
    use async_imap::imap_proto::Status;
    use tokio::io::AsyncWriteExt;
    let flags = append_flags(flags);
    let id = conn
        .session
        .run_command(format!(
            "APPEND {}{}{} {{{}}}",
            quoted(folder),
            if flags.is_some() { " " } else { "" },
            flags.as_deref().unwrap_or(""),
            raw.len()
        ))
        .await?;
    // The server asks for the literal before it reads it.
    match next_response!(conn, "append continuation").parsed() {
        Response::Continue(_) => {}
        _ => return Err(Error::Protocol("APPEND was not accepted".into())),
    }
    {
        let stream = conn.session.get_mut();
        stream.write_all(raw).await?;
        stream.write_all(b"\r\n").await?;
        stream.flush().await?;
    }
    loop {
        let resp = next_response!(conn, "append answer");
        if let Response::Done { tag, status, outcome } = resp.parsed()
            && *tag == id
        {
            if *status != Status::Ok {
                return Err(Error::Protocol("APPEND was refused".into()));
            }
            return Ok(match &outcome.code {
                Some(async_imap::imap_proto::ResponseCode::AppendUid(_, uids)) => uids.first().and_then(uid_of),
                _ => None,
            });
        }
    }
}

/// The single UID of an `APPENDUID` set member (a plain UID, or the first of a range).
fn uid_of(member: &async_imap::imap_proto::rfc4315::UidSetMember) -> Option<u32> {
    use async_imap::imap_proto::rfc4315::UidSetMember;
    match member {
        UidSetMember::Uid(uid) => Some(*uid),
        UidSetMember::UidRange(range) => Some(*range.start()),
    }
}

/// The flag list of APPEND (RFC 3501) is parenthesized. Dovecot does not refuse bare
/// flags before the message: it waits for the literal without "+", and the client
/// waiting for "+" hangs until the watchdog gives up.
fn append_flags(flags: &str) -> Option<String> {
    let flags = flags.trim();
    match flags {
        "" => None,
        f if f.starts_with('(') => Some(f.to_owned()),
        f => Some(format!("({f})")),
    }
}

/// UIDs of messages with this Message-ID in the folder. `SEARCH HEADER Message-ID`
/// matches a substring (RFC 3501), so the letters found are read back and only an exact
/// Message-ID is kept; an id that is empty, or not a Message-ID, finds nothing. A refusal
/// or a dropped connection is an error, not "nothing found" (`uid_search`).
pub async fn find_by_message_id(conn: &mut Conn, folder: &str, message_id: &str) -> Result<Vec<u32>> {
    find_matching(conn, folder, message_id, None).await
}

/// `find_by_message_id`, narrowed to letters of exactly `size` bytes when it is given: a
/// letter of the same Message-ID but another size (a mailing-list crosspost) is another letter.
async fn find_matching(conn: &mut Conn, folder: &str, message_id: &str, size: Option<u32>) -> Result<Vec<u32>> {
    let id = message_id.trim_matches(['<', '>']).trim();
    // Only an empty id (or one with angle brackets still in it) finds nothing: a
    // Message-ID without `@` is unusual but valid, and returning nothing would leave the
    // letter in "Snoozed"/"Waiting for reply" for good. The exact header read below keeps
    // a substring search from matching a longer id.
    if id.is_empty() || id.contains(['<', '>']) {
        return Ok(Vec::new());
    }
    conn.session.examine(folder).await?;
    let needle = id.replace(['"', '\\'], "");
    let uids = uid_search(conn, &format!("HEADER Message-ID \"{needle}\"")).await?;
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let fetches: Vec<_> = conn
        .session
        .uid_fetch(
            uid_set(&uids),
            "(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])",
        )
        .await?
        .try_collect()
        .await?;
    Ok(fetches
        .iter()
        .filter(|f| f.uid.is_some_and(|u| uids.contains(&u)))
        .filter(|f| size.is_none_or(|n| f.size == Some(n)))
        .filter(|f| f.header().and_then(message_id_of).as_deref() == Some(id))
        // A moved original still marked \Deleted is gone, and moving it again would
        // copy it a second time.
        .filter(|f| !f.flags().any(|flag| matches!(flag, Flag::Deleted)))
        .filter_map(|f| f.uid)
        .collect())
}

/// The Message-ID of a `HEADER.FIELDS (Message-ID)` block, bare.
fn message_id_of(header: &[u8]) -> Option<String> {
    let msg = mail_parser::MessageParser::default().parse_headers(header)?;
    msg.message_id().map(|m| m.trim_matches(['<', '>']).to_owned())
}

/// Selects a folder to sync it. With CONDSTORE the answer carries HIGHESTMODSEQ, or
/// none when the folder keeps no mod-sequences (NOMODSEQ). QRESYNC is enabled once per
/// session. A server that refuses either is synced the plain way.
pub async fn select_for_sync(conn: &mut Conn, folder: &str) -> Result<Mailbox> {
    use async_imap::error::Error as E;
    enable_qresync(conn).await?;
    if conn.caps.condstore {
        match conn.session.select_condstore(folder).await {
            Ok(mailbox) => return Ok(mailbox),
            // A missing folder fails the plain SELECT below as well.
            Err(E::Bad(_) | E::No(_)) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(conn.session.select(folder).await?)
}

/// Enables QRESYNC once per session when the server offers it; a refusal leaves the
/// session without it. The answer waits in `Conn::enabled` for the cache.
pub async fn enable_qresync(conn: &mut Conn) -> Result<()> {
    use async_imap::error::Error as E;
    if !conn.caps.qresync || conn.qresync {
        return Ok(());
    }
    match conn.session.run_command_and_check_ok("ENABLE QRESYNC").await {
        Ok(()) => {
            conn.qresync = true;
            conn.enabled = Some(Enabled {
                ok: true,
                answer: "ENABLED QRESYNC".into(),
            });
        }
        Err(E::Bad(m) | E::No(m)) => {
            conn.caps.qresync = false;
            conn.enabled = Some(Enabled {
                ok: false,
                answer: server_text(&m),
            });
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

/// What changed in the selected folder after a mod-sequence.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub flags: Vec<(u32, Flags)>,
    /// The own keywords (labels) the same `FLAGS` reported, by UID: a label another client
    /// set must reach the cache, not only the first insert of a letter.
    pub keywords: Vec<(u32, Vec<String>)>,
    /// Expunged UIDs (QRESYNC); may name UIDs that were never cached.
    pub vanished: Vec<RangeInclusive<u32>>,
}

impl Changes {
    pub fn vanished(&self, uid: u32) -> bool {
        self.vanished.iter().any(|r| r.contains(&uid))
    }

    /// Takes in a FETCH or VANISHED answer; the rest is not about changes.
    fn take(&mut self, resp: &Response<'_>) {
        match resp {
            Response::Fetch(_, attrs) => {
                let mut uid = None;
                let mut flags = None;
                let mut keywords = None;
                for a in attrs {
                    match a {
                        AttributeValue::Uid(u) => uid = Some(*u),
                        AttributeValue::Flags(f) => {
                            flags = Some(flags_from_imap(f.iter().map(|s| Flag::from(s.to_string()))));
                            keywords = Some(keywords_of(f.iter().map(|s| Flag::from(s.to_string()))));
                        }
                        _ => {}
                    }
                }
                if let (Some(uid), Some(flags), Some(keywords)) = (uid, flags, keywords) {
                    self.flags.push((uid, flags));
                    self.keywords.push((uid, keywords));
                }
            }
            Response::Vanished { uids, .. } => self.vanished.extend(uids.iter().cloned()),
            _ => {}
        }
    }
}

/// Flags of messages among `uids` of the selected folder changed after `modseq`
/// (`CHANGEDSINCE`, RFC 7162); with QRESYNC enabled, also the UIDs expunged since.
/// A refusal is `Error::Imap` with NO or BAD.
pub async fn changed_since(conn: &mut Conn, uids: &str, modseq: u64) -> Result<Changes> {
    use async_imap::error::Error as E;
    use async_imap::imap_proto::Status;
    let vanished = if conn.qresync { " VANISHED" } else { "" };
    let id = conn
        .session
        .run_command(format!(
            "UID FETCH {uids} (UID FLAGS) (CHANGEDSINCE {modseq}{vanished})"
        ))
        .await?;
    let mut changes = Changes::default();
    loop {
        let resp = next_response!(conn, "changed flags");
        match resp.parsed() {
            Response::Done { tag, status, outcome } if *tag == id => {
                let text = outcome.information.as_deref().unwrap_or_default().to_owned();
                return match status {
                    Status::Ok => Ok(changes),
                    Status::No => Err(E::No(text).into()),
                    _ => Err(E::Bad(text).into()),
                };
            }
            other => changes.take(other),
        }
    }
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
        if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
            // LARGER and SMALLER take a number, not a string; digits are a valid atom anywhere.
            line.push_str(&format!(" {value}"));
        } else if value.is_ascii() {
            line.push_str(&format!(" {}", quoted(&value)));
        } else if conn.caps.literal_plus {
            line.push_str(&format!(" {{{}+}}\r\n{value}", value.len()));
        } else {
            line.push_str(&format!(" {{{}}}", value.len()));
            segments.push((std::mem::take(&mut line), value));
        }
    }
    let mut parts = segments.into_iter();
    let Some((first, mut literal)) = parts.next() else {
        let id = conn.session.run_command(line).await?;
        return read_search(conn, id, search_refused).await;
    };
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
    read_search(conn, id, search_refused).await
}

/// `UID SEARCH {query}` in the selected folder. async-imap's `uid_search` takes a
/// refusal or a dropped connection for "nothing found"; here they are errors.
pub async fn uid_search(conn: &mut Conn, query: &str) -> Result<Vec<u32>> {
    let id = conn.session.run_command(format!("UID SEARCH {query}")).await?;
    read_search(conn, id, |info| async_imap::error::Error::No(info.to_owned()).into()).await
}

/// Creates a folder; one that already exists is fine.
pub async fn create_folder(conn: &mut Conn, name: &str) -> Result<()> {
    match conn.session.create(utf7::encode(name)).await {
        Ok(()) => Ok(()),
        Err(async_imap::error::Error::No(m)) if m.to_ascii_lowercase().contains("exist") => Ok(()),
        Err(e) => Err(e.into()),
    }
}

async fn read_search(
    conn: &mut Conn,
    id: async_imap::imap_proto::RequestId,
    refused: fn(&str) -> Error,
) -> Result<Vec<u32>> {
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
                return Err(refused(outcome.information.as_deref().unwrap_or_default()));
            }
            _ => {}
        }
    }
}

fn search_refused(info: &str) -> Error {
    Error::Said(Say::SearchCharset { info: info.to_owned() })
}

pub enum IdleOutcome {
    /// Something changed in the selected folder.
    Changed,
    /// Nothing happened before the timeout; renew IDLE.
    Timeout,
}

/// Waits for changes in `folder` with IDLE (renewed after `renew`, see `IdlePace`), or polls
/// it when IDLE is not supported.
/// Returns the connection back so it can be reused.
pub async fn wait_for_changes(
    mut conn: Conn,
    folder: &str,
    poll: Duration,
    renew: Duration,
) -> Result<(Conn, IdleOutcome)> {
    // A connection that is already on the folder is not selected again: the answer to a
    // SELECT is not an unsolicited EXISTS, so a letter that came in the gap since the last
    // IDLE would be swallowed. What came in the gap is queued, and told below.
    let selected = conn.idle_folder.as_deref() == Some(folder);
    if !selected {
        conn.session.select(folder).await?;
        conn.idle_folder = Some(folder.to_owned());
        // Polling has no IDLE to start: a SELECT that went through is its work.
        if !conn.caps.idle {
            conn.worked.store(true, Ordering::Relaxed);
        }
    }
    let gap = drain_unsolicited(&conn.session);
    if selected && gap {
        return Ok((conn, IdleOutcome::Changed));
    }
    if !conn.caps.idle {
        conn.idle_folder = None;
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

    let Conn {
        session,
        caps,
        capabilities,
        greeting,
        enabled,
        idling,
        receiver,
        idle_folder,
        worked,
        ..
    } = conn;
    let queue = session.unsolicited_responses.clone();
    let mut handle = session.idle();
    // The `+ idling` wait is an ordinary command answer and stays under the silence
    // watchdog; the watchdog stands down only once the server is actually idling.
    if let Err(e) = handle.init().await {
        return Err(e.into());
    }
    worked.store(true, Ordering::Relaxed);
    // What the server told while the IDLE was being started (before its "+ idling").
    let early = drain_with(|| queue.try_recv().ok());
    let response = if early {
        IdleResponse::ManualInterrupt
    } else {
        idling.store(true, Ordering::Relaxed);
        let (wait, _stop) = handle.wait_with_timeout(renew);
        let response = wait.await;
        idling.store(false, Ordering::Relaxed);
        response?
    };
    // A BYE is the server's own word on why it closes: keep it for the log.
    if let IdleResponse::NewData(data) = &response
        && let async_imap::imap_proto::Response::Data {
            status: async_imap::imap_proto::Status::Bye,
            outcome,
            ..
        } = data.parsed()
    {
        return Err(Error::Bye(
            outcome.information.as_deref().unwrap_or_default().to_owned(),
        ));
    }
    let session = handle.done().await?;
    let outcome = match response {
        // What came along with the news (RECENT, a second EXISTS) is the same news:
        // left in the queue it would wake the next wait for a letter already told.
        IdleResponse::NewData(_) => {
            drain_unsolicited(&session);
            IdleOutcome::Changed
        }
        IdleResponse::Timeout | IdleResponse::ManualInterrupt => {
            if early || drain_unsolicited(&session) {
                IdleOutcome::Changed
            } else {
                IdleOutcome::Timeout
            }
        }
    };
    Ok((
        Conn {
            session,
            caps,
            qresync: false,
            capabilities,
            greeting,
            enabled,
            idling,
            receiver,
            idle_folder,
            worked,
        },
        outcome,
    ))
}

/// Selects the folder the next `wait_for_changes` will idle on and gives its state, so that
/// what came in before this SELECT can be told from the cache's mark, and what comes later
/// is told by the IDLE.
pub async fn select_for_idle(conn: &mut Conn, folder: &str) -> Result<Mailbox> {
    let mailbox = conn.session.select(folder).await?;
    conn.idle_folder = Some(folder.to_owned());
    drain_unsolicited(&conn.session);
    Ok(mailbox)
}

fn drain_unsolicited(session: &Session) -> bool {
    drain_with(|| session.unsolicited_responses.try_recv().ok())
}

/// Whether anything queued says the folder changed; empties the queue.
fn drain_with(mut next: impl FnMut() -> Option<UnsolicitedResponse>) -> bool {
    use async_imap::imap_proto::Response;
    let mut changed = false;
    while let Some(r) = next() {
        changed |= match &r {
            UnsolicitedResponse::Exists(_) | UnsolicitedResponse::Expunge(_) | UnsolicitedResponse::Recent(_) => true,
            UnsolicitedResponse::Other(data) => matches!(data.parsed(), Response::Vanished { .. }),
            _ => false,
        };
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

    fn folder(name: &str) -> Folder {
        Folder {
            name: name.into(),
            display_name: name.into(),
            delimiter: Some("/".into()),
            role: None,
            selectable: true,
            hidden: false,
        }
    }

    #[test]
    fn quoted_keeps_the_quotes_of_an_address() {
        // SEARCH FROM "a b"@x: a quoted local part reaches the server with its quotes escaped.
        assert_eq!(quoted(r#""a b"@x.org"#), r#""\"a b\"@x.org""#);
        assert_eq!(quoted("olga@example.org"), r#""olga@example.org""#);
        assert_eq!(quoted(r"a\b"), r#""a\\b""#);
    }

    #[test]
    fn a_list_without_inbox_is_a_lost_connection() {
        // The empty list of a connection that died mid-LIST must not reach `replace_folders`.
        assert!(matches!(
            require_inbox(&[]),
            Err(Error::Imap(async_imap::error::Error::ConnectionLost))
        ));
        assert!(require_inbox(&[folder("Sent")]).is_err());
        assert!(require_inbox(&[folder("Sent"), folder("inbox")]).is_ok());
    }

    /// A server that answers `NO` to every SELECT and writes down what it was asked.
    async fn refusing_server() -> (u16, Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let (r, mut w) = sock.into_split();
            let mut lines = BufReader::new(r).lines();
            w.write_all(b"* OK [CAPABILITY IMAP4rev1 UIDPLUS] ready\r\n")
                .await
                .unwrap();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut parts = line.split_whitespace();
                let (tag, cmd) = (
                    parts.next().unwrap_or("*"),
                    parts.next().unwrap_or("").to_ascii_uppercase(),
                );
                seen.lock().unwrap().push(cmd.clone());
                let reply = match cmd.as_str() {
                    "CAPABILITY" => format!("* CAPABILITY IMAP4rev1 UIDPLUS\r\n{tag} OK done\r\n"),
                    "SELECT" => format!("{tag} NO no such folder\r\n"),
                    _ => format!("{tag} OK done\r\n"),
                };
                w.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (port, asked)
    }

    #[tokio::test]
    async fn a_folder_that_cannot_be_selected_ends_the_removal_before_any_store() {
        let (port, asked) = refusing_server().await;
        let mut conn = connect(
            &ServerConfig::new("127.0.0.1", port, Security::Plain),
            &Credentials::new("u", "p"),
        )
        .await
        .unwrap();
        assert!(remove_uids(&mut conn, "Gone", &[5]).await.is_err());
        let asked = asked.lock().unwrap().clone();
        assert!(asked.contains(&"SELECT".to_owned()));
        assert!(
            !asked.iter().any(|c| c == "UID" || c == "STORE" || c == "EXPUNGE"),
            "{asked:?}"
        );
    }

    /// A connection that records what `expunge_keeping` asks and fails the clearing of one batch.
    #[derive(Default)]
    struct Fake {
        asked: Vec<(String, bool)>,
        expunged: bool,
        fail_clearing_of: Option<usize>,
        fail_setting_of: Option<usize>,
    }

    impl Expunging for Fake {
        async fn mark(&mut self, set: String, deleted: bool) -> Result<()> {
            let n = self.asked.iter().filter(|(_, d)| *d == deleted).count();
            self.asked.push((set, deleted));
            let fails = if deleted {
                self.fail_setting_of
            } else {
                self.fail_clearing_of
            };
            if fails == Some(n) {
                return Err(Error::Protocol("refused".into()));
            }
            Ok(())
        }

        async fn expunge(&mut self) -> Result<()> {
            self.expunged = true;
            Ok(())
        }
    }

    #[tokio::test]
    async fn the_marks_of_others_come_back_to_every_batch_whatever_failed() {
        // 1100 scattered UIDs: three batches of at most 500.
        let kept: Vec<u32> = (0..1100).map(|n| n * 2 + 2).collect();
        let sets = |c: &Fake, deleted: bool| c.asked.iter().filter(|(_, d)| *d == deleted).count();

        // All goes well: cleared, expunged, set again.
        let mut ok = Fake::default();
        expunge_keeping(&mut ok, "1:5", &kept).await.unwrap();
        assert!(ok.expunged);
        assert_eq!((sets(&ok, false), sets(&ok, true)), (3, 3));

        // The second batch cannot be cleared: no EXPUNGE (the marks still on would be wiped),
        // and all three batches get their mark back.
        let mut stuck = Fake {
            fail_clearing_of: Some(1),
            ..Fake::default()
        };
        assert!(expunge_keeping(&mut stuck, "1:5", &kept).await.is_err());
        assert!(!stuck.expunged);
        assert_eq!(sets(&stuck, true), 3);
        // Our own marks do not stay on the server either: the last thing asked takes them off.
        assert_eq!(stuck.asked.last(), Some(&("1:5".to_owned(), false)));
        assert_eq!(ok.asked.iter().filter(|(set, _)| set == "1:5").count(), 0);

        // A batch that fails to come back does not keep the later ones from it.
        let mut lost = Fake {
            fail_setting_of: Some(0),
            ..Fake::default()
        };
        assert!(expunge_keeping(&mut lost, "1:5", &kept).await.is_err());
        assert!(lost.expunged);
        assert_eq!(sets(&lost, true), 3);
    }

    #[test]
    fn compresses_uid_sets() {
        assert_eq!(uid_set(&[7, 1, 2, 3, 3, 9, 10]), "1:3,7,9:10");
        assert_eq!(uid_set(&[5]), "5");
        assert_eq!(uid_set(&[]), "");
    }

    #[test]
    fn reads_changed_flags_and_vanished_uids() {
        let mut changes = Changes::default();
        for line in [
            &b"* 3 FETCH (UID 12 MODSEQ (90060115205545359) FLAGS (\\Seen \\Deleted))\r\n"[..],
            b"* 4 FETCH (FLAGS (\\Flagged $Label) UID 14 MODSEQ (90060115205545360))\r\n",
            b"* VANISHED (EARLIER) 5:7,9\r\n",
            b"* 5 EXISTS\r\n",
            b"* 5 FETCH (MODSEQ (1))\r\n",
        ] {
            let (_, resp) = Response::parse(line).unwrap();
            changes.take(&resp);
        }
        let seen_deleted = Flags {
            seen: true,
            deleted: true,
            ..Flags::default()
        };
        let flagged = Flags {
            flagged: true,
            ..Flags::default()
        };
        assert_eq!(changes.flags, [(12, seen_deleted), (14, flagged)]);
        assert_eq!(changes.vanished, [5..=7, 9..=9]);
        assert!(changes.vanished(6) && changes.vanished(9));
        assert!(!changes.vanished(8) && !changes.vanished(12));
    }

    #[test]
    fn reads_a_forward_and_writes_what_depesha_did() {
        let mut changes = Changes::default();
        let (_, resp) = Response::parse(b"* 3 FETCH (UID 12 FLAGS (\\Seen \\Answered $Forwarded))\r\n").unwrap();
        changes.take(&resp);
        let (_, resp) = Response::parse(b"* 4 FETCH (UID 13 FLAGS ($forwarded))\r\n").unwrap();
        changes.take(&resp);
        let both = Flags {
            seen: true,
            answered: true,
            forwarded: true,
            ..Flags::default()
        };
        let forwarded = Flags {
            forwarded: true,
            ..Flags::default()
        };
        assert_eq!(changes.flags, [(12, both), (13, forwarded)]);
        // IMAP has one flag for an answer of either kind.
        assert_eq!(
            flag_command(FlagChange::AnsweredAll(true)),
            "+FLAGS.SILENT (\\Answered)"
        );
        assert_eq!(flag_command(FlagChange::Forwarded(true)), "+FLAGS.SILENT ($Forwarded)");
        assert_eq!(flag_command(FlagChange::Forwarded(false)), "-FLAGS.SILENT ($Forwarded)");
    }

    #[test]
    fn reads_what_the_capability_list_offers() {
        let names = capability_names(
            "SORT QUOTA IDLE status=size IMAP4rev1 MOVE AUTH=PLAIN UIDPLUS LITERAL+ X-UNKNOWN QRESYNC IDLE"
                .split(' ')
                .map(str::to_owned),
        );
        // Protocol first, the rest by name, each once.
        assert_eq!(
            names,
            [
                "IMAP4rev1",
                "AUTH=PLAIN",
                "IDLE",
                "LITERAL+",
                "MOVE",
                "QRESYNC",
                "QUOTA",
                "SORT",
                "status=size",
                "UIDPLUS",
                "X-UNKNOWN"
            ]
        );
        let caps = Caps::from_names(&names);
        assert!(caps.idle && caps.move_ && caps.uidplus && caps.literal_plus && caps.quota && caps.status_size);
        // QRESYNC implies CONDSTORE.
        assert!(caps.qresync && caps.condstore);
        assert!(!caps.special_use);
        assert_eq!(Caps::from_names(&["IMAP4rev1"]), Caps::default());
    }

    #[test]
    fn rev2_has_the_folded_in_base_features() {
        // RFC 9051 (7.2.2, Appendix E.2): IMAP4rev2 folds in IDLE, MOVE, UIDPLUS,
        // SPECIAL-USE and STATUS=SIZE; they are named in CAPABILITY neither in the
        // base nor in the Appendix F recommendations. CONDSTORE/QRESYNC are not.
        let caps = Caps::from_names(&["IMAP4rev2"]);
        assert!(caps.idle && caps.move_ && caps.uidplus && caps.special_use && caps.status_size);
        assert!(!caps.condstore && !caps.qresync, "recommended, not implied");
        assert!(!caps.literal_plus && !caps.quota);
        // Case is ignored, as in the capability list.
        assert!(Caps::from_names(&["imap4rev2"]).idle);
    }

    #[test]
    fn rev1_and_rev2_together_speak_rev1() {
        // Without ENABLE IMAP4rev2 such a server (Dovecot 2.4, Stalwart, Cyrus) is rev1:
        // only the names it lists count.
        assert_eq!(Caps::from_names(&["IMAP4rev1", "IMAP4rev2"]), Caps::default());
        let caps = Caps::from_names(&["IMAP4rev2", "imap4rev1", "IDLE"]);
        assert!(caps.idle && !caps.move_ && !caps.uidplus && !caps.special_use && !caps.status_size);
    }

    #[test]
    fn keeps_the_greetings_capabilities() {
        let (_, resp) = Response::parse(
            b"* OK [CAPABILITY IMAP4rev1 SASL-IR ID ENABLE IDLE AUTH=PLAIN] mail.example.com ready.\r\n",
        )
        .unwrap();
        assert_eq!(
            greeting_line(&resp).as_deref(),
            Some("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN ENABLE ID IDLE SASL-IR] mail.example.com ready.")
        );
        // A greeting without the list says nothing about the server.
        let (_, resp) = Response::parse(b"* OK Dovecot ready.\r\n").unwrap();
        assert_eq!(greeting_line(&resp), None);
    }

    /// The FETCH of changed flags carries the keywords too; the sync writes them into the
    /// cache, so a label another client set shows up.
    /// The raw read of the NAMESPACE answer must stop exactly at the tagged line: a
    /// chunked read swallows the bytes of the next answer and desyncs the session.
    #[tokio::test]
    async fn namespace_reading_leaves_the_next_answer_alone() {
        use tokio::io::AsyncReadExt;
        let raw = b"* NAMESPACE ((\"\" \"/\")) NIL ((\"shared/\" \"/\"))\r\nA0001 OK NAMESPACE done\r\n* 1 EXISTS\r\n";
        let mut stream: &[u8] = raw;
        let text = read_tagged(&mut stream, "A0001").await.unwrap();
        assert!(text.contains("* NAMESPACE"), "{text}");
        // The bytes after the tagged line stay for the session.
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).await.unwrap();
        assert_eq!(rest, b"* 1 EXISTS\r\n");
    }

    #[test]
    fn changed_flags_carry_their_keywords() {
        let (_, resp) = Response::parse(b"* 1 FETCH (UID 7 FLAGS (\\Seen depesha-work $Forwarded))\r\n").unwrap();
        let mut changes = Changes::default();
        changes.take(&resp);
        assert_eq!(changes.flags.len(), 1);
        assert_eq!(changes.flags[0].0, 7);
        // The convention keyword is not a label.
        assert_eq!(changes.keywords, [(7, vec!["depesha-work".to_owned()])]);
    }

    #[test]
    fn append_flags_are_parenthesized() {
        assert_eq!(append_flags(""), None);
        assert_eq!(append_flags("\\Seen").as_deref(), Some("(\\Seen)"));
        assert_eq!(append_flags("\\Draft \\Seen").as_deref(), Some("(\\Draft \\Seen)"));
        assert_eq!(append_flags("(\\Seen)").as_deref(), Some("(\\Seen)"));
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
    fn explains_xoauth2_refusals() {
        let no_scope =
            xoauth2_error(br#"{"status":"400","schemes":"Bearer","scope":"https://mail.google.com/"}"#).unwrap();
        assert_eq!(no_scope, Xoauth2Detail::NoMailAccess("400".into()));
        let expired = xoauth2_error(br#"{"status":"401","schemes":"Bearer"}"#).unwrap();
        assert_eq!(expired, Xoauth2Detail::Expired("401".into()));
        assert_eq!(
            xoauth2_error(br#"{"status":503}"#).unwrap(),
            Xoauth2Detail::Other("503".into())
        );
        assert!(xoauth2_error(b"not json").is_none());
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
