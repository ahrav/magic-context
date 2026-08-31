# stagelc-staged-state-does-not-survive-a-restart

## Discovery trigger

The task asked what a fresh process reconstructs from staged state and whether a
half-finished coordination resumes or restarts. Answering it required
establishing where the staged state actually lives, which turned out to be the
short answer: nowhere durable.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty.

Where staged state lives:

- `:2946` — `state_sync_seeds: Mutex<StateSyncSeedCoordinator>,`
- `:2947` — `transform_pages: Mutex<TransformPageCoordinator>,`
- `:2950` — `state_imports: Mutex<StateImportCoordinator>,`

All three are plain in-process fields on `struct McHandler` (`:2873-2960`). None
is backed by a store handle, a file, or a durable phase row.

How they are initialised:

- `:3463-3467` — inside `new_with_connection_file` (`:3403-3472`), all three are
  `Mutex::new(<Coordinator>::default())`.
- `:3761-3765` — the second constructor used by the producer-factory injection
  seams (`:3676-3770`) does the same.
- `:946-955`, `:1075-1085`, `:1349-1360` — each `Default` starts with an empty
  `sessions` map and `total_staged_bytes: 0`.

Nothing reads staged state back. `initialize` (`:12118-12142`) does not touch the
coordinators, and no method in scope loads a partial coordination from
`mc-store`.

How a graceful stop treats them:

- `:12048` — `async fn shutdown(&self) -> Result<(), ShutdownError>` in the
  `CompositeComponent` impl (`:11934-12115`).
- `:12095-12099` — inside it, all three are overwritten with a fresh `Default`,
  alongside the four in-process caches at `:12085-12094`. So a graceful shutdown
  deliberately discards every partial coordination and every `completed` replay
  slot.

The rejections that make a post-restart continuation fail loudly rather than
silently:

- Pages: `stage`'s `Idle` arm requires `page_index == 0` and otherwise returns
  `AttemptMismatch` (`:1196-1199`), surfaced as `attempt_mismatch` at
  `:9486-9489`.
- Imports: the `None` arm requires `batch_seq == 0` and otherwise returns
  `batch_seq_mismatch` (`:1565-1571`).
- Seeds: an `Idle` phase is promoted to `AwaitingSeed` only for
  `batch_index == 0` (`:8869-8873`); a non-zero first batch falls through to the
  later arms with the phase still `Idle`.

The deliberate contrast inside the same crate, which is what makes this an
intentional design rather than an oversight: the historian *does* reconstruct
across a restart. Its durable phase machine is described at
`src/historian.rs:1-7` and the recovery is tested at `lib.rs:29793-29832`,
`assert_seeded_phase_recovers_then_refires_after_backoff` plus the three
per-phase wrappers `handler_seeded_publishing_recovers_then_refires_after_backoff`
(`:29822`), `..._firing_...` (`:29827`), and `..._validating_...` (`:29832`). So
the crate has a durable-resume idiom and the staging coordinators do not use it.

Reachability, both sides per METHOD.md rule 4:

- Config default: the constructors at `:3463-3467` are the ones
  `McHandler::new` (`:3399`) uses, and the `shutdown` reset is on the
  unconditional `CompositeComponent` path. No config leaf is involved.
- Shipped setup path: the daemon lifecycle that drives `shutdown` is
  `src/bin/ck_mc_host/serve.rs`, including its SIGTERM handler, and the paged
  request paths are reached from the shipped plugin per
  `packages/plugin/src/hooks/magic-context/module-wire.ts:1097` and
  `module-state-sync.ts:1173`.
- Class: `default-production`.

## Failure scenario

This record's outcome is the intended behaviour, and the value of cataloguing it
is that it is a precondition for the next record rather than a defect on its own.

A caller is mid-way through a five-page transform series when the daemon
restarts, gracefully via SIGTERM or abruptly. The fresh process has an empty
`TransformPageCoordinator`. The caller's page 2 arrives, hits the `Idle` arm at
`:1196`, fails `page_index != 0`, and receives `attempt_mismatch`. The caller must
re-send the whole series from page 0. For a body that was paged because it
exceeded 512 KiB (`module-wire.ts:20`), that is the entire conversation payload
re-sent.

Two things worth stating as consequences rather than defects. First, the
rejections are fail-loud: the caller is told, with a distinct error code per
coordinator, rather than having a truncated series silently applied. Second, the
`completed` replay slots are discarded with everything else at `:12097` and
`:12095`, which removes the only in-process protection against re-applying an
already-committed final step. That second consequence is the substance of
[stagelc-restart-drops-the-only-page-level-replay-guard](stagelc-restart-drops-the-only-page-level-replay-guard.md).

The state-import path is the exception and deserves credit here: its replay
protection is durable, via `store.preflight_state_import` returning
`StateImportPreflight::Duplicate` (`:5678-5686`), so a redriven completed import
is recognised across a restart. Pages and seeds have no durable equivalent.

## Timing windows and dependencies

The window is a process boundary crossed while at least one coordinator holds a
`Collecting` phase. Both crossing modes matter and behave differently in one
respect: the graceful path executes the reset at `:12095-12099`, while an abrupt
termination simply drops the process, so only the graceful path is observable
from inside the old process.

Dependency: the coordination must be genuinely mid-sequence at the boundary,
which is why this record is paired with the coverage marker
[stagelc-a-restart-is-observed-with-staged-state-present](stagelc-a-restart-is-observed-with-staged-state-present.md).
Without that marker this record can pass on a campaign that never restarts
mid-series.

## What a test must construct

1. Build handler H1 with a store in a fixed directory. Bind route 1 to session A.
2. Stage pages 0 and 1 of a three-page series. Assert both acked.
3. Drive `H1.shutdown()`. Assert it returns `Ok`.
4. Assert all three coordinators on H1 have empty `sessions` and
   `total_staged_bytes == 0`.
5. Build handler H2 over the same store directory. Assert the same emptiness
   before any request.
6. Send page 2 of the original series to H2. Assert it is rejected with
   `attempt_mismatch`, not silently accepted and not applied as a one-page
   transform.
7. Send page 0 of a fresh series to H2. Assert it acks, proving the rejection was
   about resumption and not a wedged coordinator.

Step 6 is the load-bearing assertion: it distinguishes "cannot resume" from
"resumes incorrectly". Step 7 is the control that keeps step 6 from passing on a
handler that rejects everything.

## Investigation log

### Q: Does any code path attempt to reconstruct a partial coordination from the store?

- Sources examined: both constructors (`:3403-3472`, `:3676-3770`), `initialize`
  (`:12118-12142`), `bind` (`:11946-11962`), `bind_route` (`:3775-3826`),
  `begin_store_open` and `run_store_open` (`:3498-3672`), and every call site of
  the three coordinator fields.
- Findings: none. The coordinator fields are only ever locked and mutated by the
  staging handlers, the discard helpers (`:3978-4030`), the teardown paths
  (`:3796-3804`, `:4264-4272`), the diagnostics read (`:7822`), and the
  `shutdown` reset. No load, no deserialise, no store read.
- Missing evidence: none.
- Conclusion: resolved with answer. A fresh process reconstructs nothing.

### Q: Is a partial coordination ever left half-applied durably, so that restarting the series would double-write?

- Sources examined: the three terminal steps. Pages: `handle_transform_unpaged_value`
  called once at `:9528-9536` after `assemble_transform_pages` (`:9521`). Seeds:
  `apply_state_sync_wire` called once at `:9086` after
  `assemble_state_sync_seed` (`:9085`). Imports: `commit_state_import` at
  `:5738-5743`, reached only from `StateImportStageOutcome::Apply`, which `stage`
  returns only when `batch_seq + 1 == batch_count` (`:1543`) or
  `batch_count == 1` (`:1592`).
- Findings: in all three, the durable write happens once, on the final step, over
  the fully assembled input. A `Collecting` phase has written nothing durable. So
  a restart mid-series leaves no partial durable effect and a clean re-send is
  correct.
- Missing evidence: whether the *final* step is itself atomic is the sibling
  lens's question, not this one. This record only establishes that the earlier
  steps write nothing.
- Conclusion: resolved with answer, scoped. No partial durable state exists from
  a non-final step.
