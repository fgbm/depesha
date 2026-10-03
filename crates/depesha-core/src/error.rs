use crate::tls::CertProblem;

/// Errors are worded for the end user: the GUI shows them as is.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{}", io_text(.0))]
    Io(#[from] std::io::Error),
    #[error("сервер не ответил вовремя ({0})")]
    Timeout(&'static str),
    #[error("TLS: {0}")]
    Tls(#[from] tokio_rustls::rustls::Error),
    #[error("недоверенный сертификат {}: {}", .0.host, .0.reason)]
    Certificate(Box<CertProblem>),
    #[error("сервер не поддерживает шифрование (STARTTLS); пароль не отправлен")]
    NoTls,
    #[error("неверное имя сервера: {0}")]
    InvalidHost(String),
    #[error("сервер отклонил вход: {0}")]
    Auth(String),
    #[error("сервер не предлагает поддерживаемый способ входа (предлагает: {0}); нужен PLAIN или LOGIN")]
    AuthMechanism(String),
    #[error(
        "сервер принял пароль, но не открыл ящик по IMAP. На Exchange: для ящика выключен IMAP \
         (ImapEnabled) или не запущена служба MSExchangeIMAP4BE"
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
    #[error("письмо {size} байт больше лимита сервера {limit} байт")]
    TooLarge { size: usize, limit: u64 },
    #[error("письмо не собрано: {0}")]
    Compose(String),
    #[error("локальная база: {0}")]
    Store(#[from] rusqlite::Error),
    #[error("сервер закрыл соединение")]
    Closed,
    #[error("сервер ответил непонятно: {0}")]
    Protocol(String),
    #[error("письмо не найдено")]
    NotFound,
    #[error("не удалось разобрать письмо")]
    Parse,
}

impl Error {
    /// Worth retrying later without user action: network trouble and SMTP 4xx.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Io(_) | Self::Timeout(_) | Self::Closed => true,
            Self::Smtp { code, .. } => (400..500).contains(code),
            Self::Imap(async_imap::error::Error::Io(_) | async_imap::error::Error::ConnectionLost) => true,
            _ => false,
        }
    }

    /// Short machine-readable kind for the GUI.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Certificate(_) => "certificate",
            Self::NoTls => "no-tls",
            Self::Auth(_) | Self::AuthMechanism(_) => "auth",
            Self::ImapUnavailable => "imap-unavailable",
            Self::Smtp {
                code: 421,
                enhanced: Some(e),
                ..
            } if e == "4.4.2" => "rate-limited",
            Self::TooLarge { .. } => "too-large",
            Self::NotFound => "not-found",
            e if e.is_transient() => "network",
            _ => "other",
        }
    }
}

fn imap_text(e: &async_imap::error::Error) -> String {
    use async_imap::error::Error as E;
    match e {
        E::No(m) => format!("сервер отказал: {}", crate::imap::server_text(m)),
        E::Bad(m) => format!("сервер не принял команду: {}", crate::imap::server_text(m)),
        E::Io(io) => io_text(io),
        E::ConnectionLost => "соединение с сервером оборвалось".into(),
        other => other.to_string(),
    }
}

fn io_text(e: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let text = e.to_string();
    match e.kind() {
        K::ConnectionRefused => "сервер не принимает соединения (порт закрыт или сервер выключен)".into(),
        K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe | K::UnexpectedEof => {
            "соединение с сервером оборвалось".into()
        }
        K::TimedOut => "сервер не ответил вовремя".into(),
        K::NetworkUnreachable | K::HostUnreachable => "нет сети или сервер недоступен".into(),
        _ if text.contains("lookup address") || text.contains("Name or service not known") => {
            "сервер не найден: проверьте имя (DNS)".into()
        }
        _ => format!("сеть: {text}"),
    }
}

fn smtp_text(code: u16, enhanced: Option<&str>, message: &str) -> String {
    let explained = match (code, enhanced.unwrap_or_default()) {
        (421, "4.4.2") => {
            "сервер ограничил частоту отправки (у Exchange по умолчанию 5 писем в минуту); письмо уйдёт позже"
        }
        (_, "5.7.60") => "нет права отправлять от имени этого адреса (Send As)",
        (535, _) | (_, "5.7.3") | (_, "5.7.8") => "неверный логин или пароль",
        (530, _) | (_, "5.7.57") => "сервер требует входа перед отправкой",
        (552, _) | (_, "5.3.4") => "письмо слишком большое для сервера",
        (_, "5.1.1") | (_, "5.1.10") => "адрес получателя не существует",
        (_, "5.7.1") => "сервер отказался принять письмо (нет прав или письмо отклонено политикой)",
        (c, _) if (400..500).contains(&c) => "временная ошибка сервера, письмо уйдёт позже",
        _ => "",
    };
    if explained.is_empty() {
        format!("сервер ответил {code}: {message}")
    } else {
        format!("{explained} (сервер: {code} {message})")
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
