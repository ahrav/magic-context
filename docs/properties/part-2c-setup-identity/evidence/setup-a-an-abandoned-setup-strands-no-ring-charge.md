# setup-a-an-abandoned-setup-strands-no-ring-charge

## Discovery trigger

Missing reapers recur across every part of this catalog, so the task asked whether
a half-finished setup is reaped and whether an abandoned attempt leaks a
descriptor, a mapping, or a charge. Three of the four post-`prepare` exits in
`run_connection` carry an explicit discard. One does not.

## Evidence trail

All references at commit `e447c927`.

`crates/mc-host/src/connection.rs`, the post-authentication sequence:

- `:143-149` clones the ring, ingress budget, queue depth and frame deadline and
  hands `ring.prepare(...)` to `tokio::task::spawn_blocking`.
- `:149-164` awaits it under
  `timeout_at(Instant::now() + shared.timing.transport_setup_deadline, prepared)`
  and destructures the triple-nested `Ok(Ok(Ok(PreparedRing { ... })))`. The
  `else { return; }` at `:163-164` covers a join error, a `prepare` error, and a
  timeout, all three collapsed into one arm.
- `:165-169`: token generation failure. Explicitly
  `sender.discard(); root.cancel(); return;`.
- `:170-185`: `activate_server` failure. Explicitly
  `sender.discard(); root.cancel(); return;`.
- `:186`: `drop(descriptors)` on the success path, after activation.
- `:187-188`: `record_attachment()`, `record_activation()`.
- `:208-209`: `serve_generation(...)` then `record_reclamation()`.

So the discard pattern appears at `:166-169` and `:180-185` and is absent at
`:157-164`. The absence is structural rather than an oversight: in that arm the
destructuring never bound `sender`, `root` or `descriptors`, so there is nothing
to call `discard()` on.

What happens to the ring in that arm depends on `spawn_blocking` semantics.
`timeout_at` returning `Err` drops the `JoinHandle`, and dropping a
`spawn_blocking` handle does not cancel the closure: tokio cannot abort a blocking
task once it has started. So `ring.prepare` runs to completion on the blocking
pool and the resulting `PreparedRing` is dropped inside the detached task. Whether
that release is equivalent to `sender.discard()` plus `root.cancel()` is a
`ring_transport.rs` and transport-crate question, not answerable from this
sub-part's files.

Descriptors specifically do not leak on this path. `PreparedRing.descriptors` is
`[OwnedFd; 2]` (`connection.rs:150-156` region destructures it), and `OwnedFd`
closes on drop, so the memfds are released wherever the value dies.

The observable accounting exists: `ring_transport.rs:199-203` reports
`"accounting"`, `"attachment": {"completed": ...}`, `"activation": {"completed":
...}` and `"peer_death": {"observed": ...}` from the transport's counters, and
`mc-host-shm-transport.md:21` states that active and quarantined charges are
reported separately and every configured limit is finite and validated at startup.

## Failure scenario

With `max_connections = 1`, a single stranded charge is a permanent denial: the
next peer's `ring.prepare` fails on admission, `connection.rs:157-164` returns, and
no connection can ever be established again until restart. The existing failure-mode
tests were written for exactly this reason:
`crates/mc-host/tests/shm_failure_modes.rs:232-245`
`setup_active_and_idle_sigkill_each_return_exact_capacity` pins
`max_connections = 1` and asserts a replacement connection succeeds after a killed
peer, and `:247-263` `repeated_crashes_do_not_ratchet_single_connection_capacity`
runs twelve cycles asserting no ratchet.

The uncovered exit is the `prepare` timeout. A deployment that shortens
`transport_setup_deadline`, or a host under memory pressure where `prepare`'s
prefault is slow, reaches it. If dropping a `PreparedRing` does not release what
`discard()` releases, then each timeout permanently consumes one connection's
worth of charge, and the ratchet test would catch it only if it exercised that
exit, which it does not.

## Timing windows and dependencies

The window is the `timeout_at` at `:157-162`. It closes when the deadline expires
while `prepare` is still running, so reaching it requires `prepare` to take longer
than `transport_setup_deadline`, default 2 seconds (`config.rs:227`).

There is a second, narrower race: `prepare` completes microseconds after the
deadline. Then a fully valid `PreparedRing` exists and is immediately dropped in a
task nobody joins. That is the worst case for this record, because every resource
was actually acquired.

Depends on `ring.prepare`'s own internal behaviour, which belongs to 2b
(`ring_transport.rs:233-317` per the re-scope document's attention focus for that
sub-part). Depends on Part 1's `charge-release-never-silently-strands`, which is
the neighbouring obligation and should be cited rather than restated here.

## What a test must construct

The three covered exits, which mostly exist already:

1. token-generation failure at `:165-169`. Reaching it needs `getrandom` to fail,
   which is not injectable through `activation_token()`. Note that
   `activation_token_with` at `:216-226` takes the fill closure as a parameter
   precisely so a test can inject a failure, but it is a private function with no
   visible caller other than `activation_token()`. So this exit is testable only
   from inside the crate.
2. `activate_server` failure at `:170-185`. Constructible with a peer that
   authenticates, calls `receive_grant`, then sends a wrong token or closes. The
   `setup` role in `shm_failure_modes.rs:44-58` is one statement away from it.
3. peer killed after grant, before activation. Already covered by
   `shm_failure_modes.rs:232-245`.

The uncovered exit:

4. Configure `transport_setup_deadline` to something `ring.prepare` cannot meet,
   for example one millisecond, or inject slowness into `prepare`. Drive N such
   attempts and assert the accounting reported at `ring_transport.rs:199-203`
   returns to its pre-attempt value, with N large enough that a single-unit leak
   is unambiguous. Twelve cycles is the precedent set by `:247-263`.

The oracle must be the accounting snapshot, not the ability to connect again,
because with `max_connections = 64` a small leak is invisible to a connect probe
until 64 attempts have accumulated.

A negative control is needed: the same N attempts through exit 2, which is known
to discard, must also return to baseline. If both leak, the fault is in the
accounting rather than in the exit.

## Investigation log

### Q: Does dropping a `PreparedRing` release the admission charge?

- Sources examined: `connection.rs:143-185`, `ring_transport.rs:199-203`, and the
  re-scope document's description of `ring_transport.rs:233-317` as `prepare`.
- Findings: not answerable from 2c's files. `PreparedRing`'s fields include
  `sender`, `receiver`, `io`, `root` and `read_cancel`, and the discard path calls
  `sender.discard()` and `root.cancel()` explicitly rather than relying on drop,
  which is weak evidence that drop alone is not equivalent. But `sender.discard()`
  may exist to distinguish a cancelled emission from a dropped one for reasons
  unrelated to charge release, which is what Part 2a's
  `a-cancelled-emission-releases-every-permit-it-held` is about.
- Missing evidence: `ring_transport.rs` and `crates/mc-shm-transport/src/`.
- Conclusion: unresolved, needs 2b. Recorded as the record's open question and the
  reason its confidence is medium rather than high.

### Q: Can `spawn_blocking` be cancelled by dropping the handle?

- Sources examined: `connection.rs:148`, `:157-164`.
- Findings: no. A `spawn_blocking` closure that has begun executing runs to
  completion regardless of the handle. That is the documented tokio contract and it
  is why this exit is different from an aborted `spawn`.
- Missing evidence: none.
- Conclusion: resolved. The `PreparedRing` is constructed and then dropped inside
  a task with no joiner, which is precisely the case the discard pattern exists to
  handle elsewhere.

### Q: Do descriptors or mappings leak on any exit?

- Sources examined: `connection.rs:150-186`, `setup_socket.rs:178-234`.
- Findings: descriptors are `OwnedFd` throughout and close on drop, on every exit
  and inside the detached task. On the receive side, the two rejection paths that
  return before draining ancillary data are `setup_socket.rs:205-207` (`CTRUNC`)
  and `:208-210` (zero bytes); rustix's `impl Drop for RecvAncillaryBuffer`
  (rustix 1.1.4, `src/net/send_recv/msg.rs:490-494`) calls `clear` (`:477-479`),
  which drains every message and drops the contained `OwnedFd`s. Verified in the
  vendored crate source.
- Missing evidence: whether mappings created inside `prepare` are unmapped on
  drop, which is the same 2b question as the charge.
- Conclusion: resolved for descriptors. Unresolved for mappings, folded into the
  first open question.
