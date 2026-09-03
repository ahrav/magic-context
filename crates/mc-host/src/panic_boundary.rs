//! Redacts panic diagnostics only while host handler callbacks are actively polled.
//!
//! One process-wide hook delegates panics outside callback polls to the previous hook.
//! Poll depth is thread-local, so a pending callback cannot redact a different task's
//! panic after control returns to the executor.

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

/// Installs the process-wide redacting panic hook once.
///
/// Concurrent calls are serialized by [`Once`]. Replacing the panic hook elsewhere
/// after this call disables this module's redaction.
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

/// Runs a synchronous callback with panic diagnostics redacted on this thread.
///
/// Panics from `callback` propagate unchanged after the hook emits the fixed diagnostic.
pub fn redact_sync<T>(callback: impl FnOnce() -> T) -> T {
    let _guard = CallbackPollGuard::enter();
    callback()
}

/// Polls a callback future with diagnostics redacted during each poll.
///
/// Redaction ends whenever the future returns `Poll::Pending`, so unrelated tasks on
/// the same worker retain normal panic diagnostics. Panics from the future propagate.
pub async fn redact<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    std::future::poll_fn(|cx| {
        let _guard = CallbackPollGuard::enter();
        future.as_mut().poll(cx)
    })
    .await
}
