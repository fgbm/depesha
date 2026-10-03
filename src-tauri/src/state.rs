use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use depesha_core::account::{Account, Credentials};
use depesha_core::store::Store;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::config::{self, Config, Settings};
use crate::error::{CmdError, CmdResult};
use crate::secrets;
use crate::worker::Worker;

#[derive(Debug, Clone, Serialize)]
pub struct AccountStatus {
    /// `connecting`, `online`, `error`, or `paused` (needs the user: password, certificate).
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CmdError>,
}

pub struct AppState {
    pub app: AppHandle,
    pub store: Arc<Store>,
    pub config_path: PathBuf,
    pub config: Mutex<Config>,
    pub workers: Mutex<HashMap<String, Worker>>,
    pub statuses: Mutex<HashMap<String, AccountStatus>>,
    pub outbox_notify: Notify,
    /// Wakes the scheduler (snoozed mail, follow-up reminders) early.
    pub scheduler_notify: Notify,
    pub updates: crate::updater::Updates,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    pub fn settings(&self) -> Settings {
        lock(&self.config).settings.clone()
    }

    pub fn save_settings(&self, settings: Settings) -> CmdResult<()> {
        let mut config = lock(&self.config);
        config.settings = settings;
        config::save(&self.config_path, &config)?;
        Ok(())
    }

    /// Shows a desktop notification unless the settings or a test run say otherwise.
    pub fn notify(&self, title: &str, body: &str, bulk: bool) {
        use tauri_plugin_notification::NotificationExt;
        if !self.settings().may_notify(bulk) {
            return;
        }
        // Automated tests run on a virtual display but share the user's notification daemon.
        if std::env::var_os("DEPESHA_NO_NOTIFICATIONS").is_some() {
            tracing::debug!("notification suppressed: {title}");
            return;
        }
        if let Err(e) = self.app.notification().builder().title(title).body(body).show() {
            tracing::debug!("notification failed: {e}");
        }
    }

    pub fn accounts(&self) -> Vec<Account> {
        lock(&self.config).accounts.clone()
    }

    pub fn account(&self, id: &str) -> CmdResult<Account> {
        lock(&self.config)
            .accounts
            .iter()
            .find(|a| a.id == id)
            .cloned()
            .ok_or_else(|| CmdError::new("not-found", "учётная запись не найдена"))
    }

    pub fn save_account(&self, account: Account) -> CmdResult<()> {
        let mut config = lock(&self.config);
        match config.accounts.iter_mut().find(|a| a.id == account.id) {
            Some(existing) => *existing = account,
            None => config.accounts.push(account),
        }
        config::save(&self.config_path, &config)?;
        Ok(())
    }

    pub fn remove_account(&self, id: &str) -> CmdResult<()> {
        let mut config = lock(&self.config);
        config.accounts.retain(|a| a.id != id);
        config::save(&self.config_path, &config)?;
        Ok(())
    }

    pub async fn credentials(&self, account: &Account) -> Result<Credentials, depesha_core::Error> {
        match secrets::get(&account.id).await {
            Ok(Some(password)) => Ok(Credentials::new(account.username.clone(), password)),
            Ok(None) => Err(depesha_core::Error::Auth(
                "пароль не сохранён, введите его в настройках ящика".into(),
            )),
            Err(e) => Err(depesha_core::Error::Auth(e.message)),
        }
    }

    pub fn worker(&self, id: &str) -> CmdResult<Worker> {
        lock(&self.workers)
            .get(id)
            .cloned()
            .ok_or_else(|| CmdError::new("not-found", "учётная запись не запущена"))
    }

    pub fn set_worker(&self, id: &str, worker: Option<Worker>) {
        let mut workers = lock(&self.workers);
        if let Some(old) = workers.remove(id) {
            old.stop();
        }
        if let Some(w) = worker {
            workers.insert(id.to_owned(), w);
        }
    }

    pub fn set_status(&self, id: &str, status: AccountStatus) {
        lock(&self.statuses).insert(id.to_owned(), status.clone());
        let _ = self.app.emit(
            "account-status",
            serde_json::json!({ "account_id": id, "status": status }),
        );
    }

    pub fn status(&self, id: &str) -> Option<AccountStatus> {
        lock(&self.statuses).get(id).cloned()
    }

    pub fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }
}
