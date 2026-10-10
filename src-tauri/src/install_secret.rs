//! The install secret: 32 random bytes that sign the `depesha://` links the app makes, so a
//! link from anywhere else — a letter, a web page, a script — cannot open the user's mail.
//!
//! Kept in the data directory with mode 600 rather than in the keyring: the keyring is
//! per-account and asynchronous, while this secret is the whole installation's and is needed
//! synchronously to sign a toast's `launch` and to check one that arrives. It is not a
//! password: it only tells a link of ours from a stranger's.
//!
//! `sign`/`verify` are the whole contract: the draft marker `X-Depesha-Acts-On` signs its
//! bytes the same way, so a letter claim cannot be forged either.

use std::path::Path;
use std::sync::OnceLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::aead;
use ring::hkdf;
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

/// The secret of this installation, set once at startup.
static SECRET: OnceLock<[u8; 32]> = OnceLock::new();

/// Reads the install secret from `path`, making one on first run. A secret that cannot be
/// read or written falls back to a run-only one: this session's own links still verify.
pub fn init(path: &Path) {
    let secret = match load_or_create(path) {
        Ok(secret) => secret,
        Err(e) => {
            // Once, at start: until the file can be written, every start has a new secret, and
            // the drafts saved before it lose what they answer and their time (#157).
            tracing::warn!(
                "install secret at {}: {e}; signing with a run-only secret, saved drafts will lose what they answer and their time on the next start",
                path.display()
            );
            random()
        }
    };
    let _ = SECRET.set(secret);
}

/// The secret the tests sign and verify with, without touching the disk.
#[cfg(test)]
pub(crate) fn init_with(secret: [u8; 32]) {
    let _ = SECRET.set(secret);
}

/// Signs `bytes`; the URL-safe base64 of the HMAC-SHA256 tag, empty when no secret is set.
pub fn sign(bytes: &[u8]) -> String {
    match SECRET.get() {
        Some(secret) => URL_SAFE_NO_PAD.encode(tag(secret, bytes)),
        None => String::new(),
    }
}

/// Seals `plain` for a draft header (#157): AES-256-GCM under a key derived from the secret,
/// `1.` and the URL-safe base64 of nonce and ciphertext. The value shows nothing of `plain`
/// to whoever the draft reaches, and opens only here. None when no secret is set.
pub fn seal(plain: &[u8], bound: &str) -> Option<String> {
    seal_with(SECRET.get()?, plain, bound)
}

pub(crate) fn seal_with(secret: &[u8; 32], plain: &[u8], bound: &str) -> Option<String> {
    let key = draft_key(secret)?;
    let mut nonce = [0u8; aead::NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).ok()?;
    let mut sealed = plain.to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(aad(bound)),
        &mut sealed,
    )
    .ok()?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&sealed);
    Some(format!("1.{}", URL_SAFE_NO_PAD.encode(out)))
}

/// What `seal` sealed, or None for anything else: another installation's, a changed one, a
/// value that is not ours.
pub fn open(value: &str, bound: &str) -> Option<Vec<u8>> {
    open_with(SECRET.get()?, value, bound)
}

fn open_with(secret: &[u8; 32], value: &str, bound: &str) -> Option<Vec<u8>> {
    let key = draft_key(secret)?;
    let bytes = URL_SAFE_NO_PAD.decode(value.trim().strip_prefix("1.")?).ok()?;
    if bytes.len() < aead::NONCE_LEN + aead::AES_256_GCM.tag_len() {
        return None;
    }
    let (nonce, rest) = bytes.split_at(aead::NONCE_LEN);
    let mut buf = rest.to_vec();
    let plain = key
        .open_in_place(
            aead::Nonce::try_assume_unique_for_key(nonce).ok()?,
            aead::Aad::from(aad(bound)),
            &mut buf,
        )
        .ok()?;
    Some(plain.to_vec())
}

const SEAL_AAD: &[u8] = b"X-Depesha-Draft 1";

/// What the sealed value is bound to besides the key: the Message-ID of the letter it is in.
fn aad(bound: &str) -> Vec<u8> {
    let mut aad = SEAL_AAD.to_vec();
    aad.push(0);
    aad.extend_from_slice(bound.as_bytes());
    aad
}

/// The `info` of the draft key: another purpose of the secret takes another one.
const DRAFT_KEY_INFO: &[u8] = b"depesha draft mark key 1";

struct Key32;

impl hkdf::KeyType for Key32 {
    fn len(&self) -> usize {
        32
    }
}

/// HKDF-SHA256 of the secret under its own `info`: the key of the draft cipher is nothing
/// `sign` can be made to give (the signatures of 0.8.0 stay as they were).
fn draft_key_bytes(secret: &[u8; 32]) -> Vec<u8> {
    let mut key = vec![0u8; 32];
    hkdf::Salt::new(hkdf::HKDF_SHA256, &[])
        .extract(secret)
        .expand(&[DRAFT_KEY_INFO], Key32)
        .and_then(|okm| okm.fill(&mut key))
        .expect("32 bytes are within the HKDF-SHA256 limit");
    key
}

fn draft_key(secret: &[u8; 32]) -> Option<aead::LessSafeKey> {
    let key = draft_key_bytes(secret);
    Some(aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &key).ok()?,
    ))
}

/// Whether `sig` is `sign(bytes)` for this installation. Constant-time compare.
pub fn verify(bytes: &[u8], sig: &str) -> bool {
    let Some(secret) = SECRET.get() else {
        return false;
    };
    let Ok(tag) = URL_SAFE_NO_PAD.decode(sig) else {
        return false;
    };
    hmac::verify(&hmac::Key::new(hmac::HMAC_SHA256, secret), bytes, &tag).is_ok()
}

fn tag(secret: &[u8; 32], bytes: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret), bytes)
        .as_ref()
        .to_vec()
}

/// The stored secret, or a fresh one written with mode 600 (so only its owner reads it).
fn load_or_create(path: &Path) -> std::io::Result<[u8; 32]> {
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(secret) = <[u8; 32]>::try_from(bytes) {
            return Ok(secret);
        }
        tracing::warn!(
            "install secret at {} is not 32 bytes; writing a fresh one",
            path.display()
        );
    }
    let secret = random();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_private(path, &secret)?;
    Ok(secret)
}

fn random() -> [u8; 32] {
    let mut secret = [0u8; 32];
    SystemRandom::new()
        .fill(&mut secret)
        .expect("system randomness is available");
    secret
}

fn write_private(path: &Path, secret: &[u8; 32]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(secret)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, secret)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [7u8; 32];

    #[test]
    fn a_signature_matches_its_bytes_and_nothing_else() {
        init_with(SECRET);
        let sig = sign(b"message\na\n7\n<7@x>");
        assert!(!sig.is_empty());
        assert!(verify(b"message\na\n7\n<7@x>", &sig));
        // Another route, another tag.
        assert!(!verify(b"message\na\n8\n<7@x>", &sig));
        assert!(!verify(b"inbox\na\n7", &sig));
    }

    #[test]
    fn a_broken_or_missing_signature_is_refused() {
        init_with(SECRET);
        assert!(!verify(b"x", ""));
        assert!(!verify(b"x", "not base64!!"));
        assert!(!verify(b"x", &"A".repeat(43)));
    }

    /// The draft mark is trusted only with this installation's signature. An old draft that
    /// carries the mark and Depesha's own Message-ID domain, but no signature, names nothing.
    #[test]
    fn an_acts_on_mark_is_trusted_only_when_this_install_signed_it() {
        use depesha_core::domain::{Act, ActsOn};
        use depesha_core::message::{self, ACTS_ON_HEADER, DRAFT_DOMAIN};

        init_with(SECRET);
        let acts = ActsOn {
            account_id: "a".into(),
            message_id: "m1@example.org".into(),
            folder: "Входящие".into(),
            act: Act::Reply,
            waiting: true,
        };
        let value = message::encode_acts_on(&acts).unwrap();
        let signed = message::signed_acts_on(&value, &sign(value.as_bytes())).unwrap();
        let raw = |header: &str, domain: &str| {
            format!(
                "{header}Message-ID: <1.abcd@{domain}>\r\nFrom: me@example.com\r\n\
                 To: you@example.com\r\nSubject: Hi\r\n\r\nText\r\n"
            )
        };
        let signed_raw = raw(&format!("{ACTS_ON_HEADER}: {signed}\r\n"), "example.com");
        assert_eq!(
            message::trusted_acts_on(signed_raw.as_bytes(), verify),
            Some(acts.clone())
        );
        // The same bytes with another tag are not this installation's.
        let other = raw(&format!("{ACTS_ON_HEADER}: {value}.not-ours\r\n"), DRAFT_DOMAIN);
        assert_eq!(message::trusted_acts_on(other.as_bytes(), verify), None);
        // An old draft: the mark, our domain, no signature.
        let old = raw(&format!("{ACTS_ON_HEADER}: {value}\r\n"), DRAFT_DOMAIN);
        assert_eq!(message::trusted_acts_on(old.as_bytes(), verify), None);
    }

    /// The cipher key is derived with HKDF under its own `info`, not the tag `sign` would give
    /// for a label: signatures of 0.8.0 stay as they were, and no signature is the key.
    #[test]
    fn the_cipher_key_is_not_a_signing_tag() {
        init_with(SECRET);
        let label_tag = URL_SAFE_NO_PAD.decode(sign(b"depesha draft mark key 1")).unwrap();
        assert_ne!(draft_key_bytes(&SECRET), label_tag);
        assert_eq!(draft_key_bytes(&SECRET).len(), 32);
        assert_ne!(draft_key_bytes(&SECRET), draft_key_bytes(&[8u8; 32]));
    }

    /// A sealed value is for the letter it was sealed in: moved into another letter, or opened
    /// by another installation, it opens to nothing.
    #[test]
    fn a_sealed_value_opens_only_for_its_letter_and_its_secret() {
        let value = seal_with(&SECRET, b"mark", "d1@depesha.local").unwrap();
        assert_eq!(
            open_with(&SECRET, &value, "d1@depesha.local").as_deref(),
            Some(&b"mark"[..])
        );
        assert_eq!(open_with(&SECRET, &value, "d2@depesha.local"), None);
        assert_eq!(open_with(&[8u8; 32], &value, "d1@depesha.local"), None);
    }
}
