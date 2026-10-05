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
    /// What the user calls the mailbox in the app ("Work"); empty shows the address.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// Colour that marks the mailbox in the sidebar and in shared lists (`#3f7cc4`);
    /// empty takes one from the palette by the mailbox's place.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub color: String,
    /// Sender name recipients see in From.
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
    /// Where this mailbox's attachments are saved without asking; empty takes the
    /// folder from the settings.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub attachments_dir: String,
    /// How the account logs in. Accounts saved before OAuth use a password.
    #[serde(default, skip_serializing_if = "AuthMethod::is_password")]
    pub auth: AuthMethod,
    /// Exchange Web Services instead of IMAP and SMTP: `imap` and `smtp` are then unused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ews: Option<EwsConfig>,
}

impl Account {
    pub fn is_ews(&self) -> bool {
        self.ews.is_some()
    }
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthMethod {
    /// The keyring holds the password.
    #[default]
    Password,
    /// The keyring holds the provider's refresh token; IMAP and SMTP log in with XOAUTH2.
    OAuth { provider: OAuthProvider },
}

impl AuthMethod {
    pub fn is_password(&self) -> bool {
        *self == Self::Password
    }

    pub fn oauth_provider(&self) -> Option<OAuthProvider> {
        match self {
            Self::OAuth { provider } => Some(*provider),
            Self::Password => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthProvider {
    Google,
    Yandex,
    Microsoft,
}

impl OAuthProvider {
    pub const ALL: [Self; 3] = [Self::Google, Self::Yandex, Self::Microsoft];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Yandex => "yandex",
            Self::Microsoft => "microsoft",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Google => "Google",
            Self::Yandex => crate::lang::pick("Yandex", "Яндекс"),
            Self::Microsoft => "Microsoft",
        }
    }

    /// IMAP and SMTP servers that accept this provider's tokens.
    pub fn servers(self) -> (ServerConfig, ServerConfig) {
        let domain = match self {
            Self::Google => "gmail.com",
            Self::Yandex => "yandex.ru",
            Self::Microsoft => "outlook.com",
        };
        known_provider(domain).expect("every OAuth provider is a known provider")
    }
}

/// Where Exchange Web Services live, e.g. `https://mail.example.com/EWS/Exchange.asmx`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EwsConfig {
    pub url: String,
    /// SHA-256 of a certificate the user explicitly trusted for this server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_cert: Option<String>,
}

#[derive(Clone)]
enum Secret {
    Password(String),
    /// OAuth 2.0 access token, sent with SASL XOAUTH2.
    Bearer(String),
}

#[derive(Clone)]
pub struct Credentials {
    pub username: String,
    secret: Secret,
}

impl Credentials {
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            secret: Secret::Password(password.into()),
        }
    }

    pub fn oauth(username: impl Into<String>, access_token: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            secret: Secret::Bearer(access_token.into()),
        }
    }

    /// The password, or the access token for OAuth credentials.
    pub fn password(&self) -> &str {
        match &self.secret {
            Secret::Password(p) | Secret::Bearer(p) => p,
        }
    }

    pub fn bearer(&self) -> Option<&str> {
        match &self.secret {
            Secret::Bearer(t) => Some(t),
            Secret::Password(_) => None,
        }
    }

    /// SASL XOAUTH2 initial response, before base64 (Google and Microsoft spell it this way).
    pub fn xoauth2(&self) -> Option<String> {
        self.bearer()
            .map(|token| format!("user={}\x01auth=Bearer {token}\x01\x01", self.username))
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
        // Personal Microsoft accounts and Microsoft 365 share these hosts; both need OAuth.
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "outlook.ru" | "hotmail.ru" | "live.ru" => {
            ("outlook.office365.com", "smtp.office365.com", 587, Security::StartTls)
        }
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

/// The mailbox `account:` names: by address, by the user's label, or by a part of the
/// address (`account:work`, `account:example.com`). An exact match wins.
pub fn find<'a>(accounts: &'a [Account], name: &str) -> Option<&'a Account> {
    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return None;
    }
    let exact = |a: &&Account| a.email.to_lowercase() == name || a.label.to_lowercase() == name || a.id == name;
    accounts.iter().find(exact).or_else(|| {
        accounts
            .iter()
            .find(|a| a.email.to_lowercase().contains(&name) || a.label.to_lowercase().contains(&name))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_mailbox_by_name() {
        let json = |id: &str, email: &str, label: &str| {
            format!(
                r#"{{"id":"{id}","label":"{label}","display_name":"","email":"{email}","username":"",
                "imap":{{"host":"h","port":993,"security":"tls"}},"smtp":{{"host":"h","port":587,"security":"starttls"}}}}"#
            )
        };
        let accounts: Vec<Account> = [
            json("1", "ivan@example.com", "Работа"),
            json("2", "ivan@example.org", ""),
            json("3", "example@example.net", ""),
        ]
        .iter()
        .map(|j| serde_json::from_str(j).unwrap())
        .collect();
        let id = |name: &str| find(&accounts, name).map(|a| a.id.as_str());
        assert_eq!(id("работа"), Some("1"));
        assert_eq!(id("IVAN@example.org"), Some("2"));
        assert_eq!(id("example.net"), Some("3"));
        // The whole address before a part of another one.
        assert_eq!(id("example@example.net"), Some("3"));
        assert_eq!(id("nobody"), None);
        assert_eq!(id(" "), None);
    }

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
        let creds = Credentials::oauth("u", "ya29.token");
        assert!(!format!("{creds:?}").contains("ya29"));
    }

    #[test]
    fn xoauth2_string() {
        let creds = Credentials::oauth("someuser@example.com", "ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg");
        assert_eq!(
            creds.xoauth2().unwrap(),
            "user=someuser@example.com\x01auth=Bearer ya29.vF9dft4qmTc2Nvb3RlckBhdHRhdmlzdGEuY29tCg\x01\x01"
        );
        assert!(Credentials::new("u", "p").xoauth2().is_none());
    }

    #[test]
    fn old_accounts_use_passwords() {
        let json = r#"{"id":"a","display_name":"A","email":"a@b.ru","username":"a",
            "imap":{"host":"h","port":993,"security":"tls"},"smtp":{"host":"h","port":587,"security":"starttls"}}"#;
        let a: Account = serde_json::from_str(json).unwrap();
        assert_eq!(a.auth, AuthMethod::Password);
        assert!(!a.is_ews());
        // Nothing new is written for them either.
        let back = serde_json::to_string(&a).unwrap();
        assert!(!back.contains("auth") && !back.contains("ews"));

        let mut a = a;
        a.auth = AuthMethod::OAuth {
            provider: OAuthProvider::Yandex,
        };
        let back = serde_json::to_string(&a).unwrap();
        assert!(
            back.contains(r#""auth":{"kind":"oauth","provider":"yandex"}"#),
            "{back}"
        );
    }

    #[test]
    fn oauth_providers_have_servers() {
        for p in OAuthProvider::ALL {
            let (imap, smtp) = p.servers();
            assert!(!imap.host.is_empty() && !smtp.host.is_empty());
        }
        assert_eq!(OAuthProvider::Microsoft.servers().0.host, "outlook.office365.com");
    }
}
