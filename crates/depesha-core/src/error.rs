use std::time::Duration;

use crate::tls::CertProblem;
use crate::tr;

/// Errors are worded for the end user in the current language (`lang`): the GUI shows them as is.
#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Timeout(&'static str),
    Tls(tokio_rustls::rustls::Error),
    Certificate(Box<CertProblem>),
    NoTls,
    InvalidHost(String),
    Auth(String),
    AuthMechanism(String),
    ImapUnavailable,
    Imap(async_imap::error::Error),
    Smtp {
        code: u16,
        enhanced: Option<String>,
        message: String,
    },
    /// The SMTP server refused our EHLO: it judges the client by the name it gives.
    SmtpHello {
        name: String,
        code: u16,
        message: String,
    },
    TooLarge {
        size: usize,
        limit: u64,
    },
    Compose(String),
    Store(rusqlite::Error),
    Closed,
    /// The server said `* BYE` with this text (sent as it was worded) and closed the connection.
    Bye(String),
    Protocol(String),
    NotFound,
    Parse,
    /// A value of the local cache does not parse (#146); the log names the row, never the content.
    Unreadable,
    /// Exchange Web Services refused a request: `ResponseCode` and `MessageText`;
    /// `back_off` is the pause a throttled request (`ErrorServerBusy`) is asked to
    /// keep, `BackOffMilliseconds` of its `MessageXml`.
    Ews {
        code: String,
        message: String,
        back_off: Option<Duration>,
    },
    /// Exchange is busy and the mailbox's queue sends nothing for `wait`: `retrying`
    /// when the queue repeats the request itself, otherwise the action was not done.
    Busy {
        wait: Duration,
        retrying: bool,
    },
    /// The web server offers none of the login methods we speak (EWS without Basic).
    HttpAuth(String),
    /// The mailbox waits for the user (a wrong password): background work does not
    /// knock on the server meanwhile.
    Paused,
    /// A link from a letter leads into a private network (loopback, LAN, link-local…):
    /// Depesha does not go there on a stranger's word.
    PrivateAddress(String),
    /// The local cache was written by a newer version: its format number and the
    /// newest this version knows. The cache is left as it is.
    CacheTooNew {
        found: i64,
        known: i64,
    },
    /// The server renumbered the folder (a new UIDVALIDITY, or an Exchange folder
    /// cached anew) after the UIDs of an action were read: they name other messages.
    FolderChanged,
    /// The label is being taken off every letter: a new one by the same name would have its
    /// keyword stripped with the rest.
    LabelStripping,
    /// The label check cannot run here: without UIDPLUS its test letter could not be
    /// expunged by UID, so it would stay behind. Depesha does not run it.
    LabelCheckUnsupported,
    /// The server refuses to file the copy of a sent letter in «Sent» (see `append_refused`); the text is the refusal as it was worded.
    CopyRefused(String),
}

/// What the interface branches on when a call fails: the stable code of an error, the same
/// string on the wire (`as_str`) as before it was an enum. Several belong to the interface
/// alone (`Extension`, `Print`…); the core names them so the whole set is in one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
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

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::Io(e) => io_text(e),
            Self::Timeout(what) => {
                tr!(
                    "the server did not answer in time ({})",
                    "сервер не ответил вовремя ({})",
                    timeout_label(what)
                )
            }
            Self::Tls(e) => format!("TLS: {e}"),
            Self::Certificate(p) => tr!(
                "untrusted certificate {}: {}",
                "недоверенный сертификат {}: {}",
                p.host,
                p.reason
            ),
            Self::NoTls => tr!(
                "the server does not support encryption (STARTTLS); the password was not sent",
                "сервер не поддерживает шифрование (STARTTLS); пароль не отправлен"
            ),
            Self::InvalidHost(h) => tr!("invalid server name: {h}", "неверное имя сервера: {h}"),
            Self::Auth(m) => tr!("the server rejected the login: {m}", "сервер отклонил вход: {m}"),
            Self::AuthMechanism(m) => tr!(
                "the server offers no supported login method (offers: {m}); PLAIN or LOGIN is needed",
                "сервер не предлагает поддерживаемый способ входа (предлагает: {m}); нужен PLAIN или LOGIN"
            ),
            Self::ImapUnavailable => tr!(
                "the server accepted the password but did not open the mailbox over IMAP. On Exchange: \
                 IMAP is off for the mailbox (ImapEnabled) or the MSExchangeIMAP4BE service is not running",
                "сервер принял пароль, но не открыл ящик по IMAP. На Exchange: для ящика выключен IMAP \
                 (ImapEnabled) или не запущена служба MSExchangeIMAP4BE"
            ),
            Self::Imap(e) => format!("IMAP: {}", imap_text(e)),
            Self::Smtp {
                code,
                enhanced,
                message,
            } => smtp_text(*code, enhanced.as_deref(), message),
            Self::SmtpHello { name, code, message } => tr!(
                "the server did not accept the client's greeting (EHLO {name}), before any login: {code} {message}",
                "сервер не принял приветствие клиента (EHLO {name}) ещё до входа: {code} {message}"
            ),
            Self::TooLarge { size, limit } => tr!(
                "the message is {size} bytes, over the server's limit of {limit} bytes",
                "письмо {size} байт больше лимита сервера {limit} байт"
            ),
            Self::Compose(m) => tr!("the message could not be built: {m}", "письмо не собрано: {m}"),
            Self::Store(e) => tr!("local database: {e}", "локальная база: {e}"),
            Self::Closed => tr!("the server closed the connection", "сервер закрыл соединение"),
            Self::Bye(text) => tr!(
                "the server closed the connection: {}",
                "сервер закрыл соединение: {}",
                text
            ),
            Self::Paused => tr!(
                "the mailbox is paused until its settings are fixed",
                "ящик приостановлен, пока не исправлены его настройки"
            ),
            Self::Protocol(m) => tr!(
                "unexpected answer from the server: {m}",
                "сервер ответил непонятно: {m}"
            ),
            Self::NotFound => tr!("message not found", "письмо не найдено"),
            Self::Unreadable => tr!("stored data could not be read", "сохранённые данные не читаются"),
            Self::CacheTooNew { found, known } => tr!(
                "the local mail cache was saved by a newer version of Depesha (format {found}, this version \
                 reads up to {known}). Install the newer version; the cache was left as it is",
                "локальный кэш почты сохранён более новой версией Депеши (формат {found}, эта версия \
                 читает до {known}). Установите новую версию; кэш оставлен как есть"
            ),
            Self::FolderChanged => tr!(
                "the folder changed on the server before the action ran; nothing was done, try again",
                "папка изменилась на сервере, пока действие ждало очереди; ничего не сделано, повторите действие"
            ),
            Self::LabelStripping => tr!(
                "The label is still being removed, try again in a minute",
                "Метка ещё удаляется, попробуйте через минуту"
            ),
            Self::LabelCheckUnsupported => tr!(
                "this server has no UIDPLUS: the label check cannot remove its test letter, so it is not run",
                "на этом сервере нет UIDPLUS: проверка меток не сможет удалить тестовое письмо, поэтому она не выполняется"
            ),
            Self::CopyRefused(text) => text.clone(),
            Self::Parse => tr!("the message could not be parsed", "не удалось разобрать письмо"),
            Self::PrivateAddress(host) => tr!(
                "{host} is an address in a private network; Depesha does not send requests there from a letter",
                "{host} — адрес во внутренней сети; по ссылке из письма Депеша туда не обращается"
            ),
            Self::Ews {
                code,
                message,
                back_off,
            } => ews_text(code, message, *back_off),
            Self::Busy { wait, retrying: true } => {
                let n = seconds(*wait);
                tr!(
                    "the Exchange server is busy; the mailbox will try again in {n} s",
                    "сервер Exchange занят; ящик повторит запрос через {n} с"
                )
            }
            Self::Busy { wait, retrying: false } => {
                let n = seconds(*wait);
                tr!(
                    "the Exchange server is busy; nothing was done, try again in {n} s",
                    "сервер Exchange занят; ничего не сделано, повторите через {n} с"
                )
            }
            Self::HttpAuth(offered) => tr!(
                "Exchange accepts only {offered} on EWS; Depesha signs in with Basic or NTLM. Ask the administrator \
                 to enable one of them: Set-WebServicesVirtualDirectory -WindowsAuthentication $true",
                "Exchange принимает на EWS только {offered}, а Депеша входит через Basic или NTLM. Попросите \
                 администратора включить один из них: Set-WebServicesVirtualDirectory -WindowsAuthentication $true"
            ),
        };
        f.write_str(&text)
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Tls(e) => Some(e),
            Self::Imap(e) => Some(e),
            Self::Store(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<tokio_rustls::rustls::Error> for Error {
    fn from(e: tokio_rustls::rustls::Error) -> Self {
        Self::Tls(e)
    }
}

impl From<async_imap::error::Error> for Error {
    fn from(e: async_imap::error::Error) -> Self {
        Self::Imap(e)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::Store(e)
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

/// Timeout labels are English keys; Russian is chosen when displayed.
fn timeout_label(what: &str) -> &str {
    if !crate::lang::is_ru() {
        return what;
    }
    match what {
        "connecting" => "подключение",
        "server greeting" => "приветствие сервера",
        "search answer" => "ответ на поиск",
        "SMTP answer" => "ответ SMTP",
        "operation" => "операция",
        "connecting to the list server" => "подключение к серверу рассылки",
        "list server answer" => "ответ сервера рассылки",
        "HTTP answer" => "ответ HTTP",
        other => other,
    }
}

fn imap_text(e: &async_imap::error::Error) -> String {
    use async_imap::error::Error as E;
    match e {
        E::No(m) => tr!("refused: {}", "сервер отказал: {}", crate::imap::server_text(m)),
        E::Bad(m) => tr!(
            "command not accepted: {}",
            "сервер не принял команду: {}",
            crate::imap::server_text(m)
        ),
        E::Io(io) => io_text(io),
        E::ConnectionLost => tr!("the connection to the server broke", "соединение с сервером оборвалось"),
        other => other.to_string(),
    }
}

fn io_text(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let text = e.to_string();
    match e.kind() {
        K::ConnectionRefused => tr!(
            "the server refuses connections (the port is closed or the server is down)",
            "сервер не принимает соединения (порт закрыт или сервер выключен)"
        ),
        K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe | K::UnexpectedEof => {
            tr!("the connection to the server broke", "соединение с сервером оборвалось")
        }
        K::TimedOut => tr!("the server did not answer in time", "сервер не ответил вовремя"),
        K::NetworkUnreachable | K::HostUnreachable => {
            tr!(
                "no network, or the server is unreachable",
                "нет сети или сервер недоступен"
            )
        }
        _ if text.contains("lookup address") || text.contains("Name or service not known") => {
            tr!(
                "server not found: check its name (DNS)",
                "сервер не найден: проверьте имя (DNS)"
            )
        }
        _ => tr!("network: {text}", "сеть: {text}"),
    }
}

/// Whole seconds of a pause, rounded up: "0 s" would read as no pause.
fn seconds(d: Duration) -> u64 {
    d.as_millis().div_ceil(1000).max(1) as u64
}

fn ews_text(code: &str, message: &str, back_off: Option<Duration>) -> String {
    use crate::lang::pick;
    if code == "ErrorServerBusy" {
        // Whether and when the request is repeated is the caller's business (`Busy`).
        return match back_off {
            Some(d) => {
                let n = seconds(d);
                tr!(
                    "the server is busy and asks to wait {n} s (Exchange: {code})",
                    "сервер занят и просит подождать {n} с (Exchange: {code})"
                )
            }
            None => tr!(
                "the server is busy (Exchange: {code})",
                "сервер занят (Exchange: {code})"
            ),
        };
    }
    let explained = match code {
        "ErrorItemNotFound" => pick("the message is no longer on the server", "письма уже нет на сервере"),
        "ErrorFolderNotFound" => pick("the folder is no longer on the server", "папки уже нет на сервере"),
        "ErrorMessageSizeExceeded" => pick(
            "the message is too large for the server",
            "письмо слишком большое для сервера",
        ),
        "ErrorSendAsDenied" => pick(
            "no right to send on behalf of this address (Send As)",
            "нет права отправлять от имени этого адреса (Send As)",
        ),
        "ErrorQuotaExceeded" => pick("the mailbox is full", "ящик переполнен"),
        "ErrorAccessDenied" => pick("access denied", "доступ запрещён"),
        _ => "",
    };
    if explained.is_empty() {
        tr!(
            "Exchange answered {code}: {message}",
            "Exchange ответил {code}: {message}"
        )
    } else {
        tr!("{explained} (Exchange: {code})", "{explained} (Exchange: {code})")
    }
}

fn smtp_text(code: u16, enhanced: Option<&str>, message: &str) -> String {
    use crate::lang::pick;
    let explained = match (code, enhanced.unwrap_or_default()) {
        (421, "4.4.2") => pick(
            "the server limits the sending rate (Exchange allows 5 messages a minute by default); the message will go later",
            "сервер ограничил частоту отправки (у Exchange по умолчанию 5 писем в минуту); письмо уйдёт позже",
        ),
        (_, "5.7.60") => pick(
            "no right to send on behalf of this address (Send As)",
            "нет права отправлять от имени этого адреса (Send As)",
        ),
        (535, _) | (_, "5.7.3") | (_, "5.7.8") => pick("wrong user name or password", "неверный логин или пароль"),
        (530, _) | (_, "5.7.57") => pick(
            "the server requires a login before sending",
            "сервер требует входа перед отправкой",
        ),
        (552, _) | (_, "5.3.4") => pick(
            "the message is too large for the server",
            "письмо слишком большое для сервера",
        ),
        (_, "5.1.1") | (_, "5.1.10") => pick("the recipient address does not exist", "адрес получателя не существует"),
        (_, "5.7.1") => pick(
            "the server refused the message (no permission, or rejected by policy)",
            "сервер отказался принять письмо (нет прав или письмо отклонено политикой)",
        ),
        (c, _) if (400..500).contains(&c) => pick(
            "temporary server error, the message will go later",
            "временная ошибка сервера, письмо уйдёт позже",
        ),
        _ => "",
    };
    if explained.is_empty() {
        tr!(
            "the server answered {code}: {message}",
            "сервер ответил {code}: {message}"
        )
    } else {
        tr!(
            "{explained} (server: {code} {message})",
            "{explained} (сервер: {code} {message})"
        )
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
