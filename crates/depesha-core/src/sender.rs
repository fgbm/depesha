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
    /// Nothing confirmed the sender.
    None,
    /// The mailbox's setting trusts the sender by address alone, where nothing could be checked.
    AddressOnly,
}

impl Step {
    /// The step as the log names it: a number of the ladder, or `address`.
    pub fn code(self) -> &'static str {
        match self {
            Self::ServerDmarc => "1",
            Self::ServerSignature => "2",
            Self::OwnFull => "3",
            Self::OwnHeaders => "4",
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
    /// The step that decided.
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
    /// The mailbox's server cannot be asked and the app's own check has no way in.
    NoCheck,
    /// The mailbox's setting trusts the sender by address alone.
    AddressOnly,
}

/// What the server of the mailbox said about the sender, and what the app's own check said.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Evidence {
    /// The server's own answer about the From domain.
    pub server: Option<SenderCheck>,
    /// The app's own full DKIM check of the letter.
    pub own_full: Option<crate::dkim::Signature>,
    /// The app's own check of the signature against the original headers of the letter.
    pub own_headers: Option<crate::dkim::Headers>,
    /// The letter's From is the one trusted address alone, as both readers of its headers see it.
    pub sole_from: bool,
    /// The mailbox's setting: trust the sender by address where nothing could be checked.
    pub by_address: bool,
}

/// The ladder: one rule, one place. `evidence` says what each party found, this says what it
/// means.
pub fn decide(evidence: &Evidence) -> Verdict {
    if !evidence.sole_from {
        return Verdict {
            step: Step::None,
            confirmed: false,
            logo: false,
            reason: Reason::AmbiguousFrom,
        };
    }
    // The server's «no» stays a «no»: its own check of the sender failed.
    if let Some(check) = &evidence.server
        && !check.passed()
    {
        return Verdict {
            step: Step::None,
            confirmed: false,
            logo: false,
            reason: Reason::Server,
        };
    }
    if let Some(check) = &evidence.server {
        // `dmarc=pass` aligned with the From domain, or a passed signature of the same
        // organization without a DMARC result: the server checked the sender on the original
        // bytes, and its word is enough.
        if check.passed() {
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
            crate::dkim::Signature::Unsigned => Verdict {
                step: Step::None,
                confirmed: false,
                logo: false,
                reason: Reason::Unsigned,
            },
            crate::dkim::Signature::Unchecked => Verdict {
                step: Step::None,
                confirmed: false,
                logo: false,
                reason: Reason::Unchecked,
            },
            crate::dkim::Signature::NotAligned | crate::dkim::Signature::Invalid => Verdict {
                step: Step::None,
                confirmed: false,
                logo: false,
                reason: Reason::Signature,
            },
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
            crate::dkim::Headers::Unsigned => Verdict {
                step: Step::None,
                confirmed: false,
                logo: false,
                reason: Reason::Unsigned,
            },
            crate::dkim::Headers::Unchecked => Verdict {
                step: Step::None,
                confirmed: false,
                logo: false,
                reason: Reason::Unchecked,
            },
            crate::dkim::Headers::Rejected => Verdict {
                step: Step::None,
                confirmed: false,
                logo: false,
                reason: Reason::Signature,
            },
        };
    }
    // Nothing could be checked: the mailbox's setting may still trust the address.
    if evidence.by_address {
        return Verdict {
            step: Step::AddressOnly,
            confirmed: true,
            logo: false,
            reason: Reason::AddressOnly,
        };
    }
    Verdict {
        step: Step::None,
        confirmed: false,
        logo: false,
        reason: Reason::NoCheck,
    }
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
        let mut e = evidence(Some(SenderCheck::NoOwnHeader { seen: vec![], receiver: vec![], delivery: None }));
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
    fn the_switch_by_address_says_so() {
        let mut e = evidence(None);
        e.by_address = true;
        let v = decide(&e);
        assert_eq!(v.step, Step::AddressOnly);
        assert!(v.confirmed);
        assert!(!v.logo);
        assert_eq!(v.reason, Reason::AddressOnly);
    }
}
