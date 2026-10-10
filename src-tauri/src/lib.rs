mod background;
mod commands;
mod config;
mod desktop_notify;
mod drafts;
mod drops;
mod empty;
mod error;
mod extensions;
mod flights;
mod followups;
mod install_secret;
mod label_strip;
mod outbox;
mod paths;
#[cfg(target_os = "macos")]
pub mod print_mac;
mod print_sheet;
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

/// Test builds on Windows only: the arguments for WebView2 that a run asks for. WebView2 takes
/// the ones a window sets itself and drops the variable, so every window, those of the config
/// and the letters' own (`message_window`), has to set them: a window with other arguments
/// cannot share the folder of the data, and msedgedriver would not see it.
/// `DEPESHA_E2E_WEBVIEW_ARGS`: the run's own, e.g. `--force-device-scale-factor=2`.
#[cfg(all(feature = "e2e", windows))]
pub(crate) fn e2e_browser_args() -> Option<String> {
    let extra = ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "DEPESHA_E2E_WEBVIEW_ARGS"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .collect::<Vec<_>>()
        .join(" ");
    (!extra.trim().is_empty()).then(|| {
        format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required {extra}")
    })
}

/// The app's context. A test build on Windows hands WebView2 the arguments msedgedriver asks
/// for in `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (the remote debugging port): WebView2 takes
/// the arguments the window sets itself and drops the variable, so without this the driver
/// finds no `DevToolsActivePort` and the session is never created.
#[cfg(not(all(feature = "e2e", windows)))]
fn context() -> tauri::Context {
    tauri::generate_context!()
}

#[cfg(all(feature = "e2e", windows))]
fn context() -> tauri::Context {
    let mut context = tauri::generate_context!();
    if let Some(args) = e2e_browser_args() {
        for window in &mut context.config_mut().app.windows {
            window.additional_browser_args = Some(args.clone());
        }
    }
    context
}

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
    // Mesa's GBM frees a device twice when WebKitWebProcess exits and the process dies with
    // SEGV (#73); without the DMA-BUF renderer WebKit does not go there. A value the user set,
    // `0` too, is theirs.
    let dmabuf_off = cfg!(target_os = "linux") && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none();
    #[cfg(target_os = "linux")]
    if dmabuf_off {
        // SAFETY: first thing in `main`: no thread exists yet to read the environment
        // while it changes, and GTK and WebKit have not started.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    tauri::Builder::default()
        // Launched again: the running copy shows its window (hidden in the background too);
        // a login entry starting it twice changes nothing.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|a| a == background::BACKGROUND_ARG) {
                background::show_main(app);
            }
        }))
        // `depesha://` links: a toast click (see desktop_notify) comes back as a URL.
        // After single-instance, whose `deep-link` feature hands a second process's URL
        // to the running app through this plugin before its callback runs.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args([background::BACKGROUND_ARG])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&log_dir)?;
            // The links the app makes carry its signature; a `depesha://` link that has none
            // of ours only brings the window forward.
            install_secret::init(&data_dir.join("install-secret"));
            if let Some(guard) = init_logging(&log_dir) {
                // Lives as long as the app: flushing the log on exit.
                app.manage(guard);
            }
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "starting");
            if dmabuf_off {
                tracing::info!("WEBKIT_DISABLE_DMABUF_RENDERER=1 set: workaround for the WebKit crash on exit (#73)");
            }

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
                copying: Default::default(),
                scheduler_notify: Notify::new(),
                updates: updater::Updates::new(app.package_info().version.to_string()),
                tokens: Default::default(),
                refreshing: Default::default(),
                grants: Default::default(),
                oauth_cancel: Notify::new(),
                tasks: Default::default(),
                paths: paths::Paths::new(),
                notifier: Default::default(),
                tray: Default::default(),
                background: Default::default(),
                open_seq: Default::default(),
                pending_deep_link: Mutex::new(None),
                clearing: Default::default(),
                archivals: Default::default(),
                refused: Default::default(),
                bounds: Default::default(),
                label_running: Default::default(),
                label_stalled: Default::default(),
            });
            app.manage(state.clone());
            state.apply_language();

            // A `depesha://` link: the deep-link plugin read one from the command line at
            // startup (a toast click while Depesha was closed), and emits an event for one
            // that arrives later (a second process, the app already running). The startup
            // URL waits for the main window to listen; the later one goes straight to it.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        desktop_notify::open_url(&handle, url.as_str());
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current()
                    && let Some(url) = urls.first()
                {
                    state.set_pending_deep_link(url.as_str().to_owned());
                }
            }

            // The window starts hidden (tauri.conf.json): shown now, unless started at
            // login to wait in the background.
            let args: Vec<String> = std::env::args().collect();
            let settings = state.settings();
            if !background::starts_hidden(&args, &settings)
                && let Some(w) = app.get_webview_window("main")
            {
                let _ = w.show();
                let _ = w.set_focus();
            }
            background::sync_autostart(app.handle(), None, &settings);
            tray::start(app.handle());

            tauri::async_runtime::spawn(async move {
                for account in state.accounts() {
                    let w = worker::spawn(state.clone(), account.clone());
                    state.set_worker(&account.id, Some(w));
                }
                // A label left half-taken-off by a restart is resumed.
                label_strip::resume_all(&state);
                tauri::async_runtime::spawn(scheduler::run(state.clone()));
                tauri::async_runtime::spawn(updater::run(state.clone()));
                tauri::async_runtime::spawn(read_importance_of_cached(state.clone()));
                outbox::run(state).await;
            });
            Ok(())
        })
        // Closing the main window hides it or quits, as the settings say (#4); its page
        // keeps the mail rules and plugins running in the background.
        .on_window_event(|window, event| {
            drops::window_event(window, event, drops::allow_in_state(window));
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. }
                    if window.app_handle().try_state::<Arc<AppState>>().is_some() =>
                {
                    api.prevent_close();
                    background::close_requested(window.app_handle());
                }
                tauri::WindowEvent::Focused(focused) => background::focused(window.app_handle(), *focused),
                _ => {}
            }
        })
        // Files dropped on a window were chosen by the user: they may be attached. Tauri
        // tells the page about the drop before this handler runs, so the page would ask for
        // a file that is not allowed yet (#79). The page hears of the drop from `drops`
        // instead, once the files are allowed. A window's own content reports the drop as a
        // window event, a webview inside a window as a webview event: both are heard.
        .on_webview_event(|webview, event| {
            drops::webview_event(webview, event, drops::allow_in_state(webview));
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
            commands::set_label,
            commands::labels,
            commands::label_counts,
            commands::label_save,
            commands::label_remove,
            commands::label_strip,
            commands::label_rename,
            commands::folder_props,
            commands::label_check,
            commands::move_messages,
            commands::delete_messages,
            commands::archive,
            commands::mark_spam,
            commands::snooze,
            commands::unsnooze,
            commands::undo,
            commands::thread,
            commands::counters,
            commands::followup_cancel,
            commands::followup_resume,
            commands::followup_postpone,
            commands::followup_unpark,
            commands::followup_return,
            commands::unsubscribe,
            commands::unsubscribe_plan,
            commands::settings_get,
            // Only e2e names a whole settings object; a release build does not register it.
            #[cfg(feature = "e2e")]
            commands::settings_set,
            commands::settings_patch,
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
            commands::task_stop,
            commands::folder_total,
            commands::folder_empty,
            commands::stuck_copies,
            commands::sent_copy_retry,
            commands::sent_copy_save,
            commands::sent_copy_drop,
            commands::trust_sender,
            commands::avatar,
            commands::accounts_arrange,
            commands::account_look,
            commands::account_patch_own,
            commands::addresses,
            commands::people,
            commands::person_save,
            commands::person_add_address,
            commands::person_set_primary,
            commands::person_merge,
            commands::person_split,
            commands::person_restore,
            commands::person_forget,
            commands::hints,
            commands::hint_save,
            commands::hints_clear,
            commands::hint_counts,
            commands::count_hint,
            commands::clear_hint_count,
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
            commands::draft_open,
            commands::draft_open_reset,
            commands::open_drafts,
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
            commands::background_status,
            commands::deep_link_take,
            commands::window_hide,
            commands::app_quit,
            commands::outbox_missed,
            commands::compose_unsaved,
            commands::quit_cancel,
            commands::print_sheet,
            commands::drop_seen,
            commands::drop_outcome,
            // A drop made up for the e2e run (WebDriver cannot drag a file in).
            #[cfg(feature = "e2e")]
            commands::e2e_drop,
            #[cfg(feature = "e2e")]
            commands::e2e_seed_message,
            drafts::draft_cache_put,
            drafts::draft_cache_list,
            drafts::draft_cache_drop,
        ])
        .build(context())
        .expect("error while running Depesha")
        .run(|app, event| {
            // The main window gone (the cache refused to open) takes the app with it.
            // A letter's window gone frees a quit that was waiting for it.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                if label == "main" {
                    app.exit(0);
                } else if label.starts_with("message-") {
                    if let Some(state) = app.try_state::<Arc<AppState>>() {
                        state.clearing.window_gone(label);
                    }
                    background::window_gone(app, label);
                }
            }
            // A Windows update downloaded in the background installs when the app quits.
            if let tauri::RunEvent::Exit = event
                && let Some(state) = app.try_state::<Arc<AppState>>()
            {
                state.notifier.clear(app);
                updater::apply_staged(&state);
            }
        });
}

/// Reads the importance (#72) of the letters cached before it was kept, a small batch at a
/// time with a pause between, so the window and the sync are not held back. The end is
/// recorded in the cache: the next start finds it done and returns at once.
async fn read_importance_of_cached(state: std::sync::Arc<state::AppState>) {
    const BATCH: u32 = 100;
    loop {
        let st = state.clone();
        let done = tauri::async_runtime::spawn_blocking(move || st.store.backfill_importance(BATCH)).await;
        match done {
            Ok(Ok(true)) => return,
            Ok(Ok(false)) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
            Ok(Err(e)) => {
                tracing::warn!("reading the importance of cached letters stopped: {e}");
                return;
            }
            Err(_) => return,
        }
    }
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
            .filter_map(|l| {
                let l = l.trim().strip_suffix(',')?;
                let (_, name) = l.split_once("::")?;
                Some(name)
            })
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
            "account_patch_own",
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
            "settings_patch",
            "message_window",
            "server_check",
            "folder_sizes_count",
            "folder_sizes_stop",
            "notify_full",
            "background_status",
            "window_hide",
            "app_quit",
            "outbox_missed",
            "label_rename",
            "label_strip",
            "draft_cache_list",
        ] {
            assert!(commands.contains(denied), "{denied} is not a command");
            assert!(!message.contains(denied), "a letter's window may call {denied}");
        }
        // A reply written in a letter's own window takes dropped files (#79, #107): the drop
        // asks for the file's name and size, and for a picture dropped into the text.
        for needed in ["file_info", "inline_image", "pick_files", "drop_seen", "drop_outcome"] {
            assert!(message.contains(needed), "a letter's window may not call {needed}");
        }
    }
}
