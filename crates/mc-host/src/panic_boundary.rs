//! This module redacts panic diagnostics while handler callbacks execute.

use std::cell::Cell;
use std::future::Future;
use std::sync::Once;

const REDACTED_DIAGNOSTIC: &str = "mc-host handler callback panicked (details redacted)";

static INSTALL_HOOK: Once = Once::new();

thread_local! {
    static CALLBACK_POLL_DEPTH: Cell<u32> = const { Cell::new(0) };
}

struct CallbackPollGuard;

impl CallbackPollGuard {
    fn enter() -> Self {
        CALLBACK_POLL_DEPTH.with(|depth| depth.set(depth.get().saturating_add(1)));
        Self
    }
}

impl Drop for CallbackPollGuard {
    fn drop(&mut self) {
        CALLBACK_POLL_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

fn callback_is_polling() -> bool {
    CALLBACK_POLL_DEPTH
        .try_with(|depth| depth.get() != 0)
        .unwrap_or(false)
}

pub fn install() {
    INSTALL_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if callback_is_polling() {
                eprintln!("{REDACTED_DIAGNOSTIC}");
            } else {
                previous(info);
            }
        }));
    });
}

pub fn redact_sync<T>(callback: impl FnOnce() -> T) -> T {
    let _guard = CallbackPollGuard::enter();
    callback()
}

/// A callback future that returns `Poll::Pending` cannot suppress an unrelated task's panic on the same worker.
pub async fn redact<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    std::future::poll_fn(|cx| {
        let _guard = CallbackPollGuard::enter();
        future.as_mut().poll(cx)
    })
    .await
}
