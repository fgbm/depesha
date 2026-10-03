use std::path::Path;

use depesha_core::account::Account;
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
        }
    }
}

impl Settings {
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
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
            tracing::error!(%err, "accounts.json is broken, starting without accounts");
            Config::default()
        }),
        Err(_) => Config::default(),
    }
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
