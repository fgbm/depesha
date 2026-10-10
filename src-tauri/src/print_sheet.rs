//! The command behind printing on macOS (#70): the frontend hands over the finished sheet, and
//! the system's print panel opens for it. Other systems print from a frame in the page and
//! never call this; see `print_mac.rs` for why macOS cannot.

use crate::error::{CmdError, CmdResult};
use std::collections::HashMap;

/// The error kind of a print that another print from the same window took the place of. It is
/// not a failure to show: the newer print is the one the user asked for last. The frontend
/// (`print.ts`) swallows it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const SUPERSEDED: &str = "superseded";

/// What `Loaded::take` found for a ticket.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Taken<S> {
    Mine(S),
    /// Another print's sheet stands there now (it was left), or none: this print was replaced.
    Superseded,
}

/// The sheets loaded and not yet printed, by the label of the window they are printed from, each
/// with the ticket of the print that loaded it. A newer print from a window takes its place.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Loaded<S>(HashMap<String, (u64, S)>);

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl<S> Default for Loaded<S> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl<S> Loaded<S> {
    pub fn new() -> Self {
        Self(HashMap::new())
    }

    /// Stores the sheet; the one that stood there is returned (to be dropped on the main thread).
    pub fn insert(&mut self, label: &str, ticket: u64, sheet: S) -> Option<S> {
        self.0.insert(label.to_string(), (ticket, sheet)).map(|(_, old)| old)
    }

    /// The sheet of this ticket, if it still stands.
    pub fn get(&self, label: &str, ticket: u64) -> Option<&S> {
        self.0.get(label).filter(|(t, _)| *t == ticket).map(|(_, s)| s)
    }

    /// Takes the sheet of this ticket out; another print's sheet is left where it is.
    pub fn take(&mut self, label: &str, ticket: u64) -> Taken<S> {
        if self.get(label, ticket).is_none() {
            return Taken::Superseded;
        }
        match self.0.remove(label) {
            Some((_, sheet)) => Taken::Mine(sheet),
            None => Taken::Superseded,
        }
    }

    /// Lets this ticket's sheet go (a print that ended by an error); another print's is left.
    pub fn forget(&mut self, label: &str, ticket: u64) -> Option<S> {
        match self.take(label, ticket) {
            Taken::Mine(sheet) => Some(sheet),
            Taken::Superseded => None,
        }
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use tokio::sync::oneshot;

    thread_local! {
        /// The sheets loaded and not yet printed. A sheet leaves with its print: from then on its
        /// web view belongs to the operation (`print_mac.rs`), which lets it go when AppKit reports it over.
        static LOADED: RefCell<Loaded<Sheet>> = RefCell::new(Loaded::new());
    }
    static TICKET: AtomicU64 = AtomicU64::new(0);

    /// Takes this print's sheet out of `LOADED` on every way out of the command but the print
    /// itself (an error, or the caller giving up): the web view goes out of the window on the main thread.
    struct Holding {
        window: tauri::WebviewWindow,
        label: String,
        ticket: u64,
        armed: bool,
    }
    impl Drop for Holding {
        fn drop(&mut self) {
            if self.armed {
                let (label, ticket) = (self.label.clone(), self.ticket);
                let _ = self.window.run_on_main_thread(move || {
                    let sheet = LOADED.with(|l| l.borrow_mut().forget(&label, ticket));
                    drop(sheet);
                });
            }
        }
    }

    enum Outcome {
        Printed,
        Superseded,
        NoWindow,
    }

    let failed = |what: String| CmdError::new("print", what);
    let superseded = || {
        CmdError::new(
            SUPERSEDED,
            tr!("another print took the place", "печать заменена другой"),
        )
    };
    fn host(wv: &tauri::webview::PlatformWebview) -> Option<(MainThreadMarker, &NSWindow)> {
        // SAFETY: Tauri gives the window's own NSWindow, which lives as long as the window.
        let window = unsafe { (wv.ns_window() as *const NSWindow).as_ref() }?;
        Some((MainThreadMarker::new()?, window))
    }

    let label = window.label().to_string();
    // Another print from this window while this one loads takes its place; this one then stops.
    let ticket = TICKET.fetch_add(1, Ordering::Relaxed);
    let mut holding = Holding {
        window: window.clone(),
        label: label.clone(),
        ticket,
        armed: true,
    };

    let (loaded, started) = oneshot::channel();
    let key = label.clone();
    window
        .with_webview(move |wv| {
            let made = host(&wv).and_then(|(mtm, w)| Sheet::load(mtm, w, &html));
            let ok = made.is_some();
            if let Some(sheet) = made {
                // The sheet this one takes the place of leaves the window here, on the main thread.
                let old = LOADED.with(|l| l.borrow_mut().insert(&key, ticket, sheet));
                drop(old);
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
                let state = LOADED.with(|l| l.borrow().get(&key, ticket).map(Sheet::loading));
                let _ = tx.send(state);
            })
            .map_err(|e| failed(e.to_string()))?;
        match rx.await {
            Ok(Some(false)) => quiet += 1,
            Ok(Some(true)) => quiet = 0,
            Ok(None) => return Err(superseded()),
            Err(_) => return Err(failed(tr!("the sheet is gone", "лист пропал"))),
        }
        if quiet >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let (done, result) = oneshot::channel();
    let key = label.clone();
    window
        .with_webview(move |wv| {
            let outcome = match LOADED.with(|l| l.borrow_mut().take(&key, ticket)) {
                Taken::Mine(sheet) => match host(&wv) {
                    Some((mtm, w)) => {
                        sheet.print(mtm, w, &Output::Panel, |_| {});
                        Outcome::Printed
                    }
                    None => Outcome::NoWindow,
                },
                Taken::Superseded => Outcome::Superseded,
            };
            let _ = done.send(outcome);
        })
        .map_err(|e| failed(e.to_string()))?;
    // Out of `LOADED` one way or the other: nothing left for the guard to do.
    holding.armed = false;
    match result.await {
        Ok(Outcome::Printed) => Ok(()),
        Ok(Outcome::Superseded) => Err(superseded()),
        _ => Err(failed(tr!(
            "the print panel did not open",
            "панель печати не открылась"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::{Loaded, Taken};

    #[test]
    fn a_newer_print_takes_the_place_and_the_older_is_superseded() {
        let mut loaded = Loaded::new();
        assert_eq!(loaded.insert("main", 1, "first"), None);
        // The second print from the same window takes the first's place; the first sheet comes back to be dropped.
        assert_eq!(loaded.insert("main", 2, "second"), Some("first"));
        assert!(loaded.get("main", 1).is_none());
        assert_eq!(loaded.take("main", 1), Taken::Superseded);
        // The older print asking does not take the newer one's sheet away.
        assert_eq!(loaded.get("main", 2), Some(&"second"));
        assert_eq!(loaded.take("main", 2), Taken::Mine("second"));
        assert!(loaded.is_empty());
    }

    #[test]
    fn windows_have_sheets_of_their_own() {
        let mut loaded = Loaded::new();
        loaded.insert("main", 1, "a");
        loaded.insert("message-7", 2, "b");
        assert_eq!(loaded.take("message-7", 2), Taken::Mine("b"));
        assert_eq!(loaded.take("main", 1), Taken::Mine("a"));
    }

    #[test]
    fn a_print_that_ends_by_an_error_lets_only_its_own_sheet_go() {
        let mut loaded = Loaded::new();
        loaded.insert("main", 1, "mine");
        assert_eq!(loaded.forget("main", 2), None, "another ticket's sheet is not touched");
        assert!(loaded.get("main", 1).is_some());
        assert_eq!(loaded.forget("main", 1), Some("mine"));
        assert!(loaded.is_empty());
        assert_eq!(loaded.forget("main", 1), None, "a second go is harmless");
    }

    #[test]
    fn the_superseded_kind_is_the_one_the_frontend_swallows() {
        // print.ts compares with this word.
        assert_eq!(super::SUPERSEDED, "superseded");
        let front = include_str!("../../src/lib/print.ts");
        assert!(front.contains("\"superseded\""), "print.ts does not know the kind");
    }
}
