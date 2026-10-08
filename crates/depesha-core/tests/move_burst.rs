//! The "held `e`" burst: a series of single-message moves in one mailbox must not stall
//! another mailbox sharing the same cache. A core-level reproduction of what the account
//! worker does per `Work::Move` (one MOVE, then a sync of the source and the target folder),
//! with a second account reading its list and opening its letters meanwhile.
//! Skipped unless DEPESHA_IT=1, see compose.test.yaml.

use std::sync::Arc;
use std::time::{Duration, Instant};

use depesha_core::Error;
use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap::{self, Conn};
use depesha_core::store::{ListQuery, Store};
use depesha_core::sync::{self, SyncOptions};

fn enabled() -> bool {
    std::env::var("DEPESHA_IT").is_ok_and(|v| v == "1")
}

/// Dovecot's test image accepts any user name with the configured password: every test
/// gets its own mailboxes, so parallel tests do not see each other's mail.
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

/// What the worker now does with a held "archive" key: one `UID MOVE` for all the letters
/// at once, one sync of each folder, and "z" (a move back by Message-ID) still finds them.
#[tokio::test]
async fn a_coalesced_move_of_a_uid_set_is_undone_by_message_id() {
    if !enabled() {
        return;
    }
    let mut conn = connect("coalesce").await;
    conn.session.create("Archive").await.unwrap();
    let n = 50usize;
    for i in 0..n {
        imap::append(&mut conn, "INBOX", &mail(&format!("C {i}"), i), "")
            .await
            .unwrap();
    }
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "c").await.unwrap();
    let opts = SyncOptions { initial_limit: 500 };
    sync::sync_folder(&mut conn, &store, "c", "INBOX", opts).await.unwrap();

    let rows = store
        .list(&ListQuery {
            account_id: Some("c".into()),
            folder: Some("INBOX".into()),
            limit: 500,
            ..Default::default()
        })
        .unwrap();
    let uids: Vec<u32> = rows.iter().map(|m| m.uid).collect();
    let mids: Vec<String> = rows.iter().filter_map(|m| m.message_id.clone()).collect();
    assert_eq!(uids.len(), n);

    // One request for the whole series, as `gather_moves` builds it.
    let started = Instant::now();
    imap::move_messages(&mut conn, "INBOX", None, &uids, "Archive")
        .await
        .unwrap();
    sync::sync_folder(&mut conn, &store, "c", "INBOX", opts).await.unwrap();
    sync::sync_folder(&mut conn, &store, "c", "Archive", opts)
        .await
        .unwrap();
    let burst = started.elapsed();
    assert_eq!(
        store
            .list(&ListQuery {
                account_id: Some("c".into()),
                folder: Some("INBOX".into()),
                limit: 500,
                ..Default::default()
            })
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        store
            .list(&ListQuery {
                account_id: Some("c".into()),
                folder: Some("Archive".into()),
                limit: 500,
                ..Default::default()
            })
            .unwrap()
            .len(),
        n
    );

    // "z": the letters come back by Message-ID, which the coalesced move kept.
    let mut conn = depesha_core::mail::Conn::Imap(conn);
    let back = depesha_core::mail::move_by_message_id(&mut conn, &store, "c", "Archive", &mids, "INBOX", false)
        .await
        .unwrap();
    assert_eq!(back, n);
    eprintln!("coalesced burst of {n}: one UID MOVE and two syncs in {burst:?}");
    let depesha_core::mail::Conn::Imap(conn) = &mut conn else {
        unreachable!()
    };
    sync::sync_folder(conn, &store, "c", "INBOX", opts).await.unwrap();
    sync::sync_folder(conn, &store, "c", "Archive", opts).await.unwrap();
    assert_eq!(
        store
            .list(&ListQuery {
                account_id: Some("c".into()),
                folder: Some("INBOX".into()),
                limit: 500,
                ..Default::default()
            })
            .unwrap()
            .len(),
        n
    );
    conn.session.logout().await.unwrap();
}

/// A burst of single-message archives in `a` must not keep `b` from listing and opening
/// its mail: the cache is shared, the mailbox's own queue must not be.
#[tokio::test]
async fn a_move_burst_in_one_mailbox_does_not_stall_another() {
    if !enabled() {
        return;
    }
    let mut conn_a = connect("burstA").await;
    let mut conn_b = connect("burstB").await;
    conn_a.session.create("Archive").await.unwrap();

    let n_inbox = 100usize;
    let n_other = 20usize;
    for i in 0..n_inbox {
        imap::append(&mut conn_a, "INBOX", &mail(&format!("A {i}"), i), "")
            .await
            .unwrap();
    }
    for i in 0..n_other {
        imap::append(&mut conn_b, "INBOX", &mail(&format!("B {i}"), i), "")
            .await
            .unwrap();
    }

    let store = Arc::new(Store::open_in_memory().unwrap());
    sync::sync_folder_list(&mut conn_a, &store, "a").await.unwrap();
    sync::sync_folder_list(&mut conn_b, &store, "b").await.unwrap();
    let opts = SyncOptions { initial_limit: 500 };
    sync::sync_folder(&mut conn_a, &store, "a", "INBOX", opts)
        .await
        .unwrap();
    sync::sync_folder(&mut conn_b, &store, "b", "INBOX", opts)
        .await
        .unwrap();

    let inbox_a: Vec<u32> = store
        .list(&ListQuery {
            account_id: Some("a".into()),
            folder: Some("INBOX".into()),
            limit: 500,
            ..Default::default()
        })
        .unwrap()
        .iter()
        .map(|m| m.uid)
        .collect();
    assert_eq!(inbox_a.len(), n_inbox);

    // The letters of `b` that `b` opens while `a` bursts.
    let b_rows = store
        .list(&ListQuery {
            account_id: Some("b".into()),
            folder: Some("INBOX".into()),
            limit: 500,
            ..Default::default()
        })
        .unwrap();
    let b_ids: Vec<i64> = b_rows.iter().map(|m| m.id).collect();

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let burst_started = Instant::now();
    let burst = {
        let stop = stop.clone();
        let a_store = store.clone();
        tokio::spawn(async move {
            let mut ops = 0usize;
            let opts = SyncOptions { initial_limit: 500 };
            for uid in inbox_a.into_iter().take(50) {
                imap::move_messages(&mut conn_a, "INBOX", None, &[uid], "Archive")
                    .await
                    .unwrap();
                sync::sync_folder(&mut conn_a, &a_store, "a", "INBOX", opts)
                    .await
                    .unwrap();
                sync::sync_folder(&mut conn_a, &a_store, "a", "Archive", opts)
                    .await
                    .unwrap();
                ops += 3;
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            ops
        })
    };

    // `b` reads its list and opens its letters while the burst runs.
    let mut worst_list = Duration::ZERO;
    let mut worst_open = Duration::ZERO;
    let mut rounds = 0usize;
    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        let t = Instant::now();
        let _ = store
            .list(&ListQuery {
                account_id: Some("b".into()),
                folder: Some("INBOX".into()),
                limit: 500,
                ..Default::default()
            })
            .unwrap();
        worst_list = worst_list.max(t.elapsed());

        let id = b_ids[rounds % b_ids.len()];
        let t = Instant::now();
        // The opening path: cached body first, the network only when it is missing.
        if store.body(id).unwrap().is_none() {
            sync::load_body(&mut conn_b, &store, id).await.unwrap();
        }
        worst_open = worst_open.max(t.elapsed());
        rounds += 1;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let ops = burst.await.unwrap();

    eprintln!(
        "move burst: {ops} server operations in {:?}, {rounds} reads in the other mailbox; \
         worst list {worst_list:?}, worst open {worst_open:?}",
        burst_started.elapsed()
    );
    assert!(
        worst_open < Duration::from_secs(1),
        "opening a letter in another mailbox waited {worst_open:?}"
    );
    assert!(
        worst_list < Duration::from_secs(1),
        "listing another mailbox waited {worst_list:?}"
    );
    conn_b.session.logout().await.unwrap();
}
