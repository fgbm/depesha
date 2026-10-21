//! The ladder of evidence for a letter's sender (0.8.13): one rule in one place.
//!
//! The rule: whoever saw the letter whole decides. The mailbox's server — where it checked the
//! sender on the original bytes. The app itself — where the server stayed silent and the
//! original bytes are at hand. The server's verdict about a signature it verified is as good as
//! its DMARC verdict: it hashed the body on arrival, which the app cannot do better later.
//!
//! The steps, from the strongest to the weakest:
//!
//! 1. The server of the mailbox wrote `dmarc=pass` for the From domain: pictures and a logo.
//! 2. The same server wrote a passed `dkim=` or `spf=` for the From domain without a DMARC
//!    result: pictures and a logo. The app's own check is not needed and is not run.
//! 3. The server stayed silent and the original bytes are at hand: the app's own full DKIM
//!    check: pictures and a logo.
//! 4. Exchange of the firm's own over EWS: the app's own check of the signature against the
//!    original headers of the letter (`PR_TRANSPORT_MESSAGE_HEADERS`), without the body hash:
//!    pictures only.
//! 5. Nothing confirmed the sender: no pictures.
//!
//! One more case: a letter of a colleague of the same organization, which Exchange says so
//! itself (`AuthAs: Internal`): pictures, but no logo — the organization vouches for the
//! sender, not for its brand.

use crate::avatar::SenderCheck;

/// How the sender was confirmed, or why not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The server of the mailbox wrote `dmarc=pass` for the From domain.
    ServerDmarc,
    /// The server of the mailbox wrote a passed `dkim=` or `spf=` for the From domain and no
    /// DMARC result of its own.
    ServerSignature,
    /// The app's own full DKIM check, on the original bytes of the letter.
    OwnFull,
    /// The app's own check of the signature against the original headers of the letter, without
    /// the body hash (Exchange of the firm's own over EWS).
    OwnHeaders,
    /// A colleague of the same organization, which the server of the mailbox says so.
    Internal,
    /// Nothing confirmed the sender.
    None,
    /// The mailbox's setting trusts the sender by address alone, where nothing could be checked.
    AddressOnly,
}

impl Step {
    /// The step as the log names it: a number of the ladder, or a word.
    pub fn code(self) -> &'static str {
        match self {
            Self::ServerDmarc => "1",
            Self::ServerSignature => "2",
            Self::OwnFull => "3",
            Self::OwnHeaders => "4",
            Self::Internal => "internal",
            Self::None => "-",
            Self::AddressOnly => "address",
        }
    }

    /// Whether the step is strong enough for a brand logo: the logo is a sign of authenticity,
    /// so it needs a step that checked the body as well.
    pub fn shows_logo(self) -> bool {
        matches!(self, Self::ServerDmarc | Self::ServerSignature | Self::OwnFull)
    }
}

/// What the ladder decided about a letter's sender.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// The step of the ladder that decided.
    pub step: Step,
    /// The sender is confirmed: the letter's pictures may be shown.
    pub confirmed: bool,
    /// The letter has a brand logo to show.
    pub logo: bool,
    /// Why not, when nothing confirmed the sender: the reason for the line over the letter.
    pub reason: Reason,
}

/// Why nothing confirmed the sender.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The server of the mailbox said no: it checked the sender and the check failed.
    Server,
    /// The server stayed silent and the letter carries no signature.
    Unsigned,
    /// The server stayed silent and the signature does not confirm the From address.
    Signature,
    /// The server stayed silent and DNS did not answer for the signature's key.
    Unchecked,
    /// The letter's From is not the one trusted address alone, as both readers of its headers
    /// see it: a second From, or a header one of them reads and the other does not.
    AmbiguousFrom,
    /// The server stayed silent, the app's own check is still to be made.
    Checking,
    /// The mailbox's server cannot be asked and the app's own check has no way in.
    NoCheck,
    /// The mailbox's setting trusts the sender by address alone.
    AddressOnly,
}

/// What the server of the mailbox said about the sender, and what the app's own check said.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Evidence {
    /// The server's own answer about the From domain.
    pub server: Option<SenderCheck>,
    /// The app's own full DKIM check of the letter; `None` while it is still to be made.
    pub own_full: Option<crate::dkim::Signature>,
    /// The app's own check of the signature against the original headers of the letter; `None`
    /// while it is still to be made.
    pub own_headers: Option<crate::dkim::Headers>,
    /// The app's own check is still to be made: the window asks for it.
    pub own_due: bool,
    /// The letter's From is the one trusted address alone, as both readers of its headers see it.
    pub sole_from: bool,
    /// The server of the mailbox says the sender signed in to the same organization.
    pub internal: bool,
    /// The block of headers of the letter is uneven: the server and the app may read it
    /// differently, and the server's word about the sender is not taken (0.8.13, 7.1 Б).
    pub uneven_headers: bool,
    /// The mailbox's setting: trust the sender by address where nothing could be checked.
    pub by_address: bool,
}

/// The ladder: one rule, one place. `evidence` says what each party found, this says what it
/// means.
pub fn decide(evidence: &Evidence) -> Verdict {
    let verdict = weigh(evidence);
    // The mailbox's setting trusts the sender by address where nothing could be learned about
    // the sender at all: the letter carries no signature, or the key could not be asked for.
    // An explicit «no» of the server is not overridden (0.8.13, 6.1 Б).
    if evidence.by_address && matches!(verdict.reason, Reason::Unsigned | Reason::Unchecked) {
        return Verdict {
            step: Step::AddressOnly,
            confirmed: true,
            logo: false,
            reason: Reason::AddressOnly,
        };
    }
    verdict
}

/// The ladder without the mailbox's setting.
fn weigh(evidence: &Evidence) -> Verdict {
    if !evidence.sole_from {
        return no(Reason::AmbiguousFrom);
    }
    // An uneven block of headers is read one way by the server and another by the app: its word
    // about the sender is not taken, and the app checks the signature itself (0.8.13, 7.1 Б).
    let server = evidence.server.as_ref().filter(|_| !evidence.uneven_headers);
    // The server's «no» stays a «no»: its own check of the sender failed. A server that said
    // nothing at all is not a «no»: the app's own check stands then.
    if let Some(check) = server
        && !check.passed()
        && !check.no_verdict()
    {
        return no(Reason::Server);
    }
    if let Some(check) = server
        && check.passed()
    {
        // `dmarc=pass` aligned with the From domain, or a passed signature of the same
        // organization without a DMARC result: the server checked the sender on the original
        // bytes, and its word is enough.
        let step = if check.dmarc_passed() {
            Step::ServerDmarc
        } else {
            Step::ServerSignature
        };
        return Verdict {
            step,
            confirmed: true,
            logo: true,
            reason: Reason::Server,
        };
    }
    // A colleague of the same organization: the server of the mailbox says so itself.
    if evidence.internal && !evidence.uneven_headers {
        return Verdict {
            step: Step::Internal,
            confirmed: true,
            logo: false,
            reason: Reason::Server,
        };
    }
    // The server said nothing usable: the app's own check decides.
    if let Some(signature) = evidence.own_full {
        return match signature {
            crate::dkim::Signature::Aligned => Verdict {
                step: Step::OwnFull,
                confirmed: true,
                logo: true,
                reason: Reason::Server,
            },
            crate::dkim::Signature::Unsigned => no(Reason::Unsigned),
            crate::dkim::Signature::Unchecked => no(Reason::Unchecked),
            crate::dkim::Signature::NotAligned | crate::dkim::Signature::Invalid => no(Reason::Signature),
            crate::dkim::Signature::Failed(_) => no(Reason::Signature),
        };
    }
    // The original headers of the letter, without its body: the signature covers the From, the
    // subject and the date, but not the body. Pictures only, and no logo.
    if let Some(headers) = evidence.own_headers {
        return match headers {
            crate::dkim::Headers::Valid => Verdict {
                step: Step::OwnHeaders,
                confirmed: true,
                logo: false,
                reason: Reason::Server,
            },
            crate::dkim::Headers::Unsigned => no(Reason::Unsigned),
            crate::dkim::Headers::Unchecked => no(Reason::Unchecked),
            crate::dkim::Headers::Rejected(_) => no(Reason::Signature),
        };
    }
    // The app's own check is still to be made: the window asks for it.
    if evidence.own_due {
        return no(Reason::Checking);
    }
    // Nothing could be checked: the server does not tell, and the app has no way in.
    no(Reason::NoCheck)
}

/// Nothing confirmed the sender.
fn no(reason: Reason) -> Verdict {
    Verdict {
        step: Step::None,
        confirmed: false,
        logo: false,
        reason,
    }
}

/// What the app's own check of the whole letter may say for a letter whose original headers are
/// at hand (0.8.13, ступень 4): nothing.
///
/// Exchange in the firm's own network assembles the letter again from its own store, so the bytes
/// the check hashed are not the ones the sender signed. Its verdict about them would close the
/// ladder — a letter assembled again carries no signature at all — before the check of the
/// signature over the original headers. The body is left out, and the headers decide.
pub fn body_check(
    known: Option<crate::dkim::Signature>,
    offline: Option<crate::dkim::Signature>,
    headers_at_hand: bool,
) -> Option<crate::dkim::Signature> {
    if headers_at_hand { None } else { known.or(offline) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dkim::Signature;

    fn evidence(server: Option<SenderCheck>) -> Evidence {
        Evidence {
            server,
            sole_from: true,
            ..Default::default()
        }
    }

    #[test]
    fn the_server_dmarc_decides_alone() {
        let mut e = evidence(Some(SenderCheck::Passed));
        let v = decide(&e);
        assert_eq!(v.step, Step::ServerDmarc);
        assert!(v.confirmed && v.logo);
        // The app's own check is not even asked for.
        e.own_full = Some(Signature::Invalid);
        assert_eq!(decide(&e).step, Step::ServerDmarc);
    }

    #[test]
    fn a_passed_signature_of_the_server_decides_alone() {
        // 2.1 Б: the server hashed the body on arrival; the app's own check is not needed.
        let mut e = evidence(Some(SenderCheck::AlignedWithoutDmarc { via: "dkim" }));
        let v = decide(&e);
        assert_eq!(v.step, Step::ServerSignature);
        assert!(v.confirmed && v.logo);
        e.own_full = Some(Signature::Invalid);
        assert_eq!(decide(&e).step, Step::ServerSignature);
    }

    #[test]
    fn the_servers_no_stays_a_no() {
        let e = evidence(Some(SenderCheck::DmarcNot("fail".into())));
        let v = decide(&e);
        assert!(!v.confirmed && !v.logo);
        assert_eq!(v.reason, Reason::Server);
    }

    #[test]
    fn a_second_from_confirms_nobody() {
        let mut e = evidence(Some(SenderCheck::Passed));
        e.sole_from = false;
        let v = decide(&e);
        assert!(!v.confirmed);
        assert_eq!(v.reason, Reason::AmbiguousFrom);
    }

    #[test]
    fn the_own_check_decides_where_the_server_stayed_silent() {
        let mut e = evidence(Some(SenderCheck::NoOwnHeader {
            seen: vec![],
            receiver: vec![],
            delivery: None,
        }));
        e.own_full = Some(Signature::Aligned);
        let v = decide(&e);
        assert_eq!(v.step, Step::OwnFull);
        assert!(v.confirmed && v.logo);
    }

    #[test]
    fn the_headers_step_gives_pictures_but_no_logo() {
        let mut e = evidence(None);
        e.own_headers = Some(crate::dkim::Headers::Valid);
        let v = decide(&e);
        assert_eq!(v.step, Step::OwnHeaders);
        assert!(v.confirmed);
        assert!(!v.logo);
    }

    #[test]
    fn a_colleague_is_confirmed_without_a_logo() {
        let mut e = evidence(None);
        e.internal = true;
        let v = decide(&e);
        assert_eq!(v.step, Step::Internal);
        assert!(v.confirmed);
        assert!(!v.logo);
    }

    #[test]
    fn the_check_yet_to_be_made_asks_for_it() {
        let mut e = evidence(None);
        e.own_due = true;
        assert_eq!(decide(&e).reason, Reason::Checking);
    }

    #[test]
    fn nothing_to_check_is_no_check() {
        let e = evidence(None);
        assert_eq!(decide(&e).reason, Reason::NoCheck);
    }

    #[test]
    fn the_switch_by_address_says_so() {
        // 0.8.13, 6.1 Б: the switch trusts the address where nothing could be checked.
        let mut e = evidence(None);
        e.own_full = Some(crate::dkim::Signature::Unsigned);
        e.by_address = true;
        let v = decide(&e);
        assert_eq!(v.step, Step::AddressOnly);
        assert!(v.confirmed);
        assert!(!v.logo, "the switch never gives a logo");
        assert_eq!(v.reason, Reason::AddressOnly);
    }

    #[test]
    fn the_switch_by_address_does_not_override_the_servers_no() {
        let mut e = evidence(Some(SenderCheck::DmarcNot("fail".into())));
        e.by_address = true;
        let v = decide(&e);
        assert!(!v.confirmed);
        assert_eq!(v.reason, Reason::Server);
    }

    #[test]
    fn the_switch_by_address_does_not_override_a_signature_that_does_not_fit() {
        // The signature is there and is not about the From: the address is not the answer.
        let mut e = evidence(None);
        e.own_full = Some(crate::dkim::Signature::NotAligned);
        e.by_address = true;
        let v = decide(&e);
        assert!(!v.confirmed);
        assert_eq!(v.reason, Reason::Signature);
    }

    #[test]
    fn an_uneven_block_of_headers_takes_no_word_from_the_server() {
        // 0.8.13, 7.1 Б: the server and the app may part on where the headers end, and its word
        // about the sender is not taken then. The app checks the signature itself.
        let mut e = evidence(Some(SenderCheck::Passed));
        e.uneven_headers = true;
        e.own_due = true;
        assert_eq!(decide(&e).reason, Reason::Checking);
        // A colleague of the organization is the server's word too.
        let mut e = evidence(None);
        e.uneven_headers = true;
        e.internal = true;
        assert!(!decide(&e).confirmed);
        // And a «no» of the server neither confirms nor is it overruled: nothing is known.
        let mut e = evidence(Some(SenderCheck::DmarcNot("fail".into())));
        e.uneven_headers = true;
        assert!(!decide(&e).confirmed);
    }

    #[test]
    fn the_original_headers_of_exchange_leave_the_body_out() {
        // 0.8.13, ступень 4: the body of the letter Exchange assembled again is not the one the
        // sender signed, so the check over it says nothing — not even that the letter is unsigned.
        let known = Some(Signature::Aligned);
        assert_eq!(body_check(known, None, true), None);
        assert_eq!(body_check(None, Some(Signature::Unsigned), true), None);
        // Without the original headers the body is all there is to check.
        assert_eq!(body_check(known, None, false), known);
        assert_eq!(
            body_check(None, Some(Signature::Unsigned), false),
            Some(Signature::Unsigned)
        );
    }
}
