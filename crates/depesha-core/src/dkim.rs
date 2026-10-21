//! The app's own check of a letter's DKIM signature (RFC 6376), for a mailbox whose server
//! writes no verdict of its own (Exchange) or does not check DMARC (#167).
//!
//! Asking DNS for a key tells the owner of the key's domain that the letter is being read. So
//! only a signature of the From address's own organization is ever looked up, and only once
//! the letter has one From both readers of its headers agree on; everything else is answered
//! without the network.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mail_auth::common::crypto::{Algorithm, HashAlgorithm};
use mail_auth::common::verify::DomainKey;
use mail_auth::dmarc::{Alignment, Dmarc};
use mail_auth::hickory_resolver::TokioResolver;
use mail_auth::{AuthenticatedMessage, DnsError, MessageAuthenticator, ResolverCache, Txt};

use crate::avatar::{aligned, same_domain};

/// The whole check, every DNS answer included: the letter is on screen already, the line
/// about its pictures waits for this.
const LIMIT: Duration = Duration::from_secs(10);
/// DNS answers kept, as names: enough for the senders of a day of reading.
const CACHE_NAMES: usize = 512;
/// Verdicts kept by letter id, so opening the letter again shows the answer at once.
const LETTERS: usize = 1024;
/// A check that got no answer from DNS is made again after this long.
const RETRY: Duration = Duration::from_secs(30);
/// `DKIM-Signature` headers a letter may carry at all: real mail has one to three. Thousands
/// of them would keep the check busy for nothing.
pub(crate) const MAX_HEADERS: usize = 32;
/// Signatures of the sender's organization looked up and verified.
const MAX_SIGNATURES: usize = 5;
/// Headers one signature may cover (`h=`): a real one names a dozen or two.
const MAX_SIGNED: usize = 64;
/// The `t=y` flag of a key record (RFC 6376 §3.6.1), as `mail-auth` keeps it in
/// `DomainKey::f`: the domain is testing DKIM, and a signature with it counts as none.
const KEY_TESTING: u64 = 0x10;

/// What the app's own check of the signature found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signature {
    /// A valid signature of the From address's organization: the sender is confirmed.
    Aligned,
    /// The letter carries no DKIM signature.
    Unsigned,
    /// Signatures only of other organizations, or one the sender's DMARC policy (`adkim=s`)
    /// does not accept.
    NotAligned,
    /// The signature does not match the letter, its key is gone or in testing (`t=y`), it
    /// uses SHA-1, or the letter has no single From that is the given address.
    Invalid,
    /// No answer from DNS: nothing is known, which is no confirmation.
    Unchecked,
}

impl Signature {
    pub fn passed(self) -> bool {
        self == Self::Aligned
    }
}

/// What the app's own check of a signature against a block of headers found (0.8.13, ступень 4).
///
/// The signature covers the headers of the letter, not its body: the body of a letter that came
/// through Exchange in the firm's own network was assembled again on the way, and the original
/// one is not there. The headers are the original ones, so the signature over them still proves
/// who wrote the letter — but not what it says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Headers {
    /// The signature of the sender's organization covers the headers: the sender is confirmed.
    Valid,
    /// The block of headers carries no DKIM signature.
    Unsigned,
    /// The signature does not match the headers, the key is gone or in testing, or the letter
    /// has no single From that is the given address.
    Rejected,
    /// DNS did not answer for the key: nothing is known, which is no confirmation.
    Unchecked,
}

impl Headers {
    pub fn passed(self) -> bool {
        self == Self::Valid
    }
}

/// The verdict on `raw` for the sender `address` that needs no DNS, or `None` when only a
/// lookup of the sender's own key can tell.
pub fn offline_verdict(raw: &[u8], address: &str) -> Option<Signature> {
    candidates(raw, address).err()
}

/// The letter as `mail-auth` reads it, with only the signatures worth a lookup: of the From
/// address's organization, covering From, at most [`MAX_SIGNATURES`]. Their report (`r=`) and
/// third-party (`atps=`) requests are dropped: each is one more name asked of DNS. `Err` is the
/// verdict when no signature is worth it.
fn candidates<'x>(raw: &'x [u8], address: &str) -> Result<AuthenticatedMessage<'x>, Signature> {
    if signature_headers(raw) > MAX_HEADERS {
        return Err(Signature::Invalid);
    }
    let Some(mut message) = AuthenticatedMessage::parse(raw) else {
        return Err(Signature::Invalid);
    };
    if message.dkim_headers.is_empty() && !message.has_dkim_errors {
        return Err(Signature::Unsigned);
    }
    // One From, the trusted address, read alike by the reader and by the check: a second From
    // is how a signed letter shows another sender (RFC 7489 §6.6.1).
    let address = address.trim().to_lowercase();
    if crate::message::sole_from_in(raw, &message).as_deref() != Some(address.as_str()) {
        return Err(Signature::Invalid);
    }
    let from_domain = address.rsplit_once('@').map_or("", |(_, d)| d);
    let ours = |s: &mail_auth::dkim::Signature| aligned(&s.d, from_domain);
    if !message.dkim_headers.iter().any(|h| ours(&h.header)) {
        // Malformed signatures and ones with a body length (`l=`, text below it would pass
        // unsigned) are refused by `mail-auth` before this.
        return Err(if message.dkim_headers.is_empty() {
            Signature::Invalid
        } else {
            Signature::NotAligned
        });
    }
    // SHA-1 signs nothing any longer (RFC 8301 §3.1): a collision makes a second letter.
    message.dkim_headers.retain(|h| {
        let s = &h.header;
        ours(s)
            && s.a != Algorithm::RsaSha1
            && s.h.len() <= MAX_SIGNED
            && s.h.iter().any(|name| name.trim().eq_ignore_ascii_case("from"))
    });
    if message.dkim_headers.is_empty() {
        return Err(Signature::Invalid);
    }
    message.dkim_headers.truncate(MAX_SIGNATURES);
    for header in &mut message.dkim_headers {
        header.header.r = false;
        header.header.atps = None;
    }
    message.errors.clear();
    Ok(message)
}

/// `DKIM-Signature` headers of `raw`, counted before any parsing, in the header block as
/// [`header_end`] finds it.
pub(crate) fn signature_headers(raw: &[u8]) -> usize {
    header_fields(raw)
        .0
        .iter()
        .filter(|name| name.eq_ignore_ascii_case(b"dkim-signature"))
        .count()
}

/// Where the headers of `raw` end, the empty line included, as `mail-auth` reads them: a
/// line that starts with a space or a tab goes on with the header above it, a whitespace-only
/// one too, and a line without a colon ends the headers when it ends in CRLF or is empty.
pub(crate) fn header_end(raw: &[u8]) -> usize {
    header_fields(raw).1
}

/// The names of the header fields of `raw` and where the headers end: the scan of
/// `mail-auth` 0.13 (`common::headers::scan_field`), which is private to it.
fn header_fields(raw: &[u8]) -> (Vec<&[u8]>, usize) {
    let mut names = Vec::new();
    let mut start = 0;
    'fields: loop {
        let mut cur = start;
        loop {
            let Some(offset) = raw[cur..].iter().position(|&b| b == b':' || b == b'\n') else {
                return (names, raw.len());
            };
            let pos = cur + offset;
            if raw[pos] == b':' {
                // A value the letter ends in is no header to `mail-auth`.
                let Some(end) = value_end(raw, pos) else {
                    return (names, raw.len());
                };
                names.push(&raw[start..pos]);
                start = end;
                continue 'fields;
            }
            if (pos > cur && raw[pos - 1] == b'\r') || pos == start {
                return (names, pos + 1);
            }
            match raw.get(pos + 1) {
                Some(b' ' | b'\t') => cur = pos + 1,
                _ => {
                    // A line without a colon: a field of no name.
                    start = pos + 1;
                    continue 'fields;
                }
            }
        }
    }
}

/// The end of the header value after the colon at `colon`: past the line end that no space or
/// tab follows. `None` when the letter ends first.
fn value_end(raw: &[u8], colon: usize) -> Option<usize> {
    let mut cur = colon + 1;
    loop {
        let pos = cur + raw[cur..].iter().position(|&b| b == b'\n')?;
        match raw.get(pos + 1) {
            Some(b' ' | b'\t') => cur = pos + 1,
            _ => return Some(pos + 1),
        }
    }
}

/// TXT answers by name until their TTL runs out. Errors of the network are never put here
/// by `mail-auth`, so a check without the network is asked again next time.
#[derive(Default)]
pub struct TxtCache {
    answers: Mutex<HashMap<Box<str>, (Txt, Instant)>>,
    /// A hash of every name `mail-auth` asked about: a test sees what would reach DNS. The
    /// name itself is out of reach, its type is generic.
    #[cfg(test)]
    asked: Mutex<Vec<u64>>,
    #[cfg(test)]
    hasher: std::hash::RandomState,
}

impl ResolverCache<Box<str>, Txt> for TxtCache {
    fn get<Q>(&self, name: &Q) -> Option<Txt>
    where
        Box<str>: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        #[cfg(test)]
        if let Ok(mut asked) = self.asked.lock() {
            asked.push(std::hash::BuildHasher::hash_one(&self.hasher, name));
        }
        let map = self.answers.lock().ok()?;
        map.get(name)
            .filter(|(_, until)| *until > Instant::now())
            .map(|(txt, _)| txt.clone())
    }

    fn remove<Q>(&self, name: &Q) -> Option<Txt>
    where
        Box<str>: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.answers.lock().ok()?.remove(name).map(|(txt, _)| txt)
    }

    fn insert(&self, key: Box<str>, value: Txt, valid_until: Instant) {
        if let Ok(mut map) = self.answers.lock() {
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

/// The system's resolver, with the name servers the system has now.
fn system() -> Option<MessageAuthenticator> {
    TokioResolver::builder_tokio()
        .ok()?
        .build()
        .ok()
        .map(MessageAuthenticator)
}

/// Checks signatures with the system's DNS; one per app, so the answers are shared.
pub struct Verifier {
    /// Built when first needed, and again after a check without an answer: another network or
    /// a VPN brings other name servers, and a resolver that failed to start may start now.
    auth: Mutex<Option<MessageAuthenticator>>,
    build: fn() -> Option<MessageAuthenticator>,
    cache: Arc<TxtCache>,
    /// `(digest of the letter, From address, verdict, when)` by letter id. The digest: a
    /// deleted letter's id may be given to a new one.
    letters: Mutex<HashMap<i64, Remembered>>,
    /// [`LIMIT`]; shorter in a test of the path that runs out of time.
    limit: Duration,
}

impl Default for Verifier {
    fn default() -> Self {
        Self {
            auth: Mutex::default(),
            build: system,
            cache: Arc::default(),
            letters: Mutex::default(),
            limit: LIMIT,
        }
    }
}

impl Verifier {
    #[cfg(test)]
    pub(crate) fn with(build: fn() -> Option<MessageAuthenticator>, cache: TxtCache) -> Self {
        Self {
            build,
            cache: Arc::new(cache),
            ..Self::default()
        }
    }

    /// The verdict [`Verifier::check_letter`] gave for this letter, these bytes and From
    /// address, unless it was [`Signature::Unchecked`] long enough ago to ask DNS again.
    pub fn known(&self, id: i64, raw: &[u8], address: &str) -> Option<Signature> {
        let letters = self.letters.lock().ok()?;
        let (hash, from, verdict, at) = letters.get(&id)?;
        let fresh = *verdict != Signature::Unchecked || at.elapsed() < RETRY;
        (*hash == digest(raw) && from.eq_ignore_ascii_case(address.trim()) && fresh).then_some(*verdict)
    }

    /// [`Verifier::check`], remembered for [`Verifier::known`].
    pub async fn check_letter(&self, id: i64, raw: &[u8], address: &str) -> Signature {
        let verdict = self.check(raw, address).await;
        if let Ok(mut letters) = self.letters.lock() {
            if letters.len() >= LETTERS {
                letters.clear();
            }
            letters.insert(id, (digest(raw), address.trim().to_owned(), verdict, Instant::now()));
        }
        verdict
    }

    fn authenticator(&self) -> Option<MessageAuthenticator> {
        let mut auth = self.auth.lock().ok()?;
        if auth.is_none() {
            *auth = (self.build)();
        }
        auth.clone()
    }

    /// Whether `raw` carries a valid DKIM signature of the organization of `address`, its only
    /// From. Relaxed alignment (RFC 7489 §3.1.1): `d=` and the From domain have the same
    /// registrable domain by the public suffix list, unless the sender's DMARC record asks for
    /// the exact name (`adkim=s`). The signature must cover From. The work runs off the async
    /// threads, and no longer than [`LIMIT`].
    pub async fn check(&self, raw: &[u8], address: &str) -> Signature {
        if let Some(verdict) = offline_verdict(raw, address) {
            return verdict;
        }
        let Some(auth) = self.authenticator() else {
            return Signature::Unchecked;
        };
        let (raw, address, cache) = (raw.to_vec(), address.to_owned(), Arc::clone(&self.cache));
        let (handle, limit) = (tokio::runtime::Handle::current(), self.limit);
        let task = tokio::task::spawn_blocking(move || {
            handle.block_on(async {
                tokio::time::timeout(limit, verify(&auth, &cache, &raw, &address))
                    .await
                    .unwrap_or(Signature::Unchecked)
            })
        });
        let verdict = match tokio::time::timeout(self.limit, task).await {
            Ok(Ok(verdict)) => verdict,
            _ => Signature::Unchecked,
        };
        if verdict == Signature::Unchecked
            && let Ok(mut auth) = self.auth.lock()
        {
            *auth = None;
        }
        verdict
    }

    /// Whether a block of original headers carries a valid DKIM signature of the organization of
    /// `address`, its only From (0.8.13, ступень 4). The body of the letter is not at hand and is
    /// not checked: the signature proves the headers, not what the letter says.
    pub async fn check_headers(&self, headers: &[u8], address: &str) -> Headers {
        if let Err(verdict) = candidates(headers, address) {
            return match verdict {
                Signature::Unsigned => Headers::Unsigned,
                _ => Headers::Rejected,
            };
        }
        let Some(auth) = self.authenticator() else {
            return Headers::Unchecked;
        };
        let (headers, address, cache) = (headers.to_vec(), address.to_owned(), Arc::clone(&self.cache));
        let (handle, limit) = (tokio::runtime::Handle::current(), self.limit);
        let task = tokio::task::spawn_blocking(move || {
            handle.block_on(async {
                tokio::time::timeout(limit, verify_headers(&auth, &cache, &headers, &address))
                    .await
                    .unwrap_or(Headers::Unchecked)
            })
        });
        let verdict = match tokio::time::timeout(self.limit, task).await {
            Ok(Ok(verdict)) => verdict,
            _ => Headers::Unchecked,
        };
        if verdict == Headers::Unchecked
            && let Ok(mut auth) = self.auth.lock()
        {
            *auth = None;
        }
        verdict
    }
}

/// [`Verifier::check_headers`] itself, on a thread of its own.
async fn verify_headers(
    auth: &MessageAuthenticator,
    cache: &TxtCache,
    headers: &[u8],
    address: &str,
) -> Headers {
    let message = match candidates(headers, address) {
        Ok(message) => message,
        Err(verdict) => {
            return match verdict {
                Signature::Unsigned => Headers::Unsigned,
                _ => Headers::Rejected,
            };
        }
    };
    let from_domain = address.trim().rsplit_once('@').map_or("", |(_, d)| d);
    let mut verdict = Headers::Rejected;
    for header in &message.dkim_headers {
        let signature = &header.header;
        match check_signature(auth, cache, &message, header, None).await {
            Check::Pass => match testing(auth, cache, signature).await {
                Some(true) => {}
                None => verdict = Headers::Unchecked,
                Some(false) if same_domain(&signature.d, from_domain) => return Headers::Valid,
                Some(false) => {}
            },
            Check::Temp => verdict = Headers::Unchecked,
            Check::Fail => {}
        }
    }
    verdict
}

/// [`Verifier::check`] itself, on a thread of its own.
async fn verify(auth: &MessageAuthenticator, cache: &TxtCache, raw: &[u8], address: &str) -> Signature {
    let message = match candidates(raw, address) {
        Ok(message) => message,
        Err(verdict) => return verdict,
    };
    let from_domain = address.trim().rsplit_once('@').map_or("", |(_, d)| d);
    let body = message.raw_message.get(message.body_offset as usize..);
    let (mut verdict, mut relaxed) = (Signature::Invalid, false);
    for header in &message.dkim_headers {
        let signature = &header.header;
        match check_signature(auth, cache, &message, header, body).await {
            Check::Pass => match testing(auth, cache, signature).await {
                Some(true) => {}
                None => verdict = Signature::Unchecked,
                Some(false) if same_domain(&signature.d, from_domain) => return Signature::Aligned,
                Some(false) => relaxed = true,
            },
            Check::Temp => verdict = Signature::Unchecked,
            Check::Fail => {}
        }
    }
    if !relaxed {
        return verdict;
    }
    match strict(auth, cache, from_domain).await {
        Some(false) => Signature::Aligned,
        Some(true) => Signature::NotAligned,
        None => Signature::Unchecked,
    }
}

/// What the check of one signature said.
enum Check {
    /// The signature is good.
    Pass,
    /// The signature is not good.
    Fail,
    /// DNS did not answer for the key: nothing is known.
    Temp,
}

/// Checks one signature of the letter (RFC 6376 §3.7).
///
/// The signed data is the canonicalized headers named in `h=`, then the `DKIM-Signature` header
/// itself with the value of its `b=` tag deleted, and then the body hash — the raw hash bytes,
/// not their base64. `body` is the body of the letter, when it is at hand: it is hashed and the
/// hash compared with the `bh=` tag. Without a body (the original headers of a letter that came
/// through Exchange in the firm's own network) the `bh=` tag of the signature is taken for what
/// the signer wrote: the signature then proves the headers and says nothing about the body.
///
/// The canonicalization and the verification itself are `mail-auth`'s; only the choice of the
/// headers and the removal of the `b=` value are done here.
async fn check_signature(
    auth: &MessageAuthenticator,
    cache: &TxtCache,
    message: &AuthenticatedMessage<'_>,
    header: &mail_auth::common::headers::Header<'_, mail_auth::dkim::Signature>,
    body: Option<&[u8]>,
) -> Check {
    let signature = &header.header;
    // An expired signature is no signature (RFC 6376 §3.5, the `x=` tag).
    let now = chrono::Utc::now().timestamp() as u64;
    if signature.x != 0 && signature.x < now {
        return Check::Fail;
    }
    let key = match key_of(auth, cache, signature).await {
        Some(key) => key,
        None => return Check::Temp,
    };
    // The key of a domain in testing mode is no key (RFC 6376 §3.6.1).
    if key.has_flag(KEY_TESTING) {
        return Check::Fail;
    }
    // The body: hashed and compared with the `bh=` tag, when the body is at hand.
    if let Some(body) = body {
        let hash = HashAlgorithm::from(signature.a).hash(signature.cb.canonical_body(body, signature.l));
        if hash.as_ref() != signature.bh.as_slice() {
            return Check::Fail;
        }
    }
    // The signed data: the headers named in `h=`, the `DKIM-Signature` header with its `b=`
    // value deleted, and the body hash.
    let mut data = Vec::with_capacity(1024);
    let stripped = strip_signature(header.value);
    let headers = message.signed_headers(&signature.h, header.name, &stripped);
    signature.ch.canonicalize_headers(headers, &mut data);
    data.extend_from_slice(&signature.bh);
    match key.p.verify_bytes(&data, &signature.b, signature.a) {
        Ok(()) => Check::Pass,
        Err(_) => Check::Fail,
    }
}

/// The public key of a signature, from DNS.
async fn key_of(
    auth: &MessageAuthenticator,
    cache: &TxtCache,
    signature: &mail_auth::dkim::Signature,
) -> Option<std::sync::Arc<DomainKey>> {
    let name = format!("{}._domainkey.{}.", signature.s, signature.d);
    auth.txt_lookup::<DomainKey>(name, Some(cache)).await.ok()
}

/// The value of a `DKIM-Signature` header with the value of its `b=` tag deleted (RFC 6376
/// §3.7): the tag itself stays, its value is gone. `mail-auth` keeps this to itself, so the
/// same rule is done here — over the text of the header, not over any cryptography.
fn strip_signature(value: &[u8]) -> Vec<u8> {
    // The value of the `b=` tag ends at the next `;` or at the end of the header.
    let mut out = Vec::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.iter().position(|c| *c == b';') {
        let (segment, tail) = rest.split_at(at + 1);
        out.extend_from_slice(strip_b(segment));
        rest = tail;
    }
    out.extend_from_slice(strip_b(rest));
    out
}

#[cfg(test)]
pub(crate) fn strip_signature_probe(value: &[u8]) -> Vec<u8> {
    strip_signature(value)
}

/// One tag of a `DKIM-Signature` header: the `b=` tag without its value, every other tag as it
/// is.
fn strip_b(segment: &[u8]) -> &[u8] {
    let tag = segment
        .iter()
        .position(|c| !c.is_ascii_whitespace())
        .unwrap_or(segment.len());
    if !matches!(segment.get(tag), Some(b'b' | b'B')) {
        return segment;
    }
    let after_tag = &segment[tag + 1..];
    let equals = after_tag
        .iter()
        .position(|c| !c.is_ascii_whitespace())
        .unwrap_or(after_tag.len());
    if after_tag.get(equals) != Some(&b'=') {
        return segment;
    }
    // Keep the tag and its `=`, drop the value and the whitespace around it.
    &segment[..tag + equals + 2]
}

/// Whether the key of a passed signature is in testing (`t=y`): a verifier must not treat such
/// mail apart from unsigned mail (RFC 6376 §3.6.1). `mail-auth` just read the record, so the
/// answer comes from the cache, or from the same name again. `None`: DNS did not answer.
async fn testing(
    auth: &MessageAuthenticator,
    cache: &TxtCache,
    signature: &mail_auth::dkim::Signature,
) -> Option<bool> {
    let name = format!("{}._domainkey.{}.", signature.s, signature.d);
    let key = auth.txt_lookup::<DomainKey>(name, Some(cache)).await.ok()?;
    Some(key.has_flag(KEY_TESTING))
}

/// Whether the sender's DMARC record asks for the exact name in `d=` (`adkim=s`): the record of
/// the From domain, else of its organization (RFC 7489 §6.6.3). Both names belong to the
/// organization whose key was just asked for, so the lookup tells nobody new. `None`: DNS did
/// not answer.
async fn strict(auth: &MessageAuthenticator, cache: &TxtCache, from_domain: &str) -> Option<bool> {
    let from_domain = idna::domain_to_ascii(from_domain.trim_end_matches('.')).ok()?;
    let org = crate::avatar::registrable(&from_domain).filter(|org| *org != from_domain);
    for name in std::iter::once(from_domain.clone()).chain(org) {
        match auth.txt_lookup::<Dmarc>(format!("_dmarc.{name}."), Some(cache)).await {
            Ok(record) => return Some(record.adkim == Alignment::Strict),
            Err(mail_auth::Error::Dns(DnsError::RecordNotFound(_) | DnsError::InvalidRecordType)) => {}
            Err(_) => return None,
        }
    }
    Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use mail_auth::common::crypto::{Ed25519Key, SigningKey};
    use mail_auth::common::headers::HeaderWriter;
    use mail_auth::common::parse::TxtRecordParser;
    use mail_auth::common::verify::DomainKey;
    use mail_auth::dkim::DkimSigner;
    use mail_auth::dmarc::Dmarc;
    use mail_auth::hickory_resolver::config::ResolverConfig;
    use mail_auth::hickory_resolver::net::runtime::TokioRuntimeProvider;
    use mail_auth::hickory_resolver::proto::op::ResponseCode;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const LETTER: &str = "From: Bitrix24 <no-reply@1c-bitrix.ru>\r\nTo: me@firm.example\r\nSubject: Hi\r\n\r\n<img src=\"https://1c-bitrix.ru/logo.png\">\r\n";
    const SENDER: &str = "no-reply@1c-bitrix.ru";

    /// A new key and its DNS record.
    fn keypair() -> (Ed25519Key, String) {
        let key = Ed25519Key::from_pkcs8_der(&Ed25519Key::generate_pkcs8().unwrap()).unwrap();
        let p = base64::engine::general_purpose::STANDARD.encode(key.public_key());
        (key, format!("v=DKIM1; k=ed25519; p={p}"))
    }

    fn signer(key: Ed25519Key, domain: &str) -> DkimSigner<Ed25519Key, mail_auth::dkim::Done> {
        DkimSigner::from_key(key)
            .domain(domain)
            .selector("s1")
            .headers(["From", "To", "Subject"])
    }

    fn sign_with(signer: DkimSigner<Ed25519Key, mail_auth::dkim::Done>, letter: &str) -> String {
        format!("{}{letter}", signer.sign(letter.as_bytes()).unwrap().to_header())
    }

    fn sign(key: Ed25519Key, domain: &str, letter: &str) -> String {
        sign_with(signer(key, domain), letter)
    }

    /// A signature as a real sender writes it (RFC 6376 §3.7): the signed data is the
    /// canonicalized headers, the `DKIM-Signature` header with its `b=` value deleted, and the
    /// body hash. `mail-auth`'s own signer leaves the body hash out, so a letter signed by it
    /// is not a letter any other program would accept.
    fn sign_rfc(key: Ed25519Key, domain: &str, letter: &str) -> String {
        sign_rfc_with(key, domain, "s1", &["from", "to", "subject"], &[], letter)
    }

    /// A signature as a real sender writes it, with the tags the test needs.
    fn sign_rfc_with(
        key: Ed25519Key,
        domain: &str,
        selector: &str,
        signed_headers: &[&str],
        extra: &[(&str, String)],
        letter: &str,
    ) -> String {
        let wanted: Vec<&[u8]> = signed_headers.iter().map(|h| h.as_bytes()).collect();
        let message = AuthenticatedMessage::parse(letter.as_bytes()).unwrap();
        let headers: Vec<(&[u8], &[u8])> = message
            .headers
            .iter()
            .filter(|(name, _)| wanted.iter().any(|want| want.eq_ignore_ascii_case(name)))
            .copied()
            .collect();
        let body = letter.split_once("\r\n\r\n").map(|(_, b)| b.as_bytes()).unwrap_or(b"");
        let body_hash = HashAlgorithm::Sha256
            .hash(mail_auth::dkim::Canonicalization::Relaxed.canonical_body(body, 0))
            .as_ref()
            .to_vec();
        let bh = base64::engine::general_purpose::STANDARD.encode(&body_hash);
        let mut tags = format!("v=1; a=ed25519-sha256; s={selector}; d={domain}; c=relaxed/relaxed");
        tags.push_str(&format!("; h={}", signed_headers.join(":")));
        for (name, value) in extra {
            tags.push_str(&format!("; {name}={value}"));
        }
        tags.push_str(&format!("; bh={bh}; b="));
        // The signed data: the headers, then the signature's own header without its trailing
        // CRLF, then the body hash.
        let mut data = Vec::new();
        mail_auth::dkim::Canonicalization::Relaxed
            .canonicalize_headers(headers.iter().copied(), &mut data);
        data.extend_from_slice(b"dkim-signature:");
        data.extend_from_slice(tags.as_bytes());
        data.extend_from_slice(&body_hash);
        let b = base64::engine::general_purpose::STANDARD.encode(key.sign(data.as_slice()).unwrap());
        format!("DKIM-Signature: {tags}{b}\r\n{letter}")
    }

    fn key(domain: &str, record: &str) -> (String, Txt) {
        let name = format!("s1._domainkey.{domain}.");
        (name, Txt::from(DomainKey::parse(record.as_bytes()).unwrap()))
    }

    fn dmarc(domain: &str, record: Option<&str>) -> (String, Txt) {
        let txt = match record {
            Some(r) => Txt::from(Dmarc::parse(r.as_bytes()).unwrap()),
            None => Txt::Error(mail_auth::Error::Dns(mail_auth::DnsError::RecordNotFound(
                ResponseCode::NXDomain,
            ))),
        };
        (format!("_dmarc.{domain}."), txt)
    }

    /// DNS that knows only these answers and never reaches the network.
    fn dns(answers: impl IntoIterator<Item = (String, Txt)>) -> Verifier {
        let cache = TxtCache::default();
        for (name, txt) in answers {
            cache.insert(name.into_boxed_str(), txt, Instant::now() + Duration::from_secs(3600));
        }
        Verifier::with(|| Some(offline()), cache)
    }

    /// DNS that knows only the key of `s1._domainkey.<domain>`.
    fn verifier(domain: &str, record: &str) -> Verifier {
        dns([key(domain, record)])
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

    impl Verifier {
        /// How many names the check asked DNS about.
        fn asked(&self) -> usize {
            let asked = self.cache.asked.lock().unwrap();
            asked.iter().collect::<std::collections::HashSet<_>>().len()
        }

        fn was_asked(&self, name: &str) -> bool {
            let hash = std::hash::BuildHasher::hash_one(&self.cache.hasher, name);
            self.cache.asked.lock().unwrap().contains(&hash)
        }
    }

    /// The address the reader shows for the letter, and trusts.
    fn shown(raw: &str) -> String {
        crate::message::parse_summary(raw.as_bytes())
            .from
            .map(|a| a.email)
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn a_valid_signature_of_the_from_address_confirms_the_sender() {
        let (key, record) = keypair();
        let signed = sign_rfc(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(offline_verdict(signed.as_bytes(), SENDER), None);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Aligned);
        assert_eq!(
            v.check(signed.as_bytes(), "No-Reply@1C-Bitrix.ru").await,
            Signature::Aligned
        );
        // The same domain is not enough: the address is the one trusted.
        assert_eq!(v.check(signed.as_bytes(), "ceo@1c-bitrix.ru").await, Signature::Invalid);
    }

    #[tokio::test]
    async fn a_signature_of_the_organization_aligns_a_subdomain() {
        // #167: `d=openai.com` for From `email.openai.com`.
        let letter = LETTER.replace("no-reply@1c-bitrix.ru", "noreply@email.openai.com");
        let (k, record) = keypair();
        let signed = sign_rfc(k, "openai.com", &letter);
        let v = dns([
            key("openai.com", &record),
            dmarc("email.openai.com", None),
            dmarc("openai.com", Some("v=DMARC1; p=reject")),
        ]);
        assert_eq!(
            v.check(signed.as_bytes(), "noreply@email.openai.com").await,
            Signature::Aligned
        );
    }

    #[tokio::test]
    async fn a_strict_dkim_policy_wants_the_exact_name() {
        let letter = LETTER.replace("no-reply@1c-bitrix.ru", "noreply@email.openai.com");
        let (k, record) = keypair();
        let signed = sign_rfc(k, "openai.com", &letter);
        let strict = |at: &str| {
            let (sub, org) = match at {
                "sub" => (Some("v=DMARC1; p=reject; adkim=s"), None),
                _ => (None, Some("v=DMARC1; p=reject; adkim=s")),
            };
            dns([
                key("openai.com", &record),
                dmarc("email.openai.com", sub),
                dmarc("openai.com", org),
            ])
        };
        for at in ["sub", "org"] {
            let v = strict(at);
            assert_eq!(
                v.check(signed.as_bytes(), "noreply@email.openai.com").await,
                Signature::NotAligned,
                "{at}"
            );
        }
        // DNS that does not answer about the policy: nothing is known.
        let v = dns([key("openai.com", &record)]);
        assert_eq!(
            v.check(signed.as_bytes(), "noreply@email.openai.com").await,
            Signature::Unchecked
        );
    }

    #[tokio::test]
    async fn a_changed_letter_or_a_foreign_key_is_no_confirmation() {
        let (key, record) = keypair();
        let signed = sign_rfc(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        let changed = signed.replace("logo.png", "track.png");
        assert_eq!(v.check(changed.as_bytes(), SENDER).await, Signature::Invalid);
        let resent = signed.replace("Subject: Hi", "Subject: Pay now");
        assert_eq!(v.check(resent.as_bytes(), SENDER).await, Signature::Invalid);
        // Signed with another key than the one DNS publishes.
        let forged = sign_rfc(keypair().0, "1c-bitrix.ru", LETTER);
        assert_eq!(v.check(forged.as_bytes(), SENDER).await, Signature::Invalid);
    }

    #[tokio::test]
    async fn a_signature_of_another_organization_asks_no_dns() {
        // Asking for the key of `d=` would tell its owner the letter was read.
        let signed = sign_rfc_with(
            keypair().0,
            "t.tracker.example",
            "u123",
            &["from", "to", "subject"],
            &[("r", "y".into())],
            LETTER,
        );
        assert!(signed.contains("r=y"), "{signed}");
        let v = dns([]);
        assert_eq!(offline_verdict(signed.as_bytes(), SENDER), Some(Signature::NotAligned));
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::NotAligned);
        assert_eq!(v.asked(), 0);
        // A look-alike and a name under a private suffix are other organizations too.
        let letter = LETTER.replace("1c-bitrix.ru", "bank.github.io");
        let signed = sign_rfc(keypair().0, "evil.github.io", &letter);
        assert_eq!(
            v.check(signed.as_bytes(), "no-reply@bank.github.io").await,
            Signature::NotAligned
        );
        assert_eq!(v.asked(), 0);
        // Next to a signature of the sender, only the sender's key is asked for.
        let (k, record) = keypair();
        let both = sign_rfc_with(
            k,
            "1c-bitrix.ru",
            "s1",
            &["from", "to", "subject"],
            &[],
            &sign_rfc_with(
                keypair().0,
                "t.tracker.example",
                "u123",
                &["from"],
                &[("r", "y".into())],
                LETTER,
            ),
        );
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(v.check(both.as_bytes(), SENDER).await, Signature::Aligned);
        assert!(v.was_asked("s1._domainkey.1c-bitrix.ru."));
        assert_eq!(v.asked(), 1);
    }

    #[tokio::test]
    async fn a_failed_signature_asks_for_no_report_address() {
        let (k, record) = keypair();
        let signed = sign_rfc_with(
            k,
            "1c-bitrix.ru",
            "s1",
            &["from", "to", "subject"],
            &[("r", "y".into())],
            LETTER,
        );
        let changed = signed.replace("logo.png", "track.png");
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(v.check(changed.as_bytes(), SENDER).await, Signature::Invalid);
        assert!(!v.was_asked("_report._domainkey.1c-bitrix.ru."));
    }

    #[tokio::test]
    async fn a_letter_not_from_the_trusted_address_asks_no_dns() {
        let (k, _) = keypair();
        let signed = sign_rfc(k, "1c-bitrix.ru", LETTER);
        let v = dns([]);
        assert_eq!(v.check(signed.as_bytes(), "friend@bank.ru").await, Signature::Invalid);
        assert_eq!(
            offline_verdict(signed.as_bytes(), "friend@bank.ru"),
            Some(Signature::Invalid)
        );
        assert_eq!(v.asked(), 0);
    }

    #[tokio::test]
    async fn a_body_length_signature_is_refused() {
        // Text added below the signed length would pass unsigned.
        let (k, record) = keypair();
        let signed = sign_with(signer(k, "1c-bitrix.ru").body_length(true), LETTER);
        assert!(signed.contains("l="), "{signed}");
        let longer = format!("{signed}<img src=\"https://track.example/p.png\">\r\n");
        let v = verifier("1c-bitrix.ru", &record);
        for raw in [&signed, &longer] {
            assert_eq!(v.check(raw.as_bytes(), SENDER).await, Signature::Invalid);
        }
        assert_eq!(v.asked(), 0);
    }

    #[tokio::test]
    async fn a_second_from_breaks_the_confirmation() {
        let (key, record) = keypair();
        let signed = sign_rfc(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        let two = format!("From: Bank <security@bank.ru>\r\n{signed}");
        assert_eq!(v.check(two.as_bytes(), "security@bank.ru").await, Signature::Invalid);
        assert_eq!(v.check(two.as_bytes(), SENDER).await, Signature::Invalid);
        // The From the reader shows must be the signed one.
        assert_eq!(v.check(signed.as_bytes(), "security@bank.ru").await, Signature::Invalid);
    }

    #[tokio::test]
    async fn a_from_only_the_reader_sees_breaks_the_confirmation() {
        // An attacker with a box at gmail.com signs his own From, and writes a friend's address
        // where the reader takes it for From and the signature check does not.
        let (key, record) = keypair();
        let own = "From: attacker@gmail.com\r\nTo: me@firm.example\r\nSubject: Hi\r\n";
        let body = "\r\n<img src=\"https://track.example/p.png\">\r\n";
        let below = sign_rfc(
            key,
            "gmail.com",
            &format!("{own}Fr om: Friend <friend@gmail.com>\r\n{body}"),
        );
        let (key2, record2) = keypair();
        let no_colon = sign_rfc(
            key2,
            "gmail.com",
            &format!("{own}X\r\nFrom: Friend <friend@gmail.com>{body}"),
        );
        for (raw, record) in [(&below, &record), (&no_colon, &record2)] {
            let v = verifier("gmail.com", record);
            let reader = shown(raw);
            assert_eq!(reader, "friend@gmail.com", "{raw}");
            for address in [reader.as_str(), "attacker@gmail.com"] {
                let verdict = v.check(raw.as_bytes(), address).await;
                assert!(!verdict.passed(), "{address}: {raw}");
            }
        }
    }

    #[tokio::test]
    async fn thousands_of_signatures_are_checked_quickly() {
        // DNS publishes another key: every signature is hashed and verified to the end.
        let (k, _) = keypair();
        let record = keypair().1;
        let one = sign_rfc_with(
            k,
            "1c-bitrix.ru",
            "s1",
            &vec!["from"; 300],
            &[],
            LETTER,
        );
        let header = &one[..one.len() - LETTER.len()];
        // A whitespace-only line goes on with the header above it: no end of the headers.
        let raw = format!("X-Pad: a\r\n \r\n{}{LETTER}", header.repeat(8000));
        assert_eq!(signature_headers(raw.as_bytes()), 8000);
        let v = verifier("1c-bitrix.ru", &record);
        let start = Instant::now();
        let verdict = v.check(raw.as_bytes(), SENDER).await;
        assert!(start.elapsed() < Duration::from_secs(2), "{:?}", start.elapsed());
        assert!(!verdict.passed());
        let start = Instant::now();
        assert_eq!(crate::message::sole_from(raw.as_bytes()), None);
        assert!(start.elapsed() < Duration::from_secs(2), "{:?}", start.elapsed());
        assert_eq!(v.asked(), 0);
    }

    #[test]
    fn the_headers_end_where_mail_auth_ends_them() {
        fn end(raw: &str) -> &str {
            &raw[..header_end(raw.as_bytes())]
        }
        assert_eq!(end("A: 1\r\nB: 2\r\n\r\nbody"), "A: 1\r\nB: 2\r\n\r\n");
        assert_eq!(end("A: 1\r\n \r\nB: 2\r\n\r\nbody"), "A: 1\r\n \r\nB: 2\r\n\r\n");
        assert_eq!(end("A: 1\nB: 2\n\nbody"), "A: 1\nB: 2\n\n");
        // A line without a colon ends them in CRLF, and is a field of no name in LF.
        assert_eq!(end("A: 1\r\nX\r\nB: 2\r\n\r\n"), "A: 1\r\nX\r\n");
        assert_eq!(end("A: 1\nX\nB: 2\n\n"), "A: 1\nX\nB: 2\n\n");
        assert_eq!(end("A: 1"), "A: 1");
        let raw =
            "DKIM-Signature: 1\r\n\tmore\r\nDkim-signature: 2\r\n \r\nX-DKIM-Signature: 3\r\n\r\nDKIM-Signature: 4\r\n";
        assert_eq!(signature_headers(raw.as_bytes()), 2);
    }

    #[tokio::test]
    async fn a_sha1_signature_asks_no_dns() {
        // RFC 8301 §3.1: `rsa-sha1` signs nothing any longer.
        let (k, record) = keypair();
        let signed = sign_rfc(k, "1c-bitrix.ru", LETTER).replacen("a=ed25519-sha256", "a=rsa-sha1", 1);
        assert!(signed.contains("a=rsa-sha1"), "{signed}");
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(offline_verdict(signed.as_bytes(), SENDER), Some(Signature::Invalid));
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Invalid);
        assert_eq!(v.asked(), 0);
    }

    #[tokio::test]
    async fn a_key_in_testing_confirms_nobody() {
        // RFC 6376 §3.6.1: mail signed with a `t=y` key is mail without a signature.
        let (k, record) = keypair();
        let signed = sign_rfc(k, "1c-bitrix.ru", LETTER);
        let testing = record.replace("k=ed25519;", "k=ed25519; t=y;");
        let v = verifier("1c-bitrix.ru", &testing);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Invalid);
        let strict = record.replace("k=ed25519;", "k=ed25519; t=s;");
        let v = verifier("1c-bitrix.ru", &strict);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Aligned);
    }

    #[tokio::test]
    async fn a_third_party_request_asks_no_dns() {
        let (k, record) = keypair();
        let signed = sign_rfc_with(
            k,
            "1c-bitrix.ru",
            "s1",
            &["from", "to", "subject"],
            &[("atps", "tracker.example".into())],
            LETTER,
        );
        assert!(signed.contains("atps=tracker.example"), "{signed}");
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Aligned);
        assert!(v.was_asked("s1._domainkey.1c-bitrix.ru."));
        assert_eq!(v.asked(), 1);
    }

    #[tokio::test]
    async fn a_signature_without_from_or_with_too_many_headers_asks_no_dns() {
        for headers in [vec!["To", "Subject"], vec!["From"; MAX_SIGNED + 1]] {
            let (k, record) = keypair();
            let signed = sign_rfc_with(
                k,
                "1c-bitrix.ru",
                "s1",
                &headers,
                &[],
                LETTER,
            );
            let v = verifier("1c-bitrix.ru", &record);
            assert_eq!(
                v.check(signed.as_bytes(), SENDER).await,
                Signature::Invalid,
                "{headers:?}"
            );
            assert_eq!(v.asked(), 0);
        }
    }

    #[tokio::test]
    async fn only_the_first_signatures_are_looked_up() {
        // The sender's own valid signature stands below five of others' keys of its domain.
        let (k, record) = keypair();
        let mut raw = sign_rfc(k, "1c-bitrix.ru", LETTER);
        let mut answers = vec![key("1c-bitrix.ru", &record)];
        for i in 0..MAX_SIGNATURES {
            raw = sign_rfc_with(
                keypair().0,
                "1c-bitrix.ru",
                &format!("x{i}"),
                &["from", "to", "subject"],
                &[],
                &raw,
            );
            // DNS publishes another key for each of them.
            let txt = Txt::from(DomainKey::parse(keypair().1.as_bytes()).unwrap());
            answers.push((format!("x{i}._domainkey.1c-bitrix.ru."), txt));
        }
        let v = dns(answers);
        assert_eq!(v.check(raw.as_bytes(), SENDER).await, Signature::Invalid);
        assert_eq!(v.asked(), MAX_SIGNATURES);
        assert!(!v.was_asked("s1._domainkey.1c-bitrix.ru."));
    }

    #[tokio::test]
    async fn odd_from_headers_confirm_nobody() {
        let own = "To: me@firm.example\r\nSubject: Hi\r\n";
        let body = "\r\n<img src=\"https://track.example/p.png\">\r\n";
        for from in [
            "From: no-reply@1c-bitrix.ru\r\n:From: Friend <friend@1c-bitrix.ru>\r\n",
            "From: no-reply@1c-bitrix.ru\r\n From: Friend <friend@1c-bitrix.ru>\r\n",
            "From: Friends: no-reply@1c-bitrix.ru;\r\n",
            "From: no-reply@1c-bitrix.ru, friend@1c-bitrix.ru\r\n",
            "From: =?utf-8?q?friend=40gmail=2Ecom?= <no-reply@1c-bitrix.ru>\r\n",
        ] {
            let (k, record) = keypair();
            let raw = sign_rfc(k, "1c-bitrix.ru", &format!("{from}{own}{body}"));
            let v = verifier("1c-bitrix.ru", &record);
            let reader = shown(&raw);
            let signed = crate::message::sole_from(raw.as_bytes());
            // The check confirms only the one From both readers see, and the reader shows it.
            for address in [reader.as_str(), SENDER, "friend@1c-bitrix.ru", "friend@gmail.com"] {
                let verdict = v.check(raw.as_bytes(), address).await;
                let agreed = signed.as_deref() == Some(address) && reader == address;
                assert!(!verdict.passed() || agreed, "{address}: {from}");
            }
        }
        // An encoded display name is still the one address.
        let (k, record) = keypair();
        let from = "From: =?utf-8?b?0JHQsNC90Lo=?= <no-reply@1c-bitrix.ru>\r\n";
        let raw = sign_rfc(k, "1c-bitrix.ru", &format!("{from}{own}{body}"));
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(v.check(raw.as_bytes(), SENDER).await, Signature::Aligned);
        // A group and two addresses are no single From.
        for from in [
            "From: Friends: no-reply@1c-bitrix.ru;\r\n",
            "From: no-reply@1c-bitrix.ru, friend@1c-bitrix.ru\r\n",
        ] {
            let raw = format!("{from}{own}{body}");
            assert_eq!(crate::message::sole_from(raw.as_bytes()), None, "{from}");
        }
    }

    #[tokio::test]
    async fn a_check_out_of_time_is_unchecked() {
        let (k, record) = keypair();
        // A long body: the hash takes longer than no time at all.
        let letter = format!("{LETTER}{}", "x".repeat(4 << 20));
        let signed = sign_rfc(k, "1c-bitrix.ru", &letter);
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Aligned);
        let v = Verifier {
            limit: Duration::ZERO,
            ..verifier("1c-bitrix.ru", &record)
        };
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Unchecked);
    }

    #[tokio::test]
    async fn without_the_network_the_signature_is_unchecked_not_confirmed() {
        let signed = sign_rfc(keypair().0, "1c-bitrix.ru", LETTER);
        let v = dns([]);
        let verdict = v.check(signed.as_bytes(), SENDER).await;
        assert_eq!(verdict, Signature::Unchecked);
        assert!(!verdict.passed());
    }

    static BUILT: AtomicUsize = AtomicUsize::new(0);

    #[tokio::test]
    async fn the_resolver_is_built_again_after_no_answer() {
        // A new network or VPN brings its own name servers; a failed start is no verdict for good.
        fn counted() -> Option<MessageAuthenticator> {
            (BUILT.fetch_add(1, Ordering::SeqCst) > 0).then(offline)
        }
        let signed = sign_rfc(keypair().0, "1c-bitrix.ru", LETTER);
        let v = Verifier::with(counted, TxtCache::default());
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Unchecked);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Unchecked);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Unchecked);
        assert_eq!(BUILT.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_letter_without_a_signature_is_unsigned() {
        let v = dns([]);
        assert_eq!(offline_verdict(LETTER.as_bytes(), SENDER), Some(Signature::Unsigned));
        assert_eq!(v.check(LETTER.as_bytes(), SENDER).await, Signature::Unsigned);
    }

    #[tokio::test]
    async fn the_verdict_of_a_letter_is_kept_for_its_from_address() {
        let (key, record) = keypair();
        let signed = sign_rfc(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        let raw = signed.as_bytes();
        assert_eq!(v.known(7, raw, SENDER), None);
        assert_eq!(v.check_letter(7, raw, SENDER).await, Signature::Aligned);
        assert_eq!(v.known(7, raw, SENDER), Some(Signature::Aligned));
        assert_eq!(v.known(7, raw, "ceo@1c-bitrix.ru"), None);
        assert_eq!(v.known(8, raw, SENDER), None);
        // The id of a deleted letter given to another one: its verdict does not go with it.
        assert_eq!(v.known(7, LETTER.as_bytes(), SENDER), None);
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
