use std::collections::{HashMap, HashSet};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, TimeZone, Utc};
use roxmltree::Node;

use super::{Session, child, children, desc, escape, parse, responses, single, text};
use crate::avatar::Receiver;
use crate::imap::{FlagChange, Flags, Folder, FolderRole, IdleOutcome, is_non_mail};
use crate::message::{self, Addr, Importance, Summary};
use crate::query::SearchQuery;
use crate::store::{NewMessage, Store};
use crate::sync::{FolderSync, SyncOptions};
use crate::tr;
use crate::{Error, Result};

/// The inbox gets the IMAP name, so code that looks for `INBOX` works for EWS too.
pub const INBOX: &str = "INBOX";
const DELIMITER: &str = "/";
/// New mail gets UIDs counting up from here, older mail (load older, search) counting down.
const UID_BASE: u32 = 1 << 31;
/// Items per FindItem page: ids and flags only, so a page is small.
const PAGE: usize = 500;
/// Items per GetItem with headers.
const FETCH_BATCH: usize = 50;
/// Message-IDs per FindItem when looking items up by Message-ID.
const FIND_BATCH: usize = 20;
/// Items written to the cache in one commit, as IMAP's fetches are.
const WRITE_BATCH: usize = 200;
/// Folder pages one deep `FindFolder` walk may take. A server that keeps answering
/// `IncludesLastItemInRange="false"` while ignoring `Offset` would spin forever, and
/// there is no read timeout to stop it: this bounds the walk instead. 100 pages of
/// 1000 folders is far past any real mailbox.
const FOLDER_PAGES_MAX: usize = 100;

const PR_TRANSPORT_HEADERS: &str = "0x007D";
const PR_MESSAGE_FLAGS: &str = "0x0E07";
const PR_LAST_VERB: &str = "0x1081";
/// `PidTagLastVerbExecutionTime`: when the last verb was done.
const PR_LAST_VERB_TIME: &str = "0x1082";
const PR_FLAG_STATUS: &str = "0x1090";
/// `PR_MESSAGE_SIZE_EXTENDED`: the bytes a folder and its contents take. The mailbox's
/// occupied space is the sum over every folder.
const PR_MESSAGE_SIZE_EXTENDED: &str = "0x0E08";

const MSGFLAG_READ: i64 = 0x1;
const MSGFLAG_UNSENT: i64 = 0x8;
const VERB_REPLIED: i64 = 102;
const VERB_REPLIED_ALL: i64 = 103;
/// `NOTEIVERB_FORWARD` (MS-OXOMSG 2.2.1.4).
const VERB_FORWARDED: i64 = 104;
const FLAG_FLAGGED: i64 = 2;

fn ext(tag: &str, kind: &str) -> String {
    format!(r#"<t:ExtendedFieldURI PropertyTag="{tag}" PropertyType="{kind}"/>"#)
}

fn field(uri: &str) -> String {
    format!(r#"<t:FieldURI FieldURI="{uri}"/>"#)
}

fn item_ids(ids: &[String]) -> String {
    ids.iter()
        .map(|id| format!(r#"<t:ItemId Id="{}"/>"#, escape(id)))
        .collect()
}

fn folder_ref(id: &str) -> String {
    format!(r#"<t:FolderId Id="{}"/>"#, escape(id))
}

fn parse_time(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s.trim()).ok().map(|d| d.timestamp())
}

fn iso(t: i64) -> String {
    Utc.timestamp_opt(t, 0)
        .single()
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

/// Extended MAPI properties of an item by tag number.
fn ext_props(item: Node<'_, '_>) -> HashMap<u32, String> {
    children(item, "ExtendedProperty")
        .filter_map(|p| {
            let tag = child(p, "ExtendedFieldURI")?.attribute("PropertyTag")?;
            let tag = u32::from_str_radix(tag.trim().trim_start_matches("0x").trim_start_matches("0X"), 16).ok()?;
            Some((tag, text(p, "Value").unwrap_or_default().to_owned()))
        })
        .collect()
}

fn tag(t: &str) -> u32 {
    u32::from_str_radix(t.trim_start_matches("0x"), 16).expect("constant tag")
}

fn flags_of(props: &HashMap<u32, String>) -> Flags {
    let int = |t: &str| props.get(&tag(t)).and_then(|v| v.trim().parse::<i64>().ok());
    let msg = int(PR_MESSAGE_FLAGS).unwrap_or(MSGFLAG_READ);
    Flags {
        seen: msg & MSGFLAG_READ != 0,
        draft: msg & MSGFLAG_UNSENT != 0,
        flagged: int(PR_FLAG_STATUS) == Some(FLAG_FLAGGED),
        answered: matches!(int(PR_LAST_VERB), Some(VERB_REPLIED | VERB_REPLIED_ALL)),
        deleted: false,
        // Exchange keeps the last verb only: a forward after a reply is a forward.
        forwarded: int(PR_LAST_VERB) == Some(VERB_FORWARDED),
        answered_all: int(PR_LAST_VERB) == Some(VERB_REPLIED_ALL),
    }
}

/// The folder's rights for the Exchange flavour, from its `EffectiveRights` element
/// ([MS-OXWSCORE]): a `Folder` in GetFolder carries `Read`, `CreateContents`,
/// `CreateHierarchy`, `Delete` and `Modify` as children. A missing element is unknown.
pub fn effective_rights(folder: Node<'_, '_>) -> Option<crate::acl::Rights> {
    let er = child(folder, "EffectiveRights")?;
    let on = |name: &str| {
        text(er, name)
            .map(|v| v.trim() == "true" || v.trim() == "1")
            .unwrap_or(false)
    };
    Some(crate::acl::Rights::from_effective(
        on("Read"),
        on("CreateContents"),
        on("CreateHierarchy"),
        on("Delete"),
        on("Modify"),
    ))
}

/// A folder's rights from Exchange's `EffectiveRights` ([MS-OXWSCORE]): a GetFolder with
/// the `AllProperties` shape carries them. `None` when the server did not send the element.
pub async fn folder_rights(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
) -> Result<Option<crate::acl::Rights>> {
    let id = folder_id(store, account_id, folder)?;
    let body = format!(
        "<m:GetFolder><m:FolderShape><t:BaseShape>AllProperties</t:BaseShape></m:FolderShape><m:FolderIds>{}</m:FolderIds></m:GetFolder>",
        folder_ref(&id)
    );
    let text_ = s.call(&body).await?;
    let doc = parse(&text_)?;
    let resp = single(&doc)?;
    let Some(folder_node) = child(resp, "Folders").and_then(|f| f.children().find(Node::is_element)) else {
        return Ok(None);
    };
    Ok(effective_rights(folder_node))
}

/// The categories of an item, from its `Categories` child. Exchange keeps them on the
/// server; Depesha shows them as labels (#42, Exchange frame).
pub fn categories_of(item: Node<'_, '_>) -> Vec<String> {
    child(item, "Categories")
        .map(|c| {
            children(c, "String")
                .filter_map(|s| s.text())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The `Updates` that appends one category to an item's list, leaving the rest as they are.
pub fn categories_add(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some(format!(
        "<t:AppendToItemField>{}<t:Message><t:Categories><t:String>{}</t:String></t:Categories></t:Message></t:AppendToItemField>",
        field("message:Categories"),
        escape(name)
    ))
}

/// The `Updates` that sets an item's categories to exactly `names`; empty clears them.
pub fn categories_set(names: &[String]) -> String {
    let list: String = names
        .iter()
        .map(|n| format!("<t:String>{}</t:String>", escape(n)))
        .collect();
    format!(
        "<t:SetItemField>{}<t:Message><t:Categories>{list}</t:Categories></t:Message></t:SetItemField>",
        field("message:Categories")
    )
}

/// Item elements of a FindItem/GetItem answer: `Message`, `MeetingRequest`, `PostItem`...
fn items<'a, 'i>(n: Node<'a, 'i>) -> Vec<Node<'a, 'i>> {
    match child(n, "RootFolder")
        .and_then(|r| child(r, "Items"))
        .or_else(|| child(n, "Items"))
    {
        Some(list) => list.children().filter(Node::is_element).collect(),
        None => Vec::new(),
    }
}

fn item_id(item: Node<'_, '_>) -> Option<String> {
    child(item, "ItemId")?.attribute("Id").map(str::to_owned)
}

/// The ChangeKey of an item, as a GetItem answer carries it on its `ItemId`.
pub fn change_key_of(item: Node<'_, '_>) -> Option<String> {
    child(item, "ItemId")?.attribute("ChangeKey").map(str::to_owned)
}

/// An `<t:ItemId>` for an update: with the ChangeKey the read gave, so Exchange refuses
/// the update instead of overwriting a change another client made meanwhile.
pub fn item_ref(id: &str, change_key: Option<&str>) -> String {
    match change_key {
        Some(key) => format!(r#"<t:ItemId Id="{}" ChangeKey="{}"/>"#, escape(id), escape(key)),
        None => format!(r#"<t:ItemId Id="{}"/>"#, escape(id)),
    }
}

/// The `UpdateItem` body of a set of `<t:ItemChange>`s. `conflict` is the
/// `ConflictResolution` ([MS-OXWSCORE]): `AutoResolve` lets the server merge a change
/// made meanwhile, `AlwaysOverwrite` writes over it.
pub fn update_item(changes: &str, conflict: &str) -> String {
    format!(
        r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="{conflict}" SuppressReadReceipts="true"><m:ItemChanges>{changes}</m:ItemChanges></m:UpdateItem>"#
    )
}

// Folders

#[derive(Debug)]
struct RawFolder {
    id: String,
    parent: String,
    name: String,
    class: String,
}

/// The mailbox's mail folders with IMAP-like names, and the EWS id of each.
pub async fn list_folders(s: &mut Session) -> Result<Vec<(Folder, String)>> {
    const WELL_KNOWN: [&str; 7] = [
        "msgfolderroot",
        "inbox",
        "sentitems",
        "drafts",
        "deleteditems",
        "junkemail",
        "outbox",
    ];
    let body = format!(
        "<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds>{}</m:FolderIds></m:GetFolder>",
        WELL_KNOWN
            .iter()
            .map(|id| format!(r#"<t:DistinguishedFolderId Id="{id}"/>"#))
            .collect::<String>()
    );
    let text_ = s.call(&body).await?;
    let doc = parse(&text_)?;
    let mut known: HashMap<&str, String> = HashMap::new();
    for (name, r) in WELL_KNOWN.iter().zip(responses(&doc)) {
        if let Ok(n) = r
            && let Some(id) = desc(n, "FolderId").and_then(|f| f.attribute("Id"))
        {
            known.insert(name, id.to_owned());
        }
    }
    let root = known
        .get("msgfolderroot")
        .cloned()
        .ok_or_else(|| Error::Protocol(tr!("the mailbox has no folder root", "у ящика нет корня папок")))?;

    let mut raw = Vec::new();
    let mut offset = 0;
    for _ in 0..FOLDER_PAGES_MAX {
        let body = find_folder_page(
            &folder_ref(&root),
            &format!(
                "{}{}{}",
                field("folder:ParentFolderId"),
                field("folder:DisplayName"),
                field("folder:FolderClass")
            ),
            offset,
        );
        let text_ = s.call(&body).await?;
        let doc = parse(&text_)?;
        let resp = single(&doc)?;
        let Some(root_folder) = child(resp, "RootFolder") else {
            break;
        };
        let before = raw.len();
        if let Some(list) = child(root_folder, "Folders") {
            for f in list.children().filter(Node::is_element) {
                let (Some(id), Some(parent)) = (
                    child(f, "FolderId").and_then(|n| n.attribute("Id")),
                    child(f, "ParentFolderId").and_then(|n| n.attribute("Id")),
                ) else {
                    continue;
                };
                raw.push(RawFolder {
                    id: id.to_owned(),
                    parent: parent.to_owned(),
                    name: text(f, "DisplayName").unwrap_or_default().to_owned(),
                    class: text(f, "FolderClass").unwrap_or_default().to_owned(),
                });
            }
        }
        offset = raw.len();
        if raw.len() == before || !has_next_page(root_folder) {
            break;
        }
    }
    Ok(build_folders(&raw, &root, &known))
}

/// Turns the flat EWS list into named folders with roles; non-mail ones are hidden.
fn build_folders(raw: &[RawFolder], root: &str, known: &HashMap<&str, String>) -> Vec<(Folder, String)> {
    let by_id: HashMap<&str, &RawFolder> = raw.iter().map(|f| (f.id.as_str(), f)).collect();
    let inbox = known.get("inbox").map(String::as_str);
    let outbox = known.get("outbox").map(String::as_str);
    let role_of_id = |id: &str| -> Option<FolderRole> {
        let well = known.iter().find(|(_, v)| v.as_str() == id).map(|(k, _)| *k)?;
        Some(match well {
            "inbox" => FolderRole::Inbox,
            "sentitems" => FolderRole::Sent,
            "drafts" => FolderRole::Drafts,
            "deleteditems" => FolderRole::Trash,
            "junkemail" => FolderRole::Junk,
            _ => return None,
        })
    };
    // Ancestors from the folder up to the root, the folder first.
    let chain = |id: &str| -> Option<Vec<&RawFolder>> {
        let mut out = Vec::new();
        let mut cur = id;
        while cur != root {
            let f = by_id.get(cur)?;
            out.push(*f);
            if out.len() > 32 {
                return None;
            }
            cur = &f.parent;
        }
        Some(out)
    };
    let mut folders: Vec<(Folder, String)> = Vec::new();
    for f in raw {
        let Some(chain) = chain(&f.id) else { continue };
        let mut parts: Vec<String> = Vec::new();
        for a in chain.iter().rev() {
            if Some(a.id.as_str()) == inbox {
                parts.clear();
                parts.push(INBOX.to_owned());
            } else {
                // The delimiter cannot appear inside a name.
                parts.push(a.name.replace(DELIMITER, "\u{2215}"));
            }
        }
        let name = parts.join(DELIMITER);
        let not_mail = |a: &RawFolder| {
            (!a.class.is_empty() && !a.class.starts_with("IPF.Note"))
                || Some(a.id.as_str()) == outbox
                || (a.parent == root && role_of_id(&a.id).is_none() && is_non_mail(&a.name))
        };
        let hidden = chain.iter().any(|a| not_mail(a));
        folders.push((
            Folder {
                display_name: name.clone(),
                name,
                delimiter: Some(DELIMITER.into()),
                role: role_of_id(&f.id),
                selectable: true,
                hidden,
            },
            f.id.clone(),
        ));
    }
    // Archive and Snoozed have no well-known id: guess them by name at the top level.
    let mut taken: HashSet<FolderRole> = folders.iter().filter_map(|(f, _)| f.role).collect();
    for (f, _) in &mut folders {
        if f.role.is_none()
            && !f.hidden
            && !f.name.contains(DELIMITER)
            && let Some(role) =
                FolderRole::guess(&f.name).filter(|r| matches!(r, FolderRole::Archive | FolderRole::Snoozed))
            && taken.insert(role)
        {
            f.role = Some(role);
        }
    }
    folders
}

/// The mailbox's occupied space: `PR_MESSAGE_SIZE_EXTENDED` summed over every folder
/// of the store, by one deep `FindFolder` with paging. The walk starts at `root`, not
/// `msgfolderroot`: Recoverable Items and the other NON_IPM subtrees count in the
/// quota too and would be missed under `msgfolderroot`. EWS has no store object, so no
/// limit is read here: only what is used.
///
/// Returns the bytes and how many folders the walk listed, so a caller can tell a real
/// zero (folders seen, none reporting their size) from a walk that found nothing.
pub async fn mailbox_bytes(s: &mut Session) -> Result<(u64, usize)> {
    let mut total = 0u64;
    let mut folders = 0usize;
    let mut offset = 0usize;
    // Bounded like `list_folders`: a server that ignores `Offset` and keeps saying
    // `IncludesLastItemInRange="false"` would otherwise spin forever (no read timeout).
    for _ in 0..FOLDER_PAGES_MAX {
        let body = find_folder_body(offset);
        let text_ = s.call(&body).await?;
        let doc = parse(&text_)?;
        let resp = single(&doc)?;
        let Some(root_folder) = child(resp, "RootFolder") else {
            break;
        };
        let (bytes, count) = folders_bytes(root_folder);
        total = total.saturating_add(bytes);
        folders += count;
        if count == 0 || !has_next_page(root_folder) {
            break;
        }
        offset += count;
    }
    Ok((total, folders))
}

/// One page of the deep `FindFolder` from `root`: the folder ids and their
/// `PR_MESSAGE_SIZE_EXTENDED`. `root`, not `msgfolderroot`: the NON_IPM subtrees count.
pub(crate) fn find_folder_body(offset: usize) -> String {
    find_folder_page(
        r#"<t:DistinguishedFolderId Id="root"/>"#,
        &ext(PR_MESSAGE_SIZE_EXTENDED, "Long"),
        offset,
    )
}

/// A `FindFolder` page of `additional` properties under `parent`, `1000` folders at
/// `offset`. Shared by the folder list and the occupied-space walk: their shape, paging
/// and exit condition must not drift apart.
fn find_folder_page(parent: &str, additional: &str, offset: usize) -> String {
    format!(
        r#"<m:FindFolder Traversal="Deep"><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{additional}</t:AdditionalProperties></m:FolderShape><m:IndexedPageFolderView MaxEntriesReturned="1000" Offset="{offset}" BasePoint="Beginning"/><m:ParentFolderIds>{parent}</m:ParentFolderIds></m:FindFolder>"#
    )
}

/// Whether a `RootFolder` page has a page after it. `IncludesLastItemInRange` is the
/// answer when present: `"false"`/`"0"` (xs:boolean) mean more, `"true"`/`"1"` mean the
/// end. Without the attribute there is nothing to page on: the walk ends. The caller
/// also stops on an empty page, so a server that says `"false"` forever cannot spin it.
pub(crate) fn has_next_page(root_folder: Node<'_, '_>) -> bool {
    match root_folder.attribute("IncludesLastItemInRange") {
        Some(v) => matches!(v.trim(), "false" | "0"),
        None => false,
    }
}

/// The bytes a page of folders takes and how many folders it listed: the sum of
/// `PR_MESSAGE_SIZE_EXTENDED` over them, a folder without it counting zero.
pub(crate) fn folders_bytes(root_folder: Node<'_, '_>) -> (u64, usize) {
    let Some(list) = child(root_folder, "Folders") else {
        return (0, 0);
    };
    let mut bytes = 0u64;
    let mut count = 0usize;
    for f in list.children().filter(Node::is_element) {
        count += 1;
        bytes = bytes.saturating_add(
            ext_props(f)
                .get(&tag(PR_MESSAGE_SIZE_EXTENDED))
                .and_then(|v| v.trim().parse::<u64>().ok())
                .unwrap_or(0),
        );
    }
    (bytes, count)
}

pub async fn sync_folder_list(s: &mut Session, store: &Store, account_id: &str) -> Result<Vec<Folder>> {
    let list = list_folders(s).await?;
    let folders: Vec<Folder> = list.iter().map(|(f, _)| f.clone()).collect();
    store.replace_folders(account_id, &folders)?;
    let ids: Vec<(String, String)> = list.into_iter().map(|(f, id)| (f.name, id)).collect();
    // Folders deleted and created again lose their cache here.
    store.ews_set_folders(account_id, &ids)?;
    Ok(folders)
}

fn folder_id(store: &Store, account_id: &str, folder: &str) -> Result<String> {
    store.ews_folder_id(account_id, folder)?.ok_or_else(|| Error::Ews {
        code: "ErrorFolderNotFound".into(),
        message: folder.to_owned(),
        back_off: None,
    })
}

// Items

#[derive(Debug, Clone)]
struct Scanned {
    id: String,
    received: i64,
    flags: Flags,
    /// The item's Exchange categories, as the letter's labels (#42): the sync brings them
    /// into the cache, so a category set in Outlook shows up.
    categories: Vec<String>,
}

struct Page {
    items: Vec<Scanned>,
    last: bool,
    /// `TotalItemsInView`: the whole folder (or the restricted view), not just this page.
    total: Option<usize>,
}

fn scan_shape() -> String {
    format!(
        "<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{}{}{}{}{}</t:AdditionalProperties></m:ItemShape>",
        field("item:DateTimeReceived"),
        field("item:Categories"),
        ext(PR_MESSAGE_FLAGS, "Integer"),
        ext(PR_FLAG_STATUS, "Integer"),
        ext(PR_LAST_VERB, "Integer"),
    )
}

/// Newest first; `restriction` and `query` narrow the list.
async fn find_page(
    s: &mut Session,
    folder_id: &str,
    offset: usize,
    max: usize,
    restriction: Option<&str>,
    query: Option<&str>,
) -> Result<Page> {
    let body = format!(
        r#"<m:FindItem Traversal="Shallow">{}<m:IndexedPageItemView MaxEntriesReturned="{max}" Offset="{offset}" BasePoint="Beginning"/>{}<m:SortOrder><t:FieldOrder Order="Descending">{}</t:FieldOrder></m:SortOrder><m:ParentFolderIds>{}</m:ParentFolderIds>{}</m:FindItem>"#,
        scan_shape(),
        restriction
            .map(|r| format!("<m:Restriction>{r}</m:Restriction>"))
            .unwrap_or_default(),
        field("item:DateTimeReceived"),
        folder_ref(folder_id),
        query
            .map(|q| format!("<m:QueryString>{}</m:QueryString>", escape(q)))
            .unwrap_or_default(),
    );
    let text_ = s.call(&body).await?;
    let doc = parse(&text_)?;
    let resp = single(&doc)?;
    // `last` is the same xs:boolean read as the folder walk's (`"false"`/`"0"` mean more).
    let last = child(resp, "RootFolder").is_none_or(|r| !has_next_page(r));
    let total = child(resp, "RootFolder")
        .and_then(|r| r.attribute("TotalItemsInView"))
        .and_then(|v| v.trim().parse().ok());
    let items = items(resp)
        .into_iter()
        .filter_map(|it| {
            Some(Scanned {
                id: item_id(it)?,
                received: text(it, "DateTimeReceived").and_then(parse_time).unwrap_or(0),
                flags: flags_of(&ext_props(it)),
                categories: categories_of(it),
            })
        })
        .collect();
    Ok(Page { items, last, total })
}

/// Headers of items for the cache, built from the transport headers when the
/// item has them (received mail) and from its properties otherwise.
struct Fetched {
    id: String,
    received: i64,
    size: u32,
    flags: Flags,
    summary: Summary,
    /// The Exchange categories of the item, as the labels of the letter (#42).
    categories: Vec<String>,
}

async fn fetch(s: &mut Session, ids: &[String]) -> Result<Vec<Fetched>> {
    let receiver = s.receiver.clone();
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(FETCH_BATCH) {
        let props = [
            "item:Subject",
            "item:DateTimeReceived",
            "item:DateTimeSent",
            "item:Size",
            "item:HasAttachments",
            "item:InReplyTo",
            "message:From",
            "message:ToRecipients",
            "message:CcRecipients",
            "message:ReplyTo",
            "message:InternetMessageId",
            "message:References",
            "item:Categories",
            "item:Importance",
        ];
        let body = format!(
            "<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{}{}{}{}{}</t:AdditionalProperties></m:ItemShape><m:ItemIds>{}</m:ItemIds></m:GetItem>",
            props.iter().map(|p| field(p)).collect::<String>(),
            ext(PR_TRANSPORT_HEADERS, "String"),
            ext(PR_MESSAGE_FLAGS, "Integer"),
            ext(PR_FLAG_STATUS, "Integer"),
            ext(PR_LAST_VERB, "Integer"),
            item_ids(chunk),
        );
        let text_ = s.call(&body).await?;
        let doc = parse(&text_)?;
        for r in responses(&doc) {
            let resp = match r {
                Ok(n) => n,
                // Deleted between listing and fetching: the next sync drops it.
                Err(Error::Ews { code, .. }) if code == "ErrorItemNotFound" => continue,
                Err(e) => return Err(e),
            };
            for it in items(resp) {
                if let Some(f) = fetched(it, &receiver) {
                    out.push(f);
                }
            }
        }
    }
    Ok(out)
}

fn fetched(it: Node<'_, '_>, receiver: &Receiver) -> Option<Fetched> {
    let id = item_id(it)?;
    let props = ext_props(it);
    let received = text(it, "DateTimeReceived").and_then(parse_time).unwrap_or(0);
    let headers = props
        .get(&tag(PR_TRANSPORT_HEADERS))
        .filter(|h| h.contains(':'))
        .cloned()
        .unwrap_or_else(|| synth_headers(it));
    let mut summary = message::parse_summary_for(headers.as_bytes(), receiver);
    // The item knows its attachments better than a header block does.
    summary.has_attachments = text(it, "HasAttachments") == Some("true");
    // Exchange's own word, the only one a sent letter or a draft has (#72); the headers
    // still say it when the item does not.
    if let Some(importance) = text(it, "Importance").map(Importance::from_word)
        && importance != Importance::Normal
    {
        summary.importance = importance;
    }
    if summary.subject.is_empty() {
        summary.subject = text(it, "Subject").unwrap_or_default().to_owned();
    }
    if summary.date.is_none() {
        summary.date = text(it, "DateTimeSent").and_then(parse_time);
    }
    Some(Fetched {
        id,
        received,
        size: text(it, "Size").and_then(|s| s.parse().ok()).unwrap_or(0),
        flags: flags_of(&props),
        categories: categories_of(it),
        summary,
    })
}

fn mailbox(n: Node<'_, '_>) -> Option<Addr> {
    let mb = if n.tag_name().name() == "Mailbox" {
        n
    } else {
        child(n, "Mailbox")?
    };
    let name = text(mb, "Name").map(str::to_owned).filter(|s| !s.is_empty());
    let email = text(mb, "EmailAddress").unwrap_or_default().to_owned();
    if email.is_empty() && name.is_none() {
        return None;
    }
    Some(Addr { name, email })
}

fn mailboxes(it: Node<'_, '_>, name: &str) -> Vec<Addr> {
    child(it, name)
        .map(|list| children(list, "Mailbox").filter_map(mailbox).collect())
        .unwrap_or_default()
}

fn addr_header(a: &Addr) -> String {
    match &a.name {
        Some(n) => format!("\"{}\" <{}>", n.replace(['\\', '"'], ""), a.email),
        None => format!("<{}>", a.email),
    }
}

/// An RFC 5322 header block from item properties, for items without transport
/// headers (sent mail, drafts). UTF-8 as is: the parser accepts it.
fn synth_headers(it: Node<'_, '_>) -> String {
    let mut h = String::new();
    let one_line = |s: &str| s.replace(['\r', '\n'], " ");
    if let Some(from) = child(it, "From").and_then(mailbox) {
        h.push_str(&format!("From: {}\r\n", addr_header(&from)));
    }
    for (header, field) in [("To", "ToRecipients"), ("Cc", "CcRecipients"), ("Reply-To", "ReplyTo")] {
        let list = mailboxes(it, field);
        if !list.is_empty() {
            h.push_str(&format!(
                "{header}: {}\r\n",
                list.iter().map(addr_header).collect::<Vec<_>>().join(", ")
            ));
        }
    }
    if let Some(s) = text(it, "Subject") {
        h.push_str(&format!("Subject: {}\r\n", one_line(s)));
    }
    if let Some(t) = text(it, "DateTimeSent").and_then(parse_time)
        && let Some(d) = Utc.timestamp_opt(t, 0).single()
    {
        h.push_str(&format!("Date: {}\r\n", d.to_rfc2822()));
    }
    for (header, field) in [
        ("Message-ID", "InternetMessageId"),
        ("In-Reply-To", "InReplyTo"),
        ("References", "References"),
    ] {
        if let Some(v) = text(it, field).filter(|v| !v.trim().is_empty()) {
            h.push_str(&format!("{header}: {}\r\n", one_line(v)));
        }
    }
    h.push_str("\r\n");
    h
}

/// Caches items under the given UIDs.
async fn add_items(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    uids: &HashMap<String, u32>,
) -> Result<usize> {
    let ids: Vec<String> = uids.keys().cloned().collect();
    let fetched = fetch(s, &ids).await?;
    let items: Vec<_> = fetched
        .iter()
        .filter_map(|f| {
            let &uid = uids.get(&f.id)?;
            let msg = NewMessage {
                uid,
                summary: &f.summary,
                fallback_date: f.received,
                size: f.size,
                flags: f.flags,
                // Exchange categories are the letter's labels; their names are the keywords.
                keywords: f.categories.clone(),
            };
            Some((msg, f.id.as_str(), f.received))
        })
        .collect();
    // A commit per batch, not per item; batches keep the cache free for the window between.
    for batch in items.chunks(WRITE_BATCH) {
        store.ews_insert_items(account_id, folder, batch)?;
    }
    Ok(items.len())
}

/// UIDs for items found outside the synced window: below every UID in use.
fn low_uids(store: &Store, account_id: &str, folder: &str, ids: &[String]) -> Result<(HashMap<String, u32>, Vec<u32>)> {
    let mut next = store
        .ews_min_uid(account_id, folder)?
        .unwrap_or(UID_BASE)
        .saturating_sub(1);
    let mut fresh = HashMap::new();
    let mut all = Vec::with_capacity(ids.len());
    for id in ids {
        match store.ews_uid_of(account_id, folder, id)? {
            Some(uid) => all.push(uid),
            None => {
                fresh.insert(id.clone(), next);
                all.push(next);
                next = next.saturating_sub(1);
            }
        }
    }
    Ok((fresh, all))
}

/// Brings the cached window of a folder in line with the server: new items,
/// changed flags, deleted items. The first sync takes the newest `initial_limit`.
pub async fn sync_folder(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    opts: SyncOptions,
) -> Result<FolderSync> {
    let fid = folder_id(store, account_id, folder)?;
    let window = store.ews_window(account_id, folder)?;
    let mapped = store.ews_items(account_id, folder)?;
    let known: HashMap<&str, u32> = mapped.iter().map(|(uid, id, _)| (id.as_str(), *uid)).collect();

    let mut seen: Vec<Scanned> = Vec::new();
    let mut complete = false;
    loop {
        let page = find_page(s, &fid, seen.len(), PAGE, None, None).await?;
        let n = page.items.len();
        let oldest = page.items.last().map(|i| i.received);
        seen.extend(page.items);
        if page.last || n == 0 {
            complete = true;
            break;
        }
        if window < 0 && seen.len() >= opts.initial_limit {
            break;
        }
        if window >= 0 && oldest.is_some_and(|o| o < window) {
            break;
        }
    }
    if window < 0 && seen.len() > opts.initial_limit {
        seen.truncate(opts.initial_limit);
        complete = false;
    }
    let new_window = if complete {
        0
    } else if window < 0 {
        seen.last().map(|i| i.received).unwrap_or(0)
    } else {
        window
    };

    let mut report = FolderSync::default();
    let flags: Vec<(u32, Flags)> = seen
        .iter()
        .filter_map(|i| known.get(i.id.as_str()).map(|uid| (*uid, i.flags)))
        .collect();
    report.updated = store.update_flags(account_id, folder, &flags)?;
    let keywords: Vec<(u32, Vec<String>)> = seen
        .iter()
        .filter_map(|i| known.get(i.id.as_str()).map(|uid| (*uid, i.categories.clone())))
        .collect();
    store.update_keywords(account_id, folder, &keywords)?;

    let seen_ids: HashSet<&str> = seen.iter().map(|i| i.id.as_str()).collect();
    let gone: Vec<u32> = mapped
        .iter()
        .filter(|(_, id, received)| *received >= new_window && !seen_ids.contains(id.as_str()))
        .map(|(uid, _, _)| *uid)
        .collect();
    report.removed = store.remove_uids(account_id, folder, &gone)?;
    store.ews_items_remove(account_id, folder, &gone)?;

    let mut fresh: Vec<&Scanned> = seen
        .iter()
        .filter(|i| i.received >= new_window && !known.contains_key(i.id.as_str()))
        .collect();
    fresh.sort_by_key(|i| i.received);
    // UIDVALIDITY changes only when the cache is cleared: UIDs start again then.
    let (validity, last_uid) = store.folder_state(account_id, folder)?;
    let mut next = if last_uid == 0 { UID_BASE } else { last_uid + 1 };
    let mut uids = HashMap::new();
    for i in fresh {
        uids.insert(i.id.clone(), next);
        next += 1;
    }
    report.added = add_items(s, store, account_id, folder, &uids).await?;
    store.set_folder_state(account_id, folder, validity.max(1), next - 1)?;
    store.ews_set_window(account_id, folder, new_window)?;
    Ok(report)
}

/// Extends the window `count` items into the past; returns how many it grew by.
pub async fn load_older(s: &mut Session, store: &Store, account_id: &str, folder: &str, count: usize) -> Result<usize> {
    let window = store.ews_window(account_id, folder)?;
    if window <= 0 {
        return Ok(0);
    }
    let fid = folder_id(store, account_id, folder)?;
    let restriction = format!(
        r#"<t:IsLessThan>{}<t:FieldURIOrConstant><t:Constant Value="{}"/></t:FieldURIOrConstant></t:IsLessThan>"#,
        field("item:DateTimeReceived"),
        iso(window)
    );
    let page = find_page(s, &fid, 0, count, Some(&restriction), None).await?;
    let ids: Vec<String> = page.items.iter().map(|i| i.id.clone()).collect();
    let (fresh, _) = low_uids(store, account_id, folder, &ids)?;
    add_items(s, store, account_id, folder, &fresh).await?;
    let new_window = if page.last {
        0
    } else {
        page.items.last().map(|i| i.received).unwrap_or(0)
    };
    store.ews_set_window(account_id, folder, new_window)?;
    Ok(page.items.len())
}

/// The raw message (MIME) of a cached item.
pub async fn fetch_raw(s: &mut Session, store: &Store, account_id: &str, folder: &str, uid: u32) -> Result<Vec<u8>> {
    let id = store
        .ews_item_ids(account_id, folder, &[uid])?
        .pop()
        .ok_or(Error::NotFound)?;
    let body = format!(
        "<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:ItemShape><m:ItemIds>{}</m:ItemIds></m:GetItem>",
        item_ids(&[id])
    );
    let text_ = s.call(&body).await?;
    let doc = parse(&text_)?;
    let resp = single(&doc).map_err(|e| match e {
        Error::Ews { code, .. } if code == "ErrorItemNotFound" => Error::NotFound,
        e => e,
    })?;
    let mime = desc(resp, "MimeContent")
        .and_then(|n| n.text())
        .ok_or(Error::NotFound)?;
    let clean: String = mime.chars().filter(|c| !c.is_whitespace()).collect();
    BASE64.decode(clean).map_err(|_| Error::Parse)
}

pub async fn set_flag(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    change: FlagChange,
) -> Result<()> {
    let ids = store.ews_item_ids(account_id, folder, uids)?;
    update_flag(s, &ids, change).await
}

/// The `Updates` of an item for a flag change; a verb is written with the time it was done.
fn update_of(change: FlagChange, now: i64) -> String {
    let verb = |v: i64| {
        format!(
            "<t:SetItemField>{e}<t:Message><t:ExtendedProperty>{e}<t:Value>{v}</t:Value></t:ExtendedProperty></t:Message></t:SetItemField>\
             <t:SetItemField>{t}<t:Message><t:ExtendedProperty>{t}<t:Value>{at}</t:Value></t:ExtendedProperty></t:Message></t:SetItemField>",
            e = ext(PR_LAST_VERB, "Integer"),
            t = ext(PR_LAST_VERB_TIME, "SystemTime"),
            at = iso(now)
        )
    };
    match change {
        FlagChange::Seen(v) => format!(
            "<t:SetItemField>{}<t:Message><t:IsRead>{v}</t:IsRead></t:Message></t:SetItemField>",
            field("message:IsRead")
        ),
        FlagChange::Flagged(v) => format!(
            "<t:SetItemField>{}<t:Message><t:Flag><t:FlagStatus>{}</t:FlagStatus></t:Flag></t:Message></t:SetItemField>",
            field("item:Flag"),
            if v { "Flagged" } else { "NotFlagged" }
        ),
        FlagChange::Answered(true) => verb(VERB_REPLIED),
        FlagChange::AnsweredAll(true) => verb(VERB_REPLIED_ALL),
        FlagChange::Forwarded(true) => verb(VERB_FORWARDED),
        FlagChange::Answered(false) | FlagChange::AnsweredAll(false) | FlagChange::Forwarded(false) => {
            format!(
                "<t:DeleteItemField>{}</t:DeleteItemField>",
                ext(PR_LAST_VERB, "Integer")
            )
        }
    }
}

async fn update_flag(s: &mut Session, ids: &[String], change: FlagChange) -> Result<()> {
    let update = update_of(change, Utc::now().timestamp());
    for chunk in ids.chunks(100) {
        let changes: String = chunk
            .iter()
            .map(|id| {
                format!(
                    r#"<t:ItemChange><t:ItemId Id="{}"/><t:Updates>{update}</t:Updates></t:ItemChange>"#,
                    escape(id)
                )
            })
            .collect();
        let body = format!(
            r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite" SuppressReadReceipts="true"><m:ItemChanges>{changes}</m:ItemChanges></m:UpdateItem>"#
        );
        let text_ = s.call(&body).await?;
        check_all(&text_)?;
    }
    Ok(())
}

/// Puts labels on items and takes them off, by their category names. Exchange always
/// keeps categories on the server; Depesha sends the category of the same name. Adding
/// appends; removing reads the item's categories first and sets the list without them.
pub async fn set_labels(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    add: &[crate::acl::Label],
    remove: &[crate::acl::Label],
) -> Result<()> {
    let ids = store.ews_item_ids(account_id, folder, uids)?;
    let update_ids = |updates: String, ids: &[String]| {
        let changes: String = ids
            .iter()
            .map(|id| {
                format!(
                    r#"<t:ItemChange><t:ItemId Id="{}"/><t:Updates>{updates}</t:Updates></t:ItemChange>"#,
                    escape(id)
                )
            })
            .collect();
        format!(
            r#"<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite" SuppressReadReceipts="true"><m:ItemChanges>{changes}</m:ItemChanges></m:UpdateItem>"#
        )
    };
    if !add.is_empty() {
        for label in add {
            let Some(update) = categories_add(&label.name) else {
                continue;
            };
            let body = update_ids(update, &ids);
            let text_ = s.call(&body).await?;
            check_all(&text_)?;
        }
    }
    if !remove.is_empty() {
        let drop: HashSet<&str> = remove.iter().map(|l| l.name.as_str()).collect();
        remove_categories(s, &ids, &drop).await?;
    }
    Ok(())
}

/// Rewrites the categories of `ids` without the ones in `drop`. The item is updated by the
/// ChangeKey of the read, and a conflict is retried once on a fresh read rather than
/// overwriting a category another client added meanwhile.
async fn remove_categories(s: &mut Session, ids: &[String], drop: &HashSet<&str>) -> Result<()> {
    for chunk in ids.chunks(50) {
        for attempt in 0..2 {
            let current = read_categories(s, chunk).await?;
            let changes: String = current
                .iter()
                .filter_map(|(id, key, cats)| {
                    let left: Vec<String> = cats
                        .iter()
                        .filter(|c| !drop.iter().any(|d| same_category(d, c)))
                        .cloned()
                        .collect();
                    if left.len() == cats.len() {
                        return None;
                    }
                    let update = categories_set(&left);
                    Some(format!(
                        "<t:ItemChange>{}<t:Updates>{update}</t:Updates></t:ItemChange>",
                        item_ref(id, key.as_deref())
                    ))
                })
                .collect();
            if changes.is_empty() {
                break;
            }
            let body = update_item(&changes, "AutoResolve");
            let text_ = s.call(&body).await?;
            match check_all(&text_) {
                Ok(()) => break,
                Err(e) if attempt == 0 && e.is_conflict() => continue,
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}

/// The restriction that finds the items carrying a category, for the strip of a label
/// (#42, frame 4Б). `Contains` on `item:Categories`, case-insensitive.
fn contains_category(name: &str) -> String {
    format!(
        r#"<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">{}<t:Constant Value="{}"/></t:Contains>"#,
        field("item:Categories"),
        escape(name)
    )
}

/// Exchange compares category names without case: `Счета` and `счета` are one category.
fn same_category(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// The ids of the items in `fid` that carry a category, over all pages, read before
/// anything is removed or rewritten (paging after a change would shift the pages).
/// Bounded by `FOLDER_PAGES_MAX`, and it stops when a page brings no id not seen already:
/// a server that ignores `Offset` and keeps saying "more" must not spin forever.
async fn category_ids(s: &mut Session, fid: &str, restriction: &str) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut offset = 0;
    for _ in 0..FOLDER_PAGES_MAX {
        let page = find_page(s, fid, offset, 300, Some(restriction), None).await?;
        let fresh: Vec<String> = page
            .items
            .iter()
            .map(|i| i.id.clone())
            .filter(|id| seen.insert(id.clone()))
            .collect();
        let none_new = fresh.is_empty();
        ids.extend(fresh);
        if page.last || none_new {
            break;
        }
        offset += page.items.len();
    }
    Ok(ids)
}

/// Drops a category from every item of the account that carries it (#42, frame 4Б): each
/// folder is searched by the category and the found items get it removed. Returns how many
/// items were changed.
pub async fn strip_category(s: &mut Session, store: &Store, account_id: &str, name: &str) -> Result<usize> {
    let folders: Vec<String> = store
        .folders(Some(account_id))?
        .into_iter()
        .filter(|f| f.folder.selectable)
        .map(|f| f.folder.name)
        .collect();
    let mut total = 0;
    for folder in &folders {
        total += strip_category_in(s, store, account_id, folder, name).await?;
    }
    Ok(total)
}

/// Drops a category in one folder (#42, frame 4Б): the folder is searched by the category
/// and the found items get it removed. Returns how many items were changed. The folder
/// loop is the caller's, so a long walk is not one queue item.
pub async fn strip_category_in(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    name: &str,
) -> Result<usize> {
    let Some(fid) = store.ews_folder_id(account_id, folder)? else {
        return Ok(0);
    };
    let restriction = contains_category(name);
    let ids = category_ids(s, &fid, &restriction).await?;
    if ids.is_empty() {
        return Ok(0);
    }
    remove_categories(s, &ids, &HashSet::from([name])).await?;
    Ok(ids.len())
}

/// Renames a category on every item of the account that carries it (#42, frame 7): each
/// folder is searched by the old name, and the found items get the new one instead. The
/// name is the category, so this is what "rename" means on Exchange. Returns how many
/// items were changed.
pub async fn rename_category(s: &mut Session, store: &Store, account_id: &str, from: &str, to: &str) -> Result<usize> {
    let folders: Vec<String> = store
        .folders(Some(account_id))?
        .into_iter()
        .filter(|f| f.folder.selectable)
        .map(|f| f.folder.name)
        .collect();
    let restriction = contains_category(from);
    let mut total = 0;
    for folder in &folders {
        let Some(fid) = store.ews_folder_id(account_id, folder)? else {
            continue;
        };
        let ids = category_ids(s, &fid, &restriction).await?;
        if ids.is_empty() {
            continue;
        }
        for chunk in ids.chunks(50) {
            // A conflict (the item changed since it was read) is retried once on a fresh
            // read, as `remove_categories` does, rather than overwriting what another
            // client wrote meanwhile.
            for attempt in 0..2 {
                let current = read_categories(s, chunk).await?;
                let changes: String = current
                    .iter()
                    .filter_map(|(id, key, cats)| {
                        if !cats.iter().any(|c| same_category(c, from)) {
                            return None;
                        }
                        let mut next: Vec<String> = Vec::new();
                        for c in cats {
                            let name = if same_category(c, from) { to } else { c.as_str() };
                            if !next.iter().any(|n| n == name) {
                                next.push(name.to_owned());
                            }
                        }
                        let update = categories_set(&next);
                        Some(format!(
                            "<t:ItemChange>{}<t:Updates>{update}</t:Updates></t:ItemChange>",
                            item_ref(id, key.as_deref())
                        ))
                    })
                    .collect();
                if changes.is_empty() {
                    break;
                }
                let body = update_item(&changes, "AutoResolve");
                let text_ = s.call(&body).await?;
                match check_all(&text_) {
                    Ok(()) => break,
                    Err(e) if attempt == 0 && e.is_conflict() => continue,
                    Err(e) => return Err(e),
                }
            }
        }
        total += ids.len();
    }
    Ok(total)
}

/// The categories of items, by their ids, in one GetItem, each with its ChangeKey.
async fn read_categories(s: &mut Session, ids: &[String]) -> Result<Vec<(String, Option<String>, Vec<String>)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let body = format!(
        "<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>{}</t:AdditionalProperties></m:ItemShape><m:ItemIds>{}</m:ItemIds></m:GetItem>",
        field("item:Categories"),
        item_ids(ids)
    );
    let text_ = s.call(&body).await?;
    let doc = parse(&text_)?;
    let mut out = Vec::new();
    for r in responses(&doc) {
        let Ok(resp) = r else { continue };
        for it in items(resp) {
            if let Some(id) = item_id(it) {
                out.push((id, change_key_of(it), categories_of(it)));
            }
        }
    }
    Ok(out)
}

/// Fails on the first error other than a vanished item.
fn check_all(text_: &str) -> Result<()> {
    let doc = parse(text_)?;
    for r in responses(&doc) {
        match r {
            Ok(_) => {}
            Err(Error::Ews { code, .. }) if code == "ErrorItemNotFound" => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Moves items; returns the ids they got in the target folder.
async fn move_ids(s: &mut Session, ids: &[String], to_id: &str) -> Result<Vec<String>> {
    let mut moved = Vec::new();
    for chunk in ids.chunks(100) {
        let body = format!(
            "<m:MoveItem><m:ToFolderId>{}</m:ToFolderId><m:ItemIds>{}</m:ItemIds></m:MoveItem>",
            folder_ref(to_id),
            item_ids(chunk)
        );
        let text_ = s.call(&body).await?;
        let doc = parse(&text_)?;
        for r in responses(&doc) {
            match r {
                Ok(n) => moved.extend(items(n).into_iter().filter_map(item_id)),
                Err(Error::Ews { code, .. }) if code == "ErrorItemNotFound" => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(moved)
}

pub async fn move_messages(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    from: &str,
    uids: &[u32],
    to: &str,
) -> Result<()> {
    let ids = store.ews_item_ids(account_id, from, uids)?;
    let to_id = folder_id(store, account_id, to)?;
    move_ids(s, &ids, &to_id).await?;
    Ok(())
}

/// Deletes for good, as Outlook does from Deleted Items (recoverable by the admin).
pub async fn delete_permanently(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> Result<()> {
    let ids = store.ews_item_ids(account_id, folder, uids)?;
    for chunk in ids.chunks(100) {
        let body = format!(
            r#"<m:DeleteItem DeleteType="SoftDelete"><m:ItemIds>{}</m:ItemIds></m:DeleteItem>"#,
            item_ids(chunk)
        );
        let text_ = s.call(&body).await?;
        check_all(&text_)?;
    }
    Ok(())
}

/// How many items the folder holds on the server.
pub async fn folder_total(s: &mut Session, store: &Store, account_id: &str, folder: &str) -> Result<usize> {
    let fid = folder_id(store, account_id, folder)?;
    let page = find_page(s, &fid, 0, 1, None, None).await?;
    Ok(page.total.unwrap_or(page.items.len()))
}

/// Every item id of the folder, asked of the server: the cache holds only a window of it.
pub async fn folder_item_ids(s: &mut Session, store: &Store, account_id: &str, folder: &str) -> Result<Vec<String>> {
    let fid = folder_id(store, account_id, folder)?;
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    // Bounded like the folder walk (and as long as the folder says it is): a server that
    // ignores `Offset` must not spin it forever, a folder of many pages must not be cut short.
    let mut pages = FOLDER_PAGES_MAX;
    let mut n = 0;
    while n < pages {
        n += 1;
        let page = find_page(s, &fid, ids.len(), 500, None, None).await?;
        if let Some(total) = page.total {
            pages = pages.max(total.div_ceil(500) + 1);
        }
        let empty = page.items.is_empty();
        let last = page.last;
        let before = ids.len();
        for item in page.items {
            if seen.insert(item.id.clone()) {
                ids.push(item.id);
            }
        }
        if last || empty || ids.len() == before {
            break;
        }
    }
    Ok(ids)
}

/// Deletes the items for good (as `delete_permanently` does); one that is gone already is no
/// error, so a run that is repeated from its snapshot goes on where it stopped.
pub async fn delete_item_ids(s: &mut Session, ids: &[String]) -> Result<()> {
    for chunk in ids.chunks(100) {
        let body = format!(
            r#"<m:DeleteItem DeleteType="SoftDelete"><m:ItemIds>{}</m:ItemIds></m:DeleteItem>"#,
            item_ids(chunk)
        );
        let text_ = s.call(&body).await?;
        check_all(&text_)?;
    }
    Ok(())
}

/// Moves one batch of items (as `folder_item_ids` named them) into `to`.
pub async fn move_item_ids(s: &mut Session, store: &Store, account_id: &str, ids: &[String], to: &str) -> Result<()> {
    let to_id = folder_id(store, account_id, to)?;
    move_ids(s, ids, &to_id).await?;
    Ok(())
}

/// Ids of items with these Message-IDs in the folder: the cached ones come from the local
/// cache, the rest are found on the server. The server is asked once per batch of
/// Message-IDs with an `Or` restriction, not once per message.
async fn find_by_message_ids(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    folder_id: &str,
    message_ids: &[String],
) -> Result<Vec<String>> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let bare: Vec<String> = message_ids
        .iter()
        .map(|m| m.trim().trim_matches(['<', '>']).to_owned())
        .collect();
    // The cache knows the item id of mail already synced: ask the server only for the rest.
    let cached = store.ews_item_ids_by_message_id(account_id, folder, &bare)?;
    let known: HashSet<String> = cached.iter().map(|(mid, _)| mid.clone()).collect();
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (_, id) in cached {
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    let missing: Vec<&String> = bare.iter().filter(|m| !known.contains(*m)).collect();
    for chunk in missing.chunks(FIND_BATCH) {
        // Exchange keeps the angle brackets; match both spellings in one request.
        let mut values: Vec<String> = Vec::with_capacity(chunk.len() * 2);
        for m in chunk {
            values.push(format!("<{m}>"));
            values.push((*m).clone());
        }
        let Some(restriction) = or_restriction(&values) else {
            continue;
        };
        let page = find_page(s, folder_id, 0, 50, Some(&restriction), None).await?;
        for it in page.items {
            if seen.insert(it.id.clone()) {
                ids.push(it.id);
            }
        }
    }
    Ok(ids)
}

/// `Or` over `message:InternetMessageId` equalities, one per value.
fn or_restriction(values: &[String]) -> Option<String> {
    let mut iter = values.iter();
    let mut acc = eq_message_id(iter.next()?);
    for v in iter {
        acc = format!("<t:Or>{}{acc}</t:Or>", eq_message_id(v));
    }
    Some(acc)
}

fn eq_message_id(value: &str) -> String {
    format!(
        r#"<t:IsEqualTo>{}<t:FieldURIOrConstant><t:Constant Value="{}"/></t:FieldURIOrConstant></t:IsEqualTo>"#,
        field("message:InternetMessageId"),
        escape(value)
    )
}

/// Puts a message into a folder unless one with the same Message-ID is there.
pub async fn append_unless_exists(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    raw: &[u8],
    flags: &str,
    message_id: Option<&str>,
) -> Result<()> {
    let fid = folder_id(store, account_id, folder)?;
    if let Some(mid) = message_id
        && !find_by_message_ids(s, store, account_id, folder, &fid, &[mid.to_owned()])
            .await?
            .is_empty()
    {
        return Ok(());
    }
    let seen = flags.contains("\\Seen");
    let msg_flags = if flags.contains("\\Draft") { MSGFLAG_UNSENT } else { 0 } | if seen { MSGFLAG_READ } else { 0 };
    let body = format!(
        r#"<m:CreateItem MessageDisposition="SaveOnly"><m:SavedItemFolderId>{}</m:SavedItemFolderId><m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">{}</t:MimeContent><t:ExtendedProperty>{}<t:Value>{msg_flags}</t:Value></t:ExtendedProperty><t:IsRead>{seen}</t:IsRead></t:Message></m:Items></m:CreateItem>"#,
        folder_ref(&fid),
        BASE64.encode(raw),
        ext(PR_MESSAGE_FLAGS, "Integer"),
    );
    let text_ = s.call(&body).await?;
    let doc = parse(&text_)?;
    single(&doc)?;
    Ok(())
}

/// Moves messages found by Message-ID; `unseen` marks them unread there. Returns how many moved.
pub async fn move_by_message_id(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    from: &str,
    message_ids: &[String],
    to: &str,
    unseen: bool,
) -> Result<usize> {
    let from_id = folder_id(store, account_id, from)?;
    let to_id = folder_id(store, account_id, to)?;
    // One FindItem per batch of Message-IDs, and the cache first: not a request per letter.
    let ids = find_by_message_ids(s, store, account_id, from, &from_id, message_ids).await?;
    let moved = move_ids(s, &ids, &to_id).await?;
    if unseen && !moved.is_empty() {
        update_flag(s, &moved, FlagChange::Seen(false)).await?;
    }
    Ok(ids.len())
}

/// The photo a colleague set in the organization (Exchange 2013 and later), 96×96.
/// `None` for people outside it, without a photo, or on an older server.
pub async fn user_photo(s: &mut Session, email: &str) -> Result<Option<Vec<u8>>> {
    let body = format!(
        "<m:GetUserPhoto><m:Email>{}</m:Email><m:SizeRequested>HR96x96</m:SizeRequested></m:GetUserPhoto>",
        escape(email)
    );
    let xml = match s.call(&body).await {
        Ok(xml) => xml,
        Err(e) if e.is_transient() => return Err(e),
        // Not found, no photo, a server without the operation: nothing to show.
        Err(_) => return Ok(None),
    };
    let doc = parse(&xml)?;
    let Some(resp) = desc(doc.root(), "GetUserPhotoResponse") else {
        return Ok(None);
    };
    if resp.attribute("ResponseClass") == Some("Error") {
        return Ok(None);
    }
    Ok(desc(resp, "PictureData")
        .and_then(|n| n.text())
        .and_then(|t| BASE64.decode(t.trim()).ok())
        .filter(|b| !b.is_empty()))
}

/// Creates a folder by its IMAP-like name (`Archive`, `INBOX/Projects`); an existing one is fine.
pub async fn create_folder(s: &mut Session, store: &Store, account_id: &str, name: &str) -> Result<()> {
    let (parent, leaf) = match name.rsplit_once(DELIMITER) {
        Some((p, l)) => (folder_ref(&folder_id(store, account_id, p)?), l),
        None => (r#"<t:DistinguishedFolderId Id="msgfolderroot"/>"#.to_owned(), name),
    };
    let body = format!(
        "<m:CreateFolder><m:ParentFolderId>{parent}</m:ParentFolderId><m:Folders><t:Folder><t:FolderClass>IPF.Note</t:FolderClass><t:DisplayName>{}</t:DisplayName></t:Folder></m:Folders></m:CreateFolder>",
        escape(leaf)
    );
    let text_ = s.call(&body).await?;
    let doc = parse(&text_)?;
    match single(&doc) {
        Ok(_) => Ok(()),
        Err(Error::Ews { code, .. }) if code == "ErrorFolderExists" => Ok(()),
        Err(e) => Err(e),
    }
}

/// Sends a message and keeps a copy in Sent Items (the server does it, not us).
/// Returns the RFC 822 bytes. Bcc recipients travel outside the MIME, which has none.
pub async fn send(s: &mut Session, message: &lettre::Message) -> Result<Vec<u8>> {
    let raw = message.formatted();
    let summary = message::parse_summary(&raw);
    let visible: HashSet<String> = summary
        .to
        .iter()
        .chain(&summary.cc)
        .map(|a| a.email.to_ascii_lowercase())
        .collect();
    let bcc: Vec<String> = message
        .envelope()
        .to()
        .iter()
        .map(|a| a.to_string())
        .filter(|a| !visible.contains(&a.to_ascii_lowercase()))
        .collect();
    let bcc_xml = if bcc.is_empty() {
        String::new()
    } else {
        format!(
            "<t:BccRecipients>{}</t:BccRecipients>",
            bcc.iter()
                .map(|a| format!("<t:Mailbox><t:EmailAddress>{}</t:EmailAddress></t:Mailbox>", escape(a)))
                .collect::<String>()
        )
    };
    let body = format!(
        r#"<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId><m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">{}</t:MimeContent>{bcc_xml}</t:Message></m:Items></m:CreateItem>"#,
        BASE64.encode(&raw)
    );
    let text_ = s.call(&body).await?;
    let doc = parse(&text_)?;
    single(&doc)?;
    Ok(raw)
}

/// Advanced Query Syntax for FindItem's QueryString (Exchange 2013 and later).
pub fn aqs(q: &SearchQuery) -> String {
    let quote = |v: &str| format!("\"{}\"", v.replace('"', ""));
    let mut parts: Vec<String> = q.words.iter().map(|w| quote(w)).collect();
    parts.extend(q.from.iter().map(|v| {
        let alts: Vec<String> = crate::query::alternatives(v)
            .iter()
            .map(|a| format!("from:{}", quote(a)))
            .collect();
        if alts.len() > 1 {
            format!("({})", alts.join(" OR "))
        } else {
            alts.concat()
        }
    }));
    parts.extend(q.to.iter().map(|v| format!("to:{}", quote(v))));
    parts.extend(q.subject.iter().map(|v| format!("subject:{}", quote(v))));
    // Exchange stores a label as a category of the same name: search by it as such.
    parts.extend(q.label.iter().map(|v| format!("category:{}", quote(v))));
    if q.has_attachment {
        parts.push("hasattachment:true".into());
    }
    if q.unread {
        parts.push("isread:false".into());
    }
    if q.important {
        parts.push("importance:high".into());
    }
    let day = |t: i64| {
        Utc.timestamp_opt(t, 0)
            .single()
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default()
    };
    if let Some(t) = q.after {
        parts.push(format!("received>={}", day(t)));
    }
    if let Some(t) = q.before {
        parts.push(format!("received<{}", day(t)));
    }
    parts.join(" ")
}

/// A search without words as a FindItem restriction: AQS has no size, and a restriction
/// cannot go with a query string. `None` when there are words or nothing to restrict.
pub fn restriction(q: &SearchQuery) -> Option<String> {
    if !(q.words.is_empty() && q.from.is_empty() && q.to.is_empty() && q.subject.is_empty()) {
        return None;
    }
    let compare = |op: &str, uri: &str, value: String| {
        format!(
            r#"<t:{op}>{}<t:FieldURIOrConstant><t:Constant Value="{value}"/></t:FieldURIOrConstant></t:{op}>"#,
            field(uri)
        )
    };
    let mut parts = Vec::new();
    if let Some(n) = q.larger {
        parts.push(compare("IsGreaterThan", "item:Size", n.to_string()));
    }
    if let Some(n) = q.smaller {
        parts.push(compare("IsLessThan", "item:Size", n.to_string()));
    }
    if let Some(t) = q.after {
        parts.push(compare("IsGreaterThanOrEqualTo", "item:DateTimeReceived", iso(t)));
    }
    if let Some(t) = q.before {
        parts.push(compare("IsLessThan", "item:DateTimeReceived", iso(t)));
    }
    if q.has_attachment {
        parts.push(compare("IsEqualTo", "item:HasAttachments", "true".into()));
    }
    if q.unread {
        parts.push(compare("IsEqualTo", "message:IsRead", "false".into()));
    }
    if q.important {
        parts.push(compare("IsEqualTo", "item:Importance", "High".into()));
    }
    match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(format!("<t:And>{}</t:And>", parts.concat())),
    }
}

/// Searches the folder on the server and caches what it finds. Returns row ids, newest first.
pub async fn search_server(
    s: &mut Session,
    store: &Store,
    account_id: &str,
    folder: &str,
    text_: &str,
) -> Result<Vec<i64>> {
    let q = SearchQuery::parse(text_);
    let restriction = restriction(&q);
    let query = aqs(&q);
    if restriction.is_none() && query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let fid = folder_id(store, account_id, folder)?;
    let page = match &restriction {
        Some(r) => find_page(s, &fid, 0, 300, Some(r), None).await?,
        None => find_page(s, &fid, 0, 300, None, Some(&query)).await?,
    };
    let found: Vec<&Scanned> = page.items.iter().filter(|i| !q.flagged || i.flags.flagged).collect();
    let ids: Vec<String> = found.iter().map(|i| i.id.clone()).collect();
    let (fresh, uids) = low_uids(store, account_id, folder, &ids)?;
    add_items(s, store, account_id, folder, &fresh).await?;
    // Found by importance: high, whatever the cache knew (a letter cached before it was read).
    if q.important {
        store.mark_important(account_id, folder, &uids)?;
    }
    let mut rows = Vec::with_capacity(uids.len());
    for uid in uids {
        if let Some(row) = store.find_by_uid(account_id, folder, uid)?
            && (!q.has_attachment || row.has_attachments)
            && q.fits_size(row.size.into())
        {
            rows.push(row.id);
        }
    }
    Ok(rows)
}

/// Waits for changes in the inbox with a streaming subscription; without one
/// (old server, blocked by a proxy) just waits `poll` and reports a change.
pub async fn wait_for_changes(s: &mut Session, store: &Store, account_id: &str, poll: Duration) -> Result<IdleOutcome> {
    // The folder list comes with the first sync of the other connection.
    let Some(fid) = store.ews_folder_id(account_id, INBOX)? else {
        tokio::time::sleep(poll.min(Duration::from_secs(15))).await;
        return Ok(IdleOutcome::Timeout);
    };
    let events = [
        "NewMailEvent",
        "CreatedEvent",
        "DeletedEvent",
        "ModifiedEvent",
        "MovedEvent",
        "CopiedEvent",
    ];
    let subscribe = format!(
        "<m:Subscribe><m:StreamingSubscriptionRequest><t:FolderIds>{}</t:FolderIds><t:EventTypes>{}</t:EventTypes></m:StreamingSubscriptionRequest></m:Subscribe>",
        folder_ref(&fid),
        events
            .iter()
            .map(|e| format!("<t:EventType>{e}</t:EventType>"))
            .collect::<String>()
    );
    let subscription = match s.call(&subscribe).await {
        Ok(text_) => {
            let doc = parse(&text_)?;
            match single(&doc) {
                Ok(n) => text(n, "SubscriptionId").map(str::to_owned),
                Err(e @ Error::Ews { .. }) if !e.is_transient() => None,
                Err(e) => return Err(e),
            }
        }
        Err(e @ Error::Ews { .. }) if !e.is_transient() => None,
        Err(e) => return Err(e),
    };
    let Some(subscription) = subscription else {
        tokio::time::sleep(poll).await;
        return Ok(IdleOutcome::Changed);
    };

    let request = format!(
        "<m:GetStreamingEvents><m:SubscriptionIds><t:SubscriptionId>{}</t:SubscriptionId></m:SubscriptionIds><m:ConnectionTimeout>{}</m:ConnectionTimeout></m:GetStreamingEvents>",
        escape(&subscription),
        crate::imap::IDLE_RENEW.as_secs() / 60
    );
    let (_conn, mut stream) = s.stream(&request).await?;
    if stream.status != 200 {
        tokio::time::sleep(poll).await;
        return Ok(IdleOutcome::Changed);
    }
    let mut seen = String::new();
    let outcome = loop {
        // Exchange sends keep-alive notifications every minute or so; silence means a dead link.
        let chunk = tokio::time::timeout(Duration::from_secs(5 * 60), stream.next())
            .await
            .map_err(|_| Error::Timeout("HTTP answer"))??;
        let Some(chunk) = chunk else { break IdleOutcome::Timeout };
        seen.push_str(&String::from_utf8_lossy(&chunk));
        if events.iter().any(|e| seen.contains(&format!("{e}>"))) {
            break IdleOutcome::Changed;
        }
        if seen.contains("ResponseClass=\"Error\"") {
            break IdleOutcome::Timeout;
        }
        // Keep only the tail: an event name may be split across chunks.
        if seen.len() > 8192 {
            let cut = seen.len() - 256;
            let cut = (cut..seen.len())
                .find(|i| seen.is_char_boundary(*i))
                .unwrap_or(seen.len());
            seen.drain(..cut);
        }
    };
    let unsubscribe = format!(
        "<m:Unsubscribe><m:SubscriptionId>{}</m:SubscriptionId></m:Unsubscribe>",
        escape(&subscription)
    );
    let _ = s.call(&unsubscribe).await;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verb(v: &str) -> Flags {
        flags_of(&HashMap::from([
            (tag(PR_MESSAGE_FLAGS), "1".to_owned()),
            (tag(PR_LAST_VERB), v.to_owned()),
        ]))
    }

    #[test]
    fn the_importance_of_an_item_comes_from_its_property_and_else_from_its_headers() {
        let item = |extra: &str| {
            format!(
                r#"<Message xmlns="http://schemas.microsoft.com/exchange/services/2006/types"><ItemId Id="AAA" ChangeKey="x"/><Subject>Hi</Subject>{extra}<DateTimeReceived>2026-10-01T10:00:00Z</DateTimeReceived><Size>10</Size><HasAttachments>false</HasAttachments></Message>"#
            )
        };
        let of = |extra: &str| {
            let xml = item(extra);
            let doc = roxmltree::Document::parse(&xml).unwrap();
            fetched(doc.root_element(), &Receiver::default())
                .unwrap()
                .summary
                .importance
        };
        // A sent letter has no transport headers: the property is all there is.
        assert_eq!(of("<Importance>High</Importance>"), Importance::High);
        assert_eq!(of("<Importance>Normal</Importance>"), Importance::Normal);
        assert_eq!(of("<Importance>Low</Importance>"), Importance::Low);
        assert_eq!(of(""), Importance::Normal);
    }

    #[test]
    fn the_last_verb_tells_a_reply_a_reply_to_all_and_a_forward() {
        let r = verb("102");
        assert!(r.answered && !r.answered_all && !r.forwarded);
        let all = verb("103");
        assert!(all.answered && all.answered_all && !all.forwarded);
        // MS-OXOMSG 2.2.1.4: 104 is NOTEIVERB_FORWARD.
        let fwd = verb("104");
        assert!(!fwd.answered && !fwd.answered_all && fwd.forwarded);
        let print = verb("105");
        assert!(!print.answered && !print.forwarded);
    }

    #[test]
    fn depesha_writes_the_verb_it_did_and_when() {
        let at = |change| update_of(change, 1_790_000_000);
        for (change, value) in [
            (FlagChange::Answered(true), "102"),
            (FlagChange::AnsweredAll(true), "103"),
            (FlagChange::Forwarded(true), "104"),
        ] {
            let xml = at(change);
            assert!(xml.contains(&format!("<t:Value>{value}</t:Value>")), "{xml}");
            assert!(xml.contains(r#"PropertyTag="0x1082""#), "the time too: {xml}");
            assert!(xml.contains("2026-09-21T"), "{xml}");
        }
        // Taking it back removes the verb.
        assert!(at(FlagChange::Forwarded(false)).contains("<t:DeleteItemField>"));
    }
}
