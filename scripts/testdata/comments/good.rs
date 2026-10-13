//! Fixture for scripts/check-comments.sh: no comment below may be flagged.

/// The queue holds the letters of the outbox. The send round takes them in order. A failure leaves a mark.
fn queue_state() {}

/// Reminds later, e.g. after one day or a week.
fn remind_later() {}

/// IMAP4rev2 folds IDLE, MOVE and STATUS=SIZE into the base protocol (RFC 9051, 7.2.2 and Appendix E.2).
fn capabilities() {}
