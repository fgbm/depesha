//! The keys of the web engine itself. WebView2 reloads the page on F5 and Ctrl+R and opens its
//! inspector from the keyboard; a built Depesha has no page to reload — a reload loses what the
//! window shows — and no inspector. Tauri's builder carries neither switch: they are WebView2's
//! own settings, reached through `with_webview`.

/// Turns off the browser's accelerator keys of a window: F5, Ctrl+R, F12 and the rest with them.
/// A debug build keeps them, and a test build too, for the run drives the app by keyboard.
#[cfg(windows)]
pub fn quiet(window: &tauri::WebviewWindow) {
    if cfg!(debug_assertions) {
        return;
    }
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;
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
            }
        }),
    );
}

/// WKWebView and WebKitGTK reload nothing and open no inspector from the keyboard: the app's own
/// keys are the whole of it.
#[cfg(not(windows))]
pub fn quiet(_window: &tauri::WebviewWindow) {}
