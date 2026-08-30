# no-frame-observable-before-commit

## Discovery trigger

Reading `try_reserve` showed that the producer receives writable arena spans at
reservation time, long before commit. The payload bytes a receiver would read are
therefore already present and already mutable while the frame is officially
invisible. That inverts the usual question: the guarantee cannot be "the bytes are
not there yet", it has to be "no descriptor path reaches those bytes yet". The
round-trip tests assert the positive direction only, so nothing pins the negative.

## Evidence trail

- `crates/mc-shm-transport/src/backend/ring.rs:662-734` `try_reserve` — claims the
  slot with a `SLOT_FREE → SLOT_PRODUCER_RESERVED` compare-exchange at `:691-701`,
  then hands back a `ProducerReservation` at `:725-733`. The slot sits in
  `PRODUCER_RESERVED` for the whole write phase.
- `ring.rs:1212-1244` `write_reservation` — copies caller bytes straight into the
  arena during that phase. Nothing gates those bytes behind commit.
- `ring.rs:764-844` `try_receive` — the receive admission test is two lines:
  `let consumed = ... consumed.load(Ordering::Relaxed)` (`:779`) and
  `let published = ... published.load(Ordering::Acquire)` (`:781`), then
  `if consumed == published { return Ok(None); }` (`:782-784`). `published` is the
  only value that can admit a sequence.
- `ring.rs:790-800` — the second gate. The receiver must win
  `compare_exchange(SLOT_PUBLISHED, SLOT_RECEIVER_HELD, AcqRel, Acquire)`. A slot
  in `PRODUCER_RESERVED` fails it and yields `RingError::InvalidSharedState`.
- `ring.rs:1203-1208` `commit_reservation` publication block — the descriptor
  `write_volatile` (`:1204`), `state.store(SLOT_PUBLISHED, Relaxed)` (`:1205`),
  `arena_write.store(Relaxed)` (`:1206`), and `published.store(sequence, Release)`
  (`:1207`). The `published` store is the last write, so no earlier step can admit
  the sequence.
- `ring.rs:1352-1380` `commit` — every failure branch (`Aborted`,
  `CommitOutsideReservation`, `Underfill`, and any `commit_reservation` error)
  routes through `abort_reservation` at `:1357`, `:1362`, `:1375` before returning,
  and `abort_reservation` (`:1154-1162`) stores `SLOT_FREE` without ever touching
  `published`.

## Failure scenario

1. The producer calls `try_reserve`; the slot moves to `PRODUCER_RESERVED` and the
   arena span is handed out.
2. The producer writes the full body into the arena.
3. Before commit, the receiver polls `try_receive`.
4. If the receive gate were ever widened to consult slot state, `arena_write`, or
   `reservation_len` instead of `published`, the receiver would win a CAS against
   a `PRODUCER_RESERVED` slot, read a descriptor that `commit_reservation` has not
   written yet (residual bytes from the previous lap, since only
   `reservation_len`, `completion_sequence`, and `state` are reset on reclaim at
   `ring.rs:1144-1146`), and lease a span derived from stale metadata.
5. Consequence: a lease over arena bytes the producer still owns and is still
   writing, which is exactly the read-write race the zero-copy contract forbids.

## Timing windows and dependencies

The window is the entire reservation lifetime: from the CAS at `ring.rs:691-701`
until either `published.store(Release)` at `:1207` or `abort_reservation` at
`:1159`. It is unbounded in principle, and in practice as long as the producer's
serialization takes; `reserve_until` (`:737-757`) can also hold a caller spinning
inside the window while a different sequence is outstanding. No configuration
dependency and no platform gating: both gates are plain loads and a
compare-exchange on every target. This property is the precondition for
`no-rust-reference-over-peer-writable-payload` — if a frame can be leased before
commit, that record's spans point at producer-owned memory. It is distinct from
`publication-visibility-derives-only-from-the-published-cursor`: that record is
about which edge carries *visibility* of already-published fields, this one is
about which value grants *admission* at all.

## What a test must construct

Two concurrent parties on one mapping (fault class F4, absent today). Producer:
`try_reserve`, write the full body, then park without committing. Receiver: poll
`try_receive` for a bounded window and assert every call returns `Ok(None)` — not
`Err`, since an error here would mean the CAS was attempted and lost. Then a
direct-state assertion: with the reservation open, walk the slots and assert none
in `PRODUCER_RESERVED` is reachable through the receive path, and assert
`published` is unchanged from its pre-reserve value. Finally commit and assert the
frame becomes receivable exactly once. A second arm should abort instead of
committing and assert the frame never becomes receivable. Coverage check to emit:
`shm_reservation_open_while_peer_polled`.

## Investigation log

### Q: Is `published` genuinely the only value that admits a frame to the receive path?

The catalog records no open question for this property. The question actually
investigated is the one its `high` confidence rests on.

- Sources examined: `ring.rs:764-844` (`try_receive`, read in full),
  `ring.rs:1203-1208` (`commit_reservation` publication order), `ring.rs:1154-1162`
  (`abort_reservation`), `ring.rs:1352-1380` (`commit` failure routing),
  `ring.rs:662-734` (`try_reserve`).
- Findings: `try_receive` reads exactly four shared values before it can claim a
  slot — `quarantined` via `is_quarantined` (`:765`), `active_leases` (`:771`),
  `consumed` (`:779`), `published` (`:781`). Of these only `published` can advance
  the admissible sequence; the other three can only refuse. The slot CAS at
  `:790-800` then requires `SLOT_PUBLISHED` exactly. `published.store` appears in
  exactly one place, `ring.rs:1207`, and it is the final write of the publication
  block.
- Missing evidence: none for the admission claim. The *visibility* of the
  descriptor fields after admission rests on the relaxed `state` store at `:1205`
  and is owned by `publication-visibility-derives-only-from-the-published-cursor`,
  not resolved here.
- Conclusion: resolved with answer — `published` is the sole admission value, and
  commit writes it last, so the property holds by construction at this commit. It
  stays cataloged because no test asserts the negative and a one-line change to
  the gate at `:782-784` would not fail anything.
