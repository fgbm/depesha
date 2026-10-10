//! The core words nothing for the user (#142): an error's `Display` is English, for the log. If
//! it flows into a field or a message the edge shows, the user reads English. The compiler cannot
//! see that, so this guard reads the code: every place of the core that makes a string of an error
//! outside a log call is listed here with why it is safe, and a new one fails the test until it is
//! reasoned about (carry the error itself, as `Ended::Finished.skipped` does, or word it through
//! `outbox::Words`).
use std::fs;
use std::path::Path;

/// `(file, the line, why)`.
const ALLOWED: &[(&str, &str, &str)] = &[
    (
        "ews/mod.rs",
        "Error::Protocol(format!(\"EWS XML: {e}\"))",
        "the parser's own English text inside a Protocol error, as before",
    ),
    (
        "http.rs",
        "Error::Protocol(e.to_string())",
        "the HTTP library's own English text inside a Protocol error",
    ),
    (
        "http.rs",
        "Error::Said(Say::AnswerTooLarge { why: e.to_string() })",
        "the library's reason, a parameter of a phrase",
    ),
    (
        "http.rs",
        "Error::Protocol(format!(\"HTTP: {e}\"))",
        "the HTTP library's own English text inside a Protocol error",
    ),
    (
        "smtp.rs",
        "message.map_err(|e| Error::Compose(e.to_string()))",
        "the mail builder's own English text inside a Compose error",
    ),
    (
        "oauth.rs",
        "why: last.map(|e| e.to_string()).unwrap_or_default(),",
        "the OS reason, a parameter of a phrase",
    ),
    (
        "oauth.rs",
        "format!(\"{error} {detail}\").trim().to_owned()",
        "the provider's own words (not an Error)",
    ),
    (
        "oauth.rs",
        "_ => Error::Auth(format!(\"{error}: {detail}\")),",
        "the provider's own words (not an Error)",
    ),
    (
        "store.rs",
        "map_err(|e| crate::Error::Compose(e.to_string()))",
        "serde's text inside a Compose error; no user path",
    ),
    (
        "store/sent_copies.rs",
        "map_err(|e| crate::Error::Compose(e.to_string()))",
        "serde's text inside a Compose error; no user path",
    ),
    (
        "outbox.rs",
        "settle_failed_finish(store, copy, &e.to_string(), outcome.is_ok(), now, delay, words)?",
        "`E` is the caller's own error type, already worded (the edge passes its CmdError)",
    ),
    ("outbox.rs", "e.to_string()", "the English implementation of `Words`"),
    (
        "ews/ops.rs",
        "format!(\"<t:EventType>{e}</t:EventType>\")",
        "`e` is an event name of the request, not an error",
    ),
    (
        "ews/ops.rs",
        "seen.contains(&format!(\"{e}>\"))",
        "`e` is an event name of the response, not an error",
    ),
    (
        "store.rs",
        "parts.push(format!(\"{e} {}\", if desc",
        "`e` is a sort expression, not an error",
    ),
];

const LOG_CALLS: &[&str] = &["tracing::", "warn!", "debug!", "info!", "error!(", "trace!"];

fn files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn makes_text_of_an_error(line: &str) -> bool {
    let t = line.trim();
    if t.starts_with("//") || t.starts_with('"') {
        return false;
    }
    [
        "e.to_string()",
        "err.to_string()",
        "error.to_string()",
        "{e}",
        "{err}",
        "{error}",
    ]
    .iter()
    .any(|p| {
        // As a whole word: `name.to_string()` is not `e.to_string()`.
        line.match_indices(p)
            .any(|(i, _)| !line[..i].ends_with(|c: char| c.is_alphanumeric() || c == '_'))
    })
}

#[test]
fn the_core_makes_no_user_text_of_an_error_unseen() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut all = Vec::new();
    files(&src, &mut all);
    let mut found = Vec::new();
    for path in all {
        let rel = path.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
        // The errors themselves word their own English; tests and the phrases are not code paths.
        if matches!(rel.as_str(), "error.rs" | "say.rs") || rel.ends_with("tests.rs") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        let production = text.split("#[cfg(test)]").next().unwrap();
        for line in production.lines().filter(|l| makes_text_of_an_error(l)) {
            if LOG_CALLS.iter().any(|c| line.contains(c)) {
                continue;
            }
            if ALLOWED.iter().any(|(f, l, _)| *f == rel && line.contains(l)) {
                continue;
            }
            found.push(format!("{rel}: {}", line.trim()));
        }
    }
    assert!(
        found.is_empty(),
        "text made of an error in the core, not reasoned about:\n{}",
        found.join("\n")
    );
}

#[test]
fn every_allowed_place_still_exists() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for (file, line, why) in ALLOWED {
        let text = fs::read_to_string(src.join(file)).unwrap();
        assert!(
            text.contains(line),
            "{file}: `{line}` is gone, drop it from the list ({why})"
        );
    }
}
