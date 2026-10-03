use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// TLS from the first byte (IMAP 993, SMTP 465).
    Tls,
    /// Plain connection upgraded with STARTTLS (IMAP 143, SMTP 587).
    StartTls,
    /// No encryption. Only for local test servers.
    Plain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub security: Security,
    /// SHA-256 of a certificate the user explicitly trusted for this server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_cert: Option<String>,
}

impl ServerConfig {
    pub fn new(host: impl Into<String>, port: u16, security: Security) -> Self {
        Self {
            host: host.into(),
            port,
            security,
            trusted_cert: None,
        }
    }
}

/// Account settings without the password: the password lives in the OS keyring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub display_name: String,
    pub email: String,
    pub username: String,
    pub imap: ServerConfig,
    pub smtp: ServerConfig,
    /// Put a copy of sent mail into Sent. Off for servers that do it themselves (Gmail).
    #[serde(default = "yes")]
    pub save_sent_copy: bool,
    /// Added below new messages and replies, after the standard "-- " separator.
    #[serde(default)]
    pub signature: String,
}

fn yes() -> bool {
    true
}

#[derive(Clone)]
pub struct Credentials {
    pub username: String,
    password: String,
}

impl Credentials {
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            password: password.into(),
        }
    }

    pub fn password(&self) -> &str {
        &self.password
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .finish()
    }
}

/// Settings of well-known providers by mail domain.
pub fn known_provider(domain: &str) -> Option<(ServerConfig, ServerConfig)> {
    let (imap, smtp, smtp_port, smtp_security) = match domain.trim().to_ascii_lowercase().as_str() {
        "gmail.com" | "googlemail.com" => ("imap.gmail.com", "smtp.gmail.com", 465, Security::Tls),
        "yandex.ru" | "ya.ru" | "yandex.com" | "yandex.by" | "yandex.kz" | "narod.ru" => {
            ("imap.yandex.ru", "smtp.yandex.ru", 465, Security::Tls)
        }
        "mail.ru" | "bk.ru" | "inbox.ru" | "list.ru" | "internet.ru" | "vk.com" => {
            ("imap.mail.ru", "smtp.mail.ru", 465, Security::Tls)
        }
        "rambler.ru" | "lenta.ru" | "autorambler.ru" | "ro.ru" => {
            ("imap.rambler.ru", "smtp.rambler.ru", 465, Security::Tls)
        }
        "icloud.com" | "me.com" | "mac.com" => ("imap.mail.me.com", "smtp.mail.me.com", 587, Security::StartTls),
        _ => return None,
    };
    Some((
        ServerConfig::new(imap, 993, Security::Tls),
        ServerConfig::new(smtp, smtp_port, smtp_security),
    ))
}

pub fn domain_of(email: &str) -> Option<&str> {
    email
        .rsplit_once('@')
        .map(|(_, d)| d.trim())
        .filter(|d| !d.is_empty() && d.contains('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_providers() {
        let (imap, smtp) = known_provider("Yandex.RU").unwrap();
        assert_eq!(imap.host, "imap.yandex.ru");
        assert_eq!(smtp.port, 465);
        assert!(known_provider("example.org").is_none());
        assert_eq!(domain_of("a@company.ru"), Some("company.ru"));
        assert_eq!(domain_of("no-at-sign"), None);
    }

    #[test]
    fn debug_hides_password() {
        let creds = Credentials::new("u", "hunter2");
        assert!(!format!("{creds:?}").contains("hunter2"));
    }
}
