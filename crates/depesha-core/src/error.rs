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
    Protocol(String),
    NotFound,
    Parse,
    /// Exchange Web Services refused a request: `ResponseCode` and `MessageText`.
    Ews {
        code: String,
        message: String,
    },
    /// The web server offers none of the login methods we speak (EWS without Basic).
    HttpAuth(String),
    /// The mailbox waits for the user (a wrong password): background work does not
    /// knock on the server meanwhile.
    Paused,
    /// A link from a letter leads into a private network (loopback, LAN, link-local…):
    /// Depesha does not go there on a stranger's word.
    PrivateAddress(String),
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
            Self::Paused => tr!(
                "the mailbox is paused until its settings are fixed",
                "ящик приостановлен, пока не исправлены его настройки"
            ),
            Self::Protocol(m) => tr!(
                "unexpected answer from the server: {m}",
                "сервер ответил непонятно: {m}"
            ),
            Self::NotFound => tr!("message not found", "письмо не найдено"),
            Self::Parse => tr!("the message could not be parsed", "не удалось разобрать письмо"),
            Self::PrivateAddress(host) => tr!(
                "{host} is an address in a private network; Depesha does not send requests there from a letter",
                "{host} — адрес во внутренней сети; по ссылке из письма Депеша туда не обращается"
            ),
            Self::Ews { code, message } => ews_text(code, message),
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
            Self::Io(_) | Self::Timeout(_) | Self::Closed => true,
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
            Self::Imap(async_imap::error::Error::Io(_) | async_imap::error::Error::ConnectionLost) => true,
            _ => false,
        }
    }

    /// Short machine-readable kind for the GUI.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Certificate(_) => "certificate",
            Self::NoTls => "no-tls",
            Self::Auth(_) | Self::AuthMechanism(_) | Self::HttpAuth(_) => "auth",
            Self::Ews { code, .. } if code == "ErrorItemNotFound" => "not-found",
            Self::Ews { code, .. } if code == "ErrorMessageSizeExceeded" => "too-large",
            Self::ImapUnavailable => "imap-unavailable",
            Self::Smtp {
                code: 421,
                enhanced: Some(e),
                ..
            } if e == "4.4.2" => "rate-limited",
            Self::TooLarge { .. } => "too-large",
            Self::NotFound => "not-found",
            Self::Paused => "paused",
            e if e.is_transient() => "network",
            _ => "other",
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

fn ews_text(code: &str, message: &str) -> String {
    use crate::lang::pick;
    let explained = match code {
        "ErrorServerBusy" => pick(
            "the server is busy, will try again later",
            "сервер занят, попробуем позже",
        ),
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
