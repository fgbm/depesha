//! The pace of the inbox subscription (IMAP IDLE): how often to renew it and how long to
//! wait before reconnecting. RFC 2177 asks for a renewal at least every 29 minutes, but a
//! proxy, a firewall or a corporate server may cut a connection far sooner (a reported
//! Exchange 2019 does it every ~20 seconds). A cut shows up as a dropped connection, never
//! as a timeout of ours: the silence watchdog stands down during IDLE.
//!
//! Two kinds of cut look alike and need opposite answers. A cut of an *idle* link comes N
//! seconds after the client last wrote: renewing IDLE (DONE and the new IDLE are traffic)
//! inside N keeps the link. A cut by the connection's *age* comes N seconds after the
//! connect whatever is written: renewing does nothing, and a short renewal only burns
//! traffic. The pace learns the first kind from two drops in a row at the same mark after
//! the last write, tells the second by a drop at the same age of the connection under a
//! different renewal, and for that one only backs the reconnects off.

use std::fmt;
use std::time::Duration;

use crate::Error;
use crate::imap::IDLE_RENEW;

/// Why a connection broke, as far as the error says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropCause {
    /// The server said `* BYE` (with this text) before it closed.
    Bye(String),
    /// The server closed the connection (FIN).
    Eof,
    /// The connection was reset or the pipe broke (RST).
    Reset,
    /// Something timed out: the network changed, a VPN fell, TCP keepalive gave up.
    TimedOut,
    Other,
}

impl DropCause {
    pub fn of(e: &Error) -> Self {
        use async_imap::error::Error as I;
        use std::io::ErrorKind as K;
        let io = |e: &std::io::Error| match e.kind() {
            K::UnexpectedEof => Self::Eof,
            K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe => Self::Reset,
            K::TimedOut => Self::TimedOut,
            _ => Self::Other,
        };
        match e {
            Error::Bye(text) => Self::Bye(text.clone()),
            Error::Closed | Error::Imap(I::ConnectionLost) => Self::Eof,
            Error::Io(e) | Error::Imap(I::Io(e)) => io(e),
            Error::Timeout(_) => Self::TimedOut,
            _ => Self::Other,
        }
    }

    /// Only a close by the other side says anything about when it closes.
    fn teaches(&self) -> bool {
        matches!(self, Self::Bye(_) | Self::Eof | Self::Reset)
    }
}

impl fmt::Display for DropCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bye(text) => write!(f, "BYE {text:?}"),
            Self::Eof => f.write_str("EOF"),
            Self::Reset => f.write_str("reset"),
            Self::TimedOut => f.write_str("timeout"),
            Self::Other => f.write_str("error"),
        }
    }
}

/// A connection that broke: how, when, and under which renewal.
#[derive(Debug, Clone)]
pub struct DropInfo {
    pub cause: DropCause,
    /// Since the last thing the client wrote (the start of the IDLE that failed).
    pub since_wait: Duration,
    pub since_connect: Duration,
    /// The renewal this IDLE was held under; `None` when the transport takes none (EWS).
    pub renew: Option<Duration>,
    /// The connection did its work before it broke: an IDLE started on it. A break then is
    /// the server's limit, and the reconnect does not wait longer for it.
    pub worked: bool,
}

/// The numbers the pace works by; tests shrink them to seconds.
#[derive(Debug, Clone, Copy)]
pub struct Tuning {
    /// The longest renewal, and the first one.
    pub max: Duration,
    /// The shortest renewal: below this IDLE would turn into polling.
    pub floor: Duration,
    /// A drop sooner than this after the last write is not a cut of an idle link.
    pub too_soon: Duration,
    /// A connection that lived this long counts as healthy and ends a series of drops.
    pub healthy: Duration,
    /// The first pause after a drop; doubles while drops follow each other.
    pub pause: Duration,
    pub pause_max: Duration,
    /// Renewals that went through before a learned renewal is tried longer again.
    pub probe_after: u32,
    /// Drops in a row, none of them after a renewal that went through, before the inbox is
    /// polled instead of held with IDLE.
    pub poll_after: u32,
    /// Polls before IDLE is tried again.
    pub poll_rounds: u32,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            max: IDLE_RENEW,
            floor: Duration::from_secs(10),
            too_soon: Duration::from_secs(10),
            healthy: Duration::from_secs(5 * 60),
            pause: Duration::from_secs(5),
            pause_max: Duration::from_secs(120),
            probe_after: 20,
            poll_after: 6,
            poll_rounds: 15,
        }
    }
}

#[derive(Debug)]
pub struct IdlePace {
    tune: Tuning,
    renew: Duration,
    /// Drops in a row without a healthy connection between them (for the log).
    drops: u32,
    /// Connections in a row that broke before they did any work (for the pause).
    failed: u32,
    survived: u32,
    /// The next connection should be synced at once: letters came in while there was none.
    resync: bool,
    /// The renewal was just made longer to try it: a drop before the next good wait is
    /// the price of the try, not news.
    probing: bool,
    /// The previous drop that taught: (since the last write, since the connect).
    mark: Option<(Duration, Duration)>,
    /// The age at which the connection is cut whatever is written, once told.
    lifetime: Option<Duration>,
    /// Drops in a row that came before any renewal went through: the link does not hold
    /// an IDLE, and neither a shorter renewal nor a longer pause mended it.
    quick: u32,
    /// The inbox is polled, not held with IDLE.
    polling: bool,
    poll_count: u32,
    /// The switch to polling was told in the log, and nothing has held since.
    poll_told: bool,
}

/// What to do after a drop.
#[derive(Debug, PartialEq, Eq)]
pub struct Dropped {
    pub pause: Duration,
    /// Drops in a row, this one included.
    pub drops: u32,
    /// Whether this drop is worth a line in the log: every power of two of a series, and
    /// the one that found the cut by age, so a link that breaks all day does not fill it.
    pub log: bool,
    /// The drop came on a longer renewal tried on purpose: logged quietly, not counted in the series.
    pub probe: bool,
    pub shortened: Option<Duration>,
    /// This drop showed that the cut comes by the age of the connection: set once per series.
    pub by_age: bool,
    /// The drop came when our own renewal fell due: the server closed the link instead of
    /// taking the new IDLE. It is not a cut of an idle link and is not counted in the series.
    pub at_renewal: bool,
    /// This drop turned the inbox over to polling; set once until an IDLE holds again.
    pub to_poll: bool,
}

/// Two marks are the same moment if they differ by less than a fifth (and 2 s).
fn near(a: Duration, b: Duration) -> bool {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    hi - lo <= (hi / 5).max(Duration::from_secs(2))
}

impl IdlePace {
    pub fn new() -> Self {
        Self::with(Tuning::default())
    }

    pub fn with(tune: Tuning) -> Self {
        Self {
            renew: tune.max,
            tune,
            drops: 0,
            failed: 0,
            survived: 0,
            resync: false,
            probing: false,
            mark: None,
            lifetime: None,
            quick: 0,
            polling: false,
            poll_count: 0,
            poll_told: false,
        }
    }

    /// How long to hold one IDLE before renewing it.
    pub fn renew(&self) -> Duration {
        self.renew
    }

    /// The connection broke since the last time this was asked: it has to be synced anew,
    /// for what came in during the pause. Asked once per connection, on its first wait.
    pub fn take_resync(&mut self) -> bool {
        std::mem::take(&mut self.resync)
    }

    /// A wait went through on the current connection since the last drop.
    pub fn worked_since_drop(&self) -> bool {
        self.survived > 0
    }

    /// The inbox is polled now: wait a poll interval instead of idling.
    pub fn polling(&self) -> bool {
        self.polling
    }

    /// After enough polls IDLE is tried again; one more quick drop then sends the inbox
    /// back to polling.
    pub fn polled(&mut self) {
        self.poll_count += 1;
        if self.poll_count >= self.tune.poll_rounds {
            self.poll_count = 0;
            self.polling = false;
            self.quick = self.tune.poll_after.saturating_sub(1);
        }
    }

    /// A renewal went through with the connection alive.
    pub fn renewed(&mut self) {
        self.probing = false;
        self.quick = 0;
        self.poll_told = false;
        self.survived += 1;
        if self.survived >= self.tune.probe_after && self.renew < self.tune.max {
            self.survived = 0;
            self.renew = (self.renew * 2).min(self.tune.max);
            self.probing = true;
        }
    }

    pub fn dropped(&mut self, info: &DropInfo) -> Dropped {
        self.survived = 0;
        self.resync = true;
        if info.renew.is_some_and(|renew| info.since_wait >= renew) {
            self.probing = false;
            return Dropped {
                pause: self.tune.pause,
                drops: self.drops,
                log: false,
                probe: false,
                shortened: None,
                by_age: false,
                at_renewal: true,
                to_poll: false,
            };
        }
        // Healthy by the age it had before this wait began: a wait that was cut at its own
        // 600th second proves nothing about the connection before it.
        if info.since_connect.saturating_sub(info.since_wait) >= self.tune.healthy {
            self.drops = 0;
            self.quick = 0;
            self.mark = None;
            self.lifetime = None;
        }
        let probe = std::mem::take(&mut self.probing);
        if !probe {
            self.drops += 1;
        }
        self.failed = if info.worked { 0 } else { self.failed + 1 };
        let mut shortened = None;
        let mut by_age = false;
        if let Some(renew) = info.renew.filter(|_| info.cause.teaches()) {
            let now = (info.since_wait, info.since_connect);
            match (self.lifetime, self.mark) {
                (Some(age), _) if near(info.since_connect, age) => {}
                (_, Some((wait, age))) if near(info.since_connect, age) && !near(info.since_wait, wait) => {
                    // The same age under another renewal: the age cuts, not the idleness.
                    // The shortening it was misled into is taken back.
                    self.lifetime = Some(info.since_connect);
                    self.renew = self.tune.max;
                    by_age = true;
                }
                (_, Some((wait, _))) if near(info.since_wait, wait) && info.since_wait < renew => {
                    if info.since_wait >= self.tune.too_soon {
                        self.renew = (info.since_wait * 2 / 3).max(self.tune.floor);
                        shortened = Some(self.renew);
                    }
                    self.lifetime = None;
                }
                _ => self.lifetime = None,
            }
            self.mark = Some(now);
        }
        // A cut by the age of the connection is the server's way and does not wear the link out.
        let aged = by_age || self.lifetime.is_some_and(|age| near(info.since_connect, age));
        if !probe && !aged && info.cause.teaches() && info.since_wait < self.tune.healthy {
            // A cut that a shorter renewal can still mend is the pace's to learn from; only
            // the ones it cannot mend wear the link out.
            let unmendable =
                info.renew.is_none() || info.since_wait < self.tune.too_soon || self.renew <= self.tune.floor;
            self.quick = if unmendable { self.quick + 1 } else { 0 };
        }
        let to_poll = !self.polling && self.quick >= self.tune.poll_after;
        if to_poll {
            self.polling = true;
            self.poll_count = 0;
        }
        let first_poll = to_poll && !std::mem::replace(&mut self.poll_told, true);
        // Connections that broke before doing any work push the next try away, and so do
        // drops that come one after another with no renewal between them.
        let pause = self
            .tune
            .pause
            .saturating_mul(1 << self.failed.saturating_sub(1).max(self.quick.saturating_sub(2)).min(5))
            .min(self.tune.pause_max);
        Dropped {
            pause,
            drops: self.drops,
            log: !probe && (self.drops.is_power_of_two() || by_age),
            probe,
            shortened,
            by_age,
            at_renewal: false,
            to_poll: first_poll,
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

    /// What a server that cuts a link after `after` seconds of the client's silence does:
    /// the first wait on a connection is held for the renewal, and it is cut if the renewal
    /// is longer.
    fn idle_cut(after: u64, pace: &IdlePace) -> Option<DropInfo> {
        (pace.renew() > s(after)).then(|| DropInfo {
            cause: DropCause::Eof,
            since_wait: s(after),
            since_connect: s(after),
            renew: Some(pace.renew()),
            worked: true,
        })
    }

    /// A server that cuts the connection `age` seconds after the connect, whatever is
    /// written: the wait that is on at that moment began at the last multiple of the renewal.
    fn age_cut(age: u64, pace: &IdlePace) -> DropInfo {
        let renew = pace.renew().as_secs();
        DropInfo {
            cause: DropCause::Eof,
            since_wait: s(if age < renew { age } else { age % renew }),
            since_connect: s(age),
            renew: Some(pace.renew()),
            worked: true,
        }
    }

    fn drop_of(cause: DropCause, wait: u64, connect: u64, pace: &IdlePace) -> DropInfo {
        DropInfo {
            cause,
            since_wait: s(wait),
            since_connect: s(connect),
            renew: Some(pace.renew()),
            worked: false,
        }
    }

    #[test]
    fn a_fresh_pace_renews_inside_the_rfc_limit() {
        assert!(IdlePace::new().renew() <= s(29 * 60));
    }

    #[test]
    fn a_link_cut_after_twenty_seconds_of_silence_gets_a_renewal_that_holds_it() {
        let mut p = IdlePace::new();
        let first = p.dropped(&idle_cut(20, &p).unwrap());
        assert_eq!(first.shortened, None, "one drop is no proof");
        assert_eq!(p.renew(), IDLE_RENEW);
        let second = p.dropped(&idle_cut(20, &p).unwrap());
        assert!(second.shortened.is_some());
        assert!(p.renew() < s(20) && p.renew() >= s(10), "{:?}", p.renew());
        assert!(idle_cut(20, &p).is_none(), "the link now survives");
    }

    #[test]
    fn a_link_cut_by_the_age_of_the_connection_keeps_the_long_renewal_and_logs_rarely() {
        let mut p = IdlePace::new();
        let drops: Vec<_> = (0..12)
            .map(|_| {
                let info = age_cut(15, &p);
                p.dropped(&info)
            })
            .collect();
        assert_eq!(drops.iter().filter(|d| d.by_age).count(), 1, "told once: {drops:?}");
        let logged: Vec<_> = drops.iter().filter(|d| d.log).map(|d| d.drops).collect();
        let told_at = drops.iter().find(|d| d.by_age).unwrap().drops;
        assert!(
            logged.iter().all(|n| n.is_power_of_two() || *n == told_at),
            "{logged:?}"
        );
        assert_eq!(p.renew(), IDLE_RENEW, "the renewal does not stick at the floor");
        assert!(
            drops.iter().all(|d| d.pause == s(5)),
            "a connection that worked is cut by the server, not failing: {drops:?}"
        );
    }

    #[test]
    fn a_probe_after_a_learned_cut_does_not_push_the_reconnect_away() {
        let mut p = IdlePace::new();
        p.dropped(&idle_cut(20, &p).unwrap());
        p.dropped(&idle_cut(20, &p).unwrap());
        let held = p.renew();
        for _ in 0..p.tune.probe_after {
            p.renewed();
        }
        assert!(p.renew() > held, "the probe tries a longer renewal");
        for _ in 0..4 {
            let d = p.dropped(&idle_cut(20, &p).expect("the long renewal is cut again"));
            assert_eq!(d.pause, s(5));
            for _ in 0..p.tune.probe_after {
                p.renewed();
            }
        }
    }

    #[test]
    fn drops_on_a_probe_are_not_news() {
        let mut p = IdlePace::new();
        let first: Vec<_> = (0..2).map(|_| p.dropped(&idle_cut(20, &p).unwrap())).collect();
        assert!(
            first.iter().all(|d| d.log && !d.probe),
            "the series that taught is told"
        );
        for _ in 0..4 {
            for _ in 0..p.tune.probe_after {
                p.renewed();
            }
            let d = p.dropped(&idle_cut(20, &p).expect("the longer renewal is cut again"));
            assert!(d.probe && !d.log, "{d:?}");
        }
    }

    #[test]
    fn a_connection_that_breaks_at_once_pushes_the_reconnect_away_up_to_the_limit() {
        let mut p = IdlePace::new();
        let pauses: Vec<_> = (0..9)
            .map(|_| p.dropped(&drop_of(DropCause::Eof, 0, 0, &p)).pause)
            .collect();
        assert_eq!(pauses[8], s(120));
        let worked = DropInfo {
            worked: true,
            ..drop_of(DropCause::Eof, 20, 20, &p)
        };
        assert_eq!(
            p.dropped(&worked).pause,
            s(5),
            "the first connection that worked ends it"
        );
    }

    #[test]
    fn a_wait_cut_at_its_own_tenth_minute_does_not_make_the_connection_healthy() {
        let mut p = IdlePace::new();
        p.dropped(&drop_of(DropCause::Eof, 600, 600, &p));
        p.dropped(&drop_of(DropCause::Eof, 600, 600, &p));
        assert!(p.renew() < s(600), "{:?}", p.renew());
    }

    #[test]
    fn after_a_drop_the_next_connection_is_synced_once() {
        let mut p = IdlePace::new();
        assert!(!p.take_resync());
        p.dropped(&drop_of(DropCause::Eof, 20, 20, &p));
        assert!(p.take_resync());
        assert!(!p.take_resync());
    }

    #[test]
    fn a_timeout_teaches_nothing() {
        let mut p = IdlePace::new();
        p.dropped(&drop_of(DropCause::TimedOut, 330, 330, &p));
        assert_eq!(p.renew(), IDLE_RENEW);
        for _ in 0..3 {
            p.dropped(&drop_of(DropCause::TimedOut, 20, 20, &p));
        }
        assert_eq!(p.renew(), IDLE_RENEW);
    }

    #[test]
    fn a_bye_and_a_reset_teach_like_a_close() {
        for cause in [DropCause::Bye("Idle timeout".into()), DropCause::Reset] {
            let mut p = IdlePace::new();
            p.dropped(&drop_of(cause.clone(), 20, 20, &p));
            p.dropped(&drop_of(cause, 20, 20, &p));
            assert!(p.renew() < s(20));
        }
    }

    #[test]
    fn a_cut_without_a_renewal_to_shorten_changes_nothing() {
        let mut p = IdlePace::new();
        for _ in 0..3 {
            let info = DropInfo {
                renew: None,
                ..drop_of(DropCause::Eof, 20, 20, &p)
            };
            p.dropped(&info);
        }
        assert_eq!(p.renew(), IDLE_RENEW);
    }

    #[test]
    fn drops_in_a_row_back_the_pause_off() {
        let mut p = IdlePace::new();
        let pauses: Vec<_> = (0..9)
            .map(|_| p.dropped(&drop_of(DropCause::Eof, 1, 1, &p)).pause)
            .collect();
        assert_eq!(&pauses[..3], [s(5), s(10), s(20)]);
        assert_eq!(pauses[8], s(120));
        assert_eq!(p.renew(), IDLE_RENEW, "an instant drop says nothing about idle time");
    }

    #[test]
    fn only_a_connection_that_lived_long_ends_the_series() {
        let mut p = IdlePace::new();
        p.dropped(&drop_of(DropCause::Eof, 1, 1, &p));
        // A renewal that went through is no proof the link is well: it may be cut by its age.
        p.renewed();
        assert_eq!(p.dropped(&drop_of(DropCause::Eof, 1, 1, &p)).drops, 2);
        let lived = DropInfo {
            worked: true,
            ..drop_of(DropCause::Eof, 30, 20 * 60, &p)
        };
        let d = p.dropped(&lived);
        assert_eq!((d.drops, d.pause), (1, s(5)));
    }

    #[test]
    fn the_renewal_is_never_shorter_than_the_floor() {
        let mut p = IdlePace::new();
        p.dropped(&drop_of(DropCause::Eof, 12, 12, &p));
        p.dropped(&drop_of(DropCause::Eof, 12, 12, &p));
        assert_eq!(p.renew(), s(10));
    }

    #[test]
    fn a_long_run_without_cuts_tries_a_longer_renewal() {
        let mut p = IdlePace::new();
        p.dropped(&drop_of(DropCause::Eof, 30, 30, &p));
        p.dropped(&drop_of(DropCause::Eof, 30, 30, &p));
        let short = p.renew();
        for _ in 0..p.tune.probe_after {
            p.renewed();
        }
        assert_eq!(p.renew(), short * 2);
    }

    /// A transport with no renewal to shorten (Exchange's stream) cut `wait` seconds in.
    fn stream_cut(wait: u64) -> DropInfo {
        DropInfo {
            cause: DropCause::Eof,
            since_wait: s(wait),
            since_connect: s(wait),
            renew: None,
            worked: true,
        }
    }

    #[test]
    fn a_link_cut_at_once_every_time_backs_off_and_is_then_polled_with_one_notice() {
        let mut p = IdlePace::new();
        let mut pauses = Vec::new();
        let mut notices = 0;
        for _ in 0..40 {
            let d = p.dropped(&stream_cut(15));
            pauses.push(d.pause.as_secs());
            notices += usize::from(d.to_poll);
            if p.polling() {
                break;
            }
        }
        assert_eq!(pauses, [5, 5, 10, 20, 40, 80], "the pause grows");
        assert!(p.polling());
        assert_eq!(notices, 1, "told once");
    }

    #[test]
    fn a_link_that_holds_a_renewal_is_not_polled() {
        let mut p = IdlePace::new();
        for _ in 0..40 {
            p.dropped(&stream_cut(15));
            p.renewed();
        }
        assert!(!p.polling());
    }

    #[test]
    fn polling_gives_idle_another_try_and_does_not_tell_again() {
        let mut p = IdlePace::new();
        while !p.polling() {
            p.dropped(&stream_cut(15));
        }
        for _ in 0..p.tune.poll_rounds {
            assert!(p.polling());
            p.polled();
        }
        assert!(!p.polling(), "IDLE is tried again");
        let d = p.dropped(&stream_cut(15));
        assert!(p.polling() && !d.to_poll, "back to polling, quietly");
    }

    #[test]
    fn a_renewal_that_fell_due_is_no_drop_in_a_row() {
        let mut p = IdlePace::new();
        for _ in 0..12 {
            let d = p.dropped(&DropInfo {
                cause: DropCause::Eof,
                since_wait: s(1501),
                since_connect: s(1501),
                renew: Some(p.renew()),
                worked: true,
            });
            assert!(d.at_renewal && !d.log && !d.to_poll);
            assert_eq!((d.drops, d.pause), (0, s(5)));
        }
        assert!(!p.polling());
        assert_eq!(p.renew(), IDLE_RENEW, "nothing was learned");
    }

    #[test]
    fn the_cause_is_read_from_the_error() {
        use async_imap::error::Error as I;
        let kind = |k| Error::Io(std::io::Error::from(k));
        assert_eq!(DropCause::of(&Error::Bye("x".into())), DropCause::Bye("x".into()));
        assert_eq!(DropCause::of(&Error::Imap(I::ConnectionLost)), DropCause::Eof);
        assert_eq!(DropCause::of(&kind(std::io::ErrorKind::UnexpectedEof)), DropCause::Eof);
        assert_eq!(DropCause::of(&kind(std::io::ErrorKind::BrokenPipe)), DropCause::Reset);
        assert_eq!(
            DropCause::of(&kind(std::io::ErrorKind::ConnectionReset)),
            DropCause::Reset
        );
        assert_eq!(DropCause::of(&kind(std::io::ErrorKind::TimedOut)), DropCause::TimedOut);
        assert_eq!(DropCause::of(&Error::Timeout("operation")), DropCause::TimedOut);
    }
}
