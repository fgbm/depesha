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
            tracing::warn!("install secret at {}: {e}; signing with a run-only secret", path.display());
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
        tracing::warn!("install secret at {} is not 32 bytes; writing a fresh one", path.display());
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
}
