//! End-to-end check against GreenMail, see compose.test.yaml.
//! Skipped unless DEPESHA_IT=1.

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::domain::Addr;
use depesha_core::domain::{Draft, FlagChange, FolderRole, OutgoingAttachment};
use depesha_core::imap;
use depesha_core::mail;
use depesha_core::message;
use depesha_core::smtp;
use depesha_core::store::{ListQuery, Store};
use depesha_core::sync::{self, SyncOptions};

fn enabled() -> bool {
    std::env::var("DEPESHA_IT").is_ok_and(|v| v == "1")
}

fn imap_server() -> ServerConfig {
    ServerConfig::new("127.0.0.1", 3143, Security::Plain)
}

fn smtp_server() -> ServerConfig {
    ServerConfig::new("127.0.0.1", 3025, Security::Plain)
}

fn addr(email: &str) -> Addr {
    Addr {
        name: None,
        email: email.into(),
    }
}

#[tokio::test]
async fn send_sync_read_flag_move() {
    if !enabled() {
        eprintln!("skipped: set DEPESHA_IT=1 and start compose.test.yaml");
        return;
    }
    let alice = Credentials::new("alice", "secret");
    let bob = Credentials::new("bob", "secret");
    let subject = format!("Проверка {}", std::process::id());

    let draft = Draft {
        from: Some(Addr {
            name: Some("Алиса".into()),
            email: "alice@local.test".into(),
        }),
        to: vec![addr("bob@local.test")],
        subject: subject.clone(),
        text: "Привет, Боб! Счёт во вложении.\n.точка в начале строки".into(),
        html: Some("<p>Привет, <b>Боб</b>!</p><img src=\"https://tracker.example/p.gif\">".into()),
        attachments: vec![OutgoingAttachment {
            name: "счёт.txt".into(),
            mime: "text/plain".into(),
            data: b"100".to_vec(),
        }],
        ..Default::default()
    };
    let msg = smtp::build(&draft).unwrap();
    let raw_sent = smtp::send(&smtp_server(), &alice, &msg).await.expect("smtp send");

    // Keep a copy in Alice's Sent, as the GUI does after sending.
    let mut alice_conn = imap::connect(&imap_server(), &alice).await.expect("alice login");
    let _ = alice_conn.session.create("Sent").await;
    imap::append(&mut alice_conn, "Sent", &raw_sent, "(\\Seen)")
        .await
        .expect("append to Sent");
    let message_id = message::parse_summary(&raw_sent).message_id.unwrap();
    assert_eq!(
        imap::find_by_message_id(&mut alice_conn, "Sent", &message_id)
            .await
            .unwrap()
            .len(),
        1
    );
    alice_conn.session.logout().await.unwrap();

    let store = Store::open_in_memory().unwrap();
    let mut conn = imap::connect(&imap_server(), &bob).await.expect("bob login");
    let _ = conn.session.create("Trash").await;
    let _ = conn.session.create("Calendar").await;
    let folders = sync::sync_folder_list(&mut conn, &store, "bob").await.unwrap();
    assert!(folders.iter().any(|f| f.role == Some(FolderRole::Inbox)));
    assert!(folders.iter().any(|f| f.name == "Calendar" && f.hidden), "{folders:?}");

    let report = sync::sync_folder(&mut conn, &store, "bob", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    assert!(report.added >= 1, "{report:?}");

    let inbox = store.list(&ListQuery::default()).unwrap();
    let row = inbox
        .iter()
        .find(|m| m.subject == subject)
        .expect("message in unified inbox")
        .clone();
    assert_eq!(row.from.as_ref().map(|a| a.email.as_str()), Some("alice@local.test"));
    assert!(!row.flags.seen);
    assert!(row.has_attachments);

    // Offline download in batches: a UID gone from the server is simply missing.
    let batch = imap::fetch_raw_many(&mut conn, "INBOX", &[row.uid, 999_999])
        .await
        .unwrap();
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].0, row.uid);
    assert_eq!(message::parse_summary(&batch[0].1).subject, subject);

    // Body: downloaded once, indexed, \Seen untouched by BODY.PEEK.
    let raw = sync::load_body(&mut conn, &store, row.id).await.unwrap();
    let view = message::parse_view(&raw, false).unwrap();
    assert!(view.html.as_deref().unwrap().contains("<b>Боб</b>"));
    assert!(
        view.text.as_deref().unwrap().contains("\n.точка"),
        "dot-stuffing must be undone: {:?}",
        view.text
    );
    assert!(view.has_remote_content);
    assert!(view.attachments.iter().any(|a| a.name == "счёт.txt"));
    assert_eq!(store.search("вложении", Some("bob"), 0, &[]).unwrap().len(), 1);
    let again = sync::sync_folder(&mut conn, &store, "bob", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!(again, Default::default(), "second sync must be a no-op");

    // Flag on the server, read back through sync.
    imap::set_flag(&mut conn, "INBOX", None, &[row.uid], FlagChange::Seen(true))
        .await
        .unwrap();
    let report = sync::sync_folder(&mut conn, &store, "bob", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!(report.updated, 1);
    assert!(store.get(row.id).unwrap().unwrap().flags.seen);

    // Move to Trash: gone from INBOX, present in Trash.
    imap::move_messages(&mut conn, "INBOX", None, &[row.uid], "Trash")
        .await
        .unwrap();
    let report = sync::sync_folder(&mut conn, &store, "bob", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!(report.removed, 1);
    assert!(store.get(row.id).unwrap().is_none());

    // The same without MOVE: COPY + \Deleted + UID EXPUNGE.
    let second = Draft {
        subject: format!("{subject} 2"),
        attachments: vec![],
        html: None,
        ..draft.clone()
    };
    smtp::send(&smtp_server(), &alice, &smtp::build(&second).unwrap())
        .await
        .unwrap();
    sync::sync_folder(&mut conn, &store, "bob", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    let uid2 = store
        .list(&ListQuery::default())
        .unwrap()
        .iter()
        .find(|m| m.subject == second.subject)
        .unwrap()
        .uid;
    conn.caps.move_ = false;
    imap::move_messages(&mut conn, "INBOX", None, &[uid2], "Trash")
        .await
        .unwrap();
    let report = sync::sync_folder(&mut conn, &store, "bob", "INBOX", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!(report.removed, 1, "fallback move");
    conn.caps.move_ = true;

    sync::sync_folder(&mut conn, &store, "bob", "Trash", SyncOptions::default())
        .await
        .unwrap();
    let trash = store
        .list(&ListQuery {
            role: Some(FolderRole::Trash),
            ..Default::default()
        })
        .unwrap();
    let trashed = trash.iter().find(|m| m.subject == subject).expect("message in Trash");
    assert!(
        trash.iter().any(|m| m.subject == second.subject),
        "fallback-moved message in Trash"
    );

    imap::delete_permanently(&mut conn, "Trash", None, &[trashed.uid])
        .await
        .unwrap();
    let report = sync::sync_folder(&mut conn, &store, "bob", "Trash", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!(report.removed, 1);
    conn.session.logout().await.unwrap();
}

/// Folder layout of a Russian Exchange 2019 mailbox, which has no SPECIAL-USE.
#[tokio::test]
async fn exchange_russian_folder_layout() {
    if !enabled() {
        return;
    }
    let mut conn = imap::connect(&imap_server(), &Credentials::new("alice", "secret"))
        .await
        .unwrap();
    let names = [
        "Отправленные",
        "Удаленные",
        "Черновики",
        "Нежелательная почта",
        "Исходящие",
        "Календарь",
        "Календарь.Дни рождения",
        "Контакты",
        "Задачи",
        "Заметки",
        "Журнал",
        "Проблемы синхронизации",
        "Проблемы синхронизации.Конфликты",
        "Архив",
        "Проекты",
    ];
    for n in names {
        let _ = conn.session.create(depesha_core::utf7::encode(n)).await;
    }
    let folders = imap::list_folders(&mut conn).await.unwrap();
    let role = |n: &str| folders.iter().find(|f| f.display_name == n).and_then(|f| f.role);
    let hidden = |n: &str| folders.iter().find(|f| f.display_name == n).map(|f| f.hidden);
    assert_eq!(role("INBOX"), Some(FolderRole::Inbox));
    assert_eq!(role("Отправленные"), Some(FolderRole::Sent));
    assert_eq!(role("Удаленные"), Some(FolderRole::Trash));
    assert_eq!(role("Черновики"), Some(FolderRole::Drafts));
    assert_eq!(role("Нежелательная почта"), Some(FolderRole::Junk));
    assert_eq!(role("Архив"), Some(FolderRole::Archive));
    for n in [
        "Календарь",
        "Календарь.Дни рождения",
        "Контакты",
        "Задачи",
        "Заметки",
        "Журнал",
        "Исходящие",
        "Проблемы синхронизации",
        "Проблемы синхронизации.Конфликты",
    ] {
        assert_eq!(hidden(n), Some(true), "{n} must be hidden: {folders:?}");
    }
    assert_eq!(hidden("Проекты"), Some(false));
    conn.session.logout().await.unwrap();
}

#[tokio::test]
async fn idle_sees_new_mail() {
    if !enabled() {
        return;
    }
    let carol = Credentials::new("carol", "secret");
    let conn = imap::connect(&imap_server(), &carol).await.unwrap();
    let waiter = tokio::spawn(async move {
        imap::wait_for_changes(conn, "INBOX", std::time::Duration::from_secs(2))
            .await
            .map(|(_, o)| o)
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let draft = Draft {
        from: Some(addr("alice@local.test")),
        to: vec![addr("carol@local.test")],
        subject: "IDLE".into(),
        text: "ping".into(),
        ..Default::default()
    };
    smtp::send(
        &smtp_server(),
        &Credentials::new("alice", "secret"),
        &smtp::build(&draft).unwrap(),
    )
    .await
    .unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), waiter)
        .await
        .expect("no IDLE wakeup");
    assert!(matches!(outcome.unwrap().unwrap(), imap::IdleOutcome::Changed));
}

#[tokio::test]
async fn wrong_password_is_auth_error() {
    if !enabled() {
        return;
    }
    let err = imap::connect(&imap_server(), &Credentials::new("bob", "wrong"))
        .await
        .err()
        .unwrap();
    assert!(matches!(err, depesha_core::Error::Auth(_)), "{err:?}");
    let err = smtp::check(&smtp_server(), &Credentials::new("bob", "wrong"))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "auth", "{err:?}");
}

#[tokio::test]
async fn untrusted_certificate_can_be_pinned() {
    if !enabled() {
        return;
    }
    let bob = Credentials::new("bob", "secret");
    for (port, is_imap) in [(3993, true), (3465, false)] {
        let mut server = ServerConfig::new("localhost", port, Security::Tls);
        let err = if is_imap {
            imap::connect(&server, &bob).await.err().unwrap()
        } else {
            smtp::check(&server, &bob).await.unwrap_err()
        };
        let depesha_core::Error::Certificate(problem) = err else {
            panic!("port {port}: expected certificate error, got {err:?}");
        };
        assert_eq!(problem.sha256.len(), 64);
        assert!(problem.subject.contains("GreenMail"), "{problem:?}");

        server.trusted_cert = Some(problem.sha256.to_uppercase());
        if is_imap {
            imap::connect(&server, &bob)
                .await
                .expect("pinned IMAPS")
                .session
                .logout()
                .await
                .unwrap();
        } else {
            smtp::check(&server, &bob).await.expect("pinned SMTPS");
        }

        server.trusted_cert = Some("00".repeat(32));
        let err = if is_imap {
            imap::connect(&server, &bob).await.err().unwrap()
        } else {
            smtp::check(&server, &bob).await.unwrap_err()
        };
        assert_eq!(err.kind(), "certificate", "another pin must not be accepted");
    }
}

#[tokio::test]
async fn refuses_plaintext_when_starttls_missing() {
    if !enabled() {
        return;
    }
    // GreenMail's plain ports do not offer STARTTLS, like a misconfigured Exchange receive connector.
    let server = ServerConfig::new("127.0.0.1", 3025, Security::StartTls);
    let err = smtp::check(&server, &Credentials::new("bob", "secret"))
        .await
        .unwrap_err();
    assert!(matches!(err, depesha_core::Error::NoTls), "{err:?}");
    let server = ServerConfig::new("127.0.0.1", 3143, Security::StartTls);
    let err = imap::connect(&server, &Credentials::new("bob", "secret"))
        .await
        .err()
        .unwrap();
    assert!(matches!(err, depesha_core::Error::NoTls), "{err:?}");
}

fn letter(kind: &str, n: usize) -> Vec<u8> {
    format!(
        "From: Тест <test@example.org>\r\nTo: me@example.org\r\nSubject: {kind} {n}\r\nMessage-ID: <{kind}{n}.{}@example.org>\r\n\
         Date: Fri, 2 Oct 2026 10:00:00 +0300\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nТело {n}\r\n",
        std::process::id()
    )
    .into_bytes()
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
            imap::append(c, &junk, &letter("junk", n), "").await.unwrap();
        }
        for n in 1..=2 {
            imap::append(c, &other, &letter("other", n), "").await.unwrap();
        }
        for n in 1..=5 {
            imap::append(c, &drafts, &letter("draft", n), "").await.unwrap();
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
            imap::append(c, &junk, &letter("before", n), "").await.unwrap();
        }
    }
    let bound = bound_of(&mut conn, &store, "a", &junk).await;
    {
        let mail::Conn::Imap(c) = &mut conn else { unreachable!() };
        imap::append(c, &junk, &letter("late", 1), "").await.unwrap();
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
async fn clearing_a_folder() {
    if !enabled() {
        return;
    }
    let conn = imap::connect(&imap_server(), &Credentials::new("carol", "secret"))
        .await
        .expect("carol login");
    clears_a_folder(conn, &std::process::id().to_string()).await;
}
