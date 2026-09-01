# oversize-control-drain-work-is-bounded-without-ingress-budget

## Discovery trigger

Gap G2 names "the budget-free oversize drain" and the deferred-candidate list in
`../catalog.md:1187` had already flagged "the oversize-control drain costing no
ingress budget" as a trust-boundary candidate. The question to settle is what
bounds the work if the byte budget does not, and whether that bound is written
down anywhere.

## Evidence trail

All references at `1c193ae0`; the cited files are byte-identical to `d90e7811`.

The path, in execution order:

1. `read_frame` decodes and validates the header, then at
   `tcp_frame_channel.rs:198-202` returns `ReadEvent::OversizeControl` for a
   channel-0 `Request` whose `len > MAX_CONTROL_BODY_LEN`. The comment at
   `:199-200` states the intent: "The header alone proves the violation; never
   buffer the body (protocol §7.1)."
2. This is *before* the budget charge, which is at `:204-215`. So no ingress
   permit is acquired for the body at any point.
3. `recv` stores `PendingDrain { declared: header.len, deadline }` at `:123-129`
   and returns `InboundEvent::Rejected`.
4. `read_loop` handles the rejection at `connection.rs:417-462`: it applies the
   watermark (`:426-429`), acquires a `busy_rejects` permit (`:443-447`), and
   spawns the authoritative rejection emission (`:452-462`).
5. The next `recv` runs `drain_declared_body` first (`tcp_frame_channel.rs:97-112`),
   then reads the next frame.

The ceiling on discarded bytes is `MAX_BODY_LEN`, not the control cap.
`validate_inbound_header` (`frame_channel.rs:58-61`) rejects only
`len > MAX_BODY_LEN`, and it runs at `tcp_frame_channel.rs:196`, one line before
the oversize branch. `MAX_BODY_LEN = MAX_FRAME_BODY_LEN = 64 * 1024 * 1024`
(`wire.rs:35`, `:371`); `MAX_CONTROL_BODY_LEN = 65_536` (`wire.rs:374`). So the
control cap is the *floor* that triggers the branch, and 64 MiB is the ceiling on
the work. Any framing in terms of "up to the control cap" understates it by three
orders of magnitude.

What bounds it, exhaustively:

- **The absolute frame deadline, per frame.** `deadline` is computed once at
  `tcp_frame_channel.rs:169` as `Instant::now() + frame_deadline` from the first
  header byte, carried into `PendingDrain` at `:126`, and passed to
  `frame_read::drain` at `:243`. Default `frame_deadline` is
  `Duration::from_secs(30)` (`config.rs:224`, field at `:207`). The drain's
  effective window is strictly less than that, because the remaining 20 header
  bytes (`:170-186`) and the engine's rejection emission are spent from it first.
- **The connection permit semaphore, per host.** `run_connection` acquires from
  `shared.connection_permits` at `connection.rs:165-169`, built as
  `Semaphore::new(config.limits.max_connections)` (`runtime.rs:890`, field at
  `:123`), default 64 (`config.rs:129`). So at most 64 of these loops run
  concurrently. This is the permit semaphore that replaces the byte budget as the
  aggregate bound.
- **The rejection semaphore, per generation, over the emissions only.**
  `gen.busy_rejects` is `Semaphore::new(MAX_INFLIGHT_BUSY_REJECTS)` with the
  constant at `connection.rs:53` equal to 32, constructed at `:254`. The
  rejection path acquires at `:443-447` and retires the generation on exhaustion.
  The comment at `:437-442` is precise about the scope: "Rejected frames consume
  no pending permit, so the per-generation rejection semaphore is what bounds
  these emissions." It bounds *emissions*, and the permit releases when the
  spawned emission completes (`:453`, `_reject_permit` dropped at task end), so
  it caps concurrently unwritten rejections rather than the cycle rate. Nothing
  acquires a permit for the drain itself.
- **The correlation watermark, per frame.** `connection.rs:426-429` closes the
  generation unless each `Request` correlation strictly increases. So the frames
  must be distinct, which `u64` makes no practical constraint.

Per-cycle cost is bounded and allocation-free: `drain` reuses an 8 KiB stack
scratch buffer (`frame_read.rs:107`) and clamps each read to
`remaining.min(scratch.len())` (`:110`), so the cost is one `memcpy` per 8 KiB
with no heap traffic. But nothing throttles the repetition of the cycle, so the
aggregate is bounded by link bandwidth and the deadline, which is exactly the
quantity the ingress byte budget (`wire.rs:385-397`) bounds for every other body.

What is documented, and what is not. Documented, in three places, all describing
the *intent* and all accurate: `tcp_frame_channel.rs:42-46` (the `pending_drain`
field doc, naming the deadline as the bound on the drain), `:199-200` (never
buffer the body), and the assertion at `:803-807`, "an oversize declaration must
never hold ingress budget". Not documented anywhere: what replaces the budget as
the bound on the work, or that the ceiling is 64 MiB rather than the control cap.

Observability: `drain` never touches the `CopyCounter`. `record_copy` has exactly
two call sites, `frame_channel.rs:376` (inside `InboundFrame::contiguous`) and
`shm_provider.rs:611`, and a drained body never constructs an `InboundFrame`. So
drained bytes are invisible to the only transport-byte counter in the crate.

## Failure scenario

A peer authenticates, then loops: send a channel-0 `Request` header declaring
`len = 64 MiB - 1` with a strictly increasing correlation, send the 64 MiB, send
the next header. It never opens a route and never sends a legal control body.

Per cycle the host reads and discards 64 MiB through an 8 KiB scratch buffer,
holding zero ingress budget, and emits one small rejection frame. `available()`
on the ingress budget never moves, so every budget-derived signal and every
budget-based admission decision is blind to the traffic. The generation is not
retired: the watermark advances legally, the rejection emission succeeds so
`busy_rejects` never exhausts, and the drain completes inside the deadline as
long as the link is fast enough to move 64 MiB in under ~30 s.

Repeat on 64 connections and the host is doing sustained line-rate discard with
no resident-byte accounting and no counter that sees it. It is not a memory
exhaustion, which is exactly what the design intended to prevent. It is
unaccounted bandwidth and CPU.

The self-limiting case is worth stating too, because it constrains how bad this
gets: if the host is slow to emit the rejection, the deadline armed at the first
header byte is partly consumed before the drain starts, so the drain times out,
`drain_close` returns `Corrupt("drain deadline expired")`
(`tcp_frame_channel.rs:296-298`), `recv` converts it to `RejectedDrainFailed`
(`:110`), and `read_loop` closes the generation while preserving the one queued
terminal (`connection.rs:401-410`). So the loop only sustains against a healthy
host.

## Timing windows and dependencies

The load-bearing timing fact is that the deadline is armed at the *first header
byte* and not at the drain's start, and that the rejection emission happens
between the two `recv` calls. So the drain window is
`frame_deadline - (header read time + one read_loop iteration + emission time)`.
That coupling is not stated anywhere and is what makes the property
self-limiting under host slowness.

Configuration dependencies, all default-path: `frame_deadline` 30 s
(`config.rs:224`), `max_connections` 64 (`config.rs:129`),
`MAX_INFLIGHT_BUSY_REJECTS` 32 (`connection.rs:53`, not configurable),
`MAX_BODY_LEN` 64 MiB (`wire.rs:35`, not configurable).

## What a test must construct

The zero-budget property already has a check (`tcp_frame_channel.rs:772-808`),
and it is a good one: the budget is deliberately set to 1024 bytes, far below the
declared body, so any attempt to charge or allocate would hang, and the
successful drain plus the `:803-807` assertion proves the bytes were discarded
unbuffered. What is missing is the sustained case and the bound:

1. **Cycle repetition.** Extend the `receiver_over` harness to write N
   consecutive oversize declarations with increasing correlations, each followed
   by its declared bytes, and a final legal `Goodbye`. Assert N
   `InboundEvent::Rejected` events, then the `Goodbye`, then
   `budget.available() == starting value` after every cycle rather than only at
   the end. Aggregate equality at the end can hide a charge that was taken and
   released.
2. **The deadline as the stated bound.** Under
   `#[tokio::test(start_paused = true)]`, deliver the header, advance the clock
   to just under `frame_deadline`, deliver the body, and assert the drain
   succeeds; then repeat advancing past it and assert
   `Corrupt("drain deadline expired")` via `RejectedDrainFailed`. That pins the
   deadline-armed-at-first-header-byte coupling, which is currently implicit.
3. **Declared size at the real ceiling.** The existing tests use
   `MAX_CONTROL_BODY_LEN + 5`, `+ 7`, and `+ 9` (`:734`, `:786`, `:820`), all
   just over the floor. A case at `MAX_BODY_LEN` would document that the ceiling
   is the framing maximum, not the control cap. It costs 64 MiB through a duplex
   pipe, so it belongs in a slower job or with a scaled-down constant if one is
   introduced.

None of these decides the open question, which is a policy call: whether
unbudgeted discard is acceptable. A test can only pin the bound that exists.

## Investigation log

### Q: What is the actual ceiling on bytes discarded per oversize frame?

- Sources examined: `tcp_frame_channel.rs:196` (validation call site),
  `:198-202` (the oversize branch), `frame_channel.rs:58-61`
  (`validate_inbound_header`'s length check), `wire.rs:35`, `:371`, `:374`.
- Findings: `MAX_BODY_LEN`, 64 MiB. `validate_inbound_header` runs first and
  rejects only above the framing maximum; the oversize branch then triggers
  anywhere above `MAX_CONTROL_BODY_LEN`. So the control cap is the trigger floor
  and 64 MiB is the work ceiling.
- Missing evidence: none.
- Conclusion: resolved, and it corrects the framing in the gap description. "Up
  to the control cap of read-and-discard per frame" understates the ceiling by
  1024x.

### Q: Is the cost bound stated anywhere?

- Sources examined: `tcp_frame_channel.rs:1-13` (module doc), `:42-46`
  (`pending_drain` doc), `:107-111` (the drain-failure comment in `recv`),
  `:139-143` (`ReadEvent::OversizeControl` doc), `:199-200`, `:230-233`
  (`drain_declared_body` doc), `:292` (`drain_close` doc);
  `connection.rs:392-395`, `:418-442` (the rejection arm's comments);
  `frame_read.rs:96-97` (`drain` doc); `wire.rs:377-383` (`ByteBudget` doc).
- Findings: the *intent* is documented three times and is accurate. The deadline
  is named as the bound on one drain at `tcp_frame_channel.rs:44-46`. The
  `busy_rejects` semaphore's scope is stated correctly at
  `connection.rs:437-442` as bounding the emissions. Nothing states the
  aggregate: not the 64 MiB ceiling, not `max_connections` as the concurrency
  bound, not that the byte budget deliberately does not apply and what stands in
  for it.
- Missing evidence: the protocol document's §7.1 was not read. The code cites it
  four times (`tcp_frame_channel.rs:44`, `:139`, `:200`; `connection.rs:403`,
  `:436`) and it may state a cost bound the code does not repeat.
- Conclusion: unresolved, needs the protocol §7.1 text to confirm whether the
  bound is specified upstream of the code. The code-local answer is that it is
  not stated here.

### Q: Does anything observe the drained bytes?

- Sources examined: `grep -rn 'record_copy\|copies()' crates/mc-host/src/`,
  `frame_channel.rs:83-93` (`CopyCounter`), `:376`, `shm_provider.rs:611`,
  `frame_read.rs:98-125`.
- Findings: no. `record_copy` has two producers and neither is on the drain
  path; `drain` takes no counter argument at all. The only budget signal,
  `ByteBudget::available()` (`wire.rs:441-443`), is by design unmoved by this
  path.
- Missing evidence: metrics outside `mc-host` were not surveyed. A host-level
  byte counter in another crate could see the socket traffic even if this crate
  cannot attribute it.
- Conclusion: resolved within this crate. No signal in `mc-host` observes drained
  bytes, which is why the record carries a second open question about counting
  the cycle.
