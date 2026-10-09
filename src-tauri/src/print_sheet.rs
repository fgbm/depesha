//! The command behind printing on macOS (#70): the frontend hands over the finished sheet, and
//! the system's print panel opens for it. Other systems print from a frame in the page and
//! never call this; see `print_mac.rs` for why macOS cannot.

use crate::error::{CmdError, CmdResult};

#[cfg(not(target_os = "macos"))]
pub async fn print(_window: &tauri::WebviewWindow, _html: String) -> CmdResult<()> {
    use depesha_core::tr;
    Err(CmdError::new(
        "unsupported",
        tr!(
            "printing a sheet is for macOS only",
            "печать листа через команду — только на macOS"
        ),
    ))
}

#[cfg(target_os = "macos")]
pub async fn print(window: &tauri::WebviewWindow, html: String) -> CmdResult<()> {
    use crate::print_mac::{Output, Sheet};
    use depesha_core::tr;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;
    use std::cell::RefCell;
    use std::sync::mpsc;
    use std::time::Duration;

    thread_local! {
        /// The sheet of the last print: the panel reads its pages once it is answered, so it
        /// stays until the next print.
        static CURRENT: RefCell<Option<Sheet>> = const { RefCell::new(None) };
    }
    let failed = |what: String| CmdError::new("print", what);
    fn host(wv: &tauri::webview::PlatformWebview) -> Option<(MainThreadMarker, &NSWindow)> {
        // SAFETY: Tauri gives the window's own NSWindow, which lives as long as the window.
        let window = unsafe { (wv.ns_window() as *const NSWindow).as_ref() }?;
        Some((MainThreadMarker::new()?, window))
    }

    let (loaded, started) = mpsc::channel();
    window
        .with_webview(move |wv| {
            let made = host(&wv).and_then(|(mtm, w)| Sheet::load(mtm, w, &html));
            let ok = made.is_some();
            CURRENT.with(|c| *c.borrow_mut() = made);
            let _ = loaded.send(ok);
        })
        .map_err(|e| failed(e.to_string()))?;
    if !started.recv().unwrap_or(false) {
        return Err(failed(tr!("the sheet did not load", "лист не загрузился")));
    }

    // Loaded, pictures included: not loading twice in a row. A page that hangs is printed as it is after a while.
    let mut quiet = 0;
    for _ in 0..150 {
        let (tx, rx) = mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(CURRENT.with(|c| c.borrow().as_ref().map(Sheet::loading)));
            })
            .map_err(|e| failed(e.to_string()))?;
        match rx.recv() {
            Ok(Some(false)) => quiet += 1,
            Ok(Some(true)) => quiet = 0,
            _ => return Err(failed(tr!("the sheet is gone", "лист пропал"))),
        }
        if quiet >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let (done, result) = mpsc::channel();
    window
        .with_webview(move |wv| {
            let printed = host(&wv).is_some_and(|(_, w)| {
                CURRENT.with(|c| c.borrow().as_ref().map(|s| s.print(w, &Output::Panel)).is_some())
            });
            let _ = done.send(printed);
        })
        .map_err(|e| failed(e.to_string()))?;
    if result.recv().unwrap_or(false) {
        Ok(())
    } else {
        Err(failed(tr!(
            "the print panel did not open",
            "панель печати не открылась"
        )))
    }
}
