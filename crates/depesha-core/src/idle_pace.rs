//! The pace of the inbox subscription (IMAP IDLE): how often to renew it and how long to
//! wait before reconnecting. RFC 2177 asks for a renewal at least every 29 minutes, but a
//! proxy, a firewall or a corporate server may cut an idle connection far sooner (a
//! reported Exchange 2019 does it every ~20 seconds). A cut shows up as a dropped
//! connection, never as a timeout of ours: the silence watchdog stands down during IDLE.
//! The pace learns from the cuts: renew IDLE well inside the observed lifetime (the DONE and
//! the new IDLE are traffic, which resets such an idle timer) and back off while
//! connections keep breaking at once.

use std::time::Duration;

use crate::imap::IDLE_RENEW;

/// The first pause after a drop; doubles while drops follow each other.
const PAUSE: Duration = Duration::from_secs(5);
const PAUSE_MAX: Duration = Duration::from_secs(120);
/// A connection that lived this long before it dropped counts as healthy.
const HEALTHY: Duration = Duration::from_secs(5 * 60);
/// A drop sooner than this after the start is not a timeout of an idle link
/// (refused at once, a proxy cutting long answers): it only backs the pause off.
const TOO_SOON: Duration = Duration::from_secs(10);
/// The shortest renewal: below this IDLE would turn into polling.
const RENEW_MIN: Duration = Duration::from_secs(10);
/// Renewals in a row that survived before the learned interval is tried longer again.
const PROBE_AFTER: u32 = 20;

#[derive(Debug)]
pub struct IdlePace {
    renew: Duration,
    /// Drops in a row without a healthy connection between them.
    drops: u32,
    survived: u32,
}

/// What to do after a drop.
#[derive(Debug, PartialEq, Eq)]
pub struct Dropped {
    pub pause: Duration,
    /// Drops in a row, this one included.
    pub drops: u32,
    /// Whether this drop is worth a line in the log: the first of a series and then
    /// every power of two, so a link that breaks all day does not fill the log.
    pub log: bool,
    /// The renewal was shortened by this drop.
    pub shortened: bool,
}

impl IdlePace {
    pub fn new() -> Self {
        Self {
            renew: IDLE_RENEW,
            drops: 0,
            survived: 0,
        }
    }

    /// How long to hold one IDLE before renewing it.
    pub fn renew(&self) -> Duration {
        self.renew
    }

    /// A renewal went through with the connection alive.
    pub fn renewed(&mut self) {
        self.survived += 1;
        self.drops = 0;
        if self.survived >= PROBE_AFTER && self.renew < IDLE_RENEW {
            self.survived = 0;
            self.renew = (self.renew * 2).min(IDLE_RENEW);
        }
    }

    /// The connection broke `lived` after the start of the wait that failed.
    pub fn dropped(&mut self, lived: Duration) -> Dropped {
        self.survived = 0;
        if lived >= HEALTHY {
            self.drops = 0;
        }
        self.drops += 1;
        let mut shortened = false;
        if (TOO_SOON..self.renew).contains(&lived) {
            self.renew = (lived * 2 / 3).max(RENEW_MIN);
            shortened = true;
        }
        let pause = PAUSE.saturating_mul(1 << (self.drops - 1).min(5)).min(PAUSE_MAX);
        Dropped {
            pause,
            drops: self.drops,
            log: self.drops.is_power_of_two(),
            shortened,
        }
    }
}

impl Default for IdlePace {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn s(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn a_fresh_pace_renews_inside_the_rfc_limit() {
        assert!(IdlePace::new().renew() <= s(29 * 60));
    }

    #[test]
    fn a_link_cut_every_twenty_seconds_gets_a_renewal_inside_that_time() {
        let mut p = IdlePace::new();
        let d = p.dropped(s(20));
        assert!(d.shortened);
        assert!(p.renew() < s(20) && p.renew() >= RENEW_MIN, "{:?}", p.renew());
    }

    #[test]
    fn drops_in_a_row_back_the_pause_off_and_are_logged_rarely() {
        let mut p = IdlePace::new();
        let drops: Vec<_> = (0..9).map(|_| p.dropped(s(1))).collect();
        assert_eq!(drops[0].pause, s(5));
        assert_eq!(drops[1].pause, s(10));
        assert_eq!(drops[2].pause, s(20));
        assert_eq!(drops[8].pause, PAUSE_MAX);
        let logged: Vec<_> = drops.iter().filter(|d| d.log).map(|d| d.drops).collect();
        assert_eq!(logged, [1, 2, 4, 8]);
        assert_eq!(p.renew(), IDLE_RENEW, "an instant drop says nothing about idle time");
    }

    #[test]
    fn a_healthy_connection_ends_the_series() {
        let mut p = IdlePace::new();
        p.dropped(s(1));
        p.dropped(s(1));
        let d = p.dropped(s(20 * 60));
        assert_eq!((d.drops, d.pause), (1, PAUSE));
        assert!(d.log);
    }

    #[test]
    fn a_renewal_that_went_through_ends_the_series() {
        let mut p = IdlePace::new();
        p.dropped(s(1));
        p.renewed();
        assert_eq!(p.dropped(s(1)).pause, PAUSE);
    }

    #[test]
    fn the_renewal_is_never_shorter_than_the_floor() {
        let mut p = IdlePace::new();
        p.dropped(s(12));
        assert_eq!(p.renew(), RENEW_MIN);
    }

    #[test]
    fn a_long_run_without_cuts_tries_a_longer_renewal() {
        let mut p = IdlePace::new();
        p.dropped(s(30));
        let short = p.renew();
        for _ in 0..PROBE_AFTER {
            p.renewed();
        }
        assert_eq!(p.renew(), short * 2);
    }
}
