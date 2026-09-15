use crate::{Error, Result};
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Clone, Default)]
pub struct ReadCancellation(Arc<AtomicBool>);
impl ReadCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn check(&self) -> Result<()> {
        if self.0.load(Ordering::Acquire) {
            Err(Error::new(
                "READ_CANCELLED",
                "本次读取已取消。",
                "Owned read was cancelled",
            ))
        } else {
            Ok(())
        }
    }
    pub fn run<T>(&self, read: impl FnOnce() -> Result<T>) -> Result<T> {
        with_scope(Some(self.clone()), || {
            self.check()?;
            let result = read();
            self.check()?;
            result
        })
    }
}
thread_local! {
    static CURRENT: RefCell<Option<ReadCancellation>> = const { RefCell::new(None) };
}
pub(crate) fn current() -> Option<ReadCancellation> {
    CURRENT.with(|scope| scope.borrow().clone())
}
pub fn check_read_cancellation() -> Result<()> {
    current().map_or(Ok(()), |scope| scope.check())
}
pub fn read_cancellation_active() -> bool {
    current().is_some()
}
pub(crate) fn with_scope<T>(scope: Option<ReadCancellation>, read: impl FnOnce() -> T) -> T {
    struct Restore(Option<ReadCancellation>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|current| *current.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(CURRENT.with(|current| current.replace(scope)));
    read()
}
