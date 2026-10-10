//! A copy of an error is the same error (#142): the interface and the status of a mailbox get a
//! copy of what the caller also gets, and it must be told apart as before.
use depesha_core::Error;

include!("../../../src-tauri/src/error_samples.in");

fn same(a: &Error, b: &Error, name: &str) {
    assert_eq!(a.kind(), b.kind(), "{name}: kind");
    assert_eq!(a.to_string(), b.to_string(), "{name}: words");
    assert_eq!(a.is_transient(), b.is_transient(), "{name}: transient");
    assert_eq!(a.retry_later(), b.retry_later(), "{name}: retry_later");
    assert_eq!(a.folder_gone(), b.folder_gone(), "{name}: folder_gone");
    assert_eq!(a.append_refused(), b.append_refused(), "{name}: append_refused");
    assert_eq!(a.no_rights(), b.no_rights(), "{name}: no_rights");
    assert_eq!(a.is_busy(), b.is_busy(), "{name}: busy");
    assert_eq!(a.is_conflict(), b.is_conflict(), "{name}: conflict");
    assert_eq!(a.back_off(), b.back_off(), "{name}: back_off");
}

#[test]
fn a_copy_of_every_error_is_told_apart_as_the_error_was() {
    let mut all = samples();
    // The errors of other libraries that cannot be copied as they are.
    all.push((
        "imap-parse".into(),
        Error::Imap(async_imap::error::Error::Parse(
            async_imap::error::ParseError::Unexpected("x".into()),
        )),
    ));
    all.push(("imap-append".into(), Error::Imap(async_imap::error::Error::Append)));
    all.push((
        "store-conversion".into(),
        Error::Store(rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            "bad".into(),
        )),
    ));
    all.push(("said".into(), Error::Said(depesha_core::Say::SignInCancelled)));
    for (name, e) in &all {
        let copy = e.clone();
        same(e, &copy, name);
        // And a copy of a copy.
        same(e, &copy.clone(), name);
    }
}

#[test]
fn a_copy_keeps_what_the_old_one_lost() {
    // These came out of the old copy as "unexpected answer from the server".
    let tls = Error::Tls(tokio_rustls::rustls::Error::General("x".into()));
    assert!(matches!(tls.clone(), Error::Tls(_)));
    let imap = Error::Imap(async_imap::error::Error::No("code: Some(NOPERM)".into()));
    assert!(matches!(imap.clone(), Error::Imap(async_imap::error::Error::No(_))));
    assert!(imap.clone().no_rights());
    let io = Error::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, "slow"));
    assert!(matches!(io.clone(), Error::Io(e) if e.kind() == std::io::ErrorKind::TimedOut));
    assert!(
        Error::Smtp {
            code: 451,
            enhanced: None,
            message: "later".into()
        }
        .clone()
        .is_transient()
    );
    assert!(Error::NotFound.clone().kind() == depesha_core::ErrorKind::NotFound);
}
