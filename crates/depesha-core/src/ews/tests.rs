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
