use super::*;

#[test]
fn server_field_becomes_ews_url() {
    assert_eq!(
        url_from_server("mail.corp.ru").as_deref(),
        Some("https://mail.corp.ru/EWS/Exchange.asmx")
    );
    assert_eq!(
        url_from_server("https://mail.corp.ru/owa/").as_deref(),
        Some("https://mail.corp.ru/EWS/Exchange.asmx")
    );
    assert_eq!(
        url_from_server("https://mail.corp.ru:8443/EWS/Exchange.asmx").as_deref(),
        Some("https://mail.corp.ru:8443/EWS/Exchange.asmx")
    );
    assert_eq!(url_from_server("  "), None);
}

#[test]
fn reads_autodiscover() {
    let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
<Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
<Account><Protocol><Type>EXCH</Type><EwsUrl>https://ex01.corp.local/EWS/Exchange.asmx</EwsUrl></Protocol>
<Protocol><Type>EXPR</Type><EwsUrl>https://mail.corp.ru/EWS/Exchange.asmx</EwsUrl></Protocol></Account>
</Response></Autodiscover>"#;
    assert_eq!(
        parse_autodiscover(xml).as_deref(),
        Some("https://mail.corp.ru/EWS/Exchange.asmx")
    );
    assert_eq!(parse_autodiscover("<x/>"), None);
}

#[test]
fn explains_401() {
    let e = unauthorized(&["Digest realm=\"x\"".into(), "Kerberos".into()]);
    assert!(matches!(&e, Error::HttpAuth(m) if m == "Digest, Kerberos"), "{e:?}");
    assert_eq!(e.kind(), "auth");
    assert_eq!(ntlm_scheme(&["Negotiate".into(), "NTLM".into()]), Some("NTLM"));
    assert_eq!(ntlm_scheme(&["Negotiate".into()]), Some("Negotiate"));
    assert_eq!(ntlm_scheme(&["Basic realm=\"x\"".into()]), None);
    let e = unauthorized(&["Negotiate, NTLM".into(), "Basic realm=\"mail.corp.ru\"".into()]);
    assert!(matches!(e, Error::Auth(_)));
    assert!(matches!(unauthorized(&[]), Error::Auth(_)));
}

#[test]
fn escapes_xml() {
    assert_eq!(escape("a<b>&\"c'\u{1}"), "a&lt;b&gt;&amp;&quot;c&apos;");
}

#[test]
fn reads_soap_faults_and_errors() {
    let fault_xml = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode xmlns:a="http://schemas.microsoft.com/exchange/services/2006/types">a:ErrorInvalidServerVersion</faultcode><faultstring xml:lang="en-US">The specified server version is invalid.</faultstring><detail><e:ResponseCode xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">ErrorInvalidServerVersion</e:ResponseCode><e:Message xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">The specified server version is invalid.</e:Message></detail></s:Fault></s:Body></s:Envelope>"#;
    let Error::Ews {
        code,
        message,
        back_off,
    } = fault(fault_xml)
    else {
        panic!("not an EWS error");
    };
    assert_eq!(code, "ErrorInvalidServerVersion");
    assert_eq!(message, "The specified server version is invalid.");
    assert_eq!(back_off, None);

    let answer = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:GetItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Error"><m:MessageText>The specified object was not found in the store.</m:MessageText><m:ResponseCode>ErrorItemNotFound</m:ResponseCode></m:GetItemResponseMessage><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse></s:Body></s:Envelope>"#;
    let doc = parse(answer).unwrap();
    let r = responses(&doc);
    assert_eq!(r.len(), 2);
    assert!(matches!(&r[0], Err(e) if e.kind() == "not-found"));
    assert!(r[1].is_ok());
}

#[test]
fn reads_the_back_off_of_a_busy_server() {
    use std::time::Duration;
    // Throttling as a SOAP fault (HTTP 500)…
    let fault_xml = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode xmlns:a="http://schemas.microsoft.com/exchange/services/2006/types">a:ErrorServerBusy</faultcode><faultstring xml:lang="en-US">The server cannot service this request right now. Try again later.</faultstring><detail><e:ResponseCode xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">ErrorServerBusy</e:ResponseCode><e:Message xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">The server cannot service this request right now. Try again later.</e:Message><t:MessageXml xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><t:Value Name="BackOffMilliseconds">30000</t:Value></t:MessageXml></detail></s:Fault></s:Body></s:Envelope>"#;
    let e = fault(fault_xml);
    assert!(e.is_busy(), "{e:?}");
    assert_eq!(e.back_off(), Some(Duration::from_secs(30)));
    assert_eq!(e.kind(), "network");
    assert!(e.to_string().contains("30"), "{e}");

    // …and inside an answer with HTTP 200.
    let answer = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:FindItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Error"><m:MessageText>The server cannot service this request right now. Try again later.</m:MessageText><m:ResponseCode>ErrorServerBusy</m:ResponseCode><m:DescriptiveLinkKey>0</m:DescriptiveLinkKey><m:MessageXml><t:Value Name="BackOffMilliseconds">30000</t:Value></m:MessageXml></m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse></s:Body></s:Envelope>"#;
    let doc = parse(answer).unwrap();
    let e = single(&doc).unwrap_err();
    assert!(e.is_busy());
    assert_eq!(e.back_off(), Some(Duration::from_secs(30)));

    // Busy without a pause named: the queue picks one itself.
    let bare = answer.replace(
        r#"<m:MessageXml><t:Value Name="BackOffMilliseconds">30000</t:Value></m:MessageXml>"#,
        "",
    );
    let doc = parse(&bare).unwrap();
    let e = single(&doc).unwrap_err();
    assert!(e.is_busy());
    assert_eq!(e.back_off(), None);
}

#[test]
fn search_query_becomes_aqs() {
    let q = crate::query::SearchQuery::parse("от:anna тема:\"отчёт за май\" бюджет есть:вложение is:unread");
    assert_eq!(
        aqs(&q),
        "\"бюджет\" from:\"anna\" subject:\"отчёт за май\" hasattachment:true isread:false"
    );
}

#[test]
fn a_search_without_words_is_a_restriction() {
    use super::restriction;
    let q = crate::query::SearchQuery::parse("larger:25M есть:вложение");
    assert_eq!(
        restriction(&q).unwrap(),
        concat!(
            r#"<t:And><t:IsGreaterThan><t:FieldURI FieldURI="item:Size"/><t:FieldURIOrConstant><t:Constant Value="26214400"/></t:FieldURIOrConstant></t:IsGreaterThan>"#,
            r#"<t:IsEqualTo><t:FieldURI FieldURI="item:HasAttachments"/><t:FieldURIOrConstant><t:Constant Value="true"/></t:FieldURIOrConstant></t:IsEqualTo></t:And>"#
        )
    );
    let q = crate::query::SearchQuery::parse("year:2024");
    assert!(restriction(&q).unwrap().contains("IsGreaterThanOrEqualTo"));
    // Words go as AQS; the size is checked on what it finds.
    assert_eq!(restriction(&crate::query::SearchQuery::parse("отчёт larger:1M")), None);
    assert_eq!(restriction(&crate::query::SearchQuery::parse("in:Archive")), None);
}

#[test]
fn autodiscover_signs_in_only_on_hosts_of_the_mail_domain() {
    use super::may_sign_in;
    assert!(may_sign_in("autodiscover.example.com", "example.com"));
    assert!(may_sign_in("Mail.Example.com", "example.com"));
    // The bare domain is often a web site on someone else's hosting.
    assert!(!may_sign_in("example.com", "example.com"));
    // A redirect elsewhere gets no password.
    assert!(!may_sign_in("autodiscover.example.org", "example.com"));
    assert!(!may_sign_in("evilexample.com", "example.com"));
}

#[test]
fn adds_up_the_occupied_space_of_a_folder_page() {
    // A FindFolder answer from Exchange 2019: folders carry their size as the extended
    // property 0x0E08 (Long, bytes). This page holds three folders and says so.
    let answer = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Body><m:FindFolderResponse><m:ResponseMessages><m:FindFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:RootFolder IndexedPagingOffset="3" TotalItemsInView="3" IncludesLastItemInRange="true"><t:Folders><t:Folder><t:FolderId Id="I"/><t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x0E08" PropertyType="Long"/><t:Value>1073741824</t:Value></t:ExtendedProperty></t:Folder><t:Folder><t:FolderId Id="S"/><t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x0E08" PropertyType="Long"/><t:Value>536870912</t:Value></t:ExtendedProperty></t:Folder><t:Folder><t:FolderId Id="R"/></t:Folder></t:Folders></m:RootFolder></m:FindFolderResponseMessage></m:ResponseMessages></m:FindFolderResponse></s:Body></s:Envelope>"#;
    let doc = parse(answer).unwrap();
    let resp = single(&doc).unwrap();
    let root = child(resp, "RootFolder").unwrap();
    // 1 GiB + 512 MiB; a folder without the property counts zero.
    assert_eq!(folders_bytes(root), (1_610_612_736, 3));
    // The page says it is the last one.
    assert!(!has_next_page(root));

    // A page of a deep traversal starting at root, not msgfolderroot: the NON_IPM
    // subtrees (Recoverable Items and the like) hang under root and count too.
    let body = find_folder_body(0);
    assert!(body.contains(r#"PropertyTag="0x0E08" PropertyType="Long""#), "{body}");
    assert!(body.contains(r#"Traversal="Deep""#));
    assert!(body.contains(r#"<t:DistinguishedFolderId Id="root"/>"#));
    assert!(body.contains(r#"Offset="0""#));
    // The next page's offset must reach the request, or paging would read page 0 forever.
    assert!(
        find_folder_body(1000).contains(r#"Offset="1000""#),
        "{}",
        find_folder_body(1000)
    );
}

#[test]
fn a_page_says_whether_one_follows() {
    fn next_page(attr: &str) -> bool {
        let xml = format!(r#"<RootFolder {attr}><Folders><Folder><FolderId Id="x"/></Folder></Folders></RootFolder>"#);
        let doc = roxmltree::Document::parse(&xml).unwrap();
        has_next_page(doc.root_element())
    }
    // xs:boolean has both spellings; a page is last only when the answer says so.
    assert!(next_page(r#"IncludesLastItemInRange="false""#));
    assert!(next_page(r#"IncludesLastItemInRange="0""#));
    assert!(!next_page(r#"IncludesLastItemInRange="true""#));
    assert!(!next_page(r#"IncludesLastItemInRange="1""#));
    // Without the attribute there is nothing to page on: the walk stops.
    assert!(!next_page(r#"IndexedPagingOffset="3""#));
}

#[test]
fn reads_effective_rights_of_a_folder() {
    // A GetFolder answer from Exchange 2019: a shared inbox opened to the user as a
    // reviewer, and the user's own inbox as the owner.
    let answer = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Body><m:GetFolderResponse><m:ResponseMessages><m:GetFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:Folder><t:FolderId Id="A"/><t:DisplayName>Олег Смирнов — Входящие</t:DisplayName><t:EffectiveRights><t:Read>true</t:Read><t:CreateContents>false</t:CreateContents><t:CreateHierarchy>false</t:CreateHierarchy><t:Delete>false</t:Delete><t:Modify>false</t:Modify></t:EffectiveRights></t:Folder><t:Folder><t:FolderId Id="B"/><t:DisplayName>Входящие</t:DisplayName><t:EffectiveRights><t:Read>true</t:Read><t:CreateContents>true</t:CreateContents><t:CreateHierarchy>true</t:CreateHierarchy><t:Delete>true</t:Delete><t:Modify>true</t:Modify></t:EffectiveRights></t:Folder></m:Folders></m:GetFolderResponseMessage></m:ResponseMessages></m:GetFolderResponse></s:Body></s:Envelope>"#;
    let doc = parse(answer).unwrap();
    let resp = single(&doc).unwrap();
    let folders = child(resp, "Folders").unwrap();
    let list: Vec<_> = folders.children().filter(Node::is_element).collect();
    // The reviewer: read only.
    let ro = effective_rights(list[0]).unwrap();
    assert!(ro.read && ro.read_only(), "{ro:?}");
    assert!(!ro.allows(crate::acl::Action::Write));
    assert!(!ro.allows(crate::acl::Action::Delete));
    // The owner: everything.
    let all = effective_rights(list[1]).unwrap();
    assert!(all.read && all.write && all.insert && all.allows(crate::acl::Action::Delete));
    assert!(!all.read_only());

    // A folder without EffectiveRights: nothing is known.
    let bare = roxmltree::Document::parse(
        r#"<t:Folder xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><t:FolderId Id="C"/></t:Folder>"#,
    )
    .unwrap();
    assert!(effective_rights(bare.root_element()).is_none());
}

#[test]
fn writes_an_exchange_category_on_a_letter() {
    // Adding a category: one AppendToItemField on the message's Categories property.
    let add = categories_add("Проект «Север»").unwrap();
    assert!(add.contains("<t:AppendToItemField>"), "{add}");
    assert!(add.contains(r#"FieldURI="message:Categories""#), "{add}");
    assert!(add.contains("Проект «Север»"), "{add}");
    // An empty name changes nothing.
    assert!(categories_add("  ").is_none());

    // Removing one: the whole list is set again without it.
    let set = categories_set(&["Счета".into()]);
    assert!(set.contains("<t:SetItemField>"), "{set}");
    assert!(set.contains(r#"FieldURI="message:Categories""#), "{set}");
    assert!(set.contains("<t:String>Счета</t:String>"), "{set}");
    // No categories left: an empty SetItemField clears them.
    let clear = categories_set(&[]);
    assert!(clear.contains("<t:SetItemField>"), "{clear}");

    // Reading the categories of an item back.
    let xml = r#"<t:Message xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><t:Categories><t:String>Красная категория</t:String><t:String>Проект «Север»</t:String></t:Categories></t:Message>"#;
    let doc = roxmltree::Document::parse(xml).unwrap();
    assert_eq!(
        categories_of(doc.root_element()),
        ["Красная категория", "Проект «Север»"]
    );
    let none = roxmltree::Document::parse(
        r#"<t:Message xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"/>"#,
    )
    .unwrap();
    assert!(categories_of(none.root_element()).is_empty());
}
