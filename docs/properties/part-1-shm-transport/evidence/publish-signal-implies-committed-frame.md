# publish-signal-implies-committed-frame

## Citation refresh, 2026-08-30

The ring-transport refactor (`0f336d3c`, `d8bde128`, `793a973e`, `ed487e11`)
renamed `crates/mc-host/src/shm_provider.rs` to
`crates/mc-host/src/ring_transport.rs` and deleted `provider_recovery.rs`,
`transport_negotiation.rs`, and `transport_provider.rs`. Host-side citations below
were re-anchored against `ring_transport.rs` at `e447c927`.

Where the cited construct survives, the citation names `ring_transport.rs` and a
line re-verified against that commit. Where it does not, the original reference is
kept and prefixed `former`, so it reads as pre-refactor evidence rather than a
current location. A `former` line number is never a claim about the tree today.
Every `provider_recovery.rs` reference is `former` by definition: that module has
no successor. See the refresh note in [../catalog.md](../catalog.md).

## Discovery trigger

Comparing the two sides of the publish hook. The host stores its completion marker *after* commit returns; the
TypeScript client sets its `published` flag *inside* the hook, which the native layer invokes *before* commit.
Both are internally consistent, so neither side's tests catch it. The disagreement is visible only on the one
input where the orderings differ: a commit that fails after the hook has already fired.

## Evidence trail

- `packages/mc-shm-native/src/lib.rs:859-935` `produce` — reserves with the caller's wire header (`:883-890`),
  runs the fill callback (`:910`), advances the cursor (`:925-927`), then:
  ```rust
  before_publish.call(())?;
  reservation
      .commit(written)
      .map_err(|_| error("producer underfill or invalid commit"))?;
  ```
  (`:928-932`). The hook runs unconditionally before commit is attempted.
- `packages/mc-shm-native/src/lib.rs:1042-1045` — the same ordering on the two-phase `commit_reservation` entry
  point: `before_publish.call(())?` then `reservation.commit(written as usize)`.
- `packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:289-321` `publishFrame` —
  `let published = false;` (`:296`), and the callback passed as the native before-publish hook sets
  `published = true;` (`:303`) then invokes `hooks?.onPublish?.()` (`:305`). The ticket returned at `:321` is
  `{ cancel: () => !published }`, so once the hook has run the frame is uncancellable by contract.
- `crates/mc-host/src/ring_transport.rs:560-602` `publish_one` — the host's ordering is the opposite: the publish
  attempt is wrapped at `:584-587`, then `if !matches!(result, Ok(Ok(()))) { return Err(()); }` (`:588-590`), and
  only then `completion.store(COMPLETE, Ordering::Release)` (`:591`) followed by the hook at `:592-596`. The host
  never marks a failed commit complete.
- `crates/mc-shm-transport/src/backend/ring.rs:1769-1811` `commit` — five failure branches, all aborting the
  reservation: `Aborted` (`:1770-1772`), `CommitOutsideReservation` (`:1773-1777`), `Underfill` (`:1778-1782`),
  and any error from `commit_reservation` (`:1791-1795`).
- `ring.rs:1591-1593` — inside `commit_reservation`,
  `if declared_len as usize != exact_len || wire_header[4] != 2` returns `ProducerError::WireHeaderMismatch`.
  Because the addon fixes the header at *reserve* time (`lib.rs:885`) but commits the length the fill callback
  reported (`lib.rs:926`, `:930`), a fill that under-advances produces this failure with no injected fault.
- `ring.rs:1567-1575` `abort_reservation` — the failure path stores `SLOT_FREE` and never touches `published`,
  so the peer genuinely sees no frame.
- Existing check, **corrected and re-anchored at post-#131 HEAD**: the catalog cites
  `packages/mc-shm-native/tests/runtime.ts:108-127`.
  `runNativeLifecycle` begins at `:109`, its publish hook is `:122-127`, and the assertion
  `assert.equal(publishSawDetached, true)` is at `:128` — just outside that range. The accurate span is
  `:109-128`. What it pins is the hook's *position* relative to alias detachment, not commit success. Status
  unaudited.

## Failure scenario

1. The client calls `publishFrame`; the header declares `len = N`.
2. Native `produce` reserves capacity `N` with that header.
3. The fill callback advances the cursor by `M != N` — an under-filling `DirectFrameBody.fill`, a partial
   serializer, or a caught error inside `fill`.
4. `advance(M)` succeeds; `before_publish` fires. The client sets `published = true` and calls
   `hooks.onPublish()`.
5. `commit(M)` reaches `commit_reservation`, which compares the header's declared `N` against `M` and returns
   `WireHeaderMismatch` (`ring.rs:1591-1593`).
6. `commit` aborts the reservation (`:1792`) and the slot returns to `SLOT_FREE`. `published` is never advanced,
   so the peer will never see this frame.
7. Native returns `Err("producer underfill or invalid commit")` (`lib.rs:931`).
8. Consequence: the sender's `onPublish` has already fired for a frame that does not exist and will never be
   delivered. There is no retry on this transport, and `cancel()` would report `false` — not cancellable — for a
   frame that was never published.

## Timing windows and dependencies

The window is the interval between `before_publish.call(())` and `commit`'s return — `lib.rs:928-931` and
`:1042-1045`. It contains one JavaScript callback invocation and one commit, so it is short but entirely
deterministic: it is entered on every publish and the outcome depends only on whether commit succeeds. No
configuration dependency, no platform gating. This is a client-side property: the host path
(`ring_transport.rs:588-591`) is ordered correctly, so a host-only test cannot observe it. It interacts with
`no-frame-observable-before-commit`, which establishes the other half — the peer really does see nothing — and
that is what makes the client's signal wrong rather than merely early.

## What a test must construct

No process kill and no memory fault. Construct it from the TypeScript surface with a `DirectFrameBody` whose
`fill` advances the cursor by fewer bytes than `byteLength` declares, then assert: `produce` threw;
`hooks.onPublish` was *not* called, or if the contract permits calling it, that the caller was given a
distinguishable signal that publication failed; and that the peer's `try_receive` returns `Ok(None)` for a
bounded window afterwards. A second arm should inject the failure at the two-phase entry point
(`lib.rs:1042-1045`) so both call sites are covered. A third arm should assert the host path stays correct under
the same fault, so the test documents the asymmetry rather than the symptom. Coverage check to emit:
`shm_commit_failed_after_publish_hook`.

## Investigation log

### Q: Does the client's `FrameSendTicket.cancel()`/`onPublish` contract mean "handed to the transport" or "committed"?

- Sources examined: `packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:289-321`;
  `packages/mc-shm-native/src/lib.rs:859-935` and `:1017-1046`; `crates/mc-host/src/ring_transport.rs:560-602`;
  `crates/mc-shm-transport/src/backend/ring.rs:1769-1811`, `:1577-1627`;
  `packages/mc-shm-native/tests/runtime.ts:109-128`.
- Findings: the *mechanics* are settled and verified — the hook precedes commit on both native paths, the
  client's flag is set inside the hook, the host's marker follows commit, and `WireHeaderMismatch` is a
  reachable post-hook commit failure that needs no failpoint. What is not settled is which meaning the
  `FrameSendTicket` contract intends. Nothing in the channel source, the frame-channel contract helper, or
  `docs/mc-host-shm-transport.md` states whether `onPublish` promises "the transport accepted this frame" or
  "this frame is receivable by the peer". The TCP channel is the natural comparison for intent, but its ordering
  is not evidence about the shared-memory contract's intent.
- Missing evidence: a written statement of the ticket contract. There is no specification text to read, and the
  two implementations embody different answers, so the code cannot arbitrate.
- Conclusion: needs human input. The correct oracle depends entirely on the intended meaning, and inventing one
  would make the test assert a preference rather than a contract. Until it is answered the property stays
  `medium`, and the test above should assert only the fact both readings agree on: the peer sees no frame.
