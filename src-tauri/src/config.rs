use std::path::Path;

use depesha_core::account::Account;
use serde::{Deserialize, Serialize};

/// Account settings without passwords; those live in the OS keyring.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub accounts: Vec<Account>,
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
