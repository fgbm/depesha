//! Updates, the way OpenCode's `autoupdate` works: `auto` installs in the background
//! where that needs nobody's permission, `notify` only tells, `off` never asks the server.
//! Every update is checked against the public key in tauri.conf.json before it touches
//! the disk; an unsigned or tampered build is refused.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::lang::pick;
use crate::state::{AppState, lock};
use crate::tr;

const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 3600);

/// How this copy was installed decides what updating may do without asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Install {
    /// AppImage, macOS app: replaced in place, used after a restart.
    InPlace,
    /// Windows MSI or NSIS: the installer closes the app, so it runs on restart or exit.
    Installer,
    /// deb or rpm: needs root (pkexec), so only on the user's click.
    Package,
    /// Started from a build directory: nothing to update.
    Unsupported,
}

pub fn install_kind() -> Install {
    match bundle_type() {
        Some(BundleType::AppImage | BundleType::App) => Install::InPlace,
        Some(BundleType::Msi | BundleType::Nsis) => Install::Installer,
        Some(BundleType::Deb | BundleType::Rpm) => Install::Package,
        _ => Install::Unsupported,
    }
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UpdateStatus {
    pub current: String,
    /// `idle`, `checking`, `available`, `downloading`, `ready` (downloaded, installs on
    /// restart), `installed` (restart to use it) or `error`.
    #[cfg_attr(
        test,
        ts(type = "\"idle\" | \"checking\" | \"available\" | \"downloading\" | \"ready\" | \"installed\" | \"error\"")
    )]
    pub state: &'static str,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
    pub install: Install,
}

pub struct Updates {
    status: Mutex<UpdateStatus>,
    update: Mutex<Option<Update>>,
    /// Downloaded installer waiting for restart or exit (Windows).
    staged: Mutex<Option<Vec<u8>>>,
    busy: AtomicBool,
}

impl Updates {
    pub fn new(current: String) -> Self {
        Self {
            status: Mutex::new(UpdateStatus {
                current,
                state: "idle",
                version: None,
                notes: None,
                error: None,
                install: install_kind(),
            }),
            update: Mutex::new(None),
            staged: Mutex::new(None),
            busy: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        lock(&self.status).clone()
    }
}

fn set(state: &AppState, f: impl FnOnce(&mut UpdateStatus)) {
    let status = {
        let mut s = lock(&state.updates.status);
        f(&mut s);
        s.clone()
    };
    state.emit("update-status", serde_json::to_value(status).unwrap_or_default());
}

/// Checks now and then every few hours, as the settings allow.
pub async fn run(state: std::sync::Arc<AppState>) {
    // A copy started from a build directory cannot update itself: no background
    // requests for it (development, tests). "Check now" still works.
    if install_kind() == Install::Unsupported {
        return;
    }
    tokio::time::sleep(FIRST_CHECK).await;
    loop {
        if state.settings().updates != "off" {
            check(&state, false).await;
        }
        tokio::time::sleep(EVERY).await;
    }
}

fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let mut builder = app.updater_builder();
    // For testing against a local server. The signature is checked all the same.
    if let Some(url) = std::env::var("DEPESHA_UPDATE_URL").ok().and_then(|u| u.parse().ok()) {
        builder = builder.endpoints(vec![url])?;
    }
    builder.build()
}

/// One check; in `auto` mode it also downloads and, where possible, installs.
pub async fn check(state: &AppState, manual: bool) -> UpdateStatus {
    if state.updates.busy.swap(true, Ordering::SeqCst) {
        return state.updates.status();
    }
    let result = check_inner(state, manual).await;
    state.updates.busy.store(false, Ordering::SeqCst);
    if let Err(e) = result {
        tracing::warn!("update check failed: {e}");
        set(state, |s| {
            s.state = "error";
            s.error = Some(e);
        });
    }
    state.updates.status()
}

async fn check_inner(state: &AppState, manual: bool) -> Result<(), String> {
    // Already installed or staged: nothing new to do until the restart.
    if matches!(state.updates.status().state, "installed" | "ready") {
        return Ok(());
    }
    set(state, |s| {
        s.state = "checking";
        s.error = None;
    });
    let update = updater(&state.app)
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| {
            tr!(
                "Could not check for updates: {}",
                "Не удалось проверить обновления: {}",
                reason(&e)
            )
        })?;
    let Some(update) = update else {
        set(state, |s| {
            s.state = "idle";
            s.version = None;
        });
        return Ok(());
    };
    tracing::info!(version = %update.version, "update available");
    let (version, notes) = (update.version.clone(), update.body.clone());
    set(state, |s| {
        s.state = "available";
        s.version = Some(version.clone());
        s.notes = notes;
    });
    *lock(&state.updates.update) = Some(update);

    let auto = state.settings().updates == "auto";
    let quiet = matches!(install_kind(), Install::InPlace | Install::Installer);
    if auto && quiet {
        download(state).await?;
    } else if !manual {
        state.notify(
            pick("A new version of Depesha is available", "Доступна новая версия Депеши"),
            &tr!(
                "Version {version}. Install it in Settings.",
                "Версия {version}. Установить можно в настройках."
            ),
            false,
        );
    }
    Ok(())
}

/// Downloads the announced update; installs it where that is silent.
async fn download(state: &AppState) -> Result<(), String> {
    let Some(update) = lock(&state.updates.update).clone() else {
        return Err(tr!("no update to install", "нет обновления для установки"));
    };
    set(state, |s| s.state = "downloading");
    // `download` verifies the signature against the built-in public key.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| {
        tr!(
            "The update was not installed: {}",
            "Обновление не установлено: {}",
            reason(&e)
        )
    })?;
    match install_kind() {
        Install::Installer => {
            *lock(&state.updates.staged) = Some(bytes);
            set(state, |s| s.state = "ready");
        }
        _ => {
            update.install(&bytes).map_err(|e| {
                tr!(
                    "The update was not installed: {}",
                    "Обновление не установлено: {}",
                    reason(&e)
                )
            })?;
            tracing::info!(version = %update.version, "update installed");
            set(state, |s| s.state = "installed");
        }
    }
    Ok(())
}

/// The plugin's errors in words the user can act on.
fn reason(e: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    let signature = || {
        tr!(
            "the signature does not match, the file may have been altered on the way; nothing was installed",
            "подпись не совпала, файл мог быть изменён по дороге; установка отменена"
        )
    };
    match e {
        E::ReleaseNotFound => tr!(
            "the update server has no release information",
            "на сервере обновлений нет сведений о новой версии"
        ),
        E::Minisign(_) | E::SignatureUtf8(_) | E::Base64(_) => signature(),
        E::Reqwest(_) | E::Network(_) => tr!("no connection to the update server", "нет связи с сервером обновлений"),
        other if other.to_string().contains("signature") => signature(),
        other => other.to_string(),
    }
}

/// The user's "Install": downloads if needed. deb/rpm ask for the root password here.
pub async fn install(state: &AppState) -> Result<UpdateStatus, String> {
    if state.updates.busy.swap(true, Ordering::SeqCst) {
        return Ok(state.updates.status());
    }
    let r = match state.updates.status().state {
        "available" | "error" => download(state).await,
        _ => Ok(()),
    };
    state.updates.busy.store(false, Ordering::SeqCst);
    if let Err(e) = &r {
        set(state, |s| {
            s.state = "error";
            s.error = Some(e.clone());
        });
    }
    r.map(|()| state.updates.status())
}

/// Restarts into the new version. A staged Windows installer runs now and restarts the app.
pub fn restart(state: &AppState) -> ! {
    apply_staged(state);
    state.app.restart()
}

/// On exit: a downloaded Windows installer is not wasted.
pub fn apply_staged(state: &AppState) {
    let staged = lock(&state.updates.staged).take();
    if let (Some(bytes), Some(update)) = (staged, lock(&state.updates.update).clone())
        && let Err(e) = update.install(bytes)
    {
        tracing::warn!("staged update not installed: {e}");
    }
}
