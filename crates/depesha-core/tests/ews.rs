//! EWS against a scripted server that answers like Exchange 2019: login errors,
//! folder names, the synced window, flags, moves, sending with Bcc.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use depesha_core::account::{Credentials, EwsConfig};
use depesha_core::domain::Addr;
use depesha_core::domain::{Draft, FlagChange, FolderRole};
use depesha_core::imap::IdleOutcome;
use depesha_core::mail;
use depesha_core::smtp;
use depesha_core::store::{ListQuery, Store};
use depesha_core::sync::SyncOptions;
use depesha_core::{ews, ntlm};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

const ACCOUNT: &str = "acc";

#[derive(Clone)]
struct Item {
    id: String,
    folder: String,
    received: i64,
    read: bool,
    subject: String,
    message_id: String,
}

struct Mailbox {
    items: Vec<Item>,
    next_id: u32,
    /// Raw requests of CreateItem, to check what was sent.
    created: Vec<String>,
    /// Raw requests of CreateFolder.
    folders_made: Vec<String>,
    /// Offer only Negotiate and NTLM, like Exchange with Basic switched off.
    windows_only: bool,
    /// Throttling: the next requests get `ErrorServerBusy` as a SOAP fault, with
    /// `BackOffMilliseconds` when given.
    busy: Vec<Option<u64>>,
    /// TCP connections accepted.
    connections: usize,
    /// FindItem requests answered, to check a lookup batches them.
    find_items: usize,
}

fn busy_fault(back_off: Option<u64>) -> String {
    let xml = back_off
        .map(|ms| format!(r#"<t:MessageXml xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><t:Value Name="BackOffMilliseconds">{ms}</t:Value></t:MessageXml>"#))
        .unwrap_or_default();
    envelope(&format!(
        r#"<s:Fault><faultcode xmlns:a="http://schemas.microsoft.com/exchange/services/2006/types">a:ErrorServerBusy</faultcode><faultstring xml:lang="en-US">The server cannot service this request right now. Try again later.</faultstring><detail><e:ResponseCode xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">ErrorServerBusy</e:ResponseCode><e:Message xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">The server cannot service this request right now. Try again later.</e:Message>{xml}</detail></s:Fault>"#
    ))
}

type Shared = Arc<Mutex<Mailbox>>;

const FOLDERS: [(&str, &str, &str, &str); 9] = [
    // id, parent, name, class
    ("I", "R", "Входящие", "IPF.Note"),
    ("W", "I", "Работа", "IPF.Note"),
    ("S", "R", "Отправленные", "IPF.Note"),
    ("D", "R", "Черновики", "IPF.Note"),
    ("T", "R", "Удаленные", "IPF.Note"),
    ("J", "R", "Нежелательная почта", "IPF.Note"),
    ("O", "R", "Исходящие", "IPF.Note"),
    ("C", "R", "Календарь", "IPF.Appointment"),
    ("A", "R", "Архив", "IPF.Note"),
];

fn well_known(id: &str) -> Option<&'static str> {
    Some(match id {
        "msgfolderroot" => "R",
        "inbox" => "I",
        "sentitems" => "S",
        "drafts" => "D",
        "deleteditems" => "T",
        "junkemail" => "J",
        "outbox" => "O",
        _ => return None,
    })
}

fn iso(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

fn envelope(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header><h:ServerVersionInfo MajorVersion="15" MinorVersion="2" MajorBuildNumber="1544" MinorBuildNumber="4" xmlns:h="http://schemas.microsoft.com/exchange/services/2006/types"/></s:Header><s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">{body}</s:Body></s:Envelope>"#
    )
}

fn wrap(op: &str, messages: &str) -> String {
    envelope(&format!(
        r#"<m:{op}Response xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages>{messages}</m:ResponseMessages></m:{op}Response>"#
    ))
}

fn ok(op: &str, inner: &str) -> String {
    format!(
        r#"<m:{op}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{inner}</m:{op}ResponseMessage>"#
    )
}

fn err(op: &str, code: &str) -> String {
    format!(
        r#"<m:{op}ResponseMessage ResponseClass="Error"><m:MessageText>{code}</m:MessageText><m:ResponseCode>{code}</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey></m:{op}ResponseMessage>"#
    )
}

fn headers_of(it: &Item) -> String {
    format!(
        "Received: from mx.corp.ru\r\nFrom: \"Анна Петрова\" <anna@corp.ru>\r\nTo: <me@corp.ru>\r\nSubject: {}\r\nDate: {}\r\nMessage-ID: {}\r\nContent-Type: text/plain; charset=utf-8\r\n",
        it.subject,
        chrono::DateTime::from_timestamp(it.received, 0).unwrap().to_rfc2822(),
        it.message_id
    )
}

fn local(n: roxmltree::Node<'_, '_>) -> String {
    n.tag_name().name().to_owned()
}

fn find<'a, 'i>(doc: &'a roxmltree::Document<'i>, name: &str) -> Option<roxmltree::Node<'a, 'i>> {
    doc.descendants().find(|n| n.is_element() && local(*n) == name)
}

fn handle(mb: &mut Mailbox, body: &str) -> String {
    let doc = roxmltree::Document::parse(body).expect("request XML");
    let op = find(&doc, "Body")
        .and_then(|b| b.children().find(|c| c.is_element()))
        .map(local)
        .unwrap_or_default();
    match op.as_str() {
        "GetFolder" => {
            let msgs: String = doc
                .descendants()
                .filter(|n| n.is_element() && local(*n) == "DistinguishedFolderId")
                .map(|n| match well_known(n.attribute("Id").unwrap()) {
                    Some(id) => ok(
                        "GetFolder",
                        &format!(
                            r#"<m:Folders><t:Folder><t:FolderId Id="{id}" ChangeKey="AQ"/></t:Folder></m:Folders>"#
                        ),
                    ),
                    None => err("GetFolder", "ErrorFolderNotFound"),
                })
                .collect();
            wrap("GetFolder", &msgs)
        }
        "FindFolder" => {
            let folders: String = FOLDERS
                .iter()
                .map(|(id, parent, name, class)| {
                    let tag = if class.starts_with("IPF.Appointment") { "CalendarFolder" } else { "Folder" };
                    format!(r#"<t:{tag}><t:FolderId Id="{id}" ChangeKey="AQ"/><t:ParentFolderId Id="{parent}" ChangeKey="AQ"/><t:FolderClass>{class}</t:FolderClass><t:DisplayName>{name}</t:DisplayName></t:{tag}>"#)
                })
                .collect();
            wrap(
                "FindFolder",
                &ok(
                    "FindFolder",
                    &format!(
                        r#"<m:RootFolder IndexedPagingOffset="{n}" TotalItemsInView="{n}" IncludesLastItemInRange="true"><t:Folders>{folders}</t:Folders></m:RootFolder>"#,
                        n = FOLDERS.len()
                    ),
                ),
            )
        }
        "FindItem" => {
            mb.find_items += 1;
            let folder = find(&doc, "ParentFolderIds")
                .and_then(|p| p.descendants().find(|n| local(*n) == "FolderId"))
                .and_then(|n| n.attribute("Id"))
                .unwrap()
                .to_owned();
            let view = find(&doc, "IndexedPageItemView").unwrap();
            let offset: usize = view.attribute("Offset").unwrap().parse().unwrap();
            let max: usize = view.attribute("MaxEntriesReturned").unwrap().parse().unwrap();
            let constant = find(&doc, "Constant")
                .and_then(|c| c.attribute("Value"))
                .map(str::to_owned);
            let mut list: Vec<Item> = mb.items.iter().filter(|i| i.folder == folder).cloned().collect();
            if find(&doc, "IsLessThan").is_some() {
                let before = chrono::DateTime::parse_from_rfc3339(constant.as_deref().unwrap())
                    .unwrap()
                    .timestamp();
                list.retain(|i| i.received < before);
            }
            if find(&doc, "IsEqualTo").is_some() {
                // An Or over Message-IDs carries several Constants; match any of them.
                let wanted: Vec<String> = doc
                    .descendants()
                    .filter(|n| n.is_element() && local(*n) == "Constant")
                    .filter_map(|n| n.attribute("Value"))
                    .map(str::to_owned)
                    .collect();
                list.retain(|i| wanted.contains(&i.message_id));
            }
            if let Some(q) = find(&doc, "QueryString").and_then(|q| q.text()) {
                let word = q.trim_matches('"').to_lowercase();
                list.retain(|i| i.subject.to_lowercase().contains(&word));
            }
            list.sort_by_key(|i| std::cmp::Reverse(i.received));
            let total = list.len();
            let page: Vec<&Item> = list.iter().skip(offset).take(max).collect();
            let last = offset + page.len() >= total;
            let items: String = page
                .iter()
                .map(|i| {
                    format!(
                        r#"<t:Message><t:ItemId Id="{}" ChangeKey="CQ"/><t:DateTimeReceived>{}</t:DateTimeReceived><t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0xe07" PropertyType="Integer"/><t:Value>{}</t:Value></t:ExtendedProperty></t:Message>"#,
                        i.id,
                        iso(i.received),
                        if i.read { 1 } else { 0 }
                    )
                })
                .collect();
            wrap(
                "FindItem",
                &ok(
                    "FindItem",
                    &format!(
                        r#"<m:RootFolder IndexedPagingOffset="{}" TotalItemsInView="{total}" IncludesLastItemInRange="{last}"><t:Items>{items}</t:Items></m:RootFolder>"#,
                        offset + page.len()
                    ),
                ),
            )
        }
        "GetItem" => {
            let mime = find(&doc, "IncludeMimeContent").and_then(|n| n.text()) == Some("true");
            let msgs: String = doc
                .descendants()
                .filter(|n| n.is_element() && local(*n) == "ItemId")
                .map(|n| {
                    let id = n.attribute("Id").unwrap();
                    let Some(it) = mb.items.iter().find(|i| i.id == id) else {
                        return err("GetItem", "ErrorItemNotFound");
                    };
                    let inner = if mime {
                        let raw = format!("{}\r\nПривет!\r\n", headers_of(it));
                        format!(r#"<t:MimeContent CharacterSet="UTF-8">{}</t:MimeContent>"#, BASE64.encode(raw))
                    } else {
                        format!(
                            r#"<t:Subject>{s}</t:Subject><t:DateTimeReceived>{d}</t:DateTimeReceived><t:Size>1234</t:Size><t:DateTimeSent>{d}</t:DateTimeSent><t:HasAttachments>false</t:HasAttachments><t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x7d" PropertyType="String"/><t:Value>{h}</t:Value></t:ExtendedProperty><t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0xe07" PropertyType="Integer"/><t:Value>{r}</t:Value></t:ExtendedProperty><t:From><t:Mailbox><t:Name>Анна Петрова</t:Name><t:EmailAddress>anna@corp.ru</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox></t:From><t:InternetMessageId>{m}</t:InternetMessageId>"#,
                            s = it.subject,
                            d = iso(it.received),
                            h = headers_of(it).replace('<', "&lt;").replace('>', "&gt;").replace("\r\n", "&#xD;\n"),
                            r = if it.read { 1 } else { 0 },
                            m = it.message_id.replace('<', "&lt;").replace('>', "&gt;"),
                        )
                    };
                    ok("GetItem", &format!(r#"<m:Items><t:Message><t:ItemId Id="{id}" ChangeKey="CQ"/>{inner}</t:Message></m:Items>"#))
                })
                .collect();
            wrap("GetItem", &msgs)
        }
        "UpdateItem" => {
            let read = find(&doc, "IsRead").and_then(|n| n.text()).map(|t| t == "true");
            let msgs: String = doc
                .descendants()
                .filter(|n| n.is_element() && local(*n) == "ItemId")
                .map(|n| {
                    let id = n.attribute("Id").unwrap();
                    match mb.items.iter_mut().find(|i| i.id == id) {
                        Some(it) => {
                            if let Some(r) = read {
                                it.read = r;
                            }
                            ok("UpdateItem", "")
                        }
                        None => err("UpdateItem", "ErrorItemNotFound"),
                    }
                })
                .collect();
            wrap("UpdateItem", &msgs)
        }
        "MoveItem" => {
            let to = find(&doc, "ToFolderId")
                .and_then(|n| n.descendants().find(|c| local(*c) == "FolderId"))
                .and_then(|n| n.attribute("Id"))
                .unwrap()
                .to_owned();
            let ids: Vec<String> = find(&doc, "ItemIds")
                .unwrap()
                .children()
                .filter_map(|n| n.attribute("Id").map(str::to_owned))
                .collect();
            let mut msgs = String::new();
            for id in ids {
                mb.next_id += 1;
                let new_id = format!("m{}", mb.next_id);
                match mb.items.iter_mut().find(|i| i.id == id) {
                    Some(it) => {
                        it.id = new_id.clone();
                        it.folder = to.clone();
                        msgs.push_str(&ok(
                            "MoveItem",
                            &format!(
                                r#"<m:Items><t:Message><t:ItemId Id="{new_id}" ChangeKey="CQ"/></t:Message></m:Items>"#
                            ),
                        ));
                    }
                    None => msgs.push_str(&err("MoveItem", "ErrorItemNotFound")),
                }
            }
            wrap("MoveItem", &msgs)
        }
        "DeleteItem" => {
            let ids: Vec<String> = find(&doc, "ItemIds")
                .unwrap()
                .children()
                .filter_map(|n| n.attribute("Id").map(str::to_owned))
                .collect();
            let mut msgs = String::new();
            for id in ids {
                if mb.items.iter().any(|i| i.id == id) {
                    mb.items.retain(|i| i.id != id);
                    msgs.push_str(&ok("DeleteItem", ""));
                } else {
                    msgs.push_str(&err("DeleteItem", "ErrorItemNotFound"));
                }
            }
            wrap("DeleteItem", &msgs)
        }
        "CreateFolder" => {
            mb.folders_made.push(body.to_owned());
            wrap(
                "CreateFolder",
                &ok(
                    "CreateFolder",
                    r#"<m:Folders><t:Folder><t:FolderId Id="N1" ChangeKey="AQ"/></t:Folder></m:Folders>"#,
                ),
            )
        }
        "CreateItem" => {
            mb.created.push(body.to_owned());
            wrap("CreateItem", &ok("CreateItem", "<m:Items/>"))
        }
        // Its answer is no ResponseMessages list: one GetUserPhotoResponse.
        "GetUserPhoto" => {
            let email = find(&doc, "Email").and_then(|n| n.text()).unwrap_or_default();
            let (class, inner) = if email == "boss@corp.ru" {
                (
                    "Success",
                    format!(
                        "<m:HasChanged>true</m:HasChanged><m:PictureData>{}</m:PictureData>",
                        BASE64.encode(b"\xff\xd8\xffphoto")
                    ),
                )
            } else {
                ("Error", "<m:ResponseCode>ErrorItemNotFound</m:ResponseCode>".to_owned())
            };
            envelope(&format!(
                r#"<m:GetUserPhotoResponse ResponseClass="{class}" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">{inner}</m:GetUserPhotoResponse>"#
            ))
        }
        "Subscribe" => wrap("Subscribe", &err("Subscribe", "ErrorInvalidSubscriptionRequest")),
        other => panic!("unexpected EWS operation {other}"),
    }
}

async fn fake_exchange(mailbox: Shared) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mailbox = mailbox.clone();
            mailbox.lock().unwrap().connections += 1;
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut r = BufReader::new(r);
                // NTLM state of this connection: Negotiate and Challenge, then logged in.
                let mut ntlm: Option<(Vec<u8>, Vec<u8>)> = None;
                let mut ntlm_user: Option<String> = None;
                loop {
                    let mut auth = String::new();
                    let mut len = None;
                    let mut line = String::new();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    loop {
                        let mut h = String::new();
                        r.read_line(&mut h).await.unwrap();
                        let h = h.trim_end().to_owned();
                        if h.is_empty() {
                            break;
                        }
                        let (k, v) = h.split_once(':').unwrap();
                        match k.to_ascii_lowercase().as_str() {
                            "content-length" => len = Some(v.trim().parse::<usize>().unwrap()),
                            "authorization" => auth = v.trim().to_owned(),
                            _ => {}
                        }
                    }
                    // IIS refuses a POST without Content-Length, even an empty one.
                    let Some(len) = len else {
                        let head = "HTTP/1.1 411 Length Required\r\nContent-Length: 0\r\n\r\n";
                        if w.write_all(head.as_bytes()).await.is_err() {
                            return;
                        }
                        continue;
                    };
                    let mut body = vec![0; len];
                    r.read_exact(&mut body).await.unwrap();
                    let expected = format!("Basic {}", BASE64.encode("CORP\\me:secret"));
                    let windows_only = mailbox.lock().unwrap().windows_only;
                    let windows = "WWW-Authenticate: Negotiate\r\nWWW-Authenticate: NTLM\r\n".to_owned();
                    let token = auth.strip_prefix("NTLM ").and_then(|t| BASE64.decode(t).ok());
                    let (status, extra, reply) = if windows_only && ntlm_user.is_some() {
                        let text = String::from_utf8(body).unwrap();
                        let reply = handle(&mut mailbox.lock().unwrap(), &text);
                        ("200 OK", String::new(), reply)
                    } else if windows_only {
                        match (token, ntlm.take()) {
                            (Some(t), _) if t.get(8) == Some(&1) => {
                                let challenge = ntlm::server::challenge("CORP");
                                let extra = format!("WWW-Authenticate: NTLM {}\r\n", BASE64.encode(&challenge));
                                ntlm = Some((t, challenge));
                                ("401 Unauthorized", extra, String::new())
                            }
                            (Some(t), Some((negotiate, challenge))) => {
                                match ntlm::server::verify(&negotiate, &challenge, &t, "secret", None) {
                                    Some((user, domain)) => {
                                        assert_eq!((user.as_str(), domain.as_str()), ("me", "CORP"));
                                        ntlm_user = Some(user);
                                        let text = String::from_utf8(body).unwrap();
                                        let reply = handle(&mut mailbox.lock().unwrap(), &text);
                                        ("200 OK", String::new(), reply)
                                    }
                                    None => ("401 Unauthorized", windows, String::new()),
                                }
                            }
                            _ => ("401 Unauthorized", windows, String::new()),
                        }
                    } else if auth != expected {
                        (
                            "401 Unauthorized",
                            "WWW-Authenticate: Basic realm=\"mail.corp.ru\"\r\n".to_owned(),
                            String::new(),
                        )
                    } else if !mailbox.lock().unwrap().busy.is_empty() {
                        let back_off = mailbox.lock().unwrap().busy.remove(0);
                        ("500 Internal Server Error", String::new(), busy_fault(back_off))
                    } else {
                        let text = String::from_utf8(body).unwrap();
                        let reply = handle(&mut mailbox.lock().unwrap(), &text);
                        ("200 OK", String::new(), reply)
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\n{extra}Content-Type: text/xml; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
                        reply.len()
                    );
                    if w.write_all(head.as_bytes()).await.is_err() || w.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

fn item(id: &str, folder: &str, received: i64, subject: &str) -> Item {
    Item {
        id: id.into(),
        folder: folder.into(),
        received,
        read: false,
        subject: subject.into(),
        message_id: format!("<{id}@corp.ru>"),
    }
}

fn inbox_subjects(store: &Store, folder: &str) -> Vec<String> {
    let mut rows = store
        .list(&ListQuery {
            account_id: Some(ACCOUNT.into()),
            folder: Some(folder.into()),
            limit: 100,
            ..Default::default()
        })
        .unwrap();
    rows.sort_by_key(|r| std::cmp::Reverse(r.date));
    rows.into_iter().map(|r| r.subject).collect()
}

#[tokio::test]
async fn ews_mailbox_round_trip() {
    let t0 = 1_790_000_000;
    let mailbox: Shared = Arc::new(Mutex::new(Mailbox {
        items: vec![
            item("m1", "I", t0, "Старое"),
            item("m2", "I", t0 + 60, "Среднее"),
            item("m3", "I", t0 + 120, "Новое"),
        ],
        next_id: 100,
        created: Vec::new(),
        folders_made: Vec::new(),
        windows_only: false,
        busy: Vec::new(),
        connections: 0,
        find_items: 0,
    }));
    let port = fake_exchange(mailbox.clone()).await;
    let config = EwsConfig {
        url: format!("http://127.0.0.1:{port}/EWS/Exchange.asmx"),
        trusted_cert: None,
    };

    // A wrong password is a login error, not a protocol one.
    let wrong = ews::connect(&config, &Credentials::new("CORP\\me", "nope"), "me@corp.ru").await;
    assert_eq!(wrong.err().unwrap().kind(), depesha_core::ErrorKind::Auth);

    let creds = Credentials::new("CORP\\me", "secret");
    let mut s = ews::connect(&config, &creds, "me@corp.ru").await.unwrap();
    let store = Store::open_in_memory().unwrap();

    let folders = ews::sync_folder_list(&mut s, &store, ACCOUNT).await.unwrap();
    let by_name = |n: &str| {
        folders
            .iter()
            .find(|f| f.name == n)
            .unwrap_or_else(|| panic!("no folder {n}"))
    };
    assert_eq!(by_name("INBOX").role, Some(FolderRole::Inbox));
    assert_eq!(by_name("INBOX/Работа").role, None);
    assert_eq!(by_name("Отправленные").role, Some(FolderRole::Sent));
    assert_eq!(by_name("Удаленные").role, Some(FolderRole::Trash));
    assert_eq!(by_name("Архив").role, Some(FolderRole::Archive));
    assert!(by_name("Календарь").hidden);
    assert!(by_name("Исходящие").hidden);
    assert!(!by_name("INBOX").hidden);

    // The first sync takes the newest messages only.
    let report = ews::sync_folder(&mut s, &store, ACCOUNT, "INBOX", SyncOptions { initial_limit: 2 })
        .await
        .unwrap();
    assert_eq!(report.added, 2);
    assert_eq!(inbox_subjects(&store, "INBOX"), ["Новое", "Среднее"]);
    let row = &store
        .list(&ListQuery {
            account_id: Some(ACCOUNT.into()),
            folder: Some("INBOX".into()),
            limit: 10,
            ..Default::default()
        })
        .unwrap()[0];
    assert_eq!(row.from.as_ref().unwrap().email, "anna@corp.ru");
    assert_eq!(row.message_id.as_deref(), Some("m3@corp.ru"));

    assert_eq!(ews::load_older(&mut s, &store, ACCOUNT, "INBOX", 10).await.unwrap(), 1);
    assert_eq!(inbox_subjects(&store, "INBOX"), ["Новое", "Среднее", "Старое"]);
    // The start of the folder is reached.
    assert_eq!(ews::load_older(&mut s, &store, ACCOUNT, "INBOX", 10).await.unwrap(), 0);

    // On the server: new mail, one read in OWA, one deleted.
    {
        let mut mb = mailbox.lock().unwrap();
        mb.items.push(item("m4", "I", t0 + 180, "Свежее"));
        mb.items.iter_mut().find(|i| i.id == "m2").unwrap().read = true;
        mb.items.retain(|i| i.id != "m1");
    }
    let report = ews::sync_folder(&mut s, &store, ACCOUNT, "INBOX", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!((report.added, report.updated, report.removed), (1, 1, 1));
    assert_eq!(inbox_subjects(&store, "INBOX"), ["Свежее", "Новое", "Среднее"]);
    let rows = store
        .list(&ListQuery {
            account_id: Some(ACCOUNT.into()),
            folder: Some("INBOX".into()),
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    let newest = rows.iter().find(|r| r.subject == "Свежее").unwrap();
    let older = rows.iter().find(|r| r.subject == "Среднее").unwrap();
    assert!(newest.uid > older.uid, "new mail gets higher UIDs");
    assert!(older.flags.seen);

    // Body, flags, move.
    let raw = ews::fetch_raw(&mut s, &store, ACCOUNT, "INBOX", newest.uid)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&raw).contains("Привет!"));
    ews::set_flag(&mut s, &store, ACCOUNT, "INBOX", &[newest.uid], FlagChange::Seen(true))
        .await
        .unwrap();
    assert!(
        mailbox
            .lock()
            .unwrap()
            .items
            .iter()
            .find(|i| i.subject == "Свежее")
            .unwrap()
            .read
    );
    ews::move_messages(&mut s, &store, ACCOUNT, "INBOX", &[newest.uid], "INBOX/Работа")
        .await
        .unwrap();
    ews::sync_folder(&mut s, &store, ACCOUNT, "INBOX", SyncOptions::default())
        .await
        .unwrap();
    ews::sync_folder(&mut s, &store, ACCOUNT, "INBOX/Работа", SyncOptions::default())
        .await
        .unwrap();
    assert_eq!(inbox_subjects(&store, "INBOX"), ["Новое", "Среднее"]);
    assert_eq!(inbox_subjects(&store, "INBOX/Работа"), ["Свежее"]);

    // Snooze-style move by Message-ID marks the message unread at the destination.
    let n = ews::move_by_message_id(
        &mut s,
        &store,
        ACCOUNT,
        "INBOX/Работа",
        &["m4@corp.ru".into()],
        "Архив",
        true,
    )
    .await
    .unwrap();
    assert_eq!(n, 1);
    let moved = mailbox
        .lock()
        .unwrap()
        .items
        .iter()
        .find(|i| i.subject == "Свежее")
        .cloned()
        .unwrap();
    assert_eq!(moved.folder, "A");
    assert!(!moved.read);

    // A lookup by Message-IDs the cache does not know: one FindItem for the batch, not
    // one request per letter.
    {
        let mut mb = mailbox.lock().unwrap();
        mb.items.push(item("x1", "I", t0 + 200, "Первое"));
        mb.items.push(item("x2", "I", t0 + 210, "Второе"));
        mb.find_items = 0;
    }
    let n = ews::move_by_message_id(
        &mut s,
        &store,
        ACCOUNT,
        "INBOX",
        &["x1@corp.ru".into(), "x2@corp.ru".into()],
        "Архив",
        false,
    )
    .await
    .unwrap();
    assert_eq!(n, 2);
    assert_eq!(mailbox.lock().unwrap().find_items, 1);

    // Server search caches what it finds.
    let ids = ews::search_server(&mut s, &store, ACCOUNT, "Архив", "свежее")
        .await
        .unwrap();
    assert_eq!(ids.len(), 1);
    assert_eq!(store.get(ids[0]).unwrap().unwrap().subject, "Свежее");

    // Sending: MIME plus Bcc outside it; the server keeps the copy in Sent Items.
    let draft = Draft {
        from: Some(Addr {
            name: Some("Я".into()),
            email: "me@corp.ru".into(),
        }),
        to: vec![Addr {
            name: None,
            email: "boss@corp.ru".into(),
        }],
        bcc: vec![Addr {
            name: None,
            email: "secret@corp.ru".into(),
        }],
        subject: "Отчёт".into(),
        text: "Готово".into(),
        ..Default::default()
    };
    let msg = smtp::build(&draft).unwrap();
    let raw = ews::send(&mut s, &msg).await.unwrap();
    assert!(String::from_utf8_lossy(&raw).contains("boss@corp.ru"));
    let created = mailbox.lock().unwrap().created.pop().unwrap();
    assert!(created.contains(r#"MessageDisposition="SendAndSaveCopy""#));
    assert!(created.contains("<t:BccRecipients><t:Mailbox><t:EmailAddress>secret@corp.ru</t:EmailAddress>"));
    assert!(!created.contains("<t:EmailAddress>boss@corp.ru"));

    // No streaming subscriptions: wait a little and report a change.
    let outcome = ews::wait_for_changes(&mut s, &store, ACCOUNT, Duration::from_millis(10))
        .await
        .unwrap();
    assert!(matches!(outcome, IdleOutcome::Changed));

    // Basic switched off on the server: Windows login (NTLM) on every connection.
    mailbox.lock().unwrap().windows_only = true;
    let wrong = ews::connect(&config, &Credentials::new("CORP\\me", "nope"), "me@corp.ru").await;
    let e = wrong.err().unwrap();
    assert_eq!(e.kind(), depesha_core::ErrorKind::Auth);
    assert!(!e.to_string().contains("Basic"), "{e}");
    let mut s = ews::connect(&config, &creds, "me@corp.ru").await.unwrap();
    // Further requests go on the logged-in connection.
    let folders = ews::sync_folder_list(&mut s, &store, ACCOUNT).await.unwrap();
    assert!(folders.iter().any(|f| f.name == "INBOX"));

    // Colleagues' photos; strangers have none.
    let photo = ews::user_photo(&mut s, "boss@corp.ru").await.unwrap();
    assert_eq!(photo.as_deref(), Some(&b"\xff\xd8\xffphoto"[..]));
    assert_eq!(ews::user_photo(&mut s, "stranger@example.com").await.unwrap(), None);
}

#[tokio::test]
async fn a_busy_exchange_names_its_pause_and_keeps_the_connection() {
    let mailbox: Shared = Arc::new(Mutex::new(Mailbox {
        items: Vec::new(),
        next_id: 1,
        created: Vec::new(),
        folders_made: Vec::new(),
        windows_only: false,
        busy: Vec::new(),
        connections: 0,
        find_items: 0,
    }));
    let port = fake_exchange(mailbox.clone()).await;
    let config = EwsConfig {
        url: format!("http://127.0.0.1:{port}/EWS/Exchange.asmx"),
        trusted_cert: None,
    };
    let creds = Credentials::new("CORP\\me", "secret");
    let mut s = ews::connect(&config, &creds, "me@corp.ru").await.unwrap();
    let store = Store::open_in_memory().unwrap();

    mailbox.lock().unwrap().busy = vec![Some(2000), None];
    let e = ews::sync_folder_list(&mut s, &store, ACCOUNT).await.unwrap_err();
    assert!(e.is_busy(), "{e:?}");
    assert_eq!(e.back_off(), Some(Duration::from_secs(2)));
    // Not a broken link and not a login error: the account is not paused for it.
    assert_eq!(e.kind(), depesha_core::ErrorKind::Network);
    let e = ews::sync_folder_list(&mut s, &store, ACCOUNT).await.unwrap_err();
    assert!(e.is_busy());
    assert_eq!(e.back_off(), None);

    // The retry goes on the same connection: no new TCP connection, no new login.
    let folders = ews::sync_folder_list(&mut s, &store, ACCOUNT).await.unwrap();
    assert!(folders.iter().any(|f| f.name == "INBOX"));
    assert_eq!(mailbox.lock().unwrap().connections, 1);
}

/// The bound a dialog would have counted for the folder now (#74).
async fn bound_of(conn: &mut mail::Conn, store: &Store, account: &str, folder: &str) -> mail::Bound {
    mail::folder_count(conn, store, account, folder).await.unwrap().1
}

/// #74: junk is wiped by `DeleteItem` from the snapshot the dialog counted; drafts go to the trash
/// by `MoveItem`, all of them on the server and not only the cached window, except the one that
/// is kept.
#[tokio::test]
async fn clearing_exchange_folders() {
    let t0 = 1_790_000_000;
    let mut items = Vec::new();
    for n in 1..=3 {
        items.push(item(&format!("j{n}"), "J", t0 + n, "Спам"));
    }
    for n in 1..=5 {
        items.push(item(&format!("d{n}"), "D", t0 + n, "Черновик"));
    }
    items.push(item("m1", "I", t0, "Письмо"));
    let mailbox: Shared = Arc::new(Mutex::new(Mailbox {
        items,
        next_id: 100,
        created: Vec::new(),
        folders_made: Vec::new(),
        windows_only: false,
        busy: Vec::new(),
        connections: 0,
        find_items: 0,
    }));
    let port = fake_exchange(mailbox.clone()).await;
    let config = EwsConfig {
        url: format!("http://127.0.0.1:{port}/EWS/Exchange.asmx"),
        trusted_cert: None,
    };
    let s = ews::connect(&config, &Credentials::new("CORP\\me", "secret"), "me@corp.ru")
        .await
        .unwrap();
    let store = Store::open_in_memory().unwrap();
    let mut conn = mail::Conn::Ews(s);
    let mail::Conn::Ews(s) = &mut conn else { unreachable!() };
    ews::sync_folder_list(s, &store, ACCOUNT).await.unwrap();

    let junk = "Нежелательная почта";
    assert_eq!(mail::folder_total(&mut conn, &store, ACCOUNT, junk).await.unwrap(), 3);
    let mut seen = Vec::new();
    let bound = bound_of(&mut conn, &store, ACCOUNT, junk).await;
    let run = mail::empty_folder(
        &mut conn,
        &store,
        ACCOUNT,
        junk,
        &depesha_core::clear::Emptying::Erase,
        &bound,
        &[],
        500,
        &mut |d, t| {
            seen.push((d, t));
            true
        },
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
    assert_eq!(seen, vec![(0, 3), (3, 3)]);
    {
        let mb = mailbox.lock().unwrap();
        assert!(mb.items.iter().all(|i| i.folder != "J"));
        assert!(mb.items.iter().any(|i| i.folder == "I"), "other folders stay");
    }
    // Empty now: nothing to do.
    let bound = bound_of(&mut conn, &store, ACCOUNT, junk).await;
    let run = mail::empty_folder(
        &mut conn,
        &store,
        ACCOUNT,
        junk,
        &depesha_core::clear::Emptying::Erase,
        &bound,
        &[],
        500,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!(run, depesha_core::clear::Emptied::default());

    // What the cache names to keep stays on the server: three items are cached, one is kept.
    {
        let mut mb = mailbox.lock().unwrap();
        for n in 1..=3 {
            mb.items.push(item(&format!("kept{n}"), "J", t0 + n, "Оставить"));
        }
    }
    let mail::Conn::Ews(s) = &mut conn else { unreachable!() };
    ews::sync_folder(s, &store, ACCOUNT, junk, SyncOptions { initial_limit: 10 })
        .await
        .unwrap();
    let cached = store.ews_items(ACCOUNT, junk).unwrap();
    assert_eq!(cached.len(), 3);
    let (keep_uid, keep_item, _) = cached[0].clone();
    let bound = bound_of(&mut conn, &store, ACCOUNT, junk).await;
    let run = mail::empty_folder(
        &mut conn,
        &store,
        ACCOUNT,
        junk,
        &depesha_core::clear::Emptying::Erase,
        &bound,
        &[keep_uid],
        500,
        &mut |_, _| true,
    )
    .await
    .unwrap();
    assert_eq!((run.total, run.done), (2, 2));
    {
        let mb = mailbox.lock().unwrap();
        let left: Vec<&str> = mb
            .items
            .iter()
            .filter(|i| i.folder == "J")
            .map(|i| i.id.as_str())
            .collect();
        assert_eq!(
            left,
            [keep_item.as_str()],
            "the item of the kept UID stays on the server"
        );
    }
    // Put things in order for what follows.
    let bound = bound_of(&mut conn, &store, ACCOUNT, junk).await;
    mail::empty_folder(
        &mut conn,
        &store,
        ACCOUNT,
        junk,
        &depesha_core::clear::Emptying::Erase,
        &bound,
        &[],
        500,
        &mut |_, _| true,
    )
    .await
    .unwrap();

    // An item that arrives after the dialog counted is not wiped; the same bound run again
    // meets items that are gone already and goes on.
    {
        let mut mb = mailbox.lock().unwrap();
        for n in 1..=2 {
            mb.items.push(item(&format!("k{n}"), "J", t0 + n, "Спам"));
        }
    }
    let bound = bound_of(&mut conn, &store, ACCOUNT, junk).await;
    mailbox.lock().unwrap().items.push(item("late", "J", t0 + 9, "Поздно"));
    for _ in 0..2 {
        let run = mail::empty_folder(
            &mut conn,
            &store,
            ACCOUNT,
            junk,
            &depesha_core::clear::Emptying::Erase,
            &bound,
            &[],
            500,
            &mut |_, _| true,
        )
        .await
        .unwrap();
        assert_eq!(
            run,
            depesha_core::clear::Emptied {
                total: 2,
                done: 2,
                stopped: false
            }
        );
    }
    {
        let mb = mailbox.lock().unwrap();
        let left: Vec<&str> = mb
            .items
            .iter()
            .filter(|i| i.folder == "J")
            .map(|i| i.id.as_str())
            .collect();
        assert_eq!(left, ["late"], "the item that arrived after the count stays");
    }
    // A bound of another kind is no bound of this mailbox.
    let mismatched = mail::empty_folder(
        &mut conn,
        &store,
        ACCOUNT,
        junk,
        &depesha_core::clear::Emptying::Erase,
        &mail::Bound::Imap(mail::ImapBound { validity: 1, next: 1 }),
        &[],
        500,
        &mut |_, _| true,
    )
    .await;
    assert!(mismatched.is_err());

    // Only the newest two drafts are cached; the newest is kept (open in a window).
    let mail::Conn::Ews(s) = &mut conn else { unreachable!() };
    ews::sync_folder(s, &store, ACCOUNT, "Черновики", SyncOptions { initial_limit: 2 })
        .await
        .unwrap();
    let newest = store
        .list(&ListQuery {
            account_id: Some(ACCOUNT.into()),
            folder: Some("Черновики".into()),
            limit: 10,
            ..Default::default()
        })
        .unwrap()[0]
        .id;
    let bound = bound_of(&mut conn, &store, ACCOUNT, "Черновики").await;
    let clearing = depesha_core::clear::Clearing::default();
    clearing.draft_set("main", "k1", Some(newest), None);
    let request = depesha_core::clear::Request {
        folder: "Черновики".into(),
        how: depesha_core::clear::Emptying::ToFolder("Удаленные".into()),
        bound,
        keep_ids: Vec::new(),
        drafts: true,
    };
    let done = mail::clear_folder(
        &mut conn,
        &store,
        &clearing,
        ACCOUNT,
        &request,
        &mut |_, _| true,
        &mut |_| {},
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
    assert_eq!(done.kept_ids, [newest]);
    let mb = mailbox.lock().unwrap();
    assert_eq!(
        mb.items.iter().filter(|i| i.folder == "D").count(),
        1,
        "the kept draft stays"
    );
    assert_eq!(
        mb.items.iter().filter(|i| i.folder == "T").count(),
        4,
        "the rest, not just the cached, is in the trash"
    );
}

/// #117: the kind of a draft's action travels inside the `Acts-On` mark through the MIME the
/// draft is saved with in Exchange (which lines Depesha writes is `with_service_headers`, tested
/// in the app), and the draft read back still tells a forward from an answer.
#[tokio::test]
async fn an_exchange_draft_carries_the_kind_of_its_action_inside_the_mark() {
    use depesha_core::domain::{Act, ActsOn};
    use depesha_core::message::{self, ACTS_ON_HEADER};
    let mailbox: Shared = Arc::new(Mutex::new(Mailbox {
        items: Vec::new(),
        next_id: 100,
        created: Vec::new(),
        folders_made: Vec::new(),
        windows_only: false,
        busy: Vec::new(),
        connections: 0,
        find_items: 0,
    }));
    let port = fake_exchange(mailbox.clone()).await;
    let config = EwsConfig {
        url: format!("http://127.0.0.1:{port}/EWS/Exchange.asmx"),
        trusted_cert: None,
    };
    let mut s = ews::connect(&config, &Credentials::new("CORP\\me", "secret"), "me@corp.ru")
        .await
        .unwrap();
    let store = Store::open_in_memory().unwrap();
    ews::sync_folder_list(&mut s, &store, ACCOUNT).await.unwrap();

    let acts_on = ActsOn {
        account_id: ACCOUNT.into(),
        message_id: "<orig@corp.ru>".into(),
        folder: "INBOX".into(),
        act: Act::Forward,
        waiting: false,
    };
    let value = message::encode_acts_on(&acts_on).unwrap();
    let signed = message::signed_acts_on(&value, "sig").unwrap();
    let raw = format!(
        "{ACTS_ON_HEADER}: {signed}\r\nMessage-ID: <d1@depesha.local>\r\nFrom: me@corp.ru\r\nTo: boss@corp.ru\r\nSubject: Fwd: x\r\n\r\nтекст\r\n"
    );
    ews::append_unless_exists(
        &mut s,
        &store,
        ACCOUNT,
        "Черновики",
        raw.as_bytes(),
        "(\\Draft \\Seen)",
        None,
    )
    .await
    .unwrap();

    let created = mailbox.lock().unwrap().created.pop().unwrap();
    let mime = created.split("<t:MimeContent CharacterSet=\"UTF-8\">").nth(1).unwrap();
    let mime = BASE64.decode(mime.split("</t:MimeContent>").next().unwrap()).unwrap();
    let mime = String::from_utf8(mime).unwrap();
    assert_eq!(message::draft_act(mime.as_bytes()), Some(Act::Forward));
}

/// A folder made under a parent goes to the parent's id: the key of the cache is a path, the
/// server wants the id (`ParentFolderId`).
#[tokio::test]
async fn a_folder_made_under_a_parent_names_the_parent_by_its_id() {
    let mailbox: Shared = Arc::new(Mutex::new(Mailbox {
        items: Vec::new(),
        next_id: 100,
        created: Vec::new(),
        folders_made: Vec::new(),
        windows_only: false,
        busy: Vec::new(),
        connections: 0,
        find_items: 0,
    }));
    let port = fake_exchange(mailbox.clone()).await;
    let config = EwsConfig {
        url: format!("http://127.0.0.1:{port}/EWS/Exchange.asmx"),
        trusted_cert: None,
    };
    let s = ews::connect(&config, &Credentials::new("CORP\\me", "secret"), "me@corp.ru")
        .await
        .unwrap();
    let store = Store::open_in_memory().unwrap();
    let mut conn = mail::Conn::Ews(s);
    let mail::Conn::Ews(s) = &mut conn else { unreachable!() };
    ews::sync_folder_list(s, &store, ACCOUNT).await.unwrap();
    // Under the Inbox, under a folder of the Inbox, and at the top.
    mail::create_folder(&mut conn, &store, ACCOUNT, Some("INBOX"), "Отчёты")
        .await
        .unwrap();
    mail::create_folder(&mut conn, &store, ACCOUNT, Some("INBOX/Работа"), "Акты")
        .await
        .unwrap();
    mail::create_folder(&mut conn, &store, ACCOUNT, None, "Личное")
        .await
        .unwrap();
    let made = mailbox.lock().unwrap().folders_made.clone();
    assert_eq!(made.len(), 3);
    let parent = |body: &str| {
        let doc = roxmltree::Document::parse(body).unwrap();
        let node = doc.descendants().find(|n| local(*n) == "ParentFolderId").unwrap();
        let child = node.children().find(|c| c.is_element()).unwrap();
        (local(child), child.attribute("Id").map(str::to_owned))
    };
    assert_eq!(parent(&made[0]), ("FolderId".into(), Some("I".into())));
    assert!(made[0].contains("<t:DisplayName>Отчёты</t:DisplayName>"));
    assert_eq!(parent(&made[1]), ("FolderId".into(), Some("W".into())));
    assert!(made[1].contains("<t:DisplayName>Акты</t:DisplayName>"));
    // At the top it is the root, a well-known folder.
    assert_eq!(
        parent(&made[2]),
        ("DistinguishedFolderId".into(), Some("msgfolderroot".into()))
    );
}
