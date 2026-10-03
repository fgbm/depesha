//! Large mailbox timings against Dovecot (criteria 3.4, 6.4, 7.2 backend side).
//!
//!   docker compose -f compose.test.yaml up -d dovecot && scripts/perf-fill.py
//!   DEPESHA_IT=1 cargo test --release -p depesha-core --test perf -- --ignored --nocapture

use std::time::Instant;

use depesha_core::Error;
use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap;
use depesha_core::store::{ListQuery, Store};
use depesha_core::sync::{self, SyncOptions};

const N: usize = 50_000;

#[tokio::test]
#[ignore = "slow: fills a mailbox with 50 000 messages"]
async fn fifty_thousand_messages() {
    assert!(
        std::env::var("DEPESHA_IT").is_ok_and(|v| v == "1"),
        "needs DEPESHA_IT=1 and Dovecot"
    );
    // Filled beforehand by scripts/perf-fill.py: APPEND of 50 000 messages takes half an hour.
    let user = Credentials::new(
        std::env::var("DEPESHA_PERF_USER").unwrap_or_else(|_| "perfbulk".into()),
        "secret",
    );
    let mut server = ServerConfig::new("localhost", 31143, Security::StartTls);
    if let Err(Error::Certificate(p)) = imap::connect(&server, &user).await {
        server.trusted_cert = Some(p.sha256);
    }
    let mut conn = imap::connect(&server, &user).await.unwrap();
    let t = Instant::now();
    let exists = conn.session.select("INBOX").await.unwrap().exists as usize;
    println!(
        "server SELECT of {exists} (Dovecot indexes on first access): {:.1} s",
        t.elapsed().as_secs_f32()
    );
    assert_eq!(exists, N, "run scripts/perf-fill.py first");

    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("mail.sqlite")).unwrap();
    sync::sync_folder_list(&mut conn, &store, "p").await.unwrap();

    let t = Instant::now();
    let r = sync::sync_folder(&mut conn, &store, "p", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    let first = t.elapsed();
    println!("first sync (newest {}): {:.2} s", r.added, first.as_secs_f32());
    assert!(first.as_secs() < 30, "criterion 3.4: newest 500 under 30 s");

    let t = Instant::now();
    let r = sync::sync_folder(&mut conn, &store, "p", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    println!("resync, nothing changed: {:.2} s ({r:?})", t.elapsed().as_secs_f32());

    let t = Instant::now();
    let mut total = 500;
    loop {
        let n = sync::load_older(&mut conn, &store, "p", "INBOX", 5000).await.unwrap();
        if n == 0 {
            break;
        }
        total += n;
    }
    println!("all headers ({total}): {:.1} s", t.elapsed().as_secs_f32());
    assert_eq!(total, N);

    let t = Instant::now();
    let r = sync::sync_folder(&mut conn, &store, "p", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    println!("resync with {N} cached: {:.2} s ({r:?})", t.elapsed().as_secs_f32());

    let t = Instant::now();
    let rows = store
        .list(&ListQuery {
            limit: 200,
            ..Default::default()
        })
        .unwrap();
    println!(
        "unified inbox page: {:.1} ms ({} rows)",
        t.elapsed().as_secs_f64() * 1000.0,
        rows.len()
    );
    let t = Instant::now();
    let rows = store
        .list(&ListQuery {
            limit: 200,
            offset: 40_000,
            ..Default::default()
        })
        .unwrap();
    println!(
        "deep page (offset 40000): {:.1} ms ({} rows)",
        t.elapsed().as_secs_f64() * 1000.0,
        rows.len()
    );

    let threads = ListQuery {
        limit: 200,
        threads: true,
        ..Default::default()
    };
    let t = Instant::now();
    let rows = store.list(&threads).unwrap();
    let grouped = t.elapsed();
    println!(
        "conversations page: {:.1} ms ({} rows)",
        grouped.as_secs_f64() * 1000.0,
        rows.len()
    );
    assert!(grouped.as_millis() < 500, "grouped list must stay interactive");
    let t = Instant::now();
    let rows = store
        .list(&ListQuery {
            offset: 40_000,
            ..threads
        })
        .unwrap();
    println!(
        "conversations, offset 40000: {:.1} ms ({} rows)",
        t.elapsed().as_secs_f64() * 1000.0,
        rows.len()
    );

    let t = Instant::now();
    let found = store
        .search("от:отправитель тема:счёт после:2026-01-01", None, 300)
        .unwrap();
    println!(
        "search with operators: {:.1} ms ({} hits)",
        t.elapsed().as_secs_f64() * 1000.0,
        found.len()
    );

    let t = Instant::now();
    let found = store.search("счёт 42", None, 300).unwrap();
    let search = t.elapsed();
    println!(
        "search over {N}: {:.1} ms ({} hits)",
        search.as_secs_f64() * 1000.0,
        found.len()
    );
    assert!(search.as_millis() < 1000, "criterion 6.4: under a second");
    assert!(!found.is_empty());

    let t = Instant::now();
    let found = store.search("Отправитель", None, 300).unwrap();
    println!(
        "search, broad term: {:.1} ms ({} hits)",
        t.elapsed().as_secs_f64() * 1000.0,
        found.len()
    );
    conn.session.logout().await.unwrap();
}
