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

    #[test]
    fn a_reply_to_a_dropped_receiver_is_let_go() {
        let (tx, rx) = oneshot::channel::<u8>();
        drop(rx);
        unheard(tx.send(1));
    }
}
