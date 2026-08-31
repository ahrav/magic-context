# iceoryx-completion-is-observable-to-the-host

## Citation refresh, 2026-08-30

The ring-transport refactor (`0f336d3c`, `d8bde128`, `793a973e`, `ed487e11`)
renamed `crates/mc-host/src/shm_provider.rs` to
`crates/mc-host/src/ring_transport.rs` and deleted `provider_recovery.rs`,
`transport_negotiation.rs`, and `transport_provider.rs`. Host-side citations below
were re-anchored against `ring_transport.rs` at `e447c927`.

Where the cited construct survives, the citation names `ring_transport.rs` and a
line re-verified against that commit. Where it does not, the original reference is
kept and prefixed `former`, so it reads as pre-refactor evidence rather than a
current location. A `former` line number is never a claim about the tree today.
Every `provider_recovery.rs` reference is `former` by definition: that module has
no successor. See the refresh note in [../catalog.md](../catalog.md).

## Discovery trigger

An earlier pass characterized the iceoryx lease's `release` as a no-op. It is
not. `pub fn release(self) {}` (`backend/iceoryx.rs:349`) has an empty body, but
it takes `self` **by value**, so the closing brace runs the compiler-generated
drop glue for `IceoryxReceiveLease`, which drops its `sample: ByteSample` field
(`:320`), and iceoryx2's `Drop for Sample` calls
`receiver.release_offset(...)` (`iceoryx2-0.9.3/src/sample.rs:105-113`),
returning the chunk to the provider and freeing one borrow slot. The reclamation
is real. What the call does not do is anything else: it validates no identity,
increments no counter, publishes no completion, and returns no error. That is the
property to catalog, because the ring's release does all four.

## Evidence trail

- **The cited mechanism is gone.** `0f336d3c` ("refactor(shm): collapse to fixed
  ring transport") deleted `crates/mc-shm-transport/src/backend/iceoryx.rs`,
  `crates/mc-shm-transport/tests/iceoryx.rs`, and the `iceoryx` Cargo feature, so
  `backend/mod.rs` now declares only `ring` and `sample`. Every `iceoryx.rs`
  citation below is kept as a record of what the removed backend did and did not
  guarantee, and resolves against `9c1eb4d1`, not HEAD. No successor backend
  exists in the tree.

- `backend/iceoryx.rs:319-355` — the whole lease. There is **no** `impl Drop`
  anywhere in the file, so `release(self)` and simply letting the lease fall out
  of scope are the same operation, byte for byte. Nothing distinguishes a
  completed lease from an abandoned one, and there is no second release to
  reject, because the move consumed the value.
- `backend/ring.rs:849-911` — the counterpart, for the difference. It takes an
  identity, then checks quarantine (`:850`), incarnation (`:853`), lane (`:856`),
  a zero sequence (`:860`), `sequence <= consumed` (`:867-870`), and three
  descriptor fields re-read from shared memory (`:875-884`), before the
  arbitrating compare-exchange at `:886-893` maps a second attempt to
  `DuplicateRelease` (`:894-902`). Only then does it store
  `completion_sequence` and decrement `active_leases` (`:904-908`).
- `crates/mc-shm-transport/src/lease.rs:198-206`, `:215-221` — the ring lease
  also carries a local `released` flag and a `Drop` that calls `release_once`, so
  an abandoned ring lease still completes and a duplicate is still named. The
  iceoryx lease has neither, so those two obligations are met by move semantics
  rather than by a check, which is sound but silent.
- `backend/ring.rs:914-997` `conservation` and `:1000-1005` `probe` — the ring's
  entire reporting surface: per-slot descriptor counts across six states and
  per-state byte charges. `backend/iceoryx.rs` has no equivalent. It exposes
  `try_reserve`, `try_receive`, and the associated `stale_node_observed`
  (`:177-188`), and nothing else. A caller cannot ask it how many samples are
  outstanding, how many bytes are charged, or whether it is healthy.
- former `crates/mc-host/src/provider_recovery.rs:530` — readiness is decided by
  `shared.backend.probe() && shared.backend.admission_fits()`. There is no
  iceoryx path into that predicate, because there is no iceoryx `probe`.
- `backend/iceoryx.rs:178-189` `stale_node_observed` is the only observation the
  backend offers, and its own doc comment scopes it: it "reports a
  `NodeState::Dead` without performing cleanup or creating ports or services".
  It is a process-wide `Node::list` walk over the whole host, keyed to nothing
  about this backend's samples, so it cannot answer a question about this
  channel's outstanding leases.
- `benches/hardware_envelope.rs:597` — `run_iceoryx` returns
  `Ok((start.elapsed(), 0, 0, 0, 0, checksum))`. All five operation counters are
  literal zeros written by hand, not observations. `:177` dispatches the
  `iceoryx_0_9_3` arm into that function, `:186-197` copies those zeros into
  `OperationCounters`, and `:198` computes `disqualifications`, which is
  therefore empty. `:219` and `:256` then set
  `selectable: matches!(arm, "ring" | "iceoryx_0_9_3")`.
- `benches/manifests/v1.json:107-110` lists `ring` and `iceoryx_0_9_3` as the two
  `selectable` arms, and `:143-153` names all six counter fields as
  `required_counter_fields` for the selection gate. The gate's required inputs
  are supplied as constants on this arm.
- `benches/hardware_envelope.rs:141` — the bench's own report labels the arm
  `loopback_smoke_arms: ["iceoryx_0_9_3"]`, distinct from the nine
  `paired_process_arms` at `:140`.

## Failure scenario

A host that adopted this backend would have no way to observe reclamation, and
the release gate would not notice. Concretely: a caller that drops an
`IceoryxReceiveLease` on a cancellation path reclaims the sample correctly and
produces no record of it, so the outcome is identical to a caller that leaks the
lease into a long-lived collection — up to the borrow cap, at which point the
symptom surfaces on the *other* side as `ReceiveFailed` from
`ExceedsMaxBorrows`, attributed to the receive mechanism rather than to the
retained leases. There is no counter to check and no snapshot to compare, so the
diagnosis has no evidence.

The measurement half is live today rather than latent. The arm reports zero body
copies, zero allocations, zero syscalls, and zero park-wakes because those are
the literal values at `:597`, and on that basis it is marked selectable. A copy
introduced anywhere in `run_iceoryx` would change none of them. This is the same
shape as `operation-counters-are-observed-not-declared`, but stricter: on the
ring arm the counters are at least derived from parameters, and here they are
constants.

## Timing windows and dependencies

No window and no fault. The absent surface is a static fact about the module, and
the hardcoded counters are a static fact about the bench. The only dependency is
the `iceoryx` feature, which is **on by default** for the transport crate
(`crates/mc-shm-transport/Cargo.toml:9-10`) and off for both consumers, since
`crates/mc-host/Cargo.toml:25` and `packages/mc-shm-native/Cargo.toml:16` both
set `default-features = false`. So the backend and this bench arm compile
whenever the transport crate is built or tested on its own, and are absent from
every artifact the host or the addon ships.

## What a test must construct

Nothing exotic; two static assertions and one behavioural one. First, assert on
the bench report that every arm marked `selectable` produced its counters from an
observation on its own path — the negative control is to add a body copy inside
`run_iceoryx` and require `body_copies` to rise; today it stays zero. Second,
assert the iceoryx backend exposes a readiness and conservation observation with
the same shape the recovery predicate at former `provider_recovery.rs:530` consumes, or
assert the arm is not selectable without one. Third, for the completion half:
take `max_leases` leases, drop half by scope exit and release the rest
explicitly, and assert the two disposals are equivalent *and* that some
observation distinguishes outstanding from reclaimed. The third assertion cannot
be written against the current surface, which is the finding. Coverage check to
emit: `shm_iceoryx_lease_abandoned_without_release`.

## Investigation log

### Q: What does `release(self)` actually do, and can the host's accounting consume anything the iceoryx path produces?

- Sources examined: `backend/iceoryx.rs:319-355`, `:178-189`, and the whole file
  searched for `impl Drop`, `conservation`, `probe`, and `quarantine`, all
  absent; `backend/ring.rs:849-911`, `:914-1005`;
  `crates/mc-shm-transport/src/lease.rs:198-221`;
  former `crates/mc-host/src/provider_recovery.rs:530`;
  `benches/hardware_envelope.rs:141`, `:177`, `:186-260`, `:531-598`;
  `benches/manifests/v1.json:100-155`; and
  `iceoryx2-0.9.3/src/sample.rs:105-113`.
- Findings: `release(self)` performs a real reclamation through drop glue, not a
  no-op, and it is exactly equivalent to dropping the lease. Move semantics give
  exactly-once completion for free, so the ring's `DuplicateRelease` concern does
  not arise here. Everything else the ring's release provides — identity
  authority, a completion publication, an error on a wrong or stale identity, and
  a decrementable outstanding count — is absent, and so is the conservation and
  probe surface the host reads. The bench arm supplies the gate's required
  counters as constants and is nonetheless selectable.
- Missing evidence: whether `selectable: true` on this arm is deliberate given
  that the same report classifies it as a loopback smoke arm at `:141`. The
  manifest's `selectable` list and the report's arm classification disagree in
  intent, and nothing reconciles them.
- Conclusion: resolved with answer, and the discovery input's "no-op"
  characterization is corrected. The exactly-once and reclamation halves hold by
  construction; the observability half does not exist.
