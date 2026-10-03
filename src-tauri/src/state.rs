use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use depesha_core::account::{Account, AuthMethod, Credentials};
use depesha_core::store::Store;
use depesha_core::{mail, oauth};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::config::{self, Config, Settings};
use crate::error::{CmdError, CmdResult};
use crate::secrets;
use crate::worker::Worker;
use depesha_core::tr;

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
    /// OAuth access tokens by account id, with their expiry; never written to disk.
    pub tokens: Mutex<HashMap<String, (String, i64)>>,
    /// One token refresh at a time, so two connections do not race for it.
    pub refreshing: tokio::sync::Mutex<()>,
    /// Finished browser sign-ins waiting for the account to be checked and saved.
    pub grants: Mutex<HashMap<String, oauth::Grant>>,
    /// Ends a browser sign-in in progress.
    pub oauth_cancel: Notify,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    pub fn settings(&self) -> Settings {
        lock(&self.config).settings.clone()
    }

    /// Applies the interface language to the core's messages and the window title.
    pub fn apply_language(&self) {
        use tauri::Manager;
        let lang = self.settings().lang();
        depesha_core::lang::set(lang);
        if let Some(w) = self.app.get_webview_window("main") {
            let _ = w.set_title(depesha_core::lang::pick("Depesha", "Депеша"));
        }
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
            .ok_or_else(|| CmdError::new("not-found", tr!("account not found", "учётная запись не найдена")))
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
        if let AuthMethod::OAuth { provider } = account.auth {
            return self.oauth_credentials(account, provider).await;
        }
        match secrets::get(&account.id).await {
            Ok(Some(password)) => Ok(Credentials::new(account.username.clone(), password)),
            Ok(None) => Err(depesha_core::Error::Auth(tr!(
                "no saved password: enter it in the account settings",
                "пароль не сохранён, введите его в настройках ящика"
            ))),
            Err(e) => Err(depesha_core::Error::Auth(e.message)),
        }
    }

    /// A valid access token: the cached one, or a fresh one from the refresh token.
    async fn oauth_credentials(
        &self,
        account: &Account,
        provider: depesha_core::account::OAuthProvider,
    ) -> Result<Credentials, depesha_core::Error> {
        let now = chrono::Utc::now().timestamp();
        let cached = |s: &Self| {
            lock(&s.tokens)
                .get(&account.id)
                .filter(|(_, exp)| *exp - 120 > now)
                .map(|(t, _)| t.clone())
        };
        if let Some(token) = cached(self) {
            return Ok(Credentials::oauth(account.username.clone(), token));
        }
        let _guard = self.refreshing.lock().await;
        if let Some(token) = cached(self) {
            return Ok(Credentials::oauth(account.username.clone(), token));
        }
        let refresh_token = match secrets::get(&account.id).await {
            Ok(Some(t)) => t,
            Ok(None) => {
                return Err(depesha_core::Error::Auth(tr!(
                    "no saved sign-in: sign in with {} again",
                    "вход не сохранён: войдите через {} заново",
                    provider.title()
                )));
            }
            Err(e) => return Err(depesha_core::Error::Auth(e.message)),
        };
        let client = self
            .settings()
            .oauth_client(provider)
            .ok_or_else(|| oauth::not_configured(provider))?;
        let tokens = oauth::refresh(provider, &client, &refresh_token).await?;
        // Microsoft rotates refresh tokens; the new one replaces the old.
        if !tokens.refresh_token.is_empty()
            && tokens.refresh_token != refresh_token
            && let Err(e) = secrets::set(&account.id, tokens.refresh_token.clone()).await
        {
            tracing::warn!(account = %account.id, "rotated refresh token not saved: {}", e.message);
        }
        lock(&self.tokens).insert(account.id.clone(), (tokens.access_token.clone(), tokens.expires_at));
        Ok(Credentials::oauth(account.username.clone(), tokens.access_token))
    }

    /// Runs `f` with the account's credentials; an OAuth login the server refused gets
    /// one more try with a fresh token (it may have been revoked before its expiry).
    pub async fn with_credentials<T, F, Fut>(&self, account: &Account, f: F) -> Result<T, depesha_core::Error>
    where
        F: Fn(Credentials) -> Fut,
        Fut: std::future::Future<Output = Result<T, depesha_core::Error>>,
    {
        let creds = self.credentials(account).await?;
        match f(creds).await {
            Err(e) if e.kind() == "auth" && account.auth.oauth_provider().is_some() => {
                lock(&self.tokens).remove(&account.id);
                let creds = self.credentials(account).await?;
                f(creds).await
            }
            other => other,
        }
    }

    pub async fn connect(&self, account: &Account) -> Result<mail::Conn, depesha_core::Error> {
        self.with_credentials(account, |creds| async move { mail::connect(account, &creds).await })
            .await
    }

    pub fn forget_token(&self, account_id: &str) {
        lock(&self.tokens).remove(account_id);
    }

    pub fn worker(&self, id: &str) -> CmdResult<Worker> {
        lock(&self.workers).get(id).cloned().ok_or_else(|| {
            CmdError::new(
                "not-found",
                tr!("the account is not running", "учётная запись не запущена"),
            )
        })
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
