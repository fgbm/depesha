//! The poison-tolerant lock of the core, once (#145): a thread that panicked holding a mutex
//! leaves the data as it was, and the next reader goes on instead of panicking in turn.
//! `scripts/lock-guard.sh` keeps another `fn lock` and a hand-written `into_inner()` out.

use std::sync::{Mutex, MutexGuard};

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_poisoned_lock_still_gives_its_data() {
        let m = std::sync::Arc::new(Mutex::new(5));
        let m2 = m.clone();
        std::thread::spawn(move || {
            let _held = m2.lock().unwrap();
            panic!("poison");
        })
        .join()
        .unwrap_err();
        assert!(m.is_poisoned());
        assert_eq!(*lock(&m), 5);
    }
}
