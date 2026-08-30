# Part 1 fault-to-property map

For each property, what must actually occur for a test to be non-vacuous, and
whether the harness can produce it today.

A property whose required fault is never injected passes forever while testing
nothing. That is the failure mode this file exists to prevent.

## Rules applied here

- Safety checks must hold **while** their faults are active.
- Liveness and convergence checks need a bounded fault-free window: run under
  faults, stop injection, poll until stable within a bound, check convergence.
- Crash-recovery properties need an actual termination and restart, not a clean
  shutdown.
- Rare implementation branches need deterministic injection points to become
  reachable at all. Physical faults alone rarely construct the needed semantic
  state.
- Coverage checks assert the **independent preconditions** that jointly create
  the vulnerable window. They never assert the violation, so they still fire on
  a correct implementation. Never pair `always(!X)` with `sometimes(X)`: that
  coverage check can only fire by observing the defect.

## Fault classes required

| Class | Description | Available today |
| --- | --- | --- |
| F1 process kill | `SIGKILL` at a chosen point, signal-9 wait status required, observation window anchored to reap | **Yes** — `crates/mc-host/tests/support/shm_process.rs` implements exactly this |
| F2 hostile peer writes | A peer that writes shared control pages: the quarantine byte, cursors, slot fields, a pending descriptor | **No** — all three fuzz targets model immutable byte decoders; nothing models a mutating peer |
| F3 deterministic failpoints | Forced failure at a named internal point: lease construction, span materialization, accounting overflow, alias detach, charge release | **Partial** — an external-view creation failpoint exists in the addon; no failpoint exists for lease or span construction, accounting arithmetic, or charge release |
| F4 true concurrency | Producer and receiver progressing independently, not in lockstep | **No** — the only cross-process test is lockstep with a sleep |
| F5 weak memory | A weakly-ordered target where a permitted reordering is observable, or a model checker standing in for one | **No** — no loom, shuttle, Miri, or ThreadSanitizer anywhere |
| F6 runtime variants | A runtime missing an enumerated mechanism; a non-Bun, non-Node host | **Partial** — Bun and Node are both exercised; no runtime lacking the cleanup hook |
| F7 artifact inspection | Enumerating exported symbols and resolved features of the built artifact | **No** |
| F8 static cross-artifact assertion | Asserting equality across Rust, TypeScript, fixtures, and manifests | **No** |
| F9 accounting pre-state | Seeding counters near their bounds so a checked add fails | **No** |

## Map

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| quarantine-authority-survives-peer-writes | A quarantine trigger, **then** F2 writing zero to the flag | No — F2 missing |
| quarantine-gates-cover-every-storage-mutation | An open reservation **and** a quarantine raised during its lifetime (F2 or a corrupt-frame trigger from the peer) | No |
| attach-refuses-a-quarantined-object | A quarantine trigger, then a fresh attach with the same grant | No |
| quarantine-charge-transition-is-atomic | F9: `quarantined + retained` overflows, or F3 at that point | No |
| charge-release-never-silently-strands | A poisoned accounting mutex (panic while holding), or an inconsistent `active` | No |
| custody-terminal-transition-exactly-once | Two terminal transitions racing (F4 at the host level), or an incarnation bump between admission and release | Partial — sequential cases covered; the race and the incarnation case are not |
| reservation-charge-visible-with-non-free-state | F4: an observer reading slot state during an in-progress reservation | No — single-threaded tests between operations cannot construct it |
| publication-visibility-derives-only-from-the-published-cursor | F4 plus ideally F5, or a model checker | No |
| no-frame-observable-before-commit | An open reservation with bytes written, and a receiver polling concurrently (F4) | No — the negative is never asserted |
| publish-signal-implies-committed-frame | F3: a commit failure injected after the publish hook has run | No |
| release-authority-bound-to-lease-ownership | A live lease **and** a release issued from the producer side with the identity `commit` returned | No |
| release-exactly-once-per-sequence | Two or more release attempts for one sequence, ideally concurrent (F4) | Partial — sequential duplicate and stale-lap cases are covered well |
| receive-failure-leaves-no-wedged-slot | F3 at lease or span construction, after the receive compare-exchange succeeds | No — and physical faults alone will not construct it |
| release-failure-is-observable | F3: a release that fails while the surrounding operation is otherwise clean | No |
| attach-reconciles-or-refuses-stale-shared-cursors | F1 killing a receiver holding leases, then an attach | Partial — F1 exists; no test performs the post-kill attach |
| crashed-producer-does-not-wedge-the-sequence | F1 between reserve and commit | Partial — F1 exists; this injection point is unused |
| dead-peer-charges-are-reclaimed-or-declared | F1 on a committed peer without a goodbye | **Yes** — pinned by an existing test |
| cancelled-frame-disposition-is-declared | Cancellation or overload arriving between a successful receive and the ingress charge (F3 for determinism) | No |
| validated-spans-are-disjoint-and-inside-the-arena | Attacker-controlled descriptor fields **and** an arena larger than the minimum | Partial — fuzzing covers fields but pins the arena at the minimum |
| no-rust-reference-over-peer-writable-payload | Audit form needs no fault; the impact demonstration needs F2 mutating leased bytes | Audit yes, demonstration no |
| reclaim-advance-bounded-by-the-producer-reservation | F2 writing a pending slot's descriptor between release and reclaim | No |
| attach-binds-geometry-to-a-local-profile | A grant whose geometry differs from the admitted profile | No |
| one-profile-name-denotes-one-geometry | None; F8 to detect it | No — and the contradiction is live |
| native-boundary-not-weaker-than-its-wrapper | A direct native call carrying a descriptor the wrapper would reject | No |
| operation-counters-are-observed-not-declared | None to observe the gap; negative controls that remove a real operation | No |
| measured-transfer-is-witnessed-by-the-data | None to observe the gap; a byte corruption to demonstrate impact | No |
| traceability-pointers-resolve | None; F8 | **Yes** — checked mechanically for this catalog |
| negative-tests-fail-for-their-stated-reason | None | No |
| documented-close-order-has-a-production-driver | None | No |
| capability-probe-gates-every-advertised-mechanism | F6: a runtime lacking the cleanup hook | No |
| clean-reclamation-is-reachable | None to observe the gap | No — reachable only via a fake backend |
| test-only-surface-absent-from-the-shipped-addon | None; F7 | No |

## Gap-closure records (Groups I through M)

Added after the portfolio evaluation queued seven gaps. These need four fault
classes the original map did not name.

| Class | Description | Available today |
| --- | --- | --- |
| F10 macOS ring execution | A macOS host that actually constructs a `Ring` | **No** — the macOS CI step names two integration files and excludes the lib target, so no macOS job reaches `Ring::create` |
| F11 non-4096 page host | A kernel page size other than 4096, or an injectable page size in the layout and prefault paths | **No** — and note CI already provisions a 16 KiB host every run, which is precisely the one that constructs no `Ring` |
| F12 duplex-capable peer | A peer harness able to hold frames outstanding in both directions at once | **No** — the test peer's send and receive are both synchronous and thread-confined |
| F13 iceoryx cross-process pairing | Two processes sharing one iceoryx service | **No, and not constructible** — the service name is random, private, and has no accessor; the port bounds are consumed by the creator. Requires an API change |

| Property | Required faults and enabling state | Non-vacuous today |
| --- | --- | --- |
| decoder-totality-over-arbitrary-bytes | None; arbitrary bytes are the enabling state. Needs an exhaustive-length sweep, structured mutation of an accepted seed, and an allocation oracle | Partial — ten lengths and two fills, neither reaching an arithmetic guard |
| accepted-decode-consumes-its-declared-width | None; any accepted input. Needs a per-byte influence oracle | No — the one round-trip assertion cannot fail without a source edit |
| identity-and-schema-rejection-is-one-contract | Enforcement: none. Disposition: a live lease plus F2 rewriting that slot's `schema_version`, then release and reserve | No |
| grant-reserved-bytes-are-rejected-unless-zero | None; a nonzero reserved byte. Re-encode arm needs a decode-then-re-encode component that does not exist | Partial — one of four bytes; the corpus seed that encodes the case has its outcome unasserted |
| fuzz-harness-encoding-tracks-the-production-descriptor | Static half: none. Coverage half: an `expected` identity differing from the decoded one in incarnation or sequence | No — neither fuzz target supplies it, so two of five identity guards are unreached by any campaign |
| macos-object-creation-outcome-is-attributed | F10 | No |
| attach-validation-is-not-platform-weakened | F10 plus a macOS descriptor source, then a wrong-type descriptor of exact size/uid/mode, or a retained second descriptor used to shrink after validation | No |
| macos-object-creation-leaks-no-shm-name | F10 plus F3 on `shm_unlink`, or a kill in the open-to-unlink window, plus an oracle over the Darwin shm namespace | No |
| layout-region-offsets-are-real-page-aligned | F11 | No |
| page-size-dependent-setup-runs-on-a-non-4096-page-host | F11 | No |
| iceoryx-descriptor-rejection-is-terminal-or-declared | A sequence or identity mismatch in a delivered sample: either an external config setting the discard strategy, or F2 against the provider segment | No |
| iceoryx-receive-expectation-tracks-the-delivered-stream | A delivered-versus-expected sequence divergence: a restart (blocked by F13), a malformed sample (F2), or a discard-strategy config plus a full buffer | No |
| iceoryx-cross-process-pairing-is-reachable-or-declared | F13 | No, and not constructible without an API change |
| iceoryx-completion-is-observable-to-the-host | None; the gap is visible in the public surface | No — there is no observation to assert against |
| iceoryx-saturation-is-bounded-non-blocking-backpressure | None; count operations past each cap. Publish arm hangs, so needs a terminating timeout in the harness | No |
| wire-header-fully-validated-before-any-consumer-acts | A peer-authored header satisfying the transport's two checks and violating one host rule | Partial — one such header exists in a test, but only the downstream quarantine is asserted |
| ingress-charge-matches-the-bytes-copied-from-shared-storage | None to pin it; F2 writing the descriptor page to demonstrate impact | No |
| every-shm-header-consumer-applies-its-role-gate | A role-invalid publish into each direction; the peer arm needs the frame to originate host-side | Partial — host arm only, one type |
| header-rejection-effect-does-not-depend-on-the-catching-layer | Two rejections of one class caught at different layers; the transport-caught one requires F2, because commit re-checks both fields | No |
| runtime-directory-authentication-is-a-precondition-not-a-container | Filesystem tampering between creation and use; four of five cases are constructible unprivileged, the owner-change case needs a second user or a container | No |
| backpressure-converges-in-a-bounded-reclaim-window | Genuine exhaustion of descriptor or arena capacity, then removal of the pressure | Partial — arena arm only, cross-process, bounded at five seconds |
| receive-resumes-when-lease-capacity-clears | A profile whose lease cap is reachable and above one, with depth greater than the cap so a frame is pending | No — and unreachable in the shipped host, which holds one lease per call |
| neither-direction-starves-the-other | F12 plus capacity pressure on one lane | No |
| reclamation-keeps-pace-with-completion | A retained lease with at least two released sequences behind it, then the release | Partial — the existing recovery assertion uses a one-byte request that one reclaimed sequence satisfies |
| lease-saturation-is-reached-then-drains | None; a profile with a reachable cap above one | No — reached once at a cap of one, which cannot witness the situation |
| duplex-overlap-is-reached | None; F12 to construct it | No |

### Coverage-check changes

`shm_lease_saturation_observed_then_drained` supersedes the earlier
`shm_lease_set_saturated` marker in the table above, because the older name does
not witness that anything was waiting; emit the new one, not both.
`shm_both_directions_in_flight` is new and is recorded as its own record,
`duplex-overlap-is-reached`, because it needs a monotone triple-sample rather
than a single observation: the two rings share no cursor, so a naive sequential
pair can report overlap that never existed.

### Revised leverage ranking

Counting the full 58-record catalog:

1. **F2, a mutating-peer fixture** — now unblocks 9 properties.
2. **F3, internal failpoints** — 6 properties.
3. **F11, a non-4096 page host or injectable page size** — 2 properties, and it
   is nearly free: CI already provisions a 16 KiB host every run.
4. **F12, a duplex-capable peer** — 2 properties, and without it the whole
   normal-operation liveness group is vacuous.
5. **F10, macOS ring execution** — 3 properties, and it would also settle whether
   the documented macOS omission rests on anything.
6. **F4, non-lockstep cross-process traffic** — 4 properties.
7. **F8, cross-artifact assertions** — 3 properties.
8. **F13** — requires an API change, so it is a design decision rather than a
   harness investment.


## Coverage checks to add

Each asserts a precondition that a correct implementation still satisfies, so it
can fire without a defect being present. Names must be constant and globally
unique; never construct them dynamically.

| Coverage check | Situation it witnesses | Why it is safe |
| --- | --- | --- |
| `shm_reservation_open_while_peer_quarantines` | A reservation was outstanding at the moment the other side raised quarantine | Both facts are legal on a correct system; neither is the violation |
| `shm_receive_cas_won_then_validation_ran` | A receive claimed a slot and reached validation | An outcome marker on the normal path, not a path-entry marker |
| `shm_arena_wrap_with_live_lease` | A producer wrapped the arena while an older lease was still held | The documented head-of-line case; legal and expected |
| `shm_full_lap_slot_recycled` | A descriptor slot was reused after a complete lap | Required for stale-identity properties to mean anything |
| `shm_lease_set_saturated` | Every receive lease was held simultaneously | Backpressure is a legal state |
| `shm_kill_with_leases_held` | A peer was killed while holding at least one lease | Precondition for the reconciliation property |
| `shm_kill_during_open_reservation` | A producer was killed between reserve and commit | Precondition for the wedge property |
| `shm_cancel_after_frame_acquired` | Cancellation arrived after a receive succeeded and before delivery | The exact window; both events are legal |
| `shm_commit_failed_after_publish_hook` | A commit failed on an attempt whose publish hook had already run | Legal failure ordering |
| `shm_arena_larger_than_minimum_validated` | A descriptor was validated against an arena above the floor | Ensures the disjointness derivation is exercised, not assumed |
| `shm_two_span_frame_validated` | A wrapping, two-span frame passed validation | The only shape where disjointness is non-trivial |

Anti-pattern to avoid, stated explicitly because it is tempting here: do not add
`sometimes(spans_overlapped)` alongside
`always(!spans_overlapped)`. That coverage check can only fire by violating the
invariant. Assert `shm_two_span_frame_validated` and
`shm_arena_larger_than_minimum_validated` instead — the independent preconditions
that make overlap possible.

## Effect accounting under loss

Two properties involve counting effects where a response or a frame can be lost:
`cancelled-frame-disposition-is-declared` and
`dead-peer-charges-are-reclaimed-or-declared`.

Frames here are under a one-to-one effect contract — each has a distinct
`(incarnation, lane, sequence)` identity, produces at most one persistent effect,
and each acknowledgement promises exactly one. So track attempted and
acknowledged separately and state bounds: observed effects at least the
acknowledged count and at most the attempted count. Because aggregate totals can
cancel inside the contract — one lost acknowledged frame plus one duplicated
unacknowledged frame satisfies both bounds — the per-identity checks are the
primary oracle: exactly one effect per acknowledged sequence, at most one per
other attempted sequence. Keep the bounds as a cheap screen.

Harness implementation of this accounting belongs to
`/testing:deterministic-simulation-testing`.

## Highest-leverage missing capability

Ranked by how many catalog records it unblocks:

1. **F2, a mutating-peer fixture** — unblocks 5 properties and is the only way to
   test the trust boundary the documentation actually declines to guarantee.
2. **F3, internal failpoints** — unblocks 5 properties, all of them error paths
   that no physical fault reaches.
3. **F4, non-lockstep cross-process traffic** — unblocks 4 properties, including
   the transport's core publication guarantee.
4. **F8, cross-artifact assertions** — unblocks 3 properties and would have
   caught the one defect in this area that already shipped.
5. **F1 at new injection points** — the harness exists; only two new kill points
   are needed.
