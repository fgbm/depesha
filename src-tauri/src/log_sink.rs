//! A log the tests can read: `logged` collects what the code wrote while it ran, so a test can
//! hold a journal line to its rule.

use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Sink {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Sink {
    type Writer = Sink;
    fn make_writer(&'a self) -> Sink {
        self.clone()
    }
}

/// What the log got while `run` ran.
pub(crate) fn logged(run: impl FnOnce()) -> String {
    let sink = Sink::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(sink.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::DEBUG)
        .finish();
    tracing::subscriber::with_default(subscriber, run);
    let bytes = sink.0.lock().unwrap().clone();
    String::from_utf8(bytes).unwrap()
}
