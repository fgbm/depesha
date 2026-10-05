//! A stream that gives up on a silent server: once we have sent something, the
//! first byte of the answer must come within the limit. A connection that died
//! quietly (Wi-Fi changed, a NAT forgot it) would otherwise hold the mailbox's
//! queue until the system drops the socket, hours later. Waiting with nothing
//! asked (IDLE after the server's "+ idling") is not limited, and neither is a
//! long answer that keeps coming.

use std::fmt;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Sleep, sleep};

pub struct Watchdog<S> {
    inner: S,
    limit: Duration,
    /// Armed by a write, disarmed by the next byte read.
    timer: Option<Pin<Box<Sleep>>>,
}

impl<S> Watchdog<S> {
    pub fn new(inner: S, limit: Duration) -> Self {
        Self {
            inner,
            limit,
            timer: None,
        }
    }
}

impl<S> fmt::Debug for Watchdog<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Watchdog")
            .field("limit", &self.limit)
            .finish_non_exhaustive()
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Watchdog<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Ready(r) => {
                if buf.filled().len() > before || r.is_err() {
                    self.timer = None;
                }
                Poll::Ready(r)
            }
            Poll::Pending => {
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
        if matches!(r, Poll::Ready(Ok(n)) if n > 0) && self.timer.is_none() {
            let limit = self.limit;
            self.timer = Some(Box::pin(sleep(limit)));
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

    const LIMIT: Duration = Duration::from_millis(200);

    #[tokio::test]
    async fn a_silent_server_is_given_up_on() {
        let (client, _server) = duplex(64);
        let mut w = Watchdog::new(client, LIMIT);
        w.write_all(b"a1 NOOP\r\n").await.unwrap();
        let mut buf = [0u8; 16];
        let err = w.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn waiting_with_nothing_asked_is_not_limited() {
        let (client, mut server) = duplex(64);
        let mut w = Watchdog::new(client, LIMIT);
        w.write_all(b"a1 IDLE\r\n").await.unwrap();
        server.write_all(b"+ idling\r\n").await.unwrap();
        let mut buf = [0u8; 16];
        assert!(w.read(&mut buf).await.unwrap() > 0);
        // Long after the limit the server speaks, and the answer is taken.
        let late = tokio::spawn(async move {
            tokio::time::sleep(LIMIT * 3).await;
            server.write_all(b"* 3 EXISTS\r\n").await.unwrap();
            server
        });
        assert!(w.read(&mut buf).await.unwrap() > 0);
        drop(late.await.unwrap());
    }
}
