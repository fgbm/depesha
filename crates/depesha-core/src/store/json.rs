use serde::de::DeserializeOwned;

/// A JSON column read back as `T`. A column that does not parse is written to the log with
/// the table, the column and the row, and the reason without the content (the columns hold
/// letters, and serde's own message may quote them). The error is `FromSqlConversionFailure`,
/// so inside a row mapper it fails the query; a caller that can go on without the row asks
/// `json_col_or_default` or `json_opt` instead.
pub(super) fn json_col<T: DeserializeOwned>(
    table: &'static str,
    column: &'static str,
    id: impl std::fmt::Display,
    raw: &str,
) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|e| {
        let reason = format!("{:?} at line {} column {}", e.classify(), e.line(), e.column());
        tracing::warn!("{table}.{column} of row {id} is not readable JSON: {reason}");
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("{table}.{column} of row {id}: {reason}").into(),
        )
    })
}

/// `json_col` for a column the reader can do without: the default stands in, the log says so.
/// Never for a value that is written back, or the default would replace the unread data.
pub(super) fn json_col_or_default<T: DeserializeOwned + Default>(
    table: &'static str,
    column: &'static str,
    id: impl std::fmt::Display,
    raw: &str,
) -> T {
    json_col(table, column, id, raw).unwrap_or_default()
}

/// `json_col` for a nullable column: no value is `None`, an unreadable one is `None` with a log.
pub(super) fn json_opt<T: DeserializeOwned>(
    table: &'static str,
    column: &'static str,
    id: impl std::fmt::Display,
    raw: Option<&str>,
) -> Option<T> {
    json_col(table, column, id, raw?).ok()
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use super::super::tests::{mailbox, put};
    use super::*;
    use crate::domain::{Addr, Draft};
    use crate::message::Summary;
    use crate::store::{FollowupPlan, Store};

    /// What `tracing` wrote while `f` ran.
    fn logged(f: impl FnOnce()) -> String {
        #[derive(Clone, Default)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buf {
            type Writer = Buf;
            fn make_writer(&'a self) -> Buf {
                self.clone()
            }
        }
        let buf = Buf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(buf.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        String::from_utf8(buf.0.lock().unwrap().clone()).unwrap()
    }

    fn rows(store: &Store, table: &str) -> i64 {
        store
            .conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn broken_draft(store: &Store) -> i64 {
        let id = store
            .outbox_add("a", &Draft::default(), 100, 100, 0, &FollowupPlan::default())
            .unwrap();
        store
            .conn()
            .execute("UPDATE outbox SET draft = 'not json' WHERE id = ?1", [id])
            .unwrap();
        id
    }

    #[test]
    fn a_bad_column_is_logged_with_its_place_and_without_its_content() {
        let mut got = None;
        let log = logged(|| got = Some(json_col::<Vec<String>>("things", "list", 7, r#""secret letter""#)));
        assert!(got.unwrap().is_err());
        assert!(log.contains("things.list of row 7"), "{log}");
        assert!(!log.contains("secret"), "the content stays out of the log: {log}");
        let log = logged(|| {
            assert_eq!(
                json_col_or_default::<Vec<String>>("things", "list", 8, "{"),
                Vec::<String>::new()
            )
        });
        assert!(log.contains("things.list of row 8"), "{log}");
        assert_eq!(json_opt::<Vec<String>>("things", "list", 9, None), None);
        assert_eq!(
            json_opt::<Vec<String>>("things", "list", 9, Some(r#"["a"]"#)),
            Some(vec!["a".to_owned()])
        );
    }

    #[test]
    fn a_draft_that_does_not_parse_is_not_taken_out_of_the_outbox() {
        let store = mailbox();
        let id = broken_draft(&store);
        let log = logged(|| {
            assert!(store.outbox_remove(id).is_err());
            assert!(store.outbox_withdraw(id).is_err());
            assert!(store.outbox_sending(id, 150).is_err());
        });
        assert!(log.contains(&format!("outbox.draft of row {id}")), "{log}");
        assert_eq!(rows(&store, "outbox"), 1, "the row is not lost");
        let started: i64 = store
            .conn()
            .query_row("SELECT sending_started FROM outbox WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(started, 0, "a blank letter is not sent in its place");
    }

    #[test]
    fn the_outbox_list_goes_on_past_a_draft_that_does_not_parse() {
        let store = mailbox();
        broken_draft(&store);
        let good = store
            .outbox_add("a", &Draft::default(), 100, 100, 0, &FollowupPlan::default())
            .unwrap();
        let ids: Vec<i64> = store.outbox().unwrap().iter().map(|i| i.id).collect();
        assert_eq!(ids, [good]);
        assert_eq!(rows(&store, "outbox"), 2);
    }

    #[test]
    fn a_readable_draft_is_still_removed_and_withdrawn() {
        let store = mailbox();
        let draft = Draft {
            subject: "Счёт".into(),
            ..Default::default()
        };
        let a = store
            .outbox_add("a", &draft, 100, 100, 0, &FollowupPlan::default())
            .unwrap();
        assert_eq!(store.outbox_remove(a).unwrap().unwrap().subject, "Счёт");
        assert_eq!(rows(&store, "outbox"), 0);
        let b = store
            .outbox_add("a", &draft, 100, 100, 0, &FollowupPlan::default())
            .unwrap();
        assert!(matches!(store.outbox_withdraw(b).unwrap(), crate::store::Withdrawn::Draft(d) if d.subject == "Счёт"));
        assert_eq!(rows(&store, "outbox"), 0);
    }

    #[test]
    fn a_letter_with_unreadable_columns_is_still_listed_and_kept() {
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &Summary::default(), true);
        store
            .conn()
            .execute(
                "UPDATE messages SET from_addr = '{', to_addrs = '{', cc_addrs = '{', reply_to = '{', refs = '{', keywords = '{'
                 WHERE id = ?1",
                [id],
            )
            .unwrap();
        let log = logged(|| {
            let row = store.get(id).unwrap().expect("the letter is still there");
            assert!(row.from.is_none() && row.to.is_empty() && row.references.is_empty() && row.keywords.is_empty());
        });
        for column in ["from_addr", "to_addrs", "cc_addrs", "reply_to", "refs", "keywords"] {
            assert!(
                log.contains(&format!("messages.{column} of row {id}")),
                "{column}: {log}"
            );
        }
        let kept: String = store
            .conn()
            .query_row("SELECT to_addrs FROM messages WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, "{", "the column is not rewritten");
    }

    #[test]
    fn keywords_that_do_not_parse_are_not_overwritten_by_a_label_change() {
        let store = mailbox();
        put(&store, "INBOX", 1, &Summary::default(), true);
        store.conn().execute("UPDATE messages SET keywords = '{'", []).unwrap();
        let changed = store
            .adjust_keywords("a", "INBOX", &[1], &["work".to_owned()], &[])
            .unwrap();
        assert_eq!(changed, 0);
        let kept: String = store
            .conn()
            .query_row("SELECT keywords FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, "{");
    }

    #[test]
    fn an_unsubscribe_that_does_not_parse_is_an_error_not_an_absence() {
        let store = mailbox();
        let id = put(&store, "INBOX", 1, &Summary::default(), true);
        assert!(store.unsubscribe_of(id).unwrap().is_none());
        store
            .conn()
            .execute("UPDATE messages SET unsubscribe = '{'", [])
            .unwrap();
        assert!(store.unsubscribe_of(id).is_err());
    }

    #[test]
    fn a_sender_that_does_not_parse_is_no_trusted_logo_source() {
        let store = mailbox();
        let s = Summary {
            from: Some(Addr {
                name: None,
                email: "a@x.org".into(),
            }),
            ..Default::default()
        };
        let id = put(&store, "INBOX", 1, &s, true);
        store
            .conn()
            .execute("UPDATE messages SET dmarc = 1, from_addr = '{'", [])
            .unwrap();
        assert!(!store.logo_allowed(id, "a@x.org").unwrap());
    }

    #[test]
    fn a_sent_copy_with_a_pending_that_does_not_parse_is_still_listed() {
        let store = Store::open_in_memory().unwrap();
        let out = store
            .outbox_add("a", &Draft::default(), 1, 1, 0, &FollowupPlan::default())
            .unwrap();
        let id = store
            .outbox_sent_with_copy(
                out,
                &crate::store::NewSentCopy {
                    account_id: "a",
                    folder: "Sent",
                    raw: b"raw",
                    flags: "",
                    message_id: None,
                    subject: "s",
                    pending: None,
                },
            )
            .unwrap();
        store
            .conn()
            .execute("UPDATE sent_copies SET pending = '{'", [])
            .unwrap();
        let log = logged(|| {
            let copies = store.sent_copies().unwrap();
            assert_eq!((copies.len(), copies[0].id, copies[0].pending.is_none()), (1, id, true));
        });
        assert!(log.contains(&format!("sent_copies.pending of row {id}")), "{log}");
    }

    #[test]
    fn namespaces_that_do_not_parse_read_as_empty_and_stay() {
        let store = mailbox();
        store.save_namespaces("a", &Default::default(), 5).unwrap();
        store
            .conn()
            .execute("UPDATE namespaces SET personal = '{'", [])
            .unwrap();
        let log = logged(|| {
            let (ns, at) = store.namespaces("a").unwrap().unwrap();
            assert!(ns.personal.is_empty());
            assert_eq!(at, 5);
        });
        assert!(log.contains("namespaces.personal of row a"), "{log}");
    }
}
