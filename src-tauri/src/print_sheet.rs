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
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use tokio::sync::oneshot;

    thread_local! {
        /// The sheets loaded and not yet printed, by the label of the window they are printed from.
        /// A sheet leaves with its print: from then on its web view belongs to the operation
        /// (`print_mac.rs`), which lets it go when AppKit reports it over.
        static LOADED: RefCell<HashMap<String, (u64, Sheet)>> = RefCell::new(HashMap::new());
    }
    static TICKET: AtomicU64 = AtomicU64::new(0);

    let failed = |what: String| CmdError::new("print", what);
    fn host(wv: &tauri::webview::PlatformWebview) -> Option<(MainThreadMarker, &NSWindow)> {
        // SAFETY: Tauri gives the window's own NSWindow, which lives as long as the window.
        let window = unsafe { (wv.ns_window() as *const NSWindow).as_ref() }?;
        Some((MainThreadMarker::new()?, window))
    }

    let label = window.label().to_string();
    // Another print from this window while this one loads takes its place; this one then stops.
    let ticket = TICKET.fetch_add(1, Ordering::Relaxed);
    let superseded = || failed(tr!("another print took the place", "печать заменена другой"));

    let (loaded, started) = oneshot::channel();
    let key = label.clone();
    window
        .with_webview(move |wv| {
            let made = host(&wv).and_then(|(mtm, w)| Sheet::load(mtm, w, &html));
            let ok = made.is_some();
            if let Some(sheet) = made {
                LOADED.with(|l| l.borrow_mut().insert(key, (ticket, sheet)));
            }
            let _ = loaded.send(ok);
        })
        .map_err(|e| failed(e.to_string()))?;
    if !started.await.unwrap_or(false) {
        return Err(failed(tr!("the sheet did not load", "лист не загрузился")));
    }

    // Loaded, pictures included: not loading twice in a row. A page that hangs is printed as it is after a while.
    let mut quiet = 0;
    for _ in 0..150 {
        let (tx, rx) = oneshot::channel();
        let key = label.clone();
        window
            .run_on_main_thread(move || {
                let state = LOADED.with(|l| match l.borrow().get(&key) {
                    Some((t, sheet)) if *t == ticket => Some(sheet.loading()),
                    _ => None,
                });
                let _ = tx.send(state);
            })
            .map_err(|e| failed(e.to_string()))?;
        match rx.await {
            Ok(Some(false)) => quiet += 1,
            Ok(Some(true)) => quiet = 0,
            _ => return Err(superseded()),
        }
        if quiet >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let (done, result) = oneshot::channel();
    window
        .with_webview(move |wv| {
            let sheet = LOADED.with(|l| match l.borrow_mut().remove(&label) {
                Some((t, sheet)) if t == ticket => Some(sheet),
                // Not ours: a newer print's sheet goes back where it was.
                Some(other) => {
                    l.borrow_mut().insert(label.clone(), other);
                    None
                }
                None => None,
            });
            let printed = match (sheet, host(&wv)) {
                (Some(sheet), Some((mtm, w))) => {
                    sheet.print(mtm, w, &Output::Panel, |_| {});
                    true
                }
                _ => false,
            };
            let _ = done.send(printed);
        })
        .map_err(|e| failed(e.to_string()))?;
    if result.await.unwrap_or(false) {
        Ok(())
    } else {
        Err(failed(tr!(
            "the print panel did not open",
            "панель печати не открылась"
        )))
    }
}
