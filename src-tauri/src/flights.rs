//! Requests for one key made at the same time share one run (sender pictures: a list of fifty
//! letters from one company asks about one logo, and the network is asked once).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::sync::OnceCell;

use crate::state::lock;

pub struct Flights<T> {
    running: Mutex<HashMap<String, Arc<OnceCell<T>>>>,
}

impl<T> Default for Flights<T> {
    fn default() -> Self {
        Self {
            running: Mutex::default(),
        }
    }
}

impl<T: Clone> Flights<T> {
    /// The answer of `work` for `key`: a call that finds the key running waits for that run and
    /// takes its answer; a later call, once the run is over, runs `work` anew.
    pub async fn run<F, Fut>(&self, key: &str, work: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let cell = lock(&self.running).entry(key.to_owned()).or_default().clone();
        let answer = cell.get_or_init(work).await.clone();
        let mut running = lock(&self.running);
        if running.get(key).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            running.remove(key);
        }
        answer
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn requests_for_one_key_at_once_run_the_work_once() {
        let flights = Flights::<Option<String>>::default();
        let runs = AtomicUsize::new(0);
        let work = || async {
            runs.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(30)).await;
            Some("logo".to_owned())
        };
        let (a, b, c) = tokio::join!(
            flights.run("bimi:ozon.ru", work),
            flights.run("bimi:ozon.ru", work),
            flights.run("bimi:ozon.ru", work)
        );
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(
            (a, b, c),
            (Some("logo".into()), Some("logo".into()), Some("logo".into()))
        );
    }

    #[tokio::test]
    async fn other_keys_and_later_requests_run_on_their_own() {
        let flights = Flights::<u32>::default();
        let runs = AtomicUsize::new(0);
        let work = || async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            runs.fetch_add(1, Ordering::SeqCst) as u32
        };
        tokio::join!(flights.run("a", work), flights.run("b", work));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        flights.run("a", work).await;
        assert_eq!(runs.load(Ordering::SeqCst), 3, "a finished run is not remembered");
    }
}
