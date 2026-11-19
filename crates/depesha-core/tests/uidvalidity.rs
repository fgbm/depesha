#![cfg(test)]

use depesha_core::account::{Credentials, Security, ServerConfig};
use depesha_core::domain::{Folder, FolderRole};
use depesha_core::message::Summary;
use depesha_core::store::{NewMessage, Store};
use depesha_core::{Error, imap, mail, sync};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

const ACCOUNT: &str = "test";
const FOLDER: &str = "INBOX";
const OLD: u32 = 3;
const NEW: u32 = 4;
const UID: u32 = 7;
const OLD_BODY: &str = "Subject: Cached letter\r\n\r\nOriginal content.\r\n";
const NEW_BODY: &str = "Subject: Other letter\r\n\r\nDifferent content.\r\n";

async fn serve(socket: TcpStream, validity: u32) -> Vec<String> {
    let (input, mut output) = socket.into_split();
    output.write_all(b"* OK ready\r\n").await.unwrap();
    let mut lines = BufReader::new(input).lines();
    let mut commands = Vec::new();
    while let Some(line) = lines.next_line().await.unwrap() {
        let (tag, command) = line.split_once(' ').unwrap();
        commands.push(command.to_owned());
        let response = match command {
            "CAPABILITY" => "* CAPABILITY IMAP4rev1\r\n".to_owned(),
            _ if command.starts_with("LOGIN ") => String::new(),
            _ if command.starts_with("EXAMINE ") || command.starts_with("SELECT ") => {
                format!("* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY {validity}] current\r\n")
            }
            "UID SEARCH UID 1:*" => format!("* SEARCH {UID}\r\n"),
            _ if command.starts_with("UID SEARCH UID 1:") => "* SEARCH 6\r\n".to_owned(),
            _ if command.starts_with("UID SEARCH ") => format!("* SEARCH {UID}\r\n"),
            _ if command.ends_with("(UID FLAGS)") => format!("* 1 FETCH (UID {UID} FLAGS ())\r\n"),
            _ if command.ends_with("(UID BODY.PEEK[])") => {
                let body = if validity == OLD { OLD_BODY } else { NEW_BODY };
                format!("* 1 FETCH (UID {UID} BODY[] {{{}}}\r\n{body})\r\n", body.len())
            }
            _ if command.ends_with("BODY.PEEK[HEADER])") => {
                let uid = if command.starts_with("UID FETCH 6 ") { 6 } else { UID };
                let header = "Subject: Other letter\r\n\r\n";
                format!(
                    "* 1 FETCH (UID {uid} FLAGS () RFC822.SIZE 42 INTERNALDATE \"01-Nov-2026 00:00:00 +0000\" BODY[HEADER] {{{}}}\r\n{header})\r\n",
                    header.len()
                )
            }
            _ if command.ends_with("(UID BODYSTRUCTURE)") => format!(
                "* 1 FETCH (UID {UID} BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"7BIT\" 12 1))\r\n"
            ),
            _ if command.contains("BODY.PEEK[TEXT]") => {
                let text = "Another text";
                format!("* 1 FETCH (UID {UID} BODY[TEXT]<0> {{{}}}\r\n{text})\r\n", text.len())
            }
            _ => panic!("unexpected command: {command}"),
        };
        output
            .write_all(format!("{response}{tag} OK done\r\n").as_bytes())
            .await
            .unwrap();
    }
    commands
}

struct Fixture {
    conn: mail::Conn,
    store: Store,
    id: Option<i64>,
    server: JoinHandle<Vec<String>>,
}

impl Fixture {
    async fn new(cached_validity: Option<u32>, observed_validity: u32) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            serve(socket, observed_validity).await
        });
        let config = ServerConfig::new("127.0.0.1", port, Security::Plain);
        let conn = imap::connect(&config, &Credentials::new("user", "test")).await.unwrap();
        let store = Store::open_in_memory().unwrap();
        store
            .replace_folders(
                ACCOUNT,
                &[Folder {
                    name: FOLDER.into(),
                    display_name: FOLDER.into(),
                    delimiter: Some("/".into()),
                    role: Some(FolderRole::Inbox),
                    selectable: true,
                    hidden: false,
                }],
            )
            .unwrap();
        let id = cached_validity.map(|validity| {
            let summary = Summary {
                subject: "Cached letter".into(),
                ..Default::default()
            };
            store.set_folder_state(ACCOUNT, FOLDER, validity, UID).unwrap();
            store
                .insert_message(
                    ACCOUNT,
                    FOLDER,
                    &NewMessage {
                        uid: UID,
                        summary: &summary,
                        fallback_date: 1,
                        size: 42,
                        flags: Default::default(),
                        keywords: Vec::new(),
                    },
                )
                .unwrap()
        });
        Self {
            conn: mail::Conn::Imap(conn),
            store,
            id,
            server,
        }
    }

    async fn assert_no_uid_commands(self) {
        drop(self.conn);
        let commands = self.server.await.unwrap();
        assert!(!commands.iter().any(|line| line.starts_with("UID ")), "{commands:?}");
    }
}

#[tokio::test]
async fn opening_a_cached_uid_from_another_generation_does_not_fetch_a_body() {
    let mut fixture = Fixture::new(Some(OLD), NEW).await;
    let id = fixture.id.unwrap();
    let result = mail::load_body(&mut fixture.conn, &fixture.store, id).await;

    assert!(matches!(result, Err(Error::FolderChanged)), "{result:?}");
    assert!(fixture.store.body(id).unwrap().is_none());
    assert_eq!(fixture.store.get(id).unwrap().unwrap().subject, "Cached letter");
    fixture.assert_no_uid_commands().await;
}

#[tokio::test]
async fn opening_a_cached_uid_in_the_same_generation_fetches_the_body() {
    let mut fixture = Fixture::new(Some(OLD), OLD).await;
    let id = fixture.id.unwrap();
    let body = mail::load_body(&mut fixture.conn, &fixture.store, id).await.unwrap();

    assert_eq!(body, OLD_BODY.as_bytes());
    assert_eq!(fixture.store.body(id).unwrap(), Some(body));
}

#[tokio::test]
async fn a_body_already_cached_can_be_opened_after_the_server_recreates_the_folder() {
    let mut fixture = Fixture::new(Some(OLD), NEW).await;
    let id = fixture.id.unwrap();
    fixture
        .store
        .save_body(id, OLD_BODY.as_bytes(), "Original content.")
        .unwrap();
    let body = mail::load_body(&mut fixture.conn, &fixture.store, id).await.unwrap();

    assert_eq!(body, OLD_BODY.as_bytes());
    fixture.assert_no_uid_commands().await;
}

#[tokio::test]
async fn offline_prefetch_rejects_a_reused_uid_before_reading_the_body() {
    let mut fixture = Fixture::new(Some(OLD), NEW).await;
    let id = fixture.id.unwrap();
    let result = mail::prefetch_bodies(&mut fixture.conn, &fixture.store, FOLDER, &[(id, UID)]).await;

    assert!(matches!(result, Err(Error::FolderChanged)), "{result:?}");
    assert!(fixture.store.body(id).unwrap().is_none());
    fixture.assert_no_uid_commands().await;
}

#[tokio::test]
async fn the_preview_backfill_does_not_read_from_a_recreated_folder() {
    let mut fixture = Fixture::new(Some(OLD), NEW).await;
    let result = mail::read_snippets(&mut fixture.conn, &fixture.store, ACCOUNT, FOLDER, &[UID]).await;

    assert!(matches!(result, Err(Error::FolderChanged)), "{result:?}");
    fixture.assert_no_uid_commands().await;
}

#[tokio::test]
async fn server_search_does_not_treat_a_reused_uid_as_the_cached_letter() {
    let mut fixture = Fixture::new(Some(OLD), NEW).await;
    let result = mail::search_server(&mut fixture.conn, &fixture.store, ACCOUNT, FOLDER, "other").await;

    assert!(matches!(result, Err(Error::FolderChanged)), "{result:?}");
    fixture.assert_no_uid_commands().await;
}

#[tokio::test]
async fn the_first_search_records_the_generation_of_its_results() {
    let mut fixture = Fixture::new(None, NEW).await;
    fixture.store.set_folder_state(ACCOUNT, FOLDER, 0, 120).unwrap();
    let found = mail::search_server(&mut fixture.conn, &fixture.store, ACCOUNT, FOLDER, "other")
        .await
        .unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(fixture.store.folder_state(ACCOUNT, FOLDER).unwrap(), (NEW, 0));
}

#[tokio::test]
async fn history_does_not_extend_the_cache_after_the_server_recreates_the_folder() {
    let mut fixture = Fixture::new(Some(OLD), NEW).await;
    fixture.store.set_window_start(ACCOUNT, FOLDER, UID).unwrap();
    let result = mail::load_older(&mut fixture.conn, &fixture.store, ACCOUNT, FOLDER, 20).await;

    assert!(matches!(result, Err(Error::FolderChanged)), "{result:?}");
    assert_eq!(fixture.store.window_start(ACCOUNT, FOLDER).unwrap(), UID);
    fixture.assert_no_uid_commands().await;
}

#[tokio::test]
async fn opening_a_cached_uid_of_unknown_generation_does_not_read_the_server() {
    let mut fixture = Fixture::new(Some(0), NEW).await;
    let id = fixture.id.unwrap();
    let result = mail::load_body(&mut fixture.conn, &fixture.store, id).await;

    assert!(matches!(result, Err(Error::FolderChanged)), "{result:?}");
    fixture.assert_no_uid_commands().await;
}

#[tokio::test]
async fn first_sync_replaces_a_cached_uid_of_unknown_generation() {
    let mut fixture = Fixture::new(Some(0), NEW).await;
    let old_id = fixture.id.unwrap();
    fixture
        .store
        .save_body(old_id, OLD_BODY.as_bytes(), "Original content.")
        .unwrap();
    mail::sync_folder(
        &mut fixture.conn,
        &fixture.store,
        ACCOUNT,
        FOLDER,
        sync::SyncOptions::default(),
    )
    .await
    .unwrap();

    let row = fixture.store.find_by_uid(ACCOUNT, FOLDER, UID).unwrap().unwrap();
    assert_eq!(row.subject, "Other letter");
    assert_eq!(fixture.store.folder_state(ACCOUNT, FOLDER).unwrap(), (NEW, UID));
    let body = mail::load_body(&mut fixture.conn, &fixture.store, row.id)
        .await
        .unwrap();
    assert_eq!(body, NEW_BODY.as_bytes());
}
