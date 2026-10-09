//! Files dropped on a window (#79). Tauri reports a drop as `WindowEvent::DragDrop` for the
//! content of a window (every window of this app) and as `WebviewEvent::DragDrop` only for
//! a webview added inside a window. Both are heard here, on any platform, and one drop is
//! acted on once. The files are allowed first, then the page is told with `files-dropped`.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, Runtime};

use crate::paths;
use crate::state::AppState;

/// The same drop reported twice within this time is one drop.
const SAME_DROP: Duration = Duration::from_millis(500);

static LAST: Mutex<Option<(Instant, String, Vec<PathBuf>)>> = Mutex::new(None);

/// Whether this drop is new: not the one `last` saw a moment ago for the same label.
fn is_new(last: &mut Option<(Instant, String, Vec<PathBuf>)>, now: Instant, label: &str, paths: &[PathBuf]) -> bool {
    if let Some((at, l, p)) = last
        && l == label
        && p == paths
        && now.duration_since(*at) < SAME_DROP
    {
        return false;
    }
    *last = Some((now, label.to_owned(), paths.to_vec()));
    true
}

/// The files among the dropped paths; the rest (folders) are only counted.
fn files(paths: &[PathBuf], is_file: impl Fn(&PathBuf) -> bool) -> (Vec<PathBuf>, usize) {
    let files: Vec<PathBuf> = paths.iter().filter(|p| is_file(p)).cloned().collect();
    let rest = paths.len() - files.len();
    (files, rest)
}

/// `source` is "window" or "webview": which of Tauri's two events brought the drop. Only
/// counts and the window label go to the log; the names of dropped files are personal data.
pub fn dropped<R, T>(source: &str, target: &T, label: &str, paths: &[PathBuf], position: tauri::PhysicalPosition<f64>)
where
    R: Runtime,
    T: Manager<R> + Emitter<R>,
{
    tracing::debug!(source, label, count = paths.len(), "a drop was reported");
    let new = is_new(
        &mut LAST.lock().unwrap_or_else(|e| e.into_inner()),
        Instant::now(),
        label,
        paths,
    );
    if !new {
        tracing::debug!(source, label, "the same drop was already handled");
        return;
    }
    let Some(state) = target.try_state::<std::sync::Arc<AppState>>() else {
        tracing::warn!(source, label, "a drop came before the app was ready");
        return;
    };
    let (allowed, not_files) = files(paths, |p| p.is_file());
    for path in &allowed {
        state.paths.allow(paths::Use::Attach, path.clone());
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

    fn p(s: &str) -> Vec<PathBuf> {
        s.split(',').map(PathBuf::from).collect()
    }

    #[test]
    fn one_drop_heard_twice_is_handled_once() {
        let mut last = None;
        let t = Instant::now();
        assert!(is_new(&mut last, t, "main", &p("a,b")));
        assert!(!is_new(&mut last, t + Duration::from_millis(50), "main", &p("a,b")));
    }

    #[test]
    fn the_same_files_later_or_elsewhere_are_a_new_drop() {
        let mut last = None;
        let t = Instant::now();
        assert!(is_new(&mut last, t, "main", &p("a")));
        assert!(is_new(&mut last, t + Duration::from_millis(10), "message-1", &p("a")));
        assert!(is_new(&mut last, t + Duration::from_millis(20), "message-1", &p("b")));
        assert!(is_new(&mut last, t + Duration::from_secs(2), "message-1", &p("b")));
    }

    #[test]
    fn folders_are_not_allowed_only_counted() {
        let (f, rest) = files(&p("a,dir,b"), |x| x.as_os_str() != "dir");
        assert_eq!(f, p("a,b"));
        assert_eq!(rest, 1);
    }
}
