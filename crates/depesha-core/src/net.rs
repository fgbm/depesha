//! Socket options the mail transports share.

use std::time::Duration;

use tokio::net::TcpStream;

/// Turns on TCP keepalive so a link that died quietly (Wi-Fi changed, a NAT forgot it)
/// is noticed by the system within minutes, not hours. The silence watchdog catches a
/// stall during an answer; keepalive also covers a connection that sits with nothing
/// pending, and probes a peer that vanished without a FIN.
pub fn keepalive(tcp: &TcpStream) {
    let keep = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(60))
        .with_interval(Duration::from_secs(30));
    let _ = socket2::SockRef::from(tcp).set_tcp_keepalive(&keep);
}
