# every-callback-invocation-is-inside-the-redaction-guard

## Discovery trigger

The guard is opt-in per call site. `panic_boundary.rs` exposes two wrappers and no enforcement:
`redact_sync` for a synchronous handler method and `redact` for each poll of a returned future.
Nothing in the type system requires a call into handler or provider code to pass through either — a
new `handler.foo()` compiles and runs unredacted. The property is an inventory claim over 27 hand-
written call sites, and the count is what has to be maintained.

## Evidence trail

`crates/mc-host/src/panic_boundary.rs` is 66 lines and contains the whole mechanism.

The depth counter is a thread-local, not a global flag (`:11-13`):

```
thread_local! {
    static CALLBACK_POLL_DEPTH: Cell<u32> = const { Cell::new(0) };
}
```

`CallbackPollGuard::enter` increments with `saturating_add` (`:19`) and `Drop` decrements with
`saturating_sub` (`:26`). `callback_is_polling` (`:30-34`) reads it through `try_with(...)
.unwrap_or(false)`, so a destroyed thread-local reports "not in a callback" and falls through to the
prior hook rather than redacting.

The hook itself (`:38-49`):

```
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
```

`REDACTED_DIAGNOSTIC` is the fixed string at `:7`, `"mc-host handler callback panicked (details
redacted)"`. The `Once` at `:9` makes installation first-caller-wins, so whichever of the two
installers runs first captures the then-current hook as `previous`, and a hook installed afterwards
by a test harness is simply replaced.

The per-poll granularity is deliberate and documented at `:57-58` — "Marks each individual future
poll, not the whole await. A yielded callback therefore cannot suppress an unrelated task's panic on
the same worker" — and implemented at `:59-66` by entering the guard inside the `poll_fn` closure
(`:62`) rather than around the `.await`.

**The inventory.** `grep -rn "panic_boundary::redact_sync(\|panic_boundary::redact("` across
`crates/mc-host/src/`, excluding comment lines, returns **27** call sites — 18 `redact_sync` and 9
`redact` — in six files: `runtime.rs` 14 (`:303`, `:304`, `:322`, `:323`, `:674`, `:675`, `:741`,
`:742`, `:960`, `:964`, `:1067`, `:1076`, `:1241`, `:1242`), `dispatch.rs` 6 (`:971`, `:972`,
`:1125`, `:1127`, `:1240`, `:1241`), `transport_provider.rs` 3 (`:190`, `:191`, `:245`),
`provider_recovery.rs` 2 (`:456`, `:529`), `connection.rs` 1 (`:908`), `shm_provider.rs` 1 (`:671`).
The catalog's "roughly twenty" is 27 exactly.

The paired shape appears repeatedly: `redact_sync` around the synchronous call that produces the
future, then `redact` around the future — `dispatch.rs:971-972`, `runtime.rs:303-304`, `:322-323`,
`:741-742`, `:1241-1242`. `dispatch.rs:1127` is the `redact`-only half of a `select!` branch, and
`runtime.rs:1076` wraps it in a `timeout`.

`install()` has two call sites: `runtime.rs:635`, the first statement of `run` before
`config.validate()` at `:636`; and `transport_provider.rs:186`, whose comment at `:181-185` states
why it must be earlier — "Metadata getters are provider code: the redaction hook must exist before
they run (registration happens before `run` installs it)".

## Failure scenario

One unwrapped call site is the whole failure. A panic inside handler or provider code that is not
under the guard takes the `else` branch at `:45` and runs `previous(info)`, which is the default
hook: the panic payload and, with `RUST_BACKTRACE` set, a backtrace go to stderr. Since the daemon's
stderr is the owner-only `daemon.log` (see `the-panic-hook-cannot-itself-fail`), the leak is durable
on disk rather than transient.

The over-broad direction fails the other way. If the guard were entered around an `.await` instead of
per poll, a callback that yielded would leave the depth nonzero while the worker ran other tasks, and
an unrelated task's panic on that worker would be redacted to the fixed string — losing the
diagnostic for a bug that has nothing to do with untrusted code. `:59-66` is what prevents that.

## Timing windows and dependencies

The counter is thread-local, so cross-worker interference is structurally impossible; the only
question is intra-thread scope, which is the per-poll design. Depth unwinding through a panic works
because the panic hook runs *before* unwinding begins — so the counter is still nonzero when `:42`
reads it — and `CallbackPollGuard::drop` (`:24-28`) decrements during the subsequent unwind. That
ordering depends on `panic = "unwind"`; the workspace `Cargo.toml` sets no `panic` key and no
`[profile]` override, so the default unwind applies. Under `panic = "abort"` the drop would never
run, but no unwind occurs either, so the counter's state is moot.

The nesting is handled: `saturating_add`/`saturating_sub` mean nested wrapped calls — `redact_sync`
around a body that itself calls `redact_sync` — increment and decrement correctly rather than
clobbering a boolean.

## What a test must construct

Two directions, and both need a subprocess, because the assertion is on process stderr and on the
installed hook.

The not-over-broad direction is covered. `tests/dispatch.rs:605`
`handler_panic_payload_is_redacted_from_process_stderr` re-executes the test binary
(`:606-610`) with `--exact panic_redaction_subprocess_child`, and the child at `:633` installs a
distinguishable prior hook at `:637`, drives a panicking handler (`:646-658`), then panics outside any
callback at `:661` with `catch_unwind(|| panic!("UNRELATED-PANIC-CANARY"))`. The parent asserts three
things at `:618-629`: the fixed redacted diagnostic is present, the handler's canary body is absent,
and `"UNRELATED-PANIC-CANARY"` is present.

That is more than the catalog credits. The catalog states that because `panic_boundary.rs` has no test
module, "nothing asserts what is printed, that the prior hook is preserved, or that the depth counter
unwinds correctly through a panic." The first two are asserted — `:619` pins the printed string,
`:627` pins prior-hook preservation. `panic_boundary.rs` does have zero `#[cfg(test)]` modules, which
is verified, but the integration test covers those two clauses. Only the depth-counter clause stands
unasserted, and there is no test of nested `redact_sync` or of the counter's value after a caught
panic.

What no test covers is the inventory. The child exercises one call site — `dispatch.rs:971-972`, the
handler dispatch path. The other 26 are unexercised, and a new unwrapped call site would not fail any
test. The check that matches this property is a source-level one: enumerate every call through a
`McHostHandler` or provider trait object and assert each is lexically inside `redact_sync` or
`redact`.

## Investigation log

### Q: How many call sites are there, and does the catalog's "roughly twenty" hold?

- Sources examined: `grep -rn "panic_boundary::redact_sync(\|panic_boundary::redact("` over
  `crates/mc-host/src/`, with comment-only lines filtered.
- Findings: 27 invocations across six files, split 18 `redact_sync` / 9 `redact`. Two additional grep
  hits are prose in comments (`provider_recovery.rs:453`, `transport_provider.rs:238`) and are not
  call sites.
- Missing evidence: none for the count. Whether 27 is *complete* — that every trait-object call into
  untrusted code is among them — was not established here; it requires enumerating the handler and
  provider trait methods and locating every call, which this pass did not do.
- Conclusion: partially resolved. The count is exact at 27; the completeness of the inventory is the
  open half, and it is the half the property actually asserts.

### Q: Does `panic_boundary.rs` have its own tests, and does anything assert the printed string?

- Sources examined: all 66 lines of `crates/mc-host/src/panic_boundary.rs`; `grep -n "cfg(test)\|mod
  tests"` on that file; `crates/mc-host/tests/dispatch.rs:598-663`.
- Findings: the grep returns nothing — no test module in `panic_boundary.rs`, confirming the catalog.
  But `tests/dispatch.rs:611-629` asserts the success of the child, the presence of
  `REDACTED_PANIC_DIAGNOSTIC` (`:619`), the absence of `support::CANARY_BODY` (`:623`), and the
  presence of `"UNRELATED-PANIC-CANARY"` (`:627`).
- Missing evidence: none.
- Conclusion: resolved with a correction. Two of the three clauses the catalog lists as unasserted are
  asserted, in an integration test rather than a unit test. The depth-counter-unwind clause remains
  unasserted.
