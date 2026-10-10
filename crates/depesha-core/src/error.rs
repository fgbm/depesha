use std::time::Duration;

use crate::say::{Class, Say};
use crate::tls::CertProblem;

/// What went wrong, worded in English for the log. The words the user reads are made from the
/// value at the edge of the program (`CmdError`): the core knows no language.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{}", io_text(.0))]
    Io(#[from] std::io::Error),
    #[error("the server did not answer in time ({0})")]
    Timeout(&'static str),
    #[error("TLS: {0}")]
    Tls(#[from] tokio_rustls::rustls::Error),
    #[error("untrusted certificate {}: {}", .0.host, .0.reason)]
    Certificate(Box<CertProblem>),
    #[error("the server does not support encryption (STARTTLS); the password was not sent")]
    NoTls,
    #[error("invalid server name: {0}")]
    InvalidHost(String),
    #[error("the server rejected the login: {0}")]
    Auth(String),
    /// The login methods the server offers, or none when empty.
    #[error("the server offers no supported login method (offers: {}); PLAIN or LOGIN is needed", offers_text(.0))]
    AuthMechanism(String),
    #[error(
        "the server accepted the password but did not open the mailbox over IMAP. On Exchange: \
         IMAP is off for the mailbox (ImapEnabled) or the MSExchangeIMAP4BE service is not running"
    )]
    ImapUnavailable,
    #[error("IMAP: {}", imap_text(.0))]
    Imap(#[from] async_imap::error::Error),
    #[error("{}", smtp_text(*.code, .enhanced.as_deref(), .message))]
    Smtp {
        code: u16,
        enhanced: Option<String>,
        message: String,
    },
    /// The SMTP server refused our EHLO: it judges the client by the name it gives.
    #[error("the server did not accept the client's greeting (EHLO {name}), before any login: {code} {message}")]
    SmtpHello { name: String, code: u16, message: String },
    #[error("the message is {size} bytes, over the server's limit of {limit} bytes")]
    TooLarge { size: usize, limit: u64 },
    #[error("the message could not be built: {0}")]
    Compose(String),
    #[error("local database: {0}")]
    Store(#[from] rusqlite::Error),
    #[error("the server closed the connection")]
    Closed,
    /// The server said `* BYE` with this text (sent as it was worded) and closed the connection.
    #[error("the server closed the connection: {0}")]
    Bye(String),
    #[error("unexpected answer from the server: {0}")]
    Protocol(String),
    #[error("message not found")]
    NotFound,
    #[error("the message could not be parsed")]
    Parse,
    /// A value of the local cache does not parse (#146); the log names the row, never the content.
    #[error("stored data could not be read")]
    Unreadable,
    /// Exchange Web Services refused a request: `ResponseCode` and `MessageText`;
    /// `back_off` is the pause a throttled request (`ErrorServerBusy`) is asked to
    /// keep, `BackOffMilliseconds` of its `MessageXml`.
    #[error("{}", ews_text(.code, .message, *.back_off))]
    Ews {
        code: String,
        message: String,
        back_off: Option<Duration>,
    },
    /// Exchange is busy and the mailbox's queue sends nothing for `wait`: `retrying`
    /// when the queue repeats the request itself, otherwise the action was not done.
    #[error("{}", busy_text(*.wait, *.retrying))]
    Busy { wait: Duration, retrying: bool },
    /// The web server offers none of the login methods we speak (EWS without Basic).
    #[error(
        "Exchange accepts only {0} on EWS; Depesha signs in with Basic or NTLM. Ask the administrator \
         to enable one of them: Set-WebServicesVirtualDirectory -WindowsAuthentication $true"
    )]
    HttpAuth(String),
    /// The mailbox waits for the user (a wrong password): background work does not
    /// knock on the server meanwhile.
    #[error("the mailbox is paused until its settings are fixed")]
    Paused,
    /// A link from a letter leads into a private network (loopback, LAN, link-local…):
    /// Depesha does not go there on a stranger's word.
    #[error("{0} is an address in a private network; Depesha does not send requests there from a letter")]
    PrivateAddress(String),
    /// The local cache was written by a newer version: its format number and the
    /// newest this version knows. The cache is left as it is.
    #[error(
        "the local mail cache was saved by a newer version of Depesha (format {found}, this version \
         reads up to {known}). Install the newer version; the cache was left as it is"
    )]
    CacheTooNew { found: i64, known: i64 },
    /// The server renumbered the folder (a new UIDVALIDITY, or an Exchange folder
    /// cached anew) after the UIDs of an action were read: they name other messages.
    #[error("the folder changed on the server before the action ran; nothing was done, try again")]
    FolderChanged,
    /// The label is being taken off every letter: a new one by the same name would have its
    /// keyword stripped with the rest.
    #[error("The label is still being removed, try again in a minute")]
    LabelStripping,
    /// The label check cannot run here: without UIDPLUS its test letter could not be
    /// expunged by UID, so it would stay behind. Depesha does not run it.
    #[error("this server has no UIDPLUS: the label check cannot remove its test letter, so it is not run")]
    LabelCheckUnsupported,
    /// The server refuses to file the copy of a sent letter in «Sent» (see `append_refused`); the text is the refusal as it was worded.
    #[error("{0}")]
    CopyRefused(String),
    /// A failure the core words itself, as a code with its parameters.
    #[error("{}", .0.english())]
    Said(Say),
    /// An IMAP error of a kind that cannot be copied (`Clone` keeps its words).
    #[error("IMAP: {0}")]
    ImapOther(String),
    /// A database error of a kind that cannot be copied (`Clone` keeps its words).
    #[error("local database: {0}")]
    StoreOther(String),
}

/// A copy keeps the kind of the error and every answer the predicates give; only the
/// errors of other libraries that cannot be copied are rebuilt, from their kind or their words.
impl Clone for Error {
    fn clone(&self) -> Self {
        use async_imap::error::Error as I;
        match self {
            Self::Io(e) => Self::Io(std::io::Error::new(e.kind(), e.to_string())),
            Self::Timeout(t) => Self::Timeout(t),
            Self::Tls(e) => Self::Tls(e.clone()),
            Self::Certificate(p) => Self::Certificate(p.clone()),
            Self::NoTls => Self::NoTls,
            Self::InvalidHost(h) => Self::InvalidHost(h.clone()),
            Self::Auth(m) => Self::Auth(m.clone()),
            Self::AuthMechanism(m) => Self::AuthMechanism(m.clone()),
            Self::ImapUnavailable => Self::ImapUnavailable,
            Self::Imap(e) => match e {
                I::Io(io) => Self::Imap(I::Io(std::io::Error::new(io.kind(), io.to_string()))),
                I::Bad(m) => Self::Imap(I::Bad(m.clone())),
                I::No(m) => Self::Imap(I::No(m.clone())),
                I::ConnectionLost => Self::Imap(I::ConnectionLost),
                other => Self::ImapOther(other.to_string()),
            },
            Self::Smtp {
                code,
                enhanced,
                message,
            } => Self::Smtp {
                code: *code,
                enhanced: enhanced.clone(),
                message: message.clone(),
            },
            Self::SmtpHello { name, code, message } => Self::SmtpHello {
                name: name.clone(),
                code: *code,
                message: message.clone(),
            },
            Self::TooLarge { size, limit } => Self::TooLarge {
                size: *size,
                limit: *limit,
            },
            Self::Compose(m) => Self::Compose(m.clone()),
            Self::Store(e) => Self::StoreOther(e.to_string()),
            Self::Closed => Self::Closed,
            Self::Bye(m) => Self::Bye(m.clone()),
            Self::Protocol(m) => Self::Protocol(m.clone()),
            Self::NotFound => Self::NotFound,
            Self::Parse => Self::Parse,
            Self::Unreadable => Self::Unreadable,
            Self::Ews {
                code,
                message,
                back_off,
            } => Self::Ews {
                code: code.clone(),
                message: message.clone(),
                back_off: *back_off,
            },
            Self::Busy { wait, retrying } => Self::Busy {
                wait: *wait,
                retrying: *retrying,
            },
            Self::HttpAuth(m) => Self::HttpAuth(m.clone()),
            Self::Paused => Self::Paused,
            Self::PrivateAddress(h) => Self::PrivateAddress(h.clone()),
            Self::CacheTooNew { found, known } => Self::CacheTooNew {
                found: *found,
                known: *known,
            },
            Self::FolderChanged => Self::FolderChanged,
            Self::LabelStripping => Self::LabelStripping,
            Self::LabelCheckUnsupported => Self::LabelCheckUnsupported,
            Self::CopyRefused(m) => Self::CopyRefused(m.clone()),
            Self::Said(s) => Self::Said(s.clone()),
            Self::ImapOther(m) => Self::ImapOther(m.clone()),
            Self::StoreOther(m) => Self::StoreOther(m.clone()),
        }
    }
}

/// What the interface branches on when a call fails: the stable code of an error, the same
/// string on the wire (`as_str`) as before it was an enum. Several belong to the interface
/// alone (`Extension`, `Print`…); the core names them so the whole set is in one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum ErrorKind {
    #[serde(rename = "certificate")]
    Certificate,
    #[serde(rename = "no-tls")]
    NoTls,
    #[serde(rename = "auth")]
    Auth,
    #[serde(rename = "not-found")]
    NotFound,
    #[serde(rename = "too-large")]
    TooLarge,
    #[serde(rename = "imap-unavailable")]
    ImapUnavailable,
    #[serde(rename = "rate-limited")]
    RateLimited,
    #[serde(rename = "paused")]
    Paused,
    #[serde(rename = "cache-too-new")]
    CacheTooNew,
    #[serde(rename = "folder-changed")]
    FolderChanged,
    #[serde(rename = "no-rights")]
    NoRights,
    #[serde(rename = "network")]
    Network,
    #[serde(rename = "other")]
    Other,
    #[serde(rename = "io")]
    Io,
    #[serde(rename = "extension")]
    Extension,
    #[serde(rename = "bad-request")]
    BadRequest,
    #[serde(rename = "input")]
    Input,
    #[serde(rename = "keyring")]
    Keyring,
    #[serde(rename = "save-folder")]
    SaveFolder,
    #[serde(rename = "dangerous")]
    Dangerous,
    #[serde(rename = "unsupported")]
    Unsupported,
    #[serde(rename = "print")]
    Print,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "window")]
    Window,
    #[serde(rename = "not-a-file")]
    NotAFile,
    #[serde(rename = "not-a-picture")]
    NotAPicture,
    #[serde(rename = "update")]
    Update,
    #[serde(rename = "not-chosen")]
    NotChosen,
    #[serde(rename = "copy-filed")]
    CopyFiled,
    #[serde(rename = "superseded")]
    Superseded,
}

impl ErrorKind {
    /// Every kind, in the order of the enum.
    pub const ALL: &'static [ErrorKind] = &[
        Self::Certificate,
        Self::NoTls,
        Self::Auth,
        Self::NotFound,
        Self::TooLarge,
        Self::ImapUnavailable,
        Self::RateLimited,
        Self::Paused,
        Self::CacheTooNew,
        Self::FolderChanged,
        Self::NoRights,
        Self::Network,
        Self::Other,
        Self::Io,
        Self::Extension,
        Self::BadRequest,
        Self::Input,
        Self::Keyring,
        Self::SaveFolder,
        Self::Dangerous,
        Self::Unsupported,
        Self::Print,
        Self::Cancelled,
        Self::Window,
        Self::NotAFile,
        Self::NotAPicture,
        Self::Update,
        Self::NotChosen,
        Self::CopyFiled,
        Self::Superseded,
    ];

    /// The code the interface receives.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Certificate => "certificate",
            Self::NoTls => "no-tls",
            Self::Auth => "auth",
            Self::NotFound => "not-found",
            Self::TooLarge => "too-large",
            Self::ImapUnavailable => "imap-unavailable",
            Self::RateLimited => "rate-limited",
            Self::Paused => "paused",
            Self::CacheTooNew => "cache-too-new",
            Self::FolderChanged => "folder-changed",
            Self::NoRights => "no-rights",
            Self::Network => "network",
            Self::Other => "other",
            Self::Io => "io",
            Self::Extension => "extension",
            Self::BadRequest => "bad-request",
            Self::Input => "input",
            Self::Keyring => "keyring",
            Self::SaveFolder => "save-folder",
            Self::Dangerous => "dangerous",
            Self::Unsupported => "unsupported",
            Self::Print => "print",
            Self::Cancelled => "cancelled",
            Self::Window => "window",
            Self::NotAFile => "not-a-file",
            Self::NotAPicture => "not-a-picture",
            Self::Update => "update",
            Self::NotChosen => "not-chosen",
            Self::CopyFiled => "copy-filed",
            Self::Superseded => "superseded",
        }
    }
}

impl Error {
    /// Worth retrying later without user action: network trouble and SMTP 4xx.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Io(_) | Self::Timeout(_) | Self::Closed | Self::Bye(_) => true,
            Self::Smtp { code, .. } | Self::SmtpHello { code, .. } => (400..500).contains(code),
            Self::Ews { code, .. } => matches!(
                code.as_str(),
                "ErrorServerBusy"
                    | "ErrorTimeoutExpired"
                    | "ErrorConnectionFailed"
                    | "ErrorInternalServerTransientError"
                    | "ErrorMailboxStoreUnavailable"
                    | "ErrorMailboxMoveInProgress"
                    | "ErrorBatchProcessingStopped"
            ),
            Self::Busy { .. } => true,
            Self::Said(s) => s.class() == Class::Transient,
            Self::Imap(async_imap::error::Error::Io(_) | async_imap::error::Error::ConnectionLost) => true,
            _ => false,
        }
    }

    /// Worth trying again later rather than giving up on: the errors a return of waiting
    /// letters meets that say "not now" — the mailbox is paused until its settings are
    /// fixed, the login was refused, Exchange is busy, the folder is busy or locked
    /// (`[INUSE]`/`[UNAVAILABLE]`), or a limit was hit. Everything `is_transient` is here.
    pub fn retry_later(&self) -> bool {
        if self.is_transient() {
            return true;
        }
        match self {
            Self::Paused | Self::Auth(_) | Self::AuthMechanism(_) | Self::HttpAuth(_) | Self::Busy { .. } => true,
            Self::Said(s) => s.class() == Class::Auth,
            Self::Imap(e) => {
                let raw = match e {
                    async_imap::error::Error::No(m) | async_imap::error::Error::Bad(m) => m,
                    _ => return false,
                };
                let upper = raw.to_ascii_uppercase();
                ["INUSE", "UNAVAILABLE", "OVERQUOTA", "TRYAGAIN", "LIMIT"]
                    .iter()
                    .any(|code| upper.contains(code))
            }
            Self::Ews { code, .. } => matches!(
                code.as_str(),
                "ErrorQuotaExceeded"
                    | "ErrorExceededConnectionCount"
                    | "ErrorExceededSubscriptionCount"
                    | "ErrorExceededFindCountLimit"
                    | "ErrorMailboxStoreUnavailable"
            ),
            _ => false,
        }
    }

    /// The server says the folder the letters wait in is gone: no retry can bring them
    /// back, so the user is told to return them by hand — Exchange's `ErrorFolderNotFound`,
    /// or an IMAP refusal that names a missing mailbox.
    pub fn folder_gone(&self) -> bool {
        match self {
            Self::Ews { code, .. } => code == "ErrorFolderNotFound",
            Self::Imap(async_imap::error::Error::No(m) | async_imap::error::Error::Bad(m)) => {
                let upper = m.to_ascii_uppercase();
                upper.contains("NONEXISTENT")
                    || upper.contains("MAILBOX DOES NOT EXIST")
                    || upper.contains("DOES NOT EXIST")
                    || upper.contains("NO SUCH MAILBOX")
                    || upper.contains("NO SUCH FOLDER")
                    || upper.contains("MAILBOX NOT FOUND")
                    || upper.contains("FOLDER NOT FOUND")
            }
            _ => false,
        }
    }

    /// The server's answer to filing a copy in «Sent» (the APPEND and the search for the copy
    /// before it) that is counted as a refusal: any IMAP `NO` or `BAD`, with a code or
    /// without, and our own `TooLarge`. Even a code that says "later" (`[INUSE]`,
    /// `[UNAVAILABLE]`, `[TRYAGAIN]`, `[LOCKED]`, `[LIMIT]`, `[SERVERBUG]`) is one: three
    /// answers in a row over some eight hours are a reason to ask the user, and the hold
    /// loses nothing. Only a failure of the connection itself — network, timeout, drop,
    /// TLS, a paused mailbox — is not a refusal and is retried without the count.
    pub fn append_refused(&self) -> bool {
        match self {
            Self::TooLarge { .. } => true,
            Self::Imap(async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_)) => true,
            Self::Ews { code, .. } => matches!(
                code.as_str(),
                "ErrorQuotaExceeded" | "ErrorFolderNotFound" | "ErrorMessageSizeExceeded"
            ),
            _ => false,
        }
    }

    /// Exchange throttles the client (`ErrorServerBusy`): the connection is fine,
    /// the next request must wait (`back_off`).
    pub fn is_busy(&self) -> bool {
        matches!(self, Self::Ews { code, .. } if code == "ErrorServerBusy")
    }

    /// Exchange refused an update because the item changed since it was read
    /// (`ErrorIrresolvableConflict`): the caller re-reads it and tries once more.
    pub fn is_conflict(&self) -> bool {
        matches!(self, Self::Ews { code, .. } if code == "ErrorIrresolvableConflict")
    }

    /// The pause the server asked for before the next request, if it named one.
    pub fn back_off(&self) -> Option<Duration> {
        match self {
            Self::Ews { back_off, .. } => *back_off,
            Self::Busy { wait, .. } => Some(*wait),
            _ => None,
        }
    }

    /// The server refused an action for lack of rights, not because of an error: an IMAP
    /// `NO [NOPERM]`/`[READ-ONLY]`, or Exchange's `ErrorAccessDenied` ([MS-OXWSCORE]).
    /// The folder remembers it, and the button turns off until rights change (#42, frame 8).
    pub fn no_rights(&self) -> bool {
        match self {
            Self::Imap(e) => {
                let raw = match e {
                    async_imap::error::Error::No(m) | async_imap::error::Error::Bad(m) => m,
                    _ => return false,
                };
                // The code may be in the response code (`code: Some(NOPERM)`) or in the
                // server's words; check both.
                let upper = raw.to_ascii_uppercase();
                upper.contains("NOPERM") || upper.contains("READ-ONLY") || upper.contains("READONLY")
            }
            Self::Ews { code, .. } => code == "ErrorAccessDenied",
            _ => false,
        }
    }

    /// The code of the error for the interface.
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Certificate(_) => ErrorKind::Certificate,
            Self::NoTls => ErrorKind::NoTls,
            Self::Auth(_) | Self::AuthMechanism(_) | Self::HttpAuth(_) => ErrorKind::Auth,
            Self::Said(s) if s.class() == Class::Auth => ErrorKind::Auth,
            Self::Ews { code, .. } if code == "ErrorItemNotFound" => ErrorKind::NotFound,
            Self::Ews { code, .. } if code == "ErrorMessageSizeExceeded" => ErrorKind::TooLarge,
            Self::ImapUnavailable => ErrorKind::ImapUnavailable,
            Self::Smtp {
                code: 421,
                enhanced: Some(e),
                ..
            } if e == "4.4.2" => ErrorKind::RateLimited,
            Self::TooLarge { .. } => ErrorKind::TooLarge,
            Self::NotFound => ErrorKind::NotFound,
            Self::Paused => ErrorKind::Paused,
            Self::CacheTooNew { .. } => ErrorKind::CacheTooNew,
            Self::FolderChanged => ErrorKind::FolderChanged,
            // A refusal for lack of rights, not an error: the folder remembers it (#42).
            e if e.no_rights() => ErrorKind::NoRights,
            e if e.is_transient() => ErrorKind::Network,
            _ => ErrorKind::Other,
        }
    }
}

/// What a failed IMAP command or connection comes to, for the edge that words it.
pub enum ImapFault {
    Refused(String),
    NotAccepted(String),
    ConnectionLost,
    Other(String),
}

impl Error {
    /// The IMAP error told apart for wording: `Io` is the one `Error::Io` also has.
    pub fn imap_fault(&self) -> Option<Result<ImapFault, &std::io::Error>> {
        use async_imap::error::Error as E;
        let Self::Imap(e) = self else { return None };
        Some(match e {
            E::No(m) => Ok(ImapFault::Refused(crate::imap::server_text(m))),
            E::Bad(m) => Ok(ImapFault::NotAccepted(crate::imap::server_text(m))),
            E::Io(io) => Err(io),
            E::ConnectionLost => Ok(ImapFault::ConnectionLost),
            other => Ok(ImapFault::Other(other.to_string())),
        })
    }
}

fn offers_text(offers: &str) -> &str {
    if offers.is_empty() { "nothing" } else { offers }
}

fn imap_text(e: &async_imap::error::Error) -> String {
    use async_imap::error::Error as E;
    match e {
        E::No(m) => format!("refused: {}", crate::imap::server_text(m)),
        E::Bad(m) => format!("command not accepted: {}", crate::imap::server_text(m)),
        E::Io(io) => io_text(io),
        E::ConnectionLost => "the connection to the server broke".to_owned(),
        other => other.to_string(),
    }
}

fn io_text(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let text = e.to_string();
    match e.kind() {
        K::ConnectionRefused => "the server refuses connections (the port is closed or the server is down)".to_owned(),
        K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe | K::UnexpectedEof => {
            "the connection to the server broke".to_owned()
        }
        K::TimedOut => "the server did not answer in time".to_owned(),
        K::NetworkUnreachable | K::HostUnreachable => "no network, or the server is unreachable".to_owned(),
        _ if text.contains("lookup address") || text.contains("Name or service not known") => {
            "server not found: check its name (DNS)".to_owned()
        }
        _ => format!("network: {text}"),
    }
}

/// Whole seconds of a pause, rounded up: "0 s" would read as no pause.
pub fn seconds(d: Duration) -> u64 {
    d.as_millis().div_ceil(1000).max(1) as u64
}

fn busy_text(wait: Duration, retrying: bool) -> String {
    let n = seconds(wait);
    if retrying {
        format!("the Exchange server is busy; the mailbox will try again in {n} s")
    } else {
        format!("the Exchange server is busy; nothing was done, try again in {n} s")
    }
}

/// What an Exchange response code the program knows by name means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EwsMeaning {
    ItemGone,
    FolderGone,
    TooLarge,
    SendAsDenied,
    MailboxFull,
    AccessDenied,
}

impl EwsMeaning {
    pub fn of(code: &str) -> Option<Self> {
        Some(match code {
            "ErrorItemNotFound" => Self::ItemGone,
            "ErrorFolderNotFound" => Self::FolderGone,
            "ErrorMessageSizeExceeded" => Self::TooLarge,
            "ErrorSendAsDenied" => Self::SendAsDenied,
            "ErrorQuotaExceeded" => Self::MailboxFull,
            "ErrorAccessDenied" => Self::AccessDenied,
            _ => return None,
        })
    }

    pub fn english(self) -> &'static str {
        match self {
            Self::ItemGone => "the message is no longer on the server",
            Self::FolderGone => "the folder is no longer on the server",
            Self::TooLarge => "the message is too large for the server",
            Self::SendAsDenied => "no right to send on behalf of this address (Send As)",
            Self::MailboxFull => "the mailbox is full",
            Self::AccessDenied => "access denied",
        }
    }
}

fn ews_text(code: &str, message: &str, back_off: Option<Duration>) -> String {
    if code == "ErrorServerBusy" {
        // Whether and when the request is repeated is the caller's business (`Busy`).
        return match back_off {
            Some(d) => format!(
                "the server is busy and asks to wait {} s (Exchange: {code})",
                seconds(d)
            ),
            None => format!("the server is busy (Exchange: {code})"),
        };
    }
    match EwsMeaning::of(code) {
        Some(m) => format!("{} (Exchange: {code})", m.english()),
        None => format!("Exchange answered {code}: {message}"),
    }
}

/// What an SMTP reply means, by its code and its enhanced status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpMeaning {
    RateLimited,
    SendAsDenied,
    WrongLogin,
    LoginRequired,
    TooLarge,
    NoSuchRecipient,
    Refused,
    Temporary,
}

impl SmtpMeaning {
    pub fn of(code: u16, enhanced: Option<&str>) -> Option<Self> {
        Some(match (code, enhanced.unwrap_or_default()) {
            (421, "4.4.2") => Self::RateLimited,
            (_, "5.7.60") => Self::SendAsDenied,
            (535, _) | (_, "5.7.3") | (_, "5.7.8") => Self::WrongLogin,
            (530, _) | (_, "5.7.57") => Self::LoginRequired,
            (552, _) | (_, "5.3.4") => Self::TooLarge,
            (_, "5.1.1") | (_, "5.1.10") => Self::NoSuchRecipient,
            (_, "5.7.1") => Self::Refused,
            (c, _) if (400..500).contains(&c) => Self::Temporary,
            _ => return None,
        })
    }

    pub fn english(self) -> &'static str {
        match self {
            Self::RateLimited => {
                "the server limits the sending rate (Exchange allows 5 messages a minute by default); the message will go later"
            }
            Self::SendAsDenied => "no right to send on behalf of this address (Send As)",
            Self::WrongLogin => "wrong user name or password",
            Self::LoginRequired => "the server requires a login before sending",
            Self::TooLarge => "the message is too large for the server",
            Self::NoSuchRecipient => "the recipient address does not exist",
            Self::Refused => "the server refused the message (no permission, or rejected by policy)",
            Self::Temporary => "temporary server error, the message will go later",
        }
    }
}

fn smtp_text(code: u16, enhanced: Option<&str>, message: &str) -> String {
    match SmtpMeaning::of(code, enhanced) {
        Some(m) => format!("{} (server: {code} {message})", m.english()),
        None => format!("the server answered {code}: {message}"),
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;
    use async_imap::error::Error as E;

    #[test]
    fn a_refusal_for_lack_of_rights_is_told_from_an_error() {
        // IMAP says so in the response code (RFC 5530): the folder remembers the ban.
        assert!(Error::Imap(E::No(r#"code: Some(NOPERM), info: Some("no rights")"#.into())).no_rights());
        assert!(
            Error::Imap(E::No(
                r#"code: Some(READ-ONLY), info: Some("mailbox is read-only")"#.into()
            ))
            .no_rights()
        );
        // Exchange's own word for it ([MS-OXWSCORE]).
        assert!(
            Error::Ews {
                code: "ErrorAccessDenied".into(),
                message: String::new(),
                back_off: None
            }
            .no_rights()
        );
        // A plain error is neither: no ban is remembered.
        assert!(!Error::Imap(E::No("code: None, info: Some(\"Internal error\")".into())).no_rights());
        assert!(!Error::Imap(E::Bad("code: None, info: Some(\"bad command\")".into())).no_rights());
        assert!(
            !Error::Ews {
                code: "ErrorInternalServerError".into(),
                message: String::new(),
                back_off: None
            }
            .no_rights()
        );
        assert!(!Error::Timeout("MYRIGHTS answer").no_rights());
    }

    /// The strings the interface got before `ErrorKind` was an enum: each is one variant, and
    /// no variant is left without its string.
    #[test]
    fn every_kind_the_interface_knew_is_one_variant() {
        let known = [
            "certificate",
            "no-tls",
            "auth",
            "not-found",
            "too-large",
            "imap-unavailable",
            "rate-limited",
            "paused",
            "cache-too-new",
            "folder-changed",
            "no-rights",
            "network",
            "other",
            "io",
            "extension",
            "bad-request",
            "input",
            "keyring",
            "save-folder",
            "dangerous",
            "unsupported",
            "print",
            "cancelled",
            "window",
            "not-a-file",
            "not-a-picture",
            "update",
            "not-chosen",
            "copy-filed",
            "superseded",
        ];
        for s in known {
            let hits = ErrorKind::ALL.iter().filter(|k| k.as_str() == s).count();
            assert_eq!(hits, 1, "{s}");
        }
        assert_eq!(ErrorKind::ALL.len(), known.len());
        for k in ErrorKind::ALL {
            assert_eq!(serde_json::to_string(k).unwrap(), format!("\"{}\"", k.as_str()));
        }
    }

    #[test]
    fn a_rights_refusal_has_its_own_kind() {
        // The GUI shows one of three notices per kind (#42, frame 8): no rights, an error,
        // no answer. A refusal for lack of rights is told apart by the kind alone.
        assert_eq!(
            Error::Imap(E::No("code: Some(NOPERM), info: Some(\"no rights\")".into())).kind(),
            ErrorKind::NoRights
        );
        assert_eq!(
            Error::Ews {
                code: "ErrorAccessDenied".into(),
                message: String::new(),
                back_off: None
            }
            .kind(),
            ErrorKind::NoRights
        );
        // A plain server error, and a network trouble, keep their own kinds.
        assert_eq!(
            Error::Imap(E::No("code: None, info: Some(\"Internal error\")".into())).kind(),
            ErrorKind::Other
        );
        assert_eq!(Error::Timeout("answer").kind(), ErrorKind::Network);
        assert_eq!(Error::Closed.kind(), ErrorKind::Network);
    }

    #[test]
    fn a_return_of_waiting_letters_waits_out_a_pause_or_a_refusal() {
        // "Not now" errors: the return is tried again, not given up on.
        assert!(Error::Paused.retry_later());
        assert!(Error::Auth("wrong password".into()).retry_later());
        assert!(
            Error::Busy {
                wait: Duration::from_secs(5),
                retrying: false
            }
            .retry_later()
        );
        assert!(Error::Timeout("move").retry_later());
        // RFC 5530 response codes for a folder in use or temporarily unavailable, and limits.
        assert!(Error::Imap(E::No("code: Some(INUSE), info: Some(\"mailbox in use\")".into())).retry_later());
        assert!(Error::Imap(E::No("code: Some(UNAVAILABLE), info: Some(\"try later\")".into())).retry_later());
        assert!(Error::Imap(E::No("code: Some(OVERQUOTA), info: Some(\"over quota\")".into())).retry_later());
        assert!(
            Error::Ews {
                code: "ErrorQuotaExceeded".into(),
                message: String::new(),
                back_off: None
            }
            .retry_later()
        );
        // A refusal that is not one of these is not "try later", and neither is a protocol error.
        assert!(!Error::Protocol("unexpected".into()).retry_later());
    }

    #[test]
    fn a_missing_folder_is_told_from_a_mere_refusal() {
        assert!(
            Error::Ews {
                code: "ErrorFolderNotFound".into(),
                message: String::new(),
                back_off: None
            }
            .folder_gone()
        );
        assert!(Error::Imap(E::No("NO [NONEXISTENT] Mailbox does not exist".into())).folder_gone());
        for m in ["No such mailbox", "Mailbox not found: Work", "Folder not found"] {
            assert!(Error::Imap(E::No(m.into())).folder_gone(), "{m}");
        }
        for m in [
            "[SERVERBUG] Internal error",
            "[LOCKED] locked",
            "[CONTACTADMIN] call",
            "[CANNOT] no",
            "STATUS failed",
        ] {
            assert!(!Error::Imap(E::No(m.into())).folder_gone(), "{m}");
        }
        // A refusal that does not say the folder is gone is not "gone": it is retried.
        assert!(!Error::Imap(E::No("code: Some(INUSE), info: Some(\"in use\")".into())).folder_gone());
        assert!(!Error::Paused.folder_gone());
        assert!(!Error::Protocol("unexpected".into()).folder_gone());
    }

    #[test]
    fn a_refused_append_is_told_from_a_connection_trouble() {
        let no = |m: &str| Error::Imap(E::No(m.into()));
        assert!(no("code: Some(OVERQUOTA), info: Some(\"Mailbox is full\")").append_refused());
        assert!(no("[TRYCREATE] Mailbox doesn't exist: Sent").append_refused());
        assert!(no("code: Some(TOOBIG), info: Some(\"too large\")").append_refused());
        assert!(no("[NONEXISTENT] Mailbox does not exist").append_refused());
        assert!(no("[NOPERM] Access denied").append_refused());
        assert!(Error::Imap(E::Bad("[TOOBIG] too large".into())).append_refused());
        assert!(
            no("outcome: Outcome { code: None, information: Some(\"EXAMINE failed. No such mailbox\") }")
                .append_refused()
        );
        // No code, or a code that says "later": still a refusal, the count decides.
        assert!(Error::Imap(E::Bad("bad command".into())).append_refused());
        assert!(no("Mailbox is busy").append_refused());
        assert!(no("APPEND failed").append_refused());
        assert!(no("[LIMIT] too many connections").append_refused());
        assert!(no("[SERVERBUG] oops").append_refused());
        assert!(no("[ALERT] maintenance").append_refused());
        assert!(no("[TRYAGAIN] later").append_refused());
        assert!(no("[LOCKED] locked").append_refused());
        assert!(Error::TooLarge { size: 2, limit: 1 }.append_refused());
        assert!(no("code: Some(INUSE), info: Some(\"in use\")").append_refused());
        assert!(no("code: Some(UNAVAILABLE), info: Some(\"later\")").append_refused());
        // Only the connection's own trouble passes.
        assert!(!Error::Timeout("operation").append_refused());
        assert!(!Error::Closed.append_refused());
        assert!(!Error::Paused.append_refused());
        assert!(!Error::Io(std::io::Error::new(std::io::ErrorKind::NetworkUnreachable, "x")).append_refused());
        assert_eq!(Error::CopyRefused("full".into()).to_string(), "full");
        assert!(!Error::CopyRefused("full".into()).is_transient());
    }
}
