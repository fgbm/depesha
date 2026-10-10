//! Heavy calls of the cache made from async code.

/// Runs a heavy call of the cache on a multi-thread runtime without keeping the worker thread:
/// a batch of 200 headers holds the writer for about 100 ms on the first sync of a big mailbox
/// (`tests/cache_perf.rs`, #149), and the tasks queued on that thread would wait it out.
pub(crate) fn off_runtime_thread<T>(f: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(h) if h.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use super::*;

    /// Makes the heavy call from a task that has just queued another one. With one worker thread
    /// the queued task can run during the call only if the call gave the thread up.
    async fn queued_task_ran_during(heavy: impl FnOnce(&dyn Fn() -> bool) -> bool + Send + 'static) -> bool {
        tokio::spawn(async move {
            let ran = Arc::new(AtomicBool::new(false));
            let flag = ran.clone();
            tokio::spawn(async move { flag.store(true, Ordering::SeqCst) });
            heavy(&move || ran.load(Ordering::SeqCst))
        })
        .await
        .unwrap()
    }

    fn wait_until(seen: &dyn Fn() -> bool) -> bool {
        let t = Instant::now();
        while !seen() && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(5));
        }
        seen()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn heavy_call_leaves_the_worker_thread_to_other_tasks() {
        assert!(queued_task_ran_during(|seen| off_runtime_thread(|| wait_until(seen))).await);
    }

    /// The same shape without the helper: the queued task starves, which is what the helper prevents.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn the_same_call_made_directly_holds_the_thread() {
        let t = Instant::now();
        let seen_in_call = queued_task_ran_during(|seen| {
            let end = Instant::now() + Duration::from_millis(300);
            while Instant::now() < end {
                std::thread::sleep(Duration::from_millis(5));
            }
            seen()
        })
        .await;
        assert!(
            !seen_in_call,
            "the queued task ran on the held thread ({:?})",
            t.elapsed()
        );
    }

    #[tokio::test]
    async fn heavy_call_runs_on_a_current_thread_runtime() {
        assert_eq!(off_runtime_thread(|| 7), 7);
    }
}
