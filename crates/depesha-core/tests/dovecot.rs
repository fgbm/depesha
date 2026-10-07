//! Compatibility with Dovecot 2.4, the most common IMAP server, see compose.test.yaml.
//! Dovecot refuses cleartext login, so everything goes through STARTTLS with
//! its self-signed certificate pinned. Skipped unless DEPESHA_IT=1.

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::imap::{self, Conn, FlagChange, FolderRole, IdleOutcome};
use depesha_core::query::{self, SearchQuery};
use depesha_core::store::{ListQuery, Store};
use depesha_core::sync::{self, SyncOptions};
use depesha_core::{Error, mail, utf7};

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

    imap::set_flag(&mut conn, "INBOX", None, &[rows[0].uid], FlagChange::Flagged(true))
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
    imap::move_messages(&mut conn, "INBOX", None, &[rows[1].uid], "Trash")
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
    imap::move_messages(&mut conn, "INBOX", None, &[rows[2].uid], "Trash")
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
    imap::delete_permanently(
        &mut conn,
        "Trash",
        None,
        &trash.iter().map(|m| m.uid).collect::<Vec<_>>(),
    )
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
    assert!(store.search("договор", None, 0, &[]).unwrap().is_empty());

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
async fn search_operators_and_snoozed_folder() {
    if !enabled() {
        return;
    }
    let mut conn = connect("ops").await;
    let from_ivan = "From: =?utf-8?B?0JjQstCw0L0g0J/QtdGC0YDQvtCy?= <ivan@example.org>\r\nTo: me@example.org\r\n\
         Subject: =?utf-8?B?0JDQutGCINGB0LLQtdGA0LrQuA==?=\r\nMessage-ID: <act@example.org>\r\n\
         Date: Fri, 2 Oct 2026 10:00:00 +0300\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nx\r\n";
    imap::append(&mut conn, "INBOX", from_ivan.as_bytes(), "")
        .await
        .unwrap();
    imap::append(&mut conn, "INBOX", &mail("Акт приёмки", 1), "")
        .await
        .unwrap();
    imap::append(&mut conn, "INBOX", &mail("Другое", 2), "").await.unwrap();

    // Two Cyrillic values: two literals in one command, both ways of sending them.
    let q = SearchQuery::parse("от:Иван тема:акт");
    for literal_plus in [true, false] {
        conn.caps.literal_plus = literal_plus;
        let uids = imap::search(&mut conn, "INBOX", &query::imap_criteria(&q))
            .await
            .unwrap();
        assert_eq!(uids.len(), 1, "literal_plus={literal_plus}");
    }
    let q = SearchQuery::parse("тема:акт is:unread");
    assert_eq!(
        imap::search(&mut conn, "INBOX", &query::imap_criteria(&q))
            .await
            .unwrap()
            .len(),
        2
    );
    conn.session.noop().await.unwrap();

    // The Snoozed folder is created once and recognised by name.
    imap::create_folder(&mut conn, "Отложенные").await.unwrap();
    imap::create_folder(&mut conn, "Отложенные").await.unwrap();
    let folders = imap::list_folders(&mut conn).await.unwrap();
    let snoozed = folders
        .iter()
        .find(|f| f.role == Some(FolderRole::Snoozed))
        .expect("snoozed role");
    assert_eq!(snoozed.display_name, "Отложенные");

    // There and back by Message-ID, as undo and snooze do.
    let uids = imap::find_by_message_id(&mut conn, "INBOX", "<act@example.org>")
        .await
        .unwrap();
    imap::move_messages(&mut conn, "INBOX", None, &uids, &snoozed.name)
        .await
        .unwrap();
    let back = imap::find_by_message_id(&mut conn, &snoozed.name, "act@example.org")
        .await
        .unwrap();
    assert_eq!(back.len(), 1);
    imap::move_messages(&mut conn, &snoozed.name, None, &back, "INBOX")
        .await
        .unwrap();
    assert_eq!(
        imap::find_by_message_id(&mut conn, "INBOX", "act@example.org")
            .await
            .unwrap()
            .len(),
        1
    );
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

/// The folder is deleted and created again between reading UIDs from the cache and
/// acting on them: the same UIDs name other letters, and nothing is done to them.
#[tokio::test]
async fn actions_on_uids_of_a_recreated_folder_are_refused() {
    if !enabled() {
        return;
    }
    let mut conn = connect("renumbered").await;
    for name in ["Box", "Trash"] {
        conn.session.create(name).await.unwrap();
    }
    for i in 0..3 {
        imap::append(&mut conn, "Box", &mail(&format!("Старое {i}"), i), "")
            .await
            .unwrap();
    }
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();
    sync::sync_folder(&mut conn, &store, "d", "Box", SyncOptions::default())
        .await
        .unwrap();
    let (validity, _) = store.folder_state("d", "Box").unwrap();
    let uids = store.known_uids("d", "Box").unwrap();
    assert_eq!(uids.len(), 3);

    conn.session.select("INBOX").await.unwrap();
    conn.session.delete("Box").await.unwrap();
    conn.session.create("Box").await.unwrap();
    for i in 0..3 {
        imap::append(&mut conn, "Box", &mail(&format!("Новое {i}"), i + 10), "")
            .await
            .unwrap();
    }

    let mut conn = mail::Conn::Imap(conn);
    let refused = |r: depesha_core::Result<()>| assert!(matches!(r, Err(Error::FolderChanged)), "{r:?}");
    refused(
        mail::set_flag(
            &mut conn,
            &store,
            "d",
            "Box",
            validity,
            &uids,
            FlagChange::Flagged(true),
        )
        .await,
    );
    refused(mail::move_messages(&mut conn, &store, "d", "Box", validity, &uids, "Trash").await);
    refused(mail::delete_permanently(&mut conn, &store, "d", "Box", validity, &uids).await);
    let mail::Conn::Imap(mut conn) = conn else {
        unreachable!()
    };

    // The new letters are all in place, none flagged, and the trash is empty.
    sync::sync_folder(&mut conn, &store, "d", "Box", SyncOptions::default())
        .await
        .unwrap();
    assert_ne!(store.folder_state("d", "Box").unwrap().0, validity, "a new UIDVALIDITY");
    let box_ = store
        .list(&ListQuery {
            account_id: Some("d".into()),
            folder: Some("Box".into()),
            limit: 100,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(box_.len(), 3);
    assert!(box_.iter().all(|m| m.subject.starts_with("Новое") && !m.flags.flagged));
    let trash = sync::sync_folder(&mut conn, &store, "d", "Trash", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!(trash.added, 0);
    conn.session.logout().await.unwrap();
}

/// What a pass over INBOX of `n` messages sees of another client's changes, the way
/// `conn` is set to sync: QRESYNC, CONDSTORE alone or neither.
async fn changes_from_another_client(test: &str, mut conn: Conn, n: usize) -> Vec<[usize; 4]> {
    for i in 0..n {
        imap::append(&mut conn, "INBOX", &mail(&format!("Письмо {i}"), i), "")
            .await
            .unwrap();
    }
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();
    let opts = SyncOptions::default();
    let mut passes = Vec::new();
    let mut pass = async |conn: &mut Conn| {
        let r = sync::sync_folder(conn, &store, "d", "INBOX", opts).await.unwrap();
        passes.push(counts(r));
    };
    pass(&mut conn).await;
    pass(&mut conn).await; // nothing changed

    let mut other = connect(test).await;
    let uids = store.known_uids("d", "INBOX").unwrap();
    let (mut uids, n) = (uids.clone(), uids.len());
    uids.sort_unstable();
    imap::set_flag(&mut other, "INBOX", None, &[uids[0]], FlagChange::Flagged(true))
        .await
        .unwrap();
    pass(&mut conn).await; // one flag
    imap::delete_permanently(&mut other, "INBOX", None, &[uids[1]])
        .await
        .unwrap();
    pass(&mut conn).await; // one expunged
    other.caps.uidplus = false;
    imap::delete_permanently(&mut other, "INBOX", None, &[uids[2]])
        .await
        .unwrap();
    pass(&mut conn).await; // one \Deleted, not expunged
    other.caps.uidplus = true;
    imap::delete_permanently(&mut other, "INBOX", None, &[uids[3]])
        .await
        .unwrap();
    imap::append(&mut other, "INBOX", &mail("Новое", 99), "").await.unwrap();
    pass(&mut conn).await; // one expunged, one new: EXISTS is the same

    assert!(store.find_by_uid("d", "INBOX", uids[0]).unwrap().unwrap().flags.flagged);
    for uid in &uids[1..4] {
        assert!(store.find_by_uid("d", "INBOX", *uid).unwrap().is_none(), "{uid}");
    }
    assert_eq!(store.known_uids("d", "INBOX").unwrap().len(), n - 3 + 1);
    conn.session.logout().await.unwrap();
    passes
}

/// `[added, updated, removed, fetched_flags]`: the report with what the pass cost.
fn report(added: usize, updated: usize, removed: usize, fetched_flags: usize) -> [usize; 4] {
    [added, updated, removed, fetched_flags]
}

fn counts(r: sync::FolderSync) -> [usize; 4] {
    [r.added, r.updated, r.removed, r.fetched_flags]
}

#[tokio::test]
async fn qresync_fetches_only_changed_flags_and_vanished_uids() {
    if !enabled() {
        return;
    }
    let conn = connect("qresync").await;
    assert!(conn.caps.condstore && conn.caps.qresync, "{:?}", conn.caps);
    let passes = changes_from_another_client("qresync", conn, 25).await;
    assert_eq!(
        passes,
        [
            report(25, 0, 0, 0),
            report(0, 0, 0, 0),
            report(0, 1, 0, 1),
            report(0, 0, 1, 0),
            report(0, 0, 1, 1),
            report(1, 0, 1, 0),
        ]
    );
}

#[tokio::test]
async fn condstore_without_qresync_counts_expunges() {
    if !enabled() {
        return;
    }
    let mut conn = connect("condstore").await;
    conn.caps.qresync = false;
    let passes = changes_from_another_client("condstore", conn, 25).await;
    assert_eq!(
        passes,
        [
            report(25, 0, 0, 0),
            report(0, 0, 0, 0),
            report(0, 1, 0, 1),
            report(0, 0, 1, 0),
            report(0, 0, 1, 1),
            report(1, 0, 1, 0),
        ]
    );
}

#[tokio::test]
async fn without_condstore_every_pass_fetches_all_flags() {
    if !enabled() {
        return;
    }
    let mut conn = connect("nocondstore").await;
    conn.caps.condstore = false;
    conn.caps.qresync = false;
    let passes = changes_from_another_client("nocondstore", conn, 25).await;
    assert_eq!(
        passes,
        [
            report(25, 0, 0, 0),
            report(0, 0, 0, 25),
            report(0, 1, 0, 25),
            report(0, 0, 1, 24),
            // The \Deleted one is still on the server.
            report(0, 0, 1, 24),
            report(1, 0, 1, 23),
        ]
    );
}

#[tokio::test]
async fn a_recreated_folder_forgets_its_mod_sequence() {
    if !enabled() {
        return;
    }
    let mut conn = connect("modseqvalidity").await;
    conn.session.create("Box").await.unwrap();
    for i in 0..3 {
        imap::append(&mut conn, "Box", &mail(&format!("Старое {i}"), i), "")
            .await
            .unwrap();
    }
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();
    sync::sync_folder(&mut conn, &store, "d", "Box", SyncOptions::default())
        .await
        .unwrap();
    assert_ne!(store.modseq_mark("d", "Box").unwrap().modseq, 0);
    let (validity, _) = store.folder_state("d", "Box").unwrap();

    conn.session.select("INBOX").await.unwrap();
    conn.session.delete("Box").await.unwrap();
    conn.session.create("Box").await.unwrap();
    for i in 0..2 {
        imap::append(&mut conn, "Box", &mail(&format!("Новое {i}"), i + 10), "\\Seen")
            .await
            .unwrap();
    }
    let r = sync::sync_folder(&mut conn, &store, "d", "Box", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!((r.added, r.removed), (2, 0), "{r:?}");
    assert_ne!(store.folder_state("d", "Box").unwrap().0, validity);
    let rows = store
        .list(&ListQuery {
            account_id: Some("d".into()),
            folder: Some("Box".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(rows.iter().all(|m| m.subject.starts_with("Новое") && m.flags.seen));
    let r = sync::sync_folder(&mut conn, &store, "d", "Box", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!(counts(r), report(0, 0, 0, 0));
    conn.session.logout().await.unwrap();
}

/// The syncing session has QRESYNC on and expunges there come as VANISHED; IDLE runs
/// on its own session and still wakes up on an expunge.
#[tokio::test]
async fn idle_wakes_up_on_an_expunge_while_another_session_uses_qresync() {
    if !enabled() {
        return;
    }
    let mut other = connect("idlegone").await;
    imap::append(&mut other, "INBOX", &mail("Уйдёт", 1), "").await.unwrap();
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut other, &store, "d").await.unwrap();
    sync::sync_folder(&mut other, &store, "d", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    assert!(other.qresync);

    let idle = connect("idlegone").await;
    let waiter = tokio::spawn(async move {
        imap::wait_for_changes(idle, "INBOX", std::time::Duration::from_secs(2))
            .await
            .map(|(_, o)| o)
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let uids = store.known_uids("d", "INBOX").unwrap();
    imap::delete_permanently(&mut other, "INBOX", None, &uids)
        .await
        .unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), waiter)
        .await
        .expect("no wakeup");
    assert!(matches!(outcome.unwrap().unwrap(), IdleOutcome::Changed));
}

/// What the login lists is kept, ENABLE QRESYNC is answered, and folder sizes add up
/// to the messages put there, by STATUS=SIZE and by RFC822.SIZE alike. The test image
/// runs Dovecot without the quota plugin (compose.test.yaml): QUOTA is not listed, and
/// the mailbox has no quota to show rather than a full or an empty one.
#[tokio::test]
async fn capabilities_quota_and_folder_sizes() {
    if !enabled() {
        return;
    }
    let mut conn = connect("sizes").await;
    assert!(conn.capabilities.iter().any(|c| c.eq_ignore_ascii_case("IMAP4rev1")));
    assert!(conn.capabilities.iter().any(|c| c.eq_ignore_ascii_case("IDLE")));
    assert_eq!(depesha_core::imap::Caps::from_names(&conn.capabilities), conn.caps);
    imap::enable_qresync(&mut conn).await.unwrap();
    let enabled = conn.enabled.clone().expect("Dovecot offers QRESYNC");
    assert!(enabled.ok, "{enabled:?}");

    let quota = depesha_core::quota::quota(&mut conn).await.unwrap();
    if conn.caps.quota {
        let q = quota.expect("a root for INBOX");
        assert!(q.limit == 0 || q.used <= q.limit, "{q:?}");
    } else {
        assert_eq!(quota, None);
    }

    conn.session.create("Sizes").await.unwrap();
    let mut total = 0;
    for i in 0..3 {
        let raw = mail(&format!("Размер {i}"), i);
        total += raw.len() as u64;
        imap::append(&mut conn, "Sizes", &raw, "").await.unwrap();
    }
    conn.session.logout().await.unwrap();

    let folders = ["Sizes".to_owned(), "INBOX".to_owned(), "Nonexistent".to_owned()];
    for status_size in [true, false] {
        let mut conn = connect("sizes").await;
        if status_size && !conn.caps.status_size {
            continue;
        }
        conn.caps.status_size = status_size;
        let (_, sizes) = depesha_core::quota::folder_sizes(&mut conn, &folders, |_| {})
            .await
            .unwrap();
        assert_eq!(sizes[0].bytes, Some(total), "STATUS=SIZE {status_size}: {sizes:?}");
        assert_eq!(sizes[0].messages, Some(3));
        assert_eq!(sizes[1].bytes, Some(0));
        assert!(sizes[2].bytes.is_none() && sizes[2].error.is_some(), "{sizes:?}");
    }
}

#[tokio::test]
async fn a_forward_and_an_answer_set_here_come_back_with_the_sync() {
    if !enabled() {
        return;
    }
    let mut conn = connect("marks").await;
    for i in 0..2 {
        imap::append(&mut conn, "INBOX", &mail(&format!("Отметка {i}"), i), "")
            .await
            .unwrap();
    }
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();
    let opts = SyncOptions { initial_limit: 20 };
    sync::sync_folder(&mut conn, &store, "d", "INBOX", opts).await.unwrap();
    let rows = || {
        let mut r = store
            .list(&ListQuery {
                account_id: Some("d".into()),
                folder: Some("INBOX".into()),
                ..Default::default()
            })
            .unwrap();
        r.sort_by_key(|m| m.uid);
        r
    };
    let uids: Vec<u32> = rows().iter().map(|m| m.uid).collect();
    // What Depesha writes after a forward and an answer to all: $Forwarded and \Answered.
    imap::set_flag(&mut conn, "INBOX", None, &[uids[0]], FlagChange::Forwarded(true))
        .await
        .unwrap();
    imap::set_flag(&mut conn, "INBOX", None, &[uids[1]], FlagChange::AnsweredAll(true))
        .await
        .unwrap();
    sync::sync_folder(&mut conn, &store, "d", "INBOX", opts).await.unwrap();
    let r = rows();
    assert!(r[0].flags.forwarded && !r[0].flags.answered, "{:?}", r[0].flags);
    // IMAP has one flag for an answer: a plain reply, the kind unknown.
    assert!(r[1].flags.answered && !r[1].flags.answered_all, "{:?}", r[1].flags);
    // Taken off on the server: gone here too.
    imap::set_flag(&mut conn, "INBOX", None, &[uids[0]], FlagChange::Forwarded(false))
        .await
        .unwrap();
    sync::sync_folder(&mut conn, &store, "d", "INBOX", opts).await.unwrap();
    assert!(!rows()[0].flags.forwarded);
}

/// Labels on Dovecot: `PERMANENTFLAGS` says whether own keywords may be created here,
/// NAMESPACE names the shared namespaces, and a keyword set on a message stays after a
/// re-read. Dovecot's test image has no ACL plugin, so MYRIGHTS is refused: the rights
/// are unknown, which the test tells apart from "no rights".
#[tokio::test]
async fn labels_and_namespace_over_starttls() {
    if !enabled() {
        return;
    }
    let mut conn = connect("labels").await;
    for name in ["Работа", "Проекты"] {
        conn.session.create(utf7::encode(name)).await.unwrap();
    }
    imap::append(&mut conn, "INBOX", &mail("Метки", 0), "").await.unwrap();

    // The folder's rights and permanent flags: EXAMINE and MYRIGHTS read, write nothing.
    let (rights, permanent) = imap::folder_props(&mut conn, "INBOX").await.unwrap();
    // Dovecot's image has no ACL: the rights are unknown, not "no rights".
    assert!(rights.is_none(), "{rights:?}");
    // A real Dovecot lists `\*` in PERMANENTFLAGS: own keywords may be created here.
    assert!(permanent.labels_on_server(), "{permanent:?}");

    // The namespaces: the personal one names the user's folders, the rest is empty here.
    let ns = imap::namespace(&mut conn).await.unwrap();
    assert!(!ns.personal.is_empty(), "{ns:?}");
    assert!(ns.shared.is_empty() && ns.other_users.is_empty(), "{ns:?}");

    // A keyword set on a message comes back after a fresh read: the label lives on the server.
    let keyword = depesha_core::acl::keyword_of("Счета");
    imap::set_keywords(&mut conn, "INBOX", None, &[1], std::slice::from_ref(&keyword), &[])
        .await
        .unwrap();
    let keywords = imap::fetch_keywords(&mut conn, "INBOX", 1).await.unwrap();
    assert!(keywords.contains(&keyword), "{keywords:?}");
    // Taken off again.
    imap::set_keywords(&mut conn, "INBOX", None, &[1], &[], std::slice::from_ref(&keyword))
        .await
        .unwrap();
    assert!(
        !imap::fetch_keywords(&mut conn, "INBOX", 1)
            .await
            .unwrap()
            .contains(&keyword)
    );
}
