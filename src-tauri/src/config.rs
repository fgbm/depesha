use std::path::Path;

use depesha_core::account::{Account, OAuthProvider};
use depesha_core::lang::{self, Lang};
use depesha_core::oauth::OAuthClient;
use serde::{Deserialize, Serialize};

/// Account settings without passwords; those live in the OS keyring.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// A sent message waits this long in the outbox so it can be taken back.
    pub undo_send_secs: u32,
    /// `people` (default), `all` or `none`.
    pub notify: String,
    /// Do not disturb until this Unix time; 0 when off.
    pub dnd_until: i64,
    /// Group the list into conversations.
    pub threads: bool,
    pub templates: Vec<Template>,
    /// `auto` (default), `notify` or `off`, like OpenCode's `autoupdate`.
    pub updates: String,
    /// `auto` (from the system locale, default), `en` or `ru`.
    pub language: String,
    /// `system` (light or dark as the system says, default), `paper`, `night`,
    /// `snow` or `graphite`.
    pub theme: String,
    /// Built-in plugins switched off, by id (`plugins/<id>`).
    #[serde(alias = "disabled_modules")]
    pub disabled_plugins: Vec<String>,
    /// Settings of built-in plugins, by plugin id; each plugin owns its object.
    pub plugin_settings: std::collections::BTreeMap<String, serde_json::Value>,
    /// Installed extensions switched off, by id.
    pub disabled_extensions: Vec<String>,
    /// The user's own OAuth clients; they win over the ones built into the app.
    pub oauth_clients: std::collections::BTreeMap<OAuthProvider, OAuthClient>,
    /// Mail downloaded whole for reading without a network and for searching its
    /// text: `off`, the last `30` (default), `90` or `365` days, or `all`.
    pub offline: String,
    /// Offline download takes messages with attachments too.
    pub offline_attachments: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            undo_send_secs: 10,
            notify: "people".into(),
            dnd_until: 0,
            threads: true,
            templates: Vec::new(),
            updates: "auto".into(),
            language: "auto".into(),
            theme: "system".into(),
            disabled_plugins: Vec::new(),
            plugin_settings: Default::default(),
            disabled_extensions: Vec::new(),
            oauth_clients: Default::default(),
            offline: "30".into(),
            offline_attachments: false,
        }
    }
}

impl Settings {
    /// The OAuth client to sign in with: the user's own, or the built-in one.
    pub fn oauth_client(&self, provider: OAuthProvider) -> Option<OAuthClient> {
        self.oauth_clients
            .get(&provider)
            .filter(|c| c.is_set())
            .cloned()
            .or_else(|| OAuthClient::builtin(provider))
    }

    /// The interface language: the chosen one, or Russian for a Russian system locale
    /// and English otherwise.
    pub fn lang(&self) -> Lang {
        match self.language.as_str() {
            "ru" => Lang::Ru,
            "en" => Lang::En,
            _ => sys_locale::get_locale()
                .map(|l| lang::from_locale(&l))
                .unwrap_or(Lang::En),
        }
    }

    /// Since when mail is kept for offline reading, Unix time; `None` when it is off.
    pub fn offline_since(&self) -> Option<i64> {
        match self.offline.as_str() {
            "off" => None,
            "all" => Some(0),
            days => {
                let days: i64 = days.parse().unwrap_or(30);
                Some(chrono::Utc::now().timestamp() - days * 86_400)
            }
        }
    }

    /// Whether a notification about this kind of mail may be shown now.
    pub fn may_notify(&self, bulk: bool) -> bool {
        if self.dnd_until > chrono::Utc::now().timestamp() {
            return false;
        }
        match self.notify.as_str() {
            "none" => false,
            "all" => true,
            _ => !bulk,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    pub name: String,
    pub text: String,
}

pub fn load(path: &Path) -> Config {
    let mut config = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
            tracing::error!(%err, "accounts.json is broken, starting without accounts");
            Config::default()
        }),
        Err(_) => Config::default(),
    };
    // Templates moved into the templates plugin (0.5.0).
    let s = &mut config.settings;
    if !s.templates.is_empty() && !s.plugin_settings.contains_key("templates") {
        let list = std::mem::take(&mut s.templates);
        s.plugin_settings
            .insert("templates".into(), serde_json::json!({ "list": list }));
    }
    config
}

/// Writes through a temporary file so a crash never leaves half a config.
pub fn save(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(config).map_err(std::io::Error::other)?)?;
    std::fs::rename(tmp, path)
}
