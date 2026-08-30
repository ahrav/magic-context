# iceoryx-descriptor-rejection-is-terminal-or-declared

## Discovery trigger

The ring treats a descriptor that fails validation as a condemnation, not an
error return: `try_receive` calls `enter_quarantine()` before it returns
(`backend/ring.rs:804-810`, the call at `:807`), and quarantine is terminal, so
every later operation fails closed. The iceoryx backend is presented as a second
implementation of the same transport contract, and the natural parity question is
what it does at the same point. It returns one error variant and changes no
state. Asking that question forced the wider ledger below, because the answer is
not "a weaker gate" but "no gate exists to weaken".

## Evidence trail

- `backend/mod.rs:1-9` — the whole module: a doc comment claiming "Backends use
  same direct producer and scoped receive ownership", a `#[cfg(feature =
  "iceoryx")]` declaration of `iceoryx` (`:3-5`), and declarations of `ring`
  (`:7`) and `sample` (`:9`). There is **no trait**. The shared contract is a
  prose assertion, so nothing below is a compile error and no signature forces
  the two backends to answer the same question.
- The five named guarantees, checked one at a time against
  `crates/mc-shm-transport/src/backend/iceoryx.rs`:
  - **Sequence monotonicity — owed and provided, on a weaker basis.** `commit`
    derives `next_publish + 1` (`:266-271`) and `try_receive` requires exactly
    `next_receive + 1` (`:158-167` via `backend/sample.rs:100-102`). Both cursors
    are `Cell<u64>` fields (`:43-44`) initialized to zero (`:114-115`); the ring
    reads its equivalents from shared pages (`ring.rs:677`, `:779`).
  - **Release identity validation — structurally absent.** `release(self)`
    (`:349`) accepts no argument. `Ring::release(identity)` (`ring.rs:847-909`)
    checks quarantine, incarnation, lane, a zero sequence, `sequence <=
    consumed`, and three descriptor fields re-read from shared memory before its
    compare-exchange. No iceoryx call site can present a wrong, stale, or
    duplicate identity, so `LeaseError::DuplicateRelease`, `WrongIncarnation`,
    `WrongLane`, and `InvalidSequence` have no analogue and no need for one.
  - **Incarnation fencing — present as a comparison, fencing nothing.**
    `sample.rs:94-96` rejects a mismatched incarnation, but the expected value is
    minted locally by `Incarnation::random()` (`:56`, `descriptor.rs:227-231`) and
    read back from `self.incarnation` at `:163`. It is never exchanged, so it
    separates no two participants.
  - **Quarantine — absent.** The file contains no occurrence of `quarantine`, and
    no `impl Drop` at all: its only `impl` blocks are the three inherent blocks at
    `:48`, `:209`, `:327` and the `fmt` and `Error` impls at `:192`, `:306`,
    `:357`, `:378`, `:384`, `:396`, `:421`, `:427`, `:443`. The ring's
    `enter_quarantine` (`ring.rs:1033-1038`) and `is_quarantined`
    (`:1041-1048`, defaulting to `true` on an unreadable page at `:1047`) gate
    `try_reserve` (`:670-672`), `try_receive` (`:765-767`), `release`
    (`:848-850`), `probe` (`:999-1001`), and `conservation` (`:913-924`).
    `IceoryxBackend::try_reserve` (`:121-144`) checks only `bound >
    MAX_FRAME_BYTES` (`:126-128`) and the loan (`:132-135`), and
    `try_receive` (`:150-157`) checks nothing before dequeuing.
  - **Conservation reporting — absent.** `ring.rs:912-995` reports per-slot
    descriptor counts and per-state byte charges; `:998-1003` `probe` is that
    snapshot reduced to a readiness answer, and it is what
    `crates/mc-host/src/provider_recovery.rs:530` consumes. The iceoryx backend
    exposes `try_reserve`, `try_receive`, and the associated
    `stale_node_observed` (`:178-189`), which enumerates global `NodeState::Dead`
    entries and is keyed to nothing about this instance's samples.
- `crates/mc-shm-transport/tests/iceoryx.rs` — seven tests, every one
  same-instance. The three that drive the backend end-to-end commit and then
  receive immediately (`:85-89`, `:114-117`, `:127-134`), so the rejection branch
  at `iceoryx.rs:167` never fires through the backend; the two decoder tests
  (`:164`, `:233`) reach `SamplePrefix` directly and never touch a backend.
- `crates/mc-shm-transport/Cargo.toml:8-10` — `default = ["iceoryx"]`, so the
  backend compiles whenever the transport crate is built on its own, while
  `crates/mc-host/Cargo.toml:25` and `packages/mc-shm-native/Cargo.toml:13` both
  set `default-features = false`, so no shipped artifact contains it.

## Failure scenario

A sample arrives whose prefix disagrees with the local expectation.
`SamplePrefix::validate` fails on one of nine `DescriptorError` causes,
`iceoryx.rs:165-167` collapses all nine into `InvalidDescriptor`, the sample has
already been dequeued at `:151-157`, and `next_receive` is not advanced because
`:168` sits after the `?`. On the ring the same event condemns the object; here
the backend is in exactly the state it was in before, so `try_reserve` still
succeeds, `commit` still publishes, and the caller's only signal is one opaque
error it may retry forever. Nothing in the module can be asked whether the
channel is still trustworthy, and nothing records that a frame was rejected. The
producer keeps consuming loan capacity for frames the receiver will never accept.

## Timing windows and dependencies

No window: the absence is a static property of the module, and the post-rejection
state is absorbing, because the only writer of `next_receive` is the success
branch of the call that now fails. What is not static is whether the trigger is
reachable at all. Under the compiled configuration it is not: the loopback
publisher always writes the sequence the receiver expects. Two enabling states
open it. First, an external `iceoryx2.toml` (`iceoryx2-0.9.3/src/config.rs:95`,
resolved at `:719-752`) setting `backpressure_strategy` to `DiscardData` instead
of the `RetryUntilDelivered` default at `:344`: on a full subscriber buffer
`try_send` fails with `ReceiveBufferFull`, `src/port/details/sender.rs:264-271`
swallows it, `:318` returns `Ok(0)`, `iceoryx.rs:298-300` maps only `Err` so the
publication reads as success, and `:301` advances `next_publish` — a sequence gap
with no diagnostic. Second, fault class F2 aimed at the provider's shared
segment, which no harness models. The `iceoryx` feature is the only build
dependency, and the suite does execute: `.github/workflows/ci.yml:166` under the
Linux guard at `:164` runs `cargo nextest run -p mc-shm-native -p
mc-shm-transport`, which enables the transport crate's default features.

## What a test must construct

A rejection through the public receive path, then an assertion about what the
backend accepts afterwards. The cheapest constructor is the `DiscardData` gap
above: set the strategy, publish past the subscriber buffer bound without
receiving so one frame is dropped while `next_publish` advances, publish once
more, and assert the receive fails. The oracle is the second half, not the
first: after that failure, either every later `try_reserve` and `try_receive`
reports a terminal state, or the backend exposes an observation saying the stream
was broken. Neither can be asserted against the current surface, which is the
finding — there is no gate to check and no snapshot to read, so the honest test
today is the static parity assertion that no backend marked `selectable` in
`benches/manifests/v1.json:107-110` lacks a terminal state and a conservation
observation. Coverage checks, preconditions rather than violations:
`shm_iceoryx_sample_rejected_through_backend` and
`shm_iceoryx_operation_attempted_after_rejection`.

## Investigation log

### Q: Which of the ring's five named guarantees does the iceoryx backend also owe, and which does it structurally not provide?

- Sources examined: `backend/mod.rs:1-9` in full; `backend/iceoryx.rs` in full,
  searched for `quarantine`, `conservation`, `completion`, `active_leases`, and
  `Drop`, all zero hits; `backend/ring.rs:662-700`, `:759-810`, `:847-1003`,
  `:1032-1048`; `backend/sample.rs:83-127`; `descriptor.rs:227-231`;
  `crates/mc-host/src/provider_recovery.rs:526-533`;
  `crates/mc-shm-transport/tests/iceoryx.rs` in full; the three `Cargo.toml`
  files; `.github/workflows/ci.yml:154-183`; and in vendored iceoryx2 0.9.3
  `src/config.rs:95`, `:314-347`, `:719-752` and
  `src/port/details/sender.rs:191-319`.
- Findings: two of the five are provided, three are not, and the reason differs
  in each case. Sequence monotonicity is enforced, on process-local state rather
  than shared state. Incarnation fencing exists as a comparison against a value
  that is never exchanged, so it discriminates nothing. Release identity
  validation is absent and does not need to exist, because the move in
  `release(self)` makes a wrong or duplicate identity unpresentable — the one
  place where the absence is sound rather than a gap. Quarantine and conservation
  reporting are absent with no substitute, and the missing trait in `mod.rs` is
  why that costs nothing at compile time.
- Missing evidence: whether the loopback shape is intended to be permanent. The
  parity ledger reads differently under each answer, and no repository file
  states one.
- Conclusion: resolved. Three of five guarantees are unmet; one of those three,
  release identity validation, is unmet harmlessly. The terminal-state gap is the
  one with a constructible failure, and its trigger is reachable only through an
  external provider configuration or an unmodelled fault, which is why the
  semantics are `always-or-unreached` rather than a claim of live risk.
