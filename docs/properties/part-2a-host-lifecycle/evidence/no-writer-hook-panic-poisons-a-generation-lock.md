# no-writer-hook-panic-poisons-a-generation-lock

## Discovery trigger

The write-completion hook is the one place where arbitrary generation-owned code
runs inside the shared writer task. Reading `write_frames` to see how it is
invoked showed the call has no unwind guard, while the statement fifty lines
above it — in the same loop body — does. That asymmetry is what makes this a
policy gap rather than an oversight in isolation.

## Evidence trail

The invocation, `tcp_frame_channel.rs:393-395`:

    if let Some(written) = written {
        written(completed_at);
    }

A direct call. No `catch_unwind`, no `redact_sync`, no `AssertUnwindSafe`. The
task brief placed the call at `~393`; at HEAD the `if let` is `:393` and the call
itself is `:394`.

The guarded boundary in the same loop body is `tcp_frame_channel.rs:348-349`:

    let encoded =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| direct.into_owned()));

with the unwind arm at `:355-359` retiring the generation. So one callback into
foreign code in `write_frames` is guarded and the other is not.

The hook that takes a generation lock is the liveness probe's, built at
`connection.rs:1426-1449`. Its first statement is
`let mut pings = gen_probe.pings.lock().expect("pings lock");` (`:1427`), and it
does instant arithmetic at `:1434-1435`
(`answered_at >= completed_at && answered_at.duration_since(completed_at) <
pong_deadline`). `pings` is a `std::sync::Mutex` (`connection.rs:116`), so a
panic while the guard is held poisons it.

Every consumer of that lock uses `.expect("pings lock")`, which panics on a
poisoned lock. All five non-test sites: `connection.rs:505` (the read loop's Pong
path), `:1357` (the liveness loop's wake computation), `:1371` (the expiry scan),
`:1381` (the clear-or-skip block), `:1403` (the insert). So a single poisoning
converts the read loop and the liveness loop into panicking tasks for that
generation, and the catalog's list — read loop, wake computation, expiry scan,
insert — is exact. Contrast `connection.rs:737`, where `health_snapshot` is read
with `unwrap_or_else(std::sync::PoisonError::into_inner)`: the crate does have a
poison-tolerant idiom, and the `pings` lock does not use it.

The skipped retirement signal is confirmed. `queue.retired.cancel()` sits at
`tcp_frame_channel.rs:402`, *after* the loop. An unwind out of `:394` leaves the
loop by unwinding, so `:402` never executes. `SenderQueue`
(`frame_channel.rs:838-854`) has no `Drop` impl — the only `Drop` in that file is
`ReceiveLease` at `:381` — so nothing cancels `retired` during the unwind.
Consequences for senders: `is_retired()` (`frame_channel.rs:828-830`) keeps
returning false, and `send_ticket_before`'s biased first arm on
`self.retired.cancelled()` (`:814`) never fires, so admission falls through to
`self.tx.send(..)` at `:815` and fails only because the receiver dropped, mapping
to `WriterGone` at `:818`. That is the catalog's "senders learn only through the
closed channel," verified.

The comparable guarded boundaries, so the record can state this is the gap in an
otherwise consistent policy. All three the catalog names exist:

- **Provider preflight** — `connection.rs:907-913`: `catch_unwind` wrapping
  `redact_sync(|| provider.preflight(..))`, defaulting to
  `PreflightEligibility::StaticallyOmitted` on unwind.
- **Prepare worker** — `transport_provider.rs:243-248`: `catch_unwind` wrapping
  `redact_sync(|| provider.prepare(&ctx))`, defaulting to
  `Err(ProviderFailure::Unavailable)`, with a comment stating a panicking gate
  is one failed preparation, not a dead worker.
- **Writer's owned-conversion** — `tcp_frame_channel.rs:348-349`, above.

Three more exist beyond the catalog's list: `shm_provider.rs:351` (endpoint
panic, so the thread can take the quarantine branch), `shm_provider.rs:645`,
`provider_recovery.rs:455` and `:528`, and `composite.rs:165`, which wraps every
poll of a child future. The handler-callback boundaries go through
`panic_boundary::redact` / `redact_sync` (`panic_boundary.rs:52`, `:59`) instead.

One extension the catalog does not name. `on_publish` is the hook's sibling and
is also unguarded: `frame_channel.rs:726-727` calls `on_publish()` inside
`begin_publication`, which `write_frames` invokes at
`tcp_frame_channel.rs:336`. So there are two unguarded callback boundaries in
this writer loop, not one, and a panic in either has the same unwind path.

Other completion hooks, for reachability. Non-test `written: Some(..)` sites are
`dispatch.rs:720` (the shutdown commit hook), `dispatch.rs:791` (a bare
`written_tx.send`), and `connection.rs:1455` (the liveness hook). The fourth,
`lifecycle.rs:1934`, is inside `mod tests` (starts `:1301`). Of the three, only
the liveness hook takes a lock or does arithmetic.

## Failure scenario

1. A liveness policy is configured, so `serve_generation` spawns the liveness
   loop at `connection.rs:296` and Pings carry the hook at `:1455`.
2. The writer completes a Ping's bytes and calls `written(completed_at)` at
   `tcp_frame_channel.rs:394`.
3. The hook takes the `pings` lock at `connection.rs:1427` and panics — the
   catalog's mechanism is the arithmetic at `:1434-1435`.
4. The unwind poisons `pings` and leaves `write_frames` without reaching
   `:402`, so `retired` stays uncancelled and the mpsc receiver drops with the
   frame.
5. The read loop reaches its next Pong at `connection.rs:505`, calls
   `.expect("pings lock")` on a poisoned mutex, and panics. The liveness loop
   panics at `:1357` on its next wake. Both are tracked tasks, so the panics
   surface as `JoinError::is_panic` where they are joined and as tracker
   completions where they are not.
6. Because the panic originates in the writer task rather than inside a handler
   callback, it never passes through `panic_boundary::redact`, so its payload
   prints unredacted — the catalog's second impact clause.

## Timing windows and dependencies

No race; the failure is at the instant of the call. Two prerequisites gate it.
`shared.liveness` must be `Some` for a lock-taking hook to exist at all
(`connection.rs:291`), and the hook must actually panic. The second is not
reachable today: the arithmetic at `:1434-1435` guards `duration_since` with
`answered_at >= completed_at`, and tokio's `Instant::duration_since` saturates
rather than panicking in any case, so no current hook has an operation that must
overflow. That is why the catalog's confidence is high on mechanism and medium on
whether a hook can panic — and why this is a hardening property. The mechanism
is one edit away from live: any future hook that indexes, unwraps, or asserts
under the `pings` lock inherits the whole failure path.

## What a test must construct

An injected panic inside a completion hook while the `pings` lock is held, then
progress assertions on the two consumers — the catalog's check. The hook is not
injectable from outside the crate, so this is an in-crate test that builds an
`OutboundFrame` with `written: Some(Box::new(|_| { let _g = gen.pings.lock(); panic!() }))`
and drives it through a real `write_frames`, not the `#[cfg(test)]`
`spawn_writer` helper — `spawn_writer` is fine here, since the hook path at
`:393-395` is identical, and it avoids standing up a full connection.

The oracle is that the read loop's Pong path and the liveness loop still make
progress rather than panicking on the lock. Reaching it requires the consumers to
tolerate poisoning, so as written the test asserts the current behaviour is the
opposite; the honest form is a test that fails at HEAD, or one written against
the sibling obligations that *are* observable now: after the hook panics,
`gen.writer.is_retired()` is false (`frame_channel.rs:828`) and a subsequent
`send_before` returns `WriterGone` only via the closed channel. Both are
assertable today and both pin the unwind path this record documents. A second
case should cover `on_publish` at `frame_channel.rs:727`, since it is the same
gap.

## Investigation log

The catalog records no open questions. The verification duties — confirm the hook
is invoked with no unwind guard, and list the comparable guarded boundaries —
both resolved.

- Sources examined: `tcp_frame_channel.rs:303-404`, `:334-336`, `:348-359`,
  `:393-395`, `:400-404`, `:406-421`; `frame_channel.rs:714-727`, `:758-882`;
  `connection.rs:55-80`, `:96-120`, `:291-302`, `:500-540`, `:1341-1455`,
  `:737`, `:907-913`; `dispatch.rs:712-737`, `:783-798`; `lifecycle.rs:1301`,
  `:1925-1940`; `panic_boundary.rs:52-59`; `transport_provider.rs:232-250`;
  all crate `catch_unwind` sites; all non-test `written: Some(` sites.
- Findings: the call at `:394` has no guard; the sibling call at `:348-349` in
  the same loop body does; the liveness hook takes a `std::sync::Mutex` whose
  five non-test consumers all `.expect(..)`; the unwind skips
  `queue.retired.cancel()` at `:402` and `SenderQueue` has no `Drop`. All three
  catalog-named guarded boundaries exist as described, plus five more elsewhere
  in the crate, which supports the "gap in an otherwise consistent policy"
  framing. One addition the catalog omits: `on_publish` at
  `frame_channel.rs:726-727` is a second unguarded boundary in the same loop.
- Missing evidence: whether any hook can panic today remains unestablished, and
  the record should keep the catalog's medium confidence on that clause rather
  than assert reachability. Inspection found no panicking operation in the three
  live hooks, but that is absence of a witness, not proof of totality.
- Conclusion: mechanism resolved; reachability unresolved and recorded as such.
