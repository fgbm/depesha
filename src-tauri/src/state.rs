use std::collections::{HashMap, HashSet};
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
    /// Copies in «Sent» being filed right now (ids in `sent_copies`): one try at a time.
    pub copying: Mutex<HashSet<i64>>,
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
    /// Background work the user sees in the tasks window.
    pub tasks: crate::tasks::Tasks,
    /// Files and folders the user chose, the only ones commands read or write.
    pub paths: crate::paths::Paths,
    /// Desktop notifications, with a click back into the app.
    pub notifier: crate::desktop_notify::Notifier,
    /// The tray icon: the unread count, its menu.
    pub tray: crate::tray::TrayCtl,
    /// Work in the background: the closed window, letters that missed their time.
    pub background: crate::background::Background,
    /// The newest `message_open` sequence per window: an open older than the window's
    /// newest is dropped before its body is fetched (#71).
    pub open_seq: OpenSeqs,
    /// A `depesha://` URL the app was started with (a toast click while it was closed),
    /// taken once by the main window when it listens (`deep_link_take`).
    pub pending_deep_link: Mutex<Option<String>>,
    /// The drafts windows have open and the bounds of «Clear» counts (#74).
    pub clearing: crate::empty::Clearing,
}

/// The newest `message_open` sequence per window (its label), for cancelling a body load
/// the user has already moved past.
pub type OpenSeqs = Mutex<HashMap<String, u64>>;

/// Records `seq` as the newest open of `window`.
pub fn note_open(seqs: &OpenSeqs, window: &str, seq: u64) {
    lock(seqs).insert(window.to_owned(), seq);
}

/// Whether an open with `seq` is still the newest for `window`: a newer open has already
/// made it stale, and its body need not be fetched.
pub fn open_is_current(seqs: &OpenSeqs, window: &str, seq: u64) -> bool {
    match lock(seqs).get(window) {
        Some(newest) => *newest <= seq,
        None => true,
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Applies a patch over the settings of `config` and writes them, all under `config`'s lock:
/// two patches never lose each other's keys. Returns the settings as they are after it.
pub fn patch_locked(config: &Mutex<Config>, path: &std::path::Path, patch: serde_json::Value) -> CmdResult<Settings> {
    update_locked(config, path, |settings| {
        let mut value = serde_json::to_value(&*settings).map_err(|e| CmdError::new("other", e.to_string()))?;
        config::merge(&mut value, patch);
        *settings = serde_json::from_value(value).map_err(|e| CmdError::new("bad-request", e.to_string()))?;
        Ok(())
    })
}

/// Runs `change` on the settings of `config` and writes them, all under `config`'s lock, so a
/// read-modify-write from one window never rolls back what another wrote meanwhile. Returns
/// the settings as they are after the change.
pub fn update_locked(
    config: &Mutex<Config>,
    path: &std::path::Path,
    change: impl FnOnce(&mut Settings) -> CmdResult<()>,
) -> CmdResult<Settings> {
    let mut config = lock(config);
    change(&mut config.settings)?;
    config::save(path, &config)?;
    Ok(config.settings.clone())
}

impl AppState {
    /// Takes the filing of copy `id` for one try; false when a try is already under way.
    pub fn copy_claim(&self, id: i64) -> bool {
        lock(&self.copying).insert(id)
    }

    pub fn copy_release(&self, id: i64) {
        lock(&self.copying).remove(&id);
    }

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

    /// Changes only the keys a patch names, over the settings in memory and on disk, so a
    /// save from one window's memory does not roll back what another writer changed meanwhile.
    /// Returns the settings as they are after the merge.
    pub fn patch_settings(&self, patch: serde_json::Value) -> CmdResult<Settings> {
        patch_locked(&self.config, &self.config_path, patch)
    }

    /// Changes the settings under the config lock: `change` runs on the settings that are
    /// there now and the result is written once, so two writers never lose each other's edit.
    /// Returns the settings as they are after the change.
    pub fn update_settings(&self, change: impl FnOnce(&mut Settings) -> CmdResult<()>) -> CmdResult<Settings> {
        update_locked(&self.config, &self.config_path, change)
    }

    /// Shows a desktop notification unless the settings, a test run or the window in front
    /// say otherwise; a click on it brings the window.
    pub fn notify(&self, title: &str, body: &str, bulk: bool) {
        self.notify_target(title, body, bulk, None);
    }

    /// The same, and a click opens `target` in the main window.
    pub fn notify_target(&self, title: &str, body: &str, bulk: bool, target: Option<crate::desktop_notify::Target>) {
        if !self.settings().may_notify(bulk) {
            return;
        }
        self.notifier.notify(&self.app, title, body, target);
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

    /// Changes one mailbox in place under the config lock and saves it. The mailbox's worker is
    /// not touched: only fields the worker does not hold may be changed this way.
    pub fn patch_account(&self, id: &str, change: impl FnOnce(&mut Account)) -> CmdResult<Account> {
        let mut config = lock(&self.config);
        let account = config
            .accounts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| CmdError::new("not-found", tr!("account not found", "учётная запись не найдена")))?;
        change(account);
        let saved = account.clone();
        config::save(&self.config_path, &config)?;
        Ok(saved)
    }

    /// Puts the mailboxes in this order; ones missing from `ids` keep their place after them.
    pub fn arrange_accounts(&self, ids: &[String]) -> CmdResult<()> {
        let mut config = lock(&self.config);
        let place = |id: &str| ids.iter().position(|x| x == id).unwrap_or(usize::MAX);
        config.accounts.sort_by_key(|a| place(&a.id));
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
        // A mailbox that needs the user is named in the tray menu.
        crate::tray::refresh_soon(self);
        let _ = self.app.emit(
            "account-status",
            serde_json::json!({ "account_id": id, "status": status }),
        );
    }

    pub fn status(&self, id: &str) -> Option<AccountStatus> {
        lock(&self.statuses).get(id).cloned()
    }

    pub fn emit(&self, event: &str, payload: serde_json::Value) {
        // The unread count on the tray icon follows the mail and the settings.
        if matches!(
            event,
            "mail-changed" | "counters-changed" | "folders-changed" | "settings-changed"
        ) {
            crate::tray::refresh_soon(self);
        }
        // A folder sync that brought mail is a reason to re-read the waits for answers
        // at once, instead of on the scheduler's slow fallback timer.
        if event == "mail-changed" {
            self.scheduler_notify.notify_one();
        }
        let _ = self.app.emit(event, payload);
    }

    /// An event only the main window handles (a letter's window never answers it).
    pub fn emit_main(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit_to("main", event, payload);
    }

    /// Keeps the `depesha://` URL the app was started with, for the main window to take.
    pub fn set_pending_deep_link(&self, url: String) {
        *lock(&self.pending_deep_link) = Some(url);
    }

    /// Takes that URL, if any; the second call answers none.
    pub fn take_pending_deep_link(&self) -> Option<String> {
        lock(&self.pending_deep_link).take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_open_makes_an_older_one_stale() {
        let seqs: OpenSeqs = Mutex::new(HashMap::new());
        note_open(&seqs, "main", 3);
        assert!(open_is_current(&seqs, "main", 3));
        // The window moved to the next letter: the older open is stale now.
        note_open(&seqs, "main", 4);
        assert!(!open_is_current(&seqs, "main", 3));
        assert!(open_is_current(&seqs, "main", 4));
        // Another window's opens are its own.
        assert!(open_is_current(&seqs, "message-7", 1));
    }

    /// The settings a command patches are merged and written under one lock: two windows
    /// patching at once never roll back each other's key.
    #[test]
    fn two_patches_do_not_lose_each_others_keys() {
        use std::sync::Arc;
        let dir = std::env::temp_dir().join(format!("depesha-patch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("accounts.json");
        let config = Arc::new(Mutex::new(Config::default()));
        let threads: Vec<_> = (0..8u32)
            .map(|i| {
                let config = Arc::clone(&config);
                let path = path.clone();
                std::thread::spawn(move || {
                    // Half set one field, half another: a read-modify-write without the lock
                    // would roll the other half's key back to its default.
                    let patch = if i % 2 == 0 {
                        serde_json::json!({ "undo_send_secs": i + 1 })
                    } else {
                        serde_json::json!({ "dnd_until": i + 1 })
                    };
                    patch_locked(&config, &path, patch).unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let settings = lock(&config).settings.clone();
        assert_ne!(settings.undo_send_secs, 0, "an even thread's key was lost");
        assert_ne!(settings.dnd_until, 0, "an odd thread's key was lost");
        // The file on disk agrees with memory.
        let saved = config::load(&path);
        assert_eq!(saved.settings.undo_send_secs, settings.undo_send_secs);
        assert_eq!(saved.settings.dnd_until, settings.dnd_until);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Removing a mailbox clears it as the default under the same lock a patch uses, so the
    /// clear does not write back a stale copy and lose a key another window just set.
    #[test]
    fn clearing_the_default_account_does_not_roll_back_a_patch() {
        let dir = std::env::temp_dir().join(format!("depesha-default-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("accounts.json");
        let config = Mutex::new(Config::default());
        update_locked(&config, &path, |settings| {
            settings.default_account_id = Some("gone".into());
            settings.undo_send_secs = 9;
            Ok(())
        })
        .unwrap();
        patch_locked(&config, &path, serde_json::json!({ "dnd_until": 42 })).unwrap();
        let mut cleared = false;
        update_locked(&config, &path, |settings| {
            if settings.default_account_id.as_deref() == Some("gone") {
                settings.default_account_id = None;
                cleared = true;
            }
            Ok(())
        })
        .unwrap();
        assert!(cleared);
        let settings = lock(&config).settings.clone();
        assert_eq!(settings.default_account_id, None);
        assert_eq!(
            settings.undo_send_secs, 9,
            "the clear rolled back a key it did not name"
        );
        assert_eq!(settings.dnd_until, 42, "a patch written before the clear was lost");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
