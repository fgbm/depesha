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
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Sleep, sleep};

pub struct Watchdog<S> {
    inner: S,
    /// The first byte of an answer must come within this after a write.
    limit: Duration,
    /// Once the answer started, the next byte must come within this.
    silence: Duration,
    /// Set while the connection idles: the server is meant to be quiet then.
    idling: Arc<AtomicBool>,
    /// Armed by a write, re-armed by each byte of the answer, disarmed by an error.
    timer: Option<Pin<Box<Sleep>>>,
}

impl<S> Watchdog<S> {
    pub fn new(inner: S, limit: Duration, silence: Duration, idling: Arc<AtomicBool>) -> Self {
        Self {
            inner,
            limit,
            silence,
            idling,
            timer: None,
        }
    }

    fn arm(&mut self, limit: Duration) {
        self.timer = Some(Box::pin(sleep(limit)));
    }
}

impl<S> fmt::Debug for Watchdog<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Watchdog")
            .field("limit", &self.limit)
            .field("silence", &self.silence)
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
                    let silence = self.silence;
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
            let limit = self.limit;
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};
    use tokio::net::{TcpListener, TcpStream};

    const LIMIT: Duration = Duration::from_millis(200);

    fn watchdog<S>(inner: S) -> Watchdog<S> {
        Watchdog::new(inner, LIMIT, LIMIT, Arc::new(AtomicBool::new(false)))
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
        let mut w = Watchdog::new(client, LIMIT, LIMIT, idling.clone());
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
}
