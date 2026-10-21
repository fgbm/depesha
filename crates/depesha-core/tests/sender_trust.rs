// The corpus of headers of real letters, anonymized (0.8.13, 7.1 Б).
//
// Each file is the block of headers of a letter as the mailbox's server hands it over, with the
// addresses of people and the addresses of the machines inside replaced. The `From`, the
// `Authentication-Results` of the server, the `DKIM-Signature` and the `Date` are as they came:
// they are what the check of the sender reads.
//
// Two of the letters carry a signature: they are signed with the test key of `keys/s1.pkcs8` by
// `mail-auth`'s own signer, as their senders sign, and the key is published to the check as the
// name servers of the internet would publish it. The signature is a real one, and the check
// verifies it as it verifies any other (docs/sender-corpus.md says how to sign again).
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
use mail_auth::common::crypto::Ed25519Key;
use mail_auth::common::headers::HeaderWriter;
use mail_auth::dkim::DkimSigner;

/// The address of the mailbox the corpus letters came to.
const MAILBOX: &str = "me@box.example";

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

fn dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sender")
}

/// The corpus and the table of what each letter is expected to be.
fn corpus() -> Vec<(Row, Vec<u8>)> {
    let table =
        std::fs::read_to_string(dir().join("table.json")).unwrap_or_else(|e| panic!("the table of the corpus: {e}"));
    let rows: Vec<Row> =
        serde_json::from_str(&table).unwrap_or_else(|e| panic!("the table of the corpus is JSON: {e}"));
    rows.into_iter()
        .map(|row| {
            let text = std::fs::read(dir().join(&row.file)).unwrap_or_else(|e| panic!("a letter of the corpus: {e}"));
            (row, text)
        })
        .collect()
}

/// The test key the signed letters of the corpus are signed with: `keys/s1.pkcs8` is the PKCS#8
/// DER of its private half, base64. It signs nothing outside these files.
fn corpus_key() -> Ed25519Key {
    use base64::Engine;
    let path = dir().join("keys/s1.pkcs8");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let der = base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    Ed25519Key::from_pkcs8_der(&der).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The DNS record of the corpus key, as its owner's name server publishes it.
fn corpus_record() -> String {
    use base64::Engine;
    let key = corpus_key();
    let p = base64::engine::general_purpose::STANDARD.encode(key.public_key());
    format!("v=DKIM1; k=ed25519; p={p}")
}

/// The check, with the key of the corpus letters published to it as the name servers would. No
/// other name is answered: a check that needs one gets none.
fn published() -> dkim::Verifier {
    let v = dkim::Verifier::default();
    assert!(
        v.add_answer("s1._domainkey.timeweb.cloud.", &corpus_record()),
        "the key of the signed letters of the corpus"
    );
    v
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
    let path = dir().join(name);
    path.exists()
        .then(|| std::fs::read(path).unwrap_or_else(|e| panic!("the original headers of a letter: {e}")))
}

/// The check of the sender of a letter, as the ladder decides it, with what the app's own checks
/// found.
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
        uneven_headers: auth.uneven,
        by_address: false,
    };
    sender::decide(&evidence)
}

/// What the app's own check of a letter found.
#[derive(Default)]
struct Own {
    /// The check of the whole letter.
    full: Option<dkim::Signature>,
    /// The check of the signature over the original headers of Exchange.
    headers: Option<dkim::Headers>,
}

/// What the app's own checks find for a letter of the corpus: the very checks the window runs,
/// with the key of the signed letters published instead of the name servers.
async fn own_of(row: &Row, raw: &[u8], check: &dkim::Verifier) -> Own {
    let headers = original(row);
    let offline = dkim::offline_verdict(raw, &row.from);
    let full = match sender::body_check(None, offline, headers.is_some()) {
        Some(found) => Some(found),
        // Nothing is known without a lookup: the check asks for the key of the sender.
        None if headers.is_none() => Some(check.check(raw, &row.from).await),
        None => None,
    };
    let headers = match &headers {
        Some(bytes) => Some(headers_check(bytes, row, check).await),
        None => None,
    };
    Own { full, headers }
}

/// The check of the original headers of Exchange: the address of the mailbox must stand in a
/// header the signature covers, and the letter must be of this time (0.8.13, ступень 4).
///
/// The corpus has no receipt time of its own: the time the signature names stands for it. The
/// check of a letter of another time has its own tests in `dkim.rs`.
async fn headers_check(bytes: &[u8], row: &Row, check: &dkim::Verifier) -> dkim::Headers {
    match dkim::replay_time(bytes, MAILBOX) {
        Some((recipient, at)) if dkim::not_a_replay(bytes, MAILBOX, at) => {
            check.check_headers(bytes, &row.from, recipient).await
        }
        _ => dkim::Headers::Rejected(dkim::Reason::Replay),
    }
}

/// Every letter of the corpus is judged as the table says.
#[tokio::test]
async fn the_corpus_is_judged_as_the_table_says() {
    let check = published();
    for (row, text) in corpus() {
        let own = own_of(&row, &text, &check).await;
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
    let letter = std::fs::read(dir().join(&row.file)).unwrap_or_else(|e| panic!("the letter of Exchange: {e}"));
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
        uneven_headers: false,
        by_address: true,
    };
    let verdict = sender::decide(&evidence);
    assert!(!verdict.confirmed);
    assert_eq!(verdict.reason, sender::Reason::Server);
}

/// Signs the signed letters of the corpus with the test key of `keys/s1.pkcs8`, as their senders
/// sign. Run it after a letter that carries a `DKIM-Signature` changes:
///
///     cargo test -p depesha-core --test sender_trust -- --ignored sign_the_corpus
///
/// The letters are written with the line endings they have (LF), and the signature header is
/// prepended to them, so the file stays one letter the check reads whole.
#[test]
#[ignore = "rewrites the letters of the corpus"]
fn sign_the_corpus() {
    for (file, domain, headers) in [
        (
            "exchange-ews-timeweb-original.txt",
            "timeweb.cloud",
            ["From", "To", "Subject", "Date"],
        ),
        (
            "own-imap-newsletter.txt",
            "timeweb.cloud",
            ["From", "To", "Subject", "Date"],
        ),
    ] {
        let path = dir().join(file);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        // The signature the sender wrote goes: it was a placeholder of the old corpus.
        let letter = text
            .lines()
            .filter(|line| !line.starts_with("DKIM-Signature:"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let signer = DkimSigner::from_key(corpus_key())
            .domain(domain)
            .selector("s1")
            .headers(headers);
        let signature = signer.sign(letter.as_bytes()).unwrap_or_else(|e| panic!("{file}: {e}"));
        let header = signature.to_header().replace("\r\n", "\n");
        std::fs::write(&path, format!("{header}{letter}")).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        println!("signed {file}");
    }
}
