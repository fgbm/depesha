//! Compatibility with Dovecot 2.4, the most common IMAP server, see compose.test.yaml.
//! Dovecot refuses cleartext login, so everything goes through STARTTLS with
//! its self-signed certificate pinned. Skipped unless DEPESHA_IT=1.

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::domain::{FlagChange, FolderRole};
use depesha_core::idle_pace::{DropCause, Dropped, IdlePace, Tuning};
use depesha_core::imap::{self, Conn, IdleOutcome};
use depesha_core::query::{self, SearchQuery};
use depesha_core::store::{ListQuery, Store};
use depesha_core::sync::{self, SyncOptions};
use depesha_core::{Error, mail, utf7};
use futures::TryStreamExt;
use std::time::Duration;

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
    server_at(31143).await
}

async fn server_at(port: u16) -> ServerConfig {
    let mut s = ServerConfig::new("localhost", port, Security::StartTls);
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

    // Old server without MOVE and UIDPLUS: COPY, \Deleted, then a plain EXPUNGE (#113).
    conn.caps.move_ = false;
    conn.caps.uidplus = false;
    imap::move_messages(&mut conn, "INBOX", None, &[rows[2].uid], "Trash")
        .await
        .unwrap();
    let r = sync::sync_folder(&mut conn, &store, "d", "INBOX", small).await.unwrap();
    assert_eq!(r.removed, 1, "a \\Deleted message disappears from the list");
    let status = conn.session.select("INBOX").await.unwrap();
    assert_eq!(status.exists, 28, "without UIDPLUS the original is expunged too");
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

/// A move cut short without MOVE (COPY went through, \Deleted did not) must not copy the
/// letter again on the retry: the letter already at the target is only marked deleted.
#[tokio::test]
async fn a_resumed_move_does_not_copy_again() {
    if !enabled() {
        return;
    }
    let mut conn = connect("resume").await;
    let _ = imap::create_folder(&mut conn, "Trash").await;
    let raw = mail("Resume", 7);
    let mid = "7.Resume@example.org";
    imap::append(&mut conn, "INBOX", &raw, "").await.unwrap();
    // As if the COPY had already succeeded before the connection dropped: the letter is
    // in Trash, and the original is still in INBOX.
    imap::append(&mut conn, "Trash", &raw, "").await.unwrap();
    let uid = imap::find_by_message_id(&mut conn, "INBOX", mid).await.unwrap()[0];

    imap::resume_move(&mut conn, "INBOX", None, &[uid], "Trash")
        .await
        .unwrap();

    assert!(
        imap::find_by_message_id(&mut conn, "INBOX", mid)
            .await
            .unwrap()
            .is_empty(),
        "the original is gone from the source"
    );
    assert_eq!(
        imap::find_by_message_id(&mut conn, "Trash", mid).await.unwrap().len(),
        1,
        "the letter at the target is not copied a second time"
    );
    conn.session.logout().await.unwrap();
}

/// A letter of the same Message-ID but another size at the target (a mailing-list crosspost)
/// is not the copy of this one: the resumed move copies the original too, then removes it.
#[tokio::test]
async fn a_resumed_move_copies_when_the_target_holds_another_letter() {
    if !enabled() {
        return;
    }
    let mut conn = connect("resume-cross").await;
    let _ = imap::create_folder(&mut conn, "Trash").await;
    let raw = mail("Cross", 8);
    let mid = "8.Cross@example.org";
    imap::append(&mut conn, "INBOX", &raw, "").await.unwrap();
    let mut other = raw.clone();
    other.extend_from_slice("Отличается длиной\r\n".as_bytes());
    imap::append(&mut conn, "Trash", &other, "").await.unwrap();
    let uid = imap::find_by_message_id(&mut conn, "INBOX", mid).await.unwrap()[0];

    imap::resume_move(&mut conn, "INBOX", None, &[uid], "Trash")
        .await
        .unwrap();

    assert!(
        imap::find_by_message_id(&mut conn, "INBOX", mid)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        imap::find_by_message_id(&mut conn, "Trash", mid).await.unwrap().len(),
        2,
        "the original reached the target beside the other letter"
    );
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

/// `SEARCH HEADER Message-ID` matches a substring (RFC 3501): the search must be
/// narrowed to an exact Message-ID. An empty id finds nothing; an id without `@` is
/// unusual but must still be found — returning nothing would leave such a letter in
/// "Snoozed"/"Waiting for reply" for good.
#[tokio::test]
async fn a_message_id_search_is_exact() {
    if !enabled() {
        return;
    }
    let mut conn = connect("mid").await;
    let raw = |id: &str| {
        format!(
            "From: Тест <test@example.org>\r\nTo: me@example.org\r\nSubject: Тема\r\nMessage-ID: <{id}>\r\n\
             Date: Fri, 2 Oct 2026 10:00:00 +0300\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nтело\r\n"
        )
        .into_bytes()
    };
    imap::append(&mut conn, "INBOX", &raw("abc@example.org"), "")
        .await
        .unwrap();
    imap::append(&mut conn, "INBOX", &raw("1abc@example.org"), "")
        .await
        .unwrap();
    // A Message-ID with no `@`: still a whole id, still to be found.
    imap::append(&mut conn, "INBOX", &raw("local1"), "").await.unwrap();

    let found = imap::find_by_message_id(&mut conn, "INBOX", "abc@example.org")
        .await
        .unwrap();
    assert_eq!(
        found.len(),
        1,
        "the substring match is narrowed to an exact Message-ID: {found:?}"
    );
    // An empty id matches every letter.
    assert!(
        imap::find_by_message_id(&mut conn, "INBOX", "")
            .await
            .unwrap()
            .is_empty()
    );
    // No letter carries exactly this id (`abc@example.org` is a different one).
    assert!(
        imap::find_by_message_id(&mut conn, "INBOX", "abc")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        imap::find_by_message_id(&mut conn, "INBOX", "<1abc@example.org>")
            .await
            .unwrap()
            .len(),
        1
    );
    // The id without `@` is found, not dropped.
    assert_eq!(
        imap::find_by_message_id(&mut conn, "INBOX", "local1")
            .await
            .unwrap()
            .len(),
        1
    );
    conn.session.logout().await.unwrap();
}

/// Without MOVE and UIDPLUS a move leaves the original marked `\Deleted`: finding it by
/// Message-ID again would copy the deleted original a second time.
#[tokio::test]
async fn a_deleted_original_is_not_moved_again() {
    if !enabled() {
        return;
    }
    let mut conn = connect("dup").await;
    conn.session.create("Box").await.unwrap();
    let raw = "From: Тест <test@example.org>\r\nTo: me@example.org\r\nSubject: Дубль\r\n\
               Message-ID: <dup@example.org>\r\nDate: Fri, 2 Oct 2026 10:00:00 +0300\r\n\
               Content-Type: text/plain; charset=utf-8\r\n\r\nтело\r\n"
        .replace("               ", "");
    imap::append(&mut conn, "INBOX", raw.as_bytes(), "").await.unwrap();
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();
    sync::sync_folder(&mut conn, &store, "d", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    let ids = vec!["dup@example.org".to_owned()];

    conn.caps.move_ = false;
    conn.caps.uidplus = false;
    let mut conn = mail::Conn::Imap(conn);
    let n = mail::move_by_message_id(&mut conn, &store, "d", "INBOX", &ids, "Box", false)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let mail::Conn::Imap(mut imap_conn) = conn else {
        unreachable!()
    };
    sync::sync_folder(&mut imap_conn, &store, "d", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    sync::sync_folder(&mut imap_conn, &store, "d", "Box", SyncOptions::default())
        .await
        .unwrap();

    // The original stays on the server, marked \Deleted: moving it again must find nothing.
    let mut conn = mail::Conn::Imap(imap_conn);
    let n = mail::move_by_message_id(&mut conn, &store, "d", "INBOX", &ids, "Box", false)
        .await
        .unwrap();
    assert_eq!(n, 0, "the \\Deleted original is not moved again");
    let mail::Conn::Imap(mut imap_conn) = conn else {
        unreachable!()
    };
    sync::sync_folder(&mut imap_conn, &store, "d", "Box", SyncOptions::default())
        .await
        .unwrap();
    let box_ = store
        .list(&ListQuery {
            account_id: Some("d".into()),
            folder: Some("Box".into()),
            limit: 100,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(box_.len(), 1, "one copy in the destination: {box_:?}");
    imap_conn.session.logout().await.unwrap();
}

#[tokio::test]
async fn idle_wakes_up_on_append_from_another_session() {
    if !enabled() {
        return;
    }
    let idle = connect("idle").await;
    let waiter = tokio::spawn(async move {
        imap::wait_for_changes(idle, "INBOX", std::time::Duration::from_secs(2), imap::IDLE_RENEW)
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
    // Another client marks a letter \Deleted and leaves it unexpunged.
    other.session.select("INBOX").await.unwrap();
    let _: Vec<_> = other
        .session
        .uid_store(uids[2].to_string(), "+FLAGS.SILENT (\\Deleted)")
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    pass(&mut conn).await; // one \Deleted, not expunged
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
        imap::wait_for_changes(idle, "INBOX", std::time::Duration::from_secs(2), imap::IDLE_RENEW)
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
/// re-read. The stand carries the ACL plugin (docker/dovecot-acl.conf), so MYRIGHTS must
/// answer: a stand without it is a broken stand, not a reason to skip the checks.
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

    // The folder's rights and permanent flags: MYRIGHTS and a SELECT read, write nothing.
    let (rights, permanent) = imap::folder_props(&mut conn, "INBOX").await.unwrap();
    // The ACL plugin is part of the stand (docker/dovecot-acl.conf): an answer of "no
    // rights" means the stand lacks it, and the test fails rather than skipping.
    let rights = rights.expect("MYRIGHTS must answer: the stand carries the ACL plugin");
    assert!(
        rights.read && rights.write && rights.insert && !rights.read_only(),
        "{rights:?}"
    );
    // The namespaces: the personal one and the public namespace the stand adds (`shared/`).
    let ns = imap::namespace(&mut conn).await.unwrap();
    assert!(!ns.personal.is_empty(), "{ns:?}");
    assert_eq!(ns.shared.first().map(|n| n.prefix.as_str()), Some("shared/"), "{ns:?}");
    assert!(ns.other_users.is_empty(), "{ns:?}");
    // A real Dovecot lists `\*` in PERMANENTFLAGS: own keywords may be created here.
    assert!(permanent.labels_on_server(), "{permanent:?}");

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

/// A label reaches the cache: one set by another client arrives with the sync, one set
/// here at once, and can be taken off again. The row reads `keywords`, so this is what
/// the list shows (#42).
#[tokio::test]
async fn labels_reach_the_cache_from_the_sync_and_at_once() {
    if !enabled() {
        return;
    }
    let mut conn = connect("labelscache").await;
    imap::append(&mut conn, "INBOX", &mail("Метки", 0), "").await.unwrap();
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();
    let opts = SyncOptions { initial_limit: 20 };
    sync::sync_folder(&mut conn, &store, "d", "INBOX", opts).await.unwrap();
    let keywords = || {
        store
            .list(&ListQuery {
                account_id: Some("d".into()),
                folder: Some("INBOX".into()),
                ..Default::default()
            })
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
            .keywords
    };
    assert!(keywords().is_empty(), "{:?}", keywords());

    // Another client sets a keyword; the next sync brings it into the cache.
    let theirs = depesha_core::acl::keyword_of("Своя метка");
    imap::set_keywords(&mut conn, "INBOX", None, &[1], std::slice::from_ref(&theirs), &[])
        .await
        .unwrap();
    sync::sync_folder(&mut conn, &store, "d", "INBOX", opts).await.unwrap();
    assert!(keywords().contains(&theirs), "{:?}", keywords());

    // Depesha sets a label itself: the cache takes it in at once, without a sync.
    let (validity, _) = store.folder_state("d", "INBOX").unwrap();
    let label = depesha_core::acl::Label {
        name: "Депеша".into(),
        keyword: depesha_core::acl::keyword_of("Депеша"),
        color: String::new(),
        stripping: false,
    };
    let mut conn = mail::Conn::Imap(conn);
    mail::set_labels(
        &mut conn,
        &store,
        "d",
        "INBOX",
        validity,
        &[1],
        mail::LabelChange {
            add: std::slice::from_ref(&label),
            remove: &[],
        },
    )
    .await
    .unwrap();
    assert!(keywords().contains(&label.keyword), "{:?}", keywords());

    // Taken off again.
    mail::set_labels(
        &mut conn,
        &store,
        "d",
        "INBOX",
        validity,
        &[1],
        mail::LabelChange {
            add: &[],
            remove: std::slice::from_ref(&label),
        },
    )
    .await
    .unwrap();
    assert!(!keywords().contains(&label.keyword), "{:?}", keywords());
}

/// Deleting a label takes its keyword off every letter of the mailbox on the server
/// (#42, frame 4Б), one folder per work as the app drives it: each folder is searched by
/// the keyword and the keyword cleared, a folder without rights is skipped, and other
/// labels stay.
#[tokio::test]
async fn stripping_a_label_clears_it_in_every_folder() {
    if !enabled() {
        return;
    }
    let mut conn = connect("strip").await;
    conn.session.create(utf7::encode("Work")).await.unwrap();
    imap::append(&mut conn, "INBOX", &mail("Метка", 0), "").await.unwrap();
    imap::append(&mut conn, "Work", &mail("Метка", 1), "").await.unwrap();
    imap::append(&mut conn, "INBOX", &mail("Без метки", 2), "")
        .await
        .unwrap();

    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "d").await.unwrap();

    let keyword = depesha_core::acl::keyword_of("Счета");
    let other = depesha_core::acl::keyword_of("Другая");
    for folder in ["INBOX", "Work"] {
        imap::set_keywords(&mut conn, folder, None, &[1], std::slice::from_ref(&keyword), &[])
            .await
            .unwrap();
    }
    imap::set_keywords(&mut conn, "INBOX", None, &[1], std::slice::from_ref(&other), &[])
        .await
        .unwrap();

    let mut conn = mail::Conn::Imap(conn);
    // One folder per work, as the app drives it: the keyword is cleared folder by folder.
    let mut n = 0;
    for folder in ["INBOX", "Work"] {
        n += mail::strip_label(&mut conn, &store, "d", folder, &keyword)
            .await
            .unwrap();
    }
    store.drop_keyword("d", &keyword).unwrap();
    assert_eq!(n, 2, "the keyword was on two letters");

    // A folder the user may only read: the change is refused (the server might quietly
    // ignore it, so `strip_label` refuses it itself), the driver skips it, and the rest
    // of the mailbox is cleaned.
    let err = mail::strip_label(&mut conn, &store, "d", "shared/ReadOnly", &keyword)
        .await
        .expect_err("a read-only folder refuses the change");
    assert!(err.no_rights(), "{err:?}");

    let mail::Conn::Imap(mut conn) = conn else {
        unreachable!("the stand is IMAP")
    };

    for folder in ["INBOX", "Work"] {
        let kw = imap::fetch_keywords(&mut conn, folder, 1).await.unwrap();
        assert!(!kw.contains(&keyword), "{folder}: {kw:?}");
    }
    // The read-only folder is untouched: nothing was taken off there.
    let kw = imap::fetch_keywords(&mut conn, "shared/ReadOnly", 1).await.unwrap();
    assert!(!kw.contains(&keyword), "the read-only folder is untouched: {kw:?}");
    // Another label on the same letter is untouched.
    let kw = imap::fetch_keywords(&mut conn, "INBOX", 1).await.unwrap();
    assert!(kw.contains(&other), "{kw:?}");
}

/// The ACL plugin and the public read-only namespace the stand adds (#42). MYRIGHTS
/// answers "only read" for the shared folder, a move out of it is refused with [NOPERM],
/// and the folder is grouped under its owner from NAMESPACE. Both the ACL plugin and the
/// namespace are part of docker/dovecot-acl.conf: their absence fails the test.
#[tokio::test]
async fn shared_folder_rights_and_refusals_over_starttls() {
    if !enabled() {
        return;
    }
    let mut conn = connect("acl").await;

    // The public namespace the stand adds, seen as a namespace of its own.
    let ns = imap::namespace(&mut conn).await.unwrap();
    let shared_ns = ns
        .shared
        .first()
        .expect("the stand adds the shared namespace (docker/dovecot-acl.conf)");
    assert_eq!(shared_ns.prefix, "shared/", "{ns:?}");

    // The folder the seed made, and the rights the dovecot-acl grants: lookup and read.
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "acl").await.unwrap();
    let listed = store.folders(Some("acl")).unwrap();
    assert!(
        listed.iter().any(|f| f.folder.name == "shared/ReadOnly"),
        "no shared folder: {listed:?}"
    );

    // MYRIGHTS and PERMANENTFLAGS without writing: only read, no own labels.
    let (rights, permanent) = imap::folder_props(&mut conn, "shared/ReadOnly").await.unwrap();
    assert_eq!(rights.map(|r| r.letters()), Some("lr".into()), "{rights:?}");
    assert!(rights.unwrap().read_only(), "only read");
    assert!(!permanent.labels_on_server(), "only standard flags here: {permanent:?}");

    // The owner from NAMESPACE: a shared folder, not the user's own.
    assert_eq!(ns.owner_of("shared/ReadOnly"), Some(depesha_core::acl::Owner::Shared));

    // A move out is a delete and an expunge: the server refuses with [NOPERM], and the
    // letter stays where it was.
    let uids = imap::find_by_message_id(&mut conn, "shared/ReadOnly", "shared-ro@example.org")
        .await
        .unwrap();
    assert_eq!(uids.len(), 1, "the seeded letter");
    let err = imap::move_messages(&mut conn, "shared/ReadOnly", None, &uids, "INBOX")
        .await
        .expect_err("the server must refuse");
    assert!(err.no_rights(), "{err:?}");
    assert_eq!(err.kind(), depesha_core::ErrorKind::NoRights);
    let still = imap::find_by_message_id(&mut conn, "shared/ReadOnly", "shared-ro@example.org")
        .await
        .unwrap();
    assert_eq!(still.len(), 1, "the letter returned on its own: it was never moved");

    // The refusal is remembered for this folder alone.
    store.refuse_folder("acl", "shared/ReadOnly", "no-rights", 1).unwrap();
    assert_eq!(
        store
            .folder_prop("acl", "shared/ReadOnly")
            .unwrap()
            .unwrap()
            .refused
            .as_deref(),
        Some("no-rights")
    );
}

/// A label check interrupted after APPEND leaves its test letter behind; the next check
/// removes it before adding a new one, so nothing of Depesha's stays in the folder.
#[tokio::test]
async fn a_leftover_test_message_is_cleaned_before_the_next_check() {
    if !enabled() {
        return;
    }
    let mut conn = connect("cleanup").await;
    let leftover = "depesha-test-leftover@depesha.local";
    let raw = format!(
        "From: Depesha <noreply@depesha.local>\r\nTo: noreply@depesha.local\r\nSubject: Депеша: проверка меток\r\n\
         Message-ID: <{leftover}>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nпроверка\r\n"
    );
    imap::append(&mut conn, "INBOX", raw.as_bytes(), "\\Seen")
        .await
        .unwrap();
    assert_eq!(
        imap::find_by_message_id(&mut conn, "INBOX", leftover)
            .await
            .unwrap()
            .len(),
        1,
        "the leftover is there"
    );

    let removed = imap::cleanup_test_messages(&mut conn, "INBOX").await.unwrap();
    assert_eq!(removed, 1);
    assert!(
        imap::find_by_message_id(&mut conn, "INBOX", leftover)
            .await
            .unwrap()
            .is_empty(),
        "the leftover is gone"
    );
}

/// The label check on a test message (#9, frame 9): a test letter is put into the folder,
/// a label stored on it, read back, and both taken away again. A real Dovecot keeps own
/// keywords in INBOX, so the result is "saves"; the test letter never stays behind.
#[tokio::test]
async fn a_label_check_leaves_no_test_message_over_starttls() {
    if !enabled() {
        return;
    }
    let mut conn = connect("check").await;
    // A letter of the user's own, untouched by the check.
    imap::append(&mut conn, "INBOX", &mail("Своё", 1), "").await.unwrap();

    let keyword = depesha_core::acl::keyword_of("depesha-test");
    let outcome = imap::check_labels(
        &mut conn,
        "INBOX",
        &keyword,
        "check-test-1@depesha.local",
        "Депеша: проверка меток",
    )
    .await
    .unwrap();
    // A real Dovecot keeps own keywords: the label survives the re-read.
    assert_eq!(outcome, depesha_core::acl::LabelCheck::Saves, "{outcome:?}");
    assert!(outcome.saves());

    // The test letter is gone; the user's letter stays.
    let left = imap::find_by_message_id(&mut conn, "INBOX", "check-test-1@depesha.local")
        .await
        .unwrap();
    assert!(left.is_empty(), "the test letter was deleted: {left:?}");
    assert_eq!(
        imap::find_by_message_id(&mut conn, "INBOX", "1.Своё@example.org")
            .await
            .unwrap()
            .len(),
        1,
        "the user's letter stays"
    );

    // The check leaves no label of its own on any message.
    let uids = imap::find_by_message_id(&mut conn, "INBOX", "1.Своё@example.org")
        .await
        .unwrap();
    let u = uids[0];
    assert!(
        !imap::fetch_keywords(&mut conn, "INBOX", u)
            .await
            .unwrap()
            .contains(&keyword)
    );
}

/// #113: the marks of others that a plain `EXPUNGE` spares are cleared and set again in batches:
/// the stand's command line is short, eight hundred scattered UIDs in one are refused.
#[tokio::test]
async fn many_foreign_deleted_marks_are_spared_in_batches() {
    if !enabled() {
        return;
    }
    let mut conn = imap::connect(&server_at(31144).await, &user("sparedmany"))
        .await
        .expect("login over STARTTLS");
    assert!(!conn.caps.uidplus, "the stand must not offer UIDPLUS");
    conn.session.create("Many").await.unwrap();
    // Every other letter is marked by another client: 800 UIDs that are not a range. Two letters
    // are appended and the folder is doubled with COPY, which keeps the flags: eleven commands
    // instead of sixteen hundred appends.
    imap::append(&mut conn, "Many", &mail("many", 1), "").await.unwrap();
    imap::append(&mut conn, "Many", &mail("many", 2), "(\\Deleted)")
        .await
        .unwrap();
    let mut exists = conn.session.select("Many").await.unwrap().exists;
    while exists < 1600 {
        // The last copy stops at 1600, an even number, so the alternation holds.
        let upto = exists.min(1600 - exists);
        conn.session.copy(format!("1:{upto}"), "Many").await.unwrap();
        exists += upto;
    }
    let mailbox = conn.session.select("Many").await.unwrap();
    assert_eq!(mailbox.exists, 1600);
    let validity = mailbox.uid_validity;
    let all = imap::uid_search(&mut conn, "ALL").await.unwrap();
    let foreign = imap::uid_search(&mut conn, "DELETED").await.unwrap();
    assert_eq!((all.len(), foreign.len()), (1600, 800));
    // Ours: the first unmarked letters.
    let ours: Vec<u32> = all.iter().copied().filter(|u| !foreign.contains(u)).take(3).collect();

    imap::delete_permanently(&mut conn, "Many", validity, &ours)
        .await
        .unwrap();

    conn.session.select("Many").await.unwrap();
    assert_eq!(imap::uid_search(&mut conn, "ALL").await.unwrap().len(), 1597);
    assert_eq!(
        imap::uid_search(&mut conn, "DELETED").await.unwrap(),
        foreign,
        "every foreign mark is back"
    );
    conn.session.logout().await.unwrap();
}

/// #113: a Dovecot whose capabilities lack UIDPLUS has no `UID EXPUNGE` for the client. The
/// letters must still be wiped, and a letter another client marked `\Deleted` must stay.
#[tokio::test]
async fn permanent_delete_without_uidplus_wipes_ours_and_spares_foreign_marks() {
    if !enabled() {
        return;
    }
    let mut conn = imap::connect(&server_at(31144).await, &user("nouidplus"))
        .await
        .expect("login over STARTTLS");
    assert!(!conn.caps.uidplus, "the stand must not offer UIDPLUS");
    conn.session.create("Trash").await.unwrap();
    for n in 1..=4 {
        imap::append(&mut conn, "Trash", &mail("x", n), "").await.unwrap();
    }
    conn.session.select("Trash").await.unwrap();
    let all = imap::uid_search(&mut conn, "ALL").await.unwrap();
    assert_eq!(all.len(), 4);
    // Another client has marked the last letter deleted and not expunged yet.
    let _: Vec<_> = conn
        .session
        .uid_store(all[3].to_string(), "+FLAGS.SILENT (\\Deleted)")
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    let validity = conn.session.select("Trash").await.unwrap().uid_validity;

    imap::delete_permanently(&mut conn, "Trash", validity, &all[..2])
        .await
        .unwrap();

    conn.session.select("Trash").await.unwrap();
    assert_eq!(
        imap::uid_search(&mut conn, "ALL").await.unwrap(),
        all[2..],
        "ours are gone, the rest stays"
    );
    assert_eq!(
        imap::uid_search(&mut conn, "DELETED").await.unwrap(),
        vec![all[3]],
        "the foreign mark is back on its letter and the other one is unmarked"
    );

    // Nothing foreign: the whole folder is wiped.
    imap::delete_permanently(&mut conn, "Trash", validity, &all[2..])
        .await
        .unwrap();
    conn.session.select("Trash").await.unwrap();
    assert!(imap::uid_search(&mut conn, "ALL").await.unwrap().is_empty());
    conn.session.logout().await.unwrap();
}

/// The bound a dialog would have counted for the folder now (#74).
async fn bound_of(conn: &mut mail::Conn, store: &Store, account: &str, folder: &str) -> mail::Bound {
    mail::folder_count(conn, store, account, folder).await.unwrap().1
}

/// #74: «Clear» wipes every message of the folder on the server in batches, can be stopped
/// between two of them, leaves other folders alone, and moves (not wipes) when asked to.
async fn clears_a_folder(conn: imap::Conn, tag: &str) {
    let store = Store::open_in_memory().unwrap();
    let mut conn = mail::Conn::Imap(conn);
    let (junk, other, drafts, trash) = (
        format!("Junk{tag}"),
        format!("Other{tag}"),
        format!("Drafts{tag}"),
        format!("Trash{tag}"),
    );
    for f in [&junk, &other, &drafts, &trash] {
        let mail::Conn::Imap(c) = &mut conn else { unreachable!() };
        c.session.create(f).await.unwrap();
    }
    {
        let mail::Conn::Imap(c) = &mut conn else { unreachable!() };
        for n in 1..=7 {
            imap::append(c, &junk, &mail("junk", n), "").await.unwrap();
        }
        for n in 1..=2 {
            imap::append(c, &other, &mail("other", n), "").await.unwrap();
        }
        for n in 1..=5 {
            imap::append(c, &drafts, &mail("draft", n), "").await.unwrap();
        }
    }
    assert_eq!(mail::folder_total(&mut conn, &store, "a", &junk).await.unwrap(), 7);

    // Stopped after the first batch of three: the rest stays.
    let mut seen = Vec::new();
    let mut progress = |done: usize, total: usize| {
        seen.push((done, total));
        done == 0
    };
    let bound = bound_of(&mut conn, &store, "a", &junk).await;
    let run = mail::empty_folder(
        &mut conn,
        &store,
        "a",
        &junk,
        &depesha_core::clear::Emptying::Erase,
        &bound,
        &[],
        3,
        &mut progress,
    )
    .await
    .unwrap();
    assert_eq!(
        run,
        depesha_core::clear::Emptied {
            total: 7,
            done: 3,
            stopped: true
        }
    );
    assert_eq!(seen, vec![(0, 7), (3, 7)]);
    assert_eq!(mail::folder_total(&mut conn, &store, "a", &junk).await.unwrap(), 4);

    // Run again: only what is left goes, in two batches; the other folder is untouched.
    let mut seen = Vec::new();
    let mut progress = |done: usize, total: usize| {
        seen.push((done, total));
        true
    };
    let bound = bound_of(&mut conn, &store, "a", &junk).await;
    let run = mail::empty_folder(
        &mut conn,
        &store,
        "a",
        &junk,
        &depesha_core::clear::Emptying::Erase,
        &bound,
        &[],
        3,
        &mut progress,
    )
    .await
    .unwrap();
    assert_eq!(
        run,
        depesha_core::clear::Emptied {
            total: 4,
            done: 4,
            stopped: false
        }
    );
    assert_eq!(seen, vec![(0, 4), (3, 4), (4, 4)]);
    assert_eq!(mail::folder_total(&mut conn, &store, "a", &junk).await.unwrap(), 0);
    assert_eq!(mail::folder_total(&mut conn, &store, "a", &other).await.unwrap(), 2);

    // An empty folder: nothing to do, no batch.
    let bound = bound_of(&mut conn, &store, "a", &junk).await;
    let run = mail::empty_folder(
        &mut conn,
        &store,
        "a",
        &junk,
        &depesha_core::clear::Emptying::Erase,
        &bound,
        &[],
        3,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!(run, depesha_core::clear::Emptied::default());

    // What arrives after the dialog counted is not wiped; a folder renumbered since is refused.
    {
        let mail::Conn::Imap(c) = &mut conn else { unreachable!() };
        for n in 1..=3 {
            imap::append(c, &junk, &mail("before", n), "").await.unwrap();
        }
    }
    let bound = bound_of(&mut conn, &store, "a", &junk).await;
    {
        let mail::Conn::Imap(c) = &mut conn else { unreachable!() };
        imap::append(c, &junk, &mail("late", 1), "").await.unwrap();
    }
    let mail::Bound::Imap(depesha_core::mail::ImapBound { validity, next }) = bound.clone() else {
        unreachable!()
    };
    let stale = mail::Bound::Imap(mail::ImapBound {
        validity: validity + 1,
        next,
    });
    let refused = mail::empty_folder(
        &mut conn,
        &store,
        "a",
        &junk,
        &depesha_core::clear::Emptying::Erase,
        &stale,
        &[],
        3,
        &mut |_, _| true,
    )
    .await;
    assert!(
        matches!(refused, Err(depesha_core::Error::FolderChanged)),
        "{refused:?}"
    );
    let run = mail::empty_folder(
        &mut conn,
        &store,
        "a",
        &junk,
        &depesha_core::clear::Emptying::Erase,
        &bound,
        &[],
        3,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!(
        run,
        depesha_core::clear::Emptied {
            total: 3,
            done: 3,
            stopped: false
        }
    );
    assert_eq!(
        mail::folder_total(&mut conn, &store, "a", &junk).await.unwrap(),
        1,
        "the letter that arrived after the count stays"
    );

    // Drafts go to the Trash, except the one kept (open in a window).
    let mail::Conn::Imap(c) = &mut conn else { unreachable!() };
    let (_, uids) = imap::folder_uids(c, &drafts).await.unwrap();
    assert_eq!(uids.len(), 5);
    let bound = bound_of(&mut conn, &store, "a", &drafts).await;
    // The drafts are cached as the app has them; the first is open in a window.
    store
        .replace_folders(
            "a",
            &[depesha_core::domain::Folder {
                name: drafts.clone(),
                display_name: drafts.clone(),
                delimiter: Some("/".into()),
                role: Some(FolderRole::Drafts),
                selectable: true,
                hidden: false,
            }],
        )
        .unwrap();
    let ids: Vec<i64> = uids
        .iter()
        .map(|uid| {
            let summary = depesha_core::message::Summary {
                message_id: Some(format!("{uid}@x")),
                date: Some(1),
                ..Default::default()
            };
            let msg = depesha_core::store::NewMessage {
                uid: *uid,
                summary: &summary,
                fallback_date: 0,
                size: 1,
                flags: Default::default(),
                keywords: Vec::new(),
            };
            store.insert_message("a", &drafts, &msg).unwrap()
        })
        .collect();
    let clearing = depesha_core::clear::Clearing::default();
    clearing.draft_set("main", "k1", Some(ids[0]), None);
    let request = depesha_core::clear::Request {
        folder: drafts.clone(),
        how: depesha_core::clear::Emptying::ToFolder(trash.clone()),
        bound,
        keep_ids: Vec::new(),
        drafts: true,
    };
    let mut forgot = Vec::new();
    let done = mail::clear_folder(
        &mut conn,
        &store,
        &clearing,
        "a",
        &request,
        &mut |_, _| true,
        &mut |f| forgot.push(matches!(f, depesha_core::clear::Forgot::Done)),
    )
    .await;
    assert_eq!(
        done.result.unwrap(),
        depesha_core::clear::Emptied {
            total: 4,
            done: 4,
            stopped: false
        }
    );
    assert_eq!(done.kept_ids, [ids[0]]);
    assert_eq!(forgot, [true]);
    assert_eq!(
        store.known_uids("a", &drafts).unwrap(),
        uids[..1],
        "the cache keeps the draft that stays"
    );
    let mail::Conn::Imap(c) = &mut conn else { unreachable!() };
    assert_eq!(
        imap::folder_uids(c, &drafts).await.unwrap().1,
        uids[..1],
        "the kept draft stays"
    );
    assert_eq!(
        imap::folder_uids(c, &trash).await.unwrap().1.len(),
        4,
        "the rest is in the trash"
    );
    c.session.logout().await.unwrap();
}

#[tokio::test]
async fn clearing_a_folder_over_starttls() {
    if !enabled() {
        return;
    }
    clears_a_folder(connect("clear").await, "A").await;
}

#[tokio::test]
async fn clearing_a_folder_without_uidplus() {
    if !enabled() {
        return;
    }
    let conn = imap::connect(&server_at(31144).await, &user("clearplain"))
        .await
        .expect("login over STARTTLS");
    assert!(!conn.caps.uidplus, "the stand must not offer UIDPLUS");
    clears_a_folder(conn, "B").await;
}

/// How the proxy of the stand cuts a connection (#114).
#[derive(Clone, Copy)]
enum Cut {
    /// After this long without a write from the client: what a firewall does to a quiet link.
    Silence(Duration),
    /// This long after the connect, whatever is written: a server that limits the age of a session.
    Age(Duration),
}

/// A transparent TCP proxy in front of the stand that cuts connections by `cut`. TLS passes
/// through, so the pinned certificate still fits. Returns its port.
async fn cutting_proxy(cut: Cut) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut client, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let Ok(mut upstream) = tokio::net::TcpStream::connect(("127.0.0.1", 31143)).await else {
                    return;
                };
                let (mut cr, mut cw) = client.split();
                let (mut ur, mut uw) = upstream.split();
                let up = async {
                    let mut buf = [0u8; 4096];
                    loop {
                        let read = cr.read(&mut buf);
                        let n = match cut {
                            Cut::Silence(idle) => tokio::time::timeout(idle, read).await,
                            Cut::Age(_) => Ok(read.await),
                        };
                        match n {
                            Ok(Ok(n)) if n > 0 => uw.write_all(&buf[..n]).await?,
                            _ => return std::io::Result::Ok(()),
                        }
                    }
                };
                let down = tokio::io::copy(&mut ur, &mut cw);
                let age = async {
                    match cut {
                        Cut::Age(age) => tokio::time::sleep(age).await,
                        Cut::Silence(_) => std::future::pending().await,
                    }
                };
                tokio::select! { _ = up => {}, _ = down => {}, _ = age => {} }
            });
        }
    });
    port
}

/// One wait on a connection that a proxy cuts, held as long as the renewal says.
async fn wait_through_cuts(renew: Duration) -> Result<(), Error> {
    let port = cutting_proxy(Cut::Silence(Duration::from_secs(3))).await;
    let mut conn = imap::connect(&server_at(port).await, &user("cut")).await?;
    let began = std::time::Instant::now();
    while began.elapsed() < Duration::from_secs(10) {
        conn = imap::wait_for_changes(conn, "INBOX", Duration::from_secs(2), renew)
            .await?
            .0;
    }
    Ok(())
}

/// With the default renewal (25 minutes) the cut link is a plain drop: the loop of #114.
#[tokio::test]
async fn a_link_cut_when_idle_drops_a_long_idle() {
    if !enabled() {
        return;
    }
    let err = wait_through_cuts(imap::IDLE_RENEW).await.expect_err("must be cut");
    assert!(err.is_transient(), "{err:?}");
}

/// IDLE renewed inside the cut time keeps the link alive over several cut periods.
#[tokio::test]
async fn idle_renewed_inside_the_cut_time_survives_it() {
    if !enabled() {
        return;
    }
    wait_through_cuts(Duration::from_secs(1)).await.expect("no drop");
}

/// The tuning for the tests: the same logic, seconds instead of minutes.
fn quick() -> Tuning {
    Tuning {
        floor: Duration::from_millis(500),
        too_soon: Duration::from_secs(1),
        healthy: Duration::from_secs(60),
        pause: Duration::from_millis(100),
        pause_max: Duration::from_millis(400),
        ..Tuning::default()
    }
}

struct Run {
    pace: IdlePace,
    drops: Vec<(Dropped, DropCause)>,
    waits: usize,
}

/// What the worker does: wait with `mail::wait_for_changes` under one pace, reconnect after a
/// drop, for `run` — against a proxy that cuts by `cut`.
async fn paced(cut: Cut, run: Duration) -> Run {
    let port = cutting_proxy(cut).await;
    let server = server_at(port).await;
    let store = Store::open_in_memory().unwrap();
    let mut out = Run {
        pace: IdlePace::with(quick()),
        drops: Vec::new(),
        waits: 0,
    };
    let began = std::time::Instant::now();
    'connections: while began.elapsed() < run {
        let conn = imap::connect(&server, &user("paced")).await.unwrap();
        let connected = std::time::Instant::now();
        let mut conn = mail::Conn::Imap(conn);
        loop {
            if began.elapsed() >= run {
                break 'connections;
            }
            match mail::wait_for_changes(conn, &store, "d", Duration::from_secs(2), &mut out.pace, connected).await {
                Ok((c, _)) => {
                    conn = c;
                    out.waits += 1;
                }
                Err(d) => {
                    let dropped = d.dropped.expect("a link cut is not a busy server");
                    tokio::time::sleep(dropped.pause).await;
                    out.drops.push((dropped, d.cause));
                    continue 'connections;
                }
            }
        }
    }
    out
}

/// A link cut after 3 s of silence: two drops teach the renewal, then the link is held over
/// several cut periods (#114).
#[tokio::test]
async fn the_pace_holds_a_link_cut_by_silence() {
    if !enabled() {
        return;
    }
    let run = paced(Cut::Silence(Duration::from_secs(3)), Duration::from_secs(18)).await;
    let causes: Vec<_> = run.drops.iter().map(|(_, c)| c.clone()).collect();
    // Two drops teach; a slow runner may cost a third. A pace that does not hold the link
    // is cut every 3 s, which is five or six drops in this run.
    assert!(
        (2..=3).contains(&run.drops.len()),
        "the drops teach, the rest is held: {causes:?}"
    );
    assert!(run.pace.renew() < Duration::from_secs(3), "{:?}", run.pace.renew());
    assert!(run.waits >= 2, "the renewals went through: {}", run.waits);
}

/// A link cut by the age of the connection: the renewal does not stick at the floor, the
/// cut is told once, and the log lines stay at powers of two.
#[tokio::test]
async fn the_pace_does_not_stick_at_the_floor_when_the_age_cuts() {
    if !enabled() {
        return;
    }
    let run = paced(Cut::Age(Duration::from_secs(6)), Duration::from_secs(24)).await;
    assert!(run.drops.len() >= 3, "{}", run.drops.len());
    // A connection that worked and was cut by its age is the server's way, not a failing link:
    // the reconnect does not wait longer for it.
    assert!(
        run.drops.iter().all(|(d, _)| d.pause == quick().pause),
        "{:?}",
        run.drops.iter().map(|(d, _)| d.pause).collect::<Vec<_>>()
    );
    assert_eq!(run.drops.iter().filter(|(d, _)| d.by_age).count(), 1);
    assert_eq!(run.pace.renew(), Tuning::default().max, "the renewal went back up");
    let told = run.drops.iter().find(|(d, _)| d.by_age).unwrap().0.drops;
    assert!(
        run.drops
            .iter()
            .filter(|(d, _)| d.log)
            .all(|(d, _)| d.drops.is_power_of_two() || d.drops == told)
    );
}

/// A letter that arrives in the gap between two IDLEs (after DONE, before the next IDLE)
/// must be seen at once: the renewal does not forget what it was told on the way.
#[tokio::test]
async fn a_letter_arriving_between_two_idles_is_seen_by_the_next_one() {
    if !enabled() {
        return;
    }
    let idle = connect("gap").await;
    let (idle, first) = imap::wait_for_changes(
        idle,
        "INBOX",
        std::time::Duration::from_secs(2),
        std::time::Duration::from_secs(1),
    )
    .await
    .unwrap();
    assert!(matches!(first, IdleOutcome::Timeout));
    let mut other = connect("gap").await;
    imap::append(&mut other, "INBOX", &mail("GAP", 1), "").await.unwrap();
    let began = std::time::Instant::now();
    let (_, second) = imap::wait_for_changes(
        idle,
        "INBOX",
        std::time::Duration::from_secs(2),
        std::time::Duration::from_secs(5),
    )
    .await
    .unwrap();
    assert!(matches!(second, IdleOutcome::Changed), "the letter was missed");
    assert!(
        began.elapsed() < std::time::Duration::from_secs(3),
        "{:?}",
        began.elapsed()
    );
}

/// One letter is one wake-up: what the server sent along with the news (RECENT, a second
/// EXISTS) must not make the next wait report a change again, or the letter is synced twice.
#[tokio::test]
async fn one_letter_wakes_the_idle_once() {
    if !enabled() {
        return;
    }
    let idle = connect("once").await;
    let waiter = tokio::spawn(async move {
        let (idle, first) = imap::wait_for_changes(idle, "INBOX", Duration::from_secs(2), Duration::from_secs(20))
            .await
            .unwrap();
        // The IDLE has just ended: the same letter must not be told again.
        let (_, second) = imap::wait_for_changes(idle, "INBOX", Duration::from_secs(2), Duration::from_secs(1))
            .await
            .unwrap();
        (first, second)
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut other = connect("once").await;
    imap::append(&mut other, "INBOX", &mail("ONCE", 1), "").await.unwrap();
    let (first, second) = tokio::time::timeout(Duration::from_secs(20), waiter)
        .await
        .expect("no wakeup")
        .unwrap();
    assert!(matches!(first, IdleOutcome::Changed));
    assert!(matches!(second, IdleOutcome::Timeout), "the letter was told twice");
}

/// The first wait of a connection made after a drop, the cache having been synced before it:
/// with `letter` a letter comes in while there is no connection. Returns what the wait said,
/// how long it took, and what the wait after it said.
async fn reconnect_after_a_drop(name: &str, letter: bool) -> (IdleOutcome, Duration, IdleOutcome) {
    let port = cutting_proxy(Cut::Age(Duration::from_secs(1))).await;
    let server = server_at(port).await;
    let store = Store::open_in_memory().unwrap();
    // The cache has the mailbox as it is: its mark is what a sync left.
    let mut direct = connect(name).await;
    sync::sync_folder(&mut direct, &store, "d", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    let mut pace = IdlePace::with(Tuning {
        max: Duration::from_secs(2),
        ..quick()
    });
    let conn = imap::connect(&server, &user(name)).await.unwrap();
    let err = mail::wait_for_changes(
        mail::Conn::Imap(conn),
        &store,
        "d",
        Duration::from_secs(2),
        &mut pace,
        std::time::Instant::now(),
    )
    .await
    .err()
    .expect("the proxy cuts the link");
    assert!(err.dropped.is_some());

    // While there is no connection a letter may come in.
    if letter {
        imap::append(&mut direct, "INBOX", &mail("PAUSE", 1), "").await.unwrap();
    }

    // The new connection goes straight to the stand: the proxy would cut it again.
    let conn = connect(name).await;
    let connected = std::time::Instant::now();
    let began = std::time::Instant::now();
    let (conn, first) = mail::wait_for_changes(
        mail::Conn::Imap(conn),
        &store,
        "d",
        Duration::from_secs(2),
        &mut pace,
        connected,
    )
    .await
    .unwrap_or_else(|d| panic!("selected: {:?}", d.error));
    let took = began.elapsed();
    let (_, second) = mail::wait_for_changes(conn, &store, "d", Duration::from_secs(2), &mut pace, connected)
        .await
        .unwrap_or_else(|d| panic!("idled: {:?}", d.error));
    (first, took, second)
}

/// A letter that comes in while the connection is gone is synced at once by the next one: its
/// first wait ends with `Changed` after the SELECT, and the one after it waits as usual.
#[tokio::test]
async fn the_connection_after_a_drop_is_synced_when_a_letter_came_meanwhile() {
    if !enabled() {
        return;
    }
    let (first, took, second) = reconnect_after_a_drop("resync", true).await;
    assert!(matches!(first, IdleOutcome::Changed), "no sync after the reconnect");
    assert!(took < Duration::from_millis(800), "{took:?}");
    assert!(matches!(second, IdleOutcome::Timeout), "told twice");
}

/// Nothing came in meanwhile: no sync, the connection goes straight to IDLE (a full sync of a
/// server without CONDSTORE reads every flag of the folder, and the drops may be many).
#[tokio::test]
async fn the_connection_after_a_drop_goes_straight_to_idle_when_nothing_came() {
    if !enabled() {
        return;
    }
    let (first, took, _) = reconnect_after_a_drop("resyncempty", false).await;
    assert!(matches!(first, IdleOutcome::Timeout), "a sync for nothing");
    assert!(took >= Duration::from_secs(1), "{took:?}");
}

/// A folder made under a parent with a Cyrillic name and a dot for a delimiter: the adapter
/// decodes the parent's cache name, joins the path with the parent's delimiter, and the server
/// lists the child.
#[tokio::test]
async fn a_folder_is_made_under_a_cyrillic_parent_with_a_dot_delimiter() {
    if !enabled() {
        return;
    }
    let mut conn = connect("mkchild").await;
    imap::create_folder(&mut conn, "Работа").await.unwrap();
    let store = Store::open_in_memory().unwrap();
    sync::sync_folder_list(&mut conn, &store, "m").await.unwrap();
    let parent = store
        .folders(Some("m"))
        .unwrap()
        .into_iter()
        .map(|f| f.folder)
        .find(|f| f.display_name == "Работа")
        .expect("the parent is listed");
    // The cache keeps the name as the server spells it: modified UTF-7.
    assert_eq!(parent.name, utf7::encode("Работа"));
    let delimiter = parent.delimiter.clone().expect("a delimiter");
    let mut conn = mail::Conn::Imap(conn);
    mail::create_folder(&mut conn, &store, "m", Some(&parent.name), "Отчёты")
        .await
        .unwrap();
    let mail::Conn::Imap(c) = &mut conn else { unreachable!() };
    let listed = imap::list_folders(c).await.unwrap();
    let child = listed
        .iter()
        .find(|f| f.display_name == format!("Работа{delimiter}Отчёты"))
        .unwrap_or_else(|| {
            panic!(
                "the child is listed: {:?}",
                listed.iter().map(|f| &f.display_name).collect::<Vec<_>>()
            )
        });
    assert_eq!(child.name, utf7::encode(&format!("Работа{delimiter}Отчёты")));
    // Made again, it is made all the same: the server says it exists, and that is no failure.
    mail::create_folder(&mut conn, &store, "m", Some(&parent.name), "Отчёты")
        .await
        .unwrap();
}
