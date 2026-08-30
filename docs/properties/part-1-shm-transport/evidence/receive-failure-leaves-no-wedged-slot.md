# receive-failure-leaves-no-wedged-slot

## Discovery trigger

`try_receive` claims the slot before it validates anything. That makes every failure
after the compare-exchange a cleanup obligation, and the code discharges that
obligation on exactly one of its failure paths. Tracing which errors quarantine and
which merely propagate with `?` showed that `enter_quarantine` appears once inside
`try_receive`, on the descriptor-validation path only. Everything downstream of that
returns an error while leaving shared state advanced.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:790-800` — the claim happens first:
  `compare_exchange(SLOT_PUBLISHED, SLOT_RECEIVER_HELD, AcqRel, Acquire)`. From here
  on the slot is out of the producer's reach.
- `ring.rs:804-810` — the only cleanup path. Validation failure calls
  `self.enter_quarantine()` (`:807`) and returns `RingError::Descriptor` (`:808`).
  Verified by inspection: `enter_quarantine` is called exactly once inside
  `try_receive`, at `:807`.
- `ring.rs:812-821` — **failure path 1.** Both `lease_span` calls propagate with `?`
  (`:813`, `:817`). No quarantine. At this moment the slot is `RECEIVER_HELD` and
  `consumed` has not been advanced.
- `ring.rs:823-827` — the commit point for consumer state, all three writes in one
  unsafe block: `state.store(SLOT_RECEIVER_LEASED, Release)`,
  `consumed.store(sequence, Release)`, `active_leases.fetch_add(1, Relaxed)`.
- `ring.rs:828-829` — **failure path 2**, which the catalog record does not name:
  `usize::try_from(validated.body_len()).map_err(|_| RingError::InvalidLayout)?`
  runs *after* the block above. A failure here leaves the cursor advanced and the
  lease count incremented with no lease object in existence.
- `ring.rs:831-842` — **failure path 3.** `ReceiveLease::new(...)` with
  `.map_err(RingError::Lease)?` at `:842`, also after the commit point.
- `ring.rs:785-800` — why path 1 is permanent: the next `try_receive` recomputes
  `sequence = consumed + 1` (`:785-787`), the same value, and its CAS expects
  `SLOT_PUBLISHED` but finds `SLOT_RECEIVER_HELD`, so it returns
  `RingError::InvalidSharedState` (`:799`) forever, with `is_quarantined()` false.
- `ring.rs:1106-1152` — why paths 2 and 3 are permanent: the producer's
  `reclaim_completed` breaks at the first slot whose `completion_sequence` does not
  match (`:1117-1119`), and no release will ever run for this sequence, so
  reclamation stalls there and one lease of `max_leases` is consumed for good
  (`:771-776` then reports saturation as ordinary backpressure).
- `ring.rs:1088-1104` `lease_span` — its four failure modes: two
  `usize::try_from` conversions (`:1092`, `:1093`), a `checked_add` overflow
  (`:1094-1096`), and `end > self.arena_bytes()` (`:1097-1099`), plus
  `LeaseSpan::new`'s null-pointer check at `crates/mc-shm-transport/src/lease.rs:22-30`.
- `crates/mc-shm-transport/src/lease.rs:118-124` — `ReceiveLease::new`'s only
  rejection: `span_count` outside `1..=2`, `spans[0]` none, `span_count == 1` with
  `spans[1]` some, or `span_count == 2` with `spans[1]` none.
- `crates/mc-shm-transport/src/descriptor.rs:332-432` `validate` — the constraints
  that decide reachability: `body_len > MAX_FRAME_BYTES` rejected (`:363-365`);
  `span_count` restricted to `1..=MAX_SPANS` where `MAX_SPANS = 2`
  (`descriptor.rs:12`, `:373-375`); `spans[0].offset + spans[0].len > arena_bytes`
  rejected (`:380-386`); and for `span_count == 2`, `spans[1].offset != 0` or
  `spans[1].len > arena_bytes` rejected (`:401-410`).

## Failure scenario

Path 1, the wedge:

1. A frame is published; `try_receive` wins the CAS at `:790-800`; the slot is
   `RECEIVER_HELD`.
2. Validation passes at `:804`.
3. `lease_span` fails at `:813`. The error propagates out of `try_receive`.
4. The slot stays `RECEIVER_HELD`; `consumed` is unchanged; `quarantined` is 0.
5. Every later `try_receive` recomputes the same sequence, loses the CAS, and
   returns `InvalidSharedState`. The channel is dead.
6. Consequence: on the host this surfaces as
   `ReadClose::Corrupt("shared-memory receive failed")`
   (`crates/mc-host/src/shm_provider.rs:557-558`), which is classified unclean at
   `:498` and so does report a suspect — but the ring itself is never quarantined,
   so `conservation()` still reports ordinary counts and no charge is retained as
   quarantined.

Paths 2 and 3, the unreleasable lease:

1. Same claim, same successful validation.
2. The consumer state block at `:823-827` commits: state `RECEIVER_LEASED`,
   `consumed` advanced, `active_leases` incremented.
3. `body_len` conversion (`:828`) or `ReceiveLease::new` (`:842`) fails.
4. No `ReceiveLease` exists, so nothing will ever call release for this sequence.
5. Consequence: `reclaim_completed` head-of-line blocks at this sequence forever, the
   arena bytes behind it are never reclaimed, and one lease slot is permanently
   consumed. Unlike path 1, later receives still succeed, so the loss is silent
   until the arena or the lease set runs out and reports backpressure.

## Timing windows and dependencies

There is no race here — the window is a straight-line region of one function,
entered on every successful receive: `ring.rs:800` through `:843`. What makes it
hard is not timing but reachability, because the failing conditions are all
implied by `validate` on a 64-bit target (see the investigation log). No
configuration dependency. Platform gating is the interesting axis: the
`usize::try_from` conversions at `:828`, `:1092`, and `:1093` are the only failure
modes whose reachability is architecture-dependent at all, and with
`MAX_FRAME_BYTES = 64 MiB` (`crates/mc-shm-transport/src/arena.rs:4`) they are
unreachable on 32-bit as well. Relationship: this record shares its arbitrating CAS
with `release-exactly-once-per-sequence`, approached from the receive side, and it
is the receive-side counterpart to `crashed-producer-does-not-wedge-the-sequence`
— both end with a slot stranded in a non-`FREE` state that reports as backpressure
or as a generic error rather than as a fault.

## What a test must construct

The enabling state is ordinary: one published, valid frame. The fault is a forced
failure at a named internal point after the receive CAS has succeeded — fault class
F3, which does not exist in this repository today. Two injection points are needed,
one before the consumer state block (inside `lease_span`, to reach path 1) and one
after it (at `ReceiveLease::new` or the `body_len` conversion, to reach paths 2 and
3), because the two have different post-states and different oracles. Path 1 oracle:
after the `Err`, assert `is_quarantined()` is true, or assert no slot is left in
`RECEIVER_HELD` with `consumed` un-advanced — and then assert the stronger
consequence, that a following `try_receive` on the same ring can still make
progress. Path 2 and 3 oracle: assert `active_leases` returned to its prior value
and that `reclaim_completed` can still advance past this sequence. If instead the
decision is that these paths are unreachable, the test becomes a debug assertion or
an `unreachable` marker at each site rather than an injected fault. Coverage check to
emit: `shm_receive_cas_won_then_validation_ran`.

## Investigation log

### Q: Are the two paths genuinely unreachable given `validate`?

- Sources examined: `ring.rs:764-844` (`try_receive` in full), `:1088-1104`
  (`lease_span`), `crates/mc-shm-transport/src/lease.rs:22-30` (`LeaseSpan::new`)
  and `:109-124` (`ReceiveLease::new`),
  `crates/mc-shm-transport/src/descriptor.rs:332-432` (`validate` in full) and
  `:12` (`MAX_SPANS`), `crates/mc-shm-transport/src/arena.rs:4`
  (`MAX_FRAME_BYTES`).
- Findings: three separate results.
  *`lease_span` is unreachable given `validate`.* The two `usize::try_from` calls
  cannot fail on a 64-bit target. The `checked_add` cannot overflow because both
  operands are bounded by `arena_bytes`. The `end > arena_bytes()` check is already
  proved for span 0 by `descriptor.rs:380-386`, and for span 1 by
  `descriptor.rs:401-410`, which forces `spans[1].offset == 0` and
  `spans[1].len <= arena_bytes`, so `end == spans[1].len <= arena_bytes`.
  `LeaseSpan::new` rejects only a null base, and the base is
  `mapping.base.as_ptr().add(layout.arena + offset)` on a `NonNull` mapping with
  `offset` inside the arena.
  *`ReceiveLease::new` is unreachable given `validate` plus how `try_receive`
  builds its arguments.* `validate` constrains `span_count` to `1..=2`
  (`descriptor.rs:373-375` with `MAX_SPANS = 2`), and `try_receive` passes
  `[Some(first), second]` where `second` is `Some` exactly when
  `validated.span_count() == 2` (`ring.rs:814-821`). All four rejection disjuncts
  at `lease.rs:118-121` are therefore false.
  *A third path exists that the catalog record does not name.* The
  `usize::try_from(validated.body_len())` at `ring.rs:828-829` runs after the
  consumer state block at `:823-827` and has the same wedge shape as path 3. It is
  also unreachable, because `validate` caps `body_len` at
  `MAX_FRAME_BYTES = 64 MiB` (`descriptor.rs:363-365`,
  `arena.rs:4`), which fits `usize` on every supported target.
- Missing evidence: nothing needed for the reachability question. What is missing is
  any statement of this reasoning in the code — no debug assertion, no
  `unreachable` marker, no comment at `ring.rs:813`, `:828`, or `:842` records that
  these errors are prevented upstream. The derivation depends on `validate` keeping
  four specific invariants, and nothing links the two functions.
- Conclusion: resolved with answer — all three paths are unreachable at this commit,
  given `validate` and a target where `u64` values bounded by 64 MiB convert to
  `usize`. That downgrades the record from a live wedge to a latent one, and it
  changes what the test should be: not an injected fault to prove the wedge, but a
  guard at each site so a future relaxation of `validate` fails loudly instead of
  silently wedging the channel. The `always-or-unreached` check semantics the
  catalog chose are the right ones, and the companion obligation is a reachability
  check on the paths themselves.
