# attach-reconciles-or-refuses-stale-shared-cursors

## Discovery trigger

Every cursor that governs progress — `published`, `consumed`, `completed`,
`arena_write`, `arena_reclaimed`, `active_leases` — lives in the shared mapping, not
in either process. So a process death leaves them exactly where the dead process
left them. Reading `Ring::attach` to find the reconciliation step showed there is
none: attach validates geometry and identity, prefaults, and returns. Then reading
`LifecyclePage` showed there is no field a reconciliation could consult even if one
were added.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:593-611` `attach` — the whole
  function: `grant.checked_layout()?` (`:598`), a `total_bytes` conversion (`:599`),
  `Mapping::attach` (`:600`), `validate_lifecycle` (`:601`), `prefault_read`
  (`:602`), then construct and return (`:603-610`). It never reads a cursor, a slot
  state, or the quarantine flag.
- `ring.rs:1637-1668` `validate_lifecycle` — corrected span; the catalog records
  `:1637-1667`. It reads exactly eight fields (`:1644-1655`): `magic`,
  `layout_version`, `descriptor_depth`, `arena_bytes`, `max_leases`, `total_bytes`,
  `incarnation`, `lane`, and compares each against the expected grant
  (`:1656-1666`). Notably it does not read `quarantined` either.
- `ring.rs:118-128` `LifecyclePage` — the complete field list is the eight above plus
  `quarantined: AtomicU8`. There is no holder count, attach epoch, heartbeat,
  generation, or peer pid, which confirms the catalog's claim that no field exists
  for a reconciliation to read.
- `ring.rs:110-115` `DescriptorSlot` — `state`, `completion_sequence`,
  `reservation_len`, `descriptor`. All four survive the death of whichever process
  last wrote them.
- `ring.rs:40-55` — `ProducerPage { published, arena_write }`,
  `ConsumerPage { consumed, active_leases }`,
  `ReclaimPage { completed, arena_reclaimed }`. Six cursors, all in shared memory,
  none reset on attach.
- Why the symptoms are all benign codes:
  `ring.rs:771-776` — `if active >= self.grant.max_leases { return Ok(None); }`, with
  the comment "A full lease set is backpressure, not a fault";
  `ring.rs:1116-1119` — `reclaim_completed` breaks at the first slot whose
  `completion_sequence` does not match the next expected sequence, so reclamation
  head-of-line blocks at the lowest stale sequence;
  `ring.rs:683-685` — `try_reserve` returns `ProducerError::Exhausted` once
  `published - completed` reaches `descriptor_depth`;
  `ring.rs:753` — `reserve_until` converts sustained `Exhausted` into
  `ProducerError::Deadline`. None of these calls `enter_quarantine`, and
  `enter_quarantine` (`ring.rs:1033-1038`) is the only writer of the quarantine flag.
- Non-test attach callers: `packages/mc-shm-native/src/lib.rs:238-246` `attach_ring`
  (`Ring::attach` at `:244`), reached from the bootstrap at `:527-528`, and
  `ring.rs:508` inside `RingAttachment::attach`. The host-side
  `crates/mc-host/src/shm_provider.rs:780-789` `attach_ring` is the test-support
  `TestShmPeer` path.
- Existing check: none, confirmed. `crates/mc-host/tests/shm_failure_modes.rs`
  contains six kill-based tests (`:105`, `:150`, `:246`, `:282`, `:316`, `:358`) and
  none of them performs a post-kill attach to the same object.

## Failure scenario

1. A receiver attaches and takes `K == max_leases` leases. Each lease sets its slot
   to `RECEIVER_LEASED` (`ring.rs:824`), advances `consumed` (`:825`), and increments
   `active_leases` (`:826`).
2. The receiver is killed. None of `ReceiveLease::Drop`
   (`crates/mc-shm-transport/src/lease.rs:215-221`) runs, so no release is recorded
   and `completion_sequence` stays 0 for all K slots.
3. A fresh process attaches with the same grant. `validate_lifecycle` compares the
   eight geometry and identity fields, all of which still match, and attach succeeds.
4. The new receiver calls `try_receive`. `active_leases` still reads `K`, so the
   check at `:771-772` short-circuits and returns `Ok(None)` — indistinguishable from
   an empty ring.
5. The producer calls `try_reserve`. `reclaim_completed` cannot advance past the
   lowest stale sequence (`:1117-1119`), so `completed` is frozen; `published`
   continues until `published - completed == descriptor_depth`, then `:683-685`
   returns `Exhausted`, and `reserve_until` reports `Deadline` (`:753`).
6. Consequence: the channel is permanently dead in both directions, every symptom is
   a legal backpressure code, `is_quarantined()` is false, `conservation()` still
   conserves, no charge is retained as quarantined, and no recovery episode starts.
   Nothing distinguishes this from a slow but healthy peer.

## Timing windows and dependencies

There is no narrow window: the stale state is permanent from the moment the receiver
dies until the object is destroyed. The kill must land while at least one lease is
held, which in the shipped client path means between `poll`'s
`std::mem::forget(lease)` (`packages/mc-shm-native/src/lib.rs:878`) and the
corresponding `detach_active` completion (`:303-307`) — that is, while a frame is in
JavaScript hands. The worst case is `K == max_leases`, because then even the lease
bound alone kills the receive direction. Configuration dependencies:
`HostConfig.liveness` is `None` by default
(`crates/mc-host/src/config.rs:282`, `:296`), so nothing probes the peer and the
endpoint loop polls `Ok(false)` indefinitely; with a liveness policy configured the
ring instead fills and a failed publish makes the close unclean, which is the same
divergence `dead-peer-charges-are-reclaimed-or-declared` records. Platform gating:
`Ring::attach` and both `attach_ring` helpers read `/proc/{pid}/fd/{fd}`, so the
attach path is Linux-only.

One scoping correction worth stating plainly. In the shipped two-process topology a
*replacement* peer does not attach to the dead peer's object — each candidate gets a
fresh `DuplexRing` (`ring.rs:1417-1426`) with a fresh random incarnation (`:559`).
The literal "fresh attach inherits stale leases" sequence therefore requires the
same descriptor to be re-offered, which the activation-token fence exercised by
`shm_failure_modes.rs:358`
`restart_with_same_identity_rejects_stale_activation` is designed to prevent at the
negotiation layer, not at attach. The shipped-topology manifestation is the
surviving side keeping a ring whose peer-side cursors are frozen. Both framings share
one root, no reconciliation and no liveness field, and the property is worth keeping
in its attach form because `validate_lifecycle` is where a reconciliation or refusal
would have to live.

## What a test must construct

An actual process termination while leases are held, then an attach — fault class F1,
which the harness already implements, at a kill point it does not yet offer. The
harness has `RoleProcess::kill` (`crates/mc-host/tests/support/shm_process.rs:257-263`),
`reap_killed` asserting signal-9 status (`:272-292`), and `observation_window`
(`:266-269`). What is missing is a victim scenario that holds leases: the five
existing scenarios are `idle`, `publish`, `pending`, `roundtrip`, and
`roundtrip_park` (`:712-749`), and none of them can hold a lease across the kill,
because `TestShmPeer::recv` releases inside itself at
`crates/mc-host/src/shm_provider.rs:768` before returning. So a new scenario is
required that receives without releasing — K frames, ideally `K == max_leases` — and
emits a barrier record before parking. The oracle after the attach: either the attach
fails, or `active_leases == 0` and no slot remains in `RECEIVER_LEASED`. Add the
stronger liveness arm too: after the attach, a bounded poll must eventually deliver a
newly published frame, since `Ok(None)` forever is the actual failure and an
`active_leases` assertion alone would not catch a partial reconciliation. Coverage
check to emit: `shm_kill_with_leases_held`.

## Investigation log

### Q: Is a peer crash meant to be recoverable at all? If yes, something must reset the cursors or force quarantine; today it does neither.

- Sources examined: `ring.rs:593-611`, `:1637-1668`, `:118-128`, `:40-55`,
  `:110-115`, `:1033-1048`, `:771-776`, `:683-685`, `:753`, `:1106-1152`, `:1417-1426`;
  `packages/mc-shm-native/src/lib.rs:238-246`, `:498-541`, `:833-890`;
  `crates/mc-host/src/config.rs:282`, `:296`;
  `crates/mc-host/tests/support/shm_process.rs:256-292`, `:644-757`;
  `crates/mc-host/tests/shm_failure_modes.rs` test inventory;
  `crates/mc-host/src/shm_provider.rs:363-371`, `:711-789`.
- Findings: the mechanism half is fully resolved and matches the catalog. There is no
  reconciliation, no reset, and no field to reconcile against; the three progress
  paths all degrade to legal backpressure rather than to a fault; and the quarantine
  flag is written only by explicit `enter_quarantine` calls, none of which are on a
  crash path. The recovery machinery that does exist operates one level up, on
  candidate custody and activation tokens
  (`shm_provider.rs:363-371`, `provider_recovery.rs:137-179`), and its answer to a
  dead peer is to retire or isolate the *candidate*, never to repair the *mapping*.
  That is internally consistent with "a crashed peer ends this candidate", which
  would make cursor reconciliation unnecessary by design.
- Missing evidence: no document states which of the two intentions holds.
  `docs/mc-host-shm-transport.md` describes a recovery contract in terms of
  candidates and charges and does not say whether a mapping is ever meant to outlive
  a peer. If the intent is "a crashed peer ends the candidate", the property should
  be restated as a refusal obligation on attach and the record's liveness framing is
  wrong; if the intent is "the mapping is reusable", something must reset six cursors
  and the `LifecyclePage` needs a field it does not have. The code is consistent with
  both readings, so it cannot arbitrate.
- Conclusion: needs human input. The mechanism is established with evidence and
  requires no further investigation; the normative question decides whether the test
  above asserts reconciliation or asserts refusal, and those are different tests with
  different oracles.
