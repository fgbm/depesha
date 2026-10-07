mod background;
mod commands;
mod config;
mod desktop_notify;
mod error;
mod extensions;
mod followups;
mod outbox;
mod paths;
mod scheduler;
mod secrets;
mod server;
mod state;
mod tasks;
mod tray;
mod updater;
mod waiting;
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

/// The cache cannot be opened (one from a newer version, a broken file): say why and
/// quit, instead of starting without the mail, outbox and reminders kept in it.
fn refuse_to_start(app: &tauri::App, e: &depesha_core::Error) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    tracing::error!(kind = e.kind(), "the cache did not open: {e}");
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let handle = app.handle().clone();
    app.dialog()
        .message(e.to_string())
        .title(depesha_core::lang::pick("Depesha", "Депеша"))
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Sandbox pages of extensions: their own origin and CSP, no Tauri bridge in them.
        .register_uri_scheme_protocol("ext", |ctx, request| {
            let app = ctx.app_handle();
            let disabled = app
                .try_state::<Arc<AppState>>()
                .map(|s| s.settings().disabled_extensions)
                .unwrap_or_default();
            extensions::serve(app, request.uri().path(), &disabled)
        })
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

            let config_path = config_dir.join("accounts.json");
            let mut config = config::load(&config_path);
            // The language before the cache opens: its refusal is shown to the user.
            depesha_core::lang::set(config.settings.lang());
            config::adopt_old_signatures(&mut config);
            let store = match Store::open(data_dir.join("mail.sqlite")) {
                Ok(store) => store,
                Err(e) => {
                    refuse_to_start(app, &e);
                    return Ok(());
                }
            };
            let state = Arc::new(AppState {
                app: app.handle().clone(),
                store: Arc::new(store),
                config: Mutex::new(config),
                config_path,
                workers: Mutex::new(HashMap::new()),
                statuses: Mutex::new(HashMap::new()),
                outbox_notify: Notify::new(),
                scheduler_notify: Notify::new(),
                updates: updater::Updates::new(app.package_info().version.to_string()),
                tokens: Default::default(),
                refreshing: Default::default(),
                grants: Default::default(),
                oauth_cancel: Notify::new(),
                tasks: Default::default(),
                paths: paths::Paths::new(),
            });
            app.manage(state.clone());
            state.apply_language();

            tauri::async_runtime::spawn(async move {
                for account in state.accounts() {
                    let w = worker::spawn(state.clone(), account.clone());
                    state.set_worker(&account.id, Some(w));
                }
                tauri::async_runtime::spawn(scheduler::run(state.clone()));
                tauri::async_runtime::spawn(updater::run(state.clone()));
                outbox::run(state).await;
            });
            Ok(())
        })
        // Files dropped on a window were chosen by the user: they may be attached.
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event
                && let Some(state) = webview.try_state::<Arc<AppState>>()
            {
                for path in paths.iter().filter(|p| p.is_file()) {
                    state.paths.allow(paths::Use::Attach, path.clone());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::accounts,
            commands::detect,
            commands::account_check,
            commands::account_save,
            commands::account_remove,
            commands::oauth_providers,
            commands::oauth_sign_in,
            commands::oauth_cancel,
            commands::exchange_detect,
            commands::folders,
            commands::messages,
            commands::search,
            commands::search_totals,
            commands::server_search,
            commands::message_open,
            commands::set_flag,
            commands::move_messages,
            commands::delete_messages,
            commands::archive,
            commands::mark_spam,
            commands::snooze,
            commands::undo,
            commands::thread,
            commands::counters,
            commands::followup_cancel,
            commands::followup_postpone,
            commands::followup_unpark,
            commands::followup_return,
            commands::unsubscribe,
            commands::unsubscribe_plan,
            commands::settings_get,
            commands::settings_set,
            commands::plugin_settings_set,
            commands::language,
            commands::extensions,
            commands::messages_by_id,
            commands::extension_inspect,
            commands::extension_install,
            commands::extension_approve,
            commands::extension_remove,
            commands::extension_storage_get,
            commands::extension_storage_set,
            commands::update_status,
            commands::update_check,
            commands::update_install,
            commands::update_restart,
            commands::load_older,
            commands::sync_now,
            commands::server_info,
            commands::server_check,
            commands::quota_refresh,
            commands::quotas,
            commands::folder_sizes_count,
            commands::folder_sizes_stop,
            commands::notify_full,
            commands::sync_overview,
            commands::folder_create,
            commands::offline_pause,
            commands::tasks_list,
            commands::task_dismiss,
            commands::trust_sender,
            commands::avatar,
            commands::accounts_arrange,
            commands::account_look,
            commands::addresses,
            commands::attachment_save,
            commands::attachments_save_all,
            commands::attachment_save_in,
            commands::attachment_open,
            commands::attachment_bytes,
            commands::message_window,
            commands::letter_view,
            commands::document_html,
            commands::markdown_html,
            commands::open_link,
            commands::send,
            commands::draft_save,
            commands::draft_discard,
            commands::outbox,
            commands::outbox_retry,
            commands::outbox_cancel,
            commands::temp_attachment,
            commands::file_info,
            commands::inline_image,
            commands::pick_files,
            commands::pick_folder,
            commands::pick_save_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Depesha")
        .run(|app, event| {
            // Closing the main window quits, letters open in their own windows too.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
                && label == "main"
            {
                app.exit(0);
            }
            // A Windows update downloaded in the background installs when the app quits.
            if let tauri::RunEvent::Exit = event
                && let Some(state) = app.try_state::<Arc<AppState>>()
            {
                updater::apply_staged(&state);
            }
        });
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    fn allowed(capability: &str) -> BTreeSet<String> {
        let json: serde_json::Value = serde_json::from_str(capability).unwrap();
        json["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str()?.strip_prefix("allow-"))
            .map(|c| c.replace('-', "_"))
            .collect()
    }

    /// build.rs, `invoke_handler` and the capabilities name the same commands, and a
    /// letter's window cannot manage mailboxes, plugins, updates or settings.
    #[test]
    fn acl_matches_the_commands() {
        let manifest: Vec<&str> = include_str!("../build.rs")
            .lines()
            .filter_map(|l| l.trim().strip_prefix('"')?.strip_suffix("\","))
            .collect();
        let handler: Vec<&str> = include_str!("lib.rs")
            .split("generate_handler![")
            .nth(1)
            .and_then(|s| s.split("])").next())
            .unwrap()
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands::")?.strip_suffix(','))
            .collect();
        let commands: BTreeSet<String> = handler.iter().map(|c| c.to_string()).collect();
        assert_eq!(commands.len(), handler.len(), "a command registered twice");
        assert_eq!(
            manifest.iter().map(|c| c.to_string()).collect::<BTreeSet<_>>(),
            commands,
            "build.rs and invoke_handler differ"
        );
        assert_eq!(manifest.len(), handler.len());

        let main = allowed(include_str!("../capabilities/main.json"));
        let message = allowed(include_str!("../capabilities/message.json"));
        assert_eq!(main, commands, "the main window allows every command");
        assert!(message.is_subset(&commands), "{:?}", message.difference(&commands));
        for denied in [
            "account_save",
            "account_remove",
            "account_check",
            "accounts_arrange",
            "account_look",
            "detect",
            "exchange_detect",
            "oauth_providers",
            "oauth_sign_in",
            "oauth_cancel",
            "extension_inspect",
            "extension_install",
            "extension_approve",
            "extension_remove",
            "update_status",
            "update_check",
            "update_install",
            "update_restart",
            "offline_pause",
            "settings_set",
            "message_window",
            "server_check",
            "folder_sizes_count",
            "folder_sizes_stop",
            "notify_full",
        ] {
            assert!(commands.contains(denied), "{denied} is not a command");
            assert!(!message.contains(denied), "a letter's window may call {denied}");
        }
    }
}
