# crashed-producer-does-not-wedge-the-sequence

## Discovery trigger

The next sequence is derived, not stored: `try_reserve` computes `published + 1`
every time. So a reservation that is claimed but never committed and never aborted
leaves the derived sequence pointing at a slot that is no longer `FREE`, and the
derivation will keep producing that same value forever. The only thing that undoes
the claim runs in a destructor, which is exactly what a killed process does not
execute.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:688-703` — the derivation and the
  claim. `let sequence = published.checked_add(1)` (`:688-690`, corrected from the
  catalog's `:689-703`, whose start line lands on the `.checked_add` continuation
  rather than the `let`), then `slot_ptr(sequence)` (`:691`) and
  `compare_exchange(SLOT_FREE, SLOT_PRODUCER_RESERVED, AcqRel, Acquire)` with
  `.map_err(|_| ProducerError::Exhausted)?` (`:693-703`). A losing CAS is reported as
  `Exhausted` — a backpressure code — regardless of *why* the slot was not free.
- `ring.rs:679` — `published` is loaded `Relaxed` from the shared producer page, so
  it is the surviving process's own view of a cursor the dead process last wrote.
  Nothing else feeds the derivation.
- `ring.rs:1156-1164` `abort_reservation` — corrected span; the catalog records
  `:1154-1162`, which is now `:1156-1164`, and the prompt's `1150-1165` is wider
  than the function. It stores
  `reservation_len = 0` (`:1160`) and `state = SLOT_FREE` (`:1161`).
- **Correction to the catalog record.** The catalog says `abort_reservation` "is the
  only path that restores `SLOT_FREE`". More precisely: it is the only path that
  returns a slot from `PRODUCER_RESERVED` to `SLOT_FREE` *once a
  `ProducerReservation` handle exists*. Two other sites also store `SLOT_FREE` —
  `try_reserve`'s own rollback at `:712` and `:717` (the catalog's `:710` and
  `:715`), which fire on arena exhaustion
  and arena-planning errors *before* the handle is returned, and
  `reclaim_completed` at `:1148`, which frees a slot from `RELEASE_PENDING`. Neither
  helps here: the rollback path is already past, and reclaim only acts on released
  frames.
- `ring.rs:1399-1406` `impl Drop for ProducerReservation` — `if !self.finished { self.ring.abort_reservation(self.sequence); }`. This is the path a kill skips.
- `ring.rs:1340-1351` and `:1354-1382` — the other `abort_reservation` callers, all
  in-process: `write` on overflow (`:1345`), `commit` on
  `CommitOutsideReservation`, `Underfill`, and `commit_reservation` failure (`:1359`,
  `:1364`, `:1377`), and `abort` (`:1387`).
- `ring.rs:685-687` and `:755` — the symptoms. Once `published - completed` reaches
  `descriptor_depth`, `try_reserve` returns `Exhausted`, and `reserve_until` converts
  sustained `Exhausted` into `ProducerError::Deadline`. Both are ordinary
  backpressure. `enter_quarantine` (`:1035-1040`) is never called on either path.
- `ring.rs:930-947` — why the accounting looks healthy: `conservation()` counts a
  `SLOT_PRODUCER_RESERVED` slot into `descriptors.producer_reserved` and its
  `reservation_len` into `bytes.producer_reserved`, and adds the same length to
  `charged`. The totals therefore conserve, and a stranded reservation is
  indistinguishable from a legitimately in-flight one.
- `crates/mc-host/src/ring_transport.rs:560-563` — worth recording as the *negative*
  case: the host wraps its publish in `catch_unwind`, and a panic unwinds through
  `ProducerReservation::Drop`, so `abort_reservation` does fire. A panic is not a
  wedge. Only a path that skips destructors is — `SIGKILL`, `abort()`, or a
  `panic = "abort"` profile.
- Existing check: none, confirmed. The six kill-based tests in
  `crates/mc-host/tests/shm_failure_modes.rs` (`:105`, `:150`, `:246`, `:282`,
  `:316`, `:358`) all kill outside a reservation.

## Failure scenario

1. A producer calls `try_reserve`. `published` is `N-1`, so `sequence = N`, and the
   slot for `N` moves `FREE → PRODUCER_RESERVED` (`ring.rs:693-703`).
2. The producer writes some or all of the body.
3. The process is killed before `commit`. `ProducerReservation::Drop` never runs, so
   the slot stays `PRODUCER_RESERVED`, `reservation_len` stays non-zero, and
   `published` is still `N-1`.
4. Any later producer on the same object derives `sequence = published + 1 = N`
   again (`:688-690`), and its CAS at `:693-703` fails against the stranded slot,
   returning `Exhausted`.
5. `reserve_until` retries until the deadline and returns `Deadline` (`:755`).
6. Consequence: that direction can never publish again. `is_quarantined()` is false,
   `conservation()` reports `producer_reserved == 1` and conserves, so no charge is
   retained and no recovery episode starts. The only signal is a code whose plain
   meaning is "try again later", which a caller will honour indefinitely.

## Timing windows and dependencies

The window is the whole reservation lifetime, `ring.rs:701` through either
`published.store(Release)` at `:1209` or `abort_reservation` at `:1161`. In the
shipped host that span contains the entire serialization of the frame body —
`publish_direct` runs `direct.serialize` inside it
(`crates/mc-host/src/ring_transport.rs:586-590`) and `publish_owned` performs two
writes (`:687-688`) — so it is proportional to frame size, up to
`MAX_FRAME_BYTES = 64 MiB` (`crates/mc-shm-transport/src/arena.rs:4`). In the addon
the window is wider still and includes a JavaScript callback: `produce` holds the
reservation across `fill.call(views)` (`packages/mc-shm-native/src/lib.rs:751`), and
the two-phase `reserve`/`commit_reservation` pair holds it across an entire return to
JavaScript and back (`:801-807` to `:884-886`). That second shape is the practical
kill target. No configuration dependency; no platform gating beyond the
Linux-only attach path. Relationship: this is the producer-side twin of
`attach-reconciles-or-refuses-stale-shared-cursors` and shares its root — no
liveness signal and no reconciliation — and it shares with
`dead-peer-charges-are-reclaimed-or-declared` the property that the fault surfaces
as a legal code rather than as a fault.

One scoping note, stated because it changes what "any later producer" means. In the
shipped two-process topology each candidate gets a fresh `DuplexRing`
(`ring.rs:1419-1428`) with a fresh random incarnation (`:564`), so a replacement peer
does not inherit the dead peer's object. The literal "a later producer is blocked"
sequence therefore requires a second producer on the *same* object, which today is
constructible in a same-process arrangement or through a re-attach to the same
descriptor. The shipped-topology manifestation is narrower but still real: the
surviving side holds a ring with one slot and its arena bytes permanently
unreclaimable, reported by `conservation()` as in-flight rather than as lost.

## What a test must construct

Termination during an open reservation — fault class F1 at a kill point the harness
does not yet offer. `RoleProcess::kill` (`crates/mc-host/tests/support/shm_process.rs:257-263`),
`reap_killed` with its signal-9 assertion (`:272-292`), and `observation_window`
(`:266-269`) all exist. What is missing is a victim scenario that parks *inside* a
reservation: the five existing scenarios (`:712-749`) cannot, because
`TestShmPeer::send` performs reserve, write, and commit inside one function with no
suspension point (`crates/mc-host/src/ring_transport.rs:659-673`). So the new scenario
must reserve directly against its `to_host` ring, write a partial body, emit a
barrier record, and park. After the kill and reap, the oracle has two arms.
Arm 1, the property as stated: a replacement producer on the same object must
eventually publish, or the failure must be reported as something other than
`Exhausted`/`Deadline` — assert on the *error variant*, because a test that only
checks "reserve failed" passes on both the wedged and the healthy-backpressure case.
Arm 2, the shipped-topology consequence: assert `conservation()` still reports the
stranded slot as `producer_reserved` and that the arena bytes never return to `free`,
which pins the current behaviour even before the normative question is settled.
Coverage check to emit: `shm_kill_during_open_reservation`.

## Investigation log

### Q: In the shipped two-process topology, what is the "later producer" that the wedge blocks?

The catalog records no open question for this property. This is the question its
guarantee statement leaves implicit, and it decides what the test can assert.

- Sources examined: `ring.rs:664-736` (`try_reserve`), `:1156-1164`
  (`abort_reservation`), `:1340-1406` (all `abort_reservation` callers including
  `Drop`), `:1419-1428` (`DuplexRing::create`), `:536-562` (`create_in` and the
  random incarnation), `:930-1002` (`conservation`);
  `crates/mc-host/src/ring_transport.rs:560-606`, `:659-673` (the custody
  admission formerly at `shm_provider.rs:299-302` is gone; `ed487e11` replaced it
  with `admission.admit` at `ring_transport.rs:239-242`);
  `packages/mc-shm-native/src/lib.rs:708-775`, `:705-760`, `:864-889`;
  `crates/mc-host/tests/support/shm_process.rs:256-292`, `:644-757`.
- Findings: the mechanism is confirmed exactly as the catalog states it — the
  derivation from `published + 1`, the losing CAS reported as `Exhausted`, and `Drop`
  as the sole restorer once a handle exists. What the record does not say is that a
  replacement producer on the same object does not arise in the shipped topology,
  because candidate preparation always creates a fresh `DuplexRing`. That does not
  invalidate the property; it relocates the observable consequence from "a later
  producer is blocked" to "the surviving side holds unreclaimable capacity that
  accounting reports as in-flight". The two-phase addon reservation
  (`lib.rs:727-733` and `:810-812`), which holds a claim across a return to
  JavaScript, is the widest real window and the right kill target.
- Missing evidence: none for the mechanism. What is untested rather than unknown is
  whether any deployment re-offers a descriptor whose object already carries a
  stranded reservation; the activation-token fence at
  `crates/mc-host/tests/shm_failure_modes.rs:358` suggests re-offering is guarded at
  the negotiation layer, but that guard is about stale activation, not about slot
  state, so it is evidence of intent rather than of coverage.
- Conclusion: resolved with answer — the wedge is real and the mechanism is
  confirmed, but in the shipped topology it presents as permanent unreclaimable
  capacity on the surviving side rather than as a blocked replacement producer. The
  test therefore needs both arms above, and arm 1 requires a second producer on the
  same object, which is a same-process or re-attach arrangement rather than the
  ordinary two-process one.
