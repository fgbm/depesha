//! Compatibility with Dovecot 2.4, the most common IMAP server, see compose.test.yaml.
//! Dovecot refuses cleartext login, so everything goes through STARTTLS with
//! its self-signed certificate pinned. Skipped unless DEPESHA_IT=1.

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap::{self, Conn, FlagChange, FolderRole, IdleOutcome};
use depesha_core::store::{ListQuery, Store};
use depesha_core::sync::{self, SyncOptions};
use depesha_core::{Error, utf7};

fn enabled() -> bool {
    std::env::var("DEPESHA_IT").is_ok_and(|v| v == "1")
}

/// Dovecot's test image accepts any user name with the configured password:
/// every test gets its own mailbox, so parallel tests do not see each other's mail.
fn user(test: &str) -> Credentials {
    Credentials::new(format!("{test}{}", std::process::id()), "secret")
}

/// STARTTLS server config with Dovecot's self-signed certificate pinned.
async fn server() -> ServerConfig {
    let mut s = ServerConfig::new("localhost", 31143, Security::StartTls);
    match imap::connect(&s, &user("probe")).await {
        Err(Error::Certificate(p)) => s.trusted_cert = Some(p.sha256),
        Ok(_) => {}
        Err(e) => panic!("unexpected: {e:?}"),
    }
    s
}

fn mail(subject: &str, n: usize) -> Vec<u8> {
    format!(
        "From: Тест <test@example.org>\r\nTo: me@example.org\r\nSubject: {subject}\r\nMessage-ID: <{n}.{subject}@example.org>\r\n\
         Date: Fri, 2 Oct 2026 10:{:02}:00 +0300\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nТело {n}\r\n",
        n % 60
    )
    .replace(' ', " ")
    .into_bytes()
}

async fn connect(test: &str) -> Conn {
    imap::connect(&server().await, &user(test))
        .await
        .expect("login over STARTTLS")
}

#[tokio::test]
async fn cleartext_login_is_refused_as_no_tls() {
    if !enabled() {
        return;
    }
    let plain = ServerConfig::new("127.0.0.1", 31143, Security::Plain);
    let err = imap::connect(&plain, &user("plain")).await.err().expect("must refuse");
    assert!(matches!(err, Error::NoTls), "{err:?}");
}

#[tokio::test]
async fn starttls_sync_move_and_fallbacks() {
    if !enabled() {
        return;
    }
    let mut conn = connect("sync").await;
    assert!(
        conn.caps.idle && conn.caps.move_ && conn.caps.uidplus,
        "{:?}",
        conn.caps
    );

    for name in ["Sent", "Trash", "Работа/Отчёты"] {
        conn.session
            .create(utf7::encode(name))
            .await
            .unwrap_or_else(|e| panic!("create {name}: {e}"));
    }
    for i in 0..30 {
        imap::append(&mut conn, "INBOX", &mail(&format!("Письмо {i}"), i), "")
            .await
            .unwrap();
    }

    let store = Store::open_in_memory().unwrap();
    let folders = sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();
    assert!(folders.iter().any(|f| f.display_name == "Работа/Отчёты"), "{folders:?}");
    assert_eq!(
        folders.iter().find(|f| f.name == "Trash").and_then(|f| f.role),
        Some(FolderRole::Trash)
    );

    let small = SyncOptions { initial_limit: 20 };
    let r = sync::sync_folder(&mut conn, &store, "d", "INBOX", small).await.unwrap();
    assert_eq!(r.added, 20, "first sync takes the newest window");
    assert_eq!(
        sync::load_older(&mut conn, &store, "d", "INBOX", 100).await.unwrap(),
        10
    );

    let rows = store
        .list(&ListQuery {
            account_id: Some("d".into()),
            folder: Some("INBOX".into()),
            limit: 100,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(rows.len(), 30);
    let raw = sync::load_body(&mut conn, &store, rows[0].id).await.unwrap();
    assert!(String::from_utf8_lossy(&raw).contains("Тело"));

    imap::set_flag(&mut conn, "INBOX", &[rows[0].uid], FlagChange::Flagged(true))
        .await
        .unwrap();
    assert_eq!(
        sync::sync_folder(&mut conn, &store, "d", "INBOX", small)
            .await
            .unwrap()
            .updated,
        1
    );

    // MOVE.
    imap::move_messages(&mut conn, "INBOX", &[rows[1].uid], "Trash")
        .await
        .unwrap();
    assert_eq!(
        sync::sync_folder(&mut conn, &store, "d", "INBOX", small)
            .await
            .unwrap()
            .removed,
        1
    );

    // Old server without MOVE and UIDPLUS: COPY + \Deleted, no EXPUNGE that could hit others' mail.
    conn.caps.move_ = false;
    conn.caps.uidplus = false;
    imap::move_messages(&mut conn, "INBOX", &[rows[2].uid], "Trash")
        .await
        .unwrap();
    let r = sync::sync_folder(&mut conn, &store, "d", "INBOX", small).await.unwrap();
    assert_eq!(r.removed, 1, "a \\Deleted message disappears from the list");
    let status = conn.session.select("INBOX").await.unwrap();
    assert_eq!(
        status.exists, 29,
        "without UIDPLUS the original stays on the server, marked deleted"
    );
    conn.caps.move_ = true;
    conn.caps.uidplus = true;

    sync::sync_folder(&mut conn, &store, "d", "Trash", small).await.unwrap();
    let trash = store
        .list(&ListQuery {
            account_id: Some("d".into()),
            folder: Some("Trash".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(trash.len(), 2);
    imap::delete_permanently(&mut conn, "Trash", &trash.iter().map(|m| m.uid).collect::<Vec<_>>())
        .await
        .unwrap();
    assert_eq!(conn.session.select("Trash").await.unwrap().exists, 0);
    conn.session.logout().await.unwrap();
}

#[tokio::test]
async fn server_search_finds_uncached_mail_in_russian() {
    if !enabled() {
        return;
    }
    let mut conn = connect("search").await;
    for i in 0..40 {
        let subject = if i == 3 {
            "Договор поставки"
        } else {
            "Обычное письмо"
        };
        imap::append(&mut conn, "INBOX", &mail(subject, i), "").await.unwrap();
    }
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "s").await.unwrap();
    // Only the newest 10 are cached; the contract is old.
    sync::sync_folder(&mut conn, &store, "s", "INBOX", SyncOptions { initial_limit: 10 })
        .await
        .unwrap();
    assert!(store.search("договор", None, 0).unwrap().is_empty());

    for literal_plus in [true, false] {
        conn.caps.literal_plus = literal_plus;
        let ids = sync::search_server(&mut conn, &store, "s", "INBOX", "договор")
            .await
            .unwrap();
        assert_eq!(ids.len(), 1, "literal_plus={literal_plus}");
        assert_eq!(store.get(ids[0]).unwrap().unwrap().subject, "Договор поставки");
    }
    let ids = sync::search_server(&mut conn, &store, "s", "INBOX", "example")
        .await
        .unwrap();
    assert_eq!(ids.len(), 40, "ASCII query path");
    // The session is still in sync after the hand-written literal exchange.
    conn.session.noop().await.unwrap();
    conn.session.logout().await.unwrap();
}

#[tokio::test]
async fn idle_wakes_up_on_append_from_another_session() {
    if !enabled() {
        return;
    }
    let idle = connect("idle").await;
    let waiter = tokio::spawn(async move {
        imap::wait_for_changes(idle, "INBOX", std::time::Duration::from_secs(2))
            .await
            .map(|(_, o)| o)
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let mut other = connect("idle").await;
    imap::append(&mut other, "INBOX", &mail("IDLE", 1), "").await.unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), waiter)
        .await
        .expect("no wakeup");
    assert!(matches!(outcome.unwrap().unwrap(), IdleOutcome::Changed));
}
