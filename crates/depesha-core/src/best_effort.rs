//! Steps nobody can act on when they fail: a window that is already closed, a temporary file that
//! is already gone, a reply nobody waits for. They must not stop the work, and they must not vanish
//! without a trace either (`let _ =` hides them), so the failure goes to the log at debug level.
//! Only our own `Error` is picked out by its type, so a caller that wraps it (`Box<dyn Error>`, or
//! an error built from it) loses that protection and its words go to the log.

use std::any::Any;
use std::fmt::Display;

/// Runs past a failure of `what`, noting it in the log.
pub fn best_effort<T, E: Display + Any>(what: &str, result: Result<T, E>) {
    let Err(e) = result else { return };
    // Rust has no specialization: only our own error has facts a log line may keep, so it is
    // picked out by its type. Another crate's error has just its words, and those may quote a
    // server's answer (#191).
    match (&e as &dyn Any).downcast_ref::<crate::Error>() {
        Some(ours) => tracing::debug!(
            what,
            kind = ours.kind().as_str(),
            tag = ours.tag(),
            "a step that could be skipped failed"
        ),
        None => tracing::debug!("{what}: {e}"),
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

/// Eight lowercase hex digits of the id's SHA-256: no address of the mailbox, nor any part of one,
/// reaches the journal, and the same mailbox joins up in every run of every version.
pub fn mailbox_tag(account_id: &str) -> String {
    crate::tls::sha256_hex(account_id.as_bytes())[..8].to_owned()
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
    use crate::log_sink::logged;
    use tokio::sync::oneshot;

    #[test]
    fn a_failure_does_not_panic_or_return() {
        best_effort("remove a file", Err::<(), _>("already gone"));
        best_effort("remove a file", Ok::<_, &str>(()));
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

    /// The words of our own error stay out of the log, since they may quote a server's reply;
    /// its kind and variant tell what went wrong.
    #[test]
    fn an_own_error_is_noted_by_kind_and_variant_alone() {
        let line = logged(|| {
            best_effort(
                "leave the copy",
                Err::<(), _>(crate::Error::Auth("535 login user@example.org refused".into())),
            )
        });
        assert!(line.contains("leave the copy"), "{line}");
        assert!(line.contains("auth"), "{line}");
        assert!(!line.contains("example.org") && !line.contains("user@"), "{line}");
    }

    /// The line that names a mailbox: neither its domain nor the part before the `@` is in it,
    /// and the tag is, so two runs of two versions still join up on one mailbox.
    #[test]
    fn a_journal_line_names_no_address_of_the_mailbox() {
        let id = "user@example.org-1750000000";
        let line = logged(|| {
            tracing::warn!(account = %mailbox_tag(id), "the mailbox of this letter is not running");
        });
        assert!(line.contains("account=4ebe56f1"), "{line}");
        assert!(!line.contains("example.org") && !line.contains("user@"), "{line}");
    }

    /// The tag is a fixed value of the id and not of this build: a hash that shifts between
    /// releases would keep two runs of two versions apart.
    #[test]
    fn a_mailbox_tag_is_eight_hex_digits_of_a_fixed_hash() {
        assert_eq!(mailbox_tag("user@example.org-1750000000"), "4ebe56f1");
        assert_ne!(
            mailbox_tag("user@example.org-1750000000"),
            mailbox_tag("other@example.org-1750000001")
        );
        assert!(!mailbox_tag("user@example.org-1750000000").contains('@'));
    }
}
