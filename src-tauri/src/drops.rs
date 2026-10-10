//! Files dropped on a window (#79). Tauri reports a drop as `WindowEvent::DragDrop` for the
//! content of a window (every window of this app) and as `WebviewEvent::DragDrop` only for
//! a webview added inside a window. Both are heard here, on any platform; the runtime sends
//! one of the two for a webview. The files are allowed first, then the page is told with
//! `files-dropped`.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{DragDropEvent, Emitter, Manager, Runtime, WebviewEvent, WindowEvent};

use crate::state::AppState;

/// The files among the dropped paths; the rest (folders) are only counted.
fn files(paths: &[PathBuf], is_file: impl Fn(&PathBuf) -> bool) -> (Vec<PathBuf>, usize) {
    let files: Vec<PathBuf> = paths.iter().filter(|p| is_file(p)).cloned().collect();
    let rest = paths.len() - files.len();
    (files, rest)
}

/// Where the allowed files are recorded: the state of the app, for the window they were
/// dropped on (#115). `false` while the app is not ready.
pub fn allow_in_state<'a, R: Runtime>(manager: &'a impl Manager<R>, label: &'a str) -> impl Fn(PathBuf) -> bool + 'a {
    move |path| match manager.try_state::<Arc<AppState>>() {
        Some(state) => {
            state.paths.allow_dropped(label, path);
            true
        }
        None => false,
    }
}

/// A window's own content reported a drop (every window of the app).
pub fn window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent, allow: impl Fn(PathBuf) -> bool) {
    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event {
        dropped("window", window, window.label(), paths, *position, allow);
    }
}

/// A webview added inside a window reported a drop.
pub fn webview_event<R: Runtime>(webview: &tauri::Webview<R>, event: &WebviewEvent, allow: impl Fn(PathBuf) -> bool) {
    if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event {
        dropped("webview", webview, webview.label(), paths, *position, allow);
    }
}

/// `source` is "window" or "webview": which of Tauri's two events brought the drop. Only
/// counts and the window label go to the log; the names of dropped files are personal data.
fn dropped<R, T>(
    source: &str,
    target: &T,
    label: &str,
    paths: &[PathBuf],
    position: tauri::PhysicalPosition<f64>,
    allow: impl Fn(PathBuf) -> bool,
) where
    R: Runtime,
    T: Emitter<R>,
{
    tracing::debug!(source, label, count = paths.len(), "a drop was reported");
    let (allowed, not_files) = files(paths, |p| p.is_file());
    for path in &allowed {
        if !allow(path.clone()) {
            tracing::warn!(source, label, "a drop came before the app was ready");
            return;
        }
    }
    tracing::debug!(label, allowed = allowed.len(), not_files, "dropped files allowed");
    if let Err(e) = target.emit_to(
        tauri::EventTarget::webview(label),
        "files-dropped",
        serde_json::json!({ "paths": allowed, "position": position }),
    ) {
        tracing::warn!(label, error = %e, "the page could not be told of the drop");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths;

    fn p(s: &str) -> Vec<PathBuf> {
        s.split(',').map(PathBuf::from).collect()
    }

    #[test]
    fn folders_are_not_allowed_only_counted() {
        let (f, rest) = files(&p("a,dir,b"), |x| x.as_os_str() != "dir");
        assert_eq!(f, p("a,b"));
        assert_eq!(rest, 1);
    }

    #[cfg(not(windows))]
    use std::sync::Mutex;
    #[cfg(not(windows))]
    use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

    #[cfg(not(windows))]
    fn tmp_file(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("depesha-drops-{}-{name}", std::process::id()));
        std::fs::write(&path, b"x").unwrap();
        path
    }

    /// What a drop does in a mock app with windows `main` and `message-1`: the window
    /// event goes through the same function `lib.rs` hands to the builder.
    #[cfg(not(windows))]
    #[test]
    fn a_drop_on_a_window_is_allowed_and_told_to_that_window_only() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let heard: Arc<Mutex<Vec<(&'static str, String)>>> = Default::default();
        for label in ["main", "message-1"] {
            let w = WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
                .build()
                .unwrap();
            let heard = heard.clone();
            w.as_ref().listen("files-dropped", move |e| {
                heard.lock().unwrap().push((label, e.payload().to_owned()))
            });
        }
        let granted = paths::Paths::default();
        for (label, other) in [("main", "message-1"), ("message-1", "main")] {
            heard.lock().unwrap().clear();
            let allow = |p: PathBuf| {
                granted.allow_dropped(label, p);
                true
            };
            let file = tmp_file(label);
            let window = app.get_webview_window(label).unwrap().as_ref().window();
            let event = WindowEvent::DragDrop(DragDropEvent::Drop {
                paths: vec![file.clone(), std::env::temp_dir()],
                position: tauri::PhysicalPosition::new(1.0, 2.0),
            });
            window_event(&window, &event, allow);

            let f = file.to_str().unwrap();
            // Only the window it was dropped on may attach it (#115).
            assert!(granted.check_in(Some(label), paths::Use::Attach, f).is_ok());
            assert!(granted.check_in(Some(other), paths::Use::Attach, f).is_err());
            assert!(granted.check(paths::Use::Attach, f).is_err());
            assert!(
                granted
                    .check_in(Some(label), paths::Use::Attach, std::env::temp_dir().to_str().unwrap())
                    .is_err()
            );
            let heard = heard.lock().unwrap();
            assert_eq!(heard.len(), 1, "{label}: {heard:?}");
            assert_eq!(heard[0].0, label, "told to {other}");
            assert!(heard[0].1.contains("depesha-drops"));
            std::fs::remove_file(file).ok();
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn a_second_identical_drop_is_not_swallowed() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let w = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let count = Arc::new(Mutex::new(0));
        let n = count.clone();
        w.as_ref().listen("files-dropped", move |_| *n.lock().unwrap() += 1);
        let file = tmp_file("twice");
        let window = app.get_webview_window("main").unwrap().as_ref().window();
        let event = WindowEvent::DragDrop(DragDropEvent::Drop {
            paths: vec![file.clone()],
            position: tauri::PhysicalPosition::new(0.0, 0.0),
        });
        window_event(&window, &event, |_| true);
        window_event(&window, &event, |_| true);
        assert_eq!(*count.lock().unwrap(), 2);
        std::fs::remove_file(file).ok();
    }
}
