# attach-reconciles-or-refuses-stale-shared-cursors

## Discovery trigger

Every cursor that governs progress — `published`, `consumed`, `completed`,
`arena_write`, `arena_reclaimed`, `active_leases` — lives in the shared mapping, not
in either process. So a process death leaves them exactly where the dead process
left them. Reading `Ring::attach` to find the reconciliation step showed there is
none: attach validates geometry and identity, wires the transferred eventfd
doorbells, and returns. Then reading
`LifecyclePage` showed there is no field a reconciliation could consult even if one
were added.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:783-798` `attach` — the whole
  function: `grant.checked_layout()?` (`:785`), a `total_bytes` conversion (`:786`),
  `Mapping::attach` (`:787`), `validate_lifecycle` (`:788`), then construct and
  return, including the two `Doorbell::from_fd` conversions (`:789-797`;
  `prefault_read` is gone from attach post-#131). It never reads a cursor, a slot
  state, or the quarantine flag.
- `ring.rs:2067-2098` `validate_lifecycle` — re-verified at post-#131 HEAD.
  It reads exactly eight fields (`:2074-2085`): `magic`,
  `layout_version`, `descriptor_depth`, `arena_bytes`, `max_leases`, `total_bytes`,
  `incarnation`, `lane`, and compares each against the expected grant
  (`:2086-2096`). Notably it does not read `quarantined` either.
- `ring.rs:127-137` `LifecyclePage` — the complete field list is the eight above plus
  `quarantined: AtomicU8`. There is no holder count, attach epoch, heartbeat,
  generation, or peer pid, which confirms the catalog's claim that no field exists
  for a reconciliation to read.
- `ring.rs:119-124` `DescriptorSlot` — `state`, `completion_sequence`,
  `reservation_len`, `descriptor`. All four survive the death of whichever process
  last wrote them.
- `ring.rs:43-58` — `ProducerPage { published, arena_write }`,
  `ConsumerPage { consumed, active_leases }`,
  `ReclaimPage { completed, arena_reclaimed }`. Six cursors, all in shared memory,
  none reset on attach.
- Why the symptoms are all benign codes:
  `ring.rs:1063-1067` — `if active >= self.grant.max_leases { return Ok(None); }`, with
  the comment "A full lease set is backpressure, not a fault";
  `ring.rs:1482-1484` — `reclaim_completed` breaks at the first slot whose
  `completion_sequence` does not match the next expected sequence, so reclamation
  head-of-line blocks at the lowest stale sequence;
  `ring.rs:926-928` — `try_reserve` returns `ProducerError::Exhausted` once
  `published - completed` reaches `descriptor_depth`;
  `ring.rs:989` — `reserve_until` converts sustained `Exhausted` into
  `ProducerError::Deadline`. None of these calls `enter_quarantine`, and
  `enter_quarantine` (`ring.rs:1373-1379`) is the only writer of the quarantine flag.
- Non-test attach callers: `packages/mc-shm-native/src/lib.rs:252-270` `attach_ring`
  (`Ring::attach` at `:263`), reached from the bootstrap at `:609-610`, and
  `ring.rs:698` inside `RingAttachment::attach`. The host-side
  the host-side `attach_ring` that opened `/proc/{pid}/fd/{fd}` is gone: `ed487e11`
  deleted it with `shm_provider.rs`, and its successor
  `crates/mc-host/src/ring_transport.rs:660-680`
  `RingClientEndpoint::attach_with_descriptors` receives already-transferred
  descriptors instead of opening one.
- Existing check: none, confirmed against the rewritten
  `crates/mc-host/tests/shm_failure_modes.rs` (post-#131). Its kill-based tests
  (`:213`, `:225`) and the restart test (`:302`) never perform a post-kill attach
  to the same object; the file has no attach call at all. The pre-rewrite
  six-test inventory (`:105`…`:358`) no longer exists.

## Failure scenario

1. A receiver attaches and takes `K == max_leases` leases. Each lease sets its slot
   to `RECEIVER_LEASED` (`ring.rs:1115`), advances `consumed` (`:1116`), and increments
   `active_leases` (`:1117`).
2. The receiver is killed. None of `ReceiveLease::Drop`
   (`crates/mc-shm-transport/src/lease.rs:201-207`) runs, so no release is recorded
   and `completion_sequence` stays 0 for all K slots.
3. A fresh process attaches with the same grant. `validate_lifecycle` compares the
   eight geometry and identity fields, all of which still match, and attach succeeds.
4. The new receiver calls `try_receive`. `active_leases` still reads `K`, so the
   check at `:1063-1067` short-circuits and returns `Ok(None)` — indistinguishable from
   an empty ring.
5. The producer calls `try_reserve`. `reclaim_completed` cannot advance past the
   lowest stale sequence (`:1482-1484`), so `completed` is frozen; `published`
   continues until `published - completed == descriptor_depth`, then `:926-928`
   returns `Exhausted`, and `reserve_until` reports `Deadline` (`:989`).
6. Consequence: the channel is permanently dead in both directions, every symptom is
   a legal backpressure code, `is_quarantined()` is false, `conservation()` still
   conserves, no charge is retained as quarantined, and no recovery episode starts.
   Nothing distinguishes this from a slow but healthy peer.

## Timing windows and dependencies

There is no narrow window: the stale state is permanent from the moment the receiver
dies until the object is destroyed. The kill must land while at least one lease is
held, which in the shipped client path means between `poll`'s
`std::mem::forget(lease)` (`packages/mc-shm-native/src/lib.rs:1208`) and the
corresponding `detach_active` completion (`:314-334`) — that is, while a frame is in
JavaScript hands. The worst case is `K == max_leases`, because then even the lease
bound alone kills the receive direction. Configuration dependencies:
`HostConfig.liveness` is `None` by default
(`crates/mc-host/src/config.rs:221`, `:233`), so nothing probes the peer and the
receive side waits on the data doorbell indefinitely (`wait_for_data`,
`ring.rs:1138-1160`); with a liveness policy configured the
ring instead fills and a failed publish makes the close unclean, which is the same
divergence `dead-peer-charges-are-reclaimed-or-declared` records. Platform gating:
post-#131 attach receives already-transferred descriptors plus two eventfd
doorbells (`ring.rs:783`), so the attach path is Linux-only via `eventfd`
(`ring.rs:389`); the former `/proc/{pid}/fd/{fd}` open is gone.

One scoping correction worth stating plainly. In the shipped two-process topology a
*replacement* peer does not attach to the dead peer's object — each candidate gets a
fresh `DuplexRing` (`ring.rs:1834-1843`) with a fresh random incarnation (`:757`).
The literal "fresh attach inherits stale leases" sequence therefore requires the
same descriptor to be re-offered, which the activation-token fence formerly
exercised by `shm_failure_modes.rs:358`
`restart_with_same_identity_rejects_stale_activation` was designed to prevent at
the negotiation layer, not at attach (that test was removed with the pre-#131
harness; `907746f7b`). The shipped-topology manifestation is the
surviving side keeping a ring whose peer-side cursors are frozen. Both framings share
one root, no reconciliation and no liveness field, and the property is worth keeping
in its attach form because `validate_lifecycle` is where a reconciliation or refusal
would have to live.

## What a test must construct

An actual process termination while leases are held, then an attach — fault class F1,
which the harness formerly implemented, at a kill point it did not yet offer. The
pre-#131 harness had `RoleProcess::kill`
(former `crates/mc-host/tests/support/shm_process.rs:257-263`),
`reap_killed` asserting signal-9 status (former `:272-292`), and
`observation_window` (former `:266-269`); that support file was deleted by
`907746f7b`, so the scenario harness must be rebuilt. Its five
scenarios were `idle`, `publish`, `pending`, `roundtrip`, and
`roundtrip_park` (former `:712-749`), and none of them could hold a lease across
the kill, because the client endpoint's `recv` releases inside itself at
`crates/mc-host/src/ring_transport.rs:732-736` before returning. So a new scenario is
required that receives without releasing — K frames, ideally `K == max_leases` — and
emits a barrier record before parking. The oracle after the attach: either the attach
fails, or `active_leases == 0` and no slot remains in `RECEIVER_LEASED`. Add the
stronger liveness arm too: after the attach, a bounded poll must eventually deliver a
newly published frame, since `Ok(None)` forever is the actual failure and an
`active_leases` assertion alone would not catch a partial reconciliation. Coverage
check to emit: `shm_kill_with_leases_held`.

## Investigation log

### Q: Is a peer crash meant to be recoverable at all? If yes, something must reset the cursors or force quarantine; today it does neither.

- Sources examined: `ring.rs:783-798`, `:2067-2098`, `:127-137`, `:43-58`,
  `:119-124`, `:1373-1392`, `:1063-1067`, `:926-928`, `:989`, `:1470-1566`, `:1834-1843`;
  `packages/mc-shm-native/src/lib.rs:252-270`, `:522-610`, `:1160-1230`;
  `crates/mc-host/src/config.rs:221`, `:233`;
  `crates/mc-host/tests/support/shm_process.rs:256-292`, `:644-757` (file since
  deleted by `907746f7b`);
  `crates/mc-host/tests/shm_failure_modes.rs` test inventory;
  `crates/mc-host/src/ring_transport.rs:650-734` (the branch formerly at
  `shm_provider.rs:363-371` is gone; `ed487e11` replaced it with the
  unconditional `admission.release()` at `ring_transport.rs:276`).
- Findings: the mechanism half is fully resolved and matches the catalog. There is no
  reconciliation, no reset, and no field to reconcile against; the three progress
  paths all degrade to legal backpressure rather than to a fault; and the quarantine
  flag is written only by explicit `enter_quarantine` calls, none of which are on a
  crash path. The recovery machinery that does exist operates one level up, on
  candidate custody and activation tokens
  (the suspect-versus-release branch and `CandidateCustody`, both deleted by
  `ed487e11`), and its answer to a
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
