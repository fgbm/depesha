//! The app's own check of a letter's DKIM signature (RFC 6376), for a mailbox whose server
//! writes no verdict of its own (Exchange) or does not check DMARC (#167).

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use mail_auth::hickory_resolver::TokioResolver;
use mail_auth::{AuthenticatedMessage, DkimResult, MessageAuthenticator, Parameters, ResolverCache, Txt};

/// The whole check, every DNS answer included: the letter is on screen already, the line
/// about its pictures waits for this.
const LIMIT: Duration = Duration::from_secs(10);
/// DNS answers kept, as names: enough for the senders of a day of reading.
const CACHE_NAMES: usize = 512;
/// Verdicts kept by letter id, so opening the letter again shows the answer at once.
const LETTERS: usize = 1024;
/// A check that got no answer from DNS is made again after this long.
const RETRY: Duration = Duration::from_secs(30);

/// What the app's own check of the signature found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signature {
    /// A valid signature of the From domain's organization: the sender is confirmed.
    Aligned,
    /// The letter carries no DKIM signature.
    Unsigned,
    /// Valid signatures only of other organizations.
    NotAligned,
    /// The signature does not match the letter, its key is gone, or the letter has no single
    /// From of the given domain.
    Invalid,
    /// No answer from DNS: nothing is known, which is no confirmation.
    Unchecked,
}

impl Signature {
    pub fn passed(self) -> bool {
        self == Self::Aligned
    }
}

/// The letter carries a `DKIM-Signature` header: a check can say something.
pub fn signed(raw: &[u8]) -> bool {
    AuthenticatedMessage::parse(raw).is_some_and(|m| !m.dkim_headers.is_empty() || m.has_dkim_errors)
}

/// TXT answers by name until their TTL runs out. Errors of the network are never put here
/// by `mail-auth`, so a check without the network is asked again next time.
#[derive(Default)]
pub struct TxtCache(Mutex<HashMap<Box<str>, (Txt, Instant)>>);

impl ResolverCache<Box<str>, Txt> for TxtCache {
    fn get<Q>(&self, name: &Q) -> Option<Txt>
    where
        Box<str>: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        let map = self.0.lock().ok()?;
        map.get(name)
            .filter(|(_, until)| *until > Instant::now())
            .map(|(txt, _)| txt.clone())
    }

    fn remove<Q>(&self, name: &Q) -> Option<Txt>
    where
        Box<str>: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.0.lock().ok()?.remove(name).map(|(txt, _)| txt)
    }

    fn insert(&self, key: Box<str>, value: Txt, valid_until: Instant) {
        if let Ok(mut map) = self.0.lock() {
            if map.len() >= CACHE_NAMES {
                let now = Instant::now();
                map.retain(|_, (_, until)| *until > now);
                if map.len() >= CACHE_NAMES {
                    map.clear();
                }
            }
            map.insert(key, (value, valid_until));
        }
    }
}

type Remembered = ([u8; 32], String, Signature, Instant);

fn digest(raw: &[u8]) -> [u8; 32] {
    let mut out = [0; 32];
    out.copy_from_slice(ring::digest::digest(&ring::digest::SHA256, raw).as_ref());
    out
}

/// Checks signatures with the system's DNS; one per app, so the answers are shared.
#[derive(Default)]
pub struct Verifier {
    auth: OnceLock<Option<MessageAuthenticator>>,
    cache: Arc<TxtCache>,
    /// `(digest of the letter, From domain, verdict, when)` by letter id. The digest: a
    /// deleted letter's id may be given to a new one.
    letters: Mutex<HashMap<i64, Remembered>>,
}

impl Verifier {
    #[cfg(test)]
    fn with(auth: MessageAuthenticator, cache: TxtCache) -> Self {
        Self {
            auth: OnceLock::from(Some(auth)),
            cache: Arc::new(cache),
            letters: Mutex::default(),
        }
    }

    /// The verdict [`Verifier::check_letter`] gave for this letter, these bytes and From
    /// domain, unless it was [`Signature::Unchecked`] long enough ago to ask DNS again.
    pub fn known(&self, id: i64, raw: &[u8], from_domain: &str) -> Option<Signature> {
        let letters = self.letters.lock().ok()?;
        let (hash, domain, verdict, at) = letters.get(&id)?;
        let fresh = *verdict != Signature::Unchecked || at.elapsed() < RETRY;
        (*hash == digest(raw) && domain == from_domain && fresh).then_some(*verdict)
    }

    /// [`Verifier::check`], remembered for [`Verifier::known`].
    pub async fn check_letter(&self, id: i64, raw: &[u8], from_domain: &str) -> Signature {
        let verdict = self.check(raw, from_domain).await;
        if let Ok(mut letters) = self.letters.lock() {
            if letters.len() >= LETTERS {
                letters.clear();
            }
            letters.insert(id, (digest(raw), from_domain.to_owned(), verdict, Instant::now()));
        }
        verdict
    }

    fn authenticator(&self) -> Option<&MessageAuthenticator> {
        self.auth
            .get_or_init(|| {
                TokioResolver::builder_tokio()
                    .ok()?
                    .build()
                    .ok()
                    .map(MessageAuthenticator)
            })
            .as_ref()
    }

    /// Whether `raw` carries a valid DKIM signature of the organization of `from_domain`, the
    /// domain of its only From address. Relaxed alignment (RFC 7489 §3.1.1): `d=` and the From
    /// domain have the same registrable domain by the public suffix list. The signature must
    /// cover From; `mail-auth` refuses one with a body length (`l=`), as text added below it
    /// would pass unsigned.
    pub async fn check(&self, raw: &[u8], from_domain: &str) -> Signature {
        let Some(message) = AuthenticatedMessage::parse(raw) else {
            return Signature::Invalid;
        };
        if message.dkim_headers.is_empty() && !message.has_dkim_errors {
            return Signature::Unsigned;
        }
        // A second From is how a signed letter shows another sender (RFC 7489 §6.6.1): the
        // signature covers one of them, the reader may show the other.
        let froms = message
            .headers
            .iter()
            .filter(|(name, _)| name.trim_ascii().eq_ignore_ascii_case(b"from"))
            .count();
        let from_ok = froms == 1
            && message.from.len() == 1
            && message.from[0]
                .rsplit_once('@')
                .is_some_and(|(_, d)| crate::avatar::same_domain(d, from_domain));
        if !from_ok {
            return Signature::Invalid;
        }
        let Some(auth) = self.authenticator() else {
            return Signature::Unchecked;
        };
        let params = Parameters::new(&message).with_txt_cache(self.cache.as_ref());
        let Ok(outputs) = tokio::time::timeout(LIMIT, auth.verify_dkim(params)).await else {
            return Signature::Unchecked;
        };
        let mut verdict = Signature::Invalid;
        for output in &outputs {
            let Some(signature) = output.signature() else { continue };
            let ours = crate::avatar::aligned(&signature.d, from_domain);
            let covers_from = signature.h.iter().any(|h| h.trim().eq_ignore_ascii_case("from"));
            match output.result() {
                DkimResult::Pass if ours && covers_from => return Signature::Aligned,
                DkimResult::TempError(_) if ours => verdict = Signature::Unchecked,
                DkimResult::Pass if !ours && verdict == Signature::Invalid => verdict = Signature::NotAligned,
                _ => {}
            }
        }
        verdict
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use mail_auth::common::crypto::Ed25519Key;
    use mail_auth::common::headers::HeaderWriter;
    use mail_auth::common::parse::TxtRecordParser;
    use mail_auth::common::verify::DomainKey;
    use mail_auth::dkim::DkimSigner;
    use mail_auth::hickory_resolver::config::ResolverConfig;
    use mail_auth::hickory_resolver::net::runtime::TokioRuntimeProvider;

    const LETTER: &str = "From: Bitrix24 <no-reply@1c-bitrix.ru>\r\nTo: me@firm.example\r\nSubject: Hi\r\n\r\n<img src=\"https://1c-bitrix.ru/logo.png\">\r\n";

    /// A new key and its DNS record.
    fn keypair() -> (Ed25519Key, String) {
        let key = Ed25519Key::from_pkcs8_der(&Ed25519Key::generate_pkcs8().unwrap()).unwrap();
        let p = base64::engine::general_purpose::STANDARD.encode(key.public_key());
        (key, format!("v=DKIM1; k=ed25519; p={p}"))
    }

    fn sign(key: Ed25519Key, domain: &str, letter: &str) -> String {
        let signature = DkimSigner::from_key(key)
            .domain(domain)
            .selector("s1")
            .headers(["From", "To", "Subject"])
            .sign(letter.as_bytes())
            .unwrap();
        format!("{}{letter}", signature.to_header())
    }

    /// DNS that knows only the key of `s1._domainkey.<domain>` and never reaches the network.
    fn verifier(domain: &str, record: &str) -> Verifier {
        let cache = TxtCache::default();
        cache.insert(
            format!("s1._domainkey.{domain}.").into_boxed_str(),
            Txt::from(DomainKey::parse(record.as_bytes()).unwrap()),
            Instant::now() + Duration::from_secs(3600),
        );
        Verifier::with(offline(), cache)
    }

    /// A resolver with no name servers: every lookup fails, as without a network.
    fn offline() -> MessageAuthenticator {
        let config = ResolverConfig::from_parts(None, vec![], vec![]);
        MessageAuthenticator(
            TokioResolver::builder_with_config(config, TokioRuntimeProvider::default())
                .build()
                .unwrap(),
        )
    }

    #[tokio::test]
    async fn a_valid_signature_of_the_from_domain_confirms_the_sender() {
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        assert!(super::signed(signed.as_bytes()));
        assert_eq!(v.check(signed.as_bytes(), "1c-bitrix.ru").await, Signature::Aligned);
    }

    #[tokio::test]
    async fn a_signature_of_the_organization_aligns_a_subdomain() {
        // #167: `d=openai.com` for From `email.openai.com`.
        let letter = LETTER.replace("no-reply@1c-bitrix.ru", "noreply@email.openai.com");
        let (key, record) = keypair();
        let signed = sign(key, "openai.com", &letter);
        let v = verifier("openai.com", &record);
        assert_eq!(v.check(signed.as_bytes(), "email.openai.com").await, Signature::Aligned);
    }

    #[tokio::test]
    async fn a_changed_letter_or_a_foreign_key_is_no_confirmation() {
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        let changed = signed.replace("logo.png", "track.png");
        assert_eq!(v.check(changed.as_bytes(), "1c-bitrix.ru").await, Signature::Invalid);
        let resent = signed.replace("Subject: Hi", "Subject: Pay now");
        assert_eq!(v.check(resent.as_bytes(), "1c-bitrix.ru").await, Signature::Invalid);
        // Signed with another key than the one DNS publishes.
        let forged = sign(keypair().0, "1c-bitrix.ru", LETTER);
        assert_eq!(v.check(forged.as_bytes(), "1c-bitrix.ru").await, Signature::Invalid);
    }

    #[tokio::test]
    async fn a_signature_of_another_organization_is_no_confirmation() {
        let (key, record) = keypair();
        let signed = sign(key, "evil.example", LETTER);
        let v = verifier("evil.example", &record);
        assert_eq!(v.check(signed.as_bytes(), "1c-bitrix.ru").await, Signature::NotAligned);
        // A look-alike and a name under a private suffix are other organizations too.
        let letter = LETTER.replace("1c-bitrix.ru", "bank.github.io");
        let (key, record) = keypair();
        let signed = sign(key, "evil.github.io", &letter);
        let v = verifier("evil.github.io", &record);
        assert_eq!(
            v.check(signed.as_bytes(), "bank.github.io").await,
            Signature::NotAligned
        );
    }

    #[tokio::test]
    async fn a_second_from_breaks_the_confirmation() {
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        let two = format!("From: Bank <security@bank.ru>\r\n{signed}");
        assert_eq!(v.check(two.as_bytes(), "bank.ru").await, Signature::Invalid);
        assert_eq!(v.check(two.as_bytes(), "1c-bitrix.ru").await, Signature::Invalid);
        // The From the reader shows must be the signed one.
        assert_eq!(v.check(signed.as_bytes(), "bank.ru").await, Signature::Invalid);
    }

    #[tokio::test]
    async fn without_the_network_the_signature_is_unchecked_not_confirmed() {
        let signed = sign(keypair().0, "1c-bitrix.ru", LETTER);
        let v = Verifier::with(offline(), TxtCache::default());
        let verdict = v.check(signed.as_bytes(), "1c-bitrix.ru").await;
        assert_eq!(verdict, Signature::Unchecked);
        assert!(!verdict.passed());
    }

    #[tokio::test]
    async fn a_letter_without_a_signature_is_unsigned() {
        let v = Verifier::with(offline(), TxtCache::default());
        assert!(!signed(LETTER.as_bytes()));
        assert_eq!(v.check(LETTER.as_bytes(), "1c-bitrix.ru").await, Signature::Unsigned);
    }

    #[tokio::test]
    async fn the_verdict_of_a_letter_is_kept_for_its_from_domain() {
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        let raw = signed.as_bytes();
        assert_eq!(v.known(7, raw, "1c-bitrix.ru"), None);
        assert_eq!(v.check_letter(7, raw, "1c-bitrix.ru").await, Signature::Aligned);
        assert_eq!(v.known(7, raw, "1c-bitrix.ru"), Some(Signature::Aligned));
        assert_eq!(v.known(7, raw, "bank.ru"), None);
        assert_eq!(v.known(8, raw, "1c-bitrix.ru"), None);
        // The id of a deleted letter given to another one: its verdict does not go with it.
        assert_eq!(v.known(7, LETTER.as_bytes(), "1c-bitrix.ru"), None);
    }

    #[test]
    fn the_cache_forgets_expired_answers() {
        let cache = TxtCache::default();
        let txt = || Txt::from(DomainKey::parse(b"v=DKIM1; k=ed25519; p=AAAA").unwrap());
        cache.insert("a.".into(), txt(), Instant::now() + Duration::from_secs(60));
        cache.insert("b.".into(), txt(), Instant::now());
        assert!(cache.get("a.").is_some());
        assert!(cache.get("b.").is_none());
    }
}
