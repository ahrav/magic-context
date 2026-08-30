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

- `packages/mc-shm-native/src/lib.rs:636-703` `produce` — reserves with the caller's wire header (`:652-659`),
  runs the fill callback (`:679`), advances the cursor (`:694-696`), then:
  ```rust
  before_publish.call(())?;
  reservation
      .commit(written)
      .map_err(|_| error("producer underfill or invalid commit"))?;
  ```
  (`:697-700`). The hook runs unconditionally before commit is attempted.
- `packages/mc-shm-native/src/lib.rs:809-812` — the same ordering on the two-phase `commit_reservation` entry
  point: `before_publish.call(())?` then `reservation.commit(written as usize)`.
- `packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:248-276` `publishFrame` —
  `let published = false;` (`:255`), and the callback passed as the native before-publish hook sets
  `published = true;` (`:261`) then invokes `hooks?.onPublish?.()` (`:263`). The ticket returned at `:275` is
  `{ cancel: () => !published }`, so once the hook has run the frame is uncancellable by contract.
- `crates/mc-host/src/ring_transport.rs:536-578` `publish_one` — the host's ordering is the opposite: the publish
  attempt is wrapped at `:560-563`, then `if !matches!(result, Ok(Ok(()))) { return Err(()); }` (`:564-566`), and
  only then `completion.store(COMPLETE, Ordering::Release)` (`:652`) followed by the hook at `:653-657`. The host
  never marks a failed commit complete.
- `crates/mc-shm-transport/src/backend/ring.rs:1352-1380` `commit` — five failure branches, all aborting the
  reservation: `Aborted` (`:1353-1355`), `CommitOutsideReservation` (`:1356-1360`), `Underfill` (`:1361-1365`),
  and any error from `commit_reservation` (`:1374-1378`).
- `ring.rs:1178-1180` — inside `commit_reservation`,
  `if declared_len as usize != exact_len || wire_header[4] != 2` returns `ProducerError::WireHeaderMismatch`.
  Because the addon fixes the header at *reserve* time (`lib.rs:656`) but commits the length the fill callback
  reported (`lib.rs:679`, `:699`), a fill that under-advances produces this failure with no injected fault.
- `ring.rs:1154-1162` `abort_reservation` — the failure path stores `SLOT_FREE` and never touches `published`,
  so the peer genuinely sees no frame.
- Existing check, **corrected**: the catalog cites `packages/mc-shm-native/tests/runtime.ts:101-120`.
  `runNativeLifecycle` begins at `:102`, its publish hook is `:115-120`, and the assertion
  `assert.equal(publishSawDetached, true)` is at `:121` — outside the cited range. The accurate span is
  `:102-121`. What it pins is the hook's *position* relative to alias detachment, not commit success. Status
  unaudited.

## Failure scenario

1. The client calls `publishFrame`; the header declares `len = N`.
2. Native `produce` reserves capacity `N` with that header.
3. The fill callback advances the cursor by `M != N` — an under-filling `DirectFrameBody.fill`, a partial
   serializer, or a caught error inside `fill`.
4. `advance(M)` succeeds; `before_publish` fires. The client sets `published = true` and calls
   `hooks.onPublish()`.
5. `commit(M)` reaches `commit_reservation`, which compares the header's declared `N` against `M` and returns
   `WireHeaderMismatch` (`ring.rs:1178-1180`).
6. `commit` aborts the reservation (`:1375`) and the slot returns to `SLOT_FREE`. `published` is never advanced,
   so the peer will never see this frame.
7. Native returns `Err("producer underfill or invalid commit")` (`lib.rs:700`).
8. Consequence: the sender's `onPublish` has already fired for a frame that does not exist and will never be
   delivered. There is no retry on this transport, and `cancel()` would report `false` — not cancellable — for a
   frame that was never published.

## Timing windows and dependencies

The window is the interval between `before_publish.call(())` and `commit`'s return — `lib.rs:697-700` and
`:809-812`. It contains one JavaScript callback invocation and one commit, so it is short but entirely
deterministic: it is entered on every publish and the outcome depends only on whether commit succeeds. No
configuration dependency, no platform gating. This is a client-side property: the host path
(`ring_transport.rs:564-567`) is ordered correctly, so a host-only test cannot observe it. It interacts with
`no-frame-observable-before-commit`, which establishes the other half — the peer really does see nothing — and
that is what makes the client's signal wrong rather than merely early.

## What a test must construct

No process kill and no memory fault. Construct it from the TypeScript surface with a `DirectFrameBody` whose
`fill` advances the cursor by fewer bytes than `byteLength` declares, then assert: `produce` threw;
`hooks.onPublish` was *not* called, or if the contract permits calling it, that the caller was given a
distinguishable signal that publication failed; and that the peer's `try_receive` returns `Ok(None)` for a
bounded window afterwards. A second arm should inject the failure at the two-phase entry point
(`lib.rs:809-812`) so both call sites are covered. A third arm should assert the host path stays correct under
the same fault, so the test documents the asymmetry rather than the symptom. Coverage check to emit:
`shm_commit_failed_after_publish_hook`.

## Investigation log

### Q: Does the client's `FrameSendTicket.cancel()`/`onPublish` contract mean "handed to the transport" or "committed"?

- Sources examined: `packages/plugin/src/shared/mc-host-client/shm-frame-channel.ts:248-276`;
  `packages/mc-shm-native/src/lib.rs:636-703` and `:790-815`; `crates/mc-host/src/ring_transport.rs:536-578`;
  `crates/mc-shm-transport/src/backend/ring.rs:1352-1380`, `:1164-1210`;
  `packages/mc-shm-native/tests/runtime.ts:102-121`.
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
