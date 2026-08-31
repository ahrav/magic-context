# ring-a-reclamation-count-does-not-witness-charge-release

## Discovery trigger

`docs/mc-host-shm-transport.md:79` makes a release-gate claim in terms of
reclamation: "Repeated peer crashes must not increase active charges after
reclamation, and quarantined charges remain within the configured process bound."
`docs/mc-host-shm-transport.md:68` lists "completed reclamation count" as a
doctor field. So `reclamation.completed` is the value an operator or a gate would
read to decide whether charges came back. Tracing where it is incremented
relative to where the charge is actually released showed the two are only
coincidentally ordered.

## Evidence trail

**Where the charge is released.** `crates/mc-host/src/ring_transport.rs:276`,
`admission.release()`, on the endpoint OS thread, followed immediately by
`let _ = done_tx.send(())` at `:277`.

**Where the count is incremented.** `connection.rs:208-209`:

```
serve_generation(&shared, gen, receiver, io_task).await;
shared.ring.record_reclamation();
```

`record_reclamation` is `self.reclamations.fetch_add(1, Ordering::Relaxed)`
(`ring_transport.rs:205-207`), surfaced as
`"reclamation": {"completed": ...}` at `:192`.

**The normal path orders them correctly.** `io` is
`async move { let _ = done_rx.await; }` (`:286-288`), spawned as
`AbortOnDropHandle::new(shared.tracker.spawn(io))` at `connection.rs:190`, and
awaited at the very end of `serve_generation`:

```
// connection.rs:347
let _ = (&mut io_task).await;
```

`done_rx` resolves only when `done_tx.send(())` runs at `ring_transport.rs:277`,
which is after `admission.release()` at `:276`. So on the normal path
`record_reclamation` at `connection.rs:209` strictly follows the release. That is
the correct ordering and it is not accidental: the comment at
`connection.rs:341-346` explains that the join is deliberately unbounded because
the writer's own per-frame deadline bounds it.

**The path that breaks it.** `serve_generation` has an early `return` before it
reaches `:347`:

```
// connection.rs:273-276
if shared.draining.load(Ordering::SeqCst) || shared.shutdown.is_cancelled() {
    discard_unregistered_generation(&gen);
    return;
}
```

`io_task` is a local of `serve_generation` (`connection.rs:256`,
`mut io_task: AbortOnDropHandle<()>`), so this `return` drops it, and
`AbortOnDropHandle`'s whole purpose is to abort the spawned task on drop. The
spawned task is the *awaiter* of `done_rx`, not the endpoint thread, so aborting
it does not stop the thread. Control returns to `connection.rs:209`, which
increments the count.

At that instant the endpoint thread may still be running. What stops it is
`discard_unregistered_generation` (`connection.rs:350-354`), which calls
`gen.writer.discard()` at `:353`. That cancels the `discard` token
(`frame_channel.rs:701-703`; not re-swept post-#131), which `run_endpoint`
observes in the `select!` at
`ring_transport.rs:443` and returns. The thread then drops the `DuplexRing`,
releases the charge at `:276`, and fires `done_tx` at `:277` — to a receiver
whose awaiting task was already aborted.

So `reclamation.completed` increments before `accounting().active` decreases.

**Two further paths that skip the count entirely, for completeness.** Each early
`return` in `run_connection` before `connection.rs:208` never reaches
`record_reclamation`: auth failure (`:130-132`), permit failure (`:136-140`),
`prepare` failure (`:158-162`), activation-token failure (`:165-169`), and
`activate_server` failure (`:177-184`). The last three of those did charge
admission, so on those paths a charge is admitted and released with the
reclamation count never moving. That is a different shape of the same problem:
the count is not a reliable denominator either.

## Failure scenario

A release gate reads `diagnostics()` during a graceful shutdown and compares
`reclamation.completed` against the number of connections served, concluding
that every charge came back. If any connection retired through the
already-draining path at `connection.rs:273-276`, the count is ahead of reality,
and a host that is still holding charges reports as fully reclaimed.

The window is small — one `select!` observation plus one `DuplexRing` drop — but
it is exactly the window a shutdown-time gate samples, because that path is
*only* taken during shutdown. So the sampling and the defect coincide by
construction rather than by chance, which is what makes this worth a record
rather than a footnote.

The second shape, the skipped increments, makes the count an undercount on
failure paths and an overcount on the draining path, so it cannot be used as
either a lower or an upper bound without knowing which paths ran.

## Timing windows and dependencies

Window: from `connection.rs:209` to the endpoint thread reaching
`ring_transport.rs:276`. Bounded by how quickly `run_endpoint` observes the
`discard` token, which is one loop pass — but only if the loop reaches the
`select!` at `:441-474`. The `received == true` branch (`:415-421`) skips that
`select!` entirely, so a peer publishing continuously extends the window. That
coupling is the subject of
`ring-a-cancellation-close-requires-an-empty-inbound-observation`.

Dependencies:

- `ring-a-admission-charge-releases-on-every-endpoint-thread-exit` establishes
  that the charge does come back; this record establishes that the count is not
  the witness for it.
- Part 2a's `admission-freeze-precedes-the-shutdown-commit` and
  `no-generation-registers-after-the-drain-snapshot` cover the `draining` flag
  itself; the flag's correctness is assumed here.

## What a test must construct

Preconditions:

1. A host with at least one connection that authenticates and prepares a ring.
2. `shared.draining` set, or `shared.shutdown` cancelled, before that connection
   reaches `serve_generation`'s registration block at `connection.rs:265-278`.
   That is a race in normal operation but deterministic in a test that holds the
   connection between `activate_server` and `serve_generation`, or that commits
   `host.shutdown` while a connect is in flight.
3. An observation of `accounting().active` at the moment `record_reclamation`
   increments.

The third is the hard part, because both happen inside host internals. The
cheapest honest oracle is to instrument `record_reclamation` in a test build to
capture `self.admission.snapshot()` at increment time and assert it equals the
post-release value. A weaker but zero-instrumentation proxy: after the shutdown
completes, assert `reclamation.completed` equals the number of connections whose
charge is observably back, which catches the skipped-increment shape but not the
ordering shape.

Existing checks: `ring_transport.rs:883` asserts
`diagnostics["reclamation"]["completed"] == 1` after a direct
`record_reclamation()` call in
`diagnostics_report_fixed_identity_bounds_accounting_and_lifecycle_counts`. That
exercises the counter's plumbing, not its meaning, and it does not run in CI
because every `-p mc-host` invocation in `ci.yml` filters to an integration
binary.

## Investigation log

### Q: Should `record_reclamation` move onto the endpoint thread, immediately after `admission.release()`?

- Sources examined: `ring_transport.rs:205-207` (`record_reclamation`, which
  takes `&self` on `RingTransport`), `:223-277` (`prepare`'s thread closure and
  what it captures), `connection.rs:208-209` (the current call site),
  `connection.rs:273-276` and `:347` (the two exits from `serve_generation`).
- Findings: mechanically feasible and cheap. The closure already captures
  `Arc<TargetProfile>` (`:234`) and could capture an
  `Arc<RingTransport>` or a dedicated `Arc<AtomicU64>` just as easily; nothing
  about `record_reclamation` needs the connection's context. Moving it would make
  the count release-witnessed by construction and would also fix the
  skipped-increment shape, because every path that admits a charge spawns the
  thread that would then count it — except the `spawn` failure path at
  `:279-281`, which admits and releases without a thread at all.
- Missing evidence: whether "reclamation" is intended to mean "charge returned"
  or "connection fully torn down". `docs/mc-host-shm-transport.md:49` couples them
  — "Joined endpoint teardown returns its admission charge when the mapping is
  unmapped" — which supports the charge reading. `:68`'s "completed reclamation
  count" does not disambiguate.
- Conclusion: resolved on feasibility, unresolved on semantics. If reclamation
  means charge return, the move is correct and closes both shapes. If it means
  connection teardown, the current site is right and the doc's release-gate
  phrasing at `:79` is what needs changing, because it reads the count as a
  charge witness.

### Q: Is the `connection.rs:273-276` path reachable in practice, or only theoretically?

- Sources examined: `connection.rs:265-278` (the registration block and its
  comment at `:269-272`), `connection.rs:115-209` (`run_connection`'s full
  sequence from accept to `record_reclamation`).
- Findings: reachable, and the comment says so. `connection.rs:269-272` reads:
  "The token check closes the window between a committed `host.shutdown` (which
  cancels the token) and the shutdown sequence storing `draining`: a socket
  accepted just before the commit must not register a new generation after it."
  So the path exists specifically to handle a connection that authenticated and
  prepared before shutdown committed. Every graceful shutdown with a connect in
  flight takes it.
- Missing evidence: how often that coincidence occurs in practice, which is a
  deployment question rather than a code one.
- Conclusion: resolved with answer. The path is a designed-for case, not an
  edge, and it is the case a shutdown-time gate samples.
