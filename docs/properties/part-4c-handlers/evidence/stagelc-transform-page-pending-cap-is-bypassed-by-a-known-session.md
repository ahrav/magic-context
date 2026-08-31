# stagelc-transform-page-pending-cap-is-bypassed-by-a-known-session

## Discovery trigger

Reading the doc comment on `TransformPageCoordinator` at
`crates/mc-module/src/lib.rs:1064-1065`: "Live transform pages share one
coordinator so every session has one in-flight attempt and every sender
contributes to the same bounded staging budget." That is two claims. The byte
half is enforced. Checking the count half led straight to the `contains_key`
conjunct in the overflow gate.

## Evidence trail

All lines read back at `HEAD` = `b5dc778e`;
`git diff --stat 76cd6f41 b5dc778e -- crates/mc-module/` is empty, so they hold
at the task's `76cd6f41` too.

- `:1064-1065` — the doc comment making the bounded-budget claim.
- `:632` — `const TRANSFORM_PAGE_MAX_PENDING: usize = 64;`
- `:631` — `const TRANSFORM_PAGE_MAX_STAGED_BYTES: usize = 128 * 1024 * 1024;`
- `:1082` — `max_pending_transforms: TRANSFORM_PAGE_MAX_PENDING` in `Default`.
- `:1186-1190` — the gate, verbatim shape:

  ```
  if self.pending_transform_count >= self.max_pending_transforms
      && !self.sessions.contains_key(session_id)
  {
      return Err(TransformPageStageError::BufferOverflow);
  }
  ```

  The second conjunct means the gate only refuses a session that has no map
  entry.
- `:1209` — `self.pending_transform_count += 1` in the `Idle` arm, the only
  increment.
- `:1120-1127` — `release_phase`, the only decrement, guarded by `is_pending`
  (`:1116-1118`), which is `!matches!(phase, Idle)`.
- `:1131-1144` — `discard` releases the phase but leaves the key present. This is
  the mechanism that turns a transient entry into a permanent exemption; it is
  recorded on its own as
  [stagelc-transform-page-session-map-has-no-removal-path](stagelc-transform-page-session-map-has-no-removal-path.md).
- `:1192-1194` — `stage` inserts the entry via `entry(...).or_default()` before
  validating the envelope, so even a rejected page-zero mints the exemption.

Comparison with the sibling that does not have the conjunct:

- `:1572-1577` — `StateImportCoordinator`'s capacity gate is unconditional:
  `if self.pending_import_count >= self.max_pending_imports { ... }`, inside the
  `None` arm reached only when `self.sessions.remove(session_id)` at `:1442`
  returned nothing. Because imports remove their entry on every exit path
  (`:1388-1395`), there is no stale key to exempt anyone.

Reachability, both sides checked per METHOD.md rule 4:

- Config default: none. Dispatch is on field presence, `:7985-7986` via
  `has_transform_page_fields` (`:12326`).
- Shipped setup path: `packages/plugin/src/hooks/magic-context/module-wire.ts:1097`
  pages any body over `MODULE_PAGE_MAX_BYTES` = `512 * 1024`
  (`module-wire.ts:20`), stamping `transform_page_id` at `module-wire.ts:1131`.
- Class: `default-production`.

## Failure scenario

Sixty-four sessions each hold a `Collecting` phase, so
`pending_transform_count == 64`. A sixty-fifth session that has never staged is
correctly refused with `buffer_overflow` (surfaced at `:9497-9500`). A
sixty-fifth session that staged and was discarded earlier in the process's life
still has its key, so `contains_key` is true, the conjunct short-circuits the
gate, and it proceeds to the byte checks and increments
`pending_transform_count` to 65. Repeating with previously seen sessions drives
the count arbitrarily above 64, bounded only by the 128 MiB byte cap and by how
many distinct sessions the daemon has served.

The byte cap does still hold, checked at `:1200-1207` for a first page and
`:1280-1287` for a continuation, so this is not an unbounded-bytes path. It is
the loss of the count bound, which exists precisely to stop many small
collections from each pinning a session slot.

## Timing windows and dependencies

Concurrency is needed only to hold 64 collections open at once, which is
ordinary for a multi-session daemon and does not require precise interleaving.
The exemption itself has no window: once minted it lasts for the process
lifetime, because nothing removes the key short of `shutdown` (`:12097`).

Dependency: this record is downstream of the missing removal path. Fixing
`discard` to evict the entry would fix this record as a side effect. That is
worth stating so the two are not counted as independent defects.

## What a test must construct

1. Build a handler and bind 65 routes to 65 distinct session ids.
2. On session 65, stage one page and then discard it, either by sending a
   malformed follow-up that hits one of the `discard_transform_pages` returns at
   `:9352`-`:9439`, or by calling `discard_transform_pages` directly.
3. On sessions 1 through 64, stage a non-final page each, so
   `pending_transform_count == 64`.
4. Stage a fresh page-zero on session 65 and assert it is refused with
   `buffer_overflow`. Today it succeeds and the counter reaches 65.
5. As a control, do the same with a session 66 that has never staged and assert
   it *is* refused. That control distinguishes the conjunct from a wholly broken
   gate.

The assertion oracle is `pending_transform_count <= TRANSFORM_PAGE_MAX_PENDING`,
readable directly from the crate-visible field.

## Investigation log

### Q: Is the `contains_key` conjunct load-bearing for a legitimate case?

- Sources examined: all three arms of `stage` (`:1195-1318`), the `InProgress`
  return for `Applying` (`:1242-1254`), and the continuation path for
  `Collecting` (`:1255-1317`).
- Findings: there is a real case the conjunct appears aimed at. A session already
  counted in `pending_transform_count` must be allowed to send its *next* page
  even when the coordinator is at capacity, otherwise a full coordinator would
  deadlock every in-flight series. But that case is exactly
  "this session's phase is not `Idle`", which `is_pending` already expresses at
  `:1116-1118`. Keying the exemption on map-entry existence rather than on phase
  pendency is what admits the stale-key bypass, because a discarded session has
  an `Idle` phase and a live key.
- Missing evidence: no test or comment states which of the two the author meant.
- Conclusion: resolved with answer. The conjunct is load-bearing for
  continuation traffic, but `!Self::is_pending(&phase)` would serve that purpose
  without the bypass. The record stands as a defect in the predicate's choice of
  witness, not as a claim that the exemption should not exist at all.
