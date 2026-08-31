# identity-and-schema-rejection-is-one-contract

## Discovery trigger

The identity checks read as one contract — schema, non-zero sequence,
incarnation, lane, expected sequence — and they are written out twice in
identical order, once for the ring descriptor and once for the sample prefix.
Looking for a third reader turned up `Ring::release`, which compares three of the
five fields against the raw shared struct and never calls `validate` at all. That
raised the second half of the question: a contract is not only which conditions
reject, but what a rejection does. The three readers disagree on that too.

## Evidence trail

The five-condition sequence, in the same order, in two places:

- `descriptor.rs:223-237` — `schema_version != DESCRIPTOR_SCHEMA_VERSION`
  yields `UnsupportedSchema` (`:223-225`); `identity.sequence == 0` yields
  `InvalidSequence` (`:226-228`); `incarnation != expected.incarnation` yields
  `WrongIncarnation` (`:229-231`); `lane != expected.lane` yields `WrongLane`
  (`:232-234`); `sequence != expected.sequence` yields `InvalidSequence`
  (`:235-237`).
- `backend/sample.rs:88-102` — the same five, same order, same error variants,
  written against `self` instead of a destructured `Self`.

The third reader is narrower. `Ring::release`
(`backend/ring.rs:849-911`) checks `is_quarantined` (`:850-852`),
`incarnation` against the grant (`:853-855`), `lane` against the grant
(`:856-858`), `sequence == 0` (`:860-862`), and `sequence > consumed`
(`:868-870`). It then reads the slot's raw `SharedDescriptor` with
`read_volatile` (`:875`) and compares three fields directly — `incarnation`
(`:876-878`), `lane` (`:879-881`), `sequence` (`:882-884`). It never calls
`snapshot()` and never calls `validate`, so `schema_version` is not read on this
path.

Rejection disposition differs by reader, and this is the part no document states:

- `try_receive` (`ring.rs:766-846`) calls `shared.snapshot().validate(...)` at
  `:806` and, on any error, calls `self.enter_quarantine()` at `:809` before
  returning `RingError::Descriptor`. Terminal.
- `reclaim_completed` (`ring.rs:1108-1154`) calls the identical
  `snapshot().validate(...)` at `:1129-1132` and maps the error straight through
  with `.map_err(RingError::Descriptor)?`. No quarantine. Its only caller is
  `try_reserve` at `ring.rs:675`, which wraps it as
  `ProducerError::Ring(...)`. I searched the two consumers of that error —
  `crates/mc-host/src/ring_transport.rs` and
  `packages/mc-shm-native/src/lib.rs` — and neither quarantines in response;
  every `enter_quarantine` call in the addon is on an alias-detach or
  close-failure path (`lib.rs:259`, `:266`, `:295`, `:300`, `:321`, `:328`,
  `:350-351`, `:385-386`).
- `release` returns a `LeaseError` variant and never quarantines.

So the same malformed descriptor produces a terminal channel on one path, an
ordinary producer error on another, and no observation at all on the third.

Existing checks, all partial and none cross-cutting.
`tests/contract.rs:82` `descriptor_rejects_every_untrusted_identity_and_span_failure`
tables the descriptor cases. `tests/iceoryx.rs:211-229` (deleted by `0f336d3c`;
resolves against `9c1eb4d1`) covered stale
incarnation, lane, and sequence for the sample prefix, and
`tests/contract.rs:598` covers its schema, length, and wire-header cases.
`tests/ring.rs:139-189` covers wrong incarnation, wrong lane, wrong sequence,
and duplicate release against `Ring::release`. Nothing asserts that the three
readers enforce the same set, and nothing asserts what a rejection does.

## Failure scenario

Two shapes.

The first is drift. A sixth condition is added to `descriptor.rs:223-237` — say
a lane upper bound, or a rejection of a sequence above the published cursor —
and `sample.rs:88-102` is not updated. Both decoders keep passing their own
tests, because each test table is written against its own decoder. The iceoryx
backend then admits a class of identity the ring backend refuses, and the
divergence is invisible until someone compares the two functions by eye.

The second is already present. A peer rewrites `schema_version` in a slot whose
lease is live. The receiver's own `release` accepts it, because that path does
not read the field, and moves the slot to `RELEASE_PENDING`. The producer's next
`try_reserve` calls `reclaim_completed`, which does read it, fails `validate`
with `UnsupportedSchema`, and returns `ProducerError::Ring` — a generic producer
error on a channel that is not quarantined and whose next `try_reserve` will
fail the same way, since the reclaim loop head-of-line blocks at that sequence
(`ring.rs:1119-1121`). The direction stops making progress with no terminal
state and no operator-visible fault, which is the same end state as
`crashed-producer-does-not-wedge-the-sequence` reached by a different route.

## Timing windows and dependencies

The enforcement half is timing-free: it is a static comparison of three
functions. The disposition half has a window, because the descriptor is read
twice from peer-writable memory — once at `ring.rs:804` for receive and once at
`:1127` for reclaim — with the whole lease lifetime in between. Any field can
differ between the two reads, so "validated at receive" does not imply "valid at
reclaim". That coupling puts this record next to
`reclaim-advance-bounded-by-the-producer-reservation`, which exploits the same
two-read window through `allocation_len` rather than through identity, and next
to `native-boundary-not-weaker-than-its-wrapper`, which is the same
"two implementations of one rejection contract" shape one layer up.

## What a test must construct

The enforcement half needs no fault: a shared table of identity and schema cases
driven against every reader that admits a descriptor, asserting each rejects and
asserting the specific variant rather than the category. That includes
`Ring::release`, which today has no schema case because it has no schema check —
so the table's expected outcome for that reader is the design question, not a
mechanical assertion.

The disposition half needs the two-read window: a live lease, a peer write to
the slot's `schema_version`, then a release followed by a `try_reserve`. Fault
class is a peer mutating control pages, which no harness models today. The
oracle is the declared disposition for a reclaim-path rejection — quarantine,
distinguishable fault, or documented tolerance — and picking it is a decision,
not a measurement. Coverage check to emit:
`shm_descriptor_rejected_on_reclaim_path`, which witnesses that the second
`validate` call site is reached at all.

## Investigation log

### Q: Does any caller convert a reclaim-path descriptor rejection into a quarantine?

- Sources examined: `backend/ring.rs:766-846`, `:849-911`, `:1108-1154`, `:675`,
  `:1035-1047`; `descriptor.rs:207-308`; `backend/sample.rs:83-126`;
  `crates/mc-host/src/ring_transport.rs` and
  `packages/mc-shm-native/src/lib.rs`, searched for `enter_quarantine`,
  `RingError::Descriptor`, and `ProducerError::Ring`;
  `tests/contract.rs:82`, `:598`; `tests/iceoryx.rs:164-229` (deleted by
  `0f336d3c`);
  `tests/ring.rs:139-189`.
- Findings: no. `enter_quarantine` is called from exactly one place inside the
  transport, `ring.rs:809` on the receive-validation path. Every other
  `enter_quarantine` in the tree is in the addon and is triggered by alias
  detach or close failure, never by a descriptor error. The reclaim-path
  rejection therefore surfaces as `ProducerError::Ring` from `try_reserve` and
  the ring stays active.
- Missing evidence: whether the reclaim-path rejection is reachable in the
  shipped two-process topology. It requires a peer write to a slot descriptor
  between the receive read at `:804` and the reclaim read at `:1127`, which is
  the same enabling state `reclaim-advance-bounded-by-the-producer-reservation`
  needs and which nothing constructs today. I did not establish reachability, so
  the second failure shape is latent, not demonstrated.
- Conclusion: resolved with answer for the disposition question, open for
  reachability. The enforcement divergence is verified by direct read: two
  readers enforce five conditions, one enforces three, and two callers of the
  same `validate` disagree on what its failure means.
