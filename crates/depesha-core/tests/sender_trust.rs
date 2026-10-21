// The corpus of headers of real letters, anonymized (0.8.13, 7.1 Б).
//
// Each file is the block of headers of a letter as the mailbox's server hands it over, with the
// addresses of people and the addresses of the machines inside replaced. The `From`, the
// `Authentication-Results` of the server, the `DKIM-Signature` and the `Date` are as they came:
// they are what the check of the sender reads.
//
// A letter that came through Exchange in the firm's own network has its original headers in the
// file `exchange-ews-timeweb-original.txt` — the block `PR_TRANSPORT_MESSAGE_HEADERS` (`0x007D`),
// which is what the signature covers. The letter itself is in `exchange-ews-timeweb.txt`: the
// same letter, with the body Exchange assembled again.
//
// The table of what each letter is expected to be is in `table.json` next to these files.

use std::path::Path;

use depesha_core::avatar::Receiver;
use depesha_core::{dkim, message, sender};

/// One row of the table: the letter, the mailbox it came to and what the check must say.
#[derive(Debug, serde::Deserialize)]
struct Row {
    /// The file of the letter, next to this one.
    file: String,
    /// The kind of mailbox the letter came to: `gmail`, `yandex`, `mailru`, `exchange-online`,
    /// `exchange-ews`, `own-imap`.
    mailbox: String,
    /// The address the letter says it is from.
    from: String,
    /// The step of the ladder that must decide.
    step: String,
    /// Whether the pictures of the letter may be shown.
    pictures: bool,
    /// Whether the brand logo of the sender may stand next to it.
    logo: bool,
    /// The reason, when nothing confirmed the sender.
    #[serde(default)]
    reason: Option<String>,
}

/// The corpus and the table of what each letter is expected to be.
fn corpus() -> Vec<(Row, Vec<u8>)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sender");
    let table =
        std::fs::read_to_string(dir.join("table.json")).unwrap_or_else(|e| panic!("the table of the corpus: {e}"));
    let rows: Vec<Row> =
        serde_json::from_str(&table).unwrap_or_else(|e| panic!("the table of the corpus is JSON: {e}"));
    rows.into_iter()
        .map(|row| {
            let text = std::fs::read(dir.join(&row.file)).unwrap_or_else(|e| panic!("a letter of the corpus: {e}"));
            (row, text)
        })
        .collect()
}

/// The mailbox of a row: whose `Authentication-Results` count, and whose own word about the
/// sender.
fn receiver(kind: &str) -> Receiver {
    let (domains, vouches, exchange, exchange_online) = match kind {
        "gmail" => (vec!["gmail.com".into()], true, false, false),
        "yandex" => (vec!["yandex.ru".into(), "yandex.net".into()], true, false, false),
        "mailru" => (vec!["mail.ru".into()], true, false, false),
        "exchange-online" => (vec!["outlook.com".into()], true, true, true),
        "exchange-ews" => (vec!["firm.example".into()], false, true, false),
        "own-imap" => (vec!["firm.example".into()], false, false, false),
        other => panic!("an unknown mailbox in the table: {other}"),
    };
    Receiver {
        domains,
        vouches,
        exchange,
        exchange_online,
        ..Receiver::default()
    }
}

/// The expected step, as the ladder names it.
fn step(name: &str) -> sender::Step {
    match name {
        "1" => sender::Step::ServerDmarc,
        "2" => sender::Step::ServerSignature,
        "3" => sender::Step::OwnFull,
        "4" => sender::Step::OwnHeaders,
        "internal" => sender::Step::Internal,
        "address" => sender::Step::AddressOnly,
        "-" => sender::Step::None,
        other => panic!("an unknown step in the table: {other}"),
    }
}

/// The reason, as the ladder names it.
fn reason(name: &str) -> sender::Reason {
    match name {
        "server" => sender::Reason::Server,
        "unsigned" => sender::Reason::Unsigned,
        "signature" => sender::Reason::Signature,
        "unchecked" => sender::Reason::Unchecked,
        "ambiguous_from" => sender::Reason::AmbiguousFrom,
        "checking" => sender::Reason::Checking,
        "no_check" => sender::Reason::NoCheck,
        "address_only" => sender::Reason::AddressOnly,
        other => panic!("an unknown reason in the table: {other}"),
    }
}

/// The original headers of a letter of Exchange, when the row has them: the block
/// `PR_TRANSPORT_MESSAGE_HEADERS` (`0x007D`) the server kept aside of the letter it assembled
/// again.
fn original(row: &Row) -> Option<Vec<u8>> {
    let name = row
        .file
        .strip_suffix(".txt")
        .map(|name| format!("{name}-original.txt"))?;
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sender").join(name);
    path.exists()
        .then(|| std::fs::read(path).unwrap_or_else(|e| panic!("the original headers of a letter: {e}")))
}

/// The check of the sender of a letter, as the ladder decides it.
///
/// What the app's own check found is taken from the row: the step of the ladder says which
/// check was made, and the reason says what it found. A letter of the corpus is judged by the
/// headers it carries, not by a key of a test.
fn verdict(row: &Row, raw: &[u8], own: &Own) -> sender::Verdict {
    let receiver = receiver(&row.mailbox);
    let auth = message::authenticity(raw, &receiver);
    let evidence = sender::Evidence {
        server: auth.check.clone(),
        own_full: own.full,
        own_headers: own.headers,
        own_due: false,
        sole_from: message::sole_from(raw).is_some_and(|from| from == row.from),
        internal: auth.internal,
        by_address: false,
    };
    sender::decide(&evidence)
}

/// What the app's own check of a letter found.
struct Own {
    /// The check of the whole letter.
    full: Option<dkim::Signature>,
    /// The check of the signature over the original headers of Exchange.
    headers: Option<dkim::Headers>,
}

/// The own check a row of the table stands for.
fn own_of(row: &Row) -> Own {
    match row.step.as_str() {
        // The server's word stands; the app's own check is not made.
        "1" | "2" => Own {
            full: None,
            headers: None,
        },
        "3" => Own {
            full: Some(dkim::Signature::Aligned),
            headers: None,
        },
        "4" => Own {
            full: None,
            headers: Some(dkim::Headers::Valid),
        },
        "-" => Own {
            full: match row.reason.as_deref() {
                Some("unsigned") => Some(dkim::Signature::Unsigned),
                Some("signature") => Some(dkim::Signature::NotAligned),
                Some("unchecked") => Some(dkim::Signature::Unchecked),
                _ => None,
            },
            headers: None,
        },
        other => panic!("an unknown step in the table: {other}"),
    }
}

/// Every letter of the corpus is judged as the table says.
#[test]
fn the_corpus_is_judged_as_the_table_says() {
    for (row, text) in corpus() {
        let own = own_of(&row);
        let verdict = verdict(&row, &text, &own);
        assert_eq!(verdict.step, step(&row.step), "{}: the step", row.file);
        assert_eq!(verdict.confirmed, row.pictures, "{}: the pictures", row.file);
        assert_eq!(verdict.logo, row.logo, "{}: the logo", row.file);
        if let Some(want) = &row.reason {
            assert_eq!(verdict.reason, reason(want), "{}: the reason", row.file);
        }
    }
}

/// The corpus covers every step of the ladder.
#[test]
fn the_corpus_covers_every_step() {
    let mut steps: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for (row, _) in corpus() {
        *steps.entry(row.step.clone()).or_default() += 1;
    }
    for step in ["1", "2", "3", "4", "-"] {
        assert!(steps.get(step).copied().unwrap_or(0) > 0, "no letter of step {step}");
    }
}

/// The original headers of a letter of Exchange are there: the check of the signature over them
/// is made, and the body that came with the letter is not what the signature covers.
#[test]
fn the_original_headers_of_exchange_are_kept() {
    let (row, _) = corpus()
        .into_iter()
        .find(|(row, _)| row.step == "4")
        .expect("a letter of Exchange with original headers");
    let headers = original(&row).expect("the original headers of a letter of Exchange");
    let text = String::from_utf8(headers).expect("the original headers are text");
    // The original headers carry the signature; the letter Exchange assembled again does not.
    assert!(text.contains("DKIM-Signature:"), "{text}");
    let letter = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/sender")
            .join(&row.file),
    )
    .unwrap_or_else(|e| panic!("the letter of Exchange: {e}"));
    assert!(!String::from_utf8_lossy(&letter).contains("DKIM-Signature:"));
}

/// A letter the server said no to is not confirmed, whatever the app's own check found: the
/// server's «no» stands.
#[test]
fn the_servers_no_is_not_overruled() {
    let (row, text) = corpus()
        .into_iter()
        .find(|(row, _)| row.reason.as_deref() == Some("server"))
        .expect("a letter the server said no to");
    let auth = message::authenticity(&text, &receiver(&row.mailbox));
    let evidence = sender::Evidence {
        server: auth.check.clone(),
        own_full: Some(dkim::Signature::Aligned),
        own_headers: None,
        own_due: false,
        sole_from: true,
        internal: false,
        by_address: true,
    };
    let verdict = sender::decide(&evidence);
    assert!(!verdict.confirmed);
    assert_eq!(verdict.reason, sender::Reason::Server);
}
