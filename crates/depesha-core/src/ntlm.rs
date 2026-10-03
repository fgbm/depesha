//! NTLMv2 over HTTP (MS-NLMP): on-premises Exchange often turns Basic off on EWS
//! and leaves only Windows login. The login authenticates the TCP connection, so
//! the caller runs the handshake once per connection.
//!
//! The Authenticate message carries a MIC and channel bindings to the server's TLS
//! certificate: Exchange with Extended Protection (the default since 2022) refuses
//! NTLM without them even when the password is right.

use hmac::{Hmac, KeyInit, Mac};
use md4::Md4;
use md5::{Digest, Md5};
use ring::rand::{SecureRandom, SystemRandom};

use crate::{Error, Result};

const SIGNATURE: &[u8; 8] = b"NTLMSSP\0";

const UNICODE: u32 = 0x0000_0001;
const REQUEST_TARGET: u32 = 0x0000_0004;
const NTLM: u32 = 0x0000_0200;
const ALWAYS_SIGN: u32 = 0x0000_8000;
const EXTENDED_SESSIONSECURITY: u32 = 0x0008_0000;
const TARGET_INFO: u32 = 0x0080_0000;
const VERSION: u32 = 0x0200_0000;
const N128: u32 = 0x2000_0000;
const N56: u32 = 0x8000_0000;
const FLAGS: u32 =
    UNICODE | REQUEST_TARGET | NTLM | ALWAYS_SIGN | EXTENDED_SESSIONSECURITY | TARGET_INFO | VERSION | N128 | N56;

/// Windows 10, NTLM revision 15: servers only log it.
const OS_VERSION: [u8; 8] = [10, 0, 0x61, 0x4a, 0, 0, 0, 0x0f];

const AV_EOL: u16 = 0;
const AV_FLAGS: u16 = 6;
const AV_TIMESTAMP: u16 = 7;
const AV_TARGET_NAME: u16 = 9;
const AV_CHANNEL_BINDINGS: u16 = 10;
/// MsvAvFlags bit: the Authenticate message carries a MIC.
const MIC_PRESENT: u32 = 0x2;

/// Offset of the MIC in the Authenticate message, and where its payload starts.
const MIC_AT: usize = 72;
const AUTH_HEADER: usize = 88;

/// Who logs in: `DOMAIN\user`, `user@domain` (a UPN: the domain stays empty) or `user`.
pub struct Login<'a> {
    pub user: &'a str,
    pub domain: &'a str,
    pub password: &'a str,
}

impl<'a> Login<'a> {
    pub fn new(login: &'a str, password: &'a str) -> Self {
        let (domain, user) = login.split_once('\\').unwrap_or(("", login));
        Self { user, domain, password }
    }
}

/// The client side of one handshake: keeps the Negotiate message for the MIC.
pub struct Client {
    negotiate: Vec<u8>,
}

impl Client {
    /// Starts a handshake; the message goes in `Authorization: NTLM <base64>`.
    pub fn new() -> (Self, Vec<u8>) {
        let mut m = Vec::with_capacity(40);
        m.extend_from_slice(SIGNATURE);
        m.extend_from_slice(&1u32.to_le_bytes());
        m.extend_from_slice(&FLAGS.to_le_bytes());
        // Domain and workstation: none, with the payload offset after the version.
        for _ in 0..2 {
            m.extend_from_slice(&[0, 0, 0, 0]);
            m.extend_from_slice(&40u32.to_le_bytes());
        }
        m.extend_from_slice(&OS_VERSION);
        (Self { negotiate: m.clone() }, m)
    }

    /// The Authenticate message answering the server's Challenge. `host` names the
    /// service (`HTTP/<host>`); `cert` is the server's TLS certificate (DER).
    pub fn authenticate(&self, challenge: &[u8], login: &Login, host: &str, cert: Option<&[u8]>) -> Result<Vec<u8>> {
        let ch = Challenge::parse(challenge)?;
        let mut client_challenge = [0u8; 8];
        SystemRandom::new()
            .fill(&mut client_challenge)
            .map_err(|_| Error::Protocol("NTLM: no random numbers".into()))?;
        let timestamp = ch.timestamp();
        let time = timestamp.unwrap_or_else(filetime_now);
        let av = target_info(&ch.av, timestamp.is_some(), host, cert);

        let key = ntowfv2(login.password, login.user, login.domain);
        let (nt, proof) = nt_response(&key, &ch.server_challenge, &client_challenge, time, &av);
        let session_key = hmac_md5(&key, &[&proof]);
        // With a server timestamp the LM response is zeros (MS-NLMP 3.1.5.1.2).
        let lm = if timestamp.is_some() {
            vec![0; 24]
        } else {
            lm_response(&key, &ch.server_challenge, &client_challenge)
        };

        let flags = (ch.flags & FLAGS) | UNICODE;
        let fields: [Vec<u8>; 6] = [lm, nt, utf16(login.domain), utf16(login.user), Vec::new(), Vec::new()];
        let mut m = Vec::with_capacity(AUTH_HEADER + fields.iter().map(Vec::len).sum::<usize>());
        m.extend_from_slice(SIGNATURE);
        m.extend_from_slice(&3u32.to_le_bytes());
        let mut offset = AUTH_HEADER;
        for f in &fields {
            m.extend_from_slice(&(f.len() as u16).to_le_bytes());
            m.extend_from_slice(&(f.len() as u16).to_le_bytes());
            m.extend_from_slice(&(offset as u32).to_le_bytes());
            offset += f.len();
        }
        m.extend_from_slice(&flags.to_le_bytes());
        m.extend_from_slice(&OS_VERSION);
        m.extend_from_slice(&[0; 16]);
        for f in &fields {
            m.extend_from_slice(f);
        }
        if timestamp.is_some() {
            let mic = hmac_md5(&session_key, &[&self.negotiate, challenge, &m]);
            m[MIC_AT..AUTH_HEADER].copy_from_slice(&mic);
        }
        Ok(m)
    }
}

struct Challenge {
    flags: u32,
    server_challenge: [u8; 8],
    /// Target info pairs without the terminator.
    av: Vec<(u16, Vec<u8>)>,
}

impl Challenge {
    fn parse(m: &[u8]) -> Result<Self> {
        let bad = || Error::Protocol("NTLM: malformed challenge from the server".into());
        if m.len() < 48 || &m[..8] != SIGNATURE || u32_at(m, 8) != 2 {
            return Err(bad());
        }
        let flags = u32_at(m, 20);
        let server_challenge = m[24..32].try_into().expect("8 bytes");
        let len = u16_at(m, 40) as usize;
        let offset = u32_at(m, 44) as usize;
        let info = m.get(offset..offset + len).ok_or_else(bad)?;
        let mut av = Vec::new();
        let mut i = 0;
        while i + 4 <= info.len() {
            let id = u16_at(info, i);
            let n = u16_at(info, i + 2) as usize;
            if id == AV_EOL {
                break;
            }
            av.push((id, info.get(i + 4..i + 4 + n).ok_or_else(bad)?.to_vec()));
            i += 4 + n;
        }
        Ok(Self {
            flags,
            server_challenge,
            av,
        })
    }

    fn timestamp(&self) -> Option<u64> {
        self.av
            .iter()
            .find(|(id, v)| *id == AV_TIMESTAMP && v.len() == 8)
            .map(|(_, v)| u64::from_le_bytes(v[..8].try_into().expect("8 bytes")))
    }
}

/// The server's target info with what the client adds: MIC flag, channel bindings,
/// service name. Ends with the terminator.
fn target_info(server: &[(u16, Vec<u8>)], mic: bool, host: &str, cert: Option<&[u8]>) -> Vec<u8> {
    let mut av: Vec<(u16, Vec<u8>)> = server
        .iter()
        .filter(|(id, _)| !matches!(*id, AV_FLAGS | AV_TARGET_NAME | AV_CHANNEL_BINDINGS))
        .cloned()
        .collect();
    let mut flags = server
        .iter()
        .find(|(id, v)| *id == AV_FLAGS && v.len() == 4)
        .map(|(_, v)| u32::from_le_bytes(v[..4].try_into().expect("4 bytes")))
        .unwrap_or(0);
    if mic {
        flags |= MIC_PRESENT;
    }
    if flags != 0 {
        av.push((AV_FLAGS, flags.to_le_bytes().to_vec()));
    }
    av.push((AV_CHANNEL_BINDINGS, channel_bindings(cert).to_vec()));
    av.push((AV_TARGET_NAME, utf16(&format!("HTTP/{host}"))));
    let mut out = Vec::new();
    for (id, v) in av {
        out.extend_from_slice(&id.to_le_bytes());
        out.extend_from_slice(&(v.len() as u16).to_le_bytes());
        out.extend_from_slice(&v);
    }
    out.extend_from_slice(&[0; 4]);
    out
}

/// MD5 of `gss_channel_bindings_struct` with `tls-server-end-point` (RFC 5929);
/// zeros without TLS.
fn channel_bindings(cert: Option<&[u8]>) -> [u8; 16] {
    let Some(cert) = cert else {
        return [0; 16];
    };
    let mut data = b"tls-server-end-point:".to_vec();
    data.extend_from_slice(cert_hash(cert).as_ref());
    let mut s = vec![0u8; 16];
    s.extend_from_slice(&(data.len() as u32).to_le_bytes());
    s.extend_from_slice(&data);
    Md5::digest(&s).into()
}

/// The certificate's hash with its signature's hash function; MD5 and SHA-1 become SHA-256.
fn cert_hash(cert: &[u8]) -> ring::digest::Digest {
    use ring::digest::{SHA256, SHA384, SHA512, digest};
    let oid = x509_parser::parse_x509_certificate(cert)
        .map(|(_, c)| c.signature_algorithm.algorithm.to_id_string())
        .unwrap_or_default();
    let alg = match oid.as_str() {
        "1.2.840.113549.1.1.12" | "1.2.840.10045.4.3.3" => &SHA384,
        "1.2.840.113549.1.1.13" | "1.2.840.10045.4.3.4" => &SHA512,
        _ => &SHA256,
    };
    digest(alg, cert)
}

fn ntowfv2(password: &str, user: &str, domain: &str) -> [u8; 16] {
    let nt_hash: [u8; 16] = Md4::digest(utf16(password)).into();
    hmac_md5(&nt_hash, &[&utf16(&(user.to_uppercase() + domain))])
}

/// NtChallengeResponse and NTProofStr.
fn nt_response(key: &[u8; 16], server: &[u8; 8], client: &[u8; 8], time: u64, av: &[u8]) -> (Vec<u8>, [u8; 16]) {
    let mut temp = vec![1, 1, 0, 0, 0, 0, 0, 0];
    temp.extend_from_slice(&time.to_le_bytes());
    temp.extend_from_slice(client);
    temp.extend_from_slice(&[0; 4]);
    temp.extend_from_slice(av);
    temp.extend_from_slice(&[0; 4]);
    let proof = hmac_md5(key, &[server, &temp]);
    let mut out = proof.to_vec();
    out.extend_from_slice(&temp);
    (out, proof)
}

fn lm_response(key: &[u8; 16], server: &[u8; 8], client: &[u8; 8]) -> Vec<u8> {
    let mut out = hmac_md5(key, &[server, client]).to_vec();
    out.extend_from_slice(client);
    out
}

fn hmac_md5(key: &[u8], parts: &[&[u8]]) -> [u8; 16] {
    let mut mac = <Hmac<Md5> as KeyInit>::new_from_slice(key).expect("HMAC takes any key");
    for p in parts {
        mac.update(p);
    }
    mac.finalize().into_bytes().into()
}

fn utf16(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(b[i..i + 4].try_into().expect("4 bytes"))
}

/// Tenths of microseconds since 1601, as Windows counts time.
fn filetime_now() -> u64 {
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    (unix.as_nanos() / 100) as u64 + 116_444_736_000_000_000
}

/// The server side, for tests of the HTTP handshake: a Challenge and the check of
/// the Authenticate message that answers it.
#[doc(hidden)]
pub mod server {
    use super::*;

    pub const SERVER_CHALLENGE: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

    /// A Challenge with a timestamp, as Windows sends: the client must add a MIC.
    pub fn challenge(domain: &str) -> Vec<u8> {
        let mut info = Vec::new();
        for (id, v) in [
            (2u16, utf16(domain)),
            (1, utf16("EX01")),
            (AV_TIMESTAMP, filetime_now().to_le_bytes().to_vec()),
        ] {
            info.extend_from_slice(&id.to_le_bytes());
            info.extend_from_slice(&(v.len() as u16).to_le_bytes());
            info.extend_from_slice(&v);
        }
        info.extend_from_slice(&[0; 4]);
        let mut m = SIGNATURE.to_vec();
        m.extend_from_slice(&2u32.to_le_bytes());
        m.extend_from_slice(&[0, 0, 0, 0]);
        m.extend_from_slice(&56u32.to_le_bytes());
        m.extend_from_slice(&FLAGS.to_le_bytes());
        m.extend_from_slice(&SERVER_CHALLENGE);
        m.extend_from_slice(&[0; 8]);
        m.extend_from_slice(&(info.len() as u16).to_le_bytes());
        m.extend_from_slice(&(info.len() as u16).to_le_bytes());
        m.extend_from_slice(&56u32.to_le_bytes());
        m.extend_from_slice(&OS_VERSION);
        m.extend_from_slice(&info);
        m
    }

    /// The user and domain of a valid answer; checks NTProofStr, the MIC and that
    /// the channel bindings match `cert`.
    pub fn verify(
        negotiate: &[u8],
        challenge: &[u8],
        auth: &[u8],
        password: &str,
        cert: Option<&[u8]>,
    ) -> Option<(String, String)> {
        if auth.len() < AUTH_HEADER || &auth[..8] != SIGNATURE || u32_at(auth, 8) != 3 {
            return None;
        }
        let field = |at: usize| {
            let len = u16_at(auth, at) as usize;
            let off = u32_at(auth, at + 4) as usize;
            auth.get(off..off + len)
        };
        let text = |b: &[u8]| {
            String::from_utf16(
                &b.chunks(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>(),
            )
            .ok()
        };
        let nt = field(20)?;
        let domain = text(field(28)?)?;
        let user = text(field(36)?)?;
        let key = ntowfv2(password, &user, &domain);
        let (proof, temp) = nt.split_at(16);
        if hmac_md5(&key, &[&SERVER_CHALLENGE, temp]) != proof {
            return None;
        }
        // The client's target info: channel bindings must be those of our certificate.
        let info = Challenge::parse(&{
            let mut fake = challenge[..40].to_vec();
            let av = &temp[28..temp.len() - 4];
            fake.extend_from_slice(&(av.len() as u16).to_le_bytes());
            fake.extend_from_slice(&(av.len() as u16).to_le_bytes());
            fake.extend_from_slice(&48u32.to_le_bytes());
            fake.extend_from_slice(av);
            fake
        })
        .ok()?;
        let bindings = info.av.iter().find(|(id, _)| *id == AV_CHANNEL_BINDINGS)?;
        if bindings.1 != channel_bindings(cert) {
            return None;
        }
        let session_key = hmac_md5(&key, &[proof]);
        let mut zeroed = auth.to_vec();
        zeroed[MIC_AT..AUTH_HEADER].fill(0);
        if hmac_md5(&session_key, &[negotiate, challenge, &zeroed]) != auth[MIC_AT..AUTH_HEADER] {
            return None;
        }
        Some((user, domain))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// MS-NLMP 4.2.4: NTLMv2 authentication of User\Domain with "Password".
    #[test]
    fn matches_the_specification_vectors() {
        let key = ntowfv2("Password", "User", "Domain");
        assert_eq!(hex(&key), "0c868a403bfd7a93a3001ef22ef02e3f");
        let server = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
        let client = [0xaa; 8];
        assert_eq!(
            hex(&lm_response(&key, &server, &client)),
            "86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa"
        );
        let mut av = Vec::new();
        for (id, v) in [(2u16, "Domain"), (1, "Server")] {
            av.extend_from_slice(&id.to_le_bytes());
            av.extend_from_slice(&((v.len() * 2) as u16).to_le_bytes());
            av.extend_from_slice(&utf16(v));
        }
        av.extend_from_slice(&[0; 4]);
        let (_, proof) = nt_response(&key, &server, &client, 0, &av);
        assert_eq!(hex(&proof), "68cd0ab851e51c96aabc927bebef6a1c");
        assert_eq!(hex(&hmac_md5(&key, &[&proof])), "8de40ccadbc14a82f15cb0ad0de95ca3");
    }

    #[test]
    fn splits_logins() {
        let l = Login::new("CORP\\ivan", "p");
        assert_eq!((l.domain, l.user), ("CORP", "ivan"));
        let l = Login::new("ivan@corp.ru", "p");
        assert_eq!((l.domain, l.user), ("", "ivan@corp.ru"));
    }

    #[test]
    fn handshake_passes_the_server_check() {
        let cert = b"not really DER, hashed with SHA-256 anyway";
        let (client, negotiate) = Client::new();
        assert_eq!(negotiate.len(), 40);
        let challenge = server::challenge("CORP");
        let auth = client
            .authenticate(
                &challenge,
                &Login::new("CORP\\ivan", "secret"),
                "mail.corp.ru",
                Some(cert),
            )
            .unwrap();
        assert_eq!(
            server::verify(&negotiate, &challenge, &auth, "secret", Some(cert)),
            Some(("ivan".into(), "CORP".into()))
        );
        assert_eq!(server::verify(&negotiate, &challenge, &auth, "wrong", Some(cert)), None);
        // Another certificate: a man in the middle relaying the login is caught.
        assert_eq!(
            server::verify(&negotiate, &challenge, &auth, "secret", Some(b"other")),
            None
        );
        // The target name names the HTTP service of the host.
        let spn = utf16("HTTP/mail.corp.ru");
        assert!(auth.windows(spn.len()).any(|w| w == spn));
    }

    #[test]
    fn rejects_garbage_challenges() {
        let (client, _) = Client::new();
        let login = Login::new("u", "p");
        assert!(client.authenticate(b"NTLMSSP\0", &login, "h", None).is_err());
        let mut ch = server::challenge("D");
        ch[44] = 0xff;
        assert!(client.authenticate(&ch, &login, "h", None).is_err());
    }
}
