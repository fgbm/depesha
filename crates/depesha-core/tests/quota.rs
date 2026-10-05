//! The server's capabilities, its quota (GETQUOTAROOT) and folder sizes (STATUS=SIZE,
//! or RFC822.SIZE added up) against a scripted IMAP server. Needs no network beyond
//! localhost; always runs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap::{self, Conn, Enabled};
use depesha_core::quota::{self, FolderSize, Quota, SizeMethod};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(Default)]
struct Server {
    /// Listed in the greeting and after login.
    caps: &'static str,
    /// Folder: message sizes; a folder missing here is refused (no rights).
    folders: HashMap<&'static str, Vec<u64>>,
    /// Answers ENABLE with NO.
    refuse_enable: bool,
    /// Names the mailbox of a STATUS answer as a literal.
    literal_names: bool,
    log: Vec<String>,
}

type Shared = Arc<Mutex<Server>>;

async fn serve(server: Shared) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(session(stream, server.clone()));
        }
    });
    port
}

async fn session(stream: tokio::net::TcpStream, server: Shared) {
    let (r, mut w) = stream.into_split();
    let mut lines = BufReader::new(r).lines();
    let caps = server.lock().unwrap().caps;
    w.write_all(format!("* OK [CAPABILITY IMAP4rev1 {caps}] scripted ready\r\n").as_bytes())
        .await
        .unwrap();
    while let Ok(Some(line)) = lines.next_line().await {
        let (tag, cmd) = line.split_once(' ').unwrap();
        let reply = {
            let mut server = server.lock().unwrap();
            server.log.push(cmd.to_owned());
            respond(&server, tag, cmd)
        };
        w.write_all(reply.as_bytes()).await.unwrap();
        if cmd.starts_with("LOGOUT") {
            return;
        }
    }
}

fn name_of(cmd: &str) -> &str {
    let rest = cmd.split_once(' ').unwrap().1;
    let rest = rest.strip_prefix('"').unwrap();
    &rest[..rest.find('"').unwrap()]
}

fn respond(server: &Server, tag: &str, cmd: &str) -> String {
    let ok = |out: String| format!("{out}{tag} OK done\r\n");
    let upper = cmd.to_ascii_uppercase();
    if upper.starts_with("CAPABILITY") {
        return ok(format!("* CAPABILITY IMAP4rev1 {}\r\n", server.caps));
    }
    if upper.starts_with("ENABLE") {
        return if server.refuse_enable {
            format!("{tag} NO ENABLE not permitted for this user\r\n")
        } else {
            ok("* ENABLED QRESYNC\r\n".into())
        };
    }
    if upper.starts_with("GETQUOTAROOT INBOX") {
        return ok("* QUOTAROOT INBOX \"User quota\"\r\n\
                   * QUOTA \"User quota\" (STORAGE 3250585 10485760 MESSAGE 1200 0)\r\n"
            .into());
    }
    if upper.starts_with("STATUS ") {
        let name = name_of(cmd);
        let Some(sizes) = server.folders.get(name) else {
            return format!("{tag} NO [NOPERM] Permission denied\r\n");
        };
        let total: u64 = sizes.iter().sum();
        let mailbox = if server.literal_names {
            format!("{{{}}}\r\n{name}", name.len())
        } else {
            format!("\"{name}\"")
        };
        return ok(format!(
            "* STATUS {mailbox} (MESSAGES {} SIZE {total})\r\n",
            sizes.len()
        ));
    }
    if upper.starts_with("EXAMINE ") {
        let Some(sizes) = server.folders.get(name_of(cmd)) else {
            return format!("{tag} NO [NOPERM] Permission denied\r\n");
        };
        return ok(format!(
            "* FLAGS (\\Seen)\r\n* {} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n",
            sizes.len()
        ));
    }
    if upper.starts_with("FETCH 1:* (RFC822.SIZE)") {
        // The last folder examined is the one in the log before this command.
        let examined = server.log.iter().rev().find(|c| c.starts_with("EXAMINE")).unwrap();
        let sizes = &server.folders[name_of(examined)];
        let mut out = String::new();
        for (i, size) in sizes.iter().enumerate() {
            out += &format!("* {} FETCH (RFC822.SIZE {size})\r\n", i + 1);
        }
        return ok(out);
    }
    ok(String::new())
}

async fn fixture(server: Server) -> (Shared, Conn) {
    let server = Arc::new(Mutex::new(server));
    let port = serve(server.clone()).await;
    let config = ServerConfig::new("127.0.0.1", port, Security::Plain);
    let conn = imap::connect(&config, &Credentials::new("alice", "secret"))
        .await
        .unwrap();
    (server, conn)
}

fn folders() -> HashMap<&'static str, Vec<u64>> {
    HashMap::from([
        ("INBOX", vec![1000, 2000, 3000]),
        ("Archive", vec![50_000]),
        ("Empty", vec![]),
        ("&BB4EQgRHBFEEQgRL-", vec![7, 8]),
    ])
}

fn names() -> Vec<String> {
    ["INBOX", "Archive", "Empty", "&BB4EQgRHBFEEQgRL-", "Secret"]
        .map(str::to_owned)
        .to_vec()
}

fn size(folder: &str, bytes: u64, messages: u64) -> FolderSize {
    FolderSize {
        folder: folder.into(),
        bytes: Some(bytes),
        messages: Some(messages),
        error: None,
    }
}

#[tokio::test]
async fn a_modern_server_reports_its_quota_and_folder_sizes() {
    let (server, mut conn) = fixture(Server {
        caps: "IDLE MOVE QUOTA STATUS=SIZE QRESYNC X-SECRET",
        folders: folders(),
        literal_names: true,
        ..Server::default()
    })
    .await;
    // What the login found, kept as the server listed it.
    assert!(conn.caps.quota && conn.caps.status_size && conn.caps.idle && conn.caps.move_);
    assert!(conn.capabilities.iter().any(|c| c == "X-SECRET"));
    assert_eq!(conn.capabilities[0], "IMAP4rev1");
    let greeting = conn.greeting.clone().unwrap();
    assert!(
        greeting.starts_with("* OK [CAPABILITY IMAP4rev1 IDLE MOVE"),
        "{greeting}"
    );

    imap::enable_qresync(&mut conn).await.unwrap();
    assert_eq!(
        conn.enabled,
        Some(Enabled {
            ok: true,
            answer: "ENABLED QRESYNC".into()
        })
    );
    assert!(conn.qresync);

    let quota = quota::quota(&mut conn).await.unwrap().unwrap();
    assert_eq!(
        quota,
        Quota {
            root: "User quota".into(),
            used: 3_250_585 * 1024,
            limit: 10_485_760 * 1024,
            messages: Some((1200, 0)),
        }
    );

    let mut done = Vec::new();
    let (method, sizes) = quota::folder_sizes(&mut conn, &names(), |n| done.push(n))
        .await
        .unwrap();
    assert_eq!(method, SizeMethod::Status);
    assert_eq!(done, [1, 2, 3, 4, 5]);
    assert_eq!(sizes[0], size("INBOX", 6000, 3));
    assert_eq!(sizes[1], size("Archive", 50_000, 1));
    assert_eq!(sizes[2], size("Empty", 0, 0));
    assert_eq!(sizes[3], size("&BB4EQgRHBFEEQgRL-", 15, 2));
    // A folder the server refuses is left out with the reason, not counted as empty.
    assert_eq!(sizes[4].bytes, None);
    assert_eq!(sizes[4].error.as_deref(), Some("[NOPERM] Permission denied"));

    // One STATUS per folder; no message is fetched.
    let log = server.lock().unwrap().log.clone();
    assert_eq!(log.iter().filter(|c| c.starts_with("STATUS")).count(), 5);
    assert!(log.contains(&"STATUS \"INBOX\" (MESSAGES SIZE)".to_owned()), "{log:?}");
    assert!(!log.iter().any(|c| c.starts_with("FETCH") || c.starts_with("EXAMINE")));
}

#[tokio::test]
async fn an_old_server_has_no_quota_and_its_sizes_are_added_up() {
    let (server, mut conn) = fixture(Server {
        caps: "QRESYNC",
        folders: folders(),
        refuse_enable: true,
        ..Server::default()
    })
    .await;
    assert!(!conn.caps.quota && !conn.caps.status_size && !conn.caps.idle);

    // Offered but refused: the session goes on without it, and the reason is kept.
    imap::enable_qresync(&mut conn).await.unwrap();
    assert!(!conn.qresync && !conn.caps.qresync);
    assert_eq!(
        conn.enabled,
        Some(Enabled {
            ok: false,
            answer: "ENABLE not permitted for this user".into()
        })
    );

    // No QUOTA: not asked, nothing to show.
    assert_eq!(quota::quota(&mut conn).await.unwrap(), None);
    assert!(!server.lock().unwrap().log.iter().any(|c| c.starts_with("GETQUOTAROOT")));

    let (method, sizes) = quota::folder_sizes(&mut conn, &names(), |_| {}).await.unwrap();
    assert_eq!(method, SizeMethod::Fetch);
    assert_eq!(sizes[0], size("INBOX", 6000, 3));
    assert_eq!(sizes[1], size("Archive", 50_000, 1));
    assert_eq!(sizes[2], size("Empty", 0, 0));
    assert_eq!(sizes[3], size("&BB4EQgRHBFEEQgRL-", 15, 2));
    assert!(sizes[4].bytes.is_none() && sizes[4].error.is_some());

    // An empty folder is not fetched; a refused one neither.
    let log = server.lock().unwrap().log.clone();
    assert_eq!(log.iter().filter(|c| c.starts_with("FETCH")).count(), 3, "{log:?}");
    assert!(!log.iter().any(|c| c.starts_with("STATUS")));
}
