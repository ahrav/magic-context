# release-authority-bound-to-lease-ownership

## Discovery trigger

Reading the two signatures next to each other. `ProducerReservation::commit`
returns a `ReleaseIdentity` to the producer, and `Ring::release` accepts a
`ReleaseIdentity` from anyone holding a `&Ring`. Nothing on the release path
establishes that the caller is the party that took the lease. The authority to
complete a frame is therefore carried by a value, not by ownership of the lease.

## Evidence trail

Both signatures confirmed by direct read at this commit:

```rust
// crates/mc-shm-transport/src/backend/ring.rs:847
pub fn release(&self, identity: ReleaseIdentity) -> Result<(), LeaseError>
```

```rust
// crates/mc-shm-transport/src/backend/ring.rs:1352
pub fn commit(mut self, body_len: usize) -> Result<ReleaseIdentity, ProducerError>
```

- `ring.rs:847-909` — the whole of `release`. Its checks are: quarantine (`:848`),
  `identity.incarnation() != self.grant.incarnation` (`:851`),
  `identity.lane() != self.grant.lane` (`:854`), `sequence == 0` (`:858`),
  `sequence > consumed` (`:866`), and three descriptor-versus-identity comparisons
  (`:874`, `:877`, `:880`). Then the arbitrating compare-exchange
  `SLOT_RECEIVER_LEASED → SLOT_RELEASE_PENDING` at `:884-891`. There is no role
  check, no owner check, and no lease token — the `&self` receiver is the only
  capability required.
- `ring.rs:1181` — `commit_reservation` builds
  `ReleaseIdentity::new(self.grant.incarnation, self.grant.lane, sequence)` and
  returns it (`:1209`), so the identity the producer receives is byte-identical to
  the one `try_receive` derives for the receiver at `:803`.
- `ring.rs:902-906` — a successful release stores `completion_sequence` and
  decrements `active_leases` while the receiver's `ReceiveLease` is still alive and
  still holds `LeaseSpan` pointers into the arena.
- `ring.rs:1106-1152` `reclaim_completed` — the producer's next `try_reserve` calls
  it first (`:673`), and it advances `arena_reclaimed` (`:1140-1143`) and sets the
  slot `SLOT_FREE` (`:1146`) for any slot whose `completion_sequence` matches. So a
  premature release makes those exact bytes reservable.
- `crates/mc-shm-transport/src/lease.rs:215-221` — the receiver's own `Drop` then
  calls `release_once()` and `let _ = ...` discards the `DuplicateRelease`
  (`:218`), so the legitimate holder is never told its lease was completed by
  someone else. This is the same discard site as `release-failure-is-observable`.
- Existing checks, corrected: the identity-validation ladder is
  `crates/mc-shm-transport/tests/ring.rs:173-197`, not `:174-199` as the catalog
  records — lines `:198-201` are the following `ProducerError::Exhausted` assert.
  Within that ladder, `first_id` comes from `first.commit(first_len)` (`:161`) and
  the lease over that sequence is live from `:162` until `:212`; the test calls
  `ring.release` at `:174`, `:182`, and `:190` with *mutated* copies of `first_id`
  to elicit `WrongIncarnation`, `WrongLane`, and `InvalidSequence`. The violating
  call is one unmutated argument away from an existing test.
  `tests/ring.rs:222` `stale_lap_release_cannot_complete_recycled_slot` is
  confirmed and is a genuine full-lap test.

## Failure scenario

Within one process holding a single `Ring` used in both directions:

1. Producer: `try_reserve`, write, `let id = reservation.commit(n)?` — `id` is now
   in producer-side hands (`ring.rs:1209`).
2. Receiver: `let lease = ring.try_receive()?` — the slot is `RECEIVER_LEASED`,
   `active_leases` is 1, and `lease` holds raw `LeaseSpan` pointers
   (`ring.rs:812-827`).
3. Producer: `ring.release(id)`. Every check at `:851-880` passes, because the
   descriptor genuinely carries that incarnation, lane, and sequence. The CAS at
   `:884-891` sees `SLOT_RECEIVER_LEASED` and succeeds. `completion_sequence` is
   published and `active_leases` drops to 0 (`:902-906`).
4. Producer: `try_reserve` again. `reclaim_completed` (`:673`, `:1106-1152`) sees
   the matching `completion_sequence`, advances `arena_reclaimed`, frees the slot.
5. Producer writes the new frame's body into the reclaimed span
   (`write_reservation`, `:1212-1244`) — the same bytes the live lease still points
   at.
6. Receiver reads through `lease.segment(i).read_byte(..)` or `to_vec()` and
   observes the new frame's bytes, or a torn mixture.
7. `lease` drops; `release_once` returns `DuplicateRelease`, discarded at
   `lease.rs:218`. Nothing anywhere reports that anything went wrong.

## Timing windows and dependencies

The window opens when `try_receive` sets `SLOT_RECEIVER_LEASED` (`ring.rs:824`) and
closes when the lease's own release runs. Within it, one call — `Ring::release` with
a value the API returned to the producer — is sufficient; no race, no malformed
input, no memory corruption. The read-after-recycle needs one further step, the
producer's next `try_reserve`, which is unconditional in a busy channel because
`reclaim_completed` runs at the top of it. No configuration dependency
(`HostConfig.liveness` is irrelevant here), no platform gating: this is plain
compare-exchange logic that behaves identically everywhere. Relationship:
`release-exactly-once-per-sequence` dominates this record only for *duplicate*
releases — it says nothing about a *first* release by the wrong party, which is the
actual gap. `no-rust-reference-over-peer-writable-payload` is what keeps the
consequence a stale read rather than immediate undefined behaviour, since the lease
exposes raw pointers and volatile reads rather than a `&[u8]`.

## Reachability in the shipped two-process topology

Not reachable. It is reachable only in a same-process arrangement where one `Ring`
serves as both producer and receiver, which today means the transport's own tests.
Three independent facts establish this:

1. **No non-test caller retains the identity `commit` returns.** Every non-test
   `commit` call site discards it: `crates/mc-host/src/shm_provider.rs:676` and
   `:689` (`reservation.commit(body_len).map_err(|_| ())?;`),
   `packages/mc-shm-native/src/lib.rs:699-700` and `:811-812`
   (`.map_err(|_| error(...))?;` followed by `Ok(())`), and the public-but-test-only
   `TestShmPeer::send` at `shm_provider.rs:757`.
2. **The only non-test direct `Ring::release` call is a receiver's own.** A search
   of `crates/` and `packages/` for `Ring::release` call sites yields exactly two
   outside tests and benches: `ring.rs:1259` inside `ring_release_callback`
   (`:1253-1260`), which is the lease's own release path, and
   `packages/mc-shm-native/src/lib.rs:303-307`,
   `channel.from_host.release(active.identity)` inside `detach_active`
   (`:290-310`). The second is on the addon's *receive* ring, with an identity
   captured from `lease.identity()` at `:858` and stored in the addon's `active`
   table because `poll` calls `std::mem::forget(lease)` at `:878`. That is the
   legitimate holder completing its own lease through a different bookkeeping
   route. The addon never calls `release` on `to_host`.
3. **The two directions are separate objects with separate identities.**
   `DuplexRing::create` (`ring.rs:1417-1426`) builds `first` with lane 0 and
   `second` with lane 1, each through `Ring::create_in`, which draws
   `incarnation = Incarnation::random()` at `:559`. So even a producer that did
   retain an identity from `commit` on its send ring would be rejected on its
   receive ring by `ring.rs:851-856` with `WrongIncarnation` or `WrongLane`. The
   addon's `to_host`/`from_host` (`lib.rs:62-63`) and the host's
   `rings.first`/`rings.second` (`shm_provider.rs:597`, `:555-557`) both follow this
   split, and no non-test path reserves and receives on the same `Ring`.

Severity therefore: a latent API-shape hazard, not a live defect in the shipped
topology. What keeps it worth a record is that the composition is available rather
than prevented — `Ring` and `Ring::release` are public, `commit` hands the identity
out, and the type system does not distinguish a produce-direction `Ring` from a
receive-direction one. The property protects a boundary that is currently held by
call-site convention in two separate codebases.

## What a test must construct

The enabling state is one `Ring` bound in both roles, which is the transport's own
unit-test shape: `Ring::create(&profile(), lane)`, publish, `commit` and keep the
returned identity, `try_receive` and keep the lease alive. Then the fault is a
single ordinary call, `ring.release(producer_identity)`, with no injection needed.
Assert: the call fails; the slot is still `RECEIVER_LEASED` in `conservation()`;
`active_leases` is still 1; and a following `try_reserve` cannot allocate the bytes
under the live lease. To demonstrate the consequence rather than the guard, seed the
lease's first span with a known byte, run the premature release plus a second
`try_reserve` and write, and assert the lease still reads the original byte. A
two-process arm is not required for the property and cannot construct it today for
the reasons above; if the answer to the open question is that `Ring::release`
should not be public, the test becomes a compile-fail assertion instead.

## Investigation log

### Q: Is `Ring::release` intended to be public at all, or should completion be reachable only through `ReceiveLease`?

- Sources examined: `ring.rs:847-909` (`release`), `:1253-1260`
  (`ring_release_callback`), `:1352-1380` (`commit`), `:1417-1426`
  (`DuplexRing::create`), `:536-562` (`create`/`create_in` and the random
  incarnation); `crates/mc-shm-transport/src/lease.rs:173-221`
  (`ReceiveLease::release`, `release_once`, `Drop`);
  `packages/mc-shm-native/src/lib.rs:62-63`, `:290-310`, `:833-890`;
  `crates/mc-host/src/shm_provider.rs:546-619`, `:665-691`, `:711-777`; a
  repository-wide search of `crates/` and `packages/` for `.release(` call sites.
- Findings: the reachability half is resolved — see the section above. The
  *reason* the method is public is also established: the addon needs a
  lease-independent completion path because `poll` `mem::forget`s the
  `ReceiveLease` at `lib.rs:878` and re-derives completion from its own `active`
  table at `:303-307`, so making completion reachable only through `ReceiveLease`
  would require the addon to keep the Rust lease alive across the N-API boundary.
  That is a real design constraint, not an accident.
- Missing evidence: whether the public method is *intended* as a general
  completion entry point or as an internal detail the addon happens to need.
  `docs/mc-host-shm-transport.md` describes the ownership contract in terms of
  leases and does not mention a direct release entry point. No commit message,
  plan requirement (R1-R19, AE1-AE15), or doc comment states an intended caller
  set; the doc comment at `ring.rs:846` reads only "Validates and records one
  explicit completion", which does not name a caller.
- Conclusion: partially resolved. The reachability sub-question is answered with
  evidence: producer-side release is not reachable in the shipped two-process
  topology and is reachable only in a same-process, single-`Ring` arrangement,
  which downgrades this from a live defect to a latent hazard. The design intent
  sub-question needs human input, because the answer determines whether the test
  above asserts a runtime rejection or whether the correct outcome is that the
  composition stops being expressible at all.
