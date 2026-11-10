//! A stream that gives up on a silent server: once we have sent something, the
//! first byte of the answer must come within `limit`, and once the answer has
//! started it must not fall silent for longer than `silence` before the next byte.
//! A connection that died quietly (Wi-Fi changed, a NAT forgot it) would otherwise
//! hold the mailbox's queue until the system drops the socket, hours later — even
//! when it dies in the middle of a long `BODY.PEEK[]` or `UID FETCH`. Waiting with
//! nothing asked (IDLE after the server's "+ idling") is not limited: the caller
//! marks the connection `idling` while it waits, and the timer is let go then.

use std::fmt;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Sleep, sleep};

/// The two windows of a connection's answers, shared with whoever hands one command a
/// shorter pair (`imap::AnswerWindow`): the watchdog reads them each time it arms, so the
/// pair in place when a command goes out is the pair its answer is watched with.
pub struct AnswerLimits {
    /// The first byte of an answer must come within this after a write.
    limit: AtomicU64,
    /// Once the answer started, the next byte must come within this.
    silence: AtomicU64,
}

impl AnswerLimits {
    pub fn new(limit: Duration, silence: Duration) -> Arc<Self> {
        let limits = Self {
            limit: AtomicU64::new(0),
            silence: AtomicU64::new(0),
        };
        limits.set(limit, silence);
        Arc::new(limits)
    }

    pub fn limit(&self) -> Duration {
        millis(self.limit.load(Ordering::Relaxed))
    }

    pub fn silence(&self) -> Duration {
        millis(self.silence.load(Ordering::Relaxed))
    }

    /// Both windows at once: they are shortened together and given back together.
    pub fn set(&self, limit: Duration, silence: Duration) {
        self.limit.store(millis_of(limit), Ordering::Relaxed);
        self.silence.store(millis_of(silence), Ordering::Relaxed);
    }
}

/// A window of zero would fire before the stream is polled once.
fn millis_of(window: Duration) -> u64 {
    u64::try_from(window.as_millis()).unwrap_or(u64::MAX).max(1)
}

fn millis(value: u64) -> Duration {
    Duration::from_millis(value.max(1))
}

pub struct Watchdog<S> {
    inner: S,
    limits: Arc<AnswerLimits>,
    /// Set while the connection idles: the server is meant to be quiet then.
    idling: Arc<AtomicBool>,
    /// Armed by a write, re-armed by each byte of the answer, disarmed by an error.
    timer: Option<Pin<Box<Sleep>>>,
}

impl<S> Watchdog<S> {
    pub fn new(inner: S, limits: Arc<AnswerLimits>, idling: Arc<AtomicBool>) -> Self {
        Self {
            inner,
            limits,
            idling,
            timer: None,
        }
    }

    fn arm(&mut self, window: Duration) {
        self.timer = Some(Box::pin(sleep(window)));
    }
}

impl<S> fmt::Debug for Watchdog<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Watchdog")
            .field("limit", &self.limits.limit())
            .field("silence", &self.limits.silence())
            .finish_non_exhaustive()
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Watchdog<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Ready(r) => {
                if r.is_err() {
                    self.timer = None;
                } else if buf.filled().len() > before {
                    // The answer is still coming: it must not fall silent now.
                    let silence = self.limits.silence();
                    self.arm(silence);
                }
                Poll::Ready(r)
            }
            Poll::Pending => {
                // Nothing asked: IDLE waits for the server as long as it likes.
                if self.idling.load(Ordering::Relaxed) {
                    self.timer = None;
                    return Poll::Pending;
                }
                let fired = self.timer.as_mut().is_some_and(|t| t.as_mut().poll(cx).is_ready());
                if fired {
                    self.timer = None;
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "the server stopped answering")).into();
                }
                Poll::Pending
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Watchdog<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write(cx, data);
        // Every command is a write: a fresh one gives the answer its full window, and
        // clears a timer left over from the answer before (it would fire at once).
        if matches!(r, Poll::Ready(Ok(n)) if n > 0) {
            let limit = self.limits.limit();
            self.arm(limit);
        }
        r
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};
    use tokio::net::{TcpListener, TcpStream};

    const LIMIT: Duration = Duration::from_millis(200);
    /// A gap of eight tenths of the silence window: inside it, but not by much.
    const GAP: Duration = Duration::from_millis(160);

    fn limits(limit: Duration, silence: Duration) -> Arc<AnswerLimits> {
        AnswerLimits::new(limit, silence)
    }

    fn watchdog<S>(inner: S) -> Watchdog<S> {
        Watchdog::new(inner, limits(LIMIT, LIMIT), Arc::new(AtomicBool::new(false)))
    }

    #[tokio::test]
    async fn a_silent_server_is_given_up_on() {
        let (client, _server) = duplex(64);
        let mut w = watchdog(client);
        w.write_all(b"a1 NOOP\r\n").await.unwrap();
        let mut buf = [0u8; 16];
        let err = w.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn a_server_that_stops_mid_answer_is_given_up_on() {
        // A real socket: the server sends half the answer and goes quiet.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            s.write_all(b"* 1 FETCH (BODY[] {1000}\r\n").await.unwrap();
            // Never the rest.
            tokio::time::sleep(LIMIT * 10).await;
        });
        let tcp = TcpStream::connect(addr).await.unwrap();
        let mut w = watchdog(tcp);
        w.write_all(b"a1 UID FETCH 1 BODY.PEEK[]\r\n").await.unwrap();
        let mut buf = [0u8; 64];
        // The half that came is read…
        assert!(w.read(&mut buf).await.unwrap() > 0);
        // …then silence is given up on.
        let err = w.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        server.abort();
    }

    #[tokio::test]
    async fn waiting_with_nothing_asked_is_not_limited() {
        let (client, mut server) = duplex(64);
        let idling = Arc::new(AtomicBool::new(false));
        let mut w = Watchdog::new(client, limits(LIMIT, LIMIT), idling.clone());
        w.write_all(b"a1 IDLE\r\n").await.unwrap();
        server.write_all(b"+ idling\r\n").await.unwrap();
        let mut buf = [0u8; 16];
        assert!(w.read(&mut buf).await.unwrap() > 0);
        // The caller marks the connection idling: long silence is not an error.
        idling.store(true, Ordering::Relaxed);
        let late = tokio::spawn(async move {
            tokio::time::sleep(LIMIT * 3).await;
            server.write_all(b"* 3 EXISTS\r\n").await.unwrap();
            server
        });
        assert!(w.read(&mut buf).await.unwrap() > 0);
        drop(late.await.unwrap());
    }

    #[tokio::test]
    async fn a_window_the_caller_holds_shortens_the_answer_and_drop_gives_the_own_back() {
        let (client, _server) = duplex(64);
        let limits = limits(LIMIT * 10, LIMIT * 10);
        let mut w = Watchdog::new(client, limits.clone(), Arc::new(AtomicBool::new(false)));
        // An operator is waiting for this one: the connection's own ten windows would be
        // ten times too long for them. The window is on before the command goes out, since
        // a timer takes the limits as they are when it is armed.
        let window = crate::imap::AnswerWindow::new(limits.clone(), LIMIT, LIMIT);
        assert_eq!((limits.limit(), limits.silence()), (LIMIT, LIMIT));
        let mut buf = [0u8; 16];
        w.write_all(b"a1 NOOP\r\n").await.unwrap();
        let started = tokio::time::Instant::now();
        let err = w.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < LIMIT * 5,
            "the short window fired late: {:?}",
            started.elapsed()
        );
        // And once the caller is done, the connection waits as it did before.
        drop(window);
        assert_eq!((limits.limit(), limits.silence()), (LIMIT * 10, LIMIT * 10));
        w.write_all(b"a2 NOOP\r\n").await.unwrap();
        assert!(
            tokio::time::timeout(LIMIT * 3, w.read(&mut buf)).await.is_err(),
            "the answer was given up on with the short window gone"
        );
    }

    #[tokio::test]
    async fn a_window_goes_with_the_future_that_carried_it() {
        let (client, _server) = duplex(64);
        let limits = limits(LIMIT * 10, LIMIT * 10);
        let mut w = Watchdog::new(client, limits.clone(), Arc::new(AtomicBool::new(false)));
        w.write_all(b"a1 NOOP\r\n").await.unwrap();
        let mut buf = [0u8; 16];
        // A read the caller gives up on: the window closes with the future, not later.
        let read = async {
            let _window = crate::imap::AnswerWindow::new(limits.clone(), LIMIT, LIMIT);
            w.read(&mut buf).await
        };
        assert!(read.now_or_never().is_none());
        assert_eq!((limits.limit(), limits.silence()), (LIMIT * 10, LIMIT * 10));
    }

    #[tokio::test]
    async fn bytes_that_keep_coming_are_read_for_any_length_of_answer() {
        // Every gap is inside the silence window, so nothing is given up on however long
        // the whole answer takes: there is no deadline on the answer itself.
        let (client, mut server) = duplex(64);
        let mut w = Watchdog::new(client, limits(LIMIT, LIMIT), Arc::new(AtomicBool::new(false)));
        w.write_all(b"a1 UID FETCH 1 BODY.PEEK[]\r\n").await.unwrap();
        let sending = tokio::spawn(async move {
            for _ in 0..8 {
                tokio::time::sleep(GAP).await;
                if server.write_all(b"x").await.is_err() {
                    break;
                }
            }
        });
        let mut buf = [0u8; 16];
        let started = tokio::time::Instant::now();
        let mut got = 0;
        while got < 8 {
            got += w.read(&mut buf).await.expect("a gap inside the window keeps it alive");
        }
        assert!(
            started.elapsed() > LIMIT * 3,
            "the answer was too quick to prove anything"
        );
        sending.await.unwrap();
    }

    #[test]
    fn a_window_of_zero_is_a_millisecond() {
        let limits = limits(Duration::ZERO, Duration::ZERO);
        assert_eq!(limits.limit(), Duration::from_millis(1));
        assert_eq!(limits.silence(), Duration::from_millis(1));
        limits.set(Duration::ZERO, Duration::ZERO);
        assert_eq!(limits.limit(), Duration::from_millis(1));
        assert_eq!(limits.silence(), Duration::from_millis(1));
    }
}
