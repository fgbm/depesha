//! Steps nobody can act on when they fail: a window that is already closed, a temporary file that
//! is already gone, a reply nobody waits for. They must not stop the work, and they must not vanish
//! without a trace either (`let _ =` hides them), so the failure goes to the log at debug level.

use std::fmt::Display;

/// Runs past a failure of `what`, noting it in the log.
pub fn best_effort<T, E: Display>(what: &str, result: Result<T, E>) {
    if let Err(e) = result {
        tracing::debug!("{what}: {e}");
    }
}

/// Removes a file or a folder the app made and no longer needs: `result` is what the removal gave.
/// One that is already gone is as good as removed and is not worth a line in the log; any other
/// failure (a folder without rights, a file in use) is noted, for it leaves something behind.
pub fn removed(what: &str, result: std::io::Result<()>) {
    if let Err(e) = result
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("{what}: {e}");
    }
}

/// A reply or a signal sent into a channel whose other end is gone: the one who asked has left, so
/// there is nobody to tell. The refused value is dropped.
pub fn unheard<T>(sent: Result<(), T>) {
    if sent.is_err() {
        tracing::trace!("nobody is waiting for this reply");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[test]
    fn a_failure_does_not_panic_or_return() {
        best_effort("remove a file", Err::<(), _>("already gone"));
        best_effort("remove a file", Ok::<_, &str>(()));
    }

    /// What the log got while `run` ran.
    fn logged(run: impl FnOnce()) -> String {
        use std::sync::{Arc, Mutex};
        #[derive(Clone, Default)]
        struct Sink(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Sink {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Sink {
            type Writer = Sink;
            fn make_writer(&'a self) -> Sink {
                self.clone()
            }
        }
        let sink = Sink::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(sink.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, run);
        let bytes = sink.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn a_file_that_is_gone_is_not_worth_a_line_but_any_other_failure_is() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            logged(|| removed("remove the copy", Err(Error::from(ErrorKind::NotFound)))),
            ""
        );
        assert_eq!(logged(|| removed("remove the copy", Ok(()))), "");
        let line = logged(|| removed("remove the copy", Err(Error::from(ErrorKind::PermissionDenied))));
        assert!(line.contains("remove the copy") && line.contains("WARN"), "{line}");
    }

    #[test]
    fn a_reply_to_a_dropped_receiver_is_let_go() {
        let (tx, rx) = oneshot::channel::<u8>();
        drop(rx);
        unheard(tx.send(1));
    }
}
