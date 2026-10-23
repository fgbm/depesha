//! The interface of the web engine itself. WebView2 reloads the page on F5 and Ctrl+R and opens
//! its inspector from the keyboard; a built Depesha has no page to reload — a reload loses what the
//! window shows — and no inspector. Its menu of the right button is no letter's either: next to
//! «Cut», «Copy» and «Paste» it offers the emoji keyboard, the writing direction, an import of
//! passwords and tools of its own. Tauri's builder carries neither switch: they are WebView2's own,
//! reached through `with_webview`.

#[cfg(windows)]
mod menu;

/// Turns off the browser's accelerator keys of a window, and takes the engine's own items out of
/// its menu of the right button: the edits and the spelling stay, the rest goes. A debug build
/// keeps both, and a test build too, for the run drives the app by keyboard.
#[cfg(windows)]
pub fn quiet(window: &tauri::WebviewWindow) {
    use webview2_com::ContextMenuRequestedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_11, ICoreWebView2Settings3};
    use windows::core::Interface;
    if cfg!(debug_assertions) {
        return;
    }
    depesha_core::best_effort(
        "turn the engine's own keys off",
        window.with_webview(|wv| {
            // SAFETY: WebView2's own interfaces; the controller lives as long as the window, and
            // `with_webview` runs the closure on the thread that window belongs to.
            unsafe {
                let Ok(core) = wv.controller().CoreWebView2() else {
                    return;
                };
                let Ok(settings) = core.Settings() else { return };
                let Ok(keys) = settings.cast::<ICoreWebView2Settings3>() else {
                    return;
                };
                depesha_core::best_effort(
                    "set the engine's accelerator keys",
                    keys.SetAreBrowserAcceleratorKeysEnabled(false),
                );
                let Ok(webview) = core.cast::<ICoreWebView2_11>() else {
                    return;
                };
                let edits = ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        menu::edits_only(&args);
                    }
                    Ok(())
                }));
                // WebView2 keeps its own reference to the handler, and drops it with the window.
                depesha_core::best_effort(
                    "set the engine's menu of the right button",
                    webview.add_ContextMenuRequested(&edits, std::ptr::null_mut()),
                );
            }
        }),
    );
}

/// WKWebView and WebKitGTK reload nothing and open no inspector from the keyboard, and their menu
/// of a field is short: the app's own keys and the window's guard of the engine are the whole of it.
#[cfg(not(windows))]
pub fn quiet(_window: &tauri::WebviewWindow) {}
