# Part 1 property catalog: shared-memory transport

Scope: `crates/mc-shm-transport`, `packages/mc-shm-native`. Boundary context
from `crates/mc-host/src/ring_transport.rs` is used where a transport property is
only observable through the host. The original scope line named
`crates/mc-host/src/{shm_provider,transport_negotiation,transport_provider,provider_recovery}.rs`;
`shm_provider.rs` was renamed to `ring_transport.rs` and the other three were
deleted.

Provenance and the external-reference list are in [../README.md](../README.md).
System `/local/home/ahrav/scratch/magic-context` at `9c1eb4d1`, 2026-08-29.

## Eventfd reconciliation pass, 2026-08-31

This catalog, `existing-checks.md`, and `fault-map.md` were reconciled against
HEAD `46278f47a` after PR #131 (merge `5d638e3e8`) replaced polling with sparse
eventfd delivery. The iceoryx2 backend, deleted earlier by `0f336d3c`, remains
absent at that HEAD: `crates/mc-shm-transport/src/backend/` holds only
`mod.rs`, `ring.rs`, and `sample.rs`. The interim status value
`superseded-by-refactor` is normalized to `invalidated`, the vocabulary
declared in [../METHOD.md](../METHOD.md). The seven records that carried it —
the five Group K iceoryx records, `custody-terminal-transition-exactly-once`,
and `clean-reclamation-is-reachable` — now read `Status: invalidated`, each
naming the removal commit. Record bodies are kept as the evidence of what the
removed mechanisms did and did not guarantee. A follow-up unit in the same
pass added Group N: seven records covering the doorbell delivery and
demand-paging mechanisms PR #131 introduced, discovered from that PR's own
fix history and verified against HEAD code.

## Citation refresh pass, 2026-08-30

A targeted refresh re-anchored this catalog's host-side citations after the
ring-transport refactor landed in `0f336d3c`, `d8bde128`, `793a973e`, and
`ed487e11`. Those commits renamed `crates/mc-host/src/shm_provider.rs` to
`crates/mc-host/src/ring_transport.rs` and deleted `provider_recovery.rs`,
`transport_negotiation.rs`, and `transport_provider.rs` outright. Host-side line
numbers were re-derived against `ring_transport.rs` at `e447c927`; no stale line
number was carried across.

Blast radius, verified by scanning for every reference to the four filenames in
both their fully-qualified and bare forms: **16 of 58 records** carry **24
path-bearing citations** to a removed or renamed file, plus at least 9 bare
`` `:NNN` `` continuation references inside those same records. The earlier
estimate of 7 records and 9 citations counted only the fully-qualified
`crates/mc-host/src/` form and missed every bare-filename citation.

Disposition of the 16 records:

- **12 re-pathed.** The cited construct survives inside `ring_transport.rs`, or
  the clause naming a deleted comparator was withdrawn, and every citation now
  names the current file and a re-verified line.
- **2 superseded.** `custody-terminal-transition-exactly-once` and
  `clean-reclamation-is-reachable` cite mechanisms with no successor anywhere in
  the tree: `CandidateCustody` and its phase machine, `ShmRecoveryBackend`,
  `CleanupOutcome`, `ProviderReadiness`, and provider incarnations are all gone.
  Both carry `Status: invalidated` (recorded at the time under the interim
  label `superseded-by-refactor`, normalized by the 2026-08-31 pass above) and
  an `Impact:` sentence naming the commit and the current owner of the
  obligation, if any.
- **2 reachability changes without a status change.**
  `quarantine-charge-transition-is-atomic` and `release-failure-is-observable`
  guard code that still exists in `crates/mc-shm-transport`, so the property
  remains valid; only its host driver is gone. Both move to
  `Reaches production: no` with the evidence stated in the record.

Two of the 12 re-pathed records changed substance rather than only line numbers,
because the refactor removed a branch the record described:
`dead-peer-charges-are-reclaimed-or-declared` and
`header-rejection-effect-does-not-depend-on-the-catching-layer` both used to
converge on `report_suspect` and quarantine; charges are now released
unconditionally at `crates/mc-host/src/ring_transport.rs:291`. Each record states
that.

`release-authority-bound-to-lease-ownership` was re-checked in substance, not just
re-pathed, because its `latent, not reachable` verdict rested on caller behaviour
the refactor rewrote. The verdict holds; see that record.

The remaining 42 records were checked and cite only live paths
(`crates/mc-shm-transport`, `packages/mc-shm-native`, `packages/plugin`,
`crates/mc-host/tests/`, and `docs/`); they were not modified.

This pass introduced the interim status value `superseded-by-refactor`, outside
the `active | invalidated` vocabulary declared in [../METHOD.md](../METHOD.md).
Resolved 2026-08-31: this catalog's vocabulary is normalized to METHOD's
`active | invalidated`, and every record that carried the interim value now
reads `invalidated` with the removal commit named. `part-2a-host-lifecycle`
still uses the interim value and is out of that pass's scope.

Not audited by that pass, and now closed by the sweep below: citations into
`crates/mc-shm-transport` and `packages/mc-shm-native` had also drifted, far more
widely than the three examples that pass reported.

## Transport-crate citation sweep, 2026-08-30

The refactor commits `0f336d3c`, `d8bde128`, `793a973e`, `ed487e11`, `d21cde26`,
`dde0c051`, `76cd6f41`, and `b5dc778e` edited the transport crate and the addon
themselves, so this catalog's own line numbers disagreed with the evidence files,
which were swept first. This pass re-anchored them.

Method: every citation into `crates/mc-shm-transport` or `packages/mc-shm-native`
was resolved to a file, the cited lines were read at `9c1eb4d1` (the commit this
catalog was authored against), and the same byte-identical block was located at
`e447c927`. A citation was re-pathed only when its construct exists
byte-identically at the new location; every other case was escalated rather than
re-numbered. Eight cited files are unchanged upstream and their citations cannot
have drifted:
`arena.rs`, `lease.rs`, `harness.rs`, `lifecycle.rs`, `evidence.rs`,
`napi_buffers.rs`, `crates/mc-shm-transport/src/lib.rs`, and
`tests/fuzz_corpus.rs`; `backend/sample.rs` is also unchanged.

Counts: **263 line references checked.** 204 had drifted purely by line movement
and were re-anchored, each verified byte-identical at its new line. 2 named a test
the refactor renamed and were re-anchored with the new name and line. 21 point
into files the refactor deleted; 2 of those moved to `tests/contract.rs`, where
the coverage actually went, and 19 are kept as historical references inside Group
K. 4 name constructs the refactor deleted outright, and those drove the
record-level decisions recorded below rather than a new number. The remaining 32
were already
correct. Every re-anchored citation was cross-checked against the evidence file
for its record: where both name a line for the same construct they now agree, and
no re-anchored citation contradicts one.

`DESCRIPTOR_SCHEMA_VERSION` moved from 1 to 2 in this window
(`crates/mc-shm-transport/src/descriptor.rs:8`), and the descriptor lost its
`platform` field along with `OwnershipMode`, `BackendId`, `MemoryLayout`,
`RuntimeKind`, and `WorkloadClass`; `TransportDescriptor` now carries only
`schema_version`, `scheduling`, and `hardware` (`descriptor.rs:58-62`). No record
here asserted the literal version number or any of the removed fields — every
record names `DESCRIPTOR_SCHEMA_VERSION` symbolically — so the bump invalidated no
claim. Two consequences were checked rather than assumed.
`FrameDescriptor::validate` is byte-identical across the change and only moved,
from `descriptor.rs:348-362` at `9c1eb4d1` to `:223-237`, so
`identity-and-schema-rejection-is-one-contract`'s five-condition claim stands as
written. And the `.quarantine()` call sites cited by
`quarantine-charge-transition-is-atomic` are still `tests/contract.rs:368` and
`:479`, even though the `OwnershipMode::DirectLeased` line that used to sit at
`contract.rs:368` is gone; that citation needed no change.

Two citation targets outside the two named trees also drifted and are **reported,
not repaired**, because repairing them is a re-derivation rather than a sweep.
`docs/mc-host-shm-transport.md` was rewritten from 126 lines to 88, and 17 of the
19 line references this catalog makes into it no longer resolve to their cited
text. Those references carry documented guarantees, which METHOD.md rule 3 treats
as claims under test, so re-anchoring them means re-reading the rewritten spec
against 19 claims. That needs its own pass. The one exception handled here is
`packages/plugin/src/shared/mc-host-client/shm-grant.ts`, deleted outright: it was
one of the four artifacts in `one-profile-name-denotes-one-geometry`, so its
removal changes that record's subject and is recorded there.

## Product context, and what it does to priority

Shared memory here is explicit, test-only, and non-default. Host and client
production registries are empty, no backend or target profile has qualified on a
designated host, and TCP remains the production transport
(`docs/mc-host-shm-transport.md:5-7`). Two consequences run through every record
below:

1. Most of these properties are **latent** — they guard a path that no shipped
   configuration selects. That lowers urgency, not validity: the release gate
   (`benches/manifests/v1.json`) is what would make them live, and the catalog
   exists so that gate has something to check against.
2. A minority reach production through shared code — admission accounting in
   `mc-shm-transport::profile`, the panic boundary, and the wire and frame-channel
   validation in `mc-host`. Those are marked `Reaches production: yes`.

The measurement-integrity group (G) is the exception to the latency argument. It
does not guard the transport; it guards the *evidence* that would be used to
decide whether to ship the transport. A defect there is live today.

## Index

| Slug | Type | Confidence | Reaches production |
| --- | --- | --- | --- |
| [quarantine-authority-survives-peer-writes](#quarantine-authority-survives-peer-writes) | safety | high | no |
| [quarantine-gates-cover-every-storage-mutation](#quarantine-gates-cover-every-storage-mutation) | safety | high | no |
| [attach-refuses-a-quarantined-object](#attach-refuses-a-quarantined-object) | safety | high | no |
| [quarantine-charge-transition-is-atomic](#quarantine-charge-transition-is-atomic) | safety | high | yes |
| [charge-release-never-silently-strands](#charge-release-never-silently-strands) | safety | medium | yes |
| [custody-terminal-transition-exactly-once](#custody-terminal-transition-exactly-once) | safety | high | yes |
| [reservation-charge-visible-with-non-free-state](#reservation-charge-visible-with-non-free-state) | safety | high | no |
| [publication-visibility-derives-only-from-the-published-cursor](#publication-visibility-derives-only-from-the-published-cursor) | safety | high | no |
| [no-frame-observable-before-commit](#no-frame-observable-before-commit) | safety | high | no |
| [publish-signal-implies-committed-frame](#publish-signal-implies-committed-frame) | safety | medium | no |
| [release-authority-bound-to-lease-ownership](#release-authority-bound-to-lease-ownership) | safety | high | no |
| [release-exactly-once-per-sequence](#release-exactly-once-per-sequence) | safety | high | no |
| [receive-failure-leaves-no-wedged-slot](#receive-failure-leaves-no-wedged-slot) | safety | high | no |
| [release-failure-is-observable](#release-failure-is-observable) | liveness | medium | yes |
| [attach-reconciles-or-refuses-stale-shared-cursors](#attach-reconciles-or-refuses-stale-shared-cursors) | safety | high | no |
| [crashed-producer-does-not-wedge-the-sequence](#crashed-producer-does-not-wedge-the-sequence) | liveness | high | no |
| [dead-peer-charges-are-reclaimed-or-declared](#dead-peer-charges-are-reclaimed-or-declared) | safety | high | no |
| [cancelled-frame-disposition-is-declared](#cancelled-frame-disposition-is-declared) | safety | high | no |
| [validated-spans-are-disjoint-and-inside-the-arena](#validated-spans-are-disjoint-and-inside-the-arena) | safety | high | no |
| [no-rust-reference-over-peer-writable-payload](#no-rust-reference-over-peer-writable-payload) | safety | high | no |
| [reclaim-advance-bounded-by-the-producer-reservation](#reclaim-advance-bounded-by-the-producer-reservation) | safety | medium | no |
| [attach-binds-geometry-to-a-local-profile](#attach-binds-geometry-to-a-local-profile) | safety | high | no |
| [one-profile-name-denotes-one-geometry](#one-profile-name-denotes-one-geometry) | safety | high | no |
| [native-boundary-not-weaker-than-its-wrapper](#native-boundary-not-weaker-than-its-wrapper) | safety | high | no |
| [operation-counters-are-observed-not-declared](#operation-counters-are-observed-not-declared) | safety | high | evidence |
| [measured-transfer-is-witnessed-by-the-data](#measured-transfer-is-witnessed-by-the-data) | safety | high | evidence |
| [traceability-pointers-resolve](#traceability-pointers-resolve) | safety | high | evidence |
| [negative-tests-fail-for-their-stated-reason](#negative-tests-fail-for-their-stated-reason) | safety | high | evidence |
| [documented-close-order-has-a-production-driver](#documented-close-order-has-a-production-driver) | reachability | high | no |
| [capability-probe-gates-every-advertised-mechanism](#capability-probe-gates-every-advertised-mechanism) | safety | high | no |
| [clean-reclamation-is-reachable](#clean-reclamation-is-reachable) | reachability | high | no |
| [test-only-surface-absent-from-the-shipped-addon](#test-only-surface-absent-from-the-shipped-addon) | safety | high | yes |
| [decoder-totality-over-arbitrary-bytes](#decoder-totality-over-arbitrary-bytes) | safety | high | no |
| [accepted-decode-consumes-its-declared-width](#accepted-decode-consumes-its-declared-width) | safety | high | no |
| [identity-and-schema-rejection-is-one-contract](#identity-and-schema-rejection-is-one-contract) | safety | high | no |
| [grant-reserved-bytes-are-rejected-unless-zero](#grant-reserved-bytes-are-rejected-unless-zero) | safety | high | no |
| [fuzz-harness-encoding-tracks-the-production-descriptor](#fuzz-harness-encoding-tracks-the-production-descriptor) | safety | high | evidence |
| [macos-object-creation-outcome-is-attributed](#macos-object-creation-outcome-is-attributed) | reachability | medium | no |
| [attach-validation-is-not-platform-weakened](#attach-validation-is-not-platform-weakened) | safety | high | no |
| [macos-object-creation-leaks-no-shm-name](#macos-object-creation-leaks-no-shm-name) | safety | medium | no |
| [layout-region-offsets-are-real-page-aligned](#layout-region-offsets-are-real-page-aligned) | safety | high | no |
| [page-size-dependent-setup-runs-on-a-non-4096-page-host](#page-size-dependent-setup-runs-on-a-non-4096-page-host) | reachability | high | no |
| [iceoryx-descriptor-rejection-is-terminal-or-declared](#iceoryx-descriptor-rejection-is-terminal-or-declared) | safety | high | n/a — invalidated |
| [iceoryx-receive-expectation-tracks-the-delivered-stream](#iceoryx-receive-expectation-tracks-the-delivered-stream) | safety | high | n/a — invalidated |
| [iceoryx-cross-process-pairing-is-reachable-or-declared](#iceoryx-cross-process-pairing-is-reachable-or-declared) | reachability | high | n/a — invalidated |
| [iceoryx-completion-is-observable-to-the-host](#iceoryx-completion-is-observable-to-the-host) | safety | high | n/a — invalidated |
| [iceoryx-saturation-is-bounded-non-blocking-backpressure](#iceoryx-saturation-is-bounded-non-blocking-backpressure) | liveness | high | n/a — invalidated |
| [wire-header-fully-validated-before-any-consumer-acts](#wire-header-fully-validated-before-any-consumer-acts) | safety | high | yes |
| [ingress-charge-matches-the-bytes-copied-from-shared-storage](#ingress-charge-matches-the-bytes-copied-from-shared-storage) | safety | high | yes |
| [every-shm-header-consumer-applies-its-role-gate](#every-shm-header-consumer-applies-its-role-gate) | safety | medium | yes |
| [header-rejection-effect-does-not-depend-on-the-catching-layer](#header-rejection-effect-does-not-depend-on-the-catching-layer) | safety | high | no |
| [runtime-directory-authentication-is-a-precondition-not-a-container](#runtime-directory-authentication-is-a-precondition-not-a-container) | safety | high | no |
| [backpressure-converges-in-a-bounded-reclaim-window](#backpressure-converges-in-a-bounded-reclaim-window) | liveness | high | no |
| [receive-resumes-when-lease-capacity-clears](#receive-resumes-when-lease-capacity-clears) | liveness | high | no |
| [neither-direction-starves-the-other](#neither-direction-starves-the-other) | liveness | high | no |
| [reclamation-keeps-pace-with-completion](#reclamation-keeps-pace-with-completion) | liveness | high | no |
| [lease-saturation-is-reached-then-drains](#lease-saturation-is-reached-then-drains) | reachability | high | no |
| [duplex-overlap-is-reached](#duplex-overlap-is-reached) | reachability | high | no |
| [attach-validates-doorbell-eventfds](#attach-validates-doorbell-eventfds) | safety | high | yes |
| [wake-published-during-readiness-callback-is-not-lost](#wake-published-during-readiness-callback-is-not-lost) | liveness | high | yes |
| [queued-write-needs-no-second-wake](#queued-write-needs-no-second-wake) | liveness | high | yes |
| [released-charges-wake-blocked-readers](#released-charges-wake-blocked-readers) | liveness | medium | yes |
| [capacity-recheck-after-a-wake-race](#capacity-recheck-after-a-wake-race) | liveness | medium | yes |
| [reclamation-excludes-pages-with-live-wrapped-bytes](#reclamation-excludes-pages-with-live-wrapped-bytes) | safety | high | yes |
| [reactor-callback-is-one-in-flight](#reactor-callback-is-one-in-flight) | safety | high | yes |

---

## Group A: quarantine authority and terminality

Quarantine is the transport's terminal state. It is what converts "storage whose
alias state is unknown" into "storage that is never reused". Every claim about
charge retention and about not recycling uncertain memory depends on it holding.

### quarantine-authority-survives-peer-writes

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a peer that writes the lifecycle page directly; no
harness models a peer mutating control pages.
Guarantee: Once a direction is quarantined locally, no action by the peer can
make it accept a reserve, receive, or release again.
Check: `always` — after `enter_quarantine()`, for every peer-authored mutation
of the shared object including a zero store to the `quarantined` byte,
`try_reserve`, `try_receive`, `release`, and `probe` still return their
`Quarantined` variant. `always` fits because this must hold at every evaluation
for the lifetime of the mapping; there is no optional path and no eventual
convergence involved.
Fault/timing angle: the peer writes `0` to the flag between the host's
`enter_quarantine()` and its next gate read. The window is unbounded, because
the flag is re-read on every operation rather than latched.
Required faults and enabling state: a quarantine trigger (corrupt descriptor, or
a failed alias detach) **and** a peer that writes the shared lifecycle page
after it. Without the second, the check passes without testing anything.
Confidence: high — [evidence](evidence/quarantine-authority-survives-peer-writes.md).
Verified by inspection: the only store is to `LifecyclePage.quarantined` in the
shared mapping (`ring.rs:1373`), every gate re-reads it (`ring.rs:913`, `:1056`,
`:1176`, `:1251`, `:1337`), the `Ring` struct carries no local mirror, and both
`Mapping::create` and `Mapping::attach` map the whole object
`PROT_READ|PROT_WRITE` (`ring.rs:321`, `:342`) with required seals of
`F_SEAL_GROW|SHRINK|SEAL` only and no `F_SEAL_WRITE` (`ring.rs:2131`).
Existing check: `crates/mc-shm-transport/tests/ring.rs:240`
`quarantine_rejects_all_operations_and_reports_conservation` — covers
self-quarantine only, never a peer clearing the flag. Status unaudited.
Impact: a one-byte write by the peer un-terminates a channel the local side
condemned, defeating "permanently prevents that record's storage from being
reused" (`docs/mc-host-shm-transport.md:79`). Under the documented same-user
trust model this may be in-contract; the point is that it is unstated and
unchecked.
Open questions:

- Is the flag deliberately shared so the *peer* observes quarantine, and if so
  what protects the local decision? A local `Cell<bool>` OR'd into
  `is_quarantined()` would close this without a layout change.
- Does `docs/mc-host-shm-transport.md:116`'s explicit non-guarantee about
  malicious peers extend to control pages, or only to payload bytes? The text
  says payload. (needs human input)

### quarantine-gates-cover-every-storage-mutation

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a quarantine raised while a reservation is
outstanding.
Guarantee: Once a direction is quarantined, no further descriptor can be
published into it, including from a reservation acquired before the quarantine.
Check: `always` — hold a reservation, quarantine the ring, then assert
`commit(...)` fails and `published` is unchanged. Scope narrowed after review:
an earlier draft also required that an abort not restore `SLOT_FREE`. That
clause is dropped, because restoring a slot to free does not by itself permit
reuse while `try_reserve` remains gated on the quarantine flag
(`ring.rs:913-914`), so no independent harm from the abort path was established.
Fault/timing angle: the exact interleaving is producer-holds-reservation → peer
publishes a corrupt frame → the receiver's `try_receive` quarantines
(`ring.rs:1098`) → producer commits. Also reachable in the addon when
`quarantine_channel` fails partway and leaves producers registered.
Required faults and enabling state: an outstanding `ProducerReservation`
**and** a quarantine trigger from the other side during its lifetime.
Confidence: high — [evidence](evidence/quarantine-gates-cover-every-storage-mutation.md).
Verified by inspection: `try_reserve` (`ring.rs:913`), `try_receive`
(`ring.rs:1056`), `release` (`ring.rs:1176`), and `probe` (`ring.rs:1337`) gate on
`is_quarantined()`; `commit_reservation` (`ring.rs:1577-1627`) and
`abort_reservation` (`ring.rs:1563-1578`) have no gate.
Existing check: none.
Impact: publication into a ring whose storage is already considered
unrecyclable, and an abort that hands quarantined storage back to the free pool.
The abort path matters most where quarantine was raised *because* a JavaScript
alias may still be attached to the aborted range
(`packages/mc-shm-native/src/lib.rs:283-287`).
Open questions:

- Is "a reservation admitted before quarantine may still publish" the intended
  contract? If so it belongs in the documented close ordering, which currently
  reads as unconditional.

### attach-refuses-a-quarantined-object

Type: safety
Reachability: default-production — the client's default frame channel is
`ShmFrameChannel` over this addon
(`packages/plugin/src/shared/mc-host-client/connection.ts:396`); only a test
`channelFactory` bypasses it (`:392-393`). The host side is unconditional too
(`crates/mc-host/src/runtime.rs:741`), so the test-only framing above predates
the ring-transport refactor.
Status: active
Exercised: not yet — needs an attach against an already-quarantined object.
Guarantee: Attaching to a shared object whose lifecycle page is quarantined
fails at attach, before a channel id is issued or a process-wide grant claim is
consumed.
Check: `always` — quarantine a ring, re-derive its grant, attach, and assert
failure with `ACTIVE_GRANTS` unchanged and no registry entry created.
Fault/timing angle: a peer crash or a failed alias cleanup sets the flag, then a
reconnect or worker restart attaches. The channel looks usable and fails only at
first reserve or receive.
Required faults and enabling state: a quarantine trigger, then a fresh attach
using the same grant.
Confidence: high — [evidence](evidence/attach-refuses-a-quarantined-object.md).
Raised from medium after direct verification: `validate_lifecycle`
(`ring.rs:2067-2098`) reads exactly eight fields at `:2074-2085` — magic, layout
version, depth, arena, leases, total, incarnation, and lane — and compares them
at `:2086-2096`. It never reads `quarantined`. The per-operation gates are the
only readers of that flag.
Existing check: per-operation `is_quarantined()` guards only.
Impact: a caller receives a channel id and a usable-looking channel that fails at
first reserve or receive. The grant claim is held until the registry entry is
removed; `close` and `force_close` do remove it once producers, active leases,
and stranded aliases are all empty (`packages/mc-shm-native/src/lib.rs:1326-1329`,
`:1350-1352`), so the claim is pinned indefinitely only when a detach has already
stranded an alias. An earlier draft of this record overstated that as "for the
process lifetime".
Open questions: None. The question that opened this record — whether
`validate_lifecycle` reads the flag — is resolved by direct read.

---

## Group B: charge conservation

Admission charges are the transport's only backpressure against a host that
cannot afford another candidate. The documented contract is that admission,
cancellation, publication, completion, release, and quarantine conserve every
descriptor and byte charge exactly once. This group reaches production because
`profile.rs` accounting is shared code.

### quarantine-charge-transition-is-atomic

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Reaches production: no
Status: active
Exercised: not yet — needs `quarantined` pre-seeded near `u64::MAX` so the
`checked_add` fails.
Guarantee: A `quarantine()` that returns an error leaves the charges in exactly
one accounting bucket; charges never disappear from both `active` and
`quarantined`.
Check: `always-or-unreached` — force the `quarantined.checked_add` to overflow
and assert `active + quarantined` is unchanged from before the call. Semantics
revised from `always`: review established that a valid public execution cannot
reach the overflow, because admission checks `active + requested + quarantined`
against the host limits under the same mutex (`profile.rs:434-468`), so the sum
cannot approach the bound. The ordering defect is real and worth pinning, but it
is reachable only through a synthetic seam, and the record says so rather than
implying a live path.
Fault/timing angle: no concurrency needed. The transition decrements `active`
first and then performs a fallible add, with an early return between them.
Required faults and enabling state: an accounting state where
`quarantined + retained` overflows, or an injected failure at that point.
Confidence: high — [evidence](evidence/quarantine-charge-transition-is-atomic.md).
Verified by direct read of `crates/mc-shm-transport/src/profile.rs:522-542`:
line 527-530 sets `accounting.active = active.checked_sub(charges)?`, then line
537-540 sets `accounting.quarantined = quarantined.checked_add(retained)?` with
`.ok_or(AdmissionError::ChargeOverflow)?`. On that error path `active` has
already been reduced and `quarantined` is never raised. The host caller that
discarded the error, `provider_recovery.rs:187`'s `admission.quarantine().ok()`,
was deleted by the ring-transport refactor. `Admission::quarantine` now has no
non-test caller anywhere in the tree; the only two call sites are
`crates/mc-shm-transport/tests/contract.rs:368` and `:479`. The ordering defect
is unchanged, so the record stays active, but it moved from
`Reaches production: yes` to `no`.
Existing check: `crates/mc-shm-transport/tests/contract.rs:349`
`host_admission_retains_quarantined_commitments` — asserts the success path
only. Status unaudited.
Impact: charges vanish from both counters, so the operator-visible snapshot
under-reports and the admission budget silently over-admits later. Directly
contradicts "quarantine retains the exact charges" and "charges stay visible"
(`docs/mc-host-shm-transport.md:79`, `:90`, `:112`).
Open questions: None.

### charge-release-never-silently-strands

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Reaches production: yes
Status: active
Exercised: not yet — needs a poisoned accounting mutex and an inconsistent
`active` value.
Guarantee: Every `Admission` that is dropped or released has its charges either
subtracted from `active` or explicitly moved to `quarantined`; a silent no-op is
a defect.
Check: `always` — assert `active == ZERO` once all admissions are dropped,
including under a poisoned mutex and under a deliberately inconsistent `active`.
Fault/timing angle: a panic while holding the accounting lock poisons it; a
mismatched or double release makes `checked_sub` fail.
Required faults and enabling state: lock poisoning, or an arithmetic
inconsistency in `active`.
Confidence: medium — [evidence](evidence/charge-release-never-silently-strands.md).
Reported basis: `profile.rs:511-521` returns early on a poisoned lock and
performs the subtraction inside `if let Some(active) = ...checked_sub(charges)`,
so both failures are silent, while `Drop` still marks the state `Released`
(`profile.rs:581-588`). I verified the analogous pattern in `quarantine()` by
direct read, but not the `release()` body itself.
Existing check: none.
Impact: `active` diverges permanently from the live set, so admission refuses
candidates the host can afford, or accepts ones it cannot.
Open questions:

- Under what conditions can `checked_sub` actually fail here? If it is
  unreachable, this becomes `always-or-unreached` plus a reachability check
  rather than a live risk. (partial: the arithmetic is reachable only through a
  charge mismatch, and no path constructing one has been identified)

### custody-terminal-transition-exactly-once

Type: safety
Reachability: test-only — when live, `CandidateCustody` and
`ShmRecoveryBackend` sat behind the negotiated-transport provider registry,
which shipped empty, so only tests drove custody. Invalidated rather than live:
the phase machine, the backend, and provider incarnations are all deleted, and
`crates/mc-host/src/ring_transport.rs:291` now releases charges
unconditionally.
Reaches production: no
Status: invalidated
Exercised: not yet — needs a release carrying a superseded provider incarnation.
Guarantee: Each candidate's charges are released or quarantined exactly once,
and a stale release is rejected without touching aggregate counters.
Check: `always` — `release(); assert!(!release()); assert!(!quarantine())` and
the reverse order; plus a release carrying an old provider incarnation is
rejected while the phase is still `Active`.
Fault/timing angle: the endpoint thread calling `custody.release()` concurrently
with the deadline watcher calling `quarantine()`. The losing race was invisible
because the return value was discarded at the former
`crates/mc-host/src/shm_provider.rs:365`. Both sides of that race are gone: there
is no deadline watcher and no second terminal transition.
Required faults and enabling state: two terminal transitions racing, or an
incarnation bump between admission and release. Neither is constructible now.
Confidence: high — [evidence](evidence/custody-terminal-transition-exactly-once.md).
The phase clause was enforced by `mem::replace` in the former
`crates/mc-host/src/provider_recovery.rs:167-197`.
The incarnation clause was revised after review. `CandidateCustody::release`
took no incarnation argument at all, so there was no input that could carry a
stale one, and the recovery contract deliberately kept existing committed
candidates valid across readiness changes (former `provider_recovery.rs:15-16`).
The finding was therefore a **documentation-versus-API mismatch**, not an
unenforced runtime check: `docs/mc-host-shm-transport.md:79` describes rejecting
releases "carrying an old provider incarnation", and the API had no such concept.
`admitted_incarnation()` was stored (former `:143`) and exposed (former `:153`)
with tests as its only readers.
Existing check: none. The covering test was
`custody_releases_exactly_once_and_rejects_stale_releases` at the former
`crates/mc-host/src/provider_recovery.rs:811`, deleted with its module.
Impact: `ed487e11` deleted `provider_recovery.rs` and with it `CandidateCustody`,
its `Active`/`Released`/`Quarantined` phase machine, and every caller, so no
construct now owns the exactly-once terminal-transition obligation; the surviving
host path holds one `Admission` and calls the infallible
`Admission::release` once on the endpoint thread
(`crates/mc-host/src/ring_transport.rs:291`), which removes the race rather than
arbitrating it. The documentation half of the finding still stands and is now
strictly a doc defect: `docs/mc-host-shm-transport.md:79` describes an
incarnation-bearing release protocol that never existed and whose surrounding
machinery has since been removed.
Open questions:

- Does the documented sentence describe intended future behaviour, or is it
  simply wrong and should be deleted? Adding an incarnation-bearing release
  protocol would be a real design change, so this needs an owner's decision
  rather than a code fix. (needs human input)
- Resolved 2026-08-31: a record whose mechanism no longer exists is marked
  `invalidated` per the METHOD schema. The interim `superseded-by-refactor`
  value is retired from this catalog; see the eventfd reconciliation pass at
  the top of this file.

### reservation-charge-visible-with-non-free-state

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a cross-process observer calling `conservation()`
concurrently with a reservation.
Guarantee: Whenever an observer sees a descriptor slot in a non-`FREE` state,
the `reservation_len` it reads is that slot's current charge.
Check: `always` — for every slot, `state != SLOT_FREE` implies
`reservation_len` equals the `allocation_len` of the reservation that owns it.
Instrument `conservation()` to cross-check the descriptor's `allocation_len` for
published and leased slots.
Fault/timing angle: the window is between the state CAS and the length store,
with a fallible arena-planning step in between that can early-return.
Required faults and enabling state: an observer reading slot state during an
in-progress reservation. Single-threaded tests between operations cannot
construct it.
Confidence: high — [evidence](evidence/reservation-charge-visible-with-non-free-state.md).
Verified by direct read. `try_reserve` performs the
`SLOT_FREE → SLOT_PRODUCER_RESERVED` compare-exchange at
`ring.rs:693-703`, then plans the arena at `:708-720` (which returns early at
`:712` and `:717`), and only then stores `reservation_len` at `:722-726`. The
SAFETY comment at `ring.rs:934` states the opposite: "reservation length is
atomic and assigned before non-free state is observed." The comment and the code
disagree.
Existing check: the `conservation` byte assertions in
`crates/mc-shm-transport/tests/ring.rs:131-133`, `:197-201`, `:231-234`. They
run single-threaded between operations, and `bytes.free` is computed as
`arena_bytes - charged` (`ring.rs:991-995`), which makes
`ArenaCounts::conserves` arithmetically self-satisfying. Status unaudited, and
the oracle is structurally weak.
Impact: byte accounting only, not memory safety. A concurrent observer
under-counts producer-reserved bytes. The larger finding is the contract-vs-code
contradiction in a SAFETY comment, which is exactly the kind of statement a
future reader will rely on.
Open questions:

- Which is wrong, the comment or the order? Either store `reservation_len`
  before the CAS, or stop trusting it in `conservation()`.
- Are `conservation()` and `probe()` test-only? If any cross-process production
  path will call them, this moves from latent to live.

---

## Group C: publication and visibility

The transport's core claim is that a receiver never acts on a frame the producer
has not finished writing. One release-acquire edge carries it.

### publication-visibility-derives-only-from-the-published-cursor

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a true cross-process race on weakly-ordered
hardware, or a model checker. No loom, shuttle, Miri, or ThreadSanitizer
configuration exists anywhere in the repository.
Guarantee: No reader derives the visibility of descriptor fields or payload
bytes from `DescriptorSlot::state` alone; the only publication edges are
`published` (producer to receiver) and `completion_sequence` (receiver to
producer).
Check: `always` — every load of `(*slot).state` is either preceded on the same
thread by an acquire load of `published` or `completion_sequence` covering that
sequence, or is followed by no read of the descriptor or arena bytes.
Fault/timing angle: `conservation()` or `probe()` invoked from the peer process
concurrently with a commit.
Required faults and enabling state: a concurrent cross-process reader, and
ideally a weakly-ordered target (aarch64 or Graviton) where the reordering is
observable rather than merely permitted.
Confidence: high — [evidence](evidence/publication-visibility-derives-only-from-the-published-cursor.md).
`commit_reservation` publishes in the order descriptor `write_volatile`, then
`state.store(SLOT_PUBLISHED, Relaxed)`, then `arena_write.store(Relaxed)`, then
`published.store(Release)` (`ring.rs:1615-1621`). A relaxed store forms no
release sequence, so the acquire load of `state` at `ring.rs:1269` synchronizes
with nothing. `reclaim_completed` does it correctly, gating on an acquire load of
`completion_sequence` (`ring.rs:1482`) before reading state (`:1485`) and the
descriptor (`:1489`).
Existing check: none. `two_process_zero_copy_exchange_uses_authenticated_grant`
(`tests/ring.rs:551`) is lockstep with a sleep and one frame; it cannot observe
a reordering window.
Impact: today `conservation()` never reads the descriptor, so this is a latent
hazard plus an accounting-accuracy bug rather than undefined behaviour. It
becomes unsoundness the moment any reader reaches descriptor or arena bytes from
slot state.
Open questions:

- Is the relaxed state store intentional, given `abort_reservation` and
  `reclaim_completed` use `Release` for the same field (`ring.rs:1554`, `:1572`)?
  If intentional, the reasoning belongs in the code.

### no-frame-observable-before-commit

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs an assertion that the receiver observes nothing
mid-reservation.
Guarantee: A receiver cannot acquire, validate, or lease any frame whose
producer has not committed.
Check: `always` — with a reservation open and payload bytes already written,
assert `try_receive()` returns `Ok(None)` and that no slot in
`PRODUCER_RESERVED` can win the `PUBLISHED → RECEIVER_HELD` compare-exchange.
Fault/timing angle: the producer writes payload bytes at reservation time,
before commit. So the property is "no descriptor path reaches those bytes", not
"the bytes are unwritten".
Required faults and enabling state: an open reservation with bytes written and a
receiver draining `try_receive` concurrently.
Confidence: high — [evidence](evidence/no-frame-observable-before-commit.md).
The only receive gate is `consumed != published` with `published` loaded acquire
(`ring.rs:1070-1073`), and `published.store(Release)` is the last write of commit.
A reserved-but-uncommitted slot is in `PRODUCER_RESERVED`, so the receive CAS
fails (`ring.rs:1081-1091`).
Existing check: partial — round-trip tests cover the positive direction; no test
asserts the negative.
Impact: this is the property the whole zero-copy design rests on. It looks sound
by construction; it is cataloged because nothing currently asserts the negative
case, and a future change to the receive gate would not fail any test.
Open questions: None.

### publish-signal-implies-committed-frame

Type: safety
Reachability: default-production — the client's default frame channel is
`ShmFrameChannel` over this addon
(`packages/plugin/src/shared/mc-host-client/connection.ts:396`); only a test
`channelFactory` bypasses it (`:392-393`). The host side is unconditional too
(`crates/mc-host/src/runtime.rs:741`), so the test-only framing above predates
the ring-transport refactor.
Status: active
Exercised: not yet — needs a commit failure injected after `before_publish` has
run.
Guarantee: A publication signal delivered to a sender implies the frame was
actually committed and is receivable.
Check: `always` — make `commit` fail after `before_publish` ran (underfill, wire
header mismatch, or an arena error) and assert the sender was not told the frame
published and the peer sees no frame.
Fault/timing angle: `before_publish` is invoked before `reservation.commit` on
both native paths, and the client sets `published = true` inside that hook. The
host instead stores `COMPLETE` after commit succeeds, so the two sides disagree
exactly on commit failure.
Required faults and enabling state: a commit that fails after the hook fires.
Confidence: medium — [evidence](evidence/publish-signal-implies-committed-frame.md).
The ordering is confirmed by the reported line references
(`packages/mc-shm-native/src/lib.rs:928-931`, `:1042-1045`;
`packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:296-321`;
`crates/mc-host/src/ring_transport.rs:584-591`). What "published" is contractually
supposed to mean to a client is not settled, which is why this is medium.
Existing check: `packages/mc-shm-native/tests/runtime.ts:108-127` asserts
producer aliases are detached *at* `before_publish`, pinning the hook's position
rather than commit success. Status unaudited.
Impact: a sender that believes a frame was published when it was not, with no
retry, on a transport whose failure mode is otherwise fail-closed.
Open questions:

- Does the client's `FrameSendTicket.cancel()`/`onPublish` contract mean "handed
  to the transport" or "committed"? The two differ only on commit failure.
  (needs human input)

---

## Group D: receive, release, and exactly-once completion

### release-authority-bound-to-lease-ownership

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a release issued by a party other than the lease
holder.
Guarantee: Only the holder of a receive lease can complete it; possession of a
frame's release identity does not by itself authorize completing that frame.
Check: `always` — with a live `ReceiveLease` over sequence N, a release of
identity N issued by any other party fails, the slot stays `RECEIVER_LEASED`,
and the arena bytes under the lease do not become reservable.
Fault/timing angle: the producer holds the identity of every frame it published,
because `commit` returns it. If it releases while the receiver's lease is live,
the slot moves to `RELEASE_PENDING`, the next `try_reserve` reclaims those bytes,
and the producer may write them while the receiver's `LeaseSpan` still points
there. The receiver's own `Drop` then gets `DuplicateRelease`, which is silently
discarded.
Required faults and enabling state: a live lease **and** a release from the
producer side using the identity returned by `commit`.
Confidence: high on the API shape, and the reachability question is now settled
as latent — [evidence](evidence/release-authority-bound-to-lease-ownership.md).
Verified by direct read of both signatures:
`pub fn release(&self, identity: ReleaseIdentity) -> Result<(), LeaseError>`
(`ring.rs:1175`) validates identity and slot state only, and
`pub fn commit(mut self, body_len: usize) -> Result<ReleaseIdentity, ProducerError>`
(`ring.rs:1769`) hands that identity to the producer. No role, owner, or
lease-token check exists on the release path.
Reachability verdict: **not reachable in the shipped two-process topology.**
Re-verified against `ring_transport.rs` at `e447c927, and again at post-#131 HEAD (2026-08-31)` after the refactor rewrote
every host-side producer path, because the verdict rests on caller behaviour that
the refactor could have changed. It did not. Every non-test `commit` caller still
discards the returned identity: all three host call sites put `commit` in
statement position under `?` (`ring_transport.rs:615` in `publish_direct`, `:628`
in `publish_owned`, `:696` in `RingClientEndpoint::send`), and the addon's two
call sites do the same (`packages/mc-shm-native/src/lib.rs:929-932`, `:1043-1046`).
The only non-test direct `Ring::release` is a receiver completing its own lease
(`lib.rs:327-331`, on the receive ring with an identity from `lease.identity()`
held in the addon's table because `poll` forgets the lease). And the two
directions are separate objects with independent random incarnations
(`DuplexRing::create`, `ring.rs:757`), so a cross-ring release fails the
incarnation check at `:1179-1184`. The violating composition is reachable only in
a same-process, single-`Ring` arrangement, which today means the transport's own
tests.
Existing check: none. The identity-validation tests
(`tests/ring.rs:152-175`, `:206`) all issue releases from the legitimate holder.
Impact: a latent API-shape hazard rather than a live defect. What keeps it worth
a record is that the composition is available rather than prevented, and in
`tests/ring.rs` the violating call sits one unmutated argument away from an
existing assertion. If a future caller retains a committed identity — for
instance to implement producer-side reclamation — this becomes a
read-after-recycle on leased bytes with no malformed input required.
Open questions:

- Should `Ring::release` remain public? There is a real constraint behind it:
  the addon needs lease-independent completion because `poll` forgets the lease
  and tracks the identity in its own table. So this is a design trade-off, not
  an oversight, and the answer belongs to whoever owns that seam.
  (needs human input)

### release-exactly-once-per-sequence

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs concurrent release attempts rather than sequential
ones.
Guarantee: Given a live lease, a correct identity, and a ring that is not
quarantined, exactly one release per `(incarnation, lane, sequence)` succeeds and
every later one fails.
Check: `always` — for any multiset of release calls carrying one identity, at
most one returns `Ok`, and `active_leases` is decremented at most once. The
preconditions are stated in the guarantee because "exactly one succeeds" is
false without them: zero succeed if the ring is quarantined, if the identity is
wrong, or if no lease was ever taken (`ring.rs:1176-1228`). The at-most-once half
is the invariant; the exactly-once half holds only under those preconditions.
Fault/timing angle: interleave `ReceiveLease::release()`, a direct
`Ring::release()`, and `Drop`. The compare-exchange
`RECEIVER_LEASED → RELEASE_PENDING` is the arbiter; the identity comparison
alone is not, because a stale identity can match a recycled slot's residual
descriptor bytes.
Required faults and enabling state: at least two release attempts for one
sequence, ideally concurrent.
Confidence: high — [evidence](evidence/release-exactly-once-per-sequence.md).
The CAS at `ring.rs:1212-1219` is the single mutation point, and
`DuplicateRelease` is mapped from observing `RELEASE_PENDING` or `FREE`
(`:1220-1227`).
Existing check: good coverage of the sequential cases —
`tests/ring.rs:153-178` (wrong incarnation, wrong lane, wrong sequence,
duplicate) and `tests/ring.rs:206`
`stale_lap_release_cannot_complete_recycled_slot`, a genuine full-lap test.
Status unaudited for the read-then-CAS window.
Impact: this is the load-bearing exactly-once guarantee for storage reuse. It is
cataloged as well-covered so that the *gap* — concurrency and the descriptor
re-read at `ring.rs:1201` not being atomic with the CAS at `:1213` — is explicit
rather than assumed.
Open questions: None.

### receive-failure-leaves-no-wedged-slot

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a failpoint on lease or span construction.
Guarantee: The error paths that follow the receive commit point are unreachable,
so no receive can leave a slot claimed but un-leased and un-quarantined.
Check: `unreachable` — assert the three post-commit-point failure branches in
`try_receive` are never entered. Semantics revised from `always-or-unreached`
after direct analysis: all three branches are provably unreachable given that
`validate` already succeeded on a 64-bit target, so the honest check is that the
forbidden points are never entered, not a conditional invariant over a state the
code cannot construct. If any branch ever becomes reachable, the wedge scenario
below is what happens, and the property should be re-derived as `always` at that
point.
Fault/timing angle: `try_receive` compare-exchanges
`PUBLISHED → RECEIVER_HELD` before validating. Descriptor-validation failure
quarantines; three later paths propagate with `?` and do not — span
materialization, the `body_len` usize conversion (`ring.rs:1119-1120`), and
`ReceiveLease::new`. Were the first reachable, it would leave the slot in
`RECEIVER_HELD` with `consumed` un-advanced, so every later `try_receive` would
fail its CAS with `InvalidSharedState` forever, un-quarantined. Were the third
reachable, it would fire after `state = RECEIVER_LEASED`, `consumed`, and
`active_leases += 1` are already committed, yielding a lease nobody can release.
Required faults and enabling state: none, because the property is now that the
branches are not entered. A synthetic failpoint would prove nothing about
production, since it would construct a state `validate` excludes.
Confidence: high — [evidence](evidence/receive-failure-leaves-no-wedged-slot.md).
Verified by inspection: `enter_quarantine` is called exactly once inside
`try_receive`, at `ring.rs:1098`, on the validation path only. Two independent
analyses then agreed that an accepted descriptor guarantees the span count and
bounds that both constructors check, so all three branches are dead given
`validate` on a 64-bit target.
Existing check: none.
Impact: as written, none in production — this is a correctness argument the code
does not state. The value of the record is that three `Result` paths exist for
conditions that cannot arise, and nothing marks them as such. A future change to
`validate` silently converts them from dead code into the wedge described above,
with no test covering the transition.
Open questions: None. The reachability question that opened this record is
resolved: all three branches are unreachable, which is why the semantics
changed.

### release-failure-is-observable

Type: liveness
Reachability: default-production — the host driver is back: the ring is built
unconditionally (`crates/mc-host/src/runtime.rs:741`) and prepared per
connection (`crates/mc-host/src/connection.rs:117`), so the `Reaches
production: no` line above, set when only the host driver was gone, no longer
describes this path.
Reaches production: no
Status: active
Exercised: not yet — needs an injected release failure on an otherwise clean
path.
Guarantee: A release or completion that fails is retried, reported, or surfaced;
never dropped silently.
Check: `always` — inject a release failure on the drop path and on the clean
close path, and assert that some counter, diagnostic, or suspect record fires.
Fault/timing angle: `ReceiveLease::Drop` calls `release_once()` and discards the
result, so a drop-time `WrongIncarnation`, `Quarantined`, or `DuplicateRelease`
is unobservable. The host half of this record is gone: `let _ =
custody.release()` no longer exists, and the suspect path it fell through to no
longer exists either.
Required faults and enabling state: a release that fails while the surrounding
operation is otherwise clean.
Confidence: medium — [evidence](evidence/release-failure-is-observable.md).
The surviving discard site is explicit
(`crates/mc-shm-transport/src/lease.rs:201-207`, verified unchanged). The former
host discard site `crates/mc-host/src/shm_provider.rs:365` was replaced by
`crates/mc-host/src/ring_transport.rs:276`, which calls
`Admission::release(mut self)` (`crates/mc-shm-transport/src/profile.rs:512`).
That signature returns `()`, so there is no longer a host-side result to discard
and no host-side clean-path release failure to observe; the silent-no-op risk
inside `AdmissionController::release` moved wholly into
`charge-release-never-silently-strands`. Whether `release()` can actually fail on
a clean close depends on `AdmissionError` reachability that was not fully traced,
which is why this is medium. Reachability moved to `no` because the remaining
discard is on the transport-side lease drop path, which no shipped configuration
selects.
Existing check: none. `recovery.report_suspect(custody)` was deleted with
`provider_recovery.rs`.
Impact: a stranded charge or an unreclaimed frame with no counter, no log, and
no suspect record. The operator learns nothing, and the arena bytes stay
unreclaimable.
Open questions:

- Is silent loss on the drop path intended, given the addon `mem::forget`s
  leases and releases through its own table instead?

---

## Group E: crash and cancellation

All receiver-side and producer-side cursors live in shared memory. Nothing
resets or reconciles them, so a crash is not a clean slate.

### attach-reconciles-or-refuses-stale-shared-cursors

Type: safety — revised from liveness after review. The check is evaluated at
attach time, and attach ignores the stale cursors immediately rather than failing
to converge later. The wedge that follows is the consequence, not the property.
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a receiver killed while holding leases, then a fresh
attach.
Guarantee: A process attaching to a shared object either reconciles stale
receiver state or refuses to attach; it never silently inherits leases and
descriptor slots that no live process owns.
Check: `always` — kill a receiver holding K leases, attach fresh, and assert
either the attach fails, or `active_leases == 0` and no slot remains in
`RECEIVER_LEASED`.
Fault/timing angle: kill with `K == max_leases` for the worst case: the channel
is dead and every symptom is a normal backpressure code.
Required faults and enabling state: an actual process termination while leases
are held — not a clean shutdown — followed by an attach.
Confidence: high — [evidence](evidence/attach-reconciles-or-refuses-stale-shared-cursors.md).
`Ring::attach` validates identity and geometry and wires the eventfd doorbells
(`ring.rs:783-798`, `:2067-2098`; the pre-#131 prefault step is gone); it never
inspects `published`, `consumed`,
`completed`, `arena_write`, `arena_reclaimed`, or `quarantined`. Reclamation
head-of-line blocks at the lowest stale sequence (`ring.rs:1482-1484`),
`try_receive` returns `Ok(None)` (`:1063-1067`), and `try_reserve` eventually
returns `Exhausted` (`:926-928`). None of these is an error, so no quarantine
and no recovery episode occurs.
Existing check: none.
Impact: permanent, silent loss of lease and descriptor capacity, reported as
ordinary backpressure. The `LifecyclePage` has no holder count, attach epoch,
heartbeat, or peer pid, so there is no field a reconciliation could read.
Open questions:

- Is a peer crash meant to be recoverable at all? If yes, something must reset
  the cursors or force quarantine; today it does neither. (needs human input)

### crashed-producer-does-not-wedge-the-sequence

Type: liveness
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a producer killed between reserve and commit.
Guarantee: A producer crash inside a reservation does not permanently prevent
any later producer from publishing.
Check: `always` — crash between `try_reserve` and `commit`, then assert a
replacement producer can eventually publish, or that the failure is reported as
a distinguishable fault rather than as backpressure.
Fault/timing angle: the next sequence is derived from `published + 1`, so a
replacement producer re-derives the same sequence, and its
`FREE → PRODUCER_RESERVED` CAS fails against the stranded
`PRODUCER_RESERVED` slot forever. The symptom is `ProducerError::Exhausted`
followed by `Deadline` — both backpressure codes.
Required faults and enabling state: termination during an open reservation.
Confidence: high — [evidence](evidence/crashed-producer-does-not-wedge-the-sequence.md).
`ring.rs:689-703` derives the sequence and performs the CAS; `abort_reservation`
(`:1156-1164`) is the only path that restores `SLOT_FREE` and it runs in `Drop`,
which a killed process never executes. `conservation()` still reports
`producer_reserved == 1` and conserves, so the accounting looks healthy.
Existing check: none.
Impact: a permanently unusable direction whose only signal is a code that means
"try again later".
Open questions: None.

### dead-peer-charges-are-reclaimed-or-declared

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: partial — `crates/mc-host/tests/shm_failure_modes.rs:213`
`setup_active_and_idle_sigkill_each_return_exact_capacity` constructs the
fault (SIGKILL with a required signal-9 wait status, `:154-158`) for setup,
active, and idle victims and witnesses the reclaim arm by readmission at a
one-connection cap. No per-identity charge ledger and no declared-exception
arm is asserted. The former pinning test
`killed_victim_holding_active_charges_is_never_reclaimed` no longer exists at
HEAD.
Guarantee: A peer that dies without a `Goodbye` either has its candidate's
charges reclaimed, or the retention is a declared, bounded exception rather than
an unqualified accounting claim.
Check: `always` — after killing and reaping a committed peer, either the
killed connection's exact charges return to free capacity once the
sentinel-triggered teardown completes, or the accounting snapshot exposes them
as a distinct "unreclaimable" class that the admission contract accounts for.
`always` because the obligation applies at every peer death, not at one code
point.
Fault/timing angle: under the eventfd mechanism a dead peer is pure silence.
It never signals `data_ready`, so the endpoint arms the data wait
(`crates/mc-host/src/ring_transport.rs:429`) and parks in the readiness select
(`:441-474`); the ring path alone never produces an error, a wake, or a
suspect, and a parked endpoint is indistinguishable from an idle one.
Detection is out of band: the setup socket is held open as the peer-lifetime
sentinel, and a non-`Goodbye` closure records a peer death and cancels the
generation (`crates/mc-host/src/connection.rs:180-190`), after which the
endpoint thread joins and `admission.release()` runs unconditionally
(`ring_transport.rs:276`). With outbound frames queued, the other path is
`reserve_until` parking on the `capacity_ready` doorbell and returning
`Deadline` at `frame_deadline`
(`crates/mc-shm-transport/src/backend/ring.rs:1035`, `:1043-1044`), which
fails the publish and cancels (`ring_transport.rs:479-483`). Both paths
converge on the same unconditional release; the pre-refactor
release-versus-suspect fork is gone.
Required faults and enabling state: an actual kill without `Goodbye`, plus a
committed candidate.
Confidence: high — [evidence](evidence/dead-peer-charges-are-reclaimed-or-declared.md).
The documented gap this record was opened against is gone from HEAD:
`docs/mc-host-shm-transport.md` is now 85 lines, states the sentinel contract
at `:49` ("Unexpected closure records peer death, cancels ring work, and tears
down the exact connection"), and no longer carries the retention paragraph
formerly at `:106-108` or the unqualified accounting claim formerly at `:57`.
The unconditional `admission.release()` introduced by `ed487e11` survives at
`ring_transport.rs:276`, reached after `run_endpoint` returns or panics
(`:264-274`).
Existing check: the SIGKILL test above. Status unaudited as an oracle for the
per-identity tuple: readmission at a one-connection cap witnesses that enough
capacity returned, not that the killed candidate's exact tuple did.
Impact: if release fails after a peer death, then with single-candidate limits
one dead peer permanently ends shared-memory eligibility for the process while
readiness still reports healthy — and under blocking eventfd waits nothing on
the ring path would ever surface it, because the endpoint parks silently
instead of visibly polling an empty ring.
Open questions:

- None open on the former release-versus-suspect fork: both close paths end in
  the unconditional `admission.release()` at `ring_transport.rs:276` at HEAD,
  which resolves that question by code change. What remains untested is the
  per-identity ledger oracle described in the evidence file.

### cancelled-frame-disposition-is-declared

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs cancellation injected exactly between a successful
`try_receive` and the delivery of its body.
Guarantee: Cancellation and overload have a declared disposition for an
already-acquired frame; a frame is not silently destroyed while the channel is
reported as closing cleanly.
Check: `always` — cancel between `try_receive` success and the ingress charge,
and assert the outcome matches the declared contract: either the frame is
delivered, or its loss is reported, or the contract explicitly permits the loss.
Fault/timing angle: `try_receive` advances `consumed` and marks
`RECEIVER_LEASED` before returning, so acquisition — not delivery — is the point
of no return. If the ingress wait then observes cancellation, the lease drops,
the slot is released and reclaimed, and the body never reaches `inbound`. The
sequence is permanently consumed with no replay path, and the close is
classified clean.
Required faults and enabling state: cancellation or overload arriving in that
exact window, with a frame already acquired.
Confidence: high — [evidence](evidence/cancelled-frame-disposition-is-declared.md).
`ring.rs:1115-1117` advances `consumed` before the lease is returned;
`lease.rs:201-207` releases on drop; `crates/mc-host/src/ring_transport.rs:524-527`
maps read cancellation inside the ingress-charge wait to `ReadClose::Cancelled`.
The former `shm_provider.rs:498` clean-versus-unclean classification is gone:
`run_endpoint` now returns `()` and every `ReadClose` takes the same path
(`ring_transport.rs:406-411`), so cancellation is still not branded corrupt but
the close is no longer classified at all. Commit `3bf6c22b` deliberately
made cancellation clean, which settles the charge question but not the frame's
disposition.
Existing check: none. Commit `3bf6c22b` asserts charges release cleanly, not
that the frame was accounted for.
Impact: silent single-frame loss on a channel whose documented failure posture is
fail-closed. If the channel is meant to be lossless up to close, `consumed`
advancing before delivery is the wrong commit point.
Open questions:

- Is losing one acquired-but-undelivered frame on cancel or overload an accepted
  contract term? (needs human input)

---

## Group F: hostile and buggy peer

The peer maps the entire object read-write, and the required seals are
`F_SEAL_GROW|SHRINK|SEAL` with no `F_SEAL_WRITE`. Every field below is
peer-writable at any time, including all control pages. The documentation
disclaims protection against a peer that mutates payload after publication; it
does not address control pages.

### validated-spans-are-disjoint-and-inside-the-arena

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs fuzzing with `arena_bytes > MAX_FRAME_BYTES`.
Guarantee: For any accepted frame, the spans are pairwise disjoint, both lie
inside the arena, and their lengths sum to the body length.
Check: `always` — for arbitrary untrusted field tuples and arbitrary
`arena_bytes >= MAX_FRAME_BYTES`, every accepted descriptor satisfies
`span0 ∩ span1 == ∅`.
Fault/timing angle: none; this is a pure decoding property. The exposure is that
disjointness is *derived*, not asserted.
Required faults and enabling state: attacker-controlled descriptor fields, and
an arena larger than the minimum so the derivation is actually exercised.
Confidence: high — [evidence](evidence/validated-spans-are-disjoint-and-inside-the-arena.md).
Disjointness follows only from three separate conditions holding together:
`spans[0]` ending exactly at `arena_bytes`, `spans[1].offset == 0`, and
`len0 + len1 == body_len <= allocation_len <= arena_bytes`
(`descriptor.rs:218`, `:238-244`, `:252-261`). Relaxing any one re-opens
overlap. The fuzz harness asserts per-span bounds and the sum but never pairwise
disjointness, and it only ever passes `arena_bytes == MAX_FRAME_BYTES`
(`harness.rs:69-81`).
Existing check: partial — `descriptor_rejects_every_untrusted_identity_and_span_failure`
(`tests/contract.rs:73`) and the `frame_descriptor` fuzz target. Status
unaudited; neither asserts disjointness.
Impact: two spans over the same bytes would pass validation, so a frame could
alias itself. Currently prevented by the conjunction, with nothing pinning it.
Open questions: None.

### no-rust-reference-over-peer-writable-payload

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a peer that mutates payload bytes after publication.
Guarantee: No lease API constructs a Rust reference or slice over arena bytes
the peer can still write; reads go through raw volatile access or raw copies.
Check: `always` — audit that every read path uses `read_volatile` or
`copy_nonoverlapping`, and assert no lease method creates a `&[u8]` over shared
arena memory.
Fault/timing angle: the peer rewrites body bytes during the read. Under Rust's
rules that is a data race and undefined behaviour, not merely a wrong value.
Required faults and enabling state: a concurrent peer write to leased bytes. The
property is violated statically, so the audit form needs no fault; the *impact*
demonstration does.
Confidence: high — [evidence](evidence/no-rust-reference-over-peer-writable-payload.md).
Verified by direct read of `crates/mc-shm-transport/src/lease.rs`:
`checksum` builds a slice with
`std::slice::from_raw_parts(self.base.as_ptr(), self.len)` at line 71, while
`copy_to` correctly uses `copy_nonoverlapping` at line 63 and `read_byte` uses
`read_volatile`. The SAFETY argument for the slice cites the peer *contract*,
and `docs/mc-host-shm-transport.md:116` explicitly declines to guarantee that
contract against a misbehaving peer.
Existing check: none.
Impact: one method's soundness rests on a premise the documentation disclaims,
while its siblings in the same file avoid the issue. Additionally
`LeaseSpan::as_mut_ptr` hands a mutable pointer out of a by-value receiver, and
the addon wires it into external buffers for *receive* segments too, so
JavaScript can write memory the host is concurrently reading.
Open questions:

- Is `checksum` reachable from any non-bench caller? If it is bench-only,
  gating it removes the finding; if it is part of the intended read API, the
  slice needs to go. (partial: the only observed call sites are the bench and
  tests)

### reclaim-advance-bounded-by-the-producer-reservation

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a peer rewriting the descriptor of a pending slot.
Guarantee: The producer's `arena_reclaimed` advances by exactly the length the
producer itself reserved for that sequence, never by a peer-chosen value.
Check: `always` — after the receiver releases, have the peer rewrite
`allocation_len` in the pending slot, then assert reclaim either rejects or
advances by the original reservation.
Fault/timing angle: the window between commit and `reclaim_completed` reading
the slot is unbounded. The only guard is `allocation_start == arena_reclaimed`,
which pins *where* the advance starts but not *how far* it goes.
Required faults and enabling state: a peer write to a `RELEASE_PENDING` slot's
descriptor between release and reclaim.
Confidence: medium — [evidence](evidence/reclaim-advance-bounded-by-the-producer-reservation.md).
Reclaim consumes the re-read `allocation_len` (`ring.rs:1548-1556`) with only
the FIFO start check (`:1498-1500`). Both candidate records — the descriptor and the
atomic `reservation_len` — live in peer-writable memory, so neither is
trustworthy. Exploitability past the start check was not established, hence
medium.
Existing check: none.
Impact: the reclaim cursor can be pushed past bytes still under a live lease.
Later underflow is caught (`arena.rs:104-108`), so this is corruption and
denial of service rather than an out-of-bounds access.
Open questions:

- Was the atomic `reservation_len` (`ring.rs:122`) intended to be the producer's
  trusted record? It is written but never read by `reclaim_completed`. A
  producer-local table would be trustworthy; is that feasible given `Ring` is
  thread-confined?

### attach-binds-geometry-to-a-local-profile

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs an attach whose grant geometry differs from the
admitted profile.
Guarantee: A peer only maps a shared object whose declared geometry equals the
geometry its own admitted profile charged for.
Check: `always` — at attach, assert grant depth, arena bytes, and lease cap all
equal the local profile's values, and assert an upper bound on depth and total
bytes exists inside Rust.
Fault/timing angle: no fault needed. `Ring::attach` takes no `TargetProfile`, so
geometry is only checked for self-consistency and against the mapped lifecycle
page — never against what admission charged.
Required faults and enabling state: a grant declaring a geometry the local
profile did not charge for.
Confidence: high — [evidence](evidence/attach-binds-geometry-to-a-local-profile.md).
`Ring::attach` (`ring.rs:598`) has no profile parameter, and `checked_layout`
(`:461`) bounds depth only by `!= 0` plus layout arithmetic.
Existing check: `crates/mc-host/src/ring_transport.rs:822`
`ring_profile_pins_per_connection_grant_geometry` pins the *host*
profile's geometry; nothing pins the attaching side's. Status unaudited.
Impact: admission accounting describes an object that was never mapped. It also
means a self-consistent grant with a very large depth reaches `mmap` with only a
TypeScript-side cap in the way.
Open questions: None.

### one-profile-name-denotes-one-geometry

Type: safety
Reachability: default-production — the host issues its grant geometry on every
accepted connection (`crates/mc-host/src/connection.rs:148`, from
`ring_transport.rs:32` and `:47-50`), and the client attaches through the addon
by default (`packages/plugin/src/shared/mc-host-client/connection.ts:393`), so
the disagreement is live on the shipped path.
Status: active
Exercised: not yet — needs a cross-artifact equality assertion; the
contradiction is present today.
Guarantee: Every artifact naming profile `mc-host-test-ring-v1` derives its
geometry from one source, so the name uniquely determines depth, arena bytes,
lease cap, and layout overhead.
Check: `always` — assert the TypeScript grant constants, the addon test
fixture's constants, and the Rust qualified profile are pairwise equal, and that
the TypeScript layout overhead equals `Layout::new(depth, arena).total - arena`.
Fault/timing angle: no fault needed. The disagreement is live and masked because
the addon enforces no geometry (see the previous property) and because the
total-bytes cap is loose enough to admit both overheads.
Required faults and enabling state: none; this is a static consistency property.
Confidence: high — [evidence](evidence/one-profile-name-denotes-one-geometry.md).
Three artifacts name one profile with two geometries: the host issues depth 8 and
8 leases (`ring_transport.rs:47-50`, from `DESCRIPTOR_DEPTH` at `:32`), the
transport's own `ring_profile` is depth 32
and 32 leases (`profile.rs:706`, `:709`), and the addon test fixture encodes 32
(`packages/mc-shm-native/tests/mechanism.ts:91-95`). Each is internally
consistent; together they contradict. A fourth artifact used to participate: the
TypeScript validator at `packages/plugin/src/shared/mc-host-client/shm-grant.ts:66-69`
hard-rejected anything but 8. That file was deleted by the ring-transport refactor
and no replacement validator pins a geometry, so the contradiction now has one
fewer witness but is unchanged in kind, and the client-side guard that would have
caught a depth-32 grant is gone.
Existing check: `ring_profile_pins_per_connection_grant_geometry`
(`ring_transport.rs:822`) pins Rust only. Status unaudited.
Impact: this is the mechanism behind defect `daf6e244`, where a stale hardcoded
layout total silently weakened five hardening tests for over a day. The
arrangement guarantees recurrence.
Open questions:

- Is the depth-32 fixture a deliberate model of `create_test_pair` (which uses
  `ring_profile`), in which case the profile string is knowingly overloaded
  across two geometries? (needs human input)

### native-boundary-not-weaker-than-its-wrapper

Type: safety
Reachability: default-production — the client's default frame channel is
`ShmFrameChannel` over this addon
(`packages/plugin/src/shared/mc-host-client/connection.ts:393`); only a test
`channelFactory` bypasses it (`:389-390`). The host side is unconditional too
(`crates/mc-host/src/runtime.rs:876`), so the test-only framing above predates
the ring-transport refactor.
Status: active
Exercised: not yet — needs each wrapper-level rejection driven against the
native boundary directly.
Guarantee: Every rejection the TypeScript grant decoder performs is also
performed by the directly-callable native `attach`, so bypassing the wrapper
cannot admit a descriptor the wrapper would reject.
Check: `always` — for each wrapper error code (unexpected field, stale
candidate, lane mismatch, aliased lanes by incarnation, geometry mismatch,
out-of-range total), construct a descriptor triggering it and assert the native
`attach` also rejects.
Fault/timing angle: a caller reaching the addon without the wrapper — exactly
what the addon's own mechanism test does via `createRequire`. Replay of a
previously released grant is admitted natively because the process-wide claim
covers only concurrently live grants and the native descriptor type has no
candidate-id field at all.
Required faults and enabling state: a direct native call with a descriptor the
wrapper would reject.
Confidence: high — [evidence](evidence/native-boundary-not-weaker-than-its-wrapper.md).
The native field reads are enumerable at
`packages/mc-shm-native/src/lib.rs:503-530` and contain none of these checks;
`NativeDescriptor` (`packages/mc-shm-native/index.ts:41-47`) structurally omits
`candidateId`, so the replay fence is dropped by the type contract.
Existing check: none at the native boundary; the TypeScript tests exercise the
wrapper.
Impact: the permissive layer is the inner, directly-requirable one. A related
gap: nothing binds a grant to its direction — field *position* is the only role
assignment, so swapped fields would put two producers on one single-producer
lane.
Open questions:

- Can any caller reach native `attach` with attacker-ordered or
  bug-ordered lane fields, making the role confusion reachable rather than
  latent?

---

## Group G: evidence and measurement integrity

These properties do not guard the transport. They guard the artifacts that would
be used to decide whether to ship it, and to prove the other properties hold.
A defect here is live today, regardless of the transport being non-default.

### operation-counters-are-observed-not-declared

Type: safety
Reachability: test-only — the subject is bench and test material, not a runtime
path: `OperationCounters` is referenced only by
`crates/mc-shm-transport/src/evidence.rs:5`, `tests/contract.rs`, and
`benches/hardware_envelope.rs`, and no production path increments a counter. It
is the intended release gate, but `benches/manifests/v1.json:4` still reads
`designation_status: UNSET_REQUIRES_DESIGNATED_HOST`, so it has gated no
shipped decision yet.
Reaches production: evidence path
Status: active
Exercised: not yet — needs negative controls that remove a real operation and
assert the counter drops.
Guarantee: Each gate counter is incremented at the site where the operation
occurs, by the process that performs it, and cannot be produced by a path that
did not perform it.
Check: `always` — for each counter, assert no assignment is derived solely from
an arm label, a boolean flag, a scheduling mode, or an iteration count. Negative
control: remove the receiver's copy and assert `body_copies` drops; remove the
cold-path sleep and assert `park_wakes` drops.
Fault/timing angle: none needed; the counters are computed rather than observed.
Required faults and enabling state: none. This is a static property of the
harness, and it currently fails.
Confidence: high — [evidence](evidence/operation-counters-are-observed-not-declared.md).
Verified by repository-wide search: `body_copies` is written only in a test
fixture (`tests/contract.rs:464`), in the bench (`benches/hardware_envelope.rs:132`,
`:140`, `:161`, `:184`), and as a
field declaration plus a read in `evidence.rs:7`, `:24`. `OperationCounters` is
referenced by exactly three files — `evidence.rs`, `tests/contract.rs`, and the
bench — none of them production. No production path increments any counter.
(Mechanism caveat, 2026-08-31: the #131 bench rewrite changed the provenance
mix this record derives from — `park_wakes` is now observed via a shared
`AtomicU64` at the wait site (`hardware_envelope.rs:283`, `:354`) and
copy/allocation counting mixes per-site increments with bulk arithmetic
(`:302-304`, `:325-326`), while `syscalls` stays a literal zero; the
SchedulingMode-derived counting and the fork-parent inference described below
are pre-#131 evidence. This record needs mechanism-level re-derivation.) The
receiver's copy happened in a forked child while the count was added in the parent
after `waitpid`; `syscalls` and `allocations` were hardcoded per arm; and the gate
control overwrites all six counters after running the *same* body as the
selectable arm (still true at HEAD: `hardware_envelope.rs:139-146`, `:126`).
Existing check: `purity_gate_rejects_injected_copy_allocation_queue_and_wake`
(`tests/contract.rs:462`), which tests the gate's arithmetic over values it
supplies itself. Status unaudited, and circular as an oracle. The second anchor is
gone: the manifest key `injected_gate_control_must_be_disqualified`, formerly
`benches/manifests/v1.json:155` at `9c1eb4d1`, no longer appears anywhere in the
tree at
`e447c927`. The manifest now names the injected arm only as a `gate_controls`
entry (`benches/manifests/v1.json:89-91`) with no disqualification rule stated
beside it, so the manifest half of this check was removed rather than moved.
Impact: the zero-copy selection gate cannot detect a copy. A body copy added to
a nominally zero-copy arm would report `body_copies == 0` and pass. This is the
gate that decides whether a shared-memory provider may ship.
Open questions:

- Is `OperationCounters` intended to be wired to real instrumentation, or is it
  permanently a report-schema type? If the latter, the "counts copies" language
  in `docs/mc-host-shm-transport.md:25` overstates what any artifact can prove.
  (needs human input)

### measured-transfer-is-witnessed-by-the-data

Type: safety
Reachability: test-only — the subject is the benchmark's own reporting
(`crates/mc-shm-transport/benches/hardware_envelope.rs`), which no host or
addon path executes. It feeds the release gate, but
`benches/manifests/v1.json:4` still reads `designation_status:
UNSET_REQUIRES_DESIGNATED_HOST`, so no shipped decision has rested on it.
Reaches production: evidence path
Status: active
Exercised: not yet — needs a corruption injection that the checksum must catch.
Guarantee: Every arm's reported checksum is a function of the bytes actually
delivered, so a corrupted or skipped transfer cannot produce the same value as a
correct one.
Check: `always` — assert the checksum is computed from received bytes on every
arm; corrupt one delivered byte and assert the reported value changes.
Fault/timing angle: silently dropped or corrupted frames on the selectable arm.
Required faults and enabling state: none to demonstrate the gap; a byte
corruption to demonstrate the impact.
Confidence: high — [evidence](evidence/measured-transfer-is-witnessed-by-the-data.md).
The ring arm's checksum is a closed form over the *parameters*
(`benches/hardware_envelope.rs:328-330`), while the consumer's real
`span.checksum()` is computed into a black box and discarded (`:371`). The
stream arms did checksum real bytes (pre-#131 `:478`; those arms were removed
by the #131 bench rewrite), so the field is not even comparable
across arms.
Existing check: none.
Impact: a fully corrupted ring transfer yields a bit-identical checksum, so the
benchmark cannot distinguish a working transport from a broken one.
Open questions: None.

### traceability-pointers-resolve

Type: safety
Reachability: test-only — the subject is the audit artifact
`docs/evidence/mc-shm-traceability-v1.json` and the test names it cites;
nothing in `crates/mc-host` or `packages` reads it at run time. It is the audit
trail for a release gate whose `designation_status` is still
`UNSET_REQUIRES_DESIGNATED_HOST` (`benches/manifests/v1.json:4`).
Reaches production: evidence path
Status: active
Exercised: yes — checked mechanically at `9c1eb4d1` and re-run independently.
Of 51 citation instances, 29 are distinct and contain a fragment; 18 resolve and
11 do not.
Guarantee: Every evidence pointer in the traceability record names an artifact
that exists and a test that is present in it.
Check: `always` — for each evidence string containing a fragment, assert the
file exists and the named test appears in it, under the citation convention that
artifact class actually uses.
Fault/timing angle: none; a rename silently detaches a requirement from its
proof.
Required faults and enabling state: none.
Confidence: high — [evidence](evidence/traceability-pointers-resolve.md).
The 11 unresolved pointers classify into three groups, and only the first is a
defect:

- **Definitively stale, 2 distinct across 5 citation instances.** The record
  cites `tests/ring.rs#lease_limit_rejects_then_recovers_after_release` where the
  test is `lease_limit_reports_backpressure_then_recovers_after_release`
  (`ring.rs:272`), and
  `tests/shm_transport.rs#omitted_and_unqualified_profiles_fall_back_without_side_effects`
  where the test is
  `omitted_and_unqualified_profiles_fall_back_reasonless_without_side_effects`
  (`shm_transport.rs:117`). The second is cited by three separate requirement
  rows.
- **Markdown anchors, 2 distinct.** Both resolve under standard anchor
  derivation. Not stale; a naive substring check simply cannot see them.
- **TypeScript naming convention, 7 distinct across 2 files.** Each maps
  one-to-one to a real declaration under a single transform, spaces to
  underscores with commas dropped. A literal substring check can never match
  these, because the sources spell the names with spaces.
Existing check: none. Nothing validates the traceability record against the tree.
Impact: two requirement citations, one of them load-bearing for three rows,
point at tests that do not exist under those names. This is the audit trail for a
release gate, and it has no validator.
Open questions: None. The classification question that opened this record is
resolved; the correct check normalizes per artifact class rather than doing a
literal substring match.

### negative-tests-fail-for-their-stated-reason

Type: safety
Reachability: test-only — the subject is the negative test cases themselves,
including `crates/mc-shm-transport/tests/fuzz_corpus.rs`, and the addon
mechanism tests. No runtime path evaluates them, and this record makes no claim
that gates a shipped decision.
Reaches production: evidence path
Status: active
Exercised: not yet — needs each negative case asserted against its specific
rejection reason.
Guarantee: Every test that expects a rejection asserts the specific rejection
reason, and no fixture duplicates production geometry without a cross-check.
Check: `always` — each negative case pins a distinct expected error; and for
each corpus target, assert at least one seed is accepted and at least one is
rejected.
Fault/timing angle: none; the failure mode is a test passing for the wrong
reason.
Required faults and enabling state: none.
Confidence: high — [evidence](evidence/negative-tests-fail-for-their-stated-reason.md).
This property is derived from an actual incident, not a hypothesis. Defect
`daf6e244` left a hardcoded layout total stale after the control region grew by
a page, so four of the six boundary tests were rejecting inputs on grant-layout
mismatch rather than on the hostile input under test. The wrong-profile case is
not maskable, because it returns before grant decode. Only the one case that
asserted a specific message noticed. The fix added a comment, not a check.
Separately, `tests/fuzz_corpus.rs:33-36` asserts only that the seed named
`valid` is accepted; no seed is asserted to be rejected, so a decoder that
widened acceptance would leave all three replay tests green.
Existing check: partial — one message-specific case in the addon mechanism
tests, and panic-freedom plus one positive in the corpus replays. Status
unaudited.
Impact: a whole class of negative tests can silently stop testing what they
name. This already happened once for over a day.
Open questions: None.

---

## Group H: documented surface versus implemented surface

Each of these is a documented guarantee whose implementing code is absent,
unreachable, or narrower than the text. The documentation establishes the
obligation; these records exist because the implementation does not obviously
discharge it.

### documented-close-order-has-a-production-driver

Type: reachability
Reachability: test-only — `CloseState` and `Lifecycle` are referenced by
exactly two files, their own module `crates/mc-shm-transport/src/lifecycle.rs`
and `crates/mc-shm-transport/tests/contract.rs:10`; the absence of a non-test
driver is this record's finding, so the class states it rather than
contradicting it.
Status: active
Exercised: not yet.
Guarantee: The documented close ordering is driven by production code, so the
ordering the tests prove is the ordering that ships.
Check: `reachable` — assert the close state machine is advanced from at least
one non-test caller. `reachable` fits because this is about a code location
being executed, not about a state being constructed.
Fault/timing angle: none; a static reachability question.
Required faults and enabling state: none.
Confidence: high — [evidence](evidence/documented-close-order-has-a-production-driver.md).
Verified by repository-wide search: `CloseState`, `Lifecycle::new`,
`mark_prepared`, and `must_fail_closed` are referenced by exactly two files —
their own module `crates/mc-shm-transport/src/lifecycle.rs` and
`crates/mc-shm-transport/tests/contract.rs`. The host close path and the addon
close path each implement their own ordering, and neither advances this machine.
Existing check: `lifecycle_accepts_only_diagram_edges_and_quarantine_is_terminal`
(`tests/contract.rs:272`) proves the model's edges. Status unaudited as evidence
for the shipping paths.
Impact: `docs/mc-host-shm-transport.md:63` describes the close ordering as the
implemented contract and the traceability record marks the corresponding
requirement PASS, but the PASS rests on a type nothing in production drives. The
documented "drains published data" stage has no counterpart in either real close
path.
Open questions:

- Is the state machine intended to become the driver, or is it a specification
  artifact? If specification-only, which code is normative for close ordering?
  (needs human input)

### capability-probe-gates-every-advertised-mechanism

Type: safety
Reachability: test-only — `probeCapabilities`
(`packages/mc-shm-native/index.ts:238`) is called only from
`packages/plugin/src/shared/mc-host-client/shm-frame-channel.test.ts`; the
default client path constructs `ShmFrameChannel` without consulting it
(`connection.ts:393`).
Status: active
Exercised: not yet — needs a runtime lacking the cleanup hook.
Guarantee: Capability is advertised only when every mechanism the documentation
enumerates is actually present.
Check: `always` — for each enumerated mechanism, a runtime lacking it yields
`available: false` with a bounded reason.
Fault/timing angle: a runtime that is neither Bun nor reports as Node, or one
without the cleanup-hook export.
Required faults and enabling state: a runtime missing one enumerated mechanism.
Confidence: high — [evidence](evidence/capability-probe-gates-every-advertised-mechanism.md).
Verified by direct read of `packages/mc-shm-native/index.ts`: steps one through
seven each gate with an `available: false` return (lines 118, 122, 129, 134,
149, 169, 193), but the eighth is only *reported* — line 203 returns
`available: true` and line 209 sets
`cleanupHooks: typeof native.registerCleanupProbe === "function"` inside the
same object. A runtime without the hook is advertised as capable.
Existing check: the capability suite asserts channel counts around the probe,
not the gating itself. Status unaudited.
Impact: `docs/mc-host-shm-transport.md:42` states "any failure returns
`available: false` with a bounded reason", which is falsified for one of the
eight enumerated steps.
Open questions:

- An earlier draft asserted that the code's step order differs from the
  document's numbering. That is **not supported**: steps one through eight appear
  in documented order. Two real divergences replace it. There is an undocumented
  gate before step one, `node_detachment_unavailable`, and the eight documented
  steps are implemented as five gates plus a catch-all, because steps three and
  five have no dedicated reason of their own. Whether the enumeration is meant to
  be one gate per step is the open question. (needs human input)

### clean-reclamation-is-reachable

Type: reachability
Reachability: test-only — when live, the clean-reclamation branch and the
incarnation mint were reached only through the fake recovery backend, as this
record's own evidence states. Invalidated rather than live:
`provider_recovery.rs` and `ShmRecoveryBackend` are deleted, and
`crates/mc-host/src/ring_transport.rs:291` releases charges unconditionally
with no reclamation outcome.
Status: invalidated
Exercised: not yet — reachable only through a fake backend today.
Guarantee: For the shipped provider, the clean-reclamation outcome — charges
returned exactly once and a new incarnation minted — actually occurs at least
once under conditions that should produce it.
Check: `sometimes` — across a campaign, at least one recovery episode on the
real backend ends in clean reclamation with charges returned and the incarnation
advanced. Semantics revised from `reachable`: this is a situation, not a code
location. A campaign can execute the branch's lines through a fake backend while
never producing the operational state — cleanup proving the stale resources are
gone — that the outcome is supposed to represent. If the decision is instead
that the shipped backend will never produce it, the correct resolution is to
scope the documentation to a quarantine-only outcome and mark this record
invalidated with that reason.
Fault/timing angle: none; the shipped cleanup returns the uncertain outcome
unconditionally.
Required faults and enabling state: none to observe the gap.
Confidence: high — [evidence](evidence/clean-reclamation-is-reachable.md).
`ShmRecoveryBackend::cleanup` returned `CleanupOutcome::Uncertain` for every
input and `probe()` returned `true` unconditionally (former
`crates/mc-host/src/shm_provider.rs:137-152`). The clean-reclamation branch and
the incarnation mint (former `provider_recovery.rs:481-490`) were exercised only
through the fake backend (former `provider_recovery.rs:889`).
Existing check: none. The fake-backend test was deleted with
`provider_recovery.rs`.
Impact: `ed487e11` deleted `provider_recovery.rs` and `0f336d3c` removed
`ShmRecoveryBackend`, so `CleanupOutcome`, `ProviderReadiness`, recovery
episodes, and provider incarnations no longer exist anywhere in the tree and
nothing now owns the reclaim-versus-isolate obligation. The question the record
asked — whether the shipped backend can ever reach clean reclamation — is
answered by deletion rather than by evidence: `crates/mc-host/src/ring_transport.rs:291`
returns charges unconditionally, with neither a quarantine outcome nor a
reclamation proof. `docs/mc-host-shm-transport.md:87-90` still presents clean
reclamation and quarantine as two distinct outcomes with distinct experiments,
and now describes no code at all.
Open questions:

- The documentation at `docs/mc-host-shm-transport.md:87-90` now describes a
  two-outcome recovery model that no longer exists. Should it be rewritten to the
  unconditional-release behaviour, or is the recovery model intended to return?
  (needs human input)

### test-only-surface-absent-from-the-shipped-addon

Type: safety
Reachability: default-production — the subject is the shipped addon's exported
surface, and that addon is the default client channel
(`packages/plugin/src/shared/mc-host-client/connection.ts:396`), loaded from
`@cortexkit/mc-shm-native` (`packages/plugin/package.json:58`). The exports
carry no `cfg` gate, so they ship.
Reaches production: yes
Status: active
Exercised: not yet — needs an export inventory of the built artifact.
Guarantee: Fault injectors, probes, and test constructors are absent from the
addon's exported surface in a shipping build.
Check: `always` — enumerate exported names from the built artifact and assert
the set excludes the failpoint setter, the arbitrary-buffer detach, the external
probe, the cleanup-probe registrar, the test-pair constructor, and the forced
close.
Fault/timing angle: none; any JavaScript in the host process can call them.
Required faults and enabling state: none.
Confidence: high — [evidence](evidence/test-only-surface-absent-from-the-shipped-addon.md).
The addon source contains no `cfg(test)`, `cfg(feature)`, or
`cfg(debug_assertions)` gates at all, and exports the failpoint setter, an
arbitrary `ArrayBuffer` detach, the external probe, an arbitrary-path cleanup
probe, the test-pair constructor, and a forced close
(`packages/mc-shm-native/src/lib.rs:447-511`, `:794`, `:1335`). The ungated block
grew rather than shrank: `d8bde128` added `build_profile` (`:458-465`) and
`build_target` (`:467-470`) to it. The fuzz harness
module is likewise ungated in the library (`crates/mc-shm-transport/src/lib.rs:8`).
Existing check: none.
Impact: the external-view failpoint can drive both directions into quarantine
from JavaScript, the cleanup probe is an arbitrary-path file write at teardown,
and the buffer detach operates on buffers the addon never created. The addon is
also shipped from a debug build, so release behaviour is never exercised.
Open questions:

- Is a `cfg`- or feature-gated split intended before this transport becomes
  selectable, or is the surface considered acceptable because the transport is
  test-only? (needs human input)

---

## Group I: the decode contract

The decode surface is the best-tested code in the crate. It is cataloged anyway,
because an existing check never removes a property: these records state the
contract the fuzz targets and tables are approximating, and each one names a
condition no current check pins.

### decoder-totality-over-arbitrary-bytes

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — the only totality evidence sweeps ten lengths and two fill
bytes; no exhaustive-length sweep, no structured mutation of an accepted seed,
and no allocation oracle exist.
Guarantee: For every byte sequence, each decoder returns either a value
satisfying its accept-postcondition or an error; no input panics, drives an
unbounded allocation, or yields a partially checked value.
Check: `always` — for arbitrary input the call returns, and either the accept
type's postconditions hold or an error variant is returned. A panic is a
forbidden state with no dedicated detection point, so it is expressed as
`always(!panic)`; `unreachable` would be wrong because no code point must never
execute.
Fault/timing angle: none. All three decoders are pure functions over one
immutable slice. The exposure is structural: panic-freedom rests on
`GRANT_BYTES` being the literal `58` (`ring.rs:29`) with no static tie to its 54
bytes of fields, and on the harness's last `read_u64` ending at exactly the
length gate with zero margin.
Required faults and enabling state: none. Arbitrary bytes are the whole enabling
state. The property holds at HEAD and is under-evidenced rather than violated.
Confidence: high — [evidence](evidence/decoder-totality-over-arbitrary-bytes.md).
Accept types are constructed once, after every guard (`descriptor.rs:299-307`,
`sample.rs:122-125`), both with private fields and no other constructor.
`RingGrant` materializes at `ring.rs:434-450` before `checked_layout()?` at
`:451` but cannot escape it. Panic sites enumerated: three `.expect()` calls
(`ring.rs:432`, `:439`, `:444`) plus constant range indexes, all infallible on a
58-byte array; and `harness.rs:19-23` `read_u64`, whose last read ends at index
107 against a gate admitting exactly 108. No decoder allocates; the first
length-driven allocation is `lease.rs:178-179`, bounded solely by the decoder's
`body_len > MAX_FRAME_BYTES` rejection against 64 MiB.
Existing check: `tests/contract.rs:743-766`
`harness_replays_terminate_on_arbitrary_lengths` (ten lengths, fills `0x00` and
`0xff`) and `tests/fuzz_corpus.rs:44-57` (five seeds each, panic-freedom only).
Status unaudited, and both are smoke tests for the claim they are taken to
support: neither fill reaches any arithmetic guard.
Impact: none today. The value is that the reasoning keeping totality true lives
nowhere in the tree. Narrowing `GRANT_BYTES` turns `ring.rs:426` into an
unconditional panic on every call, and a harness offset edit does the same to
`read_u64`; no property currently forbids either.
Open questions:

- Should `GRANT_BYTES` be derived from its field widths, as `SAMPLE_PREFIX_BYTES`
  is (`sample.rs:24`), rather than written as a literal?
- Is the harness's zero-margin offset arithmetic deliberate? (needs human input)

### accepted-decode-consumes-its-declared-width

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs a per-byte influence oracle; the one round-trip
assertion that exists cannot fail without a source edit.
Guarantee: For every accepted input, each byte of the declared width either
influences a decoded field or is pinned to a constant, and no region beyond the
declared width is consumed except where the decoder's contract declares trailing
slack.
Check: `always` — for every accepted decode, flipping any single input bit within
the declared width changes the decoded value or causes rejection, and the
consumed width equals the declared width. The per-decoder slack policy is part
of the condition rather than an exception to it.
Fault/timing angle: none. The interesting axis is that the three decoders do not
share a policy: `RingGrant::decode_slice` (`ring.rs:643-646`) and
`harness::frame_descriptor` (`harness.rs:23-26`) demand an exact width, while
`SamplePrefix::snapshot` (`sample.rs:32-36`) accepts a prefix plus declared body
and deliberately ignores documented capacity slack.
Required faults and enabling state: none. Any accepted input suffices; what is
missing is the oracle.
Confidence: high — [evidence](evidence/accepted-decode-consumes-its-declared-width.md).
What the `provider_grant` round-trip at `harness.rs:99-103` actually proves:
`decode` maps all 54 non-reserved bytes into seven fields with no lossy
transform, and `encode` (`ring.rs:593-604`) writes exactly those back plus four
zero bytes, so no byte is read-and-discarded or defaulted, and acceptance cannot
silently widen. It does not cover value legality, never evaluates a short input,
cannot detect a reordering of two same-width fields, and has no counterpart for
the other two decoders: `FrameDescriptor` has no encoder anywhere in the library,
and `SamplePrefix` cannot have a byte-exact oracle because its contract permits
slack. On this commit the assertion is a tautology over accepted inputs, so it is
a regression tripwire rather than a campaign-time detector.
Existing check: partial. `tests/ring.rs:451-477` sweeps every cut in `0..58`, a
one-byte suffix, and empty; `:482` re-asserts the round-trip on one fixture.
`tests/contract.rs:553-565` covers the sample slack policy properly, having moved
there from the deleted `tests/iceoryx.rs`. Nothing asserts
the frame-descriptor encoding consumes its declared width. Status unaudited.
Impact: the 108-byte frame-descriptor encoding is the one with no consumption
oracle and the one whose offsets are hand-written literals. A change making a
region inert leaves the length gate satisfied and every read in bounds, so
whether any test notices depends on which seeds happen to distinguish the fields.
Open questions:

- Is `SamplePrefix`'s prefix-plus-slack policy permanent, or an accommodation for
  iceoryx loan granularity that another backend would not need? (needs human
  input)

### identity-and-schema-rejection-is-one-contract

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — needs one shared case table driven against every reader,
and for the disposition half, a peer write to a slot descriptor between the
receive read and the reclaim read.
Guarantee: Every path that admits a shared descriptor as authentic enforces the
same schema-and-identity condition set, and a rejection from any of them has one
declared disposition.
Check: `always` — for every reader that accepts a descriptor, acceptance implies
schema equals `DESCRIPTOR_SCHEMA_VERSION`, sequence is non-zero, and incarnation,
lane, and sequence equal the locally derived expectation; and every rejection
produces the declared disposition. The divergence is a live state of the code,
not a code point, so `unreachable` does not apply.
Fault/timing angle: the enforcement half is static. The disposition half has an
unbounded window, because the descriptor is read twice from peer-writable memory
— `ring.rs:1093` on receive and `:1489` on reclaim — with the whole lease lifetime
between, so "validated at receive" does not imply "valid at reclaim".
Required faults and enabling state: none for enforcement. For disposition, a live
lease plus a peer write to that slot's `schema_version`, then a release followed
by a `try_reserve`.
Confidence: high on enforcement; the second failure shape's reachability is
unresolved — [evidence](evidence/identity-and-schema-rejection-is-one-contract.md).
The five conditions appear in identical order at `descriptor.rs:199-213` and
`sample.rs:77-91`. `Ring::release` (`ring.rs:1175-1247`) enforces three: it checks
incarnation and lane against the grant (`:1179-1184`), non-zero sequence
(`:1186-1188`), and `sequence > consumed` (`:1194-1196`), then compares only
incarnation, lane, and sequence against the raw struct (`:1201-1210`). It never
calls `snapshot()` or `validate`, so `schema_version` is not read. Dispositions
diverge for the same `validate` call: `try_receive` quarantines at `:1098`, while
`reclaim_completed` maps the error through at `:1490-1494` to `try_reserve`; both
consumers of that error were searched and neither quarantines.
Existing check: partial, and none cross-cutting. `tests/contract.rs:73` tables
the descriptor cases; `tests/contract.rs:570-672` covers the sample prefix,
including the incarnation, lane, and sequence cases that used to live in the
deleted `tests/iceoryx.rs`; `tests/ring.rs:152-175` covers release identity. Each
table is written against its own reader. Status unaudited.
Impact: two shapes. Adding a condition to one decoder and not the other leaves
both tables green while the backends admit different identity classes. And a
`schema_version` rewritten under a live lease is accepted by `release`, rejected
by `reclaim_completed`, and head-of-line blocks the reclaim loop — a direction
that stops progressing with no terminal state and no operator-visible fault, the
same end state `crashed-producer-does-not-wedge-the-sequence` reaches by another
route.
Open questions:

- Is omitting the schema check in `Ring::release` intentional, on the grounds
  that the release path builds no body view? If so it belongs in a comment,
  because the field is read from peer-writable memory by the next reader.
  (needs human input)
- Which disposition is normative for a reclaim-path `validate` failure? Both
  reachable behaviours exist today for the same rejection. (needs human input)

### grant-reserved-bytes-are-rejected-unless-zero

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — one of the four bytes is perturbed by a test, and the corpus
seed that encodes the case has its outcome unasserted.
Guarantee: A grant is accepted only if all four reserved bytes are zero, and
`encode` reproduces them as zero, so the region stays reserved in fact rather
than only in intent.
Check: `always` — acceptance implies `bytes[54..58] == [0; 4]`, and for every
accepted grant `encode()` writes those positions as zero.
Fault/timing angle: none. The forward-compatibility angle is the real one: the
guard is checked at `:430-432` before the layout-version read at `:439`, and
every grant rejection collapses to `RingError::InvalidGrant`, so "peer speaks a
newer layout" and "peer sent garbage" are indistinguishable.
Required faults and enabling state: none. A nonzero reserved byte is the whole
input. For the re-encode direction, a component that decodes and re-encodes a
grant, which does not exist in-tree today.
Confidence: high — [evidence](evidence/grant-reserved-bytes-are-rejected-unless-zero.md).
`GRANT_BYTES` is the literal `58` (`ring.rs:29`); the seven fields occupy 54
bytes; `encode` writes `0u32.to_le_bytes()` into `54..58` unconditionally at
`:415`; `decode` rejects a nonzero region at `:426-428`. The corpus seeds
`provider_grant/valid` and `near-valid` were compared byte by byte: they differ
only at index 54 (`0x00` versus `0x01`), so `near-valid` is the reserved-byte
case. The descriptor-side contrast was also measured: `SharedDescriptor` is 120
bytes with 12 of padding, written whole by `write_volatile` and read only by name
in `snapshot()`, so the shared descriptor has an unconstrained equivalent region
while the grant's four bytes are enforced.
Existing check: `tests/ring.rs:380`
`artifact_mismatch_fails_before_mapping_and_unsealed_objects_are_rejected`, which
the refactor renamed from `attach_rejects_unsealed_objects_and_tampered_grants`,
sets `reserved[54] = 1` (`:403`) and asserts `Err(RingError::InvalidGrant)`
(`:432`). A genuine pin, but it covers one byte of
four and asserts a category eight other tampered cases share. The corpus
`near-valid` seed runs with its outcome unchecked. Status unaudited.
Impact: the guard makes a version-2 reader fail closed against a version-3 grant,
which is correct. The uncovered direction is `encode`: it zeroes the region
unconditionally, so any decode-then-re-encode silently strips a future field
rather than rejecting it. The only thing standing against that is the fuzz
round-trip assertion, which is doing forward-compatibility work its comment does
not claim.
Open questions:

- Is `encode`'s unconditional zeroing intended to make the type version-2-only,
  or should a relay preserve unknown reserved bytes? (needs human input)
- Should the descriptor's 12 padding bytes get the same declared-and-enforced
  treatment, or be documented as meaningless? They are the only region of the
  decode surface with neither. (needs human input)

### fuzz-harness-encoding-tracks-the-production-descriptor

Type: safety
Reachability: test-only — the subject is the fuzz harness
(`crates/mc-shm-transport/src/harness.rs`, declared at
`crates/mc-shm-transport/src/lib.rs:16`), which only `tests/contract.rs` and
`tests/fuzz_corpus.rs` drive. The production descriptor it tracks is
default-production; the harness is not.
Reaches production: evidence path
Status: active
Exercised: not yet — needs a static width assertion, a per-byte influence
assertion, and a decoupled `expected` identity.
Guarantee: The fuzz harness's byte encoding reaches the field-tuple space the
production reader can present, so the corpus explores the real descriptor shape
rather than a stale approximation.
Check: `always` — `FRAME_DESCRIPTOR_BYTES` equals the sum of the field widths
`FrameDescriptor::from_untrusted` accepts, and the byte-to-field map is a
bijection onto that space, so no field domain is unreachable and no input byte is
inert. This is a static agreement evaluated on every build, not a situation to
reach.
Fault/timing angle: none. The exposure is that `validate` takes three independent
inputs in production — the peer-controlled descriptor, an `expected` identity
derived from the grant and local cursor, and `arena_bytes` from the grant — and
the harness pins two of them. `harness.rs:76` passes the decoded identity, so the
accept path satisfies the three identity comparisons by construction, and the
reject path at `:98-102` differs only in `lane ^ 1`.
Required faults and enabling state: none for the static half. For coverage, an
`expected` identity differing from the decoded one in incarnation or sequence,
which neither fuzz target supplies, so the guards at `descriptor.rs:229-231` and
`:235-237` are reached by no campaign execution.
Confidence: high — [evidence](evidence/fuzz-harness-encoding-tracks-the-production-descriptor.md).
Measured: `FRAME_DESCRIPTOR_BYTES` is 108 (`harness.rs:16-17`) while
`size_of::<SharedDescriptor>()` is 120 with 12 bytes of padding; every field from
`lane` onward sits at a different offset, and the span region is interleaved in
the harness but grouped in the struct. That is not a defect, because production
reads typed fields via `snapshot()` and never sees bytes. The 108-byte map is
exactly a bijection: ten field widths total 864 bits, and 108 bytes is 864 bits.
The 120-byte figure was confirmed twice: by a layout program, and through the
corpus, since the `provider_grant/valid` seed's `total_bytes` of 67,125,248 is
reproduced by `Layout::new(32, 64 MiB)` only if `DescriptorSlot` is 256 bytes,
which requires the 120-byte descriptor, and that seed is accepted by a passing
test.
Existing check: partial and type-level only. `MAX_SPANS` is coupled by a
two-element array literal, and `from_untrusted`'s argument list makes an added
field a compile error. `tests/contract.rs:743-766` sweeps the constant and the
constant plus one. Nothing asserts the read regions sum to the constant, and
nothing asserts the incarnation and sequence guards are reachable from fuzzing.
Status unaudited.
Impact: the offsets are independent literals, so a reordering preserving the
total keeps the length gate satisfied and the bit count at 864. And two of the
five identity conditions in the load-bearing `validate` function are covered only
by tabled unit cases, never by fuzzing.
Open questions:

- Should the harness encode the shared struct's 120-byte image rather than a
  packed 108-byte private shape? Keeping them different is defensible and
  cheaper; unifying them would give the padding a decode contract and force
  corpus regeneration. (needs human input)
- Was passing the decoded identity as `expected` deliberate, or did the two-input
  nature of `validate` go unnoticed? (needs human input)

---

## Group J: platform and layout

Two gaps join here because they share a root: constants and `cfg` gates chosen
for one platform and one page size, on a code path CI never executes under the
other.

### macos-object-creation-outcome-is-attributed

Type: reachability
Reachability: default-production — label retained from the pre-#131 catalog
and no longer supported at HEAD; the class is unresolved pending the Darwin
question below. The evidence the label rested on is gone: PR #131 (merge
`5d638e3e8`) deleted the Darwin npm packages (`packages/mc-host-darwin-*`,
removed in `55f47ac64`) and left `.github/workflows/ci.yml` with only
`ubuntu-latest` jobs. What remains at HEAD is weaker than a coverage gap:
`create_macos_shm` (`crates/mc-shm-transport/src/backend/ring.rs:2176`) still
exists under `cfg(target_os = "macos")`, but `Mapping::create`
(`ring.rs:311-312`) calls `create_linux_memfd` unconditionally, so the function
has no caller, and `ring.rs:1-2` raises `compile_error!("mc-shm-transport ring
backend supports Linux only")` on any non-Linux target, so the crate cannot
compile where the cfg matches.
Status: active
Exercised: not yet — `create_macos_shm` has never executed under observation,
and at HEAD it cannot: it has no call site, no macOS CI job exists, and the
crate refuses to compile off Linux (`ring.rs:1-2`).
Guarantee: On macOS the ring object-creation path is executed, and its outcome is
attributed to a named step and error code rather than recorded as a bare variant.
Check: `reachable` — assert `create_macos_shm` is entered on a macOS host and its
result is recorded with the failing step and `errno` distinguished. This is
code-location and environment coverage: the location exists and is never
executed.
Fault/timing angle: none. The blocker was environmental — a macOS host that
actually runs the file — and is now also structural: no call site, and a
compile error off Linux.
Required faults and enabling state: a restored call site for `create_macos_shm`
and removal of the `ring.rs:1-2` compile error, then a macOS runner executing
`tests/ring.rs`.
Confidence: medium — [evidence](evidence/macos-object-creation-outcome-is-attributed.md).
The original analysis resolves against the pre-#131 tree: three
`ObjectSetupFailed` exits in `create_macos_shm` (then `ring.rs:1748-1783`),
`validate_object` returning a different variant, and a 40-character shm name
computed by replicating the fold. Re-verified at HEAD `bdf72f46a`: `099a314d5`
rewrote the function (now `ring.rs:2176-2219`); the name is built from 10
random bytes, 28 characters against a commented 31-byte Darwin limit
(`ring.rs:2177-2178`), which addresses the name-length candidate, an
`FD_CLOEXEC` `fcntl` step follows `shm_open` (`ring.rs:2206`), and the function
now has five `ObjectSetupFailed` exits and no caller. Medium because nothing
was ever executed on macOS, and the doc claim this record attributes is gone:
`docs/mc-host-shm-transport.md` now states Linux-x64 glibc support only (`:5`,
`:83`) and records no macOS `ObjectSetupFailed` status.
Existing check: none, and the former partial one is gone.
`platform_preflight_is_side_effect_free` (former `shm_provider.rs:827-848`)
asserted `StaticallyOmitted` on non-Linux, but that was a `cfg!` decision and
never called `Ring::create`. `ed487e11` made the ring mandatory and removed
`preflight` and `PreflightEligibility` entirely, so no check now records a
platform decision on this path at all.
Impact: the documented macOS failure status this record was anchored to
(former `docs/mc-host-shm-transport.md:121`) is gone from HEAD docs, which now
declare Linux-x64 glibc the only supported production platform (`:5`, `:83`).
If the Darwin surface returns, the concern stands unchanged: fixing whatever
failed silently activates the whole untested macOS path at once — creation
without seals, and an attach whose type predicate is a constant `true` on
Darwin (`ring.rs:2114-2115`).
Open questions:

- Which step fails, and with which errno? The pre-#131 doc claim of a macOS
  `ObjectSetupFailed` is no longer in the tree, and `099a314d5` changed the
  strongest candidate (name length). Needs one macOS run with a restored call
  site. (needs human input)
- Is the macOS ring intended to become functional, or is `ObjectSetupFailed` the
  permanent state? If permanent, the dependent records below become invalidated
  rather than latent. (needs human input)
- Is Darwin still a supported release surface? PR #131 (merge `5d638e3e8`)
  deleted the Darwin npm packages and the macOS CI jobs while the
  `cfg(target_os = "macos")` code path remains at `ring.rs:2176`, uncalled and
  behind the `ring.rs:1-2` compile error, and `docs/mc-host-shm-transport.md:5`
  states Linux-x64 glibc only. If not, this record and its two dependents
  should be invalidated. (needs human input)

### attach-validation-is-not-platform-weakened

Type: safety
Reachability: default-production — label retained from the pre-#131 catalog
and no longer supported at HEAD; the class is unresolved pending the Darwin
question below. PR #131 (merge `5d638e3e8`) deleted the Darwin npm packages
(`packages/mc-host-darwin-*`, removed in `55f47ac64`), left
`.github/workflows/ci.yml` with only `ubuntu-latest` jobs, and added
`compile_error!` at `crates/mc-shm-transport/src/backend/ring.rs:1-2` for any
non-Linux target, so no macOS binary of this crate can exist at HEAD. The
platform-conditional validation text is still in the tree
(`ring.rs:2109-2115`), which is what keeps this record active.
Status: active
Exercised: not yet — needs a macOS execution of `Mapping::attach`, which at
HEAD is impossible: no macOS CI job exists and the crate refuses to compile off
Linux (`ring.rs:1-2`).
Guarantee: On every platform where attach is reachable, an admitted descriptor's
object type is established and its size is immutable for the mapping's lifetime.
Check: `always` — at every attach, the descriptor is refused unless its object
type is established and its size cannot subsequently shrink. `always` rather than
`unreachable` because this is a per-operation admission predicate. The earlier
form of this check also required asserting the premise that no macOS path yields
a ring descriptor; that clause is withdrawn, because `d8bde128` made a macOS
`Ring` retain and export its descriptor, so the vacuity the clause encoded no
longer holds.
Fault/timing angle: the shrink half has a window spanning the whole mapping
lifetime, from `validate_object`'s `fstat` (`ring.rs:1683`) to any later access,
because nothing re-checks. The type half has no window.
Required faults and enabling state: a macOS descriptor source — `attachment()`
plus `SCM_RIGHTS` is now one — plus a retained second descriptor used to
`ftruncate` after validation.
Confidence: high — [evidence](evidence/attach-validation-is-not-platform-weakened.md).
The refactor changed this record's premise in both directions, verified from `cfg`
attributes at `e447c927`. Correction at HEAD `bdf72f46a`: the type-check closure
did not hold. `b5dc778e` deleted the `cfg!(target_os = "linux")` carve-out that
set `type_valid = true` on Darwin, but `6352f873f` re-added it in `#[cfg]`
form — `validate_object` at HEAD checks `S_IFREG` only on Linux
(`ring.rs:2109-2110`) and sets `type_valid = true` under
`cfg(target_os = "macos")` (`ring.rs:2114-2115`). The weakening is dead text
rather than a live path only because `ring.rs:1-2` refuses to compile the crate
off Linux. The shrink half is now vacuously uniform: `validate_seals`
(`ring.rs:2127-2137`) and `seal_object` (`ring.rs:2165-2174`) keep their
`#[cfg(target_os = "linux")]`, but their call sites are ungated at HEAD — the
attach-side call (`ring.rs:336`) and the create-side pair (`ring.rs:769-770`) —
which compiles only because the whole crate is Linux-only, so every attach that
can be built runs the seal check. Opened:
the vacuity argument is gone. `d8bde128` removed the macOS `drop(fd)` and the
`#[cfg(target_os = "linux")]` on `Mapping`'s `fd` field, so macOS now retains the
descriptor (`ring.rs:207-211`), and it removed the Linux gates from `raw_fd`
(`:624`), `attachment` (`:629`), and `set_inheritable` (`:645`); `RingAttachment`
(`:503`) is ungated and gained `into_parts` (`:521`), which hands out the raw
`OwnedFd`. Those observations resolve against `e447c927`; at HEAD the
descriptor-source question is moot for macOS, because `ring.rs:1-2` prevents
any macOS build of the crate.
Existing check: `artifact_mismatch_fails_before_mapping_and_unsealed_objects_are_rejected`
(`tests/ring.rs:380`) covers the Linux seal path only and is itself Linux-gated,
with no macOS counterpart. Status unaudited as evidence for the shrink check.
Impact: `docs/mc-host-shm-transport.md:117` rests the trusted-peer boundary on
owner-only attachment. On a macOS build that boundary would be uid plus exact
size plus mode bits with a constant-true type predicate and no shrink immunity;
at HEAD the compensating property is that no such build exists — the crate
compile-errors off Linux (`ring.rs:1-2`) and no macOS CI job or Darwin package
remains. A descriptor whose size is reduced after `fstat` would be mapped
`MAP_SHARED | PROT_READ | PROT_WRITE` at its validated length.
Open questions:

- The former note that `b5dc778e` resolved the Darwin `st_mode` premise by
  deletion is corrected: `6352f873f` re-added the carve-out in `#[cfg]` form
  (`ring.rs:2114-2115`), so the unverified premise returns with any Darwin
  build. (needs human input)
- If a macOS descriptor-passing path is wired to the now-ungated `attachment()`,
  what substitutes for `F_SEAL_SHRINK`? Darwin has no seals. (needs human input)
- Is Darwin still a supported release surface? PR #131 (merge `5d638e3e8`)
  deleted the Darwin npm packages and the macOS CI jobs while the
  `cfg(target_os = "macos")` validation carve-out remains at
  `ring.rs:2114-2115`, behind the `ring.rs:1-2` compile error. If not, this
  record's weakening can never be live and the record should be invalidated
  with that reason. (needs human input)

### macos-object-creation-leaks-no-shm-name

Type: safety
Reachability: default-production — label retained from the pre-#131 catalog
and no longer supported at HEAD; the class is unresolved pending the Darwin
question below. PR #131 (merge `5d638e3e8`) deleted the Darwin npm packages
(`packages/mc-host-darwin-*`, removed in `55f47ac64`) and left
`.github/workflows/ci.yml` with only `ubuntu-latest` jobs. At HEAD
`create_macos_shm` (`crates/mc-shm-transport/src/backend/ring.rs:2176`) has no
caller — `Mapping::create` (`ring.rs:311-312`) calls `create_linux_memfd`
unconditionally — and `ring.rs:1-2` compile-errors on any non-Linux target, so
the leak path is dead text unless a Darwin surface returns.
Status: active
Exercised: not yet — needs a failpoint on `shm_unlink`, or a crash between open
and unlink, on macOS, plus an oracle over the Darwin shm namespace; at HEAD
additionally blocked by the missing call site and the `ring.rs:1-2` compile
error.
Guarantee: A failed or interrupted macOS object creation leaves no name in the
Darwin shared-memory namespace.
Check: `always` — after any `create_macos_shm` invocation that does not return
`Ok`, the generated name is absent from the shm namespace. The forbidden state is
residue after an operation with a defined completion point, and there is no
dedicated detector, so `unreachable` does not apply.
Fault/timing angle: a one-statement error window at `ring.rs:2209`, between a
successful `shm_open` (`ring.rs:2191`) and a successful `shm_unlink`. No
concurrency needed. The crash variant is wider, spanning `OwnedFd::from_raw_fd`
at `:2201` and the `FD_CLOEXEC` `fcntl` at `:2206`.
Required faults and enabling state: an `shm_unlink` failure after a successful
`O_EXCL` `shm_open`, or a process kill in that window. Both require macOS and a
seam into `create_macos_shm`.
Confidence: medium — [evidence](evidence/macos-object-creation-leaks-no-shm-name.md).
Verified from the `a5568707` diff that the unlink moved ahead of the truncate,
and re-verified at HEAD `bdf72f46a` after `099a314d5` rewrote the body (now
`ring.rs:2176-2219`): the order is `shm_open` (`:2191`), `FD_CLOEXEC` `fcntl`
(`:2206`), `shm_unlink` (`:2209`), `ftruncate` (`:2215`), so the pre-fix
`ftruncate` leak window stays closed and the combined `cloexec < 0 || unlinked
!= 0` exit (`:2210-2212`) is the one returning with the name present and no
retained handle. `shm_unlink` is called exactly once in the crate. Medium
because whether Darwin names survive the last
descriptor close, and whether `shm_unlink` can fail after `O_EXCL` success, are
external facts that could not be tested. The former note that
`create_macos_shm` was byte-identical to its `9c1eb4d1` form no longer holds:
`099a314d5` shortened the name to 28 characters and added the `fcntl` step, but
on every early-return path the local `OwnedFd`
still drops, so "no retained handle" continues to describe the leak path.
Existing check: none. `RuntimeDir` has the analogous cleanup — `Drop` plus unwind
on two early returns — and the shm object has no equivalent.
Impact: each occurrence permanently consumes one Darwin shm namespace slot and
its backing pages, since nothing in the tree will ever unlink the name. Repeated
provider preparation attempts convert one transient error into monotone
exhaustion, after which `shm_open` with `O_EXCL` fails for unrelated reasons and
reports the same `ObjectSetupFailed` from a different line, which would also
corrupt the attribution the sibling record establishes. Linux is unaffected:
`memfd_create` objects are anonymous.
Open questions:

- Can `shm_unlink` fail after a successful `O_EXCL` `shm_open` on Darwin? If
  provably not, mark this record invalidated with that reason. (needs human
  input)
- Should `create_macos_shm` own an unwind matching `RuntimeDir`, or should the
  name never be unlinked before `ftruncate`? (needs human input)
- Is Darwin still a supported release surface? PR #131 (merge `5d638e3e8`)
  deleted the Darwin npm packages and the macOS CI jobs while
  `create_macos_shm` remains at `ring.rs:2176`, uncalled and behind the
  `ring.rs:1-2` compile error. If not, the leak window can never open and this
  record should be invalidated rather than left latent. (needs human input)

### layout-region-offsets-are-real-page-aligned

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — no test asserts any layout offset against the runtime page
size, and no CI host has a non-4096 page executing this code.
Guarantee: Every layout offset the code page-aligns is a multiple of the running
kernel's page size, so each region the layout separates occupies its own real
pages.
Check: `always` — for every constructed layout, `arena`, `lifecycle`, and `total`
are each multiples of `system_page_size()`. A per-construction structural
invariant, not a location to reach or a situation to encounter.
Fault/timing angle: none; fixed at construction and held for the mapping's
lifetime.
Required faults and enabling state: none beyond a host whose
`sysconf(_SC_PAGESIZE)` is not 4096, or an injectable page size in the layout
computation.
Confidence: high — [evidence](evidence/layout-region-offsets-are-real-page-aligned.md).
`Layout::new` (`ring.rs:141-182`) uses the 4096 constant at `:158-163`,
`:164-169`, and `:170-172`, while `system_page_size()` (`:194-200`) has exactly
one caller, `verify_prefaulted` (`:1009`). The divergence was computed, not
estimated: at depth 8 under a 16384-byte page, `arena % 16384 = 4096`,
`lifecycle % 16384 = 4096`, and `total % 16384 = 8192`; at depth 32 the figures
are 12288, 12288, and 0. Depth 32 passes the total condition only because
67,125,248 is 4097 x 16384.
Existing check: `residency_vector_tracks_runtime_page_size` (`ring.rs:1785-1795`)
asserts the pure `residency_vector_len` helper at 16 KiB and 64 KiB. It touches
no layout offset and no mapping.
Impact: on a 16 KiB-page host the lifecycle page — magic, layout version,
geometry, incarnation, lane, and the `quarantined` flag — shares one real page
with the arena's final 4096 bytes (12288 at depth 32), which are peer-writable
payload. Any page-granular mechanism, including `mprotect` to make the control
page read-only to one role, can no longer separate control state from payload.
The arena start is likewise off a real page boundary, and at depth 2 and 8 the
mapping carries 8192 addressable, never-initialised bytes past `mapping.len`.
Open questions:

- Are `arena` and `lifecycle` contractually page-separated, or is 4096 standing
  in for cacheline separation? Nothing records the intent, and the answer decides
  whether this is a defect or over-alignment. (needs human input)
- Should `total` be rounded to the runtime page size so the mapping carries no
  addressable slack past `len`? (needs human input)

### page-size-dependent-setup-runs-on-a-non-4096-page-host

Type: reachability
Reachability: default-production — the ring transport is the only application
transport and every accepted connection prepares a duplex ring:
`crates/mc-host/src/connection.rs:117` calls `ring.prepare`, which constructs
the pair via `DuplexRing::create` (`crates/mc-host/src/ring_transport.rs:248`).
The former support this preamble cited — a Darwin distribution package in tree —
is gone: PR #131 (merge `5d638e3e8`) deleted `packages/mc-host-darwin-*`
(`55f47ac64`) and left `.github/workflows/ci.yml` with only `ubuntu-latest`
jobs. The gap this record names is coverage, not reachability.
Status: active
Exercised: not yet — the only page-size assertion in the tree is a pure-function
unit test, and it runs only on a 4096-page x86-64 runner; since PR #131 removed
the macOS CI leg, CI provisions no non-4096-page host at all.
Guarantee: The full setup path that depends on page size — layout, `ftruncate`,
`mmap`, both prefault walks, `mincore`, and the `PrefaultFailed` gate — executes
on a host whose kernel page size is not 4096.
Check: `reachable` — assert `Ring::create` runs to completion where
`sysconf(_SC_PAGESIZE) != 4096`, and that `verify_prefaulted()` returns true
rather than merely that creation did not error. Location and environment
coverage: the code exists and is never executed under the condition that matters.
It must not assert a page-size violation.
Fault/timing angle: none; the condition is environmental and constant per host.
Required faults and enabling state: a runner whose page size is not 4096 — an
aarch64 Linux kernel with 16 KiB or 64 KiB pages — or an injectable page size.
Confidence: high — [evidence](evidence/page-size-dependent-setup-runs-on-a-non-4096-page-host.md).
The `a5568707` diff touched only `verify_prefaulted`, adding `system_page_size`
and `residency_vector_len`, and left `Layout::new` plus both prefault walks on
4096 — including `arena.rs:229`, a bare literal that does not reference the
constant. CI was read directly at the time; re-read at HEAD `bdf72f46a` after
PR #131 (merge `5d638e3e8`), `.github/workflows/ci.yml` has only
`ubuntu-latest` jobs — the macOS leg that ran
`--test contract --test fuzz_corpus` is gone, so nothing in CI runs any of this
crate off Linux. The `mincore` mismatch the fix repaired reproduces exactly in
arithmetic:
16386 entries sized against 4097 written, leaving 12289 zero.
Existing check: `residency_vector_tracks_runtime_page_size` (`ring.rs:1785-1795`),
a pure-function assertion with no mapping. The macOS CI leg that excluded it via
`--test` selection was removed with PR #131; no macOS job remains.
Impact: the configuration in which the previous defect lived has never been
executed end to end, so the residual defects in
`layout-region-offsets-are-real-page-aligned` are invisible to CI, as is any
future change reintroducing a 4096 assumption into the residency path. PR #131
removed the macOS job, so CI provisions no 16 KiB host at all; closing the gap
now requires an aarch64 Linux large-page job or an injectable page size rather
than a returning macOS runner.
Open questions:

- Add an aarch64 Linux job with a large-page kernel, or make the page size
  injectable so the path can be driven on any host? (needs human input)
- The former question about `macos-latest` provisioning a 16384-byte page is
  moot: PR #131 removed the macOS job, so CI has no 16 KiB host of any
  provenance.
- Is Darwin still a supported release surface? PR #131 (merge `5d638e3e8`)
  deleted the Darwin npm packages and the macOS CI jobs while the
  `cfg(target_os = "macos")` code path remains (`ring.rs:2176`, uncalled,
  behind the `ring.rs:1-2` compile error). If not, non-4096-page coverage must
  come from Linux, not from a restored macOS runner. (needs human input)

---

## Group K: the second backend

**The second backend no longer exists.** `0f336d3c` deleted
`crates/mc-shm-transport/src/backend/iceoryx.rs`,
`crates/mc-shm-transport/tests/iceoryx.rs`, and the `iceoryx` Cargo feature, and
collapsed the crate to the fixed ring transport. Every parity question this group
asked — which guarantees the second implementation also owes, and where it
diverges from the ring — is therefore moot, and all five records below carry
`Status: invalidated`: `0f336d3c` removed the backend, and the removal holds at
HEAD `46278f47a` after PR #131 (merge `5d638e3e8`). Their citations into
`iceoryx.rs` and
`tests/iceoryx.rs` resolve against `9c1eb4d1`, not against the current tree, and
are kept as the record of what the removed backend did and did not guarantee.

One finding transfers, and is the reason to keep the group rather than delete it:
a same-instance test structurally cannot prove a property whose predicate ranges
over two address spaces or two incarnations. That is a statement about test
topology, not about iceoryx, so it applies to any future second backend, and to
any single-process harness offered as evidence for a cross-process guarantee. It
is stated at length in `iceoryx-cross-process-pairing-is-reachable-or-declared`.

The iceoryx backend was a second implementation of the same contract. All 32
original records were derived from the ring backend, so this group existed to
state which guarantees iceoryx also owed and which it structurally could not
provide. The distinction between untested and unprovable is the point.

One correction carried into this group: an earlier pass called the iceoryx
release a no-op. It was not. `release(self)` took `self` by value, so the closing
brace ran drop glue that returned the chunk to the publisher's retrieve channel.
The reclamation was real and exactly-once by move semantics. What it did not do
is anything else: no identity argument, no validation, no counter, no completion
publication, and no `Result`.

### iceoryx-descriptor-rejection-is-terminal-or-declared

Type: safety
Reachability: test-only — when live, the `iceoryx` backend was a default Cargo
feature at `9c1eb4d1` but was constructed only from
`crates/mc-shm-transport/tests/iceoryx.rs` and the e2e mutation harness; no
host or client path referenced it. Invalidated rather than live: the feature and
`src/backend/iceoryx.rs` are gone, and
`crates/mc-shm-transport/src/backend/mod.rs:4-6` now declares only `ring` and
`sample`.
Status: invalidated
Exercised: not yet — no test makes `try_receive` return `Err`; the seven tests in
`tests/iceoryx.rs` are same-instance and the loopback publisher always writes the
sequence the receiver expects, so the rejection at `iceoryx.rs:167` never fires.
Guarantee: A sample the backend rejects as an invalid descriptor either leaves
the channel in a terminal state that fails every later operation closed, or the
rejection point is never reached.
Check: `always-or-unreached` — after `try_receive` returns
`Err(InvalidDescriptor)`, assert every later `try_reserve` and `try_receive`
reports a terminal state; the disjunct that currently holds is that the rejection
point is unreached. `always-or-unreached` rather than `always` because the
loopback topology cannot construct a mismatched sample under the compiled
provider configuration. Not `unreachable`: the forbidden thing is a backend state
after a rejection, not a code point, and there is no gate site to mark, which is
itself the finding.
Fault/timing angle: none needed once the trigger fires. The post-rejection state
is absorbing, because the only writer of `next_receive` (`iceoryx.rs:168`) sits
after the `?` on the failing call.
Required faults and enabling state: a sequence or identity mismatch in a
delivered sample. Either an external `iceoryx2.toml` setting
`backpressure_strategy` to `DiscardData` so a full-buffer send returns `Ok(0)`
while `iceoryx.rs:301` still advances `next_publish`, or a peer rewriting a
published prefix in the provider's segment. Neither is available today.
Confidence: high — [evidence](evidence/iceoryx-descriptor-rejection-is-terminal-or-declared.md).
`backend/mod.rs` was read in full: nine lines, and no trait, which is why none of
the missing parity is a compile error. `backend/iceoryx.rs` was searched for
`quarantine`, `conservation`, `completion`, `active_leases`, and `Drop`; all zero
hits, against the ring's gate set at `ring.rs:672-674`, `:767-769`, `:850-852`,
`:1001-1003`, and `:915-926`, and its quarantine raise at `:809`.
Existing check: none. No test drives a rejection through the backend and then
probes what it accepts.
Impact: the ring's terminal state is what converts storage of unknown state into
storage never reused. On iceoryx a rejected frame leaves a channel that keeps
accepting reservations and publishing, with one opaque error variant over nine
causes as the only signal. The parity ledger behind this record: sequence
monotonicity is provided but on process-local `Cell<u64>` rather than shared
pages; release identity validation is absent and soundly so, because the move
makes a wrong or duplicate identity unpresentable; incarnation fencing compares
against a locally minted value that is never exchanged, so it discriminates
nothing; quarantine and conservation reporting are absent with no substitute.
Invalidated: `0f336d3c` deleted the backend, so there is no code left to hold or
violate this property. What the record established is that the removed backend
had no terminal state after a rejected descriptor — the ring's quarantine had no
counterpart — and that the absence was invisible because `backend/mod.rs`
declared no trait, so no parity gap was a compile error.
Open questions:

- Is the loopback shape intended to be permanent? The ledger reads differently
  under each answer and no repository file states one. (needs human input)
- If iceoryx is meant to reach a designated host, does it owe a terminal state at
  all, or does the provider layer above it own condemnation? (needs human input)

Invalidated 2026-08-31: the iceoryx2 backend was removed by `0f336d3c` and
remains absent at HEAD `46278f47a` after PR #131 (merge `5d638e3e8`).

### iceoryx-receive-expectation-tracks-the-delivered-stream

Type: safety
Reachability: test-only — when live, the `iceoryx` backend was a default Cargo
feature at `9c1eb4d1` but was constructed only from
`crates/mc-shm-transport/tests/iceoryx.rs` and the e2e mutation harness; no
host or client path referenced it. Invalidated rather than live: the feature and
`src/backend/iceoryx.rs` are gone, and
`crates/mc-shm-transport/src/backend/mod.rs:4-6` now declares only `ring` and
`sample`.
Status: invalidated
Exercised: not yet — `sequences_progress_exactly_and_wrap_attempts_fail_closed`
(`tests/iceoryx.rs:123`) commits and receives one frame per iteration, so both
cursors advance in lockstep and never diverge.
Guarantee: The receiver's local sequence expectation never falls permanently
behind the delivered stream while the publisher keeps publishing successfully.
Check: `always` — after any rejected receive, assert either that `next_receive`
advanced past the rejected sequence, or that the backend reports the stream as
broken on every later call. A permanently stranded expectation is a forbidden
state with no dedicated detection point.
Fault/timing angle: no window and no concurrency. The dequeue at
`iceoryx.rs:151-157` is unconditional and the advance at `:168` is conditional,
so any rejection consumes a sequence from the stream without consuming one from
the expectation. The state is absorbing.
Required faults and enabling state: a divergence between delivered and expected
sequence. Three constructors: a restart on either side, blocked today by the
undisclosed random service name; a malformed sample, needing a peer write to the
provider segment; or a `DiscardData` global config plus a full subscriber buffer.
None available today.
Confidence: high — [evidence](evidence/iceoryx-receive-expectation-tracks-the-delivered-stream.md).
Verified the dequeue-before-validate-before-advance order at `iceoryx.rs:150-176`,
the incarnation, lane, and exact-sequence comparisons at `sample.rs:94-102`, and
the `Cell<u64>` cursors initialized to zero at `iceoryx.rs:43-44` and `:114-115`,
against the ring's shared-page cursors. The concrete restart consequence: a fresh
`create` sets `next_receive` to 0 so a restarted receiver expects sequence 1,
while a live publisher holding `next_publish == N` sends N+1;
`sample.rs:100-102` compares N+1 against 1 and returns `InvalidSequence`, the
sample is dropped, the expectation stays at 1, and every later frame carries a
larger sequence, so every later receive fails identically and forever.
Existing check: `tests/iceoryx.rs:123` covers exact progression on the happy path
and the empty-queue case. It never constructs divergence. Status unaudited.
Impact: a permanently unreadable stream on which the producer keeps consuming
loan capacity for frames the receiver will never accept, with no shared cursor to
reconcile against, no terminal state, and one opaque error variant. This record
and the previous one share a code point from two sides: this one owns the cursor
obligation, that one owns the fail-closed obligation. Invalidated: `0f336d3c`
deleted the backend. What the record established is that the removed backend's
receive cursor was an unconditionally-advanced dequeue paired with a conditional
expectation advance, over process-local `Cell<u64>` rather than shared pages, so
one rejected sample stranded the expectation permanently with no shared cursor to
reconcile against.
Open questions:

- Was the `Cell<u64>` pair intended as a same-instance smoke-test device rather
  than a transport cursor? If so the record scopes down to a documentation
  obligation. (needs human input)

Invalidated 2026-08-31: the iceoryx2 backend was removed by `0f336d3c` and
remains absent at HEAD `46278f47a` after PR #131 (merge `5d638e3e8`).

### iceoryx-cross-process-pairing-is-reachable-or-declared

Type: reachability
Reachability: test-only — when live, the `iceoryx` backend was a default Cargo
feature at `9c1eb4d1` but was constructed only from
`crates/mc-shm-transport/tests/iceoryx.rs` and the e2e mutation harness; no
host or client path referenced it. Invalidated rather than live: the feature and
`src/backend/iceoryx.rs` are gone, and
`crates/mc-shm-transport/src/backend/mod.rs:4-6` now declares only `ring` and
`sample`.
Status: invalidated
Exercised: not yet, and not constructible without an API change;
`IceoryxBackend::create(profile, lane)` accepts neither an inbound service name
nor an inbound incarnation.
Guarantee: For a backend advertised as a candidate transport between two
processes, a frame actually crosses a process boundary at least once, or the
loopback-only basis of its evidence is declared where the release gate reads it.
Check: `sometimes` — across a campaign, at least one iceoryx frame is published
by one process and received by a different process. `sometimes` rather than
`reachable` because this is a situation spanning two address spaces, not a code
location: a same-instance test executes every line on the path while never
producing the operational state the arm represents. The check cannot fire today,
and its not firing is the evidence.
Fault/timing angle: none. This is a static property of the constructor.
Required faults and enabling state: none to observe the gap. To close it, an API
accepting a service name and incarnation from an authenticated setup channel, the
way `Ring::attach` takes a `RingGrant`.
Confidence: high — [evidence](evidence/iceoryx-cross-process-pairing-is-reachable-or-declared.md).
Three independent facts, each sufficient alone: the service name is built from 16
`getrandom` bytes inside `create` (`iceoryx.rs:57-69`), is not stored on the
struct, has no accessor, and appears nowhere else, so nothing can learn or supply
it and `open_or_create` always creates; `max_publishers(1)` and
`max_subscribers(1)` (`:76-77`) are both consumed by the creator, and iceoryx2
fails a port beyond the bound at creation; and the expected incarnation is minted
locally and read from `self.incarnation` at `:163`, with `sample.rs:94-96`
rejecting any other. All seven tests and the bench arm construct exactly one
backend used as both producer and receiver.
Existing check: none for pairing. `tests/iceoryx.rs` is same-instance throughout.
Impact: nothing authenticated the peer because the design admitted no peer. The
consequence was evidential: the arm was `selectable` in the release-gate manifest
(`benches/manifests/v1.json:107-110` at `9c1eb4d1`) as one of two candidate
providers for a
transport whose purpose is moving frames between processes, while the same bench
report classified it as a loopback smoke arm against nine paired-process arms. A
same-instance test structurally cannot prove any property whose predicate ranges
over two address spaces or two incarnations: publication visibility across a real
release-acquire edge, peer authentication at attach, geometry binding, restart
reconciliation, stale-cursor handling. Those are not untested; they are
unprovable on such a backend as constructed. Invalidated: `0f336d3c` deleted the
backend, and the manifest's `selectable` list with it — the arms block now reads
`"transport": ["ring"]` (`benches/manifests/v1.json:107`) with no second candidate
to declare. What the record established, and the part that outlives the backend,
is the topology argument in the preceding paragraph: it is a statement about
same-instance harnesses, so it binds any future second backend.
Open questions:

- The two questions about `selectable: true` and about disjoint loopback-smoke and
  `selectable` lists are moot: `0f336d3c` left one transport arm and removed the
  `selectable` key. The general form survives and belongs to whichever gate
  reintroduces a second arm: must a same-instance arm be barred from the
  candidate list? (needs human input)

Invalidated 2026-08-31: the iceoryx2 backend was removed by `0f336d3c` and
remains absent at HEAD `46278f47a` after PR #131 (merge `5d638e3e8`).

### iceoryx-completion-is-observable-to-the-host

Type: safety
Reachability: test-only — when live, the `iceoryx` backend was a default Cargo
feature at `9c1eb4d1` but was constructed only from
`crates/mc-shm-transport/tests/iceoryx.rs` and the e2e mutation harness; no
host or client path referenced it. Invalidated rather than live: the feature and
`src/backend/iceoryx.rs` are gone, and
`crates/mc-shm-transport/src/backend/mod.rs:4-6` now declares only `ring` and
`sample`.
Status: invalidated
Exercised: not yet — needs leases disposed both ways with an assertion that some
observation distinguishes outstanding from reclaimed; no such observation exists
to assert against.
Guarantee: The number of outstanding iceoryx samples is derivable from an
observation the backend exposes, and an explicitly released lease is
distinguishable from an abandoned one.
Check: `always` — at every point, assert an observation exists on the backend
reporting outstanding versus reclaimed samples. The clause requiring "a readiness
answer shaped like the one `provider_recovery.rs:530` consumes" is withdrawn:
`ed487e11` deleted that consumer and the whole `ProviderReadiness` model, so no
host surface now defines the shape. There is no
gate site so `unreachable` does not apply, and no convergence so this is not a
liveness form. The check fails by construction today, which the record states
rather than implies.
Fault/timing angle: none, and no window. The absent surface is a static fact
about the module.
Required faults and enabling state: none. The gap is observable by reading the
public surface.
Confidence: high — [evidence](evidence/iceoryx-completion-is-observable-to-the-host.md).
`iceoryx.rs:319-355` was read in full and searched for `impl Drop`,
`conservation`, `probe`, `quarantine`, `completion`, and `active_leases`; all zero
hits, against the ring's `release` (`ring.rs:849-911`, whose successful path
stores `completion_sequence` and decrements `active_leases` at `:904-908`),
`conservation` (`:914-997`), and `probe` (`:1000-1005`). The iceoryx lease meets
exactly-once completion by move semantics rather than by a check: sound, but
silent. The host-side comparator is gone: the former `provider_recovery.rs:530`
decided readiness from `backend.probe() && backend.admission_fits()` and had no
iceoryx path in, and `ed487e11` deleted it. The gap on the iceoryx backend itself
is unchanged, so the record stays active with the readiness clause withdrawn.
Existing check: none on the backend. The bench arm's counters are constants,
which is a downstream instance of `operation-counters-are-observed-not-declared`
rather than new coverage.
Impact: a host adopting this backend could not observe reclamation. A lease
dropped on a cancellation path reclaims correctly and produces no record,
indistinguishable from one leaked into a long-lived collection, up to the borrow
cap, where the symptom surfaces on the other side as `ReceiveFailed` attributed
to the receive mechanism rather than to retained leases. Combined with the
constant counters, a body copy added anywhere in `run_iceoryx` would change none
of the six fields the gate names as required. Invalidated: `0f336d3c` deleted the
backend, and `ed487e11` had already deleted the host-side readiness consumer. What
the record established is that the removed backend met exactly-once completion by
move semantics rather than by a check — sound, but silent — so it exposed no
observation from which outstanding samples could be counted, and an explicitly
released lease was indistinguishable from an abandoned one.
Open questions:

- Is `stale_node_observed` (`iceoryx.rs:178-189`) intended as the readiness
  surface? It is an associated function over global dead-node entries, keyed to
  nothing about a given instance's samples. (needs human input)

Invalidated 2026-08-31: the iceoryx2 backend was removed by `0f336d3c` and
remains absent at HEAD `46278f47a` after PR #131 (merge `5d638e3e8`).

### iceoryx-saturation-is-bounded-non-blocking-backpressure

Type: liveness
Reachability: test-only — when live, the `iceoryx` backend was a default Cargo
feature at `9c1eb4d1` but was constructed only from
`crates/mc-shm-transport/tests/iceoryx.rs` and the e2e mutation harness; no
host or client path referenced it. Invalidated rather than live: the feature and
`src/backend/iceoryx.rs` are gone, and
`crates/mc-shm-transport/src/backend/mod.rs:4-6` now declares only `ring` and
`sample`.
Status: invalidated
Exercised: not yet — every test receives and releases immediately after each
commit, so neither configured cap is ever reached.
Guarantee: When a configured capacity limit binds, the backend returns control to
the caller with a bounded, non-terminal code rather than blocking indefinitely or
reporting a channel-ending fault.
Check: `always` — reserve and commit past the subscriber buffer bound with no
intervening receive and assert the final `commit` returns within a deadline as
some bounded error; separately, retain `max_leases` leases and assert
`try_receive` returns `Ok(None)` rather than `Err`, then release one and assert
the queued frame arrives. `always` in the bounded-liveness sense used by
`crashed-producer-does-not-wedge-the-sequence`: the obligation holds whenever the
state is entered, checked in a fault-free window after it is established.
Fault/timing angle: no window; both are state conditions reached by counting
operations and permanent while the state holds. The publish-side block is
unbounded in wall-clock time and unbreakable on one thread, because the backend
pins both ports to one thread via `_not_send: PhantomData<Rc<()>>`
(`iceoryx.rs:45`), so the only party that could drain the queue is the thread
blocked inside `send()`.
Required faults and enabling state: none; no fault class and no concurrency.
Publish side: `descriptor_depth + 1` commits with no receive. Receive side:
publish to the buffer bound, retain `max_leases` leases, publish once more. A
plain test on the publish side hangs, so the harness needs a terminating timeout.
Confidence: high — [evidence](evidence/iceoryx-saturation-is-bounded-non-blocking-backpressure.md).
The compiled default was traced: the publisher builder (`iceoryx.rs:89-106`)
never sets a backpressure strategy, so it inherits `RetryUntilDelivered`; with
`enable_safe_overflow(false)` (`:80`) the send routes to a blocking path that
spins while the submission queue is full. On the receive side the library returns
an exceeds-max-borrows error when every channel with data sits at the borrow cap,
and `iceoryx.rs:151-157` collapses every receive error into
`IceoryxError::ReceiveFailed`, indistinguishable from a connection failure.
Existing check: none on iceoryx. The ring's counterpart is pinned at
`tests/ring.rs:279`. Status unaudited.
Impact: the ring answers a full descriptor set with `Exhausted`, which
`reserve_until` converts to `Deadline`, and a full lease set with `Ok(None)` under
the stated rule that a full lease set is backpressure and errors are reserved for
channel-ending faults. The iceoryx path violates both halves: the publisher can
hang forever with no deadline parameter, and normal receive backpressure is
reported as a fault. Both caps are handed to the provider and never consulted
locally, so the backend cannot report saturation in its own vocabulary.
Invalidated: `0f336d3c` deleted the backend. What the record established is that the
removed backend inherited its backpressure strategy from an external
`iceoryx2.toml` rather than pinning it, so a full publish queue blocked
indefinitely on the one thread that could have drained it, and ordinary receive
backpressure was reported as a channel-ending fault — the opposite of the ring's
`Exhausted`-plus-`Ok(None)` split, which survives.
Open questions:

- Does any designated host's global config override the backpressure strategy? No
  repository file sets it and no test asserts it, and the two possible values give
  opposite uncontracted outcomes: unbounded blocking, or silent frame loss.
  (needs human input)
- Should the backend pin the strategy explicitly rather than inherit it from an
  external file? (needs human input)

Invalidated 2026-08-31: the iceoryx2 backend was removed by `0f336d3c` and
remains absent at HEAD `46278f47a` after PR #131 (merge `5d638e3e8`).

---

## Group L: boundary composition

These records are about the division of responsibility between the transport and
the host, not about either layer's individual checks. The transport validates two
header fields; the host validates the rest. The ordering is correct at HEAD, and
nothing pins it. The dependency edge runs host-to-transport, so the validating
crate cannot import the types it is validating, which is why the composition has
to be a property rather than a shared function.

Field-by-field, the transport checks only `len` (equal to `body_len`, and within
`MAX_FRAME_BYTES`) and `ver` (equal to 2). The host's `decode_header` checks the
frame type, reserved flag bits, reserved priority and admission class, illegal
sheddable, and the channel-and-epoch pairing rules; `validate_inbound_header`
adds the body-length cap, pure-header flag pairing, and the consumer role gate.
The correlation field is unvalidated by design.

### wire-header-fully-validated-before-any-consumer-acts

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Reaches production: yes
Status: active
Exercised: partial — the pre-#131 `crates/mc-host/tests/shm_failure_modes.rs:195`
published one
header the transport accepts and the host rejects, but asserted only the
downstream quarantine, so it could not distinguish rejection before the charge from
rejection after it. That test is absent from the rewritten post-#131 file
(refresh note 2026-08-31), so even this partial arm needs re-establishing.
Missing: any assertion that no ingress permit was taken and no
inbound event emitted.
Guarantee: No consumer of a shared-memory frame acts on any header field, or on
the body it describes, before both host header gates have accepted it.
Check: `always` — on every receive that yields a lease, `decode_header` and
`validate_inbound_header` both return `Ok` before the ingress charge
(`ring_transport.rs:520`), the body copy (`:544`), and any send on `inbound`
(`:510`, `:549-556`). An ordering invariant evaluated at every receive, with no
optional path and no convergence to wait for.
Fault/timing angle: none required. The descriptor is snapshotted by one
`read_volatile` (`ring.rs:1093`), so the 21 header bytes are frozen locally before
either layer inspects them, and there is no time-of-check window between the two
layers. The window that makes the ordering load-bearing is the ingress wait loop
(`ring_transport.rs:519-542`), bounded by `frame_deadline`: that is the resource
an out-of-order gate would let an illegal frame hold.
Required faults and enabling state: a peer-authored header satisfying exactly the
transport's two checks and violating one host rule. No concurrency, no timing.
Confidence: high — [evidence](evidence/wire-header-fully-validated-before-any-consumer-acts.md).
`descriptor.rs:265-273` is the transport's only header inspection; `receive_one`
runs its seven steps in the order above with `?` on each, and nothing between
`ring_transport.rs:498` and `:505` reads a header field or a payload byte.
`WIRE_V2_HEADER_BYTES`
equals `HEADER_LEN` at 21, so `decode_header`'s truncation gates
(`wire.rs:312-322`) are statically dead on this path.
Existing check: the pre-#131 `shm_failure_modes.rs:195`
`corrupt_peer_frame_quarantines_exact_charges_and_returns_ready` (one role-invalid
type, quarantine outcome only) was removed in the #131 test rewrite; no
successor found at HEAD. Status unaudited as an ordering oracle.
Impact: this is the ordering the trust boundary rests on, and it is correct at
HEAD. Cataloged because nothing fails if it stops being correct. Moving the charge
or the copy above `ring_transport.rs:503` lets a peer hold up to 64 MiB of ingress
budget for a
frame deadline on a frame already known illegal, and the transport cannot
compensate, because `mc-host` depends on `mc-shm-transport` and so `FrameType`,
`Flags`, and the protocol version are unreachable from the validating crate.
Open questions:

- The control-cap branch (`ring_transport.rs:506-517`) releases the lease and
  answers `Rejected` rather than closing, a fourth disposition. Is a per-channel
  body cap a header rule or an admission rule? (needs human input)
- A version 3 relocating `len` or `ver` is permitted by the extension point at
  `wire.rs:301-306` and would leave `descriptor.rs:265-270` silently validating
  offsets 0..5 of a different layout. Should the transport's two checks be
  versioned, or replaced by a host-supplied predicate? (needs human input)

### ingress-charge-matches-the-bytes-copied-from-shared-storage

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Reaches production: yes
Status: active
Exercised: not yet — needs the per-frame equality assertion at admission. The
transport's two checks are exercised only in isolation, never against a host that
consumes their guarantee.
Guarantee: The ingress budget a shared-memory frame charges equals the number of
body bytes later copied out of shared storage for it.
Check: `always` — for every inbound frame the shared-memory read path emits, the
charged byte count equals the body length. `always` rather than `unreachable`: the
forbidden state is a delivered frame whose charge and body disagree, and the
divergence would arise at an ordinary, always-executed statement pair.
Fault/timing angle: no interleaving; the charge (`ring_transport.rs:520`) and the
copy (`:544`) are consecutive. The exposure window is the drift interval between
two crates: `header.len` is bytes 0..4 of the peer-authored header, `to_vec` fills
the descriptor's `body_len` (`lease.rs:164-182`), and the host never compares them.
Required faults and enabling state: none to pin the property. To demonstrate the
impact, a peer writing the descriptor page directly, which the mapping permits.
Confidence: high — [evidence](evidence/ingress-charge-matches-the-bytes-copied-from-shared-storage.md).
The sole enforcement point is `descriptor.rs:265-273`, called from
`Ring::try_receive` at `ring.rs:1095`, which refuses a lease otherwise.
Downstream, nothing re-derives it: `InboundFrame::owned`
(`frame_channel.rs:433-445`) stores header, body, and byte charge side by side
without comparing them. The bounding constants are independently defined 64 MiB
values, `MAX_FRAME_BYTES` (`arena.rs:4`) and `MAX_FRAME_BODY_LEN` (`wire.rs:31`),
and the dependency edge runs host-to-transport, so the transport can import
neither the constant nor the header type it validates.
Existing check: none for the composition. The transport's two checks are covered
alone at `tests/contract.rs:173`, `:636`, and `:645`; the wire-header setter has
no test at all. Status unaudited.
Impact: `descriptor.rs:271` is the only thing making the host's ingress accounting
mean anything. Relax it, weaken it to a bound, or feature-gate it, and a peer sets
host admission accounting from a field unrelated to the bytes moved. The
balanced-but-wrong case, charge 64 MiB and copy 64 bytes, is a cheap
budget-exhaustion primitive, because the ingress wait loop is what other receives
block on and the resulting overload close is classified clean.
Open questions:

- Should the equality also be asserted host-side, given the host owns the header
  format while the transport owns the only check? (needs human input)
- Whether any consumer above the inbound event compares the header length to the
  body it receives is Part 2 surface and was not read. (partial)

### every-shm-header-consumer-applies-its-role-gate

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Reaches production: yes
Status: active
Exercised: partial — the host arm is exercised end to end for one illegal type.
The peer arm has no test, and the oracle it needs does not exist: today the frame
is released and nothing observable changes.
Guarantee: Every consumer that receives the transport's 21 header bytes applies
its own role gate, so a role-invalid frame retires the generation on whichever
side receives it.
Check: `always` — for each illegal type in the receiving side's role set, the
consumer closes the generation: a corrupt-read close on the host, and a
role-violation close on the peer. The obligation is per-frame and normative, and
the forbidden state, a role-invalid frame silently released with the generation
open, has no dedicated detection point.
Fault/timing angle: none; static per-consumer coverage, both branches present at
HEAD.
Required faults and enabling state: a role-invalid publish into each direction.
The peer arm needs the frame to come from the host side, so the fault is a
compromised or regressed host, inside a trust model that already grants a
same-user peer write access to mapped payload.
Confidence: medium — [evidence](evidence/every-shm-header-consumer-applies-its-role-gate.md).
The omission is verified by direct read and a repository-wide search for the
header-violation helper, whose only call sites were its definition, the TCP frame
channel, and the transport provider. The shared-memory channel's drain decoded the
header and passed straight to the frame handler, and the shared validator has no
role rule, while the dispatch default releases the body quietly with the
role-restricted types all inside the range check. Medium because reachability is
unresolved, which is what sets the urgency. (Pre-#131 client evidence: the #131
rewrite deleted `tcp-frame-channel.ts` and `transport-provider.ts` and
`shm-frame-channel.ts` now imports `headerViolation` (`:19`) and calls it at
`:348`; see the 2026-08-31 refresh note in the evidence file — this record
needs mechanism-level re-derivation, not just citation refresh.)
Existing check: host arm only, one type. Nothing on the peer arm. Status
unaudited.
Impact: over TCP a role-invalid frame retires the generation with an explicit
reason; over shared memory the identical frame is released and the generation
stays open, with no diagnostic, counter, or close reason, which is the implicit
profile extension the wire document forbids. The record straddles the part
boundary, since the peer consumer lives in `packages/plugin`, assigned to Part 5.
Open questions:

- Is the shared-memory frame channel reachable in any shipped configuration, or
  only through an injected factory? Empty registries are reported for Part 1 as a
  whole and were not re-derived for the client package. (partial)
- Should the role gate move inside the shared header decoder so no consumer can
  forget it, given the provider-lease path already pairs validation with the
  violation call? (needs human input)

### header-rejection-effect-does-not-depend-on-the-catching-layer

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — one host-caught rejection is constructed but only the
admission side is observed; nothing constructs a transport-caught header rejection
end to end, and nothing observes the ring or the peer after either.
Guarantee: A malformed header field produces one declared terminal effect,
independent of which layer's check rejected it.
Check: `always` — for every peer-authored header rejected on the receive path, the
ring's `quarantined` byte, the descriptor slot state, and the admission-charge
disposition match one declared contract. `always`, not `unreachable`: the
forbidden state is two different terminal effects for one input class, and no
single code point must never execute.
Fault/timing angle: no window on the rejection; both paths are straight-line. One
on observability: the peer can read the quarantine byte only while it holds a
mapping, so its window to notice is bounded by its own lifetime rather than the
host's, and that byte is peer-writable, so the signal the transport path emits is
one a peer can erase.
Required faults and enabling state: two rejections of the same class caught at
different layers. The transport-caught one requires a direct descriptor-page
write, because `commit_reservation` re-checks both fields (`ring.rs:1585-1593`),
so the producer API cannot express it.
Confidence: high — [evidence](evidence/header-rejection-effect-does-not-depend-on-the-catching-layer.md).
`enter_quarantine` has exactly one caller, the descriptor-validation arm at
`ring.rs:1098`; no host path reaches it. There `consumed` is never advanced, since
the advance is at `:1116` past the error, so the slot stays `RECEIVER_HELD`. On the
host paths the dropped lease releases and `consumed` has already advanced. The
convergence point changed: both used to meet the clean-close classification at the
former `shm_provider.rs:498` and fall into `report_suspect`, where cleanup answered
`Uncertain` for every input and quarantined the charges. `ed487e11` deleted that
classification and the whole suspect path, so both now converge at
`crates/mc-host/src/ring_transport.rs:406-411`, which sends the `ReadClose`
inbound and cancels without branching on it, and then at `:276`, which releases the
charges unconditionally. The admission outcome is still identical across the two
layers, which is what the record asserts, but it is now unconditional release
rather than quarantine. The reason is then discarded:
`connection.rs:362-365` folds clean EOF, corrupt, I/O, and overloaded into one
peer-exit variant.
Existing check: none for the disposition. One host-caught case asserts the
quarantined charge tuple and the return to ready. Peer-originated quarantine is
untested, and no check distinguishes self-quarantine from peer-quarantine. Status
unaudited.
Impact: two adjacent malformed headers yield one accounting outcome and two
peer-visible outcomes. A transport-caught field gives the peer an unambiguous
quarantined terminal; a host-caught field gives it nothing, so it keeps publishing
and sees `Exhausted` then `Deadline`, codes meaning try again later. In neither
case is the failing field recorded anywhere, and `enter_quarantine` is itself
best-effort, no-oping if the lifecycle pointer computation fails.
Open questions:

- Is the transport path's ring quarantine intended for all header rejections, or
  an artifact of descriptor validation sitting below the trust boundary? The
  documented close ordering covers unknown alias state, not a protocol rejection.
  (needs human input)
- Should a header rejection be distinguishable from a clean EOF outside the
  endpoint thread? Today only a boolean survives, and it carries no reason.
  (needs human input)

### runtime-directory-authentication-is-a-precondition-not-a-container

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — no test references the runtime directory at all, and
revalidation is never negative-tested.
Guarantee: The runtime directory is admitted only when its by-path and
by-descriptor views name one inode that is a directory owned by the effective user
at mode 0700, and that conjunction is re-established before every ring creation.
Check: `always` — for each divergence an adversary can present (path replaced by a
symlink, by a different real directory, by a non-directory; mode widened; owner
changed), both `create_in` and `validate` return `ObjectValidationFailed`
specifically, and `Ring::create_in` refuses. A per-call invariant over
adversary-chosen filesystem state.
Fault/timing angle: two narrow windows. From `mkdir` (`ring.rs:313`) to the open
(`:316-320`), closed after the fact by the inode equality check at `:334`, which
detects a swap rather than preventing it; and between any `validate()` and the
operation that follows, which is object creation that does not use the directory.
`O_NOFOLLOW` covers only the final component, and the root is the process
temporary directory.
Required faults and enabling state: filesystem tampering between creation and use.
Four of the five cases are constructible unprivileged in a temporary root; the
owner-change case needs a second user or a container and may have to be recorded
as unconstructible in CI rather than skipped silently.
Confidence: high — [evidence](evidence/runtime-directory-authentication-is-a-precondition-not-a-container.md).
A repository-wide search returns only the definition (`ring.rs:291-377`), the two
creation sites (`:545`, `:1420`), and two struct fields, with nothing in the test
directory. `create_in` and `validate` each evaluate the same five clauses. The
directory holds nothing on either platform: `Mapping::create` takes a length and
no path; Linux uses an anonymous memfd; macOS uses `shm_open` in the global POSIX
namespace and unlinks the name before mapping. Object authentication is
descriptor-based and independent.
Existing check: none. Object and runtime-directory authentication are listed as
one unaudited guard cluster, and revalidation is never negative-tested. The happy
path runs on every `Ring::create` in the ring tests.
Impact: low, for a specific reason: defeating the checks gains nothing, because no
object is inside the directory on any supported platform. The reachable
consequence of tampering is a refusal, so the candidate fails to prepare and the
host falls back to TCP. The residual is teardown: `Drop` (`:373-377`) calls
`remove_dir` by path with no `validate()` first, so with the temporary root naming
an attacker-writable directory lacking the sticky bit, they can substitute their
own directory under our name and have our `Drop` remove theirs, a narrow same-user
denial primitive. What is actually worth guarding is a belief: a future change
storing something real here would inherit an authentication covering only the
container.
Open questions:

- Is the directory a remnant of an earlier file-backed design, or a deliberate
  environment sanity check? The doc comment at `ring.rs:543` implies the object is
  under it; it is not. Git archaeology was not performed. (needs human input)
- Should `Drop` revalidate before removing, that being the one unauthenticated use
  of the path? (needs human input)

---

## Group M: normal-operation liveness

Every liveness record before this group concerns a failure. A transport that never
wedges but also never makes progress satisfied the earlier catalog. This group
states what progress means, and it carries the portfolio's first situation-coverage
records, because the liveness properties here are vacuous unless a campaign proves
it reached the states they range over.

Bounded windows are mandatory in this group. An unbounded "eventually" cannot be
refuted by a finite test, and a generous deadline cannot distinguish one reclaim
pass from a thousand, so each record states its bound in producer attempts or in
an explicit interval.

### backpressure-converges-in-a-bounded-reclaim-window

Type: liveness
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — the one convergence assertion that exists is cross-process,
covers arena exhaustion only, and bounds nothing tighter than five seconds.
Guarantee: While a receiver keeps draining and releasing, a producer that hits
descriptor or arena exhaustion reserves successfully inside its deadline.
Check: `always` — run under real exhaustion, stop the pressure by releasing every
lease, then require the next single `try_reserve` to succeed, and require
`reserve_until` with a deadline set beyond the release to return `Ok` strictly
inside it. The bounded fault-free window is one `try_reserve` after the release
becomes visible, because `reclaim_completed` drains the whole contiguous completed
prefix per call and is invoked at the head of `try_reserve` (`ring.rs:916`).
Fault/timing angle: three independent conditions all surface as
`ProducerError::Exhausted` — depth full (`:926-928`), a lost reservation
compare-exchange (`:938-943`), and arena exhaustion (`:949-955`) — and only
that variant is retried (`reserve_until`, `:980-1048`). Retries no longer
poll: between attempts the producer parks a generation-bound epoch
(`:995-1000`), re-runs `try_reserve` after parking (`:1001`) and after
draining the doorbell (`:1020`), rechecks the generation (`:1012`, `:1031`),
and blocks in `capacity_ready.wait_until(deadline)` (`:1035`). `release`
signals `capacity_ready` (`:1236-1241`) through `signal_wake` (`:1418`), which
bumps the generation and writes the eventfd only when a waiter was parked, so
the hazard is a lost wake rather than a slow poll, and doorbell wake latency
replaces the former 50-microsecond poll quantum as the floor on any asserted
bound. `POLL_INTERVAL` survives only in
`crates/mc-host/tests/support/process_resources.rs`, a test-support constant
unrelated to this path.
Required faults and enabling state: genuine exhaustion of either capacity, then
removal of the pressure. Two arms, because only the arena arm is covered today.
Enabling situation `shm_arena_wrap_with_live_lease`; the descriptor arm needs no
marker.
Confidence: high — [evidence](evidence/backpressure-converges-in-a-bounded-reclaim-window.md).
`reclaim_completed`'s sole call site in the repository is `try_reserve`, so
reclamation is producer-driven and a retry is the act that recovers capacity; the
reclaim loop exits only at the first gap, an error, or an exhausted prefix
(`:1478-1505`); and the compare-exchange at `:938-943` cannot lose fault-free,
because `slot_ptr` maps sequence to `(sequence - 1) % descriptor_depth`
(`:1438`) and the depth gate already puts that slot's previous user at or
below `completed`, hence freed (`:1554`).
Existing check: partial —
`two_process_zero_copy_exchange_uses_authenticated_grant`
(`tests/ring.rs:551-592`). A `reserve_until` with a five-second deadline
(`:575-582`) converges after the child releases, and an elapsed-time assertion
(`:583`) keeps it from passing vacuously. Status unaudited. The give-up path is
pinned separately at `:181-185`.
Impact: this is the only statement in the catalog that the transport makes forward
progress in normal operation. A recovery-chain defect presents as
`ProducerError::Deadline`, which the host converts into a failed publish, a
cancelled generation, and a suspect record: a transport fault reported on a
channel whose peer was draining correctly.
Open questions:

- What inner bound should the cross-process arm assert? The existing test pairs a
  50 ms sleep with a five-second deadline, three orders of magnitude of slack, so
  it measures no latency and a per-pass reclaimer would pass it.

### receive-resumes-when-lease-capacity-clears

Type: liveness
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — the existing test asserts absence without pinning that a
frame was pending, and the shipped host cannot reach saturation at all.
Guarantee: When `try_receive` declines because every lease is held, the queued
frames are still deliverable, and releasing a lease makes the oldest one available
again without loss or reordering.
Check: `always-or-unreached` — at the declining return, require `conservation()`
to report `receiver_leased == max_leases` and `published >= 1`; then release one
lease and require the immediately following `try_receive` to return the frame
whose sequence equals the pre-saturation `consumed + 1`. The window is exactly one
call, because both gates are pure reads of state the release already updated. A
consumer parked in `wait_for_data` (`ring.rs:1138`) instead of calling again
does not weaken the window: the same release signals the `data_ready` doorbell
(`:1236-1241`), and `data_available` (`:1160-1172`) returns true only when
`published != consumed` and `active < max_leases`, so the saturation state is
exactly the one that parks a waiter and the release's signal is what un-parks
it. `always-or-unreached` because the saturation state is unreachable in the
shipped host: `receive_one` holds at most one of eight leases and releases it
on every path.
Fault/timing angle: no race — the counter is incremented and decremented by the
same thread-confined receiver. The hazard is representational: the declining
return is used both for saturation (`ring.rs:1063-1068`) and for an empty ring
(`:1073-1075`), and the saturation gate is taken before `consumed` or `published`
is read at all, so the value carries no reason. A second hazard is new with the
eventfd mechanism: a release whose `data_ready` signal is lost leaves a parked
`wait_for_data` consumer asleep until its deadline even though the state gates
would pass, so the recovery assertion must use a direct `try_receive` to test
the state and a parked waiter to test the wake, not one call for both.
Required faults and enabling state: a profile whose `max_leases` is reachable and
strictly greater than one, plus at least one frame published beyond the leased
set, which requires `descriptor_depth > max_leases`. Without the second, the
emptiness gate fires first and the check proves nothing. Coverage marker
`shm_lease_saturation_observed_then_drained`.
Confidence: high — [evidence](evidence/receive-resumes-when-lease-capacity-clears.md).
Both gates and the single decrement site were read directly, and every
`receive_one` return path in the host was traced to confirm one lease per call.
Existing check: `lease_limit_reports_backpressure_then_recovers_after_release`
(`tests/ring.rs:272-286`) against a profile with depth 2 and one lease. The
recovery half is real; the saturation half asserts only absence. Status unaudited,
and the oracle cannot distinguish saturation from an empty ring, which is the gap
this record closes.
Impact: a release-path defect leaves the lease counter pinned at the cap and every
later receive returns what an idle channel returns. The endpoint arms its data
wait and parks on the doorbell (`ring_transport.rs:429`, `:459`) and no error,
quarantine, or counter fires: the silent capacity-loss signature of
`attach-reconciles-or-refuses-stale-shared-cursors`, reached with no crash.
Open questions:

- Does the addon receive path saturate where the Rust host cannot? It retains
  leases deliberately, per the reachability analysis in
  `release-authority-bound-to-lease-ownership`, so it is the one shipped consumer
  that plausibly reaches the cap. Whether the property is latent or live depends
  on that answer. (needs human input)

### neither-direction-starves-the-other

Type: liveness
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — no test has ever had frames in flight in both directions at
once, so the alternation machinery is dead code under the existing traffic shape.
Guarantee: Under simultaneous load in both directions, each direction keeps making
progress, and once the offered load stops both directions drain.
Check: `always`, in two arms. Ratio: while both directions are offered
continuously, neither may complete fewer than one frame per K completions of the
other, with K pinned by the test from its own configuration and recorded in the
test. The only per-lane stall bound the code enforces is `frame_deadline`: the
outbound `reserve_until` deadline (`ring_transport.rs:583`, `ring.rs:980`) and
the inbound sender's admission timeout (`frame_channel.rs:640-652`). The
former `frame_deadline / POLL_INTERVAL` derivation is void: waits park on
eventfd doorbells with no retry quantum, and `POLL_INTERVAL` survives only in
`crates/mc-host/tests/support/process_resources.rs`. Bounded drain: stop
offering both ways, poll until stable within an explicit bound, then require
both queues empty, all descriptors free on both rings, and no close reported,
strictly inside the bound. The stalls below are bounded rather than deadlocks,
so an unbounded formulation would be both weaker and unrefutable.
Fault/timing angle: two asymmetric mechanisms, both on one task on one dedicated
thread with its own current-thread runtime. Outbound blocks inbound:
`publish_one` (`ring_transport.rs:560`, called at `:479` and `:535`) is
synchronous and parks inside `Ring::reserve_until` on the `capacity_ready`
doorbell (`ring.rs:1035`) with no await point, for up to `frame_deadline`,
during which no receive runs. Inbound blocks outbound: the inbound send is
awaited with no timeout and no enclosing select
(`ring_transport.rs:551-556`), so it parks until the application drains.
Neither is infinite: the first ends in an unclean close, the second in the
sender's own admission timeout.
Required faults and enabling state: genuine overlap, plus capacity pressure on one
lane. The peer harness cannot produce overlap today: `RingClientEndpoint::send`
blocks in `reserve_until` (`ring_transport.rs:692`) and `recv` blocks in
`wait_for_data` (`:710`); `try_recv` (`:718`) is non-blocking, but nothing
drives send and receive concurrently. Coverage marker
`shm_both_directions_in_flight`, recorded as `duplex-overlap-is-reached`.
Confidence: high — [evidence](evidence/neither-direction-starves-the-other.md).
The comment at `ring_transport.rs:416-420` claims the directions alternate so a
peer refilling the inbound ring cannot starve responses and close frames. That
claim is accurate for the case it describes, since every received frame is
followed by one non-blocking outbound take (`:421`) and the ingress-budget wait
also services outbound in its select (`:533-538`), and it does not cover either
blocking path above.
Existing check: none. Every shared-memory host test is lockstep: each peer send is
immediately followed by a peer receive, five times in the main negotiation test.
The transport's own two-process test is one ring in one direction.
Impact: one direction's pressure ends the other's progress, and the symptom is a
retired generation or an unclean close attributed to the transport. Because the
endpoint owns its thread and runtime, the damage is confined to the opposite lane
rather than other host tasks, which is also why no existing test would notice.
Open questions:

- What is the normative service ratio? `frame_deadline` is caller-supplied, so the
  worst case cannot be derived from this crate and a test must pin it from its own
  configuration. (needs human input)
- Should the inbound send be bounded, or is the sender-side admission timeout the
  intended backstop? The two give different failure attributions for one cause.
  (needs human input)

### reclamation-keeps-pace-with-completion

Type: liveness
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:876`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:148`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — the existing FIFO test recovers with a one-byte request,
which one reclaimed sequence out of two satisfies.
Guarantee: With no lease retained, one producer reserve attempt returns every
completed sequence's descriptor slot and arena bytes, not one sequence at a time.
Check: `always` — build a non-contiguous completed prefix of length at least two
behind a retained lease, witness the shape by asserting `release_pending == 2` and
`receiver_leased == 1`, release the retained lease, then perform exactly one
`try_reserve` and require `free == descriptor_depth` and
`bytes.free == arena_bytes`. Request a frame that only fits if every sequence was
reclaimed, so the assertion has a witness independent of the derived `bytes.free`.
The obligation applies whenever the prefix is contiguous; head-of-line blocking
under a retained lease is documented behaviour rather than a violation. The window
is counted in producer reserve attempts, not wall-clock, because `try_reserve` is
the only caller of `reclaim_completed`.
Fault/timing angle: no race; both cursors are producer-owned and written only in
`reclaim_completed`. The break at the first gap is the head-of-line mechanism, and
`reserve_until` masks a per-pass reclaimer entirely because each retry is another
pass, so the check must use a bare `try_reserve`.
Required faults and enabling state: a retained lease with at least two released
sequences behind it, situation `shm_arena_wrap_with_live_lease`, then the release.
Confidence: high — [evidence](evidence/reclamation-keeps-pace-with-completion.md).
The loop at `ring.rs:1112-1152` has exactly three exits, so one call drains the
whole contiguous prefix; both refusal gates it feeds are the outstanding-versus-depth
comparison and insufficient contiguous arena capacity.
Existing check: `retained_oldest_lease_enforces_fifo_reclamation_and_release_validation`
(`tests/ring.rs:138-209`). The blocking half is good. The recovery half releases
the retained lease and asserts a one-byte reserve succeeds; with a 64 MiB arena
fully charged, a reclaimer advancing only the first sequence leaves 40 MiB, where
one byte fits just as well. Status unaudited.
Impact: capacity would return one sequence per producer attempt while accounting
stays self-consistent. Convergence still happens under `reserve_until`, so only
the size class breaks: a large-frame request is refused while the arena is mostly
reclaimable, reporting `Deadline` on a healthy channel.
Open questions: None. The question that opened this record, whether one call
drains the whole prefix, is resolved by direct read of the loop's exits.

### lease-saturation-is-reached-then-drains

Type: reachability
Reachability: default-production — the lease-capacity gate is on the shipped
path, since the ring is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and prepared per connection
(`crates/mc-host/src/connection.rs:117`). The saturated *state* is not
shipped-reachable: `max_leases` is `MC_HOST_RING_DEPTH`, 8
(`crates/mc-shm-transport/src/profile.rs:652`, `:655-670`) while a receive
holds one lease at a time, which is this record's finding.
Status: active
Exercised: not yet — reached once, in one synthetic profile, at a cap of one,
which cannot distinguish being at the cap from holding one lease.
Guarantee: A campaign actually reaches a state where every receive lease is held
while at least one further frame is published and unacquired, and later observes
that state clear.
Check: `sometimes` — emit `shm_lease_saturation_observed_then_drained` where one
`conservation()` snapshot shows `receiver_leased == max_leases` and
`published >= 1`, and a later snapshot shows `receiver_leased < max_leases`. Both
facts in the first snapshot are legal on a correct system, since a full lease set
is backpressure rather than a fault, and the second is ordinary progress, so the
marker fires without a defect. It is not the negation of any `always` check here:
the violation it pairs with, receive never resuming, is a distinct predicate
asserted separately. This refines the earlier `shm_lease_set_saturated` marker in
`fault-map.md`, which does not witness that anything was waiting; treat the older
name as superseded rather than emitting both.
Fault/timing angle: no race, since one thread-confined receiver both mutates and
reads the counter. What matters is ordering between the halves: the snapshot must
be taken at the declining return, not before the last acquire and not after the
first release. The drain half no longer relies on the caller polling again:
the release that clears the cap signals both the `capacity_ready` and
`data_ready` doorbells (`ring.rs:1236-1241`), so a consumer parked in
`wait_for_data` (`:1138`) is woken into the drained state rather than
discovering it on a later poll.
Required faults and enabling state: none. A profile whose `max_leases` is
reachable and strictly greater than one, with `descriptor_depth > max_leases` so
the extra publication has a slot. The existing lease-limited profile satisfies the
second but not the first, so a new profile is required rather than a reuse.
Confidence: high — [evidence](evidence/lease-saturation-is-reached-then-drains.md).
Both halves are observable in one existing `conservation()` snapshot, so the
marker needs no new instrumentation, and the shipped host cannot reach the state
at all: `max_leases` is 8 while `receive_one` holds at most one lease per call,
releasing it on every path (`crates/mc-host/src/ring_transport.rs:507-509`,
`:546-548`, and `Drop` on error returns).
Existing check: none as a coverage marker. The lease-limit test constructs and
drains the state at a cap of one, so the situation is reached but not witnessed.
Impact: without this marker,
`receive-resumes-when-lease-capacity-clears` reports a pass that means the gate
declined for the other reason, an empty ring, which is exactly the ambiguity that
made the existing assertion weak. A never-fired marker is itself the finding: it
reports that the shipped host configuration cannot exercise lease backpressure at
all.
Open questions:

- Should a second profile with a cap above one be added purely to make this
  situation reachable, or should the eight-lease cap be reconsidered given that no
  shipped consumer can approach it? (needs human input)

### duplex-overlap-is-reached

Type: reachability
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`) and every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), so this code is on the
shipped path. This replaces the test-only, non-default framing in the
product-context section above, which predates the ring-transport refactor.
Status: active
Exercised: not yet — zero coverage in the Rust suites, and the peer harness cannot
construct the situation at all.
Guarantee: A campaign actually reaches an interval in which both directions of the
duplex pair have a frame in flight simultaneously.
Check: `sometimes` — emit `shm_both_directions_in_flight` where a monotone
triple-sample (sample the first ring, then the second, then the first again,
accepting only if the first ring's in-flight count was non-zero in both of its
samples) shows a non-zero in-flight count on each ring for the same interval.
In-flight means a slot past producer-reserved and not yet reclaimed, counted per
ring by `conservation()`. Both facts are ordinary states of a working duplex
channel, so the marker fires on a correct implementation. It is not the negation
of any `always` check here: the violation it enables observing, one direction
making no progress, is asserted separately in
`neither-direction-starves-the-other`.
Fault/timing angle: the situation is instantaneous overlap, and the two rings are
independent objects with no shared cursor, so there is no atomic way to sample
both. A naive sequential pair can report overlap that never existed if a frame
completes between the reads, which is why the monotone construction is part of the
check rather than an implementation note.
Required faults and enabling state: none; every state observed is one a healthy
duplex channel occupies constantly. What is required is a peer that can hold
frames outstanding both ways. `RingClientEndpoint::try_recv`
(`crates/mc-host/src/ring_transport.rs:718`) is already non-blocking, but
`send` still blocks in `reserve_until` up to its deadline (`:692`) and `recv`
blocks in `wait_for_data` (`:710`), so overlap still needs independent send
and receive threads or a non-blocking send.
Confidence: high — [evidence](evidence/duplex-overlap-is-reached.md).
Every shared-memory host test, the transport's two-process test, and the soak
harness were read: all are lockstep, single-direction, or resource-counter based.
That also established that two endpoint-loop paths, the post-receive outbound
take (`ring_transport.rs:416-421`) and the outbound service inside the
ingress-budget wait (`:533-538`), are unreachable under the existing traffic
shape; under the eventfd mechanism the idle path instead arms the data doorbell
(`:429`) and parks in the readiness select (`:459`).
Existing check: none. In the main negotiation test each peer send is immediately
followed by a peer receive, so two frames are never outstanding in opposite
directions.
Impact: without this marker, `neither-direction-starves-the-other` is vacuous: its
ratio arm evaluates a condition over an empty set and its drain arm degrades into
a plain round-trip test the suite already performs. A never-fired marker reports a
harness gap rather than an implementation defect, which is the honest reading.
Open questions:

- Do the addon or TypeScript client suites already drive both directions
  concurrently? They were not examined, so the harness gap may be narrower than
  stated.
- Should the marker distinguish overlap below capacity, which exercises the
  alternation, from overlap with the outbound lane at capacity, which is the only
  state making the starvation property refutable?

---

## Group N: doorbell delivery and demand paging

PR #131 (merge `5d638e3e8`) replaced the transport's polling with sparse
eventfd doorbells and made reclamation return pages with `MADV_REMOVE`. The
new mechanism family is: two doorbells per ring (`ring.rs:723-724`), a shared
parked-epoch wake protocol (`signal_wake`, `ring.rs:1418-1432`; `arm_data_wait`,
`:828-854`), a one-in-flight readiness reactor in the addon
(`packages/mc-shm-native/src/scheduling.rs:79`), and page-granular reclamation
(`removal_ranges`, `ring.rs:221-273`). Because signals are sparse — the eventfd
is written only when a waiter was parked — the dominant new hazard class is the
lost wake: a defect here presents as a healthy channel that stopped making
progress, with no error, quarantine, or counter. Each record below was
discovered from a fix commit inside the PR's own branch history and then
re-verified against HEAD code; the commit is the trigger, the code is the
evidence.

### attach-validates-doorbell-eventfds

Type: safety
Reachability: default-production — the ring transport is built unconditionally
(`crates/mc-host/src/runtime.rs:741`), every accepted connection prepares a
duplex ring (`crates/mc-host/src/connection.rs:117`), and the client bridge
attaches transferred descriptors through this gate
(`crates/mc-host/src/client.rs:1827`).
Status: active
Exercised: yes — `doorbell_attachment_requires_nonblocking_eventfd`
(`crates/mc-shm-transport/src/backend/ring.rs:2248-2270`) constructs both
rejection arms, a blocking eventfd and a nonblocking non-eventfd; the positive
arm is every cross-process attach (`ring_child_exchange`,
`tests/ring.rs:597-626`). No test substitutes a bad doorbell into a full
`Ring::attach` call.
Guarantee: `Ring::attach` accepts a doorbell descriptor only when it is a live
nonblocking eventfd, and rejects anything else as `DoorbellFailed` before the
ring is usable.
Check: `always` — at every successful attach, both doorbell descriptors carry
`O_NONBLOCK` in `F_GETFL` and readlink to `anon_inode:[eventfd]`
(`ring.rs:397-409`). `always` because the property must hold at every
evaluation of the attach gate; there is no optional path and no state to reach
first.
Fault/timing angle: none at the gate itself. The consequence of a miss is
timing-shaped: `signal` and `drain` (`ring.rs:416-448`) rely on `EAGAIN` for
their sparse semantics, so a blocking descriptor converts the first empty
`drain` (`arm_data_wait`, `:846`) into an unbounded block on the bridge or
reactor thread.
Required faults and enabling state: a peer transferring a non-conforming
descriptor in a doorbell slot of the setup handshake — fault class F15
(doorbell fd substitution). No shared state needs preparation.
Confidence: high — [evidence](evidence/attach-validates-doorbell-eventfds.md).
Both gate predicates, both attach call sites, and the absence of any
post-attach `F_SETFL` were read directly.
Existing check: `doorbell_attachment_requires_nonblocking_eventfd`
(`ring.rs:2248-2270`), unit-level against `Doorbell::from_fd` directly; status
unaudited.
Impact: a wedged setup with no error — the attaching thread blocks forever
inside a doorbell read, indistinguishable from a slow peer, on the thread that
also services every other channel event.
Open questions:

- The identity half of the gate depends on `/proc/self/fd`; it fails closed
  elsewhere, which couples doorbell attach to Linux. Is that intended for the
  macOS ring path? (needs human input)

### wake-published-during-readiness-callback-is-not-lost

Type: liveness
Reachability: default-production — the addon readiness path is the production
client delivery path: `ShmFrameChannel` registers its handler via
`startReadiness`
(`packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:110`), which
wires the reactor (`packages/mc-shm-native/src/lib.rs:1109-1131`).
Status: active
Exercised: yes — `readiness acknowledgement preserves a frame published during
callback` (`packages/mc-shm-native/tests/mechanism.ts:211-278`) publishes
frame 2 from inside callback 1 and requires `received == [1, 2]` with exactly
two callbacks. Not covered: the same race through the `NativeChannel` wrapper
with multiple registered channels.
Guarantee: a frame published while the one in-flight readiness callback runs is
delivered by a subsequent callback without any further publication, within one
acknowledgement cycle.
Check: `always` — every `readiness_handled` acknowledgement whose per-channel
re-arm observes visible data or a generation change (`arm_data_wait` returning
false, `lib.rs:1148-1152`) returns `redispatch = true`, and the dispatcher
re-enters on true (`index.ts:524-526`). `always` because the acknowledgement
runs after every callback and is the sole carrier of a wake whose doorbell
token was already drained; a bounded window (one cycle) makes this checkable
by a finite test.
Fault/timing angle: the window is the whole callback execution, from the
reactor's `pending` CAS (`scheduling.rs:169-172`) to `handled()` (`:279-282`),
during which the reactor thread is blocked in `wait_until_handled` (`:52-68`)
and observes no epoll edges. A kick raised inside the window is preserved by
rewriting the control eventfd (`:178-181`).
Required faults and enabling state: a publication concurrent with an
unacknowledged callback — a parked-then-drained consumer plus a publisher
signaling into the drained window. Enabling situation
`shm_publish_during_readiness_callback`.
Confidence: high —
[evidence](evidence/wake-published-during-readiness-callback-is-not-lost.md).
The re-arm walk, the redispatch boolean, both dispatcher `finally` blocks, and
the kick-preservation path were read directly.
Existing check: `readiness acknowledgement preserves a frame published during
callback` (`mechanism.ts:211-278`), raw-addon level; status unaudited.
Impact: a delivered frame sits invisible until an unrelated event; on an
otherwise idle channel, forever. The client sees a response that never
arrives; the host sees a healthy setup socket. Silent, no counter fires.
Open questions:

- The raw addon makes honoring `readinessHandled`'s return the caller's
  obligation. Should the contract be enforced natively (redispatch from Rust)
  rather than by convention? (needs human input)

### queued-write-needs-no-second-wake

Type: liveness
Reachability: default-production — `start_ring_bridge`
(`crates/mc-host/src/client.rs:1805`) is the client's ring worker, spawned for
every shm-negotiated connection; the ring transport itself is built
unconditionally (`crates/mc-host/src/runtime.rs:741`).
Status: active
Exercised: yes — `ring_bridge_drains_inbound_and_queued_writes`
(`client.rs:4003-4076`) queues eight writes with zero per-write wakes,
delivers one edge, and bounds every completion at 250 ms.
Guarantee: once the bridge wakes, every write already queued completes without
any further wake — k queued writes drain in k loop passes.
Check: `always` — a bridge loop pass that completed a write re-polls the write
queue without arming or blocking (`wrote` at `:1846`/`:1858`, checked at
`:1913-1915`), so per-write completion latency is bounded in loop passes, not
in external events. `always` because the property must hold on every pass;
the bound (k passes, no second signal) is what a finite test asserts. Harness
proxy: per-write completion within an explicit wall-clock deadline with the
delivered signal count pinned by the test, since loop passes are not
externally observable.
Fault/timing angle: eventfds coalesce. N `try_send` signals
(`:1764-1768`) before the bridge polls collapse into one readable edge, and
`drain_eventfd` (`:1800-1803`) consumes it whole; the window opens whenever
more than one write queues before the drain and closes only on the next
unrelated edge.
Required faults and enabling state: at least two writes enqueued before the
bridge drains its wake eventfd, then no further signals. Enabling situation
`shm_queued_writes_exceed_one_per_wake`.
Confidence: high — [evidence](evidence/queued-write-needs-no-second-wake.md).
The loop order (one write, inbound drain, `wrote` check, arm, block) was read
directly, as was the test's deliberate bypass of the signaling sender.
Existing check: `ring_bridge_drains_inbound_and_queued_writes`
(`client.rs:4003-4076`); status unaudited.
Impact: burst writes complete with unbounded latency or expire at their
deadlines on a healthy channel; the host attributes the timeout to the
transport and cancels work the peer would have absorbed.
Open questions: None.

### released-charges-wake-blocked-readers

Type: liveness
Reachability: default-production — the charge wait is inside the same
unconditionally spawned bridge loop (`crates/mc-host/src/client.rs:1869-1902`);
reaching the *blocking* arm additionally requires inbound frames wide enough
to exhaust `CLIENT_INBOUND_FRAME_BYTES`, which no test and no measured
workload has yet demonstrated.
Status: active
Exercised: not yet — no test exhausts the read budget with the bridge parked
and then releases a charge from another thread; existing `ByteCounter` tests
(`client.rs:3805-3891`) are synchronous accounting checks that never reach the
poll arm.
Guarantee: when a released byte charge frees read-budget capacity, a bridge
blocked waiting for that capacity resumes within one poll wakeup, admits the
pending frame, and continues delivery.
Check: `always` — every `ByteCharge::drop` that decrements a counter with a
registered wake signals that wake's eventfd (`client.rs:1711-1725`), and a
bridge parked in the charge loop observes it on its next poll (`:1879-1901`).
`always` because the drop-side signal is unconditional given a registered
wake; the bounded window is one poll wakeup plus one loop iteration. Harness
proxy: per-write completion within an explicit wall-clock deadline with the
delivered signal count pinned by the test, since loop passes are not
externally observable.
Fault/timing angle: signal-before-park — the drop can land between the failed
`charge` attempt and the bridge's `poll`. The eventfd absorbs it: the write
leaves the counter readable, so the later poll returns immediately. No
parked-epoch protocol exists on this path and none is needed; the eventfd is
the level-observable state.
Required faults and enabling state: read-budget exhaustion with the bridge
parked in the charge poll, then a concurrent charge drop. Needs a shrunken
budget or frames wider than the default. Enabling situation
`shm_read_budget_exhausted_with_parked_bridge`, witnessed as
`read_budget.used == capacity` at the moment a further frame is published,
followed by bounded resumption after one `ByteCharge` drop. The test is
necessarily in-module — `start_ring_bridge` is private and the `used()`
accessor exists under `#[cfg(test)]` (`client.rs:1688-1690`).
Confidence: medium —
[evidence](evidence/released-charges-wake-blocked-readers.md). The wiring
(`set_wake` at `:1821`, drop-side signal, poll arm) was read directly, but no
test has ever executed the blocking arm, so the claim rests on reading alone.
Existing check: none.
Impact: a read-heavy channel with no outbound writes wedges permanently at the
first budget exhaustion — frames accumulate unread, the producer exhausts and
reports deadlines, and the defect is attributed to the peer.
Open questions:

- Can any shipped workload exceed `CLIENT_INBOUND_FRAME_BYTES` in flight, or
  is the blocking arm latent until frame sizes grow? (needs human input)

### capacity-recheck-after-a-wake-race

Type: liveness
Reachability: default-production — `reserve_until` is the blocking send path
for every ring producer (`endpoint.send` from the bridge,
`crates/mc-host/src/client.rs:1850-1852`), on the unconditionally built ring
transport (`crates/mc-host/src/runtime.rs:741`).
Status: active
Exercised: partial — `two_process_zero_copy_exchange_uses_authenticated_grant`
(`crates/mc-shm-transport/tests/ring.rs:551-592`) parks a `reserve_until`
behind a child's held lease and converges after the release, exercising the
block-then-wake path; nothing lands a release inside the arm window itself.
Guarantee: capacity freed at any point after a producer's failed reservation
is consumed without waiting out the deadline — before blocking by the in-loop
rechecks, during blocking by the doorbell.
Check: `always` — a `reserve_until` iteration reaches
`capacity_ready.wait_until` (`ring.rs:1035`) only after a post-park
`try_reserve` (`:1001`), a generation recheck (`:1012`), a doorbell drain
(`:1016`), a second `try_reserve` (`:1020`), and a second generation recheck
(`:1031`) all found no progress; assert that a release completing before the
block yields success in the same iteration. `always` because the recheck
ladder must hold on every iteration; the bounded window (one iteration) is
what a racing test can refute.
Fault/timing angle: the vulnerable window is generation-read (`:994`) to poll
entry, a few dozen instructions. The publisher bumps the generation SeqCst and
writes the eventfd only when it swapped a parked epoch
(`signal_wake`, `:1426-1429`); the drain at `:1016` is why the second
`try_reserve` exists — it can consume a stale token whose capacity would
otherwise be represented only by the byte just discarded. Correctness rests on
SeqCst pairing that no tool validates (fault class F5).
Required faults and enabling state: a parked producer plus a release racing
the arm sequence — true concurrency (F4) or a model checker. Enabling
situation `shm_capacity_signal_hit_parked_epoch`, which witnesses
block-then-wake coverage only: a nonzero swap fires on every ordinary
mid-block wake, so the marker over-approximates the arm window. F16 itself
has no constructible runtime marker; only a loom or shuttle schedule can
observe the window.
Confidence: medium —
[evidence](evidence/capacity-recheck-after-a-wake-race.md). The full loop and
both publisher orderings were read and the interleaving case analysis is
recorded, but it is a hand proof over atomics with no loom or Miri backing.
Existing check: partial —
`two_process_zero_copy_exchange_uses_authenticated_grant`
(`tests/ring.rs:551-592`), block-then-wake only; status unaudited.
Impact: `ProducerError::Deadline` on a ring with free capacity — a stranded
full ring, reported as a transport failure on a channel whose receiver was
draining correctly. Intermittent, load-dependent, and unreproducible by any
lockstep test.
Open questions:

- A loom model of a hand transcription of the protocol is the cheapest
  oracle — the atomics live in an mmapped page loom cannot instrument, so
  `reserve_until` and `signal_wake` must be transcribed over loom atomics
  and kept in sync manually, including the Release-not-SeqCst parked resets
  (`ring.rs:1004`, `:1013`, and the other exit arms through `:1042`). Queue
  it?

### reclamation-excludes-pages-with-live-wrapped-bytes

Type: safety
Reachability: default-production — `reclaim_completed` runs at the head of
every `try_reserve` (`ring.rs:916`) on the unconditionally built ring
transport; page removal requires only a released whole page, which normal
traffic produces.
Status: active
Exercised: yes — `removal_ranges_exclude_partial_pages_and_split_once_at_wrap`
(`ring.rs:2279-2297`) sweeps three page sizes over the pure function including
the wrap split, and `partial_page_reclaim_preserves_live_neighbor`
(`:2337-2353`) holds a live lease on a shared page through a reclaim and reads
its bytes back. The trailing-partial-page exception has never been reached
with a wrapped cursor.
Guarantee: `MADV_REMOVE` is applied only to pages every byte of which belongs
to released frames; a page shared with any live byte — including the wrapped
tail of a partially released run — is never removed.
Check: `always` — every range passed to `remove_pages` is page-aligned, lies
within the logical span `[reclaimed, new_reclaimed)` rounded inward
(`removal_ranges`, `:221-273`: start rounds up `:243-249`, end rounds down
`:250`), and the sole exception, the trailing partial page, is removed only
under `arena_write == new_reclaimed` with a crossed boundary (`:1533-1548`).
`always` because the invariant must hold at every removal; there is no state
in which a live-byte removal is acceptable.
Fault/timing angle: none required — the defect class is arithmetic and
reachable single-threaded. The failure containment is ordered: a failed
`madvise` quarantines before any capacity publication (`:1514-1517`), and
`arena_reclaimed` advances only after all removals succeed (`:1557-1563`).
Required faults and enabling state: a released run sharing a page with a live
lease, and separately a run crossing the arena wrap. Enabling situations
`shm_partial_page_shared_with_live_lease` and the existing
`shm_arena_wrap_with_live_lease`. Page-size sensitivity makes a non-4096 host
(F11) the cheap amplifier.
Confidence: high —
[evidence](evidence/reclamation-excludes-pages-with-live-wrapped-bytes.md).
The rounding arithmetic, the wrap split, the trailing-page guard, and the
ordering of removal before capacity publication were all read directly and
are pinned by the unit tests named above.
Existing check: the four Linux unit tests at `ring.rs:2279-2353` plus
`page_removal_failure_quarantines_before_capacity_publication` (`:2355-2373`);
all status unaudited.
Impact: silent corruption — a leased frame's bytes read back as zeros after
validation already passed. The receiver delivers zeroed payload with a valid
header; nothing downstream can detect it. This is the only record in this
group whose failure is data loss rather than lost progress.
Open questions:

- The trailing-partial-page exception with a wrapped `arena_write` is
  untested; the guard's soundness argument is recorded in the evidence file
  but unexecuted.

### reactor-callback-is-one-in-flight

Type: safety
Reachability: default-production — the reactor is created on the first
`watch` (`packages/mc-shm-native/src/lib.rs:1117-1119`), which the production
client reaches through `startReadiness`
(`packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:110`).
Status: active
Exercised: partial — `readiness acknowledgement preserves a frame published
during callback` (`mechanism.ts:211-278`) pins exactly one deferred dispatch
(`callbacks === 2`), and `pending_callback_waits_for_acknowledgement`
(`scheduling.rs:320-348`) pins that a control write alone does not release the
wait. No test lands edges from multiple channels in one pending window.
Guarantee: the reactor never has two unacknowledged readiness callbacks in
flight — a second dispatch occurs only after `readiness_handled` re-armed
every channel and cleared the pending gate.
Check: `always` — a callback is dispatched only through a successful
`pending` compare-exchange (`scheduling.rs:169-175`) and the reactor blocks in
`wait_until_handled` (`:52-68`) until `handled()` (`:279-282`) clears the
flag; assert no dispatch while an acknowledgement is outstanding. `always`
because the mutual exclusion must hold at every dispatch decision.
Fault/timing angle: edges and kicks arriving during the pending window are the
hazard. A kick is deferred, not dropped: `wait_until_handled` returning with
`kick` set rewrites the control eventfd (`:178-181`) for exactly one later
pass. One documented exception exists: a `wait_until_handled` *error* fires a
final non-gated callback and terminates the thread (`:184-189`).
Required faults and enabling state: doorbell or kick edges concurrent with an
unacknowledged callback — one in-flight callback plus a publisher or a
`poll`-side `kick` (`lib.rs:1226-1235`). Enabling situation
`shm_kick_during_pending_callback`.
Confidence: high —
[evidence](evidence/reactor-callback-is-one-in-flight.md). The CAS, the wait,
the acknowledgement ordering (re-arm before `handled()`,
`lib.rs:1136-1156`), and both error paths were read directly.
Existing check: `mechanism.ts:211-278` and `scheduling.rs:320-348` as above;
both status unaudited.
Impact: overlapping dispatchers interleave over the thread-confined registry —
"native channel is busy" errors on a healthy channel — and a double
acknowledgement releases a reactor epoch whose re-arm never ran, which
manufactures the lost wake the previous record guards against.
Open questions:

- The terminal-path non-gated callback (`scheduling.rs:184-189`) can overlap
  an unacknowledged one exactly once, on a dying reactor. Acceptable by
  design? (needs human input)

---

## Relationship map

Grouped by shared mechanism, with suspected dominance noted where one property
holding would make another likely to hold. Dominance is a hypothesis, not proof.

- **Shared peer-writable control pages.** `quarantine-authority-survives-peer-writes`,
  `reclaim-advance-bounded-by-the-producer-reservation`,
  `attach-reconciles-or-refuses-stale-shared-cursors`,
  `reservation-charge-visible-with-non-free-state`. All four trace to one
  decision: a single object mapped read-write by both roles with no
  `F_SEAL_WRITE` and no per-role read-only region. A control-page write-protection
  split would likely dominate the first and third.
- **Quarantine as the terminal state.** `quarantine-gates-cover-every-storage-mutation`,
  `attach-refuses-a-quarantined-object`, `quarantine-authority-survives-peer-writes`.
  If quarantine authority is not peer-clearable, the other two still stand
  independently; the reverse is not true.
- **Charge conservation.** `quarantine-charge-transition-is-atomic`,
  `charge-release-never-silently-strands`, `custody-terminal-transition-exactly-once`,
  `release-failure-is-observable`. The first three are the three distinct ways an
  accounting transition can lose a charge; the fourth is why none of them would
  be noticed.
- **Exactly-once completion.** `release-exactly-once-per-sequence` dominates
  `release-authority-bound-to-lease-ownership` only for *duplicate* releases; it
  says nothing about a *first* release by the wrong party, which is the actual
  gap.
- **Crash leaves shared state behind.** `attach-reconciles-or-refuses-stale-shared-cursors`,
  `crashed-producer-does-not-wedge-the-sequence`,
  `dead-peer-charges-are-reclaimed-or-declared`. Same root: no liveness signal
  and no reconciliation path. All three surface as backpressure codes rather
  than faults.
- **One value, several hand-maintained copies.** `one-profile-name-denotes-one-geometry`,
  `attach-binds-geometry-to-a-local-profile`,
  `negative-tests-fail-for-their-stated-reason`. Defect `daf6e244` is the worked
  example of this cluster causing a silent test degradation.
- **Evidence that cannot detect its own failure.** `operation-counters-are-observed-not-declared`,
  `measured-transfer-is-witnessed-by-the-data`, `traceability-pointers-resolve`,
  `negative-tests-fail-for-their-stated-reason`. These share a shape: an artifact
  that reports success without observing the thing it claims to measure.
- **Documented but not driven.** `documented-close-order-has-a-production-driver`,
  `clean-reclamation-is-reachable`, `capability-probe-gates-every-advertised-mechanism`.
  Each has a passing or partial traceability status attached to a mechanism that
  production does not reach or does not gate.
- **The doorbell and parked-epoch wake protocol.** All of Group N except the
  reclamation record, plus the six Group M records rewritten by the eventfd
  reconciliation: `backpressure-converges-in-a-bounded-reclaim-window`,
  `receive-resumes-when-lease-capacity-clears`,
  `neither-direction-starves-the-other`, `reclamation-keeps-pace-with-completion`,
  `lease-saturation-is-reached-then-drains`, `duplex-overlap-is-reached`. One
  mechanism carries them: `signal_wake` bumps a generation and writes the
  eventfd only when a waiter was parked, so every record's hazard is some form
  of lost wake. Suspected dominance: `capacity-recheck-after-a-wake-race`
  holding would make the producer half of
  `backpressure-converges-in-a-bounded-reclaim-window` likely to hold, since
  the bounded convergence window is exactly the recheck ladder; and
  `wake-published-during-readiness-callback-is-not-lost` presupposes
  `reactor-callback-is-one-in-flight`, because a double acknowledgement
  releases an epoch whose re-arm never ran and manufactures the lost wake the
  first record excludes. `attach-validates-doorbell-eventfds` sits upstream of
  the entire cluster: none of the wake properties are meaningful over a
  descriptor that is not a nonblocking eventfd.
- **Wake delivery outside the ring pages.**
  `queued-write-needs-no-second-wake` and
  `released-charges-wake-blocked-readers` are the same coalesced-eventfd hazard
  on the bridge's private `worker_wake` rather than on a shared doorbell; the
  parked-epoch protocol does not apply there, level-observable eventfd state
  does. Neither dominates the other — one guards the write queue, one the read
  budget — but a fix that serialized bridge passes wrongly would break both.
- **Reclamation correctness versus reclamation progress.**
  `reclamation-excludes-pages-with-live-wrapped-bytes` is the safety bound on
  the same walk whose progress `reclamation-keeps-pace-with-completion` and
  `backpressure-converges-in-a-bounded-reclaim-window` assert; the rounding
  that protects live bytes is precisely what defers page removal, so tests for
  the liveness pair must not treat retained partial pages as a defect.
