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
    let e = unauthorized(&["Negotiate".into(), "NTLM".into()]);
    assert!(matches!(&e, Error::HttpAuth(m) if m == "Negotiate, NTLM"), "{e:?}");
    assert_eq!(e.kind(), "auth");
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
    let (code, message) = fault(fault_xml);
    assert_eq!(code, "ErrorInvalidServerVersion");
    assert_eq!(message, "The specified server version is invalid.");

    let answer = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:GetItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Error"><m:MessageText>The specified object was not found in the store.</m:MessageText><m:ResponseCode>ErrorItemNotFound</m:ResponseCode></m:GetItemResponseMessage><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse></s:Body></s:Envelope>"#;
    let doc = parse(answer).unwrap();
    let r = responses(&doc);
    assert_eq!(r.len(), 2);
    assert!(matches!(&r[0], Err(e) if e.kind() == "not-found"));
    assert!(r[1].is_ok());
}

#[test]
fn search_query_becomes_aqs() {
    let q = crate::query::SearchQuery::parse("от:anna тема:\"отчёт за май\" бюджет есть:вложение is:unread");
    assert_eq!(
        aqs(&q),
        "\"бюджет\" from:\"anna\" subject:\"отчёт за май\" hasattachment:true isread:false"
    );
}
