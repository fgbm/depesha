mod commands;
mod config;
mod error;
mod outbox;
mod secrets;
mod state;
mod worker;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use depesha_core::store::Store;
use tauri::Manager;
use tokio::sync::Notify;

use crate::state::AppState;

fn init_logging(dir: &std::path::Path) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::EnvFilter;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("depesha")
        .filename_suffix("log")
        .max_log_files(7)
        .build(dir)
        .ok()?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env("DEPESHA_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,depesha_lib=debug,depesha_core=debug"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false)
        .init();
    Some(guard)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&log_dir)?;
            if let Some(guard) = init_logging(&log_dir) {
                // Lives as long as the app: flushing the log on exit.
                app.manage(guard);
            }
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "starting");

            let store = Store::open(data_dir.join("mail.sqlite"))?;
            let config_path = config_dir.join("accounts.json");
            let state = Arc::new(AppState {
                app: app.handle().clone(),
                store: Arc::new(store),
                config: Mutex::new(config::load(&config_path)),
                config_path,
                workers: Mutex::new(HashMap::new()),
                statuses: Mutex::new(HashMap::new()),
                outbox_notify: Notify::new(),
            });
            app.manage(state.clone());

            tauri::async_runtime::spawn(async move {
                for account in state.accounts() {
                    let w = worker::spawn(state.clone(), account.clone());
                    state.set_worker(&account.id, Some(w));
                }
                outbox::run(state).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::accounts,
            commands::detect,
            commands::account_check,
            commands::account_save,
            commands::account_remove,
            commands::folders,
            commands::messages,
            commands::search,
            commands::server_search,
            commands::message_open,
            commands::set_flag,
            commands::move_messages,
            commands::delete_messages,
            commands::load_older,
            commands::sync_now,
            commands::trust_sender,
            commands::addresses,
            commands::attachment_save,
            commands::attachments_save_all,
            commands::attachment_open,
            commands::open_link,
            commands::send,
            commands::draft_save,
            commands::outbox,
            commands::outbox_retry,
            commands::outbox_cancel,
            commands::temp_attachment,
            commands::file_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Depesha");
}
