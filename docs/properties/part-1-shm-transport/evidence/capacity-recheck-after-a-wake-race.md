# capacity-recheck-after-a-wake-race

## Discovery trigger

Fix commit `a36f6e687` "Readiness races could strand full rings and miss idle
peer death. Recheck capacity, watch setup sockets, and keep callbacks
progressing." Its `ring.rs` hunk inserted the two post-park `try_reserve`
retries into `reserve_until`. Lead only; the loop was re-read at HEAD.

## Evidence trail

- `reserve_until` (`crates/mc-shm-transport/src/backend/ring.rs:980-1048`)
  parks a generation-bound epoch before blocking: read `generation`
  (`:994`), store `parked = generation + 1` (`:996-1000`).
- Between parking and blocking, the loop closes the race window three ways:
  1. re-run `try_reserve` immediately after parking (`:1001-1011`);
  2. recheck the generation (`:1012-1015`), drain the doorbell
     (`:1016-1019`), re-run `try_reserve` again (`:1020-1030`);
  3. recheck the generation once more (`:1031-1034`) and only then block in
     `capacity_ready.wait_until(deadline)` (`:1035-1041`).
- The publisher's half: `release` signals `capacity_ready` through
  `signal_wake` (`:1236-1241`, `:1418-1432`), which increments `generation`
  with SeqCst (`:1426`) and writes the eventfd only when it swapped a nonzero
  `parked` (`:1427-1429`).
- Case analysis for a release concurrent with the park: if the release's
  `generation.fetch_add` precedes the producer's generation read, the freed
  capacity is visible to the first `try_reserve`; if it lands after the read
  but before blocking, either a generation recheck fails (continue, no
  block), or the release's `parked.swap` saw the producer's epoch and wrote
  the eventfd, which `wait_until` observes as `POLLIN`. No interleaving
  leaves the producer blocked while capacity is free — under the SeqCst
  orderings the code claims, which no tool currently validates.
- `arm_data_wait` (`:828-854`) is the same protocol for the consumer
  direction, with the same recheck-after-park and recheck-after-drain shape.

## Failure scenario

Without the post-park retries: producer sees Exhausted, reads generation G,
parks G+1. Receiver releases, bumps to G+1, swaps `parked` to 0, writes the
eventfd. Producer drains the doorbell as part of stale-token hygiene,
consuming the wake, then blocks until its deadline although the ring has
room. Result: `ProducerError::Deadline` on a ring with free capacity, which
the host reports as a failed publish on a healthy channel — the
strand-a-full-ring symptom the fix commit names.

## Timing windows and dependencies

The vulnerable window is generation-read to `poll` entry, a few dozen
instructions wide, so only a true concurrent releaser (fault class F4) or a
model checker reaches it deliberately. Correctness rests on SeqCst ordering
between `generation` and `parked` on both sides (F5 territory: no loom,
Miri, or TSan run exists). Bounded claim: capacity freed at any point before
the block is consumed within the same loop iteration; capacity freed during
the block terminates the block via the eventfd.

## What a test must construct

A parked producer plus a release racing the arm sequence, repeated enough to
land in the window, with the oracle that `reserve_until` returns success
strictly before its deadline. Today
`two_process_zero_copy_exchange_uses_authenticated_grant`
(`crates/mc-shm-transport/tests/ring.rs:551-592`) blocks a `reserve_until`
behind a child's held lease and converges after the child releases 50 ms
later — it exercises the block-then-wake path but the release always lands
well inside the block, never in the arm window. A loom model is the cheap
oracle, but it is necessarily a hand transcription of `reserve_until` and
`signal_wake` over loom atomics — the protocol's atomics live in an mmapped
shared page loom cannot instrument — kept in sync manually, including the
Release-not-SeqCst parked resets.

## Investigation log

### Q: why two try_reserve retries rather than one?

- Sources examined: `:1001-1030`; fix diff of `a36f6e687`.
- Findings: the first retry catches releases before the park was visible;
  the drain between them can consume a stale token from a wake that predates
  this park epoch, so capacity freed by that earlier wake must be re-checked
  after the drain or it is only represented by a token the producer just
  discarded.
- Conclusion: resolved with answer — the drain is why the second retry
  exists.

### Q: are the orderings actually sufficient?

- Sources examined: `:994-1000`, `:1426-1429`; generation is SeqCst on both
  sides, but every `parked` reset on the exit paths is a `Release` store
  (`:1004`, `:1013`, and the other exit arms through `:1042`), not SeqCst.
  The mix is harmless on the current reading — a resetting producer is by
  definition not blocked — but a loom model that silently "corrected" it to
  SeqCst would validate different code.
- Findings: the pairing argument above is by hand; no concurrency tool runs
  anywhere in the repository (existing-checks.md, concurrency section).
- Conclusion: unresolved, needs a loom or Miri pass over the wake protocol.
