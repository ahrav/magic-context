# ring-a-no-producer-retains-a-committed-release-identity

## Discovery trigger

The task for this lens carries an explicit re-check. Part 1 found that
`Ring::release` is public and identity-parameterized, and judged the
producer-side release **latent** because every non-test `commit` caller
discarded the identity. The refactor rewrote those callers: Part 1's host-side
anchor was `shm_provider.rs:365`, and the re-scope confirms that line now holds
a `rings: DuplexRing` parameter, so the citation is dead. The question is
whether the rewritten callers changed behaviour. If any current caller retains a
committed identity, Part 1's latency verdict no longer holds.

## Evidence trail

`ProducerReservation::commit` returns `Result<ReleaseIdentity, ProducerError>`
(`crates/mc-shm-transport/src/backend/ring.rs:1769`). The identity is minted at
`ring.rs:1594` inside `commit_reservation` and returned at `:1626`.

`Ring::release(identity)` (`ring.rs:1175`) is the consumer of an identity. It
validates incarnation (`:1179-1181`), lane (`:1182-1184`), non-zero sequence
(`:1186-1188`), sequence not ahead of `consumed` (`:1193-1196`), and then the slot
descriptor's own incarnation, lane, and sequence (`:1200-1210`). So a
producer-derived identity for a
sequence the consumer has not yet consumed is rejected at `:1193-1196` with
`LeaseError::InvalidSequence`, which is why the producer-side form is a latent
hazard rather than an immediate one.

Every `.commit(` call site in the tree, enumerated:

| Site | Form | Identity |
| --- | --- | --- |
| `crates/mc-host/src/ring_transport.rs:615` | `reservation.commit(body_len).map_err(\|_\| ())?;` | discarded at the `?` |
| `crates/mc-host/src/ring_transport.rs:628` | `reservation.commit(body_len).map_err(\|_\| ())?;` | discarded at the `?` |
| `crates/mc-host/src/ring_transport.rs:696` | `.commit(body.len()).map_err(\|_\| RingClientError)?;` | discarded at the `?` |
| `crates/mc-host/src/ring_transport.rs:935` | `reservation.commit(1).unwrap();` | dropped as a statement value |
| `crates/mc-host/src/ring_transport.rs:985` | `reservation.commit(body.len()).unwrap();` | dropped |
| `crates/mc-host/src/ring_transport.rs:1022` | `reservation.commit(1).unwrap();` | dropped |
| `crates/mc-host/tests/support/raw_client.rs:698` | `reservation.commit(body.len()).is_err()` | dropped |
| `crates/mc-host/tests/support/raw_client.rs:743` | `let _ = reservation.commit(0);` | explicitly discarded |
| `crates/mc-host/tests/support/raw_client.rs:799` | `.commit(body.len()).map_err(..)?;` | discarded at the `?` |

Three of those are the non-test producers: `publish_direct` (`:615`),
`publish_owned` (`:628`), and `RingClientEndpoint::send` (`:696`). The remaining
six are inline tests and integration support.

Two `.commit(` sites are a different type entirely and must not be counted:
`crates/mc-host/src/frame_channel/contract_tests.rs:567` and `:600` call
`frame_channel::ProducerReservation::commit` (`frame_channel.rs:198`), which
returns `ProducedBody`, not `ReleaseIdentity`.

The only in-tree code that constructs a `ReleaseIdentity` and hands it to
`Ring::release` directly is `crates/mc-shm-transport/tests/ring.rs:153`, `:161`,
and `:169` — all transport-crate tests, deliberately probing
stale, duplicate, and quarantined release. (Pre-#131 there were five such
sites; the rewritten test file has three.)

Every other entry to `Ring::release` in the tree goes through
`ring_release_callback` (`ring.rs:1670-1677`), which is installed on the lease at
`ring.rs:1130` and invoked from `ReceiveLease::release_once`
(`crates/mc-shm-transport/src/lease.rs:184-192`) with `self.identity`, the
consumer-derived value the lease was built with at `ring.rs:1127`. The host's two release calls,
`ring_transport.rs:508` and `:547`, plus the peer's two at `:732` and `:736`, are
all this form. `packages/mc-shm-native/src/lib.rs:330` is the native side's
equivalent, releasing `active.identity`.

## Failure scenario

The hazard the property forecloses: a producer keeps the identity it got from
`commit` and later calls `ring.release(identity)` on its own direction, either as
an ill-advised "cancel my published frame" or by confusing the two rings of a
`DuplexRing`. Because `release` advances the consumer's completion bookkeeping,
a producer-driven release would either be rejected as `InvalidSequence` (the
common case, since `sequence > consumed`) or, if the consumer has already
consumed that sequence, would race the consumer's own release and be caught by
`DuplicateRelease` (`lease.rs:186`). The dangerous middle case is a release that
succeeds while the consumer still holds the lease, freeing arena storage the
consumer is reading.

None of that is reachable today.

## Timing windows and dependencies

No timing window. This is a static call-graph property.

Dependencies: this record is the reachability premise under Part 1's
`release-authority-bound-to-lease-ownership` and
`release-exactly-once-per-sequence`. Both remain valid; only their host-side
line anchors need moving from `shm_provider.rs:365` to `ring_transport.rs:615`
and `:628`.

## What a test must construct

A call-graph assertion, not a runtime test. Two workable shapes:

1. A source-level check in the same family as the `mandatory-ring-architecture`
   grep gate (`ci.yml:41-58`): assert that no `mc-host` line binds the result of
   `ProducerReservation::commit` to a named variable. Cheap, brittle, and
   honest about being a grep.
2. A `#[cfg(debug_assertions)]` counter inside `Ring::release`, incremented when
   the supplied identity's sequence is greater than `consumed`, asserted zero at
   connection teardown. This catches the real hazard rather than its syntactic
   shadow, and it also covers an out-of-tree embedder, which shape 1 cannot.

Neither exists.

## Investigation log

### Q: Does any current caller retain a committed release identity?

- Sources examined: every `.commit(` occurrence under `crates/` and
  `packages/`, listed in the table above; `ring.rs:1769` and `:1594-1626` for
  the return type and identity mint; `ring.rs:1175-1210` for the consumer;
  `lease.rs:184-192` and `:201-206` (`release_once` and `Drop`) and `ring.rs:1670-1677`
  for the callback path. Re-verified 2026-08-31 at post-#131 HEAD
  `ec0f1bbe1`: all nine `ring::ProducerReservation::commit` call sites still
  discard the `Ok` value at their new line numbers.
- Findings: no. All nine `ring::ProducerReservation::commit` call sites discard
  the `Ok` value, six through `?`/`unwrap()` in statement position and one
  through an explicit `let _ =`. The three non-test sites are exactly the ones
  the refactor rewrote, and the rewrite preserved the discard.
- Missing evidence: out-of-tree embedders. `Ring` and `ProducerReservation` are
  `pub` in `mc-shm-transport`, and `mc-host` re-exports nothing that would
  hand a reservation to an embedder, but `mc-shm-transport` is itself a
  workspace crate an embedder could depend on directly.
- Conclusion: resolved with answer. **Part 1's latency verdict on the
  producer-side release holds after the refactor.** The rewritten callers still
  discard the identity, so no re-grading of Part 1's two release records is
  needed. What is needed is a citation move: `shm_provider.rs:365` becomes
  `ring_transport.rs:615` and `:628`, plus the new third site
  `RingClientEndpoint::send` at `:696`, which did not exist when Part 1 was
  written.

### Q: Is the producer-side `ReleaseIdentity` return value intended to stay unused?

- Sources examined: `ring.rs:1769` (`commit` signature and its doc,
  "Publishes exact committed length after cursor equality check" — no mention of
  the return value's purpose), `ring.rs:1594` (mint site), the whole
  `mc-shm-transport` public surface for a producer-side release protocol.
- Findings: nothing in the tree uses it, and nothing documents a use.
  `packages/mc-shm-native/src/lib.rs:330` releases a consumer identity, so even
  the native peer does not need a producer identity. The most likely reading is
  that `ReleaseIdentity` is a single type serving both roles and the producer
  path returns it for symmetry.
- Missing evidence: design intent.
- Conclusion: needs human input. If it is meant to stay unused, `commit`
  returning `Result<(), ProducerError>` would remove the hazard class outright
  and make this record permanently vacuous, which is a better outcome than a
  test.
