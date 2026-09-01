# a-cancelled-emission-releases-every-permit-it-held

## Discovery trigger

Off-reader emissions acquire their admission permit on the read loop, before the
spawn, so a client cannot pipeline past the capacity gate — the comments at
`connection.rs:439-442` and `dispatch.rs:858-860` both say so. That means the
permit is a local at the spawn site, and whether an aborted task releases it
depends entirely on which side of the `async move` boundary the binding sits.
Checking all seven sites was the only way to know.

## Evidence trail

Seven emission sites hold a permit, and at every one the rebinding is the first
statement *inside* the async block. Naming them:

Five hold a pending permit, acquired at `connection.rs:668` from the pool
selected at `:659-667`:

- `connection.rs:687-697` — `Reject`; `let _pending_permit = pending_permit;`
  at `:688`.
- `connection.rs:705-719` — `CatalogList`; binding at `:706`.
- `connection.rs:724-727` — `HostShutdown`; binding at `:725`.
- `connection.rs:732-751` — `HostStatus`; binding at `:733`.
- `connection.rs:761-764` — `RouteOpen`; binding at `:762`. This is the one
  site using `spawn_lifecycle` rather than `spawn_tracked`, so it is
  abort-exempt — the permit is released by completion, not abort.

Two hold a per-generation reject permit from `gen.busy_rejects`
(`connection.rs:254`, capacity 32 at `:53`):

- `connection.rs:452-463` — the authoritative rejection; permit acquired at
  `:443`, bound at `:453`.
- `dispatch.rs:612-615` — `emit_rejection`; permit acquired at `:608`, bound at
  `:613`.

In every case the pattern is identical: the permit is moved into the closure by
`async move` and immediately rebound to a `_`-prefixed local, so it is owned by
the future's state. Dropping the future — which is what abort does once the task
stops — drops that local and returns the permit. Moving any binding above the
`async move` would put the permit in the enclosing frame, where it is dropped on
success (the frame returns) but leaked on abort, exactly the asymmetry the
catalog names.

Two sites nearby are *not* in the seven, and knowing why matters for the test:

- `connection.rs:983-997` — `respond_tcp` holds no permit at all. The comment at
  `:977-980` states the bound instead: the setup state machine admits at most two
  TCP negotiation responses per generation.
- `connection.rs:573-580` — the route-Goodbye close holds no permit; the comment
  at `:567-570` explains the bound is the `CloseDecision::Owner` filter.

The third resource, the egress byte charge, is released by a different mechanism
and needs no per-site check. It travels inside the frame as
`OutboundFrame.charge` (`frame_channel.rs`), and the writer drops it at
`tcp_frame_channel.rs:398` after a completed write, or with the whole queue when
the receiver drops at `:400-402`. An emission aborted before `send_before`
returns drops its charge with the future; one aborted after has already handed
the charge to the writer.

Existing checks, verified. `tests/transport_negotiation.rs:1522`
`max_connections_bounds_prepared_candidates_and_failure_releases_them` covers
connection permits, and that binary *is* named in CI
(`.github/workflows/ci.yml:167-168`). `tcp_frame_channel.rs:944`
`byte_charges_release_with_their_frame` and `:1062`
`stalled_consumer_write_retires_generation_and_frees_charges` cover charges;
both are `--lib` tests, which CI runs (`ci.yml:122`). Nothing covers pending or
reject permits under abort, confirmed — no test in the crate saturates
`pending_permits` or `busy_rejects` and then aborts.

## Failure scenario

Stated as the leak the pattern prevents, since that is what a test must be able
to distinguish.

1. `pending_permits` is driven to saturation, so `try_acquire_owned` at
   `connection.rs:668` succeeds for the last permit and the next request would
   be refused.
2. That emission is spawned at one of the five pending sites and parks inside
   `emit_error_terminal` or `emit_catalog_response`, waiting on a contended
   `egress_budget`.
3. Forced shutdown runs `abort_all` (`runtime.rs:1182`). The emission's task is
   in `abort_handles`, because all five pending sites except `:761` use
   `spawn_tracked`. The task is aborted mid-await.
4. As written, the future drops, the `_pending_permit` local drops, and the
   semaphore returns to full. Had the binding been outside the `async move`,
   the permit would be owned by `handle_control`'s frame — which already
   returned at `:770` — and the count would be permanently one lower.
5. The same shape on `busy_rejects` is worse in a specific way: it is
   per-generation with capacity 32, and past the bound `emit_rejection` retires
   the generation (`dispatch.rs:625-626`). A leak there converts a transient
   egress contention into a generation that retires on its 33rd rejection
   forever, and `handle_control`'s equivalent at `connection.rs:443-447`
   retires on the first.

## Timing windows and dependencies

Saturation is a hard prerequisite, not a convenience. Below saturation the
semaphore has headroom, so a leaked permit and a released one produce the same
observable count for as long as the test runs — the catalog's "without
saturation the check cannot distinguish a leak from headroom" is exact. The
window itself is wide: the emission must be parked, and it parks on the shared
`egress_budget`, whose wait is bounded by the frame deadline
(`admission_deadline`, `frame_channel.rs:783-785`, default 30s per
`config.rs:224`). So contended egress holds an emission open for up to a frame
deadline, which is ample. The abort must arrive in that interval, from either
`abort_all` on the forced path or a read cancellation followed by a tracker
close.

The `:761` site is a documented exception. Because `spawn_lifecycle` registers
no abort handle (`runtime.rs:157-161`), `abort_all` cannot reach it, so its
permit is never released by abort — it is released when `open_route` completes,
self-bounded by `lifecycle_callback_deadline` twice over
(`dispatch.rs:1123-1136`, `:1239-1250`). A test that aborts and then asserts the
pending pool is full must account for this one outstanding permit, or drive a
request that does not take the `RouteOpen` arm.

## What a test must construct

Saturate both pools, park the emissions, abort, then assert both semaphores
return to full and the egress budget to zero — the catalog's check verbatim.
Concretely: set `limits.max_pending_requests` low, open enough concurrent
control requests to hold every pending permit, and shrink `egress_budget` so the
emissions block inside their charge acquisition rather than completing. For the
reject pool, exhaust `pending_permits` first so control requests take the
`server_busy` path at `connection.rs:669`, then send more than a few so
`busy_rejects` fills without reaching 32 (at 32 the generation retires and the
observable changes). Then force the abort — a shutdown whose drain misses its
deadline reaches `abort_all` at `runtime.rs:1182`.

Oracle: `pending_permits.available_permits()` and
`gen.busy_rejects.available_permits()` both return to their configured
capacities, and `egress_budget.available()` returns to its baseline. The
mutation control that makes the test worth writing is to hoist one binding above
its `async move` — for instance move `connection.rs:706` to just before `:705` —
and confirm the test fails. Without that control the test passes on both the
correct and the leaking code, because a happy-path completion releases the
permit either way.

## Investigation log

The catalog records no open questions. The verification duty was to confirm the
binding position at all seven sites, and it resolved cleanly.

- Sources examined: `connection.rs:48-53`, `:244-258`, `:433-463`, `:565-581`,
  `:649-771`, `:977-997`; `dispatch.rs:596-629`, `:850-884`, `:908-910`;
  `frame_channel.rs:758-882`; `tcp_frame_channel.rs:303-404`, tests at `:943`,
  `:1061`; `runtime.rs:143-168`, `:211-221`, `:1179-1184`; `config.rs:207`,
  `:224`; `.github/workflows/ci.yml:118-125`, `:163-168`;
  `tests/transport_negotiation.rs:1521-1527`.
- Findings: all seven permit-bearing sites bind inside the async block, on the
  first statement. Five carry a pending permit, two a reject permit. Two nearby
  emission sites (`connection.rs:983`, `:573`) hold no permit and bound
  themselves structurally instead, so the count of seven is exact rather than a
  subset. One of the seven (`:761`) is abort-exempt by construction, which
  changes what an abort-based test can assert about it.
- Missing evidence: none for the mechanism.
- Conclusion: resolved. The property holds at HEAD at all seven sites, and the
  gap is that no test saturates the pending or reject pools and aborts, so the
  invisible-on-success failure mode the pattern guards against is unguarded by
  the suite.
