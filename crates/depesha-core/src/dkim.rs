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

use mail_auth::common::crypto::Algorithm;
use mail_auth::common::parse::TxtRecordParser;
use mail_auth::common::verify::DomainKey;
use mail_auth::dmarc::{Alignment, Dmarc};
use mail_auth::hickory_resolver::TokioResolver;
use mail_auth::{AuthenticatedMessage, DkimResult, DnsError, MessageAuthenticator, Parameters, ResolverCache, Txt};

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
    /// The check failed, and this is why (0.8.13, 7.1 Б): the log names the reason.
    Failed(Reason),
}

/// Why the app's own check of a signature failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The body of the letter is not the one the signature covers: the hash did not match.
    BodyHash,
    /// The signature does not match the headers it covers.
    BadSignature,
    /// The signature does not stand any more: the time in its `x=` tag has passed.
    Expired,
    /// The key of the signature is not there, or is revoked: no later check will find it.
    NoKey,
    /// The key is in testing mode (`t=y`): such a signature is no signature.
    TestingKey,
    /// The `i=` of the signature is of another domain than the `d=`.
    Auid,
    /// The signature uses SHA-1, which signs nothing any longer (RFC 8301).
    Sha1,
    /// The signature does not cover the `From`.
    NoFromInH,
    /// The signature names a length of the body (`l=`): the text below it would pass unsigned.
    LRefused,
    /// The signature names more headers than a real one does.
    TooManyH,
    /// The signature is of another organization than the From.
    FromMismatch,
    /// The sender's policy asks for the exact name in `d=` (`adkim=s`).
    StrictPolicy,
    /// The letter is of another time than the letter that was received.
    Replay,
    /// The signature covers neither the `To` nor the `Cc` the address of the mailbox stands in.
    NoRecipientInH,
    /// The signature is of another organization than the From, as the check over the original
    /// headers of a letter of Exchange sees it (0.8.13, ступень 4).
    NotAligned,
    /// The server of the mailbox and the app may read the block of headers differently.
    UnevenHeaders,
}

impl Reason {
    /// The reason as the log names it.
    pub fn code(self) -> &'static str {
        match self {
            Self::BodyHash => "body_hash",
            Self::BadSignature => "bad_signature",
            Self::Expired => "expired",
            Self::NoKey => "no_key",
            Self::TestingKey => "testing_key",
            Self::Auid => "auid",
            Self::Sha1 => "sha1",
            Self::NoFromInH => "no_from_in_h",
            Self::LRefused => "l_refused",
            Self::TooManyH => "too_many_h",
            Self::FromMismatch => "from_mismatch",
            Self::StrictPolicy => "strict_policy",
            Self::Replay => "replay",
            Self::NoRecipientInH => "no_recipient_in_h",
            Self::NotAligned => "not_aligned",
            Self::UnevenHeaders => "uneven_headers",
        }
    }
}

impl Signature {
    pub fn passed(self) -> bool {
        self == Self::Aligned
    }

    /// Why the check failed, when it failed: `None` when it passed or when nothing is known.
    pub fn reason(self) -> Option<Reason> {
        match self {
            Self::Failed(reason) => Some(reason),
            _ => None,
        }
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
    Rejected(Reason),
    /// DNS did not answer for the key: nothing is known, which is no confirmation.
    Unchecked,
}

impl Headers {
    pub fn passed(self) -> bool {
        self == Self::Valid
    }

    /// Why the check failed, when it failed.
    pub fn reason(self) -> Option<Reason> {
        match self {
            Self::Rejected(reason) => Some(reason),
            _ => None,
        }
    }
}

/// The verdict on `raw` for the sender `address` that needs no DNS, or `None` when only a
/// lookup of the sender's own key can tell.
pub fn offline_verdict(raw: &[u8], address: &str) -> Option<Signature> {
    candidates_for(raw, address).err()
}

/// The letter as `mail-auth` reads it, with only the signatures worth a lookup: of the From
/// address's organization, covering From, at most [`MAX_SIGNATURES`]. Their report (`r=`) and
/// third-party (`atps=`) requests are dropped: each is one more name asked of DNS. `Err` is the
/// verdict when no signature is worth it.
///
/// The recipient of the letter (the protection against a replayed letter, 0.8.13, ступень 4) is
/// no filter here: whether a signature names the mailbox and the time of the letter is asked of
/// the one signature that passed, not of whichever signature the block happens to carry.
fn candidates_for<'x>(raw: &'x [u8], address: &str) -> Result<AuthenticatedMessage<'x>, Signature> {
    if signature_headers(raw) > MAX_HEADERS {
        return Err(Signature::Invalid);
    }
    let Some(mut message) = AuthenticatedMessage::parse(raw) else {
        return Err(Signature::Invalid);
    };
    if message.dkim_headers.is_empty() && !message.has_dkim_errors {
        return Err(Signature::Unsigned);
    }
    // A signature with a length of the body (`l=`) is refused by `mail-auth` before the app
    // sees it: the text below that length would pass unsigned.
    if message.dkim_headers.is_empty() && message.has_dkim_errors {
        return Err(Signature::Failed(Reason::LRefused));
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
    let mut refused: Option<Reason> = None;
    message.dkim_headers.retain(|h| {
        let s = &h.header;
        if !ours(s) {
            return false;
        }
        if s.a == Algorithm::RsaSha1 {
            refused.get_or_insert(Reason::Sha1);
            return false;
        }
        if s.h.len() > MAX_SIGNED {
            refused.get_or_insert(Reason::TooManyH);
            return false;
        }
        // A signature that does not cover the `From` names no sender, and the `From` may then
        // be added by anyone (RFC 7489 §6.6.1).
        if !s.h.iter().any(|name| name.trim().eq_ignore_ascii_case("from")) {
            refused.get_or_insert(Reason::NoFromInH);
            return false;
        }
        true
    });
    if message.dkim_headers.is_empty() {
        return Err(match refused {
            Some(reason) => Signature::Failed(reason),
            None => Signature::Invalid,
        });
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

/// Whether the block of headers of `raw` is uneven (0.8.13, 7.1 Б): a line that ends with a bare
/// LF, a line that is neither a field nor the continuation of one, or a field whose name carries
/// a space. The server of the mailbox and the app read such a block differently — one may take a
/// line for a field of no name, or for the end of the headers, where the other reads on — so the
/// server's word about the sender is not taken there, and the app checks the signature itself.
pub(crate) fn uneven_headers(raw: &[u8]) -> bool {
    let block = &raw[..header_end(raw)];
    let mut mixed: Option<bool> = None;
    let mut pos = 0;
    while let Some(offset) = block[pos..].iter().position(|&b| b == b'\n') {
        let end = pos + offset;
        let crlf = end > pos && block[end - 1] == b'\r';
        // One line ending at the start and another later: two readers may part on where the
        // headers end.
        match mixed {
            Some(first) if first != crlf => return true,
            None => mixed = Some(crlf),
            _ => {}
        }
        let line = &block[pos..if crlf { end - 1 } else { end }];
        if line.is_empty() {
            return false;
        }
        let folded = matches!(line.first(), Some(b' ' | b'\t'));
        if !folded {
            match line.iter().position(|&b| b == b':') {
                Some(colon) if colon > 0 => {
                    if line[..colon].iter().any(u8::is_ascii_whitespace) {
                        return true;
                    }
                }
                // A line without a name, or without a colon at all.
                _ => return true,
            }
        }
        pos = end + 1;
    }
    false
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
type RememberedHeaders = ([u8; 32], String, Headers, Instant);

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
    /// The same for the check of the original headers of a letter of Exchange (0.8.13,
    /// ступень 4), by letter id.
    headers: Mutex<HashMap<i64, RememberedHeaders>>,
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
            headers: Mutex::default(),
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

    /// The verdict [`Verifier::check_headers`] gave for these headers and this From address,
    /// unless it was [`Headers::Unchecked`] long enough ago to ask DNS again.
    pub fn known_headers(&self, id: i64, headers: &[u8], address: &str) -> Option<Headers> {
        let remembered = self.headers.lock().ok()?;
        let (hash, from, verdict, at) = remembered.get(&id)?;
        let fresh = *verdict != Headers::Unchecked || at.elapsed() < RETRY;
        (*hash == digest(headers) && from.eq_ignore_ascii_case(address.trim()) && fresh).then_some(*verdict)
    }

    /// [`Verifier::check_headers`], remembered for [`Verifier::known_headers`].
    pub async fn check_headers_remembered(
        &self,
        id: i64,
        headers: &[u8],
        address: &str,
        mailbox: &str,
        received: i64,
    ) -> Headers {
        let verdict = self.check_headers(headers, address, mailbox, received).await;
        self.remember_headers(id, headers, address, verdict);
        verdict
    }

    /// Remembers the verdict of [`Verifier::check_headers`] for [`Verifier::known_headers`]. A
    /// check that found a letter of another time is remembered too: the letter on screen is not
    /// that letter, and asking again would say «checking» forever.
    pub fn remember_headers(&self, id: i64, headers: &[u8], address: &str, verdict: Headers) {
        if let Ok(mut remembered) = self.headers.lock() {
            if remembered.len() >= LETTERS {
                remembered.clear();
            }
            remembered.insert(
                id,
                (digest(headers), address.trim().to_owned(), verdict, Instant::now()),
            );
        }
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

    /// Adds a DNS answer to the cache of the check, as if the name servers had given it. The
    /// e2e build uses it to publish the key of a signed letter of the stand: the stand has no
    /// name server of its own, and a letter with a key nobody can look up is a letter nobody
    /// can confirm.
    pub fn add_answer(&self, name: &str, record: &str) -> bool {
        let Ok(key) = DomainKey::parse(record.as_bytes()) else {
            return false;
        };
        self.cache.insert(
            name.to_owned().into_boxed_str(),
            Txt::from(key),
            Instant::now() + Duration::from_secs(3600),
        );
        true
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
        self.run(raw, address, None, true).await
    }

    /// Whether a block of original headers carries a valid DKIM signature of the organization of
    /// `address`, its only From, which is about a letter that came to `mailbox` at `received`
    /// (0.8.13, ступень 4). The body of the letter is not at hand and is not checked: the signature
    /// proves the headers, not what the letter says. `received` is the server's own time of
    /// receipt; a block whose two readers may part on the headers is rejected.
    pub async fn check_headers(&self, headers: &[u8], address: &str, mailbox: &str, received: i64) -> Headers {
        let headers = without_preamble(headers);
        // The server of the mailbox and the app may read an uneven block differently: a signature
        // over it proves nothing about the headers the letter on screen shows (0.8.13, 7.1 Б).
        if uneven_headers(headers) {
            return Headers::Rejected(Reason::UnevenHeaders);
        }
        let addressed = Addressed {
            mailbox: mailbox.to_owned(),
            received,
        };
        headers_verdict(self.run(headers, address, Some(addressed), false).await)
    }

    /// [`Verifier::check`] and [`Verifier::check_headers`] themselves: the same check, with or
    /// without the body of the letter. `addressed` is the mailbox and the time of receipt a
    /// signature over the original headers must prove.
    async fn run(&self, raw: &[u8], address: &str, addressed: Option<Addressed>, body: bool) -> Signature {
        if let Err(verdict) = candidates_for(raw, address) {
            return verdict;
        }
        let Some(auth) = self.authenticator() else {
            return Signature::Unchecked;
        };
        let (raw, address, cache) = (raw.to_vec(), address.to_owned(), Arc::clone(&self.cache));
        let (handle, limit) = (tokio::runtime::Handle::current(), self.limit);
        let started = Instant::now();
        let task = tokio::task::spawn_blocking(move || {
            handle.block_on(async {
                tokio::time::timeout(limit, verify(&auth, &cache, &raw, &address, addressed.as_ref(), body))
                    .await
                    .unwrap_or(Signature::Unchecked)
            })
        });
        let verdict = match tokio::time::timeout(self.limit, task).await {
            // The work runs off the async threads, and the timer is looked at once per poll: an
            // answer that came after the limit is no answer, however soon the runtime saw it.
            Ok(Ok(verdict)) if started.elapsed() <= self.limit => verdict,
            _ => Signature::Unchecked,
        };
        if verdict == Signature::Unchecked
            && let Ok(mut auth) = self.auth.lock()
        {
            *auth = None;
        }
        verdict
    }
}

/// The answer of the check of a block of headers, in the shape the ladder takes it. A signature of
/// another organization is `not_aligned` there, not a signature that does not match: the two are
/// different reasons in the log (0.8.13, 7.1 Б).
fn headers_verdict(verdict: Signature) -> Headers {
    match verdict {
        Signature::Aligned => Headers::Valid,
        Signature::Unsigned => Headers::Unsigned,
        Signature::Unchecked => Headers::Unchecked,
        Signature::Failed(reason) => Headers::Rejected(reason),
        Signature::NotAligned => Headers::Rejected(Reason::NotAligned),
        Signature::Invalid => Headers::Rejected(Reason::BadSignature),
    }
}

/// [`Verifier::run`] itself, on a thread of its own.
///
/// The check is `mail-auth`'s own (RFC 6376 §3.7): the canonicalized headers named in `h=`, then
/// the `DKIM-Signature` header with the value of its `b=` tag deleted. The body enters the
/// signature through `bh=` alone, and only when `body` says the body is at hand — the body of a
/// letter that came through Exchange in the firm's own network was assembled again, and the
/// original one is not there.
async fn verify(
    auth: &MessageAuthenticator,
    cache: &TxtCache,
    raw: &[u8],
    address: &str,
    addressed: Option<&Addressed>,
    body: bool,
) -> Signature {
    let mut message = match candidates_for(raw, address) {
        Ok(message) => message,
        Err(verdict) => return verdict,
    };
    if !body {
        without_the_body(&mut message);
    }
    let from_domain = address.trim().rsplit_once('@').map_or("", |(_, d)| d);
    let params = Parameters::new(&message).with_txt_cache(cache);
    let (mut verdict, mut relaxed) = (Signature::Invalid, None);
    let outputs = auth.verify_dkim(params).await;
    for output in &outputs {
        let Some(signature) = output.signature() else {
            // A signature the library refuses before reading it as one: a version or an
            // algorithm it does not know.
            continue;
        };
        match output.result() {
            DkimResult::Pass => match testing(auth, cache, signature).await {
                // The key of a domain in testing mode is no key (RFC 6376 §3.6.1).
                Some(true) => verdict = Signature::Failed(Reason::TestingKey),
                None => verdict = Signature::Unchecked,
                Some(false) if same_domain(&signature.d, from_domain) => {
                    // The signature that passed is asked about the mailbox and the time of the
                    // letter itself: no other signature of the block may answer for it (0.8.13,
                    // ступень 4).
                    if let Some(addressed) = addressed
                        && let Err(reason) = proves_the_letter(&message, raw, signature, addressed)
                    {
                        verdict = Signature::Failed(reason);
                        continue;
                    }
                    return Signature::Aligned;
                }
                Some(false) => relaxed = Some(signature),
            },
            DkimResult::TempError(_) => verdict = Signature::Unchecked,
            DkimResult::Fail(err) | DkimResult::PermError(err) | DkimResult::Neutral(err) => {
                verdict = match reason_of(err) {
                    Some(reason) => Signature::Failed(reason),
                    None => Signature::Unchecked,
                };
            }
            DkimResult::None => {}
        }
    }
    let Some(relaxed) = relaxed else {
        return verdict;
    };
    match strict(auth, cache, from_domain).await {
        Some(false) => {
            if let Some(addressed) = addressed
                && let Err(reason) = proves_the_letter(&message, raw, relaxed, addressed)
            {
                return Signature::Failed(reason);
            }
            Signature::Aligned
        }
        Some(true) => Signature::Failed(Reason::StrictPolicy),
        None => Signature::Unchecked,
    }
}

/// The `bh=` tag of every signature replaced by the hash of the bytes at hand (0.8.13, ступень 4).
///
/// The body of the letter is not among the original headers, and the one Exchange assembled again
/// is not the one the sender signed. The signature still covers the headers; the `bh=` comparison
/// would fail over a body nobody signed. The header itself is untouched: the signed data is built
/// from its bytes, and `bh=` is not signed as such.
fn without_the_body(message: &mut AuthenticatedMessage<'_>) {
    let hashes: Vec<_> = message
        .body_hashes
        .iter()
        .map(|(cb, ha, l, bh)| (*cb, *ha, *l, bh.clone()))
        .collect();
    for header in &mut message.dkim_headers {
        let signature = &mut header.header;
        let hash = mail_auth::common::crypto::HashAlgorithm::from(signature.a);
        if let Some((_, _, _, at_hand)) = hashes
            .iter()
            .find(|(cb, ha, l, _)| *cb == signature.cb && *ha == hash && *l == signature.l)
        {
            signature.bh = at_hand.clone();
        }
    }
}

/// Why the library's check of one signature failed, as the app names it. `None`: nothing is known,
/// which is no answer at all.
fn reason_of(error: &mail_auth::Error) -> Option<Reason> {
    use mail_auth::dkim::DkimError;
    Some(match error {
        mail_auth::Error::Dkim(DkimError::SignatureExpired) => Reason::Expired,
        mail_auth::Error::Dkim(DkimError::FailedBodyHashMatch) => Reason::BodyHash,
        mail_auth::Error::Dkim(DkimError::FailedAuidMatch) => Reason::Auid,
        mail_auth::Error::Dkim(DkimError::SignatureLength) => Reason::LRefused,
        // The key is not there, is revoked, or is no key at all: no later check will find it.
        mail_auth::Error::Dkim(DkimError::RevokedPublicKey | DkimError::UnsupportedKeyType)
        | mail_auth::Error::Dns(DnsError::RecordNotFound(_) | DnsError::InvalidRecordType) => Reason::NoKey,
        // An algorithm the library refuses to verify: SHA-1 signs nothing any longer (RFC 8301).
        mail_auth::Error::Dkim(DkimError::UnsupportedAlgorithm) => Reason::Sha1,
        // No answer from the name servers: the check is worth repeating.
        mail_auth::Error::Dns(DnsError::Resolver(_)) => return None,
        _ => Reason::BadSignature,
    })
}

/// How close the time of a letter must be to the time it was received, for a letter that
/// comes with original headers only (0.8.13, ступень 4). A letter of another time cannot be
/// this letter: the signature of a letter the sender sent long ago proves nothing about the
/// body of a letter that came now.
pub const REPLAY_HOURS: i64 = 24;

/// The mailbox a letter of Exchange came to and when the server took it: what a signature over
/// the original headers of the letter must prove besides the `From` (0.8.13, ступень 4).
struct Addressed {
    mailbox: String,
    received: i64,
}

/// Whether this signature is about a letter that came to this mailbox at this time: its own `t=`
/// (or a `Date` it covers, read alike by both readers), and its own covered `To` or `Cc` with the
/// address of the mailbox.
///
/// The question is asked of the signature that passed, not of the block: a signature that says
/// nothing of the kind proves nothing about the letter on screen, whatever another signature of
/// the same block says (0.8.13, ступень 4).
fn proves_the_letter(
    message: &AuthenticatedMessage<'_>,
    raw: &[u8],
    signature: &mail_auth::dkim::Signature,
    addressed: &Addressed,
) -> Result<(), Reason> {
    let mailbox = addressed.mailbox.trim().to_lowercase();
    let covered = covered_instances(message, &signature.h);
    // `mail-auth` takes the bottom-most instance for the first mention of a name in `h=`, and the
    // reader shows that one: the address must stand in that instance, or the letter on screen was
    // addressed to somebody else.
    let mut recipient = None;
    let mut seen: Vec<&'static str> = Vec::new();
    for (name, value) in &covered {
        let Some(kind) = recipient_of(name) else {
            continue;
        };
        if seen.contains(&kind) {
            continue;
        }
        seen.push(kind);
        if addresses_of(name, value)
            .iter()
            .any(|a| a.email.trim().to_lowercase() == mailbox)
        {
            recipient = Some(kind);
            break;
        }
    }
    let kind = recipient.ok_or(Reason::NoRecipientInH)?;
    let shown = crate::message::parse_summary(raw);
    let list = if kind == "cc" { &shown.cc } else { &shown.to };
    if !list.iter().any(|a| a.email.trim().to_lowercase() == mailbox) {
        return Err(Reason::NoRecipientInH);
    }
    let signed_at = if signature.t > 0 {
        signature.t as i64
    } else {
        signed_date(message, raw, signature).ok_or(Reason::Replay)?
    };
    // The times are as the letter and the server wrote them: a `t=` near the end of the range
    // leaves no room for the subtraction, so the two are compared as unsigned.
    let limit = REPLAY_HOURS as u64 * 3600;
    if signed_at.abs_diff(addressed.received) <= limit {
        Ok(())
    } else {
        Err(Reason::Replay)
    }
}

/// `to` or `cc`, as the check names them, when this is the name of a header the address of a
/// mailbox may stand in.
fn recipient_of(name: &str) -> Option<&'static str> {
    if name.trim().eq_ignore_ascii_case("to") {
        Some("to")
    } else if name.trim().eq_ignore_ascii_case("cc") {
        Some("cc")
    } else {
        None
    }
}

/// The `Date` of the letter, when the signature covers the instance of it the reader shows and
/// the two readers read that one date alike: a `Date` nobody signed may be any date at all.
fn signed_date(message: &AuthenticatedMessage<'_>, raw: &[u8], signature: &mail_auth::dkim::Signature) -> Option<i64> {
    // The first mention of `date` in `h=` is the bottom-most instance, the one the reader shows.
    let (_, value) = covered_instances(message, &signature.h)
        .into_iter()
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("date"))?;
    let mut one = Vec::with_capacity(value.len() + 10);
    one.extend_from_slice(b"Date: ");
    one.extend_from_slice(value);
    one.extend_from_slice(b"\r\n\r\n");
    let seen = crate::message::parse_summary(&one).date?;
    (crate::message::parse_summary(raw).date == Some(seen)).then_some(seen)
}

/// The instances of headers a signature with this `h=` covers, as `mail-auth` picks them for its
/// own check: for each name in the list, the bottom-most instance not yet taken for that name, in
/// the order of `h=`. The first mention of a name covers the instance the reader shows.
fn covered_instances<'x, 'h>(message: &'x AuthenticatedMessage<'x>, signed: &'h [String]) -> Vec<(&'h str, &'x [u8])> {
    let mut taken: Vec<(&'h str, usize)> = Vec::with_capacity(signed.len());
    let mut out = Vec::with_capacity(signed.len());
    for name in signed {
        let slot = match taken.iter().position(|(n, _)| n.eq_ignore_ascii_case(name)) {
            Some(slot) => slot,
            None => {
                taken.push((name.as_str(), 0));
                taken.len() - 1
            }
        };
        let skip = taken[slot].1;
        let found = message
            .headers
            .iter()
            .rev()
            .enumerate()
            .skip(skip)
            .find(|(_, (instance, _))| instance.eq_ignore_ascii_case(name.as_bytes()));
        let (next, value) = match found {
            Some((pos, (_, value))) => (pos + 1, Some(*value)),
            None => (message.headers.len(), None),
        };
        taken[slot].1 = next;
        if let Some(value) = value {
            out.push((name.as_str(), value));
        }
    }
    out
}

/// The addresses of one header value, as the reader parses them.
fn addresses_of(name: &str, value: &[u8]) -> Vec<crate::domain::Addr> {
    let mut raw = Vec::with_capacity(value.len() + name.len() + 4);
    raw.extend_from_slice(name.as_bytes());
    raw.extend_from_slice(b": ");
    raw.extend_from_slice(value);
    raw.extend_from_slice(b"\r\n\r\n");
    let summary = crate::message::parse_summary(&raw);
    if name.eq_ignore_ascii_case("cc") {
        summary.cc
    } else {
        summary.to
    }
}

/// A block of original headers of a letter of Exchange without the line the server wrote above
/// them: some servers start `PR_TRANSPORT_MESSAGE_HEADERS` with `Microsoft Mail Internet Headers
/// Version 2.0`, which is no header, and a parser ends the block on it (0.8.13, ступень 4).
pub fn without_preamble(headers: &[u8]) -> &[u8] {
    const LINE: &[u8] = b"Microsoft Mail Internet Headers Version 2.0";
    if headers.len() < LINE.len() || !headers[..LINE.len()].eq_ignore_ascii_case(LINE) {
        return headers;
    }
    let rest = &headers[LINE.len()..];
    rest.strip_prefix(b"\r\n")
        .or_else(|| rest.strip_prefix(b"\n"))
        .unwrap_or(rest)
}

/// What the signature of a letter says about itself, for the log: the domain and the selector
/// of the key, the algorithm, whether the signature has expired, the length of the body it
/// covers, and whether it covers the `From`. Domains and selectors only, never an address of a
/// person (0.8.13, 7.1 Б). With the original headers of Exchange at hand, the signature of the
/// letter is the one kept in them (0.8.13, ступень 4).
pub fn signature_about(raw: &[u8]) -> Option<String> {
    let message = AuthenticatedMessage::parse(without_preamble(raw))?;
    let header = message.dkim_headers.first()?;
    let s = &header.header;
    let now = chrono::Utc::now().timestamp() as u64;
    let expired = s.x != 0 && s.x < now;
    Some(format!(
        "d={},s={},a={},x={},l={},from_in_h={}",
        s.d,
        s.s,
        match s.a {
            Algorithm::RsaSha256 => "rsa-sha256",
            Algorithm::RsaSha1 => "rsa-sha1",
            Algorithm::Ed25519Sha256 => "ed25519-sha256",
        },
        if expired { "expired" } else { "-" },
        if s.l > 0 { s.l.to_string() } else { "-".into() },
        s.h.iter().any(|name| name.trim().eq_ignore_ascii_case("from")),
    ))
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
    use mail_auth::common::crypto::Ed25519Key;
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
    /// The address of the mailbox the letters of these tests came to.
    const MAILBOX: &str = "me@firm.example";

    /// The time a letter is received at, in the tests that sign one now.
    fn now() -> i64 {
        chrono::Utc::now().timestamp()
    }

    /// A signature nobody signed, put above a real one: any block may carry one (0.8.13,
    /// ступень 4).
    fn forged_over(t: i64, signed: &str) -> String {
        format!(
            "DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d=evil.example; s=s1; t={t}; h=from:to; bh=AAAA; b=AAAA\r\n{signed}"
        )
    }

    /// The mailbox a letter came to and when, as the check over the original headers takes it.
    fn addressed(mailbox: &str, received: i64) -> Addressed {
        Addressed {
            mailbox: mailbox.to_owned(),
            received,
        }
    }

    /// The time a letter of the vectors was received at: the `t=` its signature names, or the date
    /// the letter carries when the signature names none. The vectors have no receipt time of their
    /// own, and the check over their headers is measured against the time they were sent.
    fn signed_at(headers: &[u8]) -> i64 {
        AuthenticatedMessage::parse(headers)
            .and_then(|message| {
                message
                    .dkim_headers
                    .iter()
                    .map(|header| header.header.t)
                    .find(|t| *t > 0)
            })
            .map(|t| t as i64)
            .or_else(|| crate::message::parse_summary(headers).date)
            .unwrap_or(0)
    }

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

    /// A signer for the fields a test picks: the `d=`, the `s=` and the headers of `h=`.
    fn signer_of(
        key: Ed25519Key,
        domain: &str,
        selector: &str,
        headers: &[&str],
    ) -> DkimSigner<Ed25519Key, mail_auth::dkim::Done> {
        DkimSigner::from_key(key)
            .domain(domain)
            .selector(selector)
            .headers(headers.iter().map(|h| (*h).to_owned()))
    }

    /// A letter signed by the sender's own key, as any sender signs it (RFC 6376 §3.7).
    fn sign(key: Ed25519Key, domain: &str, letter: &str) -> String {
        sign_with(signer(key, domain), letter)
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
        let signed = sign(key, "1c-bitrix.ru", LETTER);
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
        let signed = sign(k, "openai.com", &letter);
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
        let signed = sign(k, "openai.com", &letter);
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
                Signature::Failed(Reason::StrictPolicy),
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
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        let changed = signed.replace("logo.png", "track.png");
        assert_eq!(
            v.check(changed.as_bytes(), SENDER).await,
            Signature::Failed(Reason::BodyHash)
        );
        let resent = signed.replace("Subject: Hi", "Subject: Pay now");
        assert_eq!(
            v.check(resent.as_bytes(), SENDER).await,
            Signature::Failed(Reason::BadSignature)
        );
        // Signed with another key than the one DNS publishes.
        let forged = sign(keypair().0, "1c-bitrix.ru", LETTER);
        assert_eq!(
            v.check(forged.as_bytes(), SENDER).await,
            Signature::Failed(Reason::BadSignature)
        );
    }

    #[tokio::test]
    async fn a_signature_of_another_organization_asks_no_dns() {
        // Asking for the key of `d=` would tell its owner the letter was read.
        let report = signer_of(keypair().0, "t.tracker.example", "u123", &["From", "To", "Subject"]).reporting(true);
        let signed = sign_with(report, LETTER);
        assert!(signed.contains("r=y"), "{signed}");
        let v = dns([]);
        assert_eq!(offline_verdict(signed.as_bytes(), SENDER), Some(Signature::NotAligned));
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::NotAligned);
        assert_eq!(v.asked(), 0);
        // A look-alike and a name under a private suffix are other organizations too.
        let letter = LETTER.replace("1c-bitrix.ru", "bank.github.io");
        let signed = sign(keypair().0, "evil.github.io", &letter);
        assert_eq!(
            v.check(signed.as_bytes(), "no-reply@bank.github.io").await,
            Signature::NotAligned
        );
        assert_eq!(v.asked(), 0);
        // Next to a signature of the sender, only the sender's key is asked for.
        let (k, record) = keypair();
        let tracker = signer_of(keypair().0, "t.tracker.example", "u123", &["From"]).reporting(true);
        let both = sign_with(signer(k, "1c-bitrix.ru"), &sign_with(tracker, LETTER));
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(v.check(both.as_bytes(), SENDER).await, Signature::Aligned);
        assert!(v.was_asked("s1._domainkey.1c-bitrix.ru."));
        assert_eq!(v.asked(), 1);
    }

    #[tokio::test]
    async fn a_failed_signature_asks_for_no_report_address() {
        let (k, record) = keypair();
        let report = signer_of(k, "1c-bitrix.ru", "s1", &["From", "To", "Subject"]).reporting(true);
        let signed = sign_with(report, LETTER);
        let changed = signed.replace("logo.png", "track.png");
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(
            v.check(changed.as_bytes(), SENDER).await,
            Signature::Failed(Reason::BodyHash)
        );
        assert!(!v.was_asked("_report._domainkey.1c-bitrix.ru."));
    }

    #[tokio::test]
    async fn a_letter_not_from_the_trusted_address_asks_no_dns() {
        let (k, _) = keypair();
        let signed = sign(k, "1c-bitrix.ru", LETTER);
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
            assert_eq!(
                v.check(raw.as_bytes(), SENDER).await,
                Signature::Failed(Reason::LRefused)
            );
        }
        assert_eq!(v.asked(), 0);
    }

    #[tokio::test]
    async fn a_second_from_breaks_the_confirmation() {
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
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
        let below = sign(
            key,
            "gmail.com",
            &format!("{own}Fr om: Friend <friend@gmail.com>\r\n{body}"),
        );
        let (key2, record2) = keypair();
        let no_colon = sign(
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
        let (_, record) = keypair();
        let header = format!(
            "DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d=1c-bitrix.ru; s=s1; h={}; bh=AAAA; b=AAAA\r\n",
            vec!["from"; 300].join(":")
        );
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
        let signed = sign(k, "1c-bitrix.ru", LETTER).replacen("a=ed25519-sha256", "a=rsa-sha1", 1);
        assert!(signed.contains("a=rsa-sha1"), "{signed}");
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(
            offline_verdict(signed.as_bytes(), SENDER),
            Some(Signature::Failed(Reason::Sha1))
        );
        assert_eq!(
            v.check(signed.as_bytes(), SENDER).await,
            Signature::Failed(Reason::Sha1)
        );
        assert_eq!(v.asked(), 0);
    }

    #[tokio::test]
    async fn a_key_in_testing_confirms_nobody() {
        // RFC 6376 §3.6.1: mail signed with a `t=y` key is mail without a signature.
        let (k, record) = keypair();
        let signed = sign(k, "1c-bitrix.ru", LETTER);
        let testing = record.replace("k=ed25519;", "k=ed25519; t=y;");
        let v = verifier("1c-bitrix.ru", &testing);
        assert_eq!(
            v.check(signed.as_bytes(), SENDER).await,
            Signature::Failed(Reason::TestingKey)
        );
        let strict = record.replace("k=ed25519;", "k=ed25519; t=s;");
        let v = verifier("1c-bitrix.ru", &strict);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Aligned);
    }

    #[tokio::test]
    async fn a_third_party_request_asks_no_dns() {
        let (k, record) = keypair();
        let third_party = signer_of(k, "1c-bitrix.ru", "s1", &["From", "To", "Subject"]).atps("tracker.example");
        let signed = sign_with(third_party, LETTER);
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
            let signed = sign_with(signer_of(k, "1c-bitrix.ru", "s1", &headers), LETTER);
            let v = verifier("1c-bitrix.ru", &record);
            assert_eq!(
                v.check(signed.as_bytes(), SENDER).await,
                Signature::Failed(if headers[0] == "To" {
                    Reason::NoFromInH
                } else {
                    Reason::TooManyH
                }),
                "{headers:?}"
            );
            assert_eq!(v.asked(), 0);
        }
    }

    #[tokio::test]
    async fn only_the_first_signatures_are_looked_up() {
        // The sender's own valid signature stands below five of others' keys of its domain.
        let (k, record) = keypair();
        let mut raw = sign(k, "1c-bitrix.ru", LETTER);
        let mut answers = vec![key("1c-bitrix.ru", &record)];
        for i in 0..MAX_SIGNATURES {
            let other = signer_of(
                keypair().0,
                "1c-bitrix.ru",
                &format!("x{i}"),
                &["From", "To", "Subject"],
            );
            raw = sign_with(other, &raw);
            // DNS publishes another key for each of them.
            let txt = Txt::from(DomainKey::parse(keypair().1.as_bytes()).unwrap());
            answers.push((format!("x{i}._domainkey.1c-bitrix.ru."), txt));
        }
        let v = dns(answers);
        assert_eq!(
            v.check(raw.as_bytes(), SENDER).await,
            Signature::Failed(Reason::BadSignature)
        );
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
            let raw = sign(k, "1c-bitrix.ru", &format!("{from}{own}{body}"));
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
        let raw = sign(k, "1c-bitrix.ru", &format!("{from}{own}{body}"));
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
        let signed = sign(k, "1c-bitrix.ru", &letter);
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Aligned);
        let v = Verifier {
            limit: Duration::ZERO,
            ..verifier("1c-bitrix.ru", &record)
        };
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Unchecked);
    }

    #[tokio::test]
    async fn the_check_of_the_headers_stands_without_the_body() {
        // 0.8.13, ступень 4: the signature covers the original headers of the letter; the body
        // Exchange assembled again is not what the sender signed.
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(
            v.check_headers(signed.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Valid
        );
        // The body of the letter does not matter here: the headers are what is signed.
        let changed = signed.replace("logo.png", "track.png");
        assert_eq!(
            v.check_headers(changed.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Valid
        );
        // Changed headers: the signature does not stand.
        let changed = signed.replace("Subject: Hi", "Subject: Pay now");
        assert_eq!(
            v.check_headers(changed.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Rejected(Reason::BadSignature)
        );
        // Another address than the trusted one: the signature is not about it.
        assert_eq!(
            v.check_headers(signed.as_bytes(), "ceo@1c-bitrix.ru", MAILBOX, now())
                .await,
            Headers::Rejected(Reason::BadSignature)
        );
    }

    #[tokio::test]
    async fn another_organization_than_the_from_is_not_a_signature_that_does_not_match() {
        // The signature is of a tracker, not of the sender: the log says so (0.8.13, 7.1 Б).
        let (key, record) = keypair();
        let signed = sign(key, "t.tracker.example", LETTER);
        let v = verifier("t.tracker.example", &record);
        assert_eq!(
            v.check_headers(signed.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Rejected(Reason::NotAligned)
        );
    }

    #[tokio::test]
    async fn a_signature_that_does_not_cover_the_recipients_confirms_nobody() {
        // The address of the mailbox may be added to any letter: the signature must cover the
        // header it stands in, or the check of the recipients is worth nothing.
        let (key, record) = keypair();
        let signed = sign_with(signer_of(key, "1c-bitrix.ru", "s1", &["From", "Subject"]), LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(
            v.check_headers(signed.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Rejected(Reason::NoRecipientInH)
        );
        // Covered: the letter stands.
        let (key, record) = keypair();
        let signed = sign_with(signer_of(key, "1c-bitrix.ru", "s1", &["From", "To", "Subject"]), LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(
            v.check_headers(signed.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Valid
        );
    }

    #[tokio::test]
    async fn the_mailbox_must_stand_in_the_recipient_the_signature_covers() {
        // A signature for another mailbox proves nothing here: no one may add the address of the
        // mailbox to a letter of another time (0.8.13, ступень 4).
        let (key, record) = keypair();
        let other = LETTER.replace("To: me@firm.example", "To: other@firm.example");
        let signed = sign(key, "1c-bitrix.ru", &other);
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(
            v.check_headers(signed.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Rejected(Reason::NoRecipientInH)
        );
        assert_eq!(
            v.check_headers(signed.as_bytes(), SENDER, "other@firm.example", now())
                .await,
            Headers::Valid
        );
    }

    #[tokio::test]
    async fn a_forged_signature_above_a_real_one_says_no_time() {
        // Anyone may put a `DKIM-Signature` above the real one: its `t=` is not the time of the
        // letter, and the signature that passed is the one that answers (0.8.13, ступень 4).
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        let month = 30 * 24 * 3600;
        let received = now() + month;
        // The signature is of a month ago, and the letter came now: a replay.
        assert_eq!(
            v.check_headers(signed.as_bytes(), SENDER, MAILBOX, received).await,
            Headers::Rejected(Reason::Replay)
        );
        // The forged signature above it names the time of receipt: still a replay.
        let forged = forged_over(received, &signed);
        assert_eq!(
            v.check_headers(forged.as_bytes(), SENDER, MAILBOX, received).await,
            Headers::Rejected(Reason::Replay)
        );
        // The same letter without the month in between: confirmed.
        assert_eq!(
            v.check_headers(forged.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Valid
        );
    }

    #[tokio::test]
    async fn a_block_of_original_headers_with_a_preamble_is_read_whole() {
        // Some servers start `PR_TRANSPORT_MESSAGE_HEADERS` with a line that is no header at all:
        // a parser ends the block on it, and the signature of a real letter would be lost.
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let with = format!("Microsoft Mail Internet Headers Version 2.0\r\n{signed}");
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(
            v.check_headers(with.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Valid
        );
    }

    #[test]
    fn the_preamble_of_exchange_is_no_header() {
        let signed = "DKIM-Signature: v=1; b=AAAA\r\nFrom: a@b\r\n\r\nbody\r\n";
        let with = format!("Microsoft Mail Internet Headers Version 2.0\r\n{signed}");
        assert_eq!(without_preamble(with.as_bytes()), signed.as_bytes());
        // A block without the line is left as it is.
        assert_eq!(without_preamble(signed.as_bytes()), signed.as_bytes());
        assert_eq!(without_preamble(b""), b"");
    }

    #[tokio::test]
    async fn an_uneven_block_of_original_headers_is_rejected() {
        // `To : me@...` with a space before the colon: the reader and the check may name that
        // header differently, and a signature may cover an instance nobody shows (0.8.13, 7.1 Б).
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER).replace("To: me@firm.example", "To : me@firm.example");
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(
            v.check_headers(signed.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Rejected(Reason::UnevenHeaders)
        );
    }

    #[tokio::test]
    async fn a_letter_without_a_signature_is_unsigned_in_its_headers_too() {
        let v = dns([]);
        assert_eq!(
            v.check_headers(LETTER.as_bytes(), SENDER, MAILBOX, now()).await,
            Headers::Unsigned
        );
    }

    #[test]
    fn a_date_nobody_signed_is_no_date_at_all() {
        // The `Date` of a letter may be any date: only the one the signature covers, and the
        // reader shows, says when the letter was sent (0.8.13, ступень 4).
        let now = 1_800_000_000;
        let letter = concat!(
            "DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d=1c-bitrix.ru; s=s1; ",
            "h=from:to:subject; bh=AAAA; b=AAAA\r\n",
            "From: Bitrix24 <no-reply@1c-bitrix.ru>\r\nTo: me@firm.example\r\n",
            "Subject: Hi\r\nDate: Mon, 19 Oct 2026 12:00:00 +0300\r\n\r\n"
        );
        // The `Date` is not in the `h=` list: the time of the letter is unknown, and a letter
        // with no time of its own cannot be shown to be this letter.
        let message = AuthenticatedMessage::parse(letter.as_bytes()).unwrap();
        let signature = message.dkim_headers[0].header.clone();
        assert!(signed_date(&message, letter.as_bytes(), &signature).is_none());
        assert_eq!(
            proves_the_letter(&message, letter.as_bytes(), &signature, &addressed(MAILBOX, now)),
            Err(Reason::Replay)
        );
        // The same with the `Date` covered: the date is the time of the letter.
        let dated = letter.replace("h=from:to:subject;", "h=from:to:subject:date;");
        let message = AuthenticatedMessage::parse(dated.as_bytes()).unwrap();
        let signature = message.dkim_headers[0].header.clone();
        let at = signed_date(&message, dated.as_bytes(), &signature).expect("the signed date");
        assert!(at > 0);
        assert_eq!(
            proves_the_letter(&message, dated.as_bytes(), &signature, &addressed(MAILBOX, at)),
            Ok(())
        );
        assert_eq!(
            proves_the_letter(&message, dated.as_bytes(), &signature, &addressed(MAILBOX, now)),
            Err(Reason::Replay)
        );
    }

    #[test]
    fn a_letter_of_another_time_is_not_this_letter() {
        // The address of the mailbox must stand in the signed `To` or `Cc`, and the time of the
        // letter must be close to the time it was received.
        let now = 1_800_000_000;
        let letter = format!(
            "DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d=1c-bitrix.ru; s=s1; t={now}; h=from:to:subject; bh=AAAA; b=AAAA\r\nFrom: Bitrix24 <no-reply@1c-bitrix.ru>\r\nTo: me@firm.example\r\nSubject: Hi\r\nDate: Mon, 19 Oct 2026 12:00:00 +0300\r\n\r\n"
        );
        let message = AuthenticatedMessage::parse(letter.as_bytes()).unwrap();
        let signature = message.dkim_headers[0].header.clone();
        let verdict = |mailbox: &str, received: i64| {
            proves_the_letter(&message, letter.as_bytes(), &signature, &addressed(mailbox, received))
        };
        assert_eq!(verdict(MAILBOX, now - 3600), Ok(()));
        // Another mailbox: the letter was not addressed to it.
        assert_eq!(verdict("other@firm.example", now - 3600), Err(Reason::NoRecipientInH));
        // A letter of another time: the signature of a letter sent long ago proves nothing.
        assert_eq!(verdict(MAILBOX, now + 30 * 24 * 3600), Err(Reason::Replay));
    }

    #[test]
    fn a_letter_of_another_time_is_not_this_letter_even_at_the_edges_of_the_clock() {
        // `t=` near the end of the range: the difference of two such times has no room in an
        // `i64`, and the letter is no letter of now either way.
        let last = i64::MAX;
        let letter = format!(
            "DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d=1c-bitrix.ru; s=s1; t={last}; h=from:to:subject; bh=AAAA; b=AAAA\r\nFrom: Bitrix24 <no-reply@1c-bitrix.ru>\r\nTo: me@firm.example\r\nSubject: Hi\r\n\r\n"
        );
        let message = AuthenticatedMessage::parse(letter.as_bytes()).unwrap();
        let signature = message.dkim_headers[0].header.clone();
        for received in [i64::MIN, -1, 0] {
            assert_eq!(
                proves_the_letter(&message, letter.as_bytes(), &signature, &addressed(MAILBOX, received)),
                Err(Reason::Replay)
            );
        }
    }

    #[tokio::test]
    async fn a_published_key_confirms_the_letter() {
        // The e2e build publishes the key of the stand's letter: the check asks the name and the
        // answer is there.
        let (key, record) = keypair();
        let signed = sign(key, "1c-bitrix.ru", LETTER);
        let v = verifier("1c-bitrix.ru", &record);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Aligned);
        // A verifier with an empty cache asks the name servers and gets nothing.
        let v = dns([]);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Unchecked);
        // The published answer reaches the check.
        let v = dns([]);
        assert!(v.add_answer("s1._domainkey.1c-bitrix.ru.", &record));
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Aligned);
    }

    #[tokio::test]
    async fn without_the_network_the_signature_is_unchecked_not_confirmed() {
        let signed = sign(keypair().0, "1c-bitrix.ru", LETTER);
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
        let signed = sign(keypair().0, "1c-bitrix.ru", LETTER);
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
        let signed = sign(key, "1c-bitrix.ru", LETTER);
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

    /// A letter of the vectors of `mail-auth` and the DNS records its signature needs: the
    /// records first, a blank line, then the letter (`tests/dkim-vectors`, Apache-2.0 or MIT).
    fn vector(name: &str) -> (Vec<(String, Txt)>, Vec<u8>) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/dkim-vectors")
            .join(name);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        // A checkout may give the file CRLF line endings where the letter was written with LF:
        // the signature covers the bytes the sender wrote, so they are put back as they are.
        let text = text.replace("\r\n", "\n");
        let (records, letter) = text
            .split_once("\n\n")
            .unwrap_or_else(|| panic!("{name}: the records and the letter"));
        let answers = records
            .lines()
            .filter_map(|line| line.split_once(' '))
            .map(|(name, value)| {
                let key = DomainKey::parse(value.as_bytes()).unwrap_or_else(|e| panic!("{name}: {e}"));
                (format!("{name}."), Txt::from(key))
            })
            .collect();
        (answers, letter.as_bytes().to_vec())
    }

    #[tokio::test]
    async fn real_signatures_of_the_internet_pass_the_own_check() {
        // RFC 8463, RFC 6376, ietf.org, github.com, facebookmail.com: the signatures were made by
        // other programs, byte for byte as their senders wrote them.
        for (name, want) in [
            ("001.txt", Signature::Aligned),
            // The same letter with its `Received` line written again: the signature covers the
            // one the sender's server added, and `c=simple` leaves no room for another.
            ("002.txt", Signature::Failed(Reason::BadSignature)),
            // A signature of ietf.org for a letter of jck.com: another organization.
            ("003.txt", Signature::NotAligned),
            ("004.txt", Signature::Aligned),
            // Its `x=` has passed: the letter stands no more (RFC 6376 §3.5).
            ("005.txt", Signature::Failed(Reason::Expired)),
            ("006.txt", Signature::Aligned),
        ] {
            let (answers, letter) = vector(name);
            let from = shown(std::str::from_utf8(&letter).unwrap());
            assert_eq!(dns(answers).check(&letter, &from).await, want, "{name}: {from}");
        }
    }

    #[tokio::test]
    async fn real_signatures_pass_the_check_of_the_headers_alone() {
        // The same vectors with the body cut off (0.8.13, ступень 4): the signature covers the
        // headers, and the body hash is not compared with a body nobody signed.
        for (name, mailbox, want) in [
            ("001.txt", "suzie@shopping.example.net", Headers::Valid),
            (
                "002.txt",
                "suzie@shopping.example.net",
                Headers::Rejected(Reason::BadSignature),
            ),
            ("003.txt", "emailcore@ietf.org", Headers::Rejected(Reason::NotAligned)),
            ("004.txt", "mauro@minter.ltd", Headers::Valid),
            ("006.txt", "mauro@stalw.art", Headers::Valid),
        ] {
            let (answers, letter) = vector(name);
            let raw = String::from_utf8(letter).unwrap();
            let headers = &raw[..header_end(raw.as_bytes())];
            let from = shown(&raw);
            assert_eq!(
                dns(answers)
                    .check_headers(headers.as_bytes(), &from, mailbox, signed_at(headers.as_bytes()))
                    .await,
                want,
                "{name}: {from} in {mailbox}"
            );
        }
    }

    #[tokio::test]
    async fn the_auid_may_be_a_name_below_the_domain() {
        // RFC 6376 §3.5: `i=` is the `d=` itself or a name below it.
        let (k, record) = keypair();
        let signed = sign_with(
            signer(k, "1c-bitrix.ru").agent_user_identifier("post@mail.1c-bitrix.ru"),
            LETTER,
        );
        assert!(signed.contains("i=post@mail.1c-bitrix.ru"), "{signed}");
        assert_eq!(
            verifier("1c-bitrix.ru", &record).check(signed.as_bytes(), SENDER).await,
            Signature::Aligned
        );
        // A name the `d=` merely ends with is another domain.
        let (k, record) = keypair();
        let signed = sign_with(
            signer(k, "1c-bitrix.ru").agent_user_identifier("post@evil1c-bitrix.ru"),
            LETTER,
        );
        assert_eq!(
            verifier("1c-bitrix.ru", &record).check(signed.as_bytes(), SENDER).await,
            Signature::Failed(Reason::Auid)
        );
    }

    #[tokio::test]
    async fn a_signature_that_expired_before_it_was_made_is_no_signature() {
        // RFC 6376 §3.5: `x=` must be later than `t=`.
        let (k, record) = keypair();
        let signed = sign(k, "1c-bitrix.ru", LETTER);
        let future = chrono::Utc::now().timestamp() as u64 + 3600;
        // The signature is genuine, and the two tags are swapped in its text: only the tags say
        // when it stands, and the check reads them before any lookup.
        let forged = signed.replacen("; t=", &format!("; x={}; t=", future - 7200), 1);
        assert!(forged.contains("x="), "{forged}");
        assert_eq!(
            verifier("1c-bitrix.ru", &record).check(forged.as_bytes(), SENDER).await,
            Signature::Failed(Reason::Expired)
        );
    }

    #[tokio::test]
    async fn a_key_that_is_gone_is_not_a_key_that_did_not_answer() {
        // A record that is not there is a verdict; no answer at all is none, and the check is
        // worth repeating.
        let (k, _) = keypair();
        let signed = sign(k, "1c-bitrix.ru", LETTER);
        let name = "s1._domainkey.1c-bitrix.ru.".to_owned();
        let missing = DnsError::RecordNotFound(ResponseCode::NXDomain);
        let v = dns([(name.clone(), Txt::Error(mail_auth::Error::Dns(missing)))]);
        assert_eq!(
            v.check(signed.as_bytes(), SENDER).await,
            Signature::Failed(Reason::NoKey)
        );
        // Revoked: the record is there and its key is gone.
        let revoked = mail_auth::Error::Dkim(mail_auth::dkim::DkimError::RevokedPublicKey);
        let v = dns([(name, Txt::Error(revoked))]);
        assert_eq!(
            v.check(signed.as_bytes(), SENDER).await,
            Signature::Failed(Reason::NoKey)
        );
        // No name server answered: nothing is known.
        let v = dns([]);
        assert_eq!(v.check(signed.as_bytes(), SENDER).await, Signature::Unchecked);
    }

    #[tokio::test]
    async fn the_headers_check_wants_from_in_the_signed_list() {
        // A signature that does not cover From is no confirmation of who wrote the letter, even
        // over the headers alone (0.8.13, ступень 4).
        let (key, record) = keypair();
        let signed = sign_with(signer_of(key, "1c-bitrix.ru", "s1", &["To", "Subject"]), LETTER);
        assert_eq!(
            verifier("1c-bitrix.ru", &record)
                .check_headers(signed.as_bytes(), SENDER, MAILBOX, now())
                .await,
            Headers::Rejected(Reason::NoFromInH)
        );
    }

    #[test]
    fn the_recipients_are_the_instances_the_signature_covers() {
        // `mail-auth` takes the bottom-most instance for the first mention of a name in `h=`, and
        // the reader shows that one: a higher `To` may carry the address of the mailbox without
        // the letter being meant for it (0.8.13, ступень 4).
        let now = 1_800_000_000;
        let letter = format!(
            "DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d=1c-bitrix.ru; s=s1; t={now}; h=from:to:to:subject; bh=AAAA; b=AAAA\r\nFrom: Bitrix24 <no-reply@1c-bitrix.ru>\r\nTo: me@firm.example\r\nTo: other@firm.example\r\nSubject: Hi\r\n\r\n"
        );
        let message = AuthenticatedMessage::parse(letter.as_bytes()).unwrap();
        let signature = message.dkim_headers[0].header.clone();
        let tos: Vec<String> = covered_instances(&message, &signature.h)
            .into_iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("to"))
            .map(|(_, value)| String::from_utf8_lossy(value).trim().to_owned())
            .collect();
        assert_eq!(tos, ["other@firm.example".to_owned(), "me@firm.example".to_owned()]);
        // The address of the mailbox stands in the instance nobody shows: no letter for it.
        assert_eq!(
            proves_the_letter(&message, letter.as_bytes(), &signature, &addressed(MAILBOX, now)),
            Err(Reason::NoRecipientInH)
        );
        // The same block with the mailbox in the `To` both of them read.
        let mine = letter.replace("To: other@firm.example", "To: me@firm.example");
        let message = AuthenticatedMessage::parse(mine.as_bytes()).unwrap();
        let signature = message.dkim_headers[0].header.clone();
        assert_eq!(
            proves_the_letter(&message, mine.as_bytes(), &signature, &addressed(MAILBOX, now)),
            Ok(())
        );
    }
}
